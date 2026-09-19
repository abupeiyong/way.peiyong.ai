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
