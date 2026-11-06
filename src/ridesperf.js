"use strict";
/**
 * Rides: Abu Dhabi or Dubai at a glance for a month, quarter or year: participation, rides held,
 * average per ride, new riders, each ride series, and every ride with its turnout.
 */
const R = require("./rules");
const E = require("./engine");
const { buildData } = require("./snapshot");
const CD = require("./corpdata");
const { h, fmtDate, monLabel, nf, detailTiles, mini } = require("./views");
const { columns } = require("./charts");

const H = E.helpers;
const CITIES = { auh: { name: "Abu Dhabi", color: "#5b7cf0" }, dxb: { name: "Dubai", color: "#e8833a" } };
const KIND = { month: "Monthly", quarter: "Quarterly", year: "Annual" };
const pctCh = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);

/** Every ride (date + series) in a city between two days, with its turnout. */
function sessions(P, city, start, end) {
  const out = new Map();
  // each imported or lead-sent ride stays its own line, so a ride entered twice shows up as two lines
  for (const x of P.historyRides) if (x.d >= start && x.d <= end && x.location === city) {
    const k = x.lead ? "l" + x.lid : "h" + (x.hid || x.d + x.series);
    out.set(k, { d: x.d, series: x.series, n: x.attendees || 0, lead: !!x.lead, manual: !!x.manual, src: x.lead ? "l" : "h", id: x.lead ? x.lid : x.hid, label: x.initiative });
  }
  for (const r of P.rows) if (r.kind === "ride" && r.qualifying && !r.coveredByHistory && r.d >= start && r.d <= end && r.location === city) {
    const k = r.d + "|" + r.series, s = out.get(k) || { d: r.d, series: r.series, people: new Set(), src: "q", recs: [] };
    s.people.add(r.person); s.recs.push(r.recordId); out.set(k, s);
  }
  const list = [...out.values()].map((s) => (s.people ? { ...s, n: s.people.size } : s)).sort((a, b) => b.d.localeCompare(a.d) || a.series.localeCompare(b.series));
  // same day and same ride more than once: probably entered twice
  const seen = new Map();
  for (const s of list) { const k = s.d + "|" + s.series.toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); }
  for (const s of list) s.dupe = seen.get(s.d + "|" + s.series.toLowerCase()) > 1;
  return list;
}
const editHref = (s, back, city) => `/wmf/rides/ride?${new URLSearchParams({ ...(s.src === "q" ? { src: "q", d: s.d, recs: s.recs.join(",") } : { src: s.src, id: s.id }), series: s.series, city, back })}`;
const VENUES = {
  "Abu Dhabi": ["Al Hudayriyat Island", "Yas Marina Circuit", "Al Wathba Cycle Track", "Corniche", "Saadiyat Island", "Yas Island", "Jebel Hafeet"],
  Dubai: ["Al Qudra Cycle Track", "Nad Al Sheba Cycle Park", "Meydan", "Dubai Autodrome", "Hatta", "Jumeirah"],
};
/** Suggestions: the usual places plus every place used before. */
async function venueList(pool, city) {
  const used = (await pool.query("SELECT DISTINCT venue FROM ride_venues WHERE city = $1 UNION SELECT venue FROM ride_venue_defaults WHERE city = $1", [city])).rows.map((r) => r.venue);
  return [...new Set([...(VENUES[city] || []), ...used])].sort((a, b) => a.localeCompare(b));
}
const venueField = (list, value, id = "rdVenues") => `<input name="venue" maxlength="80" value="${h(value || "")}" list="${id}" placeholder="e.g. Al Hudayriyat Island" autocomplete="off"><datalist id="${id}">${list.map((v) => `<option value="${h(v)}">`).join("")}</datalist>`;
/** Save where a ride was; "usual" makes it the default for that ride in that city. */
async function saveVenue(c, { d, city, series, venue, usual, by }) {
  venue = R.clean(venue).slice(0, 80);
  if (!d || !city || !series) return;
  if (!venue) { await c.query("DELETE FROM ride_venues WHERE ride_date = $1 AND city = $2 AND series = $3", [d, city, series]); return; }
  await c.query(`INSERT INTO ride_venues (ride_date, city, series, venue, updated_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (ride_date, city, series) DO UPDATE SET venue = EXCLUDED.venue, updated_by = EXCLUDED.updated_by, updated_at = now()`, [d, city, series, venue, by]);
  if (usual) await c.query(`INSERT INTO ride_venue_defaults (city, series, venue) VALUES ($1,$2,$3) ON CONFLICT (city, series) DO UPDATE SET venue = EXCLUDED.venue, updated_at = now()`, [city, series, venue]);
}

module.exports = function ridesPerf(app, { need, page, wrap, user, setFlash, actor }) {
  const READ = need("admin", "coordinator", "viewer"), STAFF = need("admin", "coordinator");
  const { pool, tx, audit } = require("./db");
  const safeBack = (b) => (/^\/(wmf\/rides|rides)([/?]|$)/.test(String(b || "")) ? String(b) : "/wmf/rides");

  // ----- add a ride: a new ride name, or a ride that's missing (with check-ins by name, or a headcount)
  const coreRides = async () => (await pool.query("SELECT activity_id, name, location FROM activities WHERE kind = 'ride' AND core AND status = 'Active' ORDER BY sort_order, name")).rows;
  app.get("/wmf/rides/new", STAFF, wrap(async (req, res) => {
    const rides = await coreRides(), city = req.query.city === "dxb" ? "Dubai" : "Abu Dhabi", back = safeBack(req.query.back || `/wmf/rides?city=${req.query.city === "dxb" ? "dxb" : "auh"}`);
    res.send(page(req, "Add a ride", `<section class="card narrow"><h2>Add a ride</h2>
      <p class="lead">A ride that's missing from the list, or a new ride. Count it by checking people in by name, or with the number of riders only.</p>
      <form class="form" method="post" action="/wmf/rides/new" id="rdAdd"><input type="hidden" name="back" value="${h(back)}">
        <fieldset class="rate"><legend>City</legend><div class="rate-row">${["Abu Dhabi", "Dubai"].map((c) => `<label><input type="radio" name="city" value="${c}" ${c === city ? "checked" : ""}><span>${c}</span></label>`).join("")}</div></fieldset>
        <label>Date<input type="date" name="d" value="${R.todayLocal()}" max="${R.todayLocal()}" required></label>
        <label>Ride<select name="activity" id="rdAct">${rides.map((a) => `<option value="${h(a.activity_id)}">${h(a.name)}</option>`).join("")}<option value="new">+ New ride…</option></select></label>
        <label>Location <span class="hint">(where the ride starts)</span>${venueField(await venueList(pool, city))}</label>
        <label class="check"><input type="checkbox" name="usual" value="1" checked> <span>Usual location for this ride</span></label>
        <label id="rdNewName">Name of the new ride <span class="hint">(it's added to the scanner and the ride lists, e.g. “Thursday Social”)</span><input name="name" maxlength="60" placeholder="e.g. Thursday Social"></label>
        <fieldset class="rate"><legend>How to count it</legend><div class="rate-row">
          <label><input type="radio" name="mode" value="names" checked><span>Check people in by name</span></label><label><input type="radio" name="mode" value="count"><span>Number of riders only</span></label></div></fieldset>
        <label id="rdCount">Number of riders<input type="number" name="n" min="0" max="999" inputmode="numeric"></label>
        <div class="toolbar" style="margin:0"><button class="btn primary">Add the ride</button><a class="btn ghost" href="${h(back)}">Cancel</a></div></form></section>
      <script src="/rideadd.js" defer></script>`, { active: "/wmf/rides", wide: false }));
  }));
  app.post("/wmf/rides/new", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, by = actor(req), city = b.city === "Dubai" ? "Dubai" : "Abu Dhabi";
    const back = safeBack(b.back), d = /^\d{4}-\d{2}-\d{2}$/.test(b.d || "") && b.d <= R.todayLocal() ? b.d : null;
    const fail = (m) => { setFlash(req, "err", m); return res.redirect("/wmf/rides/new?" + new URLSearchParams({ city: city === "Dubai" ? "dxb" : "auh", back })); };
    if (!d) return fail("Check the date.");
    const name = R.clean(b.name).slice(0, 60);
    let act = b.activity && b.activity !== "new" && !name ? (await pool.query("SELECT * FROM activities WHERE activity_id = $1 AND kind = 'ride'", [b.activity])).rows[0] : null;
    if (!act) {
      if (!name) return fail("Choose a ride, or type the name of the new ride.");
      act = (await pool.query("SELECT * FROM activities WHERE kind = 'ride' AND lower(name) = lower($1)", [name])).rows[0];
      if (!act) {
        const id = "RIDE-" + name.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
        act = (await pool.query(`INSERT INTO activities (activity_id, name, activity_type, category, kind, location, status, core, sort_order)
          VALUES ($1, $2, 'Community Ride', 'Ride Initiative', 'ride', $3, 'Active', TRUE, 100 + (SELECT count(*) FROM activities WHERE core))
          ON CONFLICT (activity_id) DO UPDATE SET core = TRUE, status = 'Active', kind = 'ride' RETURNING *`, [id, name, city])).rows[0];
        await audit(pool, by, "ride.new_type", "activity", act.activity_id, null, { name, city });
      } else if (!act.core || act.status !== "Active") await pool.query("UPDATE activities SET core = TRUE, status = 'Active' WHERE activity_id = $1", [act.activity_id]);
    }
    if (b.mode === "count") {
      const n = /^\d{1,3}$/.test(String(b.n || "")) ? +b.n : null;
      if (n == null) return fail("Enter the number of riders.");
      const id = (await pool.query("INSERT INTO lead_rides (city, ride_type, title, ride_date, participants, entered_by) VALUES ($1, 'Manual', $2, $3, $4, $5) RETURNING id", [city, act.name, d, n, by])).rows[0].id;
      await audit(pool, by, "ride.add_headcount", "lead_ride", String(id), null, { city, ride: act.name, date: d, riders: n });
      await saveVenue(pool, { d, city, series: act.name, venue: b.venue, usual: b.usual === "1", by });
      setFlash(req, "ok", `Added ${act.name}, ${d}: ${n} riders.`);
      return res.redirect(back);
    }
    await saveVenue(pool, { d, city, series: R.seriesFor(act, d), venue: b.venue, usual: b.usual === "1", by });
    setFlash(req, "ok", `${act.name} is ready. Find each rider by name below and tap Check in.`);
    res.redirect(`/rides/${d}/${encodeURIComponent(act.activity_id)}`);
  }));

  // ----- one ride: change it, or remove it
  app.get("/wmf/rides/ride", STAFF, wrap(async (req, res) => {
    const q = req.query, back = safeBack(q.back);
    let body = "";
    if (q.src === "h") {
      const r = (await pool.query("SELECT *, ride_date::text AS d FROM history_rides WHERE id = $1", [+q.id || 0])).rows[0];
      if (!r) return res.redirect(back);
      body = `<p class="lead">From the imported attendance records.</p><form class="form" method="post" action="/wmf/rides/ride"><input type="hidden" name="src" value="h"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="back" value="${h(back)}">
        <div class="row2"><label>Date<input type="date" name="d" value="${h(r.d)}" required></label><label>City<select name="city"><option ${/dxb|dubai/i.test(r.state || "") ? "" : "selected"}>Abu Dhabi</option><option ${/dxb|dubai/i.test(r.state || "") ? "selected" : ""}>Dubai</option></select></label></div>
        <div class="row2"><label>Ride<input name="name" maxlength="80" value="${h(r.initiative)}" required></label><label>Riders<input type="number" name="n" min="0" max="999" value="${r.attendees}" required></label></div>
        <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn danger" name="action" value="delete" data-confirm="Delete this ride? Its riders will no longer count." formnovalidate>Delete this ride</button><a class="btn ghost" href="${h(back)}">Cancel</a></div></form>`;
    } else if (q.src === "l") {
      const r = (await pool.query("SELECT *, ride_date::text AS d, (SELECT count(*)::int FROM lead_photos p WHERE p.ride_id = r.id) AS photos FROM lead_rides r WHERE id = $1", [+q.id || 0])).rows[0];
      if (!r) return res.redirect(back);
      body = `<p class="lead">Sent by the ride lead${r.photos ? `, with ${r.photos} photo${r.photos === 1 ? "" : "s"}` : ""}.</p><form class="form" method="post" action="/wmf/rides/ride"><input type="hidden" name="src" value="l"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="back" value="${h(back)}">
        <div class="row2"><label>Date<input type="date" name="d" value="${h(r.d)}" required></label>${r.ride_type === "Manual" ? `<input type="hidden" name="type" value="Manual"><label>City<select name="city"><option ${r.city === "Dubai" ? "" : "selected"}>Abu Dhabi</option><option ${r.city === "Dubai" ? "selected" : ""}>Dubai</option></select></label></div>
        <div class="row2"><label>Ride<input name="name" maxlength="80" value="${h(r.title)}" required></label>` : `<label>Ride<select name="type">${["Monday", "Thursday", "Weekend", "Special ride"].map((t) => `<option ${t === r.ride_type ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
        <div class="row2"><label>Special ride name<input name="name" maxlength="80" value="${h(r.title)}"></label>`}<label>Riders<input type="number" name="n" min="0" max="999" value="${r.participants}" required></label></div>
        <div class="toolbar" style="margin:0"><button class="btn primary">Save</button><button class="btn danger" name="action" value="delete" data-confirm="Delete this ride and its photos?" formnovalidate>Delete this ride</button><a class="btn ghost" href="${h(back)}">Cancel</a></div></form>`;
    } else if (q.src === "q") {
      const recs = String(q.recs || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 300);
      const rows = recs.length ? (await pool.query(`SELECT p.id, p.record_id, p.record_date, p.source, p.activity_id, p.activity_name, m.full_name, m.member_id FROM participation p LEFT JOIN members m ON m.member_id = p.member_id
        WHERE p.record_id = ANY($1) AND p.voided_at IS NULL ORDER BY m.full_name`, [recs])).rows : [];
      if (!rows.length) return res.redirect(back);
      body = `<p class="lead">${rows.length} check-in${rows.length === 1 ? "" : "s"} on ${fmtDate(q.d)}. Remove one person, or delete the whole ride if it shouldn't count.</p>
        <ul class="log">${rows.map((r) => `<li><span><b>${h(r.full_name || "—")}</b> <span class="muted">${h(r.member_id || "")} · ${h(r.activity_name || "")} · ${h(r.source || "")}</span></span>
          <form method="post" action="/wmf/rides/ride" style="margin:0"><input type="hidden" name="src" value="q"><input type="hidden" name="recs" value="${h(r.record_id)}"><input type="hidden" name="back" value="${h(req.originalUrl)}"><button class="btn tblbtn" name="action" value="delete" data-confirm="Remove ${h(r.full_name || "this check-in")} from this ride?">Remove</button></form></li>`).join("")}</ul>
        <h3 style="margin:18px 0 6px">Recorded on the wrong ride or day?</h3>
        <form method="post" action="/wmf/rides/ride" class="form"><input type="hidden" name="src" value="q"><input type="hidden" name="recs" value="${h(recs.join(","))}"><input type="hidden" name="back" value="${h(back)}">
          <div class="row2"><label>Date<input type="date" name="d" value="${h(q.d || "")}" max="${R.todayLocal()}" required></label>
            <label>Ride<select name="activity">${(await pool.query("SELECT activity_id, name FROM activities WHERE core AND kind = 'ride' ORDER BY sort_order")).rows.map((a) => `<option value="${h(a.activity_id)}" ${rows[0].activity_id === a.activity_id ? "selected" : ""}>${h(a.name)}</option>`).join("")}</select></label></div>
          <button class="btn primary" name="action" value="move">Move all ${rows.length} check-in${rows.length === 1 ? "" : "s"}</button>
          <p class="hint" style="margin:0">If someone is already checked in on that ride and day, their extra check-in here is removed instead, so nobody counts twice.</p></form>
        <form method="post" action="/wmf/rides/ride" class="toolbar" style="margin-top:14px"><input type="hidden" name="src" value="q"><input type="hidden" name="recs" value="${h(recs.join(","))}"><input type="hidden" name="back" value="${h(back)}">
          <button class="btn danger" name="action" value="delete" data-confirm="Delete the whole ride (all ${rows.length} check-ins)?">Delete the whole ride</button><a class="btn ghost" href="${h(back)}">Back</a></form>
        <div class="toolbar" style="margin-top:14px"><a class="btn primary" href="/rides/${h(q.d)}/${h(encodeURIComponent(rows[0].activity_id))}?add=new#add">+ Check someone in / add a new member</a></div>`;
    } else return res.redirect(back);
    const vCity = q.city === "Dubai" ? "Dubai" : "Abu Dhabi", series = R.clean(q.series).slice(0, 80);
    const vd = q.d || (q.src === "h" ? (await pool.query("SELECT ride_date::text AS d FROM history_rides WHERE id = $1", [+q.id || 0])).rows[0]?.d : q.src === "l" ? (await pool.query("SELECT ride_date::text AS d FROM lead_rides WHERE id = $1", [+q.id || 0])).rows[0]?.d : null);
    const cur = series && vd ? (await pool.query("SELECT venue FROM ride_venues WHERE ride_date = $1 AND city = $2 AND series = $3", [vd, vCity, series])).rows[0] : null;
    const def = series ? (await pool.query("SELECT venue FROM ride_venue_defaults WHERE city = $1 AND series = $2", [vCity, series])).rows[0] : null;
    const venueForm = series && vd ? `<form method="post" action="/wmf/rides/ride" class="form rd-venue"><input type="hidden" name="src" value="venue"><input type="hidden" name="d" value="${h(vd)}"><input type="hidden" name="city" value="${vCity}"><input type="hidden" name="series" value="${h(series)}"><input type="hidden" name="back" value="${h(req.originalUrl)}">
        <label>Location${def && !cur ? ` <span class="hint">(usual: ${h(def.venue)})</span>` : ""}${venueField(await venueList(pool, vCity), cur ? cur.venue : def ? def.venue : "")}</label>
        <div class="toolbar" style="margin:0;align-items:center"><label class="check" style="margin:0"><input type="checkbox" name="usual" value="1" ${def ? "" : "checked"}> <span>Usual location for every ${h(series)}</span></label><button class="btn">Save location</button></div></form>` : "";
    res.send(page(req, "Edit ride", `<section class="card narrow"><h2>Edit ride${series ? ` · ${h(series)}` : ""}</h2>${venueForm}${body}</section>`, { active: "/wmf/rides", wide: false }));
  }));
  app.post("/wmf/rides/ride", STAFF, wrap(async (req, res) => {
    const b = req.body || {}, back = safeBack(b.back), del = b.action === "delete", by = actor(req);
    const okD = /^\d{4}-\d{2}-\d{2}$/.test(b.d || "") && b.d <= R.todayLocal(), n = /^\d{1,3}$/.test(String(b.n || "")) ? +b.n : null;
    let msg = "Saved.";
    await tx(async (c) => {
      if (b.src === "h") {
        const old = (await c.query("SELECT * FROM history_rides WHERE id = $1", [+b.id || 0])).rows[0]; if (!old) return;
        if (del) { await c.query("DELETE FROM history_rides WHERE id = $1", [old.id]); msg = "Ride deleted."; }
        else { if (!okD || n == null) { msg = "Check the date and the number of riders."; return; }
          await c.query("UPDATE history_rides SET ride_date = $2, initiative = $3, state = $4, attendees = $5 WHERE id = $1", [old.id, b.d, R.clean(b.name).slice(0, 80) || old.initiative, b.city === "Dubai" ? "DXB" : "AUH", n]); }
        await audit(c, by, del ? "ride.delete" : "ride.update", "history_ride", String(old.id), old, del ? null : { date: b.d, name: b.name, city: b.city, riders: n });
      } else if (b.src === "l") {
        const old = (await c.query("SELECT * FROM lead_rides WHERE id = $1", [+b.id || 0])).rows[0]; if (!old) return;
        if (del) { await c.query("DELETE FROM lead_rides WHERE id = $1", [old.id]); msg = "Ride deleted."; }
        else { if (!okD || n == null) { msg = "Check the date and the number of riders."; return; }
          const type = ["Monday", "Thursday", "Weekend", "Special ride", "Manual"].includes(b.type) ? b.type : old.ride_type;
          const title = type === "Special ride" || type === "Manual" ? R.clean(b.name).slice(0, 80) || old.title : null;
          const city = type === "Manual" && b.city ? (b.city === "Dubai" ? "Dubai" : "Abu Dhabi") : old.city;
          await c.query("UPDATE lead_rides SET ride_date = $2, ride_type = $3, title = $4, participants = $5, city = $6, updated_at = now() WHERE id = $1", [old.id, b.d, type, title, n, city]); }
        await audit(c, by, del ? "ride.delete" : "ride.update", "lead_ride", String(old.id), old, del ? null : { date: b.d, type: b.type, riders: n });
      } else if (b.src === "venue") {
        const d = /^\d{4}-\d{2}-\d{2}$/.test(b.d || "") ? b.d : null;
        await saveVenue(c, { d, city: b.city === "Dubai" ? "Dubai" : "Abu Dhabi", series: R.clean(b.series).slice(0, 80), venue: b.venue, usual: b.usual === "1", by });
        msg = R.clean(b.venue) ? "Location saved." : "Location cleared.";
      } else if (b.src === "q" && b.action === "move") {
        const act = (await c.query("SELECT * FROM activities WHERE activity_id = $1 AND kind = 'ride'", [b.activity])).rows[0];
        if (!act || !okD) { msg = "Check the date and the ride."; return; }
        const recs = String(b.recs || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 300);
        const series = R.seriesFor(act, b.d);
        let moved = 0, dup = 0;
        for (const p of (await c.query("SELECT * FROM participation WHERE record_id = ANY($1) AND voided_at IS NULL", [recs])).rows) {
          const key = `ride|${p.member_id}|${b.d}|${series}`;
          const other = (await c.query("SELECT 1 FROM participation WHERE dedupe_key = $1 AND id <> $2 AND voided_at IS NULL", [key, p.id])).rows[0];
          if (other) { await c.query("UPDATE participation SET voided_at = now(), void_reason = 'Duplicate after moving ride' WHERE id = $1", [p.id]); dup++; continue; }
          const time = String(p.record_date).slice(11, 19) || "00:00:00"; // stored as local time text
          await c.query(`UPDATE participation SET record_date = $2, activity_id = $3, activity_name = $4, activity_type = coalesce($5, activity_type), dedupe_key = $6 WHERE id = $1`,
            [p.id, `${b.d} ${time}`, act.activity_id, act.name, act.activity_type, key]);
          moved++;
        }
        await audit(c, by, "ride.checkins_moved", "participation", recs.slice(0, 5).join(","), null, { to: b.d, ride: act.name, moved, duplicates: dup });
        msg = `Moved ${moved} check-in${moved === 1 ? "" : "s"} to ${act.name}, ${b.d}${dup ? ` (${dup} already there, removed)` : ""}.`;
      } else if (b.src === "q" && del) {
        const recs = String(b.recs || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 300);
        const r = await c.query("UPDATE participation SET voided_at = now(), void_reason = 'Removed from the Rides page' WHERE record_id = ANY($1) AND voided_at IS NULL RETURNING record_id", [recs]);
        await audit(c, by, "ride.checkins_removed", "participation", recs.slice(0, 5).join(","), null, { removed: r.rowCount });
        msg = r.rowCount === 1 ? "Check-in removed." : `Ride deleted (${r.rowCount} check-ins removed).`;
      }
    });
    setFlash(req, msg.startsWith("Check") ? "err" : "ok", msg);
    res.redirect(back);
  }));

  app.get("/wmf/rides", READ, wrap(async (req, res) => {
    const cityKey = req.query.city === "dxb" ? "dxb" : "auh", city = CITIES[cityKey];
    const today = R.todayLocal();
    const type = ["month", "quarter", "year"].includes(req.query.period) ? req.query.period : "month";
    const per = CD.periodFromQuery({ period: type, p: req.query.p || (type === "month" ? today.slice(0, 7) : type === "quarter" ? `${today.slice(0, 4)}-Q${Math.floor((+today.slice(5, 7) - 1) / 3) + 1}` : today.slice(0, 4)) }, today);
    const end = per.end < today ? per.end : today, prevR = E.previousPeriod(per.start, per.end);
    const P = E.prepare(await buildData());
    const cur = E.compute(P, { start: per.start, end, location: city.name }, today), k = cur.kpis;
    const prev = E.compute(P, { start: prevR.start, end: prevR.end, location: city.name }, today, { light: true }).kpis;
    const list = sessions(P, city.name, per.start, end);
    const vMap = new Map((await pool.query("SELECT ride_date::text AS d, series, venue FROM ride_venues WHERE city = $1 AND ride_date BETWEEN $2 AND $3", [city.name, per.start, end])).rows.map((r) => [r.d + "|" + r.series, r.venue]));
    const vDef = new Map((await pool.query("SELECT series, venue FROM ride_venue_defaults WHERE city = $1", [city.name])).rows.map((r) => [r.series, r.venue]));
    for (const s of list) { s.venue = vMap.get(s.d + "|" + s.series) || vDef.get(s.series) || null; s.venueUsual = !vMap.has(s.d + "|" + s.series) && !!s.venue; }
    const byVenue = new Map();
    for (const s of list) { const k = s.venue || "Not set"; const x = byVenue.get(k) || { name: k, rides: 0, people: 0 }; x.rides++; x.people += s.n; byVenue.set(k, x); }
    const venues = [...byVenue.values()].sort((a, b) => (a.name === "Not set") - (b.name === "Not set") || b.people - a.people);
    const rides = list.length, people = list.reduce((a, s) => a + s.n, 0), avg = rides ? people / rides : null;
    const prevList = sessions(P, city.name, prevR.start, prevR.end), prevPeople = prevList.reduce((a, s) => a + s.n, 0);
    const series = new Map();
    for (const s of list) { const x = series.get(s.series) || { name: s.series, rides: 0, people: 0, best: null }; x.rides++; x.people += s.n; if (!x.best || s.n > x.best.n) x.best = s; series.set(s.series, x); }
    const bySeries = [...series.values()].sort((a, b) => b.people - a.people);
    // people whose first WMF ride was in this period, in this city
    const newRiders = [];
    for (const p of P.persons.values()) {
      if (!(p.first >= per.start && p.first <= end)) continue;
      const r = P.rows.find((x) => x.person === p.person && x.kind === "ride" && x.location === city.name && x.d >= per.start && x.d <= end);
      if (r) newRiders.push({ name: (p.member && (p.member.fullName || p.member.label)) || p.label || "—", d: r.d, series: r.series });
    }
    newRiders.sort((a, b) => b.d.localeCompare(a.d));
    const maxS = Math.max(1, ...bySeries.map((x) => x.people / x.rides));
    // chart: each ride in a month; each month in a quarter or year
    const chart = type === "month"
      ? (list.length ? columns({ categories: [...list].reverse().map((s) => s.d + "|" + s.series), series: [{ name: city.name, color: city.color, values: [...list].reverse().map((s) => s.n) }], height: 190, label: "Riders per ride", short: (c) => `${+c.slice(8, 10)} ${["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"][new Date(c.slice(0, 10) + "T12:00:00Z").getUTCDay()]}` }) : "")
      : columns({ categories: H.monthsBetween(per.start.slice(0, 7), end.slice(0, 7)), series: [{ name: city.name, color: city.color, values: H.monthsBetween(per.start.slice(0, 7), end.slice(0, 7)).map((m) => sessions(P, city.name, m + "-01", H.monthEnd(m)).reduce((a, s) => a + s.n, 0)) }], height: 190, label: "Participation by month", short: (m) => monLabel(m) });
    const opts = [];
    if (type === "month") for (const m of H.monthsBetween("2025-01", today.slice(0, 7)).reverse()) opts.push([m, monLabel(m, true)]);
    if (type === "quarter") for (let y = +today.slice(0, 4); y >= 2025; y--) for (let q = 4; q >= 1; q--) if (`${y}-${String(q * 3 - 2).padStart(2, "0")}` <= today.slice(0, 7)) opts.push([`${y}-Q${q}`, `Q${q} ${y}`]);
    if (type === "year") for (let y = +today.slice(0, 4); y >= 2025; y--) opts.push([String(y), String(y)]);
    const q = (o) => new URLSearchParams({ city: cityKey, period: type, p: per.p, ...o }).toString();
    const ch = pctCh(people, prevPeople);
    const delta = ch == null ? "" : `<span class="${ch >= 0 ? "rp-up" : "rp-down"}">${ch >= 0 ? "▲" : "▼"} ${Math.abs(ch)}%</span> vs before`;
    const lead = list.some((s) => s.lead);
    const canEdit = ["admin", "coordinator"].includes(user(req).role), back = req.originalUrl, dupes = list.filter((s) => s.dupe).length;
    res.send(page(req, `Rides · ${city.name}`, `
      <section class="mk-head"><div><div class="wc-eyebrow">Rides</div><h2 class="ov-title">${h(city.name)} · ${h(per.label)}</h2></div>
        <div class="mk-actions"><span class="seg rd-city">${Object.entries(CITIES).map(([key, c]) => `<a href="/wmf/rides?${q({ city: key })}" class="${key === cityKey ? "on" : ""}">${h(c.name)}</a>`).join("")}</span>
          <span class="seg">${Object.keys(KIND).map((t) => `<a href="/wmf/rides?city=${cityKey}&period=${t}" class="${type === t ? "on" : ""}">${KIND[t]}</a>`).join("")}</span>
          <form method="get" style="margin:0"><input type="hidden" name="city" value="${cityKey}"><input type="hidden" name="period" value="${type}"><select class="inp" name="p" style="width:auto" data-autosubmit aria-label="Period">${opts.map(([v, l]) => `<option value="${v}" ${v === per.p ? "selected" : ""}>${h(l)}</option>`).join("")}</select></form></div></section>
      ${detailTiles([
        { label: "Participation", value: nf(people), note: delta, detail: { title: `Participation · ${city.name} · ${per.label}`, html: `<h3>By ride</h3>${mini(["Ride", "Rides", "Participation", "Avg. per ride"], bySeries.map((x) => [h(x.name), nf(x.rides), nf(x.people), nf(Math.round(x.people / x.rides))]), { num: [1, 2, 3] })}
          <h3>Compared with the period before</h3>${mini(["", "This period", "Period before"], [["Participation", nf(people), nf(prevPeople)], ["Rides held", nf(rides), nf(prevList.length)], ["Avg. per ride", avg ? nf(Math.round(avg)) : "—", prevList.length ? nf(Math.round(prevPeople / prevList.length)) : "—"]], { num: [1, 2] })}` } },
        { label: "Rides held", value: nf(rides), note: prevList.length ? `${prevList.length} the period before` : "", detail: { title: "Rides held by weekday", html: mini(["Day", "Rides", "Participation", "Avg. per ride"],
          ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((w) => { const l = list.filter((s) => R.weekdayOf(s.d) === w); return l.length ? [w, nf(l.length), nf(l.reduce((a, s) => a + s.n, 0)), nf(Math.round(l.reduce((a, s) => a + s.n, 0) / l.length))] : null; }).filter(Boolean), { num: [1, 2, 3] }) + '<p class="hint">Every ride is listed under “Every ride” below.</p>' } },
        { label: "Avg. riders per ride", value: avg ? nf(Math.round(avg)) : "—", detail: { title: "Best and lowest turnout", html: mini(["Date", "Ride", "Riders"], [...list].sort((a, b) => b.n - a.n).slice(0, 5).map((s) => [fmtDate(s.d), h(s.series), `<b>${nf(s.n)}</b>`]), { num: [2] })
          + `<h3>Lowest</h3>${mini(["Date", "Ride", "Riders"], [...list].sort((a, b) => a.n - b.n).slice(0, 5).map((s) => [fmtDate(s.d), h(s.series), nf(s.n)]), { num: [2] })}` } },
        { label: "New riders", value: lead && !k.firstTimers ? "—" : nf(k.firstTimers), note: lead && !k.firstTimers ? "Headcounts only: names aren't recorded" : "First ride with WMF",
          detail: { title: "First ride with WMF", html: newRiders.length ? mini(canEdit ? ["Name", "First ride", "Ride"] : ["First ride", "Ride"], newRiders.map((n) => (canEdit ? [h(n.name), fmtDate(n.d), h(n.series)] : [fmtDate(n.d), h(n.series)])), { scroll: true })
            : '<p class="muted">No first-time riders recorded in this period' + (lead ? ": rides sent as a headcount don't record names." : ".") + "</p>" } },
      ])}
      <div class="grid">
        <section class="card c7"><h2>${type === "month" ? "Riders per ride" : "Participation by month"}</h2>${chart || '<p class="muted">No rides in this period.</p>'}</section>
        <section class="card c5"><h2>By ride</h2>
          ${bySeries.length ? `<div class="hbars">${bySeries.map((x) => `<div class="hbar"><span class="hbar-l">${h(x.name)}</span><span class="hbar-t"><span style="width:${(x.people / x.rides / maxS) * 100}%;background:${city.color}"></span></span>
            <span class="hbar-v"><b>${nf(Math.round(x.people / x.rides))}</b> <span class="muted">avg · ${x.rides} ride${x.rides === 1 ? "" : "s"}</span></span></div>`).join("")}</div>` : '<p class="muted">No rides.</p>'}
          ${venues.length > 1 || (venues[0] && venues[0].name !== "Not set") ? `<h3 style="margin:14px 0 6px">By location</h3><div class="hbars">${venues.map((x) => `<div class="hbar"><span class="hbar-l">${h(x.name)}</span><span class="hbar-t"><span style="width:${(x.people / Math.max(1, ...venues.map((v) => v.people))) * 100}%;background:${x.name === "Not set" ? "var(--line)" : city.color}"></span></span>
            <span class="hbar-v"><b>${nf(x.people)}</b> <span class="muted">· ${x.rides} ride${x.rides === 1 ? "" : "s"}</span></span></div>`).join("")}</div>` : ""}
          <p class="hint" style="margin-top:8px">Average riders per ride. Best turnout: ${bySeries.length ? bySeries.map((x) => `${h(x.name)} ${x.best.n} (${fmtDate(x.best.d)})`).slice(0, 2).join(", ") : "—"}.</p></section>
        <section class="card c12"><div class="card-head"><div><h2>Every ride</h2>${dupes ? `<p class="lead" style="margin:0"><span class="badge warn">${dupes}</span> rides look entered twice (same day, same ride). Open one with Edit / delete to fix or remove it.</p>` : ""}</div>
          <div class="toolbar" style="margin:0">${canEdit ? `<a class="btn primary" href="/wmf/rides/new?${h(new URLSearchParams({ city: cityKey, back }).toString())}">+ Add a ride</a>` : ""}${cityKey === "auh" ? `<a class="btn" href="/rides">Attendance per ride: check people in</a>` : `<a class="btn" href="/dubai">Dubai lead link &amp; photos</a>`}</div></div>
          <div class="tw"><table><thead><tr><th>Date</th><th>Ride</th><th>Location</th><th class="n">Riders</th><th>How it was counted</th><th></th></tr></thead><tbody>
          ${list.map((s) => `<tr${s.dupe ? ' class="rd-dupe"' : ""}><td style="white-space:nowrap">${fmtDate(s.d)}</td><td>${h(s.series)}${s.dupe ? ' <span class="badge warn">Possible duplicate</span>' : ""}</td>
            <td>${s.venue ? `${h(s.venue)}${s.venueUsual ? ' <span class="muted" title="The usual location for this ride">(usual)</span>' : ""}` : '<span class="muted">—</span>'}</td><td class="n"><b>${nf(s.n)}</b></td>
            <td class="muted">${s.src === "l" ? (s.manual ? "Number of riders, added by the team" : "Sent by the ride lead") : s.src === "q" ? "QR check-ins" : "Attendance records"}</td>
            <td>${canEdit ? `<a class="btn tblbtn" href="${h(editHref(s, back, city.name))}">Edit / delete</a>` : ""}</td></tr>`).join("") || `<tr><td colspan="6" class="muted">No rides in ${h(per.label)}.</td></tr>`}
          </tbody></table></div></section>
      </div>`, { active: "/wmf/rides" }));
  }));
};
module.exports.sessions = sessions;
