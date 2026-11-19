"use strict";
/**
 * WhatsApp ride reminder: the schedule, the weather, the message, and (with TEST_DATABASE_URL) the banner, the
 * sign-up link and the staff page end to end. The database part uses its own schema ("ridereminder_test").
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB + (DB.includes("?") ? "&" : "?") + "options=-c%20search_path%3Dridereminder_test";
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "first-Password-1";
}
const M = require("../src/ridemsg");

const forecast = (date, temp = 23.6, code = 0) => async (url) => {
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=24\.432&longitude=54\.336&/, "Hudayriyat's coordinates");
  const hours = [...Array(24).keys()], at6 = (v, other) => hours.map((x) => (x === 6 || x === 23 ? v : other));
  return { ok: true, json: async () => ({ hourly: { time: hours.map((x) => `${date}T${String(x).padStart(2, "0")}:00`), temperature_2m: at6(temp, 21.1), weather_code: at6(code, 1), wind_speed_10m: at6(12.4, 9) } }) };
};

test("ride days: Monday and Wednesday at 6 AM by default", () => {
  assert.equal(M.rideOn("2026-11-23").day, "Monday");
  assert.equal(M.rideOn("2026-11-25").day, "Wednesday");
  assert.equal(M.rideOn("2026-11-24"), null, "no ride on Tuesday");
  // Monday 04:00: today's ride; Monday 07:30 (after the start + 1 hour): Wednesday's
  assert.deepEqual(M.nextRides(2, { now: "2026-11-23T04:00" }).map((r) => r.date), ["2026-11-23", "2026-11-25"]);
  assert.equal(M.nextRides(1, { now: "2026-11-23T07:30" })[0].date, "2026-11-25");
  assert.equal(M.nextRides(1, { now: "2026-11-23T04:00", skip: { "2026-11-23": {} } })[0].date, "2026-11-25", "a day off is passed over");
  const sch = { 1: { on: false }, 6: { on: true, time: "05:30", location: "Al Wathba Cycle Track" } };
  assert.deepEqual(M.nextRides(1, { schedule: sch, now: "2026-11-23T04:00" }).map((r) => [r.date, r.time, r.location]), [["2026-11-28", "05:30", "Al Wathba Cycle Track"]]);
});

test("the WhatsApp message", async () => {
  M._cache.clear();
  const ride = M.rideOn("2026-11-23");
  const w = await M.weather(ride, { fetcher: forecast("2026-11-23") });
  assert.deepEqual(w, { temp: 24, sky: "Clear skies", wind: 12 }, "the forecast at the ride's start");
  const text = M.message(ride, { weather: w, signupUrl: "https://wmf.example/join-ride/2026-11-23" });
  assert.equal(text, "🚴 *WMF Community Ride — Monday*\n📅 Monday, 23 Nov 2026\n⏰ 6:00 AM\n📍 Hudayriyat Island\n🌡️ 24°C, Clear skies\n🔗 Register here: https://wmf.example/join-ride/2026-11-23\n\nSee you on the ride!");
  assert.equal(M.whatsappLink("a b\n&"), "https://wa.me/?text=a%20b%0A%26");
  // no weather (the service is down): the line is left out, the rest still goes
  M._cache.clear();
  const none = await M.weather(ride, { fetcher: async () => { throw new Error("offline"); } });
  assert.equal(none, null);
  assert.doesNotMatch(M.message(ride, { weather: none }), /°C/);
  assert.match(M.message(ride, { note: "Lights on, please." }), /Lights on, please\.\n\nSee you on the ride!$/);
  assert.equal(M.time12("18:05"), "6:05 PM");
});

test("banner, sign-up link and staff page", { skip: !DB && "set TEST_DATABASE_URL" }, async (t) => {
  const { pool } = require("../src/db");
  const { app, init } = require("../src/server");
  const R = require("../src/rules");
  await pool.query("DROP SCHEMA IF EXISTS ridereminder_test CASCADE; CREATE SCHEMA ridereminder_test;");
  await init();
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { server.close(); await pool.end(); });

  // a ride every day at 23:59, so there's always one today whatever time the test runs; weather comes from the stub
  const today = R.todayLocal(), tomorrow = M.addDays(today, 1);
  const every = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { on: true, time: "23:59", location: "Hudayriyat Island" }]));
  await pool.query("INSERT INTO settings (key, value) VALUES ('rideReminder', $1)", [JSON.stringify({ schedule: every })]);
  const realFetch = global.fetch;
  global.fetch = (url, o) => (String(url).includes("open-meteo") ? forecast(today, 25, 2)(url) : realFetch(url, o));
  M._cache.clear();
  t.after(() => { global.fetch = realFetch; });

  // the GitHub Action's view
  const j = await (await fetch(`${base}/api/ride-reminder.json?date=${today}`)).json();
  assert.equal(j.ride.date, today);
  assert.equal(j.signupUrl, `${base}/join-ride/${today}`);
  assert.match(j.message, /🌡️ 25°C, Partly cloudy/);
  assert.ok(j.whatsapp.startsWith("https://wa.me/?text="));
  assert.equal(decodeURIComponent(j.whatsapp.slice(20)), j.message);

  // a rider signs up from the link; a new person becomes a member and gets a QR code; twice = once
  assert.equal((await fetch(`${base}/join-ride/${today}`)).status, 200);
  assert.equal((await fetch(`${base}/join-ride/2020-01-06`)).status, 404, "past rides are closed");
  const form = (o) => ({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: base }, body: new URLSearchParams(o) });
  const rider = { full_name: "Test Rider", email: "rider@test.local", mobile: "0501234567", waiver_consent: "1" };
  const s1 = await (await fetch(`${base}/join-ride/${today}`, form(rider))).text();
  assert.match(s1, /You're in!/);
  assert.match(s1, /now a WMF member/);
  assert.match(await (await fetch(`${base}/join-ride/${today}`, form(rider))).text(), /already signed up/);
  assert.match(await (await fetch(`${base}/join-ride/${today}`, form({ ...rider, waiver_consent: "" }))).text(), /accept the terms/);
  const rows = (await pool.query("SELECT * FROM ride_signups")).rows;
  assert.equal(rows.length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM members WHERE primary_email = 'rider@test.local'")).rows[0].n, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM participation WHERE record_type = 'Attendance'")).rows[0].n, 0, "signing up is not attendance");

  // staff: the banner, the page, mark as sent, a day off
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ email: "admin@test.local", password: "first-Password-1", next: "/" }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await fetch(base + "/account/password", { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ current: "first-Password-1", password: "Second-Password-2" }) });
  const post = (path, o = {}) => fetch(base + path, { method: "POST", redirect: "manual", headers: { cookie, origin: base, referer: base + "/wmf", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(o) });

  const home = await (await fetch(base + "/wmf", { headers: { cookie } })).text();
  assert.match(home, /ride reminder is ready/);
  assert.match(home, /href="https:\/\/wa\.me\/\?text=/);
  assert.match(await (await fetch(base + "/", { headers: { cookie } })).text(), /ride reminder is ready/, "on the Hub too");
  const pg = await (await fetch(base + "/wmf/ride-reminder", { headers: { cookie } })).text();
  assert.match(pg, /1 signed up/);
  assert.match(pg, /Test Rider/);
  assert.match(pg, /Register here: /);

  assert.equal((await post(`/wmf/ride-reminder/${today}/sent`)).headers.get("location"), "/wmf");
  assert.doesNotMatch(await (await fetch(base + "/wmf", { headers: { cookie } })).text(), /ride reminder is ready/, "sent: the banner goes");
  await post(`/wmf/ride-reminder/${tomorrow}/skip`);
  assert.equal((await (await fetch(`${base}/api/ride-reminder.json?date=${tomorrow}`)).json()).skipped, true);
  assert.equal((await fetch(`${base}/join-ride/${tomorrow}`)).status, 404, "no sign-up on a day off");

  // settings: back to Monday and Wednesday at 6
  await post("/wmf/ride-reminder/settings", { on_1: "1", time_1: "06:00", location_1: "Hudayriyat Island", on_3: "1", time_3: "06:00", location_3: "", note: "Lights on!" });
  const cfg = await require("../src/ridereminder").getConfig();
  assert.deepEqual([cfg.schedule[1], cfg.schedule[2].on, cfg.schedule[3].location, cfg.note], [{ on: true, time: "06:00", location: "Hudayriyat Island" }, false, "Hudayriyat Island", "Lights on!"]);
  assert.equal((await fetch(base + "/wmf/ride-reminder", { redirect: "manual" })).status, 302, "the page is for staff");
});
