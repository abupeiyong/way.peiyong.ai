import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Area, Goal } from "../../shared/types.ts";
import { useApp } from "../App.tsx";
import { Icon } from "../components/Icon.tsx";

const LEVELS = ["lifetime", "year", "quarter", "month", "week"] as const;
const TYPES = ["outcome", "process", "maintenance", "learning"] as const;
const STATUSES = ["draft", "active", "at_risk", "paused", "completed", "abandoned", "archived"] as const;

interface GoalDraft {
  id?: number;
  title: string; description: string; level: string; type: string; status: string;
  area_id: string; parent_id: string; priority: string;
  start_date: string; target_date: string; progress: string; confidence: string;
  success_criteria: string; motivation: string;
}

const emptyDraft = (): GoalDraft => ({
  title: "", description: "", level: "year", type: "outcome", status: "active",
  area_id: "", parent_id: "", priority: "should", start_date: "", target_date: "",
  progress: "0", confidence: "", success_criteria: "", motivation: "",
});

function draftFrom(g: Goal): GoalDraft {
  return {
    id: g.id, title: g.title, description: g.description, level: g.level, type: g.type, status: g.status,
    area_id: g.area_id ? String(g.area_id) : "", parent_id: g.parent_id ? String(g.parent_id) : "",
    priority: g.priority, start_date: g.start_date ?? "", target_date: g.target_date ?? "",
    progress: String(g.progress), confidence: g.confidence ? String(g.confidence) : "",
    success_criteria: g.success_criteria, motivation: g.motivation,
  };
}

export default function Goals() {
  const { user, refreshUser } = useApp();
  const [areas, setAreas] = useState<Area[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [filterArea, setFilterArea] = useState<number | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [modal, setModal] = useState<GoalDraft | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [directionDraft, setDirectionDraft] = useState("");

  const load = async () => {
    const r = await api.get<{ areas: Area[]; goals: Goal[] }>("/api/goals");
    setAreas(r.areas);
    setGoals(r.goals);
  };
  useEffect(() => { load(); }, []);

  const save = async (d: GoalDraft) => {
    const payload = {
      title: d.title.trim(), description: d.description, level: d.level, type: d.type, status: d.status,
      area_id: d.area_id ? Number(d.area_id) : null, parent_id: d.parent_id ? Number(d.parent_id) : null,
      priority: d.priority, start_date: d.start_date || null, target_date: d.target_date || null,
      progress: Number(d.progress) || 0, confidence: d.confidence ? Number(d.confidence) : null,
      success_criteria: d.success_criteria, motivation: d.motivation,
    };
    if (d.id) await api.put(`/api/goals/${d.id}`, payload);
    else await api.post("/api/goals", payload);
    setModal(null);
    await load();
  };

  const remove = async () => {
    if (modal?.id) await api.del(`/api/goals/${modal.id}`);
    setModal(null);
    await load();
  };

  const saveDirection = async () => {
    await api.put("/api/me", { direction: directionDraft });
    await refreshUser();
    setRefineOpen(false);
  };

  const activeByArea = (areaId: number) => goals.filter((g) => g.area_id === areaId && g.status === "active");
  const visible = goals
    .filter((g) => (filterArea === null ? true : g.area_id === filterArea))
    .filter((g) => (showCompleted ? true : !["completed", "abandoned", "archived"].includes(g.status)));

  const fmtDue = (d: string | null) =>
    d ? "by " + new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";

  return (
    <>
      <div className="card direction-card">
        <div className="card-label">
          方向 <i>Direction</i>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => { setDirectionDraft(user.direction); setRefineOpen(true); }}>Refine</button>
        </div>
        {refineOpen ? (
          <div className="stack">
            <textarea className="input" rows={3} value={directionDraft} onChange={(e) => setDirectionDraft(e.target.value)}
                      placeholder="Where are you going? Vision, values, identity — one honest paragraph." />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost small" onClick={() => setRefineOpen(false)}>Cancel</button>
              <button className="btn small" onClick={saveDirection}>Save</button>
            </div>
          </div>
        ) : (
          <p className="direction-quote">
            {user.direction ? `“${user.direction}”` : "No direction yet. Write one honest paragraph about where you are going."}
          </p>
        )}
      </div>

      <p className="card-label" style={{ marginBottom: 10 }}>人生领域 <i>Life areas</i></p>
      <div className="areas-grid">
        {areas.map((a) => {
          const act = activeByArea(a.id);
          const avg = act.length ? Math.round(act.reduce((s, g) => s + g.progress, 0) / act.length) : 0;
          return (
            <div className="area-tile" key={a.id}>
              <div className="a-name"><span className="area-dot" style={{ background: a.color }} />{a.name}</div>
              <div className="a-sub">{act.length ? `${act.length} active goal${act.length > 1 ? "s" : ""} · ${avg}%` : "Quiet — no active goals"}</div>
            </div>
          );
        })}
      </div>

      <div className="spread" style={{ marginTop: 30 }}>
        <div>
          <h1 className="page-title">目标<i>Goals</i></h1>
          <p className="page-sub">每个目标，都应服务于其上一层。 Every goal should serve the level above it.</p>
        </div>
        <button className="btn" onClick={() => setModal(emptyDraft())}><Icon name="plus" /> New goal</button>
      </div>

      <div className="filter-row">
        <button className={filterArea === null ? "on" : ""} onClick={() => setFilterArea(null)}>All areas</button>
        {areas.map((a) => (
          <button key={a.id} className={filterArea === a.id ? "on" : ""} onClick={() => setFilterArea(a.id)}>{a.name}</button>
        ))}
        <label className="check">
          <input type="checkbox" checked={showCompleted} onChange={(e) => setShowCompleted(e.target.checked)} />
          Show completed
        </label>
      </div>

      {visible.length === 0 && <div className="card empty-note">Nothing here yet. A goal starts as one honest sentence.</div>}
      {visible.map((g) => {
        const area = areas.find((a) => a.id === g.area_id);
        return (
          <button className="goal-card" key={g.id} onClick={() => setModal(draftFrom(g))}>
            <div>
              <div className="g-title">{g.title}</div>
              <div className="g-chips">
                <span className="chip">{g.level[0].toUpperCase() + g.level.slice(1)}</span>
                <span className={`chip ${g.status === "active" ? "green" : g.status === "at_risk" ? "red" : ""}`}>{g.status.replace("_", " ")}</span>
                {area && <span className="chip"><span className="area-dot" style={{ background: area.color }} />{area.name}</span>}
                {g.parent_id && <span className="chip">↳ {goals.find((p) => p.id === g.parent_id)?.title.slice(0, 32) ?? "parent"}</span>}
              </div>
            </div>
            <div className="g-right">
              <div className="pct">{g.progress}%</div>
              <div className="due">{fmtDue(g.target_date)}</div>
            </div>
          </button>
        );
      })}

      {modal && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setModal(null); }}>
          <div className="modal">
            <div className="modal-head">
              <h3>{modal.id ? "Edit goal" : "New goal"}</h3>
              <button className="icon-btn" onClick={() => setModal(null)}><Icon name="x" /></button>
            </div>
            <div className="stack">
              <input className="input" autoFocus placeholder="What do you want to achieve?" value={modal.title}
                     onChange={(e) => setModal({ ...modal, title: e.target.value })} />
              <textarea className="input" placeholder="Describe the goal (optional)" value={modal.description}
                        onChange={(e) => setModal({ ...modal, description: e.target.value })} />
              <div className="form-grid">
                <div>
                  <label className="field-label">Level</label>
                  <select className="input" value={modal.level} onChange={(e) => setModal({ ...modal, level: e.target.value })}>
                    {LEVELS.map((l) => <option key={l} value={l}>{l[0].toUpperCase() + l.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Type</label>
                  <select className="input" value={modal.type} onChange={(e) => setModal({ ...modal, type: e.target.value })}>
                    {TYPES.map((t) => <option key={t} value={t}>{t[0].toUpperCase() + t.slice(1)}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Status</label>
                  <select className="input" value={modal.status} onChange={(e) => setModal({ ...modal, status: e.target.value })}>
                    {STATUSES.map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Life area</label>
                  <select className="input" value={modal.area_id} onChange={(e) => setModal({ ...modal, area_id: e.target.value })}>
                    <option value="">—</option>
                    {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Parent goal</label>
                  <select className="input" value={modal.parent_id} onChange={(e) => setModal({ ...modal, parent_id: e.target.value })}>
                    <option value="">— (top level)</option>
                    {goals.filter((g) => g.id !== modal.id).map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                  </select>
                </div>
                <div>
                  <label className="field-label">Priority</label>
                  <select className="input" value={modal.priority} onChange={(e) => setModal({ ...modal, priority: e.target.value })}>
                    <option value="must">Must</option>
                    <option value="should">Should</option>
                    <option value="could">Could</option>
                  </select>
                </div>
                <div>
                  <label className="field-label">Start date</label>
                  <input className="input" type="date" value={modal.start_date} onChange={(e) => setModal({ ...modal, start_date: e.target.value })} />
                </div>
                <div>
                  <label className="field-label">Target date</label>
                  <input className="input" type="date" value={modal.target_date} onChange={(e) => setModal({ ...modal, target_date: e.target.value })} />
                </div>
                <div>
                  <label className="field-label">Progress %</label>
                  <input className="input" type="number" min="0" max="100" value={modal.progress}
                         onChange={(e) => setModal({ ...modal, progress: e.target.value })} />
                </div>
                <div>
                  <label className="field-label">Confidence (1–5)</label>
                  <input className="input" type="number" min="1" max="5" value={modal.confidence}
                         onChange={(e) => setModal({ ...modal, confidence: e.target.value })} />
                </div>
              </div>
              <textarea className="input" placeholder="Success criteria — how will you know you achieved it?" value={modal.success_criteria}
                        onChange={(e) => setModal({ ...modal, success_criteria: e.target.value })} />
              <textarea className="input" placeholder="Motivation — why does this matter to you?" value={modal.motivation}
                        onChange={(e) => setModal({ ...modal, motivation: e.target.value })} />
            </div>
            <div className="modal-actions">
              {modal.id && <button className="btn danger small" onClick={remove}>Delete</button>}
              <div className="right">
                <button className="btn ghost" onClick={() => setModal(null)}>Cancel</button>
                <button className="btn" disabled={!modal.title.trim()} onClick={() => save(modal)}>{modal.id ? "Save" : "Create"}</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
