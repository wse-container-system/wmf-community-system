"use strict";
/** Rides & events page, event settings (including price and payment link), and each event's sign-up list. */
const { pool, tx, audit } = require("./db");
const { syncHeldEvents } = require("./activations");
const R = require("./rules");
const { h, fmtDate, fmtTs } = require("./views");

const LOCS = ["Abu Dhabi", "Dubai", "Other"];
const money = (n) => (Number(n) > 0 ? "AED " + Number(n).toLocaleString("en-GB", { maximumFractionDigits: 2 }) : "Free");
const PAY = ["Unpaid", "Paid", "Refunded", "Waived"];
const { CATEGORIES } = require("./activations");
function readEvent(b, a = {}) {
  const url = R.clean(b.payment_url), strava = R.clean(b.strava_url);
  if (url && !/^https:\/\//i.test(url)) return { err: "The payment link must start with https://" };
  if (strava && !/^https:\/\/(www\.)?strava\.(com|app\.link)\//i.test(strava)) return { err: "The Strava link must be a strava.com link (copy it from the Strava club event)." };
  const price = b.price_aed === "" || b.price_aed == null ? null : Number(b.price_aed);
  if (price != null && (!Number.isFinite(price) || price < 0 || price > 100000)) return { err: "Check the price." };
  return { row: {
    name: R.clean(b.name) || a.name, location: LOCS.includes(b.location) ? b.location : a.location || "Abu Dhabi",
    event_date: /^\d{4}-\d{2}-\d{2}$/.test(b.event_date || "") ? b.event_date : null, capacity: +b.capacity > 0 ? +b.capacity : null,
    registration_open: !!b.registration_open, notes: R.clean(b.notes) || null, price_aed: price > 0 ? price : null, payment_url: url || null,
    status: b.status === "Inactive" ? "Inactive" : "Active", strava_url: strava || null,
    partners: String(b.partners || "").split(",").map(R.clean).filter(Boolean).join(", ") || null,
    category: CATEGORIES.includes(b.category) ? b.category : a.category && CATEGORIES.includes(a.category) ? a.category : "Themed Community Rides",
  } };
}
function eventFields(a = {}) {
  return `<label>Name<input name="name" required maxlength="140" value="${h(a.name)}"></label>
    <div class="row2"><label>Date<input type="date" name="event_date" value="${h(a.event_date || "")}"></label>
      <label>Location<select name="location">${LOCS.map((l) => `<option ${a.location === l ? "selected" : ""}>${l}</option>`).join("")}</select></label></div>
    <div class="row2"><label>Capacity <span class="hint">(blank = no limit)</span><input type="number" min="0" name="capacity" value="${h(a.capacity || "")}"></label>
      <label>Status<select name="status">${["Active", "Inactive"].map((x) => `<option ${a.status === x ? "selected" : ""}>${x}</option>`).join("")}</select></label></div>
    <label>Notes shown on the sign-up page<input name="notes" maxlength="300" value="${h(a.notes)}"></label>
    <label>Strava link <span class="hint">(the Strava club event, so people can join it there too)</span><input type="url" name="strava_url" maxlength="400" placeholder="https://www.strava.com/clubs/…/group_events/…" value="${h(a.strava_url)}"></label>
    <div class="row2"><label>Type <span class="hint">(for the activation report)</span><select name="category">${CATEGORIES.map((c) => `<option ${(a.category || "Themed Community Rides") === c ? "selected" : ""}>${h(c)}</option>`).join("")}</select></label>
      <label>Partners / collaborations <span class="hint">(comma-separated)</span><input name="partners" maxlength="300" value="${h(a.partners)}" placeholder="e.g. Colnago Caffè, RM Hub Wellness"></label></div>
    <fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend style="font-weight:600;color:var(--ink-2);font-size:14px">Payment (paid events only)</legend>
      <div class="row2"><label>Price in AED <span class="hint">(blank or 0 = free)</span><input type="number" min="0" step="0.01" name="price_aed" value="${h(a.price_aed || "")}"></label>
        <label>Payment link <span class="hint">(Ziina, Stripe, bank page… must start with https://)</span><input type="url" name="payment_url" maxlength="400" value="${h(a.payment_url)}"></label></div>
      <p class="hint" style="margin:6px 0 0">After signing up, people see a “Pay now” button that opens this link. Mark each person as Paid on the sign-up list when the money arrives.</p></fieldset>
    <label class="check"><input type="checkbox" name="registration_open" value="1" ${a.registration_open ? "checked" : ""}> <span>Public sign-up open</span></label>`;
}

module.exports = function events(app, { need, page, setFlash, actor, wrap }) {
  const STAFF = need("admin", "coordinator");

  app.get("/activities", STAFF, wrap(async (req, res) => {
    await syncHeldEvents(actor(req));
    const r = await pool.query(`SELECT a.*,
        (SELECT count(*) FROM participation p WHERE p.activity_id = a.activity_id AND p.voided_at IS NULL) AS n,
        (SELECT count(*) FROM participation p WHERE p.activity_id = a.activity_id AND p.voided_at IS NULL AND p.payment_status = 'Paid') AS paid,
        (SELECT min(id) FROM activations x WHERE x.activity_id = a.activity_id) AS activation_id
      FROM activities a ORDER BY a.core DESC, a.sort_order, a.event_date DESC NULLS LAST, a.name`);
    const core = r.rows.filter((a) => a.core), evs = r.rows.filter((a) => a.kind === "event"), old = r.rows.filter((a) => a.kind !== "event" && !a.core);
    const today = R.todayLocal();
    const upcoming = evs.filter((e) => !e.event_date || e.event_date >= today), past = evs.filter((e) => e.event_date && e.event_date < today);
    const evRow = (e) => `<tr><td><a href="/activities/${encodeURIComponent(e.activity_id)}"><b>${h(e.name)}</b></a>${e.status !== "Active" ? ' <span class="badge">Inactive</span>' : ""}${e.strava_url ? ' <span class="badge">Strava</span>' : ""}
        <br><a class="btn tblbtn" href="/activities/${encodeURIComponent(e.activity_id)}">Edit</a>${e.activation_id ? ` <a class="btn tblbtn" href="/activations/${e.activation_id}">Activation</a>` : ""}</td>
      <td>${fmtDate(e.event_date)}</td><td>${h(money(e.price_aed))}</td>
      <td class="n"><a href="/activities/${encodeURIComponent(e.activity_id)}/signups">${e.n}${e.capacity ? " / " + e.capacity : ""}</a>${Number(e.price_aed) > 0 ? `<br><span class="muted">${e.paid} paid</span>` : ""}</td>
      <td>${e.registration_open ? `<span class="badge good">Open</span> <a href="/events/${encodeURIComponent(e.activity_id)}">Public page</a>` : `<span class="badge">Closed</span>`}</td></tr>`;
    const evTable = (rows) => `<div class="tw"><table><thead><tr><th>Event</th><th>Date</th><th>Fee</th><th class="n">Sign-ups</th><th>Sign-up</th></tr></thead><tbody>${rows.map(evRow).join("") || `<tr><td colspan="5" class="muted">None.</td></tr>`}</tbody></table></div>`;
    res.send(page(req, "Events & rides", `<div class="grid">
      <section class="card c8"><h2>Upcoming events</h2><p class="lead">Edit an event to change its date, fee, Strava link or partners. The sign-up count opens the list of people: tick who came. Once the date has passed, the event moves to <a href="/activations">Activations</a> by itself with its sign-ups, attendance and partners.</p>${evTable(upcoming)}
        <details style="margin-top:12px"><summary><b>Past events (${past.length})</b></summary>${evTable(past)}</details></section>
      <section class="card c4"><h2>Add an event</h2><p class="lead">Events added on the <a href="/calendar/manage">calendar</a> appear here automatically.</p>
        <form class="form" method="post" action="/activities">${eventFields({ location: "Abu Dhabi", status: "Active" })}<button class="btn primary">Add event</button></form></section>
      <section class="card c12"><h2>Rides</h2><p class="lead">The scanner offers these six rides. <a href="/rides">See attendance per ride</a>.</p>
        <div class="tw"><table><thead><tr><th>Ride</th><th class="n">Check-ins (all time)</th></tr></thead><tbody>${core.map((a) => `<tr><td><b>${h(a.name)}</b></td><td class="n">${a.n}</td></tr>`).join("")}</tbody></table></div>
        <details style="margin-top:12px"><summary>Older ride names from the workbook (${old.length}), kept for history</summary>
          <div class="tw"><table><tbody>${old.map((a) => `<tr><td>${h(a.name)} <span class="muted">${h(a.activity_id)}</span></td><td class="n">${a.n}</td></tr>`).join("")}</tbody></table></div></details></section>
    </div>`, { active: "/activities" }));
  }));

  app.post("/activities", STAFF, wrap(async (req, res) => {
    const f = readEvent(req.body);
    if (f.err || !f.row.name) { setFlash(req, "err", f.err || "Enter a name."); return res.redirect("/activities"); }
    const base = "ACT-" + f.row.name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const id = await tx(async (c) => {
      let aid = base;
      for (let i = 2; (await c.query("SELECT 1 FROM activities WHERE activity_id = $1", [aid])).rows[0]; i++) aid = `${base}-${i}`;
      const row = { activity_id: aid, kind: "event", activity_type: "Event Registration", category: "Community Activation", ...f.row };
      const cols = Object.keys(row);
      await c.query(`INSERT INTO activities (${cols}) VALUES (${cols.map((_, j) => "$" + (j + 1))})`, cols.map((k) => row[k]));
      await audit(c, actor(req), "activity.create", "activity", aid, null, row);
      return aid;
    });
    setFlash(req, "ok", `Added ${f.row.name}.`);
    res.redirect("/activities/" + encodeURIComponent(id));
  }));

  app.get("/activities/:id", STAFF, wrap(async (req, res) => {
    const a = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [req.params.id])).rows[0];
    if (!a || a.kind !== "event") return res.redirect("/activities");
    const act = (await pool.query("SELECT id FROM activations WHERE activity_id = $1 ORDER BY id LIMIT 1", [a.activity_id])).rows[0];
    res.send(page(req, a.name, `<section class="card"><div class="card-head"><div><h2>${h(a.name)}</h2><p class="lead">${h(a.activity_id)}</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/activities/${encodeURIComponent(a.activity_id)}/signups">Sign-ups</a>${act ? `<a class="btn" href="/activations/${act.id}">Activation report</a>` : ""}${a.registration_open ? `<a class="btn" href="/events/${encodeURIComponent(a.activity_id)}">Public page</a>` : ""}</div></div>
      <form class="form" method="post" action="/activities/${encodeURIComponent(a.activity_id)}">${eventFields(a)}<button class="btn primary">Save</button></form></section>`, { active: "/activities", wide: false }));
  }));
  app.post("/activities/:id", STAFF, wrap(async (req, res) => {
    const back = "/activities/" + encodeURIComponent(req.params.id);
    const err = await tx(async (c) => {
      const a = (await c.query("SELECT * FROM activities WHERE activity_id = $1 FOR UPDATE", [req.params.id])).rows[0];
      if (!a || a.kind !== "event") return "Event not found.";
      const f = readEvent(req.body, a);
      if (f.err) return f.err;
      const keys = Object.keys(f.row);
      await c.query(`UPDATE activities SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE activity_id = $1`, [a.activity_id, ...keys.map((k) => f.row[k])]);
      // a calendar entry linked to this event follows its name and date
      await c.query("UPDATE calendar_items SET title = $2, start_date = coalesce($3, start_date), end_date = GREATEST(end_date, coalesce($3, start_date)), updated_at = now() WHERE activity_id = $1", [a.activity_id, f.row.name, f.row.event_date]);
      await audit(c, actor(req), "activity.update", "activity", a.activity_id, Object.fromEntries(keys.map((k) => [k, a[k]])), f.row);
      return null;
    });
    setFlash(req, err ? "err" : "ok", err || "Saved.");
    res.redirect(back);
  }));

  // ---------- sign-ups and payments ----------
  async function signups(id) {
    return (await pool.query(`SELECT p.*, m.full_name, m.primary_email, m.mobile FROM participation p LEFT JOIN members m ON m.member_id = p.member_id
      WHERE p.activity_id = $1 AND p.voided_at IS NULL ORDER BY p.record_date, p.id`, [id])).rows;
  }
  app.get("/activities/:id/signups", STAFF, wrap(async (req, res) => {
    const a = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [req.params.id])).rows[0];
    if (!a) return res.redirect("/activities");
    const rows = await signups(a.activity_id);
    const paid = Number(a.price_aed) > 0;
    const count = (s) => rows.filter((r) => (r.payment_status || "") === s).length;
    const collected = count("Paid") * Number(a.price_aed || 0);
    res.send(page(req, "Sign-ups", `<section class="card">
      <div class="card-head"><div><h2>${h(a.name)}</h2><p class="lead">${fmtDate(a.event_date)} · ${h(money(a.price_aed))}${a.capacity ? ` · capacity ${a.capacity}` : ""}</p></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="btn" href="/activities/${encodeURIComponent(a.activity_id)}">Event settings</a><a class="btn" href="/activities/${encodeURIComponent(a.activity_id)}/signups.csv">Download list (CSV)</a></div></div>
      <div class="tiles" style="margin:6px 0 14px">
        <div class="tile"><span class="lbl">Signed up</span><span class="val">${rows.length}</span></div>
        <div class="tile"><span class="lbl">Came</span><span class="val">${rows.filter((r) => r.status === "Attended").length}</span></div>
        ${paid ? `<div class="tile"><span class="lbl">Paid</span><span class="val">${count("Paid")}</span></div>
        <div class="tile ${count("Unpaid") ? "attn" : ""}"><span class="lbl">Not paid yet</span><span class="val">${count("Unpaid")}</span></div>
        <div class="tile"><span class="lbl">Collected</span><span class="val">${h(money(collected))}</span><span class="note">Paid × fee</span></div>` : ""}
      </div>
      <p class="lead" style="margin:0 0 8px">After the event, tick who came: the attendance goes to the activation report.</p>
      <div class="tw"><table><thead><tr><th>#</th><th>Member</th><th>Contact</th><th>Signed up</th><th>Came</th>${paid ? "<th>Payment</th>" : ""}</tr></thead><tbody>
      ${rows.map((r, i) => `<tr><td>${i + 1}</td><td><a href="/members/${encodeURIComponent(r.member_id || "")}">${h(r.full_name || r.member_name || "—")}</a><br><span class="muted">${h(r.member_id || "")} · ${h(r.record_id || "")}</span></td>
        <td>${h(R.maskEmail(r.primary_email || r.member_email) || "—")}<br><span class="muted">${h(R.maskPhone(r.mobile || r.phone))}</span></td><td>${fmtDate(r.record_date)}</td>
        <td><form method="post" action="/participation/${r.id}/attended" style="margin:0"><button class="btn tblbtn ${r.status === "Attended" ? "primary" : ""}" name="came" value="${r.status === "Attended" ? "0" : "1"}" aria-pressed="${r.status === "Attended"}">${r.status === "Attended" ? "✓ Came" : "Mark came"}</button></form></td>
        ${paid ? `<td><form method="post" action="/participation/${r.id}/payment" class="toolbar" style="margin:0;align-items:center">
          <select class="inp" name="status" style="width:auto;min-height:32px;font-size:14px">${PAY.map((s) => `<option ${(r.payment_status || "Unpaid") === s ? "selected" : ""}>${s}</option>`).join("")}</select>
          <input class="inp" name="note" value="${h(r.payment_note || "")}" placeholder="Ref / note" style="max-width:140px;min-height:32px;font-size:13px">
          <button class="btn tblbtn">Save</button></form>${r.paid_at ? `<span class="muted" style="font-size:12px">Paid ${fmtTs(r.paid_at)}</span>` : ""}</td>` : ""}</tr>`).join("") || `<tr><td colspan="5" class="muted">No sign-ups yet.</td></tr>`}
      </tbody></table></div></section>`, { active: "/activities" }));
  }));
  app.get("/activities/:id/signups.csv", STAFF, wrap(async (req, res) => {
    const rows = await signups(req.params.id);
    const q = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const csv = [["Reference", "Member ID", "Name", "Signed up", "Payment", "Payment note"].map(q).join(",")]
      .concat(rows.map((r) => [r.record_id, r.member_id, r.full_name || r.member_name, String(r.record_date).slice(0, 16).replace("T", " "), r.payment_status || "", r.payment_note || ""].map(q).join(",")));
    await audit(pool, actor(req), "signups.download", "activity", req.params.id, null, { rows: rows.length }, null);
    res.type("text/csv").set("Content-Disposition", `attachment; filename="signups-${req.params.id}.csv"`).send("﻿" + csv.join("\r\n"));
  }));
  app.post("/participation/:id/attended", STAFF, wrap(async (req, res) => {
    const p = (await pool.query("SELECT * FROM participation WHERE id = $1 AND record_type = 'Event Registration' AND voided_at IS NULL", [+req.params.id])).rows[0];
    if (!p) return res.redirect("/activities");
    const status = req.body.came === "1" ? "Attended" : "Registered";
    await tx(async (c) => {
      await c.query("UPDATE participation SET status = $2 WHERE id = $1", [p.id, status]);
      await audit(c, actor(req), "event.attended", "participation", p.record_id, { status: p.status }, { status });
    });
    res.redirect("/activities/" + encodeURIComponent(p.activity_id) + "/signups");
  }));
  app.post("/participation/:id/payment", STAFF, wrap(async (req, res) => {
    const status = PAY.includes(req.body.status) ? req.body.status : null;
    const p = (await pool.query("SELECT * FROM participation WHERE id = $1", [+req.params.id])).rows[0];
    if (!p || !status) return res.redirect("/activities");
    await tx(async (c) => {
      await c.query(`UPDATE participation SET payment_status = $2, payment_note = $3, paid_at = CASE WHEN $2 = 'Paid' THEN coalesce(paid_at, now()) ELSE NULL END WHERE id = $1`,
        [p.id, status, R.clean(req.body.note) || null]);
      await audit(c, actor(req), "payment.update", "participation", p.record_id, { status: p.payment_status, note: p.payment_note }, { status, note: R.clean(req.body.note) || null });
    });
    setFlash(req, "ok", `${p.record_id}: ${status}.`);
    res.redirect("/activities/" + encodeURIComponent(p.activity_id) + "/signups");
  }));
};
