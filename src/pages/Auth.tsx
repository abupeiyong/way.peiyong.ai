import { useState } from "react";
import { api } from "../api.ts";

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

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "login") await api.post("/api/auth/login", { email, password });
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
          <div>
            <label className="field-label">Email</label>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          </div>
          <div>
            <label className="field-label">Password</label>
            <input className="input" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
          </div>
          <button className="btn" disabled={busy} type="submit">
            {mode === "login" ? "Sign in" : "Create account"}
          </button>
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
