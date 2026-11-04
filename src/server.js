"use strict";
const path = require("path");
const express = require("express");
const session = require("express-session");
const PgStore = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const { pool, migrate, tx, audit, getSettings } = require("./db");
const R = require("./rules");
const { h, layout, ROLE_TEXT, fmtDate, fmtTs } = require("./views");
const { buildData, anonymise } = require("./snapshot");

const app = express();
const PROD = process.env.NODE_ENV === "production";
const SECRET = process.env.SESSION_SECRET || (PROD ? null : "dev-only-secret");
if (!SECRET) { console.error("SESSION_SECRET is not set."); process.exit(1); }

app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  if (PROD) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
// wake-up address for a free "keep awake" service: answers without touching the database, so Neon can still sleep
app.get("/ping", (req, res) => res.set("Cache-Control", "no-store").type("text").send("ok"));
app.get("/healthz", async (req, res) => { try { await pool.query("SELECT 1"); res.send("ok"); } catch (e) { res.status(503).send("db unavailable"); } });
app.use(express.static(path.join(__dirname, "..", "public"), { index: false, maxAge: PROD ? "1h" : 0,
  // scripts and styles: always check for a newer copy, so a phone never keeps an old scanner after an update
  setHeaders: (res, file) => { if (/\.(js|css|html)$/.test(file)) res.set("Cache-Control", "no-cache"); } }));
app.get("/engine.js", (req, res) => res.type("js").sendFile(path.join(__dirname, "engine.js")));
app.use(express.urlencoded({ extended: false, limit: "200kb" }));
app.use(express.json({ limit: "200kb" }));
app.use(session({
  store: new PgStore({ pool, tableName: "session", createTableIfMissing: false }),
  secret: SECRET, name: "wmf.sid", resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, sameSite: "lax", secure: PROD, maxAge: 12 * 3600 * 1000 },
}));

// cross-site form posts are refused (the session cookie is SameSite=Lax as well)
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const o = req.get("origin") || req.get("referer");
  if (o) { try { if (new URL(o).host !== req.get("host")) return res.status(403).send("Cross-site request refused."); } catch (e) { return res.status(403).send("Bad origin."); } }
  next();
});

// ---------- tiny rate limiter for public forms and sign-in ----------
const hits = new Map();
function limit(name, max, windowMs, { perUser = false, skip } = {}) {
  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const k = name + "|" + (perUser && req.session.user ? "u" + req.session.user.id : req.ip), now = Date.now();
    const arr = (hits.get(k) || []).filter((t) => now - t < windowMs);
    arr.push(now); hits.set(k, arr);
    if (arr.length > max) return res.status(429).send(layout("Slow down", `<section class="card"><h2>Too many attempts</h2><p class="lead">Please wait a few minutes and try again.</p></section>`, { wide: false }));
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some((t) => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const user = (req) => req.session.user || null;
const actor = (req) => (user(req) ? user(req).email : "public");
function need(...roles) {
  return (req, res, next) => {
    const u = user(req);
    if (!u) return req.path.startsWith("/api/") ? res.status(401).json({ error: "Please sign in again." }) : res.redirect("/login?next=" + encodeURIComponent(req.originalUrl));
    if (u.mustChange && !req.path.startsWith("/account")) return res.redirect("/account/password");
    // an account limited to one corporate partner only reaches that partner's corporate dashboard and report
    if (u.company && !/^\/(corporate|account)(\/|$)/.test(req.path)) return req.path.startsWith("/api/") ? res.status(403).json({ error: "Not allowed for your account." }) : res.redirect("/corporate?company=" + encodeURIComponent(u.company));
    if (roles.length && !roles.includes(u.role)) return req.path.startsWith("/api/") ? res.status(403).json({ error: "Not allowed for your role." }) : res.status(403).send(layout("Not allowed", `<section class="card"><h2>Not available to your role</h2><p class="lead"><a href="/">Back to the start</a></p></section>`, { user: u }));
    next();
  };
}
const STAFF = ["admin", "coordinator"];
const takeFlash = (req) => { const f = req.session.flash; delete req.session.flash; return f; };
const setFlash = (req, type, text) => { req.session.flash = { type, text }; };
const page = (req, title, body, opts = {}) => layout(title, body, { user: user(req), flash: takeFlash(req), ...opts });

// ======================= sign in =======================
app.get("/login", (req, res) => {
  if (user(req)) return res.redirect("/");
  res.send(page(req, "Sign in", `<section class="card"><h2>Staff sign in</h2><p class="lead">For WMF administrators, ride leads, managers and sponsors.</p>
    <form class="form" method="post" action="/login">
      <input type="hidden" name="next" value="${h(req.query.next || "/")}">
      <label>Email<input name="email" type="email" autocomplete="username" required></label>
      <label>Password<input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary big">Sign in</button></form></section>
    <p class="muted" style="text-align:center">Community members: <a href="/join">register</a> · <a href="/events">event sign-up</a></p>`, { wide: false }));
});
app.post("/login", limit("login", 10, 15 * 60e3), wrap(async (req, res) => {
  const email = R.normEmail(req.body.email);
  const r = await pool.query("SELECT * FROM users WHERE lower(email) = $1 AND active", [email]);
  const u = r.rows[0];
  if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.password_hash))) {
    setFlash(req, "err", "Email or password is not right.");
    return res.redirect("/login");
  }
  await pool.query("UPDATE users SET last_login = now() WHERE id = $1", [u.id]);
  req.session.regenerate((err) => {
    if (err) return res.status(500).send("Session error");
    req.session.user = { id: u.id, email: u.email, name: u.name, role: u.role, mustChange: u.must_change, company: u.company || null };
    const next = String(req.body.next || "/");
    res.redirect(u.must_change ? "/account/password" : u.company ? "/corporate" : next.startsWith("/") && !next.startsWith("//") ? next : "/");
  });
}));
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

app.get("/account/password", need(), (req, res) => {
  const u = user(req);
  res.send(page(req, "Password", `<section class="card"><h2>${u.mustChange ? "Choose your own password" : "Change password"}</h2>
    <p class="lead">At least 10 characters.</p>
    <form class="form" method="post" action="/account/password">
      <label>Current password<input name="current" type="password" autocomplete="current-password" required></label>
      <label>New password<input name="password" type="password" minlength="10" autocomplete="new-password" required></label>
      <button class="btn primary">Save password</button></form></section>`, { wide: false }));
});
app.post("/account/password", need(), wrap(async (req, res) => {
  const u = user(req);
  const r = await pool.query("SELECT password_hash FROM users WHERE id = $1", [u.id]);
  const pw = String(req.body.password || "");
  if (!r.rows[0] || !(await bcrypt.compare(String(req.body.current || ""), r.rows[0].password_hash))) { setFlash(req, "err", "The current password is not right."); return res.redirect("/account/password"); }
  if (pw.length < 10) { setFlash(req, "err", "Use at least 10 characters."); return res.redirect("/account/password"); }
  await pool.query("UPDATE users SET password_hash = $1, must_change = false WHERE id = $2", [await bcrypt.hash(pw, 11), u.id]);
  await audit(pool, u.email, "user.password", "user", u.email, null, null, null);
  req.session.user.mustChange = false;
  setFlash(req, "ok", "Password saved.");
  res.redirect("/");
}));

// ======================= Cycling Development hub =======================
app.get("/", need(), wrap(async (req, res) => {
  const u = user(req);
  const today = R.todayLocal(), y0 = today.slice(0, 4) + "-01-01", isStaff = STAFF.includes(u.role);
  const C = require("./corpdata");
  const [w, corp, dept, me] = await Promise.all([
    pool.query(`SELECT (SELECT count(*) FROM members WHERE merged_into IS NULL) AS members,
      (SELECT count(*) FROM participation WHERE voided_at IS NULL AND record_type = 'Attendance' AND record_date >= $1::date) AS rides,
      (SELECT count(*) FROM participation WHERE voided_at IS NULL AND record_type = 'Event Registration' AND record_date >= $1::date) AS events`, [y0]),
    C.stats({ codes: (await C.companies()).map((x) => x.code), start: y0, end: today }),
    u.role === "admin" ? pool.query(`SELECT (SELECT count(*) FROM dept_staff WHERE active) staff, (SELECT count(*) FROM dept_leave WHERE status = 'Pending') pending,
      (SELECT count(DISTINCT staff_id) FROM dept_shifts WHERE work_date = $1 AND start_time IS NOT NULL) inn`, [today]) : null,
    isStaff ? pool.query("SELECT 1 FROM dept_staff WHERE lower(email) = lower($1) AND active", [u.email]) : null,
  ]);
  const W = w.rows[0], K = corp.k, D = dept && dept.rows[0];
  const stat = (v, l) => `<div><b>${Number(v || 0).toLocaleString("en-GB")}</b><span>${h(l)}</span></div>`;
  const links = (arr) => `<div class="links">${arr.map(([href, l]) => `<a href="${href}">${h(l)}</a>`).join(" · ")}</div>`;
  res.send(page(req, "Hub", `
    <section class="hub-intro"><h2>Good ${+R.nowLocal().slice(11, 13) < 12 ? "morning" : +R.nowLocal().slice(11, 13) < 17 ? "afternoon" : "evening"}${u.name && u.name !== "Administrator" ? ", " + h(u.name.split(" ")[0]) : ""}</h2>
      <p class="muted" style="margin:4px 0 0">Cycling Development department hub · ${fmtDate(today)} · figures are ${today.slice(0, 4)} year to date</p></section>
    <div class="hub-cards">
      <a class="hub-card band-wmf" href="${isStaff ? "/wmf" : "/overview"}"><span class="eyebrow">Community programme</span><h3>WMN Moving FWD</h3>
        <div class="stats">${stat(W.members, "members")}${stat(W.rides, "ride check-ins")}${stat(W.events, "event sign-ups")}</div>
        <p class="muted" style="margin:0;font-size:14px">Rides, members, events, calendar, dashboard and monthly export.</p></a>
      <a class="hub-card band-corp" href="/corporate"><span class="eyebrow">Corporate programme</span><h3>Corporate Cycling</h3>
        <div class="stats">${stat(K.rideSessions, "rides held")}${stat(K.attendance, "total attendance")}${stat(K.active, "active riders")}</div>
        <p class="muted" style="margin:0;font-size:14px">L'IMAD, NMDC and Aurora: QR check-in, attendance, events, reports for sponsors.</p></a>
      ${isStaff ? `<a class="hub-card band-dept" href="${u.role === "admin" ? "/department" : "/department/me"}"><span class="eyebrow">Department admin</span><h3>Cycling Development team</h3>
        ${D ? `<div class="stats">${stat(D.staff, "team members")}${stat(D.inn, "in today")}${stat(D.pending, "leave requests waiting")}</div>` : ""}
        <p class="muted" style="margin:0;font-size:14px">${u.role === "admin" ? "Team schedule, leave plans and availability, monthly export for HR." : me && me.rows[0] ? "Enter your schedule and leave plans." : "Your attendance and leave (ask an administrator to add you to the team list)."}</p></a>` : ""}
    </div>
    ${isStaff ? `<section class="card"><h2>Quick links</h2><div class="toolbar" style="margin:8px 0 0">
      ${u.role === "admin" ? `<a class="btn primary" href="/admin/scanners">Scanner links for staff</a>` : ""}<a class="btn" href="/scan">WMF scan</a><a class="btn" href="/corporate/attendance">Corporate attendance</a><a class="btn" href="/corporate/qr">Corporate QR codes</a>
      <a class="btn" href="/dashboard#performance">WMF performance</a><a class="btn" href="/corporate/report">Corporate report</a><a class="btn" href="/department/me">My attendance & leave</a></div></section>` : ""}`, { active: "/" }));
}));

// ======================= WMF home =======================
app.get("/wmf", need(), wrap(async (req, res) => {
  const u = user(req);
  if (!STAFF.includes(u.role)) return res.redirect("/overview");
  const today = R.todayLocal();
  const q = await pool.query(`SELECT
      (SELECT count(*) FROM members WHERE merged_into IS NULL) AS members,
      (SELECT count(*) FROM participation WHERE voided_at IS NULL AND record_date::date = $1::date AND record_type = 'Attendance') AS today,
      (SELECT count(*) FROM members WHERE first_seen::date >= ($1::date - 30) AND merged_into IS NULL) AS new30,
      (SELECT count(*) FROM activities WHERE registration_open) AS openEvents`, [today]);
  const s = q.rows[0];
  const empty = Number(s.members) === 0;
  const tile = (href, label, val, note) => `<a class="tile" href="${href}" style="text-decoration:none;color:inherit"><span class="lbl">${h(label)}</span><span class="val">${h(val)}</span><span class="note">${h(note)}</span></a>`;
  res.send(page(req, "Home", `
    ${empty ? `<div class="alert warn"><span class="ic">!</span><span><b>The database is empty.</b> ${u.role === "admin" ? `<a href="/admin/import">Import the WMF workbook</a> to bring in members, their Member IDs and the history.` : "Ask an administrator to import the workbook."}</span></div>` : ""}
    <div class="tiles">
      ${tile("/scan", "Scan ride attendance", "Open scanner", "Uses the QR codes already sent to members")}
      ${tile("/members", "Members", Number(s.members).toLocaleString("en-GB"), "Unique member records")}
      ${tile("/scan", "Ride check-ins today", s.today, fmtDate(today))}
      ${tile("/members?sort=new", "New members, last 30 days", s.new30, "Registrations")}
      ${tile("/activities", "Events open for sign-up", s.openevents, "Public sign-up page: /events")}
      ${tile("/rides", "Attendance per ride", "Check", "Spot riders you forgot to scan")}
      ${tile("/calendar", "WMF calendar", "Open", "Rides, events and key dates")}
      ${tile("/dashboard", "Dashboard & reports", "Open", "Agreed counting rules")}
      ${tile("/dashboard#performance", "Monthly export", "Excel", "Attendance per month: rides, events, impact")}
    </div>
    <section class="card"><h2>Links to share with the community</h2>
      <p class="lead">New members register here and receive their QR code on screen. Event sign-ups go through the second link.</p>
      <dl class="kv"><dt>Registration</dt><dd><a href="/join">${h(req.protocol + "://" + req.get("host"))}/join</a></dd>
      <dt>Event sign-up</dt><dd><a href="/events">${h(req.protocol + "://" + req.get("host"))}/events</a></dd></dl></section>`, { active: "/wmf" }));
}));

// ======================= dashboard =======================
app.get("/dashboard", need(), (req, res) => res.sendFile(path.join(__dirname, "..", "public", "dashboard.html")));
app.get("/api/snapshot.js", need(), wrap(async (req, res) => {
  const u = user(req);
  let data = await buildData();
  // only administrators' browsers receive real email addresses; coordinators keep names, viewers and sponsors get neither
  if (u.role !== "admin") data = anonymise(data, SECRET, { keepNames: u.role === "coordinator" });
  res.set("Cache-Control", "no-store").type("js")
    .send(`window.WMF_ROLE=${JSON.stringify(u.role)};window.WMF_DATA=${JSON.stringify(data).replace(/</g, "\\u003c")};`);
}));

// ======================= QR scanner (ride leads) =======================
async function rideActivities() {
  // the scanner offers only the six fixed WMF rides
  const r = await pool.query("SELECT * FROM activities WHERE kind = 'ride' AND core AND status = 'Active' ORDER BY sort_order, name");
  return r.rows;
}
const WEEKDAY_DEFAULT = { Monday: "RIDE-MONDAY-MADNESS", Wednesday: "RIDE-WEDNESDAY-SOCIAL", Saturday: "RIDE-WEEKEND-LONG", Sunday: "RIDE-WEEKEND-LONG" };
app.get("/scan", need(...STAFF), wrap(async (req, res) => {
  const acts = await rideActivities();
  const today = R.todayLocal(), wd = R.weekdayOf(today);
  // default: the ride on today's WMF calendar, else the usual ride for this weekday
  const onCal = await require("./calendar").ridesOn(today);
  const defId = (onCal[0] && onCal[0].slot) || WEEKDAY_DEFAULT[wd] || "RIDE-MORNING";
  const def = acts.find((a) => a.activity_id === defId) || acts[0];
  const slotName = Object.fromEntries(acts.map((a) => [a.activity_id, a.name]));
  res.send(page(req, "Scan QR", `
    <section class="card narrow">
      <h2>Ride attendance</h2>
      <p class="lead">Point the camera at a member's WMF QR code. Each member is counted once per ride per day; a second scan is simply confirmed.</p>
      <div class="row2">
        <label class="f"><span>Ride</span><select id="activity" class="inp">${acts.map((a) => `<option value="${h(a.activity_id)}" ${def && a.activity_id === def.activity_id ? "selected" : ""}>${h(a.name)}${a.location && a.location !== "Abu Dhabi" ? " · " + h(a.location) : ""}</option>`).join("")}</select></label>
        <label class="f"><span>Ride date</span><input id="date" class="inp" type="date" value="${today}" max="${today}"></label>
      </div>
      ${onCal.length ? `<div class="today-rides" style="margin-top:10px"><span class="muted" style="font-size:13px">On the WMF calendar today:</span>${onCal.map((o) => `<button type="button" class="btn" data-slot="${h(o.slot)}">${o.time ? h(o.time) + " · " : ""}${h(o.title)}${o.location ? " · " + h(o.location) : ""} <span class="badge">${h(slotName[o.slot] || "")}</span></button>`).join("")}</div>` : `<p class="muted" style="font-size:13px;margin:8px 0 0">No WMF ride on the calendar today. <a href="/calendar">Open the calendar</a></p>`}
    </section>
    <section class="card narrow" style="display:grid;gap:12px">
      <div id="reader" aria-label="Camera"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center">
        <button class="btn primary big" id="start">Start camera</button>
        <button class="btn big" id="stop" hidden>Stop camera</button>
      </div>
      <div id="result" class="scan-result" hidden aria-live="assertive"></div>
      <p class="muted" id="queue" hidden></p>
    </section>
    <section class="card narrow"><h2>No QR code? Check in by name</h2>
      <p class="lead">Search by name, email, phone or Member ID.</p>
      <input id="q" class="inp" type="search" placeholder="Search members" autocomplete="off">
      <ul class="log" id="hitsList" style="margin-top:8px"></ul>
      <details style="margin-top:12px"><summary><b>Walk-in: not registered yet</b></summary>
        <form class="form" id="walkin" style="margin-top:10px">
          <label>Full name<input name="full_name" required maxlength="120"></label>
          <div class="row2"><label>Email<input name="email" type="email" maxlength="160"></label><label>Mobile<input name="mobile" maxlength="30"></label></div>
          <label class="check"><input type="checkbox" name="waiver_consent" value="1" required> <span>The rider accepted the WMF waiver</span></label>
          <button class="btn primary">Register and check in</button>
        </form></details>
    </section>
    <p class="muted narrow" style="font-size:13px;margin:0">After the ride: <a href="/rides">check the attendance list</a> for usual riders who weren't scanned.</p>
    <section class="card narrow"><h2>This session</h2><ul class="log" id="log"><li class="muted">No check-ins yet on this device.</li></ul></section>`,
  { active: "/scan", scripts: `<script src="/vendor/html5-qrcode.min.js"></script><script src="/camhelp.js"></script><script src="/scan.js"></script>` }));
}));

/** Check one member in to a ride. Shared by camera scans, name search and walk-ins. */
async function checkIn(c, { member, activityId, date, source, scanned, by, maxDays = 14 }) {
  const act = (await c.query("SELECT * FROM activities WHERE activity_id = $1", [activityId])).rows[0];
  if (!act || act.kind !== "ride") return { status: "error", message: "Choose a ride first." };
  const today = R.todayLocal();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "") || date > today || R.weekdayOf(date) && date < require("./engine").helpers.addDays(today, -maxDays))
    return { status: "error", message: `Ride date must be within the last ${maxDays} days.` };
  const series = R.seriesFor(act, date);
  const prior = await R.alreadyRode(c, member, date, series);
  if (prior) return { status: "duplicate", member, series, record: prior.record_id };
  const time = date === today ? R.nowLocal() : date + "T00:00:00";
  const { row, duplicate } = await R.addParticipation(c, {
    member, recordType: "Attendance", date: time, activityId: act.activity_id, activityName: act.name, activityType: act.activity_type || "Community Ride",
    status: "Attended", source, formResponseId: source === "WMF QR Attendance Scanner" ? member.member_id : null,
    dedupeKey: `ride|${member.member_id}|${date}|${series}`, notes: scanned && scanned !== member.member_id ? "Scanned: " + scanned.slice(0, 80) : null,
  }, by);
  if (duplicate) return { status: "duplicate", member, series, record: row.record_id };
  const rides = (await c.query("SELECT count(DISTINCT record_date::date) AS n FROM participation WHERE voided_at IS NULL AND member_id = $1 AND record_type = 'Attendance' AND status = 'Attended'", [member.member_id])).rows[0].n;
  return { status: "ok", member, series, record: row.record_id, rides: Number(rides) };
}
const scanReply = (r) => r.member ? { status: r.status, message: r.message, memberId: r.member.member_id, name: r.member.full_name, series: r.series, record: r.record, rides: r.rides } : { status: r.status, message: r.message };

app.post("/api/scan", need(...STAFF), wrap(async (req, res) => {
  const { code, activityId, date } = req.body || {};
  const memberId = R.memberIdFromScan(code);
  const out = await tx(async (c) => {
    if (!memberId) return { status: "error", message: "This is not a WMF member QR code." };
    const member = await R.findMember(c, { memberId });
    if (!member) return { status: "error", message: `${memberId} is not in the member list.` };
    return checkIn(c, { member, activityId, date, source: "WMF QR Attendance Scanner", scanned: String(code || ""), by: actor(req) });
  });
  await pool.query("INSERT INTO scan_log (actor, scanned, activity_id, session_date, result, member_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [actor(req), String(code || "").slice(0, 200), activityId || null, /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : null, out.status, out.member ? out.member.member_id : memberId]);
  res.json(scanReply(out));
}));
app.post("/api/checkin", need(...STAFF), wrap(async (req, res) => {
  const { memberId, activityId, date } = req.body || {};
  const out = await tx(async (c) => {
    const member = await R.findMember(c, { memberId });
    if (!member) return { status: "error", message: "Member not found." };
    return checkIn(c, { member, activityId, date, source: "WMF Ride Lead Check-in", by: actor(req) });
  });
  res.json(scanReply(out));
}));
app.post("/api/walkin", need(...STAFF), wrap(async (req, res) => {
  const b = req.body || {};
  if (!R.clean(b.full_name)) return res.json({ status: "error", message: "Enter the rider's name." });
  if (b.email && !R.EMAIL_RE.test(R.normEmail(b.email))) return res.json({ status: "error", message: "That email doesn't look right." });
  if (!b.waiver_consent) return res.json({ status: "error", message: "The waiver must be accepted." });
  const out = await tx(async (c) => {
    let member = await R.findMember(c, { email: b.email, phone: b.mobile });
    let created = false;
    if (!member) { member = await R.createMember(c, { ...b, waiver_consent: true }, actor(req), "WMF Ride Lead Walk-in"); created = true; }
    const r = await checkIn(c, { member, activityId: b.activityId, date: b.date, source: "WMF Ride Lead Check-in", by: actor(req) });
    if (r.status === "error") throw Object.assign(new Error(r.message), { expose: true });
    return { ...r, created };
  }).catch((e) => { if (e.expose) return { status: "error", message: e.message }; throw e; });
  res.json({ ...scanReply(out), created: out.created });
}));
const browseLimit = limit("browse", 300, 3600e3, { perUser: true, skip: (req) => req.session.user && req.session.user.role === "admin" });
app.get("/api/members/search", need(...STAFF), browseLimit, wrap(async (req, res) => {
  const q = R.clean(req.query.q);
  if (q.length < 2) return res.json([]);
  const r = await pool.query(`SELECT member_id, full_name, primary_email, mobile FROM members
     WHERE merged_into IS NULL AND (full_name ILIKE $1 OR primary_email ILIKE $1 OR mobile ILIKE $1 OR member_id ILIKE $1 OR alt_emails ILIKE $1)
     ORDER BY full_name LIMIT 12`, ["%" + q.replace(/[%_]/g, "") + "%"]);
  // show only enough of the email and phone to tell people apart
  res.json(r.rows.map((m) => ({ memberId: m.member_id, name: m.full_name, hint: [m.primary_email ? m.primary_email.replace(/^(.{2}).*@/, "$1…@") : "", m.mobile ? "…" + String(m.mobile).slice(-3) : ""].filter(Boolean).join(" · ") })));
}));

// ======================= QR images =======================
const QRCode = require("qrcode");
const qrPng = (value) => QRCode.toBuffer(value, { errorCorrectionLevel: "M", margin: 2, width: 600 });
const qrDataUrl = (value) => QRCode.toDataURL(value, { errorCorrectionLevel: "M", margin: 2, width: 480 });
app.get("/members/:id/qr.png", need(...STAFF), wrap(async (req, res) => {
  const m = (await pool.query("SELECT member_id, qr_value FROM members WHERE member_id = $1", [req.params.id])).rows[0];
  if (!m) return res.status(404).send("Not found");
  res.type("png").set("Content-Disposition", `attachment; filename="${m.member_id}.png"`).send(await qrPng(m.qr_value || m.member_id));
}));

// ======================= public: registration =======================
const consentText = `I take part in WMF rides and events at my own risk, will follow the ride leader's instructions and road safety rules, and confirm I am fit to ride.`;
function joinForm(v = {}, err) {
  return `<section class="card"><h2>Join WMN Moving FWD</h2>
    <p class="lead">Register once. You'll get your personal QR code on the next screen: show it to the ride leader at every ride.</p>
    ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <form class="form" method="post" action="/join">
      <label>Full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
      <div class="row2"><label>Email<input name="email" type="email" required maxlength="160" value="${h(v.email)}" autocomplete="email"></label>
      <label>Mobile<input name="mobile" required maxlength="30" value="${h(v.mobile)}" autocomplete="tel" inputmode="tel"></label></div>
      <div class="row2"><label>Community<select name="community"><option value="">Choose…</option>${["Emirati", "Arab", "Expat"].map((c) => `<option ${v.community === c ? "selected" : ""}>${c}</option>`).join("")}</select></label>
      <label>Home city<select name="city"><option>Abu Dhabi</option><option ${v.city === "Dubai" ? "selected" : ""}>Dubai</option><option ${v.city === "Other" ? "selected" : ""}>Other</option></select></label></div>
      <div class="row2"><label>Emergency contact name<input name="emergency_name" maxlength="120" value="${h(v.emergency_name)}"></label>
      <label>Emergency contact number<input name="emergency_number" maxlength="30" value="${h(v.emergency_number)}" inputmode="tel"></label></div>
      <label class="check"><input type="checkbox" name="waiver_consent" value="1" required ${v.waiver_consent ? "checked" : ""}> <span>${consentText}</span></label>
      <label class="check"><input type="checkbox" name="updates_consent" value="1" ${v.updates_consent ? "checked" : ""}> <span>Send me updates about WMF rides and events.</span></label>
      <label class="check"><input type="checkbox" name="media_consent" value="1" ${v.media_consent ? "checked" : ""}> <span>Photos or videos of me may be used by WMF.</span></label>
      <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
      <button class="btn primary big">Register</button>
    </form></section>`;
}
app.get("/join", (req, res) => res.send(page(req, "Join", joinForm(), { wide: false })));
app.post("/join", limit("join", 8, 60 * 60e3), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.redirect("/join"); // bot trap
  const email = R.normEmail(b.email);
  const v = { ...b, waiver_consent: !!b.waiver_consent, updates_consent: !!b.updates_consent, media_consent: !!b.media_consent };
  if (!R.clean(b.full_name)) return res.send(page(req, "Join", joinForm(v, "Please enter your full name."), { wide: false }));
  if (!R.EMAIL_RE.test(email)) return res.send(page(req, "Join", joinForm(v, "Please check your email address."), { wide: false }));
  if (R.normPhone(b.mobile).length < 9) return res.send(page(req, "Join", joinForm(v, "Please check your mobile number."), { wide: false }));
  if (!b.waiver_consent) return res.send(page(req, "Join", joinForm(v, "Please accept the participation terms."), { wide: false }));
  const out = await tx(async (c) => {
    const existing = await R.findMember(c, { email });
    if (existing) return { existing };
    const m = await R.createMember(c, { ...v, email, community: [b.community, b.city && b.city !== "Abu Dhabi" ? b.city : ""].filter(Boolean).join(" · ") }, "public", "WMF App Registration");
    await R.addParticipation(c, { member: m, recordType: "Member Registration", date: R.nowLocal(), activityId: "WMF-MEMBER-REGISTRATION", activityName: "WMF Member Registration",
      activityType: "Member Registration", status: "Registered", source: "WMF App Registration", dedupeKey: "reg|" + m.member_id }, "public");
    return { m };
  });
  if (out.existing) {
    return res.send(page(req, "Already registered", `<section class="card"><h2>You're already registered</h2>
      <p class="lead">This email already has a WMF membership. Use the QR code we sent you, or ask the ride leader to check you in by name. They can also show your code again.</p>
      <p><a class="btn" href="/events">See upcoming events</a></p></section>`, { wide: false }));
  }
  const img = await qrDataUrl(out.m.qr_value);
  res.send(page(req, "Welcome", `<section class="card" style="display:grid;gap:12px"><h2>Welcome, ${h(out.m.full_name.split(" ")[0])}!</h2>
    <p class="lead">This is your personal WMF QR code. Save it to your phone now: show it to the ride leader at every ride.</p>
    <div class="qrbox"><img src="${img}" alt="QR code for ${h(out.m.member_id)}"><span class="id">${h(out.m.member_id)}</span></div>
    <a class="btn primary big" href="${img}" download="${h(out.m.member_id)}-WMF-QR.png" style="text-align:center;text-decoration:none">Download QR code</a>
    <p class="muted">Tip: take a screenshot too. Your Member ID is ${h(out.m.member_id)}.</p></section>`, { wide: false }));
}));

// ======================= public: event sign-up =======================
app.get("/events", wrap(async (req, res) => {
  const r = await pool.query("SELECT * FROM activities WHERE registration_open AND kind = 'event' AND status = 'Active' AND (event_date IS NULL OR event_date >= $1::date) ORDER BY event_date NULLS LAST, name", [R.todayLocal()]);
  res.send(page(req, "Events", `<section class="card"><h2>Upcoming WMF events</h2><p class="lead">Choose an event to sign up.</p>
    ${r.rows.length ? `<ul class="log">${r.rows.map((e) => `<li><a href="/events/${encodeURIComponent(e.activity_id)}"><b>${h(e.name)}</b></a><span class="muted">${e.event_date ? fmtDate(e.event_date) : ""}${e.location ? " · " + h(e.location) : ""}${priceText(e) ? " · " + h(priceText(e)) : " · Free"}</span></li>`).join("")}</ul>` : `<p class="muted">No events are open for sign-up right now.</p>`}
    <p style="margin-top:14px"><a href="/calendar">See the full WMF calendar</a> · <a href="/join">New to WMF? Register here</a></p></section>`, { wide: false }));
}));
const priceText = (e) => (Number(e.price_aed) > 0 ? "AED " + Number(e.price_aed).toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "");
const safePayUrl = (u) => { try { const x = new URL(u); return x.protocol === "https:" ? x.href : ""; } catch (err) { return ""; } };
function eventForm(e, v = {}, err) {
  return `<section class="card"><h2>${h(e.name)}</h2><p class="lead">${e.event_date ? fmtDate(e.event_date) : ""}${e.location ? " · " + h(e.location) : ""}${e.notes ? "<br>" + h(e.notes) : ""}</p>
    ${priceText(e) ? `<div class="alert info"><span class="ic">i</span><span><b>Fee: ${h(priceText(e))}.</b> After you sign up you'll be taken to the payment page. Your place is confirmed once payment is received.</span></div>` : ""}
    ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <form class="form" method="post">
      <label>Member ID <span class="hint">(optional, on your QR code, e.g. WMF-000123)</span><input name="member_id" maxlength="20" value="${h(v.member_id)}"></label>
      <label>Full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
      <div class="row2"><label>Email<input name="email" type="email" required maxlength="160" value="${h(v.email)}" autocomplete="email"></label>
      <label>Mobile<input name="mobile" required maxlength="30" value="${h(v.mobile)}" autocomplete="tel"></label></div>
      <label class="check"><input type="checkbox" name="waiver_consent" value="1" required> <span>${consentText}</span></label>
      <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
      <button class="btn primary big">Sign up</button></form></section>`;
}
async function openEvent(id) {
  const e = (await pool.query("SELECT * FROM activities WHERE activity_id = $1 AND kind = 'event'", [id])).rows[0];
  return e && e.registration_open && e.status === "Active" && (!e.event_date || e.event_date >= R.todayLocal()) ? e : null;
}
app.get("/events/:id", wrap(async (req, res) => {
  const e = await openEvent(req.params.id);
  if (!e) return res.status(404).send(page(req, "Event", `<section class="card"><h2>Sign-up is closed</h2><p class="lead"><a href="/events">See open events</a></p></section>`, { wide: false }));
  res.send(page(req, e.name, eventForm(e), { wide: false }));
}));
app.post("/events/:id", limit("event", 10, 60 * 60e3), wrap(async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.redirect("/events");
  const e = await openEvent(req.params.id);
  if (!e) return res.redirect("/events");
  const email = R.normEmail(b.email);
  if (!R.clean(b.full_name) || !R.EMAIL_RE.test(email) || R.normPhone(b.mobile).length < 9 || !b.waiver_consent)
    return res.send(page(req, e.name, eventForm(e, b, "Please fill in your name, a valid email and mobile, and accept the terms."), { wide: false }));
  const out = await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["event|" + e.activity_id]);
    // the Member ID only counts when it belongs to the same email, so nobody can sign up as someone else
    let member = null;
    const byId = R.memberIdFromScan(b.member_id) ? await R.findMember(c, { memberId: R.memberIdFromScan(b.member_id) }) : null;
    if (byId && [byId.primary_email, ...String(byId.alt_emails || "").split(/[;,\s]+/)].map(R.normEmail).includes(email)) member = byId;
    if (!member) member = await R.findMember(c, { email });
    let created = false;
    if (!member) { member = await R.createMember(c, { ...b, email, waiver_consent: true }, "public", "WMF App Event Registration"); created = true; }
    if (e.capacity) {
      const n = Number((await c.query("SELECT count(*) AS n FROM participation WHERE activity_id = $1 AND voided_at IS NULL AND record_type = 'Event Registration'", [e.activity_id])).rows[0].n);
      const mine = (await c.query("SELECT 1 FROM participation WHERE dedupe_key = $1 AND voided_at IS NULL", [`event|${member.member_id}|${e.activity_id}`])).rows[0];
      if (!mine && n >= e.capacity) return { full: true };
    }
    const r = await R.addParticipation(c, { member, recordType: "Event Registration", date: R.nowLocal(), activityId: e.activity_id, activityName: e.name,
      activityType: e.activity_type || "Event Registration", status: "Registered", source: "WMF App Event Registration", dedupeKey: `event|${member.member_id}|${e.activity_id}` }, "public");
    let paymentStatus = r.row.payment_status;
    if (!r.duplicate && Number(e.price_aed) > 0) { paymentStatus = "Unpaid"; await c.query("UPDATE participation SET payment_status = 'Unpaid' WHERE id = $1", [r.row.id]); }
    return { member, created, duplicate: r.duplicate, paymentStatus, recordId: r.row.record_id };
  });
  if (out.full) return res.send(page(req, e.name, eventForm(e, b, "Sorry, this event is full."), { wide: false }));
  let qr = "";
  if (out.created) { const img = await qrDataUrl(out.member.qr_value); qr = `<p class="lead">You're also now a WMF member. This is your personal QR code for rides:</p><div class="qrbox"><img src="${img}" alt="Your QR code"><span class="id">${h(out.member.member_id)}</span></div><a class="btn" href="${img}" download="${h(out.member.member_id)}-WMF-QR.png">Download QR code</a>`; }
  const payUrl = safePayUrl(e.payment_url);
  const pay = out.paymentStatus === "Unpaid" && priceText(e) ? `<div class="alert warn"><span class="ic">!</span><span><b>One more step: pay ${h(priceText(e))}.</b> Your place is confirmed once payment is received.${payUrl ? "" : " The WMF team will send you payment details."} Your reference: <b>${h(out.recordId)}</b></span></div>
    ${payUrl ? `<a class="btn primary big" href="${h(payUrl)}" target="_blank" rel="noopener noreferrer" style="text-align:center;text-decoration:none">Pay ${h(priceText(e))} now ↗</a>` : ""}` : out.paymentStatus === "Paid" ? `<p><span class="badge good">Payment received</span></p>` : "";
  res.send(page(req, e.name, `<section class="card" style="display:grid;gap:12px"><h2>${out.duplicate ? "You're already signed up" : "You're signed up!"}</h2>
    <p class="lead">${h(e.name)}${e.event_date ? " · " + fmtDate(e.event_date) : ""}</p>${pay}${qr}<p><a href="/events">Back to events</a></p></section>`, { wide: false }));
}));

// ======================= members =======================
app.get("/members", need(...STAFF), browseLimit, wrap(async (req, res) => {
  const q = R.clean(req.query.q), pg = Math.max(1, +req.query.page || 1), per = 50;
  // administrators can show full emails and phones on the list to compare records (each view is logged); coordinators always see them masked
  const isAdmin = user(req).role === "admin", showContacts = isAdmin && req.query.contact === "show";
  const where = ["merged_into IS NULL"], args = [];
  if (q) { args.push("%" + q.replace(/[%_]/g, "") + "%"); where.push(`(full_name ILIKE $1 OR primary_email ILIKE $1 OR alt_emails ILIKE $1 OR mobile ILIKE $1 OR member_id ILIKE $1)`); }
  const sort = ["new", "name"].includes(req.query.sort) ? req.query.sort : "";
  const order = sort === "new" ? "first_seen DESC NULLS LAST" : sort === "name" ? "lower(full_name), member_id" : "member_id";
  const [rows, cnt, groups] = await Promise.all([
    pool.query(`SELECT m.*, (SELECT max(record_date) FROM participation p WHERE p.member_id = m.member_id AND p.voided_at IS NULL AND p.record_type <> 'Member Registration') AS last_seen,
      (SELECT count(*) FROM participation p WHERE p.member_id = m.member_id AND p.voided_at IS NULL AND p.record_type <> 'Member Registration')::int AS acts
      FROM members m WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ${per} OFFSET ${(pg - 1) * per}`, args),
    pool.query(`SELECT count(*) AS n FROM members WHERE ${where.join(" AND ")}`, args),
    require("./dupes").findGroups()]);
  if (showContacts) await audit(pool, actor(req), "member.contact_view", "member_list", `page ${pg}`, null, null, "Viewed contact details on the member list");
  // which records look like someone else's (same email, phone or name)
  const dup = new Map();
  for (const [kind, list] of [["same email", groups.email], ["same phone", groups.phone], ["same name", groups.name]]) for (const g of list) for (const m of g) if (!dup.has(m.member_id)) dup.set(m.member_id, { kind, others: g.filter((x) => x.member_id !== m.member_id).map((x) => x.member_id) });
  const n = Number(cnt.rows[0].n), pages = Math.max(1, Math.ceil(n / per));
  const qs = (o) => new URLSearchParams(Object.entries({ q, sort, contact: showContacts ? "show" : "", page: pg, ...o }).filter(([, v]) => v !== "" && v != null)).toString();
  const nDup = new Set([...groups.email, ...groups.phone, ...groups.name].flat().map((m) => m.member_id)).size;
  res.send(page(req, "Members", `<section class="card">
    <div class="card-head"><div><h2>Members</h2><p class="lead">${n.toLocaleString("en-GB")} unique member records. The QR codes members already have hold their Member ID.${nDup ? ` <b>${nDup} records look like someone else's</b> (same email, phone or name)${isAdmin ? `: <a href="/admin/duplicates">review and merge them</a>` : ""}.` : ""}</p></div>
    <a class="btn primary" href="/members/new">Add member</a></div>
    <form class="toolbar" method="get"><input class="inp" type="search" name="q" value="${h(q)}" placeholder="Name, email, phone or Member ID" style="max-width:360px">
      <label class="f"><span>Sort</span><select class="inp" name="sort" data-autosubmit>${[["", "Member ID"], ["name", "Name A–Z (look-alikes together)"], ["new", "Newest first"]].map(([v, l]) => `<option value="${v}" ${sort === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      ${showContacts ? `<input type="hidden" name="contact" value="show">` : ""}<button class="btn">Search</button></form>
    ${isAdmin ? `<p class="muted" style="font-size:13px;margin:0 0 8px">${showContacts ? `Full emails and phone numbers are showing; this view is logged. <a href="/members?${qs({ contact: "", page: pg })}">Hide them</a>` : `Emails and phones are partly hidden. <a href="/members?${qs({ contact: "show" })}">Show full contact details</a> (logged in the audit log).`}</p>` : ""}
    <div class="tw"><table><thead><tr><th>Member ID</th><th>Name</th><th>Email</th><th>Mobile</th><th>Community</th><th>First seen</th><th class="n">Activities</th><th>Last activity</th><th>Came from</th><th></th></tr></thead><tbody>
    ${rows.rows.map((m) => { const d = dup.get(m.member_id); return `<tr><td><a href="/members/${encodeURIComponent(m.member_id)}">${h(m.member_id)}</a></td><td>${h(m.full_name)}</td>
      <td style="overflow-wrap:anywhere">${h((showContacts ? m.primary_email : R.maskEmail(m.primary_email)) || "—")}${showContacts && m.alt_emails ? `<br><span class="muted" style="font-size:12px">also ${h(m.alt_emails)}</span>` : ""}</td><td>${h((showContacts ? m.mobile : R.maskPhone(m.mobile)) || "—")}</td>
      <td>${h([m.community, m.gender].filter(Boolean).join(" · ") || "—")}</td><td>${fmtDate(m.first_seen && m.first_seen.slice(0, 10))}</td><td class="n">${m.acts}</td><td>${fmtDate(m.last_seen && m.last_seen.slice(0, 10))}</td>
      <td class="muted" style="font-size:13px">${h(m.sources || "")}</td>
      <td>${d ? `<span class="badge warn" title="${h(d.kind)} as ${h(d.others.join(", "))}">Possible duplicate: ${h(d.others.join(", "))}</span>` : ""}</td></tr>`; }).join("") || `<tr><td colspan="10" class="muted">No members found.</td></tr>`}
    </tbody></table></div>
    <div class="pager">${pg > 1 ? `<a class="btn" href="/members?${qs({ page: pg - 1 })}">Previous</a>` : ""}<span>Page ${pg} of ${pages}</span>${pg < pages ? `<a class="btn" href="/members?${qs({ page: pg + 1 })}">Next</a>` : ""}</div>
  </section>`, { active: "/members" }));
}));

const EDITABLE = [["full_name", "Full name"], ["primary_email", "Primary email"], ["alt_emails", "Alternative emails"], ["mobile", "Mobile"], ["gender", "Gender / demographic"],
  ["community", "Community"], ["emergency_name", "Emergency contact name"], ["emergency_number", "Emergency contact number"], ["updates_consent", "Updates consent"],
  ["waiver_consent", "Waiver consent"], ["media_consent", "Media consent"], ["qr_status", "QR status"], ["data_note", "Data quality note"]];

app.get("/members/new", need(...STAFF), (req, res) => {
  res.send(page(req, "Add member", `<section class="card"><h2>Add a member</h2><p class="lead">A new Member ID is assigned. Duplicate emails or mobile numbers are refused.</p>
    <form class="form" method="post" action="/members/new">
      <label>Full name<input name="full_name" required maxlength="120"></label>
      <div class="row2"><label>Email<input name="email" type="email" maxlength="160"></label><label>Mobile<input name="mobile" maxlength="30"></label></div>
      <div class="row2"><label>Community<input name="community" maxlength="60"></label><label>Gender / demographic<input name="gender" maxlength="30"></label></div>
      <label class="check"><input type="checkbox" name="waiver_consent" value="1"> <span>Waiver accepted</span></label>
      <button class="btn primary">Create member</button></form></section>`, { active: "/members", wide: false }));
});
app.post("/members/new", need(...STAFF), wrap(async (req, res) => {
  const b = req.body;
  if (!R.clean(b.full_name)) { setFlash(req, "err", "Enter a name."); return res.redirect("/members/new"); }
  if (b.email && !R.EMAIL_RE.test(R.normEmail(b.email))) { setFlash(req, "err", "That email doesn't look right."); return res.redirect("/members/new"); }
  const out = await tx(async (c) => {
    const ex = await R.findMember(c, { email: b.email, phone: b.mobile });
    if (ex) return { ex };
    return { m: await R.createMember(c, { ...b, waiver_consent: !!b.waiver_consent }, actor(req), "WMF Staff Entry") };
  });
  if (out.ex) { setFlash(req, "err", `Already a member: ${out.ex.member_id} ${out.ex.full_name}.`); return res.redirect("/members/" + encodeURIComponent(out.ex.member_id)); }
  setFlash(req, "ok", `Created ${out.m.member_id}.`);
  res.redirect("/members/" + encodeURIComponent(out.m.member_id));
}));

app.get("/members/:id", need(...STAFF), browseLimit, wrap(async (req, res) => {
  const m = (await pool.query("SELECT * FROM members WHERE member_id = $1", [req.params.id])).rows[0];
  if (!m) return res.status(404).send(page(req, "Not found", `<section class="card"><h2>Member not found</h2></section>`));
  const emails = [m.primary_email, ...String(m.alt_emails || "").split(/[;,\s]+/)].map(R.normEmail).filter(Boolean);
  const merged = (await pool.query("SELECT member_id FROM members WHERE merged_into = $1", [m.member_id])).rows.map((r) => r.member_id);
  const parts = await pool.query(`SELECT * FROM participation WHERE member_id = ANY($1) OR lower(member_email) = ANY($2) ORDER BY record_date DESC, id DESC LIMIT 300`, [[m.member_id, ...merged], emails]);
  const log = await pool.query("SELECT * FROM audit_log WHERE entity = 'member' AND entity_id = $1 ORDER BY at DESC LIMIT 50", [m.member_id]);
  const isAdmin = user(req).role === "admin";
  // contact details: administrators press "Show contact details" (logged); coordinators never see them in full
  const reveal = isAdmin && req.query.contact === "show";
  if (reveal) await audit(pool, actor(req), "member.contact_view", "member", m.member_id, null, null, "Viewed contact details");
  const fieldHtml = ([k, l]) => {
    if (!R.CONTACT_FIELDS.includes(k) || reveal) return `<label>${h(l)}<input name="${k}" value="${h(m[k])}" maxlength="200"></label>`;
    return `<label>${h(l)}<input value="${h(R.maskContact(k, m[k]) || "—")}" disabled title="Hidden to protect members' contact details"></label>`;
  };
  const img = await qrDataUrl(m.qr_value || m.member_id);
  res.send(page(req, m.full_name || m.member_id, `
    ${m.merged_into ? `<div class="alert warn"><span class="ic">!</span><span>This record was merged into <a href="/members/${encodeURIComponent(m.merged_into)}">${h(m.merged_into)}</a>.</span></div>` : ""}
    <div class="grid">
      <section class="card c8"><h2>${h(m.full_name || "(no name)")} <span class="badge">${h(m.member_id)}</span></h2>
        <p class="lead">First seen ${fmtDate(m.first_seen)} · Sources: ${h(m.sources || "—")}${merged.length ? " · Merged records: " + merged.map(h).join(", ") : ""}</p>
        <form class="form" method="post" action="/members/${encodeURIComponent(m.member_id)}/edit">
          <p class="muted" style="margin:0;font-size:13px">${reveal ? "Contact details are visible and this view was logged. They hide again when you leave the page." : isAdmin ? `Contact details are hidden. <a href="?contact=show">Show contact details</a> (logged in the audit log)` : "Contact details are hidden. An administrator can see or change them."}</p>
          <div class="row2">${EDITABLE.map(fieldHtml).join("")}</div>
          <label>Reason for the change <span class="hint">(kept in the audit log)</span><input name="reason" required maxlength="200"></label>
          <button class="btn primary">Save changes</button></form></section>
      <section class="card c4"><h2>QR code</h2><p class="lead">Same code as the one already sent: it holds ${h(m.qr_value || m.member_id)}.</p>
        <div class="qrbox"><img src="${img}" alt="QR code"><span class="id">${h(m.qr_value || m.member_id)}</span></div>
        <p style="margin-top:10px"><a class="btn" href="/members/${encodeURIComponent(m.member_id)}/qr.png">Download PNG</a></p>
        ${isAdmin && !m.merged_into ? `<h2 style="margin-top:18px">Merge a duplicate</h2><p class="lead">Moves the other record's activity here and keeps its email as an alternative. The other Member ID's QR code keeps working.</p>
        <form class="form" method="post" action="/members/${encodeURIComponent(m.member_id)}/merge">
          <label>Duplicate Member ID<input name="other" required placeholder="WMF-000123"></label>
          <label>Reason<input name="reason" required maxlength="200"></label>
          <button class="btn danger">Merge into this member</button></form>` : ""}
      </section>
      <section class="card c12"><h2>Activity</h2><p class="lead">${parts.rows.filter((p) => !p.voided_at).length} records. Voided rows stay visible here but are left out of every figure.</p>
        <div class="tw"><table><thead><tr><th>Date</th><th>Record</th><th>Type</th><th>Activity</th><th>Status</th><th>Source</th><th></th></tr></thead><tbody>
        ${parts.rows.map((p) => `<tr ${p.voided_at ? 'style="opacity:.55"' : ""}><td>${fmtDate(p.record_date)}</td><td>${h(p.record_id || "")}</td><td>${h(p.record_type)}</td><td>${h(p.activity_name)}</td><td>${h(p.status)}${p.voided_at ? ` <span class="badge crit">Voided: ${h(p.void_reason)}</span>` : ""}</td><td>${h(p.source)}</td>
          <td>${isAdmin && !p.voided_at ? `<form method="post" action="/participation/${p.id}/void" class="toolbar"><input class="inp" name="reason" required placeholder="Reason" style="max-width:150px;min-height:32px;font-size:13px"><button class="btn tblbtn danger">Void</button></form>` : ""}</td></tr>`).join("") || `<tr><td colspan="7" class="muted">No activity.</td></tr>`}
        </tbody></table></div></section>
      <section class="card c12"><h2>Change history</h2>
        <div class="tw"><table><thead><tr><th>When</th><th>Who</th><th>What</th><th>Reason</th><th>Before</th><th>After</th></tr></thead><tbody>
        ${log.rows.map((a) => `<tr><td>${fmtTs(a.at)}</td><td>${h(a.actor)}</td><td>${h(a.action)}</td><td>${h(a.reason || "")}</td><td><pre class="json">${h(a.before ? JSON.stringify(reveal ? a.before : R.maskDeep(a.before), null, 1) : "")}</pre></td><td><pre class="json">${h(a.after ? JSON.stringify(reveal ? a.after : R.maskDeep(a.after), null, 1) : "")}</pre></td></tr>`).join("") || `<tr><td colspan="6" class="muted">No changes recorded in the app yet.</td></tr>`}
        </tbody></table></div></section>
    </div>`, { active: "/members" }));
}));
app.post("/members/:id/edit", need(...STAFF), wrap(async (req, res) => {
  const id = req.params.id, b = req.body;
  const reason = R.clean(b.reason);
  const back = "/members/" + encodeURIComponent(id);
  if (!reason) { setFlash(req, "err", "Give a reason for the change."); return res.redirect(back); }
  const msg = await tx(async (c) => {
    const m = (await c.query("SELECT * FROM members WHERE member_id = $1 FOR UPDATE", [id])).rows[0];
    if (!m) return "Member not found.";
    const before = {}, after = {};
    const isAdmin = user(req).role === "admin";
    for (const [k] of EDITABLE) {
      if (!(k in b)) continue;
      if (R.CONTACT_FIELDS.includes(k) && !isAdmin) continue; // only administrators change contact details
      let v = R.clean(b[k]) || null;
      if (k === "primary_email" && v) { v = R.normEmail(v); if (!R.EMAIL_RE.test(v)) return "That email doesn't look right."; }
      if ((m[k] || null) !== v) { before[k] = m[k]; after[k] = v; }
    }
    if (!Object.keys(after).length) return "Nothing changed.";
    if (after.primary_email) {
      const other = await R.findMember(c, { email: after.primary_email });
      if (other && other.member_id !== id) return `That email belongs to ${other.member_id}. Merge the records instead.`;
    }
    if ("full_name" in after && !after.full_name) return "The name can't be empty.";
    const keys = Object.keys(after);
    await c.query(`UPDATE members SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE member_id = $1`, [id, ...keys.map((k) => after[k])]);
    await audit(c, actor(req), "member.update", "member", id, before, after, reason);
    return null;
  });
  setFlash(req, msg ? (msg === "Nothing changed." ? "info" : "err") : "ok", msg || "Saved. The change is in the history below.");
  res.redirect(back);
}));
app.post("/members/:id/merge", need("admin"), wrap(async (req, res) => {
  const keep = req.params.id, other = R.memberIdFromScan(req.body.other) || R.clean(req.body.other), reason = R.clean(req.body.reason);
  const back = "/members/" + encodeURIComponent(keep);
  if (!reason) { setFlash(req, "err", "Give a reason."); return res.redirect(back); }
  const r = await tx((c) => require("./dupes").mergeMembers(c, keep, other, actor(req), reason));
  setFlash(req, r.err ? "err" : "ok", r.err || `Merged ${other} into ${keep}. You can undo it under Admin → Duplicates.`);
  res.redirect(back);
}));
app.post("/participation/:id/void", need("admin"), wrap(async (req, res) => {
  const reason = R.clean(req.body.reason);
  const p = (await pool.query("SELECT * FROM participation WHERE id = $1", [+req.params.id])).rows[0];
  if (!p) return res.redirect("back");
  if (reason) {
    await tx(async (c) => {
      await c.query("UPDATE participation SET voided_at = now(), void_reason = $2 WHERE id = $1 AND voided_at IS NULL", [p.id, reason]);
      await audit(c, actor(req), "participation.void", "participation", p.record_id || String(p.id), p, null, reason);
      if (p.member_id) await audit(c, actor(req), "participation.void", "member", p.member_id, { record: p.record_id, activity: p.activity_name, date: p.record_date }, null, reason);
    });
    setFlash(req, "ok", `Voided ${p.record_id || "the row"}.`);
  }
  res.redirect(req.get("referer") && new URL(req.get("referer")).host === req.get("host") ? new URL(req.get("referer")).pathname : "/members");
}));

// ======================= rides & events (see events.js, rides.js) =======================
require("./events")(app, { need, page, setFlash, actor, user, wrap });
require("./rides")(app, { need, page, setFlash, actor, user, wrap, checkIn });

// ======================= WMF monthly export =======================
app.get("/api/wmf/monthly.xlsx", need(), wrap(async (req, res) => {
  const u = user(req);
  let data = await buildData();
  if (u.role !== "admin") data = anonymise(data, SECRET, { keepNames: u.role === "coordinator" });
  const { monthlyWorkbook } = require("./wmfexport");
  const out = await monthlyWorkbook(data, { from: req.query.from, to: req.query.to, sponsor: u.role === "sponsor" });
  await audit(pool, actor(req), "wmf.export.monthly", "wmf_dashboard", `${out.from}..${out.to}`, null, null);
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="WMF-monthly-${out.from}-to-${out.to}.xlsx"`).send(out.buffer);
}));

// ======================= admin =======================
require("./admin")(app, { need, page, setFlash, actor, user, wrap, SECRET });
require("./corporate")(app, { need, page, setFlash, actor, user, wrap, limit });
require("./scanner")(app, { need, page, setFlash, actor, user, wrap, limit, checkIn, rideActivities, scanReply, calendar: require("./calendar") });
require("./department")(app, { need, page, setFlash, actor, user, wrap });
require("./deptschedule")(app, { need, page, setFlash, actor, user, wrap });
require("./calendar")(app, { need, page, setFlash, actor, user, wrap });
require("./dupes")(app, { need, page, setFlash, actor, user, wrap });
require("./activations")(app, { need, page, setFlash, actor, user, wrap });
require("./overview")(app, { need, page, setFlash, actor, user, wrap });
require("./newsletter")(app, { need, page, setFlash, actor, user, wrap });

// ======================= errors =======================
app.use((req, res) => res.status(404).send(page(req, "Not found", `<section class="card"><h2>Page not found</h2><p class="lead"><a href="/">Back to the start</a></p></section>`, { wide: false })));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  if (req.path.startsWith("/api/")) return res.status(500).json({ status: "error", message: "Something went wrong. Try again." });
  res.status(500).send(layout("Error", `<section class="card"><h2>Something went wrong</h2><p class="lead">Nothing was half-saved: changes are all-or-nothing. <a href="/">Back to the start</a></p></section>`, { user: user(req) }));
});

async function init() {
  await migrate();
  await tx((c) => R.ensureCoreRides(c));
  await require("./calendar").seed();
  await require("./corpdata").seedCompanies();
  await require("./corpdata").seedSchedules();
  await require("./deptschedule").seedTeam();
  const merged = await require("./dupes").autoMergeEmails("system"); // same email = same person
  if (merged) console.log(`Merged ${merged} duplicate member records (same email).`);
  await ensureAdmin();
}
async function ensureAdmin() {
  const n = Number((await pool.query("SELECT count(*) AS n FROM users")).rows[0].n);
  if (n) return;
  const email = R.normEmail(process.env.ADMIN_EMAIL), pw = process.env.ADMIN_PASSWORD;
  if (!email || !pw) { console.warn("No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first administrator."); return; }
  await pool.query("INSERT INTO users (email, name, role, password_hash, must_change) VALUES ($1, 'Administrator', 'admin', $2, true)", [email, await bcrypt.hash(pw, 11)]);
  await audit(pool, "system", "user.create", "user", email, null, { role: "admin" }, "First administrator from environment");
  console.log("Created the first administrator:", email);
}

if (require.main === module) {
  (async () => {
    await init();
    const port = +process.env.PORT || 3000;
    app.listen(port, () => console.log(`WMF Community System on port ${port}`));
  })().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { app, init, migrate, ensureAdmin, crypto, ROLE_TEXT };
