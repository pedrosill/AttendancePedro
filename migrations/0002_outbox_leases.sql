ALTER TABLE outbox ADD COLUMN locked_until INTEGER;
ALTER TABLE outbox ADD COLUMN lock_token TEXT;

CREATE INDEX IF NOT EXISTS outbox_lease_idx ON outbox(locked_until, created_at, id);
