import express from 'express';
import { createToken, passwordMatches, createLoginLimiter } from '../auth.js';

export function authRoutes({ config, limiter = createLoginLimiter() }) {
  const r = express.Router();

  r.get('/health', (req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()), time: Date.now() });
  });

  r.post('/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const gate = limiter.check(ip);
    if (!gate.allowed) {
      res.set('Retry-After', String(gate.retryAfter));
      return res.status(429).json({ error: `Za dużo prób logowania. Spróbuj za ${Math.ceil(gate.retryAfter / 60)} min.` });
    }
    if (!config.password) return res.status(503).json({ error: 'Serwer nie ma ustawionego APP_PASSWORD' });
    if (!passwordMatches(config.password, req.body?.password)) {
      limiter.fail(ip);
      return res.status(401).json({ error: 'Nieprawidłowe hasło' });
    }
    limiter.reset(ip);
    const token = createToken(config.secret, config.tokenTtlMs);
    res.json({ token, expiresAt: Date.now() + config.tokenTtlMs });
  });

  return r;
}
