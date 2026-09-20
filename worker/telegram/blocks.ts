// Time-block reminders (PRD §6 row 6, #26): five minutes before a scheduled task starts, when the user
// opted in (telegram_prefs.block_reminders). The scheduler calls runBlockReminders once per tick per user;
// each reminder is claimed in telegram_outbox_log as kind `block:<taskId>:<startMin>` for that local date,
// so a snoozed task (new start_min) earns a fresh reminder and a replayed tick sends nothing twice.
//   bk:<id>:d  ✓ 完成    → done; when the task had an estimate, ask the actual minutes (am:<id>:<min>)
//   bk:<id>:z  ⏰ +15分   → start_min/end_min + 15
//   bk:<id>:t  📅 明天    → tomorrow, unscheduled

import { updateTask } from "../tasks.ts";
import { cb, shiftDate, type CallbackContext } from "./callback.ts";
import { offerWorkoutFromTask } from "./workout.ts";
import { logEvent } from "./events.ts";
import type { Reply } from "./router.ts";
import type { LocalNow } from "./time.ts";

/** Minutes before start_min the reminder goes out. */
export const BLOCK_LEAD_MIN = 5;
const ACTUAL_CHOICES = [15, 30, 45, 60, 90];

interface BlockRow {
  id: number;
  title: string;
  start_min: number;
  end_min: number | null;
  estimate_min: number | null;
  actual_min: number | null;
}

export function fmtMin(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function blockKind(taskId: number, startMin: number): string {
  return `block:${taskId}:${startMin}`;
}

function reminderCard(t: BlockRow): Reply {
  return {
    text: `⏰ 即将开始 · Starting soon\n${fmtMin(t.start_min)}${t.end_min !== null ? `–${fmtMin(t.end_min)}` : ""}  ${t.title}`,
    reply_markup: {
      inline_keyboard: [[
        { text: "✓ 完成", callback_data: cb.block(t.id, "done") },
        { text: "⏰ +15分", callback_data: cb.block(t.id, "snooze") },
        { text: "📅 明天", callback_data: cb.block(t.id, "tomorrow") },
      ]],
    },
  };
}

export interface BlockContext {
  db: D1Database;
  userId: number;
  today: string;
  send(reply: Reply): Promise<void>;
  /** telegram_outbox_log claim for (kind, today): true when this tick owns the send. */
  claim(kind: string): Promise<boolean>;
  release(kind: string): Promise<void>;
}

/** Tasks starting within (now, now + lead] get their reminder. One tick per task per start time. */
export async function runBlockReminders(ctx: BlockContext, now: LocalNow): Promise<void> {
  const { results } = await ctx.db.prepare(
    `SELECT id, title, start_min, end_min, estimate_min, actual_min FROM tasks
      WHERE user_id = ? AND date = ? AND inbox = 0 AND done = 0 AND dropped = 0
        AND start_min IS NOT NULL AND start_min > ? AND start_min <= ?
      ORDER BY start_min, id`
  ).bind(ctx.userId, ctx.today, now.minutes, now.minutes + BLOCK_LEAD_MIN).all<BlockRow>();
  for (const t of results) {
    const kind = blockKind(t.id, t.start_min);
    if (!(await ctx.claim(kind))) continue;
    try {
      await ctx.send(reminderCard(t));
      await logEvent(ctx.db, ctx.userId, "block", "sent", { local_date: ctx.today });
    } catch (e) {
      await ctx.release(kind);
      throw e;
    }
  }
}

// ---------- button handlers ----------

async function taskOf(ctx: CallbackContext, taskId: number): Promise<BlockRow | null> {
  return ctx.db.prepare("SELECT id, title, start_min, end_min, estimate_min, actual_min FROM tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, ctx.userId).first<BlockRow>();
}

export async function blockDone(ctx: CallbackContext, taskId: number): Promise<string> {
  const t = await taskOf(ctx, taskId);
  if (!t) return "找不到这件事 · Task not found";
  await updateTask(ctx.db, ctx.userId, taskId, { done: 1 });
  await logEvent(ctx.db, ctx.userId, "block", "replied", { local_date: ctx.today });
  if (t.estimate_min) {
    // Only tasks that were estimated get asked — the Insights "planned vs actual" panel needs both numbers.
    await ctx.edit({
      text: `✓ 已完成 · Done\n${t.title}\n\n实际用了多久？ · How long did it take? (估计 ${t.estimate_min} 分钟)`,
      reply_markup: { inline_keyboard: [ACTUAL_CHOICES.map((m) => ({ text: `${m}分`, callback_data: cb.actualMin(taskId, m) }))] },
    });
    await offerWorkoutFromTask(ctx, t);
    return "已完成 · Done";
  }
  await ctx.finish(`✓ 已完成 · Done\n${t.title}`);
  // A workout-looking block offers to become a workout log (PRD-body §5.4); quiet for everything else.
  await offerWorkoutFromTask(ctx, t);
  return "已完成 · Done";
}

/** am:<id>:<min> — record the actual minutes; absolute, so a replay is a no-op. */
export async function recordActualMin(ctx: CallbackContext, taskId: number, min: number): Promise<string> {
  const task = await updateTask<{ title: string; estimate_min: number | null }>(ctx.db, ctx.userId, taskId, { actual_min: min, done: 1 });
  if (!task) return "找不到这件事 · Task not found";
  const est = task.estimate_min ? ` · 估计 ${task.estimate_min}` : "";
  await ctx.finish(`✓ 已完成 · Done\n${task.title}\n实际 ${min} 分钟${est}`);
  return `记录 ${min} 分钟 · Recorded`;
}

export async function blockSnooze(ctx: CallbackContext, taskId: number): Promise<string> {
  const t = await taskOf(ctx, taskId);
  if (!t) return "找不到这件事 · Task not found";
  if (t.start_min === null) return "这件事没有时间块 · Not time-blocked";
  const start = Math.min(t.start_min + 15, 24 * 60 - 1);
  const end = t.end_min !== null ? Math.min(t.end_min + 15, 24 * 60) : null;
  await updateTask(ctx.db, ctx.userId, taskId, { start_min: start, end_min: end });
  await logEvent(ctx.db, ctx.userId, "block", "replied", { local_date: ctx.today });
  await ctx.finish(`⏰ 推迟到 ${fmtMin(start)} · Snoozed\n${t.title}`);
  return `推迟到 ${fmtMin(start)}`;
}

export async function blockTomorrow(ctx: CallbackContext, taskId: number): Promise<string> {
  const t = await taskOf(ctx, taskId);
  if (!t) return "找不到这件事 · Task not found";
  await updateTask(ctx.db, ctx.userId, taskId, { date: shiftDate(ctx.today, 1), start_min: null, end_min: null });
  await logEvent(ctx.db, ctx.userId, "block", "replied", { local_date: ctx.today });
  await ctx.finish(`📅 已改到明天 · Moved to tomorrow\n${t.title}`);
  return "已改到明天 · Tomorrow";
}
