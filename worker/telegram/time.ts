// Local wall-clock time in a user's IANA zone (users.timezone; NULL = UTC), via Intl.DateTimeFormat.
// Server "today" comes from here, not from the UTC clock: /api/reviews, /api/insights, guideContext,
// the scheduler (schedule.ts) and the bot (webhook.ts).

export interface LocalNow {
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, 24 h */
  time: string;
  /** Minutes since local midnight. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall clock in `timeZone` at `at`. Throws RangeError on an unknown zone. */
export function localNow(timeZone: string, at: Date = new Date()): LocalNow {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short",
    }).formatToParts(at).map((p) => [p.type, p.value])
  );
  const time = `${parts.hour}:${parts.minute}`;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
    weekday: WEEKDAY_INDEX[parts.weekday],
  };
}

export const localDate = (timeZone: string, at: Date = new Date()) => localNow(timeZone, at).date;
export const localTime = (timeZone: string, at: Date = new Date()) => localNow(timeZone, at).time;
export const localWeekday = (timeZone: string, at: Date = new Date()) => localNow(timeZone, at).weekday;

/** Today (YYYY-MM-DD) for a users.timezone value: NULL, or a zone the runtime no longer knows, falls back to UTC. */
export function userToday(timeZone: string | null | undefined, at: Date = new Date()): string {
  try {
    return localDate(timeZone || "UTC", at);
  } catch {
    return localDate("UTC", at);
  }
}

/**
 * `v` as a storable IANA zone, or null when it is not one. Checked against Intl.supportedValuesOf("timeZone");
 * "UTC" and aliases the list leaves out (e.g. Asia/Kolkata where ICU lists Asia/Calcutta) are accepted
 * when Intl.DateTimeFormat resolves them, and stored under the name it resolves to.
 */
export function normalizeTimeZone(v: string): string | null {
  if (v === "UTC" || Intl.supportedValuesOf("timeZone").includes(v)) return v;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}
