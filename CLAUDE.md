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
  DNS). The workers.dev URL was retired 2026-08-13 then
  **RESTORED the same day**: on 2026-08-13 the INSTRUCTOR repointed the
  domain's nameservers from Cloudflare to GoDaddy (ns15/ns16.domaincontrol)
  without consulting the owner, publishing a GoDaddy "Airo" AI site and
  taking ridewaepride.com away from this Worker (and killing the domain's
  MX, so contact@ mail stopped). The workers.dev URL is therefore the
  owner's ONLY domain-independent route to the console, developer dash and
  D1 data — do NOT redirect it again. `run_worker_first = true` still routes
  all paths through the Worker (final `env.ASSETS.fetch` fallback serves the
  static pages); only www 301s to the apex. Restoring the site = the
  instructor setting nameservers back to jobs/marjory.ns.cloudflare.com. D1 `driving-booking`
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
- **Admin accounts + two-instructor dashboards (2026-08-11)**: /admin sign-in
  is email+password (`admins` + `admin_sessions` D1 tables, same PBKDF2/90d
  pattern as pupils); creating an account (or resetting a password) requires
  the shared ADMIN_KEY in the same form — re-register with the key = password
  reset (kills that account's sessions). The RAW key alone still works as a
  bearer token everywhere (recovery + API compat) — email left blank on the
  form. **The per-instructor dashboard switcher was REMOVED 2026-08-12
  (owner request)** — the console is one joint view again. The server-side
  `?type=` scoping on /admin/summary, bookings, calendar, students, packages
  REMAINS (the UI just never sends it, except /admin/schedule which the
  Availability tab's George/Revi chips still use); legacy rows with NULL
  lesson_type count as manual. `instructor_manual`/`instructor_auto` names
  still label the availability chips + owed breakdowns.
- **Owed money is SPLIT per instructor (2026-08-11)** — they are paid
  separately. `splitOwed()` in worker.js: each lesson's owed goes to that
  lesson's type, package charges carry `charges.lesson_type` (set from the
  request's transmission; NULL on legacy rows = manual), and the pupil's
  single credit pot is applied MANUAL-FIRST, then automatic. That fixed order
  is what guarantees `owed_manual + owed_automatic === owed` — don't switch
  it to proportional without updating the tests that assert the sum. Served
  as `outstanding_manual`/`outstanding_automatic` (summary),
  `owed_manual`/`owed_automatic` on each student (scoped `owed` becomes that
  instructor's share), and `split` on student detail.
- **Per-instructor diaries (2026-08-11)**: availability, time off and clash
  checks are ALL per instructor (separate cars): `openSlots` takes
  `opts.type`, busy/clash checks compare lesson_type buckets, `/api/slots`
  takes `&type=` (the Book page refetches when the transmission toggles, and
  Move passes the lesson's own type). Weekly hours: settings key `template`
  = manual/George (also the pre-split shared one), `template_auto` =
  automatic/Revi, falling back to `template` until first edited.
  `overrides.lesson_type`: 'manual' | 'automatic' | NULL = blocks BOTH
  (legacy rows). Blocking time off auto-cancels only that instructor's
  lessons (per-id updates, not the old date-range UPDATE). The console
  Availability tab has its own always-visible George/Revi chips (the diaries
  stayed split when the dashboards were removed — separate cars).
- **Gallery (2026-08-11)**: public `#gallery` nav tab + console Gallery tab
  (both instructors). Photos stored IN D1 (`gallery` table, base64 TEXT) —
  the console shrinks to ≤1600px JPEG q0.82 client-side before upload;
  server caps ~1MB base64 and 60 photos (D1 row limit is 2MB — keep caps
  under it). Served at `/api/gallery` (list, 60s cache) and
  `/api/gallery/img/{id}` (immutable 1y cache — ids are never reused).
- **Admin UI conventions**: weekly series collapse to one ↻ line in Bookings
  (expand for per-week actions; confirm-all/cancel-all loop client-side over
  `/admin/booking`); Calendar tab reloads on every tab click via
  `/admin/calendar?from&to` (≤62 days, returns bookings + blocked dates).
- **Developer console (2026-08-12, owner-only)**: `/developer`
  (public/developer.html) — linked from NOWHERE, meta-noindex'd, deliberately
  NOT listed in robots.txt (a Disallow line would advertise the path). Gated
  by Worker secret `DEV_KEY` (owner-held, separate from the instructor
  ADMIN_KEY; stored in the session scratchpad dev-key.txt). DEV_KEY also
  passes the /admin/* gate (superset) but ADMIN_KEY does NOT open /dev/*.
  Routes: `/dev/earnings` (monthly ledger computed live from bookings+charges
  — booked, collected, manual/auto/fees/packages splits), `/dev/security`
  (last 30 security_log rows + 24h failure counts + pupil/session counts +
  admin-account list), `/dev/errors` (error_log 24h count + last 30).
  ValueTally-style logging: `secLog`/`errLog` are best-effort (waitUntil +
  try/catch — a broken log path must never break serving); security_log
  kinds: admin_auth_fail, admin_login, admin_register, dev_auth_fail,
  login_fail, signup, password_reset, canary_login. detail = route
  names/generic text only, never credentials or pupil PII. Every 401 on
  /admin/* and /dev/* logs an event. Page is THREE tabs (2026-08-12): Site
  details / Security / Earnings & accounts (instructor-accounts table with
  created/last-sign-in/session counts rides /dev/security `admins`).
  **Canary tripwire**: decoy pupil row `canary.<hex>@ridewaepride.com`
  (random hash/salt, credentials exist nowhere), self-bootstrapped by
  /dev/security; email kept in settings key 'canary' AS AN OBJECT {email} —
  getSetting object-spreads values, so scalar settings get mangled (bug hit
  once); any /auth/* attempt on it → canary_login log + ntfy (30-min flood
  cap via settings 'canaryAlert' {at}) + the same generic 401 as any wrong
  login. Excluded from the /dev pupil count. Don't "clean up" the canary
  user row, and never send test canary alerts (real ntfy topic).
  **Dev-dash analytics batch (2026-08-12)**: `audit_log` table — the /admin
  gate resolves `actor` (account email / 'admin key' / 'developer') via
  `adminActor()`, and EVERY mutating admin route calls `audit()` (same
  best-effort rule as secLog); served at /dev/audit, rendered on the
  Security tab. `traffic` table — one row per UK day, incremented on GET /
  (runs through the Worker via run_worker_first; other assets are NOT
  counted — it's homepage views only, bots included, no IPs/UAs);
  /dev/traffic joins bookings-created-per-day for conversion. /dev/pipeline
  = upcoming confirmed/pending £ + next-28-day per-instructor utilisation
  (booked min ÷ template-minus-time-off availability). /dev/pupils = new
  pupils by first-booking month, avg lessons, and the gone-quiet list
  (past lessons, nothing future, 30+ days silent, not passed/archived).
  /dev/ops = table row counts + gallery cap + live config snapshot.
  Charts are dependency-free inline SVG (`bars()` in developer.html).
  Dev-only account deletion (2026-08-12): `/dev/admin-delete` (admins row +
  sessions; the shared key still allows re-registration — rotate it for a
  real lock-out) and `/dev/user-delete` (pupil LOGIN only — users+sessions;
  bookings/charges/students records deliberately kept, they're the money
  history; canary refuses deletion). secLog kinds admin_delete (email) /
  user_delete (no PII).
