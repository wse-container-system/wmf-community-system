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

  // overview, schedule, leave and the HR file now live in deptschedule.js
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
    res.send(page(req, "Team", `<div class="grid">
      <section class="card c12"><h2>Team</h2><p class="lead">Add each person with their sign-in email so they can enter their own time and leave. Accounts: <a href="/admin/users">Admin → Staff accounts</a> (Coordinator). Someone without an account (e.g. your manager) can use a personal link from <a href="/department/share">Share</a>.</p>${all.map(row).join("") || `<p class="muted">No staff yet.</p>`}</section>
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
  // ===================================================== older daily-status exports and the HR CSV feed (kept for existing links)
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
    // the same timesheet as the HR file: one row per person per day, from the team schedule
    const D = await require("./deptschedule").load(from, to), rows = [];
    for (const st of D.staff) for (const d of days(from, to)) {
      const x = D.day(st.id, d);
      rows.push([st.employee_no, st.full_name, st.email, d, ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow(d)],
        [x.leave ? `${x.leave.leave_type} leave${x.leave.status === "Approved" ? "" : " (tentative)"}` : "", x.holiday || "", ...x.blocks.map((b) => `${b.start_time ? b.start_time + "-" + b.end_time + " " : ""}${b.activity}${b.note ? " (" + b.note + ")" : ""}`)].filter(Boolean).join("; "),
        x.hours ? Math.round(x.hours * 100) / 100 : ""]);
    }
    await audit(pool, "hr-feed", "dept.export.timesheet", "dept_shifts", `${from}..${to}`, null, null);
    res.type("text/csv").send(csv([["Employee no", "Name", "Email", "Date", "Day", "Schedule", "Hours"], ...rows]));
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
