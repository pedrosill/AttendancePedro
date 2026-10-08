CREATE TABLE IF NOT EXISTS attendance_dates (
  class_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(class_id, date_key)
);

CREATE INDEX IF NOT EXISTS attendance_dates_class_date_idx
  ON attendance_dates(class_id, date_key);

INSERT OR IGNORE INTO attendance_dates (class_id, date_key, created_at)
SELECT class_id, date_key, updated_at FROM attendance_core;

CREATE TABLE IF NOT EXISTS attendance_history_sync (
  class_id TEXT PRIMARY KEY,
  complete INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
