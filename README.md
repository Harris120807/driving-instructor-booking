# Driving Instructor Booking Site

A booking site for a UK driving instructor: pupils see live availability and
request lessons; the instructor manages everything from a key-gated admin
console. Same stack pattern as ValueTally: static pages + a Cloudflare Worker
API + D1.

## What's here

| File | What it is |
|---|---|
| `index.html` | Public booking page — lesson type/length picker with prices, 3-week availability calendar, booking form (name/email/phone/pickup postcode), self-service cancel by reference + email. |
| `admin.html` | Instructor console (Bearer admin key, sessionStorage) — bookings list with confirm/cancel, weekly-hours editor, days-off/holiday blocker, business settings (name, area, prices, notice/horizon rules). |
| `worker/worker.js` | Cloudflare Worker API — public `/api/config`, `/api/slots`, `/api/book`, `/api/cancel`; admin `/admin/bookings`, `/admin/booking`, `/admin/schedule`, `/admin/override`, `/admin/settings`. |
| `worker/schema.sql` | D1 schema: `settings`, `bookings`, `overrides`, `attempts` (rate limiting). |

## Design decisions

- **Times are UK wall-clock** (Europe/London) throughout — stored as
  `YYYY-MM-DD` + `HH:MM` strings, never UTC-converted, so DST can't shift a
  lesson. The Worker derives "now" via `Intl` in Europe/London.
- **Booking flow is request → confirm**: a booking lands as `pending` and the
  instructor confirms or declines from the console. No online payment.
- **Slots are computed, not stored**: weekly template (per-day start/end)
  minus date overrides (days off) minus non-cancelled bookings, on a 30-min
  start grid, for 60/90/120-min lessons with proper overlap checks. Booking
  re-validates the slot server-side (409 if taken meanwhile).
- **Rules enforced server-side**: minimum notice (default 12 h), booking
  horizon (default 21 days), 5 booking attempts/hour/IP, UK postcode +
  email + phone validation. Cancel-by-ref answers identically whether or not
  the ref exists (no probing).
- **Admin auth** = single `ADMIN_KEY` Worker secret, SHA-256-compared, sent
  as a Bearer header from the console (kept in sessionStorage only).
- **New-booking notifications** go to an optional `NTFY_TOPIC` secret — use a
  NEW ntfy topic for this project, never the ValueTally pipeline topics.
- **Preview mode**: with `API_BASE = ''` (as committed), both pages run on
  sample data with a visible banner, so the whole UI can be reviewed before
  any backend exists. Booking refs are one-shot codes (no ambiguous chars).

## Deployment (not yet provisioned — needs owner go-ahead)

1. **D1**: create a database, apply `worker/schema.sql`.
2. **Worker**: deploy `worker/worker.js` with binding `DB` → the database,
   secrets `ADMIN_KEY` (generate a long random one, hand to the instructor)
   and optionally `NTFY_TOPIC` (a fresh topic for the instructor's phone).
3. **Pages**: host `index.html` + `admin.html` anywhere static (GitHub Pages
   works); set `API_BASE` in BOTH files to the Worker URL.
4. First run: open `admin.html`, sign in, set business details, prices and
   weekly hours in Settings/Availability.

## Contracts to keep in sync

- Slot/booking JSON shapes between `worker.js` and both pages.
- `DURATIONS` (60/90/120) and `SLOT_STEP_MIN` (30) exist in the Worker;
  prices per duration live in the `config` settings row.
- The weekly template shape `{mon: {start, end} | null, ...}` is shared by
  `worker.js`, `admin.html`, and `schema.sql`'s comment.
