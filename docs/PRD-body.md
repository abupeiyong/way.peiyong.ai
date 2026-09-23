# PRD — Body: weight, meals and workouts through Telegram

**Status:** Draft for implementation
**Author:** Peiyong (with Claude)
**Date:** 2026-09-20
**Builds on:** `docs/PRD-telegram.md` (the bot, scheduler, callback protocol, Guide threads)
**Applies to:** `way.peiyong.ai` (worker `way`, D1 `way-preview-db`)

---

## 1. Summary

A goal like *"Get to 72 kg by December"* is the most common kind of goal people set and the one
Way currently helps least with: progress is a percentage the user types by hand. This PRD makes a
weight goal **measurable and conversational**:

1. When a goal is about body weight, the user attaches a **body plan** to it (start, target,
   weekly workouts, optional daily calories). That is the configuration switch.
2. The bot **asks for the weight** every morning and accepts a weight **at any time**
   (`/weight 72.4`, or just "72.4").
3. The bot **asks about meals and workouts** at the right times; a meal can be a **photo**, which
   the AI turns into dishes and a rough calorie/protein estimate; a workout is an activity and minutes.
4. The server keeps the logs and **projects** — deterministically, from the weight trend — when the
   target will be reached, then tells the user whether the goal is on track, and the Guide turns
   that into concrete advice about eating and training.

Everything follows the decisions already on record: one shared bot, **buttons and commands first,
natural language falls back to the Guide**, nothing written by the model without approval.

---

## 2. Goals and non-goals

### Goals
- G1 — A user with a weight goal never types a progress percentage again: `goals.progress` is
  derived from the weight trend.
- G2 — Weighing in takes one reply. Logging a meal takes one photo. Logging a workout takes one line.
- G3 — Every morning the user knows: today's weight, the 7-day trend, and the projected date.
- G4 — Reminders are conditional (only when something is missing) and rule-based; the Guide adds
  judgement, not nagging.
- G5 — Every number the bot shows is reproducible from the logs; the AI estimates are labelled as estimates.

### Non-goals
- Medical advice, diagnoses, or anything that reads as a prescription. Way says *"estimate"* and *"on
  average"* and links to nothing.
- Storing photos. Telegram keeps the file; Way keeps the `file_id`, the AI's description and the numbers.
- Wearable / Apple Health / Google Fit integrations. Manual entry and photos only.
- Multi-metric goals (waist, body fat, steps). The plan is weight-only in this round; the schema
  leaves room (see §7).

---

## 3. Concepts

| Term | Meaning |
|---|---|
| **Weight goal** | An ordinary `goals` row (any level) that has a **body plan** attached. |
| **Body plan** | One row per user (`body_plans`): which goal it serves, start/target kg, the goal's `target_date`, weekly workout target, optional daily kcal budget. This is the "config". |
| **Weigh-in** | One `weight_logs` row per local date (upsert; the latest reading of the day wins). |
| **Meal log** | A `meal_logs` row: which meal, what (text or photo), the AI's dish list and estimate, the user's corrections. |
| **Workout log** | A `workout_logs` row: activity, minutes, optional intensity and note. |
| **Trend** | The 7-day moving average of weigh-ins; the number every projection uses, never a single reading. |
| **Projection** | Linear fit over the last 28 days of trend → kg/week → the date the target is reached. |

---

## 4. Turning it on — the body plan

### 4.1 Where
Goals page → a goal's detail → **身体计划 · Body plan** section. Fields: start weight (defaults to
the latest weigh-in), target weight, weekly workouts (default 3), daily kcal budget (optional),
unit for input (kg / 斤 / lb; storage is always kg). Saving creates or replaces the user's
`body_plans` row and points it at this goal.

### 4.2 Nudging the user to turn it on
- Web: when a goal's title matches `/体重|减肥|减重|增肌|瘦|weight|lose|gain|kg|lb/i` and no body plan
  exists, the goal card shows *"这是体重目标？开启体重追踪 · Track this as a weight goal"*.
- Guide: `guideContext` lists the plan when present; when absent and such a goal exists, the
  system prompt tells the model it may propose `set_body_plan` (§9).
- Bot: `/body` with no plan replies with the same offer and a deep link to the goal.

Nothing is switched on automatically.

### 4.3 What turning it on changes
- `telegram_prefs` gets its body slots filled from defaults (§6) if they are NULL.
- `goals.progress` becomes **derived** for that goal: `clamp((start − trend) / (start − target))`
  for loss, mirrored for gain; recomputed on every weigh-in and shown read-only on the web.
- The morning message gains a body line (§6.1).

Detaching the plan (or completing/abandoning the goal) stops every body prompt; the logs stay.

---

## 5. Logging

### 5.1 Weight

| Path | Behaviour |
|---|---|
| Morning prompt (`weigh_in` kind) | *"今天体重？ · Weight today?"* with `[跳过今天]`; `telegram_state = awaiting_weight` for 3 h |
| Reply while waiting | parsed as a weight |
| `/weight 72.4` | always |
| Bare text matching the weight pattern **while a body plan exists** | logged immediately with `[撤销，记进 Inbox]` — fast path over capture, one tap to undo |
| Web | Body page, date + kg |

**Weight pattern** (strict, to keep capture safe): `^\s*(体重|weight)?\s*(\d{2,3}(?:[.,]\d)?)\s*(kg|公斤|斤|lb|lbs|磅)?\s*$`
→ kg = value × {kg:1, 斤:0.5, lb:0.4536}; accepted only in `[30, 300]` kg. Anything else is not a
weight and goes to capture as usual. "72" alone therefore logs 72 kg only when a plan exists.

Echo: `⚖️ 72.4 kg · 7日均 72.9 ↓0.3 · 距目标 0.4 kg` plus, on the first weigh-in of the week, the
projection line (§8).

### 5.2 Meals

| Path | Behaviour |
|---|---|
| Meal prompts (`meal_breakfast` / `meal_lunch` / `meal_dinner` kinds) | fire at the slot **only if that meal has no log yet**; *"午饭吃了什么？发张照片或一句话 · Lunch? A photo or a line"* with `[跳过] [没吃]`; `awaiting_meal:<kind>` for 2 h |
| Reply with a **photo** while waiting, or any photo with caption `#meal` / `饭` | vision analysis (§5.3) → confirm card |
| Reply with text while waiting | `meal_logs` row with `description`; no estimate unless the user taps `[估算]` |
| `/meal 午饭 牛肉面` | kind inferred from the word (早/午/晚/加餐 · breakfast/lunch/dinner/snack) or from the local time |
| Any other photo (no plan, no wait, no caption) | current behaviour: *text and voice only* — unchanged |

The confirm card:

```
🍜 午饭 · Lunch  13:05
牛肉面（约 1 碗）、卤蛋 ×1、青菜
估计 · est. ~620 kcal · 蛋白质 ~32 g
（估算，仅供参考 · rough estimate）

[✓ 记下]  [✏️ 改数字]  [🗑 不记]
```

`✏️ 改数字` opens a ForceReply for `kcal[/protein]`; the user's numbers override the estimate and
are marked `user_edited = 1`.

### 5.3 Photo analysis
- Download via `getFile` (already in `api.ts`); never persisted. `meal_logs.tg_file_id` allows re-analysis.
- Model: the OpenAI-compatible endpoint with image content **when `OPENAI_VISION_MODEL` is set**;
  otherwise Workers AI `@cf/meta/llama-3.2-11b-vision-instruct`. Local dev has neither → the bot
  says so and stores the photo reference with an empty estimate.
- Prompt returns strict JSON: `{"dishes":[{"name":"…","portion":"…","kcal":620,"protein_g":32}],"total_kcal":…,"total_protein_g":…,"confidence":"low|medium|high"}`.
  Parsing failure → the card shows the dishes it could read and no numbers.
- Every estimate carries the disclaimer line. Confidence `low` shows *"看不太清 · hard to tell"*.

### 5.4 Workouts

| Path | Behaviour |
|---|---|
| Evening prompt (`workout_check` kind, default 20:30) | fires **only if no workout logged today**; *"今天动了吗？ · Did you move today?"* with `[没有，休息日] [🏃 跑步] [🏋️ 力量] [🚶 走路] [其他…]` |
| Tap an activity | ForceReply for minutes (`30`) |
| `/workout 跑步 30` · `/workout run 30 min` · `/workout 力量 45 高强度` | activity, minutes, optional intensity (低/中/高 · easy/moderate/hard) |
| Free text `跑了 5 公里 30 分钟` | **not** parsed — capture as usual; the Guide may propose `log_workout` |
| A **task** completed whose title matches `/跑步|健身|力量|游泳|骑行|瑜伽|run|gym|swim|bike|yoga|workout/i` | the ✓ handler offers `[记为运动 30分]` using `actual_min`/`estimate_min` |
| Web | Body page, activity + minutes |

---

## 6. Prompts and reminders

All slots live in `telegram_prefs`, local `HH:MM`, NULL = off, filled from defaults when the body
plan is created. They obey quiet hours, `paused_until` and the outbox claim exactly like the
existing kinds (one `KINDS` entry each, with a `condition`).

| Kind | Default | Condition | Content |
|---|---|---|---|
| `weigh_in` | 07:00 (`weigh_at`) | plan exists · no weigh-in today | the weight ask |
| `meal_breakfast` | 08:30 (`breakfast_at`) | plan exists · no breakfast log | the meal ask |
| `meal_lunch` | 13:00 (`lunch_at`) | … | … |
| `meal_dinner` | 19:30 (`dinner_at`) | … | … |
| `workout_check` | 20:30 (`workout_at`) | plan exists · no workout today | the workout ask |
| `body_nudge` | 12:00, conditional | see rules | at most **one** nudge per day, the highest-priority rule |
| `body_recap` | Sunday, with `weekly_review` | plan exists | the week's numbers + projection + Guide advice (§8) |

### 6.1 Morning message
When a plan exists, the morning message (`compose.ts`) gains one block after 今日 · Today:

```
⚖️ 身体 · Body
  72.4 kg · 7日均 72.9 ↓0.3/周 · 目标 70.0 by Dec 1
  预计 · projected Nov 18 ✓ ahead by 2 weeks
  本周运动 2/3 · 昨日 ~1,850 kcal
```

If today's weigh-in is missing the block ends with the ask and sets `awaiting_weight`, instead of
sending a separate `weigh_in` message — **one morning message** stays the rule. `weigh_in` as a
separate kind fires only when `morning_at` is off.

### 6.2 Nudge rules (deterministic, checked at 12:00 local)
Priority order; the first true rule sends, the rest wait for another day:

1. **No weigh-in for 3 days** → *"三天没称体重了 · No weigh-in for 3 days"* + `[现在称 ⚖️]`
2. **Weekly workouts behind pace** (e.g. Thursday with 0 of 3) → *"这周还没运动，剩 4 天 · 0 of 3 this week"* + `[今天安排 30 分钟]` (creates a task via the existing `create_task` path)
3. **Trend moving the wrong way for 2 weeks** → *"两周均值在涨 · trend up two weeks running"* + `[问道引 🤖]`
4. **Calories over budget 3 days running** (only with a kcal budget and logged meals) → *"连续 3 天超预算 · over budget 3 days"* + `[看看饮食]`

No streak language, no guilt. Each rule fires at most once per 7 days per rule (`telegram_outbox_log`
kind `body_nudge:<rule>` keyed by the week's Monday).

---

## 7. Data model — `migrations/0004_body.sql`

```sql
CREATE TABLE body_plans (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id),
  goal_id          INTEGER NOT NULL REFERENCES goals(id),
  metric           TEXT NOT NULL DEFAULT 'weight',   -- room for waist/bodyfat later
  start_kg         REAL NOT NULL,
  target_kg        REAL NOT NULL,
  weekly_workouts  INTEGER NOT NULL DEFAULT 3,
  daily_kcal       INTEGER,                          -- NULL = no budget
  input_unit       TEXT NOT NULL DEFAULT 'kg',       -- kg|jin|lb, for display/parsing hints only
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE weight_logs (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  date       TEXT NOT NULL,                          -- local YYYY-MM-DD
  kg         REAL NOT NULL,
  source     TEXT NOT NULL DEFAULT 'telegram',       -- telegram|web|guide
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, date)
);

CREATE TABLE meal_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  date          TEXT NOT NULL,
  time_min      INTEGER,                             -- minutes from local midnight
  kind          TEXT NOT NULL,                       -- breakfast|lunch|dinner|snack
  description   TEXT NOT NULL DEFAULT '',            -- the user's words, or the AI's dish list
  kcal          INTEGER,
  protein_g     INTEGER,
  user_edited   INTEGER NOT NULL DEFAULT 0,
  tg_file_id    TEXT,                                -- Telegram photo, for re-analysis; never downloaded twice
  ai_json       TEXT,                                -- the model's raw JSON
  confidence    TEXT,                                -- low|medium|high
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_meal_logs_user_date ON meal_logs(user_id, date);

CREATE TABLE workout_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  date       TEXT NOT NULL,
  activity   TEXT NOT NULL,                          -- free text, normalised lower-case
  minutes    INTEGER NOT NULL,
  intensity  TEXT,                                   -- easy|moderate|hard
  note       TEXT NOT NULL DEFAULT '',
  task_id    INTEGER REFERENCES tasks(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_workout_logs_user_date ON workout_logs(user_id, date);

ALTER TABLE telegram_prefs ADD COLUMN weigh_at     TEXT;   -- '07:00' when a plan is created
ALTER TABLE telegram_prefs ADD COLUMN breakfast_at TEXT;   -- '08:30'
ALTER TABLE telegram_prefs ADD COLUMN lunch_at     TEXT;   -- '13:00'
ALTER TABLE telegram_prefs ADD COLUMN dinner_at    TEXT;   -- '19:30'
ALTER TABLE telegram_prefs ADD COLUMN workout_at   TEXT;   -- '20:30'
ALTER TABLE telegram_prefs ADD COLUMN body_nudges  INTEGER NOT NULL DEFAULT 1;
```

`shared/types.ts`: `BodyPlan`, `WeightLog`, `MealLog`, `WorkoutLog`, `BodySummary` (§8), the new
`TelegramPrefs` fields, and the new `GuideProposal` kinds (§9).

---

## 8. Projection and the recap

### 8.1 The numbers (`worker/body.ts`, shared by web, bot and Guide)

```
trend(date)      = mean of weigh-ins in [date−6, date]  (needs ≥ 2 readings, else null)
rate_kg_per_week = slope of least-squares fit of trend over the last 28 days × 7  (needs ≥ 7 readings)
remaining_kg     = trend(today) − target_kg            (sign by direction)
projected_date   = today + remaining_kg / |rate|       (null when rate ≈ 0 or against the goal)
verdict          = "ahead" | "on_track" (±7 days) | "behind" | "stalled" | "wrong_way" | "no_data"
progress         = clamp((start − trend) / (start − target), 0, 1)  → goals.progress
week             = { workouts_done, workouts_target, minutes, kcal_avg (logged days only), meals_logged }
```

`BodySummary` is one object with all of the above; `GET /api/body` returns it with the last 90
days of logs. Nothing here calls a model.

### 8.2 The Sunday recap (`body_recap`)
Sent with the weekly review, before its questions:

```
⚖️ 本周身体 · Body this week
  72.9 → 72.4 kg（7日均）· 本周 −0.5 · 4 周 −1.8
  运动 3/3 · 135 分钟 · 记录饮食 15/21 餐 · 平均 ~1,900 kcal
  预计 Nov 18 达到 70.0 kg · 比目标早 2 周 ✓

🤖 道引：…two sentences on what worked and one concrete change for next week…
[✓ 采用建议]  [看图表 📈]
```

The Guide turn is prompted with the summary and asked for **at most one** proposal
(`create_task`, `set_weekly_plan`, or `set_body_plan` to adjust the target date/kcal). When no model
is configured the recap is sent without the Guide paragraph.

### 8.3 "Can I make it?" — the user's question
`/body` and any Guide message mentioning the goal get the same deterministic answer first
(`verdict` + `projected_date` + the rate), then the Guide's reasoning. The model is told it may
**not** invent a projection: it reads `BodySummary` from context.

---

## 9. Guide

- `guideContext` gains a `Body:` line with the summary when a plan exists, or
  `Body: no plan (goal "…" looks like a weight goal)` when one is suggested.
- New proposal kinds (each touches `SYSTEM_PROMPT`, the union, `applyProposal`, `proposalLabel`):
  - `{"kind":"set_body_plan","goal_title":"…","start_kg":74.2,"target_kg":70,"weekly_workouts":3,"daily_kcal":1900}`
  - `{"kind":"log_workout","date":"…","activity":"run","minutes":30,"intensity":"moderate"}`
  - `{"kind":"log_weight","date":"…","kg":72.4}` (from a sentence like "I was 72.4 this morning")
- The Guide never logs a meal: meals come from the user or the photo path, not from prose.

---

## 10. Web

- **Goals page**: the body-plan section on a goal (§4.1); the derived, read-only progress; the
  "track as weight goal" offer.
- **Body page** (`/body`, 身体 · Body, nav after Reviews): weight chart (readings + 7-day trend + target
  line + projection), the week's workouts and meals, manual entry forms for all three, and the
  plan summary with `[Edit plan]`. Chart: inline SVG on the design tokens, no library.
- **Settings → Telegram**: the five body slots and the `body_nudges` toggle, hidden until a plan exists.
- **Insights**: a weight sparkline tile when a plan exists.

---

## 11. Bot surface

| Command | Behaviour |
|---|---|
| `/weight [n]` | log (with unit parsing) or show today/trend |
| `/meal [早\|午\|晚\|加餐] <text>` | log a meal by text; without text, open the ask |
| `/workout <activity> <minutes> [intensity]` | log; without args, the activity buttons |
| `/body` | the summary block + projection + `[📈 图表]` deep link + `[⚖️ 称重] [🍜 记饭] [🏃 记运动]` |
| callbacks | `wt:s:<date>` skip weigh-in · `wt:u:<date>` undo → inbox · `ml:<id>:y\|e\|x` meal confirm/edit/discard · `ml:s:<kind>:<date>` skip meal · `ml:n:<kind>:<date>` didn't eat · `wo:<code>` activity pick · `wo:t:<taskId>:<min>` from a done task · `bn:<rule>` nudge action |

New verbs go through `callback.ts` (format + parser + builder + `Widest`) as usual.

---

## 12. Security, privacy, safety

- Health data is the user's own; every query scoped by `userId` like everything else. No export,
  no sharing, no aggregation across users.
- Photos: downloaded to memory for one model call, never written to storage. `tg_file_id` only.
- The bot never gives medical advice; the Guide's system prompt for body turns includes: *"You are
  not a clinician. Speak about habits and averages. If the user reports a weight change over 1.5 kg
  in a week in either direction, or mentions an eating disorder, suggest they talk to a doctor and
  stop giving targets."*
- Rate limits: photo analysis counts as a Guide call (same flood guard); at most 10 photo analyses
  per user per day.

---

## 13. Phasing

### P0 — weigh in and know where you stand
1. Migration 0004, types, `worker/body.ts` (summary + projection), `GET /api/body`, derived progress.
2. Body plan UI on the Goals page + the offer for weight-looking goals.
3. Bot: `weigh_in` kind, `/weight`, the weight pattern fast path with undo, the morning body block.
4. `/body` command; Body page with the weight chart and manual weight entry.

**Acceptance:** a user attaches a plan, replies to the morning ask for 7 days, and the morning
message shows a trend, a rate and a projected date that match the numbers on the Body page;
`goals.progress` moved without anyone typing it.

### P1 — meals and workouts
5. Meal prompts (3 conditional kinds), `/meal`, text logging, the confirm card.
6. Photo analysis (vision model, strict JSON, disclaimer), `✏️ 改数字`.
7. Workouts: `/workout`, the evening check, the done-task offer; Body page lists both.
8. Nudge rules (§6.2) and the Sunday recap with the Guide paragraph; `body_nudges` toggle; body events in `/api/telegram/stats`.
9. Guide: context line + the three proposal kinds.

### P2 — smarter, quieter
10. Adaptive prompt times (learn from when the user actually logs; propose, don't change).
11. Monthly body report (weight trend to trend, workouts and minutes, average logged calories, the
    month's best week, and the projected date then vs now) as a message on the 1st and a Body-page
    section with month navigation.
12. Re-analysis of past photos when a better vision model is configured; per-dish corrections that improve later estimates ("my 牛肉面 is ~550 kcal").

---

## 14. Metrics
- Weigh-in rate: days with a reading / days with a plan.
- Prompt reply rate per kind (`weigh_in`, `meal_*`, `workout_check`) — reuse `telegram_events`.
- Photo analyses per week, and how often `✏️ 改数字` is used (estimate quality).
- Projection accuracy: at goal completion, projected vs actual date.
- Nudge acceptance: taps on a nudge's button / nudges sent.

## 15. Open questions
1. **斤 by default for Chinese users?** Storage is kg regardless; the question is display. Proposal: follow `input_unit`, default kg.
2. **Calories at all?** The estimates are rough. Proposal: keep them, always with the disclaimer, and make the budget optional — the trend is the truth, calories are a hint.
3. **Photo prompts and privacy fatigue** — three meal asks a day may be too many. Proposal: ship with all three on, watch reply rate, default to lunch + dinner if breakfast is ignored.
