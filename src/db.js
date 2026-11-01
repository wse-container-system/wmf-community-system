"use strict";
const { Pool, types } = require("pg");
// Dates without a zone are UAE wall-clock times, as in the workbook: keep them as text ("2026-11-01T18:30:00")
types.setTypeParser(1114, (s) => s.replace(" ", "T").slice(0, 19));
types.setTypeParser(1082, (s) => s);

const url = process.env.DATABASE_URL || "postgres://postgres@localhost:5432/wmf";
// Render's internal connection string needs no SSL; an external one (…render.com) does.
const ssl = process.env.PGSSL === "require" || /render\.com/.test(url) ? { rejectUnauthorized: false } : false;
const pool = new Pool({ connectionString: url, ssl, max: 5 });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('admin','coordinator','viewer','sponsor')),
  password_hash TEXT NOT NULL,
  must_change BOOLEAN NOT NULL DEFAULT TRUE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS members (
  member_id TEXT PRIMARY KEY,
  member_key TEXT,
  full_name TEXT NOT NULL DEFAULT '',
  primary_email TEXT,
  alt_emails TEXT,
  mobile TEXT,
  gender TEXT,
  community TEXT,
  first_seen TIMESTAMP,
  qr_issued TEXT,
  qr_status TEXT,
  qr_value TEXT,
  qr_created TIMESTAMP,
  data_note TEXT,
  sources TEXT,
  emergency_name TEXT,
  emergency_number TEXT,
  updates_consent TEXT,
  waiver_consent TEXT,
  media_consent TEXT,
  merged_into TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS members_email ON members (lower(primary_email));
CREATE INDEX IF NOT EXISTS members_qr ON members (upper(qr_value));

CREATE TABLE IF NOT EXISTS activities (
  activity_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  activity_type TEXT,
  category TEXT,
  kind TEXT NOT NULL DEFAULT 'ride' CHECK (kind IN ('ride','event','registration','other')),
  location TEXT,
  event_date DATE,
  capacity INTEGER,
  registration_open BOOLEAN NOT NULL DEFAULT FALSE,
  status TEXT NOT NULL DEFAULT 'Active',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS participation (
  id SERIAL PRIMARY KEY,
  record_id TEXT,
  record_date TIMESTAMP NOT NULL,
  record_type TEXT NOT NULL,
  activity_id TEXT,
  activity_name TEXT,
  activity_type TEXT,
  status TEXT,
  counts_as_visit TEXT,
  member_name TEXT,
  member_email TEXT,
  phone TEXT,
  gender TEXT,
  community TEXT,
  member_key TEXT,
  source TEXT,
  form_response_id TEXT,
  notes TEXT,
  member_id TEXT,
  dedupe_key TEXT UNIQUE,
  imported BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  void_reason TEXT
);
CREATE INDEX IF NOT EXISTS participation_member ON participation (member_id);
CREATE INDEX IF NOT EXISTS participation_date ON participation (record_date);

CREATE TABLE IF NOT EXISTS history_rides (
  id SERIAL PRIMARY KEY, session_key TEXT, ride_date DATE NOT NULL, initiative TEXT, state TEXT,
  expat INTEGER, arab INTEGER, new_riders INTEGER, attendees INTEGER NOT NULL DEFAULT 0, remarks TEXT
);
CREATE TABLE IF NOT EXISTS history_events (
  id SERIAL PRIMARY KEY, event_key TEXT, report_month DATE NOT NULL, name TEXT NOT NULL, category TEXT,
  collaborator TEXT, frequency TEXT, attendance INTEGER NOT NULL DEFAULT 0, comments TEXT
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  before JSONB,
  after JSONB,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS audit_entity ON audit_log (entity, entity_id);

CREATE TABLE IF NOT EXISTS scan_log (
  id SERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT, scanned TEXT, activity_id TEXT, session_date DATE, result TEXT, member_id TEXT
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
`;

const DEFAULT_SETTINGS = {
  // agreed 1 Oct 2026: the test entries are removed; the 1,000-person meet & greet is reported on its own
  excludeEmails: ["rona.mier@auroravisiongroup.com"],
  separateEvents: ["Meet & greet with UAE TEAM ADQ pro rider"],
};

async function migrate() {
  await pool.query(SCHEMA);
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await pool.query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [k, JSON.stringify(v)]);
  }
}

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const out = await fn(c);
    await c.query("COMMIT");
    return out;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

/** Next number for a counter (MEMBER, ATT, EVT, REG). Atomic. */
async function nextNumber(c, name) {
  const r = await c.query(
    "INSERT INTO counters (name, value) VALUES ($1, 1) ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value", [name]);
  return Number(r.rows[0].value);
}

async function audit(c, actor, action, entity, entityId, before, after, reason) {
  await c.query("INSERT INTO audit_log (actor, action, entity, entity_id, before, after, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    [actor || null, action, entity || null, entityId || null, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, reason || null]);
}

async function getSettings(c) {
  const r = await (c || pool).query("SELECT key, value FROM settings");
  const out = { ...DEFAULT_SETTINGS };
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

module.exports = { pool, migrate, tx, nextNumber, audit, getSettings };
