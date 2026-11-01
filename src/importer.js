"use strict";
/**
 * One-time import of WMF_Community_Master_System_Integrated.xlsx into the database.
 * Reads the named Excel tables; never changes the workbook. Member IDs and QR values are kept
 * exactly as they are, so the QR codes already sent to the community keep working.
 */
const ExcelJS = require("exceljs");
const { tx, audit } = require("./db");
const { clean, normEmail, weekdayOf } = require("./rules");

function cellValue(v) {
  if (v == null) return null;
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if ("result" in v) return cellValue(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join("");
    if ("text" in v) return cellValue(v.text);
    if (v.error) return null;
    return null;
  }
  return v;
}
const iso = (v) => {
  v = cellValue(v);
  if (v == null || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString().slice(0, 19); // Excel dates are local wall-clock times
  if (typeof v === "number") return new Date(Math.round((v - 25569) * 864e5)).toISOString().slice(0, 19);
  const s = clean(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 19);
};
const txt = (v) => { v = cellValue(v); if (v == null) return null; if (v instanceof Date) return v.toISOString().slice(0, 19); const s = clean(v); return s === "" ? null : s; };
const int = (v) => { v = cellValue(v); const n = Number(v); return Number.isFinite(n) ? Math.round(n) : 0; };

function readTable(wb, tableName) {
  for (const ws of wb.worksheets) {
    const t = ws.tables && ws.tables[tableName];
    if (!t) continue;
    const ref = t.table.tableRef || t.table.ref;
    const [a, b] = ref.split(":");
    const col = (s) => s.replace(/\d+/g, "").split("").reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
    const c1 = col(a), c2 = col(b), r1 = +a.replace(/\D+/g, ""), r2 = +b.replace(/\D+/g, "");
    const headers = [];
    for (let c = c1; c <= c2; c++) headers.push(clean(cellValue(ws.getRow(r1).getCell(c).value)));
    const rows = [];
    for (let r = r1 + 1; r <= r2; r++) {
      const row = ws.getRow(r), o = {};
      let any = false;
      headers.forEach((h, i) => { const v = row.getCell(c1 + i).value; o[h] = v; if (cellValue(v) != null && cellValue(v) !== "") any = true; });
      if (any) rows.push(o);
    }
    return { headers, rows };
  }
  return null;
}

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
function historySeries(initiative, date) {
  const n = clean(initiative).toLowerCase();
  const d = DAYS.find((w) => n.includes(w));
  return d ? d[0].toUpperCase() + d.slice(1) + " Ride" : weekdayOf(date) + " Ride";
}
function kindOf(name, type) {
  const n = clean(name).toLowerCase(), t = clean(type).toLowerCase();
  if (n === "workshop") return "event";
  if (t.includes("member") || t.includes("community registration")) return "registration";
  if (t.includes("event")) return "event";
  if (t.includes("ride")) return "ride";
  return "other";
}

/** Parse the workbook. Returns the rows to import plus a summary; writes nothing. */
async function parseWorkbook(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const need = ["WMFMemberMaster", "WMFActivityDatabase", "WMFActivitySetup", "WMFHistoricalRideSummary", "WMFHistoricalEventSummary"];
  const T = {};
  const missing = [];
  for (const n of need) { T[n] = readTable(wb, n); if (!T[n]) missing.push(n); }
  if (missing.includes("WMFMemberMaster") || missing.includes("WMFActivityDatabase")) {
    throw new Error("This file has no " + missing.join(" / ") + " table. Choose WMF_Community_Master_System_Integrated.xlsx.");
  }
  const warnings = missing.map((n) => `Table ${n} not found; it was skipped.`);

  const members = T.WMFMemberMaster.rows.map((r) => ({
    member_id: txt(r["Member ID"]), member_key: txt(r["Member Key"]), full_name: txt(r["Full Name"]) || "",
    primary_email: normEmail(txt(r["Primary Email"])) || null, alt_emails: txt(r["Alternative Emails"]), mobile: txt(r["Mobile Number"]),
    gender: txt(r["Gender / Demographic"]), community: txt(r["Community"]), first_seen: iso(r["First Seen Date"]),
    qr_issued: txt(r["QR Issued"]), qr_status: txt(r["QR Status"]), qr_value: txt(r["QR Value"]) || txt(r["Member ID"]), qr_created: iso(r["QR Created Date"]),
    data_note: txt(r["Data Quality Note"]), sources: txt(r["Sources"]), emergency_name: txt(r["Emergency Contact Name"]),
    emergency_number: txt(r["Emergency Contact Number"]), updates_consent: txt(r["Updates Consent"]), waiver_consent: txt(r["Waiver Consent"]),
    media_consent: txt(r["Media Consent"]),
  }));
  const noId = members.filter((m) => !m.member_id);
  if (noId.length) warnings.push(`${noId.length} member rows have no Member ID and were skipped.`);
  const seenIds = new Set(), dupIds = [];
  const keptMembers = [];
  for (const m of members) {
    if (!m.member_id) continue;
    if (seenIds.has(m.member_id.toUpperCase())) { dupIds.push(m.member_id); continue; }
    seenIds.add(m.member_id.toUpperCase()); keptMembers.push(m);
  }
  if (dupIds.length) warnings.push(`Duplicate Member IDs skipped (first copy kept): ${dupIds.join(", ")}.`);

  // link each activity row to a member (email, alternative email, member key, or the QR scanner's Member ID)
  const byEmail = new Map(), byKey = new Map(), byId = new Map();
  for (const m of keptMembers) {
    byId.set(m.member_id.toUpperCase(), m.member_id);
    if (m.member_key) byKey.set(m.member_key.toLowerCase(), m.member_id);
    if (m.primary_email) byEmail.set(m.primary_email, m.member_id);
  }
  for (const m of keptMembers) for (const a of String(m.alt_emails || "").split(/[;,\s]+/)) { const e = normEmail(a); if (e.includes("@") && !byEmail.has(e)) byEmail.set(e, m.member_id); }

  const activity = T.WMFActivityDatabase.rows.map((r) => {
    const email = normEmail(txt(r["Member Email"]));
    const key = txt(r["Member Key"]);
    const resp = txt(r["Form Response ID"]);
    const source = txt(r["Source"]);
    let memberId = null;
    if (source === "WMF QR Attendance Scanner" && resp && byId.has(resp.toUpperCase())) memberId = byId.get(resp.toUpperCase());
    if (!memberId && email) memberId = byEmail.get(email) || null;
    if (!memberId && key) memberId = byKey.get(key.toLowerCase()) || byKey.get("e|" + key.toLowerCase()) || null;
    return {
      record_id: txt(r["Record ID"]), record_date: iso(r["Record Date"]), record_type: txt(r["Record Type"]), activity_id: txt(r["Activity ID"]),
      activity_name: txt(r["Activity Name"]), activity_type: txt(r["Activity Type"]), status: txt(r["Participation Status"]),
      counts_as_visit: txt(r["Counts as Visit"]), member_name: txt(r["Member Name"]), member_email: email || null, phone: txt(r["Phone"]),
      gender: txt(r["Gender"]), community: txt(r["Community"]), member_key: key, source, form_response_id: resp, notes: txt(r["Notes"]), member_id: memberId,
    };
  });
  const noDate = activity.filter((a) => !a.record_date);
  if (noDate.length) warnings.push(`${noDate.length} activity rows have no Record Date and were skipped.`);
  const keptActivity = activity.filter((a) => a.record_date && a.record_type);

  const setup = T.WMFActivitySetup ? T.WMFActivitySetup.rows.map((r) => {
    const name = txt(r["Activity Name"]) || txt(r["Activity ID"]);
    const loc = txt(r["Location"]);
    const t = `${name} ${txt(r["Activity ID"])}`.toLowerCase();
    return {
      activity_id: txt(r["Activity ID"]), name, activity_type: txt(r["Activity Type"]), category: txt(r["Activity Category"]),
      kind: kindOf(name, txt(r["Activity Type"])), location: loc || (/\bdubai\b|\bdxb\b/.test(t) ? "Dubai" : "Abu Dhabi"),
      status: txt(r["Status"]) || "Active", notes: txt(r["Reporting Notes"]),
    };
  }).filter((a) => a.activity_id) : [];

  const historyRides = T.WMFHistoricalRideSummary ? T.WMFHistoricalRideSummary.rows.map((r) => ({
    session_key: txt(r["Session Key"]), ride_date: (iso(r["Ride Date"]) || "").slice(0, 10), initiative: txt(r["Initiative"]), state: txt(r["State"]),
    expat: int(r["Expat Riders"]), arab: int(r["Arab Riders"]), new_riders: int(r["New Riders"]), attendees: int(r["Total Attendees"]), remarks: txt(r["Remarks"]),
  })).filter((h) => h.ride_date) : [];
  const historyEvents = T.WMFHistoricalEventSummary ? T.WMFHistoricalEventSummary.rows.map((r) => ({
    event_key: txt(r["Event Key"]), report_month: (iso(r["Report Month"]) || "").slice(0, 10), name: txt(r["Event Name"]), category: txt(r["Category"]),
    collaborator: txt(r["Collaborated Entity"]), frequency: txt(r["Frequency"]), attendance: int(r["Attendance"]), comments: txt(r["Comments"]),
  })).filter((h) => h.report_month && h.name) : [];

  const linked = keptActivity.filter((a) => a.member_id).length;
  return {
    members: keptMembers, activity: keptActivity, setup, historyRides, historyEvents, warnings,
    summary: {
      members: keptMembers.length, activity: keptActivity.length, activityLinked: linked, activities: setup.length,
      historyRides: historyRides.length, historyEvents: historyEvents.length,
      qrValuesMatchIds: keptMembers.filter((m) => (m.qr_value || "").toUpperCase() === m.member_id.toUpperCase()).length,
      highestMemberId: keptMembers.map((m) => m.member_id).sort().pop() || null,
    },
  };
}

async function insertMany(c, table, rows) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500), vals = [];
    const ph = chunk.map((r, j) => "(" + cols.map((k, n) => { vals.push(r[k]); return "$" + (j * cols.length + n + 1); }).join(",") + ")");
    await c.query(`INSERT INTO ${table} (${cols.join(",")}) VALUES ${ph.join(",")}`, vals);
  }
}

/** Write the parsed workbook into the database. Refuses to run over existing data unless replace is set. */
async function commitImport(parsed, actor, { replace = false, fileName = "" } = {}) {
  return tx(async (c) => {
    const have = Number((await c.query("SELECT (SELECT count(*) FROM members) + (SELECT count(*) FROM participation) AS n")).rows[0].n);
    if (have && !replace) throw new Error("The database already holds data. Tick 'Replace everything' to import again.");
    if (replace) {
      await c.query("TRUNCATE members, participation, activities, history_rides, history_events, counters, scan_log");
    }
    await insertMany(c, "members", parsed.members);
    await insertMany(c, "participation", parsed.activity.map((a) => ({ ...a, imported: true, created_by: "import" })));
    await insertMany(c, "activities", parsed.setup);
    await insertMany(c, "history_rides", parsed.historyRides);
    await insertMany(c, "history_events", parsed.historyEvents);
    // carry on numbering from the highest Member ID and Record IDs in the workbook
    const maxNum = (arr, re) => arr.reduce((mx, s) => { const m = re.exec(s || ""); return m ? Math.max(mx, +m[1]) : mx; }, 0);
    const counters = {
      MEMBER: maxNum(parsed.members.map((m) => m.member_id), /^WMF-(\d+)$/i),
      ATT: maxNum(parsed.activity.map((a) => a.record_id), /^ATT-(\d+)$/i),
      EVT: maxNum(parsed.activity.map((a) => a.record_id), /^EVT-(\d+)$/i),
      REG: maxNum(parsed.activity.map((a) => a.record_id), /^REG-(\d+)$/i),
    };
    for (const [k, v] of Object.entries(counters)) await c.query("INSERT INTO counters (name, value) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET value = GREATEST(counters.value, $2)", [k, v]);
    await require("./rules").ensureCoreRides(c); // the six scanner rides survive a re-import
    await audit(c, actor, replace ? "import.replace" : "import", "workbook", fileName || null, null, { ...parsed.summary, counters, warnings: parsed.warnings });
    return { ...parsed.summary, counters };
  });
}

module.exports = { parseWorkbook, commitImport };
