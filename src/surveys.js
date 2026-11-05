"use strict";
/**
 * Follow-up surveys after a WMF event. Staff pick an event, get one link, and send it to the people who came
 * (WhatsApp one by one, one email to everyone in BCC, or the community group). Answers are anonymous unless the person adds a name.
 */
const crypto = require("crypto");
const QR = require("qrcode");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const { h, fmtDate } = require("./views");
const { syncHeldEvents } = require("./activations");

const AGAIN = ["Yes", "Maybe", "No"];
const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");
const token = () => crypto.randomBytes(9).toString("base64url");

/** Results of one survey (or all surveys of a period when ids are given). */
async function results(ids) {
  if (!ids.length) return { n: 0, avg: null, dist: [0, 0, 0, 0, 0], again: {}, first: 0, liked: [], improve: [] };
  const r = (await pool.query("SELECT * FROM survey_responses WHERE survey_id = ANY($1) ORDER BY created_at DESC", [ids])).rows;
  const rated = r.filter((x) => x.rating);
  const again = {}; for (const a of AGAIN) again[a] = r.filter((x) => x.again === a).length;
  return {
    n: r.length, avg: rated.length ? rated.reduce((s, x) => s + x.rating, 0) / rated.length : null,
    dist: [1, 2, 3, 4, 5].map((k) => rated.filter((x) => x.rating === k).length), again, first: r.filter((x) => x.first_time === "Yes").length,
    liked: r.filter((x) => x.liked).map((x) => x.liked), improve: r.filter((x) => x.improve).map((x) => x.improve),
  };
}
/** Surveys of activations held between two days, with their combined results (for the report). */
async function periodResults(start, end) {
  const ids = (await pool.query(`SELECT s.id FROM surveys s JOIN activations a ON a.id = s.activation_id
    WHERE coalesce(a.event_date, a.month) BETWEEN $1::date AND $2::date`, [start, end])).rows.map((x) => x.id);
  return { surveys: ids.length, ...(await results(ids)) };
}

module.exports = function surveys(app, { need, page, setFlash, actor, wrap, limit }) {
  const STAFF = need("admin", "coordinator");

  app.get("/surveys", STAFF, wrap(async (req, res) => {
    await syncHeldEvents(actor(req));
    const list = (await pool.query(`SELECT s.*, a.title AS act_title, a.event_date, a.month, count(r.id)::int AS n, round(avg(r.rating), 1) AS avg
      FROM surveys s LEFT JOIN activations a ON a.id = s.activation_id LEFT JOIN survey_responses r ON r.survey_id = s.id GROUP BY s.id, a.id ORDER BY s.created_at DESC`)).rows;
    const acts = (await pool.query(`SELECT a.id, a.title, a.event_date, a.month, a.activity_id, a.participants FROM activations a
      WHERE a.status = 'Completed' AND coalesce(a.event_date, a.month) >= (current_date - 180) AND NOT EXISTS (SELECT 1 FROM surveys s WHERE s.activation_id = a.id)
      ORDER BY coalesce(a.event_date, a.month) DESC LIMIT 80`)).rows;
    const pre = R.clean(req.query.event);
    const when = (a) => (a.event_date ? fmtDate(a.event_date) : fmtDate(String(a.month).slice(0, 10)).replace(/^1 /, ""));
    const seasons = (await pool.query("SELECT s.id, s.title, s.open, s.source, (SELECT count(*)::int FROM season_answers a WHERE a.survey_id = s.id) AS n FROM season_surveys s ORDER BY coalesce(s.opened, s.created_at::date) DESC, s.id DESC LIMIT 3")).rows;
    res.send(page(req, "Surveys", `<section class="card"><div class="card-head"><div><h2>End-of-season surveys</h2>
        <p class="lead">One survey to the whole community at the end of each summer and winter, compared with past seasons.</p></div>
        <div class="toolbar" style="margin:0"><a class="btn" href="/surveys/seasons">Compare seasons</a><a class="btn primary" href="/surveys/seasons/new">New end-of-season survey</a></div></div>
        ${seasons.length ? `<ul class="log">${seasons.map((x) => `<li><a href="/surveys/seasons/${x.id}"><b>${h(x.title)}</b></a><span class="muted">${x.n} answers${x.source === "app" ? (x.open ? " · open" : " · closed") : ""}</span></li>`).join("")}</ul>` : ""}</section>
      <div class="grid">
      <section class="card c5"><h2>After an event</h2><p class="lead">Choose the event. You get one link to send to the people who came. Five quick questions, answered in under a minute.</p>
        ${acts.length ? `<form class="form" method="post" action="/surveys">
          <label>Event<select name="activation_id" required>${acts.map((a) => `<option value="${a.id}" ${pre && a.activity_id === pre ? "selected" : ""}>${h(a.title)} · ${when(a)}</option>`).join("")}</select></label>
          <button class="btn primary">Create the survey link</button></form>` : `<p class="muted">Every event of the last six months already has a survey. Events move to <a href="/activations">Activations</a> once their date has passed.</p>`}
        <p class="hint" style="margin-top:10px">The questions: how was it (1–5), would you join again, was it your first WMF event, what did you enjoy, what could be better.</p></section>
      <section class="card c7"><h2>Surveys</h2>
        <div class="tw"><table><thead><tr><th>Event</th><th class="n">Answers</th><th class="n">Rating</th><th>Status</th></tr></thead><tbody>
        ${list.map((s) => `<tr><td><a href="/surveys/${s.id}"><b>${h(s.act_title || s.title)}</b></a><br><span class="muted">${s.event_date || s.month ? when(s) : ""}</span></td>
          <td class="n">${s.n}</td><td class="n">${s.avg ? s.avg + " / 5" : "—"}</td><td>${s.open ? '<span class="badge good">Open</span>' : '<span class="badge">Closed</span>'}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">No surveys yet.</td></tr>`}
        </tbody></table></div></section></div>`, { active: "/surveys" }));
  }));

  app.post("/surveys", STAFF, wrap(async (req, res) => {
    const a = (await pool.query("SELECT * FROM activations WHERE id = $1", [+req.body.activation_id || 0])).rows[0];
    if (!a) { setFlash(req, "err", "Choose an event."); return res.redirect("/surveys"); }
    const id = await tx(async (c) => {
      const ex = (await c.query("SELECT id FROM surveys WHERE activation_id = $1", [a.id])).rows[0];
      if (ex) return ex.id;
      const sid = (await c.query("INSERT INTO surveys (token, activity_id, activation_id, title, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [token(), a.activity_id, a.id, a.title, actor(req)])).rows[0].id;
      await audit(c, actor(req), "survey.create", "survey", String(sid), null, { activation: a.id, title: a.title });
      return sid;
    });
    res.redirect("/surveys/" + id);
  }));

  app.get("/surveys/:id", STAFF, wrap(async (req, res) => {
    const s = (await pool.query("SELECT s.*, a.event_date, a.month, a.participants FROM surveys s LEFT JOIN activations a ON a.id = s.activation_id WHERE s.id = $1", [+req.params.id || 0])).rows[0];
    if (!s) return res.redirect("/surveys");
    const link = `${baseOf(req)}/f/${s.token}`;
    const qr = await QR.toDataURL(link, { margin: 1, width: 320 });
    const people = s.activity_id ? (await pool.query(`SELECT DISTINCT ON (m.member_id) m.member_id, m.full_name, m.primary_email, m.mobile, p.status
      FROM participation p JOIN members m ON m.member_id = p.member_id WHERE p.activity_id = $1 AND p.voided_at IS NULL ORDER BY m.member_id, (p.status = 'Attended') DESC`, [s.activity_id])).rows : [];
    const came = people.filter((p) => p.status === "Attended");
    const to = came.length ? came : people;
    const msg = (first) => `Hi${first ? " " + first : ""}, thank you for joining ${s.title}! We'd love your feedback, it takes under a minute: ${link}`;
    const emails = [...new Set(to.map((p) => R.normEmail(p.primary_email)).filter((e) => R.EMAIL_RE.test(e)))];
    const subj = `How was ${s.title}?`;
    const r = await results([s.id]);
    const pct = (n) => (r.n ? Math.round((n / r.n) * 100) + "%" : "—");
    const maxD = Math.max(1, ...r.dist);
    res.send(page(req, "Survey", `<div class="grid">
      <section class="card c7"><div class="card-head"><div><h2>${h(s.title)}</h2><p class="lead">Follow-up survey${s.event_date ? " · event on " + fmtDate(s.event_date) : ""} · ${s.open ? "open for answers" : "closed"}</p></div>
          <form method="post" action="/surveys/${s.id}/toggle"><button class="btn">${s.open ? "Close the survey" : "Open again"}</button></form></div>
        <div class="tiles" style="margin:4px 0 14px">
          <div class="tile"><span class="lbl">Answers</span><span class="val">${r.n}</span><span class="note">${to.length ? `from ${to.length} ${came.length ? "who came" : "who signed up"}` : ""}</span></div>
          <div class="tile"><span class="lbl">Average rating</span><span class="val">${r.avg ? r.avg.toFixed(1) : "—"}</span><span class="note">out of 5</span></div>
          <div class="tile"><span class="lbl">Would join again</span><span class="val">${pct(r.again.Yes)}</span><span class="note">${r.again.Maybe ? r.again.Maybe + " maybe" : ""}</span></div>
          <div class="tile"><span class="lbl">First WMF event</span><span class="val">${r.first}</span></div></div>
        ${r.n ? `<div class="hbars" aria-label="Ratings">${[5, 4, 3, 2, 1].map((k) => `<div class="hbar"><span class="hbar-l">${"★".repeat(k)}</span><span class="hbar-t"><span style="width:${(r.dist[k - 1] / maxD) * 100}%;background:var(--s3)"></span></span><span class="hbar-v">${r.dist[k - 1]}</span></div>`).join("")}</div>
          <div class="grid" style="margin-top:12px"><div class="c6"><h3>What they enjoyed</h3><ul class="quotes">${r.liked.slice(0, 12).map((t) => `<li>${h(t)}</li>`).join("") || '<li class="muted">—</li>'}</ul></div>
            <div class="c6"><h3>What could be better</h3><ul class="quotes">${r.improve.slice(0, 12).map((t) => `<li>${h(t)}</li>`).join("") || '<li class="muted">—</li>'}</ul></div></div>` : `<p class="muted">No answers yet. Send the link from the panel on the right.</p>`}
      </section>
      <section class="card c5"><h2>Send it</h2>
        <div class="sc-row"><input class="inp" value="${h(link)}" readonly aria-label="Survey link"><button class="btn" type="button" data-copy="${h(link)}">Copy</button></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0">
          ${emails.length ? `<a class="btn primary" href="mailto:?bcc=${encodeURIComponent(emails.join(","))}&subject=${encodeURIComponent(subj)}&body=${encodeURIComponent(msg(""))}">Email all ${emails.length} (BCC)</a>
            <button class="btn" type="button" data-copy="${h(emails.join(", "))}">Copy emails</button>` : ""}
          <a class="btn" href="https://wa.me/?text=${encodeURIComponent(msg(""))}" target="_blank" rel="noopener">Post in a WhatsApp group</a>
          <a class="btn" href="${qr}" download="survey-QR.png">QR code</a></div>
        ${to.length ? `<details ${to.length <= 25 ? "open" : ""}><summary><b>One by one on WhatsApp (${to.length})</b></summary><ul class="log" style="margin-top:8px">
          ${to.map((p) => { const ph = R.normPhone(p.mobile); return `<li><span>${h(p.full_name)}</span>${ph.length >= 9 ? `<a class="btn tblbtn" href="https://wa.me/${encodeURIComponent(ph)}?text=${encodeURIComponent(msg(String(p.full_name || "").split(" ")[0]))}" target="_blank" rel="noopener">WhatsApp</a>` : '<span class="muted">no mobile</span>'}</li>`; }).join("")}</ul></details>`
          : `<p class="hint">This event has no sign-up list in the app, so send the link to the group or post the QR code.</p>`}
        <p class="hint" style="margin-top:10px">${came.length ? "Sent to the people ticked as came on the sign-up list." : people.length ? "Nobody is ticked as came yet, so everyone who signed up is listed. Tick who came on the sign-up list to narrow it." : ""}</p></section></div>`, { active: "/surveys" }));
  }));

  app.post("/surveys/:id/toggle", STAFF, wrap(async (req, res) => {
    await pool.query("UPDATE surveys SET open = NOT open WHERE id = $1", [+req.params.id || 0]);
    res.redirect("/surveys/" + (+req.params.id || ""));
  }));

  // ---------- public: answering ----------
  const byToken = async (t) => (await pool.query("SELECT * FROM surveys WHERE token = $1", [String(t || "").slice(0, 40)])).rows[0];
  const stars = [1, 2, 3, 4, 5];
  const formHtml = (s, err) => `<section class="card"><h2>How was ${h(s.title)}?</h2><p class="lead">Thank you for joining WMN Moving FWD. Your answers help us plan the next rides and events. Under a minute.</p>
    ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <form class="form" method="post">
      <fieldset class="rate"><legend>Overall, how was it?</legend><div class="rate-row">${stars.map((k) => `<label><input type="radio" name="rating" value="${k}" required><span>${k}</span></label>`).join("")}</div>
        <div class="rate-ends"><span>Not good</span><span>Excellent</span></div></fieldset>
      <fieldset class="rate"><legend>Would you join another WMF ride or event?</legend><div class="rate-row">${AGAIN.map((a) => `<label><input type="radio" name="again" value="${a}" required><span>${a}</span></label>`).join("")}</div></fieldset>
      <fieldset class="rate"><legend>Was this your first WMF event?</legend><div class="rate-row">${["Yes", "No"].map((a) => `<label><input type="radio" name="first_time" value="${a}"><span>${a}</span></label>`).join("")}</div></fieldset>
      <label>What did you enjoy most?<textarea name="liked" rows="3" maxlength="600"></textarea></label>
      <label>What could we do better?<textarea name="improve" rows="3" maxlength="600"></textarea></label>
      <label>Your name <span class="hint">(optional)</span><input name="name" maxlength="80" autocomplete="name"></label>
      <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
      <button class="btn primary big">Send</button></form></section>`;
  app.get("/f/:token", wrap(async (req, res) => {
    const s = await byToken(req.params.token);
    if (!s || !s.open) return res.status(404).send(page(req, "Survey", `<section class="card"><h2>This survey is closed</h2><p class="lead">Thank you. See what's coming up on the <a href="/calendar">WMF calendar</a>.</p></section>`, { wide: false }));
    res.send(page(req, "Survey", formHtml(s), { wide: false }));
  }));
  app.post("/f/:token", limit("survey", 20, 60 * 60e3), wrap(async (req, res) => {
    const s = await byToken(req.params.token), b = req.body || {};
    if (!s || !s.open) return res.redirect("/f/" + encodeURIComponent(req.params.token));
    if (b.website) return res.redirect("/calendar");
    const rating = +b.rating;
    if (!(rating >= 1 && rating <= 5) || !AGAIN.includes(b.again)) return res.send(page(req, "Survey", formHtml(s, "Please choose a rating and whether you'd join again."), { wide: false }));
    const txt = (v) => String(v || "").replace(/\r/g, "").trim().slice(0, 600) || null;
    await pool.query("INSERT INTO survey_responses (survey_id, rating, again, first_time, liked, improve, name) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [s.id, rating, b.again, ["Yes", "No"].includes(b.first_time) ? b.first_time : null, txt(b.liked), txt(b.improve), R.clean(b.name).slice(0, 80) || null]);
    res.send(page(req, "Thank you", `<section class="card" style="display:grid;gap:10px"><h2>Thank you!</h2><p class="lead">Your feedback goes straight to the WMF team.</p>
      <p><a class="btn primary" href="/calendar">See upcoming rides and events</a></p></section>`, { wide: false }));
  }));
};
module.exports.results = results;
module.exports.periodResults = periodResults;
