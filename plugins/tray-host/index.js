/**
 * plugins/tray-host/index.js
 *
 * Tray host detection. The tray icon only shows when a StatusNotifier host
 * owns org.kde.StatusNotifierWatcher (KDE, XFCE, GNOME with the AppIndicator
 * extension). Stock GNOME has none: the Tray object is created but invisible,
 * so hiding the window on close left Zalo running in the background with no
 * way to reopen or quit it.
 *
 * main.js hides to tray only when a host is available and quits otherwise.
 *
 * The check asks D-Bus with gdbus, busctl or dbus-send, whichever exists
 * (gdbus is not installed everywhere). Desktops with only an old XEmbed
 * tray (i3bar, lxpanel, ...) have no watcher although an icon shows:
 * ZALO_TRAY=1 forces "available", ZALO_TRAY=0 forces "none".
 */

'use strict';

const { execFile, execFileSync } = require('child_process');

const WATCHER = 'org.kde.StatusNotifierWatcher';
// NameHasOwner(WATCHER); each tool prints "true" when it is owned.
const QUERIES = [
  ['gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
    '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER]],
  ['busctl', ['--user', 'call', 'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
    'NameHasOwner', 's', WATCHER]],
  ['dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus',
    'org.freedesktop.DBus.NameHasOwner', 'string:' + WATCHER]]
];
const TIMEOUT_MS = 3000;
// The host can come and go (extension toggled, panel restarted).
const RECHECK_MS = 60000;

let available = false;
let timer = null;
let query = null; // the first tool of QUERIES that runs here

function parse(out) {
  return /\btrue\b/.test(String(out));
}

function forced() {
  const v = process.env.ZALO_TRAY;
  return v === '1' ? true : v === '0' ? false : null;
}

// Synchronous first check so the startup decisions (start-hidden) are right.
function init() {
  if (process.platform !== 'linux') {
    available = true;
    return available;
  }
  if (forced() !== null) {
    available = forced();
    return available;
  }
  available = false;
  for (const q of QUERIES) {
    try {
      available = parse(execFileSync(q[0], q[1], { timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }));
      query = q;
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') { query = q; break; } // the tool exists: no watcher (or no bus)
    }
  }
  if (!timer && query) {
    timer = setInterval(() => {
      execFile(query[0], query[1], { timeout: TIMEOUT_MS }, (err, out) => {
        available = !err && parse(out);
      });
    }, RECHECK_MS);
    timer.unref();
  }
  return available;
}

function isAvailable() {
  return available;
}

module.exports = { init, isAvailable };
