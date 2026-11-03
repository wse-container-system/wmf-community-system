"use strict";
/**
 * WMF monthly export: total attendance per month for rides and events, and the programme's impact.
 * Every figure comes from the same engine (engine.js) and counting rules as the dashboard, so the file matches the screen.
 */
const ExcelJS = require("exceljs");
const E = require("./engine");
const { todayLocal } = require("./rules");
const { monLabel } = require("./views");
const { addMonths, monthEnd, monthsBetween } = E.helpers;

const HEAD = (row) => { row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" }, name: "Arial", size: 10 }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF6A55B8" } }; c.alignment = { vertical: "middle", wrapText: true }; }); row.height = 32; };
const colL = (n) => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

async function monthlyWorkbook(data, { from, to, sponsor = false } = {}) {
  const P = E.prepare(data);
  const today = (data.meta && data.meta.asOf) || todayLocal();
  const firstM = (P.dataStart || today).slice(0, 7), lastM = today.slice(0, 7);
  let b = /^\d{4}-\d{2}$/.test(to || "") ? to : lastM; if (b > lastM) b = lastM;
  let a = /^\d{4}-\d{2}$/.test(from || "") ? from : addMonths(b, -11);
  if (a > b) [a, b] = [b, a];
  if (a < firstM) a = firstM;
  if (b < a) b = a;
  const months = monthsBetween(a, b);
  // small counts are hidden from sponsors, as on the dashboard
  const sm = (v) => (sponsor && v > 0 && v < E.RULES.smallCount ? "<5" : v);

  const rows = [], seriesNames = new Set(), eventNames = new Set(), bySeries = [], byEvent = [];
  for (const m of months) {
    const end = monthEnd(m) < today ? monthEnd(m) : today;
    const c = E.compute(P, { start: m + "-01", end }, end);
    const k = c.kpis;
    rows.push({ m, rideSessions: k.rideSessions, rideAttendance: k.rideAttendance, avg: k.rideSessions ? Math.round((k.rideAttendance / k.rideSessions) * 10) / 10 : null,
      events: k.events, eventParticipation: k.eventParticipation, large: k.largeEvents.attendance, total: k.rideAttendance + k.eventParticipation,
      participants: k.participants, firstTimers: k.firstTimers, returning: k.returning, newMembers: k.newMembers, active: k.activeMembers, members: k.uniqueMembers });
    const s = new Map(c.bySeries.map((x) => [x.name, x.value])), e = new Map(c.byEvent.map((x) => [x.name, x.value]));
    for (const n of s.keys()) seriesNames.add(n); for (const n of e.keys()) eventNames.add(n);
    bySeries.push(s); byEvent.push(e);
  }
  const whole = E.compute(P, { start: a + "-01", end: monthEnd(b) < today ? monthEnd(b) : today }, today);
  const K = whole.kpis;

  const wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development · WMF"; wb.created = new Date();
  const label = `${monLabel(a, true)} – ${monLabel(b, true)}`;

  // ---------- 1. Monthly summary
  const ws = wb.addWorksheet("Monthly summary");
  ws.addRow([`WMN Moving FWD · attendance per month · ${label}`]).font = { bold: true, size: 13 };
  ws.addRow([`Data as of ${today}. Same counting rules as the WMF dashboard.${sponsor ? " Counts below 5 are shown as <5." : ""}`]);
  const heads = ["Month", "Ride sessions", "Ride attendance", "Avg riders per ride", "Events", "Event participation", "Total attendance (rides + events)", "Large public events (separate)",
    "Unique participants", "First-time participants", "Returning participants", "New members registered", "Active members at month end", "Total members at month end"];
  HEAD(ws.addRow(heads));
  const keys = ["rideSessions", "rideAttendance", "avg", "events", "eventParticipation", "total", "large", "participants", "firstTimers", "returning", "newMembers", "active", "members"];
  const sumCols = ["rideSessions", "rideAttendance", "events", "eventParticipation", "total", "large", "newMembers"];
  for (const r of rows) ws.addRow([monLabel(r.m, true), ...keys.map((k) => (k === "avg" ? r.avg : sm(r[k])))]);
  const first = 4, last = 3 + rows.length;
  const tot = ws.addRow(["Total", ...keys.map((k, i) => {
    const col = colL(i + 2);
    if (sumCols.includes(k)) return sponsor ? rows.reduce((x, r) => x + r[k], 0) : { formula: `SUM(${col}${first}:${col}${last})` };
    if (k === "avg") return sponsor ? (K.rideSessions ? Math.round((K.rideAttendance / K.rideSessions) * 10) / 10 : null) : { formula: `IFERROR(ROUND(C${last + 1}/B${last + 1},1),"")` };
    if (k === "participants") return sm(K.participants);
    if (k === "firstTimers") return sm(K.firstTimers);
    if (k === "returning") return sm(K.returning);
    return null;
  })]);
  tot.font = { bold: true }; tot.eachCell((c) => { c.border = { top: { style: "thin" } }; });
  ws.addRow([]);
  ws.addRow(["Unique participants, first-time and returning in the Total row count each person once across the whole period (not the sum of months)."]).font = { italic: true, size: 9 };
  ws.getColumn(1).width = 18; heads.slice(1).forEach((_, i) => { ws.getColumn(i + 2).width = 14; });
  ws.views = [{ state: "frozen", xSplit: 1, ySplit: 3 }];

  // ---------- 2/3. Rides and events by month (cross-tabs)
  const cross = (name, title, names, maps) => {
    const s = wb.addWorksheet(name);
    s.addRow([title]).font = { bold: true, size: 12 };
    HEAD(s.addRow([name.startsWith("Rides") ? "Ride" : "Event", ...months.map((m) => monLabel(m)), "Total"]));
    const list = [...names].sort();
    list.forEach((n, i) => {
      const vals = maps.map((mp) => mp.get(n) || 0), r = 3 + i;
      s.addRow([n, ...vals.map(sm), sponsor ? sm(vals.reduce((x, v) => x + v, 0)) : { formula: `SUM(B${r}:${colL(months.length + 1)}${r})` }]);
    });
    if (list.length) {
      const tr = s.addRow(["Total", ...months.map((_, j) => sponsor ? sm(maps[j] ? [...maps[j].values()].reduce((x, v) => x + v, 0) : 0) : { formula: `SUM(${colL(j + 2)}3:${colL(j + 2)}${2 + list.length})` }),
        sponsor ? maps.reduce((x, mp) => x + [...mp.values()].reduce((y, v) => y + v, 0), 0) : { formula: `SUM(${colL(months.length + 2)}3:${colL(months.length + 2)}${2 + list.length})` }]);
      tr.font = { bold: true };
    } else s.addRow(["None in this period."]);
    s.getColumn(1).width = 34; months.forEach((_, j) => { s.getColumn(j + 2).width = 9; }); s.getColumn(months.length + 2).width = 10;
    s.views = [{ state: "frozen", xSplit: 1, ySplit: 2 }];
  };
  cross("Rides by month", "Ride attendance per month by ride series (historical headcounts plus registered riders)", seriesNames, bySeries);
  cross("Events by month", "Event participation per month (each registration counts; large public events are on the summary sheet)", eventNames, byEvent);

  // ---------- 4. Impact
  const im = wb.addWorksheet("Impact");
  im.addRow([`Programme impact · ${label}`]).font = { bold: true, size: 13 };
  HEAD(im.addRow(["Measure", "Value", "What it means"]));
  const pc = (r) => (r == null ? "Not measurable yet" : r);
  const lines = [
    ["Total attendance (rides + events)", sm(K.rideAttendance + K.eventParticipation), "Every ride check-in or headcount and every event participation in the period."],
    ["Ride attendance", sm(K.rideAttendance), "Historical headcounts on the dates they cover, registered riders otherwise."],
    ["Ride sessions", sm(K.rideSessions), "Each ride series counted once per day."],
    ["Event participation", sm(K.eventParticipation), "Large public events are reported separately below."],
    ["Large public events (separate)", sm(K.largeEvents.attendance), (K.largeEvents.names || []).join("; ")],
    ["Unique participants", sm(K.participants), "Different people who took part at least once."],
    ["First-time participants", sm(K.firstTimers), "People whose first ever WMF activity was in this period."],
    ["Returning participants", sm(K.returning), "People who had taken part before the period."],
    ["New members registered", sm(K.newMembers), "Member records first seen in the period."],
    ["Active members now", sm(K.activeMembers), "2+ rides in the last 90 days, or a first ride within that window."],
    ["Total unique members", sm(K.uniqueMembers), "All member records to the end of the period."],
    ["Average participations per person", K.avgPerMember == null ? null : Math.round(K.avgPerMember * 10) / 10, "Qualifying participations ÷ unique participants."],
    ["Came back within 30 days", pc(K.retention[30].rate), `${K.retention[30].retained} of ${K.retention[30].eligible} first-timers old enough to measure.`],
    ["Came back within 60 days", pc(K.retention[60].rate), `${K.retention[60].retained} of ${K.retention[60].eligible}.`],
    ["Came back within 90 days", pc(K.retention[90].rate), `${K.retention[90].retained} of ${K.retention[90].eligible}.`],
    ["Registration → first participation", pc(K.regConversion.rate), `${K.regConversion.converted} of ${K.regConversion.cohort} new members (joined 30+ days ago) took part.`],
    ["First ride → second ride within 90 days", pc(K.firstToActive.rate), `${K.firstToActive.retained} of ${K.firstToActive.eligible} first-time riders.`],
  ];
  for (const l of lines) { const r = im.addRow(l); if (typeof l[1] === "number" && l[1] <= 1 && /Came back|→/.test(l[0])) r.getCell(2).numFmt = "0%"; }
  im.getColumn(1).width = 40; im.getColumn(2).width = 18; im.getColumn(3).width = 90;

  // ---------- 5. About
  const ab = wb.addWorksheet("About");
  for (const t of ["How to read this file", "Monthly summary: one row per month. Total attendance = ride attendance + event participation. Large public events (e.g. the pro-rider meet & greet) are kept separate so they don't swamp the monthly trend.",
    "Ride attendance uses the historical headcounts on the dates they cover and registered riders (QR scans, check-ins) after that, with no double counting.",
    "Active members: 2 or more rides in the 90 days to the month end (or to today for the current month), or a first ride within that window.",
    "Unique participants per month count each person once in that month; the Total row counts each person once across the whole period.",
    `Exported ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC from the WMF Community System.`]) ab.addRow([t]);
  ab.getRow(1).font = { bold: true }; ab.getColumn(1).width = 120;
  return { buffer: await wb.xlsx.writeBuffer(), from: a, to: b };
}

module.exports = { monthlyWorkbook };
