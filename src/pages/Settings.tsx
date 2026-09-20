import { useEffect, useState } from "react";
import { api } from "../api.ts";
import type {
  Area, SecuritySettings, TelegramLinkStart, TelegramLinkStatus, TelegramPrefs, TelegramSettings, TelegramStats,
} from "../../shared/types.ts";
import { useApp } from "../App.tsx";
import { Icon } from "../components/Icon.tsx";
import { QrCode } from "../components/QrCode.tsx";

export default function Settings() {
  const { user, nav, refreshUser } = useApp();
  const [name, setName] = useState(user.name);
  // "" = UTC (users.timezone NULL).
  const [timezone, setTimezone] = useState(user.timezone ?? "");
  const [areas, setAreas] = useState<Area[]>([]);
  const [newArea, setNewArea] = useState("");
  const [refineOpen, setRefineOpen] = useState(false);
  const [directionDraft, setDirectionDraft] = useState("");
  const [savedNote, setSavedNote] = useState(false);
  const [profileError, setProfileError] = useState("");
  // null = not loaded (or unavailable): the Security card stays hidden.
  const [security, setSecurity] = useState<SecuritySettings | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [securityError, setSecurityError] = useState("");

  // null = not loaded (or unavailable): the Telegram card stays hidden.
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null);
  const [tgDraft, setTgDraft] = useState<TelegramPrefs>();
  const [tgNote, setTgNote] = useState("");
  const [tgError, setTgError] = useState("");
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  // The link in progress (deep link + QR) and where the bot says it stands.
  const [link, setLink] = useState<TelegramLinkStart | null>(null);
  const [linkState, setLinkState] = useState<TelegramLinkStatus["state"]>("pending");
  // Last 28 days of delivery/engagement numbers (PRD §14); null until the account is linked.
  const [stats, setStats] = useState<TelegramStats | null>(null);

  // The "use this browser's zone" banner can change it while this page is open.
  useEffect(() => { setTimezone(user.timezone ?? ""); }, [user.timezone]);

  const loadAreas = () => api.get<{ areas: Area[] }>("/api/goals").then((r) => setAreas(r.areas));
  useEffect(() => { loadAreas(); }, []);
  useEffect(() => {
    api.get<{ security: SecuritySettings }>("/api/security").then((r) => setSecurity(r.security)).catch(() => setSecurity(null));
  }, []);

  const loadTelegram = () =>
    api.get<{ telegram: TelegramSettings }>("/api/telegram")
      .then((r) => {
        setTelegram(r.telegram);
        setTgDraft(r.telegram.prefs);
        if (r.telegram.linked) api.get<{ stats: TelegramStats }>("/api/telegram/stats").then((x) => setStats(x.stats)).catch(() => setStats(null));
        else setStats(null);
      })
      .catch(() => setTelegram(null));
  useEffect(() => { loadTelegram(); }, []);

  const startLink = () => telegramAction("", async () => {
    setLink(await api.post<TelegramLinkStart>("/api/telegram/link/start"));
    setLinkState("pending");
  });

  // Poll while the nonce is live; once the bot has linked it, reload so the card flips to "Connected".
  useEffect(() => {
    if (!link || linkState !== "pending") return;
    const deadline = Date.now() + link.expires_in * 1000;
    let stopped = false;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) {
        setLinkState("expired");
        return;
      }
      try {
        const status = await api.get<TelegramLinkStatus>(`/api/telegram/link/status?code=${link.code}`);
        if (stopped || status.state === "pending") return;
        setLinkState(status.state);
        if (status.state === "linked") {
          setLink(null);
          await loadTelegram();
          setTgNote("已连接");
          setTimeout(() => setTgNote(""), 1600);
        }
      } catch { /* a missed poll is retried on the next tick */ }
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [link, linkState]);

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
    await api.put("/api/telegram/prefs", tgDraft);
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
    setProfileError("");
    try {
      await api.put("/api/me", { name, timezone: timezone || null });
    } catch (err) {
      setProfileError(err instanceof Error ? err.message : "Could not save.");
      return;
    }
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
            <input className="input" value={user.telegram_only ? "— Telegram 账号 · Telegram-only account" : user.email} disabled style={{ opacity: 0.6 }} />
          </div>
          <div>
            <label className="field-label">时区 Time zone</label>
            <select className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              <option value="">UTC (default)</option>
              {timeZones(timezone).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <p className="muted mini" style={{ marginTop: 4 }}>
              决定「今天」从何时开始，以及复盘与提醒的时间。Sets when “today” begins for reviews, insights, the Guide and reminders.
            </p>
          </div>
          <div>
            <button className="btn" onClick={saveProfile}>Save profile</button>
          </div>
          {profileError && <p className="small" style={{ color: "var(--red)" }}>{profileError}</p>}
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
            !telegram.bot ? (
              <p className="muted small">Telegram 尚未配置。<br />Telegram is not configured on this server.</p>
            ) : !link ? (
              <div className="stack">
                <p className="muted small">
                  连接 Telegram，每天早上收晨报，晚上复盘，随手记进 Inbox。<br />
                  Connect Telegram for a morning brief, an evening review, and capture from anywhere.
                </p>
                <div>
                  <button className="btn" onClick={startLink}>Connect Telegram</button>
                </div>
              </div>
            ) : linkState === "pending" ? (
              <div className="tg-link">
                <QrCode value={link.qr} label="Scan to connect Telegram" />
                <div className="stack">
                  <p className="muted small">
                    用手机扫码，或在这台设备上打开 Telegram，点「Start」。<br />
                    Scan with your phone, or open Telegram on this device and tap Start.
                  </p>
                  <div className="row">
                    <a className="btn" href={link.url} target="_blank" rel="noreferrer">Open in Telegram</a>
                    <button className="btn ghost small" onClick={() => setLink(null)}>Cancel</button>
                  </div>
                  <p className="muted mini">等待连接… 五分钟内有效。Waiting — the link works for 5 minutes.</p>
                </div>
              </div>
            ) : (
              <div className="stack">
                <p className="small" style={{ color: "var(--red)" }}>
                  {linkState === "refused" ? (
                    <>这个 Telegram 账号已连接了另一个 Way 账号。<br />That Telegram account is already linked to another Way account.</>
                  ) : (
                    <>连接已过期。<br />The link expired before Telegram opened it.</>
                  )}
                </p>
                <div>
                  <button className="btn" onClick={startLink}>Try again</button>
                </div>
              </div>
            )
          ) : (
            <div className="stack">
              <div className="spread">
                <span>{telegram.username ? `Connected as @${telegram.username}` : "Telegram account linked"}</span>
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
                  <label className="field-label">周一计划 Monday plan</label>
                  <input className="input" type="time" value={tgDraft.weekly_plan_at ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, weekly_plan_at: e.target.value || null })} />
                </div>
                <div>
                  <label className="field-label">周日复盘 Sunday review</label>
                  <input className="input" type="time" value={tgDraft.weekly_review_at ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, weekly_review_at: e.target.value || null })} />
                </div>
                <div>
                  <label className="field-label">月初领域打分 Monthly check-in</label>
                  <input className="input" type="time" value={tgDraft.checkin_at ?? ""}
                         onChange={(e) => setTgDraft({ ...tgDraft, checkin_at: e.target.value || null })} />
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
              {quietSwallows(tgDraft) && (
                <p className="small" style={{ color: "var(--red)" }}>
                  免打扰时段盖住了{quietSwallows(tgDraft)}，那条消息将永远不会发出。<br />
                  Quiet hours cover {quietSwallows(tgDraft)} — that message would never be sent.
                </p>
              )}
              <label className="row small" style={{ cursor: "pointer" }}>
                <button type="button" className={`checkbox${tgDraft.nudges ? " checked" : ""}`} aria-label="Toggle nudges"
                        onClick={() => setTgDraft({ ...tgDraft, nudges: tgDraft.nudges ? 0 : 1 })}>
                  {tgDraft.nudges ? <Icon name="check" /> : null}
                </button>
                中午提醒 · Midday nudge when the top three is still empty (11:00)
              </label>
              {telegram.body_plan && (
                <>
                  <div className="field-label">身体 · Body（PRD-body §6）</div>
                  <div className="row" style={{ flexWrap: "wrap", alignItems: "flex-end" }}>
                    <div>
                      <label className="field-label">称重 Weigh-in</label>
                      <input className="input" type="time" value={tgDraft.weigh_at ?? ""}
                             onChange={(e) => setTgDraft({ ...tgDraft, weigh_at: e.target.value || null })} />
                    </div>
                    <div>
                      <label className="field-label">早饭 Breakfast</label>
                      <input className="input" type="time" value={tgDraft.breakfast_at ?? ""}
                             onChange={(e) => setTgDraft({ ...tgDraft, breakfast_at: e.target.value || null })} />
                    </div>
                    <div>
                      <label className="field-label">午饭 Lunch</label>
                      <input className="input" type="time" value={tgDraft.lunch_at ?? ""}
                             onChange={(e) => setTgDraft({ ...tgDraft, lunch_at: e.target.value || null })} />
                    </div>
                    <div>
                      <label className="field-label">晚饭 Dinner</label>
                      <input className="input" type="time" value={tgDraft.dinner_at ?? ""}
                             onChange={(e) => setTgDraft({ ...tgDraft, dinner_at: e.target.value || null })} />
                    </div>
                    <div>
                      <label className="field-label">运动 Workout</label>
                      <input className="input" type="time" value={tgDraft.workout_at ?? ""}
                             onChange={(e) => setTgDraft({ ...tgDraft, workout_at: e.target.value || null })} />
                    </div>
                    <div>
                      <label className="field-label">月初小结 Monthly body</label>
                      <input className="input" type="time" value={tgDraft.body_month_at ?? ""}
                             onChange={(e) => setTgDraft({ ...tgDraft, body_month_at: e.target.value || null })} />
                    </div>
                  </div>
                  <label className="row small" style={{ cursor: "pointer" }}>
                    <button type="button" className={`checkbox${tgDraft.body_nudges ? " checked" : ""}`} aria-label="Toggle body nudges"
                            onClick={() => setTgDraft({ ...tgDraft, body_nudges: tgDraft.body_nudges ? 0 : 1 })}>
                      {tgDraft.body_nudges ? <Icon name="check" /> : null}
                    </button>
                    身体提醒 · One nudge at 12:00, only when something is missing
                  </label>
                </>
              )}
              <label className="row small" style={{ cursor: "pointer" }}>
                <button type="button" className={`checkbox${tgDraft.block_reminders ? " checked" : ""}`} aria-label="Toggle block reminders"
                        onClick={() => setTgDraft({ ...tgDraft, block_reminders: tgDraft.block_reminders ? 0 : 1 })}>
                  {tgDraft.block_reminders ? <Icon name="check" /> : null}
                </button>
                时间块提醒 · A reminder 5 minutes before each scheduled block
              </label>
              <label className="row small" style={{ cursor: "pointer" }}>
                <button type="button" className={`checkbox${tgDraft.streaks ? " checked" : ""}`} aria-label="Toggle streaks"
                        onClick={() => setTgDraft({ ...tgDraft, streaks: tgDraft.streaks ? 0 : 1 })}>
                  {tgDraft.streaks ? <Icon name="check" /> : null}
                </button>
                连续天数 · Show the review streak in the Sunday recap
              </label>
              <p className="muted mini">
                留空即关闭。时间按档案里的时区（{user.timezone || "UTC"}）。<br />
                Leave a time empty to turn it off. Times are in your profile time zone ({user.timezone || "UTC"}).
              </p>
              <div>
                <button className="btn" onClick={saveTelegram}>Save Telegram settings</button>
              </div>
              {stats && (
                <div className="tg-stats">
                  <div className="field-label">最近 {stats.days} 天 · Last {stats.days} days</div>
                  <table className="tg-stats-table">
                    <tbody>
                      {stats.kinds.map((k) => (
                        <tr key={k.kind}>
                          <td>{KIND_LABELS[k.kind] ?? k.kind}</td>
                          <td>{k.sent} 发 · sent</td>
                          <td>{k.replied} 回 · replied</td>
                          <td>{k.reply_rate === null ? "—" : `${Math.round(k.reply_rate * 100)}%`}</td>
                        </tr>
                      ))}
                      <tr><td>闭环天数 · Loop days</td><td colSpan={3}>{stats.loop_days} / {stats.days}（三件事 + 复盘 · top three + review）</td></tr>
                      <tr><td>收集 · Captured</td><td colSpan={3}>{stats.captured} Telegram · {stats.web_captured} web</td></tr>
                      {(stats.blocked || stats.rate_limited || stats.errors) ? (
                        <tr><td>投递 · Delivery</td><td colSpan={3}>{stats.blocked} blocked · {stats.rate_limited} rate-limited · {stats.errors} errors</td></tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              )}
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

const KIND_LABELS: Record<string, string> = {
  morning: "晨报 Morning", review_prompt: "晚间复盘 Evening review", weekly_plan: "周一计划 Monday plan",
  weekly_review: "周日复盘 Sunday review", midday_nudge: "中午提醒 Nudge", area_checkin: "领域打分 Check-in", block: "时间块 Blocks",
  weigh_in: "称重 Weigh-in", meal_breakfast: "早饭 Breakfast", meal_lunch: "午饭 Lunch", meal_dinner: "晚饭 Dinner",
  workout_check: "运动 Workout", body_nudge: "身体提醒 Body nudge", body_recap: "本周身体 Body recap",
};

/** The scheduled message quiet hours would swallow, or "" — the scheduler skips every kind inside them. */
function quietSwallows(p: TelegramPrefs): string {
  const min = (v: string | null) => (v && /^\d{2}:\d{2}$/.test(v) ? Number(v.slice(0, 2)) * 60 + Number(v.slice(3)) : null);
  const f = min(p.quiet_from), t = min(p.quiet_to);
  if (f === null || t === null || f === t) return "";
  const inside = (m: number) => (f < t ? m >= f && m < t : m >= f || m < t);
  const slots: [string, string | null][] = [["晨报 morning", p.morning_at], ["晚间复盘 evening review", p.review_at],
    ["周一计划 Monday plan", p.weekly_plan_at], ["周日复盘 Sunday review", p.weekly_review_at], ["月初打分 check-in", p.checkin_at]];
  return slots.filter(([, v]) => { const m = min(v); return m !== null && inside(m); }).map(([n]) => n).join("、");
}

/** Every IANA zone the browser knows, plus `current` if it is not among them (and not empty). */
function timeZones(current: string): string[] {
  const zones = Intl.supportedValuesOf("timeZone");
  return current && !zones.includes(current) ? [current, ...zones] : zones;
}
