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
    { type: "AUH Community Rides", city: "auh", n: A.sess, avg: A.avg, fresh: A.fresh, comment: comment(A) },
    { type: "DXB Community Rides", city: "dxb", n: X.sess, avg: X.avg, fresh: X.fresh, comment: comment(X) },
    ...(D.corpAll || D.corp).map((c) => ({ type: `Corporate: ${c.name}`, city: "corp", n: c.sessions, avg: c.avg, fresh: c.fresh,
      comment: c.sessions || c.cancelled ? cut(c.kinds.map((x) => `${x.kind} ${x.n}`).join(" · ") + (c.cancelled ? ` · ${c.cancelled} cancelled` : ""), 60) : "No sessions this period" })),
  ];
  const acts = [...D.done].filter((a) => !D.isBig(a)).sort((a, b) => (b.participants || 0) - (a.participants || 0)).slice(0, 4)
    .map((a) => ({ name: a.title, people: a.participants != null ? `${nf(a.participants)} participants${a.registrants ? ` · ${nf(a.registrants)} registered` : ""}` : "—", note: cut(a.impact || a.aim || "", 120) }));
  const collab = D.partners.slice(0, 4).map((p) => ({ name: p.name, event: cut(p.items.join(", "), 50), note: cut(p.impact, 80) || (p.people ? `${nf(p.people)} people reached` : "") }));
  const s = D.soc, sc = (ch, c) => (s && s[ch][c].now != null ? `${nf(s[ch][c].now)}${s[ch][c].pct != null ? ` (${fmtPct(s[ch][c].pct)})` : ""}` : "—");
  const ch = D.prev.rideAttendance ? Math.round(((D.k.rideAttendance - D.prev.rideAttendance) / D.prev.rideAttendance) * 100) : null;
  const kpi = { participation: D.k.rideAttendance, change: ch, rides: D.k.rideSessions, fresh: (A.fresh || 0) + (X.fresh || 0), acts: D.done.length, actPeople: D.evPeople,
    members: D.db.total, newMembers: D.k.newMembers, auh: A.att, dxb: X.att, partners: D.partners.length };
  const soc = s ? { strava: ["Abu Dhabi", "Dubai"].map((c) => s.strava[c]), whatsapp: ["Abu Dhabi", "Dubai"].map((c) => s.whatsapp[c]) } : null;
  return { D, per, W, T, draft, saved, rides, acts, collab, kpi, soc, social: { strava: [sc("strava", "Abu Dhabi"), sc("strava", "Dubai")], whatsapp: [sc("whatsapp", "Abu Dhabi"), sc("whatsapp", "Dubai")] },
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
    { label: "New riders", value: nf(k.fresh), note: `${nf(k.newMembers)} new members joined`,
      detail: { title: "New riders and new members", html: `${mini(["City", "First ride with WMF", "New members joined"], [["Abu Dhabi", nf(A.fresh), nf(j.city.auh)], ["Dubai", nf(X.fresh), nf(j.city.dxb)]], { num: [1, 2] })}
        <p class="hint">A new rider is someone whose first WMF ride was in this period. Dubai rides counted by headcount don't record names, so their new riders aren't counted.</p>` } },
    { label: "Community activations", value: nf(k.acts), note: `${nf(k.actPeople)} participants · ${k.partners} partner${k.partners === 1 ? "" : "s"}`, detail: { title: `Community activations · ${M.per.label}`, html: actList } },
    { label: "Community", value: nf(k.members), note: "members in Abu Dhabi and Dubai", detail: { title: "The community", html: community } },
  ];
}

// ---------------------------------------------------------------- the dashboard (what the management link shows)
function dashboard(M, { nav, pdf, pptxHref }) {
  const k = M.kpi, unit = M.W.unit === "month" ? "Month" : M.W.unit === "quarter" ? "Quarter" : "Year";
  const li = (t, n = 200) => { const l = lines(t); return l.length ? `<ul class="md-list">${l.map((x) => `<li>${h(cut(x, n))}</li>`).join("")}</ul>` : '<p class="muted">—</p>'; };
  const maxAvg = Math.max(1, ...M.rides.map((r) => r.avg || 0));
  const color = { auh: "#5b7cf0", dxb: "#e8833a", corp: "#2e86c1" };
  const socTile = (name, list) => `<div class="md-soc"><b>${name}</b>${["Abu Dhabi", "Dubai"].map((c, i) => { const r = list && list[i]; return `<div><span>${c === "Abu Dhabi" ? "AUH" : "DXB"}</span><strong>${r && r.now != null ? nf(r.now) : "—"}</strong>${r && r.pct != null ? `<em class="${r.pct >= 0 ? "rp-up" : "rp-down"}">${fmtPct(r.pct)}</em>` : ""}</div>`; }).join("")}</div>`;
  return `<section class="mk-head md-head"><div><div class="wc-eyebrow">WMN Moving FWD · ${h(M.W.kind.toLowerCase())} performance</div><h2 class="ov-title">${h(M.per.label)}</h2>
      <p class="lead" style="margin:4px 0 0">Women's community cycling in Abu Dhabi and Dubai, and the corporate cycling programme.</p></div>
      <div class="mk-actions">${nav}${pdf}<a class="btn primary" href="${h(pptxHref)}">PowerPoint</a></div></section>
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
      <section class="card c7"><h2>Community activations</h2>
        ${M.acts.length ? `<div class="md-acts">${M.acts.map((a) => `<article><div><b>${h(a.name)}</b><span class="md-n">${h(a.people)}</span></div>${a.note ? `<p>${h(a.note)}</p>` : ""}</article>`).join("")}</div>` : '<p class="muted">No activations in this period.</p>'}</section>
      <section class="card c5"><h2>Cross collaborations</h2>
        ${M.collab.length ? `<div class="md-acts">${M.collab.map((c) => `<article><div><b>${h(c.name)}</b></div><p><span class="md-ev">${h(c.event)}</span>${c.note ? ` · ${h(c.note)}` : ""}</p></article>`).join("")}</div>` : '<p class="muted">No collaborations in this period.</p>'}</section>
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
  const onePage = (M) => `<section class="card noprint md-onepage-h"><h2>One-page version</h2><p class="lead">The same report in management's template. <b>Download PDF</b> saves this page; PowerPoint gives an editable copy.</p></section>
    <div class="mg-wrap">${sheet(M)}</div>`;

  app.get("/report/management", READ, wrap(async (req, res) => {
    const per = periodOf(req.query), M = await mgmtData(per);
    const canEdit = ["admin", "coordinator"].includes(user(req).role);
    const links = canEdit ? (await pool.query("SELECT * FROM report_links WHERE kind = 'management' ORDER BY active DESC, created_at DESC")).rows : [];
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const share = links.map((l) => {
      const url = `${base}/g/${l.token}`;
      return `<div class="lr-link ${l.active ? "" : "off"}"><div><b>${h(l.label)}</b> ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}
        ${l.active ? `<div class="toolbar" style="margin:6px 0 0"><button class="btn tblbtn primary" type="button" data-copy="${h(url)}">Copy link</button>
          <a class="btn tblbtn" href="mailto:?subject=${encodeURIComponent("WMF performance dashboard")}&body=${encodeURIComponent(`Dear ${l.label},\n\nHere is the WMF performance dashboard. It is always up to date: choose the month, quarter or year at the top, and download the one-page report as PDF or PowerPoint whenever you need it.\n\n${url}\n\nKind regards`)}">Email</a>
          <a class="btn tblbtn" href="https://wa.me/?text=${encodeURIComponent(`The WMF performance dashboard, always up to date (choose the month, quarter or year at the top): ${url}`)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ""}</div>
        <form method="post" action="/report/management/links/${l.id}"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form></div>`;
    }).join("");
    res.send(page(req, "Management report", `
      ${dashboard(M, { nav: periodNav(per, "/report/management"), pdf: `<button class="btn" data-print>Download PDF</button>`, pptxHref: `/report/management.pptx?${qs(per)}` })}
      ${canEdit ? `<section class="card noprint"><h2>For the team</h2>
        <details class="mg-edit" ${req.query.edit ? "open" : ""}><summary><b>Edit the words</b> <span class="muted">(${h(per.label)} · one point per line)</span></summary>
          <form class="form" method="post" action="/report/management/notes"><input type="hidden" name="period" value="${h(per.key)}"><input type="hidden" name="back" value="/report/management?${qs(per)}">
            <div class="mg-fields">${FIELDS.map(([f, l]) => `<label>${h(l === "Priorities" ? `${M.W.next} priorities` : l)}${M.saved[f] == null ? ' <span class="badge">Suggested</span>' : ""}<textarea name="${f}" rows="${f === "closing" ? 3 : 4}" maxlength="1200">${h(M.T[f])}</textarea></label>`).join("")}</div>
            <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn" name="reset" value="1" data-confirm="Go back to the suggested text for every box?">Back to the suggested text</button></div></form></details>
        <details ${links.length ? "" : "open"} style="margin-top:10px"><summary><b>Share with management</b> <span class="muted">(a view-only link to this dashboard, always up to date)</span></summary>
          <p class="hint" style="margin:8px 0">They see exactly this page, without this box: no sign-in, no member names or contact details. They pick the month, quarter or year themselves.</p>
          ${share}<form class="inline-form" method="post" action="/report/management/links" style="margin-top:10px"><input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. Management" style="flex:1 1 200px"><button class="btn ${links.length ? "" : "primary"}">Make a link</button></form></details></section>` : ""}
      ${onePage(M)}`, { active: "/report/management" }));
  }));
  app.post("/report/management/links", STAFF, wrap(async (req, res) => {
    const label = require("./rules").clean(req.body.label).slice(0, 60);
    if (label) {
      await pool.query("INSERT INTO report_links (token, label, kind, created_by) VALUES ($1,$2,'management',$3)", [require("crypto").randomBytes(12).toString("base64url"), label, actor(req)]);
      setFlash(req, "ok", `Link made for ${label}. Copy it or email it.`);
    }
    res.redirect("/report/management");
  }));
  app.post("/report/management/links/:id", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE report_links SET active = $2 WHERE id = $1 AND kind = 'management'", [+req.params.id || 0, req.body.active === "1"]);
    res.redirect("/report/management");
  }));
  // ----- the management link (no sign-in)
  const linkOf = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'management'", [String(t || "").slice(0, 60)])).rows[0];
  const closed = (req, res) => res.status(404).send(page(req, "WMF performance", `<section class="card"><h2>This link is switched off</h2><p class="lead">Please ask the WMF team for a new one.</p></section>`, { wide: false }));
  app.get("/g/:token", limit("mgmtlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), M = await mgmtData(per), b = `/g/${encodeURIComponent(l.token)}`;
    await pool.query("UPDATE report_links SET last_used = now() WHERE id = $1", [l.id]);
    res.set("X-Robots-Tag", "noindex").send(page(req, "WMF performance", `${dashboard(M, { nav: periodNav(per, b), pdf: `<button class="btn" data-print>Download PDF</button>`, pptxHref: `${b}/pptx?${qs(per)}` })}${onePage(M)}`, { active: "/wmf" }));
  }));
  app.get("/g/:token/pptx", limit("mgmtlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf(req.query), M = await mgmtData(per);
    res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation")
      .set("Content-Disposition", `attachment; filename="WMF-${M.W.kind}-Report-${per.p}.pptx"`).send(await pptx(M));
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
