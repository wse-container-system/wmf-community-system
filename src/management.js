"use strict";
/**
 * One-page management report (monthly, quarterly, annual) in the layout of the template management sent:
 * key developments / wins / misses / forward view, rides table, community activations, corporate & marketing,
 * cross collaborations, closing note and priorities. Figures fill in by themselves; the words start as a
 * suggested draft that the team edits and saves per period.
 */
const { pool } = require("./db");
const E = require("./engine");
const { reportData, periodOf } = require("./report");
const { fmtPct } = require("./social");
const { h, fmtDate, monLabel, nf } = require("./views");

const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
const FIELDS = [["developments", "Key developments"], ["wins", "Key execution wins"], ["misses", "Key execution misses"], ["forward", "Forward view"],
  ["social", "Social media campaigns"], ["marketing", "Marketing highlights"], ["sponsor", "Sponsor activations"], ["closing", "Closing note"], ["priorities", "Priorities"]];

function words(per) {
  const H = E.helpers;
  if (per.type === "quarter") { const y = +per.p.slice(0, 4), q = +per.p.slice(-1); const nq = q === 4 ? `Q1 ${y + 1}` : `Q${q + 1} ${y}`; return { unit: "quarter", kind: "Quarterly", next: nq, prevName: "last quarter" }; }
  if (per.type === "year") return { unit: "year", kind: "Annual", next: String(+per.p + 1), prevName: String(+per.p - 1) };
  const nm = H.addMonths(per.p, 1);
  return { unit: "month", kind: "Monthly", next: monLabel(nm, true).split(" ")[0], prevName: monLabel(H.addMonths(per.p, -1), true).split(" ")[0] };
}

/** The suggested words, written from the figures in a positive, factual voice. One line per point. */
function drafts(D) {
  const W = words(D.per), k = D.k, A = D.city["Abu Dhabi"], X = D.city.Dubai;
  const dev = [
    `Community at ${nf(D.db.total)} members, with ${nf(k.newMembers)} new in this ${W.unit}.`,
    `${nf(k.rideAttendance)} ride participations across ${nf(k.rideSessions)} rides in Abu Dhabi and Dubai.`,
    D.done.length ? `${D.done.length} community activation${D.done.length === 1 ? "" : "s"}${D.partners.length ? ` with ${D.partners.length} partner${D.partners.length === 1 ? "" : "s"}` : ""}, reaching ${nf(D.evPeople)} participants.` : null,
  ].filter(Boolean);
  const wins = [];
  const ch = pct(k.rideAttendance, D.prev.rideAttendance);
  if (ch > 0) wins.push(`Ride participation up ${ch}% on ${W.prevName} (${nf(k.rideAttendance)}).`);
  if (D.spotlight && D.spotlight.participants) wins.push(`${D.spotlight.title}: ${nf(D.spotlight.participants)} participants${D.spotlight.partners.length ? ` with ${D.spotlight.partners.join(", ")}` : ""}${D.spotlight.new_contacts ? `, ${nf(D.spotlight.new_contacts)} new contacts` : ""}.`);
  const best = [A, X].filter((c) => c.top).sort((a, b) => b.top.perSession - a.top.perSession)[0];
  if (best) wins.push(`${best.top.name} ${best === X ? "(Dubai)" : "(Abu Dhabi)"} averaging ${Math.round(best.top.perSession)} riders per ride.`);
  if (D.soc) { const o = []; for (const c of ["whatsapp", "strava"]) for (const city of ["Abu Dhabi", "Dubai"]) if (D.soc[c][city].pct != null) o.push([c, city, D.soc[c][city].pct]); const b = o.sort((a, b) => b[2] - a[2])[0]; if (b && b[2] > 0) wins.push(`${b[0] === "whatsapp" ? "WhatsApp" : "Strava"} community in ${b[1]} grew ${fmtPct(b[2])}.`); }
  if (D.survey.avg && D.survey.avg >= 4.3) wins.push(`Participants rated events ${D.survey.avg.toFixed(1)} / 5.`);
  if (k.newMembers > (D.prev.newMembers || 0) && wins.length < 4) wins.push(`${nf(k.newMembers)} new members joined, against ${nf(D.prev.newMembers || 0)} in ${W.prevName}.`);
  const misses = [];
  for (const [name, c] of [["Abu Dhabi", A], ["Dubai", X]]) { const p = pct(c.att, c.prevAtt); if (p != null && p <= -5) misses.push(`${name} ride participation down ${Math.abs(p)}% on ${W.prevName} (${nf(c.att)} vs ${nf(c.prevAtt)}).`); }
  const low = D.done.filter((a) => a.registrants >= 5 && a.participants != null && a.participants / a.registrants < 0.6)[0];
  if (low) misses.push(`${low.title}: ${nf(low.participants)} of ${nf(low.registrants)} registered attended. Reminder messages before events to lift turnout.`);
  const canc = D.corp.filter((c) => c.cancelled);
  if (canc.length) misses.push(`${canc.map((c) => `${c.name} ${c.cancelled}`).join(", ")} corporate session${canc.reduce((a, c) => a + c.cancelled, 0) === 1 ? "" : "s"} cancelled.`);
  if (!misses.length) misses.push("No major misses.");
  const own = D.upcoming.filter((u) => u.category === "wmf_event");
  const fwd = (own.length ? own.concat(D.upcoming.filter((u) => u.category !== "wmf_event")) : D.upcoming).slice(0, 4).map((u) => `${fmtDate(u.d).replace(/ \d{4}$/, "")}: ${u.title}`);
  const closing = `WMF continues to grow as the UAE's women's cycling community: ${nf(k.rideAttendance)} ride participations${D.done.length ? `, ${D.done.length} activations` : ""} and ${nf(k.newMembers)} new members this ${W.unit}${D.partners.length ? `, with partners such as ${D.partners.slice(0, 2).map((p) => p.name).join(" and ")}` : ""}.`;
  const prio = (D.notes.next_steps || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (!prio.length) {
    if (X.share < 25) prio.push("Grow Dubai participation.");
    prio.push("Turn event sign-ups and first-time riders into regular riders.");
    if (D.upcoming[0]) prio.push(`Deliver ${D.upcoming[0].title}.`);
  }
  const sponsor = D.partners.slice(0, 3).map((p) => `${p.name} (${cut(p.items[0], 40)})`);
  return { developments: dev.join("\n"), wins: wins.slice(0, 4).join("\n"), misses: misses.slice(0, 3).join("\n"), forward: fwd.join("\n") || (D.notes.next_steps || ""),
    social: "", marketing: "", sponsor: sponsor.join("\n"), closing, priorities: prio.slice(0, 3).join("\n") };
}

/** Everything on the page: figures plus the words (saved, or the draft). */
async function mgmtData(per) {
  const D = await reportData(per);
  const W = words(per), draft = drafts(D), saved = D.notes.mgmt || {};
  const T = Object.fromEntries(FIELDS.map(([f]) => [f, saved[f] != null ? saved[f] : draft[f]]));
  const A = D.city["Abu Dhabi"], X = D.city.Dubai;
  const comment = (c) => (c.top ? `Most attended: ${c.top.name} (${Math.round(c.top.perSession)} avg)` : c.sess ? "" : "No rides recorded");
  const rides = [
    { type: "AUH Community Rides", n: A.sess, avg: A.avg, fresh: A.fresh, comment: comment(A) },
    { type: "DXB Community Rides", n: X.sess, avg: X.avg, fresh: X.fresh, comment: comment(X) },
    ...D.corp.map((c) => ({ type: `Corporate: ${c.name}`, n: c.sessions, avg: c.avg, fresh: c.fresh, comment: cut(c.kinds.map((x) => `${x.kind} ${x.n}`).join(" · ") + (c.cancelled ? ` · ${c.cancelled} cancelled` : ""), 60) })),
    { type: "Community events", n: D.done.length, avg: D.done.length ? D.evPeople / D.done.length : null, fresh: D.done.reduce((a, x) => a + (x.new_contacts || 0), 0) || null, comment: D.done.length ? `${nf(D.evPeople)} participants in total` : "" },
  ];
  const acts = [...D.done].filter((a) => !D.isBig(a)).sort((a, b) => (b.participants || 0) - (a.participants || 0)).slice(0, 4)
    .map((a) => ({ name: a.title, people: a.participants != null ? `${nf(a.participants)} participants${a.registrants ? ` · ${nf(a.registrants)} registered` : ""}` : "—", note: cut(a.impact || a.aim || "", 120) }));
  const collab = D.partners.slice(0, 4).map((p) => ({ name: p.name, event: cut(p.items.join(", "), 50), note: cut(p.impact, 80) || (p.people ? `${nf(p.people)} people reached` : "") }));
  const s = D.soc, sc = (ch, c) => (s && s[ch][c].now != null ? `${nf(s[ch][c].now)}${s[ch][c].pct != null ? ` (${fmtPct(s[ch][c].pct)})` : ""}` : "—");
  return { per, W, T, draft, saved, rides, acts, collab, social: { strava: [sc("strava", "Abu Dhabi"), sc("strava", "Dubai")], whatsapp: [sc("whatsapp", "Abu Dhabi"), sc("whatsapp", "Dubai")] },
    community: D.done.length ? `${D.done.length} activation${D.done.length === 1 ? "" : "s"} · ${nf(D.evPeople)} participants` : "—" };
}

// ---------------------------------------------------------------- the page (16:9, prints as one page)
const lines = (t) => String(t || "").split(/\n+/).map((x) => x.trim()).filter(Boolean);
const bullets = (t, n = 160) => { const l = lines(t); return l.length > 1 ? `<ul>${l.map((x) => `<li>${h(cut(x, n))}</li>`).join("")}</ul>` : l.length ? h(cut(l[0], n * 2)) : '<span class="mg-empty">—</span>'; };
function sheet(M) {
  const per = M.per, avg = (v) => (v == null ? "—" : nf(Math.round(v)));
  return `<section class="mg-page">
    <header class="mg-top"><b>AURORA</b><span>|</span><b>Women Moving Forward</b><span>|</span><span class="mg-light">${h(M.W.kind)} Report</span><span>|</span><b>${h(per.label)}</b></header>
    <div class="mg-body">
      <div class="mg-col">
        <table class="mg-keys">${[["developments", "Key Developments"], ["wins", "Key Execution Wins"], ["misses", "Key Execution Misses"], ["forward", `Forward View (Next ${M.W.unit === "month" ? "Month" : M.W.unit === "quarter" ? "Quarter" : "Year"})`]]
          .map(([f, l]) => `<tr><th>${h(l)}</th><td>${bullets(M.T[f])}</td></tr>`).join("")}</table>
        <table class="mg-t"><thead><tr><th>Ride Type</th><th>No. of rides</th><th>Avg. no. of riders</th><th>New riders</th><th>Comment</th></tr></thead><tbody>
          ${M.rides.map((r) => `<tr><td>${h(r.type)}</td><td class="n">${r.n ? nf(r.n) : "—"}</td><td class="n">${avg(r.avg)}</td><td class="n">${r.fresh != null ? nf(r.fresh) : "—"}</td><td>${h(r.comment)}</td></tr>`).join("")}</tbody></table>
        <div class="mg-bar">CLOSING &amp; NEXT ${M.W.unit.toUpperCase()} PRIORITIES</div>
        <div class="mg-close"><p><b>Closing note:</b> ${h(cut(M.T.closing, 260))}</p><div><b>${h(M.W.next)} priorities:</b> ${bullets(M.T.priorities, 110)}</div></div>
      </div>
      <div class="mg-col">
        <div class="mg-bar">COMMUNITY ACTIVATIONS</div>
        <table class="mg-t"><thead><tr><th>Event / Activation</th><th>Participants</th><th>Feedback / Notes</th></tr></thead><tbody>
          ${M.acts.map((a) => `<tr><td>${h(a.name)}</td><td>${h(a.people)}</td><td>${h(a.note)}</td></tr>`).join("") || '<tr><td colspan="3" class="mg-empty">No activations recorded.</td></tr>'}</tbody></table>
        <div class="mg-bar">CORPORATE RIDES &amp; MARKETING</div>
        <table class="mg-kv">
          <tr><th>Social Media Campaigns</th><td>${bullets(M.T.social, 90)}</td></tr><tr><th>Marketing Highlights</th><td>${bullets(M.T.marketing, 90)}</td></tr>
          <tr><th>Sponsor Activations</th><td>${bullets(M.T.sponsor, 90)}</td></tr><tr><th>Community Activations</th><td>${h(M.community)}</td></tr>
          <tr><th>Strava Followers</th><td><b>AUH Strava:</b> ${h(M.social.strava[0])} <span class="mg-sep">|</span> <b>DXB Strava:</b> ${h(M.social.strava[1])}</td></tr>
          <tr><th>WhatsApp Members</th><td><b>AUH WhatsApp:</b> ${h(M.social.whatsapp[0])} <span class="mg-sep">|</span> <b>DXB WhatsApp:</b> ${h(M.social.whatsapp[1])}</td></tr></table>
        <table class="mg-t mg-collab"><thead><tr><th>Cross collaborations</th><th>Event</th><th>Comment</th></tr></thead><tbody>
          ${M.collab.map((c) => `<tr><td>${h(c.name)}</td><td>${h(c.event)}</td><td>${h(c.note)}</td></tr>`).join("") || '<tr><td colspan="3" class="mg-empty">No collaborations this period.</td></tr>'}</tbody></table>
      </div>
    </div>
    <footer class="mg-foot"><span>AURORA | Confidential | ${h(M.W.kind)} Report</span><span>WMF Community System · ${h(fmtDate(new Date().toISOString().slice(0, 10)))}</span></footer></section>`;
}

// ---------------------------------------------------------------- PowerPoint in the same layout
async function pptx(M) {
  const PPT = require("pptxgenjs");
  const p = new PPT(); p.layout = "LAYOUT_WIDE"; p.title = `WMF ${M.W.kind} Report ${M.per.label}`;
  const NAVY = "1D4E77", BLUE = "2E86C1", LIGHT = "EAF3FB", INK = "1F2937", F = "Arial";
  const s = p.addSlide(); s.background = { color: "FFFFFF" };
  s.addShape(p.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.55, fill: { color: NAVY }, line: { color: NAVY } });
  s.addText([{ text: "AURORA", options: { bold: true, fontSize: 18 } }, { text: "    |   Women Moving Forward   |   ", options: { fontSize: 11, bold: true } }, { text: `${M.W.kind} Report`, options: { fontSize: 11 } }, { text: `   |   ${M.per.label}`, options: { fontSize: 11, bold: true } }],
    { x: 0.3, y: 0.05, w: 12.7, h: 0.45, fontFace: F, color: "FFFFFF", valign: "middle" });
  const cell = (t, o = {}) => ({ text: String(t == null ? "" : t), options: { fontFace: F, fontSize: 7.5, color: INK, valign: "middle", border: { type: "solid", pt: 0.5, color: "C9D6E3" }, margin: 0.04, ...o } });
  const head = (t) => cell(t, { bold: true, color: "FFFFFF", fill: { color: BLUE } });
  const txt = (t, n) => lines(t).map((x) => "• " + cut(x, n)).join("\n") || "—";
  const unit = M.W.unit === "month" ? "Month" : M.W.unit === "quarter" ? "Quarter" : "Year";
  // left column
  s.addTable([["developments", "Key Developments"], ["wins", "Key Execution Wins"], ["misses", "Key Execution Misses"], ["forward", `Forward View (Next ${unit})`]]
    .map(([f, l]) => [cell(l, { bold: true, fill: { color: LIGHT } }), cell(txt(M.T[f], 150))]), { x: 0.1, y: 0.62, w: 6.5, colW: [1.2, 5.3] });
  s.addTable([["Ride Type", "No. of rides", "Avg. no. of riders", "New riders", "Comment"].map(head),
    ...M.rides.map((r) => [cell(r.type), cell(r.n || "—", { align: "center" }), cell(r.avg == null ? "—" : Math.round(r.avg), { align: "center" }), cell(r.fresh == null ? "—" : r.fresh, { align: "center" }), cell(r.comment)])],
  { x: 0.1, y: 3.35, w: 6.5, colW: [1.55, 0.75, 0.85, 0.75, 2.6] });
  s.addText(`CLOSING & NEXT ${M.W.unit.toUpperCase()} PRIORITIES`, { x: 0.1, y: 5.55, w: 6.5, h: 0.3, fill: { color: BLUE }, color: "FFFFFF", bold: true, fontFace: F, fontSize: 9 });
  s.addText([{ text: "Closing note: ", options: { bold: true } }, { text: cut(M.T.closing, 260) + "\n" }, { text: `${M.W.next} priorities: `, options: { bold: true } }, { text: lines(M.T.priorities).map((x) => cut(x, 110)).join(" · ") || "—" }],
    { x: 0.1, y: 5.9, w: 6.5, h: 1.15, fontFace: F, fontSize: 8, color: INK, valign: "top" });
  // right column
  s.addText("COMMUNITY ACTIVATIONS", { x: 6.75, y: 0.62, w: 6.5, h: 0.3, fill: { color: BLUE }, color: "FFFFFF", bold: true, fontFace: F, fontSize: 9 });
  s.addTable([["Event / Activation", "Participants", "Feedback / Notes"].map(head), ...(M.acts.length ? M.acts.map((a) => [cell(a.name), cell(a.people), cell(a.note)]) : [[cell("No activations recorded."), cell(""), cell("")]])],
    { x: 6.75, y: 0.95, w: 6.5, colW: [1.9, 1.5, 3.1] });
  s.addText("CORPORATE RIDES & MARKETING", { x: 6.75, y: 3.05, w: 6.5, h: 0.3, fill: { color: BLUE }, color: "FFFFFF", bold: true, fontFace: F, fontSize: 9 });
  s.addTable([["Social Media Campaigns", txt(M.T.social, 90)], ["Marketing Highlights", txt(M.T.marketing, 90)], ["Sponsor Activations", txt(M.T.sponsor, 90)], ["Community Activations", M.community],
    ["Strava Followers", `AUH Strava: ${M.social.strava[0]}   |   DXB Strava: ${M.social.strava[1]}`], ["WhatsApp Members", `AUH WhatsApp: ${M.social.whatsapp[0]}   |   DXB WhatsApp: ${M.social.whatsapp[1]}`]]
    .map(([a, b]) => [cell(a, { bold: true, fill: { color: LIGHT } }), cell(b)]), { x: 6.75, y: 3.38, w: 6.5, colW: [1.7, 4.8] });
  s.addTable([["Cross collaborations", "Event", "Comment"].map(head), ...(M.collab.length ? M.collab.map((c) => [cell(c.name), cell(c.event), cell(c.note)]) : [[cell("None this period."), cell(""), cell("")]])],
    { x: 6.75, y: 5.45, w: 6.5, colW: [1.9, 1.9, 2.7] });
  s.addShape(p.ShapeType.rect, { x: 0, y: 7.2, w: 13.33, h: 0.3, fill: { color: NAVY }, line: { color: NAVY } });
  s.addText(`AURORA  |  Confidential  |  ${M.W.kind} Report`, { x: 0.3, y: 7.2, w: 8, h: 0.3, fontFace: F, fontSize: 7, color: "FFFFFF", valign: "middle" });
  return p.write({ outputType: "nodebuffer" });
}

// ---------------------------------------------------------------- routes
module.exports = function management(app, { need, page, setFlash, actor, user, wrap }) {
  const READ = need("admin", "coordinator", "viewer"), STAFF = need("admin", "coordinator");
  const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
  const qs = (per) => `period=${per.type}&p=${encodeURIComponent(per.p)}`;
  app.get("/report/management", READ, wrap(async (req, res) => {
    const per = periodOf(req.query), M = await mgmtData(per), H = E.helpers, today = new Date().toISOString().slice(0, 10), opts = [];
    if (per.type === "month") for (const m of H.monthsBetween("2025-01", today.slice(0, 7)).reverse()) opts.push([m, monLabel(m, true)]);
    if (per.type === "quarter") for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) opts.push([`${y}-Q${q}`, `Q${q} ${y}`]);
    if (per.type === "year") for (let y = +today.slice(0, 4); y >= 2025; y--) opts.push([String(y), String(y)]);
    const canEdit = ["admin", "coordinator"].includes(user(req).role);
    res.send(page(req, "Management report", `
      <section class="card noprint"><div class="card-head"><div><h2>Management report · ${h(per.label)}</h2><p class="lead">One page, in management's template. The figures fill in by themselves; the words start as a suggested draft you can rewrite.</p></div>
        <div class="toolbar" style="margin:0"><button class="btn" data-print>Save as PDF</button><a class="btn primary" href="/report/management.pptx?${qs(per)}">Download PowerPoint</a></div></div>
        <div class="toolbar" style="gap:12px;margin:4px 0 0;align-items:center"><span class="seg">${Object.keys(KIND).map((t) => `<a href="/report/management?period=${t}" class="${per.type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
          <form method="get" style="margin:0"><input type="hidden" name="period" value="${per.type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="Period">${opts.map(([v, l]) => `<option value="${v}" ${v === per.p ? "selected" : ""}>${h(l)}</option>`).join("")}</select></form>
          <a href="/report?${qs(per)}">Full report</a></div>
        ${canEdit ? `<details class="mg-edit" ${req.query.edit ? "open" : ""}><summary><b>Edit the words</b> <span class="muted">(one point per line)</span></summary>
          <form class="form" method="post" action="/report/management/notes"><input type="hidden" name="period" value="${h(per.key)}"><input type="hidden" name="back" value="/report/management?${qs(per)}">
            <div class="mg-fields">${FIELDS.map(([f, l]) => `<label>${h(l === "Priorities" ? `${M.W.next} priorities` : l)}${M.saved[f] == null ? ' <span class="badge">Suggested</span>' : ""}<textarea name="${f}" rows="${f === "closing" ? 3 : 4}" maxlength="1200">${h(M.T[f])}</textarea></label>`).join("")}</div>
            <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn" name="reset" value="1" data-confirm="Go back to the suggested text for every box?">Back to the suggested text</button></div></form></details>` : ""}</section>
      <div class="mg-wrap">${sheet(M)}</div>`, { active: "/report" }));
  }));
  app.post("/report/management/notes", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, key = String(b.period || "");
    if (!/^(month|quarter|year):[\dQ-]+$/.test(key)) return res.redirect("/report/management");
    const mg = b.reset ? null : Object.fromEntries(FIELDS.map(([f]) => [f, String(b[f] || "").replace(/\r/g, "").trim().slice(0, 1200)]));
    await pool.query(`INSERT INTO report_notes (period, mgmt, updated_by) VALUES ($1, $2, $3) ON CONFLICT (period) DO UPDATE SET mgmt = EXCLUDED.mgmt, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, mg ? JSON.stringify(mg) : null, actor(req)]);
    setFlash(req, "ok", b.reset ? "Back to the suggested text." : "Saved.");
    const back = String(b.back || ""); res.redirect(back.startsWith("/report/management?") ? back : "/report/management");
  }));
  app.get("/report/management.pptx", READ, wrap(async (req, res) => {
    const per = periodOf(req.query), M = await mgmtData(per);
    res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation")
      .set("Content-Disposition", `attachment; filename="WMF-${M.W.kind}-Management-Report-${per.p}.pptx"`).send(await pptx(M));
  }));
};
module.exports.mgmtData = mgmtData;
