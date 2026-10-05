// Punkt wejścia PWA: routing, logowanie, odświeżanie widoków, most do aplikacji desktop.
import { auth, login, setUnauthorizedHandler } from './api.js';
import { state, subscribe, loadAll, loadMe, connectLive, disconnectLive, summary } from './store.js';
import { $, icon, toast } from './util.js';
import { renderDashboard } from './dashboard.js';
import { openDetail, closeDetail } from './detail.js';
import { renderSettings, refreshSettingsList } from './settings.js';
import { renderServer, closeServer } from './server.js';
import { initDesktopBridge } from './desktop-bridge.js';

const view = $('#view');
const topbar = $('#topbar');
let route = { name: 'dashboard' };

function parseRoute() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  const params = new URLSearchParams(qs || '');
  const m = path.match(/^\/m\/(\d+)/);
  if (path === '/login') return { name: 'login', params };
  if (path === '/settings') return { name: 'settings', params };
  if (path === '/server') return { name: 'server', params };
  if (m) return { name: 'detail', id: Number(m[1]), params };
  return { name: 'dashboard', params };
}

function setNav(name) {
  document.querySelectorAll('.nav a').forEach((a) => {
    const on = (a.dataset.route === 'dashboard' && (name === 'dashboard' || name === 'detail')) || a.dataset.route === name;
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
}

function render() {
  route = parseRoute();
  if (!auth.token && route.name !== 'login') { location.replace('#/login'); return; }
  if (route.name === 'login') { closeDetail(); closeServer(); renderLogin(); return; }
  if (!started) { start().then(render, () => {}); }
  topbar.classList.remove('hidden');
  setNav(route.name);
  if (route.name !== 'server') closeServer();
  if (route.name === 'server') {
    closeDetail();
    document.title = 'Serwer · S7 Monitor';
    renderServer(view, route.params);
  } else if (route.name === 'settings') {
    closeDetail();
    document.title = 'Ustawienia · S7 Monitor';
    renderSettings(view, route.params);
  } else {
    renderDashboard(view, route.name === 'detail' ? route.id : null);
    if (route.name === 'detail') openDetail(route.id); else closeDetail();
    updateTitle();
  }
}

function updateTitle() {
  if (route.name === 'settings' || route.name === 'server' || route.name === 'login') return;
  const s = summary();
  document.title = s.down ? `(${s.down}) Awaria · S7 Monitor` : 'S7 Monitor';
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (route.name === 'dashboard' || route.name === 'detail') { renderDashboard(view, route.name === 'detail' ? route.id : null); updateTitle(); }
    else if (route.name === 'settings') refreshSettingsList(view);
  });
}

function renderLogin() {
  topbar.classList.add('hidden');
  disconnectLive();
  document.title = 'Logowanie · S7 Monitor';
  view.innerHTML = `<div class="login"><form id="login-form">
    <img class="logo" src="/icons/icon-192.png" alt="">
    <h1>S7 Monitor</h1><p class="sub">Zaloguj się, aby zobaczyć status serwerów</p>
    <div class="field"><label for="pw">Hasło</label><input class="input" id="pw" type="password" autocomplete="current-password" required></div>
    <button class="btn primary" type="submit">Zaloguj</button>
    <p class="error-msg" id="login-err" role="alert"></p></form></div>`;
  const form = $('#login-form');
  setTimeout(() => $('#pw')?.focus(), 50);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button'); btn.disabled = true;
    try {
      await login($('#pw').value);
      await start();
      window.scrollTo(0, 0);
      location.hash = '#/';
    } catch (err) {
      $('#login-err').textContent = err.message;
      btn.disabled = false;
    }
  });
}

let started = false;
async function start() {
  if (started) return;
  started = true;
  try {
    await Promise.all([loadMe(), loadAll()]);
  } catch (e) {
    started = false;
    if (e.status !== 401) toast(e.message, 'error');
    throw e;
  }
  connectLive();
}

// --- inicjalizacja ---
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
setUnauthorizedHandler(() => {
  if (!auth.token) return;
  auth.clear(); started = false; disconnectLive();
  toast('Sesja wygasła — zaloguj się ponownie');
  location.hash = '#/login';
});

subscribe((kind, payload) => {
  if (kind === 'live') {
    const el = $('#live');
    el.dataset.state = payload;
    $('#live-text').textContent = payload === 'live' ? 'Na żywo' : payload === 'offline' ? 'Rozłączono' : 'Łączenie…';
    return;
  }
  if (kind === 'transition') {
    toast(payload.to === 'down' ? `PADŁ: ${payload.name}${payload.reason ? ` (${payload.reason})` : ''}` : `Działa znowu: ${payload.name}`, payload.to);
  }
  if (kind === 'me') { $('#nav-server')?.classList.toggle('hidden', !state.me?.host); return; }
  if (kind === 'check') return;
  scheduleRender();
});

topbar.innerHTML = `
  <a class="brand" href="#/"><img src="/icons/icon-192.png" alt="">S7 Monitor</a>
  <span class="live" id="live" data-state="connecting" role="status"><span class="live-dot"></span><span class="live-text" id="live-text">Łączenie…</span></span>
  <nav class="nav" aria-label="Nawigacja">
    <a href="#/" data-route="dashboard" aria-label="Pulpit">${icon('home')}<span class="label">Pulpit</span></a>
    <a href="#/server" data-route="server" aria-label="Serwer" id="nav-server" class="hidden">${icon('server')}<span class="label">Serwer</span></a>
    <a href="#/settings" data-route="settings" aria-label="Ustawienia">${icon('gear')}<span class="label">Ustawienia</span></a>
  </nav>`;

window.addEventListener('hashchange', render);
setInterval(() => { if (route.name === 'dashboard' || route.name === 'detail') scheduleRender(); }, 15000);

initDesktopBridge();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('SW:', e));
  // Kliknięcie powiadomienia, gdy aplikacja jest już otwarta
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && e.data.url) location.hash = e.data.url.replace(/^\/?#?/, '#');
  });
}

render();

