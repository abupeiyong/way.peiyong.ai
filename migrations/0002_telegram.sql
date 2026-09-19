-- Telegram companion (docs/PRD-telegram.md §8). Timestamps are SQLite datetime() text, except sessions.
-- Column names follow the worker code (worker/telegram/*.ts): telegram_prefs.review_at and .nudges.

ALTER TABLE users ADD COLUMN timezone TEXT;                                   -- IANA; NULL = UTC
ALTER TABLE users ADD COLUMN password_login_disabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locale TEXT;

CREATE TABLE telegram_accounts (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  telegram_user_id INTEGER NOT NULL UNIQUE,  -- one Telegram identity ↔ one Way account
  chat_id INTEGER NOT NULL,
  username TEXT,
  first_name TEXT,
  verified_login INTEGER NOT NULL DEFAULT 0, -- 1 once a Telegram sign-in has succeeded
  paused_until TEXT,                         -- '9999-12-31 23:59:59' = bot blocked (disconnected)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE telegram_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  morning_at TEXT DEFAULT '07:30',           -- local 'HH:MM' in users.timezone; NULL = off
  review_at TEXT DEFAULT '21:30',            -- evening review prompt
  weekly_plan_at TEXT,
  weekly_review_at TEXT,
  nudges INTEGER NOT NULL DEFAULT 0,
  block_reminders INTEGER NOT NULL DEFAULT 0,
  quiet_from TEXT,
  quiet_to TEXT
);

-- Idempotency for scheduled sends: a row = that kind was sent (or is being sent) for that local date.
CREATE TABLE telegram_outbox_log (
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL,                        -- morning|review_prompt|…
  local_date TEXT NOT NULL,                  -- YYYY-MM-DD in the user's timezone
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, kind, local_date)
);

-- Link nonces, login nonces and OTPs.
CREATE TABLE telegram_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,                        -- link|login|otp
  code TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id),
  browser_token TEXT,                        -- binds a login/OTP to the browser that asked for it
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_telegram_codes_expires ON telegram_codes(expires_at);

-- What the bot is waiting for from one user.
CREATE TABLE telegram_state (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  payload TEXT NOT NULL,                     -- JSON
  expires_at TEXT NOT NULL
);

-- Webhook dedupe.
CREATE TABLE telegram_updates (
  update_id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_tasks_repeat_src ON tasks(repeat_src);
