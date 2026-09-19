// Unit-ish checks for api.ts (no test runner in this repo): `npm run check:telegram`.
// Runs under Node's type stripping; fetch is stubbed, nothing reaches Telegram. Any failure throws.

import {
  assertCallbackData, callbackButton, clipHtml, esc, htmlLength, inlineKeyboard, TelegramBot, TEXT_MAX,
} from "./api.ts";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

function throws(fn: () => unknown, what: string): void {
  try {
    fn();
  } catch {
    return check(true, what);
  }
  check(false, what);
}

// esc
check(esc("a & b < c > d") === "a &amp; b &lt; c &gt; d", "esc() handles & < >");
check(esc("Ship 50% *fast* _now_") === "Ship 50% *fast* _now_", "esc() leaves Markdown characters alone");
check(esc("&amp;") === "&amp;amp;", "esc() escapes an existing entity again");

// callback_data
check(assertCallbackData("t:1:d") === "t:1:d", "short callback_data passes");
check(assertCallbackData("x".repeat(64)).length === 64, "64-byte callback_data passes");
throws(() => assertCallbackData("x".repeat(65)), "65-byte callback_data throws");
throws(() => assertCallbackData("道".repeat(22)), "callback_data is measured in UTF-8 bytes (22 × 3 = 66)");
throws(() => assertCallbackData(""), "empty callback_data throws");
throws(() => inlineKeyboard([callbackButton("ok", "a")], [{ text: "long", callback_data: "y".repeat(65) }]),
  "inlineKeyboard() with an over-long callback_data throws");
check(inlineKeyboard([callbackButton("ok", "a")], []).inline_keyboard.length === 1, "inlineKeyboard() drops empty rows");

// length
check(htmlLength("<b>a &amp; b</b>") === 5, "htmlLength() counts tags as 0 and entities as 1");
const long = `<b>${esc("<&>".repeat(2000))}</b>`;
const clipped = clipHtml(long, TEXT_MAX);
check(htmlLength(clipped) === TEXT_MAX && clipped.endsWith("…</b>"), "clipHtml() cuts to the limit and closes open tags");
check(!/&[a-z]*…/.test(clipped), "clipHtml() never splits an entity");
check(clipHtml("short", TEXT_MAX) === "short", "clipHtml() leaves short text alone");

// errors come back as results
let lastBody: Record<string, unknown> = {};
function stub(status: number, body: object): void {
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    lastBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

throws(() => TelegramBot.fromEnv({}), "a missing TELEGRAM_BOT_TOKEN throws");
const bot = new TelegramBot("123:test");

stub(200, { ok: true, result: { message_id: 1, chat: { id: 7 }, date: 0 } });
const sent = await bot.sendMessage({ chat_id: 7, text: esc("Ship 50% *fast*") });
check(sent.ok && lastBody.parse_mode === "HTML", "sendMessage uses parse_mode HTML");

stub(403, { ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" });
const blocked = await bot.sendMessage({ chat_id: 7, text: "hi" });
check(!blocked.ok && blocked.kind === "blocked", "a blocked chat returns a blocked result, not an exception");

stub(429, { ok: false, error_code: 429, description: "Too Many Requests: retry after 5", parameters: { retry_after: 5 } });
const limited = await bot.sendMessage({ chat_id: 7, text: "hi" });
check(!limited.ok && limited.kind === "rate_limited" && limited.retryAfter === 5, "429 returns rate_limited with retry_after");

stub(400, { ok: false, error_code: 400, description: "Bad Request: message is not modified" });
const same = await bot.editMessageText({ chat_id: 7, message_id: 1, text: "hi" });
check(!same.ok && same.kind === "not_modified", "an unchanged edit returns not_modified");

const tooLong = await bot.sendMessage({ chat_id: 7, text: "x".repeat(TEXT_MAX + 1) });
check(!tooLong.ok && tooLong.kind === "too_long", "over 4096 without a Truncate is refused before sending");
stub(200, { ok: true, result: { message_id: 2, chat: { id: 7 }, date: 0 } });
await bot.sendMessage({ chat_id: 7, text: "x".repeat(TEXT_MAX + 1) }, { truncate: clipHtml });
check(htmlLength(String(lastBody.text)) === TEXT_MAX, "over 4096 with a Truncate is sent truncated");

console.log("all checks passed");
