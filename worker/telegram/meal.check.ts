// Unit-ish checks for meal.ts (no test runner in this repo): `npm run check:meal`.
// Runs under Node's type stripping and touches no database or model: the `ml:` callback formats round-trip
// through parseCallback, the strict JSON of PRD-body §5.3 parses (and a broken reply does not), and the
// caption / kind / number rules that decide what a photo becomes hold.
// Importing callback.ts also loads the whole telegram module graph, so this is a cycle check too.

import { cb, parseCallback, type Callback } from "./callback.ts";
import {
  MEAL_CAPTION_RE, largestPhoto, mealKindAt, parseMealEstimate, parseMealNumbers, dishLine,
} from "./meal.ts";

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

parsesBackTo(cb.meal(7, "confirm"), { verb: "meal", mealId: 7, action: "confirm" }, "ml:<id>:y round-trips");
parsesBackTo(cb.meal(7, "edit"), { verb: "meal", mealId: 7, action: "edit" }, "ml:<id>:e round-trips");
parsesBackTo(cb.meal(7, "discard"), { verb: "meal", mealId: 7, action: "discard" }, "ml:<id>:x round-trips");
parsesBackTo(cb.meal(7, "estimate"), { verb: "meal", mealId: 7, action: "estimate" }, "ml:<id>:g round-trips");
check(parseCallback("ml:7:q") === null, "an unknown meal action is refused");
check(parseCallback("ml:0:y") === null, "meal id 0 is refused");
check(parseCallback("ml:7") === null, "a meal id with no action is refused");

// ---------- which photos are meals (§5.2) ----------

check(MEAL_CAPTION_RE.test("#meal"), "#meal makes a photo a meal");
check(MEAL_CAPTION_RE.test("#饭"), "#饭 makes a photo a meal");
check(MEAL_CAPTION_RE.test("午饭"), "饭 makes a photo a meal");
check(!MEAL_CAPTION_RE.test("窗外的天空"), "an ordinary caption is not a meal");
check(!MEAL_CAPTION_RE.test(""), "a photo with no caption is not a meal on its own");

check(mealKindAt(8 * 60) === "breakfast", "08:00 is breakfast");
check(mealKindAt(13 * 60) === "lunch", "13:00 is lunch");
check(mealKindAt(19 * 60 + 30) === "dinner", "19:30 is dinner");
check(mealKindAt(23 * 60) === "snack", "23:00 is a snack");

check(largestPhoto(undefined) === null, "a message with no photo has no size to download");
check(
  largestPhoto([{ file_id: "s", width: 90, height: 90, file_size: 1000 },
                { file_id: "l", width: 1280, height: 1280, file_size: 200_000 }])?.file_id === "l",
  "the largest size that fits is the one downloaded",
);
check(
  largestPhoto([{ file_id: "s", width: 90, height: 90, file_size: 1000 },
                { file_id: "huge", width: 4000, height: 4000, file_size: 9_000_000 }])?.file_id === "s",
  "an oversized picture falls back to a smaller size",
);

// ---------- the strict JSON of §5.3 ----------

const GOOD = `{"dishes":[{"name":"牛肉面","portion":"约 1 碗","kcal":580,"protein_g":28},{"name":"卤蛋","portion":"×1","kcal":70,"protein_g":6}],"total_kcal":650,"total_protein_g":34,"confidence":"medium"}`;
const parsed = parseMealEstimate(GOOD);
check(parsed?.total_kcal === 650 && parsed?.total_protein_g === 34, "the §5.3 shape parses");
check(parsed?.dishes.length === 2 && parsed.confidence === "medium", "the dishes and the confidence survive");
check(dishLine(parsed!) === "牛肉面（约 1 碗）、卤蛋（×1）", "the dish list is what gets stored and shown");

const fenced = parseMealEstimate("Sure!\n```json\n" + GOOD + "\n```\n");
check(fenced?.total_kcal === 650, "a fenced or chatty reply still yields the JSON");

const summed = parseMealEstimate(`{"dishes":[{"name":"米饭","kcal":200,"protein_g":4},{"name":"青菜","kcal":50,"protein_g":2}]}`);
check(summed?.total_kcal === 250 && summed?.total_protein_g === 6, "missing totals are the sum of the dishes");

const noNumbers = parseMealEstimate(`{"dishes":[{"name":"看不清的一盘菜"}],"confidence":"low"}`);
check(noNumbers?.total_kcal === null && noNumbers?.confidence === "low", "dishes without numbers keep no numbers");

check(parseMealEstimate("I can't tell what this is.") === null, "a reply with no JSON is a parse failure");
check(parseMealEstimate(`{"dishes":[]}`) === null, "an empty dish list is a parse failure");
check(parseMealEstimate(`{"dishes":[{"name":"x","kcal":999999}],"total_kcal":999999}`)?.total_kcal === null,
  "an absurd calorie count is dropped");

// ---------- ✏️ 改数字 ----------

check(same(parseMealNumbers("620"), { kcal: 620, protein_g: null }), "620");
check(same(parseMealNumbers("620/32"), { kcal: 620, protein_g: 32 }), "620/32");
check(same(parseMealNumbers(" 620 kcal 32g "), { kcal: 620, protein_g: 32 }), "620 kcal 32g");
check(parseMealNumbers("大概挺多的") === null, "free text is not an answer — it captures as usual");
check(parseMealNumbers("99999") === null, "an impossible calorie count is not an answer");

console.log("all checks passed");
