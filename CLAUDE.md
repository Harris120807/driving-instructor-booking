# Driving Instructor Booking — Project Memory

Client project (owner: Harris, building for a UK driving instructor). This is
NOT part of ValueTally/stock-dashboard — keep the two entirely separate; never
reuse ValueTally's ntfy topics, Worker, or secrets here.

- **Stack**: one Cloudflare Worker (`wrangler.toml`) serving `public/` as
  static assets AND the JSON API; D1 database `driving-booking`. Deploy with
  wrangler + `CLOUDFLARE_API_TOKEN` pasted in-session (never committed).
- **Ownership model (owner decision 2026-07-31)**: Harris retains the repo +
  Cloudflare hosting; the instructor gets only the ADMIN_KEY. Keep handover
  cheap (README documents redeploy + D1 export).
- **Manual-only lessons** (2026-07-31). Prices default £44/£66/£88 for
  60/90/120 min — live values are in the D1 `config` settings row, edited
  from the console; code defaults are only a fallback.
- **README.md "Business rules" is the contract** — money-owed semantics, the
  two notice windows (book vs cancel), instructor-cancels-are-free,
  auto-cancel on time-off blocks, recurring-booking series behavior, portal
  auth (email + any ref). Change code and that section together, and keep the
  pupil-facing popup wording in `index.html` consistent with
  `cancel_notice_hours`/`late_cancel_fee`.
- **Shared shapes**: `openSlots` output, `publicLesson` fields, the weekly
  template `{mon:{start,end}|null,...}`, and `/admin/*` payloads are shared
  between `worker/worker.js` and both pages — change all touchpoints
  together. Owed/upcoming math lives in `owedOf`/`upcomingCostOf`
  (worker.js) and is mirrored nowhere (pages display server numbers; the
  only client-side duplicate is the late/not-late popup check, which the
  server re-computes authoritatively).
- **Times are UK wall-clock strings** everywhere (Europe/London via `Intl`);
  never convert to UTC or the DST bugs come back.
- **Demo mode**: both pages fall back to sample data when `/api/config` is
  unreachable (file preview). Don't remove — it's how the owner reviews UI
  changes without a backend.
- **Testing before any push**: `node --check` the worker and both pages'
  extracted `<script>` blocks, and run the stubbed-D1 smoke test pattern
  (see session history) — exercise slots/booking/cancel-fee/override paths.
- Secrets: `ADMIN_KEY`, optional `NTFY_TOPIC` (instructor's own topic),
  `RESEND_API_KEY` + `MAIL_FROM` (bookings@ridewaepride.com, send-only),
  `REPLY_TO` (contact@ridewaepride.com — Resend reply_to on every outgoing
  email so pupil replies reach the instructor's inbox).
  D1 id lives in wrangler.toml (not secret).
- **Instructor mailbox (2026-08-11)**: contact@ridewaepride.com is a
  GoDaddy-provisioned Microsoft 365 mailbox (instructor signs in at
  email.godaddy.com / Outlook). DNS on the Cloudflare zone: apex MX →
  ridewaepride-com.mail.protection.outlook.com (prio 0), apex TXT SPF
  `v=spf1 include:secureserver.net -all` (an earlier hand-typed record had
  typos — "spfl", space in secureserver.net — fixed in place), CNAME
  autodiscover → autodiscover.outlook.com, plus pre-existing TXT
  MS=ms35683938 (M365 domain verification). Resend (outgoing booking mail)
  lives entirely on the send. subdomain — no conflict; don't merge the two
  SPF records. DNS edits use the owner's email-scoped token
  (CF_EMAIL_TOKEN, pasted in-session; the deploy token cannot edit DNS).
  Site Settings `email` is set to contact@ so the public "Get in touch"
  email button shows.
- **wrangler pin**: `npx wrangler@4.28.1` — latest wrangler was broken
  2026-08-11 (depends on unpublished miniflare alpha).
- **LIVE since 2026-07-31**, at **https://ridewaepride.com** since 2026-08-14 —
  zone 2b268d6a3ed37d5dde07961cb0a928f1 on the owner's Cloudflare account
  (domain bought by the instructor at GoDaddy, nameservers moved); apex +
  www attached as Workers custom domains via the account-level
  workers/domains API (the deploy token can do this; it canNOT edit zone
  DNS). The workers.dev URL (driving-booking.harris-stockdash.workers.dev)
  still works as a fallback. D1 `driving-booking`
  id d6afe460-f234-4c9f-b168-a2ecfa18962a. Schema migrations = re-run
  schema.sql (CREATE TABLE IF NOT EXISTS only; never destructive on prod).
  Deploys via wrangler with an owner-pasted scoped token (Workers+D1 edit).
- **Pupil accounts (2026-07-31)**: email+password, PBKDF2-100k, hashed 90d
  bearer sessions (localStorage `dl-session`). NO email service by design —
  signup AND password reset require a booking ref belonging to the email as
  identity proof. Never add an email-verification dependency without owner
  sign-off, and never serve `students.notes` (instructor-private) or any
  admin payload to pupil routes.
- **Credit/passed/notes** live in D1 `students` keyed by lowercased email;
  displayed owed = gross − credit, floor 0; `/admin/pay-from-credit` is the
  atomic settle path. "Passed" only filters the default list — data is kept.
- **Admin UI conventions**: weekly series collapse to one ↻ line in Bookings
  (expand for per-week actions; confirm-all/cancel-all loop client-side over
  `/admin/booking`); Calendar tab reloads on every tab click via
  `/admin/calendar?from&to` (≤62 days, returns bookings + blocked dates).
