"use strict";
/**
 * WhatsApp ride reminder for the regular WMF rides (Monday and Wednesday, 06:00, Hudayriyat Island by default).
 *
 * - Staff see a banner on the Hub and WMF home from the evening before each ride: "Share on WhatsApp" opens WhatsApp
 *   with the message filled in (ride, date, time, place, weather, sign-up link). Pick the group and tap send.
 * - The sign-up link opens /join-ride/<date>, where riders put their name down; staff see the list here.
 * - Backup: the "Ride reminder" GitHub Action posts the same message on a GitHub issue at 04:00 Dubai on ride days,
 *   so GitHub notifies Rona by email and in its app. It reads /api/ride-reminder.json.
 * Settings (days, time, place, extra line, skipped dates) live in settings.rideReminder.
 */
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const M = require("./ridemsg");
const { h, fmtDate } = require("./views");

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function getConfig(c) {
  const r = (await (c || pool).query("SELECT value FROM settings WHERE key = 'rideReminder'")).rows[0];
  const v = (r && r.value) || {};
  return { schedule: v.schedule || null, skip: v.skip || {}, sent: v.sent || {}, note: v.note || "" };
}
async function saveConfig(c, cfg) {
  const today = R.todayLocal(), keep = (o) => Object.fromEntries(Object.entries(o || {}).filter(([d]) => d >= M.addDays(today, -60))); // forget old dates
  await c.query("INSERT INTO settings (key, value) VALUES ('rideReminder', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
    [JSON.stringify({ ...cfg, skip: keep(cfg.skip), sent: keep(cfg.sent) })]);
}

const baseUrl = (req) => (process.env.PUBLIC_URL || (req ? `${req.protocol}://${req.get("host")}` : "")).replace(/\/$/, "");

/** Everything about one ride's reminder: the ride, weather, message, WhatsApp link, sign-ups. */
async function reminder(ride, cfg, base, { fetcher } = {}) {
  const w = await M.weather(ride, fetcher ? { fetcher } : {});
  const signupUrl = base + M.signupPath(ride.date);
  const text = M.message(ride, { weather: w, signupUrl, note: cfg.note });
  const n = Number((await pool.query("SELECT count(*) AS n FROM ride_signups WHERE ride_date = $1", [ride.date])).rows[0].n);
  return { ride, weather: w, message: text, whatsapp: M.whatsappLink(text), signupUrl, signups: n, sent: cfg.sent[ride.date] || null };
}

/** The banner on the Hub and WMF home: from 18:00 the day before a ride until it starts, unless marked as sent. */
async function banner(req) {
  try {
    const cfg = await getConfig(), now = R.nowLocal().slice(0, 16), r = M.nextRides(1, { ...cfg, now })[0];
    if (!r || cfg.sent[r.date]) return "";
    const today = now.slice(0, 10);
    if (!(r.date === today && now.slice(11, 16) <= r.time) && !(r.date === M.addDays(today, 1) && now.slice(11, 16) >= "18:00")) return "";
    const x = await reminder(r, cfg, baseUrl(req));
    return `<div class="alert info rr-banner"><span class="ic">🚴</span><span><b>${h(r.day)} ride reminder is ready</b> (${h(M.time12(r.time))}, ${h(r.location)}${x.weather ? `, ${x.weather.temp}°C${x.weather.wind != null ? `, wind ${x.weather.wind} km/h` : ""}` : ""}). Send it to the WMF WhatsApp group:
      <span class="rr-actions"><a class="btn primary" href="${h(x.whatsapp)}" target="_blank" rel="noopener">Share on WhatsApp</a>
      <a class="btn" href="/wmf/ride-reminder">Preview</a>
      <form method="post" action="/wmf/ride-reminder/${r.date}/sent" style="display:inline"><button class="btn">Mark as sent</button></form></span></span></div>`;
  } catch (e) { console.error("Ride reminder banner:", e.message); return ""; }
}

function signupForm(ride, w, v = {}, err, consentText) {
  return `<section class="card"><span class="eyebrow">WMN Moving FWD</span><h2>${h(ride.title)}</h2>
    <p class="lead">📅 ${h(M.longDate(ride.date))}<br>⏰ ${h(M.time12(ride.time))}<br>📍 ${h(ride.location)}${w ? `<br>🌡️ ${w.temp}°C${w.sky ? ", " + h(w.sky) : ""}${w.wind != null ? `<br>💨 ${w.wind} km/h${w.dir ? " " + h(w.dir) : ""}` : ""}` : ""}</p>
    ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <form class="form" method="post">
      <label>Member ID <span class="hint">(optional, on your QR code, e.g. WMF-000123)</span><input name="member_id" maxlength="20" value="${h(v.member_id)}"></label>
      <label>Full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
      <div class="row2"><label>Email<input name="email" type="email" required maxlength="160" value="${h(v.email)}" autocomplete="email"></label>
      <label>Mobile<input name="mobile" required maxlength="30" value="${h(v.mobile)}" autocomplete="tel"></label></div>
      <label class="check"><input type="checkbox" name="waiver_consent" value="1" required> <span>${consentText}</span></label>
      <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
      <button class="btn primary big">I'm riding</button></form>
    <p style="margin:12px 0 0"><a href="/calendar">See the full WMF calendar</a></p></section>`;
}

module.exports = function rideReminder(app, { need, page, setFlash, actor, wrap, limit, qrDataUrl, consentText }) {
  const STAFF = need("admin", "coordinator");

  /** The ride for a sign-up link: a ride day, today or later, not skipped. */
  async function openRide(date) {
    if (!DATE_RE.test(date || "") || date < R.todayLocal()) return null;
    const cfg = await getConfig(), r = M.rideOn(date, cfg);
    return r && !r.skipped ? { r, cfg } : null;
  }
  const closed = (req, res) => res.status(404).send(page(req, "Ride sign-up", `<section class="card"><h2>Sign-up for this ride is closed</h2>
    <p class="lead">There's no WMF ride on this date, or it has already happened. <a href="/calendar">See the WMF calendar</a></p></section>`, { wide: false }));

  // public: the ride's details and message, for the GitHub Action (nothing personal in it)
  app.get("/api/ride-reminder.json", wrap(async (req, res) => {
    const cfg = await getConfig(), d = String(req.query.date || "");
    const r = DATE_RE.test(d) ? M.rideOn(d, cfg) : M.nextRides(1, cfg)[0];
    res.set("Cache-Control", "no-store");
    if (!r) return res.json({ ride: null });
    if (r.skipped) return res.json({ ride: r, skipped: true });
    const x = await reminder(r, cfg, baseUrl(req));
    res.json({ ride: r, weather: x.weather, message: x.message, whatsapp: x.whatsapp, signupUrl: x.signupUrl, signups: x.signups });
  }));

  // public: sign up for a ride
  app.get("/join-ride/:date", wrap(async (req, res) => {
    const o = await openRide(req.params.date);
    if (!o) return closed(req, res);
    res.send(page(req, o.r.title, signupForm(o.r, await M.weather(o.r), {}, null, consentText), { wide: false }));
  }));
  app.post("/join-ride/:date", limit("rideSignup", 10, 60 * 60e3), wrap(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.redirect("/join-ride/" + req.params.date);
    const o = await openRide(req.params.date);
    if (!o) return closed(req, res);
    const ride = o.r, email = R.normEmail(b.email);
    if (!R.clean(b.full_name) || !R.EMAIL_RE.test(email) || R.normPhone(b.mobile).length < 9 || !b.waiver_consent)
      return res.send(page(req, ride.title, signupForm(ride, await M.weather(ride), b, "Please fill in your name, a valid email and mobile, and accept the terms.", consentText), { wide: false }));
    const out = await tx(async (c) => {
      // the Member ID only counts when it belongs to the same email, so nobody can sign up as someone else
      let member = null;
      const byId = R.memberIdFromScan(b.member_id) ? await R.findMember(c, { memberId: R.memberIdFromScan(b.member_id) }) : null;
      if (byId && [byId.primary_email, ...String(byId.alt_emails || "").split(/[;,\s]+/)].map(R.normEmail).includes(email)) member = byId;
      if (!member) member = await R.findMember(c, { email });
      let created = false;
      if (!member) { member = await R.createMember(c, { ...b, email, waiver_consent: true }, "public", "WMF App Ride Sign-up"); created = true; }
      const ins = await c.query(`INSERT INTO ride_signups (ride_date, member_id, full_name, email, mobile) VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (ride_date, member_id) DO NOTHING RETURNING id`, [ride.date, member.member_id, R.clean(b.full_name).slice(0, 120), email, R.clean(b.mobile).slice(0, 30)]);
      if (ins.rows[0]) await audit(c, "public", "ride.signup", "ride_signup", String(ins.rows[0].id), null, { ride: ride.date, member: member.member_id });
      return { member, created, duplicate: !ins.rows[0] };
    });
    let qr = "";
    if (out.created) {
      const img = await qrDataUrl(out.member.qr_value);
      qr = `<p class="lead">You're also now a WMF member. Show this QR code to the ride leader at the ride:</p><div class="qrbox"><img src="${img}" alt="Your QR code"><span class="id">${h(out.member.member_id)}</span></div>
        <a class="btn" href="${img}" download="${h(out.member.member_id)}-WMF-QR.png">Download QR code</a>`;
    }
    res.send(page(req, ride.title, `<section class="card" style="display:grid;gap:12px"><h2>${out.duplicate ? "You're already signed up" : "You're in!"}</h2>
      <p class="lead">${h(ride.title)}<br>📅 ${h(M.longDate(ride.date))} · ⏰ ${h(M.time12(ride.time))} · 📍 ${h(ride.location)}</p>
      ${out.created ? "" : `<p class="muted">Bring your WMF QR code: the ride leader scans it at the start.</p>`}${qr}
      <p><a href="/calendar">See the WMF calendar</a></p></section>`, { wide: false }));
  }));

  // staff: preview, share, sign-ups, settings
  app.get("/wmf/ride-reminder", STAFF, wrap(async (req, res) => {
    const cfg = await getConfig(), sch = M.schedule(cfg.schedule), base = baseUrl(req);
    const rides = M.nextRides(3, { ...cfg, now: R.nowLocal().slice(0, 16), withSkipped: true });
    const cards = [];
    for (const r of rides) {
      if (r.skipped) {
        cards.push(`<section class="card"><div class="card-head"><div><h2>${h(r.day)}, ${h(fmtDate(r.date))}</h2><p class="lead"><span class="badge">No ride this day</span> No reminder, and the sign-up link is closed.</p></div>
          <form method="post" action="/wmf/ride-reminder/${r.date}/skip"><button class="btn">The ride is on after all</button></form></div></section>`);
        continue;
      }
      const x = await reminder(r, cfg, base);
      const list = (await pool.query("SELECT full_name, member_id, created_at FROM ride_signups WHERE ride_date = $1 ORDER BY created_at", [r.date])).rows;
      cards.push(`<section class="card"><div class="card-head"><div><h2>${h(r.day)}, ${h(fmtDate(r.date))}</h2>
          <p class="lead">${x.sent ? `<span class="badge good">Sent</span> ` : ""}${x.signups} signed up${x.weather ? "" : " · <span class='muted'>weather not available right now</span>"}</p></div>
          <div class="toolbar" style="margin:0"><a class="btn primary" href="${h(x.whatsapp)}" target="_blank" rel="noopener">Share on WhatsApp</a>
            <button class="btn" type="button" data-copy="${h(x.message)}">Copy message</button>
            <form method="post" action="/wmf/ride-reminder/${r.date}/sent"><button class="btn">${x.sent ? "Not sent yet" : "Mark as sent"}</button></form>
            <form method="post" action="/wmf/ride-reminder/${r.date}/skip" data-confirm="No ride on ${h(fmtDate(r.date))}? The reminder and sign-up link are switched off for that day."><button class="btn">No ride this day</button></form></div></div>
        <pre class="rr-msg">${h(x.message)}</pre>
        <p class="hint">Sign-up link: <a href="${h(M.signupPath(r.date))}">${h(x.signupUrl)}</a></p>
        ${list.length ? `<details><summary>Who's signed up (${list.length})</summary><ul class="log">${list.map((s) => `<li><a href="/members/${encodeURIComponent(s.member_id)}">${h(s.full_name)}</a><span class="muted">${h(s.member_id)}</span></li>`).join("")}</ul></details>` : ""}
      </section>`);
    }
    const D = M.DAY_NAMES, order = [1, 2, 3, 4, 5, 6, 0];
    res.send(page(req, "Ride reminder", `<section class="card"><h2>WhatsApp ride reminder</h2>
      <p class="lead">Before every regular ride the app writes the message for the WMF WhatsApp group: ride, date, time, place, the weather at the start and a sign-up link.
        From 6 PM the evening before, a banner on the Hub and WMF home has a <b>Share on WhatsApp</b> button: it opens WhatsApp with the message filled in, so you pick the group and tap send.
        WhatsApp doesn't let apps post into groups by themselves. As a backup, GitHub sends you the same message at 4 AM on ride days.</p></section>
      ${cards.join("") || `<section class="card"><p class="muted">No rides in the next two weeks. Switch on a ride day below.</p></section>`}
      <section class="card"><h2>Ride days</h2>
      <form class="form" method="post" action="/wmf/ride-reminder/settings">
        <div class="tw"><table><thead><tr><th>Day</th><th>Ride</th><th>Start</th><th>Meeting point</th></tr></thead><tbody>
        ${order.map((d) => `<tr><td>${D[d]}</td><td><label class="check" style="display:inline-flex"><input type="checkbox" name="on_${d}" value="1" ${sch[d].on ? "checked" : ""}> Ride</label></td>
          <td><input type="time" name="time_${d}" value="${h(sch[d].time)}"></td><td><input name="location_${d}" maxlength="80" value="${h(sch[d].location)}" style="width:100%"></td></tr>`).join("")}
        </tbody></table></div>
        <label>Extra line <span class="hint">(optional, added before "See you on the ride!", e.g. "Lights on and helmets please")</span><input name="note" maxlength="200" value="${h(cfg.note)}"></label>
        <div><button class="btn primary">Save</button></div></form></section>`, { active: "/wmf" }));
  }));

  app.post("/wmf/ride-reminder/settings", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, schedule = {};
    for (let d = 0; d < 7; d++) {
      const time = TIME_RE.test(b["time_" + d] || "") ? b["time_" + d] : "06:00";
      schedule[d] = { on: !!b["on_" + d], time, location: R.clean(b["location_" + d] || "").slice(0, 80) || "Hudayriyat Island" };
    }
    const note = R.clean(b.note || "").slice(0, 200);
    await tx(async (c) => { const cfg = await getConfig(c); await saveConfig(c, { ...cfg, schedule, note }); await audit(c, actor(req), "rideReminder.settings", "settings", "rideReminder", { schedule: cfg.schedule, note: cfg.note }, { schedule, note }); });
    setFlash(req, "ok", "Saved.");
    res.redirect("/wmf/ride-reminder");
  }));

  // toggles: sent / no ride this day
  for (const kind of ["sent", "skip"]) {
    app.post(`/wmf/ride-reminder/:date/${kind}`, STAFF, wrap(async (req, res) => {
      const d = req.params.date;
      if (!DATE_RE.test(d)) return res.redirect("/wmf/ride-reminder");
      await tx(async (c) => {
        const cfg = await getConfig(c), map = { ...cfg[kind] };
        if (map[d]) delete map[d]; else map[d] = { at: new Date().toISOString(), by: actor(req) };
        await saveConfig(c, { ...cfg, [kind]: map });
        await audit(c, actor(req), `rideReminder.${kind}`, "settings", "rideReminder", null, { date: d, on: !!map[d] });
      });
      const back = String(req.get("referer") || "");
      res.redirect(/\/wmf\/ride-reminder/.test(back) || kind === "skip" ? "/wmf/ride-reminder" : /\/wmf$/.test(back) ? "/wmf" : "/");
    }));
  }
};
module.exports.banner = banner;
module.exports.getConfig = getConfig;
