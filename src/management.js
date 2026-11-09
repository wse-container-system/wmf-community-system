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
const { h, fmtDate, monLabel, nf, detailTiles, mini } = require("./views");

const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };
/** Shorten at a sentence end when possible, so nothing reads as cut off. */
const brief = (t, n) => {
  t = String(t || "").replace(/\s+/g, " ").trim(); if (t.length <= n) return t;
  const parts = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [];
  let out = ""; for (const x of parts) { if ((out + x).trim().length > n) break; out += x; }
  return out.trim() || cut(t, n);
};
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
    social: require("./mkinputs").campaignLines(D.mk).join("\n"),
    marketing: D.mk.totals.actions ? `${nf(D.mk.totals.actions)} posts and campaigns reached ${nf(D.mk.totals.reach)} people with ${nf(D.mk.totals.eng)} engagements${D.mk.totals.reach ? ` (${((D.mk.totals.eng / D.mk.totals.reach) * 100).toFixed(1)}% engagement rate)` : ""}.` : "",
    sponsor: sponsor.join("\n"), closing, priorities: prio.slice(0, 3).join("\n") };
}

/** Everything on the page: figures plus the words (saved, or the draft). */
async function mgmtData(per) {
  const D = await reportData(per);
  D.mk = await require("./mkinputs").loadInputs({ start: D.start, end: D.end });
  const W = words(per), draft = drafts(D), saved = D.notes.mgmt || {};
  // a box left empty uses the suggestion, so marketing's logged posts still show up after the words were saved once
  const T = Object.fromEntries(FIELDS.map(([f]) => [f, saved[f] != null && String(saved[f]).trim() !== "" ? saved[f] : draft[f]]));
  const A = D.city["Abu Dhabi"], X = D.city.Dubai;
  const comment = (c) => (c.top ? `Most attended: ${c.top.name} (${Math.round(c.top.perSession)} avg)` : c.sess ? "" : "No rides recorded");
  const rides = [
    { type: "AUH Community Rides", city: "auh", n: A.sess, avg: A.avg, fresh: A.fresh, comment: comment(A) },
    { type: "DXB Community Rides", city: "dxb", n: X.sess, avg: X.avg, fresh: X.fresh, comment: comment(X) },
    ...(D.corpAll || D.corp).map((c) => ({ type: `Corporate: ${c.name}`, city: "corp", n: c.sessions, avg: c.avg, fresh: c.fresh,
      comment: c.sessions || c.cancelled ? cut(c.kinds.map((x) => `${x.kind} ${x.n}`).join(" · ") + (c.cancelled ? ` · ${c.cancelled} cancelled` : ""), 60) : "No sessions this period" })),
  ];
  const acts = [...D.done].filter((a) => !D.isBig(a)).sort((a, b) => (b.participants || 0) - (a.participants || 0))
    .map((a) => ({ id: a.id, name: a.title, date: a.event_date ? fmtDate(a.event_date) : monLabel(String(a.month).slice(0, 7), true),
      people: a.participants != null ? `${nf(a.participants)} participants${a.registrants ? ` · ${nf(a.registrants)} registered` : ""}` : "—",
      note: String(a.impact || a.aim || "").replace(/\s+/g, " ").trim(), mk: D.mk.byEvent.find((g) => g.act_id === a.id) || null,
      raw: { participants: a.participants, registrants: a.registrants, new_contacts: a.new_contacts, impact: a.impact || "" }, strategy: D.mk.strategies.get("a:" + a.id) || "" }));
  const collab = D.partners.map((p) => ({ name: p.name, event: p.items.join(", "), note: String(p.impact || "").replace(/\s+/g, " ").trim() || (p.people ? `${nf(p.people)} people reached` : "") }));
  const s = D.soc, sc = (ch, c) => (s && s[ch][c].now != null ? `${nf(s[ch][c].now)}${s[ch][c].pct != null ? ` (${fmtPct(s[ch][c].pct)})` : ""}` : "—");
  const ch = D.prev.rideAttendance ? Math.round(((D.k.rideAttendance - D.prev.rideAttendance) / D.prev.rideAttendance) * 100) : null;
  const kpi = { participation: D.k.rideAttendance, change: ch, rides: D.k.rideSessions, fresh: (A.fresh || 0) + (X.fresh || 0), acts: D.done.length, actPeople: D.evPeople,
    members: D.db.total, newMembers: D.k.newMembers, active: D.k.activeMembers, prevActive: D.prev.activeMembers, auh: A.att, dxb: X.att, partners: D.partners.length };
  const soc = s ? { strava: ["Abu Dhabi", "Dubai"].map((c) => s.strava[c]), whatsapp: ["Abu Dhabi", "Dubai"].map((c) => s.whatsapp[c]) } : null;
  return { D, per, W, T, draft, saved, rides, acts, collab, kpi, soc, social: { strava: [sc("strava", "Abu Dhabi"), sc("strava", "Dubai")], whatsapp: [sc("whatsapp", "Abu Dhabi"), sc("whatsapp", "Dubai")] },
    community: D.done.length ? `${D.done.length} activation${D.done.length === 1 ? "" : "s"} · ${nf(D.evPeople)} participants` : "—",
    survey: D.season, surveyLine: require("./seasonsurvey").surveyLine(D.season) };
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
          .map(([f, l]) => `<tr><th>${h(l)}</th><td>${bullets(M.T[f], 200)}</td></tr>`).join("")}</table>
        <table class="mg-t"><thead><tr><th>Ride Type</th><th>No. of rides</th><th>Avg. no. of riders</th><th>New riders</th><th>Comment</th></tr></thead><tbody>
          ${M.rides.map((r) => `<tr><td>${h(r.type)}</td><td class="n">${r.n ? nf(r.n) : "—"}</td><td class="n">${avg(r.avg)}</td><td class="n">${r.fresh != null ? nf(r.fresh) : "—"}</td><td>${h(r.comment)}</td></tr>`).join("")}</tbody></table>
        <div class="mg-bar">CLOSING &amp; NEXT ${M.W.unit.toUpperCase()} PRIORITIES</div>
        <div class="mg-close"><p><b>Closing note:</b> ${h(brief(M.T.closing, 420))}</p><div><b>${h(M.W.next)} priorities:</b> ${bullets(M.T.priorities, 160)}</div></div>
      </div>
      <div class="mg-col">
        <div class="mg-bar">COMMUNITY ACTIVATIONS</div>
        <table class="mg-t"><thead><tr><th>Event / Activation</th><th>Participants</th><th>Feedback / Notes</th></tr></thead><tbody>
          ${M.acts.slice(0, 4).map((a) => `<tr><td>${h(a.name)}</td><td>${h(a.people)}</td><td>${h(brief(a.note, 230))}</td></tr>`).join("") || '<tr><td colspan="3" class="mg-empty">No activations recorded.</td></tr>'}</tbody></table>
        <div class="mg-bar">CORPORATE RIDES &amp; MARKETING</div>
        <table class="mg-kv">
          <tr><th>Social Media Campaigns</th><td>${bullets(M.T.social, 200)}</td></tr><tr><th>Marketing Highlights</th><td>${bullets(M.T.marketing, 200)}</td></tr>
          <tr><th>Sponsor Activations</th><td>${bullets(M.T.sponsor, 200)}</td></tr><tr><th>Community Activations</th><td>${h(M.community)}</td></tr>
          <tr><th>Strava Followers</th><td><b>AUH Strava:</b> ${h(M.social.strava[0])} <span class="mg-sep">|</span> <b>DXB Strava:</b> ${h(M.social.strava[1])}</td></tr>
          <tr><th>WhatsApp Members</th><td><b>AUH WhatsApp:</b> ${h(M.social.whatsapp[0])} <span class="mg-sep">|</span> <b>DXB WhatsApp:</b> ${h(M.social.whatsapp[1])}</td></tr>
          <tr><th>Community Survey</th><td>${h(M.surveyLine)}</td></tr></table>
        <table class="mg-t mg-collab"><thead><tr><th>Cross collaborations</th><th>Event</th><th>Comment</th></tr></thead><tbody>
          ${M.collab.slice(0, 4).map((c) => `<tr><td>${h(c.name)}</td><td>${h(c.event)}</td><td>${h(brief(c.note, 170))}</td></tr>`).join("") || '<tr><td colspan="3" class="mg-empty">No collaborations this period.</td></tr>'}</tbody></table>
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
  const txt = (t, n) => lines(t).map((x) => "• " + brief(x, n)).join("\n") || "—";
  const unit = M.W.unit === "month" ? "Month" : M.W.unit === "quarter" ? "Quarter" : "Year";
  // left column
  s.addTable([["developments", "Key Developments"], ["wins", "Key Execution Wins"], ["misses", "Key Execution Misses"], ["forward", `Forward View (Next ${unit})`]]
    .map(([f, l]) => [cell(l, { bold: true, fill: { color: LIGHT } }), cell(txt(M.T[f], 200))]), { x: 0.1, y: 0.62, w: 6.5, colW: [1.2, 5.3] });
  s.addTable([["Ride Type", "No. of rides", "Avg. no. of riders", "New riders", "Comment"].map(head),
    ...M.rides.map((r) => [cell(r.type), cell(r.n || "—", { align: "center" }), cell(r.avg == null ? "—" : Math.round(r.avg), { align: "center" }), cell(r.fresh == null ? "—" : r.fresh, { align: "center" }), cell(r.comment)])],
  { x: 0.1, y: 3.35, w: 6.5, colW: [1.55, 0.75, 0.85, 0.75, 2.6] });
  s.addText(`CLOSING & NEXT ${M.W.unit.toUpperCase()} PRIORITIES`, { x: 0.1, y: 5.55, w: 6.5, h: 0.3, fill: { color: BLUE }, color: "FFFFFF", bold: true, fontFace: F, fontSize: 9 });
  s.addText([{ text: "Closing note: ", options: { bold: true } }, { text: brief(M.T.closing, 420) + "\n" }, { text: `${M.W.next} priorities: `, options: { bold: true } }, { text: lines(M.T.priorities).map((x) => brief(x, 160)).join(" · ") || "—" }],
    { x: 0.1, y: 5.9, w: 6.5, h: 1.15, fontFace: F, fontSize: 8, color: INK, valign: "top" });
  // right column
  s.addText("COMMUNITY ACTIVATIONS", { x: 6.75, y: 0.62, w: 6.5, h: 0.3, fill: { color: BLUE }, color: "FFFFFF", bold: true, fontFace: F, fontSize: 9 });
  s.addTable([["Event / Activation", "Participants", "Feedback / Notes"].map(head), ...(M.acts.length ? M.acts.slice(0, 4).map((a) => [cell(a.name), cell(a.people), cell(brief(a.note, 230), { fontSize: 7 })]) : [[cell("No activations recorded."), cell(""), cell("")]])],
    { x: 6.75, y: 0.95, w: 6.5, colW: [1.9, 1.5, 3.1] });
  s.addText("CORPORATE RIDES & MARKETING", { x: 6.75, y: 3.05, w: 6.5, h: 0.3, fill: { color: BLUE }, color: "FFFFFF", bold: true, fontFace: F, fontSize: 9 });
  s.addTable([["Social Media Campaigns", txt(M.T.social, 200)], ["Marketing Highlights", txt(M.T.marketing, 200)], ["Sponsor Activations", txt(M.T.sponsor, 200)], ["Community Activations", M.community],
    ["Strava Followers", `AUH Strava: ${M.social.strava[0]}   |   DXB Strava: ${M.social.strava[1]}`], ["WhatsApp Members", `AUH WhatsApp: ${M.social.whatsapp[0]}   |   DXB WhatsApp: ${M.social.whatsapp[1]}`], ["Community Survey", M.surveyLine]]
    .map(([a, b]) => [cell(a, { bold: true, fill: { color: LIGHT } }), cell(b)]), { x: 6.75, y: 3.38, w: 6.5, colW: [1.7, 4.8] });
  s.addTable([["Cross collaborations", "Event", "Comment"].map(head), ...(M.collab.length ? M.collab.slice(0, 4).map((c) => [cell(c.name), cell(c.event), cell(brief(c.note, 170), { fontSize: 7 })]) : [[cell("None this period."), cell(""), cell("")]])],
    { x: 6.75, y: 5.45, w: 6.5, colW: [1.9, 1.9, 2.7] });
  s.addShape(p.ShapeType.rect, { x: 0, y: 7.2, w: 13.33, h: 0.3, fill: { color: NAVY }, line: { color: NAVY } });
  s.addText(`AURORA  |  Confidential  |  ${M.W.kind} Report`, { x: 0.3, y: 7.2, w: 8, h: 0.3, fontFace: F, fontSize: 7, color: "FFFFFF", valign: "middle" });
  return p.write({ outputType: "nodebuffer" });
}


// ---------------------------------------------------------------- the details behind each number (no names: management sees these too)
function tilesOf(M) {
  const k = M.kpi, D = M.D, A = D.city["Abu Dhabi"], X = D.city.Dubai;
  const ch = (a, b) => (!b ? "—" : a === b ? '<span class="muted">no change</span>' : `<span class="${a > b ? "rp-up" : "rp-down"}">${a > b ? "▲" : "▼"} ${Math.abs(Math.round(((a - b) / b) * 100))}%</span>`);
  const byCity = mini(["City", "Participation", "Rides", "Avg. per ride", "Period before", "Change"], [["Abu Dhabi", A], ["Dubai", X]].map(([n, c]) =>
    [h(n), nf(c.att), nf(c.sess), c.avg ? nf(Math.round(c.avg)) : "—", nf(c.prevAtt), ch(c.att, c.prevAtt)]), { num: [1, 2, 3, 4] });
  const series = [...A.rides.map((r) => ({ ...r, city: "AUH" })), ...X.rides.map((r) => ({ ...r, city: "DXB" }))].sort((a, b) => b.attendance - a.attendance);
  const bySeries = mini(["Ride", "City", "Rides", "Participation", "Avg. per ride"], series.map((r) => [h(r.name), r.city, nf(r.sessions), nf(r.attendance), nf(Math.round(r.avg))]), { num: [2, 3, 4] });
  const months = D.months.map((m) => { const a = (A.trend.find((t) => t.m === m) || {}).v || 0, x = (X.trend.find((t) => t.m === m) || {}).v || 0; return [monLabel(m, true), nf(a), nf(x), `<b>${nf(a + x)}</b>`]; });
  const byMonth = mini(["Month", "Abu Dhabi", "Dubai", "Total"], months, { num: [1, 2, 3] });
  const rideList = mini(["Date", "City", "Ride", "Riders"], D.sessionsList.map((s) => [fmtDate(s.d), s.city === "Dubai" ? "DXB" : "AUH", h(s.series), nf(s.n)]), { num: [3], scroll: true });
  const acts = [...D.done].sort((a, b) => String(b.event_date || b.month).localeCompare(String(a.event_date || a.month)));
  const actList = mini(["Date", "Activation", "City", "Participants", "Registered", "Partners"], acts.map((a) => [a.event_date ? fmtDate(a.event_date) : monLabel(String(a.month).slice(0, 7), true),
    `${h(a.title)}${D.isBig(a) ? ' <span class="muted">(big event, counted separately)</span>' : ""}`, D.isDxb(a) ? "DXB" : "AUH", a.participants != null ? nf(a.participants) : "—", a.registrants ? nf(a.registrants) : "—", h(a.partners.join(", ") || "—")]), { num: [3, 4], scroll: true });
  const db = D.db, j = D.joined;
  const community = `<div class="grid"><div class="c6">${mini(["City", "Members", "Joined this period"], [["Abu Dhabi", nf(db.city.auh), nf(j.city.auh)], ["Dubai", nf(db.city.dxb), nf(j.city.dxb)], ["<b>Total</b>", `<b>${nf(db.total)}</b>`, `<b>${nf(j.total)}</b>`]], { num: [1, 2] })}</div>
    <div class="c6">${mini(["", "Members"], [["Women", nf(db.gender.women)], ["Men", nf(db.gender.men)], ["Not recorded", nf(db.gender.unknown)]], { num: [1] })}</div></div>
    <p class="hint">City is the home city given at registration, otherwise where the person rides most.</p>`;
  return [
    { label: "Ride participation", value: nf(k.participation), note: `${k.change != null ? `<span class="${k.change >= 0 ? "rp-up" : "rp-down"}">${k.change >= 0 ? "▲" : "▼"} ${Math.abs(k.change)}%</span> vs before · ` : ""}AUH ${nf(k.auh)} · DXB ${nf(k.dxb)}`,
      detail: { title: `Ride participation · ${M.per.label}`, html: `<h3>By city</h3>${byCity}<h3>By ride</h3>${bySeries}<h3>${M.per.type === "month" ? "Last six months" : "By month"}</h3>${byMonth}` } },
    { label: "Rides held", value: nf(k.rides), note: k.rides ? `${Math.round(k.participation / k.rides)} riders per ride on average` : "", detail: { title: `Every ride · ${M.per.label}`, html: rideList } },
    { label: "New joiners", value: nf(k.newMembers), note: `new members joined · ${nf(k.fresh)} first rides with WMF`,
      detail: { title: "New joiners and first rides", html: `${mini(["City", "First ride with WMF", "New members joined"], [["Abu Dhabi", nf(A.fresh), nf(j.city.auh)], ["Dubai", nf(X.fresh), nf(j.city.dxb)]], { num: [1, 2] })}
        ${D.newManual ? `<p class="hint"><b>New members: ${nf(k.newMembers)}</b>, set by the team for ${D.newManual.months.map((m) => monLabel(m, true)).join(", ")} (the records show ${nf(D.newManual.app)}). The city split above is from the records.</p>` : ""}
        <p class="hint">A new rider is someone whose first WMF ride was in this period. Dubai rides counted by headcount don't record names, so their new riders aren't counted.</p>` } },
    { label: "Active members", value: nf(k.active), note: `${k.prevActive != null ? `${ch(k.active, k.prevActive)} vs before · ` : ""}${k.members ? Math.round((k.active / k.members) * 100) + "% of the community" : ""}`,
      detail: { title: "Active members", html: `${mini(["", "Active members"], [[h(M.per.label), `<b>${nf(k.active)}</b>`], ["Period before", nf(k.prevActive)], ["Whole community", nf(k.members)]], { num: [1] })}
        <p class="hint">Active means the member took part at least twice in the 90 days up to the end of the period (or had their first ride in that time).</p>` } },
    { label: "Community activations", value: nf(k.acts), note: `${nf(k.actPeople)} participants · ${k.partners} partner${k.partners === 1 ? "" : "s"}`, detail: { title: `Community activations · ${M.per.label}`, html: actList } },
    { label: "Community", value: nf(k.members), note: "members in Abu Dhabi and Dubai", detail: { title: "The community", html: community } },
  ];
}

// ---------------------------------------------------------------- the dashboard (what the management link shows)
/** "Edit the words" for a period: the team's box, and a manager's link that may edit. */
function wordsEditor(M, per, { action, back, open, intro }) {
  return `<details class="mg-edit" ${open ? "open" : ""}><summary><b>Edit the words</b> <span class="muted">(${h(per.label)} · one point per line)</span></summary>
    ${intro ? `<p class="hint" style="margin:8px 0">${intro}</p>` : ""}
    <form class="form" method="post" action="${h(action)}"><input type="hidden" name="period" value="${h(per.key)}"><input type="hidden" name="back" value="${h(back)}">
      <div class="mg-fields">${FIELDS.map(([f, l]) => `<label>${h(l === "Priorities" ? `${M.W.next} priorities` : l)}${M.saved[f] == null || !String(M.saved[f]).trim() ? ' <span class="badge">Suggested</span>' : ""}<textarea name="${f}" rows="${f === "closing" ? 3 : 4}" maxlength="1200">${h(M.T[f])}</textarea></label>`).join("")}</div>
      <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn" name="reset" value="1" data-confirm="Go back to the suggested text for every box?">Back to the suggested text</button></div></form></details>`;
}
/** Save the words for a period (from the team or a manager's link). */
async function saveWords(b, by) {
  const key = String(b.period || "");
  if (!/^(month|quarter|year):[\dQ-]+$/.test(key)) return false;
  const mg = b.reset ? null : Object.fromEntries(FIELDS.map(([f]) => [f, String(b[f] || "").replace(/\r/g, "").trim().slice(0, 1200)]));
  await pool.query(`INSERT INTO report_notes (period, mgmt, updated_by) VALUES ($1, $2, $3) ON CONFLICT (period) DO UPDATE SET mgmt = EXCLUDED.mgmt, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, mg ? JSON.stringify(mg) : null, by]);
  return true;
}

/** The bits marketing (and the team) can edit, inside the same report. */
function editForm(a, ed) {
  return `<details class="mk-edit noprint"><summary class="btn tblbtn">Edit feedback, strategy &amp; numbers</summary>
    <form class="form" method="post" action="${ed.post}/act/${a.id}?${ed.qs({})}">
      <label>Feedback &amp; impact <span class="hint">(what happened, what people said, results)</span><textarea name="impact" rows="3" maxlength="1500">${h(a.raw.impact)}</textarea></label>
      <label>Marketing strategy <span class="hint">(aim, audience, key messages, timing)</span><textarea name="strategy" rows="3" maxlength="1200">${h(a.strategy)}</textarea></label>
      <div class="mk-edit-n"><label>Came<input name="participants" inputmode="numeric" value="${a.raw.participants ?? ""}"></label><label>Registered<input name="registrants" inputmode="numeric" value="${a.raw.registrants ?? ""}"></label>
        <label>New contacts<input name="new_contacts" inputmode="numeric" value="${a.raw.new_contacts ?? ""}"></label></div>
      <button class="btn primary">Save</button></form></details>
    <a class="btn tblbtn noprint" href="${ed.view}?${ed.qs({ target: "a:" + a.id })}#log">+ Add a post</a>`;
}

function dashboard(M, { nav, pdf, pptxHref, edit: ed }) {
  const k = M.kpi, unit = M.W.unit === "month" ? "Month" : M.W.unit === "quarter" ? "Quarter" : "Year";
  const li = (t, n = 200) => { const l = lines(t); return l.length ? `<ul class="md-list">${l.map((x) => `<li>${h(cut(x, n))}</li>`).join("")}</ul>` : '<p class="muted">—</p>'; };
  const maxAvg = Math.max(1, ...M.rides.map((r) => r.avg || 0));
  const color = { auh: "#5b7cf0", dxb: "#e8833a", corp: "#2e86c1" };
  const socTile = (name, list) => `<div class="md-soc"><b>${name}</b>${["Abu Dhabi", "Dubai"].map((c, i) => { const r = list && list[i]; return `<div><span>${c === "Abu Dhabi" ? "AUH" : "DXB"}</span><strong>${r && r.now != null ? nf(r.now) : "—"}</strong>${r && r.pct != null ? `<em class="${r.pct >= 0 ? "rp-up" : "rp-down"}">${fmtPct(r.pct)}</em>` : ""}</div>`; }).join("")}</div>`;
  return `<section class="mk-head md-head"><div><div class="wc-eyebrow">WMN Moving FWD · ${h(M.W.kind.toLowerCase())} performance</div><h2 class="ov-title">${h(M.per.label)}</h2>
      <p class="lead" style="margin:4px 0 0">Women's community cycling in Abu Dhabi and Dubai, and the corporate cycling programme.</p></div>
      <div class="mk-actions">${nav}${pdf}${ed && ed.excelHref ? `<a class="btn" href="${h(ed.excelHref)}">Excel</a>` : ""}<a class="btn primary" href="${h(pptxHref)}">PowerPoint</a></div></section>
    ${ed && ed.banner ? `<div class="md-editnote noprint"><b>You can edit this report:</b> feedback, marketing strategy and numbers under <a href="#acts">Community activations</a>, and posts under <a href="#log">Marketing &amp; impact</a>. Management sees your changes straight away.</div>` : ""}
    ${detailTiles(tilesOf(M), { cls: "tiles ov-tiles mk-tiles md-tiles" })}
    <div class="md-keys">
      <section class="card md-k"><h2>Key developments</h2>${li(M.T.developments)}</section>
      <section class="card md-k win"><h2>Key execution wins</h2>${li(M.T.wins)}</section>
      <section class="card md-k miss"><h2>Key execution misses</h2>${li(M.T.misses)}</section>
      <section class="card md-k next"><h2>Forward view (next ${unit.toLowerCase()})</h2>${li(M.T.forward)}</section>
    </div>
    <div class="grid">
      <section class="card c7"><h2>Rides</h2><div class="tw"><table class="md-rides"><thead><tr><th>Ride type</th><th class="n">No. of rides</th><th>Avg. number of riders</th><th class="n">New riders</th><th>Comment</th></tr></thead><tbody>
        ${M.rides.map((r) => `<tr><td><span class="md-dot" style="background:${color[r.city]}"></span>${h(r.type)}</td><td class="n">${r.n ? nf(r.n) : "—"}</td>
          <td><div class="md-avg"><span><i style="width:${((r.avg || 0) / maxAvg) * 100}%;background:${color[r.city]}"></i></span><b>${r.avg ? nf(Math.round(r.avg)) : "—"}</b></div></td>
          <td class="n">${r.fresh ? nf(r.fresh) : "—"}</td><td class="muted">${h(r.comment)}</td></tr>`).join("")}</tbody></table></div></section>
      <section class="card c5"><h2>Corporate rides &amp; marketing</h2>
        <div class="md-socs">${socTile("Strava", M.soc && M.soc.strava)}${socTile("WhatsApp", M.soc && M.soc.whatsapp)}</div>
        <dl class="md-dl"><dt>Social media campaigns</dt><dd>${li(M.T.social, 120)}</dd><dt>Marketing highlights</dt><dd>${li(M.T.marketing, 120)}</dd>
          <dt>Sponsor activations</dt><dd>${li(M.T.sponsor, 120)}</dd><dt>Community activations</dt><dd>${h(M.community)}</dd></dl></section>
      <section class="card c7" id="acts"><h2>Community activations</h2>
        ${M.acts.length ? `<div class="md-acts">${M.acts.map((a) => `<article id="act-${a.id}"><div><b>${h(a.name)}</b><span class="md-n">${h(a.people)}</span></div><span class="md-date">${h(a.date)}</span>${a.note ? `<p>${h(a.note)}</p>` : ""}
          ${a.strategy ? `<p class="md-strat"><b>Strategy</b> ${h(a.strategy)}</p>` : ""}
          ${a.mk ? `<p class="md-mk">Marketing: ${a.mk.actions.length} post${a.mk.actions.length === 1 ? "" : "s"} · ${nf(a.mk.reach)} reach · ${nf(a.mk.eng)} engagements</p>` : ""}${ed ? `<div class="mk-ev-actions">${editForm(a, ed)}</div>` : ""}</article>`).join("")}</div>` : '<p class="muted">No activations in this period.</p>'}</section>
      <section class="card c5"><h2>Cross collaborations</h2>
        ${M.collab.length ? `<div class="md-acts">${M.collab.map((c) => `<article><div><b>${h(c.name)}</b></div><span class="md-date">${h(c.event)}</span>${c.note ? `<p>${h(c.note)}</p>` : ""}</article>`).join("")}</div>` : '<p class="muted">No collaborations in this period.</p>'}</section>
      <section class="card c12"><h2>Community voice${M.survey ? ` · ${h(M.survey.title)}` : ""}</h2><p class="lead">What members told us in the latest end-of-season survey.</p>${require("./seasonsurvey").surveyHtml(M.survey)}</section>
      <section class="card c12"><h2>Marketing &amp; impact</h2><p class="lead">What marketing posted for each event, how far it reached, and how many people signed up and came.</p>${require("./mkinputs").impactHtml(M.D.mk)}</section>
      ${ed ? (() => { const MK = require("./mkinputs");
        const others = M.D.mk.others.length ? `<section class="card c12 noprint"><h2>Other events &amp; activities</h2><p class="lead">Marketing for events WMF didn't run. Not counted in the report.</p>
          ${mini(["Event", "Date", "Posts", "Reach", "Engagements", "People there"], M.D.mk.others.map((g) => [h(g.title), g.date ? fmtDate(g.date) : "—", nf(g.actions.length), nf(g.reach), nf(g.eng), g.participants != null ? nf(g.participants) : "—"]), { num: [2, 3, 4, 5] })}</section>` : "";
        const n = (M.D.mk.allRows || M.D.mk.rows).length;
        return `<div class="c12 noprint md-mkin"><details class="md-fold" ${ed.pre || ed.editing ? "open" : ""}><summary class="btn primary">${ed.editing ? "Edit a post" : "+ Add a post or campaign"}</summary>${MK.formHtml({ base: ed.post, tg: ed.tg, editing: ed.editing, pre: ed.pre, cancelHref: ed.cancelHref, strategies: ed.strategies })}</details>
          ${n ? `<details class="md-fold" ${ed.editing ? "open" : ""}><summary class="btn">All posts logged (${n})</summary>${MK.logHtml(M.D.mk, { base: ed.post, view: ed.view, qs: ed.qs, label: M.per.label })}${others}</details>` : ""}</div>`; })() : ""}
      <section class="card c12 md-close"><h2>Closing note &amp; ${h(M.W.next)} priorities</h2><p>${h(M.T.closing)}</p>${li(M.T.priorities, 160)}</section>
    </div>`;
}

// ---------------------------------------------------------------- routes
module.exports = function management(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const READ = need("admin", "coordinator", "viewer"), STAFF = need("admin", "coordinator");
  const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
  const qs = (per) => `period=${per.type}&p=${encodeURIComponent(per.p)}`;
  /** Month / quarter / year switch for a page at base. */
  function periodNav(per, base) {
    const H = E.helpers, today = new Date().toISOString().slice(0, 10), opts = [];
    if (per.type === "month") for (const m of H.monthsBetween("2025-01", today.slice(0, 7)).reverse()) opts.push([m, monLabel(m, true)]);
    if (per.type === "quarter") for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) opts.push([`${y}-Q${q}`, `Q${q} ${y}`]);
    if (per.type === "year") for (let y = +today.slice(0, 4); y >= 2025; y--) opts.push([String(y), String(y)]);
    return `<span class="seg">${Object.keys(KIND).map((t) => `<a href="${base}?period=${t}" class="${per.type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
      <form method="get" action="${base}" style="margin:0"><input type="hidden" name="period" value="${per.type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="Period">${opts.map(([v, l]) => `<option value="${v}" ${v === per.p ? "selected" : ""}>${h(l)}</option>`).join("")}</select></form>`;
  }
  /** What the editable parts need: where forms post, which page they come back to. */
  const editOf = async (req, per, { view, post, excelHref, banner }) => {
    const MK = require("./mkinputs");
    const q = (o) => new URLSearchParams({ period: per.type, p: per.p, ...o }).toString();
    const pre = String(req.query.target || "").slice(0, 90);
    return { view, post, excelHref, banner, qs: q, tg: await MK.targets(), strategies: await MK.loadStrategies(), editing: await MK.editRow(req.query.edit),
      pre: /^(a:\d+|e:.+|o)$/.test(pre) ? pre : "", cancelHref: `${view}?${q({})}#log` };
  };
  const onePage = (M) => `<section class="card noprint md-onepage-h"><h2>One-page version</h2><p class="lead">The same report in management's template. <b>Download PDF</b> saves this page; PowerPoint gives an editable copy.</p></section>
    <div class="mg-wrap">${sheet(M)}</div>`;

  app.get("/report/management", READ, wrap(async (req, res) => {
    const per = periodOf(req.query), M = await mgmtData(per);
    const canEdit = ["admin", "coordinator"].includes(user(req).role);
    const links = canEdit ? (await pool.query("SELECT * FROM report_links WHERE kind = 'management' ORDER BY active DESC, created_at DESC")).rows : [];
    const mkLinks = canEdit ? (await pool.query("SELECT * FROM report_links WHERE kind = 'marketing' ORDER BY active DESC, created_at DESC")).rows : [];
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const share = links.map((l) => {
      const url = `${base}/g/${l.token}`;
      return `<div class="lr-link ${l.active ? "" : "off"}"><div><b>${h(l.label)}</b> ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'} ${l.can_edit ? '<span class="badge">Can edit the words</span>' : '<span class="badge muted">View only</span>'}
        ${l.active ? `<div class="toolbar" style="margin:6px 0 0"><button class="btn tblbtn primary" type="button" data-copy="${h(url)}">Copy link</button>
          <a class="btn tblbtn" href="mailto:?subject=${encodeURIComponent("WMF performance dashboard")}&body=${encodeURIComponent(`Dear ${l.label},\n\nHere is the WMF performance dashboard. It is always up to date: choose the month, quarter or year at the top, and download the one-page report as PDF or PowerPoint whenever you need it.\n\n${url}\n\nKind regards`)}">Email</a>
          <a class="btn tblbtn" href="https://wa.me/?text=${encodeURIComponent(`The WMF performance dashboard, always up to date (choose the month, quarter or year at the top): ${url}`)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ""}</div>
        <div class="toolbar" style="margin:0"><form method="post" action="/report/management/links/${l.id}" style="margin:0"><input type="hidden" name="can_edit" value="${l.can_edit ? "0" : "1"}"><button class="btn tblbtn">${l.can_edit ? "Make view only" : "Allow editing the words"}</button></form>
          <form method="post" action="/report/management/links/${l.id}" style="margin:0"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form></div></div>`;
    }).join("");
    res.send(page(req, "Management report", `
      ${dashboard(M, { nav: periodNav(per, "/report/management"), pdf: `<button class="btn" data-print>Download PDF</button>`, pptxHref: `/report/management.pptx?${qs(per)}`,
        edit: canEdit ? await editOf(req, per, { view: "/report/management", post: "/report/marketing", excelHref: `/report/marketing.xlsx?${qs(per)}` }) : null })}
      ${canEdit ? `<section class="card noprint"><h2>For the team</h2>
        ${wordsEditor(M, per, { action: "/report/management/notes", back: `/report/management?${qs(per)}`, open: req.query.edit })}
        <details ${links.length ? "" : "open"} style="margin-top:10px"><summary><b>Share with management</b> <span class="muted">(a view-only link to this dashboard, always up to date)</span></summary>
          <p class="hint" style="margin:8px 0">They see exactly this page, without this box: no sign-in, no member names or contact details. They pick the month, quarter or year themselves. A link that can edit the words also shows the "Edit the words" box.</p>
          ${share}<form class="inline-form" method="post" action="/report/management/links" style="margin-top:10px"><input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. Management" style="flex:1 1 200px">
            <label class="hint" style="display:flex;gap:6px;align-items:center"><input type="checkbox" name="can_edit" value="1"> Can edit the words (e.g. for your manager)</label><button class="btn ${links.length ? "" : "primary"}">Make a link</button></form></details>
        ${await (async () => { // new members by hand, for months where the records are incomplete
          const manual = await require("./report").manualNewMembers();
          const mon = per.type === "month" ? per.p : E.helpers.addMonths(new Date().toISOString().slice(0, 7), -1);
          const set = Object.entries(manual).filter(([, v]) => v != null).sort((a, b) => b[0].localeCompare(a[0]));
          return `<details id="newmem" style="margin-top:10px" ${req.query.nm ? "open" : ""}><summary><b>New members</b> <span class="muted">(set the number by hand for a month${M.D.newManual ? `: ${h(M.per.label)} uses ${nf(M.kpi.newMembers)}, the app counts ${nf(M.D.newManual.app)}` : ""})</span></summary>
            <p class="hint" style="margin:8px 0">Use this when the records for a month are incomplete. The number you set is used everywhere in the reports; quarters and years add up the months.</p>
            <form class="inline-form" method="post" action="/report/management/newmembers"><input type="hidden" name="back" value="/report/management?${qs(per)}">
              <label>Month <input class="inp" type="month" name="month" value="${h(mon)}" required style="width:auto"></label>
              <label>New members <input class="inp" name="n" inputmode="numeric" maxlength="5" value="${manual[mon] ?? ""}" style="width:90px"></label>
              <button class="btn primary">Save</button><span class="hint">Leave empty to go back to the app's count.</span></form>
            ${set.length ? `<ul class="log" style="margin-top:8px">${set.map(([m, v]) => `<li><span><b>${h(monLabel(m, true))}</b>: ${nf(v)} new members (set by hand)</span>
              <form method="post" action="/report/management/newmembers" style="margin:0"><input type="hidden" name="month" value="${h(m)}"><input type="hidden" name="n" value=""><input type="hidden" name="back" value="/report/management?${qs(per)}"><button class="btn tblbtn">Use the app's count</button></form></li>`).join("")}</ul>` : ""}</details>`; })()}
        <details id="mklinks" style="margin-top:10px" ${req.query.mk ? "open" : ""}><summary><b>Marketing</b> <span class="muted">(their link to add feedback, strategy and posts per activation, and download the Excel)</span></summary>
          <p class="hint" style="margin:8px 0">Marketing gets this same report, with Community activations (feedback, strategy, numbers) and Marketing &amp; impact (posts) editable, and the Excel download. No sign-in, no member names.</p>
          ${mkLinks.map((l) => { const url = `${base}/m/${l.token}`; return `<div class="lr-link ${l.active ? "" : "off"}"><div><b>${h(l.label)}</b> ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}
            ${l.active ? `<div class="toolbar" style="margin:6px 0 0"><button class="btn tblbtn primary" type="button" data-copy="${h(url)}">Copy link</button>
              <a class="btn tblbtn" href="mailto:?subject=${encodeURIComponent("WMF marketing link")}&body=${encodeURIComponent(`Hi ${l.label},\n\nHere's your WMF marketing link. For each community activation you can update the numbers, feedback and impact, write the marketing strategy, and add each post with its reach and engagement. It all shows in the management report. Download Excel gives rides, participation, events and their impact.\n\n${url}`)}">Email</a>
              <a class="btn tblbtn" href="https://wa.me/?text=${encodeURIComponent(`Your WMF marketing link: add feedback, strategy and posts for each activation. It shows in the management report: ${url}`)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ""}</div>
            <form method="post" action="/report/marketing/links/${l.id}"><input type="hidden" name="back" value="/report/management"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form></div>`; }).join("")}
          <form class="inline-form" method="post" action="/report/marketing/links" style="margin-top:10px"><input type="hidden" name="back" value="/report/management"><input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. Marketing" style="flex:1 1 200px"><button class="btn ${mkLinks.length ? "" : "primary"}">Make a link</button></form></details></section>` : ""}
      ${onePage(M)}`, { active: "/report/management" }));
  }));
  app.post("/report/management/links", STAFF, wrap(async (req, res) => {
    const label = require("./rules").clean(req.body.label).slice(0, 60);
    if (label) {
      await pool.query("INSERT INTO report_links (token, label, kind, created_by, can_edit) VALUES ($1,$2,'management',$3,$4)", [require("crypto").randomBytes(12).toString("base64url"), label, actor(req), req.body.can_edit === "1"]);
      setFlash(req, "ok", `Link made for ${label}. Copy it or email it.`);
    }
    res.redirect("/report/management");
  }));
  app.post("/report/management/links/:id", STAFF, wrap(async (req, res) => {
    const id = +req.params.id || 0;
    if (req.body.can_edit != null) await pool.query("UPDATE report_links SET can_edit = $2 WHERE id = $1 AND kind = 'management'", [id, req.body.can_edit === "1"]);
    if (req.body.active != null) await pool.query("UPDATE report_links SET active = $2 WHERE id = $1 AND kind = 'management'", [id, req.body.active === "1"]);
    res.redirect("/report/management");
  }));
  // ----- the management link (no sign-in)
  const linkOf = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'management'", [String(t || "").slice(0, 60)])).rows[0];
  const closed = (req, res) => res.status(404).send(page(req, "WMF performance", `<section class="card"><h2>This link is switched off</h2><p class="lead">Please ask the WMF team for a new one.</p></section>`, { wide: false }));
  app.get("/g/:token", limit("mgmtlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), M = await mgmtData(per), b = `/g/${encodeURIComponent(l.token)}`;
    await pool.query("UPDATE report_links SET last_used = now() WHERE id = $1", [l.id]);
    const words = l.can_edit ? `<section class="card noprint">${wordsEditor(M, per, { action: `${b}/notes`, back: `${b}?${qs(per)}`, open: req.query.edit,
      intro: "Adjust any wording for this period. Your changes show in the report and the one-page version straight away; “Back to the suggested text” undoes them." })}</section>` : "";
    res.set("X-Robots-Tag", "noindex").send(page(req, "WMF performance", `${dashboard(M, { nav: periodNav(per, b), pdf: `<button class="btn" data-print>Download PDF</button>`, pptxHref: `${b}/pptx?${qs(per)}` })}${words}${onePage(M)}`, { active: "/wmf" }));
  }));
  app.post("/g/:token/notes", limit("mgmtlinkpost", 60, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l || !l.can_edit) return closed(req, res);
    const b = req.body || {}, base = `/g/${encodeURIComponent(l.token)}`;
    await saveWords(b, "Management link: " + l.label);
    setFlash(req, "ok", b.reset ? "Back to the suggested text." : "Saved.");
    const back = String(b.back || ""); res.redirect(303, back.startsWith(base + "?") ? back : base);
  }));
  // ----- the marketing link: this same report, with feedback, strategy, numbers and posts editable
  const mkLinkOf = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'marketing'", [String(t || "").slice(0, 60)])).rows[0];
  app.get("/m/:token", limit("reportlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await mkLinkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), M = await mgmtData(per), b = `/m/${encodeURIComponent(l.token)}`;
    await pool.query("UPDATE report_links SET last_used = now() WHERE id = $1", [l.id]);
    res.set("X-Robots-Tag", "noindex").send(page(req, "WMF performance", `${dashboard(M, { nav: periodNav(per, b), pdf: `<button class="btn" data-print>Download PDF</button>`, pptxHref: `${b}/pptx?${qs(per)}`,
      edit: await editOf(req, per, { view: b, post: b, excelHref: `${b}/excel?${qs(per)}`, banner: true }) })}${onePage(M)}`, { active: "/wmf" }));
  }));
  app.get("/m/:token/pptx", limit("reportlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await mkLinkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), M = await mgmtData(per);
    res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation")
      .set("Content-Disposition", `attachment; filename="WMF-${M.W.kind}-Report-${per.p}.pptx"`).send(await pptx(M));
  }));
  app.get("/g/:token/pptx", limit("mgmtlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), M = await mgmtData(per);
    res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation")
      .set("Content-Disposition", `attachment; filename="WMF-${M.W.kind}-Report-${per.p}.pptx"`).send(await pptx(M));
  }));
  app.post("/report/management/newmembers", STAFF, wrap(async (req, res) => {
    const m = String(req.body.month || ""), raw = String(req.body.n ?? "").replace(/[,\s]/g, "");
    if (/^\d{4}-\d{2}$/.test(m) && (raw === "" || /^\d{1,5}$/.test(raw))) {
      const cur = await require("./report").manualNewMembers();
      const before = cur[m] ?? null;
      if (raw === "") delete cur[m]; else cur[m] = +raw;
      await pool.query("INSERT INTO settings (key, value) VALUES ('newMembersManual', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(cur)]);
      await require("./db").audit(pool, actor(req), "report.newmembers", "settings", m, { n: before }, { n: raw === "" ? null : +raw });
      setFlash(req, "ok", raw === "" ? `${monLabel(m, true)}: back to the app's count.` : `${monLabel(m, true)}: ${raw} new members.`);
    } else setFlash(req, "err", "Choose a month and enter a number.");
    const back = String(req.body.back || ""); res.redirect((back.startsWith("/report/management?") ? back : "/report/management") + (back.includes("?") ? "&" : "?") + "nm=1#newmem");
  }));
  app.post("/report/management/notes", STAFF, wrap(async (req, res) => {
    const b = req.body || {};
    if (!(await saveWords(b, actor(req)))) return res.redirect("/report/management");
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
