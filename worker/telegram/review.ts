// Reviews from the chat (PRD §6.3, #17; weekly per #25): a short state machine kept in telegram_state, TTL 6 h.
//   startReview      → scoreboard + four rows of 1–5 (rt:<field>:<n>; each tap edits the card in place) + [下一步]
//   rv:next          → the period's questions one at a time; a typed answer (reviewAnswer) or [跳过 Skip] advances
//   after the last   → the reviews row, 复盘完成 ✓ (连续 N 天 for daily), and [设为明天的焦点] when the daily focus was answered
// Daily ratings go straight to days.{mood,energy,focus,satisfaction} — what the Insights mood chart reads —
// and are mirrored into the reviews row. Weekly ratings live on the reviews row only.
// Answers are saved to reviews (period, period_start = the local date / Monday) after each one, so an
// abandoned run keeps what was typed. A command pauses the run (interruptReview) and offers [继续复盘].

import { REVIEW_QUESTIONS } from "../../shared/reviews.ts";
import { updateDay } from "../days.ts";
import { dailyReviewStreak, upsertReview } from "../reviews.ts";
import { weekStartOf } from "../dates.ts";
import { cb, RATING_FIELDS, shiftDate, type CallbackContext, type RatingField } from "./callback.ts";
import { logReply } from "./events.ts";
import type { Reply } from "./router.ts";

export const REVIEW_STATE_TTL_SECONDS = 6 * 60 * 60;

export type ReviewPeriodKind = "daily" | "weekly";

const RATING_LABELS: Record<RatingField, [emoji: string, label: string]> = {
  mood: ["🙂", "心情 Mood"],
  energy: ["⚡", "精力 Energy"],
  focus: ["🎯", "专注 Focus"],
  satisfaction: ["⭐", "满意 Satisfaction"],
};

type Ratings = Partial<Record<RatingField, number | null>>;

export interface ReviewState {
  kind: "review";
  period: ReviewPeriodKind;
  /** The local date (daily) or Monday (weekly) under review, fixed at start so a run that crosses midnight stays put. */
  date: string;
  /** 0 = ratings; 1..questions.length = that question. */
  step: number;
  /** Question text → answer (the reviews.answers shape); skipped questions are absent. */
  answers: Record<string, string>;
  /** Weekly only: the ratings tapped so far (daily ratings are read from the days row). */
  ratings?: Ratings;
  /** A command interrupted the run: typed text is not an answer until [继续复盘]. */
  paused?: boolean;
}

export type ReviewContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

function questionsOf(period: ReviewPeriodKind): string[] {
  return REVIEW_QUESTIONS[period];
}

function isReviewState(v: unknown): v is ReviewState {
  if (!v || typeof v !== "object") return false;
  const s = v as Partial<ReviewState>;
  const period: ReviewPeriodKind = s.period === "weekly" ? "weekly" : "daily";
  return s.kind === "review" && typeof s.date === "string" && typeof s.step === "number"
    && s.step >= 0 && s.step <= questionsOf(period).length && !!s.answers && typeof s.answers === "object";
}

async function loadState(ctx: Pick<ReviewContext, "state">): Promise<ReviewState | null> {
  const s = await ctx.state.get();
  if (!isReviewState(s)) return null;
  return { ...s, period: s.period === "weekly" ? "weekly" : "daily" };
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

/** The outbox kind this review answers, for the reply-rate numbers. */
function eventKind(period: ReviewPeriodKind): string {
  return period === "daily" ? "review_prompt" : "weekly_review";
}

// ---------- messages ----------

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h${m ? `${m}m` : ""}` : `${m}m`;
}

/** 今天 · 7/9 tasks · Top three: ✓ ✓ ✗ · 3h20m focused */
async function dailyScoreboard(ctx: ReviewContext, date: string): Promise<string> {
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

/** 本周 · 23/30 tasks · 5/7 daily reviews · 3 goals moved · 4h10m focused */
export async function weeklyScoreboard(ctx: Pick<ReviewContext, "db" | "userId">, weekStart: string): Promise<string> {
  const end = shiftDate(weekStart, 6);
  const r = await ctx.db.prepare(
    `SELECT
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 0 AND dropped = 0 AND date BETWEEN ?2 AND ?3) AS total,
       (SELECT COUNT(*) FROM tasks WHERE user_id = ?1 AND inbox = 0 AND done = 1 AND date BETWEEN ?2 AND ?3) AS done,
       (SELECT COALESCE(SUM(COALESCE(actual_min, estimate_min, 0)), 0) FROM tasks WHERE user_id = ?1 AND done = 1 AND date BETWEEN ?2 AND ?3) AS focus_min,
       (SELECT COUNT(*) FROM reviews WHERE user_id = ?1 AND period = 'daily' AND period_start BETWEEN ?2 AND ?3) AS reviews,
       (SELECT COUNT(*) FROM goals WHERE user_id = ?1 AND updated_at BETWEEN ?2 AND ?3 || 'T23:59:59' AND status IN ('active','at_risk','completed')) AS moved`
  ).bind(ctx.userId, weekStart, end).first<{ total: number; done: number; focus_min: number; reviews: number; moved: number }>();
  return `本周 ${weekStart} · ${r?.done ?? 0}/${r?.total ?? 0} tasks · ${r?.reviews ?? 0}/7 daily reviews · ${r?.moved ?? 0} goals moved · ${fmtMinutes(r?.focus_min ?? 0)} focused`;
}

async function readRatings(ctx: ReviewContext, state: ReviewState): Promise<Ratings> {
  if (state.period === "weekly") return state.ratings ?? {};
  const day = await ctx.db.prepare("SELECT mood, energy, focus, satisfaction FROM days WHERE user_id = ? AND date = ?")
    .bind(ctx.userId, state.date).first<Ratings>();
  return day ?? {};
}

async function ratingsCard(ctx: ReviewContext, state: ReviewState): Promise<Reply> {
  const ratings = await readRatings(ctx, state);
  const lines = RATING_FIELDS.map((f) => `${RATING_LABELS[f][0]} ${RATING_LABELS[f][1]} · ${ratings[f] ?? "—"}`);
  const board = state.period === "daily" ? await dailyScoreboard(ctx, state.date) : await weeklyScoreboard(ctx, state.date);
  return {
    text: [board, "", state.period === "daily" ? "给今天打分 · Rate today (1–5)" : "给这周打分 · Rate the week (1–5)", ...lines].join("\n"),
    reply_markup: {
      inline_keyboard: [
        ...RATING_FIELDS.map((f) => [1, 2, 3, 4, 5].map((n) => ({
          text: ratings[f] === n ? `【${n}】` : `${RATING_LABELS[f][0]}${n}`,
          callback_data: cb.rating(f, n),
        }))),
        [{ text: "下一步 Next →", callback_data: cb.review("next") }],
      ],
    },
  };
}

function questionTitle(period: ReviewPeriodKind, step: number): string {
  const qs = questionsOf(period);
  return `${step}/${qs.length} · ${qs[step - 1]}`;
}

function questionCard(period: ReviewPeriodKind, step: number): Reply {
  return {
    text: `${questionTitle(period, step)}\n\n直接回复作答 · Reply to answer`,
    reply_markup: { inline_keyboard: [[{ text: "跳过 Skip", callback_data: cb.reviewSkip(step) }]] },
  };
}

function promptFor(ctx: ReviewContext, state: ReviewState): Promise<Reply> | Reply {
  return state.step === 0 ? ratingsCard(ctx, state) : questionCard(state.period, state.step);
}

async function doneText(ctx: ReviewContext, state: ReviewState): Promise<string> {
  if (state.period === "weekly") return "周复盘完成 ✓ · Weekly review done";
  return `复盘完成 ✓  连续 ${await dailyReviewStreak(ctx.db, ctx.userId, state.date)} 天`;
}

// ---------- writes ----------

/** Merge the run's answers into the reviews row, with the ratings; a daily first answer also fills an empty days.reflection. */
async function saveReview(ctx: ReviewContext, state: ReviewState): Promise<void> {
  const ratings = await readRatings(ctx, state);
  const existing = await ctx.db.prepare(
    "SELECT answers, mood, energy, focus, satisfaction FROM reviews WHERE user_id = ? AND period = ? AND period_start = ?"
  ).bind(ctx.userId, state.period, state.date).first<{ answers: string } & Ratings>();
  await upsertReview(ctx.db, ctx.userId, {
    period: state.period,
    period_start: state.date,
    answers: { ...parseAnswers(existing?.answers), ...state.answers },
    mood: ratings.mood ?? existing?.mood,
    energy: ratings.energy ?? existing?.energy,
    focus: ratings.focus ?? existing?.focus,
    satisfaction: ratings.satisfaction ?? existing?.satisfaction,
  });
  if (state.period === "daily") {
    const first = state.answers[questionsOf("daily")[0]];
    if (first) {
      const day = await ctx.db.prepare("SELECT reflection FROM days WHERE user_id = ? AND date = ?")
        .bind(ctx.userId, state.date).first<{ reflection: string }>();
      if (!day?.reflection) await updateDay(ctx.db, ctx.userId, state.date, { reflection: first });
    }
  }
}

/** Move past the current question: the next one, or close the run after the last. */
async function advance(ctx: ReviewContext, state: ReviewState, answered: boolean): Promise<void> {
  if (state.step >= questionsOf(state.period).length) return closeReview(ctx, state);
  if (answered) await saveReview(ctx, state);
  state.step++;
  await saveState(ctx, state);
  await ctx.send(questionCard(state.period, state.step));
}

async function closeReview(ctx: ReviewContext, state: ReviewState): Promise<void> {
  await saveReview(ctx, state);
  await ctx.state.clear();
  const qs = questionsOf(state.period);
  const focus = state.period === "daily" ? state.answers[qs[qs.length - 1]]?.trim() : undefined;
  await ctx.send({
    text: await doneText(ctx, state) + (focus ? `\n\n明天的焦点 · Tomorrow's focus\n"${focus}"` : ""),
    ...(focus && { reply_markup: { inline_keyboard: [[{ text: "设为明天的焦点", callback_data: cb.reviewFocus(state.date) }]] } }),
  });
}

// ---------- entry points ----------

/** The 21:30 prompt (and /review): start (or restart) the review with the scoreboard and the ratings card. */
export async function startReview(ctx: ReviewContext, period: ReviewPeriodKind = "daily"): Promise<void> {
  const date = period === "daily" ? ctx.today : weekStartOf(ctx.today);
  const prev = await loadState(ctx);
  // Restarting the same period keeps answers already given.
  const same = prev?.period === period && prev.date === date;
  const state: ReviewState = { kind: "review", period, date, step: 0, answers: same ? prev.answers : {}, ratings: same ? prev.ratings : undefined };
  await saveState(ctx, state);
  await ctx.send(await ratingsCard(ctx, state));
}

/** Router step 3: a typed message while a review waits on a question. False when it is not ours to take. */
export async function reviewAnswer(ctx: ReviewContext, text: string): Promise<boolean> {
  const state = await loadState(ctx);
  if (!state || state.paused || state.step < 1) return false;
  state.answers[questionsOf(state.period)[state.step - 1]] = text;
  await logReply(ctx.db, ctx.userId, eventKind(state.period), state.period === "daily" ? state.date : ctx.today);
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

/** rt:<field>:<n> — writes the rating and redraws the card in place. Absolute, so a replay is a no-op. */
export async function rateDay(ctx: CallbackContext, field: RatingField, n: number): Promise<string> {
  const state = (await loadState(ctx)) ?? { kind: "review" as const, period: "daily" as const, date: ctx.today, step: 0, answers: {} };
  if (state.period === "weekly") {
    state.ratings = { ...state.ratings, [field]: n };
    await saveState(ctx, state);
  } else {
    await updateDay(ctx.db, ctx.userId, state.date, { [field]: n });
  }
  await logReply(ctx.db, ctx.userId, eventKind(state.period), state.period === "daily" ? state.date : ctx.today);
  await ctx.edit(await ratingsCard(ctx, state));
  return `${RATING_LABELS[field][1]} · ${n}`;
}

/** rv:next — ratings done; freeze the card and ask the first question. */
export async function reviewNext(ctx: CallbackContext): Promise<string> {
  const state = await loadState(ctx);
  if (!state) {
    await ctx.finish("没有进行中的复盘 · No review in progress — /review");
    return "没有进行中的复盘 · No review in progress";
  }
  await ctx.finish((await ratingsCard(ctx, state)).text);
  if (state.step !== 0) return "已经往下走了 · Already moved on";
  await advance(ctx, { ...state, paused: false }, false);
  return "下一步 · Next";
}

/** rv:skip:<q> — skip question q; a stale button (q already answered) only loses its keyboard. */
export async function reviewSkip(ctx: CallbackContext, question: number): Promise<string> {
  const state = await loadState(ctx);
  if (!state || state.step !== question) {
    await ctx.finish(questionTitle(state?.period ?? "daily", question));
    return "这一题已经过了 · Already moved on";
  }
  await ctx.finish(`${questionTitle(state.period, question)}\n— 跳过 · Skipped`);
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

/** rv:focus:<date> — the daily review's last answer becomes the next day's top1. Absolute, so a replay is a no-op. */
export async function reviewFocus(ctx: CallbackContext, date: string): Promise<string> {
  const qs = questionsOf("daily");
  const row = await ctx.db.prepare("SELECT answers FROM reviews WHERE user_id = ? AND period = 'daily' AND period_start = ?")
    .bind(ctx.userId, date).first<{ answers: string }>();
  const focus = parseAnswers(row?.answers)[qs[qs.length - 1]]?.trim();
  if (!focus) return "没有找到明天的焦点 · No focus to set";
  await updateDay(ctx.db, ctx.userId, shiftDate(date, 1), { top1: focus });
  const streak = await dailyReviewStreak(ctx.db, ctx.userId, date);
  await ctx.finish(`复盘完成 ✓  连续 ${streak} 天\n\n🎯 已设为明天的焦点 · Set as tomorrow's focus\n"${focus}"`);
  return "已设为明天的焦点 · Set";
}
