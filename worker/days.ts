// Day-row writes shared by the HTTP API and the Telegram evening review,
// so a tap and a click go through the same SQL.

import { coerceFields, flag, int, text, type FieldSpecs } from "./validate.ts";

const rating = int(1, 5);

export const DAY_FIELDS: FieldSpecs = {
  intention: text, reflection: text, mood: rating, energy: rating, focus: rating, satisfaction: rating,
  top1: text, top1_done: flag, top2: text, top2_done: flag, top3: text, top3_done: flag,
};

/** Partial update over the DAY_FIELDS whitelist (PUT /api/day/:date); creates the row if missing. Throws BadInput on a bad field. */
export async function updateDay(db: D1Database, userId: number, date: string, b: Record<string, unknown>): Promise<void> {
  const values = coerceFields(b, DAY_FIELDS);
  await db.prepare("INSERT OR IGNORE INTO days (user_id, date) VALUES (?, ?)").bind(userId, date).run();
  for (const [f, v] of values) {
    await db.prepare(`UPDATE days SET ${f} = ? WHERE user_id = ? AND date = ?`).bind(v, userId, date).run();
  }
}
