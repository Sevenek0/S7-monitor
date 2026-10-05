import express from 'express';

export function pushRoutes({ push, config, ptero, store }) {
  const r = express.Router();

  r.get('/me', (req, res) => {
    res.json({ ok: true, ptero: Boolean(ptero?.enabled), vapidPublicKey: push?.publicKey || null, pushSubscriptions: push?.count() ?? 0, monitors: store.list().length });
  });

  r.get('/push/key', (req, res) => res.json({ publicKey: push.publicKey }));

  r.post('/push/subscribe', (req, res) => {
    try {
      push.subscribe(req.body, req.get('user-agent'));
      res.json({ ok: true, count: push.count() });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  r.post('/push/unsubscribe', (req, res) => {
    push.unsubscribe(String(req.body?.endpoint || ''));
    res.json({ ok: true });
  });

  r.post('/push/test', async (req, res) => {
    const stats = await push.sendAll({
      title: 'S7 Monitor: test powiadomień',
      body: 'Jeśli to widzisz, powiadomienia działają 🎉',
      kind: 'test', tag: 's7-test', url: '/#/',
    });
    res.json(stats);
  });

  return r;
}
