// Accounts: scrypt password hashes, sessions as random tokens in an HttpOnly cookie (only a hash of
// the token is stored), and a per-IP brake on login and registration attempts.

const crypto = require('crypto');
const { randomToken } = require('./store');

const COOKIE = 'rpl_session';
const SESSION_DAYS = 60;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

const USERNAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const validUsername = (u) => typeof u === 'string' && USERNAME_RE.test(u);
const validPassword = (p) => typeof p === 'string' && p.length >= 8 && p.length <= 200;
// in-game names: the Vectrex font's letters and digits, up to 8
const cleanCallsign = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function hashPassword(pw) {
  return new Promise((ok, fail) => {
    const salt = crypto.randomBytes(16);
    crypto.scrypt(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }, (e, key) => {
      if (e) return fail(e);
      ok(`scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`);
    });
  });
}

function verifyPassword(pw, stored) {
  return new Promise((ok) => {
    const [kind, n, salt, key] = String(stored || '').split('$');
    if (kind !== 'scrypt' || !salt || !key) return ok(false);
    const want = Buffer.from(key, 'base64');
    crypto.scrypt(pw, Buffer.from(salt, 'base64'), want.length, { N: Number(n), r: SCRYPT.r, p: SCRYPT.p }, (e, got) => {
      ok(!e && got.length === want.length && crypto.timingSafeEqual(got, want));
    });
  });
}

const tokenHash = (t) => crypto.createHash('sha256').update(String(t)).digest('base64url');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, secure, maxAgeDays = SESSION_DAYS) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(maxAgeDays * 86400)}${secure ? '; Secure' : ''}`;
}

async function startSession(store, userId) {
  const token = randomToken();
  await store.createSession(tokenHash(token), userId, new Date(Date.now() + SESSION_DAYS * 86400000));
  return token;
}

async function userFromRequest(store, req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  try { return await store.sessionUser(tokenHash(token)); } catch { return null; }
}

// a few tries a minute per IP for login/register
const tries = new Map();
function slowDown(ip, limit = 10, windowMs = 60000) {
  const now = Date.now();
  const t = (tries.get(ip) || []).filter((x) => now - x < windowMs);
  t.push(now);
  tries.set(ip, t);
  if (tries.size > 5000) for (const [k, v] of tries) if (!v.some((x) => now - x < windowMs)) tries.delete(k);
  return t.length > limit;
}

module.exports = {
  COOKIE, validUsername, validPassword, cleanCallsign, hashPassword, verifyPassword, tokenHash,
  parseCookies, sessionCookie, startSession, userFromRequest, slowDown,
};
