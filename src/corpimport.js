"use strict";
/**
 * Reads CORPORATE_TRACKER_UNIFIED.xlsx into the corporate tables.
 *  - "Limad" and "NMDC": one row per person, one column per session date (1 = attended, text = remark such as a cancellation).
 *  - "AURORA": one row per activity with a headcount.
 *  - "Master Data": weekly headcounts per company; used for dates the per-person sheets don't cover, and for cancellations.
 * Per-person sheets win where both exist; differences are listed in the preview.
 */
const ExcelJS = require("exceljs");
const { tx, audit } = require("./db");
const R = require("./rules");
const C = require("./corpdata");

const CANCEL_RE = /cancel|holiday|eid|weather|crisis|ramadan|no ride/i;
const iso = (v) => {
  if (v instanceof Date && !Number.isNaN(+v)) return v.toISOString().slice(0, 10);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  return null;
};
const val = (cell) => { let v = cell && cell.value; if (v && typeof v === "object" && !(v instanceof Date)) v = v.result !== undefined ? v.result : v.richText ? v.richText.map((t) => t.text).join("") : v.text !== undefined ? v.text : null; return v; };
const text = (v) => (v == null ? "" : R.clean(String(v)));

function rosterSheet(ws, company, { nameCol, firstDateCol, meta }) {
  const out = { people: [], sessions: new Map(), warnings: [] };
  // the header row is the one holding "Names"
  let hr = 0;
  for (let r = 1; r <= 6 && !hr; r++) if (/^names?$/i.test(text(val(ws.getRow(r).getCell(nameCol))))) hr = r;
  if (!hr) { out.warnings.push(`${ws.name}: couldn't find the "Names" header row; sheet skipped.`); return out; }
  const cols = [];
  for (let c = firstDateCol; c <= ws.columnCount; c++) { const d = iso(val(ws.getRow(hr).getCell(c))); if (d) cols.push({ c, d }); else if (/total/i.test(text(val(ws.getRow(hr).getCell(c))))) break; }
  for (const { d } of cols) out.sessions.set(d, { date: d, attended: [], remark: "", numeric: false });
  for (let r = hr + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r), name = text(val(row.getCell(nameCol)));
    if (!name) continue;
    if (/^(total|summary|avg)/i.test(name)) break;
    const person = { full_name: name, ...meta(row), rowNo: r };
    out.people.push(person);
    for (const { c, d } of cols) {
      const v = val(row.getCell(c)), s = out.sessions.get(d);
      if (v === 1 || v === "1") { s.attended.push(person); s.numeric = true; }
      else if (typeof v === "number") s.numeric = true;
      else if (typeof v === "string" && text(v)) s.remark = s.remark || text(v);
    }
  }
  return out;
}

async function parseTracker(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = (re) => wb.worksheets.find((w) => re.test(w.name.trim()));
  const warnings = [];
  const plan = { participants: [], sessions: [] }; // participants: {company, full_name, ...}; sessions: {company, date, kind, title, status, headcount, attended:[personRef], remarks}
  const key = (co, d, kind, title = "") => `${co}|${d}|${kind}|${title}`;
  const sessions = new Map();
  const add = (s) => { sessions.set(key(s.company, s.date, s.kind, s.title), s); };

  // --- per-person sheets
  const lim = sheet(/^l'?imad$/i);
  if (lim) {
    const r = rosterSheet(lim, "LIMAD", { nameCol: 2, firstDateCol: 6, meta: (row) => ({ gender: text(val(row.getCell(3))), bike_size: text(val(row.getCell(4))), status: text(val(row.getCell(5))) === "Inactive" ? "Inactive" : "Active" }) });
    warnings.push(...r.warnings);
    for (const p of r.people) plan.participants.push({ company: "LIMAD", ...p });
    for (const s of r.sessions.values()) {
      if (!s.numeric && !s.remark) continue;
      const cancelled = !s.attended.length && CANCEL_RE.test(s.remark);
      add({ company: "LIMAD", date: s.date, kind: C.RIDE, title: "", status: cancelled ? "Cancelled" : "Held", headcount: !cancelled && !s.attended.length && s.numeric ? 0 : null, attended: s.attended.map((p) => ({ company: "LIMAD", rowNo: p.rowNo })), remarks: s.remark || null, from: "Limad sheet" });
    }
  } else warnings.push('No "Limad" sheet found.');
  const nm = sheet(/^nmdc$/i);
  if (nm) {
    const r = rosterSheet(nm, "NMDC", { nameCol: 2, firstDateCol: 3, meta: () => ({ status: "Active" }) });
    warnings.push(...r.warnings);
    for (const p of r.people) plan.participants.push({ company: "NMDC", ...p });
    for (const s of r.sessions.values()) {
      if (!s.attended.length && !s.remark) continue;
      add({ company: "NMDC", date: s.date, kind: C.RIDE, title: "", status: !s.attended.length && CANCEL_RE.test(s.remark) ? "Cancelled" : "Held", attended: s.attended.map((p) => ({ company: "NMDC", rowNo: p.rowNo })), remarks: s.remark || null, from: "NMDC sheet" });
    }
  } else warnings.push('No "NMDC" sheet found.');

  // --- Aurora: one row per activity with a headcount
  const kindOf = (s) => /run/i.test(s) ? "Running" : /yoga/i.test(s) ? "Yoga" : /workshop/i.test(s) ? "Workshop" : /cycl|ride/i.test(s) ? C.RIDE : "Event";
  const au = sheet(/^aurora$/i);
  if (au) {
    for (let r = 1; r <= au.rowCount; r++) {
      const row = au.getRow(r), init = text(val(row.getCell(1))), d = iso(val(row.getCell(2))), n = val(row.getCell(3)), rem = text(val(row.getCell(4)));
      if (!init || /^(aurora|initiatives)$/i.test(init)) continue;
      if (!d) { warnings.push(`AURORA row ${r}: "${init}" (${n == null ? "no count" : n}) has no date, so it was left out.`); continue; }
      const kind = kindOf(init);
      add({ company: "AURORA", date: d, kind, title: kind === C.RIDE ? "" : init, status: typeof n === "number" ? "Held" : d < R.todayLocal() ? "Held" : "Scheduled",
        headcount: typeof n === "number" ? n : null, attended: [], remarks: rem || (typeof n === "number" ? null : "No count recorded in the tracker"), from: "AURORA sheet" });
    }
  } else warnings.push('No "AURORA" sheet found.');

  // --- Master Data: fills dates the other sheets don't have; flags differences
  const md = sheet(/^master data$/i);
  let mdUsed = 0, mdSame = 0;
  if (md) {
    let hr = 0;
    for (let r = 1; r <= 5 && !hr; r++) if (/^company$/i.test(text(val(md.getRow(r).getCell(1))))) hr = r;
    for (let r = hr + 1; hr && r <= md.rowCount; r++) {
      const row = md.getRow(r), co = text(val(row.getCell(1)));
      if (!co || /cross this line/i.test(co)) { if (/cross this line/i.test(co)) break; continue; }
      const d = iso(val(row.getCell(3))); if (!d) continue;
      const total = val(row.getCell(6)), expat = val(row.getCell(7)), emi = val(row.getCell(8)), nw = val(row.getCell(9)), rem = text(val(row.getCell(10)));
      let company, kind = C.RIDE, title = "";
      if (/^adq|limad/i.test(co)) company = "LIMAD";
      else if (/^nmdc/i.test(co)) company = "NMDC";
      else if (/aurora/i.test(co)) { company = "AURORA"; kind = kindOf(co); title = kind === C.RIDE ? "" : co.replace(/^aurora/i, "Aurora").replace(/AURORA/g, "Aurora"); }
      else { warnings.push(`Master Data row ${r}: company "${co}" isn't one of L'IMAD, NMDC or Aurora; left out.`); continue; }
      // Aurora titles in Master Data are like "AURORA Running"; match the AURORA sheet's spelling when that row exists
      const same = [...sessions.values()].find((s) => s.company === company && s.date === d && s.kind === kind);
      const n = typeof total === "number" ? total : null;
      if (same) {
        const have = same.attended.length || same.headcount || 0;
        if (n != null && same.status !== "Cancelled" && n !== have) warnings.push(`${company} ${d}: Master Data says ${n}, the ${same.from} has ${have}. Kept ${have}.`);
        else mdSame++;
        if (same.status === "Held" && !have && n == null && CANCEL_RE.test(rem)) { same.status = "Cancelled"; same.remarks = rem; }
        if (!same.attended.length && same.headcount == null && n != null) same.headcount = n;
        continue;
      }
      mdUsed++;
      const cancelled = n == null && CANCEL_RE.test(rem);
      add({ company, date: d, kind, title, status: cancelled ? "Cancelled" : n == null ? (d < R.todayLocal() ? "Held" : "Scheduled") : "Held", headcount: n,
        headcount_expat: typeof expat === "number" ? expat : null, headcount_emirati: typeof emi === "number" ? emi : null, headcount_new: typeof nw === "number" ? nw : null,
        attended: [], remarks: rem || (/-01$/.test(d) && n != null && d < "2025-04-01" ? "Monthly total (Master Data)" : null), from: "Master Data" });
    }
  }
  if (sheet(/^presight$/i)) warnings.push("PRESIGHT sheet (Nov–Dec 2024) isn't one of the three current partners, so it was left out.");

  // possible duplicate people (same words in a different order, e.g. "Rhea Sevilla" / "Sevilla Rhea")
  const seen = new Map();
  for (const p of plan.participants) {
    const k = p.company + "|" + C.nameKey(p.full_name);
    if (seen.has(k)) warnings.push(`${p.company}: "${seen.get(k)}" and "${p.full_name}" look like the same person. Both were imported; merge them on the Participants page if they are.`);
    else seen.set(k, p.full_name);
  }
  plan.sessions = [...sessions.values()].sort((a, b) => a.date.localeCompare(b.date));
  const s = plan.sessions;
  const summary = {
    participants: { LIMAD: plan.participants.filter((p) => p.company === "LIMAD").length, NMDC: plan.participants.filter((p) => p.company === "NMDC").length },
    sessions: ["LIMAD", "NMDC", "AURORA"].map((co) => ({ co, held: s.filter((x) => x.company === co && x.status === "Held").length, cancelled: s.filter((x) => x.company === co && x.status === "Cancelled").length,
      attendance: s.filter((x) => x.company === co && x.status === "Held").reduce((a, x) => a + (x.attended.length || x.headcount || 0), 0), checkins: s.filter((x) => x.company === co).reduce((a, x) => a + x.attended.length, 0) })),
    first: s.length ? s[0].date : null, last: s.length ? s[s.length - 1].date : null, masterDataUsed: mdUsed, masterDataMatched: mdSame,
  };
  return { plan, warnings, summary };
}

/** Replaces all corporate participants, sessions and check-ins with the tracker's content. Companies and their QR links stay. */
async function commitTracker(parsed, by, fileName) {
  return tx(async (c) => {
    await C.seedCompanies(c);
    await c.query("DELETE FROM corp_attendance; DELETE FROM corp_sessions; DELETE FROM corp_participants; DELETE FROM counters WHERE name LIKE 'CORP-%';");
    const byRow = new Map();
    for (const p of parsed.plan.participants) {
      const row = await C.createParticipant(c, { ...p, joined: null }, by, "Corporate tracker import");
      byRow.set(p.company + "|" + p.rowNo, row);
    }
    let checkins = 0;
    for (const s of parsed.plan.sessions) {
      const row = (await c.query(`INSERT INTO corp_sessions (company, session_date, kind, title, status, headcount, headcount_expat, headcount_emirati, headcount_new, remarks, imported, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,TRUE,$11) RETURNING id`, [s.company, s.date, s.kind, s.title || "", s.status, s.headcount == null ? null : s.headcount,
        s.headcount_expat == null ? null : s.headcount_expat, s.headcount_emirati == null ? null : s.headcount_emirati, s.headcount_new == null ? null : s.headcount_new, s.remarks, by])).rows[0];
      for (const a of s.attended) {
        const p = byRow.get(a.company + "|" + a.rowNo); if (!p) continue;
        await c.query("INSERT INTO corp_attendance (session_id, participant_id, method, at, created_by) VALUES ($1,$2,'Tracker import',$3,$4) ON CONFLICT DO NOTHING", [row.id, p.id, s.date + "T00:00:00", by]);
        checkins++;
      }
    }
    // joined = first session attended (or today for people with none yet)
    await c.query(`UPDATE corp_participants p SET joined = coalesce((SELECT min(s.session_date) FROM corp_attendance a JOIN corp_sessions s ON s.id = a.session_id WHERE a.participant_id = p.id), joined)`);
    await audit(c, by, "corp.import", "corp_tracker", fileName, null, { participants: parsed.plan.participants.length, sessions: parsed.plan.sessions.length, checkins }, "Corporate tracker import");
    return { participants: parsed.plan.participants.length, sessions: parsed.plan.sessions.length, checkins };
  });
}

module.exports = { parseTracker, commitTracker };
