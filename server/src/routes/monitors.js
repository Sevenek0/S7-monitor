import express from 'express';
import { ValidationError } from '../store.js';
import { RANGES } from '../history.js';
import { POWER_SIGNALS } from '../ptero-client.js';

export function monitorRoutes({ store, engine, scheduler, history, bus, ptero, host }) {
  const r = express.Router();

  const getMonitor = (req, res) => {
    const m = store.get(Number(req.params.id));
    if (!m) res.status(404).json({ error: 'Nie ma takiego monitora' });
    return m;
  };
  const handle = (fn) => (req, res) => {
    try { fn(req, res); } catch (err) {
      if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
      throw err;
    }
  };

  r.get('/monitors', (req, res) => {
    res.json({ monitors: store.list(), overview: history.overview(), incidents: history.recentIncidents(10) });
  });

  r.post('/monitors', handle((req, res) => {
    const m = store.create(req.body || {});
    bus.emit('monitor', m);
    scheduler?.reset(m.id);
    res.status(201).json(m);
  }));

  r.get('/monitors/:id', (req, res) => {
    const m = getMonitor(req, res);
    if (m) res.json(m);
  });

  r.put('/monitors/:id', handle((req, res) => {
    if (!getMonitor(req, res)) return;
    const m = store.update(Number(req.params.id), req.body || {});
    bus.emit('monitor', m);
    scheduler?.reset(m.id);
    res.json(m);
  }));

  r.delete('/monitors/:id', (req, res) => {
    const m = getMonitor(req, res);
    if (!m) return;
    store.remove(m.id);
    bus.emit('removed', { id: m.id });
    res.json({ ok: true });
  });

  r.post('/monitors/:id/pause', (req, res) => {
    const m = getMonitor(req, res);
    if (!m) return;
    const paused = Boolean(req.body?.paused);
    if (paused) engine.closeIncidents(m.id);
    const updated = store.setPaused(m.id, paused);
    scheduler?.reset(m.id);
    bus.emit('monitor', updated);
    res.json(updated);
  });

  r.post('/monitors/:id/check', async (req, res) => {
    const m = getMonitor(req, res);
    if (!m) return;
    if (m.paused) return res.status(409).json({ error: 'Monitor jest wstrzymany' });
    const out = await engine.check(m.id);
    res.json(out?.monitor ?? store.get(m.id));
  });

  r.get('/monitors/:id/history', (req, res) => {
    const m = getMonitor(req, res);
    if (!m) return;
    const range = String(req.query.range || '24h');
    if (!RANGES[range]) return res.status(400).json({ error: 'Zakres: 24h, 7d lub 30d' });
    res.json(history.get(m.id, range));
  });

  r.get('/monitors/:id/incidents', (req, res) => {
    const m = getMonitor(req, res);
    if (!m) return;
    res.json({ incidents: history.incidents(m.id, Math.min(100, Number(req.query.limit) || 20)) });
  });

  r.post('/monitors/:id/power', async (req, res) => {
    const m = getMonitor(req, res);
    if (!m) return;
    const signal = req.body?.signal;
    if (!POWER_SIGNALS.includes(signal)) return res.status(400).json({ error: 'Sygnał: start, stop, restart lub kill' });
    if (m.type === 'service') {
      if (signal === 'kill') return res.status(400).json({ error: 'Usługa obsługuje tylko start, stop i restart' });
      if (!host?.enabled) return res.status(503).json({ error: 'Agent serwera nie jest skonfigurowany' });
      console.log(`[zasilanie] ${new Date().toISOString()} ${signal.toUpperCase()} → "${m.name}" (usługa ${m.target}) z IP ${req.ip}`);
      try {
        await host.post(`/services/${encodeURIComponent(m.target)}/${signal}`);
      } catch (err) {
        return res.status(err.status === 403 || err.status === 404 ? err.status : 502).json({ error: err.message });
      }
      setTimeout(() => engine.check(m.id).catch(() => {}), 1500).unref?.();
      return res.json({ ok: true });
    }
    if (!m.pteroServerId) return res.status(400).json({ error: 'Ten monitor nie ma przypisanego serwera Pterodactyl' });
    if (!ptero?.enabled) return res.status(503).json({ error: 'Pterodactyl nie jest skonfigurowany' });
    console.log(`[zasilanie] ${new Date().toISOString()} ${signal.toUpperCase()} → "${m.name}" (${m.pteroServerId}) z IP ${req.ip}`);
    try {
      await ptero.power(m.pteroServerId, signal);
    } catch (err) {
      console.warn(`[zasilanie] Błąd: ${err.message}`);
      return res.status(502).json({ error: `Panel odrzucił polecenie: ${err.message}` });
    }
    // Szybkie odświeżenie stanu, żeby UI zobaczył starting/stopping.
    setTimeout(() => engine.check(m.id).catch(() => {}), 1500).unref?.();
    res.json({ ok: true });
  });

  return r;
}
