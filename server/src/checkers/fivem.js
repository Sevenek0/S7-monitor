import { describeError, stripColors, TIMEOUT_MS } from './util.js';

const INFO_TTL = 5 * 60 * 1000;
const infoCache = new Map();

async function getJson(fetch, url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) {
    res.body?.cancel().catch(() => {});
    const e = new Error(`HTTP ${res.status}`);
    e.reason = `HTTP ${res.status}`;
    throw e;
  }
  return res.json();
}

/** Lista graczy bez identifiers — tylko id, nick (bez kolorów) i ping. */
export function sanitizePlayers(list) {
  if (!Array.isArray(list)) return [];
  return list.map((p) => ({ id: Number(p?.id) || 0, name: stripColors(p?.name) || '?', ping: Number(p?.ping) || 0 }))
    .sort((a, b) => a.id - b.id);
}

export async function checkFivem(monitor, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS, now = Date.now() } = {}) {
  const base = monitor.target.replace(/\/+$/, '');
  const start = performance.now();
  let dyn;
  try {
    dyn = await getJson(fetch, `${base}/dynamic.json`, timeoutMs);
  } catch (err) {
    return { status: 'down', error: describeError(err) };
  }
  const latency = Math.round(performance.now() - start);

  const [playersRes, infoRes] = await Promise.allSettled([
    getJson(fetch, `${base}/players.json`, timeoutMs),
    (async () => {
      const c = infoCache.get(base);
      if (c && now - c.at < INFO_TTL) return c.value;
      const info = await getJson(fetch, `${base}/info.json`, timeoutMs);
      const value = { version: info?.server ? String(info.server) : null, resources: Array.isArray(info?.resources) ? info.resources.length : null };
      infoCache.set(base, { at: now, value });
      return value;
    })(),
  ]);

  const playersAvailable = playersRes.status === 'fulfilled' && Array.isArray(playersRes.value);
  const players = playersAvailable ? sanitizePlayers(playersRes.value) : [];
  const clients = Number(dyn?.clients);
  const data = {
    hostname: stripColors(dyn?.hostname) || null,
    clients: Number.isFinite(clients) ? clients : players.length,
    maxClients: Number(dyn?.sv_maxclients) || null,
    gametype: dyn?.gametype ? stripColors(dyn.gametype) : null,
    mapname: dyn?.mapname ? stripColors(dyn.mapname) : null,
    playersAvailable,
    players,
    version: infoRes.status === 'fulfilled' ? infoRes.value.version : null,
    resources: infoRes.status === 'fulfilled' ? infoRes.value.resources : null,
  };
  return { status: 'up', latency, players: data.clients, data };
}

export function _clearFivemCache() { infoCache.clear(); }
