// The monthly body report (docs/PRD-body.md §13 item 11). One message on the 1st of the month
// (telegram_prefs.body_month_at, filled from the default when a plan is created), covering the month
// that just ended: the trend at each end, what was logged, and the month's best week.
//
// Every number is bodyMonthReport's (worker/body.ts), the same object GET /api/body returns as `month`,
// so the message and the 本月 · This month card on the Body page can never disagree. No model is called:
// the report is arithmetic over the logs, exactly like the Sunday recap's block.

import { bodyMonthReport, loadBodyPlan } from "../body.ts";
import { addDays, monthStartOf } from "../dates.ts";
import type { BodyMonthReport } from "../../shared/types.ts";
import type { CallbackContext } from "./callback.ts";
import { logEvent } from "./events.ts";

export type BodyMonthContext = Pick<CallbackContext, "db" | "userId" | "today" | "send">;

/** +0.3 / −1.8 / 0.0, in kg. */
const deltaText = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}`;
const kgText = (n: number): string => n.toFixed(1);

/** The month a report sent on `today` covers: the one that ended yesterday. */
export function reportedMonth(today: string): string {
  return monthStartOf(addDays(monthStartOf(today), -1));
}

/** 2026-08 → 8 月 · August. */
function monthLabel(month: string): string {
  const name = new Date(month + "-01T00:00:00Z").toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return `${Number(month.slice(5, 7))} 月 · ${name}`;
}

/**
 * The projection then vs now: where the target date stood at the start of the window and where it
 * stands at its end. Earlier is progress, later is slippage — the shift is stated in days so neither
 * has to be read off two dates.
 */
function projectionText(r: BodyMonthReport): string {
  if (r.start_projected === null && r.end_projected === null) return "还算不出预计达成日 · no projected date yet";
  const shift = r.projected_shift_days === null
    ? ""
    : r.projected_shift_days === 0
      ? "（没动 · unchanged）"
      : r.projected_shift_days < 0
        ? `（提前 ${-r.projected_shift_days} 天 · ${-r.projected_shift_days} days earlier）`
        : `（推后 ${r.projected_shift_days} 天 · ${r.projected_shift_days} days later）`;
  return `预计达成 · projected ${r.start_projected ?? "—"} → ${r.end_projected ?? "—"}${shift}`;
}

/** The report as it is printed in the chat and, minus the heading, summarised on the Body page. */
export function bodyMonthBlock(r: BodyMonthReport, goalTitle: string): string {
  const weights = r.change_kg === null || r.start_trend === null || r.end_trend === null
    ? `称重 ${r.weigh_ins} 次，还算不出月度均值 · ${r.weigh_ins} weigh-ins, not enough for a monthly trend`
    : `${kgText(r.start_trend)} → ${kgText(r.end_trend)} kg（7日均 · 7-day）· 本月 ${deltaText(r.change_kg)} kg`
      + ` · 称重 ${r.weigh_ins} 次`;
  const meals = `记录饮食 ${r.meals_logged} 餐${r.kcal_avg !== null ? ` · 平均 ~${r.kcal_avg} kcal` : ""}`;
  const best = r.best_week
    ? `最好的一周 · best week ${r.best_week.week_start} · ${deltaText(r.best_week.change_kg)} kg · 运动 ${r.best_week.workouts} 次`
    : "还看不出最好的一周 · not enough weigh-ins to name a best week";
  return [
    `📅 ${monthLabel(r.month)}身体小结 · Body — ${goalTitle}`,
    `  ${weights}`,
    `  运动 ${r.workouts} 次 · ${r.minutes} 分钟 · ${meals}`,
    `  ${best}`,
    `  ${projectionText(r)}`,
  ].join("\n");
}

/** The scheduler's condition: a plan, and a month with something in it worth sending. */
export async function bodyMonthDue(ctx: BodyMonthContext): Promise<boolean> {
  if (!(await loadBodyPlan(ctx.db, ctx.userId))) return false;
  const r = await bodyMonthReport(ctx.db, ctx.userId, reportedMonth(ctx.today), ctx.today);
  return !!r && (r.weigh_ins > 0 || r.workouts > 0 || r.meals_logged > 0);
}

/** The body_month kind: one message on the 1st of the month. */
export async function sendBodyMonth(ctx: BodyMonthContext): Promise<void> {
  const plan = await loadBodyPlan(ctx.db, ctx.userId);
  if (!plan) return;
  const r = await bodyMonthReport(ctx.db, ctx.userId, reportedMonth(ctx.today), ctx.today);
  if (!r) return;
  await ctx.send({ text: bodyMonthBlock(r, plan.goal_title) });
  await logEvent(ctx.db, ctx.userId, "body_month", "sent", { local_date: ctx.today });
}
