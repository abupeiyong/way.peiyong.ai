// Account commands (PRD §7.2, #21): /timezone /settings /mute /unlink — everything the user needs to
// control the bot without a browser. /unlink refuses while password sign-in is off (§5.3): with Telegram
// as the only way in, unlinking would be a one-tap lockout.

import { cb, type CallbackContext, type MuteSpan, type SettingsToggle } from "./callback.ts";
import { logEvent } from "./events.ts";
import { timezoneCard } from "./register.ts";
import type { Reply } from "./router.ts";
import { DISCONNECTED_UNTIL } from "./schedule.ts";
import { localNow, normalizeTimeZone } from "./time.ts";

const TIMEZONE_TTL_SECONDS = 10 * 60;

export type AccountContext = Pick<CallbackContext, "db" | "userId" | "today" | "timezone" | "origin" | "state" | "send">;

// ---------- /timezone ----------

export async function timezoneCommand(ctx: AccountContext, args: string): Promise<void> {
  if (args.trim()) {
    const zone = normalizeTimeZone(args.trim());
    if (!zone) {
      await ctx.send({ text: `没认出「${args.trim()}」 · Not a time zone I know. 例如 Asia/Shanghai、Europe/London` });
      return;
    }
    await ctx.db.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(zone === "UTC" ? null : zone, ctx.userId).run();
    await ctx.send({ text: `🕐 时区已设为 ${zone} · Time zone set — 晨报和复盘的时间按它计算 · prompt times follow it` });
    return;
  }
  await ctx.state.put({ kind: "timezone" }, TIMEZONE_TTL_SECONDS);
  await ctx.send(timezoneCard(ctx.timezone, "🕐 时区 · Time zone"));
}

/** Router step 3: a typed zone after /timezone. */
export async function timezoneAnswer(ctx: AccountContext, text: string): Promise<boolean> {
  const s = await ctx.state.get();
  if (!s || typeof s !== "object" || (s as { kind?: string }).kind !== "timezone") return false;
  const zone = normalizeTimeZone(text.trim());
  if (!zone) {
    await ctx.send({ text: "没认出这个时区，点上面的按钮，或回复像 Asia/Shanghai 这样的名称 · Not a time zone I know" });
    return true;
  }
  await ctx.state.clear();
  await ctx.db.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(zone === "UTC" ? null : zone, ctx.userId).run();
  await ctx.send({ text: `🕐 时区已设为 ${zone} · Time zone set` });
  return true;
}

// ---------- /settings ----------

interface PrefsRow {
  morning_at: string | null; review_at: string | null; weekly_plan_at: string | null; weekly_review_at: string | null;
  checkin_at: string | null; quiet_from: string | null; quiet_to: string | null;
  nudges: number; block_reminders: number; streaks: number;
}

async function settingsCard(ctx: AccountContext): Promise<Reply> {
  const p = await ctx.db.prepare("SELECT * FROM telegram_prefs WHERE user_id = ?").bind(ctx.userId).first<PrefsRow>();
  const paused = await ctx.db.prepare("SELECT paused_until FROM telegram_accounts WHERE user_id = ?").bind(ctx.userId).first<{ paused_until: string | null }>();
  const slot = (v: string | null | undefined) => v || "关 off";
  const on = (v: number | undefined) => (v ? "开 on" : "关 off");
  const quiet = p?.quiet_from && p.quiet_to ? `${p.quiet_from}–${p.quiet_to}` : "关 off";
  const mute = paused?.paused_until && paused.paused_until < DISCONNECTED_UNTIL ? `静音到 ${paused.paused_until} UTC` : "";
  return {
    text: [
      "⚙️ 设置 · Settings",
      "",
      `☀️ 晨报 Morning — ${slot(p?.morning_at)}`,
      `🌙 晚间复盘 Evening review — ${slot(p?.review_at)}`,
      `📅 周一计划 Monday plan — ${slot(p?.weekly_plan_at)}`,
      `🗓 周日复盘 Sunday review — ${slot(p?.weekly_review_at)}`,
      `🌱 月初领域打分 Monthly check-in — ${slot(p?.checkin_at)}`,
      `🤫 免打扰 Quiet hours — ${quiet}`,
      `🕐 时区 Time zone — ${ctx.timezone || "UTC"}`,
      ...(mute ? [mute] : []),
      "",
      `🔔 中午提醒 Midday nudge — ${on(p?.nudges)}`,
      `⏰ 时间块提醒 Block reminders — ${on(p?.block_reminders)}`,
      `🔥 连续天数 Streaks — ${on(p?.streaks)}`,
      "",
      "时间在网页设置里改，时区用 /timezone · Change times on the web; /timezone for the zone",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [
        [
          { text: `🔔 ${p?.nudges ? "关" : "开"} nudge`, callback_data: cb.settings("nudges") },
          { text: `⏰ ${p?.block_reminders ? "关" : "开"} blocks`, callback_data: cb.settings("block_reminders") },
          { text: `🔥 ${p?.streaks ? "关" : "开"} streaks`, callback_data: cb.settings("streaks") },
        ],
        [{ text: "🌐 网页设置 Open Settings", url: `${ctx.origin}/settings` }],
      ],
    },
  };
}

export async function settingsCommand(ctx: AccountContext): Promise<void> {
  await ctx.send(await settingsCard(ctx));
}

/** st:<n|b|s> — flip one 0/1 pref and redraw. */
export async function settingsToggle(ctx: CallbackContext, toggle: SettingsToggle): Promise<string> {
  await ctx.db.prepare("INSERT OR IGNORE INTO telegram_prefs (user_id) VALUES (?)").bind(ctx.userId).run();
  await ctx.db.prepare(`UPDATE telegram_prefs SET ${toggle} = CASE WHEN ${toggle} = 1 THEN 0 ELSE 1 END WHERE user_id = ?`).bind(ctx.userId).run();
  await ctx.edit(await settingsCard(ctx));
  return "已更新 · Updated";
}

// ---------- /mute ----------

export async function muteCommand(ctx: AccountContext, args: string): Promise<void> {
  const a = args.trim().toLowerCase();
  if (a === "today" || a === "今天") return muteApply(ctx, "today");
  if (a === "7d" || a === "week" || a === "一周") return muteApply(ctx, "week");
  if (a === "off" || a === "关") return muteApply(ctx, "off");
  await ctx.send({
    text: "🔕 静音多久？ · Pause notifications for how long?",
    reply_markup: {
      inline_keyboard: [[
        { text: "今天 Today", callback_data: cb.mute("today") },
        { text: "7 天 A week", callback_data: cb.mute("week") },
        { text: "取消静音 Off", callback_data: cb.mute("off") },
      ]],
    },
  });
}

async function muteApply(ctx: AccountContext, span: MuteSpan): Promise<void> {
  await ctx.send({ text: await muteSet(ctx, span) });
}

/** Sets telegram_accounts.paused_until; "today" = until the user's next local midnight. Returns the confirmation. */
async function muteSet(ctx: Pick<CallbackContext, "db" | "userId" | "timezone">, span: MuteSpan): Promise<string> {
  if (span === "off") {
    await ctx.db.prepare("UPDATE telegram_accounts SET paused_until = NULL WHERE user_id = ? AND (paused_until IS NULL OR paused_until < ?)")
      .bind(ctx.userId, DISCONNECTED_UNTIL).run();
    await logEvent(ctx.db, ctx.userId, "mute", "used");
    return "🔔 已取消静音 · Notifications resume";
  }
  let modifier: string;
  if (span === "today") {
    let minutes = 60;
    try { minutes = 24 * 60 - localNow(ctx.timezone || "UTC").minutes; } catch { /* UTC fallback */ }
    modifier = `+${minutes} minutes`;
  } else {
    modifier = "+7 days";
  }
  await ctx.db.prepare("UPDATE telegram_accounts SET paused_until = datetime('now', ?) WHERE user_id = ?").bind(modifier, ctx.userId).run();
  await logEvent(ctx.db, ctx.userId, "mute", "used");
  return span === "today"
    ? "🔕 今天静音，明早恢复 · Muted for today; back tomorrow morning"
    : "🔕 静音 7 天 · Muted for a week — /mute off 随时恢复";
}

/** mu:<t|w|o> */
export async function muteFor(ctx: CallbackContext, span: MuteSpan): Promise<string> {
  await ctx.finish(await muteSet(ctx, span));
  return span === "off" ? "已恢复 · Resumed" : "已静音 · Muted";
}

// ---------- /unlink ----------

async function passwordLoginDisabled(ctx: Pick<CallbackContext, "db" | "userId">): Promise<boolean> {
  const u = await ctx.db.prepare("SELECT password_login_disabled FROM users WHERE id = ?").bind(ctx.userId).first<{ password_login_disabled: number }>();
  return u?.password_login_disabled === 1;
}

const LOCKOUT: Reply = {
  text: "现在 Telegram 是这个账号唯一的登录方式，断开就进不去了 · Telegram is this account's only way to sign in; unlinking would lock you out.\n"
    + "先在网页设置里重新开启邮箱密码登录 · Re-enable email + password sign-in in Settings on the web first.",
};

export async function unlinkCommand(ctx: AccountContext): Promise<void> {
  if (await passwordLoginDisabled(ctx)) return ctx.send(LOCKOUT);
  await ctx.send({
    text: "断开 Telegram？晨报、复盘和提醒都会停止；你的数据不受影响 · Disconnect Telegram? Prompts stop; your data stays.",
    reply_markup: { inline_keyboard: [[{ text: "断开 · Disconnect", callback_data: cb.unlink() }]] },
  });
}

/** ul:y — the same deletion as DELETE /api/telegram. */
export async function unlinkConfirm(ctx: CallbackContext): Promise<string> {
  if (await passwordLoginDisabled(ctx)) {
    await ctx.finish(LOCKOUT.text);
    return "无法断开 · Cannot unlink";
  }
  await logEvent(ctx.db, ctx.userId, "unlink", "used");
  await ctx.db.batch([
    ctx.db.prepare("DELETE FROM telegram_accounts WHERE user_id = ?").bind(ctx.userId),
    ctx.db.prepare("DELETE FROM telegram_codes WHERE user_id = ?").bind(ctx.userId),
    ctx.db.prepare("DELETE FROM telegram_state WHERE user_id = ?").bind(ctx.userId),
    ctx.db.prepare("DELETE FROM telegram_outbox_log WHERE user_id = ?").bind(ctx.userId),
  ]);
  await ctx.finish("已断开 · Disconnected. 随时可在网页设置里重新连接 · Reconnect any time from Settings.");
  return "已断开 · Disconnected";
}
