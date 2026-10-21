CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_class_assignments (
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  class_id TEXT NOT NULL REFERENCES classes_core(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, class_id)
);

CREATE INDEX IF NOT EXISTS user_class_assignments_class_idx
  ON user_class_assignments(class_id);

CREATE TABLE IF NOT EXISTS user_class_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  defaults_initialized INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO app_users (id, display_name, role, sort_order) VALUES
  ('pedro', 'Pedro', 'admin', 1),
  ('maria-joao', 'M.ª João', 'user', 2),
  ('rita-g', 'Rita G.', 'user', 3);
