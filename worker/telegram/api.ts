// Telegram Bot API client (PRD §10): the one place that talks to https://api.telegram.org/bot<token>/<method>.
//   methods   → sendMessage, editMessageText, answerCallbackQuery, sendChatAction, setMyCommands, setWebhook
//   HTML      → every text goes out with parse_mode "HTML"; anything that isn't markup goes through esc().
//               Never MarkdownV2 — a goal titled `Ship 50% *fast*` breaks it
//   keyboards → callback_data is checked against 64 bytes when a keyboard is built and again before any send
//   length    → text over 4096 characters goes through the caller's Truncate; without one the send is refused
//   errors    → returned, never thrown: 403 → "blocked", 429 → "rate_limited" (+ retryAfter), and so on.
//               Only programming errors throw: a missing token or an over-long callback_data
//   token     → TelegramBot.fromEnv(env) throws when TELEGRAM_BOT_TOKEN is unset
//
// Plain-text Reply values (router.ts) go through sendReply / editReply, which escape them and clip at 4096.
// Kept free of value imports and non-erasable TypeScript so `node worker/telegram/api.check.ts` can run it.

import type { Reply } from "./router.ts";

const API_BASE = "https://api.telegram.org";
/** Telegram's limit on message text, counted after entity parsing. */
export const TEXT_MAX = 4096;
export const CALLBACK_DATA_MAX_BYTES = 64;

// ---------- HTML ----------

/** Escape text for parse_mode "HTML". Telegram only requires & < > outside attribute values. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TAG = /<[^>]*>/g;
const ENTITY = /&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]+);/g;

/** The length Telegram counts: tags removed, each entity one character. */
export function htmlLength(html: string): number {
  return html.replace(TAG, "").replace(ENTITY, "&").length;
}

// ---------- truncation ----------

/** Shortens `html` to at most `max` visible characters; the result must still be valid Telegram HTML. */
export type Truncate = (html: string, max: number) => string;

const TOKEN = /<(\/?)([a-zA-Z][\w-]*)[^>]*>|&(?:#\d+|#x[\da-fA-F]+|[a-zA-Z]+);|[\s\S]/gu;

/** Cut at `max - 1` visible characters, add "…", close any tag left open. Never splits a tag, entity or code point. */
export const clipHtml: Truncate = (html, max) => {
  if (htmlLength(html) <= max) return html;
  const open: string[] = [];
  let out = "", n = 0;
  for (const m of html.matchAll(TOKEN)) {
    const [tok, closing, name] = m;
    if (name) {
      if (!closing) open.push(name.toLowerCase());
      else {
        const i = open.lastIndexOf(name.toLowerCase());
        if (i >= 0) open.splice(i, 1);
      }
      out += tok;
      continue;
    }
    const w = tok[0] === "&" ? 1 : tok.length;
    if (n + w > max - 1) break;
    out += tok;
    n += w;
  }
  return out + "…" + open.reverse().map((t) => `</${t}>`).join("");
};

// ---------- keyboards ----------

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

export type ReplyMarkup = InlineKeyboardMarkup | ForceReply;

/** Throws RangeError unless `data` is 1–64 bytes of UTF-8. Returns it unchanged. */
export function assertCallbackData(data: string): string {
  const bytes = new TextEncoder().encode(data).length;
  if (bytes < 1 || bytes > CALLBACK_DATA_MAX_BYTES) {
    throw new RangeError(`callback_data must be 1–${CALLBACK_DATA_MAX_BYTES} bytes, got ${bytes}: ${JSON.stringify(data.slice(0, 80))}`);
  }
  return data;
}

export function callbackButton(text: string, data: string): InlineKeyboardButton {
  return { text, callback_data: assertCallbackData(data) };
}

export function urlButton(text: string, url: string): InlineKeyboardButton {
  return { text, url };
}

/** An inline keyboard, one array per row; empty rows are dropped. Throws on an over-long callback_data. */
export function inlineKeyboard(...rows: InlineKeyboardButton[][]): InlineKeyboardMarkup {
  const markup = { inline_keyboard: rows.filter((r) => r.length > 0) };
  checkMarkup(markup);
  return markup;
}

function checkMarkup(markup: ReplyMarkup | undefined): void {
  if (!markup || !("inline_keyboard" in markup)) return;
  for (const row of markup.inline_keyboard) {
    for (const b of row) if ("callback_data" in b) assertCallbackData(b.callback_data);
  }
}

// ---------- results ----------

export type TgFailure =
  /** 403: the user blocked the bot, deleted their account, or never started it. The chat is gone. */
  | { ok: false; kind: "blocked"; status: 403; description: string }
  /** 429: wait `retryAfter` seconds (parameters.retry_after) before the next send. */
  | { ok: false; kind: "rate_limited"; status: 429; description: string; retryAfter: number }
  /** editMessageText with identical content; usually treated as success. */
  | { ok: false; kind: "not_modified"; status: 400; description: string }
  /** Over TEXT_MAX and no Truncate (or it didn't get under); nothing was sent. */
  | { ok: false; kind: "too_long"; status: 0; description: string }
  /** Anything else, including a network failure (status 0). */
  | { ok: false; kind: "error"; status: number; description: string };

export type TgResult<T> = { ok: true; result: T } | TgFailure;

/** A failed call as an exception, for flows that unwind on failure (the scheduler, the webhook). */
export class TelegramApiError extends Error {
  readonly status: number;
  readonly description: string;
  readonly kind: TgFailure["kind"];
  /** parameters.retry_after on a 429, in seconds. */
  readonly retryAfter?: number;
  constructor(failure: TgFailure) {
    super(`Telegram ${failure.status}: ${failure.description}`);
    this.status = failure.status;
    this.description = failure.description;
    this.kind = failure.kind;
    if (failure.kind === "rate_limited") this.retryAfter = failure.retryAfter;
  }
}

export function orThrow<T>(r: TgResult<T>): T {
  if (!r.ok) throw new TelegramApiError(r);
  return r.result;
}

function failure(status: number, description: string, retryAfter: number | undefined): TgFailure {
  if (status === 403) return { ok: false, kind: "blocked", status, description };
  if (status === 429) return { ok: false, kind: "rate_limited", status, description, retryAfter: retryAfter ?? 1 };
  if (status === 400 && description.includes("message is not modified")) return { ok: false, kind: "not_modified", status, description };
  return { ok: false, kind: "error", status, description };
}

// ---------- the slice of the Bot API this app sends ----------

export type ChatId = number | string;

export interface SentMessage {
  message_id: number;
  chat: { id: number };
  date: number;
  text?: string;
}

/** `text` is HTML: esc() every piece that isn't markup. parse_mode is always "HTML" and can't be overridden. */
export interface SendMessageParams {
  chat_id: ChatId;
  text: string;
  reply_markup?: ReplyMarkup;
  disable_notification?: boolean;
  link_preview_options?: { is_disabled?: boolean };
}

/** No reply_markup removes the message's buttons. */
export interface EditMessageTextParams {
  chat_id: ChatId;
  message_id: number;
  text: string;
  reply_markup?: InlineKeyboardMarkup;
  link_preview_options?: { is_disabled?: boolean };
}

export interface AnswerCallbackQueryParams {
  callback_query_id: string;
  /** A toast, up to 200 characters; plain text. */
  text?: string;
  show_alert?: boolean;
}

export type ChatAction = "typing" | "upload_photo" | "upload_document";

export interface BotCommand {
  /** 1–32 of a-z, 0-9, _ */
  command: string;
  /** 1–256 characters; plain text (no HTML in the command menu). */
  description: string;
}

export interface SetWebhookParams {
  url: string;
  secret_token?: string;
  allowed_updates?: string[];
  drop_pending_updates?: boolean;
  max_connections?: number;
}

/** The update types the webhook handles; passed to setWebhook so Telegram sends nothing else. */
export const ALLOWED_UPDATES = ["message", "callback_query", "inline_query", "chosen_inline_result"];

/** One inline-mode result: picking it sends `input_message_content` into the chat and (with inline feedback on) a chosen_inline_result. */
export interface InlineQueryResultArticle {
  type: "article";
  id: string;
  title: string;
  description?: string;
  input_message_content: { message_text: string; parse_mode?: "HTML" };
}

export interface AnswerInlineQueryParams {
  inline_query_id: string;
  results: InlineQueryResultArticle[];
  cache_time?: number;
  is_personal?: boolean;
  /** A button above the results that opens the bot's private chat with `start_parameter`. */
  button?: { text: string; start_parameter: string };
}

export interface TgFile {
  file_id: string;
  file_size?: number;
  /** Relative path for https://api.telegram.org/file/bot<token>/<file_path>; valid for about an hour. */
  file_path?: string;
}

export interface TextOptions {
  /** Applied when the text is over TEXT_MAX. Without one, the call returns "too_long" and nothing is sent. */
  truncate?: Truncate;
}

// ---------- client ----------

export class TelegramBot {
  readonly #token: string;

  /** Throws when the token is missing: a bot that can't send should fail where it's built, not per message. */
  constructor(token: string | undefined) {
    if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");
    this.#token = token;
  }

  static fromEnv(env: { TELEGRAM_BOT_TOKEN?: string }): TelegramBot {
    return new TelegramBot(env.TELEGRAM_BOT_TOKEN);
  }

  /** POST one Bot API method. Never throws. */
  async call<T>(method: string, params: object): Promise<TgResult<T>> {
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/bot${this.#token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
      });
    } catch (e) {
      return failure(0, `${method}: ${e instanceof Error ? e.message : String(e)}`, undefined);
    }
    const body = await res.json().catch(() => null) as
      | { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } }
      | null;
    if (res.ok && body?.ok) return { ok: true, result: body.result as T };
    return failure(res.status, body?.description ?? res.statusText, body?.parameters?.retry_after);
  }

  sendMessage(p: SendMessageParams, opts: TextOptions = {}): Promise<TgResult<SentMessage>> {
    checkMarkup(p.reply_markup);
    const text = fit(p.text, opts.truncate);
    if (text === null) return Promise.resolve(tooLong(p.text));
    return this.call("sendMessage", { ...p, text, parse_mode: "HTML" });
  }

  /** Editing to identical content comes back as "not_modified". */
  editMessageText(p: EditMessageTextParams, opts: TextOptions = {}): Promise<TgResult<SentMessage | true>> {
    checkMarkup(p.reply_markup);
    const text = fit(p.text, opts.truncate);
    if (text === null) return Promise.resolve(tooLong(p.text));
    return this.call("editMessageText", { ...p, text, parse_mode: "HTML" });
  }

  answerCallbackQuery(p: AnswerCallbackQueryParams): Promise<TgResult<true>> {
    return this.call("answerCallbackQuery", p);
  }

  sendChatAction(p: { chat_id: ChatId; action: ChatAction }): Promise<TgResult<true>> {
    return this.call("sendChatAction", p);
  }

  setMyCommands(p: { commands: BotCommand[]; language_code?: string }): Promise<TgResult<true>> {
    return this.call("setMyCommands", p);
  }

  setWebhook(p: SetWebhookParams): Promise<TgResult<true>> {
    return this.call("setWebhook", p);
  }

  answerInlineQuery(p: AnswerInlineQueryParams): Promise<TgResult<true>> {
    return this.call("answerInlineQuery", p);
  }

  getFile(fileId: string): Promise<TgResult<TgFile>> {
    return this.call("getFile", { file_id: fileId });
  }

  /** The bytes of a file getFile described. Throws TelegramApiError when the download fails. */
  async downloadFile(filePath: string): Promise<ArrayBuffer> {
    const res = await fetch(`${API_BASE}/file/bot${this.#token}/${filePath}`);
    if (!res.ok) throw new TelegramApiError({ ok: false, kind: "error", status: res.status, description: `file download: ${res.statusText}` });
    return res.arrayBuffer();
  }
}

/** `html` if it fits, else the truncated text if that fits, else null. */
function fit(html: string, truncate: Truncate | undefined): string | null {
  if (htmlLength(html) <= TEXT_MAX) return html;
  const cut = truncate?.(html, TEXT_MAX);
  return cut !== undefined && htmlLength(cut) <= TEXT_MAX ? cut : null;
}

function tooLong(html: string): TgFailure {
  return { ok: false, kind: "too_long", status: 0, description: `text is ${htmlLength(html)} characters (max ${TEXT_MAX})` };
}

// ---------- plain-text replies ----------

/** Send a plain-text Reply (escaped, clipped at TEXT_MAX). Throws TelegramApiError on failure. */
export async function sendReply(bot: TelegramBot, chatId: ChatId, reply: Reply): Promise<void> {
  await sendReplyId(bot, chatId, reply);
}

/** sendReply, returning the new message's id (a Guide reply remembers it so a reply-to continues the thread). */
export async function sendReplyId(bot: TelegramBot, chatId: ChatId, reply: Reply): Promise<number> {
  const sent = orThrow(await bot.sendMessage(
    { chat_id: chatId, text: esc(reply.text), ...(reply.reply_markup && { reply_markup: reply.reply_markup }) },
    { truncate: clipHtml },
  ));
  return sent.message_id;
}

/** Edit a message to a plain-text Reply; no reply_markup removes its buttons. Identical content is not an error. */
export async function editReply(bot: TelegramBot, chatId: ChatId, messageId: number, reply: Reply): Promise<void> {
  if (reply.reply_markup && !("inline_keyboard" in reply.reply_markup)) {
    throw new TypeError("editMessageText only takes an inline keyboard");
  }
  const r = await bot.editMessageText(
    { chat_id: chatId, message_id: messageId, text: esc(reply.text), ...(reply.reply_markup && { reply_markup: reply.reply_markup }) },
    { truncate: clipHtml },
  );
  if (!r.ok && r.kind !== "not_modified") throw new TelegramApiError(r);
}

// ---------- the command menu ----------

/**
 * The bot's / menu, bilingual like the web UI's 中文 <i>English</i> headings (the menu is plain text, so "中文 · English").
 * Installed by POST /api/telegram/setup (`npm run telegram:setup` after a deploy); keep it in step with the command table.
 */
export const BOT_COMMANDS: BotCommand[] = [
  { command: "today", description: "今天 · Today's plan" },
  { command: "plan", description: "三件事 · Plan the day" },
  { command: "task", description: "记一件事 · Add a task" },
  { command: "done", description: "完成 · Tick off a task" },
  { command: "inbox", description: "收件箱 · Inbox" },
  { command: "week", description: "本周 · This week's plan" },
  { command: "goals", description: "目标 · Goals" },
  { command: "body", description: "身体 · Weight trend and projection" },
  { command: "meal", description: "饮食 · Log a meal" },
  { command: "workout", description: "运动 · Log a workout" },
  { command: "review", description: "复盘 · Review the day" },
  { command: "note", description: "记一笔 · Add to today's reflection" },
  { command: "guide", description: "道引 · Ask the Guide" },
  { command: "find", description: "查找 · Find tasks and goals" },
  { command: "timezone", description: "时区 · Time zone" },
  { command: "settings", description: "设置 · Notifications" },
  { command: "mute", description: "静音 · Pause notifications" },
  { command: "help", description: "帮助 · All commands" },
];
