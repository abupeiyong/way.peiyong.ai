// /task micro-syntax (PRD §7.2, #20):
//   /task 明天 call the bank @Financial runway #30m !must
//   leading date  → 今天 / 明天 / 后天 / today / tomorrow / 周五 / 星期五 / fri / friday / 2026-09-25 / 9-25
//   #30m #2h      → estimate_min           !must !should !could → priority
//   @goal words   → a goal title fragment (matched against the user's active goals by the caller)
// Whatever is left, with spaces collapsed, is the title. Nothing is dropped silently: an unparsed
// token stays in the title.

import type { Priority } from "../../shared/types.ts";
import { shiftDate } from "./callback.ts";

export interface ParsedTask {
  title: string;
  /** YYYY-MM-DD; null = no date given (the caller decides: today for /task). */
  date: string | null;
  estimate_min: number | null;
  priority: Priority | null;
  /** Text after `@`, up to the next `#…`/`!…` token; null when absent. */
  goalQuery: string | null;
}

const WEEKDAYS: Record<string, number> = {
  "日": 0, "天": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function weekdayOf(date: string): number {
  return new Date(date + "T00:00:00Z").getUTCDay();
}

/** The next date (today included) falling on `dow`. */
function nextWeekday(today: string, dow: number): string {
  const diff = (dow - weekdayOf(today) + 7) % 7;
  return shiftDate(today, diff);
}

/** A leading date word/number → [date, rest], or null when the text does not start with one. */
export function leadingDate(text: string, today: string): [string, string] | null {
  const s = text.trim();
  let m: RegExpExecArray | null;
  if ((m = /^(今天|今日|today(?![a-z]))\s*/iu.exec(s))) return [today, s.slice(m[0].length)];
  if ((m = /^(明天|明日|tomorrow(?![a-z])|tmr(?![a-z]))\s*/iu.exec(s))) return [shiftDate(today, 1), s.slice(m[0].length)];
  if ((m = /^(后天|day after tomorrow)\s*/iu.exec(s))) return [shiftDate(today, 2), s.slice(m[0].length)];
  if ((m = /^(?:周|星期|礼拜)([一二三四五六日天])\s*/u.exec(s))) return [nextWeekday(today, WEEKDAYS[m[1]]), s.slice(m[0].length)];
  if ((m = /^(sun|mon|tue|wed|thu|fri|sat)(?:day|sday|nesday|rsday|urday)?\b\s*/i.exec(s))) {
    return [nextWeekday(today, WEEKDAYS[m[1].toLowerCase()]), s.slice(m[0].length)];
  }
  if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})\s*/.exec(s))) {
    const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    return isRealDate(date) ? [date, s.slice(m[0].length)] : null;
  }
  if ((m = /^(\d{1,2})[/-](\d{1,2})\s+/.exec(s))) {
    // M-D or M/D in the current year; if that day already passed, next year.
    let date = `${today.slice(0, 4)}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
    if (!isRealDate(date)) return null;
    if (date < today) date = `${Number(today.slice(0, 4)) + 1}${date.slice(4)}`;
    return [date, s.slice(m[0].length)];
  }
  return null;
}

function isRealDate(s: string): boolean {
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseTaskInput(text: string, today: string): ParsedTask {
  let rest = text.trim();
  let date: string | null = null;
  const led = leadingDate(rest, today);
  if (led) [date, rest] = led;

  let estimate: number | null = null;
  rest = rest.replace(/(?:^|\s)#(\d{1,4})\s*(m|min|mins|h|hr|hrs|分钟|分|小时)?(?=\s|$)/iu, (_, n: string, unit?: string) => {
    const v = Number(n);
    estimate = unit && /^(h|hr|hrs|小时)$/i.test(unit) ? v * 60 : v;
    return " ";
  });

  let priority: Priority | null = null;
  rest = rest.replace(/(?:^|\s)!(must|should|could)(?=\s|$)/i, (_, p: string) => {
    priority = p.toLowerCase() as Priority;
    return " ";
  });

  let goalQuery: string | null = null;
  rest = rest.replace(/(?:^|\s)@([^#!@]+?)(?=\s[#!]|$)/u, (_, g: string) => {
    goalQuery = g.trim() || null;
    return " ";
  });

  return {
    title: rest.replace(/\s+/g, " ").trim(),
    date,
    estimate_min: estimate,
    priority,
    goalQuery,
  };
}
