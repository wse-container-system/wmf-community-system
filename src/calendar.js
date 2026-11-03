"use strict";
/**
 * WMF calendar inside the app. WMF rides on the calendar tell the scanner which ride is on today;
 * WMF events on the calendar are linked to an event in the app, so sign-up opens from the calendar.
 */
const path = require("path");
const fs = require("fs");
const { pool, tx, audit } = require("./db");
const R = require("./rules");
const C = require("../public/calendar-core");
const { h, fmtDate } = require("./views");

const CATS = { wmf_ride: "WMF Ride", wmf_event: "WMF Event", generic_event: "Other event / key date", track_closure: "Track closure" };
const STATUSES = ["Confirmed", "Tentative", "Cancelled", "Completed"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Rows in the shape the calendar page uses (same as the original WMF calendar). */
function toItem(row, act) {
  const it = { id: row.id, t: row.title, c: row.category, s: row.start_date, e: row.end_date, st: row.start_time || "", et: row.end_time || "",
    loc: row.location || "", status: row.status, r: row.recur || null, x: row.exceptions || null, u: row.url || "", slot: row.ride_slot || null };
  if (act && act.registration_open && act.kind === "event" && act.status === "Active" && (!act.event_date || act.event_date >= R.todayLocal())) it.signup = "/events/" + encodeURIComponent(act.activity_id);
  if (act && Number(act.price_aed) > 0) it.fee = "AED " + Number(act.price_aed).toLocaleString("en-GB", { maximumFractionDigits: 2 });
  return it;
}
async function loadItems(c) {
  const r = await (c || pool).query(`SELECT ci.*, row_to_json(a) AS act FROM calendar_items ci LEFT JOIN activities a ON a.activity_id = ci.activity_id ORDER BY start_date, start_time NULLS LAST, id`);
  return r.rows.map((row) => toItem(row, row.act));
}
/** WMF rides on the calendar for one day, with the scanner ride each belongs to. */
async function ridesOn(date) {
  const items = (await loadItems()).filter((a) => a.slot);
  return C.on(items, date).filter((o) => !o.cancel).map((o) => ({ title: o.a.t, time: o.a.st, location: o.a.loc, slot: o.a.slot }));
}

/** Keep the linked app event in step with its calendar entry. */
async function syncEvent(c, item, actor, { open, capacity, price, paymentUrl } = {}) {
  if (item.category !== "wmf_event") return item.activity_id || null;
  let id = item.activity_id;
  if (!id) {
    const base = "EVT-" + item.title.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) + "-" + item.start_date.slice(0, 7);
    id = base;
    for (let i = 2; (await c.query("SELECT 1 FROM activities WHERE activity_id = $1", [id])).rows[0]; i++) id = `${base}-${i}`;
    await c.query(`INSERT INTO activities (activity_id, name, activity_type, category, kind, location, event_date, status, registration_open, capacity, price_aed, payment_url)
      VALUES ($1,$2,'Event Registration','Community Activation','event',$3,$4,'Active',$5,$6,$7,$8)`,
    [id, item.title, /dubai|dxb/i.test(item.location || "") ? "Dubai" : "Abu Dhabi", item.start_date, !!open, capacity || null, price || null, paymentUrl || null]);
    await audit(c, actor, "activity.create", "activity", id, null, { from: "calendar", title: item.title });
  } else {
    const sets = ["name = $2", "event_date = $3", "status = $4"], args = [id, item.title, item.start_date, item.status === "Cancelled" ? "Inactive" : "Active"];
    if (open !== undefined) {
      args.push(!!open); sets.push(`registration_open = $${args.length}`); args.push(capacity || null); sets.push(`capacity = $${args.length}`);
      args.push(price || null); sets.push(`price_aed = $${args.length}`); args.push(paymentUrl || null); sets.push(`payment_url = $${args.length}`);
    }
    await c.query(`UPDATE activities SET ${sets.join(", ")} WHERE activity_id = $1`, args);
  }
  return id;
}

/** First start: load the entries from the WMF calendar artifact (1 Nov 2026). Runs once. */
async function seed() {
  const done = (await pool.query("SELECT 1 FROM settings WHERE key = 'calendarSeeded'")).rows[0];
  if (done) return;
  const file = path.join(__dirname, "..", "data", "calendar-seed.json");
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  await tx(async (c) => {
    await R.ensureCoreRides(c);
    const today = R.todayLocal();
    for (const a of data) {
      const row = { title: a.t, category: a.c, start_date: a.s, end_date: a.e || a.s, start_time: a.st || null, end_time: a.et || null, location: a.loc || null,
        status: a.status || "Confirmed", recur: a.r ? JSON.stringify(a.r) : null, exceptions: a.x ? JSON.stringify(a.x) : null, url: a.u || null,
        ride_slot: a.c === "wmf_ride" || /mountain ride/i.test(a.t) ? R.slotForTitle(a.t) : null, activity_id: null };
      if (a.c === "wmf_event" && (a.e || a.s) >= today) row.activity_id = await syncEvent(c, row, "system");
      const cols = Object.keys(row);
      await c.query(`INSERT INTO calendar_items (${cols}) VALUES (${cols.map((_, i) => "$" + (i + 1))})`, cols.map((k) => row[k]));
    }
    await c.query("INSERT INTO settings (key, value) VALUES ('calendarSeeded', $1)", [JSON.stringify({ at: new Date().toISOString(), items: data.length })]);
    await audit(c, "system", "calendar.seed", "calendar", null, null, { items: data.length }, "Loaded from the WMF calendar artifact");
  });
}

module.exports = function calendar(app, { need, page, setFlash, actor, wrap }) {
  const STAFF = need("admin", "coordinator");

  // ---------- public calendar ----------
  app.get("/api/calendar.json", wrap(async (req, res) => {
    const items = (await loadItems()).map(({ id, slot, ...rest }) => rest); // eslint-disable-line no-unused-vars
    res.set("Cache-Control", "public, max-age=60").json({ updated: R.nowLocal(), items });
  }));
  app.get("/calendar", (req, res) => {
    res.send(page(req, "Calendar", `
      <section class="wc" aria-label="WMF calendar">
        <header class="wc-top">
          <div><div class="wc-eyebrow">Community ride calendar</div>
            <div class="wc-monthrow"><button class="wc-nav" id="wc-prev" aria-label="Previous month">‹</button><h2 class="wc-month" id="wc-month" aria-live="polite"></h2><button class="wc-nav" id="wc-next" aria-label="Next month">›</button><button class="wc-today" id="wc-today">This month</button></div></div>
          <div class="wc-legend"><span class="wc-chip c-wmf_ride"><i></i>WMF Ride</span><span class="wc-chip c-wmf_event"><i></i>WMF Event</span><span class="wc-chip c-generic_event"><i></i>Other events &amp; key dates</span><span class="wc-chip c-track_closure"><i></i>Track closures</span></div>
        </header>
        <div class="wc-cal"><div class="wc-dow"><div>MON</div><div>TUE</div><div>WED</div><div>THU</div><div>FRI</div><div>SAT</div><div>SUN</div></div>
          <div class="wc-grid" id="wc-grid"></div><div class="wc-agenda" id="wc-agenda"></div></div>
        <p class="muted" style="font-size:13px;margin:10px 0 0">Outlined = time or date to be confirmed. Plans can change, so check before you ride.${req.session.user && ["admin", "coordinator"].includes(req.session.user.role) ? ` · <a href="/calendar/manage">Edit the calendar</a>` : ""}</p>
      </section>
      <div class="wc-pop" id="wc-pop" hidden role="dialog" aria-modal="true" aria-labelledby="wc-pop-title"><div class="wc-scrim" data-close></div>
        <div class="wc-card"><div class="wc-head" id="wc-pop-head"><button class="wc-x" data-close aria-label="Close">×</button><div class="wc-eyebrow" id="wc-pop-cat"></div><h2 id="wc-pop-title"></h2></div>
          <dl id="wc-pop-body"></dl><div class="wc-actions" id="wc-pop-actions"></div></div></div>`,
    { active: "/calendar", scripts: `<script src="/calendar-core.js"></script><script src="/calendar.js"></script>` }));
  });

  // ---------- staff: manage entries ----------
  app.get("/calendar/manage", STAFF, wrap(async (req, res) => {
    const r = await pool.query(`SELECT ci.*, a.registration_open FROM calendar_items ci LEFT JOIN activities a ON a.activity_id = ci.activity_id
      ORDER BY (coalesce((ci.recur->>'until')::date, ci.end_date) < $1::date), ci.start_date, ci.id`, [R.todayLocal()]);
    const slotName = Object.fromEntries(R.CORE_RIDES.map((x) => [x.activity_id, x.name]));
    const repeat = (x) => x.recur ? `Every ${x.recur.interval > 1 ? x.recur.interval + " weeks, " : ""}${(x.recur.weekdays || []).map((d) => DAYS[d]).join(", ")}${x.recur.until ? " until " + fmtDate(x.recur.until) : ""}` : "";
    res.send(page(req, "Edit calendar", `<section class="card">
      <div class="card-head"><div><h2>WMF calendar</h2><p class="lead">WMF rides tell the scanner which ride is on each day. WMF events get a sign-up page you can open from here.</p></div>
        <div style="display:flex;gap:8px"><a class="btn" href="/calendar">View calendar</a><a class="btn primary" href="/calendar/items/new">Add entry</a></div></div>
      <div class="tw"><table><thead><tr><th>When</th><th>Entry</th><th>Type</th><th>Scanner ride / sign-up</th><th>Status</th></tr></thead><tbody>
      ${r.rows.map((x) => `<tr><td>${fmtDate(x.start_date)}${x.end_date !== x.start_date ? " – " + fmtDate(x.end_date) : ""}${x.start_time ? "<br><span class='muted'>" + h(x.start_time) + "</span>" : ""}</td>
        <td><a href="/calendar/items/${x.id}"><b>${h(x.title)}</b></a>${x.location ? "<br><span class='muted'>" + h(x.location) + "</span>" : ""}${x.recur ? "<br><span class='muted'>" + h(repeat(x)) + "</span>" : ""}</td>
        <td>${h(CATS[x.category])}</td>
        <td>${x.ride_slot ? `<span class="badge">${h(slotName[x.ride_slot] || x.ride_slot)}</span>` : ""}${x.activity_id ? (x.registration_open ? `<span class="badge good">Sign-up open</span>` : `<span class="badge">Sign-up closed</span>`) : ""}</td>
        <td>${h(x.status)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No entries yet.</td></tr>`}
      </tbody></table></div></section>`, { active: "/calendar" }));
  }));

  function form(x, act) {
    const r = x.recur || {};
    const wd = new Set(r.weekdays || []);
    const ex = Object.keys(x.exceptions || {}).filter((d) => x.exceptions[d] === "cancelled").join(", ");
    return `<section class="card"><h2>${x.id ? "Edit entry" : "Add a calendar entry"}</h2>
      <form class="form" method="post" action="/calendar/items/${x.id || "new"}">
        <label>Title<input name="title" required maxlength="140" value="${h(x.title)}"></label>
        <div class="row2"><label>Type<select name="category">${Object.entries(CATS).map(([k, l]) => `<option value="${k}" ${x.category === k ? "selected" : ""}>${l}</option>`).join("")}</select></label>
          <label>Status<select name="status">${STATUSES.map((s) => `<option ${x.status === s ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>
        <div class="row2"><label>Start date<input type="date" name="start_date" required value="${h(x.start_date)}"></label><label>End date <span class="hint">(multi-day only)</span><input type="date" name="end_date" value="${h(x.end_date !== x.start_date ? x.end_date : "")}"></label></div>
        <div class="row2"><label>Start time<input type="time" name="start_time" value="${h(x.start_time)}"></label><label>End time<input type="time" name="end_time" value="${h(x.end_time)}"></label></div>
        <label>Location<input name="location" maxlength="120" value="${h(x.location)}"></label>
        <fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend style="font-weight:600;color:var(--ink-2);font-size:14px">Repeats</legend>
          <div style="display:flex;flex-wrap:wrap;gap:6px 14px">${DAYS.map((d, i) => `<label class="check" style="display:inline-flex"><input type="checkbox" name="weekdays" value="${i}" ${wd.has(i) ? "checked" : ""}> ${d}</label>`).join("")}</div>
          <div class="row2" style="margin-top:8px"><label>Every<select name="interval">${[1, 2, 3, 4].map((n) => `<option value="${n}" ${(r.interval || 1) === n ? "selected" : ""}>${n === 1 ? "week" : n + " weeks"}</option>`).join("")}</select></label>
            <label>Until <span class="hint">(blank = no end)</span><input type="date" name="until" value="${h(r.until || "")}"></label></div>
          <label style="margin-top:8px">Cancelled dates <span class="hint">(e.g. 2026-11-09, 2026-11-16)</span><input name="cancelled" value="${h(ex)}"></label>
          <p class="hint" style="margin:6px 0 0">Tick no days for a one-off entry.</p></fieldset>
        <label>Scanner ride <span class="hint">(WMF rides: which ride ride leads check people in to)</span><select name="ride_slot"><option value="">None</option>${R.CORE_RIDES.map((s) => `<option value="${s.activity_id}" ${x.ride_slot === s.activity_id ? "selected" : ""}>${h(s.name)}</option>`).join("")}</select></label>
        <label>Join link <span class="hint">(optional, e.g. Strava)</span><input name="url" type="url" maxlength="300" value="${h(x.url)}"></label>
        <fieldset style="border:1px solid var(--line);border-radius:10px;padding:10px 12px"><legend style="font-weight:600;color:var(--ink-2);font-size:14px">WMF events: sign-up</legend>
          <label class="check"><input type="checkbox" name="open" value="1" ${act && act.registration_open ? "checked" : ""}> <span>Open public sign-up (shows a Sign up button on the calendar)</span></label>
          <label>Capacity <span class="hint">(optional)</span><input type="number" min="0" name="capacity" value="${h(act && act.capacity ? act.capacity : "")}"></label>
          <div class="row2"><label>Price in AED <span class="hint">(blank = free)</span><input type="number" min="0" step="0.01" name="price_aed" value="${h(act && act.price_aed ? act.price_aed : "")}"></label>
            <label>Payment link <span class="hint">(https://…)</span><input type="url" name="payment_url" maxlength="400" value="${h(act && act.payment_url ? act.payment_url : "")}"></label></div>
          ${act ? `<p class="hint" style="margin:6px 0 0">Linked event: <a href="/events/${encodeURIComponent(act.activity_id)}">${h(act.activity_id)}</a></p>` : ""}</fieldset>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn primary">Save</button><a class="btn" href="/calendar/manage">Cancel</a></div>
      </form>
      ${x.id ? `<form method="post" action="/calendar/items/${x.id}/delete" style="margin-top:14px"><button class="btn danger">Delete this entry</button></form>` : ""}</section>`;
  }
  app.get("/calendar/items/new", STAFF, (req, res) => res.send(page(req, "Add entry", form({ title: "", category: "wmf_ride", status: "Confirmed", start_date: R.todayLocal(), end_date: R.todayLocal() }), { active: "/calendar", wide: false })));
  app.get("/calendar/items/:id", STAFF, wrap(async (req, res) => {
    const x = (await pool.query("SELECT * FROM calendar_items WHERE id = $1", [+req.params.id || 0])).rows[0];
    if (!x) return res.redirect("/calendar/manage");
    const act = x.activity_id ? (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [x.activity_id])).rows[0] : null;
    res.send(page(req, "Edit entry", form(x, act), { active: "/calendar", wide: false }));
  }));

  function readForm(b) {
    const title = R.clean(b.title), start = b.start_date, end = b.end_date || b.start_date;
    if (!title) return { err: "Enter a title." };
    if (!DATE_RE.test(start || "") || !DATE_RE.test(end) || end < start) return { err: "Check the dates." };
    for (const t of [b.start_time, b.end_time]) if (t && !TIME_RE.test(t)) return { err: "Check the times." };
    if (b.url && !/^https?:\/\//i.test(b.url)) return { err: "The link must start with https://" };
    if (b.payment_url && !/^https:\/\//i.test(b.payment_url)) return { err: "The payment link must start with https://" };
    const weekdays = [].concat(b.weekdays || []).map(Number).filter((n) => n >= 0 && n <= 6);
    const exceptions = {};
    for (const d of String(b.cancelled || "").split(/[,\s]+/).filter(Boolean)) { if (!DATE_RE.test(d)) return { err: `"${d}" is not a date (use 2026-11-09).` }; exceptions[d] = "cancelled"; }
    const category = CATS[b.category] ? b.category : "wmf_ride";
    return { row: {
      title, category, start_date: start, end_date: weekdays.length ? start : end, start_time: b.start_time || null, end_time: b.end_time || null,
      location: R.clean(b.location) || null, status: STATUSES.includes(b.status) ? b.status : "Confirmed",
      recur: weekdays.length ? JSON.stringify({ freq: "weekly", interval: Math.min(4, Math.max(1, +b.interval || 1)), weekdays, ...(DATE_RE.test(b.until || "") ? { until: b.until } : {}) }) : null,
      exceptions: Object.keys(exceptions).length ? JSON.stringify(exceptions) : null, url: R.clean(b.url) || null,
      ride_slot: R.CORE_RIDES.some((s) => s.activity_id === b.ride_slot) ? b.ride_slot : null,
    }, open: !!b.open, capacity: +b.capacity > 0 ? +b.capacity : null, price: +b.price_aed > 0 ? +b.price_aed : null, paymentUrl: R.clean(b.payment_url) || null };
  }
  app.post("/calendar/items/:id", STAFF, wrap(async (req, res) => {
    const f = readForm(req.body);
    const isNew = req.params.id === "new";
    if (f.err) { setFlash(req, "err", f.err); return res.redirect(isNew ? "/calendar/items/new" : "/calendar/items/" + (+req.params.id)); }
    const id = await tx(async (c) => {
      let before = null, row = { ...f.row };
      if (!isNew) { before = (await c.query("SELECT * FROM calendar_items WHERE id = $1 FOR UPDATE", [+req.params.id])).rows[0]; if (!before) return null; row.activity_id = before.activity_id; }
      if (row.category === "wmf_event") row.activity_id = await syncEvent(c, row, actor(req), { open: f.open, capacity: f.capacity, price: f.price, paymentUrl: f.paymentUrl });
      else if (row.activity_id) { await c.query("UPDATE activities SET registration_open = FALSE WHERE activity_id = $1", [row.activity_id]); }
      const cols = Object.keys(row);
      let newId;
      if (isNew) newId = (await c.query(`INSERT INTO calendar_items (${cols}) VALUES (${cols.map((_, i) => "$" + (i + 1))}) RETURNING id`, cols.map((k) => row[k]))).rows[0].id;
      else { newId = before.id; await c.query(`UPDATE calendar_items SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [newId, ...cols.map((k) => row[k])]); }
      await audit(c, actor(req), isNew ? "calendar.create" : "calendar.update", "calendar", String(newId), before, { ...row, signupOpen: row.category === "wmf_event" ? f.open : undefined });
      return newId;
    });
    setFlash(req, id ? "ok" : "err", id ? "Saved. The calendar and scanner show it straight away." : "Entry not found.");
    res.redirect("/calendar/manage");
  }));
  app.post("/calendar/items/:id/delete", STAFF, wrap(async (req, res) => {
    await tx(async (c) => {
      const x = (await c.query("DELETE FROM calendar_items WHERE id = $1 RETURNING *", [+req.params.id])).rows[0];
      if (x) {
        if (x.activity_id) await c.query("UPDATE activities SET registration_open = FALSE WHERE activity_id = $1", [x.activity_id]);
        await audit(c, actor(req), "calendar.delete", "calendar", String(x.id), x, null);
      }
    });
    setFlash(req, "ok", "Deleted. Any sign-ups already made are kept.");
    res.redirect("/calendar/manage");
  }));
};
module.exports.seed = seed;
module.exports.ridesOn = ridesOn;
module.exports.loadItems = loadItems;
