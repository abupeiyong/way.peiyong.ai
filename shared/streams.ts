// Streams and generic goals (docs/PRD-brain.md §6, §7): the vocabulary every client has to agree on.
// The numbers themselves are computed once, in worker/derive.ts; this file holds the shapes, the goal
// kinds, the plausible bounds and the wording — so the bot, the web and the Guide cannot drift apart.

/** What a stream logs. Six shapes cover every tracker P0 provisions (PRD-brain §6). */
export const SHAPES = ["number", "duration", "count", "bool", "money", "text"] as const;
export type Shape = (typeof SHAPES)[number];

export function isShape(v: unknown): v is Shape {
  return typeof v === "string" && (SHAPES as readonly string[]).includes(v);
}

/** Shapes whose observations carry a number; `text` is the only one that does not. */
export function isNumeric(shape: Shape): boolean {
  return shape !== "text";
}

/** The unit a shape stores in, when the shape fixes it. `duration` is always minutes. */
export const BASE_UNIT: Partial<Record<Shape, string>> = { duration: "min", bool: "", count: "次" };

/** Sensible bounds per shape, used when the model does not supply its own (PRD-brain §6). */
export const SHAPE_BOUNDS: Record<Shape, [number, number] | null> = {
  number: null,                 // the model must supply a range; without one, bare capture stays off
  duration: [1, 24 * 60],
  count: [0, 1000],
  bool: [0, 1],
  money: [0, 1_000_000],
  text: null,
};

export const SHAPE_LABEL: Record<Shape, string> = {
  number: "数值 · number",
  duration: "时长 · duration",
  count: "次数 · count",
  bool: "做了没 · yes/no",
  money: "金额 · money",
  text: "文字 · text",
};

// ---------- goal kinds ----------

/**
 * The seven kinds of claim a goal can make (PRD-brain §7). P0 computes `reach` and `accumulate`;
 * the rest are declared here so the union, the schema and the wording are settled from the start.
 */
export const GOAL_KINDS = ["reach", "accumulate", "streak", "reduce", "maintain", "complete"] as const;
export type GoalKind = (typeof GOAL_KINDS)[number];

/** What P0 can actually compute a verdict for. Anything else stays a plain goal until its kind lands. */
export const IMPLEMENTED_KINDS: GoalKind[] = ["reach", "accumulate"];

export function isGoalKind(v: unknown): v is GoalKind {
  return typeof v === "string" && (GOAL_KINDS as readonly string[]).includes(v);
}

export const PERIODS = ["day", "week", "month"] as const;
export type Period = (typeof PERIODS)[number];

export function isPeriod(v: unknown): v is Period {
  return typeof v === "string" && (PERIODS as readonly string[]).includes(v);
}

export const PERIOD_LABEL: Record<Period, string> = { day: "每天 · a day", week: "每周 · a week", month: "每月 · a month" };

/** Every verdict any kind can return. The model reads these; it never computes one (PRD-brain §4 R2). */
export const VERDICTS = [
  "ahead", "on_track", "on_pace", "behind", "unreachable", "stalled", "wrong_way", "no_data",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export const VERDICT_TEXT: Record<Verdict, string> = {
  ahead: "提前 · ahead",
  on_track: "按计划 · on track",
  on_pace: "按节奏 · on pace",
  behind: "落后 · behind",
  unreachable: "这个周期来不及了 · out of reach this period",
  stalled: "停在原地 · stalled",
  wrong_way: "方向反了 · moving away",
  no_data: "记录还不够 · not enough logged yet",
};

// ---------- formatting ----------

/** 90 → "1h30m"; 45 → "45 分钟". Minutes are the only unit `duration` ever stores. */
export function fmtDuration(min: number): string {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  if (!h) return `${m} 分钟`;
  return m ? `${h}h${m}m` : `${h} 小时`;
}

/** One observation's value as the user should read it back. */
export function fmtValue(shape: Shape, unit: string | null, num: number | null, text?: string | null): string {
  if (shape === "text") return (text ?? "").slice(0, 80);
  if (num === null) return "—";
  if (shape === "duration") return fmtDuration(num);
  if (shape === "bool") return num ? "✓ 做了" : "✗ 没做";
  const n = Number.isInteger(num) ? String(num) : num.toFixed(1);
  return unit ? `${n} ${unit}` : n;
}

/** The same, for a total over a period (a bool total is a count of days). */
export function fmtTotal(shape: Shape, unit: string | null, total: number): string {
  if (shape === "duration") return fmtDuration(total);
  if (shape === "bool") return `${Math.round(total)} 天`;
  const n = Number.isInteger(total) ? String(total) : total.toFixed(1);
  return unit ? `${n} ${unit}` : n;
}

/** What one quick-answer button says. */
export function fmtQuick(shape: Shape, unit: string | null, value: number): string {
  if (shape === "duration") return value >= 60 && value % 60 === 0 ? `${value / 60}小时` : `${value}分`;
  if (shape === "bool") return value ? "✓ 做了" : "✗ 没做";
  return unit ? `${value}${unit}` : String(value);
}

// ---------- names ----------

export const NAME_MAX = 40;
export const MAX_ALIASES = 8;
export const ALIAS_MAX = 20;
/** How many active streams one user may have. The discipline in PRD-brain §15 is one new one at a time. */
export const MAX_ACTIVE_STREAMS = 20;

/** Lower-cased and stripped, for alias matching and conflict detection. */
export function normalise(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}
