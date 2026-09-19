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
- Dates are `YYYY-MM-DD` strings everywhere, validated by `assertDate`. Server-side date math is UTC (`weekStartOf`, `periodRange`, `reviewPeriodStart`); client-side `todayStr()`/`addDays()` in `src/api.ts` use local time. Weeks start on Monday.
- Tasks: `inbox=1` = unscheduled; `start_min`/`end_min` are minutes from midnight for the schedule grid; repeating tasks (`repeat` daily/weekly) are materialized into concrete rows (`repeat_src` → source id) lazily inside `GET /api/day`; carry-over of past undone tasks is `POST /api/carry` with `forward` (bumps `carried`) or `drop` (sets `dropped=1`).
- Register seeds the nine `DEFAULT_AREAS` for the new user.

**Guide (`worker/guide.ts`).** `chatComplete` uses an OpenAI-compatible `/chat/completions` call when `OPENAI_API_KEY` is set (base URL and model from `vars`), otherwise Workers AI `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Context is rebuilt per message by `guideContext` (direction, areas, active goals, today, weekly plan) and the last 12 messages are replayed. The model never writes data: it appends a ```` ```proposals ```` fenced JSON array that `extractProposals` strips out; the client renders cards and `POST /api/guide/apply` applies one approved proposal. Adding a proposal kind touches four places: `SYSTEM_PROMPT`, the `GuideProposal` union, the `apply` handler, and `proposalLabel()` in `shared/proposals.ts` (the wording shared by the web card in `src/pages/Guide.tsx` and other clients).

**Frontend.** No router library: `usePath()` in `src/api.ts` wraps `pushState`/`popstate`, and `App.tsx` switches on the pathname. Pages that depend on a query string (`Today`, `Timeline`) receive `search` and are keyed by full path so navigation remounts them. `useApp()` exposes `{ user, nav, refreshUser }`. Pages load with `api.get` in `useEffect`, update local state optimistically, then `api.put`/`api.post`; `api.*` throws `ApiError` with the server's `error` string. Auth gating and redirects all happen in `App.tsx`.

**Styling.** One file, `src/styles.css`, with design tokens in `:root` (paper `--paper`, ink `--ink`, seal red `--red`, fonts `--kai`/`--serif-en`/`--brush`). This is the 画·书 (huashu) "ink & paper" design shared with `../english.peiyong.ai`; keep new UI on those tokens and existing primitives (`.card`, `.btn`, `.input`, `.chip`, `.checkbox`, `.ruled`). Headings and nav labels are bilingual: `中文<i>English</i>`.

## Production facts (not derivable from code)

- Prod is worker `way` on `way.peiyong.ai`, D1 `way-preview-db` (id in `wrangler.jsonc`). The older D1 `way-db` is a frozen backup from the previous implementation — do not migrate, write to, or delete it.
- A leftover worker `way-preview` shares the same D1; safe to delete with `wrangler delete --name way-preview` once confirmed unused.
- `backup/` (gitignored) holds the SQL dump from the migration off the old version.
