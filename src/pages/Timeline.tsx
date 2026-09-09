import { useEffect, useState } from "react";
import { api, addDays, todayStr } from "../api.ts";
import type { WeeklyPlan } from "../../shared/types.ts";
import { useApp } from "../App.tsx";
import { Icon } from "../components/Icon.tsx";

interface Stats { goals_in_period: number; goals_completed: number; tasks_scheduled: number; tasks_completed: number }
interface WeekPayload {
  view: "week"; start: string; end: string; stats: Stats;
  plan: WeeklyPlan | null;
  tasks: { id: number; title: string; date: string; done: number }[];
}
interface PeriodPayload {
  view: string; start: string; end: string; stats: Stats;
  goals: { id: number; title: string; status: string; progress: number; target_date: string | null; area_name: string | null; area_color: string | null }[];
}

const VIEWS = ["week", "month", "quarter", "year"] as const;

function fmtRange(view: string, start: string, end: string): string {
  const s = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  if (view === "year") return String(s.getFullYear());
  if (view === "quarter") return `Q${Math.floor(s.getMonth() / 3) + 1} ${s.getFullYear()}`;
  if (view === "month") return s.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return `${s.toLocaleDateString("en-US", { month: "short", day: "numeric" })} – ${e.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

function shiftAnchor(view: string, anchor: string, dir: 1 | -1): string {
  const d = new Date(anchor + "T00:00:00");
  if (view === "week") return addDays(anchor, 7 * dir);
  if (view === "month") d.setMonth(d.getMonth() + dir);
  else if (view === "quarter") d.setMonth(d.getMonth() + 3 * dir);
  else d.setFullYear(d.getFullYear() + dir);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function Timeline({ search }: { search: string }) {
  const { nav } = useApp();
  const params = new URLSearchParams(search);
  const view = params.get("view") ?? "week";
  const anchor = params.get("anchor") ?? todayStr();

  const [data, setData] = useState<WeekPayload | PeriodPayload | null>(null);
  const [plan, setPlan] = useState<WeeklyPlan | null>(null);
  const [savedNote, setSavedNote] = useState(false);

  useEffect(() => {
    api.get<WeekPayload | PeriodPayload>(`/api/timeline?view=${view}&anchor=${anchor}`).then((d) => {
      setData(d);
      if (d.view === "week") {
        const w = d as WeekPayload;
        setPlan(w.plan ?? { week_start: w.start, theme: "", outcome1: "", outcome2: "", outcome3: "", commitments: "", risks: "" });
      }
    });
  }, [view, anchor]);

  if (!data) return null;
  const stats = data.stats;

  const savePlan = async () => {
    if (!plan) return;
    await api.put(`/api/weekly-plan/${data.start}`, plan);
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 1600);
  };

  return (
    <>
      <div className="spread">
        <h1 className="page-title">时间轴<i>Timeline</i></h1>
        <div className="view-tabs">
          {VIEWS.map((v) => (
            <a key={v} className={v === view ? "active" : ""} href={`/timeline?view=${v}&anchor=${anchor}`}
               onClick={(e) => { e.preventDefault(); nav(`/timeline?view=${v}&anchor=${anchor}`); }}>
              {v[0].toUpperCase() + v.slice(1)}
            </a>
          ))}
        </div>
      </div>

      <div className="spread" style={{ marginTop: 14 }}>
        <p style={{ fontWeight: 600 }}>{fmtRange(view, data.start, data.end)}</p>
        <div className="day-nav">
          <button aria-label="Previous" onClick={() => nav(`/timeline?view=${view}&anchor=${shiftAnchor(view, anchor, -1)}`)}><Icon name="left" /></button>
          <button style={{ width: "auto", padding: "0 12px", fontSize: 13, fontWeight: 600 }} onClick={() => nav(`/timeline?view=${view}`)}>Now</button>
          <button aria-label="Next" onClick={() => nav(`/timeline?view=${view}&anchor=${shiftAnchor(view, anchor, 1)}`)}><Icon name="right" /></button>
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="num">{stats.goals_in_period}</div><div className="lbl">Goals in period</div></div>
        <div className="stat-card"><div className="num">{stats.goals_completed}</div><div className="lbl">Completed goals</div></div>
        <div className="stat-card"><div className="num">{stats.tasks_scheduled}</div><div className="lbl">Tasks scheduled</div></div>
        <div className="stat-card"><div className="num">{stats.tasks_completed}</div><div className="lbl">Tasks completed</div></div>
      </div>

      {data.view === "week" && plan ? (
        <>
          <div className="card">
            <div className="card-label">一周之计 <i>Weekly plan</i> {savedNote && <span className="chip green">已存</span>}</div>
            <div className="stack">
              <input className="input" placeholder="Weekly theme — e.g. Focus on completing the first prototype"
                     value={plan.theme} onChange={(e) => setPlan({ ...plan, theme: e.target.value })} />
              <div className="form-grid">
                {(["outcome1", "outcome2", "outcome3"] as const).map((k, i) => (
                  <input key={k} className="input" placeholder={`Top outcome ${i + 1}`} value={plan[k]}
                         onChange={(e) => setPlan({ ...plan, [k]: e.target.value })} />
                ))}
              </div>
              <div className="form-grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
                <textarea className="input" placeholder="Commitments — health, learning, personal time…"
                          value={plan.commitments} onChange={(e) => setPlan({ ...plan, commitments: e.target.value })} />
                <textarea className="input" placeholder="Risks and constraints this week"
                          value={plan.risks} onChange={(e) => setPlan({ ...plan, risks: e.target.value })} />
              </div>
              <div style={{ textAlign: "right" }}>
                <button className="btn" onClick={savePlan}>Save plan</button>
              </div>
            </div>
          </div>

          <div className="week-grid">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => {
              const d = addDays(data.start, i);
              const dow = new Date(d + "T00:00:00").toLocaleDateString("en-US", { weekday: "short" });
              const dayTasks = (data as WeekPayload).tasks.filter((t) => t.date === d);
              return (
                <a key={d} className={`week-day${d === todayStr() ? " today-col-hl" : ""}`} href={`/today?date=${d}`}
                   onClick={(e) => { e.preventDefault(); nav(`/today?date=${d}`); }}>
                  <div className="d-head">
                    <span className="d-dow">{dow}</span>
                    <span className="d-num">{Number(d.slice(8))}</span>
                  </div>
                  {dayTasks.slice(0, 6).map((t) => (
                    <div key={t.id} className={`week-task${t.done ? " done" : ""}`}>· {t.title}</div>
                  ))}
                  {dayTasks.length > 6 && <div className="week-task muted">+{dayTasks.length - 6} more</div>}
                </a>
              );
            })}
          </div>
        </>
      ) : data.view !== "week" ? (
        <div>
          {(() => {
            const goals = (data as PeriodPayload).goals;
            if (goals.length === 0) return <div className="card empty-note">No goals span this period.</div>;
            const groups = new Map<string, typeof goals>();
            for (const g of goals) {
              const key = g.area_name ?? "No area";
              if (!groups.has(key)) groups.set(key, []);
              groups.get(key)!.push(g);
            }
            return [...groups.entries()].map(([area, list]) => (
              <div className="card tl-goal-group" key={area}>
                <div className="row" style={{ marginBottom: 4 }}>
                  <span className="area-dot" style={{ background: list[0].area_color ?? "#a8ada0" }} />
                  <strong>{area}</strong>
                </div>
                {list.map((g) => (
                  <div className="tl-goal-row" key={g.id}>
                    <div style={{ flex: 1 }}>
                      <div className="row" style={{ gap: 8 }}>
                        <span>{g.title}</span>
                        <span className={`chip ${g.status === "active" ? "green" : g.status === "at_risk" ? "red" : ""}`}>{g.status.replace("_", " ")}</span>
                      </div>
                      <div className="progress-track" style={{ marginTop: 6, maxWidth: 260 }}>
                        <div className="progress-fill" style={{ width: `${g.progress}%` }} />
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontWeight: 700 }}>{g.progress}%</div>
                      {g.target_date && <div className="mini muted">by {new Date(g.target_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ));
          })()}
        </div>
      ) : null}
    </>
  );
}
