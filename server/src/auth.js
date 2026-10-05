import crypto from 'node:crypto';

function sign(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

export function createToken(secret, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ sub: 'admin', iat: now, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function verifyToken(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(secret, payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < now) return null;
    return data;
  } catch {
    return null;
  }
}

/** Porównanie hasła odporne na timing (porównujemy skróty o stałej długości). */
export function passwordMatches(expected, given) {
  if (!expected || typeof given !== 'string') return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(given).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Prosty limiter: max `limit` nieudanych prób na IP w oknie `windowMs`. */
export function createLoginLimiter({ limit = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map();
  const prune = (now) => {
    for (const [ip, e] of hits) if (e.reset <= now) hits.delete(ip);
  };
  return {
    check(ip, now = Date.now()) {
      prune(now);
      const e = hits.get(ip);
      if (e && e.count >= limit) return { allowed: false, retryAfter: Math.ceil((e.reset - now) / 1000) };
      return { allowed: true };
    },
    fail(ip, now = Date.now()) {
      const e = hits.get(ip);
      if (!e || e.reset <= now) hits.set(ip, { count: 1, reset: now + windowMs });
      else e.count++;
    },
    reset(ip) { hits.delete(ip); },
  };
}

export function extractToken(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  if (typeof req.query?.token === 'string') return req.query.token;
  return null;
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const data = verifyToken(secret, extractToken(req));
    if (!data) return res.status(401).json({ error: 'Brak autoryzacji' });
    req.user = data;
    next();
  };
}
