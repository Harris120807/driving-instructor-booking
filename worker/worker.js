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
  prices: { 60: 44, 90: 66, 120: 88 }, // £ per lesson length (minutes)
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
const DURATIONS = [60, 90, 120];
const SLOT_STEP_MIN = 30;   // start-time grid
const MAX_REPEAT_WEEKS = 12;

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
          prices: c.prices, notice_hours: c.notice_hours,
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
        if (!b.name || String(b.name).trim().length < 2 || String(b.name).length > 100) return json({ error: 'Please give your name.' }, 400);
        if (!RE_EMAIL.test(b.email || '') || String(b.email).length > 200) return json({ error: 'Please give a valid email.' }, 400);
        if (!RE_PHONE.test(b.phone || '')) return json({ error: 'Please give a valid phone number.' }, 400);
        if (!RE_UK_POSTCODE.test(b.postcode || '')) return json({ error: 'Please give a valid UK pickup postcode.' }, 400);

        // First lesson must be a genuinely open slot (notice + horizon enforced)
        const open = await openSlots(env, date, date, duration);
        if (!(open[date] || []).includes(time))
          return json({ error: 'That slot is no longer available — please pick another.' }, 409);

        const config = await getSetting(env, 'config', DEFAULT_CONFIG);
        const price = config.prices[duration];
        const name = String(b.name).trim(), email = String(b.email).trim().toLowerCase();
        const phone = String(b.phone).trim(), postcode = String(b.postcode).trim().toUpperCase();
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
            `INSERT INTO bookings (ref, series, date, time, duration_min, price, name, email, phone, postcode, notes, status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
          ).bind(ref, series, d, time, duration, price, name, email, phone, postcode, notes, nowSec).run();
          booked.push({ date: d, ref });
        }

        notify(env, ctx, repeatWeeks > 1 ? `New weekly lesson request (${booked.length}×)` : 'New lesson request',
          `${date} ${time} (${duration} min${repeatWeeks > 1 ? `, weekly ×${booked.length}` : ''})\n` +
          `${name} — ${postcode}\nRef ${booked[0].ref}${skipped.length ? `\nSkipped (unavailable): ${skipped.join(', ')}` : ''}`);

        return json({
          ok: true, ref: booked[0].ref, series, status: 'pending',
          booked, skipped, price_each: price, total: price * booked.length,
        });
      }

      // Pupil portal: authenticated by email + any one of their booking refs
      if (path === '/api/my-lessons' && req.method === 'POST') {
        const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
        if (await rateLimited(env, `portal:${ip}`, 30, 3600))
          return json({ error: 'Too many attempts — please try again later.' }, 429);
        const b = await readBody(req);
        const email = String(b?.email || '').trim().toLowerCase();
        const ref = String(b?.ref || '').trim().toUpperCase();
        if (!RE_EMAIL.test(email) || !ref) return json({ error: 'bad request' }, 400);
        const match = await env.DB.prepare(
          'SELECT id, name FROM bookings WHERE ref = ? AND email = ?').bind(ref, email).first();
        if (!match) return json({ error: 'No booking found for that reference and email.' }, 404);

        const rows = (await env.DB.prepare(
          'SELECT * FROM bookings WHERE email = ? ORDER BY date, time').bind(email).all()).results;
        const now = ukNowParts();
        const config = await getSetting(env, 'config', DEFAULT_CONFIG);
        let owed = 0, upcoming = 0;
        const lessons = rows.map(r => {
          owed += owedOf(now, r);
          upcoming += upcomingCostOf(now, r);
          return { ...publicLesson(r), past: lessonPast(now, r) };
        });
        return json({
          name: match.name, lessons, owed, upcoming_cost: upcoming,
          cancel_notice_hours: config.cancel_notice_hours, late_cancel_fee: config.late_cancel_fee,
        });
      }

      if (path === '/api/cancel' && req.method === 'POST') {
        const b = await readBody(req);
        const email = String(b?.email || '').trim().toLowerCase();
        const ref = String(b?.ref || '').trim().toUpperCase();
        if (!RE_EMAIL.test(email) || !ref) return json({ error: 'bad request' }, 400);
        const row = await env.DB.prepare(
          'SELECT * FROM bookings WHERE ref = ? AND email = ?').bind(ref, email).first();
        if (!row) return json({ error: 'No booking found for that reference and email.' }, 404);
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

      // ---- admin ----
      if (path.startsWith('/admin/')) {
        if (!(await isAdmin(req, env))) return json({ error: 'unauthorized' }, 401);

        if (path === '/admin/bookings' && req.method === 'GET') {
          const status = url.searchParams.get('status');
          const q = status
            ? env.DB.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY date, time LIMIT 500').bind(status)
            : env.DB.prepare("SELECT * FROM bookings WHERE date >= date('now', '-7 day') ORDER BY date, time LIMIT 500");
          return json({ bookings: (await q.all()).results });
        }

        if (path === '/admin/booking' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || !Number.isInteger(b.id) || !['confirmed', 'cancelled', 'pending'].includes(b.action))
            return json({ error: 'bad request' }, 400);
          if (b.action === 'cancelled') {
            // Instructor cancellations never carry a pupil fee
            await env.DB.prepare(
              "UPDATE bookings SET status = 'cancelled', cancelled_by = 'instructor', fee = 0 WHERE id = ?"
            ).bind(b.id).run();
          } else {
            await env.DB.prepare(
              'UPDATE bookings SET status = ?, cancelled_by = NULL, fee = 0 WHERE id = ?'
            ).bind(b.action, b.id).run();
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
          const rows = (await env.DB.prepare('SELECT * FROM bookings ORDER BY created_at').all()).results;
          const now = ukNowParts();
          const map = new Map();
          for (const r of rows) {
            const s = map.get(r.email) || {
              email: r.email, name: r.name, phone: r.phone, postcode: r.postcode,
              lessons: 0, upcoming: 0, cancelled: 0, owed: 0, upcoming_cost: 0,
            };
            // Latest booking wins for contact details
            s.name = r.name; s.phone = r.phone; s.postcode = r.postcode;
            if (r.status !== 'cancelled') {
              s.lessons++;
              if (!lessonPast(now, r)) { s.upcoming++; s.upcoming_cost += r.price; }
            } else s.cancelled++;
            s.owed += owedOf(now, r);
            map.set(r.email, s);
          }
          const students = [...map.values()].sort((a, b2) => b2.owed - a.owed || a.name.localeCompare(b2.name));
          return json({ students });
        }

        if (path === '/admin/student' && req.method === 'GET') {
          const email = String(url.searchParams.get('email') || '').trim().toLowerCase();
          if (!RE_EMAIL.test(email)) return json({ error: 'bad request' }, 400);
          const rows = (await env.DB.prepare(
            'SELECT * FROM bookings WHERE email = ? ORDER BY date DESC, time DESC').bind(email).all()).results;
          const now = ukNowParts();
          return json({
            lessons: rows.map(r => ({ ...r, past: lessonPast(now, r), owed_now: owedOf(now, r) })),
          });
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
            prices: {},
            notice_hours: num(c.notice_hours, 0, 72, DEFAULT_CONFIG.notice_hours),
            cancel_notice_hours: num(c.cancel_notice_hours, 0, 168, DEFAULT_CONFIG.cancel_notice_hours),
            late_cancel_fee: num(c.late_cancel_fee, 0, 500, DEFAULT_CONFIG.late_cancel_fee),
            horizon_days: Math.round(num(c.horizon_days, 1, 90, DEFAULT_CONFIG.horizon_days)),
          };
          for (const d of DURATIONS) clean.prices[d] = num(c.prices?.[d], 0, 1000, DEFAULT_CONFIG.prices[d]);
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
