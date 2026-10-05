import express from 'express';
import path from 'node:path';
import { requireAuth } from './auth.js';
import { authRoutes } from './routes/auth.js';

/**
 * Buduje aplikację Express. `deps` zawiera config i usługi (store, engine, push...).
 * Trasy, które nie dostały swoich zależności, są pomijane (ułatwia testy).
 */
export function createApp(deps) {
  const { config } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '64kb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  app.use('/api', authRoutes({ config, limiter: deps.limiter }));
  app.use('/api', requireAuth(config.secret));
  for (const mount of deps.routes || []) app.use('/api', mount);
  app.use('/api', (req, res) => res.status(404).json({ error: 'Nie znaleziono' }));

  // Frontend PWA
  app.use(express.static(config.publicDir, {
    index: 'index.html',
    setHeaders(res, file) {
      const base = path.basename(file);
      if (base === 'sw.js' || base.endsWith('.html') || base.endsWith('.webmanifest')) res.set('Cache-Control', 'no-cache');
      if (base.endsWith('.webmanifest')) res.set('Content-Type', 'application/manifest+json');
    },
  }));

  app.use((err, req, res, next) => {
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Niepoprawny JSON' });
    console.error('[http]', err);
    res.status(500).json({ error: 'Błąd serwera' });
  });
  return app;
}
