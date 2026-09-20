// Unit-ish checks for parse.ts and the tracker callback formats: `npm run check:parse`.
// These parsers are what stands between a model's routing decision and the stored value
// (docs/PRD-brain.md §4 R1), so the cases are deliberately exhaustive. Any failure throws.
//
// Importing callback.ts also loads the whole telegram module graph, which is the cheapest check that
// no module uses an imported binding at top level (a TDZ crash in the Worker — see CLAUDE.md).

import { aliasConflict, boundsOf, inBounds, matchStream, parseShape } from "./parse.ts";
import { cb, parseCallback } from "./callback.ts";
import { elapsedFraction, goalStatus, periodTotals, previousPeriod } from "../derive.ts";
import { validateSpec } from "../streams.ts";

let failures = 0;
function check(ok: boolean, what: string): void {
  if (ok) console.log(`ok   ${what}`);
  else { console.error(`FAIL ${what}`); failures++; }
}
function eq(a: unknown, b: unknown, what: string): void {
  check(JSON.stringify(a) === JSON.stringify(b), `${what}  (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// ---------- duration ----------
const dur = (s: string) => parseShape("duration", s, "min")?.num ?? null;
eq(dur("45"), 45, "duration: a bare number is minutes");
eq(dur("45分"), 45, "duration: 45分");
eq(dur("45 分钟"), 45, "duration: 45 分钟");
eq(dur("1h"), 60, "duration: 1h");
eq(dur("1小时"), 60, "duration: 1小时");
eq(dur("1.5小时"), 90, "duration: 1.5小时");
eq(dur("半小时"), 30, "duration: 半小时");
eq(dur("一小时"), 60, "duration: 一小时");
eq(dur("两小时"), 120, "duration: 两小时");
eq(dur("1小时30分"), 90, "duration: 1小时30分");
eq(dur("90min"), 90, "duration: 90min");
eq(dur("没读"), 0, "duration: 没读 declines");
eq(parseShape("duration", "没读", "min")?.declined, true, "duration: 没读 is marked declined");
eq(dur("三十"), 30, "duration: 三十");
eq(dur("买牛奶"), null, "duration: prose is not a duration");
eq(dur("45 公斤"), null, "duration: a weight is not a duration");
eq(dur(""), null, "duration: empty");

// ---------- count / bool / number / money ----------
eq(parseShape("count", "3", null)?.num, 3, "count: 3");
eq(parseShape("count", "三次", null)?.num, 3, "count: 三次");
eq(parseShape("count", "两遍", null)?.num, 2, "count: 两遍");
eq(parseShape("count", "3 公里", null), null, "count: a unit it does not know is rejected");
eq(parseShape("bool", "做了", null)?.num, 1, "bool: 做了");
eq(parseShape("bool", "✓", null)?.num, 1, "bool: ✓");
eq(parseShape("bool", "没有", null)?.num, 0, "bool: 没有");
eq(parseShape("bool", "45", null), null, "bool: a number is not a yes/no");
eq(parseShape("number", "72.4", "kg")?.num, 72.4, "number: 72.4");
eq(parseShape("number", "72.4kg", "kg")?.num, 72.4, "number: the stream's own unit is allowed");
eq(parseShape("number", "72.4 lb", "kg"), null, "number: another unit is not this stream's value");
eq(parseShape("money", "¥100", null)?.num, 100, "money: ¥100");
eq(parseShape("money", "100 元", null)?.num, 100, "money: 100 元");
eq(parseShape("text", "读了《长日留痕》", null)?.text, "读了《长日留痕》", "text: kept as written");

// ---------- bounds ----------
eq(boundsOf("duration", null, null), [1, 1440], "bounds: duration falls back to the shape's");
check(inBounds("duration", 45, null, null), "bounds: 45 minutes is plausible");
check(!inBounds("duration", 5000, null, null), "bounds: 5000 minutes is a typo");
check(inBounds("number", 72.4, 30, 300), "bounds: the stream's own range is used");
check(!inBounds("number", 7, 30, 300), "bounds: below the stream's range");

// ---------- patterns (L3) ----------
const aliases = ["读书", "看书", "读了"];
eq(parseShape("duration", matchStream("今天读书 45 分钟", aliases, "duration") ?? "", "min")?.num, 45, "match: 读书 45 分钟");
eq(parseShape("duration", matchStream("读了30min", aliases, "duration") ?? "", "min")?.num, 30, "match: 读了30min");
eq(parseShape("duration", matchStream("看书一小时", aliases, "duration") ?? "", "min")?.num, 60, "match: 看书一小时");
eq(matchStream("今天很累", aliases, "duration"), null, "match: prose without a value does not match");
eq(matchStream("跑了 5 公里", aliases, "duration"), null, "match: another activity does not match");
check(aliasConflict(["跑步"], ["跑步机"]) !== null, "conflict: one word containing another collides");
check(aliasConflict(["读书"], ["跑步"]) === null, "conflict: unrelated words do not");
check(aliasConflict(["看书"], ["读书", "看书"]) !== null, "conflict: a shared alias collides");

// ---------- callback formats ----------
for (const data of [cb.streamValue(1, 45), cb.streamValue(9007199254740991, 9999), cb.streamSkip(7),
                    cb.obsUndo(42), cb.timerStart(3), cb.timerStop(), cb.trackerShow(9)]) {
  check(parseCallback(data) !== null, `callback: ${data} parses back`);
}
eq(parseCallback("sv:0:1"), null, "callback: a zero id is rejected");
eq(parseCallback("sv:1:99999"), null, "callback: an over-large quick value is rejected");
eq(parseCallback("tm:"), null, "callback: a malformed timer is rejected");

// ---------- derivations ----------
eq(previousPeriod("week", "2026-09-20"), "2026-09-07", "period: the week before the one containing Sun 20 Sep");
check(Math.abs(elapsedFraction("week", "2026-09-20") - 1) < 1e-9, "period: Sunday is the whole week elapsed");
check(Math.abs(elapsedFraction("week", "2026-09-14") - 1 / 7) < 1e-9, "period: Monday is one seventh");

const obs = [
  { at: "2026-09-14", num: 60 }, { at: "2026-09-15", num: 60 },
  { at: "2026-09-16", num: 60 }, { at: "2026-09-17", num: 60 },
];
const acc = goalStatus({ kind: "accumulate", shape: "duration", target: 600, period: "week" }, obs, "2026-09-17");
eq(acc.current, 240, "accumulate: this week's total");
eq(acc.verdict, "behind", "accumulate: 240 of 600 by Thursday is behind");
eq(acc.days_left, 4, "accumulate: Thursday leaves four days");
const done = goalStatus({ kind: "accumulate", shape: "duration", target: 200, period: "week" }, obs, "2026-09-17");
eq(done.verdict, "ahead", "accumulate: past the target is ahead");
const late = goalStatus({ kind: "accumulate", shape: "duration", target: 600, period: "week" },
  [{ at: "2026-09-20", num: 30 }], "2026-09-20");
eq(late.verdict, "unreachable", "accumulate: 30 of 600 on the last day is out of reach");
eq(periodTotals(obs, "week", "2026-09-17", 2).map((p) => p.total), [0, 240], "periodTotals: last two weeks");

const weights = Array.from({ length: 10 }, (_, i) => ({ at: `2026-09-${String(8 + i).padStart(2, "0")}`, num: 74.5 - i * 0.12 }));
const reach = goalStatus({ kind: "reach", shape: "number", target: 70, start: 74.5, deadline: "2026-12-01" }, weights, "2026-09-17");
check(reach.rate != null && reach.rate < 0, "reach: a falling series has a negative rate");
check(reach.projected_date !== null, "reach: a moving series projects a date");
eq(reach.verdict, "ahead", "reach: this rate arrives well before December");
const flat = goalStatus({ kind: "reach", shape: "number", target: 70, start: 74.5 },
  weights.map((w) => ({ ...w, num: 74.5 })), "2026-09-17");
eq(flat.verdict, "stalled", "reach: a flat series is stalled");
eq(goalStatus({ kind: "reach", shape: "number", target: 70 }, [], "2026-09-17").verdict, "no_data", "reach: nothing logged");
eq(goalStatus({ kind: "streak", shape: "bool", target: 1 }, obs, "2026-09-17").verdict, "no_data",
   "an unimplemented kind says no_data rather than guessing");

// ---------- spec validation ----------
const good = validateSpec({ name: "读书时长", shape: "duration", aliases: ["读书"], ask_at: "21:00", quick: [30, 60],
                            goal: { kind: "accumulate", target: 600, period: "week" } });
check(good.ok, "spec: a well-formed tracker validates");
check(good.ok && good.clean.aliases[0] === "读书时长", "spec: the name is always an alias");
check(!validateSpec({ name: "", shape: "duration" }).ok, "spec: an empty name is rejected");
check(!validateSpec({ name: "x", shape: "nope" as never }).ok, "spec: an unknown shape is rejected");
check(!validateSpec({ name: "x", shape: "duration", ask_at: "25:00" }).ok, "spec: a bad ask time is rejected");
check(!validateSpec({ name: "x", shape: "duration", goal: { kind: "accumulate", target: 0 } }).ok,
      "spec: an accumulate target of zero is rejected");

if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall checks passed");
