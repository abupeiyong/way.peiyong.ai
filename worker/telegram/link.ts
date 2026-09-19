// Link Telegram from the web (PRD §5.1): Settings → nonce → deep link / QR → /start in the bot → the page polls.
//   start   → POST /api/telegram/link/start: a 32-hex nonce (crypto.getRandomValues), one live link per user,
//             5-minute TTL; the answer carries https://t.me/<bot>?start=link_<nonce> and the QR payload (the same URL).
//   redeem  → the webhook's `/start link_<nonce>`: the nonce is consumed by one atomic UPDATE (exactly once, and
//             only while unexpired), then telegram_accounts is upserted, telegram_prefs seeded and a welcome sent.
//   status  → GET /api/telegram/link/status?code=…: pending | linked | refused | expired, for the page to poll.
// One Telegram identity ↔ one Way account: checked before the write, and the UNIQUE(telegram_user_id) constraint
// is the backstop when two links race.
//
// Webhook wiring (#6): `/start link_<nonce>` arrives from a chat that resolves to no Way user yet, so the webhook
// must hand it to redeemLink before requiring one (parseCommand gives name "start", args "link_<nonce>"), then
// send the returned reply to message.chat.id.
//
// Schema assumed from #2/#4: telegram_codes(kind, code, user_id, browser_token, attempts DEFAULT 0, expires_at) —
// a link row has kind = 'link', code = the nonce, and attempts = 1 once consumed (the row stays until housekeeping
// deletes it after expiry, so the page can still read the outcome); telegram_accounts(user_id UNIQUE,
// telegram_user_id UNIQUE, chat_id, username, first_name, verified_login, paused_until); telegram_prefs with
// column defaults (see prefs.ts); users.timezone.

import type { TelegramLinkStatus } from "../../shared/types.ts";
import { cb } from "./callback.ts";
import type { Reply, TgMessage } from "./router.ts";

export const LINK_TTL_SECONDS = 300;
export const LINK_START_PREFIX = "link_";

/** 16 random bytes as 32 lowercase hex characters. */
export function newLinkNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function isLinkNonce(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
}

export function linkUrl(bot: string, nonce: string): string {
  return `https://t.me/${bot}?start=${LINK_START_PREFIX}${nonce}`;
}

/** A fresh link nonce for this user; any earlier one stops working. */
export async function startLink(db: D1Database, userId: number): Promise<string> {
  const nonce = newLinkNonce();
  await db.batch([
    db.prepare("DELETE FROM telegram_codes WHERE kind = 'link' AND user_id = ?").bind(userId),
    db.prepare(
      `INSERT INTO telegram_codes (kind, code, user_id, attempts, expires_at)
       VALUES ('link', ?, ?, 0, datetime('now', ?))`
    ).bind(nonce, userId, `+${LINK_TTL_SECONDS} seconds`),
  ]);
  return nonce;
}

/** Where the link started by this user stands. A nonce issued to someone else reads as expired. */
export async function linkStatus(db: D1Database, userId: number, nonce: string): Promise<TelegramLinkStatus> {
  const [row, account] = await Promise.all([
    db.prepare(
      `SELECT attempts, expires_at > datetime('now') AS live FROM telegram_codes
        WHERE kind = 'link' AND code = ? AND user_id = ?`
    ).bind(nonce, userId).first<{ attempts: number; live: number }>(),
    db.prepare("SELECT * FROM telegram_accounts WHERE user_id = ?").bind(userId).first<{ username?: string | null }>(),
  ]);
  if (row && !row.attempts) return row.live ? { state: "pending" } : { state: "expired" };
  if (account) return { state: "linked", username: account.username ?? null };
  return { state: row ? "refused" : "expired" };
}

// ---------- the bot side ----------

export interface LinkEnv {
  db: D1Database;
  /** The web origin (e.g. https://way.peiyong.ai) for the [Change times] button. */
  origin: string;
}

/** `/start <args>` → the reply when args is a link payload, or null when it is not one (plain /start etc.). */
export async function redeemLink(env: LinkEnv, args: string, message: TgMessage): Promise<Reply | null> {
  if (!args.startsWith(LINK_START_PREFIX)) return null;
  const nonce = args.slice(LINK_START_PREFIX.length);
  const from = message.from;
  if (!isLinkNonce(nonce) || !from) return EXPIRED;

  const { db } = env;
  const code = await db.prepare(
    `UPDATE telegram_codes SET attempts = 1
      WHERE kind = 'link' AND code = ? AND attempts = 0 AND expires_at > datetime('now')
      RETURNING user_id`
  ).bind(nonce).first<{ user_id: number }>();
  if (!code) return EXPIRED;
  const userId = code.user_id;

  const other = await db.prepare("SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ? AND user_id != ?")
    .bind(from.id, userId).first();
  if (other) return TAKEN;

  try {
    await db.batch([
      // Re-linking the same identity keeps verified_login; a different identity has to prove itself again.
      db.prepare(
        `INSERT INTO telegram_accounts (user_id, telegram_user_id, chat_id, username, first_name)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           verified_login = CASE WHEN telegram_user_id = excluded.telegram_user_id THEN verified_login ELSE 0 END,
           telegram_user_id = excluded.telegram_user_id, chat_id = excluded.chat_id,
           username = excluded.username, first_name = excluded.first_name, paused_until = NULL`
      ).bind(userId, from.id, message.chat.id, from.username ?? null, from.first_name ?? null),
      db.prepare("INSERT OR IGNORE INTO telegram_prefs (user_id) VALUES (?)").bind(userId),
    ]);
  } catch (e) {
    // Lost a race with another account linking the same Telegram identity.
    if (String(e).includes("UNIQUE")) return TAKEN;
    throw e;
  }
  return welcome(env, userId, from.first_name);
}

const EXPIRED: Reply = {
  text: "这个连接已失效或已用过 · This link has expired or was already used.\n" +
    "回到 Way 的设置页重新连接 · Start again from Settings in Way.",
};

const TAKEN: Reply = {
  text: "这个 Telegram 账号已连接了另一个 Way 账号 · This Telegram account is already linked to another Way account.\n" +
    "先在那个账号的设置里断开，再来连接 · Disconnect it in that account's Settings first.",
};

async function welcome(env: LinkEnv, userId: number, firstName: string | undefined): Promise<Reply> {
  const [prefs, user] = await Promise.all([
    env.db.prepare("SELECT * FROM telegram_prefs WHERE user_id = ?").bind(userId)
      .first<{ morning_at?: string | null; review_at?: string | null }>(),
    env.db.prepare("SELECT timezone FROM users WHERE id = ?").bind(userId).first<{ timezone: string | null }>(),
  ]);
  const slot = (v: string | null | undefined) => v || "关 off";
  return {
    text: [
      `已连接 · Connected${firstName ? `, ${firstName}` : ""}。`,
      "",
      "默认安排 · Your schedule",
      `☀️ 晨报 Morning brief — ${slot(prefs?.morning_at)}`,
      `🌙 晚间复盘 Evening review — ${slot(prefs?.review_at)}`,
      `🕐 时区 Time zone — ${user?.timezone || "UTC"}`,
      "",
      "随手发一句话，就收进 Inbox · Send me anything and it goes to your inbox.",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[
        { text: "⏰ 改时间 Change times", url: `${env.origin}/settings` },
        { text: "☀️ 今日晨报 Send me today's brief", callback_data: cb.brief() },
      ]],
    },
  };
}
