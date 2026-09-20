# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Way · 道 — a single-user-per-account personal life-planning web app: direction → yearly/quarterly/weekly goals → daily top-three + time-blocked tasks → reviews, plus an AI "Guide" that proposes changes for approval. Live at https://way.peiyong.ai. See `README.md` for the feature list and the production/backup history.

## Commands

```sh
npm run dev                 # Vite + Cloudflare plugin on http://localhost:5174 (uses wrangler.dev.jsonc)
npm run typecheck           # tsc over BOTH projects (tsconfig.app.json + tsconfig.worker.json) — the only check; no lint, no tests
npm run build               # vite build → dist/client (assets) + dist/way (worker + resolved wrangler.json)
npm run deploy              # build, then `wrangler deploy -c dist/way/wrangler.json` → prod worker `way`
npm run db:migrate:local    # apply migrations/ to the local D1 used by `npm run dev`
npm run db:migrate:remote   # apply migrations/ to the production D1 (way-preview-db)
npx wrangler secret put OPENAI_API_KEY --name way   # optional: upgrade Guide from Workers AI to an OpenAI-compatible model
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET --name way   # the webhook's secret_token (see worker/telegram/webhook.ts)
TELEGRAM_WEBHOOK_SECRET=... npm run telegram:setup   # after a deploy: setWebhook (this origin, ALLOWED_UPDATES) + the bot's / command menu (POST /api/telegram/setup)
npm run check:telegram      # unit-ish checks for worker/telegram/api.ts (esc, callback_data, 4096 guard, 403/429 results); fetch is stubbed
npm run check:workout       # unit-ish checks for worker/telegram/workout.ts (the wo: formats, /workout parsing); also a module-cycle check
curl "http://localhost:5174/cdn-cgi/handler/scheduled"   # fire one cron tick (runSchedules) under `npm run dev`; /__scheduled is wrangler-dev only
```

- Local dev has **no Workers AI binding** (`wrangler.dev.jsonc` omits `ai`), so `/api/guide/chat` returns 502 locally unless you put `OPENAI_API_KEY=...` in a gitignored `.dev.vars`.
- Package.json's `deploy` script (`dist/way/…`) is authoritative; the README's `dist/way_preview/…` line is stale.
- Migrations: numbered `.sql` files in `migrations/`, applied by wrangler's migration tracker. Only `0001_init.sql` exists; add `0002_*.sql` for schema changes and never edit `0001`.

## Architecture

**Two TypeScript projects, one shared contract.** `tsconfig.app.json` covers `src/` (browser, React 18) and `tsconfig.worker.json` covers `worker/` (Cloudflare Worker, Hono). Both include `shared/types.ts`, which is the API contract — every row shape and enum (`GoalLevel`, `Priority`, `Repeat`, `GuideProposal`, …) lives there. Imports use explicit `.ts`/`.tsx` extensions.

**Config switching.** `vite.config.ts` hands `@cloudflare/vite-plugin` `wrangler.dev.jsonc` on `dev` and `wrangler.jsonc` on `build`. Both point at the same D1 (`way-preview-db`). Static assets are served with SPA fallback; `run_worker_first: ["/api/*"]` means only `/api/*` reaches the worker, and the worker's final `app.all("*")` forwards anything else to `ASSETS`.

**Backend (`worker/index.ts`, one Hono app).** Sections in order: helpers → auth → day/tasks → goals & areas → projects → timeline → reviews → insights → guide → fallback. Key conventions:
- Auth middleware on `/api/*` (except `/api/auth/*`) resolves the `way_session` cookie against the `sessions` table and sets `c.get("userId")`. **Every SQL statement is scoped by `user_id`**; keep it that way.
- Passwords are PBKDF2-SHA256 via Web Crypto (`worker/auth.ts`), sessions are D1 rows with a 30-day expiry. No JWT, no external auth.
- Partial updates use a whitelist + per-field `UPDATE` loop (`DAY_FIELDS`, `TASK_FIELDS`). Adding a column means: migration + whitelist entry + `shared/types.ts` field.
- Dates are `YYYY-MM-DD` strings everywhere, validated by `assertDate`. Server-side date math is plain calendar arithmetic on those strings (`weekStartOf`, `periodRange`, `reviewPeriodStart`); when the server has to pick "today" itself (`/api/reviews`, `/api/insights`, `guideContext`, the Telegram scheduler/bot) it uses `users.timezone` (IANA, NULL = UTC) via `worker/telegram/time.ts`; client-side `todayStr()`/`addDays()` in `src/api.ts` use local time. Weeks start on Monday.
- Tasks: `inbox=1` = unscheduled; `start_min`/`end_min` are minutes from midnight for the schedule grid; repeating tasks (`repeat` daily/weekly) are materialized into concrete rows (`repeat_src` → source id) lazily inside `GET /api/day`; carry-over of past undone tasks is `POST /api/carry` with `forward` (bumps `carried`) or `drop` (sets `dropped=1`).
- Register seeds the nine `DEFAULT_AREAS` for the new user.

**Guide (`worker/guide.ts`).** `chatComplete` uses an OpenAI-compatible `/chat/completions` call when `OPENAI_API_KEY` is set (base URL and model from `vars`), otherwise Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Context is rebuilt per message by `guideContext` (direction, areas, active goals, today, weekly plan) and the last 12 messages are replayed. The model never writes data: it appends a ```` ```proposals ```` fenced JSON array that `extractProposals` strips out; the client renders cards and `POST /api/guide/apply` applies one approved proposal. Adding a proposal kind touches four places: `SYSTEM_PROMPT`, the `GuideProposal` union, the `apply` handler, and `proposalLabel()` in `shared/proposals.ts` (the wording shared by the web card in `src/pages/Guide.tsx` and other clients).

**Body (`worker/body.ts`, spec in `docs/PRD-body.md`).** A weight goal gets a `body_plans` row (migration `0004_body.sql`) and `bodySummary()` turns the weigh-ins into the 7-day trend, the weekly rate, the projected date and a verdict — deterministically, no model. `guideContext` carries it as one `Body:` line, `guideChat` puts `bodyVerdictLine()` in front of any reply about the goal, and `/body` prints the same numbers, so the bot and the Guide can never disagree. The Guide's body proposals (`set_body_plan`, `log_weight`, `log_workout`) go through `applyProposal` like every other kind; meals are never proposed.

**Telegram (`worker/telegram/`, spec in `docs/PRD-telegram.md`).** One shared bot; `webhook.ts` is the entry point (`POST /api/telegram/webhook`, secret header, `update_id` dedupe, user resolved once from `telegram_accounts.telegram_user_id`), `router.ts` fixes the resolution order (button → command → pending `telegram_state` → reply-to-Guide → inbox capture), `commands.ts` is the command table, `callback.ts` the 64-byte `callback_data` protocol (every verb parses back; a type-level assertion fails typecheck if a format grows past 64 bytes), `schedule.ts` the cron (`*/5`) with `telegram_outbox_log` as the once-per-local-day claim. Feature modules: `compose.ts` (morning message), `topthree.ts`, `review.ts` (daily + weekly), `weekly.ts`, `goals.ts`, `blocks.ts`, `checkin.ts`, `bodynudge.ts` (the 12:00 `body_nudge` — four rules, one message a day, each rule once a week — and the Sunday `body_recap` inside `weekly_review`), `workout.ts` (`/workout`, the evening `workout_check`, the 记为运动 offer on a ticked-off workout-looking task), `guide.ts` (Guide threads in the chat; approval goes through `worker/proposals.ts`, the same code as `/api/guide/apply`), `login.ts` / `link.ts` / `register.ts` / `account.ts`, `capture.ts` (voice via Workers AI whisper, inline mode), `events.ts` (`telegram_events` → `GET /api/telegram/stats`). Rules: every SQL statement takes the resolved `userId`; a new verb goes in `callback.ts` (format + parser + builder + `Widest`) before its handler; a new scheduled kind is one entry in `KINDS`; modules form import cycles, so never use an imported binding at module top level (Node's `check:telegram`-style load would throw a TDZ error, and so would the Worker). Local dev: `npm run check:telegram` for api.ts; a Node script importing `callback.ts` loads the whole graph and is the cheapest cycle check.

**Frontend.** No router library: `usePath()` in `src/api.ts` wraps `pushState`/`popstate`, and `App.tsx` switches on the pathname. Pages that depend on a query string (`Today`, `Timeline`) receive `search` and are keyed by full path so navigation remounts them. `useApp()` exposes `{ user, nav, refreshUser }`. Pages load with `api.get` in `useEffect`, update local state optimistically, then `api.put`/`api.post`; `api.*` throws `ApiError` with the server's `error` string. Auth gating and redirects all happen in `App.tsx`.

**Styling.** One file, `src/styles.css`, with design tokens in `:root` (paper `--paper`, ink `--ink`, seal red `--red`, fonts `--kai`/`--serif-en`/`--brush`). This is the 画·书 (huashu) "ink & paper" design shared with `../english.peiyong.ai`; keep new UI on those tokens and existing primitives (`.card`, `.btn`, `.input`, `.chip`, `.checkbox`, `.ruled`). Headings and nav labels are bilingual: `中文<i>English</i>`.

## Production facts (not derivable from code)

- Prod is worker `way` on `way.peiyong.ai`, D1 `way-preview-db` (id in `wrangler.jsonc`). The older D1 `way-db` is a frozen backup from the previous implementation — do not migrate, write to, or delete it.
- A leftover worker `way-preview` shares the same D1; safe to delete with `wrangler delete --name way-preview` once confirmed unused.
- `backup/` (gitignored) holds the SQL dump from the migration off the old version.
