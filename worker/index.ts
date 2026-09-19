import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { hashPassword, verifyPassword, newSessionToken, sessionCookie, SESSION_COOKIE, SESSION_DAYS } from "./auth.ts";
import { chatComplete, extractProposals, type ChatMsg } from "./guide.ts";
import { carryOver, deleteTask, updateTask } from "./tasks.ts";
import { updateDay } from "./days.ts";
import { upsertReview, type ReviewInput } from "./reviews.ts";
import type { GoalLevel, GuideProposal, ReviewPeriod } from "../shared/types.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CHAT_MODEL?: string;
}

type Vars = { userId: number };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const DEFAULT_AREAS: [string, string][] = [
  ["Health", "#6b9080"],
  ["Family", "#c98a6d"],
  ["Career", "#5c7a99"],
  ["Wealth", "#b98a3c"],
  ["Learning", "#7d6b99"],
  ["Relationships", "#a86458"],
  ["Inner Growth", "#4d7048"],
  ["Lifestyle", "#c0a161"],
  ["Contribution", "#699099"],
];

const GOAL_LEVELS: GoalLevel[] = ["lifetime", "year", "quarter", "month", "week"];
const REVIEW_PERIODS: ReviewPeriod[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

// ---------- helpers ----------

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function assertDate(s: unknown): string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("bad date");
  return s;
}

/** Monday of the week containing date. */
function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return isoDate(d);
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

function periodRange(view: string, anchor: string): { start: string; end: string } {
  const d = new Date(anchor + "T00:00:00Z");
  const y = d.getUTCFullYear();
  if (view === "week") {
    const start = weekStartOf(anchor);
    return { start, end: addDays(start, 6) };
  }
  if (view === "month") {
    const start = `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const endD = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0));
    return { start, end: isoDate(endD) };
  }
  if (view === "quarter") {
    const q = Math.floor(d.getUTCMonth() / 3);
    const start = isoDate(new Date(Date.UTC(y, q * 3, 1)));
    const end = isoDate(new Date(Date.UTC(y, q * 3 + 3, 0)));
    return { start, end };
  }
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

// ---------- auth ----------

app.post("/api/auth/register", async (c) => {
  const { email, password, name } = await c.req.json<{ email: string; password: string; name?: string }>();
  if (!email?.includes("@") || !password || password.length < 8) {
    return c.json({ error: "Valid email and a password of at least 8 characters are required." }, 400);
  }
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email.toLowerCase()).first();
  if (exists) return c.json({ error: "An account with this email already exists." }, 409);

  const hash = await hashPassword(password);
  const user = await c.env.DB.prepare("INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?) RETURNING id")
    .bind(email.toLowerCase(), name?.trim() || email.split("@")[0], hash)
    .first<{ id: number }>();
  const userId = user!.id;

  const seed = DEFAULT_AREAS.map(([n, color], i) =>
    c.env.DB.prepare("INSERT INTO areas (user_id, name, color, sort) VALUES (?, ?, ?, ?)").bind(userId, n, color, i)
  );
  await c.env.DB.batch(seed);

  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, expires).run();
  c.header("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
  return c.json({ ok: true });
});

app.post("/api/auth/login", async (c) => {
  const { email, password } = await c.req.json<{ email: string; password: string }>();
  const user = await c.env.DB.prepare("SELECT id, password_hash FROM users WHERE email = ?")
    .bind((email ?? "").toLowerCase())
    .first<{ id: number; password_hash: string }>();
  if (!user || !(await verifyPassword(password ?? "", user.password_hash))) {
    return c.json({ error: "Email or password is incorrect." }, 401);
  }
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, user.id, expires).run();
  c.header("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
  return c.json({ ok: true });
});

app.post("/api/auth/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  c.header("Set-Cookie", sessionCookie("", 0));
  return c.json({ ok: true });
});

app.use("/api/*", async (c, next) => {
  if (c.req.path.startsWith("/api/auth/")) return next();
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const row = await c.env.DB.prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
      .bind(token)
      .first<{ user_id: number; expires_at: string }>();
    if (row && row.expires_at > new Date().toISOString()) {
      c.set("userId", row.user_id);
      return next();
    }
  }
  return c.json({ error: "unauthorized" }, 401);
});

app.get("/api/me", async (c) => {
  const user = await c.env.DB.prepare("SELECT id, email, name, direction FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first();
  return c.json({ user });
});

app.put("/api/me", async (c) => {
  const { name, direction } = await c.req.json<{ name?: string; direction?: string }>();
  if (name !== undefined)
    await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name.trim(), c.get("userId")).run();
  if (direction !== undefined)
    await c.env.DB.prepare("UPDATE users SET direction = ? WHERE id = ?").bind(direction.trim(), c.get("userId")).run();
  return c.json({ ok: true });
});

// ---------- day / tasks ----------

/** Materialize repeating tasks into concrete instances for one date. */
async function materializeRepeats(db: D1Database, userId: number, date: string) {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE user_id = ? AND repeat != 'never' AND repeat_src IS NULL AND dropped = 0
         AND date IS NOT NULL AND date <= ?`
    )
    .bind(userId, date)
    .all<Record<string, unknown>>();
  for (const t of results) {
    if (t.date === date) continue;
    const tDow = new Date((t.date as string) + "T00:00:00Z").getUTCDay();
    if (t.repeat === "weekly" && tDow !== dow) continue;
    const dup = await db
      .prepare("SELECT id FROM tasks WHERE user_id = ? AND repeat_src = ? AND date = ?")
      .bind(userId, t.id, date)
      .first();
    if (dup) continue;
    await db
      .prepare(
        `INSERT INTO tasks (user_id, title, description, date, priority, energy, estimate_min, start_min, end_min,
                            goal_id, project_id, repeat, repeat_src, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?, ?)`
      )
      .bind(userId, t.title, t.description, date, t.priority, t.energy, t.estimate_min, t.start_min, t.end_min,
            t.goal_id, t.project_id, t.id, t.notes)
      .run();
  }
}

app.get("/api/day", async (c) => {
  const userId = c.get("userId");
  const date = assertDate(c.req.query("date") ?? isoDate(new Date()));
  await materializeRepeats(c.env.DB, userId, date);

  const day =
    (await c.env.DB.prepare("SELECT * FROM days WHERE user_id = ? AND date = ?").bind(userId, date).first()) ?? {
      date, intention: "", reflection: "", mood: null, energy: null, focus: null, satisfaction: null,
      top1: "", top1_done: 0, top2: "", top2_done: 0, top3: "", top3_done: 0,
    };

  const tasks = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0 ORDER BY start_min IS NULL, start_min, id"
  ).bind(userId, date).all();

  const inbox = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE user_id = ? AND inbox = 1 AND done = 0 AND dropped = 0 ORDER BY id DESC"
  ).bind(userId).all();

  const carry = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM tasks WHERE user_id = ? AND inbox = 0 AND done = 0 AND dropped = 0 AND date < ? AND repeat = 'never'"
  ).bind(userId, date).first<{ n: number }>();

  const goals = await c.env.DB.prepare(
    "SELECT id, title, progress, target_date FROM goals WHERE user_id = ? AND status = 'active' AND parent_id IS NULL ORDER BY id"
  ).bind(userId).all();

  return c.json({ day: { ...day, date }, tasks: tasks.results, inbox: inbox.results, carryCount: carry?.n ?? 0, goals: goals.results });
});

app.put("/api/day/:date", async (c) => {
  const userId = c.get("userId");
  const date = assertDate(c.req.param("date"));
  await updateDay(c.env.DB, userId, date, await c.req.json<Record<string, unknown>>());
  return c.json({ ok: true });
});

app.post("/api/tasks", async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json<Record<string, unknown>>();
  if (!b.title || typeof b.title !== "string") return c.json({ error: "title required" }, 400);
  const row = await c.env.DB.prepare(
    `INSERT INTO tasks (user_id, title, description, date, inbox, priority, energy, estimate_min, start_min, end_min,
                        goal_id, project_id, repeat, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    userId, b.title, (b.description as string) ?? "", (b.date as string) ?? null, b.inbox ? 1 : 0,
    (b.priority as string) ?? "should", (b.energy as string) ?? null, (b.estimate_min as number) ?? null,
    (b.start_min as number) ?? null, (b.end_min as number) ?? null, (b.goal_id as number) ?? null,
    (b.project_id as number) ?? null, (b.repeat as string) ?? "never", (b.notes as string) ?? ""
  ).first();
  return c.json({ task: row });
});

app.put("/api/tasks/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  const row = await updateTask(c.env.DB, userId, id, b);
  return c.json({ task: row });
});

app.delete("/api/tasks/:id", async (c) => {
  await deleteTask(c.env.DB, c.get("userId"), Number(c.req.param("id")));
  return c.json({ ok: true });
});

app.post("/api/carry", async (c) => {
  const userId = c.get("userId");
  const { date, action } = await c.req.json<{ date: string; action: "forward" | "drop" }>();
  assertDate(date);
  await carryOver(c.env.DB, userId, date, action === "forward" ? "forward" : "drop");
  return c.json({ ok: true });
});

// ---------- goals & areas ----------

app.get("/api/goals", async (c) => {
  const userId = c.get("userId");
  const areas = await c.env.DB.prepare("SELECT * FROM areas WHERE user_id = ? AND archived = 0 ORDER BY sort, id").bind(userId).all();
  const goals = await c.env.DB.prepare("SELECT * FROM goals WHERE user_id = ? ORDER BY created_at DESC").bind(userId).all();
  return c.json({ areas: areas.results, goals: goals.results });
});

const GOAL_FIELDS = ["title", "description", "level", "type", "status", "area_id", "parent_id", "priority",
  "start_date", "target_date", "progress", "confidence", "success_criteria", "motivation"] as const;

app.post("/api/goals", async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json<Record<string, unknown>>();
  if (!b.title) return c.json({ error: "title required" }, 400);
  const row = await c.env.DB.prepare(
    `INSERT INTO goals (user_id, title, description, level, type, status, area_id, parent_id, priority,
                        start_date, target_date, progress, confidence, success_criteria, motivation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(
    userId, b.title, (b.description as string) ?? "", (b.level as string) ?? "year", (b.type as string) ?? "outcome",
    (b.status as string) ?? "active", (b.area_id as number) ?? null, (b.parent_id as number) ?? null,
    (b.priority as string) ?? "should", (b.start_date as string) ?? null, (b.target_date as string) ?? null,
    (b.progress as number) ?? 0, (b.confidence as number) ?? null, (b.success_criteria as string) ?? "",
    (b.motivation as string) ?? ""
  ).first();
  return c.json({ goal: row });
});

app.put("/api/goals/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  for (const f of GOAL_FIELDS) {
    if (f in b) {
      await c.env.DB.prepare(`UPDATE goals SET ${f} = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
        .bind(b[f], id, userId).run();
    }
  }
  const row = await c.env.DB.prepare("SELECT * FROM goals WHERE id = ? AND user_id = ?").bind(id, userId).first();
  return c.json({ goal: row });
});

app.delete("/api/goals/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE goals SET parent_id = NULL WHERE parent_id = ? AND user_id = ?").bind(id, userId),
    c.env.DB.prepare("UPDATE tasks SET goal_id = NULL WHERE goal_id = ? AND user_id = ?").bind(id, userId),
    c.env.DB.prepare("DELETE FROM goals WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
  return c.json({ ok: true });
});

app.post("/api/areas", async (c) => {
  const userId = c.get("userId");
  const { name, color } = await c.req.json<{ name: string; color?: string }>();
  if (!name?.trim()) return c.json({ error: "name required" }, 400);
  const row = await c.env.DB.prepare(
    "INSERT INTO areas (user_id, name, color, sort) VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort)+1,0) FROM areas WHERE user_id = ?)) RETURNING *"
  ).bind(userId, name.trim(), color ?? "#6b9080", userId).first();
  return c.json({ area: row });
});

app.put("/api/areas/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  for (const f of ["name", "color", "satisfaction", "archived"] as const) {
    if (f in b) {
      await c.env.DB.prepare(`UPDATE areas SET ${f} = ? WHERE id = ? AND user_id = ?`).bind(b[f], id, userId).run();
    }
  }
  return c.json({ ok: true });
});

// ---------- projects ----------

app.get("/api/projects", async (c) => {
  const userId = c.get("userId");
  const { results } = await c.env.DB.prepare(
    `SELECT p.*,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.done = 1) AS done_tasks,
            (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id AND t.dropped = 0) AS total_tasks
     FROM projects p WHERE p.user_id = ? ORDER BY p.created_at DESC`
  ).bind(userId).all<Record<string, number>>();
  const projects = results.map((p) => ({
    ...p,
    progress: p.total_tasks ? Math.round((p.done_tasks / p.total_tasks) * 100) : 0,
  }));
  return c.json({ projects });
});

app.post("/api/projects", async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json<Record<string, unknown>>();
  if (!b.name) return c.json({ error: "name required" }, 400);
  const row = await c.env.DB.prepare(
    "INSERT INTO projects (user_id, name, description, goal_id) VALUES (?, ?, ?, ?) RETURNING *"
  ).bind(userId, b.name, (b.description as string) ?? "", (b.goal_id as number) ?? null).first();
  return c.json({ project: row });
});

app.put("/api/projects/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  const b = await c.req.json<Record<string, unknown>>();
  for (const f of ["name", "description", "goal_id", "status"] as const) {
    if (f in b) {
      await c.env.DB.prepare(`UPDATE projects SET ${f} = ? WHERE id = ? AND user_id = ?`).bind(b[f], id, userId).run();
    }
  }
  return c.json({ ok: true });
});

app.delete("/api/projects/:id", async (c) => {
  const userId = c.get("userId");
  const id = Number(c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ? AND user_id = ?").bind(id, userId),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ? AND user_id = ?").bind(id, userId),
  ]);
  return c.json({ ok: true });
});

app.get("/api/projects/:id/tasks", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM tasks WHERE project_id = ? AND user_id = ? AND dropped = 0 ORDER BY done, date IS NULL, date, id"
  ).bind(Number(c.req.param("id")), c.get("userId")).all();
  return c.json({ tasks: results });
});

// ---------- timeline ----------

app.get("/api/timeline", async (c) => {
  const userId = c.get("userId");
  const view = c.req.query("view") ?? "week";
  const anchor = assertDate(c.req.query("anchor") ?? isoDate(new Date()));
  const { start, end } = periodRange(view, anchor);

  const stats = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM goals WHERE user_id = ?1 AND status != 'archived'
          AND (start_date IS NULL OR start_date <= ?3) AND (target_date IS NULL OR target_date >= ?2)) AS goals_in_period,
       (SELECT COUNT(*) FROM goals WHERE user_id = ?1 AND status = 'completed'
          AND updated_at >= ?2 AND updated_at <= ?3 || 'T23:59:59') AS goals_completed,
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 0 AND dropped = 0 AND date BETWEEN ?2 AND ?3) AS tasks_scheduled,
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 0 AND done = 1 AND date BETWEEN ?2 AND ?3) AS tasks_completed`
  ).bind(userId, start, end).first();

  if (view === "week") {
    const plan = await c.env.DB.prepare("SELECT * FROM weekly_plans WHERE user_id = ? AND week_start = ?")
      .bind(userId, start).first();
    const { results: tasks } = await c.env.DB.prepare(
      "SELECT id, title, date, done, start_min FROM tasks WHERE user_id = ? AND inbox = 0 AND dropped = 0 AND date BETWEEN ? AND ? ORDER BY date, start_min IS NULL, start_min"
    ).bind(userId, start, end).all();
    return c.json({ view, start, end, stats, plan, tasks });
  }

  const { results: goals } = await c.env.DB.prepare(
    `SELECT g.*, a.name AS area_name, a.color AS area_color FROM goals g
     LEFT JOIN areas a ON a.id = g.area_id
     WHERE g.user_id = ? AND g.status NOT IN ('archived','abandoned','draft')
       AND (g.start_date IS NULL OR g.start_date <= ?) AND (g.target_date IS NULL OR g.target_date >= ?)
     ORDER BY a.sort, g.target_date`
  ).bind(userId, end, start).all();
  return c.json({ view, start, end, stats, goals });
});

app.put("/api/weekly-plan/:weekStart", async (c) => {
  const userId = c.get("userId");
  const weekStart = assertDate(c.req.param("weekStart"));
  const b = await c.req.json<Record<string, string>>();
  await c.env.DB.prepare(
    `INSERT INTO weekly_plans (user_id, week_start, theme, outcome1, outcome2, outcome3, commitments, risks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, week_start) DO UPDATE SET
       theme = excluded.theme, outcome1 = excluded.outcome1, outcome2 = excluded.outcome2,
       outcome3 = excluded.outcome3, commitments = excluded.commitments, risks = excluded.risks`
  ).bind(userId, weekStart, b.theme ?? "", b.outcome1 ?? "", b.outcome2 ?? "", b.outcome3 ?? "", b.commitments ?? "", b.risks ?? "").run();
  return c.json({ ok: true });
});

// ---------- reviews ----------

function reviewPeriodStart(period: string, todayStr: string): string {
  const d = new Date(todayStr + "T00:00:00Z");
  const y = d.getUTCFullYear();
  switch (period) {
    case "daily": return todayStr;
    case "weekly": return weekStartOf(todayStr);
    case "monthly": return `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    case "quarterly": return isoDate(new Date(Date.UTC(y, Math.floor(d.getUTCMonth() / 3) * 3, 1)));
    default: return `${y}-01-01`;
  }
}

function reviewPeriodEnd(period: string, startStr: string): string {
  const d = new Date(startStr + "T00:00:00Z");
  switch (period) {
    case "daily": return startStr;
    case "weekly": return addDays(startStr, 6);
    case "monthly": return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    case "quarterly": return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0)));
    default: return `${d.getUTCFullYear()}-12-31`;
  }
}

app.get("/api/reviews", async (c) => {
  const userId = c.get("userId");
  const period = c.req.query("period") ?? "weekly";
  const today = isoDate(new Date());
  const start = reviewPeriodStart(period, today);
  const end = reviewPeriodEnd(period, start);

  const stats = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 0 AND dropped = 0 AND date BETWEEN ?2 AND ?3) AS tasks_planned,
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 0 AND done = 1 AND date BETWEEN ?2 AND ?3) AS tasks_done,
       (SELECT COALESCE(SUM(carried),0) FROM tasks WHERE user_id = ?1 AND date BETWEEN ?2 AND ?3) AS rescheduled,
       (SELECT COUNT(*) FROM goals WHERE user_id = ?1 AND status = 'completed' AND updated_at BETWEEN ?2 AND ?3 || 'T23:59:59') AS goals_completed`
  ).bind(userId, start, end).first();

  const current = await c.env.DB.prepare(
    "SELECT * FROM reviews WHERE user_id = ? AND period = ? AND period_start = ?"
  ).bind(userId, period, start).first();

  const { results: past } = await c.env.DB.prepare(
    "SELECT * FROM reviews WHERE user_id = ? AND period = ? AND period_start != ? ORDER BY period_start DESC LIMIT 20"
  ).bind(userId, period, start).all();

  return c.json({ period, start, end, stats, current, past });
});

app.put("/api/reviews", async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json<ReviewInput>();
  assertDate(b.period_start);
  await upsertReview(c.env.DB, userId, b);
  return c.json({ ok: true });
});

// ---------- insights ----------

app.get("/api/insights", async (c) => {
  const userId = c.get("userId");
  const today = isoDate(new Date());
  const d28 = addDays(today, -28);
  const d14 = addDays(today, -14);

  const totals = await c.env.DB.prepare(
    `SELECT
       (SELECT COALESCE(SUM(COALESCE(actual_min, estimate_min, 0)),0) FROM tasks
          WHERE user_id = ?1 AND done = 1 AND date >= ?2) AS focus_min,
       (SELECT COALESCE(SUM(actual_min),0) FROM tasks WHERE user_id = ?1 AND done = 1 AND date >= ?2) AS recorded_min,
       (SELECT COUNT(DISTINCT date) FROM tasks WHERE user_id = ?1 AND done = 1 AND date >= ?3) AS active_days,
       (SELECT COALESCE(SUM(carried),0) FROM tasks WHERE user_id = ?1) AS rescheduled`
  ).bind(userId, d28, d14).first();

  const { results: weekly } = await c.env.DB.prepare(
    `SELECT date, done FROM tasks WHERE user_id = ? AND inbox = 0 AND dropped = 0 AND date >= ?`
  ).bind(userId, d28).all<{ date: string; done: number }>();
  const weekMap = new Map<string, { done: number; total: number }>();
  for (const t of weekly) {
    const ws = weekStartOf(t.date);
    const w = weekMap.get(ws) ?? { done: 0, total: 0 };
    w.total++;
    if (t.done) w.done++;
    weekMap.set(ws, w);
  }
  const weeklyCompletion = [...weekMap.entries()].sort().map(([week, v]) => ({ week, ...v }));

  const { results: byArea } = await c.env.DB.prepare(
    `SELECT a.name, a.color, COALESCE(SUM(COALESCE(t.actual_min, t.estimate_min, 0)),0) AS minutes
     FROM tasks t JOIN goals g ON g.id = t.goal_id JOIN areas a ON a.id = g.area_id
     WHERE t.user_id = ? AND t.done = 1 AND t.date >= ?
     GROUP BY a.id ORDER BY minutes DESC`
  ).bind(userId, d28).all();

  const { results: moods } = await c.env.DB.prepare(
    "SELECT date, mood, energy FROM days WHERE user_id = ? AND date >= ? AND (mood IS NOT NULL OR energy IS NOT NULL) ORDER BY date"
  ).bind(userId, d14).all();

  const planned = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(estimate_min),0) AS est, COALESCE(SUM(actual_min),0) AS act
     FROM tasks WHERE user_id = ? AND done = 1 AND estimate_min IS NOT NULL AND actual_min IS NOT NULL AND date >= ?`
  ).bind(userId, d28).first();

  const { results: goals } = await c.env.DB.prepare(
    "SELECT id, title, progress FROM goals WHERE user_id = ? AND status = 'active' ORDER BY id"
  ).bind(userId).all();

  return c.json({ totals, weeklyCompletion, byArea, moods, planned, goals });
});

// ---------- guide ----------

async function guideContext(db: D1Database, userId: number): Promise<string> {
  const today = isoDate(new Date());
  const user = await db.prepare("SELECT name, direction FROM users WHERE id = ?").bind(userId).first<{ name: string; direction: string }>();
  const { results: areas } = await db.prepare("SELECT name, satisfaction FROM areas WHERE user_id = ? AND archived = 0 ORDER BY sort").bind(userId).all<{ name: string; satisfaction: number | null }>();
  const { results: goals } = await db.prepare(
    `SELECT g.title, g.level, g.status, g.progress, g.target_date, a.name AS area
     FROM goals g LEFT JOIN areas a ON a.id = g.area_id
     WHERE g.user_id = ? AND g.status IN ('active','at_risk') ORDER BY g.level, g.id`
  ).bind(userId).all<Record<string, unknown>>();
  const { results: tasks } = await db.prepare(
    "SELECT title, done, start_min, estimate_min FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0"
  ).bind(userId, today).all<Record<string, unknown>>();
  const day = await db.prepare("SELECT intention, top1, top2, top3 FROM days WHERE user_id = ? AND date = ?")
    .bind(userId, today).first<Record<string, string>>();
  const plan = await db.prepare("SELECT theme, outcome1, outcome2, outcome3 FROM weekly_plans WHERE user_id = ? AND week_start = ?")
    .bind(userId, weekStartOf(today)).first<Record<string, string>>();

  const lines = [
    `Today: ${today}`,
    `User: ${user?.name ?? ""}`,
    `Direction: ${user?.direction || "(not set)"}`,
    `Life areas: ${areas.map((a) => a.name + (a.satisfaction ? ` (${a.satisfaction}/10)` : "")).join(", ")}`,
    `Active goals:`,
    ...goals.map((g) => `  - [${g.level}] ${g.title} (${g.progress}%${g.target_date ? `, due ${g.target_date}` : ""}${g.area ? `, ${g.area}` : ""})`),
    `This week's plan: ${plan ? `${plan.theme || "(no theme)"} — ${[plan.outcome1, plan.outcome2, plan.outcome3].filter(Boolean).join("; ")}` : "(none)"}`,
    `Today's intention: ${day?.intention || "(none)"}`,
    `Today's top three: ${day ? [day.top1, day.top2, day.top3].filter(Boolean).join("; ") || "(empty)" : "(empty)"}`,
    `Today's tasks: ${tasks.length ? tasks.map((t) => `${t.title}${t.done ? " ✓" : ""}`).join("; ") : "(none)"}`,
  ];
  return lines.join("\n");
}

app.get("/api/guide", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM guide_messages WHERE user_id = ? ORDER BY id DESC LIMIT 40"
  ).bind(c.get("userId")).all<Record<string, unknown>>();
  const messages = results.reverse().map((m) => ({ ...m, proposals: m.proposals ? JSON.parse(m.proposals as string) : null }));
  return c.json({ messages });
});

app.post("/api/guide/chat", async (c) => {
  const userId = c.get("userId");
  const { message } = await c.req.json<{ message: string }>();
  if (!message?.trim()) return c.json({ error: "empty message" }, 400);

  await c.env.DB.prepare("INSERT INTO guide_messages (user_id, role, content) VALUES (?, 'user', ?)").bind(userId, message.trim()).run();

  const { results: recent } = await c.env.DB.prepare(
    "SELECT role, content FROM guide_messages WHERE user_id = ? ORDER BY id DESC LIMIT 12"
  ).bind(userId).all<{ role: "user" | "assistant"; content: string }>();
  const history: ChatMsg[] = recent.reverse().map((m) => ({ role: m.role, content: m.content }));

  const context = await guideContext(c.env.DB, userId);
  let reply: string;
  try {
    reply = await chatComplete(c.env, context, history);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Guide is unavailable right now." }, 502);
  }
  const { text, proposals } = extractProposals(reply);

  const saved = await c.env.DB.prepare(
    "INSERT INTO guide_messages (user_id, role, content, proposals) VALUES (?, 'assistant', ?, ?) RETURNING id, created_at"
  ).bind(userId, text, proposals.length ? JSON.stringify(proposals) : null).first();

  return c.json({ message: { id: (saved as { id: number }).id, role: "assistant", content: text, proposals: proposals.length ? proposals : null } });
});

app.post("/api/guide/apply", async (c) => {
  const userId = c.get("userId");
  const { proposal } = await c.req.json<{ proposal: GuideProposal }>();
  const db = c.env.DB;
  const isDate = (s: unknown) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

  if (proposal.kind === "create_goal") {
    if (proposal.level !== undefined && !GOAL_LEVELS.includes(proposal.level)) {
      return c.json({ error: `unknown goal level "${proposal.level}"` }, 400);
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
    ).bind(userId, proposal.title, proposal.level ?? "quarter", areaId, parentId, proposal.target_date ?? null,
           proposal.success_criteria ?? "", proposal.description ?? "").run();
    return c.json({ ok: true, applied: "goal" });
  }

  if (proposal.kind === "create_task") {
    let goalId: number | null = null;
    if (proposal.goal_title) {
      const g = await db.prepare("SELECT id FROM goals WHERE user_id = ? AND title = ?").bind(userId, proposal.goal_title).first<{ id: number }>();
      goalId = g?.id ?? null;
    }
    let startMin: number | null = null;
    let endMin: number | null = null;
    if (proposal.start && /^\d{2}:\d{2}$/.test(proposal.start)) {
      const [h, m] = proposal.start.split(":").map(Number);
      startMin = h * 60 + m;
      endMin = startMin + (proposal.estimate_min ?? 45);
    }
    await db.prepare(
      "INSERT INTO tasks (user_id, title, date, estimate_min, start_min, end_min, goal_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).bind(userId, proposal.title, assertDate(proposal.date), proposal.estimate_min ?? null, startMin, endMin, goalId).run();
    return c.json({ ok: true, applied: "task" });
  }

  if (proposal.kind === "set_top_three") {
    const date = assertDate(proposal.date);
    const [t1, t2, t3] = [...proposal.outcomes, "", "", ""].slice(0, 3);
    await db.prepare(
      `INSERT INTO days (user_id, date, top1, top2, top3) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, date) DO UPDATE SET top1 = excluded.top1, top2 = excluded.top2, top3 = excluded.top3`
    ).bind(userId, date, t1, t2, t3).run();
    return c.json({ ok: true, applied: "top_three" });
  }

  if (proposal.kind === "set_weekly_plan") {
    if (!isDate(proposal.week_start)) return c.json({ error: "bad week_start date" }, 400);
    if (!Array.isArray(proposal.outcomes)) return c.json({ error: "outcomes must be a list" }, 400);
    const weekStart = weekStartOf(proposal.week_start);
    const [o1, o2, o3] = [...proposal.outcomes, "", "", ""].slice(0, 3).map(String);
    // Commitments and risks are left as the user wrote them.
    await db.prepare(
      `INSERT INTO weekly_plans (user_id, week_start, theme, outcome1, outcome2, outcome3) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, week_start) DO UPDATE SET
         theme = excluded.theme, outcome1 = excluded.outcome1, outcome2 = excluded.outcome2, outcome3 = excluded.outcome3`
    ).bind(userId, weekStart, String(proposal.theme ?? ""), o1, o2, o3).run();
    return c.json({ ok: true, applied: "weekly_plan" });
  }

  if (proposal.kind === "update_goal_progress") {
    const progress = Number(proposal.progress);
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      return c.json({ error: "progress must be a number from 0 to 100" }, 400);
    }
    const g = typeof proposal.goal_title === "string"
      ? await db.prepare("SELECT id FROM goals WHERE user_id = ? AND title = ?").bind(userId, proposal.goal_title).first<{ id: number }>()
      : null;
    if (!g) return c.json({ error: `no goal titled "${proposal.goal_title}"` }, 404);
    await db.prepare("UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
      .bind(Math.round(progress), g.id, userId).run();
    return c.json({ ok: true, applied: "goal_progress" });
  }

  if (proposal.kind === "create_review") {
    if (!REVIEW_PERIODS.includes(proposal.period)) return c.json({ error: `unknown review period "${proposal.period}"` }, 400);
    if (!isDate(proposal.period_start)) return c.json({ error: "bad period_start date" }, 400);
    const answers = proposal.answers;
    if (!answers || typeof answers !== "object" || Array.isArray(answers)) return c.json({ error: "answers must be an object" }, 400);
    const periodStart = reviewPeriodStart(proposal.period, proposal.period_start);
    // Merge into an existing review so answers the user already wrote survive.
    await db.prepare(
      `INSERT INTO reviews (user_id, period, period_start, answers) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, period, period_start) DO UPDATE SET answers = json_patch(reviews.answers, excluded.answers)`
    ).bind(userId, proposal.period, periodStart,
           JSON.stringify(Object.fromEntries(Object.entries(answers).map(([q, a]) => [q, String(a ?? "")])))).run();
    return c.json({ ok: true, applied: "review" });
  }

  return c.json({ error: "unknown proposal kind" }, 400);
});

// ---------- fallback ----------

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
