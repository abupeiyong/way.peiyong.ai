// Account creation shared by POST /api/auth/register and the Telegram bot's "create a Way account",
// so both seed the same nine life areas.

export const DEFAULT_AREAS: [string, string][] = [
  ["Health", "#6b9080"],
  ["Family", "#c98a6d"],
  ["Career", "#5c7a99"],
  ["Wealth", "#b98a3c"],
  ["Learning", "#7d6b99"],
  ["Relationships", "#a86458"],
  ["Inner Growth", "#4d7048"],
  ["Lifestyle", "#c0a161"],
  ["Contribution", "#699099"],
];

/** Sentinel domain for accounts created from Telegram that have no email (users.email is NOT NULL UNIQUE). */
export const TELEGRAM_ONLY_DOMAIN = "way.invalid";

export function telegramOnlyEmail(telegramUserId: number): string {
  return `telegram-${telegramUserId}@${TELEGRAM_ONLY_DOMAIN}`;
}

export function isTelegramOnlyEmail(email: string): boolean {
  return email.endsWith(`@${TELEGRAM_ONLY_DOMAIN}`);
}

export interface NewUser {
  email: string;
  name: string;
  passwordHash: string;
  timezone?: string | null;
  /** Telegram-only accounts have no usable password: password sign-in is off from birth. */
  passwordLoginDisabled?: boolean;
}

/** Insert the user and seed DEFAULT_AREAS. Returns the new id. Throws on a duplicate email (UNIQUE). */
export async function createUser(db: D1Database, u: NewUser): Promise<number> {
  const row = await db.prepare(
    "INSERT INTO users (email, name, password_hash, timezone, password_login_disabled) VALUES (?, ?, ?, ?, ?) RETURNING id"
  ).bind(u.email, u.name, u.passwordHash, u.timezone ?? null, u.passwordLoginDisabled ? 1 : 0).first<{ id: number }>();
  if (!row) throw new Error("could not create the user");
  await db.batch(DEFAULT_AREAS.map(([n, color], i) =>
    db.prepare("INSERT INTO areas (user_id, name, color, sort) VALUES (?, ?, ?, ?)").bind(row.id, n, color, i)
  ));
  return row.id;
}
