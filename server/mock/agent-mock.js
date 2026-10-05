// Mock S7 Agenta (agent/s7-agent.mjs) po HTTP — do testów i npm run dev:mock.
import http from 'node:http';

export async function startAgentMock({ port = 0 } = {}) {
  const now = Date.now();
  const services = new Map([
    ['community-bot', { id: 'community-bot', label: 'community-bot', kind: 'app', power: ['start', 'stop', 'restart'], unit: 'community-bot.service', active: 'active', sub: 'running', since: now - 6 * 3600e3, mem: 92 * 1024 * 1024, cpu: 1.4, pid: 4321, restarts: 2 }],
    ['sklep-api', { id: 'sklep-api', label: 'sklep-api', kind: 'app', power: ['start', 'stop', 'restart'], unit: 'sklep-api.service', active: 'active', sub: 'running', since: now - 49 * 3600e3, mem: 61 * 1024 * 1024, cpu: 0.3, pid: 4400, restarts: 0 }],
    ['nginx', { id: 'nginx', label: 'nginx (serwer WWW)', kind: 'infra', power: ['restart'], unit: 'nginx.service', active: 'active', sub: 'running', since: now - 8 * 24 * 3600e3, mem: 14 * 1024 * 1024, cpu: 0, pid: 900, restarts: 0 }],
  ]);
  const calls = [];
  const streams = new Set();
  const line = (m, p = 6) => ({ t: Date.now(), m, p });
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://agent');
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'system') {
      return send(res, 200, {
        time: Date.now(), hostname: 'vps-mock', os: 'Ubuntu 26.04 LTS', kernel: '7.0.0-28-generic', arch: 'x64', uptime: 8 * 24 * 3600e3,
        load: [0.12, 0.2, 0.18], cpu: { model: 'Intel Core (Haswell)', cores: 4, usage: 7.5 + Math.random() * 5 },
        mem: { total: 8e9, available: 5.5e9, used: 2.5e9, swapTotal: 0, swapUsed: 0 },
        disks: [{ source: '/dev/sda1', fs: 'ext4', size: 40e9, used: 6.7e9, avail: 33.3e9, mount: '/' }],
        net: { rx: 12e9, tx: 4e9, rxRate: 18200, txRate: 9400 }, ips: ['203.0.113.10'], rebootRequired: true, updates: 18,
        processes: [{ pid: 4321, user: 'ubuntu', cpu: 1.4, mem: 92 * 1024 * 1024, name: 'node' }, { pid: 800, user: 'mysql', cpu: 0.2, mem: 210 * 1024 * 1024, name: 'mariadbd' }],
      });
    }
    if (parts[0] === 'services') {
      if (parts.length === 1) return send(res, 200, { services: [...services.values()] });
      const s = services.get(parts[1]);
      if (!s) return send(res, 404, { error: 'Nie ma takiej usługi' });
      if (req.method === 'GET') return send(res, 200, s);
      const action = parts[2];
      if (!s.power.includes(action)) return send(res, 403, { error: 'Ta akcja nie jest dozwolona dla tej usługi' });
      calls.push({ id: s.id, action });
      if (action === 'stop') Object.assign(s, { active: 'inactive', sub: 'dead', since: null, mem: null, cpu: null, pid: null });
      else Object.assign(s, { active: 'active', sub: 'running', since: Date.now(), mem: 80 * 1024 * 1024, cpu: 0.5, pid: 5000 });
      return send(res, 200, { ok: true, service: s });
    }
    if (parts[0] === 'logs') {
      const sources = [...services.values()].map((s) => ({ id: `svc.${s.id}`, label: s.label, group: s.kind === 'app' ? 'Boty i usługi' : 'System' }));
      sources.push({ id: 'system', label: 'Cały system (dziennik)', group: 'System' });
      if (parts.length === 1) return send(res, 200, { sources });
      const src = sources.find((s) => s.id === parts[1]);
      if (!src) return send(res, 404, { error: 'Nie ma takiego źródła logów' });
      if (parts[2] === 'stream') {
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        res.write(`\n${JSON.stringify(line(`[${src.label}] połączono z konsolą`))}\n`);
        const t = setInterval(() => res.write(`${JSON.stringify(line(`[${src.label}] zdarzenie ${new Date().toLocaleTimeString('pl-PL')}`))}\n`), 2500);
        streams.add(res);
        req.on('close', () => { clearInterval(t); streams.delete(res); });
        return undefined;
      }
      return send(res, 200, { id: src.id, label: src.label, lines: [line('Bot uruchomiony'), line('Zalogowano jako S7#0001'), line('Ostrzeżenie: wolna odpowiedź API', 4), line('Błąd: nie udało się wysłać wiadomości', 3)] });
    }
    return send(res, 404, { error: 'Nie znaleziono' });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    services,
    calls,
    close: () => new Promise((r) => { for (const s of streams) s.destroy(); server.closeAllConnections?.(); server.close(r); }),
  };
}
