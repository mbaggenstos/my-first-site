// Polymarket Player-Analytics Worker
// - Serves static frontend via ASSETS binding
// - Serves /api/* read endpoints from D1
// - Cron every 5 min: bootstrap (one-shot) + incremental sync of next pending users
//
// Data flow per user:
//   activity API (paginated)  ->  per-event tag lookup  ->  per-(user, tag, day) aggregate in D1
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

// ─── Cash-flow model ────────────────────────────────────────────────────────
// Signed USDC delta per activity event from the user's perspective.
// + = money in, - = money out
function cashFlow(ev) {
  const size = Number(ev.usdcSize) || 0;
  switch (ev.type) {
    case "TRADE": {
      // side BUY = user pays usdcSize for shares; SELL = user gets usdcSize
      const side = String(ev.side || "").toUpperCase();
      if (side === "BUY")  return -size;
      if (side === "SELL") return  size;
      return 0;
    }
    case "REDEEM":
      // collected winning shares after market resolution -> cash in
      return  size;
    case "MERGE":
      // combined YES+NO shares back to USDC -> cash in
      return  size;
    case "SPLIT":
      // minted YES+NO shares from USDC -> cash out
      return -size;
    case "CONVERSION":
    case "REWARD":
      return  size;
    default:
      return 0;
  }
}

// ─── Tag lookup (event-slug -> tags), cached in D1 ──────────────────────────
async function getEventTags(env, eventSlug, conditionId, ctx) {
  if (!eventSlug) return [];

  const cached = await env.DB
    .prepare("SELECT tag_slug FROM event_tags WHERE event_slug = ?")
    .bind(eventSlug)
    .all();
  if (cached.results.length > 0) {
    return cached.results.map((r) => r.tag_slug);
  }

  // fetch from Gamma
  const url = `${GAMMA_API}/events?slug=${encodeURIComponent(eventSlug)}`;
  let events;
  try {
    const res = await fetch(url, { cf: { cacheTtl: 86400 } });
    if (!res.ok) return [];
    events = await res.json();
  } catch {
    return [];
  }
  if (!Array.isArray(events) || events.length === 0) {
    // mark as "no tags" with a sentinel so we don't refetch forever
    await env.DB
      .prepare("INSERT OR IGNORE INTO event_tags (event_slug, tag_slug) VALUES (?, '__none__')")
      .bind(eventSlug).run();
    return [];
  }
  const tags = (events[0].tags || []).map((t) => t.slug).filter(Boolean);

  // persist
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
  // also cache market metadata
  if (conditionId) {
    const m = (events[0].markets || []).find((x) => x.conditionId === conditionId);
    if (m) {
      stmts.push(env.DB.prepare(`
        INSERT OR REPLACE INTO markets
          (condition_id, event_slug, market_slug, title, end_date, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        conditionId,
        eventSlug,
        m.slug || null,
        m.question || null,
        m.endDate ? Math.floor(new Date(m.endDate).getTime() / 1000) : null,
        Math.floor(Date.now() / 1000),
      ));
    }
  }
  await env.DB.batch(stmts);

  return tags;
}

// ─── Activity sync ──────────────────────────────────────────────────────────
async function fetchActivityPage(user, offset, limit = 500) {
  const url = `${DATA_API}/activity?user=${user}&limit=${limit}&offset=${offset}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`activity ${res.status}`);
  return res.json();
}

// Process ONE page (500 activity events) per invocation to stay within the
// 50-subrequest free-plan budget. Backfill walks older pages over many cron
// runs; once oldest event < windowStart, switch to incremental (offset=0).
async function syncUser(env, userAddr, windowDays) {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - windowDays * DAY;
  const budget = Number(env.SUBREQUEST_BUDGET || 40);
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

  // 1 subrequest: fetch one activity page
  let subrequests = 1;
  const events = await fetchActivityPage(userAddr, offset);

  let newestSeen = lastTs;
  let oldestSeen = oldestTs ?? Infinity;
  const buckets = new Map(); // `${tag}|${day}` -> { pnl, volume, trades }
  const seenSlugs = new Set();
  let processed = 0;

  for (const ev of events) {
    const ts = Number(ev.timestamp);
    if (!ts) continue;

    // always track the time range we've actually seen, so backfill termination
    // and incremental cursors work even for out-of-window or zero-flow events.
    if (ts > newestSeen) newestSeen = ts;
    if (ts < oldestSeen) oldestSeen = ts;

    if (backfillDone && ts <= lastTs) continue;
    if (ts < windowStart) continue; // out of window: don't aggregate, but keep cursor moving

    const flow = cashFlow(ev);
    const vol = Math.abs(Number(ev.usdcSize) || 0);
    if (flow === 0 && vol === 0) continue;

    let tags;
    const cached = await env.DB
      .prepare("SELECT tag_slug FROM event_tags WHERE event_slug = ?")
      .bind(ev.eventSlug || "").all();
    if (cached.results.length > 0) {
      tags = cached.results.map((r) => r.tag_slug);
    } else if (subrequests < budget && ev.eventSlug && !seenSlugs.has(ev.eventSlug)) {
      seenSlugs.add(ev.eventSlug);
      subrequests++;
      tags = await getEventTags(env, ev.eventSlug, ev.conditionId);
    } else {
      // budget hit: skip but don't fail; will retry next run
      continue;
    }

    const matched = tags.filter((t) => interesting.includes(t));
    if (matched.length === 0) continue;

    const day = Math.floor(ts / DAY);
    for (const tag of matched) {
      const k = `${tag}|${day}`;
      const b = buckets.get(k) || { pnl: 0, volume: 0, trades: 0 };
      b.pnl += flow;
      b.volume += vol;
      b.trades += 1;
      buckets.set(k, b);
    }
    processed++;
  }

  // persist aggregates
  if (buckets.size > 0) {
    const stmts = [];
    for (const [k, v] of buckets) {
      const [tag, day] = k.split("|");
      stmts.push(env.DB.prepare(`
        INSERT INTO user_tag_daily (user_addr, tag_slug, day, pnl, volume, trades)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_addr, tag_slug, day) DO UPDATE SET
          pnl    = pnl    + excluded.pnl,
          volume = volume + excluded.volume,
          trades = trades + excluded.trades
      `).bind(userAddr, tag, Number(day), v.pnl, v.volume, v.trades));
    }
    for (let i = 0; i < stmts.length; i += 50) {
      await env.DB.batch(stmts.slice(i, i + 50));
    }
  }

  // decide new sync state
  let newOffset = offset;
  let newBackfillDone = backfillDone ? 1 : 0;
  if (!backfillDone) {
    if (events.length < 500 || oldestSeen <= windowStart) {
      // walked off the end of the user's activity, or off the window edge
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
    subrequests,
    mode: backfillDone ? "incremental" : (newBackfillDone ? "backfill-complete" : "backfill"),
    new_offset: newOffset,
    oldest_seen: Number.isFinite(oldestSeen) ? oldestSeen : null,
    newest_seen: newestSeen,
  };
}

// ─── Bootstrap top users from lb-api ────────────────────────────────────────
async function bootstrap(env) {
  const topN = Number(env.BOOTSTRAP_TOP_N || 500);
  // lb-api caps each list at 50 and ignores window/period/limit params.
  // Combine /profit + /volume for a ~100-user seed pool.
  const [profitRes, volumeRes] = await Promise.all([
    fetch(`${LB_API}/profit`),
    fetch(`${LB_API}/volume`),
  ]);
  if (!profitRes.ok) throw new Error(`lb-api profit ${profitRes.status}`);
  const profitList = await profitRes.json();
  const volumeList = volumeRes.ok ? await volumeRes.json() : [];

  // dedupe by proxyWallet, prefer profit-list entry first
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

  const userStmts = [];
  const stateStmts = [];
  for (let i = 0; i < top.length; i++) {
    const u = top[i];
    if (!u.proxyWallet) continue;
    userStmts.push(env.DB.prepare(`
      INSERT INTO users (address, pseudonym, name, profile_image, bio, lb_amount, lb_rank, first_seen_at, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'leaderboard')
      ON CONFLICT(address) DO UPDATE SET
        pseudonym=excluded.pseudonym,
        name=excluded.name,
        profile_image=excluded.profile_image,
        bio=excluded.bio,
        lb_amount=excluded.lb_amount,
        lb_rank=excluded.lb_rank
    `).bind(
      u.proxyWallet.toLowerCase(),
      u.pseudonym || null,
      u.name || null,
      u.profileImage || null,
      u.bio || null,
      Number(u.amount) || 0,
      i + 1,
      now,
    ));
    stateStmts.push(env.DB.prepare(`
      INSERT INTO sync_state (user_addr, last_activity_ts, status)
      VALUES (?, 0, 'pending')
      ON CONFLICT(user_addr) DO NOTHING
    `).bind(u.proxyWallet.toLowerCase()));
  }
  for (let i = 0; i < userStmts.length; i += 50) {
    await env.DB.batch(userStmts.slice(i, i + 50));
  }
  for (let i = 0; i < stateStmts.length; i += 50) {
    await env.DB.batch(stateStmts.slice(i, i + 50));
  }

  await env.DB.prepare(
    "INSERT INTO ops_log (ts, kind, message, data) VALUES (?, 'bootstrap', ?, ?)"
  ).bind(now, `seeded ${top.length} users`, JSON.stringify({ topN, profit: profitList.length, volume: volumeList.length, unique: merged.length })).run();

  return top.length;
}

// ─── Scheduled handler ──────────────────────────────────────────────────────
async function runScheduled(env, ctx) {
  const windowDays = Number(env.WINDOW_DAYS || 180);
  const batchSize = Number(env.SYNC_BATCH_SIZE || 5);
  const now = Math.floor(Date.now() / 1000);

  // bootstrap once
  const userCount = await env.DB.prepare("SELECT COUNT(*) as n FROM users").first();
  if (!userCount || userCount.n === 0) {
    await bootstrap(env);
  }

  // recover stuck "syncing" rows older than 10 minutes (crashed mid-sync)
  await env.DB.prepare(`
    UPDATE sync_state SET status='pending'
     WHERE status='syncing' AND COALESCE(last_synced_at, 0) < ?
  `).bind(now - 600).run();

  // pick next users to sync: pending first, then stalest done
  const picks = await env.DB.prepare(`
    SELECT user_addr FROM sync_state
     WHERE status != 'syncing'
     ORDER BY
       CASE status WHEN 'pending' THEN 0 WHEN 'failed' THEN 1 ELSE 2 END,
       COALESCE(last_synced_at, 0) ASC
     LIMIT ?
  `).bind(batchSize).all();

  const results = [];
  for (const row of picks.results) {
    try {
      const r = await syncUser(env, row.user_addr, windowDays);
      results.push({ user: row.user_addr, ok: true, ...r });
    } catch (err) {
      await env.DB.prepare(`
        UPDATE sync_state
           SET status='failed', error_message=?, last_synced_at=?
         WHERE user_addr=?
      `).bind(String(err).slice(0, 500), now, row.user_addr).run();
      results.push({ user: row.user_addr, ok: false, error: String(err) });
    }
  }

  await env.DB.prepare(
    "INSERT INTO ops_log (ts, kind, message, data) VALUES (?, 'cron', ?, ?)"
  ).bind(now, `synced ${results.length} users`, JSON.stringify(results)).run();

  return results;
}

// ─── API handlers ───────────────────────────────────────────────────────────
async function apiLeaderboard(env, url) {
  const tag = url.searchParams.get("tag") || "ufc";
  const window = Number(url.searchParams.get("window") || env.WINDOW_DAYS || 180);
  const order = (url.searchParams.get("order") || "loss").toLowerCase();
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const minDay = todayUtcDay() - window;
  const direction = order === "profit" ? "DESC" : "ASC";

  const stmt = env.DB.prepare(`
    SELECT
      utd.user_addr                  AS address,
      u.pseudonym                    AS pseudonym,
      u.name                         AS name,
      u.profile_image                AS profile_image,
      u.lb_amount                    AS lb_amount,
      SUM(utd.pnl)                   AS pnl,
      SUM(utd.volume)                AS volume,
      SUM(utd.trades)                AS trades,
      MAX(utd.day)                   AS last_day
    FROM user_tag_daily utd
    LEFT JOIN users u ON u.address = utd.user_addr
    WHERE utd.tag_slug = ? AND utd.day >= ?
    GROUP BY utd.user_addr
    HAVING trades > 0
    ORDER BY pnl ${direction}
    LIMIT ?
  `).bind(tag, minDay, limit);

  const rows = (await stmt.all()).results;
  return jsonResponse({ tag, window_days: window, order, count: rows.length, rows });
}

async function apiUser(env, addr) {
  const a = addr.toLowerCase();
  const user = await env.DB
    .prepare("SELECT * FROM users WHERE address = ?")
    .bind(a).first();
  if (!user) return jsonResponse({ error: "user not found" }, { status: 404 });

  const window = Number(env.WINDOW_DAYS || 180);
  const minDay = todayUtcDay() - window;

  const tagRows = (await env.DB.prepare(`
    SELECT tag_slug, SUM(pnl) AS pnl, SUM(volume) AS volume, SUM(trades) AS trades, MAX(day) AS last_day
      FROM user_tag_daily
     WHERE user_addr = ? AND day >= ?
     GROUP BY tag_slug
     ORDER BY pnl ASC
  `).bind(a, minDay).all()).results;

  const dailyRows = (await env.DB.prepare(`
    SELECT tag_slug, day, pnl, volume, trades
      FROM user_tag_daily
     WHERE user_addr = ? AND day >= ?
     ORDER BY day ASC
  `).bind(a, minDay).all()).results;

  const sync = await env.DB
    .prepare("SELECT last_activity_ts, last_synced_at, status FROM sync_state WHERE user_addr = ?")
    .bind(a).first();

  return jsonResponse({ user, by_tag: tagRows, daily: dailyRows, sync });
}

async function apiStatus(env) {
  const counts = {};
  for (const t of ["users", "user_tag_daily", "event_tags", "markets"]) {
    const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first();
    counts[t] = r.n;
  }
  const syncStats = (await env.DB.prepare(`
    SELECT status, COUNT(*) AS n FROM sync_state GROUP BY status
  `).all()).results;
  const recent = (await env.DB.prepare(`
    SELECT ts, kind, message FROM ops_log ORDER BY ts DESC LIMIT 10
  `).all()).results;
  return jsonResponse({ counts, sync: syncStats, recent });
}

// ─── Worker entry ───────────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        if (url.pathname === "/api/health") {
          return jsonResponse({ ok: true, ts: Date.now() });
        }
        if (url.pathname === "/api/status") {
          return apiStatus(env);
        }
        if (url.pathname === "/api/leaderboard") {
          return apiLeaderboard(env, url);
        }
        if (url.pathname.startsWith("/api/users/")) {
          const addr = url.pathname.slice("/api/users/".length);
          return apiUser(env, addr);
        }
        if (url.pathname === "/api/admin/bootstrap" && request.method === "POST") {
          const n = await bootstrap(env);
          return jsonResponse({ ok: true, seeded: n });
        }
        if (url.pathname === "/api/admin/sync" && request.method === "POST") {
          const res = await runScheduled(env, ctx);
          return jsonResponse({ ok: true, results: res });
        }
        return jsonResponse({ error: "not found" }, { status: 404 });
      } catch (err) {
        return jsonResponse({ error: String(err) }, { status: 500 });
      }
    }

    // static fallback
    return env.ASSETS.fetch(request);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, ctx));
  },
};
