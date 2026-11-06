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
  for (const x of P.historyRides) if (x.d >= start && x.d <= end && x.location === city) {
    const k = x.d + "|" + x.series, s = out.get(k) || { d: x.d, series: x.series, n: 0, lead: !!x.lead };
    s.n += x.attendees || 0; out.set(k, s);
  }
  for (const r of P.rows) if (r.kind === "ride" && r.qualifying && !r.coveredByHistory && r.d >= start && r.d <= end && r.location === city) {
    const k = r.d + "|" + r.series, s = out.get(k) || { d: r.d, series: r.series, n: 0, people: new Set() };
    if (s.people) s.people.add(r.person); else s.n++;
    out.set(k, s);
  }
  return [...out.values()].map((s) => ({ ...s, n: s.people ? s.people.size : s.n })).sort((a, b) => b.d.localeCompare(a.d));
}

module.exports = function ridesPerf(app, { need, page, wrap }) {
  const READ = need("admin", "coordinator", "viewer");
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
        <section class="card c12"><div class="card-head"><h2>Every ride</h2>
          ${cityKey === "auh" ? `<a class="btn" href="/rides">Attendance per ride: check people in</a>` : `<a class="btn" href="/dubai">Dubai lead link &amp; photos</a>`}</div>
          <div class="tw"><table><thead><tr><th>Date</th><th>Ride</th><th class="n">Riders</th><th>How it was counted</th></tr></thead><tbody>
          ${list.map((s) => `<tr><td style="white-space:nowrap">${fmtDate(s.d)}</td><td>${h(s.series)}</td><td class="n"><b>${nf(s.n)}</b></td><td class="muted">${s.lead ? "Sent by the ride lead" : s.people !== undefined || s.lead === undefined ? "QR check-ins" : "Attendance records"}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No rides in ${h(per.label)}.</td></tr>`}
          </tbody></table></div></section>
      </div>`, { active: "/wmf/rides" }));
  }));
};
module.exports.sessions = sessions;
