// telegram_state (PRD §8): what the bot is waiting for from one user — a JSON payload with an expiry.
// One slot per user. Each flow tags its payload with a `kind` and treats anyone else's payload as absent.
// The webhook backs this with the telegram_state table (#4); an expired row reads as null.

export interface TelegramStateStore {
  /** The pending payload, or null when there is none or it has expired. */
  get(): Promise<unknown>;
  /** Replace the payload; it expires `ttlSeconds` from now. */
  put(payload: object, ttlSeconds: number): Promise<void>;
  clear(): Promise<void>;
}

/**
 * The D1-backed slot. Assumes the #4 table shape: telegram_state(user_id PRIMARY KEY, payload TEXT JSON,
 * expires_at TEXT in SQLite datetime() format).
 */
export function d1StateStore(db: D1Database, userId: number): TelegramStateStore {
  return {
    async get() {
      const row = await db.prepare("SELECT payload FROM telegram_state WHERE user_id = ? AND expires_at > datetime('now')")
        .bind(userId).first<{ payload: string }>();
      if (!row) return null;
      try { return JSON.parse(row.payload); } catch { return null; }
    },
    async put(payload, ttlSeconds) {
      await db.prepare(
        `INSERT INTO telegram_state (user_id, payload, expires_at) VALUES (?, ?, datetime('now', ?))
         ON CONFLICT (user_id) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at`
      ).bind(userId, JSON.stringify(payload), `+${Math.max(0, Math.round(ttlSeconds))} seconds`).run();
    },
    async clear() {
      await db.prepare("DELETE FROM telegram_state WHERE user_id = ?").bind(userId).run();
    },
  };
}
