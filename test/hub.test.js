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
  return async (path, { method = "GET", form, json, headers = {}, raw, multipart } = {}) => {
    const h = { ...headers, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), origin: base };
    let b;
    if (form) { b = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
    if (json) { b = JSON.stringify(json); h["content-type"] = "application/json"; }
    if (multipart) b = multipart;
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
    // NMDC's regular ride falls on today
    await pool.query("UPDATE corp_schedules SET weekday = $1, week = 0, starts = $2 WHERE company = 'NMDC'", [new Date(today + "T12:00:00Z").getUTCDay(), today]);
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

  await t.test("scanner link: one simple page for any staff, WMF and corporate", { skip: !TRACKER && "set TEST_TRACKER" }, async () => {
    const r = await admin("/admin/scanners", { method: "POST", form: { label: "Jas phone", scope: "both" } });
    assert.equal(r.status, 302);
    const l = (await pool.query("SELECT * FROM scanner_links WHERE label = 'Jas phone'")).rows[0];
    ok200(await admin("/admin/scanners"), "admin scanner links");
    const pub = client();
    const pg = ok200(await pub("/s/" + l.token), "scanner page");
    assert.match(pg.text, /Attendance scanner/); assert.match(pg.text, /data-mode="corp"/);
    assert.doesNotMatch(pg.text, /shell-nav|sub-nav/, "no hub menus");
    assert.equal((await pub("/s/" + l.token + "/manifest.webmanifest")).status, 200);
    // corporate: the "ride today" option works even on a non-ride day
    const cs = await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: "CORP-NMDC-0010", session: "ride:AUTO" } });
    assert.equal(cs.json().status, "ok", cs.text);
    assert.equal((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: "nmdc 10", session: "ride:AUTO" } })).json().status, "duplicate");
    assert.equal((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: "LIMAD-0002", session: "ride:AUTO" } })).json().status, "ok", "each person goes to their own company's ride");
    // WMF: scanned code and typed number
    const m = (await pool.query("SELECT member_id FROM members WHERE merged_into IS NULL ORDER BY member_id LIMIT 1")).rows[0];
    const ws = await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: m.member_id, activityId: "RIDE-MORNING" } });
    assert.ok(["ok", "duplicate"].includes(ws.json().status), ws.text);
    assert.equal((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: String(+m.member_id.slice(4)), activityId: "RIDE-MORNING" } })).json().status, "duplicate");
    assert.equal((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: "hello", activityId: "RIDE-MORNING" } })).json().status, "error");
    // WMF: no QR code? search by name, email or phone; check in from the result
    await tx((c) => R.createMember(c, { full_name: "Fatima Search Test", email: "fatima.search@example.org", mobile: "0507654321", waiver_consent: true }, "test", "test"));
    const found = (await pub(`/s/${l.token}/find`, { method: "POST", json: { q: "fatima sea" } })).json();
    assert.equal(found.length, 1); assert.doesNotMatch(JSON.stringify(found), /fatima\.search@example\.org|0507654321/, "contact details stay hidden");
    assert.equal((await pub(`/s/${l.token}/find`, { method: "POST", json: { q: "7654321" } })).json()[0].id, found[0].id, "found by phone");
    assert.equal((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: found[0].id, activityId: "RIDE-MORNING" } })).json().status, "ok");
    // WMF: a new rider registered on the spot, checked in, with a personal QR link to send
    const wk = (await pub(`/s/${l.token}/walkin`, { method: "POST", json: { full_name: "Brand New Rider", mobile: "0501112299", email: "new.rider@example.org", waiver_consent: "1", activityId: "RIDE-MORNING" } })).json();
    assert.equal(wk.status, "ok"); assert.equal(wk.created, true); assert.equal(wk.phone, "971501112299"); assert.match(wk.qrUrl, /\/q\/WMF-\d{6}\.[\w-]{12}$/); assert.match(wk.qr, /^data:image\/png/);
    const again = (await pub(`/s/${l.token}/walkin`, { method: "POST", json: { full_name: "Brand New Rider", mobile: "050 111 2299", waiver_consent: "1", activityId: "RIDE-MORNING" } })).json();
    assert.equal(again.created, false, "same phone: no second member"); assert.equal(again.status, "duplicate");
    const qp = await pub(new URL(wk.qrUrl).pathname); assert.equal(qp.status, 200); assert.match(qp.text, /Hi Brand!/);
    assert.equal((await pub(new URL(wk.qrUrl).pathname.replace(/\.[\w-]{12}$/, ".AAAAAAAAAAAA"))).status, 404, "guessed links don't work");
    assert.equal((await pub(`/s/${l.token}/walkin`, { method: "POST", json: { full_name: "No Waiver", mobile: "0501112200", activityId: "RIDE-MORNING" } })).json().status, "error");
    // scope and switching off
    await admin(`/admin/scanners/${l.id}`, { method: "POST", form: { label: "Jas phone", scope: "wmf" } });
    assert.match((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: "CORP-NMDC-0011", session: "ride:NMDC" } })).json().message, /WMF only/);
    await admin(`/admin/scanners/${l.id}`, { method: "POST", form: { label: "Jas phone", scope: "wmf", active: "0" } });
    assert.equal((await pub("/s/" + l.token)).status, 404);
    assert.equal((await pub(`/s/${l.token}/scan`, { method: "POST", json: { code: m.member_id, activityId: "RIDE-MORNING" } })).status, 403);
    const who = (await pool.query("SELECT method, created_by FROM corp_attendance ORDER BY id DESC LIMIT 1")).rows[0];
    assert.equal(who.created_by, "Scanner link: Jas phone");
  });

  await t.test("launch: staff list upload, work-email rule, list only, privacy, backup, ping", { skip: !TRACKER && "set TEST_TRACKER" }, async () => {
    // a company's HR list as CSV: one person already here without an email, one new person, one row with no email
    const csv = "Full name,Work email,Employee number,Gender,Emirati / Expat\nShaza Alkharat,shaza@nmdc.ae,N77,Female,UAE\nNew Starter,new.starter@nmdc.ae,N78,F,Indian\nNo Mail,,N79,,\n";
    const fd = new FormData(); fd.append("company", "NMDC"); fd.append("file", new Blob([csv], { type: "text/csv" }), "nmdc.csv");
    const pv = ok200(await admin("/corporate/participants/upload", { method: "POST", multipart: fd }), "list preview");
    assert.match(pv.text, /New Starter/); assert.match(pv.text, /No email/);
    const tok = /name="token" value="([a-f0-9]+)"/.exec(pv.text)[1];
    assert.equal((await admin("/corporate/participants/upload/commit", { method: "POST", form: { token: tok } })).status, 302);
    const shaza = (await pool.query("SELECT * FROM corp_participants WHERE company = 'NMDC' AND email = 'shaza@nmdc.ae'")).rows[0];
    assert.ok(shaza && shaza.pid === "NMDC-0004" && shaza.employee_no === "N77" && shaza.community === "Emirati", "existing person got email, employee no and community");
    assert.equal((await pool.query("SELECT community FROM corp_participants WHERE email = 'new.starter@nmdc.ae'")).rows[0].community, "Expat");
    const before = (await pool.query("SELECT count(*)::int n FROM corp_participants WHERE company = 'NMDC'")).rows[0].n;
    ok200(await admin("/corporate/participants/template.xlsx", { raw: true }), "template");
    await pool.query("UPDATE corp_companies SET email_domain = 'nmdc.ae', qr_access = 'list' WHERE code = 'NMDC'");
    const nm = (await pool.query("SELECT * FROM corp_companies WHERE code = 'NMDC'")).rows[0];
    await pool.query("UPDATE corp_companies SET checkin_mode = 'personal' WHERE code = 'NMDC'");
    const pub = client();
    const form = ok200(await pub("/c/" + nm.checkin_token), "qr page");
    assert.match(form.text, /Privacy: your name, work email/); assert.match(form.text, /@nmdc\.ae/);
    // wrong email ending refused; email not on the list refused
    assert.match(ok200(await pub("/c/" + nm.checkin_token, { method: "POST", form: { full_name: "Shaza Alkharat", email: "shaza@gmail.com" } }), "domain").text, /work email \(ending @nmdc\.ae\)/);
    assert.match(ok200(await pub("/c/" + nm.checkin_token, { method: "POST", form: { full_name: "Someone Else", email: "someone@nmdc.ae" } }), "list").text, /couldn&#39;t find|couldn't find/);
    assert.match(ok200(await pub("/c/" + nm.checkin_token, { method: "POST", form: { full_name: "Shaza Alkharat", email: "shaza@nmdc.ae" } }), "on the list").text, /NMDC-0004/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_participants WHERE company = 'NMDC'")).rows[0].n, before, "nobody added in list-only mode");
    // backup holds corporate and department sheets
    const bk = await admin("/admin/export.xlsx", { method: "POST", form: { password: "Second-Password-2" }, raw: true });
    assert.equal(bk.status, 200);
    const names = (await xlsx(bk.text)).worksheets.map((w) => w.name);
    for (const n of ["Corporate Participants", "Corporate Sessions", "Corporate Attendance", "Department Staff", "Department Leave", "Department Attendance", "Scanner Links"]) assert.ok(names.includes(n), n + " in backup");
    const ping = await pub("/ping"); assert.equal(ping.status, 200); assert.equal(ping.text, "ok");
  });

  await t.test("schedules: regular sessions per company, adjustable, cancel a date", async () => {
    const sch = (await pool.query("SELECT company, kind, title, weekday, week, start_time FROM corp_schedules ORDER BY id")).rows;
    assert.deepEqual(sch.filter((x) => x.company !== "NMDC").map((x) => [x.company, x.kind, x.title, x.weekday, x.week, x.start_time]), [
      ["LIMAD", "Weekly ride", "", 4, 0, "06:00"], ["AURORA", "Weekly ride", "Aurora Ride", 4, 1, "17:00"], ["AURORA", "Running", "Aurora Running", 4, 2, "17:00"], ["AURORA", "Yoga", "Aurora Yoga", 4, 3, "17:00"]]);
    ok200(await admin("/corporate/schedule"), "schedule page");
    // Aurora Yoga moved to today; it shows on the scanner and the AUTO option puts Aurora staff into it
    const dow = new Date(today + "T12:00:00Z").getUTCDay(), wk = Math.ceil(+today.slice(8) / 7);
    const yoga = (await pool.query("SELECT id FROM corp_schedules WHERE title = 'Aurora Yoga'")).rows[0];
    const r = await admin(`/corporate/schedule/${yoga.id}`, { method: "POST", form: { kind: "Yoga", title: "Aurora Yoga", week: String(wk > 4 ? -1 : wk), weekday: String(dow), start_time: "17:30", starts: today, active: "1" } });
    assert.equal(r.status, 302);
    // on the first Thursday of a month Aurora Ride is on today as well: switch it off so AUTO has one choice
    await pool.query("UPDATE corp_schedules SET active = false WHERE title = 'Aurora Ride'");
    const C = require("../src/corpdata");
    const aur = (await pool.query("SELECT * FROM corp_companies WHERE code = 'AURORA'")).rows[0];
    const ts = await C.todaysSessions(pool, aur);
    assert.ok(ts.some((s) => s.virtual && s.title === "Aurora Yoga" && s.start_time === "17:30"), "planned yoga appears today");
    const p = await tx((c) => C.createParticipant(c, { company: "AURORA", full_name: "Aurora Person", email: "ap@aurora.example" }, "test", "test"));
    const out = await tx((c) => C.corpScan(c, { code: "CORP-" + p.pid, session: "ride:AUTO", by: "test", codes: ["AURORA"] }));
    assert.equal(out.status, "ok");
    const sess = (await pool.query("SELECT s.* FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = $1", [p.id])).rows[0];
    assert.equal(sess.title, "Aurora Yoga"); assert.equal(sess.start_time, "17:30");
    // cancel next week's LIMAD ride; it shows as cancelled and isn't offered
    const lim = (await pool.query("SELECT id FROM corp_schedules WHERE company = 'LIMAD'")).rows[0];
    let thu = today; while (new Date(thu + "T12:00:00Z").getUTCDay() !== 4 || thu === today) thu = E.helpers.addDays(thu, 1);
    await admin(`/corporate/schedule/${lim.id}/date`, { method: "POST", form: { date: thu, action: "cancel", reason: "National Day" } });
    const can = (await pool.query("SELECT status, remarks FROM corp_sessions WHERE company = 'LIMAD' AND session_date = $1", [thu])).rows[0];
    assert.deepEqual(can, { status: "Cancelled", remarks: "National Day" });
    await admin(`/corporate/schedule/${lim.id}/date`, { method: "POST", form: { date: thu, action: "restore" } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_sessions WHERE company = 'LIMAD' AND session_date = $1", [thu])).rows[0].n, 0);
    const dash = ok200(await admin("/corporate"), "dashboard");
    assert.match(dash.text, /Every Thursday · 06:00/);
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
    const staff = (await pool.query("SELECT * FROM dept_staff WHERE email IS NOT NULL ORDER BY id")).rows;
    assert.equal(staff.length, 2);
    assert.equal((await admin("/department/me")).location, "/department/leave");
    // a leave plan across a weekend: only working days count; tentative, then confirmed
    const mon = (() => { let d = E.helpers.addDays(today, 7); while (new Date(d + "T12:00:00Z").getUTCDay() !== 1) d = E.helpers.addDays(d, 1); return d; })();
    await admin("/department/leave", { method: "POST", form: { staff_id: String(staff[0].id), leave_type: "Annual", start_date: E.helpers.addDays(mon, 3), end_date: E.helpers.addDays(mon, 7), plan: "Tentative" } }); // Thu → next Mon
    const lv = (await pool.query("SELECT * FROM dept_leave")).rows[0];
    assert.equal(+lv.days, 3); assert.equal(lv.status, "Tentative");
    await admin(`/department/leave/${lv.id}`, { method: "POST", form: { do: "confirm" } });
    assert.equal((await pool.query("SELECT status FROM dept_leave WHERE id = $1", [lv.id])).rows[0].status, "Approved");
    for (const p of ["/department/schedule", "/department/leave", "/department/staff", "/department/share"]) ok200(await admin(p), p);
    assert.equal((await admin("/department")).location, "/department/schedule");
    const lx = await admin(`/department/export/leave.xlsx?year=${mon.slice(0, 4)}`, { raw: true }); assert.equal(lx.status, 200);
    // ----- simple schedule, leave plans, HR timesheet, personal link for the manager
    const DS = require("../src/deptschedule");
    const monday = DS.mondayOf(today), jas = staff[1];
    await admin("/department/schedule/entries", { method: "POST", form: new URLSearchParams([["staff_id", String(jas.id)], ["activity", "Office"], ["work_date", monday], ["start_time", "09:00"], ["end_time", "17:00"],
      ["repeat", "1"], ["repeat", "2"], ["repeat", "3"], ["repeat", "4"], ["repeat", "5"], ["until", E.helpers.addDays(monday, 6)]]) });
    await admin("/department/schedule/entries", { method: "POST", form: { staff_id: String(jas.id), activity: "Corporate Ride", work_date: E.helpers.addDays(monday, 3), start_time: "06:00", end_time: "08:00", note: "L'IMAD" } });
    const bad = await admin("/department/schedule/entries", { method: "POST", form: { staff_id: String(jas.id), activity: "Office", work_date: monday, start_time: "10:00", end_time: "09:00" } });
    assert.match(bad.location, /err=/);
    assert.equal(await DS.weekHours(jas.id, monday), 42);
    for (const v of ["week", "month"]) assert.match(ok200(await admin(`/department/schedule?view=${v}&date=${E.helpers.addDays(monday, 3)}`), v).text, v === "week" ? /Corporate Ride/ : /sc-mt[^>]*>6–8</);
    await admin("/department/schedule/copy-week", { method: "POST", form: { staff_id: String(jas.id), monday: E.helpers.addDays(monday, 7) } });
    assert.equal(await DS.weekHours(jas.id, E.helpers.addDays(monday, 7)), 42);
    const hwb = await xlsx((await admin(`/department/schedule/export.xlsx?month=${today.slice(0, 7)}`, { raw: true })).text);
    assert.deepEqual(hwb.worksheets[0].getRow(3).values.slice(1), ["Name", "Days worked", "Total hours", "Leave days"]);
    assert.ok(hwb.getWorksheet("Jas Coach"));
    ok200(await admin("/department/leave"), "leave page");
    // personal link for the manager: sees the department, edits only her own time and leave
    await admin("/department/staff", { method: "POST", form: { full_name: "Manager Person", leave_entitlement: "22" } });
    const mgrS = (await pool.query("SELECT * FROM dept_staff WHERE full_name = 'Manager Person'")).rows[0];
    await admin("/department/share", { method: "POST", form: { staff_id: String(mgrS.id) } });
    const link = (await pool.query("SELECT * FROM dept_share_links WHERE staff_id = $1", [mgrS.id])).rows[0];
    const mgr = client(), b0 = `/d/${link.token}`;
    const sv = ok200(await mgr(`${b0}/schedule?date=${monday}`), "manager week");
    assert.match(sv.text, /Corporate Ride/); assert.doesNotMatch(sv.text, /href="\/corporate|href="\/wmf|href="\/admin/);
    assert.equal((sv.text.match(/sc-plus/g) || []).length, 7, "+ only on her own row");
    await mgr(`${b0}/schedule/entries`, { method: "POST", form: { staff_id: String(mgrS.id), activity: "Office", work_date: monday, start_time: "08:30", end_time: "16:30" } });
    await mgr(`${b0}/schedule/entries`, { method: "POST", form: { staff_id: String(jas.id), activity: "Office", work_date: monday, start_time: "06:00", end_time: "07:00" } }); // someone else: refused
    assert.equal(await DS.weekHours(mgrS.id, monday), 8);
    assert.equal(await DS.weekHours(jas.id, monday), 42);
    await mgr(`${b0}/leave`, { method: "POST", form: { staff_id: String(mgrS.id), start_date: E.helpers.addDays(monday, 14), end_date: E.helpers.addDays(monday, 15), leave_type: "Annual", plan: "Tentative" } });
    const ml = (await pool.query("SELECT * FROM dept_leave WHERE staff_id = $1", [mgrS.id])).rows[0];
    assert.equal(ml.status, "Tentative");
    await mgr(`${b0}/leave/${ml.id}`, { method: "POST", form: { do: "confirm" } });
    assert.equal((await pool.query("SELECT status FROM dept_leave WHERE id = $1", [ml.id])).rows[0].status, "Approved");
    const own = (await pool.query("SELECT id FROM dept_leave WHERE staff_id = $1 LIMIT 1", [jas.id])).rows[0];
    if (own) { await mgr(`${b0}/leave/${own.id}`, { method: "POST", form: { do: "remove" } }); assert.notEqual((await pool.query("SELECT status FROM dept_leave WHERE id = $1", [own.id])).rows[0].status, "Cancelled"); }
    assert.equal((await mgr(`${b0}/schedule/export.xlsx`, { raw: true })).status, 200);
    assert.equal((await mgr("/department/schedule")).status, 302, "the hub still needs a sign-in");
    // view-only link for HR: sees everything in the department, downloads the timesheet, changes nothing
    await admin("/department/share", { method: "POST", form: { staff_id: "" } });
    const hrL = (await pool.query("SELECT * FROM dept_share_links WHERE staff_id IS NULL ORDER BY id DESC LIMIT 1")).rows[0];
    const hr = client(), hb = `/d/${hrL.token}`;
    const hv = ok200(await hr(`${hb}/schedule?date=${monday}`), "hr week");
    assert.match(hv.text, /view only/); assert.match(hv.text, /HR timesheet/); assert.doesNotMatch(hv.text, /sc-plus|Add my time|Copy last week/);
    assert.doesNotMatch(ok200(await hr(`${hb}/leave`), "hr leave").text, /Add leave|name="do"/);
    assert.equal((await hr(`${hb}/schedule/export.xlsx?month=${today.slice(0, 7)}`, { raw: true })).status, 200);
    const before = await DS.weekHours(jas.id, monday);
    await hr(`${hb}/schedule/entries`, { method: "POST", form: { staff_id: String(jas.id), activity: "Office", work_date: monday, start_time: "05:00", end_time: "06:00" } });
    assert.equal(await DS.weekHours(jas.id, monday), before, "view-only link can't change anything");
    await admin(`/department/share/${link.id}`, { method: "POST", form: { active: "0" } });
    assert.equal((await mgr(`${b0}/schedule`)).status, 404);

    // HR feed
    const pub = client();
    assert.equal((await pub("/api/hr/attendance.csv?key=wrong")).status, 403);
    const csv = await pub(`/api/hr/attendance.csv?key=${process.env.HR_FEED_TOKEN}&from=${monday}&to=${E.helpers.addDays(monday, 6)}`);
    assert.equal(csv.status, 200); assert.match(csv.text, /Jas Coach,jas@test.local/); assert.match(csv.text, /Corporate Ride \(L'IMAD\)/);
    const lcsv = await pub(`/api/hr/leave.csv?key=${process.env.HR_FEED_TOKEN}&year=${mon.slice(0, 4)}`);
    assert.match(lcsv.text, /Approved/);
  });

  await t.test("WMF: held event becomes an activation, survey, social growth, report", async () => {
    const H = E.helpers, past = H.addDays(today, -5), m = past.slice(0, 7);
    // an event with a Strava link and a partner
    let r = await admin("/activities", { method: "POST", form: { name: "Test Women Ride", event_date: past, location: "Abu Dhabi", status: "Active", category: "Workshops",
      partners: "Test Partner", strava_url: "https://www.strava.com/clubs/1/group_events/9", registration_open: "1" } });
    assert.equal(r.status, 302);
    const aid = decodeURIComponent(r.location.split("/activities/")[1]);
    assert.equal((await admin("/activities", { method: "POST", form: { name: "Bad", strava_url: "https://example.com/x" } })).location, "/activities");
    const mem = await tx((c) => R.createMember(c, { full_name: "Sur Vey", email: "survey@test.local", mobile: "0501112233", gender: "Female", community: "Emirati", waiver_consent: true }, "t", "t"));
    await pool.query(`INSERT INTO participation (record_id, record_date, record_type, activity_id, activity_name, status, member_id, source, dedupe_key)
      VALUES ('REG-T1', $1, 'Event Registration', $2, 'Test Women Ride', 'Registered', $3, 'test', 'evt-t1')`, [past + " 09:00:00", aid, mem.member_id]);
    const pid = (await pool.query("SELECT id FROM participation WHERE record_id = 'REG-T1'")).rows[0].id;
    await admin(`/participation/${pid}/attended`, { method: "POST", form: { came: "1" } });
    // the date has passed: the activations page creates it, with sign-ups and who came
    ok200(await admin("/activations"), "activations");
    const act = (await pool.query("SELECT * FROM activations WHERE activity_id = $1", [aid])).rows[0];
    assert.ok(act, "activation created from the event");
    assert.equal(act.registrants, 1); assert.equal(act.participants, 1); assert.equal(act.category, "Workshops"); assert.ok(act.auto_sync);
    assert.equal((await pool.query("SELECT count(*)::int n FROM activation_partners WHERE activation_id = $1", [act.id])).rows[0].n, 1);
    ok200(await admin(`/activations/${act.id}`), "activation page");
    // survey: create, answer publicly, results
    r = await admin("/surveys", { method: "POST", form: { activation_id: String(act.id) } });
    const sid = r.location.split("/surveys/")[1];
    const tok = (await pool.query("SELECT token FROM surveys WHERE id = $1", [+sid])).rows[0].token;
    const pub = client();
    assert.match(ok200(await pub(`/f/${tok}`), "survey form").text, /How was Test Women Ride/);
    assert.match((await pub(`/f/${tok}`, { method: "POST", form: { rating: "5", again: "Yes", liked: "Great group" } })).text, /Thank you/);
    const sp = ok200(await admin(`/surveys/${sid}`), "survey results").text;
    assert.match(sp, /Great group/); assert.match(sp, /wa\.me\/971501112233/);
    // social growth
    await admin("/social", { method: "POST", form: { month: m, "whatsapp|Abu Dhabi": "110", "whatsapp|Dubai": "20", "strava|Abu Dhabi": "50" } });
    assert.ok((await pool.query("SELECT count(*)::int n FROM social_counts WHERE to_char(month,'YYYY-MM') = $1", [m])).rows[0].n >= 3);
    assert.equal((await pool.query("SELECT members FROM social_counts WHERE month = '2026-09-01' AND channel = 'whatsapp' AND city = 'Abu Dhabi'")).rows[0].members, 329, "the team's sheet is loaded at first start");
    // overview shows the database split; nav has no Scan QR
    const ov = ok200(await admin("/overview"), "overview").text;
    assert.match(ov, /Who is in the database/); assert.doesNotMatch(ov, />Scan QR</);
    // report pages and the PowerPoint
    await admin("/report/notes", { method: "POST", form: { period: `month:${m}`, strategy: "Reach new women riders", back: "/report" } });
    const rp = ok200(await admin(`/report?period=month&p=${m}`), "report").text;
    for (const x of ["Programme overview", "Test Women Ride", "Reach new women riders", "Social growth"]) assert.match(rp, new RegExp(x));
    ok200(await admin(`/report?period=quarter`), "quarter"); ok200(await admin(`/report?period=year`), "year");
    const pp = await admin(`/report.pptx?period=month&p=${m}`, { raw: true });
    assert.equal(pp.status, 200); assert.equal(pp.text.slice(0, 2).toString(), "PK");
    // the calendar share link is on the manage page
    assert.match(ok200(await admin("/calendar/manage"), "calendar manage").text, /Share the calendar with the community/);
  });

  await t.test("WMF end-of-season survey: past surveys loaded, new survey, public answers, comparison", async () => {
    const past = (await pool.query("SELECT title, (SELECT count(*)::int FROM season_answers a WHERE a.survey_id = s.id) AS n FROM season_surveys s WHERE source = 'import' ORDER BY id")).rows;
    assert.equal(past.length, 5); assert.ok(past.every((x) => x.n >= 17));
    assert.equal((await pool.query("SELECT count(*)::int n FROM season_answers WHERE answers::text ~ '@'")).rows[0].n, 0, "no email addresses kept");
    let r = await admin("/surveys/seasons/new", { method: "POST", form: { season: "Winter", year: "2027", activities: "Training Camp\nMountain Ride", rides: "Monday Madness" } });
    const id = r.location.split("/").pop();
    const sp = ok200(await admin(`/surveys/seasons/${id}`), "season survey").text;
    const tok = /\/fs\/([\w-]+)/.exec(sp)[1];
    const pub = client();
    const f = ok200(await pub(`/fs/${tok}`), "public form").text;
    assert.match(f, /Training Camp/); assert.match(f, /what held you back/i);
    const body = new URLSearchParams([["q_freq", "Weekly"], ["q_act0", "Excellent"], ["q_act1", "Didn't join"], ["q_barriers", "Location"], ["q_barriers", "Weather / heat"], ["q_org", "5"], ["q_ideas", "A beginner group on Mondays"]]).toString();
    r = await pub(`/fs/${tok}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, raw: false, multipart: body });
    assert.match(r.text, /Thank you/);
    const a = (await pool.query("SELECT answers FROM season_answers WHERE survey_id = $1", [+id])).rows[0].answers;
    assert.deepEqual(a.barriers, ["Location", "Weather / heat"]); assert.equal(a.act0, "Excellent");
    const cmp = ok200(await admin("/surveys/seasons"), "compare").text;
    for (const x of ["Where to focus", "What people keep asking for", "End of Winter Season Survey 2026", "Ride times"]) assert.match(cmp, new RegExp(x));
    ok200(await admin("/surveys"), "surveys");
    await admin(`/surveys/seasons/${id}/toggle`, { method: "POST" });
    assert.equal((await pub(`/fs/${tok}`)).status, 404);
  });

  await t.test("WMF Dubai: lead link sends rides with photos; they count as Dubai rides", async () => {
    await admin("/dubai/links", { method: "POST", form: { label: "Dubai Lead" } });
    const tok = (await pool.query("SELECT token FROM lead_links WHERE label = 'Dubai Lead'")).rows[0].token;
    const pub = client();
    assert.match(ok200(await pub(`/l/${tok}`), "lead page").text, /Which ride\?/);
    const fd = new FormData();
    fd.append("ride_type", "Thursday"); fd.append("day", today); fd.append("participants", "11");
    fd.append("photos", new Blob([Buffer.from("ffd8ffe000104a464946", "hex")], { type: "image/jpeg" }), "ride.jpg");
    let r = await fetch(`${base}/l/${tok}`, { method: "POST", body: fd, redirect: "manual", headers: { origin: base } });
    assert.equal(r.status, 303);
    const fd2 = new FormData(); fd2.append("ride_type", "Thursday"); fd2.append("day", today); fd2.append("participants", "12");
    await fetch(`${base}/l/${tok}`, { method: "POST", body: fd2, redirect: "manual", headers: { origin: base } });
    const rows = (await pool.query("SELECT r.*, (SELECT count(*)::int FROM lead_photos p WHERE p.ride_id = r.id) AS photos FROM lead_rides r")).rows;
    assert.equal(rows.length, 1, "same ride and date replaces"); assert.equal(rows[0].participants, 12); assert.equal(rows[0].photos, 1);
    const bad = new FormData(); bad.append("day", today); bad.append("participants", "5");
    assert.equal((await fetch(`${base}/l/${tok}`, { method: "POST", body: bad, headers: { origin: base } })).status, 400);
    // counted as a Dubai ride, and it doesn't hide Abu Dhabi check-ins on the same day
    const { buildData } = require("../src/snapshot");
    const P = E.prepare(await buildData());
    const dx = E.compute(P, { start: today, end: today, location: "Dubai" }, today).kpis;
    assert.equal(dx.rideAttendance, 12); assert.equal(dx.rideSessions, 1);
    assert.ok(!P.rows.some((x) => x.coveredByHistory && x.d === today));
    const adm = ok200(await admin("/dubai"), "dubai page").text;
    assert.match(adm, /Thursday ride/); assert.match(adm, /\/dubai\/photo\/\d+/);
    await admin(`/dubai/links/${(await pool.query("SELECT id FROM lead_links")).rows[0].id}`, { method: "POST", form: { active: "0" } });
    assert.equal((await pub(`/l/${tok}`)).status, 404);
  });

  await t.test("WMF marketing report: page, Excel, and a view-only link", async () => {
    const m = today.slice(0, 7);
    const pg = ok200(await admin(`/report/marketing?period=month&p=${m}`), "marketing page").text;
    for (const x of ["Ride participation", "Events &amp; impact", "Download Excel", "Share with marketing"]) assert.match(pg, new RegExp(x));
    const x = await admin(`/report/marketing.xlsx?period=month&p=${m}`, { raw: true });
    assert.equal(x.status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.text);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Dashboard", "Events & impact", "Rides by month"]);
    await admin("/report/marketing/links", { method: "POST", form: { label: "Marketing" } });
    const tok = (await pool.query("SELECT token, id FROM report_links WHERE label = 'Marketing'")).rows[0];
    const pub = client();
    const pp = ok200(await pub(`/m/${tok.token}?period=year`), "shared page").text;
    assert.match(pp, /marketing report/i); assert.doesNotMatch(pp, /@test\.local|Share with marketing/);
    assert.equal((await pub(`/m/${tok.token}/excel?period=year`, { raw: true })).status, 200);
    await admin(`/report/marketing/links/${tok.id}`, { method: "POST", form: { active: "0" } });
    assert.equal((await pub(`/m/${tok.token}`)).status, 404);
  });

  await t.test("WMF management one-pager: monthly, quarterly, annual; words editable; PowerPoint", async () => {
    const m = today.slice(0, 7);
    for (const q of [`period=month&p=${m}`, "period=quarter", "period=year"]) {
      const r = ok200(await admin(`/report/management?${q}`), "management " + q).text;
      for (const x of ["Key Execution Wins", "Ride Type", "COMMUNITY ACTIVATIONS", "Cross collaborations"]) assert.match(r, new RegExp(x));
    }
    await admin("/report/management/notes", { method: "POST", form: { period: `month:${m}`, wins: "Record Dubai ride\nNew partner", closing: "A strong month.", back: "/report/management" } });
    const r = ok200(await admin(`/report/management?period=month&p=${m}`), "after save").text;
    assert.match(r, /Record Dubai ride/); assert.match(r, /A strong month\./);
    const pp = await admin(`/report/management.pptx?period=month&p=${m}`, { raw: true });
    assert.equal(pp.status, 200); assert.equal(pp.text.slice(0, 2).toString(), "PK");
    await admin("/report/management/notes", { method: "POST", form: { period: `month:${m}`, reset: "1" } });
    assert.doesNotMatch(ok200(await admin(`/report/management?period=month&p=${m}`), "reset").text, /Record Dubai ride/);
  });
});
