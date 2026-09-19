// Telegram preferences (PRD §9) edited from the Settings card: the scheduler (schedule.ts) reads these slots
// on every tick, so a change here is what the next delivery uses.
//
// Schema assumed from #2/#4: telegram_prefs(user_id PRIMARY KEY, morning_at, review_at, quiet_from, quiet_to
// — 'HH:MM' local, NULL = off — and nudges INTEGER 0/1), with every column but user_id nullable or defaulted;
// users.timezone (IANA; NULL = UTC).

import { BadInput, coerceFields, flag, type Coerce, type FieldSpecs } from "../validate.ts";
import { normalizeTimeZone } from "./time.ts";

/** 'HH:MM' (24 h) or null = off. */
const hhmmOrNull: Coerce = (v, f) => {
  if (v === null || v === "") return null;
  if (typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v)) return v;
  throw new BadInput(`${f} must be an HH:MM time or null`);
};

export const TELEGRAM_PREF_FIELDS: FieldSpecs = {
  morning_at: hhmmOrNull, review_at: hhmmOrNull, quiet_from: hhmmOrNull, quiet_to: hhmmOrNull, nudges: flag,
};

/** An IANA zone the runtime knows, or null (= UTC). Throws BadInput otherwise. */
export function timezoneOrNull(v: unknown): string | null {
  if (v === null || v === "") return null;
  const zone = typeof v === "string" ? normalizeTimeZone(v) : null;
  if (zone) return zone;
  throw new BadInput("timezone must be an IANA time zone (e.g. Asia/Dubai) or null");
}

/**
 * Partial update over TELEGRAM_PREF_FIELDS (PUT /api/telegram/prefs); creates the prefs row if missing.
 * `timezone` in the same body goes to users.timezone. Everything is validated before anything is written.
 */
export async function updateTelegramPrefs(db: D1Database, userId: number, b: Record<string, unknown>): Promise<void> {
  const values = coerceFields(b, TELEGRAM_PREF_FIELDS);
  const timezone = "timezone" in b ? timezoneOrNull(b.timezone) : undefined;
  if (values.length) {
    await db.prepare("INSERT OR IGNORE INTO telegram_prefs (user_id) VALUES (?)").bind(userId).run();
    for (const [f, v] of values) {
      await db.prepare(`UPDATE telegram_prefs SET ${f} = ? WHERE user_id = ?`).bind(v, userId).run();
    }
  }
  if (timezone !== undefined) {
    await db.prepare("UPDATE users SET timezone = ? WHERE id = ?").bind(timezone, userId).run();
  }
}
