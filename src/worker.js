// Polymarket Player-Analytics Worker
// - Serves static frontend via ASSETS binding
// - Serves /api/* read endpoints from D1
// - Cron every minute: bootstrap (one-shot) + 1 discovery step + 1 user sync
//
// Data flow per user:
//   activity API (paginated) -> per-event tag lookup -> per-(user, tag, day) aggregate in D1
//   positions API           -> per-(user, tag) unrealized P&L in D1
//   raw activity is NOT persisted

const LB_API = "https://lb-api.polymarket.com";
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

// ─── Cash-flow + edge model ─────────────────────────────────────────────────
// Signed USDC delta per activity event (user's perspective; + = in, - = out)
function cashFlow(ev) {
  const size = Number(ev.usdcSize) || 0;
  switch (ev.type) {
    case "TRADE": {
      const side = String(ev.side || "").toUpperCase();
      if (side === "BUY")  return -size;
      if (side === "SELL") return  size;
      return 0;
    }
    case "REDEEM": return  size;
    case "MERGE":  return  size;
    case "SPLIT":  return -size;
    case "CONVERSION":
    case "REWARD": return  size;
    default: return 0;
  }
}

// For TRADE events on resolved markets, compute (edge, win/loss).
// edge_per_share for BUY  = (winnerPrice - entryPrice)         [+ if good]
// edge_per_share for SELL = (entryPrice - winnerPrice)         [+ if good]
// winnerPrice = 1.0 if the user's outcome won, else 0.0
function edgeAndWin(ev, market) {
  if (ev.type !== "TRADE") return null;
  if (!market || market.winning_outcome == null) return null;
  const side = String(ev.side || "").toUpperCase();
  const idx = Number(ev.outcomeIndex);
  const price = Number(ev.price) || 0;
  const shares = Number(ev.size) || 0;
  if (!shares || (price <= 0 && side === "BUY")) return null;
  const userOnWinner = idx === market.winning_outcome;
  const winnerPrice = userOnWinner ? 1.0 : 0.0;
  let edge;
  let won;
  if (side === "BUY") {
    edge = (winnerPrice - price) * shares;
    won = userOnWinner;
  } else if (side === "SELL") {
    edge = (price - winnerPrice) * shares;
    won = !userOnWinner;
  } else return null;
  return { edge, won };
}

// ─── Event + market metadata cache ──────────────────────────────────────────
// Fetches /events?slug=X once per slug, persists tags + per-market resolution.
async function fetchAndCacheEvent(env, eventSlug) {
  if (!eventSlug) return null;
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(eventSlug)}`;
  let events;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 86400 } });
    if (!res.ok) return null;
    events = await res.json();
  } catch { return null; }
  if (!Array.isArray(events) || events.length === 0) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO event_tags (event_slug, tag_slug) VALUES (?, '__none__')"
    ).bind(eventSlug).run();
    return null;
  }
  const e = events[0];
  const tags = (e.tags || []).map((t) => t.slug).filter(Boolean);

  const stmts = [];
  if (tags.length === 0) {
    stmts.push(env.DB.prepare(
      "INSERT OR IGNORE INTO event_tags (event_slug, tag_slug) VALUES (?, '__none__')"
    ).bind(eventSlug));
  } else {
    for (const t of tags) {
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO event_tags (event_slug, tag_slug) VALUES (?, ?)"
      ).bind(eventSlug, t));
    }
  }
  for (const m of (e.markets || [])) {
    let winner = null;
    try {
      const prices = JSON.parse(m.outcomePrices || "[]").map(Number);
      if (prices.length === 2 && (prices[0] === 1 || prices[1] === 1)) {
        winner = prices[0] === 1 ? 0 : 1;
      }
    } catch {}
    stmts.push(env.DB.prepare(`
      INSERT OR REPLACE INTO markets
        (condition_id, event_slug, market_slug, title, end_date,
         resolved, resolved_outcome, winning_outcome, outcomes,
         resolution_status, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      m.conditionId,
      eventSlug,
      m.slug || null,
      m.question || null,
      m.endDate ? Math.floor(new Date(m.endDate).getTime() / 1000) : null,
      m.closed ? 1 : 0,
      winner,
      winner,
      m.outcomes || null,
      m.umaResolutionStatus || null,
      Math.floor(Date.now() / 1000),
    ));
  }
  await env.DB.batch(stmts);
  return { tags, event: e };
}

async function getCachedTags(env, eventSlug) {
  if (!eventSlug) return null;
  const r = await env.DB
    .prepare("SELECT tag_slug FROM event_tags WHERE event_slug = ?")
    .bind(eventSlug).all();
  if (r.results.length === 0) return null;
  return r.results.map((row) => row.tag_slug).filter((t) => t !== "__none__");
}

async function getCachedMarket(env, conditionId) {
  if (!conditionId) return null;
  return env.DB
    .prepare("SELECT condition_id, event_slug, winning_outcome, resolved FROM markets WHERE condition_id = ?")
    .bind(conditionId).first();
}

// ─── Activity sync ──────────────────────────────────────────────────────────
async function fetchActivityPage(user, offset, limit = 500) {
  const url = `${DATA_API}/activity?user=${user}&limit=${limit}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`activity ${res.status}`);
  return res.json();
}

async function syncUser(env, userAddr, windowDays, subreqBudget) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowDays * DAY;
  const interesting = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => s.trim());

  const state = await env.DB.prepare(`
    SELECT last_activity_ts, oldest_activity_ts, backfill_offset, backfill_done
      FROM sync_state WHERE user_addr = ?
  `).bind(userAddr).first();

  const lastTs = state?.last_activity_ts ?? 0;
  const oldestTs = state?.oldest_activity_ts;
  const backfillDone = !!state?.backfill_done;
  const offset = backfillDone ? 0 : (state?.backfill_offset ?? 0);

  await env.DB
    .prepare("UPDATE sync_state SET status='syncing', attempts=attempts+1 WHERE user_addr=?")
    .bind(userAddr).run();

  let subreq = 1;
  const events = await fetchActivityPage(userAddr, offset);

  let newestSeen = lastTs;
  let oldestSeen = oldestTs ?? Infinity;
  // bucket key: `${tag}|${day}` -> { pnl, volume, trades, wins, losses, edge }
  const buckets = new Map();
  let processed = 0;

  for (const ev of events) {
    const ts = Number(ev.timestamp);
    if (!ts) continue;
    if (ts > newestSeen) newestSeen = ts;
    if (ts < oldestSeen) oldestSeen = ts;
    if (backfillDone && ts <= lastTs) continue;
    if (ts < windowStart) continue;

    const flow = cashFlow(ev);
    const vol = Math.abs(Number(ev.usdcSize) || 0);
    if (flow === 0 && vol === 0) continue;

    // resolve tags (cached or fetch within budget)
    let tags = await getCachedTags(env, ev.eventSlug);
    if (tags === null) {
      if (subreq >= subreqBudget) continue;
      subreq++;
      const cached = await fetchAndCacheEvent(env, ev.eventSlug);
      tags = cached?.tags ?? [];
    }
    const matched = tags.filter((t) => interesting.includes(t));
    if (matched.length === 0) continue;

    // resolved-market skill metric (best-effort; market may not yet be cached)
    let ew = null;
    if (ev.type === "TRADE") {
      const market = await getCachedMarket(env, ev.conditionId);
      ew = edgeAndWin(ev, market);
    }

    const day = Math.floor(ts / DAY);
    for (const tag of matched) {
      const k = `${tag}|${day}`;
      const b = buckets.get(k) || { pnl: 0, volume: 0, trades: 0, wins: 0, losses: 0, edge: 0 };
      b.pnl    += flow;
      b.volume += vol;
      b.trades += 1;
      if (ew) {
        b.edge += ew.edge;
        if (ew.won) b.wins += 1; else b.losses += 1;
      }
      buckets.set(k, b);
    }
    processed++;
  }

  if (buckets.size > 0) {
    const stmts = [];
    for (const [k, v] of buckets) {
      const [tag, day] = k.split("|");
      stmts.push(env.DB.prepare(`
        INSERT INTO user_tag_daily
          (user_addr, tag_slug, day, pnl, volume, trades, wins, losses, edge)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_addr, tag_slug, day) DO UPDATE SET
          pnl    = pnl    + excluded.pnl,
          volume = volume + excluded.volume,
          trades = trades + excluded.trades,
          wins   = wins   + excluded.wins,
          losses = losses + excluded.losses,
          edge   = edge   + excluded.edge
      `).bind(userAddr, tag, Number(day), v.pnl, v.volume, v.trades, v.wins, v.losses, v.edge));
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  // 1 more subrequest: refresh unrealized P&L from /positions
  let unrealizedUpdated = 0;
  if (subreq < subreqBudget) {
    subreq++;
    try {
      unrealizedUpdated = await refreshUnrealized(env, userAddr, interesting);
    } catch {}
  }

  // advance backfill cursor / finalize
  let newOffset = offset;
  let newBackfillDone = backfillDone ? 1 : 0;
  if (!backfillDone) {
    if (events.length < 500 || oldestSeen <= windowStart) {
      newBackfillDone = 1;
      newOffset = 0;
    } else {
      newOffset = offset + 500;
    }
  }

  await env.DB.prepare(`
    UPDATE sync_state
       SET last_activity_ts   = MAX(COALESCE(last_activity_ts, 0), ?),
           oldest_activity_ts = MIN(COALESCE(oldest_activity_ts, 9999999999), ?),
           backfill_offset    = ?,
           backfill_done      = ?,
           last_synced_at     = ?,
           status             = 'done',
           error_message      = NULL
     WHERE user_addr = ?
  `).bind(
    newestSeen,
    Number.isFinite(oldestSeen) ? oldestSeen : null,
    newOffset,
    newBackfillDone,
    now,
    userAddr,
  ).run();

  return {
    fetched: events.length,
    processed,
    subreq,
    mode: backfillDone ? "incremental" : (newBackfillDone ? "backfill-complete" : "backfill"),
    new_offset: newOffset,
    unrealized_tags: unrealizedUpdated,
  };
}

// ─── Unrealized P&L (from /positions) ───────────────────────────────────────
async function refreshUnrealized(env, userAddr, interesting) {
  const url = `${DATA_API}/positions?user=${userAddr}&limit=500`;
  const res = await fetch(url);
  if (!res.ok) return 0;
  const positions = await res.json();
  const now = Math.floor(Date.now() / 1000);

  // aggregate per tag
  const agg = new Map(); // tag -> { cashPnl, curVal, initVal, n }
  for (const p of positions) {
    const slug = p.eventSlug;
    const tags = await getCachedTags(env, slug);
    if (!tags) continue; // unknown event → skip (will be picked up next sync)
    const matched = tags.filter((t) => interesting.includes(t));
    if (matched.length === 0) continue;
    for (const tag of matched) {
      const a = agg.get(tag) || { cashPnl: 0, curVal: 0, initVal: 0, n: 0 };
      a.cashPnl += Number(p.cashPnl) || 0;
      a.curVal  += Number(p.currentValue) || 0;
      a.initVal += Number(p.initialValue) || 0;
      a.n += 1;
      agg.set(tag, a);
    }
  }

  // replace user_tag_unrealized rows for this user (delete + insert keeps it fresh)
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

// ─── Discovery: find new traders by crawling tag-specific markets ───────────
async function seedDiscoveryFromTag(env, tag) {
  const now = Math.floor(Date.now() / 1000);
  // recent + active events for the tag
  const url = `${GAMMA_API}/events?tag_slug=${encodeURIComponent(tag)}&limit=100&order=startDate&ascending=false`;
  const res = await fetch(url, { cf: { cacheTtl: 3600 } });
  if (!res.ok) return 0;
  const events = await res.json();
  let added = 0;
  const stmts = [];
  for (const e of events) {
    for (const m of (e.markets || [])) {
      if (!m.conditionId) continue;
      stmts.push(env.DB.prepare(`
        INSERT OR IGNORE INTO discovery_queue (scope, market_id, event_slug, added_at, status)
        VALUES (?, ?, ?, ?, 'pending')
      `).bind(`tag:${tag}`, m.conditionId, e.slug, now));
      added++;
    }
  }
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return added;
}

async function discoverStep(env) {
  // pick one pending market
  const row = await env.DB.prepare(`
    SELECT scope, market_id, event_slug FROM discovery_queue
     WHERE status = 'pending'
     ORDER BY added_at ASC LIMIT 1
  `).first();
  if (!row) return { picked: 0 };

  const now = Math.floor(Date.now() / 1000);
  const url = `${DATA_API}/trades?market=${row.market_id}&limit=500`;
  let trades;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`trades ${res.status}`);
    trades = await res.json();
  } catch (err) {
    await env.DB.prepare(
      "UPDATE discovery_queue SET status='failed' WHERE scope=? AND market_id=?"
    ).bind(row.scope, row.market_id).run();
    return { picked: 1, error: String(err) };
  }

  // collect unique wallets
  const wallets = new Map();
  for (const t of trades) {
    const w = t.proxyWallet?.toLowerCase();
    if (!w) continue;
    if (!wallets.has(w)) {
      wallets.set(w, { pseudonym: t.pseudonym, name: t.name, profileImage: t.profileImage });
    }
  }

  const stmts = [];
  for (const [addr, meta] of wallets) {
    stmts.push(env.DB.prepare(`
      INSERT INTO users (address, pseudonym, name, profile_image, first_seen_at, source)
      VALUES (?, ?, ?, ?, ?, 'discovery')
      ON CONFLICT(address) DO NOTHING
    `).bind(addr, meta.pseudonym || null, meta.name || null, meta.profileImage || null, now));
    stmts.push(env.DB.prepare(`
      INSERT INTO sync_state (user_addr, status) VALUES (?, 'pending')
      ON CONFLICT(user_addr) DO NOTHING
    `).bind(addr));
  }
  stmts.push(env.DB.prepare(
    "UPDATE discovery_queue SET status='done' WHERE scope=? AND market_id=?"
  ).bind(row.scope, row.market_id));
  for (let i = 0; i < stmts.length; i += 50) {
    await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { picked: 1, market: row.market_id, scope: row.scope, new_wallets: wallets.size };
}

// ─── Bootstrap ──────────────────────────────────────────────────────────────
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
    stmts.push(env.DB.prepare(`
      INSERT INTO sync_state (user_addr, status) VALUES (?, 'pending')
      ON CONFLICT(user_addr) DO NOTHING
    `).bind(u.proxyWallet.toLowerCase()));
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

// ─── Scheduled handler (cron) ───────────────────────────────────────────────
async function runScheduled(env, ctx) {
  const windowDays = Number(env.WINDOW_DAYS || 180);
  const subreqBudget = Number(env.SUBREQUEST_BUDGET || 40);
  const now = Math.floor(Date.now() / 1000);

  const userCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first();
  if (!userCount || userCount.n === 0) {
    await bootstrap(env);
  }

  // seed discovery queue if empty
  const dqCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM discovery_queue").first();
  if (dqCount.n === 0) {
    const tags = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => s.trim());
    for (const t of tags) {
      await seedDiscoveryFromTag(env, t);
    }
  }

  // recover stuck "syncing" rows
  await env.DB.prepare(`
    UPDATE sync_state SET status='pending'
     WHERE status='syncing' AND COALESCE(last_synced_at, 0) < ?
  `).bind(now - 600).run();

  const results = { discovery: null, sync: [] };

  // 1 discovery step (cheap, 1 subrequest)
  try {
    results.discovery = await discoverStep(env);
  } catch (err) {
    results.discovery = { error: String(err) };
  }

  // 1 user sync (remaining budget)
  const remaining = subreqBudget - 1;
  const pick = await env.DB.prepare(`
    SELECT user_addr FROM sync_state
     WHERE status != 'syncing'
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
       COALESCE(last_synced_at, 0) ASC
     LIMIT 1
  `).first();
  if (pick) {
    try {
      const r = await syncUser(env, pick.user_addr, windowDays, remaining);
      results.sync.push({ user: pick.user_addr, ok: true, ...r });
    } catch (err) {
      await env.DB.prepare(`
        UPDATE sync_state SET status='failed', error_message=?, last_synced_at=?
         WHERE user_addr=?
      `).bind(String(err).slice(0, 500), now, pick.user_addr).run();
      results.sync.push({ user: pick.user_addr, ok: false, error: String(err) });
    }
  }

  await env.DB.prepare(
    "INSERT INTO ops_log (ts, kind, message, data) VALUES (?, 'cron', ?, ?)"
  ).bind(now, `disc=${results.discovery?.new_wallets ?? 0} sync=${results.sync.length}`, JSON.stringify(results)).run();
  return results;
}

// ─── Public API handlers ────────────────────────────────────────────────────
async function apiLeaderboard(env, url) {
  const tag = url.searchParams.get("tag") || "ufc";
  const window = Number(url.searchParams.get("window") || env.WINDOW_DAYS || 180);
  const order = (url.searchParams.get("order") || "loss").toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

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
      SUM(utd.trades)                                AS trades,
      SUM(utd.wins)                                  AS wins,
      SUM(utd.losses)                                AS losses,
      SUM(utd.edge)                                  AS edge,
      COALESCE(unr.cash_pnl, 0)                      AS unrealized_pnl,
      COALESCE(unr.current_value, 0)                 AS unrealized_value,
      COALESCE(unr.open_positions, 0)                AS open_positions,
      MAX(utd.day)                                   AS last_day
    FROM user_tag_daily utd
    LEFT JOIN users u            ON u.address    = utd.user_addr
    LEFT JOIN user_tag_unrealized unr
                                 ON unr.user_addr = utd.user_addr
                                AND unr.tag_slug  = utd.tag_slug
    WHERE utd.tag_slug = ? AND utd.day >= ?
    GROUP BY utd.user_addr
    HAVING trades > 0
    ORDER BY pnl ${direction}
    LIMIT ?
  `).bind(tag, minDay, limit).all()).results;

  // enrich with derived metrics
  for (const r of rows) {
    const decided = (r.wins || 0) + (r.losses || 0);
    r.win_rate = decided > 0 ? r.wins / decided : null;
    r.edge_per_dollar = r.volume > 0 ? r.edge / r.volume : null;
    r.total_pnl = (r.pnl || 0) + (r.unrealized_pnl || 0);
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
      SUM(utd.pnl)    AS pnl,
      SUM(utd.volume) AS volume,
      SUM(utd.trades) AS trades,
      SUM(utd.wins)   AS wins,
      SUM(utd.losses) AS losses,
      SUM(utd.edge)   AS edge,
      MAX(utd.day)    AS last_day,
      COALESCE(unr.cash_pnl, 0)        AS unrealized_pnl,
      COALESCE(unr.current_value, 0)   AS unrealized_value,
      COALESCE(unr.open_positions, 0)  AS open_positions
    FROM user_tag_daily utd
    LEFT JOIN user_tag_unrealized unr
           ON unr.user_addr = utd.user_addr AND unr.tag_slug = utd.tag_slug
    WHERE utd.user_addr = ? AND utd.day >= ?
    GROUP BY utd.tag_slug
    ORDER BY pnl ASC
  `).bind(a, minDay).all()).results;
  for (const r of tagRows) {
    const decided = (r.wins || 0) + (r.losses || 0);
    r.win_rate = decided > 0 ? r.wins / decided : null;
    r.edge_per_dollar = r.volume > 0 ? r.edge / r.volume : null;
    r.total_pnl = (r.pnl || 0) + (r.unrealized_pnl || 0);
  }

  const dailyRows = (await env.DB.prepare(`
    SELECT tag_slug, day, pnl, volume, trades, wins, losses, edge
      FROM user_tag_daily
     WHERE user_addr = ? AND day >= ?
     ORDER BY day ASC
  `).bind(a, minDay).all()).results;

  const sync = await env.DB
    .prepare("SELECT last_activity_ts, last_synced_at, status, backfill_done FROM sync_state WHERE user_addr = ?")
    .bind(a).first();

  return jsonResponse({ user, by_tag: tagRows, daily: dailyRows, sync });
}

async function apiStatus(env) {
  const counts = {};
  for (const t of ["users", "user_tag_daily", "user_tag_unrealized", "event_tags", "markets", "discovery_queue"]) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first();
    counts[t] = r.n;
  }
  const syncStats = (await env.DB.prepare(`
    SELECT status, COUNT(*) AS n FROM sync_state GROUP BY status
  `).all()).results;
  const discStats = (await env.DB.prepare(`
    SELECT scope, status, COUNT(*) AS n FROM discovery_queue GROUP BY scope, status
  `).all()).results;
  const recent = (await env.DB.prepare(`
    SELECT ts, kind, message FROM ops_log ORDER BY ts DESC LIMIT 10
  `).all()).results;
  return jsonResponse({ counts, sync: syncStats, discovery: discStats, recent });
}

async function apiTags(env) {
  const rows = (await env.DB.prepare(
    "SELECT slug, label FROM tags WHERE enabled = 1 ORDER BY label"
  ).all()).results;
  const interesting = (env.DEFAULT_TAGS || "ufc,tennis").split(",").map((s) => s.trim());
  return jsonResponse({ tags: rows, default: interesting });
}

// ─── Worker entry ───────────────────────────────────────────────────────────
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
        if (url.pathname === "/api/admin/sync" && request.method === "POST") {
          const res = await runScheduled(env, ctx);
          return jsonResponse({ ok: true, ...res });
        }
        if (url.pathname === "/api/admin/discover" && request.method === "POST") {
          const tag = url.searchParams.get("tag");
          if (tag) {
            const n = await seedDiscoveryFromTag(env, tag);
            return jsonResponse({ ok: true, seeded: n });
          }
          const res = await discoverStep(env);
          return jsonResponse({ ok: true, ...res });
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
