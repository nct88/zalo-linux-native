const fs = require('fs');
const path = require('path');

let logger;
try {
  logger = require('../utils/logger');
} catch (_) {
  logger = {
    info: (...args) => console.log('[INFO]', ...args),
    warn: (...args) => console.warn('[WARN]', ...args),
    error: (...args) => console.error('[ERROR]', ...args),
    success: (...args) => console.log('[SUCCESS]', ...args),
    dim: (...args) => console.log(' ', ...args)
  };
}

const APP_DIR = path.join(__dirname, '..', '..', 'app');

const THEME_MAIN_INJECTION = `
// --- Zalo Linux Auto Dark/Light Theme Sync ---
(function(){
  // Injected into the main-window factory: guard against re-runs when the
  // main window is recreated (duplicate handle() throws, duplicate monitors).
  if (process.platform !== "linux" || global.__zaloThemeSync) return;
  global.__zaloThemeSync = true;
  const { app: _app, ipcMain: _ipc, BrowserWindow: _bw, nativeTheme: _nt } = require("electron");

  function isLinuxDark() {
    try {
      const { execSync: _es } = require("child_process");
      try {
        const o = _es("gsettings get org.gnome.desktop.interface color-scheme 2>/dev/null", { timeout: 1000 }).toString();
        if (o.includes("prefer-dark")) return true;
        if (o.includes("default") || o.includes("prefer-light")) return false;
      } catch (_) {}
      try {
        const o = _es('dbus-send --session --print-reply=literal --dest=org.freedesktop.portal.Desktop /org/freedesktop/portal/desktop org.freedesktop.portal.Settings.Read string:"org.freedesktop.appearance" string:"color-scheme" 2>/dev/null', { timeout: 1000 }).toString();
        if (o.includes("uint32 1")) return true;
        if (o.includes("uint32 2") || o.includes("uint32 0")) return false;
      } catch (_) {}
      try {
        const o = _es("gsettings get org.gnome.desktop.interface gtk-theme 2>/dev/null", { timeout: 1000 }).toString().toLowerCase();
        if (o.includes("dark")) return true;
      } catch (_) {}
    } catch (_) {}
    return false;
  }

  // Theme mode chosen with the title-bar switch: "system" follows the desktop,
  // "light"/"dark" pin it. Persisted next to Zalo's own data.
  const _modeFile = require("path").join(_app.getPath("userData"), "zalo-linux-theme.json");
  let _mode = "system";
  try {
    const m = JSON.parse(require("fs").readFileSync(_modeFile, "utf8")).mode;
    if (m === "light" || m === "dark") _mode = m;
  } catch (_) {}
  const effectiveDark = () => _mode === "system" ? isLinuxDark() : _mode === "dark";
  const modeState = () => ({ mode: _mode, effective: effectiveDark() ? "dark" : "light" });

  _ipc.removeHandler("zalo-linux-get-theme");
  _ipc.handle("zalo-linux-get-theme", () => effectiveDark() ? "dark" : "light");
  _ipc.removeHandler("zalo-linux-get-theme-mode");
  _ipc.handle("zalo-linux-get-theme-mode", () => modeState());
  _ipc.removeHandler("zalo-linux-set-theme-mode");
  _ipc.handle("zalo-linux-set-theme-mode", (_e, mode) => {
    if (mode !== "system" && mode !== "light" && mode !== "dark") return modeState();
    _mode = mode;
    try { require("fs").writeFileSync(_modeFile, JSON.stringify({ mode })); } catch (_) {}
    syncTheme(true);
    return modeState();
  });

  let _lastDark = null;
  function syncTheme(force) {
    const d = effectiveDark();
    if (force === true || d !== _lastDark) {
      _lastDark = d;
      _nt.themeSource = d ? "dark" : "light";
      _bw.getAllWindows().forEach((w) => {
        try {
          if (w && !w.isDestroyed() && w.webContents) {
            w.webContents.send("zalo-linux-theme-change", d ? "dark" : "light");
          }
        } catch (_) {}
      });
    }
  }

  syncTheme();
  // GNOME: the gsettings monitor pushes changes, no polling needed. Other
  // desktops (portal / gtk-theme fallbacks) and a failed monitor poll.
  // isLinuxDark() blocks the main process, so poll sparingly.
  let _quitting = false;
  let _poll = null;
  const _startPoll = () => { if (!_poll && !_quitting) _poll = setInterval(syncTheme, 10000); };
  if (!/GNOME/i.test(process.env.XDG_CURRENT_DESKTOP || "")) _startPoll();
  try {
    const { spawn: _sp } = require("child_process");
    const _w = _sp("gsettings", ["monitor", "org.gnome.desktop.interface", "color-scheme"], { stdio: ["ignore", "pipe", "ignore"] });
    _w.stdout.on("data", () => syncTheme());
    _w.on("error", _startPoll);
    _w.on("exit", _startPoll);
    // The monitor never exits on its own: without this every app launch
    // left one orphaned gsettings process behind.
    const _stop = () => { _quitting = true; try { _w.kill(); } catch (_) {} };
    _app.on("will-quit", _stop);
    process.on("exit", _stop);
  } catch (_) { _startPoll(); }
})();
`;

// Every version of the main.js injection above (closing `})();` at column 0).
const THEME_MAIN_BLOCK_RE = /\/\/ --- Zalo Linux Auto Dark\/Light Theme Sync ---\n\(function\(\)\{[\s\S]*?\n\}\)\(\);\n?/;

// Every version of the preload injection below (`(function() {` with a space,
// unlike the main.js block; closing `})();` at column 0).
const THEME_PRELOAD_BLOCK_RE = /\/\/ --- Zalo Linux Auto Dark\/Light Theme Sync ---\n\(function\(\) \{[\s\S]*?\n\}\)\(\);\n?/;

const THEME_PRELOAD_INJECTION = `
// --- Zalo Linux Auto Dark/Light Theme Sync ---
(function() {
  if (process.platform !== "linux") return;
  const { ipcRenderer } = require("electron");

  // The title-bar switch (main process, zalo-linux-theme.json) is the only
  // source of truth. Zalo's own setting is kept on SYSTEM (2), which follows
  // nativeTheme, i.e. the switch. A pinned Zalo setting (0 light / 1 dark)
  // made Zalo render its own theme on the next launch while the switch showed
  // the other one.
  const readConf = () => { try { return JSON.parse(localStorage.getItem("za_theme") || "{}") || {}; } catch (_) { return {}; } };
  function applyTheme(isDark) {
    if (isDark) {
      document.documentElement.classList.add("dark");
      if (document.body) document.body.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
      if (document.body) document.body.classList.remove("dark");
    }
    try {
      const conf = readConf();
      const theme = isDark ? "dark" : "light";
      if (conf.theme !== theme || conf.theme_setting !== 2) {
        conf.theme = theme;
        conf.theme_setting = 2;
        localStorage.setItem("za_theme", JSON.stringify(conf));
      }
    } catch (_) {}
  }

  ipcRenderer.on("zalo-linux-theme-change", (e, mode) => {
    applyTheme(mode === "dark");
  });

  // Light/Dark picked in Zalo's own settings: adopt it as the switch mode
  // (persisted by the main process), which puts Zalo back on SYSTEM.
  try {
    const adopt = new MutationObserver(() => {
      const conf = readConf();
      if (conf.theme_setting === 0 || conf.theme_setting === 1) {
        ipcRenderer.invoke("zalo-linux-set-theme-mode", conf.theme_setting === 1 ? "dark" : "light").catch(() => {});
      }
    });
    const watch = (el) => adopt.observe(el, { attributes: true, attributeFilter: ["class"] });
    watch(document.documentElement);
    if (document.body) watch(document.body);
    else document.addEventListener("DOMContentLoaded", () => watch(document.body));
  } catch (_) {}

  try {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", (e) => applyTheme(e.matches));
    applyTheme(mq.matches);
  } catch (_) {}

  ipcRenderer.invoke("zalo-linux-get-theme").then((mode) => {
    applyTheme(mode === "dark");
  }).catch(() => {});
})();
`;

async function main() {
  const mainDistDir = path.join(APP_DIR, 'main-dist');

  // 1. Patch main-dist/main.js
  const mainJsPath = path.join(mainDistDir, 'main.js');
  if (fs.existsSync(mainJsPath)) {
    let content = fs.readFileSync(mainJsPath, 'utf8');
    const block = THEME_MAIN_INJECTION.replace(/^\n/, '');
    if (THEME_MAIN_BLOCK_RE.test(content)) {
      const updated = content.replace(THEME_MAIN_BLOCK_RE, () => block);
      if (updated !== content) {
        fs.writeFileSync(mainJsPath, updated, 'utf8');
        logger.dim('Updated auto theme watcher in main.js');
      }
    } else if (!content.includes('zalo-linux-theme-change')) {
      const anchor = 'Ae=m.createWithMultiWindow(i,o,gn,oe(),t),g(Ae),v(Ae.webContents),et.setMainWindow(Ae)';
      if (content.includes(anchor)) {
        content = content.replace(anchor, `${anchor};\n${THEME_MAIN_INJECTION}\n`);
      } else {
        content += '\n' + THEME_MAIN_INJECTION + '\n';
      }
      fs.writeFileSync(mainJsPath, content, 'utf8');
      logger.dim('Injected auto theme watcher into main.js');
    }
  }

  // 2. Patch main-dist/preload-render.js
  const preloadJsPath = path.join(mainDistDir, 'preload-render.js');
  if (fs.existsSync(preloadJsPath)) {
    let content = fs.readFileSync(preloadJsPath, 'utf8');
    const block = THEME_PRELOAD_INJECTION.replace(/^\n/, '');
    if (THEME_PRELOAD_BLOCK_RE.test(content)) {
      const updated = content.replace(THEME_PRELOAD_BLOCK_RE, () => block);
      if (updated !== content) {
        fs.writeFileSync(preloadJsPath, updated, 'utf8');
        logger.dim('Updated auto theme sync in preload-render.js');
      }
    } else if (!content.includes('zalo-linux-theme-change')) {
      content = content.trimEnd() + '\n' + THEME_PRELOAD_INJECTION + '\n';
      fs.writeFileSync(preloadJsPath, content, 'utf8');
      logger.dim('Injected auto theme sync into preload-render.js');
    }
  }

  logger.success('Auto Dark/Light theme patch applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };
