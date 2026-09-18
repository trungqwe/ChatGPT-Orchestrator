// ==========================================================================
// Pipeline Observer & Orchestrator - Desktop Native Main Process (Electron)
// ==========================================================================

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');
const http = require('http');

let mainWindow = null;
let serverInstance = null;
let serverPort = 4000;

// Native OS Directory Dialog Handler for 1-Click Project Folder Opening
ipcMain.handle('dialog:openDirectory', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Chọn Thư Mục Dự Án Để Điều Phối & Quan Sát',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

// Auto-Send Keystrokes (Ctrl+V + Enter) to Antigravity IDE Window
const { exec } = require('child_process');
const { clipboard } = require('electron');

ipcMain.handle('antigravity:sendToIde', async (event, { prompt, projectKeyword }) => {
  if (!prompt) return { success: false, error: 'Empty prompt' };

  try {
    const tmpPromptFile = path.join(__dirname, '.temp_dispatch_prompt.txt');
    fs.writeFileSync(tmpPromptFile, prompt, 'utf8');

    const pyScript = path.join(__dirname, 'send_to_antigravity.py');
    const proj = projectKeyword || 'AI_Multi_Task';
    const pyCmd = `python "${pyScript}" "@${tmpPromptFile}" "${proj}"`;

    return new Promise((resolve) => {
      exec(pyCmd, { timeout: 15000 }, (err, stdout, stderr) => {
        try {
          const parsed = JSON.parse((stdout || '').trim());
          resolve(parsed);
        } catch (e) {
          resolve({
            success: !err && stdout && stdout.includes('"success": true'),
            output: stdout,
            error: err ? err.message : null
          });
        }
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Helper: Check if an existing server is running on a port
function isPortResponding(port) {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: port,
      path: '/api/status',
      method: 'GET',
      timeout: 1500
    }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });

    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// Helper: Start embedded express server if port 4000 is not running
async function ensureServerRunning() {
  const isRunning = await isPortResponding(4000);
  if (isRunning) {
    console.log('[DESKTOP] Found existing Pipeline daemon on port 4000. Attaching desktop window...');
    serverPort = 4000;
    return 4000;
  }

  console.log('[DESKTOP] Starting embedded Pipeline server...');
  const expressApp = require('./server');

  return new Promise((resolve) => {
    // Try port 4000 first, fallback to 0 (dynamic port) if busy
    const srv = expressApp.listen(4000, () => {
      serverPort = 4000;
      serverInstance = srv;
      console.log(`[DESKTOP] Embedded server listening on port 4000`);
      resolve(4000);
    });

    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.log('[DESKTOP] Port 4000 in use, choosing available dynamic port...');
        const altSrv = expressApp.listen(0, () => {
          serverPort = altSrv.address().port;
          serverInstance = altSrv;
          console.log(`[DESKTOP] Embedded server listening on dynamic port ${serverPort}`);
          resolve(serverPort);
        });
      } else {
        console.error('[DESKTOP] Server start error:', err);
        resolve(4000);
      }
    });
  });
}

function createMainWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 680,
    title: 'Pipeline Observer & Orchestrator (ChatGPT Web ⇄ Antigravity)',
    backgroundColor: '#0a0d14',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // Sleek native application menu
  const menuTemplate = [
    {
      label: 'Điều Phối',
      submenu: [
        {
          label: 'Làm Mới (Refresh)',
          accelerator: 'F5',
          click: () => mainWindow.reload()
        },
        {
          label: 'Tải Lại Bỏ Cache',
          accelerator: 'CmdOrCtrl+R',
          click: () => mainWindow.webContents.reloadIgnoringCache()
        },
        { type: 'separator' },
        {
          label: 'Thoát Ứng Dụng',
          accelerator: 'CmdOrCtrl+Q',
          click: () => app.quit()
        }
      ]
    },
    {
      label: 'Hiển Thị',
      submenu: [
        { role: 'resetZoom', label: 'Cỡ Chữ Gốc' },
        { role: 'zoomIn', label: 'Phóng To' },
        { role: 'zoomOut', label: 'Thu Nhỏ' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Toàn Màn Hình' }
      ]
    },
    {
      label: 'Công Cụ Kỹ Thuật',
      submenu: [
        {
          label: 'Mở Developer Tools (DevTools)',
          accelerator: 'CmdOrCtrl+Shift+I',
          click: () => mainWindow.webContents.toggleDevTools()
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(menuTemplate);
  Menu.setApplicationMenu(menu);

  // Load URL from internal port
  mainWindow.loadURL(`http://localhost:${port}/`);

  // Show window when content is ready to eliminate white flashes
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// App lifecycle
app.whenReady().then(async () => {
  const port = await ensureServerRunning();
  createMainWindow(port);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(serverPort);
    }
  });
});

app.on('window-all-closed', () => {
  if (serverInstance) {
    console.log('[DESKTOP] Closing embedded server...');
    serverInstance.close();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
