// /goals and goal progress from the chat (PRD §7.2, #24), plus the goal picker a capture card's
// 🎯 链接目标 opens. Every write is `WHERE id = ? AND user_id = ?`; progress buttons carry absolute
// values (g:<id>:p:<n>), so a replayed tap sets the same number again.

import { updateTask } from "../tasks.ts";
import type { GoalLevel } from "../../shared/types.ts";
import { cb, type CallbackContext } from "./callback.ts";
import type { Reply } from "./router.ts";

interface GoalRow {
  id: number;
  title: string;
  level: GoalLevel;
  status: string;
  progress: number;
  target_date: string | null;
  area: string | null;
}

const GOAL_PROGRESS_TTL_SECONDS = 10 * 60;

interface GoalProgressState {
  kind: "goal_progress";
  goalId: number;
}

function isGoalProgressState(v: unknown): v is GoalProgressState {
  return !!v && typeof v === "object" && (v as GoalProgressState).kind === "goal_progress" && typeof (v as GoalProgressState).goalId === "number";
}

const LEVEL_ZH: Record<GoalLevel, string> = { lifetime: "一生", year: "年", quarter: "季", month: "月", week: "周" };

export function progressBar(pct: number): string {
  const filled = Math.round(Math.max(0, Math.min(100, pct)) / 20);
  return "▰".repeat(filled) + "▱".repeat(5 - filled);
}

function daysUntil(date: string, today: string): number {
  return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
}

export function goalLine(g: GoalRow, today: string): string {
  const due = g.target_date ? (() => {
    const d = daysUntil(g.target_date, today);
    return d < 0 ? ` · 逾期 ${-d} 天` : d <= 14 ? ` · ⚠ ${d} 天` : ` · ${g.target_date}`;
  })() : "";
  return `${progressBar(g.progress)} ${String(g.progress).padStart(3)}%  [${LEVEL_ZH[g.level] ?? g.level}] ${g.title}${g.area ? ` · ${g.area}` : ""}${due}`;
}

async function activeGoals(ctx: Pick<CallbackContext, "db" | "userId">): Promise<GoalRow[]> {
  const { results } = await ctx.db.prepare(
    `SELECT g.id, g.title, g.level, g.status, g.progress, g.target_date, a.name AS area
       FROM goals g LEFT JOIN areas a ON a.id = g.area_id
      WHERE g.user_id = ? AND g.status IN ('active','at_risk')
      ORDER BY CASE g.level WHEN 'lifetime' THEN 0 WHEN 'year' THEN 1 WHEN 'quarter' THEN 2 WHEN 'month' THEN 3 ELSE 4 END,
               g.target_date IS NULL, g.target_date, g.id`
  ).bind(ctx.userId).all<GoalRow>();
  return results;
}

async function goalById(ctx: Pick<CallbackContext, "db" | "userId">, id: number): Promise<GoalRow | null> {
  return ctx.db.prepare(
    `SELECT g.id, g.title, g.level, g.status, g.progress, g.target_date, a.name AS area
       FROM goals g LEFT JOIN areas a ON a.id = g.area_id WHERE g.id = ? AND g.user_id = ?`
  ).bind(id, ctx.userId).first<GoalRow>();
}

/** Case-insensitive title fragment → the best active goal (shortest matching title), for /task @goal. */
export async function findGoal(db: D1Database, userId: number, query: string): Promise<{ id: number; title: string } | null> {
  return db.prepare(
    `SELECT id, title FROM goals WHERE user_id = ? AND status IN ('active','at_risk') AND lower(title) LIKE ?
      ORDER BY length(title), id LIMIT 1`
  ).bind(userId, `%${query.toLowerCase().replace(/[%_]/g, "")}%`).first<{ id: number; title: string }>();
}

const NO_GOALS: Reply = { text: "还没有进行中的目标 · No active goals yet.\n在网页的目标页创建，或问道引 /guide · Create one on the web, or ask /guide." };

// ---------- cards ----------

function listCard(goals: GoalRow[], today: string, forTask?: { id: number; title: string }): Reply {
  const head = forTask
    ? `🎯 把「${forTask.title}」链接到哪个目标？ · Link to which goal?`
    : "🎯 目标 · Goals";
  const shown = goals.slice(0, 20);
  return {
    text: [head, "", ...shown.map((g) => goalLine(g, today)), ...(goals.length > 20 ? [`… 还有 ${goals.length - 20} 个 · and ${goals.length - 20} more`] : [])].join("\n"),
    reply_markup: {
      inline_keyboard: shown.map((g) => [{
        text: `${g.progress}% · ${g.title.slice(0, 40)}`,
        callback_data: forTask ? cb.taskPickGoal(forTask.id, g.id) : cb.goal(g.id, "view"),
      }]),
    },
  };
}

function viewCard(g: GoalRow, today: string): Reply {
  const step = (n: number) => Math.max(0, Math.min(100, g.progress + n));
  const rows = [
    [
      { text: `−10% → ${step(-10)}`, callback_data: cb.goalProgress(g.id, step(-10)) },
      { text: `+10% → ${step(10)}`, callback_data: cb.goalProgress(g.id, step(10)) },
      { text: "设为… Set", callback_data: cb.goal(g.id, "set") },
    ],
    [
      { text: "✓ 完成 Done", callback_data: cb.goal(g.id, "complete") },
      { text: "⏸ 暂停 Pause", callback_data: cb.goal(g.id, "pause") },
      { text: "← 返回", callback_data: cb.goalList() },
    ],
  ];
  return {
    text: [goalLine(g, today), "", g.status === "at_risk" ? "状态：有风险 · at risk" : "状态：进行中 · active"].join("\n"),
    reply_markup: { inline_keyboard: rows },
  };
}

// ---------- entry points ----------

/** /goals — send the list. */
export async function goalsCommand(ctx: Pick<CallbackContext, "db" | "userId" | "today" | "send">): Promise<void> {
  const goals = await activeGoals(ctx);
  await ctx.send(goals.length ? listCard(goals, ctx.today) : NO_GOALS);
}

/** g:l (← 返回, edits in place) and t:<task>:g (the picker, a new message). */
export async function goalList(ctx: CallbackContext, opts: { forTask?: number }): Promise<string> {
  const goals = await activeGoals(ctx);
  if (opts.forTask !== undefined) {
    const task = await ctx.db.prepare("SELECT id, title FROM tasks WHERE id = ? AND user_id = ?")
      .bind(opts.forTask, ctx.userId).first<{ id: number; title: string }>();
    if (!task) return "找不到这件事 · Task not found";
    if (!goals.length) {
      await ctx.send(NO_GOALS);
      return "没有目标 · No goals";
    }
    await ctx.send(listCard(goals, ctx.today, task));
    return "选一个目标 · Pick a goal";
  }
  await ctx.edit(goals.length ? listCard(goals, ctx.today) : NO_GOALS);
  return "";
}

export async function goalView(ctx: CallbackContext, goalId: number): Promise<string> {
  const g = await goalById(ctx, goalId);
  if (!g) return "找不到这个目标 · Goal not found";
  await ctx.edit(viewCard(g, ctx.today));
  return "";
}

/** g:<id>:p:<n> — absolute, so a replay is a no-op. Bumps updated_at, which the period stats count. */
export async function goalSetProgress(ctx: CallbackContext, goalId: number, progress: number): Promise<string> {
  const r = await ctx.db.prepare("UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(progress, goalId, ctx.userId).run();
  if (!r.meta.changes) return "找不到这个目标 · Goal not found";
  const g = await goalById(ctx, goalId);
  if (g) await ctx.edit(viewCard(g, ctx.today));
  return progress === 100 ? "100% — 可以点「完成」了 · Tap Done to complete it" : `进度 ${progress}%`;
}

export async function goalComplete(ctx: CallbackContext, goalId: number): Promise<string> {
  const g = await goalById(ctx, goalId);
  if (!g) return "找不到这个目标 · Goal not found";
  await ctx.db.prepare("UPDATE goals SET status = 'completed', progress = 100, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(goalId, ctx.userId).run();
  await ctx.finish(`🏁 已完成 · Completed\n${g.title}`);
  return "已完成 · Completed";
}

export async function goalPause(ctx: CallbackContext, goalId: number): Promise<string> {
  const g = await goalById(ctx, goalId);
  if (!g) return "找不到这个目标 · Goal not found";
  await ctx.db.prepare("UPDATE goals SET status = 'paused', updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(goalId, ctx.userId).run();
  await ctx.finish(`⏸ 已暂停 · Paused\n${g.title}\n在网页的目标页可恢复 · Resume it on the Goals page.`);
  return "已暂停 · Paused";
}

/** 设为… — the next number typed (0–100) becomes the progress. */
export async function goalSetAsk(ctx: CallbackContext, goalId: number): Promise<string> {
  const g = await goalById(ctx, goalId);
  if (!g) return "找不到这个目标 · Goal not found";
  await ctx.state.put({ kind: "goal_progress", goalId } satisfies GoalProgressState, GOAL_PROGRESS_TTL_SECONDS);
  await ctx.send({
    text: `「${g.title}」现在 ${g.progress}%，改成多少？ · New progress (0–100)?`,
    reply_markup: { force_reply: true, input_field_placeholder: "0–100" },
  });
  return "回复一个数字 · Reply with a number";
}

/** Router step 3: a number while 设为… waits. */
export async function goalProgressAnswer(ctx: Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">, text: string): Promise<boolean> {
  const s = await ctx.state.get();
  if (!isGoalProgressState(s)) return false;
  const m = /^\s*(\d{1,3})\s*%?\s*$/.exec(text);
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 0 && n <= 100)) {
    await ctx.send({ text: "请回复 0 到 100 的数字 · A number from 0 to 100, please" });
    return true;
  }
  await ctx.state.clear();
  const r = await ctx.db.prepare("UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(n, s.goalId, ctx.userId).run();
  const g = r.meta.changes ? await goalById(ctx, s.goalId) : null;
  await ctx.send(g ? { text: `已更新 · Updated\n${goalLine(g, ctx.today)}` } : { text: "找不到这个目标 · Goal not found" });
  return true;
}

/** gl:<task>:<goal> — link the task; the picker is frozen. */
export async function taskPickGoal(ctx: CallbackContext, taskId: number, goalId: number): Promise<string> {
  const g = await goalById(ctx, goalId);
  if (!g) return "找不到这个目标 · Goal not found";
  const task = await updateTask<{ title: string }>(ctx.db, ctx.userId, taskId, { goal_id: goalId });
  if (!task) return "找不到这件事 · Task not found";
  await ctx.finish(`🎯 已链接 · Linked\n${task.title}\n→ ${g.title}`);
  return "已链接 · Linked";
}
