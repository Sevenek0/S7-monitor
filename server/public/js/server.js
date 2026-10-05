// Zakładka „Serwer": informacje o VPS-ie, usługi (boty, API) z zasilaniem, konsole z logami na żywo.
import { api, auth } from './api.js';
import { esc, icon, num, bytes, duration, toast, $ } from './util.js';
import { confirmDialog } from './modal.js';

const REFRESH_MS = 3000;
const MAX_LINES = 1000;
const LAST_SOURCE_KEY = 's7_console';

let root = null;
let timer = null;
let services = [];
let sources = [];
let con = { id: null, es: null, follow: true };

const STATE = {
  active: ['up', 'Działa'], activating: ['warn', 'Startuje'], reloading: ['warn', 'Przeładowanie'],
  deactivating: ['warn', 'Zatrzymywanie'], failed: ['down', 'Padła'], inactive: ['paused', 'Zatrzymana'],
};
const POWER_LABEL = { start: 'Start', restart: 'Restart', stop: 'Stop' };
const POWER_ICON = { start: 'play', restart: 'restart', stop: 'stop' };

function statePill(s) {
  const [status, label] = STATE[s.active] || ['pending', s.active];
  const ic = { up: 'check', warn: 'alert', down: 'x', paused: 'pause', pending: 'clock' }[status];
  return `<span class="pill" data-status="${status}">${icon(ic)}${esc(label)}</span>`;
}

function bar(percent) {
  const p = percent == null ? 0 : Math.max(0, Math.min(100, percent));
  const cls = p >= 90 ? 'crit' : p >= 75 ? 'hot' : '';
  return `<div class="track"><div class="fill ${cls}" style="width:${p.toFixed(1)}%"></div></div>`;
}

function tile(k, v, sub = '', percent = undefined) {
  return `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div>${percent !== undefined ? bar(percent) : ''}${sub ? `<div class="s">${esc(sub)}</div>` : ''}</div>`;
}

const rate = (b) => (b == null ? '—' : `${bytes(b)}/s`);

function renderSystem(s) {
  const rootDisk = s.disks.find((d) => d.mount === '/') || s.disks[0];
  const memPct = s.mem.total ? (s.mem.used / s.mem.total) * 100 : null;
  const diskPct = rootDisk ? (rootDisk.used / rootDisk.size) * 100 : null;
  $('#sv-tiles', root).innerHTML = [
    tile('Procesor', s.cpu.usage != null ? `${num(s.cpu.usage)}%` : '—', `obciążenie ${s.load.map((v) => num(v, 2)).join(' · ')}`, s.cpu.usage),
    tile('Pamięć RAM', bytes(s.mem.used), `z ${bytes(s.mem.total)}`, memPct),
    tile('Dysk', rootDisk ? bytes(rootDisk.used) : '—', rootDisk ? `z ${bytes(rootDisk.size)} · wolne ${bytes(rootDisk.avail)}` : '', diskPct),
    tile('Sieć', `↓ ${rate(s.net.rxRate)}`, `↑ ${rate(s.net.txRate)}`),
    tile('Działa od', duration(s.uptime), 'bez restartu'),
  ].join('');

  const notes = [];
  if (s.rebootRequired) notes.push('<div class="alert warn"><b>Serwer czeka na restart</b> — zainstalowane aktualizacje systemu zadziałają dopiero po ponownym uruchomieniu VPS-a.</div>');
  if (diskPct != null && diskPct >= 90) notes.push(`<div class="alert"><b>Kończy się miejsce na dysku</b> — zajęte ${num(diskPct)}%.</div>`);
  $('#sv-notes', root).innerHTML = notes.join('');

  $('#sv-disks', root).innerHTML = s.disks.map((d) => `<div class="disk">
      <div class="disk-head"><b>${esc(d.mount)}</b><span class="muted">${esc(d.source)} · ${esc(d.fs)}</span><span class="val">${bytes(d.used)} / ${bytes(d.size)}</span></div>
      ${bar((d.used / d.size) * 100)}
      <div class="muted disk-foot">Wolne: ${bytes(d.avail)} (${num(100 - (d.used / d.size) * 100)}%)</div></div>`).join('') || '<p class="muted">Brak danych o dyskach.</p>';

  const rows = [
    ['Nazwa serwera', s.hostname], ['System', s.os], ['Jądro', `${s.kernel} (${s.arch})`],
    ['Procesor', `${s.cpu.model || '—'} · ${s.cpu.cores} ${s.cpu.cores === 1 ? 'rdzeń' : s.cpu.cores < 5 ? 'rdzenie' : 'rdzeni'}`],
    ['Adres IP', s.ips.join(', ') || '—'],
    ['Swap', s.mem.swapTotal ? `${bytes(s.mem.swapUsed)} / ${bytes(s.mem.swapTotal)}` : 'brak'],
    ['Ruch od startu', `↓ ${bytes(s.net.rx)} · ↑ ${bytes(s.net.tx)}`],
    ['Aktualizacje', s.updates == null ? '—' : s.updates ? `${s.updates} do zainstalowania` : 'system aktualny'],
    ['Wymaga restartu', s.rebootRequired ? 'tak' : 'nie'],
  ];
  $('#sv-info', root).innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');

  $('#sv-procs', root).innerHTML = `<div class="row head"><span>Proces</span><span>Użytkownik</span><span class="r">CPU</span><span class="r">RAM</span></div>${
    s.processes.map((p) => `<div class="row"><span class="nick">${esc(p.name)}</span><span class="muted nick">${esc(p.user)}</span><span class="r mono">${num(p.cpu)}%</span><span class="r mono">${bytes(p.mem)}</span></div>`).join('')}`;
}

function serviceRow(s) {
  const meta = [];
  if (s.active === 'active') {
    if (s.mem != null) meta.push(`RAM ${bytes(s.mem)}`);
    if (s.cpu != null) meta.push(`CPU ${num(s.cpu)}%`);
    if (s.since) meta.push(`działa ${duration(Date.now() - s.since)}`);
  }
  if (s.restarts) meta.push(`restarty: ${s.restarts}`);
  return `<div class="srow" data-id="${esc(s.id)}">
    <div class="info"><div class="n">${esc(s.label)}</div><div class="t">${esc(s.unit)}${meta.length ? ` · ${esc(meta.join(' · '))}` : ''}</div></div>
    ${statePill(s)}
    <div class="acts">
      <button class="btn small" data-act="console">${icon('terminal')}<span>Konsola</span></button>
      ${s.power.map((p) => `<button class="btn small ${p === 'stop' ? 'danger' : p === 'start' ? 'good' : ''}" data-power="${p}" ${(p === 'start' && s.active === 'active') || (p === 'stop' && s.active !== 'active') ? 'disabled' : ''}>${icon(POWER_ICON[p])}<span>${POWER_LABEL[p]}</span></button>`).join('')}
    </div></div>`;
}

function renderServices() {
  const el = $('#sv-services', root); if (!el) return;
  const group = (kind, title) => {
    const list = services.filter((s) => s.kind === kind);
    return list.length ? `<h3 class="sub-h">${title}</h3><div class="slist">${list.map(serviceRow).join('')}</div>` : '';
  };
  el.innerHTML = group('app', 'Boty i aplikacje') + group('infra', 'System') || '<p class="muted">Nie wykryto żadnych usług.</p>';
}

async function power(id, signal) {
  const s = services.find((x) => x.id === id); if (!s) return;
  const text = { start: 'Usługa zostanie uruchomiona.', restart: 'Usługa zostanie zatrzymana i uruchomiona ponownie.', stop: 'Usługa zostanie zatrzymana i nie wstanie sama, dopóki jej nie uruchomisz.' }[signal];
  if (!await confirmDialog({ title: `${POWER_LABEL[signal]}: ${s.label}?`, text, ok: POWER_LABEL[signal], danger: signal === 'stop' })) return;
  try {
    await api(`/host/services/${encodeURIComponent(id)}/power`, { method: 'POST', body: { signal } });
    toast(`Wykonano: ${POWER_LABEL[signal]} → ${s.label}`);
  } catch (e) { toast(e.message, 'error'); }
  refresh();
}

// --- Konsola -----------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
function stamp(t) {
  if (!t) return '';
  const d = new Date(t);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function appendLines(entries) {
  const out = $('#sv-console', root); if (!out) return;
  const frag = document.createDocumentFragment();
  for (const e of entries) {
    const div = document.createElement('div');
    div.className = `ln${e.p <= 3 ? ' err' : e.p === 4 ? ' warn' : ''}`;
    if (e.t) { const ts = document.createElement('span'); ts.className = 'ts'; ts.textContent = stamp(e.t); div.appendChild(ts); }
    div.appendChild(document.createTextNode(e.m));
    frag.appendChild(div);
  }
  out.appendChild(frag);
  while (out.childElementCount > MAX_LINES) out.firstElementChild.remove();
  if (con.follow) out.scrollTop = out.scrollHeight;
}

function setConsoleState(text, state = '') {
  const el = $('#sv-con-state', root); if (!el) return;
  el.textContent = text; el.dataset.state = state;
}

function closeConsole() {
  con.es?.close(); con.es = null;
}

async function openConsole(id, { scroll = false } = {}) {
  closeConsole();
  con.id = id; con.follow = true;
  try { localStorage.setItem(LAST_SOURCE_KEY, id); } catch { /* ignore */ }
  const sel = $('#sv-source', root); if (sel) sel.value = id;
  const out = $('#sv-console', root); if (!out) return;
  out.innerHTML = '';
  setConsoleState('Wczytywanie…');
  if (scroll) $('#sv-console-box', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    const r = await api(`/host/logs/${encodeURIComponent(id)}?lines=300`);
    if (con.id !== id || !root) return;
    if (!r.lines.length) appendLines([{ t: null, m: '(brak wpisów w logach)', p: 6 }]);
    else appendLines(r.lines);
  } catch (e) {
    if (con.id === id) setConsoleState(e.message, 'offline');
    return;
  }
  const es = new EventSource(`/api/host/logs/${encodeURIComponent(id)}/stream?token=${encodeURIComponent(auth.token)}`);
  con.es = es;
  es.addEventListener('open', () => { if (con.es === es) setConsoleState('Na żywo', 'live'); });
  es.addEventListener('line', (e) => { if (con.es === es) appendLines([JSON.parse(e.data)]); });
  es.addEventListener('fail', (e) => { if (con.es === es) setConsoleState(JSON.parse(e.data).error, 'offline'); });
  es.addEventListener('error', () => { if (con.es === es) setConsoleState('Łączenie…', ''); });
}

function renderSources() {
  const sel = $('#sv-source', root); if (!sel) return;
  const groups = [...new Set(sources.map((s) => s.group))];
  sel.innerHTML = groups.map((g) => `<optgroup label="${esc(g)}">${sources.filter((s) => s.group === g).map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join('')}</optgroup>`).join('');
  if (con.id) sel.value = con.id;
}

// --- Odświeżanie -------------------------------------------------------------
async function refresh() {
  if (!root || document.visibilityState !== 'visible') return;
  try {
    const [sys, svc] = await Promise.all([api('/host/system'), api('/host/services')]);
    if (!root) return;
    $('#sv-error', root).innerHTML = '';
    services = svc.services;
    renderSystem(sys);
    renderServices();
  } catch (e) {
    if (root && e.status !== 401) $('#sv-error', root).innerHTML = `<div class="alert"><b>Brak danych z serwera:</b> ${esc(e.message)}</div>`;
  }
}

export function closeServer() {
  clearInterval(timer); timer = null;
  closeConsole();
  root = null;
}

export async function renderServer(view, params) {
  closeServer();
  root = view;
  view.innerHTML = `<div class="server">
    <div id="sv-error"></div>
    <div id="sv-notes"></div>
    <section class="stats big" id="sv-tiles"><div class="loading-block"><span class="spinner"></span></div></section>
    <section class="box"><h2>Usługi</h2><p class="desc">Boty, API i programy działające na tym VPS-ie. Stop wymaga potwierdzenia.</p><div id="sv-services"></div></section>
    <section class="box" id="sv-console-box">
      <div class="box-head"><h2>Konsola</h2><span class="live" id="sv-con-state" role="status"></span></div>
      <div class="con-bar">
        <label class="sr-only" for="sv-source">Źródło logów</label><select class="input" id="sv-source"></select>
        <button class="btn" id="sv-clear">${icon('trash')}<span>Wyczyść</span></button>
      </div>
      <div class="console" id="sv-console" tabindex="0" aria-label="Logi"></div>
      <p class="muted con-hint">Konsola pokazuje logi na żywo (tylko do odczytu). Przewiń w górę, żeby zatrzymać przewijanie; na dół — żeby wznowić.</p>
    </section>
    <div class="grid-server">
      <section class="box"><h2>Dyski</h2><div id="sv-disks" class="disks"></div></section>
      <section class="box"><h2>Serwer</h2><dl class="kv" id="sv-info"></dl></section>
    </div>
    <section class="box"><h2>Procesy <span class="muted h-note">najwięcej pamięci</span></h2><div class="procs" id="sv-procs"></div></section>
  </div>`;

  $('#sv-services', view).addEventListener('click', (e) => {
    const row = e.target.closest('.srow'); if (!row) return;
    const p = e.target.closest('[data-power]');
    if (p) { power(row.dataset.id, p.dataset.power); return; }
    if (e.target.closest('[data-act="console"]')) openConsole(`svc.${row.dataset.id}`, { scroll: true });
  });
  $('#sv-source', view).addEventListener('change', (e) => openConsole(e.target.value));
  $('#sv-clear', view).addEventListener('click', () => { $('#sv-console', view).innerHTML = ''; });
  const out = $('#sv-console', view);
  out.addEventListener('scroll', () => { con.follow = out.scrollHeight - out.scrollTop - out.clientHeight < 40; });

  await refresh();
  if (root !== view) return;
  timer = setInterval(refresh, REFRESH_MS);

  try { sources = (await api('/host/logs')).sources; } catch { sources = []; }
  if (root !== view) return;
  renderSources();
  let wanted = params?.get('log');
  if (!wanted) { try { wanted = localStorage.getItem(LAST_SOURCE_KEY); } catch { /* ignore */ } }
  const first = sources.find((s) => s.id === wanted) || sources[0];
  if (first) openConsole(first.id, { scroll: Boolean(params?.get('log')) });
}

document.addEventListener('visibilitychange', () => { if (root && document.visibilityState === 'visible') refresh(); });
