// Derivations over observations (docs/PRD-brain.md §7, §8) — the deterministic half of the system.
// Nothing here calls a model, and the model is never allowed to produce any number this file returns
// (PRD-brain §4 R2). The bot, the web and the Guide all read these, so they cannot disagree.
//
// Every operator is generic over the stream's shape: "sum this period" is the same code for kilograms
// and for minutes. That genericity is what makes one `observations` table enough.

import type { GoalKind, Period, Shape, Verdict } from "../shared/streams.ts";
import { addDays, monthStartOf, weekStartOf } from "./dates.ts";

export interface Obs {
  at: string;
  num: number | null;
}

/** The start of the period `date` falls in. */
export function periodStart(period: Period, date: string): string {
  if (period === "day") return date;
  if (period === "week") return weekStartOf(date);
  return monthStartOf(date);
}

/** The last day of the period `date` falls in. */
export function periodEnd(period: Period, date: string): string {
  if (period === "day") return date;
  if (period === "week") return addDays(weekStartOf(date), 6);
  const d = new Date(monthStartOf(date) + "T00:00:00Z");
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/** The period before the one `date` falls in. */
export function previousPeriod(period: Period, date: string): string {
  return periodStart(period, addDays(periodStart(period, date), -1));
}

const dayNumber = (date: string): number => Math.round(Date.parse(date + "T00:00:00Z") / 86400000);

/** How much of the period has gone by, counting today as used up: 0 < f ≤ 1. */
export function elapsedFraction(period: Period, today: string): number {
  const from = dayNumber(periodStart(period, today));
  const to = dayNumber(periodEnd(period, today));
  const total = to - from + 1;
  return Math.min(1, Math.max(1 / total, (dayNumber(today) - from + 1) / total));
}

/** Days left in the period, today included. */
export function daysLeft(period: Period, today: string): number {
  return dayNumber(periodEnd(period, today)) - dayNumber(today) + 1;
}

// ---------- aggregation ----------

/** Sum of `num` over [from, to]. A bool stream sums to a count of days it happened. */
export function sumBetween(obs: Obs[], from: string, to: string): number {
  return obs.reduce((t, o) => (o.at >= from && o.at <= to && o.num !== null ? t + o.num : t), 0);
}

/** Per-period totals, oldest first, over the `count` periods ending with the one `today` falls in. */
export function periodTotals(obs: Obs[], period: Period, today: string, count: number): { start: string; total: number }[] {
  const out: { start: string; total: number }[] = [];
  let start = periodStart(period, today);
  for (let i = 0; i < count; i++) {
    out.unshift({ start, total: sumBetween(obs, start, periodEnd(period, start)) });
    start = previousPeriod(period, start);
  }
  return out;
}

/** Mean of the readings in [date−(window−1), date]; null with fewer than `min` of them. */
export function trendOn(obs: Obs[], date: string, window = 7, min = 2): number | null {
  const from = addDays(date, -(window - 1));
  const w = obs.filter((o) => o.at >= from && o.at <= date && o.num !== null);
  return w.length < min ? null : w.reduce((t, o) => t + (o.num as number), 0) / w.length;
}

/** Least-squares slope of y over x; null when the points are degenerate. */
function slope(points: { x: number; y: number }[]): number | null {
  const n = points.length;
  if (n < 2) return null;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  if (den === 0) return null;
  return points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0) / den;
}

/** kg-per-week style rate: the slope of the smoothed series over the last `window` days. */
export function weeklyRate(obs: Obs[], today: string, window = 28, minReadings = 7): number | null {
  const from = addDays(today, -(window - 1));
  const pts = obs
    .filter((o) => o.at >= from && o.at <= today)
    .map((o) => ({ x: dayNumber(o.at), y: trendOn(obs, o.at) }))
    .filter((p): p is { x: number; y: number } => p.y !== null);
  if (pts.length < minReadings) return null;
  const s = slope(pts);
  return s === null ? null : Math.round(s * 7 * 100) / 100;
}

// ---------- the goal verdict ----------

const round1 = (n: number): number => Math.round(n * 10) / 10;

/** kg/week (or unit/week) below which a trend counts as flat rather than as movement. */
const FLAT = 0.05;
/** Within this many days of the deadline counts as on track. */
const ON_TRACK_DAYS = 7;
/** A period is written off when even a perfect run of the remaining days cannot reach the target. */
const MAX_CATCHUP_PER_DAY_FACTOR = 3;

export interface GoalSpec {
  kind: GoalKind;
  shape: Shape;
  target: number;
  /** accumulate/reduce/maintain. */
  period?: Period | null;
  /** reach: the value the goal started from, so progress has a denominator. */
  start?: number | null;
  /** reach: the date the target should be met by. */
  deadline?: string | null;
}

export interface GoalStatus {
  verdict: Verdict;
  /** 0–100, or null when there is not enough to say. */
  progress: number | null;
  /** What the period or the trend currently stands at. */
  current: number | null;
  /** accumulate: what the pace says should be done by now. */
  expected?: number | null;
  /** reach: the smoothed value, the weekly rate, and where it lands. */
  trend?: number | null;
  rate?: number | null;
  remaining?: number | null;
  projected_date?: string | null;
  /** accumulate: the period under way. */
  period_start?: string;
  period_end?: string;
  days_left?: number;
}

/**
 * The whole judgement for one goal, from its observations. P0 computes `reach` and `accumulate`;
 * every other kind returns `no_data` until its own maths lands, rather than guessing.
 */
export function goalStatus(spec: GoalSpec, obs: Obs[], today: string): GoalStatus {
  if (spec.kind === "accumulate") return accumulateStatus(spec, obs, today);
  if (spec.kind === "reach") return reachStatus(spec, obs, today);
  return { verdict: "no_data", progress: null, current: null };
}

function accumulateStatus(spec: GoalSpec, obs: Obs[], today: string): GoalStatus {
  const period = spec.period ?? "week";
  const start = periodStart(period, today);
  const end = periodEnd(period, today);
  const done = round1(sumBetween(obs, start, end));
  const target = spec.target;
  const elapsed = elapsedFraction(period, today);
  const expected = round1(target * elapsed);
  const left = daysLeft(period, today);
  const progress = target <= 0 ? null : Math.max(0, Math.min(100, Math.round((done / target) * 100)));

  const base = { progress, current: done, expected, period_start: start, period_end: end, days_left: left };
  if (done >= target) return { ...base, verdict: "ahead" };
  if (!obs.some((o) => o.at >= start && o.at <= end)) {
    // Nothing logged this period: too early to judge until the pace has actually slipped.
    return { ...base, verdict: elapsed < 0.5 ? "on_pace" : "behind" };
  }
  // Out of reach when even an unusually good run of the days left cannot close the gap.
  const perDay = target / ((dayNumber(end) - dayNumber(start)) + 1);
  if (target - done > perDay * MAX_CATCHUP_PER_DAY_FACTOR * left) return { ...base, verdict: "unreachable" };
  return { ...base, verdict: done >= expected ? "on_pace" : "behind" };
}

function reachStatus(spec: GoalSpec, obs: Obs[], today: string): GoalStatus {
  const trendRaw = trendOn(obs, today);
  const latest = obs.length ? obs[obs.length - 1].num : null;
  const at = trendRaw ?? latest;
  const trend = trendRaw === null ? null : round1(trendRaw);
  const rate = weeklyRate(obs, today);
  const startValue = spec.start ?? null;
  const gaining = startValue !== null ? spec.target > startValue : at !== null && spec.target > at;

  const remaining = at === null ? null : round1(gaining ? spec.target - at : at - spec.target);
  const toward = rate === null ? null : gaining ? rate : -rate;

  let projected: string | null = null;
  if (remaining !== null && remaining <= 0) projected = today;
  else if (remaining !== null && toward !== null && toward > FLAT) projected = addDays(today, Math.ceil((remaining / toward) * 7));

  let verdict: Verdict;
  if (at === null) verdict = "no_data";
  else if (remaining !== null && remaining <= 0) verdict = "ahead";
  else if (toward === null) verdict = "no_data";
  else if (toward < -FLAT) verdict = "wrong_way";
  else if (toward <= FLAT || projected === null) verdict = "stalled";
  else if (!spec.deadline) verdict = "on_track";
  else {
    const slip = dayNumber(projected) - dayNumber(spec.deadline);
    verdict = slip <= -ON_TRACK_DAYS ? "ahead" : slip >= ON_TRACK_DAYS ? "behind" : "on_track";
  }

  const span = startValue === null ? null : startValue - spec.target;
  const progress = at === null || span === null || span === 0
    ? null
    : Math.max(0, Math.min(100, Math.round(((startValue as number) - at) / span * 100)));

  return {
    verdict, progress, current: at === null ? null : round1(at),
    trend, rate, remaining, projected_date: projected,
  };
}
