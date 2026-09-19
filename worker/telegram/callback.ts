// Telegram callback_data protocol (PRD §7.3) and the shared button handlers.
// callback_data is client-supplied, replayable and capped at 64 bytes, so it only
// ever carries short opaque verbs and ids — never free text — and every handler
// re-checks ownership against the user resolved from the chat, not from the data.

import { carryOver, deleteTask, updateTask } from "../tasks.ts";
import { REVIEW_QUESTIONS } from "../../shared/reviews.ts";
import type { GuideEnv } from "../guide.ts";
import { rateDay, reviewFocus, reviewNext, reviewResume, reviewSkip } from "./review.ts";
import { carryOnMorning, topThreeDone } from "./compose.ts";
import { proposalAnswer, topThreeButton } from "./topthree.ts";
import type { Reply } from "./router.ts";
import type { TelegramStateStore } from "./state.ts";

export const CALLBACK_DATA_MAX_BYTES = 64;

export const RATING_FIELDS = ["mood", "energy", "focus", "satisfaction"] as const;
export type RatingField = (typeof RATING_FIELDS)[number];

export type TopThreeAction = "rewrite" | "copy" | "guide" | "write";
const TOP_THREE_CODES = { rewrite: "r", copy: "y", guide: "g", write: "w" } as const satisfies Record<TopThreeAction, string>;

// ---------- wire formats ----------

type Num = number | string;
type TaskDone<Id extends Num> = `t:${Id}:d`;
type TaskSchedule<Id extends Num, Days extends Num> = `t:${Id}:s:${Days}`;
type TaskLinkGoal<Id extends Num> = `t:${Id}:g`;
type TaskAskGuide<Id extends Num> = `t:${Id}:a`;
type TaskDelete<Id extends Num> = `t:${Id}:x`;
type ActualMin<Id extends Num, Min extends Num> = `am:${Id}:${Min}`;
type Rating<F extends RatingField, N extends Num> = `rt:${F}:${N}`;
type ReviewStep = "rv:next" | "rv:resume";
type ReviewSkip<Q extends Num> = `rv:skip:${Q}`;
type ReviewFocus<Date extends string> = `rv:focus:${Date}`;
type CarryCode = "f" | "d";
/** `c:f:<date>` comes from that date's morning message, which is redrawn in place instead of replaced. */
type Carry<Date extends string = never> = `c:${CarryCode}` | `c:${CarryCode}:${Date}`;
type TopThree<Date extends string> = `tt:${(typeof TOP_THREE_CODES)[TopThreeAction]}:${Date}`;
type TopDone<N extends Num, Date extends string> = `td:${N}:${Date}`;
type GoalProgress<Id extends Num, N extends Num> = `g:${Id}:p:${N}`;
type ProposalAnswer<MsgId extends Num, Idx extends Num> = `pr:${MsgId}:${Idx}:${"y" | "n"}`;

export type Callback =
  | { verb: "task_done"; taskId: number }
  | { verb: "task_schedule"; taskId: number; offsetDays: number }
  | { verb: "task_link_goal"; taskId: number }
  | { verb: "task_ask_guide"; taskId: number }
  | { verb: "task_delete"; taskId: number }
  | { verb: "actual_min"; taskId: number; min: number }
  | { verb: "rating"; field: RatingField; n: number }
  | { verb: "review"; step: "next" | "resume" }
  | { verb: "review_skip"; question: number }
  | { verb: "review_focus"; date: string }
  | { verb: "carry"; action: "forward" | "drop"; morning?: string }
  | { verb: "top_three"; action: TopThreeAction; date: string }
  | { verb: "top_done"; n: 1 | 2 | 3; date: string }
  | { verb: "goal_progress"; goalId: number; progress: number }
  | { verb: "proposal"; msgId: number; idx: number; approve: boolean };

// Numeric bounds; the build-time assertion below is checked against their widest values.
const MAX_OFFSET_DAYS = 365;
const MAX_ACTUAL_MIN = 1440;
const MAX_PROPOSAL_IDX = 99;

// Build-time assertion: the widest payload of every verb fits in 64 bytes (all ASCII,
// so characters = bytes). Changing a format to something longer fails `npm run typecheck`.
type MaxId = "9007199254740991"; // Number.MAX_SAFE_INTEGER — the largest id parseCallback accepts
type Widest =
  | TaskDone<MaxId> | TaskSchedule<MaxId, "365"> | TaskLinkGoal<MaxId> | TaskAskGuide<MaxId> | TaskDelete<MaxId> | ActualMin<MaxId, "1440"> | Rating<RatingField, "5">
  | ReviewStep | ReviewSkip<"9"> | ReviewFocus<"2026-12-31"> | Carry<"2026-12-31"> | TopThree<"2026-12-31"> | TopDone<"3", "2026-12-31"> | GoalProgress<MaxId, "100"> | ProposalAnswer<MaxId, "99">;
type Budget<N extends number, T extends 0[] = []> = T["length"] extends N ? T : Budget<N, [...T, 0]>;
type Fits<S extends string, B extends 0[]> = S extends `${infer _}${infer Rest}`
  ? B extends [0, ...infer Left extends 0[]] ? Fits<Rest, Left> : false
  : true;
type AssertTrue<T extends true> = T;
export type CallbackDataFits = AssertTrue<Fits<Widest, Budget<typeof CALLBACK_DATA_MAX_BYTES>>>;

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

function toId(s: string | undefined): number | null {
  if (!s || !/^[1-9]\d{0,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

function isDate(s: string | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toInt(s: string | undefined, min: number, max: number): number | null {
  if (!s || !/^(0|[1-9]\d{0,3})$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= max ? n : null;
}

/** Strict parse; anything malformed, out of range or over 64 bytes is null. */
export function parseCallback(data: string): Callback | null {
  if (byteLength(data) > CALLBACK_DATA_MAX_BYTES) return null;
  const p = data.split(":");
  switch (p[0]) {
    case "t": {
      const taskId = toId(p[1]);
      if (taskId === null) return null;
      if (p.length === 3 && p[2] === "d") return { verb: "task_done", taskId };
      if (p.length === 3 && p[2] === "g") return { verb: "task_link_goal", taskId };
      if (p.length === 3 && p[2] === "a") return { verb: "task_ask_guide", taskId };
      if (p.length === 3 && p[2] === "x") return { verb: "task_delete", taskId };
      const offsetDays = toInt(p[3], 0, MAX_OFFSET_DAYS);
      if (p.length === 4 && p[2] === "s" && offsetDays !== null) return { verb: "task_schedule", taskId, offsetDays };
      return null;
    }
    case "am": {
      const taskId = toId(p[1]), min = toInt(p[2], 0, MAX_ACTUAL_MIN);
      return p.length === 3 && taskId !== null && min !== null ? { verb: "actual_min", taskId, min } : null;
    }
    case "rt": {
      const field = RATING_FIELDS.find((f) => f === p[1]), n = toInt(p[2], 1, 5);
      return p.length === 3 && field && n !== null ? { verb: "rating", field, n } : null;
    }
    case "rv": {
      if (p.length === 2 && (p[1] === "next" || p[1] === "resume")) return { verb: "review", step: p[1] };
      const question = toInt(p[2], 1, REVIEW_QUESTIONS.daily.length);
      if (p.length === 3 && p[1] === "skip" && question !== null) return { verb: "review_skip", question };
      if (p.length === 3 && p[1] === "focus" && isDate(p[2])) return { verb: "review_focus", date: p[2] };
      return null;
    }
    case "c": {
      if (p[1] !== "f" && p[1] !== "d") return null;
      const action = p[1] === "f" ? "forward" : "drop";
      if (p.length === 2) return { verb: "carry", action };
      return p.length === 3 && isDate(p[2]) ? { verb: "carry", action, morning: p[2] } : null;
    }
    case "tt": {
      const action = (Object.keys(TOP_THREE_CODES) as TopThreeAction[]).find((a) => TOP_THREE_CODES[a] === p[1]);
      return p.length === 3 && action && isDate(p[2]) ? { verb: "top_three", action, date: p[2] } : null;
    }
    case "td": {
      const n = toInt(p[1], 1, 3);
      return p.length === 3 && (n === 1 || n === 2 || n === 3) && isDate(p[2]) ? { verb: "top_done", n, date: p[2] } : null;
    }
    case "g": {
      const goalId = toId(p[1]), progress = toInt(p[3], 0, 100);
      return p.length === 4 && p[2] === "p" && goalId !== null && progress !== null
        ? { verb: "goal_progress", goalId, progress } : null;
    }
    case "pr": {
      const msgId = toId(p[1]), idx = toInt(p[2], 0, MAX_PROPOSAL_IDX);
      return p.length === 4 && (p[3] === "y" || p[3] === "n") && msgId !== null && idx !== null
        ? { verb: "proposal", msgId, idx, approve: p[3] === "y" } : null;
    }
  }
  return null;
}

// Every encoded payload must parse back, which also enforces the 64-byte cap at runtime.
function checked<S extends string>(s: S): S {
  if (!parseCallback(s)) throw new Error(`invalid callback_data: ${s}`);
  return s;
}

/** Builders for inline keyboard callback_data. */
export const cb = {
  taskDone: (taskId: number): TaskDone<number> => checked(`t:${taskId}:d` as const),
  taskSchedule: (taskId: number, offsetDays: number): TaskSchedule<number, number> =>
    checked(`t:${taskId}:s:${offsetDays}` as const),
  taskLinkGoal: (taskId: number): TaskLinkGoal<number> => checked(`t:${taskId}:g` as const),
  taskAskGuide: (taskId: number): TaskAskGuide<number> => checked(`t:${taskId}:a` as const),
  taskDelete: (taskId: number): TaskDelete<number> => checked(`t:${taskId}:x` as const),
  actualMin: (taskId: number, min: number): ActualMin<number, number> => checked(`am:${taskId}:${min}` as const),
  rating: (field: RatingField, n: number): Rating<RatingField, number> => checked(`rt:${field}:${n}` as const),
  review: (step: "next" | "resume"): ReviewStep => checked(`rv:${step}` as const),
  reviewSkip: (question: number): ReviewSkip<number> => checked(`rv:skip:${question}` as const),
  reviewFocus: (date: string): ReviewFocus<string> => checked(`rv:focus:${date}` as const),
  carry: (action: "forward" | "drop", morning?: string): Carry<string> => {
    const code = action === "forward" ? "f" : "d";
    return checked(morning ? `c:${code}:${morning}` as const : `c:${code}` as const);
  },
  topThree: (action: TopThreeAction, date: string): TopThree<string> => checked(`tt:${TOP_THREE_CODES[action]}:${date}` as const),
  topDone: (n: 1 | 2 | 3, date: string): TopDone<number, string> => checked(`td:${n}:${date}` as const),
  goalProgress: (goalId: number, progress: number): GoalProgress<number, number> =>
    checked(`g:${goalId}:p:${progress}` as const),
  proposal: (msgId: number, idx: number, approve: boolean): ProposalAnswer<number, number> =>
    checked(`pr:${msgId}:${idx}:${approve ? "y" : "n"}` as const),
};

// ---------- handlers ----------

export interface CallbackContext {
  db: D1Database;
  /** Owner of the chat the tap came from, resolved by the webhook — never taken from callback_data. */
  userId: number;
  /** The user's local YYYY-MM-DD. */
  today: string;
  /** answerCallbackQuery — stops the client's spinner. handleCallback calls it exactly once per tap. */
  answer(text?: string): Promise<void>;
  /** Edit the tapped message to its terminal state (buttons removed), so a second device cannot re-apply. */
  finish(text: string): Promise<void>;
  /** Edit the tapped message in place and keep it live (new text and keyboard), e.g. the ratings card. */
  edit(reply: Reply): Promise<void>;
  /** Send a new message to the chat. */
  send(reply: Reply): Promise<void>;
  /** This user's telegram_state slot. */
  state: TelegramStateStore;
  /** Model settings for Guide turns started from a button (🤖 让道引拟). */
  guide: GuideEnv;
}

/** Route one button tap. Always answers the callback query, even on bad data or errors. */
export async function handleCallback(ctx: CallbackContext, data: string): Promise<void> {
  let toast: string | undefined;
  try {
    const parsed = parseCallback(data);
    if (!parsed) toast = "无效按钮 · Invalid button";
    else if (parsed.verb === "task_done") toast = await taskDone(ctx, parsed.taskId);
    else if (parsed.verb === "task_schedule") toast = await taskSchedule(ctx, parsed.taskId, parsed.offsetDays);
    else if (parsed.verb === "task_delete") toast = await taskDelete(ctx, parsed.taskId);
    else if (parsed.verb === "carry") toast = await carry(ctx, parsed.action, parsed.morning);
    else if (parsed.verb === "rating") toast = await rateDay(ctx, parsed.field, parsed.n);
    else if (parsed.verb === "review") toast = parsed.step === "next" ? await reviewNext(ctx) : await reviewResume(ctx);
    else if (parsed.verb === "review_skip") toast = await reviewSkip(ctx, parsed.question);
    else if (parsed.verb === "review_focus") toast = await reviewFocus(ctx, parsed.date);
    else if (parsed.verb === "top_three") toast = await topThreeButton(ctx, parsed.action, parsed.date);
    else if (parsed.verb === "top_done") toast = await topThreeDone(ctx, parsed.n, parsed.date);
    else if (parsed.verb === "proposal") toast = await proposalAnswer(ctx, parsed.msgId, parsed.idx, parsed.approve);
    else toast = "尚未支持 · Not available yet"; // the remaining verbs land with their features
  } finally {
    await ctx.answer(toast);
  }
}

// Marks done rather than toggling, so a replayed or double tap applies once.
async function taskDone(ctx: CallbackContext, taskId: number): Promise<string> {
  const row = await ctx.db.prepare(
    "UPDATE tasks SET done = 1, done_at = datetime('now') WHERE id = ? AND user_id = ? AND done = 0 RETURNING title"
  ).bind(taskId, ctx.userId).first<{ title: string }>();
  if (row) {
    await ctx.finish(`✓ 已完成 · Done\n${row.title}`);
    return "已完成 · Done";
  }
  const task = await ctx.db.prepare("SELECT title FROM tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, ctx.userId).first<{ title: string }>();
  if (!task) return "找不到这件事 · Task not found"; // unknown or another user's id: nothing changes
  await ctx.finish(`✓ 已完成 · Done\n${task.title}`);
  return "已经完成了 · Already done";
}

export function shiftDate(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Scheduling sets an absolute date (the user's local today + offset), so a replayed tap is a no-op.
async function taskSchedule(ctx: CallbackContext, taskId: number, offsetDays: number): Promise<string> {
  const date = shiftDate(ctx.today, offsetDays);
  const task = await updateTask<{ title: string }>(ctx.db, ctx.userId, taskId, { date, inbox: 0 });
  if (!task) return "找不到这件事 · Task not found";
  const when = offsetDays === 0 ? "今天 · Today" : offsetDays === 1 ? "明天 · Tomorrow" : date;
  await ctx.finish(`📅 已排到${when}\n${task.title}`);
  return `已排到${when}`;
}

async function taskDelete(ctx: CallbackContext, taskId: number): Promise<string> {
  const task = await ctx.db.prepare("SELECT title FROM tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, ctx.userId).first<{ title: string }>();
  // Unknown, another user's, or already deleted by an earlier tap: nothing changes.
  if (!task || (await deleteTask(ctx.db, ctx.userId, taskId)) === 0) return "找不到这件事 · Task not found";
  await ctx.finish(`🗑 已删除 · Deleted\n${task.title}`);
  return "已删除 · Deleted";
}

// Carrying is naturally idempotent: a second tap finds nothing left before today.
// From today's morning message the brief is redrawn in place (without the carry row) rather than replaced.
async function carry(ctx: CallbackContext, action: "forward" | "drop", morning?: string): Promise<string> {
  const n = await carryOver(ctx.db, ctx.userId, ctx.today, action);
  if (morning === ctx.today) return carryOnMorning(ctx, action, n);
  if (n === 0) {
    await ctx.finish("没有待处理的旧事 · Nothing left to carry");
    return "已处理过 · Already handled";
  }
  if (action === "forward") {
    await ctx.finish(`→ 已顺延 ${n} 件到今天 · Carried ${n} forward to today`);
    return "已顺延 · Carried forward";
  }
  await ctx.finish(`已放下 ${n} 件 · Let go of ${n}`);
  return "已放下 · Let go";
}
