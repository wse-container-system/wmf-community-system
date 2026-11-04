"use strict";
const { Pool, types } = require("pg");
// Dates without a zone are UAE wall-clock times, as in the workbook: keep them as text ("2026-11-01T18:30:00")
types.setTypeParser(1114, (s) => s.replace(" ", "T").slice(0, 19));
types.setTypeParser(1082, (s) => s);

const url = process.env.DATABASE_URL || "postgres://postgres@localhost:5432/wmf";
// Neon (and any connection string with sslmode=require) uses verified SSL; Render's external URL needs SSL too.
const needsSsl = process.env.PGSSL === "require" || /neon\.tech|sslmode=require/.test(url);
const ssl = needsSsl ? true : /render\.com/.test(url) ? { rejectUnauthorized: false } : false;
// pg reads sslmode from the URL and would override our setting, so pass the URL without it
const connectionString = url.replace(/([?&])(sslmode|channel_binding)=[^&]*&?/g, "$1").replace(/([?&])(sslmode|channel_binding)=[^&]*&?/g, "$1").replace(/[?&]$/, "");
const pool = new Pool({ connectionString, ssl, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 15000 });
pool.on("error", (e) => console.error("Database connection dropped (it reconnects on the next request):", e.message));

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

ALTER TABLE activities ADD COLUMN IF NOT EXISTS core BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS sort_order INTEGER;

-- duplicates
CREATE TABLE IF NOT EXISTS merges (
  id SERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT, reason TEXT,
  kept TEXT NOT NULL, merged TEXT NOT NULL, moved_ids INTEGER[] NOT NULL DEFAULT '{}', kept_before JSONB, undone_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS dupe_dismissed (a TEXT NOT NULL, b TEXT NOT NULL, at TIMESTAMPTZ NOT NULL DEFAULT now(), actor TEXT, PRIMARY KEY (a, b));

-- paid events
ALTER TABLE activities ADD COLUMN IF NOT EXISTS price_aed NUMERIC(10,2);
ALTER TABLE activities ADD COLUMN IF NOT EXISTS payment_url TEXT;
ALTER TABLE participation ADD COLUMN IF NOT EXISTS payment_status TEXT;
ALTER TABLE participation ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE participation ADD COLUMN IF NOT EXISTS payment_note TEXT;

-- WMF activations (events, campaigns, workshops …) and the partners WMF works with
CREATE TABLE IF NOT EXISTS partners (
  id SERIAL PRIMARY KEY, name TEXT UNIQUE NOT NULL, kind TEXT, aliases TEXT[] NOT NULL DEFAULT '{}', notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS activations (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  month DATE NOT NULL,
  event_date DATE,
  date_note TEXT,
  category TEXT NOT NULL,
  category_raw TEXT,
  lead_owner TEXT,
  frequency TEXT,
  location TEXT,
  participants INTEGER,
  registrants INTEGER,
  impact TEXT,
  link TEXT,
  status TEXT NOT NULL DEFAULT 'Completed',
  activity_id TEXT,
  source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activations_month ON activations (month);
CREATE TABLE IF NOT EXISTS activation_partners (
  activation_id INTEGER NOT NULL REFERENCES activations(id) ON DELETE CASCADE,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  PRIMARY KEY (activation_id, partner_id)
);

-- newsletters and event emails
CREATE TABLE IF NOT EXISTS newsletters (
  id SERIAL PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'monthly', title TEXT NOT NULL, month DATE, activity_id TEXT,
  intro TEXT, sections JSONB NOT NULL DEFAULT '[]', options JSONB NOT NULL DEFAULT '{}',
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calendar_items (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('wmf_ride','wmf_event','generic_event','track_closure')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_time TEXT,
  end_time TEXT,
  location TEXT,
  status TEXT NOT NULL DEFAULT 'Confirmed',
  recur JSONB,
  exceptions JSONB,
  url TEXT,
  ride_slot TEXT,
  activity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "session" (
  "sid" varchar NOT NULL COLLATE "default" PRIMARY KEY,
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL
);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");

-- ===== Cycling Development hub =====
-- a sponsor or viewer can be limited to one corporate partner (NULL = everything their role allows)
ALTER TABLE users ADD COLUMN IF NOT EXISTS company TEXT;
-- how a company's staff record attendance: 'personal' = each person shows their own QR code to the ride lead (the company link only hands out codes);
-- 'self' = people check themselves in with the company QR code


-- ----- Corporate cycling programme -----
CREATE TABLE IF NOT EXISTS corp_companies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  ride_days TEXT NOT NULL DEFAULT 'Thu',
  ride_time TEXT,
  location TEXT,
  contact TEXT,
  checkin_token TEXT UNIQUE NOT NULL,
  color TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE corp_companies ADD COLUMN IF NOT EXISTS checkin_mode TEXT NOT NULL DEFAULT 'personal';
CREATE TABLE IF NOT EXISTS corp_participants (
  id SERIAL PRIMARY KEY,
  pid TEXT UNIQUE NOT NULL,
  company TEXT NOT NULL REFERENCES corp_companies(code),
  full_name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  email TEXT,
  gender TEXT,
  community TEXT,
  bike_size TEXT,
  status TEXT NOT NULL DEFAULT 'Active',
  joined DATE,
  source TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corp_participants_company ON corp_participants (company, name_key);
CREATE TABLE IF NOT EXISTS corp_sessions (
  id SERIAL PRIMARY KEY,
  company TEXT NOT NULL REFERENCES corp_companies(code),
  session_date DATE NOT NULL,
  kind TEXT NOT NULL DEFAULT 'Weekly ride',
  title TEXT NOT NULL DEFAULT '',
  location TEXT,
  status TEXT NOT NULL DEFAULT 'Held' CHECK (status IN ('Scheduled','Held','Cancelled')),
  headcount INTEGER,
  headcount_expat INTEGER,
  headcount_emirati INTEGER,
  headcount_new INTEGER,
  remarks TEXT,
  imported BOOLEAN NOT NULL DEFAULT FALSE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company, session_date, kind, title)
);
CREATE INDEX IF NOT EXISTS corp_sessions_date ON corp_sessions (session_date);
CREATE TABLE IF NOT EXISTS corp_attendance (
  id SERIAL PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES corp_sessions(id) ON DELETE CASCADE,
  participant_id INTEGER NOT NULL REFERENCES corp_participants(id) ON DELETE CASCADE,
  method TEXT NOT NULL,
  at TIMESTAMP NOT NULL,
  created_by TEXT,
  UNIQUE (session_id, participant_id)
);
CREATE INDEX IF NOT EXISTS corp_attendance_participant ON corp_attendance (participant_id);

-- ----- Cycling Development department (staff admin) -----
CREATE TABLE IF NOT EXISTS dept_staff (
  id SERIAL PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE,
  employee_no TEXT,
  job_title TEXT,
  team TEXT,
  start_date DATE,
  leave_entitlement NUMERIC(5,1) NOT NULL DEFAULT 22,
  carry_over NUMERIC(5,1) NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS dept_leave (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES dept_staff(id),
  leave_type TEXT NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(5,1) NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending','Approved','Rejected','Cancelled')),
  requested_by TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by TEXT,
  decided_at TIMESTAMPTZ,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS dept_leave_staff ON dept_leave (staff_id, start_date);
CREATE TABLE IF NOT EXISTS dept_attendance (
  id SERIAL PRIMARY KEY,
  staff_id INTEGER NOT NULL REFERENCES dept_staff(id),
  work_date DATE NOT NULL,
  status TEXT NOT NULL,
  check_in TEXT,
  check_out TEXT,
  location TEXT,
  notes TEXT,
  source TEXT,
  updated_by TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, work_date)
);
-- shareable scanner pages for staff taking attendance (no sign-in; can only record check-ins)
CREATE TABLE IF NOT EXISTS scanner_links (
  id SERIAL PRIMARY KEY,
  token TEXT UNIQUE NOT NULL,
  label TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'both' CHECK (scope IN ('both','wmf','corporate')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  scans INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_opened TIMESTAMPTZ,
  last_used TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS dept_holidays (holiday DATE PRIMARY KEY, name TEXT NOT NULL);
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
