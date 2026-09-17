CREATE TABLE IF NOT EXISTS classes_core (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  training_days_json TEXT NOT NULL DEFAULT '[]',
  season_start TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members_core (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  photo_key TEXT NOT NULL DEFAULT '',
  photo_version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  UNIQUE(class_id, name_key)
);

CREATE INDEX IF NOT EXISTS members_core_class_idx ON members_core(class_id, name_key);

CREATE TABLE IF NOT EXISTS attendance_core (
  class_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  class_name TEXT NOT NULL DEFAULT '',
  members_json TEXT NOT NULL DEFAULT '[]',
  operation_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(class_id, date_key)
);

CREATE INDEX IF NOT EXISTS attendance_core_date_idx ON attendance_core(date_key, updated_at);

CREATE TABLE IF NOT EXISTS mutation_locks (
  scope TEXT PRIMARY KEY,
  locked_until INTEGER,
  lock_token TEXT
);

CREATE TABLE IF NOT EXISTS sync_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_success_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

ALTER TABLE outbox ADD COLUMN operation_id TEXT;
ALTER TABLE outbox ADD COLUMN next_attempt_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS outbox_operation_idx ON outbox(operation_id) WHERE operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS outbox_next_attempt_idx ON outbox(next_attempt_at, created_at, id);
