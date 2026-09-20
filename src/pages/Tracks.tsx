import { useEffect, useMemo, useState } from "react";
import { api, todayStr } from "../api.ts";
import type { Tracker } from "../../shared/types.ts";
import {
  PERIOD_LABEL, VERDICT_TEXT, fmtTotal, fmtValue, isNumeric,
} from "../../shared/streams.ts";
import { Icon } from "../components/Icon.tsx";

/**
 * 追踪 · Tracks (docs/PRD-brain.md §14): the dashboard is *generated* — one card per tracker, drawn by
 * a view primitive chosen from the stream's shape and its goal's kind. Nothing here knows what reading,
 * weight or meditation are, so a tracker the conversation provisioned needs no code for its card.
 */
export default function Tracks() {
  const [data, setData] = useState<{ today: string; trackers: Tracker[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = () => api.get<{ today: string; trackers: Tracker[] }>("/api/tracks")
    .then(setData).catch((e) => setError(e instanceof Error ? e.message : "Could not load."));
  useEffect(() => { load(); }, []);

  const log = async (id: number, value: string, date: string) => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.post(`/api/tracks/${id}/log`, { value, date });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not log.");
    } finally {
      setBusy(false);
    }
  };

  const retire = async (id: number) => {
    await api.del(`/api/tracks/${id}`).catch(() => {});
    await load();
  };

  if (!data) return <div className="settings-stack"><h1 className="page-title">追踪<i>Tracks</i></h1></div>;

  return (
    <div className="settings-stack">
      <h1 className="page-title">追踪<i>Tracks</i></h1>
      {error && <p className="small" style={{ color: "var(--red)" }}>{error}</p>}

      {!data.trackers.length ? (
        <div className="card">
          <p className="muted small">
            还没有追踪。跟道引说一句你想记什么，比如「我想每周读书 10 小时」，它会提议建一个，你点同意就好。<br />
            No trackers yet. Tell the Guide what you want to track — it proposes one, you approve it.
          </p>
        </div>
      ) : (
        data.trackers.map((t) => (
          <TrackerCard key={t.stream.id} t={t} today={data.today} onLog={log} onRetire={retire} busy={busy} />
        ))
      )}
    </div>
  );
}

function TrackerCard({ t, today, onLog, onRetire, busy }: {
  t: Tracker; today: string; busy: boolean;
  onLog: (id: number, value: string, date: string) => Promise<void>;
  onRetire: (id: number) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [date, setDate] = useState(today);
  const [confirmRetire, setConfirmRetire] = useState(false);
  const s = t.stream;
  const period = t.goal?.period ?? "week";

  const submit = async () => { await onLog(s.id, value, date); setValue(""); };

  return (
    <div className="card">
      <div className="card-label">
        {s.name}
        {s.ask_at && <span className="chip">{s.ask_at}</span>}
        {t.status && <span className={`chip${verdictTone(t.status.verdict)}`}>{VERDICT_TEXT[t.status.verdict].split(" · ")[0]}</span>}
      </div>

      {t.goal && t.status && (
        <p className="small" style={{ marginBottom: 8 }}>
          {t.goal.kind === "accumulate" ? (
            <>
              {PERIOD_LABEL[period].split(" ")[0]} {fmtTotal(s.shape, s.unit, t.status.current ?? 0)} / {fmtTotal(s.shape, s.unit, t.goal.target)}
              {t.status.days_left !== undefined && <span className="muted"> · 还剩 {t.status.days_left} 天</span>}
            </>
          ) : (
            <>
              {fmtValue(s.shape, s.unit, t.status.current)} → {fmtValue(s.shape, s.unit, t.goal.target)}
              {t.status.projected_date && <span className="muted"> · 预计 {t.status.projected_date}</span>}
            </>
          )}
        </p>
      )}

      {t.goal?.kind === "accumulate"
        ? <PeriodBars t={t} today={today} />
        : isNumeric(s.shape) && <LineChart t={t} />}

      <div className="task-add" style={{ marginTop: 10 }}>
        <input className="input" type="date" value={date} max={today} onChange={(e) => setDate(e.target.value)} style={{ width: 150 }} />
        <input
          className="input" placeholder={placeholderFor(s.shape, s.unit)} value={value}
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <button className="btn small" disabled={busy || !value.trim()} onClick={submit}><Icon name="plus" /> 记一笔</button>
      </div>

      <div className="row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <span className="muted mini">
          {s.aliases.length > 1 && <>在 Telegram 里直接说「{s.aliases[1]} 30」也行 · </>}
          {t.latest ? `最近 ${fmtValue(s.shape, s.unit, t.latest.num, t.latest.text)}（${t.latest.at}）` : "还没有记录"}
        </span>
        {confirmRetire ? (
          <span className="row">
            <button className="btn ghost small" onClick={() => setConfirmRetire(false)}>Cancel</button>
            <button className="btn danger small" onClick={() => onRetire(s.id)}>停用 · Retire</button>
          </span>
        ) : (
          <button className="btn ghost small" onClick={() => setConfirmRetire(true)}>停用</button>
        )}
      </div>
    </div>
  );
}

function verdictTone(v: string): string {
  if (v === "ahead" || v === "on_pace" || v === "on_track") return " green";
  if (v === "behind" || v === "unreachable" || v === "wrong_way") return " red";
  return "";
}

function placeholderFor(shape: string, unit: string | null): string {
  if (shape === "duration") return "45 或 1小时";
  if (shape === "bool") return "做了 / 没有";
  if (shape === "text") return "写点什么…";
  return unit ? `数值（${unit}）` : "数值";
}

const W = 320, H = 96, PAD = 6;

/** Per-period totals against the target — the view for an `accumulate` goal. */
function PeriodBars({ t, today }: { t: Tracker; today: string }) {
  const bars = useMemo(() => {
    const period = t.goal?.period ?? "week";
    const obs = t.observations ?? [];
    const out: { start: string; total: number }[] = [];
    let start = periodStart(period, today);
    for (let i = 0; i < 8; i++) {
      const end = periodEnd(period, start);
      out.unshift({ start, total: obs.reduce((n, o) => (o.at >= start && o.at <= end ? n + (o.num ?? 0) : n), 0) });
      start = periodStart(period, shift(start, -1));
    }
    return out;
  }, [t, today]);

  const target = t.goal?.target ?? 0;
  const max = Math.max(target, ...bars.map((b) => b.total), 1);
  const bw = (W - PAD * 2) / bars.length;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);

  return (
    <svg className="track-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="每周期合计">
      {target > 0 && (
        <line x1={PAD} x2={W - PAD} y1={y(target)} y2={y(target)} stroke="var(--red)" strokeWidth="1.2" strokeDasharray="4 4" opacity="0.8" />
      )}
      {bars.map((b, i) => {
        const h = Math.max(1, H - PAD - y(b.total));
        return (
          <rect key={b.start} x={PAD + i * bw + bw * 0.18} y={y(b.total)} width={bw * 0.64} height={h} rx="1.5"
                fill={b.total >= target && target > 0 ? "var(--red)" : "var(--ink-faint)"}
                opacity={i === bars.length - 1 ? 1 : 0.75}>
            <title>{`${b.start} · ${Math.round(b.total * 10) / 10}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** Readings and their 7-day trend — the view for a `reach` goal, or for a stream with no goal. */
function LineChart({ t }: { t: Tracker }) {
  const pts = (t.observations ?? []).filter((o) => o.num !== null) as { at: string; num: number }[];
  if (pts.length < 2) return <p className="muted mini">再记几次就有图了 · a couple more and there's a chart</p>;
  const xs = pts.map((p) => Date.parse(p.at));
  const lo = Math.min(...xs), hi = Math.max(...xs);
  const vs = pts.map((p) => p.num);
  const target = t.goal?.target;
  const vLo = Math.min(...vs, target ?? Infinity), vHi = Math.max(...vs, target ?? -Infinity);
  const span = vHi - vLo || 1;
  const x = (at: string) => PAD + ((Date.parse(at) - lo) / (hi - lo || 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - vLo) / span) * (H - PAD * 2);
  const trend = pts.map((p, i) => {
    const from = Math.max(0, i - 6);
    const w = pts.slice(from, i + 1);
    return { at: p.at, v: w.reduce((n, q) => n + q.num, 0) / w.length };
  });
  const path = trend.map((p, i) => `${i ? "L" : "M"}${x(p.at).toFixed(1)} ${y(p.v).toFixed(1)}`).join("");

  return (
    <svg className="track-chart" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="趋势">
      {target !== undefined && (
        <line x1={PAD} x2={W - PAD} y1={y(target)} y2={y(target)} stroke="var(--red)" strokeWidth="1.2" strokeDasharray="4 4" opacity="0.8" />
      )}
      <path d={path} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      {pts.map((p) => (
        <circle key={p.at} cx={x(p.at)} cy={y(p.num)} r="2.2" fill="var(--ink-faint)">
          <title>{`${p.at} · ${p.num}`}</title>
        </circle>
      ))}
    </svg>
  );
}

// Calendar helpers, kept local so the page has no worker imports.
function shift(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function periodStart(period: string, date: string): string {
  if (period === "day") return date;
  if (period === "month") return date.slice(0, 7) + "-01";
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function periodEnd(period: string, start: string): string {
  if (period === "day") return start;
  if (period === "month") {
    const d = new Date(start + "T00:00:00Z");
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  }
  return shift(start, 6);
}

export { todayStr };
