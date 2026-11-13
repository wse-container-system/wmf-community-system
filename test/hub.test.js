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
    const from = E.helpers.addDays(today, -40).slice(0, 7), to = today.slice(0, 7); // starts at the first month with data (date-proof)
    const r = await admin(`/api/wmf/monthly.xlsx?from=${from}&to=${to}`, { raw: true });
    assert.equal(r.status, 200); assert.match(r.type, /spreadsheetml/);
    const wb = await xlsx(r.text);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Monthly summary", "Rides by month", "Events by month", "Impact", "About"]);
    const ws = wb.getWorksheet("Monthly summary");
    const rows = []; ws.eachRow((row, n) => { if (n >= 4 && /\d{4}$/.test(String(row.getCell(1).value))) rows.push(row.values.slice(1)); });
    assert.equal(rows.length, E.helpers.monthsBetween(from, to).length);
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
    // uploading again with a changed email updates the same person (no duplicate)
    const n0 = (await pool.query("SELECT count(*)::int n FROM corp_participants WHERE company = 'NMDC'")).rows[0].n;
    const fd2 = new FormData(); fd2.append("company", "NMDC"); fd2.append("file", new Blob(["Name,Email,Gender\nNew Starter,starter.new@nmdc.ae,Female\n"], { type: "text/csv" }), "nmdc2.csv");
    const pv2 = ok200(await admin("/corporate/participants/upload", { method: "POST", multipart: fd2 }), "second preview");
    assert.match(pv2.text, /email \(was new\.starter@nmdc\.ae\)/, "shows the email change");
    await admin("/corporate/participants/upload/commit", { method: "POST", form: { token: /name="token" value="([a-f0-9]+)"/.exec(pv2.text)[1] } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_participants WHERE company = 'NMDC'")).rows[0].n, n0, "no duplicate");
    const ns = (await pool.query("SELECT * FROM corp_participants WHERE email = 'starter.new@nmdc.ae'")).rows[0];
    assert.ok(ns && ns.gender === "Female", "email and details updated");
    // personal QR codes: send one, then everyone not sent yet
    const lp = ok200(await admin("/corporate/participants?company=NMDC"), "participants").text;
    assert.match(lp, /Draft emails to everyone not sent yet/); assert.match(lp, /Draft email</);
    assert.match(lp, /Email sending/); assert.equal((await admin("/corporate/participants/test-email", { method: "POST", form: { to: "a@b.co" } })).status, 302);
    const one = await admin(`/corporate/participants/${ns.pid}/emailqr`);
    assert.equal(one.status, 302); assert.match(one.location, /^https:\/\/outlook\.office\.com\/mail\/deeplink\/compose\?to=starter\.new%40nmdc\.ae&subject=/);
    assert.ok((await pool.query("SELECT qr_sent_at FROM corp_participants WHERE id = $1", [ns.id])).rows[0].qr_sent_at, "marked sent");
    const link = /\/cq\/[A-Z0-9-]+\.[A-Za-z0-9_-]{12}/.exec(decodeURIComponent(one.location))[0];
    const png = await admin(`/corporate/participants/${ns.pid}/qr.png`, { raw: true }); assert.equal(png.status, 200); assert.match(png.type, /png/);
    assert.match(ok200(await client()(link), "personal QR page").text, new RegExp(ns.pid));
    assert.equal((await client()(`/cq/${ns.pid}.AAAAAAAAAAAA`)).status, 404, "a guessed link doesn't work");
    const all = ok200(await admin("/corporate/participants/sendqr-all", { method: "POST", form: { company: "NMDC", which: "unsent", back: "/corporate/participants?company=NMDC" } }), "send all").text;
    assert.match(all, /Send QR codes/); assert.doesNotMatch(all, new RegExp(`${ns.pid}/emailqr`), "already-sent people left out");
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
    await pool.query("UPDATE corp_schedules SET active = false WHERE title IN ('Aurora Ride', 'Aurora Running')"); // (and Running on the second Thursday)
    const C = require("../src/corpdata");
    const aur = (await pool.query("SELECT * FROM corp_companies WHERE code = 'AURORA'")).rows[0];
    const ts = await C.todaysSessions(pool, aur);
    assert.ok(ts.some((s) => s.virtual && s.title === "Aurora Yoga" && s.start_time === "17:30"), "planned yoga appears today");
    const p = await tx((c) => C.createParticipant(c, { company: "AURORA", full_name: "Aurora Person", email: "ap@aurora.example" }, "test", "test"));
    const out = await tx((c) => C.corpScan(c, { code: "CORP-" + p.pid, session: "ride:AUTO", by: "test", codes: ["AURORA"] }));
    assert.equal(out.status, "ok");
    const sess = (await pool.query("SELECT s.* FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = $1", [p.id])).rows[0];
    assert.equal(sess.title, "Aurora Yoga"); assert.equal(sess.start_time, "17:30");
    // a new rider registered on the staff scanner: added, checked in, QR code ready to send on WhatsApp
    assert.match(ok200(await admin("/corporate/scan"), "scanner").text, /New rider\? Register/);
    const wi = (await admin("/api/corp/walkin", { method: "POST", json: { company: "AURORA", session: "ride:AUTO", full_name: "Walk In Rider", mobile: "050 111 2299" } })).json();
    assert.equal(wi.status, "ok"); assert.ok(wi.created); assert.match(wi.qr, /^data:image\/png/); assert.match(wi.qrUrl, /\/cq\/AURORA-\d{4}\./); assert.equal(wi.phone, "971501112299");
    assert.equal(ok200(await client()(new URL(wi.qrUrl).pathname), "their QR page").status, 200);
    const again = (await admin("/api/corp/walkin", { method: "POST", json: { company: "AURORA", session: "ride:AUTO", full_name: "Rider Walk In" } })).json();
    assert.equal(again.status, "duplicate"); assert.equal(again.pid, wi.pid, "same person, no duplicate");
    assert.equal((await admin("/api/corp/walkin", { method: "POST", json: { company: "NOPE", full_name: "X Y Z" } })).json().status, "error");
    // and on a scanner link
    await admin("/admin/scanners", { method: "POST", form: { label: "Corp phone", scope: "corporate" } });
    const sl = (await pool.query("SELECT token FROM scanner_links WHERE label = 'Corp phone' ORDER BY id DESC LIMIT 1")).rows[0];
    assert.match(ok200(await client()("/s/" + sl.token), "scanner link").text, /id="corpWalkin"/);
    const lw = (await client()(`/s/${sl.token}/corpwalkin`, { method: "POST", json: { company: "AURORA", session: "ride:AUTO", full_name: "Link Walk Rider", mobile: "0502223344" } })).json();
    assert.equal(lw.status, "ok"); assert.match(lw.qrUrl, /\/cq\//);
    // seasons: NMDC starts with "NMDC 2025-2026" (everyone so far) and an empty "NMDC 2026-2027"
    const seas = (await pool.query("SELECT * FROM corp_seasons WHERE company = 'NMDC' ORDER BY start_date")).rows;
    assert.deepEqual(seas.map((x) => x.name), ["NMDC 2025-2026", "NMDC 2026-2027"]);
    const lp0 = ok200(await admin("/corporate/participants?company=NMDC"), "season view").text;
    assert.match(lp0, /NMDC 2026-2027/); assert.match(lp0, /Past seasons/);
    // upload the new season's list: one returning lady (no new record) and one new
    const retName = (await pool.query("SELECT id, full_name, email FROM corp_participants WHERE company = 'NMDC' AND email LIKE '%@nmdc.ae' ORDER BY id LIMIT 1")).rows[0];
    await pool.query("DELETE FROM corp_season_members WHERE participant_id = $1", [retName.id]);
    await pool.query("INSERT INTO corp_season_members (season_id, participant_id) VALUES ($1, $2)", [seas[0].id, retName.id]);
    const n0s = (await pool.query("SELECT count(*)::int n FROM corp_participants WHERE company = 'NMDC'")).rows[0].n;
    const fdS = new FormData(); fdS.append("company", "NMDC"); fdS.append("season", String(seas[1].id));
    fdS.append("file", new Blob([`Name,Email\n${retName.full_name},${retName.email}\nSeason Newcomer,season.newcomer@nmdc.ae\n`], { type: "text/csv" }), "season.csv");
    const pvS = ok200(await admin("/corporate/participants/upload", { method: "POST", multipart: fdS }), "season preview").text;
    assert.match(pvS, /goes into <b>NMDC 2026-2027<\/b>: 2 people, of whom <b>1<\/b> were on an earlier season/);
    await admin("/corporate/participants/upload/commit", { method: "POST", form: { token: /name="token" value="([a-f0-9]+)"/.exec(pvS)[1] } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_participants WHERE company = 'NMDC'")).rows[0].n, n0s + 1, "only the newcomer is a new record");
    const sv = ok200(await admin(`/corporate/participants?company=NMDC&season=${seas[1].id}`), "new season").text;
    assert.match(sv, /Returning<\/span>/); assert.match(sv, /Season Newcomer<\/a> <span class="badge good">New/);
    assert.match(ok200(await admin("/corporate/participants?company=NMDC&season=past"), "past").text, /Past seasons<\/b>/);
    await admin("/corporate/seasons", { method: "POST", form: { company: "NMDC", name: "NMDC 2027-2028", start_date: "2027-09-01", end_date: "2028-08-31" } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_seasons WHERE company = 'NMDC'")).rows[0].n, 3);
    // ride sign-up: shared link per company, rental bikes with height, who's coming, list for the shop
    assert.match(ok200(await admin("/corporate/signups?company=AURORA"), "sign-ups").text, /Share with Aurora/);
    const tokS = (await pool.query("SELECT signup_token FROM corp_companies WHERE code = 'AURORA'")).rows[0].signup_token; assert.ok(tokS);
    const rides = await require("../src/corpsignup").ridesFor((await pool.query("SELECT * FROM corp_companies WHERE code = 'AURORA'")).rows[0], today, E.helpers.addDays(today, 56));
    const rd = rides.find((x) => !x.cancelled); assert.ok(rd, "Aurora has an upcoming ride");
    await admin(`/corporate/signups/AURORA/${rd.key}/rental`, { method: "POST", form: { price: "50" } });
    const anon = client(), pubPage = ok200(await anon(`/ride/${tokS}?k=${rd.key}`), "public sign-up").text;
    assert.match(pubPage, /Rent a bike \(AED 50\)/); assert.doesNotMatch(pubPage, /class="hub-nav|Sign out/, "no hub menus");
    const s1 = await anon(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: wi.pid, rent: "1", height_cm: "165" } });
    assert.equal(s1.status, 303);
    const row = (await pool.query("SELECT * FROM corp_signups WHERE ride_key = $1 AND status = 'Coming'", [rd.key])).rows[0];
    assert.ok(row.rent && row.height_cm === 165 && /^AURORA-\d{4}-01$/.test(row.ref), "rental booked with a reference");
    const mine = ok200(await anon(`/ride/${tokS}?k=${rd.key}`), "after sign-up").text;
    assert.match(mine, /You're in, Walk!/); assert.match(mine, /Who's coming \(1\)/); assert.match(mine, /Walk R\./, "first name and initial only");
    // no limit on rental bikes: the next person can rent too, then switch to her own bike
    const other = client();
    assert.equal((await other(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: "ap@aurora.example", rent: "1", height_cm: "170" } })).status, 303, "no limit");
    assert.equal((await other(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: "ap@aurora.example", rent: "0" } })).status, 303);
    // a new person joins with name and mobile
    const nw = client(), ask = ok200(await nw(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: "fresh.rider@aurora.example", rent: "0" } }), "ask name").text;
    assert.match(ask, /Add your name and mobile/);
    assert.equal((await nw(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: "fresh.rider@aurora.example", full_name: "Fresh Rider", mobile: "0507778899", rent: "0" } })).status, 303);
    const staffRide = ok200(await admin(`/corporate/signups/AURORA/${rd.key}`), "staff ride").text;
    assert.match(staffRide, /Who's coming \(3\)/); assert.match(staffRide, /wa\.me\/[^"]*\?text=[^"]*165%20cm/, "WhatsApp draft with height");
    const xl = await admin(`/corporate/signups/AURORA/${rd.key}/rentals.xlsx`, { raw: true }); assert.equal(xl.status, 200);
    // someone already coming on her own bike can switch to a rental from her confirmation
    assert.match(ok200(await other(`/ride/${tokS}?k=${rd.key}`), "own bike page").text, /Book a rental bike/);
    // with the shop's booking link set, the ladies book their own bike there (description "<Company> Corporate Ride")
    await admin("/corporate/signups/shop", { method: "POST", form: { company: "AURORA", name: "Wolfi's", link: "https://wolfis.example/book", phone: "" } });
    const lp2 = client(), f2 = ok200(await lp2(`/ride/${tokS}?k=${rd.key}`), "link mode").text;
    assert.match(f2, /I need a rental bike \(I(&#39;|')ll book it with Wolfi(&#39;|')s\)/); assert.match(f2, /name="height_cm"/, "asks her height");
    assert.match(ok200(await lp2(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: "fresh.rider@aurora.example", rent: "1" } }), "no height").text, /Add your height/);
    await lp2(`/ride/${tokS}/signup`, { method: "POST", form: { k: rd.key, who: "fresh.rider@aurora.example", rent: "1", height_cm: "162" } });
    const conf = ok200(await lp2(`/ride/${tokS}?k=${rd.key}`), "booking box").text;
    assert.match(conf, /href="https:\/\/wolfis\.example\/book"/); assert.match(conf, /Aurora Corporate Ride/);
    await admin("/corporate/signups/shop", { method: "POST", form: { company: "AURORA", name: "Wolfi's", link: "", phone: "" } });
    // cancel frees the bike
    await anon(`/ride/${tokS}/cancel`, { method: "POST", form: { k: rd.key } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_signups su JOIN corp_participants p ON p.id = su.participant_id WHERE su.ride_key = $1 AND su.status = 'Coming' AND p.pid = $2", [rd.key, wi.pid])).rows[0].n, 0, "her place and bike are freed");
    assert.equal((await client()("/ride/nope")).status, 404);
    // delete a mistaken entry (admin): gone, with its attendance
    assert.match(ok200(await admin(`/corporate/participants/${lw.pid}`), "participant page").text, /Delete this person/);
    assert.equal((await admin(`/corporate/participants/${lw.pid}/delete`, { method: "POST", form: {} })).status, 302);
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_participants WHERE pid = $1", [lw.pid])).rows[0].n, 0);
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
    assert.equal((await admin(`/report/marketing?period=month&p=${m}`)).status, 302, "one report: marketing lives in the management report");
    const pg = ok200(await admin(`/report/management?period=month&p=${m}`), "management page").text;
    for (const x of ["Community activations", "id=\"social-in\"", "id=\"mklinks\"", ">Excel<"]) assert.match(pg, new RegExp(x));
    const x = await admin(`/report/marketing.xlsx?period=month&p=${m}`, { raw: true });
    assert.equal(x.status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(x.text);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ["Dashboard", "Events & impact", "Marketing"]);
    await admin("/report/marketing/links", { method: "POST", form: { label: "Marketing" } });
    const tok = (await pool.query("SELECT token, id FROM report_links WHERE label = 'Marketing'")).rows[0];
    const pub = client();
    const pp = ok200(await pub(`/m/${tok.token}?period=year`), "shared page").text;
    assert.match(pp, /Key execution wins/, "marketing sees the management report"); assert.match(pp, /You can edit this report/);
    assert.doesNotMatch(pp, /@test\.local|For the team/);
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

  await t.test("WMF attendance per ride: check someone in by name", async () => {
    const R2 = require("../src/rules");
    await tx(async (c) => { await R2.ensureCoreRides(c); await R2.createMember(c, { full_name: "Zoe Uniquename", email: "zoe.unique@test.local", mobile: "0507654321", waiver_consent: true }, "t", "t"); });
    const date = today, back = `/rides/${date}/RIDE-WEDNESDAY-SOCIAL`;
    let r = await admin("/rides/checkin", { method: "POST", form: { memberId: "Uniquename", date, activityId: "RIDE-WEDNESDAY-SOCIAL", back } });
    assert.equal(r.status, 302);
    const n = (await pool.query("SELECT count(*)::int n FROM participation p JOIN members m ON m.member_id = p.member_id WHERE m.full_name = 'Zoe Uniquename' AND p.voided_at IS NULL")).rows[0].n;
    assert.equal(n, 1, "one match: checked in straight away");
    await tx((c) => R2.createMember(c, { full_name: "Zoe Uniquename-Two", email: "zoe.two@test.local", waiver_consent: true }, "t", "t"));
    r = await admin("/rides/checkin", { method: "POST", form: { memberId: "Uniquename", date, activityId: "RIDE-WEDNESDAY-SOCIAL", back } });
    assert.match(r.location, /find=Uniquename/, "several matches: shows the list");
  });

  await t.test("WMF: usual-rider check-in shows on the same ride; Rides page; management link", async () => {
    const R2 = require("../src/rules");
    // an imported "Wednesday Ride" record and a check-in from the ride page land on one ride and one count
    const wed = (() => { let d = today; while (R2.weekdayOf(d) !== "Wednesday") d = E.helpers.addDays(d, -1); return d; })();
    const m1 = await tx((c) => R2.createMember(c, { full_name: "Imported Rider", email: "imp@test.local", waiver_consent: true }, "t", "t"));
    const m2 = await tx((c) => R2.createMember(c, { full_name: "Late Rider", email: "late@test.local", waiver_consent: true }, "t", "t"));
    await pool.query(`INSERT INTO participation (record_id, record_date, record_type, activity_id, activity_name, activity_type, status, member_id, source, dedupe_key)
      VALUES ('IMP-W1', $1, 'Attendance', 'FORM-WED', 'Wednesday Ride', 'Community Ride', 'Attended', $2, 'Imported form', 'imp-w1')`, [wed + " 18:00:00", m1.member_id]);
    const listPage = ok200(await admin("/rides?days=30"), "rides list").text;
    assert.match(listPage, new RegExp(`/rides/${wed}/RIDE-WEDNESDAY-SOCIAL"`), "the Wednesday ride is listed");
    await admin("/rides/checkin", { method: "POST", form: { memberId: m2.member_id, date: wed, activityId: "RIDE-WEDNESDAY-SOCIAL", back: `/rides/${wed}/RIDE-WEDNESDAY-SOCIAL` } });
    const pg = ok200(await admin(`/rides/${wed}/RIDE-WEDNESDAY-SOCIAL`), "ride page").text;
    assert.match(pg, /Imported Rider/); assert.match(pg, /Late Rider/);
    // Rides page, both cities
    for (const c of ["auh", "dxb"]) assert.match(ok200(await admin(`/wmf/rides?city=${c}&period=quarter`), "rides " + c).text, /Every ride/);
    // management dashboard + share link
    assert.match(ok200(await admin("/report/management?period=year"), "mgmt").text, /Key execution wins/);
    await admin("/report/management/links", { method: "POST", form: { label: "Management" } });
    const l = (await pool.query("SELECT * FROM report_links WHERE kind = 'management'")).rows[0];
    const pub = client();
    const g = ok200(await pub(`/g/${l.token}?period=quarter`), "management link").text;
    assert.match(g, /Key execution misses/); assert.doesNotMatch(g, /For the team|@test\.local/);
    const asAdmin = ok200(await admin(`/g/${l.token}`), "link opened while signed in").text;
    assert.doesNotMatch(asAdmin, /Department<\/a>|Corporate<\/a>|>Admin<|Sign out|For the team/, "no hub menus on a shared link");
    assert.match(asAdmin, /Community System/);
    assert.equal((await pub(`/g/${l.token}/pptx?period=year`, { raw: true })).status, 200);
    assert.equal((await pub(`/m/${l.token}`)).status, 404, "a management link isn't a marketing link");
    await admin(`/report/management/links/${l.id}`, { method: "POST", form: { active: "0" } });
    assert.equal((await pub(`/g/${l.token}`)).status, 404);
  });

  await t.test("WMF Rides: duplicates flagged; rides edited and deleted", async () => {
    const d = E.helpers.addDays(today, -3), m = d.slice(0, 7);
    const ins = (n) => pool.query("INSERT INTO history_rides (ride_date, initiative, state, attendees) VALUES ($1, 'Friday Ride', 'DXB', $2) RETURNING id", [d, n]).then((r) => r.rows[0].id);
    const a = await ins(10), b = await ins(10);
    let pg = ok200(await admin(`/wmf/rides?city=dxb&period=month&p=${m}`), "rides").text;
    assert.match(pg, /Possible duplicate/);
    assert.match(ok200(await admin(`/wmf/rides/ride?src=h&id=${a}&back=/wmf/rides?city=dxb`), "edit page").text, /Delete this ride/);
    await admin("/wmf/rides/ride", { method: "POST", form: { src: "h", id: String(b), action: "delete", back: "/wmf/rides?city=dxb" } });
    assert.equal((await pool.query("SELECT count(*)::int n FROM history_rides WHERE id = $1", [b])).rows[0].n, 0);
    await admin("/wmf/rides/ride", { method: "POST", form: { src: "h", id: String(a), d, city: "Dubai", name: "Friday Ride", n: "14", back: "/wmf/rides?city=dxb" } });
    assert.equal((await pool.query("SELECT attendees FROM history_rides WHERE id = $1", [a])).rows[0].attendees, 14);
    pg = ok200(await admin(`/wmf/rides?city=dxb&period=month&p=${m}`), "rides after").text;
    assert.doesNotMatch(pg, /Possible duplicate/);
    // live check-ins: remove the whole ride
    const rec = (await pool.query("SELECT record_id, record_date::date::text AS d FROM participation WHERE record_type = 'Attendance' AND voided_at IS NULL AND source = 'Manual Attendance Correction' LIMIT 1")).rows[0];
    if (rec) {
      await admin("/wmf/rides/ride", { method: "POST", form: { src: "q", recs: rec.record_id, action: "delete", back: "/wmf/rides" } });
      assert.ok((await pool.query("SELECT voided_at FROM participation WHERE record_id = $1", [rec.record_id])).rows[0].voided_at);
    }
  });

  await t.test("WMF Attendance per ride: edit, move and delete from the ride list", async () => {
    const R2 = require("../src/rules");
    let mon = today; while (R2.weekdayOf(mon) !== "Monday") mon = E.helpers.addDays(mon, -1);
    const a = await tx((c) => R2.createMember(c, { full_name: "Move Me", email: "move@test.local", waiver_consent: true }, "t", "t"));
    const b = await tx((c) => R2.createMember(c, { full_name: "Stay Put", email: "stay@test.local", waiver_consent: true }, "t", "t"));
    for (const m of [a, b]) await admin("/rides/checkin", { method: "POST", form: { memberId: m.member_id, date: mon, activityId: "RIDE-MONDAY-MADNESS", back: "/rides" } });
    // b is already on the Monday before; both are moved there
    const mon2 = E.helpers.addDays(mon, -7);
    await admin("/rides/checkin", { method: "POST", form: { memberId: b.member_id, date: mon2, activityId: "RIDE-MONDAY-MAINTENANCE", back: "/rides" } });
    const list = ok200(await admin("/rides?days=30"), "ride list").text;
    assert.match(list, /Edit \/ delete/);
    const recs = (await pool.query("SELECT record_id FROM participation WHERE activity_id = 'RIDE-MONDAY-MADNESS' AND record_date::date = $1 AND voided_at IS NULL AND member_id = ANY($2)", [mon, [a.member_id, b.member_id]])).rows.map((r) => r.record_id);
    assert.equal(recs.length, 2);
    assert.match(ok200(await admin(`/wmf/rides/ride?src=q&d=${mon}&recs=${recs.join(",")}&back=/rides`), "edit").text, /Move all 2 check-ins/);
    await admin("/wmf/rides/ride", { method: "POST", form: { src: "q", recs: recs.join(","), action: "move", d: mon2, activity: "RIDE-MONDAY-MAINTENANCE", back: "/rides" } });
    const after = (await pool.query("SELECT member_id, activity_id, voided_at IS NOT NULL AS gone FROM participation WHERE record_id = ANY($1)", [recs])).rows;
    assert.ok(after.find((x) => x.member_id === a.member_id && x.activity_id === "RIDE-MONDAY-MAINTENANCE" && !x.gone), "moved");
    assert.ok(after.find((x) => x.member_id === b.member_id && x.gone), "already there: removed, not counted twice");
    // remove one person from the ride page
    const pg = ok200(await admin(`/rides/${mon2}/RIDE-MONDAY-MAINTENANCE`), "ride page").text;
    assert.match(pg, /Remove/); assert.match(pg, /Edit \/ delete this ride/);
  });

  await t.test("WMF Rides: add a ride (new ride name, by name or headcount)", async () => {
    const d = E.helpers.addDays(today, -2);
    let r = await admin("/wmf/rides/new", { method: "POST", form: { city: "Abu Dhabi", d, activity: "new", name: "Thursday Sunset Ride", mode: "names", back: "/wmf/rides" } });
    const act = (await pool.query("SELECT * FROM activities WHERE name = 'Thursday Sunset Ride'")).rows[0];
    assert.ok(act && act.core, "new ride added to the scanner list");
    assert.equal(r.location, `/rides/${d}/${encodeURIComponent(act.activity_id)}`);
    assert.match(ok200(await admin(r.location), "ride page").text, /Check in someone else/);
    r = await admin("/wmf/rides/new", { method: "POST", form: { city: "Dubai", d, activity: act.activity_id, mode: "count", n: "17", back: "/wmf/rides?city=dxb" } });
    assert.equal(r.location, "/wmf/rides?city=dxb");
    const pg = ok200(await admin(`/wmf/rides?city=dxb&period=month&p=${d.slice(0, 7)}`), "dxb rides").text;
    assert.match(pg, /Thursday Sunset Ride/); assert.match(pg, /added by the team/);
    assert.match(ok200(await admin("/wmf/rides/new?city=dxb"), "form").text, /Thursday Sunset Ride/);
  });

  await t.test("WMF Rides: location per ride, with a usual location", async () => {
    const d = E.helpers.addDays(today, -1), d2 = E.helpers.addDays(today, -8);
    await admin("/wmf/rides/new", { method: "POST", form: { city: "Dubai", d, activity: "new", name: "Qudra Loop", mode: "count", n: "9", venue: "Al Qudra Cycle Track", usual: "1", back: "/wmf/rides?city=dxb" } });
    await admin("/wmf/rides/new", { method: "POST", form: { city: "Dubai", d: d2, activity: "new", name: "Qudra Loop", mode: "count", n: "7", venue: "", back: "/wmf/rides?city=dxb" } });
    let pg = ok200(await admin("/wmf/rides?city=dxb&period=year"), "dxb").text;
    assert.match(pg, /Al Qudra Cycle Track/); assert.match(pg, /\(usual\)/, "the other Qudra Loop takes the usual location");
    assert.match(pg, /By location/);
    // change one ride's location from its edit page
    const id = (await pool.query("SELECT id FROM lead_rides WHERE title = 'Qudra Loop' AND ride_date = $1", [d2])).rows[0].id;
    const ed = ok200(await admin(`/wmf/rides/ride?src=l&id=${id}&series=Qudra%20Loop&city=Dubai&back=/wmf/rides?city=dxb`), "edit").text;
    assert.match(ed, /Save location/);
    await admin("/wmf/rides/ride", { method: "POST", form: { src: "venue", d: d2, city: "Dubai", series: "Qudra Loop", venue: "Meydan", back: "/wmf/rides?city=dxb" } });
    pg = ok200(await admin("/wmf/rides?city=dxb&period=year"), "dxb after").text;
    assert.match(pg, /Meydan/);
    assert.equal((await pool.query("SELECT venue FROM ride_venue_defaults WHERE city = 'Dubai' AND series = 'Qudra Loop'")).rows[0].venue, "Al Qudra Cycle Track", "usual stays unless ticked");
  });

  await t.test("Corporate Rides page; Reports in the hub menu", async () => {
    const co = (await pool.query("SELECT code FROM corp_companies WHERE active ORDER BY code LIMIT 1")).rows[0].code;
    const d = E.helpers.addDays(today, -1);
    let r = await admin("/corporate/sessions", { method: "POST", form: { company: co, session_date: d, kind: "Weekly ride", status: "Held", location: "Yas Marina Circuit", headcount: "9" } });
    const sid = r.location.split("/").pop();
    const pg = ok200(await admin(`/corporate/rides?period=month&p=${d.slice(0, 7)}`), "corporate rides").text;
    assert.match(pg, /Every ride/); assert.match(pg, /Yas Marina Circuit/); assert.match(pg, new RegExp(`/corporate/session/${sid}`));
    r = await admin(`/corporate/session/${sid}/delete`, { method: "POST", form: { back: "/corporate/rides" } });
    assert.equal(r.location, "/corporate/rides");
    assert.equal((await pool.query("SELECT count(*)::int n FROM corp_sessions WHERE id = $1", [+sid])).rows[0].n, 0);
    // reports: in the hub menu with their own sub-menu; WMF keeps its Reports link
    const hub = ok200(await admin("/"), "hub").text;
    assert.match(hub, /<a href="\/report\/management"[^>]*>Reports<\/a>/); assert.match(hub, /band-rep/);
    const rp = ok200(await admin("/report/management?period=year"), "report").text;
    assert.match(rp, /Performance report<\/a>/); assert.doesNotMatch(rp, /">Marketing<\/a>/, "one report: marketing works through the management report");
    assert.match(ok200(await admin("/wmf"), "wmf").text, /href="\/report"[^>]*>Reports</);
  });

  await t.test("Marketing: one link to see the report and add posts; other events; shows on the management report", async () => {
    await admin("/report/marketing/links", { method: "POST", form: { label: "Marketing team" } });
    const l = (await pool.query("SELECT * FROM report_links WHERE kind = 'marketing' ORDER BY id DESC")).rows[0];
    const pub = client(), base = `/m/${l.token}`;
    const form = ok200(await pub(base), "marketing link").text;
    assert.doesNotMatch(form, /Marketing &amp; impact|Add a post|Add marketing/, "marketing & impact removed"); assert.match(form, /Community activations/); assert.match(form, /id="social-in"/); assert.match(form, /Key execution misses/, "same view as management");
    assert.doesNotMatch(form, /Department<\/a>|Corporate<\/a>|Sign out|@test\.local/, "no hub menus or emails");
    const a0 = (await pool.query("SELECT id FROM activations ORDER BY id LIMIT 1")).rows[0], ev = a0 ? [null, "a:" + a0.id] : null;
    const d = today, y = `?period=year&p=${today.slice(0, 4)}`;
    assert.equal((await pub(base + y, { method: "POST", form: { target: "", channel: "Instagram", kind: "Reel / video", posted_on: d, title: "Teaser reel", reach: "4,200", engagements: "310" } })).status, 303);
    await pub(base + y, { method: "POST", form: { target: "o", other_event: "City fun ride", other_date: d, other_people: "80", channel: "WhatsApp", kind: "Post", posted_on: d, reach: "500", engagements: "40" } });
    assert.equal((await pool.query("SELECT sum(reach)::int AS n FROM marketing_actions")).rows[0].n, 4700);
    if (ev) { // a post for a WMF event sits with that event and its turnout
      await pub(base + y, { method: "POST", form: { target: ev[1], channel: "Strava", kind: "Post", posted_on: d, reach: "100", engagements: "9" } });
      const all = await require("../src/mkinputs").loadInputs({ start: "2000-01-01", end: "2100-12-31" });
      assert.ok(all.byEvent.some((g) => !g.other && g.key !== "general" && g.reach === 100), "linked post grouped under its event");
      await pool.query("DELETE FROM marketing_actions WHERE reach = 100");
    }
    const act = (await pool.query("SELECT id, participants FROM activations ORDER BY id LIMIT 1")).rows[0];
    if (act) { // marketing updates an activation's feedback and strategy; it shows in the management report
      await pub(`${base}/act/${act.id}${y}`, { method: "POST", form: { participants: String(act.participants ?? ""), registrants: "", new_contacts: "", impact: "Great energy, 5 asked about the next ride.", strategy: "Partner reveal then reminders." } });
      assert.equal((await pool.query("SELECT impact FROM activations WHERE id = $1", [act.id])).rows[0].impact, "Great energy, 5 asked about the next ride.");
      assert.equal((await pool.query("SELECT strategy FROM marketing_strategies WHERE target = $1", ["a:" + act.id])).rows[0].strategy, "Partner reveal then reminders.");
    }
    const after = ok200(await pub(base + "?period=year"), "after entries").text;
    assert.match(after, /Great energy, 5 asked about the next ride/, "edited feedback shows in the report");
    if (ev) { // a strategy alone (no post numbers) is saved for the event and shows on the report
      const n0 = (await pool.query("SELECT count(*)::int AS n FROM marketing_actions")).rows[0].n;
      await pub(base + y, { method: "POST", form: { target: ev[1], strategy: "Teaser, partner reveal, reminders", channel: "Instagram", kind: "Post", posted_on: d } });
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketing_actions")).rows[0].n, n0, "no empty post");
      assert.equal((await pool.query("SELECT strategy FROM marketing_strategies WHERE target = $1", [ev[1]])).rows[0].strategy, "Teaser, partner reveal, reminders");
    }
    assert.equal((await admin("/report/marketing/log")).status, 302, "old log address goes to the Marketing page");
    const mg = ok200(await admin("/report/management?period=year"), "management").text;
    assert.doesNotMatch(mg, /Marketing &amp; impact/); await admin("/report/management/links", { method: "POST", form: { label: "Mgmt view" } });
    const gt = (await pool.query("SELECT token FROM report_links WHERE kind = 'management' AND label = 'Mgmt view'")).rows[0].token;
    const gv = ok200(await pub(`/g/${gt}?period=year`), "management link").text;
    assert.doesNotMatch(gv, /City fun ride/, "other events stay out of the management report"); assert.doesNotMatch(gv, /Add a post|Edit feedback/, "management's link is view-only");
    assert.equal((await pub(`/g/${l.token}`)).status, 404, "a marketing link isn't a management link");
    const xl = await xlsx((await pub(`${base}/excel?period=year`, { raw: true })).text);
    assert.ok(xl.getWorksheet("Marketing"), "Excel has a Marketing sheet");
    await admin(`/report/marketing/links/${l.id}`, { method: "POST", form: { active: "0" } });
    assert.equal((await pub(base)).status, 404);
  });

  await t.test("Reports show the latest end-of-season survey; another one can be picked", async () => {
    const mg = ok200(await admin("/report/management?period=year"), "management").text;
    assert.match(mg, /Community voice · End of Summer Season Survey 2026/);
    assert.match(mg, /Active members/); assert.match(mg, /sv-ring/, "survey shown with score rings");
    for (const x of ["Community rides", "Community activations &amp; partners", "What&#39;s next|What.s next", "Corporate programme", "sr-sp", "First rides"]) assert.match(mg, new RegExp(x), x);
    assert.doesNotMatch(mg, /Ride participation by month|New joiners by month/, "graphs removed");
    assert.match(mg, /class="spark"/, "trend lines under the numbers");
    assert.match(mg, /id="mklinks"/, "marketing link made from the management report"); assert.match(mg, /Community Survey<\/th>/);
    assert.match(ok200(await admin("/report?period=year"), "performance report").text, /What the community said/);
    const w = (await pool.query("SELECT id FROM season_surveys WHERE title = 'End of Winter Season Survey 2026'")).rows[0];
    await admin(`/surveys/seasons/${w.id}/report`, { method: "POST", form: {} });
    assert.match(ok200(await admin("/report/management?period=year"), "after picking").text, /Community voice · End of Winter Season Survey 2026/);
    assert.match(ok200(await admin(`/surveys/seasons/${w.id}`), "survey page").text, /Shown in the reports/);
    await pool.query("DELETE FROM settings WHERE key = 'reportSurvey'");
  });

  await t.test("Older rides: add a new member by name, checked in, with their personal QR code", async () => {
    let d = E.helpers.addDays(today, -120); while (R.weekdayOf(d) !== "Wednesday") d = E.helpers.addDays(d, -1);
    const act = "RIDE-WEDNESDAY-SOCIAL";
    const back = `/rides/${d}/${act}`, nm = "Brand New Rider " + Date.now().toString(36);
    const pg = ok200(await admin(back + "?add=new"), "old ride page").text;
    assert.match(pg, /New member \(not in the records yet\)/, "adding is possible on an older ride");
    const r = await admin("/rides/newmember", { method: "POST", form: { full_name: nm, date: d, activityId: act, back, city: "Abu Dhabi" } });
    assert.equal(r.status, 302); const id = /new=(WMF-\d{6})/.exec(r.location)[1];
    const m = (await pool.query("SELECT first_seen::text AS f, primary_email FROM members WHERE member_id = $1", [id])).rows[0];
    assert.equal(m.f.slice(0, 10), d, "member since the ride date"); assert.equal(m.primary_email, null, "email can be added later");
    const shown = ok200(await admin(`${back}?new=${id}`), "after adding").text;
    assert.match(shown, new RegExp(nm + " is now a member")); assert.match(shown, /data:image\/png;base64/, "their QR code is shown");
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM participation WHERE member_id = $1 AND voided_at IS NULL", [id])).rows[0].n, 1, "checked in");
  });

  await t.test("New members can be set by hand for a month", async () => {
    const m = E.helpers.addMonths(today.slice(0, 7), -1);
    await admin("/report/management/newmembers", { method: "POST", form: { month: m, n: "10", back: `/report/management?period=month&p=${m}` } });
    const pg = ok200(await admin(`/report/management?period=month&p=${m}`), "management").text;
    assert.match(pg, /New joiners<\/span><span class="val">10<|New joiners[\s\S]{0,200}>10</, "New joiners box shows the number set"); assert.match(pg, /with 10 new in this month/, "the words use it too");
    assert.match(ok200(await admin(`/report?period=month&p=${m}`), "performance").text, /New members/);
    await admin("/report/management/newmembers", { method: "POST", form: { month: m, n: "" } });
    assert.equal((await pool.query("SELECT value FROM settings WHERE key = 'newMembersManual'")).rows[0].value[m], undefined, "back to the app's count");
  });

  await t.test("A manager's link can edit the words; a normal management link can't", async () => {
    await admin("/report/management/links", { method: "POST", form: { label: "Lynsey", can_edit: "1" } });
    const l = (await pool.query("SELECT * FROM report_links WHERE kind = 'management' AND label = 'Lynsey'")).rows[0];
    assert.equal(l.can_edit, true);
    const pub = client(), g = `/g/${l.token}`, m = E.helpers.addMonths(today.slice(0, 7), -1);
    const pg = ok200(await pub(`${g}?period=month&p=${m}`), "manager link").text;
    assert.match(pg, /Edit the words/); assert.doesNotMatch(pg, /For the team|@test\.local/);
    const r = await pub(`${g}/notes`, { method: "POST", form: { period: `month:${m}`, back: `${g}?period=month&p=${m}`, developments: "Written by Lynsey", wins: "", misses: "", fwd: "", social: "", marketing: "", sponsor: "", closing: "", priorities: "" } });
    assert.equal(r.status, 303);
    assert.match(ok200(await admin(`/report/management?period=month&p=${m}`), "team view").text, /Written by Lynsey/, "the change shows for everyone");
    await admin(`/report/management/links/${l.id}`, { method: "POST", form: { can_edit: "0" } });
    assert.doesNotMatch(ok200(await pub(`${g}?period=month&p=${m}`), "now view only").text, /Edit the words/);
    assert.equal((await pub(`${g}/notes`, { method: "POST", form: { period: `month:${m}`, developments: "x" } })).status, 404, "view-only link can't save");
    await pool.query("DELETE FROM report_notes WHERE period = $1", [`month:${m}`]);
  });

  await t.test("Marketing: several channels, several types per channel, extra metrics; graph per event", async () => {
    await admin("/report/marketing/links", { method: "POST", form: { label: "Channels test" } });
    const l = (await pool.query("SELECT token FROM report_links WHERE kind = 'marketing' AND label = 'Channels test'")).rows[0];
    const pub = client(), base = `/m/${l.token}`, y = `?period=year&p=${today.slice(0, 4)}`;
    const form = ok200(await pub(base + y), "marketing link").text;
    const before = (await pool.query("SELECT count(*)::int AS n FROM marketing_actions")).rows[0].n;
    // two Instagram types and one TikTok post, in one save (as the page sends them)
    const body = new URLSearchParams([["target", ""],
      ["r_channel", "Instagram"], ["r_metrics", "Saves=45|Shares=30"], ["r_kind", "Reel"], ["r_date", today], ["r_reach", "3,000"], ["r_eng", "220"], ["r_url", ""],
      ["r_channel", "Instagram"], ["r_metrics", "Link clicks=38"], ["r_kind", "Story"], ["r_date", today], ["r_reach", "1200"], ["r_eng", "90"], ["r_url", ""],
      ["r_channel", "TikTok"], ["r_metrics", "Plays=5200"], ["r_kind", "Video"], ["r_date", today], ["r_reach", "2500"], ["r_eng", "180"], ["r_url", ""],
      ["r_channel", "TikTok"], ["r_metrics", ""], ["r_kind", "Post"], ["r_date", today], ["r_reach", ""], ["r_eng", ""], ["r_url", ""]]);
    assert.equal((await pub(base + y, { method: "POST", form: body })).status, 303);
    const rows = (await pool.query("SELECT channel, kind, reach, clicks, metrics FROM marketing_actions ORDER BY id DESC LIMIT 3")).rows.reverse();
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM marketing_actions")).rows[0].n, before + 3, "empty rows are skipped");
    assert.deepEqual(rows.map((r) => `${r.channel} ${r.kind}`), ["Instagram Reel", "Instagram Story", "TikTok Video"]);
    assert.deepEqual(rows[0].metrics, { Saves: 45, Shares: 30 }); assert.equal(rows[1].clicks, 38, "link clicks keep their own column"); assert.equal(rows[0].reach, 3000);
    const mk = await require("../src/mkinputs").loadInputs({ start: "2000-01-01", end: "2100-12-31" });
    const g = mk.byEvent.find((x) => x.key === "general");
    assert.ok(g.byChannel.get("TikTok") && g.metrics.get("Plays") === 5200, "channel split and metric totals");
    await pool.query("DELETE FROM marketing_actions WHERE id > (SELECT max(id) - 3 FROM marketing_actions)");
  });

  await t.test("WMF calendar: staff add, edit, cancel a date and delete right on the calendar", async () => {
    const m = today.slice(0, 7), back = `/calendar?m=${m}`;
    assert.match(ok200(await admin("/calendar"), "calendar").text, /data-staff="1"/);
    assert.doesNotMatch(ok200(await client()("/calendar"), "public calendar").text, /data-staff/, "the community can't edit");
    const nf = ok200(await admin(`/calendar/items/new?embed=1&date=${today}&back=${encodeURIComponent(back)}`), "add form").text;
    assert.doesNotMatch(nf, /<html|<nav/i, "just the form for the pop-up"); assert.match(nf, new RegExp(`value="${today}"`)); assert.match(nf, /name="back"/);
    const add = await admin("/calendar/items/new", { method: "POST", form: { title: "Test sunrise ride", category: "wmf_ride", status: "Confirmed", start_date: today, start_time: "06:00", weekdays: String(new Date(today + "T12:00Z").getUTCDay()), back } });
    assert.equal(add.location, back, "back to the same month");
    const x = (await pool.query("SELECT id FROM calendar_items WHERE title = 'Test sunrise ride'")).rows[0];
    const api = JSON.parse((await admin("/api/calendar.json")).text); assert.ok(api.items.some((i) => i.id === x.id), "staff get ids");
    assert.ok(!JSON.parse((await client()("/api/calendar.json")).text).items.some((i) => "id" in i), "public gets no ids");
    assert.match(ok200(await admin(`/calendar/items/${x.id}?embed=1&back=${encodeURIComponent(back)}`), "edit form").text, /Delete this entry/);
    assert.equal((await admin(`/calendar/items/${x.id}/date`, { method: "POST", form: { date: today, back } })).location, back);
    assert.equal((await pool.query("SELECT exceptions FROM calendar_items WHERE id = $1", [x.id])).rows[0].exceptions[today], "cancelled", "that date is skipped");
    await admin(`/calendar/items/${x.id}/date`, { method: "POST", form: { date: today, undo: "1", back } });
    assert.equal((await pool.query("SELECT exceptions FROM calendar_items WHERE id = $1", [x.id])).rows[0].exceptions, null, "and brought back");
    assert.equal((await client()(`/calendar/items/${x.id}/date`, { method: "POST", form: { date: today } })).status, 302, "public can't change it");
    assert.equal((await admin(`/calendar/items/${x.id}/delete`, { method: "POST", form: { back } })).location, back);
    assert.equal((await pool.query("SELECT 1 FROM calendar_items WHERE id = $1", [x.id])).rows.length, 0);
  });

  await t.test("Department team calendar: WMF and corporate rides, leave, and the team's own entries", async () => {
    const m = today.slice(0, 7), d = m + "-05";
    const r = await admin("/department/calendar/new", { method: "POST", form: { title: "Team meeting", category: "Meeting", start_date: d, start_time: "10:00", end_time: "11:00", repeat: "weekly", who: "Whole team" } });
    assert.equal(r.status, 302);
    const e = (await pool.query("SELECT * FROM dept_calendar WHERE title = 'Team meeting'")).rows[0];
    assert.equal(e.who, "Whole team"); assert.equal(e.repeat, "weekly");
    const items = await require("../src/teamcal").load(d, E.helpers.addDays(d, 20));
    assert.equal(items.filter((x) => x.title === "Team meeting").length, 3, "repeats every week");
    const pg = ok200(await admin(`/department/calendar?m=${m}`), "month").text;
    for (const x of ["WMF rides &(amp;)? events", "Corporate rides", "Leave &(amp;)? days off", "Team entries", "Team meeting"]) assert.match(pg, new RegExp(x));
    assert.match(ok200(await admin(`/department/calendar?view=week&d=${d}`), "week").text, /Whole team/, "week view shows who");
    assert.doesNotMatch(ok200(await admin(`/department/calendar?m=${m}&show=wmf,corp`), "filtered").text, /Team meeting/, "filters hide team entries");
    const jan = ok200(await admin("/department/calendar?m=2027-01"), "holidays").text;
    assert.match(jan, /New Year&#39;s Day|New Year's Day/, "UAE public holidays on the calendar"); assert.match(jan, /tc-day[^"]*hol/, "holiday days are highlighted");
    assert.ok((await pool.query("SELECT 1 FROM dept_holidays WHERE holiday = '2027-03-10'")).rows[0], "2027 holidays added");
    // edit right in the calendar: the entry opens in a panel and saving comes back to the same view
    const here = `/department/calendar?m=${m}&show=hol%2Cwmf%2Ccorp%2Caway%2Cteam`;
    assert.match(pg, new RegExp(`edit=${e.id}#tc-edit`), "team entries open in the calendar");
    const pn = ok200(await admin(`/department/calendar?m=${m}&edit=${e.id}`), "edit panel").text;
    assert.match(pn, /id="tc-edit"/); assert.match(pn, /Edit: Team meeting/);
    const sv = await admin(`/department/calendar/entry/${e.id}`, { method: "POST", form: { title: "Team meeting", category: "Meeting", start_date: d, start_time: "10:30", repeat: "weekly", who: "Whole team", back: here + `&edit=${e.id}` } });
    assert.equal(sv.location, here, "back to the same calendar view");
    assert.match(ok200(await admin(`/department/calendar?m=${m}&add=${d}`), "add panel").text, /Add on /);
    await admin(`/department/calendar/entry/${e.id}/delete`, { method: "POST", form: {} });
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM dept_calendar")).rows[0].n, 0);
  });

  await t.test("Corporate sponsor report: for the team, and reachable from the management and marketing links", async () => {
    const m = E.helpers.addMonths(today.slice(0, 7), -1), q = `?period=month&p=${m}`;
    const pg = ok200(await admin(`/corporate/management${q}`), "sponsor report").text;
    for (const x of ["Sponsor scorecard", "Sessions delivered", "Avg per session", "Participation by month", "Sessions delivered vs planned", "Staff engagement", "Activity mix", "Highlights for our sponsors", "Next month", "Edit the words"])
      assert.match(pg, new RegExp(x), x);
    await admin("/corporate/management/notes", { method: "POST", form: { period: `month:${m}`, back: `/corporate/management${q}`, highlights: "Sponsor praise from HR", next: "" } });
    assert.match(ok200(await admin(`/corporate/management${q}`), "after saving").text, /Sponsor praise from HR/);
    await admin("/report/management/links", { method: "POST", form: { label: "Corp view" } });
    const g = (await pool.query("SELECT token FROM report_links WHERE kind = 'management' AND label = 'Corp view'")).rows[0].token;
    const pub = client();
    const wm = ok200(await pub(`/g/${g}${q}`), "management link").text;
    assert.match(wm, new RegExp(`/g/${g}/corporate`), "management report links to the full corporate view");
    const cv = ok200(await pub(`/g/${g}/corporate${q}`), "corporate via management link").text;
    assert.match(cv, /Sponsor scorecard/); assert.doesNotMatch(cv, /Edit the words|For the team|@test\.local/, "view only, no hub");
    const mk = (await pool.query("SELECT token FROM report_links WHERE kind = 'marketing' AND active LIMIT 1")).rows[0];
    if (mk) assert.match(ok200(await pub(`/m/${mk.token}/corporate${q}`), "corporate via marketing link").text, /Sponsor scorecard/);
    assert.equal((await pub(`/g/nope/corporate${q}`)).status, 404);
    await pool.query("DELETE FROM report_notes WHERE period = $1", [`corp:month:${m}`]);
  });

  await t.test("Social media insights: marketing uploads or types them in; management sees the summary", async () => {
    const m = E.helpers.addMonths(today.slice(0, 7), -1), q = `?period=month&p=${m}`;
    await admin("/report/marketing/links", { method: "POST", form: { label: "Social test" } });
    const mk = (await pool.query("SELECT token FROM report_links WHERE kind = 'marketing' AND label = 'Social test'")).rows[0].token;
    const pub = client(), base = `/m/${mk}`;
    assert.match(ok200(await pub(base + q), "marketing link").text, /id="social-in"/, "marketing sees the input");
    // template → fill → upload
    const tpl = await pub(`${base}/social/template?month=${m}`, { raw: true });
    assert.equal(tpl.status, 200); assert.match(tpl.type, /spreadsheetml/);
    const ExcelJS = require("exceljs"), wb = new ExcelJS.Workbook(); await wb.xlsx.load(tpl.text);
    const ws = wb.worksheets[0], fill = { "Followers at start": [1000, 50], "Followers at end": [1100, 60], "Accounts reached": [9000, 300], "Total content views": [20000, 800], "Likes": [400, 20], "Shares": [50, 2] };
    ws.eachRow((row) => { const l = String(row.getCell(1).value || ""); for (const [k, v] of Object.entries(fill)) if (l.startsWith(k)) { row.getCell(2).value = v[0]; row.getCell(3).value = v[1]; } });
    const fd = new FormData(); fd.append("month", m);
    fd.append("file", new Blob([await wb.xlsx.writeBuffer()]), "insights.xlsx");
    assert.equal((await pub(`${base}/social/upload${q}`, { method: "POST", multipart: fd })).status, 303);
    const row = (await pool.query("SELECT data FROM social_insights WHERE month = $1", [m + "-01"])).rows[0];
    assert.ok(row, "month saved");
    // uploading the month again replaces it (with a theme this time)
    ws.eachRow((row) => { const l = String(row.getCell(1).value || ""); if (l.startsWith("Followers at start")) { row.getCell(2).value = 2000; row.getCell(3).value = null; }
      if (l.startsWith("Followers at end")) { row.getCell(2).value = 2200; row.getCell(3).value = 70; } if (l.startsWith("Accounts reached")) { row.getCell(2).value = 5000; row.getCell(3).value = null; }
      if (l.startsWith("Total content views")) { row.getCell(2).value = 10000; row.getCell(3).value = null; } if (l.startsWith("Likes")) { row.getCell(2).value = 300; row.getCell(3).value = null; }
      if (l.startsWith("Shares")) { row.getCell(2).value = null; row.getCell(3).value = null; } if (l.startsWith("Top-performing content theme")) row.getCell(2).value = "Ride-out reel"; });
    const fd2 = new FormData(); fd2.append("file", new Blob([await wb.xlsx.writeBuffer()]), "insights.xlsx"); fd2.append("month", m);
    assert.equal((await pub(`${base}/social/upload${q}`, { method: "POST", multipart: fd2 })).status, 303);
    assert.doesNotMatch(ok200(await pub(base + q), "after upload").text, /social\/save|name="m_0_/, "no typing table, upload only");
    const I = await require("../src/socialinsights").insightsFor({ start: m + "-01", end: E.helpers.addDays(E.helpers.addMonths(m, 1) + "-01", -1), key: `month:${m}` });
    assert.ok(I, "insights for the month");
    const viewTok = (await pool.query("SELECT token FROM report_links WHERE kind = 'management' AND active LIMIT 1")).rows[0].token;
    const g = ok200(await client()(`/g/${viewTok}${q}`), "management link").text;
    for (const x of ["Social media", "Followers", "Accounts reached", "Engagement rate", "Every metric"]) assert.match(g, new RegExp(x), x);
    assert.doesNotMatch(g, /id="social-in"|social\/save/, "management can't edit the figures");
    const kv = /Marketing Highlights<\/th><td>([\s\S]*?)<\/td>/.exec(g)[1];
    assert.match(kv, /2,270 followers \(\+270, \+13\.5%\) on Instagram and TikTok/, "one-page marketing highlights come from the upload"); assert.match(/Social Media Campaigns<\/th><td>([\s\S]*?)<\/td>/.exec(g)[1], /Ride-out reel/);
    assert.match(g, /Rides held/); assert.match(g, /AUH \d+ · DXB \d+/, "rides held split by city"); assert.match(g, /Social followers/);
    assert.doesNotMatch(g, /Marketing &amp; impact|Corporate rides &amp; marketing|Community scorecard/, "no repeats in management's view");
    assert.match(ok200(await admin(`/report/management${q}`), "team view").text, /Social media/);
    assert.equal((await client()(`/m/nope/social/template`)).status, 404);
    await pool.query("DELETE FROM social_insights WHERE month = $1", [m + "-01"]);
  });

  await t.test("Dashboards: every number box opens its details", async () => {
    for (const u of ["/report/management?period=year", "/wmf/rides?city=auh&period=year", "/corporate/rides?period=year", "/corporate?period=ytd", "/overview"]) {
      const pg = ok200(await admin(u), u).text;
      assert.match(pg, /class="tile big dt"/, u); assert.match(pg, /class="card dt-panel"/, u); assert.match(pg, /details\.js/, u);
    }
    await admin("/report/management/links", { method: "POST", form: { label: "Board" } });
    const tok = (await pool.query("SELECT token FROM report_links WHERE kind = 'management' AND label = 'Board'")).rows[0].token;
    const g = ok200(await client()(`/g/${tok}?period=year`), "shared").text;
    assert.match(g, /dt-panel/); assert.doesNotMatch(g, /@test\.local/);
  });
});
