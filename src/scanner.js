"use strict";
/**
 * Shareable scanner links: one simple page, no sign-in and no hub menus, for any staff member taking attendance.
 * An administrator makes a link per person or phone (Admin → Scanner links) and can switch it off at any time.
 * A link can only record check-ins: it shows no member lists or contact details, only the name of the person just scanned.
 */
const crypto = require("crypto");
const QRCode = require("qrcode");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const { h, fmtDate, fmtTs } = require("./views");

const SCOPES = { both: "WMF and Corporate", wmf: "WMF only", corporate: "Corporate only" };
const WEEKDAY_DEFAULT = { Monday: "RIDE-MONDAY-MADNESS", Wednesday: "RIDE-WEDNESDAY-SOCIAL", Saturday: "RIDE-WEEKEND-LONG", Sunday: "RIDE-WEEKEND-LONG" };
const newToken = () => crypto.randomBytes(12).toString("base64url");
/** Typed WMF IDs: "WMF-000123", "wmf 123" or just "123". */
const wmfIdFromText = (t) => R.memberIdFromScan(t) || (/^\s*(?:wmf[\s-]*)?(\d{1,6})\s*$/i.exec(String(t || "")) ? "WMF-" + /(\d{1,6})\s*$/.exec(String(t))[1].padStart(6, "0") : null);

async function linkByToken(t) {
  return (await pool.query("SELECT * FROM scanner_links WHERE token = $1 AND active", [String(t || "")])).rows[0];
}

function shell(title, body, { scripts = "", manifest = "" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${h(title)}</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@87,500;87,600;87,700&family=Source+Sans+3:wght@400;600&display=swap">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/hub.css">
<link rel="icon" type="image/png" href="/brand/favicon.png"><link rel="apple-touch-icon" href="/brand/apple-touch-icon.png"><meta name="theme-color" content="#4d5ac2">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Scanner">
${manifest ? `<link rel="manifest" href="${manifest}">` : ""}
</head><body class="scanner-app"><main id="main" class="sc-wrap">${body}</main>${scripts}</body></html>`;
}

module.exports = function scanner(app, { need, page, setFlash, actor, wrap, limit, checkIn, rideActivities, scanReply, calendar, qrSend, qrDataUrl }) {
  const A = need("admin");
  const linkUrl = (req, l) => `${req.protocol}://${req.get("host")}/s/${l.token}`;

  // ===================================================== the scanner page (no sign-in)
  app.get("/s/:token", wrap(async (req, res) => {
    const l = await linkByToken(req.params.token);
    if (!l) return res.status(404).send(shell("Scanner", `<section class="card sc-off"><h1>This scanner link is switched off</h1><p class="lead">Ask the Cycling Development team for a new link.</p></section>`));
    const today = R.todayLocal(), wd = R.weekdayOf(today);
    const showW = l.scope !== "corporate", showC = l.scope !== "wmf";
    let wmf = "", corp = "";
    if (showW) {
      const acts = await rideActivities();
      const onCal = await calendar.ridesOn(today).catch(() => []);
      const defId = (onCal[0] && onCal[0].slot) || WEEKDAY_DEFAULT[wd] || "RIDE-MORNING";
      wmf = `<label class="sc-field"><span>WMF ride today</span><select id="wmfRide" class="inp">${acts.map((a) => `<option value="${h(a.activity_id)}" ${a.activity_id === defId ? "selected" : ""}>${h(a.name)}</option>`).join("")}</select></label>
        ${onCal.length ? `<p class="sc-note">On the calendar today: ${onCal.map((o) => `${o.time ? h(o.time) + " " : ""}${h(o.title)}`).join(" · ")}</p>` : ""}`;
    }
    if (showC) {
      const opts = [["ride:AUTO", "Today's session (any company)"]];
      for (const co of await C.companies()) {
        const ss = await C.todaysSessions(pool, co);
        for (const s of ss) opts.push([C.sessionValue(s), `${co.name} · ${C.sessionName(s, co)}${s.start_time ? " · " + s.start_time : ""}`]);
      }
      corp = `<label class="sc-field"><span>Corporate session</span><select id="corpSession" class="inp">${opts.map(([v, t], i) => `<option value="${h(v)}" ${i === 0 ? "selected" : ""}>${h(t)}</option>`).join("")}</select></label>
        <p class="sc-note">Leave it on “Today's session”: each person goes into their own company's session for today. Pick a session from the list only when a company has two sessions on the same day.</p>`;
    }
    await pool.query("UPDATE scanner_links SET last_opened = now() WHERE id = $1", [l.id]);
    res.set("Cache-Control", "no-store").send(shell("Attendance scanner", `
      <header class="sc-top"><span class="cd-mark" aria-hidden="true"><svg viewBox="0 0 40 40" width="30" height="30"><circle cx="11" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="29" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11 26 L18 13 L26 13 M18 13 L23 26 L29 26 M24 9 h5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
        <div><h1>Attendance scanner</h1><p>${h(l.label)} · ${fmtDate(today)}</p></div></header>
      ${showW && showC ? `<div class="sc-tabs" role="tablist" aria-label="Programme"><button role="tab" data-mode="wmf" aria-selected="true">WMF</button><button role="tab" data-mode="corp" aria-selected="false">Corporate</button></div>` : ""}
      <section class="card sc-card" data-token="${h(l.token)}" data-default="${showW ? "wmf" : "corp"}">
        <div data-panel="wmf" ${showW ? "" : "hidden"}>${wmf}</div>
        <div data-panel="corp" ${showW ? "hidden" : ""}>${corp}</div>
        <div id="reader" class="sc-reader" aria-label="Camera"></div>
        <button class="btn primary big sc-go" id="start">Start scanning</button>
        <button class="btn big sc-go" id="stop" hidden>Stop camera</button>
        <label class="btn big sc-go sc-photo" for="photo">Camera won't open? Take a photo of the code</label>
        <input type="file" id="photo" accept="image/*" capture="environment" hidden>
        <div id="photoReader" hidden></div>
        <div id="result" class="scan-result" hidden aria-live="assertive"></div>
        <p class="sc-note" id="queue" hidden></p>
      </section>
      <section class="card sc-card"><h2>No QR code?</h2>
        <p class="sc-note"><span data-panel="wmf" ${showW ? "" : "hidden"}>Search their name, email or phone, or type their Member ID.</span><span data-panel="corp" ${showW ? "hidden" : ""}>Type their ID, e.g. NMDC-0012 or nmdc 12.</span></p>
        <form id="byId" class="sc-row"><input class="inp" id="idInput" placeholder="Name, email, phone or ID" autocomplete="off" aria-label="Name, email, phone or ID"><button class="btn primary">Go</button></form>
        <ul class="log sc-hits" id="hits"></ul></section>
      ${showW ? `<section class="card sc-card" data-panel="wmf"><details id="newRider"><summary><h2 style="display:inline">New rider? Register</h2></summary>
        <form id="walkin" class="form" style="margin-top:10px">
          <label>Full name<input name="full_name" required maxlength="120" autocomplete="off"></label>
          <label>Mobile<input name="mobile" required maxlength="30" inputmode="tel" autocomplete="off" placeholder="05x xxx xxxx"></label>
          <label>Email<input name="email" type="email" maxlength="160" autocomplete="off"></label>
          <div class="row2"><label>Gender<select name="gender"><option value="">—</option><option>Female</option><option>Male</option></select></label>
            <label>City<select name="city"><option>Abu Dhabi</option><option>Dubai</option></select></label></div>
          <label class="check"><input type="checkbox" name="waiver_consent" value="1" required> <span>The rider accepts the WMF waiver (rides at own risk, follows the ride leader's instructions and road safety rules)</span></label>
          <button class="btn primary big">Register and check in</button></form>
        <div id="newDone" hidden></div></details></section>` : ""}
      <section class="card sc-card"><div class="sc-count"><h2>Checked in on this phone</h2><b id="count">0</b></div><ul class="log" id="log"><li class="muted">Nobody yet.</li></ul></section>
      <p class="sc-foot">Tip: add this page to your home screen. Cycling Development · Powered by Aurora</p>`,
    { manifest: `/s/${encodeURIComponent(l.token)}/manifest.webmanifest`, scripts: `<script src="/ui.js"></script><script src="/vendor/html5-qrcode.min.js"></script><script src="/camhelp.js"></script><script src="/scanner.js"></script>` }));
  }));
  app.get("/s/:token/manifest.webmanifest", wrap(async (req, res) => {
    const l = await linkByToken(req.params.token); if (!l) return res.status(404).end();
    res.type("application/manifest+json").send(JSON.stringify({ name: "Attendance scanner", short_name: "Scanner", start_url: `/s/${l.token}`, scope: `/s/${l.token}`, display: "standalone", background_color: "#f7f6fb", theme_color: "#4d5ac2",
      icons: [{ src: "/brand/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] }));
  }));

  // ----- WMF: find a member who has no QR code with them (shows only names and a hint, never full contact details)
  app.post("/s/:token/find", limit("scanfind", 240, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkByToken(req.params.token);
    if (!l || l.scope === "corporate") return res.status(403).json([]);
    const q = R.clean((req.body || {}).q).slice(0, 60);
    if (q.length < 3) return res.json([]);
    const like = "%" + q.replace(/[%_]/g, "") + "%", digits = q.replace(/\D/g, "");
    const r = await pool.query(`SELECT member_id, full_name, primary_email, mobile FROM members WHERE merged_into IS NULL
      AND (full_name ILIKE $1 OR primary_email ILIKE $1 OR member_id ILIKE $1 ${digits.length >= 4 ? "OR regexp_replace(coalesce(mobile, ''), '\\D', '', 'g') LIKE $2" : ""}) ORDER BY full_name LIMIT 6`, digits.length >= 4 ? [like, "%" + digits + "%"] : [like]);
    res.json(r.rows.map((m) => ({ id: m.member_id, name: m.full_name, hint: [m.primary_email ? R.maskEmail(m.primary_email) : "", m.mobile ? R.maskPhone(m.mobile) : ""].filter(Boolean).join(" · ") })));
  }));
  // ----- WMF: register a new rider on the spot, check them in, and hand back their personal QR link to send
  app.post("/s/:token/walkin", limit("scanwalkin", 60, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkByToken(req.params.token);
    if (!l || l.scope === "corporate") return res.status(403).json({ status: "error", message: "This scanner is for corporate staff only." });
    const b = req.body || {}, by = "Scanner link: " + l.label;
    if (R.clean(b.full_name).length < 3) return res.json({ status: "error", message: "Enter the rider's full name." });
    if (R.normPhone(b.mobile).length < 9) return res.json({ status: "error", message: "Enter the rider's mobile number." });
    if (b.email && !R.EMAIL_RE.test(R.normEmail(b.email))) return res.json({ status: "error", message: "That email doesn't look right." });
    if (!b.waiver_consent) return res.json({ status: "error", message: "The rider must accept the waiver." });
    const out = await tx(async (c) => {
      let member = await R.findMember(c, { email: b.email, phone: b.mobile }), created = false;
      if (!member) { member = await R.createMember(c, { full_name: b.full_name, email: b.email, mobile: b.mobile, gender: ["Female", "Male"].includes(b.gender) ? b.gender : "",
        community: b.city === "Dubai" ? "Dubai" : "", waiver_consent: true }, by, "WMF Scanner Walk-in"); created = true; }
      const r = await checkIn(c, { member, activityId: b.activityId, date: R.todayLocal(), source: "WMF Ride Lead Check-in", by });
      return { r, member, created };
    });
    if (out.r.status === "error") return res.json(out.r);
    const x = scanReply(out.r);
    res.json({ status: out.r.status, name: x.name, id: x.memberId, detail: `${x.series || "WMF"}${out.created ? " · new member, welcome!" : " · already a member"}`, created: out.created,
      qr: await qrDataUrl(out.member.qr_value || out.member.member_id), ...qrSend(req, out.member) });
  }));

  app.post("/s/:token/scan", limit("scanlink", 900, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkByToken(req.params.token);
    if (!l) return res.status(403).json({ status: "error", message: "This scanner link has been switched off." });
    const b = req.body || {}, code = R.clean(b.code).slice(0, 200), by = "Scanner link: " + l.label;
    const isCorp = !!C.pidFromScan(code) && !/^\s*(wmf|\d)/i.test(code); // WMF codes start with WMF- (or are typed as a number)
    let out;
    if (isCorp) {
      if (l.scope === "wmf") out = { status: "error", message: "This scanner is for WMF only." };
      else out = await tx(async (c) => C.corpScan(c, { code, session: b.session, by, codes: (await C.companies(c)).map((x) => x.code), method: "Scanner link" }));
      if (out.status !== "error") out = { status: out.status, name: out.name, id: out.pid, detail: `${out.company} · session ${out.total}` };
    } else {
      const memberId = wmfIdFromText(code);
      if (l.scope === "corporate") out = { status: "error", message: memberId ? "This scanner is for corporate staff only." : "This is not a corporate QR code or ID." };
      else if (!memberId) out = { status: "error", message: "This QR code isn't a WMF or corporate code." };
      else {
        const r = await tx(async (c) => {
          const member = await R.findMember(c, { memberId });
          if (!member) return { status: "error", message: `${memberId} is not in the WMF member list.` };
          return checkIn(c, { member, activityId: b.activityId, date: R.todayLocal(), source: "WMF QR Attendance Scanner", scanned: code, by });
        });
        await pool.query("INSERT INTO scan_log (actor, scanned, activity_id, session_date, result, member_id) VALUES ($1,$2,$3,$4,$5,$6)", [by, code, b.activityId || null, R.todayLocal(), r.status, r.member ? r.member.member_id : memberId]);
        const x = scanReply(r);
        out = r.status === "error" ? x : { status: x.status, name: x.name, id: x.memberId, detail: `${x.series || "WMF"}${x.rides === 1 ? " · first ride, welcome!" : x.rides ? ` · ride ${x.rides}` : ""}` };
      }
    }
    await pool.query("UPDATE scanner_links SET last_used = now(), scans = scans + $2 WHERE id = $1", [l.id, out.status === "ok" ? 1 : 0]);
    res.json(out);
  }));

  // ===================================================== admin: make and manage links
  app.get("/admin/scanners", A, wrap(async (req, res) => {
    const rows = (await pool.query("SELECT * FROM scanner_links ORDER BY active DESC, created_at DESC")).rows;
    const fresh = req.session.newScanner; delete req.session.newScanner;
    const cards = await Promise.all(rows.map(async (l) => {
      const url = linkUrl(req, l), img = l.active ? await QRCode.toDataURL(url, { margin: 1, width: 240 }) : null;
      const wa = "https://wa.me/?text=" + encodeURIComponent(`Attendance scanner for ${l.label}: ${url}\nOpen it on your phone, choose the ride and tap Start scanning.`);
      return `<section class="card c6" style="display:grid;gap:8px;${l.active ? "" : "opacity:.6"}${fresh === l.id ? ";border-color:var(--accent)" : ""}">
        <div class="card-head"><div><h2>${h(l.label)} ${l.active ? `<span class="badge good">On</span>` : `<span class="badge">Off</span>`}</h2>
          <p class="lead" style="margin:2px 0 0">${h(SCOPES[l.scope])} · ${l.scans} check-in${l.scans === 1 ? "" : "s"} · last used ${fmtTs(l.last_used)}</p></div>
          ${img ? `<img src="${img}" alt="QR code to open this scanner" width="96" height="96" style="border-radius:6px;background:#fff;padding:4px">` : ""}</div>
        ${l.active ? `<p class="muted" style="font-size:13px;overflow-wrap:anywhere;margin:0">${h(url)}</p>
          <div class="toolbar" style="margin:0"><button class="btn primary" data-copy="${h(url)}">Copy link</button><a class="btn" href="${h(wa)}" target="_blank" rel="noopener">Send on WhatsApp</a><a class="btn" href="${h(url)}" target="_blank" rel="noopener">Open</a></div>` : ""}
        <form class="inline-form" method="post" action="/admin/scanners/${l.id}">
          <input class="inp" name="label" value="${h(l.label)}" maxlength="60" aria-label="Name">
          <select class="inp" name="scope" aria-label="Programmes">${Object.entries(SCOPES).map(([k, v]) => `<option value="${k}" ${l.scope === k ? "selected" : ""}>${v}</option>`).join("")}</select>
          <button class="btn tblbtn">Save</button>
          <button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form></section>`;
    }));
    res.send(page(req, "Scanner links", `
      <section class="card"><h2>Scanner links</h2>
        <p class="lead">A scanner link opens one simple page on any phone: choose WMF or Corporate, pick today's ride, and scan people's QR codes. No sign-in, no menus.
        Make one link per person (or per phone) so you can see who scanned, and switch it off when they no longer help. A link can only record attendance: it never shows member lists or contact details.</p>
        <form class="inline-form" method="post" action="/admin/scanners" style="margin-top:6px">
          <input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. Jas, ride lead phone" style="flex:1 1 220px">
          <select class="inp" name="scope">${Object.entries(SCOPES).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select>
          <button class="btn primary">Make a scanner link</button></form></section>
      <div class="grid">${cards.join("") || `<section class="card c12"><p class="muted">No scanner links yet.</p></section>`}</div>`, { active: "/admin" }));
  }));
  app.post("/admin/scanners", A, wrap(async (req, res) => {
    const label = R.clean(req.body.label), scope = SCOPES[req.body.scope] ? req.body.scope : "both";
    if (!label) { setFlash(req, "err", "Say who the link is for."); return res.redirect("/admin/scanners"); }
    const r = (await pool.query("INSERT INTO scanner_links (token, label, scope, created_by) VALUES ($1,$2,$3,$4) RETURNING id", [newToken(), label, scope, actor(req)])).rows[0];
    await audit(pool, actor(req), "scanner.create", "scanner_link", String(r.id), null, { label, scope });
    req.session.newScanner = r.id;
    setFlash(req, "ok", `Scanner link made for ${label}. Copy it or send it on WhatsApp.`);
    res.redirect("/admin/scanners");
  }));
  app.post("/admin/scanners/:id", A, wrap(async (req, res) => {
    const l = (await pool.query("SELECT * FROM scanner_links WHERE id = $1", [+req.params.id])).rows[0];
    if (!l) return res.redirect("/admin/scanners");
    const upd = { label: R.clean(req.body.label) || l.label, scope: SCOPES[req.body.scope] ? req.body.scope : l.scope, active: req.body.active === undefined ? l.active : req.body.active === "1" };
    // switching a link back on gives it a new address, so an old copy that was passed around stays dead
    const token = !l.active && upd.active ? newToken() : l.token;
    await pool.query("UPDATE scanner_links SET label = $2, scope = $3, active = $4, token = $5 WHERE id = $1", [l.id, upd.label, upd.scope, upd.active, token]);
    await audit(pool, actor(req), upd.active === l.active ? "scanner.update" : upd.active ? "scanner.on" : "scanner.off", "scanner_link", String(l.id), { label: l.label, scope: l.scope, active: l.active }, upd);
    setFlash(req, "ok", upd.active === l.active ? "Saved." : upd.active ? "Switched on with a new link. Send the new link." : "Switched off. That link no longer works.");
    res.redirect("/admin/scanners");
  }));
};
module.exports.wmfIdFromText = wmfIdFromText;
