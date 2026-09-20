import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import {
  hashPassword, verifyPassword, newSessionToken, sessionCookie, pendingCookie, underLimit,
  PENDING_COOKIE, SESSION_COOKIE, SESSION_DAYS,
} from "./auth.ts";
import { guideChat } from "./guide.ts";
import { addDays, periodRange, reviewPeriodEnd, reviewPeriodStart, weekStartOf } from "./dates.ts";
import { applyProposal } from "./proposals.ts";
import { createUser, isTelegramOnlyEmail } from "./users.ts";
import { carryOver, deleteTask, materializeRepeats, updateTask } from "./tasks.ts";
import { updateDay } from "./days.ts";
import { upsertReview, type ReviewInput } from "./reviews.ts";
import { issueOtp, redeemOtp, OTP_TTL_SECONDS } from "./telegram/otp.ts";
import { sendMorning } from "./telegram/compose.ts";
import { timezoneOrNull, updateTelegramPrefs } from "./telegram/prefs.ts";
import { isLinkNonce, linkStatus, linkUrl, startLink, LINK_TTL_SECONDS } from "./telegram/link.ts";
import { runSchedules, isDisconnected, localDate, DISCONNECTED_UNTIL } from "./telegram/schedule.ts";
import { ALLOWED_UPDATES, BOT_COMMANDS, sendReply, TelegramApiError, TelegramBot } from "./telegram/api.ts";
import { describeBrowser, loginUrl, pollLogin, startLoginRequest, LOGIN_TTL_SECONDS } from "./telegram/login.ts";
import { telegramStats } from "./telegram/events.ts";
import { bodySummary, loadBodyPlan, loadWeightLogs, refreshBodyGoalProgress, suggestedWeightGoal, weightTrends } from "./body.ts";
import { d1StateStore } from "./telegram/state.ts";
import { userToday } from "./telegram/time.ts";
import { verifyWidgetLogin } from "./telegram/widget.ts";
import { claimUpdate, handleUpdate, isUpdate, secretTokenOk, SECRET_HEADER } from "./telegram/webhook.ts";
import { BadInput, coerceFields, dateOrNull, idOrNull, int, nonEmptyText, oneOf, text, type FieldSpecs } from "./validate.ts";
import { isWeightUnit, toKg, KG_RANGE } from "../shared/body.ts";
import type {
  GoalLevel, GoalStatus, GoalType, GuideProposal, Priority, SecuritySettings,
  TelegramLinkStart, TelegramPrefs, TelegramSettings, User,
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
  /** The secret_token given to setWebhook (a Worker secret). Unset = every webhook request is refused. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** 5 attempts per IP per minute across /api/auth/* (wrangler `ratelimits`). */
  AUTH_LIMITER?: RateLimit;
  /** 10 bot messages per user per minute (wrangler `ratelimits`); see floodGuard in telegram/router.ts. */
  TG_FLOOD_LIMITER?: RateLimit;
}

const GOAL_LEVELS: GoalLevel[] = ["lifetime", "year", "quarter", "month", "week"];

type Vars = { userId: number };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();


// ---------- helpers ----------

/** Today in the user's timezone (users.timezone; NULL = UTC). */
async function todayFor(db: D1Database, userId: number): Promise<string> {
  const row = await db.prepare("SELECT timezone FROM users WHERE id = ?").bind(userId).first<{ timezone: string | null }>();
  return userToday(row?.timezone);
}

function assertDate(s: unknown): string {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error("bad date");
  return s;
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

  const userId = await createUser(c.env.DB, {
    email: email.toLowerCase(), name: name?.trim() || email.split("@")[0], passwordHash: await hashPassword(password),
  });

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

// Deep-link sign-in (PRD §5.2(b)): the page mints a nonce bound to a fresh way_pending cookie, shows the
// t.me link / QR, and polls; the bot asks the linked user to approve (telegram/login.ts).
app.post("/api/auth/telegram/start", async (c) => {
  const bot = c.env.TELEGRAM_BOT_TOKEN ? c.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null : null;
  if (!bot) return c.json({ error: "Telegram sign-in is not configured." }, 503);
  const browserToken = newSessionToken();
  const code = await startLoginRequest(c.env.DB, browserToken, {
    country: (c.req.raw.cf as { country?: string } | undefined)?.country ?? c.req.header("CF-IPCountry") ?? "unknown",
    browser: describeBrowser(c.req.header("User-Agent")),
  });
  c.header("Set-Cookie", pendingCookie(browserToken, LOGIN_TTL_SECONDS));
  return c.json({ code, url: loginUrl(bot, code), expires_in: LOGIN_TTL_SECONDS });
});

app.get("/api/auth/telegram/poll", async (c) => {
  const code = c.req.query("code");
  const browserToken = getCookie(c, PENDING_COOKIE);
  if (!browserToken || !code || !/^[0-9a-f]{32}$/.test(code)) return c.json({ state: "expired" });
  const r = await pollLogin(c.env.DB, browserToken, code);
  if (r.state !== "approved") return c.json({ state: r.state });
  const token = newSessionToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)").bind(token, r.userId, expires),
    c.env.DB.prepare("UPDATE telegram_accounts SET verified_login = 1 WHERE user_id = ?").bind(r.userId),
  ]);
  c.header("Set-Cookie", sessionCookie(token, SESSION_DAYS * 86400));
  c.header("Set-Cookie", pendingCookie("", 0), { append: true });
  return c.json({ state: "approved" });
});

// Reachable without a session cookie. The webhook authenticates with its secret token instead (PRD §4.4).
const PUBLIC = ["/api/auth/", "/api/telegram/webhook", "/api/telegram/setup"];

app.use("/api/*", async (c, next) => {
  if (PUBLIC.some((p) => c.req.path.startsWith(p))) return next();
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
  // SELECT * so /api/me keeps working before migration 0002 adds timezone / password_login_disabled.
  const row = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?")
    .bind(c.get("userId"))
    .first<{ id: number; email: string; name: string; direction: string; timezone?: string | null; password_login_disabled?: number }>();
  const user: User | null = row && {
    id: row.id, email: isTelegramOnlyEmail(row.email) ? "" : row.email, name: row.name, direction: row.direction,
    timezone: row.timezone ?? null, password_login_disabled: !!row.password_login_disabled,
    telegram_only: isTelegramOnlyEmail(row.email),
  };
  return c.json({ user });
});

app.put("/api/me", async (c) => {
  const b = await c.req.json<{ name?: string; direction?: string; timezone?: unknown }>();
  const { name, direction } = b;
  // Validated before anything is written; null or "" = UTC.
  const timezone = "timezone" in b ? timezoneOrNull(b.timezone) : undefined;
  if (name !== undefined)
    await c.env.DB.prepare("UPDATE users SET name = ? WHERE id = ?").bind(name.trim(), c.get("userId")).run();
  if (direction !== undefined)
    await c.env.DB.prepare("UPDATE users SET direction = ? WHERE id = ?").bind(direction.trim(), c.get("userId")).run();
  if (timezone !== undefined)
    await c.env.DB.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(timezone, c.get("userId")).run();
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
// The Settings → Telegram card (PRD §5.1 step 6, §9). Linking: /api/telegram/link/* here, the bot side in telegram/link.ts.
// Schema assumed from #2/#4: telegram_accounts(user_id, chat_id, username, paused_until, …) — SELECT * so the
// card still loads if username is missing — plus telegram_prefs and users.timezone (see telegram/prefs.ts).

app.get("/api/telegram", async (c) => {
  const userId = c.get("userId");
  const [account, prefs, user, bodyPlan] = await Promise.all([
    c.env.DB.prepare("SELECT * FROM telegram_accounts WHERE user_id = ?").bind(userId)
      .first<{ username?: string | null; paused_until: string | null }>(),
    c.env.DB.prepare("SELECT * FROM telegram_prefs WHERE user_id = ?").bind(userId).first<Partial<TelegramPrefs>>(),
    c.env.DB.prepare("SELECT timezone FROM users WHERE id = ?").bind(userId).first<{ timezone: string | null }>(),
    // The body slots and the nudge toggle are only shown once a plan exists (PRD-body §10).
    loadBodyPlan(c.env.DB, userId),
  ]);
  const telegram: TelegramSettings = {
    linked: !!account,
    username: account?.username ?? null,
    disconnected: isDisconnected(account?.paused_until),
    timezone: user?.timezone ?? null,
    bot: c.env.TELEGRAM_BOT_TOKEN ? c.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null : null,
    body_plan: !!bodyPlan,
    prefs: {
      morning_at: prefs?.morning_at ?? null,
      review_at: prefs?.review_at ?? null,
      weekly_plan_at: prefs?.weekly_plan_at ?? null,
      weekly_review_at: prefs?.weekly_review_at ?? null,
      checkin_at: prefs?.checkin_at ?? null,
      quiet_from: prefs?.quiet_from ?? null,
      quiet_to: prefs?.quiet_to ?? null,
      nudges: prefs?.nudges ? 1 : 0,
      block_reminders: prefs?.block_reminders ? 1 : 0,
      streaks: prefs?.streaks ? 1 : 0,
      weigh_at: prefs?.weigh_at ?? null,
      breakfast_at: prefs?.breakfast_at ?? null,
      lunch_at: prefs?.lunch_at ?? null,
      dinner_at: prefs?.dinner_at ?? null,
      workout_at: prefs?.workout_at ?? null,
      body_nudges: prefs?.body_nudges ? 1 : 0,
    },
  };
  return c.json({ telegram });
});

// Link from the web: a deep link / QR the page shows, then polls until the bot has seen /start link_<nonce>.
app.post("/api/telegram/link/start", async (c) => {
  const bot = c.env.TELEGRAM_BOT_TOKEN ? c.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") || null : null;
  if (!bot) return c.json({ error: "Telegram is not configured." }, 503);
  const code = await startLink(c.env.DB, c.get("userId"));
  const url = linkUrl(bot, code);
  const link: TelegramLinkStart = { code, url, qr: url, expires_in: LINK_TTL_SECONDS };
  return c.json(link);
});

app.get("/api/telegram/link/status", async (c) => {
  const code = c.req.query("code");
  if (!isLinkNonce(code)) return c.json({ error: "code must be the 32-hex link code." }, 400);
  return c.json(await linkStatus(c.env.DB, c.get("userId"), code));
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
  const bot = new TelegramBot(token);
  try {
    await sendMorning({
      db, userId, today,
      state: d1StateStore(db, userId),
      send: (reply) => sendReply(bot, account.chat_id, reply),
    });
  } catch (e) {
    if (e instanceof TelegramApiError && e.kind === "blocked") {
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

// ---------- telegram webhook ----------
// The bot's entry point (PRD §4.3–§4.5; the handling itself is in telegram/webhook.ts). Every outcome is an empty
// 200: any other status makes Telegram retry, and a 401 would only tell a probe it found something.
app.post("/api/telegram/webhook", async (c) => {
  if (!secretTokenOk(c.env.TELEGRAM_WEBHOOK_SECRET, c.req.header(SECRET_HEADER))) {
    console.warn("telegram webhook: bad secret token");
    return c.body(null, 200);
  }
  try {
    const update: unknown = await c.req.json().catch(() => null);
    if (!isUpdate(update)) {
      console.warn("telegram webhook: body is not an update");
    } else if (await claimUpdate(c.env.DB, update.update_id)) {
      c.executionCtx.waitUntil(handleUpdate(c.env, update, new URL(c.req.url).origin));
    }
  } catch (e) {
    console.error("telegram webhook: failed", e);
  }
  return c.body(null, 200);
});

app.get("/api/telegram/stats", async (c) => {
  const userId = c.get("userId");
  return c.json({ stats: await telegramStats(c.env.DB, userId, await todayFor(c.env.DB, userId)) });
});

// Deploy-time bot setup: registers the webhook (this origin, the same secret, ALLOWED_UPDATES) and installs
// the / command menu (BOT_COMMANDS in telegram/api.ts). Idempotent.
// `npm run telegram:setup` after a deploy, with TELEGRAM_WEBHOOK_SECRET in the shell (Authorization: Bearer <it>).
app.post("/api/telegram/setup", async (c) => {
  const auth = c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!secretTokenOk(c.env.TELEGRAM_WEBHOOK_SECRET, auth)) return c.json({ error: "unauthorized" }, 401);
  const bot = TelegramBot.fromEnv(c.env);
  const url = `${new URL(c.req.url).origin}/api/telegram/webhook`;
  const hook = await bot.setWebhook({ url, secret_token: c.env.TELEGRAM_WEBHOOK_SECRET, allowed_updates: ALLOWED_UPDATES });
  if (!hook.ok) return c.json({ error: `Telegram setWebhook: ${hook.description}` }, 502);
  const r = await bot.setMyCommands({ commands: BOT_COMMANDS });
  if (!r.ok) return c.json({ error: `Telegram setMyCommands: ${r.description}` }, 502);
  return c.json({ ok: true, webhook: url, commands: BOT_COMMANDS.map((b) => b.command) });
});

// ---------- day / tasks ----------

app.get("/api/day", async (c) => {
  const userId = c.get("userId");
  const date = assertDate(c.req.query("date") ?? await todayFor(c.env.DB, userId));
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
  const anchor = assertDate(c.req.query("anchor") ?? await todayFor(c.env.DB, userId));
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

app.get("/api/reviews", async (c) => {
  const userId = c.get("userId");
  const period = c.req.query("period") ?? "weekly";
  const today = await todayFor(c.env.DB, userId);
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
  const today = await todayFor(c.env.DB, userId);
  const d28 = addDays(today, -28);
  const d14 = addDays(today, -14);
  const d90 = addDays(today, -89);

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

  // The weight tile (PRD-body §10): the same summary the Body page and the bot quote, with the
  // readings behind the sparkline. Null without a body plan, and the tile is not rendered.
  const summary = await bodySummary(c.env.DB, userId, today);
  const body = summary ? { summary, weights: await loadWeightLogs(c.env.DB, userId, d90) } : null;

  return c.json({ totals, weeklyCompletion, byArea, moods, planned, goals, body });
});

// ---------- body ----------

/**
 * Everything the Body page draws (PRD-body §10): the deterministic summary, the weigh-ins and the
 * 7-day trend at each of them — all from worker/body.ts, so the page and `/body` in the bot quote
 * the same projected date. `summary` is null when no plan is attached; `suggested` then names the
 * goal that looks like a weight goal, so the page can offer to turn tracking on.
 */
app.get("/api/body", async (c) => {
  const userId = c.get("userId");
  const today = await todayFor(c.env.DB, userId);
  const [summary, weights] = await Promise.all([
    bodySummary(c.env.DB, userId, today),
    loadWeightLogs(c.env.DB, userId),
  ]);
  const trend = await weightTrends(c.env.DB, userId, weights.map((w) => w.date));
  return c.json({
    today,
    summary,
    weights,
    trend,
    suggested: summary ? null : await suggestedWeightGoal(c.env.DB, userId),
  });
});

/** Manual entry (PRD-body §10): one reading per local date, the latest wins, `unit` is input only. */
app.post("/api/body/weight", async (c) => {
  const userId = c.get("userId");
  const b = await c.req.json<{ date?: string; value?: number | string; unit?: string; note?: string }>();
  const date = assertDate(b.date);
  const unit = b.unit === undefined ? "kg" : b.unit;
  if (!isWeightUnit(unit)) return c.json({ error: "unit must be kg, jin or lb" }, 400);
  const kg = toKg(Number(b.value), unit);
  if (!Number.isFinite(kg) || kg < KG_RANGE[0] || kg > KG_RANGE[1]) {
    return c.json({ error: `weight must be from ${KG_RANGE[0]} to ${KG_RANGE[1]} kg` }, 400);
  }
  await c.env.DB.prepare(
    `INSERT INTO weight_logs (user_id, date, kg, source, note) VALUES (?, ?, ?, 'web', ?)
     ON CONFLICT (user_id, date) DO UPDATE SET kg = excluded.kg, source = excluded.source, note = excluded.note`
  ).bind(userId, date, kg, String(b.note ?? "")).run();
  // goals.progress is derived for a goal with a body plan (PRD-body §4.3).
  await refreshBodyGoalProgress(c.env.DB, userId, await todayFor(c.env.DB, userId));
  return c.json({ ok: true, kg });
});

app.delete("/api/body/weight/:date", async (c) => {
  const userId = c.get("userId");
  const date = assertDate(c.req.param("date"));
  await c.env.DB.prepare("DELETE FROM weight_logs WHERE user_id = ? AND date = ?").bind(userId, date).run();
  await refreshBodyGoalProgress(c.env.DB, userId, await todayFor(c.env.DB, userId));
  return c.json({ ok: true });
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
  const { proposal } = await c.req.json<{ proposal: GuideProposal }>();
  const r = await applyProposal(c.env.DB, c.get("userId"), proposal);
  if (!r.ok) return c.json({ error: r.error }, r.status);
  return c.json({ ok: true, applied: r.applied });
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

// Cron ticks (Telegram scheduler): "triggers.crons" in wrangler.jsonc / wrangler.dev.jsonc, every 5 minutes.
export default {
  fetch: app.fetch,
  scheduled(controller, env, ctx) {
    ctx.waitUntil(runSchedules(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;
