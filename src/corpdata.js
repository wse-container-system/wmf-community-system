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
/** Sessions a person can check in to today: what is scheduled, or the weekly ride on a ride day. */
async function todaysSessions(c, co) {
  const today = R.todayLocal();
  const rows = (await c.query("SELECT * FROM corp_sessions WHERE company = $1 AND session_date = $2 AND status <> 'Cancelled' ORDER BY kind = $3 DESC, id", [co.code, today, RIDE])).rows;
  const hasRide = rows.some((s) => s.kind === RIDE);
  const cancelledRide = (await c.query("SELECT 1 FROM corp_sessions WHERE company = $1 AND session_date = $2 AND kind = $3 AND status = 'Cancelled'", [co.code, today, RIDE])).rows[0];
  if (!hasRide && !cancelledRide && isRideDay(co, today)) rows.unshift({ id: 0, company: co.code, session_date: today, kind: RIDE, title: "", status: "Scheduled", virtual: true });
  return rows;
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
      roster: allP.filter((p) => p.company === code && p.status === "Active").length, cancelled: S.filter((s) => s.company === code && s.status === "Cancelled").length,
      lastSession: (hs[hs.length - 1] || {}).d || null };
  });
  const top = [...perPerson.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, n]) => ({ ...P.get(id), inRange: n }));
  const needsAttendance = sessions.filter((s) => s.d <= asOf && (s.status === "Scheduled" || (s.status === "Held" && !s.named && s.headcount == null)));
  const lapsed = allP.filter((p) => p.status === "Active" && p.last && !activeAt(p, asOf) && p.last > addDays(asOf, -180)).sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  return {
    start, end, asOf, codes,
    k: { rideSessions: rides.length, events: events.length, cancelled: S.filter((s) => s.status === "Cancelled").length, attendance: sum(held), rideAttendance: sum(rides),
      eventAttendance: sum(events), avgPerRide: rides.length ? sum(rides) / rides.length : null, people: people.size, newJoiners, emirati, expat, unknownCommunity,
      active: active.length, roster: allP.filter((p) => p.status === "Active").length, repeat, repeatRate: people.size ? repeat / people.size : null,
      headcountOnly: held.filter((s) => !s.named).length },
    months, byKind: [...byKind.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value), byCompany,
    sessions: S, top, needsAttendance, lapsed, participants: P,
  };
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
  seedCompanies, companies, companiesFor, createParticipant, findParticipant, ensureSession, markAttendance, todaysSessions, sessionName, stats, periodFromQuery,
};
