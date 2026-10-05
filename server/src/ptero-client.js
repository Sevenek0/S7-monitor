/**
 * Klient Pterodactyl Client API. URL i klucz pochodzą wyłącznie z .env —
 * nigdy nie trafiają do bazy ani do frontendu.
 */
const DETAILS_TTL = 10 * 60 * 1000;
export const POWER_SIGNALS = ['start', 'stop', 'restart', 'kill'];

export function createPteroClient({ url, key, fetch = globalThis.fetch, timeoutMs = 10_000 }) {
  const enabled = Boolean(url && key);
  const cache = new Map();

  async function request(path, { method = 'GET', body } = {}) {
    if (!enabled) throw new Error('Pterodactyl nie jest skonfigurowany');
    const res = await fetch(`${url}${path}`, {
      method,
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        authorization: `Bearer ${key}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let detail = '';
      try { detail = JSON.parse(text)?.errors?.[0]?.detail || ''; } catch { /* brak */ }
      const err = new Error(`Pterodactyl HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
      err.status = res.status;
      err.reason = `HTTP ${res.status}`;
      throw err;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  const enc = (id) => encodeURIComponent(id);

  return {
    enabled,
    async resources(id) {
      const j = await request(`/api/client/servers/${enc(id)}/resources`);
      return j?.attributes;
    },
    async serverDetails(id, now = Date.now()) {
      const c = cache.get(id);
      if (c && now - c.at < DETAILS_TTL) return c.value;
      const j = await request(`/api/client/servers/${enc(id)}`);
      const a = j?.attributes || {};
      const value = {
        id: a.identifier || id,
        name: a.name || id,
        limits: { memory: a.limits?.memory ?? null, cpu: a.limits?.cpu ?? null, disk: a.limits?.disk ?? null },
      };
      cache.set(id, { at: now, value });
      return value;
    },
    async power(id, signal) {
      if (!POWER_SIGNALS.includes(signal)) throw new Error('Niepoprawny sygnał');
      await request(`/api/client/servers/${enc(id)}/power`, { method: 'POST', body: { signal } });
    },
    async listServers() {
      const out = [];
      for (let page = 1; page <= 20; page++) {
        const j = await request(`/api/client?page=${page}&per_page=100`);
        for (const s of j?.data || []) {
          const a = s.attributes || {};
          out.push({
            id: a.identifier,
            name: a.name,
            description: a.description || '',
            node: a.node || '',
            limits: { memory: a.limits?.memory ?? null, cpu: a.limits?.cpu ?? null, disk: a.limits?.disk ?? null },
          });
        }
        const p = j?.meta?.pagination;
        if (!p || p.current_page >= p.total_pages) break;
      }
      return out;
    },
  };
}
