// Czyste funkcje agenta (parsowanie /proc, df, systemctl, journalctl) — testowane w server/test/agent.test.js.

/** Suma i czas bezczynności z pierwszej linii /proc/stat. */
export function parseCpuStat(text) {
  const line = String(text).split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (n[3] || 0) + (n[4] || 0);
  const total = n.slice(0, 8).reduce((a, b) => a + (b || 0), 0);
  return { idle, total };
}

/** Użycie CPU w % między dwoma odczytami parseCpuStat. */
export function cpuPercent(prev, cur) {
  if (!prev || !cur) return null;
  const dt = cur.total - prev.total;
  if (dt <= 0) return null;
  return Math.round((1 - (cur.idle - prev.idle) / dt) * 1000) / 10;
}

/** /proc/meminfo → bajty. */
export function parseMeminfo(text) {
  const kb = {};
  for (const l of String(text).split('\n')) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) kb[m[1]] = Number(m[2]) * 1024;
  }
  const total = kb.MemTotal ?? null;
  const available = kb.MemAvailable ?? kb.MemFree ?? null;
  return {
    total,
    available,
    used: total != null && available != null ? total - available : null,
    swapTotal: kb.SwapTotal ?? 0,
    swapUsed: (kb.SwapTotal ?? 0) - (kb.SwapFree ?? 0),
  };
}

/** Wynik `df -B1 --output=source,fstype,size,used,avail,target` → lista dysków. */
export function parseDf(text) {
  const out = [];
  for (const l of String(text).trim().split('\n').slice(1)) {
    const p = l.trim().split(/\s+/);
    if (p.length < 6) continue;
    const [source, fs, size, used, avail] = p;
    const mount = p.slice(5).join(' ');
    if (!Number(size)) continue;
    out.push({ source, fs, size: Number(size), used: Number(used), avail: Number(avail), mount });
  }
  return out;
}

/** /proc/net/dev → suma bajtów z fizycznych interfejsów (bez lo, dockera i mostków). */
export function parseNetDev(text) {
  let rx = 0; let tx = 0;
  for (const l of String(text).split('\n')) {
    const m = l.match(/^\s*([^:\s]+):\s*(.+)$/);
    if (!m) continue;
    if (/^(lo|docker|br-|veth|virbr|tun|tap|wg)/.test(m[1])) continue;
    const n = m[2].trim().split(/\s+/).map(Number);
    rx += n[0] || 0; tx += n[8] || 0;
  }
  return { rx, tx };
}

/** Wynik `systemctl show a b c -p ...` (bloki rozdzielone pustą linią) → lista obiektów. */
export function parseShow(text) {
  return String(text).split(/\n\s*\n/).map((block) => {
    const o = {};
    for (const l of block.split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) o[l.slice(0, i)] = l.slice(i + 1);
    }
    return o;
  }).filter((o) => o.Id);
}

const numOrNull = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/** Właściwości systemd → uproszczony opis usługi. */
export function unitInfo(p) {
  const since = /@(\d+)/.exec(p.ActiveEnterTimestamp || '');
  return {
    unit: p.Id,
    description: p.Description || '',
    loaded: p.LoadState === 'loaded',
    active: p.ActiveState || 'unknown',
    sub: p.SubState || '',
    result: p.Result || '',
    since: since && p.ActiveState === 'active' ? Number(since[1]) * 1000 : null,
    mem: numOrNull(p.MemoryCurrent),
    cpuNs: numOrNull(p.CPUUsageNSec),
    pid: numOrNull(p.MainPID) || null,
    restarts: numOrNull(p.NRestarts) ?? 0,
    enabled: p.UnitFileState === 'enabled',
  };
}

const MAX_LINE = 4000;

/** Jedna linia `journalctl -o json` → { t, m, p } (czas ms, treść, priorytet 0–7). */
export function journalEntry(line, { withIdent = false } = {}) {
  let j;
  try { j = JSON.parse(line); } catch { return null; }
  let msg = j.MESSAGE;
  if (Array.isArray(msg)) msg = Buffer.from(msg).toString('utf8');
  if (msg == null) return null;
  msg = String(msg);
  if (withIdent && j.SYSLOG_IDENTIFIER) msg = `${j.SYSLOG_IDENTIFIER}: ${msg}`;
  if (msg.length > MAX_LINE) msg = `${msg.slice(0, MAX_LINE)}…`;
  const t = Number(j.__REALTIME_TIMESTAMP);
  return { t: Number.isFinite(t) ? Math.round(t / 1000) : null, m: msg, p: j.PRIORITY != null ? Number(j.PRIORITY) : 6 };
}

/** Linia zwykłego pliku logu → { t: null, m, p }. */
export function fileEntry(line) {
  const m = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
  return { t: null, m, p: 6 };
}

export const ID_RE = /^[A-Za-z0-9_.@-]{1,100}$/;

/** Usługi infrastruktury wykrywane automatycznie; `power` = dozwolone akcje z aplikacji. */
export const INFRA_UNITS = [
  { unit: 'nginx.service', label: 'nginx (serwer WWW)', power: ['restart'] },
  { unit: 'apache2.service', label: 'Apache (serwer WWW)', power: ['restart'] },
  { unit: 'caddy.service', label: 'Caddy (serwer WWW)', power: ['restart'] },
  { unit: 'mariadb.service', label: 'MariaDB (baza danych)', power: ['restart'] },
  { unit: 'mysql.service', label: 'MySQL (baza danych)', power: ['restart'] },
  { unit: 'postgresql.service', label: 'PostgreSQL (baza danych)', power: ['restart'] },
  { unit: 'redis-server.service', label: 'Redis', power: ['restart'] },
  { unit: 'docker.service', label: 'Docker', power: [] },
  { unit: 'ssh.service', label: 'SSH', power: [] },
];

/** Nazwy plików *.service z /etc/systemd/system → własne usługi użytkownika (boty, API). */
export function appUnitsFrom(fileNames) {
  return fileNames
    .filter((f) => f.endsWith('.service') && !f.includes('@'))
    .filter((f) => !/^(s7-|snap[.-]|cloud-|dbus-|display-manager|syslog|sshd?\.)/.test(f))
    .filter((f) => !INFRA_UNITS.some((i) => i.unit === f))
    .sort();
}
