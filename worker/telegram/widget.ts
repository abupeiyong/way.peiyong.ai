// Sign in with the Telegram Login Widget (PRD §5.2(a), §11.2). The bot token is the signing key, so one
// shared bot authenticates every user; BotFather needs `/setdomain way.peiyong.ai` once.
//   secret       = SHA256(bot_token)                  raw bytes
//   check_string = sorted "key=value" lines joined by "\n", excluding hash
//   expected     = HMAC_SHA256(check_string, secret)  hex, compared to hash in constant time
// and auth_date must be at most WIDGET_MAX_AGE_SECONDS old.
//
// Schema assumed from #2: telegram_accounts(user_id, telegram_user_id, chat_id, verified_login).

import { timingSafeEqual } from "../auth.ts";

export const WIDGET_MAX_AGE_SECONDS = 300;
/** Tolerated clock skew for an auth_date slightly ahead of ours. */
const WIDGET_FUTURE_SKEW_SECONDS = 60;

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The Telegram user id the widget payload vouches for, or null (malformed, tampered, or stale).
 * `data` is the object the widget hands to data-onauth, posted as-is.
 */
export async function verifyWidgetLogin(botToken: string, data: unknown, nowSeconds: number): Promise<number | null> {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const { hash } = fields;
  if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;

  const lines: string[] = [];
  for (const key of Object.keys(fields).sort()) {
    if (key === "hash") continue;
    const value = fields[key];
    if (typeof value !== "string" && typeof value !== "number") return null;
    lines.push(`${key}=${value}`);
  }

  const enc = new TextEncoder();
  const secret = await crypto.subtle.digest("SHA-256", enc.encode(botToken));
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = toHex(await crypto.subtle.sign("HMAC", key, enc.encode(lines.join("\n"))));
  if (!timingSafeEqual(expected, hash)) return null;

  const authDate = Number(fields.auth_date);
  if (!Number.isInteger(authDate)) return null;
  const age = nowSeconds - authDate;
  if (age > WIDGET_MAX_AGE_SECONDS || age < -WIDGET_FUTURE_SKEW_SECONDS) return null;

  const id = Number(fields.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
