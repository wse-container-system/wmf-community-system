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
const MK = require("./mkinputs");

const AUH = "#5b7cf0", DXB = "#e8833a";
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };
const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

/** Only what marketing needs: WMF events, their participation, and the marketing behind them. */
async function marketingData(per) {
  const D = await reportData(per);
  const mk = await MK.loadInputs({ start: D.start, end: D.end });
  const events = D.done.map((a) => {
    const g = mk.byEvent.find((x) => x.act_id && x.act_id === a.id);
    return { act_id: a.id, date: a.event_date || String(a.month).slice(0, 10), dated: !!a.event_date, title: a.title, city: D.isDxb(a) ? "Dubai" : "Abu Dhabi", category: a.category,
      participants: a.participants, registrants: a.registrants, partners: a.partners, impact: a.impact || "", big: D.isBig(a), mk: g || null, strategy: mk.strategies.get("a:" + a.id) || "" };
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return { per, label: per.label, kind: per.kind, events, mk,
    ev: { count: events.length, people: D.evPeople, partners: D.partners.length, registered: events.reduce((s, e) => s + (e.registrants || 0), 0) } };
}
const dayLabel = (e) => (e.dated ? fmtDate(e.date) : monLabel(String(e.date).slice(0, 7), true));

// ---------------------------------------------------------------- what each number is made of
function details(M, input) {
  const addHref = (v) => `${input.base}?${input.qs({ target: v })}#log`;
  const title = (e) => (input ? `<a href="${h(addHref("a:" + e.act_id))}" title="Add marketing for this event">${h(e.title)}</a>` : h(e.title));
  const mkCell = (e) => { const v = e.mk ? `${nf(e.mk.reach)} reach · ${nf(e.mk.eng)} eng.` : "—"; return input ? `${v} <a class="btn tblbtn" href="${h(addHref("a:" + e.act_id))}">+ Add</a>` : v; };
  const evRow = (e) => [dayLabel(e), title(e), e.city === "Dubai" ? "DXB" : "AUH", e.participants != null ? nf(e.participants) : "—", e.registrants != null ? nf(e.registrants) : "—", mkCell(e)];
  const heads = ["Date", "Event", "City", "Came", "Registered", "Marketing"];
  const hint = input ? '<p class="hint" style="margin:0 0 6px">Click an event to add its marketing: strategy, posts, reach and engagement.</p>' : "";
  return [
    { title: `Events · ${M.label}`, html: hint + mini(heads, M.events.map(evRow), { num: [3, 4], scroll: true, empty: "No WMF events this period." }) },
    { title: "Event participation, biggest first", html: hint + mini(heads, [...M.events].sort((a, b) => (b.participants || 0) - (a.participants || 0)).map(evRow), { num: [3, 4], scroll: true, empty: "No WMF events this period." }) },
    { title: `Marketing by event · ${M.label}`, html: mini(["Event", "Posts", "Reach", "Engagements", "Rate", "Came"], M.mk.byEvent.map((g) => [h(g.title), nf(g.actions.length), nf(g.reach), nf(g.eng), MK.rateOf(g) || "—", g.key === "general" ? "—" : g.participants != null ? nf(g.participants) : "—"]), { num: [1, 2, 3, 4, 5], empty: "No marketing logged yet." }) },
    { title: `Every post · ${M.label}`, html: mini(["Posted", "Event", "Channel", "Reach", "Engagements"], M.mk.rows.map((r) => [fmtDate(r.posted), h(r.ev_title || "General / brand"), h(r.channel), nf(r.reach), nf(r.engagements)]), { num: [3, 4], scroll: true, empty: "No marketing logged yet." }) },
  ];
}

// ---------------------------------------------------------------- events and participation graph
function eventChart(M) {
  if (!M.events.length) return '<p class="muted">No WMF events in this period.</p>';
  const max = Math.max(1, ...M.events.map((e) => Math.max(e.participants || 0, e.registrants || 0)));
  const rows = [...M.events].reverse().map((e) => `<div class="ev-bar"><span class="ev-bar-l" title="${h(e.title)}">${h(e.title)} <span class="muted">${dayLabel(e)}</span></span>
    <span class="ev-bar-t">${e.registrants ? `<i style="width:${(e.registrants / max) * 100}%;background:#c9d4fb"></i>` : ""}<i style="width:${((e.participants || 0) / max) * 100}%;background:${e.city === "Dubai" ? DXB : AUH}"></i></span>
    <span class="ev-bar-v"><b>${e.participants != null ? nf(e.participants) : "—"}</b> came${e.registrants ? ` of ${nf(e.registrants)} registered` : ""}${e.mk && e.mk.reach ? ` · <span class="muted">${nf(e.mk.reach)} reach</span>` : ""}</span></div>`).join("");
  return `<ul class="legend"><li><i style="background:${AUH}"></i>Came (Abu Dhabi)</li><li><i style="background:${DXB}"></i>Came (Dubai)</li><li><i style="background:#c9d4fb"></i>Registered</li></ul><div class="ev-bars">${rows}</div>`;
}

// ---------------------------------------------------------------- events with their marketing
function eventCards(M, input) {
  const groups = M.mk.byEvent.filter((g) => g.key !== "general"), mx = MK.maxes(groups);
  const add = (v) => (input ? `<a class="btn tblbtn mk-ev-add noprint" href="${input.base}?${input.qs({ target: v })}#log">+ Add marketing</a>` : "");
  const link = (v, t) => (input ? `<a href="${input.base}?${input.qs({ target: v })}#log">${h(t)}</a>` : h(t));
  const cards = M.events.map((e) => ({ d: String(e.date), html: `<article class="mk-ev ${e.city === "Dubai" ? "dxb" : "auh"}">
      <div class="mk-ev-top"><span class="badge">${h(e.city)} · ${h(e.category)}</span><span class="muted">${dayLabel(e)}</span></div>
      <h3>${link("a:" + e.act_id, e.title)}</h3>
      <p class="mk-n"><b>${e.participants != null ? nf(e.participants) : "—"}</b> participants${e.registrants ? ` · ${nf(e.registrants)} registered` : ""}${e.partners.length ? ` · with ${h(e.partners.join(", "))}` : ""}</p>
      ${e.strategy ? MK.strategyHtml(e.strategy) : ""}${e.impact ? `<p class="mk-impact">${h(cut(e.impact, 320))}</p>` : ""}${e.mk ? MK.funnel(e.mk, mx) : ""}${add("a:" + e.act_id)}</article>` }));
  // marketing for WMF events not yet held (coming up)
  for (const g of groups.filter((x) => !M.events.some((e) => e.mk === x))) cards.push({ d: String(g.date), html: `<article class="mk-ev ${g.city === "Dubai" ? "dxb" : "auh"}">
      <div class="mk-ev-top"><span class="badge">${h(g.city || "WMF")} · WMF event</span><span class="muted">${g.date ? fmtDate(g.date) : ""}</span></div>
      <h3>${h(g.title)}</h3>${g.strategy ? MK.strategyHtml(g.strategy) : ""}${MK.funnel(g, mx)}${add(g.act_id ? "a:" + g.act_id : "e:" + g.actions[0].activity_id)}</article>` });
  cards.sort((a, b) => b.d.localeCompare(a.d));
  return cards.length ? `<div class="mk-events">${cards.map((c) => c.html).join("")}</div>` : "";
}

// ---------------------------------------------------------------- page
function pageHtml(M, { periodNav, excelHref, staff, input }) {
  const t = M.mk.totals;
  const tiles = [["Events", nf(M.ev.count), M.ev.partners ? `${M.ev.partners} partner${M.ev.partners === 1 ? "" : "s"}` : ""],
    ["Event participation", nf(M.ev.people), M.ev.count ? `${Math.round(M.ev.people / M.ev.count)} per event on average` : ""],
    ["Marketing reach", nf(t.reach), t.actions ? `${nf(t.actions)} posts & campaigns` : "Nothing logged yet"],
    ["Engagements", nf(t.eng), t.reach ? `${((t.eng / t.reach) * 100).toFixed(1)}% engagement rate` : ""]];
  const others = input && M.mk.others.length ? `<section class="card c12"><h2>Other events &amp; activities</h2><p class="lead">Marketing for events WMF didn't run. Kept here for marketing only: not counted in any report.</p>
      ${mini(["Event", "Date", "Posts", "Reach", "Engagements", "People there"], M.mk.others.map((g) => [h(g.title), g.date ? fmtDate(g.date) : "—", nf(g.actions.length), nf(g.reach), nf(g.eng), g.participants != null ? nf(g.participants) : "—"]), { num: [2, 3, 4, 5] })}</section>` : "";
  const dd = details(M, input);
  return `<section class="mk-head"><div><div class="wc-eyebrow">WMN Moving FWD · marketing</div><h2 class="ov-title">${h(M.label)}</h2>
      <p class="lead" style="margin:4px 0 0">WMF events: who came, the marketing strategy behind each one, and how far it reached.</p></div>
      <div class="mk-actions">${periodNav}<a class="btn primary" href="${h(excelHref)}">Download Excel</a></div></section>
    ${detailTiles(tiles.map(([l, v, n], i) => ({ label: l, value: v, note: h(n), detail: dd[i] })))}
    <div class="grid">
      <section class="card c12"><h2>Events &amp; participation</h2><p class="lead">${M.ev.count ? `${nf(M.ev.count)} event${M.ev.count === 1 ? "" : "s"}, ${nf(M.ev.people)} participants${M.ev.registered ? ` from ${nf(M.ev.registered)} registered` : ""}.` : ""}</p>${eventChart(M)}</section>
      <section class="card c12"><h2>Events &amp; impact</h2><p class="lead">Each event's marketing strategy, its posts, and the result.${input ? " Click an event or “+ Add marketing” to add to it." : ""}</p>
        ${MK.totalsHtml(M.mk)}
        ${eventCards(M, input)}${MK.generalLine(M.mk)}</section>
      ${input ? MK.formHtml(input) + others + MK.logHtml(M.mk, { base: input.base, qs: input.qs, label: M.label }) : ""}
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
  const t = M.mk.totals;

  // ----- Dashboard
  const ws = wb.addWorksheet("Dashboard", { views: [{ showGridLines: false }], pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 } });
  ws.columns = [{ width: 2 }, { width: 13 }, { width: 30 }, { width: 9 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 22 }, { width: 2 }];
  ws.mergeCells("B2:I2"); Object.assign(ws.getCell("B2"), { value: "WMN MOVING FWD · MARKETING REPORT", font: { name: F, size: 10, bold: true, color: { argb: BLUE } } });
  ws.mergeCells("B3:I3"); Object.assign(ws.getCell("B3"), { value: M.label, font: { name: F, size: 22, bold: true, color: { argb: INK } } });
  ws.getRow(3).height = 32;
  ws.mergeCells("B4:I4"); Object.assign(ws.getCell("B4"), { value: "WMF events: participation, marketing strategy and reach · Abu Dhabi & Dubai", font: { name: F, size: 10, color: { argb: MUT } } });
  const tiles = [["Events", M.ev.count, `${M.ev.partners} partners`], ["Event participation", M.ev.people, M.ev.count ? `${Math.round(M.ev.people / M.ev.count)} per event on average` : ""],
    ["Marketing reach", t.reach, `${t.actions} posts & campaigns`], ["Engagements", t.eng, t.reach ? `${((t.eng / t.reach) * 100).toFixed(1)}% engagement rate` : ""]];
  const spans = [[2, 3], [4, 5], [6, 7], [8, 9]];
  tiles.forEach(([l, v, n], i) => {
    const [c1, c2] = spans[i];
    for (const r of [6, 7, 8]) { ws.mergeCells(r, c1, r, c2); ws.getCell(r, c1).fill = fill(CARD); }
    Object.assign(ws.getCell(6, c1), { value: l, font: { name: F, size: 10, bold: true, color: { argb: INK } }, alignment: { indent: 1, vertical: "bottom" } });
    Object.assign(ws.getCell(7, c1), { value: v, font: { name: F, size: 24, bold: true, color: { argb: INK } }, alignment: { indent: 1, horizontal: "left" }, numFmt: "#,##0" });
    Object.assign(ws.getCell(8, c1), { value: n, font: { name: F, size: 9, color: { argb: BLUE } }, alignment: { indent: 1, vertical: "top" } });
  });
  ws.getRow(6).height = 22; ws.getRow(7).height = 36; ws.getRow(8).height = 20;
  let row = 10;
  ws.mergeCells(row, 2, row, 9); Object.assign(ws.getCell(row, 2), { value: "Events & participation", font: { name: F, size: 13, bold: true, color: { argb: INK } } }); ws.getRow(row).height = 22; row++;
  ["Date", "Event", "City", "Came", "Registered", "Reach", "Engagements", ""].forEach((x, i) => Object.assign(ws.getCell(row, 2 + i), { value: x, font: { name: F, size: 9, bold: true, color: { argb: MUT } }, border, alignment: { horizontal: i >= 3 && i <= 6 ? "right" : "left" } }));
  row++;
  const r0 = row;
  for (const e of M.events) {
    const vals = [dayLabel(e), e.title, e.city === "Dubai" ? "DXB" : "AUH", e.participants, e.registrants, e.mk ? e.mk.reach : null, e.mk ? e.mk.eng : null, e.participants || 0];
    vals.forEach((v, i) => { const c = ws.getCell(row, 2 + i); c.value = v; c.border = border; c.font = { name: F, size: 10, color: { argb: i === 7 ? "FFFFFFFF" : INK }, bold: i === 1 }; if (i >= 3) c.numFmt = "#,##0"; c.alignment = { vertical: "top", wrapText: i === 1 }; });
    row++;
  }
  if (M.events.length) ws.addConditionalFormatting({ ref: `I${r0}:I${row - 1}`, rules: [{ type: "dataBar", minLength: 0, maxLength: 100, cfvo: [{ type: "num", value: 0 }, { type: "max" }], color: { argb: "FF5B7CF0" }, gradient: false }] });
  else { ws.getCell(row, 2).value = "No WMF events in this period."; row++; }
  ws.getCell(row + 1, 2).value = "Each event's strategy and impact: see the “Events & impact” sheet. Every post: see “Marketing”."; ws.getCell(row + 1, 2).font = { name: F, size: 9, italic: true, color: { argb: MUT } };

  // ----- Events & impact (full text)
  const es = wb.addWorksheet("Events & impact", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  es.columns = [{ header: "Date", key: "date", width: 13 }, { header: "Event", key: "title", width: 32 }, { header: "City", key: "city", width: 11 }, { header: "Type", key: "category", width: 22 },
    { header: "Came", key: "participants", width: 9 }, { header: "Registered", key: "registrants", width: 11 }, { header: "Partners", key: "partners", width: 22 },
    { header: "Marketing strategy", key: "strategy", width: 60 }, { header: "Posts", key: "posts", width: 8 }, { header: "Reach", key: "reach", width: 10 }, { header: "Engagements", key: "eng", width: 12 }, { header: "Engagement rate", key: "rate", width: 14 },
    { header: "Impact", key: "impact", width: 70 }];
  for (const e of M.events) es.addRow({ ...e, date: dayLabel(e), partners: e.partners.join(", "), posts: e.mk ? e.mk.actions.length : null, reach: e.mk ? e.mk.reach : null, eng: e.mk ? e.mk.eng : null, rate: e.mk ? MK.rateOf(e.mk) || "" : "" });
  es.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); c.alignment = { vertical: "middle", wrapText: true }; });
  es.getRow(1).height = 22;
  es.eachRow((r, i) => { if (i === 1) return; r.eachCell((c) => { c.font = { name: F, size: 10 }; c.alignment = { vertical: "top", wrapText: true }; c.border = border; }); if (i % 2 === 0) r.eachCell((c) => { c.fill = fill(CARD); }); });

  // ----- Marketing: per event, then every post (WMF only)
  const ms = wb.addWorksheet("Marketing", { views: [{ state: "frozen", ySplit: 1, showGridLines: false }] });
  ms.columns = [{ header: "Event", key: "title", width: 34 }, { header: "Date", key: "date", width: 13 }, { header: "Posts", key: "posts", width: 9 }, { header: "Channels", key: "ch", width: 26 },
    { header: "Reach", key: "reach", width: 11 }, { header: "Engagements", key: "eng", width: 13 }, { header: "Engagement rate", key: "rate", width: 15 }, { header: "Registered", key: "reg", width: 11 }, { header: "Came", key: "came", width: 9 }];
  for (const g of M.mk.byEvent) ms.addRow({ title: g.title, date: g.date ? fmtDate(g.date) : "", posts: g.actions.length, ch: [...g.channels].join(", "), reach: g.reach, eng: g.eng,
    rate: MK.rateOf(g) || "", reg: g.key === "general" ? null : g.registrants, came: g.key === "general" ? null : g.participants });
  ms.addRow({});
  ms.addRow({ title: "Every post" }).font = { name: F, size: 11, bold: true };
  ms.addRow({ title: "Event", date: "Posted", posts: "Channel", ch: "Type", reach: "Reach", eng: "Engagements", rate: "Clicks", reg: "Sign-ups" }).font = { name: F, size: 10, bold: true, color: { argb: MUT } };
  for (const r of M.mk.rows) ms.addRow({ title: r.ev_title || "General / brand", date: fmtDate(r.posted), posts: r.channel, ch: r.kind + (r.title ? " · " + r.title : ""), reach: r.reach, eng: r.engagements, rate: r.clicks, reg: r.signups });
  ms.getRow(1).eachCell((c) => { c.font = { name: F, size: 10, bold: true, color: { argb: "FFFFFFFF" } }; c.fill = fill(BLUE); });
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
    return { base, qs: q, tg: await MK.targets(), strategies: await MK.loadStrategies(), editing: await MK.editRow(req.query.edit), pre: /^(a:\d+|e:.+|o)$/.test(pre) ? pre : "", cancelHref: `${base}?${q({})}#log` };
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
