# PRD — Brain: Way as an AI-driven personal system

**Status:** Draft for discussion — architecture, not yet scheduled
**Author:** Peiyong (with Claude)
**Date:** 2026-09-20
**Supersedes in direction:** nothing yet; `docs/PRD-telegram.md` and `docs/PRD-body.md` become the reference
implementations this generalises from.
**Applies to:** `way.peiyong.ai` (worker `way`, D1 `way-preview-db`)

---

## 1. Summary

Way today is a fixed app with a chat client attached: fixed tables → fixed API → fixed UI, with the Guide
commenting from the side. This document describes the turn: **the chat becomes the product, and the app
grows itself around what each user turns out to need.**

Concretely: a user says *"I want to read more"* and the system provisions a tracker — a stream to log
minutes into, a goal with a definition of "on track", an ask at the right time with one-tap answers, a
chart on the web — and from then on that tracker runs **without the model**. Another user says *"track my
sleep"*, or *"I want to stop buying lunch out"*, and gets a different one from the same parts.

The single idea that makes this something other than a chat wrapper around a todo list:

> **The model compiles; the runtime executes.** Every model output becomes a durable artifact — a stream
> definition, a capture pattern, a schedule, a goal's parameters — that runs deterministically afterwards.
> The model is never in the loop of storing a value, computing a projection, or firing a reminder.

The evidence that this is the right shape is already in the repo. `docs/PRD-body.md` is ~4,300 lines of
hand-written code for one domain, and almost none of it is about weight. It is six generic things —
what to log, what the target is, how a value arrives, when to ask, what to compute, how to draw it —
with "kg" filled in. Make those six things **data** and the same machinery serves reading minutes,
meditation, savings, guitar practice or job applications.

---

## 2. Decisions on record

| # | Decision | Consequence |
|---|---|---|
| 1 | When the system cannot satisfy a request, it files a GitHub issue, agent-mo develops it, and the user is told when it ships | §12 — behind three valves; an issue is filed only with the user's tap |
| 2 | Proactivity is strong; important things escalate to a phone call | §9 — the ladder and the caps are designed now, the call provider is parked (§9.4) |
| 3 | Reading time is the first domain to validate the generic layer | §17 — it forces duration, timers, `accumulate` and the weekly view at once |
| 4 | Where there is no usable API, the bot asks and the user self-reports | §11 — with one-tap answers, and a timer preferred over a question |
| 5 | `maintain` is its own goal kind — the brainstorm's "six kinds" was wrong | §7 — seven kinds, one of which reuses `projects` |

---

## 3. Goals and non-goals

### Goals
- G1 — A need expressed in chat becomes a working tracker in the same conversation, with no code change
  in the common case.
- G2 — Logging never depends on a model: the deterministic paths work when the model is down, slow or unpaid.
- G3 — Every number the system states is computed, reproducible and attributable to logs. The model
  comments on numbers; it never produces them.
- G4 — The system initiates — it notices, asks, and escalates — while spending a bounded, learned amount
  of the user's attention.
- G5 — When the system genuinely cannot do something, that gap becomes a tracked feature request rather
  than a dead end, and the user hears back when it ships.
- G6 — The web app is generated from each user's own configuration; no per-user code.

### Non-goals
- Replacing the fixed spine. Direction → goals → today's plan → reviews stays exactly as it is; it is the
  part that is the same for everybody (§16).
- A general agent that can run arbitrary code or take arbitrary actions on the user's behalf.
- Multi-user collaboration, sharing, or social features.
- Medical, financial or legal advice. The system reports what the logs say (§15).

---

## 4. The principle, stated precisely

Three rules follow from "compile, don't interpret". They are the ones to check any future design against.

**R1 — The model never produces a stored value.**
It may decide *which stream* a message belongs to. The value itself is extracted from the user's own text
by a deterministic parser for that stream's shape (§8.2). A model that returns `{minutes: 44}` for "45
minutes" fails silently and poisons every derived number; a model that returns `stream: reading` and is
wrong is visible in the echo and fixable in one tap.

**R2 — The model never computes a projection, a rate or a verdict.**
Those come from `worker/body.ts`-style pure functions over the logs (§7). The model reads the result and
may reason about it. This rule already exists in `worker/guide.ts` for the body goal; it becomes global.

**R3 — Every model decision that will recur is written down.**
A capture pattern, an ask template, a schedule, a unit, a threshold: authored once by the model, stored,
and executed thereafter without it. If the same model call has to happen twice for the same purpose, the
first one should have produced an artifact instead.

---

## 5. Concepts

| Term | Meaning |
|---|---|
| **Stream** | A named thing the user logs: a shape, a unit, a plausible range, the ways a value arrives, and how to ask for it. |
| **Observation** | One logged value on a stream, with a timestamp and a source. |
| **Goal** | A claim the system can verify: a `kind` (§7) over a stream, with a target and optionally a deadline. |
| **Tracker** | Informally, a stream + its goal + its schedule + its view. What gets provisioned in one conversation. |
| **Derivation** | A pure function over observations: trend, rate, period sum, streak, compliance, projection. |
| **Connector** | A non-chat way observations arrive: a native integration, a push endpoint, email, or a timer. |
| **Gap** | A request the current primitives cannot express (§12). |

---

## 6. Data model

One table holds every observation. No per-user tables, no migration per domain.

```sql
CREATE TABLE streams (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,          -- "读书时长"
  shape              TEXT NOT NULL,          -- number|duration|count|bool|enum|money|text|photo
  unit               TEXT,                   -- min|kg|次|元 … display + parsing
  min_value          REAL, max_value         REAL,   -- plausible range; outside it is a typo, not a reading
  enum_options       TEXT,                   -- JSON, shape = enum
  aliases            TEXT NOT NULL DEFAULT '[]',   -- JSON: the user's own words (§8.4)
  patterns           TEXT NOT NULL DEFAULT '[]',   -- JSON: capture regexes, authored by the model
  bare_value_capture INTEGER NOT NULL DEFAULT 0,   -- a naked number logs here (§8.5) — off by default
  ask_template       TEXT,                   -- JSON: the question and its quick-answer buttons
  ask_at             TEXT,                   -- local HH:MM, NULL = never asks
  ask_condition      TEXT,                   -- e.g. "no observation today"
  status             TEXT NOT NULL DEFAULT 'active',  -- active|paused|retired
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  stream_id  INTEGER NOT NULL REFERENCES streams(id),
  at         TEXT NOT NULL,        -- local YYYY-MM-DD, plus time_min when the moment matters
  time_min   INTEGER,
  num        REAL,                 -- number|duration|count|money|bool(0/1)
  text       TEXT,                 -- enum value, or free text
  json       TEXT,                 -- shape-specific extras (a photo's dish list, a workout's intensity)
  source     TEXT NOT NULL,        -- telegram|web|timer|connector:<name>|guide
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_obs_stream ON observations(user_id, stream_id, at);
```

`goals` gains the machinery of §7 (`kind`, `stream_id`, `target`, `period`, `parent_id` for nesting) while
keeping every column it has today, so existing goals keep working as `qualitative`.

**Why one table works:** because the derivations are generic. "7-day trend", "sum this week", "consecutive
days", "% of periods under the ceiling" are the same code whether `num` means kilograms or minutes. Finite
deterministic operators, unbounded user-facing combinations.

---

## 7. The seven goal kinds

The model's job when a goal is created is to pick a kind and fill its parameters. It may not invent a
kind, and it may not compute the verdict. Two axes decide which kind fits:

| | **level** (a state: weight, balance, pace) | **flow** (a quantity: minutes, times, money spent) |
|---|---|---|
| **reach a point** | `reach` | `complete` |
| **sustain** | `maintain` | `accumulate` · `reduce` |
| **just show up** | — | `streak` |

Plus `qualitative` for goals with no honest metric.

### 7.1 `reach` — get a value to a target
```
params   stream, target, deadline?
math     smoothed trend → least-squares rate → remaining / rate → projected date → compare to deadline
verdict  ahead | on_track | behind | stalled | wrong_way | no_data
view     line + trend band + target line + dashed projection
```
Smoothing is mandatory: raw readings are noisy (weight moves ~1 kg within a day) and an unsmoothed rate
oscillates wildly. This is exactly `worker/body.ts` today.
**Trap:** reaching the target leaves the goal stuck at 100% forever. On reaching it, offer to convert to
`maintain`.
> 体重 70 · 存款 10 万 · 5k 配速到 5:00

### 7.2 `accumulate` — reach an amount per period
```
params   stream, amount, period (day|week|month), carry_shortfall (default false)
math     sum(period) vs amount × elapsed_fraction(period)
verdict  ahead | on_pace | behind | unreachable | no_data
view     bars per period + target line
```
`unreachable` is a distinct and useful state: Saturday with 1 of 10 hours is not "behind", it is over —
and the right message is "write this week off, start Monday", not "hurry up".
**Trap:** carrying a shortfall forward compounds into guilt and gets the tracker abandoned. Default off;
offer it only for things like savings where debt is real.
> 每周读书 10 小时 · 每周运动 3 次 · 每月存 5000

### 7.3 `reduce` — stay under a ceiling
```
params   stream, ceiling, period, tolerance_periods
math     per-period total vs ceiling · compliance rate over a window · trend of the total
verdict  under | occasionally_over | often_over (each with improving/worsening)
view     bars + ceiling line, over-bars coloured
```
Mathematically `accumulate` with the inequality flipped, but the psychology is opposite — finishing the
week's quota on Wednesday is success for `accumulate` and an alarm for `reduce` — so the wording, the
verdict set and the nudges are different. Shared code, separate kind.
> 每天屏幕 < 2h · 每月外卖 < 800 · 每天咖啡 ≤ 2 杯

### 7.4 `maintain` — stay inside a band
```
params   stream, floor, ceiling, period, tolerance
math     % of periods inside the band · direction and size of deviation · variance
verdict  steady | drifting_high | drifting_low | unstable
view     line + shaded band
```
Distinct from `reduce` because the constraint is two-sided, and because `unstable` (mean is fine, variance
is not) is a real state neither of the others can express. This is where a finished `reach` goes.
> 体重维持 70–72 · 睡眠 7–8 小时 · 每周工时 40–45

### 7.5 `streak` — keep showing up
```
params   stream, condition (happened | above threshold), period (usually daily), allowance_per_week
math     current run · longest run · completion rate over the last 30 periods
verdict  running_n | due_today | broken
view     calendar heatmap
```
Two decisions that matter more than the maths:
- **`allowance` is required.** A pure streak is brittle; one miss collapses the motivation it was built on.
  "one rest day a week" keeps it alive.
- **Always report the rate alongside the run.** "26 of the last 30 days" is more honest and more useful
  than "3-day streak". Reporting only the run manufactures anxiety instead of information.
> 每天冥想 · 每天记三件事 · 每天不喝酒

### 7.6 `complete` — finish a set of named things
```
params   items (named) or target_count, deadline?
math     done/total · pace vs deadline · projected completion
view     checklist + progress
```
The line against `accumulate`: if the items are **individually named and meaningful**, it is `complete`
("read these 12 books"); if only the count matters, it is `accumulate` ("read 12 books this year").
**This kind reuses `projects` + `tasks`.** It is not new machinery, and building a second one would be a
mistake.
> 读完 12 本书 · 拜访 20 个客户 · 学完 8 门课

### 7.7 `qualitative` — no metric
```
params   intention, review cadence
math     none. Evidence = notes, reviews, linked tasks, the Guide's periodic read of what was written
verdict  only from reviews: the user's own rating and a summary of the evidence that exists
```
This is a requirement, not an escape. The goals that matter most — *"be a more patient father"*, *"work
out what to do next"* — have no honest number, and forcing one on them is what makes goal-tracking
software feel hollow. The system's job is to ask a good question on a cadence and surface what the user
themselves wrote.
**Trap:** it becomes the dumping ground. The model should push back exactly once — *"is there anything
that would show this is getting better?"* — and then accept "no" gracefully.

### 7.8 Goals nest
"Save 100k" is a `reach` on a balance, but the lever is "save 5,000 a month", an `accumulate`. Let a goal
carry sub-goals: **the parent answers "will I get there", the child answers "what do I do this week"**.
The body plan already contains this shape hard-coded (a weight target plus a weekly workout count);
generalising it makes it explicit.

---

## 8. The parsing cascade

How a message becomes data. This layer decides whether the product is trustworthy.

### 8.1 Seven layers; the model appears at the fourth

```
L0  callback (button)        deterministic    ~0 ms
L1  a pending ask            deterministic    parsed against that stream's shape
L2  command /…               deterministic
L3  registered patterns      deterministic    patterns authored by the model, matched without it
────────────────────────────────────────────  everything above works with no model at all
L4  small model: routing     picks the lane, never the value
L5  frontier model           conversation, design, review, judgement
L6  inbox capture            input is never lost
```

**L0–L3 are a hard guarantee:** when the model is down, slow, or out of credit, *logging still works*.
Only conversation degrades. The habit the product depends on never breaks.

### 8.2 L1 is the main path, and it is small

When the system asked the question, the expected shape is known, so parsing is not an NLU problem — it is
a 30-line parser per shape, each unit-testable to exhaustion:

| shape | accepts |
|---|---|
| `number` | value + unit + range check |
| `duration` | `45` `45分` `一小时` `1h` `1.5小时` `半小时` `没读` |
| `count` | `3` `三次` `两遍` |
| `bool` | 是/否/做了/没有/✓ |
| `enum` | option names + aliases (buttons carry most of these) |
| `money` | amount + currency |

Most logging should land here, because the system asked. Proactivity and reliability are the same
property seen from two sides: the better the system asks, the less it has to guess.

### 8.3 L3 — the model writes the patterns, the runtime runs them

```
stream  读书时长   shape=duration
  aliases   读书 / 看书 / 读了 / reading
  patterns  /(读|看)(书|了)?\s*(\d+)\s*(分钟|小时|min|h)/
  bare      off
```

Two things this needs:

- **Pattern conflicts are detected at provisioning time, not at parse time.** A user with a "跑步" stream
  who adds "运动时长" creates an ambiguity for "跑了 30". That must surface the moment the second stream is
  created, with the user choosing, rather than being resolved by luck on every later message.
- **Bare values are hazardous and default to off.** `72.4` works for body only because exactly one stream
  exists whose plausible range contains it and which opted in. The general rule: a naked number is claimed
  only when **exactly one active stream's range can hold it** and that stream has `bare_value_capture`.
  Otherwise, ask with buttons.

### 8.4 L4 — closed classification, multiple lanes

```
Which of these does this message contain?
  log to stream X | Y | Z  ·  new capability request  ·  task capture  ·  conversation  ·  correction
```

It may return several: *"今天跑了 5 公里，读了一小时书，明天要看牙医"* is three items. Each then goes back
through its own deterministic parser (§8.2) for the value. The reply echoes a structured summary with
per-item fix buttons:

```
收到三件 ·
  🏃 跑步 5.0 km        [改]
  📖 读书 60 分钟        [改]
  ✅ 任务：看牙医 明天    [改]
```

Aggressive parsing is safe precisely because being wrong costs one tap.

### 8.5 Three rules across every layer

1. **Ambiguity is a question, not a guess.** Two plausible candidates → two buttons. One tap buys
   permanent certainty and produces a training signal.
2. **Every automatic interpretation is undoable in one tap.** The weight fast path's *"撤销，记进 Inbox"*
   becomes the general pattern.
3. **A correction teaches, but the lesson needs approval.** *"不是，那是跑步不是走路"* → fix the record,
   **then offer** *"以后「走了 X」也算跑步？[是] [否]"*. Learning the user's shorthand silently is not
   acceptable: they must be able to see what the system now believes about their words, and undo it.

Together these are how the system "learns how you talk" — not by understanding afresh each time, but by
**settling understanding into deterministic rules**.

### 8.6 Latency budget

| | target |
|---|---|
| L0–L3 logging | < 200 ms — should feel like pressing a button |
| L4 routing | ~1 s |
| L5 conversation | seconds, with a typing indicator |

The gap is deliberate: it teaches the user that recording is a reliable mechanical act and conversation is
a different thing.

---

## 9. Proactivity

The system initiates. Decision #2 puts this at "strong", which makes the limits — not the triggers — the
part that needs designing.

### 9.1 What it initiates
- **Asks** — the scheduled questions each stream defines.
- **Noticing** — the high-value class, because the user cannot do it themselves:
  *"your 7-day average has risen two weeks running after three months of falling — what changed?"* ·
  *"you said this week was for the paper; there is not an hour of it in your calendar"* ·
  *"nothing has moved on this goal in 18 days — do you still want it?"*
- **Escalation** — §9.3.

### 9.2 The attention budget
The scarcest resource is not compute, it is the user's willingness to be interrupted. This is a mechanism,
not a guideline:

- A per-day and per-week message quota, spent in value order.
- **One composed message** where several things are due, never seven separate ones (the merged morning
  message in `docs/PRD-telegram.md` §6.1 is the precedent).
- Reply rate per message kind is recorded — `telegram_events` already does this — and a kind that stays
  under ~20% is automatically down-ranked, then offered for removal.
- Strong proactivity without a budget ends in a muted bot, which is the end of the product.

### 9.3 The escalation ladder
```
message  →  15 min unacknowledged  →  louder channel (voice note)
         →  still unacknowledged   →  call  →  "press 1 to confirm"
```
**Every rung must be cancellable by acknowledgement**, or it is harassment.

What earns escalation is **irreversibility plus time-criticality**:

| escalates | does not |
|---|---|
| a flight in two hours, not left yet | no weigh-in today |
| a meeting in ten minutes, unacknowledged | one workout short this week |
| medication | review is due |
| something due today that has never been touched | reading time behind |

- The **first time** the system wants to escalate a given category it must ask permission. One
  authorisation, held thereafter.
- Hard caps: N escalations per week; quiet hours are absolute unless the user marked that specific thing
  as override-capable.

### 9.4 The call channel is parked
Decision #2 defers the provider. The design is therefore **an abstract notification channel** with levels
(`text | loud | call`). The ladder, the acknowledgement, the caps, and the rules about what earns a rung
are provider-independent and are designed now; the phone implementation drops in as one channel later
without a redesign. Note for whenever it lands: Telegram bots cannot place calls, so this is an external
provider, and UAE termination needs to be verified empirically before anything is built on it.

---

## 10. Memory

Replaying the last 12 messages cannot know that the user skips workouts in the week before a deadline.
Four tiers:

- **Profile / facts** — extracted, durable, and **visible and editable by the user**.
- **Episodic summaries** — rolling weekly digests that compress history.
- **Behavioural observations** — *"logs meals on weekdays only"*, *"never trains on Wednesdays"*.
- **Retrieval** — pull what is relevant to the current topic into context.

**User-inspectable is a hard requirement.** A web page — *"what the Guide believes about you"* — listing
every fact with an edit and a delete. If the system holds wrong beliefs that the user can neither see nor
correct, trust collapses, and trust is the whole product.

---

## 11. Connectors — what is actually possible

Decision #4 accepts self-reporting where no API exists. The honest tiering:

| tier | what | reality |
|---|---|---|
| **Native** | Google Calendar, Strava, Toggl | OAuth, hand-built, pick 3–5 and no more |
| **Push endpoint** ⭐ | a per-user webhook URL | **the 80% answer** — iOS Shortcuts, Tasker, IFTTT, Zapier, n8n all post to it |
| **Email intake** | a per-user address | statements, exports, weekly digests arrive by themselves |
| **Timer** | `/开始 读书` … `/停止` | real durations, no integration, no recall |
| **Ask** | the bot asks, the user answers | always available |

**iOS Shortcuts against a per-user webhook is the highest-leverage item here** — Apple Health weight,
steps and sleep, Screen Time, "start a timer when 微信读书 opens", an NFC tag on the treadmill — all become
automatic capture with zero integration code.

微信读书 and most Chinese apps have no public API. **The model must know this and say so** — *"微信读书 没有
接口。我给你一个计时器，或者每晚问你一次"* — rather than promising what cannot be delivered. Honesty about
the system's own limits is a core trust property, and it is also what makes §12 meaningful.

**Prefer a timer over a question** wherever it applies: reading, practice, deep work, meditation. The
question is the timer's fallback, not the first choice.

---

## 12. The self-extending loop

Decision #1. When the primitives cannot express a request, the system writes its own feature request.

```
gap detected → classify → deduplicate → ASK THE USER → file issue with a spec
             → agent-mo → PR → CI gates → deploy → tell the user → migrate their interim data
```

### 12.1 Three valves

**Valve 1 — the detector will over-fire.** Every slightly novel sentence must not become an issue.
- **Classify** the miss: a genuinely absent capability / a parse failure / the user is just talking. Only
  the first is a gap.
- **Deduplicate** semantically against open issues.
- **Ask**: *"这个我现在做不了。要我把它记成一个功能去开发吗？[要] [算了]"* — one tap removes ~90% of the noise,
  and it keeps the system inside the "propose, never act" discipline the Guide already follows.

**Valve 2 — agent-mo is modifying a production system holding personal data.** Two gates must be
mechanical, not documentary:
- **`user_id` scoping enforced in CI.** Today this rule lives in `CLAUDE.md` and is checked by hand — this
  session found it correct by grepping. It must become a check that fails the build when any SQL touching
  a user table lacks `user_id`. It is the one invariant whose breach is an incident.
- **Migrations require human approval.** Generated code may auto-merge; generated schema changes to the
  production database may not.
- New capability ships **behind a per-user flag**, enabled first for whoever asked.

**Valve 3 — the escape hatch must not become the main road.**
If the generic layer is right, *"track my water intake"* is a config row, not a PR. The hatch is for
genuinely new **kinds**: a connector, a view primitive, a goal kind, a shape.

> **The gap-trigger rate is a metric on the architecture, not on the users.** Several a week means the
> generic layer is wrong. Roughly one a month is healthy. This number belongs on the operator dashboard;
> it tells you what to abstract next better than any amount of speculation.

### 12.2 What the issue contains
Not *"user wants X"*. A spec — which is why the Telegram and body issues were implementable:
the conversation excerpt · what the system tried · **which layer is missing** (shape? goal kind?
connector? view?) · acceptance criteria · the interim manual workaround in place.
Writing that spec is itself a model task.

### 12.3 The waiting period
Between the user's tap and the deploy there may be hours or days. The system must:
1. give an **interim manual fallback immediately** (log it as a `text` stream, or capture to the inbox) —
   the user is never left with nothing;
2. **migrate the interim data into the real capability** when it ships. Done well this is the moment the
   product feels alive.

### 12.4 The gap log is the roadmap
Even with auto-filing switched off, recording every unfulfillable request is the most honest product
research available. Build the log first; automate the filing second.

---

## 13. The action permission ladder

All five decisions point the same way: the system acts on its own initiative. So the most important layer
is not the data model — it is the **explicit, central, auditable set of constraints on the system's own
behaviour**.

| level | what the system may do | examples |
|---|---|---|
| **Free** | any time, silently | read data, compute derivations, render views, match patterns |
| **Budgeted** | do it, but it spends attention (§9.2) | send a message, remind, start a conversation |
| **Confirmed** | ask first; act only on a tap | write data from an inference, create a stream or goal, file an issue, escalate a new category, add a learned pattern |
| **Forbidden** | never | call during quiet hours, delete data, change schema, give medical/financial advice, act on another user's data |

This table is the thing to check every new feature against.

---

## 14. The web app

Decision: display and configuration, generated per user.

- **Dashboard** — one card per active tracker, each rendered by a view primitive chosen from the stream's
  shape and the goal's kind. Six or seven primitives cover everything:
  `line+trend` · `period bars` · `calendar heatmap` · `tally` · `distribution` · `timeline/gallery` ·
  `checklist`. Every user's home page differs; no per-user code exists.
- **The fixed spine** stays as it is: Today, Timeline, Goals, Reviews, Guide.
- **Stream & goal editor** — what chat provisions, the web lets you inspect and correct: the patterns, the
  ask times, the ranges, the aliases.
- **What the Guide believes about you** (§10) — facts, editable, deletable.
- **Operator view** (single-user for now): gap log, gap-trigger rate, reply rate per message kind,
  attention budget spend, model cost.

---

## 15. Risks

| risk | mitigation |
|---|---|
| **Over-provisioning** — 15 trackers, none used | **one new tracker at a time**; it must survive two weeks before another is offered |
| **Nag fatigue** — strong proactivity gets muted | the attention budget (§9.2) as a hard mechanism, with reply-rate feedback |
| **Cold start** — an empty chat and "tell me anything" paralyses | opinionated onboarding: two or three concrete offers, not an open question |
| **The model as a liability** — confident wrong numbers | R1/R2 (§4): the model never produces values or verdicts |
| **Everything soft, nothing trustworthy** | the fixed spine does not move; deterministic layers are guaranteed (§8.1) |
| **Cost** | ≥ 90% of interactions must never reach a frontier model |
| **Accumulation without pruning** | a monthly ritual that *proposes removal*: *"these three haven't been touched in two weeks — retire them?"* Almost every tool only ever adds; subtracting is a genuine differentiator |
| **agent-mo breaking production** | §12.1 valve 2: CI-enforced scoping, human-approved migrations, per-user flags |

---

## 16. Relationship to the existing code

**Nothing built so far was the wrong thing.** The current repo is the spine plus one hand-built vertical.

- `goals` · `tasks` · `days` · `weekly_plans` · `reviews` — the **fixed spine**, identical for everyone.
  It stays. Existing goals become `qualitative` until a stream is attached.
- **Body is the reference implementation.** Its value is as the standard the generic layer must be able to
  express: if `streams` + `reach` + `accumulate` cannot reproduce `docs/PRD-body.md`, the generic layer is
  not finished. Body may stay specialised afterwards — it has earned it.
- **The bot's architecture generalises almost unchanged**: the router's resolution order, the 64-byte
  `callback_data` protocol with its type-level assertion, the scheduler's `telegram_outbox_log` claim, the
  `telegram_events` instrumentation, the "propose, never act" rule. §8 is the existing router with L3 made
  dynamic and L4 inserted.
- `streams` / `observations` are added **alongside**, not as a replacement. Nothing is migrated on day one.

---

## 17. Phasing

### P0 — the generic layer, proven on reading time
Decision #3. Reading time is the right first domain because it exercises `duration`, the timer, an
`accumulate` goal and the period-bars view all at once, and because the author will actually use it.

1. `streams` + `observations` + the six shape parsers.
2. Provisioning by conversation: the model proposes a stream + goal + ask template; the user approves.
   Pattern-conflict detection at creation.
3. The parsing cascade L0–L3, with L4 as a stub that falls through to capture.
4. `accumulate` and `reach` derivations; the goal verdict shared by bot and web.
5. The timer (`/开始` `/停止`) and the scheduled ask with one-tap answers.
6. Web: the generated dashboard with `line+trend` and `period bars`.

**Acceptance:** *"I want to read 10 hours a week"* in chat produces, with one approval and no code change,
a working tracker: it asks at the right time, accepts "45分" and a timer, shows a weekly bar chart, and
says whether the week is on pace — and all of it keeps working with the model turned off.

### P1 — the rest of the kinds, and the brain
7. `streak`, `reduce`, `maintain`, nesting; `complete` mapped onto `projects`.
8. L4 routing with multi-lane extraction and the structured echo.
9. The attention budget and the noticing engine (§9.1).
10. Memory tiers + the "what the Guide believes about you" page.
11. The push endpoint (per-user webhook) and one native connector (calendar).
12. Pattern learning from corrections, with approval.

### P2 — self-extension and reach
13. The gap log, then the classifier, then auto-filing to agent-mo (§12) with all three valves and the CI
    gates; interim-data migration on ship.
14. The escalation ladder; the call channel when the provider arrives (§9.4).
15. Retirement ritual; monthly report; the operator dashboard.

---

## 18. Metrics

- **Gap-trigger rate** — the architecture's own score (§12.1).
- **Deterministic share** — % of inbound messages resolved at L0–L3. Target ≥ 90%.
- **Provisioning survival** — % of trackers still receiving observations 30 days after creation. This is
  the honest measure of whether conversational provisioning works at all.
- **Reply rate per message kind**, already instrumented; drives the budget.
- **Loop completion** — % of user-days with both a plan and a review, as today.
- **Escalation precision** — acknowledged escalations / escalations sent.
- **Model cost per active user per week.**

---

## 19. Open questions

1. **How far can a user's tracker deviate from the primitives?** The proposal is a hard limit: six shapes ×
   seven goal kinds, combined but never invented — with §12 as the only way past it. Should there be a raw
   `json` escape hatch as well, or does that quietly become the main road?
2. **Multi-user and generated features.** One user's feature request changes shared code. Per-user flags
   are the answer, but the decision affects how code is written *now*, while there is still one user.
3. **Where does body end up** — folded into the generic layer, or kept special? Deciding late is fine;
   deciding never is not.
4. **The system's personality.** "Strong proactivity" can mean a quiet archivist that answers when asked,
   or something that interrupts with a judgement. This is a product decision, it sets how the attention
   budget is spent, and it should be written down rather than emerging from prompt wording.
5. **Retirement policy** — who decides a tracker is dead: the user, or the system proposing it? Proposal:
   the system proposes, the user disposes, and it never asks about the same tracker twice in a quarter.
