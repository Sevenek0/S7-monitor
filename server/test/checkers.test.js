import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHttp, codeMatches } from '../src/checkers/http.js';
import { checkFivem, _clearFivemCache } from '../src/checkers/fivem.js';
import { checkPterodactyl, STATE_MAP } from '../src/checkers/pterodactyl.js';
import { runChecker } from '../src/checkers/index.js';
import { stripColors } from '../src/checkers/util.js';
import { createPteroClient } from '../src/ptero-client.js';
import { startFivemMock } from '../mock/fivem-mock.js';
import { startPteroMock } from '../mock/ptero-mock.js';
import { startSiteMock } from '../mock/site-mock.js';

test('kody HTTP i kolory', () => {
  assert.ok(codeMatches('200-399', 301));
  assert.ok(!codeMatches('200-399', 404));
  assert.ok(codeMatches('200,404', 404));
  assert.ok(codeMatches(null, 200));
  assert.equal(stripColors('^1S7^7 RP ^2|^0 PL'), 'S7 RP | PL');
});

test('HTTP: OK, przekierowanie, słowo kluczowe, kod, timeout, odmowa', async (t) => {
  const site = await startSiteMock({ slowMs: 2000 });
  t.after(() => site.close());
  let r = await checkHttp({ target: `${site.url}/` });
  assert.equal(r.status, 'up'); assert.ok(r.latency >= 0);
  r = await checkHttp({ target: `${site.url}/redirect`, keyword: 'Witaj' });
  assert.equal(r.status, 'up', 'przekierowanie + słowo');
  assert.equal(r.data.finalUrl, `${site.url}/`);
  r = await checkHttp({ target: `${site.url}/`, keyword: 'Nie ma mnie' });
  assert.equal(r.status, 'down'); assert.equal(r.error, 'brak słowa kluczowego');
  r = await checkHttp({ target: `${site.url}/error` });
  assert.equal(r.status, 'down'); assert.equal(r.error, 'HTTP 500');
  r = await checkHttp({ target: `${site.url}/error`, expectedCodes: '500' });
  assert.equal(r.status, 'up', 'własny oczekiwany kod');
  r = await checkHttp({ target: `${site.url}/slow` }, { timeoutMs: 300 });
  assert.equal(r.status, 'down'); assert.equal(r.error, 'timeout');
  r = await checkHttp({ target: 'http://127.0.0.1:59998/' });
  assert.equal(r.status, 'down'); assert.equal(r.error, 'połączenie odrzucone');
});

test('FiveM: dane, brak identifiers, kolory, paranoia, offline', async (t) => {
  _clearFivemCache();
  const fm = await startFivemMock({ players: 5, maxClients: 48 });
  t.after(() => fm.close());
  let r = await checkFivem({ target: fm.url });
  assert.equal(r.status, 'up');
  assert.equal(r.players, 5);
  assert.equal(r.data.hostname, 'S7 RolePlay | Polska');
  assert.equal(r.data.maxClients, 48);
  assert.equal(r.data.resources, 142);
  assert.match(r.data.version, /FXServer/);
  assert.equal(r.data.players.length, 5);
  assert.equal(r.data.players[0].name, 'Kowalski');
  assert.deepEqual(Object.keys(r.data.players[0]).sort(), ['id', 'name', 'ping']);
  assert.ok(!JSON.stringify(r).includes('license:'), 'identifiers nie mogą wyciec');
  assert.ok(!JSON.stringify(r).includes('ip:10'), 'identifiers nie mogą wyciec');

  fm.state.paranoia = true;
  r = await checkFivem({ target: fm.url });
  assert.equal(r.status, 'up', 'sv_requestParanoia → nadal UP');
  assert.equal(r.data.playersAvailable, false);
  assert.equal(r.players, 5, 'liczba graczy z dynamic.json');

  fm.state.online = false;
  r = await checkFivem({ target: fm.url });
  assert.equal(r.status, 'down');
});

test('Pterodactyl: mapowanie stanów, zasoby, limity, zasilanie, lista, zły klucz', async (t) => {
  const pm = await startPteroMock({ transitionMs: 50 });
  t.after(() => pm.close());
  const ptero = createPteroClient({ url: pm.url, key: pm.key });
  assert.deepEqual(STATE_MAP, { running: 'up', offline: 'down', starting: 'warn', stopping: 'warn' });

  let r = await checkPterodactyl({ pteroServerId: 'a1b2c3d4' }, { ptero });
  assert.equal(r.status, 'up');
  assert.ok(r.cpu > 0 && r.mem > 0);
  assert.equal(r.data.ptero.limits.memory, 512);
  r = await checkPterodactyl({ pteroServerId: 'c9d0e1f2' }, { ptero });
  assert.equal(r.status, 'down'); assert.equal(r.error, 'wyłączony');

  await ptero.power('c9d0e1f2', 'start');
  r = await checkPterodactyl({ pteroServerId: 'c9d0e1f2' }, { ptero });
  assert.equal(r.status, 'warn', 'starting → WARN');
  await new Promise((res) => setTimeout(res, 80));
  r = await checkPterodactyl({ pteroServerId: 'c9d0e1f2' }, { ptero });
  assert.equal(r.status, 'up');
  assert.deepEqual(pm.powerLog.map((p) => p.signal), ['start']);
  await assert.rejects(ptero.power('c9d0e1f2', 'boom'));

  const list = await ptero.listServers();
  assert.equal(list.length, 4);
  assert.ok(list.find((s) => s.id === 'a1b2c3d4' && s.name === 'Bot EMS'));

  r = await checkPterodactyl({ pteroServerId: 'nieistnieje' }, { ptero });
  assert.equal(r.status, 'down'); assert.match(r.error, /nie istnieje/);
  const bad = createPteroClient({ url: pm.url, key: 'ptlc_zly' });
  r = await checkPterodactyl({ pteroServerId: 'a1b2c3d4' }, { ptero: bad });
  assert.equal(r.status, 'down'); assert.match(r.error, /401/);
  r = await checkPterodactyl({ pteroServerId: 'a1b2c3d4' }, { ptero: createPteroClient({}) });
  assert.match(r.error, /nie jest skonfigurowany/);
});

test('pteroServerId na monitorze FiveM dokłada CPU/RAM', async (t) => {
  _clearFivemCache();
  const fm = await startFivemMock({ players: 3 });
  const pm = await startPteroMock();
  t.after(() => Promise.all([fm.close(), pm.close()]));
  const ptero = createPteroClient({ url: pm.url, key: pm.key });
  const r = await runChecker({ type: 'fivem', target: fm.url, pteroServerId: 'f00dbabe' }, { ptero });
  assert.equal(r.status, 'up');
  assert.equal(r.players, 3);
  assert.ok(r.cpu > 50);
  assert.equal(r.data.ptero.state, 'running');
});
