"use strict";
/** Corporate Cycling Programme pages: dashboard, attendance, events, participants, QR check-in, scanner, reports and exports. */
const multer = require("multer");
const crypto = require("crypto");
const QRCode = require("qrcode");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const { h, fmtDate, monLabel, nf, tile, table, raw, STAFF, ALL } = require("./views");
const { columns, hbars } = require("./charts");
const { addMonths, addDays } = require("./engine").helpers;

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const previews = new Map();
const pct = (r) => (r == null ? "—" : Math.round(r * 100) + "%");
const opt = (v, label, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? "selected" : ""}>${h(label)}</option>`;
const coChip = (co) => `<span class="co" style="--co:${h(co.color || "var(--accent)")}">${h(co.name)}</span>`;
const stChip = (s) => `<span class="status-chip st-${h(String(s).split(/[ /]/)[0])}">${h(s)}</span>`;
const label = (s, co) => `${C.sessionName(s, co)}${s.start_time ? " · " + s.start_time : ""}`;
const sessLink = (s, co) => `<a href="/corporate/session/${s.id}">${h(C.sessionName(s, co))}</a>`;

module.exports = function corporate(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const S = need(...STAFF), A = need("admin"), V = need(...ALL);
  const qrUrl = (req, co) => `${req.protocol}://${req.get("host")}/c/${co.checkin_token}`;

  // company in the query, limited to what this user may see
  async function scope(req) {
    const list = await C.companiesFor(user(req));
    const pick = list.find((x) => x.code === req.query.company);
    return { list, sel: pick || null, codes: pick ? [pick.code] : list.map((x) => x.code), byCode: Object.fromEntries((await C.companies(pool, { all: true })).map((x) => [x.code, x])) };
  }
  function periodControls(per, extra = "", opts = {}) {
    const today = R.todayLocal(), y0 = 2025, ys = []; for (let y = +today.slice(0, 4); y >= y0; y--) ys.push(String(y));
    const quarters = []; for (const y of ys) for (let q = 4; q >= 1; q--) { const m = `${y}-${String(q * 3 - 2).padStart(2, "0")}`; if (m <= today.slice(0, 7)) quarters.push(`${y}-Q${q}`); }
    return `<form class="toolbar noprint" method="get">${extra}
      <label class="f"><span>Period</span><select name="period" class="inp" data-autosubmit>${[["ytd", "This year to date"], ["month", "Month"], ["quarter", "Quarter"], ["year", "Year"], ["all", "All time"], ["custom", "Date range"]].map(([v, l]) => opt(v, l, per.type)).join("")}</select></label>
      ${per.type === "month" ? `<label class="f"><span>Month</span><input class="inp" type="month" name="p" value="${h(per.p)}" max="${today.slice(0, 7)}"></label>` : ""}
      ${per.type === "quarter" ? `<label class="f"><span>Quarter</span><select class="inp" name="p" data-autosubmit>${quarters.map((q) => opt(q, q.replace("-", " "), per.p)).join("")}</select></label>` : ""}
      ${per.type === "year" ? `<label class="f"><span>Year</span><select class="inp" name="p" data-autosubmit>${ys.map((y) => opt(y, y, per.p)).join("")}</select></label>` : ""}
      ${per.type === "custom" ? `<label class="f"><span>From</span><input class="inp" type="date" name="from" value="${h(per.from)}"></label><label class="f"><span>To</span><input class="inp" type="date" name="to" value="${h(per.to)}"></label>` : ""}
      <button class="btn">Apply</button>${opts.after || ""}</form>`;
  }
  const companySelect = (sc, { all = true, name = "company", auto = true } = {}) => sc.list.length > 1 || !all
    ? `<label class="f"><span>Company</span><select name="${name}" class="inp" ${auto ? "data-autosubmit" : ""}>${all ? opt("", "All companies", sc.sel ? sc.sel.code : "") : ""}${sc.list.map((c) => opt(c.code, c.name, sc.sel ? sc.sel.code : "")).join("")}</select></label>`
    : `<input type="hidden" name="${name}" value="${h(sc.list[0] ? sc.list[0].code : "")}">`;
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();
  const perQs = (per) => ({ period: per.type, p: per.p, from: per.from, to: per.to });

  // ===================================================== dashboard
  app.get("/corporate", V, wrap(async (req, res) => {
    const u = user(req), sc = await scope(req), per = C.periodFromQuery(req.query);
    if (!sc.list.length) return res.send(page(req, "Corporate", `<section class="card"><h2>No corporate partners yet</h2></section>`, { active: "/corporate" }));
    const st = await C.stats({ codes: sc.codes, start: per.start, end: per.end });
    const k = st.k, named = STAFF.includes(u.role);
    const multi = sc.codes.length > 1;
    const monthsIn = st.months;
    const chart = columns({ categories: monthsIn.map((m) => m.month), short: (m) => monLabel(m), label: "Attendance by month",
      series: multi ? sc.codes.map((code) => ({ name: sc.byCode[code].name, color: sc.byCode[code].color, values: monthsIn.map((m) => m.byCo[code]) }))
        : [{ name: "Rides", color: "var(--s1)", values: monthsIn.map((m) => m.rideAttendance) }, { name: "Other activities & events", color: "var(--s3)", values: monthsIn.map((m) => m.eventAttendance) }] });
    const coCards = st.byCompany.map((b) => { const co = sc.byCode[b.code]; return `<div class="co-card" style="--co:${h(co.color)}"><h3>${h(co.name)}</h3>
      <dl><dt>Rides held</dt><dd>${nf(b.sessions)}</dd><dt>Other activities & events</dt><dd>${nf(b.events)}</dd><dt>Total attendance</dt><dd>${nf(b.attendance)}</dd>
      <dt>Average riders per ride</dt><dd>${nf(b.avg, 1)}</dd><dt>People taking part</dt><dd>${nf(b.people)}</dd><dt>Active now (2+ in 90 days)</dt><dd>${nf(b.active)}</dd>
      <dt>Cancelled sessions</dt><dd>${nf(b.cancelled)}</dd><dt>Last session</dt><dd>${fmtDate(b.lastSession)}</dd></dl>
      <div class="toolbar" style="margin:4px 0 0"><a class="btn" href="/corporate?${qs({ company: b.code, ...perQs(per) })}">Open</a><a class="btn ghost" href="/corporate/report?${qs({ company: b.code, ...perQs(per) })}">Report</a></div></div>`; }).join("");
    const todayIs = R.todayLocal();
    // coming up: the next planned sessions from each company's schedule, plus one-off sessions added by hand
    const occ = await C.occurrences(pool, sc.codes, todayIs, addDays(todayIs, 35));
    const extra = (await pool.query("SELECT * FROM corp_sessions WHERE company = ANY($1) AND session_date >= $2 ORDER BY session_date", [sc.codes, todayIs])).rows
      .filter((s) => !occ.some((o) => o.session && o.session.id === s.id));
    const upcoming = [...occ.map((o) => ({ d: o.date, company: o.sc.company, name: C.schedName(o.sc, sc.byCode[o.sc.company]) + (o.sc.start_time ? " · " + o.sc.start_time : ""), status: o.session ? o.session.status : "Scheduled", id: o.session && o.session.id })),
      ...extra.map((s) => ({ d: s.session_date, company: s.company, name: label(s, sc.byCode[s.company]), status: s.status, id: s.id }))].sort((a, b) => a.d.localeCompare(b.d)).slice(0, 10);
    // planned in the last 60 days but nothing recorded (not even a cancellation)
    const missed = (await C.occurrences(pool, sc.codes, addDays(todayIs, -60), addDays(todayIs, -1))).filter((o) => !o.session);
    const scheds = await C.schedules(pool, sc.codes);
    const rideDays = sc.list.filter((c) => sc.codes.includes(c.code)).map((c) => { const x = scheds.filter((y) => y.company === c.code); return `${c.name}: ${x.length ? x.map((y) => C.scheduleText(y).replace(/ of the month/, "")).join(", ") : c.ride_days}`; }).join(" · ");
    res.send(page(req, "Corporate dashboard", `
      <div class="card-head"><div><h2 style="font-size:22px">${sc.sel ? coChip(sc.sel) : "Corporate Cycling Programme"}</h2><p class="muted" style="margin:2px 0 0">${h(per.label)} · ${h(rideDays)}${named ? ` · <a href="/corporate/schedule">change schedule</a>` : ""}</p></div>
        <div class="toolbar noprint" style="margin:0">${named ? `<a class="btn" href="/corporate/attendance?${qs({ company: sc.sel && sc.sel.code })}">Take attendance</a><a class="btn" href="/corporate/qr">QR codes</a>` : ""}<a class="btn primary" href="/corporate/report?${qs({ company: sc.sel && sc.sel.code, ...perQs(per) })}">Report for management & sponsors</a></div></div>
      ${periodControls(per, companySelect(sc))}
      ${named && missed.length ? `<div class="alert warn"><span class="ic">!</span><span><b>${missed.length} planned session${missed.length > 1 ? "s have" : " has"} nothing recorded</b> (no scans and not marked cancelled): ${missed.slice(0, 5).map((o) => `${h(sc.byCode[o.sc.company].name)} ${h(C.schedName(o.sc, sc.byCode[o.sc.company]))} ${fmtDate(o.date)}`).join(" · ")}. Record them on the <a href="/corporate/schedule">Schedule</a> page (tick names or mark cancelled).</span></div>` : ""}
      ${named && st.needsAttendance.length ? `<div class="alert warn"><span class="ic">!</span><span><b>${st.needsAttendance.length} past session${st.needsAttendance.length > 1 ? "s have" : " has"} no attendance recorded.</b> ${st.needsAttendance.slice(0, 4).map((s) => `<a href="/corporate/session/${s.id}">${h(sc.byCode[s.company].name)} ${fmtDate(s.d)}</a>`).join(" · ")}</span></div>` : ""}
      <div class="tiles">
        ${tile("Total attendance", nf(k.attendance), "Rides, activities and events")}
        ${tile("Rides held", nf(k.rideSessions), k.cancelled ? `${k.cancelled} cancelled` : "None cancelled")}
        ${tile("Average riders per ride", nf(k.avgPerRide, 1), `${nf(k.rideAttendance)} ride check-ins`)}
        ${tile("Other activities & events", nf(k.events), `${nf(k.eventAttendance)} attendance`)}
        ${tile("People taking part", nf(k.people), "Named check-ins in the period")}
        ${tile("New joiners", nf(k.newJoiners), "First session in the period")}
        ${tile("Active participants", nf(k.active), "2+ sessions in the last 90 days")}
        ${tile("Came back again", pct(k.repeatRate), `${nf(k.repeat)} of ${nf(k.people)} attended 2+ times`)}
      </div>
      <div class="grid">
        <section class="card c8"><h2>Attendance by month</h2><p class="lead">${multi ? "Stacked by company." : "Rides and other activities."} Months before the period are shown for context.</p>${chart}</section>
        <section class="card c4"><h2>By activity</h2><p class="lead">Attendance in the period.</p>${hbars(st.byKind.map((x) => ({ ...x, color: x.name === C.RIDE ? "var(--s1)" : "var(--s3)" })))}
          <h2 style="margin-top:16px">Community</h2><p class="lead">Emirati and expat attendance, where recorded.</p>${hbars([{ name: "Emirati", value: k.emirati, color: "var(--s1)" }, { name: "Expat", value: k.expat, color: "var(--s2)" }, { name: "Not recorded", value: k.unknownCommunity, color: "var(--axis)" }].filter((x) => x.value))}</section>
        ${multi ? `<section class="card c12"><h2>Companies</h2><p class="lead">${h(per.label)}.</p><div class="co-cards">${coCards}</div></section>` : ""}
        ${named ? `<section class="card c6"><h2>Most regular participants</h2><p class="lead">Sessions attended in the period.</p>${table(["Name", "Company", "Sessions", "Last"], st.top.map((p) => [raw(`<a href="/corporate/participants/${encodeURIComponent(p.pid)}">${h(p.full_name)}</a>`), sc.byCode[p.company].name, p.inRange, fmtDate(p.last)]), { num: [2] })}</section>
        <section class="card c6"><h2>Follow up</h2><p class="lead">Used to come regularly, nothing in the last 90 days.</p>${table(["Name", "Company", "Last session", "Total"], st.lapsed.slice(0, 10).map((p) => [raw(`<a href="/corporate/participants/${encodeURIComponent(p.pid)}">${h(p.full_name)}</a>`), sc.byCode[p.company].name, fmtDate(p.last), p.dates.length]), { num: [3], empty: "Nobody to follow up." })}</section>` : ""}
        <section class="card c12"><h2>Coming up</h2>${table(["Date", "Company", "Session", "Status"], upcoming.map((u) => [fmtDate(u.d) + (u.d === todayIs ? " · today" : ""), sc.byCode[u.company].name, named && u.id ? raw(`<a href="/corporate/session/${u.id}">${h(u.name)}</a>`) : u.name, raw(stChip(u.status))]), { empty: "Nothing planned. Add the regular sessions on the Schedule page." })}</section>
      </div>`, { active: "/corporate" }));
  }));

  // ===================================================== attendance register
  app.get("/corporate/attendance", S, wrap(async (req, res) => {
    const sc = await scope(req);
    const co = sc.sel || sc.list[0];
    if (!co) return res.redirect("/corporate");
    const per = C.periodFromQuery({ period: "custom", from: addDays(R.todayLocal(), -83), ...req.query });
    const sess = (await pool.query(`SELECT s.*, (SELECT count(*) FROM corp_attendance a WHERE a.session_id = s.id)::int AS named FROM corp_sessions s
      WHERE company = $1 AND session_date BETWEEN $2 AND $3 ORDER BY session_date, kind <> $4, id`, [co.code, per.start, per.end, C.RIDE])).rows;
    const parts = (await pool.query(`SELECT p.*, (SELECT count(*) FROM corp_attendance a WHERE a.participant_id = p.id)::int AS total FROM corp_participants p WHERE company = $1 ORDER BY status, full_name`, [co.code])).rows;
    const att = new Set((await pool.query("SELECT session_id, participant_id FROM corp_attendance WHERE session_id = ANY($1)", [sess.map((s) => s.id)])).rows.map((a) => a.session_id + "|" + a.participant_id));
    const show = parts.filter((p) => p.status === "Active" || sess.some((s) => att.has(s.id + "|" + p.id)));
    const head = sess.map((s) => `<th class="d" title="${h(C.sessionName(s, co))}"><a href="/corporate/session/${s.id}">${h(fmtDate(s.session_date).replace(/ \d{4}$/, ""))}${s.kind !== C.RIDE ? " · " + h(s.kind) : ""}</a></th>`).join("");
    const cell = (s, p) => s.status === "Cancelled" ? `<td class="x cx" title="${h(s.remarks || "Cancelled")}">—</td>` : att.has(s.id + "|" + p.id) ? `<td class="x y">1</td>` : `<td class="x"></td>`;
    const reg = `<div class="tw"><table class="reg"><thead><tr><th>Name</th>${head}<th class="n">In range</th><th class="n">All time</th></tr></thead><tbody>
      ${show.map((p) => `<tr><td class="name"><a href="/corporate/participants/${encodeURIComponent(p.pid)}">${h(p.full_name)}</a>${p.status === "Inactive" ? ' <span class="badge">Inactive</span>' : ""}</td>${sess.map((s) => cell(s, p)).join("")}<td class="n">${sess.filter((s) => att.has(s.id + "|" + p.id)).length}</td><td class="n">${p.total}</td></tr>`).join("") || `<tr><td class="muted" colspan="${sess.length + 3}">No participants yet.</td></tr>`}
      </tbody><tfoot><tr><td class="name">Attendance</td>${sess.map((s) => `<td class="x">${s.status === "Cancelled" ? "—" : s.named || s.headcount || 0}</td>`).join("")}<td></td><td></td></tr></tfoot></table></div>`;
    const today = R.todayLocal();
    res.send(page(req, "Corporate attendance", `
      <div class="card-head"><div><h2 style="font-size:22px">Attendance register · ${coChip(co)}</h2><p class="muted" style="margin:2px 0 0">Same layout as the tracker: one row per person, one column per session. Click a date to tick names or change a session.</p></div>
        <a class="btn noprint" href="/corporate/export.xlsx?${qs({ company: co.code })}">Download tracker (.xlsx)</a></div>
      ${periodControls(per, companySelect(sc, { all: false }))}
      <div class="grid">
        <section class="card c8"><h2>Record a session</h2><p class="lead">Create the session, then tick who came. Staff can also check themselves in with the company QR code on ride days.</p>
          <form class="form" method="post" action="/corporate/sessions"><input type="hidden" name="company" value="${h(co.code)}">
            <div class="row2"><label>Date<input type="date" name="session_date" value="${today}" required></label>
              <label>Activity<select name="kind">${C.KINDS.map((k) => opt(k, k, C.RIDE)).join("")}</select></label></div>
            <div class="row2"><label>Title <span class="hint">(optional, e.g. "Night ride at Yas")</span><input name="title" maxlength="120"></label>
              <label>Status<select name="status">${opt("Held", "Held", "Held")}${opt("Scheduled", "Scheduled (future)", "")}${opt("Cancelled", "Cancelled", "")}</select></label></div>
            <button class="btn primary">Create session</button></form></section>
        <section class="card c4"><h2>Today</h2>${(await C.todaysSessions(pool, co)).map((s) => s.virtual ? `<p class="lead" style="margin:0 0 6px"><b>${h(label(s, co))}</b> is planned today; it opens at the first scan.</p><form method="post" action="/corporate/sessions"><input type="hidden" name="company" value="${h(co.code)}"><input type="hidden" name="session_date" value="${today}"><input type="hidden" name="kind" value="${h(s.kind)}"><input type="hidden" name="title" value="${h(s.title)}"><input type="hidden" name="status" value="Held"><button class="btn">Open it to tick names</button></form>` : `<p>${sessLink(s, co)} ${stChip(s.status)}</p>`).join("") || `<p class="muted">No session today. <a href="/corporate/schedule">Schedule</a></p>`}
          <p class="muted" style="font-size:13px">Self check-in link: <a href="/corporate/qr">QR codes</a></p></section>
        <section class="card c12"><h2>${h(per.label)}</h2><p class="lead">${sess.filter((s) => s.status === "Held").length} sessions held, ${sess.filter((s) => s.status === "Cancelled").length} cancelled. — means cancelled. Columns with a total but no ticks are headcount-only sessions.</p>${reg}</section>
      </div>`, { active: "/corporate/attendance" }));
  }));

  app.post("/corporate/sessions", S, wrap(async (req, res) => {
    const b = req.body, sc = await scope(req);
    if (!sc.list.some((x) => x.code === b.company)) return res.redirect("/corporate");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.session_date || "")) { setFlash(req, "err", "Choose a date."); return res.redirect("back"); }
    const kind = C.KINDS.includes(b.kind) ? b.kind : C.RIDE, status = ["Held", "Scheduled", "Cancelled"].includes(b.status) ? b.status : "Held";
    const s = await tx(async (c) => {
      const row = await C.ensureSession(c, { company: b.company, date: b.session_date, kind, title: b.title, status, by: actor(req) });
      if (b.location || b.headcount || b.remarks) await c.query("UPDATE corp_sessions SET location = coalesce($2, location), headcount = coalesce($3, headcount), remarks = coalesce($4, remarks) WHERE id = $1",
        [row.id, R.clean(b.location) || null, b.headcount !== "" && b.headcount != null && +b.headcount >= 0 ? +b.headcount : null, R.clean(b.remarks) || null]);
      await audit(c, actor(req), "corp.session.create", "corp_session", String(row.id), null, { company: b.company, date: b.session_date, kind, title: b.title, status });
      return row;
    });
    res.redirect("/corporate/session/" + s.id);
  }));

  // ===================================================== one session
  async function loadSession(req, id) {
    const s = (await pool.query("SELECT * FROM corp_sessions WHERE id = $1", [+id || 0])).rows[0];
    if (!s) return null;
    const list = await C.companiesFor(user(req));
    const co = list.find((x) => x.code === s.company);
    return co ? { s, co } : null;
  }
  app.get("/corporate/session/:id", S, wrap(async (req, res) => {
    const L = await loadSession(req, req.params.id);
    if (!L) return res.status(404).send(page(req, "Not found", `<section class="card"><h2>Session not found</h2></section>`, { active: "/corporate/attendance" }));
    const { s, co } = L;
    const att = (await pool.query("SELECT a.*, p.full_name, p.pid FROM corp_attendance a JOIN corp_participants p ON p.id = a.participant_id WHERE a.session_id = $1 ORDER BY p.full_name", [s.id])).rows;
    const roster = (await pool.query("SELECT * FROM corp_participants WHERE company = $1 AND (status = 'Active' OR id = ANY($2)) ORDER BY full_name", [co.code, att.map((a) => a.participant_id)])).rows;
    const here = new Set(att.map((a) => a.participant_id));
    const isAdmin = user(req).role === "admin";
    res.send(page(req, C.sessionName(s, co), `
      <div class="card-head"><div><h2 style="font-size:22px">${h(C.sessionName(s, co))} · ${fmtDate(s.session_date)}</h2><p class="muted" style="margin:2px 0 0">${coChip(co)} · ${h(s.kind)} ${stChip(s.status)} · ${att.length} checked in${!att.length && s.headcount != null ? ` · headcount ${s.headcount}` : ""}</p></div>
        <a class="btn" href="/corporate/attendance?${qs({ company: co.code })}">← Register</a></div>
      <div class="grid">
        <section class="card c8"><div class="card-head"><div><h2>Who came</h2><p class="lead">Tick everyone who attended, then save. Self check-ins and scans appear here too.</p></div><button class="btn tblbtn" data-check-all="#roster">Tick / untick all</button></div>
          ${s.status === "Cancelled" ? `<div class="alert warn"><span class="ic">!</span><span>This session is marked cancelled${s.remarks ? `: ${h(s.remarks)}` : ""}. Change the status to tick names.</span></div>` : `
          <form class="form" method="post" action="/corporate/session/${s.id}/attendance">
            <div class="checklist" id="roster">${roster.map((p) => `<label><input type="checkbox" name="p" value="${p.id}" ${here.has(p.id) ? "checked" : ""}> <span>${h(p.full_name)}${p.status === "Inactive" ? ' <span class="badge">Inactive</span>' : ""}</span></label>`).join("") || `<p class="muted">No participants yet. Add one below.</p>`}</div>
            <button class="btn primary">Save attendance</button></form>
          <details style="margin-top:14px"><summary><b>Someone new? Add them and check them in</b></summary>
            <form class="form" method="post" action="/corporate/session/${s.id}/walkin" style="margin-top:10px">
              <div class="row2"><label>Full name<input name="full_name" required maxlength="120"></label><label>Work email <span class="hint">(optional)</span><input name="email" type="email" maxlength="160"></label></div>
              <div class="row2"><label>Community<select name="community"><option value="">Not recorded</option>${C.COMMUNITIES.map((x) => opt(x, x, "")).join("")}<option>Other</option></select></label>
                <label>Gender<select name="gender"><option value="">Not recorded</option><option>Female</option><option>Male</option></select></label></div>
              <button class="btn">Add and check in</button></form></details>`}
          ${att.length ? `<h3 style="margin-top:16px;font-size:15px">Check-in log</h3>${table(["Name", "How", "When", "By"], att.map((a) => [a.full_name, a.method, fmtDate(a.at), a.created_by || ""]))}` : ""}
        </section>
        <section class="card c4"><h2>Session details</h2>
          <form class="form" method="post" action="/corporate/session/${s.id}">
            <label>Date<input type="date" name="session_date" value="${h(s.session_date)}" required></label>
            <label>Activity<select name="kind">${C.KINDS.map((k) => opt(k, k, s.kind)).join("")}</select></label>
            <label>Title<input name="title" value="${h(s.title)}" maxlength="120"></label>
            <label>Location<input name="location" value="${h(s.location)}" maxlength="120"></label>
            <label>Status<select name="status">${["Held", "Scheduled", "Cancelled"].map((x) => opt(x, x, s.status)).join("")}</select></label>
            <label>Headcount <span class="hint">(only when names weren't taken)</span><input type="number" min="0" name="headcount" value="${h(s.headcount)}"></label>
            <div class="row2"><label>Emirati<input type="number" min="0" name="headcount_emirati" value="${h(s.headcount_emirati)}"></label><label>Expat<input type="number" min="0" name="headcount_expat" value="${h(s.headcount_expat)}"></label></div>
            <label>New joiners<input type="number" min="0" name="headcount_new" value="${h(s.headcount_new)}"></label>
            <label>Remarks <span class="hint">(e.g. reason for cancelling)</span><input name="remarks" value="${h(s.remarks)}" maxlength="300"></label>
            <button class="btn primary">Save details</button></form>
          ${isAdmin ? `<form method="post" action="/corporate/session/${s.id}/delete" data-confirm="Delete this session and its ${att.length} check-ins?" style="margin-top:14px"><button class="btn danger">Delete session</button></form>` : ""}
        </section>
      </div>`, { active: "/corporate/attendance" }));
  }));
  app.post("/corporate/session/:id", S, wrap(async (req, res) => {
    const L = await loadSession(req, req.params.id); if (!L) return res.redirect("/corporate");
    const b = req.body, n = (v) => (v === "" || v == null || !(+v >= 0) ? null : Math.round(+v));
    const upd = { session_date: /^\d{4}-\d{2}-\d{2}$/.test(b.session_date || "") ? b.session_date : L.s.session_date, kind: C.KINDS.includes(b.kind) ? b.kind : L.s.kind, title: R.clean(b.title),
      location: R.clean(b.location) || null, status: ["Held", "Scheduled", "Cancelled"].includes(b.status) ? b.status : L.s.status, headcount: n(b.headcount),
      headcount_emirati: n(b.headcount_emirati), headcount_expat: n(b.headcount_expat), headcount_new: n(b.headcount_new), remarks: R.clean(b.remarks) || null };
    try {
      await tx(async (c) => {
        const k = Object.keys(upd);
        await c.query(`UPDATE corp_sessions SET ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")} WHERE id = $1`, [L.s.id, ...k.map((x) => upd[x])]);
        await audit(c, actor(req), "corp.session.update", "corp_session", String(L.s.id), L.s, upd);
      });
      setFlash(req, "ok", "Saved.");
    } catch (e) { if (e.code === "23505") setFlash(req, "err", "There is already a session with that date, activity and title."); else throw e; }
    res.redirect("/corporate/session/" + L.s.id);
  }));
  app.post("/corporate/session/:id/attendance", S, wrap(async (req, res) => {
    const L = await loadSession(req, req.params.id); if (!L) return res.redirect("/corporate");
    const want = new Set([].concat(req.body.p || []).map(Number).filter(Boolean));
    const out = await tx(async (c) => {
      const have = new Set((await c.query("SELECT participant_id FROM corp_attendance WHERE session_id = $1", [L.s.id])).rows.map((r) => r.participant_id));
      const valid = new Set((await c.query("SELECT id FROM corp_participants WHERE company = $1 AND id = ANY($2)", [L.co.code, [...want]])).rows.map((r) => r.id));
      let added = 0, removed = 0;
      for (const id of valid) if (!have.has(id)) { const p = (await c.query("SELECT * FROM corp_participants WHERE id = $1", [id])).rows[0]; const r = await C.markAttendance(c, L.s, p, "Ticked by staff", actor(req)); if (r.status === "ok") added++; }
      for (const id of have) if (!want.has(id)) { await c.query("DELETE FROM corp_attendance WHERE session_id = $1 AND participant_id = $2", [L.s.id, id]); removed++; }
      if (added || removed) await audit(c, actor(req), "corp.attendance.update", "corp_session", String(L.s.id), null, { added, removed });
      return { added, removed };
    });
    setFlash(req, "ok", `Saved: ${out.added} added, ${out.removed} removed.`);
    res.redirect("/corporate/session/" + L.s.id);
  }));
  app.post("/corporate/session/:id/walkin", S, wrap(async (req, res) => {
    const L = await loadSession(req, req.params.id); if (!L) return res.redirect("/corporate");
    const b = req.body;
    if (!R.clean(b.full_name)) { setFlash(req, "err", "Enter a name."); return res.redirect("/corporate/session/" + L.s.id); }
    const msg = await tx(async (c) => {
      let p = await C.findParticipant(c, L.co.code, { email: b.email, name: b.full_name }), created = false;
      if (!p) { p = await C.createParticipant(c, { ...b, company: L.co.code }, actor(req), "Staff walk-in"); created = true; }
      const r = await C.markAttendance(c, L.s, p, "Ticked by staff", actor(req));
      return r.status === "error" ? r.message : `${p.full_name} ${created ? "added and " : ""}${r.status === "ok" ? "checked in" : "was already checked in"}.`;
    });
    setFlash(req, "ok", msg);
    res.redirect("/corporate/session/" + L.s.id);
  }));
  app.post("/corporate/session/:id/delete", A, wrap(async (req, res) => {
    const L = await loadSession(req, req.params.id); if (!L) return res.redirect("/corporate");
    await tx(async (c) => { await c.query("DELETE FROM corp_sessions WHERE id = $1", [L.s.id]); await audit(c, actor(req), "corp.session.delete", "corp_session", String(L.s.id), L.s, null); });
    setFlash(req, "ok", "Session deleted.");
    res.redirect("/corporate/attendance?company=" + L.co.code);
  }));

  // ===================================================== event tracker
  app.get("/corporate/events", S, wrap(async (req, res) => {
    const sc = await scope(req), per = C.periodFromQuery(req.query);
    const kind = C.KINDS.includes(req.query.kind) ? req.query.kind : "";
    const rows = (await pool.query(`SELECT s.*, (SELECT count(*) FROM corp_attendance a WHERE a.session_id = s.id)::int AS named FROM corp_sessions s
      WHERE company = ANY($1) AND kind <> $2 AND session_date BETWEEN $3 AND $4 ${kind ? "AND kind = $5" : ""} ORDER BY session_date DESC`, [sc.codes, C.RIDE, per.start, per.end, ...(kind ? [kind] : [])])).rows;
    const up = (await pool.query(`SELECT * FROM corp_sessions WHERE company = ANY($1) AND kind <> $2 AND session_date > $3 ORDER BY session_date`, [sc.codes, C.RIDE, R.todayLocal()])).rows;
    const att = (s) => s.status === "Cancelled" ? 0 : s.named || s.headcount || 0;
    const held = rows.filter((s) => s.status === "Held");
    const byKind = C.KINDS.filter((k) => k !== C.RIDE).map((k) => ({ name: k, value: held.filter((s) => s.kind === k).reduce((a, s) => a + att(s), 0), n: held.filter((s) => s.kind === k).length })).filter((x) => x.n);
    res.send(page(req, "Corporate events", `
      <div class="card-head"><div><h2 style="font-size:22px">Event tracker</h2><p class="muted" style="margin:2px 0 0">Running, yoga, workshops and one-off events with each partner. Weekly rides are on the Attendance page.</p></div></div>
      ${periodControls(per, companySelect(sc) + `<label class="f"><span>Activity</span><select class="inp" name="kind" data-autosubmit>${opt("", "All activities", kind)}${C.KINDS.filter((k) => k !== C.RIDE).map((k) => opt(k, k, kind)).join("")}</select></label>`)}
      <div class="tiles">${tile("Events held", nf(held.length), h(per.label))}${tile("Event attendance", nf(held.reduce((a, s) => a + att(s), 0)), "Named check-ins or headcount")}${tile("Average per event", nf(held.length ? held.reduce((a, s) => a + att(s), 0) / held.length : null, 1), "")}${tile("Coming up", nf(up.length), "Scheduled")}</div>
      <div class="grid">
        <section class="card c8"><h2>Events</h2>${table(["Date", "Company", "Event", "Activity", "Status", "Attendance", "Remarks"], rows.map((s) => [fmtDate(s.session_date), raw(coChip(sc.byCode[s.company])), raw(sessLink(s, sc.byCode[s.company])), s.kind, raw(stChip(s.status)), s.status === "Held" ? att(s) : "—", s.remarks || ""]), { num: [5], empty: "No events in this period." })}
          ${up.length ? `<h3 style="margin-top:14px;font-size:15px">Coming up</h3>${table(["Date", "Company", "Event", "Activity"], up.map((s) => [fmtDate(s.session_date), raw(coChip(sc.byCode[s.company])), raw(sessLink(s, sc.byCode[s.company])), s.kind]))}` : ""}</section>
        <section class="card c4"><h2>Add an event</h2><p class="lead">Add it ahead of time as Scheduled. On the day, people can check in with the company QR code, or you tick names or enter a headcount.</p>
          <form class="form" method="post" action="/corporate/sessions">
            <label>Company<select name="company">${sc.list.map((c) => opt(c.code, c.name, sc.sel ? sc.sel.code : "")).join("")}</select></label>
            <label>Event name<input name="title" required maxlength="120" placeholder="e.g. Aurora Yoga, Bike maintenance workshop"></label>
            <div class="row2"><label>Date<input type="date" name="session_date" required></label><label>Activity<select name="kind">${C.KINDS.filter((k) => k !== C.RIDE).map((k) => opt(k, k, "Event")).join("")}</select></label></div>
            <label>Location<input name="location" maxlength="120"></label>
            <div class="row2"><label>Status<select name="status">${opt("Scheduled", "Scheduled", "Scheduled")}${opt("Held", "Held", "")}</select></label><label>Headcount <span class="hint">(if held, optional)</span><input type="number" min="0" name="headcount"></label></div>
            <button class="btn primary">Add event</button></form>
          <h2 style="margin-top:16px">By activity</h2>${hbars(byKind, { color: "var(--s3)", empty: "No events held in this period." })}</section>
      </div>`, { active: "/corporate/events" }));
  }));

  // ===================================================== participants
  app.get("/corporate/participants", S, wrap(async (req, res) => {
    const sc = await scope(req), q = R.clean(req.query.q), status = ["Active", "Inactive"].includes(req.query.status) ? req.query.status : "";
    const args = [sc.codes], where = ["company = ANY($1)"];
    if (q) { args.push("%" + q.replace(/[%_]/g, "") + "%"); where.push(`(full_name ILIKE $${args.length} OR email ILIKE $${args.length} OR pid ILIKE $${args.length})`); }
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    const rows = (await pool.query(`SELECT p.*, (SELECT count(*) FROM corp_attendance a WHERE a.participant_id = p.id)::int AS total,
      (SELECT max(s.session_date) FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = p.id) AS last
      FROM corp_participants p WHERE ${where.join(" AND ")} ORDER BY company, full_name`, args)).rows;
    const dups = (await pool.query(`SELECT company, name_key, array_agg(pid ORDER BY id) pids, array_agg(full_name ORDER BY id) names FROM corp_participants WHERE company = ANY($1) GROUP BY company, name_key HAVING count(*) > 1`, [sc.codes])).rows;
    res.send(page(req, "Corporate participants", `
      <div class="card-head"><div><h2 style="font-size:22px">Participants</h2><p class="muted" style="margin:2px 0 0">${rows.length} shown. Each person gets a personal QR code (on their page) that ride leads can scan.</p></div></div>
      <form class="toolbar" method="get">${companySelect(sc)}<label class="f"><span>Status</span><select class="inp" name="status" data-autosubmit>${opt("", "Active and inactive", status)}${opt("Active", "Active", status)}${opt("Inactive", "Inactive", status)}</select></label>
        <label class="f"><span>Search</span><input class="inp" type="search" name="q" value="${h(q)}" placeholder="Name, email or ID"></label><button class="btn">Search</button></form>
      ${dups.length ? `<div class="alert warn"><span class="ic">!</span><span><b>Possible duplicates:</b> ${dups.map((d) => `${h(d.names.join(" / "))} (<a href="/corporate/participants/${encodeURIComponent(d.pids[0])}">${h(d.pids.join(", "))}</a>)`).join(" · ")}. Open the first record to merge.</span></div>` : ""}
      <div class="grid"><section class="card c8">${table(["ID", "Name", "Company", "Work email", "Community", "Status", "Sessions", "Last attended"], rows.map((p) => [p.pid, raw(`<a href="/corporate/participants/${encodeURIComponent(p.pid)}">${h(p.full_name)}</a>`), sc.byCode[p.company].name, p.email || raw('<span class="muted">none yet</span>'), p.community || "—", raw(p.status === "Active" ? '<span class="badge good">Active</span>' : '<span class="badge">Inactive</span>'), p.total, fmtDate(p.last)]), { num: [6] })}</section>
      <section class="card c4"><h2>Upload a staff list</h2><p class="lead">Ask each company for an Excel or CSV list of the staff joining the programme: <b>name and work email</b> (employee number, gender and Emirati/Expat are optional). Uploading adds new people and fills in emails for people already here. You'll see a preview first.</p>
        <form class="form" method="post" action="/corporate/participants/upload" enctype="multipart/form-data">
          <label>Company<select name="company">${sc.list.map((c) => opt(c.code, c.name, sc.sel ? sc.sel.code : "")).join("")}</select></label>
          <input type="file" name="file" accept=".xlsx,.csv" required>
          <button class="btn primary">Read list and preview</button></form>
        <p style="margin:8px 0 0"><a href="/corporate/participants/template.xlsx">Download a blank list to send to the company</a></p></section>
      <section class="card c4"><h2>Add a participant</h2><form class="form" method="post" action="/corporate/participants">
        <label>Company<select name="company">${sc.list.map((c) => opt(c.code, c.name, sc.sel ? sc.sel.code : "")).join("")}</select></label>
        <label>Full name<input name="full_name" required maxlength="120"></label><label>Work email<input type="email" name="email" maxlength="160"></label>
        <div class="row2"><label>Community<select name="community"><option value="">Not recorded</option>${C.COMMUNITIES.map((x) => opt(x, x, "")).join("")}<option>Other</option></select></label>
        <label>Gender<select name="gender"><option value="">Not recorded</option><option>Female</option><option>Male</option></select></label></div>
        <label>Bike size<input name="bike_size" maxlength="30" placeholder="Own bike, XS, S, M, L"></label>
        <button class="btn primary">Add participant</button></form></section></div>`, { active: "/corporate/participants" }));
  }));
  // ----- staff list upload (from each company's HR): name + work email, optional employee no, gender, community
  app.get("/corporate/participants/template.xlsx", S, wrap(async (req, res) => {
    const ExcelJS = require("exceljs"), wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Staff list");
    ws.addRow(["Full name", "Work email", "Employee number", "Gender", "Emirati / Expat"]).font = { bold: true };
    ws.addRow(["Example: Sara Al Mansoori", "sara.almansoori@company.ae", "E1234", "Female", "Emirati"]).font = { italic: true, color: { argb: "FF888888" } };
    [30, 34, 18, 10, 16].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", 'attachment; filename="Corporate-cycling-staff-list.xlsx"').send(await wb.xlsx.writeBuffer());
  }));
  async function readList(file) {
    let rows = [];
    if (/\.csv$/i.test(file.originalname) || /text\/csv/.test(file.mimetype)) {
      const text = file.buffer.toString("utf8").replace(/^\ufeff/, "");
      const parseLine = (l) => { const out = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; } else if (ch === '"') q = true; else if (ch === "," || ch === ";") { out.push(cur); cur = ""; } else cur += ch; } out.push(cur); return out; };
      rows = text.split(/\r?\n/).filter((l) => l.trim()).map(parseLine);
    } else {
      const ExcelJS = require("exceljs"), wb = new ExcelJS.Workbook(); await wb.xlsx.load(file.buffer);
      const ws = wb.worksheets[0];
      ws.eachRow({ includeEmpty: false }, (row) => rows.push(row.values.slice(1).map((v) => (v && typeof v === "object" ? (v.text || v.result || (v.richText ? v.richText.map((t) => t.text).join("") : "")) : v == null ? "" : String(v)))));
    }
    const hi = rows.findIndex((r) => r.some((c) => /name/i.test(c)) && r.some((c) => /mail/i.test(c)));
    if (hi < 0) throw new Error('No header row with a "Name" and an "Email" column.');
    const head = rows[hi].map((c) => R.clean(c).toLowerCase());
    const col = (re) => head.findIndex((c) => re.test(c));
    const iName = col(/name/), iMail = col(/mail/), iEmp = col(/(emp|staff|badge).*(no|num|id)|^id$|number/), iGen = col(/gender|sex/), iCom = col(/emirati|expat|community|national/);
    return rows.slice(hi + 1).map((r, k) => ({ line: hi + 2 + k, full_name: R.clean(r[iName]), email: R.normEmail(r[iMail]), employee_no: iEmp >= 0 ? R.clean(r[iEmp]) : "",
      gender: iGen >= 0 ? (/^f/i.test(R.clean(r[iGen])) ? "Female" : /^m/i.test(R.clean(r[iGen])) ? "Male" : "") : "",
      community: iCom >= 0 ? (/emirati|uae|local/i.test(R.clean(r[iCom])) ? "Emirati" : R.clean(r[iCom]) ? "Expat" : "") : "" }))
      .filter((r) => (r.full_name || r.email) && !/^example/i.test(r.full_name));
  }
  async function planList(co, list) {
    const plan = { add: [], update: [], same: [], problems: [] }, seen = new Set();
    for (const r of list) {
      if (!r.full_name) { plan.problems.push([r.line, r.email, "No name"]); continue; }
      if (!R.EMAIL_RE.test(r.email)) { plan.problems.push([r.line, r.full_name, r.email ? `Email "${r.email}" doesn't look right` : "No email"]); continue; }
      if (!domainOk(co, r.email)) { plan.problems.push([r.line, r.full_name, `${r.email} isn't a ${co.name} work email (${domains(co).join(", ")})`]); continue; }
      if (seen.has(r.email)) { plan.problems.push([r.line, r.full_name, `${r.email} is in the list twice`]); continue; }
      seen.add(r.email);
      const byMail = await C.findParticipant(pool, co.code, { email: r.email });
      if (byMail) { (r.employee_no && byMail.employee_no !== r.employee_no ? plan.update : plan.same).push({ ...r, pid: byMail.pid, id: byMail.id, was: byMail.full_name }); continue; }
      const byName = await C.findParticipant(pool, co.code, { name: r.full_name });
      if (byName && byName.email) { plan.problems.push([r.line, r.full_name, `Already listed as ${byName.pid} with a different email (${byName.email})`]); continue; }
      if (byName) plan.update.push({ ...r, pid: byName.pid, id: byName.id, was: byName.full_name, addEmail: true });
      else plan.add.push(r);
    }
    return plan;
  }
  app.post("/corporate/participants/upload", S, upload.single("file"), wrap(async (req, res) => {
    const co = (await C.companiesFor(user(req))).find((x) => x.code === req.body.company);
    if (!co || !req.file) { setFlash(req, "err", "Choose a company and a file."); return res.redirect("/corporate/participants"); }
    let list;
    try { list = await readList(req.file); } catch (e) { setFlash(req, "err", "Couldn't read that list: " + e.message); return res.redirect("/corporate/participants?company=" + co.code); }
    const plan = await planList(co, list);
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60e3) previews.delete(k);
    const t = crypto.randomBytes(16).toString("hex");
    previews.set(t, { kind: "list", co: co.code, plan, at: Date.now(), name: req.file.originalname });
    res.send(page(req, "Staff list preview", `<section class="card"><h2>${coChip(co)} staff list: ${h(req.file.originalname)}</h2><p class="lead">Nothing has been saved yet. ${list.length} rows read.</p>
      <div class="tiles" style="margin-bottom:12px">${tile("New people", nf(plan.add.length), "Get a new ID")}${tile("Email added / updated", nf(plan.update.length), "Already on the list")}${tile("Already up to date", nf(plan.same.length), "")}${tile("Need checking", nf(plan.problems.length), "Not saved")}</div>
      ${plan.update.length ? `<h3 style="font-size:15px">Matched to people already here</h3>${table(["ID", "On the programme as", "From the list", "Work email"], plan.update.map((r) => [r.pid, r.was, r.full_name, r.email]))}` : ""}
      ${plan.add.length ? `<h3 style="font-size:15px;margin-top:12px">New people</h3>${table(["Name", "Work email", "Employee no", "Gender", "Emirati / Expat"], plan.add.map((r) => [r.full_name, r.email, r.employee_no, r.gender, r.community]))}` : ""}
      ${plan.problems.length ? `<h3 style="font-size:15px;margin-top:12px">Need checking (not saved)</h3>${table(["Row", "Name", "Problem"], plan.problems)}` : ""}
      <form method="post" action="/corporate/participants/upload/commit" style="margin-top:14px"><input type="hidden" name="token" value="${t}"><button class="btn primary big" ${plan.add.length + plan.update.length ? "" : "disabled"}>Save ${plan.add.length + plan.update.length} people</button> <a class="btn" href="/corporate/participants?company=${h(co.code)}">Cancel</a></form></section>`, { active: "/corporate/participants" }));
  }));
  app.post("/corporate/participants/upload/commit", S, wrap(async (req, res) => {
    const pv = previews.get(String(req.body.token || ""));
    if (!pv || pv.kind !== "list") { setFlash(req, "err", "The preview expired. Upload the list again."); return res.redirect("/corporate/participants"); }
    const co = (await C.companiesFor(user(req))).find((x) => x.code === pv.co); if (!co) return res.redirect("/corporate/participants");
    const n = await tx(async (c) => {
      let added = 0, updated = 0;
      for (const r of pv.plan.add) {
        if (await C.findParticipant(c, co.code, { email: r.email })) continue;
        const p = await C.createParticipant(c, { ...r, company: co.code }, actor(req), "Company staff list");
        if (r.employee_no) await c.query("UPDATE corp_participants SET employee_no = $2 WHERE id = $1", [p.id, r.employee_no]);
        added++;
      }
      for (const r of pv.plan.update) {
        await c.query(`UPDATE corp_participants SET email = coalesce(email, $2), employee_no = coalesce(nullif($3, ''), employee_no), gender = coalesce(gender, nullif($4, '')), community = coalesce(community, nullif($5, '')), updated_at = now() WHERE id = $1`,
          [r.id, r.email, r.employee_no, r.gender, r.community]);
        updated++;
      }
      await audit(c, actor(req), "corp.list.upload", "corp_company", co.code, null, { file: pv.name, added, updated });
      return { added, updated };
    });
    previews.delete(String(req.body.token));
    setFlash(req, "ok", `${co.name}: ${n.added} people added, ${n.updated} updated. They can now collect their personal QR codes with their work email.`);
    res.redirect("/corporate/participants?company=" + co.code);
  }));
  app.post("/corporate/participants", S, wrap(async (req, res) => {
    const b = req.body, sc = await scope(req);
    if (!sc.list.some((x) => x.code === b.company) || !R.clean(b.full_name)) { setFlash(req, "err", "Choose a company and enter a name."); return res.redirect("/corporate/participants"); }
    if (b.email && !R.EMAIL_RE.test(R.normEmail(b.email))) { setFlash(req, "err", "That email doesn't look right."); return res.redirect("/corporate/participants"); }
    const out = await tx(async (c) => {
      const ex = await C.findParticipant(c, b.company, { email: b.email, name: b.full_name });
      if (ex) return { ex };
      return { p: await C.createParticipant(c, b, actor(req), "Staff entry") };
    });
    if (out.ex) { setFlash(req, "info", `Already listed as ${out.ex.pid}.`); return res.redirect("/corporate/participants/" + encodeURIComponent(out.ex.pid)); }
    setFlash(req, "ok", `Added ${out.p.full_name} (${out.p.pid}).`);
    res.redirect("/corporate/participants/" + encodeURIComponent(out.p.pid));
  }));
  async function loadParticipant(req) {
    const p = (await pool.query("SELECT * FROM corp_participants WHERE pid = $1", [req.params.pid])).rows[0];
    if (!p) return null;
    const list = await C.companiesFor(user(req));
    const co = list.find((x) => x.code === p.company);
    return co ? { p, co } : null;
  }
  app.get("/corporate/participants/:pid", S, wrap(async (req, res) => {
    const L = await loadParticipant(req);
    if (!L) return res.status(404).send(page(req, "Not found", `<section class="card"><h2>Participant not found</h2></section>`, { active: "/corporate/participants" }));
    const { p, co } = L;
    const hist = (await pool.query("SELECT s.*, a.method, a.at FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = $1 ORDER BY s.session_date DESC", [p.id])).rows;
    const img = await QRCode.toDataURL(C.pidQr(p.pid), { errorCorrectionLevel: "M", margin: 2, width: 420 });
    const log = (await pool.query("SELECT * FROM audit_log WHERE entity = 'corp_participant' AND entity_id = $1 ORDER BY at DESC LIMIT 20", [p.pid])).rows;
    res.send(page(req, p.full_name, `<div class="grid">
      <section class="card c8"><h2>${h(p.full_name)} <span class="badge">${h(p.pid)}</span></h2><p class="lead">${coChip(co)} · joined ${fmtDate(p.joined)} · ${hist.length} sessions · source: ${h(p.source || "—")}</p>
        <form class="form" method="post" action="/corporate/participants/${encodeURIComponent(p.pid)}">
          <div class="row2"><label>Full name<input name="full_name" value="${h(p.full_name)}" required maxlength="120"></label><label>Work email<input type="email" name="email" value="${h(p.email)}" maxlength="160"></label></div>
          <div class="row2"><label>Community<select name="community"><option value="">Not recorded</option>${[...C.COMMUNITIES, "Other"].map((x) => opt(x, x, p.community)).join("")}</select></label>
            <label>Gender<select name="gender"><option value="">Not recorded</option>${["Female", "Male"].map((x) => opt(x, x, p.gender)).join("")}</select></label></div>
          <div class="row2"><label>Bike size<input name="bike_size" value="${h(p.bike_size)}" maxlength="30"></label><label>Status<select name="status">${["Active", "Inactive"].map((x) => opt(x, x, p.status)).join("")}</select></label></div>
          <label>Notes<input name="notes" value="${h(p.notes)}" maxlength="300"></label>
          <button class="btn primary">Save</button></form></section>
      <section class="card c4"><h2>Personal QR code</h2><p class="lead">A ride lead scans this at <a href="/corporate/scan">Corporate → Scan</a>. It holds ${h(C.pidQr(p.pid))}.</p>
        <div class="qrbox"><img src="${img}" alt="QR code for ${h(p.pid)}"><span class="id">${h(p.pid)}</span></div>
        <p style="margin-top:10px"><a class="btn" href="${img}" download="${h(p.pid)}.png">Download PNG</a></p>
        ${user(req).role === "admin" ? `<h2 style="margin-top:16px">Merge a duplicate</h2><p class="lead">Moves the other record's sessions here and removes it.</p>
          <form class="form" method="post" action="/corporate/participants/${encodeURIComponent(p.pid)}/merge" data-confirm="Merge the other record into ${h(p.full_name)}? This can't be undone."><label>Other ID<input name="other" required placeholder="${h(co.code)}-0000"></label><button class="btn danger">Merge into this person</button></form>` : ""}</section>
      <section class="card c12"><h2>Sessions attended</h2>${table(["Date", "Session", "Activity", "How"], hist.map((s) => [fmtDate(s.session_date), raw(sessLink(s, co)), s.kind, s.method]), { empty: "No sessions yet." })}</section>
      ${log.length ? `<section class="card c12"><h2>Change history</h2>${table(["When", "Who", "What"], log.map((a) => [require("./views").fmtTs(a.at), a.actor || "", a.action]))}</section>` : ""}
    </div>`, { active: "/corporate/participants" }));
  }));
  app.post("/corporate/participants/:pid", S, wrap(async (req, res) => {
    const L = await loadParticipant(req); if (!L) return res.redirect("/corporate/participants");
    const b = req.body, back = "/corporate/participants/" + encodeURIComponent(L.p.pid);
    if (!R.clean(b.full_name)) { setFlash(req, "err", "The name can't be empty."); return res.redirect(back); }
    if (b.email && !R.EMAIL_RE.test(R.normEmail(b.email))) { setFlash(req, "err", "That email doesn't look right."); return res.redirect(back); }
    const upd = { full_name: R.clean(b.full_name), name_key: C.nameKey(b.full_name), email: R.normEmail(b.email) || null, community: R.clean(b.community) || null, gender: R.clean(b.gender) || null,
      bike_size: R.clean(b.bike_size) || null, status: b.status === "Inactive" ? "Inactive" : "Active", notes: R.clean(b.notes) || null };
    await tx(async (c) => {
      const k = Object.keys(upd);
      await c.query(`UPDATE corp_participants SET ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [L.p.id, ...k.map((x) => upd[x])]);
      await audit(c, actor(req), "corp.participant.update", "corp_participant", L.p.pid, Object.fromEntries(Object.keys(upd).map((x) => [x, L.p[x]])), upd);
    });
    setFlash(req, "ok", "Saved.");
    res.redirect(back);
  }));
  app.post("/corporate/participants/:pid/merge", A, wrap(async (req, res) => {
    const L = await loadParticipant(req); if (!L) return res.redirect("/corporate/participants");
    const other = R.clean(req.body.other).toUpperCase(), back = "/corporate/participants/" + encodeURIComponent(L.p.pid);
    const msg = await tx(async (c) => {
      const o = (await c.query("SELECT * FROM corp_participants WHERE pid = $1 AND company = $2", [other, L.p.company])).rows[0];
      if (!o || o.id === L.p.id) return "Choose another participant from the same company.";
      const moved = await c.query("UPDATE corp_attendance SET participant_id = $1 WHERE participant_id = $2 AND session_id NOT IN (SELECT session_id FROM corp_attendance WHERE participant_id = $1)", [L.p.id, o.id]);
      await c.query("DELETE FROM corp_participants WHERE id = $1", [o.id]);
      await c.query("UPDATE corp_participants SET email = coalesce(email, $2), community = coalesce(community, $3), gender = coalesce(gender, $4), joined = least(joined, $5), updated_at = now() WHERE id = $1", [L.p.id, o.email, o.community, o.gender, o.joined]);
      await audit(c, actor(req), "corp.participant.merge", "corp_participant", L.p.pid, o, { merged: o.pid, sessionsMoved: moved.rowCount });
      return null;
    });
    setFlash(req, msg ? "err" : "ok", msg || `Merged ${other} into ${L.p.pid}.`);
    res.redirect(back);
  }));

  // ===================================================== QR codes
  app.get("/corporate/qr", S, wrap(async (req, res) => {
    const list = await C.companiesFor(user(req)), isAdmin = user(req).role === "admin";
    const cards = await Promise.all(list.map(async (co) => {
      const url = qrUrl(req, co), img = await QRCode.toDataURL(url, { errorCorrectionLevel: "M", margin: 2, width: 420 });
      return `<section class="card c4" style="display:grid;gap:10px;align-content:start"><h2>${coChip(co)}</h2>
        <p class="muted" style="margin:0;font-size:13px">${co.checkin_mode === "self" ? "Self check-in: staff scan this and type their name." : "Staff scan this once to get their own QR code and ID. Attendance is taken by scanning their personal code."}</p>
        <div class="poster" style="--co:${h(co.color)}"><img src="${img}" alt="QR code for ${h(co.name)}"><p><b>${co.checkin_mode === "self" ? "Scan to check in" : "Scan to get your personal QR code"}</b></p></div>
        <p class="muted" style="font-size:13px;overflow-wrap:anywhere;margin:0">${h(url)}</p>
        <div class="toolbar" style="margin:0"><a class="btn primary" href="/corporate/qr/${h(co.code)}/poster">Print poster</a><a class="btn" href="${img}" download="${h(co.code)}-check-in-QR.png">Download PNG</a><button class="btn" data-copy="${h(url)}">Copy link</button></div>
        <div class="toolbar" style="margin:0"><a class="btn ghost" href="/corporate/qr/${h(co.code)}/cards">Print personal QR cards (all participants)</a></div>
        ${isAdmin ? `<form method="post" action="/corporate/qr/${h(co.code)}/rotate" data-confirm="Make a new link? The old QR code for ${h(co.name)} stops working straight away."><button class="btn danger tblbtn">Replace this QR code</button></form>` : ""}</section>`;
    }));
    res.send(page(req, "Corporate QR codes", `
      <section class="card"><h2>QR codes for corporate staff</h2>
        <p class="lead"><b>Every staff member has their own QR code and ID number</b> (for example NMDC-0012). They keep it on their phone or as a printed card and show it at every ride; the ride lead scans it at <a href="/corporate/scan">Corporate → Scan</a>, and the attendance is saved on their record.</p>
        <p class="lead"><b>How staff get their code:</b> share the company link or poster below. They scan it once, type their name and work email, and their personal QR code and ID appear on screen to save. They can come back to the same link any time to see the code again and their attendance record. You can also print a card for everyone.</p>
        <p class="lead" style="margin-bottom:0">Forgot the code? The ride lead types their ID or ticks their name on the session page.</p></section>
      <div class="grid">${cards.join("")}</div>`, { active: "/corporate/qr" }));
  }));
  app.get("/corporate/qr/:code/poster", S, wrap(async (req, res) => {
    const co = (await C.companiesFor(user(req))).find((x) => x.code === req.params.code); if (!co) return res.redirect("/corporate/qr");
    const img = await QRCode.toDataURL(qrUrl(req, co), { errorCorrectionLevel: "M", margin: 2, width: 720 });
    res.send(page(req, co.name + " poster", `<div class="toolbar noprint"><button class="btn primary" data-print>Print</button><a class="btn" href="/corporate/qr">Back</a></div>
      <div class="poster" style="--co:${h(co.color)};max-width:620px;margin:0 auto"><p style="letter-spacing:.08em;text-transform:uppercase;font-size:13px">Corporate Cycling Programme</p>
        ${co.checkin_mode === "self" ? `<h3>${h(co.name)} ride check-in</h3><img src="${img}" alt="Check-in QR code"><p style="font-size:18px"><b>1.</b> Open your phone camera &nbsp; <b>2.</b> Scan &nbsp; <b>3.</b> Enter your name</p>`
    : `<h3>${h(co.name)} · get your personal QR code</h3><img src="${img}" alt="QR code"><p style="font-size:18px"><b>1.</b> Scan with your phone camera &nbsp; <b>2.</b> Enter your name and work email &nbsp; <b>3.</b> Save your QR code</p><p style="font-size:16px">Show your personal QR code to the ride lead at every ride.</p>`}
        <p class="muted">${(await C.schedules(pool, [co.code])).map((x) => h(C.schedName(x, co) + ": " + C.scheduleText(x))).join("<br>") || h(co.ride_days)}${co.location ? "<br>" + h(co.location) : ""}</p><p style="font-size:12px;color:#666">Cycling Development · Powered by Aurora</p></div>`, { active: "/corporate/qr", wide: false }));
  }));
  app.get("/corporate/qr/:code/cards", S, wrap(async (req, res) => {
    const co = (await C.companiesFor(user(req))).find((x) => x.code === req.params.code); if (!co) return res.redirect("/corporate/qr");
    const ps = (await pool.query("SELECT * FROM corp_participants WHERE company = $1 AND status = 'Active' ORDER BY full_name", [co.code])).rows;
    const cards = await Promise.all(ps.map(async (p) => `<div class="qr-card"><img src="${await QRCode.toDataURL(C.pidQr(p.pid), { margin: 1, width: 280 })}" alt=""><b>${h(p.full_name)}</b><span>${h(p.pid)} · ${h(co.name)}</span></div>`));
    res.send(page(req, co.name + " QR cards", `<div class="toolbar noprint"><button class="btn primary" data-print>Print cards</button><a class="btn" href="/corporate/qr">Back</a><span class="muted">${ps.length} active participants. Cut out and hand out, or send each person their own code from their page.</span></div><div class="qr-cards">${cards.join("")}</div>`, { active: "/corporate/qr" }));
  }));
  app.post("/corporate/qr/:code/rotate", A, wrap(async (req, res) => {
    await pool.query("UPDATE corp_companies SET checkin_token = $2 WHERE code = $1", [req.params.code, C.token()]);
    await audit(pool, actor(req), "corp.qr.rotate", "corp_company", req.params.code, null, null, "New check-in link");
    setFlash(req, "ok", "New QR code made. Print and share the new one.");
    res.redirect("/corporate/qr");
  }));

  // ===================================================== public self check-in (no sign-in)
  async function companyByToken(t) { return (await pool.query("SELECT * FROM corp_companies WHERE checkin_token = $1 AND active", [String(t || "")])).rows[0]; }
  /** Short privacy note shown wherever staff type their details. */
  const privacyNote = (co) => `<p class="muted" style="margin:0;font-size:12.5px;line-height:1.45">Privacy: your name, work email and the sessions you attend are used only to run the ${h(co.name)} cycling programme and to report on it. Only the Cycling Development team sees names; reports for ${h(co.name)} management and sponsors show totals only. Community and gender are optional. To correct or remove your details, ask your ride lead or the Cycling Development team.</p>`;
  const domains = (co) => String(co.email_domain || "").toLowerCase().split(/[\s,;]+/).map((d) => d.replace(/^@/, "")).filter(Boolean);
  const domainOk = (co, email) => !domains(co).length || domains(co).some((d) => email.endsWith("@" + d));
  function checkinForm(co, sessions, v = {}, err) {
    const many = sessions.length > 1;
    return `<section class="card" style="display:grid;gap:12px">
      <div class="checkin-hero"><p class="muted" style="margin:0;letter-spacing:.06em;text-transform:uppercase;font-size:12px">Corporate Cycling Programme</p><h2 style="font-size:24px">${coChip(co)} check-in</h2><p class="lead" style="margin:0">${fmtDate(R.todayLocal())}</p></div>
      ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
      ${sessions.length ? `<form class="form" method="post" id="checkin">
        ${many ? `<fieldset style="border:0;padding:0;margin:0;display:grid;gap:6px"><legend style="font-weight:600;margin-bottom:4px">Which session?</legend>${sessions.map((s, i) => `<label class="check"><input type="radio" name="session" value="${h(C.sessionValue(s))}" ${i === 0 ? "checked" : ""}> <span>${h(label(s, co))}</span></label>`).join("")}</fieldset>` : `<input type="hidden" name="session" value="${h(C.sessionValue(sessions[0]))}"><p style="margin:0"><b>${h(label(sessions[0], co))}</b></p>`}
        <label>Your full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
        <label>Work email <span class="hint">(helps us find you; optional)</span><input name="email" type="email" maxlength="160" value="${h(v.email)}" autocomplete="email"></label>
        <details><summary>First time? Tell us a little more</summary><div class="row2" style="margin-top:8px">
          <label>Community<select name="community"><option value="">Prefer not to say</option>${C.COMMUNITIES.map((x) => opt(x, x, v.community)).join("")}<option ${v.community === "Other" ? "selected" : ""}>Other</option></select></label>
          <label>Gender<select name="gender"><option value="">Prefer not to say</option>${["Female", "Male"].map((x) => opt(x, x, v.gender)).join("")}</select></label></div></details>
        <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
        <button class="btn primary big">Check in</button>${privacyNote(co)}</form>`
    : `<div class="alert info"><span class="ic">i</span><span>There's no ${h(co.name)} session to check in to today.</span></div>`}
    </section>`;
  }
  function myQrForm(co, v = {}, err) {
    return `<section class="card" style="display:grid;gap:12px">
      <div class="checkin-hero"><p class="muted" style="margin:0;letter-spacing:.06em;text-transform:uppercase;font-size:12px">Corporate Cycling Programme</p><h2 style="font-size:24px">${coChip(co)} personal QR code</h2>
        <p class="lead" style="margin:0">Get your own QR code and ID number. Show it to the ride lead at every ride to record your attendance. Already have one? Enter the same details to see it again with your attendance record.</p></div>
      ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
      <form class="form" method="post" id="checkin">
        <label>Your full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
        <label>Work email${domains(co).length ? ` <span class="hint">(ending ${h(domains(co).map((d) => "@" + d).join(" or "))})</span>` : ""}<input name="email" type="email" required maxlength="160" value="${h(v.email)}" autocomplete="email"></label>
        ${co.qr_access === "list" ? "" : `<details><summary>First time? Tell us a little more</summary><div class="row2" style="margin-top:8px">
          <label>Community<select name="community"><option value="">Prefer not to say</option>${C.COMMUNITIES.map((x) => opt(x, x, v.community)).join("")}<option ${v.community === "Other" ? "selected" : ""}>Other</option></select></label>
          <label>Gender<select name="gender"><option value="">Prefer not to say</option>${["Female", "Male"].map((x) => opt(x, x, v.gender)).join("")}</select></label></div></details>`}
        <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
        <button class="btn primary big">Show my QR code</button>${privacyNote(co)}</form></section>`;
  }
  app.get("/c/:token", wrap(async (req, res) => {
    const co = await companyByToken(req.params.token);
    if (!co) return res.status(404).send(page(req, "Check-in", `<section class="card"><h2>This link isn't active</h2><p class="lead">Ask your ride leader for the current QR code.</p></section>`, { wide: false }));
    if (co.checkin_mode !== "self") return res.send(page(req, co.name + " personal QR code", myQrForm(co), { wide: false, scripts: `<script src="/checkin.js"></script>` }));
    const ss = await C.todaysSessions(pool, co);
    res.send(page(req, co.name + " check-in", checkinForm(co, ss), { wide: false, scripts: `<script src="/checkin.js"></script>` }));
  }));
  app.post("/c/:token", limit("corpcheckin", 30, 60 * 60e3), wrap(async (req, res) => {
    const co = await companyByToken(req.params.token);
    if (!co) return res.redirect("/c/" + encodeURIComponent(req.params.token));
    const b = req.body || {};
    if (b.website) return res.redirect("/c/" + encodeURIComponent(req.params.token));
    if (co.checkin_mode !== "self") return myQrPost(req, res, co, b);
    const ss = await C.todaysSessions(pool, co);
    const again = (err) => res.send(page(req, co.name + " check-in", checkinForm(co, ss, b, err), { wide: false, scripts: `<script src="/checkin.js"></script>` }));
    if (!ss.length) return again(null);
    if (R.clean(b.full_name).length < 3) return again("Please enter your full name.");
    if (b.email && !R.EMAIL_RE.test(R.normEmail(b.email))) return again("Please check your email address.");
    const target = ss.find((s) => C.sessionValue(s) === String(b.session)) || ss[0];
    const out = await tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["corp|" + co.code + "|" + R.todayLocal()]);
      const s = await C.resolveSession(c, C.sessionValue(target), { by: "QR self check-in" });
      let p = await C.findParticipant(c, co.code, { email: b.email, name: b.full_name }), created = false;
      if (!p) { p = await C.createParticipant(c, { ...b, company: co.code, community: [...C.COMMUNITIES, "Other"].includes(b.community) ? b.community : "", gender: ["Female", "Male"].includes(b.gender) ? b.gender : "" }, "public", "QR self check-in"); created = true; }
      else if (b.email && !p.email) await c.query("UPDATE corp_participants SET email = $2, updated_at = now() WHERE id = $1", [p.id, R.normEmail(b.email)]);
      const r = await C.markAttendance(c, s, p, "QR self check-in", "public");
      return { ...r, p, s, created };
    });
    if (out.status === "error") return again(out.message);
    const first = out.p.full_name.split(" ")[0];
    res.send(page(req, "Checked in", `<section class="card checkin-hero" style="padding:28px 16px">
      <div class="big-tick" aria-hidden="true">✓</div><h2 style="font-size:26px">${out.status === "ok" ? `Thanks, ${h(first)}!` : `You're already in, ${h(first)}`}</h2>
      <p class="lead" style="margin:0">${h(C.sessionName(out.s, co))} · ${fmtDate(out.s.session_date)}</p>
      <p style="margin:6px 0 0">${out.created ? "Welcome to the programme. 🎉" : out.total > 1 ? `That's session number ${out.total} for you.` : ""}</p>
      <p class="muted" style="font-size:13px">Have a great ride.</p></section>`, { wide: false }));
  }));

  /**
   * Personal QR code for a staff member. Found by work email, or by name when no email is on file yet.
   * A name whose record already has a different email is refused, so nobody can pull up someone else's code.
   */
  async function myQrPost(req, res, co, b) {
    const again = (err) => res.send(page(req, co.name + " personal QR code", myQrForm(co, b, err), { wide: false, scripts: `<script src="/checkin.js"></script>` }));
    const email = R.normEmail(b.email);
    if (R.clean(b.full_name).length < 3) return again("Please enter your full name.");
    if (!R.EMAIL_RE.test(email)) return again("Please enter your work email.");
    if (!domainOk(co, email)) return again(`Please use your ${co.name} work email (ending ${domains(co).map((d) => "@" + d).join(" or ")}).`);
    const out = await tx(async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["corpqr|" + co.code]);
      let p = await C.findParticipant(c, co.code, { email }), created = false;
      // list only: the email must already be on the company's staff list
      if (!p && co.qr_access === "list") return { err: `We couldn't find ${email} on the ${co.name} programme list. Check the spelling, or ask your ride lead to add you.` };
      if (!p) {
        const byName = await C.findParticipant(c, co.code, { name: b.full_name });
        if (byName && byName.email && byName.email !== email) return { err: "We have a different email for this name. Use the email you registered with, or ask your ride lead to show your code." };
        if (byName) { await c.query("UPDATE corp_participants SET email = $2, updated_at = now() WHERE id = $1", [byName.id, email]); p = { ...byName, email }; }
      }
      if (!p) { p = await C.createParticipant(c, { ...b, email, company: co.code, community: [...C.COMMUNITIES, "Other"].includes(b.community) ? b.community : "", gender: ["Female", "Male"].includes(b.gender) ? b.gender : "" }, "public", "Personal QR request"); created = true; }
      const hist = (await c.query("SELECT s.* FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = $1 ORDER BY s.session_date DESC", [p.id])).rows;
      await audit(c, "public", "corp.qr.view", "corp_participant", p.pid, null, null, created ? "New participant" : null);
      return { p, created, hist };
    });
    if (out.err) return again(out.err);
    const { p, hist } = out;
    const img = await QRCode.toDataURL(C.pidQr(p.pid), { errorCorrectionLevel: "M", margin: 2, width: 560 });
    const thisYear = hist.filter((s) => String(s.session_date).startsWith(R.todayLocal().slice(0, 4))).length;
    res.send(page(req, "My QR code", `<section class="card" style="display:grid;gap:12px">
      <div class="checkin-hero"><h2 style="font-size:24px">${out.created ? `Welcome, ${h(p.full_name.split(" ")[0])}!` : `Hi ${h(p.full_name.split(" ")[0])}`}</h2>
        <p class="lead" style="margin:0">This is your personal QR code. Show it to the ride lead at every ride.</p></div>
      <div class="poster" style="--co:${h(co.color)}"><img src="${img}" alt="Your QR code"><p style="font-size:22px;font-weight:700;letter-spacing:.04em">${h(p.pid)}</p><p>${h(p.full_name)} · ${h(co.name)}</p></div>
      <a class="btn primary big" href="${img}" download="${h(p.pid)}-QR.png" style="justify-content:center">Download my QR code</a>
      <p class="muted" style="margin:0;font-size:13px">Tip: take a screenshot too, or add it to your phone's photos. Your ID number is ${h(p.pid)}; if you forget your phone, tell the ride lead your ID.</p></section>
    <section class="card"><h2>My attendance</h2>
      <div class="tiles" style="margin:8px 0 12px">${tile("Sessions attended", nf(hist.length), "All time")}${tile("This year", nf(thisYear), R.todayLocal().slice(0, 4))}${tile("Last session", hist[0] ? fmtDate(hist[0].session_date) : "—", hist[0] ? C.sessionName(hist[0], co) : "Not yet")}</div>
      ${table(["Date", "Session"], hist.slice(0, 20).map((s) => [fmtDate(s.session_date), C.sessionName(s, co)]), { empty: "No sessions yet. See you at the next ride!" })}</section>`, { wide: false }));
  }

  // ===================================================== staff scanner (personal QR codes)
  app.get("/corporate/scan", S, wrap(async (req, res) => {
    const list = await C.companiesFor(user(req));
    const today = R.todayLocal();
    const options = [];
    for (const co of list) for (const s of await C.todaysSessions(pool, co)) options.push({ v: C.sessionValue(s), label: `${co.name} · ${label(s, co)}` });
    res.send(page(req, "Scan corporate QR", `
      <section class="card narrow"><h2>Scan personal QR codes</h2><p class="lead">Scan each staff member's personal code (it starts with CORP-) to record their attendance. For the WMF community, use <a href="/scan">WMF → Scan QR</a>.</p>
        ${options.length ? `<label class="f" style="display:grid;gap:4px"><span>Session today</span><select id="corpSession" class="inp">${options.map((o) => opt(o.v, o.label, "")).join("")}</select></label>`
    : `<div class="alert info"><span class="ic">i</span><span>No corporate session today (${fmtDate(today)}). <a href="/corporate/attendance">Create one</a> to scan into it.</span></div>`}</section>
      ${options.length ? `<section class="card narrow" style="display:grid;gap:12px"><div id="reader" aria-label="Camera"></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center"><button class="btn primary big" id="start">Start camera</button><button class="btn big" id="stop" hidden>Stop camera</button></div>
        <div id="result" class="scan-result" hidden aria-live="assertive"></div></section>
      <section class="card narrow"><h2>Forgot their QR code?</h2><p class="lead">Type their ID number (e.g. NMDC-0012, or just "nmdc 12"). You can also tick names on the <a href="/corporate/attendance">session page</a>.</p>
        <form class="toolbar" id="byId" style="margin:0"><input class="inp" id="pidInput" placeholder="ID number" autocomplete="off" style="max-width:220px" aria-label="ID number"><button class="btn primary">Check in</button></form></section>
      <section class="card narrow"><h2>This session</h2><ul class="log" id="log"><li class="muted">No scans yet on this device.</li></ul></section>` : ""}`,
    { active: "/corporate/scan", scripts: options.length ? `<script src="/vendor/html5-qrcode.min.js"></script><script src="/camhelp.js"></script><script src="/corp-scan.js"></script>` : "" }));
  }));
  app.post("/api/corp/scan", S, wrap(async (req, res) => {
    const { code, session } = req.body || {};
    const codes = (await C.companiesFor(user(req))).map((x) => x.code);
    res.json(await tx((c) => C.corpScan(c, { code, session, by: actor(req), codes })));
  }));

  // ===================================================== report for management & sponsors
  app.get("/corporate/report", V, wrap(async (req, res) => {
    const u = user(req), sc = await scope(req), per = C.periodFromQuery({ period: "quarter", ...req.query });
    if (!sc.list.length) return res.redirect("/corporate");
    const st = await C.stats({ codes: sc.codes, start: per.start, end: per.end });
    const prevEnd = addDays(per.start, -1), days = Math.round((Date.parse(per.end) - Date.parse(per.start)) / 864e5) + 1;
    const pr = await C.stats({ codes: sc.codes, start: addDays(prevEnd, -(days - 1)), end: prevEnd });
    const k = st.k, kp = pr.k, who = sc.sel ? sc.sel.name : "All corporate partners";
    const ch = (a, b) => (b ? `${a - b >= 0 ? "+" : ""}${Math.round(((a - b) / b) * 100)}%` : a ? "New" : "—");
    const rowsK = [["Rides held", k.rideSessions, kp.rideSessions], ["Ride attendance", k.rideAttendance, kp.rideAttendance], ["Average riders per ride", k.avgPerRide, kp.avgPerRide, 1],
      ["Other activities & events", k.events, kp.events], ["Activity & event attendance", k.eventAttendance, kp.eventAttendance], ["Total attendance", k.attendance, kp.attendance],
      ["People taking part (named)", k.people, kp.people], ["New joiners", k.newJoiners, kp.newJoiners], ["Active participants (2+ in 90 days)", k.active, kp.active], ["Sessions cancelled", k.cancelled, kp.cancelled]];
    const months = st.months.filter((m) => m.inRange);
    const evs = st.sessions.filter((s) => s.kind !== C.RIDE);
    // plain-language highlights, built only from the numbers above
    const hl = [];
    if (k.attendance) hl.push(`${nf(k.attendance)} attendances across ${nf(k.rideSessions)} ride${k.rideSessions === 1 ? "" : "s"} and ${nf(k.events)} other ${k.events === 1 ? "activity" : "activities"}.`);
    if (kp.attendance) hl.push(`Total attendance ${k.attendance >= kp.attendance ? "rose" : "fell"} ${Math.abs(Math.round(((k.attendance - kp.attendance) / kp.attendance) * 100))}% compared with the previous ${days} days.`);
    if (k.newJoiners) hl.push(`${nf(k.newJoiners)} new joiner${k.newJoiners > 1 ? "s" : ""} took part for the first time.`);
    if (k.repeatRate != null && k.people) hl.push(`${pct(k.repeatRate)} of participants came to two or more sessions.`);
    if (k.cancelled) hl.push(`${nf(k.cancelled)} session${k.cancelled > 1 ? "s were" : " was"} cancelled (weather, holidays or other reasons).`);
    const best = months.filter((m) => m.attendance).sort((a, b) => b.attendance - a.attendance)[0];
    if (best && months.length > 1) hl.push(`Busiest month: ${monLabel(best.month, true)} with ${nf(best.attendance)} attendances.`);
    const chart = columns({ categories: months.map((m) => m.month), short: (m) => monLabel(m), height: 200, label: "Attendance by month",
      series: sc.codes.length > 1 ? sc.codes.map((code) => ({ name: sc.byCode[code].name, color: sc.byCode[code].color, values: months.map((m) => m.byCo[code]) }))
        : [{ name: "Rides", color: "#2f7fd6", values: months.map((m) => m.rideAttendance) }, { name: "Other activities & events", color: "#7b62cf", values: months.map((m) => m.eventAttendance) }] });
    res.send(page(req, "Corporate report", `
      <div class="toolbar noprint" style="align-items:center"><button class="btn primary" data-print>Print or save as PDF</button><a class="btn" href="/corporate/report.xlsx?${qs({ company: sc.sel && sc.sel.code, ...perQs(per) })}">Download Excel</a></div>
      ${periodControls(per, companySelect(sc))}
      <div class="report-wrap"><article class="a4" id="report">
        <h2>Corporate Cycling Programme · ${h(who)}</h2>
        <p class="meta">${h(per.label)} (${fmtDate(per.start)} – ${fmtDate(per.end < R.todayLocal() ? per.end : R.todayLocal())}) · compared with the previous ${days} days · prepared ${fmtDate(R.todayLocal())} by the Cycling Development department</p>
        <div class="kpis"><div><b>${nf(k.attendance)}</b><span>Total attendance</span></div><div><b>${nf(k.rideSessions)}</b><span>Rides held</span></div><div><b>${nf(k.avgPerRide, 1)}</b><span>Average riders per ride</span></div><div><b>${nf(k.newJoiners)}</b><span>New joiners</span></div></div>
        <h3>Highlights</h3>${hl.length ? `<ul>${hl.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : "<p>No sessions in this period.</p>"}
        <h3>Key figures</h3>${table(["Measure", h(per.label), "Previous period", "Change"], rowsK.map(([l, a, b, d]) => [l, nf(a, d || 0), nf(b, d || 0), ch(a || 0, b || 0)]), { num: [1, 2, 3] })}
        <h3>Attendance by month</h3>${chart}
        ${table(["Month", "Rides", "Ride attendance", "Activities & events", "Their attendance", "Total", "Cancelled"], months.map((m) => [monLabel(m.month), m.rides, m.rideAttendance, m.events, m.eventAttendance, m.attendance, m.cancelled]), { num: [1, 2, 3, 4, 5, 6] })}
        ${sc.codes.length > 1 ? `<h3>By company</h3>${table(["Company", "Rides", "Avg per ride", "Activities & events", "Total attendance", "People", "Active now"], st.byCompany.map((b) => [sc.byCode[b.code].name, b.sessions, nf(b.avg, 1), b.events, b.attendance, b.people, b.active]), { num: [1, 2, 3, 4, 5, 6] })}` : ""}
        <h3>Activities and events</h3>${table(["Date", "Company", "Activity", "Attendance", "Notes"], evs.map((s) => [fmtDate(s.d), sc.byCode[s.company].name, s.title || s.kind, s.status === "Cancelled" ? "Cancelled" : s.attendance, s.remarks || ""]), { num: [3], empty: "No other activities in this period." })}
        <h3>Community</h3><p>Emirati: ${nf(k.emirati)} · Expat: ${nf(k.expat)} · Not recorded: ${nf(k.unknownCommunity)}</p>
        <p class="foot">Attendance counts each person once per session. Sessions recorded only as a headcount (${nf(k.headcountOnly)} in this period) count their headcount. Active participants attended 2 or more sessions in the 90 days to the end of the period. ${STAFF.includes(u.role) ? "" : "This report contains no names."}</p>
      </article></div>`, { active: "/corporate/report" }));
  }));
  app.get("/corporate/report.xlsx", V, wrap(async (req, res) => {
    const sc = await scope(req), per = C.periodFromQuery({ period: "quarter", ...req.query });
    const buf = await require("./corpexport").reportWorkbook({ sc, per, named: STAFF.includes(user(req).role) });
    await audit(pool, actor(req), "corp.export.report", "corp_report", sc.sel ? sc.sel.code : "ALL", null, { period: per.label });
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="Corporate-report-${sc.sel ? sc.sel.code : "ALL"}-${per.start}-to-${per.end}.xlsx"`).send(buf);
  }));
  app.get("/corporate/export.xlsx", S, wrap(async (req, res) => {
    const sc = await scope(req);
    const buf = await require("./corpexport").trackerWorkbook({ sc });
    await audit(pool, actor(req), "corp.export.tracker", "corp_tracker", sc.sel ? sc.sel.code : "ALL", null, null);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="CORPORATE_TRACKER_${sc.sel ? sc.sel.code : "UNIFIED"}_${R.todayLocal()}.xlsx"`).send(buf);
  }));

  // ===================================================== schedule: regular sessions per company (adjustable)
  const schedFields = (b) => ({
    kind: C.KINDS.includes(b.kind) ? b.kind : C.RIDE, title: R.clean(b.title).slice(0, 80),
    weekday: Math.min(6, Math.max(0, +b.weekday || 0)), week: C.WEEKS.some((w) => String(w[0]) === String(b.week)) ? +b.week : 0,
    start_time: /^\d{2}:\d{2}$/.test(b.start_time || "") ? b.start_time : null, location: R.clean(b.location) || null,
    starts: /^\d{4}-\d{2}-\d{2}$/.test(b.starts || "") ? b.starts : R.todayLocal(), ends: /^\d{4}-\d{2}-\d{2}$/.test(b.ends || "") ? b.ends : null,
  });
  const schedRow = (x, co, action) => `<form class="inline-form" method="post" action="${action}" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <select class="inp" name="kind" aria-label="Activity">${C.KINDS.map((k) => opt(k, k === C.RIDE ? "Ride" : k, x.kind)).join("")}</select>
      <input class="inp" name="title" value="${h(x.title)}" placeholder="Name (e.g. Aurora Yoga)" aria-label="Name" maxlength="80" style="width:170px">
      <select class="inp" name="week" aria-label="Which weeks">${C.WEEKS.map(([v, l]) => opt(v, l, x.week)).join("")}</select>
      <select class="inp" name="weekday" aria-label="Day">${C.WEEKDAYS_LONG.map((d, i) => opt(i, d, x.weekday)).join("")}</select>
      <input class="inp" type="time" name="start_time" value="${h(x.start_time)}" aria-label="Start time">
      <input class="inp" name="location" value="${h(x.location)}" placeholder="Location" aria-label="Location" maxlength="80" style="width:140px">
      <label class="muted" style="font-size:13px">From <input class="inp" type="date" name="starts" value="${h(x.starts || R.todayLocal())}"></label>
      <label class="muted" style="font-size:13px">Until <input class="inp" type="date" name="ends" value="${h(x.ends)}"></label>
      ${x.id ? `<select class="inp" name="active" aria-label="On or paused">${opt("1", "On", x.active ? "1" : "0")}${opt("0", "Paused", x.active ? "1" : "0")}</select>
        <button class="btn tblbtn">Save</button><button class="btn tblbtn danger" name="action" value="delete" formnovalidate>Remove</button>` : `<button class="btn primary tblbtn">Add</button>`}
    </form>`;
  app.get("/corporate/schedule", S, wrap(async (req, res) => {
    const list = await C.companiesFor(user(req)), codes = list.map((x) => x.code), today = R.todayLocal();
    const all = await C.schedules(pool, codes, { all: true });
    const occ = await C.occurrences(pool, codes, addDays(today, -21), addDays(today, 56));
    const counts = new Map((await pool.query("SELECT session_id, count(*)::int n FROM corp_attendance WHERE session_id = ANY($1) GROUP BY session_id", [occ.filter((o) => o.session).map((o) => o.session.id)])).rows.map((r) => [r.session_id, r.n]));
    const dateRow = (o, co) => {
      const s = o.session, past = o.date < today, n = s ? counts.get(s.id) || 0 : 0;
      const status = s ? (s.status === "Cancelled" ? `Cancelled${s.remarks ? ": " + s.remarks : ""}` : `${s.status} · ${n || s.headcount || 0} attended`) : past ? "Nothing recorded" : o.date === today ? "Today · opens at the first scan" : "Planned";
      const act = s && s.status === "Cancelled"
        ? (n ? "" : `<form method="post" action="/corporate/schedule/${o.sc.id}/date" class="inline-form"><input type="hidden" name="date" value="${o.date}"><button class="btn tblbtn" name="action" value="restore">Undo cancel</button></form>`)
        : `${s ? `<a class="btn tblbtn" href="/corporate/session/${s.id}">Open</a>` : past || o.date === today ? `<form method="post" action="/corporate/sessions" class="inline-form"><input type="hidden" name="company" value="${h(co.code)}"><input type="hidden" name="session_date" value="${o.date}"><input type="hidden" name="kind" value="${h(o.sc.kind)}"><input type="hidden" name="title" value="${h(o.sc.title)}"><input type="hidden" name="status" value="Held"><button class="btn tblbtn">Record attendance</button></form>` : ""}
           ${!s || !n ? `<form method="post" action="/corporate/schedule/${o.sc.id}/date" class="inline-form"><input type="hidden" name="date" value="${o.date}"><input class="inp" name="reason" placeholder="Reason (holiday, weather…)" maxlength="120" style="width:180px" aria-label="Reason"><button class="btn tblbtn danger" name="action" value="cancel">Cancel this date</button></form>` : ""}`;
      return [fmtDate(o.date) + " " + ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(o.date + "T12:00:00Z").getUTCDay()], C.schedName(o.sc, co) + (o.sc.start_time ? " · " + o.sc.start_time : ""), raw(`<span class="status-chip st-${s ? s.status : past ? "Absent" : "Scheduled"}">${h(status)}</span>`), raw(act)];
    };
    const cards = list.map((co) => {
      const mine = all.filter((x) => x.company === co.code), dates = occ.filter((o) => o.sc.company === co.code);
      return `<section class="card" id="${h(co.code)}"><h2>${coChip(co)}</h2>
        <p class="lead">${mine.filter((x) => x.active).map((x) => `<b>${h(C.schedName(x, co))}</b>: ${h(C.scheduleText(x))}`).join(" · ") || "No regular sessions yet."}</p>
        ${mine.map((x) => schedRow(x, co, `/corporate/schedule/${x.id}`)).join("")}
        <details style="margin-top:8px"><summary><b>Add a regular session</b></summary>${schedRow({ kind: C.RIDE, title: "", week: 0, weekday: 4, start_time: "", location: co.location || "", starts: today, ends: "", active: true }, co, `/corporate/schedule?company=${encodeURIComponent(co.code)}`)}</details>
        <h3 style="font-size:15px;margin-top:14px">Dates (last 3 weeks and next 8 weeks)</h3>
        ${table(["Date", "Session", "Status", ""], dates.map((o) => dateRow(o, co)), { empty: "No planned dates in this window." })}</section>`;
    });
    res.send(page(req, "Corporate schedule", `
      <section class="card"><h2>Regular sessions</h2><p class="lead">Set each company's regular sessions once: which day, which week of the month (every week, or e.g. the 1st Thursday), time and place.
        On the day, the session appears on the scanner and the company link by itself, and opens at the first scan. Holiday or bad weather? <b>Cancel this date</b> below; the rest of the schedule stays the same.
        "1st Thursday" means the first Thursday of the month (days 1–7), "2nd" days 8–14, and so on.</p></section>
      ${cards.join("")}`, { active: "/corporate/schedule" }));
  }));
  async function schedAllowed(req, id) {
    const x = (await pool.query("SELECT * FROM corp_schedules WHERE id = $1", [+id || 0])).rows[0];
    return x && (await C.companiesFor(user(req))).some((c) => c.code === x.company) ? x : null;
  }
  app.post("/corporate/schedule", S, wrap(async (req, res) => {
    const co = (await C.companiesFor(user(req))).find((x) => x.code === req.query.company);
    if (!co) return res.redirect("/corporate/schedule");
    const f = schedFields(req.body), k = Object.keys(f);
    const r = (await pool.query(`INSERT INTO corp_schedules (company, ${k}) VALUES ($1, ${k.map((_, i) => "$" + (i + 2))}) RETURNING id`, [co.code, ...k.map((x) => f[x])])).rows[0];
    await audit(pool, actor(req), "corp.schedule.create", "corp_schedule", String(r.id), null, { company: co.code, ...f });
    setFlash(req, "ok", `Added: ${C.schedName(f, co)}, ${C.scheduleText(f)}.`);
    res.redirect("/corporate/schedule#" + co.code);
  }));
  app.post("/corporate/schedule/:id", S, wrap(async (req, res) => {
    const x = await schedAllowed(req, req.params.id); if (!x) return res.redirect("/corporate/schedule");
    if (req.body.action === "delete") {
      await pool.query("DELETE FROM corp_schedules WHERE id = $1", [x.id]);
      await audit(pool, actor(req), "corp.schedule.delete", "corp_schedule", String(x.id), x, null);
      setFlash(req, "ok", "Removed. Sessions already recorded stay in the register.");
    } else {
      const f = { ...schedFields(req.body), starts: /^\d{4}-\d{2}-\d{2}$/.test(req.body.starts || "") ? req.body.starts : x.starts, active: req.body.active !== "0" }, k = Object.keys(f);
      await pool.query(`UPDATE corp_schedules SET ${k.map((y, i) => `${y} = $${i + 2}`).join(", ")} WHERE id = $1`, [x.id, ...k.map((y) => f[y])]);
      await audit(pool, actor(req), "corp.schedule.update", "corp_schedule", String(x.id), x, f);
      setFlash(req, "ok", "Schedule saved.");
    }
    res.redirect("/corporate/schedule#" + x.company);
  }));
  app.post("/corporate/schedule/:id/date", S, wrap(async (req, res) => {
    const x = await schedAllowed(req, req.params.id), d = req.body.date;
    if (!x || !/^\d{4}-\d{2}-\d{2}$/.test(d || "")) return res.redirect("/corporate/schedule");
    await tx(async (c) => {
      if (req.body.action === "restore") {
        const s = (await c.query("SELECT * FROM corp_sessions WHERE company = $1 AND session_date = $2 AND kind = $3 AND title = $4", [x.company, d, x.kind, x.title || ""])).rows[0];
        const n = s ? Number((await c.query("SELECT count(*) n FROM corp_attendance WHERE session_id = $1", [s.id])).rows[0].n) : 0;
        if (s && s.status === "Cancelled" && !n) await c.query("DELETE FROM corp_sessions WHERE id = $1", [s.id]);
        await audit(c, actor(req), "corp.schedule.restore", "corp_schedule", String(x.id), null, { date: d });
      } else {
        const s = await C.ensureSession(c, { company: x.company, date: d, kind: x.kind, title: x.title, status: "Cancelled", by: actor(req) });
        await c.query("UPDATE corp_sessions SET status = 'Cancelled', remarks = coalesce($2, remarks) WHERE id = $1", [s.id, R.clean(req.body.reason) || null]);
        await audit(c, actor(req), "corp.schedule.cancel", "corp_schedule", String(x.id), null, { date: d, reason: R.clean(req.body.reason) });
      }
    });
    setFlash(req, "ok", req.body.action === "restore" ? `${fmtDate(d)} is back on.` : `${fmtDate(d)} cancelled. It won't appear on the scanner, and reports count it as cancelled.`);
    res.redirect("/corporate/schedule#" + x.company);
  }));

  // ===================================================== admin: import & companies
  app.get("/corporate/admin", A, wrap(async (req, res) => {
    const list = await C.companies(pool, { all: true });
    const n = (await pool.query("SELECT (SELECT count(*) FROM corp_participants) p, (SELECT count(*) FROM corp_sessions) s, (SELECT count(*) FROM corp_attendance) a")).rows[0];
    res.send(page(req, "Corporate settings", `<div class="grid">
      <section class="card c6"><h2>Import the corporate tracker</h2><p class="lead">Upload CORPORATE_TRACKER_UNIFIED.xlsx (sheets Limad, NMDC, AURORA, Master Data). You'll see a preview first. Importing replaces all corporate participants, sessions and check-ins; the QR links stay the same.</p>
        <form class="form" method="post" action="/corporate/admin/import" enctype="multipart/form-data"><input type="file" name="file" accept=".xlsx" required><button class="btn primary">Read file and preview</button></form>
        <p class="muted">Now: ${n.p} participants, ${n.s} sessions, ${n.a} named check-ins.</p></section>
      <section class="card c6"><h2>Add a partner company</h2><form class="form" method="post" action="/corporate/admin/companies">
        <div class="row2"><label>Short code <span class="hint">(letters, e.g. ADNOC)</span><input name="code" required pattern="[A-Za-z]{2,12}" maxlength="12"></label><label>Name<input name="name" required maxlength="60"></label></div>
        <div class="row2"><label>Colour<input type="color" name="color" value="#7b62cf"></label></div><p class="muted" style="margin:0;font-size:13px">Then add its regular sessions on Corporate → Schedule.</p>
        <button class="btn">Add company</button></form></section>
      <section class="card c12"><h2>Partner companies</h2>${list.map((co) => `<form class="inline-form" method="post" action="/corporate/admin/companies/${h(co.code)}" style="padding:8px 0;border-bottom:1px solid var(--line)">
        <b style="min-width:70px">${h(co.code)}</b><input class="inp" name="name" value="${h(co.name)}" aria-label="Name" maxlength="60">
        <a class="btn tblbtn" href="/corporate/schedule#${h(co.code)}">Schedule</a>
        <input class="inp" name="location" value="${h(co.location)}" aria-label="Location" placeholder="Location" style="width:160px">
        <input class="inp" name="contact" value="${h(co.contact)}" aria-label="Contact" placeholder="Company contact" style="width:170px">
        <input type="color" name="color" value="${h(co.color || "#4d5ac2")}" aria-label="Colour">
        <input class="inp" name="email_domain" value="${h(co.email_domain)}" aria-label="Work email ending" placeholder="Work email ending, e.g. nmdc.ae" title="Only emails ending like this can get a code. Leave empty to allow any email." style="width:200px">
        <select class="inp" name="qr_access" aria-label="Who can get a personal code">${opt("anyone", "Anyone can get a code", co.qr_access)}${opt("list", "Only people on our list", co.qr_access)}</select>
        <select class="inp" name="checkin_mode" aria-label="How attendance is taken">${opt("personal", "Personal QR codes", co.checkin_mode)}${opt("self", "Self check-in link", co.checkin_mode)}</select>
        <select class="inp" name="active" aria-label="Status">${opt("1", "Active", co.active ? "1" : "0")}${opt("0", "Paused", co.active ? "1" : "0")}</select>
        <button class="btn tblbtn">Save</button></form>`).join("")}<p class="muted" style="font-size:13px">Regular sessions (days, weeks of the month, times) are set on <a href="/corporate/schedule">Corporate → Schedule</a>. Attendance: <b>Personal QR codes</b> means each person shows their own code to the ride lead and the company link only hands out codes; <b>Self check-in link</b> lets people check themselves in with the company link. <b>Work email ending</b> (e.g. nmdc.ae): only those emails can collect a personal code. <b>Only people on our list</b>: staff can collect a code only if their email is already on the participant list (upload the company's staff list on Corporate → Participants).</p></section>
    </div>`, { active: "/admin" }));
  }));
  app.post("/corporate/admin/companies", A, wrap(async (req, res) => {
    const code = R.clean(req.body.code).toUpperCase().replace(/[^A-Z]/g, "");
    if (code.length < 2 || !R.clean(req.body.name)) { setFlash(req, "err", "Enter a code and a name."); return res.redirect("/corporate/admin"); }
    const r = await pool.query("INSERT INTO corp_companies (code, name, ride_days, color, checkin_token, sort_order) VALUES ($1,$2,$3,$4,$5,(SELECT coalesce(max(sort_order),0)+1 FROM corp_companies)) ON CONFLICT DO NOTHING",
      [code, R.clean(req.body.name), R.clean(req.body.ride_days) || "Thu", /^#[0-9a-f]{6}$/i.test(req.body.color || "") ? req.body.color : "#7b62cf", C.token()]);
    if (r.rowCount) await audit(pool, actor(req), "corp.company.create", "corp_company", code, null, req.body);
    setFlash(req, r.rowCount ? "ok" : "err", r.rowCount ? `Added ${code}.` : "That code is already used.");
    res.redirect("/corporate/admin");
  }));
  app.post("/corporate/admin/companies/:code", A, wrap(async (req, res) => {
    const b = req.body, co0 = (await pool.query("SELECT * FROM corp_companies WHERE code = $1", [req.params.code])).rows[0];
    if (!co0) return res.redirect("/corporate/admin");
    await pool.query("UPDATE corp_companies SET name = $2, ride_days = $3, ride_time = $4, location = $5, contact = $6, color = $7, active = $8, checkin_mode = $9, email_domain = $10, qr_access = $11 WHERE code = $1",
      [req.params.code, R.clean(b.name) || req.params.code, R.clean(b.ride_days) || co0.ride_days || "Thu", R.clean(b.ride_time) || co0.ride_time || null, R.clean(b.location) || null, R.clean(b.contact) || null, /^#[0-9a-f]{6}$/i.test(b.color || "") ? b.color : null, b.active !== "0", b.checkin_mode === "self" ? "self" : "personal",
        String(b.email_domain || "").toLowerCase().split(/[\s,;]+/).map((d) => d.replace(/^@/, "")).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)).join(", ") || null, b.qr_access === "list" ? "list" : "anyone"]);
    await audit(pool, actor(req), "corp.company.update", "corp_company", req.params.code, null, b);
    setFlash(req, "ok", "Saved.");
    res.redirect("/corporate/admin");
  }));
  app.post("/corporate/admin/import", A, upload.single("file"), wrap(async (req, res) => {
    if (!req.file) { setFlash(req, "err", "Choose a file."); return res.redirect("/corporate/admin"); }
    let parsed;
    try { parsed = await require("./corpimport").parseTracker(req.file.buffer); } catch (e) { setFlash(req, "err", "Couldn't read that file: " + e.message); return res.redirect("/corporate/admin"); }
    for (const [k, v] of previews) if (Date.now() - v.at > 30 * 60e3) previews.delete(k);
    const t = crypto.randomBytes(16).toString("hex");
    previews.set(t, { parsed, name: req.file.originalname, at: Date.now() });
    const s = parsed.summary, have = Number((await pool.query("SELECT count(*) n FROM corp_sessions")).rows[0].n);
    res.send(page(req, "Corporate import preview", `<section class="card"><h2>Preview: ${h(req.file.originalname)}</h2><p class="lead">Nothing has been written yet. Records from ${fmtDate(s.first)} to ${fmtDate(s.last)}.</p>
      ${table(["Company", "Participants", "Sessions held", "Cancelled", "Attendance", "Named check-ins"], s.sessions.map((x) => [x.co, s.participants[x.co] == null ? "Headcounts only" : s.participants[x.co], x.held, x.cancelled, x.attendance, x.checkins]), { num: [2, 3, 4, 5] })}
      <p class="muted">Master Data: ${s.masterDataMatched} rows matched the per-person sheets; ${s.masterDataUsed} rows filled dates they don't cover.</p>
      ${parsed.warnings.length ? `<h3 style="margin-top:12px">Notes</h3><ul>${parsed.warnings.map((w) => `<li>${h(w)}</li>`).join("")}</ul>` : ""}
      <form class="form" method="post" action="/corporate/admin/import/commit" style="margin-top:12px"><input type="hidden" name="token" value="${t}">
        ${have ? `<div class="alert crit"><span class="ic">!</span><span>There are already ${have} corporate sessions. Importing replaces <b>all</b> corporate participants, sessions and check-ins, including QR check-ins made in the app.</span></div><label>Type REPLACE to confirm<input name="confirm" required pattern="REPLACE"></label>` : ""}
        <button class="btn primary big">Import now</button></form></section>`, { active: "/admin", wide: false }));
  }));
  app.post("/corporate/admin/import/commit", A, wrap(async (req, res) => {
    const p = previews.get(String(req.body.token || ""));
    if (!p) { setFlash(req, "err", "The preview expired. Upload the file again."); return res.redirect("/corporate/admin"); }
    const have = Number((await pool.query("SELECT count(*) n FROM corp_sessions")).rows[0].n);
    if (have && req.body.confirm !== "REPLACE") { setFlash(req, "err", "Type REPLACE to confirm."); return res.redirect("/corporate/admin"); }
    const out = await require("./corpimport").commitTracker(p.parsed, actor(req), p.name);
    previews.delete(String(req.body.token));
    setFlash(req, "ok", `Imported ${out.participants} participants, ${out.sessions} sessions and ${out.checkins} check-ins.`);
    res.redirect("/corporate");
  }));
};
