-- Body (docs/PRD-body.md §7): a weight goal's plan and the three logs behind it, plus the
-- Telegram slots the body prompts use. One body plan per user; every row scoped by user_id.

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

-- The body prompt slots (§6): local 'HH:MM', NULL = off. Filled from the defaults when a plan is created.
ALTER TABLE telegram_prefs ADD COLUMN weigh_at     TEXT;   -- '07:00' when a plan is created
ALTER TABLE telegram_prefs ADD COLUMN breakfast_at TEXT;   -- '08:30'
ALTER TABLE telegram_prefs ADD COLUMN lunch_at     TEXT;   -- '13:00'
ALTER TABLE telegram_prefs ADD COLUMN dinner_at    TEXT;   -- '19:30'
ALTER TABLE telegram_prefs ADD COLUMN workout_at   TEXT;   -- '20:30'
ALTER TABLE telegram_prefs ADD COLUMN body_nudges  INTEGER NOT NULL DEFAULT 1;
