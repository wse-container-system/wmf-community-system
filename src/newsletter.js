"use strict";
/**
 * Monthly newsletter and event emails. The app writes and designs the email; it is sent from Outlook or Mailchimp.
 * The app never sends email itself. The recipient list contains only members who agreed to updates, and needs a password.
 */
const bcrypt = require("bcryptjs");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { h, fmtDate } = require("./views");

const H = E.helpers;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const monthName = (m) => MONTHS[+m.slice(5, 7) - 1] + " " + m.slice(0, 4);
const nf = (n) => Number(n || 0).toLocaleString("en-GB");
const t12 = (t) => { if (!t) return ""; const [hh, mm] = t.split(":").map(Number); return (hh % 12 || 12) + (mm ? ":" + String(mm).padStart(2, "0") : "") + (hh >= 12 ? " PM" : " AM"); };
const excerpt = (s, n = 280) => { s = String(s || "").replace(/\s+\n/g, "\n").trim(); return s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s; };

/** Draft content for a monthly newsletter: last month's recap and what's coming next month. */
async function draftMonthly(month, base) {
  const recap = H.addMonths(month, -1);
  const { buildData } = require("./snapshot");
  const P = E.prepare(await buildData());
  const k = E.compute(P, { start: recap + "-01", end: H.monthEnd(recap) }, R.todayLocal(), { light: true }).kpis;
  const acts = (await require("./activations").loadActivations("a.status = 'Completed' AND to_char(a.month, 'YYYY-MM') = $1", [recap]));
  const people = acts.reduce((s, a) => s + (a.participants || 0), 0);
  const partners = [...new Set(acts.flatMap((a) => a.partners))];
  // coming up: WMF events and the weekly rides on the calendar next month
  const C = require("../public/calendar-core");
  const items = (await require("./calendar").loadItems()).filter((a) => a.c === "wmf_event" || a.c === "wmf_ride");
  const map = C.build(items, month + "-01", H.monthEnd(month));
  const events = [], rides = new Map();
  for (const [d, list] of Object.entries(map).sort()) for (const o of list) {
    if (o.cancel) continue;
    if (o.a.c === "wmf_event" && o.date === d) events.push({ date: d, ...o.a });
    if (o.a.c === "wmf_ride") {
      if (o.a.r) { const k2 = o.a.t; if (!rides.has(k2)) rides.set(k2, { ...o.a, days: new Set() }); rides.get(k2).days.add(DAYS[C.dow(d)]); }
      else events.push({ date: d, ...o.a });
    }
  }
  const sections = [];
  sections.push({ heading: `${monthName(recap)} in numbers`, body: [
    `${nf(k.rideAttendance)} ride attendances across ${nf(k.rideSessions)} rides`,
    `${nf(k.newMembers)} new members joined the community`,
    acts.length ? `${acts.length} events and activations, with ${nf(people)} participants` : "",
  ].filter(Boolean).map((x) => "• " + x).join("\n") });
  for (const a of acts.filter((x) => x.impact).sort((x, y) => (y.participants || 0) - (x.participants || 0)).slice(0, 3)) {
    sections.push({ heading: a.title, body: excerpt(a.impact), button_text: "", button_url: "" });
  }
  if (events.length) {
    sections.push({ heading: `Coming up in ${MONTHS[+month.slice(5, 7) - 1]}`, body: events.map((e) => `• ${fmtDate(e.date)}${e.st ? ", " + t12(e.st) : ""}: ${e.t}${e.loc ? " (" + e.loc + ")" : ""}${e.fee ? " · " + e.fee : ""}`).join("\n"),
      button_text: events.some((e) => e.signup) ? "Sign up for events" : "", button_url: events.some((e) => e.signup) ? base + "/events" : "" });
  }
  if (rides.size) {
    sections.push({ heading: "Weekly rides", body: [...rides.values()].map((r) => `• ${r.t}: every ${[...r.days].join(" & ")}${r.st ? ", " + t12(r.st) : ""}${r.loc ? " at " + r.loc : ""}`).join("\n"),
      button_text: "See the full calendar", button_url: base + "/calendar" });
  }
  if (partners.length) sections.push({ heading: "Thank you to our partners", body: `A big thank you to ${partners.join(", ")} for riding with us in ${monthName(recap)}.` });
  sections.push({ heading: "New to WMF? Bring a friend", body: "Registration is free and takes a minute. You'll get your personal QR code straight away to check in at rides.", button_text: "Register", button_url: base + "/join" });
  return { title: `WMF ${monthName(month)} newsletter`, intro: `Hello ladies,\n\nHere's what happened in the WMF community in ${monthName(recap)} and what's coming up in ${MONTHS[+month.slice(5, 7) - 1]}.`, sections };
}
async function draftEvent(activityId, base) {
  const e = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [activityId])).rows[0];
  if (!e) return null;
  const fee = Number(e.price_aed) > 0 ? `AED ${Number(e.price_aed).toLocaleString("en-GB")}` : "Free";
  return { title: e.name, intro: `Hello ladies,\n\nWe'd love to see you at ${e.name}.`, sections: [
    { heading: e.name, body: [`• Date: ${e.event_date ? fmtDate(e.event_date) : "to be confirmed"}`, `• Where: ${e.location || "to be confirmed"}`, `• Fee: ${fee}`, e.capacity ? `• Places: ${e.capacity}, first come first served` : "", e.notes ? "\n" + e.notes : ""].filter(Boolean).join("\n"),
      button_text: e.registration_open ? (Number(e.price_aed) > 0 ? "Sign up and pay" : "Sign up") : "", button_url: e.registration_open ? `${base}/events/${encodeURIComponent(e.activity_id)}` : "" },
  ] };
}

/** The email itself: 600px, table layout and inline styles so it looks right in Outlook, Gmail and Mailchimp. */
function renderEmail(n, base) {
  const esc = (s) => h(s).replace(/\n/g, "<br>");
  const btn = (t, u) => (t && /^https?:\/\//.test(u || "") ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:14px 0 4px"><tr><td style="border-radius:999px;background:#5b5fc7"><a href="${h(u)}" style="display:inline-block;padding:11px 22px;font:bold 15px Arial,sans-serif;color:#ffffff;text-decoration:none;border-radius:999px">${h(t)}</a></td></tr></table>` : "");
  const sec = (s) => `<tr><td style="padding:22px 32px 4px;font:15px/1.55 Arial,sans-serif;color:#2b2840">
      <h2 style="margin:0 0 8px;font:bold 19px Arial,sans-serif;color:#151320">${h(s.heading)}</h2><div>${esc(s.body)}</div>${btn(s.button_text, s.button_url)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${h(n.title)}</title></head>
<body style="margin:0;padding:0;background:#f3f1f8">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f1f8"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden">
  <tr><td style="height:6px;background:#979fe7;background-image:linear-gradient(90deg,#80c0f9,#979fe7,#be91b2,#f59082)"></td></tr>
  <tr><td align="center" style="padding:26px 32px 6px"><img src="${h(base)}/brand/wmf-logo.png" width="260" alt="WMN Moving FWD" style="display:block;width:260px;max-width:80%;height:auto;border:0"></td></tr>
  <tr><td style="padding:10px 32px 0;font:bold 26px/1.15 Arial,sans-serif;color:#151320;text-align:center">${h(n.title)}</td></tr>
  ${n.intro ? `<tr><td style="padding:16px 32px 0;font:15px/1.55 Arial,sans-serif;color:#2b2840">${esc(n.intro)}</td></tr>` : ""}
  ${(n.sections || []).filter((s) => s.heading || s.body).map(sec).join("")}
  <tr><td style="padding:26px 32px 30px;font:13px/1.5 Arial,sans-serif;color:#5f5a74;border-top:1px solid #e7e4f0">
    See you on the road!<br><b>The WMF team</b><br><br>
    <a href="${h(base)}/calendar" style="color:#4d5ac2">Calendar</a> · <a href="${h(base)}/events" style="color:#4d5ac2">Events</a> · <a href="${h(base)}/join" style="color:#4d5ac2">Register</a><br><br>
    You're receiving this because you're part of the Women Moving Forward community and agreed to receive updates. To stop receiving these emails, reply with “unsubscribe”.</td></tr>
</table></td></tr></table></body></html>`;
}

module.exports = function newsletter(app, { need, page, setFlash, actor, user, wrap }) {
  const STAFF = need("admin", "coordinator"), A = need("admin");
  const baseOf = (req) => (process.env.PUBLIC_URL || `${req.protocol}://${req.get("host")}`).replace(/\/$/, "");

  async function audience() {
    return (await pool.query(`SELECT
      count(*) FILTER (WHERE lower(updates_consent) = 'yes') AS yes,
      count(*) FILTER (WHERE lower(coalesce(updates_consent, '')) IN ('', 'not recorded')) AS unknown,
      count(*) FILTER (WHERE lower(updates_consent) = 'no') AS no
      FROM members WHERE merged_into IS NULL AND primary_email ~ '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$'`)).rows[0];
  }

  app.get("/newsletter", STAFF, wrap(async (req, res) => {
    const list = (await pool.query("SELECT id, kind, title, updated_at FROM newsletters ORDER BY updated_at DESC LIMIT 30")).rows;
    const evs = (await pool.query("SELECT activity_id, name, event_date FROM activities WHERE kind = 'event' AND status = 'Active' AND (event_date IS NULL OR event_date >= $1::date) ORDER BY event_date NULLS LAST", [R.todayLocal()])).rows;
    const a = await audience();
    const t = R.todayLocal(), next = +t.slice(8, 10) <= 15 ? t.slice(0, 7) : H.addMonths(t.slice(0, 7), 1); // early in the month: this month's issue (last month's recap)
    res.send(page(req, "Newsletter", `<div class="grid">
      <section class="card c6"><h2>Monthly newsletter</h2><p class="lead">Starts with last month's numbers and highlights, the events and rides coming up, and thanks to partners. Edit any text before sending.</p>
        <form class="form" method="post" action="/newsletter/new"><input type="hidden" name="kind" value="monthly">
          <label>Newsletter for<input type="month" name="month" value="${next}" required></label><button class="btn primary">Create draft</button></form></section>
      <section class="card c6"><h2>Event email</h2><p class="lead">An invitation for one event, with its date, fee and a Sign up button.</p>
        <form class="form" method="post" action="/newsletter/new"><input type="hidden" name="kind" value="event">
          <label>Event<select name="activity_id" required>${evs.map((e) => `<option value="${h(e.activity_id)}">${h(e.name)}${e.event_date ? " · " + fmtDate(e.event_date) : ""}</option>`).join("") || "<option value=''>No upcoming events</option>"}</select></label>
          <button class="btn primary" ${evs.length ? "" : "disabled"}>Create draft</button></form></section>
      <section class="card c12"><h2>Drafts</h2><div class="tw"><table><thead><tr><th>Title</th><th>Type</th><th>Last edited</th></tr></thead><tbody>
        ${list.map((n) => `<tr><td><a href="/newsletter/${n.id}"><b>${h(n.title)}</b></a></td><td>${n.kind === "event" ? "Event email" : "Monthly"}</td><td>${fmtDate(new Date(n.updated_at).toISOString().slice(0, 10))}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">No drafts yet.</td></tr>`}
      </tbody></table></div></section>
      <section class="card c12"><h2>Who receives it</h2><p class="lead">Only members who agreed to receive updates. <b>${nf(a.yes)}</b> members said yes · ${nf(a.no)} said no · ${nf(a.unknown)} have no answer recorded (most imported members), so they are left out unless you choose otherwise. New registrations ask the question, so this list grows.</p></section>
    </div>`, { active: "/newsletter" }));
  }));

  app.post("/newsletter/new", STAFF, wrap(async (req, res) => {
    const base = baseOf(req);
    let d, kind = req.body.kind === "event" ? "event" : "monthly";
    if (kind === "event") d = await draftEvent(req.body.activity_id, base);
    else if (/^\d{4}-\d{2}$/.test(req.body.month || "")) d = await draftMonthly(req.body.month, base);
    if (!d) { setFlash(req, "err", "Choose a month or an event."); return res.redirect("/newsletter"); }
    const id = (await pool.query("INSERT INTO newsletters (kind, title, month, activity_id, intro, sections, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [kind, d.title, kind === "monthly" ? req.body.month + "-01" : null, kind === "event" ? req.body.activity_id : null, d.intro, JSON.stringify(d.sections), actor(req)])).rows[0].id;
    res.redirect("/newsletter/" + id);
  }));

  app.get("/newsletter/:id", STAFF, wrap(async (req, res) => {
    const n = (await pool.query("SELECT * FROM newsletters WHERE id = $1", [+req.params.id || 0])).rows[0];
    if (!n) return res.redirect("/newsletter");
    const base = baseOf(req), a = await audience();
    const secs = [...n.sections, {}, {}].slice(0, Math.max(n.sections.length + 1, 3));
    const isAdmin = user(req).role === "admin";
    res.send(page(req, n.title, `<div class="grid">
      <section class="card c6"><h2>Edit</h2>
        <form class="form" method="post" action="/newsletter/${n.id}">
          <label>Title<input name="title" required maxlength="140" value="${h(n.title)}"></label>
          <label>Opening<textarea name="intro" rows="4">${h(n.intro)}</textarea></label>
          ${secs.map((s, i) => `<fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px;display:grid;gap:8px"><legend style="font-weight:600;color:var(--ink-2);font-size:14px">Section ${i + 1}${s.heading ? "" : " (empty = left out)"}</legend>
            <input class="inp" name="heading_${i}" placeholder="Heading" value="${h(s.heading)}"><textarea class="inp" name="body_${i}" rows="5" placeholder="Text">${h(s.body)}</textarea>
            <div class="row2"><input class="inp" name="btext_${i}" placeholder="Button text (optional)" value="${h(s.button_text)}"><input class="inp" name="burl_${i}" placeholder="Button link https://…" value="${h(s.button_url)}"></div></fieldset>`).join("")}
          <input type="hidden" name="count" value="${secs.length}">
          <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Save</button><button class="btn" name="add" value="1">Save and add a section</button></div>
        </form>
        <form method="post" action="/newsletter/${n.id}/delete" style="margin-top:12px"><button class="btn danger">Delete draft</button></form></section>
      <section class="card c6"><h2>Send it</h2>
        <ol style="margin:0 0 12px;padding-left:20px;display:grid;gap:6px;font-size:14px">
          <li><b>Outlook:</b> press <b>Copy for Outlook</b>, start a new email in Outlook, paste. Put the recipients in <b>Bcc</b> so nobody sees the other addresses.</li>
          <li><b>Mailchimp:</b> create an email with “Code your own”, press <b>Copy HTML code</b> and paste it in. Import the recipient list as your audience.</li>
          <li>Send a test to yourself first and check it on your phone.</li></ol>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary" type="button" data-copy="html">Copy for Outlook</button><button class="btn" type="button" data-copy="code">Copy HTML code</button>
          <a class="btn" href="/newsletter/${n.id}/email.html" download="${h(n.title.replace(/[^\w -]+/g, ""))}.html">Download .html</a></div>
        <p class="toast" id="nToast" role="status"></p>
        <h3 style="margin:18px 0 6px;font-size:15px">Recipient list</h3>
        ${isAdmin ? `<p class="lead" style="margin:0 0 8px">${nf(a.yes)} members agreed to updates. The list holds their email and first name, and the download is logged.</p>
          <form method="post" action="/newsletter-recipients.csv" class="form" style="gap:8px">
            <label class="check"><input type="checkbox" name="include_unknown" value="1"> <span>Also include the ${nf(a.unknown)} members with no answer recorded. Only tick this if WMF is allowed to email them, for example because they joined through a WMF form that said so.</span></label>
            <div class="toolbar" style="margin:0;align-items:center"><input class="inp" type="password" name="password" required placeholder="Your password" autocomplete="current-password" style="max-width:220px"><button class="btn">Download recipients (CSV)</button></div></form>`
    : `<p class="lead">An administrator downloads the recipient list, because it contains members' email addresses.</p>`}
      </section>
      <section class="card c12"><h2>Preview</h2><div id="email-preview" style="border:1px solid var(--line);border-radius:12px;overflow:hidden">${renderEmail(n, base).replace(/^[\s\S]*<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, "")}</div>
        <template id="email-html">${h(renderEmail(n, base))}</template></section>
    </div>`, { active: "/newsletter", scripts: `<script src="/newsletter.js"></script>` }));
  }));

  app.post("/newsletter/:id", STAFF, wrap(async (req, res) => {
    const b = req.body, count = Math.min(12, +b.count || 0), sections = [];
    for (let i = 0; i < count; i++) {
      const s = { heading: R.clean(b["heading_" + i]), body: String(b["body_" + i] || "").replace(/\r/g, "").trim(), button_text: R.clean(b["btext_" + i]), button_url: R.clean(b["burl_" + i]) };
      if (s.button_url && !/^https?:\/\//.test(s.button_url)) s.button_url = "";
      if (s.heading || s.body) sections.push(s);
    }
    if (b.add) sections.push({ heading: "New section", body: "" });
    await pool.query("UPDATE newsletters SET title = $2, intro = $3, sections = $4, updated_at = now() WHERE id = $1",
      [+req.params.id, R.clean(b.title) || "WMF newsletter", String(b.intro || "").replace(/\r/g, "").trim(), JSON.stringify(sections)]);
    setFlash(req, "ok", "Saved.");
    res.redirect("/newsletter/" + +req.params.id);
  }));
  app.post("/newsletter/:id/delete", STAFF, wrap(async (req, res) => { await pool.query("DELETE FROM newsletters WHERE id = $1", [+req.params.id]); setFlash(req, "ok", "Draft deleted."); res.redirect("/newsletter"); }));
  app.get("/newsletter/:id/email.html", STAFF, wrap(async (req, res) => {
    const n = (await pool.query("SELECT * FROM newsletters WHERE id = $1", [+req.params.id || 0])).rows[0];
    if (!n) return res.status(404).send("Not found");
    res.type("html").set("Content-Disposition", "attachment").send(renderEmail(n, baseOf(req)));
  }));

  app.post("/newsletter-recipients.csv", A, wrap(async (req, res) => {
    const u = (await pool.query("SELECT password_hash FROM users WHERE id = $1", [user(req).id])).rows[0];
    if (!u || !(await bcrypt.compare(String(req.body.password || ""), u.password_hash))) {
      await audit(pool, actor(req), "recipients.refused", "newsletter", null, null, null, "Wrong password");
      setFlash(req, "err", "Password not right. Nothing was downloaded.");
      return res.redirect(req.get("referer") && new URL(req.get("referer")).host === req.get("host") ? new URL(req.get("referer")).pathname : "/newsletter");
    }
    const unknown = !!req.body.include_unknown;
    const rows = (await pool.query(`SELECT member_id, full_name, primary_email FROM members WHERE merged_into IS NULL
       AND primary_email ~ '^[^@\\s]+@[^@\\s]+\\.[A-Za-z]{2,}$'
       AND (lower(updates_consent) = 'yes' ${unknown ? "OR lower(coalesce(updates_consent, '')) IN ('', 'not recorded')" : ""}) ORDER BY member_id`)).rows;
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const csv = [["Email Address", "First Name", "Member ID"].map(q).join(",")].concat(rows.map((r) => [r.primary_email, R.clean(r.full_name).split(" ")[0], r.member_id].map(q).join(",")));
    await audit(pool, actor(req), "recipients.download", "newsletter", null, null, { rows: rows.length, includeUnknown: unknown }, null);
    res.type("text/csv").set("Content-Disposition", `attachment; filename="WMF-recipients-${R.todayLocal()}.csv"`).send("﻿" + csv.join("\r\n"));
  }));
};
module.exports.renderEmail = renderEmail;
module.exports.draftMonthly = draftMonthly;
