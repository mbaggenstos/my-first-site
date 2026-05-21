const API = "https://gamma-api.polymarket.com/markets";
const PAGE_LIMIT = 60;

const $status = document.getElementById("status");
const $grid = document.getElementById("markets");
const $search = document.getElementById("search");
const $sort = document.getElementById("sort");
const $refresh = document.getElementById("refresh");
const $tpl = document.getElementById("card-tpl");

let allMarkets = [];

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
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "k";
  return "$" + Math.round(n);
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

function normalize(m) {
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

function sortBy(arr, mode) {
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

function filterBy(arr, q) {
  const s = q.trim().toLowerCase();
  if (!s) return arr;
  return arr.filter(m => m.question.toLowerCase().includes(s));
}

function render(list) {
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

function update() {
  const filtered = filterBy(allMarkets, $search.value);
  const sorted = sortBy(filtered, $sort.value);
  render(sorted);
}

async function load() {
  $grid.setAttribute("aria-busy", "true");
  $status.textContent = "Lade Märkte…";
  $grid.replaceChildren();
  try {
    const raw = await fetchMarkets();
    allMarkets = raw.map(normalize).filter(m => m.outcomes.length > 0);
    update();
  } catch (err) {
    $status.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = "Konnte Märkte nicht laden: " + err.message;
    $status.append(box);
    $grid.setAttribute("aria-busy", "false");
  }
}

$search.addEventListener("input", update);
$sort.addEventListener("change", update);
$refresh.addEventListener("click", load);

load();
