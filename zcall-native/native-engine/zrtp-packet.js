'use strict';

/**
 * ZRTPPacket wire format, taken from ARM64
 * zrtc::ZRTPPacket::_buildPacketInternal / initZRTPPacket* on macOS ZaloCall,
 * and checked byte for byte against packets the real engine sent
 * (native-engine/wire-check.js).
 *
 *  - Media (MsgType 3/5/7/13/15): 1 byte type + uint32 LE server token + payload.
 *  - Control (MsgType 1, client -> server) and reply (MsgType 2, server -> client):
 *      0 type | 1 magic | 2 u32 0 | 6 u32 seq | 10 u32 local UID | 14 u32 server token
 *      18 u16 cmd | 20 u8 subCmd | 21.. payload
 *  - InitZRTP cmd 11 (caller) / 12 (callee): payload u32 callId, u32 peer UID,
 *    u16str sessId (+ u16str extra when non-empty). Token is 0: the
 *    server hands it out in its MsgType 2 reply.
 *  - Ping cmd 2: payload u16str sessId. EndCall cmd 3: payload u32 callId.
 */

const MSG_TYPES = {
  CONTROL: 0x01,
  SERVER_REPLY: 0x02,   // server -> client answer to a control request (InitZRTP, cmd 32)
  AUDIO_RTP: 0x03,       // client → server, 5-byte hdr + RTP PT 112 (wire 2026-09-29)
  AUDIO_RTP_DOWN: 0x04,  // server → client (observed; not in macOS 0xa0a8 bitmask)
  AUDIO_FEC: 0x05,
  AUDIO_RTCP: 0x07,
  VIDEO_RTP: 0x0d,
  VIDEO_DOWN: 0x0e,      // server → client (observed)
  VIDEO_FEC: 0x0f,
  P2P_EXT: 0x7f,
};

const COMMANDS = {
  PING: 2,
  END_CALL: 3,
  INIT_CALL_CALLER: 11,
  INIT_CALL_CALLEE: 12,
  ECHO: 5,          // server RTT probe before InitZRTP (payload: decimal seq)
  CHANGE_ADDRESS: 14,
  REQ_FORWARD: 32,  // relayed to the peer via the server; sub 10 ~1/s ping/pong, sub 8 once
  INIT_ZAVI_PING: 0x33,
};

const MAGIC_BYTE = 0x7e;
const CONTROL_HEADER_LEN = 21;
const MEDIA_HEADER_LEN = 5;

function isMediaType(t) {
  return t === 0x03 || t === 0x04 || t === 0x05 || t === 0x07 || t === 0x0d || t === 0x0e || t === 0x0f;
}

function wrapMediaPacket({ msgType = MSG_TYPES.AUDIO_RTP, token = 0, payload }) {
  if (!Buffer.isBuffer(payload)) throw new TypeError('payload must be a Buffer');
  const buf = Buffer.allocUnsafe(MEDIA_HEADER_LEN + payload.length);
  buf[0] = msgType;
  buf.writeUInt32LE(token >>> 0, 1);
  payload.copy(buf, 5);
  return buf;
}

function buildControlHeader({
  msgType = MSG_TYPES.CONTROL,
  magic = MAGIC_BYTE,
  field02 = 0,
  seq = 0,
  uid = 0,
  token = 0,
  cmd,
  subCmd = 0,
}) {
  if (cmd == null) throw new TypeError('cmd is required');
  const buf = Buffer.alloc(CONTROL_HEADER_LEN);
  buf[0] = msgType;
  buf[1] = magic;
  buf.writeUInt32LE(field02 >>> 0, 2);
  buf.writeUInt32LE(seq >>> 0, 6);
  buf.writeUInt32LE(uid >>> 0, 10);
  buf.writeUInt32LE(token >>> 0, 14);
  buf.writeUInt16LE(cmd >>> 0, 18);
  buf[20] = subCmd & 0xff;
  return buf;
}

function u16String(s) {
  const data = Buffer.isBuffer(s) ? s : Buffer.from(String(s || ''), 'utf8');
  const out = Buffer.allocUnsafe(2 + data.length);
  out.writeUInt16LE(data.length, 0);
  data.copy(out, 2);
  return out;
}

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * RequestInitZRTP (cmd 11 caller / 12 callee), sent to every candidate server.
 * initZRTPPacketRequestInitCall(isCaller, uid, peer, callId, sessId, subCmd,
 * extra, flag): subCmd |= 4 when flag is set. An empty extra is not written
 * (caller 185 B with a 154-byte sessId, callee 183 B with a 152-byte session).
 * subCmd is 2 for both roles on the wire. The callee sends it to the one
 * server the caller chose, right after answering.
 */
function buildInitZrtpPacket({
  role = 'caller',
  uid = 0,
  peerUid = 0,
  callId = 0,
  sessId = '',
  extra = '',
  subCmd = 0x02,
}) {
  const caller = role === 'caller';
  const header = buildControlHeader({
    magic: MAGIC_BYTE,
    uid,
    cmd: caller ? COMMANDS.INIT_CALL_CALLER : COMMANDS.INIT_CALL_CALLEE,
    subCmd,
  });
  const parts = [header, u32(callId), u32(peerUid), u16String(sessId)];
  // Empty extra is not written for either role (callee packet: 183 B with a
  // 152-byte session, capture 2026-09-30).
  if (extra && extra.length) parts.push(u16String(extra));
  return Buffer.concat(parts);
}

function buildPingPacket({ uid = 0, token = 0, sessId = '' }) {
  // initZRTPPacketRequestPing overwrites the magic with 1.
  const header = buildControlHeader({ magic: 0x01, uid, token, cmd: COMMANDS.PING, subCmd: 0x01 });
  return Buffer.concat([header, u16String(sessId)]);
}

// Sent to the chosen server on hangup, and to every other server that
// answered InitZRTP once the best one is picked (~2 s after InitZRTP).
function buildEndCallPacket({ uid = 0, token = 0, callId = 0 }) {
  const header = buildControlHeader({ magic: MAGIC_BYTE, uid, token, cmd: COMMANDS.END_CALL, subCmd: 0 });
  return Buffer.concat([header, u32(callId)]);
}

// ReqForward (cmd 32): relayed by the server to the peer, acked with MsgType 2.
// Each side sends sub 10 once a second with its own seq; payload is six u32:
// [20, a, 1, 1, audio packets received in the last second, b]. a and b are 0
// in 96/133 captured packets (else a ~24, b 2-7: meaning not known yet).
// Sub 8 with payload [4, 0] is sent once, ~0.2 s after media starts.
function buildReqForwardPacket({ uid = 0, token = 0, seq = 0, subCmd, payload = Buffer.alloc(0) }) {
  const header = buildControlHeader({ magic: 0x01, seq, uid, token, cmd: COMMANDS.REQ_FORWARD, subCmd });
  return Buffer.concat([header, payload]);
}

function reqForwardStatus(rxPerSecond, a = 0, b5 = 0) {
  const b = Buffer.alloc(24);
  [20, a, 1, 1, rxPerSecond, b5].forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
  return b;
}

// P2P (MsgType 0x7f), sent straight between the two clients (capture of the
// real engine answering a call, 2026-09-30). 9-byte header:
//   7f | 00 | role (0 caller, 1 callee) | u32 LE callId | kind | 00
// kind 1  binding to each remote candidate: u16 LE seq, u32 BE candidate index
// kind 2  binding from the peer: seq, index, u32 LE len + "ip|port" we were
//         reached at, then ff
// kind 3  answer to kind 2: same seq and index, u32 LE len + "ip|port" of the
//         peer as we see it (no ff)
// kind 4  keepalive: byte 9 = 1 ping / 2 pong; the pong is the ping with our
//         role and byte 9 = 2
// kind 6  audio (SRTP, same keys and sequence as relay), 7 audio RTCP, 8/9 video
const P2P = { HEADER_LEN: 9, BIND: 1, BIND_PEER: 2, BIND_ANSWER: 3, KEEPALIVE: 4, AUDIO: 6, AUDIO_RTCP: 7, VIDEO: 8, VIDEO_RTCP: 9 };

function p2pHeader(role, callId, kind) {
  const h = Buffer.alloc(P2P.HEADER_LEN);
  h[0] = MSG_TYPES.P2P_EXT;
  h[2] = role === 'callee' ? 1 : 0;
  h.writeUInt32LE(callId >>> 0, 3);
  h[7] = kind;
  return h;
}

function buildP2pBind({ role, callId, seq = 0, index }) {
  const b = Buffer.alloc(6);
  b.writeUInt16LE(seq & 0xffff, 0);
  b.writeUInt32BE(index >>> 0, 2);
  return Buffer.concat([p2pHeader(role, callId, P2P.BIND), b]);
}

// Answer a kind 2 from the peer, seen coming from peerAddr ("ip|port").
function buildP2pBindAnswer({ role, callId, request, peerAddr }) {
  const addr = Buffer.from(peerAddr, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(addr.length, 0);
  return Buffer.concat([p2pHeader(role, callId, P2P.BIND_ANSWER), request.subarray(9, 15), len, addr]);
}

function buildP2pPong({ role, ping }) {
  const pong = Buffer.from(ping);
  pong[2] = role === 'callee' ? 1 : 0;
  pong[9] = 2;
  return pong;
}

function wrapP2pAudio({ role, callId, rtp }) {
  return Buffer.concat([p2pHeader(role, callId, P2P.AUDIO), rtp]);
}

function wrapP2pVideo({ role, callId, rtp }) {
  return Buffer.concat([p2pHeader(role, callId, P2P.VIDEO), rtp]);
}

function unwrapPacket(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 1) return null;
  const msgType = buf[0];

  if (msgType === MSG_TYPES.AUDIO_RTP_DOWN || msgType === MSG_TYPES.VIDEO_DOWN) {
    // Server -> client media: 1-byte header, RTP right after (no token).
    return { isMedia: true, msgType, payload: buf.slice(1) };
  }
  if (isMediaType(msgType)) {
    if (buf.length < MEDIA_HEADER_LEN) return { isMedia: true, msgType, truncated: true, raw: buf };
    return {
      isMedia: true,
      msgType,
      token: buf.readUInt32LE(1),
      payload: buf.slice(5),
    };
  }

  if ((msgType === MSG_TYPES.CONTROL || msgType === MSG_TYPES.SERVER_REPLY) && buf.length >= CONTROL_HEADER_LEN) {
    const data = buf.slice(CONTROL_HEADER_LEN);
    const parsed = {
      isMedia: false,
      msgType,
      magic: buf[1],
      field02: buf.readUInt32LE(2),
      seq: buf.readUInt32LE(6),
      uid: buf.readUInt32LE(10),
      token: buf.readUInt32LE(14),
      cmd: buf.readUInt16LE(18),
      subCmd: buf[20],
      data,
    };
    const initCmd = parsed.cmd === COMMANDS.INIT_CALL_CALLER || parsed.cmd === COMMANDS.INIT_CALL_CALLEE;
    if (initCmd && msgType === MSG_TYPES.SERVER_REPLY && data.length >= 14) {
      // Server answer to InitZRTP: result, callId, the token for media
      // headers, and our address as the server sees it ("ip|port").
      parsed.res = data.readUInt32LE(0);
      parsed.callId = data.readUInt32LE(4);
      parsed.serverToken = data.readUInt32LE(8);
      const n = data.readUInt16LE(12);
      parsed.publicAddr = data.slice(14, 14 + n).toString('latin1');
    } else if (initCmd && data.length >= 10) {
      parsed.callId = data.readUInt32LE(0);
      parsed.peerUid = data.readUInt32LE(4);
      const n1 = data.readUInt16LE(8);
      parsed.sessId = data.slice(10, 10 + n1);
      const off = 10 + n1;
      if (data.length >= off + 2) parsed.extra = data.slice(off + 2, off + 2 + data.readUInt16LE(off));
    } else if (parsed.cmd === COMMANDS.PING && data.length >= 2) {
      parsed.sessId = data.slice(2, 2 + data.readUInt16LE(0));
    } else if (parsed.cmd === COMMANDS.END_CALL && data.length >= 4) {
      parsed.callId = data.readUInt32LE(0);
    }
    return parsed;
  }

  if (msgType === MSG_TYPES.P2P_EXT && buf.length >= 9) {
    return {
      isMedia: false,
      msgType,
      b1: buf[1],
      b2: buf[2],
      field38: buf.readUInt32LE(3),
      cmd: buf.readUInt16LE(7),
      data: buf.slice(9),
    };
  }

  return { isMedia: false, msgType, raw: buf };
}

module.exports = {
  MSG_TYPES,
  COMMANDS,
  MAGIC_BYTE,
  CONTROL_HEADER_LEN,
  MEDIA_HEADER_LEN,
  wrapMediaPacket,
  buildControlHeader,
  buildInitZrtpPacket,
  buildPingPacket,
  buildEndCallPacket,
  buildReqForwardPacket,
  reqForwardStatus,
  P2P,
  buildP2pBind,
  buildP2pBindAnswer,
  buildP2pPong,
  wrapP2pAudio,
  wrapP2pVideo,
  unwrapPacket,
};
