import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Area } from "../../shared/types.ts";
import { useApp } from "../App.tsx";
import { Icon } from "../components/Icon.tsx";

export default function Settings() {
  const { user, nav, refreshUser } = useApp();
  const [name, setName] = useState(user.name);
  const [areas, setAreas] = useState<Area[]>([]);
  const [newArea, setNewArea] = useState("");
  const [refineOpen, setRefineOpen] = useState(false);
  const [directionDraft, setDirectionDraft] = useState("");
  const [savedNote, setSavedNote] = useState(false);

  const loadAreas = () => api.get<{ areas: Area[] }>("/api/goals").then((r) => setAreas(r.areas));
  useEffect(() => { loadAreas(); }, []);

  const saveProfile = async () => {
    await api.put("/api/me", { name });
    await refreshUser();
    setSavedNote(true);
    setTimeout(() => setSavedNote(false), 1600);
  };

  const saveDirection = async () => {
    await api.put("/api/me", { direction: directionDraft });
    await refreshUser();
    setRefineOpen(false);
  };

  const patchArea = async (id: number, patch: Partial<Area>) => {
    setAreas((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    await api.put(`/api/areas/${id}`, patch);
  };

  const addArea = async () => {
    if (!newArea.trim()) return;
    await api.post("/api/areas", { name: newArea.trim() });
    setNewArea("");
    await loadAreas();
  };

  const signOut = async () => {
    await api.post("/api/auth/logout");
    window.location.href = "/";
  };

  return (
    <div className="settings-stack">
      <h1 className="page-title">设置<i>Settings</i></h1>

      <div className="card">
        <div className="card-label">档案 <i>Profile</i> {savedNote && <span className="chip green">已存</span>}</div>
        <div className="stack">
          <div>
            <label className="field-label">Name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="field-label">Email</label>
            <input className="input" value={user.email} disabled style={{ opacity: 0.6 }} />
          </div>
          <div>
            <button className="btn" onClick={saveProfile}>Save profile</button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-label">
          方向 <i>Direction</i>
          <span className="spacer" />
          <button className="btn ghost small" onClick={() => { setDirectionDraft(user.direction); setRefineOpen(true); }}>Refine</button>
        </div>
        {refineOpen ? (
          <div className="stack">
            <textarea className="input" rows={3} value={directionDraft} onChange={(e) => setDirectionDraft(e.target.value)} />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost small" onClick={() => setRefineOpen(false)}>Cancel</button>
              <button className="btn small" onClick={saveDirection}>Save</button>
            </div>
          </div>
        ) : (
          <p className="direction-quote">{user.direction ? `“${user.direction}”` : "No direction set yet."}</p>
        )}
      </div>

      <div className="card">
        <div className="card-label">人生领域 <i>Life areas</i></div>
        <p className="muted small" style={{ marginBottom: 10 }}>
          The domains your goals live in. Archive what no longer serves you.
        </p>
        {areas.map((a) => (
          <div className="area-edit-row" key={a.id}>
            <input type="color" value={a.color} title="Area color"
                   onChange={(e) => patchArea(a.id, { color: e.target.value })} />
            <input className="input grow" defaultValue={a.name}
                   onBlur={(e) => e.target.value !== a.name && patchArea(a.id, { name: e.target.value })} />
            <select className="input" style={{ width: 130 }} value={a.satisfaction ?? ""}
                    title="Current satisfaction (1–10)"
                    onChange={(e) => patchArea(a.id, { satisfaction: e.target.value ? Number(e.target.value) : null })}>
              <option value="">Satisfaction</option>
              {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => <option key={n} value={n}>{n}/10</option>)}
            </select>
            <button className="btn ghost small" onClick={async () => { await patchArea(a.id, { archived: 1 }); await loadAreas(); }}>
              Archive
            </button>
          </div>
        ))}
        <div className="task-add" style={{ marginTop: 10 }}>
          <input className="input" placeholder="Add a life area…" value={newArea}
                 onChange={(e) => setNewArea(e.target.value)}
                 onKeyDown={(e) => e.key === "Enter" && addArea()} />
          <button className="btn small" onClick={addArea}><Icon name="plus" /> Add area</button>
        </div>
      </div>

      <div className="card">
        <div className="card-label">会话 <i>Session</i></div>
        <button className="btn ghost" onClick={signOut}>Sign out</button>
      </div>

      <p className="mini muted" style={{ textAlign: "center" }}>
        <a href="/" onClick={(e) => { e.preventDefault(); nav("/"); }}>About Way</a>
      </p>
    </div>
  );
}
