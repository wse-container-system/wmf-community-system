"use strict";
/**
 * Department: a simple team schedule and leave plans.
 * Schedule = time blocks per person per day (Office, WMF Ride, Corporate Ride, Event, Other, Off).
 * Leave = confirmed or tentative. One short monthly timesheet for HR.
 * A personal link (Department → Share) lets one person (e.g. the manager) see the department and edit only her own schedule and leave.
 */
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate, fmtTs, monLabel, nf, table, raw } = require("./views");
const { addDays, monthEnd, addMonths } = require("./engine").helpers;

// what people pick from; older names stay readable
const ACTS = [
  { k: "Office", c: "#2f7fd6", hours: true },
  { k: "WMF Ride", c: "#d6489b", hours: true },
  { k: "Corporate Ride", c: "#7b3fb8", hours: true },
  { k: "Event", c: "#e07b1a", hours: true },
  { k: "Other", c: "#4a6a8a", hours: true },
  { k: "Off", c: "#9a94ab", hours: false, allDay: true },
];
// ready timings for each activity: the first is filled in when the activity is picked
const TIMES = {
  Office: [["08:00", "17:00"], ["09:00", "18:00"], ["07:00", "16:00"], ["08:00", "13:00"], ["13:00", "17:00"]],
  "WMF Ride": [["05:30", "08:30"], ["06:00", "09:00"], ["17:00", "20:00"], ["18:00", "21:00"], ["19:00", "21:30"]],
  "Corporate Ride": [["05:30", "08:00"], ["06:00", "08:00"], ["16:30", "19:00"], ["17:00", "19:00"]],
  Event: [["07:00", "12:00"], ["09:00", "17:00"], ["16:00", "21:00"], ["18:00", "22:00"]],
  Other: [["09:00", "12:00"], ["13:00", "17:00"], ["08:00", "17:00"]],
};
const OLD = { "Workshop / Training": "#13917a", Mechanic: "#a87a00", "Business trip": "#4a6a8a", "Lieu day": "#9a94ab" };
const actOf = (k) => ACTS.find((a) => a.k === k) || (OLD[k] ? { k, c: OLD[k], hours: k !== "Lieu day", allDay: k === "Lieu day" } : { k, c: "#777", hours: true });
const LEAVE_TYPES = ["Annual", "Sick", "Other"];
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const dow = (d) => new Date(d + "T12:00:00Z").getUTCDay();
const mondayOf = (d) => addDays(d, -((dow(d) + 6) % 7));
const days = (a, b) => { const o = []; for (let d = a; d <= b; d = addDays(d, 1)) o.push(d); return o; };
const mins = (t) => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const hrs = (b) => { if (!actOf(b.activity).hours) return 0; const a = mins(b.start_time), z = mins(b.end_time); return a != null && z != null && z > a ? (z - a) / 60 : 0; };
const hm = (n) => (n ? `${Math.floor(n)}${n % 1 ? ":" + String(Math.round((n % 1) * 60)).padStart(2, "0") : ""}h` : "");
const okDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || "");
const okTime = (s) => /^\d{2}:\d{2}$/.test(s || "");
const WEEK_LIMIT = 48; // UAE labour law: up to 48 working hours a week

async function load(from, to, { staffIds } = {}) {
  const staff = (await pool.query(`SELECT * FROM dept_staff WHERE active ${staffIds ? "AND id = ANY($1)" : ""} ORDER BY full_name`, staffIds ? [staffIds] : [])).rows;
  const ids = staff.map((s) => s.id);
  const [sh, lv, hol] = await Promise.all([
    pool.query("SELECT *, work_date::text AS d FROM dept_shifts WHERE staff_id = ANY($1) AND work_date BETWEEN $2 AND $3 ORDER BY work_date, start_time NULLS FIRST, id", [ids, from, to]),
    pool.query("SELECT *, start_date::text AS a, end_date::text AS z FROM dept_leave WHERE staff_id = ANY($1) AND status IN ('Approved','Tentative','Pending') AND end_date >= $2 AND start_date <= $3", [ids, from, to]),
    pool.query("SELECT holiday::text AS d, name FROM dept_holidays WHERE holiday BETWEEN $1 AND $2", [from, to]),
  ]);
  const blocks = new Map();
  for (const b of sh.rows) { const k = b.staff_id + "|" + b.d; if (!blocks.has(k)) blocks.set(k, []); blocks.get(k).push(b); }
  const holidays = new Map(hol.rows.map((x) => [x.d, x.name]));
  const day = (id, d) => {
    const bl = blocks.get(id + "|" + d) || [];
    const leave = lv.rows.filter((l) => l.staff_id === id && l.a <= d && l.z >= d).sort((x) => (x.status === "Approved" ? -1 : 1))[0] || null;
    return { blocks: bl, hours: bl.reduce((a, b) => a + hrs(b), 0), leave, holiday: holidays.get(d) || null, weekend: dow(d) === 0 || dow(d) === 6 };
  };
  return { staff, day, holidays, leave: lv.rows };
}

// ---------------------------------------------------------------- views
const chip = (b, href) => {
  const t = b.start_time ? `${b.start_time}–${b.end_time || ""}` : "";
  const inner = `${t ? `<b>${h(t)}</b> ` : ""}${h(b.activity)}${b.note ? ` <span class="sc-note2">${h(b.note)}</span>` : ""}`;
  return href ? `<a class="sc-chip" style="--ac:${actOf(b.activity).c}" href="${href}">${inner}</a>` : `<span class="sc-chip" style="--ac:${actOf(b.activity).c}">${inner}</span>`;
};
const leaveChip = (l) => `<span class="sc-lv ${l.status === "Approved" ? "conf" : "tent"}">${h(l.leave_type === "Annual" ? "Leave" : l.leave_type + " leave")}${l.status === "Approved" ? "" : " · tentative"}</span>`;
const legend = () => `<div class="sc-legend">${ACTS.map((a) => `<span><i style="background:${a.c}"></i>${h(a.k)}</span>`).join("")}<span><i class="sc-li conf"></i>Leave</span><span><i class="sc-li tent"></i>Tentative leave</span></div>`;

function weekView(D, mon, ctx) {
  const ds = days(mon, addDays(mon, 6)), today = R.todayLocal();
  const head = ds.map((d) => `<th class="${d === today ? "is-today" : ""}">${DOW[dow(d)]} <span>${+d.slice(8)}</span></th>`).join("");
  const rows = D.staff.map((s) => {
    const edit = ctx.canEdit(s); let tot = 0;
    const cells = ds.map((d) => { const x = D.day(s.id, d); tot += x.hours;
      return `<td class="${d === today ? "is-today" : ""} ${x.weekend ? "we" : ""}">${x.leave ? leaveChip(x.leave) : ""}${x.holiday && !x.blocks.length ? `<span class="sc-lv hol">${h(x.holiday)}</span>` : ""}${x.blocks.map((b) => chip(b, edit ? `${ctx.base}/schedule/entry/${b.id}` : null)).join("")}${edit ? `<a class="sc-plus noprint" href="${ctx.base}/schedule/new?staff=${s.id}&date=${d}" aria-label="Add">+</a>` : ""}</td>`; }).join("");
    return `<tr class="${edit ? "mine" : ""}"><th>${h(s.full_name)}</th>${cells}<td class="sc-tot ${tot > WEEK_LIMIT ? "over" : ""}" title="${tot > WEEK_LIMIT ? "Over " + WEEK_LIMIT + " hours" : ""}">${hm(tot) || "—"}</td></tr>`;
  }).join("");
  return `<div class="tw"><table class="sc-week"><thead><tr><th></th>${head}<th>Hours</th></tr></thead><tbody>${rows || `<tr><td class="muted">Add the team first.</td></tr>`}</tbody></table></div>`;
}

const short = (t) => { const [hh, mm] = String(t || "").split(":"); return hh ? `${+hh}${mm && mm !== "00" ? ":" + mm : ""}` : ""; };
function monthView(D, m, ctx) {
  const ds = days(m + "-01", monthEnd(m)), today = R.todayLocal();
  const head = ds.map((d) => `<th class="${dow(d) === 0 || dow(d) === 6 ? "we" : ""} ${d === today ? "is-today" : ""}">${+d.slice(8)}<br><span>${DOW[dow(d)][0]}</span></th>`).join("");
  const rows = D.staff.map((s) => { let tot = 0;
    const cells = ds.map((d) => { const x = D.day(s.id, d); tot += x.hours;
      const main = x.blocks.slice().sort((a, b) => hrs(b) - hrs(a))[0];
      const cls = x.leave ? (x.leave.status === "Approved" ? "conf" : "tent") : x.holiday ? "hol" : x.weekend ? "we" : "";
      const tip = [fmtDate(d), x.leave ? `${x.leave.leave_type} leave${x.leave.status === "Approved" ? "" : " (tentative)"}` : "", x.holiday || "", ...x.blocks.map((b) => `${b.start_time ? b.start_time + "–" + b.end_time + " " : ""}${b.activity}${b.note ? " · " + b.note : ""}`)].filter(Boolean).join("\n");
      // each block as a short time, coloured by activity: "9–17", "6–8", "19:30–21"
      const times = x.blocks.map((b) => `<span class="sc-mt" style="--ac:${actOf(b.activity).c}">${b.start_time ? `${short(b.start_time)}–${short(b.end_time)}` : h(b.activity)}</span>`).join("");
      return `<td class="${cls}" title="${h(tip)}">${x.leave ? `<span class="sc-ml">L</span>` : ""}${times}</td>`; }).join("");
    return `<tr><th>${h(s.full_name)}</th>${cells}<td class="sc-tot">${hm(tot) || "—"}</td></tr>`; }).join("");
  return `<div class="tw"><table class="sc-month"><thead><tr><th></th>${head}<th>Hours</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="muted" style="font-size:12.5px;margin:6px 0 0">Times are in 24-hour format (9–17 = 09:00 to 17:00), coloured by activity · L = leave (striped = tentative) · hover a day for details</p>`;
}

// ---------------------------------------------------------------- HR timesheet (short)
async function hrWorkbook(m) {
  const from = m + "-01", to = monthEnd(m), D = await load(from, to), ds = days(from, to);
  const wb = new ExcelJS.Workbook(); wb.creator = "Cycling Development";
  const head = (row) => row.eachCell((c) => { c.font = { bold: true, color: { argb: "FFFFFFFF" } }; c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF4D5AC2" } }; });
  const s1 = wb.addWorksheet("Summary");
  s1.addRow([`Cycling Development · timesheet ${monLabel(m, true)}`]).font = { bold: true, size: 13 };
  s1.addRow([]);
  head(s1.addRow(["Name", "Days worked", "Total hours", "Leave days"]));
  for (const s of D.staff) {
    let dw = 0, t = 0, lv = 0;
    for (const d of ds) { const x = D.day(s.id, d); if (x.hours) dw++; t += x.hours; if (x.leave && x.leave.status === "Approved" && !x.weekend && !x.holiday) lv++; }
    s1.addRow([s.full_name, dw, Math.round(t * 100) / 100, lv]);
  }
  [24, 13, 13, 12].forEach((w, i) => { s1.getColumn(i + 1).width = w; });
  for (const s of D.staff) {
    const ws = wb.addWorksheet(s.full_name.replace(/[\\/*?:[\]]/g, "").slice(0, 31));
    ws.addRow([`${s.full_name} · ${monLabel(m, true)}`]).font = { bold: true, size: 13 };
    head(ws.addRow(["Date", "Day", "Schedule", "Hours"]));
    let wk = 0, all = 0;
    for (const d of ds) {
      const x = D.day(s.id, d); wk += x.hours; all += x.hours;
      const what = [x.leave ? `${x.leave.leave_type} leave${x.leave.status === "Approved" ? "" : " (tentative)"}` : "", x.holiday || "",
        ...x.blocks.map((b) => `${b.start_time ? b.start_time + "–" + b.end_time + " " : ""}${b.activity}${b.note ? " (" + b.note + ")" : ""}`)].filter(Boolean).join(", ");
      const r = ws.addRow([new Date(d + "T00:00:00Z"), DOW[dow(d)], what, x.hours ? Math.round(x.hours * 100) / 100 : null]);
      if (x.weekend) r.font = { color: { argb: "FF888888" } };
      if (dow(d) === 0 || d === to) { const t = ws.addRow(["", "", "Week total", Math.round(wk * 100) / 100]); t.font = { bold: true }; wk = 0; }
    }
    const t = ws.addRow(["", "", "Month total", Math.round(all * 100) / 100]); t.font = { bold: true, size: 12 };
    ws.getColumn(1).numFmt = "d mmm"; [9, 6, 60, 8].forEach((w, i) => { ws.getColumn(i + 1).width = w; });
    ws.views = [{ state: "frozen", ySplit: 2 }];
  }
  return wb.xlsx.writeBuffer();
}

// ---------------------------------------------------------------- pages (shared by the hub and the personal link)
module.exports = function deptSchedule(app, { need, page, setFlash, actor, user, wrap }) {
  const S = need("admin", "coordinator"), A = need("admin");
  const me = async (email) => (await pool.query("SELECT * FROM dept_staff WHERE lower(email) = lower($1) AND active", [email])).rows[0];
  const allStaff = async () => (await pool.query("SELECT * FROM dept_staff WHERE active ORDER BY full_name")).rows;

  // who is looking, where links point, and whose rows they may change
  async function hubCtx(req) {
    const u = user(req), mine = await me(u.email), admin = u.role === "admin";
    return { base: "/department", admin, editable: admin ? await allStaff() : mine ? [mine] : [], canEdit: (s) => admin || (mine && mine.id === s.id), by: actor(req), mine,
      send: (res, title, body, active) => res.send(page(req, title, body, { active })) };
  }
  const shareShell = (title, body, l) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(title)} · Cycling Development</title><meta name="robots" content="noindex">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@87,500;87,600;87,700&family=Source+Sans+3:wght@400;600&display=swap">
<link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/hub.css"><link rel="icon" type="image/png" href="/brand/favicon.png"></head>
<body><div class="app"><header class="top"><div class="brand"><span class="cd-mark" aria-hidden="true"><svg viewBox="0 0 40 40" width="30" height="30"><circle cx="11" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><circle cx="29" cy="26" r="8" fill="none" stroke="currentColor" stroke-width="3"/><path d="M11 26 L18 13 L26 13 M18 13 L23 26 L29 26 M24 9 h5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
<div class="brand-name"><h1>Cycling Development</h1><p class="sub">Department · ${l && l.staff_name ? h(l.staff_name) : "view only"}</p></div></div>
<nav class="shell-nav"><a href="/d/${h(l.token)}/schedule">Schedule</a><a href="/d/${h(l.token)}/leave">Leave</a></nav></header>
<main id="main" style="display:grid;gap:14px">${body}</main><footer class="foot"><span>Cycling Development · Powered by Aurora</span><span>UAE time</span></footer></div><script src="/ui.js"></script></body></html>`;
  async function shareCtx(req, res) {
    const l = (await pool.query("SELECT d.*, s.full_name AS staff_name FROM dept_share_links d LEFT JOIN dept_staff s ON s.id = d.staff_id WHERE d.token = $1 AND d.active", [String(req.params.token || "")])).rows[0];
    if (!l) { res.status(404).send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><main class="app"><section class="card"><h2>This link is switched off</h2><p class="lead">Ask the Cycling Development team for a new one.</p></section></main>`); return null; }
    await pool.query("UPDATE dept_share_links SET last_opened = now() WHERE id = $1", [l.id]);
    const own = l.staff_id ? (await pool.query("SELECT * FROM dept_staff WHERE id = $1 AND active", [l.staff_id])).rows[0] : null;
    return { base: `/d/${l.token}`, admin: false, editable: own ? [own] : [], canEdit: (s) => !!own && s.id === own.id, by: "Link: " + l.label, mine: own, link: l,
      send: (r, title, body) => r.set("Cache-Control", "no-store").send(shareShell(title, body, l)) };
  }
  // register a page on both the hub and the personal link
  const both = (method, path, fn, hubGuard = S) => {
    app[method]("/department" + path, hubGuard, wrap(async (req, res) => fn(req, res, await hubCtx(req))));
    app[method]("/d/:token" + path, wrap(async (req, res) => { const c = await shareCtx(req, res); if (c) await fn(req, res, c); }));
  };

  // ----- schedule
  both("get", "/schedule", async (req, res, c) => {
    const view = req.query.view === "month" ? "month" : "week";
    const date = okDate(req.query.date) ? req.query.date : R.todayLocal(), m = date.slice(0, 7);
    const mon = mondayOf(date);
    const prev = view === "week" ? addDays(mon, -7) : addMonths(m, -1) + "-01", next = view === "week" ? addDays(mon, 7) : addMonths(m, 1) + "-01";
    const label = view === "week" ? `${fmtDate(mon).replace(/ \d{4}$/, "")} – ${fmtDate(addDays(mon, 6))}` : monLabel(m, true);
    const q = (v, d) => `${c.base}/schedule?view=${v}&date=${d}`;
    const body = view === "week" ? weekView(await load(mon, addDays(mon, 6)), mon, c) : monthView(await load(m + "-01", monthEnd(m)), m, c);
    c.send(res, "Schedule", `
      <div class="sc-bar">
        <div class="sc-step"><a class="btn" href="${q(view, prev)}" aria-label="Previous">‹</a><b>${h(label)}</b><a class="btn" href="${q(view, next)}" aria-label="Next">›</a></div>
        <div class="seg" role="group" aria-label="View"><a class="btn ${view === "week" ? "primary" : ""}" href="${q("week", date)}">Week</a><a class="btn ${view === "month" ? "primary" : ""}" href="${q("month", date)}">Month</a></div>
        <div class="sc-act">${c.mine ? `<a class="btn primary" href="${c.base}/schedule/new?staff=${c.mine.id}&date=${R.todayLocal()}">+ Add my time</a>` : ""}${c.mine && view === "week" ? `<form method="post" action="${c.base}/schedule/copy-week" style="display:inline"><input type="hidden" name="staff_id" value="${c.mine.id}"><input type="hidden" name="monday" value="${mon}"><button class="btn" title="Fill this week's empty days from last week">Copy last week</button></form>` : ""}
          <a class="btn" href="${c.base}/schedule/export.xlsx?month=${m}">HR timesheet</a></div>
      </div>
      ${legend()}<section class="card sc-card">${body}</section>`, "/department/schedule");
  });

  // ----- add / change a block
  const form = (c, v, action, del) => `<form class="form" method="post" action="${action}">
    ${c.editable.length > 1 ? `<label>Who<select name="staff_id">${c.editable.map((s) => `<option value="${s.id}" ${String(v.staff_id) === String(s.id) ? "selected" : ""}>${h(s.full_name)}</option>`).join("")}</select></label>` : `<input type="hidden" name="staff_id" value="${c.editable[0].id}">`}
    <div class="ds-acts">${ACTS.map((a) => `<label class="ds-actpick" style="--ac:${a.c}"><input type="radio" name="activity" value="${h(a.k)}" ${v.activity === a.k ? "checked" : ""} required><span>${h(a.k)}</span></label>`).join("")}</div>
    <div class="row2"><label>Date<input type="date" name="work_date" value="${h(v.work_date)}" required></label><label>Note <span class="hint">(optional)</span><input name="note" value="${h(v.note)}" maxlength="60" placeholder="e.g. L'IMAD"></label></div>
    <div class="ds-times" id="dsTimes" data-times="${h(JSON.stringify(TIMES))}" ${v.activity === "Off" ? "hidden" : ""}><span class="hint">Ready times: tap one</span><div class="ds-chips"></div></div>
    <div class="row2" id="dsFromTo" ${v.activity === "Off" ? "hidden" : ""}><label>From<input type="time" name="start_time" value="${h(v.start_time)}"></label><label>To<input type="time" name="end_time" value="${h(v.end_time)}"></label></div>
    ${del ? "" : `<details><summary>Repeat</summary><div class="ds-days" style="margin-top:8px">${[1, 2, 3, 4, 5, 6, 0].map((i) => `<label><input type="checkbox" name="repeat" value="${i}"> ${DOW[i]}</label>`).join("")}</div><label style="margin-top:8px">Until<input type="date" name="until"></label></details>`}
    <div class="toolbar" style="margin:0"><button class="btn primary">Save</button>${del ? `<button class="btn danger" name="action" value="delete" formnovalidate>Remove</button>` : ""}<a class="btn ghost" href="${c.base}/schedule?date=${h(v.work_date || "")}">Cancel</a></div></form><script src="/deptform.js" defer></script>`;
  function readEntry(b) {
    const a = ACTS.find((x) => x.k === b.activity);
    if (!a) return { err: "Choose what it is." };
    if (!okDate(b.work_date)) return { err: "Choose a date." };
    const st = okTime(b.start_time) ? b.start_time : null, en = okTime(b.end_time) ? b.end_time : null;
    if (!a.allDay && (!st || !en)) return { err: "Enter the time (from and to)." };
    if (st && en && mins(en) <= mins(st)) return { err: "'To' must be after 'From'." };
    return { activity: a.k, start_time: a.allDay ? null : st, end_time: a.allDay ? null : en, note: R.clean(b.note).slice(0, 60) || null };
  }
  both("get", "/schedule/new", async (req, res, c) => {
    if (!c.editable.length) return res.redirect(`${c.base}/schedule`);
    const sid = c.editable.some((s) => String(s.id) === String(req.query.staff)) ? req.query.staff : c.editable[0].id;
    c.send(res, "Add time", `<section class="card narrow"><h2>Add time</h2>${req.query.err ? `<div class="flash err" role="alert">${h(String(req.query.err).slice(0, 120))}</div>` : ""}${form(c, { staff_id: sid, work_date: okDate(req.query.date) ? req.query.date : R.todayLocal(), activity: "Office", start_time: "08:00", end_time: "17:00" }, `${c.base}/schedule/entries`)}</section>`, "/department/schedule");
  });
  both("post", "/schedule/entries", async (req, res, c) => {
    const b = req.body, s = c.editable.find((x) => String(x.id) === String(b.staff_id)), e = readEntry(b);
    if (!s || e.err) return res.redirect(`${c.base}/schedule/new?staff=${b.staff_id || ""}&date=${b.work_date || ""}&err=${encodeURIComponent(e.err || "Not allowed.")}`);
    const rep = [].concat(b.repeat || []).map(Number);
    const ds = rep.length && okDate(b.until) && b.until >= b.work_date && days(b.work_date, b.until).length <= 93 ? days(b.work_date, b.until).filter((d) => d === b.work_date || rep.includes(dow(d))) : [b.work_date];
    await tx(async (cn) => {
      for (const d of ds) {
        if ((await cn.query("SELECT 1 FROM dept_shifts WHERE staff_id = $1 AND work_date = $2 AND activity = $3 AND start_time IS NOT DISTINCT FROM $4", [s.id, d, e.activity, e.start_time])).rows[0]) continue;
        await cn.query("INSERT INTO dept_shifts (staff_id, work_date, start_time, end_time, activity, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [s.id, d, e.start_time, e.end_time, e.activity, e.note, c.by]);
      }
      await audit(cn, c.by, "dept.schedule.add", "dept_shifts", String(s.id), null, { ...e, days: ds.length });
    });
    res.redirect(`${c.base}/schedule?date=${b.work_date}`);
  });
  async function entryFor(c, id) { const b = (await pool.query("SELECT *, work_date::text AS d FROM dept_shifts WHERE id = $1", [+id || 0])).rows[0]; return b && c.editable.some((s) => s.id === b.staff_id) ? b : null; }
  both("get", "/schedule/entry/:id", async (req, res, c) => {
    const b = await entryFor(c, req.params.id); if (!b) return res.redirect(`${c.base}/schedule`);
    c.send(res, "Change time", `<section class="card narrow"><h2>Change</h2>${form(c, { ...b, work_date: b.d }, `${c.base}/schedule/entry/${b.id}`, true)}</section>`, "/department/schedule");
  });
  both("post", "/schedule/entry/:id", async (req, res, c) => {
    const b = await entryFor(c, req.params.id); if (!b) return res.redirect(`${c.base}/schedule`);
    if (req.body.action === "delete") { await pool.query("DELETE FROM dept_shifts WHERE id = $1", [b.id]); await audit(pool, c.by, "dept.schedule.remove", "dept_shifts", String(b.id), b, null); return res.redirect(`${c.base}/schedule?date=${b.d}`); }
    const e = readEntry(req.body), s = c.editable.find((x) => String(x.id) === String(req.body.staff_id));
    if (e.err || !s) return res.redirect(`${c.base}/schedule/entry/${b.id}`);
    await pool.query("UPDATE dept_shifts SET staff_id = $2, work_date = $3, start_time = $4, end_time = $5, activity = $6, note = $7, updated_at = now() WHERE id = $1", [b.id, s.id, req.body.work_date, e.start_time, e.end_time, e.activity, e.note]);
    await audit(pool, c.by, "dept.schedule.change", "dept_shifts", String(b.id), b, e);
    res.redirect(`${c.base}/schedule?date=${req.body.work_date}`);
  });
  both("post", "/schedule/copy-week", async (req, res, c) => {
    const s = c.editable.find((x) => String(x.id) === String(req.body.staff_id)), mon = okDate(req.body.monday) ? mondayOf(req.body.monday) : null;
    if (!s || !mon) return res.redirect(`${c.base}/schedule`);
    await tx(async (cn) => {
      const prev = (await cn.query("SELECT *, work_date::text AS d FROM dept_shifts WHERE staff_id = $1 AND work_date BETWEEN $2 AND $3", [s.id, addDays(mon, -7), addDays(mon, -1)])).rows;
      const busy = new Set((await cn.query("SELECT work_date::text AS d FROM dept_shifts WHERE staff_id = $1 AND work_date BETWEEN $2 AND $3", [s.id, mon, addDays(mon, 6)])).rows.map((r) => r.d));
      for (const b of prev) { const d = addDays(b.d, 7); if (!busy.has(d)) await cn.query("INSERT INTO dept_shifts (staff_id, work_date, start_time, end_time, activity, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)", [s.id, d, b.start_time, b.end_time, b.activity, b.note, c.by]); }
      await audit(cn, c.by, "dept.schedule.copy_week", "dept_shifts", String(s.id), null, { monday: mon });
    });
    res.redirect(`${c.base}/schedule?date=${mon}`);
  });
  both("get", "/schedule/export.xlsx", async (req, res, c) => {
    const m = /^\d{4}-\d{2}$/.test(req.query.month || "") ? req.query.month : R.todayLocal().slice(0, 7);
    await audit(pool, c.by, "dept.export.timesheet", "dept_shifts", m, null, null);
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").set("Content-Disposition", `attachment; filename="Timesheet-${m}.xlsx"`).send(await hrWorkbook(m));
  });

  // ----- leave: add your plan (confirmed or tentative); everyone sees the team's
  both("get", "/leave", async (req, res, c) => {
    const today = R.todayLocal(), y = today.slice(0, 4);
    const rows = (await pool.query(`SELECT l.*, l.start_date::text a, l.end_date::text z, s.full_name FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id
      WHERE l.status IN ('Approved','Tentative','Pending') AND l.end_date >= $1 ORDER BY l.start_date`, [addDays(today, -31)])).rows;
    const used = (await pool.query(`SELECT s.id, s.full_name, (s.leave_entitlement + s.carry_over)::float ent, coalesce(sum(l.days) FILTER (WHERE l.status = 'Approved' AND l.leave_type = 'Annual'), 0)::float taken
      FROM dept_staff s LEFT JOIN dept_leave l ON l.staff_id = s.id AND extract(year FROM l.start_date) = $1 WHERE s.active GROUP BY s.id ORDER BY s.full_name`, [+y])).rows;
    const can = (l) => c.editable.some((s) => s.id === l.staff_id);
    c.send(res, "Leave", `<div class="grid">
      <section class="card c8"><h2>Team leave</h2>
        ${table(["Who", "Dates", "Days", "Type", "", ""], rows.map((l) => [l.full_name, `${fmtDate(l.a).replace(/ \d{4}$/, "")}${l.z !== l.a ? " – " + fmtDate(l.z) : " " + l.a.slice(0, 4)}`, nf(l.days, 1), l.leave_type,
          raw(`<span class="sc-lv ${l.status === "Approved" ? "conf" : "tent"}" style="display:inline-block;margin:0">${l.status === "Approved" ? "Confirmed" : "Tentative"}</span>`),
          raw(can(l) ? `${l.status !== "Approved" ? `<form method="post" action="${c.base}/leave/${l.id}" style="display:inline"><button class="btn tblbtn" name="do" value="confirm">Confirm</button></form> ` : ""}<form method="post" action="${c.base}/leave/${l.id}" data-confirm="Remove this leave?" style="display:inline"><button class="btn tblbtn" name="do" value="remove">Remove</button></form>` : "")]), { num: [2], empty: "No leave planned." })}
        <p class="muted" style="font-size:13px;margin:8px 0 0">Annual leave left in ${y}: ${used.map((u) => `${h(u.full_name.split(" ")[0])} ${nf(u.ent - u.taken, 1)}`).join(" · ")} days</p></section>
      ${c.editable.length ? `<section class="card c4"><h2>Add leave</h2><form class="form" method="post" action="${c.base}/leave">
        ${c.editable.length > 1 ? `<label>Who<select name="staff_id">${c.editable.map((s) => `<option value="${s.id}" ${c.mine && c.mine.id === s.id ? "selected" : ""}>${h(s.full_name)}</option>`).join("")}</select></label>` : `<input type="hidden" name="staff_id" value="${c.editable[0].id}">`}
        <div class="row2"><label>From<input type="date" name="start_date" required></label><label>To<input type="date" name="end_date" required></label></div>
        <div class="row2"><label>Type<select name="leave_type">${LEAVE_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></label>
          <label>Plan<select name="plan"><option value="Approved">Confirmed</option><option value="Tentative">Tentative</option></select></label></div>
        <button class="btn primary">Save</button></form></section>` : ""}
    </div>`, "/department/leave");
  });
  both("post", "/leave", async (req, res, c) => {
    const b = req.body, s = c.editable.find((x) => String(x.id) === String(b.staff_id));
    if (s && okDate(b.start_date) && okDate(b.end_date) && b.end_date >= b.start_date) {
      const n = await require("./department").workingDays(b.start_date, b.end_date, false);
      const st = b.plan === "Tentative" ? "Tentative" : "Approved";
      await pool.query("INSERT INTO dept_leave (staff_id, leave_type, start_date, end_date, days, status, requested_by, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [s.id, LEAVE_TYPES.includes(b.leave_type) ? b.leave_type : "Annual", b.start_date, b.end_date, n || 0, st, c.by, st === "Approved" ? c.by : null, st === "Approved" ? new Date() : null]);
      await audit(pool, c.by, "dept.leave.create", "dept_leave", String(s.id), null, { from: b.start_date, to: b.end_date, status: st });
    }
    res.redirect(`${c.base}/leave`);
  });
  both("post", "/leave/:id", async (req, res, c) => {
    const l = (await pool.query("SELECT * FROM dept_leave WHERE id = $1", [+req.params.id || 0])).rows[0];
    if (l && c.editable.some((s) => s.id === l.staff_id)) {
      const st = req.body.do === "confirm" ? "Approved" : "Cancelled";
      await pool.query("UPDATE dept_leave SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1", [l.id, st, c.by]);
      await audit(pool, c.by, st === "Approved" ? "dept.leave.confirm" : "dept.leave.remove", "dept_leave", String(l.id), null, null);
    }
    res.redirect(`${c.base}/leave`);
  });

  // older addresses go to the new pages
  for (const p of ["", "/me", "/availability", "/attendance", "/hr"]) app.get("/department" + p, S, (req, res) => res.redirect(p === "/me" ? "/department/leave" : "/department/schedule"));
  app.get("/d/:token", (req, res) => res.redirect(`/d/${encodeURIComponent(req.params.token)}/schedule`));

  // ----- Share: a personal link (no sign-in) that can edit one person's schedule and leave
  app.get("/department/share", A, wrap(async (req, res) => {
    const rows = (await pool.query("SELECT d.*, s.full_name AS staff_name FROM dept_share_links d LEFT JOIN dept_staff s ON s.id = d.staff_id ORDER BY d.active DESC, d.created_at DESC")).rows;
    const staff = await allStaff(), base = `${req.protocol}://${req.get("host")}`;
    res.send(page(req, "Share", `<section class="card"><h2>Personal link</h2><p class="lead"><b>View only</b> (e.g. HR): sees the team schedule and leave, and can download the timesheet; can't change anything. <b>A team member</b> (e.g. your manager): the same, and can change only their own time and leave.</p>
      <form class="inline-form" method="post" action="/department/share"><select class="inp" name="staff_id" aria-label="Who is the link for"><option value="">View only (HR)</option>${staff.map((s) => `<option value="${s.id}">${h(s.full_name)} (can edit own)</option>`).join("")}</select><button class="btn primary">Make link</button></form></section>
      ${rows.map((l) => `<section class="card" style="display:grid;gap:8px;${l.active ? "" : "opacity:.6"}"><div class="card-head"><h2>${h(l.staff_name || l.label)} ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}</h2><span class="muted" style="font-size:13px">${l.staff_id ? "Can edit own time and leave" : "View only"} · last opened ${fmtTs(l.last_opened)}</span></div>
        ${l.active ? `<div class="toolbar" style="margin:0"><button class="btn primary" data-copy="${h(base)}/d/${h(l.token)}">Copy link</button><a class="btn" href="/d/${h(l.token)}" target="_blank" rel="noopener">Open</a>
          <form method="post" action="/department/share/${l.id}" style="display:inline"><button class="btn danger" name="active" value="0">Switch off</button></form></div>`
    : `<form method="post" action="/department/share/${l.id}"><button class="btn" name="active" value="1">Switch on with a new link</button></form>`}</section>`).join("")}`, { active: "/department/share" }));
  }));
  app.post("/department/share", A, wrap(async (req, res) => {
    // no person chosen = view only (e.g. HR): can look and download the timesheet, can't change anything
    const s = req.body.staff_id ? (await pool.query("SELECT * FROM dept_staff WHERE id = $1 AND active", [+req.body.staff_id || 0])).rows[0] : null;
    if (req.body.staff_id && !s) return res.redirect("/department/share");
    const label = s ? s.full_name : "HR (view only)";
    await pool.query("INSERT INTO dept_share_links (token, label, staff_id, created_by) VALUES ($1,$2,$3,$4)", [crypto.randomBytes(12).toString("base64url"), label, s ? s.id : null, actor(req)]);
    await audit(pool, actor(req), "dept.share.create", "dept_share_links", label, null, null);
    setFlash(req, "ok", `Link made: ${label}. Copy it and send it.`);
    res.redirect("/department/share");
  }));
  app.post("/department/share/:id", A, wrap(async (req, res) => {
    const on = req.body.active === "1";
    await pool.query(`UPDATE dept_share_links SET active = $2 ${on ? ", token = $3" : ""} WHERE id = $1`, [+req.params.id, on, ...(on ? [crypto.randomBytes(12).toString("base64url")] : [])]);
    await audit(pool, actor(req), on ? "dept.share.on" : "dept.share.off", "dept_share_links", req.params.id, null, null);
    res.redirect("/department/share");
  }));
};

/** First start only: team names from the October 2026 roster when the list is empty. */
async function seedTeam() {
  if ((await pool.query("SELECT 1 FROM settings WHERE key = 'deptTeamSeeded'")).rows[0]) return;
  if (!Number((await pool.query("SELECT count(*) n FROM dept_staff")).rows[0].n))
    for (const n of ["Lynsey", "Ronamae", "Jasper", "Manal", "Chane"]) await pool.query("INSERT INTO dept_staff (full_name) VALUES ($1)", [n]);
  await pool.query("INSERT INTO settings (key, value) VALUES ('deptTeamSeeded', 'true') ON CONFLICT (key) DO NOTHING");
}
module.exports.seedTeam = seedTeam;
module.exports.load = load;
module.exports.ACTS = ACTS;
module.exports.hrWorkbook = hrWorkbook;
module.exports.mondayOf = mondayOf;
module.exports.weekHours = async (staffId, monday) => { const D = await load(monday, addDays(monday, 6), { staffIds: [staffId] }); return days(monday, addDays(monday, 6)).reduce((a, d) => a + D.day(staffId, d).hours, 0); };
