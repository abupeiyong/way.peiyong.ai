// Unit-ish checks for weight.ts (no test runner in this repo): `npm run check:weight`.
// Runs under Node's type stripping and touches no database: the `wt:` callback formats round-trip through
// parseCallback, and parseWeightKg keeps ordinary captures out of the weight log (PRD-body §5.1).
// Importing callback.ts also loads the whole telegram module graph, so this is a cycle check too.

import { cb, parseCallback, type Callback } from "./callback.ts";
import { parseWeightKg } from "./weight.ts";

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(`FAIL: ${what}`);
  console.log(`ok   ${what}`);
}

function parsesBackTo(data: string, want: Callback, what: string): void {
  check(JSON.stringify(parseCallback(data)) === JSON.stringify(want), what);
}

function kg(text: string, want: number | null, what: string): void {
  check(parseWeightKg(text) === want, what);
}

// ---------- the wire format ----------

parsesBackTo(cb.weight("skip", "2026-09-20"), { verb: "weight", action: "skip", date: "2026-09-20" }, "wt:s:<date> round-trips");
parsesBackTo(cb.weight("undo", "2026-09-20"), { verb: "weight", action: "undo", date: "2026-09-20" }, "wt:u:<date> round-trips");
check(parseCallback("wt:s") === null, "wt: without a date is refused");
check(parseCallback("wt:q:2026-09-20") === null, "an unknown weight verb is refused");
check(parseCallback("wt:u:2026-02-30") === null, "a date that does not exist is refused");

// ---------- the strict weight pattern (§5.1) ----------

kg("72.4", 72.4, "72.4 → 72.4 kg");
kg("72,4", 72.4, "a comma decimal");
kg("72", 72, "a bare two-digit number is a weight while a plan exists");
kg(" 72.4 kg ", 72.4, "the unit and the spaces around it");
kg("72.4公斤", 72.4, "公斤 is kg");
kg("144斤", 72, "144斤 → 72.0 kg");
kg("160 lb", 72.6, "pounds");
kg("160磅", 72.6, "磅 is lb");
kg("体重 72.4", 72.4, "the 体重 prefix");
kg("weight 72.4", 72.4, "the weight prefix");
kg("7", null, "7 is not a weight");
kg("400", null, "400 kg is out of range");
kg("29", null, "under 30 kg is out of range");
kg("72.45", null, "two decimals is not the pattern");
kg("买牛奶", null, "an ordinary capture is not a weight");
kg("72.4 和 73", null, "a sentence with a number is not a weight");
kg("明天 8 点开会", null, "a task with a number is not a weight");

console.log("all checks passed");
