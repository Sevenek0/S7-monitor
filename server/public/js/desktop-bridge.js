// Integracja z aplikacją Windows (Electron): natywne powiadomienia i kolor ikony w trayu.
// Electron nie obsługuje Web Push, więc powiadomienia idą z SSE przez preload (window.desktop).
import { subscribe, summary } from './store.js';
import { isDesktopApp } from './util.js';

export function initDesktopBridge() {
  if (!isDesktopApp()) return;
  document.documentElement.classList.add('is-desktop');
  const d = window.desktop;
  let last = '';
  const pushStatus = () => {
    const s = summary();
    const color = s.down ? 'down' : s.total && (s.up || s.warn) ? 'up' : 'unknown';
    const tip = s.down ? `S7 Monitor — awarie: ${s.down}` : s.total ? 'S7 Monitor — wszystko działa' : 'S7 Monitor';
    const key = `${color}|${tip}`;
    if (key !== last) { last = key; d.setStatus({ status: color, tooltip: tip }); }
  };
  subscribe((kind, payload) => {
    if (kind === 'transition') {
      const down = payload.to === 'down';
      const mins = payload.downtimeMs != null ? Math.max(1, Math.round(payload.downtimeMs / 60000)) : null;
      d.notify({
        title: down ? `PADŁ: ${payload.name}${payload.reason ? ` (${payload.reason})` : ''}` : `Działa znowu: ${payload.name}${mins ? ` (przerwa ${mins} min)` : ''}`,
        body: down ? 'Kliknij, aby zobaczyć szczegóły.' : 'Monitor znów odpowiada.',
        monitorId: payload.monitorId,
        urgent: down,
      });
    }
    if (kind === 'live' && payload === 'offline') d.setStatus({ status: 'unknown', tooltip: 'S7 Monitor — brak połączenia z serwerem' });
    if (['all', 'monitor', 'removed', 'live'].includes(kind)) { if (kind === 'live') last = ''; pushStatus(); }
  });
  d.onOpenMonitor?.((id) => { location.hash = `#/m/${id}`; });
}
