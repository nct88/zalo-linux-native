# Zalo Linux Native

[![Build](https://github.com/nct88/zalo-linux-native/actions/workflows/build.yml/badge.svg)](https://github.com/nct88/zalo-linux-native/actions/workflows/build.yml)
[![Release](https://img.shields.io/github/v/release/nct88/zalo-linux-native)](https://github.com/nct88/zalo-linux-native/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**[Tiếng Việt](#tiếng-việt) · [English](#english)**

---

## Tiếng Việt

Zalo cho Linux, đóng gói từ ứng dụng Zalo chính thức cho macOS thành một AppImage, kèm **engine gọi điện native** viết riêng cho Linux. Gọi thoại, gọi video và chia sẻ màn hình chạy trực tiếp trên Linux: không Wine, không ứng dụng Windows, không thư viện 32-bit.

> Dự án không chính thức, không liên quan tới VNG / Zalo.

### Native ở những điểm nào

Zalo không có bản Linux. Các bản Zalo cho Linux trước đây chạy phần gọi điện bằng `ZaloCall.exe` (Windows) dưới Wine. Zalo Linux Native viết lại toàn bộ phần đó:

| Phần | Cách cũ (Wine) | Zalo Linux Native |
|---|---|---|
| Engine gọi | `ZaloCall.exe` + cầu nối named pipe chạy dưới Wine | Engine Node.js + Python tự viết: giao thức call-v2 của Zalo, ZRTP relay, P2P, SRTP, Opus, H.264 |
| Khởi chạy | Wineprefix, tải Wine, kiểm tra Wine | Zalo chạy engine trực tiếp bằng chính Electron của nó |
| Âm thanh | Âm thanh Windows qua Wine | PipeWire / PulseAudio trực tiếp, xử lý WebRTC (khử vọng, khử ồn, tự cân mức) của PipeWire |
| Camera | Không có | V4L2 qua Chromium, mã hoá H.264 bằng WebCodecs |
| Chia sẻ màn hình | Xvfb + `LD_PRELOAD` | Portal của desktop (PipeWire trên Wayland), X11 |
| Cửa sổ gọi | Cửa sổ Qt của bản Windows | Cửa sổ riêng của app, theo giao diện Zalo |

### Tối ưu ở đâu

- **Dung lượng:** không còn wineprefix (~1,8 GB), không còn `ZaloCall.exe` và DLL (~65 MB), không còn bản "Full" kèm Wine (~430 MB). AppImage khoảng 170 MB.
- **Tài nguyên:** engine gọi dùng khoảng 20 MB RAM và gần như 0% CPU khi không có cuộc gọi.
- **Âm thanh:** Opus 32 kbit/s, độ phức tạp 10, có FEC. Bên nhận dựng lại gói mất bằng FEC thay vì đoán. Micro đi qua bộ xử lý WebRTC.
- **Video:** camera tối đa 640 px (H.264 Level 3.0, điện thoại nào cũng giải được), màn hình tối đa 1280 px. Gửi khung khoá ngay khi bắt đầu và khi điện thoại yêu cầu (PLI/FIR), nên hình lên gần như ngay lập tức.
- **Mở / đóng app:** thoát app khi đang gọi thì cuộc gọi kết thúc ngay ở phía bên kia. Không còn bước dọn Wine (khoảng 3 giây) khi thoát.
- **Nhiều bản phân phối:** tự kiểm tra gói hệ thống, nếu thiếu thì báo đúng lệnh cài cho Debian/Ubuntu, Fedora, Arch, openSUSE. Tự nhận biết có khay hệ thống hay không.

### Tính năng gọi điện

| Tính năng | Trạng thái |
|---|---|
| Gọi thoại 1-1: gọi đi, nghe, từ chối, kết thúc | ✅ |
| Gọi video 1-1: camera hai chiều | ✅ |
| Chia sẻ màn hình (gửi đi) | ✅ |
| Chọn micro / loa / camera ngay trong cuộc gọi, nhớ lựa chọn | ✅ |
| Hiển thị trạng thái camera / mic của bên kia | ✅ |
| Khử vọng, khử ồn, tự cân mức micro | ✅ (cần PipeWire) |
| Giao diện nghe gọi theo Zalo macOS: biểu tượng, âm thanh, font gốc (lấy từ DMG lúc build) | ✅ |
| Khung báo cuộc gọi đến ở góc màn hình, "Trả lời không mở camera" | ✅ |
| Thu nhỏ / thu gọn cửa sổ gọi; tự thu gọn khi chia sẻ màn hình | ✅ |
| Gọi video và gọi nhóm: kéo giãn, phóng to, toàn màn hình (nút trên thanh, F11, nhấp đúp; Esc để thoát) | ✅ |
| Chuyển từ gọi thoại sang gọi video giữa cuộc gọi | ❌ Zalo PC (macOS, Windows) cũng không hỗ trợ, chỉ điện thoại với điện thoại |
| P2P khi cùng mạng, relay khi khác mạng | ✅ |
| Gọi nhóm: âm thanh, camera, chia sẻ màn hình (gửi), xem camera các thành viên | ✅ (đã thử với điện thoại và Zalo macOS) |

### Cài đặt

1. Tải file `Zalo-Linux-Native-<phiên bản>-x86_64.AppImage` (hoặc `aarch64`) ở trang [Releases](https://github.com/nct88/zalo-linux-native/releases). Không tải file `.zsync`, file đó chỉ dùng để cập nhật.
2. Khuyên dùng [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever): Open → chọn file AppImage → Unlock → Move to the app menu. Gear Lever sẽ báo khi có phiên bản mới.

Gọi điện cần thêm `python3`, libopus và bộ công cụ PulseAudio. Nếu thiếu, lần gọi đầu tiên sẽ báo lệnh cài:

| Bản phân phối | Lệnh |
|---|---|
| Debian / Ubuntu / Mint | `sudo apt install python3 libopus0 pulseaudio-utils` |
| Fedora | `sudo dnf install python3 opus pulseaudio-utils` |
| Arch / Manjaro | `sudo pacman -S python opus libpulse` |
| openSUSE | `sudo zypper install python3 libopus0 pulseaudio-utils` |

### Tuỳ chỉnh

| Biến môi trường | Tác dụng |
|---|---|
| `ZALO_TRAY=1` / `0` | Ép bật / tắt chế độ khay hệ thống (cho i3bar, lxpanel… dùng khay XEmbed) |
| `ZALO_DISABLE_GPU=1` | Tắt tăng tốc GPU khi cửa sổ đen hoặc tiến trình GPU bị lỗi |
| `ZCALL_MIC` / `ZCALL_SPEAKER` | Chọn micro / loa (tên nguồn PulseAudio). Nút ▾ trong cửa sổ gọi làm được việc này |
| `ZCALL_AUDIO_PROCESSING=0` | Gọi không qua khử vọng / khử ồn |
| `ZCALL_PW_RT=0` | Không xin RTKit ưu tiên thời gian thực cho PipeWire khi nó đang chạy ưu tiên thường (mặc định có xin: luồng âm thanh không có RT thì tiếng rè khi máy bận) |
| `ZCALL_AUDIO_DIAG=0` | Không ghi dòng `diag:` (âm thanh, xrun, resync của PipeWire) vào log mỗi 10 giây |
| `ZCALL_MIC_AGC=0` | Không tự hạ âm lượng micro khi tiếng bị xén đỉnh (mặc định hạ từng 3 dB, tối đa 24 dB, giống Zalo trên Windows / macOS) |
| `ZCALL_AUDIO_DUMP=1` | Ghi âm thanh đã phát và âm thanh micro gửi đi của cuộc gọi vào `~/.config/ZaloData/call-*.raw` (để tìm lỗi; nhớ xoá sau khi dùng) |
| `ZCALL_VERBOSE=1` | Ghi chi tiết cuộc gọi vào `~/.config/ZaloData/native-engine-*.log` |
| `ZCALL_GROUP=0` | Tắt gọi nhóm (cửa sổ gọi báo chưa hỗ trợ) |
| `ZCALL_GROUP_CAMERA=0` | Gọi nhóm không gửi camera |
| `ZCALL_GROUP_CAM_LAYER=0` / `1` / `2` | Kích thước camera khi gọi nhóm: 480×240, 720×360 (mặc định), 960×480 |
| `ZCALL_SHARE_RES=720` | Cạnh ngắn của màn hình khi chia sẻ trong gọi nhóm (mặc định 720) |

### Build từ mã nguồn

```bash
git clone https://github.com/nct88/zalo-linux-native.git
cd zalo-linux-native
npm ci
npm run main          # tải Zalo macOS, giải nén, áp patch, đóng gói AppImage vào dist/
npm start             # hoặc chạy trực tiếp từ mã nguồn (sau npm run main:setup)
```

Cần Node.js 20 trở lên, Rust, `build-essential`, `liblzma-dev`, `p7zip-full`. Chi tiết ở [DEVELOPMENT.md](DEVELOPMENT.md), cách hoạt động ở [ARCHITECTURE.md](ARCHITECTURE.md), engine gọi ở [zcall-native/README.md](zcall-native/README.md).

### Giới hạn hiện tại

- Gọi nhóm gửi một lớp camera (Zalo macOS gửi hai lớp); chưa thử xem màn hình do người khác chia sẻ trong gọi nhóm (luồng đó hiện như một ô thành viên).
- Nhận chia sẻ màn hình *từ* điện thoại chưa kiểm chứng (Zalo trên điện thoại không có nút này).
- Chưa thử gọi điện trên aarch64 (engine không có phần nào chỉ chạy được trên x86).

### Lịch sử

Dự án bắt đầu từ việc nghiên cứu giao thức gọi điện của Zalo để thay thế Wine. Phần ứng dụng ban đầu dựa trên [zalo-for-linux](https://github.com/VN-Linux-Family/zalo-for-linux). Ở phiên bản **1.0.0**, repo được dựng lại từ đầu thành dự án riêng: gộp lịch sử cũ thành một commit đầu tiên, bỏ toàn bộ Wine, ZaDark và các thành phần không thuộc dự án, phiên bản đánh lại từ 1.0.0.

### Ghi công và giấy phép

- Phần đóng gói, cửa sổ, khay hệ thống, các patch và thư viện native (`nativelibs/`) kế thừa từ [zalo-for-linux](https://github.com/VN-Linux-Family/zalo-for-linux) (doandat943 và cộng đồng VN Linux Family) và giải pháp gốc của [realdtn2](https://github.com/realdtn2/zalo-linux-2026).
- Engine gọi điện native, cửa sổ gọi và các thay đổi trong repo này: nct88.
- Giấy phép [MIT](LICENSE). Zalo là thương hiệu của VNG. Repo không chứa mã hay tệp nhị phân của Zalo: ứng dụng được tải từ nguồn chính thức lúc build.

---

## English

Zalo for Linux, packaged from the official Zalo macOS app into an AppImage, with a **native call engine** written for Linux. Voice calls, video calls and screen sharing run directly on Linux: no Wine, no Windows app, no 32-bit libraries.

> Unofficial project, not affiliated with VNG / Zalo.

### What is native

Zalo has no Linux version. Earlier Zalo-for-Linux builds ran calls through `ZaloCall.exe` (Windows) under Wine. Zalo Linux Native replaces all of it:

| Part | Before (Wine) | Zalo Linux Native |
|---|---|---|
| Call engine | `ZaloCall.exe` + a named-pipe bridge under Wine | Own Node.js + Python engine: Zalo's call-v2 protocol, ZRTP relay, P2P, SRTP, Opus, H.264 |
| Startup | Wine prefix, Wine download and checks | Zalo spawns the engine directly on its own Electron |
| Audio | Windows audio through Wine | PipeWire / PulseAudio directly, PipeWire's WebRTC processing (echo cancellation, noise suppression, gain control) |
| Camera | None | V4L2 through Chromium, H.264 encoded with WebCodecs |
| Screen sharing | Xvfb + `LD_PRELOAD` | The desktop's portal (PipeWire on Wayland), X11 |
| Call window | The Windows Qt window | The app's own window, in Zalo's style |

### What is optimized

- **Size:** no Wine prefix (~1.8 GB), no `ZaloCall.exe` and DLLs (~65 MB), no Wine-bundled "Full" build (~430 MB). The AppImage is about 170 MB.
- **Resources:** the call engine uses about 20 MB of RAM and almost no CPU when there is no call.
- **Audio:** Opus at 32 kbit/s, complexity 10, with FEC. The receiver rebuilds lost packets from FEC instead of guessing them. The microphone goes through WebRTC processing.
- **Video:** camera at up to 640 px (H.264 level 3.0, which any phone decodes), screen at up to 1280 px. A key frame goes out at the start and whenever the phone asks (PLI/FIR), so the picture shows almost at once.
- **Start / quit:** quitting during a call ends it on the other side at once. No Wine cleanup (about 3 s) on quit.
- **Distributions:** system packages are checked; anything missing comes with the right install command for Debian/Ubuntu, Fedora, Arch or openSUSE. The app detects whether there is a system tray.

### Call features

| Feature | Status |
|---|---|
| 1-1 voice calls: call, answer, decline, hang up | ✅ |
| 1-1 video calls: camera both ways | ✅ |
| Screen sharing (sending) | ✅ |
| Pick microphone / speaker / camera during a call, remembered | ✅ |
| The other side's camera / mic state | ✅ |
| Echo cancellation, noise suppression, gain control | ✅ (needs PipeWire) |
| Call window laid out as Zalo for macOS: its own icons, sounds and fonts (from the DMG at build time) | ✅ |
| Incoming call notice in the screen's corner, "answer without camera" | ✅ |
| Minimize / compact the call window; compact while sharing | ✅ |
| Video and group calls: resize, maximize, full screen (the bar's button, F11, double click; Esc leaves it) | ✅ |
| Switching a voice call to video during the call | ❌ Zalo PC (macOS, Windows) cannot either; phone to phone only |
| P2P on the same network, relay otherwise | ✅ |
| Group calls: audio, camera, screen sharing (sending), the members' cameras | ✅ (tried with a phone and Zalo for macOS) |

### Install

1. Download `Zalo-Linux-Native-<version>-x86_64.AppImage` (or `aarch64`) from [Releases](https://github.com/nct88/zalo-linux-native/releases). Not the `.zsync` file: that one is only for updates.
2. [Gear Lever](https://flathub.org/apps/it.mijorus.gearlever) is recommended: Open → the AppImage → Unlock → Move to the app menu. It tells you when a new version is out.

Calls also need `python3`, libopus and the PulseAudio tools. If something is missing, the first call shows the install command:

| Distribution | Command |
|---|---|
| Debian / Ubuntu / Mint | `sudo apt install python3 libopus0 pulseaudio-utils` |
| Fedora | `sudo dnf install python3 opus pulseaudio-utils` |
| Arch / Manjaro | `sudo pacman -S python opus libpulse` |
| openSUSE | `sudo zypper install python3 libopus0 pulseaudio-utils` |

### Options

| Environment variable | Effect |
|---|---|
| `ZALO_TRAY=1` / `0` | Force the system tray on / off (for XEmbed trays such as i3bar or lxpanel) |
| `ZALO_DISABLE_GPU=1` | No GPU acceleration, when the window is black or the GPU process crashes |
| `ZCALL_MIC` / `ZCALL_SPEAKER` | Microphone / speaker (PulseAudio source / sink name). The ▾ in the call window does the same |
| `ZCALL_AUDIO_PROCESSING=0` | Calls without echo cancellation / noise suppression |
| `ZCALL_PW_RT=0` | Do not ask RTKit for realtime priority when PipeWire's audio threads run at normal priority (asked by default: without it calls crackle on a busy PC) |
| `ZCALL_AUDIO_DIAG=0` | No `diag:` line (audio, PipeWire xruns and resyncs) in the log every 10 seconds |
| `ZCALL_MIC_AGC=0` | Do not turn the microphone down when it clips (3 dB steps, at most 24 dB by default, as Zalo on Windows / macOS) |
| `ZCALL_AUDIO_DUMP=1` | Record what the call played and what the microphone sent to `~/.config/ZaloData/call-*.raw` (for bug hunting; delete them afterwards) |
| `ZCALL_VERBOSE=1` | Log call details to `~/.config/ZaloData/native-engine-*.log` |
| `ZCALL_GROUP=0` | No group calls (the call window says they are not supported) |
| `ZCALL_GROUP_CAMERA=0` | Group calls without sending the camera |
| `ZCALL_GROUP_CAM_LAYER=0` / `1` / `2` | Camera size in group calls: 480×240, 720×360 (default), 960×480 |
| `ZCALL_SHARE_RES=720` | Shorter side of the shared screen in group calls (720 by default) |

### Build from source

```bash
git clone https://github.com/nct88/zalo-linux-native.git
cd zalo-linux-native
npm ci
npm run main          # download Zalo for macOS, extract, patch, package the AppImage into dist/
npm start             # or run from source (after npm run main:setup)
```

Needs Node.js 20 or later, Rust, `build-essential`, `liblzma-dev`, `p7zip-full`. Details in [DEVELOPMENT.md](DEVELOPMENT.md), how it works in [ARCHITECTURE.md](ARCHITECTURE.md), the call engine in [zcall-native/README.md](zcall-native/README.md).

### Current limits

- Group calls send one camera layer (Zalo for macOS sends two); viewing someone else's screen share in a group call is untested (it shows as a member tile).
- Receiving a screen share *from* a phone is untested (Zalo's phone app has no such button).
- Calls are untested on aarch64 (the engine has no x86-only parts).

### History

The project started as research into Zalo's call protocol to replace Wine. The app side was originally based on [zalo-for-linux](https://github.com/VN-Linux-Family/zalo-for-linux). With version **1.0.0** the repository was rebuilt from scratch as a project of its own: the earlier history squashed into one first commit, Wine, ZaDark and everything else that is not part of this project removed, and versions restarted at 1.0.0.

### Credits and license

- Packaging, window, tray, patches and native libraries (`nativelibs/`) come from [zalo-for-linux](https://github.com/VN-Linux-Family/zalo-for-linux) (doandat943 and the VN Linux Family community) and the original solution by [realdtn2](https://github.com/realdtn2/zalo-linux-2026).
- The native call engine, the call window and the changes in this repository: nct88.
- [MIT](LICENSE) license. Zalo is a trademark of VNG. This repository holds no Zalo code or binaries: the app is downloaded from the official source at build time.
