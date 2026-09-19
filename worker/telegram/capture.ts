// Voice capture (PRD §13 P2, #31): a voice message is transcribed with Workers AI (whisper) and captured
// like typed text, with the transcript and duration in the notes. Without the AI binding the bot says so.
// Inline mode (#33): `@bot buy milk` from any chat offers "Capture to Way"; picking it sends the text into
// that chat and, with inline feedback enabled in BotFather, a chosen_inline_result that creates the task.

import { captureToInbox } from "../tasks.ts";
import type { CallbackContext } from "./callback.ts";
import { logEvent } from "./events.ts";
import { captureReply, type TgChosenInlineResult, type TgInlineQuery, type TgMessage } from "./router.ts";
import type { TelegramBot } from "./api.ts";

const WHISPER = "@cf/openai/whisper";

export type VoiceContext = Pick<CallbackContext, "db" | "userId" | "guide" | "bot" | "send" | "typing">;

export async function captureVoice(ctx: VoiceContext, message: TgMessage): Promise<void> {
  const voice = message.voice;
  if (!voice) return;
  if (!ctx.guide.AI) {
    await ctx.send({ text: "语音转写需要 Workers AI，这台服务器没有配置 · Voice notes need Workers AI, which isn't configured here. 请打字 · Please type it." });
    return;
  }
  if (voice.duration > 120) {
    await ctx.send({ text: "语音太长（最多 2 分钟） · Voice note too long (2 minutes max)." });
    return;
  }
  await ctx.typing();
  const file = await ctx.bot.getFile(voice.file_id);
  if (!file.ok || !file.result.file_path) {
    await ctx.send({ text: "没拿到语音文件 · Couldn't fetch the voice note. 再发一次？ · Try again?" });
    return;
  }
  let text = "";
  try {
    const bytes = new Uint8Array(await ctx.bot.downloadFile(file.result.file_path));
    const out = (await ctx.guide.AI.run(WHISPER, { audio: [...bytes] })) as { text?: string };
    text = (out.text ?? "").trim();
  } catch (e) {
    console.error("telegram voice: transcription failed", e);
    await logEvent(ctx.db, ctx.userId, "voice", "error");
    await ctx.send({ text: "转写失败 · Transcription failed. 请打字 · Please type it." });
    return;
  }
  if (!text) {
    await ctx.send({ text: "没听清 · Couldn't make out any words. 再说一次？ · Say it again?" });
    return;
  }
  const task = await captureToInbox(ctx.db, ctx.userId, text.slice(0, 200), `🎙 voice · ${voice.duration}s\n${text}`);
  await logEvent(ctx.db, ctx.userId, "voice", "used");
  await ctx.send({ ...captureReply(task), text: `🎙 ${captureReply(task).text}` });
}

// ---------- inline mode ----------

/** The results for `@bot <query>`; an unlinked user gets a button into the bot instead. */
export async function answerInline(bot: TelegramBot, db: D1Database, q: TgInlineQuery): Promise<void> {
  const linked = await db.prepare("SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?").bind(q.from.id).first();
  const query = q.query.trim();
  if (!linked) {
    await bot.answerInlineQuery({
      inline_query_id: q.id, results: [], cache_time: 0, is_personal: true,
      button: { text: "先连接 Way 账号 · Link your Way account first", start_parameter: "inline" },
    });
    return;
  }
  const results = query
    ? [{
        type: "article" as const, id: "capture",
        title: "📥 收进 Way Inbox · Capture to Way",
        description: query.slice(0, 100),
        input_message_content: { message_text: `📥 ${query.slice(0, 3000)}` },
      }]
    : [];
  await bot.answerInlineQuery({ inline_query_id: q.id, results, cache_time: 0, is_personal: true });
}

/** The user picked the capture result: create the inbox task (needs /setinlinefeedback in BotFather). */
export async function chosenInline(db: D1Database, chosen: TgChosenInlineResult): Promise<void> {
  if (chosen.result_id !== "capture" || !chosen.query.trim()) return;
  const linked = await db.prepare("SELECT user_id FROM telegram_accounts WHERE telegram_user_id = ?").bind(chosen.from.id).first<{ user_id: number }>();
  if (!linked) return;
  await captureToInbox(db, linked.user_id, chosen.query.trim().slice(0, 200), "📥 inline");
  await logEvent(db, linked.user_id, "inline", "used");
}
