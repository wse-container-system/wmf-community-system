"use strict";
/**
 * WhatsApp ride reminder: the ride schedule, the weather and the message. No database here, so the
 * GitHub Action (scripts/ride-reminder-notify.js) can build the same message when the app can't be reached.
 *
 * WhatsApp lets no app post into a group, so the app makes a share link (wa.me/?text=…) that opens WhatsApp
 * with the message filled in: pick the WMF group and tap send.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The regular rides: Monday and Wednesday, 06:00 at Hudayriyat Island. Staff change it on the Ride reminder page. */
const DEFAULT_SCHEDULE = {
  1: { on: true, time: "06:00", location: "Hudayriyat Island" },
  3: { on: true, time: "06:00", location: "Hudayriyat Island" },
};

/** Where a venue is, for the weather. Matched on words in the location; anything else uses Abu Dhabi city. */
const VENUES = [
  [/hudayriyat|hudairiyat/i, 24.432, 54.336],
  [/yas marina|ymc|circuit/i, 24.467, 54.603],
  [/yas/i, 24.488, 54.605],
  [/wathba/i, 24.262, 54.611],
  [/saadiyat/i, 24.542, 54.434],
  [/corniche/i, 24.476, 54.336],
  [/hafeet/i, 24.060, 55.776],
  [/al ain/i, 24.207, 55.745],
  [/qudra/i, 24.845, 55.371],
  [/nad al sheba|meydan/i, 25.153, 55.315],
  [/dubai|dxb/i, 25.205, 55.271],
];
const ABU_DHABI = [24.454, 54.377];
const coordsFor = (location) => { const v = VENUES.find(([re]) => re.test(location || "")); return v ? [v[1], v[2]] : ABU_DHABI; };

/** Open-Meteo weather codes (WMO), in words. */
const SKY = { 0: "Clear skies", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Foggy", 48: "Foggy", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle",
  56: "Freezing drizzle", 57: "Freezing drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Freezing rain", 67: "Freezing rain", 71: "Light snow", 73: "Snow",
  75: "Heavy snow", 77: "Snow", 80: "Light showers", 81: "Showers", 82: "Heavy showers", 85: "Snow showers", 86: "Snow showers", 95: "Thunderstorms", 96: "Thunderstorms with hail", 99: "Thunderstorms with hail" };

const pad = (n) => String(n).padStart(2, "0");
const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const weekday = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const longDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return `${DAY_NAMES[weekday(iso)]}, ${d} ${MON[m - 1]} ${y}`; };
const time12 = (t) => { const [hh, mm] = String(t || "06:00").split(":").map(Number); return `${((hh + 11) % 12) + 1}:${pad(mm || 0)} ${hh < 12 ? "AM" : "PM"}`; };
/** Local Dubai time as "YYYY-MM-DDTHH:MM". */
const nowDubai = () => new Date().toLocaleString("sv-SE", { timeZone: process.env.APP_TIMEZONE || "Asia/Dubai", hour12: false }).replace(" ", "T").slice(0, 16);

/** The schedule with every day filled in (days not in the saved schedule are off). */
function schedule(saved) {
  const out = {};
  for (let d = 0; d < 7; d++) {
    const s = (saved && saved[d]) || (saved ? null : DEFAULT_SCHEDULE[d]) || {};
    out[d] = { on: !!s.on, time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || "") ? s.time : "06:00", location: String(s.location || "").trim() || "Hudayriyat Island" };
  }
  return out;
}

/** The ride on a date, or null when there's no ride that day (or it's skipped). */
function rideOn(date, { schedule: sch, skip = {} } = {}) {
  const s = schedule(sch)[weekday(date)];
  if (!s.on) return null;
  return { date, day: DAY_NAMES[weekday(date)], time: s.time, location: s.location, title: `WMF Community Ride — ${DAY_NAMES[weekday(date)]}`, skipped: !!skip[date] };
}

/**
 * The next ride from now: today's while it hasn't started (plus an hour, for latecomers), else the next ride day.
 * Skipped dates are passed over unless `withSkipped`.
 */
function nextRides(n = 1, { schedule: sch, skip, now = nowDubai(), withSkipped = false } = {}) {
  const out = [], today = now.slice(0, 10);
  for (let i = 0; i < 15 && out.length < n; i++) {
    const r = rideOn(addDays(today, i), { schedule: sch, skip });
    if (!r || (r.skipped && !withSkipped)) continue;
    if (i === 0) { const [hh, mm] = r.time.split(":").map(Number); if (now.slice(11, 16) > `${pad(Math.min(23, hh + 1))}:${pad(mm)}`) continue; }
    out.push(r);
  }
  return out;
}

/**
 * Forecast at the ride's start, from Open-Meteo (free, no key). Returns { temp, sky } or null.
 * Kept for 30 minutes per ride; `fetcher` replaces fetch in tests.
 */
/** Where the wind comes from, as a compass point (N, NE, E …). */
const compass = (deg) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round((((deg % 360) + 360) % 360) / 45) % 8];
const cache = new Map();
async function weather(ride, { fetcher = fetch, timeoutMs = 4000 } = {}) {
  const [lat, lon] = coordsFor(ride.location), key = `${ride.date}|${ride.time}|${lat},${lon}`, hit = cache.get(key);
  if (hit && Date.now() - hit.at < 30 * 60e3) return hit.w;
  let w = null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=temperature_2m,weather_code,wind_speed_10m,wind_direction_10m&timezone=Asia%2FDubai&start_date=${ride.date}&end_date=${ride.date}`;
    const r = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "wmf-ride-reminder" } });
    if (r.ok) {
      const j = await r.json(), hr = j.hourly || {}, at = `${ride.date}T${ride.time.slice(0, 2)}:00`, i = (hr.time || []).indexOf(at);
      if (i >= 0 && hr.temperature_2m[i] != null) w = { temp: Math.round(hr.temperature_2m[i]), sky: SKY[hr.weather_code && hr.weather_code[i]] || "", wind: hr.wind_speed_10m && hr.wind_speed_10m[i] != null ? Math.round(hr.wind_speed_10m[i]) : null,
        dir: hr.wind_direction_10m && hr.wind_direction_10m[i] != null ? compass(hr.wind_direction_10m[i]) : "" };
    }
  } catch (e) { w = null; }
  if (w) cache.set(key, { at: Date.now(), w });
  return w;
}

/** The WhatsApp message (WhatsApp shows *text* in bold). */
function message(ride, { weather: w, signupUrl, note } = {}) {
  return [
    `🚴 *${ride.title}*`,
    `📅 ${longDate(ride.date)}`,
    `⏰ ${time12(ride.time)}`,
    `📍 ${ride.location}`,
    w ? `🌡️ ${w.temp}°C${w.sky ? ", " + w.sky : ""}` : null,
    w && w.wind != null ? `💨 ${w.wind} km/h${w.dir ? " " + w.dir : ""}` : null,
    signupUrl ? `🔗 Register here: ${signupUrl}` : null,
    note ? "\n" + String(note).trim() : null,
    "",
    "See you on the ride!",
  ].filter((x) => x !== null).join("\n");
}
const whatsappLink = (text) => "https://wa.me/?text=" + encodeURIComponent(text);
const signupPath = (date) => `/join-ride/${date}`;

module.exports = { DEFAULT_SCHEDULE, DAY_NAMES, schedule, rideOn, nextRides, weather, message, whatsappLink, signupPath, compass, longDate, time12, coordsFor, addDays, nowDubai, _cache: cache };
