// Scheduler core (PRD §10.1, §12, §12.1): what one cron tick sends, to whom, exactly once.
//   candidates   → one query over linked, unpaused users (+ their prefs)
//   per user     → local date / HH:MM / weekday in users.timezone; a kind fires when
//                  HH:MM ∈ [slot, slot + window) and its cadence and quiet-hours checks pass
//   idempotency  → INSERT OR IGNORE telegram_outbox_log(user_id, kind, local_date); 0 changes = already sent.
//                  Any failure deletes the row again, so the next tick retries (while still inside the window)
//   fan-out      → at most SEND_CONCURRENCY users at once; one user's kinds go out in order (1 msg/s per chat)
//   403          → the chat is gone (e.g. "bot was blocked by the user"): paused_until = DISCONNECTED_UNTIL
//   429          → every later send in this run waits out parameters.retry_after (or is deferred to the next tick)
//   housekeeping → expired sessions, telegram_codes, telegram_state; telegram_updates older than a day
//
// Times come from the tick's scheduledTime, not the clock, so a retried tick sees the same minute.
// Quiet hours suppress every kind here (all scheduled); user-triggered replies never pass through this module.
//
// Schema assumed from #2: users.timezone (IANA; NULL = UTC), telegram_accounts(user_id, chat_id, paused_until),
// telegram_prefs(user_id, morning_at, review_at, quiet_from, quiet_to — 'HH:MM', NULL = off),
// telegram_outbox_log(user_id, kind, local_date) with a UNIQUE/PRIMARY KEY over all three,
// telegram_codes.expires_at, telegram_updates.created_at. Telegram timestamps use SQLite datetime() format.
//
// Scaling: one query per tick is fine into the low hundreds of linked users; past that, precompute
// next_send_at (UTC) per user per kind and index it.

import { sendMorning } from "./compose.ts";
import { startReview } from "./review.ts";
import type { Reply } from "./router.ts";
import { d1StateStore } from "./state.ts";
import type { TopThreeContext } from "./topthree.ts";

export interface ScheduleEnv {
  DB: D1Database;
  /** Unset = nothing is sent (housekeeping still runs). */
  TELEGRAM_BOT_TOKEN?: string;
}

/** Telegram allows ~30 msg/s globally and 1/s per chat. */
const SEND_CONCURRENCY = 10;
/** A 429 asking for a longer pause than this defers the remaining sends to the next tick instead of sleeping. */
const MAX_BACKOFF_MS = 30_000;
/** paused_until for a chat that blocked the bot; the Settings card shows it as disconnected. */
export const DISCONNECTED_UNTIL = "9999-12-31 23:59:59";

export function isDisconnected(pausedUntil: string | null | undefined): boolean {
  return !!pausedUntil && pausedUntil >= DISCONNECTED_UNTIL;
}

// ---------- local time ----------

export interface LocalNow {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24 h */
  time: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in `timeZone` at `at`. Throws RangeError on an unknown zone. */
export function localNow(timeZone: string, at: Date): LocalNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(at).map((p) => [p.type, p.value])
  );
  const time = `${parts.hour}:${parts.minute}`;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

export const localDate = (timeZone: string, at: Date) => localNow(timeZone, at).date;
export const localTime = (timeZone: string, at: Date) => localNow(timeZone, at).time;
export const localWeekday = (timeZone: string, at: Date) => localNow(timeZone, at).weekday;

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

interface Candidate {
  user_id: number;
  timezone: string | null;
  name: string;
  direction: string;
  chat_id: number | string;
  paused_until: string | null;
  [pref: string]: unknown;
}

interface ScheduleKind {
  /** telegram_outbox_log.kind */
  kind: string;
  /** The telegram_prefs column holding the local 'HH:MM' slot. */
  slot: string;
  /** Minutes after the slot during which a tick still delivers. Cloudflare does not guarantee exact cron timing. */
  windowMin: number;
  cadence(prefs: Candidate, now: LocalNow): boolean;
  send(ctx: TopThreeContext): Promise<void>;
}

const daily = () => true;

const KINDS: ScheduleKind[] = [
  { kind: "morning", slot: "morning_at", windowMin: 5, cadence: daily, send: sendMorning },
  { kind: "review_prompt", slot: "review_at", windowMin: 15, cadence: daily, send: startReview },
];

/** Kinds due for this user at `now`; the window never wraps past midnight, so a local date never repeats a kind. */
export function dueKinds(prefs: Candidate, now: LocalNow): ScheduleKind[] {
  if (inQuietHours(prefs.quiet_from, prefs.quiet_to, now.minutes)) return [];
  return KINDS.filter((k) => {
    const slot = slotMinutes(prefs[k.slot]);
    return slot !== null && now.minutes >= slot && now.minutes < slot + k.windowMin && k.cadence(prefs, now);
  });
}

// ---------- Bot API ----------

export class TelegramApiError extends Error {
  readonly status: number;
  readonly description: string;
  /** parameters.retry_after on a 429, in seconds. */
  readonly retryAfter?: number;
  constructor(status: number, description: string, retryAfter?: number) {
    super(`Telegram ${status}: ${description}`);
    this.status = status;
    this.description = description;
    this.retryAfter = retryAfter;
  }
}

/** A 429 asked for a longer wait than MAX_BACKOFF_MS; the send is left for the next tick. */
class Deferred extends Error {}

export async function sendMessage(token: string, chatId: number | string, reply: Reply): Promise<void> {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: reply.text, ...(reply.reply_markup && { reply_markup: reply.reply_markup }) }),
  });
  if (res.ok) return;
  const body = await res.json().catch(() => ({})) as { description?: string; parameters?: { retry_after?: number } };
  throw new TelegramApiError(res.status, body.description ?? res.statusText, body.parameters?.retry_after);
}

/** Shared by every send in one run: after a 429, nobody sends before `until`. */
interface Backoff { until: number }

async function waitOut(backoff: Backoff): Promise<void> {
  const wait = backoff.until - Date.now();
  if (wait <= 0) return;
  if (wait > MAX_BACKOFF_MS) throw new Deferred();
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
async function runUser(db: D1Database, token: string, u: Candidate, at: Date, backoff: Backoff): Promise<void> {
  let now: LocalNow;
  try {
    now = localNow(u.timezone || "UTC", at);
  } catch {
    console.error(`schedule: user ${u.user_id} has an unknown timezone "${u.timezone}"`);
    return;
  }
  const ctx: TopThreeContext = {
    db,
    userId: u.user_id,
    today: now.date,
    state: d1StateStore(db, u.user_id),
    async send(reply) {
      await waitOut(backoff);
      await sendMessage(token, u.chat_id, reply);
    },
  };
  for (const k of dueKinds(u, now)) {
    if (!(await claim(db, u.user_id, k.kind, now.date))) continue;
    try {
      await k.send(ctx);
    } catch (e) {
      await release(db, u.user_id, k.kind, now.date);
      if (e instanceof Deferred) return;
      if (e instanceof TelegramApiError && e.status === 403) {
        await db.prepare("UPDATE telegram_accounts SET paused_until = ? WHERE user_id = ?")
          .bind(DISCONNECTED_UNTIL, u.user_id).run();
        console.warn(`schedule: user ${u.user_id} disconnected — ${e.description}`);
        return;
      }
      if (e instanceof TelegramApiError && e.status === 429) {
        backoff.until = Math.max(backoff.until, Date.now() + (e.retryAfter ?? 1) * 1000);
        return;
      }
      console.error(`schedule: ${k.kind} for user ${u.user_id} failed`, e);
    }
  }
}

async function housekeeping(db: D1Database): Promise<void> {
  const results = await Promise.allSettled([
    db.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(new Date().toISOString()).run(),
    db.prepare("DELETE FROM telegram_codes WHERE expires_at < datetime('now')").run(),
    db.prepare("DELETE FROM telegram_state WHERE expires_at < datetime('now')").run(),
    db.prepare("DELETE FROM telegram_updates WHERE created_at < datetime('now', '-1 day')").run(),
  ]);
  for (const r of results) if (r.status === "rejected") console.error("schedule: housekeeping failed", r.reason);
}

/** One cron tick: send whatever is due at `scheduledTime` (ms since epoch), then clean up. */
export async function runSchedules(env: ScheduleEnv, scheduledTime: number): Promise<void> {
  const db = env.DB;
  try {
    const token = env.TELEGRAM_BOT_TOKEN;
    if (!token) return;
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
          await runUser(db, token, u, at, backoff);
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
