"use strict";
/**
 * Department → Team calendar: one month view of what the team has on.
 * It shows the WMF rides and events (from the WMF calendar) and the corporate rides and sessions (from each company's
 * schedule and recorded sessions), plus the team's own entries — meetings, trainings, travel, anything — under any
 * category the team types, so new kinds of entries need no change to the app.
 */
const { pool, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const CAL = require("../public/calendar-core");
const C = require("./corpdata");
const { h, fmtDate, monLabel } = require("./views");

const { addDays, addMonths, monthEnd } = E.helpers;
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const okTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || "");
const SUGGEST = ["Meeting", "Training", "Workshop", "Admin", "Travel", "Partner visit", "Deadline", "Event support"];
const SOURCES = { hol: "UAE public holidays", wmf: "WMF rides & events", corp: "Corporate rides", away: "Leave & days off", team: "Team entries" };
const SRC_COLOR = { hol: "#d03b3b", wmf: "#5b7cf0", corp: "#e8833a", away: "#1d9e75", team: "#7a5cc8" };

/**
 * UAE public holidays for the rest of 2026 and for 2027, added once (the team keeps the list under Department → Team).
 * Islamic holidays follow the moon, so they're marked "expected" until the Cabinet confirms the dates.
 * Source: dates reported for 2027 (The National, Aug 2026).
 */
const UAE_2027 = [["2026-12-02", "UAE National Day"], ["2026-12-03", "UAE National Day"], ["2027-01-01", "New Year's Day"], ["2027-03-09", "Eid Al Fitr (expected)"], ["2027-03-10", "Eid Al Fitr (expected)"], ["2027-03-11", "Eid Al Fitr (expected)"],
  ["2027-05-15", "Arafat Day (expected)"], ["2027-05-16", "Eid Al Adha (expected)"], ["2027-05-17", "Eid Al Adha (expected)"], ["2027-05-18", "Eid Al Adha (expected)"],
  ["2027-06-06", "Islamic New Year (expected)"], ["2027-08-14", "Prophet Mohammed's Birthday (expected)"], ["2027-12-02", "UAE National Day"], ["2027-12-03", "UAE National Day"]];
async function seedHolidays() {
  if ((await pool.query("SELECT 1 FROM settings WHERE key = 'uaeHolidays2027Seeded'")).rows[0]) return;
  for (const [d, n] of UAE_2027) await pool.query("INSERT INTO dept_holidays (holiday, name) VALUES ($1,$2) ON CONFLICT (holiday) DO NOTHING", [d, n]);
  await pool.query("INSERT INTO settings (key, value) VALUES ('uaeHolidays2027Seeded', $1) ON CONFLICT (key) DO NOTHING", [JSON.stringify({ at: new Date().toISOString(), days: UAE_2027.length })]);
}
const PALETTE = ["#7a5cc8", "#1baf7a", "#d4537e", "#b8860b", "#0f6e56", "#c2410c", "#4b5563", "#2563eb"];
/** A steady colour per team category (the same name always gets the same colour). */
const catColor = (c) => { let n = 0; for (const ch of String(c || "").toLowerCase()) n = (n * 31 + ch.charCodeAt(0)) >>> 0; return PALETTE[n % PALETTE.length]; };

/** Everything on the calendar between two dates, by day: [{ date, time, title, where, src, color, href, cancel, cat }]. */
async function load(from, to) {
  const out = [];
  const put = (o) => out.push(o);
  // WMF calendar (rides and events)
  const items = (await require("./calendar").loadItems()).filter((a) => a.c === "wmf_ride" || a.c === "wmf_event");
  const map = CAL.build(items, from, to);
  for (const [d, list] of Object.entries(map)) for (const o of list) {
    if (o.date !== d && d !== from) continue; // a multi-day item is listed on its first day in view
    put({ date: d, end: o.end > d ? o.end : null, time: o.a.st || "", title: o.a.t, where: o.a.loc, src: "wmf", cat: o.a.c === "wmf_ride" ? "WMF ride" : "WMF event",
      color: o.a.c === "wmf_ride" ? "#5b7cf0" : "#2f5fb3", href: o.a.id ? `/calendar/items/${o.a.id}` : null, cancel: o.cancel });
  }
  // corporate: planned sessions from each company's schedule, plus sessions recorded on other days
  const cos = await C.companies(pool), names = new Map(cos.map((x) => [x.code, x]));
  const occ = await C.occurrences(pool, cos.map((x) => x.code), from, to);
  const seen = new Set();
  for (const o of occ) {
    const co = names.get(o.sc.company), s = o.session; if (s) seen.add(s.id);
    put({ date: o.date, time: (s && s.start_time) || o.sc.start_time || "", title: C.schedName(o.sc, co), where: (s && s.location) || o.sc.location || "", src: "corp", cat: co ? co.name : "Corporate",
      color: "#e8833a", href: s ? `/corporate/session/${s.id}` : null, cancel: s && s.status === "Cancelled" });
  }
  const extra = (await pool.query("SELECT * FROM corp_sessions WHERE session_date BETWEEN $1 AND $2", [from, to])).rows.filter((s) => !seen.has(s.id));
  for (const s of extra) {
    const co = names.get(s.company);
    put({ date: s.session_date, time: s.start_time || "", title: C.sessionName ? C.sessionName(s, co) : s.title || s.kind, where: s.location || "", src: "corp", cat: co ? co.name : s.company,
      color: "#e8833a", href: `/corporate/session/${s.id}`, cancel: s.status === "Cancelled" });
  }
  // UAE public holidays (the list kept under Department → Team)
  for (const r of (await pool.query("SELECT holiday::text AS d, name FROM dept_holidays WHERE holiday BETWEEN $1 AND $2", [from, to])).rows)
    put({ date: r.d, time: "", title: r.name, where: "", src: "hol", cat: "UAE public holiday", color: SRC_COLOR.hol, href: null, hol: true });
  // who is away: leave (not rejected or cancelled) and days off from the team schedule
  const first = (n) => String(n || "").split(" ")[0];
  const leave = (await pool.query(`SELECT l.*, l.start_date::text AS s, l.end_date::text AS e, st.full_name FROM dept_leave l JOIN dept_staff st ON st.id = l.staff_id
    WHERE l.status NOT IN ('Rejected','Cancelled') AND l.start_date <= $2 AND l.end_date >= $1 ORDER BY l.start_date`, [from, to])).rows;
  for (const l of leave) for (let d = l.s < from ? from : l.s; d <= (l.e > to ? to : l.e); d = addDays(d, 1))
    put({ date: d, time: "", title: `${first(l.full_name)} · ${String(l.leave_type).toLowerCase()} leave${l.status === "Tentative" ? " (tentative)" : l.status === "Pending" ? " (pending)" : ""}`, where: "", src: "away", cat: "Leave",
      color: SRC_COLOR.away, href: "/department/leave", note: `${fmtDate(l.s)} – ${fmtDate(l.e)}` });
  const off = (await pool.query(`SELECT sh.work_date::text AS d, st.full_name FROM dept_shifts sh JOIN dept_staff st ON st.id = sh.staff_id WHERE sh.activity = 'Off' AND sh.work_date BETWEEN $1 AND $2`, [from, to])).rows;
  for (const o of off) put({ date: o.d, time: "", title: `${first(o.full_name)} · off`, where: "", src: "away", cat: "Day off", color: SRC_COLOR.away, href: `/department/schedule` });
  // the team's own entries (repeating ones too)
  const team = (await pool.query("SELECT *, start_date::text AS s, end_date::text AS e, until::text AS u FROM dept_calendar ORDER BY start_date, start_time NULLS LAST, id")).rows;
  const asItem = (t) => ({ id: t.id, t: t.title, c: "team", s: t.s, e: t.e || t.s, st: t.start_time || "", loc: t.location || "", status: "Confirmed",
    r: t.repeat === "weekly" ? { freq: "weekly", until: t.u || null } : t.repeat === "monthly" ? { freq: "monthly", until: t.u || null } : null, row: t });
  const tmap = CAL.build(team.map(asItem), from, to);
  for (const [d, list] of Object.entries(tmap)) for (const o of list) {
    if (o.date !== d && d !== from) continue;
    const t = o.a.row;
    put({ date: d, end: o.end > d ? o.end : null, time: t.start_time ? t.start_time + (t.end_time ? "–" + t.end_time : "") : "", title: t.title, where: t.location || "", src: "team", cat: t.category, who: t.who || "",
      color: catColor(t.category), href: `/department/calendar/entry/${t.id}`, note: t.notes || "", repeat: t.repeat });
  }
  out.sort((a, b) => a.date.localeCompare(b.date) || !!b.hol - !!a.hol || (a.time || "99").localeCompare(b.time || "99") || a.title.localeCompare(b.title));
  return out;
}

/** The categories the team has used, most used first, then the suggestions. */
async function categories() {
  const used = (await pool.query("SELECT category, count(*) n FROM dept_calendar GROUP BY 1 ORDER BY 2 DESC, 1")).rows.map((r) => r.category);
  return [...new Set([...used, ...SUGGEST])];
}

/** Team members' names, for "Who". */
const people = async () => (await pool.query("SELECT full_name FROM dept_staff WHERE coalesce(active, true) ORDER BY full_name")).rows.map((r) => r.full_name);

const chip = (x, full) => {
  const inner = `${x.time ? `<b>${h(x.time.replace(/^0/, ""))}</b> ` : ""}${h(x.title)}${full && (x.who || x.where) ? `<small>${h([x.who, x.where].filter(Boolean).join(" · "))}</small>` : ""}`;
  const tip = [x.cat, x.time, x.title, x.who, x.where, x.end ? "until " + fmtDate(x.end) : "", x.note, x.cancel ? "Cancelled" : ""].filter(Boolean).join(" · ");
  return x.href ? `<a class="tc-chip ${x.cancel ? "off" : ""}" style="--c:${x.color}" href="${h(x.href)}" title="${h(tip)}">${inner}</a>` : `<span class="tc-chip ${x.cancel ? "off" : ""}" style="--c:${x.color}" title="${h(tip)}">${inner}</span>`;
};

function monthGrid(m, items, show) {
  const first = m + "-01", last = monthEnd(m), today = R.todayLocal();
  const start = addDays(first, -((dow(first) + 6) % 7)), end = addDays(last, (7 - dow(last)) % 7);
  const by = new Map(); for (const x of items) if (show.has(x.src)) (by.get(x.date) || by.set(x.date, []).get(x.date)).push(x);
  let cells = "";
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const list = by.get(d) || [], out = d.slice(0, 7) !== m;
    cells += `<div class="tc-day ${out ? "out" : ""} ${d === today ? "today" : ""} ${dow(d) === 0 || dow(d) === 6 ? "we" : ""} ${list.some((x) => x.hol) ? "hol" : ""}"><div class="tc-dn">${+d.slice(8)}
      <a class="tc-add noprint" href="/department/calendar/new?date=${d}" aria-label="Add on ${fmtDate(d)}">+</a></div>${list.map(chip).join("")}</div>`;
  }
  // on phones: a simple list of the days that have something
  const agenda = [...by.entries()].filter(([d]) => d.slice(0, 7) === m).sort().map(([d, list]) => `<div class="tc-ag ${d === today ? "today" : ""}"><div class="tc-agd">${DOW[dow(d)]} ${+d.slice(8)}</div><div>${list.map(chip).join("")}</div></div>`).join("")
    || '<p class="muted">Nothing on the calendar this month.</p>';
  return `<div class="tc-grid"><div class="tc-dow">${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((x) => `<div>${x}</div>`).join("")}</div><div class="tc-days">${cells}</div></div><div class="tc-agenda">${agenda}</div>`;
}

/** One week, Monday to Sunday, with every entry written out in full. */
function weekGrid(d0, items, show) {
  const start = addDays(d0, -((dow(d0) + 6) % 7)), today = R.todayLocal();
  const by = new Map(); for (const x of items) if (show.has(x.src)) (by.get(x.date) || by.set(x.date, []).get(x.date)).push(x);
  let cols = "";
  for (let i = 0; i < 7; i++) {
    const d = addDays(start, i), list = by.get(d) || [];
    cols += `<div class="tc-wd ${d === today ? "today" : ""} ${list.some((x) => x.hol) ? "hol" : ""}"><div class="tc-wh">${DOW[dow(d)]} <b>${+d.slice(8)}</b><a class="tc-add noprint" href="/department/calendar/new?date=${d}" aria-label="Add on ${fmtDate(d)}">+</a></div>
      ${list.map((x) => chip(x, true)).join("") || '<span class="muted" style="font-size:12px">—</span>'}</div>`;
  }
  return `<div class="tc-week">${cols}</div>`;
}

function entryForm(e, cats, action, people = []) {
  return `<form class="form" method="post" action="${action}">
    <div class="grid"><label class="c8">What<input name="title" required maxlength="120" value="${h(e.title || "")}" placeholder="e.g. Team meeting"></label>
      <label class="c4">Category <span class="hint">(pick or type a new one)</span><input name="category" required maxlength="40" list="tc-cats" value="${h(e.category || "")}" placeholder="Meeting"></label></div>
    <datalist id="tc-cats">${cats.map((c) => `<option value="${h(c)}">`).join("")}</datalist>
    <div class="grid"><label class="c3">Date<input type="date" name="start_date" required value="${h(e.s || "")}"></label><label class="c3">Until <span class="hint">(several days)</span><input type="date" name="end_date" value="${h(e.e && e.e !== e.s ? e.e : "")}"></label>
      <label class="c3">From<input type="time" name="start_time" value="${h(e.start_time || "")}"></label><label class="c3">To<input type="time" name="end_time" value="${h(e.end_time || "")}"></label></div>
    <div class="grid"><label class="c4">Repeats<select name="repeat">${[["", "Doesn't repeat"], ["weekly", "Every week"], ["monthly", "Every month (same week and day)"]].map(([v, l]) => `<option value="${v}" ${String(e.repeat || "") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
      <label class="c4">Repeat until <span class="hint">(optional)</span><input type="date" name="until" value="${h(e.u || "")}"></label><label class="c4">Where <span class="hint">(optional)</span><input name="location" maxlength="120" value="${h(e.location || "")}"></label></div>
    <div class="grid"><label class="c4">Who <span class="hint">(optional)</span><input name="who" maxlength="80" list="tc-who" value="${h(e.who || "")}" placeholder="Whole team"></label>
      <label class="c8">Notes <span class="hint">(optional)</span><input name="notes" maxlength="300" value="${h(e.notes || "")}"></label></div>
    <datalist id="tc-who">${["Whole team", ...people].map((c) => `<option value="${h(c)}">`).join("")}</datalist>
    <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><a class="btn ghost" href="/department/calendar${e.s ? "?m=" + e.s.slice(0, 7) : ""}">Cancel</a></div></form>`;
}

function clean(b) {
  const s = okDate(b.start_date) ? b.start_date : null, e = okDate(b.end_date) && s && b.end_date > s ? b.end_date : s;
  return { title: R.clean(b.title).slice(0, 120), category: R.clean(b.category).slice(0, 40) || "Other", start_date: s, end_date: e,
    start_time: okTime(b.start_time) ? b.start_time : null, end_time: okTime(b.end_time) ? b.end_time : null,
    repeat: ["weekly", "monthly"].includes(b.repeat) ? b.repeat : null, until: okDate(b.until) && s && b.until >= s && ["weekly", "monthly"].includes(b.repeat) ? b.until : null,
    location: R.clean(b.location).slice(0, 120) || null, who: R.clean(b.who).slice(0, 80) || null, notes: R.clean(b.notes).slice(0, 300) || null };
}

module.exports = function teamCalendar(app, { need, page, setFlash, actor, wrap }) {
  const S = need("admin", "coordinator");
  const PAGE = { active: "/department/calendar" };

  app.get("/department/calendar", S, wrap(async (req, res) => {
    const week = req.query.view === "week";
    const d0 = okDate(req.query.d) ? req.query.d : R.todayLocal();
    const m = /^\d{4}-\d{2}$/.test(req.query.m || "") ? req.query.m : d0.slice(0, 7);
    const show = new Set(String(req.query.show || Object.keys(SOURCES).join(",")).split(",").filter((x) => SOURCES[x]));
    const first = m + "-01", items = week ? await load(addDays(d0, -7), addDays(d0, 7)) : await load(addDays(first, -7), addDays(monthEnd(m), 7));
    const q = (o) => "?" + new URLSearchParams({ ...(week ? { view: "week", d: d0 } : { m }), show: [...show].join(","), ...o }).toString();
    const wkStart = addDays(d0, -((dow(d0) + 6) % 7));
    const toggle = (k) => { const s = new Set(show); if (s.has(k)) s.delete(k); else s.add(k); return `/department/calendar${q({ show: [...s].join(",") })}`; };
    const teamCats = [...new Set(items.filter((x) => x.src === "team").map((x) => x.cat))];
    res.send(page(req, "Team calendar", `<section class="card"><div class="tc-head">
        <div><div class="wc-eyebrow">Cycling Development · team calendar</div><div class="tc-nav">${week
          ? `<a class="btn tblbtn" href="/department/calendar${q({ d: addDays(wkStart, -7) })}" aria-label="Previous week">‹</a><h2 style="margin:0">${h(fmtDate(wkStart))} – ${h(fmtDate(addDays(wkStart, 6)))}</h2><a class="btn tblbtn" href="/department/calendar${q({ d: addDays(wkStart, 7) })}" aria-label="Next week">›</a>
             <a class="btn tblbtn" href="/department/calendar${q({ d: R.todayLocal() })}">This week</a>`
          : `<a class="btn tblbtn" href="/department/calendar${q({ m: addMonths(m, -1) })}" aria-label="Previous month">‹</a><h2 style="margin:0">${h(monLabel(m, true))}</h2><a class="btn tblbtn" href="/department/calendar${q({ m: addMonths(m, 1) })}" aria-label="Next month">›</a>
             ${m !== R.todayLocal().slice(0, 7) ? `<a class="btn tblbtn" href="/department/calendar${q({ m: R.todayLocal().slice(0, 7) })}">This month</a>` : ""}`}
          <span class="seg tc-seg"><a class="${week ? "" : "on"}" href="/department/calendar?${new URLSearchParams({ m: week ? d0.slice(0, 7) : m, show: [...show].join(",") })}">Month</a><a class="${week ? "on" : ""}" href="/department/calendar?${new URLSearchParams({ view: "week", d: week ? d0 : m === R.todayLocal().slice(0, 7) ? R.todayLocal() : m + "-01", show: [...show].join(",") })}">Week</a></span></div></div>
        <a class="btn primary" href="/department/calendar/new">+ Add to the calendar</a></div>
      <div class="tc-filters">${Object.entries(SOURCES).map(([k, l]) => `<a class="tc-f ${show.has(k) ? "on" : ""}" href="${toggle(k)}" aria-pressed="${show.has(k)}"><i style="background:${SRC_COLOR[k]}"></i>${l}</a>`).join("")}
        ${show.has("team") && teamCats.length ? `<span class="tc-cats">${teamCats.map((c) => `<span><i style="background:${catColor(c)}"></i>${h(c)}</span>`).join("")}</span>` : ""}</div>
      ${week ? weekGrid(d0, items, show) : monthGrid(m, items, show)}
      <p class="muted" style="font-size:12.5px;margin:10px 0 0">WMF rides and events come from the <a href="/calendar">WMF calendar</a>; corporate rides from each company's <a href="/corporate/schedule">schedule</a> and recorded sessions; leave and days off from <a href="/department/leave">Leave</a> and the <a href="/department/schedule">Schedule</a>; UAE public holidays from the list under <a href="/department/staff">Team</a> (Islamic holidays are expected dates until announced). Click an entry to open it · + on a day adds an entry · struck through = cancelled.</p></section>`, PAGE));
  }));

  app.get("/department/calendar/new", S, wrap(async (req, res) => {
    const d = okDate(req.query.date) ? req.query.date : R.todayLocal();
    res.send(page(req, "Add to the team calendar", `<section class="card"><h2>Add to the team calendar</h2><p class="lead">Anything the team has on: meetings, trainings, travel, deadlines. Type a new category whenever you need one.</p>
      ${entryForm({ s: d }, await categories(), "/department/calendar/new", await people())}</section>`, { ...PAGE, wide: false }));
  }));
  app.post("/department/calendar/new", S, wrap(async (req, res) => {
    const f = clean(req.body || {});
    if (!f.title || !f.start_date) { setFlash(req, "err", "Add what it is and the date."); return res.redirect("/department/calendar/new"); }
    const k = Object.keys(f);
    const r = await pool.query(`INSERT INTO dept_calendar (${k}, created_by) VALUES (${k.map((_, i) => "$" + (i + 1))}, $${k.length + 1}) RETURNING id`, [...k.map((x) => f[x]), actor(req)]);
    await audit(pool, actor(req), "teamcal.create", "dept_calendar", String(r.rows[0].id), null, f);
    setFlash(req, "ok", `Added: ${f.title}, ${fmtDate(f.start_date)}.`); res.redirect(`/department/calendar?m=${f.start_date.slice(0, 7)}`);
  }));
  app.get("/department/calendar/entry/:id", S, wrap(async (req, res) => {
    const e = (await pool.query("SELECT *, start_date::text AS s, end_date::text AS e, until::text AS u FROM dept_calendar WHERE id = $1", [+req.params.id || 0])).rows[0];
    if (!e) return res.redirect("/department/calendar");
    res.send(page(req, "Edit calendar entry", `<section class="card"><h2>Edit: ${h(e.title)}</h2>${entryForm(e, await categories(), `/department/calendar/entry/${e.id}`, await people())}
      <form method="post" action="/department/calendar/entry/${e.id}/delete" style="margin-top:12px"><button class="btn danger" data-confirm="Delete this entry${e.repeat ? " and all its repeats" : ""}?">Delete</button></form></section>`, { ...PAGE, wide: false }));
  }));
  app.post("/department/calendar/entry/:id", S, wrap(async (req, res) => {
    const id = +req.params.id || 0, f = clean(req.body || {});
    if (!f.title || !f.start_date) { setFlash(req, "err", "Add what it is and the date."); return res.redirect(`/department/calendar/entry/${id}`); }
    const k = Object.keys(f);
    await pool.query(`UPDATE dept_calendar SET ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...k.map((x) => f[x])]);
    await audit(pool, actor(req), "teamcal.update", "dept_calendar", String(id), null, f);
    setFlash(req, "ok", "Saved."); res.redirect(`/department/calendar?m=${f.start_date.slice(0, 7)}`);
  }));
  app.post("/department/calendar/entry/:id/delete", S, wrap(async (req, res) => {
    const r = await pool.query("DELETE FROM dept_calendar WHERE id = $1 RETURNING *", [+req.params.id || 0]);
    if (r.rows[0]) await audit(pool, actor(req), "teamcal.delete", "dept_calendar", String(r.rows[0].id), r.rows[0], null);
    setFlash(req, "ok", "Deleted."); res.redirect("/department/calendar");
  }));
};
module.exports.load = load;
module.exports.seedHolidays = seedHolidays;
