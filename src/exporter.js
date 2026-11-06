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
  // ----- Corporate programme and department (added so one backup holds everything)
  const [co, cp, cs, ca, ds, dl, da, dh, sl] = (await Promise.all([
    pool.query("SELECT * FROM corp_companies ORDER BY sort_order, code"),
    pool.query("SELECT * FROM corp_participants ORDER BY company, pid"),
    pool.query("SELECT s.*, (SELECT count(*) FROM corp_attendance a WHERE a.session_id = s.id)::int AS named FROM corp_sessions s ORDER BY session_date, company, id"),
    pool.query(`SELECT a.*, p.pid, p.full_name, s.company, s.session_date, s.kind, s.title FROM corp_attendance a
      JOIN corp_participants p ON p.id = a.participant_id JOIN corp_sessions s ON s.id = a.session_id ORDER BY s.session_date, s.company, p.pid`),
    pool.query("SELECT * FROM dept_staff ORDER BY full_name"),
    pool.query("SELECT l.*, s.full_name FROM dept_leave l JOIN dept_staff s ON s.id = l.staff_id ORDER BY l.start_date"),
    pool.query("SELECT a.*, s.full_name FROM dept_attendance a JOIN dept_staff s ON s.id = a.staff_id ORDER BY a.work_date, s.full_name"),
    pool.query("SELECT * FROM dept_holidays ORDER BY holiday"),
    pool.query("SELECT * FROM scanner_links ORDER BY created_at"),
  ])).map((r) => r.rows);
  addTable(wb, "Corporate Companies", "CorpCompanies", [
    ["Code", (r) => r.code], ["Name", (r) => r.name], ["Ride Days", (r) => r.ride_days], ["Ride Time", (r) => r.ride_time], ["Location", (r) => r.location],
    ["Contact", (r) => r.contact], ["Attendance Method", (r) => r.checkin_mode], ["Work Email Ending", (r) => r.email_domain], ["Codes For", (r) => r.qr_access], ["Active", (r) => (r.active ? "Yes" : "No")],
  ], co);
  addTable(wb, "Corporate Participants", "CorpParticipants", [
    ["ID", (r) => r.pid], ["Company", (r) => r.company], ["Full Name", (r) => r.full_name], ["Work Email", (r) => r.email], ["Employee No", (r) => r.employee_no], ["Gender", (r) => r.gender],
    ["Community", (r) => r.community], ["Bike Size", (r) => r.bike_size], ["Status", (r) => r.status], ["Joined", (r) => toDate(r.joined), "day"], ["Source", (r) => r.source], ["Notes", (r) => r.notes],
  ], cp);
  addTable(wb, "Corporate Sessions", "CorpSessions", [
    ["Session No", (r) => r.id], ["Company", (r) => r.company], ["Date", (r) => toDate(r.session_date), "day"], ["Activity", (r) => r.kind], ["Title", (r) => r.title], ["Location", (r) => r.location],
    ["Status", (r) => r.status], ["Named Check-ins", (r) => r.named], ["Headcount", (r) => r.headcount], ["Emirati", (r) => r.headcount_emirati], ["Expat", (r) => r.headcount_expat], ["New", (r) => r.headcount_new], ["Remarks", (r) => r.remarks],
  ], cs);
  addTable(wb, "Corporate Attendance", "CorpAttendance", [
    ["Session No", (r) => r.session_id], ["Date", (r) => toDate(r.session_date), "day"], ["Company", (r) => r.company], ["Activity", (r) => r.kind], ["Title", (r) => r.title],
    ["ID", (r) => r.pid], ["Name", (r) => r.full_name], ["How", (r) => r.method], ["When", (r) => toDate(r.at), "date"], ["By", (r) => r.created_by],
  ], ca);
  addTable(wb, "Department Staff", "DeptStaff", [
    ["Name", (r) => r.full_name], ["Email", (r) => r.email], ["Employee No", (r) => r.employee_no], ["Job Title", (r) => r.job_title], ["Start Date", (r) => toDate(r.start_date), "day"],
    ["Leave Entitlement", (r) => Number(r.leave_entitlement)], ["Carried Over", (r) => Number(r.carry_over)], ["Active", (r) => (r.active ? "Yes" : "No")],
  ], ds);
  addTable(wb, "Department Leave", "DeptLeave", [
    ["Name", (r) => r.full_name], ["Type", (r) => r.leave_type], ["First Day", (r) => toDate(r.start_date), "day"], ["Last Day", (r) => toDate(r.end_date), "day"], ["Working Days", (r) => Number(r.days)],
    ["Status", (r) => r.status], ["Reason", (r) => r.reason], ["Requested By", (r) => r.requested_by], ["Decided By", (r) => r.decided_by], ["Decision Note", (r) => r.decision_note],
  ], dl);
  addTable(wb, "Department Attendance", "DeptAttendance", [
    ["Name", (r) => r.full_name], ["Date", (r) => toDate(r.work_date), "day"], ["Status", (r) => r.status], ["Check In", (r) => r.check_in], ["Check Out", (r) => r.check_out], ["Note", (r) => r.notes], ["Recorded By", (r) => r.updated_by],
  ], da);
  addTable(wb, "Public Holidays", "DeptHolidays", [["Date", (r) => toDate(r.holiday), "day"], ["Holiday", (r) => r.name]], dh);
  const [sv, sr, so, rn] = (await Promise.all([
    pool.query("SELECT * FROM surveys ORDER BY created_at"),
    pool.query("SELECT r.*, s.title FROM survey_responses r JOIN surveys s ON s.id = r.survey_id ORDER BY r.created_at"),
    pool.query("SELECT * FROM social_counts ORDER BY month, channel, city"),
    pool.query("SELECT * FROM report_notes ORDER BY period"),
  ])).map((r) => r.rows);
  addTable(wb, "Surveys", "WMFSurveys", [["Survey", (r) => r.title], ["Event", (r) => r.activity_id], ["Open", (r) => (r.open ? "Yes" : "No")], ["Created", (r) => r.created_at]], sv);
  addTable(wb, "Survey Responses", "WMFSurveyResponses", [["Survey", (r) => r.title], ["Rating (1-5)", (r) => r.rating], ["Join again", (r) => r.again], ["First WMF event", (r) => r.first_time],
    ["Enjoyed", (r) => r.liked], ["Could be better", (r) => r.improve], ["Name", (r) => r.name], ["When", (r) => r.created_at]], sr);
  addTable(wb, "Social Growth", "WMFSocialGrowth", [["Month", (r) => toDate(r.month), "day"], ["Channel", (r) => r.channel], ["City", (r) => r.city], ["Members", (r) => r.members]], so);
  const ss = (await pool.query("SELECT s.id, s.title, s.questions, a.answers, a.at FROM season_answers a JOIN season_surveys s ON s.id = a.survey_id ORDER BY s.id, a.at, a.id")).rows;
  const ssRows = [];
  for (const r of ss) for (const q of r.questions) { const v = r.answers[q.id]; if (v != null && v !== "") ssRows.push({ title: r.title, at: r.at, group: q.group, q: q.q, v: Array.isArray(v) ? v.join("; ") : v }); }
  addTable(wb, "Season Survey Answers", "WMFSeasonSurveyAnswers", [["Survey", (r) => r.title], ["When", (r) => r.at], ["Section", (r) => r.group], ["Question", (r) => r.q], ["Answer", (r) => String(r.v).slice(0, 32000)]], ssRows);
  const lr = (await pool.query("SELECT r.*, l.label, (SELECT count(*)::int FROM lead_photos p WHERE p.ride_id = r.id) AS photos FROM lead_rides r LEFT JOIN lead_links l ON l.id = r.link_id ORDER BY r.ride_date, r.id")).rows;
  addTable(wb, "Dubai Rides", "WMFLeadRides", [["Date", (r) => toDate(r.ride_date), "day"], ["City", (r) => r.city], ["Ride", (r) => r.ride_type], ["Special ride name", (r) => r.title],
    ["Participants", (r) => r.participants], ["Photos", (r) => r.photos], ["Sent by", (r) => r.label || r.entered_by]], lr);
  const mka = (await pool.query("SELECT m.*, a.title AS act FROM marketing_actions m LEFT JOIN activations a ON a.id = m.activation_id ORDER BY m.posted_on, m.id")).rows;
  addTable(wb, "Marketing Log", "WMFMarketingLog", [["Posted", (r) => toDate(r.posted_on), "day"], ["Event", (r) => r.act || r.activity_id || "General"], ["Channel", (r) => r.channel], ["Type", (r) => r.kind],
    ["What", (r) => r.title], ["Link", (r) => r.url], ["Reach", (r) => r.reach], ["Engagements", (r) => r.engagements], ["Clicks", (r) => r.clicks], ["Sign-ups", (r) => r.signups], ["Notes", (r) => r.notes]], mka);
  addTable(wb, "Report Notes", "WMFReportNotes", [["Period", (r) => r.period], ["Strategy", (r) => r.strategy], ["What's next", (r) => r.next_steps], ["Corporate note", (r) => r.corporate]], rn);
  // scanner links: names only, never the secret part of the address
  addTable(wb, "Scanner Links", "ScannerLinks", [["For", (r) => r.label], ["Programmes", (r) => r.scope], ["On", (r) => (r.active ? "Yes" : "No")], ["Check-ins", (r) => r.scans], ["Last Used (UTC)", (r) => r.last_used]], sl);
  addTable(wb, "Audit Log", "WMFAuditLog", [
    ["When (UTC)", (r) => r.at], ["Who", (r) => r.actor], ["Action", (r) => r.action], ["Entity", (r) => r.entity], ["Record", (r) => r.entity_id],
    ["Reason", (r) => r.reason], ["Before", (r) => (r.before ? JSON.stringify(r.before).slice(0, 32000) : null)], ["After", (r) => (r.after ? JSON.stringify(r.after).slice(0, 32000) : null)],
  ], au.rows);
  void g;
  return wb.xlsx.writeBuffer();
}

module.exports = { exportWorkbook };
