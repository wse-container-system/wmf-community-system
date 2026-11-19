"use strict";
/**
 * Reading race listing pages: the site readers, the UAE cycling/triathlon filter and collect(), which turns a list of
 * pages into upcoming races. No database here, so the GitHub Action (scripts/race-watch-notify.js) can use it too.
 */
const crypto = require("crypto");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// what counts as a cycling or triathlon race (title, sport and description are checked)
const SPORT_RE = /\b(cycl\w*|bike|biking|bicycle|velo|v[ée]lo|gran\s?fondo|granfondo|criterium|crit|sportive|time\s?trial|mtb|mountain\s?bik\w*|gravel|road\s?race|tri(athlon)?s?|duathlon|aquabike|ironman|70\.3|t100|swim\s?bike\s?run|ride|cycle|cyclists?|uae\s?tour|tour\s?de|l['’]?[ée]tape)\b/i;
// clearly not ours even if they mention a bike (e.g. "bike parking available")
const NOT_RE = /\b(marathon|half\s?marathon|10k|5k|fun\s?run|padel|tennis|football|swim\s?only|open\s?water\s?swim|obstacle|spartan|yoga|concert)\b/i;

/* ---------- reading pages ---------- */

const clean = (s) => String(s == null ? "" : s).replace(/<[^>]*>/g, " ").replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCodePoint(parseInt(x, 16))).replace(/&#(\d+);/g, (_, x) => String.fromCodePoint(+x)).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/** "2026-12-06T06:00:00+04:00" → { date: "2026-12-06", time: "06:00" } in Dubai time. */
function dubai(v) {
  if (!v) return {};
  const s = String(v).trim();
  if (DATE_RE.test(s)) return { date: s };
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})\d{0,2}(Z)?)?$/.exec(s); // ICS form
  const iso = m ? `${m[1]}-${m[2]}-${m[3]}${m[4] ? `T${m[4]}:${m[5]}:00${m[6] ? "Z" : ""}` : ""}` : s;
  if (DATE_RE.test(iso)) return { date: iso };
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  if (!hasZone && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) return { date: iso.slice(0, 10), time: iso.slice(11, 16) === "00:00" ? null : iso.slice(11, 16) };
  const d = new Date(iso);
  if (isNaN(d)) return {};
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(d).map((x) => [x.type, x.value]));
  const time = `${p.hour}:${p.minute}`;
  return { date: `${p.year}-${p.month}-${p.day}`, time: time === "00:00" ? null : time };
}

function placeText(loc) {
  if (!loc) return "";
  if (typeof loc === "string") return clean(loc);
  if (Array.isArray(loc)) return placeText(loc[0]);
  const a = loc.address;
  const addr = !a ? "" : typeof a === "string" ? a : [a.addressLocality, a.addressRegion].filter(Boolean).join(", ");
  return clean([loc.name, addr].filter(Boolean).join(", "));
}

/** schema.org Event objects anywhere in a JSON-LD block (arrays, @graph, ItemList). */
function walkLd(node, out) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { node.forEach((n) => walkLd(n, out)); return; }
  const types = [].concat(node["@type"] || []).map(String);
  if (types.some((t) => /Event$/.test(t))) out.push(node);
  for (const k of ["@graph", "itemListElement", "item", "subEvent", "event", "events"]) if (node[k]) walkLd(node[k], out);
}
function fromJsonLd(html, pageUrl) {
  const found = [];
  for (const m of String(html).matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walkLd(JSON.parse(m[1].trim()), found); } catch (e) { /* a broken block on their page: skip it */ }
  }
  return found.map((e) => {
    const s = dubai(e.startDate), en = dubai(e.endDate);
    let url = e.url || (e.offers && [].concat(e.offers)[0] && [].concat(e.offers)[0].url) || "";
    try { url = url ? new URL(url, pageUrl).href : ""; } catch (x) { url = ""; }
    const addr = e.location && !Array.isArray(e.location) && e.location.address, country = addr && typeof addr === "object" ? [].concat(addr.addressCountry || [])[0] : null;
    return { title: clean(e.name), date: s.date, time: s.time || null, end: en.date || null, location: placeText(e.location), country: country ? clean(country.name || country) : null,
      url, text: clean([e.sport, e.description, [].concat(e.keywords || []).join(" ")].filter(Boolean).join(" ")).slice(0, 600) };
  });
}
function fromIcs(text, pageUrl) {
  const lines = String(text).replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const out = []; let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT") { if (cur) out.push(cur); cur = null; }
    else if (cur) { const i = line.indexOf(":"); if (i > 0) cur[line.slice(0, i).split(";")[0].toUpperCase()] = line.slice(i + 1).replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1"); }
  }
  return out.map((e) => {
    const s = dubai(e.DTSTART), en = dubai(e.DTEND);
    // an all-day ICS event ends the day after
    let end = en.date || null;
    if (end && /^\d{8}$/.test(e.DTEND || "")) { const d = new Date(end + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); end = d.toISOString().slice(0, 10); }
    return { title: clean(e.SUMMARY), date: s.date, time: s.time || null, end, location: clean(e.LOCATION), url: e.URL || pageUrl,
      text: clean([e.CATEGORIES, e.DESCRIPTION].filter(Boolean).join(" ")).slice(0, 600) };
  });
}

/* ---------- site readers (UAE race listings that publish neither JSON-LD nor ICS) ---------- */

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
/** "22.11.2026" or "Sat. 21 Nov. 2026" or "28 Nov 2026" → "2026-11-22" */
function dateText(s) {
  s = clean(s);
  let m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(s); if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  m = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})/.exec(s); if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return null;
}
const pick = (b, re) => clean((re.exec(b) || [])[1] || "");
/** "AL AIN" → "Al Ain" (places some sites write in capitals) */
const tidyPlace = (s) => (/[a-z]/.test(s) ? s : s.toLowerCase().replace(/(^|[\s(-])\w/g, (c) => c.toUpperCase()));

/**
 * host → { url(pageUrl, today) to fetch instead of the page (optional), parse(body, pageUrl) → races }.
 * Each race: { title, date, end, time, location, country ("AE" when known), url, text (sport words) }.
 */
const ADAPTERS = {
  // RaceResult: the events page loads its list from a JSON API; 784 = United Arab Emirates
  "my.raceresult.com": {
    url: (u, today) => { const y = new Date(today + "T12:00:00Z"); y.setUTCFullYear(y.getUTCFullYear() + 1);
      return `https://my.raceresult.com/RREvents/list?group=0&user=0&userID=0&lang=en&country=784&dateFrom=${today}&dateTo=${y.toISOString().slice(0, 10)}&limit=500`; },
    parse: (body) => [].concat(...JSON.parse(body).map((g) => g.Events || [])).map((e) => ({
      title: clean(e.name), date: e.dateFrom, end: e.dateTo || null, time: null, location: tidyPlace(clean([e.location, e.region].filter(Boolean).join(", "))),
      country: e.countryCode || null, url: `https://my.raceresult.com/${e.id}/`, text: clean(`${e.eventTypeName || ""} ${e.distances || ""}`) })),
  },
  // Premier Online: the home page lists every upcoming event as a card (city, date, title, sport)
  "premieronline.com": {
    parse: (html) => [...String(html).matchAll(/<a href="([^"]+\/event\/[^"]+)" class="uk-card[^"]*\bevent">([\s\S]*?)<\/a>/g)].map(([, url, b]) => {
      const when = pick(b, /class="date">([\s\S]*?)<\/span>/), place = pick(b, /counrty-name">([\s\S]*?)<\/span>/), ds = when.split(/\s+-\s+/);
      return { title: pick(b, /uk-card-title[^>]*>([\s\S]*?)<\/h3>/), date: dateText(ds[0]), end: ds[1] ? dateText(ds[1]) : null, time: null,
        location: place.replace(/,\s*UAE$/i, ""), country: /,\s*UAE$/i.test(place) ? "AE" : place ? "other" : null, url, text: pick(b, /uk-card-btn">([\s\S]*?)<\/span>/) };
    }),
  },
  // Hopasports (same events as Premier Online, plus some of its own): the next 20 events
  "hopasports.com": {
    parse: (html) => [...String(html).matchAll(/<li\s+class="relative p-4[\s\S]*?<\/li>/g)].map(([b]) => {
      const t = clean(b.replace(/<!--[\s\S]*?-->/g, "").replace(/<svg[\s\S]*?<\/svg>/g, ""));
      const a = /<h3[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(b) || [];
      const dm = /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\.\s+\d{1,2}\s+[A-Za-z]{3}\.?\s+\d{4}/.exec(t), place = /((?:[A-Z][A-Za-z']*\s?){1,3}),\s+([A-Z]{2})\s+(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\./.exec(t);
      return { title: clean(a[2]), date: dm ? dateText(dm[0]) : null, end: null, time: null, location: place ? place[1].trim() : "",
        country: place ? place[2] : null, url: a[1] || "", text: t.slice(0, 600) };
    }),
  },
  // Abu Dhabi Sports Council events (all in Abu Dhabi), newest first
  "adsc.ae": {
    parse: (html, pageUrl) => [...String(html).matchAll(/<div class="event-item[^"]*"[\s\S]*?href="([^"]+)"[\s\S]*?<h3>([\s\S]*?)<\/h3>[\s\S]*?When\s*<span>([\s\S]*?)<\/span>[\s\S]*?Where\s*<span>([\s\S]*?)<\/span>/g)].map(([, href, title, when, where]) => {
      const w = clean(when), m = /^(\d{1,2})\s+([A-Za-z]{3})(?:\s+(\d{4}))?\s*-\s*(.+)$/.exec(w), end = m ? dateText(m[4]) : null;
      const start = m ? dateText(`${m[1]} ${m[2]} ${m[3] || end.slice(0, 4)}`) : dateText(w);
      let url = ""; try { url = new URL(href, pageUrl).href; } catch (e) { /* bad link */ }
      return { title: clean(title), date: start, end, time: null, location: tidyPlace(clean(where)), country: "AE", url, text: "" };
    }),
  },
};
const adapterFor = (pageUrl) => { try { const host = new URL(pageUrl).hostname.replace(/^www\./, ""); return ADAPTERS[host] || null; } catch (e) { return null; } };

function parse(body, pageUrl) {
  if (/^\s*BEGIN:VCALENDAR/.test(body)) return fromIcs(body, pageUrl);
  const a = adapterFor(pageUrl);
  return a ? a.parse(body, pageUrl) : fromJsonLd(body, pageUrl);
}

/** Only races in the UAE. A race whose page names no country is kept (most listings we read are UAE-only). */
const UAE_RE = /\b(uae|united arab emirates|emirates|dubai|abu dhabi|sharjah|ajman|fujairah|ras al khaimah|rak|umm al quwain|al ain|hatta|al dhafra|khor ?fakkan)\b/i;
const inUae = (r) => (r.country ? /^(AE|ARE|UAE|United Arab Emirates)$/i.test(r.country) : true) || UAE_RE.test(r.location || "");

const isOurSport = (r) => { const all = `${r.title} ${r.text || ""}`; return SPORT_RE.test(all) && !(NOT_RE.test(r.title) && !SPORT_RE.test(r.title)); };
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
/** One race = same name on the same start date, whichever page it came from. */
const keyOf = (r) => crypto.createHash("sha1").update(`${norm(r.title)}|${r.date}`).digest("hex").slice(0, 20);

async function fetchPage(url) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 20000);
  try {
    const r = await fetch(url, { signal: ctl.signal, redirect: "follow", headers: { "user-agent": "Mozilla/5.0 (compatible; WMF-calendar-race-watch/1.0)", accept: "text/html,text/calendar,*/*" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.text()).slice(0, 5_000_000);
  } finally { clearTimeout(t); }
}

// the pages watched until staff change the list (Rona's two, plus the Abu Dhabi Sports Council and Hopasports listings)
const DEFAULT_SOURCES = ["https://my.raceresult.com/events/", "https://www.premieronline.com/", "https://adsc.ae/events", "https://www.hopasports.com/en/events"];

const todayDubai = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Dubai" });

/** Read every page; returns { races (upcoming UAE cycling/triathlon, one per race, by date), errors }. */
async function collect(sources, { load = fetchPage, today = todayDubai() } = {}) {
  const errors = [], found = new Map();
  for (const url of sources) {
    try {
      const a = adapterFor(url);
      for (const r of parse(await load(a && a.url ? a.url(url, today) : url), url)) {
        if (!r.title || !DATE_RE.test(r.date || "") || (r.end || r.date) < today || !isOurSport(r) || !inUae(r)) continue;
        const k = keyOf(r); if (!found.has(k)) found.set(k, { ...r, key: k, source: url });
      }
    } catch (e) { errors.push({ url, error: String(e.message || e).slice(0, 200) }); }
  }
  const races = [...found.values()].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.title < y.title ? -1 : 1));
  return { races, errors };
}

module.exports = { collect, parse, fromJsonLd, fromIcs, isOurSport, inUae, keyOf, dubai, dateText, fetchPage, ADAPTERS, DEFAULT_SOURCES };
