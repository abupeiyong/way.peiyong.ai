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
}

/** GET /api/security. */
export interface SecuritySettings {
  /** Telegram is linked and has been used to sign in at least once (telegram_accounts.verified_login = 1). */
  telegram_verified: boolean;
  /** users.password_login_disabled: POST /api/auth/login answers 403 for this account. */
  password_login_disabled: boolean;
}

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

/** A change the Guide proposes; applied only after the user approves. */
export type GuideProposal =
  | { kind: "create_goal"; title: string; level: GoalLevel; area?: string; parent_title?: string; target_date?: string; success_criteria?: string; description?: string }
  | { kind: "create_task"; title: string; date: string; estimate_min?: number; start?: string; goal_title?: string }
  | { kind: "set_top_three"; date: string; outcomes: string[] }
  | { kind: "set_weekly_plan"; week_start: string; theme?: string; outcomes: string[] }
  | { kind: "update_goal_progress"; goal_title: string; progress: number }
  | { kind: "create_review"; period: ReviewPeriod; period_start: string; answers: Record<string, string> };

export interface GuideMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  proposals: GuideProposal[] | null;
  created_at: string;
}
