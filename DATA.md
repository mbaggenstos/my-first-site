# How the Fish-Spotter Works

This is an analytics pipeline for finding **bad traders ("fish")** on
Polymarket UFC and Tennis markets. A fish is anyone whose live betting
behaviour repeatedly costs them money — the kind of counterparty you
want to be opposite of.

Everything runs on Cloudflare (Worker + D1) with no extra services.
Public Polymarket APIs are the only data source; no API key is required.

---

## What we pull from Polymarket

| Endpoint | What it gives us | When we call it |
|---|---|---|
| `gamma-api.polymarket.com/events?tag_slug=ufc` (or `tennis`) | All events with a UFC/Tennis tag, including their markets, condition IDs, resolution status, and winning outcome | Once on cold start, to seed the discovery queue |
| `data-api.polymarket.com/trades?market=<conditionId>&limit=500&offset=N` | A page of executed trades on one market: who, side, shares, price, timestamp | Once per pending market per cron tick; paginated until the page is older than 180 days |
| `data-api.polymarket.com/positions?user=<addr>` | Currently open positions per user with `cashPnl`, `currentValue`, `initialValue` | Optional, on demand (for the "Unrealized P&L" column) |
| `lb-api.polymarket.com/profit` and `/volume` | Top-50 all-time profit and volume leaderboards | Once at bootstrap, to seed an initial pool of known users with their all-time profit number |

We never store the raw trades. Each `/trades` response is folded into
per-day aggregates and discarded. The DB stays small (~100 MB even for
tens of thousands of traders).

---

## The scan loop

A cron trigger fires every minute. Each run:

1. **First time only**: bootstrap from the leaderboards + seed the
   discovery queue from `events?tag_slug=ufc` and `…=tennis`. Both
   open and closed events of the last ~1.5 years are queued — about
   2 000 markets total.
2. **Process up to ~36 markets per cron tick** (subrequest budget: 40
   on the Workers free plan, with a few held in reserve). For each
   market the worker fetches the next `/trades` page at the stored
   `offset` and folds every trade in the 180-day window into:
   - `user_tag_daily(user_addr, tag, day)` — running totals per day
   - `user_tag_market(user_addr, tag, condition_id)` — running totals per market
3. **Markets alternate** between UFC and Tennis so no scope starves.
4. **Pagination cursor** is persisted (`discovery_queue.offset`). A
   market is marked done when a page comes back short or the oldest
   trade on the page falls before the 180-day window.

A full sweep finishes in roughly an hour. After that the cron keeps
ticking, picking up newly resolved markets and new fights as they
appear.

---

## What gets stored in the ledger

For every user we see in a UFC/Tennis trade we store **aggregates only**:

```
user_tag_daily   (user_addr, tag, day)
  → pnl, volume, maker_volume, trades, wins, losses, edge

user_tag_market  (user_addr, tag, condition_id)
  → pnl, volume, maker_volume, trades,
    largest_trade, first_trade_ts, last_trade_ts
```

180-day totals are recomputed on read by summing the rows with
`day >= today − 180`. Cleanup is a single `DELETE` of rows older than
that.

---

## How realized P&L is computed

For each fill on a market that has resolved with a known winner:

```
winning_price = 1  if user_outcome == winning_outcome
              = 0  otherwise

BUY:   pnl = shares × (winning_price − fill_price)
SELL:  pnl = shares × (fill_price − winning_price)
```

This is the actual money the trader made or lost on that fill *as it
relates to the final settlement*. Trades on still-open markets
contribute to **volume** and **trades count** but not to `pnl` — those
sit in unrealized space until the fight ends.

Unrealized P&L for open positions comes from `/positions?user=…`
on demand (cached in `user_tag_unrealized`).

---

## KPIs derived for the UI

| KPI | Formula | What it tells you |
|---|---|---|
| **P&L 180d** | `SUM(pnl)` over last 180 days | Realized money in/out over the window. Negative big numbers = real losses, not paper |
| **Unrealized** | `cashPnl` from `/positions`, summed per tag | What they'd lock in if markets settled now |
| **Total** | P&L + Unrealized | Best single number for "how is this trader actually doing" |
| **Volume** | `SUM(shares × price)` | How much money flowed through their account on these tags |
| **Markets** | `COUNT(*)` from `user_tag_market` | How many distinct fights they touched |
| **Trades** | `SUM(trades)` | Total fill events |
| **Avg trade** | `volume / trades` | Position-sizing style. Tiny avg = chip-shooter. Large avg = swing-better |
| **Largest** | `MAX(largest_trade)` | Biggest single bet — courage / tilt signal |
| **Maker %** | `maker_volume / volume` (heuristic, see below) | Approximate liquidity-provider behaviour |
| **Win rate** | `wins / (wins + losses)` | Fraction of *resolved* trades that ended on the right side |
| **Edge / $** | `SUM(pnl) / SUM(volume)` | Money returned per dollar bet. Negative = consistently overpaying |

---

## Heuristics for spotting fish

Fish-vs-pro is a pattern, not a single number. The UI highlights
outliers in bold so they jump out:

| Pattern | Likely interpretation |
|---|---|
| **Win rate ≤ 30 %** *(red)* | Consistently picking losing sides — bad reads or chasing the public |
| **Edge / $ ≤ −50 %** *(red)* | Paying close to chalk and watching it lose. Pure fish indicator |
| **Trades ≥ 1 000** + low avg trade | Spread bettor placing many small chips. Often a tilted retail trader |
| **Markets ≥ 30** + low win rate | Throwing money at every fight indiscriminately |
| **Largest ≥ $100 k** + big negative P&L | High-conviction whale on the wrong side — copy-trade danger because they keep coming back |
| **Maker % ≤ 20 %** *(red)* | Almost everything was a market-buy hitting an existing limit. Pays the spread every time. Classic fish |
| **Maker % ≥ 70 %** *(green)* | Mostly posting liquidity. Usually a market-maker bot or sophisticated participant — *do not copy them naively, they want you to* |
| **Volume ≥ $5 M** in 180 d | Whale 🐋 tier. Read the breakdown carefully before copy-trading either way |

A "good fish" to follow inversely is: high volume, low win rate, low
maker %, many markets, big losses. That's a high-conviction taker who
keeps losing and keeps coming back.

The tier badges (🐋 Whale / 🐬 Big Fish / 🐟 Fish / 🐠 Perch / 🦐 Shrimp)
classify purely by 180-day volume so you can filter by size class. A
$2 M-volume fish is worth more attention than a $5 k shrimp even if
their win rate is identical.

---

## Caveats and limitations

- **Maker / Taker is an estimate.** Polymarket's public `/trades`
  endpoint only returns the *taker* side of each fill (we verified
  this empirically — BUY/SELL volumes don't balance on a given
  market). We can't tell directly which side of the trade was the
  resting maker. As a proxy we flag trades at **clean integer-cent
  prices** (0.50, 0.27, 0.10 etc.) as likely maker-side fills, and
  trades at fractional prices like 0.5666003 as taker sweeps through
  multiple book levels. This is biased but directionally useful.
  Treat the column as a hint, not a hard number.
- **180-day window only.** Behaviour from before that point isn't
  visible. A pro who stopped trading 200 days ago will look inactive.
- **Realized P&L underestimates true P&L on open positions.** For
  pending fights we know the position size and entry price but not the
  outcome. Use the Unrealized column (or the All-time Profit on the
  user's Polymarket profile) for a fuller picture.
- **Wallet identity.** Polymarket users are wallets. One person can
  have many wallets, and one wallet can be co-signed. Don't assume the
  pseudonym is a unique person.
- **Survivorship.** Markets that never got traded don't enter our
  queue. We only see flows on markets that had at least one trade.

---

## How to use the UI

Site: **https://polymarket.macherweb.ch**

1. Pick **UFC** or **Tennis** at the top.
2. Toggle **Losers / Winners** to choose the sort direction.
3. Filter by **tier** using the chips (🐋 Whales, 🦐 Shrimps, etc.).
4. Set **Min. trades** to remove one-time accidental traders.
5. Click any **column header** to sort by that KPI. Click again to
   flip direction.
6. Click any **row** to expand it: a daily-P&L sparkline, top markets
   by |P&L|, recent markets by last trade date, and the full KPI panel
   appear inline.
7. The "Open on Polymarket ↗" link in the expanded panel goes straight
   to that wallet's public profile so you can sanity-check against the
   official view.

---

## Architecture in one diagram

```
 Polymarket APIs                    Cloudflare
 ───────────────                    ──────────
 gamma-api/events  ───seed──▶  discovery_queue (D1)
                                       │
                              cron picks N markets/min
                                       │
                                       ▼
 data-api/trades?market ────────▶ scanMarketTradePage
                                       │
                       aggregates only │  (raw trades discarded)
                                       ▼
                       ┌─────────────────────────────────┐
                       │ user_tag_daily  (per-day)       │
                       │ user_tag_market (per-market)    │
                       │ users           (wallet meta)   │
                       └─────────────────────────────────┘
                                       │
                                       ▼
                              Worker JSON API (/api/*)
                                       │
                                       ▼
                              Static frontend (public/)
                              served by the same Worker
```

Six SQL migrations describe the schema in order:
`0001_init`, `0002_sync_cursor`, `0003_skill_unrealized_discovery`,
`0004_market_scan`, `0005_per_market_aggregates`, `0006_maker_estimate`.

The whole thing — frontend, API, scan worker, and database — is one
Cloudflare Worker with one D1 binding.
