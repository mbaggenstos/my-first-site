// Polymarket Player-Analytics Worker
//
// Strategy: scan EVERY trade on every UFC/Tennis market in the last 180 days.
// For each trade, aggregate per-(user, tag, day) cash flow + realized P&L into
// the user_tag_daily ledger. We never persist raw trades; only the aggregate.
//
// Cron each minute walks the discovery_queue, one /trades page at a time per
// market, paginating older. When a page goes off the 180-day edge or returns
// fewer than 500 rows, that market is marked done.

const LB_API   = "https://lb-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const GAMMA_API = "https://gamma-api.polymarket.com";

const DAY = 86400;

function todayUtcDay() {
  return Math.floor(Date.now() / 1000 / DAY);
}

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=30",
      "access-control-allow-origin": "*",
      ...(init.headers || {}),
    },
  });
}

// ─── Discovery queue: seed UFC/Tennis events of the last ~year ──────────────
// Captures resolution state and winning outcome up-front so the scan loop
// doesn't need extra Gamma round-trips.
async function seedDiscoveryFromTag(env, tag, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const windowDays = Number(env.WINDOW_DAYS || 180);
  const windowStartSec = now - windowDays * DAY;
  // Gamma caps limit at 100. We paginate via offset, but each /events call
  // counts toward the Workers 50-subrequest-per-invocation limit on the
  // Free plan, so we cap pages per call and skip-by-startOffset for resume.
  const maxPagesPerSide = Number(opts.maxPagesPerSide || 18); // 18*2 = 36 fetches max
  const startOffset = Number(opts.startOffset || 0);
  const closedOnly = opts.closedOnly === true;
  const openOnly   = opts.openOnly === true;

  async function pullSide(closed) {
    const out = [];
    let lastSeenOffset = startOffset;
    for (let page = 0; page < maxPagesPerSide; page++) {
      const offset = startOffset + page * 100;
      const u = `${GAMMA_API}/events?tag_slug=${encodeURIComponent(tag)}` +
        `&limit=100&offset=${offset}&order=startDate&ascending=false&closed=${closed}`;
      let res;
      try {
        const r = await fetch(u, { cf: { cacheTtl: 1800 } });
        if (!r.ok) break;
        res = await r.json();
      } catch { break; }
      if (!Array.isArray(res) || res.length === 0) break;
      let allOutOfWindow = true;
      for (const e of res) {
        const end = e.endDate ? Math.floor(new Date(e.endDate).getTime() / 1000) : null;
        if (end == null || end >= windowStartSec) {
          allOutOfWindow = false;
          out.push(e);
        }
      }
      lastSeenOffset = offset;
      if (allOutOfWindow) break;
      if (res.length < 100) break;
    }
    return { events: out, lastSeenOffset };
  }

  const closedPart = openOnly  ? { events: [], lastSeenOffset: startOffset } : await pullSide(true);
  const openPart   = closedOnly ? { events: [], lastSeenOffset: startOffset } : await pullSide(false);
  const events = [...closedPart.events, ...openPart.events];

  let added = 0;
  const dqStmts = [];
  const mStmts = [];
  for (const e of events) {
    for (const m of (e.markets || [])) {
      if (!m.conditionId) continue;
      let winner = null;
      try {
        const prices = JSON.parse(m.outcomePrices || "[]").map(Number);
        if (prices.length === 2 && (prices[0] === 1 || prices[1] === 1)) {
          winner = prices[0] === 1 ? 0 : 1;
        }
      } catch {}
      const resolved = m.umaResolutionStatus === "resolved" ? 1 : 0;
      dqStmts.push(env.DB.prepare(`
        INSERT INTO discovery_queue
          (scope, market_id, event_slug, added_at, status, offset,
           trades_processed, winning_outcome, resolved)
        VALUES (?, ?, ?, ?, 'pending', 0, 0, ?, ?)
        ON CONFLICT(scope, market_id) DO UPDATE SET
          winning_outcome = COALESCE(excluded.winning_outcome, winning_outcome),
          resolved = MAX(resolved, excluded.resolved)
      `).bind(`tag:${tag}`, m.conditionId, e.slug, now, winner, resolved));
      mStmts.push(env.DB.prepare(`
        INSERT INTO markets
          (condition_id, event_slug, market_slug, title, end_date,
           resolved, resolved_outcome, winning_outcome, outcomes,
           resolution_status, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(condition_id) DO UPDATE SET
          resolved=excluded.resolved,
          winning_outcome=COALESCE(excluded.winning_outcome, winning_outcome),
          resolved_outcome=COALESCE(excluded.resolved_outcome, resolved_outcome),
          resolution_status=excluded.resolution_status
      `).bind(
        m.conditionId,
        e.slug,
        m.slug || null,
        m.question || null,
        m.endDate ? Math.floor(new Date(m.endDate).getTime() / 1000) : null,
        resolved,
        winner,
        winner,
        m.outcomes || null,
        m.umaResolutionStatus || null,
        now,
      ));
      added++;
    }
  }
  const batches = [...dqStmts, ...mStmts];
  for (let i = 0; i < batches.length; i += 50) {
    await env.DB.batch(batches.slice(i, i + 50));
  }
  return added;
}

// ─── Core: scan one trade page for one market, aggregate into ledger ────────
// Returns { processed, oldest_ts, done } so the caller can decide pagination.
async function scanMarketTradePage(env, row, windowStart) {
  const conditionId = row.market_id;
  const offset = row.offset || 0;
  const tag = String(row.scope || "").startsWith("tag:")
    ? row.scope.slice(4) : null;
  if (!tag) {
    // unknown scope; mark done
    await env.DB.prepare("UPDATE discovery_queue SET status='done' WHERE scope=? AND market_id=?")
      .bind(row.scope, conditionId).run();
    return { processed: 0, done: true };
  }

  const resolved = !!row.resolved;
  const winningOutcome = row.winning_outcome;

  const url = `${DATA_API}/trades?market=${conditionId}&limit=500&offset=${offset}`;
  let trades;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`trades ${res.status}`);
    trades = await res.json();
  } catch (err) {
    await env.DB.prepare(`
      UPDATE discovery_queue
         SET status='failed', last_run_at=?
       WHERE scope=? AND market_id=?
    `).bind(Math.floor(Date.now() / 1000), row.scope, conditionId).run();
    return { processed: 0, done: true, error: String(err) };
  }
  if (!Array.isArray(trades)) trades = [];

  const now = Math.floor(Date.now() / 1000);

  // collect new users + bucket aggregates
  const users = new Map(); // addr -> { pseudonym, name, image }
  // bucket key: `${addr}|${day}` -> { pnl, vol, trades, wins, losses, edge }
  const buckets = new Map();
  // per-user aggregate for THIS market (one row per user gets upserted later)
  // addr -> { trades, volume, pnl, largestTrade, firstTs, lastTs }
  const perMarket = new Map();
  let oldestTs = row.oldest_ts != null ? row.oldest_ts : Infinity;
  let processed = 0;
  let pageOldest = Infinity;
  let pastWindow = false;

  for (const t of trades) {
    const ts = Number(t.timestamp);
    if (!ts) continue;
    if (ts < pageOldest) pageOldest = ts;
    if (ts < windowStart) { pastWindow = true; continue; }
    if (ts < oldestTs) oldestTs = ts;

    const addr = (t.proxyWallet || "").toLowerCase();
    if (!addr) continue;
    const side = String(t.side || "").toUpperCase();
    const shares = Number(t.size) || 0;
    const price = Number(t.price) || 0;
    const value = shares * price;
    if (shares === 0) continue;

    // Maker-side estimate: a clean integer-cent price (0.50, 0.27 …) implies
    // the fill happened against a clean limit order. Non-clean prices like
    // 0.5666003 indicate a taker sweep through multiple book levels.
    const cents = price * 100;
    const isCleanCent = Math.abs(cents - Math.round(cents)) < 0.001;
    const makerVol = isCleanCent ? value : 0;

    if (!users.has(addr)) {
      users.set(addr, {
        pseudonym: t.pseudonym || null,
        name: t.name || null,
        image: t.profileImage || null,
      });
    }

    // realized P&L only when market is resolved + we know the winner
    let realized = 0;
    let won = null;
    if (resolved && winningOutcome != null) {
      const userOnWinner = Number(t.outcomeIndex) === winningOutcome;
      const winningPrice = userOnWinner ? 1.0 : 0.0;
      if (side === "BUY")       realized = shares * (winningPrice - price);
      else if (side === "SELL") realized = shares * (price - winningPrice);
      // a trade "wins" if it produced positive realized P&L
      if (realized !== 0) won = realized > 0;
    }

    const day = Math.floor(ts / DAY);
    const k = `${addr}|${day}`;
    const b = buckets.get(k) || {
      pnl: 0, volume: 0, trades: 0, wins: 0, losses: 0, edge: 0, makerVol: 0,
    };
    b.volume   += value;
    b.makerVol += makerVol;
    b.trades   += 1;
    b.pnl      += realized;
    b.edge     += realized;
    if (won === true)  b.wins   += 1;
    if (won === false) b.losses += 1;
    buckets.set(k, b);

    // per-(user, market) aggregate
    const pm = perMarket.get(addr) || {
      trades: 0, volume: 0, makerVol: 0, pnl: 0, largestTrade: 0,
      firstTs: ts, lastTs: ts,
    };
    pm.trades   += 1;
    pm.volume   += value;
    pm.makerVol += makerVol;
    pm.pnl      += realized;
    if (value > pm.largestTrade) pm.largestTrade = value;
    if (ts < pm.firstTs) pm.firstTs = ts;
    if (ts > pm.lastTs)  pm.lastTs  = ts;
    perMarket.set(addr, pm);

    processed++;
  }

  // persist users + aggregates + queue progress in a few batches
  const stmts = [];
  for (const [addr, meta] of users) {
    stmts.push(env.DB.prepare(`
      INSERT INTO users (address, pseudonym, name, profile_image, first_seen_at, source)
      VALUES (?, ?, ?, ?, ?, 'scan')
      ON CONFLICT(address) DO UPDATE SET
        pseudonym=COALESCE(users.pseudonym, excluded.pseudonym),
        name=COALESCE(users.name, excluded.name),
        profile_image=COALESCE(users.profile_image, excluded.profile_image)
    `).bind(addr, meta.pseudonym, meta.name, meta.image, now));
  }
  for (const [k, v] of buckets) {
    const [addr, dayStr] = k.split("|");
    stmts.push(env.DB.prepare(`
      INSERT INTO user_tag_daily
        (user_addr, tag_slug, day, pnl, volume, trades, wins, losses, edge, maker_volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_addr, tag_slug, day) DO UPDATE SET
        pnl          = pnl          + excluded.pnl,
        volume       = volume       + excluded.volume,
        trades       = trades       + excluded.trades,
        wins         = wins         + excluded.wins,
        losses       = losses       + excluded.losses,
        edge         = edge         + excluded.edge,
        maker_volume = maker_volume + excluded.maker_volume
    `).bind(addr, tag, Number(dayStr), v.pnl, v.volume, v.trades, v.wins, v.losses, v.edge, v.makerVol));
  }
  for (const [addr, v] of perMarket) {
    stmts.push(env.DB.prepare(`
      INSERT INTO user_tag_market
        (user_addr, tag_slug, condition_id, trades, volume, maker_volume, pnl,
         largest_trade, first_trade_ts, last_trade_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_addr, tag_slug, condition_id) DO UPDATE SET
        trades         = trades         + excluded.trades,
        volume         = volume         + excluded.volume,
        maker_volume   = maker_volume   + excluded.maker_volume,
        pnl            = pnl            + excluded.pnl,
        largest_trade  = MAX(largest_trade, excluded.largest_trade),
        first_trade_ts = MIN(first_trade_ts, excluded.first_trade_ts),
        last_trade_ts  = MAX(last_trade_ts,  excluded.last_trade_ts)
    `).bind(addr, tag, conditionId, v.trades, v.volume, v.makerVol, v.pnl, v.largestTrade, v.firstTs, v.lastTs));
  }

  const newOffset = offset + (trades.length || 0);
  const done = (trades.length < 500) || pastWindow;
  stmts.push(env.DB.prepare(`
    UPDATE discovery_queue
       SET offset = ?, trades_processed = trades_processed + ?, last_run_at = ?,
           oldest_ts = ?, status = ?
     WHERE scope = ? AND market_id = ?
  `).bind(
    newOffset,
    processed,
    now,
    Number.isFinite(oldestTs) ? oldestTs : null,
    done ? 'done' : 'pending',
    row.scope, conditionId,
  ));

  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }

  return {
    market: conditionId,
    scope: row.scope,
    fetched: trades.length,
    in_window: processed,
    new_users: users.size,
    new_buckets: buckets.size,
    new_offset: newOffset,
    page_oldest_ts: Number.isFinite(pageOldest) ? pageOldest : null,
    done,
  };
}

// ─── Optional: bootstrap top-N users from lb-api for the `lb_amount` field ──
async function bootstrap(env) {
  const topN = Number(env.BOOTSTRAP_TOP_N || 500);
  const [profitRes, volumeRes] = await Promise.all([
    fetch(`${LB_API}/profit`),
    fetch(`${LB_API}/volume`),
  ]);
  if (!profitRes.ok) throw new Error(`lb-api profit ${profitRes.status}`);
  const profitList = await profitRes.json();
  const volumeList = volumeRes.ok ? await volumeRes.json() : [];

  const seen = new Set();
  const merged = [];
  for (const u of [...profitList, ...volumeList]) {
    const w = u.proxyWallet?.toLowerCase();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    merged.push(u);
  }

  const now = Math.floor(Date.now() / 1000);
  const top = merged.slice(0, topN);
  const stmts = [];
  for (let i = 0; i < top.length; i++) {
    const u = top[i];
    if (!u.proxyWallet) continue;
    stmts.push(env.DB.prepare(`
      INSERT INTO users (address, pseudonym, name, profile_image, bio, lb_amount, lb_rank, first_seen_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'leaderboard')
      ON CONFLICT(address) DO UPDATE SET
        pseudonym=excluded.pseudonym, name=excluded.name,
        profile_image=excluded.profile_image, bio=excluded.bio,
        lb_amount=excluded.lb_amount, lb_rank=excluded.lb_rank
    `).bind(
      u.proxyWallet.toLowerCase(),
      u.pseudonym || null, u.name || null,
      u.profileImage || null, u.bio || null,
      Number(u.amount) || 0, i + 1, now,
    ));
  }
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }

  await env.DB.prepare(
    "INSERT INTO ops_log (ts, kind, message, data) VALUES (?, 'bootstrap', ?, ?)"
  ).bind(now, `seeded ${top.length} users`, JSON.stringify({
    topN, profit: profitList.length, volume: volumeList.length, unique: merged.length,
  })).run();
  return top.length;
}

// ─── Reset: clear aggregates and rewind discovery queue ─────────────────────
async function resetScan(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM user_tag_daily"),
    env.DB.prepare("DELETE FROM user_tag_unrealized"),
    env.DB.prepare("DELETE FROM user_tag_market"),
    env.DB.prepare(`
      UPDATE discovery_queue
         SET status='pending', offset=0, trades_processed=0, oldest_ts=NULL
    `),
  ]);
  await env.DB.prepare(
    "INSERT INTO ops_log (ts, kind, message, data) VALUES (?, 'reset', ?, ?)"
  ).bind(Math.floor(Date.now() / 1000), "cleared aggregates", "{}").run();
}

// ─── Cron: scan as many trade pages as the subrequest budget allows ─────────
async function runScheduled(env, ctx) {
  const windowDays = Number(env.WINDOW_DAYS || 180);
  const subreqBudget = Number(env.SUBREQUEST_BUDGET || 40);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowDays * DAY;

  // first cron: seed users + discovery queue
  const userCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  if (!userCount || userCount.n === 0) {
    await bootstrap(env);
  }

  const dqCount = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM discovery_queue"
  ).first();
  if (!dqCount || dqCount.n === 0) {
    const tags = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => s.trim());
    for (const t of tags) {
      await seedDiscoveryFromTag(env, t);
    }
  }

  // process markets within budget; each page = 1 subrequest
  // leave a few subrequests free for safety
  const maxMarkets = Math.max(1, subreqBudget - 4);
  const results = [];
  // alternate scopes round-robin so tennis doesn't starve behind UFC's queue
  const scopes = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => `tag:${s.trim()}`);

  // recover any markets stuck in 'syncing' for > 5 min (crashed worker)
  await env.DB.prepare(`
    UPDATE discovery_queue
       SET status='pending'
     WHERE status='syncing' AND COALESCE(last_run_at, 0) < ?
  `).bind(now - 300).run();

  for (let i = 0; i < maxMarkets; i++) {
    const scope = scopes[i % scopes.length];
    // ATOMIC CLAIM: pick + mark syncing in one statement so two concurrent
    // cron/admin invocations can't grab the same market and double-aggregate.
    let pick = await env.DB.prepare(`
      UPDATE discovery_queue
         SET status='syncing', last_run_at=?
       WHERE rowid = (
         SELECT rowid FROM discovery_queue
          WHERE status='pending' AND scope=?
          ORDER BY
            CASE WHEN offset > 0 THEN 0 ELSE 1 END,
            resolved DESC,
            added_at ASC
          LIMIT 1
       )
      RETURNING scope, market_id, event_slug, offset, oldest_ts,
                winning_outcome, resolved
    `).bind(now, scope).first();
    if (!pick) {
      // scope drained; final-drain claim ignoring scope
      pick = await env.DB.prepare(`
        UPDATE discovery_queue
           SET status='syncing', last_run_at=?
         WHERE rowid = (
           SELECT rowid FROM discovery_queue
            WHERE status='pending'
            ORDER BY
              CASE WHEN offset > 0 THEN 0 ELSE 1 END,
              resolved DESC,
              added_at ASC
            LIMIT 1
         )
        RETURNING scope, market_id, event_slug, offset, oldest_ts,
                  winning_outcome, resolved
      `).bind(now).first();
      if (!pick) break;
    }
    try {
      const r = await scanMarketTradePage(env, pick, windowStart);
      results.push(r);
    } catch (err) {
      results.push({ market: pick.market_id, error: String(err) });
      await env.DB.prepare(
        "UPDATE discovery_queue SET status='failed', last_run_at=? WHERE scope=? AND market_id=?"
      ).bind(now, pick.scope, pick.market_id).run();
    }
  }

  const totalProcessed = results.reduce((s, r) => s + (r.in_window || 0), 0);
  const totalUsers = results.reduce((s, r) => s + (r.new_users || 0), 0);
  await env.DB.prepare(
    "INSERT INTO ops_log (ts, kind, message, data) VALUES (?, 'cron', ?, ?)"
  ).bind(
    now,
    `scanned ${results.length} markets, ${totalProcessed} trades, +${totalUsers} users`,
    JSON.stringify(results.slice(0, 5)),
  ).run();

  return { markets_scanned: results.length, trades_in_window: totalProcessed, users_seen: totalUsers, sample: results.slice(0, 3) };
}

// ─── Unrealized P&L: per-user /positions snapshot ───────────────────────────
async function refreshUnrealizedForUser(env, userAddr) {
  const url = `${DATA_API}/positions?user=${userAddr}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) return 0;
  const positions = await res.json();
  const now = Math.floor(Date.now() / 1000);
  const interesting = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => s.trim());

  // build slug -> tags map from cached event_tags
  const slugs = new Set();
  for (const p of positions) if (p.eventSlug) slugs.add(p.eventSlug);
  const slugTags = new Map();
  if (slugs.size > 0) {
    const ph = Array.from(slugs).map(() => "?").join(",");
    const r = await env.DB.prepare(
      `SELECT event_slug, tag_slug FROM event_tags WHERE event_slug IN (${ph})`
    ).bind(...slugs).all();
    for (const row of r.results) {
      if (!slugTags.has(row.event_slug)) slugTags.set(row.event_slug, new Set());
      slugTags.get(row.event_slug).add(row.tag_slug);
    }
  }
  // backfill missing event tags by deriving from markets table via conditionId
  for (const p of positions) {
    if (slugTags.has(p.eventSlug)) continue;
    if (!p.conditionId) continue;
    const m = await env.DB.prepare(
      "SELECT event_slug FROM markets WHERE condition_id = ?"
    ).bind(p.conditionId).first();
    if (m?.event_slug) {
      const r = await env.DB.prepare(
        "SELECT tag_slug FROM event_tags WHERE event_slug = ?"
      ).bind(m.event_slug).all();
      const set = new Set(r.results.map((x) => x.tag_slug));
      slugTags.set(p.eventSlug, set);
    }
  }

  const agg = new Map();
  for (const p of positions) {
    const tags = slugTags.get(p.eventSlug);
    if (!tags) continue;
    for (const tag of tags) {
      if (!interesting.includes(tag)) continue;
      const a = agg.get(tag) || { cashPnl: 0, curVal: 0, initVal: 0, n: 0 };
      a.cashPnl += Number(p.cashPnl) || 0;
      a.curVal  += Number(p.currentValue) || 0;
      a.initVal += Number(p.initialValue) || 0;
      a.n += 1;
      agg.set(tag, a);
    }
  }

  const stmts = [
    env.DB.prepare("DELETE FROM user_tag_unrealized WHERE user_addr = ?").bind(userAddr),
  ];
  for (const [tag, a] of agg) {
    stmts.push(env.DB.prepare(`
      INSERT INTO user_tag_unrealized
        (user_addr, tag_slug, cash_pnl, current_value, initial_value, open_positions, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(userAddr, tag, a.cashPnl, a.curVal, a.initVal, a.n, now));
  }
  await env.DB.batch(stmts);
  return agg.size;
}

// ─── Public API ─────────────────────────────────────────────────────────────
async function apiLeaderboard(env, url) {
  const tag = url.searchParams.get("tag") || "ufc";
  const window = Number(url.searchParams.get("window") || env.WINDOW_DAYS || 180);
  const order = (url.searchParams.get("order") || "loss").toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") || 100), 500);
  const minDay = todayUtcDay() - window;
  const direction = order === "profit" ? "DESC" : "ASC";

  const rows = (await env.DB.prepare(`
    SELECT
      utd.user_addr                                  AS address,
      u.pseudonym                                    AS pseudonym,
      u.name                                         AS name,
      u.profile_image                                AS profile_image,
      u.lb_amount                                    AS lb_amount,
      SUM(utd.pnl)                                   AS pnl,
      SUM(utd.volume)                                AS volume,
      SUM(utd.maker_volume)                          AS maker_volume,
      SUM(utd.trades)                                AS trades,
      SUM(utd.wins)                                  AS wins,
      SUM(utd.losses)                                AS losses,
      SUM(utd.edge)                                  AS edge,
      COALESCE(unr.cash_pnl, 0)                      AS unrealized_pnl,
      COALESCE(unr.current_value, 0)                 AS unrealized_value,
      COALESCE(unr.open_positions, 0)                AS open_positions,
      COALESCE(mk.markets_played, 0)                 AS markets_played,
      COALESCE(mk.largest_trade, 0)                  AS largest_trade,
      MAX(utd.day)                                   AS last_day
    FROM user_tag_daily utd
    LEFT JOIN users u ON u.address = utd.user_addr
    LEFT JOIN user_tag_unrealized unr
           ON unr.user_addr = utd.user_addr AND unr.tag_slug = utd.tag_slug
    LEFT JOIN (
      SELECT user_addr, tag_slug,
             COUNT(*) AS markets_played,
             MAX(largest_trade) AS largest_trade
        FROM user_tag_market
       WHERE tag_slug = ?
       GROUP BY user_addr
    ) mk ON mk.user_addr = utd.user_addr
    WHERE utd.tag_slug = ? AND utd.day >= ?
    GROUP BY utd.user_addr
    HAVING trades > 0
    ORDER BY pnl ${direction}
    LIMIT ?
  `).bind(tag, tag, minDay, limit).all()).results;

  for (const r of rows) {
    const decided = (r.wins || 0) + (r.losses || 0);
    r.win_rate = decided > 0 ? r.wins / decided : null;
    r.edge_per_dollar = r.volume > 0 ? r.edge / r.volume : null;
    r.total_pnl = (r.pnl || 0) + (r.unrealized_pnl || 0);
    r.avg_trade_size = r.trades > 0 ? r.volume / r.trades : 0;
    r.avg_position_size = r.markets_played > 0 ? r.volume / r.markets_played : 0;
    r.trades_per_market = r.markets_played > 0 ? r.trades / r.markets_played : 0;
    r.maker_ratio = r.volume > 0 ? (r.maker_volume || 0) / r.volume : null;
  }

  return jsonResponse({ tag, window_days: window, order, count: rows.length, rows });
}

async function apiUser(env, addr) {
  const a = addr.toLowerCase();
  const user = await env.DB
    .prepare("SELECT * FROM users WHERE address = ?").bind(a).first();
  if (!user) return jsonResponse({ error: "user not found" }, { status: 404 });

  const window = Number(env.WINDOW_DAYS || 180);
  const minDay = todayUtcDay() - window;

  const tagRows = (await env.DB.prepare(`
    SELECT
      utd.tag_slug,
      SUM(utd.pnl)          AS pnl,
      SUM(utd.volume)       AS volume,
      SUM(utd.maker_volume) AS maker_volume,
      SUM(utd.trades)       AS trades,
      SUM(utd.wins)         AS wins,
      SUM(utd.losses)       AS losses,
      SUM(utd.edge)         AS edge,
      MAX(utd.day)          AS last_day,
      COALESCE(unr.cash_pnl, 0)        AS unrealized_pnl,
      COALESCE(unr.current_value, 0)   AS unrealized_value,
      COALESCE(unr.open_positions, 0)  AS open_positions,
      COALESCE(mk.markets_played, 0)   AS markets_played,
      COALESCE(mk.largest_trade, 0)    AS largest_trade,
      COALESCE(mk.biggest_win, 0)      AS biggest_market_win,
      COALESCE(mk.biggest_loss, 0)     AS biggest_market_loss
    FROM user_tag_daily utd
    LEFT JOIN user_tag_unrealized unr
           ON unr.user_addr = utd.user_addr AND unr.tag_slug = utd.tag_slug
    LEFT JOIN (
      SELECT user_addr, tag_slug,
             COUNT(*) AS markets_played,
             MAX(largest_trade) AS largest_trade,
             MAX(pnl) AS biggest_win,
             MIN(pnl) AS biggest_loss
        FROM user_tag_market
       WHERE user_addr = ?
       GROUP BY tag_slug
    ) mk ON mk.user_addr = utd.user_addr AND mk.tag_slug = utd.tag_slug
    WHERE utd.user_addr = ? AND utd.day >= ?
    GROUP BY utd.tag_slug
    ORDER BY pnl ASC
  `).bind(a, a, minDay).all()).results;
  for (const r of tagRows) {
    const decided = (r.wins || 0) + (r.losses || 0);
    r.win_rate = decided > 0 ? r.wins / decided : null;
    r.edge_per_dollar = r.volume > 0 ? r.edge / r.volume : null;
    r.total_pnl = (r.pnl || 0) + (r.unrealized_pnl || 0);
    r.avg_trade_size = r.trades > 0 ? r.volume / r.trades : 0;
    r.avg_position_size = r.markets_played > 0 ? r.volume / r.markets_played : 0;
    r.trades_per_market = r.markets_played > 0 ? r.trades / r.markets_played : 0;
    r.maker_ratio = r.volume > 0 ? (r.maker_volume || 0) / r.volume : null;
  }

  const dailyRows = (await env.DB.prepare(`
    SELECT tag_slug, day, pnl, volume, trades, wins, losses, edge
      FROM user_tag_daily
     WHERE user_addr = ? AND day >= ?
     ORDER BY day ASC
  `).bind(a, minDay).all()).results;

  // top markets by absolute P&L
  const topMarkets = (await env.DB.prepare(`
    SELECT utm.tag_slug, utm.condition_id, utm.trades, utm.volume,
           utm.maker_volume, utm.pnl,
           utm.largest_trade, utm.first_trade_ts, utm.last_trade_ts,
           m.title, m.market_slug, m.event_slug, m.resolved, m.winning_outcome
      FROM user_tag_market utm
      LEFT JOIN markets m ON m.condition_id = utm.condition_id
     WHERE utm.user_addr = ?
     ORDER BY ABS(utm.pnl) DESC
     LIMIT 10
  `).bind(a).all()).results;

  // markets sorted by most recent trade timestamp (the "in-play review")
  const recentMarkets = (await env.DB.prepare(`
    SELECT utm.tag_slug, utm.condition_id, utm.trades, utm.volume,
           utm.maker_volume, utm.pnl,
           utm.largest_trade, utm.first_trade_ts, utm.last_trade_ts,
           m.title, m.market_slug, m.event_slug, m.resolved, m.winning_outcome,
           m.end_date
      FROM user_tag_market utm
      LEFT JOIN markets m ON m.condition_id = utm.condition_id
     WHERE utm.user_addr = ?
     ORDER BY utm.last_trade_ts DESC
     LIMIT 30
  `).bind(a).all()).results;

  return jsonResponse({
    user, by_tag: tagRows, daily: dailyRows,
    top_markets: topMarkets, recent_markets: recentMarkets,
  });
}

async function apiStatus(env) {
  const counts = {};
  for (const t of ["users", "user_tag_daily", "user_tag_market", "user_tag_unrealized", "markets", "discovery_queue"]) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first();
    counts[t] = r.n;
  }
  const dq = (await env.DB.prepare(`
    SELECT scope, status, COUNT(*) AS n,
           SUM(trades_processed) AS trades,
           MIN(oldest_ts) AS oldest_ts
      FROM discovery_queue
     GROUP BY scope, status
  `).all()).results;
  const recent = (await env.DB.prepare(`
    SELECT ts, kind, message FROM ops_log ORDER BY ts DESC LIMIT 10
  `).all()).results;

  // progress: % of markets done per scope
  const progress = {};
  for (const row of dq) {
    if (!progress[row.scope]) progress[row.scope] = { done: 0, pending: 0, failed: 0, trades: 0 };
    progress[row.scope][row.status] = row.n;
    progress[row.scope].trades += Number(row.trades || 0);
  }
  for (const k of Object.keys(progress)) {
    const p = progress[k];
    const total = (p.done || 0) + (p.pending || 0) + (p.failed || 0);
    p.percent = total > 0 ? Math.round(((p.done || 0) / total) * 100) : 0;
  }

  return jsonResponse({ counts, scopes: progress, recent });
}

async function apiTags(env) {
  const rows = (await env.DB.prepare(
    "SELECT slug, label FROM tags WHERE enabled = 1 ORDER BY label"
  ).all()).results;
  const interesting = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => s.trim());
  return jsonResponse({ tags: rows, default: interesting });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/health")       return jsonResponse({ ok: true, ts: Date.now() });
        if (url.pathname === "/api/status")       return apiStatus(env);
        if (url.pathname === "/api/tags")         return apiTags(env);
        if (url.pathname === "/api/leaderboard")  return apiLeaderboard(env, url);
        if (url.pathname.startsWith("/api/users/")) {
          return apiUser(env, url.pathname.slice("/api/users/".length));
        }
        if (url.pathname === "/api/admin/bootstrap" && request.method === "POST") {
          const n = await bootstrap(env);
          return jsonResponse({ ok: true, seeded: n });
        }
        if (url.pathname === "/api/admin/seed" && request.method === "POST") {
          const tag = url.searchParams.get("tag");
          if (!tag) return jsonResponse({ error: "tag param required" }, { status: 400 });
          const opts = {
            startOffset: Number(url.searchParams.get("offset") || 0),
            maxPagesPerSide: Number(url.searchParams.get("pages") || 18),
            closedOnly: url.searchParams.get("side") === "closed",
            openOnly:   url.searchParams.get("side") === "open",
          };
          const n = await seedDiscoveryFromTag(env, tag, opts);
          return jsonResponse({ ok: true, seeded: n, opts });
        }
        if (url.pathname === "/api/admin/scan" && request.method === "POST") {
          const r = await runScheduled(env, ctx);
          return jsonResponse({ ok: true, ...r });
        }
        if (url.pathname === "/api/admin/reset" && request.method === "POST") {
          await resetScan(env);
          return jsonResponse({ ok: true });
        }
        if (url.pathname === "/api/admin/unrealized" && request.method === "POST") {
          const addr = url.searchParams.get("addr");
          if (!addr) return jsonResponse({ error: "addr param required" }, { status: 400 });
          const n = await refreshUnrealizedForUser(env, addr.toLowerCase());
          return jsonResponse({ ok: true, tags: n });
        }
        return jsonResponse({ error: "not found" }, { status: 404 });
      } catch (err) {
        return jsonResponse({ error: String(err) }, { status: 500 });
      }
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, ctx));
  },
};
