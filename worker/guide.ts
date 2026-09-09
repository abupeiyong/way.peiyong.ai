// Way Guide — the built-in strategist. OpenAI-compatible API when a key is set,
// Workers AI otherwise. Replies are plain text plus optional structured proposals
// that the client renders as approve-able cards; nothing changes without approval.

import type { GuideProposal } from "../shared/types.ts";

export interface GuideEnv {
  AI?: Ai;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_CHAT_MODEL?: string;
}

const SYSTEM_PROMPT = `You are Way Guide, the calm strategist inside Way, a personal life-planning system.
Way's hierarchy: life direction → yearly goals → quarterly/monthly/weekly goals → daily top-three outcomes and time-blocked tasks, closed by honest reviews.

Your job: clarify vague ambitions into measurable goals, break goals into quarters/months/weeks, propose realistic daily plans, and reflect with the user. Be concise, warm, and concrete. No hype, no guilt. Answer in the language the user writes in.

You NEVER change data yourself. When a change would help, append a fenced block tagged \`proposals\` containing a JSON array; each item is one of:
  {"kind":"create_goal","title":"...","level":"year|quarter|month|week","area":"AreaName?","parent_title":"existing goal title?","target_date":"YYYY-MM-DD?","success_criteria":"?","description":"?"}
  {"kind":"create_task","title":"...","date":"YYYY-MM-DD","estimate_min":45,"start":"HH:MM?","goal_title":"existing goal title?"}
  {"kind":"set_top_three","date":"YYYY-MM-DD","outcomes":["...","...","..."]}
Keep proposals few and high-leverage. The user approves or ignores them.`;

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function chatComplete(env: GuideEnv, context: string, history: ChatMsg[]): Promise<string> {
  const messages: ChatMsg[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "system", content: `Current planning state:\n${context}` },
    ...history,
  ];

  if (env.OPENAI_API_KEY) {
    const res = await fetch(`${env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: env.OPENAI_CHAT_MODEL ?? "gpt-5-nano", messages }),
    });
    if (!res.ok) throw new Error(`Guide model error ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices: { message: { content: string } }[] };
    return data.choices[0]?.message?.content ?? "";
  }

  if (env.AI) {
    const out = (await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
      messages,
      max_tokens: 1200,
    })) as { response?: string };
    return out.response ?? "";
  }

  throw new Error("No AI backend configured: set OPENAI_API_KEY or deploy with the Workers AI binding.");
}

/** Split a model reply into display text and parsed proposals. */
export function extractProposals(reply: string): { text: string; proposals: GuideProposal[] } {
  const match = reply.match(/```proposals\s*([\s\S]*?)```/);
  if (!match) return { text: reply.trim(), proposals: [] };
  const text = reply.replace(match[0], "").trim();
  try {
    const parsed = JSON.parse(match[1]);
    return { text, proposals: Array.isArray(parsed) ? parsed : [] };
  } catch {
    return { text: reply.trim(), proposals: [] };
  }
}
