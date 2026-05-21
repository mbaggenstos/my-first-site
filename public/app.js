// Polymarket Players — Leaderboard, Tiers, Skill metrics.

const $refresh = document.getElementById("refresh");
const $tagSeg = document.querySelectorAll(".seg-btn[data-tag]");
const $orderSeg = document.querySelectorAll(".seg-btn[data-order]");
const $minTrades = document.getElementById("minTrades");
const $tierFilter = document.getElementById("tier-filter");
const $tierChips = $tierFilter.querySelectorAll(".chip");
const $playersStats = document.getElementById("players-stats");
const $playersStatus = document.getElementById("players-status");
const $playersBody = document.getElementById("players-body");
const $statsTpl = document.getElementById("stats-tpl");
const $tableHeaders = document.querySelectorAll("#players-table th.sortable");

const state = {
  tag: "ufc",
  order: "loss",
  rows: [],
  sortKey: "pnl",
  sortDir: "asc",
  tier: "all",
  expandedAddr: null,
};
const userDetailCache = new Map();

// ─── Formatting ────────────────────────────────────────────────────────────
function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "k";
  return sign + "$" + Math.round(a);
}
function pctOrDash(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(digits) + "%";
}
function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
// Polymarket assigns auto-names that are literally wallet hashes (long hex
// strings, sometimes with a numeric suffix). These wreck table layout, so
// fall back to short-addr when the displayed name has no real characters.
function displayName(r) {
  const candidates = [r.name, r.pseudonym].filter(Boolean);
  for (const c of candidates) {
    if (c.length > 30 || /^0x[0-9a-fA-F]{20,}/.test(c)) continue;
    return c;
  }
  return shortAddr(r.address);
}
function dateUTC(daySinceEpoch) {
  return new Date(daySinceEpoch * 86400 * 1000).toISOString().slice(0, 10);
}

// ─── Tier classification (by 180d volume) ──────────────────────────────────
const TIERS = {
  whale:  { min: 5_000_000, ico: "🐋", label: "Whale" },
  big:    { min:   500_000, ico: "🐬", label: "Big Fish" },
  fish:   { min:    50_000, ico: "🐟", label: "Fish" },
  perch:  { min:     5_000, ico: "🐠", label: "Perch" },
  shrimp: { min:         0, ico: "🦐", label: "Shrimp" },
};
const TIER_ORDER = ["whale", "big", "fish", "perch", "shrimp"];
function tierFor(volume) {
  const v = volume || 0;
  for (const k of TIER_ORDER) if (v >= TIERS[k].min) return k;
  return "shrimp";
}
function buildTierBadge(volume) {
  const tier = tierFor(volume);
  const t = TIERS[tier];
  const el = document.createElement("span");
  el.className = "tier-badge";
  el.dataset.tier = tier;
  el.title = `${t.label} — volume ≥ ${fmtMoney(t.min)}`;
  const ico = document.createElement("span"); ico.className = "ico"; ico.textContent = t.ico;
  const lbl = document.createElement("span"); lbl.textContent = t.label;
  el.append(ico, lbl);
  return el;
}

// extra status icons next to the name: hot streak, big losses, perfect record
function buildNameIcons(row) {
  const wrap = document.createElement("span");
  wrap.className = "name-icons";
  const trades = row.trades || 0;
  if (trades >= 500) {
    const e = document.createElement("span"); e.className = "ico hot"; e.title = `Very active: ${trades} trades`; e.textContent = "🔥";
    wrap.append(e);
  } else if (trades >= 200) {
    const e = document.createElement("span"); e.className = "ico"; e.title = `${trades} trades`; e.textContent = "⚡";
    wrap.append(e);
  }
  if ((row.pnl || 0) <= -500_000) {
    const e = document.createElement("span"); e.className = "ico skull"; e.title = "Heavy losses"; e.textContent = "💀";
    wrap.append(e);
  }
  const decided = (row.wins || 0) + (row.losses || 0);
  if (decided >= 10 && row.wins === decided) {
    const e = document.createElement("span"); e.className = "ico star"; e.title = "Undefeated on resolved markets"; e.textContent = "⭐";
    wrap.append(e);
  }
  return wrap;
}

// ─── Skeleton ──────────────────────────────────────────────────────────────
function renderSkeleton() {
  $playersBody.replaceChildren();
  const cols = document.querySelectorAll("#players-table thead th").length;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 8; i++) {
    const tr = document.createElement("tr");
    tr.className = "skeleton-row";
    for (let c = 0; c < cols; c++) {
      const td = document.createElement("td");
      const b = document.createElement("div"); b.className = "skeleton-bar";
      b.style.width = c === 1 ? "70%" : "60%";
      td.append(b);
      tr.append(td);
    }
    frag.append(tr);
  }
  $playersBody.append(frag);
}

// ─── Stats banner ──────────────────────────────────────────────────────────
function renderStats(filtered, total) {
  $playersStats.replaceChildren();
  if (!filtered.length) return;

  // tier breakdown
  const breakdown = { whale: 0, big: 0, fish: 0, perch: 0, shrimp: 0 };
  for (const r of filtered) breakdown[tierFor(r.volume)]++;
  const tierLine = TIER_ORDER
    .filter((k) => breakdown[k] > 0)
    .map((k) => `${TIERS[k].ico} ${breakdown[k]}`)
    .join("  ·  ");

  const stats = [
    { label: "Players", value: String(filtered.length), sub: total !== filtered.length ? `of ${total}` : null },
    { label: "Σ Volume 180d", value: fmtMoney(filtered.reduce((s, r) => s + (r.volume || 0), 0)) },
    { label: "Σ P&L 180d", valueRaw: filtered.reduce((s, r) => s + (r.pnl || 0), 0), signed: true },
    {
      label: state.order === "loss" ? "Biggest loss" : "Biggest win",
      valueRaw: state.order === "loss"
        ? Math.min(...filtered.map((r) => r.pnl || 0))
        : Math.max(...filtered.map((r) => r.pnl || 0)),
      signed: true,
    },
    { label: "Tier breakdown", value: tierLine || "—" },
  ];

  const frag = document.createDocumentFragment();
  for (const s of stats) {
    const node = $statsTpl.content.firstElementChild.cloneNode(true);
    node.querySelector(".stat-label").textContent = s.label;
    const v = node.querySelector(".stat-value");
    if (s.valueRaw != null) {
      v.textContent = fmtMoney(s.valueRaw);
      if (s.signed) v.classList.add(s.valueRaw >= 0 ? "pos" : "neg");
    } else {
      v.textContent = s.value;
      if (s.label === "Tier breakdown") v.style.fontSize = "16px";
    }
    if (s.sub) {
      const sub = document.createElement("div"); sub.className = "stat-sub"; sub.textContent = s.sub;
      node.append(sub);
    }
    frag.append(node);
  }
  $playersStats.append(frag);
}

// ─── Filter + sort ─────────────────────────────────────────────────────────
function applyFilterAndSort(rows) {
  const minT = Number($minTrades.value || 0);
  let out = rows.filter((r) => (r.trades || 0) >= minT);
  if (state.tier !== "all") out = out.filter((r) => tierFor(r.volume) === state.tier);

  const k = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    const av = a[k]; const bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
  return out;
}

// ─── Render players table ─────────────────────────────────────────────────
function renderPlayers() {
  const filtered = applyFilterAndSort(state.rows);
  renderStats(filtered, state.rows.length);
  $playersBody.replaceChildren();
  if (!filtered.length) {
    $playersStatus.textContent = state.rows.length
      ? "No players match this filter."
      : `No player data yet for ${state.tag.toUpperCase()} — scan running in the background.`;
    return;
  }
  $playersStatus.textContent = `${filtered.length} players`;

  const frag = document.createDocumentFragment();
  filtered.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.dataset.addr = r.address;
    if (r.address === state.expandedAddr) tr.classList.add("open");

    const td = (cls = "") => { const e = document.createElement("td"); if (cls) e.className = cls; return e; };
    const tdNum = (n, opts = {}) => {
      const e = td("num" + (opts.hide ? " " + opts.hide : ""));
      if (n == null || isNaN(n)) { e.textContent = "—"; e.classList.add("muted"); return e; }
      e.textContent = opts.fmt === "pct" ? pctOrDash(n) : fmtMoney(n);
      if (opts.signed) e.classList.add(n >= 0 ? "pnl-pos" : "pnl-neg");
      if (opts.outlier) e.classList.add("outlier");
      return e;
    };

    const rank = td("col-rank"); rank.textContent = i + 1; tr.append(rank);

    // player cell
    const player = td("col-player");
    const inner = document.createElement("div"); inner.className = "player-cell";
    if (r.profile_image) {
      const img = document.createElement("img");
      img.src = r.profile_image; img.loading = "lazy"; img.alt = "";
      inner.append(img);
    } else {
      const av = document.createElement("span"); av.className = "av";
      av.textContent = TIERS[tierFor(r.volume)].ico;
      inner.append(av);
    }
    const meta = document.createElement("div"); meta.className = "player-meta";
    const name = document.createElement("div"); name.className = "player-name";
    name.textContent = displayName(r);
    name.append(buildNameIcons(r));
    const addr = document.createElement("span"); addr.className = "player-addr";
    addr.textContent = shortAddr(r.address);
    meta.append(name, addr);
    inner.append(meta);
    player.append(inner);
    tr.append(player);

    // tier badge column
    const tierCell = td("col-tier hide-sm");
    tierCell.append(buildTierBadge(r.volume));
    tr.append(tierCell);

    tr.append(tdNum(r.pnl, { signed: true, outlier: Math.abs(r.pnl || 0) >= 500_000 }));
    tr.append(tdNum(r.unrealized_pnl, { signed: true, hide: "hide-sm" }));
    tr.append(tdNum(r.total_pnl, { signed: true, outlier: Math.abs(r.total_pnl || 0) >= 500_000 }));
    tr.append(tdNum(r.volume, { hide: "hide-sm", outlier: r.volume >= 1_000_000 }));
    const markets = td("num hide-md"); markets.textContent = r.markets_played || 0;
    if ((r.markets_played || 0) >= 30) markets.classList.add("outlier");
    tr.append(markets);
    const trades = td("num hide-md"); trades.textContent = r.trades || 0;
    if ((r.trades || 0) >= 1000) trades.classList.add("outlier");
    tr.append(trades);
    tr.append(tdNum(r.avg_trade_size, { hide: "hide-md", outlier: r.avg_trade_size >= 50_000 }));
    tr.append(tdNum(r.largest_trade, { hide: "hide-md", outlier: r.largest_trade >= 100_000 }));
    const makerTd = td("num hide-md");
    if (r.maker_ratio == null) { makerTd.textContent = "—"; makerTd.classList.add("muted"); }
    else {
      makerTd.textContent = pctOrDash(r.maker_ratio);
      if (r.maker_ratio >= 0.7) { makerTd.classList.add("pnl-pos", "outlier"); makerTd.title = "Mostly maker — likely sophisticated"; }
      else if (r.maker_ratio <= 0.2) { makerTd.classList.add("pnl-neg", "outlier"); makerTd.title = "Mostly taker — fish-like"; }
    }
    tr.append(makerTd);
    const winTd = tdNum(r.win_rate, { fmt: "pct", hide: "hide-md" });
    if (r.win_rate != null) {
      if (r.win_rate >= 0.6) winTd.classList.add("pnl-pos", "outlier");
      else if (r.win_rate <= 0.3) winTd.classList.add("pnl-neg", "outlier");
    }
    tr.append(winTd);
    const edge = tdNum(r.edge_per_dollar, { fmt: "pct", hide: "hide-md" });
    if (r.edge_per_dollar != null && !isNaN(r.edge_per_dollar)) {
      edge.classList.add(r.edge_per_dollar >= 0 ? "pnl-pos" : "pnl-neg");
      if (Math.abs(r.edge_per_dollar) >= 0.5) edge.classList.add("outlier");
    }
    tr.append(edge);

    tr.addEventListener("click", () => togglePlayerRow(r.address));
    frag.append(tr);

    if (r.address === state.expandedAddr) {
      frag.append(buildExpandRow(r));
    }
  });
  $playersBody.append(frag);
}

// ─── Expanded row ──────────────────────────────────────────────────────────
function buildExpandRow(rowData) {
  const exp = document.createElement("tr");
  exp.className = "expand-row";
  const td = document.createElement("td");
  td.colSpan = document.querySelectorAll("#players-table thead th").length || 13;
  const inner = document.createElement("div");
  inner.className = "expand-inner loading";
  inner.textContent = "Loading details…";
  td.append(inner);
  exp.append(td);
  fetchAndRenderDetail(rowData, inner);
  return exp;
}

async function fetchAndRenderDetail(rowData, host) {
  try {
    let detail = userDetailCache.get(rowData.address);
    if (!detail) {
      const res = await fetch("/api/users/" + rowData.address);
      if (!res.ok) throw new Error("HTTP " + res.status);
      detail = await res.json();
      userDetailCache.set(rowData.address, detail);
    }
    renderDetail(rowData, detail, host);
  } catch (err) {
    host.classList.remove("loading");
    host.textContent = "Error: " + err.message;
  }
}

function renderDetail(rowData, detail, host) {
  host.classList.remove("loading");
  host.replaceChildren();

  // Daily P&L sparkline for current tag
  const daily = (detail.daily || []).filter((d) => d.tag_slug === state.tag);
  const today = Math.floor(Date.now() / 1000 / 86400);
  const start = today - 180;
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const series = [];
  for (let d = start; d <= today; d++) {
    const r = byDay.get(d);
    series.push({ day: d, pnl: r ? r.pnl : 0 });
  }

  const wrap = document.createElement("div"); wrap.className = "spark-wrap";
  const title = document.createElement("h4");
  title.textContent = `Daily P&L · ${state.tag.toUpperCase()} · last 180 days`;
  wrap.append(title);
  wrap.append(renderSpark(series));
  // top markets table below sparkline
  const tm = (detail.top_markets || []).filter((m) => m.tag_slug === state.tag).slice(0, 5);
  if (tm.length) {
    const h = document.createElement("h4"); h.textContent = "Top markets (by |P&L|)";
    h.style.marginTop = "14px";
    wrap.append(h);
    wrap.append(renderMarketsTable(tm, { showDate: false }));
  }
  // recent markets sorted by most recent trade
  const rm = (detail.recent_markets || []).filter((m) => m.tag_slug === state.tag).slice(0, 10);
  if (rm.length) {
    const h = document.createElement("h4"); h.textContent = "Recent activity (by last trade)";
    h.style.marginTop = "14px";
    wrap.append(h);
    wrap.append(renderMarketsTable(rm, { showDate: true }));
  }
  host.append(wrap);

  // Side panel: stats grouped
  const tag = (detail.by_tag || []).find((t) => t.tag_slug === state.tag) || {};
  const side = document.createElement("div"); side.className = "expand-side";
  const makerRatio = tag.maker_ratio;
  const items = [
    ["Markets played",    tag.markets_played != null ? tag.markets_played : "—"],
    ["Trades",            tag.trades != null ? tag.trades : "—"],
    ["Trades / market",   tag.trades_per_market != null ? tag.trades_per_market.toFixed(1) : "—"],
    ["Volume",            fmtMoney(tag.volume)],
    ["Avg trade size",    fmtMoney(tag.avg_trade_size)],
    ["Avg position",      fmtMoney(tag.avg_position_size)],
    ["Largest trade",     fmtMoney(tag.largest_trade)],
    ["", null],
    ["Maker volume",      fmtMoney(tag.maker_volume)],
    ["Maker / Taker",     makerRatio == null ? "—" :
      `${(makerRatio * 100).toFixed(0)}% / ${((1 - makerRatio) * 100).toFixed(0)}%`],
    ["", null],
    ["Wins",              String(tag.wins ?? 0)],
    ["Losses",            String(tag.losses ?? 0)],
    ["Win rate",          pctOrDash(tag.win_rate)],
    ["Edge / $",          pctOrDash(tag.edge_per_dollar)],
    ["", null],
    ["Best market P&L",   fmtMoney(tag.biggest_market_win)],
    ["Worst market",      fmtMoney(tag.biggest_market_loss)],
    ["Open positions",    String(tag.open_positions ?? 0)],
    ["All-time profit",   fmtMoney(detail.user?.lb_amount)],
  ];
  for (const [k, v] of items) {
    if (k === "" && v == null) {
      const sep = document.createElement("div");
      sep.style.cssText = "height:6px";
      side.append(sep);
      continue;
    }
    const row = document.createElement("div"); row.className = "kv";
    const ke = document.createElement("span"); ke.className = "k"; ke.textContent = k;
    const ve = document.createElement("span"); ve.className = "v"; ve.textContent = v;
    row.append(ke, ve);
    side.append(row);
  }
  const link = document.createElement("a");
  link.className = "open-profile";
  link.target = "_blank"; link.rel = "noopener";
  link.href = "https://polymarket.com/profile/" + rowData.address;
  link.textContent = "Open on Polymarket ↗";
  side.append(link);
  host.append(side);
}

function renderMarketsTable(markets, opts = {}) {
  const t = document.createElement("table");
  t.className = "players-table inline-table";
  const thead = document.createElement("thead");
  const dateHead = opts.showDate ? "<th>Last trade</th>" : "";
  thead.innerHTML = `<tr>
    <th>Market</th>
    ${dateHead}
    <th class="num">P&L</th>
    <th class="num">Vol</th>
    <th class="num">Trades</th>
    <th class="num">Largest</th>
  </tr>`;
  t.append(thead);
  const tbody = document.createElement("tbody");
  for (const m of markets) {
    const tr = document.createElement("tr");
    const title = m.title || m.market_slug || m.condition_id.slice(0, 10) + "…";
    const link = m.market_slug
      ? `<a href="https://polymarket.com/market/${m.market_slug}" target="_blank" rel="noopener">${title}</a>`
      : title;
    const dateCell = opts.showDate
      ? `<td class="muted" style="font-size:11.5px; white-space:nowrap;">${new Date((m.last_trade_ts || 0) * 1000).toISOString().slice(0, 10)}</td>`
      : "";
    tr.innerHTML = `
      <td>${link}</td>
      ${dateCell}
      <td class="num ${m.pnl >= 0 ? "pnl-pos" : "pnl-neg"}">${fmtMoney(m.pnl)}</td>
      <td class="num">${fmtMoney(m.volume)}</td>
      <td class="num">${m.trades}</td>
      <td class="num">${fmtMoney(m.largest_trade)}</td>
    `;
    tbody.append(tr);
  }
  t.append(tbody);
  return t;
}

function renderSpark(series) {
  const W = 600, H = 120, PAD = 4;
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "none");

  const maxAbs = Math.max(1, ...series.map((s) => Math.abs(s.pnl || 0)));
  const barW = (W - 2 * PAD) / series.length;
  const mid = H / 2;
  const scale = (mid - PAD) / maxAbs;

  const axis = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axis.setAttribute("x1", PAD); axis.setAttribute("x2", W - PAD);
  axis.setAttribute("y1", mid); axis.setAttribute("y2", mid);
  axis.setAttribute("class", "spark-axis");
  svg.append(axis);

  series.forEach((s, i) => {
    if (!s.pnl) return;
    const x = PAD + i * barW;
    const h = Math.abs(s.pnl) * scale;
    const y = s.pnl >= 0 ? mid - h : mid;
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", x);
    rect.setAttribute("y", y);
    rect.setAttribute("width", Math.max(0.5, barW - 0.5));
    rect.setAttribute("height", h);
    rect.setAttribute("class", s.pnl >= 0 ? "spark-bar-pos" : "spark-bar-neg");
    const titleEl = document.createElementNS("http://www.w3.org/2000/svg", "title");
    titleEl.textContent = `${dateUTC(s.day)}: ${fmtMoney(s.pnl)}`;
    rect.append(titleEl);
    svg.append(rect);
  });

  const lblMax = document.createElementNS("http://www.w3.org/2000/svg", "text");
  lblMax.setAttribute("x", PAD); lblMax.setAttribute("y", PAD + 10);
  lblMax.setAttribute("class", "spark-label");
  lblMax.textContent = "+" + fmtMoney(maxAbs);
  svg.append(lblMax);
  const lblMin = document.createElementNS("http://www.w3.org/2000/svg", "text");
  lblMin.setAttribute("x", PAD); lblMin.setAttribute("y", H - PAD - 2);
  lblMin.setAttribute("class", "spark-label");
  lblMin.textContent = "−" + fmtMoney(maxAbs);
  svg.append(lblMin);

  return svg;
}

function togglePlayerRow(addr) {
  state.expandedAddr = (state.expandedAddr === addr) ? null : addr;
  renderPlayers();
}

// ─── Data load ─────────────────────────────────────────────────────────────
async function load() {
  renderSkeleton();
  $playersStatus.textContent = "Loading players…";
  $playersStats.replaceChildren();
  try {
    const u = new URL("/api/leaderboard", location.origin);
    u.searchParams.set("tag", state.tag);
    u.searchParams.set("order", state.order);
    u.searchParams.set("limit", "500");
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    state.rows = data.rows || [];
    state.sortKey = "pnl";
    state.sortDir = state.order === "loss" ? "asc" : "desc";
    updateSortIndicators();
    renderPlayers();
  } catch (err) {
    $playersBody.replaceChildren();
    $playersStatus.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = "Could not load leaderboard: " + err.message;
    $playersStatus.append(box);
  }
}

function updateSortIndicators() {
  for (const th of $tableHeaders) {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === state.sortKey) {
      th.classList.add(state.sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  }
}

// ─── Event wiring ──────────────────────────────────────────────────────────
for (const b of $tagSeg) {
  b.addEventListener("click", () => {
    for (const x of $tagSeg) x.classList.toggle("active", x === b);
    state.tag = b.dataset.tag;
    state.expandedAddr = null;
    userDetailCache.clear();
    load();
  });
}
for (const b of $orderSeg) {
  b.addEventListener("click", () => {
    for (const x of $orderSeg) x.classList.toggle("active", x === b);
    state.order = b.dataset.order;
    state.expandedAddr = null;
    load();
  });
}
for (const c of $tierChips) {
  c.addEventListener("click", () => {
    for (const x of $tierChips) x.classList.toggle("active", x === c);
    state.tier = c.dataset.tier;
    state.expandedAddr = null;
    renderPlayers();
  });
}
for (const th of $tableHeaders) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) {
      state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
    } else {
      state.sortKey = key;
      state.sortDir = (key === "pnl" || key === "total_pnl" || key === "edge_per_dollar")
        ? (state.order === "loss" ? "asc" : "desc")
        : "desc";
    }
    updateSortIndicators();
    renderPlayers();
  });
}
let minTradesDebounce;
$minTrades.addEventListener("input", () => {
  clearTimeout(minTradesDebounce);
  minTradesDebounce = setTimeout(renderPlayers, 150);
});
$refresh.addEventListener("click", () => { userDetailCache.clear(); load(); });

load();
