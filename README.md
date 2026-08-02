# Driving Instructor Booking Site

A booking site for a UK driving instructor (manual tuition only): pupils see
live availability, request one-off or weekly-recurring lessons, track what
they owe, and cancel with clear fee rules; the instructor manages bookings,
pupils' accounts, availability and prices from a key-gated console.

Stack: Cloudflare Worker (serves both the static pages and the JSON API on
one origin) + D1.

## Layout

| Path | What it is |
|---|---|
| `public/index.html` | Public booking page — price/length picker, availability calendar, booking form (with "repeat weekly for 4/8/12 weeks"), and the **My lessons** pupil portal: email+password accounts (signup/reset proven by a booking ref), money owed, lesson credit, upcoming costs, per-lesson cancel. |
| `public/admin.html` | Instructor console — 5 tabs: **Bookings** (weekly series collapsed to one ↻-badged line, expand/confirm-all/cancel-all), **Calendar** (month grid: lessons color-coded by status, time off shaded), **Students** (Active/Passed lists; per-pupil account: lessons, owed, mark paid, pay-from-credit, credit top-ups, private notes, mark-as-passed), **Availability**, **Settings**. |
| `worker/worker.js` | The Worker: public `/api/config`, `/api/slots`, `/api/book`; pupil `/auth/signup`, `/auth/login`, `/auth/reset`, `/auth/logout`, `/me/lessons`, `/me/cancel`; admin `/admin/bookings`, `/admin/booking`, `/admin/calendar`, `/admin/paid`, `/admin/students`, `/admin/student`, `/admin/student-meta`, `/admin/credit`, `/admin/pay-from-credit`, `/admin/schedule`, `/admin/override`, `/admin/settings`. |
| `worker/schema.sql` | D1 schema: `settings`, `bookings` (price/paid/fee/cancelled_by/series), `overrides` (date ranges), `students` (notes/passed/credit), `users`, `sessions`, `attempts`. |
| `wrangler.toml` | Worker + assets + D1 binding config. |

## Business rules (the contract — keep code and copy in sync)

- **Times are UK wall-clock** (Europe/London), stored as `YYYY-MM-DD` + `HH:MM`
  strings, never UTC-converted. The Worker derives "now" via `Intl`.
- **Two separate notice windows**, deliberately distinct in the UI:
  - `notice_hours` — minimum notice to **book** (how soon a slot can start).
  - `cancel_notice_hours` — minimum notice to **cancel without charge**.
    A pupil cancelling inside this window owes `late_cancel_fee` (£).
    The popup wording on the pupil side states which side of the window
    they're on *before* they confirm; the server computes the fee
    authoritatively on `/api/cancel`.
- **Instructor cancellations never charge the pupil** (`cancelled_by:
  'instructor'`, fee 0) — including the auto-cancels when time off is blocked.
- **Pupil cancellation notifications** (email + SMS): every instructor-side
  cancel (single, series bulk, time-off auto-cancel) triggers ONE message per
  pupil listing all cancelled dates (`notifyCancelledPupils`). Channels are
  secret-gated and silently skipped when unconfigured: email = Resend
  (`RESEND_API_KEY` + `MAIL_FROM`, needs a verified domain on a SEPARATE
  Resend account — never ValueTally's), SMS = Twilio (`TWILIO_SID` +
  `TWILIO_TOKEN` + `TWILIO_FROM`; UK numbers normalized to E.164, 07… → +44).
  `/admin/booking` accepts `{ids: [...]}` for series bulk actions so the
  pupil isn't messaged once per week. Send failures never break the request.
- **Blocking time off** takes a start/end date range; all non-cancelled
  lessons inside are auto-cancelled and returned to the console so the
  instructor can contact the pupils (also pushed via ntfy if configured).
  Reopening a period does NOT restore auto-cancelled lessons.
- **Money owed** per pupil = past **confirmed** unpaid lessons (price) +
  unpaid **student** late-cancel fees. Pending lessons that were never
  confirmed cost nothing. `paid` on a cancelled booking means the fee is
  settled. Upcoming cost = all future non-cancelled lessons.
- **Recurring bookings**: `repeat_weeks` ∈ {1,4,8,12} (server cap 12). The
  first lesson must pass normal booking rules (notice + horizon); later weeks
  skip the horizon check (that's the point) but still respect availability —
  unavailable weeks are skipped and reported back. All lessons in a series
  share a `series` id but have individual refs and cancel individually.
- **Site-wide sign-in**: a signed-in pupil's `/api/book` takes the email from
  the session; name/phone fall back to their latest booking (the form hides
  those fields and shows "Booking as …"). Pickup = house number/name +
  postcode (both required).
- **Dismiss (×)**: `/admin/hide` removes a row from the console Bookings
  list ONLY for past or cancelled lessons (upcoming ones must be cancelled
  first — a hidden active lesson would invisibly block slots). Hidden rows
  stay in the pupil's account history and in all money math.
- **Pupil accounts**: email + password (PBKDF2-SHA256 100k, per-user salt;
  90-day bearer sessions stored hashed). There is NO email service on this
  project, so **signup and password reset require a booking reference**
  belonging to that email as proof of identity (refs are 6-char unguessable
  codes) — this is what stops someone registering another person's email and
  reading their lessons. Password reset signs out all sessions. Auth is
  rate-limited 20/h/IP; booking 5/h/IP.
- **Credit**: per-pupil prepaid balance (`students.credit`), topped
  up/deducted by the instructor. Displayed owed = gross owed − credit
  (floor 0). "Pay from credit" settles one lesson/fee atomically (marks paid
  + deducts); insufficient credit is rejected server-side.
- **Passed**: `students.passed` removes the pupil from the default Students
  list (they move to the Passed list, owed money still visible; portal shows
  a congratulations note). Instructor **notes** are private — served only via
  `/admin/*`, never in any pupil-facing response.
- Slots are computed (weekly template − blocked ranges − bookings) on a
  30-min grid for 60/90/120-min lessons with overlap checks; `/api/book`
  re-validates server-side (409 if taken).
- **Manual-transmission only** (owner decision 2026-07-31) — no lesson-type
  field anywhere.

## Deploy (owner's Cloudflare account)

```bash
export CLOUDFLARE_API_TOKEN=...   # scoped: Workers Scripts:Edit + D1:Edit
npx wrangler d1 create driving-booking          # put the id in wrangler.toml
npx wrangler d1 execute driving-booking --remote --file=worker/schema.sql
npx wrangler deploy
npx wrangler secret put ADMIN_KEY               # long random; hand to instructor
npx wrangler secret put NTFY_TOPIC              # optional, a NEW topic
```

The site is then live at the workers.dev URL (custom domain can be added on
the Worker later). Both pages auto-detect a missing backend and fall into a
sample-data preview mode — that's what you see when opening the HTML files
directly.

## Ownership / handover notes

- Owner (Harris) hosts and holds the Cloudflare account + repo; the
  instructor gets the ADMIN_KEY only. Everything is portable: redeploy =
  this repo + `wrangler d1 export` of the data. Domain (if/when bought)
  should be registered in the instructor's name.
