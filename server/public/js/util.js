// Pomocnicze: escapowanie, formatowanie, ikony.

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const nf1 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat('pl-PL', { maximumFractionDigits: 2 });
export const num = (v, d = 1) => (v == null || Number.isNaN(v) ? '—' : (d === 2 ? nf2 : nf1).format(v));

export function bytes(b) {
  if (b == null) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${nf1.format(v)} ${u[i]}`;
}
export const mb = (m) => (m == null ? '—' : m === 0 ? '∞' : bytes(m * 1024 * 1024));

export function duration(ms) {
  if (ms == null) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60); const rm = m % 60;
  if (h < 24) return rm ? `${h} h ${rm} min` : `${h} h`;
  const d = Math.floor(h / 24); const rh = h % 24;
  return rh ? `${d} d ${rh} h` : `${d} d`;
}

export function ago(ts, now = Date.now()) {
  if (!ts) return 'nigdy';
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'przed chwilą';
  if (s < 60) return `${s} s temu`;
  return `${duration(now - ts)} temu`;
}

const dtf = new Intl.DateTimeFormat('pl-PL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const tf = new Intl.DateTimeFormat('pl-PL', { hour: '2-digit', minute: '2-digit' });
const df = new Intl.DateTimeFormat('pl-PL', { day: 'numeric', month: 'short' });
export const dateTime = (ts) => dtf.format(ts);
export const timeOnly = (ts) => tf.format(ts);
export const dayOnly = (ts) => df.format(ts);

export const STATUS_LABEL = { up: 'Działa', down: 'Awaria', warn: 'Uwaga', pending: 'Oczekuje', paused: 'Pauza' };
export const TYPE_LABEL = { http: 'Strona WWW', fivem: 'Serwer FiveM', pterodactyl: 'Bot (Pterodactyl)', service: 'Usługa na VPS-ie' };
export const PTERO_STATE = { running: 'działa', offline: 'wyłączony', starting: 'uruchamianie', stopping: 'zatrzymywanie' };

// Ikony (inline SVG, stroke = currentColor)
const P = {
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  pause: '<path d="M9 6v12M15 6v12"/>',
  play: '<path d="M8 5.5v13l10-6.5z"/>',
  restart: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  home: '<path d="M4 11l8-7 8 7"/><path d="M6 10v10h12V10"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  share: '<path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11v9h12v-9"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  logout: '<path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4 4"/>',
  server: '<rect x="3.5" y="4" width="17" height="7" rx="1.5"/><rect x="3.5" y="13" width="17" height="7" rx="1.5"/><path d="M7 7.5v.01M7 16.5v.01"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M12.5 15h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6"/>',
};
export function icon(name, cls = '') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`;
}
export const STATUS_ICON = { up: 'check', down: 'x', warn: 'alert', pending: 'clock', paused: 'pause' };

export function pill(status) {
  return `<span class="pill" data-status="${esc(status)}">${icon(STATUS_ICON[status] || 'clock')}${esc(STATUS_LABEL[status] || status)}</span>`;
}

export function html(strings, ...vals) {
  return strings.reduce((out, s, i) => out + s + (i < vals.length ? vals[i] ?? '' : ''), '');
}

/** Sekcja dashboardu, do której trafia monitor. */
export function sectionOf(m) {
  if (m.type === 'fivem') return 'fivem';
  if (m.type === 'pterodactyl' || m.type === 'service') return 'bots';
  return 'sites';
}

let toastRoot;
export function toast(msg, kind = '') {
  toastRoot ||= Object.assign(document.body.appendChild(document.createElement('div')), { className: 'toasts' });
  toastRoot.setAttribute('role', 'status');
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

export function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
export function isStandalone() {
  return window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
}
export const isDesktopApp = () => Boolean(window.desktop?.isDesktop);
