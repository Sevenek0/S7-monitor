/**
 * Fałszywy serwer FiveM: /dynamic.json, /players.json, /info.json.
 * Sterowanie: obiekt `state` albo GET /__control?online=0&paranoia=1&players=12
 */
import { json, startServer } from './util.js';

const NAMES = ['^1Kowal^7ski', 'Nowak', '^2Zielony^0', 'Wiśniewski', 'Mati_PL', '^5Ziomek^7', 'Kasia', 'Bartek', 'RP_Janek', 'Szybki Lopez',
  'Ola', '^3Medyk^7 Ania', 'Patrol 12', 'Kuba', 'Dawid', 'Ewa_EMS', 'Marek', 'Gosia', 'Tomek', 'Pawel', 'Zosia', 'Krzysiek'];

export function makePlayers(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: NAMES[i % NAMES.length] + (i >= NAMES.length ? ` ${i}` : ''),
    ping: 20 + ((i * 37) % 140),
    identifiers: [`license:${'a'.repeat(40)}${i}`, `discord:12345${i}`, `ip:10.0.0.${i}`],
    endpoint: '127.0.0.1',
  }));
}

export async function startFivemMock({ port = 0, players = 18, maxClients = 64 } = {}) {
  const state = { online: true, paranoia: false, slowMs: 0, players: makePlayers(players), maxClients };
  const s = await startServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/__control') {
      for (const k of ['online', 'paranoia']) if (url.searchParams.has(k)) state[k] = url.searchParams.get(k) === '1';
      if (url.searchParams.has('players')) state.players = makePlayers(Number(url.searchParams.get('players')));
      return json(res, 200, { online: state.online, paranoia: state.paranoia, players: state.players.length });
    }
    if (!state.online) { req.socket.destroy(); return; }
    if (state.slowMs) await new Promise((r) => setTimeout(r, state.slowMs));
    switch (url.pathname) {
      case '/dynamic.json':
        return json(res, 200, {
          clients: state.players.length, gametype: 'Roleplay', hostname: '^1S7^7 RolePlay ^2| Polska^0',
          iv: '0', mapname: 'Los Santos', sv_maxclients: String(state.maxClients),
        });
      case '/players.json':
        if (state.paranoia) return json(res, 404, { error: 'Not found' });
        return json(res, 200, state.players);
      case '/info.json':
        return json(res, 200, {
          enhancedHostSupport: true, icon: '',
          resources: Array.from({ length: 142 }, (_, i) => `res_${i}`),
          server: 'FXServer-master SERVER v1.0.0.12913 linux',
          vars: { sv_projectName: '^1S7 RP' }, version: 12913,
        });
      default:
        return json(res, 404, { error: 'Not found' });
    }
  }, port);
  return { ...s, state };
}
