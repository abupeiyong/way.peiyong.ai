import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Review, ReviewPeriod } from "../../shared/types.ts";

const PERIODS: ReviewPeriod[] = ["daily", "weekly", "monthly", "quarterly", "yearly"];

const QUESTIONS: Record<ReviewPeriod, string[]> = {
  daily: [
    "What moved forward today?",
    "What resisted or distracted me?",
    "What did I learn?",
    "What is tomorrow's single focus?",
  ],
  weekly: [
    "Which goals moved forward this week?",
    "Which commitments were missed?",
    "Where did my time actually go?",
    "Which life areas received attention — and which didn't?",
    "What did I learn?",
    "What remains unfinished, and what happens to it?",
    "What is the focus for next week?",
  ],
  monthly: [
    "How did this month's goals progress?",
    "What worked well and deserves repeating?",
    "What didn't work, and why?",
    "What will I adjust for next month?",
  ],
  quarterly: [
    "What did this quarter actually produce?",
    "Is the direction still right?",
    "What was the biggest lesson?",
    "What is the focus for next quarter?",
  ],
  yearly: [
    "How did the year serve my direction?",
    "What am I proudest of?",
    "What was hardest, and what did it teach me?",
    "What is the theme for next year?",
  ],
};

interface Payload {
  period: ReviewPeriod;
  start: string;
  end: string;
  stats: { tasks_planned: number; tasks_done: number; rescheduled: number; goals_completed: number };
  current: (Omit<Review, "answers"> & { answers: string }) | null;
  past: (Omit<Review, "answers"> & { answers: string })[];
}

const RATINGS = [["mood", "Mood"], ["energy", "Energy"], ["focus", "Focus"], ["satisfaction", "Satisfaction"]] as const;

function fmtPeriod(period: ReviewPeriod, start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  const md = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  if (period === "daily") return s.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  if (period === "yearly") return String(s.getFullYear());
  if (period === "quarterly") return `Q${Math.floor(s.getMonth() / 3) + 1} ${s.getFullYear()}`;
  if (period === "monthly") return s.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return `${md(s)} – ${md(e)}`;
}

export default function Reviews() {
  const [period, setPeriod] = useState<ReviewPeriod>("weekly");
  const [data, setData] = useState<Payload | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [ratings, setRatings] = useState<Record<string, number | null>>({});
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    api.get<Payload>(`/api/reviews?period=${period}`).then((d) => {
      setData(d);
      setAnswers(d.current ? JSON.parse(d.current.answers) : {});
      setRatings(d.current
        ? { mood: d.current.mood, energy: d.current.energy, focus: d.current.focus, satisfaction: d.current.satisfaction }
        : { mood: null, energy: null, focus: null, satisfaction: null });
    });
  }, [period]);

  if (!data) return null;

  const save = async () => {
    await api.put("/api/reviews", { period, period_start: data.start, answers, ...ratings });
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 1600);
  };

  return (
    <>
      <h1 className="page-title">复盘<i>Reviews</i></h1>
      <p className="page-sub">没有复盘，计划只是美好的愿望。</p>

      <div className="filter-row" style={{ marginTop: 18 }}>
        {PERIODS.map((p) => (
          <button key={p} className={p === period ? "on" : ""} onClick={() => setPeriod(p)}>
            {p[0].toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>

      <div className="reviews-layout">
        <div className="card">
          <div className="card-label">
            本期复盘 <i>Current {period} review</i> {savedNote && <span className="chip green">已存</span>}
          </div>
          <p className="muted small" style={{ marginBottom: 14 }}>{fmtPeriod(period, data.start, data.end)}</p>

          <div className="stat-cards" style={{ margin: "0 0 18px" }}>
            <div className="stat-card">
              <div className="num">{data.stats.tasks_planned}</div><div className="lbl">Tasks planned</div>
            </div>
            <div className="stat-card">
              <div className="num">{data.stats.tasks_done}</div><div className="lbl">Tasks done</div>
            </div>
            <div className="stat-card">
              <div className="num">{data.stats.rescheduled}</div><div className="lbl">Rescheduled</div>
            </div>
            <div className="stat-card">
              <div className="num">{data.stats.goals_completed}</div><div className="lbl">Goals completed</div>
            </div>
          </div>

          {QUESTIONS[period].map((q) => (
            <div className="review-q" key={q}>
              <label>{q}</label>
              <textarea className="input" rows={2} value={answers[q] ?? ""}
                        onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })} />
            </div>
          ))}

          <div className="rating-panel">
            {RATINGS.map(([key, label]) => (
              <div className="rating-row" key={key}>
                <span className="small">{label}</span>
                <span className="rating-dots">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button key={n} className={ratings[key] === n ? "on" : ""}
                            onClick={() => setRatings({ ...ratings, [key]: ratings[key] === n ? null : n })}>
                      {n}
                    </button>
                  ))}
                </span>
              </div>
            ))}
          </div>

          <div style={{ textAlign: "right", marginTop: 16 }}>
            <button className="btn" onClick={save}>Save review</button>
          </div>
        </div>

        <div>
          <p className="card-label" style={{ marginBottom: 10 }}>往期 <i>Past {period} reviews</i></p>
          <div className="card">
            {data.past.length === 0 && (
              <p className="empty-note">No past {period} reviews yet. They will accumulate here — a quiet record of how you have moved.</p>
            )}
            {data.past.map((r) => {
              const a = JSON.parse(r.answers) as Record<string, string>;
              return (
                <details className="past-review" key={r.id}>
                  <summary>{fmtPeriod(period, r.period_start, r.period_start)}</summary>
                  <dl className="qa">
                    {Object.entries(a).filter(([, v]) => v).map(([q, v]) => (
                      <div key={q}><dt>{q}</dt><dd>{v}</dd></div>
                    ))}
                  </dl>
                </details>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
