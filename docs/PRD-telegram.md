# PRD — Way on Telegram

**Status:** Draft for implementation
**Author:** Peiyong (with Claude)
**Date:** 2026-09-19
**Applies to:** `way.peiyong.ai` (worker `way`, D1 `way-preview-db`)

---

## 1. Summary

Way is today a web app you must remember to open. This PRD turns Telegram into a
**first-class second client**: Way reaches out at fixed times, the user answers in the
chat, and the answers land in the same D1 tables the web UI writes. A user who never
opens the browser after onboarding should still end each day with a `days` row, a
top three, completed tasks and a review.

Three things this buys:

1. **Push instead of pull.** Direction, weekly outcomes and reminders arrive every morning.
2. **Capture at the speed of thought.** A stray thought becomes an inbox task in two seconds.
3. **Closure.** A 21:30 nudge is the difference between a review habit and an empty `reviews` table.

---

## 2. Decisions already made

| Decision | Choice | Consequence |
|---|---|---|
| Bot ownership | **One shared official bot** (`@WayGuideBot`, token in a Worker secret) | One webhook, one token, users identified by `telegram_user_id`. No per-user BotFather setup. |
| Reply parsing | **Buttons and commands first, natural language falls back to Guide** | Deterministic paths cost zero tokens; free text is one tap from the Guide. |
| Password login | **Can be fully disabled, no recovery mechanism** | Accepted risk, see §11.1. |
| Scope | **Full vision, phased P0 / P1 / P2** | P0 is a shippable closed loop on its own. |

---

## 3. Goals and non-goals

### Goals
- G1 — A user links Telegram in under 15 seconds from the web app, or from the bot on their phone.
- G2 — A user can sign in to the web app with Telegram alone, and may switch password login off.
- G3 — Three scheduled messages per day (brief, plan prompt, review prompt) delivered at the user's **local** time.
- G4 — Every scheduled message is actionable: replying or tapping writes real rows.
- G5 — Telegram covers the daily loop end to end: capture → plan → execute → review.

### Non-goals (this round)
- Group chats, channels, or multi-user rooms. Way is single-user-per-account; the bot only works in 1:1 chats.
- File/photo attachments (no R2 bucket today).
- Telegram Mini App / WebApp embedding — the web app already works in Telegram's in-app browser.
- Push for anything the user did not opt into. No marketing, no streak shaming.

---

## 4. Constraints in the current codebase

These are not optional design notes; the feature does not work until each is handled.

### 4.1 There is no per-user timezone — this is the blocker

Server date math is UTC (`isoDate`, `weekStartOf`, `periodRange` in `worker/index.ts`),
the browser uses local time (`todayStr()` in `src/api.ts`). Today that mismatch is
mostly invisible because the client always passes an explicit `date`. It stops being
invisible the moment the server decides *when* 07:30 is.

It is also an existing bug: `/api/insights` (`worker/index.ts:551`), `/api/reviews`
(`worker/index.ts:508`) and `guideContext` (`worker/index.ts:603`) all take "today"
from UTC. For a UTC+8 user between 00:00 and 08:00 local, those endpoints answer for
*yesterday*.

**Required:** `users.timezone` (IANA, e.g. `Asia/Shanghai`), a `localDate(tz)` /
`localTime(tz)` helper built on `Intl.DateTimeFormat` (supported in Workers), and those
three call sites switched over. Default `UTC`; the web app offers
`Intl.DateTimeFormat().resolvedOptions().timeZone` on first load and on the Settings page.

### 4.2 The worker exports a Hono app, not a handler object

`worker/index.ts:729` is `export default app;`. A `scheduled()` handler cannot be added
to that. It becomes:

```ts
export default {
  fetch: app.fetch,
  scheduled: (event, env, ctx) => ctx.waitUntil(runSchedules(env, event.scheduledTime)),
} satisfies ExportedHandler<Env>;
```

and `wrangler.jsonc` gains `"triggers": { "crons": ["*/5 * * * *"] }`.
`wrangler.dev.jsonc` should get the same trigger so `npm run dev` can exercise it
via `curl "http://localhost:5174/__scheduled"`.

### 4.3 Only `/api/*` reaches the worker

`run_worker_first: ["/api/*"]` in both wrangler configs. The Telegram webhook must
therefore live under `/api/`. Use `POST /api/telegram/webhook`.

### 4.4 The auth middleware would block the webhook

`worker/index.ts:127` lets through only paths starting with `/api/auth/`. Telegram
sends no cookie. Extend the bypass to an explicit list:

```ts
const PUBLIC = ["/api/auth/", "/api/telegram/webhook"];
if (PUBLIC.some((p) => c.req.path.startsWith(p))) return next();
```

The webhook authenticates itself by the `X-Telegram-Bot-Api-Secret-Token` header
instead (§11.2).

### 4.5 Every bot query must be `user_id`-scoped

The rule from `CLAUDE.md` ("every SQL statement is scoped by `user_id`") now has a
second entry point. The webhook resolves `update.message.from.id` →
`telegram_accounts.user_id` **once**, and every downstream helper takes that `userId`
as its first argument — same shape as the HTTP handlers. A bot path that queries by
`chat_id` instead of `user_id` is a bug.

### 4.6 Smaller findings worth fixing while we are in here

- `worker/auth.ts:35` — `candidate === hash` is a non-constant-time comparison. Low
  practical risk over the network, but a constant-time XOR compare is four lines. Worth
  doing now that login gets a second code path.
- **No rate limiting on `/api/auth/login`.** Adding a 6-digit Telegram code makes this
  a real concern (10^6 space, 5-minute TTL). Both endpoints need attempt counters.
- **Expired sessions are never deleted.** The `sessions` table grows forever. Add a
  cleanup to the same cron: `DELETE FROM sessions WHERE expires_at < datetime('now')`.
- **`PUT /api/day/:date` binds `body[f]` unvalidated** (`worker/index.ts` `DAY_FIELDS`
  loop). A JSON object or array in `mood` throws a D1 bind error → 500. The bot will
  reuse these helpers, so coerce: numbers for ratings, strings for text.
- **Missing indexes:** `sessions(expires_at)`, `tasks(repeat_src)`. The new tables need
  `telegram_accounts(telegram_user_id)` UNIQUE.
- `materializeRepeats` issues one `SELECT` + one `INSERT` per repeating task on every
  `GET /api/day`. The morning brief calls the same path for every user at once. Fine at
  current scale; revisit past ~200 users (§12.4).

---

## 5. Linking and authentication

### 5.1 Linking from the web (primary)

Settings → *Telegram* card → **Connect Telegram**.

1. `POST /api/telegram/link/start` → server mints a 32-hex nonce, stores
   `telegram_link_codes(code, user_id, kind='link', expires_at = now + 5 min)`.
2. UI shows a button `https://t.me/WayGuideBot?start=link_<nonce>` plus a QR code
   (desktop users scan it with their phone).
3. Tapping it opens the chat pre-filled with `/start link_<nonce>`.
4. Webhook: look up the nonce, check it is pending and unexpired, then upsert
   `telegram_accounts` with `telegram_user_id`, `chat_id`, `username`. Mark consumed.
5. Bot replies with a welcome + the default schedule + `[Change times] [Send me today's brief]`.
6. The web page polls `GET /api/telegram/link/status?code=…` and flips the card to
   "Connected as @handle".

**If that `telegram_user_id` is already bound to another Way account**, refuse with a
clear message. One Telegram identity ↔ one Way account (DB-level `UNIQUE`).

### 5.2 Signing in with Telegram

Three mechanisms, all using the single shared bot token as the signing key.

**(a) Login Widget — primary, desktop and mobile web.**
Requires `/setdomain way.peiyong.ai` in BotFather once. The login page renders
Telegram's widget; Telegram returns `{id, first_name, username, photo_url, auth_date, hash}`.
The worker verifies:

```
secret        = SHA256(bot_token)                      // raw bytes
check_string  = sorted "key=value" lines joined by "\n", excluding hash
expected      = HMAC_SHA256(check_string, secret)       // hex
```

Accept only if `expected === hash` (constant time) **and** `now - auth_date <= 300s`.
Then `telegram_user_id` → `telegram_accounts.user_id` → mint a session exactly as
`/api/auth/login` does (same `sessionCookie` helper, same 30-day expiry).

**(b) Deep link — best on phones.**
Login page shows **Open Telegram to sign in**; same nonce mechanic as §5.1 but
`kind='login'`. The bot asks for confirmation with an inline button showing the
requesting IP's country and browser, because a nonce can be phished. The page polls
`GET /api/auth/telegram/poll?code=…` and receives the cookie on approval.
The nonce is additionally bound to an httpOnly `way_pending` cookie set at step 1, so a
code approved on one device cannot log in a different browser.

**(c) 6-digit code — fallback, and the literal "验证码登录".**
User types their email → server finds the linked chat → bot sends `Your Way code: 418 233`.
Code: 6 digits, 5-minute TTL, single use, **5 attempts max**, bound to the same
`way_pending` cookie. Only available to already-linked accounts (a bot cannot message
someone who never pressed `/start`).

### 5.3 Disabling password login

Settings → *Security*: **Disable email + password sign-in**.

- Available only when Telegram is linked **and** the user has completed at least one
  successful Telegram sign-in (proven, not just claimed).
- Sets `users.password_login_disabled = 1`. `POST /api/auth/login` then returns
  `403 {"error": "Password sign-in is disabled for this account. Use Telegram."}` —
  **before** verifying the password, so it leaks nothing.
- The password hash is **not** deleted. Re-enabling is a toggle from any signed-in
  session; that is the only way back in, by explicit decision.
- The confirm dialog states this plainly: *"If you lose access to this Telegram account,
  you lose access to Way. There is no recovery email."*
- The login page hides the password form and shows the Telegram button when the account
  is known to have it disabled (only after email entry, to avoid enumeration — or simply
  always show the form and fail at submit; prefer the latter for P0).

### 5.4 Registering from Telegram (P2)

`/start` with no account and no nonce → offer **Create a Way account**. Needs
`users.email` to become nullable or to accept a synthetic value. Preferred: a
migration making `email` nullable with a partial unique index, and `users.name` seeded
from the Telegram first name. The nine `DEFAULT_AREAS` are seeded exactly as
`/api/auth/register` does — factor that into a shared `createUser()` helper rather than
duplicating it.

---

## 6. Scheduled messages

All times are **local to the user** and stored as `HH:MM` strings; an empty string means
that message is off. Cron runs every 5 minutes; a message fires on the first tick where
the user's local time is within `[slot, slot + 5min)` and no `telegram_outbox_log` row
exists for `(user_id, kind, local_date)`.

| # | Kind | Default | Cadence | Content |
|---|---|---|---|---|
| 1 | `morning` | 07:30 | daily | **One message.** Direction · this week's theme and 3 outcomes · active goals with progress and due dates · today's blocks · carry-over reminder · and the ask: today's three |
| 2 | `review_prompt` | 21:30 | daily | Day stats, then ratings and review questions |
| 3 | `weekly_plan` | Mon 09:00 | weekly | Last week's numbers, then theme + 3 outcomes |
| 4 | `weekly_review` | Sun 20:00 | weekly | Weekly review questions → `reviews(period='weekly')` |
| 5 | `midday_nudge` | 11:00 | conditional | Only if today's top three is still empty. Once per day, respects `nudge_enabled`. |
| 6 | `block_start` | — | per task | 5 min before `tasks.start_min`, with `[Done] [Snooze 15m] [Reschedule]` (P1) |
| 7 | `area_checkin` | 1st of month, 10:00 | monthly | Rate the 9 life areas 1–10 → `areas.satisfaction` (P2) |

Quiet hours (`quiet_from` / `quiet_to`) suppress everything except messages the user
triggered. `paused_until` suppresses everything.

### 6.1 The morning message — brief and ask in one

One message per morning. It tells the user where they are, then asks for today's three.
The ask is the last thing they read, so the message ends on an action rather than on
information.

```
早安，Peiyong ☀️  Friday, 19 Sep

方向 · Direction
"Build things that outlive the hype."

本周 · Week of Sep 15 — “Ship, don't polish”
  ◦ Way v2 live on the custom domain
  ◦ 3 runs, 15km total
  ◦ One long-form essay drafted

目标 · Active goals
  [year]    Financial runway to 18 months   62%   due Dec 31
  [quarter] Way reaches 50 daily users      30%   due Sep 30  ⚠ 11 days
  [quarter] Sub-50min 10k                   45%   due Sep 30

今日 · Today
  09:00–10:30  Deep work: proposals API
  12:00–12:45  Run
  (+3 untimed tasks)
  ⤴ 4 unfinished tasks from earlier days

————————————————
今天的三件事是什么？
直接回复，一行一件。

[✍️ 写三件事]  [📋 抄昨天]  [🤖 让道引拟]
[⤴ 顺延 4 项]  [🗑 放下]
```

**Composition rules**

- Goals whose `target_date` is within 14 days get a ⚠ and the day count.
- The carry-forward row appears only when `carryCount > 0`; the buttons call the same
  logic as `POST /api/carry` with `forward` / `drop`. Tapping either edits the message to
  show the result, so the buttons cannot be tapped twice.
- If today's top three is **already set** (the user planned the night before), the ask
  block is replaced by the three outcomes with `[✓]` buttons, and the message ends
  `三件事已定 ✓`.
- Render with `parse_mode: "HTML"` and escape `& < >`. Never Markdown — a goal titled
  `Ship 50% *fast*` breaks MarkdownV2.
- Hard cap 4096 characters. Truncate the goals list first ("… and N more — /goals"),
  then the task list. The ask block is never truncated.

**Why no `force_reply`**

Telegram's `reply_markup` accepts exactly one of `InlineKeyboardMarkup` or `ForceReply` —
a message cannot have both buttons and a forced reply. The buttons are worth more than
the auto-opened keyboard, so the scheduled message carries the inline keyboard and sets
`telegram_state = awaiting_top_three` (TTL 4 h) instead. The user's next free-text
message is parsed as their three, with no reply-to needed.

`✍️ 写三件事` exists for the case where that is not obvious: it sends a one-line
follow-up (`今天的三件事？一行一件。`) carrying `ForceReply`, which does open the keyboard.
That second message is sent only on demand, so the scheduled cadence stays at one
message per morning. `/plan` does the same thing at any time of day.

### 6.2 Parsing the three

The reply is split on newlines, falling back to `;` / `；` / `1. 2. 3.` numbering, then
trimmed to three items and written through the same path as
`PUT /api/day/:date { top1, top2, top3 }`. The bot echoes the parsed list with `[✏️ 重写]`.

- More than three lines → take the first three, say so, offer `[✏️ 重写]`.
- One line → that is a valid answer; write it to `top1` and leave the rest empty.
- `📋 抄昨天` copies yesterday's `top1..3`, skipping any that were marked done.
- `🤖 让道引拟` calls the existing Guide with a synthesized prompt and renders the
  resulting `set_top_three` proposal as an Approve button (§7.4).
- If nothing arrives by 11:00 local, the `midday_nudge` fires once (§6, row 5).

### 6.3 Review prompt (21:30)

A short state machine, not a wall of text:

1. **Scoreboard.**
   `今天 · 7/9 tasks · Top three: ✓ ✓ ✗ · 3h20m focused`
2. **Four ratings**, one message with four rows of 1–5 buttons (`callback_data`
   `rt:mood:4`). Each tap edits the message in place to show the choice. Writes
   `days.{mood,energy,focus,satisfaction}` — the same columns the Insights mood chart
   reads.
3. **Questions**, one at a time, from the existing daily set in `src/pages/Reviews.tsx`:
   *What moved forward today? / What resisted or distracted me? / What did I learn? /
   What is tomorrow's single focus?* Each with `[跳过 Skip]`.
4. **Write.** Answers → `reviews (period='daily', period_start=<local date>)` via the
   existing upsert. The first answer also fills `days.reflection`. If the fourth answer
   is present, offer `[设为明天的焦点]` → writes tomorrow's `days.top1`.
5. **Close.** `复盘完成 ✓  连续 5 天` (streak = consecutive local dates with a daily review).

The state machine lives in `telegram_state` with `{step, answers}` and a 6-hour TTL. Any
command (`/today`, `/task`) interrupts it cleanly and the bot offers `[继续复盘]`.

---

## 7. Replying: how messages become data

### 7.1 Resolution order

For every incoming update, in order:

1. **Callback query** (button tap) → dispatch on `callback_data`. Never touches the LLM.
2. **Command** (`/…`) → the command table in §7.2. Never touches the LLM.
3. **Pending `telegram_state`** → feed the text to that state machine (top three,
   review answer, timezone, goal progress…).
4. **Reply to a Guide message** → Guide, with that thread as context.
5. **Anything else** → **capture to inbox**, with escalation buttons.

Rule 5 is the one to get right. Default capture is fast, predictable, offline-safe and
costs nothing; the Guide is one tap away:

```
已收进 Inbox · Captured
"call the accountant about Q3"

[📅 今天 Today]  [📅 明天]  [🎯 链接目标]  [🤖 问道引 Ask Guide]  [🗑]
```

### 7.2 Command table

| Command | Behaviour | Writes |
|---|---|---|
| `/start` | Link, login, or help depending on payload | `telegram_accounts` |
| `/today` | Brief + today's tasks, each a `[✓]` button; top three status | reads |
| `/plan` | Fire the plan prompt on demand | `days.top1..3` |
| `/task <text>` | Add task for today. Leading `明天`/`tomorrow`/`周五`/`2026-09-25` sets the date; trailing `@goal` links a goal; `#30m` sets `estimate_min`; `!must` sets priority | `tasks` |
| `/inbox` | List open inbox items with `[Today] [Tomorrow] [🗑]` | `tasks.date`, `tasks.inbox` |
| `/done` | Open tasks for today as buttons; tapping toggles `done` and asks actual minutes | `tasks.done`, `actual_min` |
| `/week` | This week's plan; empty → prompt for theme + 3 outcomes | `weekly_plans` |
| `/goals` | Active goals with progress bars; tap a goal → `[+10%] [-10%] [Set…] [✓ Done] [⏸ Pause]` | `goals.progress`, `goals.status` |
| `/review [daily\|weekly]` | Start a review now | `reviews`, `days` |
| `/note <text>` | Append a line to today's `days.reflection` | `days.reflection` |
| `/guide <text>` | Force the Guide | `guide_messages` |
| `/timezone [IANA]` | Show or set; bare command offers a shortlist | `users.timezone` |
| `/settings` | Inline toggles for each scheduled message + a deep link to the web Settings page | `telegram_prefs` |
| `/mute [today\|7d\|off]` | Pause notifications | `telegram_accounts.paused_until` |
| `/find <text>` | Search tasks and goals by title | reads |
| `/unlink` | Confirm, then delete the link and all pending state | `telegram_accounts` |
| `/help` | The command list, grouped | — |

Register the user-facing subset with `setMyCommands` at deploy time so Telegram shows
the `/` menu. Bilingual descriptions, matching the web UI's `中文<i>English</i>` style.

### 7.3 Callback data format

`callback_data` is capped at **64 bytes**. Use short opaque verbs, never free text:

```
t:<taskId>:d        toggle task done
t:<taskId>:s:<min>  schedule task to today/tomorrow (offset days)
am:<taskId>:<min>   record actual_min
rt:<field>:<n>      rating 1..5
rv:next | rv:skip   review step
c:f | c:d           carry forward / drop
g:<goalId>:p:<n>    set goal progress
pr:<msgId>:<idx>:y  approve proposal idx of guide message
pr:<msgId>:<idx>:n  dismiss
```

Every handler re-checks ownership (`WHERE id = ? AND user_id = ?`) — a `callback_data`
is client-supplied input and can be replayed.

### 7.4 Guide in Telegram

`POST /api/guide/chat` already stores history and returns `proposals`. In Telegram:

- The text part is sent as-is.
- Each proposal becomes a line plus `[✓ Approve] [✗ Dismiss]`, reusing
  `proposalLabel()`'s wording from `src/pages/Guide.tsx` (factor that formatter into
  `shared/` so both clients render proposals identically).
- Approve calls the same `/api/guide/apply` logic. On success the message is edited to
  `✓ Created: …` so the buttons cannot be tapped twice.
- The chat history is shared with the web Guide — the same `guide_messages` rows. Going
  from phone to desktop mid-conversation just works.
- The model call happens in `ctx.waitUntil()` after a fast 200 to Telegram, with a
  `sendChatAction: "typing"` first (§12.2).

**Guide proposals do not currently cover what Telegram needs.** Add three kinds to the
`GuideProposal` union — and remember each one touches four places (`SYSTEM_PROMPT`, the
union, the `apply` handler, the card renderer):

- `{"kind":"set_weekly_plan","week_start":"…","theme":"…","outcomes":["…"]}`
- `{"kind":"update_goal_progress","goal_title":"…","progress":70}`
- `{"kind":"create_review","period":"daily","period_start":"…","answers":{…}}`

---

## 8. Data model — `migrations/0002_telegram.sql`

Never edit `0001_init.sql`.

```sql
ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE users ADD COLUMN password_login_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh';

CREATE TABLE telegram_accounts (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id),
  telegram_user_id INTEGER NOT NULL UNIQUE,
  chat_id          INTEGER NOT NULL,
  username         TEXT NOT NULL DEFAULT '',
  first_name       TEXT NOT NULL DEFAULT '',
  linked_at        TEXT NOT NULL DEFAULT (datetime('now')),
  verified_login   INTEGER NOT NULL DEFAULT 0,   -- gates §5.3
  paused_until     TEXT
);

CREATE TABLE telegram_prefs (
  user_id          INTEGER PRIMARY KEY REFERENCES users(id),
  morning_at       TEXT NOT NULL DEFAULT '07:30',   -- '' = off; brief + the ask, one message
  review_prompt_at TEXT NOT NULL DEFAULT '21:30',
  weekly_plan_at   TEXT NOT NULL DEFAULT '09:00',   -- Monday
  weekly_review_at TEXT NOT NULL DEFAULT '20:00',   -- Sunday
  nudge_enabled    INTEGER NOT NULL DEFAULT 1,
  block_reminders  INTEGER NOT NULL DEFAULT 0,      -- P1
  quiet_from       TEXT NOT NULL DEFAULT '',
  quiet_to         TEXT NOT NULL DEFAULT ''
);

-- idempotency: one row per (user, kind, local date)
CREATE TABLE telegram_outbox_log (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  kind       TEXT NOT NULL,
  local_date TEXT NOT NULL,
  message_id INTEGER,
  sent_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, local_date)
);

-- link nonces, login nonces and 6-digit codes
CREATE TABLE telegram_codes (
  code             TEXT PRIMARY KEY,
  kind             TEXT NOT NULL,                 -- link|login|otp
  user_id          INTEGER REFERENCES users(id),  -- NULL until resolved (login deep link)
  telegram_user_id INTEGER,
  browser_token    TEXT NOT NULL DEFAULT '',      -- binds to the way_pending cookie
  status           TEXT NOT NULL DEFAULT 'pending', -- pending|approved|consumed
  attempts         INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at       TEXT NOT NULL
);
CREATE INDEX idx_tg_codes_expiry ON telegram_codes(expires_at);

-- what the bot is waiting for
CREATE TABLE telegram_state (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  kind       TEXT NOT NULL,          -- awaiting_top_three|review|weekly_plan|timezone|goal_progress
  payload    TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL
);

-- webhook dedupe (Telegram retries on non-2xx)
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX idx_tasks_repeat_src ON tasks(repeat_src);
```

`shared/types.ts` gains `TelegramAccount`, `TelegramPrefs`, `timezone` and
`password_login_disabled` on `User`, and the three new `GuideProposal` kinds.

---

## 9. API surface

All under the existing auth middleware unless marked public.

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/telegram/webhook` | **public**, secret-token header |
| `GET` | `/api/telegram` | Link status + prefs |
| `POST` | `/api/telegram/link/start` | Mint link nonce → deep link + QR payload |
| `GET` | `/api/telegram/link/status?code=` | Poll for completion |
| `DELETE` | `/api/telegram` | Unlink |
| `PUT` | `/api/telegram/prefs` | Whitelist + per-field UPDATE, same pattern as `DAY_FIELDS` |
| `POST` | `/api/telegram/test` | Send a test message ("Send me today's brief") |
| `POST` | `/api/auth/telegram/widget` | **public**, verify Login Widget HMAC → session |
| `POST` | `/api/auth/telegram/start` | **public**, mint login nonce for deep link |
| `GET` | `/api/auth/telegram/poll?code=` | **public**, session cookie once approved |
| `POST` | `/api/auth/telegram/otp` | **public**, send 6-digit code to a linked account |
| `POST` | `/api/auth/telegram/verify` | **public**, exchange code → session |
| `PUT` | `/api/me` | extended with `timezone`, `password_login_disabled` |

---

## 10. Worker architecture

```
worker/
  index.ts          existing Hono app + new routes + scheduled export
  telegram/
    api.ts          sendMessage / editMessageText / answerCallbackQuery / setMyCommands
    webhook.ts      update router: callback → command → state → guide → capture
    commands.ts     one handler per command
    compose.ts      message builders (morning brief, /today, scoreboard, …)
    schedule.ts     runSchedules(): due-user query, fan-out, outbox log
    time.ts         localDate(tz), localTime(tz), localWeekday(tz)
    auth.ts         widget HMAC, nonce and OTP lifecycle
```

### 10.1 `runSchedules`

```
now = new Date(scheduledTime)
rows = SELECT u.id, u.timezone, u.name, u.direction, a.chat_id, a.paused_until, p.*
       FROM telegram_accounts a
       JOIN users u ON u.id = a.user_id
       JOIN telegram_prefs p ON p.user_id = a.user_id
       WHERE a.paused_until IS NULL OR a.paused_until < datetime('now')

for each row:
  date = localDate(tz); hhmm = localTime(tz); dow = localWeekday(tz)
  for each kind whose slot is within [slot, slot+5min) and passes its cadence/quiet check:
     INSERT OR IGNORE INTO telegram_outbox_log(user_id, kind, local_date)  -- returns changes
     if changes == 0: skip          <-- the whole idempotency story
     build + send; on failure DELETE the log row so the next tick retries
```

Fan out with a concurrency cap of ~10 (`Promise.all` over chunks) — Telegram allows
~30 messages/second globally and 1/second per chat.

Handle `403 Forbidden: bot was blocked by the user` by setting `paused_until` far in the
future and flagging the web Settings card as "disconnected"; handle `429` by honouring
`parameters.retry_after` and deleting the outbox row so the next tick retries.

The same cron does housekeeping: delete expired `sessions`, `telegram_codes`,
`telegram_state`, and `telegram_updates` older than a day.

### 10.2 Webhook

Telegram treats any non-2xx as a failure and retries. Therefore:

1. Verify `X-Telegram-Bot-Api-Secret-Token` (constant time). Mismatch → **200 OK** with
   an empty body and a log line, not 401 — a 401 invites retries from whoever is probing.
2. `INSERT OR IGNORE INTO telegram_updates(update_id)`; `changes === 0` → already
   processed → return 200.
3. Resolve the user. Unknown `telegram_user_id` and no `/start <nonce>` → reply with a
   short "link your account at way.peiyong.ai" and return.
4. Dispatch per §7.1. Anything slow (Guide, multi-message composition) goes in
   `c.executionCtx.waitUntil()`; the HTTP response is 200 immediately.
5. Uncaught errors: reply `出错了，请稍后再试` to the user, log, still return 200.

---

## 11. Security

### 11.1 The accepted lockout risk

With `password_login_disabled = 1` and no recovery mechanism, losing the Telegram
account means losing the Way account. Mitigations that are *not* extra mechanisms:

- The password hash is retained, so any still-signed-in session (30-day cookie) can turn
  password login back on.
- The confirmation dialog says so explicitly, in both languages.
- As operator you can always flip the flag in D1: `UPDATE users SET password_login_disabled = 0 WHERE email = ?`.

### 11.2 Secrets and verification

- `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` as `wrangler secret put … --name way`.
  Never in `wrangler.jsonc` `vars` — that file is committed.
- Webhook registered with `setWebhook?secret_token=…&allowed_updates=["message","callback_query"]`.
- Login Widget: HMAC verified with `SHA256(bot_token)` as key; `auth_date` freshness ≤ 300 s.
- Nonces: 32 hex from `crypto.getRandomValues`, 5-minute TTL, single use, bound to a
  `way_pending` httpOnly cookie.
- OTP: 6 digits, 5-minute TTL, 5 attempts, single use, same cookie binding.
- Rate limits: 5 `/api/auth/*` attempts per IP per minute; 10 bot messages per user per
  minute before the bot says "slow down".
- `telegram_user_id` is `UNIQUE` — no shared or transferred identities.
- The bot never renders another user's data; `user_id` scoping per §4.5.
- Deleting the link (`/unlink`) deletes codes, state and outbox rows for that user.

---

## 12. Edge cases and failure modes

| Case | Behaviour |
|---|---|
| Cron misses a tick (Cloudflare does not guarantee exactness) | The `[slot, slot+5min)` window plus the outbox log means at most one send; a missed window means no send that day, not a double. For the 21:30 review, widen to a 15-minute window so a skipped tick still delivers. |
| DST shift | `Intl` handles it. A 08:30 slot simply lands at the new UTC instant. On the "lost hour", a slot inside it is skipped for that day. |
| User travels | Timezone is manual (`/timezone`). Optionally offer to update when Telegram reports a very different local time — P2. |
| User replies hours after the prompt | `telegram_state` TTL is 4–6 h. After expiry, free text falls to inbox capture. The bot says "复盘已过期 — /review 重新开始". |
| Reply with more than three lines | Take the first three, say so, offer `[✏️ Redo]`. |
| Two devices answering the same button | `callback_data` handlers are idempotent; the message is edited to a terminal state after the first tap. |
| Bot blocked or chat deleted | `403` → pause, mark disconnected in web Settings, stop sending. |
| Message over 4096 chars | Truncate lists with "… and N more". |
| Guide unavailable (no `OPENAI_API_KEY`, no Workers AI locally) | The bot says so and offers the deterministic path. Everything in P0 except `/guide` works with no model at all. |
| Local dev | No cron and no AI binding on `wrangler.dev.jsonc`. Test the schedule with `curl "http://localhost:5174/__scheduled"` and the webhook with a saved update JSON POSTed by `curl`, or a Cloudflare Tunnel to receive real updates. |

### 12.1 Scaling note

One D1 query per cron tick over all linked users is fine to the low hundreds. Past that,
precompute `next_send_at` (UTC) per user per kind and index it, so each tick reads only
due rows. Do not build that until it is needed.

---

## 13. Phasing

### P0 — the closed loop (ship first)

**Prerequisites:** §4.1 timezone, §4.2 scheduled export, §4.3/§4.4 webhook routing,
migration `0002`.

1. Bot created, token + webhook secret as Worker secrets, `setMyCommands`, `/setdomain`.
2. Link from web (§5.1) with QR; Settings → Telegram card showing status, times and
   an unlink button.
3. Telegram sign-in: Login Widget (§5.2a) + 6-digit code (§5.2c).
4. `password_login_disabled` toggle with the blunt warning (§5.3).
5. Scheduled: `morning` (brief + ask, one message) and `review_prompt`, with the outbox log.
6. Replies: top three parsing, review state machine with ratings, carry-forward buttons,
   task `[✓]` buttons, free text → inbox capture.
7. Commands: `/start /today /plan /task /done /inbox /review /timezone /settings /mute /help`.

**Acceptance:** a user who never opens the browser for a week ends with 7 `days` rows
carrying a top three and four ratings, 7 daily `reviews` rows, and their captured tasks
in `tasks` — all timestamped against their own local dates.

### P1 — the working day

8. `/goals` with progress buttons; `/week` and the Monday weekly plan prompt;
   Sunday weekly review.
9. Guide in Telegram with inline proposal approval (§7.4), plus the three new
   proposal kinds.
10. Time-block start reminders with `[Done] [Snooze] [Reschedule]`, and `actual_min`
    capture on completion.
11. Midday nudge, quiet hours, `/find`.
12. Deep-link sign-in (§5.2b) with the confirmation prompt.

### P2 — the full second client

13. Register from Telegram (§5.4).
14. Voice messages → Workers AI transcription → capture.
15. Forwarded messages and links → inbox with the source preserved.
16. Monthly life-area satisfaction check-in.
17. Weekly recap card, streaks (opt-in, never guilt-based).
18. Timezone auto-detection prompt.
19. Inline mode (`@WayGuideBot buy milk` from any chat).

---

## 14. Metrics

- **Link rate:** % of active accounts with a linked Telegram.
- **Loop completion:** % of user-days with both a top three and a daily review, before
  vs. after linking. This is the number that says whether the feature worked.
- **Reply rate per message kind** — a prompt below ~20% reply rate should be reworded or
  switched off by default.
- **Capture volume:** inbox items created from Telegram vs. web.
- **Delivery health:** sends, 429s, 403s (blocked), and outbox rows deleted for retry.
- **Unsubscribe signals:** `/mute` and `/unlink` counts.

---

## 15. Open questions

1. **Bot handle** — `@WayGuideBot` is a placeholder; needs to be registered.
2. **Message language** — proposal is to follow `users.locale`, defaulting to the
   bilingual `中文 · English` style of the web UI for headings and Chinese-only for
   prompts. Confirm, or go Chinese-only in the bot.
3. **Morning message weight — the open risk of merging.** Now that the brief and the ask
   are one message (§6.1), direction + week + goals + today + the ask is the longest
   thing Way ever sends, and the ask sits at the bottom where a skimmer stops reading.
   Two fallbacks if reply rate disappoints, in order of preference:
   (a) fold the goals list behind a `[目标 Goals]` button, leaving direction + week +
   today + ask — this is the one to try first;
   (b) move the ask to the top and the context below it.
   Instrument reply-rate from day one (§14) so this is a data call, not a taste call.
4. **`estimate_min` prompting** — asking "how long?" on every completion may be too much
   friction. Suggest asking only for tasks that had an `estimate_min` set.
