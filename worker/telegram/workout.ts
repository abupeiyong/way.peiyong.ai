// Workouts through the bot (docs/PRD-body.md §5.4, §11). A workout is an activity and minutes; nothing here
// calls a model.
//   /workout 跑步 30 [低|中|高] → one line, logged; /workout with no args opens the activity buttons
//   workout_check              → the evening check (telegram_prefs.workout_at), sent only when a body plan
//                                exists and nothing is logged for today, so a day with a workout is silent
//   wo:<code>                  → an activity tap: a ForceReply for the minutes (telegram_state, 3 h).
//                                「没有，休息日」writes a zero-minute `rest` row, so the check does not repeat.
//   wo:t:<taskId>:<min>        → 记为运动 on a ticked-off workout-looking task: the row keeps
//                                workout_logs.task_id, so the same task is never logged twice.
// Free text ("跑了 30 分钟") is deliberately not parsed: it captures to the inbox as usual and the Guide may
// propose log_workout instead (§5.4, §9).
//
// Every write goes through insertWorkout below — one place that normalises the activity, dedupes by task and
// stays quiet when migration 0004 has not run (the Guide's log_workout proposal writes the same row through
// worker/proposals.ts, which is the path an approved proposal keeps taking).

import { bodySummary, loadBodyPlan } from "../body.ts";
import type { WorkoutIntensity } from "../../shared/types.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logReply } from "./events.ts";
import type { Reply } from "./router.ts";

/** The buttons of the evening check (§5.4); `other` asks for the activity too, `rest` logs the rest day. */
export const WORKOUT_PICKS = ["run", "strength", "walk", "other", "rest"] as const;
export type WorkoutPick = (typeof WORKOUT_PICKS)[number];

/** How long a reply still counts as the minutes. */
export const WORKOUT_ANSWER_SECONDS = 3 * 60 * 60;
/** The same bound as the Guide's log_workout proposal (worker/proposals.ts). */
export const MAX_WORKOUT_MIN = 600;
/** The zero-minute row 「没有，休息日」writes: it silences the check for the day without claiming a workout. */
const REST_ACTIVITY = "rest";

const PICK_ACTIVITY: Record<Exclude<WorkoutPick, "other" | "rest">, string> = {
  run: "run", strength: "strength", walk: "walk",
};

/** Words that mean one of the canonical activities; anything else is stored as the user typed it. */
const ACTIVITY_ALIASES: Record<string, string> = {
  "跑步": "run", "跑": "run", "晨跑": "run", "夜跑": "run", "慢跑": "run", run: "run", running: "run", jog: "run", jogging: "run",
  "力量": "strength", "健身": "strength", "举铁": "strength", "撸铁": "strength", gym: "strength", strength: "strength", lifting: "strength", weights: "strength",
  "走路": "walk", "散步": "walk", "快走": "walk", "徒步": "walk", walk: "walk", walking: "walk", hike: "walk", hiking: "walk",
  "游泳": "swim", swim: "swim", swimming: "swim",
  "骑行": "bike", "骑车": "bike", bike: "bike", biking: "bike", cycling: "bike", ride: "bike",
  "瑜伽": "yoga", yoga: "yoga",
  "运动": "workout", workout: "workout", training: "workout",
};

const ACTIVITY_LABELS: Record<string, string> = {
  run: "🏃 跑步 · run", strength: "🏋️ 力量 · strength", walk: "🚶 走路 · walk",
  swim: "🏊 游泳 · swim", bike: "🚴 骑行 · bike", yoga: "🧘 瑜伽 · yoga",
  workout: "🏃 运动 · workout", [REST_ACTIVITY]: "😌 休息日 · rest day",
};

/** 低|中|高 · easy|moderate|hard (§5.4), and the few obvious neighbours. */
const INTENSITY_WORDS: Record<string, WorkoutIntensity> = {
  "低": "easy", "轻": "easy", "轻松": "easy", "低强度": "easy", easy: "easy", light: "easy",
  "中": "moderate", "中等": "moderate", "中强度": "moderate", moderate: "moderate", medium: "moderate",
  "高": "hard", "强": "hard", "高强度": "hard", "大强度": "hard", hard: "hard", intense: "hard",
};
const INTENSITY_LABEL: Record<WorkoutIntensity, string> = { easy: "低 · easy", moderate: "中 · moderate", hard: "高 · hard" };

/** A ticked-off task whose title matches gets the 记为运动 offer (§5.4). */
export const WORKOUT_TITLE_RE = /跑步|健身|力量|游泳|骑行|瑜伽|run|gym|swim|bike|yoga|workout/i;
/** Which activity that title means; the order decides when a title mentions two. */
const TITLE_ACTIVITY: [RegExp, string][] = [
  [/跑步|run/i, "run"],
  [/健身|力量|gym/i, "strength"],
  [/游泳|swim/i, "swim"],
  [/骑行|bike/i, "bike"],
  [/瑜伽|yoga/i, "yoga"],
  [/workout/i, "workout"],
];

export function activityLabel(activity: string): string {
  return ACTIVITY_LABELS[activity] ?? activity;
}

function activityFromTitle(title: string): string | null {
  if (!WORKOUT_TITLE_RE.test(title)) return null;
  return TITLE_ACTIVITY.find(([re]) => re.test(title))?.[1] ?? "workout";
}

// ---------- parsing (`/workout 跑步 30 高强度`, and the minutes reply) ----------

export interface ParsedWorkout {
  activity: string;
  minutes: number;
  intensity: WorkoutIntensity | null;
}

const MINUTES_RE = /^(\d{1,3})(?:分钟|分|min|mins|minutes|m)?$/i;
const UNIT_RE = /^(?:分钟|分|min|mins|minutes|m)$/i;
/** `跑步30分钟` written without a space. */
const GLUED_RE = /^(\D+?)(\d{1,3})(?:分钟|分)?$/;

function normalizeActivity(text: string): string | null {
  const raw = text.trim().toLowerCase().slice(0, 60);
  if (!raw) return null;
  return ACTIVITY_ALIASES[raw] ?? raw;
}

/**
 * `跑步 30`, `run 30 min`, `力量 45 高强度`, `30`(with `fallback`) → the row to write; null when there is no
 * plausible number of minutes, which is what keeps free text out of the logs.
 */
export function parseWorkoutInput(text: string, fallback?: string | null): ParsedWorkout | null {
  let tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 1 && !MINUTES_RE.test(tokens[0])) {
    const glued = GLUED_RE.exec(tokens[0]);
    if (glued) tokens = [glued[1], glued[2]];
  }
  const at = tokens.findIndex((t) => MINUTES_RE.test(t));
  if (at < 0) return null;
  const minutes = Number(MINUTES_RE.exec(tokens[at])![1]);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_WORKOUT_MIN) return null;

  const rest = [...tokens.slice(0, at), ...tokens.slice(at + 1)].filter((t) => !UNIT_RE.test(t));
  const intensityOf = (t: string): WorkoutIntensity | undefined => INTENSITY_WORDS[t.toLowerCase()];
  const intensity = rest.map(intensityOf).find((i): i is WorkoutIntensity => !!i) ?? null;
  const words = tokens.slice(0, at).filter((t) => !UNIT_RE.test(t) && !intensityOf(t));

  const activity = words.length ? normalizeActivity(words.join(" ")) : fallback ? normalizeActivity(fallback) : null;
  return activity ? { activity, minutes, intensity } : null;
}

// ---------- the one write path ----------

type WriteResult = "logged" | "duplicate" | "error";

interface WorkoutWrite extends ParsedWorkout {
  date: string;
  /** Set only by wo:t:…, so one task can never be logged twice. */
  taskId?: number | null;
}

async function insertWorkout(db: D1Database, userId: number, w: WorkoutWrite): Promise<WriteResult> {
  try {
    const r = await db.prepare(
      `INSERT INTO workout_logs (user_id, date, activity, minutes, intensity, note, task_id)
       SELECT ?1, ?2, ?3, ?4, ?5, '', ?6
        WHERE ?6 IS NULL OR NOT EXISTS (SELECT 1 FROM workout_logs WHERE user_id = ?1 AND task_id = ?6)`
    ).bind(userId, w.date, w.activity.slice(0, 60), w.minutes, w.intensity ?? null, w.taskId ?? null).run();
    return r.meta.changes > 0 ? "logged" : "duplicate";
  } catch (e) {
    console.error("telegram workout: insert failed", e); // migration 0004 has not run here
    return "error";
  }
}

/** True when today already has a workout (or a rest day) — and on an error, so nothing is asked twice. */
async function hasWorkoutToday(db: D1Database, userId: number, date: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 AS n FROM workout_logs WHERE user_id = ? AND date = ? LIMIT 1")
      .bind(userId, date).first<{ n: number }>();
    return !!row;
  } catch {
    return true; // migration 0004 has not run here
  }
}

async function loggedForTask(db: D1Database, userId: number, taskId: number): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 AS n FROM workout_logs WHERE user_id = ? AND task_id = ? LIMIT 1")
      .bind(userId, taskId).first<{ n: number }>();
    return !!row;
  } catch {
    return true;
  }
}

type EchoContext = Pick<CallbackContext, "db" | "userId" | "today">;

/** One line back: what was logged, plus the week's count when a plan says what the week is for. */
async function workoutEcho(ctx: EchoContext, w: ParsedWorkout): Promise<string> {
  const intensity = w.intensity ? ` · ${INTENSITY_LABEL[w.intensity]}` : "";
  const s = await bodySummary(ctx.db, ctx.userId, ctx.today);
  const week = s ? `\n本周运动 ${s.week.workouts_done}/${s.week.workouts_target} · ${s.week.minutes} 分钟` : "";
  return `${activityLabel(w.activity)} ${w.minutes} 分钟${intensity} 已记下 · Logged${week}`;
}

const COULD_NOT_LOG = "没能记下 · Could not log it — 请稍后再试";

// ---------- the evening check (workout_check) ----------

export type WorkoutCheckContext = Pick<CallbackContext, "db" | "userId" | "today" | "send">;

/** The activity buttons; the same card the evening check sends and `/workout` with no arguments opens. */
export function workoutAskCard(): Reply {
  return {
    text: "🏃 今天动了吗？ · Did you move today?\n点一下，然后回复分钟数 · Tap one, then reply with the minutes",
    reply_markup: {
      inline_keyboard: [
        [
          { text: "🏃 跑步", callback_data: cb.workoutPick("run") },
          { text: "🏋️ 力量", callback_data: cb.workoutPick("strength") },
          { text: "🚶 走路", callback_data: cb.workoutPick("walk") },
        ],
        [
          { text: "其他…", callback_data: cb.workoutPick("other") },
          { text: "没有，休息日", callback_data: cb.workoutPick("rest") },
        ],
      ],
    },
  };
}

/** The scheduler's condition: a plan, and nothing logged today. No claim when there is nothing to ask. */
export async function workoutCheckDue(ctx: WorkoutCheckContext): Promise<boolean> {
  if (!(await loadBodyPlan(ctx.db, ctx.userId))) return false;
  return !(await hasWorkoutToday(ctx.db, ctx.userId, ctx.today));
}

export async function sendWorkoutCheck(ctx: WorkoutCheckContext): Promise<void> {
  await ctx.send(workoutAskCard());
}

// ---------- wo:<code> — an activity tap ----------

interface WorkoutState {
  kind: "awaiting_workout";
  /** The local date the minutes belong to, fixed when asked. */
  date: string;
  /** The activity already picked, or null when 其他… asked for both. */
  activity: string | null;
  expires_at: number;
}

function isWorkoutState(v: unknown): v is WorkoutState {
  const s = v as Partial<WorkoutState> | null;
  return !!s && typeof s === "object" && s.kind === "awaiting_workout"
    && typeof s.date === "string" && typeof s.expires_at === "number"
    && (s.activity === null || typeof s.activity === "string");
}

export async function workoutPick(ctx: CallbackContext, pick: WorkoutPick): Promise<string> {
  await logReply(ctx.db, ctx.userId, "workout_check", ctx.today);
  if (pick === "rest") {
    if (await hasWorkoutToday(ctx.db, ctx.userId, ctx.today)) {
      await ctx.finish("今天已经记过了 · Already logged today");
      return "已记过 · Already logged";
    }
    const r = await insertWorkout(ctx.db, ctx.userId, { date: ctx.today, activity: REST_ACTIVITY, minutes: 0, intensity: null });
    if (r === "error") return COULD_NOT_LOG;
    await ctx.finish("😌 休息日 · Rest day\n明天见 · See you tomorrow");
    return "休息日 · Rest day";
  }
  const activity = pick === "other" ? null : PICK_ACTIVITY[pick];
  const state: WorkoutState = {
    kind: "awaiting_workout", date: ctx.today, activity, expires_at: Date.now() + WORKOUT_ANSWER_SECONDS * 1000,
  };
  await ctx.state.put(state, WORKOUT_ANSWER_SECONDS);
  await ctx.send({
    text: activity
      ? `${activityLabel(activity)} — 多少分钟？ · How many minutes?`
      : "什么运动，多少分钟？ · What did you do, and for how long?\n例如 · e.g. 瑜伽 30",
    reply_markup: { force_reply: true, input_field_placeholder: activity ? "30" : "瑜伽 30" },
  });
  return "回复分钟数 · Reply with the minutes";
}

/**
 * Router step 3: the typed answer while the minutes ask is open. Anything that is not a number of minutes
 * falls through to capture with the slot left open, exactly like the weight ask (§5.1).
 */
export async function workoutAnswer(
  ctx: Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">, text: string,
): Promise<boolean> {
  const state = await ctx.state.get();
  if (!isWorkoutState(state)) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    return false;
  }
  // 其他… asked for both; a bare number after it is still a workout, just an unnamed one.
  const parsed = parseWorkoutInput(text, state.activity ?? "workout");
  if (!parsed) return false;
  const r = await insertWorkout(ctx.db, ctx.userId, { ...parsed, date: state.date });
  if (r === "error") {
    await ctx.send({ text: COULD_NOT_LOG });
    return true;
  }
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, "workout_check", ctx.today);
  await ctx.send({ text: await workoutEcho(ctx, parsed) });
  return true;
}

// ---------- the done-task offer, and wo:t:<taskId>:<min> ----------

export interface WorkoutTask {
  id: number;
  title: string;
  actual_min: number | null;
  estimate_min: number | null;
}

/**
 * A workout-looking task was just ticked off: offer to log it, with the minutes it actually (or was meant to)
 * take. Quiet without a body plan, without minutes, or when this task is already a workout. Never throws —
 * the ✓ itself has already been applied by the time this runs.
 */
export async function offerWorkoutFromTask(
  ctx: Pick<CallbackContext, "db" | "userId" | "send">, task: WorkoutTask,
): Promise<void> {
  try {
    const minutes = task.actual_min ?? task.estimate_min;
    if (!minutes || minutes < 1 || minutes > MAX_WORKOUT_MIN) return;
    const activity = activityFromTitle(task.title);
    if (!activity) return;
    if (!(await loadBodyPlan(ctx.db, ctx.userId))) return; // no plan: no body prompts at all (§4.3)
    if (await loggedForTask(ctx.db, ctx.userId, task.id)) return;
    await ctx.send({
      text: `🏃 记为运动？ · Log as a workout?\n${task.title} · ${activityLabel(activity)} ${minutes} 分钟`,
      reply_markup: {
        inline_keyboard: [[{ text: `记为运动 ${minutes}分`, callback_data: cb.workoutTask(task.id, minutes) }]],
      },
    });
  } catch (e) {
    console.error("telegram workout: offer failed", e);
  }
}

/** wo:t:<taskId>:<min> — the offer accepted; the row links the task, so a replayed tap logs nothing new. */
export async function workoutFromTask(ctx: CallbackContext, taskId: number, minutes: number): Promise<string> {
  const task = await ctx.db.prepare("SELECT title FROM tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, ctx.userId).first<{ title: string }>();
  if (!task) return "找不到这件事 · Task not found";
  const parsed: ParsedWorkout = { activity: activityFromTitle(task.title) ?? "workout", minutes, intensity: null };
  const r = await insertWorkout(ctx.db, ctx.userId, { ...parsed, date: ctx.today, taskId });
  if (r === "error") return COULD_NOT_LOG;
  if (r === "duplicate") {
    await ctx.finish(`🏃 已经记过了 · Already logged\n${task.title}`);
    return "已经记过 · Already logged";
  }
  await ctx.finish(await workoutEcho(ctx, parsed));
  return "已记下 · Logged";
}

// ---------- /workout ----------

const USAGE: Reply = {
  text: "用法 · Usage: /workout 跑步 30\n可以加强度 · intensity is optional: /workout 力量 45 高强度（低|中|高 · easy|moderate|hard）",
};

export async function workoutCommand(ctx: CallbackContext, args: string): Promise<void> {
  const text = args.trim();
  if (!text) {
    await ctx.send(workoutAskCard());
    return;
  }
  const parsed = parseWorkoutInput(text);
  if (!parsed) {
    await ctx.send(USAGE);
    return;
  }
  const r = await insertWorkout(ctx.db, ctx.userId, { ...parsed, date: ctx.today });
  await ctx.send({ text: r === "error" ? COULD_NOT_LOG : await workoutEcho(ctx, parsed) });
}
