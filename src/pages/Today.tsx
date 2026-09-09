import { useCallback, useEffect, useState } from "react";
import { api, addDays, fmtMin, todayStr } from "../api.ts";
import type { Day, Goal, Project, Task } from "../../shared/types.ts";
import { useApp } from "../App.tsx";
import { Icon } from "../components/Icon.tsx";
import ScheduleGrid from "../components/ScheduleGrid.tsx";
import TaskModal, { draftFromTask, draftToPayload, type TaskDraft } from "../components/TaskModal.tsx";

interface DayPayload {
  day: Day;
  tasks: Task[];
  inbox: Task[];
  carryCount: number;
  goals: { id: number; title: string; progress: number }[];
}

function Checkbox({ checked, onClick, disabled }: { checked: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button className={`checkbox${checked ? " checked" : ""}`} onClick={onClick} disabled={disabled} aria-label="Toggle done">
      {checked ? <Icon name="check" /> : null}
    </button>
  );
}

export default function Today({ search }: { search: string }) {
  const { user, nav } = useApp();
  const date = new URLSearchParams(search).get("date") ?? todayStr();
  const isToday = date === todayStr();

  const [data, setData] = useState<DayPayload | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [quickTask, setQuickTask] = useState("");
  const [inboxText, setInboxText] = useState("");
  const [modal, setModal] = useState<TaskDraft | null>(null);
  const [reflectOpen, setReflectOpen] = useState(false);

  const load = useCallback(async () => {
    const payload = await api.get<DayPayload>(`/api/day?date=${date}`);
    setData(payload);
  }, [date]);

  useEffect(() => {
    load();
    api.get<{ goals: Goal[] }>("/api/goals").then((r) => setGoals(r.goals.filter((g) => g.status === "active")));
    api.get<{ projects: Project[] }>("/api/projects").then((r) => setProjects(r.projects.filter((p) => p.status === "active")));
  }, [load]);

  if (!data) return null;
  const { day, tasks, inbox, carryCount } = data;

  const saveDay = async (patch: Partial<Day>) => {
    setData((prev) => prev && { ...prev, day: { ...prev.day, ...patch } });
    await api.put(`/api/day/${date}`, patch);
  };

  const saveTask = async (id: number, patch: Partial<Task> & Record<string, unknown>) => {
    await api.put(`/api/tasks/${id}`, patch);
    await load();
  };

  const addQuickTask = async () => {
    if (!quickTask.trim()) return;
    await api.post("/api/tasks", { title: quickTask.trim(), date });
    setQuickTask("");
    await load();
  };

  const captureInbox = async () => {
    if (!inboxText.trim()) return;
    await api.post("/api/tasks", { title: inboxText.trim(), inbox: 1 });
    setInboxText("");
    await load();
  };

  const submitModal = async (d: TaskDraft) => {
    const payload = draftToPayload(d);
    if (d.id) await api.put(`/api/tasks/${d.id}`, payload);
    else await api.post("/api/tasks", payload);
    setModal(null);
    await load();
  };

  const deleteModalTask = async () => {
    if (modal?.id) await api.del(`/api/tasks/${modal.id}`);
    setModal(null);
    await load();
  };

  const carry = async (action: "forward" | "drop") => {
    await api.post("/api/carry", { date, action });
    await load();
  };

  const dateObj = new Date(date + "T00:00:00");
  const heading = dateObj.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "早安" : hour < 18 ? "午安" : "晚安";

  const unscheduled = tasks.filter((t) => t.start_min === null);
  const tops: [string, string, string, number][] = [
    ["top1", day.top1, "Outcome 1…", day.top1_done],
    ["top2", day.top2, "Outcome 2…", day.top2_done],
    ["top3", day.top3, "Outcome 3…", day.top3_done],
  ];

  return (
    <>
      <div className="today-head">
        <div>
          <p className="muted">{isToday ? `${greeting}，${user.name}` : "计划中 · Planning for"}</p>
          <h1 className="page-title">{heading}</h1>
        </div>
        <div className="day-nav">
          <button aria-label="Previous day" onClick={() => nav(`/today?date=${addDays(date, -1)}`)}><Icon name="left" /></button>
          <button aria-label="Next day" onClick={() => nav(`/today?date=${addDays(date, 1)}`)}><Icon name="right" /></button>
        </div>
      </div>

      {carryCount > 0 && (
        <div className="carry-banner">
          <strong>{carryCount} task{carryCount > 1 ? "s" : ""} from earlier days remain unfinished.</strong>
          <span>Would you like to bring them forward or let them go?</span>
          <span className="actions">
            <button onClick={() => carry("forward")}>Bring forward</button>
            <button onClick={() => carry("drop")}>Let them go</button>
          </span>
        </div>
      )}

      <div className="today-grid">
        <div className="today-col">
          <div className="card">
            <div className="card-label">今日心念 <i>Daily intention</i></div>
            <input
              className="intention-input"
              placeholder="Set an intention for the day…"
              defaultValue={day.intention}
              onBlur={(e) => e.target.value !== day.intention && saveDay({ intention: e.target.value })}
            />
          </div>

          <div className="card">
            <div className="card-label">今日三事 <i>Top three</i></div>
            {tops.map(([key, value, placeholder, done]) => (
              <div className="topthree-row" key={key}>
                <Checkbox checked={!!done} disabled={!value} onClick={() => saveDay({ [`${key}_done`]: done ? 0 : 1 } as Partial<Day>)} />
                <input
                  className={done ? "done-text" : ""}
                  placeholder={placeholder}
                  defaultValue={value}
                  onBlur={(e) => e.target.value !== value && saveDay({ [key]: e.target.value } as Partial<Day>)}
                />
              </div>
            ))}
            <p className="hint">三件事足矣，其余皆可等待。</p>
          </div>

          <div className="card">
            <div className="card-label">
              待办 <i>Tasks</i>
              <span className="spacer" />
              <button className="btn ghost small" onClick={() => setModal(draftFromTask({ date }))}>
                <Icon name="plus" /> Detailed
              </button>
            </div>
            <div className="task-add">
              <input
                className="input"
                placeholder="Add a task for this day…"
                value={quickTask}
                onChange={(e) => setQuickTask(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addQuickTask()}
              />
              <button className="btn small" onClick={addQuickTask} aria-label="Add task"><Icon name="plus" /></button>
            </div>
            {unscheduled.length === 0 && <p className="hint" style={{ textAlign: "center" }}>No unscheduled tasks. A clear list is a good sign.</p>}
            {unscheduled.map((t) => (
              <div className="task-row" key={t.id}>
                <Checkbox checked={!!t.done} onClick={() => saveTask(t.id, { done: t.done ? 0 : 1 })} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="task-title-line">
                    <span className={`title${t.done ? " done" : ""}`}>{t.title}</span>
                    {t.priority === "must" && <span className="chip amber">must</span>}
                  </div>
                  {(t.estimate_min || t.goal_id) && (
                    <div className="task-meta">
                      {t.estimate_min ? <span>{t.estimate_min} min</span> : null}
                      {t.goal_id ? <span>→ {goals.find((g) => g.id === t.goal_id)?.title ?? "goal"}</span> : null}
                    </div>
                  )}
                </div>
                <span className="task-actions">
                  <button className="icon-btn" onClick={() => setModal(draftFromTask(t))} aria-label="Edit"><Icon name="edit" /></button>
                  <button className="icon-btn" onClick={async () => { await api.del(`/api/tasks/${t.id}`); await load(); }} aria-label="Delete"><Icon name="trash" /></button>
                </span>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-label">
              <Icon name="inbox" /> 收集箱 <i>Inbox</i> {inbox.length > 0 && <span className="inbox-count">{inbox.length}</span>}
            </div>
            <p className="muted small" style={{ marginBottom: 10 }}>
              Catch everything here — ideas, requests, loose ends. Decide when to do them later.
            </p>
            <div className="task-add">
              <input
                className="input"
                placeholder="What's on your mind?"
                value={inboxText}
                onChange={(e) => setInboxText(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && captureInbox()}
              />
              <button className="btn small" disabled={!inboxText.trim()} onClick={captureInbox} aria-label="Capture to inbox"><Icon name="plus" /></button>
            </div>
            {inbox.map((t) => (
              <div className="task-row" key={t.id}>
                <Checkbox checked={false} onClick={() => saveTask(t.id, { done: 1 })} />
                <button style={{ flex: 1, textAlign: "left" }} onClick={() => setModal(draftFromTask({ ...t, date: "" }))}>
                  {t.title}
                </button>
              </div>
            ))}
          </div>

          <div className="card">
            <div className="card-label">
              目标进度 <i>Goal progress</i>
              <span className="spacer" />
              <a href="/goals" onClick={(e) => { e.preventDefault(); nav("/goals"); }} className="mini" style={{ fontWeight: 600 }}>All goals</a>
            </div>
            {data.goals.map((g) => (
              <div className="goal-progress-row" key={g.id}>
                <div className="line"><span>{g.title}</span><span className="muted">{g.progress}%</span></div>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${g.progress}%` }} /></div>
              </div>
            ))}
            {data.goals.length === 0 && <p className="hint">No active goals yet — set one on the Goals page.</p>}
          </div>
        </div>

        <div className="today-col">
          <div className="card schedule-card">
            <div className="card-label">
              时辰 <i>Schedule</i>
              <span className="spacer" />
              <span className="mini muted" style={{ textTransform: "none", letterSpacing: 0 }}>
                Drag to move · edge to resize · double-click to add
              </span>
            </div>
            <ScheduleGrid
              tasks={tasks}
              isToday={isToday}
              onCreate={(start, end) => setModal(draftFromTask({ date, start_min: start, end_min: end }))}
              onMove={(t, start, end) => saveTask(t.id, { start_min: start, end_min: end })}
              onOpen={(t) => setModal(draftFromTask(t))}
            />
          </div>

          <div className="card">
            <div className="card-label">日暮反思 <i>Daily reflection</i></div>
            {!reflectOpen && !day.reflection ? (
              <button className="reflection-btn" onClick={() => setReflectOpen(true)}>
                以几分钟安静的反思，为今天收笔
              </button>
            ) : (
              <div className="stack">
                <textarea
                  className="input ruled"
                  placeholder="今天什么推进了？什么受阻了？明天会怎么做？"
                  defaultValue={day.reflection}
                  rows={4}
                  onBlur={(e) => e.target.value !== day.reflection && saveDay({ reflection: e.target.value })}
                />
                {([["mood", "Mood"], ["energy", "Energy"], ["focus", "Focus"], ["satisfaction", "Satisfaction"]] as const).map(([key, label]) => (
                  <div className="rating-row" key={key}>
                    <span className="small">{label}</span>
                    <span className="rating-dots">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <button key={n} className={day[key] === n ? "on" : ""} onClick={() => saveDay({ [key]: day[key] === n ? null : n } as Partial<Day>)}>
                          {n}
                        </button>
                      ))}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {modal && (
        <TaskModal
          initial={modal}
          goals={goals}
          projects={projects}
          onSave={submitModal}
          onDelete={modal.id ? deleteModalTask : undefined}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}
