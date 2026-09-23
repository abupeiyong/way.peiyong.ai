// Unit-ish checks for adapt.ts and the per-dish corrections (no test runner in this repo): `npm run check:adapt`.
// Nothing here touches a database or a model: the `ad:` callback formats round-trip through parseCallback,
// the median / HH:MM helpers behave, and a dish name normalises the same way whichever card it came from.
// Importing callback.ts also loads the whole telegram module graph, so this is a cycle check too.

import { cb, parseCallback, type Callback } from "./callback.ts";
import { driftOf, hhmm, medianMinutes, localMinutesOf, slotMinutes, type Sample } from "./adapt.ts";
import { addDays } from "../dates.ts";
import { dishesOf, normalizeDish } from "./meal.ts";
import { reportedMonth } from "./bodymonth.ts";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parsesBackTo(data: string, want: Callback, what: string): void {
  check(same(parseCallback(data), want), what);
}

// ---------- the wire format ----------

parsesBackTo(cb.adapt("lunch", "13:40"), { verb: "adapt", slot: "lunch", time: "13:40" }, "ad:l:1340 round-trips");
parsesBackTo(cb.adapt("weigh", "07:05"), { verb: "adapt", slot: "weigh", time: "07:05" }, "a leading zero survives");
parsesBackTo(cb.adaptKeep(), { verb: "adapt", slot: null, time: null }, "ad:x round-trips");
parsesBackTo(cb.adaptOff("breakfast"), { verb: "adapt", slot: "breakfast", time: null, off: true }, "ad:f:b round-trips");
check(parseCallback("ad:l:2400") === null, "hour 24 is refused");
check(parseCallback("ad:l:1360") === null, "minute 60 is refused");
check(parseCallback("ad:q:1300") === null, "an unknown slot is refused");
check(parseCallback("ad:l") === null, "a slot with no time is refused");
check(parseCallback("ad:f:q") === null, "ad:f with an unknown slot is refused");
check(parseCallback("ad:f") === null, "ad:f with no slot is refused");

// ---------- the times ----------

check(slotMinutes("13:00") === 780, "13:00 is 780 minutes");
check(slotMinutes("24:00") === null, "24:00 is not a time");
check(slotMinutes(null) === null, "an unset slot has no minutes");
check(medianMinutes([]) === null, "no samples, no median");
check(medianMinutes([800, 820, 780]) === 800, "the median is the middle sample");
check(medianMinutes([780, 800, 820, 840]) === 810, "an even count averages the middle two");
check(hhmm(823) === "13:45", "the median rounds to five minutes");
check(hhmm(0) === "00:00" && hhmm(1439) === "23:55", "the ends stay inside the day");
check(localMinutesOf("2026-09-20 07:12:00", "UTC") === 7 * 60 + 12, "a stored UTC timestamp reads as local minutes");
check(localMinutesOf("2026-09-20 07:12:00", "Asia/Dubai") === 11 * 60 + 12, "the user's zone shifts it");
check(localMinutesOf("not a time", "UTC") === null, "an unparseable timestamp is not a sample");

// ---------- the drift, two weeks running (issue #65) ----------

const TODAY = "2026-09-20";
/** `days` days of one log a day, all at the same local minute. */
function daily(minutes: number, days: number[]): Sample[] {
  return days.map((d) => ({ date: addDays(TODAY, -d), minutes }));
}
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

const LUNCH_ASK = 13 * 60;          // 13:00
const LUNCH_ACTUAL = 12 * 60 + 15;  // 12:15 — exactly 45 minutes early

const oneWeek = daily(LUNCH_ACTUAL, range(0, 6));
const twoWeeks = daily(LUNCH_ACTUAL, range(0, 13));

check(driftOf(oneWeek, LUNCH_ASK, TODAY) === null, "one week of 12:15 lunches is not yet a drift");
check(
  same(driftOf(twoWeeks, LUNCH_ASK, TODAY), { median: LUNCH_ACTUAL, count: 14 }),
  "two weeks running of 12:15 lunches offers 12:15",
);
check(driftOf(daily(12 * 60 + 30, range(0, 13)), LUNCH_ASK, TODAY) === null, "half an hour off is left alone");
check(
  driftOf(daily(LUNCH_ACTUAL, [0, 1, 2, 3, 12, 13]), LUNCH_ASK, TODAY) === null,
  "fewer than five logs in the earlier window is not two weeks running",
);
check(
  driftOf(
    [...daily(12 * 60, range(0, 6)), ...daily(12 * 60, range(0, 6)), ...daily(12 * 60, range(0, 6)),
     ...daily(14 * 60, range(7, 20))],
    LUNCH_ASK, TODAY,
  ) === null,
  "a week that swung the other way is not a drift",
);

// ---------- the month the report covers ----------

check(reportedMonth("2026-09-01") === "2026-08-01", "the 1st reports the month that just ended");
check(reportedMonth("2026-01-01") === "2025-12-01", "January reports last December");

// ---------- per-dish corrections ----------

check(normalizeDish("牛肉面（约 1 碗）") === "牛肉面", "the portion is not part of the dish");
check(normalizeDish("卤蛋 ×2") === "卤蛋", "a count is not part of the dish either");
check(normalizeDish("  Beef   Noodles ") === "beef noodles", "a dish name is lower-cased and squeezed");
check(same(dishesOf("牛肉面（约 1 碗）、卤蛋 ×1"), ["牛肉面", "卤蛋"]), "a description splits into its dishes");
check(dishesOf("牛肉面").length === 1, "one dish is one dish — the only kind a correction is remembered for");
check(dishesOf("   ").length === 0, "an empty description teaches nothing");

console.log("all checks passed");
