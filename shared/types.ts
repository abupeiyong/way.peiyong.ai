import type { GoalKind, Period, Shape, Verdict } from "./streams.ts";
import type { WeightSource } from "./body.ts";

export type GoalLevel = "lifetime" | "year" | "quarter" | "month" | "week";
export type GoalType = "outcome" | "process" | "maintenance" | "learning";
export type GoalStatus = "draft" | "active" | "at_risk" | "paused" | "completed" | "abandoned" | "archived";
export type Priority = "must" | "should" | "could";
export type Energy = "low" | "medium" | "high";
export type Repeat = "never" | "daily" | "weekly";
export type ReviewPeriod = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

export interface User {
  id: number;
  email: string;
  name: string;
  direction: string;
  /** users.timezone (IANA); null = UTC. */
  timezone: string | null;
  /** users.password_login_disabled: only Telegram can sign in to this account. */
  password_login_disabled: boolean;
  /** Created from Telegram with no email: `email` is "" and password sign-in is off from birth. */
  telegram_only?: boolean;
}

/** A streams row as the API returns it (docs/PRD-brain.md §6). */
export interface StreamRow {
  id: number;
  name: string;
  shape: Shape;
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
  aliases: string[];
  bare_value_capture: number;
  ask_at: string | null;
  ask_text: string | null;
  quick: number[];
  status: string;
}

/** The goal that judges a stream, when it has one. */
export interface TrackerGoal {
  id: number;
  title: string;
  kind: GoalKind;
  target: number;
  period: Period | null;
  deadline: string | null;
  start: number | null;
}

/** Everything worker/derive.ts can say about a tracker's goal. The model never computes any of it (§4 R2). */
export interface TrackerStatus {
  verdict: Verdict;
  progress: number | null;
  current: number | null;
  expected?: number | null;
  trend?: number | null;
  rate?: number | null;
  remaining?: number | null;
  projected_date?: string | null;
  period_start?: string;
  period_end?: string;
  days_left?: number;
}

/** One card on the generated dashboard — GET /api/tracks. */
export interface Tracker {
  stream: StreamRow;
  goal: TrackerGoal | null;
  status: TrackerStatus | null;
  today_total: number;
  latest: { at: string; num: number | null; text: string | null } | null;
  observations?: { at: string; num: number | null; text: string | null }[];
}

/** A telegram_accounts row: the Telegram identity linked to one Way account. */
export interface TelegramAccount {
  user_id: number;
  /** Telegram's from.id; UNIQUE, so one Telegram identity links to at most one Way account. */
  telegram_user_id: number;
  chat_id: number;
  username: string | null;
  first_name: string | null;
  /** 0/1: a Telegram sign-in has succeeded at least once. */
  verified_login: number;
  /** SQLite datetime(); nothing is sent before it. '9999-12-31 23:59:59' = the bot was blocked. */
  paused_until: string | null;
  created_at: string;
}

/** GET /api/security. */
export interface SecuritySettings {
  /** Telegram is linked and has been used to sign in at least once (telegram_accounts.verified_login = 1). */
  telegram_verified: boolean;
  /** users.password_login_disabled: POST /api/auth/login answers 403 for this account. */
  password_login_disabled: boolean;
}

/** telegram_prefs: local 'HH:MM' slots in the user's timezone; null = off. */
export interface TelegramPrefs {
  morning_at: string | null;
  review_at: string | null;
  /** Monday: last week's numbers, then the theme and three outcomes. */
  weekly_plan_at: string | null;
  /** Sunday: the weekly recap and review. */
  weekly_review_at: string | null;
  /** 1st of the month: rate the life areas. */
  checkin_at: string | null;
  quiet_from: string | null;
  quiet_to: string | null;
  /** 0/1: the midday nudge when the top three is still empty. */
  nudges: number;
  /** 0/1: a reminder 5 minutes before each time-blocked task. */
  block_reminders: number;
  /** 0/1: show streaks in the weekly recap. */
  streaks: number;
  /** The body prompts (PRD-body §6); null = off, and they only apply while a body plan exists. */
  weigh_at: string | null;
  breakfast_at: string | null;
  lunch_at: string | null;
  dinner_at: string | null;
  workout_at: string | null;
  /** The monthly body report on the 1st (PRD-body §13 item 11); null = off. */
  body_month_at: string | null;
  /** 0/1: the conditional body nudge at 12:00 (PRD-body §6.2). */
  body_nudges: number;
}

/** GET /api/telegram/stats — this account's delivery and engagement numbers (PRD §14). */
export interface TelegramStats {
  /** Days covered. */
  days: number;
  /** Per scheduled kind: sends, replies and the reply rate. */
  kinds: { kind: string; sent: number; replied: number; reply_rate: number | null }[];
  /** Days (in the window) with both a top three and a daily review. */
  loop_days: number;
  /** Inbox items captured from Telegram vs. created on the web. */
  captured: number;
  web_captured: number;
  blocked: number;
  rate_limited: number;
  errors: number;
}

/** GET /api/telegram. */
export interface TelegramSettings {
  linked: boolean;
  /** The linked Telegram @username, without the @. */
  username: string | null;
  /** The bot was blocked (paused_until far future): nothing is sent until a test message gets through. */
  disconnected: boolean;
  /** users.timezone (IANA); null = UTC. */
  timezone: string | null;
  /** The shared bot's @username, without the @; null when Telegram is not configured. */
  bot: string | null;
  /** A body plan is attached to a goal: the body slots and the nudge toggle apply (PRD-body §10). */
  body_plan: boolean;
  prefs: TelegramPrefs;
}

/** POST /api/telegram/link/start. */
export interface TelegramLinkStart {
  /** The 32-hex nonce; poll GET /api/telegram/link/status?code=… with it. */
  code: string;
  /** https://t.me/<bot>?start=link_<code> — opens the bot on this device. */
  url: string;
  /** What the QR code encodes (the same deep link), for scanning with a phone. */
  qr: string;
  /** Seconds until the nonce stops working. */
  expires_in: number;
}

/** GET /api/telegram/link/status. */
export type TelegramLinkStatus =
  | { state: "pending" }
  | { state: "linked"; username: string | null }
  /** The nonce was used, but that Telegram account is already linked to another Way account. */
  | { state: "refused" }
  /** Expired, replaced by a newer link, or not this user's nonce. */
  | { state: "expired" };

export interface Area {
  id: number;
  name: string;
  color: string;
  satisfaction: number | null;
  archived: number;
  sort: number;
}

export interface Goal {
  id: number;
  title: string;
  description: string;
  level: GoalLevel;
  type: GoalType;
  status: GoalStatus;
  area_id: number | null;
  parent_id: number | null;
  priority: Priority;
  start_date: string | null;
  target_date: string | null;
  progress: number;
  confidence: number | null;
  success_criteria: string;
  motivation: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  goal_id: number | null;
  status: "active" | "finished";
  progress?: number; // derived from tasks
  open_tasks?: number;
  done_tasks?: number;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  date: string | null;
  inbox: number;
  priority: Priority;
  energy: Energy | null;
  estimate_min: number | null;
  actual_min: number | null;
  start_min: number | null;
  end_min: number | null;
  goal_id: number | null;
  project_id: number | null;
  repeat: Repeat;
  notes: string;
  done: number;
  dropped: number;
}

export interface Day {
  date: string;
  intention: string;
  reflection: string;
  mood: number | null;
  energy: number | null;
  focus: number | null;
  satisfaction: number | null;
  top1: string; top1_done: number;
  top2: string; top2_done: number;
  top3: string; top3_done: number;
}

export interface WeeklyPlan {
  week_start: string;
  theme: string;
  outcome1: string;
  outcome2: string;
  outcome3: string;
  commitments: string;
  risks: string;
}

export interface Review {
  id: number;
  period: ReviewPeriod;
  period_start: string;
  answers: Record<string, string>;
  mood: number | null;
  energy: number | null;
  focus: number | null;
  satisfaction: number | null;
  created_at: string;
}

// ---------- Body (docs/PRD-body.md) ----------

export type WorkoutIntensity = "easy" | "moderate" | "hard";
export type MealKind = "breakfast" | "lunch" | "dinner" | "snack";
/** How the weight trend compares with the goal's target date (PRD-body §8.1). */
export type BodyVerdict = "ahead" | "on_track" | "behind" | "stalled" | "wrong_way" | "no_data";

/** body_plans: one per user, attached to the goal it serves. */
export interface BodyPlan {
  goal_id: number;
  /** The goal's title, so every client can name it without a second query. */
  goal_title: string;
  /** The goal's target_date; null = no deadline, so there is nothing to be ahead of. */
  target_date: string | null;
  metric: string;
  start_kg: number;
  target_kg: number;
  weekly_workouts: number;
  daily_kcal: number | null;
  /** kg|jin|lb — display and input parsing only; storage is always kg. */
  input_unit: string;
}

export interface WeightLog {
  date: string;
  kg: number;
  source: WeightSource;
  note: string;
}

export interface WorkoutLog {
  id: number;
  date: string;
  activity: string;
  minutes: number;
  intensity: WorkoutIntensity | null;
  note: string;
  task_id: number | null;
}

export interface MealLog {
  id: number;
  date: string;
  time_min: number | null;
  kind: MealKind;
  description: string;
  kcal: number | null;
  protein_g: number | null;
  user_edited: number;
  confidence: string | null;
}

/** The deterministic numbers behind a weight goal (PRD-body §8.1). No model touches these. */
export interface BodySummary {
  plan: BodyPlan;
  /** The local date the summary was computed for. */
  today: string;
  /** The latest weigh-in, whatever its date. */
  latest: WeightLog | null;
  /** 7-day moving average at `today`; null with fewer than two readings in the window. */
  trend: number | null;
  /** The same average a week earlier, for "↓0.3". */
  trend_prev: number | null;
  /** Least-squares slope of the trend over the last 28 days, per week; null with fewer than 7 readings. */
  rate_kg_per_week: number | null;
  /** Kilograms still to go, signed by the plan's direction; ≤ 0 = reached. */
  remaining_kg: number | null;
  /** When the trend reaches the target; null when it is flat or moving away. */
  projected_date: string | null;
  verdict: BodyVerdict;
  /** 0..100, what goals.progress becomes for this goal; null when start and target are equal. */
  progress: number | null;
  week: {
    workouts_done: number;
    workouts_target: number;
    minutes: number;
    /** Average kcal over the days that have a logged meal with calories; null when none do. */
    kcal_avg: number | null;
    meals_logged: number;
  };
}

/**
 * One calendar month of body logs (PRD-body §13 item 11), deterministic like BodySummary: the trend at
 * each end of the month, what was logged in it, and the week that moved most toward the target.
 */
export interface BodyMonthReport {
  /** YYYY-MM. */
  month: string;
  /** First and last day of the month that the report covers (the last is capped at today). */
  from: string;
  to: string;
  /** The 7-day trend at each end of the window; null when there were too few weigh-ins. */
  start_trend: number | null;
  end_trend: number | null;
  /** end_trend − start_trend; null when either is missing. */
  change_kg: number | null;
  /** The projected target date as it stood at each end of the window — the projection then vs now. */
  start_projected: string | null;
  end_projected: string | null;
  /** end_projected − start_projected in days; negative = the target moved closer. Null when either is missing. */
  projected_shift_days: number | null;
  weigh_ins: number;
  workouts: number;
  minutes: number;
  /** Average kcal over the days that have a logged meal with calories; null when none do. */
  kcal_avg: number | null;
  meals_logged: number;
  /** The month's best week: the one whose trend moved furthest toward the target. */
  best_week: { week_start: string; change_kg: number; workouts: number } | null;
}

/** A change the Guide proposes; applied only after the user approves. */
export type GuideProposal =
  | { kind: "create_goal"; title: string; level: GoalLevel; area?: string; parent_title?: string; target_date?: string; success_criteria?: string; description?: string }
  | { kind: "create_task"; title: string; date: string; estimate_min?: number; start?: string; goal_title?: string }
  | { kind: "set_top_three"; date: string; outcomes: string[] }
  | { kind: "set_weekly_plan"; week_start: string; theme?: string; outcomes: string[] }
  | { kind: "update_goal_progress"; goal_title: string; progress: number }
  | { kind: "create_review"; period: ReviewPeriod; period_start: string; answers: Record<string, string> }
  | { kind: "set_body_plan"; goal_title: string; start_kg: number; target_kg: number; weekly_workouts?: number; daily_kcal?: number | null }
  | { kind: "log_workout"; date: string; activity: string; minutes: number; intensity?: WorkoutIntensity; note?: string }
  | { kind: "log_weight"; date: string; kg: number; note?: string }
  /** Provision a tracker (docs/PRD-brain.md §12): a stream, and optionally the goal that judges it. */
  | {
      kind: "create_tracker";
      name: string;
      shape: Shape;
      unit?: string | null;
      /** The user's own words for it; the capture pattern is built from these, in code. */
      aliases?: string[];
      min_value?: number | null;
      max_value?: number | null;
      /** Local HH:MM to ask at, or null for a tracker the user logs unprompted. */
      ask_at?: string | null;
      ask_text?: string | null;
      /** One-tap answers on the ask, in the stream's base unit. */
      quick?: number[];
      goal?: { kind: GoalKind; target: number; period?: Period | null; title?: string; deadline?: string | null } | null;
    };

export interface GuideMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  proposals: GuideProposal[] | null;
  created_at: string;
}
