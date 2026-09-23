// Telegram callback_data protocol (PRD §7.3) and the shared button handlers.
// callback_data is client-supplied, replayable and capped at 64 bytes, so it only
// ever carries short opaque verbs and ids — never free text — and every handler
// re-checks ownership against the user resolved from the chat, not from the data.

import { carryOver, deleteTask, updateTask } from "../tasks.ts";
import type { MealKind } from "../../shared/types.ts";
import { REVIEW_QUESTIONS } from "../../shared/reviews.ts";
import type { GuideEnv } from "../guide.ts";
import type { TelegramBot } from "./api.ts";
import { rateDay, reviewFocus, reviewNext, reviewResume, reviewSkip } from "./review.ts";
import { carryOnMorning, sendMorning, topThreeDone } from "./compose.ts";
import { topThreeButton } from "./topthree.ts";
import { goalComplete, goalList, goalPause, goalSetAsk, goalSetProgress, goalView, taskPickGoal } from "./goals.ts";
import { weeklyGuideDraft, weeklyWritePrompt } from "./weekly.ts";
import { blockDone, blockSnooze, blockTomorrow, recordActualMin } from "./blocks.ts";
import { checkinDone, checkinList, checkinPick, checkinRate } from "./checkin.ts";
import { loginDecide } from "./login.ts";
import { obsUndoButton, streamSkipButton, streamValueButton, timerStartButton, timerStopButton, trackerShowButton } from "./stream.ts";
import { directionSkip, timezonePick } from "./register.ts";
import { muteFor, settingsToggle, unlinkConfirm } from "./account.ts";
import { proposalAnswer, taskAskGuide } from "./guide.ts";
import { bodyNudgeAction, type BodyNudgeRule } from "./bodynudge.ts";
import { bodyAction } from "./commands.ts";
import { MAX_WORKOUT_MIN, offerWorkoutFromTask, workoutFromTask, workoutPick, type WorkoutPick } from "./workout.ts";
import { mealButton, mealPromptButton, type MealAction, type MealPromptAction } from "./meal.ts";
import { adaptButton, type AdaptSlot } from "./adapt.ts";
import { weightButton, type WeightAction } from "./weight.ts";
import type { Reply } from "./router.ts";
import type { TelegramStateStore } from "./state.ts";

import { CALLBACK_DATA_MAX_BYTES } from "./api.ts";

export { CALLBACK_DATA_MAX_BYTES };

export const RATING_FIELDS = ["mood", "energy", "focus", "satisfaction"] as const;
export type RatingField = (typeof RATING_FIELDS)[number];

export type TopThreeAction = "rewrite" | "copy" | "guide" | "write";
const TOP_THREE_CODES = { rewrite: "r", copy: "y", guide: "g", write: "w" } as const satisfies Record<TopThreeAction, string>;

export type GoalAction = "view" | "complete" | "pause" | "set";
const GOAL_CODES = { view: "v", complete: "c", pause: "z", set: "s" } as const satisfies Record<GoalAction, string>;

export type BlockAction = "done" | "snooze" | "tomorrow";
const BLOCK_CODES = { done: "d", snooze: "z", tomorrow: "t" } as const satisfies Record<BlockAction, string>;

export type SettingsToggle = "nudges" | "block_reminders" | "streaks";
const SETTINGS_CODES = { nudges: "n", block_reminders: "b", streaks: "s" } as const satisfies Record<SettingsToggle, string>;

/** The three logging buttons under `/body` (PRD-body §11); each opens an ask that already exists. */
export const BODY_ACTIONS = ["weigh", "meal", "workout"] as const;
export type BodyAction = (typeof BODY_ACTIONS)[number];
const BODY_ACTION_CODES = { weigh: "w", meal: "m", workout: "o" } as const satisfies Record<BodyAction, string>;

/** The body nudge rules of PRD-body §6.2; the tapped rule decides what the button does. */
const BODY_NUDGE_CODES = { weigh: "w", workout: "o", trend: "t", kcal: "k" } as const satisfies Record<BodyNudgeRule, string>;

/** The weigh-in's buttons (PRD-body §5.1): 跳过今天 on the ask, 撤销 on the fast path's echo. */
const WEIGHT_CODES = { skip: "s", undo: "u" } as const satisfies Record<WeightAction, string>;

/** The evening check's activity buttons (PRD-body §5.4); `t` is taken by wo:t:<taskId>:<min>. */
const WORKOUT_CODES = { run: "r", strength: "s", walk: "w", other: "o", rest: "x" } as const satisfies Record<WorkoutPick, string>;

/**
 * The confirm card's buttons (PRD-body §5.2); `estimate` only appears on a meal with no numbers yet and
 * `reanalyze` only on one that still has its photo (§13 item 12).
 */
const MEAL_CODES = { confirm: "y", edit: "e", discard: "x", estimate: "g", reanalyze: "r" } as const satisfies Record<MealAction, string>;

/** The adaptive-time suggestion (PRD-body §13 item 10); `ad:x` leaves the slot alone, `ad:f:<slot>` turns it off. */
const ADAPT_CODES = { weigh: "w", breakfast: "b", lunch: "l", dinner: "d", workout: "o" } as const satisfies Record<AdaptSlot, string>;

/** The meal ask's own buttons (PRD-body §5.2); they carry the meal and the date, never a row id. */
const MEAL_PROMPT_CODES = { skip: "s", none: "n" } as const satisfies Record<MealPromptAction, string>;
const MEAL_KIND_CODES = { breakfast: "b", lunch: "l", dinner: "d", snack: "s" } as const satisfies Record<MealKind, string>;

export type MuteSpan = "today" | "week" | "off";
const MUTE_CODES = { today: "t", week: "w", off: "o" } as const satisfies Record<MuteSpan, string>;

/** The most questions any review period has (rv:skip:<q> bound). */
const MAX_QUESTIONS = Math.max(...Object.values(REVIEW_QUESTIONS).map((q) => q.length));
/** Timezone picker entries (tz:<n>), see register.ts COMMON_ZONES. */
export const MAX_TIMEZONE_PICK = 30;

// ---------- wire formats ----------

type Num = number | string;
type TaskDone<Id extends Num> = `t:${Id}:d`;
type TaskSchedule<Id extends Num, Days extends Num> = `t:${Id}:s:${Days}`;
type TaskLinkGoal<Id extends Num> = `t:${Id}:g`;
type TaskAskGuide<Id extends Num> = `t:${Id}:a`;
type TaskDelete<Id extends Num> = `t:${Id}:x`;
type TaskPickGoal<Id extends Num, Goal extends Num> = `gl:${Id}:${Goal}`;
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
type GoalAct<Id extends Num> = `g:${Id}:${(typeof GOAL_CODES)[GoalAction]}`;
type GoalList = "g:l";
type Weekly<Date extends string> = `wk:${"w" | "g"}:${Date}`;
type Block<Id extends Num> = `bk:${Id}:${(typeof BLOCK_CODES)[BlockAction]}`;
type Checkin<Area extends Num, N extends Num> = "ac:l" | "ac:x" | `ac:${Area}` | `ac:${Area}:${N}`;
type Login<Id extends Num> = `lg:${Id}:${"y" | "n"}`;
type Register = "rg:y" | "rg:n";
type TimezonePick<N extends Num> = `tz:${N}`;
type Settings = `st:${(typeof SETTINGS_CODES)[SettingsToggle]}`;
type Mute = `mu:${(typeof MUTE_CODES)[MuteSpan]}`;
type Unlink = "ul:y";
type DirectionSkip = "dr:s";
type ProposalAnswer<MsgId extends Num, Idx extends Num> = `pr:${MsgId}:${Idx}:${"y" | "n"}`;
/** "Send me today's brief" on the link welcome (link.ts). */
type Brief = "br";
/** Trackers (PRD-brain §8): a one-tap answer, a skip, an undo, the timer and the card. */
type StreamValue<Id extends Num, N extends Num> = `sv:${Id}:${N}`;
type StreamSkip<Id extends Num> = `sv:${Id}:x`;
type ObsUndo<Id extends Num> = `su:${Id}`;
type TimerStart<Id extends Num> = `tm:${Id}`;
type TimerStop = "tm:x";
type TrackerShow<Id extends Num> = `tr:${Id}`;
type BodyNudge = `bn:${(typeof BODY_NUDGE_CODES)[BodyNudgeRule]}`;
type BodyActionData = `bd:${(typeof BODY_ACTION_CODES)[BodyAction]}`;
type WeightData<Date extends string> = `wt:${(typeof WEIGHT_CODES)[WeightAction]}:${Date}`;
type WorkoutPickData = `wo:${(typeof WORKOUT_CODES)[WorkoutPick]}`;
type WorkoutFromTask<Id extends Num, Min extends Num> = `wo:t:${Id}:${Min}`;
type Meal<Id extends Num> = `ml:${Id}:${(typeof MEAL_CODES)[MealAction]}`;
type MealPrompt<Date extends string> =
  `ml:${(typeof MEAL_PROMPT_CODES)[MealPromptAction]}:${(typeof MEAL_KIND_CODES)[MealKind]}:${Date}`;
/** `ad:l:1340` — the slot and the new time as four digits, since ':' is the separator. */
type Adapt<Time extends string> =
  | `ad:${(typeof ADAPT_CODES)[AdaptSlot]}:${Time}`
  /** `ad:f:l` — turn that ask off altogether (the §15 q3 rule); 'f' is no slot's code, so it cannot collide. */
  | `ad:f:${(typeof ADAPT_CODES)[AdaptSlot]}`
  | "ad:x";

export type Callback =
  | { verb: "task_done"; taskId: number }
  | { verb: "task_schedule"; taskId: number; offsetDays: number }
  | { verb: "task_link_goal"; taskId: number }
  | { verb: "task_ask_guide"; taskId: number }
  | { verb: "task_delete"; taskId: number }
  | { verb: "task_pick_goal"; taskId: number; goalId: number }
  | { verb: "actual_min"; taskId: number; min: number }
  | { verb: "rating"; field: RatingField; n: number }
  | { verb: "review"; step: "next" | "resume" }
  | { verb: "review_skip"; question: number }
  | { verb: "review_focus"; date: string }
  | { verb: "carry"; action: "forward" | "drop"; morning?: string }
  | { verb: "top_three"; action: TopThreeAction; date: string }
  | { verb: "top_done"; n: 1 | 2 | 3; date: string }
  | { verb: "goal_progress"; goalId: number; progress: number }
  | { verb: "goal"; goalId: number; action: GoalAction }
  | { verb: "goal_list" }
  | { verb: "weekly"; action: "write" | "guide"; weekStart: string }
  | { verb: "block"; taskId: number; action: BlockAction }
  | { verb: "checkin_list" }
  | { verb: "checkin_done" }
  | { verb: "checkin_pick"; areaId: number }
  | { verb: "checkin_rate"; areaId: number; n: number }
  | { verb: "login"; codeId: number; approve: boolean }
  | { verb: "register"; yes: boolean }
  | { verb: "timezone_pick"; n: number }
  | { verb: "settings"; toggle: SettingsToggle }
  | { verb: "mute"; span: MuteSpan }
  | { verb: "unlink" }
  | { verb: "direction_skip" }
  | { verb: "proposal"; msgId: number; idx: number; approve: boolean }
  | { verb: "brief" }
  | { verb: "body_nudge"; rule: BodyNudgeRule }
  | { verb: "body_action"; action: BodyAction }
  | { verb: "weight"; action: WeightAction; date: string }
  | { verb: "workout_pick"; pick: WorkoutPick }
  | { verb: "workout_task"; taskId: number; min: number }
  | { verb: "meal"; mealId: number; action: MealAction }
  | { verb: "meal_prompt"; action: MealPromptAction; meal: MealKind; date: string }
  /** slot and time are null on `ad:x` — the suggestion was turned down. `off` is the `ad:f:<slot>` form. */
  | { verb: "adapt"; slot: AdaptSlot | null; time: string | null; off?: true }
  | { verb: "stream_value"; streamId: number; value: number }
  | { verb: "stream_skip"; streamId: number }
  | { verb: "obs_undo"; obsId: number }
  | { verb: "timer_start"; streamId: number }
  | { verb: "timer_stop" }
  | { verb: "tracker_show"; streamId: number };

// Numeric bounds; the build-time assertion below is checked against their widest values.
const MAX_OFFSET_DAYS = 365;
const MAX_ACTUAL_MIN = 1440;
const MAX_PROPOSAL_IDX = 99;
/** A quick-answer button carries a small whole number in the stream's base unit. */
const MAX_QUICK_VALUE = 9999;

// Build-time assertion: the widest payload of every verb fits in 64 bytes (all ASCII,
// so characters = bytes). Changing a format to something longer fails `npm run typecheck`.
type MaxId = "9007199254740991"; // Number.MAX_SAFE_INTEGER — the largest id parseCallback accepts
type Widest =
  | TaskDone<MaxId> | TaskSchedule<MaxId, "365"> | TaskLinkGoal<MaxId> | TaskAskGuide<MaxId> | TaskDelete<MaxId>
  | TaskPickGoal<MaxId, MaxId> | ActualMin<MaxId, "1440"> | Rating<RatingField, "5">
  | ReviewStep | ReviewSkip<"9"> | ReviewFocus<"2026-12-31"> | Carry<"2026-12-31"> | TopThree<"2026-12-31">
  | TopDone<"3", "2026-12-31"> | GoalProgress<MaxId, "100"> | GoalAct<MaxId> | GoalList | Weekly<"2026-12-31">
  | Block<MaxId> | Checkin<MaxId, "10"> | Login<MaxId> | Register | TimezonePick<"30"> | Settings | Mute | Unlink
  | DirectionSkip | ProposalAnswer<MaxId, "99"> | Brief | BodyNudge | BodyActionData
  | WeightData<"2026-12-31"> | WorkoutPickData | WorkoutFromTask<MaxId, "600"> | Meal<MaxId> | MealPrompt<"2026-12-31">
  | Adapt<"2359"> | StreamValue<MaxId, "9999"> | StreamSkip<MaxId> | ObsUndo<MaxId>
  | TimerStart<MaxId> | TimerStop | TrackerShow<MaxId>;
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

function codeOf<T extends string>(codes: Record<T, string>, code: string | undefined): T | undefined {
  return (Object.keys(codes) as T[]).find((k) => codes[k] === code);
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
    case "gl": {
      const taskId = toId(p[1]), goalId = toId(p[2]);
      return p.length === 3 && taskId !== null && goalId !== null ? { verb: "task_pick_goal", taskId, goalId } : null;
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
      const question = toInt(p[2], 1, MAX_QUESTIONS);
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
      const action = codeOf<TopThreeAction>(TOP_THREE_CODES, p[1]);
      return p.length === 3 && action && isDate(p[2]) ? { verb: "top_three", action, date: p[2] } : null;
    }
    case "td": {
      const n = toInt(p[1], 1, 3);
      return p.length === 3 && (n === 1 || n === 2 || n === 3) && isDate(p[2]) ? { verb: "top_done", n, date: p[2] } : null;
    }
    case "g": {
      if (p.length === 2 && p[1] === "l") return { verb: "goal_list" };
      const goalId = toId(p[1]);
      if (goalId === null) return null;
      const progress = toInt(p[3], 0, 100);
      if (p.length === 4 && p[2] === "p" && progress !== null) return { verb: "goal_progress", goalId, progress };
      const action = codeOf<GoalAction>(GOAL_CODES, p[2]);
      return p.length === 3 && action ? { verb: "goal", goalId, action } : null;
    }
    case "wk": {
      const action = p[1] === "w" ? "write" : p[1] === "g" ? "guide" : null;
      return p.length === 3 && action && isDate(p[2]) ? { verb: "weekly", action, weekStart: p[2] } : null;
    }
    case "bk": {
      const taskId = toId(p[1]), action = codeOf<BlockAction>(BLOCK_CODES, p[2]);
      return p.length === 3 && taskId !== null && action ? { verb: "block", taskId, action } : null;
    }
    case "ac": {
      if (p.length === 2 && p[1] === "l") return { verb: "checkin_list" };
      if (p.length === 2 && p[1] === "x") return { verb: "checkin_done" };
      const areaId = toId(p[1]);
      if (areaId === null) return null;
      if (p.length === 2) return { verb: "checkin_pick", areaId };
      const n = toInt(p[2], 1, 10);
      return p.length === 3 && n !== null ? { verb: "checkin_rate", areaId, n } : null;
    }
    case "lg": {
      const codeId = toId(p[1]);
      return p.length === 3 && codeId !== null && (p[2] === "y" || p[2] === "n") ? { verb: "login", codeId, approve: p[2] === "y" } : null;
    }
    case "rg":
      return p.length === 2 && (p[1] === "y" || p[1] === "n") ? { verb: "register", yes: p[1] === "y" } : null;
    case "tz": {
      const n = toInt(p[1], 0, MAX_TIMEZONE_PICK);
      return p.length === 2 && n !== null ? { verb: "timezone_pick", n } : null;
    }
    case "st": {
      const toggle = codeOf<SettingsToggle>(SETTINGS_CODES, p[1]);
      return p.length === 2 && toggle ? { verb: "settings", toggle } : null;
    }
    case "mu": {
      const span = codeOf<MuteSpan>(MUTE_CODES, p[1]);
      return p.length === 2 && span ? { verb: "mute", span } : null;
    }
    case "ul":
      return p.length === 2 && p[1] === "y" ? { verb: "unlink" } : null;
    case "dr":
      return p.length === 2 && p[1] === "s" ? { verb: "direction_skip" } : null;
    case "pr": {
      const msgId = toId(p[1]), idx = toInt(p[2], 0, MAX_PROPOSAL_IDX);
      return p.length === 4 && (p[3] === "y" || p[3] === "n") && msgId !== null && idx !== null
        ? { verb: "proposal", msgId, idx, approve: p[3] === "y" } : null;
    }
    case "br":
      return p.length === 1 ? { verb: "brief" } : null;
    case "bn": {
      const rule = codeOf<BodyNudgeRule>(BODY_NUDGE_CODES, p[1]);
      return p.length === 2 && rule ? { verb: "body_nudge", rule } : null;
    }
    case "bd": {
      const action = codeOf<BodyAction>(BODY_ACTION_CODES, p[1]);
      return p.length === 2 && action ? { verb: "body_action", action } : null;
    }
    case "wt": {
      const action = codeOf<WeightAction>(WEIGHT_CODES, p[1]);
      return p.length === 3 && action && isDate(p[2]) ? { verb: "weight", action, date: p[2] } : null;
    }
    case "wo": {
      if (p.length === 2) {
        const pick = codeOf<WorkoutPick>(WORKOUT_CODES, p[1]);
        return pick ? { verb: "workout_pick", pick } : null;
      }
      const taskId = toId(p[2]), min = toInt(p[3], 1, MAX_WORKOUT_MIN);
      return p.length === 4 && p[1] === "t" && taskId !== null && min !== null
        ? { verb: "workout_task", taskId, min } : null;
    }
    case "ml": {
      if (p.length === 4) {
        const action = codeOf<MealPromptAction>(MEAL_PROMPT_CODES, p[1]);
        const meal = codeOf<MealKind>(MEAL_KIND_CODES, p[2]);
        return action && meal && isDate(p[3]) ? { verb: "meal_prompt", action, meal, date: p[3] } : null;
      }
      const mealId = toId(p[1]), action = codeOf<MealAction>(MEAL_CODES, p[2]);
      return p.length === 3 && mealId !== null && action ? { verb: "meal", mealId, action } : null;
    }
    case "sv": {
      const streamId = toId(p[1]);
      if (p.length !== 3 || streamId === null) return null;
      if (p[2] === "x") return { verb: "stream_skip", streamId };
      const value = toInt(p[2], 0, MAX_QUICK_VALUE);
      return value === null ? null : { verb: "stream_value", streamId, value };
    }
    case "su": {
      const obsId = toId(p[1]);
      return p.length === 2 && obsId !== null ? { verb: "obs_undo", obsId } : null;
    }
    case "tm": {
      if (p.length === 2 && p[1] === "x") return { verb: "timer_stop" };
      const streamId = toId(p[1]);
      return p.length === 2 && streamId !== null ? { verb: "timer_start", streamId } : null;
    }
    case "tr": {
      const streamId = toId(p[1]);
      return p.length === 2 && streamId !== null ? { verb: "tracker_show", streamId } : null;
    }
    case "ad": {
      if (p.length === 2 && p[1] === "x") return { verb: "adapt", slot: null, time: null };
      if (p.length === 3 && p[1] === "f") {
        const off = codeOf<AdaptSlot>(ADAPT_CODES, p[2]);
        return off ? { verb: "adapt", slot: off, time: null, off: true } : null;
      }
      const slot = codeOf<AdaptSlot>(ADAPT_CODES, p[1]);
      const t = p[2] && /^\d{4}$/.test(p[2]) ? p[2] : null;
      if (p.length !== 3 || !slot || t === null) return null;
      const h = Number(t.slice(0, 2)), m = Number(t.slice(2));
      return h < 24 && m < 60 ? { verb: "adapt", slot, time: `${t.slice(0, 2)}:${t.slice(2)}` } : null;
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
  taskPickGoal: (taskId: number, goalId: number): TaskPickGoal<number, number> => checked(`gl:${taskId}:${goalId}` as const),
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
  goal: (goalId: number, action: GoalAction): GoalAct<number> => checked(`g:${goalId}:${GOAL_CODES[action]}` as const),
  goalList: (): GoalList => checked("g:l"),
  weekly: (action: "write" | "guide", weekStart: string): Weekly<string> =>
    checked(`wk:${action === "write" ? "w" : "g"}:${weekStart}` as const),
  block: (taskId: number, action: BlockAction): Block<number> => checked(`bk:${taskId}:${BLOCK_CODES[action]}` as const),
  checkinList: (): "ac:l" => checked("ac:l"),
  checkinDone: (): "ac:x" => checked("ac:x"),
  checkinPick: (areaId: number): `ac:${number}` => checked(`ac:${areaId}` as const),
  checkinRate: (areaId: number, n: number): `ac:${number}:${number}` => checked(`ac:${areaId}:${n}` as const),
  login: (codeId: number, approve: boolean): Login<number> => checked(`lg:${codeId}:${approve ? "y" : "n"}` as const),
  register: (yes: boolean): Register => checked(yes ? "rg:y" : "rg:n"),
  timezonePick: (n: number): TimezonePick<number> => checked(`tz:${n}` as const),
  settings: (toggle: SettingsToggle): Settings => checked(`st:${SETTINGS_CODES[toggle]}` as const),
  mute: (span: MuteSpan): Mute => checked(`mu:${MUTE_CODES[span]}` as const),
  unlink: (): Unlink => checked("ul:y"),
  directionSkip: (): DirectionSkip => checked("dr:s"),
  proposal: (msgId: number, idx: number, approve: boolean): ProposalAnswer<number, number> =>
    checked(`pr:${msgId}:${idx}:${approve ? "y" : "n"}` as const),
  brief: (): Brief => checked("br"),
  bodyNudge: (rule: BodyNudgeRule): BodyNudge => checked(`bn:${BODY_NUDGE_CODES[rule]}` as const),
  bodyAction: (action: BodyAction): BodyActionData => checked(`bd:${BODY_ACTION_CODES[action]}` as const),
  weight: (action: WeightAction, date: string): WeightData<string> => checked(`wt:${WEIGHT_CODES[action]}:${date}` as const),
  workoutPick: (pick: WorkoutPick): WorkoutPickData => checked(`wo:${WORKOUT_CODES[pick]}` as const),
  workoutTask: (taskId: number, min: number): WorkoutFromTask<number, number> => checked(`wo:t:${taskId}:${min}` as const),
  meal: (mealId: number, action: MealAction): Meal<number> => checked(`ml:${mealId}:${MEAL_CODES[action]}` as const),
  mealPrompt: (action: MealPromptAction, meal: MealKind, date: string): MealPrompt<string> =>
    checked(`ml:${MEAL_PROMPT_CODES[action]}:${MEAL_KIND_CODES[meal]}:${date}` as const),
  adapt: (slot: AdaptSlot, time: string): Adapt<string> =>
    checked(`ad:${ADAPT_CODES[slot]}:${time.replace(":", "")}` as const),
  adaptOff: (slot: AdaptSlot): Adapt<string> => checked(`ad:f:${ADAPT_CODES[slot]}` as const),
  adaptKeep: (): "ad:x" => checked("ad:x"),
  streamValue: (streamId: number, value: number): StreamValue<number, number> => checked(`sv:${streamId}:${value}` as const),
  streamSkip: (streamId: number): StreamSkip<number> => checked(`sv:${streamId}:x` as const),
  obsUndo: (obsId: number): ObsUndo<number> => checked(`su:${obsId}` as const),
  timerStart: (streamId: number): TimerStart<number> => checked(`tm:${streamId}` as const),
  timerStop: (): TimerStop => checked("tm:x"),
  trackerShow: (streamId: number): TrackerShow<number> => checked(`tr:${streamId}` as const),
};

// ---------- handlers ----------

export interface CallbackContext {
  db: D1Database;
  /** Owner of the chat the tap came from, resolved by the webhook — never taken from callback_data. */
  userId: number;
  /** The user's local YYYY-MM-DD. */
  today: string;
  /** users.timezone (IANA) or null = UTC. */
  timezone: string | null;
  /** The web origin, e.g. https://way.peiyong.ai, for deep links into the app. */
  origin: string;
  /** answerCallbackQuery — stops the client's spinner. handleCallback calls it exactly once per tap. */
  answer(text?: string): Promise<void>;
  /** Edit the tapped message to its terminal state (buttons removed), so a second device cannot re-apply. */
  finish(text: string): Promise<void>;
  /** Edit the tapped message in place and keep it live (new text and keyboard), e.g. the ratings card. */
  edit(reply: Reply): Promise<void>;
  /** Send a new message to the chat. */
  send(reply: Reply): Promise<void>;
  /** Send a new message and return its Telegram message id (Guide replies remember theirs). */
  sendId(reply: Reply): Promise<number>;
  /** "typing…" in the chat while a model call runs. */
  typing(): Promise<void>;
  /** This user's telegram_state slot. */
  state: TelegramStateStore;
  /** Model settings for Guide turns. */
  guide: GuideEnv;
  /** The Bot API client (file downloads for voice capture). */
  bot: TelegramBot;
}

/** Route one button tap. Always answers the callback query, even on bad data or errors. */
export async function handleCallback(ctx: CallbackContext, data: string): Promise<void> {
  let toast: string | undefined;
  try {
    const parsed = parseCallback(data);
    if (!parsed) toast = "无效按钮 · Invalid button";
    else toast = await dispatch(ctx, parsed);
  } finally {
    await ctx.answer(toast);
  }
}

async function dispatch(ctx: CallbackContext, p: Callback): Promise<string | undefined> {
  switch (p.verb) {
    case "task_done": return taskDone(ctx, p.taskId);
    case "task_schedule": return taskSchedule(ctx, p.taskId, p.offsetDays);
    case "task_delete": return taskDelete(ctx, p.taskId);
    case "task_link_goal": return goalList(ctx, { forTask: p.taskId });
    case "task_pick_goal": return taskPickGoal(ctx, p.taskId, p.goalId);
    case "task_ask_guide": return taskAskGuide(ctx, p.taskId);
    case "actual_min": return recordActualMin(ctx, p.taskId, p.min);
    case "carry": return carry(ctx, p.action, p.morning);
    case "rating": return rateDay(ctx, p.field, p.n);
    case "review": return p.step === "next" ? reviewNext(ctx) : reviewResume(ctx);
    case "review_skip": return reviewSkip(ctx, p.question);
    case "review_focus": return reviewFocus(ctx, p.date);
    case "top_three": return topThreeButton(ctx, p.action, p.date);
    case "top_done": return topThreeDone(ctx, p.n, p.date);
    case "goal_progress": return goalSetProgress(ctx, p.goalId, p.progress);
    case "goal":
      if (p.action === "view") return goalView(ctx, p.goalId);
      if (p.action === "complete") return goalComplete(ctx, p.goalId);
      if (p.action === "pause") return goalPause(ctx, p.goalId);
      return goalSetAsk(ctx, p.goalId);
    case "goal_list": return goalList(ctx, {});
    case "weekly": return p.action === "write" ? weeklyWritePrompt(ctx, p.weekStart) : weeklyGuideDraft(ctx, p.weekStart);
    case "block":
      if (p.action === "done") return blockDone(ctx, p.taskId);
      if (p.action === "snooze") return blockSnooze(ctx, p.taskId);
      return blockTomorrow(ctx, p.taskId);
    case "checkin_list": return checkinList(ctx);
    case "checkin_done": return checkinDone(ctx);
    case "checkin_pick": return checkinPick(ctx, p.areaId);
    case "checkin_rate": return checkinRate(ctx, p.areaId, p.n);
    case "login": return loginDecide(ctx, p.codeId, p.approve);
    case "register": return "已经连接了 · Already linked"; // only reachable from a linked chat; register.ts handles unlinked ones
    case "timezone_pick": return timezonePick(ctx, p.n);
    case "settings": return settingsToggle(ctx, p.toggle);
    case "mute": return muteFor(ctx, p.span);
    case "unlink": return unlinkConfirm(ctx);
    case "direction_skip": return directionSkip(ctx);
    case "proposal": return proposalAnswer(ctx, p.msgId, p.idx, p.approve);
    case "brief": return brief(ctx);
    case "body_nudge": return bodyNudgeAction(ctx, p.rule);
    case "body_action": return bodyAction(ctx, p.action);
    case "weight": return weightButton(ctx, p.action, p.date);
    case "workout_pick": return workoutPick(ctx, p.pick);
    case "workout_task": return workoutFromTask(ctx, p.taskId, p.min);
    case "meal": return mealButton(ctx, p.mealId, p.action);
    case "meal_prompt": return mealPromptButton(ctx, p.action, p.meal, p.date);
    case "adapt": return adaptButton(ctx, p.slot, p.time, p.off ?? false);
    case "stream_value": return streamValueButton(ctx, p.streamId, p.value);
    case "stream_skip": return streamSkipButton(ctx, p.streamId);
    case "obs_undo": return obsUndoButton(ctx, p.obsId);
    case "timer_start": return timerStartButton(ctx, p.streamId);
    case "timer_stop": return timerStopButton(ctx);
    case "tracker_show": return trackerShowButton(ctx, p.streamId);
  }
}

// Marks done rather than toggling, so a replayed or double tap applies once.
async function taskDone(ctx: CallbackContext, taskId: number): Promise<string> {
  const row = await ctx.db.prepare(
    "UPDATE tasks SET done = 1, done_at = datetime('now') WHERE id = ? AND user_id = ? AND done = 0 RETURNING title, actual_min, estimate_min"
  ).bind(taskId, ctx.userId).first<{ title: string; actual_min: number | null; estimate_min: number | null }>();
  if (row) {
    await ctx.finish(`✓ 已完成 · Done\n${row.title}`);
    // A workout-looking task offers to become a workout log (PRD-body §5.4); quiet for everything else.
    await offerWorkoutFromTask(ctx, { id: taskId, ...row });
    return "已完成 · Done";
  }
  const task = await ctx.db.prepare("SELECT title FROM tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, ctx.userId).first<{ title: string }>();
  if (!task) return "找不到这件事 · Task not found"; // unknown or another user's id: nothing changes
  await ctx.finish(`✓ 已完成 · Done\n${task.title}`);
  return "已经完成了 · Already done";
}

// A fresh morning message rather than an edit, so tapping again later in the day shows the day as it is then.
async function brief(ctx: CallbackContext): Promise<string> {
  await sendMorning(ctx);
  return "已发 · Sent";
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
