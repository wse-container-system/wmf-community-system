"use strict";
/** Ride It Forward: one public page (QR code at the drop area + social media link) with two choices: donate gear or apply. */
const { pool, tx, audit, nextNumber } = require("./db");
const R = require("./rules");
const { h, fmtDate, fmtTs } = require("./views");

const EVENT = "ACT-RIDE-IT-FORWARD";
const ITEMS = ["Bike", "Helmet", "Jersey", "Bib shorts", "Gloves", "Cycling shoes", "Lights", "Water bottle", "Other"];

async function applyOpen() {
  const e = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [EVENT])).rows[0];
  const today = R.todayLocal();
  const open = e && e.registration_open && e.status === "Active" && (!e.event_date || e.event_date >= today) && (!e.apply_until || e.apply_until >= today);
  return { e, open };
}

function donateForm(v = {}, err) {
  const items = [].concat(v.items || []);
  return `<section class="card"><h2>Give your gear a new home</h2>
    <p class="lead">Tell us what you're donating. Clean, good-condition items only, please.</p>
    ${err ? `<div class="flash err" role="alert">${h(err)}</div>` : ""}
    <form class="form" method="post" action="/ride-it-forward/donate">
      <label>Full name<input name="full_name" required maxlength="120" value="${h(v.full_name)}" autocomplete="name"></label>
      <div class="row2"><label>Mobile<input name="mobile" required maxlength="30" value="${h(v.mobile)}" autocomplete="tel" inputmode="tel"></label>
        <label>Email <span class="hint">(optional)</span><input name="email" type="email" maxlength="160" value="${h(v.email)}" autocomplete="email"></label></div>
      <fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend style="font-weight:600;color:var(--ink-2);font-size:14px">What are you donating?</legend>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:4px 12px">${ITEMS.map((g) => `<label class="check"><input type="checkbox" name="items" value="${h(g)}" ${items.includes(g) ? "checked" : ""}> <span>${h(g)}</span></label>`).join("")}</div></fieldset>
      <label>Sizes and details <span class="hint">(e.g. jersey M, bib shorts S, helmet 54–58 cm)</span><textarea name="details" maxlength="600" rows="3">${h(v.details)}</textarea></label>
      <label class="check"><input type="checkbox" name="condition" value="1" required ${v.condition ? "checked" : ""}> <span>My items are clean and in good condition.</span></label>
      <input name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-5000px" aria-hidden="true">
      <button class="btn primary big">Donate my gear</button>
    </form><p style="margin:12px 0 0"><a href="/ride-it-forward">Back</a></p></section>`;
}

module.exports = function rideForward(app, { need, page, actor, wrap, limit, qrPng, qrDataUrl }) {
  const STAFF = need("admin", "coordinator");
  const pub = (req, title, body) => page(req, title, body, { wide: false, active: "/ride-it-forward" });
  const link = (req) => `${req.protocol}://${req.get("host")}/ride-it-forward`;

  // ---------- public landing page ----------
  app.get("/ride-it-forward", wrap(async (req, res) => {
    const { e, open } = await applyOpen();
    res.send(pub(req, "Ride It Forward", `<div class="rif">
      <section class="rif-hero">
        <p class="rif-kicker">WMN Moving FWD</p>
        <h2>Ride It Forward</h2>
        <p class="rif-tag">Share your gear. Support someone's cycling journey.</p>
        <p class="rif-sub">Every rider started somewhere. The helmet in your cupboard or the jersey you no longer wear could be what gives a woman the confidence to take her first ride.</p>
      </section>
      <div class="rif-choices">
        <a class="rif-choice" href="/ride-it-forward/donate">
          <span class="rif-ic" aria-hidden="true">🎁</span>
          <b>I have gear to give</b>
          <span>Give your gear a new home. Clean, good-condition cycling items help a beginner ride with confidence.</span>
          <span class="btn primary">Donate gear</span></a>
        ${open ? `<a class="rif-choice" href="/events/${EVENT}">
          <span class="rif-ic" aria-hidden="true">🚲</span>
          <b>I want to start riding</b>
          <span>New to cycling or getting back on the bike? Share your story. Selected women receive donated cycling essentials and ride with our community.</span>
          <span class="btn primary">Apply now</span>${e.apply_until ? `<span class="rif-note">Applications close ${fmtDate(e.apply_until)}</span>` : ""}</a>`
        : `<div class="rif-choice off"><span class="rif-ic" aria-hidden="true">🚲</span><b>I want to start riding</b>
          <span>Applications are closed for now. Thank you to everyone who shared their story. Follow WMF for the next round.</span></div>`}
      </div>
      <section class="card"><h2>How it works</h2>
        <ol class="rif-steps">
          <li><b>Donate</b><span>Drop clean, good-condition gear at the donation point, or bring it to a WMF ride.</span></li>
          <li><b>Apply</b><span>Beginners share their story during the one-week application period.</span></li>
          <li><b>Ride</b><span>Selected women receive their gear and join their first WMF ride, with a community cheering them on.</span></li>
        </ol>
        <p class="muted" style="margin:10px 0 0">We collect: bikes, helmets, jerseys, bib shorts, gloves, cycling shoes, lights and bottles.</p></section>
    </div>`));
  }));

  // ---------- public donation form ----------
  app.get("/ride-it-forward/donate", (req, res) => res.send(pub(req, "Donate gear", donateForm())));
  app.post("/ride-it-forward/donate", limit("donate", 10, 60 * 60e3), wrap(async (req, res) => {
    const b = req.body || {};
    if (b.website) return res.redirect("/ride-it-forward");
    const items = [].concat(b.items || []).filter((x) => ITEMS.includes(x));
    const email = R.normEmail(b.email);
    let err = "";
    if (!R.clean(b.full_name)) err = "Please enter your name.";
    else if (R.normPhone(b.mobile).length < 9) err = "Please check your mobile number.";
    else if (email && !R.EMAIL_RE.test(email)) err = "Please check your email address.";
    else if (!items.length) err = "Please tick what you're donating.";
    else if (!b.condition) err = "Please confirm your items are clean and in good condition.";
    if (err) return res.send(pub(req, "Donate gear", donateForm(b, err)));
    const ref = await tx(async (c) => {
      const r = "RIF-" + String(await nextNumber(c, "RIF")).padStart(4, "0");
      await c.query("INSERT INTO gear_donations (ref, full_name, mobile, email, items, details) VALUES ($1,$2,$3,$4,$5,$6)",
        [r, R.clean(b.full_name), R.clean(b.mobile), email || null, items, String(b.details || "").trim().slice(0, 600) || null]);
      return r;
    });
    res.send(pub(req, "Thank you", `<div class="rif"><section class="rif-hero"><h2>Thank you for riding it forward!</h2>
      <p class="rif-sub">Your gear will help a beginner start her cycling journey. Drop your items at the Ride It Forward donation point, or bring them to a WMF ride.</p>
      <p class="rif-sub">Your reference: <b>${h(ref)}</b></p></section>
      <p style="text-align:center"><a href="/ride-it-forward">Back to Ride It Forward</a></p></div>`));
  }));

  // ---------- staff: QR code, link, donations ----------
  app.get("/ride-it-forward/manage", STAFF, wrap(async (req, res) => {
    const d = (await pool.query("SELECT * FROM gear_donations ORDER BY created_at DESC")).rows;
    const apps = (await pool.query("SELECT count(*)::int n, count(*) FILTER (WHERE selection = 'Selected')::int s FROM participation WHERE activity_id = $1 AND voided_at IS NULL", [EVENT])).rows[0];
    const img = await qrDataUrl(link(req));
    res.send(page(req, "Ride It Forward", `<div class="grid">
      <section class="card c4" style="text-align:center"><h2>QR code & link</h2>
        <p class="lead">One code for both: print it for the drop area and share the link on social media.</p>
        <div class="qrbox"><img src="${img}" alt="QR code for Ride It Forward"></div>
        <p><a href="/ride-it-forward">${h(link(req))}</a></p>
        <a class="btn primary" href="/ride-it-forward/qr.png">Download QR code</a></section>
      <section class="card c8"><div class="card-head"><div><h2>Donations</h2></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/activities/${EVENT}/signups">Applications (${apps.n}, ${apps.s} selected)</a><a class="btn" href="/activities/${EVENT}">Event settings</a></div></div>
        <div class="tiles" style="margin:6px 0 14px"><div class="tile"><span class="lbl">Donations</span><span class="val">${d.length}</span></div>
          <div class="tile"><span class="lbl">Received</span><span class="val">${d.filter((x) => x.received).length}</span></div></div>
        <div class="tw"><table><thead><tr><th>Donor</th><th>Items</th><th>Date</th><th>Received</th></tr></thead><tbody>
        ${d.map((x) => `<tr><td><b>${h(x.full_name)}</b><br><span class="muted">${h(x.ref)} · ${h(x.mobile || "")}${x.email ? " · " + h(x.email) : ""}</span></td>
          <td>${h(x.items.join(", "))}${x.details ? `<br><span class="muted">${h(x.details)}</span>` : ""}</td><td>${fmtTs(x.created_at)}</td>
          <td><form method="post" action="/ride-it-forward/donations/${x.id}" style="margin:0"><button class="btn tblbtn ${x.received ? "primary" : ""}" name="received" value="${x.received ? "0" : "1"}">${x.received ? "✓ Received" : "Mark received"}</button></form></td></tr>`).join("")
          || `<tr><td colspan="4" class="muted">No donations yet.</td></tr>`}
        </tbody></table></div></section></div>`, { active: "/ride-it-forward/manage" }));
  }));
  app.get("/ride-it-forward/qr.png", STAFF, wrap(async (req, res) => {
    res.type("png").set("Content-Disposition", 'attachment; filename="Ride-It-Forward-QR.png"').send(await qrPng(link(req)));
  }));
  app.post("/ride-it-forward/donations/:id", STAFF, wrap(async (req, res) => {
    const received = req.body.received === "1";
    await tx(async (c) => {
      const r = (await c.query("UPDATE gear_donations SET received = $2 WHERE id = $1 RETURNING ref", [+req.params.id, received])).rows[0];
      if (r) await audit(c, actor(req), "donation.received", "gear_donation", r.ref, null, { received });
    });
    res.redirect("/ride-it-forward/manage");
  }));
};
module.exports.EVENT = EVENT;
