import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  hashPassword, verifyPassword, newSessionToken, sessionCookie, pendingCookie, underLimit,
  PENDING_COOKIE, SESSION_COOKIE, SESSION_DAYS,
} from "./auth.ts";
import { guideChat } from "./guide.ts";
import { carryOver, deleteTask, materializeRepeats, updateTask } from "./tasks.ts";
import { updateDay } from "./days.ts";
import { upsertReview, type ReviewInput } from "./reviews.ts";
import { issueOtp, redeemOtp, OTP_TTL_SECONDS } from "./telegram/otp.ts";
import { sendMorning } from "./telegram/compose.ts";
import { updateTelegramPrefs } from "./telegram/prefs.ts";
import {
  runSchedules, isDisconnected, localDate, sendMessage, TelegramApiError, DISCONNECTED_UNTIL,
} from "./telegram/schedule.ts";
import { d1StateStore } from "./telegram/state.ts";
import { verifyWidgetLogin } from "./telegram/widget.ts";
import { BadInput, coerceFields, dateOrNull, idOrNull, int, nonEmptyText, oneOf, text, type FieldSpecs } from "./validate.ts";
import type {
  GoalLevel, GoalStatus, GoalType, GuideProposal, Priority, ReviewPeriod, SecuritySettings,
  TelegramPrefs, TelegramSettings,
} from "../shared/types.ts";

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  AI?: Ai;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CHAT_MODEL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  /** The shared bot's @username, without the @. Unset = the login page shows no Telegram Login Widget. */
  TELEGRAM_BOT_USERNAME?: string;
  /** 5 attempts per IP per minute across /api/auth/* (wrangler `ratelimits`). */
  AUTH_LIMITER?: RateLimit;
  /** 10 bot messages per user per minute (wrangler `ratelimits`); see floodGuard in telegram/router.ts. */
  TG_FLOOD_LIMITER?: RateLimit;
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

// Which bot the login page's Telegram Login Widget renders. Registered before the brute-force guard on
// purpose: it reads no secret and touches no DB, so loading the login page must not spend an attempt.
app.get("/api/auth/telegram/widget", (c) => {
  const bot = c.env.TELEGRAM_BOT_TOKEN ? c.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null : null;
  return c.json({ bot });
});

// Brute-force guard: checked before any handler, so a rejected attempt never touches D1.
app.use("/api/auth/*", async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  if (!(await underLimit(c.env.AUTH_LIMITER, `auth:${ip}`))) {
    c.header("Retry-After", "60");
    return c.json({ error: "Too many attempts. Please wait a minute and try again." }, 429);
  }
  return next();
});

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
  // SELECT * so login keeps working before the column exists (migration pending, see /api/security).
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?")
    .bind((email ?? "").toLowerCase())
    .first<{ id: number; password_hash: string; password_login_disabled?: number }>();
  // Checked before the password, so the answer says nothing about whether the password was right.
  if (user?.password_login_disabled) {
    return c.json({ error: "Password sign-in is disabled for this account. Use Telegram." }, 403);
  }
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

// Telegram code sign-in (PRD §5.2(c)). Every request gets the same answer and a fresh way_pending cookie;
// the lookup and send run after the response, so neither content nor timing reveals whether the email is linked.
app.post("/api/auth/telegram/otp", async (c) => {
  const { email } = await c.req.json<{ email?: unknown }>();
  if (typeof email !== "string" || !email.includes("@")) return c.json({ error: "Enter the email of your Way account." }, 400);
  const browserToken = newSessionToken();
  c.executionCtx.waitUntil(
    issueOtp(c.env.DB, c.env.TELEGRAM_BOT_TOKEN, email.trim().toLowerCase(), browserToken)
      .catch((e) => console.error("telegram otp: issue failed", e))
  );
  c.header("Set-Cookie", pendingCookie(browserToken, OTP_TTL_SECONDS));
  return c.json({ ok: true });
});

app.post("/api/auth/telegram/verify", async (c) => {
  const { code } = await c.req.json<{ code?: unknown }>();
  const browserToken = getCookie(c, PENDING_COOKIE);
  const userId = browserToken && typeof code === "string" ? await redeemOtp(c.env.DB, browserToken, code) : null;
  if (!userId) return c.json({ error: "That code is wrong or has expired. Check Telegram or request a new one." }, 401);

  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, userId, expires),
    // A Telegram sign-in has now succeeded, which is what lets the user switch password sign-in off.
    c.env.DB.prepare("UPDATE telegram_accounts SET verified_login = 1 WHERE user_id = ?").bind(userId),
  ]);
  c.header("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
  c.header("Set-Cookie", pendingCookie("", 0), { append: true });
  return c.json({ ok: true });
});

// Telegram Login Widget sign-in (PRD §5.2(a)): the widget's signed payload → the linked Way account.
app.post("/api/auth/telegram/widget", async (c) => {
  const botToken = c.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return c.json({ error: "Telegram sign-in is not configured." }, 503);
  const data = await c.req.json<unknown>().catch(() => null);
  const telegramUserId = await verifyWidgetLogin(botToken, data, Math.floor(Date.now() / 1000));
  if (!telegramUserId) return c.json({ error: "Telegram sign-in could not be verified or has expired. Please try again." }, 401);

  const account = await c.env.DB.prepare("SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?")
    .bind(telegramUserId)
    .first<{ user_id: number }>();
  if (!account) return c.json({ error: "No Way account is linked to this Telegram." }, 404);

  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, account.user_id, expires),
    // A Telegram sign-in has now succeeded, which is what lets the user switch password sign-in off.
    c.env.DB.prepare("UPDATE telegram_accounts SET verified_login = 1 WHERE user_id = ?").bind(account.user_id),
  ]);
  c.header("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
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

// Security (PRD §5.3, §11.1): Telegram as the only way in. No recovery mechanism, by decision.
// The password hash is kept; any signed-in session can switch password sign-in back on.
// Operator escape hatch: UPDATE users SET password_login_disabled = 0 WHERE email = ?
// Schema assumed from #2/#9: users.password_login_disabled (INTEGER, default 0),
// telegram_accounts(user_id, verified_login) — verified_login = 1 once a Telegram sign-in has succeeded.

app.get("/api/security", async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT u.password_login_disabled, t.verified_login
       FROM users u LEFT JOIN telegram_accounts t ON t.user_id = u.id
      WHERE u.id = ?`
  ).bind(c.get("userId")).first<{ password_login_disabled: number; verified_login: number | null }>();
  const security: SecuritySettings = {
    telegram_verified: row?.verified_login === 1,
    password_login_disabled: row?.password_login_disabled === 1,
  };
  return c.json({ security });
});

app.put("/api/security", async (c) => {
  const userId = c.get("userId");
  const { password_login_disabled } = await c.req.json<{ password_login_disabled?: unknown }>();
  if (typeof password_login_disabled !== "boolean") {
    return c.json({ error: "password_login_disabled must be true or false." }, 400);
  }
  if (!password_login_disabled) {
    await c.env.DB.prepare("UPDATE users SET password_login_disabled = 0 WHERE id = ?").bind(userId).run();
    return c.json({ ok: true });
  }
  // Only once Telegram sign-in is proven (a real Telegram sign-in happened), not merely claimed.
  const res = await c.env.DB.prepare(
    `UPDATE users SET password_login_disabled = 1
      WHERE id = ? AND EXISTS (SELECT 1 FROM telegram_accounts WHERE user_id = ? AND verified_login = 1)`
  ).bind(userId, userId).run();
  if (!res.meta.changes) {
    return c.json({ error: "Sign in with Telegram at least once before disabling password sign-in." }, 409);
  }
  return c.json({ ok: true });
});

// ---------- telegram settings ----------
// The Settings → Telegram card (PRD §5.1 step 6, §9). Linking itself happens in the bot (#7).
// Schema assumed from #2/#4: telegram_accounts(user_id, chat_id, username, paused_until, …) — SELECT * so the
// card still loads if username is missing — plus telegram_prefs and users.timezone (see telegram/prefs.ts).

app.get("/api/telegram", async (c) => {
  const userId = c.get("userId");
  const [account, prefs, user] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM telegram_accounts WHERE user_id = ?").bind(userId)
      .first<{ username?: string | null; paused_until: string | null }>(),
    c.env.DB.prepare("SELECT * FROM telegram_prefs WHERE user_id = ?").bind(userId).first<Partial<TelegramPrefs>>(),
    c.env.DB.prepare("SELECT timezone FROM users WHERE id = ?").bind(userId).first<{ timezone: string | null }>(),
  ]);
  const telegram: TelegramSettings = {
    linked: !!account,
    username: account?.username ?? null,
    disconnected: isDisconnected(account?.paused_until),
    timezone: user?.timezone ?? null,
    bot: c.env.TELEGRAM_BOT_TOKEN ? c.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null : null,
    prefs: {
      morning_at: prefs?.morning_at ?? null,
      review_at: prefs?.review_at ?? null,
      quiet_from: prefs?.quiet_from ?? null,
      quiet_to: prefs?.quiet_to ?? null,
      nudges: prefs?.nudges ? 1 : 0,
    },
  };
  return c.json({ telegram });
});

app.put("/api/telegram/prefs", async (c) => {
  await updateTelegramPrefs(c.env.DB, c.get("userId"), await c.req.json<Record<string, unknown>>());
  return c.json({ ok: true });
});

// Unlink. Prefs are kept so a re-link starts from the same times; everything the bot holds for this user goes.
app.delete("/api/telegram", async (c) => {
  const userId = c.get("userId");
  const user = await c.env.DB.prepare("SELECT password_login_disabled FROM users WHERE id = ?")
    .bind(userId).first<{ password_login_disabled: number }>();
  // Telegram is this account's only way in (see /api/security): unlinking would lock the user out.
  if (user?.password_login_disabled === 1) {
    return c.json({ error: "Telegram is your only way to sign in. Re-enable email + password sign-in first." }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM telegram_accounts WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM telegram_codes WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM telegram_state WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("DELETE FROM telegram_outbox_log WHERE user_id = ?").bind(userId),
  ]);
  return c.json({ ok: true });
});

// "Send me today's brief": the morning message, now, outside the schedule (no outbox claim).
// A send that gets through clears a "bot was blocked" disconnect; a 403 sets it.
app.post("/api/telegram/test", async (c) => {
  const userId = c.get("userId");
  const token = c.env.TELEGRAM_BOT_TOKEN;
  if (!token) return c.json({ error: "Telegram is not configured." }, 503);
  const db = c.env.DB;
  const account = await db.prepare(
    "SELECT a.chat_id, a.paused_until, u.timezone FROM telegram_accounts a JOIN users u ON u.id = a.user_id WHERE a.user_id = ?"
  ).bind(userId).first<{ chat_id: number | string; paused_until: string | null; timezone: string | null }>();
  if (!account) return c.json({ error: "Telegram is not connected." }, 404);
  if (!(await underLimit(c.env.TG_FLOOD_LIMITER, `test:${userId}`))) {
    return c.json({ error: "Too many test messages. Please wait a minute." }, 429);
  }
  let today: string;
  try {
    today = localDate(account.timezone || "UTC", new Date());
  } catch {
    today = localDate("UTC", new Date());
  }
  try {
    await sendMorning({
      db, userId, today,
      state: d1StateStore(db, userId),
      send: (reply) => sendMessage(token, account.chat_id, reply),
    });
  } catch (e) {
    if (e instanceof TelegramApiError && e.status === 403) {
      await db.prepare("UPDATE telegram_accounts SET paused_until = ? WHERE user_id = ?").bind(DISCONNECTED_UNTIL, userId).run();
      return c.json({ error: "Telegram refused the message — the bot was blocked. Unblock it in Telegram and try again." }, 409);
    }
    if (e instanceof TelegramApiError) return c.json({ error: `Telegram: ${e.description}` }, 502);
    throw e;
  }
  if (isDisconnected(account.paused_until)) {
    await db.prepare("UPDATE telegram_accounts SET paused_until = NULL WHERE user_id = ?").bind(userId).run();
  }
  return c.json({ ok: true });
});

// ---------- day / tasks ----------

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

const GOAL_TYPES: GoalType[] = ["outcome", "process", "maintenance", "learning"];
const GOAL_STATUSES: GoalStatus[] = ["draft", "active", "at_risk", "paused", "completed", "abandoned", "archived"];
const PRIORITIES: Priority[] = ["must", "should", "could"];

const GOAL_FIELDS: FieldSpecs = {
  title: nonEmptyText, description: text, level: oneOf(GOAL_LEVELS), type: oneOf(GOAL_TYPES), status: oneOf(GOAL_STATUSES),
  area_id: idOrNull, parent_id: idOrNull, priority: oneOf(PRIORITIES), start_date: dateOrNull, target_date: dateOrNull,
  progress: int(0, 100, false), confidence: int(1, 5), success_criteria: text, motivation: text,
};

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
  for (const [f, v] of coerceFields(b, GOAL_FIELDS)) {
    await c.env.DB.prepare(`UPDATE goals SET ${f} = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?`)
      .bind(v, id, userId).run();
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

  try {
    const { id, text, proposals } = await guideChat(c.env.DB, c.env, userId, message);
    return c.json({ message: { id, role: "assistant", content: text, proposals: proposals.length ? proposals : null } });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : "Guide is unavailable right now." }, 502);
  }
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

// A bad field in a partial update (see worker/validate.ts) is the client's fault: 400, not 500.
app.onError((err, c) => {
  if (err instanceof BadInput) return c.json({ error: err.message }, 400);
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.text("Internal Server Error", 500);
});

// Cron ticks (Telegram scheduler). No trigger is configured in wrangler.jsonc until the telegram_* migration lands.
export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedules(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
