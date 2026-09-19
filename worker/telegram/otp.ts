// Sign in with a Telegram code (PRD §5.2(c), §11.2): the fallback when the Login Widget is blocked.
//   issue  → email → linked chat → "Your Way code: 418 233"; one live code per user, 5-minute TTL.
//            The row is bound to the browser's way_pending token, so a phished code is useless elsewhere.
//            Unknown / unlinked emails do nothing; the caller answers identically either way.
//   redeem → every attempt is counted before the code is compared (atomic UPDATE … attempts < 5), so
//            concurrent guesses cannot exceed the budget; the fifth wrong guess deletes the code, and a
//            correct one deletes it too (single use — only one DELETE can win).
//
// Schema assumed from #4: telegram_codes(kind, code, user_id, browser_token, attempts DEFAULT 0, expires_at)
// with expires_at in SQLite datetime() format; telegram_accounts(user_id, chat_id, verified_login).

import { newOtpCode, timingSafeEqual } from "../auth.ts";
import { sendMessage } from "./schedule.ts";

export const OTP_TTL_SECONDS = 300;
export const OTP_MAX_ATTEMPTS = 5;

/** Look up the linked chat and send it a fresh code. Silent when there is nothing to send to. */
export async function issueOtp(db: D1Database, botToken: string | undefined, email: string, browserToken: string): Promise<void> {
  if (!botToken) return;
  const account = await db.prepare(
    `SELECT a.user_id, a.chat_id FROM users u JOIN telegram_accounts a ON a.user_id = u.id WHERE u.email = ?`
  ).bind(email).first<{ user_id: number; chat_id: number | string }>();
  if (!account) return;

  const code = newOtpCode();
  await db.batch([
    db.prepare("DELETE FROM telegram_codes WHERE kind = 'otp' AND user_id = ?").bind(account.user_id),
    db.prepare(
      `INSERT INTO telegram_codes (kind, code, user_id, browser_token, attempts, expires_at)
       VALUES ('otp', ?, ?, ?, 0, datetime('now', ?))`
    ).bind(code, account.user_id, browserToken, `+${OTP_TTL_SECONDS} seconds`),
  ]);
  try {
    await sendMessage(botToken, account.chat_id, {
      text: `Your Way code: ${code.slice(0, 3)} ${code.slice(3)}\nIt expires in 5 minutes. Didn't ask for it? Ignore this message.`,
    });
  } catch (e) {
    await db.prepare("DELETE FROM telegram_codes WHERE kind = 'otp' AND browser_token = ?").bind(browserToken).run();
    throw e;
  }
}

/** The user id the code signs in as, or null (wrong, expired, used up, or issued to another browser). */
export async function redeemOtp(db: D1Database, browserToken: string, input: string): Promise<number | null> {
  const guess = input.replace(/\D/g, "");
  const row = await db.prepare(
    `UPDATE telegram_codes SET attempts = attempts + 1
      WHERE kind = 'otp' AND browser_token = ? AND expires_at > datetime('now') AND attempts < ?
      RETURNING code, attempts`
  ).bind(browserToken, OTP_MAX_ATTEMPTS).first<{ code: string; attempts: number }>();
  if (!row) return null;

  if (guess.length !== 6 || !timingSafeEqual(guess, String(row.code).padStart(6, "0"))) {
    if (row.attempts >= OTP_MAX_ATTEMPTS) {
      await db.prepare("DELETE FROM telegram_codes WHERE kind = 'otp' AND browser_token = ?").bind(browserToken).run();
    }
    return null;
  }
  const used = await db.prepare(
    "DELETE FROM telegram_codes WHERE kind = 'otp' AND browser_token = ? AND expires_at > datetime('now') RETURNING user_id"
  ).bind(browserToken).first<{ user_id: number }>();
  return used?.user_id ?? null;
}
