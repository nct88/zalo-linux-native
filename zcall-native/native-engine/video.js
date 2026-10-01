'use strict';
// Received video: RTP payloads -> whole H.264 access units (Annex-B), in order.
//
// What the phone sends when we announce h264 and no HEVC (call 2026-10-01):
//   PT 98  key frames (SPS/PPS/IDR, High profile), PT 97 other frames, one
//          RTP sequence for both; PT 100 (own sequence, FEC?) is ignored.
//   Payload: an Annex-B chunk, either whole (starts 00 00 ..) or a fragment
//          with a 2-byte header 1c 80 (first), 1c 00 (middle), 1c 40 (last).
//   The RTP marker bit ends a frame; all packets of a frame share the timestamp.
// Same packetization as the H.265 the phone sends to the Windows engine.
//
// Frames go out in sequence order. Over P2P packets arrive up to ~13 late,
// so a frame that is complete but not next waits a little (REORDER_*). If the
// gap does not fill, decoding goes on anyway: the decoder conceals the damage,
// while waiting for the next key frame would freeze the picture for tens of
// seconds (the phone sends key frames rarely: 2 in a 20 s call). Only the very
// first frame must be a key frame.

const VIDEO_PTS = new Set([97, 98]);
const KEY_PT = 98;
const REORDER_FRAMES = 3; // complete frames held while an earlier one is missing
const REORDER_MS = 200;
const MAX_PENDING = 30; // incomplete frames kept (by timestamp)

class VideoAssembler {
  constructor(onFrame, now = () => Date.now()) {
    this.onFrame = onFrame; // ({ key, data, ts })
    this.now = now;
    this.pending = new Map(); // ts -> { parts: Map(idx -> payload), key, end }
    this.ready = new Map(); // first idx -> { key, data, ts, last, since }
    this.lastIdx = -1; // last packet of the last frame handed on
    this.started = false; // a key frame went out
    this.stats = { frames: 0, dropped: 0, keys: 0, gaps: 0 };
  }

  push({ ts, pt, marker, payload, seq, roc = 0 }) {
    if (!VIDEO_PTS.has(pt) || !payload.length) return;
    const idx = roc * 0x10000 + seq;
    if (idx <= this.lastIdx) return; // late, or a duplicate (relay + P2P)
    let f = this.pending.get(ts);
    if (!f) {
      f = { parts: new Map(), key: false, end: null };
      this.pending.set(ts, f);
      if (this.pending.size > MAX_PENDING) { this.pending.delete(this.pending.keys().next().value); this.stats.dropped++; }
    }
    f.parts.set(idx, payload);
    if (pt === KEY_PT) f.key = true;
    if (marker) f.end = idx;
    if (f.end !== null) this._complete(ts, f);
    this._flush();
  }

  _complete(ts, f) {
    const idxs = [...f.parts.keys()].sort((a, b) => a - b);
    const first = f.parts.get(idxs[0]);
    if (isFragment(first) && first[1] !== 0x80) return; // first fragment still missing
    for (let i = 1; i < idxs.length; i++) if (idxs[i] !== idxs[i - 1] + 1) return; // hole
    if (idxs[idxs.length - 1] !== f.end) return;
    this.pending.delete(ts);
    const data = Buffer.concat(idxs.map((i) => { const p = f.parts.get(i); return isFragment(p) ? p.subarray(2) : p; }));
    this.ready.set(idxs[0], { key: f.key, data, ts, last: f.end, since: this.now() });
  }

  _flush() {
    for (;;) {
      if (!this.ready.size) return;
      const next = this.ready.get(this.lastIdx + 1);
      if (next && this.lastIdx >= 0) { this._emit(this.lastIdx + 1, next); continue; }
      // Nothing in order: wait a little for the late packets, then skip the gap.
      const firstIdx = Math.min(...this.ready.keys());
      const oldest = this.ready.get(firstIdx);
      const waited = this.now() - oldest.since;
      if (this.lastIdx >= 0 && this.ready.size <= REORDER_FRAMES && waited < REORDER_MS) return;
      if (!this.started && !oldest.key) { this.ready.delete(firstIdx); this.stats.dropped++; continue; }
      if (this.lastIdx >= 0) this.stats.gaps++;
      this._emit(firstIdx, oldest);
    }
  }

  _emit(firstIdx, fr) {
    this.ready.delete(firstIdx);
    this.lastIdx = fr.last;
    // Incomplete frames from before this point can no longer be used.
    for (const [t, f] of this.pending) if (Math.max(...f.parts.keys()) <= this.lastIdx) { this.pending.delete(t); this.stats.dropped++; }
    this.started = this.started || fr.key;
    this.stats.frames++;
    if (fr.key) this.stats.keys++;
    this.onFrame({ key: fr.key, data: fr.data, ts: fr.ts });
  }
}

function isFragment(p) {
  return p.length >= 2 && p[0] === 0x1c && (p[1] & 0x3f) === 0;
}

// avc1.PPCCLL from the SPS of a key frame (WebCodecs codec string).
function avcCodecString(annexB) {
  for (let i = 0; i + 7 < annexB.length; i++) {
    if (annexB[i] === 0 && annexB[i + 1] === 0 && annexB[i + 2] === 1 && (annexB[i + 3] & 0x1f) === 7) {
      return 'avc1.' + [annexB[i + 4], annexB[i + 5], annexB[i + 6]].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
  }
  return null;
}

// Outgoing video: one H.264 access unit (Annex-B) -> RTP payloads, the way
// the phone packs its own: whole if it fits, else 1c 80 / 1c 00 / 1c 40
// fragments of at most MAX_CHUNK bytes. The caller sets the marker on the last.
const MAX_CHUNK = 1068; // the phone's fragments carry 1068 bytes (1070 with the header)

function packetizeFrame(annexB, maxChunk = MAX_CHUNK) {
  if (annexB.length <= maxChunk) return [annexB];
  const out = [];
  for (let off = 0; off < annexB.length; off += maxChunk) {
    const end = Math.min(off + maxChunk, annexB.length);
    const flag = off === 0 ? 0x80 : end === annexB.length ? 0x40 : 0x00;
    out.push(Buffer.concat([Buffer.from([0x1c, flag]), annexB.subarray(off, end)]));
  }
  return out;
}

module.exports = { VideoAssembler, avcCodecString, packetizeFrame, KEY_PT, DELTA_PT: 97 };
