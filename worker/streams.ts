// Streams and generic goals (docs/PRD-brain.md §6, §12): reading, writing and provisioning a tracker.
// A tracker is a stream (what to log, how it arrives, when to ask) plus optionally a goal (a claim the
// system can verify). Provisioning happens by conversation and is applied only on the user's approval,
// exactly like every other Guide proposal.
//
// Every statement is scoped by user_id. The tables arrive with migration 0006, so each read is wrapped
// in a try/catch: on a database where 0006 has not run, an account without trackers is the answer.

import type { GoalKind, Period, Shape } from "../shared/streams.ts";
import {
  ALIAS_MAX, MAX_ACTIVE_STREAMS, MAX_ALIASES, NAME_MAX, SHAPE_BOUNDS,
  isGoalKind, isPeriod, isShape, normalise,
} from "../shared/streams.ts";
import { goalStatus, type GoalStatus, type Obs } from "./derive.ts";
import { aliasConflict, boundsOf, inBounds } from "./telegram/parse.ts";
import { addDays } from "./dates.ts";

export interface StreamRow {
  id: number;
  name: string;
  shape: Shape;
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
  aliases: string[];
  bare_value_capture: number;
  ask_at: string | null;
  ask_text: string | null;
  quick: number[];
  status: string;
}

export interface TrackerGoal {
  id: number;
  title: string;
  kind: GoalKind;
  target: number;
  period: Period | null;
  deadline: string | null;
  start: number | null;
}

export interface Tracker {
  stream: StreamRow;
  goal: TrackerGoal | null;
  status: GoalStatus | null;
  /** Today's total for the stream, and the latest observation. */
  today_total: number;
  latest: { at: string; num: number | null; text: string | null } | null;
  observations?: { at: string; num: number | null; text: string | null }[];
}

const COLUMNS = `id, name, shape, unit, min_value, max_value, aliases, bare_value_capture, ask_at, ask_text, quick, status`;

function parseJsonArray(s: unknown): unknown[] {
  try {
    const v = JSON.parse(typeof s === "string" && s ? s : "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function toStream(row: Record<string, unknown>): StreamRow {
  return {
    id: row.id as number,
    name: row.name as string,
    shape: row.shape as Shape,
    unit: (row.unit as string) ?? null,
    min_value: (row.min_value as number) ?? null,
    max_value: (row.max_value as number) ?? null,
    aliases: parseJsonArray(row.aliases).filter((a): a is string => typeof a === "string"),
    bare_value_capture: (row.bare_value_capture as number) ?? 0,
    ask_at: (row.ask_at as string) ?? null,
    ask_text: (row.ask_text as string) ?? null,
    quick: parseJsonArray(row.quick).filter((q): q is number => typeof q === "number"),
    status: (row.status as string) ?? "active",
  };
}

/** Every active stream, oldest first. */
export async function activeStreams(db: D1Database, userId: number): Promise<StreamRow[]> {
  try {
    const { results } = await db.prepare(`SELECT ${COLUMNS} FROM streams WHERE user_id = ? AND status = 'active' ORDER BY id`)
      .bind(userId).all<Record<string, unknown>>();
    return results.map(toStream);
  } catch {
    return []; // migration 0006 has not run here
  }
}

export async function streamById(db: D1Database, userId: number, id: number): Promise<StreamRow | null> {
  try {
    const row = await db.prepare(`SELECT ${COLUMNS} FROM streams WHERE id = ? AND user_id = ?`)
      .bind(id, userId).first<Record<string, unknown>>();
    return row ? toStream(row) : null;
  } catch {
    return null;
  }
}

/** A stream the user named, matched on the name or any alias. */
export async function streamByWord(db: D1Database, userId: number, word: string): Promise<StreamRow | null> {
  const w = normalise(word);
  if (!w) return null;
  const streams = await activeStreams(db, userId);
  return streams.find((s) => normalise(s.name) === w || s.aliases.some((a) => normalise(a) === w))
    ?? streams.find((s) => normalise(s.name).includes(w) || s.aliases.some((a) => normalise(a).includes(w)))
    ?? null;
}

/** The goal attached to a stream, if any. */
export async function goalForStream(db: D1Database, userId: number, streamId: number): Promise<TrackerGoal | null> {
  try {
    const row = await db.prepare(
      `SELECT id, title, goal_kind, target_value, period, target_date FROM goals
        WHERE user_id = ? AND stream_id = ? AND status IN ('active','at_risk') ORDER BY id LIMIT 1`
    ).bind(userId, streamId).first<Record<string, unknown>>();
    if (!row || !isGoalKind(row.goal_kind)) return null;
    return {
      id: row.id as number,
      title: row.title as string,
      kind: row.goal_kind,
      target: Number(row.target_value ?? 0),
      period: isPeriod(row.period) ? row.period : null,
      deadline: (row.target_date as string) ?? null,
      start: null,
    };
  } catch {
    return null;
  }
}

/** Observations for a stream, oldest first, from `from` on. */
export async function observations(
  db: D1Database, userId: number, streamId: number, from: string
): Promise<{ at: string; num: number | null; text: string | null }[]> {
  try {
    const { results } = await db.prepare(
      "SELECT at, num, text FROM observations WHERE user_id = ? AND stream_id = ? AND at >= ? ORDER BY at, id"
    ).bind(userId, streamId, from).all<{ at: string; num: number | null; text: string | null }>();
    return results;
  } catch {
    return [];
  }
}

/**
 * The whole picture for one stream: its goal, the verdict, today's total and the recent log.
 * `history` days of observations are loaded; the verdict needs at most 90.
 */
export async function tracker(
  db: D1Database, userId: number, stream: StreamRow, today: string, history = 90, withObs = false
): Promise<Tracker> {
  const obs = await observations(db, userId, stream.id, addDays(today, -(history - 1)));
  const goal = await goalForStream(db, userId, stream.id);
  // `reach` needs a starting value for progress: the first reading we have is the honest one.
  const start = goal?.kind === "reach" ? (obs.find((o) => o.num !== null)?.num ?? null) : null;
  const status = goal
    ? goalStatus(
        { kind: goal.kind, shape: stream.shape, target: goal.target, period: goal.period, start, deadline: goal.deadline },
        obs as Obs[], today
      )
    : null;
  const todayObs = obs.filter((o) => o.at === today);
  return {
    stream,
    goal: goal ? { ...goal, start } : null,
    status,
    today_total: todayObs.reduce((t, o) => t + (o.num ?? 0), 0),
    latest: obs.length ? obs[obs.length - 1] : null,
    ...(withObs && { observations: obs }),
  };
}

export async function trackers(db: D1Database, userId: number, today: string, withObs = false): Promise<Tracker[]> {
  const streams = await activeStreams(db, userId);
  return Promise.all(streams.map((s) => tracker(db, userId, s, today, 90, withObs)));
}

// ---------- writing ----------

export interface LogResult {
  ok: true;
  id: number;
  stream: StreamRow;
  num: number | null;
  text: string | null;
}
export type LogError = { ok: false; error: string };

/**
 * One observation. The value has already been read out of the user's text by a shape parser
 * (PRD-brain §4 R1); this checks the stream's bounds and writes the row.
 */
export async function logObservation(
  db: D1Database, userId: number, stream: StreamRow,
  v: { at: string; num: number | null; text?: string | null; timeMin?: number | null; source?: string; note?: string }
): Promise<LogResult | LogError> {
  if (v.num !== null && !inBounds(stream.shape, v.num, stream.min_value, stream.max_value)) {
    const b = boundsOf(stream.shape, stream.min_value, stream.max_value);
    return { ok: false, error: b ? `要在 ${b[0]}–${b[1]} 之间 · must be between ${b[0]} and ${b[1]}` : "超出范围 · out of range" };
  }
  const row = await db.prepare(
    "INSERT INTO observations (user_id, stream_id, at, time_min, num, text, source, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"
  ).bind(userId, stream.id, v.at, v.timeMin ?? null, v.num, v.text ?? null, v.source ?? "telegram", v.note ?? "")
   .first<{ id: number }>();
  if (!row) return { ok: false, error: "写入失败 · could not log" };
  await refreshStreamGoal(db, userId, stream.id, v.at);
  return { ok: true, id: row.id, stream, num: v.num, text: v.text ?? null };
}

export async function deleteObservation(db: D1Database, userId: number, id: number, today: string): Promise<boolean> {
  const row = await db.prepare("DELETE FROM observations WHERE id = ? AND user_id = ? RETURNING stream_id")
    .bind(id, userId).first<{ stream_id: number }>();
  if (!row) return false;
  await refreshStreamGoal(db, userId, row.stream_id, today);
  return true;
}

/** A goal over a stream has a derived progress, like a body goal does (PRD-brain §7). */
export async function refreshStreamGoal(db: D1Database, userId: number, streamId: number, today: string): Promise<void> {
  const stream = await streamById(db, userId, streamId);
  if (!stream) return;
  const t = await tracker(db, userId, stream, today);
  if (!t.goal || t.status?.progress === null || t.status === null) return;
  await db.prepare("UPDATE goals SET progress = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(t.status.progress, t.goal.id, userId).run();
}

// ---------- provisioning (PRD-brain §12) ----------

export interface TrackerSpec {
  name: string;
  shape: Shape;
  unit?: string | null;
  min_value?: number | null;
  max_value?: number | null;
  aliases?: string[];
  ask_at?: string | null;
  ask_text?: string | null;
  quick?: number[];
  goal?: { kind: GoalKind; target: number; period?: Period | null; title?: string; deadline?: string | null } | null;
}

export type ProvisionResult =
  | { ok: true; stream: StreamRow; goalId: number | null }
  | { ok: false; status: 400 | 409; error: string };

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validate a tracker spec. Everything the model may supply is checked here — it is the only thing
 * standing between a model's output and the schema.
 */
export function validateSpec(spec: TrackerSpec): { ok: true; clean: Required<Omit<TrackerSpec, "goal">> & { goal: TrackerSpec["goal"] } } | { ok: false; error: string } {
  const name = String(spec.name ?? "").trim();
  if (!name || name.length > NAME_MAX) return { ok: false, error: `name must be 1–${NAME_MAX} characters` };
  if (!isShape(spec.shape)) return { ok: false, error: "unknown shape" };

  const aliases = (Array.isArray(spec.aliases) ? spec.aliases : [])
    .map((a) => String(a ?? "").trim())
    .filter((a) => a && a.length <= ALIAS_MAX)
    .slice(0, MAX_ALIASES);
  if (!aliases.some((a) => normalise(a) === normalise(name))) aliases.unshift(name);

  const bounds = SHAPE_BOUNDS[spec.shape];
  const min = spec.min_value ?? bounds?.[0] ?? null;
  const max = spec.max_value ?? bounds?.[1] ?? null;
  if (min !== null && max !== null && min >= max) return { ok: false, error: "min_value must be below max_value" };

  const ask_at = spec.ask_at ? String(spec.ask_at) : null;
  if (ask_at && !HHMM.test(ask_at)) return { ok: false, error: "ask_at must be HH:MM or null" };

  const quick = (Array.isArray(spec.quick) ? spec.quick : [])
    .map((q) => Number(q)).filter((q) => Number.isFinite(q)).slice(0, 5);

  let goal = spec.goal ?? null;
  if (goal) {
    if (!isGoalKind(goal.kind)) return { ok: false, error: "unknown goal kind" };
    const target = Number(goal.target);
    if (!Number.isFinite(target)) return { ok: false, error: "goal target must be a number" };
    const period = goal.period && isPeriod(goal.period) ? goal.period : goal.kind === "accumulate" ? "week" : null;
    if (goal.kind === "accumulate" && target <= 0) return { ok: false, error: "an accumulate target must be above 0" };
    if (goal.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(goal.deadline)) return { ok: false, error: "bad deadline" };
    goal = { ...goal, target, period, title: String(goal.title ?? name).slice(0, 200) };
  }

  return {
    ok: true,
    clean: {
      name, shape: spec.shape, unit: spec.unit ?? null, min_value: min, max_value: max,
      aliases, ask_at, ask_text: spec.ask_text ? String(spec.ask_text).slice(0, 200) : null, quick, goal,
    },
  };
}

/**
 * Create a tracker: the stream, and the goal that judges it. Refuses on a name or alias that would make
 * two streams fight over the same message — that conflict is caught here, at provisioning time, rather
 * than being resolved by luck on every later message (PRD-brain §8.3).
 */
export async function provisionTracker(
  db: D1Database, userId: number, spec: TrackerSpec, today: string
): Promise<ProvisionResult> {
  const v = validateSpec(spec);
  if (!v.ok) return { ok: false, status: 400, error: v.error };
  const c = v.clean;

  const existing = await activeStreams(db, userId);
  if (existing.length >= MAX_ACTIVE_STREAMS) {
    return { ok: false, status: 409, error: `最多 ${MAX_ACTIVE_STREAMS} 个追踪 · at most ${MAX_ACTIVE_STREAMS} trackers` };
  }
  if (existing.some((s) => normalise(s.name) === normalise(c.name))) {
    return { ok: false, status: 409, error: `已经有「${c.name}」了 · a tracker called that already exists` };
  }
  for (const s of existing) {
    const clash = aliasConflict(c.aliases, s.aliases);
    if (clash) {
      return { ok: false, status: 409, error: `「${clash}」和已有的「${s.name}」会抢同一句话 · that word would collide with "${s.name}"` };
    }
  }

  const row = await db.prepare(
    `INSERT INTO streams (user_id, name, shape, unit, min_value, max_value, aliases, ask_at, ask_text, quick)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`
  ).bind(
    userId, c.name, c.shape, c.unit, c.min_value, c.max_value,
    JSON.stringify(c.aliases), c.ask_at, c.ask_text, JSON.stringify(c.quick)
  ).first<Record<string, unknown>>();
  if (!row) return { ok: false, status: 400, error: "could not create the stream" };
  const stream = toStream(row);

  let goalId: number | null = null;
  if (c.goal) {
    const g = await db.prepare(
      `INSERT INTO goals (user_id, title, level, type, status, goal_kind, stream_id, target_value, period, target_date)
       VALUES (?, ?, 'quarter', 'process', 'active', ?, ?, ?, ?, ?) RETURNING id`
    ).bind(userId, c.goal.title ?? c.name, c.goal.kind, stream.id, c.goal.target, c.goal.period, c.goal.deadline ?? null)
     .first<{ id: number }>();
    goalId = g?.id ?? null;
    if (goalId) await refreshStreamGoal(db, userId, stream.id, today);
  }
  return { ok: true, stream, goalId };
}

/** Retire a tracker: it stops asking and leaves the dashboard; the observations stay (PRD-brain §15). */
export async function retireStream(db: D1Database, userId: number, streamId: number): Promise<boolean> {
  try {
    const r = await db.prepare("UPDATE streams SET status = 'retired' WHERE id = ? AND user_id = ? AND status = 'active'")
      .bind(streamId, userId).run();
    return r.meta.changes > 0;
  } catch {
    return false;
  }
}

const STREAM_FIELDS = ["name", "unit", "ask_at", "ask_text", "bare_value_capture", "status"] as const;

/** Partial update from the web (PRD-brain §14): the user corrects what the conversation provisioned. */
export async function updateStream(db: D1Database, userId: number, id: number, b: Record<string, unknown>): Promise<StreamRow | null> {
  for (const f of STREAM_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (f === "ask_at") {
      if (v === "" || v === null) v = null;
      else if (typeof v !== "string" || !HHMM.test(v)) continue;
    }
    if (f === "bare_value_capture") v = v ? 1 : 0;
    if (f === "status" && !["active", "paused", "retired"].includes(String(v))) continue;
    if ((f === "name" || f === "unit" || f === "ask_text") && v !== null) v = String(v).slice(0, NAME_MAX * 5);
    await db.prepare(`UPDATE streams SET ${f} = ? WHERE id = ? AND user_id = ?`).bind(v as string | number | null, id, userId).run();
  }
  if (Array.isArray(b.quick)) {
    const quick = b.quick.map((q) => Number(q)).filter((q) => Number.isFinite(q)).slice(0, 5);
    await db.prepare("UPDATE streams SET quick = ? WHERE id = ? AND user_id = ?").bind(JSON.stringify(quick), id, userId).run();
  }
  if (Array.isArray(b.aliases)) {
    const aliases = b.aliases.map((a) => String(a ?? "").trim()).filter((a) => a && a.length <= ALIAS_MAX).slice(0, MAX_ALIASES);
    const others = (await activeStreams(db, userId)).filter((s) => s.id !== id);
    if (!others.some((s) => aliasConflict(aliases, s.aliases))) {
      await db.prepare("UPDATE streams SET aliases = ? WHERE id = ? AND user_id = ?").bind(JSON.stringify(aliases), id, userId).run();
    }
  }
  return streamById(db, userId, id);
}

// ---------- timers (PRD-brain §11) ----------

export async function startTimer(db: D1Database, userId: number, streamId: number): Promise<void> {
  await db.prepare(
    `INSERT INTO stream_timers (user_id, stream_id, started_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT (user_id) DO UPDATE SET stream_id = excluded.stream_id, started_at = excluded.started_at`
  ).bind(userId, streamId).run();
}

export async function runningTimer(db: D1Database, userId: number): Promise<{ stream_id: number; minutes: number } | null> {
  try {
    const row = await db.prepare(
      "SELECT stream_id, CAST((julianday('now') - julianday(started_at)) * 1440 AS INTEGER) AS minutes FROM stream_timers WHERE user_id = ?"
    ).bind(userId).first<{ stream_id: number; minutes: number }>();
    return row ?? null;
  } catch {
    return null;
  }
}

export async function clearTimer(db: D1Database, userId: number): Promise<void> {
  await db.prepare("DELETE FROM stream_timers WHERE user_id = ?").bind(userId).run();
}

/**
 * The `Trackers:` line for guideContext (PRD-brain §9): every tracker the user already has, so the
 * model proposes a new one only for something genuinely absent — and can quote where each one stands
 * without computing anything itself (§4 R2).
 */
export async function trackersContextLine(db: D1Database, userId: number, today: string): Promise<string> {
  const list = await trackers(db, userId, today);
  if (!list.length) return "Trackers: none yet";
  const parts = list.map((t) => {
    const s = t.stream;
    const goal = t.goal && t.status
      ? `, goal ${t.goal.kind} ${t.goal.target}${t.goal.period ? `/${t.goal.period}` : ""}`
        + `, now ${t.status.current ?? "n/a"}, verdict ${t.status.verdict}`
      : "";
    return `"${s.name}" (${s.shape}${s.unit ? ` in ${s.unit}` : ""}${goal})`;
  });
  return `Trackers: ${parts.join(" · ")}`;
}
