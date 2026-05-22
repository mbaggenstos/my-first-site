-- Persistent cursor for 180-day backfill within Workers free-plan subrequest budget.
ALTER TABLE sync_state ADD COLUMN backfill_offset INTEGER DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN backfill_done INTEGER DEFAULT 0;
ALTER TABLE sync_state ADD COLUMN oldest_activity_ts INTEGER;
