# Architecture

Zalo Linux Native runs the official Zalo macOS app (an Electron app) on Linux
inside a small Electron shell, and replaces the parts that only exist for
macOS / Windows with Linux ones: native addons, and the call helper.

## Layout

```
zalo-linux-native/
├── main.js                 Electron entry: tray, main window, plugins, then Zalo's bootstrap
├── plugins/
│   ├── zcall/              Calls: engine environment + system package check (index.js),
│   │                       the call window (window.js)
│   ├── tray-host/          Is there a StatusNotifier tray? (hide to tray, or quit on close)
│   ├── start-hidden/       Start hidden in the tray
│   ├── window-state/       Remember the main window's size and position
│   ├── launcher-badge/     Unread count on the launcher icon
│   └── screenshot/         Screenshot tool (whichever is installed: spectacle, flameshot, gnome-screenshot, …)
├── zcall-native/           The native call engine (generated from its research repository)
├── nativelibs/             Linux builds of Zalo's native addons (db-cross-v4, file-utils, zimage, …)
├── scripts/
│   ├── main.js             Pipeline: version → DMG → prepare-app → build
│   ├── check-versions.js   Zalo version (latest macOS release unless ZALO_VERSION)
│   ├── download-dmg.js     The official DMG into temp/
│   ├── prepare-app.js      Extract app.asar into app/, apply the patches (ordered list)
│   ├── patches/            One script per change to Zalo's code
│   ├── build.js            app/ → dist/Zalo-Linux-Native-<version>-<arch>.AppImage
│   └── build-stage2.sh     Repack with quick-sharun, embed the update information
├── app/                    Zalo, extracted and patched (generated, not in git)
├── temp/                   DMG cache (not in git)
└── dist/                   AppImages (not in git)
```

## Calls

Zalo's main process normally starts a call helper (`ZaloCall.exe` on Windows,
`ZaloHelper.app` on macOS) and talks to it over two local channels with
AES-encrypted JSON ("call-v2"). `scripts/patches/patch-zcall-native.js` makes
it, on Linux:

1. listen on loopback TCP ports 29631 / 29632 and require a per-launch token
   as the first line of each connection;
2. spawn `zcall-native/native-engine/zcall-native.js` on its own Electron
   (`ELECTRON_RUN_AS_NODE`), after `plugins/zcall` has checked the system
   packages.

```
Zalo (Electron)  ── call-v2 IPC (TCP, token, AES) ──  zcall-native.js (Node)
   │                                                   ├─ EngineCore: signalling like ZaloCall
   ├─ plugins/zcall/window.js  ◄── call window ──►     ├─ zrtc-media: ZRTP relay, P2P, SRTP, H.264
   │   (camera / screen → WebCodecs H.264)             └─ audio-io.py: Opus, PipeWire / PulseAudio,
   │                                                       WebRTC echo cancellation (pipewire process)
   └─ Zalo servers (signalling)                        Zalo media servers / the phone (UDP)
```

The engine, its protocol notes and tests live in a separate research
repository; `zcall-native/` here is exported from it
([zcall-native/README.md](zcall-native/README.md)).

## Patches

`prepare-app.js` applies, in order: window look (`patch-remove-menu`,
`patch-window-appearance`), chats in their own window (`patch-multi-window`),
pasting images, the native addons (`patch-sqlite3`, `patch-db-cross-v4`,
`patch-file-utilities`, `patch-file-utils`, `patch-mp4thumb`, `patch-zimage`,
`patch-zjxl`), calls (`patch-zcall-callgate`, `patch-zcall-native`,
`patch-call-signal-fix`), start at login, quitting, unread badge, XDG user
directories, opening folders, network and sync recovery, and following the
system's light / dark theme. Each patch documents what it changes and why in
its header.

## Why an Electron shell

Zalo's own code expects Electron and its macOS layout. The shell loads Zalo's
`bootstrap.js` after setting up what Linux needs first (tray, window state,
plugins, Chromium switches such as PipeWire screen capture), so Zalo runs
unmodified apart from the patches above.
