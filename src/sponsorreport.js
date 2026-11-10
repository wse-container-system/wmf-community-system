"use strict";
/**
 * Corporate sponsor report for management: what we delivered for each sponsor (sessions held against planned),
 * how many of their staff took part and keep coming, and how it is growing. Also a short version for the WMF report.
 */
const { pool } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const E = require("./engine");
const { h, nf, fmtDate, monLabel, mini, detailTiles } = require("./views");
const { columns, hbars, spark } = require("./charts");

const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const ch = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
const arrow = (d, word = "vs before") => (d == null ? "" : d === 0 ? `no change ${word}` : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}% ${word}`);
const FIELDS = [["highlights", "Highlights for our sponsors"], ["next", "Next month"]];

/** Everything the report shows, for a period from periodOf(). */
async function sponsorData(per) {
  const cos = await C.companies(pool), codes = cos.map((c) => c.code), byCode = Object.fromEntries(cos.map((c) => [c.code, c]));
  const today = R.todayLocal(), H = E.helpers;
  const days = Math.round((Date.parse(per.end) - Date.parse(per.start)) / 864e5) + 1;
  const prevEnd = H.addDays(per.start, -1), prevStart = H.addDays(prevEnd, -(days - 1));
  const [st, pr] = await Promise.all([C.stats({ codes, start: per.start, end: per.end }), C.stats({ codes, start: prevStart, end: prevEnd })]);
  // planned sessions come from each company's schedule (up to today); held ones that weren't on the schedule count as planned too
  const months = st.months;
  const occ = codes.length ? await C.occurrences(pool, codes, months[0].month + "-01", (per.end < today ? per.end : today)) : [];
  const planIn = (code, a, b) => occ.filter((o) => o.sc.company === code && o.date >= a && o.date <= b).length;
  const sponsors = st.byCompany.map((b) => {
    const p = pr.byCompany.find((x) => x.code === b.code) || {};
    const held = b.sessions + b.events, planned = Math.max(planIn(b.code, per.start, per.end), held + b.cancelled);
    const delivery = planned ? held / planned : null, trend = ch(b.attendance, p.attendance);
    const status = !held && !planned ? "No sessions" : (delivery != null && delivery < 0.7) || (trend != null && trend <= -30) ? "Needs attention"
      : (delivery != null && delivery < 0.9) || (trend != null && trend <= -10) ? "Watch" : trend != null && trend >= 10 ? "Growing" : "On track";
    return { ...b, name: (byCode[b.code] || {}).name || b.code, color: (byCode[b.code] || {}).color || "#5b7cf0", held, planned, delivery, trend, status,
      avgAll: held ? b.attendance / held : null, prev: p, activeShare: b.roster ? b.active / b.roster : null };
  });
  const monthly = months.map((m) => ({ ...m, planned: Math.max(codes.reduce((s, code) => s + planIn(code, m.month + "-01", H.monthEnd(m.month)), 0), m.rides + m.events + m.cancelled) }));
  // engagement: enrolled → took part → came 2+ times → champions (about weekly: 4+ a month)
  const months_n = Math.max(1, months.filter((m) => m.inRange).length);
  const counts = new Map(); for (const p of st.participants.values()) { const n = p.dates.filter((d) => d >= per.start && d <= per.end).length; if (n) counts.set(p.id, n); }
  const champ = 4 * months_n;
  const funnel = { enrolled: st.k.roster, tookPart: st.k.people, regulars: [...counts.values()].filter((n) => n >= 2).length, champions: [...counts.values()].filter((n) => n >= champ).length, champ };
  const k = st.k, kp = pr.k;
  const T = {
    held: sponsors.reduce((s, x) => s + x.held, 0), planned: sponsors.reduce((s, x) => s + x.planned, 0),
    attendance: k.attendance, prevAttendance: kp.attendance, people: k.people, prevPeople: kp.people, newJoiners: k.newJoiners, prevNew: kp.newJoiners,
    repeatRate: k.repeatRate, avg: null, cancelled: k.cancelled,
  };
  T.avg = T.held ? T.attendance / T.held : null;
  const saved = (await pool.query("SELECT mgmt FROM report_notes WHERE period = $1", ["corp:" + per.key])).rows[0];
  const S = { per, sponsors, monthly, funnel, mix: st.byKind, T, saved: (saved && saved.mgmt) || {}, upcoming: await upcoming(codes, byCode, per) };
  S.draft = drafts(S);
  S.text = Object.fromEntries(FIELDS.map(([f]) => [f, S.saved[f] != null && String(S.saved[f]).trim() !== "" ? S.saved[f] : S.draft[f]]));
  return S;
}

/** What's planned for the month after the period (for "Next month"). */
async function upcoming(codes, byCode, per) {
  const H = E.helpers, m = H.addMonths(per.end.slice(0, 7), 1);
  const occ = codes.length ? await C.occurrences(pool, codes, m + "-01", H.monthEnd(m)) : [];
  const evs = (await pool.query("SELECT company, session_date::text AS d, title, kind FROM corp_sessions WHERE company = ANY($1) AND session_date BETWEEN $2 AND $3 AND kind <> $4 AND status <> 'Cancelled' ORDER BY session_date",
    [codes, m + "-01", H.monthEnd(m), C.RIDE])).rows;
  const per_co = codes.map((code) => ({ code, name: (byCode[code] || {}).name || code, n: occ.filter((o) => o.sc.company === code).length })).filter((x) => x.n);
  return { month: m, per_co, events: evs.map((e) => ({ ...e, name: (byCode[e.company] || {}).name || e.company })) };
}

/** Suggested wording, built only from the figures. */
function drafts(S) {
  const T = S.T, hl = [], nx = [];
  const up = S.sponsors.filter((s) => s.trend != null && s.trend >= 10).sort((a, b) => b.trend - a.trend);
  for (const s of up.slice(0, 2)) hl.push(`${s.name}: participation up ${s.trend}% (${nf(s.attendance)} this period).`);
  if (T.planned) hl.push(`${nf(T.held)} of ${nf(T.planned)} planned sessions delivered (${pct(T.held, T.planned)}%).`);
  if (T.newJoiners) hl.push(`${nf(T.newJoiners)} new staff joined the programme.`);
  if (T.repeatRate != null && T.people) hl.push(`${Math.round(T.repeatRate * 100)}% of participants came to two or more sessions.`);
  const best = [...S.sponsors].filter((s) => s.avgAll).sort((a, b) => b.avgAll - a.avgAll)[0];
  if (best) hl.push(`${best.name} has the strongest turnout: ${best.avgAll.toFixed(1)} per session.`);
  for (const s of S.sponsors.filter((x) => x.status === "Needs attention" || x.status === "Watch"))
    nx.push(s.delivery != null && s.delivery < 0.9 ? `${s.name}: recover missed sessions (${s.held} of ${s.planned} held).` : `${s.name}: lift participation (${s.trend}% vs before).`);
  for (const e of S.upcoming.events.slice(0, 3)) nx.push(`${fmtDate(e.d)}: ${e.title || e.kind} (${e.name}).`);
  for (const c of S.upcoming.per_co) if (nx.length < 5) nx.push(`${c.name}: ${c.n} session${c.n === 1 ? "" : "s"} planned.`);
  return { highlights: hl.slice(0, 4).join("\n"), next: nx.slice(0, 5).join("\n") };
}

const STATUS_CLS = { "Growing": "good", "On track": "good", "Watch": "warn", "Needs attention": "bad", "No sessions": "" };
const lines = (t) => String(t || "").split(/\r?\n/).map((x) => x.replace(/^[-•*]\s*/, "").trim()).filter(Boolean);
const bullets = (t) => { const l = lines(t); return l.length ? `<ul class="md-list">${l.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : '<p class="muted">—</p>'; };

/** The full report. opts: nav (period picker), pdf (button), edit ({ action, back } for the team), back (link above). */
function sponsorHtml(S, { nav = "", pdf = "", edit = null, back = "" } = {}) {
  const T = S.T, per = S.per;
  const sp = (k) => S.monthly.map((m) => m[k]);
  const tiles = [
    { label: "Sessions delivered", value: nf(T.held), note: T.planned ? `${pct(T.held, T.planned)}% of ${nf(T.planned)} planned${spark(S.monthly.map((m) => m.rides + m.events), "#5b7cf0")}` : "",
      detail: { title: "Sessions held against planned", html: mini(["Sponsor", "Held", "Planned", "Cancelled"], S.sponsors.map((s) => [h(s.name), nf(s.held), nf(s.planned), nf(s.cancelled)]), { num: [1, 2, 3] }) } },
    { label: "Participations", value: nf(T.attendance), note: `${arrow(ch(T.attendance, T.prevAttendance))}${spark(sp("attendance"), "#5b7cf0")}`,
      detail: { title: "Participations by sponsor", html: mini(["Sponsor", "This period", "Before", "Change"], S.sponsors.map((s) => [h(s.name), nf(s.attendance), nf(s.prev.attendance || 0), s.trend == null ? "—" : `${s.trend > 0 ? "+" : ""}${s.trend}%`]), { num: [1, 2, 3] }) } },
    { label: "Avg per session", value: T.avg != null ? T.avg.toFixed(1) : "—", note: "participants per session held",
      detail: { title: "Average participation per session", html: mini(["Sponsor", "Sessions held", "Avg per session"], S.sponsors.map((s) => [h(s.name), nf(s.held), s.avgAll != null ? s.avgAll.toFixed(1) : "—"]), { num: [1, 2] }) } },
    { label: "Staff reached", value: T.people || !T.attendance ? nf(T.people) : "—", note: T.people || !T.attendance ? ["unique people", arrow(ch(T.people, T.prevPeople))].filter(Boolean).join(" · ") : "headcount only (no names recorded)",
      detail: { title: "Staff reached", html: mini(["Sponsor", "Staff reached", "Enrolled", "Active (2+ in 90 days)"], S.sponsors.map((s) => [h(s.name), nf(s.people), nf(s.roster), nf(s.active)]), { num: [1, 2, 3] }) } },
    { label: "Regulars", value: T.repeatRate != null ? Math.round(T.repeatRate * 100) + "%" : "—", note: "came 2+ times",
      detail: { title: "How engaged staff are", html: `<p class="hint">${nf(S.funnel.regulars)} of ${nf(T.people)} people came to two or more sessions in ${h(per.label)}.</p>` } },
    { label: "New staff joined", value: nf(T.newJoiners), note: `${arrow(ch(T.newJoiners, T.prevNew))}${spark(sp("people"), "#1baf7a")}`,
      detail: { title: "New staff", html: `<p class="hint">Staff whose first session was in ${h(per.label)}.</p>` } },
  ];
  const card = (s) => `<article class="sr-sp"><div class="sr-h"><b>${h(s.name)}</b><span class="badge ${STATUS_CLS[s.status] || ""}">${h(s.status)}</span></div>
      <dl class="sr-dl"><dt>Sessions held</dt><dd>${nf(s.held)}${s.planned ? ` / ${nf(s.planned)}` : ""}</dd><dt>Participations</dt><dd>${nf(s.attendance)}</dd>
        <dt>Avg per session</dt><dd>${s.avgAll != null ? s.avgAll.toFixed(1) : "—"}</dd><dt>Staff reached</dt><dd>${s.people || !s.attendance ? nf(s.people) : "—"}</dd></dl>
      ${s.activeShare != null ? `<div class="sr-m"><i style="width:${Math.min(100, Math.round(s.activeShare * 100))}%;background:${s.status === "Watch" || s.status === "Needs attention" ? "#e8a33a" : "#1d9e75"}"></i></div>
        <p class="hint" style="margin:2px 0 0">${Math.round(s.activeShare * 100)}% of ${nf(s.roster)} enrolled staff active${s.cancelled ? ` · ${nf(s.cancelled)} cancelled` : ""}</p>` : ""}
      ${s.trend != null ? `<p class="hint" style="margin:2px 0 0">${arrow(s.trend)}</p>` : ""}</article>`;
  const fun = S.funnel, fmax = Math.max(1, fun.enrolled, fun.tookPart);
  const frow = (l, v, c) => `<div class="sr-f"><span>${l}</span><span class="sr-ft"><i style="width:${Math.max(v ? 2 : 0, (v / fmax) * 100)}%;background:${c}"></i></span><b>${nf(v)}</b></div>`;
  const inR = S.monthly.filter((m) => m.inRange || S.monthly.length <= 6);
  const editor = edit ? `<section class="card noprint"><details class="mg-edit"><summary><b>Edit the words</b> <span class="muted">(${h(per.label)} · one point per line)</span></summary>
      <form class="form" method="post" action="${h(edit.action)}"><input type="hidden" name="period" value="${h(per.key)}"><input type="hidden" name="back" value="${h(edit.back)}">
        <div class="mg-fields">${FIELDS.map(([f, l]) => `<label>${h(l)}${S.saved[f] == null || !String(S.saved[f]).trim() ? ' <span class="badge">Suggested</span>' : ""}<textarea name="${f}" rows="4" maxlength="1200">${h(S.text[f])}</textarea></label>`).join("")}</div>
        <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn" name="reset" value="1">Back to the suggested text</button></div></form></details></section>` : "";
  return `${back}<section class="mk-head"><div><div class="wc-eyebrow">Corporate cycling programme · sponsor report</div><h2 class="ov-title">${h(per.label)}</h2>
      <p class="lead" style="margin:4px 0 0">What we delivered for each sponsor, how many of their staff take part, and how it is growing.</p></div>
      <div class="mk-actions">${nav}${pdf}</div></section>
    ${detailTiles(tiles, { cls: "tiles ov-tiles mk-tiles md-tiles" })}
    <section class="card"><h2>Sponsor scorecard</h2><p class="hint" style="margin:2px 0 10px">What we delivered for each sponsor in ${h(per.label)}</p>
      <div class="sr-sc">${S.sponsors.map(card).join("") || '<p class="muted">No corporate partners yet.</p>'}</div></section>
    <div class="grid md-graphs">
      <section class="card c6 md-g"><h2>Participation by month</h2><p class="hint">Per sponsor</p>
        ${columns({ categories: inR.map((m) => m.month), short: (m) => monLabel(m), height: 190, label: "Participation by month per sponsor", series: S.sponsors.map((s) => ({ name: s.name, color: s.color, values: inR.map((m) => m.byCo[s.code] || 0) })) })}</section>
      <section class="card c6 md-g"><h2>Sessions delivered vs planned</h2><p class="hint">How reliably the programme runs</p>
        ${columns({ categories: inR.map((m) => m.month), short: (m) => monLabel(m), height: 190, stacked: false, label: "Sessions delivered vs planned",
          series: [{ name: "Delivered", color: "#2f5fb3", values: inR.map((m) => m.rides + m.events) }, { name: "Planned", color: "#c6d6f5", values: inR.map((m) => m.planned) }] })}</section>
      <section class="card c6 md-g"><h2>Staff engagement</h2><p class="hint">From enrolled staff to regulars · ${h(per.label)}</p>
        ${frow("Enrolled", fun.enrolled, "#c6d6f5")}${frow("Took part", fun.tookPart, "#8fb3ef")}${frow("Came 2+ times", fun.regulars, "#5b7cf0")}${frow(`Champions (${fun.champ}+)`, fun.champions, "#2f5fb3")}</section>
      <section class="card c6 md-g"><h2>Activity mix</h2><p class="hint">Participations by activity</p>
        ${hbars(S.mix.map((x) => ({ name: x.name, value: x.value, color: "#5b7cf0" })), { empty: "No sessions in this period." })}</section>
    </div>
    <div class="grid">
      <section class="card c6"><h2>Highlights for our sponsors</h2>${bullets(S.text.highlights)}</section>
      <section class="card c6"><h2>Next month</h2>${bullets(S.text.next)}</section>
    </div>
    ${editor}
    <p class="muted" style="font-size:13px">Figures from the corporate check-ins and schedules. Planned sessions come from each company's schedule; cancelled sessions count as planned but not delivered.</p>`;
}

/** The short version inside the WMF management report. */
function sponsorSummaryHtml(S, fullHref) {
  const T = S.T;
  if (!S.sponsors.length) return "";
  return `<section class="card c12"><h2>Corporate programme</h2><p class="hint" style="margin:2px 0 10px">Sponsor performance at a glance${fullHref ? ` · <a href="${h(fullHref)}">Open the full corporate report</a>` : ""}</p>
    ${mini(["Sponsor", "Sessions held", "Participations", "Avg per session", "Staff reached", "Status"], S.sponsors.map((s) => [h(s.name), `${nf(s.held)}${s.planned ? ` / ${nf(s.planned)}` : ""}`, nf(s.attendance),
      s.avgAll != null ? s.avgAll.toFixed(1) : "—", s.people || !s.attendance ? nf(s.people) : "—", `<span class="badge ${STATUS_CLS[s.status] || ""}">${h(s.status)}</span>`]), { num: [1, 2, 3, 4] })}
    <p class="hint" style="margin:8px 0 0">${nf(T.held)} of ${nf(T.planned)} sessions delivered${T.planned ? ` (${pct(T.held, T.planned)}%)` : ""} · ${nf(T.attendance)} participations · ${T.avg != null ? T.avg.toFixed(1) : "—"} per session${T.people ? ` · ${nf(T.people)} staff reached` : ""}</p></section>`;
}

/** Save the words (team only). */
async function saveWords(b, by) {
  const key = String(b.period || "");
  if (!/^(month|quarter|year):[\dQ-]+$/.test(key)) return false;
  const v = b.reset ? null : Object.fromEntries(FIELDS.map(([f]) => [f, String(b[f] || "").replace(/\r/g, "").trim().slice(0, 1200)]));
  await pool.query(`INSERT INTO report_notes (period, mgmt, updated_by) VALUES ($1, $2, $3) ON CONFLICT (period) DO UPDATE SET mgmt = EXCLUDED.mgmt, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    ["corp:" + key, v ? JSON.stringify(v) : null, by]);
  return true;
}

module.exports = { sponsorData, sponsorHtml, sponsorSummaryHtml, saveWords };
