// Trackers in the chat (docs/PRD-brain.md §8, §11): the ask, the answer, the timer and the cards.
//   L1  a pending ask   → the next message is parsed against that stream's shape (parse.ts)
//   L3  aliases         → "读书 45 分钟" matches without a model; the pattern is built in code (parse.ts)
//   timer               → /timer <name> … /stop turns wall-clock into an observation (also /开始 /停止)
//   sv:<id>:<n>         → the ask's one-tap answers; sv:<id>:x skips the day
//   su:<obsId>          → undo, because an automatic reading has to be one tap from gone (§8.5)
//
// Every write goes through worker/streams.ts, the same path the web API uses, so the derived goal
// progress is refreshed once, in one place.

import {
  VERDICT_TEXT, fmtQuick, fmtTotal, fmtValue, isNumeric, normalise, type Shape,
} from "../../shared/streams.ts";
import { PERIOD_LABEL } from "../../shared/streams.ts";
import {
  activeStreams, clearTimer, deleteObservation, logObservation, runningTimer, startTimer,
  streamByWord, streamById, tracker, trackers, type StreamRow, type Tracker,
} from "../streams.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logEvent, logReply } from "./events.ts";
import { matchStream, parseShape } from "./parse.ts";
import type { Reply } from "./router.ts";

/** How long a reply still counts as the answer to a stream's ask. */
export const ASK_ANSWER_SECONDS = 4 * 60 * 60;
const ASK_SLOT_SECONDS = 20 * 60 * 60;

export type StreamContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

interface AskState {
  kind: "awaiting_stream";
  stream_id: number;
  date: string;
  expires_at: number;
}

function isAskState(v: unknown): v is AskState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<AskState>;
  return s.kind === "awaiting_stream" && typeof s.stream_id === "number" && typeof s.date === "string"
    && typeof s.expires_at === "number";
}

async function loadAsk(ctx: Pick<StreamContext, "state">): Promise<AskState | null> {
  const s = await ctx.state.get();
  return isAskState(s) ? s : null;
}

// ---------- wording ----------

export function askText(stream: StreamRow): string {
  if (stream.ask_text) return stream.ask_text;
  if (stream.shape === "bool") return `${stream.name}，今天做了吗？ · done today?`;
  if (stream.shape === "duration") return `今天${stream.name}多久？ · how long today?`;
  return `今天的${stream.name}？ · today's ${stream.name}?`;
}

function quickRow(stream: StreamRow): { text: string; callback_data: string }[] {
  const values = stream.quick.length ? stream.quick : stream.shape === "bool" ? [1, 0] : [];
  return values.slice(0, 4).map((v) => ({
    text: fmtQuick(stream.shape, stream.unit, v),
    callback_data: cb.streamValue(stream.id, Math.round(v)),
  }));
}

export function askCard(stream: StreamRow): Reply {
  const rows = [quickRow(stream), [{ text: "今天跳过 · Skip", callback_data: cb.streamSkip(stream.id) }]];
  return { text: `📊 ${askText(stream)}`, reply_markup: { inline_keyboard: rows.filter((r) => r.length) } };
}

/** The line a goal adds under a value: where the period stands, and the verdict. */
export function goalLine(t: Tracker): string | null {
  if (!t.goal || !t.status) return null;
  const s = t.stream, st = t.status;
  if (t.goal.kind === "accumulate") {
    const period = t.goal.period ?? "week";
    const done = fmtTotal(s.shape, s.unit, st.current ?? 0);
    const target = fmtTotal(s.shape, s.unit, t.goal.target);
    const left = st.days_left ?? 0;
    return `${PERIOD_LABEL[period].split(" ")[0]} ${done} / ${target} · ${VERDICT_TEXT[st.verdict]}`
      + (st.verdict === "ahead" ? " ✓" : ` · 还剩 ${left} 天`);
  }
  const now = st.current === null ? "—" : fmtValue(s.shape, s.unit, st.current);
  const target = fmtValue(s.shape, s.unit, t.goal.target);
  const projected = st.projected_date ? ` · 预计 ${st.projected_date}` : "";
  return `${now} → ${target} · ${VERDICT_TEXT[st.verdict]}${projected}`;
}

/** One tracker as a card: the name, where it stands, and the buttons that act on it. */
export function trackerCard(t: Tracker): Reply {
  const s = t.stream;
  const lines = [`📊 ${s.name}`];
  const goal = goalLine(t);
  if (goal) lines.push(goal);
  if (isNumeric(s.shape)) lines.push(`今天 · today ${fmtTotal(s.shape, s.unit, t.today_total)}`);
  if (t.latest) lines.push(`最近 · latest ${fmtValue(s.shape, s.unit, t.latest.num, t.latest.text)}（${t.latest.at}）`);
  const rows = [quickRow(s)];
  if (s.shape === "duration") rows.push([{ text: "⏱ 开始计时 · Start timer", callback_data: cb.timerStart(s.id) }]);
  return { text: lines.join("\n"), ...(rows.some((r) => r.length) && { reply_markup: { inline_keyboard: rows.filter((r) => r.length) } }) };
}

/** `/tracks` — every tracker at a glance. */
export async function tracksCard(ctx: StreamContext): Promise<Reply> {
  const list = await trackers(ctx.db, ctx.userId, ctx.today);
  if (!list.length) {
    return {
      text: "还没有追踪 · No trackers yet.\n"
        + "跟道引说一句你想记什么，比如「我想每周读书 10 小时」 · Tell the Guide what you want to track.",
    };
  }
  const lines = ["📊 追踪 · Tracks", ""];
  for (const t of list) {
    lines.push(`${t.stream.name} — ${goalLine(t) ?? fmtTotal(t.stream.shape, t.stream.unit, t.today_total) + " 今天"}`);
  }
  return {
    text: lines.join("\n"),
    reply_markup: { inline_keyboard: list.slice(0, 8).map((t) => [{ text: t.stream.name, callback_data: cb.trackerShow(t.stream.id) }]) },
  };
}

// ---------- logging ----------

function echo(t: Tracker, num: number | null, text: string | null, obsId: number, undo: boolean): Reply {
  const s = t.stream;
  const lines = [`✓ ${s.name} ${fmtValue(s.shape, s.unit, num, text)}`];
  const goal = goalLine(t);
  if (goal) lines.push(goal);
  return {
    text: lines.join("\n"),
    ...(undo && { reply_markup: { inline_keyboard: [[{ text: "撤销 · Undo", callback_data: cb.obsUndo(obsId) }]] } }),
  };
}

/** Write one observation and echo where it leaves the goal. `undo` is on for anything inferred. */
export async function record(
  ctx: StreamContext, stream: StreamRow, value: { num: number | null; text?: string | null },
  opts: { source?: string; undo?: boolean; quiet?: boolean } = {}
): Promise<boolean> {
  const r = await logObservation(ctx.db, ctx.userId, stream, {
    at: ctx.today, num: value.num, text: value.text ?? null, source: opts.source ?? "telegram",
  });
  if (!r.ok) {
    await ctx.send({ text: `没能记下 · Could not log: ${r.error}` });
    return false;
  }
  await logEvent(ctx.db, ctx.userId, "stream", "used");
  if (!opts.quiet) {
    const t = await tracker(ctx.db, ctx.userId, stream, ctx.today);
    await ctx.send(echo(t, r.num, r.text, r.id, opts.undo ?? false));
  }
  return true;
}

// ---------- L1: a pending ask ----------

export async function awaitStream(ctx: Pick<StreamContext, "state">, streamId: number, date: string): Promise<void> {
  const state: AskState = { kind: "awaiting_stream", stream_id: streamId, date, expires_at: Date.now() + ASK_ANSWER_SECONDS * 1000 };
  await ctx.state.put(state, ASK_SLOT_SECONDS);
}

/** The scheduled ask: one stream, one question, one-tap answers. */
export async function sendStreamAsk(ctx: StreamContext, stream: StreamRow): Promise<void> {
  await awaitStream(ctx, stream.id, ctx.today);
  await ctx.send(askCard(stream));
}

/**
 * Router step 3. Free text while a stream's ask is open is its answer, parsed against that stream's
 * shape — the one place where the expected shape is known, so no guessing is involved.
 */
export async function streamAskAnswer(ctx: StreamContext, text: string): Promise<boolean> {
  const state = await loadAsk(ctx);
  if (!state) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    await ctx.send({ text: "⌛ 这个提问已过期，这条收进 Inbox · That prompt expired — capturing instead." });
    return false;
  }
  const stream = await streamById(ctx.db, ctx.userId, state.stream_id);
  if (!stream) {
    await ctx.state.clear();
    return false;
  }
  const parsed = parseShape(stream.shape, text, stream.unit);
  if (!parsed) {
    await ctx.send({ text: `没读懂 · Couldn't read that — ${askText(stream)}` });
    return true;
  }
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, `stream:${stream.id}`, state.date);
  if (parsed.declined && parsed.num === 0 && stream.shape !== "bool") {
    await ctx.send({ text: `好，今天不记 ${stream.name} · Skipped for today` });
    return true;
  }
  await record(ctx, stream, parsed);
  return true;
}

// ---------- L3: aliases ----------

/**
 * Router step 3b. A message that names a stream and carries a value logs straight away — matched by a
 * pattern built in code from the stream's aliases, never by a model (PRD-brain §8.3). The undo button
 * is what makes claiming a message this eagerly safe.
 */
export async function streamPatternMatch(ctx: StreamContext, text: string): Promise<boolean> {
  const streams = await activeStreams(ctx.db, ctx.userId);
  for (const stream of streams) {
    if (!isNumeric(stream.shape)) continue;
    const valueText = matchStream(text, stream.aliases, stream.shape);
    if (valueText === null) continue;
    const parsed = parseShape(stream.shape, valueText, stream.unit);
    if (!parsed || parsed.num === null) continue;
    await record(ctx, stream, parsed, { undo: true });
    return true;
  }
  // A bare number belongs to a stream only when exactly one opted in and can hold it (PRD-brain §8.3).
  const bare = /^\s*(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (bare) {
    const value = Number(bare[1]);
    const candidates = streams.filter((s) => s.bare_value_capture && isNumeric(s.shape)
      && (s.min_value === null || value >= s.min_value) && (s.max_value === null || value <= s.max_value));
    if (candidates.length === 1) {
      await record(ctx, candidates[0], { num: value }, { undo: true });
      return true;
    }
  }
  return false;
}

// ---------- commands ----------

/** `/log 读书 45` · `/log 读书` opens the ask. */
export async function logCommand(ctx: StreamContext, args: string): Promise<void> {
  const streams = await activeStreams(ctx.db, ctx.userId);
  if (!streams.length) return void (await ctx.send(await tracksCard(ctx)));
  const trimmed = args.trim();
  if (!trimmed) return void (await ctx.send(await tracksCard(ctx)));

  // The longest matching name or alias wins, so "读书 45" beats a stream called "书".
  let best: { stream: StreamRow; rest: string } | null = null;
  for (const s of streams) {
    for (const word of [s.name, ...s.aliases]) {
      const n = normalise(word);
      if (!n || !normalise(trimmed).startsWith(n)) continue;
      const rest = trimmed.slice(word.length).trim() || trimmed.replace(new RegExp(`^${word}`, "i"), "").trim();
      if (!best || word.length > normalise(best.stream.name).length) best = { stream: s, rest };
    }
  }
  if (!best) {
    await ctx.send({ text: `没找到「${trimmed.split(/\s+/)[0]}」 · No tracker by that name. /tracks 看全部` });
    return;
  }
  if (!best.rest) {
    await awaitStream(ctx, best.stream.id, ctx.today);
    await ctx.send(askCard(best.stream));
    return;
  }
  const parsed = parseShape(best.stream.shape, best.rest, best.stream.unit);
  if (!parsed) {
    await ctx.send({ text: `没读懂「${best.rest}」 · Couldn't read that value` });
    return;
  }
  await record(ctx, best.stream, parsed);
}

/** `/tracks` */
export async function tracksCommand(ctx: StreamContext): Promise<void> {
  await ctx.send(await tracksCard(ctx));
}

// ---------- timer ----------

export async function timerStart(ctx: StreamContext, args: string): Promise<void> {
  const running = await runningTimer(ctx.db, ctx.userId);
  if (running) {
    const s = await streamById(ctx.db, ctx.userId, running.stream_id);
    await ctx.send({ text: `已经在计时：${s?.name ?? "?"}（${running.minutes} 分钟）· A timer is already running — /停止 first` });
    return;
  }
  const stream = args.trim() ? await streamByWord(ctx.db, ctx.userId, args.trim()) : null;
  if (!stream) {
    const list = (await activeStreams(ctx.db, ctx.userId)).filter((s) => s.shape === "duration");
    if (!list.length) {
      await ctx.send({ text: "没有可计时的追踪 · No duration tracker yet." });
      return;
    }
    await ctx.send({
      text: "⏱ 给哪个计时？ · Time which one?",
      reply_markup: { inline_keyboard: list.slice(0, 6).map((s) => [{ text: s.name, callback_data: cb.timerStart(s.id) }]) },
    });
    return;
  }
  await beginTimer(ctx, stream);
}

export async function beginTimer(ctx: StreamContext, stream: StreamRow): Promise<void> {
  await startTimer(ctx.db, ctx.userId, stream.id);
  await ctx.send({
    text: `⏱ ${stream.name} 开始计时 · Timer running.\n结束时发 /stop · /stop when you are done`,
    reply_markup: { inline_keyboard: [[{ text: "⏹ 停止 · Stop", callback_data: cb.timerStop() }]] },
  });
}

/** Stop the timer and log the minutes. Anything under a minute is not worth a row. */
export async function timerStop(ctx: StreamContext): Promise<boolean> {
  const running = await runningTimer(ctx.db, ctx.userId);
  if (!running) {
    await ctx.send({ text: "没有在计时 · No timer running. /timer <名字> 开始一个" });
    return false;
  }
  await clearTimer(ctx.db, ctx.userId);
  const stream = await streamById(ctx.db, ctx.userId, running.stream_id);
  if (!stream) return false;
  const minutes = Math.max(0, running.minutes);
  if (minutes < 1) {
    await ctx.send({ text: "不到一分钟，没记 · Under a minute — nothing logged" });
    return false;
  }
  await record(ctx, stream, { num: minutes }, { source: "timer" });
  return true;
}

// ---------- button handlers ----------

/** sv:<stream>:<n> — a one-tap answer. Absolute, so a replayed tap logs the same value once more only. */
export async function streamValueButton(ctx: CallbackContext, streamId: number, value: number): Promise<string> {
  const stream = await streamById(ctx.db, ctx.userId, streamId);
  if (!stream) return "找不到这个追踪 · Tracker not found";
  const ask = await loadAsk(ctx);
  if (ask?.stream_id === streamId) {
    await ctx.state.clear();
    await logReply(ctx.db, ctx.userId, `stream:${streamId}`, ask.date);
  }
  const r = await logObservation(ctx.db, ctx.userId, stream, { at: ctx.today, num: value, source: "telegram" });
  if (!r.ok) return r.error;
  await logEvent(ctx.db, ctx.userId, "stream", "used");
  const t = await tracker(ctx.db, ctx.userId, stream, ctx.today);
  await ctx.edit(echo(t, value, null, r.id, true));
  return `已记 ${fmtValue(stream.shape, stream.unit, value)}`;
}

/** sv:<stream>:x — nothing today. */
export async function streamSkipButton(ctx: CallbackContext, streamId: number): Promise<string> {
  const stream = await streamById(ctx.db, ctx.userId, streamId);
  const ask = await loadAsk(ctx);
  if (ask?.stream_id === streamId) await ctx.state.clear();
  await ctx.finish(`今天跳过 ${stream?.name ?? ""} · Skipped for today`);
  return "已跳过 · Skipped";
}

/** su:<obsId> — one tap removes an inferred reading (PRD-brain §8.5). */
export async function obsUndoButton(ctx: CallbackContext, obsId: number): Promise<string> {
  const gone = await deleteObservation(ctx.db, ctx.userId, obsId, ctx.today);
  if (!gone) return "已经撤销过了 · Already undone";
  await ctx.finish("↩︎ 已撤销 · Undone");
  return "已撤销 · Undone";
}

export async function trackerShowButton(ctx: CallbackContext, streamId: number): Promise<string> {
  const stream = await streamById(ctx.db, ctx.userId, streamId);
  if (!stream) return "找不到这个追踪 · Tracker not found";
  await ctx.send(trackerCard(await tracker(ctx.db, ctx.userId, stream, ctx.today)));
  return "";
}

export async function timerStartButton(ctx: CallbackContext, streamId: number): Promise<string> {
  const stream = await streamById(ctx.db, ctx.userId, streamId);
  if (!stream) return "找不到这个追踪 · Tracker not found";
  const running = await runningTimer(ctx.db, ctx.userId);
  if (running) return "已经在计时 · A timer is already running";
  await beginTimer(ctx, stream);
  return "开始计时 · Timer started";
}

export async function timerStopButton(ctx: CallbackContext): Promise<string> {
  const ok = await timerStop(ctx);
  return ok ? "已停止 · Stopped" : "没有在计时 · No timer";
}

/** The trackers due to be asked now — the scheduler claims each one separately (schedule.ts). */
export async function dueAsks(db: D1Database, userId: number, minutes: number, windowMin: number, today: string): Promise<StreamRow[]> {
  const streams = await activeStreams(db, userId);
  const due: StreamRow[] = [];
  for (const s of streams) {
    if (!s.ask_at) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.ask_at);
    if (!m) continue;
    const slot = Number(m[1]) * 60 + Number(m[2]);
    if (minutes < slot || minutes >= slot + windowMin) continue;
    // Silent on a stream that already has something today — the ask is conditional (PRD-brain §6).
    const t = await db.prepare("SELECT 1 FROM observations WHERE user_id = ? AND stream_id = ? AND at = ? LIMIT 1")
      .bind(userId, s.id, today).first();
    if (!t) due.push(s);
  }
  return due;
}

export type { Shape };
