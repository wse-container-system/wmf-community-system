"use strict";
/**
 * Attendance per ride: who was checked in at each ride, and who usually comes but has no check-in,
 * so a ride lead can spot people they forgot to scan and add them afterwards.
 */
const { pool, tx } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { h, fmtDate } = require("./views");

const H = E.helpers;
const REGULAR_WEEKS = 8;     // "regular" = 2+ check-ins at the same ride in the 8 weeks before
const CORRECT_DAYS = 60;     // check-ins can be added up to 60 days after a ride from this page

/** The ride a row belongs to: one of the six scanner rides when it is one, otherwise the weekday series used in reporting. */
function sessionRide(r, coreById) {
  if (coreById.has(r.activity_id)) return { key: r.activity_id, name: coreById.get(r.activity_id).name };
  const c = E.classify({ recordType: r.record_type, activityName: r.activity_name, activityId: r.activity_id, activityType: r.activity_type, date: r.record_date });
  return { key: "S:" + c.series, name: c.series };
}
async function loadRides(from, to) {
  const core = (await pool.query("SELECT activity_id, name FROM activities WHERE core ORDER BY sort_order")).rows;
  const coreById = new Map(core.map((a) => [a.activity_id, a]));
  const rows = (await pool.query(`SELECT p.id, p.record_id, p.record_date, p.record_type, p.activity_id, p.activity_name, p.activity_type, p.source, p.member_id, p.member_name, p.member_email,
        m.full_name, m.merged_into FROM participation p LEFT JOIN members m ON m.member_id = p.member_id
      WHERE p.voided_at IS NULL AND p.record_type = 'Attendance' AND p.status = 'Attended' AND p.record_date >= $1::date AND p.record_date < ($2::date + 1)
      ORDER BY p.record_date`, [from, to])).rows;
  const out = [];
  for (const r of rows) {
    const c = E.classify({ recordType: r.record_type, activityName: r.activity_name, activityId: r.activity_id, activityType: r.activity_type, date: r.record_date });
    if (c.kind !== "ride") continue;
    const s = sessionRide(r, coreById);
    // attendance forms were often sent a day or two after the ride: put "Monday Ride" sent on a Wednesday back on that Monday
    let date = String(r.record_date).slice(0, 10), late = false;
    const named = /^(\w+day) Ride$/.exec(c.series || "");
    if (named && R.weekdayOf(date) !== named[1]) {
      for (let i = 1; i <= 6; i++) { const d = H.addDays(date, -i); if (R.weekdayOf(d) === named[1]) { date = d; late = true; break; } }
    }
    // an imported "Wednesday Ride" and the app's "Wednesday Social" on the same day are the same ride: one list, one count
    if (s.key.startsWith("S:") && named) { const k = activityForKey(s.key, date, core); if (coreById.has(k)) { s.key = k; s.name = coreById.get(k).name; } }
    out.push({ ...r, date, late, key: s.key, ride: s.name, person: r.merged_into || r.member_id || "e:" + R.normEmail(r.member_email) });
  }
  return { rows: out, core, coreById };
}
/** Which of the six scanner rides a missed check-in should be recorded against. */
function activityForKey(key, date, core) {
  if (core.some((a) => a.activity_id === key)) return key;
  const wd = R.weekdayOf(date);
  return { Monday: "RIDE-MONDAY-MADNESS", Wednesday: "RIDE-WEDNESDAY-SOCIAL", Saturday: "RIDE-WEEKEND-LONG", Sunday: "RIDE-WEEKEND-LONG" }[wd] || "RIDE-MORNING";
}

/** Members matching a name, email, phone or ID (contact details shortened). */
async function findPeople(q) {
  q = R.clean(q).slice(0, 60);
  if (q.length < 2) return [];
  const like = "%" + q.replace(/[%_]/g, "") + "%", digits = q.replace(/\D/g, "");
  const r = await pool.query(`SELECT member_id, full_name, primary_email, mobile FROM members WHERE merged_into IS NULL
    AND (full_name ILIKE $1 OR primary_email ILIKE $1 OR alt_emails ILIKE $1 OR member_id ILIKE $1 ${digits.length >= 4 ? "OR regexp_replace(coalesce(mobile, ''), '\\D', '', 'g') LIKE $2" : ""})
    ORDER BY full_name LIMIT 8`, digits.length >= 4 ? [like, "%" + digits + "%"] : [like]);
  return r.rows.map((m) => ({ ...m, hint: [m.primary_email ? R.maskEmail(m.primary_email) : "", m.mobile ? R.maskPhone(m.mobile) : ""].filter(Boolean).join(" · ") }));
}

module.exports = function rides(app, { need, page, setFlash, actor, wrap, checkIn }) {
  const STAFF = need("admin", "coordinator");

  app.get("/rides", STAFF, wrap(async (req, res) => {
    const days = [30, 60, 90, 180].includes(+req.query.days) ? +req.query.days : 60;
    const today = R.todayLocal(), from = H.addDays(today, -days);
    const { rows } = await loadRides(H.addDays(from, -REGULAR_WEEKS * 7), today);
    // sessions in the window
    const sessions = new Map();
    for (const r of rows) {
      if (r.date < from) continue;
      const k = r.date + "|" + r.key;
      if (!sessions.has(k)) sessions.set(k, { date: r.date, key: r.key, ride: r.ride, people: new Set(), recs: [] });
      sessions.get(k).people.add(r.person); sessions.get(k).recs.push(r.record_id);
    }
    // regulars missing from each session
    const byKey = new Map();
    for (const r of rows) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r); }
    for (const s of sessions.values()) s.missing = regularsMissing(byKey.get(s.key) || [], s.date, s.people).length;
    // calendar rides that have no check-ins at all
    const cal = require("./calendar");
    const C = require("../public/calendar-core");
    const items = (await cal.loadItems()).filter((a) => a.slot);
    const map = C.build(items, from, today);
    const empty = [];
    for (const [d, list] of Object.entries(map)) for (const o of list) {
      if (o.cancel || d >= today) continue;
      if (![...sessions.values()].some((s) => s.date === d && (s.key === o.a.slot || s.ride === R.weekdayOf(d) + " Ride"))) empty.push({ date: d, title: o.a.t, slot: o.a.slot });
    }
    const list = [...sessions.values()].sort((a, b) => b.date.localeCompare(a.date) || a.ride.localeCompare(b.ride));
    res.send(page(req, "Attendance per ride", `
      <section class="card"><div class="card-head"><div><h2>Attendance per ride</h2>
        <p class="lead">Every ride with the people checked in. “Usual riders not checked in” counts people who came to the same ride at least twice in the ${REGULAR_WEEKS} weeks before but have no check-in that day. Open the ride to check whether you missed scanning them.</p></div>
        <form method="get" class="toolbar"><a class="btn primary" href="/wmf/rides/new?back=${encodeURIComponent("/rides?days=" + days)}">+ Add a ride</a><select class="inp" name="days" style="width:auto">${[30, 60, 90, 180].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>Last ${d} days</option>`).join("")}</select><button class="btn">Show</button></form></div>
      ${empty.length ? `<div class="alert warn" style="margin-bottom:12px"><span class="ic">!</span><span><b>${empty.length} ride${empty.length > 1 ? "s" : ""} on the calendar with no check-ins:</b> ${empty.slice(0, 8).map((e) => `<a href="/rides/${e.date}/${encodeURIComponent(e.slot)}">${fmtDate(e.date)} ${h(e.title)}</a>`).join(" · ")}${empty.length > 8 ? " …" : ""}. Was the ride cancelled, or were people not scanned?</span></div>` : ""}
      <div class="tw"><table><thead><tr><th>Date</th><th>Ride</th><th class="n">Checked in</th><th class="n">Usual riders not checked in</th><th></th></tr></thead><tbody>
      ${list.map((s) => `<tr><td>${fmtDate(s.date)} <span class="muted">${R.weekdayOf(s.date).slice(0, 3)}</span></td><td>${h(s.ride)}</td><td class="n"><b>${s.people.size}</b></td>
        <td class="n">${s.missing ? `<span class="badge warn">${s.missing}</span>` : `<span class="muted">0</span>`}</td><td style="white-space:nowrap"><a class="btn tblbtn" href="/rides/${s.date}/${encodeURIComponent(s.key)}">Open</a>
          <a class="btn tblbtn" href="/wmf/rides/ride?${h(new URLSearchParams({ src: "q", d: s.date, recs: s.recs.join(","), back: `/rides?days=${days}` }).toString())}">Edit / delete</a></td></tr>`).join("") || `<tr><td colspan="5" class="muted">No ride check-ins in this period.</td></tr>`}
      </tbody></table></div></section>`, { active: "/wmf/rides" }));
  }));

  function regularsMissing(rows, date, present) {
    const since = H.addDays(date, -REGULAR_WEEKS * 7);
    const counts = new Map();
    for (const r of rows) {
      if (r.date >= date || r.date < since || present.has(r.person)) continue;
      const k = r.person;
      if (!counts.has(k)) counts.set(k, { person: k, memberId: r.merged_into || r.member_id, name: r.full_name || r.member_name, n: 0, last: r.date });
      const c = counts.get(k); c.n++; if (r.date > c.last) c.last = r.date;
    }
    return [...counts.values()].filter((c) => c.n >= 2).sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
  }

  app.get("/rides/:date/:key", STAFF, wrap(async (req, res) => {
    const date = req.params.date, key = req.params.key;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.redirect("/rides");
    const { rows, core } = await loadRides(H.addDays(date, -REGULAR_WEEKS * 7), date);
    const coreRide = core.find((a) => a.activity_id === key);
    const same = rows.filter((r) => r.key === key);
    const here = same.filter((r) => r.date === date);
    const present = new Set(here.map((r) => r.person));
    const missing = regularsMissing(same, date, present);
    const rideName = coreRide ? coreRide.name : key.replace(/^S:/, "");
    const canAdd = date >= H.addDays(R.todayLocal(), -CORRECT_DAYS);
    const actId = activityForKey(key, date, core);
    const back = `/rides/${date}/${encodeURIComponent(key)}`;
    const checkBtn = (id) => `<form method="post" action="/rides/checkin" style="margin:0"><input type="hidden" name="memberId" value="${h(id)}"><input type="hidden" name="date" value="${h(date)}"><input type="hidden" name="activityId" value="${h(actId)}"><input type="hidden" name="back" value="${h(back)}"><button class="btn tblbtn primary">Check in</button></form>`;
    const found = canAdd && R.clean(req.query.find).length >= 2 ? await findPeople(req.query.find) : [];
    res.send(page(req, `${rideName} ${date}`, `
      <section class="card"><div class="card-head"><div><h2>${h(rideName)} · ${fmtDate(date)}</h2><p class="lead">${R.weekdayOf(date)} · ${here.length} checked in</p></div>
        <div class="toolbar" style="margin:0">${here.length ? `<a class="btn" href="/wmf/rides/ride?${h(new URLSearchParams({ src: "q", d: date, recs: here.map((r) => r.record_id).join(","), back }).toString())}">Edit / delete this ride</a>` : ""}<a class="btn" href="/rides">All rides</a></div></div>
        <div class="tw"><table><thead><tr><th>#</th><th>Member</th><th>Time</th><th>How</th><th></th></tr></thead><tbody>
        ${here.map((r, i) => `<tr><td>${i + 1}</td><td>${r.member_id ? `<a href="/members/${encodeURIComponent(r.merged_into || r.member_id)}">${h(r.full_name || r.member_name || r.member_id)}</a> <span class="muted">${h(r.merged_into || r.member_id)}</span>` : h(r.member_name || "—")}</td>
          <td>${r.late ? `<span class="muted">sent ${fmtDate(String(r.record_date).slice(0, 10))}</span>` : String(r.record_date).slice(11, 16) === "00:00" ? "—" : String(r.record_date).slice(11, 16)}</td><td>${h(r.source)}</td>
          <td><form method="post" action="/wmf/rides/ride" style="margin:0"><input type="hidden" name="src" value="q"><input type="hidden" name="recs" value="${h(r.record_id)}"><input type="hidden" name="back" value="${h(back)}"><button class="btn tblbtn" name="action" value="delete" data-confirm="Remove ${h(r.full_name || r.member_name || "this check-in")} from this ride?">Remove</button></form></td></tr>`).join("") || `<tr><td colspan="5" class="muted">Nobody was checked in.</td></tr>`}
        </tbody></table></div>
        ${canAdd ? `<h3 style="margin:16px 0 6px">Check in someone else</h3>
        <form method="post" action="/rides/checkin" class="toolbar rd-find" style="margin:0;align-items:center"><input class="inp" name="memberId" id="rdFind" placeholder="Name, email, phone or Member ID" required autocomplete="off" value="${h(req.query.find || "")}" style="max-width:320px" aria-label="Name, email, phone or Member ID">
          <input type="hidden" name="date" value="${h(date)}"><input type="hidden" name="activityId" value="${h(actId)}"><input type="hidden" name="back" value="/rides/${h(date)}/${h(encodeURIComponent(key))}"><button class="btn">Find</button></form>
        <ul class="log sc-hits" id="rdHits">${found.map((m) => `<li><span><b>${h(m.full_name)}</b> <span class="muted">${h(m.member_id)}${m.hint ? " · " + h(m.hint) : ""}</span></span>${checkBtn(m.member_id)}</li>`).join("") || (req.query.find ? '<li class="muted">Nobody found. Try part of the name, the email or the phone number.</li>' : "")}</ul>
        <template id="rdBtn">${checkBtn("__ID__")}</template><script src="/ridefind.js" defer></script>` : ""}</section>
      <section class="card"><h2>Usual riders not checked in <span class="badge ${missing.length ? "warn" : "good"}">${missing.length}</span></h2>
        <p class="lead">They came to this ride at least twice in the ${REGULAR_WEEKS} weeks before. If they were there, check them in now${canAdd ? "" : ` (only possible up to ${CORRECT_DAYS} days after the ride)`}.</p>
        <div class="tw"><table><thead><tr><th>Member</th><th class="n">Rides in the ${REGULAR_WEEKS} weeks before</th><th>Last ride</th><th></th></tr></thead><tbody>
        ${missing.map((m) => `<tr><td>${m.memberId ? `<a href="/members/${encodeURIComponent(m.memberId)}">${h(m.name || m.memberId)}</a> <span class="muted">${h(m.memberId)}</span>` : h(m.name || "—")}</td><td class="n">${m.n}</td><td>${fmtDate(m.last)}</td>
          <td>${canAdd && m.memberId ? `<form method="post" action="/rides/checkin"><input type="hidden" name="memberId" value="${h(m.memberId)}"><input type="hidden" name="date" value="${h(date)}"><input type="hidden" name="activityId" value="${h(actId)}"><input type="hidden" name="back" value="/rides/${h(date)}/${h(encodeURIComponent(key))}"><button class="btn tblbtn">They were there: check in</button></form>` : ""}</td></tr>`).join("") || `<tr><td colspan="4" class="muted">Everyone who usually comes was checked in.</td></tr>`}
        </tbody></table></div>

      </section>`, { active: "/wmf/rides" }));
  }));

  app.post("/rides/checkin", STAFF, wrap(async (req, res) => {
    const b = req.body;
    const back = String(b.back || "/rides").startsWith("/rides") ? String(b.back) : "/rides";
    const out = await tx(async (c) => {
      let member = R.memberIdFromScan(b.memberId) ? await R.findMember(c, { memberId: R.memberIdFromScan(b.memberId) }) : null;
      if (!member) { // a name, email or phone: check in straight away when it's one person, otherwise show who matches
        const hits = await findPeople(b.memberId);
        if (hits.length !== 1) return { status: "find", q: R.clean(b.memberId) };
        member = await R.findMember(c, { memberId: hits[0].member_id });
      }
      if (!member) return { status: "error", message: "Member not found." };
      return checkIn(c, { member, activityId: b.activityId, date: b.date, source: "Manual Attendance Correction", by: actor(req), maxDays: CORRECT_DAYS });
    });
    if (out.status === "find") return res.redirect(`${back}${back.includes("?") ? "&" : "?"}find=${encodeURIComponent(out.q)}`);
    setFlash(req, out.status === "error" ? "err" : "ok", out.status === "ok" ? `${out.member.full_name} checked in.` : out.status === "duplicate" ? `${out.member.full_name} was already checked in.` : out.message);
    res.redirect(back);
  }));
};
