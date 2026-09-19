-- Telegram P1/P2 (docs/PRD-telegram.md §6, §13): weekly prompts, midday nudge, block reminders,
-- monthly life-area check-in, deep-link sign-in, Guide threads in the chat, and delivery/engagement events.

-- The prompts the PRD turns on by default. NULL still means off; the link path seeds new rows explicitly.
UPDATE telegram_prefs SET weekly_plan_at = '09:00' WHERE weekly_plan_at IS NULL;
UPDATE telegram_prefs SET weekly_review_at = '20:00' WHERE weekly_review_at IS NULL;
UPDATE telegram_prefs SET nudges = 1;                -- PRD §6 row 5: the midday nudge is on unless switched off

ALTER TABLE telegram_prefs ADD COLUMN checkin_at TEXT;                         -- monthly life-area check-in, 1st of the month, 'HH:MM' local; NULL = off
ALTER TABLE telegram_prefs ADD COLUMN streaks INTEGER NOT NULL DEFAULT 0;      -- opt-in: show streaks in the weekly recap
UPDATE telegram_prefs SET checkin_at = '10:00';

-- Deep-link sign-in (§5.2(b)): where the request came from, shown to the user before they approve it.
ALTER TABLE telegram_codes ADD COLUMN meta TEXT;                               -- JSON {country, browser}

-- A Guide reply sent to the chat remembers its Telegram message id, so replying to it continues the thread.
ALTER TABLE guide_messages ADD COLUMN tg_message_id INTEGER;
CREATE INDEX idx_guide_tg_message ON guide_messages(user_id, tg_message_id);

-- Delivery and engagement events (§14): what was sent, what was answered, what went wrong.
CREATE TABLE telegram_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                        -- morning|review_prompt|weekly_plan|…|capture|command|mute|unlink
  event TEXT NOT NULL,                       -- sent|replied|blocked|rate_limited|error|used
  local_date TEXT,                           -- YYYY-MM-DD in the user's timezone
  latency_s INTEGER,                         -- replied: seconds since the prompt was sent
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_telegram_events_user ON telegram_events(user_id, created_at);

-- Block reminders look up today's timed tasks every tick.
CREATE INDEX idx_tasks_user_date_start ON tasks(user_id, date, start_min);
