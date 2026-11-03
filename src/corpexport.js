"use strict";
/** Corporate Excel files: the tracker in its familiar layout, and the management / sponsor report. */
const ExcelJS = require("exceljs");
const { pool } = require("./db");
const C = require("./corpdata");
const R = require("./rules");
const { monLabel } = require("./views");

const HEAD = { font: { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 10 }, fill: { type: "pattern", pattern: "solid", fgColor: { argb: "FF4D5AC2" } }, alignment: { vertical: "middle", wrapText: true } };
const toDate = (s) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || "")); return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null; };
const colL = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
function styleHead(row) { row.eachCell((c) => { c.font = HEAD.font; c.fill = HEAD.fill; c.alignment = HEAD.alignment; }); row.height = 30; }
function sheetTable(wb, name, heads, rows, widths = [], { totals } = {}) {
  const ws = wb.addWorksheet(name.slice(0, 31));
  ws.addRow(heads); styleHead(ws.getRow(1));
  for (const r of rows) ws.addRow(r);
  if (totals && rows.length) {
    const tr = ws.addRow(heads.map((_, i) => (i === 0 ? "Total" : totals.includes(i) ? { formula: `SUM(${colL(i + 1)}2:${colL(i + 1)}${rows.length + 1})` } : null)));
    tr.font = { bold: true, name: "Arial", size: 10 };
  }
  heads.forEach((hd, i) => { ws.getColumn(i + 1).width = widths[i] || Math.max(12, Math.min(40, String(hd).length + 4)); });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  return ws;
}

/** One sheet per company laid out like the tracker (names down, session dates across, 1 = attended), plus a Master Data sheet. */
async function trackerWorkbook({ sc }) {
  const wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development"; wb.created = new Date();
  const md = [];
  for (const code of sc.codes) {
    const co = sc.byCode[code];
    const sess = (await pool.query("SELECT * FROM corp_sessions WHERE company = $1 ORDER BY session_date, kind <> $2, id", [code, C.RIDE])).rows;
    const parts = (await pool.query("SELECT * FROM corp_participants WHERE company = $1 ORDER BY status, full_name", [code])).rows;
    const att = (await pool.query("SELECT a.session_id, a.participant_id, p.community, p.joined FROM corp_attendance a JOIN corp_participants p ON p.id = a.participant_id JOIN corp_sessions s ON s.id = a.session_id WHERE s.company = $1", [code])).rows;
    const has = new Set(att.map((a) => a.session_id + "|" + a.participant_id));
    const ws = wb.addWorksheet(co.name.replace(/[\\/*?:[\]]/g, "").slice(0, 31));
    ws.addRow(["", "", "", "", "", ...sess.map((s, i) => `W${i + 1}`)]);
    ws.addRow(["", "", "", "", "", ...sess.map((s) => (s.kind === C.RIDE ? (s.title || "") : s.title || s.kind))]);
    const hr = ws.addRow(["ID", "Names", "Gender", "Bike size", "Status", ...sess.map((s) => toDate(s.session_date)), "Total"]);
    styleHead(hr);
    sess.forEach((s, i) => { ws.getColumn(6 + i).numFmt = "d mmm yy"; ws.getColumn(6 + i).width = 9; });
    const first = 4;
    parts.forEach((p, r) => {
      const rowN = first + r;
      ws.addRow([p.pid, p.full_name, p.gender || "", p.bike_size || "", p.status,
        ...sess.map((s) => (s.status === "Cancelled" ? (r === 0 ? s.remarks || "Cancelled" : null) : has.has(s.id + "|" + p.id) ? 1 : null)),
        { formula: `SUM(${colL(6)}${rowN}:${colL(5 + sess.length)}${rowN})` }]);
    });
    const tr = ws.addRow(["", "TOTAL", "", "", "", ...sess.map((s, i) => { const c = colL(6 + i); const named = att.some((a) => a.session_id === s.id); return s.status === "Cancelled" ? 0 : named || s.headcount == null ? { formula: `SUM(${c}${first}:${c}${first + parts.length - 1})` } : s.headcount; })]);
    tr.font = { bold: true };
    ws.getColumn(1).width = 12; ws.getColumn(2).width = 28; ws.getColumn(5).width = 10;
    ws.views = [{ state: "frozen", xSplit: 2, ySplit: 3 }];
    // Master Data rows for this company
    sess.forEach((s, i) => {
      const a = att.filter((x) => x.session_id === s.id);
      const named = a.length;
      const total = s.status === "Cancelled" ? null : named || s.headcount || 0;
      const d = String(s.session_date);
      md.push([s.kind === C.RIDE ? co.name : `${co.name} ${s.title || s.kind}`, i + 1, toDate(d), monLabel(d.slice(0, 7), true).split(" ")[0], +d.slice(0, 4), total,
        named ? a.filter((x) => /expat/i.test(x.community || "")).length : s.headcount_expat, named ? a.filter((x) => /emirati/i.test(x.community || "")).length : s.headcount_emirati,
        named ? a.filter((x) => String(x.joined) === d).length : s.headcount_new, s.status === "Cancelled" ? s.remarks || "Cancelled" : s.remarks || null]);
    });
  }
  md.sort((a, b) => a[2] - b[2]);
  const ws = sheetTable(wb, "Master Data", ["Company", "Week", "Date", "Month", "Year", "TOTAL ATTENDEES", "Expat", "Emirati", "New", "Remarks"], md, [24, 8, 12, 10, 8, 16, 8, 9, 8, 40]);
  ws.getColumn(3).numFmt = "d mmm yyyy";
  return wb.xlsx.writeBuffer();
}

/** Report workbook: summary, monthly figures, by company, activities & events (and, for staff, participants). */
async function reportWorkbook({ sc, per, named }) {
  const st = await C.stats({ codes: sc.codes, start: per.start, end: per.end });
  const k = st.k, wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development"; wb.created = new Date();
  const s = wb.addWorksheet("Summary");
  s.addRow([`Corporate Cycling Programme · ${sc.sel ? sc.sel.name : "All corporate partners"}`]).font = { bold: true, size: 14 };
  s.addRow([`${per.label} (${per.start} to ${per.end < R.todayLocal() ? per.end : R.todayLocal()}) · prepared ${R.todayLocal()}`]);
  s.addRow([]);
  styleHead(s.addRow(["Measure", "Value"]));
  for (const [l, v] of [["Total attendance", k.attendance], ["Weekly rides held", k.rideSessions], ["Ride attendance", k.rideAttendance], ["Average riders per ride", k.avgPerRide == null ? null : Math.round(k.avgPerRide * 10) / 10],
    ["Other activities & events held", k.events], ["Activity & event attendance", k.eventAttendance], ["People taking part (named)", k.people], ["New joiners", k.newJoiners],
    ["Active participants (2+ sessions in 90 days)", k.active], ["Came back again (2+ sessions in period)", k.repeatRate], ["Sessions cancelled", k.cancelled], ["Emirati attendance", k.emirati], ["Expat attendance", k.expat], ["Community not recorded", k.unknownCommunity]]) s.addRow([l, v]);
  s.getCell("B14").numFmt = "0%";
  s.getColumn(1).width = 46; s.getColumn(2).width = 14;
  const months = st.months.filter((m) => m.inRange);
  sheetTable(wb, "Monthly", ["Month", "Weekly rides", "Ride attendance", "Activities & events", "Their attendance", "Total attendance", "People (named)", "Cancelled", ...(sc.codes.length > 1 ? sc.codes.map((c) => sc.byCode[c].name) : [])],
    months.map((m) => [monLabel(m.month, true), m.rides, m.rideAttendance, m.events, m.eventAttendance, m.attendance, m.people, m.cancelled, ...(sc.codes.length > 1 ? sc.codes.map((c) => m.byCo[c]) : [])]),
    [16], { totals: [1, 2, 3, 4, 5, 7, ...(sc.codes.length > 1 ? sc.codes.map((_, i) => 8 + i) : [])] });
  sheetTable(wb, "By company", ["Company", "Weekly rides", "Average per ride", "Activities & events", "Total attendance", "People (named)", "Active now", "Active roster", "Cancelled"],
    st.byCompany.map((b) => [sc.byCode[b.code].name, b.sessions, b.avg == null ? null : Math.round(b.avg * 10) / 10, b.events, b.attendance, b.people, b.active, b.roster, b.cancelled]), [18], { totals: [1, 3, 4, 8] });
  const ev = sheetTable(wb, "Sessions", ["Date", "Company", "Activity", "Title", "Status", "Attendance", "Named check-ins", "Headcount", "Remarks"],
    st.sessions.map((x) => [toDate(x.d), sc.byCode[x.company].name, x.kind, x.title || "", x.status, x.attendance, x.named, x.headcount, x.remarks || ""]), [12, 14, 14, 26, 11, 11, 14, 11, 40], { totals: [5] });
  ev.getColumn(1).numFmt = "d mmm yyyy";
  if (named) {
    const P = [...st.participants.values()].filter((p) => p.dates.some((d) => d >= per.start && d <= per.end) || p.status === "Active");
    sheetTable(wb, "Participants", ["ID", "Name", "Company", "Community", "Status", "Sessions in period", "Sessions all time", "First", "Last"],
      P.map((p) => [p.pid, p.full_name, sc.byCode[p.company].name, p.community || "", p.status, p.dates.filter((d) => d >= per.start && d <= per.end).length, p.dates.length, p.first, p.last]), [12, 28, 12, 12, 10, 16, 16, 12, 12]);
  }
  const ab = wb.addWorksheet("About");
  for (const t of ["How the figures are counted", "Attendance counts each person once per session. Sessions recorded only as a headcount count that headcount.",
    "Weekly rides are the regular programme rides; running, yoga, workshops and events are counted as activities & events.",
    "Active participants attended 2 or more sessions in the 90 days to the end of the period.", "New joiners took part for the first time in the period.",
    named ? "This file contains participants' names: keep it inside the department." : "This file contains no names."]) ab.addRow([t]);
  ab.getRow(1).font = { bold: true }; ab.getColumn(1).width = 110;
  return wb.xlsx.writeBuffer();
}

module.exports = { trackerWorkbook, reportWorkbook };
