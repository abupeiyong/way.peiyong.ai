import { useState } from "react";
import type { Goal, Project, Task } from "../../shared/types.ts";
import { fmtMin } from "../api.ts";
import { Icon } from "./Icon.tsx";

export interface TaskDraft {
  id?: number;
  title: string;
  description: string;
  priority: string;
  energy: string;
  estimate_min: string;
  date: string;
  start: string;   // "HH:MM" or ""
  end: string;
  goal_id: string;
  project_id: string;
  repeat: string;
  notes: string;
}

export function draftFromTask(t: Partial<Task> & { date?: string | null }): TaskDraft {
  return {
    id: t.id,
    title: t.title ?? "",
    description: t.description ?? "",
    priority: t.priority ?? "should",
    energy: t.energy ?? "",
    estimate_min: t.estimate_min ? String(t.estimate_min) : "",
    date: t.date ?? "",
    start: t.start_min != null ? fmtMin(t.start_min) : "",
    end: t.end_min != null ? fmtMin(t.end_min) : "",
    goal_id: t.goal_id ? String(t.goal_id) : "",
    project_id: t.project_id ? String(t.project_id) : "",
    repeat: t.repeat ?? "never",
    notes: t.notes ?? "",
  };
}

export function draftToPayload(d: TaskDraft): Record<string, unknown> {
  const parseTime = (s: string): number | null => {
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const start = parseTime(d.start);
  let end = parseTime(d.end);
  if (start !== null && end === null) end = start + (Number(d.estimate_min) || 60);
  return {
    title: d.title.trim(),
    description: d.description,
    priority: d.priority,
    energy: d.energy || null,
    estimate_min: d.estimate_min ? Number(d.estimate_min) : null,
    date: d.date || null,
    inbox: d.date ? 0 : 1,
    start_min: start,
    end_min: end,
    goal_id: d.goal_id ? Number(d.goal_id) : null,
    project_id: d.project_id ? Number(d.project_id) : null,
    repeat: d.repeat,
    notes: d.notes,
  };
}

export default function TaskModal({ initial, goals, projects, onSave, onDelete, onClose }: {
  initial: TaskDraft;
  goals: Goal[];
  projects: Project[];
  onSave: (d: TaskDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
}) {
  const [d, setD] = useState<TaskDraft>(initial);
  const set = (patch: Partial<TaskDraft>) => setD((prev) => ({ ...prev, ...patch }));

  return (
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal">
        <div className="modal-head">
          <h3>{d.id ? "Edit task" : "New task"}</h3>
          <button className="icon-btn" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="stack">
          <input className="input" autoFocus placeholder="Task title" value={d.title} onChange={(e) => set({ title: e.target.value })} />
          <textarea className="input" placeholder="Description (optional)" value={d.description} onChange={(e) => set({ description: e.target.value })} />
          <div className="form-grid">
            <div>
              <label className="field-label">Priority</label>
              <select className="input" value={d.priority} onChange={(e) => set({ priority: e.target.value })}>
                <option value="must">Must</option>
                <option value="should">Should</option>
                <option value="could">Could</option>
              </select>
            </div>
            <div>
              <label className="field-label">Energy</label>
              <select className="input" value={d.energy} onChange={(e) => set({ energy: e.target.value })}>
                <option value="">—</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <label className="field-label">Estimate (min)</label>
              <input className="input" type="number" min="5" step="5" placeholder="45" value={d.estimate_min} onChange={(e) => set({ estimate_min: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Date</label>
              <input className="input" type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Start</label>
              <input className="input" type="time" value={d.start} onChange={(e) => set({ start: e.target.value })} />
            </div>
            <div>
              <label className="field-label">End</label>
              <input className="input" type="time" value={d.end} onChange={(e) => set({ end: e.target.value })} />
            </div>
            <div>
              <label className="field-label">Goal</label>
              <select className="input" value={d.goal_id} onChange={(e) => set({ goal_id: e.target.value })}>
                <option value="">—</option>
                {goals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Project</label>
              <select className="input" value={d.project_id} onChange={(e) => set({ project_id: e.target.value })}>
                <option value="">—</option>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="field-label">Repeat</label>
              <select className="input" value={d.repeat} onChange={(e) => set({ repeat: e.target.value })}>
                <option value="never">Never</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </div>
          </div>
          <textarea className="input" placeholder="Notes" value={d.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
        <div className="modal-actions">
          {d.id && onDelete && <button className="btn danger small" onClick={onDelete}>Delete</button>}
          <div className="right">
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={!d.title.trim()} onClick={() => onSave(d)}>{d.id ? "Save" : "Create"}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
