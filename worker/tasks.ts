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

export const TASK_FIELDS = ["title", "description", "date", "inbox", "priority", "energy", "estimate_min", "actual_min",
  "start_min", "end_min", "goal_id", "project_id", "repeat", "notes", "done", "dropped"] as const;

/** Partial update over the TASK_FIELDS whitelist (PUT /api/tasks/:id and the Telegram buttons). Returns the row, or null if not the user's. */
export async function updateTask<T = Record<string, unknown>>(
  db: D1Database, userId: number, id: number, b: Record<string, unknown>
): Promise<T | null> {
  for (const f of TASK_FIELDS) {
    if (f in b) {
      await db.prepare(`UPDATE tasks SET ${f} = ? WHERE id = ? AND user_id = ?`).bind(b[f], id, userId).run();
    }
  }
  if ("done" in b) {
    await db.prepare("UPDATE tasks SET done_at = CASE WHEN done = 1 THEN datetime('now') ELSE NULL END WHERE id = ? AND user_id = ?")
      .bind(id, userId).run();
  }
  return db.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(id, userId).first<T>();
}

/** Returns rows deleted (0 when the id is unknown or another user's). */
export async function deleteTask(db: D1Database, userId: number, id: number): Promise<number> {
  const res = await db.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return res.meta.changes;
}

/** Unscheduled capture: inbox = 1, date = NULL. */
export async function captureToInbox(db: D1Database, userId: number, title: string): Promise<{ id: number; title: string }> {
  const row = await db.prepare("INSERT INTO tasks (user_id, title, date, inbox) VALUES (?, ?, NULL, 1) RETURNING id, title")
    .bind(userId, title).first<{ id: number; title: string }>();
  if (!row) throw new Error("capture failed");
  return row;
}
