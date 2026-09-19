// Today's top three (PRD §6.2): the morning ask, and the reply that fills days.top1..3.
//   askTopThree        → "what are today's three?" + [📋 抄昨天] [🤖 让道引拟]; telegram_state = awaiting_top_three
//   topThreeAnswer     → the next free-text message is the answer (no reply-to needed): parsed, written, echoed with [✏️ 重写]
//   tt:y:<date>        → copy yesterday's top1..3, skipping the ones marked done
//   tt:g:<date>        → ask the Guide for a draft; its set_top_three proposal comes back as [✓ 采用] (pr:<msg>:<idx>:y)
//   tt:r:<date>        → ask again for that date
//   tt:w:<date>        → ✍️ 写三件事 on the morning message: a one-line follow-up carrying ForceReply
// Writes go through updateDay — the same path as PUT /api/day/:date { top1, top2, top3 }.
// The answer window is 4 h; a later reply is told the prompt expired and falls through to inbox capture.
//
// Webhook wiring (#6/#20): the /plan command calls askTopThree (the morning message, compose.ts, embeds
// askText and calls awaitTopThree itself); the router's pendingState handler calls topThreeAnswer
// (after reviewAnswer — each only takes its own state kind).

import { updateDay } from "../days.ts";
import { guideChat } from "../guide.ts";
import { cb, shiftDate, type CallbackContext, type TopThreeAction } from "./callback.ts";
import { logReply } from "./events.ts";
import { guideReplyCard } from "./guide.ts";
import type { Reply } from "./router.ts";

/** How long a reply still counts as the answer. */
export const TOP_THREE_ANSWER_SECONDS = 4 * 60 * 60;
/** How long the slot is kept, so a late reply can be told the prompt expired instead of vanishing silently. */
const TOP_THREE_SLOT_SECONDS = 24 * 60 * 60;

export interface TopThreeState {
  kind: "awaiting_top_three";
  /** The local date being planned, fixed when asked. */
  date: string;
  /** Epoch ms after which a reply is no longer the answer. */
  expires_at: number;
}

export type TopThreeContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

function isTopThreeState(v: unknown): v is TopThreeState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<TopThreeState>;
  return s.kind === "awaiting_top_three" && typeof s.date === "string" && typeof s.expires_at === "number";
}

async function loadState(ctx: Pick<TopThreeContext, "state">): Promise<TopThreeState | null> {
  const s = await ctx.state.get();
  return isTopThreeState(s) ? s : null;
}

/** The answer is in (typed, copied, or a Guide proposal approved): stop waiting, but only if the slot is still ours for that date. */
export async function clearTopThreeWait(ctx: Pick<TopThreeContext, "state">, date: string): Promise<void> {
  if ((await loadState(ctx))?.date === date) await ctx.state.clear();
}

// ---------- parsing ----------

const ITEM_MARKER = /^(?:\d{1,2}\s*[.．、)）](?!\d)|[-*•·])\s*/;
const INLINE_NUMBER = /(?:^|\s)(\d{1,2})\s*[.．、)）](?!\d)\s*/g;

/** `1. foo 2. bar 3. baz` → the items, when the numbers run 1, 2, 3… from the start of the line. */
function splitNumbered(line: string): string[] | null {
  const marks: RegExpMatchArray[] = [];
  for (const m of line.matchAll(INLINE_NUMBER)) {
    if (Number(m[1]) === marks.length + 1 && (marks.length > 0 || m.index === 0)) marks.push(m);
  }
  if (marks.length < 2) return null;
  return marks.map((m, i) => line.slice(m.index! + m[0].length, marks[i + 1]?.index));
}

/**
 * One item per line; a single line falls back to `;` / `；`, then to `1. 2. 3.` numbering.
 * `total` is how many were written before trimming to three.
 */
export function parseTopThree(text: string): { items: string[]; total: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let parts = lines;
  if (lines.length === 1) {
    const bySemicolon = lines[0].split(/[;；]/);
    parts = bySemicolon.length > 1 ? bySemicolon : splitNumbered(lines[0]) ?? lines;
  }
  const all = parts.map((p) => p.trim().replace(ITEM_MARKER, "").trim()).filter(Boolean);
  return { items: all.slice(0, 3), total: all.length };
}

// ---------- messages ----------

function when(ctx: Pick<TopThreeContext, "today">, date: string): string {
  return date === ctx.today ? "今天" : date === shiftDate(ctx.today, 1) ? "明天" : date;
}

/** The ask itself; also the closing block of the morning message. */
export function askText(ctx: Pick<TopThreeContext, "today">, date: string): string {
  return `🎯 ${when(ctx, date)}最重要的三件事是什么？\nWhat are the top three for ${date}?\n\n直接回复，一行一件 · Reply with one per line`;
}

function askCard(ctx: Pick<TopThreeContext, "today">, date: string): Reply {
  return {
    text: askText(ctx, date),
    reply_markup: {
      inline_keyboard: [[
        { text: "📋 抄昨天", callback_data: cb.topThree("copy", date) },
        { text: "🤖 让道引拟", callback_data: cb.topThree("guide", date) },
      ]],
    },
  };
}

function echoText(ctx: Pick<TopThreeContext, "today">, date: string, items: string[], total = items.length): string {
  const list = items.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const note = total > 3 ? `\n\n收到 ${total} 条，只取前三 · Took the first three of ${total}` : "";
  return `🎯 ${when(ctx, date)}的三件事 · Top three for ${date}\n${list}${note}`;
}

function echoCard(ctx: Pick<TopThreeContext, "today">, date: string, items: string[], total?: number): Reply {
  return {
    text: echoText(ctx, date, items, total),
    reply_markup: { inline_keyboard: [[{ text: "✏️ 重写", callback_data: cb.topThree("rewrite", date) }]] },
  };
}

// ---------- writes ----------

/** days.top1..3 through the PUT /api/day path; slots past the given items are emptied. */
async function writeTopThree(ctx: Pick<TopThreeContext, "db" | "userId">, date: string, items: string[]): Promise<void> {
  const [top1, top2, top3] = [...items, "", "", ""];
  await updateDay(ctx.db, ctx.userId, date, { top1, top2, top3 });
}

// ---------- entry points ----------

/** Open (or reopen) the 4 h answer window for `date`: the next free text becomes its top three. */
export async function awaitTopThree(ctx: Pick<TopThreeContext, "state">, date: string): Promise<void> {
  const state: TopThreeState = { kind: "awaiting_top_three", date, expires_at: Date.now() + TOP_THREE_ANSWER_SECONDS * 1000 };
  await ctx.state.put(state, TOP_THREE_SLOT_SECONDS);
}

/** /plan (and ✏️ 重写): ask for the day's top three and wait 4 h for the reply. */
export async function askTopThree(ctx: TopThreeContext, date = ctx.today): Promise<void> {
  await awaitTopThree(ctx, date);
  await ctx.send(askCard(ctx, date));
}

/**
 * Router step 3: free text while the ask is open is the answer. False when it is not ours to take —
 * including an expired ask, which is cleared with a note so the message falls through to inbox capture.
 */
export async function topThreeAnswer(ctx: TopThreeContext, text: string): Promise<boolean> {
  const state = await loadState(ctx);
  if (!state) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    await ctx.send({ text: "⌛ 三件事的提问已过期，这条收进 Inbox · The top-three prompt expired — capturing to the Inbox instead.\n/plan 重新开始 · /plan to ask again" });
    return false;
  }
  const { items, total } = parseTopThree(text);
  if (!items.length) {
    await ctx.send({ text: "没读出内容，请一行写一件 · Couldn't read that — one per line, please" });
    return true;
  }
  await writeTopThree(ctx, state.date, items);
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, "morning", state.date);
  await ctx.send(echoCard(ctx, state.date, items, total));
  return true;
}

// ---------- button handlers (dispatched by handleCallback) ----------

/** tt:<r|y|g|w>:<date> */
export async function topThreeButton(ctx: CallbackContext, action: TopThreeAction, date: string): Promise<string> {
  if (action === "rewrite") return rewrite(ctx, date);
  if (action === "write") return writePrompt(ctx, date);
  if (action === "copy") return copyYesterday(ctx, date);
  return guideDraft(ctx, date);
}

/** ✏️ 重写 — freeze the echo and ask again for the same date. */
async function rewrite(ctx: CallbackContext, date: string): Promise<string> {
  const day = await ctx.db.prepare("SELECT top1, top2, top3 FROM days WHERE user_id = ? AND date = ?")
    .bind(ctx.userId, date).first<{ top1: string; top2: string; top3: string }>();
  const items = day ? [day.top1, day.top2, day.top3].filter(Boolean) : [];
  if (items.length) await ctx.finish(echoText(ctx, date, items));
  await askTopThree(ctx, date);
  return "请重新回复 · Reply with the new three";
}

/**
 * ✍️ 写三件事 — the morning message keeps its inline keyboard, so it cannot also carry ForceReply;
 * this one-line follow-up opens the reply field on demand. The window is reopened so a late tap still works.
 */
async function writePrompt(ctx: CallbackContext, date: string): Promise<string> {
  await awaitTopThree(ctx, date);
  await ctx.send({
    text: `✍️ ${when(ctx, date)}的三件事，一行一件 · Your top three, one per line`,
    reply_markup: { force_reply: true, input_field_placeholder: "一行一件 · One per line" },
  });
  return "请直接回复 · Reply below";
}

/** 📋 抄昨天 — yesterday's top1..3 that are not done. Absolute, so a replay writes the same thing. */
async function copyYesterday(ctx: CallbackContext, date: string): Promise<string> {
  const y = await ctx.db.prepare(
    "SELECT top1, top1_done, top2, top2_done, top3, top3_done FROM days WHERE user_id = ? AND date = ?"
  ).bind(ctx.userId, shiftDate(date, -1)).first<Record<string, string | number | null>>();
  const items = y ? [1, 2, 3].filter((i) => !y[`top${i}_done`]).map((i) => String(y[`top${i}`] ?? "").trim()).filter(Boolean) : [];
  if (!items.length) return "昨天没有未完成的三件事 · Nothing left over from yesterday";
  await writeTopThree(ctx, date, items);
  await clearTopThreeWait(ctx, date);
  await ctx.edit(echoCard(ctx, date, items));
  return "已抄昨天 · Copied from yesterday";
}

/** 🤖 让道引拟 — one Guide turn with a synthesized prompt; its set_top_three proposal comes back with Approve buttons (guide.ts). */
async function guideDraft(ctx: CallbackContext, date: string): Promise<string> {
  await ctx.typing();
  const prompt = `Draft my top three outcomes for ${date}, drawn from my goals and this week's plan. `
    + `Keep the reply to a sentence or two and include exactly one set_top_three proposal for ${date}.`;
  let reply: Awaited<ReturnType<typeof guideChat>>;
  try {
    reply = await guideChat(ctx.db, ctx.guide, ctx.userId, prompt);
  } catch {
    return "道引暂时不可用 · Guide is unavailable right now";
  }
  const messageId = await ctx.sendId(guideReplyCard(reply));
  await ctx.db.prepare("UPDATE guide_messages SET tg_message_id = ? WHERE id = ? AND user_id = ?").bind(messageId, reply.id, ctx.userId).run();
  if (!reply.proposals.some((p) => p?.kind === "set_top_three")) {
    await ctx.send({ text: "（道引没有给出草案，可直接回复三件事 · No draft this time — reply with your three）" });
    return "没有草案 · No draft";
  }
  return "道引已拟 · Drafted";
}
