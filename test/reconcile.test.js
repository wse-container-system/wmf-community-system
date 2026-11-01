"use strict";
/**
 * Checks that importing the 30 Sep 2026 workbook into the database reproduces the figures agreed on 1–2 Oct 2026.
 *   TEST_DATABASE_URL=… RECONCILE_WORKBOOK=path/to/old-workbook.xlsx npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const DB = process.env.TEST_DATABASE_URL, WB = process.env.RECONCILE_WORKBOOK;
if (!DB || !WB) { test("reconcile (skipped: set TEST_DATABASE_URL and RECONCILE_WORKBOOK)", () => {}); return; }
process.env.DATABASE_URL = DB;
const { pool, migrate } = require("../src/db");
const { parseWorkbook, commitImport } = require("../src/importer");
const { buildData } = require("../src/snapshot");
const R = require("../src/rules");
const E = require("../src/engine");

test("agreed reference figures (data to 30 Sep 2026)", async () => {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await migrate();
  await commitImport(await parseWorkbook(fs.readFileSync(WB)), "test");
  const P = E.prepare(await buildData());
  const asOf = "2026-09-30";
  const k = (start, end) => E.compute(P, { start, end }, asOf).kpis;
  const sep = k("2026-09-01", "2026-09-30"), aug = k("2026-08-01", "2026-08-31"), q3 = k("2026-07-01", "2026-09-30"), oct24 = k("2024-10-01", "2024-10-31");
  assert.equal(sep.participants, 53, "Sep members taking part");
  assert.equal(sep.newMembers, 26, "Sep new members");
  assert.equal(sep.rideAttendance, 68, "Sep ride attendance");
  assert.equal(sep.rideSessions, 14, "Sep ride sessions");
  assert.equal(sep.eventRegistrations, 23, "Sep event registrations");
  assert.equal(sep.activeMembers, 50, "active as of 30 Sep");
  assert.equal(sep.inactiveMembers, 887, "inactive as of 30 Sep");
  assert.equal(aug.rideAttendance, 116, "Aug ride attendance");
  assert.equal(aug.rideSessions, 24, "Aug ride sessions");
  assert.equal(E.compute(P, { start: "2026-08-01", end: "2026-08-31" }, "2026-08-31").kpis.activeMembers, 44, "active at end of Aug");
  assert.equal(q3.newMembers, 46, "Q3 new members");
  assert.equal(q3.rideAttendance, 300, "Q3 ride attendance");
  assert.equal(q3.rideSessions, 73, "Q3 ride sessions");
  assert.equal(oct24.eventParticipation, 96, "Oct 2024 event participation");
  assert.equal(oct24.largeEvents.attendance, 1000, "Oct 2024 large event");

  // the scanner's duplicate check sees rides imported from the forms
  const r = (await pool.query(`SELECT p.*, a.* FROM participation p JOIN activities a USING (activity_id)
     WHERE p.imported AND a.kind = 'ride' AND p.status = 'Attended' AND p.member_id IS NOT NULL ORDER BY p.record_date DESC LIMIT 1`)).rows[0];
  const m = (await pool.query("SELECT * FROM members WHERE member_id = $1", [r.member_id])).rows[0];
  const day = r.record_date.slice(0, 10);
  assert.ok(await R.alreadyRode(pool, m, day, R.seriesFor(r, day)), "imported ride found");
  await pool.end();
});
