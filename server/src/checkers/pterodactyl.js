import { describeError } from './util.js';

export const STATE_MAP = { running: 'up', offline: 'down', starting: 'warn', stopping: 'warn' };
const STATE_PL = { running: 'działa', offline: 'wyłączony', starting: 'uruchamianie', stopping: 'zatrzymywanie' };

/** Pobiera zasoby i limity serwera z Pterodactyla. Zwraca obiekt `ptero` dla data. */
export async function fetchPteroInfo(ptero, serverId) {
  const start = performance.now();
  const r = await ptero.resources(serverId);
  const latency = Math.round(performance.now() - start);
  let limits = null;
  let name = null;
  try {
    const d = await ptero.serverDetails(serverId);
    limits = d.limits; name = d.name;
  } catch { /* limity są opcjonalne */ }
  const res = r?.resources || {};
  return {
    latency,
    info: {
      state: r?.current_state || 'unknown',
      cpu: typeof res.cpu_absolute === 'number' ? Math.round(res.cpu_absolute * 10) / 10 : null,
      mem: res.memory_bytes ?? null,
      disk: res.disk_bytes ?? null,
      uptime: res.uptime ?? null,
      name,
      limits,
    },
  };
}

export async function checkPterodactyl(monitor, { ptero } = {}) {
  if (!ptero?.enabled) return { status: 'down', error: 'Pterodactyl nie jest skonfigurowany (PTERO_URL/PTERO_KEY)' };
  let r;
  try {
    r = await fetchPteroInfo(ptero, monitor.pteroServerId);
  } catch (err) {
    return { status: 'down', error: err.status === 404 ? 'serwer nie istnieje w panelu' : `panel: ${describeError(err)}` };
  }
  const { info, latency } = r;
  const status = STATE_MAP[info.state] || 'warn';
  return {
    status,
    latency,
    cpu: info.cpu,
    mem: info.mem,
    error: status === 'up' ? null : (STATE_PL[info.state] || info.state),
    data: { ptero: info },
  };
}
