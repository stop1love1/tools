const { app, BrowserWindow, Menu, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
let mainWindow;
let serverProcess;

const PORT = 4747;
const SERVER_BIN = path.join(__dirname, 'dist', 'jira-dashboard-linux');

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    icon: path.join(__dirname, '..', 'public', 'favicon.svg'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`http://localhost:${PORT}`);
  // mainWindow.webContents.openDevTools();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function waitForServer() {
  return new Promise((resolve) => {
    const check = () => {
      http
        .get(`http://localhost:${PORT}`, (res) => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            setTimeout(check, 100);
          }
        })
        .on('error', () => setTimeout(check, 100));
    };
    check();
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    console.log(`Starting Jira Dashboard server from ${SERVER_BIN}`);
    serverProcess = spawn(SERVER_BIN, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    serverProcess.stdout.on('data', (data) => {
      console.log(`[Server] ${data.toString().trim()}`);
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`[Server Error] ${data.toString().trim()}`);
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start server:', err);
      reject(err);
    });

    waitForServer()
      .then(() => {
        console.log('Server is ready!');
        resolve();
      })
      .catch(reject);
  });
}

app.on('ready', async () => {
  try {
    await startServer();
    createWindow();
  } catch (err) {
    console.error('Failed to initialize:', err);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  if (serverProcess) {
    console.log('Stopping server...');
    serverProcess.kill();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// Create menu
const menu = Menu.buildFromTemplate([
  {
    label: 'File',
    submenu: [
      {
        label: 'Exit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => app.quit(),
      },
    ],
  },
  {
    label: 'View',
    submenu: [
      {
        label: 'Reload',
        accelerator: 'CmdOrCtrl+R',
        click: () => mainWindow?.webContents.reload(),
      },
      {
        label: 'Toggle DevTools',
        accelerator: 'CmdOrCtrl+Shift+I',
        click: () => mainWindow?.webContents.toggleDevTools(),
      },
    ],
  },
]);

Menu.setApplicationMenu(menu);
