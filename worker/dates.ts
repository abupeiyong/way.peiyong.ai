// Calendar arithmetic on YYYY-MM-DD strings. No "now" in here: whoever calls decides what today is
// (the request's date, or users.timezone via telegram/time.ts). Weeks start on Monday.

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

/** Monday of the week containing date. */
export function weekStartOf(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  d.setUTCDate(d.getUTCDate() - dow);
  return isoDate(d);
}

export function monthStartOf(dateStr: string): string {
  return dateStr.slice(0, 7) + "-01";
}

/** 0 = Sunday … 6 = Saturday, for a YYYY-MM-DD string. */
export function weekdayOf(dateStr: string): number {
  return new Date(dateStr + "T00:00:00Z").getUTCDay();
}

export function periodRange(view: string, anchor: string): { start: string; end: string } {
  const d = new Date(anchor + "T00:00:00Z");
  const y = d.getUTCFullYear();
  if (view === "week") {
    const start = weekStartOf(anchor);
    return { start, end: addDays(start, 6) };
  }
  if (view === "month") {
    const start = `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const endD = new Date(Date.UTC(y, d.getUTCMonth() + 1, 0));
    return { start, end: isoDate(endD) };
  }
  if (view === "quarter") {
    const q = Math.floor(d.getUTCMonth() / 3);
    const start = isoDate(new Date(Date.UTC(y, q * 3, 1)));
    const end = isoDate(new Date(Date.UTC(y, q * 3 + 3, 0)));
    return { start, end };
  }
  return { start: `${y}-01-01`, end: `${y}-12-31` };
}

export function reviewPeriodStart(period: string, todayStr: string): string {
  const d = new Date(todayStr + "T00:00:00Z");
  const y = d.getUTCFullYear();
  switch (period) {
    case "daily": return todayStr;
    case "weekly": return weekStartOf(todayStr);
    case "monthly": return `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
    case "quarterly": return isoDate(new Date(Date.UTC(y, Math.floor(d.getUTCMonth() / 3) * 3, 1)));
    default: return `${y}-01-01`;
  }
}

export function reviewPeriodEnd(period: string, startStr: string): string {
  const d = new Date(startStr + "T00:00:00Z");
  switch (period) {
    case "daily": return startStr;
    case "weekly": return addDays(startStr, 6);
    case "monthly": return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
    case "quarterly": return isoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, 0)));
    default: return `${d.getUTCFullYear()}-12-31`;
  }
}
