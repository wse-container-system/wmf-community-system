"use strict";
/**
 * Marketing report: ride participation, events, event participation and impact. Nothing else.
 * A dashboard-style page that can be shared as a view-only link (no sign-in), and the same figures as a styled Excel file.
 */
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { pool, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { reportData, periodOf } = require("./report");
const { h, fmtDate, monLabel, nf, detailTiles, mini } = require("./views");
const { columns } = require("./charts");
const MK = require("./mkinputs");

const AUH = "#5b7cf0", DXB = "#e8833a";
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };
const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/** Only what marketing needs, from the same figures as the management report. */
async function marketingData(per) {
  const D = await reportData(per);
  const A = D.city["Abu Dhabi"], X = D.city.Dubai;
  const rideMonths = D.months.map((m) => {
    const a = (A.trend.find((t) => t.m === m) || {}).v || 0, d = (X.trend.find((t) => t.m === m) || {}).v || 0;
    return { m, auh: a, dxb: d, total: a + d, inPeriod: m >= D.start.slice(0, 7) };
  });
  const rides = [...A.rides.map((r) => ({ ...r, city: "Abu Dhabi" })), ...X.rides.map((r) => ({ ...r, city: "Dubai" }))].sort((a, b) => b.attendance - a.attendance);
  const events = D.done.map((a) => ({ act_id: a.id, date: a.event_date || String(a.month).slice(0, 10), dated: !!a.event_date, title: a.title, city: D.isDxb(a) ? "Dubai" : "Abu Dhabi", category: a.category,
    participants: a.participants, registrants: a.registrants, partners: a.partners, impact: a.impact || "", big: D.isBig(a) })).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return {
    per, label: per.label, kind: per.kind, sessions: D.sessionsList,
    ride: { total: D.k.rideAttendance, sessions: D.k.rideSessions, avg: D.k.rideSessions ? D.k.rideAttendance / D.k.rideSessions : null, auh: A.att, dxb: X.att, auhShare: A.share, dxbShare: X.share },
    rideMonths, rides,
    ev: { count: events.length, people: D.evPeople, partners: D.partners.length, withImpact: events.filter((e) => e.impact).length },
    events, mk: await MK.loadInputs({ start: D.start, end: D.end }),
  };
}

// ---------------------------------------------------------------- what each number is made of
function details(M, input) {
  const addHref = (v) => `${input.base}?${input.qs({ target: v })}#log`;
  const mkOf = (e) => M.mk.byEvent.find((g) => g.act_id && g.act_id === e.act_id);
  const title = (e) => (input ? `<a href="${h(addHref("a:" + e.act_id))}" title="Add marketing for this event">${h(e.title)}</a>` : h(e.title));
  const mkCell = (e) => { const g = mkOf(e); const v = g ? `${nf(g.reach)} reach · ${nf(g.eng)} eng.` : "—"; return input ? `${v} <a class="btn tblbtn" href="${h(addHref("a:" + e.act_id))}">+ Add</a>` : v; };
  const pm = M.rideMonths.filter((x) => x.inPeriod);
  const evRow = (e) => [e.dated ? fmtDate(e.date) : monLabel(String(e.date).slice(0, 7), true), title(e), e.city === "Dubai" ? "DXB" : "AUH", e.participants != null ? nf(e.participants) : "—", h(e.partners.join(", ") || "—"), mkCell(e)];
  return [
    { title: `Ride participation · ${M.label}`, html: `<h3>By city</h3>${mini(["City", "Participation", "Share"], [["Abu Dhabi", nf(M.ride.auh), M.ride.auhShare + "%"], ["Dubai", nf(M.ride.dxb), M.ride.dxbShare + "%"]], { num: [1, 2] })}
      <h3>By ride</h3>${mini(["Ride", "City", "Rides", "Participation"], M.rides.map((r) => [h(r.name), r.city === "Dubai" ? "DXB" : "AUH", nf(r.sessions), nf(r.attendance)]), { num: [2, 3] })}
      ${pm.length > 1 ? `<h3>By month</h3>${mini(["Month", "Abu Dhabi", "Dubai", "Total"], pm.map((x) => [monLabel(x.m, true), nf(x.auh), nf(x.dxb), `<b>${nf(x.total)}</b>`]), { num: [1, 2, 3] })}` : ""}` },
    { title: `Every ride · ${M.label}`, html: mini(["Date", "City", "Ride", "Riders"], M.sessions.map((s) => [fmtDate(s.d), s.city === "Dubai" ? "DXB" : "AUH", h(s.series), nf(s.n)]), { num: [3], scroll: true }) },
    { title: `Events · ${M.label}`, html: (input ? '<p class="hint" style="margin:0 0 6px">Click an event to add its marketing: posts, reach and engagement.</p>' : "") + mini(["Date", "Event", "City", "Participants", "Partners", "Marketing"], M.events.map(evRow), { num: [3], scroll: true }) },
    { title: "Event participation, biggest first", html: mini(["Date", "Event", "City", "Participants", "Partners", "Marketing"], [...M.events].sort((a, b) => (b.participants || 0) - (a.participants || 0)).map(evRow), { num: [3], scroll: true }) },
    { title: `Marketing · ${M.label}`, html: mini(["Event", "Posts", "Reach", "Engagements", "Rate", "Came"], M.mk.byEvent.map((g) => [h(g.title) + (g.other ? ' <span class="muted">· other event</span>' : ""), nf(g.actions.length), nf(g.reach), nf(g.eng), MK.rateOf(g) || "—", g.key === "general" ? "—" : g.participants != null ? nf(g.participants) : "—"]), { num: [1, 2, 3, 4, 5], empty: "No marketing logged yet." }) },
  ];
}

// ---------------------------------------------------------------- events with their marketing
function eventCards(M, input) {
  const groups = M.mk.byEvent.filter((g) => g.key !== "general"), mx = MK.maxes(groups);
  const used = new Set();
  const add = (v) => (input ? `<a class="btn tblbtn mk-ev-add noprint" href="${input.base}?${input.qs({ target: v })}#log">+ Add marketing</a>` : "");
  const cards = M.events.map((e) => {
    const g = groups.find((x) => x.act_id === e.act_id); if (g) used.add(g.key);
    return { d: String(e.date), html: `<article class="mk-ev ${e.city === "Dubai" ? "dxb" : "auh"}">
      <div class="mk-ev-top"><span class="badge">${h(e.city)} · ${h(e.category)}</span><span class="muted">${e.dated ? fmtDate(e.date) : monLabel(String(e.date).slice(0, 7), true)}</span></div>
      <h3>${input ? `<a href="${input.base}?${input.qs({ target: "a:" + e.act_id })}#log">${h(e.title)}</a>` : h(e.title)}</h3>
      <p class="mk-n"><b>${e.participants != null ? nf(e.participants) : "—"}</b> participants${e.registrants ? ` · ${nf(e.registrants)} registered` : ""}${e.partners.length ? ` · with ${h(e.partners.join(", "))}` : ""}</p>
      ${e.impact ? `<p class="mk-impact">${h(cut(e.impact, 320))}</p>` : ""}${g ? MK.funnel(g, mx) : ""}${add("a:" + e.act_id)}</article>` };
  });
  // marketing for events that aren't held WMF activations: upcoming WMF events and other events or activities
  for (const g of groups.filter((x) => !used.has(x.key))) cards.push({ d: String(g.date), html: `<article class="mk-ev ${g.other ? "other" : g.city === "Dubai" ? "dxb" : "auh"}">
      <div class="mk-ev-top"><span class="badge">${g.other ? "Other event / activity" : h(g.city || "WMF") + " · WMF event"}</span><span class="muted">${g.date ? fmtDate(g.date) : ""}</span></div>
      <h3>${h(g.title)}</h3>${MK.funnel(g, mx)}${add(g.other ? "o" : g.act_id ? "a:" + g.act_id : "e:" + g.actions[0].activity_id)}</article>` });
  cards.sort((a, b) => b.d.localeCompare(a.d));
  return cards.length ? `<div class="mk-events">${cards.map((c) => c.html).join("")}</div>` : "";
}

// ---------------------------------------------------------------- page
function pageHtml(M, { periodNav, excelHref, staff, input }) {
  const tiles = [["Ride participation", nf(M.ride.total), `AUH ${nf(M.ride.auh)} · DXB ${nf(M.ride.dxb)}`], ["Rides held", nf(M.ride.sessions), M.ride.avg ? `${Math.round(M.ride.avg)} riders per ride on average` : ""],
    ["Events", nf(M.ev.count), M.ev.partners ? `${M.ev.partners} partner${M.ev.partners === 1 ? "" : "s"}` : ""], ["Event participation", nf(M.ev.people), M.ev.count ? `${Math.round(M.ev.people / M.ev.count)} per event on average` : ""],
    ["Marketing reach", nf(M.mk.totals.reach), M.mk.totals.actions ? `${nf(M.mk.totals.actions)} posts · ${nf(M.mk.totals.eng)} engagements` : "Nothing logged yet"]];
  const chart = columns({ categories: M.rideMonths.map((x) => x.m), series: [{ name: "Abu Dhabi", color: AUH, values: M.rideMonths.map((x) => x.auh) }, { name: "Dubai", color: DXB, values: M.rideMonths.map((x) => x.dxb) }],
    height: 210, label: "Ride participation by month", short: (m) => monLabel(m) });
  const maxR = Math.max(1, ...M.rides.map((r) => r.attendance));
  return `<section class="mk-head"><div><div class="wc-eyebrow">WMN Moving FWD · marketing</div><h2 class="ov-title">${h(M.label)}</h2>
      <p class="lead" style="margin:4px 0 0">Rides, events and marketing in one place: what was posted, how far it reached, and who came.</p></div>
      <div class="mk-actions">${periodNav}<a class="btn primary" href="${h(excelHref)}">Download Excel</a></div></section>
    ${(() => { const dd = details(M, input); return detailTiles(tiles.map(([l, v, n], i) => ({ label: l, value: v, note: h(n), detail: dd[i] }))); })()}
    <div class="grid">
      <section class="card c7"><h2>Ride participation by month</h2><p class="lead">One person at one ride is one participation. Abu Dhabi ${M.ride.auhShare}% · Dubai ${M.ride.dxbShare}% this period.</p>${chart}</section>
      <section class="card c5"><h2>Rides</h2><p class="lead">Participation per ride series this period.</p>
        ${M.rides.length ? `<div class="hbars">${M.rides.slice(0, 8).map((r) => `<div class="hbar"><span class="hbar-l">${h(r.name)} <span class="muted">${r.city === "Dubai" ? "DXB" : "AUH"}</span></span>
          <span class="hbar-t"><span style="width:${(r.attendance / maxR) * 100}%;background:${r.city === "Dubai" ? DXB : AUH}"></span></span><span class="hbar-v">${nf(r.attendance)} <span class="muted">· ${r.sessions} ride${r.sessions === 1 ? "" : "s"}</span></span></div>`).join("")}</div>` : '<p class="muted">No rides in this period.</p>'}</section>
      <section class="card c12"><h2>Events &amp; impact</h2><p class="lead">${M.ev.count ? `${nf(M.ev.count)} event${M.ev.count === 1 ? "" : "s"}, ${nf(M.ev.people)} participants.` : "No WMF events recorded for this period."}${input ? " Use “+ Add marketing” on an event to log a post for it." : ""}</p>
        ${MK.totalsHtml(M.mk)}
        ${eventCards(M, input)}${MK.generalLine(M.mk)}</section>
      ${input ? MK.formHtml(input) + MK.logHtml(M.mk, { base: input.base, qs: input.qs, label: M.label }) : ""}
    </div>
    <p class="muted" style="font-size:13px">Figures from the WMF Community System${staff ? "" : " · shared view, no personal data"}.</p>`;
}

// ---------------------------------------------------------------- Excel, laid out like a dashboard
async function workbook(M) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "WMF Community System"; wb.created = new Date();
  const F = "Arial", INK = "FF15151F", MUT = "FF5D6075", BLUE = "FF4D6AE0", CARD = "FFF4F5FB", LINE = "FFE3E5EF";
  const fill = (c) => ({ type: "pattern", pattern: "solid", fgColor: { argb: c } });
  const border = { bottom: { style: "thin", color: { argb: LINE } } };

  // ----- Dashboard
  const ws = wb.addWorksheet("Dashboard", { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 2 }, ...Array(8).fill({ width: 16 }), { width: 2 }];
  ws.mergeCells("B2:I2"); Object.assign(ws.getCell("B2"), { value: "WMN MOVING FWD · MARKETING REPORT", font: { name: F, size: 10, bold: true, color: { argb: BLUE } } });
  ws.mergeCells("B3:I3"); Object.assign(ws.getCell("B3"), { value: M.label, font: { name: F, size: 22, bold: true, color: { argb: INK } } });
  ws.getRow(3).height = 32;
  ws.mergeCells("B4:I4"); Object.assign(ws.getCell("B4"), { value: "Ride participation, events and their impact · Abu Dhabi & Dubai", font: { name: F, size: 10, color: { argb: MUT } } });
  // KPI tiles: 4 tiles, 2 columns each
  const tiles = [["Ride participation", M.ride.total, `AUH ${M.ride.auh} · DXB ${M.ride.dxb}`], ["Rides held", M.ride.sessions, M.ride.avg ? `${Math.round(M.ride.avg)} per ride on average` : ""],
    ["Events", M.ev.count, `${M.ev.partners} partners`], ["Event participation", M.ev.people, M.ev.count ? `${Math.round(M.ev.people / M.ev.count)} per event on average` : ""]];
  tiles.forEach(([l, v, n], i) => {
    const c1 = 2 + i * 2, c2 = c1 + 1;
    for (const r of [6, 7, 8]) { ws.mergeCells(r, c1, r, c2); ws.getCell(r, c1).fill = fill(CARD); }
    Object.assign(ws.getCell(6, c1), { value: l, font: { name: F, size: 10, bold: true, color: { argb: INK } }, alignment: { indent: 1, vertical: "bottom" } });
    Object.assign(ws.getCell(7, c1), { value: v, font: { name: F, size: 24, bold: true, color: { argb: INK } }, alignment: { indent: 1, horizontal: "left" }, numFmt: "#,##0" });
    Object.assign(ws.getCell(8, c1), { value: n, font: { name: F, size: 9, color: { argb: BLUE } }, alignment: { indent: 1, vertical: "top" } });
  });
  ws.getRow(6).height = 22; ws.getRow(7).height = 36; ws.getRow(8).height = 20;
  // section helper
  let row = 10;
  const section = (title) => { ws.mergeCells(row, 2, row, 9); Object.assign(ws.getCell(row, 2), { value: title, font: { name: F, size: 13, bold: true, color: { argb: INK } } }); ws.getRow(row).height = 22; row += 1; };
  const head = (cells) => { cells.forEach(([c, t, span]) => { if (span) ws.mergeCells(row, c, row, c + span - 1); Object.assign(ws.getCell(row, c), { value: t, font: { name: F, size: 9, bold: true, color: { argb: MUT } }, border, alignment: { horizontal: c > 2 && !span ? "right" : "left" } }); }); row += 1; };
  // monthly participation, with in-cell bars
  section("Ride participation by month");
  head([[2, "Month", 2], [4, "Abu Dhabi"], [5, "Dubai"], [6, "Total"], [7, "", 3]]);
  const m0 = row;
  for (const x of M.rideMonths) {
    ws.mergeCells(row, 2, row, 3); ws.mergeCells(row, 7, row, 9);
    ws.getCell(row, 2).value = monLabel(x.m, true) + (x.inPeriod ? "" : "  (earlier)");
    ws.getCell(row, 4).value = x.auh; ws.getCell(row, 5).value = x.dxb; ws.getCell(row, 6).value = x.total; ws.getCell(row, 7).value = x.total;
    for (let c = 2; c <= 9; c++) { const cell = ws.getCell(row, c); cell.font = { name: F, size: 10, color: { argb: x.inPeriod ? INK : MUT }, bold: c === 6 }; cell.border = border; if (c >= 4 && c <= 7) cell.numFmt = "#,##0"; }
    ws.getCell(row, 7).font = { name: F, size: 10, color: { argb: "FFFFFFFF" } };
    row++;
  }
  if (M.rideMonths.length) ws.addConditionalFormatting({ ref: `G${m0}:G${row - 1}`, rules: [{ type: "dataBar", minLength: 0, maxLength: 100, cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF5B7CF0" }, gradient: false }] });
  row++;
  // ride series
  section("Rides");
  head([[2, "Ride", 2], [4, "City"], [5, "Rides"], [6, "Participation"], [7, "Avg. per ride"], [8, "", 2]]);
  const r0 = row;
  for (const r of M.rides) {
    ws.mergeCells(row, 2, row, 3); ws.mergeCells(row, 8, row, 9);
    Object.assign(ws.getCell(row, 2), { value: r.name }); ws.getCell(row, 4).value = r.city; ws.getCell(row, 5).value = r.sessions; ws.getCell(row, 6).value = r.attendance;
    ws.getCell(row, 7).value = Math.round(r.avg * 10) / 10; ws.getCell(row, 8).value = r.attendance;
    for (let c = 2; c <= 9; c++) { const cell = ws.getCell(row, c); cell.font = { name: F, size: 10, color: { argb: c === 8 ? "FFFFFFFF" : INK } }; cell.border = border; }
    ws.getCell(row, 4).font = { name: F, size: 10, color: { argb: r.city === "Dubai" ? "FFE8833A" : "FF5B7CF0" }, bold: true };
    row++;
  }
  if (M.rides.length) ws.addConditionalFormatting({ ref: `H${r0}:H${row - 1}`, rules: [{ type: "dataBar", minLength: 0, maxLength: 100, cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF9B7BE0" }, gradient: false }] });
  if (!M.rides.length) { ws.getCell(row, 2).value = "No rides in this period."; row++; }
  row++;
  // events summary (full impact on the next sheet)
  section("Events");
  head([[2, "Date"], [3, "Event", 3], [6, "City"], [7, "Participants"], [8, "Partners", 2]]);
  for (const e of M.events) {
    ws.mergeCells(row, 3, row, 5); ws.mergeCells(row, 8, row, 9);
    ws.getCell(row, 2).value = e.dated ? fmtDate(e.date) : monLabel(String(e.date).slice(0, 7), true); ws.getCell(row, 3).value = e.title; ws.getCell(row, 6).value = e.city;
    ws.getCell(row, 7).value = e.participants; ws.getCell(row, 8).value = e.partners.join(", ");
    for (let c = 2; c <= 9; c++) { const cell = ws.getCell(row, c); cell.font = { name: F, size: 10, color: { argb: INK }, bold: c === 3 }; cell.border = border; cell.alignment = { vertical: "top", wrapText: c === 3 || c === 8, horizontal: c === 7 ? "center" : "left" }; }
    row++;
  }
  if (!M.events.length) { ws.getCell(row, 2).value = "No events recorded for this period."; row++; }
  ws.getCell(row + 1, 2).value = "Impact of each event: see the “Events & impact” sheet."; ws.getCell(row + 1, 2).font = { name: F, size: 9, italic: true, color: { argb: MUT } };

  // ----- Events & impact (full text)
  const es = wb.addWorksheet("Events & impact", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  es.columns = [{ header: "Date", key: "date", width: 13 }, { header: "Event", key: "title", width: 34 }, { header: "City", key: "city", width: 11 }, { header: "Type", key: "category", width: 24 },
    { header: "Participants", key: "participants", width: 13 }, { header: "Registered", key: "registrants", width: 12 }, { header: "Partners", key: "partners", width: 26 }, { header: "Impact", key: "impact", width: 80 }];
  for (const e of M.events) es.addRow({ ...e, date: e.dated ? fmtDate(e.date) : monLabel(String(e.date).slice(0, 7), true), partners: e.partners.join(", ") });
  es.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); c.alignment = { vertical: "middle" }; });
  es.getRow(1).height = 22;
  es.eachRow((r, i) => { if (i === 1) return; r.eachCell((c) => { c.font = { name: F, size: 10 }; c.alignment = { vertical: "top", wrapText: true }; c.border = border; }); if (i % 2 === 0) r.eachCell((c) => { c.fill = fill(CARD); }); });

  // ----- Marketing: per event, then every post
  const ms = wb.addWorksheet("Marketing", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  ms.columns = [{ header: "Event", key: "title", width: 34 }, { header: "Date", key: "date", width: 13 }, { header: "Posts", key: "posts", width: 9 }, { header: "Channels", key: "ch", width: 26 },
    { header: "Reach", key: "reach", width: 11 }, { header: "Engagements", key: "eng", width: 13 }, { header: "Engagement rate", key: "rate", width: 15 }, { header: "Registered", key: "reg", width: 11 }, { header: "Came", key: "came", width: 9 }];
  for (const g of M.mk.byEvent) ms.addRow({ title: g.title + (g.other ? " (other event)" : ""), date: g.date ? fmtDate(g.date) : "", posts: g.actions.length, ch: [...g.channels].join(", "), reach: g.reach, eng: g.eng,
    rate: MK.rateOf(g) || "", reg: g.key === "general" ? null : g.registrants, came: g.key === "general" ? null : g.participants });
  ms.addRow({});
  ms.addRow({ title: "Every post" }).font = { name: F, size: 11, bold: true };
  ms.addRow({ title: "Event", date: "Posted", posts: "Channel", ch: "Type", reach: "Reach", eng: "Engagements", rate: "Clicks", reg: "Sign-ups" }).font = { name: F, size: 10, bold: true, color: { argb: MUT } };
  for (const r of M.mk.rows) ms.addRow({ title: r.ev_title || "General / brand", date: fmtDate(r.posted), posts: r.channel, ch: r.kind + (r.title ? " · " + r.title : ""), reach: r.reach, eng: r.engagements, rate: r.clicks, reg: r.signups });
  ms.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); });

  // ----- Ride participation (plain table, easy to reuse)
  const rs = wb.addWorksheet("Rides by month", { views: [{ state: "frozen", ySplit: 1 }] });
  rs.columns = [{ header: "Month", key: "m", width: 16 }, { header: "Abu Dhabi", key: "auh", width: 12 }, { header: "Dubai", key: "dxb", width: 12 }, { header: "Total", key: "total", width: 12 }];
  for (const x of M.rideMonths) rs.addRow({ ...x, m: monLabel(x.m, true) });
  rs.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); });
  return wb.xlsx.writeBuffer();
}

module.exports = function marketing(app, { need, page, setFlash, actor, wrap, limit }) {
  const READ = need("admin", "coordinator", "viewer"), STAFF = need("admin", "coordinator");
  const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
  const qs = (per) => `period=${per.type}&p=${encodeURIComponent(per.p)}`;
  /** Month / quarter / year picker; base is the page address it reloads. */
  function periodNav(per, base) {
    const today = R.todayLocal(), opts = [];
    if (per.type === "month") for (const m of E.helpers.monthsBetween("2025-01", today.slice(0, 7)).reverse()) opts.push([m, monLabel(m, true)]);
    if (per.type === "quarter") for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) opts.push([`${y}-Q${q}`, `Q${q} ${y}`]);
    if (per.type === "year") for (let y = +today.slice(0, 4); y >= 2025; y--) opts.push([String(y), String(y)]);
    return `<span class="seg">${Object.keys(KIND).map((t) => `<a href="${base}?period=${t}" class="${per.type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
      <form method="get" action="${base}" style="margin:0"><input type="hidden" name="period" value="${per.type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="Period">${opts.map(([v, l]) => `<option value="${v}" ${v === per.p ? "selected" : ""}>${h(l)}</option>`).join("")}</select></form>`;
  }
  const backQs = (req) => new URLSearchParams({ period: req.query.period || "month", ...(req.query.p ? { p: req.query.p } : {}) }).toString();
  /** What the add-marketing form needs on this page. */
  const inputOf = async (req, per, base) => {
    const q = (o) => new URLSearchParams({ period: per.type, p: per.p, ...o }).toString();
    const pre = String(req.query.target || "").slice(0, 90);
    return { base, qs: q, tg: await MK.targets(), editing: await MK.editRow(req.query.edit), pre: /^(a:\d+|e:.+|o)$/.test(pre) ? pre : "", cancelHref: `${base}?${q({})}#log` };
  };
  const sendXlsx = async (res, per) => {
    const M = await marketingData(per);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", `attachment; filename="WMF-Marketing-Report-${per.p}.xlsx"`).send(await workbook(M));
  };

  // ----- the team
  app.get("/report/marketing", READ, wrap(async (req, res) => {
    const per = periodOf(req.query);
    const M = await marketingData(per);
    const canEdit = req.session.user.role !== "viewer";
    const input = canEdit ? await inputOf(req, per, "/report/marketing") : null;
    const links = (await pool.query("SELECT * FROM report_links WHERE kind = 'marketing' ORDER BY active DESC, created_at DESC")).rows;
    const share = links.map((l) => {
      const url = `${baseOf(req)}/m/${l.token}`;
      return `<div class="lr-link ${l.active ? "" : "off"}"><div><b>${h(l.label)}</b> ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}
        ${l.active ? `<div class="toolbar" style="margin:6px 0 0"><button class="btn tblbtn primary" type="button" data-copy="${h(url)}">Copy link</button>
          <a class="btn tblbtn" href="https://wa.me/?text=${encodeURIComponent(`Hi ${l.label}, here's the WMF marketing page: rides, events and their impact. Add each post or campaign with its reach and engagement there, and it shows next to the event's attendance: ${url}`)}" target="_blank" rel="noopener">WhatsApp</a>
          <a class="btn tblbtn" href="mailto:?subject=${encodeURIComponent("WMF marketing")}&body=${encodeURIComponent(`Hi ${l.label},\n\nHere's the WMF marketing page: rides, events and their impact.\n\nFor each post or campaign, press “+ Add marketing” on the event (or choose “Other event or activity”) and add the reach and engagement. It shows next to the event's attendance, and management sees it in their report.\n\nYou can choose the month at the top and download it as Excel.\n\n${url}`)}">Email</a></div>` : ""}</div>
        ${req.session.user.role !== "viewer" ? `<form method="post" action="/report/marketing/links/${l.id}"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form>` : ""}</div>`;
    }).join("");
    res.send(page(req, "Marketing", `${pageHtml(M, { periodNav: periodNav(per, "/report/marketing"), excelHref: `/report/marketing.xlsx?${qs(per)}`, staff: true, input })}
      ${canEdit ? `<section class="card noprint"><h2>Link for marketing</h2><p class="lead">One link for marketing: they see this page (rides, events and impact, no names) and add their posts and results. Management sees it in their report.</p>
        ${share}<form class="inline-form" method="post" action="/report/marketing/links" style="margin-top:10px"><input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. Marketing" style="flex:1 1 200px"><button class="btn ${links.length ? "" : "primary"}">Make a link</button></form></section>` : ""}`,
    { active: "/report/marketing" }));
  }));
  app.post("/report/marketing", STAFF, wrap(async (req, res) => {
    if (req.query.remove) await MK.remove(req, actor(req)); else await MK.save(req, actor(req), null);
    setFlash(req, "ok", req.query.remove ? "Removed." : "Saved.");
    res.redirect(303, "/report/marketing?" + backQs(req) + "#log");
  }));
  app.get("/report/marketing.xlsx", READ, wrap(async (req, res) => sendXlsx(res, periodOf(req.query))));
  app.post("/report/marketing/links", STAFF, wrap(async (req, res) => {
    const label = R.clean(req.body.label).slice(0, 60);
    if (label) {
      await pool.query("INSERT INTO report_links (token, label, created_by) VALUES ($1,$2,$3)", [crypto.randomBytes(12).toString("base64url"), label, actor(req)]);
      await audit(pool, actor(req), "reportlink.create", "report_link", label, null, null);
      setFlash(req, "ok", `Link made for ${label}.`);
    }
    res.redirect("/report/marketing");
  }));
  app.post("/report/marketing/links/:id", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE report_links SET active = $2 WHERE id = $1 AND kind = 'marketing'", [+req.params.id || 0, req.body.active === "1"]);
    res.redirect("/report/marketing");
  }));

  // ----- the shared link (no sign-in)
  const linkOf = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'marketing'", [String(t || "").slice(0, 60)])).rows[0];
  const closed = (req, res) => res.status(404).send(page(req, "Report", `<section class="card"><h2>This link is switched off</h2><p class="lead">Ask the WMF team for a new one.</p></section>`, { wide: false }));
  app.get("/m/:token", limit("reportlink", 120, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), base = `/m/${encodeURIComponent(l.token)}`;
    await pool.query("UPDATE report_links SET last_used = now() WHERE id = $1", [l.id]);
    res.set("X-Robots-Tag", "noindex").send(page(req, "WMF marketing", pageHtml(await marketingData(per), { periodNav: periodNav(per, base), excelHref: `${base}/excel?${qs(per)}`, input: await inputOf(req, per, base) }), { active: "/wmf" }));
  }));
  app.post("/m/:token", limit("reportlinkpost", 200, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const by = "Marketing link: " + l.label;
    if (req.query.remove) await MK.remove(req, by); else await MK.save(req, by, l.id);
    setFlash(req, "ok", req.query.remove ? "Removed." : "Saved. Thank you!");
    res.redirect(303, `/m/${encodeURIComponent(l.token)}?` + backQs(req) + "#log");
  }));
  app.get("/m/:token/excel", limit("reportlink", 120, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    await sendXlsx(res, periodOf(req.query));
  }));
};
module.exports.marketingData = marketingData;
module.exports.workbook = workbook;
