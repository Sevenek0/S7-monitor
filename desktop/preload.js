// Bezpieczny most: frontend dostaje tylko te funkcje (window.desktop), bez dostępu do Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  /** Natywne powiadomienie Windows: { title, body, monitorId?, urgent? } */
  notify: (n) => ipcRenderer.send('desktop:notify', {
    title: String(n?.title || 'S7 Monitor').slice(0, 200),
    body: String(n?.body || '').slice(0, 500),
    monitorId: Number.isInteger(n?.monitorId) ? n.monitorId : null,
    urgent: Boolean(n?.urgent),
  }),
  /** Kolor ikony w trayu: status = 'up' | 'down' | 'unknown' */
  setStatus: (s) => ipcRenderer.send('desktop:status', { status: String(s?.status || 'unknown'), tooltip: String(s?.tooltip || '').slice(0, 120) }),
  onOpenMonitor: (cb) => ipcRenderer.on('desktop:open-monitor', (_e, id) => cb(id)),
  // Ekran konfiguracji
  getServer: () => ipcRenderer.invoke('desktop:get-server'),
  saveServer: (url) => ipcRenderer.invoke('desktop:save-server', String(url || '')),
  changeServer: () => ipcRenderer.send('desktop:change-server'),
  retry: () => ipcRenderer.send('desktop:retry'),
});
