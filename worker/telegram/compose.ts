// The morning message (PRD §6.1): one message per morning — where you are, then the ask, so it ends on an action.
//   direction · this week's theme + outcomes · active goals (⚠ within 14 days) · today's blocks · carry-over line
//   ──────
//   the ask (top three not set)  → [✍️ 写三件事] [📋 抄昨天] [🤖 让道引拟]
//   or the three (already set)   → [✓ n] per undone item, ending 三件事已定 ✓
//   + [⤴ 顺延] [放下] when there are past undone tasks (c:f|d:<date>; the brief is redrawn in place)
// It carries an inline keyboard, so no ForceReply: telegram_state catches the free-text reply (topthree.ts).
// Capped at Telegram's 4096 characters: goals are cut first, then tasks, and the ask never.
//
// Scheduler wiring (#14): the morning slot calls sendMorning.

import { materializeRepeats, type CarryAction } from "../tasks.ts";
import { updateDay } from "../days.ts";
import { cb, shiftDate, type CallbackContext } from "./callback.ts";
import type { InlineKeyboardButton, Reply } from "./router.ts";
import { askText, awaitTopThree, type TopThreeContext } from "./topthree.ts";

export const TELEGRAM_TEXT_MAX = 4096;
/** Goals due within this many days get ⚠ and the day count. */
const DUE_SOON_DAYS = 14;
const SEPARATOR = "──────────";
const WEEKDAYS = "日一二三四五六";

interface GoalRow { title: string; progress: number; target_date: string | null }
interface TaskRow { title: string; start_min: number | null; end_min: number | null; done: number }
type DayRow = Record<`top${1 | 2 | 3}`, string> & Record<`top${1 | 2 | 3}_done`, number>;

export interface MorningMessage {
  reply: Reply;
  /** True when the message ends with the ask (today's top three not set yet). */
  asks: boolean;
}

export interface ComposeOptions {
  /** Replaces the carry-over line after a carry button, e.g. "→ 已顺延 3 件". */
  carried?: { action: CarryAction; n: number };
}

// ---------- formatting ----------

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) / 86400_000);
}

function hhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

function goalLine(g: GoalRow, today: string): string {
  const head = `${g.title} — ${g.progress}%`;
  if (!g.target_date) return `· ${head}`;
  const d = daysBetween(today, g.target_date);
  if (d > DUE_SOON_DAYS) return `· ${head} · 截止 ${g.target_date}`;
  const left = d < 0 ? `逾期 ${-d} 天 · ${-d}d overdue` : d === 0 ? "今天到期 · due today" : `还剩 ${d} 天 · ${d}d left`;
  return `⚠ ${head} · ${left}`;
}

function taskLine(t: TaskRow): string {
  const mark = t.done ? "✓ " : "";
  if (t.start_min === null) return `· ${mark}${t.title}`;
  const time = t.end_min !== null && t.end_min > t.start_min ? `${hhmm(t.start_min)}–${hhmm(t.end_min)}` : hhmm(t.start_min);
  return `${time} ${mark}${t.title}`;
}

/** The first `shown` lines, plus a "… N more" line for the rest. */
function capped(lines: string[], shown: number, more: (n: number) => string): string[] {
  return shown >= lines.length ? lines : [...lines.slice(0, shown), more(lines.length - shown)];
}

function carryLine(carryCount: number, carried?: ComposeOptions["carried"]): string | null {
  if (carried && carried.n > 0) {
    return carried.action === "forward"
      ? `→ 已顺延 ${carried.n} 件到今天 · Carried ${carried.n} forward to today`
      : `已放下 ${carried.n} 件 · Let go of ${carried.n}`;
  }
  return carryCount > 0 ? `↪ 还有 ${carryCount} 件没做完的旧事 · ${carryCount} left over from before` : null;
}

/** Clip to `max` UTF-16 units without splitting a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let cut = s.slice(0, Math.max(0, max - 1));
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return cut + "…";
}

// ---------- compose ----------

/** The morning message for `date` (the user's local today). Read-only apart from materializing repeating tasks. */
export async function composeMorning(
  db: D1Database, userId: number, date: string, opts: ComposeOptions = {}
): Promise<MorningMessage> {
  await materializeRepeats(db, userId, date);
  const user = await db.prepare("SELECT name, direction FROM users WHERE id = ?")
    .bind(userId).first<{ name: string; direction: string }>();
  const weekStart = shiftDate(date, -((new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7));
  const plan = await db.prepare("SELECT theme, outcome1, outcome2, outcome3 FROM weekly_plans WHERE user_id = ? AND week_start = ?")
    .bind(userId, weekStart).first<Record<"theme" | "outcome1" | "outcome2" | "outcome3", string>>();
  const { results: goals } = await db.prepare(
    `SELECT title, progress, target_date FROM goals
     WHERE user_id = ? AND status IN ('active','at_risk')
     ORDER BY target_date IS NULL, target_date, id`
  ).bind(userId).all<GoalRow>();
  const { results: tasks } = await db.prepare(
    "SELECT title, start_min, end_min, done FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0 ORDER BY start_min IS NULL, start_min, id"
  ).bind(userId, date).all<TaskRow>();
  const carry = await db.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND inbox = 0 AND done = 0 AND dropped = 0 AND date < ? AND repeat = 'never'"
  ).bind(userId, date).first<{ n: number }>();
  const carryCount = carry?.n ?? 0;
  const day = await db.prepare("SELECT top1, top1_done, top2, top2_done, top3, top3_done FROM days WHERE user_id = ? AND date = ?")
    .bind(userId, date).first<DayRow>();

  // Fixed head: greeting, direction, this week.
  const head: string[] = [`☀️ 早安${user?.name ? `，${user.name}` : ""} · Good morning — ${date} 周${WEEKDAYS[new Date(date + "T00:00:00Z").getUTCDay()]}`];
  if (user?.direction?.trim()) head.push("", `🧭 方向 · Direction\n${user.direction.trim()}`);
  const outcomes = plan ? [plan.outcome1, plan.outcome2, plan.outcome3].map((o) => o?.trim()).filter(Boolean) : [];
  if (plan?.theme?.trim() || outcomes.length) {
    head.push("", `📅 本周 · This week${plan?.theme?.trim() ? ` — ${plan.theme.trim()}` : ""}`, ...outcomes.map((o, i) => `${i + 1}. ${o}`));
  }

  const goalLines = goals.map((g) => goalLine(g, date));
  const taskLines = tasks.map(taskLine);
  const carried = carryLine(carryCount, opts.carried);

  // The closing block: the ask, or the three with their ✓ buttons. Never truncated.
  const tops = ([1, 2, 3] as const).map((n) => ({ n, text: (day?.[`top${n}`] ?? "").trim(), done: !!day?.[`top${n}_done`] }))
    .filter((t) => t.text);
  const asks = tops.length === 0;
  const tail = asks
    ? askText({ today: date }, date)
    : [`🎯 今天的三件事 · Today's top three`, ...tops.map((t) => `${t.done ? "✓" : `${t.n}.`} ${t.text}`), "", "三件事已定 ✓"].join("\n");

  const render = (goalsShown: number, tasksShown: number): string => {
    const brief = [...head];
    if (goalLines.length) {
      brief.push("", "🎯 目标 · Goals", ...capped(goalLines, goalsShown, (n) => `… 还有 ${n} 个 · and ${n} more — /goals`));
    }
    if (taskLines.length) {
      brief.push("", "🗓 今天 · Today", ...capped(taskLines, tasksShown, (n) => `… 还有 ${n} 件 · and ${n} more — /today`));
    }
    if (carried) brief.push("", carried);
    return brief.join("\n");
  };
  const fits = (brief: string) => brief.length + 2 + SEPARATOR.length + 1 + tail.length <= TELEGRAM_TEXT_MAX;

  // Goals are cut first, then tasks; if the head alone is still too long, it is clipped.
  let goalsShown = goalLines.length, tasksShown = taskLines.length;
  while (goalsShown > 0 && !fits(render(goalsShown, tasksShown))) goalsShown--;
  while (tasksShown > 0 && !fits(render(goalsShown, tasksShown))) tasksShown--;
  const brief = clip(render(goalsShown, tasksShown), TELEGRAM_TEXT_MAX - (2 + SEPARATOR.length + 1 + tail.length));
  const text = `${brief}\n\n${SEPARATOR}\n${tail}`;

  const keyboard: InlineKeyboardButton[][] = asks
    ? [[
        { text: "✍️ 写三件事", callback_data: cb.topThree("write", date) },
        { text: "📋 抄昨天", callback_data: cb.topThree("copy", date) },
        { text: "🤖 让道引拟", callback_data: cb.topThree("guide", date) },
      ]]
    : tops.some((t) => !t.done)
      ? [tops.filter((t) => !t.done).map((t) => ({ text: `✓ ${t.n}`, callback_data: cb.topDone(t.n, date) }))]
      : [];
  if (carryCount > 0) {
    keyboard.push([
      { text: `⤴ 顺延 ${carryCount}`, callback_data: cb.carry("forward", date) },
      { text: "放下 Let go", callback_data: cb.carry("drop", date) },
    ]);
  }
  return { reply: { text, ...(keyboard.length && { reply_markup: { inline_keyboard: keyboard } }) }, asks };
}

// ---------- entry point ----------

/** The scheduled morning message; when it asks, the next free text (4 h) becomes today's top three. */
export async function sendMorning(ctx: TopThreeContext): Promise<void> {
  const { reply, asks } = await composeMorning(ctx.db, ctx.userId, ctx.today);
  if (asks) await awaitTopThree(ctx, ctx.today);
  await ctx.send(reply);
}

// ---------- button handlers (dispatched by handleCallback) ----------

/** td:<n>:<date> — mark one of the three done and redraw the message in place. Absolute, so a replay is a no-op. */
export async function topThreeDone(ctx: CallbackContext, n: 1 | 2 | 3, date: string): Promise<string> {
  const day = await ctx.db.prepare(`SELECT top${n} AS text FROM days WHERE user_id = ? AND date = ?`)
    .bind(ctx.userId, date).first<{ text: string }>();
  if (!day?.text?.trim()) return "找不到这一件 · Not found";
  await updateDay(ctx.db, ctx.userId, date, { [`top${n}_done`]: 1 });
  await ctx.edit((await composeMorning(ctx.db, ctx.userId, date)).reply);
  return `✓ ${day.text.trim()}`;
}

/** c:f|d:<today> — the carry already ran; redraw the brief with the result in place of the carry row. */
export async function carryOnMorning(ctx: CallbackContext, action: CarryAction, n: number): Promise<string> {
  await ctx.edit((await composeMorning(ctx.db, ctx.userId, ctx.today, { carried: { action, n } })).reply);
  if (n === 0) return "已处理过 · Already handled";
  return action === "forward" ? "已顺延 · Carried forward" : "已放下 · Let go";
}
