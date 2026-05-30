// Cloudflare Pages Function: /api/status
// Aggregiert den Infrastruktur-Status mehrerer Provider serverseitig (CORS-frei)
// und liefert pro Service eine BEGRÜNDUNG samt klickbaren Quell-Links, damit im
// Dashboard nachvollziehbar ist, warum ein Status zustande kommt.
//
// Jede Quelle läuft isoliert (Promise.allSettled + try/catch): fällt eine aus,
// erscheint sie als "unknown" – das Dashboard bleibt funktionsfähig.

const TIMEOUT_MS = 8000;
const UA = "MacherwebStatusBot/1.0 (+https://azure.macherweb.ch)";

// Crowd-Schwellen (Nutzer-Meldungen / 24h)
const CROWD_DEGRADED = 10; // ab hier "auffällig"
const CROWD_OUTAGE = 40;   // ab hier "Störung wahrscheinlich"

// Status-Stufen: operational < degraded < outage; unknown = keine Daten
const RANK = { operational: 0, degraded: 1, outage: 2, unknown: -1 };

async function fetchText(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      cf: { cacheTtl: 30, cacheEverything: true },
      headers: { "user-agent": UA, accept: "*/*", ...headers },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function tile(o) {
  return {
    id: o.id,
    name: o.name,
    category: o.category,
    icon: o.icon || "",            // Domain für Favicon
    status: o.status || "unknown",
    headline: o.headline || "",     // kurze Kennzahl
    reason: o.reason || "",         // warum dieser Status?
    method: o.method || "",         // wie wird gemessen?
    sources: o.sources || [],       // [{label, url, value}]
    updated: o.updated || null,
  };
}

// ---------------------------------------------------------------------------
// Atlassian Statuspage (Cloudflare, Fortinet, … – gemeinsames Schema)
// summary.json enthält Status + offene Incidents in einem Call.
// ---------------------------------------------------------------------------
async function statuspage({ id, name, category, base, icon }) {
  try {
    const j = JSON.parse(await fetchText(`${base}/api/v2/summary.json`));
    const ind = j?.status?.indicator || "none";
    const status = ind === "none" ? "operational" : ind === "minor" ? "degraded" : "outage";
    const incidents = (j.incidents || []).filter((i) => i.status !== "resolved");

    const sources = [
      { label: "Offizielle Statusseite", url: base, value: j?.status?.description || "—" },
    ];
    for (const inc of incidents.slice(0, 6)) {
      sources.push({ label: inc.name, url: inc.shortlink || base, value: `Impact: ${inc.impact}` });
    }

    return tile({
      id, name, category, icon, status,
      headline: incidents.length ? `${incidents.length} aktive Vorfälle` : "Alle Systeme normal",
      reason: incidents.length
        ? `Offizielle Statusseite meldet ${incidents.length} laufende(n) Vorfall/Vorfälle (Severity: ${ind}).`
        : "Offizielle Statusseite meldet keinen aktiven Vorfall.",
      method: "Offizielle Atlassian-Statuspage (api/v2/summary.json).",
      sources,
      updated: j?.page?.updated_at || null,
    });
  } catch (e) {
    return tile({ id, name, category, icon, status: "unknown", reason: "Quelle nicht erreichbar: " + e,
      sources: [{ label: "Statusseite", url: base, value: "manuell prüfen" }] });
  }
}

// ---------------------------------------------------------------------------
// Microsoft Azure – offizieller RSS-Feed (XML)
// ---------------------------------------------------------------------------
async function azure() {
  const page = "https://azure.status.microsoft/en-us/status";
  const feed = "https://azure.status.microsoft/en-us/status/feed/";
  try {
    const xml = await fetchText(feed);
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
      const blk = m[1];
      const pick = (t) => (blk.match(new RegExp(`<${t}>([\\s\\S]*?)<\\/${t}>`)) || [, ""])[1]
        .replace(/<!\[CDATA\[|\]\]>/g, "").trim();
      return { title: pick("title"), link: pick("link") || page, pub: pick("pubDate") };
    });
    const swiss = /switzerland/i.test(items.map((i) => i.title).join(" ") + " " + xml);
    const status = items.length ? (swiss ? "outage" : "degraded") : "operational";

    const sources = [
      { label: "Azure Status (offiziell)", url: page,
        value: items.length ? `${items.length} aktive Vorfälle` : "keine aktiven Vorfälle" },
    ];
    for (const it of items.slice(0, 6)) sources.push({ label: it.title, url: it.link, value: it.pub });

    return tile({
      id: "azure", name: "Microsoft Azure", category: "Cloud", icon: "azure.microsoft.com", status,
      headline: items.length ? `${items.length} aktive Vorfälle` : "Keine aktiven Vorfälle",
      reason: items.length
        ? (swiss ? "Azure-Feed listet aktive Vorfälle MIT Schweiz-Bezug." : "Azure-Feed listet aktive Vorfälle (global, kein expliziter CH-Bezug).")
        : "Azure-Statusfeed enthält aktuell keine aktiven Vorfälle.",
      method: "Offizieller Azure-Status-RSS-Feed, gefiltert auf 'Switzerland'.",
      sources,
    });
  } catch (e) {
    return tile({ id: "azure", name: "Microsoft Azure", category: "Cloud", icon: "azure.microsoft.com",
      status: "unknown", reason: "Feed nicht erreichbar: " + e,
      sources: [{ label: "Azure Status", url: page, value: "manuell prüfen" }] });
  }
}

// ---------------------------------------------------------------------------
// Crowd-Daten via störunglive.ch (Nutzer-Meldungen der letzten 24h)
// ---------------------------------------------------------------------------
async function crowd({ id, name, category, slug, icon, official }) {
  const src = `https://www.xn--strunglive-fcb.ch/status/${slug}`;
  try {
    const html = await fetchText(src);
    const nums = [...html.matchAll(/(\d+)\s*Meldungen/g)].map((m) => Number(m[1]));
    const reports = nums.length ? Math.max(...nums) : 0;
    const status = reports >= CROWD_OUTAGE ? "outage" : reports >= CROWD_DEGRADED ? "degraded" : "operational";

    const sources = [
      { label: "störunglive.ch – Crowd-Meldungen", url: src, value: `${reports} Nutzer-Meldungen / 24h` },
    ];
    if (official) sources.push({ label: "Offizielle Statusseite", url: official, value: "Anbieter-Seite" });

    return tile({
      id, name, category, icon, status,
      headline: reports ? `${reports} Meldungen (24h)` : "Keine Meldungen",
      reason: reports
        ? `${reports} Nutzer-Meldungen in 24h. Schwellen: ab ${CROWD_DEGRADED} = auffällig, ab ${CROWD_OUTAGE} = Störung wahrscheinlich.`
        : `Keine grösseren Störungen gemeldet (0 Nutzer-Meldungen). Schwelle für "auffällig": ${CROWD_DEGRADED}.`,
      method: "Crowdsourcing: aggregierte Nutzer-Meldungen (inoffiziell, kein Provider-API).",
      sources,
    });
  } catch (e) {
    return tile({ id, name, category, icon, status: "unknown", reason: "Crowd-Quelle nicht erreichbar: " + e,
      sources: [{ label: "störunglive.ch", url: src, value: "manuell prüfen" }] });
  }
}

export async function onRequest() {
  const jobs = [
    // CH Telecom (Crowd)
    crowd({ id: "swisscom", name: "Swisscom", category: "CH Telecom", slug: "swisscom", icon: "swisscom.ch", official: "https://www.swisscom.ch/de/privatkunden/hilfe/netz-und-service-status.html" }),
    crowd({ id: "sunrise", name: "Sunrise", category: "CH Telecom", slug: "sunrise", icon: "sunrise.ch", official: "https://www.sunrise.ch/de/support/aktuelle-stoerungen" }),
    crowd({ id: "salt", name: "Salt", category: "CH Telecom", slug: "salt", icon: "salt.ch", official: "https://www.salt.ch/de/outages/status/" }),
    crowd({ id: "init7", name: "Init7", category: "CH Telecom", slug: "init7", icon: "init7.net", official: "https://www.init7.net/de/support/faq/status-info/" }),

    // Microsoft 365 (Crowd + offizielle Statusseite als Quelle)
    crowd({ id: "m365", name: "Microsoft 365", category: "Microsoft 365", slug: "microsoft", icon: "microsoft.com", official: "https://status.cloud.microsoft/m365/" }),
    crowd({ id: "teams", name: "Microsoft Teams", category: "Microsoft 365", slug: "microsoft-teams", icon: "microsoft.com", official: "https://status.cloud.microsoft/m365/" }),

    // Cloud (offiziell)
    azure(),
    statuspage({ id: "cloudflare", name: "Cloudflare", category: "Cloud", base: "https://www.cloudflarestatus.com", icon: "cloudflare.com" }),
    statuspage({ id: "fortinet", name: "Fortinet", category: "Cloud", base: "https://status.forticloud.com", icon: "fortinet.com" }),
  ];

  const settled = await Promise.allSettled(jobs);
  const services = settled.map((s) =>
    s.status === "fulfilled" ? s.value : tile({ id: "err", name: "Quelle", category: "Cloud", status: "unknown", reason: String(s.reason) })
  );

  const overall = services.reduce((acc, s) => (RANK[s.status] > RANK[acc] ? s.status : acc), "operational");

  return new Response(JSON.stringify({ generated: new Date().toISOString(), overall, services }), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "public, max-age=20, s-maxage=60",
    },
  });
}
