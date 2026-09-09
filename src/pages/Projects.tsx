import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Goal, Project, Task } from "../../shared/types.ts";
import { Icon } from "../components/Icon.tsx";

interface ProjectRow extends Project {
  done_tasks: number;
  total_tasks: number;
}

export default function Projects() {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [showFinished, setShowFinished] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  const [tasks, setTasks] = useState<Record<number, Task[]>>({});
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState({ name: "", description: "", goal_id: "" });

  const load = async () => {
    const r = await api.get<{ projects: ProjectRow[] }>("/api/projects");
    setProjects(r.projects);
  };
  useEffect(() => {
    load();
    api.get<{ goals: Goal[] }>("/api/goals").then((r) => setGoals(r.goals));
  }, []);

  const toggleOpen = async (id: number) => {
    if (open === id) { setOpen(null); return; }
    setOpen(id);
    const r = await api.get<{ tasks: Task[] }>(`/api/projects/${id}/tasks`);
    setTasks((prev) => ({ ...prev, [id]: r.tasks }));
  };

  const create = async () => {
    if (!draft.name.trim()) return;
    await api.post("/api/projects", { name: draft.name.trim(), description: draft.description, goal_id: draft.goal_id ? Number(draft.goal_id) : null });
    setDraft({ name: "", description: "", goal_id: "" });
    setCreating(false);
    await load();
  };

  const setStatus = async (p: ProjectRow, status: "active" | "finished") => {
    await api.put(`/api/projects/${p.id}`, { status });
    await load();
  };

  const visible = projects.filter((p) => (showFinished ? true : p.status === "active"));

  return (
    <>
      <div className="spread">
        <div>
          <h1 className="page-title">项目<i>Projects</i></h1>
          <p className="page-sub">为推进某个目标而暂时聚拢的一组事。</p>
        </div>
        <button className="btn" onClick={() => setCreating(true)}><Icon name="plus" /> New project</button>
      </div>

      <div className="filter-row" style={{ justifyContent: "flex-end" }}>
        <label className="check">
          <input type="checkbox" checked={showFinished} onChange={(e) => setShowFinished(e.target.checked)} />
          Show finished
        </label>
      </div>

      {visible.length === 0 && <div className="card empty-note">No projects yet. A project is a bundle of tasks with an end.</div>}
      {visible.map((p) => (
        <div className="card" key={p.id} style={{ marginBottom: 12, padding: "14px 20px" }}>
          <div className="spread">
            <button className="row" style={{ flex: 1, textAlign: "left" }} onClick={() => toggleOpen(p.id)}>
              <Icon name={open === p.id ? "left" : "right"} />
              <strong>{p.name}</strong>
              <span className={`chip ${p.status === "active" ? "green" : ""}`}>{p.status === "active" ? "Active" : "Finished"}</span>
              {p.goal_id && <span className="chip">→ {goals.find((g) => g.id === p.goal_id)?.title.slice(0, 36) ?? "goal"}</span>}
            </button>
            <div className="row" style={{ width: 220 }}>
              <div className="progress-track" style={{ flex: 1 }}>
                <div className="progress-fill" style={{ width: `${p.progress}%` }} />
              </div>
              <span className="muted mini">{p.progress}%</span>
            </div>
          </div>
          {open === p.id && (
            <div style={{ marginTop: 12, borderTop: "1px solid #f1efe6", paddingTop: 10 }}>
              {p.description && <p className="muted small" style={{ marginBottom: 8 }}>{p.description}</p>}
              {(tasks[p.id] ?? []).map((t) => (
                <div className="task-row" key={t.id}>
                  <span className={`checkbox${t.done ? " checked" : ""}`}>{t.done ? <Icon name="check" /> : null}</span>
                  <span className={t.done ? "muted" : ""} style={{ textDecoration: t.done ? "line-through" : "none" }}>{t.title}</span>
                  {t.date && <span className="mini muted" style={{ marginLeft: "auto" }}>{t.date}</span>}
                </div>
              ))}
              {(tasks[p.id] ?? []).length === 0 && <p className="hint">No tasks linked yet — link them from a task's Project field.</p>}
              <div className="row" style={{ marginTop: 10, justifyContent: "flex-end" }}>
                {p.status === "active"
                  ? <button className="btn ghost small" onClick={() => setStatus(p, "finished")}>Mark finished</button>
                  : <button className="btn ghost small" onClick={() => setStatus(p, "active")}>Reopen</button>}
                <button className="btn danger small" onClick={async () => { await api.del(`/api/projects/${p.id}`); await load(); }}>Delete</button>
              </div>
            </div>
          )}
        </div>
      ))}

      {creating && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setCreating(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-head">
              <h3>New project</h3>
              <button className="icon-btn" onClick={() => setCreating(false)}><Icon name="x" /></button>
            </div>
            <div className="stack">
              <input className="input" autoFocus placeholder="Project name" value={draft.name}
                     onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              <textarea className="input" placeholder="What is done when this is done?" value={draft.description}
                        onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
              <div>
                <label className="field-label">Serves goal</label>
                <select className="input" value={draft.goal_id} onChange={(e) => setDraft({ ...draft, goal_id: e.target.value })}>
                  <option value="">—</option>
                  {goals.filter((g) => g.status === "active").map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-actions">
              <div className="right">
                <button className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
                <button className="btn" disabled={!draft.name.trim()} onClick={create}>Create</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
