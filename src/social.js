"use strict";
/** Social growth: WhatsApp community and Strava club sizes per city, entered once a month, with growth month on month. */
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, monLabel, nf } = require("./views");
const { columns } = require("./charts");

const CH = [["whatsapp", "WhatsApp"], ["strava", "Strava"]], CITIES = ["Abu Dhabi", "Dubai"];
const COLORS = { "Abu Dhabi": "var(--s1)", Dubai: "#e8833a" };
const pct = (a, b) => (a != null && b ? ((a - b) / b) * 100 : null);
const fmtPct = (p) => (p == null ? "—" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`);

/** { months: ["2026-09", …], get(month, channel, city) } for every month entered. */
async function loadSocial() {
  const r = (await pool.query("SELECT to_char(month, 'YYYY-MM') AS m, channel, city, members FROM social_counts ORDER BY month")).rows;
  const map = new Map(r.map((x) => [`${x.m}|${x.channel}|${x.city}`, x.members]));
  const months = [...new Set(r.map((x) => x.m))];
  const get = (m, ch, city) => { if (city) return map.get(`${m}|${ch}|${city}`) ?? null; const v = CITIES.map((c) => map.get(`${m}|${ch}|${c}`)); return v.every((x) => x == null) ? null : v.reduce((a, x) => a + (x || 0), 0); };
  return { months, get };
}
/** Growth over a period: last month entered on or before the end vs the month before the period starts (or the first month in it). */
function growthFor(S, start, end) {
  const inP = S.months.filter((m) => m <= end.slice(0, 7));
  if (!inP.length) return null;
  const last = inP[inP.length - 1];
  const before = S.months.filter((m) => m < start.slice(0, 7));
  const base = before.length ? before[before.length - 1] : inP.find((m) => m >= start.slice(0, 7) && m !== last) || null;
  const row = (ch, city) => { const now = S.get(last, ch, city), was = base ? S.get(base, ch, city) : null; return { now, was, diff: now != null && was != null ? now - was : null, pct: pct(now, was) }; };
  const out = { last, base };
  for (const [k] of CH) { out[k] = { total: row(k) }; for (const c of CITIES) out[k][c] = row(k, c); }
  return out;
}

module.exports = function social(app, { need, page, setFlash, actor, wrap }) {
  const STAFF = need("admin", "coordinator");
  app.get("/social", STAFF, wrap(async (req, res) => {
    const S = await loadSocial();
    const thisM = R.todayLocal().slice(0, 7);
    const m = /^\d{4}-\d{2}$/.test(req.query.m || "") ? req.query.m : thisM;
    const val = (ch, c) => { const v = S.get(m, ch, c); return v == null ? "" : v; };
    const rows = [...S.months].reverse();
    const prevOf = (x) => S.months[S.months.indexOf(x) - 1];
    const cell = (x, ch, c) => { const v = S.get(x, ch, c), p = prevOf(x) ? pct(v, S.get(prevOf(x), ch, c)) : null; return `<td class="n">${nf(v)}${p != null ? `<br><span class="${p > 0 ? "up" : p < 0 ? "down" : "muted"}" style="font-size:12px">${fmtPct(p)}</span>` : ""}</td>`; };
    const last12 = S.months.slice(-12);
    const chart = (ch, name) => last12.length ? `<h3 style="margin:6px 0">${name}</h3>${columns({ categories: last12, series: CITIES.map((c) => ({ name: c, color: COLORS[c], values: last12.map((x) => S.get(x, ch, c) || 0) })), label: `${name} members by month`, short: (x) => monLabel(x) })}` : "";
    res.send(page(req, "Social growth", `<div class="grid">
      <section class="card c5"><h2>Enter this month's numbers</h2><p class="lead">Once a month, copy the member counts from the WhatsApp communities and the Strava clubs. Growth is worked out for you and goes into the report.</p>
        <form method="get" class="toolbar" style="margin:0 0 10px"><input class="inp" type="month" name="m" value="${h(m)}" aria-label="Month" style="width:auto"><button class="btn">Show month</button></form>
        <form class="form" method="post" action="/social"><input type="hidden" name="month" value="${h(m)}">
          <p style="margin:0"><b>${h(monLabel(m, true))}</b></p>
          ${CH.map(([k, name]) => `<fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend style="font-weight:600;font-size:14px">${name}</legend>
            <div class="row2">${CITIES.map((c) => `<label>${c}<input type="number" min="0" max="1000000" name="${k}|${c}" value="${val(k, c)}" inputmode="numeric"></label>`).join("")}</div></fieldset>`).join("")}
          <button class="btn primary">Save</button></form>
        <p class="hint" style="margin-top:8px">Saving a month that already has numbers replaces them. Leave a box empty if you don't have that number.</p></section>
      <section class="card c7"><h2>Growth</h2>
        ${S.months.length ? `${chart("whatsapp", "WhatsApp")}${chart("strava", "Strava")}` : `<p class="muted">Nothing entered yet. Start with this month's counts.</p>`}</section>
      <section class="card c12"><h2>Month by month</h2><div class="tw"><table><thead><tr><th>Month</th>${CH.map(([, n]) => CITIES.map((c) => `<th class="n">${n} ${c === "Abu Dhabi" ? "AUH" : "DXB"}</th>`).join("") + `<th class="n">${n} total</th>`).join("")}<th></th></tr></thead><tbody>
        ${rows.map((x) => `<tr><td>${monLabel(x, true)}</td>${CH.map(([k]) => CITIES.map((c) => cell(x, k, c)).join("") + cell(x, k)).join("")}<td><a href="/social?m=${x}">Edit</a></td></tr>`).join("") || `<tr><td colspan="8" class="muted">No months yet.</td></tr>`}
        </tbody></table></div></section></div>`, { active: "/social" }));
  }));
  app.post("/social", STAFF, wrap(async (req, res) => {
    const m = /^\d{4}-\d{2}$/.test(req.body.month || "") ? req.body.month : null;
    if (!m) { setFlash(req, "err", "Choose the month."); return res.redirect("/social"); }
    const vals = [];
    for (const [k] of CH) for (const c of CITIES) {
      const raw = String(req.body[`${k}|${c}`] ?? "").replace(/[^\d]/g, "");
      vals.push([k, c, raw === "" ? null : Math.min(1e6, +raw)]);
    }
    await tx(async (c) => {
      for (const [k, city, v] of vals) {
        if (v == null) await c.query("DELETE FROM social_counts WHERE month = $1::date AND channel = $2 AND city = $3", [m + "-01", k, city]);
        else await c.query(`INSERT INTO social_counts (month, channel, city, members, updated_by) VALUES ($1::date, $2, $3, $4, $5)
          ON CONFLICT (month, channel, city) DO UPDATE SET members = EXCLUDED.members, updated_by = EXCLUDED.updated_by, updated_at = now()`, [m + "-01", k, city, v, actor(req)]);
      }
      await audit(c, actor(req), "social.save", "social", m, null, Object.fromEntries(vals.map(([k, ci, v]) => [`${k} ${ci}`, v])));
    });
    setFlash(req, "ok", `Saved ${monLabel(m, true)}.`);
    res.redirect("/social?m=" + m);
  }));
};
module.exports.loadSocial = loadSocial;
module.exports.growthFor = growthFor;
module.exports.fmtPct = fmtPct;
module.exports.CITIES = CITIES;
