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
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,                 -- stored lowercased
  phone        TEXT NOT NULL,
  postcode     TEXT NOT NULL,                 -- pickup postcode
  notes        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled
  cancelled_by TEXT,                          -- 'student' | 'instructor' (null unless cancelled)
  fee          REAL NOT NULL DEFAULT 0,       -- late-cancellation fee owed (£)
  paid         INTEGER NOT NULL DEFAULT 0,    -- 1 = lesson price (or fee, if cancelled) settled
  created_at   INTEGER NOT NULL               -- epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);
CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);

-- Blocked periods (holidays / days off) — inclusive date ranges
CREATE TABLE IF NOT EXISTS overrides (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  start_date TEXT NOT NULL,                   -- YYYY-MM-DD
  end_date   TEXT NOT NULL,                   -- YYYY-MM-DD (>= start_date)
  note       TEXT DEFAULT ''
);

-- Simple rate limiting for public endpoints
CREATE TABLE IF NOT EXISTS attempts (
  bucket TEXT NOT NULL,                       -- e.g. 'book:<ip>'
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(bucket, at);
