// Holt den aggregierten Status (/api/status) und rendert ein kompaktes
// Icon-Raster. Klick auf eine Kachel öffnet die Detailansicht mit Begründung
// und klickbaren Quell-Links. Auto-Refresh alle 60s.

const API = "/api/status";
const REFRESH_MS = 60000;

const $status = document.getElementById("status");
const $sections = document.getElementById("sections");
const $overall = document.getElementById("overall");
const $overallDot = document.getElementById("overall-dot");
const $stamp = document.getElementById("stamp");
const $refresh = document.getElementById("refresh");
const $tpl = document.getElementById("tile-tpl");
const $modal = document.getElementById("modal");

const CATEGORY_ORDER = ["CH Telecom", "Microsoft 365", "Cloud"];
const STATUS_LABEL = { operational: "OK", degraded: "Auffällig", outage: "Störung", unknown: "Unbekannt" };
const OVERALL_LABEL = { operational: "Alles läuft", degraded: "Auffälligkeiten", outage: "Störungen aktiv", unknown: "Status unklar" };

let lastById = {};

function favicon(domain) {
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : "";
}
function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

function openDetail(s) {
  document.getElementById("m-icon").src = favicon(s.icon);
  document.getElementById("m-name").textContent = s.name;
  const st = document.getElementById("m-status");
  st.textContent = STATUS_LABEL[s.status] || "—";
  st.className = `pill ${s.status}`;
  document.getElementById("m-reason").textContent = s.reason || "";
  document.getElementById("m-method").textContent = s.method ? "Methode: " + s.method : "";

  const ul = document.getElementById("m-sources");
  ul.replaceChildren();
  for (const src of s.sources || []) {
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = src.url; a.target = "_blank"; a.rel = "noopener";
    a.textContent = src.label;
    const val = document.createElement("span");
    val.className = "src-val";
    val.textContent = src.value || "";
    li.append(a, val);
    ul.append(li);
  }
  document.getElementById("m-updated").textContent =
    s.updated ? "Quelle aktualisiert: " + new Date(s.updated).toLocaleString("de-CH") : "";

  $modal.hidden = false;
}
function closeDetail() { $modal.hidden = true; }

function render(data) {
  const services = data.services || [];
  lastById = Object.fromEntries(services.map((s) => [s.id, s]));

  $overall.textContent = OVERALL_LABEL[data.overall] || "—";
  $overall.className = `pill ${data.overall}`;
  $overallDot.className = `dot ${data.overall}`;
  $stamp.textContent = `Stand ${fmtTime(data.generated)}`;
  $status.textContent = `${services.length} Quellen überwacht`;

  const groups = {};
  for (const s of services) (groups[s.category] ||= []).push(s);
  const cats = [
    ...CATEGORY_ORDER.filter((c) => groups[c]),
    ...Object.keys(groups).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  const rank = { outage: 0, degraded: 1, unknown: 2, operational: 3 };
  $sections.replaceChildren();
  for (const cat of cats) {
    const h = document.createElement("h2");
    h.className = "section-title";
    h.textContent = cat;
    $sections.append(h);

    const grid = document.createElement("section");
    grid.className = "grid";
    for (const s of [...groups[cat]].sort((a, b) => rank[a.status] - rank[b.status])) {
      const node = $tpl.content.firstElementChild.cloneNode(true);
      node.classList.add(s.status);
      const img = node.querySelector(".tile-icon");
      if (s.icon) img.src = favicon(s.icon); else img.hidden = true;
      node.querySelector(".tile-name").textContent = s.name;
      node.querySelector(".tile-headline").textContent = s.headline || STATUS_LABEL[s.status];
      node.querySelector(".state-dot").className = `state-dot ${s.status}`;
      node.title = `${s.name}: ${STATUS_LABEL[s.status]} – Details anzeigen`;
      node.addEventListener("click", () => openDetail(lastById[s.id]));
      grid.append(node);
    }
    $sections.append(grid);
  }
}

async function load() {
  $status.textContent = "Lade Status…";
  try {
    const res = await fetch(API, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    $status.innerHTML = "";
    const box = document.createElement("div");
    box.className = "error";
    box.textContent = "Konnte Status nicht laden: " + err.message;
    $status.append(box);
  }
}

$refresh.addEventListener("click", load);
$modal.addEventListener("click", (e) => { if (e.target.dataset.close !== undefined) closeDetail(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });
setInterval(load, REFRESH_MS);
load();
