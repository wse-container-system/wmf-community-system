"use strict";
/**
 * Marketing inputs: the page marketing works on (through their link, no sign-in) and the team can open from the
 * management report. Per WMF activation they update the numbers, feedback & impact, marketing strategy and posts;
 * everything shows in the management report. The Excel has rides, participation, events and their impact.
 */
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { pool, audit } = require("./db");
const R = require("./rules");
const { reportData, periodOf } = require("./report");
const { fmtDate, monLabel } = require("./views");
const MK = require("./mkinputs");


/** Only what marketing needs: WMF events, their participation, and the marketing behind them. */
async function marketingData(per) {
  const D = await reportData(per);
  const mk = await MK.loadInputs({ start: D.start, end: D.end });
  const events = D.done.map((a) => {
    const g = mk.byEvent.find((x) => x.act_id && x.act_id === a.id);
    return { act_id: a.id, date: a.event_date || String(a.month).slice(0, 10), dated: !!a.event_date, title: a.title, city: D.isDxb(a) ? "Dubai" : "Abu Dhabi", category: a.category,
      participants: a.participants, registrants: a.registrants, new_contacts: a.new_contacts, partners: a.partners, impact: a.impact || "", big: D.isBig(a), mk: g || null, strategy: mk.strategies.get("a:" + a.id) || "" };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const A = D.city["Abu Dhabi"], X = D.city.Dubai;
  const rideMonths = D.months.map((m) => { const a = (A.trend.find((t) => t.m === m) || {}).v || 0, d = (X.trend.find((t) => t.m === m) || {}).v || 0; return { m, auh: a, dxb: d, total: a + d, inPeriod: m >= D.start.slice(0, 7) }; });
  return { per, label: per.label, kind: per.kind, events, mk, rideMonths,
    ride: { total: D.k.rideAttendance, sessions: D.k.rideSessions, auh: A.att, dxb: X.att, auhSess: A.sess, dxbSess: X.sess },
    ev: { count: events.length, people: D.evPeople, partners: D.partners.length, registered: events.reduce((s, e) => s + (e.registrants || 0), 0) } };
}
const dayLabel = (e) => (e.dated ? fmtDate(e.date) : monLabel(String(e.date).slice(0, 7), true));

// ---------------------------------------------------------------- Excel, laid out like a dashboard
async function workbook(M) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "WMF Community System"; wb.created = new Date();
  const F = "Arial", INK = "FF15151F", MUT = "FF5D6075", BLUE = "FF4D6AE0", CARD = "FFF4F5FB", LINE = "FFE3E5EF";
  const fill = (c) => ({ type: "pattern", pattern: "solid", fgColor: { argb: c } });
  const border = { bottom: { style: "thin", color: { argb: LINE } } };
  const t = M.mk.totals;

  // ----- Dashboard
  const ws = wb.addWorksheet("Dashboard", { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 2 }, { width: 13 }, { width: 30 }, { width: 9 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 22 }, { width: 2 }];
  ws.mergeCells("B2:I2"); Object.assign(ws.getCell("B2"), { value: "WMN MOVING FWD · MARKETING REPORT", font: { name: F, size: 10, bold: true, color: { argb: BLUE } } });
  ws.mergeCells("B3:I3"); Object.assign(ws.getCell("B3"), { value: M.label, font: { name: F, size: 22, bold: true, color: { argb: INK } } });
  ws.getRow(3).height = 32;
  ws.mergeCells("B4:I4"); Object.assign(ws.getCell("B4"), { value: "Rides, participation, WMF events and their impact · Abu Dhabi & Dubai", font: { name: F, size: 10, color: { argb: MUT } } });
  const spans = [[2, 3], [4, 5], [6, 7], [8, 9]];
  const tileRow = (r0, tiles) => { tiles.forEach(([l, v, n, fmt], i) => {
    const [c1, c2] = spans[i];
    for (const r of [r0, r0 + 1, r0 + 2]) { ws.mergeCells(r, c1, r, c2); ws.getCell(r, c1).fill = fill(CARD); }
    Object.assign(ws.getCell(r0, c1), { value: l, font: { name: F, size: 10, bold: true, color: { argb: INK } }, alignment: { indent: 1, vertical: "bottom" } });
    Object.assign(ws.getCell(r0 + 1, c1), { value: v, font: { name: F, size: 22, bold: true, color: { argb: INK } }, alignment: { indent: 1, horizontal: "left" }, numFmt: fmt || "#,##0" });
    Object.assign(ws.getCell(r0 + 2, c1), { value: n, font: { name: F, size: 9, color: { argb: BLUE } }, alignment: { indent: 1, vertical: "top" } });
  }); ws.getRow(r0).height = 20; ws.getRow(r0 + 1).height = 32; ws.getRow(r0 + 2).height = 18; };
  tileRow(6, [["Rides held", M.ride.sessions, `AUH ${M.ride.auhSess} · DXB ${M.ride.dxbSess}`], ["Ride participation", M.ride.total, `AUH ${M.ride.auh} · DXB ${M.ride.dxb}`],
    ["Events", M.ev.count, `${M.ev.partners} partners`], ["Event participation", M.ev.people, M.ev.count ? `${Math.round(M.ev.people / M.ev.count)} per event on average` : ""]]);
  tileRow(10, [["Marketing reach", t.reach, `${t.actions} posts & campaigns`], ["Engagements", t.eng, t.reach ? `${((t.eng / t.reach) * 100).toFixed(1)}% engagement rate` : ""],
    ["Registered for events", M.ev.registered, "sign-ups"], ["Came to promoted events", t.attended, "events with marketing"]]);
  let row = 14;
  const section = (title) => { ws.mergeCells(row, 2, row, 9); Object.assign(ws.getCell(row, 2), { value: title, font: { name: F, size: 13, bold: true, color: { argb: INK } } }); ws.getRow(row).height = 22; row++; };
  const headRow = (cells) => { cells.forEach((x, i) => Object.assign(ws.getCell(row, 2 + i), { value: x, font: { name: F, size: 9, bold: true, color: { argb: MUT } }, border, alignment: { horizontal: i >= 2 && i <= 6 ? "right" : "left" } })); row++; };
  section("Ride participation by month");
  headRow(["Month", "", "Abu Dhabi", "Dubai", "Total", "", "", ""]);
  for (const x of M.rideMonths) {
    [monLabel(x.m, true) + (x.inPeriod ? "" : "  (earlier)"), "", x.auh, x.dxb, x.total].forEach((v, i) => { const c = ws.getCell(row, 2 + i); c.value = v; c.border = border; c.font = { name: F, size: 10, color: { argb: x.inPeriod ? INK : MUT }, bold: i === 4 }; if (i >= 2) c.numFmt = "#,##0"; });
    row++;
  }
  row++;
  section("Events & participation");
  headRow(["Date", "Event", "City", "Came", "Registered", "Reach", "Engagements", ""]);
  const r0 = row;
  for (const e of M.events) {
    const vals = [dayLabel(e), e.title, e.city === "Dubai" ? "DXB" : "AUH", e.participants, e.registrants, e.mk ? e.mk.reach : null, e.mk ? e.mk.eng : null, e.participants || 0];
    vals.forEach((v, i) => { const c = ws.getCell(row, 2 + i); c.value = v; c.border = border; c.font = { name: F, size: 10, color: { argb: i === 7 ? "FFFFFFFF" : INK }, bold: i === 1 }; if (i >= 3) c.numFmt = "#,##0"; c.alignment = { vertical: "top", wrapText: i === 1 }; });
    row++;
  }
  if (M.events.length) ws.addConditionalFormatting({ ref: `I${r0}:I${row - 1}`, rules: [{ type: "dataBar", minLength: 0, maxLength: 100, cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF5B7CF0" }, gradient: false }] });
  else { ws.getCell(row, 2).value = "No WMF events in this period."; row++; }
  ws.getCell(row + 1, 2).value = "Each event's feedback, strategy and impact: see the “Events & impact” sheet. Every post: see “Marketing”."; ws.getCell(row + 1, 2).font = { name: F, size: 9, italic: true, color: { argb: MUT } };

  // ----- Events & impact (full text)
  const es = wb.addWorksheet("Events & impact", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  es.columns = [{ header: "Date", key: "date", width: 13 }, { header: "Event", key: "title", width: 32 }, { header: "City", key: "city", width: 11 }, { header: "Type", key: "category", width: 22 },
    { header: "Came", key: "participants", width: 9 }, { header: "Registered", key: "registrants", width: 11 }, { header: "Partners", key: "partners", width: 22 },
    { header: "New contacts", key: "new_contacts", width: 12 }, { header: "Marketing strategy", key: "strategy", width: 60 }, { header: "Posts", key: "posts", width: 8 }, { header: "Reach", key: "reach", width: 10 }, { header: "Engagements", key: "eng", width: 12 }, { header: "Engagement rate", key: "rate", width: 14 },
    { header: "Feedback & impact", key: "impact", width: 70 }];
  for (const e of M.events) es.addRow({ ...e, date: dayLabel(e), partners: e.partners.join(", "), posts: e.mk ? e.mk.actions.length : null, reach: e.mk ? e.mk.reach : null, eng: e.mk ? e.mk.eng : null, rate: e.mk ? MK.rateOf(e.mk) || "" : "" });
  es.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); c.alignment = { vertical: "middle", wrapText: true }; });
  es.getRow(1).height = 22;
  es.eachRow((r, i) => { if (i === 1) return; r.eachCell((c) => { c.font = { name: F, size: 10 }; c.alignment = { vertical: "top", wrapText: true }; c.border = border; }); if (i % 2 === 0) r.eachCell((c) => { c.fill = fill(CARD); }); });

  // ----- Marketing: per event, then every post (WMF only)
  const ms = wb.addWorksheet("Marketing", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  ms.columns = [{ header: "Event", key: "title", width: 34 }, { header: "Date", key: "date", width: 13 }, { header: "Posts", key: "posts", width: 9 }, { header: "Channels", key: "ch", width: 26 },
    { header: "Reach", key: "reach", width: 11 }, { header: "Engagements", key: "eng", width: 13 }, { header: "Engagement rate", key: "rate", width: 15 }, { header: "Registered", key: "reg", width: 11 }, { header: "Came", key: "came", width: 9 }, { header: "More metrics", key: "mets", width: 40 }];
  for (const g of M.mk.byEvent) ms.addRow({ title: g.title, date: g.date ? fmtDate(g.date) : "", posts: g.actions.length,
    ch: [...g.byChannel.entries()].map(([c, x]) => `${c} (${x.n})`).join(", "), reach: g.reach, eng: g.eng,
    rate: MK.rateOf(g) || "", reg: g.key === "general" ? null : g.registrants, came: g.key === "general" ? null : g.participants,
    mets: [...g.metrics.entries()].sort((a, b) => b[1] - a[1]).map(([m, v]) => `${m} ${v}`).join("; ") });
  ms.addRow({});
  ms.addRow({ title: "Every post" }).font = { name: F, size: 11, bold: true };
  ms.addRow({ title: "Event", date: "Posted", posts: "Channel", ch: "Type", reach: "Reach", eng: "Engagements", rate: "Clicks", reg: "Sign-ups", came: "", mets: "More metrics" }).font = { name: F, size: 10, bold: true, color: { argb: MUT } };
  for (const r of M.mk.rows) ms.addRow({ title: r.ev_title || "General / brand", date: fmtDate(r.posted), posts: r.channel, ch: r.kind + (r.title ? " · " + r.title : ""), reach: r.reach, eng: r.engagements, rate: r.clicks, reg: r.signups, mets: Object.entries(r.metrics || {}).map(([k, v]) => `${k} ${v}`).join("; ") });
  ms.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); });
  return wb.xlsx.writeBuffer();
}

module.exports = function marketing(app, { need, page, setFlash, actor, wrap, limit }) {
  const READ = need("admin", "coordinator", "viewer"), STAFF = need("admin", "coordinator");
  const qs = (per) => `period=${per.type}&p=${encodeURIComponent(per.p)}`;
  const backQs = (req) => new URLSearchParams({ period: req.query.period || "month", ...(req.query.p ? { p: req.query.p } : {}) }).toString();
  /** Marketing updates an activation: numbers, feedback & impact, and its marketing strategy. */
  const saveActivation = async (req, by) => {
    const id = +req.params.id || 0, b = req.body || {};
    const num = (v) => { const x = String(v == null ? "" : v).replace(/[,\s]/g, ""); return /^\d{1,7}$/.test(x) ? +x : null; };
    const before = (await pool.query("SELECT * FROM activations WHERE id = $1", [id])).rows[0];
    if (!before) return;
    const row = { participants: num(b.participants), registrants: num(b.registrants), new_contacts: num(b.new_contacts), impact: String(b.impact || "").replace(/\r/g, "").trim().slice(0, 1500) || null };
    const numbersChanged = row.participants !== before.participants || row.registrants !== before.registrants;
    await pool.query(`UPDATE activations SET participants = $2, registrants = $3, new_contacts = $4, impact = $5, auto_sync = CASE WHEN $6 THEN false ELSE auto_sync END, updated_at = now() WHERE id = $1`,
      [id, row.participants, row.registrants, row.new_contacts, row.impact, numbersChanged]);
    await audit(pool, by, "activation.marketing", "activation", String(id), { participants: before.participants, registrants: before.registrants, new_contacts: before.new_contacts, impact: before.impact }, row);
    if (b.strategy != null) await MK.save({ body: { target: "a:" + id, strategy: b.strategy }, query: {} }, by, null);
  };
  const sendXlsx = async (res, per) => {
    const M = await marketingData(per);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", `attachment; filename="WMF-Rides-Events-Impact-${per.p}.xlsx"`).send(await workbook(M));
  };

  // ----- the team
  // one report: marketing works inside the management report
  app.get("/report/marketing", READ, (req, res) => res.redirect("/report/management?" + backQs(req) + (req.query.target || req.query.edit ? "&" + new URLSearchParams({ ...(req.query.target ? { target: req.query.target } : {}), ...(req.query.edit ? { edit: req.query.edit } : {}) }) + "#log" : "#mklinks")));
  app.post("/report/marketing", STAFF, wrap(async (req, res) => {
    if (req.query.remove) await MK.remove(req, actor(req)); else await MK.save(req, actor(req), null);
    setFlash(req, "ok", req.query.remove ? "Removed." : "Saved.");
    res.redirect(303, "/report/management?" + backQs(req) + "#log");
  }));
  app.post("/report/marketing/act/:id", STAFF, wrap(async (req, res) => {
    await saveActivation(req, actor(req));
    setFlash(req, "ok", "Saved."); res.redirect(303, "/report/management?" + backQs(req) + "&act=" + (+req.params.id || "") + "#act-" + (+req.params.id || ""));
  }));
  app.get("/report/marketing.xlsx", READ, wrap(async (req, res) => sendXlsx(res, periodOf(req.query))));
  app.post("/report/marketing/links", STAFF, wrap(async (req, res) => {
    const label = R.clean(req.body.label).slice(0, 60);
    if (label) {
      await pool.query("INSERT INTO report_links (token, label, created_by) VALUES ($1,$2,$3)", [crypto.randomBytes(12).toString("base64url"), label, actor(req)]);
      await audit(pool, actor(req), "reportlink.create", "report_link", label, null, null);
      setFlash(req, "ok", `Link made for ${label}.`);
    }
    res.redirect("/report/management?mk=1#mklinks");
  }));
  app.post("/report/marketing/links/:id", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE report_links SET active = $2 WHERE id = $1 AND kind = 'marketing'", [+req.params.id || 0, req.body.active === "1"]);
    res.redirect("/report/management?mk=1#mklinks");
  }));

  // ----- the shared link (no sign-in)
  const linkOf = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'marketing'", [String(t || "").slice(0, 60)])).rows[0];
  const closed = (req, res) => res.status(404).send(page(req, "Report", `<section class="card"><h2>This link is switched off</h2><p class="lead">Ask the WMF team for a new one.</p></section>`, { wide: false }));
  app.post("/m/:token", limit("reportlinkpost", 200, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const by = "Marketing link: " + l.label;
    if (req.query.remove) await MK.remove(req, by); else await MK.save(req, by, l.id);
    setFlash(req, "ok", req.query.remove ? "Removed." : "Saved. Thank you!");
    res.redirect(303, `/m/${encodeURIComponent(l.token)}?` + backQs(req) + "#log");
  }));
  app.post("/m/:token/act/:id", limit("reportlinkpost", 200, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    await saveActivation(req, "Marketing link: " + l.label);
    setFlash(req, "ok", "Saved. Thank you!"); res.redirect(303, `/m/${encodeURIComponent(l.token)}?` + backQs(req) + "&act=" + (+req.params.id || "") + "#act-" + (+req.params.id || ""));
  }));
  app.get("/m/:token/excel", limit("reportlink", 120, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    await sendXlsx(res, periodOf(req.query));
  }));
};
module.exports.marketingData = marketingData;
module.exports.workbook = workbook;
