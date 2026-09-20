// Update router (PRD §7.1): what one Telegram update does, in a fixed resolution order.
//   1. callback query (button tap) → callback_data handler; never touches the LLM
//   2. command (/…)                → command table
//   3. pending telegram_state      → that state machine (e.g. an evening review in progress)
//   4. reply to a Guide message    → Guide, with the thread as context
//   5. a registered capture pattern → log it to that tracker; still no model (PRD-brain §8.3)
//   6. anything else               → capture to the inbox: one round trip, no model call
// A photo is decided before any of that (PRD-body §5.2): while a meal ask is open, or captioned #meal / 饭,
// it is a meal; every other photo falls through to the steps below as it always did.
// The webhook (#6) verifies the update, resolves the Way user once and supplies the
// handlers; this module only decides which one runs.

import { underLimit } from "../auth.ts";
import { captureToInbox } from "../tasks.ts";
import type { ReplyMarkup } from "./api.ts";
import { cb } from "./callback.ts";

// ---------- the slice of the Bot API update shape the router reads ----------

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgEntity {
  type: string;
  offset: number;
  length: number;
  /** text_link only. */
  url?: string;
}

/** One size of a photo; Telegram sends the same picture in several, smallest first. */
export interface TgPhotoSize {
  file_id: string;
  width: number;
  height: number;
  file_size?: number;
}

/** Where a forwarded message came from (Bot API 7+). */
export type TgForwardOrigin =
  | { type: "user"; sender_user: TgUser }
  | { type: "hidden_user"; sender_user_name: string }
  | { type: "chat"; sender_chat: { title?: string; username?: string }; author_signature?: string }
  | { type: "channel"; chat: { title?: string; username?: string }; message_id: number };

export interface TgMessage {
  message_id: number;
  /** Unix seconds. */
  date?: number;
  chat: { id: number };
  from?: TgUser;
  text?: string;
  caption?: string;
  entities?: TgEntity[];
  caption_entities?: TgEntity[];
  reply_to_message?: TgMessage;
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number };
  photo?: TgPhotoSize[];
  forward_origin?: TgForwardOrigin;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  data?: string;
  message?: TgMessage;
}

export interface TgInlineQuery {
  id: string;
  from: TgUser;
  query: string;
}

export interface TgChosenInlineResult {
  result_id: string;
  from: TgUser;
  query: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
  inline_query?: TgInlineQuery;
  chosen_inline_result?: TgChosenInlineResult;
}

export type { ForceReply, InlineKeyboardButton, InlineKeyboardMarkup } from "./api.ts";

/** Plain text (escaped on the way out by sendReply / editReply in api.ts). */
export interface Reply {
  text: string;
  reply_markup?: ReplyMarkup;
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
  /** 5. A registered capture pattern: the message names a tracker and carries a value (PRD-brain §8.3). */
  match(message: TgMessage, text: string): Promise<boolean>;
  /** 6. The default. A forwarded message arrives here too (message.forward_origin says where from). */
  capture(message: TgMessage, text: string): Promise<void>;
  /** A voice message: transcribe, then capture. */
  voice(message: TgMessage): Promise<void>;
  /** `@bot query` typed in any chat: answer with what picking it would do. */
  inlineQuery(query: TgInlineQuery): Promise<void>;
  /** The user picked an inline result (needs inline feedback on in BotFather). */
  chosenInline(chosen: TgChosenInlineResult): Promise<void>;
  /** A photo. True when it was taken as a meal; false falls through to the steps above. */
  photo(message: TgMessage, caption: string): Promise<boolean>;
  /** A message with no text (sticker, photo without caption, …). */
  unsupported(message: TgMessage): Promise<void>;
}

export type RouteKind = "callback" | "inline" | "chosen" | "command" | "state" | "guide" | "match" | "capture" | "voice" | "photo" | "unsupported" | "ignored";

// Telegram's own / menu is ASCII, but a user may type a command in their own language
// (/开始, /停止) and it should work, so the name accepts any letter.
const COMMAND = /^\/([\p{L}\p{N}_]{1,32})(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/u;

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
  if (update.inline_query) {
    await h.inlineQuery(update.inline_query);
    return "inline";
  }
  if (update.chosen_inline_result) {
    await h.chosenInline(update.chosen_inline_result);
    return "chosen";
  }
  const message = update.message;
  if (!message) return "ignored";
  const text = (message.text ?? message.caption ?? "").trim();
  if (message.photo?.length && (await h.photo(message, text))) return "photo";
  if (!text) {
    if (message.voice) {
      await h.voice(message);
      return "voice";
    }
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
  if (await h.match(message, text)) return "match";
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

/** "Forwarded from X" for the notes of a captured forward, or null when the message was not forwarded. */
export function forwardSource(message: TgMessage): string | null {
  const o = message.forward_origin;
  if (!o) return null;
  if (o.type === "user") return `Forwarded from ${o.sender_user.first_name ?? ""}${o.sender_user.username ? ` (@${o.sender_user.username})` : ""}`.trim();
  if (o.type === "hidden_user") return `Forwarded from ${o.sender_user_name}`;
  if (o.type === "chat") return `Forwarded from ${o.sender_chat.title ?? o.sender_chat.username ?? "a chat"}`;
  const link = o.chat.username ? ` — https://t.me/${o.chat.username}/${o.message_id}` : "";
  return `Forwarded from ${o.chat.title ?? o.chat.username ?? "a channel"}${link}`;
}

/** The URLs a message carries (url and text_link entities), in order. */
export function messageLinks(message: TgMessage, text: string): string[] {
  const entities = message.entities ?? message.caption_entities ?? [];
  const chars = [...text];
  const out: string[] = [];
  for (const e of entities) {
    if (e.type === "text_link" && e.url) out.push(e.url);
    else if (e.type === "url") out.push(chars.slice(e.offset, e.offset + e.length).join(""));
  }
  return out;
}

/** Step 5 end to end: an inbox task (inbox = 1, date = NULL) and the card to send back. A forward keeps its source and links in the notes. */
export async function captureMessage(db: D1Database, userId: number, text: string, message?: TgMessage): Promise<Reply> {
  const source = message ? forwardSource(message) : null;
  const links = message ? messageLinks(message, message.text ?? message.caption ?? "") : [];
  const firstLine = text.split(/\r?\n/)[0].trim();
  // A forward's title is its first line; the whole text lives in the notes with where it came from.
  const title = source && firstLine ? firstLine.slice(0, 200) : text;
  const notes = [source, source && text !== firstLine ? text : null, ...links.filter((l) => !text.includes(l))].filter(Boolean).join("\n");
  return captureReply(await captureToInbox(db, userId, title, notes));
}
