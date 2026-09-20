// Telegram webhook (PRD §4.3–§4.5): POST /api/telegram/webhook in index.ts, the bot's single entry point.
//   secret      → X-Telegram-Bot-Api-Secret-Token compared in constant time; a mismatch is an empty 200 + a log line
//   dedupe      → INSERT OR IGNORE telegram_updates(update_id); 0 changes = already handled → 200, nothing runs
//   respond     → 200 at once; handleUpdate runs inside waitUntil
//   inline      → inline_query / chosen_inline_result need no chat: answered before anything else (capture.ts)
//   link        → `/start link_<nonce>` goes to redeemLink before any user is required (link.ts)
//   resolve     → from.id → telegram_accounts.user_id, once; every handler gets that userId (never chat_id)
//   unknown     → /start offers to link or to create an account (register.ts); anything else says "link first"
//   dispatch    → flood guard, then routeUpdate with the handlers below (commands.ts, callback.ts, the state machines)
//   photo       → a meal photo goes to meal.ts (PRD-body §5.2); every other photo keeps the TEXT_ONLY reply
//   errors      → logged, and the user gets 出错了，请稍后再试; the response was already a 200
//
// Registration (once per bot): wrangler secret put TELEGRAM_WEBHOOK_SECRET, then POST /api/telegram/setup
// (`npm run telegram:setup`), which calls setWebhook with the same secret and ALLOWED_UPDATES.
// Every Bot API call goes through api.ts.

import { timingSafeEqual } from "../auth.ts";
import type { GuideEnv } from "../guide.ts";
import { timezoneAnswer } from "./account.ts";
import { editReply, orThrow, sendReply, sendReplyId, TelegramBot } from "./api.ts";
import { handleCallback, parseCallback, type CallbackContext } from "./callback.ts";
import { answerInline, captureVoice, chosenInline } from "./capture.ts";
import { handleCommand } from "./commands.ts";
import { logEvent } from "./events.ts";
import { goalProgressAnswer } from "./goals.ts";
import { guideReplyThread } from "./guide.ts";
import { redeemLink } from "./link.ts";
import { onboardAnswer, registerCreate, registerOffer, startOnboarding } from "./register.ts";
import { reviewAnswer } from "./review.ts";
import {
  captureMessage, floodGuard, parseCommand, routeUpdate, SLOW_DOWN, type Reply, type TgUpdate,
} from "./router.ts";
import { mealNumbersAnswer, mealPhoto } from "./meal.ts";
import { localDate } from "./schedule.ts";
import { d1StateStore } from "./state.ts";
import { topThreeAnswer } from "./topthree.ts";
import { weightAnswer } from "./bodynudge.ts";
import { workoutAnswer } from "./workout.ts";
import { weeklyPlanAnswer } from "./weekly.ts";

export interface WebhookEnv extends GuideEnv {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN?: string;
  TG_FLOOD_LIMITER?: RateLimit;
}

export const SECRET_HEADER = "X-Telegram-Bot-Api-Secret-Token";

/** Constant-time check of the setWebhook secret. No secret configured = every request is refused. */
export function secretTokenOk(expected: string | undefined, given: string | undefined): boolean {
  return !!expected && timingSafeEqual(given ?? "", expected);
}

export function isUpdate(v: unknown): v is TgUpdate {
  return !!v && typeof v === "object" && Number.isSafeInteger((v as { update_id?: unknown }).update_id);
}

/** True the first time an update_id is seen; a Telegram retry or a replay reads false. */
export async function claimUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const r = await db.prepare("INSERT OR IGNORE INTO telegram_updates (update_id) VALUES (?)").bind(updateId).run();
  return r.meta.changes > 0;
}

// ---------- replies ----------

const ERROR: Reply = { text: "出错了，请稍后再试 · Something went wrong — please try again later." };

function linkFirst(origin: string): Reply {
  return {
    text: "这个 Telegram 还没连接 Way 账号 · This Telegram isn't linked to a Way account yet.\n" +
      `在 ${origin}/settings 连接，或发 /start 在这里创建账号 · Link at ${origin}/settings, or /start to create an account here`,
  };
}

/** answerCallbackQuery toasts are capped at 200 characters. */
const LINK_FIRST_TOAST = "请先连接 Way 账号：/start · Link your Way account first: /start";

const TEXT_ONLY: Reply = { text: "目前只收文字和语音 · Text and voice only for now — send it as a message." };

// ---------- the update ----------

function todayIn(timeZone: string | null): string {
  try {
    return localDate(timeZone || "UTC", new Date());
  } catch {
    return localDate("UTC", new Date());
  }
}

/** Everything after the dedupe; runs inside waitUntil. Never throws. */
export async function handleUpdate(env: WebhookEnv, update: TgUpdate, origin: string): Promise<void> {
  let bot: TelegramBot;
  try {
    bot = TelegramBot.fromEnv(env);
  } catch (e) {
    console.error("telegram webhook:", e);
    return;
  }
  // Inline mode carries no chat; it is answered on its own.
  if (update.inline_query) {
    await answerInline(bot, env.DB, update.inline_query).catch((e) => console.error("telegram inline: failed", e));
    return;
  }
  if (update.chosen_inline_result) {
    await chosenInline(env.DB, update.chosen_inline_result).catch((e) => console.error("telegram inline: capture failed", e));
    return;
  }
  const query = update.callback_query;
  const from = update.message?.from ?? query?.from;
  // A tap on a message too old to be delivered with the query still has a private chat: the user's own id.
  const chatId = update.message?.chat.id ?? query?.message?.chat.id ?? from?.id;
  if (!from || chatId === undefined) return;
  const send = (reply: Reply) => sendReply(bot, chatId, reply);
  try {
    await dispatch(env, bot, update, from.id, chatId, send, origin);
  } catch (e) {
    console.error(`telegram webhook: update ${update.update_id} failed`, e);
    if (query) await bot.answerCallbackQuery({ callback_query_id: query.id });
    await send(ERROR).catch((err) => console.error("telegram webhook: error reply failed", err));
  }
}

async function dispatch(
  env: WebhookEnv, bot: TelegramBot, update: TgUpdate, telegramUserId: number, chatId: number,
  send: (reply: Reply) => Promise<void>, origin: string,
): Promise<void> {
  const db = env.DB;
  const query = update.callback_query;
  let answered = false;
  const answer = async (text?: string) => {
    if (!query || answered) return;
    answered = true;
    orThrow(await bot.answerCallbackQuery({ callback_query_id: query.id, ...(text && { text }) }));
  };

  // `/start link_<nonce>` comes from someone with no Way user yet (or re-linking), so it runs before resolution.
  const start = update.message?.text ? parseCommand(update.message.text) : null;
  if (update.message && start?.name === "start") {
    const reply = await redeemLink({ db, origin }, start.args, update.message);
    if (reply) return send(reply);
  }

  let account = await db.prepare(
    "SELECT a.user_id, u.timezone FROM telegram_accounts a JOIN users u ON u.id = a.user_id WHERE a.telegram_user_id = ?"
  ).bind(telegramUserId).first<{ user_id: number; timezone: string | null }>();

  if (!account) {
    // rg:y — create the account right here (register.ts), then continue as that user.
    const tapped = query?.data ? parseCallback(query.data) : null;
    if (query && tapped?.verb === "register") {
      if (!tapped.yes) return answer("好的 · OK");
      const from = query.from;
      const userId = await registerCreate(db, from, chatId);
      if (userId === null) return answer("这个 Telegram 已经连接了账号 · Already linked");
      await answer("账号已创建 · Account created");
      if (query.message) await editReply(bot, chatId, query.message.message_id, { text: "✨ 账号已创建 · Account created" });
      account = { user_id: userId, timezone: null };
      await startOnboarding({
        db, userId, timezone: null, state: d1StateStore(db, userId), send,
      });
      return;
    }
    if (query) return answer(LINK_FIRST_TOAST);
    if (update.message) return send(start?.name === "start" ? registerOffer(origin) : linkFirst(origin));
    return;
  }
  const userId = account.user_id;

  if (!(await floodGuard(env.TG_FLOOD_LIMITER, userId))) {
    return query ? answer(SLOW_DOWN.text) : send(SLOW_DOWN);
  }

  const tapped = query?.message;
  const ctx: CallbackContext = {
    db,
    userId,
    today: todayIn(account.timezone),
    timezone: account.timezone,
    origin,
    state: d1StateStore(db, userId),
    guide: env,
    bot,
    answer,
    finish: (text) => (tapped ? editReply(bot, tapped.chat.id, tapped.message_id, { text }) : send({ text })),
    edit: (reply) => (tapped ? editReply(bot, tapped.chat.id, tapped.message_id, reply) : send(reply)),
    send,
    sendId: (reply) => sendReplyId(bot, chatId, reply),
    typing: async () => { await bot.sendChatAction({ chat_id: chatId, action: "typing" }); },
  };

  await routeUpdate(update, {
    callback: (q) => handleCallback(ctx, q.data ?? ""),
    command: (name, args, message) => handleCommand(ctx, name, args, message),
    // Each state machine only takes its own kind, so the order only matters for who looks first.
    pendingState: async (_message, text) =>
      (await reviewAnswer(ctx, text)) || (await topThreeAnswer(ctx, text)) || (await weeklyPlanAnswer(ctx, text))
      || (await weightAnswer(ctx, text)) || (await workoutAnswer(ctx, text)) || (await mealNumbersAnswer(ctx, text))
      || (await goalProgressAnswer(ctx, text))
      || (await timezoneAnswer(ctx, text))
      || (await onboardAnswer(ctx, text)),
    guideReply: (message, text) => guideReplyThread(ctx, message, text),
    capture: async (message, text) => {
      await send(await captureMessage(db, userId, text, message));
      await logEvent(db, userId, "capture", "used");
    },
    voice: (message) => captureVoice(ctx, message),
    // A meal photo (PRD-body §5.2); anything else photographic falls through to capture or TEXT_ONLY.
    photo: (message, caption) => mealPhoto(ctx, message, caption),
    inlineQuery: async () => {},   // handled before dispatch
    chosenInline: async () => {},
    unsupported: () => send(TEXT_ONLY),
  });
}
