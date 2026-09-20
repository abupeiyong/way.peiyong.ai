import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { BodySummary, WeightLog } from "../../shared/types.ts";
import { useApp } from "../App.tsx";

interface Payload {
  totals: { focus_min: number; recorded_min: number; active_days: number; rescheduled: number };
  weeklyCompletion: { week: string; done: number; total: number }[];
  byArea: { name: string; color: string; minutes: number }[];
  moods: { date: string; mood: number | null; energy: number | null }[];
  planned: { est: number; act: number };
  goals: { id: number; title: string; progress: number }[];
  /** The weight tile (PRD-body §10); null when no body plan is attached. */
  body: { summary: BodySummary; weights: WeightLog[] } | null;
}

const hrs = (min: number) => (min >= 60 ? `${Math.round((min / 60) * 10) / 10}h` : `${min}m`);

export default function Insights() {
  const { nav } = useApp();
  const [data, setData] = useState<Payload | null>(null);
  useEffect(() => { api.get<Payload>("/api/insights").then(setData); }, []);
  if (!data) return null;

  const { totals } = data;
  const maxArea = Math.max(1, ...data.byArea.map((a) => a.minutes));
  const hasAny = totals.focus_min > 0 || data.weeklyCompletion.some((w) => w.total > 0);

  return (
    <>
      <h1 className="page-title">洞察<i>Insights</i></h1>
      <p className="page-sub">静静看一眼：时间与注意力，究竟去了哪里。</p>

      {!hasAny && (
        <div className="card" style={{ marginTop: 18, fontStyle: "italic", color: "var(--soft)" }}>
          Once you complete a few tasks with time attached, patterns will begin to appear here.
        </div>
      )}

      <div className="stat-cards">
        <div className="stat-card"><div className="num">{hrs(totals.focus_min)}</div><div className="lbl">Focus time · 4 weeks</div></div>
        <div className="stat-card"><div className="num">{hrs(totals.recorded_min)}</div><div className="lbl">Recorded time · 4 weeks</div></div>
        <div className="stat-card"><div className="num">{totals.active_days}/14</div><div className="lbl">Active days · 2 weeks</div></div>
        <div className="stat-card"><div className="num">{totals.rescheduled}</div><div className="lbl">Rescheduled tasks</div></div>
      </div>

      <div className="insights-grid">
        {data.body && <WeightTile body={data.body} onOpen={() => nav("/body")} />}

        <div className="card">
          <div className="card-label">每周完成 <i>Weekly completion</i></div>
          {data.weeklyCompletion.length === 0 && <p className="empty-note">No scheduled tasks in the last four weeks.</p>}
          {data.weeklyCompletion.map((w) => (
            <div className="bar-row" key={w.week}>
              <span className="bar-label">{new Date(w.week + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              <div className="progress-track" style={{ flex: 1 }}>
                <div className="progress-fill" style={{ width: `${w.total ? (w.done / w.total) * 100 : 0}%` }} />
              </div>
              <span className="bar-val">{w.done}/{w.total}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-label">时间去处 <i>By life area</i></div>
          {data.byArea.length === 0 && <p className="empty-note">Complete tasks linked to goals to see this breakdown.</p>}
          {data.byArea.map((a) => (
            <div className="bar-row" key={a.name}>
              <span className="bar-label">{a.name}</span>
              <div className="progress-track" style={{ flex: 1 }}>
                <div className="progress-fill" style={{ width: `${(a.minutes / maxArea) * 100}%`, background: a.color }} />
              </div>
              <span className="bar-val">{hrs(a.minutes)}</span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-label">日子的滋味 <i>How the days felt</i></div>
          {data.moods.length === 0 && <p className="empty-note">Write daily reflections to see mood and energy trends.</p>}
          {data.moods.map((m) => (
            <div className="bar-row" key={m.date}>
              <span className="bar-label">{new Date(m.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</span>
              <span style={{ flex: 1 }} className="mini muted">
                {m.mood ? `mood ${"●".repeat(m.mood)}${"○".repeat(5 - m.mood)}` : ""}
                {m.energy ? `  energy ${"●".repeat(m.energy)}${"○".repeat(5 - m.energy)}` : ""}
              </span>
            </div>
          ))}
        </div>

        <div className="card">
          <div className="card-label">计划与实际 <i>Planned vs actual</i></div>
          {data.planned.act === 0 ? (
            <p className="empty-note">Record actual minutes on completed tasks to compare estimates with reality.</p>
          ) : (
            <>
              <div className="bar-row">
                <span className="bar-label">Estimated</span>
                <div className="progress-track" style={{ flex: 1 }}>
                  <div className="progress-fill" style={{ width: "100%", background: "#c9c4b2" }} />
                </div>
                <span className="bar-val">{hrs(data.planned.est)}</span>
              </div>
              <div className="bar-row">
                <span className="bar-label">Actual</span>
                <div className="progress-track" style={{ flex: 1 }}>
                  <div className="progress-fill" style={{ width: `${Math.min(100, (data.planned.act / Math.max(1, data.planned.est)) * 100)}%` }} />
                </div>
                <span className="bar-val">{hrs(data.planned.act)}</span>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 22 }}>
        <div className="card-label">目标进度 <i>Goal progress</i></div>
        <div className="insights-grid" style={{ margin: 0, gap: "4px 32px" }}>
          {data.goals.map((g) => (
            <div className="goal-progress-row" key={g.id}>
              <div className="line"><span>{g.title}</span><span className="muted">{g.progress}%</span></div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${g.progress}%` }} /></div>
            </div>
          ))}
          {data.goals.length === 0 && <p className="hint">No active goals.</p>}
        </div>
      </div>
    </>
  );
}

/** The weight tile: the sparkline of the last 90 days, with the numbers the Body page and /body quote. */
function WeightTile({ body, onOpen }: { body: { summary: BodySummary; weights: WeightLog[] }; onOpen: () => void }) {
  const { summary, weights } = body;
  const w = 220, h = 44;
  const day = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 86400000);
  const xs = weights.map((r) => day(r.date));
  const lo = Math.min(...weights.map((r) => r.kg)), hi = Math.max(...weights.map((r) => r.kg));
  const span = Math.max(0.4, hi - lo);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const path = weights
    .map((r, i) => `${i ? "L" : "M"}${(((day(r.date) - x0) / Math.max(1, x1 - x0)) * w).toFixed(1)} ${(((hi - r.kg) / span) * h).toFixed(1)}`)
    .join(" ");

  return (
    <div className="card">
      <div className="card-label">
        体重 <i>Weight</i>
        <span className="spacer" />
        <button className="btn ghost small" onClick={onOpen}>身体 · Body</button>
      </div>
      {weights.length < 2 ? (
        <p className="empty-note">称两次以上，曲线就出来了 · Two weigh-ins are enough to draw the trend.</p>
      ) : (
        <>
          <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" role="img" aria-label="体重 · Weight, last 90 days">
            <path d={path} fill="none" stroke="var(--ink)" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          <div className="bar-row" style={{ borderTop: "1px solid var(--line-soft)", marginTop: 8 }}>
            <span className="bar-label">{summary.trend === null ? "—" : `${summary.trend.toFixed(1)} kg`}</span>
            <span className="mini muted" style={{ flex: 1 }}>
              7 日均 · 7-day trend{summary.remaining_kg !== null && summary.remaining_kg > 0 ? ` · 距目标 ${summary.remaining_kg.toFixed(1)} kg` : ""}
            </span>
            <span className="bar-val">{summary.projected_date ?? "—"}</span>
          </div>
        </>
      )}
    </div>
  );
}
