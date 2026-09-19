// Telegram webhook (PRD §4.3–§4.5): POST /api/telegram/webhook in index.ts, the bot's single entry point.
//   secret      → X-Telegram-Bot-Api-Secret-Token compared in constant time; a mismatch is an empty 200 + a log line
//   dedupe      → INSERT OR IGNORE telegram_updates(update_id); 0 changes = already handled → 200, nothing runs
//   respond     → 200 at once; handleUpdate runs inside waitUntil
//   link        → `/start link_<nonce>` goes to redeemLink before any user is required (see link.ts)
//   resolve     → from.id → telegram_accounts.user_id, once; every handler gets that userId (never chat_id)
//   unknown     → a sender with no linked account is told to link it on the web
//   dispatch    → flood guard, then routeUpdate with the handlers below
//   errors      → logged, and the user gets 出错了，请稍后再试; the response was already a 200
//
// Schema assumed from #4: telegram_updates(update_id PRIMARY KEY, created_at DEFAULT now) — housekeeping in
// schedule.ts deletes rows older than a day; telegram_accounts(user_id, telegram_user_id UNIQUE); users.timezone.
//
// Registration (once per bot): wrangler secret put TELEGRAM_WEBHOOK_SECRET, then
//   https://api.telegram.org/bot<token>/setWebhook?url=https://way.peiyong.ai/api/telegram/webhook
//     &secret_token=<the same secret>&allowed_updates=["message","callback_query"]
// Every Bot API call goes through api.ts.

import { timingSafeEqual } from "../auth.ts";
import type { GuideEnv } from "../guide.ts";
import { editReply, orThrow, sendReply, TelegramBot } from "./api.ts";
import { handleCallback, type CallbackContext } from "./callback.ts";
import { redeemLink } from "./link.ts";
import { interruptReview, reviewAnswer } from "./review.ts";
import {
  captureMessage, floodGuard, parseCommand, routeUpdate, SLOW_DOWN, type Reply, type TgUpdate,
} from "./router.ts";
import { localDate } from "./schedule.ts";
import { d1StateStore } from "./state.ts";
import { topThreeAnswer } from "./topthree.ts";

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
      `在 ${origin}/settings 连接 · Link your account at ${origin}/settings`,
  };
}

/** answerCallbackQuery toasts are capped at 200 characters. */
const LINK_FIRST_TOAST = "请先在 way.peiyong.ai 连接账号 · Link your account at way.peiyong.ai first";

const CONNECTED: Reply = {
  text: "已连接 · You're connected.\n随手发一句话，就收进 Inbox · Send me anything and it goes to your inbox.",
};

const TEXT_ONLY: Reply = { text: "目前只收文字 · Text only for now — send it as a message." };

function notYet(name: string): Reply {
  return { text: `暂不支持 /${name} · /${name} isn't available yet.` };
}

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
  const query = update.callback_query;
  const from = update.message?.from ?? query?.from;
  // A tap on a message too old to be delivered with the query still has a private chat: the user's own id.
  const chatId = update.message?.chat.id ?? query?.message?.chat.id ?? from?.id;
  if (!from || chatId === undefined) return;
  const send = (reply: Reply) => sendReply(bot, chatId, reply);
  try {
    await dispatch(env, bot, update, from.id, send, origin);
  } catch (e) {
    console.error(`telegram webhook: update ${update.update_id} failed`, e);
    if (query) await bot.answerCallbackQuery({ callback_query_id: query.id });
    await send(ERROR).catch((err) => console.error("telegram webhook: error reply failed", err));
  }
}

async function dispatch(
  env: WebhookEnv, bot: TelegramBot, update: TgUpdate, telegramUserId: number,
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

  const account = await db.prepare(
    "SELECT a.user_id, u.timezone FROM telegram_accounts a JOIN users u ON u.id = a.user_id WHERE a.telegram_user_id = ?"
  ).bind(telegramUserId).first<{ user_id: number; timezone: string | null }>();
  if (!account) {
    if (query) return answer(LINK_FIRST_TOAST);
    if (update.message) return send(linkFirst(origin));
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
    state: d1StateStore(db, userId),
    guide: env,
    answer,
    finish: (text) => (tapped ? editReply(bot, tapped.chat.id, tapped.message_id, { text }) : send({ text })),
    edit: (reply) => (tapped ? editReply(bot, tapped.chat.id, tapped.message_id, reply) : send(reply)),
    send,
  };

  await routeUpdate(update, {
    callback: (q) => handleCallback(ctx, q.data ?? ""),
    async command(name) {
      // The command table (/today, /plan, /task, …) lands with #20.
      await send(name === "start" ? CONNECTED : notYet(name));
      const paused = await interruptReview(ctx);
      if (paused) await send(paused);
    },
    // Each state machine only takes its own kind, so the order only matters for who looks first.
    pendingState: async (_message, text) => (await reviewAnswer(ctx, text)) || (await topThreeAnswer(ctx, text)),
    // Guide threads in Telegram land with their own issue; until then a reply falls through to capture.
    guideReply: async () => false,
    capture: async (_message, text) => send(await captureMessage(db, userId, text)),
    unsupported: () => send(TEXT_ONLY),
  });
}
