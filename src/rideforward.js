"use strict";
/** Ride It Forward: one public page (QR code at the drop area + social media link) with two choices: donate gear or apply. */
const crypto = require("crypto");
const { pool, tx, audit, nextNumber } = require("./db");
const R = require("./rules");
const { h, fmtDate, fmtTs } = require("./views");

const EVENT = "ACT-RIDE-IT-FORWARD";
const ITEMS = ["Helmet", "Jersey", "Bib shorts", "Gloves", "Cycling shoes", "Lights", "Water bottle", "Other"];
const COLLECT = ["Jerseys, cycling shorts, gloves and socks", "Shoes, sunglasses and water bottles", "Lights, reflectors, saddle bags and basic tools", "Other clean, safe and usable cycling accessories"];

// ---------- page text: editable by the team, and by the manager through a review link (no sign-in) ----------
const TEXT = [
  ["tagline", "Tagline", "Supporting beginners into their cycling journey.", 160],
  ["intro", "Intro", "Every rider remembers her first ride: the nerves, the wobble, the joy. Ride It Forward helps women who are new to cycling begin with the right gear and a community cheering them on. Give your gear a new home and help her ride.", 500],
  ["donate", "“I have gear to give” text", "Give your gear a new home. Clean, good-condition cycling items help a beginner ride with confidence.", 400],
  ["apply", "“I want to start riding” text", "New to cycling or getting back on the bike? Share your story. Selected women receive donated cycling essentials and ride with our community.", 400],
  ["day_title", "Event day: title", "Ride It Forward Day", 120],
  ["day_when", "Event day: date", "Sunday, 6 December 2026", 120],
  ["day_text", "Event day: text", "All women are invited! Join our women-only community ride, then watch the final of the Hudayriyat Women's Races series and cheer on amazing, strong women to look up to.", 600],
  ["dropoff", "Where to drop donations", "Drop your items at Wolfi's reception from 30 November to 4 December.", 300],
];
async function loadText() {
  const r = (await pool.query("SELECT value FROM settings WHERE key = 'rideItForward'")).rows[0];
  const v = (r && r.value) || {};
  return { ...Object.fromEntries(TEXT.map(([k, , d]) => [k, d])), ...v };
}
async function saveText(patch) {
  const cur = await loadText();
  const next = { ...cur, ...patch };
  await pool.query("INSERT INTO settings (key, value) VALUES ('rideItForward', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify(next)]);
  return next;
}
async function reviewToken() {
  const t = await loadText();
  return t.token || (await saveText({ token: crypto.randomBytes(18).toString("base64url") })).token;
}
const approved = (t) => t.approved_at && (!t.edited_at || t.approved_at >= t.edited_at);
const status = (t) => approved(t) ? `<span class="badge good">Approved by ${h(t.approved_by)} · ${fmtTs(t.approved_at)}</span>`
  : `<span class="badge">${t.approved_at ? "Changed since approval" : "Waiting for approval"}</span>`;
function textForm(t, action, extra = "", buttons = `<button class="btn primary">Save changes</button>`) {
  return `<form class="form" method="post" action="${action}">
    ${TEXT.map(([k, label, , max]) => max > 200 ? `<label>${h(label)}<textarea name="${k}" maxlength="${max}" rows="4" style="font:inherit">${h(t[k])}</textarea></label>`
      : `<label>${h(label)}<input name="${k}" maxlength="${max}" value="${h(t[k])}"></label>`).join("")}
    ${extra}<div style="display:flex;gap:8px;flex-wrap:wrap">${buttons}</div></form>`;
}
const readText = (b) => Object.fromEntries(TEXT.map(([k, , d, max]) => [k, String(b[k] == null ? "" : b[k]).replace(/\r/g, "").trim().slice(0, max) || d]));
const para = (s) => h(s).replace(/\n/g, "<br>");

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
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:4px 12px">${ITEMS.map((g) => `<label class="check"><input type="checkbox" name="items" value="${h(g)}" ${items.includes(g) ? "checked" : ""}> <span>${h(g)}</span></label>`).join("")}</div></fieldset>
      <label>Sizes and details <span class="hint">(e.g. jersey M, bib shorts S, shoes 39)</span><textarea name="details" maxlength="600" rows="3">${h(v.details)}</textarea></label>
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
    const t = await loadText();
    res.send(pub(req, "Ride It Forward", `<div class="rif">
      <section class="rif-hero">
        <p class="rif-kicker">WMN Moving FWD</p>
        <h2>Ride It Forward</h2>
        <p class="rif-tag">${para(t.tagline)}</p>
        <p class="rif-sub">${para(t.intro)}</p>
      </section>
      <div class="rif-choices">
        <a class="rif-choice" href="/ride-it-forward/donate">
          <span class="rif-ic" aria-hidden="true">🎁</span>
          <b>I have gear to give</b>
          <span>${para(t.donate)}</span>
          <span class="btn primary">Donate gear</span></a>
        ${open ? `<a class="rif-choice" href="/events/${EVENT}">
          <span class="rif-ic" aria-hidden="true">🚲</span>
          <b>I want to start riding</b>
          <span>${para(t.apply)}</span>
          <span class="btn primary">Apply now</span>${e.apply_until ? `<span class="rif-note">Applications close ${fmtDate(e.apply_until)}</span>` : ""}</a>`
        : `<div class="rif-choice off"><span class="rif-ic" aria-hidden="true">🚲</span><b>I want to start riding</b>
          <span>Applications are closed for now. Thank you to everyone who shared their story. Follow WMF for the next round.</span></div>`}
      </div>
      <section class="rif-day"><span class="rif-date" aria-hidden="true"><small>DEC</small>6</span><div>
        <p class="rif-kicker">${h(t.day_when)}</p><h2>${h(t.day_title)}</h2><p>${para(t.day_text)}</p></div></section>
      <section class="card"><h2>How it works</h2>
        <ol class="rif-steps">
          <li><b>Donate</b><span>${para(t.dropoff)}</span></li>
          <li><b>Apply</b><span>Beginners share their story during the one-week application period.</span></li>
          <li><b>Ride</b><span>Selected women receive their gear on ${h(t.day_title)} (${h(t.day_when)}) and ride with a community cheering them on.</span></li>
        </ol>
        <p style="margin:12px 0 4px"><b>What we collect</b></p><ul class="muted" style="margin:0;padding-left:20px">${COLLECT.map((i) => `<li>${h(i)}</li>`).join("")}</ul></section>
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
    const t = await loadText();
    res.send(pub(req, "Thank you", `<div class="rif"><section class="rif-hero"><h2>Thank you for riding it forward!</h2>
      <p class="rif-sub">Your gear will help a beginner start her cycling journey. ${para(t.dropoff)}</p>
      <p class="rif-sub">Your reference: <b>${h(ref)}</b></p></section>
      <p style="text-align:center"><a href="/ride-it-forward">Back to Ride It Forward</a></p></div>`));
  }));

  // ---------- staff: QR code, link, donations ----------
  app.get("/ride-it-forward/manage", STAFF, wrap(async (req, res) => {
    const d = (await pool.query("SELECT * FROM gear_donations ORDER BY created_at DESC")).rows;
    const apps = (await pool.query("SELECT count(*)::int n, count(*) FILTER (WHERE selection = 'Selected')::int s FROM participation WHERE activity_id = $1 AND voided_at IS NULL", [EVENT])).rows[0];
    const img = await qrDataUrl(link(req));
    const t = await loadText(), tok = await reviewToken();
    const review = `${link(req)}/review/${tok}`;
    const wa = "https://wa.me/?text=" + encodeURIComponent("Hi, here is the Ride It Forward page for your review. You can edit the text and approve it here: " + review);
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
        </tbody></table></div></section>
      <section class="card c8"><div class="card-head"><div><h2>Page text</h2><p class="lead">Edit what people see on the page. ${status(t)}</p></div>
        <a class="btn" href="/ride-it-forward" target="_blank" rel="noopener">View page ↗</a></div>
        ${textForm(t, "/ride-it-forward/text")}</section>
      <section class="card c4"><h2>Manager review</h2>
        <p class="lead">Send this link to your manager. She can edit the text and approve the page, no sign-in needed.</p>
        <p style="word-break:break-all"><a href="${h(review)}">${h(review)}</a></p>
        <a class="btn primary" href="${h(wa)}" target="_blank" rel="noopener">Send by WhatsApp ↗</a>
        <p style="margin:12px 0 0">${status(t)}</p>
        ${t.edited_by ? `<p class="muted" style="margin:6px 0 0">Last edit: ${h(t.edited_by)} · ${fmtTs(t.edited_at)}</p>` : ""}</section>
      </div>`, { active: "/ride-it-forward/manage" }));
  }));
  app.post("/ride-it-forward/text", STAFF, wrap(async (req, res) => {
    const before = await loadText();
    const next = await saveText({ ...readText(req.body), edited_by: actor(req), edited_at: new Date().toISOString() });
    await audit(pool, actor(req), "rif.text", "settings", "rideItForward", before, next, null);
    res.redirect("/ride-it-forward/manage");
  }));

  // ---------- manager review link: edit + approve ----------
  const reviewOk = async (tok) => {
    const t = await loadText();
    return t.token && typeof tok === "string" && tok.length === t.token.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(t.token)) ? t : null;
  };
  const closedLink = (req) => (res) => res.status(404).send(pub(req, "Review", `<section class="card"><h2>This link doesn't work</h2><p class="lead">Ask the WMF team to send it again.</p></section>`));
  app.get("/ride-it-forward/review/:tok", wrap(async (req, res) => {
    const t = await reviewOk(req.params.tok);
    if (!t) return closedLink(req)(res);
    const base = "/ride-it-forward/review/" + encodeURIComponent(req.params.tok);
    res.set("Cache-Control", "no-store").send(pub(req, "Review Ride It Forward", `<section class="card" style="display:grid;gap:10px">
      <h2>Review: Ride It Forward</h2>
      <p class="lead">Check the page, change any text below, then approve it. ${status(t)}</p>
      <p><a class="btn" href="/ride-it-forward" target="_blank" rel="noopener">Open the page ↗</a></p></section>
      <section class="card"><h2>Edit and approve</h2>${textForm(t, base, `<label>Your name<input name="who" required maxlength="80" value="${h(t.approved_by || "")}"></label>`,
        `<button class="btn">Save changes</button><button class="btn primary" name="approve" value="1">Save & approve</button>`)}</section>`));
  }));
  app.post("/ride-it-forward/review/:tok", limit("rifreview", 30, 60 * 60e3), wrap(async (req, res) => {
    const t = await reviewOk(req.params.tok);
    if (!t) return closedLink(req)(res);
    const who = R.clean(req.body.who).slice(0, 80) || "Manager";
    const now = Date.now();
    const next = await saveText({ ...readText(req.body), edited_by: who + " (review link)", edited_at: new Date(now).toISOString(),
      ...(req.body.approve ? { approved_by: who, approved_at: new Date(now + 1).toISOString() } : {}) });
    await audit(pool, who + " (review link)", req.body.approve ? "rif.approve" : "rif.text", "settings", "rideItForward", t, next, null);
    if (!req.body.approve) return res.redirect("/ride-it-forward/review/" + encodeURIComponent(req.params.tok));
    res.send(pub(req, "Approved", `<div class="rif"><section class="rif-hero"><h2>Thank you, ${h(who)}!</h2>
      <p class="rif-sub">The Ride It Forward page is approved. The WMF team can see your approval in the Hub.</p></section>
      <p style="text-align:center"><a href="/ride-it-forward">See the page</a></p></div>`));
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
