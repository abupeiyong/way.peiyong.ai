import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";

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
