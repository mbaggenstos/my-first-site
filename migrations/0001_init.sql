-- Polymarket Player-Analytics Schema
-- Approach: store only aggregates per (user, tag, day). Raw trades are fetched
-- from the Polymarket data-api and discarded after aggregation.

CREATE TABLE tags (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  enabled INTEGER DEFAULT 1
);

CREATE TABLE markets (
  condition_id TEXT PRIMARY KEY,
  event_slug TEXT,
  market_slug TEXT,
  title TEXT,
  end_date INTEGER,
  resolved INTEGER DEFAULT 0,
  resolved_outcome INTEGER,
  fetched_at INTEGER
);

CREATE TABLE event_tags (
  event_slug TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  PRIMARY KEY (event_slug, tag_slug)
);
CREATE INDEX idx_event_tags_tag ON event_tags(tag_slug);

CREATE TABLE users (
  address TEXT PRIMARY KEY,
  pseudonym TEXT,
  name TEXT,
  profile_image TEXT,
  bio TEXT,
  lb_amount REAL,
  lb_rank INTEGER,
  first_seen_at INTEGER,
  source TEXT
);

-- THE LEDGER: per-(user, tag, day) cash flow + activity. 180d aggregates are
-- computed at query time via SUM over days >= today - 180.
CREATE TABLE user_tag_daily (
  user_addr TEXT NOT NULL,
  tag_slug TEXT NOT NULL,
  day INTEGER NOT NULL,      -- days since unix epoch (UTC)
  pnl REAL DEFAULT 0,        -- net cash flow in USDC dollars (signed)
  volume REAL DEFAULT 0,     -- absolute USDC volume traded
  trades INTEGER DEFAULT 0,  -- count of events
  PRIMARY KEY (user_addr, tag_slug, day)
);
CREATE INDEX idx_utd_tag_day ON user_tag_daily(tag_slug, day);
CREATE INDEX idx_utd_user_day ON user_tag_daily(user_addr, day);

-- incremental sync pointer per user
CREATE TABLE sync_state (
  user_addr TEXT PRIMARY KEY,
  last_activity_ts INTEGER DEFAULT 0,
  last_synced_at INTEGER,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  attempts INTEGER DEFAULT 0
);
CREATE INDEX idx_sync_state_pending ON sync_state(status, last_synced_at);

-- ops log for observability
CREATE TABLE ops_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER,
  kind TEXT,
  message TEXT,
  data TEXT
);
CREATE INDEX idx_ops_log_ts ON ops_log(ts);

-- seed default tags
INSERT INTO tags (slug, label) VALUES
  ('ufc', 'UFC'),
  ('tennis', 'Tennis'),
  ('mma', 'MMA'),
  ('mixed-martial-arts', 'Mixed Martial Arts'),
  ('sports', 'Sports');
