// Adaptive prompt times (docs/PRD-body.md §13 item 10): learn when the user actually logs, and
// **propose** a better slot — never change one behind their back.
//
//   body_adapt (Monday 09:30 local, gated on telegram_prefs.body_nudges like the noon nudge) →
//     for each body slot, the median local time of the last 28 days of that log; the slot whose ask is
//     furthest from it, by at least 30 minutes and over at least 5 logs, is offered once:
//       ⏰ 你一般 13:40 记午饭，提醒在 13:00 · [改成 13:40] [不用]
//   ad:<slot>:<hhmm> → write the new time into telegram_prefs · ad:x → leave it alone
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

/** Days of logs a suggestion is read from. */
const WINDOW_DAYS = 28;
/** Logs a slot needs before its median means anything. */
const MIN_SAMPLES = 5;
/** Minutes between the ask and the median before it is worth saying anything. */
const MIN_SHIFT_MIN = 30;
/** Weeks a slot rests after it was offered or dismissed. */
const REST_WEEKS = 4;

export interface Adaptation {
  slot: AdaptSlot;
  /** The current 'HH:MM' of that ask. */
  from: string;
  /** The median 'HH:MM' the user actually logs at. */
  to: string;
  /** How many logs the median came from. */
  samples: number;
}

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

/** The local times this user logged at, per slot, over the last 28 days. */
async function samplesBySlot(
  db: D1Database, userId: number, today: string, timezone: string | null
): Promise<Record<AdaptSlot, number[]>> {
  const from = addDays(today, -(WINDOW_DAYS - 1));
  const out: Record<AdaptSlot, number[]> = { weigh: [], breakfast: [], lunch: [], dinner: [], workout: [] };
  try {
    const [weights, meals, workouts] = await Promise.all([
      db.prepare("SELECT created_at FROM weight_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
        .bind(userId, from, today).all<{ created_at: string }>(),
      // time_min is the local minute the meal was logged at, already in the user's own clock.
      db.prepare("SELECT kind, time_min FROM meal_logs WHERE user_id = ? AND date BETWEEN ? AND ? AND time_min IS NOT NULL")
        .bind(userId, from, today).all<{ kind: string; time_min: number }>(),
      db.prepare("SELECT created_at FROM workout_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
        .bind(userId, from, today).all<{ created_at: string }>(),
    ]);
    for (const w of weights.results) {
      const m = localMinutesOf(w.created_at, timezone);
      if (m !== null) out.weigh.push(m);
    }
    for (const m of meals.results) {
      if (m.kind === "breakfast" || m.kind === "lunch" || m.kind === "dinner") out[m.kind].push(m.time_min);
    }
    for (const o of workouts.results) {
      const m = localMinutesOf(o.created_at, timezone);
      if (m !== null) out.workout.push(m);
    }
  } catch {
    // migration 0004 has not run here: nothing to learn from.
  }
  return out;
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
 * The one slot worth moving, or null: the largest gap between an ask that is on and the median time the
 * user logs at, over at least MIN_SAMPLES logs and at least MIN_SHIFT_MIN minutes. Deterministic.
 */
export async function pickAdaptation(db: D1Database, userId: number, today: string): Promise<Adaptation | null> {
  if (!(await loadBodyPlan(db, userId))) return null;
  const prefs = await db.prepare("SELECT * FROM telegram_prefs WHERE user_id = ?").bind(userId).first<Prefs>();
  if (!prefs) return null;
  const user = await db.prepare("SELECT timezone FROM users WHERE id = ?").bind(userId).first<{ timezone: string | null }>();
  const samples = await samplesBySlot(db, userId, today, user?.timezone ?? null);
  const resting = await restingSlots(db, userId, weekStartOf(today));

  let best: Adaptation | null = null;
  let bestGap = 0;
  for (const slot of ADAPT_SLOTS) {
    if (resting.has(slot)) continue;
    const current = slotMinutes(prefs[SLOT_FIELD[slot]]);
    if (current === null) continue; // the ask is off: nothing to move
    const values = samples[slot];
    if (values.length < MIN_SAMPLES) continue;
    const median = medianMinutes(values);
    if (median === null) continue;
    const gap = Math.abs(median - current);
    if (gap < MIN_SHIFT_MIN || gap <= bestGap) continue;
    bestGap = gap;
    best = { slot, from: hhmm(current), to: hhmm(median), samples: values.length };
  }
  return best;
}

// ---------- the message ----------

export type AdaptContext = Pick<CallbackContext, "db" | "userId" | "today" | "send">;

export function adaptText(a: Adaptation): string {
  return [
    "⏰ 提醒的时间对不太上 · The ask is at the wrong time",
    `${SLOT_LABEL[a.slot]} 提醒在 ${a.from}，你最近一般 ${a.to} 才记（${a.samples} 次）`,
    `the ask is at ${a.from}; you usually log around ${a.to} (${a.samples} logs)`,
    "改不改都行，不改就照旧 · Your call — nothing changes unless you tap.",
  ].join("\n");
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
  await ctx.send({
    text: adaptText(a),
    reply_markup: {
      inline_keyboard: [[
        { text: `改成 ${a.to}`, callback_data: cb.adapt(a.slot, a.to) },
        { text: "不用 · Leave it", callback_data: cb.adaptKeep() },
      ]],
    },
  });
}

// ---------- ad:<slot>:<hhmm> · ad:x ----------

/** The suggestion's buttons: write the new time, or leave the slot alone. Both end the card. */
export async function adaptButton(ctx: CallbackContext, slot: AdaptSlot | null, time: string | null): Promise<string> {
  await logReply(ctx.db, ctx.userId, "body_adapt", ctx.today);
  if (!slot || !time) {
    await ctx.finish("⏰ 照旧 · Left as it was");
    return "照旧 · Unchanged";
  }
  await ctx.db.prepare("INSERT OR IGNORE INTO telegram_prefs (user_id) VALUES (?)").bind(ctx.userId).run();
  await ctx.db.prepare(`UPDATE telegram_prefs SET ${SLOT_FIELD[slot]} = ? WHERE user_id = ?`)
    .bind(time, ctx.userId).run();
  await ctx.finish(`⏰ ${SLOT_LABEL[slot]} 改到 ${time} · moved to ${time}`);
  return `已改到 ${time}`;
}
