export default function Landing({ nav, authed }: { nav: (to: string) => void; authed: boolean }) {
  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); nav(to); };
  return (
    <div className="landing">
      <div className="landing-top">
        <div className="row">
          <span className="logo-mark">道</span>
          <span className="logo-name">Way</span>
        </div>
        <div className="links">
          {authed ? (
            <a className="btn" href="/today" onClick={go("/today")}>Open Way</a>
          ) : (
            <>
              <a href="/login" onClick={go("/login")} className="muted">Sign in</a>
              <a className="btn" href="/register" onClick={go("/register")}>Get started</a>
            </>
          )}
        </div>
      </div>

      <p className="hero-eyebrow">A personal life-planning system · 个人人生规划系统</p>
      <h1>找到自己的方向，把人生目标落实到每一天。</h1>
      <p className="hero-en">Turn your direction into daily action.</p>
      <p className="hero-body">
        Way is not another to-do list. It connects your life direction to yearly goals, weekly
        plans, and this hour's work — then helps you review honestly and adjust gently.
      </p>
      <p style={{ marginTop: 22 }}>
        <a className="btn" href="/register" onClick={go("/register")}>Begin your Way</a>
      </p>

      <p className="flow-line">Direction → Plan → Action → Reflection → Adjustment</p>

      <div className="landing-cards">
        <div className="card">
          <h3>Where am I going?</h3>
          <p className="muted small" style={{ marginTop: 6 }}>
            Define a direction — vision, values, identity — and let every goal serve it.
          </p>
        </div>
        <div className="card">
          <h3>What should I focus on now?</h3>
          <p className="muted small" style={{ marginTop: 6 }}>
            Three outcomes a day, arranged into calm time blocks. Everything else can wait.
          </p>
        </div>
        <div className="card">
          <h3>Am I actually moving?</h3>
          <p className="muted small" style={{ marginTop: 6 }}>
            Daily to yearly reviews and quiet insights — no guilt, no gamification.
          </p>
        </div>
      </div>

      <div className="card chain-card">
        {[
          ["Life direction:", "Become healthy and energetic"],
          ["Yearly goal:", "Reach 70 kg"],
          ["Quarterly goal:", "75 kg → 72 kg"],
          ["Weekly goal:", "Exercise four times"],
          ["Today:", "Swim 45 minutes"],
          ["19:00–19:45:", "Swimming"],
        ].map(([k, v]) => (
          <div className="chain-row" key={k}>
            <span className="chain-key">{k}</span>
            <span>{v}</span>
          </div>
        ))}
        <p className="muted small" style={{ marginTop: 12 }}>
          Every task answers: what larger goal does this serve?
        </p>
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h3>Way Guide — a calm strategist, not a taskmaster</h3>
        <p className="muted small" style={{ marginTop: 6 }}>
          The built-in AI clarifies vague ambitions into measurable goals, breaks them into
          quarters, months and weeks, and proposes realistic daily plans. It never changes
          anything without your approval.
        </p>
      </div>

      <div className="landing-footer">
        <span>Way — calm, focused, thoughtful.</span>
        <a href="/register" onClick={go("/register")} style={{ fontWeight: 600 }}>Start today</a>
      </div>
    </div>
  );
}
