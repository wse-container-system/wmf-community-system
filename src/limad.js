"use strict";
/**
 * L'imad programme dashboard (/corporate/limad): the L'imad view of the corporate programme, in five tabs.
 *   Overview · Department League (can be switched off) · Registration (form + QR code) · Annual framework · Reports
 * The registration form also works on its own for sharing by QR code or link: /corporate/limad/register (no sign-in).
 * Everything reads the same corporate tables as the rest of Corporate (participants, sessions, attendance), filtered to L'imad.
 */
const QRCode = require("qrcode");
const ExcelJS = require("exceljs");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const { h, fmtDate, nf, table, raw, STAFF, ALL } = require("./views");
const { addDays } = require("./engine").helpers;

const CODE = "LIMAD";
const LEVELS = [
  { n: 0, name: "Curious", quote: "I don't cycle.", text: "Discover cycling without pressure: events, talks and team experiences." },
  { n: 1, name: "Try", quote: "I'm interested, but not confident.", text: "Beginner-friendly sessions: bike basics, confidence and first rides." },
  { n: 2, name: "Ride", quote: "I'd like to ride socially.", text: "Regular group rides at a predictable, social pace." },
  { n: 3, name: "Develop", quote: "I'm ready to progress.", text: "A structured pathway: skills, endurance and confidence." },
];
// Departments are typed in by people as they register; the form suggests the ones already entered so the same department is spelled the same way.
const deptKey = (s) => R.clean(s).toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim();
const DAYS = ["Tuesday evening", "Thursday", "Both", "Not sure yet"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
// Department League: points per activity, as in the 20 Nov proposal. Rides and sessions come from attendance; the last three are awarded by staff.
const POINTS = [
  { key: "101", label: "Attend Cycling 101", pts: 10, auto: true },
  { key: "maint", label: "Attend a maintenance workshop", pts: 10, auto: true },
  { key: "first", label: "Complete first ride", pts: 20, auto: true },
  { key: "social", label: "Attend a social ride", pts: 15, auto: true },
  { key: "other", label: "Any other workshop, talk or activity", pts: 10, auto: true },
  { key: "academy", label: "Complete Cycling Academy", pts: 50 },
  { key: "bring", label: "Bring a first-time participant", pts: 20 },
  { key: "ambassador", label: "Volunteer or ambassador activity", pts: 20 },
];
const PT = Object.fromEntries(POINTS.map((p) => [p.key, p]));
const TABS = [["overview", "Overview"], ["league", "Department League"], ["register", "Registration"], ["framework", "Annual framework"], ["reports", "Reports"]];

const opt = (v, label, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? "selected" : ""}>${h(label)}</option>`;
const t12 = (t) => { if (!t) return ""; const [hh, mm] = String(t).split(":").map(Number); return `${hh % 12 || 12}${mm ? ":" + String(mm).padStart(2, "0") : ""} ${hh >= 12 ? "PM" : "AM"}`; };
/** The programme year runs August to July (Preparation, Peak, Momentum). */
function seasonOf(today = R.todayLocal()) {
  const y = +today.slice(0, 4), m = +today.slice(5, 7), y0 = m >= 8 ? y : y - 1;
  return { start: `${y0}-08-01`, end: `${y0 + 1}-07-31`, label: `${y0}/${String(y0 + 1).slice(2)}`, y0 };
}
/** Which group a schedule is for: Tuesday = newer riders, Thursday = established riders. */
const groupOf = (weekday) => (weekday === 2 ? { name: "Newer riders", levels: "Level 0–1" } : weekday === 4 ? { name: "Established riders", levels: "Level 2–3" } : null);

async function company() { return (await pool.query("SELECT * FROM corp_companies WHERE code = $1", [CODE])).rows[0] || null; }
/** Departments people have entered so far, one spelling each (the most used), A to Z. */
async function departments(c = pool) {
  const r = (await c.query("SELECT department d, count(*)::int n FROM corp_participants WHERE company = $1 AND coalesce(trim(department), '') <> '' GROUP BY 1 ORDER BY 2 DESC, 1", [CODE])).rows;
  const by = new Map(); for (const x of r) { const k = deptKey(x.d); if (k && !by.has(k)) by.set(k, R.clean(x.d)); }
  return [...by.values()].sort((a, b) => a.localeCompare(b));
}
async function leagueOn() { const r = (await pool.query("SELECT value FROM settings WHERE key = 'limadLeague'")).rows[0]; return !!(r && r.value && r.value.on); }
const domains = (co) => String(co.email_domain || "").toLowerCase().split(/[\s,;]+/).map((d) => d.replace(/^@/, "")).filter(Boolean);
const domainOk = (co, email) => !domains(co).length || domains(co).some((d) => email.endsWith("@" + d));

/** Overview figures: registered, active this month, 90-day retention, departments and riders per level. */
async function overview(today = R.todayLocal()) {
  const ps = (await pool.query("SELECT id, department, cycling_level, status FROM corp_participants WHERE company = $1", [CODE])).rows;
  const att = (await pool.query(`SELECT a.participant_id pid, s.session_date::text d FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id
    WHERE s.company = $1 AND s.status = 'Held' ORDER BY s.session_date`, [CODE])).rows;
  const by = new Map(); for (const a of att) (by.get(a.pid) || by.set(a.pid, []).get(a.pid)).push(a.d);
  const month = today.slice(0, 7);
  const activeMonth = new Set(att.filter((a) => a.d.startsWith(month)).map((a) => a.pid)).size;
  // retention: came back for another session within 90 days of their first (people whose first session was under 90 days ago count once they return)
  let base = 0, back = 0;
  for (const ds of by.values()) {
    const first = ds[0], again = ds.find((d) => d > first && d <= addDays(first, 90));
    if (again) { base++; back++; } else if (addDays(first, 90) < today) base++;
  }
  const depts = new Set(ps.map((p) => deptKey(p.department)).filter(Boolean));
  const levels = LEVELS.map((l) => ({ ...l, count: ps.filter((p) => p.status === "Active" && p.cycling_level === l.n).length }));
  return { registered: ps.length, active: ps.filter((p) => p.status === "Active").length, activeMonth, retention: base ? back / base : null, retBase: base, retBack: back,
    depts: depts.size, levels, noLevel: ps.filter((p) => p.status === "Active" && p.cycling_level == null).length, everAttended: by.size };
}

/** Department League for the programme year: points from attendance plus points awarded by staff. */
async function league(se = seasonOf()) {
  const ps = (await pool.query("SELECT id, department FROM corp_participants WHERE company = $1", [CODE])).rows;
  const names = new Map(); for (const d of await departments()) names.set(deptKey(d), d);
  const dept = new Map(ps.map((p) => { const k = deptKey(p.department); return [p.id, k ? names.get(k) || R.clean(p.department) : ""]; }));
  const att = (await pool.query(`SELECT a.participant_id pid, s.session_date::text d, s.kind, s.title FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id
    WHERE s.company = $1 AND s.status = 'Held' AND s.session_date <= $2 ORDER BY s.session_date, s.id`, [CODE, se.end])).rows;
  const extra = (await pool.query(`SELECT cp.*, p.full_name, p.department FROM corp_points cp JOIN corp_participants p ON p.id = cp.participant_id
    WHERE p.company = $1 AND cp.awarded_on BETWEEN $2 AND $3 ORDER BY cp.awarded_on DESC, cp.id DESC`, [CODE, se.start, se.end])).rows;
  const rows = new Map(), firstRide = new Set();
  const add = (pid, key, pts) => {
    const d = dept.get(pid) || "";
    const r = rows.get(d) || rows.set(d, { dept: d, points: 0, people: new Set(), byKey: {} }).get(d);
    r.points += pts; r.people.add(pid); r.byKey[key] = (r.byKey[key] || 0) + pts;
  };
  for (const a of att) {
    const ride = a.kind === C.RIDE;
    let key = ride ? (firstRide.has(a.pid) ? "social" : "first") : /\b101\b/.test(a.title || "") ? "101" : /maint/i.test(a.title || "") ? "maint" : "other";
    if (ride) firstRide.add(a.pid); // the first ride ever counts as the first ride, even before this season
    if (a.d >= se.start) add(a.pid, key, PT[key].pts);
  }
  for (const x of extra) add(x.participant_id, x.kind, x.points);
  const registered = new Map(); for (const d of dept.values()) registered.set(d, (registered.get(d) || 0) + 1);
  for (const [d] of registered) if (!rows.has(d)) rows.set(d, { dept: d, points: 0, people: new Set(), byKey: {} });
  const named = [...rows.values()].filter((r) => r.dept).sort((a, b) => b.points - a.points || b.people.size - a.people.size || a.dept.localeCompare(b.dept));
  let rank = 0, prev = null;
  named.forEach((r, i) => { if (r.points !== prev) rank = i + 1; prev = r.points; r.rank = rank; r.registered = registered.get(r.dept) || 0; });
  const unset = rows.get("");
  return { rows: named, unset: unset && (unset.points || registered.get("")) ? { ...unset, registered: registered.get("") || 0 } : null, extra };
}

/** Registration form (public and inside the dashboard). */
function regForm(co, scheds, depts, v = {}, err, { action = "/corporate/limad/register" } = {}) {
  const tue = scheds.find((s) => s.weekday === 2), thu = scheds.find((s) => s.weekday === 4);
  const dayHint = { "Tuesday evening": tue ? `${t12(tue.start_time)} · newer riders, Level 0–1` : "newer riders, Level 0–1", Thursday: thu ? `${t12(thu.start_time)} · established riders, Level 2–3` : "established riders, Level 2–3", Both: "come to either ride", "Not sure yet": "we'll help you choose" };
  const radio = (name, value, label, hint, cur) => `<label class="lm-choice"><input type="radio" name="${name}" value="${h(value)}" ${String(cur) === String(value) ? "checked" : ""} required><span><b>${h(label)}</b>${hint ? `<small>${h(hint)}</small>` : ""}</span></label>`;
  return `<form class="form lm-form" method="post" action="${h(action)}">
    ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <fieldset><legend>About you</legend>
      <label>Full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
      <div class="row2"><label>${h(co.name)} work email${domains(co).length ? ` <span class="hint">(ending ${h(domains(co).map((d) => "@" + d).join(" or "))})</span>` : ""}<input name="email" type="email" required maxlength="160" value="${h(v.email)}" autocomplete="email"></label>
      <label>Mobile / WhatsApp<input name="mobile" type="tel" required maxlength="30" value="${h(v.mobile)}" autocomplete="tel" placeholder="+971 5x xxx xxxx"></label></div>
      <label>Department <span class="hint">(type it, or pick one colleagues have already entered)</span><input name="department" required maxlength="80" list="lm-depts" value="${h(v.department)}" autocomplete="organization-title" placeholder="e.g. Finance"></label>
      <datalist id="lm-depts">${depts.map((d) => `<option value="${h(d)}">`).join("")}</datalist></fieldset>
    <fieldset><legend>Your cycling experience</legend><div class="lm-choices">
      ${LEVELS.map((l) => radio("cycling_level", l.n, `Level ${l.n} · ${l.name}`, `“${l.quote}” ${l.text}`, v.cycling_level)).join("")}</div></fieldset>
    <fieldset><legend>Preferred riding day</legend><div class="lm-choices two">
      ${DAYS.map((d) => radio("preferred_day", d, d, dayHint[d], v.preferred_day)).join("")}</div></fieldset>
    <fieldset><legend>Bike and kit</legend><div class="row2">
      <label>Do you have your own road bike?<select name="has_own_bike" required><option value="">Choose</option>${opt("yes", "Yes", v.has_own_bike)}${opt("no", "No, I'll need one", v.has_own_bike)}</select></label>
      <label>T-shirt size<select name="tshirt_size" required><option value="">Choose</option>${SIZES.map((s) => opt(s, s, v.tshirt_size)).join("")}</select></label></div></fieldset>
    <fieldset><legend>Emergency contact</legend><div class="row2">
      <label>Name<input name="emergency_contact_name" required maxlength="120" value="${h(v.emergency_contact_name)}"></label>
      <label>Phone number<input name="emergency_contact_phone" type="tel" required maxlength="30" value="${h(v.emergency_contact_phone)}"></label></div></fieldset>
    <label class="check"><input type="checkbox" name="consent" value="1" required ${v.consent ? "checked" : ""}> <span>I agree to take part at my own risk, to follow the ride leader's safety instructions, and for my details and attendance to be used to run and report on the ${h(co.name)} cycling programme. Reports for ${h(co.name)} management show totals only.</span></label>
    <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
    <button class="btn primary big lm-btn">Register and get my QR code</button></form>`;
}

module.exports = function limad(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const V = need(...ALL), S = need(...STAFF);
  const regUrl = (req) => `${req.protocol}://${req.get("host")}/corporate/limad/register`;
  const guard = (req, res) => { const u = user(req); if (u && u.company && u.company !== CODE) { res.redirect("/corporate"); return false; } return true; };
  const notReady = (req) => page(req, "L'imad", `<section class="card"><h2>L'imad isn't set up yet</h2><p class="lead">Add the company on Corporate → Admin first.</p></section>`, { active: "/corporate/limad" });

  // ===================================================== dashboard
  app.get("/corporate/limad", V, wrap(async (req, res) => {
    if (!guard(req, res)) return;
    const co = await company(); if (!co) return res.send(notReady(req));
    const u = user(req), named = STAFF.includes(u.role), on = await leagueOn();
    const tabs = TABS.filter(([k]) => k !== "league" || on || named);
    const tab = tabs.some(([k]) => k === req.query.tab) ? req.query.tab : "overview";
    const today = R.todayLocal(), se = seasonOf(today);
    const scheds = await C.schedules(pool, [CODE]);
    let body = "";

    if (tab === "overview") {
      const o = await overview(today);
      const occ = await C.occurrences(pool, [CODE], today, addDays(today, 21));
      const extra = (await pool.query("SELECT * FROM corp_sessions WHERE company = $1 AND session_date BETWEEN $2 AND $3 ORDER BY session_date", [CODE, today, addDays(today, 21)])).rows
        .filter((s) => !occ.some((x) => x.session && x.session.id === s.id));
      const up = [...occ.map((x) => ({ d: x.date, name: C.schedName(x.sc, co), time: (x.session && x.session.start_time) || x.sc.start_time, grp: x.sc.kind === C.RIDE ? groupOf(x.sc.weekday) : null, cancelled: x.session && x.session.status === "Cancelled", id: x.session && x.session.id })),
        ...extra.map((s) => ({ d: s.session_date, name: C.sessionName(s, co), time: s.start_time, grp: null, cancelled: s.status === "Cancelled", id: s.id }))].sort((a, b) => a.d.localeCompare(b.d) || String(a.time).localeCompare(String(b.time))).slice(0, 8);
      const slot = (wd, fallback) => { const s = scheds.find((x) => x.weekday === wd && x.kind === C.RIDE), g = groupOf(wd);
        return `<div class="lm-slot${s ? "" : " off"}"><span class="lm-eyebrow">${h(g.levels)}</span><b>${h(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][wd])}${s && s.start_time ? " · " + h(t12(s.start_time)) : ""}</b><span>${h(g.name)}</span><small class="muted">${s ? h(s.location || co.location || "Meeting point to be confirmed") : h(fallback)}</small></div>`; };
      const total = o.levels.reduce((a, l) => a + l.count, 0) || 1;
      body = `<div class="tiles lm-tiles">
          <div class="tile big"><span class="lbl">Total registered</span><span class="val">${nf(o.registered)}</span><span class="note">${nf(o.active)} active on the list</span></div>
          <div class="tile big"><span class="lbl">Active this month</span><span class="val">${nf(o.activeMonth)}</span><span class="note">Came to a session in ${h(fmtDate(today).replace(/^\d+ /, ""))}</span></div>
          <div class="tile big"><span class="lbl">Retention rate</span><span class="val">${o.retention == null ? "—" : Math.round(o.retention * 100) + "%"}</span><span class="note">${o.retBase ? `${nf(o.retBack)} of ${nf(o.retBase)} returned within 90 days` : "Returning within 90 days of a first session"}</span></div>
          <div class="tile big"><span class="lbl">Departments represented</span><span class="val">${nf(o.depts)}</span><span class="note">From the registration form</span></div></div>
        <div class="grid" style="margin-top:14px">
          <section class="card c12"><div class="card-head"><div><h2>Participation by level</h2><p class="lead">Active riders by the level they chose when registering. Different starting points, one shared cycling culture.</p></div></div>
            <div class="lm-levels">${o.levels.map((l) => `<div class="lm-level l${l.n}"><span class="lm-eyebrow">Level ${l.n}</span><b>${h(l.name)}</b><span class="lm-num">${nf(l.count)}</span><i style="--w:${Math.round((l.count / total) * 100)}%"></i><small>“${h(l.quote)}”</small></div>`).join("")}</div>
            ${o.noLevel ? `<p class="hint" style="margin:10px 0 0">${nf(o.noLevel)} active ${o.noLevel === 1 ? "person has" : "people have"} no level yet (added before the registration form). They get one when they fill in the form.</p>` : ""}</section>
          <section class="card c5"><h2>Weekly rides</h2><p class="lead">Two rides a week so newer riders and established riders each have a group that fits. Day and time can change once L'imad shares its other activities.</p>
            <div class="lm-slots">${slot(2, "Not on the schedule yet")}${slot(4, "Not on the schedule yet")}</div>
            ${named ? `<p style="margin:10px 0 0"><a href="/corporate/schedule">Change the schedule</a></p>` : ""}</section>
          <section class="card c7"><h2>Upcoming rides &amp; events</h2><p class="lead">The next three weeks.</p>
            ${up.length ? `<ul class="lm-up">${up.map((x) => `<li><span class="lm-date"><b>${h(String(+x.d.slice(8)))}</b>${h(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+x.d.slice(5, 7) - 1])}</span>
              <span class="lm-what"><b>${named && x.id ? `<a href="/corporate/session/${x.id}">${h(x.name)}</a>` : h(x.name)}</b><small>${h(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(x.d + "T12:00:00Z").getUTCDay()])}${x.time ? " · " + h(t12(x.time)) : ""}${x.d === today ? " · today" : ""}</small></span>
              ${x.cancelled ? '<span class="status-chip st-Cancelled">Cancelled</span>' : x.grp ? `<span class="lm-grp">${h(x.grp.name)} · ${h(x.grp.levels)}</span>` : '<span class="lm-grp">Everyone</span>'}</li>`).join("")}</ul>` : '<p class="muted">Nothing planned in the next three weeks.</p>'}</section>
        </div>`;
    }

    if (tab === "league") {
      const L = await league(se), max = Math.max(1, ...L.rows.map((r) => r.points));
      const toggle = named ? `<form method="post" action="/corporate/limad/league" class="lm-toggle"><input type="hidden" name="on" value="${on ? "0" : "1"}">
          <span class="lm-switch${on ? " on" : ""}" aria-hidden="true"><i></i></span><span><b>Department League is ${on ? "on" : "off"}</b><small>${on ? "Everyone with access to this dashboard can see the table." : "Only the Cycling Development team sees this tab. Turn it on if L'imad wants the league."}</small></span>
          <button class="btn ${on ? "" : "primary"}">${on ? "Turn off" : "Turn on"}</button></form>` : "";
      const ps = named ? (await pool.query("SELECT id, pid, full_name, department FROM corp_participants WHERE company = $1 AND status = 'Active' ORDER BY full_name", [CODE])).rows : [];
      body = `${toggle}
        <div class="grid" style="margin-top:14px${on || !named ? "" : ";opacity:.62"}">
          <section class="card c8"><h2>Corporate Cycling League ${h(se.label)}</h2><p class="lead">Departments compete on engagement, not kilometres. A first ride and bringing a colleague are worth more than a long ride.</p>
            ${L.rows.length ? `<div class="tw"><table class="lm-league"><thead><tr><th class="n">Rank</th><th>Department</th><th>Points</th><th class="n">Participants</th></tr></thead><tbody>
              ${L.rows.map((r) => `<tr class="${r.rank <= 3 && r.points ? "top" + r.rank : ""}"><td class="n"><span class="lm-rank">${r.rank}</span></td><td><b>${h(r.dept)}</b></td><td><div class="lm-bar"><i style="--w:${Math.round((r.points / max) * 100)}%"></i><b>${nf(r.points)}</b></div></td><td class="n">${nf(r.people.size)} <span class="muted">of ${nf(r.registered)}</span></td></tr>`).join("")}
              </tbody></table></div>` : `<p class="muted">No departments yet. Departments appear as people register with the form.</p>`}
            ${L.unset ? `<p class="hint" style="margin:10px 0 0">${nf(L.unset.points)} points from ${nf(L.unset.registered)} ${L.unset.registered === 1 ? "person" : "people"} without a department are not counted yet.${named ? " Ask them to fill in the registration form." : ""}</p>` : ""}
            <p class="hint" style="margin:6px 0 0">Season ${h(fmtDate(se.start))} to ${h(fmtDate(se.end))}. Participants = people who earned points, of everyone registered in that department.</p></section>
          <section class="card c4"><h2>How points are earned</h2><p class="lead">Rides and sessions count automatically from attendance.</p>
            <div class="tw"><table><tbody>${POINTS.map((p) => `<tr><td>${h(p.label)}${p.auto ? "" : ' <span class="badge">awarded by staff</span>'}</td><td class="n"><b>${p.pts}</b></td></tr>`).join("")}</tbody></table></div>
            <p class="hint" style="margin:8px 0 0">Workshops count as Cycling 101 when the title has “101”, and as maintenance when it says “maintenance”.</p></section>
          ${named ? `<section class="card c6"><h2>Award points</h2><p class="lead">For things attendance can't show.</p>
            <form class="form" method="post" action="/corporate/limad/points">
              <label>Person<select name="participant" required><option value="">Choose</option>${ps.map((p) => opt(p.id, `${p.full_name}${p.department ? " · " + p.department : ""}`, "")).join("")}</select></label>
              <div class="row2"><label>For<select name="kind" required>${POINTS.filter((p) => !p.auto).map((p) => opt(p.key, `${p.label} (${p.pts})`, "")).join("")}</select></label>
              <label>Date<input type="date" name="awarded_on" value="${h(today)}" min="${h(se.start)}" max="${h(se.end)}" required></label></div>
              <label>Note <span class="hint">(optional, e.g. who they brought)</span><input name="note" maxlength="200"></label>
              <button class="btn primary lm-btn">Award points</button></form></section>
          <section class="card c6"><h2>Points awarded by staff</h2>${table(["Date", "Person", "For", "Points", ""], L.extra.map((x) => [fmtDate(x.awarded_on), x.full_name + (x.department ? " · " + x.department : ""), (PT[x.kind] || {}).label || x.kind, x.points,
            raw(`<form method="post" action="/corporate/limad/points/${x.id}/delete" data-confirm="Remove these points?"><button class="btn tblbtn">Remove</button></form>`)]), { num: [3], empty: "None yet this season." })}</section>` : ""}
        </div>`;
    }

    if (tab === "register") {
      const url = regUrl(req), img = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 520 });
      const regs = (await pool.query("SELECT * FROM corp_participants WHERE company = $1 AND registered_at IS NOT NULL ORDER BY registered_at DESC", [CODE])).rows;
      const count = (f, vals) => vals.map((v) => [v, regs.filter((r) => f(r) === v).length]);
      const chips = (pairs) => pairs.map(([k, n]) => `<span class="lm-chip">${h(k)} <b>${nf(n)}</b></span>`).join("");
      body = `<div class="grid">
          <section class="card c5 lm-share"><h2>Share the registration form</h2><p class="lead">Put the QR code on posters and in internal emails. Each person gets their own QR code for ride check-in as soon as they register.</p>
            <div class="poster" style="--co:${h(co.color)}"><img src="${img}" alt="QR code for the L'imad registration form"><p><b>Scan to join L'imad Corporate Cycling</b></p></div>
            <p class="muted" style="font-size:13px;overflow-wrap:anywhere;margin:8px 0">${h(url)}</p>
            <div class="toolbar" style="margin:0"><a class="btn primary" href="/corporate/limad/register/poster">Print poster</a><a class="btn" href="${img}" download="LIMAD-registration-QR.png">Download QR</a><button class="btn" data-copy="${h(url)}">Copy link</button><a class="btn ghost" href="/corporate/limad/register" target="_blank" rel="noopener">Open form</a></div></section>
          <section class="card c7"><h2>Registrations so far</h2><p class="lead">${nf(regs.length)} ${regs.length === 1 ? "person has" : "people have"} used the form.</p>
            <h3 class="lm-h3">Preferred day</h3><div class="lm-chips">${chips(count((r) => r.preferred_day, DAYS))}</div>
            <h3 class="lm-h3">Level</h3><div class="lm-chips">${chips(LEVELS.map((l) => [`${l.n} ${l.name}`, regs.filter((r) => r.cycling_level === l.n).length]))}</div>
            <h3 class="lm-h3">Bikes and T-shirts</h3><div class="lm-chips">${chips([["Own road bike", regs.filter((r) => r.has_own_bike === true).length], ["Needs a bike", regs.filter((r) => r.has_own_bike === false).length]])}${chips(count((r) => r.tshirt_size, SIZES))}</div>
            ${named ? `<div class="toolbar" style="margin:12px 0 0"><a class="btn" href="/corporate/limad/registrations.xlsx">Download registrations (Excel)</a></div>` : ""}</section>
          ${named ? `<section class="card c12"><h2>Latest registrations</h2>${regs.length > 12 ? `<p class="lead">The 12 most recent. Everyone is in the Excel download and on the <a href="/corporate/participants?company=${CODE}">Participants</a> page.</p>` : ""}${table(["Registered", "Name", "Department", "Level", "Day", "Own bike", "T-shirt"], regs.slice(0, 12).map((r) => [fmtDate(new Date(r.registered_at).toISOString().slice(0, 10)),
            raw(`<a href="/corporate/participants/${encodeURIComponent(r.pid)}">${h(r.full_name)}</a>`), r.department || "—", r.cycling_level == null ? "—" : `${r.cycling_level} ${LEVELS[r.cycling_level].name}`, r.preferred_day || "—", r.has_own_bike == null ? "—" : r.has_own_bike ? "Yes" : "No", r.tshirt_size || "—"]), { empty: "No registrations yet." })}</section>` : ""}
          <section class="card c12"><h2>What people see</h2><p class="lead">The form as it opens on a phone. Emergency contacts are kept for ride leads and are in the Excel download only.</p><div class="lm-preview" inert>${regForm(co, scheds, await departments(), {}, null, { action: "#" })}</div></section>
        </div>`;
    }

    if (tab === "framework") {
      const y = se.y0, mNow = today.slice(0, 7);
      const phases = [
        { n: "01", name: "Preparation", from: `${y}-08`, to: `${y}-09`, when: `Aug – Sep ${y}`, verbs: "Plan · align · recruit", items: ["Agree the season plan and ride days with L'imad", "Align with UAE Team L'imad on coaches and team moments", "Recruit department ambassadors", "Open registration (form and QR code)", "Cycling 101 launch talk"] },
        { n: "02", name: "Peak", from: `${y}-10`, to: `${y + 1}-04`, when: `Oct ${y} – Apr ${y + 1}`, verbs: "Activate · engage · progress", items: ["Tuesday evening rides for newer riders (Level 0–1)", "Thursday rides for established riders (Level 2–3)", "Maintenance, bike set-up and nutrition workshops", "Bike fitting and turbo challenges", "Cycling Academy for Level 3 riders", "UAE Tour moment and race screening (February)", "Mid-season report to L'imad (January)"] },
        { n: "03", name: "Momentum", from: `${y + 1}-05`, to: `${y + 1}-07`, when: `May – Jul ${y + 1}`, verbs: "Maintain · recognise · retain", items: ["Indoor and early-morning sessions through the heat", "Graduation and awards in front of leadership", "Season report: breadth, depth and progression", `Plan ${y + 1}/${String(y + 2).slice(2)} with L'imad`] },
      ];
      const cur = phases.find((p) => mNow >= p.from && mNow <= p.to);
      const months = []; for (let i = 0; i < 12; i++) { const m = new Date(Date.UTC(y, 7 + i, 1)).toISOString().slice(0, 7); months.push(m); }
      const pOf = (m) => phases.findIndex((p) => m >= p.from && m <= p.to);
      body = `<section class="card"><h2>${h(se.label)} annual framework</h2><p class="lead">A three-phase cycle that puts most activity in the cooler riding season and keeps the community going through the summer. Prepare, peak, sustain, repeat.</p>
          <div class="lm-months" role="img" aria-label="Twelve months from August to July, coloured by phase">${months.map((m) => `<span class="p${pOf(m)}${m === mNow ? " now" : ""}">${h(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+m.slice(5) - 1])}${m === mNow ? "<em>Now</em>" : ""}</span>`).join("")}</div>
          <div class="lm-phases">${phases.map((p, i) => `<article class="lm-phase p${i}${cur === p ? " now" : ""}"><span class="lm-eyebrow">Phase ${p.n}${cur === p ? ' · <b>We are here</b>' : ""}</span><h3>${h(p.name)}</h3><p class="lm-when">${h(p.when)}</p><p class="muted" style="margin:0 0 8px">${h(p.verbs)}</p>
            <ul>${p.items.map((x) => `<li>${h(x)}</li>`).join("")}</ul></article>`).join("")}</div></section>
        <div class="grid" style="margin-top:14px">
          <section class="card c6"><h2>Entry pathway</h2><p class="lead">Three inclusive entry levels plus an optional development level.</p>
            <div class="lm-path">${LEVELS.map((l) => `<div class="l${l.n}"><span class="lm-eyebrow">Level ${l.n}${l.n === 3 ? " · optional" : ""}</span><b>${h(l.name)}</b><small>${h(l.text)}</small></div>`).join("")}</div></section>
          <section class="card c6"><h2>What we measure</h2><p class="lead">Kilometres are not the headline. Breadth, depth and progression are.</p>
            <div class="tw"><table><tbody><tr><td><b>New participation</b></td><td>Share of people taking part for the first time</td></tr><tr><td><b>Conversion</b></td><td>Workshop to first ride</td></tr>
              <tr><td><b>Retention</b></td><td>Employees returning within 90 days</td></tr><tr><td><b>Progression</b></td><td>First ride to second and third ride, and moving up a level</td></tr><tr><td><b>Inclusivity</b></td><td>Mix by gender, department and experience</td></tr></tbody></table></div></section>
        </div>`;
    }

    if (tab === "reports") {
      const st = await C.stats({ codes: [CODE], start: se.start, end: se.end < today ? se.end : today }), k = st.k;
      const q = (o) => new URLSearchParams({ company: CODE, ...o }).toString(), seasonQ = { period: "custom", from: se.start, to: se.end };
      body = `<div class="tiles lm-tiles">
          <div class="tile big"><span class="lbl">Rides held</span><span class="val">${nf(k.rideSessions)}</span><span class="note">${k.cancelled ? `${nf(k.cancelled)} cancelled` : "None cancelled"}</span></div>
          <div class="tile big"><span class="lbl">Total attendance</span><span class="val">${nf(k.attendance)}</span><span class="note">Rides, activities and events</span></div>
          <div class="tile big"><span class="lbl">Average riders per ride</span><span class="val">${nf(k.avgPerRide, 1)}</span><span class="note">${nf(k.rideAttendance)} ride check-ins</span></div>
          <div class="tile big"><span class="lbl">New joiners</span><span class="val">${nf(k.newJoiners)}</span><span class="note">First session this season</span></div></div>
        <p class="hint" style="margin:8px 0 14px">Season ${h(se.label)} so far: ${h(fmtDate(se.start))} to today.</p>
        <div class="lm-links">
          <a class="lm-link" href="/corporate/report?${q(seasonQ)}"><b>Season report</b><span>The ${h(se.label)} season on one page, ready to print or save as PDF.</span></a>
          <a class="lm-link" href="/corporate/report?${q({ period: "quarter" })}"><b>Quarterly report</b><span>This quarter compared with the one before.</span></a>
          <a class="lm-link" href="/corporate/report.xlsx?${q(seasonQ)}"><b>Season figures (Excel)</b><span>The season report as a workbook.</span></a>
          ${named ? `<a class="lm-link" href="/corporate/export.xlsx?${q({})}"><b>Attendance tracker (Excel)</b><span>Every session and every person, the full L'imad tracker.</span></a>
          <a class="lm-link" href="/corporate/limad/registrations.xlsx"><b>Registrations (Excel)</b><span>Form answers with department, level, day, kit and emergency contact.</span></a>` : ""}
          ${u.role !== "sponsor" ? `<a class="lm-link" href="/corporate/management?${q({})}"><b>Sponsor report</b><span>The management and sponsor view of the programme.</span></a>` : ""}
          <a class="lm-link" href="/corporate?${q({ period: "custom", from: se.start, to: today })}"><b>Corporate dashboard</b><span>All the season's figures and charts for L'imad.</span></a></div>`;
    }

    const nav = `<nav class="lm-tabs" aria-label="L'imad dashboard">${tabs.map(([k, l]) => `<a href="/corporate/limad${k === "overview" ? "" : "?tab=" + k}" ${k === tab ? 'aria-current="page"' : ""}>${h(l)}${k === "league" && !on ? ' <span class="lm-off">off</span>' : ""}</a>`).join("")}</nav>`;
    res.send(page(req, "L'imad dashboard", `<div class="lm" style="--lm:${h(co.color || "#2f7fd6")}">
      <header class="lm-hero"><div><span class="lm-eyebrow">Corporate Cycling ${h(se.label)} · The Social Ride</span><h2>L'imad Dashboard</h2><p>With UAE Team L'imad coaches · Abu Dhabi</p></div>
        ${named ? `<div class="toolbar" style="margin:0"><a class="btn" href="/corporate/attendance?company=${CODE}">Take attendance</a><a class="btn lm-btn primary" href="/corporate/limad?tab=register">Registration &amp; QR</a></div>` : ""}</header>
      ${nav}<div class="lm-body">${body}</div></div>`, { active: "/corporate/limad" }));
  }));

  app.post("/corporate/limad/league", S, wrap(async (req, res) => {
    const on = String((req.body || {}).on) === "1";
    await pool.query("INSERT INTO settings (key, value) VALUES ('limadLeague', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify({ on })]);
    await audit(pool, actor(req), "limad.league." + (on ? "on" : "off"), "setting", "limadLeague", null, { on });
    setFlash(req, "ok", on ? "Department League is on." : "Department League is off. Only the Cycling Development team sees the tab.");
    res.redirect("/corporate/limad?tab=league");
  }));
  app.post("/corporate/limad/points", S, wrap(async (req, res) => {
    const b = req.body || {}, kind = PT[b.kind], se = seasonOf();
    const p = (await pool.query("SELECT * FROM corp_participants WHERE id = $1 AND company = $2", [+b.participant || 0, CODE])).rows[0];
    const d = /^\d{4}-\d{2}-\d{2}$/.test(b.awarded_on || "") ? b.awarded_on : R.todayLocal();
    if (!p || !kind || kind.auto) { setFlash(req, "err", "Choose the person and what the points are for."); return res.redirect("/corporate/limad?tab=league"); }
    await pool.query("INSERT INTO corp_points (participant_id, kind, points, awarded_on, note, created_by) VALUES ($1,$2,$3,$4,$5,$6)", [p.id, kind.key, kind.pts, d < se.start || d > se.end ? R.todayLocal() : d, R.clean(b.note) || null, actor(req)]);
    await audit(pool, actor(req), "limad.points.award", "corp_participant", p.pid, null, { kind: kind.key, points: kind.pts });
    setFlash(req, "ok", `${kind.pts} points for ${p.full_name}${p.department ? " (" + p.department + ")" : ""}.`);
    res.redirect("/corporate/limad?tab=league");
  }));
  app.post("/corporate/limad/points/:id/delete", S, wrap(async (req, res) => {
    const r = (await pool.query("DELETE FROM corp_points WHERE id = $1 RETURNING *", [+req.params.id || 0])).rows[0];
    if (r) await audit(pool, actor(req), "limad.points.remove", "corp_points", String(r.id), r, null);
    setFlash(req, "ok", "Points removed.");
    res.redirect("/corporate/limad?tab=league");
  }));

  // ===================================================== registration form (public, no sign-in)
  const regPage = async (req, res, v, err, status = 200) => {
    const co = await company();
    if (!co || !co.active) return res.status(404).send(page(req, "Registration", `<section class="card"><h2>Registration isn't open</h2><p class="lead">Ask the Cycling Development team for the current link.</p></section>`, { wide: false }));
    const scheds = await C.schedules(pool, [CODE]);
    res.status(status).send(page(req, "Join L'imad Corporate Cycling", `<div class="lm" style="--lm:${h(co.color || "#2f7fd6")}"><section class="card lm-reg">
      <header class="lm-hero sm"><div><span class="lm-eyebrow">Corporate Cycling ${h(seasonOf().label)}</span><h2>Join L'imad Corporate Cycling</h2>
        <p>Rides with UAE Team L'imad coaches for every level, from never ridden to ready to race. Register once and you'll get your own QR code for ride check-in.</p></div></header>
      ${regForm(co, scheds, await departments(), v, err)}</section></div>`, { wide: false }));
  };
  app.get("/corporate/limad/register", wrap(async (req, res) => regPage(req, res, {}, null)));
  app.post("/corporate/limad/register", limit("limadreg", 20, 60 * 60e3), wrap(async (req, res) => {
    const co = await company(), b = req.body || {};
    if (!co || !co.active || b.website) return res.redirect("/corporate/limad/register");
    const email = R.normEmail(b.email), lvl = Number(b.cycling_level);
    const v = { ...b, email };
    const again = (err) => regPage(req, res, v, err, 400);
    if (R.clean(b.full_name).length < 3) return again("Please enter your full name.");
    if (!R.EMAIL_RE.test(email)) return again("Please enter your work email.");
    if (!domainOk(co, email)) return again(`Please use your ${co.name} work email (ending ${domains(co).map((d) => "@" + d).join(" or ")}).`);
    if (R.clean(b.mobile).replace(/\D/g, "").length < 7) return again("Please enter your mobile or WhatsApp number.");
    if (R.clean(b.department).length < 2) return again("Please enter your department.");
    if (!(Number.isInteger(lvl) && lvl >= 0 && lvl <= 3) || b.cycling_level === "" || b.cycling_level == null) return again("Please choose your cycling experience level.");
    if (!DAYS.includes(b.preferred_day)) return again("Please choose your preferred riding day.");
    if (!["yes", "no"].includes(b.has_own_bike)) return again("Please say whether you have your own road bike.");
    if (!SIZES.includes(b.tshirt_size)) return again("Please choose your T-shirt size.");
    if (R.clean(b.emergency_contact_name).length < 2 || R.clean(b.emergency_contact_phone).replace(/\D/g, "").length < 7) return again("Please add an emergency contact name and phone number.");
    if (!b.consent) return again("Please tick the consent box to register.");
    const out = await tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["limadreg"]);
      const dk = deptKey(b.department), department = (await departments(c)).find((d) => deptKey(d) === dk) || R.clean(b.department).slice(0, 80);
      let p = await C.findParticipant(c, CODE, { email }), created = false;
      if (!p) {
        const byName = await C.findParticipant(c, CODE, { name: b.full_name });
        if (byName && byName.email && byName.email !== email) return { err: "We already have this name with a different email. Use the email you registered with, or ask your ride lead." };
        p = byName;
      }
      if (!p) { p = await C.createParticipant(c, { company: CODE, full_name: b.full_name, email }, "public", "L'imad registration form"); created = true; }
      p = (await c.query(`UPDATE corp_participants SET email = $2, mobile = $3, department = $4, cycling_level = $5, preferred_day = $6, has_own_bike = $7, tshirt_size = $8,
        emergency_contact_name = $9, emergency_contact_phone = $10, registered_at = coalesce(registered_at, now()), status = 'Active', updated_at = now() WHERE id = $1 RETURNING *`,
      [p.id, email, R.clean(b.mobile), department, lvl, b.preferred_day, b.has_own_bike === "yes", b.tshirt_size, R.clean(b.emergency_contact_name), R.clean(b.emergency_contact_phone)])).rows[0];
      await audit(c, "public", created ? "limad.register.new" : "limad.register.update", "corp_participant", p.pid, null, { department: p.department, level: lvl, day: p.preferred_day });
      return { p, created };
    });
    if (out.err) return again(out.err);
    const p = out.p, scheds = await C.schedules(pool, [CODE]);
    const img = await QRCode.toDataURL(C.pidQr(p.pid), { errorCorrectionLevel: "M", margin: 2, width: 560 });
    const rides = scheds.filter((s) => s.kind === C.RIDE && (p.preferred_day === "Both" || p.preferred_day === "Not sure yet" || (p.preferred_day === "Thursday" ? s.weekday === 4 : s.weekday === 2)));
    const link = `${req.protocol}://${req.get("host")}${C.cqPath(p.pid)}`;
    res.set("Cache-Control", "no-store").send(page(req, "You're registered", `<div class="lm" style="--lm:${h(co.color || "#2f7fd6")}"><section class="card lm-reg" style="display:grid;gap:12px;text-align:center">
      <div class="big-tick" aria-hidden="true">✓</div><h2 style="font-size:24px">${out.created ? "Welcome" : "Thanks"}, ${h(p.full_name.split(" ")[0])}!</h2>
      <p class="lead" style="margin:0 auto">${out.created ? "You're registered for L'imad Corporate Cycling." : "Your details are updated."} This is your personal QR code. Show it to the ride lead at every session.</p>
      <div class="poster" style="--co:${h(co.color)}"><img src="${img}" alt="Your QR code"><p style="font-size:22px;font-weight:700;letter-spacing:.04em">${h(p.pid)}</p><p>${h(p.full_name)} · ${h(p.department || "")} · Level ${p.cycling_level} ${h(LEVELS[p.cycling_level].name)}</p></div>
      <a class="btn primary big lm-btn" href="${img}" download="${h(p.pid)}-QR.png" style="justify-content:center">Download my QR code</a>
      <p class="muted" style="margin:0;font-size:13px">Tip: take a screenshot too. You can open your code again any time at <a href="${h(link)}">this link</a>.</p>
      ${rides.length ? `<div class="lm-slots" style="text-align:left">${rides.map((s) => { const g = groupOf(s.weekday); return `<div class="lm-slot"><span class="lm-eyebrow">${h(g ? g.levels : s.kind)}</span><b>Every ${h(C.WEEKDAYS_LONG[s.weekday])}${s.start_time ? " · " + h(t12(s.start_time)) : ""}</b><span>${h(g ? g.name : C.schedName(s, co))}</span></div>`; }).join("")}</div>` : ""}
      ${co.signup_token ? `<a class="btn" href="/ride/${encodeURIComponent(co.signup_token)}" style="justify-content:center">See the ride calendar and sign up for a ride</a>` : ""}</section></div>`, { wide: false }));
  }));
  app.get("/corporate/limad/register/poster", S, wrap(async (req, res) => {
    const co = await company(); if (!co) return res.send(notReady(req));
    const img = await QRCode.toDataURL(regUrl(req), { errorCorrectionLevel: "M", margin: 2, width: 720 });
    const scheds = (await C.schedules(pool, [CODE])).filter((s) => s.kind === C.RIDE);
    res.send(page(req, "L'imad registration poster", `<div class="toolbar noprint"><button class="btn primary" data-print>Print</button><a class="btn" href="/corporate/limad?tab=register">Back</a></div>
      <div class="poster" style="--co:${h(co.color)};max-width:620px;margin:0 auto"><p style="letter-spacing:.08em;text-transform:uppercase;font-size:13px">Corporate Cycling ${h(seasonOf().label)} · The Social Ride</p>
        <h3>Join L'imad Corporate Cycling</h3><img src="${img}" alt="Registration QR code">
        <p style="font-size:18px"><b>1.</b> Scan with your phone camera &nbsp; <b>2.</b> Fill in the form &nbsp; <b>3.</b> Save your QR code</p>
        <p class="muted">${scheds.map((s) => { const g = groupOf(s.weekday); return h(`Every ${C.WEEKDAYS_LONG[s.weekday]}${s.start_time ? " " + t12(s.start_time) : ""}${g ? ` · ${g.name} (${g.levels})` : ""}`); }).join("<br>")}</p>
        <p style="font-size:12px;color:#666">All levels welcome · Rides with UAE Team L'imad coaches · Cycling Development</p></div>`, { active: "/corporate/limad", wide: false }));
  }));
  app.get("/corporate/limad/registrations.xlsx", S, wrap(async (req, res) => {
    const rows = (await pool.query("SELECT * FROM corp_participants WHERE company = $1 AND registered_at IS NOT NULL ORDER BY registered_at", [CODE])).rows;
    const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Registrations");
    ws.columns = [["ID", "pid", 12], ["Registered", "reg", 12], ["Full name", "full_name", 26], ["Email", "email", 30], ["Mobile / WhatsApp", "mobile", 18], ["Department", "department", 24], ["Level", "level", 14],
      ["Preferred day", "preferred_day", 16], ["Own road bike", "bike", 13], ["T-shirt", "tshirt_size", 9], ["Emergency contact", "emergency_contact_name", 22], ["Emergency phone", "emergency_contact_phone", 18], ["Status", "status", 10]].map(([header, key, width]) => ({ header, key, width }));
    for (const r of rows) ws.addRow({ ...r, reg: new Date(r.registered_at).toISOString().slice(0, 10), level: r.cycling_level == null ? "" : `${r.cycling_level} ${LEVELS[r.cycling_level].name}`, bike: r.has_own_bike == null ? "" : r.has_own_bike ? "Yes" : "No" });
    ws.getRow(1).font = { bold: true }; ws.views = [{ state: "frozen", ySplit: 1 }];
    await audit(pool, actor(req), "limad.export.registrations", "corp_company", CODE, null, { rows: rows.length });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="LIMAD-registrations-${R.todayLocal()}.xlsx"`).send(Buffer.from(await wb.xlsx.writeBuffer()));
  }));
};
module.exports.LEVELS = LEVELS;
module.exports.POINTS = POINTS;
module.exports.league = league;
module.exports.overview = overview;
module.exports.seasonOf = seasonOf;
