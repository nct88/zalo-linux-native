'use strict';
// RTP header of outgoing audio, as ZaloCall writes it (capture 2026-09-29,
// 6645 type-3 packets):
//   90 70 | seq | ts | ssrc | be de 00 01 | 51 <tw seq hi> <tw seq lo> 00
// V=2, X=1, PT 112 (opus/16000/1), timestamp +320 per 20 ms frame (16 kHz
// clock), SSRC = local UID, one-byte header extension (RFC 8285) id 5 len 2 =
// transport-wide sequence number (transport-cc), padded to 4 bytes.

const AUDIO_PT = 112;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz
const TWCC_EXT_ID = 5;

function buildAudioRtpHeader({ seq, ts, ssrc, twSeq, marker = false, pt = AUDIO_PT }) {
  const h = Buffer.alloc(20);
  h[0] = 0x90;
  h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  h.writeUInt16BE(0xbede, 12);
  h.writeUInt16BE(1, 14);
  h[16] = (TWCC_EXT_ID << 4) | 1;
  h.writeUInt16BE(twSeq & 0xffff, 17);
  h[19] = 0;
  return h;
}

// Group video adds the SFU one-byte extension after transport-cc. BuildRTPHeaderExtension
// walks types in order, so id 5 comes first and the SFU id (12 or 14) second.
// VideoRtpRtcp::_create (0x1002a45e0): CallType 2 → short id 12 (3 data bytes,
// header nibble 2); CallType 1 → long id 14 (7 data bytes, nibble 6). CallType is
// the mode dword at GroupCallPeer+0x390 (GroupCallConfig, fromJson from codec).
// Short payload, BuildVideoGroupCallExtension: byte0 = (spatial*3+temporal)<<4 |
// (spatial2*3+temporal2), byte1 = SFUExtensionData[5], byte2 = [4]. Layer 0 with
// the other fields zero is 00 00 00. 1-1 stays buildAudioRtpHeader (CallType 0).
function buildGroupVideoRtpHeader({ seq, ts, ssrc, twSeq, marker = false, pt, sfu }) {
  const long = !!(sfu && sfu.long);
  const id = (sfu && sfu.id) || (long ? 14 : 12);
  const dataLen = long ? 7 : 3;
  const extBytes = 4 + 1 + dataLen;
  const padded = (extBytes + 3) & ~3;
  const h = Buffer.alloc(12 + 4 + padded);
  h[0] = 0x90;
  h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
  h.writeUInt16BE(seq & 0xffff, 2);
  h.writeUInt32BE(ts >>> 0, 4);
  h.writeUInt32BE(ssrc >>> 0, 8);
  h.writeUInt16BE(0xbede, 12);
  h.writeUInt16BE(padded / 4, 14);
  h[16] = (TWCC_EXT_ID << 4) | 1;
  h.writeUInt16BE(twSeq & 0xffff, 17);
  h[19] = 0;
  h[20] = ((id & 0x0f) << 4) | (long ? 6 : 2);
  return h;
}

// Read the fields back (for checks against captured packets).
function readAudioRtpHeader(rtp) {
  if (rtp.length < 20 || rtp[0] !== 0x90 || rtp.readUInt16BE(12) !== 0xbede) return null;
  return {
    marker: !!(rtp[1] & 0x80),
    pt: rtp[1] & 0x7f,
    seq: rtp.readUInt16BE(2),
    ts: rtp.readUInt32BE(4),
    ssrc: rtp.readUInt32BE(8),
    twSeq: (rtp[16] >> 4) === TWCC_EXT_ID ? rtp.readUInt16BE(17) : null,
  };
}

module.exports = { AUDIO_PT, FRAME_SAMPLES, buildAudioRtpHeader, buildGroupVideoRtpHeader, readAudioRtpHeader };
