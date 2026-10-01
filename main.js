const { app, BrowserWindow, Menu, Tray, ipcMain, screen } = require('electron');
const path = require('path');
const fs = require('fs');

// Zalo's own app (extracted from the macOS build): next to this file in a
// checkout, next to the executable when packaged.
const appDir = fs.existsSync(path.join(__dirname, 'app'))
  ? path.join(__dirname, 'app')
  : path.join(path.dirname(process.execPath), 'app');
const iconPath = path.join(appDir, 'pc-dist', 'favicon-512x512.png');

// Hidden windows Zalo uses as background processes, never the main window.
const BACKGROUND_WINDOW_TITLES = ['Shared Worker', 'SQLite'];

app.setName('zalo');

// Drivers where Electron 22's GPU path fails (black window, GPU process
// crashes; e.g. some NVIDIA / Wayland setups): ZALO_DISABLE_GPU=1.
if (process.env.ZALO_DISABLE_GPU === '1') app.disableHardwareAcceleration();

// Point libpulse at the PulseAudio / pipewire-pulse socket when it exists;
// otherwise libpulse finds its server, or Chromium falls back to ALSA.
if (process.platform === 'linux' && !process.env.PULSE_SERVER) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  const pulseSocket = path.join(runtimeDir, 'pulse', 'native');
  if (fs.existsSync(pulseSocket)) process.env.PULSE_SERVER = `unix:${pulseSocket}`;
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const screenshotPlugin = require('./plugins/screenshot');
const launcherBadgePlugin = require('./plugins/launcher-badge');
const trayHost = require('./plugins/tray-host');
const zcall = require('./plugins/zcall');
// Created with the main window: the screen module is not usable before 'ready'.
let windowState = null;
const startHidden = require('./plugins/start-hidden').createStartHiddenController({
  onMaximize: () => { if (windowState) windowState.requestMaximize(); }
});

let tray = null;
let mainWindow = null;
let isAppQuitting = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toggleDevTools() {
  const win = BrowserWindow.getFocusedWindow() || mainWindow;
  if (!win || win.isDestroyed()) return;
  if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
  else win.webContents.openDevTools({ mode: 'detach' });
}

// Native Wayland windows cannot be moved by the app, only X11/XWayland ones.
function isNativeWayland() {
  const platform = app.commandLine.getSwitchValue('ozone-platform');
  const hint = app.commandLine.getSwitchValue('ozone-platform-hint');
  return platform === 'wayland' ||
    ((hint === 'wayland' || hint === 'auto') && process.env.XDG_SESSION_TYPE === 'wayland');
}

function showMainWindow() {
  startHidden.release();
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop();
  mainWindow.webContents.send('show-from-tray');
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
}

function quitApp() {
  isAppQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  app.quit();
}

function createTray() {
  if (!fs.existsSync(iconPath)) return;
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.error('Tray init failed:', e);
    return;
  }
  tray.setToolTip('Zalo');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Mở Zalo', click: showMainWindow },
    { label: 'Ẩn Zalo', click: hideMainWindow },
    { label: 'Toggle DevTools', click: toggleDevTools },
    { label: 'Thoát', click: quitApp }
  ]));
}

// The first window that is not one of Zalo's background windows.
function attachMainWindow(win) {
  mainWindow = win;
  screenshotPlugin.setMainWindow(win);

  if (!windowState) {
    windowState = require('./plugins/window-state').createWindowStateController({
      screen,
      canPosition: !isNativeWayland(),
      stateFile: path.join(app.getPath('userData'), 'zalo-linux-window-state.json')
    });
  }
  windowState.attach(win);

  // Start hidden only when there is a tray to bring the window back.
  if (tray && trayHost.isAvailable()) startHidden.attach(win);

  win.webContents.on('before-input-event', (_event, input) => {
    if (input.control && input.shift && input.key.toLowerCase() === 'i') toggleDevTools();
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Launching Zalo again (dock, menu, notification) starts a second instance
// that only hands its arguments to the running one: Zalo's
// second-instance.js quits it during bootstrap, but 'ready' and 'before-quit'
// still fire in it. It must not start the tray or the plugins, nor stop the
// call engine (that would end the running instance's call).
function isPrimaryInstance() {
  return app.hasSingleInstanceLock();
}

app.on('before-quit', () => {
  isAppQuitting = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
});

// Zalo cancels the first quit to let the renderer save its state, then quits
// again, so 'before-quit' fires twice; 'will-quit' fires once, after every
// window is closed.
app.on('will-quit', () => {
  if (isPrimaryInstance()) zcall.stop();
});

// Registered before Zalo's bootstrap, so this runs before Zalo's own
// second-instance handler tries to show the window.
app.on('second-instance', () => startHidden.release());

app.on('browser-window-created', (_evt, win) => {
  if (fs.existsSync(iconPath)) win.setIcon(iconPath);
  win.setMenuBarVisibility(false);
  win.removeMenu();

  if (!mainWindow && !BACKGROUND_WINDOW_TITLES.includes(win.getTitle())) {
    try {
      attachMainWindow(win);
    } catch (e) {
      console.error('Main window setup failed:', e);
    }
  }

  // Closing hides Zalo to the tray. The 50 ms delay lets preventDefault()
  // settle first: hiding at once makes "Mở Zalo" a no-op on some desktops
  // (#27). Without a tray host (stock GNOME) the icon is invisible and a
  // hidden window could never come back: quit instead.
  win.on('close', (event) => {
    if (isAppQuitting) return;
    if (tray && trayHost.isAvailable() && (win === mainWindow || win.getTitle().includes('Zalo'))) {
      event.preventDefault();
      setTimeout(() => {
        if (!isAppQuitting && !win.isDestroyed()) win.hide();
      }, 50);
    } else if (win === mainWindow) {
      event.preventDefault();
      isAppQuitting = true;
      setImmediate(() => app.quit());
    }
  });
});

app.once('ready', () => {
  if (!isPrimaryInstance()) return;
  Menu.setApplicationMenu(null);
  trayHost.init();
  createTray();

  launcherBadgePlugin.register({ app, ipcMain });
  screenshotPlugin.register({ ipcMain });
  zcall.start({ userDataDir: app.getPath('userData') });
});

// ---------------------------------------------------------------------------
// Bootstrap Zalo
// ---------------------------------------------------------------------------

const bootstrapPath = path.join(appDir, 'bootstrap.js');
if (fs.existsSync(bootstrapPath)) {
  process.chdir(appDir);
  try {
    require(bootstrapPath);
  } catch (e) {
    console.error('Error loading Zalo:', e);
  }
} else {
  console.error('Zalo bootstrap.js not found at:', bootstrapPath);
}
zcall.configure(app); // Chromium switches: after Zalo's own
