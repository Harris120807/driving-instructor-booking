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
  hourly_rate: 44,         // £ per hour; lesson price = rate × length
  notice_hours: 12,        // minimum notice to BOOK a slot
  cancel_notice_hours: 24, // cancelling closer than this to the lesson incurs the fee
  late_cancel_fee: 44,     // £ owed for a late cancellation
  horizon_days: 21,        // how far ahead pupils can book
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
const DURATIONS = [60, 90, 120, 150, 180, 210, 240]; // 1–4 h, 30-min steps
const SLOT_STEP_MIN = 30;   // start-time grid
const MAX_REPEAT_WEEKS = 12;

// Lesson price scales with length from the single hourly rate
// (old configs stored a prices map — its 1-hour entry doubles as the rate)
function lessonPrice(config, durationMin) {
  const rate = Number.isFinite(config.hourly_rate) ? config.hourly_rate
    : (config.prices?.[60] ?? 44);
  return Math.round(rate * durationMin / 60 * 100) / 100;
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

async function isAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const key = auth.replace(/^Bearer\s+/i, '');
  if (!key || !env.ADMIN_KEY) return false;
  return (await sha256Hex(key)) === (await sha256Hex(env.ADMIN_KEY));
}

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

async function blockedDates(env, from, to) {
  const set = new Set();
  const { results } = await env.DB.prepare(
    'SELECT start_date, end_date FROM overrides WHERE start_date <= ? AND end_date >= ?'
  ).bind(to, from).all();
  for (const r of results) {
    const s = r.start_date < from ? from : r.start_date;
    const e = r.end_date > to ? to : r.end_date;
    for (let d = s; d <= e; d = addDays(d, 1)) set.add(d);
  }
  return set;
}

// opts.noHorizon: used for recurring weeks beyond the public booking horizon
async function openSlots(env, from, to, durationMin, opts = {}) {
  const config = await getSetting(env, 'config', DEFAULT_CONFIG);
  const template = await getSetting(env, 'template', DEFAULT_TEMPLATE);
  const now = ukNowParts();

  if (from < now.date) from = now.date;
  if (!opts.noHorizon) {
    const horizonEnd = addDays(now.date, config.horizon_days);
    if (to > horizonEnd) to = horizonEnd;
  }
  if (from > to) return {};

  const blocked = await blockedDates(env, from, to);

  const busy = {}; // date -> [{start, end}] minutes
  for (const r of (await env.DB.prepare(
    "SELECT date, time, duration_min FROM bookings WHERE date >= ? AND date <= ? AND status != 'cancelled'"
  ).bind(from, to).all()).results) {
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
    body: JSON.stringify({ from: env.MAIL_FROM, to, subject, text }),
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

async function studentMeta(env, email) {
  return (await env.DB.prepare('SELECT * FROM students WHERE email = ?').bind(email).first())
    || { email, notes: '', passed: 0, credit: 0 };
}

async function putStudentMeta(env, m) {
  await env.DB.prepare(
    `INSERT INTO students (email, notes, passed, credit, test_date, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET notes = excluded.notes, passed = excluded.passed,
       credit = excluded.credit, test_date = excluded.test_date, updated_at = excluded.updated_at`
  ).bind(m.email, m.notes || '', m.passed ? 1 : 0, m.credit || 0, m.test_date || null,
    Math.floor(Date.now() / 1000)).run();
}

// Full account picture for one pupil (shared by /me/lessons and the console)
async function accountFor(env, email) {
  const rows = (await env.DB.prepare(
    'SELECT * FROM bookings WHERE email = ? ORDER BY date, time').bind(email).all()).results;
  const meta = await studentMeta(env, email);
  const now = ukNowParts();
  let gross = 0, upcoming = 0;
  const lessons = rows.map(r => {
    gross += owedOf(now, r);
    upcoming += upcomingCostOf(now, r);
    return { ...publicLesson(r), past: lessonPast(now, r) };
  });
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  return {
    name: lastRow ? lastRow.name : '',
    postcode: lastRow ? lastRow.postcode : '', house: lastRow ? (lastRow.house || '') : '',
    lessons, gross_owed: gross, credit: meta.credit || 0,
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
  cancelled_by: b.cancelled_by, fee: b.fee, paid: !!b.paid,
});

// --- routes ----------------------------------------------------------------

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ---- public ----
      if (path === '/api/config' && req.method === 'GET') {
        const c = await getSetting(env, 'config', DEFAULT_CONFIG);
        return json({
          name: c.name, area: c.area, phone: c.phone, email: c.email,
          hourly_rate: lessonPrice(c, 60),
          prices: Object.fromEntries(DURATIONS.map(d => [d, lessonPrice(c, d)])),
          notice_hours: c.notice_hours,
          cancel_notice_hours: c.cancel_notice_hours, late_cancel_fee: c.late_cancel_fee,
          horizon_days: c.horizon_days, durations: DURATIONS, max_repeat_weeks: MAX_REPEAT_WEEKS,
        }, 200, { 'Cache-Control': 'public, max-age=300' });
      }

      if (path === '/api/slots' && req.method === 'GET') {
        const from = url.searchParams.get('from');
        const to = url.searchParams.get('to');
        const dur = parseInt(url.searchParams.get('duration') || '60', 10);
        if (!RE_DATE.test(from || '') || !RE_DATE.test(to || '') || !DURATIONS.includes(dur))
          return json({ error: 'bad params' }, 400);
        return json({ slots: await openSlots(env, from, to, dur) }, 200,
          { 'Cache-Control': 'public, max-age=60' });
      }

      if (path === '/api/book' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (await rateLimited(env, `book:${ip}`, 5, 3600))
          return json({ error: 'Too many booking attempts — please try again later.' }, 429);

        const b = await readBody(req);
        if (!b) return json({ error: 'bad request' }, 400);
        const { date, time, duration } = b;
        const notes = String(b.notes || '').slice(0, 500);
        const repeatWeeks = Math.min(MAX_REPEAT_WEEKS, Math.max(1, parseInt(b.repeat_weeks, 10) || 1));

        if (!RE_DATE.test(date || '') || !RE_TIME.test(time || '')) return json({ error: 'Invalid slot.' }, 400);
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

        // First lesson must be a genuinely open slot (notice + horizon enforced)
        const open = await openSlots(env, date, date, duration);
        if (!(open[date] || []).includes(time))
          return json({ error: 'That slot is no longer available — please pick another.' }, 409);

        const config = await getSetting(env, 'config', DEFAULT_CONFIG);
        const price = lessonPrice(config, duration);
        const name = bkName, email = bkEmail.toLowerCase();
        const phone = bkPhone, postcode = String(b.postcode).trim().toUpperCase();
        const series = repeatWeeks > 1 ? newRef() : null;
        const nowSec = Math.floor(Date.now() / 1000);

        const booked = [], skipped = [];
        for (let w = 0; w < repeatWeeks; w++) {
          const d = addDays(date, w * 7);
          if (w > 0) {
            // Later weeks: same checks minus the horizon (that's the point of recurring)
            const openW = await openSlots(env, d, d, duration, { noHorizon: true });
            if (!(openW[d] || []).includes(time)) { skipped.push(d); continue; }
          }
          const ref = newRef();
          await env.DB.prepare(
            `INSERT INTO bookings (ref, series, date, time, duration_min, price, name, email, phone, postcode, house, notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(ref, series, d, time, duration, price, name, email, phone, postcode, house, notes, nowSec).run();
          booked.push({ date: d, ref });
        }

        notify(env, ctx, repeatWeeks > 1 ? `New weekly lesson request (${booked.length}×)` : 'New lesson request',
          `${date} ${time} (${duration} min${repeatWeeks > 1 ? `, weekly ×${booked.length}` : ''})\n` +
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

        if (path === '/auth/login') {
          const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
          if (!u || (await pbkdf2Hex(password, u.salt)) !== u.pw_hash)
            return json({ error: 'Wrong email or password.' }, 401);
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
        } else { // reset: replace password, sign out everywhere
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
            lessons: acc.lessons,
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
          const open = await openSlots(env, nd, nd, row.duration_min);
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
            `INSERT INTO bookings (ref, series, date, time, duration_min, price, name, email, phone, postcode, house, notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(nref, null, nd, nt, row.duration_min, lessonPrice(config, row.duration_min),
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

      // ---- admin ----
      if (path.startsWith('/admin/')) {
        if (!(await isAdmin(req, env))) return json({ error: 'unauthorized' }, 401);

        // Console KPIs: booked/collected money + outstanding + pending count
        if (path === '/admin/summary' && req.method === 'GET') {
          const rows = (await env.DB.prepare('SELECT * FROM bookings').all()).results;
          const metas = (await env.DB.prepare('SELECT * FROM students').all()).results;
          const now = ukNowParts();
          const dow = (new Date(now.date + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = Monday
          const weekStart = addDays(now.date, -dow), weekEnd = addDays(weekStart, 6);
          const month = now.date.slice(0, 7);
          let weekBooked = 0, monthBooked = 0, monthCollected = 0, pending = 0;
          const gross = new Map();
          for (const r of rows) {
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
            gross.set(r.email, (gross.get(r.email) || 0) + owedOf(now, r));
          }
          const creditBy = new Map(metas.map(m => [m.email, m.credit || 0]));
          let outstanding = 0;
          for (const [em, g] of gross) outstanding += Math.max(0, g - (creditBy.get(em) || 0));
          return json({
            week_booked: weekBooked, month_booked: monthBooked,
            month_collected: monthCollected, outstanding, pending,
          });
        }

        if (path === '/admin/bookings' && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const q = status
            ? env.DB.prepare('SELECT * FROM bookings WHERE status = ? AND hidden = 0 ORDER BY date, time LIMIT 500').bind(status)
            : env.DB.prepare("SELECT * FROM bookings WHERE date >= date('now', '-7 day') AND hidden = 0 ORDER BY date, time LIMIT 500");
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
          const bookings = (await env.DB.prepare(
            'SELECT * FROM bookings WHERE date >= ? AND date <= ? AND hidden = 0 ORDER BY date, time'
          ).bind(from, to).all()).results;
          return json({ bookings, blocked: [...await blockedDates(env, from, to)] });
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
          } else {
            for (const id of ids) await env.DB.prepare(
              'UPDATE bookings SET status = ?, cancelled_by = NULL, fee = 0 WHERE id = ?'
            ).bind(b.action, id).run();
          }
          return json({ ok: true });
        }

        if (path === '/admin/paid' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id) || ![0, 1].includes(b.paid)) return json({ error: 'bad request' }, 400);
          await env.DB.prepare('UPDATE bookings SET paid = ? WHERE id = ?').bind(b.paid, b.id).run();
          return json({ ok: true });
        }

        if (path === '/admin/students' && req.method === 'GET') {
          const wantPassed = url.searchParams.get('passed') === '1';
          const rows = (await env.DB.prepare('SELECT * FROM bookings ORDER BY created_at').all()).results;
          const metas = new Map((await env.DB.prepare('SELECT * FROM students').all())
            .results.map(m => [m.email, m]));
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
            s.credit = m.credit || 0;
            s.passed = !!m.passed;
            s.test_date = m.test_date || null;
            s.has_notes = !!(m.notes && m.notes.trim());
            s.owed = Math.max(0, s.gross_owed - s.credit);
            return s;
          }).filter(s => s.passed === wantPassed)
            .sort((a, b2) => b2.owed - a.owed || a.name.localeCompare(b2.name));
          return json({ students });
        }

        if (path === '/admin/student' && req.method === 'GET') {
          const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          const rows = (await env.DB.prepare(
            'SELECT * FROM bookings WHERE email = ? ORDER BY date DESC, time DESC').bind(email).all()).results;
          const now = ukNowParts();
          const meta = await studentMeta(env, email);
          const gross = rows.reduce((a, r) => a + owedOf(now, r), 0);
          const hasAccount = !!(await env.DB.prepare(
            'SELECT email FROM users WHERE email = ?').bind(email).first());
          return json({
            lessons: rows.map(r => ({ ...r, past: lessonPast(now, r), owed_now: owedOf(now, r) })),
            meta: { notes: meta.notes || '', passed: !!meta.passed, credit: meta.credit || 0,
              test_date: meta.test_date || null },
            gross_owed: gross, owed: Math.max(0, gross - (meta.credit || 0)),
            has_account: hasAccount,
          });
        }

        if (path === '/admin/student-meta' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          const m = await studentMeta(env, email);
          if (typeof b.notes === 'string') m.notes = b.notes.slice(0, 2000);
          if (typeof b.passed === 'boolean') m.passed = b.passed ? 1 : 0;
          await putStudentMeta(env, { ...m, email });
          return json({ ok: true, meta: { notes: m.notes || '', passed: !!m.passed, credit: m.credit || 0 } });
        }

        if (path === '/admin/credit' && req.method === 'POST') {
          const b = await readBody(req);
          const email = String(b?.email || '').trim().toLowerCase();
          const delta = parseFloat(b?.delta);
          if (!RE_EMAIL.test(email) || !Number.isFinite(delta) || Math.abs(delta) > 5000)
            return json({ error: 'bad request' }, 400);
          const m = await studentMeta(env, email);
          m.credit = Math.max(0, Math.round(((m.credit || 0) + delta) * 100) / 100);
          await putStudentMeta(env, { ...m, email });
          return json({ ok: true, credit: m.credit });
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
          return json({
            template: await getSetting(env, 'template', DEFAULT_TEMPLATE),
            overrides: (await env.DB.prepare(
              "SELECT * FROM overrides WHERE end_date >= date('now') ORDER BY start_date LIMIT 200").all()).results,
          });
        }

        if (path === '/admin/schedule' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || typeof b.template !== 'object') return json({ error: 'bad request' }, 400);
          const clean = {};
          for (const k of DAY_KEYS) {
            const d = b.template[k];
            if (!d) { clean[k] = null; continue; }
            if (!RE_TIME.test(d.start || '') || !RE_TIME.test(d.end || '') || toMin(d.start) >= toMin(d.end))
              return json({ error: `bad hours for ${k}` }, 400);
            clean[k] = { start: d.start, end: d.end };
          }
          await putSetting(env, 'template', clean);
          return json({ ok: true });
        }

        if (path === '/admin/override' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b) return json({ error: 'bad request' }, 400);
          if (b.remove) {
            if (!Number.isInteger(b.id)) return json({ error: 'bad request' }, 400);
            await env.DB.prepare('DELETE FROM overrides WHERE id = ?').bind(b.id).run();
            return json({ ok: true });
          }
          const start = b.start_date, end = b.end_date || b.start_date;
          if (!RE_DATE.test(start || '') || !RE_DATE.test(end || '') || end < start)
            return json({ error: 'bad dates' }, 400);
          await env.DB.prepare(
            'INSERT INTO overrides (start_date, end_date, note) VALUES (?, ?, ?)'
          ).bind(start, end, String(b.note || '').slice(0, 200)).run();

          // Auto-cancel lessons inside the blocked window (no pupil fee) and
          // report them so the instructor can tell the pupils
          const hit = (await env.DB.prepare(
            "SELECT id, ref, date, time, name, phone, email FROM bookings WHERE date >= ? AND date <= ? AND status != 'cancelled' ORDER BY date, time"
          ).bind(start, end).all()).results;
          if (hit.length) {
            await env.DB.prepare(
              "UPDATE bookings SET status = 'cancelled', cancelled_by = 'instructor', fee = 0 WHERE date >= ? AND date <= ? AND status != 'cancelled'"
            ).bind(start, end).run();
            notify(env, ctx, `Time off blocked — ${hit.length} lesson(s) auto-cancelled`,
              hit.map(h => `${h.date} ${h.time} ${h.name} (${h.phone})`).join('\n'));
            await notifyCancelledPupils(env, ctx, hit, url.origin);
          }
          return json({ ok: true, cancelled: hit });
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
            notice_hours: num(c.notice_hours, 0, 72, DEFAULT_CONFIG.notice_hours),
            cancel_notice_hours: num(c.cancel_notice_hours, 0, 168, DEFAULT_CONFIG.cancel_notice_hours),
            late_cancel_fee: num(c.late_cancel_fee, 0, 500, DEFAULT_CONFIG.late_cancel_fee),
            horizon_days: Math.round(num(c.horizon_days, 1, 90, DEFAULT_CONFIG.horizon_days)),
          };
          await putSetting(env, 'config', clean);
          return json({ ok: true });
        }
      }

      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server error' }, 500);
    }
  },
};
