import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createEngine } from '../src/engine.js';
import { createBus } from '../src/bus.js';
import { createPush, loadVapidKeys } from '../src/push.js';
import { attachNotifier, buildNotification, formatDuration } from '../src/notifier.js';

const sub = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: `p${n}`, auth: `a${n}` } });

test('VAPID: generowane raz i zapisywane w katalogu data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's7vapid-'));
  const a = loadVapidKeys(dir);
  const b = loadVapidKeys(dir);
  assert.ok(a.publicKey && a.privateKey);
  assert.deepEqual(a, b);
});

test('formatowanie powiadomień', () => {
  assert.equal(formatDuration(4 * 60e3), '4 min');
  assert.equal(formatDuration(45e3), '45 s');
  assert.equal(formatDuration(95 * 60e3), '1 h 35 min');
  assert.equal(formatDuration(26 * 3600e3), '1 d 2 h');
  const m = { id: 7, name: 'Bot EMS' };
  assert.equal(buildNotification({ monitor: m, to: 'down', reason: 'timeout' }).title, 'PADŁ: Bot EMS (timeout)');
  assert.equal(buildNotification({ monitor: m, to: 'up', downtimeMs: 4 * 60e3 }).title, 'Działa znowu: Bot EMS (przerwa 4 min)');
  assert.equal(buildNotification({ monitor: m, to: 'up' }).url, '/#/m/7');
  assert.equal(buildNotification({ monitor: m, to: 'warn' }), null);
});

test('rozsyłanie: mock web-push, usuwanie 404/410, pozostawienie przy 500', async () => {
  const db = openDb(':memory:');
  const sent = [];
  const sender = async (s, body) => {
    if (s.endpoint.endsWith('/gone')) throw Object.assign(new Error('Gone'), { statusCode: 410 });
    if (s.endpoint.endsWith('/missing')) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    if (s.endpoint.endsWith('/err')) throw Object.assign(new Error('Server'), { statusCode: 500 });
    sent.push({ endpoint: s.endpoint, body: JSON.parse(body) });
  };
  const push = createPush({ db, vapid: { publicKey: 'BPub', privateKey: 'priv' }, subject: 'mailto:x@y.z', sender, log: {} });
  push.subscribe(sub(1)); push.subscribe(sub(2)); push.subscribe(sub(1));
  push.subscribe({ ...sub(0), endpoint: 'https://push.example.com/gone' });
  push.subscribe({ ...sub(0), endpoint: 'https://push.example.com/missing' });
  push.subscribe({ ...sub(0), endpoint: 'https://push.example.com/err' });
  assert.throws(() => push.subscribe({ endpoint: 'http://niebezpieczny' }));
  assert.equal(push.count(), 5);
  const stats = await push.sendAll({ title: 'Test' });
  assert.deepEqual(stats, { sent: 2, removed: 2, failed: 1 });
  assert.equal(push.count(), 3);
  assert.equal(sent[0].body.title, 'Test');
});

test('end-to-end: przejścia silnika wysyłają push tylko przy UP↔DOWN', async () => {
  const db = openDb(':memory:');
  const store = createStore(db);
  const bus = createBus();
  const sent = [];
  const push = createPush({ db, vapid: { publicKey: 'BPub', privateKey: 'priv' }, subject: 'mailto:x@y.z', sender: async (s, b) => sent.push(JSON.parse(b)), log: {} });
  push.subscribe(sub(1));
  attachNotifier({ bus, push, log: {} });
  let clock = 0;
  const results = [];
  const engine = createEngine({ db, store, bus, ctx: { now: () => clock, checkers: { http: async () => results.shift() } } });
  const m = store.create({ name: 'Bot EMS', type: 'http', target: 'https://example.com', failThreshold: 2 });
  const seq = [
    { status: 'up', latency: 10 }, { status: 'down', error: 'timeout' }, { status: 'down', error: 'timeout' },
    { status: 'down', error: 'timeout' }, { status: 'warn', error: 'uruchamianie' }, { status: 'up', latency: 10 }, { status: 'up', latency: 10 },
  ];
  for (const r of seq) { results.push(r); clock += 60e3; await engine.check(m.id); }
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent.map((n) => n.title), ['PADŁ: Bot EMS (timeout)', 'Działa znowu: Bot EMS (przerwa 3 min)']);
  assert.equal(sent[0].monitorId, m.id);
});
