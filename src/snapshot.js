"use strict";
/** Builds the dashboard's data from the database, in the shape the calculation engine expects. */
const crypto = require("crypto");
const { pool, getSettings } = require("./db");
const { nowLocal, todayLocal, TZ } = require("./rules");

const isoOut = (d) => (d == null ? null : d instanceof Date ? localIso(d) : String(d));
// node-postgres returns TIMESTAMP (no zone) as a local Date of the server; rebuild the wall-clock text
function localIso(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function buildData() {
  const [settings, mem, act, setup, hr, he] = await Promise.all([
    getSettings(),
    pool.query("SELECT * FROM members WHERE merged_into IS NULL ORDER BY member_id"),
    pool.query("SELECT * FROM participation WHERE voided_at IS NULL ORDER BY record_date, id"),
    pool.query("SELECT activity_id, location FROM activities"),
    pool.query("SELECT * FROM history_rides ORDER BY ride_date, id"),
    pool.query("SELECT * FROM history_events ORDER BY report_month, id"),
  ]);
  const lead = (await pool.query("SELECT id, ride_date, ride_type, title, city, participants FROM lead_rides ORDER BY ride_date, id")).rows;
  // merged members: their rows count for the surviving member
  const merged = new Map((await pool.query("SELECT member_id, merged_into FROM members WHERE merged_into IS NOT NULL")).rows.map((r) => [r.member_id, r.merged_into]));
  const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const weekday = (iso) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][new Date(iso + "T12:00:00Z").getUTCDay()];
  const dayOnly = (d) => (d instanceof Date ? localIso(d).slice(0, 10) : String(d).slice(0, 10));
  const setupLocations = {};
  for (const s of setup.rows) if (s.location) setupLocations[s.activity_id] = s.location;

  const memberById = new Map(mem.rows.map((m) => [m.member_id, m]));
  return {
    config: { excludeEmails: settings.excludeEmails || [], separateEvents: settings.separateEvents || [] },
    meta: { mode: "live", asOf: todayLocal(), refreshed: nowLocal() + "+04:00", timezone: TZ },
    setupLocations,
    members: mem.rows.map((m) => ({
      memberId: m.member_id, memberKey: m.member_key || "", label: m.full_name || m.member_id, email: m.primary_email || "",
      altEmails: m.alt_emails || "", firstSeen: isoOut(m.first_seen), community: m.community || "", qrStatus: m.qr_status || "",
      qrIssued: m.qr_issued || "", qrCreated: isoOut(m.qr_created),
    })),
    activity: act.rows.map((r) => {
      // rows linked to a member who was merged: point them at the surviving record
      let mid = r.member_id;
      for (let i = 0; mid && merged.has(mid) && i < 5; i++) mid = merged.get(mid);
      const m = mid && mid !== r.member_id ? memberById.get(mid) : null;
      const appRow = !r.imported && r.member_id;
      const target = m || (appRow ? memberById.get(r.member_id) : null);
      return {
        recordId: r.record_id || "", date: isoOut(r.record_date), recordType: r.record_type, activityId: r.activity_id || "",
        activityName: r.activity_name || "", activityType: r.activity_type || "", status: r.status || "", source: r.source || "",
        memberKey: target ? target.member_key || "" : r.member_key || "", email: target ? target.primary_email || "" : r.member_email || "",
        formResponseId: r.source === "WMF QR Attendance Scanner" && mid ? mid : r.form_response_id || "", countsAsVisit: r.counts_as_visit || "",
      };
    }),
    historyRides: hr.rows.map((h) => {
      const d = dayOnly(h.ride_date), n = String(h.initiative || "").toLowerCase();
      const w = DAYS.find((x) => n.includes(x));
      return { date: d, initiative: h.initiative, series: w ? w[0].toUpperCase() + w.slice(1) + " Ride" : weekday(d) + " Ride",
        location: /dxb|dubai/i.test(h.state || "") ? "Dubai" : "Abu Dhabi", attendees: h.attendees, hid: h.id };
    }).concat(lead.map((l) => ({ date: dayOnly(l.ride_date), initiative: l.title || l.ride_type, lead: true, location: l.city,
      series: l.ride_type === "Manual" ? l.title || "Ride" : l.ride_type === "Special ride" ? (l.title ? "Special: " + l.title : "Special ride") : l.ride_type + " Ride",
      manual: l.ride_type === "Manual", attendees: l.participants, lid: l.id }))),
    historyEvents: he.rows.map((h) => ({ month: dayOnly(h.report_month), name: h.name, attendance: h.attendance })),
  };
}

/**
 * Viewers and sponsors get the same figures without anyone's identity: names become "Member 0001",
 * email local parts and keys are replaced by stable codes (the domain is kept so the email checks still count).
 */
function anonymise(data, secret, { keepNames = false } = {}) {
  const code = (s) => crypto.createHmac("sha256", secret).update(String(s).toLowerCase()).digest("hex").slice(0, 12);
  // valid emails: replace the part before @; anything malformed keeps its shape (so the data-quality counts match) with every word coded
  const mail = (e) => !e ? e : /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(String(e).trim().toLowerCase())
    ? String(e).replace(/^[^@]*/, () => "m" + code(e)) : String(e).replace(/[A-Za-z0-9]+/g, (w) => "x" + code(e + "|" + w).slice(0, 6));
  const keyOut = (k) => { if (!k) return k; const m = /^([epn])\|/i.exec(k); return m ? m[1].toUpperCase() + "|" + code(k) : code(k); };
  const ids = new Map(data.members.map((m, i) => [m.memberId, "Member " + String(i + 1).padStart(4, "0")]));
  const testEmails = new Set((data.config.excludeEmails || []).map((e) => e.toLowerCase()));
  return {
    ...data,
    config: { ...data.config, excludeEmails: [...testEmails].map(mail) },
    members: data.members.map((m) => ({ ...m, label: keepNames ? m.label : ids.get(m.memberId), email: mail(m.email), altEmails: String(m.altEmails || "").split(/[;,\s]+/).filter(Boolean).map(mail).join(";"), memberKey: keyOut(m.memberKey) })),
    activity: data.activity.map((r) => ({ ...r, email: mail(r.email), memberKey: keyOut(r.memberKey) })),
  };
}

module.exports = { buildData, anonymise, localIso };
