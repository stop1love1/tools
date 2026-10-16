'use strict';

// Desktop shell for the dashboard: runs server.js with Electron's own Node and shows it in a window.
//
// The app name / desktop name must be "jira-dashboard" so the window's WM_CLASS (X11) and app_id (Wayland)
// match jira-dashboard.desktop; otherwise GNOME shows a separate "Electron" icon in the dock instead of
// the launcher's icon. Launching `electron electron-main.js` (a bare file) skips package.json and names the
// app "Electron", so we set it explicitly here as well.

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, utilityProcess } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const APP_ID = 'jira-dashboard';
app.setName(APP_ID);
if (process.platform === 'linux') app.setDesktopName(`${APP_ID}.desktop`);

const PORT = Number(process.env.PORT) || 4747;
const BASE_URL = `http://localhost:${PORT}`;
const ICON = path.join(__dirname, 'assets', 'icon.png');
const SERVER_READY_TIMEOUT_MS = 30_000;

let mainWindow = null;
let serverProcess = null;
let tray = null;

// Started at login by the autostart entry (see setAutoStart): run the server only, no window.
const START_HIDDEN = process.argv.includes('--hidden');

// One instance only: a second launch (desktop icon clicked again) focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(init);
}

// Linux: no separate title bar. The window buttons are drawn over the right end of the page's top bar (Window
// Controls Overlay), which also keeps them on the right: with its own client-side title bar on Wayland, Electron
// put them on the left regardless of the GNOME button layout. preload.js keeps the overlay's colours and height
// in step with the page theme and top bar; the page CSS makes the top bar draggable.
const OVERLAY = process.platform === 'linux';
const overlayDefaults = () =>
  nativeTheme.shouldUseDarkColors ? { color: '#161a20', symbolColor: '#e5e8ec', height: 52 } : { color: '#ffffff', symbolColor: '#1a1e24', height: 52 };

const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
ipcMain.on('titlebar-overlay', (e, { color, symbolColor, height } = {}) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!OVERLAY || !win || !COLOR_RE.test(color) || !COLOR_RE.test(symbolColor)) return;
  win.setTitleBarOverlay({ color, symbolColor, height: Math.min(Math.max(Math.round(height) || 52, 28), 120) });
});

function showWindow() {
  if (!mainWindow) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: ICON,
    show: false,
    ...(OVERLAY && { titleBarStyle: 'hidden', titleBarOverlay: overlayDefaults(), autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(BASE_URL + readLastPage());

  // The pages keep their filters in the query string (history.replaceState), so remember the last page + query
  // and reopen it on the next start, the way a browser tab would.
  const remember = (_e, url) => saveLastPage(url);
  mainWindow.webContents.on('did-navigate', remember);
  mainWindow.webContents.on('did-navigate-in-page', remember);
  mainWindow.on('closed', () => {
    flushLastPage();
    mainWindow = null;
  });
}

const LAST_PAGE_FILE = () => path.join(app.getPath('userData'), 'last-page.json');
let pendingPage = null;
let saveTimer = null;

// Path + query of the last page shown, or '' (the overview) when there is none or it is unusable.
function readLastPage() {
  try {
    const page = JSON.parse(fs.readFileSync(LAST_PAGE_FILE(), 'utf8')).page;
    return typeof page === 'string' && page.startsWith('/') && !page.startsWith('//') ? page : '';
  } catch {
    return '';
  }
}

// Typing in a filter replaces the URL on every keystroke, so batch the writes.
function saveLastPage(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return;
  }
  if (u.origin !== new URL(BASE_URL).origin || u.pathname.startsWith('/oauth/')) return;
  pendingPage = u.pathname + u.search;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushLastPage, 500);
}

function flushLastPage() {
  clearTimeout(saveTimer);
  if (pendingPage === null) return;
  try {
    fs.writeFileSync(LAST_PAGE_FILE(), JSON.stringify({ page: pendingPage }));
  } catch (e) {
    console.error('Could not save the last page:', e.message);
  }
  pendingPage = null;
}

// ---------------------------------------------------------------------------
// Background mode: an XDG autostart entry starts the app hidden at login, and closing the window keeps the server
// running (with a tray icon to reopen or quit) so the dashboard and its MCP server stay up without the window.
// Electron's setLoginItemSettings does nothing on Linux, hence the .desktop file. The file is the setting itself.

const AUTOSTART_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(app.getPath('home'), '.config'), 'autostart', `${APP_ID}.desktop`);

const isAutoStart = () => fs.existsSync(AUTOSTART_FILE);

// The command that relaunches this app. The AppImage / deb go through the after-pack.js wrapper (it adds the
// Wayland and sandbox flags); in dev it is electron + the project folder with the flags of `npm run start:electron`.
function launchCommand() {
  const q = (a) => `"${a.replace(/(["`$\\])/g, '\\$1')}"`;
  if (process.env.APPIMAGE) return q(process.env.APPIMAGE);
  if (app.isPackaged) {
    const wrapper = process.execPath.replace(/\.bin$/, '');
    return q(fs.existsSync(wrapper) ? wrapper : process.execPath);
  }
  return [q(process.execPath), q(app.getAppPath()), '--no-sandbox', '--ozone-platform-hint=auto', '--enable-features=WaylandWindowDecorations'].join(' ');
}

function setAutoStart(on) {
  if (!on) {
    fs.rmSync(AUTOSTART_FILE, { force: true });
  } else {
    fs.mkdirSync(path.dirname(AUTOSTART_FILE), { recursive: true });
    fs.writeFileSync(
      AUTOSTART_FILE,
      `[Desktop Entry]
Type=Application
Name=Jira Dashboard
Comment=Run the Jira Dashboard server in the background
Exec=${launchCommand()} --hidden
Icon=${APP_ID}
Terminal=false
X-GNOME-Autostart-enabled=true
`,
    );
  }
  updateTray();
  return isAutoStart();
}

ipcMain.handle('autostart:get', () => isAutoStart());
ipcMain.handle('autostart:set', (_e, on) => setAutoStart(!!on));

// The tray icon is there while the app may run without a window (background mode on, or started hidden).
function updateTray() {
  const want = isAutoStart() || START_HIDDEN;
  if (!want) {
    tray?.destroy();
    tray = null;
    return;
  }
  if (tray) return;
  tray = new Tray(ICON);
  tray.setToolTip(`Jira Dashboard — ${BASE_URL}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Jira Dashboard', click: () => showWindow() },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => showWindow());
}

function ping() {
  return new Promise((resolve) => {
    http
      .get(BASE_URL, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      })
      .on('error', () => resolve(false))
      .setTimeout(1000, function () {
        this.destroy();
      });
  });
}

// Packaged (AppImage/deb): the app files are read-only, so .env, settings, the OAuth grant and the MCP token
// live in the user data dir. In dev they stay next to server.js, shared with `npm start`.
function serverEnv() {
  const env = { ...process.env, PORT: String(PORT) };
  delete env.ELECTRON_RUN_AS_NODE; // would leak into tools the server launches (e.g. VS Code)
  if (app.isPackaged) {
    const data = app.getPath('userData');
    env.NODE_ENV = 'production';
    env.DASHBOARD_ENV_FILE ??= path.join(data, '.env');
    env.DASHBOARD_CONFIG_FILE ??= path.join(data, 'config.json');
    env.DASHBOARD_OAUTH_FILE ??= path.join(data, '.oauth.json');
    env.DASHBOARD_MCP_TOKEN_FILE ??= path.join(data, '.mcp-token');
  }
  return env;
}

async function startServer() {
  // A dashboard already running (e.g. `npm start` in a terminal) is reused instead of fighting over the port.
  if (await ping()) {
    console.log(`Using the dashboard already running at ${BASE_URL}`);
    return;
  }

  console.log('Starting Jira Dashboard server...');
  serverProcess = utilityProcess.fork(path.join(__dirname, 'server.js'), [], {
    cwd: app.isPackaged ? app.getPath('userData') : __dirname,
    env: serverEnv(),
    stdio: 'pipe',
    serviceName: 'Jira Dashboard server',
  });
  serverProcess.stdout.on('data', (d) => console.log(`[Server] ${d.toString().trim()}`));
  serverProcess.stderr.on('data', (d) => console.error(`[Server] ${d.toString().trim()}`));

  let exited = null;
  serverProcess.on('exit', (code) => {
    exited = { code };
    serverProcess = null;
    if (!quitting) console.error(`Server exited (code ${code})`);
  });

  const deadline = Date.now() + SERVER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Server exited during startup (code ${exited.code}). See the log for details.`);
    if (await ping()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server did not answer on ${BASE_URL} within ${SERVER_READY_TIMEOUT_MS / 1000}s.`);
}

async function init() {
  Menu.setApplicationMenu(menu());
  try {
    await startServer();
    updateTray();
    if (!START_HIDDEN) createWindow();
  } catch (err) {
    console.error('Failed to initialize:', err);
    dialog.showErrorBox('Jira Dashboard', err.message);
    app.quit();
  }
}

// In background mode the window can be closed while the server keeps running; quit from the tray or Ctrl+Q.
app.on('window-all-closed', () => {
  if (quitting || tray) return;
  if (process.platform !== 'darwin') app.quit();
});

// server.js finishes running git jobs on SIGTERM before exiting, so wait for it instead of leaving it behind.
let quitting = false;
app.on('before-quit', (e) => {
  quitting = true;
  if (!serverProcess) return;
  e.preventDefault();
  BrowserWindow.getAllWindows().forEach((w) => w.hide());
  console.log('Stopping server...');
  serverProcess.once('exit', () => app.quit());
  serverProcess.kill();
});

app.on('activate', () => {
  if (!mainWindow) createWindow();
});

function menu() {
  return Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [{ label: 'Exit', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.webContents.reload() },
        { label: 'Toggle DevTools', accelerator: 'CmdOrCtrl+Shift+I', click: () => mainWindow?.webContents.toggleDevTools() },
      ],
    },
  ]);
}
