// Register from Telegram (PRD §5.4, #30) and the timezone picker it shares with /timezone.
//   /start (unlinked)  → [🔗 我有账号] (link from the web) or [✨ 创建新账号] (rg:y)
//   rg:y               → createUser (same seeding as the web), telegram_accounts with verified_login = 1 —
//                        Telegram *is* this account's identity — and password sign-in off from birth.
//                        users.email is NOT NULL UNIQUE, so the account carries a sentinel address
//                        (users.ts telegramOnlyEmail) that /api/me hides. There is no password and no
//                        recovery: losing the Telegram account loses the Way account (§11.1).
//   onboarding         → timezone (buttons or a typed IANA name), then a one-line direction (or skip)

import { createUser, telegramOnlyEmail } from "../users.ts";
import { newSessionToken, hashPassword } from "../auth.ts";
import { cb, MAX_TIMEZONE_PICK, type CallbackContext } from "./callback.ts";
import { logEvent } from "./events.ts";
import { PREFS_SEED_SQL } from "./prefs.ts";
import type { Reply, TgUser } from "./router.ts";
import { normalizeTimeZone } from "./time.ts";

/** tz:<n> picks from here; keep it at most MAX_TIMEZONE_PICK + 1 long. */
export const COMMON_ZONES = [
  "Asia/Shanghai", "Asia/Hong_Kong", "Asia/Taipei", "Asia/Singapore", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Bangkok", "Asia/Jakarta", "Asia/Kolkata", "Asia/Dubai", "Australia/Sydney", "Pacific/Auckland",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Madrid", "Europe/Moscow", "Africa/Johannesburg",
  "America/New_York", "America/Toronto", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Vancouver", "America/Mexico_City", "America/Sao_Paulo", "UTC",
] as const;

const ONBOARD_TTL_SECONDS = 60 * 60;

interface OnboardState {
  kind: "onboard";
  step: "timezone" | "direction";
}

function isOnboardState(v: unknown): v is OnboardState {
  return !!v && typeof v === "object" && (v as OnboardState).kind === "onboard";
}

/** The picker card; also used by /timezone (account.ts). */
export function timezoneCard(current: string | null, head: string): Reply {
  const rows: { text: string; callback_data: string }[][] = [];
  // tz:<n> only reaches MAX_TIMEZONE_PICK; checked here (not at module level) because callback.ts imports this file.
  COMMON_ZONES.slice(0, MAX_TIMEZONE_PICK + 1).forEach((z, i) => {
    const btn = { text: z === current ? `【${z}】` : z.replace(/_/g, " "), callback_data: cb.timezonePick(i) };
    if (i % 2 === 0) rows.push([btn]); else rows[rows.length - 1].push(btn);
  });
  return {
    text: `${head}\n\n现在 · Now: ${current || "UTC"}\n点一个，或直接回复 IANA 名称（如 Asia/Shanghai） · Tap one, or reply with an IANA name`,
    reply_markup: { inline_keyboard: rows },
  };
}

// ---------- unlinked /start ----------

export function registerOffer(origin: string): Reply {
  return {
    text: [
      "你好 · Hello. 这个 Telegram 还没连接 Way 账号 · This Telegram isn't linked to a Way account yet.",
      "",
      "已有账号：在网页设置里点「Connect Telegram」 · Have an account? Connect from Settings on the web.",
      "没有账号：可以直接在这里创建，一切都在 Telegram 里完成 · No account? Create one right here.",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔗 我有账号 · Link my account", url: `${origin}/settings` }],
        [{ text: "✨ 创建新账号 · Create a Way account", callback_data: cb.register(true) }],
      ],
    },
  };
}

/**
 * rg:y from an unlinked chat: the account, its link and its prefs. Returns the new user id, or null when
 * this Telegram identity got linked meanwhile (the UNIQUE constraint decides).
 */
export async function registerCreate(db: D1Database, from: TgUser, chatId: number): Promise<number | null> {
  const existing = await db.prepare("SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?").bind(from.id).first();
  if (existing) return null;
  // No usable password: a random secret hashed, never shown to anyone; sign-in is Telegram only.
  const userId = await createUser(db, {
    email: telegramOnlyEmail(from.id),
    name: (from.first_name ?? "").trim() || (from.username ?? "") || "Way",
    passwordHash: await hashPassword(newSessionToken()),
    passwordLoginDisabled: true,
  });
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO telegram_accounts (user_id, telegram_user_id, chat_id, username, first_name, verified_login) VALUES (?, ?, ?, ?, ?, 1)"
      ).bind(userId, from.id, chatId, from.username ?? null, from.first_name ?? null),
      db.prepare(PREFS_SEED_SQL).bind(userId),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return null;
    throw e;
  }
  await logEvent(db, userId, "register", "used");
  return userId;
}

export type OnboardContext = Pick<CallbackContext, "db" | "userId" | "state" | "send" | "timezone">;

/** After the account exists: ask for the timezone first, since every prompt time depends on it. */
export async function startOnboarding(ctx: OnboardContext): Promise<void> {
  await ctx.state.put({ kind: "onboard", step: "timezone" } satisfies OnboardState, ONBOARD_TTL_SECONDS);
  await ctx.send({ text: "✨ 账号已创建 · Your Way account is ready.\n\n先定时区，所有提醒时间都以它为准 · First, your time zone — every prompt time follows it." });
  await ctx.send(timezoneCard(ctx.timezone, "🕐 时区 · Time zone"));
}

async function setTimezone(ctx: Pick<CallbackContext, "db" | "userId">, zone: string): Promise<void> {
  await ctx.db.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(zone === "UTC" ? null : zone, ctx.userId).run();
}

async function askDirection(ctx: OnboardContext): Promise<void> {
  await ctx.state.put({ kind: "onboard", step: "direction" } satisfies OnboardState, ONBOARD_TTL_SECONDS);
  await ctx.send({
    text: "🧭 用一句话说说你的方向 · Your direction, in one sentence.\n它会出现在每天早上的晨报顶部 · It opens every morning brief.",
    reply_markup: { inline_keyboard: [[{ text: "先跳过 Skip for now", callback_data: cb.directionSkip() }]] },
  });
}

async function finishOnboarding(ctx: OnboardContext): Promise<void> {
  await ctx.state.clear();
  await ctx.send({
    text: [
      "都好了 · All set.",
      "",
      "☀️ 每天早上晨报 + 三件事 · A morning brief and your top three, every day",
      "🌙 每天 21:30 复盘 · An evening review at 21:30",
      "📥 随手发一句话，就收进 Inbox · Send me anything and it goes to your inbox",
      "",
      "/help 看全部命令 · /help for every command",
    ].join("\n"),
    reply_markup: { inline_keyboard: [[{ text: "☀️ 今日晨报 Send me today's brief", callback_data: cb.brief() }]] },
  });
}

/** tz:<n> — from onboarding or /timezone; either way the zone is set, then the flow continues. */
export async function timezonePick(ctx: CallbackContext, n: number): Promise<string> {
  const zone = COMMON_ZONES[n];
  if (!zone) return "无效选项 · Invalid choice";
  await setTimezone(ctx, zone);
  await ctx.finish(`🕐 时区已设为 ${zone} · Time zone set`);
  const s = await ctx.state.get();
  if (isOnboardState(s) && s.step === "timezone") await askDirection(ctx);
  else if (s && typeof s === "object" && (s as { kind?: string }).kind === "timezone") await ctx.state.clear();
  return zone;
}

/** Router step 3 during onboarding: a typed zone, then the direction. */
export async function onboardAnswer(ctx: OnboardContext, text: string): Promise<boolean> {
  const s = await ctx.state.get();
  if (!isOnboardState(s)) return false;
  if (s.step === "timezone") {
    const zone = normalizeTimeZone(text.trim());
    if (!zone) {
      await ctx.send({ text: "没认出这个时区，点上面的按钮，或回复像 Asia/Shanghai 这样的名称 · Not a time zone I know — tap one above, or reply e.g. Europe/London" });
      return true;
    }
    await setTimezone(ctx, zone);
    await ctx.send({ text: `🕐 时区已设为 ${zone} · Time zone set` });
    await askDirection(ctx);
    return true;
  }
  await ctx.db.prepare("UPDATE users SET direction = ? WHERE id = ?").bind(text.trim().slice(0, 500), ctx.userId).run();
  await ctx.send({ text: `🧭 已记下 · Saved\n“${text.trim().slice(0, 500)}”` });
  await finishOnboarding(ctx);
  return true;
}

export async function directionSkip(ctx: CallbackContext): Promise<string> {
  const s = await ctx.state.get();
  await ctx.finish("🧭 方向 · Direction — 以后在网页设置里写 · add it later in Settings");
  if (isOnboardState(s)) await finishOnboarding(ctx);
  return "已跳过 · Skipped";
}
