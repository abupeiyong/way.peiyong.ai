// Body — the deterministic numbers behind a weight goal (docs/PRD-body.md §8.1), shared by the web,
// the bot and the Guide. Nothing here calls a model: the trend is the mean of the weigh-ins, the rate is
// a least-squares fit over it, and the projected date follows from the two. The Guide reads this; it
// never computes a projection of its own.
//
// Every statement is scoped by user_id. The tables arrive with migration 0004, so every read is wrapped
// in a try/catch: on a database where 0004 has not run yet, a body-less account is the answer, not a 500.

import type { BodyPlan, BodySummary, BodyVerdict, WeightLog } from "../shared/types.ts";
import { BODY_VERDICT_TEXT } from "../shared/body.ts";
import { addDays, weekStartOf } from "./dates.ts";

/** Goal titles that look like a weight goal (PRD-body §4.2) — used to offer a plan, never to create one. */
export const WEIGHT_GOAL_RE = /体重|减肥|减重|增肌|瘦|weight|lose|gain|kg|lb/i;

/** "能不能达成" and friends: the question that must be answered from the summary first (PRD-body §8.3). */
const FEASIBILITY_RE = /能不能|能否|来得及|赶得上|达得到|达成|做得到|有没有希望|on track|make it|achievable|reach (it|the target)|going to (hit|reach)/i;

const TREND_WINDOW = 7;   // days averaged into the trend
const FIT_WINDOW = 28;    // days the rate is fitted over
const MIN_TREND_READINGS = 2;
const MIN_FIT_READINGS = 7;
/** kg/week below which the trend counts as flat rather than as movement. */
const FLAT = 0.05;
/** ±7 days of the goal's target date is "on track" (PRD-body §8.1). */
const ON_TRACK_DAYS = 7;

const dayNumber = (date: string): number => Math.round(Date.parse(date + "T00:00:00Z") / 86400000);

/** The user's body plan with the goal it serves, or null when there is none (or no body tables yet). */
export async function loadBodyPlan(db: D1Database, userId: number): Promise<BodyPlan | null> {
  let row: (BodyPlan & { goal_status: string }) | null = null;
  try {
    row = await db.prepare(
      `SELECT p.goal_id, p.metric, p.start_kg, p.target_kg, p.weekly_workouts, p.daily_kcal, p.input_unit,
              g.title AS goal_title, g.target_date, g.status AS goal_status
         FROM body_plans p JOIN goals g ON g.id = p.goal_id AND g.user_id = p.user_id
        WHERE p.user_id = ?`
    ).bind(userId).first<BodyPlan & { goal_status: string }>();
  } catch {
    return null; // migration 0004 has not run here
  }
  if (!row) return null;
  // A completed or abandoned goal stops every body prompt; the logs stay (PRD-body §4.3).
  if (row.goal_status === "completed" || row.goal_status === "abandoned" || row.goal_status === "archived") return null;
  const { goal_status: _s, ...plan } = row;
  return plan;
}

/** The active goal whose title looks like a weight goal, when no plan exists yet (PRD-body §4.2). */
export async function suggestedWeightGoal(db: D1Database, userId: number): Promise<string | null> {
  const { results } = await db.prepare(
    "SELECT title FROM goals WHERE user_id = ? AND status IN ('active','at_risk') ORDER BY id"
  ).bind(userId).all<{ title: string }>();
  return results.find((g) => WEIGHT_GOAL_RE.test(g.title))?.title ?? null;
}

/** Least-squares slope of y over x; null when the points are degenerate. */
function slope(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den === 0 ? null : num / den;
}

/** Mean of the readings in [date−6, date]; null with fewer than two of them (PRD-body §8.1). */
function trendOf(weights: { date: string; kg: number }[], date: string): number | null {
  const from = addDays(date, -(TREND_WINDOW - 1));
  const inWindow = weights.filter((w) => w.date >= from && w.date <= date);
  if (inWindow.length < MIN_TREND_READINGS) return null;
  return inWindow.reduce((s, w) => s + w.kg, 0) / inWindow.length;
}

/**
 * The 7-day trend on each of `dates`, rounded like bodySummary's, from one read of the weigh-ins.
 * The nudge rules and the Sunday recap compare the trend a week and a month back (PRD-body §6.2, §8.2).
 */
export async function weightTrends(db: D1Database, userId: number, dates: string[]): Promise<(number | null)[]> {
  if (!dates.length) return [];
  const from = addDays(dates.reduce((a, b) => (a < b ? a : b)), -(TREND_WINDOW - 1));
  const to = dates.reduce((a, b) => (a > b ? a : b));
  let weights: WeightLog[] = [];
  try {
    const r = await db.prepare("SELECT date, kg, source, note FROM weight_logs WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date")
      .bind(userId, from, to).all<WeightLog>();
    weights = r.results;
  } catch {
    return dates.map(() => null); // migration 0004 has not run here
  }
  return dates.map((d) => {
    const t = trendOf(weights, d);
    return t === null ? null : Math.round(t * 10) / 10;
  });
}

/**
 * The weigh-ins from `from` (inclusive) on, oldest first — the Body page's chart and the Insights
 * sparkline read the same rows the summary is built from. No plan, no 0004: an empty history.
 */
export async function loadWeightLogs(db: D1Database, userId: number, from?: string): Promise<WeightLog[]> {
  try {
    const { results } = from
      ? await db.prepare("SELECT date, kg, source, note FROM weight_logs WHERE user_id = ? AND date >= ? ORDER BY date")
          .bind(userId, from).all<WeightLog>()
      : await db.prepare("SELECT date, kg, source, note FROM weight_logs WHERE user_id = ? ORDER BY date")
          .bind(userId).all<WeightLog>();
    return results;
  } catch {
    return []; // migration 0004 has not run here
  }
}

/** The whole picture for the user's weight goal, or null when there is no plan. */
export async function bodySummary(db: D1Database, userId: number, today: string): Promise<BodySummary | null> {
  const plan = await loadBodyPlan(db, userId);
  if (!plan) return null;

  const weekStart = weekStartOf(today);
  let weights: WeightLog[] = [];
  let workouts: { minutes: number }[] = [];
  let meals: { date: string; description: string; kcal: number | null }[] = [];
  try {
    const [w, o, m] = await Promise.all([
      db.prepare("SELECT date, kg, source, note FROM weight_logs WHERE user_id = ? AND date <= ? AND date >= ? ORDER BY date")
        .bind(userId, today, addDays(today, -89)).all<WeightLog>(),
      db.prepare("SELECT minutes FROM workout_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
        .bind(userId, weekStart, today).all<{ minutes: number }>(),
      db.prepare("SELECT date, description, kcal FROM meal_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
        .bind(userId, weekStart, today).all<{ date: string; description: string; kcal: number | null }>(),
    ]);
    weights = w.results;
    workouts = o.results;
    meals = m.results;
  } catch {
    // 0004 not applied: the plan could not have been created either, but stay quiet rather than throw.
  }

  const trendAt = (date: string): number | null => trendOf(weights, date);

  const trend = trendAt(today);
  const trendPrev = trendAt(addDays(today, -TREND_WINDOW));

  const fitFrom = addDays(today, -(FIT_WINDOW - 1));
  const fitPoints = weights
    .filter((w) => w.date >= fitFrom)
    .map((w) => ({ x: dayNumber(w.date), y: trendAt(w.date) }))
    .filter((p): p is { x: number; y: number } => p.y !== null);
  const rate = fitPoints.length >= MIN_FIT_READINGS ? slope(fitPoints) : null;
  const rateWeekly = rate === null ? null : Math.round(rate * 7 * 100) / 100;

  const gaining = plan.target_kg > plan.start_kg;
  // Kilograms still to go, and the weekly movement toward the target (positive = closing the gap).
  const remaining = trend === null ? null : Math.round((gaining ? plan.target_kg - trend : trend - plan.target_kg) * 10) / 10;
  const toward = rateWeekly === null ? null : gaining ? rateWeekly : -rateWeekly;

  let projected: string | null = null;
  if (remaining !== null && remaining <= 0) projected = today;
  else if (remaining !== null && toward !== null && toward > FLAT) projected = addDays(today, Math.ceil((remaining / toward) * 7));

  let verdict: BodyVerdict;
  if (trend === null) verdict = "no_data";
  else if (remaining !== null && remaining <= 0) verdict = "ahead";
  else if (toward === null) verdict = "no_data";
  else if (toward < -FLAT) verdict = "wrong_way";
  else if (toward <= FLAT || projected === null) verdict = "stalled";
  else if (!plan.target_date) verdict = "on_track";
  else {
    const slip = dayNumber(projected) - dayNumber(plan.target_date);
    verdict = slip <= -ON_TRACK_DAYS ? "ahead" : slip >= ON_TRACK_DAYS ? "behind" : "on_track";
  }

  // Progress follows the trend, falling back to the latest reading so the very first weigh-in
  // already moves the bar (the projection never does: that needs a trend).
  const span = plan.start_kg - plan.target_kg;
  const at = trend ?? (weights.length ? weights[weights.length - 1].kg : null);
  const progress = at === null || span === 0
    ? null
    : Math.max(0, Math.min(100, Math.round(((plan.start_kg - at) / span) * 100)));

  const kcalDays = [...new Set(meals.filter((m) => m.kcal !== null).map((m) => m.date))].length;
  const kcalTotal = meals.reduce((s, m) => s + (m.kcal ?? 0), 0);

  return {
    plan,
    today,
    latest: weights.length ? weights[weights.length - 1] : null,
    trend: trend === null ? null : Math.round(trend * 10) / 10,
    trend_prev: trendPrev === null ? null : Math.round(trendPrev * 10) / 10,
    rate_kg_per_week: rateWeekly,
    remaining_kg: remaining,
    projected_date: projected,
    verdict,
    progress,
    week: {
      workouts_done: workouts.length,
      workouts_target: plan.weekly_workouts,
      minutes: workouts.reduce((s, w) => s + w.minutes, 0),
      kcal_avg: kcalDays ? Math.round(kcalTotal / kcalDays) : null,
      // A 「没吃」row (empty description, PRD-body §5.2) answers the prompt but is not a meal eaten.
      meals_logged: meals.filter((m) => m.description.trim()).length,
    },
  };
}

/**
 * goals.progress is derived for a goal with a body plan (PRD-body §4.3): recompute it after a weigh-in.
 * A goal without enough readings keeps the number it has.
 */
export async function refreshBodyGoalProgress(db: D1Database, userId: number, today: string): Promise<number | null> {
  const summary = await bodySummary(db, userId, today);
  if (!summary || summary.progress === null) return null;
  await db.prepare("UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(summary.progress, summary.plan.goal_id, userId).run();
  return summary.progress;
}

// ---------- wording, shared by /body, the Guide and the web ----------

const kg = (n: number): string => n.toFixed(1);

/** −0.30 kg/周·week, or "—" when there is no fit yet. */
function rateText(s: BodySummary): string {
  if (s.rate_kg_per_week === null) return "—";
  const n = s.rate_kg_per_week;
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(2)} kg/周·week`;
}

/**
 * The deterministic answer to "能不能达成" (PRD-body §8.3): verdict, projected date and rate, in that order.
 * `/body` opens with it and the Guide's reply is prefixed with it, so both quote the same numbers.
 */
export function bodyVerdictLine(s: BodySummary): string {
  const projected = s.projected_date
    ? `预计 ${s.projected_date} 达到 ${kg(s.plan.target_kg)} kg · projected ${s.projected_date}`
    : `还算不出日期 · no projected date yet`;
  return `⚖️ ${BODY_VERDICT_TEXT[s.verdict]}\n${projected} · ${rateText(s)}${s.plan.target_date ? ` · 目标 ${s.plan.target_date}` : ""}`;
}

/** The body block: the verdict line plus today's numbers and the week (PRD-body §6.1, §11). */
export function bodyBlock(s: BodySummary): string {
  const now = s.latest
    ? `${kg(s.latest.kg)} kg（${s.latest.date}）· 7日均 ${s.trend === null ? "—" : kg(s.trend)}`
      + `${s.trend !== null && s.trend_prev !== null ? ` ${s.trend <= s.trend_prev ? "↓" : "↑"}${Math.abs(s.trend - s.trend_prev).toFixed(1)}/周` : ""}`
    : "还没有称重记录 · no weigh-ins yet";
  const gap = s.remaining_kg === null ? "" : s.remaining_kg > 0 ? ` · 距目标 ${kg(s.remaining_kg)} kg` : " · 已达目标 ✓";
  return [
    `⚖️ 身体 · Body — ${s.plan.goal_title}`,
    `${now}${gap}`,
    bodyVerdictLine(s),
    `本周运动 ${s.week.workouts_done}/${s.week.workouts_target} · ${s.week.minutes} 分钟`
      + `${s.week.kcal_avg !== null ? ` · 平均 ~${s.week.kcal_avg} kcal` : ""}`,
  ].join("\n");
}

/** One line for guideContext: every number the model is allowed to quote about the goal. */
export function bodyContextLine(s: BodySummary): string {
  const parts = [
    `goal "${s.plan.goal_title}"`,
    `start ${kg(s.plan.start_kg)} kg → target ${kg(s.plan.target_kg)} kg${s.plan.target_date ? ` by ${s.plan.target_date}` : " (no target date)"}`,
    s.latest ? `latest ${kg(s.latest.kg)} kg on ${s.latest.date}` : "no weigh-ins yet",
    `7-day trend ${s.trend === null ? "n/a" : `${kg(s.trend)} kg`}`,
    `rate ${s.rate_kg_per_week === null ? "n/a" : `${s.rate_kg_per_week.toFixed(2)} kg/week`}`,
    `remaining ${s.remaining_kg === null ? "n/a" : `${kg(s.remaining_kg)} kg`}`,
    `projected ${s.projected_date ?? "n/a"}`,
    `verdict ${s.verdict}`,
    `this week ${s.week.workouts_done}/${s.week.workouts_target} workouts, ${s.week.minutes} min`
      + `${s.week.kcal_avg !== null ? `, ~${s.week.kcal_avg} kcal/day` : ""}`,
  ];
  return parts.join(" · ");
}

/** Is this Guide message about the weight goal? Then the deterministic answer goes first (PRD-body §8.3). */
export function asksAboutBody(text: string, s: BodySummary): boolean {
  const title = s.plan.goal_title.trim();
  if (title && text.toLowerCase().includes(title.toLowerCase())) return true;
  return WEIGHT_GOAL_RE.test(text) || FEASIBILITY_RE.test(text);
}
