// S7 Monitor — aplikacja Windows (Electron): okno z PWA, tray, natywne powiadomienia.
const { app, BrowserWindow, Tray, Menu, Notification, ipcMain, shell, nativeImage, net, session } = require('electron');
const path = require('node:path');
const { createConfigStore, normalizeServerUrl } = require('./config');

// MUSI być zgodne z build.appId w package.json — inaczej Windows nie pokaże powiadomień.
const APP_ID = 'pl.s7.monitor';
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const ASSETS = path.join(__dirname, 'assets');
let win = null;
let tray = null;
let config = null;
let quitting = false;
let lastStatus = 'unknown';
const startHidden = process.argv.includes('--hidden');

const trayIcon = (status) => nativeImage.createFromPath(path.join(ASSETS, `tray-${status === 'up' ? 'green' : status === 'down' ? 'red' : 'gray'}.png`));

function serverOrigin() {
  const u = config.get('serverUrl');
  try { return u ? new URL(u).origin : null; } catch { return null; }
}

function isAllowedUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'file:') return decodeURIComponent(u.pathname).toLowerCase().startsWith(pathToPosix(__dirname).toLowerCase());
    return u.origin === serverOrigin();
  } catch { return false; }
}
const pathToPosix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '/$1:');

function loadApp() {
  const origin = serverOrigin();
  if (!origin) return win.loadFile(path.join(__dirname, 'setup.html'));
  return win.loadURL(`${origin}/`);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 380,
    minHeight: 560,
    show: false,
    backgroundColor: '#0f1013',
    title: 'S7 Monitor',
    icon: path.join(ASSETS, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.removeMenu();

  win.once('ready-to-show', () => { if (!startHidden) win.show(); });

  // Zamknięcie okna = schowanie do traya (aplikacja działa dalej w tle).
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // Blokada nawigacji poza serwer; linki zewnętrzne → przeglądarka.
  win.webContents.on('will-navigate', (e, url) => {
    if (!isAllowedUrl(url)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.on('will-redirect', (e, url) => { if (!isAllowedUrl(url)) e.preventDefault(); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());

  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // -3 = przerwane (np. nawigacja)
    win.loadFile(path.join(__dirname, 'offline.html'), { query: { url: serverOrigin() || '', err: desc || String(code) } });
  });

  loadApp();
}

function buildTrayMenu() {
  const login = app.getLoginItemSettings({ args: ['--hidden'] });
  return Menu.buildFromTemplate([
    { label: 'Otwórz S7 Monitor', click: showWindow },
    { label: 'Zmień serwer…', click: () => { config.set('serverUrl', null); showWindow(); loadApp(); } },
    { type: 'separator' },
    {
      label: 'Uruchamiaj z Windowsem',
      type: 'checkbox',
      checked: login.openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
        tray.setContextMenu(buildTrayMenu());
      },
    },
    { type: 'separator' },
    { label: 'Zamknij', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon('unknown'));
  tray.setToolTip('S7 Monitor');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

// --- IPC (tylko z naszego okna) ---
const fromOurWindow = (e) => win && e.sender === win.webContents;

ipcMain.on('desktop:notify', (e, n) => {
  if (!fromOurWindow(e) || !Notification.isSupported()) return;
  const notification = new Notification({
    title: n.title,
    body: n.body,
    icon: path.join(ASSETS, 'icon.png'),
    urgency: n.urgent ? 'critical' : 'normal',
    timeoutType: n.urgent ? 'never' : 'default',
  });
  notification.on('click', () => {
    showWindow();
    if (n.monitorId != null) win.webContents.send('desktop:open-monitor', n.monitorId);
  });
  notification.show();
});

ipcMain.on('desktop:status', (e, s) => {
  if (!fromOurWindow(e) || !tray) return;
  const status = ['up', 'down'].includes(s.status) ? s.status : 'unknown';
  if (status !== lastStatus) { tray.setImage(trayIcon(status)); lastStatus = status; }
  tray.setToolTip(s.tooltip || 'S7 Monitor');
});

ipcMain.handle('desktop:get-server', (e) => (fromOurWindow(e) ? config.get('serverUrl') || '' : ''));

ipcMain.handle('desktop:save-server', async (e, input) => {
  if (!fromOurWindow(e)) return { ok: false, error: 'Odmowa' };
  let origin;
  try { origin = normalizeServerUrl(input); } catch (err) { return { ok: false, error: err.message }; }
  try {
    const res = await net.fetch(`${origin}/api/health`, { cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.ok) return { ok: false, error: `Serwer odpowiedział, ale to nie jest S7 Monitor (HTTP ${res.status}).` };
  } catch (err) {
    return { ok: false, error: `Nie mogę połączyć się z ${origin} (${err.message}).` };
  }
  config.set('serverUrl', origin);
  setImmediate(loadApp);
  return { ok: true, url: origin };
});

ipcMain.on('desktop:change-server', (e) => { if (fromOurWindow(e)) { config.set('serverUrl', null); loadApp(); } });
ipcMain.on('desktop:retry', (e) => { if (fromOurWindow(e)) loadApp(); });

// --- cykl życia ---
app.on('second-instance', showWindow);

app.whenReady().then(() => {
  config = createConfigStore(app.getPath('userData'));
  // Żadnych uprawnień (kamera, mikrofon, geolokalizacja...) dla strony.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  createTray();
  createWindow();
});

app.on('before-quit', () => { quitting = true; });
// Nie kończymy aplikacji po zamknięciu okien — działa w trayu.
app.on('window-all-closed', () => {});
app.on('activate', showWindow);
