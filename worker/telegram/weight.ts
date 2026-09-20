// Weight — one reply a day is the whole habit (docs/PRD-body.md §5.1, §6.1, §11).
//   weigh_in        → the scheduled ask (telegram_prefs.weigh_at): a plan, no weigh-in today, and
//                     morning_at off — when the morning message is on, the ask rides inside it (compose.ts)
//   awaiting_weight → 3 h after any ask, a typed number is the weigh-in
//   fast path       → while a plan exists, a bare message matching the strict §5.1 pattern is logged at once
//                     with [撤销，记进 Inbox] (wt:u:<date>): one tap deletes the row and captures the text
//   /weight 72.4    → always, with unit parsing (kg 公斤 斤 lb 磅); bare /weight prints today and the trend
//   wt:s:<date>     → 跳过今天 on the ask
//
// Every write goes through applyProposal's log_weight — the same upsert as POST /api/body/weight — so one
// reading per local date wins and goals.progress stays derived (§4.3). Every number quoted here comes from
// bodySummary, so the echo, /body and the web page can never disagree.

import { bodyBlock, bodySummary, bodyVerdictLine, loadBodyPlan, refreshBodyGoalProgress } from "../body.ts";
import { weekStartOf } from "../dates.ts";
import { applyProposal } from "../proposals.ts";
import { captureToInbox } from "../tasks.ts";
import type { BodySummary } from "../../shared/types.ts";
import { KG_RANGE } from "../../shared/body.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logEvent, logReply } from "./events.ts";
import { captureReply, type Reply } from "./router.ts";

/** The buttons the weigh-in owns (§5.1): 跳过今天 on the ask, and the fast path's one-tap undo. */
export const WEIGHT_ACTIONS = ["skip", "undo"] as const;
export type WeightAction = (typeof WEIGHT_ACTIONS)[number];

/** How long a reply still counts as the weight. */
export const WEIGHT_ANSWER_SECONDS = 3 * 60 * 60;

/** Which prompt opened the ask, so the reply is credited to it in telegram_events; null = nobody asked. */
export type WeightAsk = "weigh_in" | "morning" | "body_nudge";

export type WeightContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

interface WeightState {
  kind: "awaiting_weight";
  date: string;
  expires_at: number;
  /** The kind that asked; absent on a state written before this field existed. */
  from?: WeightAsk;
}

function isWeightState(v: unknown): v is WeightState {
  const s = v as Partial<WeightState> | null;
  return !!s && typeof s === "object" && s.kind === "awaiting_weight"
    && typeof s.date === "string" && typeof s.expires_at === "number";
}

// ---------- parsing (§5.1) ----------

/** The strict weight pattern of §5.1: anything else is not a weight and goes to capture as usual. */
const WEIGHT_RE = /^\s*(?:体重|weight)?\s*(\d{2,3}(?:[.,]\d)?)\s*(kg|公斤|斤|lb|lbs|磅)?\s*$/i;
const UNIT_KG: Record<string, number> = { "斤": 0.5, lb: 0.4536, lbs: 0.4536, "磅": 0.4536 };

/** `72.4`, `72,4 kg`, `145 lb`, `144斤` → kilograms; null when the text is not a weight. */
export function parseWeightKg(text: string): number | null {
  const m = WEIGHT_RE.exec(text);
  if (!m) return null;
  const kg = Number(m[1].replace(",", ".")) * (UNIT_KG[(m[2] ?? "").toLowerCase()] ?? 1);
  if (!Number.isFinite(kg) || kg < KG_RANGE[0] || kg > KG_RANGE[1]) return null;
  return Math.round(kg * 10) / 10;
}

// ---------- wording ----------

const kgText = (n: number): string => n.toFixed(1);

/** One line after a weigh-in: the reading, the trend and what is left (§5.1). */
function weighEcho(s: BodySummary, kg: number): string {
  const trend = s.trend === null ? "—" : kgText(s.trend);
  const move = s.trend !== null && s.trend_prev !== null
    ? ` ${s.trend <= s.trend_prev ? "↓" : "↑"}${Math.abs(s.trend - s.trend_prev).toFixed(1)}`
    : "";
  const gap = s.remaining_kg === null ? "" : s.remaining_kg > 0 ? ` · 距目标 ${kgText(s.remaining_kg)} kg` : " · 已达目标 ✓";
  return `⚖️ ${kgText(kg)} kg · 7日均 ${trend}${move}${gap}`;
}

const ASK_TEXT = "⚖️ 今天体重？ · Weight today?\n直接回复数字就行 · Just reply with the number";
/** Inside the morning message the ask is one line: the block already carries the numbers (§6.1). */
const ASK_LINE = "今天还没称 · No weigh-in today — 回复体重就行（例如 72.4）· just reply with the number";

// ---------- reading the log ----------

/** Today's reading, or null when there is none (and on a database where migration 0004 has not run). */
async function weighInOn(db: D1Database, userId: number, date: string): Promise<{ kg: number; note: string } | null> {
  try {
    return await db.prepare("SELECT kg, note FROM weight_logs WHERE user_id = ? AND date = ?")
      .bind(userId, date).first<{ kg: number; note: string }>();
  } catch {
    return null; // migration 0004 has not run here
  }
}

/** Is this the week's first weigh-in? Then the echo carries the projection line too (§5.1). */
async function firstOfWeek(db: D1Database, userId: number, today: string): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM weight_logs WHERE user_id = ? AND date BETWEEN ? AND ?")
      .bind(userId, weekStartOf(today), today).first<{ n: number }>();
    return (row?.n ?? 0) <= 1;
  } catch {
    return false;
  }
}

// ---------- the ask ----------

/** Wait `WEIGHT_ANSWER_SECONDS` for a number; `from` is the kind the reply is credited to. */
export async function awaitWeight(ctx: Pick<CallbackContext, "state">, date: string, from: WeightAsk | null): Promise<void> {
  const state: WeightState = {
    kind: "awaiting_weight", date, expires_at: Date.now() + WEIGHT_ANSWER_SECONDS * 1000,
    ...(from && { from }),
  };
  await ctx.state.put(state, WEIGHT_ANSWER_SECONDS);
}

/** 现在称 ⚖️ and `/weight` — a ForceReply for today's weight; telegram_state waits 3 h for it. */
export async function askWeight(
  ctx: Pick<CallbackContext, "state" | "send" | "today">, from: WeightAsk | null = null,
): Promise<void> {
  await awaitWeight(ctx, ctx.today, from);
  await ctx.send({ text: ASK_TEXT, reply_markup: { force_reply: true, input_field_placeholder: "72.4" } });
}

/** The scheduler's condition for `weigh_in`: a plan, and nothing logged today (§6). */
export async function weighInDue(ctx: Pick<CallbackContext, "db" | "userId" | "today">): Promise<boolean> {
  if (!(await loadBodyPlan(ctx.db, ctx.userId))) return false;
  return !(await weighInOn(ctx.db, ctx.userId, ctx.today));
}

/** The `weigh_in` kind: the ask with [跳过今天]; the free-text reply is caught by telegram_state. */
export async function sendWeighIn(ctx: WeightContext): Promise<void> {
  await awaitWeight(ctx, ctx.today, "weigh_in");
  await ctx.send({
    text: ASK_TEXT,
    reply_markup: { inline_keyboard: [[{ text: "跳过今天 · Skip", callback_data: cb.weight("skip", ctx.today) }]] },
  });
}

/**
 * The ⚖️ 身体 · Body block the morning message carries after 今日 (§6.1), or null without a plan.
 * `ask` says today's weigh-in is still missing, so the caller opens the 3 h slot for it.
 */
export async function morningBodyBlock(
  db: D1Database, userId: number, today: string,
): Promise<{ text: string; ask: boolean } | null> {
  const summary = await bodySummary(db, userId, today);
  if (!summary) return null;
  const ask = !(await weighInOn(db, userId, today));
  return { text: ask ? `${bodyBlock(summary)}\n${ASK_LINE}` : bodyBlock(summary), ask };
}

// ---------- logging ----------

/** The echo (plus the week's first projection line) and, on the fast path, the undo button. */
async function logWeighIn(ctx: WeightContext, kg: number, opts: { note?: string; undo?: boolean } = {}): Promise<boolean> {
  // The same write as the Guide's log_weight proposal and POST /api/body/weight: one reading per date,
  // the latest wins, and goals.progress is recomputed from the new trend.
  const r = await applyProposal(
    ctx.db, ctx.userId, { kind: "log_weight", date: ctx.today, kg, note: opts.note ?? "" }, { source: "telegram" }
  );
  if (!r.ok) {
    await ctx.send({ text: `没能记下 · Could not log: ${r.error}` });
    return false;
  }
  const summary = await bodySummary(ctx.db, ctx.userId, ctx.today);
  const lines = [summary ? weighEcho(summary, kg) : `⚖️ ${kgText(kg)} kg 已记下 · Logged`];
  if (summary && (await firstOfWeek(ctx.db, ctx.userId, ctx.today))) lines.push(bodyVerdictLine(summary));
  await ctx.send({
    text: lines.join("\n"),
    ...(opts.undo && {
      reply_markup: { inline_keyboard: [[{ text: "撤销，记进 Inbox", callback_data: cb.weight("undo", ctx.today) }]] },
    }),
  });
  return true;
}

/**
 * Router step 3: a typed answer while the weight ask is open. Anything that is not a weight falls through
 * to the steps below with the slot left open, so the next number still counts (§5.1).
 */
export async function weightAnswer(ctx: WeightContext, text: string): Promise<boolean> {
  const state = await ctx.state.get();
  if (!isWeightState(state)) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    return false;
  }
  const kg = parseWeightKg(text);
  if (kg === null) return false;
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, state.from ?? "weigh_in", ctx.today);
  await logWeighIn(ctx, kg);
  return true;
}

/**
 * The fast path (§5.1): while a body plan exists, a bare message matching the strict pattern is a weigh-in
 * rather than a capture — with one tap to put it back in the inbox. Without a plan nothing here fires and
 * the message captures as it always did.
 */
export async function weightFastPath(ctx: WeightContext, text: string): Promise<boolean> {
  const kg = parseWeightKg(text);
  if (kg === null) return false;
  if (!(await loadBodyPlan(ctx.db, ctx.userId))) return false;
  await logWeighIn(ctx, kg, { note: text.trim().slice(0, 200), undo: true });
  return true;
}

// ---------- /weight [n] (§11) ----------

const USAGE = "用法 · Usage: /weight 72.4（也认 72,4 kg · 144斤 · 160 lb）";

/** Bare `/weight`: today's reading and the trend, then the ask when today is still missing. */
async function weightStatus(ctx: WeightContext): Promise<Reply> {
  const summary = await bodySummary(ctx.db, ctx.userId, ctx.today);
  const todayKg = await weighInOn(ctx.db, ctx.userId, ctx.today);
  if (todayKg) {
    return { text: summary ? weighEcho(summary, todayKg.kg) : `⚖️ ${kgText(todayKg.kg)} kg · ${ctx.today}` };
  }
  const last = summary?.latest ?? null;
  const trend = summary?.trend ?? null;
  const head = [
    "⚖️ 今天还没称 · No weigh-in today",
    last ? `上次 ${last.date} · ${kgText(last.kg)} kg · 7日均 ${trend === null ? "—" : kgText(trend)}` : USAGE,
  ].join("\n");
  await awaitWeight(ctx, ctx.today, null);
  return { text: head, reply_markup: { force_reply: true, input_field_placeholder: "72.4" } };
}

export async function weightCommand(ctx: WeightContext, args: string): Promise<void> {
  const text = args.trim();
  if (!text) {
    await ctx.send(await weightStatus(ctx));
    return;
  }
  const kg = parseWeightKg(text);
  if (kg === null) {
    await ctx.send({ text: `不像是体重 · That doesn't look like a weight（${KG_RANGE[0]}–${KG_RANGE[1]} kg）\n${USAGE}` });
    return;
  }
  await logWeighIn(ctx, kg);
}

// ---------- wt:s:<date> · wt:u:<date> ----------

/** 跳过今天 on the ask, and 撤销 on the fast path's echo. Both are idempotent. */
export async function weightButton(ctx: CallbackContext, action: WeightAction, date: string): Promise<string> {
  const pending = await ctx.state.get();
  if (isWeightState(pending) && pending.date === date) await ctx.state.clear();
  if (action === "skip") {
    await logReply(ctx.db, ctx.userId, "weigh_in", ctx.today);
    await ctx.finish("⏭ 今天不称 · Skipped today");
    return "已跳过 · Skipped";
  }
  const row = await weighInOn(ctx.db, ctx.userId, date);
  if (!row) {
    await ctx.finish("↩️ 已经撤销了 · Already undone");
    return "已经撤销了 · Already undone";
  }
  await ctx.db.prepare("DELETE FROM weight_logs WHERE user_id = ? AND date = ?").bind(ctx.userId, date).run();
  await refreshBodyGoalProgress(ctx.db, ctx.userId, ctx.today);
  // The text that looked like a weight goes where it would have gone without a plan: the inbox.
  const task = await captureToInbox(ctx.db, ctx.userId, row.note.trim() || kgText(row.kg));
  await logEvent(ctx.db, ctx.userId, "capture", "used");
  await ctx.finish(`↩️ 已撤销 · Undone — ${kgText(row.kg)} kg（${date}）`);
  await ctx.send(captureReply(task));
  return "已撤销 · Undone";
}
