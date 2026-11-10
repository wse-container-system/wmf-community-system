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

// suggestions only: marketing can type any channel, type or metric
const CHANNELS = ["Instagram", "WhatsApp", "Strava", "TikTok", "Facebook", "LinkedIn", "X / Twitter", "YouTube", "Email", "Website", "Press / media", "Paid ad"];
const KINDS = ["Post", "Story", "Reel", "Video", "Campaign", "Carousel", "Live", "Broadcast", "Email", "Ad", "Article"];
const METRICS = ["Saves", "Shares", "Plays", "Link clicks", "Sign-ups", "Comments", "Replies", "Followers gained", "Profile visits", "Impressions", "Watch time (min)"];
/** One colour per channel, the same in every event (unknown channels are grey). */
const CH_COLOR = { instagram: "#2a78d6", whatsapp: "#1baf7a", strava: "#eb6834", tiktok: "#e87ba4", facebook: "#6250d6", linkedin: "#eda100", youtube: "#e34948", email: "#008300" };
const colorOf = (ch) => CH_COLOR[String(ch || "").toLowerCase().split(/[\s/]/)[0]] || "#9a988f";
const cleanName = (v, n) => R.clean(v).slice(0, n);
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
/** Marketing strategy per WMF event, keyed "a:<activation id>" or "e:<activity id>". */
async function loadStrategies() {
  return new Map((await pool.query("SELECT target, strategy FROM marketing_strategies")).rows.map((r) => [r.target, r.strategy]));
}

async function loadInputs({ start, end }) {
  let rows = (await pool.query(`SELECT m.*, m.posted_on::text AS posted, m.other_date::text AS odate,
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
      participants: r.participants, registrants: r.registrants ?? (r.ev_regs || null), new_contacts: r.new_contacts, actions: [], reach: 0, eng: 0, clicks: 0, signups: 0, channels: new Set(),
      byChannel: new Map(), byType: new Map(), metrics: new Map() };
    if (other && g.participants == null && r.participants != null) g.participants = r.participants;
    g.actions.push(r); g.reach += r.reach || 0; g.eng += r.engagements || 0; g.clicks += r.clicks || 0; g.signups += r.signups || 0; g.channels.add(r.channel);
    const c = g.byChannel.get(r.channel) || { reach: 0, eng: 0, n: 0 }; c.reach += r.reach || 0; c.eng += r.engagements || 0; c.n++; g.byChannel.set(r.channel, c);
    const tk = `${r.channel} ${String(r.kind || "").toLowerCase()}`, t = g.byType.get(tk) || { reach: 0, eng: 0 }; t.reach += r.reach || 0; t.eng += r.engagements || 0; g.byType.set(tk, t);
    for (const [m, v] of metricsOf(r)) g.metrics.set(m, (g.metrics.get(m) || 0) + v);
    groups.set(key, g);
  }
  const strat = await loadStrategies();
  for (const g of groups.values()) g.strategy = g.act_id ? strat.get("a:" + g.act_id) || "" : g.key[0] === "e" ? strat.get("e:" + g.key.slice(1)) || "" : "";
  // reports only count WMF events and WMF brand posts; other events stay on marketing's log
  const all = [...groups.values()].sort((a, b) => (a.key === "general") - (b.key === "general") || String(b.date).localeCompare(String(a.date)));
  const byEvent = all.filter((g) => !g.other), others = all.filter((g) => g.other);
  const allRows = rows;
  rows = rows.filter((r) => !(r.other_event && !r.act_id && !r.activity_id));
  const sum = (f) => rows.reduce((s, r) => s + (r[f] || 0), 0);
  const ev = byEvent.filter((g) => g.key !== "general");
  return { rows, allRows, byEvent, others, strategies: strat, totals: { actions: rows.length, reach: sum("reach"), eng: sum("engagements"), clicks: sum("clicks"), signups: sum("signups"),
    events: ev.length, attended: ev.reduce((s, g) => s + (g.participants || 0), 0), registered: ev.reduce((s, g) => s + (g.registrants || 0), 0) } };
}

/** A post's extra metrics, with link clicks and sign-ups (their own columns) included. */
function metricsOf(r) {
  const out = Object.entries(r.metrics && typeof r.metrics === "object" ? r.metrics : {}).filter(([, v]) => Number.isFinite(+v)).map(([k, v]) => [k, +v]);
  if (r.clicks) out.push(["Link clicks", r.clicks]);
  if (r.signups) out.push(["Sign-ups", r.signups]);
  return out;
}

/** One line per event for the management report ("Social media campaigns"). */
const campaignLines = (mk) => mk.byEvent.filter((g) => g.key !== "general").slice(0, 3).map((g) =>
  `${g.title}: ${g.actions.length} post${g.actions.length === 1 ? "" : "s"} (${[...g.channels].join(", ")})${g.reach ? `, ${nf(g.reach)} reach` : ""}${g.eng ? `, ${nf(g.eng)} engagements` : ""}${g.participants != null ? ` → ${nf(g.participants)} attended` : g.registrants ? ` → ${nf(g.registrants)} registered` : ""}.`);

const rateOf = (g) => (g.reach && g.eng ? ((g.eng / g.reach) * 100).toFixed(1) + "%" : null);
const maxes = (groups) => ({ r: Math.max(1, ...groups.map((g) => g.reach)), e: Math.max(1, ...groups.map((g) => g.eng)), a: Math.max(1, ...groups.map((g) => g.participants || g.registrants || 0)) });

/** Per event: reach and engagements split by channel, then registered and came, extra metrics, and three quick results. */
function funnel(g, mx) {
  const chans = [...g.byChannel.entries()].sort((a, b) => b[1].reach - a[1].reach || b[1].eng - a[1].eng);
  const stacked = (field, total, max, label) => `<div class="mc-bar"><span class="mc-l">${label}</span><span class="mc-t"><span class="mc-fill" style="width:${total ? Math.max(3, (total / max) * 100) : 0}%">${
    chans.filter(([, c]) => c[field]).map(([ch, c]) => `<i style="flex:${c[field]};background:${colorOf(ch)}" title="${h(ch)}: ${nf(c[field])}"></i>`).join("")}</span></span><b>${total ? nf(total) : "—"}</b></div>`;
  const plain = (v, max, color, label) => `<div class="mc-bar"><span class="mc-l">${label}</span><span class="mc-t"><span class="mc-fill" style="width:${v ? Math.max(3, (v / max) * 100) : 0}%"><i style="flex:1;background:${color}"></i></span></span><b>${v ? nf(v) : "—"}</b></div>`;
  const best = [...g.byType.entries()].sort((a, b) => b[1].eng - a[1].eng || b[1].reach - a[1].reach)[0];
  const turnout = g.registrants && g.participants != null ? Math.round((g.participants / g.registrants) * 100) + "%" : null;
  const mets = [...g.metrics.entries()].sort((a, b) => b[1] - a[1]);
  const tiles = [best && (best[1].eng || best[1].reach) ? ["Best channel", h(best[0])] : null, rateOf(g) ? ["Engagement rate", rateOf(g)] : null, turnout ? ["Turnout", turnout] : g.new_contacts ? ["New contacts", nf(g.new_contacts)] : null].filter(Boolean);
  return `<p class="mi-ch">${g.actions.length} post${g.actions.length === 1 ? "" : "s"} on ${chans.length} channel${chans.length === 1 ? "" : "s"}</p>
    <ul class="mc-leg">${chans.map(([ch, c]) => `<li><i style="background:${colorOf(ch)}"></i>${h(ch)} <span class="muted">${c.n}</span></li>`).join("")}</ul>
    ${stacked("reach", g.reach, mx.r, "Reach")}${stacked("eng", g.eng, mx.e, "Engagements")}
    ${g.other ? "" : plain(g.registrants || 0, mx.a, "#9fc0f0", "Registered")}${plain(g.participants || 0, mx.a, "#2f5fb3", g.other ? "People there" : "Came")}
    ${mets.length ? `<div class="mc-mets"><span class="muted">More metrics</span>${mets.map(([m, v]) => `<span class="mc-chip">${h(m)} <b>${nf(v)}</b></span>`).join("")}</div>` : ""}
    ${tiles.length ? `<div class="mc-tiles">${tiles.map(([l, v]) => `<div><span>${l}</span><b>${v}</b></div>`).join("")}</div>` : ""}`;
}

/** Marketing totals in one row. */
function totalsHtml(mk) {
  const t = mk.totals;
  if (!mk.rows.length) return "";
  return `<div class="mi-tot"><div><b>${nf(t.actions)}</b><span>posts &amp; campaigns</span></div><div><b>${nf(t.reach)}</b><span>reach</span></div><div><b>${nf(t.eng)}</b><span>engagements</span></div>
    <div><b>${t.reach ? ((t.eng / t.reach) * 100).toFixed(1) + "%" : "—"}</b><span>engagement rate</span></div><div><b>${nf(t.attended)}</b><span>people at the promoted events</span></div></div>`;
}
const generalLine = (mk) => { const g = mk.byEvent.find((x) => x.key === "general"); return g ? `<p class="hint" style="margin-top:10px">General / brand posts (not for one event): ${g.actions.length} ${g.actions.length === 1 ? "post" : "posts"} · ${nf(g.reach)} reach · ${nf(g.eng)} engagements.</p>` : ""; };

const cutTxt = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…" : s; };
/** The plan behind an event's marketing. */
const strategyHtml = (txt, n = 400) => `<p class="mk-strat"><b>Strategy</b> ${h(cutTxt(txt, n))}</p>`;

/** The results on their own (management report). */
function impactHtml(mk) {
  if (!mk.rows.length) return '<p class="muted">No marketing logged for this period yet.</p>';
  const ev = mk.byEvent.filter((g) => g.key !== "general"), mx = maxes(ev);
  return `${totalsHtml(mk)}${ev.length ? `<div class="mi-cards">${ev.map((g) => `<article class="mi-card"><div class="mi-h"><b>${h(g.title)}</b><span class="muted">${g.date ? fmtDate(g.date) : ""}${g.city ? " · " + h(g.city) : ""}</span></div>${g.strategy ? strategyHtml(g.strategy, 220) : ""}${funnel(g, mx)}</article>`).join("")}</div>` : ""}${generalLine(mk)}`;
}

/** One post row: type, date, reach, engagements, link, and any extra metrics. */
function rowHtml(r = {}, channel = "Instagram") {
  const mets = r.metricsList || [];
  return `<div class="mk-row"><input type="hidden" name="r_channel" value="${h(channel)}"><input type="hidden" name="r_metrics" value="">
    <label>Type<input name="r_kind" list="mk-kinds" maxlength="40" value="${h(r.kind || "Post")}"></label>
    <label>Date<input type="date" name="r_date" value="${h(r.posted || R.todayLocal())}" max="${R.todayLocal()}"></label>
    <label>Reach / views<input name="r_reach" inputmode="numeric" value="${r.reach ?? ""}" placeholder="4,200"></label>
    <label>Engagements<input name="r_eng" inputmode="numeric" value="${r.engagements ?? ""}" placeholder="310"></label>
    <label class="mk-link">Link<input type="url" name="r_url" maxlength="400" value="${h(r.url || "")}" placeholder="https:// (optional)"></label>
    <button type="button" class="btn tblbtn mk-x" data-mk-delrow aria-label="Remove this type">✕</button>
    <div class="mk-mets"><span class="hint">More metrics</span>${mets.map(([m, v]) => metHtml(m, v)).join("")}<button type="button" class="btn tblbtn" data-mk-addmet>+ Add a metric</button></div></div>`;
}
const metHtml = (m = "", v = "") => `<span class="mk-met"><input class="mk-mn" list="mk-metrics" maxlength="40" value="${h(m)}" placeholder="Saves" aria-label="Metric"><input class="mk-mv" inputmode="numeric" value="${h(v)}" placeholder="45" aria-label="Number"><button type="button" class="mk-x2" data-mk-delmet aria-label="Remove metric">✕</button></span>`;
/** One channel with its rows. */
const channelHtml = (ch = "Instagram", rows = [{}]) => `<fieldset class="mk-ch"><div class="mk-ch-h"><label>Channel<input class="mk-chname" list="mk-channels" maxlength="40" value="${h(ch)}" required></label>
    <button type="button" class="btn tblbtn" data-mk-delch>Remove channel</button></div>
  <div class="mk-rows">${rows.map((r) => rowHtml(r, ch)).join("")}</div>
  <button type="button" class="btn tblbtn" data-mk-addrow>+ Add another type</button></fieldset>`;

/** The add / edit form: the event, its strategy, then posts grouped by channel. `base` is where it posts; `pre` preselects an event. */
function formHtml({ base, tg, editing, pre, cancelHref, strategies }) {
  const opt = (v, l, cur) => `<option value="${h(v)}" ${String(cur) === String(v) ? "selected" : ""}>${h(l)}</option>`;
  const e = editing || {};
  const cur = editing ? (e.activation_id ? "a:" + e.activation_id : e.activity_id ? "e:" + e.activity_id : e.other_event ? "o" : "") : pre || "";
  const blocks = editing ? channelHtml(e.channel, [{ ...e, metricsList: metricsOf(e) }]) : channelHtml("Instagram", [{}]);
  return `<section class="card c12" id="log"><h2>${editing ? "Edit a post" : pre && pre !== "o" && tg.find((t) => t.v === pre) ? `Add marketing · ${h(tg.find((t) => t.v === pre).label)}` : "Add marketing"}</h2>
    <p class="lead">Choose the event and its strategy, then add each channel and every type you posted there (reel, story, campaign…), with the date, reach, engagements and any other metrics.</p>
    <form class="form mk-form" method="post" action="${base}${editing ? `?edit=${e.id}` : ""}" data-mk-form>
      <label class="mk-wide">Event<select name="target" data-mk-target><option value="">General / brand (not for one event)</option>${tg.map((t) => `<option value="${h(t.v)}" ${t.v === cur ? "selected" : ""} data-s="${h((strategies && strategies.get(t.v)) || "")}">${h(t.label)}</option>`).join("")}${opt("o", "Other event or activity (not a WMF event)…", cur)}</select></label>
      <div class="mk-other mk-wide" ${cur === "o" ? "" : "hidden"}><label>Event or activity name<input name="other_event" maxlength="120" value="${h(e.other_event || "")}" placeholder="e.g. Abu Dhabi Tour fan zone"></label>
        <label>Date<input type="date" name="other_date" value="${h(e.odate || "")}"></label><label>People there <span class="hint">(optional)</span><input name="other_people" inputmode="numeric" value="${e.other_people ?? ""}"></label></div>
      <label class="mk-wide mk-strat-f" ${cur === "" || cur === "o" ? "hidden" : ""}>Marketing strategy for this event <span class="hint">(aim, audience, key messages, timing; leave the posts empty to save only this)</span>
        <textarea name="strategy" rows="3" maxlength="1200" placeholder="e.g. Build up over 2 weeks: route teaser, partner reveal, reminder stories; aim at new riders in Abu Dhabi">${h(strategies && cur ? strategies.get(cur) || "" : "")}</textarea></label>
      <div class="mk-chs mk-wide" data-mk-chs>${blocks}</div>
      <div class="toolbar mk-wide" style="margin:0">${editing ? "" : '<button type="button" class="btn" data-mk-addch>+ Add a channel</button>'}<button class="btn primary">${editing ? "Save" : "Save all"}</button>${editing ? `<a class="btn ghost" href="${h(cancelHref)}">Cancel</a>` : ""}
        <span class="hint">Update the numbers any time: reach keeps growing for a few days.</span></div>
      <template data-mk-tpl="ch">${channelHtml("", [{}])}</template><template data-mk-tpl="row">${rowHtml({}, "")}</template><template data-mk-tpl="met">${metHtml()}</template>
      <datalist id="mk-channels">${CHANNELS.map((c) => `<option value="${h(c)}">`).join("")}</datalist><datalist id="mk-kinds">${KINDS.map((c) => `<option value="${h(c)}">`).join("")}</datalist><datalist id="mk-metrics">${METRICS.map((c) => `<option value="${h(c)}">`).join("")}</datalist>
    </form>
    <script src="/mklog.js"></script></section>`;
}

/** Everything logged, with Edit / Remove. */
function logHtml(mk, { base, qs, label, view }) {
  view = view || base;
  return `<section class="card c12"><h2>Marketing logged · ${h(label)}</h2>${mini(["Posted", "Event", "Channel", "Type", "Reach", "Engagements", "More metrics", ""], (mk.allRows || mk.rows).map((r) => [fmtDate(r.posted), h(r.ev_title || "General / brand") + (r.other_event && !r.act_id && !r.activity_id ? ' <span class="muted">· other event</span>' : ""), h(r.channel), h(r.kind + (r.title ? " · " + r.title : "")) + (r.url && /^https:\/\//.test(r.url) ? ` <a href="${h(r.url)}" target="_blank" rel="noopener noreferrer">↗</a>` : ""),
    nf(r.reach), nf(r.engagements), h(metricsOf(r).map(([m, v]) => `${m} ${nf(v)}`).join(" · ") || "—"), `<a class="btn tblbtn" href="${view}?${qs({ edit: r.id })}#log">Edit</a> <form method="post" action="${base}?${qs({ remove: r.id })}" style="display:inline;margin:0"><button class="btn tblbtn" data-confirm="Remove this entry?">Remove</button></form>`]), { num: [4, 5], empty: "Nothing logged yet." })}</section>`;
}

async function save(req, by, linkId) {
  const b = req.body || {}, t = String(b.target || "");
  if (b.strategy != null && /^(a:\d+|e:.+)$/.test(t)) {
    const txt = R.clean(String(b.strategy)).slice(0, 1200), key = t.slice(0, 90);
    if (txt) await pool.query(`INSERT INTO marketing_strategies (target, strategy, updated_by) VALUES ($1,$2,$3)
      ON CONFLICT (target) DO UPDATE SET strategy = EXCLUDED.strategy, updated_by = EXCLUDED.updated_by, updated_at = now()`, [key, txt, by]);
    else await pool.query("DELETE FROM marketing_strategies WHERE target = $1", [key]);
  }
  const other = t === "o" ? R.clean(b.other_event).slice(0, 120) : "";
  const base = { activation_id: /^a:\d+$/.test(t) ? +t.slice(2) : null, activity_id: /^e:/.test(t) ? t.slice(2).slice(0, 80) : null,
    other_event: other || null, other_date: other && /^\d{4}-\d{2}-\d{2}$/.test(b.other_date || "") ? b.other_date : null, other_people: other ? int(b.other_people) : null };
  const rows = postRows(b).map((p) => ({ ...base, ...p }));
  const id = +req.query.edit || 0;
  if (!rows.length && !id) return 0;
  const cols = (row) => Object.keys(row);
  let n = 0;
  for (const [i, row] of rows.entries()) {
    const k = cols(row), vals = k.map((x) => (x === "metrics" ? JSON.stringify(row[x]) : row[x]));
    if (id && i === 0) {
      await pool.query(`UPDATE marketing_actions SET ${k.map((x, j) => `${x} = $${j + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...vals]);
      await audit(pool, by, "marketing.update", "marketing_action", String(id), null, row);
    } else {
      const r = await pool.query(`INSERT INTO marketing_actions (${k}, link_id, entered_by) VALUES (${k.map((_, j) => "$" + (j + 1))}, $${k.length + 1}, $${k.length + 2}) RETURNING id`, [...vals, linkId, by]);
      await audit(pool, by, "marketing.create", "marketing_action", String(r.rows[0].id), null, row);
    }
    n++;
  }
  return n;
}
/** The posts in a form: one per row (channel, type, date, reach, engagements, link, metrics). Older single-post forms still work. */
function postRows(b) {
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const today = R.todayLocal(), day = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") && d <= today ? d : today);
  const parseMetrics = (txt) => {
    const out = {}; let clicks = null, signups = null;
    for (const part of String(txt || "").split("|")) {
      const i = part.lastIndexOf("="); if (i < 1) continue;
      const name = cleanName(part.slice(0, i), 40), v = int(part.slice(i + 1));
      if (!name || v == null) continue;
      if (/^(link )?clicks?$/i.test(name)) clicks = (clicks || 0) + v; else if (/^sign[- ]?ups?$/i.test(name)) signups = (signups || 0) + v; else out[name] = (out[name] || 0) + v;
      if (Object.keys(out).length >= 12) break;
    }
    return { metrics: out, clicks, signups };
  };
  let rows;
  if (b.r_kind != null) {
    const kinds = arr(b.r_kind), chans = arr(b.r_channel), dates = arr(b.r_date), reach = arr(b.r_reach), eng = arr(b.r_eng), urls = arr(b.r_url), mets = arr(b.r_metrics);
    rows = kinds.slice(0, 60).map((k, i) => ({ channel: cleanName(chans[i], 40) || "Other", kind: cleanName(k, 40) || "Post", posted_on: day(dates[i]), reach: int(reach[i]), engagements: int(eng[i]),
      url: /^https:\/\//i.test(String(urls[i] || "")) ? String(urls[i]).trim().slice(0, 400) : null, ...parseMetrics(mets[i]) }));
  } else { // a single post (older form)
    rows = [{ channel: cleanName(b.channel, 40) || "Other", kind: cleanName(b.kind, 40) || "Post", posted_on: day(b.posted_on), reach: int(b.reach), engagements: int(b.engagements),
      url: /^https:\/\//i.test(String(b.url || "")) ? String(b.url).trim().slice(0, 400) : null, metrics: {}, clicks: int(b.clicks), signups: int(b.signups),
      title: R.clean(b.title).slice(0, 120) || null, notes: R.clean(b.notes).slice(0, 300) || null }];
  }
  return rows.filter((r) => r.reach != null || r.engagements != null || r.url || r.clicks != null || r.signups != null || Object.keys(r.metrics).length || r.title || r.notes);
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
Object.assign(module.exports, { metricsOf, colorOf, loadStrategies, strategyHtml, loadInputs, impactHtml, campaignLines, funnel, maxes, totalsHtml, generalLine, formHtml, logHtml, save, remove, editRow, targets, rateOf });
