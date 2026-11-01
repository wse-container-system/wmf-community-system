"use strict";
/**
 * End-to-end test against a real Postgres. Needs TEST_DATABASE_URL (an empty database it may wipe)
 * and TEST_WORKBOOK (path to WMF_Community_Master_System_Integrated.xlsx).
 *   TEST_DATABASE_URL=postgres://postgres@localhost/wmf_test TEST_WORKBOOK=./in/wb.xlsx npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const DB = process.env.TEST_DATABASE_URL, WB = process.env.TEST_WORKBOOK;
if (!DB || !WB) { test("e2e (skipped: set TEST_DATABASE_URL and TEST_WORKBOOK)", () => {}); return; }
process.env.DATABASE_URL = DB;
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASSWORD = "first-Password-1";

const { pool } = require("../src/db");
const { app, migrate, ensureAdmin } = require("../src/server");
const { parseWorkbook } = require("../src/importer");
const R = require("../src/rules");
const E = require("../src/engine");

let base, server;
function client() {
  const jar = {};
  const f = async (path, { method = "GET", form, json, body, headers = {}, raw } = {}) => {
    const h = { ...headers, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; "), origin: base };
    let b = body;
    if (form) { b = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
    if (json) { b = JSON.stringify(json); h["content-type"] = "application/json"; }
    const r = await fetch(base + path, { method, headers: h, body: b, redirect: "manual" });
    for (const c of r.headers.getSetCookie()) { const [kv] = c.split(";"); const i = kv.indexOf("="); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    const text = raw ? Buffer.from(await r.arrayBuffer()) : await r.text();
    return { status: r.status, location: r.headers.get("location"), text, json: () => JSON.parse(text), type: r.headers.get("content-type") };
  };
  return f;
}
async function login(c, email, pw) {
  const r = await c("/login", { method: "POST", form: { email, password: pw, next: "/" } });
  assert.equal(r.status, 302, "login redirects");
  return r.location;
}

test.before(async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
  await ensureAdmin();
  await new Promise((ok) => { server = app.listen(0, ok); });
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(async () => { server.close(); await pool.end(); });

test("full flow", async (t) => {
  const admin = client();
  let loc;

  await t.test("first admin must choose a password", async () => {
    loc = await login(admin, "admin@test.local", "first-Password-1");
    assert.equal(loc, "/account/password");
    const r = await admin("/account/password", { method: "POST", form: { current: "first-Password-1", password: "Second-Password-2" } });
    assert.equal(r.location, "/");
    const home = await admin("/");
    assert.match(home.text, /The database is empty/);
  });

  await t.test("workbook import: preview, then commit", async () => {
    const fd = new FormData();
    fd.append("file", new Blob([fs.readFileSync(WB)]), "WMF_Community_Master_System_Integrated.xlsx");
    const jar = (await admin("/admin")).status; assert.equal(jar, 200);
    const r = await fetch(base + "/admin/import", { method: "POST", body: fd, headers: { origin: base, cookie: (await cookieOf(admin)) } });
    const html = await r.text();
    assert.match(html, /Nothing has been written yet/);
    const token = /name="token" value="([0-9a-f]+)"/.exec(html)[1];
    assert.equal(Number((await pool.query("SELECT count(*) n FROM members")).rows[0].n), 0, "preview writes nothing");
    const c = await admin("/admin/import/commit", { method: "POST", form: { token } });
    assert.equal(c.location, "/admin");
    const n = (await pool.query("SELECT (SELECT count(*) FROM members) m, (SELECT count(*) FROM participation) p, (SELECT count(*) FROM history_rides) h")).rows[0];
    const parsed = await parseWorkbook(fs.readFileSync(WB));
    assert.equal(Number(n.m), parsed.summary.members);
    assert.equal(Number(n.p), parsed.summary.activity);
    assert.equal(Number(n.h), parsed.summary.historyRides);
    const m1 = (await pool.query("SELECT * FROM members WHERE member_id = 'WMF-000001'")).rows[0];
    assert.equal(m1.qr_value, "WMF-000001", "QR value kept");
  });

  await t.test("second import without REPLACE is refused", async () => {
    const parsed = await parseWorkbook(fs.readFileSync(WB));
    await assert.rejects(require("../src/importer").commitImport(parsed, "test", {}), /already holds data/);
  });

  let rideId;
  await t.test("scanner: existing QR codes check in once per ride per day", async () => {
    const acts = (await pool.query("SELECT * FROM activities WHERE kind = 'ride' AND status = 'Active'")).rows;
    rideId = acts.find((a) => a.name === "Saturday Ride").activity_id;
    const today = R.todayLocal();
    // a member with no ride today
    const r1 = (await admin("/api/scan", { method: "POST", json: { code: "WMF-000005", activityId: rideId, date: today } })).json();
    assert.equal(r1.status, "ok", JSON.stringify(r1));
    assert.equal(r1.memberId, "WMF-000005");
    const r2 = (await admin("/api/scan", { method: "POST", json: { code: "WMF-000005", activityId: rideId, date: today } })).json();
    assert.equal(r2.status, "duplicate");
    // the old QR codes were made by quickchart with the plain Member ID; a URL around it also works
    const r3 = (await admin("/api/scan", { method: "POST", json: { code: "https://quickchart.io/qr?size=300&text=WMF-000006", activityId: rideId, date: today } })).json();
    assert.equal(r3.status, "ok");
    const bad = (await admin("/api/scan", { method: "POST", json: { code: "hello", activityId: rideId, date: today } })).json();
    assert.equal(bad.status, "error");
    const unknown = (await admin("/api/scan", { method: "POST", json: { code: "WMF-999999", activityId: rideId, date: today } })).json();
    assert.equal(unknown.status, "error");
    const future = (await admin("/api/scan", { method: "POST", json: { code: "WMF-000007", activityId: rideId, date: "2099-01-01" } })).json();
    assert.equal(future.status, "error");
    const rows = (await pool.query("SELECT * FROM participation WHERE member_id = 'WMF-000005' AND source = 'WMF QR Attendance Scanner' AND NOT imported")).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].form_response_id, "WMF-000005");
    assert.match(rows[0].record_id, /^ATT-\d+$/);
  });

  await t.test("scanner respects attendance already imported from the forms", async () => {
    const r = (await pool.query(`SELECT * FROM participation WHERE imported AND record_type = 'Attendance' AND status = 'Attended' AND member_id IS NOT NULL
      AND record_date >= now() - interval '13 days' ORDER BY record_date DESC LIMIT 1`)).rows[0];
    if (!r) return; // no recent imported ride to test against
    const act = (await pool.query("SELECT * FROM activities WHERE activity_id = $1", [r.activity_id])).rows[0];
    if (!act || act.kind !== "ride") return;
    const out = (await admin("/api/scan", { method: "POST", json: { code: r.member_id, activityId: act.activity_id, date: r.record_date.slice(0, 10) } })).json();
    assert.equal(out.status, "duplicate");
  });

  let newId;
  await t.test("public registration: next Member ID, QR shown, duplicates refused", async () => {
    const pub = client();
    const before = (await pool.query("SELECT max(member_id) mx FROM members")).rows[0].mx;
    const r = await pub("/join", { method: "POST", form: { full_name: "Test Rider", email: "Test.Rider@Example.org", mobile: "050 123 4567", waiver_consent: "1" } });
    assert.match(r.text, /Welcome, Test!/);
    newId = /class="id">(WMF-\d+)</.exec(r.text)[1];
    assert.equal(newId, R.formatMemberId(+before.slice(4) + 1));
    assert.match(r.text, /data:image\/png;base64/);
    const m = (await pool.query("SELECT * FROM members WHERE member_id = $1", [newId])).rows[0];
    assert.equal(m.primary_email, "test.rider@example.org", "email normalised");
    assert.equal(m.qr_value, newId);
    const again = await pub("/join", { method: "POST", form: { full_name: "Test Rider", email: "test.rider@example.org", mobile: "0501234567", waiver_consent: "1" } });
    assert.match(again.text, /already registered/);
    assert.doesNotMatch(again.text, /data:image\/png/, "no QR handed to someone typing a known email");
    const scan = (await admin("/api/scan", { method: "POST", json: { code: newId, activityId: rideId, date: R.todayLocal() } })).json();
    assert.equal(scan.status, "ok"); assert.equal(scan.rides, 1);
  });

  let evId;
  await t.test("event sign-up: open, idempotent, capacity", async () => {
    let r = await admin("/activities", { method: "POST", form: { name: "Test Gran Fondo Briefing", kind: "event", location: "Dubai", event_date: "2099-12-01", capacity: "2", registration_open: "1" } });
    assert.equal(r.location, "/activities");
    evId = (await pool.query("SELECT activity_id FROM activities WHERE name = 'Test Gran Fondo Briefing'")).rows[0].activity_id;
    const pub = client();
    const list = await pub("/events"); assert.match(list.text, /Test Gran Fondo Briefing/);
    r = await pub("/events/" + evId, { method: "POST", form: { full_name: "Test Rider", email: "test.rider@example.org", mobile: "0501234567", waiver_consent: "1" } });
    assert.match(r.text, /signed up!/);
    r = await pub("/events/" + evId, { method: "POST", form: { full_name: "Test Rider", email: "test.rider@example.org", mobile: "0501234567", waiver_consent: "1" } });
    assert.match(r.text, /already signed up/);
    r = await pub("/events/" + evId, { method: "POST", form: { full_name: "Other Person", email: "other.person@example.org", mobile: "0507654321", waiver_consent: "1" } });
    assert.match(r.text, /signed up!/); assert.match(r.text, /You're also now a WMF member/);
    r = await pub("/events/" + evId, { method: "POST", form: { full_name: "Third", email: "third@example.org", mobile: "0507654000", waiver_consent: "1" } });
    assert.match(r.text, /event is full/);
    const regs = (await pool.query("SELECT count(*) n FROM participation WHERE activity_id = $1", [evId])).rows[0].n;
    assert.equal(Number(regs), 2);
  });

  await t.test("member edit needs a reason and is audited; merge and void work", async () => {
    let r = await admin(`/members/${newId}/edit`, { method: "POST", form: { full_name: "Test Rider Edited", reason: "" } });
    assert.equal((await pool.query("SELECT full_name FROM members WHERE member_id = $1", [newId])).rows[0].full_name, "Test Rider");
    r = await admin(`/members/${newId}/edit`, { method: "POST", form: { full_name: "Test Rider Edited", reason: "Spelling" } });
    assert.equal((await pool.query("SELECT full_name FROM members WHERE member_id = $1", [newId])).rows[0].full_name, "Test Rider Edited");
    const a = (await pool.query("SELECT * FROM audit_log WHERE action = 'member.update' AND entity_id = $1", [newId])).rows[0];
    assert.equal(a.before.full_name, "Test Rider"); assert.equal(a.after.full_name, "Test Rider Edited"); assert.equal(a.reason, "Spelling");
    // email belonging to another member is refused
    r = await admin(`/members/${newId}/edit`, { method: "POST", form: { primary_email: "other.person@example.org", reason: "x" } });
    assert.equal((await pool.query("SELECT primary_email FROM members WHERE member_id = $1", [newId])).rows[0].primary_email, "test.rider@example.org");
    // merge "Other Person" into the test rider
    const other = (await pool.query("SELECT member_id FROM members WHERE primary_email = 'other.person@example.org'")).rows[0].member_id;
    r = await admin(`/members/${newId}/merge`, { method: "POST", form: { other, reason: "Same person" } });
    const o = (await pool.query("SELECT * FROM members WHERE member_id = $1", [other])).rows[0];
    assert.equal(o.merged_into, newId);
    assert.match((await pool.query("SELECT alt_emails FROM members WHERE member_id = $1", [newId])).rows[0].alt_emails, /other\.person@example\.org/);
    // the merged member's old QR now checks in the surviving member
    const s = (await admin("/api/scan", { method: "POST", json: { code: other, activityId: rideId, date: R.todayLocal() } })).json();
    assert.equal(s.status, "duplicate"); assert.equal(s.memberId, newId);
    // void a check-in, then the member can be checked in again
    const p = (await pool.query("SELECT id FROM participation WHERE member_id = $1 AND source = 'WMF QR Attendance Scanner'", [newId])).rows[0];
    r = await admin(`/participation/${p.id}/void`, { method: "POST", form: { reason: "Scanned by mistake" } });
    assert.ok((await pool.query("SELECT voided_at FROM participation WHERE id = $1", [p.id])).rows[0].voided_at);
    const again = (await admin("/api/scan", { method: "POST", json: { code: newId, activityId: rideId, date: R.todayLocal() } })).json();
    assert.equal(again.status, "ok");
  });

  await t.test("walk-in registers and checks in", async () => {
    const r = (await admin("/api/walkin", { method: "POST", json: { full_name: "Walk In", email: "walk.in@example.org", waiver_consent: "1", activityId: rideId, date: R.todayLocal() } })).json();
    assert.equal(r.status, "ok"); assert.ok(r.created);
  });

  await t.test("roles: viewer and sponsor get anonymised data; no operational pages", async () => {
    for (const role of ["viewer", "sponsor", "coordinator"]) {
      await admin("/admin/users", { method: "POST", form: { email: role + "@test.local", role } });
      const page = await admin("/admin/users");
      const pw = /<b style="font-family:monospace;font-size:16px">([^<]+)</.exec(page.text)[1];
      const c = client();
      assert.equal(await login(c, role + "@test.local", pw), "/account/password");
      await c("/account/password", { method: "POST", form: { current: pw, password: "Role-Password-123" } });
      const snap = await c("/api/snapshot.js");
      assert.equal(snap.status, 200);
      const data = JSON.parse(/window\.WMF_DATA=(.*);$/s.exec(snap.text)[1]);
      if (role === "coordinator") {
        assert.ok(data.members.some((m) => m.label === "Test Rider Edited"));
        assert.equal((await c("/members")).status, 200);
        assert.equal((await c("/admin")).status, 403);
      } else {
        assert.ok(!snap.text.includes("Test Rider"), "no names");
        assert.ok(!snap.text.includes("test.rider@"), "no emails");
        assert.ok(!snap.text.includes("31.mahra@"), "no imported emails");
        assert.equal((await c("/members")).status, 403);
        assert.equal((await c("/api/scan", { method: "POST", json: { code: "WMF-000001" } })).status, 403);
      }
    }
  });

  await t.test("dashboard figures: anonymised data gives the same numbers", async () => {
    const { buildData, anonymise } = require("../src/snapshot");
    const d = await buildData(), asOf = d.meta.asOf;
    const f = { start: asOf.slice(0, 7) + "-01", end: asOf };
    const a = E.compute(E.prepare(d), f, asOf).kpis, b = E.compute(E.prepare(anonymise(d, "s")), f, asOf).kpis;
    for (const k of ["uniqueMembers", "newMembers", "activeMembers", "rideAttendance", "rideSessions", "participants", "eventRegistrations", "recordsWithErrors"]) assert.deepEqual(b[k], a[k], k);
    assert.ok(a.rideAttendance >= 3, "today's scans are counted");
  });

  await t.test("security: cross-site posts refused, login required", async () => {
    const r = await fetch(base + "/api/scan", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json", cookie: await cookieOf(admin) }, body: "{}" });
    assert.equal(r.status, 403);
    const anon = client();
    assert.equal((await anon("/members")).status, 302);
    assert.equal((await anon("/api/snapshot.js")).status, 401);
    assert.equal((await anon("/api/scan", { method: "POST", json: {} })).status, 401);
  });

  await t.test("backup export re-imports with the same counts", async () => {
    const r = await admin("/admin/export.xlsx", { raw: true });
    assert.equal(r.status, 200);
    const parsed = await parseWorkbook(r.text);
    const n = (await pool.query("SELECT (SELECT count(*) FROM members) m, (SELECT count(*) FROM participation) p")).rows[0];
    assert.equal(parsed.summary.members, Number(n.m));
    assert.equal(parsed.summary.activity, Number(n.p));
  });
});

async function cookieOf(c) {
  // the client keeps cookies internally; read them back by asking for a page and capturing the header we send
  return c.__cookie || (c.__cookie = await new Promise((ok) => {
    const orig = global.fetch;
    global.fetch = (u, o) => { global.fetch = orig; ok(o.headers.cookie); return orig(u, o); };
    c("/healthz");
  }));
}
