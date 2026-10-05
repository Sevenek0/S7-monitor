// Stan aplikacji + strumień SSE na żywo.
import { api, auth } from './api.js';

const listeners = new Set();
export const state = {
  monitors: new Map(),
  overview: { monitors: {} },
  incidents: [],
  live: 'connecting', // connecting | live | offline
  me: null,
  loaded: false,
};

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(kind, payload) { for (const fn of listeners) fn(kind, payload); }

export async function loadAll() {
  const r = await api('/monitors');
  state.monitors = new Map(r.monitors.map((m) => [m.id, m]));
  state.overview = r.overview;
  state.incidents = r.incidents;
  state.loaded = true;
  emit('all');
}

export async function loadMe() {
  state.me = await api('/me');
  emit('me');
  return state.me;
}

export function upsert(m) { state.monitors.set(m.id, m); emit('monitor', m); }
export function remove(id) { state.monitors.delete(id); emit('removed', id); }

/** Podsumowanie wszystkich monitorów (np. do paska stanu i ikony w trayu). */
export function summary() {
  const c = { up: 0, down: 0, warn: 0, pending: 0, paused: 0 };
  for (const m of state.monitors.values()) c[m.status] = (c[m.status] || 0) + 1;
  const active = c.up + c.down + c.warn + c.pending;
  let overall = 'pending';
  if (c.down) overall = 'down';
  else if (c.warn) overall = 'warn';
  else if (c.up && !c.pending) overall = 'up';
  else if (!active) overall = 'pending';
  return { ...c, total: state.monitors.size, overall };
}

let es = null;
let overviewTimer = null;
let retryTimer = null;

function setLive(v) { if (state.live !== v) { state.live = v; emit('live', v); } }

export function connectLive() {
  disconnectLive();
  if (!auth.token) return;
  setLive('connecting');
  es = new EventSource(`/api/events?token=${encodeURIComponent(auth.token)}`);
  es.addEventListener('open', () => setLive('live'));
  es.addEventListener('hello', (e) => {
    const { monitors } = JSON.parse(e.data);
    state.monitors = new Map(monitors.map((m) => [m.id, m]));
    setLive('live');
    emit('all');
  });
  es.addEventListener('monitor', (e) => upsert(JSON.parse(e.data)));
  es.addEventListener('removed', (e) => remove(JSON.parse(e.data).id));
  es.addEventListener('check', (e) => emit('check', JSON.parse(e.data)));
  es.addEventListener('transition', (e) => {
    const t = JSON.parse(e.data);
    emit('transition', t);
    refreshOverview();
  });
  es.addEventListener('error', () => {
    setLive('offline');
    // EventSource sam się łączy ponownie; jeśli token wygasł — sprawdzamy /api/me (401 → wylogowanie).
    if (es.readyState === EventSource.CLOSED) {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => { api('/me').then(connectLive).catch(() => {}); }, 5000);
    }
  });
  clearInterval(overviewTimer);
  overviewTimer = setInterval(refreshOverview, 5 * 60e3);
}

export function disconnectLive() {
  es?.close(); es = null;
  clearInterval(overviewTimer);
  clearTimeout(retryTimer);
}

let ovPending = null;
export function refreshOverview() {
  clearTimeout(ovPending);
  ovPending = setTimeout(() => loadAll().catch(() => {}), 800);
}

// Po powrocie aplikacji z tła (iOS zamraża PWA) — odśwież i połącz ponownie.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && auth.token && (!es || es.readyState === EventSource.CLOSED || state.live !== 'live')) {
    connectLive();
    refreshOverview();
  }
});
