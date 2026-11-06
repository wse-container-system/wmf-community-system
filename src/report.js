"use strict";
/**
 * WMF performance report: monthly, quarterly or annual, laid out like the team's Canva report
 * (cover, programme overview, attendance by city, riders, event spotlight, events, collaborations,
 * social growth, survey, corporate, strategy & what's next, summary).
 * Open it as pages to print / save as PDF, or download a PowerPoint that Canva imports as an editable design.
 */
const { pool, getSettings } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { buildData } = require("./snapshot");
const { loadActivations, syncHeldEvents } = require("./activations");
const { memberProfiles, summarise } = require("./demographics");
const { loadSocial, growthFor, fmtPct } = require("./social");
const { periodResults } = require("./surveys");
const CD = require("./corpdata");
const { h, fmtDate, monLabel, nf } = require("./views");
const { columns } = require("./charts");

const H = E.helpers;
const BRAND = require("path").join(__dirname, "..", "public", "brand") + "/";
const CITY = { "Abu Dhabi": { short: "AUH", color: "#5b7cf0" }, Dubai: { short: "DXB", color: "#e8833a" } };
const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
const pctOf = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const change = (a, b) => (b ? ((a - b) / b) * 100 : null);
const cut = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };

/** Period from the query; the default is the last full month. */
function periodOf(q, today = R.todayLocal()) {
  const type = ["month", "quarter", "year"].includes(q.period) ? q.period : "month";
  const last = H.addMonths(today.slice(0, 7), -1);
  const p = q.p || (type === "month" ? last : type === "quarter" ? `${last.slice(0, 4)}-Q${Math.floor((+last.slice(5, 7) - 1) / 3) + 1}` : today.slice(0, 4));
  const per = CD.periodFromQuery({ period: type, p }, today);
  return { ...per, key: `${type}:${per.p}`, kind: KIND[type] };
}

async function reportData(per) {
  const today = R.todayLocal();
  const start = per.start, end = per.end < today ? per.end : today;
  const prevR = E.previousPeriod(per.start, per.end);
  await syncHeldEvents("report");
  const [data, settings, acts, profiles, S, survey, notes, hist, upcoming, cos] = await Promise.all([
    buildData(), getSettings(), loadActivations(), memberProfiles(), loadSocial(), periodResults(start, end),
    pool.query("SELECT * FROM report_notes WHERE period = $1", [per.key]).then((r) => r.rows[0] || {}),
    pool.query("SELECT coalesce(sum(expat),0)::int AS expat, coalesce(sum(arab),0)::int AS arab, coalesce(sum(new_riders),0)::int AS fresh FROM history_rides WHERE ride_date BETWEEN $1 AND $2", [start, end]).then((r) => r.rows[0]),
    pool.query(`SELECT title, start_date::text AS d, location, category FROM calendar_items WHERE category IN ('wmf_event','generic_event') AND status <> 'Cancelled'
      AND start_date > $1::date AND start_date <= ($1::date + 75) ORDER BY start_date LIMIT 6`, [end]).then((r) => r.rows),
    CD.companies(),
  ]);
  const P = E.prepare(data);
  const cur = E.compute(P, { start, end }, today);
  const prev = E.compute(P, { start: prevR.start, end: prevR.end }, today, { light: true }).kpis;
  const k = cur.kpis;

  // ---- rides by city
  const city = {};
  for (const c of Object.keys(CITY)) {
    const x = E.compute(P, { start, end, location: c }, today);
    const rides = x.activities.filter((a) => a.kind === "Ride" && a.sessions);
    const top = rides.filter((a) => a.sessions >= 2).sort((a, b) => b.perSession - a.perSession)[0] || rides.sort((a, b) => b.perSession - a.perSession)[0] || null;
    city[c] = { att: x.kpis.rideAttendance, sess: x.kpis.rideSessions, avg: x.kpis.rideSessions ? x.kpis.rideAttendance / x.kpis.rideSessions : null, top,
      fresh: x.kpis.firstTimers, prevAtt: E.compute(P, { start: prevR.start, end: prevR.end, location: c }, today, { light: true }).kpis.rideAttendance,
      rides: rides.map((a) => ({ name: a.name, sessions: a.sessions, attendance: a.attendance, avg: a.perSession })).sort((a, b) => b.attendance - a.attendance),
      trend: x.trend.map((t) => ({ m: t.month, v: t.rideAttendance })) };
  }
  // the same weekday in both cities is two rides: count sessions per city
  k.rideSessions = Object.values(city).reduce((a, c) => a + (c.sess || 0), 0);
  const attSum = Object.values(city).reduce((a, c) => a + (c.att || 0), 0);
  city["Abu Dhabi"].share = pctOf(city["Abu Dhabi"].att, attSum);
  city.Dubai.share = city.Dubai.att ? 100 - city["Abu Dhabi"].share : 0;
  const months = per.type === "month" ? H.monthsBetween(H.addMonths(start.slice(0, 7), -5), start.slice(0, 7)) : H.monthsBetween(start.slice(0, 7), end.slice(0, 7));

  // ---- who rode: community and gender (live check-ins; history headcounts add the community split they recorded)
  const prof = new Map(profiles.map((p) => [p.id, p]));
  const live = cur.rows.filter((r) => r.kind === "ride" && r.qualifying && !r.coveredByHistory && r.member);
  const g = { emirati: 0, arab: 0, expat: 0, unknown: 0, women: 0, men: 0 };
  for (const r of live) { const p = prof.get(r.member.memberId); g[p ? p.group : "unknown"]++; if (p && p.gender !== "unknown") g[p.gender]++; }
  const riders = { emiratiArab: g.emirati + g.arab + hist.arab, expat: g.expat + hist.expat, women: g.women, men: g.men };
  riders.unknown = Math.max(0, k.rideAttendance - riders.emiratiArab - riders.expat);
  const firstRiders = k.firstTimers + hist.fresh;
  const db = summarise(profiles);
  const joined = summarise(profiles.filter((p) => { const m = data.members.find((x) => x.memberId === p.id); const d = m && String(m.firstSeen || "").slice(0, 10); return d && d >= start && d <= end; }));

  // ---- events, activations and partners
  const separate = new Set((settings.separateEvents || []).map((s) => s.toLowerCase()));
  const dayOf = (a) => String(a.event_date || a.month).slice(0, 10);
  const done = acts.filter((a) => a.status === "Completed" && dayOf(a) >= start.slice(0, 7) + "-01" && dayOf(a) <= end);
  const prevDone = acts.filter((a) => a.status === "Completed" && dayOf(a) >= prevR.start && dayOf(a) <= prevR.end);
  const isBig = (a) => separate.has(String(a.title).toLowerCase().trim());
  const isDxb = (a) => /dubai|dxb/i.test(`${a.location || ""} ${a.title}`);
  const evPeople = done.filter((a) => !isBig(a)).reduce((s, a) => s + (a.participants || 0), 0);
  const spotlight = [...done].filter((a) => !isBig(a)).sort((a, b) => (b.participants || 0) - (a.participants || 0) || (b.registrants || 0) - (a.registrants || 0))[0] || null;
  const surveyOf = spotlight && spotlight.activity_id ? (await pool.query(`SELECT count(r.id)::int AS n, avg(r.rating) AS avg FROM surveys s JOIN survey_responses r ON r.survey_id = s.id WHERE s.activation_id = $1`, [spotlight.id])).rows[0] : null;
  const pmap = new Map();
  for (const a of done) for (const p of a.partners) { const x = pmap.get(p) || { name: p, items: [], people: 0, impact: "" }; x.items.push(a.title); x.people += isBig(a) ? 0 : a.participants || 0; x.impact = x.impact || a.impact || ""; pmap.set(p, x); }
  const partners = [...pmap.values()].sort((a, b) => b.people - a.people || b.items.length - a.items.length);
  const told = new Set(); // one event's impact is shown once, under its first partner
  for (const p of partners) { if (told.has(p.impact)) p.impact = ""; else if (p.impact) told.add(p.impact); }

  // ---- corporate programme
  const st = cos.length ? await CD.stats({ codes: cos.map((c) => c.code), start, end }) : null;
  let corp = st ? cos.map((co) => {
    const b = st.byCompany.find((x) => x.code === co.code) || {};
    const held = st.sessions.filter((s) => s.company === co.code && s.status === "Held");
    const kinds = new Map(); for (const s of held) { const x = kinds.get(s.kind) || { kind: s.kind, n: 0, att: 0 }; x.n++; x.att += s.attendance; kinds.set(s.kind, x); }
    const fresh = [...st.participants.values()].filter((x) => x.company === co.code && x.first && x.first >= start && x.first <= end).length
      + held.filter((s) => !s.named).reduce((a, s) => a + (s.headcount_new || 0), 0);
    return { code: co.code, name: co.name, fresh, sessions: held.length, attendance: b.attendance || 0, avg: held.length ? (b.attendance || 0) / held.length : null, people: b.people || 0,
      kinds: [...kinds.values()].map((x) => ({ ...x, avg: x.n ? x.att / x.n : 0 })), cancelled: b.cancelled || 0 };
  }) : [];
  const corpAll = corp; // every programme, also those with no session this period (management lists them all)
  corp = corp.filter((c) => c.sessions || c.cancelled);

  // ---- social
  const soc = growthFor(S, start, end);

  // ---- headline wins (written from the figures; the team can rewrite them in the strategy notes)
  const wins = [];
  if (spotlight && spotlight.participants) wins.push({ big: `${nf(spotlight.participants)} attendees`, text: `${spotlight.title}${spotlight.partners.length ? " with " + spotlight.partners.join(", ") : ""}` });
  const bestCity = Object.entries(city).filter(([, v]) => v.top).sort((a, b) => b[1].top.perSession - a[1].top.perSession)[0];
  if (bestCity) wins.push({ big: `${Math.round(bestCity[1].top.perSession)} riders per ride`, text: `${bestCity[1].top.name}, ${bestCity[0]}` });
  if (soc) {
    const opts = [];
    for (const ch of ["whatsapp", "strava"]) for (const c of Object.keys(CITY)) if (soc[ch][c].pct != null) opts.push({ ch, c, p: soc[ch][c].pct });
    const best = opts.sort((a, b) => b.p - a.p)[0];
    if (best && best.p > 0) wins.push({ big: `${fmtPct(best.p)} ${best.ch === "whatsapp" ? "WhatsApp" : "Strava"}`, text: `Fastest-growing channel, ${best.c}` });
  }
  if (wins.length < 3 && k.newMembers) wins.push({ big: `+${nf(k.newMembers)} members`, text: `Joined the community in ${per.label}` });
  if (wins.length < 3 && survey.avg) wins.push({ big: `${survey.avg.toFixed(1)} / 5`, text: `Average event rating (${survey.n} answers)` });

  return { prevR, prevEvents: prevDone.length, prevEvPeople: prevDone.filter((a) => !isBig(a)).reduce((s, a) => s + (a.participants || 0), 0), per, start, end, today, k, prev, city, months, riders, firstRiders, db, joined, done, evPeople, spotlight, surveyOf, partners, corp, corpAll, soc, survey, upcoming, notes, wins, isDxb, isBig };
}

// =====================================================================================================  HTML pages
const tileH = (lbl, val, sub, cls = "") => `<div class="rp-tile ${cls}"><span class="rp-l">${h(lbl)}</span><span class="rp-v">${val}</span>${sub ? `<span class="rp-s">${sub}</span>` : ""}</div>`;
const cityLine = (a, b) => `<span class="rp-t-auh">AUH ${nf(a)}</span> · <span class="rp-t-dxb">DXB ${nf(b)}</span>`;

function slides(D) {
  const { per, k, prev, city } = D, A = city["Abu Dhabi"], X = city.Dubai;
  const title = `WMF · ${per.label} Performance Report`;
  let n = 1;
  const slide = (eyebrow, head, body, cls = "") => `<section class="rp-slide ${cls}"><div class="rp-strip"></div><div class="rp-in">
    <div class="rp-eyebrow">${h(eyebrow)}</div><h2 class="rp-h">${h(head)}</h2>${body}</div>
    <footer class="rp-foot"><span>${h(title)}</span><span class="rp-mark">WMN MOVING FWD</span><span>${String(++n).padStart(2, "0")}</span></footer></section>`;
  const out = [];
  out.push(`<section class="rp-slide rp-cover"><div class="rp-cover-in"><div class="rp-logo">WMN MOVING FWD<small>Powered by AURORA</small></div>
    <div class="rp-kind">${h(per.kind.toUpperCase())} REPORT</div><div class="rp-sub">${h(per.label)} · Performance Dashboard</div></div>
    <div class="rp-cover-foot">Abu Dhabi &amp; Dubai communities · WMF Operations</div></section>`);

  const evAuh = D.done.filter((a) => !D.isDxb(a)).length, evDxb = D.done.length - evAuh;
  out.push(slide(`${per.label} at a glance`, "Programme overview", `
    <div class="rp-tiles4">${tileH("Total participation", nf(k.rideAttendance), cityLine(A.att, X.att))}${tileH("Rides delivered", nf(k.rideSessions), cityLine(A.sess, X.sess))}
      ${tileH("New members", nf(k.newMembers), D.prev.newMembers != null ? `vs ${nf(prev.newMembers)} the period before` : "")}${tileH("Community events", nf(D.done.length), cityLine(evAuh, evDxb))}</div>
    <p class="rp-cap">Share of participation by city</p>
    <div class="rp-share"><span style="flex:${A.att || 0.0001};background:${CITY["Abu Dhabi"].color}">Abu Dhabi · ${A.share}%</span><span style="flex:${X.att || 0.0001};background:${CITY.Dubai.color}">Dubai · ${X.share}%</span></div>
    <p class="rp-cap">Headline wins</p><div class="rp-wins">${D.wins.slice(0, 3).map((w) => `<div class="rp-win"><b>${h(w.big)}</b><span>${h(w.text)}</span></div>`).join("") || '<p class="muted">Add events and rides to see the highlights.</p>'}</div>`));

  const cityCard = (name, c) => `<div class="rp-city ${CITY[name].short.toLowerCase()}"><div class="rp-city-h"><b>${h(name.toUpperCase())}</b></div>
    <div class="rp-big">${nf(c.att)}</div><div class="rp-s">Total participation</div>
    <div class="rp-trio"><div><b>${nf(c.sess)}</b><span>Sessions</span></div><div><b>${c.avg ? nf(Math.round(c.avg)) : "—"}</b><span>Avg. per ride</span></div><div><b>${c.share}%</b><span>Share of total</span></div></div>
    ${c.top ? `<div class="rp-most"><span>MOST ATTENDED</span><b>${h(c.top.name)}</b><small>Averaging ${Math.round(c.top.perSession)} riders per ride</small></div>` : ""}</div>`;
  const chart = columns({ categories: D.months, series: Object.entries(city).map(([c, v]) => ({ name: c, color: CITY[c].color, values: D.months.map((m) => (v.trend.find((t) => t.m === m) || {}).v || 0) })), height: 150, label: "Ride attendance by month", short: (m) => monLabel(m) });
  const ch = change(k.rideAttendance, prev.rideAttendance);
  out.push(slide("Rides by city", "Community attendance", `<div class="rp-two">${cityCard("Abu Dhabi", A)}${cityCard("Dubai", X)}</div>
    <div class="rp-trend"><span class="rp-cap">Ride attendance by month${ch != null ? ` · ${fmtPct(ch)} vs the period before` : ""}</span>${chart}</div>`));

  const rTot = D.riders.emiratiArab + D.riders.expat;
  const bar = (parts) => `<div class="rp-share sm">${parts.filter((p) => p[1] > 0).map((p) => `<span style="flex:${p[1]};background:${p[2]}">${h(p[0])} · ${p[1]}</span>`).join("") || '<span style="flex:1;background:#d7d9e6;color:#555">No data yet</span>'}</div>`;
  out.push(slide("Newcomers & community mix", "Riders", `<div class="rp-tiles4">
      ${tileH("New members", nf(k.newMembers), D.joined.total ? cityLine(D.joined.city.auh, D.joined.city.dxb) : "")}
      ${tileH("First-time riders", nf(D.firstRiders), "First ride in this period")}
      ${tileH("Emirati & Arab riders", nf(D.riders.emiratiArab), rTot ? `${pctOf(D.riders.emiratiArab, rTot)}% of known` : "")}
      ${tileH("Expat riders", nf(D.riders.expat), rTot ? `${pctOf(D.riders.expat, rTot)}% of known` : "")}</div>
    <div class="rp-two"><div class="rp-box"><p class="rp-cap">Ride attendance by community</p>${bar([["Emirati & Arab", D.riders.emiratiArab, "#5b7cf0"], ["Expat", D.riders.expat, "#9b7be0"], ["Not recorded", D.riders.unknown, "#c9cbd8"]])}
        <p class="rp-cap" style="margin-top:14px">Ride attendances checked in with the app: women and men</p>${bar([["Women", D.riders.women, "#e86a8a"], ["Men", D.riders.men, "#5b7cf0"]])}</div>
      <div class="rp-box"><p class="rp-cap">Member database · ${nf(D.db.total)} members</p>${bar([["Abu Dhabi", D.db.city.auh, CITY["Abu Dhabi"].color], ["Dubai", D.db.city.dxb, CITY.Dubai.color]])}
        <p class="rp-cap" style="margin-top:14px">Women and men in the database</p>${bar([["Women", D.db.gender.women, "#e86a8a"], ["Men", D.db.gender.men, "#5b7cf0"], ["Not recorded", D.db.gender.unknown, "#c9cbd8"]])}</div></div>`));

  const s = D.spotlight;
  if (s) {
    const f = [["Registrations received", s.registrants], ["New contacts collected", s.new_contacts], [`Attended${s.registrants && s.participants ? ` (${pctOf(s.participants, s.registrants)}% of registrations)` : ""}`, s.participants]].filter((x) => x[1] != null);
    const fmax = Math.max(1, ...f.map((x) => x[1]));
    out.push(slide(`Event spotlight · ${D.isDxb(s) ? "Dubai" : "Abu Dhabi"}`, s.title, `<div class="rp-two">
      <div>${s.partners.length ? `<p class="rp-with">In collaboration with ${h(s.partners.join(", "))}</p>` : ""}${s.aim ? `<p class="rp-aim"><b>Aim:</b> ${h(s.aim)}</p>` : ""}
        ${s.impact ? `<div class="rp-box"><span class="rp-cap">Impact</span><p>${h(cut(s.impact, 420))}</p></div>` : ""}
        ${D.surveyOf && D.surveyOf.n ? `<div class="rp-box"><span class="rp-cap">Survey</span><p><b>${(+D.surveyOf.avg).toFixed(1)} / 5</b> from ${D.surveyOf.n} participants</p></div>` : ""}</div>
      <div class="rp-box"><span class="rp-cap">From registration to future riders</span>${f.map((x) => `<div class="rp-fun"><span>${h(x[0])}</span><b>${nf(x[1])}</b><i style="width:${(x[1] / fmax) * 100}%"></i></div>`).join("") || `<p>${nf(s.participants)} participants</p>`}</div></div>`));
  }

  const others = D.done.filter((a) => a !== s).slice(0, 6);
  out.push(slide(`Events · ${per.label}`, "Events & initiatives", others.length ? `<div class="rp-cards two">${others.map((a) => `<article class="rp-card ${D.isDxb(a) ? "dxb" : "auh"}">
      <span class="rp-tag">${D.isDxb(a) ? "Dubai" : "Abu Dhabi"} · ${h(a.category)}</span><h3>${h(a.title)}</h3><p>${h(cut(a.impact || a.aim || "", 150))}</p>
      <b class="rp-k">${a.participants != null ? `${nf(a.participants)} participants` : "Participants to add"}${a.partners.length ? " · " + h(a.partners.join(", ")) : ""}</b></article>`).join("")}</div>`
    : `<p class="rp-empty">${D.done.length ? "The spotlight was the only event this period." : "No events recorded for this period. They appear here once added on the Activations page."}</p>`));

  out.push(slide("Opportunities", "Collaborations & reach-outs", `<div class="rp-collab"><div class="rp-bignum"><b>${D.partners.length}</b><span>collaborations in ${h(per.label)}</span></div>
    <div class="rp-cards">${D.partners.slice(0, 4).map((p) => `<article class="rp-card"><h3>${h(p.name)}</h3><span class="rp-tag">${h(p.items.slice(0, 2).join(" · "))}</span><p>${h(cut(p.impact, 140))}</p>${p.people ? `<b class="rp-k">${nf(p.people)} people reached</b>` : ""}</article>`).join("") || '<p class="rp-empty">No partners recorded on this period\'s activations.</p>'}</div></div>`));

  const so = D.soc;
  const socCell = (ch, c) => { const r = so && so[ch][c]; return `<div><span>${c}</span><b>${r && r.pct != null ? fmtPct(r.pct) : "—"}</b><small>${r && r.now != null ? nf(r.now) + " members" : ""}</small></div>`; };
  out.push(slide("Strava & WhatsApp", "Social growth", so ? `<p class="rp-cap">Growth ${so.base ? `from ${monLabel(so.base, true)} to ${monLabel(so.last, true)}` : `in ${monLabel(so.last, true)}`}, by channel and city</p>
    <div class="rp-two"><div class="rp-box rp-soc"><h3>WhatsApp</h3><div class="rp-trio">${socCell("whatsapp", "Abu Dhabi")}${socCell("whatsapp", "Dubai")}<div><span>Total</span><b>${so.whatsapp.total.now != null ? nf(so.whatsapp.total.now) : "—"}</b><small>${so.whatsapp.total.diff != null ? (so.whatsapp.total.diff >= 0 ? "+" : "") + nf(so.whatsapp.total.diff) : ""}</small></div></div></div>
      <div class="rp-box rp-soc"><h3>Strava</h3><div class="rp-trio">${socCell("strava", "Abu Dhabi")}${socCell("strava", "Dubai")}<div><span>Total</span><b>${so.strava.total.now != null ? nf(so.strava.total.now) : "—"}</b><small>${so.strava.total.diff != null ? (so.strava.total.diff >= 0 ? "+" : "") + nf(so.strava.total.diff) : ""}</small></div></div></div></div>`
    : `<p class="rp-empty">Enter the monthly WhatsApp and Strava counts on the Social growth page and they appear here.</p>`));

  if (D.survey.n) {
    const sv = D.survey;
    out.push(slide("What participants said", "Event survey", `<div class="rp-tiles4">${tileH("Answers", nf(sv.n), `${sv.surveys} event${sv.surveys === 1 ? "" : "s"}`)}${tileH("Average rating", sv.avg ? sv.avg.toFixed(1) + " / 5" : "—", "")}
      ${tileH("Would join again", pctOf(sv.again.Yes || 0, sv.n) + "%", sv.again.Maybe ? `${sv.again.Maybe} maybe` : "")}${tileH("First WMF event", nf(sv.first), "of those who answered")}</div>
      <div class="rp-two"><div class="rp-box"><span class="rp-cap">They enjoyed</span><ul class="rp-q">${sv.liked.slice(0, 3).map((t) => `<li>“${h(cut(t, 130))}”</li>`).join("") || "<li>—</li>"}</ul></div>
        <div class="rp-box"><span class="rp-cap">To improve</span><ul class="rp-q">${sv.improve.slice(0, 3).map((t) => `<li>“${h(cut(t, 130))}”</li>`).join("") || "<li>—</li>"}</ul></div></div>`));
  }

  out.push(slide("Corporate program", "Corporate programs", D.corp.length ? `<div class="rp-cards three">${D.corp.map((c) => `<article class="rp-card corp"><h3>${h(c.name)}</h3>
      <div class="rp-trio"><div><b>${c.sessions}</b><span>Sessions</span></div><div><b>${c.avg ? nf(Math.round(c.avg)) : "—"}</b><span>Avg. attendance</span></div><div><b>${nf(c.people || c.attendance)}</b><span>${c.people ? "People" : "Attendances"}</span></div></div>
      <p>${c.kinds.map((x) => `${h(x.kind)}: ${x.n} × avg ${Math.round(x.avg)}`).join(" · ")}${c.cancelled ? ` · ${c.cancelled} cancelled` : ""}</p></article>`).join("")}</div>${D.notes.corporate ? `<p class="rp-note">${h(D.notes.corporate)}</p>` : ""}`
    : `<p class="rp-empty">No corporate sessions in this period.${D.notes.corporate ? " " + h(D.notes.corporate) : ""}</p>`));

  out.push(slide(`Strategy · what's next`, "Strategy & what's next", `<div class="rp-two">
    <div class="rp-box"><span class="rp-cap">Strategy this period</span><p class="rp-pre">${h(D.notes.strategy || "Write the strategy used this period in the notes above the report.")}</p></div>
    <div class="rp-box"><span class="rp-cap">Coming up</span>${D.upcoming.length ? `<ul class="rp-next">${D.upcoming.map((u) => `<li><b>${fmtDate(u.d).replace(/ \d{4}$/, "")}</b><span>${h(u.title)}${u.location ? ` · ${h(u.location)}` : ""}</span></li>`).join("")}</ul>` : ""}
      ${D.notes.next_steps ? `<p class="rp-pre">${h(D.notes.next_steps)}</p>` : D.upcoming.length ? "" : "<p>Add upcoming events to the calendar, or write them in the notes.</p>"}</div></div>`));

  const sum = [["Participation", nf(k.rideAttendance), `Participations across ${nf(k.rideSessions)} rides. Abu Dhabi ${A.share}%, Dubai ${X.share}%.`],
    ["Community growth", `+${nf(k.newMembers)}`, `New members. ${nf(D.firstRiders)} first-time riders.`],
    ["Activations", `${D.done.length} events`, `${nf(D.evPeople)} participants${s ? `; biggest: ${cut(s.title, 40)}` : ""}.`],
    ["Collaborations", nf(D.partners.length), cut(D.partners.map((p) => p.name).join(", "), 90) || "None recorded."],
    ["Corporate", `${D.corp.length} program${D.corp.length === 1 ? "" : "s"}`, cut(D.corp.map((c) => `${c.name}: ${c.sessions} sessions (avg ${c.avg ? Math.round(c.avg) : 0})`).join(". "), 110) || "No sessions."],
    ["Survey", D.survey.avg ? D.survey.avg.toFixed(1) + " / 5" : "—", D.survey.n ? `${D.survey.n} answers; ${pctOf(D.survey.again.Yes || 0, D.survey.n)}% would join again.` : "No survey answers this period."]];
  out.push(slide(per.label, "Summary", `<div class="rp-sum">${sum.map(([a, b, c]) => `<div><span class="rp-l">${h(a)}</span><b>${h(b)}</b><p>${h(c)}</p></div>`).join("")}</div>`));
  return out.join("");
}

// =====================================================================================================  PowerPoint (for Canva import)
async function pptx(D) {
  const PPT = require("pptxgenjs");
  const p = new PPT();
  p.layout = "LAYOUT_WIDE"; // 13.33 x 7.5 in
  p.title = `WMF ${D.per.label} ${D.per.kind} Report`;
  const HF = "Montserrat", BF = "Open Sans", INK = "15151F", MUT = "5D6075", BLUE = "4D6AE0", AUH = "5B7CF0", DXB = "E8833A", CARD = "F4F5FB";
  const { k, city } = D, A = city["Abu Dhabi"], X = city.Dubai;
  let n = 1;
  const base = (eyebrow, head) => {
    const s = p.addSlide(); s.background = { color: "FFFFFF" };
    s.addImage({ path: BRAND + "report-strip.png", x: 0, y: 0, w: 0.12, h: 7.5 });
    s.addText(eyebrow.toUpperCase(), { x: 0.7, y: 0.45, w: 11, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: BLUE, charSpacing: 3 });
    s.addText(head.toUpperCase(), { x: 0.7, y: 0.72, w: 12, h: 0.7, fontFace: HF, fontSize: 30, bold: true, color: INK });
    s.addText(`WMF · ${D.per.label} Performance Report`, { x: 0.7, y: 6.95, w: 7, h: 0.3, fontFace: BF, fontSize: 10, color: MUT });
    s.addText("WMN MOVING FWD", { x: 9.6, y: 6.93, w: 2.4, h: 0.32, fontFace: HF, fontSize: 12, bold: true, color: "A88FE0", align: "right" });
    s.addText(String(++n).padStart(2, "0"), { x: 12.1, y: 6.93, w: 0.6, h: 0.32, fontFace: BF, fontSize: 10, color: MUT, align: "right" });
    return s;
  };
  const card = (s, x, y, w, hh) => s.addShape(p.ShapeType.roundRect, { x, y, w, h: hh, rectRadius: 0.08, fill: { color: CARD }, line: { color: "E6E8F2" } });
  const tile = (s, x, y, w, lbl, val, sub, subColor = BLUE) => {
    card(s, x, y, w, 1.6);
    s.addText(lbl, { x: x + 0.2, y: y + 0.15, w: w - 0.4, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: INK });
    s.addText(String(val), { x: x + 0.2, y: y + 0.45, w: w - 0.4, h: 0.75, fontFace: HF, fontSize: 36, bold: true, color: INK });
    if (sub) s.addText(sub, { x: x + 0.2, y: y + 1.18, w: w - 0.4, h: 0.3, fontFace: BF, fontSize: 10, color: subColor });
  };
  const cityTxt = (a, b) => `AUH ${nf(a)} · DXB ${nf(b)}`;

  // cover
  const c = p.addSlide();
  c.background = { path: BRAND + "report-cover.jpg" };
  c.addText("WMN MOVING FWD", { x: 0, y: 2.2, w: 13.33, h: 0.6, fontFace: HF, fontSize: 30, bold: true, color: "FFFFFF", align: "center" });
  c.addText("Powered by AURORA", { x: 0, y: 2.75, w: 13.33, h: 0.3, fontFace: BF, fontSize: 11, color: "FFFFFF", align: "center" });
  c.addText(`${D.per.kind.toUpperCase()} REPORT`, { x: 0, y: 3.15, w: 13.33, h: 1.1, fontFace: BF, fontSize: 60, color: "FFFFFF", align: "center" });
  c.addText(`${D.per.label} · Performance Dashboard`, { x: 0, y: 4.2, w: 13.33, h: 0.45, fontFace: BF, fontSize: 20, color: "FFFFFF", align: "center" });
  c.addText("Abu Dhabi & Dubai communities · WMF Operations", { x: 0.9, y: 6.7, w: 8, h: 0.3, fontFace: BF, fontSize: 10, italic: true, color: "FFFFFF" });

  // overview
  let s = base(`${D.per.label} at a glance`, "Programme overview");
  const evAuh = D.done.filter((a) => !D.isDxb(a)).length;
  [["Total participation", nf(k.rideAttendance), cityTxt(A.att, X.att)], ["Rides delivered", nf(k.rideSessions), cityTxt(A.sess, X.sess)], ["New members", nf(k.newMembers), ""], ["Community events", nf(D.done.length), cityTxt(evAuh, D.done.length - evAuh)]]
    .forEach(([l, v, sub], i) => tile(s, 0.7 + i * 3.02, 1.6, 2.85, l, v, sub));
  s.addText("Share of participation by city", { x: 0.7, y: 3.4, w: 6, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: INK });
  const tot = Math.max(1, A.att + X.att), wA = 11.9 * (A.att / tot) || 0.01;
  s.addText(`Abu Dhabi · ${A.share}%`, { x: 0.7, y: 3.75, w: Math.max(0.01, wA), h: 0.38, fill: { color: AUH }, fontFace: BF, fontSize: 10, bold: true, color: "FFFFFF" });
  if (X.att) s.addText(`Dubai · ${X.share}%`, { x: 0.7 + wA, y: 3.75, w: 11.9 - wA, h: 0.38, fill: { color: DXB }, fontFace: BF, fontSize: 10, bold: true, color: "FFFFFF", align: "right" });
  s.addText("Headline wins", { x: 0.7, y: 4.45, w: 6, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: INK });
  D.wins.slice(0, 3).forEach((w, i) => { const x = 0.7 + i * 4.02; card(s, x, 4.8, 3.85, 1.4);
    s.addText(w.big, { x: x + 0.2, y: 4.92, w: 3.5, h: 0.45, fontFace: HF, fontSize: 18, bold: true, color: BLUE });
    s.addText(w.text, { x: x + 0.2, y: 5.38, w: 3.5, h: 0.7, fontFace: BF, fontSize: 11, color: INK, valign: "top" }); });

  // attendance
  s = base("Rides by city", "Community attendance");
  [["Abu Dhabi", A, AUH, 0.7], ["Dubai", X, DXB, 6.85]].forEach(([name, cc, col, x]) => {
    card(s, x, 1.6, 5.9, 4.9);
    s.addText(name.toUpperCase(), { x: x + 0.3, y: 1.8, w: 4, h: 0.35, fontFace: HF, fontSize: 14, bold: true, color: INK });
    s.addText(nf(cc.att), { x: x + 0.3, y: 2.15, w: 4, h: 0.9, fontFace: HF, fontSize: 48, bold: true, color: col });
    s.addText("Total participation", { x: x + 0.3, y: 3.0, w: 4, h: 0.3, fontFace: BF, fontSize: 11, color: MUT });
    [[nf(cc.sess), "Sessions"], [cc.avg ? nf(Math.round(cc.avg)) : "—", "Avg. per ride"], [cc.share + "%", "Share of total"]].forEach(([v, l], i) => {
      s.addText(v, { x: x + 0.3 + i * 1.85, y: 3.45, w: 1.8, h: 0.55, fontFace: HF, fontSize: 24, bold: true, color: INK });
      s.addText(l, { x: x + 0.3 + i * 1.85, y: 3.98, w: 1.8, h: 0.3, fontFace: BF, fontSize: 10, color: MUT }); });
    if (cc.top) {
      s.addText("MOST ATTENDED", { x: x + 0.3, y: 4.6, w: 5, h: 0.3, fontFace: BF, fontSize: 10, bold: true, color: col, charSpacing: 2 });
      s.addText(cc.top.name, { x: x + 0.3, y: 4.9, w: 5.3, h: 0.45, fontFace: HF, fontSize: 15, bold: true, color: INK });
      s.addText(`Averaging ${Math.round(cc.top.perSession)} riders per ride`, { x: x + 0.3, y: 5.35, w: 5.3, h: 0.3, fontFace: BF, fontSize: 11, color: MUT }); }
  });

  // riders
  s = base("Newcomers & community mix", "Riders");
  const rTot = D.riders.emiratiArab + D.riders.expat;
  [["New members", nf(k.newMembers), D.joined.total ? cityTxt(D.joined.city.auh, D.joined.city.dxb) : ""], ["First-time riders", nf(D.firstRiders), "First ride in this period"],
    ["Emirati & Arab riders", nf(D.riders.emiratiArab), rTot ? `${pctOf(D.riders.emiratiArab, rTot)}% of known` : ""], ["Expat riders", nf(D.riders.expat), rTot ? `${pctOf(D.riders.expat, rTot)}% of known` : ""]]
    .forEach(([l, v, sub], i) => tile(s, 0.7 + i * 3.02, 1.6, 2.85, l, v, sub));
  card(s, 0.7, 3.5, 11.9, 2.9);
  s.addText([
    { text: `Member database: ${nf(D.db.total)} members\n`, options: { bold: true, fontSize: 14 } },
    { text: `Abu Dhabi ${nf(D.db.city.auh)} · Dubai ${nf(D.db.city.dxb)}\n`, options: { fontSize: 13 } },
    { text: `Women ${nf(D.db.gender.women)} · Men ${nf(D.db.gender.men)}${D.db.gender.unknown ? ` · not recorded ${nf(D.db.gender.unknown)}` : ""}\n\n`, options: { fontSize: 13 } },
    { text: `Riders this period checked in with the app: women ${nf(D.riders.women)} · men ${nf(D.riders.men)}`, options: { fontSize: 12, color: MUT } },
  ], { x: 1, y: 3.7, w: 11.3, h: 2.5, fontFace: BF, color: INK, valign: "top" });

  // spotlight
  const sp = D.spotlight;
  if (sp) {
    s = base(`Event spotlight · ${D.isDxb(sp) ? "Dubai" : "Abu Dhabi"}`, cut(sp.title, 48));
    const left = [];
    if (sp.partners.length) left.push({ text: `In collaboration with ${sp.partners.join(", ")}\n`, options: { bold: true, color: BLUE, fontSize: 13 } });
    if (sp.aim) left.push({ text: `Aim: ${sp.aim}\n\n`, options: { fontSize: 12 } });
    if (sp.impact) left.push({ text: cut(sp.impact, 420), options: { fontSize: 12 } });
    if (left.length) s.addText(left, { x: 0.7, y: 1.6, w: 6, h: 4.8, fontFace: BF, color: INK, valign: "top" });
    card(s, 7, 1.6, 5.6, 4.8);
    s.addText("From registration to future riders", { x: 7.25, y: 1.75, w: 5.2, h: 0.35, fontFace: BF, fontSize: 12, bold: true, color: INK });
    [["Registrations received", sp.registrants], ["New contacts collected", sp.new_contacts], ["Attended", sp.participants], ["Survey rating", D.surveyOf && D.surveyOf.n ? (+D.surveyOf.avg).toFixed(1) + " / 5" : null]]
      .filter((x) => x[1] != null).forEach(([l, v], i) => {
        s.addText(l, { x: 7.25, y: 2.3 + i * 0.95, w: 3.6, h: 0.4, fontFace: BF, fontSize: 12, color: INK });
        s.addText(typeof v === "number" ? nf(v) : v, { x: 10.6, y: 2.2 + i * 0.95, w: 1.8, h: 0.55, fontFace: HF, fontSize: 26, bold: true, color: BLUE, align: "right" }); });
  }

  // events
  s = base(`Events · ${D.per.label}`, "Events & initiatives");
  const others = D.done.filter((a) => a !== sp).slice(0, 4);
  if (!others.length) s.addText("No other events recorded for this period.", { x: 0.7, y: 1.7, w: 11, h: 0.5, fontFace: BF, fontSize: 14, color: MUT });
  others.forEach((a, i) => { const x = 0.7 + (i % 2) * 6.05, y = 1.6 + Math.floor(i / 2) * 2.55; card(s, x, y, 5.85, 2.35);
    s.addText(`${D.isDxb(a) ? "Dubai" : "Abu Dhabi"} · ${a.category}`, { x: x + 0.25, y: y + 0.15, w: 5.3, h: 0.3, fontFace: BF, fontSize: 10, bold: true, color: D.isDxb(a) ? DXB : BLUE });
    s.addText(cut(a.title, 50), { x: x + 0.25, y: y + 0.45, w: 5.3, h: 0.45, fontFace: HF, fontSize: 16, bold: true, color: INK });
    s.addText(cut(a.impact || a.aim || "", 150), { x: x + 0.25, y: y + 0.9, w: 5.3, h: 0.9, fontFace: BF, fontSize: 11, color: INK, valign: "top" });
    s.addText(`${a.participants != null ? nf(a.participants) + " participants" : ""}${a.partners.length ? " · " + a.partners.join(", ") : ""}`, { x: x + 0.25, y: y + 1.85, w: 5.3, h: 0.3, fontFace: BF, fontSize: 10, bold: true, color: D.isDxb(a) ? DXB : BLUE }); });

  // collaborations
  s = base("Opportunities", "Collaborations & reach-outs");
  s.addText(String(D.partners.length), { x: 0.7, y: 1.6, w: 2.5, h: 1.1, fontFace: HF, fontSize: 60, bold: true, color: BLUE });
  s.addText(`collaborations in ${D.per.label}`, { x: 0.7, y: 2.7, w: 2.6, h: 0.6, fontFace: BF, fontSize: 12, color: INK, valign: "top" });
  D.partners.slice(0, 3).forEach((pt, i) => { const y = 1.6 + i * 1.6; card(s, 3.6, y, 9, 1.45);
    s.addText(pt.name, { x: 3.85, y: y + 0.12, w: 8.5, h: 0.4, fontFace: HF, fontSize: 15, bold: true, color: INK });
    s.addText(cut(pt.items.join(" · "), 90), { x: 3.85, y: y + 0.5, w: 8.5, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: BLUE });
    s.addText(cut(pt.impact, 150) + (pt.people ? ` (${nf(pt.people)} people reached)` : ""), { x: 3.85, y: y + 0.8, w: 8.5, h: 0.55, fontFace: BF, fontSize: 10.5, color: INK, valign: "top" }); });

  // social
  s = base("Strava & WhatsApp", "Social growth");
  if (!D.soc) s.addText("No social counts entered for this period yet.", { x: 0.7, y: 1.7, w: 11, h: 0.5, fontFace: BF, fontSize: 14, color: MUT });
  else [["WhatsApp", "whatsapp", 0.7], ["Strava", "strava", 6.85]].forEach(([name, ch, x]) => {
    card(s, x, 1.6, 5.9, 2.8);
    s.addText(name, { x: x + 0.3, y: 1.75, w: 5, h: 0.4, fontFace: HF, fontSize: 16, bold: true, color: INK });
    ["Abu Dhabi", "Dubai"].forEach((cn, i) => { const r = D.soc[ch][cn];
      s.addText(cn, { x: x + 0.3 + i * 2.8, y: 2.3, w: 2.6, h: 0.3, fontFace: BF, fontSize: 11, color: MUT });
      s.addText(r.pct != null ? fmtPct(r.pct) : "—", { x: x + 0.3 + i * 2.8, y: 2.6, w: 2.6, h: 0.7, fontFace: HF, fontSize: 32, bold: true, color: i ? DXB : AUH });
      s.addText(r.now != null ? `${nf(r.now)} members` : "", { x: x + 0.3 + i * 2.8, y: 3.35, w: 2.6, h: 0.3, fontFace: BF, fontSize: 10, color: MUT }); });
  });

  // survey
  if (D.survey.n) {
    const sv = D.survey;
    s = base("What participants said", "Event survey");
    [["Answers", nf(sv.n), `${sv.surveys} event(s)`], ["Average rating", sv.avg ? sv.avg.toFixed(1) + " / 5" : "—", ""], ["Would join again", pctOf(sv.again.Yes || 0, sv.n) + "%", ""], ["First WMF event", nf(sv.first), ""]]
      .forEach(([l, v, sub], i) => tile(s, 0.7 + i * 3.02, 1.6, 2.85, l, v, sub));
    s.addText(sv.liked.slice(0, 3).map((t) => ({ text: `“${cut(t, 140)}”\n`, options: { fontSize: 12, italic: true } })), { x: 0.7, y: 3.6, w: 5.9, h: 2.8, fontFace: BF, color: INK, valign: "top" });
    s.addText(sv.improve.slice(0, 3).map((t) => ({ text: `“${cut(t, 140)}”\n`, options: { fontSize: 12, italic: true } })), { x: 6.85, y: 3.6, w: 5.9, h: 2.8, fontFace: BF, color: INK, valign: "top" });
  }

  // corporate
  s = base("Corporate program", "Corporate programs");
  if (!D.corp.length) s.addText("No corporate sessions in this period.", { x: 0.7, y: 1.7, w: 11, h: 0.5, fontFace: BF, fontSize: 14, color: MUT });
  D.corp.slice(0, 3).forEach((co, i) => { const x = 0.7 + i * 4.02; card(s, x, 1.6, 3.85, 4.4);
    s.addText(co.name, { x: x + 0.25, y: 1.75, w: 3.4, h: 0.45, fontFace: HF, fontSize: 16, bold: true, color: INK });
    [[co.sessions, "Sessions"], [co.avg ? Math.round(co.avg) : "—", "Avg. attendance"]].forEach(([v, l], j) => {
      s.addText(String(v), { x: x + 0.25 + j * 1.75, y: 2.3, w: 1.7, h: 0.7, fontFace: HF, fontSize: 30, bold: true, color: BLUE });
      s.addText(l, { x: x + 0.25 + j * 1.75, y: 3.0, w: 1.7, h: 0.3, fontFace: BF, fontSize: 10, color: MUT }); });
    s.addText(co.kinds.map((kk) => `${kk.kind}: ${kk.n} session${kk.n === 1 ? "" : "s"}, avg ${Math.round(kk.avg)}`).join("\n") + (co.cancelled ? `\n${co.cancelled} cancelled` : ""), { x: x + 0.25, y: 3.45, w: 3.4, h: 2.3, fontFace: BF, fontSize: 11, color: INK, valign: "top" }); });
  if (D.notes.corporate) s.addText(D.notes.corporate, { x: 0.7, y: 6.15, w: 11.9, h: 0.6, fontFace: BF, fontSize: 11, color: MUT });

  // strategy & next
  s = base("Strategy · what's next", "Strategy & what's next");
  card(s, 0.7, 1.6, 5.9, 4.9); card(s, 6.85, 1.6, 5.75, 4.9);
  s.addText([{ text: "Strategy this period\n", options: { bold: true, fontSize: 13, color: BLUE } }, { text: D.notes.strategy || "—", options: { fontSize: 12 } }], { x: 0.95, y: 1.8, w: 5.4, h: 4.5, fontFace: BF, color: INK, valign: "top" });
  s.addText([{ text: "Coming up\n", options: { bold: true, fontSize: 13, color: BLUE } },
    ...D.upcoming.map((u) => ({ text: `${fmtDate(u.d).replace(/ \d{4}$/, "")}  ${u.title}${u.location ? " · " + u.location : ""}\n`, options: { fontSize: 12 } })),
    ...(D.notes.next_steps ? [{ text: "\n" + D.notes.next_steps, options: { fontSize: 12 } }] : [])], { x: 7.1, y: 1.8, w: 5.3, h: 4.5, fontFace: BF, color: INK, valign: "top" });

  // summary
  s = base(D.per.label, "Summary");
  const sumRows = [["Participation", nf(k.rideAttendance), `Across ${nf(k.rideSessions)} rides. AUH ${A.share}%, DXB ${X.share}%.`], ["Community growth", `+${nf(k.newMembers)}`, `${nf(D.firstRiders)} first-time riders.`],
    ["Activations", `${D.done.length} events`, `${nf(D.evPeople)} participants.`], ["Collaborations", String(D.partners.length), cut(D.partners.map((x) => x.name).join(", "), 80)],
    ["Corporate", `${D.corp.length} programs`, cut(D.corp.map((x) => `${x.name}: ${x.sessions} sessions`).join(". "), 80)], ["Survey", D.survey.avg ? D.survey.avg.toFixed(1) + " / 5" : "—", D.survey.n ? `${D.survey.n} answers` : "No answers."]];
  sumRows.forEach(([l, v, t], i) => { const x = 0.7 + (i % 3) * 4.02, y = 1.6 + Math.floor(i / 3) * 2.5; card(s, x, y, 3.85, 2.3);
    s.addText(l, { x: x + 0.25, y: y + 0.15, w: 3.4, h: 0.3, fontFace: BF, fontSize: 11, bold: true, color: MUT });
    s.addText(v, { x: x + 0.25, y: y + 0.45, w: 3.4, h: 0.65, fontFace: HF, fontSize: 26, bold: true, color: BLUE });
    s.addText(t, { x: x + 0.25, y: y + 1.15, w: 3.4, h: 1, fontFace: BF, fontSize: 11, color: INK, valign: "top" }); });

  return p.write({ outputType: "nodebuffer" });
}

// =====================================================================================================  routes
module.exports = function report(app, { need, page, setFlash, actor, user, wrap }) {
  const READ = need("admin", "coordinator", "viewer");
  const canEdit = (req) => ["admin", "coordinator"].includes(user(req).role);
  const qs = (per) => `period=${per.type}&p=${encodeURIComponent(per.p)}`;

  app.get("/report", READ, wrap(async (req, res) => {
    const per = periodOf(req.query);
    const D = await reportData(per);
    const today = R.todayLocal();
    const monthOpts = H.monthsBetween("2025-01", today.slice(0, 7)).reverse().map((m) => `<option value="${m}" ${per.type === "month" && per.p === m ? "selected" : ""}>${monLabel(m, true)}</option>`).join("");
    const qOpts = []; for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) qOpts.push(`${y}-Q${q}`);
    const yOpts = []; for (let y = +today.slice(0, 4); y >= 2025; y--) yOpts.push(String(y));
    const sel = (type, opts) => `<form method="get" class="toolbar" style="margin:0"><input type="hidden" name="period" value="${type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="${KIND[type]} report">${opts}</select></form>`;
    const N = D.notes;
    res.send(page(req, `${per.kind} report`, `
      <section class="card noprint"><div class="card-head"><div><h2>WMF ${h(per.kind.toLowerCase())} report · ${h(per.label)}</h2>
          <p class="lead">Built from the rides, events, activations, surveys, social counts and corporate sessions in the app, in the layout of the WMF Canva report.</p></div>
          <div class="toolbar" style="margin:0"><a class="btn" href="/report/management?${qs(per)}">Management (1 page)</a><a class="btn" href="/report/marketing?${qs(per)}">Marketing report &amp; Excel</a><button class="btn" data-print>Save as PDF</button><a class="btn primary" href="/report.pptx?${qs(per)}">Download for Canva (PowerPoint)</a></div></div>
        <div class="toolbar" style="gap:14px;margin:6px 0 0;align-items:center">
          <span class="seg">${["month", "quarter", "year"].map((t) => `<a href="/report?period=${t}" class="${per.type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
          ${per.type === "month" ? sel("month", monthOpts) : per.type === "quarter" ? sel("quarter", qOpts.map((q) => `<option ${q === per.p ? "selected" : ""} value="${q}">${q.replace("-", " ")}</option>`).join("")) : sel("year", yOpts.map((y) => `<option ${y === per.p ? "selected" : ""}>${y}</option>`).join(""))}</div>
        <details class="rp-howto"><summary><b>Put it in Canva</b></summary><ol>
          <li>Download for Canva (PowerPoint).</li><li>In Canva: <b>Create a design → Import file</b> and choose the downloaded file. Every slide comes in as editable text and shapes.</li>
          <li>Swap in photos and your template's backgrounds, then share or download from Canva. Or use <b>Save as PDF</b> above for a ready-made version.</li></ol></details></section>
      ${canEdit(req) ? `<section class="card noprint"><h2>Your words in the report</h2><p class="lead">Saved for ${h(per.label)} only.</p>
        <form class="form" method="post" action="/report/notes"><input type="hidden" name="period" value="${h(per.key)}"><input type="hidden" name="back" value="/report?${qs(per)}">
          <div class="row2"><label>Strategy used this period<textarea name="strategy" rows="4" maxlength="1500" placeholder="e.g. Partnered with wellness studios to reach women new to cycling; moved the long ride to Sunday for the winter timetable.">${h(N.strategy)}</textarea></label>
            <label>What's next <span class="hint">(upcoming events from the calendar are added already)</span><textarea name="next_steps" rows="4" maxlength="1500">${h(N.next_steps)}</textarea></label></div>
          <label>Corporate note <span class="hint">(one or two lines, e.g. why attendance changed)</span><input name="corporate" maxlength="400" value="${h(N.corporate)}"></label>
          <button class="btn primary">Save notes</button></form>
        <p class="hint" style="margin:8px 0 0">Missing an event or a figure? Fix it on <a href="/activations">Activations</a> or <a href="/social">Social growth</a> and it updates here.</p></section>` : ""}
      <div class="rp-deck">${slides(D)}</div>`, { active: "/report" }));
  }));

  app.post("/report/notes", need("admin", "coordinator"), wrap(async (req, res) => {
    const b = req.body || {}, key = String(b.period || "");
    if (!/^(month|quarter|year):[\dQ-]+$/.test(key)) return res.redirect("/report");
    const t = (v, n) => String(v || "").replace(/\r/g, "").trim().slice(0, n) || null;
    await pool.query(`INSERT INTO report_notes (period, strategy, next_steps, corporate, updated_by) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (period) DO UPDATE SET strategy = EXCLUDED.strategy, next_steps = EXCLUDED.next_steps, corporate = EXCLUDED.corporate, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, t(b.strategy, 1500), t(b.next_steps, 1500), t(b.corporate, 400), actor(req)]);
    setFlash(req, "ok", "Notes saved.");
    const back = String(b.back || "/report");
    res.redirect(back.startsWith("/report?") ? back : "/report");
  }));

  app.get("/report.pptx", READ, wrap(async (req, res) => {
    const per = periodOf(req.query);
    const buf = await pptx(await reportData(per));
    res.type("application/vnd.openxmlformats-officedocument.presentationml.presentation")
      .set("Content-Disposition", `attachment; filename="WMF-${per.kind}-Report-${per.p}.pptx"`).send(buf);
  }));
};
module.exports.reportData = reportData;
module.exports.periodOf = periodOf;
