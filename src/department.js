"use strict";
/**
 * Cycling Development department admin: staff list, daily attendance, annual leave with approvals and balances,
 * and exports for HR (Excel, CSV, and a token-protected feed HR systems or Power Automate can pull).
 */
const ExcelJS = require("exceljs");
const crypto = require("crypto");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate, fmtTs, monLabel, nf, tile, table, raw } = require("./views");
const { addDays, monthEnd, addMonths } = require("./engine").helpers;

const STATUSES = ["Present", "Remote", "Field/Event", "Leave", "Sick", "Absent", "Off"];
const CODE = { Present: "P", Remote: "R", "Field/Event": "F", Leave: "L", Sick: "S", Absent: "A", Off: "O", Holiday: "H" };
const LEAVE_TYPES = ["Annual", "Sick", "Compassionate", "Maternity / Paternity", "Hajj", "Study / Exam", "Time off in lieu", "Unpaid", "Other"];
const WEEKEND = [0, 6]; // Sunday, Saturday (UAE working week Mon–Fri)
const opt = (v, l, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? "selected" : ""}>${h(l)}</option>`;
const chip = (s) => `<span class="status-chip st-${h(String(s || "").split(/[ /]/)[0])}">${h(s || "—")}</span>`;
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const isWeekend = (d) => WEEKEND.includes(dow(d));
const days = (a, b) => { const out = []; for (let d = a; d <= b; d = addDays(d, 1)) out.push(d); return out; };
const nowHM = () => R.nowLocal().slice(11, 16);

async function holidays(from, to) {
  return new Map((await pool.query("SELECT holiday::text d, name FROM dept_holidays WHERE holiday BETWEEN $1 AND $2", [from, to])).rows.map((r) => [r.d, r.name]));
}
/** Working days in a leave request: Monday–Friday, public holidays left out. */
async function workingDays(a, b, half) {
  const hol = await holidays(a, b);
  const n = days(a, b).filter((d) => !isWeekend(d) && !hol.has(d)).length;
  return half && a === b && n ? 0.5 : n;
}
async function balances(year, staffIds) {
  const r = await pool.query(`SELECT s.id, s.leave_entitlement::float ent, s.carry_over::float co,
      coalesce(sum(l.days) FILTER (WHERE l.status = 'Approved' AND l.leave_type = 'Annual'), 0)::float taken,
      coalesce(sum(l.days) FILTER (WHERE l.status IN ('Pending','Tentative') AND l.leave_type = 'Annual'), 0)::float pending,
      coalesce(sum(l.days) FILTER (WHERE l.status = 'Approved' AND l.leave_type = 'Sick'), 0)::float sick,
      coalesce(sum(l.days) FILTER (WHERE l.status = 'Approved' AND l.leave_type NOT IN ('Annual','Sick')), 0)::float other
    FROM dept_staff s LEFT JOIN dept_leave l ON l.staff_id = s.id AND extract(year FROM l.start_date) = $1
    WHERE ($2::int[] IS NULL OR s.id = ANY($2)) GROUP BY s.id`, [+year, staffIds || null]);
  return new Map(r.rows.map((b) => [b.id, { ...b, remaining: b.ent + b.co - b.taken }]));
}
/** Status of every staff member on every day: a recorded day wins, then approved leave, then public holiday, then weekend. */
async function grid(staff, from, to) {
  const ids = staff.map((s) => s.id);
  const [att, lv, hol] = await Promise.all([
    pool.query("SELECT staff_id, work_date::text d, status, check_in, check_out, notes FROM dept_attendance WHERE staff_id = ANY($1) AND work_date BETWEEN $2 AND $3", [ids, from, to]),
    pool.query("SELECT * FROM dept_leave WHERE staff_id = ANY($1) AND status = 'Approved' AND end_date >= $2 AND start_date <= $3", [ids, from, to]),
    holidays(from, to)]);
  const rec = new Map(att.rows.map((a) => [a.staff_id + "|" + a.d, a]));
  const out = new Map();
  for (const s of staff) for (const d of days(from, to)) {
    const r = rec.get(s.id + "|" + d);
    let v = r ? { status: r.status, check_in: r.check_in, check_out: r.check_out, notes: r.notes, recorded: true } : null;
    if (!v) { const l = lv.rows.find((x) => x.staff_id === s.id && x.start_date <= d && x.end_date >= d); if (l && !isWeekend(d) && !hol.has(d)) v = { status: l.leave_type === "Sick" ? "Sick" : "Leave", notes: l.leave_type + " leave", leave: true }; }
    if (!v && hol.has(d)) v = { status: "Holiday", notes: hol.get(d) };
    if (!v && isWeekend(d)) v = { status: "Off", weekend: true };
    out.set(s.id + "|" + d, v || { status: "" });
  }
  return { get: (id, d) => out.get(id + "|" + d), holidays: hol };
}

module.exports = function department(app, { need, page, setFlash, actor, user, wrap }) {
  const A = need("admin"), S = need("admin", "coordinator");
  const me = async (req) => (await pool.query("SELECT * FROM dept_staff WHERE lower(email) = lower($1) AND active", [user(req).email])).rows[0];
  const activeStaff = async () => (await pool.query("SELECT * FROM dept_staff WHERE active ORDER BY full_name")).rows;

  // ===================================================== overview (admin)
  app.get("/department", S, wrap(async (req, res) => {
    if (user(req).role !== "admin") return res.redirect("/department/me");
    const DS = require("./deptschedule");
    const today = R.todayLocal(), staff = await activeStaff();
    const D = await DS.load(today, today);
    const pend = (await pool.query("SELECT l.*, s.full_name FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id WHERE l.status = 'Pending' ORDER BY l.start_date")).rows;
    const upcoming = (await pool.query("SELECT l.*, s.full_name FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id WHERE l.status IN ('Approved','Tentative') AND l.end_date >= $1 AND l.start_date <= $2 ORDER BY l.start_date", [today, addDays(today, 45)])).rows;
    const bal = await balances(today.slice(0, 4));
    const x = staff.map((s0) => D.day(s0.id, today));
    const working = x.filter((d) => d.hours > 0).length, away = x.filter((d) => d.leave && d.leave.status === "Approved").length;
    res.send(page(req, "Department", `
      <div class="card-head"><div><h2 style="font-size:22px">Cycling Development department</h2><p class="muted" style="margin:2px 0 0">${fmtDate(today)}${D.holidays.get(today) ? " · " + h(D.holidays.get(today)) : isWeekend(today) ? " · weekend" : ""}</p></div>
        <div class="toolbar" style="margin:0"><a class="btn" href="/department/schedule">Team schedule</a><a class="btn" href="/department/availability">Availability</a><a class="btn primary" href="/department/schedule/export.xlsx?month=${today.slice(0, 7)}">This month for HR</a></div></div>
      ${!staff.length ? `<div class="alert info"><span class="ic">i</span><span>Start by adding the team on the <a href="/department/staff">Staff</a> page. Use the same email as their sign-in so they can enter their own schedule and leave.</span></div>` : ""}
      <div class="tiles">${tile("Team members", nf(staff.length), "Active")}${tile("Working today", nf(working), "Have hours on today's schedule")}${tile("On leave today", nf(away), "Confirmed leave")}
        ${tile("Leave coming up", nf(upcoming.length), "Next 45 days, confirmed and tentative", "/department/availability")}${pend.length ? tile("Leave requests waiting", nf(pend.length), "Need a decision", "/department/leave?status=Pending") : ""}</div>
      <div class="grid">
        <section class="card c7"><div class="card-head"><h2>Today</h2><a class="btn tblbtn" href="/department/schedule?view=day&date=${today}">Day timeline</a></div>${DS.todayList(D, today) || `<p class="muted">No staff yet.</p>`}</section>
        <section class="card c5"><h2>Leave coming up</h2>${table(["Name", "Type", "From", "To", "Plan"], upcoming.map((l) => [l.full_name, l.leave_type, fmtDate(l.start_date), fmtDate(l.end_date), raw(`<span class="status-chip st-${l.status === "Approved" ? "Approved" : "Tentative"}">${l.status === "Approved" ? "Confirmed" : "Tentative"}</span>`)]), { empty: "No leave planned in the next 45 days." })}
          ${pend.length ? `<h2 style="margin-top:16px">Waiting for a decision</h2>${pend.map((l) => decisionForm(l)).join("")}` : ""}</section>
        <section class="card c12"><h2>Annual leave balances ${today.slice(0, 4)}</h2><p class="lead">Working days. Remaining = entitlement + carried over − confirmed annual leave this year. Planned = tentative (not yet counted).</p>
          ${table(["Name", "Entitlement", "Carried over", "Taken", "Planned", "Remaining", "Sick days", "Other leave"], staff.map((s0) => { const b0 = bal.get(s0.id) || {}; return [s0.full_name, nf(b0.ent, 1), nf(b0.co, 1), nf(b0.taken, 1), nf(b0.pending, 1), raw(`<b>${nf(b0.remaining, 1)}</b>`), nf(b0.sick, 1), nf(b0.other, 1)]; }), { num: [1, 2, 3, 4, 5, 6, 7] })}</section>
      </div>`, { active: "/department" }));
  }));
  const decisionForm = (l) => `<div style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px;display:grid;gap:6px">
    <div><b>${h(l.full_name)}</b> · ${h(l.leave_type)} · ${fmtDate(l.start_date)}${l.end_date !== l.start_date ? " – " + fmtDate(l.end_date) : ""} · <b>${nf(l.days, 1)} day${+l.days === 1 ? "" : "s"}</b>${l.reason ? `<br><span class="muted">${h(l.reason)}</span>` : ""}</div>
    <form class="inline-form" method="post" action="/department/leave/${l.id}/decide"><input class="inp" name="note" placeholder="Note (optional)" maxlength="200" style="flex:1 1 160px">
      <button class="btn primary tblbtn" name="decision" value="Approved">Approve</button><button class="btn danger tblbtn" name="decision" value="Rejected">Reject</button></form></div>`;

  // ===================================================== my attendance & leave (any staff account linked by email)
  app.get("/department/me", S, wrap(async (req, res) => {
    const s0 = await me(req), today = R.todayLocal();
    if (!s0) return res.send(page(req, "My schedule & leave", `<section class="card"><h2>Your account isn't on the team list yet</h2><p class="lead">An administrator adds you on Department → Staff using your sign-in email (${h(user(req).email)}). Then you can enter your schedule and leave plans here.</p></section>`, { active: "/department/me" }));
    const DS = require("./deptschedule"), mon = DS.mondayOf(today);
    const D = await DS.load(mon, addDays(mon, 6), { staffIds: [s0.id] }), wk = await DS.weekHours(s0.id, mon);
    const bal = (await balances(today.slice(0, 4), [s0.id])).get(s0.id) || {};
    const reqs = (await pool.query("SELECT * FROM dept_leave WHERE staff_id = $1 AND status <> 'Cancelled' ORDER BY start_date DESC LIMIT 30", [s0.id])).rows;
    const t = D.day(s0.id, today);
    const planChip = (st) => `<span class="status-chip st-${st === "Approved" ? "Approved" : st === "Tentative" ? "Tentative" : st}">${st === "Approved" ? "Confirmed" : st === "Pending" ? "Requested" : st}</span>`;
    res.send(page(req, "My schedule & leave", `
      <div class="grid">
        <section class="card c7"><div class="card-head"><div><h2>My week</h2><p class="lead" style="margin:2px 0 0">${hmText(wk)} this week · today ${t.blocks.length ? "" : "nothing entered yet"}</p></div>
          <div class="toolbar" style="margin:0"><a class="btn primary" href="/department/schedule/new?staff=${s0.id}&date=${today}">+ Add to my schedule</a><a class="btn" href="/department/schedule?view=week&date=${today}">Team week</a></div></div>
          <div class="ds-myweek">${days(mon, addDays(mon, 6)).map((d) => { const x = D.day(s0.id, d); return `<div class="ds-myday ${d === today ? "is-today" : ""}"><b>${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow(d)]} ${+d.slice(8)}</b>
            <div>${x.leave ? `<span class="ds-leave ${x.leave.status === "Approved" ? "conf" : "tent"}">${h(x.leave.leave_type)} leave${x.leave.status === "Approved" ? "" : " (tentative)"}</span>` : ""}${x.blocks.map((b0) => `<a class="ds-chip" style="--ac:${(DS.ACTS.find((a0) => a0.k === b0.activity) || { c: "#777" }).c}" href="/department/schedule/entry/${b0.id}"><span class="ds-t">${h(b0.start_time ? b0.start_time + "–" + (b0.end_time || "") : "All day")}</span><span class="ds-a">${h(b0.activity)}${b0.note ? " · " + h(b0.note) : ""}</span></a>`).join("") || (x.holiday ? `<span class="ds-leave hol">${h(x.holiday)}</span>` : "")}</div>
            <a class="ds-add" href="/department/schedule/new?staff=${s0.id}&date=${d}" aria-label="Add">+</a></div>`; }).join("")}</div>
          <form method="post" action="/department/schedule/copy-week" style="margin-top:10px"><input type="hidden" name="staff_id" value="${s0.id}"><input type="hidden" name="monday" value="${mon}"><button class="btn">Copy last week into this week</button> <span class="muted" style="font-size:13px">Fills only the days that are still empty.</span></form></section>
        <section class="card c5" id="leave"><h2>My leave ${today.slice(0, 4)}</h2>
          <div class="tiles" style="margin-bottom:10px">${tile("Remaining", nf(bal.remaining, 1), "Working days")}${tile("Taken", nf(bal.taken, 1), "Confirmed")}${tile("Planned", nf(bal.pending, 1), "Tentative")}</div>
          <details ${reqs.length ? "" : "open"}><summary><b>Add a leave plan</b></summary>${leaveForm("/department/me/leave", null)}</details>
          <h3 style="font-size:15px;margin-top:12px">My leave plans</h3>
          ${table(["Type", "Dates", "Days", "Plan", ""], reqs.map((l) => [l.leave_type, `${fmtDate(l.start_date)}${l.end_date !== l.start_date ? " – " + fmtDate(l.end_date) : ""}`, nf(l.days, 1), raw(planChip(l.status)),
            raw(`${l.status === "Tentative" ? `<form method="post" action="/department/me/leave/${l.id}/confirm" style="display:inline"><button class="btn tblbtn primary">Confirm</button></form> ` : ""}${["Pending", "Tentative"].includes(l.status) || (l.status === "Approved" && l.start_date > today) ? `<form method="post" action="/department/me/leave/${l.id}/cancel" data-confirm="Remove this leave plan?" style="display:inline"><button class="btn tblbtn">Remove</button></form>` : ""}`)]), { num: [2], empty: "No leave planned yet." })}</section>
      </div>`, { active: "/department/me" }));
  }));
  const hmText = (n) => (n ? `${Math.floor(n)}${n % 1 ? ":" + String(Math.round((n % 1) * 60)).padStart(2, "0") : ""} hours` : "No hours");
  app.post("/department/me/clock", S, wrap(async (req, res) => {
    const s = await me(req); if (!s) return res.redirect("/department/me");
    const today = R.todayLocal(), a = req.body.action;
    if (a === "out") {
      const r = await pool.query("UPDATE dept_attendance SET check_out = $3, updated_by = $4, updated_at = now() WHERE staff_id = $1 AND work_date = $2", [s.id, today, nowHM(), actor(req)]);
      setFlash(req, r.rowCount ? "ok" : "err", r.rowCount ? `Checked out at ${nowHM()}.` : "Check in first.");
    } else if (["Present", "Remote", "Field/Event"].includes(a)) {
      await pool.query(`INSERT INTO dept_attendance (staff_id, work_date, status, check_in, source, updated_by) VALUES ($1,$2,$3,$4,'Self',$5)
        ON CONFLICT (staff_id, work_date) DO UPDATE SET status = $3, check_in = coalesce(dept_attendance.check_in, $4), updated_by = $5, updated_at = now()`, [s.id, today, a, nowHM(), actor(req)]);
      setFlash(req, "ok", `Recorded: ${a}, ${nowHM()}.`);
    }
    res.redirect("/department/me");
  }));
  const leaveForm = (action, staff) => `<form class="form" method="post" action="${action}" style="margin-top:10px">
    ${staff ? `<label>Staff member<select name="staff_id" required>${staff.map((s) => opt(s.id, s.full_name, "")).join("")}</select></label>` : ""}
    <label>Type<select name="leave_type">${LEAVE_TYPES.map((t) => opt(t, t, "Annual")).join("")}</select></label>
    <div class="row2"><label>First day<input type="date" name="start_date" required></label><label>Last day<input type="date" name="end_date" required></label></div>
    <label class="check"><input type="checkbox" name="half" value="1"> <span>Half day (one-day requests only)</span></label>
    <label>Reason / note <span class="hint">(optional)</span><input name="reason" maxlength="300"></label>
    <fieldset style="border:0;padding:0;margin:0;display:grid;gap:6px"><legend style="font-weight:600;margin-bottom:4px">Plan</legend>
      <label class="check"><input type="radio" name="plan" value="Confirmed" checked> <span><b>Confirmed</b>: approved or booked</span></label>
      <label class="check"><input type="radio" name="plan" value="Tentative"> <span><b>Tentative</b>: still planning, may change</span></label></fieldset>
    <button class="btn primary">Save leave plan</button></form>`;
  async function createLeave(req, staffId, b) {
    const status = b.plan === "Tentative" ? "Tentative" : "Approved";
    const approve = status === "Approved";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || "") || !/^\d{4}-\d{2}-\d{2}$/.test(b.end_date || "") || b.end_date < b.start_date) return "Choose a first and last day (the last day can't be before the first).";
    const n = await workingDays(b.start_date, b.end_date, !!b.half);
    if (!n) return "Those dates are all weekends or public holidays.";
    const clash = (await pool.query("SELECT 1 FROM dept_leave WHERE staff_id = $1 AND status IN ('Pending','Approved','Tentative') AND end_date >= $2 AND start_date <= $3", [staffId, b.start_date, b.end_date])).rows[0];
    if (clash) return "There is already leave planned for some of those days.";
    const type = LEAVE_TYPES.includes(b.leave_type) ? b.leave_type : "Annual";
    await tx(async (c) => {
      const r = (await c.query(`INSERT INTO dept_leave (staff_id, leave_type, start_date, end_date, days, reason, status, requested_by, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [staffId, type, b.start_date, b.end_date, n, R.clean(b.reason) || null, status, actor(req), approve ? actor(req) : null, approve ? new Date() : null])).rows[0];
      await audit(c, actor(req), "dept.leave.create", "dept_leave", String(r.id), null, { staffId, type, from: b.start_date, to: b.end_date, days: n, status });
    });
    return null;
  }
  app.post("/department/me/leave", S, wrap(async (req, res) => {
    const s = await me(req); if (!s) return res.redirect("/department/me");
    const err = await createLeave(req, s.id, req.body);
    setFlash(req, err ? "err" : "ok", err || (req.body.plan === "Tentative" ? "Tentative leave saved. Mark it confirmed when it's booked." : "Leave saved as confirmed."));
    res.redirect("/department/me");
  }));
  app.post("/department/me/leave/:id/confirm", S, wrap(async (req, res) => {
    const s = await me(req); if (!s) return res.redirect("/department/me");
    const r = await pool.query("UPDATE dept_leave SET status = 'Approved', decided_by = $3, decided_at = now() WHERE id = $1 AND staff_id = $2 AND status = 'Tentative' RETURNING id", [+req.params.id, s.id, actor(req)]);
    if (r.rowCount) await audit(pool, actor(req), "dept.leave.confirm", "dept_leave", req.params.id, null, null);
    setFlash(req, "ok", "Marked as confirmed.");
    res.redirect("/department/me#leave");
  }));
  app.post("/department/me/leave/:id/cancel", S, wrap(async (req, res) => {
    const s = await me(req); if (!s) return res.redirect("/department/me");
    const r = await pool.query("UPDATE dept_leave SET status = 'Cancelled', decided_by = $3, decided_at = now() WHERE id = $1 AND staff_id = $2 AND (status IN ('Pending','Tentative') OR (status = 'Approved' AND start_date > $4)) RETURNING id", [+req.params.id, s.id, actor(req), R.todayLocal()]);
    if (r.rowCount) await audit(pool, actor(req), "dept.leave.cancel", "dept_leave", req.params.id, null, null);
    setFlash(req, r.rowCount ? "ok" : "err", r.rowCount ? "Cancelled." : "That request can't be cancelled any more.");
    res.redirect("/department/me");
  }));

  // ===================================================== attendance month (admin)
  app.get("/department/attendance", A, wrap(async (req, res) => {
    const today = R.todayLocal(), m = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : today.slice(0, 7);
    const staff = await activeStaff(), ds = days(m + "-01", monthEnd(m)), g = await grid(staff, ds[0], ds[ds.length - 1]);
    const cnt = (s, st) => ds.filter((d) => (g.get(s.id, d) || {}).status === st).length;
    const body = staff.map((s) => `<tr><td class="name">${h(s.full_name)}</td>${ds.map((d) => { const v = g.get(s.id, d) || {}; return `<td class="c ${isWeekend(d) ? "we" : ""}" title="${h(fmtDate(d))}: ${h(v.status || "not recorded")}${v.check_in ? " · in " + h(v.check_in) : ""}${v.check_out ? " · out " + h(v.check_out) : ""}${v.notes ? " · " + h(v.notes) : ""}">${v.status ? `<span class="status-chip st-${h(v.status.split(/[ /]/)[0])}" style="padding:0 4px">${CODE[v.status] || "?"}</span>` : d <= today && !isWeekend(d) ? '<span class="muted">·</span>' : ""}</td>`; }).join("")}
      <td class="n">${cnt(s, "Present") + cnt(s, "Remote") + cnt(s, "Field/Event")}</td><td class="n">${cnt(s, "Leave")}</td><td class="n">${cnt(s, "Sick")}</td><td class="n">${cnt(s, "Absent")}</td></tr>`).join("");
    res.send(page(req, "Department attendance", `
      <div class="card-head"><div><h2 style="font-size:22px">Attendance · ${h(monLabel(m, true))}</h2><p class="muted" style="margin:2px 0 0">P present · R remote · F field / event · L leave · S sick · A absent · O off / weekend · H public holiday. Approved leave fills in by itself.</p></div>
        <div class="toolbar noprint" style="margin:0"><a class="btn" href="/department/attendance?month=${addMonths(m, -1)}">← ${h(monLabel(addMonths(m, -1)))}</a>${m < today.slice(0, 7) ? `<a class="btn" href="/department/attendance?month=${addMonths(m, 1)}">${h(monLabel(addMonths(m, 1)))} →</a>` : ""}<a class="btn primary" href="/department/export/attendance.xlsx?month=${m}">Download (.xlsx)</a></div></div>
      <section class="card"><div class="tw"><table class="reg month-grid"><thead><tr><th>Name</th>${ds.map((d) => `<th class="c ${isWeekend(d) ? "we" : ""}">${+d.slice(8)}<br>${"SMTWTFS"[dow(d)]}</th>`).join("")}<th class="n">Worked</th><th class="n">Leave</th><th class="n">Sick</th><th class="n">Absent</th></tr></thead><tbody>${body || `<tr><td class="muted">Add staff first.</td></tr>`}</tbody></table></div></section>
      <section class="card"><h2>Record attendance</h2><p class="lead">For one person, one day or a range of days. Weekends are skipped unless you tick the box.</p>
        <form class="form" method="post" action="/department/attendance/set"><input type="hidden" name="back" value="/department/attendance?month=${m}">
          <div class="row2"><label>Staff member<select name="staff_id">${opt("all", "Everyone", "")}${staff.map((s) => opt(s.id, s.full_name, "")).join("")}</select></label><label>Status<select name="status">${STATUSES.map((x) => opt(x, x, "Present")).join("")}<option value="clear">Clear (remove the record)</option></select></label></div>
          <div class="row2"><label>From<input type="date" name="from" value="${today}" required></label><label>To <span class="hint">(optional)</span><input type="date" name="to"></label></div>
          <div class="row2"><label>Check-in time <span class="hint">(optional)</span><input type="time" name="check_in"></label><label>Check-out time <span class="hint">(optional)</span><input type="time" name="check_out"></label></div>
          <label>Note<input name="notes" maxlength="200" placeholder="e.g. NMDC ride, Liwa camp"></label>
          <label class="check"><input type="checkbox" name="weekends" value="1"> <span>Include weekends (e.g. weekend rides or camps)</span></label>
          <button class="btn primary">Save</button></form></section>`, { active: "/department/attendance" }));
  }));
  app.post("/department/attendance/set", A, wrap(async (req, res) => {
    const b = req.body, back = String(b.back || "/department/attendance").startsWith("/department") ? b.back : "/department/attendance";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(b.from || "")) { setFlash(req, "err", "Choose a date."); return res.redirect(back); }
    const to = /^\d{4}-\d{2}-\d{2}$/.test(b.to || "") && b.to >= b.from ? b.to : b.from;
    if (days(b.from, to).length > 62) { setFlash(req, "err", "Choose two months or less at a time."); return res.redirect(back); }
    const ids = b.staff_id === "all" ? (await activeStaff()).map((s) => s.id) : [+b.staff_id].filter(Boolean);
    const ds = days(b.from, to).filter((d) => b.weekends || b.from === to || !isWeekend(d));
    const clear = b.status === "clear", status = STATUSES.includes(b.status) ? b.status : null;
    if (!clear && !status) { setFlash(req, "err", "Choose a status."); return res.redirect(back); }
    await tx(async (c) => {
      for (const id of ids) for (const d of ds) {
        if (clear) await c.query("DELETE FROM dept_attendance WHERE staff_id = $1 AND work_date = $2", [id, d]);
        else await c.query(`INSERT INTO dept_attendance (staff_id, work_date, status, check_in, check_out, notes, source, updated_by) VALUES ($1,$2,$3,$4,$5,$6,'Admin',$7)
          ON CONFLICT (staff_id, work_date) DO UPDATE SET status = $3, check_in = coalesce($4, dept_attendance.check_in), check_out = coalesce($5, dept_attendance.check_out), notes = coalesce($6, dept_attendance.notes), source = 'Admin', updated_by = $7, updated_at = now()`,
        [id, d, status, R.clean(b.check_in) || null, R.clean(b.check_out) || null, R.clean(b.notes) || null, actor(req)]);
      }
      await audit(c, actor(req), "dept.attendance.set", "dept_attendance", ids.join(","), null, { from: b.from, to, status: clear ? "cleared" : status, days: ds.length });
    });
    setFlash(req, "ok", `Saved ${ids.length * ds.length} day${ids.length * ds.length === 1 ? "" : "s"}.`);
    res.redirect(back);
  }));

  // ===================================================== leave (admin)
  app.get("/department/leave", A, wrap(async (req, res) => {
    const today = R.todayLocal(), y = /^\d{4}$/.test(req.query.year || "") ? req.query.year : today.slice(0, 4);
    const st = ["Pending", "Approved", "Tentative", "Rejected", "Cancelled"].includes(req.query.status) ? req.query.status : "";
    const rows = (await pool.query(`SELECT l.*, s.full_name FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id WHERE extract(year FROM l.start_date) = $1 ${st ? "AND l.status = $2" : ""} ORDER BY l.start_date DESC`, [+y, ...(st ? [st] : [])])).rows;
    const staff = await activeStaff();
    res.send(page(req, "Leave", `
      <div class="card-head"><div><h2 style="font-size:22px">Leave ${h(y)}</h2></div><a class="btn primary" href="/department/export/leave.xlsx?year=${h(y)}">Download leave register (.xlsx)</a></div>
      <form class="toolbar" method="get"><label class="f"><span>Year</span><select class="inp" name="year" data-autosubmit>${[+today.slice(0, 4) + 1, +today.slice(0, 4), +today.slice(0, 4) - 1].map((x) => opt(x, x, y)).join("")}</select></label>
        <label class="f"><span>Status</span><select class="inp" name="status" data-autosubmit>${opt("", "All", st)}${[["Approved", "Confirmed"], ["Tentative", "Tentative"], ["Pending", "Requested"], ["Rejected", "Rejected"], ["Cancelled", "Cancelled"]].map(([x, l]) => opt(x, l, st)).join("")}</select></label></form>
      <div class="grid"><section class="card c8">${rows.filter((l) => l.status === "Pending").map(decisionForm).join("")}
        ${table(["Name", "Type", "From", "To", "Days", "Status", "Requested", "Decided by", ""], rows.map((l) => [l.full_name, l.leave_type, fmtDate(l.start_date), fmtDate(l.end_date), nf(l.days, 1), raw(chip(l.status === "Approved" ? "Confirmed" : l.status).replace("st-Confirmed", "st-Approved")), fmtTs(l.requested_at), l.decided_by ? `${l.decided_by}${l.decision_note ? " · " + l.decision_note : ""}` : "",
          raw(`${l.status === "Tentative" ? `<form method="post" action="/department/leave/${l.id}/decide" style="display:inline"><input type="hidden" name="decision" value="Approved"><button class="btn tblbtn primary">Confirm</button></form> ` : ""}${["Approved", "Tentative"].includes(l.status) ? `<form method="post" action="/department/leave/${l.id}/decide" data-confirm="Cancel this leave?" style="display:inline"><input type="hidden" name="decision" value="Cancelled"><button class="btn tblbtn">Cancel</button></form>` : ""}`)]), { num: [4], empty: "No leave recorded." })}</section>
      <section class="card c4"><h2>Add leave for someone</h2><p class="lead">Confirmed or tentative. Leave counts working days (Mon–Fri) and skips public holidays.</p>${leaveForm("/department/leave", staff)}</section></div>`, { active: "/department/leave" }));
  }));
  app.post("/department/leave", A, wrap(async (req, res) => {
    const err = await createLeave(req, +req.body.staff_id, req.body);
    setFlash(req, err ? "err" : "ok", err || "Leave recorded.");
    res.redirect("/department/leave");
  }));
  app.post("/department/leave/:id/decide", A, wrap(async (req, res) => {
    const d = ["Approved", "Rejected", "Cancelled"].includes(req.body.decision) ? req.body.decision : null;
    if (d) {
      const r = await pool.query("UPDATE dept_leave SET status = $2, decided_by = $3, decided_at = now(), decision_note = coalesce($4, decision_note) WHERE id = $1 AND status IN ('Pending','Approved','Tentative') RETURNING *", [+req.params.id, d, actor(req), R.clean(req.body.note) || null]);
      if (r.rowCount) await audit(pool, actor(req), "dept.leave." + d.toLowerCase(), "dept_leave", req.params.id, null, { status: d }, R.clean(req.body.note) || null);
      setFlash(req, "ok", `Leave ${d.toLowerCase()}.`);
    }
    res.redirect(req.get("referer") && new URL(req.get("referer")).host === req.get("host") ? new URL(req.get("referer")).pathname + new URL(req.get("referer")).search : "/department/leave");
  }));

  // ===================================================== staff & public holidays (admin)
  app.get("/department/staff", A, wrap(async (req, res) => {
    const all = (await pool.query("SELECT * FROM dept_staff ORDER BY active DESC, full_name")).rows;
    const users = new Set((await pool.query("SELECT lower(email) e FROM users WHERE active")).rows.map((r) => r.e));
    const hol = (await pool.query("SELECT holiday::text d, name FROM dept_holidays WHERE holiday >= $1 ORDER BY holiday", [R.todayLocal().slice(0, 4) + "-01-01"])).rows;
    const row = (s) => `<form class="inline-form" method="post" action="/department/staff/${s.id}" style="padding:8px 0;border-bottom:1px solid var(--line)">
      <input class="inp" name="full_name" value="${h(s.full_name)}" aria-label="Name" required style="width:180px"><input class="inp" name="email" type="email" value="${h(s.email)}" aria-label="Email" placeholder="Email" style="width:220px">
      <input class="inp" name="employee_no" value="${h(s.employee_no)}" aria-label="Employee number" placeholder="Emp. no." style="width:90px"><input class="inp" name="job_title" value="${h(s.job_title)}" aria-label="Job title" placeholder="Job title" style="width:160px">
      <input class="inp" type="date" name="start_date" value="${h(s.start_date)}" aria-label="Start date" title="Start date"><label class="muted" style="font-size:13px">Leave/yr <input class="inp" type="number" step="0.5" min="0" name="leave_entitlement" value="${h(s.leave_entitlement)}" style="width:70px"></label>
      <label class="muted" style="font-size:13px">Carried <input class="inp" type="number" step="0.5" min="0" name="carry_over" value="${h(s.carry_over)}" style="width:64px"></label>
      <select class="inp" name="active" aria-label="Status">${opt("1", "Active", s.active ? "1" : "0")}${opt("0", "Left", s.active ? "1" : "0")}</select><button class="btn tblbtn">Save</button>
      ${s.email ? users.has(s.email.toLowerCase()) ? '<span class="badge good">Can sign in</span>' : '<span class="badge warn" title="Add a sign-in under Admin → Staff accounts with this email">No sign-in</span>' : ""}</form>`;
    res.send(page(req, "Department staff", `<div class="grid">
      <section class="card c12"><h2>Team</h2><p class="lead">Use each person's sign-in email so they can record attendance and request leave under Department → My attendance & leave. Accounts are made under <a href="/admin/users">Admin → Staff accounts</a> (role Coordinator).</p>${all.map(row).join("") || `<p class="muted">No staff yet.</p>`}</section>
      <section class="card c6"><h2>Add a team member</h2><form class="form" method="post" action="/department/staff">
        <div class="row2"><label>Full name<input name="full_name" required maxlength="120"></label><label>Email<input type="email" name="email" maxlength="160"></label></div>
        <div class="row2"><label>Employee number<input name="employee_no" maxlength="30"></label><label>Job title<input name="job_title" maxlength="80" placeholder="e.g. Cycling Coach"></label></div>
        <div class="row2"><label>Start date<input type="date" name="start_date"></label><label>Annual leave (working days / year)<input type="number" step="0.5" min="0" name="leave_entitlement" value="22"></label></div>
        <button class="btn primary">Add</button></form></section>
      <section class="card c6"><h2>Public holidays</h2><p class="lead">Left out of leave days and shown as H on the attendance month.</p>
        ${table(["Date", "Holiday", ""], hol.map((x) => [fmtDate(x.d), x.name, raw(`<form method="post" action="/department/holidays/delete"><input type="hidden" name="d" value="${x.d}"><button class="btn tblbtn">Remove</button></form>`)]), { empty: "None added for this year." })}
        <form class="inline-form" method="post" action="/department/holidays" style="margin-top:10px"><input class="inp" type="date" name="d" required aria-label="Date"><input class="inp" name="to" type="date" aria-label="Last day (optional)" title="Last day (optional, for multi-day holidays)"><input class="inp" name="name" required placeholder="e.g. Eid Al Adha" maxlength="80"><button class="btn">Add</button></form></section>
    </div>`, { active: "/department/staff" }));
  }));
  const staffFields = (b) => ({ full_name: R.clean(b.full_name), email: R.normEmail(b.email) || null, employee_no: R.clean(b.employee_no) || null, job_title: R.clean(b.job_title) || null,
    start_date: /^\d{4}-\d{2}-\d{2}$/.test(b.start_date || "") ? b.start_date : null, leave_entitlement: +b.leave_entitlement >= 0 && b.leave_entitlement !== "" ? +b.leave_entitlement : 22, carry_over: +b.carry_over > 0 ? +b.carry_over : 0 });
  app.post("/department/staff", A, wrap(async (req, res) => {
    const f = staffFields(req.body);
    if (!f.full_name) { setFlash(req, "err", "Enter a name."); return res.redirect("/department/staff"); }
    try {
      const k = Object.keys(f);
      await pool.query(`INSERT INTO dept_staff (${k}) VALUES (${k.map((_, i) => "$" + (i + 1))})`, k.map((x) => f[x]));
      await audit(pool, actor(req), "dept.staff.create", "dept_staff", f.email || f.full_name, null, f);
      setFlash(req, "ok", `Added ${f.full_name}.`);
    } catch (e) { if (e.code === "23505") setFlash(req, "err", "That email is already on the list."); else throw e; }
    res.redirect("/department/staff");
  }));
  app.post("/department/staff/:id", A, wrap(async (req, res) => {
    const f = { ...staffFields(req.body), active: req.body.active !== "0" };
    if (!f.full_name) { setFlash(req, "err", "The name can't be empty."); return res.redirect("/department/staff"); }
    try {
      const k = Object.keys(f);
      await pool.query(`UPDATE dept_staff SET ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")} WHERE id = $1`, [+req.params.id, ...k.map((x) => f[x])]);
      await audit(pool, actor(req), "dept.staff.update", "dept_staff", req.params.id, null, f);
      setFlash(req, "ok", "Saved.");
    } catch (e) { if (e.code === "23505") setFlash(req, "err", "That email is already used by someone else."); else throw e; }
    res.redirect("/department/staff");
  }));
  app.post("/department/holidays", A, wrap(async (req, res) => {
    const a = req.body.d, b = /^\d{4}-\d{2}-\d{2}$/.test(req.body.to || "") && req.body.to >= a ? req.body.to : a;
    if (/^\d{4}-\d{2}-\d{2}$/.test(a || "") && R.clean(req.body.name) && days(a, b).length <= 10) {
      for (const d of days(a, b)) await pool.query("INSERT INTO dept_holidays (holiday, name) VALUES ($1,$2) ON CONFLICT (holiday) DO UPDATE SET name = $2", [d, R.clean(req.body.name)]);
      setFlash(req, "ok", "Holiday added.");
    } else setFlash(req, "err", "Enter a date and a name (up to 10 days).");
    res.redirect("/department/staff");
  }));
  app.post("/department/holidays/delete", A, wrap(async (req, res) => { await pool.query("DELETE FROM dept_holidays WHERE holiday = $1", [req.body.d]); res.redirect("/department/staff"); }));

  // ===================================================== HR exports
  app.get("/department/hr", A, wrap(async (req, res) => {
    const today = R.todayLocal(), m = addMonths(today.slice(0, 7), -1), base = `${req.protocol}://${req.get("host")}`;
    const feed = !!process.env.HR_FEED_TOKEN;
    res.send(page(req, "HR export", `<div class="grid">
      <section class="card c12" style="border-color:var(--accent)"><h2>Monthly schedule for HR (use this one)</h2><p class="lead">The team schedule for the month: a summary per person (days worked, hours, hours by activity, weeks over the weekly limit, leave and public holidays worked), one sheet per person with every day's blocks and a total after each week, and a colour-coded team grid.</p>
        <form class="toolbar" method="get" action="/department/schedule/export.xlsx"><label class="f"><span>Month</span><input class="inp" type="month" name="month" value="${m}" max="${today.slice(0, 7)}"></label><button class="btn primary">Download (.xlsx)</button><a class="btn" href="/department/schedule/print?month=${m}">Print / PDF</a></form></section>
      <section class="card c6"><h2>Daily status (older check-in records)</h2><p class="lead">The attendance month as a grid (one row per person, one column per day) plus a list of every day with times, and totals per person. Ready to send to HR or payroll.</p>
        <form class="toolbar" method="get" action="/department/export/attendance.xlsx"><label class="f"><span>Month</span><input class="inp" type="month" name="month" value="${m}" max="${today.slice(0, 7)}"></label><button class="btn primary">Download (.xlsx)</button></form></section>
      <section class="card c6"><h2>Leave register</h2><p class="lead">Every leave request for the year with its decision, and each person's annual leave balance.</p>
        <form class="toolbar" method="get" action="/department/export/leave.xlsx"><label class="f"><span>Year</span><input class="inp" type="number" name="year" value="${today.slice(0, 4)}" min="2024" max="2100"></label><button class="btn primary">Download (.xlsx)</button></form></section>
      <section class="card c12"><h2>Connect to the HR system</h2>
        <p class="lead">For HR systems, Power Automate or Excel “Get data from web”, the same records are available as CSV files at fixed web addresses, protected by a secret key.</p>
        ${feed ? `<dl class="kv"><dt>Attendance (CSV)</dt><dd><code>${h(base)}/api/hr/attendance.csv?from=${m}-01&amp;to=${monthEnd(m)}&amp;key=…</code></dd>
          <dt>Leave (CSV)</dt><dd><code>${h(base)}/api/hr/leave.csv?year=${today.slice(0, 4)}&amp;key=…</code></dd><dt>Key</dt><dd>The value of HR_FEED_TOKEN in Render (Environment). Give it only to HR.</dd></dl>`
    : `<div class="alert info"><span class="ic">i</span><span>Switched off. To switch it on, add an environment variable <b>HR_FEED_TOKEN</b> in Render (any long random text) and redeploy. Then this box shows the addresses to give HR.</span></div>`}
        <p class="muted" style="font-size:13px">Columns: Employee no, Name, Email, Date, Day, Status, Check in, Check out, Hours, Note. Status values: Present, Remote, Field/Event, Leave, Sick, Absent, Off, Holiday.</p></section></div>`, { active: "/department/hr" }));
  }));
  async function attendanceRows(from, to) {
    const staff = (await pool.query("SELECT * FROM dept_staff WHERE active OR id IN (SELECT staff_id FROM dept_attendance WHERE work_date BETWEEN $1 AND $2) ORDER BY full_name", [from, to])).rows;
    const g = await grid(staff, from, to), out = [];
    const hrs = (a, b) => { if (!a || !b) return null; const [h1, m1] = a.split(":").map(Number), [h2, m2] = b.split(":").map(Number); const v = (h2 * 60 + m2 - h1 * 60 - m1) / 60; return v > 0 ? Math.round(v * 100) / 100 : null; };
    for (const s of staff) for (const d of days(from, to)) { const v = g.get(s.id, d) || {}; out.push({ s, d, v, hours: hrs(v.check_in, v.check_out) }); }
    return { staff, g, out };
  }
  app.get("/department/export/attendance.xlsx", A, wrap(async (req, res) => {
    const m = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : R.todayLocal().slice(0, 7);
    const from = m + "-01", to = monthEnd(m), { staff, g, out } = await attendanceRows(from, to), ds = days(from, to);
    const wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development";
    const head = (row) => { row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4D5AC2" } }; c.alignment = { horizontal: "center", vertical: "middle", wrapText: true }; }); };
    const ws = wb.addWorksheet("Month grid");
    ws.addRow([`Cycling Development department · attendance ${monLabel(m, true)}`]).font = { bold: true, size: 13 };
    ws.addRow(["P present · R remote · F field/event · L leave · S sick · A absent · O off/weekend · H public holiday"]);
    head(ws.addRow(["Emp. no", "Name", ...ds.map((d) => `${+d.slice(8)} ${"SMTWTFS"[dow(d)]}`), "Worked", "Leave", "Sick", "Absent"]));
    staff.forEach((s, i) => {
      const r = 4 + i, first = 3, last = 2 + ds.length, L = (n) => { let x = ""; while (n > 0) { const k = (n - 1) % 26; x = String.fromCharCode(65 + k) + x; n = Math.floor((n - 1) / 26); } return x; };
      const rng = `${L(first)}${r}:${L(last)}${r}`;
      ws.addRow([s.employee_no || "", s.full_name, ...ds.map((d) => CODE[(g.get(s.id, d) || {}).status] || ""),
        { formula: `COUNTIF(${rng},"P")+COUNTIF(${rng},"R")+COUNTIF(${rng},"F")` }, { formula: `COUNTIF(${rng},"L")` }, { formula: `COUNTIF(${rng},"S")` }, { formula: `COUNTIF(${rng},"A")` }]);
    });
    ws.getColumn(2).width = 26; ds.forEach((_, i) => { ws.getColumn(3 + i).width = 4.5; ws.getColumn(3 + i).alignment = { horizontal: "center" }; });
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];
    const ls = wb.addWorksheet("Daily records");
    head(ls.addRow(["Emp. no", "Name", "Email", "Date", "Day", "Status", "Check in", "Check out", "Hours", "Note"]));
    for (const x of out) ls.addRow([x.s.employee_no || "", x.s.full_name, x.s.email || "", new Date(x.d + "T00:00:00Z"), ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow(x.d)], x.v.status || "Not recorded", x.v.check_in || "", x.v.check_out || "", x.hours, x.v.notes || ""]);
    ls.getColumn(4).numFmt = "d mmm yyyy"; [10, 26, 30, 12, 6, 14, 9, 9, 7, 30].forEach((w, i) => { ls.getColumn(i + 1).width = w; });
    ls.views = [{ state: "frozen", ySplit: 1 }]; ls.autoFilter = { from: "A1", to: "J1" };
    await audit(pool, actor(req), "dept.export.attendance", "dept_attendance", m, null, null);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="Cycling-Development-attendance-${m}.xlsx"`).send(await wb.xlsx.writeBuffer());
  }));
  app.get("/department/export/leave.xlsx", A, wrap(async (req, res) => {
    const y = /^\d{4}$/.test(req.query.year || "") ? req.query.year : R.todayLocal().slice(0, 4);
    const rows = (await pool.query("SELECT l.*, s.full_name, s.employee_no, s.email FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id WHERE extract(year FROM l.start_date) = $1 ORDER BY l.start_date", [+y])).rows;
    const staff = (await pool.query("SELECT * FROM dept_staff ORDER BY active DESC, full_name")).rows, bal = await balances(y);
    const wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development";
    const head = (row) => row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4D5AC2" } }; });
    const a = wb.addWorksheet("Leave requests");
    head(a.addRow(["Emp. no", "Name", "Email", "Type", "First day", "Last day", "Working days", "Status", "Reason", "Requested by", "Requested", "Decided by", "Decided", "Decision note"]));
    for (const l of rows) a.addRow([l.employee_no || "", l.full_name, l.email || "", l.leave_type, new Date(l.start_date + "T00:00:00Z"), new Date(l.end_date + "T00:00:00Z"), +l.days, l.status, l.reason || "", l.requested_by || "", l.requested_at, l.decided_by || "", l.decided_at, l.decision_note || ""]);
    [10, 24, 28, 18, 12, 12, 12, 11, 30, 26, 18, 26, 18, 30].forEach((w, i) => { a.getColumn(i + 1).width = w; });
    a.getColumn(5).numFmt = a.getColumn(6).numFmt = "d mmm yyyy"; a.getColumn(11).numFmt = a.getColumn(13).numFmt = "d mmm yyyy hh:mm";
    a.autoFilter = { from: "A1", to: "N1" }; a.views = [{ state: "frozen", ySplit: 1 }];
    const b = wb.addWorksheet("Balances " + y);
    head(b.addRow(["Emp. no", "Name", "Entitlement", "Carried over", "Annual taken", "Annual pending", "Remaining", "Sick days", "Other leave"]));
    staff.forEach((s, i) => { const x = bal.get(s.id) || {}; b.addRow([s.employee_no || "", s.full_name, x.ent, x.co, x.taken, x.pending, { formula: `C${i + 2}+D${i + 2}-E${i + 2}` }, x.sick, x.other]); });
    [10, 26, 12, 12, 12, 14, 12, 10, 12].forEach((w, i) => { b.getColumn(i + 1).width = w; });
    await audit(pool, actor(req), "dept.export.leave", "dept_leave", y, null, null);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="Cycling-Development-leave-${y}.xlsx"`).send(await wb.xlsx.writeBuffer());
  }));

  // token-protected CSV feed for HR systems (switched on by HR_FEED_TOKEN)
  const csv = (rows) => rows.map((r) => r.map((v) => { const s = String(v == null ? "" : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");
  const keyOk = (req) => { const t = process.env.HR_FEED_TOKEN, k = String(req.query.key || ""); return !!t && k.length === t.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(t)); };
  app.get("/api/hr/attendance.csv", wrap(async (req, res) => {
    if (!keyOk(req)) return res.status(403).type("text").send("Key missing or wrong.");
    const today = R.todayLocal(), from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from || "") ? req.query.from : today.slice(0, 7) + "-01", to0 = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to || "") ? req.query.to : today;
    const to = to0 < from ? from : days(from, to0).length > 92 ? addDays(from, 91) : to0;
    const { out } = await attendanceRows(from, to);
    await audit(pool, "hr-feed", "dept.export.attendance", "dept_attendance", `${from}..${to}`, null, null);
    res.type("text/csv").send(csv([["Employee no", "Name", "Email", "Date", "Day", "Status", "Check in", "Check out", "Hours", "Note"], ...out.map((x) => [x.s.employee_no, x.s.full_name, x.s.email, x.d, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow(x.d)], x.v.status, x.v.check_in, x.v.check_out, x.hours, x.v.notes])]));
  }));
  app.get("/api/hr/leave.csv", wrap(async (req, res) => {
    if (!keyOk(req)) return res.status(403).type("text").send("Key missing or wrong.");
    const y = /^\d{4}$/.test(req.query.year || "") ? req.query.year : R.todayLocal().slice(0, 4);
    const rows = (await pool.query("SELECT l.*, s.full_name, s.employee_no, s.email FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id WHERE extract(year FROM l.start_date) = $1 ORDER BY l.start_date", [+y])).rows;
    await audit(pool, "hr-feed", "dept.export.leave", "dept_leave", y, null, null);
    res.type("text/csv").send(csv([["Employee no", "Name", "Email", "Type", "First day", "Last day", "Working days", "Status", "Decided by", "Decided at"], ...rows.map((l) => [l.employee_no, l.full_name, l.email, l.leave_type, l.start_date, l.end_date, l.days, l.status, l.decided_by, l.decided_at ? new Date(l.decided_at).toISOString() : ""])]));
  }));
};
module.exports.workingDays = workingDays;
