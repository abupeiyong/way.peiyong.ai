// Applying an approved Guide proposal — shared by POST /api/guide/apply and the Telegram [✓ Approve] button,
// so a tap and a click write the same rows. Nothing here runs without the user's approval.

import type { GoalLevel, GuideProposal, ReviewPeriod, WorkoutIntensity } from "../shared/types.ts";
import { KG_RANGE } from "../shared/body.ts";
import { refreshBodyGoalProgress } from "./body.ts";
import { reviewPeriodStart, weekStartOf } from "./dates.ts";
import { userToday } from "./telegram/time.ts";

const GOAL_LEVELS: GoalLevel[] = ["lifetime", "year", "quarter", "month", "week"];
const REVIEW_PERIODS: ReviewPeriod[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

export type ApplyResult =
  | { ok: true; applied: string }
  /** 400 = the proposal itself is malformed; 404 = it names something the user does not have. */
  | { ok: false; status: 400 | 404; error: string };

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

const INTENSITIES: WorkoutIntensity[] = ["easy", "moderate", "hard"];

/** The Telegram slots the body prompts use, filled from the defaults when a plan is created (PRD-body §4.3, §6). */
const BODY_PREF_DEFAULTS: [string, string][] = [
  ["weigh_at", "07:00"], ["breakfast_at", "08:30"], ["lunch_at", "13:00"], ["dinner_at", "19:30"], ["workout_at", "20:30"],
];

/** Today in the user's timezone — the date a body summary is computed for (users.timezone; NULL = UTC). */
async function todayOf(db: D1Database, userId: number): Promise<string> {
  // SELECT * for the same reason as guideContext: it works whatever columns users has.
  const u = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId).first<{ timezone?: string | null }>();
  return userToday(u?.timezone);
}

/** A goal of this user by title: exact first, then case-insensitively. */
async function findGoalByTitle(db: D1Database, userId: number, title: unknown): Promise<{ id: number } | null> {
  if (typeof title !== "string" || !title.trim()) return null;
  return (await db.prepare("SELECT id FROM goals WHERE user_id = ? AND title = ?").bind(userId, title).first<{ id: number }>())
    ?? (await db.prepare("SELECT id FROM goals WHERE user_id = ? AND lower(title) = lower(?) ORDER BY id LIMIT 1")
      .bind(userId, title.trim()).first<{ id: number }>());
}

export async function applyProposal(db: D1Database, userId: number, proposal: GuideProposal): Promise<ApplyResult> {
  if (!proposal || typeof proposal !== "object") return { ok: false, status: 400, error: "proposal must be an object" };

  if (proposal.kind === "create_goal") {
    if (typeof proposal.title !== "string" || !proposal.title.trim()) return { ok: false, status: 400, error: "title required" };
    if (proposal.level !== undefined && !GOAL_LEVELS.includes(proposal.level)) {
      return { ok: false, status: 400, error: `unknown goal level "${proposal.level}"` };
    }
    let areaId: number | null = null;
    if (proposal.area) {
      const a = await db.prepare("SELECT id FROM areas WHERE user_id = ? AND name = ? AND archived = 0").bind(userId, proposal.area).first<{ id: number }>();
      areaId = a?.id ?? null;
    }
    let parentId: number | null = null;
    if (proposal.parent_title) {
      const p = await db.prepare("SELECT id FROM goals WHERE user_id = ? AND title = ?").bind(userId, proposal.parent_title).first<{ id: number }>();
      parentId = p?.id ?? null;
    }
    await db.prepare(
      "INSERT INTO goals (user_id, title, level, area_id, parent_id, target_date, success_criteria, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, proposal.title, proposal.level ?? "quarter", areaId, parentId,
           isDate(proposal.target_date) ? proposal.target_date : null,
           String(proposal.success_criteria ?? ""), String(proposal.description ?? "")).run();
    return { ok: true, applied: "goal" };
  }

  if (proposal.kind === "create_task") {
    if (typeof proposal.title !== "string" || !proposal.title.trim()) return { ok: false, status: 400, error: "title required" };
    if (!isDate(proposal.date)) return { ok: false, status: 400, error: "bad date" };
    let goalId: number | null = null;
    if (proposal.goal_title) {
      const g = await db.prepare("SELECT id FROM goals WHERE user_id = ? AND title = ?").bind(userId, proposal.goal_title).first<{ id: number }>();
      goalId = g?.id ?? null;
    }
    const estimate = Number.isFinite(Number(proposal.estimate_min)) && Number(proposal.estimate_min) > 0
      ? Math.round(Number(proposal.estimate_min)) : null;
    let startMin: number | null = null;
    let endMin: number | null = null;
    if (typeof proposal.start === "string" && /^\d{2}:\d{2}$/.test(proposal.start)) {
      const [h, m] = proposal.start.split(":").map(Number);
      startMin = h * 60 + m;
      endMin = startMin + (estimate ?? 45);
    }
    await db.prepare(
      "INSERT INTO tasks (user_id, title, date, estimate_min, start_min, end_min, goal_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, proposal.title, proposal.date, estimate, startMin, endMin, goalId).run();
    return { ok: true, applied: "task" };
  }

  if (proposal.kind === "set_top_three") {
    if (!isDate(proposal.date)) return { ok: false, status: 400, error: "bad date" };
    if (!Array.isArray(proposal.outcomes)) return { ok: false, status: 400, error: "outcomes must be a list" };
    const [t1, t2, t3] = [...proposal.outcomes.map((o) => String(o ?? "").trim()), "", "", ""].slice(0, 3);
    await db.prepare(
      `INSERT INTO days (user_id, date, top1, top2, top3) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET top1 = excluded.top1, top2 = excluded.top2, top3 = excluded.top3`
    ).bind(userId, proposal.date, t1, t2, t3).run();
    return { ok: true, applied: "top_three" };
  }

  if (proposal.kind === "set_weekly_plan") {
    if (!isDate(proposal.week_start)) return { ok: false, status: 400, error: "bad week_start date" };
    if (!Array.isArray(proposal.outcomes)) return { ok: false, status: 400, error: "outcomes must be a list" };
    const weekStart = weekStartOf(proposal.week_start);
    const [o1, o2, o3] = [...proposal.outcomes, "", "", ""].slice(0, 3).map((o) => String(o ?? ""));
    // Commitments and risks are left as the user wrote them.
    await db.prepare(
      `INSERT INTO weekly_plans (user_id, week_start, theme, outcome1, outcome2, outcome3) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, week_start) DO UPDATE SET
         theme = excluded.theme, outcome1 = excluded.outcome1, outcome2 = excluded.outcome2, outcome3 = excluded.outcome3`
    ).bind(userId, weekStart, String(proposal.theme ?? ""), o1, o2, o3).run();
    return { ok: true, applied: "weekly_plan" };
  }

  if (proposal.kind === "update_goal_progress") {
    const progress = Number(proposal.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      return { ok: false, status: 400, error: "progress must be a number from 0 to 100" };
    }
    const g = typeof proposal.goal_title === "string"
      ? await db.prepare("SELECT id FROM goals WHERE user_id = ? AND title = ?").bind(userId, proposal.goal_title).first<{ id: number }>()
      : null;
    if (!g) return { ok: false, status: 404, error: `no goal titled "${proposal.goal_title}"` };
    await db.prepare("UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .bind(Math.round(progress), g.id, userId).run();
    return { ok: true, applied: "goal_progress" };
  }

  if (proposal.kind === "create_review") {
    if (!REVIEW_PERIODS.includes(proposal.period)) return { ok: false, status: 400, error: `unknown review period "${proposal.period}"` };
    if (!isDate(proposal.period_start)) return { ok: false, status: 400, error: "bad period_start date" };
    const answers = proposal.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return { ok: false, status: 400, error: "answers must be an object" };
    const periodStart = reviewPeriodStart(proposal.period, proposal.period_start);
    // Merge into an existing review so answers the user already wrote survive.
    await db.prepare(
      `INSERT INTO reviews (user_id, period, period_start, answers) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, period, period_start) DO UPDATE SET answers = json_patch(reviews.answers, excluded.answers)`
    ).bind(userId, proposal.period, periodStart,
           JSON.stringify(Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, String(a ?? "")])))).run();
    return { ok: true, applied: "review" };
  }

  // ---------- body (PRD-body §9); meals are never proposed ----------

  if (proposal.kind === "set_body_plan") {
    const goal = await findGoalByTitle(db, userId, proposal.goal_title);
    if (!goal) return { ok: false, status: 404, error: `no goal titled "${proposal.goal_title}"` };
    const start = Number(proposal.start_kg);
    const target = Number(proposal.target_kg);
    for (const [name, v] of [["start_kg", start], ["target_kg", target]] as const) {
      if (!Number.isFinite(v) || v < KG_RANGE[0] || v > KG_RANGE[1]) {
        return { ok: false, status: 400, error: `${name} must be a weight in kg from ${KG_RANGE[0]} to ${KG_RANGE[1]}` };
      }
    }
    if (start === target) return { ok: false, status: 400, error: "start_kg and target_kg must differ" };
    const workouts = proposal.weekly_workouts === undefined ? 3 : Math.round(Number(proposal.weekly_workouts));
    if (!Number.isFinite(workouts) || workouts < 0 || workouts > 14) {
      return { ok: false, status: 400, error: "weekly_workouts must be from 0 to 14" };
    }
    let kcal: number | null = null;
    if (proposal.daily_kcal !== undefined && proposal.daily_kcal !== null) {
      kcal = Math.round(Number(proposal.daily_kcal));
      if (!Number.isFinite(kcal) || kcal < 800 || kcal > 6000) {
        return { ok: false, status: 400, error: "daily_kcal must be from 800 to 6000, or omitted" };
      }
    }
    // One plan per user: attaching it to another goal replaces the old one, as the Goals page does.
    await db.prepare(
      `INSERT INTO body_plans (user_id, goal_id, start_kg, target_kg, weekly_workouts, daily_kcal) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         goal_id = excluded.goal_id, start_kg = excluded.start_kg, target_kg = excluded.target_kg,
         weekly_workouts = excluded.weekly_workouts, daily_kcal = excluded.daily_kcal, updated_at = datetime('now')`
    ).bind(userId, goal.id, start, target, workouts, kcal).run();
    await db.prepare("INSERT OR IGNORE INTO telegram_prefs (user_id) VALUES (?)").bind(userId).run();
    for (const [field, value] of BODY_PREF_DEFAULTS) {
      await db.prepare(`UPDATE telegram_prefs SET ${field} = COALESCE(${field}, ?) WHERE user_id = ?`).bind(value, userId).run();
    }
    await refreshBodyGoalProgress(db, userId, await todayOf(db, userId));
    return { ok: true, applied: "body_plan" };
  }

  if (proposal.kind === "log_weight") {
    if (!isDate(proposal.date)) return { ok: false, status: 400, error: "bad date" };
    const value = Number(proposal.kg);
    if (!Number.isFinite(value) || value < KG_RANGE[0] || value > KG_RANGE[1]) {
      return { ok: false, status: 400, error: `kg must be a weight from ${KG_RANGE[0]} to ${KG_RANGE[1]}` };
    }
    const kg = Math.round(value * 10) / 10;
    // One reading per local date (PRD-body §3): the latest wins.
    await db.prepare(
      `INSERT INTO weight_logs (user_id, date, kg, source, note) VALUES (?, ?, ?, 'guide', ?)
       ON CONFLICT (user_id, date) DO UPDATE SET kg = excluded.kg, source = excluded.source, note = excluded.note`
    ).bind(userId, proposal.date, kg, String(proposal.note ?? "")).run();
    // goals.progress is derived for a goal with a body plan (PRD-body §4.3).
    await refreshBodyGoalProgress(db, userId, await todayOf(db, userId));
    return { ok: true, applied: "weight" };
  }

  if (proposal.kind === "log_workout") {
    if (!isDate(proposal.date)) return { ok: false, status: 400, error: "bad date" };
    const activity = typeof proposal.activity === "string" ? proposal.activity.trim().toLowerCase() : "";
    if (!activity) return { ok: false, status: 400, error: "activity required" };
    const minutes = Math.round(Number(proposal.minutes));
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 600) {
      return { ok: false, status: 400, error: "minutes must be from 1 to 600" };
    }
    if (proposal.intensity !== undefined && !INTENSITIES.includes(proposal.intensity)) {
      return { ok: false, status: 400, error: `unknown intensity "${proposal.intensity}"` };
    }
    await db.prepare(
      "INSERT INTO workout_logs (user_id, date, activity, minutes, intensity, note) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(userId, proposal.date, activity.slice(0, 60), minutes, proposal.intensity ?? null, String(proposal.note ?? "")).run();
    return { ok: true, applied: "workout" };
  }

  return { ok: false, status: 400, error: "unknown proposal kind" };
}
