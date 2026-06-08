'use strict';

const { app, BrowserWindow, ipcMain, Tray, Menu, Notification, nativeImage, shell } = require('electron');
const path = require('path');
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');

const isDev = process.env.NODE_ENV !== 'production';
const CLI_PATH = path.join(__dirname, '..', 'dist', 'index.js');

let mainWindow = null;
let tray = null;
let currentTask = null; // { process, abortController }

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0D0000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    show: false,
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    // mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('close', (e) => {
    if (tray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  // Create a simple tray icon
  const iconPath = path.join(__dirname, 'assets', 'tray-icon.png');
  let trayIcon;
  if (fs.existsSync(iconPath)) {
    trayIcon = nativeImage.createFromPath(iconPath);
  } else {
    trayIcon = nativeImage.createEmpty();
  }

  tray = new Tray(trayIcon);
  tray.setToolTip('TRIDENT AI');

  const contextMenu = Menu.buildFromTemplate([
    { label: 'Show TRIDENT', click: () => { mainWindow && mainWindow.show(); } },
    { type: 'separator' },
    { label: 'Quit', click: () => { tray = null; app.quit(); } },
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('double-click', () => { mainWindow && mainWindow.show(); });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else if (mainWindow) mainWindow.show();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ─── IPC Handlers ──────────────────────────────────────────────────────────────

// Window controls
ipcMain.on('window-minimize', () => mainWindow && mainWindow.minimize());
ipcMain.on('window-maximize', () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on('window-close', () => {
  if (mainWindow) {
    if (tray) mainWindow.hide();
    else mainWindow.close();
  }
});

// Run a task by spawning the CLI
ipcMain.handle('run-task', async (event, task, opts = {}) => {
  // Kill any running task before starting a new one
  if (currentTask) {
    const prev = currentTask;
    currentTask = null;
    try { prev.process.kill('SIGTERM'); } catch {}
  }

  const args = [CLI_PATH, task];

  const env = {
    ...process.env,
    TRIDENT_DESKTOP: '1',
    TRIDENT_OUTPUT: 'json',
  };

  if (opts.model) env.TRIDENT_MODEL = opts.model;
  if (opts.provider) env.TRIDENT_PROVIDER = opts.provider;
  if (opts.mode) env.TRIDENT_MODE = opts.mode;
  if (opts.cwd) env.TRIDENT_CWD = opts.cwd;

  const child = spawn('node', args, {
    env,
    cwd: opts.cwd || process.cwd(),
  });

  currentTask = { process: child };

  const safeSend = (channel, payload) => {
    try {
      if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
    } catch {}
  };

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch {}
      safeSend('task-event', parsed ?? { type: 'text', content: line });
    }
  });

  child.stderr.on('data', (data) => {
    safeSend('task-event', { type: 'error', content: data.toString() });
  });

  // Hard timeout: 30 minutes — prevents the IPC promise hanging forever
  const TASK_TIMEOUT_MS = 30 * 60 * 1000;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      currentTask = null;
      safeSend('task-event', { type: 'done', exitCode: exitCode ?? 0 });
      resolve(error ? { exitCode: exitCode ?? 1, error } : { exitCode });
    };

    const timeoutHandle = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(1, 'Task timed out after 30 minutes');
    }, TASK_TIMEOUT_MS);

    child.on('close', (code) => finish(code));
    child.on('error', (err) => finish(1, err.message));
  });
});

ipcMain.on('abort-task', () => {
  if (currentTask) {
    try { currentTask.process.kill('SIGTERM'); } catch {}
    currentTask = null;
  }
});

// Config management using Conf's JSON file
function getConfigPath() {
  const configDir = path.join(os.homedir(), '.config', 'trident-cli');
  return path.join(configDir, 'config.json');
}

ipcMain.handle('get-config', async () => {
  try {
    const cfgPath = getConfigPath();
    if (!fs.existsSync(cfgPath)) {
      return getDefaultConfig();
    }
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return { ...getDefaultConfig(), ...raw };
  } catch {
    return getDefaultConfig();
  }
});

function getDefaultConfig() {
  return {
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    mode: 'review',
    maxTurns: 50,
    budgetUsd: null,
    logSessions: true,
    onboarded: true,
    userName: '',
    profile: null,
    systemOverride: '',
    codexModel: '',
    codexTimeoutMs: 180000,
  };
}

ipcMain.handle('set-config', async (_, cfg) => {
  try {
    const cfgPath = getConfigPath();
    const dir = path.dirname(cfgPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    let existing = {};
    if (fs.existsSync(cfgPath)) {
      try { existing = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch {}
    }
    const merged = { ...existing, ...cfg };
    fs.writeFileSync(cfgPath, JSON.stringify(merged, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-sessions', async () => {
  try {
    const logsDir = path.join(os.homedir(), '.trident', 'sessions');
    if (!fs.existsSync(logsDir)) return [];
    const files = fs.readdirSync(logsDir)
      .filter(f => f.endsWith('.json') || f.endsWith('.log'))
      .sort()
      .reverse()
      .slice(0, 50);
    return files.map(f => {
      const fpath = path.join(logsDir, f);
      try {
        const stat = fs.statSync(fpath);
        const raw = fs.readFileSync(fpath, 'utf8');
        let data = {};
        try { data = JSON.parse(raw); } catch {}
        return {
          id: f.replace(/\.[^.]+$/, ''),
          file: fpath,
          mtime: stat.mtime.toISOString(),
          ...data,
        };
      } catch {
        return { id: f, file: fpath };
      }
    });
  } catch {
    return [];
  }
});

ipcMain.handle('get-memory', async () => {
  try {
    const memPath = path.join(process.cwd(), 'TRIDENT.md');
    if (!fs.existsSync(memPath)) return '';
    return fs.readFileSync(memPath, 'utf8');
  } catch {
    return '';
  }
});

ipcMain.handle('set-memory', async (_, content) => {
  try {
    const memPath = path.join(process.cwd(), 'TRIDENT.md');
    fs.writeFileSync(memPath, content, 'utf8');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('list-models', async () => {
  return [
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', provider: 'anthropic' },
    { id: 'claude-opus-4-5', name: 'Claude Opus 4.5', provider: 'anthropic' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic' },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', provider: 'anthropic' },
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', provider: 'anthropic' },
    { id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'openrouter' },
    { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo', provider: 'openrouter' },
    { id: 'google/gemini-pro-1.5', name: 'Gemini Pro 1.5', provider: 'openrouter' },
    { id: 'meta-llama/llama-3.1-405b-instruct', name: 'Llama 3.1 405B', provider: 'openrouter' },
  ];
});

ipcMain.handle('shell-git', async (_, args) => {
  return new Promise((resolve) => {
    execFile('git', args, { cwd: process.cwd() }, (err, stdout, stderr) => {
      if (err) resolve({ ok: false, error: err.message, stderr });
      else resolve({ ok: true, stdout, stderr });
    });
  });
});

ipcMain.handle('read-file', async (_, filePath) => {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('get-project-tree', async (_, cwd) => {
  try {
    const dir = cwd || process.cwd();
    function walk(d, depth = 0) {
      if (depth > 4) return [];
      const entries = [];
      let items;
      try { items = fs.readdirSync(d); } catch { return []; }
      for (const item of items) {
        if (item.startsWith('.') || item === 'node_modules') continue;
        const full = path.join(d, item);
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.isDirectory()) {
          entries.push({ name: item, type: 'dir', path: full, children: walk(full, depth + 1) });
        } else {
          entries.push({ name: item, type: 'file', path: full });
        }
      }
      return entries;
    }
    return { ok: true, tree: walk(dir) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('open-external', async (_, url) => {
  await shell.openExternal(url);
});

ipcMain.handle('show-notification', async (_, { title, body }) => {
  if (Notification.isSupported()) {
    new Notification({ title, body }).show();
  }
});

ipcMain.handle('get-cwd', async () => process.cwd());
