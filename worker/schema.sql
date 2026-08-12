-- Driving instructor booking site — D1 schema
-- Apply with: wrangler d1 execute driving-booking --remote --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Weekly availability template + business config live in settings as JSON:
--   'config'   -> {name, area, phone, email, prices:{"60":x,"90":x,"120":x},
--                  notice_hours, cancel_notice_hours, late_cancel_fee, horizon_days}
--   'template' -> {"mon":{"start":"09:00","end":"18:00"}, ... , "sun":null}

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ref          TEXT NOT NULL UNIQUE,          -- short code the pupil keeps
  series       TEXT,                          -- shared id for weekly-recurring bookings
  date         TEXT NOT NULL,                 -- YYYY-MM-DD (UK local)
  time         TEXT NOT NULL,                 -- HH:MM (UK local)
  duration_min INTEGER NOT NULL,
  price        REAL NOT NULL,                 -- £, captured at booking time
  lesson_type  TEXT NOT NULL DEFAULT 'manual', -- manual | automatic
  motorway     INTEGER NOT NULL DEFAULT 0,    -- 1 = motorway lesson (fixed length)
  mock         INTEGER NOT NULL DEFAULT 0,    -- 1 = mock test (fixed length)
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,                 -- stored lowercased
  phone        TEXT NOT NULL,
  postcode     TEXT NOT NULL,                 -- pickup postcode
  house        TEXT NOT NULL DEFAULT '',      -- pickup house number/name
  notes        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled
  cancelled_by TEXT,                          -- 'student' | 'instructor' (null unless cancelled)
  fee          REAL NOT NULL DEFAULT 0,       -- late-cancellation fee owed (£)
  paid         INTEGER NOT NULL DEFAULT 0,    -- 1 = lesson price (or fee, if cancelled) settled
  hidden       INTEGER NOT NULL DEFAULT 0,    -- 1 = dismissed from the console bookings list
  created_at   INTEGER NOT NULL               -- epoch seconds
);
-- Existing deployments: ALTER TABLE bookings ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
--                       ALTER TABLE bookings ADD COLUMN house TEXT NOT NULL DEFAULT '';
--                       ALTER TABLE bookings ADD COLUMN lesson_type TEXT NOT NULL DEFAULT 'manual';
--                       ALTER TABLE bookings ADD COLUMN motorway INTEGER NOT NULL DEFAULT 0;
--                       ALTER TABLE bookings ADD COLUMN mock INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);

-- Blocked periods (holidays / days off) — inclusive date ranges
-- Live migration 2026-08-11: ALTER TABLE overrides ADD COLUMN lesson_type TEXT;
-- (lesson_type: 'manual' | 'automatic' | NULL = time off for BOTH instructors)
CREATE TABLE IF NOT EXISTS overrides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,                   -- YYYY-MM-DD
  end_date   TEXT NOT NULL,                   -- YYYY-MM-DD (>= start_date)
  lesson_type TEXT,                       -- whose diary; NULL = both
  note       TEXT DEFAULT ''
);

-- Instructor-maintained per-pupil record (keyed by booking email)
CREATE TABLE IF NOT EXISTS students (
  email      TEXT PRIMARY KEY,
  notes      TEXT NOT NULL DEFAULT '',
  passed     INTEGER NOT NULL DEFAULT 0,     -- 1 = passed their test (hidden from default list)
  credit     REAL NOT NULL DEFAULT 0,        -- £ prepaid balance
  credit_min INTEGER NOT NULL DEFAULT 0,     -- prepaid lesson time (minutes, e.g. packages)
  credit_mock  INTEGER NOT NULL DEFAULT 0,     -- prepaid MOCK TESTS (count, tracked separately)
  archived   INTEGER NOT NULL DEFAULT 0,     -- 1 = filed away; keeps history, out of working lists
  test_date  TEXT,                           -- pupil-entered driving test date (YYYY-MM-DD)
  updated_at INTEGER
);
-- Existing deployments: ALTER TABLE students ADD COLUMN test_date TEXT;
--                       ALTER TABLE students ADD COLUMN credit_min INTEGER NOT NULL DEFAULT 0;
--                       ALTER TABLE students ADD COLUMN credit_mock INTEGER NOT NULL DEFAULT 0;
--                       ALTER TABLE students ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

-- Standalone account charges (package fees etc.) — count toward owed until paid
CREATE TABLE IF NOT EXISTS charges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  label      TEXT NOT NULL,                  -- e.g. 'Beginner Package'
  amount     REAL NOT NULL,                  -- £
  paid       INTEGER NOT NULL DEFAULT 0,
  -- which instructor earned it (they are paid separately): 'manual' |
  -- 'automatic'; NULL on pre-2026-08-11 rows and treated as manual
  lesson_type TEXT DEFAULT 'manual',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_email ON charges(email);
-- Live migration 2026-08-11: ALTER TABLE charges ADD COLUMN lesson_type TEXT DEFAULT 'manual';

-- Pupil requests for fixed packages, reviewed in the console
CREATE TABLE IF NOT EXISTS package_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  package    TEXT NOT NULL,                  -- key into the PACKAGES map in worker.js
  lesson_type TEXT NOT NULL DEFAULT 'manual', -- manual | automatic
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  phone      TEXT NOT NULL,
  postcode   TEXT NOT NULL DEFAULT '',
  house      TEXT NOT NULL DEFAULT '',
  notes      TEXT DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | declined
  created_at INTEGER NOT NULL
);

-- Pupil login accounts (signup requires a booking ref as proof of identity —
-- there is no email-verification service on this project)
CREATE TABLE IF NOT EXISTS users (
  email      TEXT PRIMARY KEY,               -- lowercased, matches bookings.email
  pw_hash    TEXT NOT NULL,                  -- PBKDF2-SHA256 100k iters
  salt       TEXT NOT NULL,                  -- per-user random hex
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,               -- sha256 of the bearer token
  email      TEXT NOT NULL,
  expires    INTEGER NOT NULL                -- epoch seconds
);
CREATE INDEX IF NOT EXISTS idx_sessions_email ON sessions(email);

-- Simple rate limiting for public endpoints
CREATE TABLE IF NOT EXISTS attempts (
  bucket TEXT NOT NULL,                       -- e.g. 'book:<ip>'
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(bucket, at);

-- Admin accounts (2026-08-11): email+password sign-in for the console; the
-- shared ADMIN_KEY is the proof required to create an account (or reset a
-- forgotten password). The raw key still works as a bearer token directly.
CREATE TABLE IF NOT EXISTS admins (
  email TEXT PRIMARY KEY,
  name TEXT DEFAULT '',
  pw_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  token_hash TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  expires INTEGER NOT NULL
);

-- Public gallery (2026-08-11): photos stored IN D1 as base64 (the console
-- shrinks them client-side to ~1600px JPEG first; server caps ~1MB binary,
-- 60 photos). Served via /api/gallery/img/{id} with immutable caching.
CREATE TABLE IF NOT EXISTS gallery (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  caption    TEXT DEFAULT '',
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,                  -- base64 image bytes
  created_at INTEGER NOT NULL
);

-- Developer console (2026-08-12, owner-only /developer page):
-- security events + worker errors, both written best-effort (a broken log
-- path must never break serving). detail carries route names/generic text
-- only — never passwords, tokens or pupil PII.
CREATE TABLE IF NOT EXISTS security_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,                   -- epoch seconds
  kind   TEXT NOT NULL,                      -- admin_auth_fail | admin_login | admin_register |
                                             -- dev_auth_fail | login_fail | signup
  detail TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS error_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  route  TEXT NOT NULL,
  detail TEXT DEFAULT ''
);

-- Admin action audit trail (2026-08-12): who did what in the console.
-- actor = admin account email, 'admin key' or 'developer'.
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  actor  TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT DEFAULT ''
);

-- Anonymous page-view counter (2026-08-12): one row per UK day, no IPs/UAs.
CREATE TABLE IF NOT EXISTS traffic (
  day   TEXT PRIMARY KEY,                    -- YYYY-MM-DD (Europe/London)
  views INTEGER NOT NULL DEFAULT 0
);
