// PiCode — Electron main process.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { PiRpc } from './rpc';
import { listSessions, buildSessionTree } from './sessions';
import {
  agentDir,
  bundledCliPath,
  clearProviderKey,
  maskAuth,
  piVersion,
  readSettings,
  setProviderKey,
  writeSettings,
} from './config';

app.setName('PiCode');

// E2E hook: isolate userData so tests start from a clean, scripted state.
if (process.env.PICODE_USER_DATA) {
  app.setPath('userData', process.env.PICODE_USER_DATA);
}

let win: BrowserWindow | null = null;
const rpc = new PiRpc();

const PREFS_FILE = () => path.join(app.getPath('userData'), 'picode-prefs.json');

function readPrefs(): any {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf-8'));
  } catch {
    return {};
  }
}

function writePrefs(patch: Record<string, any>): any {
  const prefs = { ...readPrefs(), ...patch };
  try {
    fs.mkdirSync(path.dirname(PREFS_FILE()), { recursive: true });
    fs.writeFileSync(PREFS_FILE(), JSON.stringify(prefs, null, 2), 'utf-8');
  } catch {
    /* ignore */
  }
  return prefs;
}

function broadcast(channel: string, payload: any): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

rpc.onEvent = (record) => broadcast('pi:event', record);
rpc.onExtUi = (record) => broadcast('pi:ext-ui', record);
rpc.onStatus = (status) => broadcast('pi:status', status);

function createWindow(): void {
  const prefs = readPrefs();
  const bounds = prefs.windowBounds || {};
  win = new BrowserWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: bounds.x,
    y: bounds.y,
    minWidth: 960,
    minHeight: 620,
    title: 'PiCode',
    backgroundColor: '#0c0e11',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('closed', () => (win = null));
}

let boundsTimer: NodeJS.Timeout | null = null;
function saveBounds(): void {
  if (!win || win.isDestroyed() || win.isMinimized()) return;
  if (boundsTimer) clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed()) return;
    writePrefs({ windowBounds: win.getBounds() });
  }, 500);
}

// ---------- IPC ----------
ipcMain.handle('picode:app-info', () => ({
  appVersion: app.getVersion(),
  piVersion: piVersion(),
  platform: process.platform,
  agentDir: agentDir(),
  cliPath: bundledCliPath(),
  home: app.getPath('home'),
}));

ipcMain.handle('prefs:get', () => readPrefs());
ipcMain.handle('prefs:set', (_e, patch) => writePrefs(patch || {}));

ipcMain.handle('dialog:pick-folder', async () => {
  if (!win) return null;
  const res = await dialog.showOpenDialog(win, {
    title: '选择项目文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return res.canceled || !res.filePaths[0] ? null : res.filePaths[0];
});

ipcMain.handle('shell:open-path', (_e, p: string) => {
  if (!p) return;
  if (/^https?:\/\//.test(p)) shell.openExternal(p);
  else shell.openPath(p).catch(() => {});
});

ipcMain.handle('shell:show-item', (_e, p: string) => {
  if (p) shell.showItemInFolder(p);
});

// pi subprocess
ipcMain.handle('pi:start', (_e, opts: { cwd: string; sessionPath?: string | null; extraArgs?: string[] }) => {
  if (!opts?.cwd) throw new Error('缺少工作目录');
  if (!fs.existsSync(opts.cwd)) throw new Error(`目录不存在: ${opts.cwd}`);
  rpc.start({
    nodePath: process.execPath,
    cliPath: bundledCliPath(),
    cwd: opts.cwd,
    sessionPath: opts.sessionPath || null,
    extraArgs: opts.extraArgs || [],
  });
  return true;
});

ipcMain.handle('pi:stop', () => {
  rpc.stop();
  return true;
});

ipcMain.handle('pi:command', (_e, cmd) => {
  const { $timeout, ...rest } = cmd || {};
  return rpc.command(rest, typeof $timeout === 'number' ? $timeout : 0);
});

ipcMain.handle('pi:ext-respond', (_e, record) => {
  rpc.respondExtUi(record);
  return true;
});

// sessions
ipcMain.handle('sessions:list', (_e, filterCwd?: string) => listSessions(filterCwd));
ipcMain.handle('sessions:tree', (_e, file: string) => buildSessionTree(file));
ipcMain.handle('sessions:delete', (_e, file: string) => {
  fs.rmSync(file, { force: true });
  return true;
});

// pi config (auth / settings)
ipcMain.handle('pi-config:read', () => ({
  auth: maskAuth(),
  settings: readSettings(),
  agentDir: agentDir(),
}));
ipcMain.handle('pi-config:set-key', (_e, provider: string, key: string) => {
  setProviderKey(provider, key);
  return maskAuth();
});
ipcMain.handle('pi-config:clear-key', (_e, provider: string) => {
  clearProviderKey(provider);
  return maskAuth();
});
ipcMain.handle('pi-config:write-settings', (_e, patch: Record<string, any>) => writeSettings(patch));

ipcMain.handle('diag:log', () => ({
  stderr: rpc.lastStderr,
  running: rpc.running,
  cwd: rpc.cwd,
}));

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  rpc.stop();
});
