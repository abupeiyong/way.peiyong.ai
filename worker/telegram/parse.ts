// Shape parsers (docs/PRD-brain.md §8.2) — the deterministic half of "the model never produces a
// stored value" (§4 R1). When the system asked the question, the expected shape is known, so reading
// the answer is not an NLU problem: it is one small parser per shape, each testable to exhaustion.
//
// A model may decide *which* stream a message belongs to. The value always comes from here, out of the
// user's own text. That kills the whole class of bug where a model quietly returns 44 for "45 分钟".
//
// `npm run check:parse` runs the cases.

import { BASE_UNIT, SHAPE_BOUNDS, normalise, type Shape } from "../../shared/streams.ts";

export interface ParseResult {
  /** The value in the stream's base unit (minutes for duration, 0/1 for bool). */
  num: number | null;
  /** shape = text. */
  text?: string;
  /** The user declined: "没读" / "skip" / "没有". Logged as 0 (or not at all, the caller decides). */
  declined?: boolean;
}

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

/** 一 二十 二十五 半 — enough for the numbers people actually type at a bot. */
function cnNumber(s: string): number | null {
  const t = s.trim();
  if (t === "半") return 0.5;
  if (/^[零一两二三四五六七八九]$/.test(t)) return CN_DIGITS[t];
  const m = /^([一两二三四五六七八九])?十([一二三四五六七八九])?$/.exec(t);
  if (m) return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[2] ? CN_DIGITS[m[2]] : 0);
  return null;
}

/** A leading number, Arabic or Chinese, and what follows it. */
function leadingNumber(s: string): [number, string] | null {
  const t = s.trim();
  const ar = /^(\d+(?:\.\d+)?)\s*/.exec(t);
  if (ar) return [Number(ar[1]), t.slice(ar[0].length)];
  const cn = /^([零一两二三四五六七八九十半]{1,3})\s*/.exec(t);
  if (cn) {
    const n = cnNumber(cn[1]);
    if (n !== null) return [n, t.slice(cn[0].length)];
  }
  return null;
}

const DECLINE = /^(没|没有|没读|没做|不|跳过|算了|skip|none|no|nope|0)$/i;
const YES = /^(是|对|做了|有|完成|好|✓|✅|y|yes|done|ok)$/i;
const NO = /^(否|不是|没|没有|没做|✗|❌|n|no|nope)$/i;

const HOUR = /^(小时|个小时|h|hr|hrs|hour|hours)/i;
const MINUTE = /^(分钟|分|min|m|mins|minute|minutes)/i;

/**
 * "45" "45分" "一小时" "1h" "1.5小时" "半小时" "1小时30分" "90min" → minutes.
 * A bare number is minutes, which is what someone answering "读了多久" means.
 */
export function parseDuration(input: string): ParseResult | null {
  const s = input.trim();
  if (!s) return null;
  if (DECLINE.test(normalise(s))) return { num: 0, declined: true };

  let rest = s;
  let total = 0;
  let matched = false;
  // Up to two parts, so "1小时30分" works; more than that is not a duration anyone types.
  for (let i = 0; i < 2 && rest; i++) {
    const lead = leadingNumber(rest);
    if (!lead) break;
    const [n, after] = lead;
    if (HOUR.test(after)) {
      total += n * 60;
      rest = after.replace(HOUR, "").trim();
    } else if (MINUTE.test(after)) {
      total += n;
      rest = after.replace(MINUTE, "").trim();
    } else if (i === 0 && !after.trim()) {
      total += n;           // a bare number is minutes
      rest = "";
    } else {
      return null;          // a number followed by something that is not a time unit
    }
    matched = true;
  }
  if (!matched || rest.trim()) return null;
  const m = Math.round(total);
  return m > 0 || total === 0 ? { num: m } : null;
}

/** "3" "三次" "两遍" → a count. */
export function parseCount(input: string): ParseResult | null {
  const s = input.trim();
  if (!s) return null;
  if (DECLINE.test(normalise(s))) return { num: 0, declined: true };
  const lead = leadingNumber(s);
  if (!lead) return null;
  const [n, after] = lead;
  if (after.trim() && !/^(次|遍|回|个|times?)$/i.test(after.trim())) return null;
  return Number.isFinite(n) && n >= 0 ? { num: Math.round(n) } : null;
}

/** "是" "做了" "✓" / "没有" "否" → 1 or 0. */
export function parseBool(input: string): ParseResult | null {
  const s = normalise(input);
  if (!s) return null;
  if (YES.test(s)) return { num: 1 };
  if (NO.test(s)) return { num: 0, declined: true };
  if (s === "1") return { num: 1 };
  if (s === "0") return { num: 0, declined: true };
  return null;
}

/** "72.4" "72.4kg" "100 元" → the number, with the unit checked when the stream names one. */
export function parseNumber(input: string, unit: string | null): ParseResult | null {
  const s = input.trim();
  if (!s) return null;
  if (DECLINE.test(normalise(s))) return { num: 0, declined: true };
  const lead = leadingNumber(s);
  if (!lead) return null;
  const [n, after] = lead;
  const tail = after.trim();
  if (tail) {
    // A trailing unit is allowed when it is the stream's own; anything else is not this stream's value.
    if (!unit || normalise(tail) !== normalise(unit)) return null;
  }
  return Number.isFinite(n) ? { num: n } : null;
}

/** "100" "100元" "¥100" "$25.5" → the amount. */
export function parseMoney(input: string): ParseResult | null {
  const s = input.trim().replace(/^[¥$€£]/, "").trim();
  if (!s) return null;
  if (DECLINE.test(normalise(s))) return { num: 0, declined: true };
  const lead = leadingNumber(s);
  if (!lead) return null;
  const [n, after] = lead;
  const tail = after.trim();
  if (tail && !/^(元|块|rmb|cny|usd|aed|dirhams?)$/i.test(tail)) return null;
  return Number.isFinite(n) && n >= 0 ? { num: n } : null;
}

/** The parser for a shape. `text` takes whatever it is given. */
export function parseShape(shape: Shape, input: string, unit: string | null): ParseResult | null {
  switch (shape) {
    case "duration": return parseDuration(input);
    case "count": return parseCount(input);
    case "bool": return parseBool(input);
    case "money": return parseMoney(input);
    case "number": return parseNumber(input, unit);
    case "text": {
      const t = input.trim();
      return t ? { num: null, text: t.slice(0, 500) } : null;
    }
  }
}

/** The stream's bounds, or the shape's default. Outside them a value is a typo, not a reading. */
export function boundsOf(shape: Shape, min: number | null, max: number | null): [number, number] | null {
  const fallback = SHAPE_BOUNDS[shape];
  const lo = min ?? fallback?.[0] ?? null;
  const hi = max ?? fallback?.[1] ?? null;
  return lo === null || hi === null ? null : [lo, hi];
}

export function inBounds(shape: Shape, value: number, min: number | null, max: number | null): boolean {
  const b = boundsOf(shape, min, max);
  return !b || (value >= b[0] && value <= b[1]);
}

// ---------- capture patterns (PRD-brain §8.3) ----------

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The capture regex for a stream, built **in code from the model's aliases** rather than written by the
 * model. A model-authored regex is an unbounded input to the runtime — a catastrophic-backtracking hazard
 * with no timeout available in a Worker — so the model supplies words and this builds the pattern around
 * them. Every quantifier here is bounded, so matching is linear whatever the user types.
 *
 * Matches "读书 45 分钟", "读了45min", "45 分钟 读书".
 */
export function buildPattern(aliases: string[], shape: Shape): RegExp | null {
  const words = aliases.map((a) => a.trim()).filter((a) => a && a.length <= 20).slice(0, 8).map(escapeRe);
  if (!words.length) return null;
  const alt = words.join("|");
  const unitWord = shape === "duration" ? "(?:分钟|分|小时|个小时|min|mins|m|h|hr|hrs)?" : "[^\\s]{0,4}";
  const value = `(\\d+(?:\\.\\d+)?|[零一两二三四五六七八九十半]{1,3})`;
  // alias then value, or value then alias; at most four filler characters between them.
  return new RegExp(`(?:(?:${alt})[^0-9]{0,4}${value}\\s*${unitWord}|${value}\\s*${unitWord}[^0-9]{0,4}(?:${alt}))`, "iu");
}

/**
 * Does this message log to a stream with these aliases? Returns the text of the value part, which then
 * goes through the shape parser — the pattern finds the value, it never decides what the value is.
 */
export function matchStream(text: string, aliases: string[], shape: Shape): string | null {
  const re = buildPattern(aliases, shape);
  if (!re) return null;
  const m = re.exec(text);
  if (!m) return null;
  const captured = m[1] ?? m[2];
  if (!captured) return null;
  // Hand the parser the value plus whatever unit followed it, so "1小时" survives.
  const from = m.index + m[0].indexOf(captured);
  return text.slice(from, m.index + m[0].length).trim();
}

/** An alias that would make two streams fight over the same message (PRD-brain §8.3). */
export function aliasConflict(a: string[], b: string[]): string | null {
  const setB = new Set(b.map(normalise));
  for (const alias of a) {
    const n = normalise(alias);
    if (!n) continue;
    if (setB.has(n)) return alias;
    // One containing the other is a conflict too: "跑步" inside "跑步机" matches the same words.
    for (const other of setB) if (other.includes(n) || n.includes(other)) return alias;
  }
  return null;
}

export { BASE_UNIT };
