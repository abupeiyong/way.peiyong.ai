// Scheduler core (PRD §10.1, §12, §12.1): what one cron tick sends, to whom, exactly once.
//   candidates   → one query over linked, unpaused users (+ their prefs)
//   per user     → local date / HH:MM / weekday in users.timezone; a kind fires when
//                  HH:MM ∈ [slot, slot + window) and its cadence, condition and quiet-hours checks pass
//   idempotency  → INSERT OR IGNORE telegram_outbox_log(user_id, kind, local_date); 0 changes = already sent.
//                  A failure before anything went out deletes the row again, so the next tick retries
//                  (while still inside the window). Once part of a multi-message kind is out, the claim is
//                  kept and a 429 is waited out instead — a repeat of the first message is worse than a delay.
//   fan-out      → at most SEND_CONCURRENCY users at once; one user's kinds go out in order (1 msg/s per chat)
//   403          → the chat is gone (e.g. "bot was blocked by the user"): paused_until = DISCONNECTED_UNTIL
//   429          → every later send in this run waits out parameters.retry_after (or is deferred to the next tick)
//   blocks       → after the kinds, time-block reminders for users who opted in (blocks.ts)
//   events       → every send and failure is a telegram_events row (events.ts)
//   housekeeping → expired sessions, telegram_codes, telegram_state; telegram_updates older than a day
//
// Times come from the tick's scheduledTime, not the clock, so a retried tick sees the same minute.
// Quiet hours suppress every kind here (all scheduled); user-triggered replies never pass through this module.
//
// Kinds (PRD §6): morning (brief + the ask) · review_prompt · weekly_plan (Mon) · weekly_review (Sun) ·
// midday_nudge (11:00, only while the top three is empty) · area_checkin (1st of the month) ·
// body_nudge (12:00, only when one of the four body rules is true — PRD-body §6.2).
// The Sunday body recap rides inside weekly_review (weekly.ts), so the week stays one conversation.
//
// Scaling: one query per tick is fine into the low hundreds of linked users; past that, precompute
// next_send_at (UTC) per user per kind and index it.

import { sendReply, sendReplyId, TelegramApiError, TelegramBot } from "./api.ts";
import { runBlockReminders } from "./blocks.ts";
import { bodyNudgeDue, sendBodyNudge } from "./bodynudge.ts";
import { sendCheckin } from "./checkin.ts";
import { sendMorning } from "./compose.ts";
import { logEvent } from "./events.ts";
import { startReview } from "./review.ts";
import { d1StateStore } from "./state.ts";
import type { TopThreeContext } from "./topthree.ts";
import { sendWeeklyPlan, sendWeeklyReview } from "./weekly.ts";
import { localNow, type LocalNow } from "./time.ts";
import type { GuideEnv } from "../guide.ts";

export { localDate, localNow, localTime, localWeekday, type LocalNow } from "./time.ts";

/** The model settings are optional: without them the Sunday recap is its deterministic block alone. */
export interface ScheduleEnv extends GuideEnv {
  DB: D1Database;
  /** Unset = nothing is sent (housekeeping still runs). */
  TELEGRAM_BOT_TOKEN?: string;
}

/** Telegram allows ~30 msg/s globally and 1/s per chat. */
const SEND_CONCURRENCY = 10;
/** A 429 asking for a longer pause than this defers the remaining sends to the next tick instead of sleeping… */
const MAX_BACKOFF_MS = 30_000;
/** …unless part of a multi-message kind already went out; then we wait up to this long rather than repeat it. */
const MAX_PARTIAL_BACKOFF_MS = 60_000;
/** paused_until for a chat that blocked the bot; the Settings card shows it as disconnected. */
export const DISCONNECTED_UNTIL = "9999-12-31 23:59:59";
/** The midday nudge's fixed slot (PRD §6 row 5). */
const NUDGE_AT = "11:00";
/** The body nudge's fixed slot (PRD-body §6.2): the rules are checked at noon. */
const BODY_NUDGE_AT = "12:00";

export function isDisconnected(pausedUntil: string | null | undefined): boolean {
  return !!pausedUntil && pausedUntil >= DISCONNECTED_UNTIL;
}

// ---------- local time ----------

/** 'HH:MM' (or 'HH:MM:SS') → minutes since midnight; null when unset or malformed. */
function slotMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** [from, to) in local minutes; wraps midnight when from > to; from === to or either unset = no quiet hours. */
export function inQuietHours(from: unknown, to: unknown, minutes: number): boolean {
  const f = slotMinutes(from), t = slotMinutes(to);
  if (f === null || t === null || f === t) return false;
  return f < t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}

// ---------- kinds ----------

export interface Candidate {
  user_id: number;
  timezone: string | null;
  name: string;
  direction: string;
  chat_id: number | string;
  paused_until: string | null;
  [pref: string]: unknown;
}

type KindContext = TopThreeContext & {
  streaks: boolean;
  /** Model settings for the one scheduled message that may ask the Guide (the Sunday body recap). */
  guide: ScheduleEnv;
  /** Like send, but keeps the Telegram message id, so a Guide reply can be threaded. */
  sendId(reply: Parameters<TopThreeContext["send"]>[0]): Promise<number>;
};

interface ScheduleKind {
  /** telegram_outbox_log.kind */
  kind: string;
  /** The local 'HH:MM' slot for this user, or null/undefined = off. */
  slot(prefs: Candidate): unknown;
  /** Minutes after the slot during which a tick still delivers. Cloudflare does not guarantee exact cron timing. */
  windowMin: number;
  cadence(prefs: Candidate, now: LocalNow): boolean;
  /** Checked just before claiming: false = nothing to say today (no claim, so a later tick in the window re-checks). */
  condition?(ctx: KindContext): Promise<boolean>;
  send(ctx: KindContext): Promise<void>;
}

const daily = () => true;

async function topThreeEmpty(ctx: KindContext): Promise<boolean> {
  const day = await ctx.db.prepare("SELECT top1, top2, top3 FROM days WHERE user_id = ? AND date = ?")
    .bind(ctx.userId, ctx.today).first<{ top1: string; top2: string; top3: string }>();
  return !day || ![day.top1, day.top2, day.top3].some((t) => t?.trim());
}

async function sendNudge(ctx: KindContext): Promise<void> {
  const { askText, awaitTopThree } = await import("./topthree.ts");
  const { cb } = await import("./callback.ts");
  await awaitTopThree(ctx, ctx.today);
  await ctx.send({
    text: `👋 ${askText(ctx, ctx.today)}\n\n（中午了，三件事还空着 · It's midday and the top three is still empty — 不想定也没关系 · fine to skip）`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✍️ 写三件事", callback_data: cb.topThree("write", ctx.today) },
        { text: "📋 抄昨天", callback_data: cb.topThree("copy", ctx.today) },
      ]],
    },
  });
}

const KINDS: ScheduleKind[] = [
  { kind: "morning", slot: (p) => p.morning_at, windowMin: 5, cadence: daily, send: sendMorning },
  { kind: "review_prompt", slot: (p) => p.review_at, windowMin: 15, cadence: daily, send: (ctx) => startReview(ctx, "daily") },
  { kind: "weekly_plan", slot: (p) => p.weekly_plan_at, windowMin: 15, cadence: (_, now) => now.weekday === 1, send: sendWeeklyPlan },
  { kind: "weekly_review", slot: (p) => p.weekly_review_at, windowMin: 15, cadence: (_, now) => now.weekday === 0, send: sendWeeklyReview },
  { kind: "midday_nudge", slot: (p) => (p.nudges ? NUDGE_AT : null), windowMin: 15, cadence: daily, condition: topThreeEmpty, send: sendNudge },
  { kind: "area_checkin", slot: (p) => p.checkin_at, windowMin: 15, cadence: (_, now) => now.date.endsWith("-01"), send: sendCheckin },
  // The body nudge sends at most one message a day, and each of its rules at most once a week (bodynudge.ts).
  { kind: "body_nudge", slot: (p) => (p.body_nudges ? BODY_NUDGE_AT : null), windowMin: 15, cadence: daily, condition: bodyNudgeDue, send: sendBodyNudge },
];

/** Kinds due for this user at `now`; the window never wraps past midnight, so a local date never repeats a kind. */
export function dueKinds(prefs: Candidate, now: LocalNow): ScheduleKind[] {
  if (inQuietHours(prefs.quiet_from, prefs.quiet_to, now.minutes)) return [];
  return KINDS.filter((k) => {
    const slot = slotMinutes(k.slot(prefs));
    return slot !== null && now.minutes >= slot && now.minutes < slot + k.windowMin && k.cadence(prefs, now);
  });
}

// ---------- backoff ----------

/** A 429 asked for a longer wait than the cap; the send is left for the next tick. */
class Deferred extends Error {}

/** Shared by every send in one run: after a 429, nobody sends before `until`. */
interface Backoff { until: number }

async function waitOut(backoff: Backoff, partial: boolean): Promise<void> {
  const wait = backoff.until - Date.now();
  if (wait <= 0) return;
  if (wait > (partial ? MAX_PARTIAL_BACKOFF_MS : MAX_BACKOFF_MS)) throw new Deferred();
  await new Promise((r) => setTimeout(r, wait));
}

// ---------- run ----------

async function claim(db: D1Database, userId: number, kind: string, date: string): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO telegram_outbox_log (user_id, kind, local_date) VALUES (?, ?, ?)")
    .bind(userId, kind, date).run();
  return r.meta.changes > 0;
}

async function release(db: D1Database, userId: number, kind: string, date: string): Promise<void> {
  await db.prepare("DELETE FROM telegram_outbox_log WHERE user_id = ? AND kind = ? AND local_date = ?")
    .bind(userId, kind, date).run();
}

/** Every due kind for one user, in order. Stops at the first 403 (chat gone) or deferral. */
async function runUser(env: ScheduleEnv, bot: TelegramBot, u: Candidate, at: Date, backoff: Backoff): Promise<void> {
  const db = env.DB;
  let now: LocalNow;
  try {
    now = localNow(u.timezone || "UTC", at);
  } catch {
    console.error(`schedule: user ${u.user_id} has an unknown timezone "${u.timezone}"`);
    return;
  }
  let sentInKind = 0;
  const ctx: KindContext = {
    db,
    userId: u.user_id,
    today: now.date,
    state: d1StateStore(db, u.user_id),
    streaks: !!u.streaks,
    guide: env,
    async send(reply) {
      await ctx.sendId(reply);
    },
    async sendId(reply) {
      await waitOut(backoff, sentInKind > 0);
      const id = await sendReplyId(bot, u.chat_id, reply);
      sentInKind++;
      return id;
    },
  };

  /** One claimed send; returns false when the run should stop for this user. */
  const attempt = async (kind: string, go: () => Promise<void>): Promise<boolean> => {
    sentInKind = 0;
    try {
      await go();
      await logEvent(db, u.user_id, kind, "sent", { local_date: now.date });
      return true;
    } catch (e) {
      if (sentInKind === 0) await release(db, u.user_id, kind, now.date);
      if (e instanceof Deferred) return false;
      if (e instanceof TelegramApiError && e.kind === "blocked") {
        await db.prepare("UPDATE telegram_accounts SET paused_until = ? WHERE user_id = ?").bind(DISCONNECTED_UNTIL, u.user_id).run();
        await logEvent(db, u.user_id, kind, "blocked", { local_date: now.date });
        console.warn(`schedule: user ${u.user_id} disconnected — ${e.description}`);
        return false;
      }
      if (e instanceof TelegramApiError && e.kind === "rate_limited") {
        backoff.until = Math.max(backoff.until, Date.now() + (e.retryAfter ?? 1) * 1000);
        await logEvent(db, u.user_id, kind, "rate_limited", { local_date: now.date });
        return false;
      }
      await logEvent(db, u.user_id, kind, "error", { local_date: now.date });
      console.error(`schedule: ${kind} for user ${u.user_id} failed`, e);
      return true;
    }
  };

  for (const k of dueKinds(u, now)) {
    if (k.condition && !(await k.condition(ctx))) continue;
    if (!(await claim(db, u.user_id, k.kind, now.date))) continue;
    if (!(await attempt(k.kind, () => k.send(ctx)))) return;
  }

  if (u.block_reminders && !inQuietHours(u.quiet_from, u.quiet_to, now.minutes)) {
    await runBlockReminders({
      db, userId: u.user_id, today: now.date,
      send: (reply) => sendReply(bot, u.chat_id, reply),
      claim: (kind) => claim(db, u.user_id, kind, now.date),
      release: (kind) => release(db, u.user_id, kind, now.date),
    }, now).catch(async (e) => {
      if (e instanceof TelegramApiError && e.kind === "blocked") {
        await db.prepare("UPDATE telegram_accounts SET paused_until = ? WHERE user_id = ?").bind(DISCONNECTED_UNTIL, u.user_id).run();
        return;
      }
      if (e instanceof TelegramApiError && e.kind === "rate_limited") {
        backoff.until = Math.max(backoff.until, Date.now() + (e.retryAfter ?? 1) * 1000);
        return;
      }
      console.error(`schedule: block reminders for user ${u.user_id} failed`, e);
    });
  }
}

async function housekeeping(db: D1Database): Promise<void> {
  const results = await Promise.allSettled([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run(),
    db.prepare("DELETE FROM telegram_codes WHERE expires_at < datetime('now')").run(),
    db.prepare("DELETE FROM telegram_state WHERE expires_at < datetime('now')").run(),
    db.prepare("DELETE FROM telegram_updates WHERE created_at < datetime('now', '-1 day')").run(),
    db.prepare("DELETE FROM telegram_events WHERE created_at < datetime('now', '-180 days')").run(),
  ]);
  for (const r of results) if (r.status === "rejected") console.error("schedule: housekeeping failed", r.reason);
}

/** One cron tick: send whatever is due at `scheduledTime` (ms since epoch), then clean up. */
export async function runSchedules(env: ScheduleEnv, scheduledTime: number): Promise<void> {
  const db = env.DB;
  try {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const bot = TelegramBot.fromEnv(env);
    const { results: candidates } = await db.prepare(
      `SELECT u.id AS user_id, u.timezone, u.name, u.direction, a.chat_id, a.paused_until, p.*
       FROM telegram_accounts a
       JOIN users u ON u.id = a.user_id
       JOIN telegram_prefs p ON p.user_id = a.user_id
       WHERE a.paused_until IS NULL OR a.paused_until < datetime('now')`
    ).all<Candidate>();
    const at = new Date(scheduledTime);
    const backoff: Backoff = { until: 0 };
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const u = candidates[next++];
        try {
          await runUser(env, bot, u, at, backoff);
        } catch (e) {
          console.error(`schedule: user ${u.user_id} failed`, e);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(SEND_CONCURRENCY, candidates.length) }, worker));
  } finally {
    await housekeeping(db);
  }
}
