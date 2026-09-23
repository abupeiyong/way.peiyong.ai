// Meals (docs/PRD-body.md §5.2, §5.3, §11, §12). One photo — or one line — is one meal.
//   meal_*        → the three conditional asks (telegram_prefs.breakfast_at / lunch_at / dinner_at), sent only
//                   when a body plan exists and that meal has no log yet; `[跳过] [没吃]` and
//                   `awaiting_meal:<kind>` for 2 h
//   /meal …       → `/meal 午 牛肉面`: the meal from the word, else from the local time; with no text, the ask
//   router step 0 → a photo while `awaiting_meal:<kind>` is pending, or any photo captioned #meal / #饭,
//                   goes to analysis; every other photo keeps the plain "text and voice only" reply
//   router step 3 → a line while the ask is open is the meal itself: a row with the words and no numbers
//   analysis      → getFile + download into memory (never stored; meal_logs.tg_file_id is the only
//                   reference kept, so a better model can re-read the same photo later, §12)
//   model         → the OpenAI-compatible endpoint with image content when OPENAI_VISION_MODEL is set,
//                   otherwise Workers AI @cf/meta/llama-3.2-11b-vision-instruct; with neither the photo is
//                   still logged as a meal, with an empty estimate and a line saying why
//   JSON          → the strict shape of §5.3; a parse failure keeps the dishes the model could name and
//                   drops every number, and `confidence: low` adds 看不太清
//   ml:<id>:…     → ✓ 记下 · ✏️ 改数字 (a ForceReply for `kcal[/protein]`, user_edited = 1) · 🗑 不记 ·
//                   估算 (the same JSON from a text-only prompt, for a meal that has no numbers yet) ·
//                   🔄 重新分析 (reanalyzeMeal: the same photo read again by whatever vision model is
//                   configured now; POST /api/body/meal/:id/reanalyze runs the very same function, §13
//                   item 12, so the card and the web can never disagree about what a re-read does)
//   dish notes    → the numbers ✏️ 改数字 leaves on a one-dish meal are remembered per user and replace
//                   the model's the next time that dish is estimated, on every path above (§13 item 12)
//   ml:s|n:…      → 跳过 (nothing written; the day's outbox claim keeps the ask from repeating) · 没吃
//                   (an empty row for that meal, so the condition below reads it as answered)
//
// Every estimate carries the disclaimer; nothing here ever claims to be a measurement. Ten analyses per
// user per local day (telegram_events kind `photo`); the per-minute flood guard in webhook.ts already
// counts a photo like any other message, so this is the only extra limit.

import type { MealKind } from "../../shared/types.ts";
import { loadBodyPlan } from "../body.ts";
import type { GuideEnv } from "../guide.ts";
import { fmtMin } from "./blocks.ts";
import { cb, type CallbackContext } from "./callback.ts";
import { logEvent, logReply } from "./events.ts";
import type { Reply, TgMessage, TgPhotoSize } from "./router.ts";
import { localNow } from "./time.ts";

/**
 * The buttons of the confirm card (§5.2); `estimate` is the `[估算]` offered when a meal has no numbers,
 * `reanalyze` the `[🔄 重新分析]` offered on a meal that still has its photo (§13 item 12).
 */
export const MEAL_ACTIONS = ["confirm", "edit", "discard", "estimate", "reanalyze"] as const;
export type MealAction = (typeof MEAL_ACTIONS)[number];

/** The buttons of the ask itself (§5.2): 跳过 writes nothing, 没吃 writes an empty row for that meal. */
export const MEAL_PROMPT_ACTIONS = ["skip", "none"] as const;
export type MealPromptAction = (typeof MEAL_PROMPT_ACTIONS)[number];

/** The meals that get their own scheduled ask (§6); a snack is only ever logged by hand. */
export const MEAL_PROMPT_KINDS = ["breakfast", "lunch", "dinner"] as const;

/** How long a meal ask waits for the photo or the line (§5.2). */
export const MEAL_ASK_SECONDS = 2 * 60 * 60;
/** How long `✏️ 改数字` waits for the numbers. */
export const MEAL_NUMBERS_SECONDS = 2 * 60 * 60;
/** Photo analyses per user per local day (§12). */
export const PHOTO_ANALYSES_PER_DAY = 10;
/** Telegram photos are a few hundred KB; anything larger than this is not worth sending to a model. */
const MAX_PHOTO_BYTES = 4 * 1024 * 1024;

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";
const TEXT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

/** §5.3: every estimate says it is one. */
export const DISCLAIMER = "（估算，仅供参考 · rough estimate）";
const LOW_CONFIDENCE = "看不太清 · hard to tell";

/** A caption that turns a photo into a meal even with nothing pending (§5.2). */
export const MEAL_CAPTION_RE = /#meal|#饭|饭/i;
/** Only the hashtag forms are stripped from the description; a plain 饭 is part of what the user wrote. */
const MEAL_TAG_RE = /#meal\b|#饭/gi;

const KIND_LABEL: Record<MealKind, string> = {
  breakfast: "🍳 早饭 · Breakfast",
  lunch: "🍜 午饭 · Lunch",
  dinner: "🍲 晚饭 · Dinner",
  snack: "🍎 加餐 · Snack",
};

/** The ask of §5.2, one per meal. */
const ASK_TEXT: Record<MealKind, string> = {
  breakfast: "🍳 早饭吃了什么？发张照片或一句话 · Breakfast? A photo or a line",
  lunch: "🍜 午饭吃了什么？发张照片或一句话 · Lunch? A photo or a line",
  dinner: "🍲 晚饭吃了什么？发张照片或一句话 · Dinner? A photo or a line",
  snack: "🍎 加餐吃了什么？发张照片或一句话 · Snack? A photo or a line",
};

/** Which meal a photo or a `/meal` with no word is, from `minutes` past local midnight (§11). */
export function mealKindAt(minutes: number): MealKind {
  if (minutes < 10 * 60 + 30) return "breakfast";
  if (minutes < 15 * 60) return "lunch";
  if (minutes < 21 * 60) return "dinner";
  return "snack";
}

/** The words `/meal 早|午|晚|加餐 …` accepts. */
const KIND_WORDS: Record<string, MealKind> = {
  "早": "breakfast", "早饭": "breakfast", "早餐": "breakfast", "早上": "breakfast", breakfast: "breakfast",
  "午": "lunch", "午饭": "lunch", "午餐": "lunch", "中饭": "lunch", "中午": "lunch", lunch: "lunch",
  "晚": "dinner", "晚饭": "dinner", "晚餐": "dinner", dinner: "dinner", supper: "dinner",
  "加餐": "snack", "零食": "snack", "夜宵": "snack", snack: "snack",
};
/** The multi-character words that may be written straight against the food (`午饭牛肉面`), longest first. */
const GLUED_WORDS = Object.keys(KIND_WORDS).filter((w) => w.length > 1 && !/^[a-z]+$/.test(w))
  .sort((a, b) => b.length - a.length);

export function mealKindFromWord(word: string): MealKind | null {
  return KIND_WORDS[word.trim().toLowerCase()] ?? null;
}

/** `午 牛肉面`, `午饭牛肉面`, `牛肉面`, `` → which meal, and what was eaten (empty = open the ask). */
export function splitMealArgs(args: string, minutes: number): { kind: MealKind; text: string } {
  const trimmed = args.trim();
  const spaced = /^(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (spaced) {
    const kind = mealKindFromWord(spaced[1]);
    if (kind) return { kind, text: spaced[2].trim() };
  }
  const only = mealKindFromWord(trimmed);
  if (only) return { kind: only, text: "" };
  const glued = GLUED_WORDS.find((w) => trimmed.length > w.length && trimmed.startsWith(w));
  if (glued) return { kind: KIND_WORDS[glued], text: trimmed.slice(glued.length).trim() };
  return { kind: mealKindAt(minutes), text: trimmed };
}

// ---------- the model's JSON (§5.3) ----------

export interface MealDish {
  name: string;
  portion: string;
  kcal: number | null;
  protein_g: number | null;
}

export interface MealEstimate {
  dishes: MealDish[];
  total_kcal: number | null;
  total_protein_g: number | null;
  confidence: "low" | "medium" | "high" | null;
}

const SHAPE = `{"dishes":[{"name":"牛肉面","portion":"约 1 碗","kcal":620,"protein_g":32}],"total_kcal":620,"total_protein_g":32,"confidence":"low|medium|high"}`;
const RULES = [
  "Reply with ONE JSON object and nothing else — no prose, no code fence, no explanation:",
  SHAPE,
  'Name each dish the way the cuisine names it (Chinese for Chinese food); keep "portion" short ("1 碗", "×2", "半份").',
  "Numbers are rough estimates for what is actually there; use null for any number you cannot tell.",
  'Set "confidence" to "low" when the picture or the description is blurry, dark or ambiguous.',
].join("\n");

const PHOTO_PROMPT = `You estimate what a meal is from a photo.\n${RULES}`;
const TEXT_PROMPT = `You estimate what a meal is from the eater's own words.\n${RULES}`;

function num(v: unknown, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? Math.round(v) : null;
}

const MAX_KCAL = 10000;
const MAX_PROTEIN_G = 500;

/** The model's reply → the §5.3 shape, or null when there is no usable JSON object in it. */
export function parseMealEstimate(raw: string): MealEstimate | null {
  const start = raw.indexOf("{"), end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  const dishes = (Array.isArray(o.dishes) ? o.dishes : [])
    .map((d): MealDish | null => {
      const item = d as Record<string, unknown> | null;
      const name = typeof item?.name === "string" ? item.name.trim().slice(0, 60) : "";
      if (!name) return null;
      return {
        name,
        portion: typeof item?.portion === "string" ? item.portion.trim().slice(0, 30) : "",
        kcal: num(item?.kcal, MAX_KCAL),
        protein_g: num(item?.protein_g, MAX_PROTEIN_G),
      };
    })
    .filter((d): d is MealDish => d !== null)
    .slice(0, 12);
  if (!dishes.length) return null;
  const confidence = o.confidence === "low" || o.confidence === "medium" || o.confidence === "high" ? o.confidence : null;
  // A missing total is the sum of the dishes, so a model that only fills one level still gives a number.
  const sum = (pick: (d: MealDish) => number | null, max: number): number | null => {
    const parts = dishes.map(pick).filter((n): n is number => n !== null);
    return parts.length === dishes.length ? num(parts.reduce((a, b) => a + b, 0), max) : null;
  };
  return {
    dishes,
    total_kcal: num(o.total_kcal, MAX_KCAL) ?? sum((d) => d.kcal, MAX_KCAL),
    total_protein_g: num(o.total_protein_g, MAX_PROTEIN_G) ?? sum((d) => d.protein_g, MAX_PROTEIN_G),
    confidence,
  };
}

/** 牛肉面（约 1 碗）、卤蛋 ×1 — the dish list as it is stored and shown. */
export function dishLine(estimate: MealEstimate): string {
  return estimate.dishes.map((d) => (d.portion ? `${d.name}（${d.portion}）` : d.name)).join("、").slice(0, 300);
}

// ---------- per-dish corrections (§13 item 12) ----------

/** The dishes of a description are separated by 、, and a portion rides in brackets after the name. */
const DISH_SEPARATOR = /[、,]/;

/** `牛肉面（约 1 碗）` → `牛肉面`; lower-cased and capped, so the same dish always keys the same row. */
export function normalizeDish(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, " ")
    .replace(/[×xX*]\s*\d+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 40);
}

/** The dish names in a stored description, normalised; empty when it does not read as a dish list. */
export function dishesOf(description: string): string[] {
  return description.split(DISH_SEPARATOR).map(normalizeDish).filter((d) => d.length > 0);
}

/**
 * Remember the user's own numbers for a meal that is exactly one dish ("my 牛肉面 is ~550 kcal"), so the
 * next estimate of that dish uses them. A meal of several dishes teaches nothing: the correction cannot
 * be attributed to one of them, so nothing is written.
 */
export async function rememberDish(
  db: D1Database, userId: number, description: string, kcal: number | null, proteinG: number | null,
): Promise<string | null> {
  const dishes = dishesOf(description);
  if (dishes.length !== 1 || kcal === null) return null;
  try {
    await db.prepare(
      `INSERT INTO meal_dish_notes (user_id, dish, kcal, protein_g) VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, dish) DO UPDATE SET
         kcal = excluded.kcal, protein_g = COALESCE(excluded.protein_g, meal_dish_notes.protein_g),
         samples = meal_dish_notes.samples + 1, updated_at = datetime('now')`
    ).bind(userId, dishes[0], kcal, proteinG).run();
    return dishes[0];
  } catch (e) {
    console.error("telegram meal: dish note failed", e); // migration 0005 has not run here
    return null;
  }
}

/**
 * Replace the model's numbers with the user's own wherever a dish has been corrected before, then
 * re-total. Returns the dishes that were overridden, so the card can say whose numbers these are.
 */
export async function applyDishNotes(
  db: D1Database, userId: number, estimate: MealEstimate,
): Promise<{ estimate: MealEstimate; used: string[] }> {
  const wanted = [...new Set(estimate.dishes.map((d) => normalizeDish(d.name)).filter(Boolean))];
  if (!wanted.length) return { estimate, used: [] };
  let notes: { dish: string; kcal: number | null; protein_g: number | null }[] = [];
  try {
    const { results } = await db.prepare(
      `SELECT dish, kcal, protein_g FROM meal_dish_notes WHERE user_id = ? AND dish IN (${wanted.map(() => "?").join(",")})`
    ).bind(userId, ...wanted).all<{ dish: string; kcal: number | null; protein_g: number | null }>();
    notes = results;
  } catch {
    return { estimate, used: [] }; // migration 0005 has not run here
  }
  if (!notes.length) return { estimate, used: [] };
  const byDish = new Map(notes.map((n) => [n.dish, n]));
  const used: string[] = [];
  const dishes = estimate.dishes.map((d) => {
    const note = byDish.get(normalizeDish(d.name));
    if (!note || note.kcal === null) return d;
    used.push(d.name);
    return { ...d, kcal: note.kcal, protein_g: note.protein_g ?? d.protein_g };
  });
  if (!used.length) return { estimate, used: [] };
  const total = (pick: (d: MealDish) => number | null): number | null => {
    const parts = dishes.map(pick).filter((n): n is number => n !== null);
    return parts.length === dishes.length ? parts.reduce((a, b) => a + b, 0) : null;
  };
  return {
    estimate: { ...estimate, dishes, total_kcal: total((d) => d.kcal), total_protein_g: total((d) => d.protein_g) },
    used,
  };
}

/** The line the card adds when an estimate used numbers the user had corrected before. */
export function dishNoteLine(used: string[]): string {
  return `用了你改过的数字 · your own numbers for ${used.join("、")}`;
}

// ---------- the model calls ----------

/** Whether this deployment can read a photo at all (§5.3). */
export function hasVisionModel(env: GuideEnv): boolean {
  return !!(env.OPENAI_API_KEY && env.OPENAI_VISION_MODEL) || !!env.AI;
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

interface OpenAiChoices {
  choices?: { message?: { content?: string } }[];
}

async function openAiJson(env: GuideEnv, model: string, content: unknown): Promise<string> {
  const res = await fetch(`${env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, messages: [{ role: "user", content }] }),
  });
  if (!res.ok) throw new Error(`vision model error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ((await res.json()) as OpenAiChoices).choices?.[0]?.message?.content ?? "";
}

/** The raw model reply for one photo, or null when no vision model is configured. */
export async function analyzePhoto(env: GuideEnv, bytes: Uint8Array): Promise<string | null> {
  if (env.OPENAI_API_KEY && env.OPENAI_VISION_MODEL) {
    return openAiJson(env, env.OPENAI_VISION_MODEL, [
      { type: "text", text: PHOTO_PROMPT },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64(bytes)}` } },
    ]);
  }
  if (env.AI) {
    const out = await env.AI.run(VISION_MODEL, { prompt: PHOTO_PROMPT, image: [...bytes], max_tokens: 600 });
    return (out as { response?: string }).response ?? "";
  }
  return null;
}

/** The same JSON from a text-only prompt: `[估算]` on a meal that was typed, not photographed (§5.2). */
export async function analyzeText(env: GuideEnv, description: string): Promise<string | null> {
  const prompt = `${TEXT_PROMPT}\n\nThe meal: ${description.slice(0, 300)}`;
  if (env.OPENAI_API_KEY) return openAiJson(env, env.OPENAI_CHAT_MODEL ?? "gpt-5-nano", prompt);
  if (env.AI) {
    const out = await env.AI.run(TEXT_MODEL, { prompt, max_tokens: 600 });
    return (out as { response?: string }).response ?? "";
  }
  return null;
}

// ---------- the row ----------

export interface MealRow {
  id: number;
  date: string;
  time_min: number | null;
  kind: string;
  description: string;
  kcal: number | null;
  protein_g: number | null;
  user_edited: number;
  confidence: string | null;
  /** The Telegram photo this meal came from, when it came from one — what re-analysis re-reads (§12). */
  tg_file_id: string | null;
}

/** Every column the card needs, in one place: the confirm card is drawn from exactly these. */
const MEAL_COLUMNS = "id, date, time_min, kind, description, kcal, protein_g, user_edited, confidence, tg_file_id";

interface MealWrite {
  date: string;
  time_min: number;
  kind: MealKind;
  description: string;
  estimate: MealEstimate | null;
  tg_file_id: string | null;
  ai_json: string | null;
}

/** Insert one meal; null when migration 0004 has not run here. */
async function insertMeal(db: D1Database, userId: number, m: MealWrite): Promise<MealRow | null> {
  try {
    return await db.prepare(
      `INSERT INTO meal_logs (user_id, date, time_min, kind, description, kcal, protein_g, tg_file_id, ai_json, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING ${MEAL_COLUMNS}`
    ).bind(
      userId, m.date, m.time_min, m.kind, m.description.slice(0, 300),
      m.estimate?.total_kcal ?? null, m.estimate?.total_protein_g ?? null,
      m.tg_file_id, m.ai_json?.slice(0, 4000) ?? null, m.estimate?.confidence ?? null,
    ).first<MealRow>();
  } catch (e) {
    console.error("telegram meal: insert failed", e); // migration 0004 has not run here
    return null;
  }
}

export async function loadMeal(db: D1Database, userId: number, id: number): Promise<MealRow | null> {
  try {
    return await db.prepare(
      `SELECT ${MEAL_COLUMNS} FROM meal_logs WHERE id = ? AND user_id = ?`
    ).bind(id, userId).first<MealRow>();
  } catch {
    return null;
  }
}

/** Analyses already run today, so the eleventh photo is logged without calling a model (§12). */
async function analysesToday(db: D1Database, userId: number, date: string): Promise<number> {
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM telegram_events WHERE user_id = ? AND kind = 'photo' AND event = 'used' AND local_date = ?"
    ).bind(userId, date).first<{ n: number }>();
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// ---------- the confirm card (§5.2) ----------

function kindLabel(kind: string): string {
  return KIND_LABEL[kind as MealKind] ?? kind;
}

/** The card's text; `note` is the one line that explains an empty estimate. */
function mealText(row: MealRow, note?: string): string {
  const when = row.time_min === null ? "" : `  ${fmtMin(row.time_min)}`;
  const lines = [`${kindLabel(row.kind)}${when}`];
  if (row.description) lines.push(row.description);
  if (row.kcal !== null || row.protein_g !== null) {
    const kcal = row.kcal !== null ? `~${row.kcal} kcal` : "kcal —";
    const protein = row.protein_g !== null ? ` · 蛋白质 ~${row.protein_g} g` : "";
    lines.push(row.user_edited ? `${kcal}${protein}` : `估计 · est. ${kcal}${protein}`);
    if (!row.user_edited) lines.push(DISCLAIMER);
    if (!row.user_edited && row.confidence === "low") lines.push(LOW_CONFIDENCE);
  }
  if (note) lines.push(note);
  return lines.join("\n");
}

function mealCard(row: MealRow, note?: string): Reply {
  const buttons = [[
    { text: "✓ 记下", callback_data: cb.meal(row.id, "confirm") },
    { text: "✏️ 改数字", callback_data: cb.meal(row.id, "edit") },
    { text: "🗑 不记", callback_data: cb.meal(row.id, "discard") },
  ]];
  // Nothing to estimate from without a description, and nothing to re-estimate once there are numbers.
  if (row.kcal === null && row.description) {
    buttons.push([{ text: "估算 · estimate", callback_data: cb.meal(row.id, "estimate") }]);
  }
  // The photo is still on Telegram, so a better model can read it again (§13 item 12).
  if (row.tg_file_id) {
    buttons.push([{ text: "🔄 重新分析 · re-analyse", callback_data: cb.meal(row.id, "reanalyze") }]);
  }
  return { text: mealText(row, note), reply_markup: { inline_keyboard: buttons } };
}

const NO_VISION_NOTE = "这台服务器没有配置看图模型，照片先记下了 · No vision model here — the photo is logged, without numbers";
const LIMIT_NOTE = `今天的照片估算已用完（${PHOTO_ANALYSES_PER_DAY} 次），照片先记下了 · That's today's ${PHOTO_ANALYSES_PER_DAY} photo estimates — logged without numbers`;
const UNREADABLE_NOTE = "没算出数字 · Couldn't put numbers on it";
const EDITED_NOTE = "你改过这一餐的数字，重新分析会覆盖 · You set these numbers yourself — 先改回估算再试";
const NO_PHOTO_NOTE = "这一餐没有照片可以重看 · No photo to re-read";
const NO_MODEL_NOTE = "这台服务器没有配置模型 · No model is configured here";
const COULD_NOT_LOG = "没能记下 · Could not log it — 请稍后再试";

// ---------- awaiting_meal:<kind> (§5.2) ----------

interface MealState {
  kind: "awaiting_meal";
  /** Which meal was asked for. */
  meal: MealKind;
  /** The local date the answer belongs to, fixed when asked. */
  date: string;
  expires_at: number;
}

function isMealState(v: unknown): v is MealState {
  const s = v as Partial<MealState> | null;
  return !!s && typeof s === "object" && s.kind === "awaiting_meal"
    && typeof s.date === "string" && typeof s.expires_at === "number"
    && (s.meal === "breakfast" || s.meal === "lunch" || s.meal === "dinner" || s.meal === "snack");
}

/** `✏️ 改数字` is waiting for `kcal[/protein]` for one meal. */
interface MealNumbersState {
  kind: "awaiting_meal_numbers";
  meal_id: number;
  expires_at: number;
}

function isMealNumbersState(v: unknown): v is MealNumbersState {
  const s = v as Partial<MealNumbersState> | null;
  return !!s && typeof s === "object" && s.kind === "awaiting_meal_numbers"
    && typeof s.meal_id === "number" && typeof s.expires_at === "number";
}

// ---------- the meal ask (§5.2, §6): meal_breakfast / meal_lunch / meal_dinner ----------

/** The card the three scheduled asks (and `/meal` with no text) send; the buttons are `ml:s|n:<kind>:<date>`. */
export function mealAskCard(kind: MealKind, date: string): Reply {
  return {
    text: ASK_TEXT[kind],
    reply_markup: {
      inline_keyboard: [[
        { text: "跳过 · Skip", callback_data: cb.mealPrompt("skip", kind, date) },
        { text: "没吃 · Didn't eat", callback_data: cb.mealPrompt("none", kind, date) },
      ]],
    },
  };
}

export type MealAskContext = Pick<CallbackContext, "db" | "userId" | "today" | "state" | "send">;

/** Ask for one meal and wait 2 h for the answer — a photo (mealPhoto) or a line (mealAnswer). */
export async function askMeal(ctx: MealAskContext, kind: MealKind): Promise<void> {
  const state: MealState = {
    kind: "awaiting_meal", meal: kind, date: ctx.today, expires_at: Date.now() + MEAL_ASK_SECONDS * 1000,
  };
  await ctx.state.put(state, MEAL_ASK_SECONDS);
  await ctx.send(mealAskCard(kind, ctx.today));
}

/** True when today already has a log of this meal — and on an error, so nothing is asked twice. */
async function hasMealToday(db: D1Database, userId: number, date: string, kind: MealKind): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT 1 AS n FROM meal_logs WHERE user_id = ? AND date = ? AND kind = ? LIMIT 1")
      .bind(userId, date, kind).first<{ n: number }>();
    return !!row;
  } catch {
    return true; // migration 0004 has not run here
  }
}

/** The scheduler's condition (§6): a plan, and nothing logged for that meal today. 没吃 counts as logged. */
export async function mealAskDue(ctx: MealAskContext, kind: MealKind): Promise<boolean> {
  if (!(await loadBodyPlan(ctx.db, ctx.userId))) return false;
  return !(await hasMealToday(ctx.db, ctx.userId, ctx.today, kind));
}

export function sendMealAsk(ctx: MealAskContext, kind: MealKind): Promise<void> {
  return askMeal(ctx, kind);
}

// ---------- logging a meal by text (§5.2) ----------

export type MealTextContext = Pick<CallbackContext, "db" | "userId" | "today" | "timezone" | "send">;

/** One typed meal: the words as the description, no numbers — the card's `[估算]` is what asks for those. */
async function logMealText(ctx: MealTextContext, kind: MealKind, description: string, date: string): Promise<void> {
  const row = await insertMeal(ctx.db, ctx.userId, {
    date, time_min: localMinutes(ctx.timezone), kind, description,
    estimate: null, tg_file_id: null, ai_json: null,
  });
  await ctx.send(row ? mealCard(row) : { text: COULD_NOT_LOG });
}

/**
 * Router step 3: a typed answer while a meal ask is open. Everything the user writes is the meal, so an
 * empty line is the only thing that falls through to capture.
 */
export async function mealAnswer(ctx: MealTextContext & Pick<CallbackContext, "state">, text: string): Promise<boolean> {
  const state = await ctx.state.get();
  if (!isMealState(state)) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    return false;
  }
  const description = text.trim();
  if (!description) return false;
  await ctx.state.clear();
  await logReply(ctx.db, ctx.userId, `meal_${state.meal}`, ctx.today);
  await logMealText(ctx, state.meal, description, state.date);
  return true;
}

// ---------- /meal [早|午|晚|加餐] <text> (§11) ----------

const MEAL_USAGE: Reply = {
  text: "用法 · Usage: /meal 牛肉面\n可以先说哪一餐 · name the meal first if you like: /meal 午 牛肉面（早|午|晚|加餐）",
};

export async function mealCommand(ctx: CallbackContext, args: string): Promise<void> {
  const { kind, text } = splitMealArgs(args, localMinutes(ctx.timezone));
  if (!text) {
    await askMeal(ctx, kind);
    return;
  }
  if (text.length > 300) {
    await ctx.send(MEAL_USAGE);
    return;
  }
  await logMealText(ctx, kind, text, ctx.today);
}

// ---------- ml:s:<kind>:<date> · ml:n:<kind>:<date> ----------

/** `跳过` and `没吃` on a meal ask. 没吃 writes an empty row, so the ask does not come back for that meal. */
export async function mealPromptButton(
  ctx: CallbackContext, action: MealPromptAction, kind: MealKind, date: string,
): Promise<string> {
  await logReply(ctx.db, ctx.userId, `meal_${kind}`, ctx.today);
  const pending = await ctx.state.get();
  if (isMealState(pending) && pending.meal === kind && pending.date === date) await ctx.state.clear();
  if (action === "skip") {
    await ctx.finish(`⏭ 跳过 · Skipped\n${kindLabel(kind)}`);
    return "已跳过 · Skipped";
  }
  if (await hasMealToday(ctx.db, ctx.userId, date, kind)) {
    await ctx.finish(`${kindLabel(kind)} 已经记过了 · Already logged`);
    return "已记过 · Already logged";
  }
  const row = await insertMeal(ctx.db, ctx.userId, {
    date, time_min: localMinutes(ctx.timezone), kind, description: "",
    estimate: null, tg_file_id: null, ai_json: null,
  });
  if (!row) return COULD_NOT_LOG;
  await ctx.finish(`🍽 没吃 · Didn't eat\n${kindLabel(kind)}`);
  return "已记下 · Logged";
}

// ---------- the photo path ----------

export type MealPhotoContext =
  Pick<CallbackContext, "db" | "userId" | "today" | "timezone" | "state" | "send" | "typing" | "guide" | "bot">;

/** The largest size Telegram offers that is still worth downloading; sizes come ordered smallest first. */
export function largestPhoto(sizes: TgPhotoSize[] | undefined): TgPhotoSize | null {
  if (!sizes?.length) return null;
  const fits = sizes.filter((p) => (p.file_size ?? 0) <= MAX_PHOTO_BYTES);
  return fits.length ? fits[fits.length - 1] : sizes[0];
}

function localMinutes(timezone: string | null): number {
  try {
    return localNow(timezone || "UTC").minutes;
  } catch {
    return localNow("UTC").minutes;
  }
}

/**
 * Router step 0: a photo. True when it was taken as a meal — while a meal ask is open, or with a
 * `#meal` / `饭` caption. Every other photo returns false and keeps the plain "text and voice only" reply.
 */
export async function mealPhoto(ctx: MealPhotoContext, message: TgMessage, caption: string): Promise<boolean> {
  const photo = largestPhoto(message.photo);
  if (!photo) return false;
  const pending = await ctx.state.get();
  const asked = isMealState(pending) && Date.now() <= pending.expires_at ? pending : null;
  if (!asked && !MEAL_CAPTION_RE.test(caption)) return false;

  const kind = asked?.meal ?? mealKindAt(localMinutes(ctx.timezone));
  const note = caption.replace(MEAL_TAG_RE, " ").trim();
  if (asked) {
    await ctx.state.clear();
    await logReply(ctx.db, ctx.userId, `meal_${kind}`, ctx.today);
  }

  const write: MealWrite = {
    date: ctx.today,
    time_min: localMinutes(ctx.timezone),
    kind,
    description: note,
    estimate: null,
    tg_file_id: photo.file_id,   // the reference stays; the bytes below never leave memory (§12)
    ai_json: null,
  };
  let cardNote: string | undefined;

  if (!hasVisionModel(ctx.guide)) {
    cardNote = NO_VISION_NOTE;
  } else if ((await analysesToday(ctx.db, ctx.userId, ctx.today)) >= PHOTO_ANALYSES_PER_DAY) {
    cardNote = LIMIT_NOTE;
  } else {
    await logEvent(ctx.db, ctx.userId, "photo", "used", { local_date: ctx.today });
    await ctx.typing();
    const raw = await readPhoto(ctx, photo.file_id);
    if (raw === null) {
      await logEvent(ctx.db, ctx.userId, "photo", "error", { local_date: ctx.today });
      cardNote = UNREADABLE_NOTE;
    } else {
      write.ai_json = raw;
      const parsed = parseMealEstimate(raw);
      if (parsed) {
        const { estimate, used } = await applyDishNotes(ctx.db, ctx.userId, parsed);
        write.estimate = estimate;
        write.description = dishLine(estimate) || note;
        if (used.length) cardNote = dishNoteLine(used);
      } else {
        // §5.3: a parse failure keeps what the model could read and drops every number.
        write.description = note || raw.replace(/\s+/g, " ").trim().slice(0, 200);
        cardNote = UNREADABLE_NOTE;
      }
    }
  }

  const row = await insertMeal(ctx.db, ctx.userId, write);
  await ctx.send(row ? mealCard(row, cardNote) : { text: COULD_NOT_LOG });
  return true;
}

/** Download into memory and ask the model; null on any failure along the way. */
async function readPhoto(ctx: Pick<CallbackContext, "guide" | "bot">, fileId: string): Promise<string | null> {
  try {
    const file = await ctx.bot.getFile(fileId);
    if (!file.ok || !file.result.file_path) return null;
    const bytes = new Uint8Array(await ctx.bot.downloadFile(file.result.file_path));
    return await analyzePhoto(ctx.guide, bytes);
  } catch (e) {
    console.error("telegram meal: photo analysis failed", e);
    return null;
  }
}

// ---------- ml:<id>:<action> ----------

/** `620`, `620/32`, `620 kcal 32g` — the numbers `✏️ 改数字` accepts; anything else is not an answer. */
export function parseMealNumbers(text: string): { kcal: number; protein_g: number | null } | null {
  const m = /^\s*(\d{1,5})\s*(?:kcal|大卡|千卡|卡)?\s*(?:[\/,、]|\s)?\s*(?:蛋白质?\s*)?(\d{1,3})?\s*(?:g|克)?\s*$/i.exec(text);
  if (!m) return null;
  const kcal = Number(m[1]);
  if (!Number.isFinite(kcal) || kcal > MAX_KCAL) return null;
  const protein = m[2] === undefined ? null : Number(m[2]);
  if (protein !== null && (!Number.isFinite(protein) || protein > MAX_PROTEIN_G)) return null;
  return { kcal, protein_g: protein };
}

export async function mealButton(ctx: CallbackContext, mealId: number, action: MealAction): Promise<string> {
  const row = await loadMeal(ctx.db, ctx.userId, mealId);
  if (!row) return "找不到这餐 · Meal not found";
  switch (action) {
    case "confirm":
      await ctx.finish(`✓ ${mealText(row)}`);
      return "已记下 · Logged";
    case "discard": {
      await ctx.db.prepare("DELETE FROM meal_logs WHERE id = ? AND user_id = ?").bind(mealId, ctx.userId).run();
      await ctx.finish(`🗑 没记 · Not logged\n${kindLabel(row.kind)}`);
      return "已删除 · Discarded";
    }
    case "edit": {
      const state: MealNumbersState = {
        kind: "awaiting_meal_numbers", meal_id: mealId, expires_at: Date.now() + MEAL_NUMBERS_SECONDS * 1000,
      };
      await ctx.state.put(state, MEAL_NUMBERS_SECONDS);
      await ctx.send({
        text: "多少 kcal？（可以带蛋白质）· How many kcal? (protein optional)\n例如 · e.g. 620 或 620/32",
        reply_markup: { force_reply: true, input_field_placeholder: "620/32" },
      });
      return "回复数字 · Reply with the numbers";
    }
    case "estimate": {
      if (!row.description) return "没有可估算的内容 · Nothing to estimate from";
      await ctx.typing();
      let raw: string | null = null;
      try {
        raw = await analyzeText(ctx.guide, row.description);
      } catch (e) {
        console.error("telegram meal: text estimate failed", e);
      }
      const parsed = raw === null ? null : parseMealEstimate(raw);
      if (!parsed || (parsed.total_kcal === null && parsed.total_protein_g === null)) {
        await ctx.edit(mealCard(row, raw === null ? NO_MODEL_NOTE : UNREADABLE_NOTE));
        return raw === null ? NO_MODEL_NOTE : UNREADABLE_NOTE;
      }
      const { estimate, used } = await applyDishNotes(ctx.db, ctx.userId, parsed);
      const updated = await setMealNumbers(ctx, mealId, estimate.total_kcal, estimate.total_protein_g, {
        confidence: estimate.confidence, userEdited: false,
      });
      await ctx.edit(mealCard(updated ?? row, used.length ? dishNoteLine(used) : undefined));
      return "已估算 · Estimated";
    }
    case "reanalyze": return mealReanalyze(ctx, row);
  }
}

/** Why a re-read did or did not happen (§13 item 12); the card and `POST /api/body/meal/:id/reanalyze` share it. */
export type MealReanalysisStatus = "ok" | "no_photo" | "user_edited" | "no_model" | "limit" | "unreadable";

export interface MealReanalysis {
  status: MealReanalysisStatus;
  /** The meal as it stands afterwards; the row untouched unless `status` is "ok". */
  row: MealRow;
  /** The dishes whose numbers came from a correction of the user's, for `dishNoteLine`. */
  used: string[];
  /** The one line that explains the outcome; absent when there is nothing to add. */
  note?: string;
}

/** Everything a re-read needs: the row's owner, the day's analysis budget, the models and the Bot API. */
export type MealReanalyzeContext =
  Pick<CallbackContext, "db" | "userId" | "today" | "guide" | "bot"> & { typing?: () => Promise<void> };

/**
 * Read the same photo again with whatever vision model is configured now (§13 item 12). Telegram keeps
 * the file behind `tg_file_id` alive, so nothing had to be stored for this. Numbers the user typed
 * themselves are never overwritten — the re-read is refused instead — and a re-read counts against the
 * day's ten analyses like any other.
 */
export async function reanalyzeMeal(ctx: MealReanalyzeContext, row: MealRow): Promise<MealReanalysis> {
  if (!row.tg_file_id) return { status: "no_photo", row, used: [], note: NO_PHOTO_NOTE };
  if (row.user_edited) return { status: "user_edited", row, used: [], note: EDITED_NOTE };
  if (!hasVisionModel(ctx.guide)) return { status: "no_model", row, used: [], note: NO_VISION_NOTE };
  if ((await analysesToday(ctx.db, ctx.userId, ctx.today)) >= PHOTO_ANALYSES_PER_DAY) {
    return { status: "limit", row, used: [], note: LIMIT_NOTE };
  }
  await logEvent(ctx.db, ctx.userId, "photo", "used", { local_date: ctx.today });
  await ctx.typing?.();
  const raw = await readPhoto(ctx, row.tg_file_id);
  const parsed = raw === null ? null : parseMealEstimate(raw);
  if (!parsed) {
    await logEvent(ctx.db, ctx.userId, "photo", "error", { local_date: ctx.today });
    return { status: "unreadable", row, used: [], note: UNREADABLE_NOTE };
  }
  const { estimate, used } = await applyDishNotes(ctx.db, ctx.userId, parsed);
  const updated = await setMealNumbers(ctx, row.id, estimate.total_kcal, estimate.total_protein_g, {
    confidence: estimate.confidence, userEdited: false, description: dishLine(estimate) || row.description,
    aiJson: raw ?? undefined,
  });
  return { status: "ok", row: updated ?? row, used, note: used.length ? dishNoteLine(used) : undefined };
}

/** `🔄 重新分析`: the re-read above, then the card redrawn with whatever it has to say. */
async function mealReanalyze(ctx: CallbackContext, row: MealRow): Promise<string> {
  const result = await reanalyzeMeal(ctx, row);
  // Nothing to redraw when there was never a photo: the card is already right.
  if (result.status === "no_photo") return NO_PHOTO_NOTE;
  await ctx.edit(mealCard(result.row, result.note));
  if (result.status === "ok") return "已重新分析 · Re-analysed";
  if (result.status === "user_edited") return "你改过数字了 · Your own numbers";
  return result.note ?? UNREADABLE_NOTE;
}

async function setMealNumbers(
  ctx: Pick<CallbackContext, "db" | "userId">, mealId: number,
  kcal: number | null, proteinG: number | null,
  opts: { confidence?: string | null; userEdited: boolean; description?: string; aiJson?: string },
): Promise<MealRow | null> {
  try {
    return await ctx.db.prepare(
      `UPDATE meal_logs SET kcal = ?, protein_g = COALESCE(?, protein_g), user_edited = ?, confidence = ?,
              description = COALESCE(?, description), ai_json = COALESCE(?, ai_json)
        WHERE id = ? AND user_id = ?
       RETURNING ${MEAL_COLUMNS}`
    ).bind(
      kcal, proteinG, opts.userEdited ? 1 : 0, opts.confidence ?? null,
      opts.description?.slice(0, 300) ?? null, opts.aiJson?.slice(0, 4000) ?? null,
      mealId, ctx.userId,
    ).first<MealRow>();
  } catch (e) {
    console.error("telegram meal: update failed", e);
    return null;
  }
}

/**
 * Router step 3: the typed answer while `✏️ 改数字` is open. Anything that is not a number falls through
 * to capture with the slot left open, exactly like the weight and workout asks.
 */
export async function mealNumbersAnswer(
  ctx: Pick<CallbackContext, "db" | "userId" | "state" | "send">, text: string,
): Promise<boolean> {
  const state = await ctx.state.get();
  if (!isMealNumbersState(state)) return false;
  if (Date.now() > state.expires_at) {
    await ctx.state.clear();
    return false;
  }
  const numbers = parseMealNumbers(text);
  if (!numbers) return false;
  // The user's numbers replace the estimate and stop being one (§5.2).
  const row = await setMealNumbers(ctx, state.meal_id, numbers.kcal, numbers.protein_g, { userEdited: true });
  await ctx.state.clear();
  // A one-dish meal teaches the next estimate of that dish (§13 item 12).
  const learned = row ? await rememberDish(ctx.db, ctx.userId, row.description, numbers.kcal, numbers.protein_g) : null;
  await ctx.send({
    text: row
      ? `✓ ${mealText(row)}${learned ? `\n下次 ${learned} 就用这个数 · remembered for next time` : ""}`
      : COULD_NOT_LOG,
  });
  return true;
}
