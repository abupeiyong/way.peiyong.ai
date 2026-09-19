// Way Guide in the chat (PRD §7.4, #22): the same guide_messages thread as the web page.
//   guideTurn        → "typing…", one model turn, the reply text + one line per proposal with [✓ Approve] [✗ Dismiss]
//   pr:<msg>:<i>:y   → applyProposal (worker/proposals.ts) — the same rows the web card writes; the line is frozen
//   reply-to         → a reply to a Guide message continues the thread (guide_messages.tg_message_id remembers ours)
//   /guide <text>    → forces the Guide; 🤖 问道引 on a capture card asks about that task
//   no model         → the bot says so and points at the deterministic path; nothing else depends on it

import { guideChat } from "../guide.ts";
import { applyProposal } from "../proposals.ts";
import { proposalLabelText } from "../../shared/proposals.ts";
import type { GuideProposal } from "../../shared/types.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logEvent } from "./events.ts";
import type { Reply, TgMessage } from "./router.ts";
import { clearTopThreeWait } from "./topthree.ts";
import { clearWeeklyWait } from "./weekly.ts";

const UNAVAILABLE: Reply = {
  text: "道引暂时不可用 · The Guide is unavailable right now.\n"
    + "（服务器未配置模型：OPENAI_API_KEY 或 Workers AI · No model is configured on the server）\n\n"
    + "其他一切照常：直接发消息进 Inbox，/today /plan /review 都不需要模型 · Everything else works without it.",
};

export type GuideContext = Pick<CallbackContext, "db" | "userId" | "guide" | "typing" | "sendId" | "send">;

/** The reply text plus its proposals, each with approve/dismiss buttons keyed by the stored message id. */
export function guideReplyCard(reply: { id: number; text: string; proposals: GuideProposal[] }): Reply {
  const text = reply.text.slice(0, 3000) || "（道引没有说什么 · The Guide had nothing to add）";
  const shown = reply.proposals.slice(0, 6);
  if (!shown.length) return { text };
  return {
    text: `${text}\n\n${shown.map((p, i) => `${i + 1}. ${proposalLabelText(p)}`).join("\n")}`,
    reply_markup: {
      inline_keyboard: shown.map((_, i) => [
        { text: `✓ 采用 ${shown.length > 1 ? i + 1 : ""}`.trim(), callback_data: cb.proposal(reply.id, i, true) },
        { text: `✗ 不用 ${shown.length > 1 ? i + 1 : ""}`.trim(), callback_data: cb.proposal(reply.id, i, false) },
      ]),
    },
  };
}

/**
 * One Guide turn from the chat. The user's message and the reply land in guide_messages like a web turn,
 * and the sent message's id is stored so a reply-to finds the thread. Returns false when no model is configured.
 */
export async function guideTurn(ctx: GuideContext, prompt: string): Promise<boolean> {
  await ctx.typing();
  let reply: Awaited<ReturnType<typeof guideChat>>;
  try {
    reply = await guideChat(ctx.db, ctx.guide, ctx.userId, prompt);
  } catch (e) {
    console.warn("telegram guide: model unavailable", e instanceof Error ? e.message : e);
    await ctx.send(UNAVAILABLE);
    await logEvent(ctx.db, ctx.userId, "guide", "error");
    return false;
  }
  const messageId = await ctx.sendId(guideReplyCard(reply));
  await ctx.db.prepare("UPDATE guide_messages SET tg_message_id = ? WHERE id = ? AND user_id = ?")
    .bind(messageId, reply.id, ctx.userId).run();
  await logEvent(ctx.db, ctx.userId, "guide", "used");
  return true;
}

/** Router step 4: the message replies to one of our Guide messages → continue the thread. */
export async function guideReplyThread(ctx: GuideContext, message: TgMessage, text: string): Promise<boolean> {
  const replyTo = message.reply_to_message?.message_id;
  if (!replyTo) return false;
  const ours = await ctx.db.prepare("SELECT id FROM guide_messages WHERE user_id = ? AND tg_message_id = ?")
    .bind(ctx.userId, replyTo).first();
  if (!ours) return false;
  await guideTurn(ctx, text);
  return true;
}

/** 🤖 问道引 on a capture card: one turn about that task. */
export async function taskAskGuide(ctx: CallbackContext, taskId: number): Promise<string> {
  const task = await ctx.db.prepare("SELECT title, notes FROM tasks WHERE id = ? AND user_id = ?")
    .bind(taskId, ctx.userId).first<{ title: string; notes: string }>();
  if (!task) return "找不到这件事 · Task not found";
  const prompt = `I just captured this to my inbox: "${task.title}"${task.notes ? `\n(${task.notes.slice(0, 300)})` : ""}. `
    + "Which goal does it serve, when should it happen, and is it worth doing at all? "
    + "Be brief; if it belongs on a day, include one create_task proposal (or say it should stay in the inbox).";
  const ok = await guideTurn(ctx, prompt);
  return ok ? "已问道引 · Asked" : "道引不可用 · Guide unavailable";
}

/**
 * pr:<msgId>:<idx>:<y|n> — answer one proposal of a stored Guide message. The message is re-read by id AND
 * user_id, so a forged id changes nothing; approve goes through applyProposal, the same path as the web card.
 */
export async function proposalAnswer(ctx: CallbackContext, msgId: number, idx: number, approve: boolean): Promise<string> {
  const row = await ctx.db.prepare("SELECT proposals FROM guide_messages WHERE id = ? AND user_id = ? AND role = 'assistant'")
    .bind(msgId, ctx.userId).first<{ proposals: string | null }>();
  let all: GuideProposal[] = [];
  try {
    all = row?.proposals ? (JSON.parse(row.proposals) as GuideProposal[]) : [];
  } catch {
    all = [];
  }
  const p = all[idx];
  if (!p) return "找不到这条提议 · Proposal not found";
  const label = proposalLabelText(p);
  if (!approve) {
    await ctx.finish(`${label}\n— 不用 · Dismissed`);
    return "已忽略 · Dismissed";
  }
  const r = await applyProposal(ctx.db, ctx.userId, p);
  if (!r.ok) {
    await ctx.finish(`${label}\n— 无法采用 · Could not apply: ${r.error}`);
    return "无法采用 · Could not apply";
  }
  // The proposal answered a pending ask: stop waiting for a typed answer.
  if (p.kind === "set_top_three") await clearTopThreeWait(ctx, p.date);
  if (p.kind === "set_weekly_plan") await clearWeeklyWait(ctx, p.week_start);
  await ctx.finish(`✓ 已采用 · Approved\n${label}`);
  return "已采用 · Approved";
}
