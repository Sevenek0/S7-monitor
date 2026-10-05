// Panel szczegółów monitora (panel boczny na PC, pełny ekran na telefonie).
import { api } from './api.js';
import { state, subscribe } from './store.js';
import { esc, icon, pill, num, bytes, duration, dateTime, ago, toast, TYPE_LABEL, PTERO_STATE } from './util.js';
import { mountLineChart, timeline } from './charts.js';
import { resourceBars } from './dashboard.js';
import { confirmDialog } from './modal.js';

let scrim; let panel; let body;
let current = null; // { id, range, history, incidents, query, cleanups: [] }
let unsub = null;
let historyTimer = null;

function ensureDom() {
  if (panel) return;
  scrim = document.createElement('div');
  scrim.className = 'scrim hidden';
  panel = document.createElement('aside');
  panel.className = 'panel hidden';
  panel.setAttribute('aria-label', 'Szczegóły monitora');
  panel.innerHTML = `<div class="panel-head">
      <a class="btn icon" href="#/" aria-label="Zamknij">${icon('back')}</a>
      <div class="title"><h2 id="d-name"></h2><div class="sub" id="d-sub"></div></div>
      <span id="d-pill"></span>
    </div><div class="panel-body" id="d-body"></div>`;
  document.body.append(scrim, panel);
  body = panel.querySelector('#d-body');
  scrim.addEventListener('click', () => { location.hash = '#/'; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && current && !document.querySelector('.modal-wrap')) location.hash = '#/'; });
}

export function closeDetail() {
  if (!panel || !current) return;
  current.cleanups.forEach((f) => f());
  current = null;
  unsub?.(); unsub = null;
  clearTimeout(historyTimer);
  panel.classList.remove('open'); scrim.classList.remove('open');
  document.body.classList.remove('no-scroll');
  setTimeout(() => { if (!current) { panel.classList.add('hidden'); scrim.classList.add('hidden'); } }, 230);
}

export function openDetail(id) {
  ensureDom();
  if (current?.id === id) return;
  if (current) closeDetail();
  current = { id, range: '24h', history: null, incidents: null, query: '', cleanups: [] };
  panel.classList.remove('hidden'); scrim.classList.remove('hidden');
  requestAnimationFrame(() => { panel.classList.add('open'); scrim.classList.add('open'); });
  if (matchMedia('(max-width: 760px)').matches) document.body.classList.add('no-scroll');
  body.scrollTop = 0;
  renderSkeleton();
  loadHistory();
  unsub = subscribe((kind, payload) => {
    if (!current) return;
    if ((kind === 'monitor' && payload.id === current.id) || kind === 'all') renderLive();
    if (kind === 'removed' && payload === current.id) { toast('Monitor został usunięty'); location.hash = '#/'; }
    if (kind === 'check' && payload.monitorId === current.id) scheduleHistory();
    if (kind === 'transition' && payload.monitorId === current.id) loadIncidents();
  });
}

function monitor() { return current && state.monitors.get(current.id); }

function scheduleHistory() {
  if (historyTimer) return;
  historyTimer = setTimeout(() => { historyTimer = null; loadHistory(true); }, 20000);
}

async function loadHistory(silent = false) {
  const c = current; if (!c) return;
  if (!silent) body.querySelector('#d-charts').innerHTML = '<div class="loading-block"><span class="spinner"></span></div>';
  try {
    const [h, inc] = await Promise.all([api(`/monitors/${c.id}/history?range=${c.range}`), api(`/monitors/${c.id}/incidents?limit=15`)]);
    if (current !== c) return;
    c.history = h; c.incidents = inc.incidents;
    renderHistory(); renderIncidents();
  } catch (e) {
    if (current === c) body.querySelector('#d-charts').innerHTML = `<div class="alert">${esc(e.message)}</div>`;
  }
}
async function loadIncidents() {
  const c = current; if (!c) return;
  try { c.incidents = (await api(`/monitors/${c.id}/incidents?limit=15`)).incidents; if (current === c) renderIncidents(); } catch { /* ignore */ }
}

function renderSkeleton() {
  const m = monitor();
  if (!m) { body.innerHTML = '<div class="empty">Nie znaleziono monitora.</div>'; return; }
  body.innerHTML = `
    <div id="d-alert"></div>
    <div id="d-power"></div>
    <div class="block"><div id="d-stats" class="stats"></div></div>
    <div class="block">
      <div class="segmented" role="group" aria-label="Zakres historii" id="d-range">
        ${['24h', '7d', '30d'].map((r) => `<button data-range="${r}" aria-pressed="${r === current.range}">${r === '24h' ? '24 godz.' : r === '7d' ? '7 dni' : '30 dni'}</button>`).join('')}
      </div>
    </div>
    <div class="block"><h3>Dostępność</h3><div id="d-timeline"><div class="timeline"></div></div></div>
    <div class="block" id="d-charts"></div>
    <div class="block hidden" id="d-players-block">
      <h3>${icon('users')} Gracze online <span class="muted" id="d-pcount"></span></h3>
      <div class="field" style="margin-bottom:10px"><label class="sr-only" for="d-search">Szukaj gracza</label>
        <input class="input" id="d-search" type="search" placeholder="Szukaj po nicku lub ID…" autocomplete="off" enterkeyhint="search"></div>
      <div id="d-players"></div>
    </div>
    <div class="block"><h3>Informacje</h3><dl class="kv" id="d-info"></dl></div>
    <div class="block"><h3>Ostatnie incydenty</h3><div id="d-incidents"><div class="loading-block"><span class="spinner"></span></div></div></div>
    <div class="block btn-row"><button class="btn" id="d-check">${icon('refresh')}Sprawdź teraz</button><a class="btn" href="#/settings?edit=${m.id}">${icon('edit')}Edytuj</a></div>`;
  body.querySelector('#d-range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]'); if (!b || b.dataset.range === current.range) return;
    current.range = b.dataset.range;
    body.querySelectorAll('#d-range button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    loadHistory();
  });
  body.querySelector('#d-search').addEventListener('input', (e) => { current.query = e.target.value; renderPlayers(); });
  body.querySelector('#d-check').addEventListener('click', async (e) => {
    const btn = e.currentTarget; btn.disabled = true;
    try { await api(`/monitors/${current.id}/check`, { method: 'POST' }); toast('Sprawdzono'); } catch (err) { toast(err.message, 'error'); }
    btn.disabled = false;
  });
  renderLive();
}

/** Części zależne od bieżącego stanu (bez historii). */
function renderLive() {
  const m = monitor(); if (!m || !body.querySelector('#d-stats')) return;
  const d = m.data || {};
  panel.querySelector('#d-name').textContent = m.name;
  panel.querySelector('#d-sub').textContent = `${TYPE_LABEL[m.type]} · ${m.type === 'fivem' ? (d.hostname || m.target) : m.type === 'http' ? m.target : m.pteroServerId}`;
  panel.querySelector('#d-pill').innerHTML = pill(m.status);

  const alert = body.querySelector('#d-alert');
  if (m.status === 'down') alert.innerHTML = `<div class="alert"><b>Awaria:</b> ${esc(m.lastError || 'brak odpowiedzi')} · od ${esc(ago(m.lastChange))}</div>`;
  else if (m.status === 'warn') alert.innerHTML = `<div class="alert warn"><b>Uwaga:</b> ${esc(m.lastError || '')}</div>`;
  else if (m.status === 'paused') alert.innerHTML = `<div class="alert info">Monitor jest wstrzymany — nie wykonuje sprawdzeń.</div>`;
  else alert.innerHTML = '';

  renderPower(m);
  renderStats();
  renderInfo(m);
  const pb = body.querySelector('#d-players-block');
  pb.classList.toggle('hidden', m.type !== 'fivem');
  if (m.type === 'fivem') renderPlayers();
}

function renderStats() {
  const m = monitor(); if (!m) return;
  const d = m.data || {};
  const s = current.history?.summary;
  const items = [];
  items.push(['Dostępność', s?.uptime != null ? `${num(s.uptime, 2)}%` : '—']);
  if (m.type === 'fivem') {
    items.push(['Gracze teraz', m.status === 'down' ? '—' : `${d.clients ?? 0}${d.maxClients ? `/${d.maxClients}` : ''}`]);
    items.push(['Maks. graczy', s?.maxPlayers ?? '—']);
  }
  if (m.type !== 'pterodactyl') items.push(['Śr. odpowiedź', s?.avgLatency != null ? `${s.avgLatency} ms` : '—']);
  if (d.ptero) {
    items.push(['CPU teraz', d.ptero.cpu != null ? `${num(d.ptero.cpu)}%` : '—']);
    items.push(['RAM teraz', bytes(d.ptero.mem)]);
  }
  items.push(['Incydenty', current.incidents ? String(current.incidents.filter((i) => i.startedAt >= (current.history?.from ?? 0)).length) : '—']);
  body.querySelector('#d-stats').innerHTML = items.map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');
}

function renderPower(m) {
  const el = body.querySelector('#d-power');
  if (!m.pteroServerId) { el.innerHTML = ''; return; }
  if (el.dataset.for === String(m.id) && el.innerHTML) {
    // tylko odśwież paski zasobów
    const rb = el.querySelector('.d-res'); if (rb) rb.innerHTML = resourceBars(m.data?.ptero);
    return;
  }
  el.dataset.for = String(m.id);
  el.innerHTML = `<div class="block"><h3>${icon('bolt')} Zasilanie <span class="muted">Pterodactyl</span></h3>
    <div class="d-res" style="margin-bottom:12px">${resourceBars(m.data?.ptero)}</div>
    <div class="power">
      <button class="btn good" data-sig="start">${icon('play')}Start</button>
      <button class="btn" data-sig="restart">${icon('restart')}Restart</button>
      <button class="btn danger" data-sig="stop">${icon('stop')}Stop</button>
      <button class="btn danger" data-sig="kill">${icon('bolt')}Kill</button>
    </div><p class="muted" style="font-size:12px;margin:8px 0 0">Stop i Kill wymagają drugiego kliknięcia.</p></div>`;
  const LABEL = { start: 'Start', restart: 'Restart', stop: 'Stop', kill: 'Kill' };
  const armed = new Map();
  const send = async (btn, sig) => {
    btn.disabled = true;
    try {
      await api(`/monitors/${m.id}/power`, { method: 'POST', body: { signal: sig } });
      toast(`Wysłano: ${LABEL[sig]} → ${m.name}`);
    } catch (e) { toast(e.message, 'error'); }
    btn.disabled = false;
  };
  el.querySelectorAll('[data-sig]').forEach((btn) => btn.addEventListener('click', async () => {
    const sig = btn.dataset.sig;
    if (sig === 'stop' || sig === 'kill') {
      if (!armed.has(sig)) {
        btn.classList.add('armed');
        btn.innerHTML = `${icon(sig === 'stop' ? 'stop' : 'bolt')}Na pewno?`;
        armed.set(sig, setTimeout(() => { armed.delete(sig); btn.classList.remove('armed'); btn.innerHTML = `${icon(sig === 'stop' ? 'stop' : 'bolt')}${LABEL[sig]}`; }, 4000));
        return;
      }
      clearTimeout(armed.get(sig)); armed.delete(sig);
      btn.classList.remove('armed'); btn.innerHTML = `${icon(sig === 'stop' ? 'stop' : 'bolt')}${LABEL[sig]}`;
      return send(btn, sig);
    }
    const ok = await confirmDialog({ title: `${LABEL[sig]}: ${m.name}?`, text: sig === 'restart' ? 'Serwer zostanie zatrzymany i uruchomiony ponownie.' : 'Serwer zostanie uruchomiony.', ok: LABEL[sig] });
    if (ok) send(btn, sig);
  }));
}

function renderInfo(m) {
  const d = m.data || {};
  const rows = [['Typ', TYPE_LABEL[m.type]]];
  if (m.type === 'http') {
    rows.push(['Adres', m.target]);
    if (d.finalUrl) rows.push(['Przekierowanie', d.finalUrl]);
    if (d.code) rows.push(['Kod HTTP', d.code]);
    rows.push(['Oczekiwane kody', m.expectedCodes || '200–399']);
    if (m.keyword) rows.push(['Słowo kluczowe', m.keyword]);
  }
  if (m.type === 'fivem') {
    rows.push(['Adres', m.target]);
    if (d.hostname) rows.push(['Nazwa', d.hostname]);
    if (d.version) rows.push(['Wersja', d.version]);
    if (d.resources != null) rows.push(['Zasoby', d.resources]);
    if (d.gametype) rows.push(['Tryb', d.gametype]);
  }
  if (d.ptero) {
    rows.push(['Serwer Ptero', `${d.ptero.name || ''} (${m.pteroServerId})`]);
    rows.push(['Stan w panelu', PTERO_STATE[d.ptero.state] || d.ptero.state]);
    if (d.ptero.uptime) rows.push(['Czas działania', duration(d.ptero.uptime)]);
    if (d.ptero.disk != null) rows.push(['Dysk', `${bytes(d.ptero.disk)}${d.ptero.limits?.disk ? ` / ${bytes(d.ptero.limits.disk * 1048576)}` : ''}`]);
  }
  rows.push(['Interwał', `${m.intervalS} s`], ['Próg awarii', `${m.failThreshold} × z rzędu`], ['Ostatnie sprawdzenie', m.lastCheck ? `${dateTime(m.lastCheck)} (${ago(m.lastCheck)})` : 'jeszcze nie']);
  body.querySelector('#d-info').innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
}

function renderPlayers() {
  const m = monitor(); if (!m) return;
  const d = m.data || {};
  const el = body.querySelector('#d-players');
  const cnt = body.querySelector('#d-pcount');
  const search = body.querySelector('#d-search');
  if (m.status === 'down' || d.stale) { cnt.textContent = ''; search.parentElement.classList.add('hidden'); el.innerHTML = '<div class="alert info">Serwer nie odpowiada.</div>'; return; }
  if (!d.playersAvailable) {
    cnt.textContent = `(${d.clients ?? 0})`;
    search.parentElement.classList.add('hidden');
    el.innerHTML = `<div class="alert info">Lista graczy jest niedostępna — serwer blokuje <code>/players.json</code> (sv_requestParanoia). Liczba graczy: <b>${esc(d.clients ?? 0)}</b>.</div>`;
    return;
  }
  search.parentElement.classList.toggle('hidden', !d.players.length);
  const q = current.query.trim().toLowerCase();
  const list = q ? d.players.filter((p) => p.name.toLowerCase().includes(q) || String(p.id) === q) : d.players;
  cnt.textContent = `(${d.players.length}${d.maxClients ? `/${d.maxClients}` : ''})`;
  if (!d.players.length) { el.innerHTML = '<div class="alert info">Nikt nie gra w tej chwili.</div>'; return; }
  const pingCls = (p) => (p >= 150 ? 'ping-bad' : p >= 90 ? 'ping-mid' : '');
  el.innerHTML = `<div class="players"><div class="row head"><span>ID</span><span>Nick</span><span class="ping">Ping</span></div>
    <div class="scroll">${list.map((p) => `<div class="row"><span class="mono muted">${esc(p.id)}</span><span class="nick">${esc(p.name)}</span><span class="ping ${pingCls(p.ping)}">${esc(p.ping)} ms</span></div>`).join('') || '<div class="row"><span></span><span class="muted">Brak wyników</span><span></span></div>'}</div></div>`;
}

function renderHistory() {
  const m = monitor(); const h = current?.history; if (!m || !h) return;
  current.cleanups.forEach((f) => f()); current.cleanups = [];
  const segments = window.innerWidth < 500 ? 48 : 72;
  body.querySelector('#d-timeline').innerHTML = timeline(h.buckets, { from: h.from, to: h.to, segments })
    + `<div class="timeline-legend"><span>${esc(dateTime(h.from))}</span><span>teraz</span></div>
       <div class="legend-keys"><span><i style="background:var(--good)"></i>działa</span><span><i style="background:var(--warning)"></i>częściowo</span><span><i style="background:var(--critical)"></i>awaria</span><span><i style="background:var(--surface-3)"></i>brak danych</span></div>`;
  const wrap = body.querySelector('#d-charts');
  wrap.innerHTML = '';
  const base = { points: h.buckets, from: h.from, to: h.to, bucketMs: h.bucketMs };
  const add = (opts) => { const el = document.createElement('div'); wrap.appendChild(el); current.cleanups.push(mountLineChart(el, { ...base, ...opts })); };
  if (m.type === 'fivem') add({ key: 'pl', title: 'Gracze (maks. w przedziale)', fmt: (v) => num(v, 0), yMax: m.data?.maxClients || undefined });
  if (m.type !== 'pterodactyl') add({ key: 'lat', title: 'Czas odpowiedzi', fmt: (v) => `${num(v, 0)} ms` });
  if (m.pteroServerId) {
    add({ key: 'cpu', title: 'CPU (%)', fmt: (v) => `${num(v)}%` });
    add({ key: 'mem', title: 'RAM', fmt: (v) => bytes(v), color: 'var(--series-2)' });
  }
  renderStats();
}

function renderIncidents() {
  const el = body.querySelector('#d-incidents'); const list = current?.incidents; if (!el || !list) return;
  if (!list.length) { el.innerHTML = '<div class="alert info">Brak incydentów — oby tak dalej.</div>'; return; }
  el.innerHTML = `<ul class="incidents">${list.map((i) => `<li>
      <div><div class="reason">${pill(i.ongoing ? 'down' : 'up').replace(/>(Awaria|Działa)</, `>${i.ongoing ? 'Trwa' : 'Zakończony'}<`)}<span>${esc(i.reason || 'awaria')}</span></div><div class="when">${esc(dateTime(i.startedAt))}${i.endedAt ? ` – ${esc(dateTime(i.endedAt))}` : ''}</div></div>
      <span class="dur">${esc(duration(i.durationMs))}</span></li>`).join('')}</ul>`;
  renderStats();
}
