CREATE TABLE IF NOT EXISTS attendance_ignored_dates (
  class_id TEXT NOT NULL,
  date_key TEXT NOT NULL,
  ignored_at INTEGER NOT NULL,
  PRIMARY KEY (class_id, date_key)
);
