"use strict";
/** Corporate Cycling Programme: participants, sessions, check-ins and the figures used by the dashboard, reports and exports. */
const crypto = require("crypto");
const { pool, nextNumber, audit } = require("./db");
const R = require("./rules");
const E = require("./engine");
const { addDays, addMonths, monthEnd, monthsBetween } = E.helpers;

const DEFAULT_COMPANIES = [
  { code: "LIMAD", name: "L'IMAD", ride_days: "Thu", color: "#2f7fd6", sort_order: 1 },
  { code: "NMDC", name: "NMDC", ride_days: "Thu", color: "#13917a", sort_order: 2 },
  { code: "AURORA", name: "Aurora", ride_days: "Thu", color: "#d9634f", sort_order: 3 },
];
const KINDS = ["Weekly ride", "Running", "Yoga", "Workshop", "Event", "Other"];
const RIDE = "Weekly ride";
const COMMUNITIES = ["Emirati", "Expat"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ACTIVE_WINDOW = 90, ACTIVE_MIN = 2; // same rule as WMF: 2+ sessions in the last 90 days

const token = () => crypto.randomBytes(9).toString("base64url");
/** Name key: lower case, no accents or punctuation, words sorted (so "Al Ameri Sameera" = "Sameera Al Ameri"). */
const nameKey = (s) => R.clean(s).normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9؀-ۿ ]+/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
const weekdayShort = (iso) => DAYS[new Date(iso + "T12:00:00Z").getUTCDay()];
const isRideDay = (co, iso) => String(co.ride_days || "").split(/[ ,;]+/).map((d) => d.slice(0, 3).toLowerCase()).includes(weekdayShort(iso).toLowerCase());
const pidQr = (pid) => "CORP-" + pid;
/** Participant ID from a scanned code or a typed ID: "CORP-NMDC-0012", "NMDC-0012" and "nmdc 12" all give "NMDC-0012". */
const pidFromScan = (text) => { const m = R.clean(text).toUpperCase().match(/^(?:CORP-)?([A-Z]{2,12})[- ]?(\d{1,5})$/) || R.clean(text).toUpperCase().match(/CORP-([A-Z]{2,12})-(\d{1,5})\b/); return m ? `${m[1]}-${m[2].padStart(4, "0")}` : null; };

async function seedCompanies(c = pool) {
  for (const co of DEFAULT_COMPANIES) {
    await c.query(`INSERT INTO corp_companies (code, name, ride_days, color, sort_order, checkin_token) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO NOTHING`,
      [co.code, co.name, co.ride_days, co.color, co.sort_order, token()]);
  }
}
async function companies(c = pool, { all = false } = {}) {
  return (await c.query(`SELECT * FROM corp_companies ${all ? "" : "WHERE active"} ORDER BY sort_order, name`)).rows;
}
/** Companies this user may see: everything, or only the partner their account is limited to. */
async function companiesFor(u) {
  const list = await companies();
  return u && u.company ? list.filter((x) => x.code === u.company) : list;
}

async function createParticipant(c, d, by, source) {
  const n = await nextNumber(c, "CORP-" + d.company);
  const pid = `${d.company}-${String(n).padStart(4, "0")}`;
  const row = (await c.query(`INSERT INTO corp_participants (pid, company, full_name, name_key, email, gender, community, bike_size, status, joined, source, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
  [pid, d.company, R.clean(d.full_name), nameKey(d.full_name), R.normEmail(d.email) || null, R.clean(d.gender) || null, R.clean(d.community) || null,
    R.clean(d.bike_size) || null, d.status === "Inactive" ? "Inactive" : "Active", d.joined || R.todayLocal(), source, R.clean(d.notes) || null])).rows[0];
  await audit(c, by, "corp.participant.create", "corp_participant", pid, null, { company: d.company, name: row.full_name, source });
  if (!d.noSeason) { const se = await currentSeason(c, d.company); if (se) await enrol(c, se.id, row.id, source); }
  return row;
}
/** Match a person within a company: work email first, then the name (word order and accents ignored). */
async function findParticipant(c, company, { email, name, pid }) {
  if (pid) { const r = (await c.query("SELECT * FROM corp_participants WHERE pid = $1", [pid])).rows[0]; if (r) return r; }
  const e = R.normEmail(email);
  if (e) { const r = (await c.query("SELECT * FROM corp_participants WHERE company = $1 AND lower(email) = $2 ORDER BY id LIMIT 1", [company, e])).rows[0]; if (r) return r; }
  const k = nameKey(name);
  if (k) { const r = (await c.query("SELECT * FROM corp_participants WHERE company = $1 AND name_key = $2 ORDER BY id LIMIT 1", [company, k])).rows[0]; if (r) return r; }
  return null;
}
async function ensureSession(c, { company, date, kind = RIDE, title = "", status = "Held", by }) {
  const t = R.clean(title);
  const ex = (await c.query("SELECT * FROM corp_sessions WHERE company = $1 AND session_date = $2 AND kind = $3 AND title = $4", [company, date, kind, t])).rows[0];
  if (ex) return ex;
  return (await c.query("INSERT INTO corp_sessions (company, session_date, kind, title, status, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *", [company, date, kind, t, status, by])).rows[0];
}
/** One check-in per person per session. A scheduled session becomes "Held" at its first check-in. */
async function markAttendance(c, session, participant, method, by) {
  if (session.status === "Cancelled") return { status: "error", message: "This session was cancelled." };
  const r = await c.query(`INSERT INTO corp_attendance (session_id, participant_id, method, at, created_by) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (session_id, participant_id) DO NOTHING RETURNING id`, [session.id, participant.id, method, R.nowLocal(), by]);
  if (session.status === "Scheduled") await c.query("UPDATE corp_sessions SET status = 'Held' WHERE id = $1", [session.id]);
  if (participant.status === "Inactive") await c.query("UPDATE corp_participants SET status = 'Active', updated_at = now() WHERE id = $1", [participant.id]);
  const n = Number((await c.query("SELECT count(*) n FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = $1", [participant.id])).rows[0].n);
  return { status: r.rowCount ? "ok" : "duplicate", total: n };
}
// ---------------------------------------------------------------- schedules
/**
 * Regular sessions per company, e.g. "every Thursday 06:00" or "1st Thursday of the month 17:00".
 * week: 0 = every week, 1–4 = that week of the month (1st Thursday = days 1–7), -1 = the last one in the month.
 */
const WEEKDAYS_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const WEEKS = [[0, "Every week"], [1, "1st of the month"], [2, "2nd of the month"], [3, "3rd of the month"], [4, "4th of the month"], [-1, "Last of the month"]];
const dayNo = (iso) => new Date(iso + "T12:00:00Z").getUTCDay();
const daysInMonth = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7), 0)).getUTCDate();
function occursOn(sc, iso) {
  if (!sc.active || dayNo(iso) !== sc.weekday) return false;
  if (sc.starts && iso < String(sc.starts)) return false;
  if (sc.ends && iso > String(sc.ends)) return false;
  const d = +iso.slice(8, 10);
  if (sc.week === 0) return true;
  if (sc.week === -1) return d + 7 > daysInMonth(iso);
  return Math.ceil(d / 7) === sc.week;
}
const scheduleText = (sc) => `${sc.week === 0 ? "Every" : (WEEKS.find((w) => w[0] === sc.week) || [0, ""])[1].replace(" of the month", "")} ${WEEKDAYS_LONG[sc.weekday]}${sc.week === 0 ? "" : " of the month"}${sc.start_time ? " · " + sc.start_time : ""}`;
const schedName = (sc, co) => sc.title || (sc.kind === RIDE ? `${co ? co.name + " " : ""}weekly ride` : sc.kind);
async function schedules(c, codes, { all = false } = {}) {
  return (await c.query(`SELECT * FROM corp_schedules WHERE company = ANY($1) ${all ? "" : "AND active"} ORDER BY company, week = 0 DESC, week, weekday, start_time`, [codes])).rows;
}
/** First run only: the programme's regular sessions as agreed (adjustable on Corporate → Schedule). */
async function seedSchedules(c = pool) {
  const done = (await c.query("SELECT 1 FROM settings WHERE key = 'corpSchedulesSeeded'")).rows[0];
  if (done) return;
  const today = R.todayLocal();
  const rows = [["LIMAD", RIDE, "", 4, 0, "06:00"], ["NMDC", RIDE, "", 4, 0, null], ["AURORA", RIDE, "Aurora Ride", 4, 1, "17:00"], ["AURORA", "Running", "Aurora Running", 4, 2, "17:00"], ["AURORA", "Yoga", "Aurora Yoga", 4, 3, "17:00"]];
  for (const [co, kind, title, wd, wk, t] of rows) {
    if (!(await c.query("SELECT 1 FROM corp_companies WHERE code = $1", [co])).rows[0]) continue;
    await c.query("INSERT INTO corp_schedules (company, kind, title, weekday, week, start_time, starts) VALUES ($1,$2,$3,$4,$5,$6,$7)", [co, kind, title, wd, wk, t, today]);
  }
  await c.query("INSERT INTO settings (key, value) VALUES ('corpSchedulesSeeded', 'true') ON CONFLICT (key) DO NOTHING");
}
/** Every planned occurrence between two dates, with the session already recorded for it (if any). */
async function occurrences(c, codes, from, to) {
  const scs = await schedules(c, codes);
  const sess = (await c.query("SELECT * FROM corp_sessions WHERE company = ANY($1) AND session_date BETWEEN $2 AND $3", [codes, from, to])).rows;
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) for (const sc of scs) if (occursOn(sc, d)) {
    const s = sess.find((x) => x.company === sc.company && x.session_date === d && x.kind === sc.kind && x.title === (sc.title || ""));
    out.push({ date: d, sc, session: s || null });
  }
  return out;
}

/**
 * Sessions people can check in to today: anything recorded or scheduled for today, plus each planned session from the
 * company's schedule that isn't recorded yet (it is created at the first check-in). Companies with no schedule fall back to their ride days.
 */
async function todaysSessions(c, co) {
  const today = R.todayLocal();
  const all = (await c.query("SELECT * FROM corp_sessions WHERE company = $1 AND session_date = $2 ORDER BY kind = $3 DESC, start_time NULLS LAST, id", [co.code, today, RIDE])).rows;
  const rows = all.filter((s) => s.status !== "Cancelled");
  const scs = await schedules(c, [co.code]);
  if (scs.length) {
    for (const sc of scs) if (occursOn(sc, today) && !all.some((s) => s.kind === sc.kind && s.title === (sc.title || "")))
      rows.push({ id: 0, company: co.code, session_date: today, kind: sc.kind, title: sc.title || "", start_time: sc.start_time, location: sc.location, status: "Scheduled", virtual: true, sched: sc.id });
  } else if (!rows.some((s) => s.kind === RIDE) && !all.some((s) => s.kind === RIDE && s.status === "Cancelled") && isRideDay(co, today)) {
    rows.push({ id: 0, company: co.code, session_date: today, kind: RIDE, title: "", status: "Scheduled", virtual: true });
  }
  return rows.sort((a, b) => String(a.start_time || "99").localeCompare(String(b.start_time || "99")));
}
/** The value a form or scanner sends for a session: its number, or a plan to create it at the first check-in. */
const sessionValue = (s) => (s.virtual ? (s.sched ? `sched:${s.sched}` : `ride:${s.company}`) : String(s.id));
/**
 * Turn a sent value into today's session, creating a planned one on first use.
 * "ride:AUTO" + company = that company's session today (its ride first), or an extra ride when nothing is planned.
 */
async function resolveSession(c, value, { by, company } = {}) {
  const v = String(value || ""), today = R.todayLocal();
  if (v === "ride:AUTO") {
    const co = (await c.query("SELECT * FROM corp_companies WHERE code = $1", [company])).rows[0];
    if (!co) return null;
    const ss = await todaysSessions(c, co);
    const pick = ss.find((s) => s.kind === RIDE) || ss[0];
    return pick ? resolveSession(c, sessionValue(pick), { by }) : ensureSession(c, { company, date: today, kind: RIDE, status: "Held", by });
  }
  let m = /^sched:(\d+)$/.exec(v);
  if (m) {
    const sc = (await c.query("SELECT * FROM corp_schedules WHERE id = $1", [+m[1]])).rows[0];
    if (!sc) return null;
    const s = await ensureSession(c, { company: sc.company, date: today, kind: sc.kind, title: sc.title, status: "Held", by });
    if (!s.start_time && (sc.start_time || sc.location)) await c.query("UPDATE corp_sessions SET start_time = coalesce(start_time, $2), location = coalesce(location, $3) WHERE id = $1", [s.id, sc.start_time, sc.location]);
    return s;
  }
  m = /^ride:([A-Z]+)$/.exec(v);
  if (m) return ensureSession(c, { company: m[1], date: today, kind: RIDE, status: "Held", by });
  return (await c.query("SELECT * FROM corp_sessions WHERE id = $1", [+v || 0])).rows[0] || null;
}
const sessionName = (s, co) => s.title || (s.kind === RIDE ? `${co ? co.name + " " : ""}weekly ride` : s.kind);

// ---------------------------------------------------------------- figures
/**
 * Everything the dashboard and reports need for a set of companies and a date range.
 * Attendance of a session = named check-ins when there are any, otherwise the recorded headcount.
 */
async function stats({ codes, start, end, asOf = R.todayLocal() }) {
  const [sess, att, parts] = await Promise.all([
    pool.query(`SELECT s.*, (SELECT count(*) FROM corp_attendance a WHERE a.session_id = s.id)::int AS named FROM corp_sessions s
      WHERE s.company = ANY($1) ORDER BY s.session_date, s.id`, [codes]),
    pool.query(`SELECT a.participant_id, a.session_id, s.session_date::text AS d, s.company, s.kind FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id
      WHERE s.company = ANY($1) AND s.status <> 'Cancelled' ORDER BY s.session_date`, [codes]),
    pool.query("SELECT * FROM corp_participants WHERE company = ANY($1) ORDER BY company, full_name", [codes]),
  ]);
  // enrolled per company: the season list running at the end of the period (when the company uses seasons), otherwise everyone active
  const seasonRoster = new Map();
  { const refD = end < asOf ? end : asOf;
    const se = (await pool.query(`SELECT DISTINCT ON (s.company) s.company, (SELECT count(*) FROM corp_season_members m WHERE m.season_id = s.id)::int n
      FROM corp_seasons s WHERE s.company = ANY($1) AND s.start_date <= $2 AND EXISTS (SELECT 1 FROM corp_season_members m WHERE m.season_id = s.id)
      ORDER BY s.company, s.start_date DESC`, [codes, refD])).rows;
    for (const x of se) seasonRoster.set(x.company, x.n); }
  const P = new Map(parts.rows.map((p) => [p.id, { ...p, dates: [] }]));
  for (const a of att.rows) { const p = P.get(a.participant_id); if (p) p.dates.push(a.d); }
  for (const p of P.values()) { p.first = p.dates[0] || null; p.last = p.dates[p.dates.length - 1] || null; }
  const sessions = sess.rows.map((s) => ({ ...s, d: String(s.session_date).slice(0, 10), attendance: s.status === "Cancelled" ? 0 : s.named || s.headcount || 0 }));
  const inR = (d) => d >= start && d <= end;
  const S = sessions.filter((s) => inR(s.d));
  const held = S.filter((s) => s.status === "Held"), rides = held.filter((s) => s.kind === RIDE), events = held.filter((s) => s.kind !== RIDE);
  const A = att.rows.filter((a) => inR(a.d));
  const people = new Set(A.map((a) => a.participant_id));
  const sum = (arr) => arr.reduce((x, s) => x + s.attendance, 0);
  // community and new joiners: named check-ins use the participant record; headcount sessions use their own split
  let emirati = 0, expat = 0, unknownCommunity = 0, newJoiners = 0;
  for (const a of A) { const p = P.get(a.participant_id); const cm = (p && p.community) || ""; if (/emirati/i.test(cm)) emirati++; else if (/expat/i.test(cm)) expat++; else unknownCommunity++; }
  for (const s of held) if (!s.named) { emirati += s.headcount_emirati || 0; expat += s.headcount_expat || 0; unknownCommunity += Math.max(0, (s.headcount || 0) - (s.headcount_emirati || 0) - (s.headcount_expat || 0)); newJoiners += s.headcount_new || 0; }
  const newPeople = [...people].map((id) => P.get(id)).filter((p) => p && p.first && inR(p.first));
  newJoiners += newPeople.length;
  const ref = end < asOf ? end : asOf;
  const activeAt = (p, d) => p.dates.filter((x) => x <= d && x > addDays(d, -ACTIVE_WINDOW)).length >= ACTIVE_MIN;
  const allP = [...P.values()];
  const active = allP.filter((p) => activeAt(p, ref));
  const perPerson = new Map(); for (const a of A) perPerson.set(a.participant_id, (perPerson.get(a.participant_id) || 0) + 1);
  const repeat = [...perPerson.values()].filter((n) => n >= 2).length;

  // months (at least the range; widened to 6 months for a single month so there is a trend to see)
  let m0 = start.slice(0, 7); const m1 = end.slice(0, 7);
  if (monthsBetween(m0, m1).length < 6) m0 = addMonths(m1, -5);
  const months = monthsBetween(m0, m1).map((m) => {
    const ss = sessions.filter((s) => s.d.slice(0, 7) === m && s.status === "Held");
    const byCo = {}; for (const code of codes) byCo[code] = ss.filter((s) => s.company === code).reduce((x, s) => x + s.attendance, 0);
    const am = att.rows.filter((a) => a.d.slice(0, 7) === m);
    return { month: m, inRange: m >= start.slice(0, 7), rides: ss.filter((s) => s.kind === RIDE).length, events: ss.filter((s) => s.kind !== RIDE).length,
      rideAttendance: sum(ss.filter((s) => s.kind === RIDE)), eventAttendance: sum(ss.filter((s) => s.kind !== RIDE)), attendance: sum(ss),
      people: new Set(am.map((a) => a.participant_id)).size, byCo, cancelled: sessions.filter((s) => s.d.slice(0, 7) === m && s.status === "Cancelled").length };
  });
  const byKind = new Map(); for (const s of held) byKind.set(s.kind, (byKind.get(s.kind) || 0) + s.attendance);
  const byCompany = codes.map((code) => {
    const hs = held.filter((s) => s.company === code), rs = hs.filter((s) => s.kind === RIDE);
    return { code, sessions: rs.length, events: hs.length - rs.length, attendance: sum(hs), rideAttendance: sum(rs), avg: rs.length ? sum(rs) / rs.length : null,
      people: new Set(A.filter((a) => a.company === code).map((a) => a.participant_id)).size, active: active.filter((p) => p.company === code).length,
      roster: seasonRoster.has(code) ? seasonRoster.get(code) : allP.filter((p) => p.company === code && p.status === "Active").length, cancelled: S.filter((s) => s.company === code && s.status === "Cancelled").length,
      lastSession: (hs[hs.length - 1] || {}).d || null };
  });
  const top = [...perPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ ...P.get(id), inRange: n }));
  const needsAttendance = sessions.filter((s) => s.d <= asOf && (s.status === "Scheduled" || (s.status === "Held" && !s.named && s.headcount == null)));
  const lapsed = allP.filter((p) => p.status === "Active" && p.last && !activeAt(p, asOf) && p.last > addDays(asOf, -180)).sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return {
    start, end, asOf, codes,
    k: { rideSessions: rides.length, events: events.length, cancelled: S.filter((s) => s.status === "Cancelled").length, attendance: sum(held), rideAttendance: sum(rides),
      eventAttendance: sum(events), avgPerRide: rides.length ? sum(rides) / rides.length : null, people: people.size, newJoiners, emirati, expat, unknownCommunity,
      active: active.length, roster: byCompany.reduce((t, x) => t + x.roster, 0), repeat, repeatRate: people.size ? repeat / people.size : null,
      headcountOnly: held.filter((s) => !s.named).length },
    months, byKind: [...byKind.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value), byCompany,
    sessions: S, top, needsAttendance, lapsed, participants: P,
  };
}

/**
 * Check a participant in from a scanned code or typed ID. session = a session id, or "ride:<CODE>" for today's weekly ride
 * (created on the first scan). codes = the companies the scanner may record for.
 */
async function corpScan(c, { code, session, by, codes, method = "Scanned by staff" }) {
  if (/WMF-\d/i.test(String(code || ""))) return { status: "error", message: "That's a WMF member code." };
  const pid = pidFromScan(code);
  if (!pid) return { status: "error", message: "This is not a corporate QR code or ID." };
  const p = (await c.query("SELECT * FROM corp_participants WHERE pid = $1", [pid])).rows[0];
  if (!p || !codes.includes(p.company)) return { status: "error", message: `${pid} isn't on the participant list.` };
  // "ride:AUTO": today's session of whichever company the person belongs to
  const s = await resolveSession(c, session, { by, company: p.company });
  if (!s || !codes.includes(s.company)) return { status: "error", message: "Choose today's session first." };
  if (s.company !== p.company) return { status: "error", message: `${p.full_name} is with ${p.company}, not this session's company. Choose the ${p.company} session.` };
  const r = await markAttendance(c, s, p, method, by);
  return { ...r, name: p.full_name, pid: p.pid, company: p.company };
}

// ---------- seasons: one record per person; each season has its own list (enrolment) of people
async function seasons(c, company) {
  return (await c.query(`SELECT s.*, s.start_date::text AS start, s.end_date::text AS "end", (SELECT count(*) FROM corp_season_members m WHERE m.season_id = s.id)::int AS members
    FROM corp_seasons s WHERE company = $1 ORDER BY start_date DESC, id DESC`, [company])).rows;
}
/** The season running on a date (or the latest one that started before it). */
async function currentSeason(c, company, d = R.todayLocal()) {
  const all = await seasons(c, company);
  return all.find((s) => s.start <= d && s.end >= d) || all.find((s) => s.start <= d) || null;
}
async function enrol(c, seasonId, participantId, source) {
  await c.query("INSERT INTO corp_season_members (season_id, participant_id, source) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [seasonId, participantId, source || null]);
}
/** One-time start: NMDC's people so far become "NMDC 2025-2026"; "NMDC 2026-2027" is ready for the new list. */
async function seedSeasons(c) {
  const done = (await c.query("SELECT 1 FROM settings WHERE key = 'nmdcSeasonsSeeded'")).rows.length;
  if (done || !(await c.query("SELECT 1 FROM corp_companies WHERE code = 'NMDC'")).rows.length) return;
  const old = (await c.query(`INSERT INTO corp_seasons (company, name, start_date, end_date) VALUES ('NMDC', 'NMDC 2025-2026', '2025-09-01', '2026-08-31')
    ON CONFLICT (company, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`)).rows[0].id;
  await c.query(`INSERT INTO corp_seasons (company, name, start_date, end_date) VALUES ('NMDC', 'NMDC 2026-2027', '2026-09-01', '2027-08-31') ON CONFLICT DO NOTHING`);
  await c.query(`INSERT INTO corp_season_members (season_id, participant_id, source) SELECT $1, id, 'Existing list' FROM corp_participants WHERE company = 'NMDC' ON CONFLICT DO NOTHING`, [old]);
  await c.query("INSERT INTO settings (key, value) VALUES ('nmdcSeasonsSeeded', 'true') ON CONFLICT DO NOTHING");
}

/** A personal QR link that can't be guessed: /cq/NMDC-0012.<signature> shows only that person's code. */
const cqSig = (pid) => require("crypto").createHmac("sha256", process.env.SESSION_SECRET || "dev-only-secret").update("cq|" + pid).digest("base64url").slice(0, 12);
const cqPath = (pid) => `/cq/${encodeURIComponent(pid)}.${cqSig(pid)}`;

/**
 * New rider at a corporate session: find them (work email, then name) or add them to the company's list,
 * then check them in to the chosen session. Mobile is kept so their QR code can be sent on WhatsApp.
 */
async function walkIn(c, { company, session, full_name, email, mobile, by, codes, method = "Registered at the ride" }) {
  const name = R.clean(full_name), mail = R.normEmail(email), phone = R.normPhone(mobile);
  if (!codes.includes(company)) return { status: "error", message: "Choose the company." };
  if (name.length < 3) return { status: "error", message: "Enter their full name." };
  if (mail && !R.EMAIL_RE.test(mail)) return { status: "error", message: "That email doesn't look right." };
  let p = await findParticipant(c, company, { email: mail, name }), created = false;
  if (!p) { p = await createParticipant(c, { company, full_name: name, email: mail }, by, "Registered at the ride"); created = true; }
  else if (mail && !p.email) p = (await c.query("UPDATE corp_participants SET email = $2, updated_at = now() WHERE id = $1 RETURNING *", [p.id, mail])).rows[0];
  if (phone && phone !== p.mobile) p = (await c.query("UPDATE corp_participants SET mobile = $2 WHERE id = $1 RETURNING *", [p.id, phone])).rows[0];
  const r = await corpScan(c, { code: p.pid, session, by, codes, method });
  return { ...r, created, participant: p };
}

/** Period helpers shared by the dashboard and reports: ?period=month|quarter|year|ytd|custom&p=2026-10 */
function periodFromQuery(q, today = R.todayLocal()) {
  const type = ["month", "quarter", "year", "ytd", "all", "custom"].includes(q.period) ? q.period : "ytd";
  const thisM = today.slice(0, 7);
  if (type === "month") { const m = /^\d{4}-\d{2}$/.test(q.p || "") ? q.p : thisM; return { type, p: m, start: m + "-01", end: monthEnd(m), label: require("./views").monLabel(m, true) }; }
  if (type === "quarter") {
    const v = /^\d{4}-Q[1-4]$/.test(q.p || "") ? q.p : `${today.slice(0, 4)}-Q${Math.floor((+today.slice(5, 7) - 1) / 3) + 1}`;
    const y = v.slice(0, 4), n = +v.slice(-1), s = `${y}-${String(n * 3 - 2).padStart(2, "0")}`;
    return { type, p: v, start: s + "-01", end: monthEnd(addMonths(s, 2)), label: `Q${n} ${y}` };
  }
  if (type === "year") { const y = /^\d{4}$/.test(q.p || "") ? q.p : today.slice(0, 4); return { type, p: y, start: y + "-01-01", end: y + "-12-31", label: y }; }
  if (type === "all") return { type, p: "", start: "2024-01-01", end: today, label: "All time" };
  if (type === "custom") {
    const a = /^\d{4}-\d{2}-\d{2}$/.test(q.from || "") ? q.from : addDays(today, -89), b = /^\d{4}-\d{2}-\d{2}$/.test(q.to || "") ? q.to : today;
    const [s, e] = a <= b ? [a, b] : [b, a];
    const { fmtDate } = require("./views");
    return { type, p: "", from: s, to: e, start: s, end: e, label: `${fmtDate(s)} – ${fmtDate(e)}` };
  }
  return { type: "ytd", p: "", start: today.slice(0, 4) + "-01-01", end: today, label: `${today.slice(0, 4)} year to date` };
}

module.exports = {
  DEFAULT_COMPANIES, KINDS, RIDE, COMMUNITIES, ACTIVE_WINDOW, ACTIVE_MIN, token, nameKey, weekdayShort, isRideDay, pidQr, pidFromScan,
  seedCompanies, companies, companiesFor, corpScan, WEEKDAYS_LONG, WEEKS, occursOn, scheduleText, schedName, schedules, seedSchedules, occurrences, sessionValue, resolveSession, createParticipant, findParticipant, walkIn, seasons, currentSeason, enrol, seedSeasons, cqSig, cqPath, ensureSession, markAttendance, todaysSessions, sessionName, stats, periodFromQuery,
};
