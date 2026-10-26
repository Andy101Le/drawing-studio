/**
 * File interchange.
 *   PSD export: Photoshop 8-bit RGBA, one PSD layer per raster/vector/tone layer (tones are
 *     rasterised at document dpi), group layers as folders (section dividers), clipping masks
 *     and blend modes preserved, plus the flattened composite so any viewer opens it.
 *   PSD import: reads 8-bit RGB(A) PSDs, raw or RLE (PackBits) channels, layer names, opacity,
 *     visibility, blend mode, clipping flag; groups are flattened into their children.
 *   PDF export: one page, the composite as a DCT (JPEG) or Flate-free RGB stream, MediaBox from dpi.
 *   PNG/TIFF-like: PNG with a pHYs chunk carrying the dpi so print software reads the size.
 */
import { TILE, Layer, Doc, type BlendMode, effectiveLayer } from "./document.js";
import { drawBalloon } from "./manga.js";

// ---------------------------------------------------------------- helpers
class Writer {
  private parts: Uint8Array[] = []; length = 0;
  u8(v: number) { this.bytes(new Uint8Array([v & 255])); }
  u16(v: number) { this.bytes(new Uint8Array([(v >> 8) & 255, v & 255])); }
  i16(v: number) { this.u16(v < 0 ? v + 65536 : v); }
  u32(v: number) { this.bytes(new Uint8Array([(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255])); }
  ascii(s: string) { this.bytes(new TextEncoder().encode(s)); }
  bytes(b: Uint8Array) { this.parts.push(b); this.length += b.byteLength; }
  pascal(s: string, pad = 4) { const b = new TextEncoder().encode(s.slice(0, 255)); this.u8(b.length); this.bytes(b); const total = 1 + b.length; const rem = (pad - (total % pad)) % pad; for (let i = 0; i < rem; i++) this.u8(0); }
  concat(): Uint8Array { const out = new Uint8Array(this.length); let o = 0; for (const p of this.parts) { out.set(p, o); o += p.byteLength; } return out; }
}

const PSD_BLEND: Record<BlendMode, string> = { normal: "norm", multiply: "mul ", screen: "scrn", overlay: "over", darken: "dark", lighten: "lite", add: "lddg" } as Record<BlendMode, string>;
const BLEND_FROM_PSD: Record<string, BlendMode> = { "norm": "normal", "mul ": "multiply", "scrn": "screen", "over": "overlay", "dark": "darken", "lite": "lighten", "lddg": "add" as BlendMode };

/** Layer pixels as a tight RGBA buffer with bounds (null when empty). Tones and vectors are rasterised. */
function rasterLayer(doc: Doc, l: Layer, renderLayer: (l: Layer) => HTMLCanvasElement | null): { x0: number; y0: number; w: number; h: number; data: Uint8ClampedArray } | null {
  const b = l.bounds();
  let canvas: HTMLCanvasElement | null = null; let x0 = 0, y0 = 0, w = 0, h = 0;
  if (l.kind === "raster" && b) {
    x0 = Math.max(0, b.x0); y0 = Math.max(0, b.y0); w = Math.min(doc.width, b.x1) - x0; h = Math.min(doc.height, b.y1) - y0;
    if (w <= 0 || h <= 0) return null;
    canvas = document.createElement("canvas"); canvas.width = w; canvas.height = h; const g = canvas.getContext("2d")!;
    for (const t of l.tiles.values()) if (t.canvas) g.drawImage(t.canvas as CanvasImageSource, t.x * TILE - x0, t.y * TILE - y0);
  } else {
    const full = renderLayer(l); if (!full) return null; canvas = full; x0 = 0; y0 = 0; w = full.width; h = full.height;
  }
  const data = canvas.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data;
  let any = false; for (let i = 3; i < data.length; i += 4) if (data[i]) { any = true; break; }
  return any ? { x0, y0, w, h, data } : null;
}

export function exportPsd(doc: Doc, composite: HTMLCanvasElement, renderLayer: (l: Layer) => HTMLCanvasElement | null): Uint8Array {
  const W = doc.width, H = doc.height;
  const w = new Writer();
  // header
  w.ascii("8BPS"); w.u16(1); w.bytes(new Uint8Array(6)); w.u16(4); w.u32(H); w.u32(W); w.u16(8); w.u16(3);
  w.u32(0); // colour mode data
  // image resources: resolution info (1005) so the dpi round-trips
  const res = new Writer(); res.ascii("8BIM"); res.u16(1005); res.u16(0); res.u32(16);
  const fixed = Math.round(doc.dpi * 65536); res.u32(fixed); res.u16(1); res.u16(1); res.u32(fixed); res.u16(1); res.u16(1);
  const resBytes = res.concat(); w.u32(resBytes.length); w.bytes(resBytes);
  // layer records (bottom to top in file order = document order), groups as section dividers
  const layers = doc.drawing.layers.filter((l) => l.kind !== "npr");
  const records = new Writer(); const channelData = new Writer(); let count = 0;
  const openGroups: number[] = [];
  const writeRecord = (name: string, rect: [number, number, number, number], channels: Array<{ id: number; data: Uint8Array }>, blend: string, opacity: number, clipping: boolean, visible: boolean, section: 0 | 1 | 3) => {
    count++;
    records.u32(rect[1]); records.u32(rect[0]); records.u32(rect[3]); records.u32(rect[2]); // top left bottom right
    records.u16(channels.length);
    for (const c of channels) { records.i16(c.id); records.u32(c.data.length + 2); channelData.u16(0); channelData.bytes(c.data); }
    records.ascii("8BIM"); records.ascii(blend); records.u8(Math.round(opacity * 255)); records.u8(clipping ? 1 : 0); records.u8((visible ? 0 : 2) | 8); records.u8(0);
    const extra = new Writer(); extra.u32(0); extra.u32(0); extra.pascal(name, 4);
    if (section) { extra.ascii("8BIM"); extra.ascii("lsct"); extra.u32(4); extra.u32(section); }
    const eb = extra.concat(); records.u32(eb.length); records.bytes(eb);
  };
  const emptyChannels = () => [-1, 0, 1, 2].map((id) => ({ id, data: new Uint8Array(0) }));
  // PSD groups: a hidden "</Layer group>" divider (section 3) opens the folder at the bottom, the named folder (section 1) closes it on top
  const emitLayer = (l: Layer) => {
    const eff = effectiveLayer(doc.drawing.layers, l);
    if (l.kind === "group") return;
    const r = rasterLayer(doc, l, renderLayer);
    if (!r) { writeRecord(l.name, [0, 0, 0, 0], emptyChannels(), PSD_BLEND[l.blend] ?? "norm", l.opacity, l.clipBelow, l.visible && eff.visible, 0); return; }
    const n = r.w * r.h; const ch = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
    for (let i = 0, j = 0; i < n; i++, j += 4) { ch[0]![i] = r.data[j + 3]!; ch[1]![i] = r.data[j]!; ch[2]![i] = r.data[j + 1]!; ch[3]![i] = r.data[j + 2]!; }
    writeRecord(l.name, [r.x0, r.y0, r.x0 + r.w, r.y0 + r.h], [{ id: -1, data: ch[0]! }, { id: 0, data: ch[1]! }, { id: 1, data: ch[2]! }, { id: 2, data: ch[3]! }], PSD_BLEND[l.blend] ?? "norm", l.opacity, l.clipBelow, l.visible, 0);
  };
  // walk: children of a group are emitted between its divider and its folder record
  const emitTree = (parent: number | null) => {
    for (const l of layers) {
      if (l.parent !== parent) continue;
      if (l.kind === "group") {
        writeRecord("</Layer group>", [0, 0, 0, 0], emptyChannels(), "norm", 1, false, true, 3);
        openGroups.push(l.id); emitTree(l.id); openGroups.pop();
        writeRecord(l.name, [0, 0, 0, 0], emptyChannels(), PSD_BLEND[l.blend] ?? "norm", l.opacity, false, l.visible, 1);
      } else emitLayer(l);
    }
  };
  emitTree(null);
  const recBytes = records.concat(), chBytes = channelData.concat();
  const layerInfo = new Writer(); layerInfo.i16(count); layerInfo.bytes(recBytes); layerInfo.bytes(chBytes);
  let li = layerInfo.concat(); if (li.length % 2) { const p = new Uint8Array(li.length + 1); p.set(li); li = p; }
  const lmi = new Writer(); lmi.u32(li.length); lmi.bytes(li); lmi.u32(0); // global layer mask info
  const lmiBytes = lmi.concat(); w.u32(lmiBytes.length); w.bytes(lmiBytes);
  // merged image: raw planar R G B A over white paper
  const g = composite.getContext("2d", { willReadFrequently: true })!; const img = g.getImageData(0, 0, W, H).data;
  w.u16(0); const n = W * H; const planes = [new Uint8Array(n), new Uint8Array(n), new Uint8Array(n), new Uint8Array(n)];
  for (let i = 0, j = 0; i < n; i++, j += 4) { const a = img[j + 3]! / 255; planes[0]![i] = Math.round(img[j]! * a + 255 * (1 - a)); planes[1]![i] = Math.round(img[j + 1]! * a + 255 * (1 - a)); planes[2]![i] = Math.round(img[j + 2]! * a + 255 * (1 - a)); planes[3]![i] = 255; }
  for (const pl of planes) w.bytes(pl);
  return w.concat();
}

// ---------------------------------------------------------------- PSD import
class Reader {
  o = 0; constructor(readonly v: DataView, readonly b: Uint8Array) {}
  u8() { return this.v.getUint8(this.o++); }
  u16() { const x = this.v.getUint16(this.o); this.o += 2; return x; }
  i16() { const x = this.v.getInt16(this.o); this.o += 2; return x; }
  u32() { const x = this.v.getUint32(this.o); this.o += 4; return x; }
  i32() { const x = this.v.getInt32(this.o); this.o += 4; return x; }
  ascii(n: number) { const s = new TextDecoder("latin1").decode(this.b.subarray(this.o, this.o + n)); this.o += n; return s; }
  skip(n: number) { this.o += n; }
}
function unpackBits(src: Uint8Array, out: Uint8Array): void {
  let i = 0, o = 0;
  while (i < src.length && o < out.length) {
    const n = (src[i++]! << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < out.length; k++) out[o++] = src[i++]!; }
    else if (n !== -128) { const v = src[i++]!; for (let k = 0; k < 1 - n && o < out.length; k++) out[o++] = v; }
  }
}

export interface PsdLayer { name: string; x: number; y: number; w: number; h: number; rgba: Uint8ClampedArray | null; opacity: number; visible: boolean; blend: BlendMode; clipping: boolean; group: "open" | "close" | null }
export function importPsd(bytes: Uint8Array): { width: number; height: number; dpi: number; layers: PsdLayer[] } {
  const r = new Reader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), bytes);
  if (r.ascii(4) !== "8BPS") throw new Error("not a PSD");
  const version = r.u16(); if (version !== 1) throw new Error("PSB (large document) is not supported");
  r.skip(6); const channels = r.u16(); const height = r.u32(); const width = r.u32(); const depth = r.u16(); const mode = r.u16();
  if (depth !== 8) throw new Error(`only 8-bit PSDs are supported (got ${depth})`);
  if (mode !== 3 && mode !== 1) throw new Error(`only RGB or grayscale PSDs are supported (mode ${mode})`);
  void channels;
  const cmLen = r.u32(); r.skip(cmLen);
  let dpi = 300; const resLen = r.u32(); const resEnd = r.o + resLen;
  while (r.o < resEnd - 12) {
    if (r.ascii(4) !== "8BIM") break;
    const id = r.u16(); const nameLen = r.u8(); r.skip(nameLen + ((nameLen + 1) % 2 === 0 ? 0 : 1) - 0); // pascal padded to even
    if ((nameLen + 1) % 2 === 1) { /* already padded by the skip above */ }
    const size = r.u32(); const start = r.o;
    if (id === 1005) { dpi = Math.round(r.u32() / 65536); }
    r.o = start + size + (size % 2);
  }
  r.o = resEnd;
  const lmiLen = r.u32(); const lmiEnd = r.o + lmiLen;
  const layers: PsdLayer[] = [];
  if (lmiLen > 0) {
    const liLen = r.u32(); void liLen;
    let count = r.i16(); if (count < 0) count = -count;
    const recs: Array<{ top: number; left: number; bottom: number; right: number; ch: Array<{ id: number; len: number }>; blend: string; opacity: number; clipping: boolean; visible: boolean; name: string; group: PsdLayer["group"] }> = [];
    for (let i = 0; i < count; i++) {
      const top = r.i32(), left = r.i32(), bottom = r.i32(), right = r.i32();
      const nch = r.u16(); const ch: Array<{ id: number; len: number }> = [];
      for (let c = 0; c < nch; c++) ch.push({ id: r.i16(), len: r.u32() });
      r.ascii(4); const blend = r.ascii(4); const opacity = r.u8() / 255; const clipping = r.u8() === 1; const flags = r.u8(); r.u8();
      const extraLen = r.u32(); const extraEnd = r.o + extraLen;
      const maskLen = r.u32(); r.skip(maskLen); const brLen = r.u32(); r.skip(brLen);
      const nameLen = r.u8(); const name = new TextDecoder("latin1").decode(bytes.subarray(r.o, r.o + nameLen)); r.skip(nameLen); r.skip((4 - ((nameLen + 1) % 4)) % 4);
      let group: PsdLayer["group"] = null;
      while (r.o < extraEnd - 12) {
        const sig = r.ascii(4); if (sig !== "8BIM" && sig !== "8B64") break;
        const key = r.ascii(4); const len = r.u32(); const s = r.o;
        if (key === "lsct") { const t = r.u32(); group = t === 3 ? "open" : t === 1 || t === 2 ? "close" : null; }
        r.o = s + len + (len % 2);
      }
      r.o = extraEnd;
      recs.push({ top, left, bottom, right, ch, blend, opacity, clipping, visible: (flags & 2) === 0, name, group });
    }
    for (const rec of recs) {
      const w = rec.right - rec.left, h = rec.bottom - rec.top; const n = Math.max(0, w * h);
      const planes = new Map<number, Uint8Array>();
      for (const c of rec.ch) {
        const comp = r.u16(); const dataLen = c.len - 2; const start = r.o; const out = new Uint8Array(n);
        if (n > 0) {
          if (comp === 0) out.set(bytes.subarray(start, start + n));
          else if (comp === 1) { const counts: number[] = []; let p = start; for (let y = 0; y < h; y++) { counts.push(r.v.getUint16(p)); p += 2; } let o = 0; for (let y = 0; y < h; y++) { const row = new Uint8Array(w); unpackBits(bytes.subarray(p, p + counts[y]!), row); out.set(row, o); o += w; p += counts[y]!; } }
          else throw new Error(`unsupported channel compression ${comp}`);
        }
        planes.set(c.id, out); r.o = start + dataLen;
      }
      let rgba: Uint8ClampedArray | null = null;
      if (n > 0) {
        rgba = new Uint8ClampedArray(n * 4); const R = planes.get(0), G = planes.get(1) ?? R, B = planes.get(2) ?? R, A = planes.get(-1);
        for (let i = 0, j = 0; i < n; i++, j += 4) { rgba[j] = R?.[i] ?? 0; rgba[j + 1] = G?.[i] ?? 0; rgba[j + 2] = B?.[i] ?? 0; rgba[j + 3] = A ? A[i]! : 255; }
      }
      layers.push({ name: rec.name, x: rec.left, y: rec.top, w, h, rgba, opacity: rec.opacity, visible: rec.visible, blend: BLEND_FROM_PSD[rec.blend] ?? "normal", clipping: rec.clipping, group: rec.group });
    }
  }
  r.o = lmiEnd;
  return { width, height, dpi, layers };
}

/** Build a Doc from an imported PSD (groups become group layers; children keep their order). */
export function docFromPsd(psd: ReturnType<typeof importPsd>): Doc {
  const doc = new Doc(); doc.width = psd.width; doc.height = psd.height; doc.dpi = psd.dpi;
  const frame = doc.drawing; frame.layers = [];
  const stack: number[] = [];
  for (const pl of psd.layers) {
    if (pl.group === "open") { const g = new Layer("Group", "group"); g.parent = stack[stack.length - 1] ?? null; frame.layers.push(g); stack.push(g.id); continue; }
    if (pl.group === "close") { const id = stack.pop(); const g = frame.layers.find((l) => l.id === id); if (g) { g.name = pl.name; g.opacity = pl.opacity; g.visible = pl.visible; g.blend = pl.blend; } continue; }
    const l = new Layer(pl.name, "raster"); l.opacity = pl.opacity; l.visible = pl.visible; l.blend = pl.blend; l.clipBelow = pl.clipping; l.parent = stack[stack.length - 1] ?? null;
    if (pl.rgba && pl.w > 0 && pl.h > 0) {
      const c = document.createElement("canvas"); c.width = pl.w; c.height = pl.h; c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(pl.rgba.buffer as ArrayBuffer, pl.rgba.byteOffset, pl.rgba.byteLength), pl.w, pl.h), 0, 0);
      for (const t of l.tilesIn(Math.max(0, pl.x), Math.max(0, pl.y), Math.min(doc.width, pl.x + pl.w), Math.min(doc.height, pl.y + pl.h), true)) { if (!t.ctx) continue; (t.ctx as CanvasRenderingContext2D).drawImage(c, pl.x - t.x * TILE, pl.y - t.y * TILE); t.generation++; }
    }
    frame.layers.push(l);
  }
  if (!frame.layers.length) frame.layers.push(new Layer("Ink", "raster"));
  doc.activeLayerId = frame.layers[frame.layers.length - 1]!.id;
  return doc;
}

// ---------------------------------------------------------------- PDF
/** Single-page PDF: the composite as a JPEG XObject, page size from dpi. */
export async function exportPdf(doc: Doc, composite: HTMLCanvasElement, quality = 0.92): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res, rej) => composite.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", quality));
  const jpg = new Uint8Array(await blob.arrayBuffer());
  const pw = (doc.width * 72) / doc.dpi, ph = (doc.height * 72) / doc.dpi;
  const enc = new TextEncoder(); const parts: Uint8Array[] = []; const offsets: number[] = []; let pos = 0;
  const push = (s: string | Uint8Array) => { const b = typeof s === "string" ? enc.encode(s) : s; parts.push(b); pos += b.length; };
  const obj = (n: number, body: string | Uint8Array, stream?: Uint8Array) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(body); if (stream) { push("\nstream\n"); push(stream); push("\nendstream"); } push("\nendobj\n"); };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(3)} ${ph.toFixed(3)}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
  obj(4, `<< /Type /XObject /Subtype /Image /Width ${doc.width} /Height ${doc.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
  const content = `q ${pw.toFixed(3)} 0 0 ${ph.toFixed(3)} 0 0 cm /Im0 Do Q`;
  obj(5, `<< /Length ${content.length} >>`, enc.encode(content));
  const info = `<< /Producer (OMNI-CELL) /Title (${doc.name.replace(/[()\\]/g, "")}) >>`; obj(6, info);
  const xref = pos; push(`xref\n0 7\n0000000000 65535 f \n`); for (let i = 1; i <= 6; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size 7 /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/** Multi-page PDF: one JPEG XObject per page, each page sized from its own dpi. */
export async function exportPdfPages(docs: Doc[], composites: HTMLCanvasElement[], quality = 0.92): Promise<Uint8Array> {
  const enc = new TextEncoder(); const parts: Uint8Array[] = []; const offsets: number[] = []; let pos = 0;
  const push = (s: string | Uint8Array) => { const b = typeof s === "string" ? enc.encode(s) : s; parts.push(b); pos += b.length; };
  const obj = (n: number, body: string, stream?: Uint8Array) => { offsets[n] = pos; push(`${n} 0 obj\n`); push(body); if (stream) { push("\nstream\n"); push(stream); push("\nendstream"); } push("\nendobj\n"); };
  push("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");
  const n = docs.length; const pageIds = docs.map((_, i) => 3 + i * 3); // page, image, content per page
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>`);
  for (let i = 0; i < n; i++) {
    const doc = docs[i]!, comp = composites[i]!; const pw = (doc.width * 72) / doc.dpi, ph = (doc.height * 72) / doc.dpi;
    const blob: Blob = await new Promise((res, rej) => comp.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/jpeg", quality));
    const jpg = new Uint8Array(await blob.arrayBuffer()); const pid = pageIds[i]!;
    obj(pid, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(3)} ${ph.toFixed(3)}] /Resources << /XObject << /Im0 ${pid + 1} 0 R >> >> /Contents ${pid + 2} 0 R >>`);
    obj(pid + 1, `<< /Type /XObject /Subtype /Image /Width ${doc.width} /Height ${doc.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>`, jpg);
    const content = `q ${pw.toFixed(3)} 0 0 ${ph.toFixed(3)} 0 0 cm /Im0 Do Q`; obj(pid + 2, `<< /Length ${content.length} >>`, enc.encode(content));
  }
  const infoId = 3 + n * 3; obj(infoId, "<< /Producer (OMNI-CELL) >>");
  const total = infoId + 1; const xref = pos; push(`xref\n0 ${total}\n0000000000 65535 f \n`); for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(pos); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out;
}

// ---------------------------------------------------------------- PNG with dpi
/** Insert a pHYs chunk (pixels per metre) after IHDR so the PNG carries its print size. */
export async function exportPngWithDpi(canvas: HTMLCanvasElement, dpi: number): Promise<Uint8Array> {
  const blob: Blob = await new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
  const png = new Uint8Array(await blob.arrayBuffer());
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4); const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9); chunk.set(new TextEncoder().encode("pHYs"), 4); dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1;
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  const out = new Uint8Array(png.length + chunk.length); out.set(png.subarray(0, ihdrEnd)); out.set(chunk, ihdrEnd); out.set(png.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}
let crcTable: Uint32Array | null = null;
export function crc32(b: Uint8Array): number {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 255]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}

/** Composite for export: layers + balloons over white paper at document size; with `surface.inExport`,
 *  the surface fills transparent areas first (paper is drawn opaque white regardless). */
export async function exportComposite(doc: Doc, flatten: (doc: Doc, scale?: number) => HTMLCanvasElement): Promise<HTMLCanvasElement> {
  const { paintSurface } = await import("./surface.js");
  const flat = flatten(doc, 1);
  const c = document.createElement("canvas"); c.width = doc.width; c.height = doc.height; const g = c.getContext("2d")!;
  if (doc.surface.inExport) {
    let img: HTMLImageElement | null = null;
    if (doc.surface.kind === "image" && doc.surface.image) { img = new Image(); img.src = doc.surface.image; try { await img.decode(); } catch { img = null; } }
    paintSurface(g, doc.surface, c.width, c.height, img);
  } else { g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); }
  g.drawImage(flat, 0, 0);
  void drawBalloon; // balloons are already part of flatten()
  return c;
}
