import express from 'express';

const POWER = ['start', 'stop', 'restart'];

/** Trasy zakładki „Serwer": informacje o VPS-ie, usługi, konsole (logi) — przez S7 Agenta. */
export function hostRoutes({ host, store, engine }) {
  const r = express.Router();
  const fail = (res, err) => res.status(err.status >= 400 ? err.status : 502).json({ error: err.message || 'Błąd agenta' });
  const proxy = (path) => async (req, res) => {
    try { res.json(await host.get(typeof path === 'function' ? path(req) : path)); } catch (err) { fail(res, err); }
  };

  r.use('/host', (req, res, next) => {
    if (!host?.enabled) return res.status(503).json({ error: 'Agent serwera nie jest skonfigurowany', enabled: false });
    next();
  });

  r.get('/host/system', proxy('/system'));
  r.get('/host/services', proxy('/services'));
  r.get('/host/logs', proxy('/logs'));
  r.get('/host/logs/:id', proxy((req) => `/logs/${encodeURIComponent(req.params.id)}?lines=${Math.min(1000, Number(req.query.lines) || 200)}`));

  // Konsola na żywo (SSE): /api/host/logs/:id/stream?token=...
  r.get('/host/logs/:id/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    const hb = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 25000);
    const close = host.stream(`/logs/${encodeURIComponent(req.params.id)}/stream`, {
      onEntry: (entry) => res.write(`event: line\ndata: ${JSON.stringify(entry)}\n\n`),
      onEnd: (err) => {
        clearInterval(hb);
        if (err) res.write(`event: fail\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      },
    });
    req.on('close', () => { clearInterval(hb); close(); });
  });

  r.post('/host/services/:id/power', async (req, res) => {
    const signal = req.body?.signal;
    if (!POWER.includes(signal)) return res.status(400).json({ error: 'Sygnał: start, stop lub restart' });
    console.log(`[zasilanie] ${new Date().toISOString()} ${signal.toUpperCase()} → usługa "${req.params.id}" z IP ${req.ip}`);
    try {
      const out = await host.post(`/services/${encodeURIComponent(req.params.id)}/${signal}`);
      // Monitory tej usługi odświeżamy od razu, żeby pulpit pokazał nowy stan.
      for (const m of store.list()) {
        if (m.type === 'service' && m.target === req.params.id) setTimeout(() => engine.check(m.id).catch(() => {}), 1500).unref?.();
      }
      res.json(out);
    } catch (err) { fail(res, err); }
  });

  return r;
}
