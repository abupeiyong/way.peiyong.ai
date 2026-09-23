// 身体 · Body (docs/PRD-body.md §10): the weight chart, manual entry and the plan summary.
// Every number shown here comes from GET /api/body — the same BodySummary the bot's /body prints —
// so the projected date on the page and the one in Telegram can never disagree. The chart is inline
// SVG on the design tokens: readings as dots, the 7-day trend as a line, the target flat, the
// projection dashed to the projected date.

import { useEffect, useState } from "react";
import { api, ApiError, addDays, todayStr } from "../api.ts";
import type { BodyMonthReport, BodySummary, WeightLog } from "../../shared/types.ts";
import { BODY_VERDICT_TEXT, WEIGHT_UNIT_LABELS, isWeightUnit, type WeightUnit } from "../../shared/body.ts";
import { useApp } from "../App.tsx";
import { Icon } from "../components/Icon.tsx";

interface Payload {
  today: string;
  summary: BodySummary | null;
  weights: WeightLog[];
  /** The 7-day trend at each weigh-in's date, computed server-side; parallel to `weights`. */
  trend: (number | null)[];
  /** The active goal that looks like a weight goal, when no plan is attached yet. */
  suggested: string | null;
  /** The month so far — the same report the bot sends on the 1st (PRD-body §13 item 11). */
  month: BodyMonthReport | null;
  /** YYYY-MM of the first weigh-in: how far back the 本月 card may be paged. */
  first_month: string | null;
}

interface Point { date: string; kg: number; trend: number | null }

const RANGES: [string, string, number | null][] = [
  ["30 天", "30 days", 30],
  ["90 天", "90 days", 90],
  ["全部", "All", null],
];

const kg1 = (n: number) => n.toFixed(1);
const dayNum = (date: string) => Math.round(Date.parse(date + "T00:00:00Z") / 86400000);
const shortDate = (date: string) =>
  new Date(date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });

/** "提前 · ahead of the target date" → the two halves, so the page can set them in the two faces. */
function verdictParts(summary: BodySummary): [string, string] {
  const [zh, en] = BODY_VERDICT_TEXT[summary.verdict].split(" · ");
  return [zh, en ?? ""];
}

export default function Body() {
  const { nav } = useApp();
  const [data, setData] = useState<Payload | null>(null);
  const [days, setDays] = useState<number | null>(90);
  const [date, setDate] = useState(todayStr());
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<WeightUnit>("kg");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const load = async () => {
    const payload = await api.get<Payload>("/api/body");
    setData(payload);
    // The plan's input unit is a display/parsing hint; the form starts there and stores kg either way.
    if (payload.summary && isWeightUnit(payload.summary.plan.input_unit)) setUnit(payload.summary.plan.input_unit);
  };
  useEffect(() => { load(); }, []);
  if (!data) return null;

  const { summary } = data;
  const points: Point[] = data.weights.map((w, i) => ({ date: w.date, kg: w.kg, trend: data.trend[i] ?? null }));
  const from = days === null ? null : addDays(data.today, -(days - 1));
  const shown = from ? points.filter((p) => p.date >= from) : points;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      await api.post("/api/body/weight", { date, value: Number(value), unit });
      setValue("");
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "没能保存 · Could not save");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (d: string) => {
    await api.del(`/api/body/weight/${d}`);
    await load();
  };

  return (
    <>
      <h1 className="page-title">身体<i>Body</i></h1>
      <p className="page-sub">秤上的数字每天在跳，七日均值才是实话。</p>

      {!summary && (
        <div className="card" style={{ marginTop: 18 }}>
          <div className="card-label">还没有身体计划 <i>No body plan yet</i></div>
          <p className="small" style={{ color: "var(--ink-soft)", marginTop: 4 }}>
            {data.suggested
              ? <>「{data.suggested}」看起来是个体重目标 · This goal looks like a weight goal. 在目标页给它加上身体计划，这里就会有趋势和预计达成日。</>
              : <>给一个体重目标加上身体计划（起点、目标、每周运动），这里就会有趋势和预计达成日 · Attach a body plan to a weight goal to see the trend and the projection.</>}
          </p>
          <button className="btn" style={{ marginTop: 12 }} onClick={() => nav("/goals")}>去目标页 · Goals</button>
        </div>
      )}

      {summary && <PlanCard summary={summary} onEdit={() => nav("/goals")} />}

      {summary && data.month && (
        <MonthCard thisMonth={data.month} today={data.today} firstMonth={data.first_month} />
      )}

      <div className="card" style={{ marginTop: 22 }}>
        <div className="card-label">
          体重曲线 <i>Weight</i>
          <span className="spacer" />
          <span className="filter-row" style={{ margin: 0 }}>
            {RANGES.map(([zh, en, n]) => (
              <button key={en} className={days === n ? "on" : ""} onClick={() => setDays(n)}>
                {zh} <i style={{ fontFamily: "var(--serif-en)", fontStyle: "italic" }}>{en}</i>
              </button>
            ))}
          </span>
        </div>
        {shown.length < 2
          ? <p className="empty-note">称两次以上，曲线就出来了 · Two weigh-ins are enough to draw the trend.</p>
          : <WeightChart points={shown} summary={summary} today={data.today} />}
      </div>

      <div className="insights-grid">
        <div className="card">
          <div className="card-label">记一次体重 <i>Log a weigh-in</i></div>
          <form className="row" style={{ flexWrap: "wrap", marginTop: 4 }} onSubmit={save}>
            <input className="input" type="date" value={date} max={data.today} onChange={(e) => setDate(e.target.value)} style={{ width: 160 }} />
            <input
              className="input" type="number" step="0.1" min="1" required placeholder="72.4"
              value={value} onChange={(e) => setValue(e.target.value)} style={{ width: 100 }}
            />
            <select className="input" value={unit} onChange={(e) => setUnit(e.target.value as WeightUnit)} style={{ width: 82 }}>
              {(Object.keys(WEIGHT_UNIT_LABELS) as WeightUnit[]).map((u) => (
                <option key={u} value={u}>{WEIGHT_UNIT_LABELS[u]}</option>
              ))}
            </select>
            <button className="btn" type="submit" disabled={saving || !value}>记下 · Log</button>
          </form>
          <p className="hint">一天一个读数，同一天再记就覆盖 · One reading per day; logging again replaces it.</p>
          {error && <p className="hint" style={{ color: "var(--red-deep)" }}>{error}</p>}
        </div>

        <div className="card">
          <div className="card-label">最近的称重 <i>Recent weigh-ins</i></div>
          {points.length === 0 && <p className="empty-note">还没有称重记录 · No weigh-ins yet.</p>}
          {[...points].reverse().slice(0, 12).map((p) => (
            <div className="weigh-row" key={p.date}>
              <span className="d">{shortDate(p.date)}</span>
              <span className="kg">{kg1(p.kg)} kg</span>
              <span className="muted mini">{p.trend === null ? "" : `7日均 ${kg1(p.trend)}`}</span>
              <button className="icon-btn" title="删除 · Delete" onClick={() => remove(p.date)}><Icon name="trash" /></button>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const delta = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}`;

/** 2026-08 shifted by n months. */
function shiftMonth(month: string, n: number): string {
  const d = new Date(month + "-01T00:00:00Z");
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 7);
}

const monthName = (month: string) =>
  new Date(month + "-01T00:00:00").toLocaleDateString("en-US", { month: "long", year: "numeric" });

/** 「月初预计 → 现在预计」in days; "" when the shift cannot be stated. */
function shiftText(days: number | null): string {
  if (days === null) return "";
  if (days === 0) return " · 没动 · unchanged";
  return days < 0 ? ` · 提前 ${-days} 天 · ${-days} days earlier` : ` · 推后 ${days} 天 · ${days} days later`;
}

/**
 * 月度小结 (PRD-body §13 item 11): the same BodyMonthReport the monthly Telegram message prints,
 * with month navigation. The current month comes in with the page payload; an earlier one is one
 * `GET /api/body/month/:month`, so the card never recomputes numbers of its own — the trend change
 * it shows is the same 7-day trend the chart above draws.
 */
function MonthCard({ thisMonth, today, firstMonth }: { thisMonth: BodyMonthReport; today: string; firstMonth: string | null }) {
  const current = today.slice(0, 7);
  const [month, setMonth] = useState(current);
  const [report, setReport] = useState<BodyMonthReport | null>(thisMonth);

  useEffect(() => {
    if (month === current) { setReport(thisMonth); return; }
    let live = true;
    setReport(null);
    api.get<{ month: BodyMonthReport | null }>(`/api/body/month/${month}`)
      .then((r) => { if (live) setReport(r.month); })
      .catch(() => { if (live) setReport(null); });
    return () => { live = false; };
  }, [month, current, thisMonth]);

  // Back to the first weigh-in's month, forward to the running one.
  const canPrev = !firstMonth || shiftMonth(month, -1) >= firstMonth;
  const canNext = month < current;

  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-label">
        {month === current ? "本月" : "月度小结"} <i>{monthName(month)}</i>
        <span className="spacer" />
        <span className="day-nav">
          <button aria-label="上个月 · Previous month" disabled={!canPrev} onClick={() => setMonth(shiftMonth(month, -1))}><Icon name="left" /></button>
          <button aria-label="下个月 · Next month" disabled={!canNext} onClick={() => setMonth(shiftMonth(month, 1))}><Icon name="right" /></button>
        </span>
      </div>
      {!report
        ? <p className="empty-note">这个月还没有身体记录 · Nothing logged this month.</p>
        : <>
          <div className="body-stats">
            <div>
              <div className="num">{report.change_kg === null ? "—" : `${delta(report.change_kg)} kg`}</div>
              <div className="lbl">
                7 日均变化 · Trend change
                {report.start_trend !== null && report.end_trend !== null ? ` · ${kg1(report.start_trend)} → ${kg1(report.end_trend)}` : ""}
              </div>
            </div>
            <div><div className="num">{report.weigh_ins}</div><div className="lbl">称重 · Weigh-ins</div></div>
            <div><div className="num">{report.workouts}</div><div className="lbl">运动 · Workouts · {report.minutes} 分钟</div></div>
            <div>
              <div className="num">{report.kcal_avg === null ? "—" : `~${report.kcal_avg}`}</div>
              <div className="lbl">平均 kcal · Daily average</div>
            </div>
          </div>
          <p className="hint">
            {report.best_week
              ? <>最好的一周 · best week {shortDate(report.best_week.week_start)} · {delta(report.best_week.change_kg)} kg · 运动 {report.best_week.workouts} 次</>
              : <>称重多几次，就能看出最好的一周 · a few more weigh-ins and the best week shows up</>}
            {report.meals_logged ? ` · 记录 ${report.meals_logged} 餐` : ""}
          </p>
          <p className="hint">
            {report.start_projected === null && report.end_projected === null
              ? <>还算不出预计达成日 · no projected date yet</>
              : <>预计达成 · projected {report.start_projected ?? "—"} → {report.end_projected ?? "—"}{shiftText(report.projected_shift_days)}</>}
          </p>
        </>}
    </div>
  );
}

function PlanCard({ summary, onEdit }: { summary: BodySummary; onEdit: () => void }) {
  const [zh, en] = verdictParts(summary);
  const { plan, week } = summary;
  return (
    <div className="card" style={{ marginTop: 18 }}>
      <div className="card-label">
        {plan.goal_title}
        <span className="spacer" />
        <button className="btn ghost small" onClick={onEdit}>编辑计划 · Edit plan</button>
      </div>
      <div className="body-stats">
        <div><div className="num">{summary.latest ? `${kg1(summary.latest.kg)} kg` : "—"}</div><div className="lbl">最近一次 · Latest{summary.latest ? ` · ${shortDate(summary.latest.date)}` : ""}</div></div>
        <div><div className="num">{summary.trend === null ? "—" : `${kg1(summary.trend)} kg`}</div><div className="lbl">7 日均 · 7-day trend</div></div>
        <div><div className="num">{summary.rate_kg_per_week === null ? "—" : `${summary.rate_kg_per_week > 0 ? "+" : summary.rate_kg_per_week < 0 ? "−" : ""}${Math.abs(summary.rate_kg_per_week).toFixed(2)}`}</div><div className="lbl">kg / 周 · per week</div></div>
        <div><div className="num">{summary.projected_date ?? "—"}</div><div className="lbl">预计达成 · Projected{plan.target_date ? ` · 目标 ${plan.target_date}` : ""}</div></div>
      </div>
      <div className="row" style={{ marginTop: 12, flexWrap: "wrap" }}>
        <span className={`chip ${summary.verdict === "behind" || summary.verdict === "wrong_way" ? "red" : summary.verdict === "ahead" || summary.verdict === "on_track" ? "green" : "amber"}`}>{zh}</span>
        <span className="mini muted">{en}</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="mini muted">
          {kg1(plan.start_kg)} → {kg1(plan.target_kg)} kg
          {summary.remaining_kg !== null && (summary.remaining_kg > 0 ? ` · 距目标 ${kg1(summary.remaining_kg)} kg` : " · 已达目标 ✓")}
        </span>
      </div>
      {summary.progress !== null && (
        <div className="progress-track" style={{ marginTop: 10 }}><div className="progress-fill" style={{ width: `${summary.progress}%` }} /></div>
      )}
      <p className="hint">
        本周运动 {week.workouts_done}/{week.workouts_target} · {week.minutes} 分钟
        {week.kcal_avg !== null ? ` · 平均 ~${week.kcal_avg} kcal` : ""}
        {week.meals_logged ? ` · 记录 ${week.meals_logged} 餐` : ""}
      </p>
    </div>
  );
}

const W = 760, H = 260;
const PAD = { top: 16, right: 18, bottom: 26, left: 46 };

/** Readings, the 7-day trend, the target line and the dashed projection — one SVG, no library. */
function WeightChart({ points, summary, today }: { points: Point[]; summary: BodySummary | null; today: string }) {
  const target = summary?.plan.target_kg ?? null;
  const projected = summary?.projected_date ?? null;
  const trendToday = summary?.trend ?? null;
  // The projection is only drawn when it starts at today's trend and ends after the last reading.
  const showProjection = target !== null && projected !== null && trendToday !== null && projected > today;

  const x0 = dayNum(points[0].date);
  const lastDate = showProjection ? projected : (today > points[points.length - 1].date ? today : points[points.length - 1].date);
  const x1 = dayNum(lastDate);
  const values = [
    ...points.map((p) => p.kg),
    ...points.map((p) => p.trend).filter((t): t is number => t !== null),
    ...(target === null ? [] : [target]),
  ];
  const lo = Math.min(...values), hi = Math.max(...values);
  const pad = Math.max(0.4, (hi - lo) * 0.12);
  const [yMin, yMax] = [lo - pad, hi + pad];

  const x = (date: string) => PAD.left + ((dayNum(date) - x0) / Math.max(1, x1 - x0)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + ((yMax - v) / (yMax - yMin)) * (H - PAD.top - PAD.bottom);

  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (yMax - yMin));
  const trendPath = points
    .filter((p): p is Point & { trend: number } => p.trend !== null)
    .map((p, i) => `${i ? "L" : "M"}${x(p.date).toFixed(1)} ${y(p.trend).toFixed(1)}`)
    .join(" ");

  return (
    <svg className="body-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`体重曲线 · Weight from ${points[0].date} to ${points[points.length - 1].date}`}>
      {ticks.map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--line-soft)" strokeWidth="1" />
          <text x={PAD.left - 8} y={y(v) + 3.5} textAnchor="end" className="axis">{kg1(v)}</text>
        </g>
      ))}

      {target !== null && (
        <>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(target)} y2={y(target)}
            stroke="var(--red)" strokeWidth="1.2" strokeDasharray="2 5" opacity="0.8" />
          <text x={W - PAD.right} y={y(target) - 6} textAnchor="end" className="axis red">目标 {kg1(target)}</text>
        </>
      )}

      {showProjection && (
        <>
          <line x1={x(today)} x2={x(projected)} y1={y(trendToday)} y2={y(target)}
            stroke="var(--red)" strokeWidth="1.4" strokeDasharray="5 4" opacity="0.75" />
          <circle cx={x(projected)} cy={y(target)} r="3.2" fill="var(--red)" />
          <text x={x(projected)} y={y(target) + 17} textAnchor="end" className="axis red">{projected}</text>
        </>
      )}

      {trendPath && <path d={trendPath} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />}

      {points.map((p) => (
        <circle key={p.date} cx={x(p.date)} cy={y(p.kg)} r="2.4" fill="var(--ink-faint)">
          <title>{p.date} · {kg1(p.kg)} kg</title>
        </circle>
      ))}

      <text x={PAD.left} y={H - 8} className="axis">{shortDate(points[0].date)}</text>
      <text x={W - PAD.right} y={H - 8} textAnchor="end" className="axis">{shortDate(lastDate)}</text>
    </svg>
  );
}
