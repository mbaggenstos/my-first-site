// Holt den aggregierten Status von der Cloudflare Pages Function (/api/status)
// und rendert ihn nach Kategorie gruppiert. Auto-Refresh alle 60s.

const API = "/api/status";
const REFRESH_MS = 60000;

const $status = document.getElementById("status");
const $sections = document.getElementById("sections");
const $overall = document.getElementById("overall");
const $overallDot = document.getElementById("overall-dot");
const $refresh = document.getElementById("refresh");
const $tpl = document.getElementById("card-tpl");

const CATEGORY_ORDER = ["CH Telecom", "Cloud", "CH Strom"];

const STATUS_LABEL = {
  operational: "OK",
  degraded: "Auffällig",
  outage: "Störung",
  unknown: "Unbekannt",
};
const OVERALL_LABEL = {
  operational: "Alles läuft",
  degraded: "Auffälligkeiten",
  outage: "Störungen aktiv",
  unknown: "Status unklar",
};

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
}

function render(data) {
  const services = data.services || [];

  $overall.textContent = OVERALL_LABEL[data.overall] || "—";
  $overall.className = `pill ${data.overall}`;
  $overallDot.className = `dot ${data.overall}`;
  $status.textContent = `Stand ${fmtTime(data.generated)} · ${services.length} Quellen`;

  // Kategorien gruppieren, bekannte zuerst
  const groups = {};
  for (const s of services) (groups[s.category] ||= []).push(s);
  const cats = [
    ...CATEGORY_ORDER.filter((c) => groups[c]),
    ...Object.keys(groups).filter((c) => !CATEGORY_ORDER.includes(c)),
  ];

  $sections.replaceChildren();
  for (const cat of cats) {
    const h = document.createElement("h2");
    h.className = "section-title";
    h.textContent = cat;
    $sections.append(h);

    const grid = document.createElement("section");
    grid.className = "grid";

    // innerhalb der Gruppe: Störungen nach oben
    const rank = { outage: 0, degraded: 1, unknown: 2, operational: 3 };
    const items = [...groups[cat]].sort((a, b) => rank[a.status] - rank[b.status]);

    for (const s of items) {
      const node = $tpl.content.firstElementChild.cloneNode(true);
      node.classList.add(s.status);
      node.querySelector(".state-dot").className = `state-dot ${s.status}`;
      node.querySelector(".name").textContent = `${s.name} · ${STATUS_LABEL[s.status]}`;
      node.querySelector(".detail").textContent = s.detail || "";
      node.querySelector(".note").textContent = s.note || "";
      const link = node.querySelector(".open");
      link.href = s.link || s.source || "#";
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
    box.textContent =
      "Konnte Status nicht laden: " + err.message +
      " (läuft die Cloudflare Pages Function?)";
    $status.append(box);
  }
}

$refresh.addEventListener("click", load);
setInterval(load, REFRESH_MS);
load();
