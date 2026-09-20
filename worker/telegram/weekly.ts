// The week from the chat (PRD §6 rows 3–4, #25).
//   weekly_plan   (Mon)  → last week's numbers, then the ask: a theme and three outcomes → weekly_plans
//   weekly_review (Sun)  → the week's recap (+ streak when opted in), then the weekly questions → reviews(period 'weekly')
//   /week                → this week's plan, or the ask when there is none
// The plan answer: first line = theme, following lines = outcomes (up to three); a single line is three
// outcomes separated like the daily top three. Writes go through applyProposal's set_weekly_plan, the same
// path as the Guide card. The ask waits 6 h in telegram_state; later text falls through to inbox capture.

import { applyProposal } from "../proposals.ts";
import { sendBodyRecap, type BodyRecapContext } from "./bodynudge.ts";
import { dailyReviewStreak } from "../reviews.ts";
import { weekStartOf } from "../dates.ts";
import { guideChat } from "../guide.ts";
import { cb, shiftDate, type CallbackContext } from "./callback.ts";
import { logReply } from "./events.ts";
import { guideReplyCard } from "./guide.ts";
import { startReview, weeklyScoreboard } from "./review.ts";
import type { Reply } from "./router.ts";
import { parseTopThree } from "./topthree.ts";

export const WEEKLY_ANSWER_SECONDS = 6 * 60 * 60;

interface WeeklyState {
  kind: "weekly_plan";
  week_start: string;
  expires_at: number;
}

function isWeeklyState(v: unknown): v is WeeklyState {
  return !!v && typeof v === "object" && (v as WeeklyState).kind === "weekly_plan"
    && typeof (v as WeeklyState).week_start === "string" && typeof (v as WeeklyState).expires_at === "number";
}

export type WeeklyContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

interface PlanRow { theme: string; outcome1: string; outcome2: string; outcome3: string }

async function loadPlan(ctx: Pick<WeeklyContext, "db" | "userId">, weekStart: string): Promise<PlanRow | null> {
  return ctx.db.prepare("SELECT theme, outcome1, outcome2, outcome3 FROM weekly_plans WHERE user_id = ? AND week_start = ?")
    .bind(ctx.userId, weekStart).first<PlanRow>();
}

function planText(weekStart: string, plan: PlanRow): string {
  const outcomes = [plan.outcome1, plan.outcome2, plan.outcome3].map((o) => o?.trim()).filter(Boolean);
  return [
    `📅 本周 · Week of ${weekStart}${plan.theme?.trim() ? ` — “${plan.theme.trim()}”` : ""}`,
    ...(outcomes.length ? outcomes.map((o, i) => `${i + 1}. ${o}`) : ["（还没有成果 · no outcomes yet）"]),
  ].join("\n");
}

export function askWeeklyText(weekStart: string): string {
  return `📅 这一周（${weekStart} 起）的主题和三个成果？\nTheme and three outcomes for the week of ${weekStart}?\n\n第一行主题，接着一行一个成果 · First line the theme, then one outcome per line`;
}

function askCard(weekStart: string): Reply {
  return {
    text: askWeeklyText(weekStart),
    reply_markup: {
      inline_keyboard: [[
        { text: "✍️ 写", callback_data: cb.weekly("write", weekStart) },
        { text: "🤖 让道引拟", callback_data: cb.weekly("guide", weekStart) },
      ]],
    },
  };
}

export async function awaitWeekly(ctx: Pick<WeeklyContext, "state">, weekStart: string): Promise<void> {
  const state: WeeklyState = { kind: "weekly_plan", week_start: weekStart, expires_at: Date.now() + WEEKLY_ANSWER_SECONDS * 1000 };
  await ctx.state.put(state, WEEKLY_ANSWER_SECONDS);
}

/** The plan was written another way (Guide card, web): stop waiting for a typed one. */
export async function clearWeeklyWait(ctx: Pick<WeeklyContext, "state">, weekStart: string): Promise<void> {
  const s = await ctx.state.get();
  if (isWeeklyState(s) && s.week_start === weekStartOf(weekStart)) await ctx.state.clear();
}

/** First line = theme, rest = outcomes; one line = outcomes only. */
export function parseWeeklyPlan(text: string): { theme: string; outcomes: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const theme = lines[0].replace(/^(主题|theme)\s*[:：]\s*/i, "");
    return { theme, outcomes: parseTopThree(lines.slice(1).join("\n")).items };
  }
  return { theme: "", outcomes: parseTopThree(text).items };
}

// ---------- entry points ----------

/** Monday's message (and /week when the plan is empty): last week's numbers, then the ask. */
export async function sendWeeklyPlan(ctx: WeeklyContext): Promise<void> {
  const weekStart = weekStartOf(ctx.today);
  const lastWeek = await weeklyScoreboard(ctx, shiftDate(weekStart, -7));
  const plan = await loadPlan(ctx, weekStart);
  const hasPlan = plan && [plan.theme, plan.outcome1, plan.outcome2, plan.outcome3].some((v) => v?.trim());
  if (hasPlan) {
    await ctx.send({ text: `上周 · Last week\n${lastWeek}\n\n${planText(weekStart, plan)}` });
    return;
  }
  await awaitWeekly(ctx, weekStart);
  await ctx.send({ text: `上周 · Last week\n${lastWeek}`, });
  await ctx.send(askCard(weekStart));
}

/** /week */
export async function weekCommand(ctx: WeeklyContext): Promise<void> {
  const weekStart = weekStartOf(ctx.today);
  const plan = await loadPlan(ctx, weekStart);
  const hasPlan = plan && [plan.theme, plan.outcome1, plan.outcome2, plan.outcome3].some((v) => v?.trim());
  if (hasPlan) {
    await ctx.send({
      text: planText(weekStart, plan),
      reply_markup: { inline_keyboard: [[{ text: "✏️ 重写", callback_data: cb.weekly("write", weekStart) }]] },
    });
    return;
  }
  await awaitWeekly(ctx, weekStart);
  await ctx.send(askCard(weekStart));
}

/** Router step 3: typed text while the weekly ask is open. */
export async function weeklyPlanAnswer(ctx: WeeklyContext, text: string): Promise<boolean> {
  const s = await ctx.state.get();
  if (!isWeeklyState(s)) return false;
  if (Date.now() > s.expires_at) {
    await ctx.state.clear();
    await ctx.send({ text: "⌛ 周计划的提问已过期，这条收进 Inbox · The weekly ask expired — capturing instead.\n/week 重新开始 · /week to ask again" });
    return false;
  }
  const { theme, outcomes } = parseWeeklyPlan(text);
  if (!outcomes.length && !theme) {
    await ctx.send({ text: "没读出内容 · Couldn't read that — 第一行主题，然后一行一个成果" });
    return true;
  }
  const r = await applyProposal(ctx.db, ctx.userId, { kind: "set_weekly_plan", week_start: s.week_start, theme, outcomes });
  if (!r.ok) {
    await ctx.send({ text: `没能保存 · Could not save: ${r.error}` });
    return true;
  }
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, "weekly_plan", ctx.today);
  const plan = await loadPlan(ctx, s.week_start);
  await ctx.send({
    text: `已定 · Set\n${plan ? planText(s.week_start, plan) : ""}`,
    reply_markup: { inline_keyboard: [[{ text: "✏️ 重写", callback_data: cb.weekly("write", s.week_start) }]] },
  });
  return true;
}

/**
 * Sunday's message: the recap (with the streak when opted in), the body recap when a plan exists
 * (PRD-body §8.2), then the weekly review. A body recap that fails is logged and skipped — the
 * week's questions matter more than its numbers.
 */
export async function sendWeeklyReview(ctx: WeeklyContext & { streaks?: boolean } & Partial<BodyRecapContext>): Promise<void> {
  const weekStart = weekStartOf(ctx.today);
  const streak = ctx.streaks ? await dailyReviewStreak(ctx.db, ctx.userId, ctx.today) : 0;
  const plan = await loadPlan(ctx, weekStart);
  const head = [
    "🗓 本周回顾 · The week in review",
    await weeklyScoreboard(ctx, weekStart),
    ...(plan && [plan.outcome1, plan.outcome2, plan.outcome3].some(Boolean) ? ["", planText(weekStart, plan)] : []),
    ...(streak > 1 ? ["", `🔥 连续 ${streak} 天复盘 · ${streak}-day review streak`] : []),
  ];
  await ctx.send({ text: head.join("\n") });
  try {
    await sendBodyRecap(ctx);
  } catch (e) {
    console.error("telegram weekly review: body recap failed", e);
  }
  await startReview(ctx, "weekly");
}

// ---------- button handlers ----------

/** wk:w:<monday> — reopen the ask with a ForceReply so the keyboard opens. */
export async function weeklyWritePrompt(ctx: CallbackContext, weekStart: string): Promise<string> {
  await awaitWeekly(ctx, weekStart);
  await ctx.send({
    text: `✍️ ${weekStart} 这一周：第一行主题，然后一行一个成果 · Theme, then one outcome per line`,
    reply_markup: { force_reply: true, input_field_placeholder: "主题 / 成果 1 / 成果 2 / 成果 3" },
  });
  return "请直接回复 · Reply below";
}

/** wk:g:<monday> — one Guide turn asking for a set_weekly_plan proposal. */
export async function weeklyGuideDraft(ctx: CallbackContext, weekStart: string): Promise<string> {
  await ctx.typing();
  const prompt = `Draft a theme and three outcomes for my week starting ${weekStart}, drawn from my goals and last week. `
    + `Keep the reply to two sentences and include exactly one set_weekly_plan proposal with week_start ${weekStart}.`;
  let reply: Awaited<ReturnType<typeof guideChat>>;
  try {
    reply = await guideChat(ctx.db, ctx.guide, ctx.userId, prompt);
  } catch {
    return "道引暂时不可用 · Guide is unavailable right now";
  }
  const messageId = await ctx.sendId(guideReplyCard(reply));
  await ctx.db.prepare("UPDATE guide_messages SET tg_message_id = ? WHERE id = ? AND user_id = ?").bind(messageId, reply.id, ctx.userId).run();
  return reply.proposals.length ? "道引已拟 · Drafted" : "没有草案 · No draft";
}
