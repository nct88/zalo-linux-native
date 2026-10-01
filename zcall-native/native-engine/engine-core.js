'use strict';
// Control-plane of a native Linux call engine.
//
// Reproduces what ZaloCall does at the IPC boundary with Zalo's Electron main
// process (call-v2): it consumes the zalo->engine frames and produces the
// engine->zalo frames, with the field layout the real engine uses (captures
// 2026-09-29, see docs/REPORT.md). The MediaBackend (backends/zrtc-media.js)
// carries the audio.
//
// Outgoing call, as the real engine does it:
//   makeCall        -> callState incall, show, sendSignal 401 {callId (ours), calleeId, codec "[]\n", type}
//   recvSignal 401  -> media.prepare(): InitZRTP to every server
//                   -> sendSignal 416 {codec, extendData, rtcpAddress, rtpAddress, session}
//   control answer  -> media.start(params.rtpSerIp), sendSignal 408
//   hang up         -> sendSignal 409 (connected) or 405 (not answered),
//                      bubble, sendSignal 406 (stats), callState free
// Incoming call (capture 2026-09-30):
//   control request -> callState incall, getAliasName, sendSignal 407 {callId, callerId}
//   answer          -> action 5, sendSignal 402 {status 0, extendData, caller's server, session},
//                      InitZRTP cmd 12 to that one server, media
//   reject          -> action 8, sendSignal 402 {status 3, empty}, bubble, 406 status 160
//   control end_call (peer hung up) -> showNotification partner_endcall, bubble, 406
// 406 status: 50 connected call, 103 caller cancelled, 160 callee rejected.
// Hanging up is the engine's job: the real engine's call window (Qt) owns the
// end button, so every 409/405 in the captures comes from the engine. Here
// the `ui` object (call-window.js) plays that role.

const { VideoAssembler, avcCodecString } = require('./video');

const CODEC = '[{"dynamicFptime":0,"frmPtime":20,"name":"opus/16000/1","payload":112}]\n';

// JsonCpp writes keys sorted and ends with a newline; mirror that.
function jsonCpp(v) {
  const sort = (x) => (Array.isArray(x) ? x.map(sort)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return JSON.stringify(sort(v)) + '\n';
}

// callId must fit a signed 32-bit int: the server answers requestcall,
// cancel and logendcall with error 114 ("invalid parameters") for callIds
// above 2^31 - 1 (live test 2026-09-30). The real engine's are ~1.83e9.
function newCallId() {
  return 1000000000 + Math.floor(Math.random() * (0x7fffffff - 1000000000));
}

function parseMaybeJson(s) {
  if (typeof s !== 'string') return s || {};
  try { return JSON.parse(s); } catch (_) { return {}; }
}

class MediaBackend {
  onNegotiated(_params) {}
  prepare(_role) { return Promise.resolve(null); }
  start(_role, _rtpSerIp) {}
  stop() {}
  setMute(_on) {}
  stats() { return null; }
  on() { return this; }
}

const noUi = { open() {}, status() {}, close() {}, onHangup() {}, incoming() {} };

class EngineCore {
  // emit(frame) sends one engine->zalo frame: { type, command, data }.
  constructor({ emit, media = new MediaBackend(), log = () => {}, ui = noUi }) {
    this.emit = emit;
    this.media = media;
    this.log = log;
    this.ui = ui;
    this.call = null;
    this.local = {};
    this.ui.onHangup(() => this.hangup('local'));
    if (typeof this.ui.onMute === 'function') {
      this.ui.onMute((on) => { this.media.setMute(on); this._micState(!on); });
    }
    // Device picked in the call window (or the saved choice, sent when the window connects).
    if (typeof this.ui.onDevice === 'function') {
      this.ui.onDevice((kind, name) => { if (this.media.setDevice) this.media.setDevice(kind, name); });
    }
    if (typeof this.ui.onSpeaker === 'function') this.ui.onSpeaker((on) => this.media.setSpeaker && this.media.setSpeaker(on));
    // Our camera, encoded by the call window (H.264 Annex-B frames).
    if (typeof this.ui.onVideoFrame === 'function') {
      this.ui.onVideoFrame((f) => { if (this.call && this.call.state === 'connected' && this.media.sendVideoFrame) this.media.sendVideoFrame(f); });
    }
    if (typeof this.ui.onCamera === 'function') this.ui.onCamera((on) => this._camMic(on));
    if (typeof this.ui.onScreen === 'function') this.ui.onScreen((on) => this._screenShare(on));
    if (typeof media.on === 'function') {
      media.on('timeout', () => this.hangup('media-timeout'));
      media.on('failed', (why) => this.hangup(`media-${why}`));
      media.on('peerEnd', () => this._peerEnded('server'));
      media.on('video', (pkt) => this._onVideoPacket(pkt));
      media.on('keyframe', (why) => this._requestKeyFrame(why));
    }
  }

  start() {
    this.emit({ type: 'update', command: 'native-ready', data: {} });
  }

  onZaloFrame(f) {
    if (!f || typeof f !== 'object') return;
    const data = f.data && typeof f.data === 'object' ? f.data : {};
    switch (f.type) {
      case 'update': return this._onUpdate(f.command, data);
      case 'request': return this._onRequest(f.command, data);
      case 'control': return this._onControl(data.act, data);
      case 'recvSignal': return this._onRecvSignal(f.command, data);
      case 'response': return; // answers to our requests (getAliasName, ...): nothing to do
      default: this.log('unhandled type', f.type, f.command);
    }
  }

  _onUpdate(command, data) {
    // init / updateLocal / updateLang / advancedOptions: local config, no reply.
    if ((command === 'init' || command === 'updateLocal') && data.local) this.local = { ...this.local, ...data.local };
  }

  _onRequest(command, data) {
    switch (command) {
      case 'makeCall': return this._makeCall(data);
      case 'endCall': return this.hangup('zalo');
      case 'listDevice':
        this.emit({ type: 'response', command: 'listDevice', data: { audioIn: [], audioOut: [], video: [] } });
        return;
      case 'ping':
      case 'hide':
        return;
      default:
        this.log('unhandled request', command);
    }
  }

  _makeCall(data) {
    if (this.call) { this.log('makeCall while in a call; ignored'); return; }
    // type 1 voice, 3 video; 5 / 6 the same for a group (with groupInfo).
    if (data.type === 5 || data.type === 6 || data.groupInfo) {
      const g = data.groupInfo || {};
      this.emit({ type: 'response', command: 'show', data: { error: 0, extendData: 'success' } });
      this.emit({ type: 'update', command: 'callState', data: { state: 'free' } });
      this._groupNotSupported(g.name || g.groupName || 'Gọi nhóm', g.avatar || '');
      return;
    }
    const partner = (data.partner && data.partner[0]) || {};
    this.call = {
      role: 'caller',
      peerId: String(partner.id || ''),
      peerName: partner.name || '',
      avatar: partner.avatar || '',
      type: data.type,
      callId: newCallId(),
      state: 'calling',
      startedAt: 0,
    };
    const c = this.call;
    this.emit({ type: 'update', command: 'callState', data: { state: 'incall' } });
    this.emit({ type: 'response', command: 'show', data: { error: 0, extendData: 'success' } });
    this.emit({ type: 'sendSignal', command: 401, data: { callId: c.callId, calleeId: c.peerId, codec: '[]\n', type: c.type } });
    if (c.type === 3) this._camMic();
    this.ui.open({ title: c.peerName || 'Zalo', text: 'Đang gọi…', avatar: c.avatar, video: c.type === 3 });
  }

  // Our screen replaces the camera in the video stream; the phone is told
  // with 12064 (/api/voicecall/requestsharescreen {uidTo, callId, status}).
  _screenShare(on) {
    const c = this.call;
    if (!c || c.state !== 'connected') return;
    this.log('screen share', on ? 'on' : 'off');
    this.emit({ type: 'sendSignal', command: 12064, data: { callId: c.callId, status: on ? 1 : 0, uidTo: c.peerId } });
  }

  // Group calls are not implemented (separate SFU signalling and media).
  // Ours: say so in the call window for a few seconds instead of calling anyone.
  _groupNotSupported(title, avatar) {
    const text = 'Gọi nhóm chưa được hỗ trợ trên Linux';
    this.log('group call: not supported');
    this.ui.open({ title, text, avatar });
    setTimeout(() => { if (!this.call) this.ui.close(text); }, 3000).unref();
  }

  // Someone else's (control group_request): show it like an incoming call,
  // with only a dismiss button, for up to 45 s. A 1-1 call takes over.
  _incomingGroup(d) {
    this.log('incoming group call', d.id, '(not supported)');
    if (this.call) return;
    const notice = this.groupNotice = {};
    const dismiss = () => {
      if (this.groupNotice !== notice) return;
      this.groupNotice = null;
      if (!this.call) this.ui.close('Đã bỏ qua cuộc gọi nhóm');
    };
    this.ui.incoming({
      title: d.groupName || 'Cuộc gọi nhóm',
      text: `${d.Dname || 'Ai đó'} đang gọi nhóm. Gọi nhóm chưa được hỗ trợ trên Linux.`,
      avatar: d.groupAvatar || d.avatar || '',
      noAnswer: true,
    }, dismiss, dismiss);
    setTimeout(dismiss, 45000).unref();
  }

  // Camera / mic state (12006 -> /api/voicecall/conf, the phone gets it as
  // onoff_camera / mute_audio); -1 leaves a field unchanged. Without a camera
  // the real engine sends isOnCam 0, isOnMic -1; the call window reports ours
  // when it starts.
  _camMic(camOn) {
    const c = this.call;
    if (!c) return;
    const cam = camOn === undefined ? 0 : camOn ? 1 : 0;
    this.emit({ type: 'sendSignal', command: 12006, data: { callId: c.callId, calleeId: c.peerId, data: '', isOnCam: cam, isOnMic: -1 } });
  }

  // Despite its name, isOnMic is a mute flag for the phone: 1 shows our mic
  // as off, 0 clears it (live test 2026-10-01).
  _micState(micOn) {
    const c = this.call;
    if (!c || c.state !== 'connected') return;
    this.emit({ type: 'sendSignal', command: 12006, data: { callId: c.callId, calleeId: c.peerId, data: '', isOnCam: -1, isOnMic: micOn ? 0 : 1 } });
  }

  _onControl(act, data) {
    const c = this.call;
    const d = data.data || {};
    if (typeof act === 'string' && act.startsWith('group_')) {
      if (act === 'group_request') this._incomingGroup(d);
      return;
    }
    switch (act) {
      case 'request': // incoming 1-1 call
        return this._incoming(d);
      case 'ring_ring':
        if (c && c.state === 'calling') { c.state = 'ringing'; this.ui.status('Đang đổ chuông…'); }
        return;
      case 'answer': {
        if (!c || c.role !== 'caller' || c.state === 'connected') return;
        const params = parseMaybeJson(d.params);
        // A declining phone also sends "answer", with status 3 and no
        // extendData (the same status our 402 uses to decline): no media.
        const status = Number(d.status || params.status || 0);
        if (status !== 0) {
          this.log('peer declined, answer status', status);
          this._finish(103, status === 3 ? 'Người nhận đã từ chối' : 'Không liên lạc được');
          return;
        }
        c.state = 'connected';
        c.startedAt = Date.now();
        this.media.start(c.role, params.rtpSerIp);
        this.emit({ type: 'sendSignal', command: 408, data: { callId: c.callId, calleeId: c.peerId } });
        if (c.type === 3) this._camMic();
        this.ui.status('Đã kết nối', c.startedAt);
        return;
      }
      case 'end_call':
      case 'cancel':
      case 'reject':
      case 'busy':
        if (c && d.callId && String(d.callId) !== String(c.callId)) return; // another call
        this._peerEnded(act);
        return;
      case 'answer_ack':
        return;
      // The peer's camera / mic (params.type; capture 2026-10-01):
      // onoff_camera 1 on, 0 off; mute_audio 1 muted, 0 not.
      // share_screen: assumed the same way (1 sharing, 0 not; not captured yet).
      case 'onoff_camera':
      case 'mute_audio':
      case 'share_screen': {
        if (!c || (d.callId && String(d.callId) !== String(c.callId))) return;
        const p = parseMaybeJson(d.params);
        const type = Number(p.type !== undefined ? p.type : p.status);
        if (act === 'onoff_camera') c.peerCamOff = type === 0;
        else if (act === 'mute_audio') c.peerMuted = type === 1;
        else { c.peerSharing = type === 1; this.log('peer share_screen', JSON.stringify(p)); }
        if (typeof this.ui.peer === 'function') this.ui.peer({ camOff: !!c.peerCamOff, muted: !!c.peerMuted, sharing: !!c.peerSharing });
        return;
      }
      default:
        this.log('unhandled control', act);
    }
  }

  _incoming(d) {
    if (this.call) { this.log('incoming call while in a call; ignored'); return; }
    this.groupNotice = null; // a group call notice gives way
    const params = parseMaybeJson(d.params);
    const ext = parseMaybeJson(params.extendData);
    const addr = (ext.serverAddr && ext.serverAddr[0]) || {};
    this.call = {
      role: 'callee',
      peerId: String(d.uidN || ''),       // caller's Zalo id (18-19 digits)
      peerUid: Number(d.uidFrom) || 0,    // caller's media UID (9 digits)
      localUid: Number(d.uidTo) || 0,
      peerName: params.Dname || '',
      avatar: params.avatar || '',
      type: ext.callType === 1 ? 3 : 1,
      callId: Number(d.callId),
      sessId: d.session || params.sessId,
      // The callee uses the caller's server (d.rtpAddress == extendData.serverAddr[0].rtp).
      server: { rtpaddr: d.rtpAddress, rtcpaddr: d.rtcpAddress, rtpIPv6: addr.rtpIPv6 || '', rtcpIPv6: addr.rtcpIPv6 || '' },
      config: params.zrtc_config || {},
      p2p: Array.isArray(ext.p2p) ? ext.p2p : [], // the caller's P2P candidates
      state: 'incoming',
      startedAt: 0,
    };
    const c = this.call;
    this.emit({ type: 'update', command: 'callState', data: { state: 'incall' } });
    this.emit({ type: 'request', command: 'getAliasName', data: { noisedId: c.peerId } });
    this.emit({ type: 'sendSignal', command: 407, data: { callId: c.callId, callerId: c.peerId } });
    const kind = c.type === 3 ? 'Cuộc gọi video đến (chỉ có tiếng)' : 'Cuộc gọi thoại đến';
    this.ui.incoming({ title: c.peerName || 'Zalo', text: kind, avatar: c.avatar, video: c.type === 3 },
      () => this.answer(), (why) => this.reject(why));
  }

  // Callee picks up: InitZRTP to the caller's server first, so that 402 can
  // carry our P2P candidates (the phone ignores our P2P binding without them).
  answer() {
    const c = this.call;
    if (!c || c.role !== 'callee' || c.state !== 'incoming') return;
    c.state = 'connected';
    c.startedAt = Date.now();
    this.emit({ type: 'request', command: 'action', data: { id: 5 } });
    this.media.onNegotiated({
      servers: [c.server],
      config: c.config,
      srtpMode: c.config.srtpMode,
      sessId: c.sessId,
      callId: c.callId,
      role: c.role,
      localUid: c.localUid,
      peerUid: c.peerUid,
      p2pCandidates: c.p2p,
    });
    this.ui.status('Đang kết nối…');
    this.media.prepare('callee').then((best) => {
      if (this.call !== c || c.state === 'ended') return;
      const p2p = typeof this.media.localCandidates === 'function' ? this.media.localCandidates(best && best.publicAddr) : [];
      this.emit({
        type: 'sendSignal',
        command: 402,
        data: {
          callId: c.callId,
          callerId: c.peerId,
          codec: CODEC,
          extendData: jsonCpp(this._extendData(c, c.server, null, { numServers: 0, p2p, sP2P: 1, select2side: 1, supportCallBusy: 0 })),
          rtcpAddress: c.server.rtcpaddr,
          rtpAddress: c.server.rtpaddr,
          session: c.sessId,
          status: 0,
        },
      });
      if (!best && this.media.sendUdp) { this.ui.status('Không kết nối được máy chủ'); this.hangup('no-server'); return; }
      this.media.start('callee', c.server.rtpaddr);
      this.ui.status('Đã kết nối', c.startedAt);
    });
  }

  // Callee declines (button, or no answer before the window times out).
  reject(why = 'reject') {
    const c = this.call;
    if (!c || c.role !== 'callee' || c.state !== 'incoming') return;
    this.log('reject:', why);
    this.emit({ type: 'request', command: 'action', data: { id: 8 } });
    this.emit({
      type: 'sendSignal',
      command: 402,
      data: { callId: c.callId, callerId: c.peerId, codec: '[]\n', extendData: '{}\n', rtcpAddress: '', rtpAddress: '', session: c.sessId, status: 3 },
    });
    this._finish(160);
  }

  // The phone needs a key frame (start of our video, PLI / FIR): ask the
  // call window's encoder, at most every 500 ms.
  _requestKeyFrame(why) {
    const c = this.call;
    if (!c || c.state !== 'connected' || typeof this.ui.requestKeyFrame !== 'function') return;
    const now = Date.now();
    if (c.keyAskedAt && now - c.keyAskedAt < 500) return;
    c.keyAskedAt = now;
    if (why !== 'start') this.log('key frame requested:', why);
    this.ui.requestKeyFrame();
  }

  // Received video packets -> frames -> call window (decoded there with WebCodecs).
  _onVideoPacket(pkt) {
    const c = this.call;
    if (!c || c.state !== 'connected' || typeof this.ui.video !== 'function') return;
    if (!c.video) {
      c.video = new VideoAssembler((f) => {
        if (f.key) c.videoCodec = avcCodecString(f.data) || c.videoCodec;
        this.ui.video({ key: f.key, codec: c.videoCodec || 'avc1.64001e', data: f.data });
      });
    }
    c.video.push(pkt);
  }

  // The other side hung up, cancelled or declined.
  _peerEnded(why) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    this.log('peer ended:', why);
    if (c.state === 'connected') {
      this.emit({ type: 'request', command: 'showNotification', data: { isGroup: false, reason: 'partner_endcall', toUid: c.peerId, userId: c.peerId } });
    }
    this._finish(c.state === 'connected' ? 50 : 103);
  }

  _onRecvSignal(command, data) {
    const c = this.call;
    switch (String(command)) {
      case '401': // server's answer: media servers + zrtc_config + sessId
        if (!c || c.state !== 'calling') return;
        if (data.status || !Array.isArray(data.servers) || !data.servers.length) {
          this.log('recvSignal 401 without servers', data.status, data.msg);
          this.ui.status('Không gọi được');
          this._finish(103);
          return;
        }
        c.sessId = data.sessId;
        c.localUid = Number(data.fromId) || Number(this.local.id) || 0;
        this.media.onNegotiated({
          servers: data.servers,
          config: data.zrtc_config || {},
          srtpMode: data.zrtc_config && data.zrtc_config.srtpMode,
          sessId: data.sessId,
          callId: c.callId,
          role: c.role,
          localUid: c.localUid,
          // Media UIDs are the 9-digit numbers of 401 (fromId/toId), not the
          // 18-19 digit Zalo ids of makeCall.
          peerUid: Number(data.toId) || 0,
        });
        this.media.prepare(c.role).then((best) => {
          if (this.call !== c || c.state === 'ended') return;
          const chosen = best ? best.server.raw : data.servers[0];
          if (!best && this.media.sendUdp) { this.ui.status('Không kết nối được máy chủ'); this.hangup('no-server'); return; }
          this._send416(c, chosen, best && best.publicAddr);
        });
        return;
      case '409': // ack of our 409/405 (the call is already finished then)
      case '405':
        if (c && c.state !== 'ended') this._peerEnded(`recvSignal ${command}`);
        return;
      case '402':
      case '407':
      case '416':
      case '408':
      case '406':
      case '12006':
      case '12064':
        return; // acks of what we sent
      default:
        this.log('recvSignal', command);
    }
  }

  // extendData of 416 (caller) and 402 (callee), keys as the real engine sends them.
  _extendData(c, server, publicAddr, extra = {}) {
    const p2p = [];
    if (publicAddr && publicAddr.includes('|')) {
      const [ip, port] = publicAddr.split('|');
      p2p.push({ ip, port: Number(port), type: 1 });
    }
    return {
      callType: c.type === 3 ? 1 : 0,
      fecTP: 0,
      gccAudio: 1,
      gccEarlyCall: 0,
      gccMode: 1,
      gccSVLR: 1,
      maxFT: 60,
      newZrtc: 1,
      p2p,
      packetMode: 2,
      platform: 2,
      sP2P: 0, // relay only: no P2P in the native engine yet
      serverAddr: [{ rtcp: server.rtcpaddr, rtcpIPv6: server.rtcpIPv6, rtp: server.rtpaddr, rtpIPv6: server.rtpIPv6, tpType: 0 }],
      spTcp: 1,
      srtcp: 0,
      srtpMode: 1,
      supportCallBusy: 1,
      supportHevcDecode: 0,
      tpType: 0,
      video: { codec: [{ name: 'h264', payload: 97 }] },
      ...extra,
    };
  }

  _send416(c, server, publicAddr) {
    this.emit({
      type: 'sendSignal',
      command: 416,
      data: {
        callId: c.callId,
        calleeId: c.peerId,
        codec: CODEC,
        extendData: jsonCpp(this._extendData(c, server, publicAddr)),
        rtcpAddress: server.rtcpaddr,
        rtpAddress: server.rtpaddr,
        session: c.sessId,
      },
    });
  }

  // Local hang up (call window, Zalo, media loss): tell the peer, then finish.
  hangup(why) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    this.log('hangup:', why);
    if (c.state === 'incoming') { this.reject(why); return; }
    if (c.state === 'connected') {
      this.emit({ type: 'sendSignal', command: 409, data: { callId: c.callId, toId: c.peerId } });
    } else {
      this.emit({ type: 'sendSignal', command: 405, data: { callId: c.callId, callType: c.type === 3 ? 1 : 0, status: 0, toId: c.peerId } });
    }
    this._finish(c.state === 'connected' ? 50 : 103);
  }

  _finish(status, closeText) {
    const c = this.call;
    if (!c || c.state === 'ended') return;
    const connected = c.state === 'connected';
    c.state = 'ended';
    const stats = (c.sessId && this.media.stats()) || {}; // no media before recvSignal 401
    this.media.stop();
    const duration = connected ? Math.round((Date.now() - c.startedAt) / 1000) : 0;
    const role = c.role === 'caller';
    this.emit({ type: 'update', command: 'bubble', data: { duration, partnerId: c.peerId, role } });
    this.emit({
      type: 'sendSignal',
      command: 406,
      data: {
        callId: c.callId,
        data: JSON.stringify({
          Codec: ['opus/16000/1', '20'],
          NewZRTC: 1,
          RxTotalPkt: stats.rx || 0,
          SrtpMode: 1,
          TxTotalPkt: stats.tx || 0,
          sysInfo: 'native-engine',
        }),
        duration,
        partnerId: c.peerId,
        role,
        status,
      },
    });
    this.emit({ type: 'update', command: 'callState', data: { state: 'free' } });
    this.ui.close(closeText || (connected ? `Kết thúc — ${duration} s` : 'Đã kết thúc'));
    this.call = null;
  }
}

module.exports = { EngineCore, MediaBackend, jsonCpp, newCallId };
