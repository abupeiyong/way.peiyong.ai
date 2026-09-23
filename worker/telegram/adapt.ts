// Adaptive prompt times (docs/PRD-body.md §13 item 10, §15 q3, issue #65): learn when the user actually
// logs, and **propose** a better slot — never change one behind their back.
//
//   body_adapt (Monday 09:30 local, gated on telegram_prefs.body_nudges like the noon nudge) → at most one
//   suggestion, of one of two shapes:
//
//   1. move it — the median local time of this slot's logs is at least 45 minutes off the ask, in the same
//      direction, in BOTH the 28 days ending today and the 28 days ending a week ago ("two weeks running",
//      computed from the logs alone, so no extra state table):
//        ⏰ 🍜 午饭 提醒在 13:00，你最近一般 12:15 才记（14 次） · [改成 12:15] [不用]
//      ad:<slot>:<hhmm> → write the new time into telegram_prefs · ad:x → leave it alone
//   2. turn it off — over the last three weeks the ask went out at least 10 times and at least 80 % of those
//      days ended with nothing logged for it (跳过 or simply ignored; 没吃 writes a row, so it counts as used):
//        ⏰ 🍳 早饭 提醒在 08:30，最近三周问了 18 次，16 次没有下文 · [关掉提醒] [留着]
//      ad:f:<slot> → clear that telegram_prefs slot (the Settings page switches it back on)
//   A drift is offered before an unused ask: moving the ask is the smaller change, and an ask at the wrong
//   time is exactly the one that gets ignored.
//
// Offered or dismissed, a slot then rests four weeks (telegram_outbox_log kind `body_adapt:<slot>`,
// keyed by the week's Monday), so the same suggestion never nags. At most one slot per message, and
// at most one message a week. Nothing here calls a model.

import { loadBodyPlan } from "../body.ts";
import { addDays, weekStartOf } from "../dates.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logReply } from "./events.ts";
import { localNow } from "./time.ts";

/** The body slots a suggestion may move; the code is what travels in `ad:<code>:<hhmm>`. */
export const ADAPT_SLOTS = ["weigh", "breakfast", "lunch", "dinner", "workout"] as const;
export type AdaptSlot = (typeof ADAPT_SLOTS)[number];

/** Which telegram_prefs column each slot writes, and what it is called in the message. */
const SLOT_FIELD: Record<AdaptSlot, string> = {
  weigh: "weigh_at", breakfast: "breakfast_at", lunch: "lunch_at", dinner: "dinner_at", workout: "workout_at",
};
const SLOT_LABEL: Record<AdaptSlot, string> = {
  weigh: "⚖️ 称重 · the weigh-in",
  breakfast: "🍳 早饭 · breakfast",
  lunch: "🍜 午饭 · lunch",
  dinner: "🍲 晚饭 · dinner",
  workout: "🏃 运动 · the workout check",
};

/** Days of logs one median is read from. */
const WINDOW_DAYS = 28;
/** Logs a slot needs, in each window, before its median means anything. */
const MIN_SAMPLES = 5;
/** Minutes between the ask and the median before it is worth saying anything (issue #65). */
const MIN_SHIFT_MIN = 45;
/** The check is weekly, so "two weeks running" is this window and the one ending seven days earlier. */
const PRIOR_OFFSET_DAYS = 7;
/** Days of asks the "turn it off" rule reads (§15 q3). */
const IGNORE_WINDOW_DAYS = 21;
/** Asks a slot needs in that window before its ignore rate means anything. */
const MIN_ASKS = 10;
/** Share of those asks that has to have led to nothing before turning the prompt off is worth proposing. */
const IGNORE_RATIO = 0.8;
/** Weeks a slot rests after it was offered or dismissed. */
const REST_WEEKS = 4;

export type Adaptation =
  | {
      kind: "move";
      slot: AdaptSlot;
      /** The current 'HH:MM' of that ask. */
      from: string;
      /** The median 'HH:MM' the user actually logs at. */
      to: string;
      /** How many logs this window's median came from. */
      samples: number;
    }
  | {
      kind: "off";
      slot: AdaptSlot;
      /** The current 'HH:MM' of that ask. */
      from: string;
      /** Days the ask went out over the last three weeks. */
      asked: number;
      /** How many of those ended with nothing logged. */
      ignored: number;
    };

// ---------- pure helpers ----------

/** 'HH:MM' → minutes since midnight; null when unset or malformed (the same shape schedule.ts accepts). */
export function slotMinutes(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Minutes since midnight → 'HH:MM', rounded to the nearest five minutes so a suggestion reads like a time. */
export function hhmm(minutes: number): string {
  const rounded = Math.min(23 * 60 + 55, Math.max(0, Math.round(minutes / 5) * 5));
  return `${String(Math.floor(rounded / 60)).padStart(2, "0")}:${String(rounded % 60).padStart(2, "0")}`;
}

/** The middle value (the mean of the middle two when there is an even number); null when empty. */
export function medianMinutes(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** A stored `datetime('now')` (UTC) → minutes past local midnight in `timezone`; null when unparseable. */
export function localMinutesOf(createdAt: string, timezone: string | null): number | null {
  const at = new Date(createdAt.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(createdAt) ? "" : "Z"));
  if (Number.isNaN(at.getTime())) return null;
  try {
    return localNow(timezone || "UTC", at).minutes;
  } catch {
    return localNow("UTC", at).minutes;
  }
}

// ---------- reading the logs ----------

interface Prefs { [field: string]: unknown }

/** One log: the day it belongs to, and the local minute it was written at. */
export interface Sample { date: string; minutes: number }

/**
 * The local times this user logged at, per slot, far enough back for both windows of the "two weeks
 * running" test (28 days, plus the week the earlier window reaches further into).
 */
async function samplesBySlot(
  db: D1Database, userId: number, today: string, timezone: string | null
): Promise<Record<AdaptSlot, Sample[]>> {
  const from = addDays(today, -(WINDOW_DAYS + PRIOR_OFFSET_DAYS - 1));
  const out: Record<AdaptSlot, Sample[]> = { weigh: [], breakfast: [], lunch: [], dinner: [], workout: [] };
  try {
    const [weights, meals, workouts] = await Promise.all([
      db.prepare("SELECT date, created_at FROM weight_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
        .bind(userId, from, today).all<{ date: string; created_at: string }>(),
      // time_min is the local minute the meal was logged at, already in the user's own clock.
      db.prepare("SELECT date, kind, time_min FROM meal_logs WHERE user_id = ? AND date BETWEEN ? AND ? AND time_min IS NOT NULL")
        .bind(userId, from, today).all<{ date: string; kind: string; time_min: number }>(),
      db.prepare("SELECT date, created_at FROM workout_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
        .bind(userId, from, today).all<{ date: string; created_at: string }>(),
    ]);
    for (const w of weights.results) {
      const m = localMinutesOf(w.created_at, timezone);
      if (m !== null) out.weigh.push({ date: w.date, minutes: m });
    }
    for (const m of meals.results) {
      if (m.kind === "breakfast" || m.kind === "lunch" || m.kind === "dinner") {
        out[m.kind].push({ date: m.date, minutes: m.time_min });
      }
    }
    for (const o of workouts.results) {
      const m = localMinutesOf(o.created_at, timezone);
      if (m !== null) out.workout.push({ date: o.date, minutes: m });
    }
  } catch {
    // migration 0004 has not run here: nothing to learn from.
  }
  return out;
}

/** The median of the samples inside [from, to], or null when there are too few to mean anything. */
function windowMedian(samples: Sample[], from: string, to: string): { median: number; count: number } | null {
  const values = samples.filter((s) => s.date >= from && s.date <= to).map((s) => s.minutes);
  if (values.length < MIN_SAMPLES) return null;
  const median = medianMinutes(values);
  return median === null ? null : { median, count: values.length };
}

/**
 * The drift this slot has shown **two weeks running**, or null: the 28 days ending today and the 28 days
 * ending a week ago both have to sit at least MIN_SHIFT_MIN from the ask, and on the same side of it.
 * Stateless on purpose — the logs are the record, so nothing extra has to be remembered between Mondays.
 */
export function driftOf(
  samples: Sample[], current: number, today: string
): { median: number; count: number } | null {
  const now = windowMedian(samples, addDays(today, -(WINDOW_DAYS - 1)), today);
  const before = windowMedian(
    samples,
    addDays(today, -(WINDOW_DAYS + PRIOR_OFFSET_DAYS - 1)),
    addDays(today, -PRIOR_OFFSET_DAYS),
  );
  if (!now || !before) return null;
  const a = now.median - current, b = before.median - current;
  if (Math.abs(a) < MIN_SHIFT_MIN || Math.abs(b) < MIN_SHIFT_MIN) return null;
  return Math.sign(a) === Math.sign(b) ? now : null;
}

/** The scheduled kind each slot's ask goes out as, and the log that shows the ask was used. */
const SLOT_KIND: Record<AdaptSlot, string> = {
  weigh: "weigh_in", breakfast: "meal_breakfast", lunch: "meal_lunch", dinner: "meal_dinner", workout: "workout_check",
};
/** Correlated subqueries over `telegram_outbox_log o`; no user input goes anywhere near these strings. */
const SLOT_LOGGED_SQL: Record<AdaptSlot, string> = {
  weigh: "SELECT 1 FROM weight_logs x WHERE x.user_id = o.user_id AND x.date = o.local_date",
  breakfast: "SELECT 1 FROM meal_logs x WHERE x.user_id = o.user_id AND x.date = o.local_date AND x.kind = 'breakfast'",
  lunch: "SELECT 1 FROM meal_logs x WHERE x.user_id = o.user_id AND x.date = o.local_date AND x.kind = 'lunch'",
  dinner: "SELECT 1 FROM meal_logs x WHERE x.user_id = o.user_id AND x.date = o.local_date AND x.kind = 'dinner'",
  workout: "SELECT 1 FROM workout_logs x WHERE x.user_id = o.user_id AND x.date = o.local_date",
};

/**
 * How often this slot's ask went out over the last three weeks, and how often the day it went out ended
 * with nothing logged for it. 跳过 writes nothing and so counts as ignored; 没吃 writes an empty row and
 * counts as used. An ask that never fires (the weigh-in while the morning message carries it) has asked = 0.
 */
async function askUse(
  db: D1Database, userId: number, slot: AdaptSlot, today: string
): Promise<{ asked: number; ignored: number }> {
  try {
    const row = await db.prepare(
      `SELECT COUNT(*) AS asked,
              SUM(CASE WHEN EXISTS (${SLOT_LOGGED_SQL[slot]}) THEN 0 ELSE 1 END) AS ignored
         FROM telegram_outbox_log o
        WHERE o.user_id = ? AND o.kind = ? AND o.local_date BETWEEN ? AND ?`
    ).bind(userId, SLOT_KIND[slot], addDays(today, -(IGNORE_WINDOW_DAYS - 1)), today)
      .first<{ asked: number; ignored: number | null }>();
    return { asked: row?.asked ?? 0, ignored: row?.ignored ?? 0 };
  } catch {
    return { asked: 0, ignored: 0 }; // migration 0004 has not run here
  }
}

/** Slots that were offered or dismissed inside the rest window, from the per-slot outbox claims. */
async function restingSlots(db: D1Database, userId: number, weekStart: string): Promise<Set<string>> {
  const { results } = await db.prepare(
    "SELECT kind FROM telegram_outbox_log WHERE user_id = ? AND kind LIKE 'body_adapt:%' AND local_date >= ?"
  ).bind(userId, addDays(weekStart, -7 * (REST_WEEKS - 1))).all<{ kind: string }>();
  return new Set(results.map((r) => r.kind.slice("body_adapt:".length)));
}

/** INSERT OR IGNORE this week's claim for one slot, so it rests whether it was taken or turned down. */
export async function restSlot(db: D1Database, userId: number, slot: AdaptSlot, weekStart: string): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO telegram_outbox_log (user_id, kind, local_date) VALUES (?, ?, ?)")
    .bind(userId, `body_adapt:${slot}`, weekStart).run();
  return r.meta.changes > 0;
}

/**
 * The one suggestion worth making, or null. A drift first — the largest gap between an ask that is on and
 * the median time the user logs at, two weeks running — and only if there is none, the ask that has gone
 * unused the most. Deterministic: the same Monday always picks the same slot.
 */
export async function pickAdaptation(db: D1Database, userId: number, today: string): Promise<Adaptation | null> {
  if (!(await loadBodyPlan(db, userId))) return null;
  const prefs = await db.prepare("SELECT * FROM telegram_prefs WHERE user_id = ?").bind(userId).first<Prefs>();
  if (!prefs) return null;
  const user = await db.prepare("SELECT timezone FROM users WHERE id = ?").bind(userId).first<{ timezone: string | null }>();
  const samples = await samplesBySlot(db, userId, today, user?.timezone ?? null);
  const resting = await restingSlots(db, userId, weekStartOf(today));

  // The asks that are on and not resting; an ask that is off has neither a time to move nor one to clear.
  const live: { slot: AdaptSlot; current: number }[] = [];
  for (const slot of ADAPT_SLOTS) {
    if (resting.has(slot)) continue;
    const current = slotMinutes(prefs[SLOT_FIELD[slot]]);
    if (current !== null) live.push({ slot, current });
  }

  let move: Adaptation | null = null;
  let bestGap = 0;
  for (const { slot, current } of live) {
    const drift = driftOf(samples[slot], current, today);
    if (!drift) continue;
    const gap = Math.abs(drift.median - current);
    if (gap <= bestGap) continue;
    bestGap = gap;
    move = { kind: "move", slot, from: hhmm(current), to: hhmm(drift.median), samples: drift.count };
  }
  if (move) return move;

  let off: Adaptation | null = null;
  let mostIgnored = 0;
  for (const { slot, current } of live) {
    const use = await askUse(db, userId, slot, today);
    if (use.asked < MIN_ASKS || use.ignored < use.asked * IGNORE_RATIO || use.ignored <= mostIgnored) continue;
    mostIgnored = use.ignored;
    off = { kind: "off", slot, from: hhmm(current), asked: use.asked, ignored: use.ignored };
  }
  return off;
}

// ---------- the message ----------

export type AdaptContext = Pick<CallbackContext, "db" | "userId" | "today" | "send">;

export function adaptText(a: Adaptation): string {
  if (a.kind === "off") {
    return [
      "⏰ 这个提醒好像没在用 · This ask mostly goes unanswered",
      `${SLOT_LABEL[a.slot]} 提醒在 ${a.from}，最近三周问了 ${a.asked} 次，${a.ignored} 次没有下文`,
      `the ask is at ${a.from}; ${a.ignored} of the last ${a.asked} led to nothing`,
      "关掉以后随时能在设置里开回来 · You can switch it back on in Settings.",
    ].join("\n");
  }
  return [
    "⏰ 提醒的时间对不太上 · The ask is at the wrong time",
    `${SLOT_LABEL[a.slot]} 提醒在 ${a.from}，你最近一般 ${a.to} 才记（${a.samples} 次）`,
    `the ask is at ${a.from}; you usually log around ${a.to} (${a.samples} logs)`,
    "改不改都行，不改就照旧 · Your call — nothing changes unless you tap.",
  ].join("\n");
}

/** The suggestion's two buttons: take it, or leave the slot exactly as it is. */
function adaptButtons(a: Adaptation): { text: string; callback_data: string }[] {
  return a.kind === "off"
    ? [
        { text: "关掉提醒 · Turn it off", callback_data: cb.adaptOff(a.slot) },
        { text: "留着 · Keep it", callback_data: cb.adaptKeep() },
      ]
    : [
        { text: `改成 ${a.to}`, callback_data: cb.adapt(a.slot, a.to) },
        { text: "不用 · Leave it", callback_data: cb.adaptKeep() },
      ];
}

/** The scheduler's condition: nothing to suggest = no claim, so a later tick in the window looks again. */
export async function adaptDue(ctx: AdaptContext): Promise<boolean> {
  return (await pickAdaptation(ctx.db, ctx.userId, ctx.today)) !== null;
}

/** The body_adapt kind: at most one suggestion, offered once and then rested for four weeks. */
export async function sendAdapt(ctx: AdaptContext): Promise<void> {
  const a = await pickAdaptation(ctx.db, ctx.userId, ctx.today);
  if (!a) return;
  // The slot's rest starts when it is offered; a tick that lost the race says nothing rather than repeating it.
  if (!(await restSlot(ctx.db, ctx.userId, a.slot, weekStartOf(ctx.today)))) return;
  await ctx.send({ text: adaptText(a), reply_markup: { inline_keyboard: [adaptButtons(a)] } });
}

// ---------- ad:<slot>:<hhmm> · ad:f:<slot> · ad:x ----------

/**
 * The suggestion's buttons: write the new time, clear the slot (`off`), or leave it alone. Both writes go
 * through the same telegram_prefs column the Settings page edits, so either can be undone there.
 */
export async function adaptButton(
  ctx: CallbackContext, slot: AdaptSlot | null, time: string | null, off = false
): Promise<string> {
  await logReply(ctx.db, ctx.userId, "body_adapt", ctx.today);
  if (!slot || (!time && !off)) {
    await ctx.finish("⏰ 照旧 · Left as it was");
    return "照旧 · Unchanged";
  }
  await ctx.db.prepare("INSERT OR IGNORE INTO telegram_prefs (user_id) VALUES (?)").bind(ctx.userId).run();
  await ctx.db.prepare(`UPDATE telegram_prefs SET ${SLOT_FIELD[slot]} = ? WHERE user_id = ?`)
    .bind(off ? null : time, ctx.userId).run();
  if (off) {
    await ctx.finish(`⏰ ${SLOT_LABEL[slot]} 已关掉 · Turned off\n设置里随时能开回来 · Switch it back on in Settings`);
    return "已关掉 · Turned off";
  }
  await ctx.finish(`⏰ ${SLOT_LABEL[slot]} 改到 ${time} · moved to ${time}`);
  return `已改到 ${time}`;
}
