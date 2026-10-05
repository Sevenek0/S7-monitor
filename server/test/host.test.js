import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createServices } from '../src/services.js';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { startAgentMock } from '../mock/agent-mock.js';
import { tmpConfig, listen } from './helpers.js';
import {
  parseCpuStat, cpuPercent, parseMeminfo, parseDf, parseNetDev, parseShow, unitInfo, journalEntry, appUnitsFrom,
} from '../../agent/lib.mjs';

async function boot(t, { agent = true } = {}) {
  const am = agent ? await startAgentMock() : null;
  const config = tmpConfig(am ? { S7_AGENT_URL: am.url } : {});
  const svc = createServices(config, { pushSender: async () => {} });
  const s = await listen(svc.app);
  t.after(async () => { svc.stop(); await s.close(); await am?.close(); svc.db.close(); });
  const login = await (await fetch(`${s.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"tajne-haslo"}' })).json();
  const api = async (p, opts = {}) => {
    const res = await fetch(`${s.url}/api${p}`, {
      ...opts,
      headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, svc, api, am, token: login.token };
}

test('zakładka Serwer: informacje, usługi, logi i zasilanie przez agenta', async (t) => {
  const { api, am } = await boot(t);
  let r = await api('/me');
  assert.equal(r.body.host, true);

  r = await api('/host/system');
  assert.equal(r.status, 200); assert.equal(r.body.hostname, 'vps-mock'); assert.equal(r.body.disks[0].mount, '/');

  r = await api('/host/services');
  assert.deepEqual(r.body.services.map((x) => x.id), ['community-bot', 'sklep-api', 'nginx']);

  r = await api('/host/logs');
  assert.ok(r.body.sources.some((x) => x.id === 'svc.community-bot'));
  r = await api('/host/logs/svc.community-bot?lines=50');
  assert.equal(r.status, 200); assert.equal(r.body.lines.length, 4);
  r = await api('/host/logs/nie-ma');
  assert.equal(r.status, 404);

  r = await api('/host/services/nginx/power', { method: 'POST', body: { signal: 'stop' } });
  assert.equal(r.status, 403);
  r = await api('/host/services/community-bot/power', { method: 'POST', body: { signal: 'kill' } });
  assert.equal(r.status, 400);
  r = await api('/host/services/community-bot/power', { method: 'POST', body: { signal: 'restart' } });
  assert.equal(r.status, 200);
  assert.deepEqual(am.calls, [{ id: 'community-bot', action: 'restart' }]);
});

test('konsola na żywo: strumień SSE z logami wymaga tokenu', async (t) => {
  const { s, token } = await boot(t);
  let res = await fetch(`${s.url}/api/host/logs/system/stream`);
  assert.equal(res.status, 401);
  const ac = new AbortController();
  res = await fetch(`${s.url}/api/host/logs/system/stream?token=${token}`, { signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const reader = res.body.getReader();
  let text = '';
  while (!text.includes('event: line')) {
    const { done, value } = await reader.read();
    if (done) break;
    text += Buffer.from(value).toString('utf8');
  }
  ac.abort();
  assert.match(text, /event: line\ndata: \{.*połączono z konsolą/);
});

test('monitor typu "service": stan usługi, zasoby i start/stop z aplikacji', async (t) => {
  const { api, am } = await boot(t);
  let r = await api('/monitors', { method: 'POST', body: { name: 'Bot', type: 'service', target: 'zła nazwa!' } });
  assert.equal(r.status, 400);
  r = await api('/monitors', { method: 'POST', body: { name: 'Bot', type: 'service', target: 'community-bot', failThreshold: 1 } });
  assert.equal(r.status, 201);
  const id = r.body.id;

  r = await api(`/monitors/${id}/check`, { method: 'POST' });
  assert.equal(r.body.status, 'up');
  assert.equal(r.body.data.ptero.state, 'running');
  assert.equal(r.body.data.ptero.mem, 92 * 1024 * 1024);
  assert.equal(r.body.data.service.unit, 'community-bot.service');

  r = await api(`/monitors/${id}/power`, { method: 'POST', body: { signal: 'kill' } });
  assert.equal(r.status, 400);
  r = await api(`/monitors/${id}/power`, { method: 'POST', body: { signal: 'stop' } });
  assert.equal(r.status, 200);
  assert.equal(am.services.get('community-bot').active, 'inactive');
  r = await api(`/monitors/${id}/check`, { method: 'POST' });
  assert.equal(r.body.status, 'down'); assert.equal(r.body.lastError, 'usługa zatrzymana');

  r = await api(`/monitors/${id}/power`, { method: 'POST', body: { signal: 'start' } });
  assert.equal(r.status, 200);
  r = await api(`/monitors/${id}/check`, { method: 'POST' });
  assert.equal(r.body.status, 'up');

  r = await api('/monitors', { method: 'POST', body: { name: 'Duch', type: 'service', target: 'nie-ma', failThreshold: 1 } });
  r = await api(`/monitors/${r.body.id}/check`, { method: 'POST' });
  assert.equal(r.body.status, 'down'); assert.match(r.body.lastError, /nie istnieje/);
});

test('bez agenta: zakładka Serwer wyłączona, monitor usługi zgłasza brak konfiguracji', async (t) => {
  const { api } = await boot(t, { agent: false });
  let r = await api('/me');
  assert.equal(r.body.host, false);
  r = await api('/host/system');
  assert.equal(r.status, 503);
  r = await api('/monitors', { method: 'POST', body: { name: 'Bot', type: 'service', target: 'community-bot', failThreshold: 1 } });
  r = await api(`/monitors/${r.body.id}/check`, { method: 'POST' });
  assert.equal(r.body.status, 'down'); assert.match(r.body.lastError, /Agent/);
});

test('migracja bazy: stara tabela z CHECK na typ przyjmuje monitory usług i zachowuje dane', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 's7mig-')), 'old.db');
  const old = new Database(file);
  old.exec(`
    CREATE TABLE monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('http','fivem','pterodactyl')),
      target TEXT NOT NULL DEFAULT '', interval_s INTEGER NOT NULL DEFAULT 30, fail_threshold INTEGER NOT NULL DEFAULT 2,
      paused INTEGER NOT NULL DEFAULT 0, ptero_server_id TEXT, expected_codes TEXT, keyword TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
    CREATE TABLE monitor_state (monitor_id INTEGER PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE, status TEXT NOT NULL DEFAULT 'pending',
      fail_count INTEGER NOT NULL DEFAULT 0, last_check INTEGER, last_change INTEGER, last_error TEXT, last_latency INTEGER, data TEXT);
    CREATE TABLE checks (id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      ts INTEGER NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER, players INTEGER, cpu REAL, mem_bytes INTEGER);
    INSERT INTO monitors (name, type, target, created_at) VALUES ('Strona', 'http', 'https://example.com/', 1);
    INSERT INTO monitor_state (monitor_id, status) VALUES (1, 'up');
    INSERT INTO checks (monitor_id, ts, ok, latency_ms) VALUES (1, 5, 1, 42);
  `);
  old.close();

  const db = openDb(file);
  const store = createStore(db);
  assert.equal(store.get(1).name, 'Strona'); assert.equal(store.get(1).status, 'up');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 1);
  const m = store.create({ name: 'Bot', type: 'service', target: 'community-bot' });
  assert.equal(m.type, 'service'); assert.equal(m.id, 2);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  store.remove(1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM checks').get().n, 0, 'usunięcie monitora kasuje jego pomiary');
  db.close();
  openDb(file).close(); // drugie otwarcie nie migruje ponownie
});

test('agent: parsowanie /proc, df, systemctl i journalctl', () => {
  const a = parseCpuStat('cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 2 3');
  const b = parseCpuStat('cpu  150 0 150 1100 100 0 0 0 0 0\n');
  assert.deepEqual(a, { idle: 800, total: 1000 });
  assert.equal(cpuPercent(a, b), 20);
  assert.equal(cpuPercent(null, b), null);

  const mem = parseMeminfo('MemTotal:       8000000 kB\nMemFree:  100 kB\nMemAvailable:   6000000 kB\nSwapTotal: 1000 kB\nSwapFree: 400 kB\n');
  assert.equal(mem.total, 8000000 * 1024); assert.equal(mem.used, 2000000 * 1024); assert.equal(mem.swapUsed, 600 * 1024);

  const disks = parseDf('Filesystem Type 1B-blocks Used Avail Mounted on\n/dev/sda1 ext4 40000 6000 34000 /\n/dev/sdb1 ext4 100 10 90 /mnt/my disk\n');
  assert.deepEqual(disks[0], { source: '/dev/sda1', fs: 'ext4', size: 40000, used: 6000, avail: 34000, mount: '/' });
  assert.equal(disks[1].mount, '/mnt/my disk');

  const net = parseNetDev('Inter-|   Receive\n face |bytes\n    lo: 500 1 0 0 0 0 0 0 500 1 0 0 0 0 0 0\n  ens3: 1000 5 0 0 0 0 0 0 2000 6 0 0 0 0 0 0\ndocker0: 9 1 0 0 0 0 0 0 9 1 0 0 0 0 0 0\n');
  assert.deepEqual(net, { rx: 1000, tx: 2000 });

  const units = parseShow('Id=a.service\nDescription=Bot A\nLoadState=loaded\nActiveState=active\nSubState=running\nActiveEnterTimestamp=@1700000000\nMemoryCurrent=1048576\nCPUUsageNSec=5000\nMainPID=12\nNRestarts=3\nUnitFileState=enabled\n\nId=b.service\nLoadState=not-found\nActiveState=inactive\nMemoryCurrent=[not set]\n').map(unitInfo);
  assert.equal(units.length, 2);
  assert.deepEqual({ ...units[0] }, { unit: 'a.service', description: 'Bot A', loaded: true, active: 'active', sub: 'running', result: '', since: 1700000000000, mem: 1048576, cpuNs: 5000, pid: 12, restarts: 3, enabled: true });
  assert.equal(units[1].loaded, false); assert.equal(units[1].mem, null);

  assert.deepEqual(journalEntry('{"MESSAGE":"hej","PRIORITY":"3","__REALTIME_TIMESTAMP":"1700000000000000","SYSLOG_IDENTIFIER":"node"}', { withIdent: true }), { t: 1700000000000, m: 'node: hej', p: 3 });
  assert.equal(journalEntry(JSON.stringify({ MESSAGE: [...Buffer.from('zażółć')] })).m, 'zażółć');
  assert.equal(journalEntry('nie json'), null);

  assert.deepEqual(appUnitsFrom(['community-bot.service', 's7-agent.service', 'nginx.service', 'getty@.service', 'x.timer', 'api.service']), ['api.service', 'community-bot.service']);
});
