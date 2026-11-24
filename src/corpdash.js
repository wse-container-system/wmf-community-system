"use strict";
/**
 * One dashboard per corporate partner, all in the same format: /corporate?company=LIMAD&season=12&tab=overview
 *   Company tabs (one per partner) → season picker (each season is its own list of people) → section tabs.
 * Every figure is for the chosen season only: its sessions (by date) and the people on its list.
 * A season never copies people from another one; people join a season by registering, by being on its uploaded list,
 * or by coming to one of its sessions.
 * L'imad adds its own sections (Department League, Registration, Annual framework) from limad.js.
 */
const { pool } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const { h, fmtDate, nf, STAFF } = require("./views");
const { columns, hbars } = require("./charts");
const { addDays, monthsBetween } = require("./engine").helpers;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dd = (d) => `${+d.slice(8, 10)} ${MON[+d.slice(5, 7) - 1]}`;
const pct = (r) => (r == null ? "—" : Math.round(r * 100) + "%");
const first = (s) => String(s || "").trim().split(/\s+/)[0];
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== "")).toString();

/** Partner logos (public/brand/corp), each on the plate its brand uses: L'imad and NMDC on white, Aurora on black. */
const LOGOS = { LIMAD: { src: "/brand/corp/limad.png", plate: "#ffffff" }, NMDC: { src: "/brand/corp/nmdc.png", plate: "#ffffff" }, AURORA: { src: "/brand/corp/aurora.png", plate: "#000000" } };
const logo = (co, cls = "") => { const l = LOGOS[co.code]; return l ? `<span class="cd-logo ${cls}" style="--co:${h(co.color || "#4a5bc4")};--plate:${l.plate}"><img src="${l.src}" alt="${h(co.name)}"></span>` : ""; };
/** The company tabs at the top of the corporate dashboard. */
const companyTabs = (list, cur) => `<nav class="cd-cos" aria-label="Companies">${list.length > 1 ? `<a href="/corporate" ${!cur ? 'aria-current="page"' : ""}><span class="cd-all">All companies</span></a>` : ""}${list.map((c) => `<a href="/corporate?company=${h(c.code)}" style="--co:${h(c.color || "var(--accent)")}" ${cur && c.code === cur.code ? 'aria-current="page"' : ""}${LOGOS[c.code] ? ` title="${h(c.name)}"` : ""}>${LOGOS[c.code] ? logo(c, "sm") : `<i></i>${h(c.name)}`}</a>`).join("")}</nav>`;

/** Running, upcoming or ended, for the season chip. */
function seasonState(se, today) {
  if (!se) return { key: "all", text: "Whole programme" };
  if (se.start > today) return { key: "up", text: `Starts ${fmtDate(se.start)}` };
  if (se.end < today) return { key: "end", text: "Ended" };
  return { key: "on", text: "Running now" };
}

/** A ring for one share (0–1). The number sits in the middle so it reads without a legend. */
function ring(share, { label = "", color = "var(--lm)", size = 132 } = {}) {
  const r = 52, c = 2 * Math.PI * r, v = share == null ? 0 : Math.max(0, Math.min(1, share));
  return `<svg class="cd-ring" viewBox="0 0 132 132" width="${size}" height="${size}" role="img" aria-label="${h(label)}: ${pct(share)}">
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="var(--line)" stroke-width="12"/>
    ${v ? `<circle cx="66" cy="66" r="${r}" fill="none" stroke="${color}" stroke-width="12" stroke-linecap="round" stroke-dasharray="${(c * v).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 66 66)"/>` : ""}
    <text x="66" y="66" text-anchor="middle" dominant-baseline="central" class="cd-ring-v">${pct(share)}</text></svg>`;
}

/**
 * Everything for one company and one season (or the whole programme when the company has no seasons).
 * Sessions are the season's by date; people are those on the season's list plus anyone who came to one of its sessions.
 */
async function seasonData(co, se, today = R.todayLocal()) {
  const start = se ? se.start : (await pool.query("SELECT coalesce(min(session_date), $2::date)::text d FROM corp_sessions WHERE company = $1", [co.code, today])).rows[0].d;
  const end = se ? se.end : today, to = end < today ? end : today;
  const sess = (await pool.query(`SELECT s.*, s.session_date::text d, (SELECT count(*) FROM corp_attendance a WHERE a.session_id = s.id)::int AS named FROM corp_sessions s
    WHERE s.company = $1 AND s.session_date BETWEEN $2 AND $3 ORDER BY s.session_date, s.start_time NULLS LAST, s.id`, [co.code, start, end])).rows
    .map((s) => ({ ...s, attendance: s.status === "Cancelled" ? 0 : s.named || s.headcount || 0 }));
  const att = (await pool.query(`SELECT a.participant_id pid, a.session_id sid, s.session_date::text d FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id
    WHERE s.company = $1 AND s.session_date BETWEEN $2 AND $3 AND s.status <> 'Cancelled' ORDER BY s.session_date`, [co.code, start, end])).rows;
  const memberIds = se ? (await pool.query("SELECT participant_id FROM corp_season_members WHERE season_id = $1", [se.id])).rows.map((r) => r.participant_id)
    : (await pool.query("SELECT id FROM corp_participants WHERE company = $1 AND status = 'Active'", [co.code])).rows.map((r) => r.id);
  const ids = [...new Set([...memberIds, ...att.map((a) => a.pid)])];
  const people = new Map((await pool.query("SELECT * FROM corp_participants WHERE id = ANY($1)", [ids])).rows.map((p) => [p.id, { ...p, dates: [], sids: new Set() }]));
  for (const a of att) { const p = people.get(a.pid); if (p) { p.dates.push(a.d); p.sids.add(a.sid); } }
  const held = sess.filter((s) => s.status === "Held" && s.d <= to), rides = held.filter((s) => s.kind === C.RIDE);
  const cancelled = sess.filter((s) => s.status === "Cancelled");
  const ppl = [...people.values()], came = ppl.filter((p) => p.dates.length);
  const total = held.reduce((t, s) => t + s.attendance, 0), rideTotal = rides.reduce((t, s) => t + s.attendance, 0);
  // month by month: people who came for the first time this season, and people who came again
  const months = held.length ? monthsBetween(start.slice(0, 7), to.slice(0, 7)) : [];
  const monthly = months.map((m) => {
    const here = came.filter((p) => p.dates.some((d) => d.startsWith(m)));
    const fresh = here.filter((p) => p.dates[0].startsWith(m)).length;
    return { m, people: here.length, fresh, again: here.length - fresh, attendance: held.filter((s) => s.d.startsWith(m)).reduce((t, s) => t + s.attendance, 0) };
  });
  const freq = [["1 session", (n) => n === 1], ["2–3", (n) => n >= 2 && n <= 3], ["4–6", (n) => n >= 4 && n <= 6], ["7 or more", (n) => n >= 7]]
    .map(([name, f]) => ({ name, value: came.filter((p) => f(p.dates.length)).length }));
  return {
    start, end, to, sessions: sess, held, rides, cancelled, people: ppl, came,
    k: { list: ppl.length, came: came.length, sessions: held.length, rides: rides.length, cancelled: cancelled.length, attendance: total,
      avg: rides.length ? rideTotal / rides.length : held.length ? total / held.length : null, participation: ppl.length ? came.length / ppl.length : null,
      again: came.filter((p) => p.dates.length >= 2).length, retention: came.length ? came.filter((p) => p.dates.length >= 2).length / came.length : null,
      recent: came.filter((p) => p.dates[p.dates.length - 1] > addDays(today, -30)).length },
    monthly, freq,
  };
}

/** Upcoming sessions for a company (schedule + one-offs), for the "Coming up" list. */
async function upcoming(co, from, days = 21, n = 5, until = null) {
  let to = addDays(from, days); if (until && until < to) to = until;
  if (to < from) return [];
  const today = from;
  const occ = await C.occurrences(pool, [co.code], today, to);
  const extra = (await pool.query("SELECT *, session_date::text d FROM corp_sessions WHERE company = $1 AND session_date BETWEEN $2 AND $3", [co.code, today, to])).rows
    .filter((s) => !occ.some((o) => o.session && o.session.id === s.id));
  return [...occ.map((o) => ({ d: o.date, name: C.schedName(o.sc, co), time: (o.session && o.session.start_time) || o.sc.start_time, cancelled: o.session && o.session.status === "Cancelled", id: o.session && o.session.id, weekday: o.sc.weekday, kind: o.sc.kind })),
    ...extra.map((s) => ({ d: s.d, name: C.sessionName(s, co), time: s.start_time, cancelled: s.status === "Cancelled", id: s.id, kind: s.kind }))]
    .sort((a, b) => a.d.localeCompare(b.d) || String(a.time || "").localeCompare(String(b.time || ""))).slice(0, n);
}
const upList = (up, today, named, tag = () => "") => up.length ? `<ul class="lm-up">${up.map((x) => `<li><span class="lm-date"><b>${+x.d.slice(8)}</b>${MON[+x.d.slice(5, 7) - 1]}</span>
  <span class="lm-what"><b>${named && x.id ? `<a href="/corporate/session/${x.id}">${h(x.name)}</a>` : h(x.name)}</b><small>${DAY[new Date(x.d + "T12:00:00Z").getUTCDay()]}${x.time ? " · " + h(x.time) : ""}${x.d === today ? " · today" : ""}</small></span>
  ${x.cancelled ? '<span class="status-chip st-Cancelled">Cancelled</span>' : tag(x)}</li>`).join("")}</ul>` : '<p class="muted">Nothing planned in the next three weeks.</p>';

// ------------------------------------------------------------------ sections
function overviewTab({ co, se, D, today, named, up, extra = "", tagUp }) {
  const k = D.k, st = seasonState(se, today);
  const tiles = `<div class="tiles lm-tiles cd-tiles">
    <div class="tile big"><span class="lbl">On the season list</span><span class="val">${nf(k.list)}</span><span class="note">${k.list ? `${nf(k.came)} came at least once` : "Nobody yet"}</span></div>
    <div class="tile big"><span class="lbl">Sessions held</span><span class="val">${nf(k.sessions)}</span><span class="note">${k.cancelled ? `${nf(k.cancelled)} cancelled` : "None cancelled"}</span></div>
    <div class="tile big"><span class="lbl">Average per ride</span><span class="val">${nf(k.avg, 1)}</span><span class="note">${nf(k.attendance)} check-ins in total</span></div>
    <div class="tile big"><span class="lbl">Came back</span><span class="val">${pct(k.retention)}</span><span class="note">${k.came ? `${nf(k.again)} of ${nf(k.came)} came 2+ times` : "Share who return for a 2nd session"}</span></div></div>`;
  if (!D.held.length) {
    return `${tiles}<div class="grid" style="margin-top:14px">
      <section class="card c7 cd-empty"><span class="cd-empty-ic" aria-hidden="true">○</span><h2>No records yet</h2>
        <p class="lead">${se ? `${h(se.name)} ${st.key === "up" ? `starts on <b>${h(fmtDate(se.start))}</b>` : "has no sessions recorded yet"}. It starts with an empty list: nobody is carried over from an earlier season.` : "Nothing recorded yet."}</p>
        <p class="muted" style="margin:0">People join ${se ? "this season" : "the programme"} when they register${co.code === "LIMAD" ? " with the form" : ""}, are on an uploaded list, or come to one of its rides. Figures and charts appear after the first session.</p>
        ${k.list ? `<p style="margin:10px 0 0"><span class="lm-chip">Signed up so far <b>${nf(k.list)}</b></span></p>` : ""}</section>
      <section class="card c5"><h2>${st.key === "up" ? "First sessions" : "Coming up"}</h2>${upList(up, today, named, tagUp)}</section></div>${extra}`;
  }
  const perSession = D.held.length <= 18;
  const color = co.color || "var(--s1)";
  const trend = perSession
    ? columns({ categories: D.held.map((s) => s.d), short: (c) => dd(c), label: "Attendance at each session", series: [{ name: "Attendance", color, values: D.held.map((s) => s.attendance) }] })
    : columns({ categories: D.monthly.map((m) => m.m), short: (m) => MON[+m.slice(5) - 1], label: "Attendance by month", series: [{ name: "Attendance", color, values: D.monthly.map((m) => m.attendance) }] });
  const monthly = D.monthly.length ? columns({ categories: D.monthly.map((m) => m.m), short: (m) => MON[+m.slice(5) - 1] + " ’" + m.slice(2, 4), label: "People each month",
    series: [{ name: "First time this season", color: `color-mix(in srgb, ${color} 38%, var(--surface))`, values: D.monthly.map((m) => m.fresh) }, { name: "Came again", color, values: D.monthly.map((m) => m.again) }] }) : "";
  const regular = named ? D.came.slice().sort((a, b) => b.dates.length - a.dates.length || a.full_name.localeCompare(b.full_name)).slice(0, 6) : [];
  const lapsed = named ? D.came.filter((p) => p.dates.length >= 2 && p.dates[p.dates.length - 1] < addDays(today, -45)).sort((a, b) => b.dates.length - a.dates.length).slice(0, 6) : [];
  const nameRow = (p, right) => `<li><a href="/corporate/participants/${encodeURIComponent(p.pid)}">${h(p.full_name)}</a><span>${right}</span></li>`;
  return `${tiles}
    <div class="grid" style="margin-top:14px">
      <section class="card c8"><h2>${perSession ? "Attendance at each session" : "Attendance by month"}</h2><p class="lead">${h(se ? se.name : "Whole programme")}${D.to < D.end ? ", so far" : ""}.</p>${trend}</section>
      <section class="card c4 cd-ringcard"><h2>Participation</h2><p class="lead">Share of the season list who came to at least one session.</p>
        <div class="cd-ringrow">${ring(D.k.participation, { label: "Participation", color })}<div><b>${nf(k.came)}</b> of ${nf(k.list)}<br><span class="muted">came at least once</span></div></div>
        <h3 class="lm-h3">How often people came</h3>${hbars(D.freq, { color })}</section>
      <section class="card ${st.key === "end" ? "c12" : "c7"}"><h2>People each month</h2><p class="lead">New faces and people coming back: the retention picture month by month.</p>${monthly}</section>
      ${st.key === "end" ? "" : `<section class="card c5"><h2>Coming up</h2>${upList(up, today, named, tagUp)}</section>`}
      ${named ? `<section class="card c6"><h2>Most regular</h2><ul class="cd-names">${regular.map((p) => nameRow(p, `${nf(p.dates.length)} sessions`)).join("") || '<li class="muted">Nobody yet.</li>'}</ul></section>
      <section class="card c6"><h2>Follow up</h2><p class="lead">Came twice or more, nothing in the last 45 days.</p><ul class="cd-names">${lapsed.map((p) => nameRow(p, `last ${dd(p.dates[p.dates.length - 1])}`)).join("") || '<li class="muted">Nobody to follow up.</li>'}</ul></section>` : ""}
    </div>${extra}`;
}

/** Attendance, minimal: one card per session (who came), or one line per person (a dot per session). */
function attendanceTab({ co, se, D, today, named, view, month, base, todayBox }) {
  const months = [...new Set(D.sessions.filter((s) => s.d <= today).map((s) => s.d.slice(0, 7)))];
  const mSel = months.includes(month) ? month : "";
  const list = D.sessions.filter((s) => s.d <= today && (!mSel || s.d.startsWith(mSel))).reverse();
  const people = new Map(D.people.map((p) => [p.id, p]));
  const who = (s) => D.people.filter((p) => p.sids.has(s.id)).sort((a, b) => a.full_name.localeCompare(b.full_name));
  const link = (o) => base({ tab: "attendance", ...o });
  const views = named ? `<div class="cd-seg" role="tablist"><a href="${link({ view: "", month: mSel })}" ${view !== "person" ? 'aria-current="page"' : ""}>By session</a><a href="${link({ view: "person", month: mSel })}" ${view === "person" ? 'aria-current="page"' : ""}>By person</a></div>` : "";
  const chips = months.length > 1 ? `<div class="cd-months"><a href="${link({ view, month: "" })}" ${!mSel ? 'aria-current="page"' : ""}>All</a>${months.map((m) => `<a href="${link({ view, month: m })}" ${m === mSel ? 'aria-current="page"' : ""}>${MON[+m.slice(5) - 1]}</a>`).join("")}</div>` : "";
  const bar = `<div class="cd-attbar">${views}${chips}${named ? `<a class="btn ghost" href="/corporate/export.xlsx?${qs({ company: co.code })}">Download tracker</a>` : ""}</div>`;
  if (!list.length) return `${todayBox || ""}${bar}<section class="card cd-empty"><span class="cd-empty-ic" aria-hidden="true">○</span><h2>No sessions yet</h2><p class="lead">${se && se.start > today ? `${h(se.name)} starts on ${h(fmtDate(se.start))}.` : "Nothing recorded in this season yet."} Each session appears here as a card with who came.</p></section>`;
  if (view === "person" && named) {
    const held = list.filter((s) => s.status === "Held").reverse();
    const rows = D.people.map((p) => ({ p, n: held.filter((s) => p.sids.has(s.id)).length })).sort((a, b) => b.n - a.n || a.p.full_name.localeCompare(b.p.full_name));
    const nNamed = held.filter((s) => s.named).length || 1;
    return `${todayBox || ""}${bar}<section class="card"><div class="card-head"><div><h2>By person</h2><p class="lead">One dot per session${mSel ? ` in ${MON[+mSel.slice(5) - 1]}` : ""}, oldest first. Filled = came.</p></div></div>
      <ul class="cd-people">${rows.map(({ p, n }) => `<li><a class="cd-pn" href="/corporate/participants/${encodeURIComponent(p.pid)}">${h(p.full_name)}</a>
        <span class="cd-dots" aria-label="${n} of ${held.length} sessions">${held.map((s) => `<i class="${p.sids.has(s.id) ? "on" : ""}" title="${h(dd(s.d))}${p.sids.has(s.id) ? ": came" : ""}"></i>`).join("")}</span>
        <span class="cd-pc"><b>${n}</b><small>/${held.length}</small></span><span class="cd-meter"><i style="--w:${Math.round((n / nNamed) * 100)}%"></i></span></li>`).join("") || '<li class="muted">Nobody on the list yet.</li>'}</ul>
      ${held.some((s) => !s.named) ? '<p class="hint" style="margin:8px 0 0">Some sessions only have a headcount (no names), so nobody has a dot for them.</p>' : ""}</section>`;
  }
  const max = Math.max(1, D.k.list, ...list.map((s) => s.attendance));
  const card = (s) => {
    const ws = who(s), wd = DAY[new Date(s.d + "T12:00:00Z").getUTCDay()];
    const head = `<span class="cd-sd"><b>${+s.d.slice(8)}</b>${MON[+s.d.slice(5, 7) - 1]}</span><span class="cd-st"><b>${named && s.id ? `<a href="/corporate/session/${s.id}">${h(C.sessionName(s, co))}</a>` : h(C.sessionName(s, co))}</b><small>${wd}${s.start_time ? " · " + h(s.start_time) : ""}</small></span>`;
    if (s.status === "Cancelled") return `<article class="cd-sess off">${head}<span class="cd-n"><span class="status-chip st-Cancelled">Cancelled</span></span>${s.remarks ? `<p class="cd-who muted">${h(s.remarks)}</p>` : ""}</article>`;
    if (s.status !== "Held") return `<article class="cd-sess off">${head}<span class="cd-n"><span class="status-chip st-Scheduled">Nothing recorded</span></span></article>`;
    const names = named && ws.length ? `<p class="cd-who">${ws.slice(0, 14).map((p) => `<span>${h(first(p.full_name))}</span>`).join("")}${ws.length > 14 ? `<span class="more">+${ws.length - 14}</span>` : ""}</p>` : !s.named ? '<p class="cd-who muted">Headcount only</p>' : "";
    return `<article class="cd-sess">${head}<span class="cd-n"><b>${nf(s.attendance)}</b><small>came</small></span><span class="cd-meter"><i style="--w:${Math.round((s.attendance / max) * 100)}%"></i></span>${names}</article>`;
  };
  return `${todayBox || ""}${bar}<div class="cd-sessions">${list.map(card).join("")}</div>`;
}

function reportsTab({ co, se, D, named, u }) {
  const k = D.k, q = (o) => qs({ company: co.code, ...o }), range = { period: "custom", from: D.start, to: D.to };
  return `<div class="lm-links">
      <a class="lm-link" href="/corporate/report?${q(range)}"><b>Season report</b><span>${h(se ? se.name : "The programme")} on one page, ready to print or save as PDF.</span></a>
      <a class="lm-link" href="/corporate/report?${q({ period: "quarter" })}"><b>Quarterly report</b><span>This quarter compared with the one before.</span></a>
      <a class="lm-link" href="/corporate/report.xlsx?${q(range)}"><b>Season figures (Excel)</b><span>The season report as a workbook.</span></a>
      ${named ? `<a class="lm-link" href="/corporate/export.xlsx?${q({})}"><b>Attendance tracker (Excel)</b><span>Every session and every person.</span></a>` : ""}
      ${co.code === "LIMAD" && named ? `<a class="lm-link" href="/corporate/limad/registrations.xlsx"><b>Registrations (Excel)</b><span>Form answers with department, level, day, kit and emergency contact.</span></a>` : ""}
      ${u.role !== "sponsor" ? `<a class="lm-link" href="/corporate/management?${q({})}"><b>Sponsor report</b><span>The management and sponsor view of the programme.</span></a>` : ""}
    </div><p class="hint" style="margin:10px 0 0">${k.sessions ? `${nf(k.sessions)} sessions and ${nf(k.attendance)} check-ins from ${h(fmtDate(D.start))} to ${h(fmtDate(D.to))}.` : "Reports fill in once the season has sessions."}</p>`;
}

/** Staff: rename a season or move its dates, and add the next one. */
function seasonAdmin(co, se, seas, back) {
  return `<details class="cd-admin"><summary>Seasons: edit dates or add a new one</summary><div class="cd-admin-in">
    ${se ? `<form class="toolbar" method="post" action="/corporate/seasons/${se.id}"><input type="hidden" name="back" value="${h(back)}">
      <label class="f"><span>Season name</span><input class="inp" name="name" required maxlength="80" value="${h(se.name)}"></label>
      <label class="f"><span>From</span><input class="inp" type="date" name="start_date" value="${h(se.start)}" required></label>
      <label class="f"><span>To</span><input class="inp" type="date" name="end_date" value="${h(se.end)}" required></label><button class="btn">Save</button></form>` : ""}
    <form class="toolbar" method="post" action="/corporate/seasons"><input type="hidden" name="company" value="${h(co.code)}"><input type="hidden" name="back" value="${h(back)}">
      <label class="f"><span>New season</span><input class="inp" name="name" required maxlength="80" placeholder="${h(co.name)} 2027/28"></label>
      <label class="f"><span>From</span><input class="inp" type="date" name="start_date" required></label>
      <label class="f"><span>To</span><input class="inp" type="date" name="end_date" required></label><button class="btn">Add season</button></form>
    <p class="hint" style="margin:0">A new season starts with nobody on its list. Sessions belong to the season whose dates they fall in. Manage lists on <a href="/corporate/participants?company=${h(co.code)}">Participants</a>.${seas.length ? "" : " Until a season is added, the dashboard shows the whole programme."}</p></div></details>`;
}

/**
 * The page: company tabs, then the company's season and sections.
 * extraTabs (L'imad): [[key, label, async (ctx) => html]] inserted after Attendance.
 */
async function companyDashboard(req, { co, list, u, query, extraTabs = [], extraOverview, tagUp }) {
  const today = R.todayLocal(), named = STAFF.includes(u.role);
  const seas = await C.seasons(pool, co.code);
  const def = await C.defaultSeason(pool, co.code, today);
  const se = seas.find((x) => String(x.id) === String(query.season)) || def;
  const tabs = [["overview", "Overview"], ["attendance", "Attendance"], ...extraTabs.map(([k, l]) => [k, l]), ["reports", "Reports"]];
  const tab = tabs.some(([k]) => k === query.tab) ? query.tab : "overview";
  const seasonQ = se && def && se.id !== def.id ? se.id : "";
  const base = (o = {}) => "/corporate?" + qs({ company: co.code, season: seasonQ, ...o, tab: o.tab === "overview" ? "" : o.tab });
  const D = await seasonData(co, se, today);
  const st = seasonState(se, today);
  const ctx = { req, co, se, D, today, named, u, seas, base };
  let body = "";
  if (tab === "overview") {
    const from = se && se.start > today ? se.start : today;
    // extras (L'imad levels and ride groups) belong to the season people sign up for now
    const open = await C.openSeason(pool, co.code, today);
    const showExtra = extraOverview && (!se || !open || open.id === se.id);
    body = overviewTab({ ...ctx, up: st.key === "end" ? [] : await upcoming(co, from, 21, 5, se ? se.end : null), extra: showExtra ? await extraOverview(ctx) : "", tagUp });
  }
  else if (tab === "attendance") {
    let todayBox = "";
    if (named && (!se || (se.start <= today && se.end >= today))) {
      const ts = await C.todaysSessions(pool, co);
      todayBox = ts.length ? `<div class="cd-today"><span class="lm-eyebrow">Today</span>${ts.map((s) => s.virtual
        ? `<form method="post" action="/corporate/sessions"><input type="hidden" name="company" value="${h(co.code)}"><input type="hidden" name="session_date" value="${today}"><input type="hidden" name="kind" value="${h(s.kind)}"><input type="hidden" name="title" value="${h(s.title)}"><input type="hidden" name="status" value="Held"><b>${h(C.sessionName(s, co))}${s.start_time ? " · " + h(s.start_time) : ""}</b> <button class="btn">Open to tick names</button></form>`
        : `<span><a href="/corporate/session/${s.id}"><b>${h(C.sessionName(s, co))}</b></a> <span class="status-chip st-${h(s.status)}">${h(s.status)}</span></span>`).join("")}<a class="btn ghost" href="/corporate/scan">Scan QR codes</a></div>` : "";
    }
    body = attendanceTab({ ...ctx, view: query.view, month: query.month, todayBox });
  } else if (tab === "reports") body = reportsTab(ctx);
  else body = await extraTabs.find(([k]) => k === tab)[2](ctx);

  const coTabs = companyTabs(list, co);
  const seasonPick = seas.length ? `<nav class="cd-seasons" aria-label="Seasons">${seas.map((x) => { const s2 = seasonState(x, today); return `<a href="${"/corporate?" + qs({ company: co.code, season: def && x.id === def.id ? "" : x.id, tab: tab === "overview" ? "" : tab })}" ${se && x.id === se.id ? 'aria-current="page"' : ""}><b>${h(x.name)}</b><small class="s-${s2.key}">${h(s2.text)} · ${nf(x.members)} on list</small></a>`; }).join("")}</nav>` : "";
  const nav = `<nav class="lm-tabs" aria-label="${h(co.name)} dashboard">${tabs.map(([k, l]) => `<a href="${base({ tab: k })}" ${k === tab ? 'aria-current="page"' : ""}>${h(l)}</a>`).join("")}</nav>`;
  const scheds = await C.schedules(pool, [co.code]);
  const when = scheds.length ? scheds.filter((x) => x.kind === C.RIDE).map((x) => C.scheduleText(x).replace(/ of the month/, "")).join(" · ") : co.ride_days ? "Rides " + co.ride_days : "";
  return `${coTabs}<div class="lm cd" style="--lm:${h(co.color || "#4a5bc4")}">
    <header class="lm-hero"><div class="cd-hero-id">${logo(co, "lg")}<div><span class="lm-eyebrow">${h(co.name)} · Corporate Cycling</span><h2>${h(se ? se.name : "Whole programme")}</h2>
      <p>${se ? `${h(fmtDate(se.start))} – ${h(fmtDate(se.end))} · <span class="cd-state s-${st.key}">${h(st.text)}</span>` : "No seasons yet: showing the whole programme"}${when ? " · " + h(when) : ""}</p></div></div>
      ${named ? `<div class="toolbar" style="margin:0"><a class="btn" href="${base({ tab: "attendance" })}">Attendance</a><a class="btn" href="/corporate/qr">QR codes</a>${co.code === "LIMAD" ? `<a class="btn lm-btn primary" href="${base({ tab: "register" })}">Registration &amp; QR</a>` : `<a class="btn lm-btn primary" href="/corporate/participants?${qs({ company: co.code, season: se && se.id })}">Season list</a>`}</div>` : ""}</header>
    ${seasonPick}${named ? seasonAdmin(co, se, seas, req.originalUrl) : ""}
    ${nav}<div class="lm-body">${body}</div></div>`;
}

module.exports = { companyDashboard, companyTabs, logo, LOGOS, seasonData, seasonState, ring, upcoming, upList };
