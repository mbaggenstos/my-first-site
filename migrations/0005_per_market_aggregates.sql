-- Per-(user, tag, market) aggregates so we can compute Markets-Played,
-- Trades-per-Market, Avg-Position-Size, Largest-Single-Trade.
CREATE TABLE user_tag_market (
  user_addr TEXT NOT NULL,
  tag_slug  TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  trades   INTEGER DEFAULT 0,
  volume   REAL    DEFAULT 0,
  pnl      REAL    DEFAULT 0,
  largest_trade REAL DEFAULT 0,
  first_trade_ts INTEGER,
  last_trade_ts  INTEGER,
  PRIMARY KEY (user_addr, tag_slug, condition_id)
);
CREATE INDEX idx_utm_user_tag ON user_tag_market(user_addr, tag_slug);
CREATE INDEX idx_utm_tag_market ON user_tag_market(tag_slug, condition_id);
