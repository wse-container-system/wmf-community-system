"use strict";
/**
 * Cycling Development hub: corporate programme, department admin and the WMF monthly export.
 *   TEST_DATABASE_URL=postgres://… [TEST_TRACKER=./in/corporate-tracker.xlsx] npm test
 * The database is wiped.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const DB = process.env.TEST_DATABASE_URL, TRACKER = process.env.TEST_TRACKER;
if (!DB) { test("hub (skipped: set TEST_DATABASE_URL)", () => {}); return; }
if (process.env.TEST_WORKBOOK) { test("hub (skipped: runs on its own, not alongside the WMF e2e test)", () => {}); return; }
process.env.DATABASE_URL = DB;
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASSWORD = "first-Password-1";
process.env.HR_FEED_TOKEN = "hr-secret-token-1234567890";

const ExcelJS = require("exceljs");
const { pool, tx } = require("../src/db");
const { app, init } = require("../src/server");
const R = require("../src/rules");
const E = require("../src/engine");

let base, server;
function client() {
  const jar = {};
  return async (path, { method = "GET", form, json, headers = {}, raw } = {}) => {
    const h = { ...headers, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), origin: base };
    let b;
    if (form) { b = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
    if (json) { b = JSON.stringify(json); h["content-type"] = "application/json"; }
    const r = await fetch(base + path, { method, headers: h, body: b, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = raw ? Buffer.from(await r.arrayBuffer()) : await r.text();
    return { status: r.status, location: r.headers.get("location"), text, json: () => JSON.parse(text), type: r.headers.get("content-type") };
  };
}
const ok200 = (r, what) => { assert.equal(r.status, 200, `${what}: HTTP ${r.status} ${String(r.text).slice(0, 300)}`); return r; };
const xlsx = async (buf) => { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; };
async function login(c, email, pw) { const r = await c("/login", { method: "POST", form: { email, password: pw, next: "/" } }); assert.equal(r.status, 302); return r.location; }

test.before(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await init();
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { server.close(); await pool.end(); });

test("cycling development hub", async (t) => {
  const admin = client();
  await login(admin, "admin@test.local", "first-Password-1");
  await admin("/account/password", { method: "POST", form: { current: "first-Password-1", password: "Second-Password-2" } });
  const today = R.todayLocal();

  await t.test("hub shows the three areas", async () => {
    const r = ok200(await admin("/"), "hub");
    for (const s of ["WMN Moving FWD", "Corporate Cycling", "Cycling Development team"]) assert.match(r.text, new RegExp(s));
    ok200(await admin("/wmf"), "wmf home");
  });

  await t.test("WMF monthly export matches the engine", async () => {
    await tx(async (c) => {
      await R.ensureCoreRides(c);
      const m1 = await R.createMember(c, { full_name: "Amal Test", email: "amal@example.org", mobile: "0501234567", waiver_consent: true }, "test", "test");
      const m2 = await R.createMember(c, { full_name: "Bea Test", email: "bea@example.org", mobile: "0501234568", waiver_consent: true }, "test", "test");
      for (const [m, d] of [[m1, E.helpers.addDays(today, -40)], [m2, E.helpers.addDays(today, -40)], [m1, E.helpers.addDays(today, -3)]])
        await R.addParticipation(c, { member: m, recordType: "Attendance", date: d + "T07:00:00", activityId: "RIDE-WEDNESDAY-SOCIAL", activityName: "Wednesday Social", activityType: "Community Ride", status: "Attended", source: "WMF QR Attendance Scanner", dedupeKey: `ride|${m.member_id}|${d}|x` }, "test");
      await c.query("INSERT INTO activities (activity_id, name, kind, status) VALUES ('ACT-TEST-EVENT','Test Workshop','event','Active')");
      await R.addParticipation(c, { member: m2, recordType: "Event Registration", date: today + "T09:00:00", activityId: "ACT-TEST-EVENT", activityName: "Test Workshop", activityType: "Event Registration", status: "Registered", source: "WMF App Event Registration", dedupeKey: "event|x" }, "test");
    });
    const from = E.helpers.addMonths(today.slice(0, 7), -2), to = today.slice(0, 7);
    const r = await admin(`/api/wmf/monthly.xlsx?from=${from}&to=${to}`, { raw: true });
    assert.equal(r.status, 200); assert.match(r.type, /spreadsheetml/);
    const wb = await xlsx(r.text);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Monthly summary", "Rides by month", "Events by month", "Impact", "About"]);
    const ws = wb.getWorksheet("Monthly summary");
    const rows = []; ws.eachRow((row, n) => { if (n >= 4 && /\d{4}$/.test(String(row.getCell(1).value))) rows.push(row.values.slice(1)); });
    assert.equal(rows.length, 3);
    const ride = rows.reduce((a, r) => a + (r[2] || 0), 0), ev = rows.reduce((a, r) => a + (r[5] || 0), 0);
    assert.equal(ride, 3, "three ride check-ins");
    assert.equal(ev, 1, "one event participation");
    ok200(await admin("/dashboard"), "dashboard");
  });

  await t.test("WMF members: details to spot the same person twice", async () => {
    await tx(async (c) => {
      await R.createMember(c, { full_name: "Rhea Sevilla", email: "rhea.s@example.org", mobile: "0507770001", waiver_consent: true }, "test", "WMF App Registration");
      await R.createMember(c, { full_name: "Sevilla  Rhéa", email: "rhea.work@example.org", mobile: "0507770002", waiver_consent: true }, "test", "WMF Staff Entry");
    });
    const d = ok200(await admin("/admin/duplicates"), "duplicates");
    assert.match(d.text, /Rhea Sevilla/); assert.match(d.text, /Sevilla \s*Rh/);
    assert.doesNotMatch(d.text, /rhea\.work@example\.org/, "hidden until asked");
    const shown = ok200(await admin("/admin/duplicates?contact=show"), "duplicates with contacts");
    assert.match(shown.text, /rhea\.work@example\.org/); assert.match(shown.text, /971507770002|0507770002/);
    const list = ok200(await admin("/members?sort=name&contact=show"), "members list");
    assert.match(list.text, /Possible duplicate/); assert.match(list.text, /rhea\.s@example\.org/);
    assert.ok((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action = 'member.contact_view'")).rows[0].n >= 2, "views are logged");
    // a ride lead never sees full contact details on the list
    await admin("/admin/users", { method: "POST", form: { email: "lead@test.local", name: "Ride Lead", role: "coordinator" } });
    await pool.query("UPDATE users SET password_hash = $2, must_change = false WHERE email = $1", ["lead@test.local", await require("bcryptjs").hash("Lead-Password-1", 4)]);
    const lead = client(); await login(lead, "lead@test.local", "Lead-Password-1");
    const ll = ok200(await lead("/members?sort=name&contact=show"), "lead list");
    assert.doesNotMatch(ll.text, /rhea\.s@example\.org/); assert.match(ll.text, /Possible duplicate/);
  });

  let co;
  await t.test("corporate import commit (direct)", { skip: !TRACKER && "set TEST_TRACKER" }, async () => {
    const { parseTracker, commitTracker } = require("../src/corpimport");
    const parsed = await parseTracker(fs.readFileSync(TRACKER));
    const out = await commitTracker(parsed, "admin@test.local", "tracker.xlsx");
    assert.equal(out.participants, 109);
    assert.ok(out.checkins > 300);
    const r = ok200(await admin("/corporate?period=all"), "corporate dashboard");
    assert.match(r.text, /L&#39;IMAD|L'IMAD/);
    for (const p of ["/corporate/attendance?company=LIMAD&period=year&p=2025", "/corporate/events?period=all", "/corporate/participants?company=NMDC", "/corporate/qr", "/corporate/scan",
      "/corporate/report?period=all", "/corporate/report?company=NMDC&period=year&p=2026", "/corporate/qr/NMDC/poster", "/corporate/qr/LIMAD/cards"]) ok200(await admin(p), p);
    const x = await admin("/corporate/report.xlsx?period=all", { raw: true }); assert.equal(x.status, 200);
    const wb = await xlsx(x.text); assert.ok(wb.getWorksheet("Monthly"));
    const tr = await admin("/corporate/export.xlsx", { raw: true }); assert.equal(tr.status, 200);
    const twb = await xlsx(tr.text); assert.deepEqual(twb.worksheets.map((w) => w.name), ["L'IMAD", "NMDC", "Aurora", "Master Data"]);
  });

  await t.test("corporate QR self check-in, scanner and ticking names", async () => {
    co = (await pool.query("SELECT * FROM corp_companies WHERE code = 'NMDC'")).rows[0];
    // make today a ride day for NMDC
    await pool.query("UPDATE corp_companies SET checkin_mode = 'self' WHERE code = 'NMDC'");
    await pool.query("UPDATE corp_companies SET ride_days = $2 WHERE code = $1", ["NMDC", ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(today + "T12:00:00Z").getUTCDay()]]);
    const pub = client();
    const g = ok200(await pub("/c/" + co.checkin_token), "public check-in page");
    assert.match(g.text, /weekly ride/);
    const r1 = ok200(await pub("/c/" + co.checkin_token, { method: "POST", form: { session: "ride", full_name: "Sameera Al Ameri", email: "" } }), "check-in");
    assert.match(r1.text, /Thanks, Sameera|Thanks/);
    const r2 = ok200(await pub("/c/" + co.checkin_token, { method: "POST", form: { session: "ride", full_name: "Al Ameri Sameera" } }), "repeat");
    assert.match(r2.text, /already in/);
    const r3 = ok200(await pub("/c/" + co.checkin_token, { method: "POST", form: { session: "ride", full_name: "Brand New Person", email: "new@nmdc.example", community: "Emirati" } }), "new person");
    assert.match(r3.text, /Welcome to the programme/);
    assert.equal((await pub("/c/not-a-token")).status, 404);
    const s = (await pool.query("SELECT * FROM corp_sessions WHERE company = 'NMDC' AND session_date = $1", [today])).rows[0];
    assert.ok(s, "today's session was created");
    const n = (await pool.query("SELECT count(*)::int n FROM corp_attendance WHERE session_id = $1", [s.id])).rows[0].n;
    assert.equal(n, 2);
    // staff scanner with a personal code
    const p = (await pool.query("SELECT * FROM corp_participants WHERE company = 'NMDC' ORDER BY id OFFSET 5 LIMIT 1")).rows[0];
    const sc = await admin("/api/corp/scan", { method: "POST", json: { code: "CORP-" + p.pid, session: String(s.id) } });
    assert.equal(sc.json().status, "ok");
    assert.equal((await admin("/api/corp/scan", { method: "POST", json: { code: "WMF-000001", session: String(s.id) } })).json().status, "error");
    // tick names on the session page
    ok200(await admin("/corporate/session/" + s.id), "session page");
    const ids = (await pool.query("SELECT participant_id FROM corp_attendance WHERE session_id = $1", [s.id])).rows.map((x) => String(x.participant_id));
    const r = await admin(`/corporate/session/${s.id}/attendance`, { method: "POST", form: new URLSearchParams([...ids.slice(1).map((i) => ["p", i])]) });
    assert.equal(r.status, 302);
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_attendance WHERE session_id = $1", [s.id])).rows[0].n, ids.length - 1);
    // an event with a headcount
    const ev = await admin("/corporate/sessions", { method: "POST", form: { company: "AURORA", title: "Aurora Bike Fit Workshop", session_date: today, kind: "Workshop", status: "Held", headcount: "11" } });
    assert.equal(ev.status, 302);
    const evp = ok200(await admin("/corporate/events"), "events");
    assert.match(evp.text, /Aurora Bike Fit Workshop/);
  });

  await t.test("personal QR codes: staff get their own code and ID, ride lead scans or types it", { skip: !TRACKER && "set TEST_TRACKER" }, async () => {
    const lim = (await pool.query("SELECT * FROM corp_companies WHERE code = 'LIMAD'")).rows[0];
    assert.equal(lim.checkin_mode, "personal");
    const pub = client();
    assert.match(ok200(await pub("/c/" + lim.checkin_token), "get-qr page").text, /personal QR code/);
    // existing person with no email on file: found by name, email saved, code and record shown
    const r = ok200(await pub("/c/" + lim.checkin_token, { method: "POST", form: { full_name: "Jaap Kalkman", email: "jaap@limad.example" } }), "existing person");
    assert.match(r.text, /LIMAD-0001/); assert.match(r.text, /data:image\/png;base64/); assert.match(r.text, /My attendance/);
    // same name, different email: refused
    const r2 = ok200(await pub("/c/" + lim.checkin_token, { method: "POST", form: { full_name: "Kalkman Jaap", email: "someone@else.example" } }), "other email");
    assert.match(r2.text, /different email/); assert.doesNotMatch(r2.text, /LIMAD-0001/);
    // new person gets a new ID
    const r3 = ok200(await pub("/c/" + lim.checkin_token, { method: "POST", form: { full_name: "Nadia New", email: "nadia@limad.example" } }), "new person");
    const pid = /LIMAD-\d{4}/.exec(r3.text)[0];
    assert.notEqual(pid, "LIMAD-0001");
    // ride lead: scan the code, and type an ID for someone who forgot theirs
    const s = (await pool.query("INSERT INTO corp_sessions (company, session_date, kind, title, status) VALUES ('LIMAD', $1, 'Weekly ride', '', 'Held') ON CONFLICT DO NOTHING RETURNING id", [today])).rows[0]
      || (await pool.query("SELECT id FROM corp_sessions WHERE company = 'LIMAD' AND session_date = $1 AND kind = 'Weekly ride'", [today])).rows[0];
    assert.equal((await admin("/api/corp/scan", { method: "POST", json: { code: "CORP-" + pid, session: String(s.id) } })).json().status, "ok");
    assert.equal((await admin("/api/corp/scan", { method: "POST", json: { code: "limad 1", session: String(s.id) } })).json().status, "ok");
    assert.equal((await admin("/api/corp/scan", { method: "POST", json: { code: "LIMAD-0001", session: String(s.id) } })).json().status, "duplicate");
    // the record shows today's session
    assert.match(ok200(await pub("/c/" + lim.checkin_token, { method: "POST", form: { full_name: "Nadia New", email: "nadia@limad.example" } }), "record").text, /Sessions attended[\s\S]*?>1</);
    ok200(await admin("/corporate/qr"), "qr page"); ok200(await admin("/corporate/qr/LIMAD/poster"), "poster"); ok200(await admin("/corporate/scan"), "scan page");
  });

  await t.test("sponsor limited to one partner", async () => {
    await admin("/admin/users", { method: "POST", form: { email: "sponsor@nmdc.example", name: "NMDC Sponsor", role: "sponsor", company: "NMDC" } });
    await pool.query("UPDATE users SET password_hash = $2, must_change = false WHERE email = $1", ["sponsor@nmdc.example", await require("bcryptjs").hash("Sponsor-Password-1", 4)]);
    const sp = client();
    assert.equal(await login(sp, "sponsor@nmdc.example", "Sponsor-Password-1"), "/corporate");
    const d = ok200(await sp("/corporate"), "sponsor dashboard");
    assert.doesNotMatch(d.text, /Aurora Bike Fit/);
    assert.doesNotMatch(d.text, /Most regular participants/);
    const rep = ok200(await sp("/corporate/report?company=LIMAD"), "sponsor report");
    assert.match(rep.text, /NMDC/); assert.doesNotMatch(rep.text, /<h2>Corporate Cycling Programme · L/);
    assert.equal((await sp("/dashboard")).status, 302);
    assert.equal((await sp("/corporate/attendance")).status, 403);
    assert.equal((await sp("/department")).status, 302);
  });

  await t.test("department: staff, attendance, leave and HR exports", async () => {
    await admin("/department/staff", { method: "POST", form: { full_name: "Rona Test", email: "admin@test.local", employee_no: "E100", job_title: "Programme Manager", leave_entitlement: "22" } });
    await admin("/department/staff", { method: "POST", form: { full_name: "Jas Coach", email: "jas@test.local", employee_no: "E101", job_title: "Coach", leave_entitlement: "22" } });
    const staff = (await pool.query("SELECT * FROM dept_staff ORDER BY id")).rows;
    assert.equal(staff.length, 2);
    // self check-in
    await admin("/department/me/clock", { method: "POST", form: { action: "Present" } });
    const me = ok200(await admin("/department/me"), "me");
    assert.match(me.text, /Present/);
    // a leave request across a weekend: only working days count
    const mon = (() => { let d = E.helpers.addDays(today, 7); while (new Date(d + "T12:00:00Z").getUTCDay() !== 1) d = E.helpers.addDays(d, 1); return d; })();
    await admin("/department/me/leave", { method: "POST", form: { leave_type: "Annual", start_date: E.helpers.addDays(mon, 3), end_date: E.helpers.addDays(mon, 7) } }); // Thu → next Mon
    const lv = (await pool.query("SELECT * FROM dept_leave")).rows[0];
    assert.equal(+lv.days, 3); assert.equal(lv.status, "Pending");
    // overlapping request refused
    await admin("/department/me/leave", { method: "POST", form: { leave_type: "Annual", start_date: E.helpers.addDays(mon, 4), end_date: E.helpers.addDays(mon, 4) } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM dept_leave")).rows[0].n, 1);
    await admin(`/department/leave/${lv.id}/decide`, { method: "POST", form: { decision: "Approved", note: "Enjoy" } });
    assert.equal((await pool.query("SELECT status FROM dept_leave WHERE id = $1", [lv.id])).rows[0].status, "Approved");
    // admin records a range for Jas
    await admin("/department/attendance/set", { method: "POST", form: { staff_id: String(staff[1].id), status: "Field/Event", from: E.helpers.addDays(today, -6), to: today, notes: "Liwa camp prep" } });
    for (const p of ["/department", "/department/attendance", "/department/leave", "/department/staff", "/department/hr"]) ok200(await admin(p), p);
    const ax = await admin(`/department/export/attendance.xlsx?month=${today.slice(0, 7)}`, { raw: true }); assert.equal(ax.status, 200);
    const awb = await xlsx(ax.text); assert.deepEqual(awb.worksheets.map((w) => w.name), ["Month grid", "Daily records"]);
    const lx = await admin(`/department/export/leave.xlsx?year=${mon.slice(0, 4)}`, { raw: true }); assert.equal(lx.status, 200);
    // HR feed
    const pub = client();
    assert.equal((await pub("/api/hr/attendance.csv?key=wrong")).status, 403);
    const csv = await pub(`/api/hr/attendance.csv?key=${process.env.HR_FEED_TOKEN}&from=${E.helpers.addDays(today, -6)}&to=${today}`);
    assert.equal(csv.status, 200); assert.match(csv.text, /Jas Coach,jas@test.local/); assert.match(csv.text, /Field\/Event/);
    const lcsv = await pub(`/api/hr/leave.csv?key=${process.env.HR_FEED_TOKEN}&year=${mon.slice(0, 4)}`);
    assert.match(lcsv.text, /Approved/);
  });
});
