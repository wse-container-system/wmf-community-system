"use strict";
/**
 * Rides reported by a city lead (WMF Dubai) through a share link: no sign-in, one short page.
 * The lead taps the ride type, checks the date, sets the number of riders and adds photos.
 * Entries count as rides in that city everywhere (dashboard, overview, reports).
 */
const crypto = require("crypto");
const multer = require("multer");
const QR = require("qrcode");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate, fmtTs, monLabel, nf } = require("./views");

const TYPES = ["Monday", "Thursday", "Weekend", "Special ride"];
const MAX_PHOTOS = 6, MAX_BYTES = 4 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: MAX_PHOTOS, fields: 10 } });
const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const rideName = (r) => (r.ride_type === "Special ride" ? r.title || "Special ride" : r.ride_type + " ride");
const IMG = /^image\/(jpeg|png|webp|heic|heif)$/;

async function linkOf(token) {
  return (await pool.query("SELECT * FROM lead_links WHERE token = $1 AND active", [String(token || "").slice(0, 60)])).rows[0] || null;
}

module.exports = function leadRides(app, { need, page, setFlash, actor, wrap, limit }) {
  const STAFF = need("admin", "coordinator");

  // ===================================================== the lead's page
  function leadPage(l, recent, flash) {
    const today = R.todayLocal(), y = require("./engine").helpers.addDays(today, -1);
    return `<section class="card lr-card">
      <h2>WMF ${h(l.city)} · ride report</h2><p class="lead">Hi ${h(l.label)}! Three taps after each ride. Thank you!</p>
      ${flash ? `<div class="flash ok" role="status">${h(flash)}</div>` : ""}
      <form id="lrForm" class="form" method="post" enctype="multipart/form-data">
        <fieldset class="rate"><legend>Which ride?</legend><div class="rate-row lr-types">${TYPES.map((t) => `<label><input type="radio" name="ride_type" value="${t}" required><span>${t}</span></label>`).join("")}</div></fieldset>
        <label id="lrTitle" hidden>Name of the special ride<input name="title" maxlength="80" placeholder="e.g. National Day Ride"></label>
        <fieldset class="rate"><legend>Date</legend><div class="rate-row lr-days">
          <label><input type="radio" name="day" value="${today}" checked><span>Today</span></label><label><input type="radio" name="day" value="${y}"><span>Yesterday</span></label>
          <label><input type="radio" name="day" value="other"><span>Other day</span></label></div>
          <input class="inp" type="date" name="ride_date" max="${today}" value="${today}" id="lrDate" hidden aria-label="Ride date"></fieldset>
        <fieldset class="rate"><legend>How many riders?</legend><div class="lr-count">
          <button type="button" class="btn" data-step="-1" aria-label="One less">−</button><input class="inp" type="number" name="participants" min="0" max="500" value="" inputmode="numeric" required aria-label="Number of riders" placeholder="0">
          <button type="button" class="btn" data-step="1" aria-label="One more">+</button></div></fieldset>
        <label>Photos <span class="hint">(optional, up to ${MAX_PHOTOS})</span><input type="file" name="photos" accept="image/*" multiple id="lrPhotos"></label>
        <div id="lrPreview" class="lr-prev"></div>
        <button class="btn primary big" id="lrSend">Send</button>
        <p class="hint" id="lrMsg" role="status"></p>
      </form></section>
      <section class="card lr-card"><h2>Sent from this link</h2>
        <ul class="log">${recent.map((r) => `<li><span><b>${h(rideName(r))}</b> · ${fmtDate(r.ride_date)}<br><span class="muted">${r.participants} rider${r.participants === 1 ? "" : "s"}${r.photos ? ` · ${r.photos} photo${r.photos === 1 ? "" : "s"}` : ""}</span></span>
          ${Date.now() - new Date(r.created_at).getTime() < 7 * 864e5 ? `<form method="post" action="?remove=${r.id}" style="margin:0"><button class="btn tblbtn" data-confirm="Remove this ride?">Remove</button></form>` : ""}</li>`).join("") || '<li class="muted">Nothing yet.</li>'}</ul>
        <p class="hint">Sent the same ride and date twice? The newest one replaces the first. Made a mistake? Remove it and send again.</p></section>`;
  }
  async function recentOf(l) {
    return (await pool.query(`SELECT r.*, (SELECT count(*)::int FROM lead_photos p WHERE p.ride_id = r.id) AS photos FROM lead_rides r WHERE r.link_id = $1 ORDER BY r.ride_date DESC, r.id DESC LIMIT 12`, [l.id])).rows;
  }
  const lpage = (req, l, body) => page(req, "Ride report", body, { wide: false, scripts: `<script src="/leadride.js"></script>` });

  app.get("/l/:token", wrap(async (req, res) => {
    const l = await linkOf(req.params.token);
    if (!l) return res.status(404).send(page(req, "Ride report", `<section class="card"><h2>This link is switched off</h2><p class="lead">Ask the WMF team for a new one.</p></section>`, { wide: false }));
    res.send(lpage(req, l, leadPage(l, await recentOf(l), req.query.ok ? "Sent. Thank you!" : req.query.removed ? "Removed." : "")));
  }));
  app.post("/l/:token", limit("leadride", 60, 60 * 60e3), (req, res, next) => upload.array("photos", MAX_PHOTOS)(req, res, (err) => {
    if (err) { req.uploadError = err.code === "LIMIT_FILE_SIZE" ? "A photo is too large (4 MB max)." : err.code === "LIMIT_FILE_COUNT" ? `Up to ${MAX_PHOTOS} photos at a time.` : "The photos couldn't be uploaded."; }
    next();
  }), wrap(async (req, res) => {
    const l = await linkOf(req.params.token);
    if (!l) return res.redirect("/l/" + encodeURIComponent(req.params.token));
    const back = "/l/" + encodeURIComponent(l.token);
    if (req.query.remove) {
      await tx(async (c) => {
        const r = (await c.query("DELETE FROM lead_rides WHERE id = $1 AND link_id = $2 AND created_at > now() - interval '7 days' RETURNING id, ride_type, ride_date, participants", [+req.query.remove || 0, l.id])).rows[0];
        if (r) await audit(c, "Lead link: " + l.label, "leadride.remove", "lead_ride", String(r.id), r, null);
      });
      return res.redirect(303, back + "?removed=1");
    }
    const b = req.body || {}, today = R.todayLocal();
    const type = TYPES.includes(b.ride_type) ? b.ride_type : null;
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.day || "") ? b.day : /^\d{4}-\d{2}-\d{2}$/.test(b.ride_date || "") ? b.ride_date : null;
    const n = /^\d{1,3}$/.test(String(b.participants || "").trim()) ? +b.participants : null;
    const err = req.uploadError || (!type ? "Choose the ride." : !date || date > today || date < "2024-01-01" ? "Check the date." : n == null ? "Enter the number of riders." : null);
    const files = (req.files || []).filter((f) => IMG.test(f.mimetype));
    if (err) return res.status(400).send(lpage(req, l, `<div class="flash err" role="alert">${h(err)}</div>` + leadPage(l, await recentOf(l))));
    const title = type === "Special ride" ? R.clean(b.title).slice(0, 80) || null : null;
    await tx(async (c) => {
      const ex = (await c.query("SELECT id FROM lead_rides WHERE link_id = $1 AND ride_type = $2 AND ride_date = $3 AND coalesce(title, '') = coalesce($4, '') FOR UPDATE", [l.id, type, date, title])).rows[0];
      let id;
      if (ex) { id = ex.id; await c.query("UPDATE lead_rides SET participants = $2, updated_at = now() WHERE id = $1", [id, n]); }
      else id = (await c.query("INSERT INTO lead_rides (link_id, city, ride_type, title, ride_date, participants, entered_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id", [l.id, l.city, type, title, date, n, "Lead link: " + l.label])).rows[0].id;
      for (const f of files) await c.query("INSERT INTO lead_photos (ride_id, mime, data, bytes) VALUES ($1,$2,$3,$4)", [id, f.mimetype, f.buffer, f.size]);
      await c.query("UPDATE lead_links SET last_used = now() WHERE id = $1", [l.id]);
      await audit(c, "Lead link: " + l.label, ex ? "leadride.update" : "leadride.create", "lead_ride", String(id), null, { type, title, date, participants: n, photos: files.length });
    });
    res.redirect(303, back + "?ok=1");
  }));

  // ===================================================== WMF team: the link, the rides and the photos
  app.get("/dubai", STAFF, wrap(async (req, res) => {
    const links = (await pool.query("SELECT * FROM lead_links ORDER BY active DESC, created_at DESC")).rows;
    const rides = (await pool.query(`SELECT r.*, l.label, coalesce(array_agg(p.id ORDER BY p.id) FILTER (WHERE p.id IS NOT NULL), '{}') AS photo_ids
      FROM lead_rides r LEFT JOIN lead_links l ON l.id = r.link_id LEFT JOIN lead_photos p ON p.ride_id = r.id
      WHERE r.city = 'Dubai' GROUP BY r.id, l.label ORDER BY r.ride_date DESC, r.id DESC LIMIT 300`)).rows;
    const months = new Map();
    for (const r of rides) { const m = String(r.ride_date).slice(0, 7); const x = months.get(m) || { rides: 0, people: 0, byType: {} }; x.rides++; x.people += r.participants; x.byType[r.ride_type] = (x.byType[r.ride_type] || 0) + r.participants; months.set(m, x); }
    const cards = await Promise.all(links.map(async (l) => {
      const url = `${baseOf(req)}/l/${l.token}`, img = l.active ? await QR.toDataURL(url, { margin: 1, width: 240 }) : null;
      const msg = `Hi ${l.label}! This is your WMF ${l.city} ride report link. After each ride, open it, tap the ride, the number of riders and add photos. Save it to your home screen: ${url}`;
      return `<div class="lr-link ${l.active ? "" : "off"}"><div><b>${h(l.label)}</b> · ${h(l.city)} ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}<br><span class="muted">Last used ${fmtTs(l.last_used)}</span>
        ${l.active ? `<div class="toolbar" style="margin:8px 0 0"><button class="btn primary" type="button" data-copy="${h(url)}">Copy link</button><a class="btn" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Send on WhatsApp</a><a class="btn" href="${h(url)}" target="_blank" rel="noopener">Open</a></div>` : ""}
        <form method="post" action="/dubai/links/${l.id}" style="margin-top:8px"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form></div>
        ${img ? `<img src="${img}" alt="QR code for the ride report link" width="110" height="110">` : ""}</div>`;
    }));
    res.send(page(req, "Dubai rides", `<div class="grid">
      <section class="card c5"><h2>Link for the Dubai lead</h2><p class="lead">One page, no sign-in: the lead taps the ride (Monday, Thursday, Weekend or a special ride), the date, the number of riders, and adds photos. The rides count as Dubai rides in the dashboard and reports.</p>
        ${cards.join("") || ""}
        <form class="inline-form" method="post" action="/dubai/links" style="margin-top:10px"><input class="inp" name="label" required maxlength="60" placeholder="Lead's name" style="flex:1 1 160px"><button class="btn ${links.length ? "" : "primary"}">Make a link</button></form></section>
      <section class="card c7"><h2>By month</h2><div class="tw"><table><thead><tr><th>Month</th><th class="n">Rides</th><th class="n">Riders</th><th class="n">Avg. per ride</th>${TYPES.map((t) => `<th class="n">${h(t)}</th>`).join("")}</tr></thead><tbody>
        ${[...months.entries()].map(([m, x]) => `<tr><td style="white-space:nowrap">${monLabel(m, true)}</td><td class="n">${x.rides}</td><td class="n">${nf(x.people)}</td><td class="n">${nf(Math.round(x.people / x.rides))}</td>${TYPES.map((t) => `<td class="n">${x.byType[t] ? nf(x.byType[t]) : "·"}</td>`).join("")}</tr>`).join("") || `<tr><td colspan="${4 + TYPES.length}" class="muted">No rides sent yet.</td></tr>`}
        </tbody></table></div><p class="hint">Riders by ride type are totals for the month.</p></section>
      <section class="card c12"><h2>Rides sent</h2><div class="tw"><table><thead><tr><th>Date</th><th>Ride</th><th class="n">Riders</th><th>Photos</th><th>Sent by</th><th></th></tr></thead><tbody>
        ${rides.map((r) => `<tr><td style="white-space:nowrap">${fmtDate(r.ride_date)}</td><td><b>${h(rideName(r))}</b></td>
          <td class="n"><form method="post" action="/dubai/rides/${r.id}" class="toolbar" style="margin:0;justify-content:flex-end"><input class="inp" type="number" min="0" max="500" name="participants" value="${r.participants}" style="width:80px;min-height:32px" aria-label="Riders"><button class="btn tblbtn">Save</button></form></td>
          <td><div class="lr-thumbs">${r.photo_ids.map((p) => `<a href="/dubai/photo/${p}" target="_blank" rel="noopener"><img src="/dubai/photo/${p}" alt="Ride photo" loading="lazy"></a>`).join("")}</div></td>
          <td class="muted">${h(r.label || r.entered_by || "")}</td>
          <td><form method="post" action="/dubai/rides/${r.id}/delete" style="margin:0"><button class="btn tblbtn danger" data-confirm="Delete this ride and its photos?">Delete</button></form></td></tr>`).join("") || `<tr><td colspan="6" class="muted">Nothing yet.</td></tr>`}
        </tbody></table></div></section></div>`, { active: "/wmf/rides" }));
  }));
  app.post("/dubai/links", STAFF, wrap(async (req, res) => {
    const label = R.clean(req.body.label).slice(0, 60);
    if (!label) return res.redirect("/dubai");
    await pool.query("INSERT INTO lead_links (token, label, city, created_by) VALUES ($1,$2,'Dubai',$3)", [crypto.randomBytes(12).toString("base64url"), label, actor(req)]);
    await audit(pool, actor(req), "leadlink.create", "lead_link", label, null, { city: "Dubai" });
    setFlash(req, "ok", `Link made for ${label}. Send it on WhatsApp.`); res.redirect("/dubai");
  }));
  app.post("/dubai/links/:id", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE lead_links SET active = $2 WHERE id = $1", [+req.params.id || 0, req.body.active === "1"]);
    res.redirect("/dubai");
  }));
  app.post("/dubai/rides/:id", STAFF, wrap(async (req, res) => {
    const n = /^\d{1,3}$/.test(String(req.body.participants || "")) ? +req.body.participants : null;
    if (n != null) await pool.query("UPDATE lead_rides SET participants = $2, updated_at = now() WHERE id = $1", [+req.params.id || 0, n]);
    setFlash(req, "ok", "Saved."); res.redirect("/dubai");
  }));
  app.post("/dubai/rides/:id/delete", STAFF, wrap(async (req, res) => {
    await tx(async (c) => { const r = (await c.query("DELETE FROM lead_rides WHERE id = $1 RETURNING id, ride_type, ride_date, participants", [+req.params.id || 0])).rows[0]; if (r) await audit(c, actor(req), "leadride.delete", "lead_ride", String(r.id), r, null); });
    setFlash(req, "ok", "Deleted."); res.redirect("/dubai");
  }));
  app.get("/dubai/photo/:id", STAFF, wrap(async (req, res) => {
    const p = (await pool.query("SELECT mime, data FROM lead_photos WHERE id = $1", [+req.params.id || 0])).rows[0];
    if (!p) return res.status(404).end();
    res.type(p.mime).set("Cache-Control", "private, max-age=86400").send(p.data);
  }));
};
