import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type { Area, SecuritySettings, TelegramPrefs, TelegramSettings } from "../../shared/types.ts";
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
  // null = not loaded (or unavailable): the Security card stays hidden.
  const [security, setSecurity] = useState<SecuritySettings | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [securityError, setSecurityError] = useState("");

  // null = not loaded (or unavailable): the Telegram card stays hidden.
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [tgDraft, setTgDraft] = useState<TelegramPrefs & { timezone: string }>();
  const [tgNote, setTgNote] = useState("");
  const [tgError, setTgError] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false);

  const loadAreas = () => api.get<{ areas: Area[] }>("/api/goals").then((r) => setAreas(r.areas));
  useEffect(() => { loadAreas(); }, []);
  useEffect(() => {
    api.get<{ security: SecuritySettings }>("/api/security").then((r) => setSecurity(r.security)).catch(() => setSecurity(null));
  }, []);

  const loadTelegram = () =>
    api.get<{ telegram: TelegramSettings }>("/api/telegram")
      .then((r) => {
        setTelegram(r.telegram);
        setTgDraft({ ...r.telegram.prefs, timezone: r.telegram.timezone ?? "" });
      })
      .catch(() => setTelegram(null));
  useEffect(() => { loadTelegram(); }, []);

  const telegramAction = async (note: string, action: () => Promise<unknown>) => {
    setTgError("");
    setTgNote("");
    try {
      await action();
      setTgNote(note);
      setTimeout(() => setTgNote(""), 1600);
    } catch (err) {
      setTgError(err instanceof Error ? err.message : "Could not save.");
    }
  };

  const saveTelegram = () => telegramAction("已存", async () => {
    if (!tgDraft) return;
    const { timezone, ...prefs } = tgDraft;
    await api.put("/api/telegram/prefs", { ...prefs, timezone: timezone || null });
    await loadTelegram();
  });

  const sendTest = () => telegramAction("已发", async () => {
    await api.post("/api/telegram/test");
    await loadTelegram();
  });

  const unlinkTelegram = () => telegramAction("已断开", async () => {
    setConfirmUnlink(false);
    await api.del("/api/telegram");
    await loadTelegram();
  });

  const setPasswordLogin = async (disabled: boolean) => {
    setSecurityError("");
    try {
      await api.put("/api/security", { password_login_disabled: disabled });
      setSecurity((prev) => prev && { ...prev, password_login_disabled: disabled });
    } catch (err) {
      setSecurityError(err instanceof Error ? err.message : "Could not save.");
    }
    setConfirmDisable(false);
  };

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

      {telegram && tgDraft && (
        <div className="card">
          <div className="card-label">
            电报 <i>Telegram</i>
            {!telegram.linked ? <span className="chip">未连接 · Not connected</span>
              : telegram.disconnected ? <span className="chip red">已断开 · Disconnected</span>
              : <span className="chip green">已连接 · Connected</span>}
            {tgNote && <span className="chip green">{tgNote}</span>}
          </div>
          {!telegram.linked ? (
            <p className="muted small">
              {telegram.bot ? (
                <>
                  在 Telegram 打开 <a href={`https://t.me/${telegram.bot}`} target="_blank" rel="noreferrer">@{telegram.bot}</a> 连接你的账号。<br />
                  Open <a href={`https://t.me/${telegram.bot}`} target="_blank" rel="noreferrer">@{telegram.bot}</a> in Telegram to connect your account.
                </>
              ) : (
                <>Telegram 尚未配置。<br />Telegram is not configured on this server.</>
              )}
            </p>
          ) : (
            <div className="stack">
              <div className="spread">
                <span>{telegram.username ? `@${telegram.username}` : "Telegram account linked"}</span>
                <div className="row">
                  <button className="btn ghost small" onClick={sendTest}>Send me today's brief</button>
                  {confirmUnlink ? (
                    <>
                      <button className="btn ghost small" onClick={() => setConfirmUnlink(false)}>Cancel</button>
                      <button className="btn danger small" onClick={unlinkTelegram}>Disconnect</button>
                    </>
                  ) : (
                    <button className="btn ghost small" onClick={() => setConfirmUnlink(true)}>Disconnect</button>
                  )}
                </div>
              </div>
              {telegram.disconnected && (
                <p className="small" style={{ color: "var(--red)" }}>
                  已断开 —— 机器人被屏蔽了，不再发送消息。在 Telegram 解除屏蔽后点「Send me today's brief」恢复。<br />
                  Disconnected — the bot was blocked, so nothing is sent. Unblock it in Telegram, then send the brief to resume.
                </p>
              )}
              <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <label className="field-label">晨报 Morning brief</label>
                  <input className="input" type="time" value={tgDraft.morning_at ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, morning_at: e.target.value || null })} />
                </div>
                <div>
                  <label className="field-label">晚间复盘 Evening review</label>
                  <input className="input" type="time" value={tgDraft.review_at ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, review_at: e.target.value || null })} />
                </div>
              </div>
              <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <label className="field-label">免打扰 Quiet from</label>
                  <input className="input" type="time" value={tgDraft.quiet_from ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, quiet_from: e.target.value || null })} />
                </div>
                <div>
                  <label className="field-label">至 Until</label>
                  <input className="input" type="time" value={tgDraft.quiet_to ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, quiet_to: e.target.value || null })} />
                </div>
              </div>
              <div>
                <label className="field-label">时区 Time zone</label>
                <select className="input" value={tgDraft.timezone}
                        onChange={(e) => setTgDraft({ ...tgDraft, timezone: e.target.value })}>
                  <option value="">UTC (default)</option>
                  {timeZones(tgDraft.timezone).map((z) => <option key={z} value={z}>{z}</option>)}
                </select>
              </div>
              <label className="row small" style={{ cursor: "pointer" }}>
                <button type="button" className={`checkbox${tgDraft.nudges ? " checked" : ""}`} aria-label="Toggle nudges"
                        onClick={() => setTgDraft({ ...tgDraft, nudges: tgDraft.nudges ? 0 : 1 })}>
                  {tgDraft.nudges ? <Icon name="check" /> : null}
                </button>
                提醒 · Nudges during the day
              </label>
              <p className="muted mini">留空即关闭。Leave a time empty to turn it off.</p>
              <div>
                <button className="btn" onClick={saveTelegram}>Save Telegram settings</button>
              </div>
            </div>
          )}
          {tgError && <p className="small" style={{ color: "var(--red)", marginTop: 8 }}>{tgError}</p>}
        </div>
      )}

      {security && (
        <div className="card">
          <div className="card-label">
            安全 <i>Security</i>
            {security.password_login_disabled && <span className="chip red">仅 Telegram · Telegram only</span>}
          </div>
          {security.password_login_disabled ? (
            <div className="stack">
              <p className="muted small">
                邮箱 + 密码登录已关闭，只能用 Telegram 登录。<br />
                Email + password sign-in is off. Telegram is the only way in.
              </p>
              <div>
                <button className="btn ghost" onClick={() => setPasswordLogin(false)}>Re-enable email + password sign-in</button>
              </div>
            </div>
          ) : (
            <div className="stack">
              <p className="muted small">
                只用 Telegram 登录。密码不会被删除，随时可在已登录的会话里重新开启。<br />
                Make Telegram the only way in. Your password is kept; any signed-in session can turn it back on.
              </p>
              {!security.telegram_verified && (
                <p className="muted small">
                  需先用 Telegram 登录过一次。<br />
                  Available after you have signed in with Telegram at least once.
                </p>
              )}
              <div>
                <button className="btn danger" disabled={!security.telegram_verified} onClick={() => setConfirmDisable(true)}>
                  Disable email + password sign-in
                </button>
              </div>
            </div>
          )}
          {securityError && <p className="small" style={{ color: "var(--red)", marginTop: 8 }}>{securityError}</p>}
        </div>
      )}

      {confirmDisable && (
        <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setConfirmDisable(false); }}>
          <div className="modal" style={{ maxWidth: 480 }}>
            <div className="modal-head">
              <h3>关闭密码登录</h3>
              <button className="icon-btn" onClick={() => setConfirmDisable(false)}><Icon name="x" /></button>
            </div>
            <div className="stack">
              <p>如果你失去这个 Telegram 账号，你就失去了 Way。没有找回邮箱。</p>
              <p>If you lose access to this Telegram account, you lose access to Way. There is no recovery email.</p>
            </div>
            <div className="modal-actions">
              <div className="right">
                <button className="btn ghost" onClick={() => setConfirmDisable(false)}>Cancel</button>
                <button className="btn" onClick={() => setPasswordLogin(true)}>Disable password sign-in</button>
              </div>
            </div>
          </div>
        </div>
      )}

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

/** Every IANA zone the browser knows, plus `current` if it is not among them (and not empty). */
function timeZones(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}
