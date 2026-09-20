-- Body P2 (docs/PRD-body.md §13): the monthly report's slot and the per-dish corrections that make
-- later estimates the user's own numbers. Adaptive prompt times need no schema: they are read from the
-- logs and claimed in telegram_outbox_log like every other once-a-week message.

-- The monthly body report (§13 item 11): local 'HH:MM' on the 1st, NULL = off, filled from the default
-- when a body plan is created, exactly like the other body slots.
ALTER TABLE telegram_prefs ADD COLUMN body_month_at TEXT;   -- '09:00' when a plan is created

-- Per-dish corrections (§13 item 12): when the user overrides the estimate of a meal that is one dish,
-- that dish's numbers are remembered and used the next time the same dish is estimated. One row per
-- user per normalised dish name; the latest correction wins and `samples` counts how often it was made.
CREATE TABLE meal_dish_notes (
  user_id    INTEGER NOT NULL REFERENCES users(id),
  dish       TEXT NOT NULL,                          -- normalised dish name (lower case, no portion)
  kcal       INTEGER,
  protein_g  INTEGER,
  samples    INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, dish)
);
