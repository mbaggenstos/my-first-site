// Cloudflare Pages Function: aggregiert den Infrastruktur-Status mehrerer
// Provider serverseitig (CORS-frei) und liefert ein normalisiertes JSON.
//
// Route:  /api/status
// Cache:  Edge-Cache 60s (s-maxage), damit wir die Quellen nicht hämmern.
//
// Jede Quelle läuft isoliert (Promise.allSettled + try/catch): Fällt eine aus,
// erscheint sie als "unknown" — das Dashboard bleibt funktionsfähig.

const TIMEOUT_MS = 8000;
const UA = "MacherwebStatusBot/1.0 (+https://azure.macherweb.ch)";

// Status-Stufen: operational < degraded < outage < unknown
const RANK = { operational: 0, degraded: 1, outage: 2, unknown: -1 };

async function fetchText(url, { headers = {}, as = "text" } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cf: { cacheTtl: 30, cacheEverything: true },
      headers: { "user-agent": UA, accept: "*/*", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (as === "buffer") return await res.arrayBuffer();
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function tile(over) {
  return {
    id: over.id,
    name: over.name,
    category: over.category,
    status: over.status || "unknown",
    detail: over.detail || "",
    reports: over.reports ?? null,
    source: over.source,
    link: over.link || over.source,
    note: over.note || "",
    updated: over.updated || null,
  };
}

// --- Atlassian Statuspage (Cloudflare & viele andere teilen dieses Schema) ---
async function statuspage({ id, name, category, base, link }) {
  try {
    const json = JSON.parse(await fetchText(`${base}/api/v2/status.json`));
    const ind = json?.status?.indicator || "none";
    const status =
      ind === "none" ? "operational" : ind === "minor" ? "degraded" : "outage";
    return tile({
      id, name, category,
      status,
      detail: json?.status?.description || "",
      source: base,
      link: link || base,
      updated: json?.page?.updated_at || null,
    });
  } catch (e) {
    return tile({ id, name, category, status: "unknown", detail: String(e), source: base, link });
  }
}

// --- Microsoft Azure (öffentlicher RSS-Feed, XML) ---
async function azure() {
  const src = "https://azure.status.microsoft/en-us/status/feed/";
  try {
    const xml = await fetchText(src);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const blk = m[1];
      const pick = (tag) => (blk.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) || [, ""])[1]
        .replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      return { title: pick("title"), desc: pick("description"), pub: pick("pubDate") };
    });
    const blob = items.map((i) => `${i.title} ${i.desc}`).join(" ");
    const swiss = /switzerland/i.test(blob);
    let status = "operational";
    if (items.length) status = swiss ? "outage" : "degraded";
    const detail = items.length
      ? items.slice(0, 4).map((i) => i.title).filter(Boolean).join("; ")
      : "Keine aktiven Azure-Vorfälle";
    return tile({
      id: "azure", name: "Microsoft Azure", category: "Cloud",
      status, reports: items.length, detail,
      note: swiss ? "Schweiz-Region betroffen" : "",
      source: src, link: "https://azure.status.microsoft/en-us/status",
    });
  } catch (e) {
    return tile({ id: "azure", name: "Microsoft Azure", category: "Cloud", status: "unknown", detail: String(e), source: src, link: "https://azure.status.microsoft/en-us/status" });
  }
}

// --- CH Telecom via störunglive.ch (Crowd-Meldungen, inoffiziell) ---
// Heuristik auf Basis der gemeldeten 24h-Nutzerberichte.
const CROWD_DEGRADED = 10; // ab so vielen Meldungen: "auffällig"
const CROWD_OUTAGE = 40;   // ab so vielen Meldungen: "Störung wahrscheinlich"

async function crowd({ id, name, slug, official }) {
  const src = `https://www.xn--strunglive-fcb.ch/status/${slug}`;
  try {
    const html = await fetchText(src);
    const nums = [...html.matchAll(/(\d+)\s*Meldungen/g)].map((m) => Number(m[1]));
    const reports = nums.length ? Math.max(...nums) : 0;
    let status = "operational";
    if (reports >= CROWD_OUTAGE) status = "outage";
    else if (reports >= CROWD_DEGRADED) status = "degraded";
    return tile({
      id, name, category: "CH Telecom",
      status, reports,
      detail: reports
        ? `${reports} Nutzer-Meldungen in 24h`
        : "Keine grösseren Störungen gemeldet",
      note: "Crowd-Daten (inoffiziell)",
      source: src, link: official || src,
    });
  } catch (e) {
    return tile({ id, name, category: "CH Telecom", status: "unknown", detail: String(e), note: "Crowd-Daten (inoffiziell)", source: src, link: official || src });
  }
}

// --- CH Strom & weitere: keine API -> reine Link-Kacheln ---
const LINK_ONLY = [
  { id: "ewz", name: "ewz (Strom Zürich)", category: "CH Strom", link: "https://www.ewz.ch/de/services/stoerungen.html" },
  { id: "ekz", name: "EKZ (Strom Kanton ZH)", category: "CH Strom", link: "https://www.ekz.ch/" },
  { id: "swissgrid", name: "Swissgrid (Übertragungsnetz)", category: "CH Strom", link: "https://www.swissgrid.ch/de/home/operation/grid-data/current-data.html" },
  { id: "m365", name: "Microsoft 365", category: "Cloud", link: "https://status.cloud.microsoft/m365/" },
];

export async function onRequest() {
  const jobs = [
    statuspage({ id: "cloudflare", name: "Cloudflare", category: "Cloud", base: "https://www.cloudflarestatus.com" }),
    statuspage({ id: "fortinet", name: "Fortinet (FortiCloud)", category: "Cloud", base: "https://status.forticloud.com" }),
    azure(),
    crowd({ id: "swisscom", name: "Swisscom", slug: "swisscom", official: "https://www.swisscom.ch/de/privatkunden/hilfe/netz-und-service-status.html" }),
    crowd({ id: "sunrise", name: "Sunrise", slug: "sunrise", official: "https://www.sunrise.ch/de/support/aktuelle-stoerungen" }),
    crowd({ id: "salt", name: "Salt", slug: "salt", official: "https://www.salt.ch/de/outages/status/" }),
    crowd({ id: "init7", name: "Init7", slug: "init7", official: "https://www.init7.net/de/support/faq/status-info/" }),
  ];

  const settled = await Promise.allSettled(jobs);
  const services = settled.map((s) => (s.status === "fulfilled" ? s.value : tile({ id: "err", name: "Quelle", category: "Cloud", status: "unknown", detail: String(s.reason) })));

  for (const l of LINK_ONLY) {
    services.push(tile({ ...l, status: "unknown", detail: "Keine Echtzeit-API – manuell prüfen", note: "nur Link" }));
  }

  // Gesamtstatus = schlimmste bekannte Stufe
  const worst = services.reduce((acc, s) => (RANK[s.status] > RANK[acc] ? s.status : acc), "operational");

  const body = JSON.stringify({
    generated: new Date().toISOString(),
    overall: worst,
    services,
  });

  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=20, s-maxage=60",
    },
  });
}
