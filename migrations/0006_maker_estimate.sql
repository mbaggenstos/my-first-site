-- Maker-side volume estimate. Heuristic: when a fill's price equals exactly
-- one whole cent (e.g. 0.50, 0.27), the fill happened against a clean limit
-- order — likely the maker. Non-clean prices like 0.5666003 are taker sweeps
-- through multiple order book levels.
ALTER TABLE user_tag_daily  ADD COLUMN maker_volume REAL DEFAULT 0;
ALTER TABLE user_tag_market ADD COLUMN maker_volume REAL DEFAULT 0;
