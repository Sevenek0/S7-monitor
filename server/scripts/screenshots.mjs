/**
 * Zrzuty ekranu UI w Playwright: PC (1440 px) i iPhone (390 px).
 * Wymaga działającego serwera (np. npm run dev:mock).
 *   BASE_URL=http://localhost:3000 APP_PASSWORD=admin npm run screenshots
 * Zapisuje PNG do ../screenshots i zgłasza poziomy scroll oraz błędy konsoli.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'screenshots');
const BASE = process.env.BASE_URL || 'http://localhost:3000';
const PASSWORD = process.env.APP_PASSWORD || 'admin';
fs.mkdirSync(OUT, { recursive: true });

const { token } = await (await fetch(`${BASE}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) })).json();
const { monitors } = await (await fetch(`${BASE}/api/monitors`, { headers: { authorization: `Bearer ${token}` } })).json();
const byType = (t) => monitors.find((m) => m.type === t);

const browser = await chromium.launch();
const problems = [];

const DEVICES = {
  pc: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  iphone: {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  },
};

async function shot(page, device, name, { fullPage = true } = {}) {
  await page.waitForTimeout(500);
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const bad = [];
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.right > w + 1 || r.left < -1) && getComputedStyle(el).position !== 'fixed' && !el.closest('.panel:not(.open)')) bad.push(`${el.tagName.toLowerCase()}.${[...el.classList].join('.')} (${Math.round(r.left)}–${Math.round(r.right)})`);
    }
    return { scroll: document.documentElement.scrollWidth > w, w, sw: document.documentElement.scrollWidth, bad: bad.slice(0, 5) };
  });
  if (overflow.scroll || overflow.bad.length) problems.push(`[${device}/${name}] poziomy overflow: scrollWidth=${overflow.sw} > ${overflow.w}; ${overflow.bad.join(', ')}`);
  const file = path.join(OUT, `${device}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  console.log('📸', path.relative(ROOT, file));
}

for (const [device, opts] of Object.entries(DEVICES)) {
  const ctx = await browser.newContext({ ...opts, locale: 'pl-PL', timezoneId: 'Europe/Warsaw', colorScheme: 'dark', serviceWorkers: 'block' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') problems.push(`[${device}] konsola: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${device}] wyjątek: ${e.message}`));

  await page.goto(`${BASE}/#/login`);
  await page.waitForSelector('#login-form');
  await shot(page, device, 'login', { fullPage: false });

  await page.evaluate((t) => localStorage.setItem('s7_token', t), token);
  await page.goto(`${BASE}/#/`);
  await page.waitForSelector('.card');
  await page.waitForFunction(() => document.querySelector('#live')?.dataset.state === 'live');
  await shot(page, device, 'dashboard');

  for (const [label, m] of [['fivem', byType('fivem')], ['bot', byType('pterodactyl')], ['strona', byType('http')]]) {
    if (!m) continue;
    await page.goto(`${BASE}/#/m/${m.id}`);
    await page.waitForSelector('.panel.open .chart svg');
    await page.waitForTimeout(400);
    if (device === 'pc') {
      await shot(page, device, `szczegoly-${label}`, { fullPage: false });
    } else {
      // pełny ekran panelu: zrzut przewijanej zawartości
      const h = await page.evaluate(() => document.querySelector('#d-body').scrollHeight + 70);
      await page.setViewportSize({ width: 390, height: Math.min(h, 4000) });
      await shot(page, device, `szczegoly-${label}`, { fullPage: false });
      await page.setViewportSize(opts.viewport);
    }
  }
  // hover na wykresie (tooltip)
  if (device === 'pc') {
    const svg = page.locator('.panel .chart svg').first();
    const box = await svg.boundingBox();
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await shot(page, device, 'wykres-tooltip', { fullPage: false });
  }
  await page.goto(`${BASE}/#/`);
  await page.goto(`${BASE}/#/settings`);
  await page.waitForSelector('.mrow');
  await shot(page, device, 'ustawienia');
  await page.click('[data-act="add"]');
  await page.waitForSelector('.modal');
  await page.click('#f-type button[data-type="fivem"]');
  await page.waitForTimeout(300);
  await shot(page, device, 'formularz', { fullPage: false });
  await page.keyboard.press('Escape');
  await page.click('[data-act="import"]');
  await page.waitForSelector('.check-item');
  await shot(page, device, 'import', { fullPage: false });
  await ctx.close();
}
await browser.close();

if (problems.length) {
  console.log('\n⚠️  Problemy:'); for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
} else console.log('\n✅ Brak poziomego scrolla i błędów konsoli.');
