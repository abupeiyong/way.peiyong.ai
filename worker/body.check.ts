// Unit-ish checks for the monthly body report (no test runner in this repo): `npm run check:month`.
// The database is a stub that answers the four statements bodyMonthReport and weightTrends make, so the
// arithmetic — not D1 — is what is under test. The load-bearing one is the issue's acceptance criterion:
// the month's change is the 7-day trend at each end, and those are the same trends the Body page's chart
// draws, so the card and the curve above it can never disagree.

import { bodyMonthReport, weightTrends } from "./body.ts";
import { bodyMonthBlock, reportedMonth } from "./telegram/bodymonth.ts";
import { addDays } from "./dates.ts";
import type { BodyMonthReport } from "../shared/types.ts";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

// ---------- the stub ----------

interface Fixture {
  plan: Record<string, unknown> | null;
  weights: { date: string; kg: number }[];
  workouts: { date: string; minutes: number }[];
  meals: { date: string; description: string; kcal: number | null }[];
}

/** Answers on the table name in the SQL; every date-ranged read is filtered by the two bound dates. */
function fakeDb(f: Fixture): D1Database {
  const between = <T extends { date: string }>(rows: T[], from: string, to: string): T[] =>
    rows.filter((r) => r.date >= from && r.date <= to).sort((a, b) => a.date.localeCompare(b.date));
  return {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          const [from, to] = args.slice(1) as string[];
          const rows = sql.includes("FROM weight_logs") ? between(f.weights, from, to)
            : sql.includes("FROM workout_logs") ? between(f.workouts, from, to)
            : sql.includes("FROM meal_logs") ? between(f.meals, from, to)
            : [];
          return {
            async first() { return sql.includes("FROM body_plans") ? f.plan : null; },
            async all() { return { results: rows }; },
          };
        },
      };
    },
  } as unknown as D1Database;
}

const PLAN = {
  goal_id: 1, metric: "weight", start_kg: 80, target_kg: 75, weekly_workouts: 3, daily_kcal: null,
  input_unit: "kg", goal_title: "减到 75 kg", target_date: "2026-12-31", goal_status: "active",
};

/** A weigh-in every day from `from` to `to`, falling `perDay` kg a day off 80.0. */
function falling(from: string, to: string, perDay: number, flatFrom?: string): { date: string; kg: number }[] {
  const out: { date: string; kg: number }[] = [];
  let kg = 80;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push({ date: d, kg: Math.round(kg * 100) / 100 });
    if (!flatFrom || d < flatFrom) kg -= perDay;
  }
  return out;
}

const TODAY = "2026-09-15";
const MONTH = "2026-08-01";

const steady: Fixture = {
  plan: PLAN,
  // The report at `from` fits over the 28 days before it, so the history has to start well before August.
  weights: falling("2026-06-20", "2026-08-31", 0.02),
  workouts: [
    { date: "2026-08-03", minutes: 40 }, { date: "2026-08-05", minutes: 35 },
    { date: "2026-08-12", minutes: 50 }, { date: "2026-08-13", minutes: 30 },
    { date: "2026-07-30", minutes: 99 }, // outside the month: must not be counted
  ],
  meals: [
    { date: "2026-08-04", description: "牛肉面", kcal: 600 },
    { date: "2026-08-05", description: "沙拉", kcal: 400 },
    { date: "2026-08-06", description: "", kcal: null }, // 没吃: answers the ask, is not a meal eaten
  ],
};

const db = fakeDb(steady);
const r = (await bodyMonthReport(db, 1, MONTH, TODAY)) as BodyMonthReport;

// ---------- the month's window ----------

check(r.month === "2026-08" && r.from === "2026-08-01" && r.to === "2026-08-31", "a past month runs first to last");
check(r.weigh_ins === 31, "only August's weigh-ins are counted, not the lookback the fit needs");
check(r.workouts === 2 + 2 && r.minutes === 155, "only August's workouts are counted");
check(r.meals_logged === 2 && r.kcal_avg === 500, "a 没吃 row is not a meal, and kcal averages over the days that have one");

// ---------- the acceptance criterion: the report matches the chart ----------

const [chartStart, chartEnd] = await weightTrends(db, 1, [r.from, r.to]);
check(r.start_trend === chartStart && r.end_trend === chartEnd, "both ends are the same 7-day trend the chart plots");
check(
  r.change_kg === Math.round(((r.end_trend as number) - (r.start_trend as number)) * 10) / 10,
  "the month's change is exactly end trend − start trend"
);
check(r.change_kg === -0.6, "0.02 kg a day for 30 days is −0.6 kg of trend");

// ---------- the projection then vs now ----------

check(r.start_projected !== null && r.end_projected !== null, "a full fit at each end projects a date at each end");
check(r.projected_shift_days === 0, "a steady rate leaves the projected date where it was");
check(bodyMonthBlock(r, PLAN.goal_title).includes(`预计达成 · projected ${r.start_projected} → ${r.end_projected}`),
  "the message prints the projection then → now");
check(bodyMonthBlock(r, PLAN.goal_title).includes("没动 · unchanged"), "an unmoved projection says so");

// A month that starts well and then stalls: the target may only move later, never earlier.
const stalled = (await bodyMonthReport(
  fakeDb({ ...steady, weights: falling("2026-06-20", "2026-08-31", 0.02, "2026-08-16") }), 1, MONTH, TODAY
)) as BodyMonthReport;
check(stalled.projected_shift_days === null || stalled.projected_shift_days > 0, "stalling pushes the projection out, never in");

// ---------- too little to say ----------

const thin = (await bodyMonthReport(fakeDb({ ...steady, weights: [{ date: "2026-08-10", kg: 79 }] }), 1, MONTH, TODAY)) as BodyMonthReport;
check(thin.change_kg === null && thin.start_trend === null, "one weigh-in is not a trend");
check(thin.start_projected === null && thin.end_projected === null && thin.projected_shift_days === null, "no trend, no projection");
check(bodyMonthBlock(thin, PLAN.goal_title).includes("还算不出预计达成日"), "the message says so rather than inventing a date");

// The running month is capped at today, so the card on the page never reports days that have not happened.
const running = (await bodyMonthReport(db, 1, TODAY, TODAY)) as BodyMonthReport;
check(running.from === "2026-09-01" && running.to === TODAY, "the running month stops at today");

// ---------- the 1st sends the month that just ended ----------

check(reportedMonth("2026-09-01") === "2026-08-01", "the 1st reports the month before it");
check(reportedMonth("2026-01-01") === "2025-12-01", "and across a year boundary");

// No plan, no month: there is nothing to be a month of.
check((await bodyMonthReport(fakeDb({ ...steady, plan: null }), 1, MONTH, TODAY)) === null, "no plan, no report");

console.log("all checks passed");
