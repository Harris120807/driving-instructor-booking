/**
 * Driving instructor booking site — Cloudflare Worker API.
 * Static pages (public/) are served by the Worker's assets binding; anything
 * that isn't an asset lands here.
 *
 * Bindings:  DB (D1, schema.sql)
 * Secrets:   ADMIN_KEY  - bearer key for /admin/* (instructor's console)
 *            NTFY_TOPIC - optional ntfy.sh topic for instructor pushes
 *
 * All responses are JSON with CORS *; times are UK wall-clock (Europe/London).
 * Manual-transmission lessons only (owner decision 2026-07-31).
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};

const DEFAULT_CONFIG = {
  name: 'Your Driving School',
  area: 'Your town and surrounding areas',
  phone: '',
  email: '',
  hourly_rate: 44,         // £ per hour, manual; lesson price = rate × length
  hourly_rate_auto: 46,    // £ per hour, automatic
  min_duration: 60,        // shortest lesson pupils can book (minutes)
  max_duration: 240,       // longest lesson pupils can book (minutes)
  motorway_minutes: 120,   // motorway lessons are a FIXED length
  motorway_price: 0,       // £ for a motorway lesson; 0 = price at the normal rate
  notice_hours: 12,        // minimum notice to BOOK a slot
  cancel_notice_hours: 24, // cancelling closer than this to the lesson incurs the fee
  late_cancel_fee: 44,     // £ owed for a late cancellation
  horizon_days: 21,        // how far ahead pupils can book
  instructor_manual: 'George',  // manual lessons belong to this instructor's dash
  instructor_auto: 'Revi',      // automatic lessons belong to this one's
};

const DEFAULT_TEMPLATE = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '13:00' },
  sun: null,
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DURATIONS = [30, 60, 90, 120, 150, 180, 210, 240]; // 30-min steps; pupil-facing
// range is bounded by config min_duration/max_duration

function durationBounds(config) {
  let lo = DURATIONS.includes(config.min_duration) ? config.min_duration : 60;
  let hi = DURATIONS.includes(config.max_duration) ? config.max_duration : 240;
  if (lo > hi) [lo, hi] = [hi, lo];
  return [lo, hi];
}
const SLOT_STEP_MIN = 30;   // start-time grid
const MAX_REPEAT_WEEKS = 12;

// Lesson price scales with length from the per-transmission hourly rate
// (old configs stored a prices map — its 1-hour entry doubles as the rate)
function lessonPrice(config, durationMin, type = 'manual') {
  let rate;
  if (type === 'automatic') {
    rate = Number.isFinite(config.hourly_rate_auto) ? config.hourly_rate_auto
      : (Number.isFinite(config.hourly_rate) ? config.hourly_rate + 2 : 46);
  } else {
    rate = Number.isFinite(config.hourly_rate) ? config.hourly_rate
      : (config.prices?.[60] ?? 44);
  }
  return Math.round(rate * durationMin / 60 * 100) / 100;
}

const LESSON_TYPES = ['manual', 'automatic'];

// Motorway lessons are a fixed-length product: the pupil picks only a slot
function motorwayMinutes(config) {
  const m = parseInt(config.motorway_minutes, 10);
  return DURATIONS.includes(m) ? m : 120;
}
function motorwayPrice(config, type) {
  const p = parseFloat(config.motorway_price);
  return Number.isFinite(p) && p > 0 ? p : lessonPrice(config, motorwayMinutes(config), type);
}

// Fixed packages pupils can request; prices are instructor-editable (config)
function packageInfo(config) {
  const p = (v, d) => Number.isFinite(parseFloat(v)) && parseFloat(v) >= 0 ? parseFloat(v) : d;
  return {
    beginner: { label: 'Beginner Package', minutes: 300, price: p(config.pkg_beginner_price, 190) },
    mock: { label: 'Mock Test', minutes: 120, price: p(config.pkg_mock_price, 95) },
  };
}

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...extra },
  });
}

async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

const bytesToHex = a => [...a].map(b => b.toString(16).padStart(2, '0')).join('');
const randomHex = n => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2Hex(password, saltHex) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

// Pupil session from the Authorization bearer token; null if absent/expired
async function sessionEmail(req, env) {
  const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!/^[0-9a-f]{64}$/.test(tok)) return null;
  const row = await env.DB.prepare('SELECT email, expires FROM sessions WHERE token_hash = ?')
    .bind(await sha256Hex(tok)).first();
  if (!row || row.expires < Math.floor(Date.now() / 1000)) return null;
  return row.email;
}

async function newSession(env, email) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO sessions (token_hash, email, expires) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), email, Math.floor(Date.now() / 1000) + 90 * 86400).run();
  return token;
}

// Admin auth: the raw ADMIN_KEY as a bearer token, or an admin-account
// session token (created via /admin/auth/* with the key as first-time proof)
async function isAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  if (!key || !env.ADMIN_KEY) return false;
  if ((await sha256Hex(key)) === (await sha256Hex(env.ADMIN_KEY))) return true;
  if (!/^[0-9a-f]{64}$/.test(key)) return false;
  const row = await env.DB.prepare('SELECT email, expires FROM admin_sessions WHERE token_hash = ?')
    .bind(await sha256Hex(key)).first();
  return !!row && row.expires >= Math.floor(Date.now() / 1000);
}

// Developer key (owner-held, separate from the instructor ADMIN_KEY) —
// unlocks /dev/* AND counts as admin so the developer console can read
// everything the instructor console can.
async function isDev(req, env) {
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key || !env.DEV_KEY) return false;
  return (await sha256Hex(key)) === (await sha256Hex(env.DEV_KEY));
}

// Best-effort logging — a broken log path must NEVER break serving.
// detail is route names / generic text only, never credentials or pupil PII.
function secLog(env, ctx, kind, detail) {
  try {
    ctx.waitUntil(env.DB.prepare('INSERT INTO security_log (at, kind, detail) VALUES (?, ?, ?)')
      .bind(Math.floor(Date.now() / 1000), kind, String(detail || '').slice(0, 200)).run()
      .catch(() => {}));
  } catch {}
}
// Who is acting on an /admin route: an admin account email, the raw shared
// key ('admin key'), or the owner's dev key ('developer'); null = not allowed
async function adminActor(req, env) {
  const key = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!key) return null;
  if (env.ADMIN_KEY && (await sha256Hex(key)) === (await sha256Hex(env.ADMIN_KEY))) return 'admin key';
  if (env.DEV_KEY && (await sha256Hex(key)) === (await sha256Hex(env.DEV_KEY))) return 'developer';
  if (/^[0-9a-f]{64}$/.test(key)) {
    const row = await env.DB.prepare('SELECT email, expires FROM admin_sessions WHERE token_hash = ?')
      .bind(await sha256Hex(key)).first();
    if (row && row.expires >= Math.floor(Date.now() / 1000)) return row.email;
  }
  return null;
}

// Console action audit — same best-effort rule as secLog
function audit(env, ctx, actor, action, detail) {
  try {
    ctx.waitUntil(env.DB.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .bind(Math.floor(Date.now() / 1000), actor, action, String(detail || '').slice(0, 300)).run()
      .catch(() => {}));
  } catch {}
}

function errLog(env, ctx, route, detail) {
  try {
    ctx.waitUntil(env.DB.prepare('INSERT INTO error_log (at, route, detail) VALUES (?, ?, ?)')
      .bind(Math.floor(Date.now() / 1000), String(route).slice(0, 100), String(detail || '').slice(0, 500)).run()
      .catch(() => {}));
  } catch {}
}

// Canary tripwire (ValueTally pattern): a decoy pupil account whose
// credentials exist NOWHERE — any attempt to log into it, sign it up or
// reset it means someone is using leaked database contents. Detection only:
// the request gets the normal generic 401, it is never blocked differently.
// NOTE: getSetting object-spreads stored values, so canary state is stored
// as objects ({email}, {at}) — never as bare strings/numbers.
async function canaryEmailOf(env) {
  const c = await getSetting(env, 'canary', null);
  if (c && c.email) return c.email;
  const em = `canary.${randomHex(6)}@ridewaepride.com`;
  await env.DB.prepare('INSERT INTO users (email, pw_hash, salt, created_at) VALUES (?, ?, ?, ?)')
    .bind(em, randomHex(32), randomHex(16), Math.floor(Date.now() / 1000)).run();
  await putSetting(env, 'canary', { email: em });
  return em;
}

async function canaryTripped(env, ctx, what) {
  secLog(env, ctx, 'canary_login', what);
  try {
    // one push per 30 min at most (the log keeps every event)
    const last = (await getSetting(env, 'canaryAlert', { at: 0 })).at || 0;
    const now = Math.floor(Date.now() / 1000);
    if (now - last >= 1800) {
      await putSetting(env, 'canaryAlert', { at: now });
      notify(env, ctx, 'SECURITY ALERT — decoy account touched',
        'Someone tried to use the canary account. Its details exist only inside the ' +
        'database, so this means leaked data. Check ridewaepride.com/developer.');
    }
  } catch {}
}

async function newAdminSession(env, email) {
  const token = randomHex(32);
  await env.DB.prepare('INSERT INTO admin_sessions (token_hash, email, expires) VALUES (?, ?, ?)')
    .bind(await sha256Hex(token), email, Math.floor(Date.now() / 1000) + 90 * 86400).run();
  return token;
}

// Instructor scoping: manual lessons = George's dash, automatic = Revi's.
// null scope = the joint dashboard. Legacy rows with no lesson_type count
// as manual.
function scopeOf(url) {
  const t = url.searchParams.get('type');
  return t === 'manual' || t === 'automatic' ? t : null;
}
const inScope = (t, r) =>
  !t || (t === 'automatic' ? r.lesson_type === 'automatic' : r.lesson_type !== 'automatic');

// --- UK local time helpers -------------------------------------------------

function ukNowParts() {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date()).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    minutes: parseInt(p.hour, 10) * 60 + parseInt(p.minute, 10),
  };
}

function isoDayKey(dateStr) {
  return DAY_KEYS[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

// Minutes from now (UK) until a lesson starts; negative = already started/past
function minsUntil(now, date, time) {
  return daysBetween(now.date, date) * 1440 + toMin(time) - now.minutes;
}

// --- settings --------------------------------------------------------------

async function getSetting(env, key, fallback) {
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return { ...fallback, ...JSON.parse(row.value) }; } catch { return fallback; }
}

async function putSetting(env, key, obj) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).bind(key, JSON.stringify(obj)).run();
}

// --- slot computation ------------------------------------------------------

// type: 'manual' | 'automatic' | null (null = dates blocked for anyone).
// Overrides with NULL lesson_type (incl. all pre-2026-08-11 rows) block BOTH
// instructors; typed ones block only their own diary.
async function blockedDates(env, from, to, type = null) {
  const set = new Set();
  const { results } = await env.DB.prepare(
    'SELECT start_date, end_date, lesson_type FROM overrides WHERE start_date <= ? AND end_date >= ?'
  ).bind(to, from).all();
  for (const r of results) {
    if (type && r.lesson_type && r.lesson_type !== type) continue;
    const s = r.start_date < from ? from : r.start_date;
    const e = r.end_date > to ? to : r.end_date;
    for (let d = s; d <= e; d = addDays(d, 1)) set.add(d);
  }
  return set;
}

// Each instructor has their own weekly hours: 'template' is the manual
// (George) diary — also the pre-split shared one — and 'template_auto' is the
// automatic (Revi) diary, falling back to the manual template until it's
// edited so the split changes nothing by itself.
async function templateFor(env, type) {
  if (type === 'automatic') {
    const t = await getSetting(env, 'template_auto', null);
    if (t) return t;
  }
  return getSetting(env, 'template', DEFAULT_TEMPLATE);
}

// opts.noHorizon: used for recurring weeks beyond the public booking horizon.
// opts.type ('manual' | 'automatic'): whose diary — the two instructors teach
// in separate cars, so slots, time off and clashes are all per instructor.
async function openSlots(env, from, to, durationMin, opts = {}) {
  const type = opts.type === 'automatic' ? 'automatic' : 'manual';
  const config = await getSetting(env, 'config', DEFAULT_CONFIG);
  const template = await templateFor(env, type);
  const now = ukNowParts();

  if (from < now.date) from = now.date;
  if (!opts.noHorizon) {
    const horizonEnd = addDays(now.date, config.horizon_days);
    if (to > horizonEnd) to = horizonEnd;
  }
  if (from > to) return {};

  const blocked = await blockedDates(env, from, to, type);

  const busy = {}; // date -> [{start, end}] minutes — this instructor's lessons only
  for (const r of (await env.DB.prepare(
    "SELECT date, time, duration_min, lesson_type FROM bookings WHERE date >= ? AND date <= ? AND status != 'cancelled'"
  ).bind(from, to).all()).results) {
    if ((r.lesson_type === 'automatic') !== (type === 'automatic')) continue;
    (busy[r.date] ||= []).push({ start: toMin(r.time), end: toMin(r.time) + r.duration_min });
  }

  const out = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (blocked.has(d)) continue;
    const day = template[isoDayKey(d)];
    if (!day) continue;
    const open = toMin(day.start), close = toMin(day.end);
    // Earliest bookable start on this date: (now + booking notice) projected
    // into day-of-date minutes; 0 once the date is far enough out
    const noticeCutoff = Math.max(0,
      now.minutes + config.notice_hours * 60 - daysBetween(now.date, d) * 1440);
    const slots = [];
    for (let s = open; s + durationMin <= close; s += SLOT_STEP_MIN) {
      if (s < noticeCutoff) continue;
      const e = s + durationMin;
      if ((busy[d] || []).some(b => s < b.end && e > b.start)) continue;
      slots.push(toHM(s));
    }
    if (slots.length) out[d] = slots;
  }
  return out;
}

// --- rate limiting ---------------------------------------------------------

async function rateLimited(env, bucket, max, windowSec) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.prepare('DELETE FROM attempts WHERE bucket = ? AND at < ?').bind(bucket, now - windowSec).run();
  const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM attempts WHERE bucket = ?').bind(bucket).first();
  if (c >= max) return true;
  await env.DB.prepare('INSERT INTO attempts (bucket, at) VALUES (?, ?)').bind(bucket, now).run();
  return false;
}

// --- notifications ---------------------------------------------------------

function notify(env, ctx, title, body) {
  if (!env.NTFY_TOPIC) return;
  ctx.waitUntil(fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
    method: 'POST',
    headers: { Title: title, Tags: 'car' },
    body,
  }).catch(() => {}));
}

// --- pupil notifications (email/SMS) ---------------------------------------
// Both channels are optional and activate when their secrets exist:
//   email: RESEND_API_KEY + MAIL_FROM (e.g. "Driving School <lessons@domain>")
//   SMS:   TWILIO_SID + TWILIO_TOKEN + TWILIO_FROM (E.164 or UK alpha sender)
// Missing secrets = channel silently skipped; a send failure never breaks the
// request that triggered it.

function ukE164(phone) {
  const p = String(phone || '').replace(/[^\d+]/g, '');
  if (p.startsWith('+')) return /^\+\d{10,14}$/.test(p) ? p : null;
  if (p.startsWith('07') && p.length === 11) return '+44' + p.slice(1);
  if (p.startsWith('447') && p.length === 12) return '+' + p;
  return null;
}

function prettyDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-GB',
    { weekday: 'long', day: 'numeric', month: 'long' });
}

function sendEmail(env, ctx, to, subject, text) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) return;
  ctx.waitUntil(fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text,
      ...(env.REPLY_TO ? { reply_to: env.REPLY_TO } : {}) }),
  }).catch(() => {}));
}

function sendSms(env, ctx, phone, text) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return;
  const to = ukE164(phone);
  if (!to) return;
  ctx.waitUntil(fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ From: env.TWILIO_FROM, To: to, Body: text }),
  }).catch(() => {}));
}

// One message per pupil, however many lessons were cancelled in the action
async function notifyCancelledPupils(env, ctx, rows, origin) {
  if (!rows.length) return;
  const config = await getSetting(env, 'config', DEFAULT_CONFIG);
  const byEmail = new Map();
  for (const r of rows) {
    if (!byEmail.has(r.email)) byEmail.set(r.email, []);
    byEmail.get(r.email).push(r);
  }
  const signoff = `${config.name}${config.phone ? ' · ' + config.phone : ''}`;
  for (const list of byEmail.values()) {
    const first = list[0];
    const lines = list.map(r => `${prettyDate(r.date)} at ${r.time}`);
    const subject = list.length === 1
      ? `Your driving lesson on ${lines[0]} has been cancelled`
      : `${list.length} of your driving lessons have been cancelled`;
    const body =
      `Hi ${String(first.name).split(' ')[0]},\n\n` +
      `Sorry — your instructor has had to cancel ${list.length === 1 ? 'your lesson' : 'these lessons'}:\n\n` +
      lines.map(l => `  • ${l}`).join('\n') + '\n\n' +
      `You won't be charged for ${list.length === 1 ? 'it' : 'them'}. ` +
      `To rebook, visit ${origin} — or just reply to your instructor directly.\n\n${signoff}`;
    sendEmail(env, ctx, first.email, subject, body);
    sendSms(env, ctx, first.phone,
      list.length === 1
        ? `Sorry — your driving lesson on ${lines[0]} has been cancelled (no charge). Rebook: ${origin} — ${signoff}`
        : `Sorry — ${list.length} of your driving lessons have been cancelled (no charge): ${lines.join('; ')}. Rebook: ${origin} — ${signoff}`);
  }
}

// --- money -----------------------------------------------------------------

function lessonPast(now, b) {
  return minsUntil(now, b.date, b.time) <= 0;
}

// What this booking currently adds to the pupil's "money owed"
function owedOf(now, b) {
  if (b.paid) return 0;
  if (b.status === 'cancelled') return b.cancelled_by === 'student' ? (b.fee || 0) : 0;
  if (b.status === 'confirmed' && lessonPast(now, b)) return b.price;
  return 0; // upcoming, or pending lessons that never got confirmed
}

function upcomingCostOf(now, b) {
  return (b.status !== 'cancelled' && !lessonPast(now, b)) ? b.price : 0;
}

// The two instructors are paid separately, so a pupil's owed money is split by
// which instructor earned it: manual lessons (and manual package charges) to
// one, automatic to the other. Credit is a single per-pupil pot, so it is
// applied manual-first, then automatic — a fixed order that guarantees the two
// instructor figures always add up to the pupil's joint owed.
function splitOwed(now, rows, charges, credit) {
  const gross = { manual: 0, automatic: 0 };
  for (const r of rows) gross[r.lesson_type === 'automatic' ? 'automatic' : 'manual'] += owedOf(now, r);
  for (const ch of charges || [])
    if (!ch.paid) gross[ch.lesson_type === 'automatic' ? 'automatic' : 'manual'] += ch.amount;
  let left = credit || 0;
  const useManual = Math.min(left, gross.manual);
  left -= useManual;
  const useAuto = Math.min(left, gross.automatic);
  return {
    gross_manual: gross.manual, gross_automatic: gross.automatic,
    owed_manual: Math.max(0, gross.manual - useManual),
    owed_automatic: Math.max(0, gross.automatic - useAuto),
  };
}

async function studentMeta(env, email) {
  return (await env.DB.prepare('SELECT * FROM students WHERE email = ?').bind(email).first())
    || { email, notes: '', passed: 0, credit: 0, credit_min: 0, credit_mock: 0, archived: 0 };
}

async function putStudentMeta(env, m) {
  await env.DB.prepare(
    `INSERT INTO students (email, notes, passed, credit, credit_min, credit_mock, archived, test_date, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET notes = excluded.notes, passed = excluded.passed,
       credit = excluded.credit, credit_min = excluded.credit_min, credit_mock = excluded.credit_mock,
       archived = excluded.archived, test_date = excluded.test_date, updated_at = excluded.updated_at`
  ).bind(m.email, m.notes || '', m.passed ? 1 : 0, m.credit || 0, m.credit_min || 0,
    m.credit_mock || 0, m.archived ? 1 : 0, m.test_date || null, Math.floor(Date.now() / 1000)).run();
}

// Full account picture for one pupil (shared by /me/lessons and the console)
async function accountFor(env, email) {
  const rows = (await env.DB.prepare(
    'SELECT * FROM bookings WHERE email = ? ORDER BY date, time').bind(email).all()).results;
  const charges = (await env.DB.prepare(
    'SELECT * FROM charges WHERE email = ? ORDER BY created_at').bind(email).all()).results;
  const meta = await studentMeta(env, email);
  const now = ukNowParts();
  let gross = 0, upcoming = 0;
  const lessons = rows.map(r => {
    gross += owedOf(now, r);
    upcoming += upcomingCostOf(now, r);
    return { ...publicLesson(r), past: lessonPast(now, r) };
  });
  for (const ch of charges) if (!ch.paid) gross += ch.amount;
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  return {
    name: lastRow ? lastRow.name : '',
    postcode: lastRow ? lastRow.postcode : '', house: lastRow ? (lastRow.house || '') : '',
    lessons, gross_owed: gross, credit: meta.credit || 0, credit_min: meta.credit_min || 0,
    credit_mock: meta.credit_mock || 0,
    charges: charges.map(ch => ({ id: ch.id, label: ch.label, amount: ch.amount, paid: !!ch.paid })),
    owed: Math.max(0, gross - (meta.credit || 0)),
    upcoming_cost: upcoming, passed: !!meta.passed,
    test_date: meta.test_date || null, meta,
  };
}

// --- validation ------------------------------------------------------------

const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_TIME = /^\d{2}:\d{2}$/;
const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RE_UK_POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const RE_PHONE = /^[\d+\s()-]{7,20}$/;

function newRef() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let r = '';
  const rnd = crypto.getRandomValues(new Uint8Array(6));
  for (const b of rnd) r += chars[b % chars.length];
  return r;
}

const publicLesson = b => ({
  ref: b.ref, series: b.series, date: b.date, time: b.time,
  duration_min: b.duration_min, price: b.price, status: b.status,
  lesson_type: b.lesson_type || 'manual', motorway: !!b.motorway, mock: !!b.mock,
  cancelled_by: b.cancelled_by, fee: b.fee, paid: !!b.paid,
});

// --- routes ----------------------------------------------------------------

export default {
  async fetch(req, env, ctx) {
    {
      // Canonical host: www 301s to the apex (SEO). The workers.dev URL is
      // deliberately NOT redirected (restored 2026-08-13): it is the owner's
      // direct route to the console, developer dash and database that does
      // not depend on the domain's nameservers, which the instructor
      // controls at their registrar.
      const u = new URL(req.url);
      if (u.hostname === 'www.ridewaepride.com')
        return Response.redirect('https://ridewaepride.com' + u.pathname + u.search, 301);
      // "/" is routed through the Worker (run_worker_first) for the redirect
      // above — count the page view (anonymous: one number per UK day, no
      // IPs or user agents) and hand back to the static assets
      if (u.pathname === '/' && req.method === 'GET') {
        try {
          ctx.waitUntil(env.DB.prepare(
            'INSERT INTO traffic (day, views) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET views = views + 1'
          ).bind(ukNowParts().date).run().catch(() => {}));
        } catch {}
      }
      if (u.pathname === '/' && env.ASSETS) return env.ASSETS.fetch(req);
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ---- public ----
      if (path === '/api/config' && req.method === 'GET') {
        const c = await getSetting(env, 'config', DEFAULT_CONFIG);
        const [minD, maxD] = durationBounds(c);
        return json({
          name: c.name, area: c.area, phone: c.phone, email: c.email,
          hourly_rate: lessonPrice(c, 60), hourly_rate_auto: lessonPrice(c, 60, 'automatic'),
          min_duration: minD, max_duration: maxD,
          prices: {
            manual: Object.fromEntries(DURATIONS.map(d => [d, lessonPrice(c, d)])),
            automatic: Object.fromEntries(DURATIONS.map(d => [d, lessonPrice(c, d, 'automatic')])),
          },
          notice_hours: c.notice_hours,
          cancel_notice_hours: c.cancel_notice_hours, late_cancel_fee: c.late_cancel_fee,
          horizon_days: c.horizon_days, durations: DURATIONS, max_repeat_weeks: MAX_REPEAT_WEEKS,
          packages: packageInfo(c),
          motorway: {
            minutes: motorwayMinutes(c),
            price: { manual: motorwayPrice(c, 'manual'), automatic: motorwayPrice(c, 'automatic') },
          },
        }, 200, { 'Cache-Control': 'public, max-age=300' });
      }

      // Package request (Beginner / Mock Test) — reviewed by the instructor
      if (path === '/api/package' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (await rateLimited(env, `book:${ip}`, 5, 3600))
          return json({ error: 'Too many requests — please try again later.' }, 429);
        const b = await readBody(req);
        const config = await getSetting(env, 'config', DEFAULT_CONFIG);
        const pkg = packageInfo(config)[b?.package];
        if (!pkg) return json({ error: 'bad request' }, 400);
        const sessEmail = await sessionEmail(req, env);
        let name = String(b.name || '').trim(), email, phone = String(b.phone || '').trim();
        if (sessEmail) {
          email = sessEmail;
          if (!name || !phone) {
            const prev = await env.DB.prepare(
              'SELECT name, phone FROM bookings WHERE email = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(email).first();
            name = name || prev?.name || '';
            phone = phone || prev?.phone || '';
          }
        } else {
          email = String(b.email || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email) || email.length > 200) return json({ error: 'Please give a valid email.' }, 400);
        }
        if (name.length < 2 || name.length > 100) return json({ error: 'Please give your name.' }, 400);
        if (!RE_PHONE.test(phone)) return json({ error: 'Please give a valid phone number.' }, 400);
        const postcode = String(b.postcode || '').trim().toUpperCase().slice(0, 10);
        const house = String(b.house || '').trim().slice(0, 30);
        const notes = String(b.notes || '').slice(0, 500);
        const pkType = LESSON_TYPES.includes(b.lesson_type) ? b.lesson_type : 'manual';
        await env.DB.prepare(
          `INSERT INTO package_requests (package, lesson_type, name, email, phone, postcode, house, notes, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(b.package, pkType, name, email.toLowerCase(), phone, postcode, house, notes,
          Math.floor(Date.now() / 1000)).run();
        notify(env, ctx, `Package request: ${pkg.label}`,
          `${name} — ${phone} · ${pkType}\n£${pkg.price} · review in the console`);
        return json({ ok: true, package: pkg.label });
      }

      // Public gallery: photo list + the images themselves (stored in D1;
      // the console shrinks photos client-side before upload)
      if (path === '/api/gallery' && req.method === 'GET') {
        const rows = (await env.DB.prepare(
          'SELECT id, caption, created_at FROM gallery ORDER BY created_at DESC, id DESC LIMIT 100'
        ).all()).results;
        return json({ photos: rows }, 200, { 'Cache-Control': 'public, max-age=60' });
      }

      if (path.startsWith('/api/gallery/img/') && req.method === 'GET') {
        const imgId = parseInt(path.slice('/api/gallery/img/'.length), 10);
        if (!Number.isInteger(imgId)) return json({ error: 'bad request' }, 400);
        const row = await env.DB.prepare('SELECT mime, data FROM gallery WHERE id = ?').bind(imgId).first();
        if (!row) return new Response('not found', { status: 404 });
        const bin = Uint8Array.from(atob(row.data), c => c.charCodeAt(0));
        return new Response(bin, { headers: {
          'Content-Type': row.mime,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*',
        } });
      }

      if (path === '/api/slots' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const dur = parseInt(url.searchParams.get('duration') || '60', 10);
        if (!RE_DATE.test(from || '') || !RE_DATE.test(to || '') || !DURATIONS.includes(dur))
          return json({ error: 'bad params' }, 400);
        const cfgS = await getSetting(env, 'config', DEFAULT_CONFIG);
        const [loS, hiS] = durationBounds(cfgS);
        // the fixed motorway length is always queryable, even outside the range
        if ((dur < loS || dur > hiS) && dur !== motorwayMinutes(cfgS))
          return json({ error: 'bad params' }, 400);
        const slotType = url.searchParams.get('type') === 'automatic' ? 'automatic' : 'manual';
        return json({ slots: await openSlots(env, from, to, dur, { type: slotType }) }, 200,
          { 'Cache-Control': 'public, max-age=60' });
      }

      if (path === '/api/book' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (await rateLimited(env, `book:${ip}`, 5, 3600))
          return json({ error: 'Too many booking attempts — please try again later.' }, 429);

        const b = await readBody(req);
        if (!b) return json({ error: 'bad request' }, 400);
        const { date, time } = b;
        const notes = String(b.notes || '').slice(0, 500);
        const repeatWeeks = Math.min(MAX_REPEAT_WEEKS, Math.max(1, parseInt(b.repeat_weeks, 10) || 1));

        if (!RE_DATE.test(date || '') || !RE_TIME.test(time || '')) return json({ error: 'Invalid slot.' }, 400);
        const lessonType = LESSON_TYPES.includes(b.lesson_type) ? b.lesson_type : 'manual';
        // Motorway lessons and mock tests are fixed-length products — their
        // duration and price come from config, never from the client
        const cfgB = await getSetting(env, 'config', DEFAULT_CONFIG);
        const mock = b.mock ? 1 : 0;
        const motorway = (!mock && b.motorway) ? 1 : 0;
        const duration = mock ? packageInfo(cfgB).mock.minutes
          : motorway ? motorwayMinutes(cfgB) : parseInt(b.duration, 10);
        if (!DURATIONS.includes(duration)) return json({ error: 'Invalid duration.' }, 400);
        if (!RE_UK_POSTCODE.test(b.postcode || '')) return json({ error: 'Please give a valid UK pickup postcode.' }, 400);
        const house = String(b.house || '').trim().slice(0, 30);
        if (!house) return json({ error: 'Please give your house number or name.' }, 400);

        // Signed-in pupils book against their account: email comes from the
        // session and name/phone fall back to their latest booking
        const sessEmail = await sessionEmail(req, env);
        let bkName = String(b.name || '').trim(), bkEmail, bkPhone = String(b.phone || '').trim();
        if (sessEmail) {
          bkEmail = sessEmail;
          if (!bkName || !bkPhone) {
            const prev = await env.DB.prepare(
              'SELECT name, phone FROM bookings WHERE email = ? ORDER BY created_at DESC LIMIT 1'
            ).bind(bkEmail).first();
            bkName = bkName || prev?.name || '';
            bkPhone = bkPhone || prev?.phone || '';
          }
        } else {
          bkEmail = String(b.email || '').trim();
          if (!RE_EMAIL.test(bkEmail) || bkEmail.length > 200) return json({ error: 'Please give a valid email.' }, 400);
        }
        if (bkName.length < 2 || bkName.length > 100) return json({ error: 'Please give your name.' }, 400);
        if (!RE_PHONE.test(bkPhone)) return json({ error: 'Please give a valid phone number.' }, 400);

        const config = cfgB;
        const [loB, hiB] = durationBounds(config);
        if (!motorway && !mock && (duration < loB || duration > hiB))
          return json({ error: 'Invalid duration.' }, 400);

        // First lesson must be a genuinely open slot (notice + horizon enforced)
        const open = await openSlots(env, date, date, duration, { type: lessonType });
        if (!(open[date] || []).includes(time))
          return json({ error: 'That slot is no longer available — please pick another.' }, 409);

        const price = mock ? packageInfo(config).mock.price
          : motorway ? motorwayPrice(config, lessonType)
          : lessonPrice(config, duration, lessonType);
        const name = bkName, email = bkEmail.toLowerCase();
        const phone = bkPhone, postcode = String(b.postcode).trim().toUpperCase();
        const series = repeatWeeks > 1 ? newRef() : null;
        const nowSec = Math.floor(Date.now() / 1000);

        const booked = [], skipped = [];
        for (let w = 0; w < repeatWeeks; w++) {
          const d = addDays(date, w * 7);
          if (w > 0) {
            // Later weeks: same checks minus the horizon (that's the point of recurring)
            const openW = await openSlots(env, d, d, duration, { noHorizon: true, type: lessonType });
            if (!(openW[d] || []).includes(time)) { skipped.push(d); continue; }
          }
          const ref = newRef();
          await env.DB.prepare(
            `INSERT INTO bookings (ref, series, date, time, duration_min, price, lesson_type, motorway, mock, name, email, phone, postcode, house, notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(ref, series, d, time, duration, price, lessonType, motorway, mock, name, email, phone, postcode, house, notes, nowSec).run();
          booked.push({ date: d, ref });
        }

        notify(env, ctx, repeatWeeks > 1 ? `New weekly lesson request (${booked.length}×)` : 'New lesson request',
          `${date} ${time} (${duration} min, ${lessonType}${motorway ? ', motorway' : ''}${mock ? ', MOCK TEST' : ''}${repeatWeeks > 1 ? `, weekly ×${booked.length}` : ''})\n` +
          `${name} — ${house} ${postcode}\nRef ${booked[0].ref}${skipped.length ? `\nSkipped (unavailable): ${skipped.join(', ')}` : ''}`);

        return json({
          ok: true, ref: booked[0].ref, series, status: 'pending',
          booked, skipped, price_each: price, total: price * booked.length,
        });
      }

      // ---- pupil auth ----
      // No email service on this project, so a booking reference is the proof
      // of identity for signup and password reset (every pupil gets one).
      if ((path === '/auth/signup' || path === '/auth/login' || path === '/auth/reset') && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (await rateLimited(env, `auth:${ip}`, 20, 3600))
          return json({ error: 'Too many attempts — please try again later.' }, 429);
        const b = await readBody(req);
        const email = String(b?.email || '').trim().toLowerCase();
        const password = String(b?.password || '');
        if (!RE_EMAIL.test(email)) return json({ error: 'Please give a valid email.' }, 400);

        // Canary: any auth attempt against the decoy account trips the alarm
        // but is answered exactly like any wrong login (no tell)
        if (email === (await getSetting(env, 'canary', { email: null })).email) {
          await canaryTripped(env, ctx, path);
          return json({ error: 'Wrong email or password.' }, 401);
        }

        if (path === '/auth/login') {
          const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
          if (!u || (await pbkdf2Hex(password, u.salt)) !== u.pw_hash) {
            secLog(env, ctx, 'login_fail', '');
            return json({ error: 'Wrong email or password.' }, 401);
          }
          return json({ ok: true, token: await newSession(env, email) });
        }

        // signup + reset both verify a booking ref belonging to this email
        if (password.length < 8 || password.length > 200)
          return json({ error: 'Password must be at least 8 characters.' }, 400);
        const ref = String(b?.ref || '').trim().toUpperCase();
        const proof = await env.DB.prepare(
          'SELECT id FROM bookings WHERE ref = ? AND email = ?').bind(ref, email).first();
        if (!proof) return json({ error: 'No booking found for that reference and email.' }, 404);

        const salt = randomHex(16);
        const hash = await pbkdf2Hex(password, salt);
        if (path === '/auth/signup') {
          const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
          if (existing) return json({ error: 'An account already exists for this email — sign in instead.' }, 409);
          await env.DB.prepare('INSERT INTO users (email, pw_hash, salt, created_at) VALUES (?, ?, ?, ?)')
            .bind(email, hash, salt, Math.floor(Date.now() / 1000)).run();
          secLog(env, ctx, 'signup', '');
        } else { // reset: replace password, sign out everywhere
          secLog(env, ctx, 'password_reset', '');
          const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
          if (!existing) return json({ error: 'No account for this email — create one instead.' }, 404);
          await env.DB.prepare('UPDATE users SET pw_hash = ?, salt = ? WHERE email = ?')
            .bind(hash, salt, email).run();
          await env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email).run();
        }
        return json({ ok: true, token: await newSession(env, email) });
      }

      if (path === '/auth/logout' && req.method === 'POST') {
        const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (/^[0-9a-f]{64}$/.test(tok))
          await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256Hex(tok)).run();
        return json({ ok: true });
      }

      // ---- pupil portal (session-gated) ----
      if (path.startsWith('/me/')) {
        const email = await sessionEmail(req, env);
        if (!email) return json({ error: 'unauthorized' }, 401);

        if (path === '/me/lessons' && req.method === 'GET') {
          const acc = await accountFor(env, email);
          const config = await getSetting(env, 'config', DEFAULT_CONFIG);
          return json({
            email, name: acc.name, postcode: acc.postcode, house: acc.house,
            lessons: acc.lessons, charges: acc.charges, credit_min: acc.credit_min,
            credit_mock: acc.credit_mock,
            owed: acc.owed, gross_owed: acc.gross_owed, credit: acc.credit,
            upcoming_cost: acc.upcoming_cost, passed: acc.passed, test_date: acc.test_date,
            cancel_notice_hours: config.cancel_notice_hours, late_cancel_fee: config.late_cancel_fee,
          });
        }

        if (path === '/me/test-date' && req.method === 'POST') {
          const b = await readBody(req);
          const td = b?.date ? String(b.date) : null;
          if (td && !RE_DATE.test(td)) return json({ error: 'bad date' }, 400);
          const m = await studentMeta(env, email);
          m.test_date = td;
          await putStudentMeta(env, { ...m, email });
          return json({ ok: true, test_date: td });
        }

        // Move a lesson to a new open slot. The original becomes a student
        // cancellation (late fee applies if inside the notice window) and the
        // lesson re-books as a fresh pending request the instructor confirms.
        if (path === '/me/reschedule' && req.method === 'POST') {
          const b = await readBody(req);
          const ref = String(b?.ref || '').trim().toUpperCase();
          const nd = b?.date, nt = b?.time;
          if (!ref || !RE_DATE.test(nd || '') || !RE_TIME.test(nt || '')) return json({ error: 'bad request' }, 400);
          const row = await env.DB.prepare(
            'SELECT * FROM bookings WHERE ref = ? AND email = ?').bind(ref, email).first();
          if (!row) return json({ error: 'No such lesson on your account.' }, 404);
          if (row.status === 'cancelled') return json({ error: 'That lesson is cancelled — book a new one instead.' }, 409);
          const now = ukNowParts();
          if (lessonPast(now, row)) return json({ error: 'That lesson has already taken place.' }, 409);
          const open = await openSlots(env, nd, nd, row.duration_min,
            { type: row.lesson_type === 'automatic' ? 'automatic' : 'manual' });
          if (!(open[nd] || []).includes(nt))
            return json({ error: 'That new time is not available — pick another.' }, 409);

          const config = await getSetting(env, 'config', DEFAULT_CONFIG);
          const late = minsUntil(now, row.date, row.time) < config.cancel_notice_hours * 60;
          const fee = late ? config.late_cancel_fee : 0;
          await env.DB.prepare(
            "UPDATE bookings SET status = 'cancelled', cancelled_by = 'student', fee = ?, paid = 0 WHERE id = ?"
          ).bind(fee, row.id).run();
          const nref = newRef();
          await env.DB.prepare(
            `INSERT INTO bookings (ref, series, date, time, duration_min, price, lesson_type, motorway, mock, name, email, phone, postcode, house, notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(nref, null, nd, nt, row.duration_min,
            lessonPrice(config, row.duration_min, row.lesson_type || 'manual'),
            row.lesson_type || 'manual', row.motorway || 0, row.mock || 0,
            row.name, row.email, row.phone, row.postcode, row.house || '', row.notes || '',
            Math.floor(Date.now() / 1000)).run();
          notify(env, ctx, late ? 'Lesson moved by pupil (late)' : 'Lesson moved by pupil',
            `${row.date} ${row.time} → ${nd} ${nt}\n${row.name}` +
            (late ? `\nLate fee £${fee} added for the original slot` : ''));
          return json({ ok: true, ref: nref, late, fee });
        }

        if (path === '/me/cancel' && req.method === 'POST') {
          const b = await readBody(req);
          const ref = String(b?.ref || '').trim().toUpperCase();
          if (!ref) return json({ error: 'bad request' }, 400);
          const row = await env.DB.prepare(
            'SELECT * FROM bookings WHERE ref = ? AND email = ?').bind(ref, email).first();
          if (!row) return json({ error: 'No such lesson on your account.' }, 404);
          if (row.status === 'cancelled') return json({ error: 'That lesson is already cancelled.' }, 409);
          const now = ukNowParts();
          if (lessonPast(now, row)) return json({ error: 'That lesson has already taken place.' }, 409);

          const config = await getSetting(env, 'config', DEFAULT_CONFIG);
          const late = minsUntil(now, row.date, row.time) < config.cancel_notice_hours * 60;
          const fee = late ? config.late_cancel_fee : 0;
          await env.DB.prepare(
            "UPDATE bookings SET status = 'cancelled', cancelled_by = 'student', fee = ?, paid = 0 WHERE id = ?"
          ).bind(fee, row.id).run();
          notify(env, ctx, late ? 'Late cancellation by pupil' : 'Booking cancelled by pupil',
            `${row.date} ${row.time} — ${row.name}\nRef ${ref}${late ? `\nLate-cancel fee £${fee} added` : ''}`);
          return json({ ok: true, late, fee });
        }
      }

      // ---- admin auth (no gate — these CREATE the credentials) ----
      // Register needs the shared ADMIN_KEY as proof; it also serves as
      // password reset (re-register with the key sets a new password and
      // signs out that account's other sessions). Login is email+password.
      if ((path === '/admin/auth/register' || path === '/admin/auth/login') && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (await rateLimited(env, `aauth:${ip}`, 20, 3600))
          return json({ error: 'Too many attempts — please try again later.' }, 429);
        const b = await readBody(req);
        const email = String(b?.email || '').trim().toLowerCase();
        const password = String(b?.password || '');
        if (!RE_EMAIL.test(email) || email.length > 200)
          return json({ error: 'Please give a valid email.' }, 400);

        if (path === '/admin/auth/register') {
          if (password.length < 8)
            return json({ error: 'Password must be at least 8 characters.' }, 400);
          const key = String(b?.key || '');
          if (!key || !env.ADMIN_KEY || (await sha256Hex(key)) !== (await sha256Hex(env.ADMIN_KEY))) {
            secLog(env, ctx, 'admin_auth_fail', 'register (wrong key)');
            return json({ error: 'Admin key not accepted.' }, 401);
          }
          const name = String(b?.name || '').trim().slice(0, 40);
          const salt = randomHex(16);
          const hash = await pbkdf2Hex(password, salt);
          await env.DB.prepare(
            `INSERT INTO admins (email, name, pw_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(email) DO UPDATE SET pw_hash = excluded.pw_hash, salt = excluded.salt,
               name = CASE WHEN excluded.name != '' THEN excluded.name ELSE admins.name END`
          ).bind(email, name, hash, salt, Math.floor(Date.now() / 1000)).run();
          await env.DB.prepare('DELETE FROM admin_sessions WHERE email = ?').bind(email).run();
          secLog(env, ctx, 'admin_register', email);
          return json({ token: await newAdminSession(env, email), email });
        }

        const a = await env.DB.prepare('SELECT * FROM admins WHERE email = ?').bind(email).first();
        if (!a || (await pbkdf2Hex(password, a.salt)) !== a.pw_hash) {
          secLog(env, ctx, 'admin_auth_fail', 'login');
          return json({ error: 'Wrong email or password.' }, 401);
        }
        secLog(env, ctx, 'admin_login', email);
        return json({ token: await newAdminSession(env, email), email, name: a.name || '' });
      }

      if (path === '/admin/auth/logout' && req.method === 'POST') {
        const tok = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
        if (/^[0-9a-f]{64}$/.test(tok))
          await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash = ?')
            .bind(await sha256Hex(tok)).run();
        return json({ ok: true });
      }

      // ---- developer (owner-only; separate DEV_KEY) ----
      if (path.startsWith('/dev/')) {
        if (!(await isDev(req, env))) {
          secLog(env, ctx, 'dev_auth_fail', path);
          return json({ error: 'unauthorized' }, 401);
        }

        // Monthly earnings ledger, computed live from the full booking and
        // charge history (bookings are never deleted, so this IS the record)
        if (path === '/dev/earnings' && req.method === 'GET') {
          const rows = (await env.DB.prepare('SELECT * FROM bookings').all()).results;
          const charges = (await env.DB.prepare('SELECT * FROM charges').all()).results;
          const months = new Map();
          const M = m => {
            if (!months.has(m)) months.set(m, { month: m, lessons: 0, booked: 0, collected: 0,
              fees_collected: 0, packages_collected: 0, collected_manual: 0, collected_automatic: 0 });
            return months.get(m);
          };
          for (const r of rows) {
            const m = M(r.date.slice(0, 7));
            const bucket = r.lesson_type === 'automatic' ? 'collected_automatic' : 'collected_manual';
            if (r.status !== 'cancelled') {
              m.lessons++;
              m.booked += r.price;
              if (r.paid) { m.collected += r.price; m[bucket] += r.price; }
            } else if (r.fee > 0 && r.paid) {
              m.collected += r.fee; m.fees_collected += r.fee; m[bucket] += r.fee;
            }
          }
          for (const ch of charges) {
            if (!ch.paid) continue;
            const d = new Date(ch.created_at * 1000).toLocaleDateString('en-CA',
              { timeZone: 'Europe/London' }).slice(0, 7);
            const m = M(d);
            const bucket = ch.lesson_type === 'automatic' ? 'collected_automatic' : 'collected_manual';
            m.collected += ch.amount; m.packages_collected += ch.amount; m[bucket] += ch.amount;
          }
          return json({ months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)) });
        }

        if (path === '/dev/security' && req.method === 'GET') {
          const nowSec = Math.floor(Date.now() / 1000);
          const dayAgo = nowSec - 86400;
          const canary = await canaryEmailOf(env); // self-bootstraps the decoy row
          const recent = (await env.DB.prepare(
            'SELECT * FROM security_log ORDER BY id DESC LIMIT 30').all()).results;
          const count = async (sql, ...args) =>
            (await env.DB.prepare(sql).bind(...args).first())?.c || 0;
          // canary_ok = decoy row present, never touched, no sessions on it
          const canaryRow = await env.DB.prepare('SELECT email FROM users WHERE email = ?')
            .bind(canary).first();
          const canaryHits = await count(
            "SELECT COUNT(*) AS c FROM security_log WHERE kind = 'canary_login'");
          const canarySessions = await count(
            'SELECT COUNT(*) AS c FROM sessions WHERE email = ?', canary);
          // instructor accounts with live-session + last-sign-in detail
          const admins = [];
          for (const a of (await env.DB.prepare('SELECT email, created_at FROM admins').all()).results) {
            admins.push({
              email: a.email, created_at: a.created_at,
              sessions: await count(
                'SELECT COUNT(*) AS c FROM admin_sessions WHERE email = ? AND expires > ?', a.email, nowSec),
              last_login: (await env.DB.prepare(
                "SELECT MAX(at) AS m FROM security_log WHERE kind IN ('admin_login','admin_register') AND detail = ?"
              ).bind(a.email).first())?.m || null,
            });
          }
          return json({
            recent,
            failed_admin_24h: await count(
              "SELECT COUNT(*) AS c FROM security_log WHERE kind IN ('admin_auth_fail','dev_auth_fail') AND at > ?", dayAgo),
            failed_login_24h: await count(
              "SELECT COUNT(*) AS c FROM security_log WHERE kind = 'login_fail' AND at > ?", dayAgo),
            pupils: (await count('SELECT COUNT(*) AS c FROM users')) - (canaryRow ? 1 : 0),
            sessions: await count('SELECT COUNT(*) AS c FROM sessions WHERE expires > ?', nowSec),
            admins,
            canary_ok: !!canaryRow && canaryHits === 0 && canarySessions === 0,
            canary_hits: canaryHits,
          });
        }

        // Revoke an instructor's console account entirely (row + sessions).
        // The shared admin key still exists — they could re-register with it,
        // so rotating the key is the companion step for a real lock-out.
        if (path === '/dev/admin-delete' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          await env.DB.prepare('DELETE FROM admins WHERE email = ?').bind(email).run();
          await env.DB.prepare('DELETE FROM admin_sessions WHERE email = ?').bind(email).run();
          secLog(env, ctx, 'admin_delete', email);
          return json({ ok: true });
        }

        // Delete a pupil's LOGIN account (users row + sessions). Bookings,
        // charges and the student record stay — they are the business's
        // money history; the pupil can re-register with any booking ref.
        if (path === '/dev/user-delete' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          if (email === (await getSetting(env, 'canary', { email: null })).email)
            return json({ error: 'That is the canary tripwire account — it stays.' }, 400);
          const u = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
          if (!u) return json({ error: 'No login account exists for that email.' }, 404);
          await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
          await env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email).run();
          secLog(env, ctx, 'user_delete', '');
          return json({ ok: true });
        }

        if (path === '/dev/audit' && req.method === 'GET') {
          return json({ audit: (await env.DB.prepare(
            'SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all()).results });
        }

        // Anonymous daily page views + bookings created that day (conversion)
        if (path === '/dev/traffic' && req.method === 'GET') {
          const days = (await env.DB.prepare(
            'SELECT day, views FROM traffic ORDER BY day DESC LIMIT 30').all()).results;
          const byDay = new Map(days.map(d => [d.day, { ...d, bookings: 0 }]));
          for (const r of (await env.DB.prepare('SELECT created_at FROM bookings').all()).results) {
            const d = new Date(r.created_at * 1000).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
            if (byDay.has(d)) byDay.get(d).bookings++;
          }
          return json({ days: [...byDay.values()] });
        }

        // Money already in the diary + how full each instructor's next 4 weeks are
        if (path === '/dev/pipeline' && req.method === 'GET') {
          const now = ukNowParts();
          const horizon = addDays(now.date, 27);
          const rows = (await env.DB.prepare(
            "SELECT * FROM bookings WHERE status != 'cancelled'").all()).results;
          let upcomingConfirmed = 0, upcomingPending = 0;
          for (const r of rows) {
            if (lessonPast(now, r)) continue;
            if (r.status === 'confirmed') upcomingConfirmed += r.price;
            else if (r.status === 'pending') upcomingPending += r.price;
          }
          const util = {};
          for (const type of ['manual', 'automatic']) {
            const template = await templateFor(env, type);
            const blocked = await blockedDates(env, now.date, horizon, type);
            let avail = 0;
            for (let d = now.date; d <= horizon; d = addDays(d, 1)) {
              if (blocked.has(d)) continue;
              const day = template[isoDayKey(d)];
              if (day) avail += toMin(day.end) - toMin(day.start);
            }
            const booked = rows
              .filter(r => (r.lesson_type === 'automatic') === (type === 'automatic'))
              .filter(r => r.date >= now.date && r.date <= horizon)
              .reduce((a, r) => a + r.duration_min, 0);
            util[type] = { avail_min: avail, booked_min: booked };
          }
          return json({ upcoming_confirmed: upcomingConfirmed,
            upcoming_pending: upcomingPending, window_days: 28, utilisation: util });
        }

        // Pupil analytics: growth, depth, and who has gone quiet
        if (path === '/dev/pupils' && req.method === 'GET') {
          const now = ukNowParts();
          const rows = (await env.DB.prepare(
            'SELECT * FROM bookings ORDER BY date, time').all()).results;
          const metas = new Map((await env.DB.prepare('SELECT * FROM students').all())
            .results.map(m => [m.email, m]));
          const pupils = new Map();
          for (const r of rows) {
            const p = pupils.get(r.email) || { email: r.email, name: r.name, phone: r.phone,
              first_date: r.date, last_past: null, past: 0, future: 0 };
            p.name = r.name; p.phone = r.phone;
            if (r.date < p.first_date) p.first_date = r.date;
            if (r.status !== 'cancelled') {
              if (lessonPast(now, r)) { p.past++; if (!p.last_past || r.date > p.last_past) p.last_past = r.date; }
              else p.future++;
            }
            pupils.set(r.email, p);
          }
          const monthCounts = new Map();
          let taught = 0, lessonsTaught = 0;
          const quiet = [];
          const cutoff = addDays(now.date, -30);
          for (const p of pupils.values()) {
            const m = p.first_date.slice(0, 7);
            monthCounts.set(m, (monthCounts.get(m) || 0) + 1);
            if (p.past > 0) { taught++; lessonsTaught += p.past; }
            const meta = metas.get(p.email) || {};
            if (p.past > 0 && p.future === 0 && p.last_past <= cutoff && !meta.passed && !meta.archived)
              quiet.push({ name: p.name, phone: p.phone, email: p.email,
                last_lesson: p.last_past, lessons: p.past });
          }
          quiet.sort((a, b) => b.last_lesson.localeCompare(a.last_lesson));
          return json({
            total_pupils: pupils.size,
            avg_lessons: taught ? Math.round(lessonsTaught / taught * 10) / 10 : 0,
            new_by_month: [...monthCounts.entries()].map(([month, count]) => ({ month, count }))
              .sort((a, b) => a.month.localeCompare(b.month)).slice(-8),
            quiet,
          });
        }

        // Ops snapshot: table sizes, gallery usage, live config
        if (path === '/dev/ops' && req.method === 'GET') {
          const counts = {};
          for (const t of ['bookings', 'students', 'users', 'sessions', 'admins', 'charges',
            'package_requests', 'overrides', 'gallery', 'security_log', 'error_log', 'audit_log']) {
            counts[t] = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first())?.c || 0;
          }
          return json({ counts, gallery_cap: 60,
            config: await getSetting(env, 'config', DEFAULT_CONFIG) });
        }

        if (path === '/dev/errors' && req.method === 'GET') {
          const dayAgo = Math.floor(Date.now() / 1000) - 86400;
          return json({
            count_24h: (await env.DB.prepare(
              'SELECT COUNT(*) AS c FROM error_log WHERE at > ?').bind(dayAgo).first())?.c || 0,
            recent: (await env.DB.prepare(
              'SELECT * FROM error_log ORDER BY id DESC LIMIT 30').all()).results,
          });
        }

        return json({ error: 'not found' }, 404);
      }

      // ---- admin ----
      if (path.startsWith('/admin/')) {
        const actor = await adminActor(req, env);
        if (!actor) {
          secLog(env, ctx, 'admin_auth_fail', path);
          return json({ error: 'unauthorized' }, 401);
        }

        // Console KPIs: booked/collected money + outstanding + pending count.
        // ?type=manual|automatic scopes the money/pending to one instructor's
        // lessons; Outstanding then covers that instructor's pupils but keeps
        // each pupil's FULL account (money is per pupil, not per instructor).
        if (path === '/admin/summary' && req.method === 'GET') {
          const scope = scopeOf(url);
          const rows = (await env.DB.prepare('SELECT * FROM bookings').all()).results;
          const metas = (await env.DB.prepare('SELECT * FROM students').all()).results;
          const now = ukNowParts();
          const dow = (new Date(now.date + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = Monday
          const weekStart = addDays(now.date, -dow), weekEnd = addDays(weekStart, 6);
          const month = now.date.slice(0, 7);
          let weekBooked = 0, monthBooked = 0, monthCollected = 0, pending = 0;
          const allCharges = (await env.DB.prepare('SELECT * FROM charges').all()).results;
          const chargesByEmail = new Map();
          for (const ch of allCharges) {
            if (!chargesByEmail.has(ch.email)) chargesByEmail.set(ch.email, []);
            chargesByEmail.get(ch.email).push(ch);
          }
          const rowsByEmail = new Map();
          for (const r of rows) {
            if (!rowsByEmail.has(r.email)) rowsByEmail.set(r.email, []);
            rowsByEmail.get(r.email).push(r);
          }
          for (const r of rows) {
            if (inScope(scope, r)) {
              if (r.status === 'pending' && !lessonPast(now, r)) pending++;
              if (r.status !== 'cancelled') {
                if (r.date >= weekStart && r.date <= weekEnd) weekBooked += r.price;
                if (r.date.startsWith(month)) {
                  monthBooked += r.price;
                  if (r.paid) monthCollected += r.price;
                }
              } else if (r.fee > 0 && r.paid && r.date.startsWith(month)) {
                monthCollected += r.fee;
              }
            }
          }
          // Outstanding is split per instructor (they're paid separately);
          // the scoped view reports that instructor's share only.
          const creditBy = new Map(metas.map(m => [m.email, m.credit || 0]));
          const archived = new Set(metas.filter(m => m.archived).map(m => m.email));
          let owedManual = 0, owedAuto = 0;
          for (const em of new Set([...rowsByEmail.keys(), ...chargesByEmail.keys()])) {
            if (archived.has(em)) continue;
            const sp = splitOwed(now, rowsByEmail.get(em) || [],
              chargesByEmail.get(em) || [], creditBy.get(em) || 0);
            owedManual += sp.owed_manual;
            owedAuto += sp.owed_automatic;
          }
          const outstanding = scope === 'manual' ? owedManual
            : scope === 'automatic' ? owedAuto : owedManual + owedAuto;
          return json({
            week_booked: weekBooked, month_booked: monthBooked,
            month_collected: monthCollected, outstanding, pending,
            outstanding_manual: owedManual, outstanding_automatic: owedAuto,
          });
        }

        // Instructor-created booking (phone/text pupils). Deliberately skips
        // template hours, notice and horizon — his diary, his rules. The only
        // check is a clash with an existing non-cancelled lesson.
        if (path === '/admin/add-booking' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b) return json({ error: 'bad request' }, 400);
          const { date, time } = b;
          const duration = parseInt(b.duration, 10);
          if (!RE_DATE.test(date || '') || !RE_TIME.test(time || '')) return json({ error: 'Invalid date or time.' }, 400);
          if (!DURATIONS.includes(duration)) return json({ error: 'Invalid length.' }, 400);
          const name = String(b.name || '').trim();
          if (name.length < 2 || name.length > 100) return json({ error: "Give the pupil's name." }, 400);
          const phone = String(b.phone || '').trim();
          if (!RE_PHONE.test(phone)) return json({ error: 'Give a valid phone number.' }, 400);
          let email = String(b.email || '').trim().toLowerCase();
          if (email && (!RE_EMAIL.test(email) || email.length > 200)) return json({ error: 'That email looks invalid.' }, 400);
          // No email known: synthesize a per-phone identity so the pupil's
          // lessons still aggregate into one account row
          if (!email) email = 'p' + phone.replace(/\D/g, '') + '@phone.local';
          const postcode = String(b.postcode || '').trim().toUpperCase().slice(0, 10);
          const house = String(b.house || '').trim().slice(0, 30);
          const notes = String(b.notes || '').slice(0, 500);
          const status = b.status === 'pending' ? 'pending' : 'confirmed';
          const abType = LESSON_TYPES.includes(b.lesson_type) ? b.lesson_type : 'manual';
          const abMock = b.mock ? 1 : 0;
          const abMotorway = (!abMock && b.motorway) ? 1 : 0;
          const repeatWeeks = Math.min(MAX_REPEAT_WEEKS, Math.max(1, parseInt(b.repeat_weeks, 10) || 1));
          const config = await getSetting(env, 'config', DEFAULT_CONFIG);
          const priceIn = parseFloat(b.price);
          const price = Number.isFinite(priceIn) && priceIn >= 0 && priceIn <= 1000
            ? priceIn : lessonPrice(config, duration, abType);
          const series = repeatWeeks > 1 ? newRef() : null;
          const nowSec = Math.floor(Date.now() / 1000);

          const booked = [], skipped = [];
          for (let w = 0; w < repeatWeeks; w++) {
            const d = addDays(date, w * 7);
            const clash = (await env.DB.prepare(
              "SELECT time, duration_min, lesson_type FROM bookings WHERE date = ? AND status != 'cancelled'"
            ).bind(d).all()).results.some(r =>
              (r.lesson_type === 'automatic') === (abType === 'automatic') &&
              toMin(time) < toMin(r.time) + r.duration_min && toMin(time) + duration > toMin(r.time));
            if (clash) {
              if (w === 0) return json({ error: 'That time overlaps an existing lesson.' }, 409);
              skipped.push(d);
              continue;
            }
            const ref = newRef();
            await env.DB.prepare(
              `INSERT INTO bookings (ref, series, date, time, duration_min, price, lesson_type, motorway, mock, name, email, phone, postcode, house, notes, status, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(ref, series, d, time, duration, price, abType, abMotorway, abMock, name, email, phone, postcode, house, notes, status, nowSec).run();
            booked.push({ date: d, ref });
          }
          audit(env, ctx, actor, 'add-booking',
            `${name} — ${booked.map(x => x.date).join(', ')} ${time} (£${price} each, ${abType})`);
          return json({ ok: true, booked, skipped, price_each: price, email });
        }

        if (path === '/admin/bookings' && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const scope = scopeOf(url);
          const typeSql = scope === 'automatic' ? " AND lesson_type = 'automatic'"
            : scope === 'manual' ? " AND (lesson_type IS NULL OR lesson_type != 'automatic')" : '';
          const q = status
            ? env.DB.prepare(`SELECT * FROM bookings WHERE status = ? AND hidden = 0${typeSql} ORDER BY date, time LIMIT 500`).bind(status)
            : env.DB.prepare(`SELECT * FROM bookings WHERE date >= date('now', '-7 day') AND hidden = 0${typeSql} ORDER BY date, time LIMIT 500`);
          return json({ bookings: (await q.all()).results });
        }

        // Dismiss a row from the bookings list (kept in the pupil's account
        // history and in the money math) — only for past or cancelled lessons
        if (path === '/admin/hide' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id)) return json({ error: 'bad request' }, 400);
          const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
          if (!row) return json({ error: 'not found' }, 404);
          if (row.status !== 'cancelled' && !lessonPast(ukNowParts(), row))
            return json({ error: 'This lesson is still upcoming — cancel it first, then remove it.' }, 409);
          await env.DB.prepare('UPDATE bookings SET hidden = 1 WHERE id = ?').bind(b.id).run();
          return json({ ok: true });
        }

        // Month/range view: bookings (all statuses) + blocked-out dates
        if (path === '/admin/calendar' && req.method === 'GET') {
          const from = url.searchParams.get('from'), to = url.searchParams.get('to');
          if (!RE_DATE.test(from || '') || !RE_DATE.test(to || '') || daysBetween(from, to) > 62)
            return json({ error: 'bad params' }, 400);
          const scope = scopeOf(url);
          const bookings = (await env.DB.prepare(
            'SELECT * FROM bookings WHERE date >= ? AND date <= ? AND hidden = 0 ORDER BY date, time'
          ).bind(from, to).all()).results.filter(r => inScope(scope, r));
          return json({ bookings, blocked: [...await blockedDates(env, from, to, scope)] });
        }

        if (path === '/admin/booking' && req.method === 'POST') {
          const b = await readBody(req);
          // Accepts a single id or an ids array (series bulk actions) so a
          // pupil gets ONE cancellation message however many weeks are cancelled
          const ids = Array.isArray(b?.ids) ? b.ids.filter(Number.isInteger).slice(0, 50)
            : (Number.isInteger(b?.id) ? [b.id] : []);
          if (!ids.length || !['confirmed', 'cancelled', 'pending'].includes(b.action))
            return json({ error: 'bad request' }, 400);
          if (b.action === 'cancelled') {
            // Instructor cancellations never carry a pupil fee
            const rows = [];
            for (const id of ids) {
              const r = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first();
              if (r && r.status !== 'cancelled') rows.push(r);
              await env.DB.prepare(
                "UPDATE bookings SET status = 'cancelled', cancelled_by = 'instructor', fee = 0 WHERE id = ?"
              ).bind(id).run();
            }
            await notifyCancelledPupils(env, ctx, rows, url.origin);
            audit(env, ctx, actor, 'cancel-booking',
              rows.map(r => `${r.name} ${r.date} ${r.time}`).join('; ') || `ids ${ids.join(',')}`);
          } else {
            for (const id of ids) await env.DB.prepare(
              'UPDATE bookings SET status = ?, cancelled_by = NULL, fee = 0 WHERE id = ?'
            ).bind(b.action, id).run();
            audit(env, ctx, actor, b.action === 'confirmed' ? 'confirm-booking' : 'set-pending',
              `ids ${ids.join(',')}`);
          }
          return json({ ok: true });
        }

        if (path === '/admin/paid' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id) || ![0, 1].includes(b.paid)) return json({ error: 'bad request' }, 400);
          await env.DB.prepare('UPDATE bookings SET paid = ? WHERE id = ?').bind(b.paid, b.id).run();
          audit(env, ctx, actor, b.paid ? 'mark-paid' : 'mark-unpaid', `booking #${b.id}`);
          return json({ ok: true });
        }

        if (path === '/admin/students' && req.method === 'GET') {
          const view = url.searchParams.get('view') ||
            (url.searchParams.get('passed') === '1' ? 'passed' : 'active');
          const rows = (await env.DB.prepare('SELECT * FROM bookings ORDER BY created_at').all()).results;
          const scope = scopeOf(url);
          const scopedEmails = scope
            ? new Set(rows.filter(r => inScope(scope, r)).map(r => r.email)) : null;
          const metas = new Map((await env.DB.prepare('SELECT * FROM students').all())
            .results.map(m => [m.email, m]));
          const chargesBy = new Map(), chargeRows = new Map();
          for (const ch of (await env.DB.prepare('SELECT * FROM charges').all()).results) {
            if (!ch.paid) chargesBy.set(ch.email, (chargesBy.get(ch.email) || 0) + ch.amount);
            if (!chargeRows.has(ch.email)) chargeRows.set(ch.email, []);
            chargeRows.get(ch.email).push(ch);
          }
          const lessonRows = new Map();
          for (const r of rows) {
            if (!lessonRows.has(r.email)) lessonRows.set(r.email, []);
            lessonRows.get(r.email).push(r);
          }
          const now = ukNowParts();
          const map = new Map();
          for (const r of rows) {
            const s = map.get(r.email) || {
              email: r.email, name: r.name, phone: r.phone, postcode: r.postcode,
              lessons: 0, upcoming: 0, cancelled: 0, gross_owed: 0, upcoming_cost: 0,
            };
            // Latest booking wins for contact details
            s.name = r.name; s.phone = r.phone; s.postcode = r.postcode; s.house = r.house || '';
            if (r.status !== 'cancelled') {
              s.lessons++;
              if (!lessonPast(now, r)) { s.upcoming++; s.upcoming_cost += r.price; }
            } else s.cancelled++;
            s.gross_owed += owedOf(now, r);
            map.set(r.email, s);
          }
          const students = [...map.values()].map(s => {
            const m = metas.get(s.email) || {};
            s.gross_owed += chargesBy.get(s.email) || 0;
            s.credit = m.credit || 0;
            s.credit_min = m.credit_min || 0;
            s.credit_mock = m.credit_mock || 0;
            s.passed = !!m.passed;
            s.archived = !!m.archived;
            s.test_date = m.test_date || null;
            s.has_notes = !!(m.notes && m.notes.trim());
            s.owed = Math.max(0, s.gross_owed - s.credit);
            // Per-instructor split — in a scoped view `owed` becomes that
            // instructor's share, so the list totals what they're owed
            const sp = splitOwed(now, lessonRows.get(s.email) || [],
              chargeRows.get(s.email) || [], s.credit);
            s.owed_manual = sp.owed_manual;
            s.owed_automatic = sp.owed_automatic;
            if (scope) s.owed = scope === 'automatic' ? sp.owed_automatic : sp.owed_manual;
            return s;
          }).filter(s => view === 'archived' ? s.archived
            : view === 'passed' ? (s.passed && !s.archived)
            : (!s.passed && !s.archived))
            // Scoped view: only pupils with at least one of this instructor's
            // lessons; their money figures stay whole-account.
            .filter(s => !scopedEmails || scopedEmails.has(s.email))
            .sort((a, b2) => b2.owed - a.owed || a.name.localeCompare(b2.name));
          return json({ students });
        }

        if (path === '/admin/student' && req.method === 'GET') {
          const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          const rows = (await env.DB.prepare(
            'SELECT * FROM bookings WHERE email = ? ORDER BY date DESC, time DESC').bind(email).all()).results;
          const chRows = (await env.DB.prepare(
            'SELECT * FROM charges WHERE email = ? ORDER BY created_at').bind(email).all()).results;
          const now = ukNowParts();
          const meta = await studentMeta(env, email);
          const gross = rows.reduce((a, r) => a + owedOf(now, r), 0) +
            chRows.reduce((a, ch) => a + (ch.paid ? 0 : ch.amount), 0);
          const hasAccount = !!(await env.DB.prepare(
            'SELECT email FROM users WHERE email = ?').bind(email).first());
          return json({
            lessons: rows.map(r => ({ ...r, past: lessonPast(now, r), owed_now: owedOf(now, r) })),
            charges: chRows,
            meta: { notes: meta.notes || '', passed: !!meta.passed, credit: meta.credit || 0,
              credit_min: meta.credit_min || 0, credit_mock: meta.credit_mock || 0, archived: !!meta.archived,
              test_date: meta.test_date || null },
            gross_owed: gross, owed: Math.max(0, gross - (meta.credit || 0)),
            split: splitOwed(now, rows, chRows, meta.credit || 0),
            has_account: hasAccount,
          });
        }

        if (path === '/admin/packages' && req.method === 'GET') {
          const scope = scopeOf(url);
          return json({
            requests: (await env.DB.prepare(
              'SELECT * FROM package_requests ORDER BY created_at DESC LIMIT 100').all())
              .results.filter(r => inScope(scope, r)),
            packages: packageInfo(await getSetting(env, 'config', DEFAULT_CONFIG)),
          });
        }

        // Accepting a package credits the lesson-time hours and raises the
        // package charge (owed until marked paid)
        if (path === '/admin/package' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id) || !['accept', 'decline'].includes(b.action))
            return json({ error: 'bad request' }, 400);
          const row = await env.DB.prepare('SELECT * FROM package_requests WHERE id = ?').bind(b.id).first();
          if (!row) return json({ error: 'not found' }, 404);
          if (row.status !== 'pending') return json({ error: 'Already handled.' }, 409);
          if (b.action === 'accept') {
            const config = await getSetting(env, 'config', DEFAULT_CONFIG);
            const pkg = packageInfo(config)[row.package];
            if (!pkg) return json({ error: 'unknown package' }, 400);
            const m = await studentMeta(env, row.email);
            if (row.package === 'mock') m.credit_mock = (m.credit_mock || 0) + 1;
            else m.credit_min = (m.credit_min || 0) + pkg.minutes;
            await putStudentMeta(env, { ...m, email: row.email });
            await env.DB.prepare(
              'INSERT INTO charges (email, label, amount, paid, lesson_type, created_at) VALUES (?, ?, ?, 0, ?, ?)'
            ).bind(row.email, pkg.label, pkg.price,
              row.lesson_type === 'automatic' ? 'automatic' : 'manual',
              Math.floor(Date.now() / 1000)).run();
          }
          await env.DB.prepare('UPDATE package_requests SET status = ? WHERE id = ?')
            .bind(b.action === 'accept' ? 'accepted' : 'declined', b.id).run();
          audit(env, ctx, actor, `package-${b.action}`, `${row.package} — ${row.name}`);
          return json({ ok: true });
        }

        if (path === '/admin/charge' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id) || ![0, 1].includes(b.paid)) return json({ error: 'bad request' }, 400);
          await env.DB.prepare('UPDATE charges SET paid = ? WHERE id = ?').bind(b.paid, b.id).run();
          audit(env, ctx, actor, b.paid ? 'charge-paid' : 'charge-unpaid', `charge #${b.id}`);
          return json({ ok: true });
        }

        // Settle one unpaid lesson from prepaid credit — lesson-time hours, or
        // (for motorway lessons) the pupil's separate motorway-lesson credit
        if (path === '/admin/cover-from-hours' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id)) return json({ error: 'bad request' }, 400);
          const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
          if (!row) return json({ error: 'not found' }, 404);
          if (row.paid) return json({ error: 'Already marked paid.' }, 409);
          if (row.status === 'cancelled') return json({ error: 'Credit covers lessons, not cancellation fees.' }, 400);
          const m = await studentMeta(env, row.email);
          if (b.unit === 'mock') {
            if (!row.mock) return json({ error: 'That booking is not a mock test.' }, 400);
            if ((m.credit_mock || 0) < 1) return json({ error: 'No prepaid mock tests left on their account.' }, 409);
            m.credit_mock -= 1;
          } else {
            if ((m.credit_min || 0) < row.duration_min)
              return json({ error: `Not enough lesson-time credit (${m.credit_min || 0} min available, ${row.duration_min} needed).` }, 409);
            m.credit_min -= row.duration_min;
          }
          await putStudentMeta(env, { ...m, email: row.email });
          await env.DB.prepare('UPDATE bookings SET paid = 1 WHERE id = ?').bind(b.id).run();
          audit(env, ctx, actor, 'cover-from-credit',
            `${row.email} — ${row.date} ${row.time} (${b.unit === 'mock' ? '1 mock test' : row.duration_min + ' min'})`);
          return json({ ok: true, credit_min: m.credit_min || 0, credit_mock: m.credit_mock || 0 });
        }

        // File a finished pupil away: they leave the working lists but every
        // lesson and payment record is kept, so past months' takings still add
        // up. Reversible — nothing is deleted.
        if (path === '/admin/student-archive' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email) || typeof b.archived !== 'boolean')
            return json({ error: 'bad request' }, 400);
          const meta = await studentMeta(env, email);
          if (b.archived && !meta.passed)
            return json({ error: 'Mark the pupil as passed before archiving them.' }, 409);
          meta.archived = b.archived ? 1 : 0;
          await putStudentMeta(env, { ...meta, email });
          if (b.archived) await env.DB.prepare('DELETE FROM sessions WHERE email = ?').bind(email).run();
          audit(env, ctx, actor, b.archived ? 'archive-pupil' : 'restore-pupil', email);
          return json({ ok: true, archived: !!meta.archived });
        }

        if (path === '/admin/student-meta' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          const m = await studentMeta(env, email);
          if (typeof b.notes === 'string') m.notes = b.notes.slice(0, 2000);
          if (typeof b.passed === 'boolean') m.passed = b.passed ? 1 : 0;
          await putStudentMeta(env, { ...m, email });
          audit(env, ctx, actor, 'edit-pupil-record', email);
          return json({ ok: true, meta: { notes: m.notes || '', passed: !!m.passed, credit: m.credit || 0 } });
        }

        if (path === '/admin/credit' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          const delta = parseFloat(b?.delta);
          if (!RE_EMAIL.test(email) || !Number.isFinite(delta) || Math.abs(delta) > 6000)
            return json({ error: 'bad request' }, 400);
          const m = await studentMeta(env, email);
          if (b.unit === 'mock') {
            m.credit_mock = Math.max(0, Math.round((m.credit_mock || 0) + delta));
          } else if (b.unit === 'minutes') {
            m.credit_min = Math.max(0, Math.round((m.credit_min || 0) + delta));
          } else {
            m.credit = Math.max(0, Math.round(((m.credit || 0) + delta) * 100) / 100);
          }
          await putStudentMeta(env, { ...m, email });
          return json({ ok: true, credit: m.credit || 0, credit_min: m.credit_min || 0,
            credit_mock: m.credit_mock || 0 });
        }

        // Settle one unpaid lesson (or cancellation fee) from the pupil's credit
        if (path === '/admin/pay-from-credit' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id)) return json({ error: 'bad request' }, 400);
          const row = await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(b.id).first();
          if (!row) return json({ error: 'not found' }, 404);
          if (row.paid) return json({ error: 'Already marked paid.' }, 409);
          const amount = row.status === 'cancelled' ? row.fee : row.price;
          if (!(amount > 0)) return json({ error: 'Nothing to charge for this lesson.' }, 400);
          const m = await studentMeta(env, row.email);
          if ((m.credit || 0) < amount)
            return json({ error: `Not enough credit (£${m.credit || 0} available, £${amount} needed).` }, 409);
          m.credit = Math.round((m.credit - amount) * 100) / 100;
          await putStudentMeta(env, { ...m, email: row.email });
          await env.DB.prepare('UPDATE bookings SET paid = 1 WHERE id = ?').bind(b.id).run();
          return json({ ok: true, credit: m.credit });
        }

        if (path === '/admin/schedule' && req.method === 'GET') {
          const type = scopeOf(url) || 'manual';
          return json({
            type,
            template: await templateFor(env, type),
            overrides: (await env.DB.prepare(
              "SELECT * FROM overrides WHERE end_date >= date('now') ORDER BY start_date LIMIT 200").all())
              .results.filter(o => !o.lesson_type || o.lesson_type === type),
          });
        }

        if (path === '/admin/schedule' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || typeof b.template !== 'object') return json({ error: 'bad request' }, 400);
          const tplType = b.type === 'automatic' ? 'automatic' : 'manual';
          const clean = {};
          for (const k of DAY_KEYS) {
            const d = b.template[k];
            if (!d) { clean[k] = null; continue; }
            if (!RE_TIME.test(d.start || '') || !RE_TIME.test(d.end || '') || toMin(d.start) >= toMin(d.end))
              return json({ error: `bad hours for ${k}` }, 400);
            clean[k] = { start: d.start, end: d.end };
          }
          await putSetting(env, tplType === 'automatic' ? 'template_auto' : 'template', clean);
          audit(env, ctx, actor, 'edit-hours', tplType);
          return json({ ok: true });
        }

        if (path === '/admin/override' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b) return json({ error: 'bad request' }, 400);
          if (b.remove) {
            if (!Number.isInteger(b.id)) return json({ error: 'bad request' }, 400);
            await env.DB.prepare('DELETE FROM overrides WHERE id = ?').bind(b.id).run();
            audit(env, ctx, actor, 'reopen-time-off', `override #${b.id}`);
            return json({ ok: true });
          }
          const start = b.start_date, end = b.end_date || b.start_date;
          if (!RE_DATE.test(start || '') || !RE_DATE.test(end || '') || end < start)
            return json({ error: 'bad dates' }, 400);
          // Whose time off: 'manual' | 'automatic'; null = both instructors
          const ovType = b.lesson_type === 'automatic' ? 'automatic'
            : b.lesson_type === 'manual' ? 'manual' : null;
          await env.DB.prepare(
            'INSERT INTO overrides (start_date, end_date, note, lesson_type) VALUES (?, ?, ?, ?)'
          ).bind(start, end, String(b.note || '').slice(0, 200), ovType).run();

          // Auto-cancel THAT instructor's lessons inside the blocked window
          // (no pupil fee) and report them so the instructor can tell the pupils
          const hit = (await env.DB.prepare(
            "SELECT id, ref, date, time, name, phone, email, lesson_type FROM bookings WHERE date >= ? AND date <= ? AND status != 'cancelled' ORDER BY date, time"
          ).bind(start, end).all()).results.filter(h =>
            !ovType || (h.lesson_type === 'automatic') === (ovType === 'automatic'));
          if (hit.length) {
            for (const h of hit) await env.DB.prepare(
              "UPDATE bookings SET status = 'cancelled', cancelled_by = 'instructor', fee = 0 WHERE id = ?"
            ).bind(h.id).run();
            notify(env, ctx, `Time off blocked — ${hit.length} lesson(s) auto-cancelled`,
              hit.map(h => `${h.date} ${h.time} ${h.name} (${h.phone})`).join('\n'));
            await notifyCancelledPupils(env, ctx, hit, url.origin);
          }
          audit(env, ctx, actor, 'block-time-off',
            `${start} → ${end} (${ovType || 'both'}, ${hit.length} lesson(s) auto-cancelled)`);
          return json({ ok: true, cancelled: hit });
        }

        // Gallery uploads (either instructor). Client sends a shrunk JPEG as
        // base64; hard caps keep every row well inside D1's row-size limit.
        if (path === '/admin/gallery' && req.method === 'POST') {
          const b = await readBody(req);
          const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(b?.mime) ? b.mime : null;
          const data = typeof b?.data === 'string' ? b.data.replace(/\s/g, '') : '';
          if (!mime || data.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(data))
            return json({ error: 'bad image' }, 400);
          if (data.length > 1400000)
            return json({ error: 'That photo is too large — please try a smaller one.' }, 400);
          const { c } = await env.DB.prepare('SELECT COUNT(*) AS c FROM gallery').first();
          if (c >= 60) return json({ error: 'The gallery is full (60 photos) — remove some first.' }, 409);
          await env.DB.prepare(
            'INSERT INTO gallery (caption, mime, data, created_at) VALUES (?, ?, ?, ?)'
          ).bind(String(b.caption || '').slice(0, 200), mime, data, Math.floor(Date.now() / 1000)).run();
          audit(env, ctx, actor, 'gallery-upload', String(b.caption || '').slice(0, 80));
          return json({ ok: true });
        }

        if (path === '/admin/gallery-delete' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id)) return json({ error: 'bad request' }, 400);
          await env.DB.prepare('DELETE FROM gallery WHERE id = ?').bind(b.id).run();
          audit(env, ctx, actor, 'gallery-delete', `photo #${b.id}`);
          return json({ ok: true });
        }

        if (path === '/admin/settings' && req.method === 'GET') {
          return json({ config: await getSetting(env, 'config', DEFAULT_CONFIG) });
        }

        if (path === '/admin/settings' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || typeof b.config !== 'object') return json({ error: 'bad request' }, 400);
          const c = b.config;
          const num = (v, lo, hi, dflt) => {
            const n = parseFloat(v);
            return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
          };
          const clean = {
            name: String(c.name || DEFAULT_CONFIG.name).slice(0, 100),
            area: String(c.area || '').slice(0, 200),
            phone: String(c.phone || '').slice(0, 30),
            email: RE_EMAIL.test(c.email || '') ? c.email : '',
            hourly_rate: num(c.hourly_rate, 0, 1000, DEFAULT_CONFIG.hourly_rate),
            hourly_rate_auto: num(c.hourly_rate_auto, 0, 1000, DEFAULT_CONFIG.hourly_rate_auto),
            min_duration: DURATIONS.includes(parseInt(c.min_duration, 10)) ? parseInt(c.min_duration, 10) : 60,
            max_duration: DURATIONS.includes(parseInt(c.max_duration, 10)) ? parseInt(c.max_duration, 10) : 240,
            notice_hours: num(c.notice_hours, 0, 72, DEFAULT_CONFIG.notice_hours),
            cancel_notice_hours: num(c.cancel_notice_hours, 0, 168, DEFAULT_CONFIG.cancel_notice_hours),
            late_cancel_fee: num(c.late_cancel_fee, 0, 500, DEFAULT_CONFIG.late_cancel_fee),
            horizon_days: Math.round(num(c.horizon_days, 1, 90, DEFAULT_CONFIG.horizon_days)),
            pkg_beginner_price: num(c.pkg_beginner_price, 0, 2000, 190),
            pkg_mock_price: num(c.pkg_mock_price, 0, 2000, 95),
            motorway_minutes: DURATIONS.includes(parseInt(c.motorway_minutes, 10))
              ? parseInt(c.motorway_minutes, 10) : 120,
            motorway_price: num(c.motorway_price, 0, 2000, 0),
            instructor_manual: String(c.instructor_manual || DEFAULT_CONFIG.instructor_manual).slice(0, 40),
            instructor_auto: String(c.instructor_auto || DEFAULT_CONFIG.instructor_auto).slice(0, 40),
          };
          await putSetting(env, 'config', clean);
          audit(env, ctx, actor, 'edit-settings', '');
          return json({ ok: true });
        }
      }

      // Anything that isn't an API route is a static asset (all requests run
      // through the Worker now so host redirects work on every path)
      if (env.ASSETS && (req.method === 'GET' || req.method === 'HEAD'))
        return env.ASSETS.fetch(req);
      return json({ error: 'not found' }, 404);
    } catch (e) {
      errLog(env, ctx, path, String(e && e.message || e));
      return json({ error: 'server error' }, 500);
    }
  },
};
