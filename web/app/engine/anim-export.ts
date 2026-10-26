/**
 * Animation audio and export.
 *   Audio: a decoded AudioBuffer kept on the app (not in the .omni), per-frame RMS for the
 *     Xsheet waveform column, and sample-accurate playback started at the current frame.
 *   Export: every frame rendered at document size (or a scale), then
 *     - image sequence as a ZIP (store-only, CRC-32) of PNGs
 *     - animated GIF (median-cut palette, Floyd-Steinberg dithering, LZW, loop forever)
 *     - WebM video through MediaRecorder on a canvas stream, frames pushed at the document fps
 */
import { crc32 } from "./export.js";
export { cameraAt } from "./tween.js";

// ---------------------------------------------------------------- audio
export interface AudioTrack { name: string; buffer: AudioBuffer; rms: Float32Array; offsetFrames: number }

export async function loadAudio(file: File, fps: number, ctx: AudioContext): Promise<AudioTrack> {
  const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  return { name: file.name, buffer, rms: frameRms(buffer, fps), offsetFrames: 0 };
}
export function frameRms(buffer: AudioBuffer, fps: number): Float32Array {
  const ch = buffer.getChannelData(0); const per = buffer.sampleRate / fps; const n = Math.ceil(buffer.duration * fps);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) { const s0 = Math.floor(f * per), s1 = Math.min(ch.length, Math.floor((f + 1) * per)); let acc = 0; for (let i = s0; i < s1; i++) acc += ch[i]! * ch[i]!; out[f] = Math.sqrt(acc / Math.max(1, s1 - s0)); }
  // normalise to the loudest frame
  let m = 0; for (const v of out) m = Math.max(m, v); if (m > 0) for (let i = 0; i < n; i++) out[i] = out[i]! / m;
  return out;
}
export class AudioPlayer {
  private src: AudioBufferSourceNode | null = null;
  constructor(readonly ctx: AudioContext) {}
  start(track: AudioTrack, frame: number, fps: number): void {
    this.stop();
    const t = (frame - track.offsetFrames) / fps; if (t >= track.buffer.duration) return;
    const s = this.ctx.createBufferSource(); s.buffer = track.buffer; s.connect(this.ctx.destination);
    if (t >= 0) s.start(0, t); else s.start(this.ctx.currentTime - t, 0);
    this.src = s;
  }
  stop(): void { try { this.src?.stop(); } catch { /* already stopped */ } this.src = null; }
}

// ---------------------------------------------------------------- ZIP (store only)
export function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const enc = new TextEncoder(); const parts: Uint8Array[] = []; const central: Uint8Array[] = []; let offset = 0;
  const le16 = (v: number) => [v & 255, (v >> 8) & 255]; const le32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  for (const f of files) {
    const name = enc.encode(f.name); const crc = crc32(f.data);
    const local = new Uint8Array([0x50, 0x4b, 3, 4, ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(f.data.length), ...le32(f.data.length), ...le16(name.length), ...le16(0), ...name]);
    parts.push(local, f.data);
    central.push(new Uint8Array([0x50, 0x4b, 1, 2, ...le16(20), ...le16(20), ...le16(0), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc), ...le32(f.data.length), ...le32(f.data.length), ...le16(name.length), ...le16(0), ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(offset), ...name]));
    offset += local.length + f.data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array([0x50, 0x4b, 5, 6, ...le16(0), ...le16(0), ...le16(files.length), ...le16(files.length), ...le32(cdSize), ...le32(offset), ...le16(0)]);
  const total = offset + cdSize + end.length; const out = new Uint8Array(total); let o = 0;
  for (const p of [...parts, ...central, end]) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- GIF
/** Median-cut palette (<= 256 colours) over a sample of the frames. */
function medianCut(pixels: Uint8ClampedArray[], maxColors = 256): Uint8Array {
  const samples: number[][] = [];
  for (const px of pixels) for (let i = 0; i < px.length; i += 4 * 7) samples.push([px[i]!, px[i + 1]!, px[i + 2]!]);
  let boxes: number[][][] = [samples];
  while (boxes.length < maxColors) {
    boxes.sort((a, b) => b.length - a.length); const box = boxes.shift()!; if (box.length < 2) { boxes.push(box); break; }
    const ranges = [0, 1, 2].map((c) => { let lo = 255, hi = 0; for (const s of box) { lo = Math.min(lo, s[c]!); hi = Math.max(hi, s[c]!); } return hi - lo; });
    const axis = ranges.indexOf(Math.max(...ranges)); box.sort((a, b) => a[axis]! - b[axis]!);
    const mid = box.length >> 1; boxes.push(box.slice(0, mid), box.slice(mid));
  }
  const pal = new Uint8Array(256 * 3);
  boxes.forEach((box, i) => { if (!box.length) return; let r = 0, g = 0, b = 0; for (const s of box) { r += s[0]!; g += s[1]!; b += s[2]!; } pal[i * 3] = Math.round(r / box.length); pal[i * 3 + 1] = Math.round(g / box.length); pal[i * 3 + 2] = Math.round(b / box.length); });
  return pal;
}
function nearest(pal: Uint8Array, n: number, r: number, g: number, b: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < n; i++) { const dr = pal[i * 3]! - r, dg = pal[i * 3 + 1]! - g, db = pal[i * 3 + 2]! - b; const d = dr * dr + dg * dg + db * db; if (d < bd) { bd = d; best = i; } }
  return best;
}
/** Floyd-Steinberg quantisation to palette indices. */
function quantise(px: Uint8ClampedArray, w: number, h: number, pal: Uint8Array, n: number): Uint8Array {
  const out = new Uint8Array(w * h); const err = new Float32Array(w * h * 3); const cache = new Map<number, number>();
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const j = i * 4;
    const r = Math.max(0, Math.min(255, px[j]! + err[i * 3]!)), g = Math.max(0, Math.min(255, px[j + 1]! + err[i * 3 + 1]!)), b = Math.max(0, Math.min(255, px[j + 2]! + err[i * 3 + 2]!));
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2); let idx = cache.get(key); if (idx === undefined) { idx = nearest(pal, n, r, g, b); cache.set(key, idx); }
    out[i] = idx;
    const er = r - pal[idx * 3]!, eg = g - pal[idx * 3 + 1]!, eb = b - pal[idx * 3 + 2]!;
    const spread = (dx: number, dy: number, k: number) => { const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= w || yy >= h) return; const q = (yy * w + xx) * 3; err[q] = err[q]! + er * k; err[q + 1] = err[q + 1]! + eg * k; err[q + 2] = err[q + 2]! + eb * k; };
    spread(1, 0, 7 / 16); spread(-1, 1, 3 / 16); spread(0, 1, 5 / 16); spread(1, 1, 1 / 16);
  }
  return out;
}
/** LZW encoder for GIF image data (variable code size, 8-bit minimum, dictionary keyed on prefix<<8|byte). */
function lzw(indices: Uint8Array): Uint8Array {
  const minCode = 8, clear = 1 << minCode, eoi = clear + 1;
  const out: number[] = []; let cur = 0, curBits = 0;
  const emit = (code: number, size: number) => { cur |= code << curBits; curBits += size; while (curBits >= 8) { out.push(cur & 255); cur >>>= 8; curBits -= 8; } };
  let dict = new Map<number, number>(); let next = eoi + 1; let size = minCode + 1;
  emit(clear, size);
  if (!indices.length) { emit(eoi, size); if (curBits > 0) out.push(cur & 255); return new Uint8Array(out); }
  let prefix = indices[0]!;
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]!; const key = (prefix << 8) | k; const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix, size);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear, size); dict = new Map(); next = eoi + 1; size = minCode + 1; }
    prefix = k;
  }
  emit(prefix, size); emit(eoi, size); if (curBits > 0) out.push(cur & 255);
  return new Uint8Array(out);
}
export function encodeGif(frames: Array<{ data: Uint8ClampedArray; w: number; h: number }>, fps: number): Uint8Array {
  if (!frames.length) return new Uint8Array(0);
  const w = frames[0]!.w, h = frames[0]!.h; const pal = medianCut(frames.map((f) => f.data)); const n = 256;
  const parts: number[] = [];
  const le16 = (v: number) => [v & 255, (v >> 8) & 255];
  parts.push(...new TextEncoder().encode("GIF89a"), ...le16(w), ...le16(h), 0xf7, 0, 0); // global colour table 256
  parts.push(...pal);
  parts.push(0x21, 0xff, 11, ...new TextEncoder().encode("NETSCAPE2.0"), 3, 1, 0, 0, 0); // loop forever
  const delay = Math.max(2, Math.round(100 / fps));
  for (const f of frames) {
    const idx = quantise(f.data, w, h, pal, n); const data = lzw(idx);
    parts.push(0x21, 0xf9, 4, 0, ...le16(delay), 0, 0); // graphic control
    parts.push(0x2c, 0, 0, 0, 0, ...le16(w), ...le16(h), 0, 8);
    for (let i = 0; i < data.length; i += 255) { const chunk = data.subarray(i, i + 255); parts.push(chunk.length, ...chunk); }
    parts.push(0);
  }
  parts.push(0x3b);
  return new Uint8Array(parts);
}

// ---------------------------------------------------------------- WebM
export async function recordWebm(frames: HTMLCanvasElement[], fps: number, onProgress?: (i: number) => void): Promise<Blob> {
  const first = frames[0]; if (!first) throw new Error("no frames");
  const stage = document.createElement("canvas"); stage.width = first.width; stage.height = first.height; const g = stage.getContext("2d")!;
  g.drawImage(first, 0, 0);
  // automatic capture at the document fps: the stage is repainted on a timer and the stream samples it
  const stream = stage.captureStream(fps);
  const mime = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 });
  const chunks: Blob[] = []; rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<Blob>((res) => { rec.onstop = () => res(new Blob(chunks, { type: mime })); });
  rec.start(100);
  const frameMs = 1000 / fps; const t0 = performance.now();
  for (let i = 0; i < frames.length; i++) {
    g.drawImage(frames[i]!, 0, 0); onProgress?.(i);
    const due = t0 + (i + 1) * frameMs; await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
  }
  await new Promise((r) => setTimeout(r, frameMs * 3));
  rec.stop();
  return done;
}
