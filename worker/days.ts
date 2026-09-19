// Day-row writes shared by the HTTP API and the Telegram evening review,
// so a tap and a click go through the same SQL.

export const DAY_FIELDS = ["intention", "reflection", "mood", "energy", "focus", "satisfaction",
  "top1", "top1_done", "top2", "top2_done", "top3", "top3_done"] as const;

/** Partial update over the DAY_FIELDS whitelist (PUT /api/day/:date); creates the row if missing. */
export async function updateDay(db: D1Database, userId: number, date: string, b: Record<string, unknown>): Promise<void> {
  await db.prepare("INSERT OR IGNORE INTO days (user_id, date) VALUES (?, ?)").bind(userId, date).run();
  for (const f of DAY_FIELDS) {
    if (f in b) {
      await db.prepare(`UPDATE days SET ${f} = ? WHERE user_id = ? AND date = ?`).bind(b[f], userId, date).run();
    }
  }
}
