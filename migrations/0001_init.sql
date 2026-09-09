-- Way — personal life-planning system. Single-file schema.

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b9080',
  satisfaction INTEGER,              -- 1..10, nullable
  archived INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_areas_user ON areas(user_id);

CREATE TABLE goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT 'year',        -- lifetime|year|quarter|month|week
  type TEXT NOT NULL DEFAULT 'outcome',      -- outcome|process|maintenance|learning
  status TEXT NOT NULL DEFAULT 'active',     -- draft|active|at_risk|paused|completed|abandoned|archived
  area_id INTEGER REFERENCES areas(id),
  parent_id INTEGER REFERENCES goals(id),
  priority TEXT NOT NULL DEFAULT 'should',   -- must|should|could
  start_date TEXT,
  target_date TEXT,
  progress INTEGER NOT NULL DEFAULT 0,       -- 0..100
  confidence INTEGER,                        -- 1..5
  success_criteria TEXT NOT NULL DEFAULT '',
  motivation TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_goals_user ON goals(user_id);

CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  goal_id INTEGER REFERENCES goals(id),
  status TEXT NOT NULL DEFAULT 'active',     -- active|finished
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_projects_user ON projects(user_id);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  date TEXT,                                 -- YYYY-MM-DD; NULL = inbox item
  inbox INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'should',   -- must|should|could
  energy TEXT,                               -- low|medium|high
  estimate_min INTEGER,
  actual_min INTEGER,
  start_min INTEGER,                         -- minutes from 00:00; schedule block
  end_min INTEGER,
  goal_id INTEGER REFERENCES goals(id),
  project_id INTEGER REFERENCES projects(id),
  repeat TEXT NOT NULL DEFAULT 'never',      -- never|daily|weekly
  repeat_src INTEGER REFERENCES tasks(id),   -- materialized from this repeating task
  notes TEXT NOT NULL DEFAULT '',
  done INTEGER NOT NULL DEFAULT 0,
  done_at TEXT,
  dropped INTEGER NOT NULL DEFAULT 0,        -- "let it go" on carry-over
  carried INTEGER NOT NULL DEFAULT 0,        -- times brought forward
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_tasks_user_date ON tasks(user_id, date);

CREATE TABLE days (
  user_id INTEGER NOT NULL REFERENCES users(id),
  date TEXT NOT NULL,
  intention TEXT NOT NULL DEFAULT '',
  reflection TEXT NOT NULL DEFAULT '',
  mood INTEGER, energy INTEGER, focus INTEGER, satisfaction INTEGER,  -- 1..5
  top1 TEXT NOT NULL DEFAULT '', top1_done INTEGER NOT NULL DEFAULT 0,
  top2 TEXT NOT NULL DEFAULT '', top2_done INTEGER NOT NULL DEFAULT 0,
  top3 TEXT NOT NULL DEFAULT '', top3_done INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, date)
);

CREATE TABLE weekly_plans (
  user_id INTEGER NOT NULL REFERENCES users(id),
  week_start TEXT NOT NULL,                  -- Monday YYYY-MM-DD
  theme TEXT NOT NULL DEFAULT '',
  outcome1 TEXT NOT NULL DEFAULT '',
  outcome2 TEXT NOT NULL DEFAULT '',
  outcome3 TEXT NOT NULL DEFAULT '',
  commitments TEXT NOT NULL DEFAULT '',
  risks TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (user_id, week_start)
);

CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  period TEXT NOT NULL,                      -- daily|weekly|monthly|quarterly|yearly
  period_start TEXT NOT NULL,
  answers TEXT NOT NULL DEFAULT '{}',        -- JSON {question: answer}
  mood INTEGER, energy INTEGER, focus INTEGER, satisfaction INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, period, period_start)
);

CREATE TABLE guide_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,                        -- user|assistant
  content TEXT NOT NULL,
  proposals TEXT,                            -- JSON array, assistant only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_guide_user ON guide_messages(user_id);
