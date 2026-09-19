// Sign in with a deep link (PRD §5.2(b), #28): the login page mints a nonce bound to the browser's
// way_pending cookie and opens https://t.me/<bot>?start=login_<nonce>; the bot shows who is asking
// (country and browser, from the request that minted it) and the user approves or denies with a button.
// The page polls until the nonce is approved, then gets its session. A nonce works once, for 5 minutes,
// and only in the browser that asked — a phished link approved elsewhere signs nobody in.
//
// telegram_codes rows with kind 'login': attempts 0 = pending, 1 = approved (user_id = who approved),
// 2 = denied; the row is deleted when the page collects the session.

import { newLinkNonce } from "./link.ts";
import type { CallbackContext } from "./callback.ts";
import { cb } from "./callback.ts";
import { logEvent } from "./events.ts";
import type { Reply } from "./router.ts";

export const LOGIN_TTL_SECONDS = 300;
export const LOGIN_START_PREFIX = "login_";

export interface LoginMeta {
  country: string;
  browser: string;
}

export function loginUrl(bot: string, nonce: string): string {
  return `https://t.me/${bot}?start=${LOGIN_START_PREFIX}${nonce}`;
}

/** The login page asked: a pending nonce for this browser. Any earlier one for the browser is dropped. */
export async function startLoginRequest(db: D1Database, browserToken: string, meta: LoginMeta): Promise<string> {
  const nonce = newLinkNonce();
  await db.batch([
    db.prepare("DELETE FROM telegram_codes WHERE kind = 'login' AND browser_token = ?").bind(browserToken),
    db.prepare(
      `INSERT INTO telegram_codes (kind, code, browser_token, meta, attempts, expires_at)
       VALUES ('login', ?, ?, ?, 0, datetime('now', ?))`
    ).bind(nonce, browserToken, JSON.stringify(meta), `+${LOGIN_TTL_SECONDS} seconds`),
  ]);
  return nonce;
}

/** A readable "Chrome on macOS" from a User-Agent, without a parser library. */
export function describeBrowser(ua: string | undefined): string {
  if (!ua) return "unknown browser";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "a browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "macOS"
    : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export type LoginPoll =
  | { state: "pending" }
  | { state: "approved"; userId: number }
  | { state: "denied" }
  | { state: "expired" };

/** The page's poll. Approved rows are consumed here (deleted), so the session is minted once. */
export async function pollLogin(db: D1Database, browserToken: string, code: string): Promise<LoginPoll> {
  const row = await db.prepare(
    `SELECT id, attempts, user_id, expires_at > datetime('now') AS live FROM telegram_codes
      WHERE kind = 'login' AND code = ? AND browser_token = ?`
  ).bind(code, browserToken).first<{ id: number; attempts: number; user_id: number | null; live: number }>();
  if (!row || !row.live) return { state: "expired" };
  if (row.attempts === 2) return { state: "denied" };
  if (row.attempts === 1 && row.user_id) {
    const used = await db.prepare("DELETE FROM telegram_codes WHERE id = ? AND attempts = 1 RETURNING user_id")
      .bind(row.id).first<{ user_id: number }>();
    return used ? { state: "approved", userId: used.user_id } : { state: "expired" };
  }
  return { state: "pending" };
}

// ---------- the bot side ----------

const EXPIRED: Reply = { text: "这个登录链接已失效 · This sign-in link has expired.\n回到登录页重新开始 · Start again from the sign-in page." };

/** `/start login_<nonce>` from a linked chat: show where the request came from and ask. */
export async function loginRequest(ctx: Pick<CallbackContext, "db" | "userId" | "send">, args: string): Promise<boolean> {
  if (!args.startsWith(LOGIN_START_PREFIX)) return false;
  const nonce = args.slice(LOGIN_START_PREFIX.length);
  const row = await ctx.db.prepare(
    "SELECT id, meta FROM telegram_codes WHERE kind = 'login' AND code = ? AND attempts = 0 AND expires_at > datetime('now')"
  ).bind(nonce).first<{ id: number; meta: string | null }>();
  if (!row) {
    await ctx.send(EXPIRED);
    return true;
  }
  let meta: Partial<LoginMeta> = {};
  try { meta = JSON.parse(row.meta ?? "{}"); } catch { meta = {}; }
  await ctx.send({
    text: [
      "🔐 有人正在登录你的 Way 账号 · Someone is signing in to your Way account",
      "",
      `来自 · From: ${meta.country || "unknown location"} · ${meta.browser || "unknown browser"}`,
      "",
      "是你吗？ · Is this you? 5 分钟内有效 · valid for 5 minutes",
    ].join("\n"),
    reply_markup: {
      inline_keyboard: [[
        { text: "✓ 是我，登录 Yes, sign in", callback_data: cb.login(row.id, true) },
        { text: "✗ 不是 No", callback_data: cb.login(row.id, false) },
      ]],
    },
  });
  return true;
}

/** lg:<id>:y|n — decide once; the row records who approved, and the page's poll collects it. */
export async function loginDecide(ctx: CallbackContext, codeId: number, approve: boolean): Promise<string> {
  const r = await ctx.db.prepare(
    "UPDATE telegram_codes SET attempts = ?, user_id = ? WHERE id = ? AND kind = 'login' AND attempts = 0 AND expires_at > datetime('now')"
  ).bind(approve ? 1 : 2, ctx.userId, codeId).run();
  if (!r.meta.changes) {
    await ctx.finish("这个登录请求已失效或已处理 · This sign-in request has expired or was already answered.");
    return "已失效 · Expired";
  }
  await logEvent(ctx.db, ctx.userId, "login", "used");
  if (approve) {
    await ctx.finish("✓ 已批准 · Approved — 网页几秒内会登录 · the page will sign in within a few seconds.");
    return "已批准 · Approved";
  }
  await ctx.finish("✗ 已拒绝 · Denied.\n如果不是你发起的，建议在网页设置里检查安全选项 · If this wasn't you, check Security in Settings.");
  return "已拒绝 · Denied";
}
