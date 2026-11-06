"use strict";
/**
 * Marketing inputs: posts, stories, emails and campaigns, with their reach and engagement.
 * They sit on the Marketing page next to each event's sign-ups and turnout, so the impact is visible in one place.
 * A post can belong to a WMF event, to another event or activity (not run by WMF), or to the brand in general.
 */
const { pool, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { h, fmtDate, nf, mini } = require("./views");

const CHANNELS = ["Instagram", "WhatsApp", "Strava", "TikTok", "Facebook", "LinkedIn", "Email", "Website", "Press / media", "Paid ad", "Other"];
const KINDS = ["Post", "Story", "Reel / video", "Message / broadcast", "Email", "Ad", "Article", "Other"];
const int = (v) => { const s = String(v == null ? "" : v).replace(/[,\s]/g, ""); return /^\d{1,9}$/.test(s) ? +s : null; };

/** WMF events and activations a post can belong to: the last 18 months and anything coming up. */
async function targets() {
  const since = E.helpers.addMonths(R.todayLocal().slice(0, 7), -18) + "-01";
  const acts = (await pool.query(`SELECT id, title, coalesce(event_date, month)::text AS d, activity_id FROM activations WHERE coalesce(event_date, month) >= $1 ORDER BY coalesce(event_date, month) DESC`, [since])).rows;
  const evs = (await pool.query(`SELECT activity_id, name, event_date::text AS d FROM activities a WHERE kind = 'event' AND event_date >= $1
    AND NOT EXISTS (SELECT 1 FROM activations x WHERE x.activity_id = a.activity_id) ORDER BY event_date DESC`, [since])).rows;
  return [...evs.map((e) => ({ v: "e:" + e.activity_id, label: `${e.name} · ${fmtDate(e.d)}`, d: e.d })), ...acts.map((a) => ({ v: "a:" + a.id, label: `${a.title} · ${fmtDate(a.d)}`, d: a.d }))]
    .sort((a, b) => b.d.localeCompare(a.d));
}

/** Every logged post in a period (by the event's date, or the posting date), grouped by event, with the event's results. */
async function loadInputs({ start, end }) {
  const rows = (await pool.query(`SELECT m.*, m.posted_on::text AS posted, m.other_date::text AS odate,
      coalesce(a.id, a2.id) AS act_id, coalesce(a.title, a2.title, ev.name, m.other_event) AS ev_title,
      coalesce(a.event_date, a.month, a2.event_date, a2.month, ev.event_date, m.other_date)::text AS ev_date,
      coalesce(a.participants, a2.participants, m.other_people) AS participants, coalesce(a.registrants, a2.registrants) AS registrants, coalesce(a.new_contacts, a2.new_contacts) AS new_contacts,
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
    const key = r.act_id ? "a" + r.act_id : r.activity_id ? "e" + r.activity_id : r.other_event ? "o" + r.other_event.toLowerCase() : "general";
    const other = key[0] === "o";
    const g = groups.get(key) || { key, other, act_id: r.act_id, title: r.ev_title || "General / brand", date: r.ev_title ? r.when : null,
      city: other ? "" : /dubai|dxb/i.test(r.location || "") ? "Dubai" : r.ev_title ? "Abu Dhabi" : "",
      participants: r.participants, registrants: r.registrants ?? (r.ev_regs || null), new_contacts: r.new_contacts, actions: [], reach: 0, eng: 0, clicks: 0, signups: 0, channels: new Set() };
    if (other && g.participants == null && r.participants != null) g.participants = r.participants;
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

const rateOf = (g) => (g.reach && g.eng ? ((g.eng / g.reach) * 100).toFixed(1) + "%" : null);
const maxes = (groups) => ({ r: Math.max(1, ...groups.map((g) => g.reach)), e: Math.max(1, ...groups.map((g) => g.eng)), a: Math.max(1, ...groups.map((g) => g.participants || g.registrants || 0)) });

/** Reach → engagements → registered → attended for one event. */
function funnel(g, mx) {
  const bar = (v, max, color, label) => `<div class="mi-bar"><span class="mi-l">${label}</span><span class="mi-t"><i style="width:${v ? Math.max(2, (v / max) * 100) : 0}%;background:${color}"></i></span><b>${v ? nf(v) : "—"}</b></div>`;
  const turnout = g.registrants && g.participants != null ? Math.round((g.participants / g.registrants) * 100) + "%" : null;
  return `<p class="mi-ch">Marketing: ${g.actions.length} post${g.actions.length === 1 ? "" : "s"} · ${h([...g.channels].join(", "))}</p>
    ${bar(g.reach, mx.r, "#9b7be0", "Reach")}${bar(g.eng, mx.e, "#e86a8a", "Engagements")}${g.other ? "" : bar(g.registrants || 0, mx.a, "#7fb3ef", "Registered")}${bar(g.participants || 0, mx.a, "#5b7cf0", g.other ? "People" : "Attended")}
    <p class="mi-k">${[rateOf(g) ? `Engagement rate <b>${rateOf(g)}</b>` : "", turnout ? `Turnout <b>${turnout}</b>` : "", g.new_contacts ? `<b>${nf(g.new_contacts)}</b> new contacts` : "", g.signups ? `<b>${nf(g.signups)}</b> sign-ups from posts` : ""].filter(Boolean).join(" · ") || "&nbsp;"}</p>`;
}

/** Marketing totals in one row. */
function totalsHtml(mk) {
  const t = mk.totals;
  if (!mk.rows.length) return "";
  return `<div class="mi-tot"><div><b>${nf(t.actions)}</b><span>posts &amp; campaigns</span></div><div><b>${nf(t.reach)}</b><span>reach</span></div><div><b>${nf(t.eng)}</b><span>engagements</span></div>
    <div><b>${t.reach ? ((t.eng / t.reach) * 100).toFixed(1) + "%" : "—"}</b><span>engagement rate</span></div><div><b>${nf(t.attended)}</b><span>people at the promoted events</span></div></div>`;
}
const generalLine = (mk) => { const g = mk.byEvent.find((x) => x.key === "general"); return g ? `<p class="hint" style="margin-top:10px">General / brand posts (not for one event): ${g.actions.length} ${g.actions.length === 1 ? "post" : "posts"} · ${nf(g.reach)} reach · ${nf(g.eng)} engagements.</p>` : ""; };

/** The results on their own (management report). */
function impactHtml(mk) {
  if (!mk.rows.length) return '<p class="muted">No marketing logged for this period yet.</p>';
  const ev = mk.byEvent.filter((g) => g.key !== "general"), mx = maxes(ev);
  return `${totalsHtml(mk)}${ev.length ? `<div class="mi-cards">${ev.map((g) => `<article class="mi-card"><div class="mi-h"><b>${h(g.title)}</b><span class="muted">${g.date ? fmtDate(g.date) : ""}${g.city ? " · " + h(g.city) : ""}${g.other ? " · other event" : ""}</span></div>${funnel(g, mx)}</article>`).join("")}</div>` : ""}${generalLine(mk)}`;
}

/** The add / edit form. `base` is where it posts; `pre` preselects an event. */
function formHtml({ base, tg, editing, pre, cancelHref }) {
  const opt = (v, l, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? "selected" : ""}>${h(l)}</option>`;
  const e = editing || {};
  const cur = editing ? (e.activation_id ? "a:" + e.activation_id : e.activity_id ? "e:" + e.activity_id : e.other_event ? "o" : "") : pre || "";
  return `<section class="card c12" id="log"><h2>${editing ? "Edit a post or campaign" : pre && pre !== "o" && tg.find((t) => t.v === pre) ? `Add marketing · ${h(tg.find((t) => t.v === pre).label)}` : "Add marketing"}</h2>
    <p class="lead">One line per post, story, email or campaign. Choose the event it was for; it then shows on that event's card with its reach and turnout.</p>
    <form class="form mk-form" method="post" action="${base}${editing ? `?edit=${e.id}` : ""}">
      <label class="mk-wide">Event<select name="target" data-mk-target><option value="">General / brand (not for one event)</option>${tg.map((t) => opt(t.v, t.label, cur)).join("")}${opt("o", "Other event or activity (not a WMF event)…", cur)}</select></label>
      <div class="mk-other mk-wide" ${cur === "o" ? "" : "hidden"}><label>Event or activity name<input name="other_event" maxlength="120" value="${h(e.other_event || "")}" placeholder="e.g. Abu Dhabi Tour fan zone"></label>
        <label>Date<input type="date" name="other_date" value="${h(e.odate || "")}"></label><label>People there <span class="hint">(optional)</span><input name="other_people" inputmode="numeric" value="${e.other_people ?? ""}"></label></div>
      <label>Channel<select name="channel">${CHANNELS.map((c) => opt(c, c, e.channel || "Instagram")).join("")}</select></label>
      <label>Type<select name="kind">${KINDS.map((c) => opt(c, c, e.kind || "Post")).join("")}</select></label>
      <label>Date posted<input type="date" name="posted_on" value="${h(e.posted || R.todayLocal())}" max="${R.todayLocal()}" required></label>
      <label>What was it? <span class="hint">(optional)</span><input name="title" maxlength="120" value="${h(e.title || "")}" placeholder="e.g. Teaser reel"></label>
      <label>Reach / views<input name="reach" inputmode="numeric" value="${e.reach ?? ""}" placeholder="e.g. 4,200"></label>
      <label>Engagements <span class="hint">(likes, comments, shares)</span><input name="engagements" inputmode="numeric" value="${e.engagements ?? ""}"></label>
      <label>Link clicks <span class="hint">(optional)</span><input name="clicks" inputmode="numeric" value="${e.clicks ?? ""}"></label>
      <label>Sign-ups from it <span class="hint">(optional)</span><input name="signups" inputmode="numeric" value="${e.signups ?? ""}"></label>
      <label class="mk-wide">Link <span class="hint">(optional)</span><input type="url" name="url" maxlength="400" value="${h(e.url || "")}" placeholder="https://"></label>
      <label class="mk-wide">Notes <span class="hint">(optional)</span><input name="notes" maxlength="300" value="${h(e.notes || "")}"></label>
      <div class="toolbar mk-wide" style="margin:0"><button class="btn primary">${editing ? "Save" : "Add"}</button>${editing ? `<a class="btn ghost" href="${h(cancelHref)}">Cancel</a>` : ""}
        <span class="hint">Update the numbers any time: reach keeps growing for a few days.</span></div></form>
    <script src="/mklog.js"></script></section>`;
}

/** Everything logged, with Edit / Remove. */
function logHtml(mk, { base, qs, label }) {
  return `<section class="card c12"><h2>Marketing logged · ${h(label)}</h2>${mini(["Posted", "Event", "Channel", "Type", "Reach", "Engagements", ""], mk.rows.map((r) => [fmtDate(r.posted), h(r.ev_title || "General / brand"), h(r.channel), h(r.kind + (r.title ? " · " + r.title : "")) + (r.url && /^https:\/\//.test(r.url) ? ` <a href="${h(r.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ""),
    nf(r.reach), nf(r.engagements), `<a class="btn tblbtn" href="${base}?${qs({ edit: r.id })}#log">Edit</a> <form method="post" action="${base}?${qs({ remove: r.id })}" style="display:inline;margin:0"><button class="btn tblbtn" data-confirm="Remove this entry?">Remove</button></form>`]), { num: [4, 5], empty: "Nothing logged yet." })}</section>`;
}

async function save(req, by, linkId) {
  const b = req.body || {}, t = String(b.target || "");
  const other = t === "o" ? R.clean(b.other_event).slice(0, 120) : "";
  const row = { activation_id: /^a:\d+$/.test(t) ? +t.slice(2) : null, activity_id: /^e:/.test(t) ? t.slice(2).slice(0, 80) : null,
    other_event: other || null, other_date: other && /^\d{4}-\d{2}-\d{2}$/.test(b.other_date || "") ? b.other_date : null, other_people: other ? int(b.other_people) : null,
    channel: CHANNELS.includes(b.channel) ? b.channel : "Other", kind: KINDS.includes(b.kind) ? b.kind : "Post",
    posted_on: /^\d{4}-\d{2}-\d{2}$/.test(b.posted_on || "") && b.posted_on <= R.todayLocal() ? b.posted_on : R.todayLocal(),
    title: R.clean(b.title).slice(0, 120) || null, url: /^https:\/\//i.test(String(b.url || "")) ? String(b.url).trim().slice(0, 400) : null,
    reach: int(b.reach), engagements: int(b.engagements), clicks: int(b.clicks), signups: int(b.signups), notes: R.clean(b.notes).slice(0, 300) || null };
  const id = +req.query.edit || 0, k = Object.keys(row);
  if (id) {
    await pool.query(`UPDATE marketing_actions SET ${k.map((x, i) => `${x} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...k.map((x) => row[x])]);
    await audit(pool, by, "marketing.update", "marketing_action", String(id), null, row);
  } else {
    const r = await pool.query(`INSERT INTO marketing_actions (${k}, link_id, entered_by) VALUES (${k.map((_, i) => "$" + (i + 1))}, $${k.length + 1}, $${k.length + 2}) RETURNING id`, [...k.map((x) => row[x]), linkId, by]);
    await audit(pool, by, "marketing.create", "marketing_action", String(r.rows[0].id), null, row);
  }
}
async function remove(req, by) {
  const r = await pool.query("DELETE FROM marketing_actions WHERE id = $1 RETURNING *", [+req.query.remove || 0]);
  if (r.rows[0]) await audit(pool, by, "marketing.delete", "marketing_action", String(r.rows[0].id), r.rows[0], null);
}
const editRow = async (id) => (id ? (await pool.query("SELECT *, posted_on::text AS posted, other_date::text AS odate FROM marketing_actions WHERE id = $1", [+id])).rows[0] : null);

/** Old addresses now live on the Marketing page. */
module.exports = function marketingInputs(app) {
  app.get("/report/marketing/log", (req, res) => res.redirect("/report/marketing" + (req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "") + "#log"));
  app.get("/mk/:token", (req, res) => res.redirect(`/m/${encodeURIComponent(req.params.token)}`));
};
Object.assign(module.exports, { loadInputs, impactHtml, campaignLines, funnel, maxes, totalsHtml, generalLine, formHtml, logHtml, save, remove, editRow, targets, rateOf });
