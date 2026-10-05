import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createStore } from '../src/store.js';
import { createEngine } from '../src/engine.js';
import { createScheduler } from '../src/scheduler.js';
import { createHistory } from '../src/history.js';
import { createRetention } from '../src/retention.js';
import { createBus } from '../src/bus.js';

function setup() {
  const db = openDb(':memory:');
  const store = createStore(db);
  const bus = createBus();
  let clock = 1_700_000_000_000;
  const results = [];
  const ctx = {
    now: () => clock,
    checkers: { http: async () => results.shift() ?? { status: 'up', latency: 50 } },
  };
  const engine = createEngine({ db, store, bus, ctx });
  const events = { transition: [], monitor: [], check: [] };
  for (const k of Object.keys(events)) bus.on(k, (e) => events[k].push(e));
  return { db, store, engine, events, results, tick: (ms) => { clock += ms; }, now: () => clock };
}

test('próg awarii: DOWN dopiero po N porażkach, UP od razu, incydent z czasem przerwy', async () => {
  const s = setup();
  const m = s.store.create({ name: 'Strona', type: 'http', target: 'https://example.com', failThreshold: 3 });
  assert.equal(m.status, 'pending');

  await s.engine.check(m.id);
  assert.equal(s.store.get(m.id).status, 'up');
  assert.equal(s.events.transition.length, 0, 'pending→up bez powiadomienia');

  s.results.push({ status: 'down', error: 'timeout' }, { status: 'down', error: 'timeout' }, { status: 'down', error: 'timeout' });
  s.tick(30e3); await s.engine.check(m.id);
  s.tick(30e3); await s.engine.check(m.id);
  let st = s.store.get(m.id);
  assert.equal(st.status, 'up', 'po 2/3 porażkach nadal UP');
  assert.equal(st.failCount, 2);
  assert.equal(s.events.transition.length, 0);

  s.tick(30e3); await s.engine.check(m.id);
  st = s.store.get(m.id);
  assert.equal(st.status, 'down');
  assert.equal(st.lastError, 'timeout');
  assert.equal(s.events.transition.length, 1);
  assert.deepEqual([s.events.transition[0].from, s.events.transition[0].to, s.events.transition[0].reason], ['up', 'down', 'timeout']);
  const downAt = s.now();

  s.results.push({ status: 'down', error: 'HTTP 502' });
  s.tick(30e3); await s.engine.check(m.id);
  assert.equal(s.events.transition.length, 1, 'kolejna porażka nie spamuje');

  let inc = s.engine && createHistory(s.db).incidents(m.id);
  assert.equal(inc.length, 1); assert.ok(inc[0].ongoing); assert.equal(inc[0].reason, 'timeout');

  s.tick(4 * 60e3); await s.engine.check(m.id);
  st = s.store.get(m.id);
  assert.equal(st.status, 'up', 'UP od razu po pierwszym sukcesie');
  assert.equal(st.failCount, 0);
  const rec = s.events.transition[1];
  assert.equal(rec.to, 'up');
  assert.equal(rec.downtimeMs, s.now() - downAt);
  inc = createHistory(s.db).incidents(m.id);
  assert.equal(inc[0].ongoing, false);
  assert.equal(inc[0].durationMs, s.now() - downAt);
  assert.equal(s.events.check.length, 6);
});

test('pending → DOWN powiadamia, WARN nie zamyka incydentu ani nie powiadamia', async () => {
  const s = setup();
  const m = s.store.create({ name: 'Bot', type: 'http', target: 'https://example.com', failThreshold: 1 });
  s.results.push({ status: 'down', error: 'wyłączony' });
  await s.engine.check(m.id);
  assert.equal(s.store.get(m.id).status, 'down');
  assert.equal(s.events.transition.length, 1);

  s.results.push({ status: 'warn', error: 'uruchamianie' });
  s.tick(5e3); await s.engine.check(m.id);
  assert.equal(s.store.get(m.id).status, 'warn');
  assert.equal(s.events.transition.length, 1, 'brak powiadomienia przy WARN');
  assert.ok(createHistory(s.db).incidents(m.id)[0].ongoing, 'incydent nadal otwarty');

  s.tick(5e3); await s.engine.check(m.id);
  assert.equal(s.store.get(m.id).status, 'up');
  assert.equal(s.events.transition.length, 2);
  assert.equal(s.events.transition[1].downtimeMs, 10e3);
});

test('pauza: brak sprawdzeń, status paused, wznowienie → pending', async () => {
  const s = setup();
  const m = s.store.create({ name: 'X', type: 'http', target: 'https://example.com' });
  s.store.setPaused(m.id, true);
  assert.equal(s.store.get(m.id).status, 'paused');
  assert.equal(await s.engine.check(m.id), null);
  s.store.setPaused(m.id, false);
  assert.equal(s.store.get(m.id).status, 'pending');
});

test('scheduler: interwał i limit równoległości', async () => {
  const s = setup();
  let active = 0, maxActive = 0, calls = 0;
  s.engine.check = async () => { active++; calls++; maxActive = Math.max(maxActive, active); await new Promise((r) => setTimeout(r, 20)); active--; };
  for (let i = 0; i < 6; i++) s.store.create({ name: `M${i}`, type: 'http', target: 'https://example.com', intervalS: 30 });
  s.store.create({ name: 'P', type: 'http', target: 'https://example.com', paused: true });
  const sch = createScheduler({ store: s.store, engine: s.engine, concurrency: 2, now: s.now });
  sch.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 6, 'wstrzymany pominięty');
  assert.equal(maxActive, 2);
  s.tick(10e3); sch.tick();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls, 6, 'interwał jeszcze nie minął');
  s.tick(20e3); sch.tick();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(calls, 12);
});

test('historia: kubełki 5 min / 1 h / 6 h, uptime, latencja, gracze, CPU', () => {
  const s = setup();
  const m = s.store.create({ name: 'F', type: 'fivem', target: '1.2.3.4:30120' });
  assert.equal(m.target, 'http://1.2.3.4:30120');
  const ins = s.db.prepare('INSERT INTO checks (monitor_id, ts, ok, latency_ms, players, cpu, mem_bytes) VALUES (?,?,?,?,?,?,?)');
  const now = Date.UTC(2026, 0, 10, 12, 0, 0);
  // 4 pomiary w jednym kubełku 5-min: 3 OK, 1 porażka
  const b0 = now - 10 * 60e3;
  ins.run(m.id, b0 + 1000, 1, 100, 10, 20, 100);
  ins.run(m.id, b0 + 2000, 1, 200, 30, 40, 300);
  ins.run(m.id, b0 + 3000, 1, 300, 20, 30, 200);
  ins.run(m.id, b0 + 4000, 0, null, null, null, null);
  // poza zakresem 24h
  ins.run(m.id, now - 2 * 24 * 3600e3, 0, null, null, null, null);
  // 10 dni temu — tylko w 30d
  ins.run(m.id, now - 10 * 24 * 3600e3, 1, 50, 5, 1, 1);

  const h = createHistory(s.db);
  const d = h.get(m.id, '24h', now);
  assert.equal(d.bucketMs, 5 * 60e3);
  assert.equal(d.buckets.length, 1);
  assert.deepEqual(d.buckets[0], { t: b0, n: 4, up: 75, lat: 200, pl: 30, cpu: 30, mem: 200 });
  assert.equal(d.summary.uptime, 75);
  assert.equal(h.get(m.id, '7d', now).buckets.length, 2);
  assert.equal(h.get(m.id, '7d', now).bucketMs, 3600e3);
  const m30 = h.get(m.id, '30d', now);
  assert.equal(m30.bucketMs, 6 * 3600e3);
  assert.equal(m30.buckets.length, 3);
  assert.equal(m30.summary.checks, 6);
  assert.ok(m30.buckets.every((b) => b.t % (6 * 3600e3) === 0));
  assert.throws(() => h.get(m.id, '1y'));

  const ov = h.overview(now);
  assert.equal(ov.monitors[m.id].uptime, 75);
  assert.equal(ov.monitors[m.id].spark.length, 1);

  const r = createRetention({ db: s.db, days: 30, log: {} }).run(now + 29 * 24 * 3600e3);
  assert.equal(r.checks, 2, 'usunięte pomiary starsze niż 30 dni');
});
