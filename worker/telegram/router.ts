// Update router (PRD §7.1): what one Telegram update does, in a fixed resolution order.
//   1. callback query (button tap) → callback_data handler; never touches the LLM
//   2. command (/…)                → command table
//   3. pending telegram_state      → that state machine (e.g. an evening review in progress)
//   4. reply to a Guide message    → Guide, with the thread as context
//   5. anything else               → capture to the inbox: one round trip, no model call
// The webhook (#6) verifies the update, resolves the Way user once and supplies the
// handlers; this module only decides which one runs.

import { captureToInbox } from "../tasks.ts";
import { cb } from "./callback.ts";

// ---------- the slice of the Bot API update shape the router reads ----------

export interface TgUser {
  id: number;
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

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface Reply {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
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
