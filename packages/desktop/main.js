// KobeDB Studio — Electron desktop shell.
// Boots the KobeDB + KobeDeploy server (using Electron's bundled Node) and opens
// the Studio dashboard in a native window. Postgres is expected on DATABASE_URL
// (default: the docker-compose Postgres); the app surfaces a clear error if it's
// unreachable.
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const http = require('node:http');

const SERVER_PORT = process.env.PORT || '8000';
const STUDIO_URL = `http://localhost:${SERVER_PORT}/studio/`;

// In a packaged app the server lives under resources/server/dist; in dev it's the sibling package.
const packaged = app.isPackaged;
const serverEntry = packaged
  ? path.join(process.resourcesPath, 'server', 'dist', 'index.js')
  : path.join(__dirname, '..', 'server', 'dist', 'index.js');

let serverProc = null;
let win = null;

function startServer() {
  serverProc = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1', // run the server script with Electron's Node, no separate install
      PORT: String(SERVER_PORT),
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://kobedb:kobedb@localhost:5432/kobedb',
      STORAGE_PATH: path.join(app.getPath('userData'), 'storage'),
      BACKUP_DIR: path.join(app.getPath('userData'), 'backups'),
      FUNCTIONS_PATH: process.env.FUNCTIONS_PATH || path.join(app.getPath('userData'), 'functions'),
    },
    stdio: 'inherit',
  });
  serverProc.on('exit', (code) => {
    serverProc = null;
    if (code && win && !win.isDestroyed()) win.loadFile(path.join(__dirname, 'error.html'));
  });
}

function stopServer() {
  if (serverProc) {
    serverProc.kill();
    serverProc = null;
  }
}

function waitForHealth(cb, attempts = 60) {
  const req = http.get(`http://localhost:${SERVER_PORT}/health`, (res) => {
    res.resume();
    cb(res.statusCode === 200);
  });
  req.on('error', () => {
    if (attempts <= 0) return cb(false);
    setTimeout(() => waitForHealth(cb, attempts - 1), 500);
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    title: 'KobeDB Studio',
    backgroundColor: '#0f1115',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'loading.html'));
  waitForHealth((ok) => {
    if (win.isDestroyed()) return;
    if (ok) win.loadURL(STUDIO_URL);
    else win.loadFile(path.join(__dirname, 'error.html'));
  });
}

function buildMenu() {
  const template = [
    {
      label: 'KobeDB',
      submenu: [
        { label: 'Open Studio', click: () => win && win.loadURL(STUDIO_URL) },
        { label: 'Restart server', click: () => { stopServer(); startServer(); createWindow(); } },
        { type: 'separator' },
        { label: 'Open Studio in browser', click: () => shell.openExternal(STUDIO_URL) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  startServer();
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopServer();
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopServer);
