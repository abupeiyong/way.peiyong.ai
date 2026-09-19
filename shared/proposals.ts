import type { GuideProposal } from "./types.ts";

// One wording for a Guide proposal, shared by every client (web card, Telegram).
// Parts are plain strings or `{ strong }` emphasis, so each client renders bold its own way.
export type LabelPart = string | { strong: string };

export function proposalLabel(p: GuideProposal): LabelPart[] {
  if (p.kind === "create_goal") {
    return [`New ${p.level} goal: `, { strong: p.title }, `${p.area ? ` · ${p.area}` : ""}${p.target_date ? ` · by ${p.target_date}` : ""}`];
  }
  if (p.kind === "create_task") {
    return [`Task on ${p.date}: `, { strong: p.title }, `${p.start ? ` · ${p.start}` : ""}${p.estimate_min ? ` · ${p.estimate_min} min` : ""}`];
  }
  if (p.kind === "set_top_three") {
    return [`Top three for ${p.date}: `, { strong: p.outcomes.join(" · ") }];
  }
  if (p.kind === "set_weekly_plan") {
    return [`Week of ${p.week_start}`, ...(p.theme ? [" · ", { strong: p.theme }] : []), ": ", { strong: (p.outcomes ?? []).join(" · ") }];
  }
  if (p.kind === "update_goal_progress") {
    return ["Progress of ", { strong: p.goal_title }, " → ", { strong: `${p.progress}%` }];
  }
  if (p.kind === "create_review") {
    const answered = Object.values(p.answers ?? {}).filter(Boolean).length;
    return [`${p.period} review from ${p.period_start}: `, { strong: `${answered} answer${answered === 1 ? "" : "s"}` }];
  }
  return ["Unknown proposal"];
}

// Plain-text form, e.g. for chat messages that carry no markup.
export function proposalLabelText(p: GuideProposal): string {
  return proposalLabel(p).map((part) => (typeof part === "string" ? part : part.strong)).join("");
}
