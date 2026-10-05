import express from 'express';

export function pteroRoutes({ ptero, store }) {
  const r = express.Router();
  r.get('/ptero/servers', async (req, res) => {
    if (!ptero?.enabled) return res.status(503).json({ error: 'Ustaw PTERO_URL i PTERO_KEY w pliku .env', enabled: false });
    try {
      const servers = await ptero.listServers();
      const used = new Set(store.list().map((m) => m.pteroServerId).filter(Boolean));
      res.json({ enabled: true, servers: servers.map((s) => ({ ...s, monitored: used.has(s.id) })) });
    } catch (err) {
      res.status(502).json({ error: `Nie udało się pobrać listy z panelu: ${err.message}` });
    }
  });
  return r;
}
