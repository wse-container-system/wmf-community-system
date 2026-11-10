"use strict";
/**
 * Corporate sponsor report: what we delivered for each sponsor, how their staff took part, and how happy they are.
 * For the team (Corporate → Report), for sponsor users (their own company), and through the management link
 * (/g/<token>/corporate). Totals only on the shared view: no names.
 */
const { pool, audit } = require("./db");
const R = require("./rules");
const C = require("./corpdata");
const E = require("./engine");
const { h, nf, fmtDate, monLabel, detailTiles, mini } = require("./views");
const { columns, hbars, spark, lines } = require("./charts");
const { periodOf } = require("./report");

const H = E.helpers;
const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
const CHAMPION = 6; // sessions in the last 90 days
const pct = (a, b) => (b ? Math.round((a / b) * 100) : null);
const change = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
const chg = (a, b) => { const c = change(a, b); return c == null ? (a ? "new" : "") : c === 0 ? "no change" : `${c > 0 ? "▲" : "▼"} ${Math.abs(c)}%`; };

/** Everything the report shows, for the chosen companies and period. */
async function sponsorData(per, codes) {
  const today = R.todayLocal(), upto = per.end < today ? per.end : today;
  const days = Math.round((Date.parse(per.end) - Date.parse(per.start)) / 864e5) + 1;
  const prevEnd = H.addDays(per.start, -1), prevStart = H.addDays(prevEnd, -(days - 1));
  const all = await C.companies(pool, { all: true }), byCode = Object.fromEntries(all.map((c) => [c.code, c]));
  const [st, pr] = await Promise.all([C.stats({ codes, start: per.start, end: per.end }), C.stats({ codes, start: prevStart, end: prevEnd })]);
  // planned sessions come from each company's weekly schedule; recorded sessions count too (some aren't on the schedule)
  const m1 = per.end.slice(0, 7), m0 = st.months[0] ? st.months[0].month : m1;
  const occ = upto >= m0 + "-01" ? await C.occurrences(pool, codes, m0 + "-01", upto < H.monthEnd(m1) ? upto : H.monthEnd(m1)) : [];
  const inR = (d) => d >= per.start && d <= upto;
  const ratings = (await pool.query(`SELECT company, stars, comment, created_at::date::text AS d FROM corp_ratings WHERE company = ANY($1) AND created_at::date BETWEEN $2 AND $3 ORDER BY created_at DESC`,
    [codes, per.start, per.end])).rows;
  const ref = per.end < today ? per.end : today;
  const parts = [...st.participants.values()];
  const recent = (p, n) => p.dates.filter((x) => x <= ref && x > H.addDays(ref, -90)).length >= n;
  const perCo = codes.map((code) => {
    const b = st.byCompany.find((x) => x.code === code) || {}, pb = pr.byCompany.find((x) => x.code === code) || {};
    const held = st.sessions.filter((s) => s.company === code && s.status === "Held").length;
    const cancelled = st.sessions.filter((s) => s.company === code && s.status === "Cancelled").length;
    const planned = Math.max(occ.filter((o) => o.sc.company === code && inR(o.date)).length, held + cancelled);
    const rt = ratings.filter((r) => r.company === code);
    const sat = rt.length ? rt.reduce((a, r) => a + r.stars, 0) / rt.length : null;
    const delivery = planned ? held / planned : null, ch = change(b.attendance || 0, pb.attendance || 0);
    const status = !held ? "Needs attention" : (delivery != null && delivery < 0.7) || (ch != null && ch < -30) ? "Needs attention" : (delivery != null && delivery < 0.9) || (ch != null && ch < -10) || (sat != null && sat < 3.8) ? "Watch" : "On track";
    const why = [];
    if (cancelled) why.push(`${cancelled} session${cancelled === 1 ? "" : "s"} cancelled`);
    if (ch != null && ch < -10) why.push(`participation down ${Math.abs(ch)}%`);
    if (sat != null && sat < 3.8) why.push(`rating ${sat.toFixed(1)}/5`);
    return { code, name: (byCode[code] || {}).name || code, color: (byCode[code] || {}).color || "#5b7cf0", held, planned, cancelled, delivery,
      attendance: b.attendance || 0, prevAttendance: pb.attendance || 0, change: ch, people: b.people || 0, roster: b.roster || 0, avg: held ? (b.attendance || 0) / held : null,
      active: b.active || 0, sat, ratings: rt.length, status, why, newJoiners: 0 };
  });
  for (const p of parts) if (p.first && p.first >= per.start && p.first <= per.end) { const c = perCo.find((x) => x.code === p.company); if (c) c.newJoiners++; }
  const roster = parts.filter((p) => p.status === "Active").length;
  const tried = st.k.people, regulars = st.k.repeat, champions = parts.filter((p) => recent(p, CHAMPION)).length;
  const months = st.months.map((m) => ({ m: m.month, inRange: m.inRange, byCo: m.byCo, attendance: m.attendance, held: m.rides + m.events,
    planned: Math.max(occ.filter((o) => o.date.slice(0, 7) === m.month && o.date <= today).length, m.rides + m.events + m.cancelled) }));
  const sum = (f) => perCo.reduce((a, c) => a + (c[f] || 0), 0);
  const allRt = ratings.length ? ratings.reduce((a, r) => a + r.stars, 0) / ratings.length : null;
  // what's coming: next period's planned sessions and special sessions already on the calendar
  const nextStart = H.addDays(per.end, 1), nextEnd = H.monthEnd(nextStart.slice(0, 7));
  const nextOcc = await C.occurrences(pool, codes, nextStart, nextEnd);
  const special = (await pool.query(`SELECT company, session_date::text AS d, title, kind FROM corp_sessions WHERE company = ANY($1) AND session_date BETWEEN $2 AND $3 AND kind <> $4 AND status <> 'Cancelled' ORDER BY session_date`,
    [codes, nextStart, nextEnd, C.RIDE])).rows;
  const sinceLaunch = (await pool.query(`SELECT count(*)::int AS n FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE s.company = ANY($1) AND s.status <> 'Cancelled' AND s.session_date <= $2`, [codes, per.end])).rows[0].n;
  return { per, codes, byCode, st, pr, perCo, months, ratings, sat: allRt, nextOcc, special, nextLabel: monLabel(nextStart.slice(0, 7), true), sinceLaunch,
    k: { held: sum("held"), planned: sum("planned"), attendance: st.k.attendance, prevAttendance: pr.k.attendance, people: tried, newJoiners: st.k.newJoiners, prevNew: pr.k.newJoiners,
      regularsRate: tried ? regulars / tried : null, regulars, roster, champions, cancelled: sum("cancelled") },
    mix: st.byKind };
}

/** The suggested words: highlights and next month, from the figures. */
function draftWords(S) {
  const hl = [], nx = [];
  const best = [...S.perCo].filter((c) => c.prevAttendance).sort((a, b) => (b.change || 0) - (a.change || 0))[0];
  if (best && best.change > 0) hl.push(`${best.name}: participation up ${best.change}% on the previous ${S.per.type === "month" ? "month" : "period"} (${nf(best.attendance)}).`);
  if (S.k.newJoiners) hl.push(`${nf(S.k.newJoiners)} new staff joined the programme.`);
  if (S.sinceLaunch >= 100) hl.push(`${nf(Math.floor(S.sinceLaunch / 100) * 100)}+ participations since the programme started.`);
  if (S.k.planned && S.k.held / S.k.planned >= 0.95) hl.push(`${pct(S.k.held, S.k.planned)}% of planned sessions delivered.`);
  if (S.sat != null) hl.push(`Staff rated the sessions ${S.sat.toFixed(1)}/5 (${S.ratings.length} ratings).`);
  for (const c of S.perCo.filter((x) => x.status !== "On track")) nx.push(`${c.name}: ${c.why.length ? `follow up on ${c.why.join(", ")}` : "agree a recovery plan with the sponsor"}.`);
  for (const s of S.special.slice(0, 3)) nx.push(`${fmtDate(s.d)}: ${s.title || s.kind} (${(S.byCode[s.company] || {}).name || s.company}).`);
  const plannedNext = S.nextOcc.length;
  if (plannedNext) nx.push(`${nf(plannedNext)} sessions planned for ${S.nextLabel}.`);
  nx.push("Ask each sponsor's HR contact for feedback on the programme.");
  return { highlights: hl.join("\n"), next: nx.join("\n") };
}
async function wordsOf(S) {
  const r = (await pool.query("SELECT mgmt FROM report_notes WHERE period = $1", ["corp|" + S.per.key])).rows[0];
  const d = draftWords(S), saved = (r && r.mgmt) || {};
  const pick = (f) => (saved[f] != null && String(saved[f]).trim() !== "" ? saved[f] : d[f]);
  return { highlights: pick("highlights"), next: pick("next"), saved };
}
const bullets = (t) => { const ls = String(t || "").split("\n").map((x) => x.replace(/^[-•*]\s*/, "").trim()).filter(Boolean); return ls.length ? `<ul class="sr-list">${ls.map((x) => `<li>${h(x)}</li>`).join("")}</ul>` : '<p class="muted">—</p>'; };

/** The report page body. opts: { nav, excelHref, shared, editHtml, rateLinks } */
function reportHtml(S, W, opts = {}) {
  const k = S.k, mo = S.months, multi = S.perCo.length > 1;
  const named = !opts.shared;
  const badge = (s) => `<span class="sr-badge ${s === "On track" ? "ok" : s === "Watch" ? "wa" : "bad"}">${h(s)}</span>`;
  const tiles = [
    { label: "Sessions delivered", value: nf(k.held), note: k.planned ? `${pct(k.held, k.planned)}% of ${nf(k.planned)} planned` : "", spark: mo.map((m) => m.held),
      detail: { title: "Sessions delivered", html: mini(["Sponsor", "Delivered", "Planned", "Cancelled", "Delivery"], S.perCo.map((c) => [h(c.name), nf(c.held), nf(c.planned), nf(c.cancelled), c.delivery != null ? Math.round(c.delivery * 100) + "%" : "—"]), { num: [1, 2, 3, 4] }) } },
    { label: "Participations", value: nf(k.attendance), note: `${chg(k.attendance, k.prevAttendance)} vs before`, spark: mo.map((m) => m.attendance),
      detail: { title: "Participations", html: mini(["Sponsor", "This period", "Before", "Change"], S.perCo.map((c) => [h(c.name), nf(c.attendance), nf(c.prevAttendance), chg(c.attendance, c.prevAttendance) || "—"]), { num: [1, 2, 3] }) } },
    { label: "Staff reached", value: nf(k.people), note: "unique people",
      detail: { title: "Staff reached", html: mini(["Sponsor", "Staff reached", "Enrolled", "Share"], S.perCo.map((c) => [h(c.name), nf(c.people), nf(c.roster), c.roster ? pct(c.people, c.roster) + "%" : "—"]), { num: [1, 2, 3] }) } },
    { label: "Regulars", value: k.regularsRate != null ? Math.round(k.regularsRate * 100) + "%" : "—", note: "came 2+ times",
      detail: { title: "Regulars", html: `<p>${nf(k.regulars)} of ${nf(k.people)} staff came to two or more sessions in this period.</p>` } },
    { label: "New staff joined", value: nf(k.newJoiners), note: `${chg(k.newJoiners, k.prevNew)} vs before`,
      detail: { title: "New staff joined", html: mini(["Sponsor", "New staff"], S.perCo.map((c) => [h(c.name), nf(c.newJoiners)]), { num: [1] }) } },
    { label: "Satisfaction", value: S.sat != null ? S.sat.toFixed(1) + "<small>/5</small>" : "—", note: S.ratings.length ? `from ${nf(S.ratings.length)} ratings` : "no ratings yet",
      detail: { title: "Session ratings", html: S.ratings.length ? `${mini(["Sponsor", "Average", "Ratings"], S.perCo.filter((c) => c.ratings).map((c) => [h(c.name), c.sat.toFixed(1) + "/5", nf(c.ratings)]), { num: [1, 2] })}
        ${S.ratings.filter((r) => r.comment).slice(0, 6).map((r) => `<p class="mk-impact">“${h(r.comment)}” <span class="muted">· ${h((S.byCode[r.company] || {}).name || "")}, ${fmtDate(r.d)}</span></p>`).join("")}` : '<p class="muted">Staff rate a session (1–5 stars) from the rating link after the ride.</p>' } },
  ].map((t) => ({ ...t, note: h(t.note) + (t.spark && t.spark.length > 1 ? spark(t.spark, "#5b7cf0") : "") }));
  const card = (c) => `<article class="sr-card"><div class="sr-ch"><b>${h(c.name)}</b>${badge(c.status)}</div>
      <dl class="sr-dl"><dt>Sessions</dt><dd>${nf(c.held)} / ${nf(c.planned)}</dd><dt>Participations</dt><dd>${nf(c.attendance)} <small class="${(c.change || 0) >= 0 ? "up" : "down"}">${h(chg(c.attendance, c.prevAttendance))}</small></dd>
        <dt>Staff reached</dt><dd>${nf(c.people)}</dd><dt>Avg per session</dt><dd>${c.avg != null ? c.avg.toFixed(1) : "—"}</dd>${c.sat != null ? `<dt>Rating</dt><dd>${c.sat.toFixed(1)}/5</dd>` : ""}</dl>
      <div class="sr-meter"><i style="width:${c.roster ? Math.min(100, pct(c.active, c.roster)) : 0}%;background:${c.status === "On track" ? "#1d9e75" : c.status === "Watch" ? "#ba7517" : "#d03b3b"}"></i></div>
      <p class="hint">${c.roster ? `${pct(c.active, c.roster)}% of enrolled staff active` : "No staff enrolled yet"}${c.why.length ? ` · ${h(c.why.join(" · "))}` : ""}</p></article>`;
  const funnel = [["Enrolled", k.roster, "#b5d4f4"], ["Tried a session", k.people, "#85b7eb"], ["Regulars (2+)", k.regulars, "#378add"], [`Champions (${CHAMPION}+ in 90 days)`, k.champions, "#185fa5"]];
  const fmax = Math.max(1, ...funnel.map((f) => f[1]));
  const short = (m) => monLabel(m);
  return `<section class="mk-head"><div><div class="wc-eyebrow">Corporate cycling programme · sponsor report</div><h2 class="ov-title">${h(S.per.label)}</h2>
      <p class="lead" style="margin:4px 0 0">What we delivered for our sponsors, how their staff took part, and how they rated it.</p></div>
      <div class="mk-actions">${opts.nav || ""}<button class="btn" data-print>Download PDF</button>${opts.excelHref ? `<a class="btn" href="${h(opts.excelHref)}">Excel</a>` : ""}</div></section>
    ${detailTiles(tiles, { cls: "tiles ov-tiles mk-tiles md-tiles" })}
    <div class="grid">
      <section class="card c12"><h2>Sponsor scorecard</h2><p class="hint">What we delivered for each sponsor · On track, Watch or Needs attention (delivery, participation trend and rating)</p>
        <div class="sr-cards">${S.perCo.map(card).join("") || '<p class="muted">No sponsors.</p>'}</div></section>
      <section class="card c6 md-g"><h2>Participation by month</h2><p class="hint">${multi ? "Per sponsor" : "Participations"} · ${mo.length ? `${monLabel(mo[0].m, true)} – ${monLabel(mo[mo.length - 1].m, true)}` : ""}</p>
        ${lines({ categories: mo.map((m) => m.m), short, label: "Participation by month", series: S.perCo.map((c) => ({ name: c.name, color: c.color, values: mo.map((m) => m.byCo[c.code] || 0) })) })}</section>
      <section class="card c6 md-g"><h2>Sessions delivered vs planned</h2><p class="hint">How reliably the programme runs</p>
        ${columns({ categories: mo.map((m) => m.m), short, stacked: false, height: 200, label: "Sessions delivered vs planned", series: [{ name: "Delivered", color: "#2f5fb3", values: mo.map((m) => m.held) }, { name: "Planned", color: "#c6d6f5", values: mo.map((m) => m.planned) }] })}</section>
      <section class="card c6 md-g"><h2>Staff engagement</h2><p class="hint">From enrolled to regulars${multi ? ", all sponsors" : ""}</p>
        <div class="sr-funnel">${funnel.map(([l, v, col]) => `<div class="mc-bar"><span class="mc-l">${h(l)}</span><span class="mc-t"><span class="mc-fill" style="width:${v ? Math.max(3, (v / fmax) * 100) : 0}%"><i style="flex:1;background:${col}"></i></span></span><b>${nf(v)}</b></div>`).join("")}</div></section>
      <section class="card c6 md-g"><h2>Activity mix</h2><p class="hint">Participations by activity</p>
        ${hbars(S.mix.map((x) => ({ name: x.name, value: x.value, color: "#5b7cf0" })), { empty: "No sessions in this period." })}</section>
      <section class="card c6"><h2>Highlights for our sponsors</h2>${bullets(W.highlights)}</section>
      <section class="card c6"><h2>Next month</h2>${bullets(W.next)}</section>
      ${named && S.st.top && S.st.top.length ? `<section class="card c12 noprint"><h2>Most engaged staff <span class="muted" style="font-weight:400;font-size:14px">(team only)</span></h2>
        ${mini(["Name", "Company", "Sessions this period"], S.st.top.slice(0, 8).map((p) => [h(p.full_name), h((S.byCode[p.company] || {}).name || p.company), nf(p.inRange)]), { num: [2] })}</section>` : ""}
      ${opts.editHtml || ""}
    </div>
    <p class="muted" style="font-size:13px">Planned sessions come from each sponsor's weekly schedule. Active staff took part 2+ times in the 90 days to the end of the period.${opts.shared ? " Shared view: totals only, no names." : ""}</p>`;
}

/** A short summary for the overall WMF report. */
async function summary(per) {
  const codes = (await C.companies(pool)).map((c) => c.code);
  if (!codes.length) return null;
  const S = await sponsorData(per, codes);
  return { perCo: S.perCo, k: S.k, sat: S.sat, ratings: S.ratings.length };
}

// ---------------------------------------------------------------- routes
module.exports = function sponsor(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const V = need("admin", "coordinator", "viewer", "sponsor");
  const STAFF = need("admin", "coordinator");
  const qs = (per, extra = {}) => new URLSearchParams({ period: per.type, p: per.p, ...extra }).toString();
  const nav = (per, base, extra = {}) => {
    const today = R.todayLocal(), opts = [];
    if (per.type === "month") for (const m of H.monthsBetween("2025-01", today.slice(0, 7)).reverse()) opts.push([m, monLabel(m, true)]);
    if (per.type === "quarter") for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) opts.push([`${y}-Q${q}`, `Q${q} ${y}`]);
    if (per.type === "year") for (let y = +today.slice(0, 4); y >= 2025; y--) opts.push([String(y), String(y)]);
    const hid = Object.entries(extra).map(([k2, v]) => `<input type="hidden" name="${h(k2)}" value="${h(v)}">`).join("");
    return `<span class="seg">${Object.keys(KIND).map((t) => `<a href="${base}?${new URLSearchParams({ period: t, ...extra })}" class="${per.type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
      <form method="get" action="${base}" style="margin:0">${hid}<input type="hidden" name="period" value="${per.type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="Period">${opts.map(([v, l]) => `<option value="${v}" ${v === per.p ? "selected" : ""}>${h(l)}</option>`).join("")}</select></form>`;
  };

  app.get("/corporate/report", V, wrap(async (req, res) => {
    const u = user(req), list = await C.companiesFor(u);
    if (!list.length) return res.redirect("/corporate");
    const sel = list.find((x) => x.code === req.query.company) || null, codes = sel ? [sel.code] : list.map((x) => x.code);
    const per = periodOf(req.query), S = await sponsorData(per, codes), W = await wordsOf(S);
    const staff = ["admin", "coordinator"].includes(u.role), extra = sel ? { company: sel.code } : {};
    const pick = list.length > 1 ? `<form method="get" class="toolbar noprint" style="margin:0"><input type="hidden" name="period" value="${per.type}"><input type="hidden" name="p" value="${h(per.p)}">
      <label class="f"><span>Sponsor</span><select class="inp" name="company" data-autosubmit><option value="">All sponsors</option>${list.map((c) => `<option value="${h(c.code)}" ${sel && sel.code === c.code ? "selected" : ""}>${h(c.name)}</option>`).join("")}</select></label></form>` : "";
    const base = `${req.protocol}://${req.get("host")}`;
    const edit = staff ? `<section class="card c12 noprint"><h2>For the team</h2>
      <details class="mg-edit" ${req.query.edit ? "open" : ""}><summary><b>Edit the words</b> <span class="muted">(${h(per.label)} · one point per line)</span></summary>
        <form class="form" method="post" action="/corporate/report/words"><input type="hidden" name="period" value="${h(per.key)}"><input type="hidden" name="back" value="/corporate/report?${qs(per, extra)}">
          <div class="mg-fields"><label>Highlights for our sponsors${W.saved.highlights ? "" : ' <span class="badge">Suggested</span>'}<textarea name="highlights" rows="5" maxlength="1500">${h(W.highlights)}</textarea></label>
            <label>Next month${W.saved.next ? "" : ' <span class="badge">Suggested</span>'}<textarea name="next" rows="5" maxlength="1500">${h(W.next)}</textarea></label></div>
          <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn" name="reset" value="1">Back to the suggested text</button></div></form></details>
      <details style="margin-top:10px"><summary><b>Session rating links</b> <span class="muted">(staff rate a session 1–5 stars after the ride; shown as Satisfaction)</span></summary>
        ${list.map((c) => { const url = `${base}/c/${c.checkin_token}/rate`; return `<div class="lr-link"><div><b>${h(c.name)}</b> <span class="muted" style="font-size:13px">${h(url)}</span></div>
          <div class="toolbar" style="margin:0"><button class="btn tblbtn" type="button" data-copy="${h(url)}">Copy link</button><a class="btn tblbtn" href="https://wa.me/?text=${encodeURIComponent(`How was today's ${c.name} session? Rate it here (10 seconds, anonymous): ${url}`)}" target="_blank" rel="noopener">WhatsApp</a></div></div>`; }).join("")}
        <p class="hint" style="margin:8px 0 0">The check-in page also asks people to rate the session.</p></details>
      <p class="hint" style="margin:10px 0 0">Management sees this report from their management link (Corporate programme → Open the full corporate report).</p></section>` : "";
    res.send(page(req, "Sponsor report", `${pick}${reportHtml(S, W, { nav: nav(per, "/corporate/report", extra), excelHref: `/corporate/report.xlsx?${qs(per, extra)}`, editHtml: edit })}`, { active: "/corporate/report" }));
  }));

  app.post("/corporate/report/words", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, key = String(b.period || "");
    if (/^(month|quarter|year):[\dQ-]+$/.test(key)) {
      const v = b.reset ? null : { highlights: String(b.highlights || "").replace(/\r/g, "").trim().slice(0, 1500), next: String(b.next || "").replace(/\r/g, "").trim().slice(0, 1500) };
      await pool.query(`INSERT INTO report_notes (period, mgmt, updated_by) VALUES ($1, $2, $3) ON CONFLICT (period) DO UPDATE SET mgmt = EXCLUDED.mgmt, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        ["corp|" + key, v ? JSON.stringify(v) : null, actor(req)]);
      setFlash(req, "ok", b.reset ? "Back to the suggested text." : "Saved.");
    }
    const back = String(b.back || ""); res.redirect(back.startsWith("/corporate/report?") ? back : "/corporate/report");
  }));

  // ----- management link: the full corporate view, totals only
  const mgmtLink = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'management'", [String(t || "").slice(0, 60)])).rows[0];
  app.get("/g/:token/corporate", limit("reportlink", 150, 60 * 60e3), wrap(async (req, res) => {
    const l = await mgmtLink(req.params.token);
    if (!l) return res.status(404).send(page(req, "Link closed", `<section class="card"><h2>This link isn't active</h2><p class="lead">Ask the Cycling Development team for a new one.</p></section>`, { wide: false }));
    const codes = (await C.companies(pool)).map((c) => c.code), per = periodOf(req.query), S = await sponsorData(per, codes), W = await wordsOf(S);
    const b = `/g/${encodeURIComponent(l.token)}`;
    res.set("X-Robots-Tag", "noindex").send(page(req, "Sponsor report", `<p class="noprint" style="margin:0"><a href="${b}?${qs(per)}">← WMF management report</a></p>
      ${reportHtml(S, W, { nav: nav(per, b + "/corporate"), shared: true })}`, { active: "/wmf" }));
  }));

  // ----- session rating (public, anonymous): 1–5 stars and an optional comment
  const coByToken = async (t) => (await pool.query("SELECT * FROM corp_companies WHERE checkin_token = $1 AND active", [String(t || "")])).rows[0];
  const rateForm = (co, sessions, err) => `<section class="card" style="display:grid;gap:12px"><div class="checkin-hero"><p class="muted" style="margin:0;letter-spacing:.06em;text-transform:uppercase;font-size:12px">Corporate Cycling Programme</p>
      <h2 style="font-size:24px">How was your ${h(co.name)} session?</h2><p class="lead" style="margin:0">Anonymous · takes 10 seconds</p></div>${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <form class="form" method="post">${sessions.length > 1 ? `<label>Session<select name="session">${sessions.map((s) => `<option value="${s.id}">${h(C.sessionName(s, co))} · ${fmtDate(s.d)}</option>`).join("")}</select></label>` : sessions[0] ? `<input type="hidden" name="session" value="${sessions[0].id}"><p style="margin:0"><b>${h(C.sessionName(sessions[0], co))}</b> · ${fmtDate(sessions[0].d)}</p>` : ""}
      <fieldset class="sr-stars"><legend>Your rating</legend>${[5, 4, 3, 2, 1].map((n) => `<input type="radio" id="st${n}" name="stars" value="${n}" required><label for="st${n}" title="${n} star${n > 1 ? "s" : ""}">★</label>`).join("")}</fieldset>
      <label>Anything to tell us? <span class="hint">(optional)</span><textarea name="comment" rows="3" maxlength="400"></textarea></label>
      <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true"><button class="btn primary big">Send</button></form></section>`;
  const recentSessions = async (co) => (await pool.query(`SELECT *, session_date::text AS d FROM corp_sessions WHERE company = $1 AND status = 'Held' AND session_date BETWEEN $2 AND $3 ORDER BY session_date DESC, id DESC LIMIT 5`,
    [co.code, H.addDays(R.todayLocal(), -7), R.todayLocal()])).rows;
  app.get("/c/:token/rate", wrap(async (req, res) => {
    const co = await coByToken(req.params.token);
    if (!co) return res.status(404).send(page(req, "Rating", `<section class="card"><h2>This link isn't active</h2></section>`, { wide: false }));
    res.send(page(req, `Rate your ${co.name} session`, rateForm(co, await recentSessions(co)), { wide: false }));
  }));
  app.post("/c/:token/rate", limit("corprate", 20, 60 * 60e3), wrap(async (req, res) => {
    const co = await coByToken(req.params.token), b = req.body || {};
    if (!co || b.website) return res.redirect(`/c/${encodeURIComponent(req.params.token)}/rate`);
    const stars = +b.stars;
    if (!(stars >= 1 && stars <= 5)) return res.send(page(req, "Rating", rateForm(co, await recentSessions(co), "Choose 1 to 5 stars."), { wide: false }));
    const ss = await recentSessions(co), s = ss.find((x) => String(x.id) === String(b.session)) || ss[0] || null;
    await pool.query("INSERT INTO corp_ratings (company, session_id, stars, comment) VALUES ($1,$2,$3,$4)", [co.code, s ? s.id : null, Math.round(stars), R.clean(b.comment).slice(0, 400) || null]);
    res.send(page(req, "Thank you", `<section class="card checkin-hero" style="padding:28px 16px"><div class="big-tick" aria-hidden="true">✓</div><h2 style="font-size:26px">Thank you!</h2>
      <p class="lead" style="margin:0">Your rating helps us make the ${h(co.name)} sessions better.</p></section>`, { wide: false }));
  }));
};
module.exports.sponsorData = sponsorData;
module.exports.summary = summary;
