const { app, BrowserWindow, ipcMain, dialog, shell, Menu, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { createStore } = require('./storage');
const { createPatcher } = require('./patcher');

let autoUpdater = null;
try { autoUpdater = require('electron-updater').autoUpdater; } catch (e) { /* not available in dev */ }

// ---- Data folder (where project files and backups live) ----
const configPath = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch (e) { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2), 'utf8');
}
function defaultDataDir() {
  return path.join(app.getPath('documents'), '保育指導案・実習記録');
}
function getDataDir() {
  return readConfig().dataDir || defaultDataDir();
}

const store = createStore({ getDir: getDataDir, trash: (file) => shell.trashItem(file) });

let mainWindow = null;

// ---- IPC: projects ----
ipcMain.handle('projects:list', () => store.list().map(({ file, ...rest }) => rest));
ipcMain.handle('projects:create', (e, name) => store.create(name));
ipcMain.handle('projects:load', (e, id) => store.load(id));
ipcMain.handle('projects:save', (e, id, project, opts) => {
  const r = store.save(id, project, opts);
  return { ok: true, id: r.id, snapshot: !!r.snapshot };
});
ipcMain.handle('projects:delete', (e, id) => store.remove(id));

// ---- IPC: data folder ----
ipcMain.handle('data:getDir', () => getDataDir());
ipcMain.handle('data:openDir', async () => {
  const dir = getDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
ipcMain.handle('data:openBackups', async (e, id) => shell.openPath(store.backupDirFor(id)));
ipcMain.handle('data:chooseDir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: '保存フォルダを選択',
    defaultPath: getDataDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const cfg = readConfig();
  cfg.dataDir = result.filePaths[0];
  writeConfig(cfg);
  store.reset();
  return cfg.dataDir;
});

// ---- IPC: single files (sheet export) ----
// existingPath: overwrite that file without asking again (used for 2nd and later saves).
ipcMain.handle('file:saveJson', async (e, suggestedName, text, existingPath) => {
  let target = existingPath;
  if (!target) {
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'JSONファイルとして保存',
      defaultPath: path.join(getDataDir(), suggestedName),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (result.canceled || !result.filePath) return { saved: false };
    target = result.filePath;
  }
  fs.writeFileSync(target, text, 'utf8');
  return { saved: true, filePath: target };
});

// ---- IPC: app / updates ----
ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:install', () => { if (autoUpdater) autoUpdater.quitAndInstall(); });

// The ExcelJS copy installed with the app (used by the page for Excel export, offline).
function exceljsUrl() {
  try { return pathToFileURL(require.resolve('exceljs/dist/exceljs.min.js')).href; } catch (e) { /* fall through */ }
  try { return pathToFileURL(path.join(app.getAppPath(), 'node_modules', 'exceljs', 'dist', 'exceljs.min.js')).href; } catch (e) { /* fall through */ }
  return '';
}
ipcMain.on('app:exceljs-url', (e) => { e.returnValue = exceljsUrl(); });

// Renderer tells us it has finished saving after a "flush" request (window closing).
let flushed = false;
ipcMain.on('app:flush-done', () => {
  flushed = true;
  if (mainWindow) mainWindow.close();
});

// ================================================================
// Screen patches (see patcher.js): update only renderer/index.html without reinstalling
// ================================================================
const WATCHDOG_MS = Number(process.env.HOIKU_WATCHDOG_MS) || 15000;
const patchEnabled = () => app.isPackaged || process.env.HOIKU_ENABLE_PATCH === '1';
const bundledIndexPath = () => path.join(__dirname, 'renderer', 'index.html');

let patcher = null;
function getPatcher() {
  if (!patcher) {
    patcher = createPatcher({
      dir: path.join(app.getPath('userData'), 'ui-patch'),
      bundledIndex: bundledIndexPath(),
      appVersion: app.getVersion()
    });
  }
  return patcher;
}

let runningUi = null;        // ui-version of the screen currently on display
let runningSource = 'bundled';
let uiReadyReceived = false;
let watchdog = null;
const notified = new Set();  // versions already announced to the page this session

// Where the latest screen is published: the "renderer/index.html" of the GitHub repository
// this app was built from (owner/repo are written into app-update.yml at build time).
function patchSourceUrl() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const clean = (s) => String(s || '').trim().replace(/^['"]|['"]$/g, '');
    const owner = clean((yml.match(/^owner:\s*(.+)$/m) || [])[1]);
    const repo = clean((yml.match(/^repo:\s*(.+)$/m) || [])[1]);
    if (!owner || !repo) return null;
    return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/renderer/index.html?t=${Date.now()}`;
  } catch (e) {
    return null;
  }
}

async function fetchText(url) {
  const res = await net.fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// Loads the screen: a saved patch if there is a usable one, otherwise the built-in screen.
function loadRenderer(win) {
  let choice = { path: bundledIndexPath(), uiVersion: '', source: 'bundled' };
  if (patchEnabled()) {
    try {
      choice = getPatcher().choose();
      getPatcher().beginLoad(choice);
    } catch (e) { console.error('patch selection failed:', e && e.message); }
  }
  runningUi = choice.uiVersion;
  runningSource = choice.source;
  uiReadyReceived = false;
  clearTimeout(watchdog);
  win.loadFile(choice.path);
  if (choice.source === 'patch') {
    // A patched screen must report "ready" soon after loading, or we go back to the built-in one.
    watchdog = setTimeout(() => { if (!uiReadyReceived) fallBackFromPatch(win, 'no ready report'); }, WATCHDOG_MS);
  }
}

function fallBackFromPatch(win, reason) {
  if (runningSource !== 'patch') return;
  console.error('screen patch rejected (' + reason + '); using the built-in screen');
  try { getPatcher().rejectCurrent(); } catch (e) { /* ignore */ }
  loadRenderer(win);
}

ipcMain.on('ui:ready', () => {
  uiReadyReceived = true;
  clearTimeout(watchdog);
  if (runningSource === 'patch') { try { getPatcher().ack(); } catch (e) { /* ignore */ } }
});

// The person chose "今すぐ反映": reload the page from whatever is chosen now.
ipcMain.handle('ui:apply', () => { if (mainWindow) loadRenderer(mainWindow); });

async function checkUiPatch() {
  if (!patchEnabled() || !mainWindow) return;
  const url = patchSourceUrl();
  if (!url) return;
  let result;
  try { result = await getPatcher().check(() => fetchText(url)); } catch (e) { return; }
  const choice = getPatcher().choose();
  if (choice.source === 'patch' && choice.uiVersion !== runningUi && !notified.has(choice.uiVersion)) {
    notified.add(choice.uiVersion);
    mainWindow.webContents.send('ui:status', { state: 'ready', version: choice.uiVersion });
  } else if (result.state === 'needs-app-update' && !notified.has('needs:' + result.version)) {
    notified.add('needs:' + result.version);
    mainWindow.webContents.send('ui:status', { state: 'needs-app-update', version: result.version, minAppVersion: result.minAppVersion });
  }
}

function setupUiPatching() {
  if (!patchEnabled()) return;
  setTimeout(checkUiPatch, 8000);
  setInterval(checkUiPatch, 60 * 60 * 1000);
}

// ================================================================
// Whole-app updates (installer), via GitHub Releases
// ================================================================
function setupAutoUpdate(win) {
  if (!autoUpdater || !app.isPackaged) return; // only in the installed app
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true; // installs on the next quit even if the banner is ignored
  autoUpdater.on('update-available', (info) => win.webContents.send('update:status', { state: 'downloading', version: info.version }));
  autoUpdater.on('update-downloaded', (info) => win.webContents.send('update:status', { state: 'ready', version: info.version }));
  autoUpdater.on('error', (err) => console.error('auto-update error:', err && err.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => { /* offline */ });
  setTimeout(check, 5000);
  setInterval(check, 60 * 60 * 1000);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    backgroundColor: '#eef0e6',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  loadRenderer(mainWindow);

  // If a patched screen can't even load or its process dies, go back to the built-in screen.
  mainWindow.webContents.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
    if (isMainFrame && runningSource === 'patch') fallBackFromPatch(mainWindow, 'load failed: ' + desc);
  });
  mainWindow.webContents.on('render-process-gone', () => {
    if (runningSource === 'patch') fallBackFromPatch(mainWindow, 'renderer crashed');
  });

  // Before the window closes, ask the page to save whatever is on screen.
  mainWindow.on('close', (e) => {
    if (flushed) return;
    e.preventDefault();
    mainWindow.webContents.send('app:flush');
    setTimeout(() => { flushed = true; if (mainWindow) mainWindow.close(); }, 3000); // safety net
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  setupAutoUpdate(mainWindow);
  setupUiPatching();
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' }
  ]));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) { flushed = false; createWindow(); }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Exposed only so the wiring above can be tested without Electron.
module.exports.__test = { loadRenderer, checkUiPatch, patchSourceUrl, getRunning: () => ({ runningUi, runningSource }) };
