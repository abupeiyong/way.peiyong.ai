// Task operations shared by the HTTP API and the Telegram button handlers,
// so a tap and a click go through the same SQL.

import type { Energy, Priority, Repeat } from "../shared/types.ts";
import { coerceFields, dateOrNull, flag, idOrNull, int, nonEmptyText, oneOf, text, type FieldSpecs } from "./validate.ts";

const PRIORITIES: Priority[] = ["must", "should", "could"];
const ENERGIES: Energy[] = ["low", "medium", "high"];
const REPEATS: Repeat[] = ["never", "daily", "weekly"];

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

const minutes = int(0, 7 * 24 * 60);

export const TASK_FIELDS: FieldSpecs = {
  title: nonEmptyText, description: text, date: dateOrNull, inbox: flag,
  priority: oneOf(PRIORITIES), energy: oneOf(ENERGIES, true),
  estimate_min: minutes, actual_min: minutes, start_min: minutes, end_min: minutes,
  goal_id: idOrNull, project_id: idOrNull, repeat: oneOf(REPEATS), notes: text, done: flag, dropped: flag,
};

/** Partial update over the TASK_FIELDS whitelist (PUT /api/tasks/:id and the Telegram buttons). Returns the row, or null if not the user's. Throws BadInput on a bad field. */
export async function updateTask<T = Record<string, unknown>>(
  db: D1Database, userId: number, id: number, b: Record<string, unknown>
): Promise<T | null> {
  for (const [f, v] of coerceFields(b, TASK_FIELDS)) {
    await db.prepare(`UPDATE tasks SET ${f} = ? WHERE id = ? AND user_id = ?`).bind(v, id, userId).run();
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

/** Materialize repeating tasks into concrete instances for one date (GET /api/day and the morning message). */
export async function materializeRepeats(db: D1Database, userId: number, date: string) {
  const dow = new Date(date + "T00:00:00Z").getUTCDay();
  const { results } = await db
    .prepare(
      `SELECT * FROM tasks
       WHERE user_id = ? AND repeat != 'never' AND repeat_src IS NULL AND dropped = 0
         AND date IS NOT NULL AND date <= ?`
    )
    .bind(userId, date)
    .all<Record<string, unknown>>();
  for (const t of results) {
    if (t.date === date) continue;
    const tDow = new Date((t.date as string) + "T00:00:00Z").getUTCDay();
    if (t.repeat === "weekly" && tDow !== dow) continue;
    const dup = await db
      .prepare("SELECT id FROM tasks WHERE user_id = ? AND repeat_src = ? AND date = ?")
      .bind(userId, t.id, date)
      .first();
    if (dup) continue;
    await db
      .prepare(
        `INSERT INTO tasks (user_id, title, description, date, priority, energy, estimate_min, start_min, end_min,
                            goal_id, project_id, repeat, repeat_src, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'never', ?, ?)`
      )
      .bind(userId, t.title, t.description, date, t.priority, t.energy, t.estimate_min, t.start_min, t.end_min,
            t.goal_id, t.project_id, t.id, t.notes)
      .run();
  }
}
