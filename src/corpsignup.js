"use strict";
/**
 * Corporate ride sign-up: one shared link per company (/ride/<token>) with that company's ride calendar.
 * Participants say they're coming, can book a rental bike (with their height) and see who else is coming.
 * Staff (Corporate → Sign-ups) set the rental bikes per ride, see the list, download it and send it to the bike shop on WhatsApp.
 */
const crypto = require("crypto");
const QRCode = require("qrcode");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const { h, fmtDate, monLabel, nf, table, raw } = require("./views");
const { addDays, addMonths } = require("./engine").helpers;

const AHEAD = 56; // how far ahead rides are open for sign-up (8 weeks)
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const sig = (s) => crypto.createHmac("sha256", process.env.SESSION_SECRET || "dev-only-secret").update("su|" + s).digest("base64url").slice(0, 16);
const dayLabel = (d) => `${DOW[new Date(d + "T12:00:00Z").getUTCDay()]} ${fmtDate(d)}`;
const short = (name) => { const w = String(name || "").trim().split(/\s+/); return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : w[0] || ""; };
const t12 = (t) => { if (!t) return ""; const [hh, mm] = String(t).split(":").map(Number); return `${hh % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${hh >= 12 ? "PM" : "AM"}`; };

/** The company's rides (and other sessions) between two dates, each with a stable key. */
async function ridesFor(co, from, to) {
  const out = [];
  for (const o of await C.occurrences(pool, [co.code], from, to)) {
    const s = o.session;
    out.push({ key: `${o.date}_sc${o.sc.id}`, date: o.date, title: C.schedName(o.sc, co), time: (s && s.start_time) || o.sc.start_time || "", where: (s && s.location) || o.sc.location || "",
      cancelled: !!(s && s.status === "Cancelled"), kind: o.sc.kind });
  }
  const seen = new Set(out.map((x) => x.date + "|" + x.title));
  const extra = (await pool.query("SELECT * FROM corp_sessions WHERE company = $1 AND session_date BETWEEN $2 AND $3 ORDER BY session_date, start_time NULLS LAST", [co.code, from, to])).rows;
  for (const s of extra) {
    const title = C.sessionName(s, co);
    if (seen.has(s.session_date + "|" + title) || out.some((x) => x.date === s.session_date && x.kind === s.kind)) continue;
    out.push({ key: `${s.session_date}_s${s.id}`, date: s.session_date, title, time: s.start_time || "", where: s.location || "", cancelled: s.status === "Cancelled", kind: s.kind });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.time).localeCompare(String(b.time)));
}
async function rideByKey(co, key) {
  const m = /^(\d{4}-\d{2}-\d{2})_s(c?)(\d+)$/.exec(String(key || ""));
  if (!m) return null;
  return (await ridesFor(co, m[1], m[1])).find((x) => x.key === key) || null;
}
async function rental(co, key) {
  return (await pool.query("SELECT * FROM corp_ride_rental WHERE company = $1 AND ride_key = $2", [co.code, key])).rows[0] || null;
}
async function signups(co, key) {
  return (await pool.query(`SELECT su.*, p.full_name, p.pid, p.email, p.mobile FROM corp_signups su JOIN corp_participants p ON p.id = su.participant_id
    WHERE su.company = $1 AND su.ride_key = $2 AND su.status = 'Coming' ORDER BY su.created_at`, [co.code, key])).rows;
}
/** Counts for many rides at once: coming and rentals per key. */
async function counts(co, keys) {
  const r = (await pool.query(`SELECT ride_key, count(*)::int n, count(*) FILTER (WHERE rent)::int bikes FROM corp_signups WHERE company = $1 AND ride_key = ANY($2) AND status = 'Coming' GROUP BY 1`, [co.code, keys])).rows;
  return Object.fromEntries(r.map((x) => [x.ride_key, x]));
}
const rentalOpen = (rt, taken) => !!(rt && rt.bikes > 0 && taken < rt.bikes && (!rt.closes_at || R.nowLocal().slice(0, 16) < rt.closes_at));
async function companyByToken(token) {
  return (await pool.query("SELECT * FROM corp_companies WHERE signup_token = $1 AND coalesce(active, true)", [String(token || "")])).rows[0] || null;
}
async function ensureToken(co) {
  if (co.signup_token) return co.signup_token;
  const t = crypto.randomBytes(9).toString("base64url");
  await pool.query("UPDATE corp_companies SET signup_token = $2 WHERE code = $1 AND signup_token IS NULL", [co.code, t]);
  return (await pool.query("SELECT signup_token FROM corp_companies WHERE code = $1", [co.code])).rows[0].signup_token;
}
const shopOf = async () => { const r = (await pool.query("SELECT value FROM settings WHERE key = 'rentalShop'")).rows[0]; return (r && r.value) || { name: "Wolfi's", phone: "" }; };

module.exports = function corpSignup(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const S = need("admin", "coordinator");

  // ---------- who is this? remembered on this phone after the first sign-up (signed, so it can't be faked)
  const cookieName = (co) => "rs_" + co.code;
  const whoFromCookie = async (req, co) => {
    const raw0 = String((req.headers.cookie || "").split(/;\s*/).find((c) => c.startsWith(cookieName(co) + "=")) || "").split("=")[1] || "";
    const [pid, s] = decodeURIComponent(raw0).split(".");
    if (!pid || !s || s !== sig("who|" + pid)) return null;
    return (await pool.query("SELECT * FROM corp_participants WHERE pid = $1 AND company = $2", [pid, co.code])).rows[0] || null;
  };
  const remember = (res, co, p) => res.append("Set-Cookie", `${cookieName(co)}=${encodeURIComponent(p.pid + "." + sig("who|" + p.pid))}; Path=/ride; Max-Age=${180 * 86400}; HttpOnly; SameSite=Lax${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);

  // ---------- public: the company's ride calendar and sign-up
  async function publicPage(req, res, co, { key, err, v = {}, askName = false, done } = {}) {
    const today = R.todayLocal(), rides = (await ridesFor(co, today, addDays(today, AHEAD))).filter((x) => !x.cancelled || x.date >= today);
    const m = /^\d{4}-\d{2}$/.test(req.query.m || "") ? req.query.m : (key ? key.slice(0, 7) : today.slice(0, 7));
    const me = await whoFromCookie(req, co);
    const sel = key ? rides.find((x) => x.key === key) : null;
    const cnt = await counts(co, rides.map((x) => x.key));
    const base = `/ride/${encodeURIComponent(co.signup_token)}`;
    // month grid
    const first = m + "-01", startG = addDays(first, -((new Date(first + "T12:00:00Z").getUTCDay() + 6) % 7));
    const byDay = new Map(); for (const x of rides) (byDay.get(x.date) || byDay.set(x.date, []).get(x.date)).push(x);
    let cells = ""; for (let i = 0; i < 42; i++) {
      const d = addDays(startG, i); if (i >= 35 && d.slice(0, 7) !== m) break;
      const list = byDay.get(d) || [], out = d.slice(0, 7) !== m;
      cells += list.length && !out ? `<a class="rs-d on${sel && sel.date === d ? " sel" : ""}${list.every((x) => x.cancelled) ? " off" : ""}" href="${base}?k=${encodeURIComponent(list[0].key)}#signup">${+d.slice(8)}</a>`
        : `<span class="rs-d${out ? " out" : ""}${d < today ? " past" : ""}">${+d.slice(8)}</span>`;
    }
    const minM = today.slice(0, 7), maxM = addDays(today, AHEAD).slice(0, 7);
    const nav = `<div class="rs-mh">${m > minM ? `<a class="btn tblbtn" href="${base}?m=${addMonths(m, -1)}" aria-label="Previous month">‹</a>` : "<span></span>"}<b>${h(monLabel(m, true))}</b>${m < maxM ? `<a class="btn tblbtn" href="${base}?m=${addMonths(m, 1)}" aria-label="Next month">›</a>` : "<span></span>"}</div>`;
    // the list under the calendar: this week's rides only (or the next ride when nothing is left this week); other dates are in the calendar
    const sunday = addDays(today, (7 - new Date(today + "T12:00:00Z").getUTCDay()) % 7);
    let week = rides.filter((x) => x.date >= today && x.date <= sunday); if (!week.length) week = rides.filter((x) => x.date >= today && !x.cancelled).slice(0, 1);
    const list = week.map((x) => { const c = cnt[x.key] || {};
      return `<a class="rs-ride${sel && sel.key === x.key ? " sel" : ""}${x.cancelled ? " off" : ""}" href="${base}?k=${encodeURIComponent(x.key)}#signup"><b>${h(dayLabel(x.date))}${x.time ? " · " + h(t12(x.time)) : ""}</b><span>${h(x.title)}${x.where ? " · " + h(x.where) : ""}</span><span class="muted">${x.cancelled ? "Cancelled" : `${nf(c.n || 0)} coming`}</span></a>`; }).join("")
      || '<p class="muted">No rides planned yet.</p>';
    // the chosen ride: sign-up form, or "you're in"
    let panel = "";
    if (sel) {
      const rt = await rental(co, sel.key), who = await signups(co, sel.key), taken = who.filter((x) => x.rent).length;
      const mine = me ? who.find((x) => x.participant_id === me.id) : null;
      const canRent = rentalOpen(rt, taken) || (mine && mine.rent);
      const whoList = who.length ? `<p class="rs-who"><b>Who's coming (${who.length})</b><br>${who.map((x) => h(short(x.full_name))).join(" · ")}</p>` : '<p class="muted">Nobody yet. Be the first!</p>';
      const rentLine = rt && rt.bikes > 0 ? `<p class="hint" style="margin:0">Rental bikes: ${nf(Math.max(0, rt.bikes - taken))} of ${nf(rt.bikes)} left${rt.price ? ` · AED ${nf(+rt.price)}` : ""}${rt.closes_at ? ` · book by ${h(dayLabel(rt.closes_at.slice(0, 10)))} ${h(t12(rt.closes_at.slice(11, 16)))}` : ""}</p>` : "";
      if (sel.cancelled) panel = `<h2>${h(dayLabel(sel.date))}</h2><p class="lead">This session is cancelled.</p>`;
      else if (mine) {
        panel = `<h2>You're in, ${h(String(mine.full_name).split(" ")[0])}!</h2><p class="lead">${h(dayLabel(sel.date))}${sel.time ? " · " + h(t12(sel.time)) : ""}${sel.where ? " · " + h(sel.where) : ""}</p>
          ${mine.rent ? `<p class="rs-ref">Rental bike booked · ref <b>${h(mine.ref)}</b> · height ${nf(mine.height_cm)} cm</p>` : `<p>Riding your own bike.</p>`}
          <p class="hint">Bring your personal QR code: <a href="${h(C.cqPath(me.pid))}">open my QR code</a>.</p>
          <form method="post" action="${base}/cancel"><input type="hidden" name="k" value="${h(sel.key)}"><button class="btn" data-confirm="Cancel your place${mine.rent ? " and your rental bike" : ""}?">Can't make it? Cancel my place</button></form>${whoList}`;
      } else {
        panel = `<h2>Sign up · ${h(dayLabel(sel.date))}</h2><p class="lead">${h(sel.title)}${sel.time ? " · " + h(t12(sel.time)) : ""}${sel.where ? " · " + h(sel.where) : ""}</p>
          ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
          <form class="form" method="post" action="${base}/signup" id="rsForm"><input type="hidden" name="k" value="${h(sel.key)}">
            ${me ? `<p style="margin:0">Signing up as <b>${h(me.full_name)}</b> (${h(me.pid)}). <a href="${base}/forget?k=${encodeURIComponent(sel.key)}">Not you?</a></p><input type="hidden" name="who" value="${h(me.pid)}">`
              : `<label>Your work email or ID<input name="who" required maxlength="160" value="${h(v.who || "")}" placeholder="name@company.com or ${h(co.code)}-0012" autocomplete="email"></label>
            ${askName ? `<p class="hint" style="margin:0">We couldn't find you on the ${h(co.name)} list. Add your name and mobile to join.</p>
              <label>Full name<input name="full_name" required maxlength="120" value="${h(v.full_name || "")}"></label>
              <label>Mobile<input name="mobile" maxlength="30" inputmode="tel" value="${h(v.mobile || "")}" placeholder="05x xxx xxxx"></label>` : ""}`}
            ${canRent ? `<fieldset class="rs-bike"><legend>Bike</legend>
              <label class="check"><input type="radio" name="rent" value="0" ${v.rent === "1" ? "" : "checked"}> <span>I'll bring my own bike</span></label>
              <label class="check"><input type="radio" name="rent" value="1" ${v.rent === "1" ? "checked" : ""}> <span>Rent a bike${rt.price ? ` (AED ${nf(+rt.price)})` : ""}</span></label>
              <label class="rs-h">Your height (cm) <span class="hint">needed for a rental bike</span><input name="height_cm" type="number" min="120" max="210" inputmode="numeric" value="${h(v.height_cm || "")}" placeholder="165"></label>${rentLine}</fieldset>`
              : rt && rt.bikes > 0 ? `<p class="hint">Rental bikes are fully booked${rt.closes_at && R.nowLocal().slice(0, 16) >= rt.closes_at ? " (booking has closed)" : ""}.</p>` : ""}
            <button class="btn primary big">I'm coming</button></form>${whoList}`;
      }
    }
    const shareMsg = `${co.name} cycling: sign up for our rides here ${req.protocol}://${req.get("host")}${base}`;
    res.set("Cache-Control", "no-store").send(page(req, `${co.name} rides`, `<section class="card rs-top"><div class="wc-eyebrow">${h(co.name)} cycling programme</div><h2 style="margin:4px 0 0">Ride sign-up</h2>
        <p class="lead" style="margin:4px 0 0">Pick a ride, tell us you're coming, and book a rental bike if you need one.</p></section>
      ${done ? `<div class="flash ok" role="status">${h(done)}</div>` : ""}
      <div class="rs-grid"><section class="card"><div class="rs-cal">${nav}<div class="rs-dow">${["M", "T", "W", "T", "F", "S", "S"].map((x) => `<span>${x}</span>`).join("")}</div><div class="rs-days">${cells}</div></div>
        <p class="hint" style="margin:12px 0 0">${week.length && week[0].date <= sunday ? "This week" : "Next ride"} · tap a date above for other rides</p><div class="rs-list" style="margin-top:6px">${list}</div></section>
      <section class="card" id="signup">${panel || '<p class="muted" style="margin:0">Tap a ride in the calendar to sign up.</p>'}</section></div>
      <p class="muted" style="text-align:center;font-size:12px">Cycling Development · <a href="https://wa.me/?text=${encodeURIComponent(shareMsg)}" target="_blank" rel="noopener">Share this page</a></p>`,
    { wide: false }));
  }
  app.get("/ride/:token", wrap(async (req, res) => {
    const co = await companyByToken(req.params.token);
    if (!co) return res.status(404).send(page(req, "Ride sign-up", `<section class="card"><h2>This link doesn't work</h2><p class="lead">Ask the programme team for the new link.</p></section>`, { wide: false }));
    let key = R.clean(req.query.k);
    if (!key) { const t = R.todayLocal(), next = (await ridesFor(co, t, addDays(t, AHEAD))).find((x) => !x.cancelled); if (next && !req.query.m) key = next.key; }
    await publicPage(req, res, co, { key, done: req.query.done === "1" ? "You're signed up. See you on the ride!" : req.query.done === "0" ? "Your place is cancelled." : "" });
  }));
  app.get("/ride/:token/forget", wrap(async (req, res) => {
    const co = await companyByToken(req.params.token); if (!co) return res.redirect("/");
    res.append("Set-Cookie", `${cookieName(co)}=; Path=/ride; Max-Age=0`);
    res.redirect(`/ride/${encodeURIComponent(co.signup_token)}?k=${encodeURIComponent(R.clean(req.query.k))}#signup`);
  }));
  const rl = limit ? limit("ridesignup", 120, 60 * 60e3) : (req, res, next) => next();
  app.post("/ride/:token/signup", rl, wrap(async (req, res) => {
    const co = await companyByToken(req.params.token); if (!co) return res.status(404).send("Not found");
    const b = req.body || {}, key = R.clean(b.k), ride = await rideByKey(co, key), today = R.todayLocal();
    if (!ride || ride.cancelled || ride.date < today || ride.date > addDays(today, AHEAD)) return publicPage(req, res, co, { key, err: "That ride isn't open for sign-up." });
    const again = (err, askName) => publicPage(req, res, co, { key, err, v: b, askName });
    // who: remembered on this phone, an ID, or a work email; new people join with name and mobile
    const whoTxt = R.clean(b.who), pid = C.pidFromScan(whoTxt), mail = R.normEmail(whoTxt);
    let p = (await whoFromCookie(req, co));
    if (!p || (whoTxt && whoTxt !== p.pid)) {
      p = null;
      if (pid) p = (await pool.query("SELECT * FROM corp_participants WHERE pid = $1 AND company = $2", [pid, co.code])).rows[0] || null;
      else if (R.EMAIL_RE.test(mail || "")) p = await C.findParticipant(pool, co.code, { email: mail });
      else return again("Enter your work email or your ID.");
    }
    if (!p) {
      if (pid) return again(`${pid} isn't on the ${co.name} list. Check the number, or use your work email.`);
      const doms = String(co.email_domain || "").toLowerCase().split(/[\s,;]+/).map((d) => d.replace(/^@/, "")).filter(Boolean);
      if (doms.length && !doms.some((d) => mail.endsWith("@" + d))) return again(`Use your ${co.name} work email (${doms.join(", ")}).`);
      if (co.qr_access === "list") return again(`You're not on the ${co.name} list yet. Please ask the programme team to add you.`);
      if (R.clean(b.full_name).length < 3) return again("", true);
      p = await tx(async (c) => {
        const np = await C.createParticipant(c, { company: co.code, full_name: b.full_name, email: mail }, "Ride sign-up", "Ride sign-up");
        const ph = R.normPhone(b.mobile); return ph ? (await c.query("UPDATE corp_participants SET mobile = $2 WHERE id = $1 RETURNING *", [np.id, ph])).rows[0] : np;
      });
    }
    const rent = b.rent === "1", height = Math.round(+b.height_cm || 0);
    if (rent && (height < 120 || height > 210)) return again("Add your height in cm (for example 165) so the bike fits you.");
    const out = await tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [co.code + key]); // one booking at a time per ride
      const rt = (await c.query("SELECT * FROM corp_ride_rental WHERE company = $1 AND ride_key = $2", [co.code, key])).rows[0];
      const cur = (await c.query("SELECT * FROM corp_signups WHERE ride_key = $1 AND participant_id = $2", [key, p.id])).rows[0];
      const taken = (await c.query("SELECT count(*)::int n FROM corp_signups WHERE company = $1 AND ride_key = $2 AND status = 'Coming' AND rent AND participant_id <> $3", [co.code, key, p.id])).rows[0].n;
      if (rent && !(cur && cur.rent && cur.status === "Coming") && !rentalOpen(rt, taken)) return { err: "Sorry, the rental bikes for this ride are fully booked. You can still come on your own bike." };
      let ref = cur && cur.ref;
      if (rent && !ref) { const n = (await c.query("SELECT count(*)::int n FROM corp_signups WHERE company = $1 AND ride_key = $2 AND ref IS NOT NULL", [co.code, key])).rows[0].n + 1; ref = `${co.code}-${ride.date.slice(5, 7)}${ride.date.slice(8)}-${String(n).padStart(2, "0")}`; }
      await c.query(`INSERT INTO corp_signups (company, ride_key, ride_date, participant_id, rent, height_cm, ref, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'Coming')
        ON CONFLICT (ride_key, participant_id) DO UPDATE SET rent = $5, height_cm = $6, ref = coalesce(corp_signups.ref, $7), status = 'Coming', updated_at = now()`,
      [co.code, key, ride.date, p.id, rent, rent ? height : null, rent ? ref : null]);
      await audit(c, "Ride sign-up", "corp.signup", "corp_participant", p.pid, null, { ride: key, rent, height: rent ? height : undefined });
      return {};
    });
    if (out.err) return again(out.err);
    remember(res, co, p);
    res.redirect(303, `/ride/${encodeURIComponent(co.signup_token)}?k=${encodeURIComponent(key)}&done=1#signup`);
  }));
  app.post("/ride/:token/cancel", rl, wrap(async (req, res) => {
    const co = await companyByToken(req.params.token); if (!co) return res.status(404).send("Not found");
    const key = R.clean((req.body || {}).k), me = await whoFromCookie(req, co);
    if (me) {
      await pool.query("UPDATE corp_signups SET status = 'Cancelled', rent = FALSE, updated_at = now() WHERE company = $1 AND ride_key = $2 AND participant_id = $3", [co.code, key, me.id]);
      await audit(pool, "Ride sign-up", "corp.signup.cancel", "corp_participant", me.pid, null, { ride: key });
    }
    res.redirect(303, `/ride/${encodeURIComponent(co.signup_token)}?k=${encodeURIComponent(key)}&done=0#signup`);
  }));

  // ---------- staff: share the link, set rental bikes, see who's coming, send the rental list
  async function scope(req) {
    const list = await C.companiesFor(user(req));
    return { list, co: list.find((x) => x.code === req.query.company) || list[0] || null };
  }
  const coSelect = (sc) => `<form class="toolbar noprint" method="get" style="margin:0"><label class="f"><span>Company</span><select class="inp" name="company" data-autosubmit>${sc.list.map((x) => `<option value="${h(x.code)}" ${x.code === sc.co.code ? "selected" : ""}>${h(x.name)}</option>`).join("")}</select></label></form>`;
  const wolfiMsg = (co, ride, list) => `Hi ${"{shop}"} team,\nBike rental booking for the ${co.name} ride, ${dayLabel(ride.date)}${ride.time ? ", " + t12(ride.time) : ""}${ride.where ? ", " + ride.where : ""}.\n${list.length} bike${list.length === 1 ? "" : "s"}:\n${list.map((x, i) => `${i + 1}. ${x.ref} · ${x.full_name} · ${x.height_cm} cm`).join("\n")}\nPlease confirm. Thank you!`;

  app.get("/corporate/signups", S, wrap(async (req, res) => {
    const sc = await scope(req); if (!sc.co) return res.redirect("/corporate");
    const co = sc.co, token = await ensureToken(co), link = `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "")}/ride/${token}`;
    const qr = await QRCode.toDataURL(link, { margin: 1, width: 320 });
    const today = R.todayLocal(), rides = await ridesFor(co, today, addDays(today, AHEAD)), cnt = await counts(co, rides.map((x) => x.key));
    const rts = Object.fromEntries((await pool.query("SELECT * FROM corp_ride_rental WHERE company = $1 AND ride_date >= $2", [co.code, today])).rows.map((x) => [x.ride_key, x]));
    const shop = await shopOf();
    const msg = `Hi ladies! Sign up for the ${co.name} rides here and book a rental bike if you need one: ${link}`;
    res.send(page(req, "Ride sign-ups", `<div class="card-head"><div><h2 style="font-size:22px">Ride sign-ups</h2><p class="muted" style="margin:2px 0 0">Participants sign up for rides, book rental bikes and see who's coming.</p></div>${coSelect(sc)}</div>
      <div class="grid"><section class="card c8"><h2>${h(co.name)}: upcoming rides</h2>
        ${table(["Date", "Session", "Coming", "Rental bikes", ""], rides.map((x) => { const c = cnt[x.key] || {}, rt = rts[x.key];
          return [dayLabel(x.date) + (x.time ? " · " + t12(x.time) : ""), raw(`${h(x.title)}${x.cancelled ? ' <span class="badge">Cancelled</span>' : ""}`), nf(c.n || 0), rt && rt.bikes ? `${nf(c.bikes || 0)} of ${nf(rt.bikes)}` : (c.bikes ? nf(c.bikes) : "—"),
            raw(`<a class="btn tblbtn" href="/corporate/signups/${encodeURIComponent(co.code)}/${encodeURIComponent(x.key)}">Open</a>`)]; }), { num: [2], empty: "No rides in the next 8 weeks. Add them on Corporate → Schedule." })}</section>
      <section class="card c4"><h2>Share with ${h(co.name)}</h2><p class="lead">One link for everyone at ${h(co.name)}. No sign-in: they use their work email or ID.</p>
        <div class="sc-row"><input class="inp" value="${h(link)}" readonly aria-label="Sign-up link"><button class="btn" type="button" data-copy="${h(link)}">Copy</button></div>
        <div class="toolbar" style="margin:10px 0 0"><a class="btn primary" href="https://wa.me/?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Share on WhatsApp</a><a class="btn" href="${qr}" download="${h(co.code)}-ride-signup-QR.png">QR code</a><a class="btn" href="${h(link)}" target="_blank" rel="noopener">Open</a></div>
        <h2 style="margin-top:18px">Bike rental shop</h2>
        <form class="form" method="post" action="/corporate/signups/shop"><input type="hidden" name="company" value="${h(co.code)}">
          <label>Shop name<input name="name" maxlength="60" value="${h(shop.name || "")}"></label>
          <label>WhatsApp number <span class="hint">(the rental list goes straight to this chat)</span><input name="phone" maxlength="30" inputmode="tel" value="${h(shop.phone || "")}" placeholder="+971 5x xxx xxxx"></label>
          <button class="btn">Save</button></form></section></div>`, { active: "/corporate/signups" }));
  }));
  app.post("/corporate/signups/shop", S, wrap(async (req, res) => {
    const b = req.body || {}, v = { name: R.clean(b.name).slice(0, 60) || "Wolfi's", phone: R.normPhone(b.phone) || "" };
    await pool.query("INSERT INTO settings (key, value) VALUES ('rentalShop', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(v)]);
    await audit(pool, actor(req), "corp.rentalShop", "settings", "rentalShop", null, v);
    setFlash(req, "ok", "Bike rental shop saved.");
    res.redirect("/corporate/signups?company=" + encodeURIComponent(R.clean(b.company)));
  }));
  async function loadRide(req) {
    const list = await C.companiesFor(user(req)), co = list.find((x) => x.code === req.params.code);
    if (!co) return null;
    const ride = await rideByKey(co, req.params.key);
    return ride ? { co, ride } : null;
  }
  app.get("/corporate/signups/:code/:key", S, wrap(async (req, res) => {
    const L = await loadRide(req); if (!L) return res.redirect("/corporate/signups");
    const { co, ride } = L, rt = await rental(co, ride.key), who = await signups(co, ride.key), bikes = who.filter((x) => x.rent), shop = await shopOf();
    const base = `/corporate/signups/${encodeURIComponent(co.code)}/${encodeURIComponent(ride.key)}`;
    const msg = wolfiMsg(co, ride, bikes).replace("{shop}", shop.name || "Wolfi's") + `\n${(user(req).name || "").split(" ")[0] || "Cycling Development"} · Cycling Development`;
    res.send(page(req, "Ride sign-ups", `<p class="muted" style="margin:0 0 6px"><a href="/corporate/signups?company=${h(co.code)}">‹ All rides</a></p>
      <div class="card-head"><div><h2 style="font-size:22px">${h(co.name)} · ${h(dayLabel(ride.date))}</h2><p class="muted" style="margin:2px 0 0">${h(ride.title)}${ride.time ? " · " + h(t12(ride.time)) : ""}${ride.where ? " · " + h(ride.where) : ""} · ${nf(who.length)} coming · ${nf(bikes.length)} rental bike${bikes.length === 1 ? "" : "s"}</p></div></div>
      <div class="grid"><section class="card c4"><h2>Bike rental for this ride</h2><p class="lead">Set how many rental bikes are available. Participants can book until they're gone or booking closes.</p>
        <form class="form" method="post" action="${base}/rental">
          <label>Rental bikes available<input type="number" name="bikes" min="0" max="200" value="${h(rt ? rt.bikes : 0)}"></label>
          <label>Price per bike, AED <span class="hint">(optional, shown to them)</span><input type="number" name="price" min="0" step="1" value="${h(rt && rt.price != null ? +rt.price : "")}"></label>
          <label>Booking closes <span class="hint">(optional)</span><input type="datetime-local" name="closes_at" value="${h(rt && rt.closes_at ? rt.closes_at : "")}"></label>
          <button class="btn primary">Save</button></form></section>
      <section class="card c8"><div class="si-top"><h2>Rental list for ${h(shop.name || "the shop")} (${nf(bikes.length)})</h2>
        <div class="toolbar" style="margin:0">${bikes.length ? `<a class="btn" href="${base}/rentals.xlsx">Download Excel</a><a class="btn primary" href="https://wa.me/${h(shop.phone || "")}?text=${encodeURIComponent(msg)}" target="_blank" rel="noopener">Send to ${h(shop.name || "shop")} on WhatsApp</a>` : ""}</div></div>
        ${table(["Ref", "Name", "ID", "Height"], bikes.map((x) => [x.ref, x.full_name, x.pid, `${nf(x.height_cm)} cm`]), { empty: "No rental bikes booked yet." })}
        ${bikes.length ? `<details style="margin-top:10px"><summary class="hint">See the WhatsApp message</summary><pre class="rs-msg">${h(msg)}</pre></details>` : ""}${shop.phone ? "" : `<p class="hint">Add the shop's WhatsApp number on <a href="/corporate/signups?company=${h(co.code)}">Ride sign-ups</a> so the message opens in their chat.</p>`}</section>
      <section class="card c12"><h2>Who's coming (${nf(who.length)})</h2>
        ${table(["Name", "ID", "Bike", "Signed up", ""], who.map((x) => [x.full_name, x.pid, x.rent ? `Rental · ${x.ref} · ${nf(x.height_cm)} cm` : "Own bike", require("./views").fmtTs(x.created_at),
          raw(`<form method="post" action="${base}/remove" style="display:inline"><input type="hidden" name="id" value="${x.id}"><button class="btn tblbtn" data-confirm="Remove ${h(x.full_name)} from this ride?">Remove</button></form>`)]), { empty: "Nobody has signed up yet. Share the link from Ride sign-ups." })}</section></div>`, { active: "/corporate/signups" }));
  }));
  app.post("/corporate/signups/:code/:key/rental", S, wrap(async (req, res) => {
    const L = await loadRide(req); if (!L) return res.redirect("/corporate/signups");
    const b = req.body || {}, bikes = Math.max(0, Math.min(200, Math.round(+b.bikes || 0))), price = b.price === "" || b.price == null ? null : Math.max(0, +b.price || 0);
    const closes = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(b.closes_at || "") ? b.closes_at : null;
    await pool.query(`INSERT INTO corp_ride_rental (company, ride_key, ride_date, bikes, price, closes_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (company, ride_key) DO UPDATE SET bikes = $4, price = $5, closes_at = $6`, [L.co.code, L.ride.key, L.ride.date, bikes, price, closes]);
    await audit(pool, actor(req), "corp.rental.set", "corp_ride", `${L.co.code}:${L.ride.key}`, null, { bikes, price, closes });
    setFlash(req, "ok", bikes ? `${bikes} rental bike${bikes === 1 ? "" : "s"} open for booking.` : "Rental bikes switched off for this ride.");
    res.redirect(`/corporate/signups/${encodeURIComponent(L.co.code)}/${encodeURIComponent(L.ride.key)}`);
  }));
  app.post("/corporate/signups/:code/:key/remove", S, wrap(async (req, res) => {
    const L = await loadRide(req); if (!L) return res.redirect("/corporate/signups");
    const r = (await pool.query("UPDATE corp_signups SET status = 'Cancelled', rent = FALSE, updated_at = now() WHERE id = $1 AND company = $2 AND ride_key = $3 RETURNING *", [+(req.body || {}).id || 0, L.co.code, L.ride.key])).rows[0];
    if (r) await audit(pool, actor(req), "corp.signup.remove", "corp_signup", String(r.id), null, { ride: L.ride.key });
    setFlash(req, "ok", "Removed from this ride.");
    res.redirect(`/corporate/signups/${encodeURIComponent(L.co.code)}/${encodeURIComponent(L.ride.key)}`);
  }));
  app.get("/corporate/signups/:code/:key/rentals.xlsx", S, wrap(async (req, res) => {
    const L = await loadRide(req); if (!L) return res.status(404).send("Not found");
    const bikes = (await signups(L.co, L.ride.key)).filter((x) => x.rent), ExcelJS = require("exceljs"), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Rental bikes");
    ws.addRow([`${L.co.name} ride · ${dayLabel(L.ride.date)}${L.ride.time ? " · " + t12(L.ride.time) : ""}${L.ride.where ? " · " + L.ride.where : ""}`]).font = { bold: true, size: 13 };
    ws.addRow([`${bikes.length} rental bike${bikes.length === 1 ? "" : "s"}`]); ws.addRow([]);
    const hr = ws.addRow(["#", "Booking ref", "Name", "Height (cm)"]); hr.font = { bold: true };
    bikes.forEach((x, i) => ws.addRow([i + 1, x.ref, x.full_name, x.height_cm]));
    ws.columns = [{ width: 5 }, { width: 18 }, { width: 32 }, { width: 13 }];
    res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${L.co.code}-rental-bikes-${L.ride.date}.xlsx"` });
    res.send(Buffer.from(await wb.xlsx.writeBuffer()));
  }));
};
module.exports.ridesFor = ridesFor;
