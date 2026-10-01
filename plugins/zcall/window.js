/**
 * plugins/zcall/window.js
 *
 * The call window. The engine (its own process) connects to a loopback
 * socket opened here, sends the call state and gets the user's clicks back;
 * the window is a small always-on-top BrowserWindow. The socket is passed to
 * the engine in ZCALL_UI_PORT / ZCALL_UI_TOKEN (inherited through the spawn);
 * the engine's first line is the token. Then one JSON object per line:
 *
 *   engine -> ui  {type:"state", phase, name, avatar, text, since, video, muted,
 *                  speakerOff, peerCamOff, peerMuted, peerSharing}
 *                 {type:"video", key, codec, data}   one received H.264 frame (Annex-B, base64)
 *                 {type:"keyframe"}                  the phone needs a key frame
 *                 {type:"close", text}
 *   ui -> engine  {action:"hangup"|"accept"|"reject"|"mute"|"speaker"|"camera", on?}
 *                 {action:"videoFrame", key, data}   our camera, H.264 Annex-B (base64)
 *                 {action:"device", kind:"mic"|"speaker", id}   PulseAudio source / sink ("" = default)
 *                 {action:"screen", on}               our screen replaces the camera
 *
 * phase: outgoing | incoming | connecting | connected | ended.
 *
 * Video: the camera is encoded with WebCodecs (H.264 baseline, 15 fps, at
 * most 640 px, key frame every 2 s or when the engine asks). With
 * ZCALL_TEST_VIDEO=1 and no camera, a moving test pattern is sent instead.
 * Sharing the screen replaces the camera (10 fps, at most 1280 px).
 *
 * Devices: the chevron on Micro / Camera / Loa picks the device, also during
 * a call. Microphones and speakers come from PipeWire (pactl), cameras from
 * Chromium; the choice is saved in <userData>/zcall-devices.json and sent to
 * the engine whenever it connects.
 */

'use strict';

const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WIDTH = 300;
const HEIGHT = 420;
const VIDEO_WIDTH = 360; // the peer's camera is portrait
const VIDEO_HEIGHT = 640;
const COMPACT_WIDTH = 180; // compact: a small tile in the screen's corner
const COMPACT_HEIGHT = 320;
const COMPACT_MARGIN = 16;
const CLOSE_DELAY_MS = 1500; // keep "Đã kết thúc" visible a moment
const RADIUS = 10;

// Rounded-rectangle window shape as 1-px rows for the corners. Zalo runs
// under XWayland, where a transparent window alone does not show rounded
// corners; the X shape clips them for real.
function roundedShape(w, h, r) {
  const rects = [{ x: 0, y: r, width: w, height: h - 2 * r }];
  for (let i = 0; i < r; i++) {
    const dy = r - i - 0.5;
    const inset = Math.ceil(r - Math.sqrt(r * r - dy * dy));
    rects.push({ x: inset, y: i, width: w - 2 * inset, height: 1 });
    rects.push({ x: inset, y: h - 1 - i, width: w - 2 * inset, height: 1 });
  }
  return rects;
}

let server = null;
let client = null;
let win = null;
let winReady = false;
let lastState = null;
let closeTimer = null;
let videoMode = false;
let compact = null; // the normal bounds while the window is compact
let htmlFile = null;

// --- devices: { mic, speaker } PulseAudio names, camera { id, label }; '' / null = default ---
let prefsFile = null;
let prefs = null;

function loadPrefs() {
  if (prefs) return prefs;
  prefs = { mic: '', speaker: '', camera: null };
  try {
    prefsFile = path.join(require('electron').app.getPath('userData'), 'zcall-devices.json');
    Object.assign(prefs, JSON.parse(fs.readFileSync(prefsFile, 'utf8')));
  } catch (_) { /* first run */ }
  return prefs;
}

function savePrefs() {
  if (!prefsFile) return;
  try { fs.writeFileSync(prefsFile, JSON.stringify(prefs, null, 2)); } catch (e) { console.error('[zcall-window] save devices:', e.message); }
}

function pactl(args) {
  return new Promise((resolve) => {
    execFile('pactl', args, { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out)));
  });
}

// Inputs without the monitors of outputs; outputs. Each { id, label }.
async function listAudio(kind) {
  const json = await pactl(['-f', 'json', 'list', kind]);
  let list = [];
  try {
    list = JSON.parse(json).map((d) => ({ id: d.name, label: d.description || d.name }));
  } catch (_) {
    // pactl without -f json (PulseAudio < 16): names only.
    list = (await pactl(['list', 'short', kind])).split('\n').map((l) => l.split('\t')[1]).filter(Boolean).map((n) => ({ id: n, label: n }));
  }
  // Not the monitors, nor the engine's own processed devices (zcall_ec_*: picking them would loop).
  return list.filter((d) => !d.id.endsWith('.monitor') && !d.id.startsWith('zcall_ec_'));
}

async function audioDevices() {
  const [mics, speakers, defMic, defSpeaker] = await Promise.all([
    listAudio('sources'), listAudio('sinks'), pactl(['get-default-source']), pactl(['get-default-sink']),
  ]);
  return { mics, speakers, defaultMic: defMic.trim(), defaultSpeaker: defSpeaker.trim(), prefs: loadPrefs() };
}

function sendDevicePrefs() {
  const p = loadPrefs();
  if (p.mic) send({ action: 'device', kind: 'mic', id: p.mic });
  if (p.speaker) send({ action: 'device', kind: 'speaker', id: p.speaker });
}

function send(msg) {
  if (client && !client.destroyed) {
    try { client.write(JSON.stringify(msg) + '\n'); } catch (_) { /* engine gone */ }
  }
}

function pushState(state) {
  lastState = state;
  if (win && !win.isDestroyed() && winReady) win.webContents.send('zcall-ui-state', state);
}

function ensureWindow() {
  const { BrowserWindow } = require('electron');
  clearTimeout(closeTimer);
  if (win && !win.isDestroyed()) return win;
  winReady = false;
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    frame: false,
    resizable: false,
    movable: true,
    center: true,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Cuộc gọi Zalo',
    // Transparent window so the page can round its corners (10px).
    transparent: true,
    backgroundColor: '#00000000',
    // Internal window with static HTML (the only remote content is the
    // avatar image): node integration is safe here.
    webPreferences: { contextIsolation: false, nodeIntegration: true },
  });
  win.setMenuBarVisibility(false);
  applyShape(WIDTH, HEIGHT);
  win.webContents.on('did-finish-load', () => {
    winReady = true;
    if (lastState) win.webContents.send('zcall-ui-state', lastState);
  });
  // Closing the window during a call ends it (or declines a ringing call).
  win.on('close', () => {
    if (lastState && lastState.phase !== 'ended') send({ action: 'hangup' });
    lastState = null;
  });
  win.on('closed', () => { win = null; winReady = false; videoMode = false; compact = null; });
  // From a file, not a data: URL: WebCodecs (video) needs a secure context.
  if (!htmlFile) {
    htmlFile = path.join(os.tmpdir(), `zcall-window-${process.pid}.html`);
    fs.writeFileSync(htmlFile, HTML);
  }
  win.loadFile(htmlFile);
  return win;
}

function applyShape(w, h) {
  try { win.setShape(roundedShape(w, h, RADIUS)); } catch (_) { /* not supported: CSS corners only */ }
}

// Video call (or its first frame): grow the window to a portrait video size, keeping its center.
function enterVideoMode() {
  if (videoMode || !win || win.isDestroyed()) return;
  videoMode = true;
  const b = compact || win.getBounds();
  if (compact) { // back to the video size when expanded
    compact = { x: Math.round(b.x + (b.width - VIDEO_WIDTH) / 2), y: Math.round(b.y + (b.height - VIDEO_HEIGHT) / 2), width: VIDEO_WIDTH, height: VIDEO_HEIGHT };
    return;
  }
  win.setResizable(true);
  win.setBounds({ x: Math.round(b.x + (b.width - VIDEO_WIDTH) / 2), y: Math.round(b.y + (b.height - VIDEO_HEIGHT) / 2), width: VIDEO_WIDTH, height: VIDEO_HEIGHT });
  win.setResizable(false);
  applyShape(VIDEO_WIDTH, VIDEO_HEIGHT);
}

function setBounds(b) {
  win.setResizable(true);
  win.setBounds(b);
  win.setResizable(false);
  applyShape(b.width, b.height);
}

// Compact: a small tile in the bottom-right corner of the window's screen,
// so it hides little of a shared screen; expanding restores the bounds.
function setCompact(on) {
  if (!win || win.isDestroyed() || !!compact === on) return;
  if (on) {
    compact = win.getBounds();
    const wa = require('electron').screen.getDisplayMatching(compact).workArea;
    setBounds({ x: wa.x + wa.width - COMPACT_WIDTH - COMPACT_MARGIN, y: wa.y + wa.height - COMPACT_HEIGHT - COMPACT_MARGIN, width: COMPACT_WIDTH, height: COMPACT_HEIGHT });
  } else {
    setBounds(compact);
    compact = null;
  }
  win.webContents.send('zcall-ui-compact', on);
}

function onEngineMessage(m) {
  if (m.type === 'state') {
    const first = !lastState || lastState.phase === 'ended';
    const w = ensureWindow();
    pushState(m);
    // A video call has five buttons: take the video size at once, not on the first frame.
    if (m.video && m.phase !== 'incoming') enterVideoMode();
    if (first || m.phase === 'incoming') {
      w.show();
      w.focus();
      if (m.phase === 'incoming') w.flashFrame(true);
    }
  } else if (m.type === 'keyframe') {
    if (win && !win.isDestroyed() && winReady) win.webContents.send('zcall-ui-keyframe');
  } else if (m.type === 'video') {
    if (!win || win.isDestroyed() || !winReady || !lastState || lastState.phase !== 'connected') return;
    enterVideoMode();
    win.webContents.send('zcall-ui-video', m);
  } else if (m.type === 'close') {
    if (!win || win.isDestroyed()) { lastState = null; return; }
    pushState({ ...(lastState || {}), phase: 'ended', text: m.text || 'Đã kết thúc' });
    closeTimer = setTimeout(() => {
      lastState = null;
      if (win && !win.isDestroyed()) win.destroy();
    }, CLOSE_DELAY_MS);
  }
}

function onConnection(sock) {
  const token = process.env.ZCALL_UI_TOKEN;
  let authed = false;
  let buf = '';
  sock.setEncoding('utf8');
  sock.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!authed) {
        if (line !== token) { sock.destroy(); return; }
        authed = true;
        if (client && client !== sock) client.destroy(); // engine restarted
        client = sock;
        sendDevicePrefs();
        continue;
      }
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      onEngineMessage(m);
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => {
    if (client !== sock) return;
    client = null;
    // Engine died mid-call: do not leave a dead window around.
    if (lastState) onEngineMessage({ type: 'close', text: 'Mất kết nối với bộ gọi điện' });
  });
}

/** Opens the socket and exports ZCALL_UI_PORT / ZCALL_UI_TOKEN. Call before the engine starts. */
function start() {
  if (server) return;
  const { ipcMain } = require('electron');
  process.env.ZCALL_UI_TOKEN = crypto.randomBytes(16).toString('hex');
  server = net.createServer(onConnection);
  server.on('error', (e) => console.error('[zcall-window]', e.message));
  server.listen(0, '127.0.0.1', () => {
    process.env.ZCALL_UI_PORT = String(server.address().port);
  });
  ipcMain.handle('zcall-ui-devices', () => audioDevices());
  // The screen to share. With PipeWire capture (Wayland, see zcall.configure)
  // this asks the desktop's portal, which lets the user pick one.
  ipcMain.handle('zcall-ui-screen-source', async () => {
    const { desktopCapturer } = require('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const s = sources.find((x) => x.id.startsWith('screen:')) || sources[0];
    return s ? s.id : null;
  });
  // Window controls of the page: minimize / compact / expand, and restore.
  // The desktop's screen picker belongs to Zalo's main window and opens
  // under our always-on-top one (clearing always-on-top does not help under
  // XWayland): the page has us minimized until the share starts or fails.
  ipcMain.on('zcall-ui-window', (_e, op) => {
    if (!win || win.isDestroyed()) return;
    if (op === 'minimize') win.minimize();
    else if (op === 'restore') { win.restore(); win.show(); }
    else if (op === 'compact' || op === 'expand') { win.restore(); win.show(); setCompact(op === 'compact'); }
  });
  ipcMain.on('zcall-ui-action', (_e, action) => {
    if (!action || typeof action.action !== 'string') return;
    if (action.action === 'videoFrame') { send(action); return; } // hot path
    if (action.action === 'device') {
      const p = loadPrefs();
      if (action.kind === 'camera') { p.camera = action.id ? { id: String(action.id), label: String(action.label || '') } : null; savePrefs(); return; }
      if (action.kind !== 'mic' && action.kind !== 'speaker') return;
      p[action.kind] = typeof action.id === 'string' ? action.id : '';
      savePrefs();
      send({ action: 'device', kind: action.kind, id: p[action.kind] });
      return;
    }
    if (lastState && (action.action === 'mute' || action.action === 'speaker')) {
      lastState = { ...lastState, [action.action === 'mute' ? 'muted' : 'speakerOff']: !!action.on };
      pushState(lastState);
    }
    send(action);
  });
}

function stop() {
  if (win && !win.isDestroyed()) win.destroy();
  if (htmlFile) try { fs.unlinkSync(htmlFile); } catch (_) { /* gone */ }
  if (server) server.close();
  server = null;
}

const ICONS = {
  mic: '<path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z"/>',
  micOff: '<path d="M15 10.6V5a3 3 0 0 0-5.7-1.3L15 9.4v1.2ZM19 11h-2a5 5 0 0 1-.6 2.4l1.5 1.5A7 7 0 0 0 19 11ZM4.3 3 3 4.3l6 6V11a3 3 0 0 0 4.4 2.6l1.6 1.6A5 5 0 0 1 7 11H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 3.4-1.4l3.3 3.3 1.3-1.3L4.3 3Z"/>',
  speaker: '<path d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/>',
  speakerOff: '<path d="M16.5 12A4.5 4.5 0 0 0 14 8v2.2l2.5 2.4v-.6ZM19 12a7 7 0 0 1-.5 2.6l1.5 1.5A9 9 0 0 0 14 3.2v2.1a7 7 0 0 1 5 6.7ZM4.3 3 3 4.3 7.7 9H3v6h4l5 5v-6.7l4.3 4.3a7 7 0 0 1-2.3 1.2v2.1a9 9 0 0 0 3.7-1.8l2 2 1.3-1.3-9-9L4.3 3ZM12 4 9.9 6.1 12 8.2V4Z"/>',
  end: '<path d="M12 9c-1.6 0-3.1.3-4.6.7v3.1c0 .4-.2.7-.6.9-1 .5-1.8 1.1-2.6 1.8-.2.2-.4.3-.7.3s-.5-.1-.7-.3L.3 13c-.2-.2-.3-.4-.3-.7s.1-.5.3-.7A16.9 16.9 0 0 1 12 7c4.5 0 8.6 1.8 11.7 4.6.2.2.3.4.3.7s-.1.5-.3.7l-2.5 2.5c-.2.2-.4.3-.7.3s-.5-.1-.7-.3c-.8-.7-1.6-1.3-2.6-1.8-.3-.2-.6-.5-.6-.9V9.7C15.1 9.3 13.6 9 12 9Z"/>',
  cam: '<path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4Z"/>',
  camOff: '<path d="M21 6.5l-4 4V7a1 1 0 0 0-1-1H9.8L21 17.2V6.5ZM3.3 2 2 3.3 4.7 6H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12c.2 0 .4-.1.5-.2l3.2 3.2 1.3-1.3L3.3 2Z"/>',
  minimize: '<path d="M5 18h14v2H5z"/>',
  compact: '<path d="M22 3.4 15.4 10H20v2h-8V4h2v4.6L20.6 2 22 3.4ZM3.4 22 10 15.4V20h2v-8H4v2h4.6L2 20.6 3.4 22Z"/>',
  expand: '<path d="M21 11V3h-8l3.3 3.3-10 10L3 13v8h8l-3.3-3.3 10-10L21 11Z"/>',
  caret: '<path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/>',
  screen: '<path d="M20 18a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2H0v2h24v-2h-4Zm-7-3.5v-2.2c-2.8 0-4.6.8-6 2.7.6-2.7 2.1-5.3 6-5.9V7l4 3.7-4 3.8Z"/>',
  screenOff: '<path d="M21.2 18l2 2H24v-2h-2.8Zm.8-2V6a2 2 0 0 0-2-2H7.2l5.2 5.2.6-.1V7l4 3.7-1.6 1.5 5.4 5.4c.3-.3.5-.7.5-1.2ZM2.4 1.7 1.1 3l1.5 1.5c-.4.4-.6.9-.6 1.5v10a2 2 0 0 0 2 2H0v2h18.1l2.7 2.7 1.3-1.3L2.4 1.7ZM7 15c.3-1.5.9-3 2.1-4.1l1.6 1.6c-1.5.4-2.7 1.2-3.7 2.5Z"/>',
  accept: '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1A17 17 0 0 1 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1l-2.3 2.2Z"/>',
};
const svg = (name) => `<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor">${ICONS[name]}</svg>`;

const HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cuộc gọi Zalo</title><style>
  :root{color-scheme:dark;--bg:#232526;--card:#2d3031;--hover:#3b3e3f;--text:#e5e5e5;--muted:#9e9f9f;--accent:#0e70ff;--on:#e5e5e5;--on-text:#232526;--red:#f5484a;--green:#1bb35e}
  @media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#fff;--card:#eef0f3;--hover:#e1e4ea;--text:#001a33;--muted:#72808e;--on:#001a33;--on-text:#fff}}
  *{box-sizing:border-box}
  html{height:100%;background:transparent}
  body{height:100%;border-radius:${RADIUS}px;overflow:hidden;margin:0;background:var(--bg);color:var(--text);font:14px/1.45 "Open Sans",system-ui,Cantarell,"Noto Sans",Ubuntu,sans-serif;
    user-select:none;display:flex;flex-direction:column;align-items:center;-webkit-app-region:drag}
  button{-webkit-app-region:no-drag;font:inherit}
  .top{align-self:stretch;display:flex;justify-content:space-between;align-items:center;padding:10px 12px 0 16px;color:var(--muted);font-size:12px}
  .tag{visibility:hidden}.tag.show{visibility:visible}
  .avatar{margin-top:28px;width:96px;height:96px;border-radius:50%;background:var(--card) center/cover no-repeat;display:flex;align-items:center;justify-content:center;
    font-size:38px;font-weight:600;color:var(--muted);position:relative}
  .avatar.ring::after{content:"";position:absolute;inset:-8px;border-radius:50%;border:2px solid var(--accent);animation:pulse 1.4s ease-out infinite}
  @keyframes pulse{from{opacity:.9;transform:scale(.92)}to{opacity:0;transform:scale(1.18)}}
  h1{margin:18px 16px 4px;font-size:19px;font-weight:600;text-align:center;max-width:270px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .status{color:var(--muted);min-height:20px;text-align:center;padding:0 16px}
  .timer{font-variant-numeric:tabular-nums;margin-top:2px;min-height:20px;color:var(--text)}
  .buttons{margin-top:auto;margin-bottom:34px;display:flex;gap:22px;align-items:flex-start}
  .b{display:flex;flex-direction:column;align-items:center;gap:6px;color:var(--muted);font-size:12px;width:58px;text-align:center;line-height:1.25}
  .b button{width:56px;height:56px;border-radius:50%;border:0;display:flex;align-items:center;justify-content:center;cursor:pointer;
    background:var(--card);color:var(--text);transition:background .12s,filter .12s}
  .b button:hover{background:var(--hover)}
  .b button.on{background:var(--on);color:var(--on-text)}
  .b button.red{background:var(--red);color:#fff}.b button.green{background:var(--green);color:#fff}
  .b button.red:hover,.b button.green:hover{filter:brightness(1.1)}
  #ringing{gap:110px} /* answer and decline far apart: no mis-click */
  #self{position:fixed;top:12px;right:12px;width:90px;height:160px;object-fit:cover;border-radius:8px;background:#000;z-index:2;display:none;box-shadow:0 2px 8px #0008}
  body.has-self #self{display:block}
  /* Video calls have five buttons in a 360 px window: smaller, closer. */
  body.is-video .buttons{gap:8px}
  body.is-video .b button:not(.caret){width:50px;height:50px}
  body.is-video .b button.caret{top:32px;left:calc(50% + 9px)}
  .camb{display:none!important}
  body.is-video .camb{display:flex!important}
  #video{position:fixed;inset:0;width:100%;height:100%;object-fit:cover;background:#000;display:none;z-index:0}
  body.has-video #video{display:block}
  body.has-video .avatar{display:none}
  body.has-video .top,body.has-video h1,body.has-video .status,body.has-video .timer,body.has-video .notes,body.has-video .buttons{position:relative;z-index:1}
  body.has-video h1{margin-top:auto;margin-top:18px;color:#fff;text-shadow:0 1px 3px #000a}
  body.has-video .status,body.has-video .timer,body.has-video .top{color:#fff;text-shadow:0 1px 3px #000a}
  body.has-video .b span{color:#fff;text-shadow:0 1px 3px #000a}
  body.has-video .b button:not(.red):not(.green):not(.on):not(.caret){background:#0007;color:#fff}
  .b{position:relative}
  /* ▾ device menu: a small light chip on the button's corner */
  .b button.caret{position:absolute;top:38px;left:calc(50% + 12px);width:20px;height:20px;padding:0;background:var(--text);color:var(--bg);
    box-shadow:0 0 0 2px var(--bg),0 1px 4px #0006;transition:transform .12s}
  .b button.caret:hover{background:var(--text);transform:scale(1.15)}
  .b button.caret svg{width:16px;height:16px;transition:transform .15s}
  .b button.caret.open svg{transform:rotate(180deg)}
  .notes{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:8px;min-height:24px;padding:0 12px}
  .note{display:inline-flex;align-items:center;gap:5px;padding:3px 10px 3px 8px;border-radius:12px;background:var(--card);color:var(--text);font-size:12px}
  .note svg{width:14px;height:14px}
  body.has-video .note{background:#0009;color:#fff}
  #menu{position:fixed;left:12px;right:12px;bottom:118px;max-height:60%;overflow:auto;background:var(--bg);border:1px solid var(--hover);border-radius:10px;
    padding:6px 0;z-index:5;box-shadow:0 6px 20px #0008;-webkit-app-region:no-drag;display:none;font-size:13px}
  #menu.show{display:block}
  #menu .h{padding:4px 14px 6px;color:var(--muted);font-size:12px}
  #menu .it{display:flex;gap:8px;align-items:center;padding:7px 14px;cursor:pointer;white-space:nowrap}
  #menu .it span:last-child{overflow:hidden;text-overflow:ellipsis}
  #menu .it:hover{background:var(--hover)}
  #menu .ck{width:14px;flex:none;color:var(--accent);font-weight:600}
  .wctl{display:flex;gap:2px}
  .wctl button{-webkit-app-region:no-drag;width:26px;height:26px;border:0;border-radius:6px;background:transparent;color:inherit;
    display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0}
  .wctl button:hover{background:var(--hover)}
  body.has-video .wctl button:hover{background:#0006}
  .wctl svg{width:16px;height:16px}
  body.has-self #self{top:44px}
  /* Compact: a small tile with the picture, Kết thúc and expand. */
  body.compact .top{padding:6px 6px 0 10px;justify-content:flex-end}
  body.compact .tag,body.compact #minBtn,body.compact .status,body.compact .notes,body.compact #menu{display:none!important}
  body.compact .avatar{width:64px;height:64px;margin-top:24px;font-size:26px}
  body.compact h1{font-size:14px;margin:10px 8px 0;max-width:160px}
  body.compact .timer{font-size:12px}
  body.compact #incall .b:not(.endb),body.compact .b span{display:none!important}
  body.compact .buttons{margin-bottom:14px}
  body.compact #self{width:48px;height:85px;top:38px;right:6px}
  .hide{display:none!important}
</style></head><body>
  <canvas id="video"></canvas>
  <canvas id="self"></canvas>
  <div class="top"><span class="tag" id="tag">Cuộc gọi video</span>
    <span class="wctl"><button id="compactBtn" title="Thu gọn">${svg('compact')}</button><button id="minBtn" title="Thu nhỏ xuống thanh tác vụ">${svg('minimize')}</button></span></div>
  <div class="avatar" id="avatar"></div>
  <h1 id="name"></h1>
  <div class="status" id="status"></div>
  <div class="timer" id="timer"></div>
  <div class="notes"><span class="note hide" id="peerCam">${svg('camOff')}<span>Đã tắt camera</span></span><span class="note hide" id="peerMic">${svg('micOff')}<span>Đã tắt micro</span></span><span class="note hide" id="peerShare">${svg('screen')}<span>Đang chia sẻ màn hình</span></span></div>
  <div class="buttons" id="incall">
    <div class="b"><button id="mute" title="Tắt micro">${svg('mic')}</button><button class="caret" data-kind="mic" title="Chọn micro">${svg('caret')}</button><span id="muteL">Micro</span></div>
    <div class="b camb"><button id="cam" title="Tắt camera">${svg('cam')}</button><button class="caret" data-kind="camera" title="Chọn camera">${svg('caret')}</button><span id="camL">Camera</span></div>
    <div class="b camb"><button id="screen" title="Chia sẻ màn hình">${svg('screen')}</button><span id="screenL">Chia sẻ</span></div>
    <div class="b"><button id="speaker" title="Tắt loa">${svg('speaker')}</button><button class="caret" data-kind="speaker" title="Chọn loa">${svg('caret')}</button><span id="speakerL">Loa</span></div>
    <div class="b endb"><button id="end" class="red" title="Kết thúc">${svg('end')}</button><span>Kết thúc</span></div>
  </div>
  <div id="menu"></div>
  <div class="buttons hide" id="ringing">
    <div class="b"><button id="reject" class="red" title="Từ chối">${svg('end')}</button><span id="rejectL">Từ chối</span></div>
    <div class="b" id="acceptB"><button id="accept" class="green" title="Nghe">${svg('accept')}</button><span>Nghe</span></div>
  </div>
<script>
  const { ipcRenderer } = require('electron');
  const $ = (id) => document.getElementById(id);
  const ICON = ${JSON.stringify({ mic: svg('mic'), micOff: svg('micOff'), speaker: svg('speaker'), speakerOff: svg('speakerOff'), cam: svg('cam'), camOff: svg('camOff'), screen: svg('screen'), screenOff: svg('screenOff'), compact: svg('compact'), expand: svg('expand') })};
  const TEST_PATTERN = ${JSON.stringify(process.env.ZCALL_TEST_VIDEO === '1')};
  let state = {}; let tick = null;
  const act = (action, extra) => ipcRenderer.send('zcall-ui-action', Object.assign({ action }, extra || {}));
  $('end').onclick = () => act('hangup');
  $('reject').onclick = () => act('reject');
  $('accept').onclick = () => act('accept');
  $('mute').onclick = () => act('mute', { on: !state.muted });
  let compactMode = false, autoCompact = false;
  $('minBtn').onclick = () => ipcRenderer.send('zcall-ui-window', 'minimize');
  $('compactBtn').onclick = () => { autoCompact = false; ipcRenderer.send('zcall-ui-window', compactMode ? 'expand' : 'compact'); };
  ipcRenderer.on('zcall-ui-compact', (_e, on) => {
    compactMode = on;
    document.body.classList.toggle('compact', on);
    $('compactBtn').innerHTML = on ? ICON.expand : ICON.compact;
    $('compactBtn').title = on ? 'Phóng to' : 'Thu gọn';
  });
  $('speaker').onclick = () => act('speaker', { on: !state.speakerOff });
  function fmt(ms) { const s = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(s / 3600);
    const mm = String(Math.floor(s / 60) % 60).padStart(2, '0'), ss = String(s % 60).padStart(2, '0'); return (h ? h + ':' : '') + mm + ':' + ss; }
  function render() {
    const s = state;
    $('name').textContent = s.name || 'Zalo';
    document.title = (s.name || 'Zalo') + ' — Cuộc gọi Zalo';
    $('status').textContent = s.text || '';
    $('tag').classList.toggle('show', !!s.video);
    const av = $('avatar');
    if (s.avatar) { av.style.backgroundImage = 'url("' + String(s.avatar).replace(/"/g, '') + '")'; av.textContent = ''; }
    else { av.style.backgroundImage = ''; av.textContent = (s.name || '?').trim().charAt(0).toUpperCase(); }
    const ringing = s.phase === 'incoming', ended = s.phase === 'ended';
    av.classList.toggle('ring', ringing || s.phase === 'outgoing');
    $('ringing').classList.toggle('hide', !ringing);
    // A call we cannot take (group call): only a dismiss button.
    $('acceptB').classList.toggle('hide', !!s.noAnswer);
    $('rejectL').textContent = s.noAnswer ? 'Đóng' : 'Từ chối';
    $('incall').classList.toggle('hide', ringing || ended);
    $('mute').classList.toggle('on', !!s.muted); $('mute').innerHTML = s.muted ? ICON.micOff : ICON.mic;
    $('muteL').textContent = s.muted ? 'Đã tắt micro' : 'Micro';
    $('speaker').classList.toggle('on', !!s.speakerOff); $('speaker').innerHTML = s.speakerOff ? ICON.speakerOff : ICON.speaker;
    $('speakerL').textContent = s.speakerOff ? 'Đã tắt loa' : 'Loa';
    document.body.classList.toggle('is-video', !!s.video && !ringing);
    // The peer's camera off: drop its last (frozen) frame, show the avatar.
    if (s.peerCamOff) document.body.classList.remove('has-video');
    $('peerCam').classList.toggle('hide', !(s.video && s.peerCamOff && s.phase === 'connected'));
    $('peerMic').classList.toggle('hide', !(s.peerMuted && s.phase === 'connected'));
    $('peerShare').classList.toggle('hide', !(s.peerSharing && s.phase === 'connected'));
    $('screen').classList.toggle('on', sharing); $('screen').innerHTML = sharing ? ICON.screenOff : ICON.screen;
    $('screenL').textContent = sharing ? 'Dừng chia sẻ' : 'Chia sẻ';
    $('cam').classList.toggle('on', !camOn); $('cam').innerHTML = camOn ? ICON.cam : ICON.camOff;
    $('camL').textContent = camOn ? 'Camera' : (noCamera ? 'Không có camera' : 'Đã tắt camera');
    clearInterval(tick);
    const upd = () => { $('timer').textContent = s.since && !ended ? fmt(Date.now() - s.since) : ''; };
    upd(); if (s.since && !ended) tick = setInterval(upd, 500);
  }
  ipcRenderer.on('zcall-ui-state', (_e, s) => {
    state = s || {};
    if (state.phase !== 'connected') {
      stopVideo(); stopLocal(); sharing = false;
      if (pendingScreen) { pendingScreen.stop(); pendingScreen = null; }
    }
    else if (state.video && camOn && !local && !sharing) startLocal();
    render();
  });

  // --- what we send (camera or screen): capture, preview, H.264 encode, frames to the engine ---
  const self = $('self'); const sg = self.getContext('2d');
  // local: the capture running, { kind: 'camera' | 'screen', stop }.
  let camOn = true, noCamera = false, sharing = false, local = null, enc = null, nFrames = 0, lastAt = 0;
  let camPref = null, curCamId = ''; // saved choice { id, label }; the camera in use
  // Encoder settings per source. Level 3.0 (avc1.42E01E) holds 640 px: a
  // 1920x1080 camera (Iriun) encoded as is never shows on the phone. The
  // screen needs level 4.0 (avc1.42E028) for 1280 px at any aspect ratio.
  const PROFILES = {
    camera: { fps: 15, maxSide: 640, bitrate: 500000, codec: 'avc1.42E01E' },
    screen: { fps: 10, maxSide: 1280, bitrate: 1500000, codec: 'avc1.42E028' }
  };
  const KEY_MS = 2000;
  let forceKey = true, lastKeyAt = 0; // key frame now (engine asked: start, PLI) / every KEY_MS
  let scaler = null, scalerG = null;
  $('cam').onclick = () => {
    if (noCamera) return;
    camOn = !camOn;
    if (!sharing) { if (camOn) startLocal(); else { stopLocal(); act('camera', { on: false }); } }
    render();
  };
  $('screen').onclick = () => { if (sharing) stopScreen(); else startScreen(); };
  function b64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function encodeFrame(frame) {
    const P = PROFILES[sharing ? 'screen' : 'camera'];
    const now = performance.now();
    if (now - lastAt < 1000 / P.fps - 5) { frame.close(); return; }
    lastAt = now;
    const k = Math.min(1, P.maxSide / Math.max(frame.displayWidth, frame.displayHeight));
    const w = Math.round(frame.displayWidth * k) & ~1, h = Math.round(frame.displayHeight * k) & ~1;
    if (k < 1) {
      if (!scaler || scaler.width !== w || scaler.height !== h) { scaler = new OffscreenCanvas(w, h); scalerG = scaler.getContext('2d'); }
      scalerG.drawImage(frame, 0, 0, w, h);
      const ts = frame.timestamp; frame.close();
      frame = new VideoFrame(scaler, { timestamp: ts });
    }
    if (!enc || enc.state === 'closed' || enc.w !== w || enc.h !== h || enc.profile !== P) {
      if (enc && enc.state !== 'closed') try { enc.close(); } catch (_) {}
      enc = new VideoEncoder({
        output: (chunk) => {
          const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
          act('videoFrame', { key: chunk.type === 'key', data: b64(data) });
        },
        error: () => { enc = null; },
      });
      enc.configure({ codec: P.codec, width: w, height: h, bitrate: P.bitrate, framerate: P.fps, avc: { format: 'annexb' }, latencyMode: 'realtime' });
      enc.w = w; enc.h = h; enc.profile = P; nFrames = 0;
    }
    if (self.width !== w || self.height !== h) { self.width = w; self.height = h; }
    sg.drawImage(frame, 0, 0);
    document.body.classList.add('has-self');
    if (enc.encodeQueueSize < 3) {
      const key = forceKey || nFrames++ === 0 || now - lastKeyAt >= KEY_MS;
      if (key) { forceKey = false; lastKeyAt = now; }
      enc.encode(frame, { keyFrame: key });
    }
    frame.close();
  }
  // Frames of the track to the encoder until cap.stop(). onFirst(frame)
  // decides about the first one (true: encode it); onEnd() when the track
  // ends by itself.
  function runTrack(track, cap, onFirst, onEnd) {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    let alive = true, first = true;
    cap.stop = () => { alive = false; track.stop(); try { reader.cancel(); } catch (_) {} };
    (async () => {
      while (alive) {
        const { value, done } = await reader.read();
        if (done) break;
        if (first && onFirst) { first = false; if (!onFirst()) { value.close(); continue; } }
        if (alive) encodeFrame(value); else value.close();
      }
      if (alive && onEnd) onEnd();
    })();
  }
  async function startLocal() {
    if (local) return;
    local = { kind: 'camera', stop: () => {} };
    const mine = local;
    try {
      const want = { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: PROFILES.camera.fps } };
      const camId = await chosenCamera();
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ video: camId ? Object.assign({ deviceId: { exact: camId } }, want) : want, audio: false }); }
      catch (e) { if (!camId) throw e; stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false }); }
      if (local !== mine) { stream.getTracks().forEach((t) => t.stop()); return; }
      const track = stream.getVideoTracks()[0];
      curCamId = (track.getSettings && track.getSettings().deviceId) || '';
      runTrack(track, local);
      act('camera', { on: true });
    } catch (e) {
      if (!TEST_PATTERN) { noCamera = true; camOn = false; local = null; act('camera', { on: false }); render(); return; }
      // No camera: a moving test pattern (ZCALL_TEST_VIDEO=1).
      const c = new OffscreenCanvas(360, 640); const g2 = c.getContext('2d'); let i = 0;
      const timer = setInterval(() => {
        i++;
        g2.fillStyle = 'hsl(' + (i * 4 % 360) + ',70%,45%)'; g2.fillRect(0, 0, 360, 640);
        g2.fillStyle = '#fff'; g2.font = 'bold 44px sans-serif'; g2.textAlign = 'center';
        g2.fillText('Zalo Linux', 180, 280); g2.fillText(new Date().toLocaleTimeString(), 180, 350);
        g2.beginPath(); g2.arc(180 + 120 * Math.sin(i / 10), 480, 30, 0, 7); g2.fill();
        encodeFrame(new VideoFrame(c, { timestamp: i * 66666 }));
      }, 1000 / PROFILES.camera.fps);
      local.stop = () => clearInterval(timer);
      act('camera', { on: true });
    }
  }
  // Our screen in place of the camera. On Wayland the desktop's portal asks
  // which screen only once the capture runs, so the window stays minimized
  // (see 'zcall-ui-window') and the camera on until the first screen frame;
  // cancelling, or 60 s without a pick, gives up. Stopping it from the
  // desktop's indicator ends the share.
  // A failure within 3 s of the click is not the user cancelling: the first
  // capture after a launch sometimes fails at once, the second works. So
  // that one is retried, once. While sharing, the window is compact.
  let pendingScreen = null;
  async function startScreen(attempt = 1) {
    if (sharing || (pendingScreen && attempt === 1)) return;
    const cap = pendingScreen = { kind: 'screen', stop: () => {} };
    const t0 = performance.now();
    const giveUp = (why) => {
      if (pendingScreen !== cap) return;
      pendingScreen = null;
      cap.stop();
      act('log', { text: 'screen share attempt ' + attempt + ': ' + why });
      if (attempt === 1 && why !== 'timeout' && performance.now() - t0 < 3000 && state.phase === 'connected') {
        setTimeout(() => startScreen(2), 300);
        return;
      }
      ipcRenderer.send('zcall-ui-window', 'restore');
    };
    if (attempt === 1) ipcRenderer.send('zcall-ui-window', 'minimize');
    let stream;
    try {
      const id = await ipcRenderer.invoke('zcall-ui-screen-source');
      if (!id) throw new Error('no screen source');
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: {
        chromeMediaSource: 'desktop', chromeMediaSourceId: id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: PROFILES.screen.fps } } });
    } catch (e) {
      giveUp((e && e.name) + ': ' + (e && e.message)); // cancelled in the portal, or no capture
      return;
    }
    if (pendingScreen !== cap || state.phase !== 'connected') { stream.getTracks().forEach((t) => t.stop()); giveUp('call over'); return; }
    const track = stream.getVideoTracks()[0];
    setTimeout(() => giveUp('timeout'), 60000);
    runTrack(track, cap, () => {
      if (pendingScreen !== cap || state.phase !== 'connected') { giveUp('call over'); return false; }
      pendingScreen = null;
      act('log', { text: 'screen share started (attempt ' + attempt + ')' });
      autoCompact = !compactMode;
      ipcRenderer.send('zcall-ui-window', 'compact');
      stopLocal(); // the camera
      sharing = true;
      forceKey = true;
      local = cap;
      act('screen', { on: true });
      act('camera', { on: true }); // the phone shows our video only while it thinks the camera is on
      render();
      return true;
    }, () => { if (local === cap) stopScreen(); else giveUp('ended before a frame'); });
  }
  function stopScreen() {
    if (!sharing) return;
    sharing = false;
    if (autoCompact) { autoCompact = false; ipcRenderer.send('zcall-ui-window', 'expand'); }
    stopLocal();
    act('screen', { on: false });
    if (camOn && state.phase === 'connected') startLocal(); else act('camera', { on: false });
    render();
  }
  function stopLocal() {
    if (local) { local.stop(); local = null; }
    curCamId = '';
    if (enc && enc.state !== 'closed') try { enc.close(); } catch (_) {}
    enc = null;
    document.body.classList.remove('has-self');
  }

  // Received video: H.264 Annex-B frames decoded with WebCodecs, drawn on the canvas.
  const canvas = $('video'); const g = canvas.getContext('2d');
  let dec = null, decCodec = null, ts = 0;
  function stopVideo() {
    if (dec && dec.state !== 'closed') try { dec.close(); } catch (_) {}
    dec = null; decCodec = null;
    document.body.classList.remove('has-video');
  }
  function newDecoder(codec) {
    if (dec && dec.state !== 'closed') try { dec.close(); } catch (_) {}
    decCodec = codec;
    dec = new VideoDecoder({
      output: (f) => {
        if (canvas.width !== f.displayWidth || canvas.height !== f.displayHeight) { canvas.width = f.displayWidth; canvas.height = f.displayHeight; }
        g.drawImage(f, 0, 0); f.close();
        if (!state.peerCamOff) document.body.classList.add('has-video');
      },
      error: () => { dec = null; }, // wait for the next key frame
    });
    // Software: the hardware path refuses these streams on this Electron.
    dec.configure({ codec, optimizeForLatency: true, hardwareAcceleration: 'prefer-software' });
  }
  ipcRenderer.on('zcall-ui-video', (_e, m) => {
    if (state.phase !== 'connected') return;
    if (m.key && (!dec || dec.state === 'closed' || m.codec !== decCodec)) newDecoder(m.codec);
    if (!dec || dec.state !== 'configured') return;
    const bin = atob(m.data); const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
    try { dec.decode(new EncodedVideoChunk({ type: m.key ? 'key' : 'delta', timestamp: ts += 66666, data })); } catch (_) { dec = null; }
  });
  ipcRenderer.on('zcall-ui-keyframe', () => { forceKey = true; });

  // --- device menus (▾): microphones and speakers from PipeWire, cameras from Chromium ---
  const menu = $('menu');
  ipcRenderer.invoke('zcall-ui-devices').then((d) => { camPref = d.prefs.camera || null; }).catch(() => {});
  async function cameras() {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput')
      .map((d, i) => ({ id: d.deviceId, label: d.label || ('Camera ' + (i + 1)) }));
  }
  // The saved camera if it is plugged in (ids can change: fall back to the name).
  async function chosenCamera() {
    if (!camPref) return null;
    const cams = await cameras();
    const m = cams.find((c) => c.id === camPref.id) || cams.find((c) => camPref.label && c.label === camPref.label);
    return m ? m.id : null;
  }
  function closeMenu() {
    menu.classList.remove('show'); menu.textContent = ''; menu.dataset.kind = '';
    document.querySelectorAll('.caret.open').forEach((b) => b.classList.remove('open'));
  }
  async function openMenu(kind) {
    if (menu.dataset.kind === kind) { closeMenu(); return; }
    let items, current, title;
    if (kind === 'camera') {
      title = 'Camera';
      items = await cameras();
      current = curCamId || (await chosenCamera()) || (items[0] && items[0].id);
    } else {
      const d = await ipcRenderer.invoke('zcall-ui-devices');
      const list = kind === 'mic' ? d.mics : d.speakers;
      const def = list.find((x) => x.id === (kind === 'mic' ? d.defaultMic : d.defaultSpeaker));
      title = kind === 'mic' ? 'Micro' : 'Loa';
      items = [{ id: '', label: 'Mặc định hệ thống' + (def ? ' (' + def.label + ')' : '') }].concat(list);
      current = list.some((x) => x.id === d.prefs[kind]) ? d.prefs[kind] : '';
    }
    menu.textContent = '';
    const row = (ck, text) => {
      const r = document.createElement('div'); r.className = 'it'; r.title = text;
      const c = document.createElement('span'); c.className = 'ck'; c.textContent = ck ? '✓' : '';
      const t = document.createElement('span'); t.textContent = text;
      r.append(c, t); menu.appendChild(r); return r;
    };
    const h = document.createElement('div'); h.className = 'h'; h.textContent = title; menu.appendChild(h);
    if (!items.length) row(false, 'Không tìm thấy thiết bị');
    for (const it of items) {
      row(it.id === current, it.label).onclick = (e) => { e.stopPropagation(); closeMenu(); pick(kind, it); };
    }
    menu.dataset.kind = kind;
    menu.classList.add('show');
    document.querySelectorAll('.caret').forEach((b) => b.classList.toggle('open', b.dataset.kind === kind));
  }
  function pick(kind, it) {
    act('device', { kind, id: it.id, label: it.label });
    if (kind !== 'camera') return;
    camPref = { id: it.id, label: it.label };
    if (local && local.kind === 'camera' && it.id !== curCamId) { stopLocal(); startLocal(); }
  }
  document.querySelectorAll('.caret').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); openMenu(b.dataset.kind).catch(closeMenu); };
  });
  document.addEventListener('click', (e) => { if (!menu.contains(e.target)) closeMenu(); });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menu.dataset.kind) closeMenu(); else if (state.phase === 'incoming') act('reject');
  });
</script></body></html>`;

module.exports = { start, stop };
