#!/usr/bin/env node
/**
 * S7 Agent — mały pomocnik działający na VPS-ie (poza Dockerem, jako usługa systemd).
 * Udostępnia aplikacji S7 Monitor informacje o serwerze, stan usług (boty, API),
 * ich logi („konsole") oraz start/stop/restart. Słucha TYLKO na gnieździe uniksowym
 * (domyślnie /run/s7-agent/agent.sock) — nie otwiera żadnego portu w sieci.
 *
 * Agent nie wykonuje dowolnych poleceń: działa wyłącznie na usługach i logach z listy
 * (wykrytej automatycznie albo z /etc/s7-agent.json).
 *
 *   /etc/s7-agent.json (opcjonalny):
 *   { "services": [{ "unit": "moj-bot.service", "label": "Mój bot", "power": ["start","stop","restart"] }],
 *     "logs":     [{ "id": "moj-log", "label": "Mój log", "file": "/var/log/moj.log" }] }
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import {
  parseCpuStat, cpuPercent, parseMeminfo, parseDf, parseNetDev, parseShow, unitInfo,
  journalEntry, fileEntry, ID_RE, INFRA_UNITS, appUnitsFrom,
} from './lib.mjs';

const SOCKET = process.env.S7_AGENT_SOCKET || '/run/s7-agent/agent.sock';
const CONFIG = process.env.S7_AGENT_CONFIG || '/etc/s7-agent.json';
const GID = Number(process.env.S7_AGENT_GID ?? 1000); // grupa użytkownika "node" w kontenerze
const UNIT_DIR = '/etc/systemd/system';
const POWER = ['start', 'stop', 'restart'];
const MAX_STREAMS = 8;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 15000, maxBuffer: 8 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stderr = String(stderr || ''); reject(err); } else resolve(String(stdout));
  });
});
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

// --- Lista usług i źródeł logów ---------------------------------------------
function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); } catch { return {}; }
}

async function discoverServices() {
  const cfg = loadConfig();
  const list = [];
  const add = (unit, label, kind, power) => {
    const id = unit.replace(/\.service$/, '');
    if (!ID_RE.test(id) || list.some((s) => s.id === id)) return;
    list.push({ id, unit, label: label || id, kind, power });
  };
  for (const s of cfg.services || []) {
    if (!s?.unit) continue;
    const unit = s.unit.endsWith('.service') ? s.unit : `${s.unit}.service`;
    add(unit, s.label, s.kind || 'app', (s.power || POWER).filter((p) => POWER.includes(p)));
  }
  if (!cfg.services) {
    let files = [];
    try {
      files = fs.readdirSync(UNIT_DIR, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name);
    } catch { /* brak katalogu */ }
    for (const unit of appUnitsFrom(files)) add(unit, null, 'app', POWER);
  }
  const infra = [...INFRA_UNITS];
  try {
    for (const f of fs.readdirSync('/lib/systemd/system')) {
      if (/^php[\d.]*-fpm\.service$/.test(f)) infra.push({ unit: f, label: `PHP-FPM (${f.replace(/\.service$/, '')})`, power: ['restart'] });
    }
  } catch { /* ignore */ }
  for (const i of infra) add(i.unit, i.label, 'infra', i.power);
  return list;
}

function logSources(services) {
  const cfg = loadConfig();
  const out = services.map((s) => ({ id: `svc.${s.id}`, label: s.label, group: s.kind === 'app' ? 'Boty i usługi' : 'System', journal: ['-u', s.unit] }));
  out.push({ id: 'system', label: 'Cały system (dziennik)', group: 'System', journal: [], ident: true });
  out.push({ id: 'kernel', label: 'Jądro systemu', group: 'System', journal: ['-k'] });
  const files = [
    { id: 'nginx-access', label: 'Strony — wejścia (nginx)', file: '/var/log/nginx/access.log' },
    { id: 'nginx-error', label: 'Strony — błędy (nginx)', file: '/var/log/nginx/error.log' },
    ...(cfg.logs || []).filter((l) => l?.id && ID_RE.test(l.id) && l.file),
  ];
  for (const f of files) if (fs.existsSync(f.file)) out.push({ id: f.id, label: f.label || f.id, group: 'Strony', file: f.file });
  return out;
}

// --- Próbkowanie: CPU, sieć, usługi -----------------------------------------
const sample = { cpu: null, cpuPct: null, net: null, netRate: { rx: 0, tx: 0 }, netTs: 0 };
function sampleSystem() {
  const cpu = parseCpuStat(read('/proc/stat'));
  const pct = cpuPercent(sample.cpu, cpu);
  if (pct != null) sample.cpuPct = pct;
  sample.cpu = cpu;
  const net = parseNetDev(read('/proc/net/dev'));
  const now = Date.now();
  if (sample.net && now > sample.netTs) {
    const dt = (now - sample.netTs) / 1000;
    sample.netRate = { rx: Math.max(0, Math.round((net.rx - sample.net.rx) / dt)), tx: Math.max(0, Math.round((net.tx - sample.net.tx) / dt)) };
  }
  sample.net = net; sample.netTs = now;
}

let services = [];
let serviceState = new Map(); // id → opis usługi
const cpuPrev = new Map(); // id → { ns, ts }
const SHOW_PROPS = 'Id,Description,LoadState,ActiveState,SubState,Result,ActiveEnterTimestamp,MemoryCurrent,CPUUsageNSec,MainPID,NRestarts,UnitFileState';

async function sampleServices() {
  services = await discoverServices();
  if (!services.length) { serviceState = new Map(); return; }
  let text;
  try {
    text = await run('systemctl', ['show', '--timestamp=unix', '-p', SHOW_PROPS, ...services.map((s) => s.unit)]);
  } catch (e) { text = String(e.stdout || ''); }
  const byUnit = new Map(parseShow(text).map((p) => [p.Id, unitInfo(p)]));
  const now = Date.now();
  const next = new Map();
  for (const s of services) {
    const u = byUnit.get(s.unit);
    if (!u || !u.loaded) continue; // np. apache2 nie jest zainstalowany
    let cpu = null;
    const prev = cpuPrev.get(s.id);
    if (u.cpuNs != null) {
      if (prev && now > prev.ts && u.cpuNs >= prev.ns) cpu = Math.round(((u.cpuNs - prev.ns) / 1e6 / (now - prev.ts)) * 1000) / 10;
      cpuPrev.set(s.id, { ns: u.cpuNs, ts: now });
    }
    if (u.active !== 'active') cpu = null;
    // Własne usługi pokazujemy pod opisem z pliku .service (np. "Community Bot (Discord)").
    const label = s.label === s.id && s.kind === 'app' && u.description && u.description !== s.unit ? u.description : s.label;
    next.set(s.id, { id: s.id, label, kind: s.kind, power: s.power, ...u, mem: u.active === 'active' ? u.mem : null, cpu });
  }
  serviceState = next;
}

let dfCache = { ts: 0, disks: [] };
async function disks() {
  if (Date.now() - dfCache.ts < 15000) return dfCache.disks;
  try {
    const text = await run('df', ['-B1', '--output=source,fstype,size,used,avail,target', '-x', 'tmpfs', '-x', 'devtmpfs', '-x', 'overlay', '-x', 'squashfs', '-x', 'efivarfs']);
    dfCache = { ts: Date.now(), disks: parseDf(text).filter((d) => !d.mount.startsWith('/boot/efi') && !d.mount.startsWith('/snap')) };
  } catch { /* zostaje poprzedni wynik */ }
  return dfCache.disks;
}

async function topProcesses() {
  try {
    const text = await run('ps', ['-eo', 'pid,user:16,pcpu,rss,comm', '--sort=-rss', '--no-headers']);
    return text.trim().split('\n').slice(0, 10).map((l) => {
      const p = l.trim().split(/\s+/);
      return { pid: Number(p[0]), user: p[1], cpu: Number(p[2]), mem: Number(p[3]) * 1024, name: p.slice(4).join(' ') };
    });
  } catch { return []; }
}

function osName() {
  const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(read('/etc/os-release'));
  return m ? m[1] : os.type();
}

function pendingUpdates() {
  const m = /(\d+) updates? can be applied/.exec(read('/var/lib/update-notifier/updates-available'));
  return m ? Number(m[1]) : null;
}

async function systemInfo() {
  const cpus = os.cpus();
  const ips = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(lo|docker|br-|veth|virbr)/.test(name)) continue;
    for (const a of addrs || []) if (!a.internal && a.family === 'IPv4') ips.push(a.address);
  }
  return {
    time: Date.now(),
    hostname: os.hostname(),
    os: osName(),
    kernel: os.release(),
    arch: os.arch(),
    uptime: Math.round(os.uptime() * 1000),
    load: os.loadavg().map((v) => Math.round(v * 100) / 100),
    cpu: { model: cpus[0]?.model?.trim() || '', cores: cpus.length, usage: sample.cpuPct },
    mem: parseMeminfo(read('/proc/meminfo')),
    disks: await disks(),
    net: { ...sample.net, rxRate: sample.netRate.rx, txRate: sample.netRate.tx },
    ips,
    rebootRequired: fs.existsSync('/run/reboot-required'),
    updates: pendingUpdates(),
    processes: await topProcesses(),
  };
}

// --- Logi --------------------------------------------------------------------
const JOURNAL_FIELDS = '--output-fields=MESSAGE,PRIORITY,__REALTIME_TIMESTAMP,SYSLOG_IDENTIFIER';

async function readLogs(src, lines) {
  if (src.file) {
    const text = await run('tail', ['-n', String(lines), src.file]);
    return text.split('\n').filter(Boolean).map(fileEntry);
  }
  const text = await run('journalctl', ['--no-pager', '-o', 'json', JOURNAL_FIELDS, '-n', String(lines), ...src.journal]);
  return text.split('\n').filter(Boolean).map((l) => journalEntry(l, { withIdent: src.ident })).filter(Boolean);
}

let streams = 0;
function streamLogs(src, req, res) {
  if (streams >= MAX_STREAMS) return send(res, 429, { error: 'Za dużo otwartych konsol naraz' });
  const child = src.file
    ? spawn('tail', ['-n', '0', '-F', src.file], { stdio: ['ignore', 'pipe', 'ignore'] })
    : spawn('journalctl', ['--no-pager', '-o', 'json', JOURNAL_FIELDS, '-n', '0', '-f', ...src.journal], { stdio: ['ignore', 'pipe', 'ignore'] });
  streams++;
  res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
  res.write('\n');
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      const entry = src.file ? fileEntry(line) : journalEntry(line, { withIdent: src.ident });
      if (entry) res.write(`${JSON.stringify(entry)}\n`);
    }
  });
  const ping = setInterval(() => res.write('\n'), 20000);
  let closed = false;
  const stop = () => {
    if (closed) return;
    closed = true; streams--;
    clearInterval(ping);
    child.kill('SIGTERM');
    res.end();
  };
  child.on('exit', stop);
  req.on('close', stop);
}

// --- HTTP --------------------------------------------------------------------
function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://agent');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  if (req.method === 'GET' && parts[0] === 'health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && parts[0] === 'system' && parts.length === 1) return send(res, 200, await systemInfo());

  if (parts[0] === 'services') {
    if (req.method === 'GET' && parts.length === 1) return send(res, 200, { services: [...serviceState.values()] });
    const svc = serviceState.get(parts[1]);
    if (!svc) return send(res, 404, { error: 'Nie ma takiej usługi' });
    if (req.method === 'GET' && parts.length === 2) return send(res, 200, svc);
    if (req.method === 'POST' && parts.length === 3) {
      const action = parts[2];
      if (!POWER.includes(action) || !svc.power.includes(action)) return send(res, 403, { error: 'Ta akcja nie jest dozwolona dla tej usługi' });
      console.log(`[zasilanie] ${new Date().toISOString()} ${action.toUpperCase()} → ${svc.unit}`);
      try {
        await run('systemctl', [action, svc.unit], { timeout: 60000 });
      } catch (e) {
        return send(res, 500, { error: (e.stderr || e.message || 'błąd systemctl').trim().split('\n')[0] });
      }
      await sampleServices().catch(() => {});
      return send(res, 200, { ok: true, service: serviceState.get(svc.id) || null });
    }
  }

  if (req.method === 'GET' && parts[0] === 'logs') {
    const sources = logSources(services.filter((s) => serviceState.has(s.id)).map((s) => ({ ...s, label: serviceState.get(s.id).label })));
    if (parts.length === 1) return send(res, 200, { sources: sources.map(({ id, label, group }) => ({ id, label, group })) });
    const src = sources.find((s) => s.id === parts[1]);
    if (!src) return send(res, 404, { error: 'Nie ma takiego źródła logów' });
    if (parts[2] === 'stream') return streamLogs(src, req, res);
    const lines = Math.min(1000, Math.max(1, Number(url.searchParams.get('lines')) || 200));
    return send(res, 200, { id: src.id, label: src.label, lines: await readLogs(src, lines) });
  }

  return send(res, 404, { error: 'Nie znaleziono' });
}

function main() {
  const dir = path.dirname(SOCKET);
  fs.mkdirSync(dir, { recursive: true });
  try { fs.unlinkSync(SOCKET); } catch { /* nie było */ }
  // Katalog i gniazdo dostępne tylko dla roota i grupy użytkownika kontenera.
  try { fs.chownSync(dir, 0, GID); fs.chmodSync(dir, 0o750); } catch (e) { console.warn(`[agent] chown ${dir}: ${e.message}`); }

  sampleSystem();
  sampleServices().catch((e) => console.warn(`[agent] usługi: ${e.message}`));
  setInterval(sampleSystem, 2000);
  setInterval(() => sampleServices().catch((e) => console.warn(`[agent] usługi: ${e.message}`)), 5000);

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error('[agent]', e);
      if (!res.headersSent) send(res, 500, { error: e.message || 'błąd agenta' }); else res.end();
    });
  });
  server.listen(SOCKET, () => {
    try { fs.chownSync(SOCKET, 0, GID); fs.chmodSync(SOCKET, 0o660); } catch (e) { console.warn(`[agent] chown gniazda: ${e.message}`); }
    console.log(`[agent] S7 Agent słucha na ${SOCKET}`);
  });
  const stop = () => { server.close(); try { fs.unlinkSync(SOCKET); } catch { /* ignore */ } process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main();
