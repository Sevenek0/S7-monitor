/**
 * npm run dev:mock — uruchamia lokalnie mocki FiveM/Pterodactyl/strony WWW
 * oraz S7 Monitor z przykładowymi monitorami i 30-dniową historią.
 *
 *   http://localhost:3000   hasło: admin   (zmień przez APP_PASSWORD)
 *
 * Sterowanie mockami (np. symulacja awarii):
 *   curl "http://127.0.0.1:30121/__control?online=0"        # FiveM pada
 *   curl "http://127.0.0.1:8091/__control?down=1"           # strona zwraca 503
 *   curl "http://127.0.0.1:8090/__control?id=a1b2c3d4&state=offline"  # bot offline
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from '../src/config.js';
import { createServices } from '../src/services.js';
import { startFivemMock } from './fivem-mock.js';
import { startPteroMock } from './ptero-mock.js';
import { startSiteMock } from './site-mock.js';
import { startAgentMock } from './agent-mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.DATA_DIR || path.join(ROOT, '.dev-data');
const fresh = !process.argv.includes('--keep');
if (fresh) fs.rmSync(dataDir, { recursive: true, force: true });

const fivem = await startFivemMock({ port: Number(process.env.MOCK_FIVEM_PORT || 30121), players: 23, maxClients: 64 });
const ptero = await startPteroMock({ port: Number(process.env.MOCK_PTERO_PORT || 8090) });
const site = await startSiteMock({ port: Number(process.env.MOCK_SITE_PORT || 8091) });
const agent = await startAgentMock({ port: Number(process.env.MOCK_AGENT_PORT || 8092) });

const config = createConfig({
  ...process.env,
  DATA_DIR: dataDir,
  APP_PASSWORD: process.env.APP_PASSWORD || 'admin',
  PTERO_URL: ptero.url,
  PTERO_KEY: ptero.key,
  S7_AGENT_URL: agent.url,
  PORT: process.env.PORT || '3000',
});

const svc = createServices(config, {
  // Lokalnie nie ma prawdziwych serwerów push — logujemy zamiast wysyłać.
  pushSender: async (sub, body) => console.log(`[mock web-push] → ${sub.endpoint.slice(0, 50)}… ${body}`),
});

function seed() {
  const { store, db } = svc;
  if (store.list().length) return;
  const defs = [
    { name: 'S7 RolePlay', type: 'fivem', target: fivem.url, pteroServerId: 'f00dbabe' },
    { name: 'Bot EMS', type: 'pterodactyl', pteroServerId: 'a1b2c3d4' },
    { name: 'Bot Policja', type: 'pterodactyl', pteroServerId: 'e5f6a7b8' },
    { name: 'Bot Ekonomia', type: 'pterodactyl', pteroServerId: 'c9d0e1f2' },
    { name: 'Community Bot', type: 'service', target: 'community-bot' },
    { name: 'Strona S7', type: 'http', target: `${site.url}/`, keyword: 'Witaj' },
    { name: 'Panel sklepu', type: 'http', target: `${site.url}/redirect` },
    { name: 'Wiki serwera', type: 'http', target: `${site.url}/error` },
  ];
  const monitors = defs.map((d, i) => store.create({ ...d, sort: i }));

  // 30 dni syntetycznej historii co 5 minut.
  const now = Date.now();
  const step = 5 * 60e3;
  const ins = db.prepare('INSERT INTO checks (monitor_id, ts, ok, latency_ms, players, cpu, mem_bytes) VALUES (?,?,?,?,?,?,?)');
  const inc = db.prepare('INSERT INTO incidents (monitor_id, started_at, ended_at, reason) VALUES (?,?,?,?)');
  let seedRand = 42;
  const rnd = () => { seedRand = (seedRand * 16807) % 2147483647; return seedRand / 2147483647; };
  const outages = {
    [monitors[0].id]: [[now - 3 * 24 * 3600e3, 18 * 60e3, 'timeout'], [now - 9 * 3600e3, 6 * 60e3, 'połączenie odrzucone']],
    [monitors[1].id]: [[now - 12 * 24 * 3600e3, 45 * 60e3, 'wyłączony'], [now - 5 * 3600e3, 4 * 60e3, 'wyłączony']],
    [monitors[3].id]: [[now - 2 * 3600e3, 2 * 3600e3, 'wyłączony']],
    [monitors[5].id]: [[now - 6 * 24 * 3600e3, 12 * 60e3, 'HTTP 502']],
    [monitors[7].id]: [[now - 40 * 60e3, 40 * 60e3, 'HTTP 500']],
  };
  db.transaction(() => {
    for (const m of monitors) {
      const outs = outages[m.id] || [];
      for (const [start, dur, reason] of outs) inc.run(m.id, start, start + dur < now - 60e3 ? start + dur : null, reason);
      for (let ts = now - 30 * 24 * 3600e3; ts < now - step; ts += step) {
        const down = outs.some(([s, d]) => ts >= s && ts < s + d);
        const hour = new Date(ts).getHours() + new Date(ts).getMinutes() / 60;
        const wave = (Math.cos(((hour - 21) / 24) * 2 * Math.PI) + 1) / 2; // szczyt ok. 21:00
        if (m.type === 'fivem') {
          const pl = Math.round(4 + wave * 50 + rnd() * 6);
          ins.run(m.id, ts, down ? 0 : 1, down ? null : Math.round(25 + rnd() * 30), down ? null : pl, down ? null : 40 + pl * 1.2 + rnd() * 10, down ? null : Math.round((3.4 + pl * 0.02) * 1e9));
        } else if (m.type === 'pterodactyl' || m.type === 'service') {
          ins.run(m.id, ts, down ? 0 : 1, down ? null : Math.round(60 + rnd() * 40), null, down ? null : 2 + wave * 6 + rnd() * 3, down ? null : Math.round((120 + wave * 60 + rnd() * 20) * 1e6));
        } else {
          ins.run(m.id, ts, down ? 0 : 1, down ? null : Math.round(80 + wave * 120 + rnd() * 60 + (rnd() > 0.98 ? 600 : 0)), null, null, null);
        }
      }
    }
  })();
  console.log(`[dev:mock] Utworzono ${monitors.length} przykładowych monitorów z historią 30 dni`);
}

seed();
svc.app.listen(config.port, '0.0.0.0', () => {
  svc.start();
  const W = 55;
  const row = (t) => `  │ ${t.padEnd(W - 2)} │`;
  console.log([
    '',
    `  ┌${'─'.repeat(W)}┐`,
    row(`S7 Monitor (tryb mock): http://localhost:${config.port}`),
    row(`Hasło: ${config.password}`),
    `  ├${'─'.repeat(W)}┤`,
    row(`Mock FiveM:        ${fivem.url}`),
    row(`Mock Pterodactyl:  ${ptero.url}`),
    row(`Mock strona:       ${site.url}`),
    row(`Mock agent VPS:    ${agent.url}`),
    `  └${'─'.repeat(W)}┘`,
    `  Symulacja awarii FiveM:  curl "${fivem.url}/__control?online=0"`,
    `  Powrót:                  curl "${fivem.url}/__control?online=1"`,
    '',
  ].join('\n'));
});
