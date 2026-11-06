"use strict";
/**
 * Rides: Abu Dhabi or Dubai at a glance for a month, quarter or year: participation, rides held,
 * average per ride, new riders, each ride series, and every ride with its turnout.
 */
const R = require("./rules");
const E = require("./engine");
const { buildData } = require("./snapshot");
const CD = require("./corpdata");
const { h, fmtDate, monLabel, nf } = require("./views");
const { columns } = require("./charts");

const H = E.helpers;
const CITIES = { auh: { name: "Abu Dhabi", color: "#5b7cf0" }, dxb: { name: "Dubai", color: "#e8833a" } };
const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
const pctCh = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);

/** Every ride (date + series) in a city between two days, with its turnout. */
function sessions(P, city, start, end) {
  const out = new Map();
  // each imported or lead-sent ride stays its own line, so a ride entered twice shows up as two lines
  for (const x of P.historyRides) if (x.d >= start && x.d <= end && x.location === city) {
    const k = x.lead ? "l" + x.lid : "h" + (x.hid || x.d + x.series);
    out.set(k, { d: x.d, series: x.series, n: x.attendees || 0, lead: !!x.lead, src: x.lead ? "l" : "h", id: x.lead ? x.lid : x.hid, label: x.initiative });
  }
  for (const r of P.rows) if (r.kind === "ride" && r.qualifying && !r.coveredByHistory && r.d >= start && r.d <= end && r.location === city) {
    const k = r.d + "|" + r.series, s = out.get(k) || { d: r.d, series: r.series, people: new Set(), src: "q", recs: [] };
    s.people.add(r.person); s.recs.push(r.recordId); out.set(k, s);
  }
  const list = [...out.values()].map((s) => (s.people ? { ...s, n: s.people.size } : s)).sort((a, b) => b.d.localeCompare(a.d) || a.series.localeCompare(b.series));
  // same day and same ride more than once: probably entered twice
  const seen = new Map();
  for (const s of list) { const k = s.d + "|" + s.series.toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  for (const s of list) s.dupe = seen.get(s.d + "|" + s.series.toLowerCase()) > 1;
  return list;
}
const editHref = (s, back) => `/wmf/rides/ride?${new URLSearchParams(s.src === "q" ? { src: "q", d: s.d, recs: s.recs.join(","), back } : { src: s.src, id: s.id, back })}`;

module.exports = function ridesPerf(app, { need, page, wrap, user, setFlash, actor }) {
  const READ = need("admin", "coordinator", "viewer"), STAFF = need("admin", "coordinator");
  const { pool, tx, audit } = require("./db");
  const safeBack = (b) => (String(b || "").startsWith("/wmf/rides") ? String(b) : "/wmf/rides");

  // ----- one ride: change it, or remove it
  app.get("/wmf/rides/ride", STAFF, wrap(async (req, res) => {
    const q = req.query, back = safeBack(q.back);
    let body = "";
    if (q.src === "h") {
      const r = (await pool.query("SELECT *, ride_date::text AS d FROM history_rides WHERE id = $1", [+q.id || 0])).rows[0];
      if (!r) return res.redirect(back);
      body = `<p class="lead">From the imported attendance records.</p><form class="form" method="post" action="/wmf/rides/ride"><input type="hidden" name="src" value="h"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="back" value="${h(back)}">
        <div class="row2"><label>Date<input type="date" name="d" value="${h(r.d)}" required></label><label>City<select name="city"><option ${/dxb|dubai/i.test(r.state || "") ? "" : "selected"}>Abu Dhabi</option><option ${/dxb|dubai/i.test(r.state || "") ? "selected" : ""}>Dubai</option></select></label></div>
        <div class="row2"><label>Ride<input name="name" maxlength="80" value="${h(r.initiative)}" required></label><label>Riders<input type="number" name="n" min="0" max="999" value="${r.attendees}" required></label></div>
        <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn danger" name="action" value="delete" data-confirm="Delete this ride? Its riders will no longer count." formnovalidate>Delete this ride</button><a class="btn ghost" href="${h(back)}">Cancel</a></div></form>`;
    } else if (q.src === "l") {
      const r = (await pool.query("SELECT *, ride_date::text AS d, (SELECT count(*)::int FROM lead_photos p WHERE p.ride_id = r.id) AS photos FROM lead_rides r WHERE id = $1", [+q.id || 0])).rows[0];
      if (!r) return res.redirect(back);
      body = `<p class="lead">Sent by the ride lead${r.photos ? `, with ${r.photos} photo${r.photos === 1 ? "" : "s"}` : ""}.</p><form class="form" method="post" action="/wmf/rides/ride"><input type="hidden" name="src" value="l"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="back" value="${h(back)}">
        <div class="row2"><label>Date<input type="date" name="d" value="${h(r.d)}" required></label><label>Ride<select name="type">${["Monday", "Thursday", "Weekend", "Special ride"].map((t) => `<option ${t === r.ride_type ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
        <div class="row2"><label>Special ride name<input name="name" maxlength="80" value="${h(r.title)}"></label><label>Riders<input type="number" name="n" min="0" max="999" value="${r.participants}" required></label></div>
        <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn danger" name="action" value="delete" data-confirm="Delete this ride and its photos?" formnovalidate>Delete this ride</button><a class="btn ghost" href="${h(back)}">Cancel</a></div></form>`;
    } else if (q.src === "q") {
      const recs = String(q.recs || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 300);
      const rows = recs.length ? (await pool.query(`SELECT p.id, p.record_id, p.record_date, p.source, p.activity_name, m.full_name, m.member_id FROM participation p LEFT JOIN members m ON m.member_id = p.member_id
        WHERE p.record_id = ANY($1) AND p.voided_at IS NULL ORDER BY m.full_name`, [recs])).rows : [];
      if (!rows.length) return res.redirect(back);
      body = `<p class="lead">${rows.length} check-in${rows.length === 1 ? "" : "s"} on ${fmtDate(q.d)}. Remove one person, or delete the whole ride if it shouldn't count.</p>
        <ul class="log">${rows.map((r) => `<li><span><b>${h(r.full_name || "—")}</b> <span class="muted">${h(r.member_id || "")} · ${h(r.activity_name || "")} · ${h(r.source || "")}</span></span>
          <form method="post" action="/wmf/rides/ride" style="margin:0"><input type="hidden" name="src" value="q"><input type="hidden" name="recs" value="${h(r.record_id)}"><input type="hidden" name="back" value="${h(req.originalUrl)}"><button class="btn tblbtn" name="action" value="delete" data-confirm="Remove ${h(r.full_name || "this check-in")} from this ride?">Remove</button></form></li>`).join("")}</ul>
        <form method="post" action="/wmf/rides/ride" class="toolbar" style="margin-top:12px"><input type="hidden" name="src" value="q"><input type="hidden" name="recs" value="${h(recs.join(","))}"><input type="hidden" name="back" value="${h(back)}">
          <button class="btn danger" name="action" value="delete" data-confirm="Delete the whole ride (all ${rows.length} check-ins)?">Delete the whole ride</button><a class="btn ghost" href="${h(back)}">Back</a></form>
        <p class="hint">To add someone, use <a href="/rides">Attendance per ride</a>.</p>`;
    } else return res.redirect(back);
    res.send(page(req, "Edit ride", `<section class="card narrow"><h2>Edit ride</h2>${body}</section>`, { active: "/wmf/rides", wide: false }));
  }));
  app.post("/wmf/rides/ride", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, back = safeBack(b.back), del = b.action === "delete", by = actor(req);
    const okD = /^\d{4}-\d{2}-\d{2}$/.test(b.d || "") && b.d <= R.todayLocal(), n = /^\d{1,3}$/.test(String(b.n || "")) ? +b.n : null;
    let msg = "Saved.";
    await tx(async (c) => {
      if (b.src === "h") {
        const old = (await c.query("SELECT * FROM history_rides WHERE id = $1", [+b.id || 0])).rows[0]; if (!old) return;
        if (del) { await c.query("DELETE FROM history_rides WHERE id = $1", [old.id]); msg = "Ride deleted."; }
        else { if (!okD || n == null) { msg = "Check the date and the number of riders."; return; }
          await c.query("UPDATE history_rides SET ride_date = $2, initiative = $3, state = $4, attendees = $5 WHERE id = $1", [old.id, b.d, R.clean(b.name).slice(0, 80) || old.initiative, b.city === "Dubai" ? "DXB" : "AUH", n]); }
        await audit(c, by, del ? "ride.delete" : "ride.update", "history_ride", String(old.id), old, del ? null : { date: b.d, name: b.name, city: b.city, riders: n });
      } else if (b.src === "l") {
        const old = (await c.query("SELECT * FROM lead_rides WHERE id = $1", [+b.id || 0])).rows[0]; if (!old) return;
        if (del) { await c.query("DELETE FROM lead_rides WHERE id = $1", [old.id]); msg = "Ride deleted."; }
        else { if (!okD || n == null) { msg = "Check the date and the number of riders."; return; }
          const type = ["Monday", "Thursday", "Weekend", "Special ride"].includes(b.type) ? b.type : old.ride_type;
          await c.query("UPDATE lead_rides SET ride_date = $2, ride_type = $3, title = $4, participants = $5, updated_at = now() WHERE id = $1", [old.id, b.d, type, type === "Special ride" ? R.clean(b.name).slice(0, 80) || null : null, n]); }
        await audit(c, by, del ? "ride.delete" : "ride.update", "lead_ride", String(old.id), old, del ? null : { date: b.d, type: b.type, riders: n });
      } else if (b.src === "q" && del) {
        const recs = String(b.recs || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 300);
        const r = await c.query("UPDATE participation SET voided_at = now(), void_reason = 'Removed from the Rides page' WHERE record_id = ANY($1) AND voided_at IS NULL RETURNING record_id", [recs]);
        await audit(c, by, "ride.checkins_removed", "participation", recs.slice(0, 5).join(","), null, { removed: r.rowCount });
        msg = r.rowCount === 1 ? "Check-in removed." : `Ride deleted (${r.rowCount} check-ins removed).`;
      }
    });
    setFlash(req, msg.startsWith("Check") ? "err" : "ok", msg);
    res.redirect(back);
  }));

  app.get("/wmf/rides", READ, wrap(async (req, res) => {
    const cityKey = req.query.city === "dxb" ? "dxb" : "auh", city = CITIES[cityKey];
    const today = R.todayLocal();
    const type = ["month", "quarter", "year"].includes(req.query.period) ? req.query.period : "month";
    const per = CD.periodFromQuery({ period: type, p: req.query.p || (type === "month" ? today.slice(0, 7) : type === "quarter" ? `${today.slice(0, 4)}-Q${Math.floor((+today.slice(5, 7) - 1) / 3) + 1}` : today.slice(0, 4)) }, today);
    const end = per.end < today ? per.end : today, prevR = E.previousPeriod(per.start, per.end);
    const P = E.prepare(await buildData());
    const cur = E.compute(P, { start: per.start, end, location: city.name }, today), k = cur.kpis;
    const prev = E.compute(P, { start: prevR.start, end: prevR.end, location: city.name }, today, { light: true }).kpis;
    const list = sessions(P, city.name, per.start, end);
    const rides = list.length, people = list.reduce((a, s) => a + s.n, 0), avg = rides ? people / rides : null;
    const prevList = sessions(P, city.name, prevR.start, prevR.end), prevPeople = prevList.reduce((a, s) => a + s.n, 0);
    const series = new Map();
    for (const s of list) { const x = series.get(s.series) || { name: s.series, rides: 0, people: 0, best: null }; x.rides++; x.people += s.n; if (!x.best || s.n > x.best.n) x.best = s; series.set(s.series, x); }
    const bySeries = [...series.values()].sort((a, b) => b.people - a.people);
    const maxS = Math.max(1, ...bySeries.map((x) => x.people / x.rides));
    // chart: each ride in a month; each month in a quarter or year
    const chart = type === "month"
      ? (list.length ? columns({ categories: [...list].reverse().map((s) => s.d + "|" + s.series), series: [{ name: city.name, color: city.color, values: [...list].reverse().map((s) => s.n) }], height: 190, label: "Riders per ride", short: (c) => `${+c.slice(8, 10)} ${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][new Date(c.slice(0, 10) + "T12:00:00Z").getUTCDay()]}` }) : "")
      : columns({ categories: H.monthsBetween(per.start.slice(0, 7), end.slice(0, 7)), series: [{ name: city.name, color: city.color, values: H.monthsBetween(per.start.slice(0, 7), end.slice(0, 7)).map((m) => sessions(P, city.name, m + "-01", H.monthEnd(m)).reduce((a, s) => a + s.n, 0)) }], height: 190, label: "Participation by month", short: (m) => monLabel(m) });
    const opts = [];
    if (type === "month") for (const m of H.monthsBetween("2025-01", today.slice(0, 7)).reverse()) opts.push([m, monLabel(m, true)]);
    if (type === "quarter") for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) opts.push([`${y}-Q${q}`, `Q${q} ${y}`]);
    if (type === "year") for (let y = +today.slice(0, 4); y >= 2025; y--) opts.push([String(y), String(y)]);
    const q = (o) => new URLSearchParams({ city: cityKey, period: type, p: per.p, ...o }).toString();
    const ch = pctCh(people, prevPeople);
    const delta = ch == null ? "" : `<span class="${ch >= 0 ? "rp-up" : "rp-down"}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch)}%</span> vs before`;
    const lead = list.some((s) => s.lead);
    const canEdit = ["admin", "coordinator"].includes(user(req).role), back = req.originalUrl, dupes = list.filter((s) => s.dupe).length;
    res.send(page(req, `Rides · ${city.name}`, `
      <section class="mk-head"><div><div class="wc-eyebrow">Rides</div><h2 class="ov-title">${h(city.name)} · ${h(per.label)}</h2></div>
        <div class="mk-actions"><span class="seg rd-city">${Object.entries(CITIES).map(([key, c]) => `<a href="/wmf/rides?${q({ city: key })}" class="${key === cityKey ? "on" : ""}">${h(c.name)}</a>`).join("")}</span>
          <span class="seg">${Object.keys(KIND).map((t) => `<a href="/wmf/rides?city=${cityKey}&period=${t}" class="${type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
          <form method="get" style="margin:0"><input type="hidden" name="city" value="${cityKey}"><input type="hidden" name="period" value="${type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="Period">${opts.map(([v, l]) => `<option value="${v}" ${v === per.p ? "selected" : ""}>${h(l)}</option>`).join("")}</select></form></div></section>
      <div class="tiles ov-tiles mk-tiles">
        <div class="tile big"><span class="lbl">Participation</span><span class="val">${nf(people)}</span><span class="note">${delta}</span></div>
        <div class="tile big"><span class="lbl">Rides held</span><span class="val">${nf(rides)}</span><span class="note">${prevList.length ? `${prevList.length} the period before` : ""}</span></div>
        <div class="tile big"><span class="lbl">Avg. riders per ride</span><span class="val">${avg ? nf(Math.round(avg)) : "—"}</span></div>
        <div class="tile big"><span class="lbl">New riders</span><span class="val">${lead && !k.firstTimers ? "—" : nf(k.firstTimers)}</span><span class="note">${lead && !k.firstTimers ? "Headcounts only: names aren't recorded" : "First ride with WMF"}</span></div>
      </div>
      <div class="grid">
        <section class="card c7"><h2>${type === "month" ? "Riders per ride" : "Participation by month"}</h2>${chart || '<p class="muted">No rides in this period.</p>'}</section>
        <section class="card c5"><h2>By ride</h2>
          ${bySeries.length ? `<div class="hbars">${bySeries.map((x) => `<div class="hbar"><span class="hbar-l">${h(x.name)}</span><span class="hbar-t"><span style="width:${(x.people / x.rides / maxS) * 100}%;background:${city.color}"></span></span>
            <span class="hbar-v"><b>${nf(Math.round(x.people / x.rides))}</b> <span class="muted">avg · ${x.rides} ride${x.rides === 1 ? "" : "s"}</span></span></div>`).join("")}</div>` : '<p class="muted">No rides.</p>'}
          <p class="hint" style="margin-top:8px">Average riders per ride. Best turnout: ${bySeries.length ? bySeries.map((x) => `${h(x.name)} ${x.best.n} (${fmtDate(x.best.d)})`).slice(0, 2).join(", ") : "—"}.</p></section>
        <section class="card c12"><div class="card-head"><div><h2>Every ride</h2>${dupes ? `<p class="lead" style="margin:0"><span class="badge warn">${dupes}</span> rides look entered twice (same day, same ride). Open one with Edit / delete to fix or remove it.</p>` : ""}</div>
          ${cityKey === "auh" ? `<a class="btn" href="/rides">Attendance per ride: check people in</a>` : `<a class="btn" href="/dubai">Dubai lead link &amp; photos</a>`}</div>
          <div class="tw"><table><thead><tr><th>Date</th><th>Ride</th><th class="n">Riders</th><th>How it was counted</th><th></th></tr></thead><tbody>
          ${list.map((s) => `<tr${s.dupe ? ' class="rd-dupe"' : ""}><td style="white-space:nowrap">${fmtDate(s.d)}</td><td>${h(s.series)}${s.dupe ? ' <span class="badge warn">Possible duplicate</span>' : ""}</td><td class="n"><b>${nf(s.n)}</b></td>
            <td class="muted">${s.src === "l" ? "Sent by the ride lead" : s.src === "q" ? "QR check-ins" : "Attendance records"}</td>
            <td>${canEdit ? `<a class="btn tblbtn" href="${h(editHref(s, back))}">Edit / delete</a>` : ""}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No rides in ${h(per.label)}.</td></tr>`}
          </tbody></table></div></section>
      </div>`, { active: "/wmf/rides" }));
  }));
};
module.exports.sessions = sessions;
