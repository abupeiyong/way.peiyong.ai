// Body constants and wording shared by the worker, the bot and the web (docs/PRD-body.md §8, §10).
// The numbers themselves are computed once, in worker/body.ts; this file only holds what every
// client has to agree on: the plausible weight range, the input units, and how a verdict is worded.

import type { BodyVerdict } from "./types.ts";

/** The weight a body can plausibly have, in kg (PRD-body §5.1); anything else is a typo, not a weigh-in. */
export const KG_RANGE: [number, number] = [30, 300];

/** Goal titles that look like a weight goal (PRD-body §4.2) — used to offer a plan, never to create one. */
export const WEIGHT_GOAL_RE = /体重|减肥|减重|增肌|瘦|weight|lose|gain|kg|lb/i;

/** What a body plan accepts (PRD-body §4.1); the form and the worker check the same bounds. */
export const WEEKLY_WORKOUTS_RANGE: [number, number] = [0, 14];
export const DAILY_KCAL_RANGE: [number, number] = [800, 6000];
export const DEFAULT_WEEKLY_WORKOUTS = 3;

/** What one unit of input is worth in kilograms; storage is always kg (`body_plans.input_unit`). */
export const WEIGHT_UNITS = { kg: 1, jin: 0.5, lb: 0.4536 } as const;
export type WeightUnit = keyof typeof WEIGHT_UNITS;
export const WEIGHT_UNIT_LABELS: Record<WeightUnit, string> = { kg: "kg", jin: "斤", lb: "lb" };

export function isWeightUnit(v: unknown): v is WeightUnit {
  return typeof v === "string" && v in WEIGHT_UNITS;
}

/** `72.4` in `unit` → kilograms, rounded the way a weigh-in is stored (one decimal). */
export function toKg(value: number, unit: WeightUnit): number {
  return Math.round(value * WEIGHT_UNITS[unit] * 10) / 10;
}

/** Kilograms → a number in `unit`, one decimal — what a stored plan shows in the input it was typed in. */
export function fromKg(kg: number, unit: WeightUnit): number {
  return Math.round((kg / WEIGHT_UNITS[unit]) * 10) / 10;
}

/**
 * Where a weigh-in came from (`weight_logs.source`). Every write names its own: the bot and the web
 * share one upsert, so without this they would all be labelled the same.
 */
export const WEIGHT_SOURCES = ["telegram", "web", "guide"] as const;
export type WeightSource = (typeof WEIGHT_SOURCES)[number];

export function isWeightSource(v: unknown): v is WeightSource {
  return typeof v === "string" && (WEIGHT_SOURCES as readonly string[]).includes(v);
}

/** The verdict in words — `/body`, the Guide's prefix and the Body page all use these. */
export const BODY_VERDICT_TEXT: Record<BodyVerdict, string> = {
  ahead: "提前 · ahead of the target date",
  on_track: "按计划 · on track",
  behind: "落后 · behind the target date",
  stalled: "停在原地 · stalled",
  wrong_way: "方向反了 · moving away from the target",
  no_data: "称重还不够 · not enough weigh-ins yet",
};
