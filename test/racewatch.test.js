"use strict";
/**
 * Race watch: the site readers, the UAE cycling/triathlon filter, and (with TEST_DATABASE_URL) the daily run end to end.
 * The fixtures copy the structure of the real pages as of 19 Nov 2026. The database part uses its own schema
 * ("racewatch_test"), so it can run alongside the other test files.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const DB = process.env.TEST_DATABASE_URL;
if (DB) {
  process.env.DATABASE_URL = DB + (DB.includes("?") ? "&" : "?") + "options=-c%20search_path%3Dracewatch_test";
  process.env.ADMIN_EMAIL = "admin@test.local";
  process.env.ADMIN_PASSWORD = "first-Password-1";
  process.env.RACE_WATCH_TOKEN = "race-watch-token-1234567890";
}
const W = require("../src/racewatch");

const PO = `<div class="events_flex_event"><a href="https://www.premieronline.com/event/ajman_cycling_race_2025_8563" class="uk-card uk-card-hover event">
  <div class="uk-card-body"><div class="uk-card-top"><span class="counrty-name"><img src="/images/location.svg" alt=""> Ajman, UAE <img src="x.png" alt="Cycling"></span>
  <span class="date">22.11.2026</span></div><h3 class="uk-card-title" uk-slider-parallax="x: 100,-100">Ajman Cycling Race</h3><span class="uk-card-btn">Cycling</span></div></a></div>
<div class="events_flex_event"><a href="https://www.premieronline.com/event/29_inch_8848" class="uk-card uk-card-hover event"><div class="uk-card-top"><span class="counrty-name"> Fujairah, UAE </span>
  <span class="date">27.11.2026 - 29.11.2026</span></div><h3 class="uk-card-title">29INCH Academy x Le M&eacute;ridien</h3><span class="uk-card-btn">Cycling</span></a></div>
<div class="events_flex_event"><a href="https://www.premieronline.com/event/qantab_8703" class="uk-card uk-card-hover event"><span class="counrty-name"> Muscat, Oman </span>
  <span class="date">27.11.2026</span><h3 class="uk-card-title">Oman Triathlon Championship series 3</h3><span class="uk-card-btn">Triathlon</span></a></div>
<div class="events_flex_event"><a href="https://www.premieronline.com/event/thiqah_8944" class="uk-card uk-card-hover event"><span class="counrty-name"> Sharjah, UAE </span>
  <span class="date">29.11.2026</span><h3 class="uk-card-title">AL Thiqah Run 2026</h3><span class="uk-card-btn">Running</span></a></div>`;

const RR = JSON.stringify([{ Mode: "", HasMore: false, Events: [
  { id: 423001, eventTypeName: "Triathlon", name: "HUDAYRIYAT NEXT GEN TRI", dateFrom: "2026-11-21", dateTo: "2026-11-21", location: "Abu Dhabi", countryCode: "AE", region: "", distances: "" },
  { id: 423002, eventTypeName: "Cycling", name: "Individual Time Trial Challenge 2026 |Only Road Bike", dateFrom: "2026-11-28", dateTo: "2026-11-28", location: "AL AIN", countryCode: "AE", region: "", distances: "" },
  { id: 423003, eventTypeName: "Running", name: "STEP OF LIFE MARATHON", dateFrom: "2026-11-28", dateTo: "2026-11-28", location: "DUBAI", countryCode: "AE", region: "", distances: "" },
] }]);

const ADSC = `<div class="event-item community" data-aos="fade-up"> <a class="event__img--thumb" href="/events/uae-tour-third-and-final-round-jebel-hafeet/"><img src="x.jpg"></a>
  <div class="content"> <div class="content__info"> <span class="event--type">community</span> <h3>UAE Tour | Third and Final Round &#x2013; Jebel Hafeet</h3>
  <ul> <li> When <span> 28 Nov 2026 </span> </li> <li>Where <span>JAPEL HAFEET</span></li> </ul> </div></div></div>
<div class="event-item professional" data-aos="fade-up"> <a class="event__img--thumb" href="/events/spartan/"></a><div class="content"><h3>Spartan World Championship 2026</h3>
  <ul><li>When <span>19 NOV - 22 NOV 2026</span></li><li>Where <span>AL WATHBA DESERT |ABU DHABI</span></li></ul></div></div>
<div class="event-item professional" data-aos="fade-up"> <a class="event__img--thumb" href="/events/triathlon/"></a><div class="content"><h3>World Triathlon Championship Series Abu Dhabi</h3>
  <ul><li>When <span>30 DEC 2026 - 02 JAN 2027</span></li><li>Where <span>HUDAYRIYAT ISLAND</span></li></ul></div></div>`;

const HOPA = `<li
    class="relative p-4 bg-white text-gray-800"><div class="flex"><h3 class="font-semibold"><a href="https://www.hopasports.com/en/event/ajman-duathlon-2026" class="hover:underline">Ajman Duathlon 2026</a></h3>
    <!--[if BLOCK]><![endif]--><span class="line-clamp-1">Registration closing soon</span><p>Run, bike, run around Ajman.</p>
    <div><svg viewBox="0 0 24 24"><path d="M1"/></svg> Ajman, AE</div><div>Sat. 19 Dec. 2026</div><div>Sat. 19 Dec. 2026</div><div>Ajman, AE</div></div></li>
<li class="relative p-4 bg-white"><h3 class="font-semibold"><a href="https://www.hopasports.com/en/event/sharm" class="hover:underline">Sharm El Sheikh Half Marathon</a></h3>
    <div>South Sinai Governorate, EG</div><div>Sat. 28 Nov. 2026</div></li>`;

test("site readers", () => {
  const po = W.parse(PO, "https://www.premieronline.com/");
  assert.equal(po.length, 4);
  assert.deepEqual({ ...po[0] }, { title: "Ajman Cycling Race", date: "2026-11-22", end: null, time: null, location: "Ajman", country: "AE", url: "https://www.premieronline.com/event/ajman_cycling_race_2025_8563", text: "Cycling" });
  assert.equal(po[1].end, "2026-11-29", "multi-day");
  assert.equal(po[2].country, "other");

  const rr = W.parse(RR, "https://my.raceresult.com/events/");
  assert.equal(rr.length, 3);
  assert.equal(rr[1].location, "Al Ain", "capitals tidied");
  assert.equal(rr[0].url, "https://my.raceresult.com/423001/");
  assert.match(W.ADAPTERS["my.raceresult.com"].url("https://my.raceresult.com/events/", "2026-11-19"), /country=784&dateFrom=2026-11-19&dateTo=2027-11-19/);

  const ad = W.parse(ADSC, "https://adsc.ae/events");
  assert.equal(ad[0].title, "UAE Tour | Third and Final Round – Jebel Hafeet");
  assert.equal(ad[0].url, "https://adsc.ae/events/uae-tour-third-and-final-round-jebel-hafeet/");
  assert.equal(ad[0].location, "Japel Hafeet");
  assert.deepEqual([ad[1].date, ad[1].end], ["2026-11-19", "2026-11-22"]);
  assert.deepEqual([ad[2].date, ad[2].end], ["2026-12-30", "2027-01-02"], "a range across new year");

  const hp = W.parse(HOPA, "https://www.hopasports.com/en/events");
  assert.deepEqual([hp[0].title, hp[0].date, hp[0].location, hp[0].country], ["Ajman Duathlon 2026", "2026-12-19", "Ajman", "AE"]);
  assert.equal(hp[1].country, "EG");
});

test("schema.org events and .ics feeds", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"SportsEvent","name":"Dubai Gran Fondo","startDate":"2027-02-06T05:30:00+04:00",
    "endDate":"2027-02-06","url":"/races/fondo","location":{"@type":"Place","name":"Meydan","address":{"addressLocality":"Dubai","addressCountry":"AE"}}},{"@type":"Organization","name":"x"}]}</script>`;
  const [e] = W.fromJsonLd(html, "https://example.ae/calendar");
  assert.deepEqual([e.title, e.date, e.time, e.location, e.country, e.url], ["Dubai Gran Fondo", "2027-02-06", "05:30", "Meydan, Dubai", "AE", "https://example.ae/races/fondo"]);
  const ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:Al Wathba Cycle \r\n Race\r\nDTSTART;VALUE=DATE:20270115\r\nDTEND;VALUE=DATE:20270117\r\nLOCATION:Al Wathba\\, Abu Dhabi\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
  const [i] = W.parse(ics, "https://example.ae/cal.ics");
  assert.deepEqual([i.title, i.date, i.end, i.location], ["Al Wathba Cycle Race", "2027-01-15", "2027-01-16", "Al Wathba, Abu Dhabi"]);
  assert.equal(W.dubai("2026-12-06T02:00:00Z").time, "06:00", "UTC times shown in Dubai time");
});

test("UAE cycling and triathlon only", () => {
  const sport = (title, text = "") => W.isOurSport({ title, text });
  for (const t of ["Ajman Cycling Race", "JAIS Ride 2026", "Al Ain Duathlon Series", "RAK Tri 113 + 76", "AD Ports Group Gran Fondo 2026", "UAE Tour | Third and Final Round", "L’Etape Dubai Junior Challenge"]) assert.ok(sport(t), t);
  assert.ok(sport("Masfout X 2026", "Mountain Bike & Run"));
  for (const t of ["ADNOC Abu Dhabi Marathon", "Spartan World Championship 2026", "Her Padel Series", "Saturday Run @ Al Heera Beach"]) assert.ok(!sport(t), t);
  assert.ok(!sport("Dubai 10K", "free bike parking"), "a run that mentions bikes");
  assert.ok(W.inUae({ country: "AE" }) && W.inUae({ country: null }) && W.inUae({ country: "other", location: "Dubai" }));
  assert.ok(!W.inUae({ country: "other", location: "Muscat" }) && !W.inUae({ country: "EG", location: "South Sinai Governorate" }));
  assert.equal(W.keyOf({ title: "Ajman Cycling Race", date: "2026-11-22" }), W.keyOf({ title: "AJMAN cycling race!", date: "2026-11-22" }), "same race on two sites");
});

test("daily run", { skip: !DB && "set TEST_DATABASE_URL" }, async (t) => {
  const { pool } = require("../src/db");
  const { app, init } = require("../src/server");
  const R = require("../src/rules");
  await pool.query("DROP SCHEMA IF EXISTS racewatch_test CASCADE; CREATE SCHEMA racewatch_test;");
  await init();
  const server = await new Promise((ok) => { const s = app.listen(0, () => ok(s)); });
  const base = "http://127.0.0.1:" + server.address().port;
  t.after(async () => { server.close(); await pool.end(); });

  const today = R.todayLocal(), y = (n) => { const d = new Date(today + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dd = (iso) => iso.split("-").reverse().join(".");
  const card = (title, date, place, sport) => `<a href="https://www.premieronline.com/event/${encodeURIComponent(title)}" class="uk-card event"><span class="counrty-name">${place}</span><span class="date">${dd(date)}</span><h3 class="uk-card-title">${title}</h3><span class="uk-card-btn">${sport}</span></a>`;
  let po = card("Test Cycling Race", y(5), "Ajman, UAE", "Cycling") + card("Test Fun Run", y(5), "Dubai, UAE", "Running") + card("Oman Test Tri", y(6), "Muscat, Oman", "Triathlon") + card("Old Test Tri", y(-3), "Dubai, UAE", "Triathlon");
  const rr = () => JSON.stringify([{ Events: [{ id: 9, eventTypeName: "Cycling", name: "TEST CYCLING RACE", dateFrom: y(5), dateTo: y(5), location: "AJMAN", countryCode: "AE" }] }]);
  const load = async (u) => { if (u.includes("raceresult")) return rr(); if (u.includes("premieronline")) return po; throw new Error("HTTP 503"); };
  await pool.query("INSERT INTO settings (key, value) VALUES ('raceWatch', $1)", [JSON.stringify({ sources: ["https://www.premieronline.com/", "https://my.raceresult.com/events/", "https://broken.example/"] })]);

  const r1 = await W.run({ load, notify: false });
  assert.deepEqual(r1.added.map((a) => a.title), ["Test Cycling Race"], "one race: same race on two sites, runs, Oman and past races left out");
  assert.equal(r1.errors.length, 1, "a page that can't be read is reported, the rest still run");
  const item = (await pool.query("SELECT * FROM calendar_items WHERE category = 'external_race'")).rows;
  assert.equal(item.length, 1);
  assert.deepEqual([item[0].status, item[0].start_date, item[0].location], ["Tentative", y(5), "Ajman"]);

  assert.equal((await W.run({ load, notify: false })).added.length, 0, "nothing new the second time");
  assert.equal(await W.maybeRun(), null, "the app's own check waits 20 hours after the last one");
  await pool.query("DELETE FROM calendar_items WHERE id = $1", [item[0].id]);
  po += card("Test Duathlon", y(9), "Al Ain, UAE", "Duathlon");
  const r3 = await W.run({ load, notify: false });
  assert.deepEqual(r3.added.map((a) => a.title), ["Test Duathlon"], "a deleted race is not added back; a new one is");

  // the calendar shows it; the daily endpoint needs the token
  const cal = await (await fetch(base + "/api/calendar.json")).json();
  assert.ok(cal.items.some((i) => i.c === "external_race" && i.t === "Test Duathlon" && i.status === "Tentative"));
  assert.equal((await fetch(base + "/api/race-watch/run", { method: "POST" })).status, 401);
  assert.equal((await fetch(base + "/api/race-watch/run", { method: "POST", headers: { authorization: "Bearer wrong-token-wrong-token-12" } })).status, 401);
  await pool.query("UPDATE settings SET value = jsonb_set(value, '{sources}', '[]') WHERE key = 'raceWatch'");
  const ok = await fetch(base + "/api/race-watch/run", { method: "POST", headers: { authorization: "Bearer " + process.env.RACE_WATCH_TOKEN } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).added, []);
  assert.equal((await fetch(base + "/calendar/races", { redirect: "manual" })).status, 302, "the Race watch page is for staff");

  // staff: the Race watch page lists what was found and saves the pages to watch
  const login = await fetch(base + "/login", { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
    body: new URLSearchParams({ email: "admin@test.local", password: "first-Password-1", next: "/" }) });
  const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  await fetch(base + "/account/password", { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ current: "first-Password-1", password: "Second-Password-2" }) }); // first sign-in asks for a new password
  const pg = await fetch(base + "/calendar/races", { headers: { cookie } });
  assert.equal(pg.status, 200);
  const html = await pg.text();
  assert.match(html, /Test Duathlon/);
  assert.match(html, /Deleted \(won't be added again\)/);
  const save = await fetch(base + "/calendar/races/settings", { method: "POST", redirect: "manual", headers: { cookie, origin: base, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ sources: "https://adsc.ae/events\nnot-a-link", notify: "rona@example.org" }) });
  assert.equal(save.status, 302);
  assert.deepEqual(await W.getConfig().then((c) => [c.sources, c.notify]), [["https://adsc.ae/events"], "rona@example.org"]);
  assert.match(await (await fetch(base + "/calendar", { headers: { cookie } })).text(), /Race watch/);
});
