import { createContext, useContext, useEffect, useState } from "react";
import { api, usePath } from "./api.ts";
import type { User } from "../shared/types.ts";
import Landing from "./pages/Landing.tsx";
import AuthPage from "./pages/Auth.tsx";
import Today from "./pages/Today.tsx";
import Timeline from "./pages/Timeline.tsx";
import Goals from "./pages/Goals.tsx";
import Projects from "./pages/Projects.tsx";
import Reviews from "./pages/Reviews.tsx";
import Insights from "./pages/Insights.tsx";
import Guide from "./pages/Guide.tsx";
import Settings from "./pages/Settings.tsx";
import { Icon } from "./components/Icon.tsx";

interface Ctx {
  user: User;
  nav: (to: string) => void;
  refreshUser: () => Promise<void>;
}
const AppCtx = createContext<Ctx | null>(null);
export function useApp(): Ctx {
  const ctx = useContext(AppCtx);
  if (!ctx) throw new Error("useApp outside provider");
  return ctx;
}

const NAV_ITEMS: [string, string, string, string][] = [
  ["/today", "今日", "Today", "sun"],
  ["/timeline", "时间轴", "Timeline", "calendar"],
  ["/goals", "目标", "Goals", "target"],
  ["/projects", "项目", "Projects", "folder"],
  ["/reviews", "复盘", "Reviews", "review"],
  ["/insights", "洞察", "Insights", "chart"],
  ["/guide", "道引", "Guide", "compass"],
];

export default function App() {
  const [path, nav] = usePath();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = async () => {
    try {
      const { user } = await api.get<{ user: User }>("/api/me");
      setUser(user);
    } catch {
      setUser(null);
    }
  };

  useEffect(() => {
    refreshUser().finally(() => setLoading(false));
  }, []);

  const route = path.split("?")[0];

  if (loading) return null;

  if (route === "/login" || route === "/register") {
    if (user) { nav("/today"); return null; }
    return <AuthPage mode={route === "/login" ? "login" : "register"} nav={nav} onAuthed={async () => { await refreshUser(); nav("/today"); }} />;
  }

  if (route === "/" || !user) {
    if (route !== "/" && !user) { nav("/"); return null; }
    return <Landing nav={nav} authed={!!user} />;
  }

  const page = (() => {
    switch (route) {
      case "/today": return <Today key={path} search={path.split("?")[1] ?? ""} />;
      case "/timeline": return <Timeline key={path} search={path.split("?")[1] ?? ""} />;
      case "/goals": return <Goals />;
      case "/projects": return <Projects />;
      case "/reviews": return <Reviews />;
      case "/insights": return <Insights />;
      case "/guide": return <Guide />;
      case "/settings": return <Settings />;
      default: return <Today key={path} search="" />;
    }
  })();

  return (
    <AppCtx.Provider value={{ user, nav, refreshUser }}>
      <div className="shell">
        <aside className="sidebar">
          <a className="logo" href="/today" onClick={(e) => { e.preventDefault(); nav("/today"); }}>
            <span className="logo-mark">道</span>
            <span className="logo-name">Way</span>
          </a>
          <nav className="nav">
            {NAV_ITEMS.map(([to, zh, en, icon]) => (
              <a
                key={to}
                href={to}
                className={route === to ? "active" : ""}
                onClick={(e) => { e.preventDefault(); nav(to); }}
              >
                <Icon name={icon} />
                {zh}
                <i>{en}</i>
              </a>
            ))}
          </nav>
          <div className="sidebar-footer">
            <a href="/settings" onClick={(e) => { e.preventDefault(); nav("/settings"); }}>
              <Icon name="gear" />
              {user.name || "Settings"}
            </a>
          </div>
        </aside>
        <main className="main">{page}</main>
      </div>
    </AppCtx.Provider>
  );
}
