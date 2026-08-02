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
  motorway     INTEGER NOT NULL DEFAULT 0,    -- 1 = motorway lesson
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

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);

-- Blocked periods (holidays / days off) — inclusive date ranges
CREATE TABLE IF NOT EXISTS overrides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,                   -- YYYY-MM-DD
  end_date   TEXT NOT NULL,                   -- YYYY-MM-DD (>= start_date)
  note       TEXT DEFAULT ''
);

-- Instructor-maintained per-pupil record (keyed by booking email)
CREATE TABLE IF NOT EXISTS students (
  email      TEXT PRIMARY KEY,
  notes      TEXT NOT NULL DEFAULT '',
  passed     INTEGER NOT NULL DEFAULT 0,     -- 1 = passed their test (hidden from default list)
  credit     REAL NOT NULL DEFAULT 0,        -- £ prepaid balance
  credit_min INTEGER NOT NULL DEFAULT 0,     -- prepaid lesson time (minutes, e.g. packages)
  test_date  TEXT,                           -- pupil-entered driving test date (YYYY-MM-DD)
  updated_at INTEGER
);
-- Existing deployments: ALTER TABLE students ADD COLUMN test_date TEXT;
--                       ALTER TABLE students ADD COLUMN credit_min INTEGER NOT NULL DEFAULT 0;

-- Standalone account charges (package fees etc.) — count toward owed until paid
CREATE TABLE IF NOT EXISTS charges (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL,
  label      TEXT NOT NULL,                  -- e.g. 'Beginner Package'
  amount     REAL NOT NULL,                  -- £
  paid       INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_charges_email ON charges(email);

-- Pupil requests for fixed packages, reviewed in the console
CREATE TABLE IF NOT EXISTS package_requests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  package    TEXT NOT NULL,                  -- key into the PACKAGES map in worker.js
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
