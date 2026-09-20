-- Streams (docs/PRD-brain.md §6): one table for everything a user logs, so a new kind of tracker is a
-- row rather than a migration. The derivations over `observations` are generic — "sum this week" is the
-- same code whether num means kilograms or minutes — which is what makes one table enough.

CREATE TABLE streams (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  name               TEXT NOT NULL,                       -- 读书时长
  shape              TEXT NOT NULL,                       -- number|duration|count|bool|money|text
  unit               TEXT,                                -- min|kg|次|元 — display, and what a bare number means
  min_value          REAL,                                -- plausible range; outside it is a typo, not a reading
  max_value          REAL,
  aliases            TEXT NOT NULL DEFAULT '[]',          -- JSON string[]: the user's own words (§8.3)
  bare_value_capture INTEGER NOT NULL DEFAULT 0,          -- a naked number logs here; off by default (§8.3)
  ask_at             TEXT,                                -- local HH:MM, NULL = never asks
  ask_text           TEXT,                                -- the question; NULL = generated from the name
  quick              TEXT NOT NULL DEFAULT '[]',          -- JSON number[]: one-tap answers on the ask
  status             TEXT NOT NULL DEFAULT 'active',      -- active|paused|retired
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, name)
);
CREATE INDEX idx_streams_user ON streams(user_id, status);

CREATE TABLE observations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  stream_id  INTEGER NOT NULL REFERENCES streams(id),
  at         TEXT NOT NULL,                               -- local YYYY-MM-DD
  time_min   INTEGER,                                     -- minutes from local midnight, when it matters
  num        REAL,                                        -- number|duration|count|money|bool(0/1)
  text       TEXT,                                        -- shape = text
  source     TEXT NOT NULL DEFAULT 'telegram',            -- telegram|web|timer|guide
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_obs_stream ON observations(user_id, stream_id, at);

-- One running timer per user (PRD-brain §11): /开始 <stream> … /停止 turns wall-clock into an observation.
CREATE TABLE stream_timers (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id),
  stream_id  INTEGER NOT NULL REFERENCES streams(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A goal becomes a claim the system can verify (PRD-brain §7): a kind over a stream with a target.
-- Existing goals have goal_kind NULL and behave exactly as before — qualitative, progress typed by hand.
ALTER TABLE goals ADD COLUMN goal_kind    TEXT;           -- reach|accumulate|streak|reduce|maintain|complete
ALTER TABLE goals ADD COLUMN stream_id    INTEGER REFERENCES streams(id);
ALTER TABLE goals ADD COLUMN target_value REAL;
ALTER TABLE goals ADD COLUMN period       TEXT;           -- accumulate/reduce/maintain: day|week|month
CREATE INDEX idx_goals_stream ON goals(user_id, stream_id);
