import { STATE_MAP } from './pterodactyl.js';

const STATE_PL = { offline: 'usługa zatrzymana', starting: 'uruchamianie', stopping: 'zatrzymywanie' };

/** Stan systemd → stan w stylu Pterodactyla (te same etykiety i kolory w aplikacji). */
export function serviceState(svc) {
  if (svc.active === 'active') return 'running';
  if (svc.active === 'activating' || svc.active === 'reloading') return 'starting';
  if (svc.active === 'deactivating') return 'stopping';
  return 'offline';
}

/** Monitor typu "service": usługa systemd na VPS-ie (bot, API), odczytywana przez S7 Agenta. */
export async function checkService(monitor, { host } = {}) {
  if (!host?.enabled) return { status: 'down', error: 'Agent serwera nie jest skonfigurowany (S7_AGENT_SOCKET)' };
  const start = performance.now();
  let svc;
  try {
    svc = await host.get(`/services/${encodeURIComponent(monitor.target)}`);
  } catch (err) {
    return { status: 'down', error: err.status === 404 ? 'usługa nie istnieje na serwerze' : err.message };
  }
  const latency = Math.round(performance.now() - start);
  const state = serviceState(svc);
  const status = STATE_MAP[state];
  const info = {
    state,
    cpu: svc.cpu ?? null,
    mem: svc.mem ?? null,
    disk: null,
    uptime: svc.since ? Math.max(0, Date.now() - svc.since) : null,
    name: svc.unit,
    limits: null,
  };
  return {
    status,
    latency,
    cpu: info.cpu,
    mem: info.mem,
    error: status === 'up' ? null : svc.active === 'failed' ? 'usługa padła (failed)' : STATE_PL[state],
    data: { ptero: info, service: { unit: svc.unit, label: svc.label, restarts: svc.restarts, pid: svc.pid, power: svc.power } },
  };
}
