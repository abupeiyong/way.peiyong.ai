import { useEffect, useState } from "react";
import { api, ApiError } from "../api.ts";
import type { Area, BodyPlan, Goal } from "../../shared/types.ts";
import {
  DAILY_KCAL_RANGE, DEFAULT_WEEKLY_WORKOUTS, WEEKLY_WORKOUTS_RANGE, WEIGHT_GOAL_RE, WEIGHT_UNIT_LABELS,
  fromKg, isWeightUnit, toKg, type WeightUnit,
} from "../../shared/body.ts";
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

/** GET /api/goals — the goals plus the user's single body plan (PRD-body §4.1, §10). */
interface GoalsPayload {
  areas: Area[];
  goals: Goal[];
  /** The one plan this user has, whichever goal it sits on; null when body tracking is off. */
  body_plan: BodyPlan | null;
  /** The latest weigh-in, the start weight a new plan defaults to. */
  latest_kg: number | null;
}

export default function Goals() {
  const { user, refreshUser } = useApp();
  const [areas, setAreas] = useState<Area[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [plan, setPlan] = useState<BodyPlan | null>(null);
  const [latestKg, setLatestKg] = useState<number | null>(null);
  const [filterArea, setFilterArea] = useState<number | null>(null);
  const [showCompleted, setShowCompleted] = useState(false);
  const [modal, setModal] = useState<GoalDraft | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [directionDraft, setDirectionDraft] = useState("");

  const load = async () => {
    const r = await api.get<GoalsPayload>("/api/goals");
    setAreas(r.areas);
    setGoals(r.goals);
    setPlan(r.body_plan);
    setLatestKg(r.latest_kg);
    return r;
  };
  useEffect(() => { load(); }, []);

  /** goals.progress is derived for the goal the body plan sits on (PRD-body §4.3). */
  const derivedGoalId = plan?.goal_id ?? null;

  /** After attaching, moving or detaching a plan the goal's progress changed under the open modal. */
  const reloadPlan = async () => {
    const r = await load();
    setModal((m) => {
      const g = m?.id ? r.goals.find((x) => x.id === m.id) : undefined;
      return m && g ? { ...m, progress: String(g.progress) } : m;
    });
  };

  const save = async (d: GoalDraft) => {
    const payload = {
      title: d.title.trim(), description: d.description, level: d.level, type: d.type, status: d.status,
      area_id: d.area_id ? Number(d.area_id) : null, parent_id: d.parent_id ? Number(d.parent_id) : null,
      priority: d.priority, start_date: d.start_date || null, target_date: d.target_date || null,
      confidence: d.confidence ? Number(d.confidence) : null,
      success_criteria: d.success_criteria, motivation: d.motivation,
      // A goal with a body plan has its progress computed from the weigh-ins; the form never writes it.
      ...(d.id && d.id === derivedGoalId ? {} : { progress: Number(d.progress) || 0 }),
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
                {offerTrack(g, plan) && (
                  <span className="chip offer">这是体重目标？开启体重追踪 <i>Track this as a weight goal</i></span>
                )}
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
                         disabled={modal.id === derivedGoalId}
                         onChange={(e) => setModal({ ...modal, progress: e.target.value })} />
                  {modal.id === derivedGoalId && <p className="hint" style={{ marginTop: 5 }}>由体重推算 · derived from weight</p>}
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
              {modal.id && (
                <BodyPlanSection key={modal.id} goalId={modal.id} goalTitle={modal.title} plan={plan}
                                 latestKg={latestKg} onChanged={reloadPlan} />
              )}
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

/**
 * The nudge to turn tracking on (PRD-body §4.2): an active goal whose title reads like a weight
 * goal, while the user has no plan at all. Nothing is switched on automatically — the card only
 * says so, and the section inside the goal does the rest.
 */
function offerTrack(g: Goal, plan: BodyPlan | null): boolean {
  return !plan && (g.status === "active" || g.status === "at_risk") && WEIGHT_GOAL_RE.test(g.title);
}

/**
 * 身体计划 · Body plan (PRD-body §4.1): the configuration switch, living on the goal it serves.
 * Start and target are typed in the chosen unit and stored in kg by the worker — 144 斤 is 72.0 kg.
 * One plan exists per user, so saving it here when it sits on another goal moves it, after asking.
 */
function BodyPlanSection(
  { goalId, goalTitle, plan, latestKg, onChanged }:
  { goalId: number; goalTitle: string; plan: BodyPlan | null; latestKg: number | null; onChanged: () => Promise<void> }
) {
  const attached = plan?.goal_id === goalId;
  /** The plan sits on a different goal: saving here moves it (PRD-body §4.1, one row per user). */
  const elsewhere = plan && !attached ? plan : null;
  const unit0: WeightUnit = attached && isWeightUnit(plan.input_unit) ? plan.input_unit : "kg";

  const [open, setOpen] = useState(attached || (!plan && WEIGHT_GOAL_RE.test(goalTitle)));
  const [unit, setUnit] = useState<WeightUnit>(unit0);
  const [start, setStart] = useState(
    attached ? String(fromKg(plan.start_kg, unit0)) : latestKg === null ? "" : String(latestKg)
  );
  const [target, setTarget] = useState(attached ? String(fromKg(plan.target_kg, unit0)) : "");
  const [workouts, setWorkouts] = useState(String(attached ? plan.weekly_workouts : DEFAULT_WEEKLY_WORKOUTS));
  const [kcal, setKcal] = useState(attached && plan.daily_kcal !== null ? String(plan.daily_kcal) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  /** What the worker will store, so the unit never has to be taken on trust. */
  const asKg = (v: string): number | null => {
    const n = Number(v);
    return v.trim() && Number.isFinite(n) ? toKg(n, unit) : null;
  };
  const startKg = asKg(start), targetKg = asKg(target);

  const submit = async () => {
    setError("");
    if (elsewhere && !window.confirm(
      `体重追踪现在挂在「${elsewhere.goal_title}」上，移到这个目标？\nMove weight tracking from “${elsewhere.goal_title}” to this goal?`
    )) return;
    setBusy(true);
    try {
      await api.put("/api/body/plan", {
        goal_id: goalId, start, target, unit, weekly_workouts: workouts, daily_kcal: kcal === "" ? null : kcal,
      });
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "没能保存 · Could not save");
    } finally {
      setBusy(false);
    }
  };

  const detach = async () => {
    if (!window.confirm("取消体重追踪？称重记录会留着。\nStop tracking this goal by weight? The weigh-ins stay.")) return;
    setBusy(true);
    try {
      await api.del("/api/body/plan");
      setOpen(false);
      await onChanged();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "没能取消 · Could not detach");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="plan-block">
      <div className="card-label">
        身体计划 <i>Body plan</i>
        {attached && <span className="chip green" style={{ marginLeft: 8 }}>追踪中 · tracking</span>}
      </div>

      {!open ? (
        <div className="row" style={{ flexWrap: "wrap" }}>
          <p className="hint" style={{ marginTop: 0, flex: 1 }}>
            {elsewhere
              ? <>体重追踪现在挂在「{elsewhere.goal_title}」上 · Weight tracking is on another goal.</>
              : <>这是体重目标？开启后有七日均值、每周速度和预计达成日 · Track this as a weight goal.</>}
          </p>
          <button className="btn ghost small" onClick={() => setOpen(true)}>开启体重追踪 · Track as weight goal</button>
        </div>
      ) : (
        <>
          <div className="form-grid">
            <div>
              <label className="field-label">起点 · Start ({WEIGHT_UNIT_LABELS[unit]})</label>
              <input className="input" type="number" step="0.1" placeholder="72.4" value={start}
                     onChange={(e) => setStart(e.target.value)} />
            </div>
            <div>
              <label className="field-label">目标 · Target ({WEIGHT_UNIT_LABELS[unit]})</label>
              <input className="input" type="number" step="0.1" placeholder="70" value={target}
                     onChange={(e) => setTarget(e.target.value)} />
            </div>
            <div>
              <label className="field-label">输入单位 · Input unit</label>
              <select className="input" value={unit} onChange={(e) => setUnit(e.target.value as WeightUnit)}>
                {(Object.keys(WEIGHT_UNIT_LABELS) as WeightUnit[]).map((u) => (
                  <option key={u} value={u}>{WEIGHT_UNIT_LABELS[u]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="field-label">每周运动 · Weekly workouts</label>
              <input className="input" type="number" min={WEEKLY_WORKOUTS_RANGE[0]} max={WEEKLY_WORKOUTS_RANGE[1]}
                     value={workouts} onChange={(e) => setWorkouts(e.target.value)} />
            </div>
            <div>
              <label className="field-label">每日热量 · Daily kcal</label>
              <input className="input" type="number" min={DAILY_KCAL_RANGE[0]} max={DAILY_KCAL_RANGE[1]}
                     placeholder="可选 · optional" value={kcal} onChange={(e) => setKcal(e.target.value)} />
            </div>
          </div>
          <p className="hint">
            存储始终是公斤 · stored in kg
            {startKg !== null && targetKg !== null && ` — ${startKg.toFixed(1)} → ${targetKg.toFixed(1)} kg`}
            ；进度随称重推算 · progress becomes derived from the weigh-ins.
          </p>
          {error && <p className="hint" style={{ color: "var(--red-deep)" }}>{error}</p>}
          <div className="row" style={{ marginTop: 10 }}>
            {attached && <button className="btn danger small" disabled={busy} onClick={detach}>取消追踪 · Detach</button>}
            <span className="spacer" style={{ flex: 1 }} />
            {!attached && <button className="btn ghost small" disabled={busy} onClick={() => setOpen(false)}>收起 · Cancel</button>}
            <button className="btn small" disabled={busy || !start.trim() || !target.trim()} onClick={submit}>
              {attached ? "保存计划 · Save plan" : elsewhere ? "移到这个目标 · Move here" : "开启 · Turn on"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
