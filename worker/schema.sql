-- Driving instructor booking site — D1 schema
-- Apply with: wrangler d1 execute <db-name> --file=worker/schema.sql

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Weekly availability template + business config live in settings as JSON:
--   'config'   -> {name, area, phone, email, prices:{"60":x,"90":x,"120":x}, notice_hours, horizon_days}
--   'template' -> {"mon":{"start":"09:00","end":"18:00"}, ... , "sun":null}

CREATE TABLE IF NOT EXISTS bookings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ref          TEXT NOT NULL UNIQUE,          -- short code the pupil keeps
  date         TEXT NOT NULL,                 -- YYYY-MM-DD (UK local)
  time         TEXT NOT NULL,                 -- HH:MM (UK local)
  duration_min INTEGER NOT NULL,
  lesson_type  TEXT NOT NULL,                 -- manual | automatic
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  phone        TEXT NOT NULL,
  postcode     TEXT NOT NULL,                 -- pickup postcode
  notes        TEXT DEFAULT '',
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled
  created_at   INTEGER NOT NULL               -- epoch seconds
);

CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(date, status);

-- Per-date exceptions to the weekly template
CREATE TABLE IF NOT EXISTS overrides (
  date   TEXT PRIMARY KEY,                    -- YYYY-MM-DD
  closed INTEGER NOT NULL DEFAULT 1,          -- 1 = whole day off
  note   TEXT DEFAULT ''
);

-- Simple rate limiting for the public booking endpoint
CREATE TABLE IF NOT EXISTS attempts (
  bucket TEXT NOT NULL,                       -- e.g. 'book:<ip>'
  at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts ON attempts(bucket, at);
