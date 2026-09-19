// Per-field coercion for the partial-update whitelists (DAY_FIELDS, TASK_FIELDS, GOAL_FIELDS).
// Each coercer returns the value to bind, or throws BadInput — which the routes turn into a 400
// instead of letting D1 choke on an object/array and answer 500.

export class BadInput extends Error {}

export type Coerce = (v: unknown, field: string) => string | number | null;
export type FieldSpecs = Record<string, Coerce>;

function bad(field: string, want: string): never {
  throw new BadInput(`${field} must be ${want}`);
}

function toInt(v: unknown): number | null {
  if (typeof v === "number") return Number.isInteger(v) ? v : null;
  if (typeof v === "string" && /^-?\d+$/.test(v.trim())) return Number(v);
  return null;
}

export const text: Coerce = (v, f) => (typeof v === "string" ? v : bad(f, "a string"));

export const nonEmptyText: Coerce = (v, f) => (typeof v === "string" && v.trim() ? v : bad(f, "a non-empty string"));

/** 0/1; booleans are accepted and stored as 0/1. */
export const flag: Coerce = (v, f) => {
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = toInt(v);
  return n === 0 || n === 1 ? n : bad(f, "0 or 1");
};

/** Integer in [min, max]; null clears it when `nullable`. */
export function int(min: number, max: number, nullable = true): Coerce {
  return (v, f) => {
    if (v === null && nullable) return null;
    const n = toInt(v);
    if (n === null || n < min || n > max) bad(f, `an integer from ${min} to ${max}${nullable ? " or null" : ""}`);
    return n;
  };
}

/** A row id (positive integer) or null. */
export const idOrNull: Coerce = (v, f) => {
  if (v === null) return null;
  const n = toInt(v);
  return n !== null && n > 0 ? n : bad(f, "an id or null");
};

export const dateOrNull: Coerce = (v, f) =>
  v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : bad(f, "a YYYY-MM-DD date or null");

export function oneOf(values: readonly string[], nullable = false): Coerce {
  return (v, f) => {
    if (v === null && nullable) return null;
    return typeof v === "string" && values.includes(v) ? v : bad(f, `one of ${values.join("|")}${nullable ? " or null" : ""}`);
  };
}

/** Coerce every whitelisted field present in `b`; throws BadInput on the first bad one, before anything is written. */
export function coerceFields(b: Record<string, unknown>, specs: FieldSpecs): [string, string | number | null][] {
  if (typeof b !== "object" || b === null || Array.isArray(b)) throw new BadInput("body must be a JSON object");
  return Object.keys(specs).filter((f) => f in b).map((f) => [f, specs[f](b[f], f)]);
}
