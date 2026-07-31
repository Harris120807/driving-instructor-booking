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
- Secrets: `ADMIN_KEY`, optional `NTFY_TOPIC` (instructor's own topic).
  D1 id lives in wrangler.toml (not secret).
