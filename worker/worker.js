/**
 * Driving instructor booking site — Cloudflare Worker API.
 *
 * Bindings:
 *   DB        - D1 database (schema.sql)
 * Secrets:
 *   ADMIN_KEY  - bearer key for the /admin/* routes (instructor's console)
 *   NTFY_TOPIC - optional ntfy.sh topic; new-booking pushes go here if set
 *
 * All responses are JSON with CORS *; times are UK wall-clock (Europe/London).
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
  prices: { 60: 38, 90: 55, 120: 70 }, // £ per lesson length (minutes)
  notice_hours: 12,   // minimum notice before a slot can be booked
  horizon_days: 21,   // how far ahead pupils can book
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
const SLOT_STEP_MIN = 30; // start-time grid

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
  // Day-of-week for a YYYY-MM-DD (UTC parse is fine — date-only)
  return DAY_KEYS[new Date(dateStr + 'T12:00:00Z').getUTCDay()];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const toHM = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

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

async function openSlots(env, from, to, durationMin) {
  const config = await getSetting(env, 'config', DEFAULT_CONFIG);
  const template = await getSetting(env, 'template', DEFAULT_TEMPLATE);
  const now = ukNowParts();

  const horizonEnd = addDays(now.date, config.horizon_days);
  if (from < now.date) from = now.date;
  if (to > horizonEnd) to = horizonEnd;
  if (from > to) return {};

  const overrides = {};
  for (const r of (await env.DB.prepare(
    'SELECT date, closed FROM overrides WHERE date >= ? AND date <= ?'
  ).bind(from, to).all()).results) overrides[r.date] = r;

  const busy = {}; // date -> [{start, end}] minutes
  for (const r of (await env.DB.prepare(
    "SELECT date, time, duration_min FROM bookings WHERE date >= ? AND date <= ? AND status != 'cancelled'"
  ).bind(from, to).all()).results) {
    (busy[r.date] ||= []).push({ start: toMin(r.time), end: toMin(r.time) + r.duration_min });
  }

  const out = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (overrides[d]?.closed) continue;
    const day = template[isoDayKey(d)];
    if (!day) continue;
    const open = toMin(day.start), close = toMin(day.end);
    // Earliest bookable start on this date: (now + notice window) projected
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

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
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

// --- routes ----------------------------------------------------------------

export default {
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const path = url.pathname;

    try {
      // ---- public ----
      if (path === '/api/config' && req.method === 'GET') {
        const config = await getSetting(env, 'config', DEFAULT_CONFIG);
        return json({
          name: config.name, area: config.area, phone: config.phone, email: config.email,
          prices: config.prices, notice_hours: config.notice_hours,
          horizon_days: config.horizon_days, durations: DURATIONS,
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
        const { date, time, duration, lesson_type, name, email, phone, postcode } = b;
        const notes = String(b.notes || '').slice(0, 500);

        if (!RE_DATE.test(date || '') || !RE_TIME.test(time || '')) return json({ error: 'Invalid slot.' }, 400);
        if (!DURATIONS.includes(duration)) return json({ error: 'Invalid duration.' }, 400);
        if (!['manual', 'automatic'].includes(lesson_type)) return json({ error: 'Invalid lesson type.' }, 400);
        if (!name || String(name).trim().length < 2 || String(name).length > 100) return json({ error: 'Please give your name.' }, 400);
        if (!RE_EMAIL.test(email || '') || String(email).length > 200) return json({ error: 'Please give a valid email.' }, 400);
        if (!RE_PHONE.test(phone || '')) return json({ error: 'Please give a valid phone number.' }, 400);
        if (!RE_UK_POSTCODE.test(postcode || '')) return json({ error: 'Please give a valid UK pickup postcode.' }, 400);

        // Re-check the slot is genuinely open (also enforces notice + horizon)
        const open = await openSlots(env, date, date, duration);
        if (!(open[date] || []).includes(time))
          return json({ error: 'That slot is no longer available — please pick another.' }, 409);

        const ref = newRef();
        await env.DB.prepare(
          `INSERT INTO bookings (ref, date, time, duration_min, lesson_type, name, email, phone, postcode, notes, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(ref, date, time, duration, lesson_type, String(name).trim(), String(email).trim(),
          String(phone).trim(), String(postcode).trim().toUpperCase(), notes,
          Math.floor(Date.now() / 1000)).run();

        notify(env, ctx, 'New lesson request',
          `${date} ${time} (${duration} min, ${lesson_type})\n${String(name).trim()} — ${postcode.toUpperCase()}\nRef ${ref}`);
        return json({ ok: true, ref, status: 'pending' });
      }

      if (path === '/api/cancel' && req.method === 'POST') {
        const b = await readBody(req);
        if (!b || !b.ref || !RE_EMAIL.test(b.email || '')) return json({ error: 'bad request' }, 400);
        const row = await env.DB.prepare(
          "SELECT id, status FROM bookings WHERE ref = ? AND lower(email) = lower(?)"
        ).bind(String(b.ref).trim().toUpperCase(), String(b.email).trim()).first();
        // Same answer whether or not the ref exists — no probing
        if (row && row.status !== 'cancelled') {
          await env.DB.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").bind(row.id).run();
          notify(env, ctx, 'Booking cancelled by pupil', `Ref ${String(b.ref).trim().toUpperCase()}`);
        }
        return json({ ok: true });
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
          await env.DB.prepare('UPDATE bookings SET status = ? WHERE id = ?').bind(b.action, b.id).run();
          return json({ ok: true });
        }

        if (path === '/admin/schedule' && req.method === 'GET') {
          return json({
            template: await getSetting(env, 'template', DEFAULT_TEMPLATE),
            overrides: (await env.DB.prepare(
              "SELECT * FROM overrides WHERE date >= date('now') ORDER BY date LIMIT 200").all()).results,
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
          if (!b || !RE_DATE.test(b.date || '')) return json({ error: 'bad request' }, 400);
          if (b.remove) {
            await env.DB.prepare('DELETE FROM overrides WHERE date = ?').bind(b.date).run();
          } else {
            await env.DB.prepare(
              'INSERT INTO overrides (date, closed, note) VALUES (?, 1, ?) ON CONFLICT(date) DO UPDATE SET note = excluded.note'
            ).bind(b.date, String(b.note || '').slice(0, 200)).run();
          }
          return json({ ok: true });
        }

        if (path === '/admin/settings' && req.method === 'GET') {
          return json({ config: await getSetting(env, 'config', DEFAULT_CONFIG) });
        }

        if (path === '/admin/settings' && req.method === 'POST') {
          const b = await readBody(req);
          if (!b || typeof b.config !== 'object') return json({ error: 'bad request' }, 400);
          const c = b.config;
          const clean = {
            name: String(c.name || DEFAULT_CONFIG.name).slice(0, 100),
            area: String(c.area || '').slice(0, 200),
            phone: String(c.phone || '').slice(0, 30),
            email: RE_EMAIL.test(c.email || '') ? c.email : '',
            prices: {},
            notice_hours: Math.min(72, Math.max(0, parseInt(c.notice_hours, 10) || DEFAULT_CONFIG.notice_hours)),
            horizon_days: Math.min(90, Math.max(1, parseInt(c.horizon_days, 10) || DEFAULT_CONFIG.horizon_days)),
          };
          for (const d of DURATIONS) {
            const p = parseFloat(c.prices?.[d]);
            clean.prices[d] = Number.isFinite(p) && p >= 0 ? p : DEFAULT_CONFIG.prices[d];
          }
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
