# PRD — 全靠 AI 驱动 · Making Way fully AI-driven

**Status:** Draft for discussion — an audit and a plan, not yet scheduled
**Author:** Peiyong (with Claude)
**Date:** 2026-09-21
**Builds on:** `docs/PRD-brain.md`, which sets the architecture. This document audits the code as it
stands *after* the tracker layer shipped (`5377d60`), says precisely what "fully AI-driven" has to mean
to be worth doing, and answers the questions PRD-brain §19 left open.
**Applies to:** `way.peiyong.ai` (worker `way`, D1 `way-preview-db`)

---

## 1. The question, and the answer

The question is "how do we make Way fully AI-driven". The answer this document argues for:

> **Not by putting the model in more loops — by taking the developer out of them.**

Way is already AI-*assisted*: a model converses (`worker/guide.ts`), proposes (`shared/types.ts`
`GuideProposal`), and now provisions trackers (`worker/streams.ts` `provisionTracker`). What is *not*
AI-driven is everything that decides how the system behaves toward a particular person: which questions
it asks and when, what it notices, what it says in the morning, what it reviews on Sunday, what it
believes about you, what the web shows you. Every one of those is a decision a developer made once, in
code, for all users at once.

So "fully AI-driven" is a measurable statement about the *source* of each of those decisions, and the
work is a sequence of conversions:

```
today   developer writes the judgement  →  code executes it        (fixed for everyone)
target  model writes the judgement      →  runtime executes it     (per user, per week)
never   model executes the judgement                              (§13)
```

The third line is not a compromise; it is the thing that makes the second line safe enough to be worth
building. §2 argues that the alternative reading destroys the properties this codebase has already paid
for.

---

## 2. Two readings of 全靠 AI 驱动

**Reading A — the model is in the loop.** Every inbound message goes to a model. Every number is
produced by a model. Every screen is generated per request. There is no schema to speak of; the model
reads and writes a blob.

This is one week of work and it would destroy, specifically:

| property held today | where it comes from | what Reading A does to it |
|---|---|---|
| logging answers in < 200 ms and works with the model down, slow or unpaid | `router.ts` L0–L3; `parse.ts`; `stream.ts` | every log becomes a model round trip with a network failure mode; the habit the product depends on breaks the first time the key expires |
| the same number in the bot, the web and the Guide | `derive.ts` / `body.ts` are the only source; `shared/streams.ts` holds the wording | two clients ask the model twice and get two answers; the product's credibility is gone |
| a wrong interpretation costs one tap | `cb.obsUndo`, `wt:u:<date>`, the echo cards | a wrong interpretation is invisible, because there is no record of what was interpreted |
| `45 分钟` is 45 | `parseDuration` | a model returns `44` roughly never, which is exactly what makes it unfixable |

**Reading B — the model is the compiler.** Every recurring behaviour of the system is an artifact —
a row, a template, a threshold, a schedule, a set of words — authored by a model in conversation with
the user, approved by the user, stored, and then executed by deterministic code that never calls a
model again. The model is present at the moment a behaviour is *created* or *changed*, and absent every
time it *runs*.

PRD-brain §4 states this as three rules (R1–R3). The tracker layer is the first proof that it works:
`buildPattern` takes the *words* the model chose and builds the regex in code; `provisionTracker`
validates every field the model supplied; `goalStatus` computes the verdict the model is then allowed
to talk about. Nothing in that path calls a model, and all of it came out of a sentence the user typed.

**This document is Reading B applied to everything that is left.** The rest of it is the inventory.

---

## 3. Definition of done

Seven properties. Each is checkable, and none of them is "the model does more".

1. **No judgement about a particular person is compiled in.** No `DEFAULT_AREAS`, no fixed review
   questions, no fixed table of asks, no fixed nudge rules.
2. **A new tracker, ask, view, or goal shape is a row, not a deploy.** The escape hatch (§12 of
   PRD-brain) fires about once a month; more often means the vocabulary is wrong.
3. **The model can be switched off and the product still works.** Logging, derivation, asking, the
   dashboard and the review flow all continue; only conversation and the creation of new capabilities
   stop. This is a test, not an aspiration (§14).
4. **Every number traces to observations and a pure function.** One exception exists and is labelled
   as such (§13.2).
5. **What the system says today is decided by value and a budget, not by a timetable.** The user's
   attention is a metered resource with a ledger (§7).
6. **Everything the system believes about the user is visible and editable by the user** — facts,
   aliases, ask times, thresholds, verdict parameters.
7. **What the system cannot do becomes a recorded gap**, not a dead end.

---

## 4. The audit — where a developer's judgement is still compiled in

This is the actual work list. Ordered by how much of "AI-driven" each one blocks.

| # | compiled-in judgement | where | what it becomes |
|---|---|---|---|
| 1 | **The set of things the system ever says, and when** — 14 entries in a static array, 11 `HH:MM` columns, 4 flags | `telegram/schedule.ts` `KINDS`; `telegram/prefs.ts` `TELEGRAM_PREF_FIELDS` | rows in `agenda` (§6), scored by a budget (§7) |
| 2 | **Nothing enters the system unless it was pre-configured** — anything that misses a registered pattern becomes an inbox task | `telegram/router.ts` step 5 → 6; L4 is absent | L4 intake: closed classification, deterministic extraction, structured echo (§8) |
| 3 | **What the Guide knows about you is the last 12 messages** | `guide.ts` `guideChat`, `guideContext` | four memory tiers with provenance, and a page that shows them (§9) |
| 4 | **The review questions** — 5 periods, fixed wording, the same on a week you shipped a product and a week you were ill | `shared/reviews.ts` `REVIEW_QUESTIONS` | model-authored per period from what actually happened, stored before being asked (§10) |
| 5 | **Four of the six enumerated goal kinds have no maths** (`qualitative` being `goal_kind NULL`), so a `streak`/`reduce`/`maintain`/`complete` goal silently returns `no_data` | `derive.ts` `goalStatus`; `shared/streams.ts` `IMPLEMENTED_KINDS` | the remaining derivations; the vocabulary the model compiles into stays fixed at six |
| 6 | **The nine life areas** | `worker/users.ts` `DEFAULT_AREAS`, seeded in `createUser` | a conversational first session that produces direction, areas and one tracker (§10.2) |
| 7 | **The morning message's composition**, and the rule that there is one of it | `telegram/compose.ts` | a composed message assembled from the budget's top-ranked items (§7.3) |
| 8 | **The nudge rules** — four hand-written body rules, one adaptive-slot rule | `telegram/bodynudge.ts`, `telegram/adapt.ts` | the noticing engine over any stream (§7.4) |
| 9 | **The set of things the model may propose** — a 10-arm union, and adding an arm touches four files | `shared/types.ts`, `guide.ts` `SYSTEM_PROMPT`, `proposals.ts`, `shared/proposals.ts` | still a closed union (this is correct), but with a generated prompt fragment and one registry (§11.2) |
| 10 | **The web's pages and its per-domain code** — a 10-arm route switch, fixed Insights tiles, a bespoke Body page | `src/App.tsx`, `src/pages/Insights.tsx`, `src/pages/Body.tsx` | `Tracks.tsx`'s pattern — a view primitive chosen from shape and goal kind — applied to the home page (§11) |
| 11 | **Body is a second implementation of the tracker layer**, with its own four tables and ~2,500 lines across seven modules | `worker/body.ts`, `telegram/{weight,workout,meal,bodynudge,bodymonth,adapt}.ts`, migrations `0004`/`0005` | folded onto `streams`/`observations`, keeping meals as a connector (§12) |
| 12 | **Even the instrumentation is a fixed list** — the reply-rate query has the kind names in a SQL `IN` clause | `telegram/events.ts` `telegramStats` | derived from `agenda`, so a new ask is measured the day it exists |

Two observations about this list.

**It is mostly one bug repeated.** Items 1, 4, 6, 7, 8, 9, 12 are all the same shape: a set that should
be data is an array in a module. The tracker layer already escaped it once — `dueAsks` reads `ask_at`
off each row, and `telegram_outbox_log`'s claim is keyed on an arbitrary string (`stream:<id>`), so the
delivery machinery needs *no* change to serve arbitrary rows. The seam is already cut; the per-stream
loop just runs *after* the fixed one in `runUser` instead of replacing it.

**Item 2 is the only one a user would call a missing feature.** Everything else is architecture. A
sentence like *"今天跑了 5 公里，读了一小时书，明天要看牙医"* becomes one inbox task with the whole
sentence in it. That is the gap between "an app with a chat in it" and "a system driven by what you
say", and it is worth doing before the elegant refactors.

---

## 5. The AI is in the middle; it has to move to the edges

Way's model calls all sit in one place: the user opens a conversation and the model answers. The two
edges — what comes in, and what the system initiates — have no model in them at all, and the
meta-level (what the system is capable of) has a developer in it.

```
          IN                        MIDDLE                        OUT
  message ─┐                                                 ┌─ scheduled ask
  photo ───┤                                                 ├─ nudge
  voice ───┼──► L0–L3 deterministic ──► conversation ────────┼─► review prompt
  timer ───┤        (no model)          (model, today)       ├─ noticing        ← §7
  webhook ─┘             ▲                    │              └─ escalation
                         │                    ▼
                    §8 L4 intake        §9 memory                §12 self-extension
```

- **In (§8)** — the model classifies into a closed set of lanes and picks *which* stream; deterministic
  parsers still take every value. Cheap model, hard latency budget, falls through to today's behaviour
  when it is unavailable.
- **Out (§7)** — the model writes the wording and proposes the schedule; a deterministic budget decides
  whether anything is sent at all. This is the inversion that matters: *the model may say what, never
  whether.*
- **Memory (§9)** — extraction runs nightly over the day's messages, not per message, so context stays
  small and cost stays bounded.
- **Meta (§12 of PRD-brain)** — the gap log first, the auto-filing later.

---

## 6. The load-bearing refactor: `agenda`

One table replaces `KINDS`, the eleven pref slots, and the per-stream ask loop.

```sql
CREATE TABLE agenda (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  kind        TEXT NOT NULL,          -- the telegram_outbox_log claim key: 'morning' | 'stream:7' | 'review:daily' | 'notice:…'
  handler     TEXT NOT NULL,          -- which code renders it: morning | stream_ask | review | weekly_plan | notice | …
  params      TEXT NOT NULL DEFAULT '{}',   -- JSON for the handler (stream_id, review period, …)
  slot        TEXT,                   -- local HH:MM; NULL = not time-driven (the budget places it)
  window_min  INTEGER NOT NULL DEFAULT 15,
  cadence     TEXT NOT NULL DEFAULT 'daily',  -- daily | weekday:1 | monthday:1 | none
  weight      REAL NOT NULL DEFAULT 1,  -- value prior, decayed by observed reply rate (§7)
  origin      TEXT NOT NULL,          -- seed | user | model
  status      TEXT NOT NULL DEFAULT 'active',  -- active | paused | retired
  UNIQUE (user_id, kind)
);
```

- `handler` is a **fixed registry in code**, one function per renderer — the same discipline as the six
  shapes and the six goal kinds. The model may create rows and choose params; it may not invent a
  handler. That is R3 with a schema.
- `cadence` and `condition` stay code-side: `cadence` is an enum, and the "is there anything to say"
  check belongs to the handler, where it already lives (`weighInDue`, `mealAskDue`, `dueAsks`).
- Migration seeds today's 14 kinds as `origin = 'seed'` rows from each user's existing prefs, so
  behaviour on day one is identical. `dueKinds` becomes a query; `runUser`'s two loops become one.
- The Settings page stops being a form of 11 named time fields and becomes a list of the user's asks —
  which is the only version of that page that can describe a per-user system.
- `telegramStats` joins `agenda` instead of naming kinds in SQL (audit item 12), which closes the
  feedback loop the budget needs.

This is the highest-leverage change in the document: it is what makes §7, §10 and most of §4 possible,
and it is a refactor with a mechanical, behaviour-preserving first step.

---

## 7. The attention budget — the model says what, the runtime says whether

Strong proactivity (PRD-brain decision #2) is only survivable as a mechanism.

### 7.1 One queue, scored deterministically

Every tick, candidates from `agenda` (due by slot) plus candidates from the noticing engine (§7.4) are
scored. Nothing about the score is model-produced:

```
score = weight                      -- the row's value prior
      × reply_rate_prior(kind)      -- from telegram_events, Laplace-smoothed, floor 0.1
      × staleness(kind)             -- days since this kind last had anything to say
      × urgency(params)             -- time-critical and irreversible only (PRD-brain §9.3)
```

### 7.2 Caps are absolute

Per-day and per-week message caps; quiet hours as they are today; **one composed message** when
several items are due in the same window. Over budget means dropped, not deferred — a queue that
drains later is how a system arrives at 7 a.m. with yesterday's nagging.

### 7.3 The model's only job here is the wording

The runtime picks the items and assembles a deterministic bundle (numbers, verdicts, names). The model
turns that bundle into one paragraph and the buttons stay code-generated. If the model is unavailable,
a template renders the same bundle — uglier, identical in content. This is how `compose.ts` becomes
per-user without becoming unpredictable.

### 7.4 The noticing engine

Generalises `bodynudge.ts`'s four rules into detectors over *any* stream, each a pure function over
observations emitting a candidate with a reason:

```
trend reversal      the 7-day trend turned and held for N days
pace break          an accumulate goal crossed into `unreachable` (derive.ts already computes it)
silence             an active stream with no observation for N × its usual interval
goal drift          an active goal with no linked task and no observation for 18 days
plan/act mismatch   the week's stated theme has no task hours against it
```

The detector produces the *finding*; the model produces the *sentence*; the budget decides whether the
sentence is sent. A kind whose reply rate stays under ~20% for a month is down-ranked automatically and
then offered for removal — with `agenda.weight` as the place that decay is written down.

---

## 8. L4 intake — the missing edge

### 8.1 The contract

L4 runs **only** after L0–L3 miss, and returns a closed structure — never a value:

```jsonc
{ "items": [
  { "lane": "log",     "stream_id": 7, "span": "跑了 5 公里" },
  { "lane": "task",    "span": "明天要看牙医" },
  { "lane": "gap",     "span": "帮我盯着股价" },
  { "lane": "correct", "target": "obs:1421", "span": "那是跑步不是走路" },
  { "lane": "talk" }
] }
```

`span` is a **substring of the user's own message**, verified by the runtime to actually occur in it.
The value is then read out of that span by the same `parseShape` that L1 uses. A model that returns a
span it invented is rejected before anything is written — which reduces R1 from a prompt instruction to
a runtime check.

### 8.2 Auto-log at L3, confirm at L4

PRD-brain §8.4 says aggressive parsing is safe because being wrong costs one tap. That is true when the
words were the user's own (L3, aliases they chose). It is weaker when a model picked the stream, so:

- **one item, high confidence, a stream whose bounds hold the value** → log it, echo it, with 撤销.
- **several items, or any ambiguity** → the structured echo card with per-item `[记下]` / `[改]`, and
  nothing is written until a tap. One card, not three messages.

### 8.3 Degradation and cost

A timeout, an error, or no key at all means the message falls through to inbox capture — exactly
today's behaviour. L4 is therefore strictly additive, and the small-model call happens on the minority
of messages that L0–L3 could not resolve, which is also the definition of the ≥ 90% deterministic
target (PRD-brain §18).

### 8.4 A correction is a proposal, not a silent lesson

`lane: "correct"` fixes the record immediately (deterministic, it names a row), and *then* offers
*「以后「走了 X」也算跑步？[是][否]」*. A yes adds an alias through `updateStream`, which already refuses
aliases that would collide with another stream. Learning the user's shorthand is thus a durable row the
user can see and delete — R3 again, and the mechanism by which the deterministic share grows over time
instead of the model's share.

---

## 9. Memory — with provenance, and visible

```sql
CREATE TABLE facts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  tier        TEXT NOT NULL,      -- profile | episodic | behaviour
  text        TEXT NOT NULL,      -- "never trains on Wednesdays"
  source      TEXT NOT NULL,      -- guide_message:912 | derived:streams | user
  confidence  REAL NOT NULL DEFAULT 0.5,
  pinned      INTEGER NOT NULL DEFAULT 0,
  expires_at  TEXT,               -- behaviour facts rot; profile facts do not
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Three rules that keep this from becoming a liability:

1. **Extraction is nightly, not per-message.** One model call over the day's messages, proposing facts;
   `guideContext` then carries a bounded selection (pinned + top-scoring + relevant). Cost and context
   length both stay flat as history grows.
2. **A fact may not contain a derivable number.** *"wants to reach 70 kg"* is a fact; *"is losing
   0.4 kg a week"* is a derivation and must be read from `derive.ts` at use time. Otherwise R2 is
   violated by the back door and the Guide starts quoting a stale rate with total confidence.
3. **A page shows every fact with an edit and a delete** — 道引记得什么 · What the Guide remembers.
   PRD-brain §10 calls this a hard requirement; it is also the cheapest trust mechanism in the whole
   document, and it is what makes behavioural inference acceptable at all.

---

## 10. The questions the system asks become the model's, too

### 10.1 Reviews

`REVIEW_QUESTIONS` is the clearest case of a developer's judgement applied to a stranger's week. The
conversion: on the evening of a review, a deterministic bundle (goals moved, tasks done and dropped,
observations by stream, last review's answers) → the model writes **four** questions → they are stored
in `review_templates` → the bot and the web ask exactly those. Two thirds generic, one third about this
week specifically, is the right ratio to keep comparability across weeks.

**One schema consequence, easy to miss:** `reviews.answers` is a JSON object keyed by the *question
text* (`shared/reviews.ts`, `applyProposal`'s `create_review`, `json_patch` merge). Per-week wording
makes those keys unstable, so the answers must key on a stable `question_id` with the text stored
alongside. That migration is a prerequisite, not a detail.

### 10.2 Onboarding

Registration currently seeds nine areas and drops the user on an empty Today page — the cold-start risk
PRD-brain §15 names. Fully AI-driven means the first session *is* a conversation: direction in the
user's own words, the areas *they* name, and exactly one tracker provisioned before the first message
ends. `DEFAULT_AREAS` survives only as the fallback for a user who declines to talk.

---

## 11. The web, generated

### 11.1 One home page per person

`Tracks.tsx` already demonstrates the endpoint: cards chosen from the stream's shape and the goal's
kind, so a new tracker needs no new code. The generalisation is a **fixed registry of view
primitives** — `line+trend`, `period bars`, `calendar heatmap`, `tally`, `distribution`,
`timeline/gallery`, `checklist` — with the choice stored on the stream (and overridable by the user).
The home page becomes the user's own tracker cards plus the spine's cards, ordered by what they
actually look at. The route switch in `App.tsx` stays: the spine is fixed on purpose (§13.4).

### 11.2 The proposal union stays closed

Ten arms is not the problem; **four files per arm** is. One registry per proposal kind — the schema, the
validator, the apply function, the label, and the prompt fragment in one place — makes the union cheap
to extend and makes `SYSTEM_PROMPT` a generated artifact rather than 20 hand-maintained lines that can
drift out of sync with `applyProposal`. The model still may not invent a kind.

---

## 12. Fold body into the generic layer

PRD-brain §19 asks where body ends up. It should be folded, and folding it is the acceptance test that
the generic layer is finished:

| body today | becomes |
|---|---|
| `weight_logs` | observations on a `number` stream in kg, with a `reach` goal that becomes `maintain` |
| `workout_logs` | a `count` stream with an `accumulate` goal (3/week) |
| `body_plans` | the goal's own params, plus the nested child goal of PRD-brain §7.8 |
| `bodySummary()` | `goalStatus` for `reach` — already the same maths, already the same verdicts |
| the six body Telegram modules | `stream_ask` handler rows in `agenda` |
| `meal_logs` + the vision path | **stays special** — a connector with a JSON payload, not a shape |

Meals are the honest exception: a photo becoming `{dishes, kcal, protein}` is not a value extracted from
the user's text, and no parser will ever do it. Keeping meals as a *connector* (a non-chat way
observations arrive) rather than a *vertical* is the distinction that lets everything else generalise.
Doing this deletes more code than any other item here, and it is the only way to know the six shapes
and six kinds are actually sufficient.

---

## 13. What must never be AI-driven

The more of §4 gets converted, the more this section is the product.

### 13.1 Invariants enforced mechanically

- **`user_id` on every statement touching a user table.** Today this is a `CLAUDE.md` sentence checked
  by grep. It must be a CI check that fails the build, especially once generated code can reach `main`
  (PRD-brain §12.1 valve 2). It is the one invariant whose breach is an incident.
- **Migrations need a human.** Generated code may merge; generated schema may not.
- **Model-authored artifacts are validated in code, never trusted.** `validateSpec` is the model of
  this: bounds, `HH:MM`, alias limits, goal kinds, conflicts — all refused at provisioning time.
- **No model-authored regex, ever.** `buildPattern` exists because a model-supplied pattern is an
  unbounded backtracking hazard in a runtime with no timeout.

### 13.2 The one number that comes from a model

Meal kcal. It is stored in `meal_logs`, shown with a `~` and the 估算 disclaimer, user-correctable, and
**no verdict depends on it** — the weight verdict comes from weigh-ins alone. That is the template for
any future model-produced number: labelled as an estimate, editable, and excluded from every derivation
that produces a judgement.

### 13.3 The permission ladder is the spec

PRD-brain §13's four levels (free / budgeted / confirmed / forbidden) should be a real table in code
that each handler declares against, not a paragraph. A system that initiates needs its constraints in
one auditable place — that is the difference between a proactive assistant and an unpredictable one.

### 13.4 The spine does not move

Direction → goals → today's three → reviews is the part that is the same for everybody, and it is the
frame that makes generated trackers mean something. A system where everything is soft has nothing to
be trustworthy about.

---

## 14. The degradation contract

Property 3 of §3, made testable. Add `AI_OFF` (a `vars` flag) and a CI-run smoke test asserting that
with it set:

| works | stops |
|---|---|
| L0–L3 logging, timers, buttons, `/log`, `/tracks` | conversation with the Guide |
| every scheduled ask, rendered from templates | the composed wording of merged messages (falls back to templates) |
| every derivation, verdict, chart and report | provisioning a new tracker; review-question generation |
| review flow with the last stored questions | L4 intake (falls through to inbox capture) |

Local dev already runs this way — `wrangler.dev.jsonc` omits the `ai` binding — which means the test is
cheap to write and the property is nearly true today. It is worth keeping true deliberately, because
every phase below adds a model call to a path that did not have one.

---

## 15. Phasing

Each phase is shippable alone, and each ends with the §14 test still passing.

### A0 — Make the current layer honest (no new AI)
1. The four missing derivations: `streak`, `reduce`, `maintain`, `complete` over `projects`
   (`derive.ts`); nesting (§7.8). *Until these land, the model can compile goals the runtime cannot
   judge, which is worse than not offering them.*
2. `question_id` on `reviews.answers` (§10.1's prerequisite).
3. The `AI_OFF` flag and its smoke test (§14).

**Acceptance:** a `streak` and a `reduce` tracker provisioned by conversation produce correct verdicts
in the bot and the web, and the whole product passes the §14 table.

### A1 — `agenda`: proactivity becomes data
4. The table, the handler registry, the seed migration; `dueKinds` → a query; one delivery loop (§6).
5. The attention budget: scoring, caps, the composed message, `agenda.weight` decay from
   `telegram_events` (§7.1–7.3).
6. Settings becomes a list of the user's own asks.

**Acceptance:** deleting a seeded row stops that message; a model-created `agenda` row asks a question
at the right time the next day; two items due in one window arrive as one message; a kind ignored for a
month is down-ranked without a deploy.

### A2 — The edges
7. L4 intake with span verification, the structured echo, confirm-vs-auto-log, fall-through (§8).
8. Corrections → alias proposals (§8.4).
9. `facts` + nightly extraction + the 道引记得什么 page (§9).
10. The noticing engine over streams, feeding the budget (§7.4).

**Acceptance:** *"今天跑了 5 公里，读了一小时书，明天要看牙医"* produces two observations and one task
from one card; with the model off, the same sentence lands in the inbox and nothing breaks.

### A3 — Generated, per person
11. Model-authored review questions (§10.1); conversational onboarding (§10.2).
12. The view-primitive registry and the generated home page (§11.1).
13. The proposal registry and the generated prompt fragment (§11.2).
14. Body folded onto streams; meals kept as a connector (§12).

**Acceptance:** two accounts with different histories see different home pages and get different Sunday
questions, with no per-user code anywhere in the repo.

### A4 — Self-extension and reach
15. The gap log, then the classifier, then filing to agent-mo behind all three valves, with the
    `user_id` CI gate first (PRD-brain §12).
16. The per-user webhook (PRD-brain §11) — the highest-leverage connector by far.
17. The permission-ladder table (§13.3); the escalation ladder; the retirement ritual; the operator
    dashboard.

---

## 16. Cost and metrics

Model calls per user per day, at target:

| path | calls | model |
|---|---|---|
| L4 intake | ≤ 10% of messages | small |
| composed message wording | ≤ 3 | small |
| nightly fact extraction | 1 | small |
| conversation | on demand | frontier |
| provisioning / review questions / gap specs | ~1 per week | frontier |

Metrics to add to PRD-brain §18: **deterministic share** (L0–L3 as a fraction of inbound — must *rise*
as A2 lands, because corrections become aliases), **budget spend vs cap**, **notice precision**
(acknowledged notices ÷ notices sent), and **generated-artifact edit rate** (how often a user fixes
what the model authored — the direct measure of whether Reading B is working).

---

## 17. Answers to PRD-brain §19's open questions

1. **How far may a tracker deviate from the primitives?** No raw `json` hatch. Six shapes × six kinds ×
   the view primitives, combined and never invented; §12 of PRD-brain is the only way past it. A hatch
   would become the main road within a month and take every guarantee in §13 with it.
2. **Multi-user and generated features.** Write per-user flags in now, while there is one user and it
   costs nothing. A0's `AI_OFF` is the first one.
3. **Where does body end up?** Folded (§12), with meals as a connector. It is the acceptance test for
   the generic layer, so leaving it special leaves the layer unproven.
4. **The system's personality.** A quiet archivist that becomes insistent only about things that are
   irreversible and time-critical. Written here so the budget has something to spend against: notice
   generously, interrupt rarely, never moralise, and prefer *「上周的趋势反了」* to *「你该努力了」*.
5. **Retirement policy.** The system proposes, the user disposes, monthly, never the same tracker twice
   in a quarter. `agenda` makes the ritual itself a row.

---

## 18. Risks specific to going further

| risk | why it is new | mitigation |
|---|---|---|
| **A wrong artifact lives forever** — a bad ask time, a greedy alias, a mis-picked goal kind runs silently for months | model-authored config outlives the conversation that made it | every artifact is editable on a page (§9, §11), and the monthly ritual surfaces the unused ones |
| **Cost grows with conversation length** | memory and L4 add calls per message | nightly extraction, bounded context, small models on the edges, the §16 budget as a tracked metric |
| **The budget is mistuned and the bot gets muted** | proactivity is the point of A1 | reply-rate decay is automatic; caps are hard; one composed message; muting is the metric that matters most |
| **L4 claims messages it should not** | the model now picks streams | span verification, confirm-before-write for anything ambiguous, one-tap undo, and the L3/L4 split of §8.2 |
| **Generated code reaches production** | A4 | CI `user_id` gate first, human-approved migrations, per-user flags |
| **The generic layer turns out insufficient** | only §12 proves it | fold body before building anything on top; the gap-trigger rate is the architecture's own score |
