"use strict";
/**
 * Management overview: one page that answers, in plain language, how WMF is doing.
 * Figures come from the same rules as the detailed dashboard; nothing on this page names a member.
 */
const { pool, getSettings } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { buildData } = require("./snapshot");
const { loadActivations } = require("./activations");
const { databaseMix } = require("./demographics");
const { h, fmtDate, detailTiles, mini } = require("./views");

const H = E.helpers;
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const nf = (n) => (n == null ? "—" : Number(n).toLocaleString("en-GB"));
const monLabel = (m, y) => MON[+m.slice(5, 7) - 1] + (y ? " " + m.slice(0, 4) : "");
const pctChange = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
function delta(cur, prev, what) {
  if (prev == null) return "";
  const p = pctChange(cur, prev);
  if (p == null) return `<span class="delta">${nf(prev)} ${what}</span>`;
  const cls = p > 0 ? "up" : p < 0 ? "down" : "";
  return `<span class="delta"><span class="${cls}">${p > 0 ? "▲" : p < 0 ? "▼" : "●"} ${Math.abs(p)}%</span> vs ${nf(prev)} ${what}</span>`;
}

// ---------- small SVG charts (thin marks, rounded data ends, recessive axes, hover via tips.js) ----------
function niceMax(v) { if (v <= 5) return 5; const p = 10 ** Math.floor(Math.log10(v)); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return 10 * p; }
const tipAttr = (value, label) => `tabindex="0" data-tip="${h(`<b>${value}</b><br>${label}`)}"`;
function barChart(data, { label, color = "var(--s1)", height = 190, unit = "", width = 640 }) {
  if (!data.length || !data.some((d) => d.value > 0)) return `<div class="empty">No data for this period yet.</div>`;
  const W = width, Hh = height, padL = 34, padB = 22, padT = 8, iw = W - padL - 6, ih = Hh - padB - padT;
  const max = niceMax(Math.max(...data.map((d) => d.value)));
  const bw = iw / data.length, w = Math.max(4, Math.min(42, bw - 4));
  const y = (v) => padT + ih - (v / max) * ih;
  const grid = [0, max / 2, max].map((g) => `<line x1="${padL}" x2="${W - 6}" y1="${y(g)}" y2="${y(g)}"/><text x="${padL - 6}" y="${y(g) + 4}" text-anchor="end">${nf(g)}</text>`).join("");
  const every = Math.ceil(data.length / 12);
  const bars = data.map((d, i) => {
    const x = padL + i * bw + (bw - w) / 2, top = y(d.value), hgt = padT + ih - top, r = Math.min(4, hgt, w / 2);
    const path = hgt > 0 ? `M${x},${padT + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + w - r} Q${x + w},${top} ${x + w},${top + r} V${padT + ih} Z` : "";
    return `<g class="mark" ${tipAttr(nf(d.value) + unit, d.tip || d.label)}><rect class="hit" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${ih}"/>${path ? `<path d="${path}" fill="${color}"/>` : ""}</g>
      ${i % every === 0 ? `<text x="${x + w / 2}" y="${Hh - 6}" text-anchor="middle">${h(d.label)}</text>` : ""}`;
  }).join("");
  return `<div class="chart"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${h(label)}"><g class="grid">${grid}</g>${bars}<line class="base" x1="${padL}" x2="${W - 6}" y1="${padT + ih}" y2="${padT + ih}"/></svg></div>`;
}
function lineChart(points, { label, color = "var(--s3)", height = 210 }) {
  if (points.length < 2) return `<div class="empty">Not enough data yet.</div>`;
  const W = 640, Hh = height, padL = 40, padB = 22, padT = 10, iw = W - padL - 10, ih = Hh - padB - padT;
  const max = niceMax(Math.max(...points.map((p) => p.value)));
  const x = (i) => padL + (i / (points.length - 1)) * iw, y = (v) => padT + ih - (v / max) * ih;
  const d = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${d} L${x(points.length - 1)},${padT + ih} L${padL},${padT + ih} Z`;
  const grid = [0, max / 2, max].map((g) => `<line x1="${padL}" x2="${W - 10}" y1="${y(g)}" y2="${y(g)}"/><text x="${padL - 6}" y="${y(g) + 4}" text-anchor="end">${nf(g)}</text>`).join("");
  const every = Math.ceil(points.length / 8), step = iw / (points.length - 1);
  const hits = points.map((p, i) => `<g class="mark" ${tipAttr(nf(p.value), p.tip || p.label)}><rect class="hit" x="${x(i) - step / 2}" y="${padT}" width="${step}" height="${ih}"/></g>`).join("");
  const labels = points.map((p, i) => (i % every === 0 || i === points.length - 1 ? `<text x="${x(i)}" y="${Hh - 6}" text-anchor="middle">${h(p.label)}</text>` : "")).join("");
  const last = points[points.length - 1];
  return `<div class="chart"><svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="${h(label)}"><g class="grid">${grid}</g>
    <path d="${area}" fill="${color}" opacity=".12"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${x(points.length - 1)}" cy="${y(last.value)}" r="4" fill="${color}" stroke="var(--surface)" stroke-width="2"/>
    <text class="val" x="${x(points.length - 1) - 8}" y="${y(last.value) - 10}" text-anchor="end">${nf(last.value)}</text>
    ${hits}${labels}<line class="base" x1="${padL}" x2="${W - 10}" y1="${padT + ih}" y2="${padT + ih}"/></svg></div>`;
}
function hbars(rows, { label, color = "var(--s2)" }) {
  if (!rows.length) return `<div class="empty">Nothing recorded yet.</div>`;
  const max = Math.max(...rows.map((r) => r.value));
  return `<div class="hbars" role="list" aria-label="${h(label)}">${rows.map((r) => `<div class="hbar" role="listitem" ${tipAttr(nf(r.value) + (r.unit || ""), r.tip || r.label)}>
    <span class="hbar-l">${h(r.label)}</span><span class="hbar-t"><span style="width:${Math.max(2, (r.value / max) * 100)}%;background:${color}"></span></span><span class="hbar-v">${nf(r.value)}${r.note ? ` <span class="muted">${h(r.note)}</span>` : ""}</span></div>`).join("")}</div>`;
}
/** One stacked bar with its numbers, e.g. Abu Dhabi 412 · Dubai 98. Empty parts are left out. */
function split(label, parts) {
  const total = parts.reduce((a, p) => a + p[1], 0);
  const shown = parts.filter((p) => p[1] > 0);
  return `<div class="split"><div class="split-h"><b>${h(label)}</b></div>
    <div class="split-bar" role="img" aria-label="${h(label + ": " + shown.map((p) => `${p[0]} ${p[1]}`).join(", "))}">${shown.map((p) => `<span style="flex:${p[1]};background:${p[2]}" ${tipAttr(nf(p[1]) + " · " + Math.round((p[1] / total) * 100) + "%", p[0])}></span>`).join("")}</div>
    <div class="split-k">${shown.map((p) => `<span><i style="background:${p[2]}"></i>${h(p[0])} <b>${nf(p[1])}</b> <span class="muted">${Math.round((p[1] / total) * 100)}%</span></span>`).join("") || '<span class="muted">No data yet.</span>'}</div></div>`;
}
const tableToggle = (id, head, rows) => `<details class="tview"><summary>Show as table</summary><div class="tw"><table id="${id}"><thead><tr>${head.map((x, i) => `<th${i ? ' class="n"' : ""}>${h(x)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${i ? ' class="n"' : ""}>${h(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></details>`;

module.exports = function overview(app, { need, page, wrap }) {
  app.get("/overview", need(), wrap(async (req, res) => {
    const today = R.todayLocal();
    const [data, settings] = await Promise.all([buildData(), getSettings()]);
    const [acts, mix] = await Promise.all([loadActivations(), databaseMix()]);
    const years = [...new Set(acts.map((a) => +String(a.month).slice(0, 4)).concat([+today.slice(0, 4)]))].sort((a, b) => b - a);
    const year = years.includes(+req.query.year) ? +req.query.year : +today.slice(0, 4);
    const isCurrent = year === +today.slice(0, 4);
    const start = `${year}-01-01`, end = isCurrent ? today : `${year}-12-31`;
    const pStart = `${year - 1}-01-01`, pEnd = isCurrent ? H.addDays(today, -365) : `${year - 1}-12-31`;
    const periodName = isCurrent ? `${year} so far` : String(year);

    // community & rides (agreed counting rules)
    const P = E.prepare(data);
    const cur = E.compute(P, { start, end }, today);
    const prev = E.compute(P, { start: pStart, end: pEnd }, today, { light: true }).kpis;
    const k = cur.kpis;
    const months = H.monthsBetween(start.slice(0, 7), end.slice(0, 7));
    const trend = cur.trend.filter((t) => months.includes(t.month));

    // database growth: everyone who has joined, month by month
    const firsts = data.members.map((m) => String(m.firstSeen || "").slice(0, 7)).filter(Boolean).sort();
    const growthStart = [firsts[0] || today.slice(0, 7), H.addMonths(today.slice(0, 7), -35)].sort().pop();
    const growth = H.monthsBetween(growthStart, today.slice(0, 7)).map((m) => {
      const total = firsts.filter((f) => f <= m).length;
      return { label: monLabel(m, true).replace(" 20", " ’"), value: total, tip: `members by end of ${monLabel(m, true)}` };
    });
    const newByMonth = months.map((m) => ({ label: MON[+m.slice(5, 7) - 1], value: firsts.filter((f) => f === m).length, tip: `new members in ${monLabel(m, true)}` }));
    const totalMembers = data.members.length;

    // activations & partners
    const separate = new Set((settings.separateEvents || []).map((s) => s.toLowerCase()));
    const inYear = (a, s, e) => String(a.month).slice(0, 10) >= s.slice(0, 7) + "-01" && String(a.month).slice(0, 10) <= e;
    const done = acts.filter((a) => a.status === "Completed" && inYear(a, start, end));
    const donePrev = acts.filter((a) => a.status === "Completed" && inYear(a, pStart, pEnd));
    const isBig = (a) => separate.has(String(a.title).toLowerCase().trim());
    const people = (list) => list.filter((a) => !isBig(a)).reduce((s, a) => s + (a.participants || 0), 0);
    const big = done.filter(isBig);
    const withPartner = done.filter((a) => a.partners.length);
    const partnerStats = new Map();
    for (const a of done) for (const p of a.partners) { const s = partnerStats.get(p) || { n: 0, people: 0 }; s.n++; s.people += isBig(a) ? 0 : a.participants || 0; partnerStats.set(p, s); }
    const firstYearOf = new Map();
    for (const a of acts.filter((x) => x.status === "Completed")) for (const p of a.partners) { const y = +String(a.month).slice(0, 4); if (!firstYearOf.has(p) || y < firstYearOf.get(p)) firstYearOf.set(p, y); }
    const newPartners = [...partnerStats.keys()].filter((p) => firstYearOf.get(p) === year);
    const topPartners = [...partnerStats.entries()].sort((a, b) => b[1].n - a[1].n || b[1].people - a[1].people).slice(0, 8);
    const byCat = new Map();
    for (const a of done) { const c = byCat.get(a.category) || { n: 0, people: 0 }; c.n++; c.people += isBig(a) ? 0 : a.participants || 0; byCat.set(a.category, c); }
    const cats = [...byCat.entries()].sort((a, b) => b[1].people - a[1].people);
    const actsByMonth = months.map((m) => { const list = done.filter((a) => String(a.month).slice(0, 7) === m); return { label: MON[+m.slice(5, 7) - 1], value: list.length, tip: `activations in ${monLabel(m, true)} · ${nf(people(list))} participants` }; });
    const highlights = done.filter((a) => a.impact && !isBig(a)).sort((a, b) => (b.participants || 0) - (a.participants || 0)).slice(0, 6);
    const rideBars = trend.map((t) => ({ label: MON[+t.month.slice(5, 7) - 1], value: t.rideAttendance, tip: `ride attendances in ${monLabel(t.month, true)}` }));
    const sessions = k.rideSessions, avgPerRide = sessions ? Math.round(k.rideAttendance / sessions) : null;

    const bigNames = (settings.separateEvents || []).join(", ") || "none";
    const tile = (lbl, val, sub, note) => `<div class="tile big"><span class="lbl">${lbl}</span><span class="val">${val}</span>${sub || ""}${note ? `<span class="note">${note}</span>` : ""}</div>`;
    const q = (r) => `?year=${r}`;
    res.send(page(req, "Overview", `
      <section class="ov-head"><div><div class="wc-eyebrow">WMF at a glance</div><h2 class="ov-title">${h(periodName)}</h2>
        <p class="lead" style="margin:4px 0 0">How the Women Moving Forward community is doing: who joins, who rides, what we organise and who we work with. Figures as of ${fmtDate(today)}${isCurrent ? `, compared with the same dates in ${year - 1}` : `, compared with ${year - 1}`}.</p></div>
        <nav class="seg" aria-label="Year">${years.map((y) => `<a href="${q(y)}" class="${y === year ? "on" : ""}" ${y === year ? 'aria-current="page"' : ""}>${y}</a>`).join("")}</nav></section>

      ${detailTiles([
        { label: "Community members", value: nf(totalMembers), note: `<span class="delta">+${nf(k.newMembers)} joined in ${h(periodName)}</span><br>Everyone in the member database`,
          detail: { title: "The community", html: `<div class="grid"><div class="c6">${mini(["City", "Members"], [["Abu Dhabi", nf(mix.city.auh)], ["Dubai", nf(mix.city.dxb)]], { num: [1] })}</div>
            <div class="c6">${mini(["", "Members"], [["Women", nf(mix.gender.women)], ["Men", nf(mix.gender.men)], ["Not recorded", nf(mix.gender.unknown)]], { num: [1] })}</div></div>
            <h3>New members by month</h3>${mini(["Month", "Joined"], newByMonth.map((x, i) => [monLabel(months[i], true), nf(x.value)]), { num: [1] })}` } },
        { label: "Active riders now", value: nf(k.activeMembers), note: "2+ rides in the last 90 days, or a first ride in that time",
          detail: { title: "Riders this period", html: mini(["", "People"], [["Rode at least once", nf(k.participants)], ["Came back (rode before this period)", nf(k.returning)], ["First ride with WMF", nf(k.firstTimers)], ["Active now (last 90 days)", nf(k.activeMembers)]], { num: [1] }) } },
        { label: "Ride attendances", value: nf(k.rideAttendance), note: `${delta(k.rideAttendance, prev.rideAttendance, `in ${year - 1}`)}<br>${nf(sessions)} rides held${avgPerRide ? ` · about ${avgPerRide} per ride` : ""}`,
          detail: { title: "Ride attendances by month", html: mini(["Month", "Attendances"], trend.map((t) => [monLabel(t.month, true), nf(t.rideAttendance)]), { num: [1] }) + `<p class="hint">For each ride, see <a href="/wmf/rides">Rides</a>.</p>` } },
        { label: "Events & activations", value: nf(done.length), note: `${delta(done.length, donePrev.length, `in ${year - 1}`)}<br>${nf(people(done))} participants`,
          detail: { title: `Events & activations · ${h(periodName)}`, html: mini(["Month", "Activation", "Type", "Participants", "Partners"], [...done].sort((a, b) => String(b.event_date || b.month).localeCompare(String(a.event_date || a.month))).map((a) => [a.event_date ? fmtDate(a.event_date) : monLabel(String(a.month).slice(0, 7), true),
            `${h(a.title)}${isBig(a) ? ' <span class="muted">(counted separately)</span>' : ""}`, h(a.category), a.participants != null ? nf(a.participants) : "—", h(a.partners.join(", ") || "—")]), { num: [3], scroll: true }) } },
        { label: "Partners", value: nf(partnerStats.size), note: `<span class="delta">${newPartners.length} new in ${year}</span><br>${done.length ? Math.round((withPartner.length / done.length) * 100) : 0}% of activations had a partner`,
          detail: { title: "Partners", html: mini(["Partner", "Activations", "People reached", ""], [...partnerStats.entries()].sort((a, b) => b[1].n - a[1].n || b[1].people - a[1].people).map(([p, x]) => [h(p), nf(x.n), nf(x.people), newPartners.includes(p) ? '<span class="badge good">New</span>' : ""]), { num: [1, 2], scroll: true }) } },
      ], { cls: "tiles ov-tiles" })}

      <section class="card"><h2>Who is in the database</h2><p class="lead">${nf(mix.total)} members. City is the home city given at registration, otherwise where they ride most.</p>
        <div class="mix">
          ${split("City", [["Abu Dhabi", mix.city.auh, "var(--s1)"], ["Dubai", mix.city.dxb, "#e8833a"]])}
          ${split("Gender", [["Women", mix.gender.women, "var(--s3)"], ["Men", mix.gender.men, "var(--s2)"], ["Not recorded", mix.gender.unknown, "var(--line)"]])}
          ${split("Community", [["Emirati", mix.group.emirati, "var(--s1)"], ["Arab", mix.group.arab, "var(--s2)"], ["Expat", mix.group.expat, "var(--s3)"], ["Not recorded", mix.group.unknown, "var(--line)"]])}
        </div></section>

      <div class="grid">
        <section class="card c7"><h2>Is the community growing?</h2><p class="lead">Total members in the database, month by month. Each step up is new people registering.</p>
          ${lineChart(growth, { label: "Members in the database by month" })}
          ${tableToggle("t-growth", ["Month", "Members"], growth.map((g) => [g.label, nf(g.value)]))}</section>
        <section class="card c5"><h2>New members by month</h2><p class="lead">${nf(k.newMembers)} people joined in ${h(periodName)}${prev.newMembers != null ? `, against ${nf(prev.newMembers)} in the same period of ${year - 1}` : ""}.</p>
          ${barChart(newByMonth, { label: "New members by month", color: "var(--s3)", height: 210 })}
          ${tableToggle("t-new", ["Month", "New members"], newByMonth.map((g) => [g.label, nf(g.value)]))}</section>

        <section class="card c7"><h2>What we organised</h2><p class="lead">Events, campaigns, workshops and partner activations each month.</p>
          ${barChart(actsByMonth, { label: "Activations by month", color: "var(--s2)" })}
          <div class="tw" style="margin-top:10px"><table><thead><tr><th>Category</th><th class="n">Activations</th><th class="n">Participants</th><th class="n">Average</th></tr></thead><tbody>
          ${cats.map(([c, v]) => `<tr><td>${h(c)}</td><td class="n">${v.n}</td><td class="n">${nf(v.people)}</td><td class="n">${v.n ? nf(Math.round(v.people / v.n)) : "—"}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No activations recorded for ${year}. <a href="/activations">Add them</a>.</td></tr>`}
          </tbody></table></div></section>
        <section class="card c5"><h2>Who we work with</h2><p class="lead">${nf(withPartner.length)} of ${nf(done.length)} activations were run with at least one partner.${newPartners.length ? ` New in ${year}: ${h(newPartners.slice(0, 6).join(", "))}${newPartners.length > 6 ? "…" : ""}.` : ""}</p>
          ${hbars(topPartners.map(([p, s]) => ({ label: p, value: s.n, note: s.people ? `· ${nf(s.people)} people` : "", tip: `${p}: activations together, reaching ${nf(s.people)} participants` })), { label: "Top partners by number of activations" })}
          <p style="margin:10px 0 0"><a href="/partners">All partners</a></p></section>

        <section class="card c12"><h2>Rides</h2><p class="lead">Ride attendances each month (one person at one ride = one attendance). ${k.rideCoverage !== "live" ? "Months up to mid-August 2026 use the historical headcounts, which include riders who weren't registered." : ""}</p>
          ${barChart(rideBars, { label: "Ride attendances by month", color: "var(--s1)", height: 220, width: 1240 })}
          ${tableToggle("t-rides", ["Month", "Ride attendances"], rideBars.map((g) => [g.label, nf(g.value)]))}</section>

        <section class="card c12"><h2>Highlights and impact</h2><p class="lead">The biggest activations of ${h(periodName)} and what they achieved, in the team's own words.</p>
          <div class="hl-grid">${highlights.map((a) => `<article class="hl"><div class="hl-top"><span class="badge">${h(a.category)}</span><span class="muted">${a.event_date ? fmtDate(a.event_date) : monLabel(String(a.month).slice(0, 7), true)}</span></div>
            <h3><a href="/activations/${a.id}">${h(a.title)}</a></h3><p class="hl-n"><b>${nf(a.participants)}</b> participants${a.partners.length ? ` · with ${h(a.partners.join(", "))}` : ""}</p>
            <p class="hl-t">${h(a.impact.length > 260 ? a.impact.slice(0, 260) + "…" : a.impact)}</p></article>`).join("") || `<p class="muted">No impact notes recorded yet.</p>`}</div></section>
      </div>
      <p class="muted" style="font-size:13px">How these figures are counted: a member is one unique person (duplicates merged). Active riders follow the rule agreed in October 2026. Ride attendances count each person once per ride per day. Large public events (${h(bigNames)}) are shown separately so they don't hide the everyday trend. <a href="/dashboard">Open the detailed dashboard</a>.</p>`,
    { active: "/overview", scripts: `<script src="/tips.js"></script>` }));
  }));
};
