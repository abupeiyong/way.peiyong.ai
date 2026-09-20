// Way Guide — the built-in strategist. OpenAI-compatible API when a key is set,
// Workers AI otherwise. Replies are plain text plus optional structured proposals
// that the client renders as approve-able cards; nothing changes without approval.

import type { BodySummary, GuideProposal } from "../shared/types.ts";
import { asksAboutBody, bodyContextLine, bodySummary, bodyVerdictLine, suggestedWeightGoal } from "./body.ts";
import { userToday } from "./telegram/time.ts";
import { weekStartOf } from "./dates.ts";

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
  {"kind":"set_weekly_plan","week_start":"YYYY-MM-DD (Monday)","theme":"...","outcomes":["...","...","..."]}
  {"kind":"update_goal_progress","goal_title":"exact existing goal title","progress":70}
  {"kind":"create_review","period":"daily|weekly|monthly|quarterly|yearly","period_start":"YYYY-MM-DD","answers":{"review question":"answer"}}
  {"kind":"set_body_plan","goal_title":"exact existing goal title","start_kg":74.2,"target_kg":70,"weekly_workouts":3,"daily_kcal":1900}
  {"kind":"log_workout","date":"YYYY-MM-DD","activity":"run","minutes":30,"intensity":"easy|moderate|hard?"}
  {"kind":"log_weight","date":"YYYY-MM-DD","kg":72.4}
Keep proposals few and high-leverage. The user approves or ignores them.

Body: when the context has a \`Body:\` line, it holds every number about the weight goal — the 7-day trend, the weekly rate, what is left, the projected date and the verdict. Quote those; never fit, extrapolate or invent a projection of your own, and when the line says n/a say the weigh-ins are not enough yet. Propose \`set_body_plan\` only when the line says there is no plan, \`log_weight\` when the user reports a weight ("I was 72.4 this morning"), and \`log_workout\` when they describe training they did. Never propose a meal: meals come from the user or a photo, not from prose.

You are not a clinician. Speak about habits and averages. If the user reports a weight change over 1.5 kg in a week in either direction, or mentions an eating disorder, suggest they talk to a doctor and stop giving targets.`;

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

// ---------- one Guide turn, shared by POST /api/guide/chat and the Telegram bot ----------

/** The planning state the Guide sees, rebuilt for every message. */
export async function guideContext(db: D1Database, userId: number): Promise<string> {
  return (await guideState(db, userId)).context;
}

/**
 * The context plus the body summary it quotes, so the caller can put the deterministic answer
 * in front of the model's words without recomputing it (PRD-body §8.3).
 */
export async function guideState(db: D1Database, userId: number): Promise<{ context: string; body: BodySummary | null }> {
  // SELECT * keeps this working before migration 0002 adds users.timezone.
  const user = await db.prepare("SELECT * FROM users WHERE id = ?").bind(userId)
    .first<{ name: string; direction: string; timezone?: string | null }>();
  const today = userToday(user?.timezone);
  const { results: areas } = await db.prepare("SELECT name, satisfaction FROM areas WHERE user_id = ? AND archived = 0 ORDER BY sort").bind(userId).all<{ name: string; satisfaction: number | null }>();
  const { results: goals } = await db.prepare(
    `SELECT g.title, g.level, g.status, g.progress, g.target_date, a.name AS area
     FROM goals g LEFT JOIN areas a ON a.id = g.area_id
     WHERE g.user_id = ? AND g.status IN ('active','at_risk') ORDER BY g.level, g.id`
  ).bind(userId).all<Record<string, unknown>>();
  const { results: tasks } = await db.prepare(
    "SELECT title, done, start_min, estimate_min FROM tasks WHERE user_id = ? AND date = ? AND inbox = 0 AND dropped = 0"
  ).bind(userId, today).all<Record<string, unknown>>();
  const day = await db.prepare("SELECT intention, top1, top2, top3 FROM days WHERE user_id = ? AND date = ?")
    .bind(userId, today).first<Record<string, string>>();
  const plan = await db.prepare("SELECT theme, outcome1, outcome2, outcome3 FROM weekly_plans WHERE user_id = ? AND week_start = ?")
    .bind(userId, weekStartOf(today)).first<Record<string, string>>();
  // Body (PRD-body §9): the summary when a plan exists, the offer when a goal looks like a weight goal.
  const body = await bodySummary(db, userId, today);
  const suggested = body ? null : await suggestedWeightGoal(db, userId);

  const lines = [
    `Today: ${today}`,
    `User: ${user?.name ?? ""}`,
    `Direction: ${user?.direction || "(not set)"}`,
    `Life areas: ${areas.map((a) => a.name + (a.satisfaction ? ` (${a.satisfaction}/10)` : "")).join(", ")}`,
    `Active goals:`,
    ...goals.map((g) => `  - [${g.level}] ${g.title} (${g.progress}%${g.target_date ? `, due ${g.target_date}` : ""}${g.area ? `, ${g.area}` : ""})`),
    `This week's plan: ${plan ? `${plan.theme || "(no theme)"} — ${[plan.outcome1, plan.outcome2, plan.outcome3].filter(Boolean).join("; ")}` : "(none)"}`,
    `Today's intention: ${day?.intention || "(none)"}`,
    `Today's top three: ${day ? [day.top1, day.top2, day.top3].filter(Boolean).join("; ") || "(empty)" : "(empty)"}`,
    `Today's tasks: ${tasks.length ? tasks.map((t) => `${t.title}${t.done ? " ✓" : ""}`).join("; ") : "(none)"}`,
    ...(body ? [`Body: ${bodyContextLine(body)}`] : []),
    ...(suggested ? [`Body: no plan (goal "${suggested}" looks like a weight goal)`] : []),
  ];
  return { context: lines.join("\n"), body };
}

/**
 * One Guide turn: store the user's message, replay the last 12 with fresh context, store the reply.
 * Throws when the model is unavailable (the user's message stays stored, as before).
 */
export async function guideChat(
  db: D1Database, env: GuideEnv, userId: number, message: string
): Promise<{ id: number; text: string; proposals: GuideProposal[] }> {
  await db.prepare("INSERT INTO guide_messages (user_id, role, content) VALUES (?, 'user', ?)").bind(userId, message.trim()).run();

  const { results: recent } = await db.prepare(
    "SELECT role, content FROM guide_messages WHERE user_id = ? ORDER BY id DESC LIMIT 12"
  ).bind(userId).all<{ role: "user" | "assistant"; content: string }>();
  const history: ChatMsg[] = recent.reverse().map((m) => ({ role: m.role, content: m.content }));

  const { context, body } = await guideState(db, userId);
  const reply = await chatComplete(env, context, history);
  const { text, proposals } = extractProposals(reply);
  // "能不能达成" is answered from the summary first, in the same words /body uses (PRD-body §8.3).
  const answer = body && asksAboutBody(message, body) ? `${bodyVerdictLine(body)}\n\n${text}`.trim() : text;

  const saved = await db.prepare(
    "INSERT INTO guide_messages (user_id, role, content, proposals) VALUES (?, 'assistant', ?, ?) RETURNING id"
  ).bind(userId, answer, proposals.length ? JSON.stringify(proposals) : null).first<{ id: number }>();
  if (!saved) throw new Error("could not save the Guide reply");
  return { id: saved.id, text: answer, proposals };
}
