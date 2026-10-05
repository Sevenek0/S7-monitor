// Dashboard: pasek ogólnego stanu, sekcje FiveM / Boty / Strony, karty monitorów.
import { state, summary } from './store.js';
import { esc, icon, pill, num, bytes, ago, sectionOf, isIOS, isStandalone, isDesktopApp, TYPE_LABEL, PTERO_STATE } from './util.js';
import { sparkline } from './charts.js';

const SECTIONS = [
  { key: 'fivem', title: 'Serwer FiveM' },
  { key: 'bots', title: 'Boty i usługi' },
  { key: 'sites', title: 'Strony' },
];

function pct(used, limit) {
  if (used == null || !limit) return null;
  return Math.min(100, (used / limit) * 100);
}

function resBar(label, value, percent) {
  const cls = percent == null ? '' : percent >= 90 ? 'crit' : percent >= 70 ? 'hot' : '';
  return `<div class="res-bar"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${percent == null ? 0 : percent.toFixed(1)}%"></div></div><span class="val">${value}</span></div>`;
}

export function resourceBars(p) {
  if (!p) return '';
  const cpuLimit = p.limits?.cpu || null;
  const memLimit = p.limits?.memory ? p.limits.memory * 1024 * 1024 : null;
  return `<div class="res-bars">
    ${resBar('CPU', `${num(p.cpu)}%${cpuLimit ? ` / ${cpuLimit}%` : ''}`, cpuLimit ? pct(p.cpu, cpuLimit) : p.cpu != null ? Math.min(100, p.cpu) : null)}
    ${resBar('RAM', `${bytes(p.mem)}${memLimit ? ` / ${bytes(memLimit)}` : ''}`, pct(p.mem, memLimit))}
  </div>`;
}

/** Główna metryka karty, zależnie od typu monitora. */
function mainMetric(m) {
  const d = m.data || {};
  if (m.status === 'paused') return `<div class="metric"><span class="value muted">—</span><span class="unit">wstrzymany</span></div>`;
  if (m.type === 'fivem') {
    const live = m.status !== 'down' && !d.stale;
    return `<div class="metric"><span class="value">${live ? esc(d.clients ?? 0) : '—'}${live && d.maxClients ? `<span class="unit">/${esc(d.maxClients)}</span>` : ''}</span><span class="unit">graczy</span>
      ${m.lastLatency != null ? `<span class="extra">${esc(m.lastLatency)} ms</span>` : ''}</div>
      ${d.ptero ? resourceBars(d.ptero) : ''}`;
  }
  if (m.type === 'pterodactyl' || m.type === 'service') {
    const p = d.ptero;
    if (!p) return `<div class="metric"><span class="value muted">—</span><span class="unit">${esc(m.lastError || 'brak danych')}</span></div>`;
    return resourceBars(p) + `<div class="card-sub" style="margin-top:0">Stan: ${esc(PTERO_STATE[p.state] || p.state)}</div>`;
  }
  const hasLat = m.lastLatency != null && m.status !== 'down';
  return `<div class="metric"><span class="value${hasLat ? '' : ' muted'}">${hasLat ? esc(m.lastLatency) : '—'}</span>${hasLat ? '<span class="unit">ms</span>' : `<span class="unit">${esc(m.lastError || 'brak odpowiedzi')}</span>`}
    ${d.code ? `<span class="extra">HTTP ${esc(d.code)}</span>` : ''}</div>`;
}

function subtitle(m) {
  if (m.type === 'fivem') return m.data?.hostname || m.target;
  if (m.type === 'service') return `Usługa · ${m.target}`;
  if (m.type === 'pterodactyl') return m.data?.ptero?.name ? `Pterodactyl · ${m.data.ptero.name}` : `Pterodactyl · ${m.pteroServerId}`;
  try { return new URL(m.target).host; } catch { return m.target; }
}

export function card(m, selectedId) {
  const ov = state.overview?.monitors?.[m.id];
  const key = m.type === 'fivem' ? 'pl' : m.type === 'pterodactyl' || m.type === 'service' ? 'cpu' : 'lat';
  const sparkLabel = { pl: 'gracze', cpu: 'CPU', lat: 'latencja' }[key];
  const now = Date.now();
  const spark = sparkline(ov?.spark || [], key, { from: state.overview?.from ?? now - 864e5, to: now, bucketMs: state.overview?.bucketMs ?? 1800e3 });
  const err = m.status === 'down' || m.status === 'warn' ? (m.lastError ? ` · ${esc(m.lastError)}` : '') : '';
  return `<a class="card" href="#/m/${m.id}" data-id="${m.id}" data-status="${esc(m.status)}" ${selectedId === m.id ? 'aria-current="true"' : ''}>
    <div class="card-head"><span class="name">${esc(m.name)}</span>${pill(m.status)}</div>
    <div class="card-sub">${esc(subtitle(m))}${err}</div>
    ${mainMetric(m)}
    <div title="${esc(sparkLabel)} — ostatnie 24 h">${spark}</div>
    <div class="card-foot"><span>Uptime 24h: <b>${ov?.uptime != null ? `${num(ov.uptime, 2)}%` : '—'}</b></span><span>${esc(ago(m.lastCheck, now))}</span></div>
  </a>`;
}

function overallBar() {
  const s = summary();
  let title; let desc; let ic;
  if (!s.total) { title = 'Brak monitorów'; desc = 'Dodaj pierwszy monitor w ustawieniach.'; ic = 'plus'; }
  else if (s.down) { title = s.down === 1 ? '1 awaria' : `${s.down} ${s.down < 5 ? 'awarie' : 'awarii'}`; desc = [...state.monitors.values()].filter((m) => m.status === 'down').map((m) => m.name).join(', '); ic = 'x'; }
  else if (s.warn) { title = 'Wymaga uwagi'; desc = [...state.monitors.values()].filter((m) => m.status === 'warn').map((m) => `${m.name} (${m.lastError || 'uwaga'})`).join(', '); ic = 'alert'; }
  else if (s.pending && !s.up) { title = 'Sprawdzanie…'; desc = 'Czekam na pierwsze wyniki.'; ic = 'clock'; }
  else { title = 'Wszystko działa'; desc = `${s.up} ${s.up === 1 ? 'monitor' : 'monitorów'} bez problemów.`; ic = 'check'; }
  const state_ = !s.total ? 'pending' : s.overall;
  return `<section class="overall" data-state="${state_}" aria-live="polite">
    <div class="big-icon">${icon(ic)}</div>
    <div class="text"><h1>${esc(title)}</h1><p>${esc(desc)}</p></div>
    <div class="counts">
      <span><i class="dot" data-status="up"></i>${s.up} działa</span>
      ${s.warn ? `<span><i class="dot" data-status="warn"></i>${s.warn} uwaga</span>` : ''}
      <span><i class="dot" data-status="down"></i>${s.down} awarie</span>
      ${s.paused ? `<span><i class="dot"></i>${s.paused} pauza</span>` : ''}
    </div>
  </section>`;
}

function installBanner() {
  if (!isIOS() || isStandalone() || isDesktopApp()) return '';
  try { if (localStorage.getItem('s7_hide_ios') === '1') return ''; } catch { /* ignore */ }
  return `<div class="banner" id="ios-banner">
    <div class="b-text"><strong>Zainstaluj aplikację na iPhonie</strong>
    Stuknij ${icon('share', 'share-ico')} <b>Udostępnij</b> → <b>Do ekranu początkowego</b>, a potem otwórz S7 Monitor z ikony. Tylko wtedy iOS pozwala na powiadomienia push.</div>
    <button class="btn small icon" data-act="hide-ios" aria-label="Ukryj">${icon('close')}</button></div>`;
}

export function renderDashboard(root, selectedId) {
  if (!state.loaded) { root.innerHTML = `<div class="loading-block"><span class="spinner"></span></div>`; return; }
  const all = [...state.monitors.values()];
  let out = installBanner() + overallBar();
  if (!all.length) {
    out += `<div class="empty"><h2>Nic tu jeszcze nie ma</h2><p>Dodaj stronę, serwer FiveM albo bota w ustawieniach.</p><a class="btn primary" href="#/settings">${icon('plus')}Dodaj monitor</a></div>`;
  }
  for (const s of SECTIONS) {
    const list = all.filter((m) => sectionOf(m) === s.key);
    if (!list.length) continue;
    const down = list.filter((m) => m.status === 'down').length;
    out += `<section class="section" aria-labelledby="sec-${s.key}">
      <div class="section-head"><h2 id="sec-${s.key}">${s.title}</h2><span class="muted">${list.length}${down ? ` · ${down} z awarią` : ''}</span></div>
      <div class="cards">${list.map((m) => card(m, selectedId)).join('')}</div></section>`;
  }
  root.innerHTML = out;
  root.querySelector('[data-act="hide-ios"]')?.addEventListener('click', () => {
    try { localStorage.setItem('s7_hide_ios', '1'); } catch { /* ignore */ }
    root.querySelector('#ios-banner')?.remove();
  });
}

export { TYPE_LABEL };
