-- Per-market pagination cursor so we can resume across cron runs.
ALTER TABLE discovery_queue ADD COLUMN offset INTEGER DEFAULT 0;
ALTER TABLE discovery_queue ADD COLUMN trades_processed INTEGER DEFAULT 0;
ALTER TABLE discovery_queue ADD COLUMN last_run_at INTEGER;
ALTER TABLE discovery_queue ADD COLUMN oldest_ts INTEGER;
ALTER TABLE discovery_queue ADD COLUMN winning_outcome INTEGER;
ALTER TABLE discovery_queue ADD COLUMN resolved INTEGER DEFAULT 0;
