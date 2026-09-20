// Body nudges and the Sunday recap (docs/PRD-body.md §6.2, §8.2).
//   body_nudge (12:00 local, telegram_prefs.body_nudges) → four deterministic rules in priority order:
//     1 no weigh-in for 3 days · 2 workouts behind pace · 3 trend the wrong way two weeks · 4 kcal over budget 3 days
//     At most ONE message a day (the scheduler's daily outbox claim) and at most one of each rule a week
//     (telegram_outbox_log kind `body_nudge:<rule>`, keyed by the week's Monday). No streaks, no guilt.
//   bn:<rule>   → the nudge's one button: the weight ask · a 30-minute task · a Guide turn · the Body page
//   body_recap  → sent inside Sunday's weekly_review when a plan exists: the §8.2 block, then one Guide turn
//                 asked for at most one proposal, rendered with the usual [✓ 采用] buttons. No model = the block alone.
//
// Every number here comes from bodySummary (worker/body.ts), the same object GET /api/body returns, so the
// recap and the web can never disagree. Nothing is written without a tap.

import { bodyContextLine, bodySummary, weightTrends } from "../body.ts";
import { addDays, weekdayOf, weekStartOf } from "../dates.ts";
import { guideChat, type GuideEnv } from "../guide.ts";
import { applyProposal } from "../proposals.ts";
import type { BodySummary } from "../../shared/types.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logEvent, logReply } from "./events.ts";
import { guideReplyCard } from "./guide.ts";
import type { Reply } from "./router.ts";

/** The rules of §6.2, in the priority order they are checked in. */
export const BODY_NUDGE_RULES = ["weigh", "workout", "trend", "kcal"] as const;
export type BodyNudgeRule = (typeof BODY_NUDGE_RULES)[number];

/** Days without a weigh-in before rule 1 fires. */
const WEIGH_GAP_DAYS = 3;
/** Kilograms the trend has to move away from the target, each week, for rule 3 to count it as a direction. */
const WRONG_WAY_KG = 0.1;
/** Days in a row over the kcal budget for rule 4. */
const OVER_BUDGET_DAYS = 3;
/** The task rule 2 offers to create. */
const WORKOUT_TASK_MIN = 30;

const kgText = (n: number): string => n.toFixed(1);
/** −0.5 / +0.3 / 0.0, in kg. */
const deltaText = (n: number): string => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}`;

export type BodyNudgeContext = Pick<CallbackContext, "db" | "userId" | "today" | "send">;

interface Nudge {
  rule: BodyNudgeRule;
  text: string;
  /** The label of the nudge's single button; its callback_data is always bn:<rule>. */
  button: string;
}

// ---------- the rules (§6.2) ----------

/** Rules already sent this week, from the per-rule outbox claims keyed by the week's Monday. */
async function rulesSentThisWeek(db: D1Database, userId: number, weekStart: string): Promise<Set<string>> {
  const { results } = await db.prepare(
    "SELECT kind FROM telegram_outbox_log WHERE user_id = ? AND local_date = ? AND kind LIKE 'body_nudge:%'"
  ).bind(userId, weekStart).all<{ kind: string }>();
  return new Set(results.map((r) => r.kind.slice("body_nudge:".length)));
}

/** INSERT OR IGNORE the week's claim for one rule; false = it has already gone out this week. */
async function claimRule(db: D1Database, userId: number, rule: BodyNudgeRule, weekStart: string): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO telegram_outbox_log (user_id, kind, local_date) VALUES (?, ?, ?)")
    .bind(userId, `body_nudge:${rule}`, weekStart).run();
  return r.meta.changes > 0;
}

/** Rule 1 — no weigh-in for three days. */
function weighRule(s: BodySummary, today: string): Nudge | null {
  const since = s.latest?.date ?? null;
  if (since && since > addDays(today, -WEIGH_GAP_DAYS)) return null;
  const days = since ? Math.round((Date.parse(today) - Date.parse(since)) / 86400000) : null;
  return {
    rule: "weigh",
    text: since
      ? `⚖️ ${days} 天没称体重了 · No weigh-in for ${days} days\n上次 ${since} · ${kgText(s.latest!.kg)} kg`
      : "⚖️ 还没称过体重 · No weigh-in yet\n一次就够，趋势从这里开始 · One reading starts the trend",
    button: "现在称 ⚖️",
  };
}

/** Rule 2 — this week's workouts are behind the pace the plan asks for. */
function workoutRule(s: BodySummary, today: string): Nudge | null {
  const target = s.week.workouts_target;
  if (target <= 0) return null;
  const dow = weekdayOf(today);
  const elapsed = dow === 0 ? 7 : dow;      // Mon = 1 … Sun = 7
  const left = 8 - elapsed;                 // days left in the week, today included
  const expected = Math.floor((target * elapsed) / 7);
  if (s.week.workouts_done >= expected) return null;
  return {
    rule: "workout",
    text: `🏃 这周运动 ${s.week.workouts_done}/${target}，还剩 ${left} 天 · ${s.week.workouts_done} of ${target} this week, ${left} days left`,
    button: `今天安排 ${WORKOUT_TASK_MIN} 分钟`,
  };
}

/** Rule 3 — the 7-day trend has moved away from the target two weeks running. */
async function trendRule(db: D1Database, userId: number, s: BodySummary, today: string): Promise<Nudge | null> {
  const [t2, t1, t0] = await weightTrends(db, userId, [addDays(today, -14), addDays(today, -7), today]);
  if (t0 === null || t1 === null || t2 === null) return null;
  const gaining = s.plan.target_kg > s.plan.start_kg;
  const away = (later: number, earlier: number) => (gaining ? earlier - later : later - earlier);
  if (away(t0, t1) <= WRONG_WAY_KG || away(t1, t2) <= WRONG_WAY_KG) return null;
  return {
    rule: "trend",
    text: `📈 两周均值在往反方向走 · The trend has moved away from the target two weeks running\n`
      + `${kgText(t2)} → ${kgText(t1)} → ${kgText(t0)} kg（7日均 · 7-day）`,
    button: "问道引 🤖",
  };
}

/** Rule 4 — the kcal budget, over on each of the last three complete days. */
async function kcalRule(db: D1Database, userId: number, s: BodySummary, today: string): Promise<Nudge | null> {
  const budget = s.plan.daily_kcal;
  if (!budget) return null;
  const from = addDays(today, -OVER_BUDGET_DAYS);
  let days: { date: string; kcal: number }[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT date, SUM(kcal) AS kcal FROM meal_logs
        WHERE user_id = ? AND date BETWEEN ? AND ? AND kcal IS NOT NULL GROUP BY date`
    ).bind(userId, from, addDays(today, -1)).all<{ date: string; kcal: number }>();
    days = results;
  } catch {
    return null; // migration 0004 has not run here
  }
  const over = days.filter((d) => d.kcal > budget);
  if (over.length < OVER_BUDGET_DAYS) return null;
  const avg = Math.round(over.reduce((t, d) => t + d.kcal, 0) / over.length);
  return {
    rule: "kcal",
    text: `🍽 连续 ${OVER_BUDGET_DAYS} 天超预算 · Over budget ${OVER_BUDGET_DAYS} days running\n`
      + `平均 ~${avg} kcal · 预算 ${budget} kcal`,
    button: "看看饮食",
  };
}

/**
 * The one nudge to send today, or null. The first rule that is true AND has not fired this week wins;
 * the others wait for another day. Deterministic: the same tick always picks the same rule.
 */
export async function pickBodyNudge(db: D1Database, userId: number, today: string): Promise<Nudge | null> {
  const s = await bodySummary(db, userId, today);
  if (!s) return null;
  const sent = await rulesSentThisWeek(db, userId, weekStartOf(today));
  for (const rule of BODY_NUDGE_RULES) {
    if (sent.has(rule)) continue;
    const nudge = rule === "weigh" ? weighRule(s, today)
      : rule === "workout" ? workoutRule(s, today)
      : rule === "trend" ? await trendRule(db, userId, s, today)
      : await kcalRule(db, userId, s, today);
    if (nudge) return nudge;
  }
  return null;
}

/** The scheduler's condition: nothing to say = no claim, so a later tick in the window looks again. */
export async function bodyNudgeDue(ctx: BodyNudgeContext): Promise<boolean> {
  return (await pickBodyNudge(ctx.db, ctx.userId, ctx.today)) !== null;
}

/** The body_nudge kind: at most one message, with the rule's single action. */
export async function sendBodyNudge(ctx: BodyNudgeContext): Promise<void> {
  const nudge = await pickBodyNudge(ctx.db, ctx.userId, ctx.today);
  if (!nudge) return;
  // The week's claim for this rule; a tick that lost the race says nothing rather than repeating it.
  if (!(await claimRule(ctx.db, ctx.userId, nudge.rule, weekStartOf(ctx.today)))) return;
  await ctx.send({
    text: nudge.text,
    reply_markup: { inline_keyboard: [[{ text: nudge.button, callback_data: cb.bodyNudge(nudge.rule) }]] },
  });
}

// ---------- bn:<rule> — the nudge's button ----------

export async function bodyNudgeAction(ctx: CallbackContext, rule: BodyNudgeRule): Promise<string> {
  // Nudge acceptance (PRD-body §14): taps on a nudge's button over nudges sent.
  await logReply(ctx.db, ctx.userId, "body_nudge", ctx.today);
  const s = await bodySummary(ctx.db, ctx.userId, ctx.today);
  if (!s) return "没有身体计划 · No body plan";
  if (rule === "weigh") {
    await askWeight(ctx);
    return "回复体重就行 · Reply with your weight";
  }
  if (rule === "workout") {
    const title = `运动 ${WORKOUT_TASK_MIN} 分钟 · Move ${WORKOUT_TASK_MIN} minutes`;
    const r = await applyProposal(ctx.db, ctx.userId, {
      kind: "create_task", title, date: ctx.today, estimate_min: WORKOUT_TASK_MIN, goal_title: s.plan.goal_title,
    });
    if (!r.ok) return `没能安排 · Could not add: ${r.error}`;
    await ctx.finish(`🏃 已排到今天 · Added to today\n${title}`);
    return "已安排 · Added";
  }
  if (rule === "trend") {
    await ctx.typing();
    const prompt = `My weight trend has moved away from the target two weeks running. Body: ${bodyContextLine(s)}. `
      + "In two sentences say what most likely explains it and one concrete change for this week. "
      + "Quote only the numbers above; include at most one proposal.";
    let reply: Awaited<ReturnType<typeof guideChat>>;
    try {
      reply = await guideChat(ctx.db, ctx.guide, ctx.userId, prompt);
    } catch {
      return "道引暂时不可用 · Guide is unavailable right now";
    }
    const messageId = await ctx.sendId(guideReplyCard(reply));
    await ctx.db.prepare("UPDATE guide_messages SET tg_message_id = ? WHERE id = ? AND user_id = ?")
      .bind(messageId, reply.id, ctx.userId).run();
    await logEvent(ctx.db, ctx.userId, "guide", "used");
    return "已问道引 · Asked";
  }
  await ctx.send({
    text: `🍽 本周饮食 · Meals this week\n记录 ${s.week.meals_logged} 餐`
      + `${s.week.kcal_avg !== null ? ` · 平均 ~${s.week.kcal_avg} kcal` : ""}`
      + `${s.plan.daily_kcal ? ` · 预算 ${s.plan.daily_kcal} kcal` : ""}`,
    reply_markup: { inline_keyboard: [[{ text: "📈 身体 · Body", url: `${ctx.origin}/body` }]] },
  });
  return "打开身体页 · Body page";
}

// ---------- the weight ask (PRD-body §5.1), as far as the nudge needs it ----------

/** How long a reply still counts as the weight. */
export const WEIGHT_ANSWER_SECONDS = 3 * 60 * 60;

interface WeightState {
  kind: "awaiting_weight";
  date: string;
  expires_at: number;
}

function isWeightState(v: unknown): v is WeightState {
  const s = v as Partial<WeightState> | null;
  return !!s && typeof s === "object" && s.kind === "awaiting_weight"
    && typeof s.date === "string" && typeof s.expires_at === "number";
}

/** The strict weight pattern of §5.1: anything else is not a weight and goes to capture as usual. */
const WEIGHT_RE = /^\s*(?:体重|weight)?\s*(\d{2,3}(?:[.,]\d)?)\s*(kg|公斤|斤|lb|lbs|磅)?\s*$/i;
const UNIT_KG: Record<string, number> = { "斤": 0.5, lb: 0.4536, lbs: 0.4536, "磅": 0.4536 };
/** The weight a body can plausibly have, in kg (§5.1). */
const KG_RANGE: [number, number] = [30, 300];

/** `72.4`, `72,4 kg`, `145 lb` → kilograms; null when the text is not a weight. */
export function parseWeightKg(text: string): number | null {
  const m = WEIGHT_RE.exec(text);
  if (!m) return null;
  const kg = Number(m[1].replace(",", ".")) * (UNIT_KG[(m[2] ?? "").toLowerCase()] ?? 1);
  if (!Number.isFinite(kg) || kg < KG_RANGE[0] || kg > KG_RANGE[1]) return null;
  return Math.round(kg * 10) / 10;
}

/** 现在称 ⚖️ — a ForceReply for today's weight; telegram_state waits 3 h for it. */
export async function askWeight(ctx: Pick<CallbackContext, "state" | "send" | "today">): Promise<void> {
  const state: WeightState = { kind: "awaiting_weight", date: ctx.today, expires_at: Date.now() + WEIGHT_ANSWER_SECONDS * 1000 };
  await ctx.state.put(state, WEIGHT_ANSWER_SECONDS);
  await ctx.send({
    text: "⚖️ 今天体重？ · Weight today?\n直接回复数字就行 · Just reply with the number",
    reply_markup: { force_reply: true, input_field_placeholder: "72.4" },
  });
}

/** One line after a weigh-in: the reading, the trend and what is left (§5.1). */
function weighEcho(s: BodySummary, kg: number): string {
  const trend = s.trend === null ? "—" : kgText(s.trend);
  const move = s.trend !== null && s.trend_prev !== null ? ` ${deltaText(s.trend - s.trend_prev)}/周·wk` : "";
  const gap = s.remaining_kg === null ? "" : s.remaining_kg > 0 ? ` · 距目标 ${kgText(s.remaining_kg)} kg` : " · 已达目标 ✓";
  return `⚖️ ${kgText(kg)} kg · 7日均 ${trend}${move}${gap}`;
}

/**
 * Router step 3: a typed answer while the weight ask is open. Anything that is not a weight falls through
 * to capture with the slot left open, so the next number still counts (§5.1).
 */
export async function weightAnswer(ctx: Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">, text: string): Promise<boolean> {
  const state = await ctx.state.get();
  if (!isWeightState(state)) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    return false;
  }
  const kg = parseWeightKg(text);
  if (kg === null) return false;
  // The same write as the Guide's log_weight proposal, so one path keeps goals.progress derived.
  const r = await applyProposal(ctx.db, ctx.userId, { kind: "log_weight", date: ctx.today, kg });
  if (!r.ok) {
    await ctx.send({ text: `没能记下 · Could not log: ${r.error}` });
    return true;
  }
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, "body_nudge", ctx.today);
  const s = await bodySummary(ctx.db, ctx.userId, ctx.today);
  await ctx.send({ text: s ? weighEcho(s, kg) : `⚖️ ${kgText(kg)} kg 已记下 · Logged` });
  return true;
}

// ---------- body_recap (§8.2) ----------

export type BodyRecapContext = Pick<CallbackContext, "db" | "userId" | "today" | "send"> & {
  /** Model settings; without them the recap is the block alone. */
  guide?: GuideEnv;
  /** Needed to remember the Guide message's id so a reply continues the thread. */
  sendId?(reply: Reply): Promise<number>;
};

/** "比目标早 2 周" / "比目标晚 1 周", or "" when there is no target date or no projection. */
function slipText(s: BodySummary): string {
  if (!s.projected_date || !s.plan.target_date) return "";
  const days = Math.round((Date.parse(s.projected_date) - Date.parse(s.plan.target_date)) / 86400000);
  const weeks = Math.round(Math.abs(days) / 7);
  if (Math.abs(days) < 7) return " · 正好赶上 · on the date ✓";
  return days < 0 ? ` · 比目标早 ${weeks} 周 · ${weeks} weeks early ✓` : ` · 比目标晚 ${weeks} 周 · ${weeks} weeks late`;
}

/** The §8.2 block. Every number is bodySummary's, so it matches GET /api/body for the same week. */
export function bodyRecapBlock(s: BodySummary, trendMonthAgo: number | null): string {
  const week = s.trend !== null && s.trend_prev !== null ? ` · 本周 ${deltaText(s.trend - s.trend_prev)}` : "";
  const month = s.trend !== null && trendMonthAgo !== null ? ` · 4 周 ${deltaText(s.trend - trendMonthAgo)}` : "";
  const weights = s.trend === null
    ? "称重还不够，算不出均值 · not enough weigh-ins for a trend"
    : `${s.trend_prev === null ? "" : `${kgText(s.trend_prev)} → `}${kgText(s.trend)} kg（7日均 · 7-day）${week}${month}`;
  const meals = `记录饮食 ${s.week.meals_logged} 餐${s.week.kcal_avg !== null ? ` · 平均 ~${s.week.kcal_avg} kcal` : ""}`;
  const projection = s.projected_date
    ? `预计 ${s.projected_date} 达到 ${kgText(s.plan.target_kg)} kg${slipText(s)}`
    : "还算不出预计日期 · no projected date yet";
  return [
    `⚖️ 本周身体 · Body this week — ${s.plan.goal_title}`,
    `  ${weights}`,
    `  运动 ${s.week.workouts_done}/${s.week.workouts_target} · ${s.week.minutes} 分钟 · ${meals}`,
    `  ${projection}`,
  ].join("\n");
}

/**
 * Sunday's recap, sent inside the weekly review before its questions. The block is deterministic; the
 * Guide turn after it is asked for at most one proposal and is skipped entirely when no model answers.
 */
export async function sendBodyRecap(ctx: BodyRecapContext): Promise<void> {
  const s = await bodySummary(ctx.db, ctx.userId, ctx.today);
  if (!s) return;
  const [monthAgo] = await weightTrends(ctx.db, ctx.userId, [addDays(ctx.today, -28)]);
  await ctx.send({ text: bodyRecapBlock(s, monthAgo) });
  await logEvent(ctx.db, ctx.userId, "body_recap", "sent", { local_date: ctx.today });
  if (!ctx.guide || !ctx.sendId) return;
  const prompt = `This is my body week: ${bodyContextLine(s)}. `
    + "In at most three sentences say what worked and one concrete change for next week. "
    + "Quote only the numbers above — never fit or invent a projection — and include at most one proposal "
    + "(create_task, set_weekly_plan, or set_body_plan to adjust the target date or the kcal budget).";
  let reply: Awaited<ReturnType<typeof guideChat>>;
  try {
    reply = await guideChat(ctx.db, ctx.guide, ctx.userId, prompt);
  } catch (e) {
    console.warn("telegram body recap: model unavailable", e instanceof Error ? e.message : e);
    return; // no model configured: the block alone (PRD-body §8.2)
  }
  const messageId = await ctx.sendId(guideReplyCard(reply));
  await ctx.db.prepare("UPDATE guide_messages SET tg_message_id = ? WHERE id = ? AND user_id = ?")
    .bind(messageId, reply.id, ctx.userId).run();
  await logEvent(ctx.db, ctx.userId, "guide", "used");
}
