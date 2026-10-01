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

module.exports = { AUDIO_PT, FRAME_SAMPLES, buildAudioRtpHeader, readAudioRtpHeader };
