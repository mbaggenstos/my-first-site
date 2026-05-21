const API = "https://gamma-api.polymarket.com/markets";
const PAGE_LIMIT = 60;

const $status = document.getElementById("status");
const $grid = document.getElementById("markets");
const $search = document.getElementById("search");
const $sort = document.getElementById("sort");
const $refresh = document.getElementById("refresh");
const $tpl = document.getElementById("card-tpl");

const $tabs = document.querySelectorAll(".tab");
const $marketsView = document.getElementById("markets-view");
const $playersView = document.getElementById("players-view");
const $marketsCtrl = document.querySelector(".controls-for-markets");
const $playersCtrl = document.querySelector(".controls-for-players");
const $tagSeg = document.querySelectorAll(".seg-btn[data-tag]");
const $orderSeg = document.querySelectorAll(".seg-btn[data-order]");
const $minTrades = document.getElementById("minTrades");
const $playersStats = document.getElementById("players-stats");
const $playersStatus = document.getElementById("players-status");
const $playersTable = document.getElementById("players-table");
const $playersBody = document.getElementById("players-body");
const $statsTpl = document.getElementById("stats-tpl");
const $tableHeaders = document.querySelectorAll("#players-table th.sortable");

let allMarkets = [];
let currentView = "markets";
const playersState = {
  tag: "ufc",
  order: "loss",
  rows: [],
  sortKey: "pnl",
  sortDir: "asc",
  expandedAddr: null,
};
const userDetailCache = new Map();

// ─── Markets ───────────────────────────────────────────────────────────────
function parseMaybeJson(v, fallback) {
  if (v == null) return fallback;
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return fallback;
}

function fmtMoney(n) {
  if (n == null || isNaN(n)) return "—";
  const sign = n < 0 ? "−" : "";
  const a = Math.abs(n);
  if (a >= 1e9) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1e3) return sign + "$" + (a / 1e3).toFixed(1) + "k";
  return sign + "$" + Math.round(a);
}

function fmtDate(d) {
  if (!d) return "";
  const t = new Date(d);
  if (isNaN(t)) return "";
  return t.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function pctClass(name) {
  const n = String(name || "").trim().toLowerCase();
  if (n === "yes" || n === "ja") return "yes";
  if (n === "no" || n === "nein") return "no";
  return "";
}

async function fetchMarkets() {
  const params = new URLSearchParams({
    closed: "false",
    active: "true",
    limit: String(PAGE_LIMIT),
    order: "volume24hr",
    ascending: "false",
  });
  const res = await fetch(`${API}?${params}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.data || []);
}

function normalizeMarket(m) {
  const outcomes = parseMaybeJson(m.outcomes, []);
  const prices = parseMaybeJson(m.outcomePrices, []).map(Number);
  const items = outcomes.map((name, i) => ({
    name,
    price: prices[i] != null && !isNaN(prices[i]) ? prices[i] : null,
  }));
  return {
    id: m.id || m.conditionId || m.slug,
    question: m.question || m.title || m.slug || "Markt",
    slug: m.slug,
    image: m.image || m.icon || null,
    volume: Number(m.volume) || 0,
    volume24: Number(m.volume24hr) || 0,
    liquidity: Number(m.liquidity) || 0,
    end: m.endDate || m.end_date_iso || m.endDateIso,
    created: m.createdAt || m.startDate,
    outcomes: items,
  };
}

function sortMarkets(arr, mode) {
  const a = [...arr];
  switch (mode) {
    case "liquidity": a.sort((x, y) => y.liquidity - x.liquidity); break;
    case "newest":    a.sort((x, y) => new Date(y.created || 0) - new Date(x.created || 0)); break;
    case "ending":    a.sort((x, y) => new Date(x.end || 8.64e15) - new Date(y.end || 8.64e15)); break;
    case "volume":
    default:          a.sort((x, y) => (y.volume24 || y.volume) - (x.volume24 || x.volume)); break;
  }
  return a;
}

function filterMarkets(arr, q) {
  const s = q.trim().toLowerCase();
  if (!s) return arr;
  return arr.filter(m => m.question.toLowerCase().includes(s));
}

function renderMarkets(list) {
  $grid.replaceChildren();
  if (!list.length) {
    $status.textContent = "Keine Märkte gefunden.";
    return;
  }
  $status.textContent = `${list.length} aktive Märkte`;
  const frag = document.createDocumentFragment();
  for (const m of list) {
    const node = $tpl.content.firstElementChild.cloneNode(true);
    const img = node.querySelector(".thumb");
    if (m.image) { img.src = m.image; } else { img.hidden = true; }
    node.querySelector(".question").textContent = m.question;

    const ul = node.querySelector(".outcomes");
    for (const o of m.outcomes) {
      const li = document.createElement("li");
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = o.name;
      const price = document.createElement("span");
      price.className = `price ${pctClass(o.name)}`;
      price.textContent = o.price == null ? "—" : (Math.round(o.price * 100) + "¢");
      li.append(name, price);
      ul.append(li);
    }

    const vol = m.volume24 || m.volume;
    node.querySelector(".vol").textContent = "Vol: " + fmtMoney(vol);
    node.querySelector(".end").textContent = m.end ? "Endet: " + fmtDate(m.end) : "";

    const link = node.querySelector(".open");
    link.href = m.slug ? `https://polymarket.com/market/${m.slug}` : "https://polymarket.com";

    frag.append(node);
  }
  $grid.append(frag);
  $grid.setAttribute("aria-busy", "false");
}

function updateMarkets() {
  const filtered = filterMarkets(allMarkets, $search.value);
  const sorted = sortMarkets(filtered, $sort.value);
  renderMarkets(sorted);
}

async function loadMarkets() {
  $grid.setAttribute("aria-busy", "true");
  $status.textContent = "Lade Märkte…";
  $grid.replaceChildren();
  try {
    const raw = await fetchMarkets();
    allMarkets = raw.map(normalizeMarket).filter(m => m.outcomes.length > 0);
    updateMarkets();
  } catch (err) {
    $status.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = "Konnte Märkte nicht laden: " + err.message;
    $status.append(box);
    $grid.setAttribute("aria-busy", "false");
  }
}

// ─── Players ───────────────────────────────────────────────────────────────
function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }

function pctOrDash(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return (n * 100).toFixed(digits) + "%";
}

function renderSkeleton() {
  $playersBody.replaceChildren();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < 8; i++) {
    const tr = document.createElement("tr");
    tr.className = "skeleton-row";
    for (let c = 0; c < 9; c++) {
      const td = document.createElement("td");
      const b = document.createElement("div");
      b.className = "skeleton-bar";
      b.style.width = c === 1 ? "70%" : "60%";
      td.append(b);
      tr.append(td);
    }
    frag.append(tr);
  }
  $playersBody.append(frag);
}

function renderStats(rows, totalRows) {
  $playersStats.replaceChildren();
  if (!rows.length) return;
  const stats = [
    { label: "Players (gefiltert)", value: String(rows.length), sub: `von ${totalRows}` },
    { label: "Σ Volume 180d", value: fmtMoney(rows.reduce((s, r) => s + (r.volume || 0), 0)) },
    { label: "Σ P&L 180d", valueRaw: rows.reduce((s, r) => s + (r.pnl || 0), 0), signed: true },
    {
      label: playersState.order === "loss" ? "Größter Loss" : "Größter Win",
      valueRaw: playersState.order === "loss"
        ? Math.min(...rows.map((r) => r.pnl || 0))
        : Math.max(...rows.map((r) => r.pnl || 0)),
      signed: true,
    },
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
    }
    if (s.sub) {
      const sub = document.createElement("div");
      sub.className = "stat-sub";
      sub.textContent = s.sub;
      node.append(sub);
    }
    frag.append(node);
  }
  $playersStats.append(frag);
}

function applyFilterAndSort(rows) {
  const minT = Number($minTrades.value || 0);
  let out = rows.filter((r) => (r.trades || 0) >= minT);
  const k = playersState.sortKey;
  const dir = playersState.sortDir === "asc" ? 1 : -1;
  out.sort((a, b) => {
    const av = a[k]; const bv = b[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
  return out;
}

function renderPlayers() {
  const filtered = applyFilterAndSort(playersState.rows);
  renderStats(filtered, playersState.rows.length);
  $playersBody.replaceChildren();
  if (!filtered.length) {
    $playersStatus.textContent = playersState.rows.length
      ? "Keine Player passen zum Filter."
      : `Noch keine Player-Daten für ${playersState.tag.toUpperCase()} — Cron syncht im Hintergrund.`;
    return;
  }
  $playersStatus.textContent = `${filtered.length} Player`;

  const frag = document.createDocumentFragment();
  filtered.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.className = "row";
    tr.dataset.addr = r.address;
    if (r.address === playersState.expandedAddr) tr.classList.add("open");

    const td = (cls = "") => { const e = document.createElement("td"); if (cls) e.className = cls; return e; };
    const tdNum = (n, opts = {}) => {
      const e = td("num" + (opts.hide ? " " + opts.hide : ""));
      if (n == null || isNaN(n)) { e.textContent = "—"; e.classList.add("muted"); return e; }
      if (opts.fmt === "pct") {
        e.textContent = pctOrDash(n);
      } else {
        e.textContent = fmtMoney(n);
      }
      if (opts.signed) e.classList.add(n >= 0 ? "pnl-pos" : "pnl-neg");
      return e;
    };

    const rank = td("col-rank"); rank.textContent = i + 1; tr.append(rank);

    const player = td("col-player");
    const inner = document.createElement("div");
    inner.className = "player-cell";
    if (r.profile_image) {
      const img = document.createElement("img");
      img.src = r.profile_image; img.loading = "lazy"; img.alt = "";
      inner.append(img);
    } else {
      const av = document.createElement("span"); av.className = "av";
      inner.append(av);
    }
    const meta = document.createElement("div");
    meta.className = "player-meta";
    const name = document.createElement("div"); name.className = "player-name";
    name.textContent = r.name || r.pseudonym || shortAddr(r.address);
    const addr = document.createElement("span"); addr.className = "player-addr";
    addr.textContent = shortAddr(r.address);
    meta.append(name, addr);
    inner.append(meta);
    player.append(inner);
    tr.append(player);

    tr.append(tdNum(r.pnl, { signed: true }));
    tr.append(tdNum(r.unrealized_pnl, { signed: true, hide: "hide-sm" }));
    tr.append(tdNum(r.total_pnl, { signed: true }));
    tr.append(tdNum(r.volume, { hide: "hide-sm" }));
    const trades = td("num hide-md"); trades.textContent = r.trades || 0; tr.append(trades);
    tr.append(tdNum(r.win_rate, { fmt: "pct", hide: "hide-md" }));
    const edge = tdNum(r.edge_per_dollar, { fmt: "pct", hide: "hide-md" });
    if (r.edge_per_dollar != null && !isNaN(r.edge_per_dollar)) {
      edge.classList.add(r.edge_per_dollar >= 0 ? "pnl-pos" : "pnl-neg");
    }
    tr.append(edge);

    tr.addEventListener("click", () => togglePlayerRow(r.address, tr));
    frag.append(tr);

    if (r.address === playersState.expandedAddr) {
      const exp = buildExpandRow(r);
      frag.append(exp);
    }
  });
  $playersBody.append(frag);
}

function buildExpandRow(rowData) {
  const exp = document.createElement("tr");
  exp.className = "expand-row";
  const td = document.createElement("td");
  td.colSpan = 9;
  const inner = document.createElement("div");
  inner.className = "expand-inner loading";
  inner.textContent = "Lade Daily-Daten…";
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
    host.textContent = "Fehler: " + err.message;
  }
}

function renderDetail(rowData, detail, host) {
  host.classList.remove("loading");
  host.replaceChildren();

  // Sparkline data: aggregate per-day P&L for the currently-selected tag
  const daily = (detail.daily || []).filter((d) => d.tag_slug === playersState.tag);
  const today = Math.floor(Date.now() / 1000 / 86400);
  const start = today - 180;
  // build full series with zeros for missing days
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const series = [];
  for (let d = start; d <= today; d++) {
    const r = byDay.get(d);
    series.push({ day: d, pnl: r ? r.pnl : 0, trades: r ? r.trades : 0 });
  }

  const wrap = document.createElement("div");
  wrap.className = "spark-wrap";
  const title = document.createElement("h4");
  title.textContent = `Daily P&L · ${playersState.tag.toUpperCase()} · letzte 180 Tage`;
  wrap.append(title);
  wrap.append(renderSpark(series));
  host.append(wrap);

  // side panel: key tag stats + link
  const side = document.createElement("div");
  side.className = "expand-side";
  const stats = (detail.by_tag || []).find((t) => t.tag_slug === playersState.tag);
  const sync = detail.sync || {};
  const items = [
    ["Win-Rate", pctOrDash(stats?.win_rate)],
    ["Edge/$", pctOrDash(stats?.edge_per_dollar)],
    ["Wins", String(stats?.wins ?? 0)],
    ["Losses", String(stats?.losses ?? 0)],
    ["Open Positions", String(stats?.open_positions ?? 0)],
    ["All-time Profit", fmtMoney(detail.user?.lb_amount)],
    ["Backfill", sync.backfill_done ? "✓ complete" : "läuft…"],
  ];
  for (const [k, v] of items) {
    const row = document.createElement("div");
    row.className = "kv";
    const ke = document.createElement("span"); ke.className = "k"; ke.textContent = k;
    const ve = document.createElement("span"); ve.className = "v"; ve.textContent = v;
    row.append(ke, ve);
    side.append(row);
  }
  const link = document.createElement("a");
  link.className = "open-profile";
  link.target = "_blank"; link.rel = "noopener";
  link.href = "https://polymarket.com/profile/" + rowData.address;
  link.textContent = "Auf Polymarket öffnen ↗";
  side.append(link);
  host.append(side);
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

  // zero axis
  const axis = document.createElementNS("http://www.w3.org/2000/svg", "line");
  axis.setAttribute("x1", PAD); axis.setAttribute("x2", W - PAD);
  axis.setAttribute("y1", mid); axis.setAttribute("y2", mid);
  axis.setAttribute("class", "spark-axis");
  svg.append(axis);

  // bars
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
    const date = new Date(s.day * 86400 * 1000);
    titleEl.textContent = `${date.toISOString().slice(0, 10)}: ${fmtMoney(s.pnl)}`;
    rect.append(titleEl);
    svg.append(rect);
  });

  // axis labels (max/min markers)
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

function togglePlayerRow(addr, tr) {
  if (playersState.expandedAddr === addr) {
    playersState.expandedAddr = null;
  } else {
    playersState.expandedAddr = addr;
  }
  renderPlayers();
}

async function loadPlayers() {
  renderSkeleton();
  $playersStatus.textContent = "Lade Players…";
  $playersStats.replaceChildren();
  try {
    const u = new URL("/api/leaderboard", location.origin);
    u.searchParams.set("tag", playersState.tag);
    u.searchParams.set("order", playersState.order);
    u.searchParams.set("limit", "200");
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    playersState.rows = data.rows || [];
    // align default sort with order
    playersState.sortKey = "pnl";
    playersState.sortDir = playersState.order === "loss" ? "asc" : "desc";
    updateSortIndicators();
    renderPlayers();
  } catch (err) {
    $playersBody.replaceChildren();
    $playersStatus.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = "Konnte Leaderboard nicht laden: " + err.message;
    $playersStatus.append(box);
  }
}

function updateSortIndicators() {
  for (const th of $tableHeaders) {
    th.classList.remove("sort-asc", "sort-desc");
    if (th.dataset.sort === playersState.sortKey) {
      th.classList.add(playersState.sortDir === "asc" ? "sort-asc" : "sort-desc");
    }
  }
}

// ─── Tab navigation ────────────────────────────────────────────────────────
function setView(name) {
  currentView = name;
  for (const t of $tabs) t.classList.toggle("active", t.dataset.view === name);
  $marketsView.hidden = name !== "markets";
  $playersView.hidden = name !== "players";
  $marketsCtrl.hidden = name !== "markets";
  $playersCtrl.hidden = name !== "players";
  if (name === "players") loadPlayers();
}

for (const t of $tabs) t.addEventListener("click", () => setView(t.dataset.view));

for (const b of $tagSeg) {
  b.addEventListener("click", () => {
    for (const x of $tagSeg) x.classList.toggle("active", x === b);
    playersState.tag = b.dataset.tag;
    playersState.expandedAddr = null;
    userDetailCache.clear();
    loadPlayers();
  });
}
for (const b of $orderSeg) {
  b.addEventListener("click", () => {
    for (const x of $orderSeg) x.classList.toggle("active", x === b);
    playersState.order = b.dataset.order;
    playersState.expandedAddr = null;
    loadPlayers();
  });
}

for (const th of $tableHeaders) {
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    if (playersState.sortKey === key) {
      playersState.sortDir = playersState.sortDir === "asc" ? "desc" : "asc";
    } else {
      playersState.sortKey = key;
      // sensible default direction: pnl/edge ASC for loss-mode, else DESC
      playersState.sortDir = (key === "pnl" || key === "total_pnl" || key === "edge_per_dollar")
        ? (playersState.order === "loss" ? "asc" : "desc")
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

$search.addEventListener("input", updateMarkets);
$sort.addEventListener("change", updateMarkets);
$refresh.addEventListener("click", () => currentView === "markets" ? loadMarkets() : loadPlayers());

loadMarkets();
