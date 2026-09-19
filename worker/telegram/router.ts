// Update router (PRD §7.1): what one Telegram update does, in a fixed resolution order.
//   1. callback query (button tap) → callback_data handler; never touches the LLM
//   2. command (/…)                → command table
//   3. pending telegram_state      → that state machine (e.g. an evening review in progress)
//   4. reply to a Guide message    → Guide, with the thread as context
//   5. anything else               → capture to the inbox: one round trip, no model call
// The webhook (#6) verifies the update, resolves the Way user once and supplies the
// handlers; this module only decides which one runs.

import { underLimit } from "../auth.ts";
import { captureToInbox } from "../tasks.ts";
import { cb } from "./callback.ts";

// ---------- the slice of the Bot API update shape the router reads ----------

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgMessage {
  message_id: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  caption?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  /** Opens the URL in the browser; no callback query comes back. */
  | { text: string; url: string };

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

/** Opens the reply keyboard on the client. A message carries this or an inline keyboard, never both. */
export interface ForceReply {
  force_reply: true;
  /** Up to 64 characters. */
  input_field_placeholder?: string;
}

export interface Reply {
  text: string;
  reply_markup?: InlineKeyboardMarkup | ForceReply;
}

// ---------- routing ----------

export interface RouteHandlers {
  /** 1. A button tap. */
  callback(query: TgCallbackQuery): Promise<void>;
  /** 2. `/name args`; `name` is lower-cased with any `@botname` suffix removed. */
  command(name: string, args: string, message: TgMessage): Promise<void>;
  /** 3. Feed the message to the user's pending telegram_state, if any. Returns false when nothing is pending. */
  pendingState(message: TgMessage, text: string): Promise<boolean>;
  /** 4. Continue the Guide thread if `message.reply_to_message` is a Guide message. Returns false otherwise. */
  guideReply(message: TgMessage, text: string): Promise<boolean>;
  /** 5. The default. */
  capture(message: TgMessage, text: string): Promise<void>;
  /** A message with no text (sticker, photo without caption, …). */
  unsupported(message: TgMessage): Promise<void>;
}

export type RouteKind = "callback" | "command" | "state" | "guide" | "capture" | "unsupported" | "ignored";

const COMMAND = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/;

export function parseCommand(text: string): { name: string; args: string } | null {
  const m = COMMAND.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() } : null;
}

/** Dispatch one update to exactly one handler, in resolution order. Returns which one ran. */
export async function routeUpdate(update: TgUpdate, h: RouteHandlers): Promise<RouteKind> {
  if (update.callback_query) {
    await h.callback(update.callback_query);
    return "callback";
  }
  const message = update.message;
  if (!message) return "ignored";
  const text = (message.text ?? message.caption ?? "").trim();
  if (!text) {
    await h.unsupported(message);
    return "unsupported";
  }
  const command = message.text ? parseCommand(message.text) : null;
  if (command) {
    await h.command(command.name, command.args, message);
    return "command";
  }
  if (await h.pendingState(message, text)) return "state";
  if (message.reply_to_message && (await h.guideReply(message, text))) return "guide";
  await h.capture(message, text);
  return "capture";
}

// ---------- flood guard (PRD §11.2) ----------

export const SLOW_DOWN: Reply = { text: "慢一点 · Slow down — 一分钟内消息太多，稍等再发。" };

/**
 * Per-user flood guard: 10 messages a minute (the TG_FLOOD_LIMITER binding), checked by the webhook
 * before routeUpdate. Returns false once the user is over the limit — reply SLOW_DOWN and drop the update.
 */
export function floodGuard(limiter: RateLimit | undefined, userId: number): Promise<boolean> {
  return underLimit(limiter, `tg:${userId}`);
}

// ---------- step 5: inbox capture ----------

/** The capture card. Its buttons go through the shared callback handlers (and so the shared task update path). */
export function captureReply(task: { id: number; title: string }): Reply {
  return {
    text: `已收进 Inbox · Captured\n"${task.title}"`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "📅 今天 Today", callback_data: cb.taskSchedule(task.id, 0) },
          { text: "📅 明天", callback_data: cb.taskSchedule(task.id, 1) },
          { text: "🎯 链接目标", callback_data: cb.taskLinkGoal(task.id) },
        ],
        [
          { text: "🤖 问道引 Ask Guide", callback_data: cb.taskAskGuide(task.id) },
          { text: "🗑", callback_data: cb.taskDelete(task.id) },
        ],
      ],
    },
  };
}

/** Step 5 end to end: an inbox task (inbox = 1, date = NULL) and the card to send back. */
export async function captureMessage(db: D1Database, userId: number, text: string): Promise<Reply> {
  return captureReply(await captureToInbox(db, userId, text));
}
