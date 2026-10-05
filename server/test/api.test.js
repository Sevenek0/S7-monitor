import test from 'node:test';
import assert from 'node:assert/strict';
import { createServices } from '../src/services.js';
import { createPteroClient } from '../src/ptero-client.js';
import { startPteroMock } from '../mock/ptero-mock.js';
import { startFivemMock } from '../mock/fivem-mock.js';
import { tmpConfig, listen } from './helpers.js';

async function boot(t) {
  const pm = await startPteroMock({ transitionMs: 100 });
  const fm = await startFivemMock({ players: 4 });
  const config = tmpConfig({ PTERO_URL: pm.url, PTERO_KEY: pm.key });
  const pushed = [];
  const svc = createServices(config, { pushSender: async (s, b) => pushed.push(JSON.parse(b)) });
  const s = await listen(svc.app);
  t.after(async () => { svc.stop(); await s.close(); await pm.close(); await fm.close(); svc.db.close(); });
  const login = await (await fetch(`${s.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"tajne-haslo"}' })).json();
  const api = async (path, opts = {}) => {
    const res = await fetch(`${s.url}/api${path}`, {
      ...opts,
      headers: { authorization: `Bearer ${login.token}`, 'content-type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { s, svc, api, pm, fm, token: login.token, pushed };
}

test('CRUD monitorów, walidacja, pauza, historia, incydenty', async (t) => {
  const { api, fm } = await boot(t);
  let r = await api('/monitors', { method: 'POST', body: { name: '', type: 'http' } });
  assert.equal(r.status, 400); assert.match(r.body.error, /Nazwa/);
  r = await api('/monitors', { method: 'POST', body: { name: 'Strona', type: 'http', target: 'ftp://x' } });
  assert.equal(r.status, 400);
  r = await api('/monitors', { method: 'POST', body: { name: 'FiveM', type: 'fivem', target: fm.url, pteroServerId: 'f00dbabe' } });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.intervalS, 30); assert.equal(r.body.failThreshold, 2); assert.equal(r.body.status, 'pending');

  r = await api(`/monitors/${id}/check`, { method: 'POST' });
  assert.equal(r.body.status, 'up');
  assert.equal(r.body.data.clients, 4);
  assert.equal(r.body.data.ptero.state, 'running');

  r = await api(`/monitors/${id}`, { method: 'PUT', body: { name: 'FiveM S7', intervalS: 60 } });
  assert.equal(r.body.name, 'FiveM S7'); assert.equal(r.body.intervalS, 60); assert.equal(r.body.target, fm.url);

  r = await api(`/monitors/${id}/pause`, { method: 'POST', body: { paused: true } });
  assert.equal(r.body.status, 'paused');
  r = await api(`/monitors/${id}/check`, { method: 'POST' });
  assert.equal(r.status, 409);
  await api(`/monitors/${id}/pause`, { method: 'POST', body: { paused: false } });

  r = await api(`/monitors/${id}/history?range=7d`);
  assert.equal(r.body.bucketMs, 3600e3); assert.equal(r.body.buckets.length, 1);
  assert.equal((await api(`/monitors/${id}/history?range=1y`)).status, 400);
  r = await api('/monitors');
  assert.equal(r.body.monitors.length, 1);
  assert.ok(r.body.overview.monitors[id].spark.length >= 1);
  assert.deepEqual((await api(`/monitors/${id}/incidents`)).body.incidents, []);

  assert.equal((await api(`/monitors/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/monitors/${id}`)).status, 404);
});

test('Pterodactyl: import, zasilanie, klucz nigdy nie wycieka', async (t) => {
  const { api, pm, s, token } = await boot(t);
  let r = await api('/ptero/servers');
  assert.equal(r.status, 200);
  assert.equal(r.body.servers.length, 4);
  const m = (await api('/monitors', { method: 'POST', body: { name: 'Bot EMS', type: 'pterodactyl', pteroServerId: 'a1b2c3d4' } })).body;
  r = await api('/ptero/servers');
  assert.ok(r.body.servers.find((x) => x.id === 'a1b2c3d4').monitored);

  r = await api(`/monitors/${m.id}/power`, { method: 'POST', body: { signal: 'format' } });
  assert.equal(r.status, 400);
  r = await api(`/monitors/${m.id}/power`, { method: 'POST', body: { signal: 'restart' } });
  assert.equal(r.status, 200);
  assert.deepEqual(pm.powerLog.map((p) => [p.id, p.signal]), [['a1b2c3d4', 'restart']]);
  const noAuth = await fetch(`${s.url}/api/monitors/${m.id}/power`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"signal":"kill"}' });
  assert.equal(noAuth.status, 401);
  assert.equal(pm.powerLog.length, 1, 'bez tokenu brak akcji');

  const all = JSON.stringify([(await api('/monitors')).body, (await api('/me')).body, (await api('/ptero/servers')).body]);
  assert.ok(!all.includes(pm.key), 'klucz Pterodactyla nie trafia do API');
  assert.ok(!all.includes(pm.url), 'URL panelu nie trafia do API');
  const html = await (await fetch(`${s.url}/?token=${token}`)).text();
  assert.ok(!html.includes(pm.key));
});

test('SSE: token w query, hello + zdarzenia na żywo, push testowy', async (t) => {
  const { api, s, token, fm, pushed } = await boot(t);
  assert.equal((await fetch(`${s.url}/api/events`)).status, 401);
  const ctrl = new AbortController();
  const res = await fetch(`${s.url}/api/events?token=${encodeURIComponent(token)}`, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  let buf = '';
  const waitFor = async (re) => {
    const deadline = Date.now() + 3000;
    while (!re.test(buf)) {
      if (Date.now() > deadline) throw new Error(`Brak zdarzenia ${re} w: ${buf}`);
      const { value } = await reader.read();
      buf += new TextDecoder().decode(value);
    }
  };
  await waitFor(/event: hello/);
  const m = (await api('/monitors', { method: 'POST', body: { name: 'FiveM', type: 'fivem', target: fm.url, failThreshold: 1 } })).body;
  await api(`/monitors/${m.id}/check`, { method: 'POST' });
  await waitFor(/event: check/);
  fm.state.online = false;
  await api(`/monitors/${m.id}/check`, { method: 'POST' });
  await waitFor(/event: transition\ndata: \{[^\n]*"to":"down"/);
  ctrl.abort();

  const sub = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'x', auth: 'y' } };
  assert.equal((await api('/push/subscribe', { method: 'POST', body: sub })).status, 200);
  assert.equal((await api('/push/subscribe', { method: 'POST', body: { endpoint: 'x' } })).status, 400);
  const r = await api('/push/test', { method: 'POST' });
  assert.deepEqual(r.body, { sent: 1, removed: 0, failed: 0 });
  assert.equal(pushed.at(-1).title, 'S7 Monitor: test powiadomień');
});
