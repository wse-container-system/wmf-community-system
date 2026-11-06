"use strict";
/**
 * Marketing log: posts, stories, emails and campaigns for WMF events, with their reach and engagement,
 * shown next to each event's sign-ups and turnout so the impact is visible.
 * Marketing fills it in through their own link (no sign-in); the team can do the same from Reports.
 */
const crypto = require("crypto");
const { pool, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { h, fmtDate, monLabel, nf, detailTiles, mini } = require("./views");

const CHANNELS = ["Instagram", "WhatsApp", "Strava", "TikTok", "Facebook", "LinkedIn", "Email", "Website", "Press / media", "Paid ad", "Other"];
const KINDS = ["Post", "Story", "Reel / video", "Message / broadcast", "Email", "Ad", "Article", "Other"];
const int = (v) => { const s = String(v == null ? "" : v).replace(/[,\s]/g, ""); return /^\d{1,9}$/.test(s) ? +s : null; };

/** Events and activations marketing can link a post to: held in the last 18 months or coming up. */
async function targets() {
  const since = E.helpers.addMonths(R.todayLocal().slice(0, 7), -18) + "-01";
  const acts = (await pool.query(`SELECT id, title, coalesce(event_date, month)::text AS d, activity_id FROM activations WHERE coalesce(event_date, month) >= $1 ORDER BY coalesce(event_date, month) DESC`, [since])).rows;
  const evs = (await pool.query(`SELECT activity_id, name, event_date::text AS d FROM activities a WHERE kind = 'event' AND event_date >= $1
    AND NOT EXISTS (SELECT 1 FROM activations x WHERE x.activity_id = a.activity_id) ORDER BY event_date DESC`, [since])).rows;
  return [...evs.map((e) => ({ v: "e:" + e.activity_id, label: `${e.name} · ${fmtDate(e.d)}`, d: e.d })), ...acts.map((a) => ({ v: "a:" + a.id, label: `${a.title} · ${fmtDate(a.d)}`, d: a.d }))]
    .sort((a, b) => b.d.localeCompare(a.d));
}

/** Every logged action in a period (by the event's date, or the posting date when not linked), grouped by event, with the event's results. */
async function loadInputs({ start, end }) {
  const rows = (await pool.query(`SELECT m.*, m.posted_on::text AS posted,
      coalesce(a.id, a2.id) AS act_id, coalesce(a.title, a2.title, ev.name) AS ev_title, coalesce(a.event_date, a.month, a2.event_date, a2.month, ev.event_date)::text AS ev_date,
      coalesce(a.participants, a2.participants) AS participants, coalesce(a.registrants, a2.registrants) AS registrants, coalesce(a.new_contacts, a2.new_contacts) AS new_contacts,
      coalesce(a.location, a2.location, ev.location) AS location,
      (SELECT count(*)::int FROM participation p WHERE p.activity_id = m.activity_id AND p.voided_at IS NULL AND p.record_type = 'Event Registration') AS ev_regs
    FROM marketing_actions m
    LEFT JOIN activations a ON a.id = m.activation_id
    LEFT JOIN activations a2 ON m.activation_id IS NULL AND a2.activity_id = m.activity_id AND m.activity_id IS NOT NULL
    LEFT JOIN activities ev ON ev.activity_id = m.activity_id
    ORDER BY m.posted_on DESC, m.id DESC`)).rows
    .map((r) => ({ ...r, when: (r.ev_date || r.posted || "").slice(0, 10) }))
    .filter((r) => r.when >= start && r.when <= end);
  const groups = new Map();
  for (const r of rows) {
    const key = r.act_id ? "a" + r.act_id : r.activity_id ? "e" + r.activity_id : "general";
    const g = groups.get(key) || { key, title: r.ev_title || "General / brand", date: r.ev_title ? r.when : null, city: /dubai|dxb/i.test(r.location || "") ? "Dubai" : r.ev_title ? "Abu Dhabi" : "",
      participants: r.participants, registrants: r.registrants ?? (r.ev_regs || null), new_contacts: r.new_contacts, actions: [], reach: 0, eng: 0, clicks: 0, signups: 0, channels: new Set() };
    g.actions.push(r); g.reach += r.reach || 0; g.eng += r.engagements || 0; g.clicks += r.clicks || 0; g.signups += r.signups || 0; g.channels.add(r.channel);
    groups.set(key, g);
  }
  const byEvent = [...groups.values()].sort((a, b) => (a.key === "general") - (b.key === "general") || String(b.date).localeCompare(String(a.date)));
  const sum = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const ev = byEvent.filter((g) => g.key !== "general");
  return { rows, byEvent, totals: { actions: rows.length, reach: sum("reach"), eng: sum("engagements"), clicks: sum("clicks"), signups: sum("signups"),
    events: ev.length, attended: ev.reduce((s, g) => s + (g.participants || 0), 0), registered: ev.reduce((s, g) => s + (g.registrants || 0), 0) } };
}

/** One line per event for the management report ("Social media campaigns"). */
const campaignLines = (mk) => mk.byEvent.filter((g) => g.key !== "general").slice(0, 3).map((g) =>
  `${g.title}: ${g.actions.length} post${g.actions.length === 1 ? "" : "s"} (${[...g.channels].join(", ")})${g.reach ? `, ${nf(g.reach)} reach` : ""}${g.eng ? `, ${nf(g.eng)} engagements` : ""}${g.participants != null ? ` → ${nf(g.participants)} attended` : g.registrants ? ` → ${nf(g.registrants)} registered` : ""}.`);

/** The results: totals, then each event's funnel from reach to attendance. */
function impactHtml(mk, { compact = false } = {}) {
  const t = mk.totals, ev = mk.byEvent.filter((g) => g.key !== "general");
  if (!mk.rows.length) return '<p class="muted">No marketing logged for this period yet.</p>';
  const maxR = Math.max(1, ...ev.map((g) => g.reach)), maxE = Math.max(1, ...ev.map((g) => g.eng)), maxA = Math.max(1, ...ev.map((g) => g.participants || g.registrants || 0));
  const bar = (v, max, color, label) => `<div class="mi-bar"><span class="mi-l">${label}</span><span class="mi-t"><i style="width:${v ? Math.max(2, (v / max) * 100) : 0}%;background:${color}"></i></span><b>${v ? nf(v) : "—"}</b></div>`;
  const cards = ev.map((g) => {
    const rate = g.reach && g.eng ? ((g.eng / g.reach) * 100).toFixed(1) + "%" : null;
    const turnout = g.registrants && g.participants != null ? Math.round((g.participants / g.registrants) * 100) + "%" : null;
    return `<article class="mi-card"><div class="mi-h"><b>${h(g.title)}</b><span class="muted">${g.date ? fmtDate(g.date) : ""}${g.city ? " · " + h(g.city) : ""}</span></div>
      <p class="mi-ch">${g.actions.length} post${g.actions.length === 1 ? "" : "s"} · ${h([...g.channels].join(", "))}</p>
      ${bar(g.reach, maxR, "#9b7be0", "Reach")}${bar(g.eng, maxE, "#e86a8a", "Engagements")}${bar(g.registrants || 0, maxA, "#7fb3ef", "Registered")}${bar(g.participants || 0, maxA, "#5b7cf0", "Attended")}
      <p class="mi-k">${[rate ? `Engagement rate <b>${rate}</b>` : "", turnout ? `Turnout <b>${turnout}</b>` : "", g.new_contacts ? `<b>${nf(g.new_contacts)}</b> new contacts` : "", g.signups ? `<b>${nf(g.signups)}</b> sign-ups from posts` : ""].filter(Boolean).join(" · ") || "&nbsp;"}</p></article>`;
  }).join("");
  const general = mk.byEvent.find((g) => g.key === "general");
  return `<div class="mi-tot"><div><b>${nf(t.actions)}</b><span>posts &amp; campaigns</span></div><div><b>${nf(t.reach)}</b><span>reach</span></div><div><b>${nf(t.eng)}</b><span>engagements</span></div>
      <div><b>${t.reach ? ((t.eng / t.reach) * 100).toFixed(1) + "%" : "—"}</b><span>engagement rate</span></div><div><b>${nf(t.attended)}</b><span>attended the promoted events</span></div></div>
    ${ev.length ? `<div class="mi-cards">${compact ? cards : cards}</div>` : ""}
    ${general ? `<p class="hint" style="margin-top:10px">General / brand posts (not tied to an event): ${general.actions.length} ${general.actions.length === 1 ? "post" : "posts"} · ${nf(general.reach)} reach · ${nf(general.eng)} engagements.</p>` : ""}`;
}

module.exports = function marketingInputs(app, { need, page, setFlash, actor, user, wrap, limit }) {
  const STAFF = need("admin", "coordinator");
  const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
  const { periodOf } = require("./report");

  function body(req, { base, per, mk, tg, editing, links }) {
    const opt = (v, l, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? "selected" : ""}>${h(l)}</option>`;
    const e = editing || {};
    const curT = e.activation_id ? "a:" + e.activation_id : e.activity_id ? "e:" + e.activity_id : "";
    const qs = (o) => new URLSearchParams({ period: per.type, p: per.p, ...o }).toString();
    const nav = `<span class="seg">${Object.keys(KIND).map((t) => `<a href="${base}?period=${t}" class="${per.type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>`;
    return `<section class="mk-head"><div><div class="wc-eyebrow">WMN Moving FWD · marketing log</div><h2 class="ov-title">${h(per.label)}</h2>
        <p class="lead" style="margin:4px 0 0">Log each post or campaign for a WMF event. Its reach and engagement show next to how many people signed up and came.</p></div>
        <div class="mk-actions">${nav}</div></section>
      <div class="grid">
        <section class="card c5" id="log"><h2>${editing ? "Edit" : "Add"} a post or campaign</h2>
          <form class="form" method="post" action="${base}${editing ? `?edit=${e.id}` : ""}">
            <label>Event<select name="target"><option value="">General / brand (no event)</option>${tg.map((t) => opt(t.v, t.label, curT)).join("")}</select></label>
            <div class="row2"><label>Channel<select name="channel">${CHANNELS.map((c) => opt(c, c, e.channel || "Instagram")).join("")}</select></label>
              <label>Type<select name="kind">${KINDS.map((c) => opt(c, c, e.kind || "Post")).join("")}</select></label></div>
            <div class="row2"><label>Date posted<input type="date" name="posted_on" value="${h(e.posted || R.todayLocal())}" max="${R.todayLocal()}" required></label>
              <label>Link <span class="hint">(optional)</span><input type="url" name="url" maxlength="400" value="${h(e.url || "")}" placeholder="https://"></label></div>
            <label>What was it? <span class="hint">(optional)</span><input name="title" maxlength="120" value="${h(e.title || "")}" placeholder="e.g. Teaser reel, route reveal, reminder story"></label>
            <div class="row2"><label>Reach / views<input name="reach" inputmode="numeric" value="${e.reach ?? ""}" placeholder="e.g. 4,200"></label><label>Engagements <span class="hint">(likes, comments, shares, saves)</span><input name="engagements" inputmode="numeric" value="${e.engagements ?? ""}"></label></div>
            <div class="row2"><label>Link clicks <span class="hint">(optional)</span><input name="clicks" inputmode="numeric" value="${e.clicks ?? ""}"></label><label>Sign-ups from it <span class="hint">(optional)</span><input name="signups" inputmode="numeric" value="${e.signups ?? ""}"></label></div>
            <label>Notes <span class="hint">(optional)</span><input name="notes" maxlength="300" value="${h(e.notes || "")}"></label>
            <div class="toolbar" style="margin:0"><button class="btn primary">${editing ? "Save" : "Add"}</button>${editing ? `<a class="btn ghost" href="${base}?${qs({})}">Cancel</a>` : ""}</div>
            <p class="hint" style="margin:0">Update the numbers any time: reach keeps growing for a few days after posting.</p></form></section>
        <section class="card c7"><h2>Impact</h2><p class="lead">Each event: what was posted, how far it reached, and how many people signed up and came.</p>${impactHtml(mk)}</section>
        <section class="card c12"><h2>Everything logged · ${h(per.label)}</h2>${mini(["Posted", "Event", "Channel", "Type", "Reach", "Engagements", "Clicks", ""], mk.rows.map((r) => [fmtDate(r.posted), h(r.ev_title || "General / brand"), h(r.channel), h(r.kind + (r.title ? " · " + r.title : "")) + (r.url && /^https:\/\//.test(r.url) ? ` <a href="${h(r.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ""),
          nf(r.reach), nf(r.engagements), nf(r.clicks), `<a class="btn tblbtn" href="${base}?${qs({ edit: r.id })}#log">Edit</a> <form method="post" action="${base}?${qs({ remove: r.id })}" style="display:inline;margin:0"><button class="btn tblbtn" data-confirm="Remove this entry?">Remove</button></form>`]), { num: [4, 5, 6], empty: "Nothing logged yet. Add the first post on the left." })}</section>
        ${links || ""}
      </div>`;
  }
  async function save(req, by, linkId) {
    const b = req.body || {}, t = String(b.target || "");
    const row = { activation_id: /^a:\d+$/.test(t) ? +t.slice(2) : null, activity_id: /^e:/.test(t) ? t.slice(2).slice(0, 80) : null,
      channel: CHANNELS.includes(b.channel) ? b.channel : "Other", kind: KINDS.includes(b.kind) ? b.kind : "Post",
      posted_on: /^\d{4}-\d{2}-\d{2}$/.test(b.posted_on || "") && b.posted_on <= R.todayLocal() ? b.posted_on : R.todayLocal(),
      title: R.clean(b.title).slice(0, 120) || null, url: /^https:\/\//i.test(String(b.url || "")) ? String(b.url).trim().slice(0, 400) : null,
      reach: int(b.reach), engagements: int(b.engagements), clicks: int(b.clicks), signups: int(b.signups), notes: R.clean(b.notes).slice(0, 300) || null };
    const id = +req.query.edit || 0;
    if (id) {
      const k = Object.keys(row);
      await pool.query(`UPDATE marketing_actions SET ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...k.map((x) => row[x])]);
      await audit(pool, by, "marketing.update", "marketing_action", String(id), null, row);
    } else {
      const k = Object.keys(row);
      const r = await pool.query(`INSERT INTO marketing_actions (${k}, link_id, entered_by) VALUES (${k.map((_, i) => "$" + (i + 1))}, $${k.length + 1}, $${k.length + 2}) RETURNING id`, [...k.map((x) => row[x]), linkId, by]);
      await audit(pool, by, "marketing.create", "marketing_action", String(r.rows[0].id), null, row);
    }
  }
  async function remove(req, by) {
    const r = await pool.query("DELETE FROM marketing_actions WHERE id = $1 RETURNING *", [+req.query.remove || 0]);
    if (r.rows[0]) await audit(pool, by, "marketing.delete", "marketing_action", String(r.rows[0].id), r.rows[0], null);
  }
  const editRow = async (id) => (id ? (await pool.query("SELECT *, posted_on::text AS posted FROM marketing_actions WHERE id = $1", [+id])).rows[0] : null);

  // ----- the team: Reports → Marketing log
  app.get("/report/marketing/log", STAFF, wrap(async (req, res) => {
    const per = periodOf({ period: req.query.period || "year", p: req.query.p });
    const links = (await pool.query("SELECT * FROM report_links WHERE kind = 'mkinput' ORDER BY active DESC, created_at DESC")).rows;
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
    const share = `<section class="card c12"><h2>Link for marketing</h2><p class="lead">Marketing adds and updates their posts through this link: no sign-in, and they only see this log and its results.</p>
      ${links.map((l) => { const url = `${base}/mk/${l.token}`; return `<div class="lr-link ${l.active ? "" : "off"}"><div><b>${h(l.label)}</b> ${l.active ? '<span class="badge good">On</span>' : '<span class="badge">Off</span>'}
        ${l.active ? `<div class="toolbar" style="margin:6px 0 0"><button class="btn tblbtn primary" type="button" data-copy="${h(url)}">Copy link</button>
        <a class="btn tblbtn" href="mailto:?subject=${encodeURIComponent("WMF marketing log")}&body=${encodeURIComponent(`Hi ${l.label},\n\nHere is the WMF marketing log. For each post or campaign, choose the event and add the reach and engagement. The page shows the impact next to the event's sign-ups and attendance, and management sees it in their report.\n\n${url}`)}">Email</a>
        <a class="btn tblbtn" href="https://wa.me/?text=${encodeURIComponent(`WMF marketing log: add each post with its reach and engagement, and see the impact on our events: ${url}`)}" target="_blank" rel="noopener">WhatsApp</a></div>` : ""}</div>
        <form method="post" action="/report/marketing/log/links/${l.id}"><button class="btn tblbtn ${l.active ? "danger" : ""}" name="active" value="${l.active ? "0" : "1"}">${l.active ? "Switch off" : "Switch on"}</button></form></div>`; }).join("")}
      <form class="inline-form" method="post" action="/report/marketing/log/links" style="margin-top:10px"><input class="inp" name="label" required maxlength="60" placeholder="Who is it for? e.g. Marketing" style="flex:1 1 200px"><button class="btn ${links.length ? "" : "primary"}">Make a link</button></form></section>`;
    res.send(page(req, "Marketing log", body(req, { base: "/report/marketing/log", per, mk: await loadInputs(per), tg: await targets(), editing: await editRow(req.query.edit), links: share }), { active: "/report/marketing/log" }));
  }));
  app.post("/report/marketing/log", STAFF, wrap(async (req, res) => {
    if (req.query.remove) await remove(req, actor(req)); else await save(req, actor(req), null);
    setFlash(req, "ok", req.query.remove ? "Removed." : "Saved.");
    res.redirect(303, "/report/marketing/log?" + new URLSearchParams({ period: req.query.period || "year", ...(req.query.p ? { p: req.query.p } : {}) }));
  }));
  app.post("/report/marketing/log/links", STAFF, wrap(async (req, res) => {
    const label = R.clean(req.body.label).slice(0, 60);
    if (label) await pool.query("INSERT INTO report_links (token, label, kind, created_by) VALUES ($1,$2,'mkinput',$3)", [crypto.randomBytes(12).toString("base64url"), label, actor(req)]);
    res.redirect("/report/marketing/log");
  }));
  app.post("/report/marketing/log/links/:id", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE report_links SET active = $2 WHERE id = $1 AND kind = 'mkinput'", [+req.params.id || 0, req.body.active === "1"]);
    res.redirect("/report/marketing/log");
  }));

  // ----- marketing's own link (no sign-in)
  const linkOf = async (t) => (await pool.query("SELECT * FROM report_links WHERE token = $1 AND active AND kind = 'mkinput'", [String(t || "").slice(0, 60)])).rows[0];
  const closed = (req, res) => res.status(404).send(page(req, "Marketing log", `<section class="card"><h2>This link is switched off</h2><p class="lead">Please ask the WMF team for a new one.</p></section>`, { wide: false }));
  app.get("/mk/:token", limit("mklink", 200, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const per = periodOf({ period: req.query.period || "year", p: req.query.p });
    await pool.query("UPDATE report_links SET last_used = now() WHERE id = $1", [l.id]);
    res.set("X-Robots-Tag", "noindex").send(page(req, "Marketing log", body(req, { base: `/mk/${encodeURIComponent(l.token)}`, per, mk: await loadInputs(per), tg: await targets(), editing: await editRow(req.query.edit) }), { active: "/wmf" }));
  }));
  app.post("/mk/:token", limit("mklinkpost", 200, 60 * 60e3), wrap(async (req, res) => {
    const l = await linkOf(req.params.token); if (!l) return closed(req, res);
    const by = "Marketing link: " + l.label;
    if (req.query.remove) await remove(req, by); else await save(req, by, l.id);
    setFlash(req, "ok", req.query.remove ? "Removed." : "Saved. Thank you!");
    res.redirect(303, `/mk/${encodeURIComponent(l.token)}?` + new URLSearchParams({ period: req.query.period || "year", ...(req.query.p ? { p: req.query.p } : {}) }));
  }));
};
module.exports.loadInputs = loadInputs;
module.exports.impactHtml = impactHtml;
module.exports.campaignLines = campaignLines;
