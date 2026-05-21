-- Skill metrics: wins/losses + edge per trade on resolved markets
ALTER TABLE user_tag_daily ADD COLUMN wins   INTEGER DEFAULT 0;
ALTER TABLE user_tag_daily ADD COLUMN losses INTEGER DEFAULT 0;
ALTER TABLE user_tag_daily ADD COLUMN edge   REAL DEFAULT 0;

-- Unrealized P&L from open positions, refreshed on each user sync
CREATE TABLE user_tag_unrealized (
  user_addr TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  cash_pnl REAL DEFAULT 0,
  current_value REAL DEFAULT 0,
  initial_value REAL DEFAULT 0,
  open_positions INTEGER DEFAULT 0,
  updated_at INTEGER,
  PRIMARY KEY (user_addr, tag_slug)
);

-- Enrich markets with resolution data (used for edge/wins/losses)
ALTER TABLE markets ADD COLUMN winning_outcome INTEGER;
ALTER TABLE markets ADD COLUMN outcomes TEXT;
ALTER TABLE markets ADD COLUMN resolution_status TEXT;

-- Discovery: per-tag queue of markets to crawl for new traders
CREATE TABLE discovery_queue (
  scope TEXT NOT NULL,
  market_id TEXT NOT NULL,
  event_slug TEXT,
  added_at INTEGER,
  status TEXT DEFAULT 'pending',
  PRIMARY KEY (scope, market_id)
);
CREATE INDEX idx_dq_status ON discovery_queue(scope, status, added_at);
