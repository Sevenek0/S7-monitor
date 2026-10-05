import express from 'express';

/** SSE: /api/events?token=... — token sprawdza globalny middleware auth. */
export function eventRoutes({ bus, store, heartbeatMs = 25000 }) {
  const r = express.Router();
  const clients = new Set();

  const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (event) => (data) => { for (const res of clients) send(res, event, data); };

  bus.on('monitor', broadcast('monitor'));
  bus.on('check', broadcast('check'));
  bus.on('removed', broadcast('removed'));
  bus.on('transition', (t) => broadcast('transition')({
    monitorId: t.monitor.id, name: t.monitor.name, type: t.monitor.type,
    from: t.from, to: t.to, reason: t.reason, downtimeMs: t.downtimeMs ?? null, ts: t.ts,
  }));

  r.get('/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    send(res, 'hello', { monitors: store.list(), time: Date.now() });
    clients.add(res);
    const hb = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), heartbeatMs);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
  });

  r.clientCount = () => clients.size;
  return r;
}
