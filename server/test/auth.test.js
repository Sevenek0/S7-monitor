import test from 'node:test';
import assert from 'node:assert/strict';
import { createToken, verifyToken, passwordMatches, createLoginLimiter } from '../src/auth.js';
import { createApp } from '../src/app.js';
import { tmpConfig, listen } from './helpers.js';

test('token HMAC: poprawny, zmieniony, wygasły', () => {
  const t = createToken('s', 1000, 0);
  assert.ok(verifyToken('s', t, 500));
  assert.equal(verifyToken('s', t, 2000), null, 'wygasły');
  assert.equal(verifyToken('inny', t, 500), null, 'zły sekret');
  assert.equal(verifyToken('s', t.slice(0, -2) + 'xx', 500), null, 'zmieniony podpis');
  assert.equal(verifyToken('s', 'śmieci', 500), null);
});

test('porównanie hasła', () => {
  assert.ok(passwordMatches('abc', 'abc'));
  assert.ok(!passwordMatches('abc', 'abcd'));
  assert.ok(!passwordMatches('', ''));
  assert.ok(!passwordMatches('abc', undefined));
});

test('limiter logowania', () => {
  const l = createLoginLimiter({ limit: 2, windowMs: 1000 });
  l.fail('a', 0); l.fail('a', 0);
  assert.equal(l.check('a', 10).allowed, false);
  assert.equal(l.check('b', 10).allowed, true);
  assert.equal(l.check('a', 1001).allowed, true);
});

test('API: health publiczne, reszta wymaga tokenu, login + rate limit', async () => {
  const config = tmpConfig();
  const app = createApp({ config, limiter: createLoginLimiter({ limit: 3 }) });
  const s = await listen(app);
  try {
    assert.equal((await fetch(`${s.url}/api/health`)).status, 200);
    assert.equal((await fetch(`${s.url}/api/monitors`)).status, 401);
    const post = (pw) => fetch(`${s.url}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: pw }) });
    const ok = await post('tajne-haslo');
    assert.equal(ok.status, 200);
    const { token } = await ok.json();
    assert.ok(token);
    const authed = await fetch(`${s.url}/api/nic`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(authed.status, 404, 'z tokenem przechodzi przez auth');
    const viaQuery = await fetch(`${s.url}/api/nic?token=${encodeURIComponent(token)}`);
    assert.equal(viaQuery.status, 404, 'token w query (SSE)');
    for (let i = 0; i < 3; i++) assert.equal((await post('zle')).status, 401);
    assert.equal((await post('tajne-haslo')).status, 429, 'zablokowane po 3 próbach');
  } finally { await s.close(); }
});
