// Body constants and wording shared by the worker, the bot and the web (docs/PRD-body.md §8, §10).
// The numbers themselves are computed once, in worker/body.ts; this file only holds what every
// client has to agree on: the plausible weight range, the input units, and how a verdict is worded.

import type { BodyVerdict } from "./types.ts";

/** The weight a body can plausibly have, in kg (PRD-body §5.1); anything else is a typo, not a weigh-in. */
export const KG_RANGE: [number, number] = [30, 300];

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

/** The verdict in words — `/body`, the Guide's prefix and the Body page all use these. */
export const BODY_VERDICT_TEXT: Record<BodyVerdict, string> = {
  ahead: "提前 · ahead of the target date",
  on_track: "按计划 · on track",
  behind: "落后 · behind the target date",
  stalled: "停在原地 · stalled",
  wrong_way: "方向反了 · moving away from the target",
  no_data: "称重还不够 · not enough weigh-ins yet",
};
