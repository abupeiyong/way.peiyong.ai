import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { QrCode } from "../components/QrCode.tsx";

declare global {
  interface Window { onTelegramAuth?: (user: Record<string, unknown>) => void }
}

/** Telegram's Login Widget (PRD §5.2(a)). The signed user object it hands back is posted to the server as-is. */
function TelegramLogin({ bot, onAuth }: { bot: string; onAuth: (user: Record<string, unknown>) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onAuthRef = useRef(onAuth);
  onAuthRef.current = onAuth;

  useEffect(() => {
    window.onTelegramAuth = (user) => onAuthRef.current(user);
    const script = document.createElement("script");
    script.async = true;
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-login", bot);
    script.setAttribute("data-size", "large");
    script.setAttribute("data-radius", "4");
    script.setAttribute("data-onauth", "onTelegramAuth(user)");
    const el = ref.current;
    el?.appendChild(script);
    return () => {
      if (el) el.innerHTML = "";
      delete window.onTelegramAuth;
    };
  }, [bot]);

  return <div ref={ref} className="auth-telegram-widget" />;
}

export default function AuthPage({ mode, nav, onAuthed }: {
  mode: "login" | "register";
  nav: (to: string) => void;
  onAuthed: () => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Sign in with a Telegram code (login only): enter email → code sent to the linked chat → enter code.
  const [viaTelegram, setViaTelegram] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const telegram = mode === "login" && viaTelegram;
  // Username of the bot behind the Login Widget; null = not configured, so no widget.
  const [widgetBot, setWidgetBot] = useState<string | null>(null);
  // Deep-link sign-in (PRD §5.2(b)): the pending request the page is polling, and how it ended.
  const [deep, setDeep] = useState<{ code: string; url: string; expires_in: number } | null>(null);
  const [deepState, setDeepState] = useState<"pending" | "denied" | "expired">("pending");

  const startDeepLink = async () => {
    setError("");
    try {
      setDeep(await api.post<{ code: string; url: string; expires_in: number }>("/api/auth/telegram/start"));
      setDeepState("pending");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    }
  };

  // Poll while the request is live; the approving tap in Telegram turns the next poll into a session.
  useEffect(() => {
    if (!deep || deepState !== "pending") return;
    const deadline = Date.now() + deep.expires_in * 1000;
    let stopped = false;
    const timer = setInterval(async () => {
      if (Date.now() > deadline) { setDeepState("expired"); return; }
      try {
        const r = await api.get<{ state: "pending" | "approved" | "denied" | "expired" }>(`/api/auth/telegram/poll?code=${deep.code}`);
        if (stopped || r.state === "pending") return;
        if (r.state === "approved") { setDeep(null); await onAuthed(); return; }
        setDeepState(r.state);
      } catch { /* retried on the next tick */ }
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [deep, deepState]);

  useEffect(() => {
    if (mode !== "login") return;
    api.get<{ bot: string | null }>("/api/auth/telegram/widget").then((r) => setWidgetBot(r.bot)).catch(() => {});
  }, [mode]);

  const widgetLogin = async (user: Record<string, unknown>) => {
    setBusy(true);
    setError("");
    try {
      await api.post("/api/auth/telegram/widget", user);
      await onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  const switchMethod = (toTelegram: boolean) => {
    setViaTelegram(toTelegram);
    setCodeSent(false);
    setCode("");
    setError("");
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (telegram && !codeSent) {
        await api.post("/api/auth/telegram/otp", { email });
        setCodeSent(true);
        return;
      }
      if (telegram) await api.post("/api/auth/telegram/verify", { code });
      else if (mode === "login") await api.post("/api/auth/login", { email, password });
      else await api.post("/api/auth/register", { email, password, name });
      await onAuthed();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-wrap">
      <div className="auth-box">
        <div className="auth-brand">
          <span className="logo-mark">歪</span>
          <h1>Way</h1>
          <p>Turn your direction into daily action.</p>
        </div>
        <form className="card auth-card" onSubmit={submit}>
          <h2>{mode === "login" ? "欢迎回来" : "启程"} <i style={{ fontFamily: "var(--serif-en)", fontStyle: "italic", fontWeight: 400, fontSize: "0.85rem", color: "var(--ink-faint)" }}>{mode === "login" ? "Welcome back" : "Begin your Way"}</i></h2>
          {error && <div className="auth-error">{error}</div>}
          {mode === "register" && (
            <div>
              <label className="field-label">Name</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="How should Way call you?" />
            </div>
          )}
          {telegram && codeSent ? (
            <>
              <p className="auth-note">
                If <b>{email}</b> is linked to Telegram, the Way bot has just sent you a 6-digit code. It works once, in this browser, for 5 minutes.
              </p>
              <div>
                <label className="field-label">Code</label>
                <input
                  className="input auth-code" required autoFocus inputMode="numeric" autoComplete="one-time-code"
                  pattern="\d{3} ?\d{3}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} placeholder="418 233"
                />
              </div>
            </>
          ) : (
            <div>
              <label className="field-label">Email</label>
              <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
          )}
          {!telegram && (
            <div>
              <label className="field-label">Password</label>
              <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
          )}
          <button className="btn" disabled={busy} type="submit">
            {mode === "register" ? "Create account" : telegram && !codeSent ? "Send code to Telegram" : "Sign in"}
          </button>
          {mode === "login" && widgetBot && (
            <div className="auth-telegram">
              <span className="auth-or">或 <i>or</i></span>
              <TelegramLogin bot={widgetBot} onAuth={widgetLogin} />
              {!deep ? (
                <button type="button" className="btn ghost small" onClick={startDeepLink}>在 Telegram 里确认登录 · Open Telegram to sign in</button>
              ) : deepState === "pending" ? (
                <div className="auth-deeplink">
                  <QrCode value={deep.url} label="Scan to sign in with Telegram" />
                  <div className="stack">
                    <p className="auth-note">用手机扫码，或在这台设备上打开 Telegram，点「是我，登录」。<br />Scan with your phone, or open Telegram here and tap “Yes, sign in”.</p>
                    <div className="row">
                      <a className="btn small" href={deep.url} target="_blank" rel="noreferrer">Open Telegram</a>
                      <button type="button" className="btn ghost small" onClick={() => setDeep(null)}>Cancel</button>
                    </div>
                    <p className="muted mini">等待确认… 五分钟内有效 · Waiting — valid for 5 minutes.</p>
                  </div>
                </div>
              ) : (
                <div className="stack">
                  <p className="small" style={{ color: "var(--red)" }}>
                    {deepState === "denied" ? "在 Telegram 里被拒绝了。 · Denied in Telegram." : "登录链接已过期。 · The sign-in link expired."}
                  </p>
                  <button type="button" className="btn ghost small" onClick={startDeepLink}>Try again</button>
                </div>
              )}
            </div>
          )}
          {mode === "login" && (
            <p className="auth-switch">
              {telegram && codeSent && (
                <><a href="#" onClick={(e) => { e.preventDefault(); switchMethod(true); }}>Use another email or resend</a> · </>
              )}
              <a href="#" onClick={(e) => { e.preventDefault(); switchMethod(!telegram); }}>
                {telegram ? "Use password instead" : "Telegram 验证码 · Sign in with a Telegram code"}
              </a>
            </p>
          )}
        </form>
        <p className="auth-alt">
          {mode === "login" ? (
            <>New to Way? <a href="/register" onClick={(e) => { e.preventDefault(); nav("/register"); }}>Create an account</a></>
          ) : (
            <>Already have an account? <a href="/login" onClick={(e) => { e.preventDefault(); nav("/login"); }}>Sign in</a></>
          )}
        </p>
      </div>
    </div>
  );
}
