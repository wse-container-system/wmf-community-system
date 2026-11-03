"use strict";
/** Full backup as an Excel workbook, laid out like the original tables so it can be re-imported. */
const ExcelJS = require("exceljs");
const { pool } = require("./db");

const toDate = (s) => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?/.exec(String(s));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0))) : null; // exceljs writes UTC parts = wall-clock
};

function addTable(wb, sheet, tableName, columns, rows) {
  const ws = wb.addWorksheet(sheet);
  ws.addTable({
    name: tableName, ref: "A1", headerRow: true, style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: columns.map(([name]) => ({ name, filterButton: true })),
    rows: rows.length ? rows.map((r) => columns.map(([, f]) => { const v = f(r); return v === undefined ? null : v; })) : [columns.map(() => null)],
  });
  columns.forEach(([name, , kind], i) => {
    const col = ws.getColumn(i + 1);
    col.width = Math.min(40, Math.max(12, name.length + 2));
    if (kind === "date") col.numFmt = "yyyy-mm-dd hh:mm";
    if (kind === "day") col.numFmt = "yyyy-mm-dd";
  });
  ws.views = [{ state: "frozen", ySplit: 1 }];
  ws.eachRow((row) => { row.font = { name: "Arial", size: 10 }; });
  ws.getRow(1).font = { name: "Arial", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
}

async function exportWorkbook() {
  const [m, p, a, hr, he, au] = await Promise.all([
    pool.query("SELECT * FROM members ORDER BY member_id"),
    pool.query("SELECT * FROM participation ORDER BY record_date, id"),
    pool.query("SELECT * FROM activities ORDER BY activity_id"),
    pool.query("SELECT * FROM history_rides ORDER BY ride_date, id"),
    pool.query("SELECT * FROM history_events ORDER BY report_month, id"),
    pool.query("SELECT * FROM audit_log ORDER BY at, id"),
  ]);
  const acts = await require("./activations").loadActivations();
  const partners = (await pool.query("SELECT * FROM partners ORDER BY name")).rows;
  const cal = (await pool.query("SELECT * FROM calendar_items ORDER BY start_date, id")).rows;
  const wb = new ExcelJS.Workbook();
  wb.creator = "WMF Community System";
  wb.created = new Date();
  const g = (k, kind) => [k, kind];
  addTable(wb, "Unique Member Database", "WMFMemberMaster", [
    ["Member ID", (r) => r.member_id], ["Member Key", (r) => r.member_key], ["Full Name", (r) => r.full_name], ["Primary Email", (r) => r.primary_email],
    ["Alternative Emails", (r) => r.alt_emails], ["Mobile Number", (r) => r.mobile], ["Gender / Demographic", (r) => r.gender], ["Community", (r) => r.community],
    ["First Seen Date", (r) => toDate(r.first_seen), "date"], ["QR Issued", (r) => r.qr_issued], ["QR Status", (r) => r.qr_status], ["QR Value", (r) => r.qr_value],
    ["QR Created Date", (r) => toDate(r.qr_created), "date"], ["Data Quality Note", (r) => r.data_note], ["Sources", (r) => r.sources],
    ["Emergency Contact Name", (r) => r.emergency_name], ["Emergency Contact Number", (r) => r.emergency_number], ["Updates Consent", (r) => r.updates_consent],
    ["Waiver Consent", (r) => r.waiver_consent], ["Media Consent", (r) => r.media_consent], ["Merged Into", (r) => r.merged_into],
  ], m.rows);
  addTable(wb, "Master Activity Database", "WMFActivityDatabase", [
    ["Record ID", (r) => r.record_id], ["Record Date", (r) => toDate(r.record_date), "date"], ["Record Type", (r) => r.record_type], ["Activity ID", (r) => r.activity_id],
    ["Activity Name", (r) => r.activity_name], ["Activity Type", (r) => r.activity_type], ["Participation Status", (r) => r.status], ["Counts as Visit", (r) => r.counts_as_visit],
    ["Member Name", (r) => r.member_name], ["Member Email", (r) => r.member_email], ["Phone", (r) => r.phone], ["Gender", (r) => r.gender], ["Community", (r) => r.community],
    ["Member Key", (r) => r.member_key], ["Source", (r) => r.source], ["Form Response ID", (r) => r.form_response_id], ["Notes", (r) => r.notes],
    ["Member ID", (r) => r.member_id], ["Payment Status", (r) => r.payment_status], ["Paid At", (r) => (r.paid_at ? new Date(r.paid_at) : null)], ["Payment Note", (r) => r.payment_note],
    ["Voided", (r) => (r.voided_at ? "Yes" : "")], ["Void Reason", (r) => r.void_reason], ["Entered By", (r) => r.created_by],
  ], p.rows);
  addTable(wb, "Activity Setup", "WMFActivitySetup", [
    ["Activity ID", (r) => r.activity_id], ["Activity Name", (r) => r.name], ["Activity Type", (r) => r.activity_type], ["Activity Category", (r) => r.category],
    ["Kind", (r) => r.kind], ["Location", (r) => r.location], ["Event Date", (r) => toDate(r.event_date), "day"], ["Capacity", (r) => r.capacity],
    ["Sign-up Open", (r) => (r.registration_open ? "Yes" : "No")], ["Price (AED)", (r) => (r.price_aed == null ? null : Number(r.price_aed))], ["Payment Link", (r) => r.payment_url], ["Status", (r) => r.status], ["Reporting Notes", (r) => r.notes],
  ], a.rows);
  addTable(wb, "Historical Ride Summary", "WMFHistoricalRideSummary", [
    ["Session Key", (r) => r.session_key], ["Ride Date", (r) => toDate(r.ride_date), "day"], ["Initiative", (r) => r.initiative], ["State", (r) => r.state],
    ["Expat Riders", (r) => r.expat], ["Arab Riders", (r) => r.arab], ["New Riders", (r) => r.new_riders], ["Total Attendees", (r) => r.attendees], ["Remarks", (r) => r.remarks],
  ], hr.rows);
  addTable(wb, "Historical Event Summary", "WMFHistoricalEventSummary", [
    ["Event Key", (r) => r.event_key], ["Report Month", (r) => toDate(r.report_month), "day"], ["Event Name", (r) => r.name], ["Category", (r) => r.category],
    ["Collaborated Entity", (r) => r.collaborator], ["Frequency", (r) => r.frequency], ["Attendance", (r) => r.attendance], ["Comments", (r) => r.comments],
  ], he.rows);
  addTable(wb, "Activations", "WMFActivations", [
    ["Month", (r) => toDate(r.month), "day"], ["Date", (r) => toDate(r.event_date), "day"], ["Date Note", (r) => r.date_note], ["Activation", (r) => r.title], ["Category", (r) => r.category],
    ["Original Category", (r) => r.category_raw], ["Partners", (r) => r.partners.join(", ")], ["Lead", (r) => r.lead_owner], ["Frequency", (r) => r.frequency], ["Location", (r) => r.location],
    ["Participants", (r) => r.participants], ["Registrations", (r) => r.registrants], ["Status", (r) => r.status], ["Impact", (r) => r.impact], ["Link", (r) => r.link], ["Linked Event", (r) => r.activity_id],
  ], acts);
  addTable(wb, "Partners", "WMFPartners", [["Partner", (r) => r.name], ["Other names", (r) => (r.aliases || []).join(", ")], ["Notes", (r) => r.notes]], partners);
  addTable(wb, "Calendar", "WMFCalendar", [
    ["Title", (r) => r.title], ["Type", (r) => r.category], ["Start", (r) => toDate(r.start_date), "day"], ["End", (r) => toDate(r.end_date), "day"], ["Start Time", (r) => r.start_time],
    ["End Time", (r) => r.end_time], ["Location", (r) => r.location], ["Status", (r) => r.status], ["Repeats", (r) => (r.recur ? JSON.stringify(r.recur) : null)],
    ["Cancelled Dates", (r) => (r.exceptions ? Object.keys(r.exceptions).join(", ") : null)], ["Link", (r) => r.url], ["Scanner Ride", (r) => r.ride_slot], ["Linked Event", (r) => r.activity_id],
  ], cal);
  addTable(wb, "Audit Log", "WMFAuditLog", [
    ["When (UTC)", (r) => r.at], ["Who", (r) => r.actor], ["Action", (r) => r.action], ["Entity", (r) => r.entity], ["Record", (r) => r.entity_id],
    ["Reason", (r) => r.reason], ["Before", (r) => (r.before ? JSON.stringify(r.before).slice(0, 32000) : null)], ["After", (r) => (r.after ? JSON.stringify(r.after).slice(0, 32000) : null)],
  ], au.rows);
  void g;
  return wb.xlsx.writeBuffer();
}

module.exports = { exportWorkbook };
