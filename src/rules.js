"use strict";
/** Business rules shared by the importer, the scanner and the registration forms. */
const E = require("./engine");
const { nextNumber, audit } = require("./db");

const TZ = process.env.APP_TIMEZONE || "Asia/Dubai";
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/;

const clean = (s) => (s == null ? "" : String(s).replace(/ /g, " ").replace(/\s+/g, " ").trim());
const normEmail = (s) => clean(s).toLowerCase();
const normPhone = (s) => {
  let d = clean(s).replace(/[^\d+]/g, "").replace(/^\+/, "").replace(/^00/, "");
  if (/^0?5\d{8}$/.test(d)) d = "971" + d.replace(/^0/, ""); // UAE mobile written locally
  return d;
};
/** Local wall-clock time in Dubai as "YYYY-MM-DDTHH:MM:SS" (stored without a zone, like the workbook). */
function nowLocal() {
  return new Date().toLocaleString("sv-SE", { timeZone: TZ, hour12: false }).replace(" ", "T").slice(0, 19);
}
const todayLocal = () => nowLocal().slice(0, 10);
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const weekdayOf = (iso) => WEEKDAYS[new Date(iso.slice(0, 10) + "T12:00:00Z").getUTCDay()];

/** A Member ID found in scanned text: the QR codes we sent hold "WMF-000123". */
function memberIdFromScan(text) {
  const m = clean(text).toUpperCase().match(/WMF-(\d{1,6})\b/);
  return m ? "WMF-" + m[1].padStart(6, "0") : null;
}
const formatMemberId = (n) => "WMF-" + String(n).padStart(6, "0");

/** Ride series for an activity, using the same classification as the dashboard. */
function seriesFor(activity, isoDate) {
  const c = E.classify({ recordType: "Attendance", activityName: activity.name, activityId: activity.activity_id, activityType: activity.activity_type || "Community Ride" });
  if (c.series && c.series !== "Other ride") return c.series;
  return weekdayOf(isoDate) + " Ride"; // no weekday in the name: use the day of the session
}

/** The rides offered on the scanner. Fixed list; the calendar says which of them run on a given day. */
const CORE_RIDES = [
  { activity_id: "RIDE-MONDAY-MADNESS", name: "Monday Madness" },
  { activity_id: "RIDE-MONDAY-MAINTENANCE", name: "Monday Maintenance" },
  { activity_id: "RIDE-WEDNESDAY-SOCIAL", name: "Wednesday Social" },
  { activity_id: "RIDE-MORNING", name: "Morning Ride" },
  { activity_id: "RIDE-WEEKEND-LONG", name: "Weekend Long Ride" },
  { activity_id: "RIDE-MOUNTAIN", name: "Mountain Ride" },
];
async function ensureCoreRides(c) {
  for (const [i, r] of CORE_RIDES.entries()) {
    await c.query(`INSERT INTO activities (activity_id, name, activity_type, category, kind, location, status, core, sort_order)
      VALUES ($1, $2, 'Community Ride', 'Ride Initiative', 'ride', 'Abu Dhabi', 'Active', TRUE, $3)
      ON CONFLICT (activity_id) DO UPDATE SET core = TRUE, sort_order = $3, kind = 'ride'`, [r.activity_id, r.name, i + 1]);
  }
}
/** Which scanner ride a calendar entry belongs to, guessed from its title. */
function slotForTitle(title) {
  const t = clean(title).toLowerCase();
  if (/madness/.test(t)) return "RIDE-MONDAY-MADNESS";
  if (/maintenance/.test(t)) return "RIDE-MONDAY-MAINTENANCE";
  if (/social/.test(t)) return "RIDE-WEDNESDAY-SOCIAL";
  if (/mountain|jebel|hafeet/.test(t)) return "RIDE-MOUNTAIN";
  if (/long ride/.test(t)) return "RIDE-WEEKEND-LONG";
  if (/open ride|morning/.test(t)) return "RIDE-MORNING";
  return null;
}

/** Contact details are shown in full to administrators only; everyone else sees a masked version. */
const CONTACT_FIELDS = ["primary_email", "alt_emails", "mobile", "emergency_name", "emergency_number", "email", "member_email", "phone"];
const maskEmail = (e) => { e = clean(e); if (!e) return ""; const at = e.indexOf("@"); return at > 0 ? e.slice(0, Math.min(2, at)) + "•••" + e.slice(at) : "•••"; };
const maskPhone = (p) => { const d = clean(p).replace(/\D/g, ""); return d ? "•••• " + d.slice(-3) : ""; };
const maskName = (n) => clean(n) ? clean(n).split(" ").map((w) => w[0] + "•••").join(" ") : "";
function maskContact(k, v) {
  if (v == null || v === "") return v;
  if (k === "mobile" || k === "phone" || k === "emergency_number") return maskPhone(v);
  if (k === "emergency_name") return maskName(v);
  if (k === "alt_emails") return String(v).split(/[;,\s]+/).filter(Boolean).map(maskEmail).join("; ");
  return maskEmail(v);
}
/** Mask contact fields anywhere inside an audit before/after record. */
function maskDeep(o) {
  if (!o || typeof o !== "object") return o;
  if (Array.isArray(o)) return o.map(maskDeep);
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = CONTACT_FIELDS.includes(k) && typeof v === "string" ? maskContact(k, v) : maskDeep(v);
  return out;
}

const memberKeyFor = (email, phone, name) => (email ? "E|" + email : phone ? "P|" + phone : "N|" + clean(name).toLowerCase());

/** Find one live member by Member ID, email (primary or alternative) or phone. */
async function findMember(c, { memberId, email, phone }) {
  if (memberId) {
    const r = await c.query("SELECT * FROM members WHERE upper(member_id) = upper($1) OR upper(qr_value) = upper($1) ORDER BY member_id LIMIT 1", [memberId]);
    if (r.rows[0]) return follow(c, r.rows[0]);
  }
  const em = normEmail(email);
  if (em) {
    const r = await c.query(
      `SELECT * FROM members WHERE lower(primary_email) = $1
         OR $1 = ANY (string_to_array(regexp_replace(lower(coalesce(alt_emails,'')), '[;,\\s]+', ',', 'g'), ','))
       ORDER BY merged_into NULLS FIRST, member_id LIMIT 1`, [em]);
    if (r.rows[0]) return follow(c, r.rows[0]);
  }
  const ph = normPhone(phone);
  if (ph && ph.length >= 9) {
    const r = await c.query("SELECT * FROM members WHERE regexp_replace(coalesce(mobile,''), '\\D', '', 'g') IN ($1, $2) ORDER BY merged_into NULLS FIRST, member_id LIMIT 1",
      [ph, ph.replace(/^971/, "0")]);
    if (r.rows[0]) return follow(c, r.rows[0]);
  }
  return null;
}
async function follow(c, m) {
  for (let i = 0; m && m.merged_into && i < 5; i++) {
    const r = await c.query("SELECT * FROM members WHERE member_id = $1", [m.merged_into]);
    m = r.rows[0] || m;
    if (!r.rows[0]) break;
  }
  return m;
}

/** Create a member with the next Member ID. The QR value is the Member ID, as in the codes already sent. */
async function createMember(c, f, actor, source) {
  const email = normEmail(f.email) || null;
  const phone = clean(f.mobile) || null;
  const n = await nextNumber(c, "MEMBER");
  const id = formatMemberId(n);
  const row = {
    member_id: id, member_key: memberKeyFor(email, normPhone(phone), f.full_name), full_name: clean(f.full_name), primary_email: email,
    mobile: phone, gender: clean(f.gender) || null, community: clean(f.community) || null, first_seen: f.first_seen || nowLocal(),
    qr_issued: "Yes", qr_status: "Issued in App", qr_value: id, qr_created: nowLocal(), sources: source,
    emergency_name: clean(f.emergency_name) || null, emergency_number: clean(f.emergency_number) || null,
    updates_consent: f.updates_consent ? "Yes" : "No", waiver_consent: f.waiver_consent ? "Yes" : "No", media_consent: f.media_consent ? "Yes" : "No",
  };
  const cols = Object.keys(row);
  await c.query(`INSERT INTO members (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, cols.map((k) => row[k]));
  await audit(c, actor, "member.create", "member", id, null, row, source);
  return row;
}

/** Append one participation row. dedupeKey makes repeats a no-op. Returns {row, duplicate}. */
async function addParticipation(c, p, actor) {
  if (p.dedupeKey) {
    const ex = await c.query("SELECT * FROM participation WHERE dedupe_key = $1 AND voided_at IS NULL", [p.dedupeKey]);
    if (ex.rows[0]) return { row: ex.rows[0], duplicate: true };
    // a voided row may hold the key: free it so the member can be checked in again
    await c.query("UPDATE participation SET dedupe_key = NULL WHERE dedupe_key = $1 AND voided_at IS NOT NULL", [p.dedupeKey]);
  }
  const prefix = { "Attendance": "ATT", "Event Registration": "EVT", "Member Registration": "REG" }[p.recordType] || "REC";
  const recordId = `${prefix}-${await nextNumber(c, prefix)}`;
  const m = p.member || {};
  const r = await c.query(
    `INSERT INTO participation (record_id, record_date, record_type, activity_id, activity_name, activity_type, status, counts_as_visit,
       member_name, member_email, phone, gender, community, member_key, source, form_response_id, notes, member_id, dedupe_key, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
    [recordId, p.date, p.recordType, p.activityId, p.activityName, p.activityType, p.status, "Yes",
      m.full_name || null, m.primary_email || null, m.mobile || null, m.gender || null, m.community || null, m.member_key || null,
      p.source, p.formResponseId || null, p.notes || null, m.member_id || null, p.dedupeKey || null, actor || null]);
  await audit(c, actor, "participation.create", "participation", recordId, null, { member: m.member_id, activity: p.activityId, date: p.date, source: p.source });
  return { row: r.rows[0], duplicate: false };
}

/**
 * Has this member already attended this ride series on this day, from any source (imported form rows included)?
 * Mirrors the dashboard rule: one ride per person per day per series.
 */
async function alreadyRode(c, member, isoDate, series) {
  const emails = [member.primary_email, ...String(member.alt_emails || "").split(/[;,\s]+/)].map(normEmail).filter(Boolean);
  const r = await c.query(
    `SELECT record_id, activity_id, activity_name, activity_type, record_type FROM participation
      WHERE voided_at IS NULL AND record_type = 'Attendance' AND status = 'Attended' AND record_date::date = $1::date
        AND (member_id = $2 OR lower(member_email) = ANY($3) OR form_response_id = $2)`, [isoDate, member.member_id, emails]);
  return r.rows.find((x) => {
    const c2 = E.classify({ recordType: x.record_type, activityName: x.activity_name, activityId: x.activity_id, activityType: x.activity_type });
    const s = c2.series && c2.series !== "Other ride" ? c2.series : weekdayOf(isoDate) + " Ride";
    return c2.kind === "ride" && s === series;
  }) || null;
}

module.exports = { CONTACT_FIELDS, maskEmail, maskPhone, maskContact, maskDeep, CORE_RIDES, ensureCoreRides, slotForTitle, TZ, EMAIL_RE, clean, normEmail, normPhone, nowLocal, todayLocal, weekdayOf, memberIdFromScan, formatMemberId,
  seriesFor, memberKeyFor, findMember, createMember, addParticipation, alreadyRode };
