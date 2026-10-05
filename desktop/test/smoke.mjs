/**
 * Test dymny aplikacji desktop (Linux + Xvfb, Playwright _electron).
 * Wymaga działającego `npm run dev:mock` w server/ (http://localhost:3000, hasło admin).
 *   xvfb-run -a node test/smoke.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { _electron } = require('../../server/node_modules/playwright');
const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const SHOTS = path.join(DIR, '..', 'screenshots');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 's7desk-'));
const ok = (cond, msg) => { if (!cond) throw new Error(`❌ ${msg}`); console.log(`✔ ${msg}`); };

const app = await _electron.launch({
  executablePath: require('electron'),
  args: ['--no-sandbox', DIR],
  env: { ...process.env, XDG_CONFIG_HOME: home, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
});
try {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__notes = []; globalThis.__status = [];
    ipcMain.on('desktop:notify', (_e, n) => globalThis.__notes.push(n));
    ipcMain.on('desktop:status', (_e, s) => globalThis.__status.push(s.status));
  });
  const appId = await app.evaluate(({ app }) => app.getName());
  console.log('  nazwa aplikacji:', appId);
  let win = await app.firstWindow();
  await win.waitForSelector('#url');
  ok(win.url().startsWith('file:') && win.url().endsWith('setup.html'), 'pierwsze uruchomienie pokazuje ekran konfiguracji');
  const webPrefs = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    return w.webContents.getLastWebPreferences?.() || {};
  });
  ok(webPrefs.contextIsolation === true && webPrefs.nodeIntegration === false, 'contextIsolation: true, nodeIntegration: false');
  ok(await win.evaluate(() => typeof require === 'undefined' && typeof process === 'undefined'), 'brak Node w rendererze');
  await win.screenshot({ path: path.join(SHOTS, 'desktop-setup.png') });

  await win.fill('#url', 'http://127.0.0.1:1');
  await win.click('button');
  await win.waitForFunction(() => document.querySelector('#err').textContent.length > 0);
  ok(true, `zły adres → błąd: "${await win.textContent('#err')}"`);

  await win.fill('#url', BASE);
  await win.click('button');
  await win.waitForURL(`${BASE}/**`);
  await win.waitForSelector('#login-form');
  const cfg = JSON.parse(fs.readFileSync(path.join(home, 'S7 Monitor', 'config.json'), 'utf8'));
  ok(cfg.serverUrl === new URL(BASE).origin, `adres zapisany w userData/config.json (${cfg.serverUrl})`);
  ok(await win.evaluate(() => window.desktop?.isDesktop === true), 'window.desktop dostępne przez preload');

  await win.fill('#pw', 'admin');
  await win.click('#login-form button');
  await win.waitForSelector('.card');
  await win.waitForFunction(() => document.querySelector('#live')?.dataset.state === 'live');
  await win.waitForTimeout(500);
  let st = await app.evaluate(() => globalThis.__status.at(-1));
  ok(st === 'down', `tray: czerwony przy awariach (status=${st})`);
  await win.screenshot({ path: path.join(SHOTS, 'desktop-dashboard.png') });

  // Awaria FiveM → natywne powiadomienie przez IPC
  const token = await win.evaluate(() => localStorage.getItem('s7_token'));
  await fetch('http://127.0.0.1:30121/__control?online=0');
  for (let i = 0; i < 2; i++) await fetch(`${BASE}/api/monitors/1/check`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await win.waitForTimeout(800);
  const notes = await app.evaluate(() => globalThis.__notes);
  ok(notes.some((n) => n.title.startsWith('PADŁ: S7 RolePlay') && n.monitorId === 1), `powiadomienie Windows: "${notes.at(-1)?.title}"`);
  await fetch('http://127.0.0.1:30121/__control?online=1');
  await fetch(`${BASE}/api/monitors/1/check`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await win.waitForTimeout(800);
  ok((await app.evaluate(() => globalThis.__notes)).some((n) => n.title.startsWith('Działa znowu: S7 RolePlay')), 'powiadomienie o powrocie');

  // Kliknięcie powiadomienia → otwarcie szczegółów monitora
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send('desktop:open-monitor', 1));
  await win.waitForSelector('.panel.open');
  ok(win.url().endsWith('#/m/1'), 'kliknięcie powiadomienia otwiera szczegóły monitora');

  // Blokada nawigacji poza serwer
  await win.evaluate(() => { location.href = 'https://example.com/'; });
  await win.waitForTimeout(800);
  ok(win.url().startsWith(BASE), 'nawigacja poza serwer zablokowana');

  // Zamknięcie okna → chowa do traya
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await win.waitForTimeout(300);
  const visible = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()));
  ok(visible.length === 1 && visible[0] === false, 'zamknięcie okna chowa aplikację do traya');
} finally {
  await app.evaluate(({ app }) => { app.exit(0); }).catch(() => {});
}
console.log('\n✅ Test aplikacji desktop zaliczony');
