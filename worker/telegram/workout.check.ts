// Unit-ish checks for workout.ts (no test runner in this repo): `npm run check:workout`.
// Runs under Node's type stripping and touches no database: the `wo:` callback formats round-trip through
// parseCallback, and parseWorkoutInput keeps free text out of the logs (PRD-body §5.4).
// Importing callback.ts also loads the whole telegram module graph, so this is the cheapest cycle check.

import { cb, parseCallback, type Callback } from "./callback.ts";
import { parseWorkoutInput, type ParsedWorkout } from "./workout.ts";

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

function parses(text: string, fallback: string | null, want: ParsedWorkout | null, what: string): void {
  check(same(parseWorkoutInput(text, fallback), want), what);
}

// ---------- the wire format ----------

parsesBackTo(cb.workoutPick("run"), { verb: "workout_pick", pick: "run" }, "wo:<code> round-trips (run)");
parsesBackTo(cb.workoutPick("other"), { verb: "workout_pick", pick: "other" }, "wo:<code> round-trips (other)");
parsesBackTo(cb.workoutPick("rest"), { verb: "workout_pick", pick: "rest" }, "wo:<code> round-trips (rest)");
parsesBackTo(cb.workoutTask(42, 30), { verb: "workout_task", taskId: 42, min: 30 }, "wo:t:<taskId>:<min> round-trips");
check(parseCallback("wo:q") === null, "an unknown activity code is refused");
check(parseCallback("wo:t:42:0") === null, "a zero-minute task log is refused");
check(parseCallback("wo:t:42:601") === null, "over 600 minutes is refused");
check(parseCallback("wo:t:0:30") === null, "task id 0 is refused");

// ---------- /workout and the minutes reply ----------

parses("跑步 30", null, { activity: "run", minutes: 30, intensity: null }, "跑步 30");
parses("run 30 min", null, { activity: "run", minutes: 30, intensity: null }, "run 30 min");
parses("力量 45 高强度", null, { activity: "strength", minutes: 45, intensity: "hard" }, "力量 45 高强度");
parses("跑步30分钟", null, { activity: "run", minutes: 30, intensity: null }, "跑步30分钟 (no space)");
parses("瑜伽 30", null, { activity: "yoga", minutes: 30, intensity: null }, "an activity outside the buttons");
parses("30", "walk", { activity: "walk", minutes: 30, intensity: null }, "the minutes reply after an activity tap");
parses("30 低", "run", { activity: "run", minutes: 30, intensity: "easy" }, "minutes and intensity after a tap");
check(parseWorkoutInput("30") === null, "a bare number with no activity is not a workout");
check(parseWorkoutInput("跑了五公里") === null, "free text is not parsed — it captures as usual");
check(parseWorkoutInput("买牛奶") === null, "an ordinary capture is not a workout");
check(parseWorkoutInput("跑步 900") === null, "over 600 minutes is not a workout");

console.log("all checks passed");
