// Evening review (PRD §6.3): a short state machine kept in telegram_state, TTL 6 h.
//   startReview      → scoreboard + four rows of 1–5 (rt:<field>:<n>; each tap edits the card in place) + [下一步]
//   rv:next          → the daily questions one at a time; a typed answer (reviewAnswer) or [跳过 Skip] advances
//   after the last   → the daily reviews row, 复盘完成 ✓ 连续 N 天, and [设为明天的焦点] when the last question was answered
// Ratings go straight to days.{mood,energy,focus,satisfaction} — what the Insights mood chart reads.
// Answers are saved to reviews (period 'daily', period_start = the local date) after each one, so an
// abandoned run keeps what was typed. A command pauses the run (interruptReview) and offers [继续复盘].
//
// Webhook wiring (#6/#20): the scheduler's review prompt calls startReview; the router's pendingState
// handler calls reviewAnswer; the command handler sends interruptReview's reply after the command's own.

import { REVIEW_QUESTIONS } from "../../shared/reviews.ts";
import { updateDay } from "../days.ts";
import { dailyReviewStreak, upsertReview } from "../reviews.ts";
import { cb, RATING_FIELDS, shiftDate, type CallbackContext, type RatingField } from "./callback.ts";
import type { Reply } from "./router.ts";

export const REVIEW_STATE_TTL_SECONDS = 6 * 60 * 60;

const QUESTIONS = REVIEW_QUESTIONS.daily;
const FOCUS_QUESTION = QUESTIONS[QUESTIONS.length - 1]; // "What is tomorrow's single focus?"

const RATING_LABELS: Record<RatingField, [emoji: string, label: string]> = {
  mood: ["🙂", "心情 Mood"],
  energy: ["⚡", "精力 Energy"],
  focus: ["🎯", "专注 Focus"],
  satisfaction: ["⭐", "满意 Satisfaction"],
};

export interface ReviewState {
  kind: "review";
  /** The local date under review, fixed at start so a run that crosses midnight stays on its day. */
  date: string;
  /** 0 = ratings; 1..QUESTIONS.length = that question. */
  step: number;
  /** Question text → answer (the reviews.answers shape); skipped questions are absent. */
  answers: Record<string, string>;
  /** A command interrupted the run: typed text is not an answer until [继续复盘]. */
  paused?: boolean;
}

export type ReviewContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

function isReviewState(v: unknown): v is ReviewState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<ReviewState>;
  return s.kind === "review" && typeof s.date === "string" && typeof s.step === "number"
    && s.step >= 0 && s.step <= QUESTIONS.length && !!s.answers && typeof s.answers === "object";
}

async function loadState(ctx: Pick<ReviewContext, "state">): Promise<ReviewState | null> {
  const s = await ctx.state.get();
  return isReviewState(s) ? s : null;
}

function saveState(ctx: Pick<ReviewContext, "state">, state: ReviewState): Promise<void> {
  return ctx.state.put(state, REVIEW_STATE_TTL_SECONDS);
}

function parseAnswers(json: string | undefined): Record<string, string> {
  try {
    const a: unknown = JSON.parse(json ?? "{}");
    return a && typeof a === "object" ? (a as Record<string, string>) : {};
  } catch {
    return {};
  }
}

// ---------- messages ----------

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}

/** 今天 · 7/9 tasks · Top three: ✓ ✓ ✗ · 3h20m focused */
async function scoreboard(ctx: ReviewContext, date: string): Promise<string> {
  const t = await ctx.db.prepare(
    `SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done,
            COALESCE(SUM(CASE WHEN done = 1 THEN COALESCE(actual_min, estimate_min, 0) ELSE 0 END), 0) AS focus_min
     FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0`
  ).bind(ctx.userId, date).first<{ total: number; done: number; focus_min: number }>();
  const day = await ctx.db.prepare(
    "SELECT top1, top1_done, top2, top2_done, top3, top3_done FROM days WHERE user_id = ? AND date = ?"
  ).bind(ctx.userId, date).first<Record<string, string | number>>();
  const tops = day ? [1, 2, 3].filter((i) => day[`top${i}`]).map((i) => (day[`top${i}_done`] ? "✓" : "✗")) : [];
  return `${date === ctx.today ? "今天" : date} · ${t?.done ?? 0}/${t?.total ?? 0} tasks · Top three: ${
    tops.length ? tops.join(" ") : "—"} · ${fmtMinutes(t?.focus_min ?? 0)} focused`;
}

async function ratingsCard(ctx: ReviewContext, date: string): Promise<Reply> {
  const day = await ctx.db.prepare("SELECT mood, energy, focus, satisfaction FROM days WHERE user_id = ? AND date = ?")
    .bind(ctx.userId, date).first<Record<RatingField, number | null>>();
  const lines = RATING_FIELDS.map((f) => `${RATING_LABELS[f][0]} ${RATING_LABELS[f][1]} · ${day?.[f] ?? "—"}`);
  return {
    text: [await scoreboard(ctx, date), "", "给今天打分 · Rate today (1–5)", ...lines].join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...RATING_FIELDS.map((f) => [1, 2, 3, 4, 5].map((n) => ({
          text: day?.[f] === n ? `【${n}】` : `${RATING_LABELS[f][0]}${n}`,
          callback_data: cb.rating(f, n),
        }))),
        [{ text: "下一步 Next →", callback_data: cb.review("next") }],
      ],
    },
  };
}

function questionTitle(step: number): string {
  return `${step}/${QUESTIONS.length} · ${QUESTIONS[step - 1]}`;
}

function questionCard(step: number): Reply {
  return {
    text: `${questionTitle(step)}\n\n直接回复作答 · Reply to answer`,
    reply_markup: { inline_keyboard: [[{ text: "跳过 Skip", callback_data: cb.reviewSkip(step) }]] },
  };
}

function promptFor(ctx: ReviewContext, state: ReviewState): Promise<Reply> | Reply {
  return state.step === 0 ? ratingsCard(ctx, state.date) : questionCard(state.step);
}

async function doneText(ctx: ReviewContext, date: string): Promise<string> {
  return `复盘完成 ✓  连续 ${await dailyReviewStreak(ctx.db, ctx.userId, date)} 天`;
}

// ---------- writes ----------

/** Merge the run's answers into the daily reviews row, with the day's ratings; the first answer also fills an empty days.reflection. */
async function saveReview(ctx: ReviewContext, state: ReviewState): Promise<void> {
  const day = await ctx.db.prepare("SELECT reflection, mood, energy, focus, satisfaction FROM days WHERE user_id = ? AND date = ?")
    .bind(ctx.userId, state.date)
    .first<{ reflection: string } & Record<RatingField, number | null>>();
  const existing = await ctx.db.prepare(
    "SELECT answers, mood, energy, focus, satisfaction FROM reviews WHERE user_id = ? AND period = 'daily' AND period_start = ?"
  ).bind(ctx.userId, state.date).first<{ answers: string } & Record<RatingField, number | null>>();
  await upsertReview(ctx.db, ctx.userId, {
    period: "daily",
    period_start: state.date,
    answers: { ...parseAnswers(existing?.answers), ...state.answers },
    mood: day?.mood ?? existing?.mood,
    energy: day?.energy ?? existing?.energy,
    focus: day?.focus ?? existing?.focus,
    satisfaction: day?.satisfaction ?? existing?.satisfaction,
  });
  const first = state.answers[QUESTIONS[0]];
  if (first && !day?.reflection) await updateDay(ctx.db, ctx.userId, state.date, { reflection: first });
}

/** Move past the current question: the next one, or close the run after the last. */
async function advance(ctx: ReviewContext, state: ReviewState, answered: boolean): Promise<void> {
  if (state.step >= QUESTIONS.length) return closeReview(ctx, state);
  if (answered) await saveReview(ctx, state);
  state.step++;
  await saveState(ctx, state);
  await ctx.send(questionCard(state.step));
}

async function closeReview(ctx: ReviewContext, state: ReviewState): Promise<void> {
  await saveReview(ctx, state);
  await ctx.state.clear();
  const focus = state.answers[FOCUS_QUESTION]?.trim();
  await ctx.send({
    text: await doneText(ctx, state.date) + (focus ? `\n\n明天的焦点 · Tomorrow's focus\n"${focus}"` : ""),
    ...(focus && { reply_markup: { inline_keyboard: [[{ text: "设为明天的焦点", callback_data: cb.reviewFocus(state.date) }]] } }),
  });
}

// ---------- entry points ----------

/** The 21:30 prompt: start (or restart) today's review with the scoreboard and the ratings card. */
export async function startReview(ctx: ReviewContext): Promise<void> {
  const prev = await loadState(ctx);
  // Restarting the same day keeps answers already given.
  await saveState(ctx, { kind: "review", date: ctx.today, step: 0, answers: prev?.date === ctx.today ? prev.answers : {} });
  await ctx.send(await ratingsCard(ctx, ctx.today));
}

/** Router step 3: a typed message while a review waits on a question. False when it is not ours to take. */
export async function reviewAnswer(ctx: ReviewContext, text: string): Promise<boolean> {
  const state = await loadState(ctx);
  if (!state || state.paused || state.step < 1) return false;
  state.answers[QUESTIONS[state.step - 1]] = text;
  await advance(ctx, state, true);
  return true;
}

/** After any command: pause a review in progress and return the [继续复盘] offer to send, or null. */
export async function interruptReview(ctx: Pick<ReviewContext, "state">): Promise<Reply | null> {
  const state = await loadState(ctx);
  if (!state) return null;
  if (!state.paused) await saveState(ctx, { ...state, paused: true });
  const answered = Object.keys(state.answers).length;
  return {
    text: `复盘已暂停 · Review paused${answered ? `\n已答 ${answered} 题，都还在 · ${answered} answer(s) kept` : ""}`,
    reply_markup: { inline_keyboard: [[{ text: "继续复盘", callback_data: cb.review("resume") }]] },
  };
}

// ---------- button handlers (dispatched by handleCallback) ----------

/** rt:<field>:<n> — writes the day's rating and redraws the card in place. Absolute, so a replay is a no-op. */
export async function rateDay(ctx: CallbackContext, field: RatingField, n: number): Promise<string> {
  const date = (await loadState(ctx))?.date ?? ctx.today;
  await updateDay(ctx.db, ctx.userId, date, { [field]: n });
  await ctx.edit(await ratingsCard(ctx, date));
  return `${RATING_LABELS[field][1]} · ${n}`;
}

/** rv:next — ratings done; freeze the card and ask the first question. */
export async function reviewNext(ctx: CallbackContext): Promise<string> {
  const state = await loadState(ctx);
  await ctx.finish((await ratingsCard(ctx, state?.date ?? ctx.today)).text);
  if (!state) return "没有进行中的复盘 · No review in progress";
  if (state.step !== 0) return "已经往下走了 · Already moved on";
  await advance(ctx, { ...state, paused: false }, false);
  return "下一步 · Next";
}

/** rv:skip:<q> — skip question q; a stale button (q already answered) only loses its keyboard. */
export async function reviewSkip(ctx: CallbackContext, question: number): Promise<string> {
  const state = await loadState(ctx);
  if (!state || state.step !== question) {
    await ctx.finish(questionTitle(question));
    return "这一题已经过了 · Already moved on";
  }
  await ctx.finish(`${questionTitle(question)}\n— 跳过 · Skipped`);
  await advance(ctx, { ...state, paused: false }, false);
  return "跳过 · Skipped";
}

/** rv:resume — unpause and ask again whatever the run was waiting on. */
export async function reviewResume(ctx: CallbackContext): Promise<string> {
  const state = await loadState(ctx);
  if (!state) {
    await ctx.finish("没有进行中的复盘 · No review in progress");
    return "复盘已结束或已过期 · Nothing to resume";
  }
  const resumed = { ...state, paused: false };
  await saveState(ctx, resumed);
  await ctx.finish("继续复盘 · Resuming review");
  await ctx.send(await promptFor(ctx, resumed));
  return "继续复盘 · Resumed";
}

/** rv:focus:<date> — the review's last answer becomes the next day's top1. Absolute, so a replay is a no-op. */
export async function reviewFocus(ctx: CallbackContext, date: string): Promise<string> {
  const row = await ctx.db.prepare("SELECT answers FROM reviews WHERE user_id = ? AND period = 'daily' AND period_start = ?")
    .bind(ctx.userId, date).first<{ answers: string }>();
  const focus = parseAnswers(row?.answers)[FOCUS_QUESTION]?.trim();
  if (!focus) return "没有找到明天的焦点 · No focus to set";
  await updateDay(ctx.db, ctx.userId, shiftDate(date, 1), { top1: focus });
  await ctx.finish(`${await doneText(ctx, date)}\n\n🎯 已设为明天的焦点 · Set as tomorrow's focus\n"${focus}"`);
  return "已设为明天的焦点 · Set";
}
