import { useEffect, useRef, useState } from "react";
import { api, todayStr } from "../api.ts";
import type { Goal, GuideMessage, GuideProposal } from "../../shared/types.ts";
import { useApp } from "../App.tsx";

function proposalLabel(p: GuideProposal): JSX.Element {
  if (p.kind === "create_goal") {
    return <span className="p-what">New {p.level} goal: <strong>{p.title}</strong>{p.area ? ` · ${p.area}` : ""}{p.target_date ? ` · by ${p.target_date}` : ""}</span>;
  }
  if (p.kind === "create_task") {
    return <span className="p-what">Task on {p.date}: <strong>{p.title}</strong>{p.start ? ` · ${p.start}` : ""}{p.estimate_min ? ` · ${p.estimate_min} min` : ""}</span>;
  }
  if (p.kind === "set_top_three") {
    return <span className="p-what">Top three for {p.date}: <strong>{p.outcomes.join(" · ")}</strong></span>;
  }
  if (p.kind === "set_weekly_plan") {
    return <span className="p-what">Week of {p.week_start}{p.theme ? <> · <strong>{p.theme}</strong></> : ""}: <strong>{(p.outcomes ?? []).join(" · ")}</strong></span>;
  }
  if (p.kind === "update_goal_progress") {
    return <span className="p-what">Progress of <strong>{p.goal_title}</strong> → <strong>{p.progress}%</strong></span>;
  }
  if (p.kind === "create_review") {
    const answered = Object.values(p.answers ?? {}).filter(Boolean).length;
    return <span className="p-what">{p.period} review from {p.period_start}: <strong>{answered} answer{answered === 1 ? "" : "s"}</strong></span>;
  }
  return <span className="p-what">Unknown proposal</span>;
}

export default function Guide() {
  const { user } = useApp();
  const [messages, setMessages] = useState<GuideMessage[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState<Set<string>>(new Set());
  const [error, setError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<{ messages: GuideMessage[] }>("/api/guide").then((r) => setMessages(r.messages));
    api.get<{ goals: Goal[] }>("/api/goals").then((r) => setGoals(r.goals.filter((g) => g.status === "active")));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    setError("");
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { id: -Date.now(), role: "user", content: text.trim(), proposals: null, created_at: "" }]);
    try {
      const r = await api.post<{ message: GuideMessage }>("/api/guide/chat", { message: text.trim() });
      setMessages((m) => [...m, r.message]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Guide is unavailable right now.");
    } finally {
      setBusy(false);
    }
  };

  const apply = async (msgId: number, idx: number, p: GuideProposal) => {
    setError("");
    try {
      await api.post("/api/guide/apply", { proposal: p });
      setApplied((prev) => new Set(prev).add(`${msgId}:${idx}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not apply this proposal.");
    }
  };

  return (
    <div className="guide-wrap">
      <div>
        <h1 className="page-title">道引<i>Way Guide</i></h1>
        <p className="page-sub">一位沉静的军师，通晓你完整的规划脉络。</p>
      </div>

      <div className="guide-scroll" ref={scrollRef} style={{ marginTop: 18 }}>
        <div className="guide-msg assistant">
          Hello {user.name}. I can clarify goals, break them into steps, plan your day around what
          matters, and reflect on your week with you. I will always ask before changing anything.
          <div className="guide-quick">
            <button className="btn ghost small" onClick={() => send("Help me plan today. Look at my goals and suggest a top three and a schedule.")}>Plan my day</button>
            <button className="btn ghost small" onClick={() => send("Help me break down one of my goals into concrete steps. Ask me which one if unclear.")}>Break down a goal</button>
            <button className="btn ghost small" onClick={() => send("Review my week with me: what moved, what didn't, and what should next week's focus be?")}>Review my week</button>
          </div>
          {goals.length > 0 && (
            <>
              <p className="mini muted" style={{ marginTop: 12 }}>Or pick a goal to decompose</p>
              <div className="guide-quick">
                {goals.map((g) => (
                  <button key={g.id} className="btn ghost small" onClick={() => send(`Break down my goal "${g.title}" into quarterly and weekly steps, and propose the first tasks for ${todayStr()}.`)}>
                    {g.title.length > 42 ? g.title.slice(0, 42) + "…" : g.title}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {messages.map((m) => (
          <div key={m.id} className={`guide-msg ${m.role}`}>
            {m.content}
            {m.proposals?.map((p, i) => {
              const key = `${m.id}:${i}`;
              return (
                <div className="proposal-card" key={key}>
                  {proposalLabel(p)}
                  {applied.has(key)
                    ? <span className="chip green">applied</span>
                    : <button className="btn small" onClick={() => apply(m.id, i, p)}>Approve</button>}
                </div>
              );
            })}
          </div>
        ))}
        {busy && <div className="guide-msg assistant muted">Thinking…</div>}
        {error && <div className="guide-msg assistant" style={{ color: "var(--danger)" }}>{error}</div>}
      </div>

      <div className="guide-input-row">
        <input
          className="input"
          placeholder="Ask about your goals, your week, or your day…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send(input)}
        />
        <button className="btn" disabled={!input.trim() || busy} onClick={() => send(input)}>Send</button>
      </div>
    </div>
  );
}
