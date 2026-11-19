"use strict";
/**
 * Race watch: reads external race listing pages once a day, keeps the upcoming cycling and triathlon races,
 * puts new ones on the WMF calendar as "External race" (Tentative) and emails a list of what's new.
 *
 * Pages are set on /calendar/races (staff). A page can give its races as schema.org Event data (JSON-LD, which most
 * event and ticketing sites publish for Google) or as an .ics calendar feed. Sites that give neither get their own
 * reader in ADAPTERS, keyed by host name.
 *
 * No setup needed: whenever the app is awake (any visit), it checks again if the last check was over 20 hours ago.
 * The daily GitHub Action (.github/workflows/race-watch.yml) wakes the app and also posts the new races on a GitHub
 * issue, so GitHub notifies Rona by email and in its app. Email from the app is extra, only when SMTP is set.
 * POST /api/race-watch/run (with RACE_WATCH_TOKEN) runs a check on demand.
 */
const crypto = require("crypto");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const mailer = require("./mailer");
const { h, fmtDate } = require("./views");

const S = require("./racesources");
const { DEFAULT_SOURCES } = S;

/* ---------- settings ---------- */

async function getConfig(c) {
  const r = (await (c || pool).query("SELECT value FROM settings WHERE key = 'raceWatch'")).rows[0];
  const v = (r && r.value) || {};
  return { sources: Array.isArray(v.sources) ? v.sources : DEFAULT_SOURCES, notify: v.notify || "", lastRun: v.lastRun || null };
}
async function saveConfig(c, cfg) {
  await c.query("INSERT INTO settings (key, value) VALUES ('raceWatch', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(cfg)]);
}
const notifyTo = (cfg) => cfg.notify || process.env.RACE_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || "";

/* ---------- the run ---------- */

/**
 * Check every page, add the new upcoming races, email the list. Returns { added, checked, errors }.
 * `load` replaces fetchPage in tests.
 */
async function run({ actor = "race-watch", load = S.fetchPage, notify = true } = {}) {
  const cfg = await getConfig();
  const { races, errors } = await S.collect(cfg.sources, { load, today: R.todayLocal() });
  const found = { size: races.length };
  const added = await tx(async (c) => {
    const out = [];
    for (const r of races) {
      const seen = await c.query("INSERT INTO race_watch_seen (key, source, title, start_date) VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING RETURNING key", [r.key, r.source, r.title, r.date]);
      if (!seen.rows[0]) continue; // already found before (even if staff deleted it from the calendar since)
      const end = r.end && r.end >= r.date ? r.end : r.date;
      const id = (await c.query(`INSERT INTO calendar_items (title, category, start_date, end_date, start_time, location, status, url)
        VALUES ($1,'external_race',$2,$3,$4,$5,'Tentative',$6) RETURNING id`, [r.title.slice(0, 140), r.date, end, r.time, (r.location || "").slice(0, 120) || null, r.url || null])).rows[0].id;
      await c.query("UPDATE race_watch_seen SET calendar_item_id = $2 WHERE key = $1", [r.key, id]);
      await audit(c, actor, "calendar.create", "calendar", String(id), null, { from: "race-watch", source: r.source, title: r.title, date: r.date });
      out.push({ ...r, end, id });
    }
    await saveConfig(c, { ...(await getConfig(c)), lastRun: { at: new Date().toISOString(), checked: cfg.sources.length, matched: found.size, added: out.length, errors } });
    return out;
  });
  let emailed = false;
  if (notify && added.length && notifyTo(cfg)) {
    try { emailed = await mailer.send({ to: notifyTo(cfg), ...email(added) }); } catch (e) { errors.push({ url: "email", error: String(e.message || e).slice(0, 200) }); }
  }
  return { checked: cfg.sources.length, matched: found.size, added, errors, emailed };
}

/** Run a check in the background when the last one is over 20 hours old. Looks at the database at most every 10 minutes. */
let looked = 0, running = null;
function maybeRun() {
  if (running || Date.now() - looked < 10 * 60 * 1000) return running;
  looked = Date.now();
  running = (async () => {
    const cfg = await getConfig();
    if (cfg.lastRun && Date.now() - new Date(cfg.lastRun.at).getTime() < 20 * 3600 * 1000) return null;
    const r = await run();
    console.log(`Race watch: ${r.added.length} new race(s) added, ${r.errors.length} page(s) could not be read.`);
    return r;
  })().catch((e) => console.error("Race watch failed:", e.message)).finally(() => { running = null; });
  return running;
}

function email(added) {
  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const line = (r) => `${fmtDate(r.date)}${r.end !== r.date ? " – " + fmtDate(r.end) : ""}: ${r.title}${r.location ? " (" + r.location + ")" : ""}${r.url ? "\n  " + r.url : ""}`;
  const subject = `${added.length} new race${added.length > 1 ? "s" : ""} added to the WMF calendar`;
  const text = `New cycling and triathlon races were found and added to the WMF calendar as Tentative:\n\n${added.map(line).join("\n")}\n\n` +
    `Check them, then confirm, edit or delete each one${base ? ` at ${base}/calendar/races` : " on Calendar → Race watch"}.`;
  const html = `<p>New cycling and triathlon races were found and added to the WMF calendar as <b>Tentative</b>:</p><ul>${added.map((r) =>
    `<li><b>${h(fmtDate(r.date))}${r.end !== r.date ? " – " + h(fmtDate(r.end)) : ""}</b>: ${r.url ? `<a href="${h(r.url)}">${h(r.title)}</a>` : h(r.title)}${r.location ? ` · ${h(r.location)}` : ""}</li>`).join("")}</ul>
    <p>Check them, then confirm, edit or delete each one${base ? ` on <a href="${h(base)}/calendar/races">Race watch</a>` : " on Calendar → Race watch"}.</p>`;
  return { subject, text, html };
}

/* ---------- routes ---------- */

const tokenOk = (req) => {
  const t = process.env.RACE_WATCH_TOKEN, k = String(req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  return !!t && t.length >= 16 && k.length === t.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(t));
};

function routes(app, { need, page, setFlash, actor, wrap }) {
  const STAFF = need("admin", "coordinator");

  // the daily run (GitHub Action); token-protected, no sign-in
  app.post("/api/race-watch/run", wrap(async (req, res) => {
    if (!tokenOk(req)) return res.status(401).json({ error: "Bad or missing token." });
    const r = await run();
    res.set("Cache-Control", "no-store").json({ checked: r.checked, matched: r.matched, added: r.added.map((x) => ({ title: x.title, date: x.date, id: x.id })), errors: r.errors, emailed: r.emailed });
  }));

  app.get("/calendar/races", STAFF, wrap(async (req, res) => {
    const cfg = await getConfig(), lr = cfg.lastRun;
    const rows = (await pool.query(`SELECT s.*, ci.id AS item, ci.status, ci.title AS cal_title FROM race_watch_seen s LEFT JOIN calendar_items ci ON ci.id = s.calendar_item_id
      WHERE s.start_date >= $1::date - 7 ORDER BY s.start_date, s.title LIMIT 300`, [R.todayLocal()])).rows;
    const when = (iso) => new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dubai", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    res.send(page(req, "Race watch", `<section class="card">
      <div class="card-head"><div><h2>Race watch</h2><p class="lead">Every morning the app reads these pages, finds upcoming cycling and triathlon races and adds new ones to the calendar as <b>External race · Tentative</b>, then lets you know. Confirm, edit or delete them like any other entry.</p></div>
        <form method="post" action="/calendar/races/run"><button class="btn primary">Check now</button></form></div>
      <p class="muted" style="font-size:13px">${lr ? `Last check ${h(when(lr.at))} Dubai time: ${lr.checked} page${lr.checked === 1 ? "" : "s"}, ${lr.matched} upcoming race${lr.matched === 1 ? "" : "s"} listed, ${lr.added} new.` : "Not checked yet."}
        
        ${mailer.configured() ? "" : " · New races are posted on the <i>Race watch</i> issue on GitHub, which notifies you by email and in the GitHub app."}</p>
      ${lr && lr.errors && lr.errors.length ? `<div class="flash err">${lr.errors.map((e) => `Could not read ${h(e.url)}: ${h(e.error)}`).join("<br>")}</div>` : ""}
      <form class="form" method="post" action="/calendar/races/settings">
        <label>Pages to watch <span class="hint">(one link per line: a race listing page or an .ics calendar link)</span><textarea name="sources" rows="4" style="width:100%">${h(cfg.sources.join("\n"))}</textarea></label>
        <label>Email new races to <span class="hint">(blank = ${h(process.env.RACE_NOTIFY_EMAIL || process.env.ADMIN_EMAIL || "the admin email")})</span><input type="email" name="notify" maxlength="200" value="${h(cfg.notify)}"></label>
        <div><button class="btn">Save</button></div></form></section>
      <section class="card"><h2>Races found</h2>
      <div class="tw"><table><thead><tr><th>Date</th><th>Race</th><th>On the calendar</th><th>Found</th></tr></thead><tbody>
      ${rows.map((x) => `<tr><td>${fmtDate(x.start_date)}</td><td><b>${h(x.title)}</b><br><span class="muted" style="font-size:12px">${h(x.source)}</span></td>
        <td>${x.item ? `<a href="/calendar/items/${x.item}">${h(x.status)}</a>` : `<span class="muted">Deleted (won't be added again)</span>`}</td><td>${h(when(x.seen_at))}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No races found yet.</td></tr>`}
      </tbody></table></div></section>`, { active: "/calendar" }));
  }));

  app.post("/calendar/races/settings", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, bad = [];
    const sources = [...new Set(String(b.sources || "").split(/\s+/).filter(Boolean))].filter((u) => { try { const x = new URL(u); if (x.protocol === "https:" || x.protocol === "http:") return true; } catch (e) { /* not a link */ } bad.push(u); return false; }).slice(0, 20);
    const notify = R.clean(b.notify || "");
    if (notify && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(notify)) { setFlash(req, "err", "Check the email address."); return res.redirect("/calendar/races"); }
    await tx(async (c) => { const cfg = await getConfig(c); await saveConfig(c, { ...cfg, sources, notify }); await audit(c, actor(req), "raceWatch.settings", "settings", "raceWatch", { sources: cfg.sources, notify: cfg.notify }, { sources, notify }); });
    setFlash(req, bad.length ? "err" : "ok", bad.length ? `Saved, but these aren't links and were left out: ${bad.join(", ")}` : "Saved.");
    res.redirect("/calendar/races");
  }));

  app.post("/calendar/races/run", STAFF, wrap(async (req, res) => {
    const r = await run({ actor: actor(req) });
    const msg = !r.checked ? "Add a page to watch first." : `${r.added.length ? `${r.added.length} new race${r.added.length > 1 ? "s" : ""} added to the calendar` : "No new races"}${r.added.length && r.emailed ? " and emailed" : ""}.${r.errors.length ? ` ${r.errors.length} page${r.errors.length > 1 ? "s" : ""} could not be read.` : ""}`;
    setFlash(req, r.errors.length || !r.checked ? "err" : "ok", msg);
    res.redirect("/calendar/races");
  }));
}

module.exports = routes;
Object.assign(module.exports, S, { run, getConfig, maybeRun });
