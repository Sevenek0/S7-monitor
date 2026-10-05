/**
 * Fałszywe Pterodactyl Client API: /api/client, /servers/{id}, /resources, /power.
 * Sygnały zasilania zmieniają stan z opóźnieniem `transitionMs`.
 */
import { json, readBody, startServer } from './util.js';

export const MOCK_KEY = 'ptlc_mockkey123';

export async function startPteroMock({ port = 0, key = MOCK_KEY, transitionMs = 3000 } = {}) {
  const servers = new Map([
    ['a1b2c3d4', { name: 'Bot EMS', state: 'running', limits: { memory: 512, cpu: 50, disk: 1024 }, mem: 140e6, cpu: 3.2 }],
    ['e5f6a7b8', { name: 'Bot Policja', state: 'running', limits: { memory: 512, cpu: 50, disk: 1024 }, mem: 180e6, cpu: 5.1 }],
    ['c9d0e1f2', { name: 'Bot Ekonomia', state: 'offline', limits: { memory: 1024, cpu: 100, disk: 2048 }, mem: 0, cpu: 0 }],
    ['f00dbabe', { name: 'FiveM S7 RP', state: 'running', limits: { memory: 8192, cpu: 400, disk: 30720 }, mem: 4.2e9, cpu: 87 }],
  ]);
  const powerLog = [];
  const timers = new Set();
  const later = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); };

  const s = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__control') {
      const id = url.searchParams.get('id');
      const st = url.searchParams.get('state');
      if (servers.has(id) && st) servers.get(id).state = st;
      return json(res, 200, Object.fromEntries([...servers].map(([k, v]) => [k, v.state])));
    }
    if (req.headers.authorization !== `Bearer ${key}`) return json(res, 401, { errors: [{ code: 'AuthenticationException', detail: 'Unauthenticated.' }] });

    if (url.pathname === '/api/client') {
      return json(res, 200, {
        object: 'list',
        data: [...servers].map(([id, v]) => ({ object: 'server', attributes: { identifier: id, uuid: `${id}-0000-0000-0000-000000000000`, name: v.name, node: 'OVH-1', description: '', limits: { ...v.limits, swap: 0, io: 500 } } })),
        meta: { pagination: { total: servers.size, count: servers.size, per_page: 100, current_page: 1, total_pages: 1 } },
      });
    }
    const m = url.pathname.match(/^\/api\/client\/servers\/([^/]+)(\/resources|\/power)?$/);
    if (!m) return json(res, 404, { errors: [{ detail: 'Not found' }] });
    const srv = servers.get(m[1]);
    if (!srv) return json(res, 404, { errors: [{ code: 'NotFoundHttpException', detail: 'The requested resource could not be found on the server.' }] });

    if (!m[2] && req.method === 'GET') {
      return json(res, 200, { object: 'server', attributes: { identifier: m[1], name: srv.name, limits: { ...srv.limits, swap: 0, io: 500 } } });
    }
    if (m[2] === '/resources') {
      const running = srv.state === 'running';
      const jitter = () => 0.85 + Math.random() * 0.3;
      return json(res, 200, {
        object: 'stats',
        attributes: {
          current_state: srv.state, is_suspended: false,
          resources: {
            memory_bytes: running ? Math.round(srv.mem * jitter()) : 0,
            cpu_absolute: running ? Math.round(srv.cpu * jitter() * 1000) / 1000 : 0,
            disk_bytes: 312e6, network_rx_bytes: 1000, network_tx_bytes: 2000,
            uptime: running ? 3 * 3600 * 1000 + 17 * 60 * 1000 : 0,
          },
        },
      });
    }
    if (m[2] === '/power' && req.method === 'POST') {
      const { signal } = await readBody(req);
      if (!['start', 'stop', 'restart', 'kill'].includes(signal)) return json(res, 422, { errors: [{ detail: 'Invalid signal' }] });
      powerLog.push({ id: m[1], signal, at: Date.now() });
      if (signal === 'kill') srv.state = 'offline';
      else if (signal === 'stop') { srv.state = 'stopping'; later(transitionMs, () => { srv.state = 'offline'; }); }
      else if (signal === 'start') { srv.state = 'starting'; later(transitionMs, () => { srv.state = 'running'; }); }
      else { srv.state = 'stopping'; later(transitionMs / 2, () => { srv.state = 'starting'; later(transitionMs / 2, () => { srv.state = 'running'; }); }); }
      res.writeHead(204); return res.end();
    }
    return json(res, 405, { errors: [{ detail: 'Method not allowed' }] });
  }, port);

  const close = s.close;
  return { ...s, servers, powerLog, key, close: () => { timers.forEach(clearTimeout); return close(); } };
}
