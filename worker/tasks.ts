// Task operations shared by the HTTP API and the Telegram button handlers,
// so a tap and a click go through the same SQL.

export type CarryAction = "forward" | "drop";

/** Past undone one-off tasks before `date`: bring them forward to `date`, or let them go. Returns rows changed. */
export async function carryOver(db: D1Database, userId: number, date: string, action: CarryAction): Promise<number> {
  const res = action === "forward"
    ? await db.prepare(
        "UPDATE tasks SET date = ?, start_min = NULL, end_min = NULL, carried = carried + 1 WHERE user_id = ? AND inbox = 0 AND done = 0 AND dropped = 0 AND date < ? AND repeat = 'never'"
      ).bind(date, userId, date).run()
    : await db.prepare(
        "UPDATE tasks SET dropped = 1 WHERE user_id = ? AND inbox = 0 AND done = 0 AND dropped = 0 AND date < ? AND repeat = 'never'"
      ).bind(userId, date).run();
  return res.meta.changes;
}
