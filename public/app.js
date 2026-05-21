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
const $tagSel = document.getElementById("tagSel");
const $orderSel = document.getElementById("orderSel");
const $playersStatus = document.getElementById("players-status");
const $playersBody = document.getElementById("players-body");

let allMarkets = [];
let currentView = "markets";

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

function pctOrDash(n) {
  if (n == null) return "—";
  return (n * 100).toFixed(1) + "%";
}

function renderPlayers(rows) {
  $playersBody.replaceChildren();
  if (!rows.length) {
    $playersStatus.textContent = "Noch keine Player-Daten — Cron syncht im Hintergrund.";
    return;
  }
  $playersStatus.textContent = `${rows.length} Player`;
  const frag = document.createDocumentFragment();
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");

    const td = (cls = "") => { const e = document.createElement("td"); if (cls) e.className = cls; return e; };
    const tdNum = (n, signed = false) => {
      const e = td("num");
      if (n == null || isNaN(n)) { e.textContent = "—"; return e; }
      e.textContent = fmtMoney(n);
      if (signed) e.className += n >= 0 ? " pnl-pos" : " pnl-neg";
      return e;
    };

    const rank = td(); rank.textContent = i + 1; tr.append(rank);

    const player = td("player-cell");
    if (r.profile_image) {
      const img = document.createElement("img");
      img.src = r.profile_image; img.loading = "lazy"; img.alt = "";
      player.append(img);
    } else {
      const sp = document.createElement("span");
      sp.style.cssText = "width:24px;height:24px;background:var(--panel-2);border-radius:50%;flex:0 0 24px";
      player.append(sp);
    }
    const wrap = document.createElement("div");
    const name = document.createElement("div"); name.className = "player-name";
    name.textContent = r.name || r.pseudonym || shortAddr(r.address);
    const addr = document.createElement("a"); addr.className = "player-addr";
    addr.textContent = shortAddr(r.address);
    addr.href = "https://polymarket.com/profile/" + r.address;
    addr.target = "_blank"; addr.rel = "noopener";
    wrap.append(name, addr);
    player.append(wrap);
    tr.append(player);

    tr.append(tdNum(r.pnl, true));
    tr.append(tdNum(r.unrealized_pnl, true));
    tr.append(tdNum(r.total_pnl, true));
    tr.append(tdNum(r.volume));
    const trades = td("num"); trades.textContent = r.trades || 0; tr.append(trades);
    const winRate = td("num");
    winRate.textContent = pctOrDash(r.win_rate);
    if (r.win_rate == null) winRate.className += " muted";
    tr.append(winRate);
    const edge = td("num");
    edge.textContent = r.edge_per_dollar == null ? "—" : pctOrDash(r.edge_per_dollar);
    if (r.edge_per_dollar == null) edge.className += " muted";
    else if (r.edge_per_dollar > 0) edge.className += " pnl-pos";
    else edge.className += " pnl-neg";
    tr.append(edge);

    frag.append(tr);
  });
  $playersBody.append(frag);
}

async function loadPlayers() {
  $playersStatus.textContent = "Lade Players…";
  $playersBody.replaceChildren();
  try {
    const u = new URL("/api/leaderboard", location.origin);
    u.searchParams.set("tag", $tagSel.value);
    u.searchParams.set("order", $orderSel.value);
    u.searchParams.set("limit", "100");
    const res = await fetch(u);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderPlayers(data.rows || []);
  } catch (err) {
    $playersStatus.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = "Konnte Leaderboard nicht laden: " + err.message;
    $playersStatus.append(box);
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

$search.addEventListener("input", updateMarkets);
$sort.addEventListener("change", updateMarkets);
$tagSel.addEventListener("change", loadPlayers);
$orderSel.addEventListener("change", loadPlayers);
$refresh.addEventListener("click", () => currentView === "markets" ? loadMarkets() : loadPlayers());

loadMarkets();
