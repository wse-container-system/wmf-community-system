"use strict";
/**
 * Department team schedule: who works when and on what (office, WMF ride, corporate ride, events…), in coloured
 * time blocks per person per day. Day, week and month views, team availability (leave confirmed / tentative,
 * public holidays), weekly hours against the 48-hour week, an Excel file for HR, and a read-only link for a manager.
 */
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate, fmtTs, monLabel, nf, table, raw } = require("./views");
const { addDays, monthEnd, addMonths } = require("./engine").helpers;

// activities: colour, whether the time counts as working hours, whether it is a whole day with no times
const ACTS = [
  { k: "Office", c: "#2f7fd6", hours: true },
  { k: "WMF Ride", c: "#d6489b", hours: true },
  { k: "Corporate Ride", c: "#7b3fb8", hours: true },
  { k: "Event", c: "#e07b1a", hours: true },
  { k: "Workshop / Training", c: "#13917a", hours: true },
  { k: "Mechanic", c: "#a87a00", hours: true },
  { k: "Business trip", c: "#4a6a8a", hours: true },
  { k: "Lieu day", c: "#8a8a8a", hours: false, allDay: true },
  { k: "Off", c: "#b4aec6", hours: false, allDay: true },
];
const ACT = Object.fromEntries(ACTS.map((a) => [a.k, a]));
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const mondayOf = (d) => addDays(d, -((dow(d) + 6) % 7));
const days = (a, b) => { const o = []; for (let d = a; d <= b; d = addDays(d, 1)) o.push(d); return o; };
const mins = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const hrs = (b) => { if (!ACT[b.activity] || !ACT[b.activity].hours) return 0; const a = mins(b.start_time), z = mins(b.end_time); return a != null && z != null && z > a ? (z - a) / 60 : 0; };
const hm = (n) => (n == null ? "—" : `${Math.floor(n)}${n % 1 ? ":" + String(Math.round((n % 1) * 60)).padStart(2, "0") : ""}h`);
const ymd = (s) => String(s).slice(0, 10);
const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const okTime = (s) => /^\d{2}:\d{2}$/.test(s || "");

async function weeklyLimit() {
  const r = (await pool.query("SELECT value FROM settings WHERE key = 'deptWeeklyHours'")).rows[0];
  return r ? +r.value || 48 : 48; // UAE labour law: up to 48 working hours a week
}

/** Everything needed to draw a date range: staff, blocks, leave (confirmed and tentative), public holidays. */
async function load(from, to, { staffIds } = {}) {
  const staff = (await pool.query(`SELECT * FROM dept_staff WHERE (active OR id IN (SELECT staff_id FROM dept_shifts WHERE work_date BETWEEN $1 AND $2)) ${staffIds ? "AND id = ANY($3)" : ""} ORDER BY full_name`, [from, to, ...(staffIds ? [staffIds] : [])])).rows;
  const ids = staff.map((s) => s.id);
  const [sh, lv, hol] = await Promise.all([
    pool.query("SELECT *, work_date::text AS d FROM dept_shifts WHERE staff_id = ANY($1) AND work_date BETWEEN $2 AND $3 ORDER BY work_date, start_time NULLS FIRST, id", [ids, from, to]),
    pool.query("SELECT *, start_date::text AS a, end_date::text AS z FROM dept_leave WHERE staff_id = ANY($1) AND status IN ('Approved','Tentative','Pending') AND end_date >= $2 AND start_date <= $3", [ids, from, to]),
    pool.query("SELECT holiday::text AS d, name FROM dept_holidays WHERE holiday BETWEEN $1 AND $2", [from, to]),
  ]);
  const blocks = new Map();
  for (const b of sh.rows) { const k = b.staff_id + "|" + b.d; if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(b); }
  const holidays = new Map(hol.rows.map((x) => [x.d, x.name]));
  const day = (id, d) => {
    const bl = blocks.get(id + "|" + d) || [];
    const leave = lv.rows.filter((l) => l.staff_id === id && l.a <= d && l.z >= d && !(dow(d) === 0 || dow(d) === 6) && !holidays.has(d))
      .sort((x, y) => (x.status === "Approved" ? -1 : 1) - (y.status === "Approved" ? -1 : 1))[0] || null;
    const timed = bl.filter((b) => b.start_time);
    return { blocks: bl, hours: bl.reduce((a, b) => a + hrs(b), 0), leave, holiday: holidays.get(d) || null, weekend: dow(d) === 0 || dow(d) === 6,
      first: timed.length ? timed.map((b) => b.start_time).sort()[0] : null, last: timed.length ? timed.map((b) => b.end_time).filter(Boolean).sort().slice(-1)[0] : null };
  };
  return { staff, day, holidays, leave: lv.rows, from, to };
}

// ---------------------------------------------------------------- pieces of HTML
const chip = (b, href) => {
  const a = ACT[b.activity] || { c: "#777" };
  const t = b.start_time ? `${b.start_time}${b.end_time ? "–" + b.end_time : ""}` : "All day";
  const inner = `<span class="ds-t">${h(t)}</span><span class="ds-a">${h(b.activity)}${b.note ? ` · ${h(b.note)}` : ""}</span>`;
  return href ? `<a class="ds-chip" style="--ac:${a.c}" href="${href}" title="Change or remove">${inner}</a>` : `<span class="ds-chip" style="--ac:${a.c}">${inner}</span>`;
};
const leaveTag = (l) => l ? `<span class="ds-leave ${l.status === "Approved" ? "conf" : "tent"}" title="${h(l.leave_type)} leave · ${l.status === "Approved" ? "confirmed" : l.status === "Pending" ? "waiting for approval" : "tentative"}">${h(l.leave_type === "Annual" ? "Leave" : l.leave_type)}${l.status === "Approved" ? "" : l.status === "Pending" ? " (requested)" : " (tentative)"}</span>` : "";
const legend = () => `<div class="legend ds-legend">${ACTS.map((a) => `<span><i style="background:${a.c}"></i>${h(a.k)}</span>`).join("")}
  <span><i class="ds-li conf"></i>Leave confirmed</span><span><i class="ds-li tent"></i>Leave tentative</span><span><i style="background:#2e9e5b"></i>Public holiday</span></div>`;

function viewNav(base, view, date, extra = "") {
  const q = (v, d) => `${base}/schedule?view=${v}&date=${d}`;
  const prev = view === "day" ? addDays(date, -1) : view === "week" ? addDays(date, -7) : addMonths(date.slice(0, 7), -1) + "-01";
  const next = view === "day" ? addDays(date, 1) : view === "week" ? addDays(date, 7) : addMonths(date.slice(0, 7), 1) + "-01";
  const label = view === "day" ? `${DOW[dow(date)]} ${fmtDate(date)}` : view === "week" ? `Week of ${fmtDate(mondayOf(date))}` : monLabel(date.slice(0, 7), true);
  return `<div class="ds-nav noprint">
    <div class="seg" role="group" aria-label="View">${[["day", "Day"], ["week", "Week"], ["month", "Month"]].map(([v, l]) => `<a class="btn ${view === v ? "primary" : ""}" href="${q(v, date)}" ${view === v ? 'aria-current="page"' : ""}>${l}</a>`).join("")}
      <a class="btn ${view === "availability" ? "primary" : ""}" href="${base}/availability?month=${date.slice(0, 7)}">Availability</a></div>
    ${view === "availability" ? "" : `<div class="ds-step"><a class="btn" href="${q(view, prev)}" aria-label="Previous">‹</a><b>${h(label)}</b><a class="btn" href="${q(view, next)}" aria-label="Next">›</a><a class="btn ghost" href="${q(view, R.todayLocal())}">Today</a></div>`}
    ${extra}</div>`;
}

/** Week: one row per person, one column per day, coloured blocks; the weekly total against the 48-hour week. */
function weekView(D, monday, { base, canEdit, limit }) {
  const ds = days(monday, addDays(monday, 6)), today = R.todayLocal();
  const head = ds.map((d) => `<th class="${d === today ? "ds-today" : ""} ${dow(d) === 0 || dow(d) === 6 ? "we" : ""}">${DOW[dow(d)]}<br><span>${+d.slice(8)} ${monLabel(d.slice(0, 7)).split(" ")[0]}</span>${D.holidays.get(d) ? `<br><span class="ds-hol">${h(D.holidays.get(d))}</span>` : ""}</th>`).join("");
  const rows = D.staff.map((s) => {
    let total = 0;
    const cells = ds.map((d) => {
      const x = D.day(s.id, d); total += x.hours;
      const edit = canEdit(s);
      return `<td class="${d === today ? "ds-today" : ""} ${x.weekend ? "we" : ""} ${x.holiday ? "hol" : ""}">
        ${leaveTag(x.leave)}${x.blocks.map((b) => chip(b, edit ? `${base}/schedule/entry/${b.id}` : null)).join("")}
        ${!x.blocks.length && !x.leave && x.holiday ? `<span class="ds-leave hol">Public holiday</span>` : ""}
        ${x.hours ? `<span class="ds-h">${hm(x.hours)}</span>` : ""}
        ${edit ? `<a class="ds-add noprint" href="${base}/schedule/new?staff=${s.id}&date=${d}" aria-label="Add to ${h(s.full_name)}'s ${DOW[dow(d)]}">+</a>` : ""}</td>`;
    }).join("");
    const diff = total - limit;
    return `<tr><th class="ds-name">${h(s.full_name)}<span>${h(s.job_title || "")}</span>
      ${canEdit(s) ? `<form method="post" action="${base}/schedule/copy-week" class="noprint" style="margin-top:4px"><input type="hidden" name="staff_id" value="${s.id}"><input type="hidden" name="monday" value="${monday}"><button class="btn tblbtn" title="Copy last week's blocks into the empty days of this week">Copy last week</button></form>` : ""}</th>
      ${cells}<td class="ds-tot"><b>${hm(total)}</b><span class="${diff > 0 ? "over" : ""}">${total ? (diff > 0 ? `+${hm(diff)} over ${limit}h` : `${hm(-diff)} under ${limit}h`) : "—"}</span></td></tr>`;
  }).join("");
  return `<div class="tw ds-wrap"><table class="ds-week"><thead><tr><th>Team</th>${head}<th>Week</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">Add the team on Department → Staff first.</td></tr>`}</tbody></table></div>`;
}

/** Day: a timeline from 05:00 to 23:00 for each person. */
function dayView(D, d, { base, canEdit }) {
  const A = 5 * 60, Z = 23 * 60, pct = (m) => ((Math.min(Z, Math.max(A, m)) - A) / (Z - A)) * 100;
  const ticks = []; for (let t = 6; t <= 22; t += 2) ticks.push(`<span style="left:${pct(t * 60)}%">${String(t).padStart(2, "0")}:00</span>`);
  const nowM = d === R.todayLocal() ? mins(R.nowLocal().slice(11, 16)) : null;
  const rows = D.staff.map((s) => {
    const x = D.day(s.id, d);
    const bars = x.blocks.filter((b) => b.start_time && b.end_time).map((b) => { const a = ACT[b.activity] || { c: "#777" }; const l = pct(mins(b.start_time)), w = pct(mins(b.end_time)) - l;
      return `<${canEdit(s) ? `a href="${base}/schedule/entry/${b.id}"` : "span"} class="ds-bar" style="left:${l}%;width:${w}%;--ac:${a.c}" title="${h(b.start_time + "–" + b.end_time + " " + b.activity + (b.note ? " · " + b.note : ""))}"><b>${h(b.activity)}</b> ${h(b.start_time)}–${h(b.end_time)}${b.note ? " · " + h(b.note) : ""}</${canEdit(s) ? "a" : "span"}>`; }).join("");
    const allDay = x.blocks.filter((b) => !b.start_time).map((b) => `<span class="ds-allday" style="--ac:${(ACT[b.activity] || { c: "#777" }).c}">${h(b.activity)}${b.note ? " · " + h(b.note) : ""}</span>`).join("");
    const band = x.leave ? `<span class="ds-band ${x.leave.status === "Approved" ? "conf" : "tent"}">${h(x.leave.leave_type)} leave${x.leave.status === "Approved" ? "" : " (tentative)"}</span>` : x.holiday && !x.blocks.length ? `<span class="ds-band hol">${h(x.holiday)}</span>` : "";
    return `<div class="ds-trow"><div class="ds-tname">${h(s.full_name)}<span>${x.hours ? hm(x.hours) : ""}</span></div>
      <div class="ds-track">${band}${allDay}${bars}${nowM != null && nowM >= A && nowM <= Z ? `<i class="ds-now" style="left:${pct(nowM)}%" title="Now"></i>` : ""}
      ${canEdit(s) ? `<a class="ds-add2 noprint" href="${base}/schedule/new?staff=${s.id}&date=${d}">+ Add</a>` : ""}</div></div>`;
  }).join("");
  return `<div class="ds-day"><div class="ds-axis">${ticks.join("")}</div>${rows || `<p class="muted">Add the team on Department → Staff first.</p>`}</div>`;
}

/** Month: one row per person, one small cell per day with a colour strip for each block and the hours. */
function monthView(D, m, { base, limit }) {
  const ds = days(m + "-01", monthEnd(m)), today = R.todayLocal();
  const head = ds.map((d) => `<th class="${dow(d) === 0 || dow(d) === 6 ? "we" : ""} ${d === today ? "ds-today" : ""}">${+d.slice(8)}<br>${DOW[dow(d)][0]}</th>`).join("");
  const rows = D.staff.map((s) => {
    let tot = 0, lv = 0;
    const cells = ds.map((d) => {
      const x = D.day(s.id, d); tot += x.hours; if (x.leave && x.leave.status === "Approved") lv++;
      const strips = x.blocks.map((b) => `<i style="background:${(ACT[b.activity] || { c: "#777" }).c}"></i>`).join("");
      const cls = x.leave ? (x.leave.status === "Approved" ? "lv-conf" : "lv-tent") : x.holiday ? "hol" : x.weekend ? "we" : "";
      const tip = [x.leave ? `${x.leave.leave_type} leave (${x.leave.status === "Approved" ? "confirmed" : "tentative"})` : "", x.holiday || "", ...x.blocks.map((b) => `${b.start_time ? b.start_time + "–" + (b.end_time || "") + " " : ""}${b.activity}${b.note ? " · " + b.note : ""}`)].filter(Boolean).join("\n");
      return `<td class="${cls} ${d === today ? "ds-today" : ""}" title="${h(fmtDate(d) + (tip ? "\n" + tip : ""))}"><a href="${base}/schedule?view=day&date=${d}"><span class="ds-strips">${strips}</span>${x.hours ? `<b>${Math.round(x.hours * 10) / 10}</b>` : x.leave ? "L" : x.holiday ? "H" : ""}</a></td>`;
    }).join("");
    return `<tr><th class="ds-name">${h(s.full_name)}</th>${cells}<td class="n"><b>${hm(tot)}</b></td><td class="n">${lv}</td></tr>`;
  }).join("");
  return `<div class="tw ds-wrap"><table class="ds-month"><thead><tr><th>Team</th>${head}<th class="n">Hours</th><th class="n">Leave days</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="font-size:13px">Numbers are hours worked that day. L = leave (striped = tentative), H = public holiday. Tap a day to see it in detail. Weekly limit: ${limit} hours.</p>`;
}

/** Availability: who is away each day, leave confirmed vs tentative, and how many are available. */
function availView(D, m, { base }) {
  const ds = days(m + "-01", monthEnd(m)), today = R.todayLocal();
  const head = ds.map((d) => `<th class="${dow(d) === 0 || dow(d) === 6 ? "we" : ""} ${d === today ? "ds-today" : ""}">${+d.slice(8)}<br>${DOW[dow(d)][0]}</th>`).join("");
  const avail = ds.map((d) => D.staff.filter((s) => { const x = D.day(s.id, d); return !x.leave && !x.blocks.some((b) => b.activity === "Off" || b.activity === "Lieu day"); }).length);
  const rows = D.staff.map((s) => `<tr><th class="ds-name">${h(s.full_name)}</th>${ds.map((d) => { const x = D.day(s.id, d);
    const off = x.blocks.find((b) => b.activity === "Off" || b.activity === "Lieu day");
    const cls = x.leave ? (x.leave.status === "Approved" ? "lv-conf" : "lv-tent") : off ? "off" : x.holiday ? "hol" : x.weekend ? "we" : "ok";
    const tip = x.leave ? `${x.leave.leave_type} leave · ${x.leave.status === "Approved" ? "confirmed" : x.leave.status === "Pending" ? "requested" : "tentative"}${x.leave.reason ? " · " + x.leave.reason : ""}` : off ? off.activity : x.holiday || (x.weekend ? "Weekend" : "Available");
    return `<td class="${cls}" title="${h(fmtDate(d) + ": " + tip)}">${x.leave ? (x.leave.status === "Approved" ? "L" : "T") : off ? "O" : x.holiday ? "H" : ""}</td>`; }).join("")}</tr>`).join("");
  const upcoming = D.leave.filter((l) => l.z >= today).sort((a, b) => a.a.localeCompare(b.a));
  const name = (id) => (D.staff.find((s) => s.id === id) || {}).full_name || "";
  return `<div class="tw ds-wrap"><table class="ds-month ds-avail"><thead><tr><th>Team</th>${head}</tr></thead><tbody>${rows}
      <tr class="ds-count"><th>Available</th>${avail.map((n, i) => `<td class="${n <= Math.ceil(D.staff.length / 2) && !(dow(ds[i]) === 0 || dow(ds[i]) === 6) ? "low" : ""}">${n}</td>`).join("")}</tr></tbody></table></div>
    <p class="muted" style="font-size:13px">L = leave confirmed · T = tentative or requested · O = off / lieu day · H = public holiday. Bottom row: how many of the team are available. Hover or tap a cell for details.</p>
    <h3 style="font-size:16px;margin-top:14px">Leave this month and coming up</h3>
    ${table(["Name", "Type", "From", "To", "Working days", "Plan"], upcoming.map((l) => [name(l.staff_id), l.leave_type, fmtDate(l.a), fmtDate(l.z), nf(l.days, 1), raw(`<span class="status-chip st-${l.status === "Approved" ? "Approved" : "Tentative"}">${l.status === "Approved" ? "Confirmed" : l.status === "Pending" ? "Requested" : "Tentative"}</span>`)]), { num: [4], empty: "No leave planned." })}
    <p class="noprint" style="margin-top:8px"><a href="${base === "/department" ? "/department/me#leave" : "#"}" ${base === "/department" ? "" : "hidden"}>Add your leave plan</a></p>`;
}

/** Today: what everyone is doing, for the overview page. */
function todayList(D, d) {
  return D.staff.map((s) => { const x = D.day(s.id, d);
    return `<div class="ds-todayrow"><b>${h(s.full_name)}</b><span>${leaveTag(x.leave)}${x.blocks.map((b) => chip(b)).join("") || (x.leave ? "" : x.holiday ? `<span class="ds-leave hol">${h(x.holiday)}</span>` : `<span class="muted">Nothing entered</span>`)}</span></div>`; }).join("");
}

// ---------------------------------------------------------------- Excel for HR
async function hrWorkbook(m) {
  const from = m + "-01", to = monthEnd(m), limit = await weeklyLimit();
  // weeks run Monday–Sunday; a week belongs to the month in which it ends, so each week is counted once
  const firstMon = mondayOf(from), lastSun = addDays(mondayOf(to), 6);
  const D = await load(firstMon, lastSun);
  const wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development";
  const head = (row, color = "FF4D5AC2") => row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } }; c.alignment = { vertical: "middle", wrapText: true }; });
  const fill = (hex) => ({ type: "pattern", pattern: "solid", fgColor: { argb: "FF" + hex.replace("#", "").toUpperCase() } });
  const light = (hex) => { const n = parseInt(hex.slice(1), 16); const mix = (c) => Math.round(c + (255 - c) * 0.75); return "#" + [n >> 16, (n >> 8) & 255, n & 255].map(mix).map((x) => x.toString(16).padStart(2, "0")).join(""); };
  const hoursActs = ACTS.filter((a) => a.hours).map((a) => a.k);
  const sum = wb.addWorksheet("Summary");
  sum.addRow([`Cycling Development department · schedule ${monLabel(m, true)}`]).font = { bold: true, size: 14 };
  sum.addRow([`Prepared ${fmtDate(R.todayLocal())}. Weeks run Monday–Sunday and are counted in the month they end. Weekly limit ${limit} hours.`]);
  sum.addRow([]);
  head(sum.addRow(["Name", "Employee no", "Job title", "Days worked", "Total hours", ...hoursActs.map((a) => a + " hrs"), "Weeks over " + limit + "h", "Hours over / under limit", "Leave days (confirmed)", "Leave days (tentative)", "Public holidays worked"]));
  for (const s of D.staff) {
    const ds = days(from, to); let dw = 0, tot = 0, lvC = 0, lvT = 0, ph = 0; const by = Object.fromEntries(hoursActs.map((a) => [a, 0]));
    for (const d of ds) { const x = D.day(s.id, d); if (x.hours) dw++; tot += x.hours; for (const b of x.blocks) if (by[b.activity] != null) by[b.activity] += hrs(b); if (x.leave) { if (x.leave.status === "Approved") lvC++; else lvT++; } if (x.holiday && x.hours) ph++; }
    let over = 0, bal = 0;
    for (let mon = firstMon; mon <= to; mon = addDays(mon, 7)) { const sun = addDays(mon, 6); if (sun < from || sun > to) continue; const w = days(mon, sun).reduce((a, d) => a + D.day(s.id, d).hours, 0); if (w > limit) over++; bal += w - limit; }
    sum.addRow([s.full_name, s.employee_no || "", s.job_title || "", dw, Math.round(tot * 100) / 100, ...hoursActs.map((a) => Math.round(by[a] * 100) / 100), over, Math.round(bal * 100) / 100, lvC, lvT, ph]);
  }
  sum.columns.forEach((c, i) => { c.width = i === 0 ? 24 : i === 2 ? 22 : 13; });
  sum.views = [{ state: "frozen", ySplit: 4 }];
  // legend
  sum.addRow([]); sum.addRow(["Colours"]).font = { bold: true };
  for (const a of ACTS) { const r = sum.addRow([a.k]); r.getCell(1).fill = fill(light(a.c)); }

  // one sheet per person: a row per day with the blocks, start, finish and hours, and a total after each week
  for (const s of D.staff) {
    const ws = wb.addWorksheet(s.full_name.replace(/[\\/*?:[\]]/g, "").slice(0, 31));
    ws.addRow([`${s.full_name} · ${monLabel(m, true)}`, s.job_title || "", s.employee_no ? "Employee no " + s.employee_no : ""]).font = { bold: true, size: 13 };
    head(ws.addRow(["Date", "Day", "Schedule", "Start", "Finish", "Hours", ...hoursActs, "Leave / holiday"]));
    let bal = 0;
    for (let mon = firstMon; mon <= to; mon = addDays(mon, 7)) {
      const sun = addDays(mon, 6), counted = sun >= from && sun <= to;
      let wk = 0;
      for (const d of days(mon, sun)) {
        const x = D.day(s.id, d); wk += x.hours;
        if (d < from || d > to) continue;
        const per = Object.fromEntries(hoursActs.map((a) => [a, 0])); for (const b of x.blocks) if (per[b.activity] != null) per[b.activity] += hrs(b);
        const r = ws.addRow([new Date(d + "T00:00:00Z"), DOW[dow(d)], x.blocks.map((b) => `${b.start_time ? b.start_time + "–" + (b.end_time || "") + " " : ""}${b.activity}${b.note ? " (" + b.note + ")" : ""}`).join("\n"),
          x.first || "", x.last || "", x.hours ? Math.round(x.hours * 100) / 100 : null, ...hoursActs.map((a) => (per[a] ? Math.round(per[a] * 100) / 100 : null)),
          [x.leave ? `${x.leave.leave_type} leave${x.leave.status === "Approved" ? "" : " (tentative)"}` : "", x.holiday || "", x.blocks.filter((b) => !ACT[b.activity] || !ACT[b.activity].hours).map((b) => b.activity).join(", ")].filter(Boolean).join(" · ")]);
        r.alignment = { vertical: "top", wrapText: true };
        hoursActs.forEach((a, i) => { if (per[a]) r.getCell(7 + i).fill = fill(light(ACT[a].c)); });
        if (x.blocks[0]) r.getCell(3).fill = fill(light((ACT[x.blocks[0].activity] || { c: "#cccccc" }).c));
        if (x.weekend || x.holiday) { r.getCell(1).font = { color: { argb: "FF888888" } }; r.getCell(2).font = { color: { argb: "FF888888" } }; }
      }
      if (counted) {
        bal += wk - limit;
        const r = ws.addRow(["", "", `Week ${fmtDate(mon)} – ${fmtDate(sun)}`, "", "Week total", Math.round(wk * 100) / 100, `vs ${limit}h: ${wk - limit >= 0 ? "+" : ""}${Math.round((wk - limit) * 100) / 100}`, `Running balance: ${bal >= 0 ? "+" : ""}${Math.round(bal * 100) / 100}`]);
        r.font = { bold: true }; r.eachCell((c) => { c.fill = fill("#EEF0FB"); });
      }
    }
    ws.getColumn(1).numFmt = "d mmm"; [9, 6, 46, 8, 8, 8, ...hoursActs.map(() => 11), 28].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: "frozen", ySplit: 2 }];
  }

  // team grid: hours per person per day, coloured by the main activity
  const g = wb.addWorksheet("Team grid");
  const ds = days(from, to);
  head(g.addRow(["Name", ...ds.map((d) => `${+d.slice(8)} ${DOW[dow(d)]}`), "Total"]));
  D.staff.forEach((s, i) => {
    const r = g.addRow([s.full_name, ...ds.map((d) => { const x = D.day(s.id, d); return x.hours ? Math.round(x.hours * 10) / 10 : x.leave ? (x.leave.status === "Approved" ? "L" : "T") : x.holiday ? "H" : x.blocks[0] ? x.blocks[0].activity.slice(0, 3) : ""; }), { formula: `SUM(B${i + 2}:${String.fromCharCode(65 + Math.min(25, ds.length))}${i + 2})` }]);
    ds.forEach((d, j) => { const x = D.day(s.id, d); const main = x.blocks.slice().sort((a, b) => hrs(b) - hrs(a))[0]; const c = r.getCell(2 + j);
      c.alignment = { horizontal: "center" };
      if (main) c.fill = fill(light((ACT[main.activity] || { c: "#cccccc" }).c)); else if (x.leave) c.fill = fill(x.leave.status === "Approved" ? "#FCE3B0" : "#FFF4DA"); else if (x.holiday) c.fill = fill("#D8F0E0"); });
  });
  // the total formula: column letters beyond Z need two letters
  const L = (n) => { let s = ""; while (n > 0) { const k = (n - 1) % 26; s = String.fromCharCode(65 + k) + s; n = Math.floor((n - 1) / 26); } return s; };
  D.staff.forEach((s, i) => { g.getRow(i + 2).getCell(ds.length + 2).value = { formula: `SUM(B${i + 2}:${L(ds.length + 1)}${i + 2})` }; });
  g.getColumn(1).width = 22; ds.forEach((_, j) => { g.getColumn(2 + j).width = 6.5; });
  g.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------- routes
module.exports = function deptSchedule(app, { need, page, setFlash, actor, user, wrap }) {
  const A = need("admin"), S = need("admin", "coordinator");
  const me = async (req) => (await pool.query("SELECT * FROM dept_staff WHERE lower(email) = lower($1) AND active", [user(req).email])).rows[0];
  const editorFor = async (req) => { const u = user(req), mine = await me(req); return (s) => u.role === "admin" || (mine && mine.id === s.id); };
  const scripts = "";

  async function scheduleBody(req, base, { canEdit, readOnly }) {
    const view = ["day", "week", "month"].includes(req.query.view) ? req.query.view : "week";
    const date = okDate(req.query.date) ? req.query.date : R.todayLocal(), limit = await weeklyLimit();
    let body;
    if (view === "day") body = dayView(await load(date, date), date, { base, canEdit });
    else if (view === "week") { const mon = mondayOf(date); body = weekView(await load(mon, addDays(mon, 6)), mon, { base, canEdit, limit }); }
    else { const m = date.slice(0, 7); body = monthView(await load(m + "-01", monthEnd(m)), m, { base, limit }); }
    const exportBtns = `<div class="ds-actions noprint"><a class="btn" href="${base}/schedule/print?month=${date.slice(0, 7)}">Print / PDF for HR</a><a class="btn primary" href="${base}/schedule/export.xlsx?month=${date.slice(0, 7)}">Download ${h(monLabel(date.slice(0, 7)))} for HR (.xlsx)</a></div>`;
    return `${viewNav(base, view, date, readOnly ? exportBtns : "")}
      ${readOnly ? "" : `<div class="ds-top noprint"><p class="muted" style="margin:0">Tap <b>+</b> to add a time block (office, WMF ride, corporate ride…). Tap a block to change or remove it. ${view === "week" ? "<b>Copy last week</b> fills this week's empty days from last week." : ""}</p>${exportBtns}</div>`}
      ${legend()}
      <section class="card ds-card">${body}</section>`;
  }

  app.get("/department/schedule", S, wrap(async (req, res) => {
    const canEdit = await editorFor(req);
    const mine = await me(req);
    res.send(page(req, "Team schedule", `<div class="card-head"><div><h2 style="font-size:22px">Team schedule</h2><p class="muted" style="margin:2px 0 0">Where everyone is and when: office, rides, events and leave.${!mine && user(req).role !== "admin" ? " Ask an administrator to add you to the team list so you can enter your own schedule." : ""}</p></div></div>
      ${await scheduleBody(req, "/department", { canEdit })}`, { active: "/department/schedule", scripts }));
  }));
  app.get("/department/availability", S, wrap(async (req, res) => {
    const m = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : R.todayLocal().slice(0, 7);
    res.send(page(req, "Team availability", `<div class="card-head"><div><h2 style="font-size:22px">Team availability · ${h(monLabel(m, true))}</h2><p class="muted" style="margin:2px 0 0">Leave plans (confirmed and tentative), days off and public holidays, so you can see who is around.</p></div>
      <div class="toolbar noprint" style="margin:0"><a class="btn" href="/department/availability?month=${addMonths(m, -1)}">‹ ${h(monLabel(addMonths(m, -1)))}</a><a class="btn" href="/department/availability?month=${addMonths(m, 1)}">${h(monLabel(addMonths(m, 1)))} ›</a></div></div>
      ${viewNav("/department", "availability", m + "-01")}<section class="card ds-card">${availView(await load(m + "-01", monthEnd(m)), m, { base: "/department" })}</section>`, { active: "/department/availability" }));
  }));

  // ----- add / change / remove blocks
  const entryForm = (staff, v, action, { del } = {}) => `<form class="form" method="post" action="${action}">
      ${staff.length > 1 ? `<label>Who<select name="staff_id">${staff.map((s) => `<option value="${s.id}" ${String(v.staff_id) === String(s.id) ? "selected" : ""}>${h(s.full_name)}</option>`).join("")}</select></label>` : `<input type="hidden" name="staff_id" value="${staff[0].id}"><p style="margin:0"><b>${h(staff[0].full_name)}</b></p>`}
      <div class="ds-acts" role="radiogroup" aria-label="Activity">${ACTS.map((a) => `<label class="ds-actpick" style="--ac:${a.c}"><input type="radio" name="activity" value="${h(a.k)}" ${v.activity === a.k ? "checked" : ""} required><span>${h(a.k)}</span></label>`).join("")}</div>
      <div class="row2"><label>Date<input type="date" name="work_date" value="${h(v.work_date)}" required></label>
        <label>Note <span class="hint">(optional, e.g. L'IMAD, Jebel Hafeet)</span><input name="note" value="${h(v.note)}" maxlength="80"></label></div>
      <div class="row2"><label>Start<input type="time" name="start_time" value="${h(v.start_time)}"></label><label>Finish<input type="time" name="end_time" value="${h(v.end_time)}"></label></div>
      <p class="hint" style="margin:0">Leave Start and Finish empty for a whole day (Off, Lieu day). Leave is planned on My schedule & leave.</p>
      ${del ? "" : `<details><summary>Repeat on more days</summary><div style="margin-top:8px;display:grid;gap:8px">
        <div class="ds-days">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="repeat" value="${i}"> ${DOW[i]}</label>`).join("")}</div>
        <label>Until<input type="date" name="until"></label><p class="hint" style="margin:0">E.g. Office Mon–Fri until the end of the month. Days that already have this exact block are skipped.</p></div></details>`}
      <div class="toolbar" style="margin:0"><button class="btn primary">Save</button>${del ? `<button class="btn danger" name="action" value="delete" formnovalidate>Remove</button>` : ""}<a class="btn ghost" href="/department/schedule?view=week&date=${h(v.work_date || R.todayLocal())}">Back</a></div></form>`;
  async function allowedStaff(req) {
    if (user(req).role === "admin") return (await pool.query("SELECT * FROM dept_staff WHERE active ORDER BY full_name")).rows;
    const m = await me(req); return m ? [m] : [];
  }
  app.get("/department/schedule/new", S, wrap(async (req, res) => {
    const staff = await allowedStaff(req);
    if (!staff.length) { setFlash(req, "err", "Ask an administrator to add you to the team list first."); return res.redirect("/department/schedule"); }
    const sid = staff.some((s) => String(s.id) === String(req.query.staff)) ? req.query.staff : staff[0].id;
    res.send(page(req, "Add to schedule", `<section class="card"><h2>Add to the schedule</h2>${entryForm(staff, { staff_id: sid, work_date: okDate(req.query.date) ? req.query.date : R.todayLocal(), activity: "Office", start_time: "08:00", end_time: "17:00" }, "/department/schedule/entries")}</section>`, { active: "/department/schedule", wide: false }));
  }));
  function readEntry(b) {
    const activity = ACT[b.activity] ? b.activity : null;
    if (!activity) return { err: "Choose what it is (office, WMF ride…)." };
    if (!okDate(b.work_date)) return { err: "Choose a date." };
    const st = okTime(b.start_time) ? b.start_time : null, en = okTime(b.end_time) ? b.end_time : null;
    if (!ACT[activity].allDay && (!st || !en)) return { err: "Enter a start and finish time." };
    if (st && en && mins(en) <= mins(st)) return { err: "The finish time must be after the start time." };
    return { activity, start_time: ACT[activity].allDay ? null : st, end_time: ACT[activity].allDay ? null : en, note: R.clean(b.note).slice(0, 80) || null };
  }
  app.post("/department/schedule/entries", S, wrap(async (req, res) => {
    const staff = await allowedStaff(req), b = req.body, s = staff.find((x) => String(x.id) === String(b.staff_id));
    const e = readEntry(b);
    if (!s || e.err) { setFlash(req, "err", e.err || "Not allowed."); return res.redirect(`/department/schedule/new?staff=${b.staff_id || ""}&date=${b.work_date || ""}`); }
    let ds = [b.work_date];
    const rep = [].concat(b.repeat || []).map(Number);
    if (rep.length && okDate(b.until) && b.until >= b.work_date && days(b.work_date, b.until).length <= 93) ds = days(b.work_date, b.until).filter((d) => d === b.work_date || rep.includes(dow(d)));
    const n = await tx(async (c) => {
      let added = 0;
      for (const d of ds) {
        const dup = (await c.query("SELECT 1 FROM dept_shifts WHERE staff_id = $1 AND work_date = $2 AND activity = $3 AND start_time IS NOT DISTINCT FROM $4", [s.id, d, e.activity, e.start_time])).rows[0];
        if (dup) continue;
        await c.query("INSERT INTO dept_shifts (staff_id, work_date, start_time, end_time, activity, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [s.id, d, e.start_time, e.end_time, e.activity, e.note, actor(req)]);
        added++;
      }
      await audit(c, actor(req), "dept.schedule.add", "dept_shifts", String(s.id), null, { ...e, dates: ds.length, added });
      return added;
    });
    setFlash(req, "ok", n === 1 ? `Added ${e.activity} for ${s.full_name}.` : `Added ${n} days of ${e.activity} for ${s.full_name}.`);
    res.redirect(`/department/schedule?view=week&date=${b.work_date}`);
  }));
  async function entryAllowed(req, id) {
    const b = (await pool.query("SELECT *, work_date::text AS d FROM dept_shifts WHERE id = $1", [+id || 0])).rows[0];
    if (!b) return null;
    const staff = await allowedStaff(req);
    return staff.some((s) => s.id === b.staff_id) ? { b, staff } : null;
  }
  app.get("/department/schedule/entry/:id", S, wrap(async (req, res) => {
    const x = await entryAllowed(req, req.params.id);
    if (!x) return res.redirect("/department/schedule");
    res.send(page(req, "Change schedule", `<section class="card"><h2>Change or remove</h2>${entryForm(x.staff, { ...x.b, work_date: x.b.d }, `/department/schedule/entry/${x.b.id}`, { del: true })}</section>`, { active: "/department/schedule", wide: false }));
  }));
  app.post("/department/schedule/entry/:id", S, wrap(async (req, res) => {
    const x = await entryAllowed(req, req.params.id);
    if (!x) return res.redirect("/department/schedule");
    if (req.body.action === "delete") {
      await pool.query("DELETE FROM dept_shifts WHERE id = $1", [x.b.id]);
      await audit(pool, actor(req), "dept.schedule.remove", "dept_shifts", String(x.b.id), x.b, null);
      setFlash(req, "ok", "Removed.");
      return res.redirect(`/department/schedule?view=week&date=${x.b.d}`);
    }
    const e = readEntry(req.body), s = x.staff.find((y) => String(y.id) === String(req.body.staff_id));
    if (e.err || !s) { setFlash(req, "err", e.err || "Not allowed."); return res.redirect(`/department/schedule/entry/${x.b.id}`); }
    await pool.query("UPDATE dept_shifts SET staff_id = $2, work_date = $3, start_time = $4, end_time = $5, activity = $6, note = $7, updated_at = now() WHERE id = $1", [x.b.id, s.id, req.body.work_date, e.start_time, e.end_time, e.activity, e.note]);
    await audit(pool, actor(req), "dept.schedule.change", "dept_shifts", String(x.b.id), x.b, e);
    setFlash(req, "ok", "Saved.");
    res.redirect(`/department/schedule?view=week&date=${req.body.work_date}`);
  }));
  app.post("/department/schedule/copy-week", S, wrap(async (req, res) => {
    const staff = await allowedStaff(req), s = staff.find((x) => String(x.id) === String(req.body.staff_id)), mon = okDate(req.body.monday) ? mondayOf(req.body.monday) : null;
    if (!s || !mon) return res.redirect("/department/schedule");
    const n = await tx(async (c) => {
      const prev = (await c.query("SELECT *, work_date::text AS d FROM dept_shifts WHERE staff_id = $1 AND work_date BETWEEN $2 AND $3", [s.id, addDays(mon, -7), addDays(mon, -1)])).rows;
      const busy = new Set((await c.query("SELECT work_date::text AS d FROM dept_shifts WHERE staff_id = $1 AND work_date BETWEEN $2 AND $3", [s.id, mon, addDays(mon, 6)])).rows.map((r) => r.d));
      let added = 0;
      for (const b of prev) { const d = addDays(b.d, 7); if (busy.has(d)) continue; await c.query("INSERT INTO dept_shifts (staff_id, work_date, start_time, end_time, activity, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [s.id, d, b.start_time, b.end_time, b.activity, b.note, actor(req)]); added++; }
      await audit(c, actor(req), "dept.schedule.copy_week", "dept_shifts", String(s.id), null, { monday: mon, added });
      return added;
    });
    setFlash(req, n ? "ok" : "info", n ? `Copied ${n} block${n === 1 ? "" : "s"} from last week for ${s.full_name}. Adjust anything that's different.` : "Nothing to copy: last week is empty, or this week's days are already filled.");
    res.redirect(`/department/schedule?view=week&date=${mon}`);
  }));

  // ----- HR: Excel and printable month
  const sendXlsx = async (res, m) => res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="Cycling-Development-schedule-${m}.xlsx"`).send(await hrWorkbook(m));
  const monthQ = (q) => (/^\d{4}-\d{2}$/.test(q.month || "") ? q.month : R.todayLocal().slice(0, 7));
  app.get("/department/schedule/export.xlsx", A, wrap(async (req, res) => { const m = monthQ(req.query); await audit(pool, actor(req), "dept.export.schedule", "dept_shifts", m, null, null); await sendXlsx(res, m); }));
  async function printBody(m, base) {
    const D = await load(m + "-01", monthEnd(m)), limit = await weeklyLimit();
    const tot = D.staff.map((s) => { const ds = days(m + "-01", monthEnd(m)); let t = 0, dw = 0, lv = 0; for (const d of ds) { const x = D.day(s.id, d); t += x.hours; if (x.hours) dw++; if (x.leave && x.leave.status === "Approved") lv++; } return [s.full_name, s.job_title || "", dw, hm(t), lv]; });
    return `<div class="toolbar noprint"><button class="btn primary" data-print>Print or save as PDF</button><a class="btn" href="${base}/schedule/export.xlsx?month=${m}">Download Excel</a><a class="btn ghost" href="${base}/schedule?view=month&date=${m}-01">Back</a></div>
      <article class="a4 ds-print"><h2>Cycling Development department · ${h(monLabel(m, true))}</h2><p class="meta">Team schedule for HR · prepared ${fmtDate(R.todayLocal())} · weekly limit ${limit} hours</p>
        <h3>Summary</h3>${table(["Name", "Role", "Days worked", "Hours", "Leave days"], tot, { num: [2, 3, 4] })}
        <h3>Month at a glance</h3>${legend()}${monthView(D, m, { base, limit })}
        <h3>Availability</h3>${availView(D, m, { base })}</article>`;
  }
  app.get("/department/schedule/print", A, wrap(async (req, res) => { const m = monthQ(req.query); res.send(page(req, "Schedule for HR", await printBody(m, "/department"), { active: "/department/schedule" })); }));

  // ----- read-only link for a manager: the department only, nothing else in the hub
  const shell = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Cycling Development</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@87,500;87,600;87,700&family=Source+Sans+3:wght@400;600&display=swap">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/hub.css"><link rel="icon" type="image/png" href="/brand/favicon.png"></head>
<body><div class="app"><header class="top"><div class="brand"><span class="cd-mark" aria-hidden="true"><svg viewBox="0 0 40 40" width="30" height="30"><circle cx="11" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="29" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11 26 L18 13 L26 13 M18 13 L23 26 L29 26 M24 9 h5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
<div class="brand-name"><h1>Cycling Development</h1><p class="sub">Department · read-only view</p></div></div></header>
<main id="main" style="display:grid;gap:14px">${body}</main><footer class="foot"><span>Cycling Development · Powered by Aurora</span><span>Times shown in UAE time</span></footer></div><script src="/ui.js"></script></body></html>`;
  const linkBy = async (t) => (await pool.query("SELECT * FROM dept_share_links WHERE token = $1 AND active", [String(t || "")])).rows[0];
  const readOnly = () => false;
  app.get("/d/:token", wrap(async (req, res) => res.redirect(`/d/${encodeURIComponent(req.params.token)}/schedule`)));
  app.get("/d/:token/schedule", wrap(async (req, res) => {
    const l = await linkBy(req.params.token); if (!l) return res.status(404).send(shell("Link off", `<section class="card"><h2>This link is switched off</h2><p class="lead">Ask the Cycling Development team for a new one.</p></section>`));
    await pool.query("UPDATE dept_share_links SET last_opened = now() WHERE id = $1", [l.id]);
    res.set("Cache-Control", "no-store").send(shell("Team schedule", `<h2 style="font-size:22px">Team schedule</h2>${await scheduleBody(req, `/d/${l.token}`, { canEdit: readOnly, readOnly: true })}`));
  }));
  app.get("/d/:token/availability", wrap(async (req, res) => {
    const l = await linkBy(req.params.token); if (!l) return res.status(404).send(shell("Link off", `<section class="card"><h2>This link is switched off</h2></section>`));
    const m = monthQ(req.query);
    res.set("Cache-Control", "no-store").send(shell("Team availability", `<h2 style="font-size:22px">Team availability · ${h(monLabel(m, true))}</h2>${viewNav(`/d/${l.token}`, "availability", m + "-01", `<div class="ds-step"><a class="btn" href="/d/${l.token}/availability?month=${addMonths(m, -1)}">‹</a><b>${h(monLabel(m, true))}</b><a class="btn" href="/d/${l.token}/availability?month=${addMonths(m, 1)}">›</a></div>`)}
      <section class="card ds-card">${availView(await load(m + "-01", monthEnd(m)), m, { base: `/d/${l.token}` })}</section>`));
  }));
  app.get("/d/:token/schedule/export.xlsx", wrap(async (req, res) => {
    const l = await linkBy(req.params.token); if (!l) return res.status(404).end();
    const m = monthQ(req.query); await audit(pool, "Share link: " + l.label, "dept.export.schedule", "dept_shifts", m, null, null); await sendXlsx(res, m);
  }));
  app.get("/d/:token/schedule/print", wrap(async (req, res) => {
    const l = await linkBy(req.params.token); if (!l) return res.status(404).end();
    res.set("Cache-Control", "no-store").send(shell("Schedule for HR", await printBody(monthQ(req.query), `/d/${l.token}`)));
  }));
  // the read-only view never accepts changes
  app.post(/^\/d\/.*/, (req, res) => res.status(403).send("This link is read-only."));

  app.get("/department/share", A, wrap(async (req, res) => {
    const rows = (await pool.query("SELECT * FROM dept_share_links ORDER BY active DESC, created_at DESC")).rows;
    const base = `${req.protocol}://${req.get("host")}`;
    res.send(page(req, "Share the department", `<section class="card"><h2>Share the department (read-only)</h2>
      <p class="lead">Make a link for your manager (or HR). It opens the team schedule, availability and leave, and lets them download the month for HR. It shows nothing else from the hub (no WMF, no corporate, no member details) and nothing can be changed through it. Switch it off at any time.</p>
      <form class="inline-form" method="post" action="/department/share"><input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. my manager" style="flex:1 1 220px"><button class="btn primary">Make a read-only link</button></form></section>
      <div class="grid">${rows.map((l) => `<section class="card c6" style="display:grid;gap:8px;${l.active ? "" : "opacity:.6"}"><h2>${h(l.label)} ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}</h2>
        <p class="muted" style="margin:0;font-size:13px">Made ${fmtTs(l.created_at)} · last opened ${fmtTs(l.last_opened)}</p>
        ${l.active ? `<p style="margin:0;overflow-wrap:anywhere;font-size:14px">${h(base)}/d/${h(l.token)}</p><div class="toolbar" style="margin:0"><button class="btn primary" data-copy="${h(base)}/d/${h(l.token)}">Copy link</button><a class="btn" href="/d/${h(l.token)}" target="_blank" rel="noopener">Open</a></div>` : ""}
        <form method="post" action="/department/share/${l.id}"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on with a new link"}</button></form></section>`).join("") || `<section class="card c12"><p class="muted">No links yet.</p></section>`}</div>`, { active: "/department/share" }));
  }));
  app.post("/department/share", A, wrap(async (req, res) => {
    const label = R.clean(req.body.label); if (!label) return res.redirect("/department/share");
    await pool.query("INSERT INTO dept_share_links (token, label, created_by) VALUES ($1,$2,$3)", [crypto.randomBytes(12).toString("base64url"), label, actor(req)]);
    await audit(pool, actor(req), "dept.share.create", "dept_share_links", label, null, null);
    setFlash(req, "ok", `Read-only link made for ${label}. Copy it and send it to them.`);
    res.redirect("/department/share");
  }));
  app.post("/department/share/:id", A, wrap(async (req, res) => {
    const on = req.body.active === "1";
    await pool.query(`UPDATE dept_share_links SET active = $2 ${on ? ", token = $3" : ""} WHERE id = $1`, [+req.params.id, on, ...(on ? [crypto.randomBytes(12).toString("base64url")] : [])]);
    await audit(pool, actor(req), on ? "dept.share.on" : "dept.share.off", "dept_share_links", req.params.id, null, null);
    setFlash(req, "ok", on ? "Switched on with a new link." : "Switched off. That link no longer works.");
    res.redirect("/department/share");
  }));
};
/** First start only: the team names from the October 2026 roster, so the schedule isn't empty (emails added on Staff). */
async function seedTeam() {
  const done = (await pool.query("SELECT 1 FROM settings WHERE key = 'deptTeamSeeded'")).rows[0];
  if (done) return;
  const n = Number((await pool.query("SELECT count(*) n FROM dept_staff")).rows[0].n);
  if (!n) for (const [name, job] of [["Lynsey", "Management"], ["Ronamae", "Cycling Development"], ["Jasper", "Coach"], ["Manal", "Coach"], ["Chane", "Coach"]])
    await pool.query("INSERT INTO dept_staff (full_name, job_title) VALUES ($1,$2)", [name, job]);
  await pool.query("INSERT INTO settings (key, value) VALUES ('deptTeamSeeded', 'true'), ('deptWeeklyHours', '48') ON CONFLICT (key) DO NOTHING");
}
module.exports.seedTeam = seedTeam;
module.exports.load = load;
module.exports.todayList = todayList;
module.exports.ACTS = ACTS;
module.exports.hrWorkbook = hrWorkbook;
module.exports.weekHours = async (staffId, monday) => { const D = await load(monday, addDays(monday, 6), { staffIds: [staffId] }); return days(monday, addDays(monday, 6)).reduce((a, d) => a + D.day(staffId, d).hours, 0); };
module.exports.mondayOf = mondayOf;
