/**
 * Redraw: rebuild a picture on new layers using OMNI-CELL's own tools.
 *
 *   Ink         every traced centre line replayed through the stroke engine with the Trace Pen
 *               (exact width per point), plus solid black areas as shape fills
 *   Flats       one shape fill per region in its lit colour
 *   Shadows     multiply layer: per region, cel-shadow shapes in the colour that darkens the flat
 *   Light       screen layer: per region, highlight shapes
 *   Screentone  tone layers (one per density) whose painted shapes mask OMNI-CELL's dot screens
 *
 * The analysis (trace-core) runs in a worker; building the layers runs here because it draws on
 * the document's tile canvases. The result is one undo step and is scored against the source.
 */
import { TILE, type Doc, type Layer, makeCanvas } from "../document.js";
import { PRESETS, StrokeEngine, type BrushPreset } from "../brush.js";
import { toLab, type TraceParams, type TraceResult, type TraceShape, type RGB } from "./trace-core.js";
import { regionMap, type Region } from "../ml.js";

export type RedrawStyle = "colour" | "manga";
export interface RedrawOptions {
  params: Partial<TraceParams>;
  style: RedrawStyle;
  /** working resolution cap, megapixels */
  maxMpx: number;
  /** screentone frequency for the tone layers */
  lpi: number;
  /** ink colour: as traced (coloured lines kept) or black (print manga) */
  inkBlack: boolean;
  name: string;
}
export interface RedrawReport {
  layers: Layer[]; group: Layer;
  stats: TraceResult["stats"] & { workW: number; workH: number; buildMs: number; dabs: number };
  /** colour match of the colour redraw (flats + shadows + light + soft + ink) against the source, over the pixels the source covers */
  deltaE: number; within10: number; coverage: number;
  /** line match: F1 of redraw ink vs source ink, 1 px tolerance */
  lineF1: number; linePrecision: number; lineRecall: number;
}
export type Progress = (stage: string, pct: number) => void;

const hex = (c: RGB) => `#${c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;

export interface SourcePixels { data: ImageData; W: number; H: number; /** 1 where the source has at least 50% alpha; null when it is fully opaque */ mask: Uint8Array | null; coverage: number }
/**
 * Composite straight alpha onto white for the colour analysis, and keep where the picture actually
 * is as a mask (so a transparent sticker is traced and judged only where it has pixels).
 */
function onWhite(img: ImageData): SourcePixels {
  const N = img.width * img.height; const d = img.data; let covered = 0; let partial = false;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const a = d[i * 4 + 3]!; if (a >= 128) { mask[i] = 1; covered++; } if (a < 255) { partial = true; const t = a / 255; d[i * 4] = Math.round(d[i * 4]! * t + 255 * (1 - t)); d[i * 4 + 1] = Math.round(d[i * 4 + 1]! * t + 255 * (1 - t)); d[i * 4 + 2] = Math.round(d[i * 4 + 2]! * t + 255 * (1 - t)); d[i * 4 + 3] = 255; } }
  return { data: img, W: img.width, H: img.height, mask: partial ? mask : null, coverage: covered / N };
}
const workGrid = (region: Region, maxMpx: number) => { const rw = region.x1 - region.x0, rh = region.y1 - region.y0; const s = Math.min(1, Math.sqrt((maxMpx * 1e6) / Math.max(1, rw * rh))); return { rw, rh, W: Math.max(8, Math.round(rw * s)), H: Math.max(8, Math.round(rh * s)) }; };
/** the source picture resampled to the working grid over `region` (page coordinates) */
export async function sourcePixels(src: CanvasImageSource & { width: number; height: number }, doc: Doc, region: Region, mapRegion: Region | null, maxMpx: number): Promise<SourcePixels> {
  const { rw, rh, W, H } = workGrid(region, maxMpx);
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  // page -> work: (X - x0) * W / rw ; image placed on the page by the same mapping the generator used
  const m = regionMap(doc, src.width, src.height, mapRegion);
  g.setTransform(W / rw, 0, 0, H / rh, -region.x0 * W / rw, -region.y0 * H / rh);
  g.drawImage(src, -m.ox / m.s, -m.oy / m.s, src.width / m.s, src.height / m.s);
  return onWhite(g.getImageData(0, 0, W, H));
}
/** a layer's pixels inside `region` */
export function layerPixels(layer: Layer, region: Region, maxMpx: number): SourcePixels {
  const { rw, rh, W, H } = workGrid(region, maxMpx);
  const c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
  g.setTransform(W / rw, 0, 0, H / rh, -region.x0 * W / rw, -region.y0 * H / rh);
  const t = layer.transform; g.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
  for (const tile of layer.tiles.values()) if (tile.canvas) g.drawImage(tile.canvas as CanvasImageSource, tile.x * TILE, tile.y * TILE);
  return onWhite(g.getImageData(0, 0, W, H));
}

let worker: Worker | null = null; let jobId = 0;
/** run the analysis in a worker (falls back to this thread if workers are unavailable) */
export function analyse(img: ImageData, params: Partial<TraceParams>, progress?: Progress, mask: Uint8Array | null = null, lines: Uint8Array | null = null): { promise: Promise<TraceResult>; cancel: () => void } {
  const id = ++jobId; let cancelled = false;
  const promise = new Promise<TraceResult>((resolve, reject) => {
    try {
      if (!worker) worker = new Worker(new URL("./trace-worker.ts", import.meta.url), { type: "module" });
      const w = worker;
      const onMsg = (e: MessageEvent) => {
        const d = e.data as { id: number; progress?: { stage: string; pct: number }; result?: TraceResult; error?: string };
        if (d.id !== id) return;
        if (d.progress) { progress?.(d.progress.stage, d.progress.pct * 0.6); return; }
        w.removeEventListener("message", onMsg);
        if (cancelled) return reject(new Error("cancelled"));
        if (d.error) reject(new Error(d.error)); else resolve(d.result!);
      };
      w.addEventListener("message", onMsg);
      const copy = new Uint8ClampedArray(img.data); // the caller keeps its ImageData for scoring
      const m = mask ? mask.slice() : null; const ln = lines ? lines.slice() : null;
      const transfer: Transferable[] = [copy.buffer]; if (m) transfer.push(m.buffer); if (ln) transfer.push(ln.buffer);
      w.postMessage({ id, w: img.width, h: img.height, rgba: copy, params, mask: m, lines: ln }, transfer);
    } catch {
      void import("./trace-core.js").then(({ trace }) => resolve(trace(img.data, img.width, img.height, params, (s, p) => progress?.(s, p * 0.6), mask, lines))).catch(reject);
    }
  });
  return { promise, cancel: () => { cancelled = true; worker?.terminate(); worker = null; } };
}

/** fill traced shapes onto a layer, tile by tile; a hairline stroke of the same colour closes AA seams between neighbours */
function fillShapes(layer: Layer, shapes: TraceShape[], map: { sx: number; sy: number; ox: number; oy: number }, seam: boolean, color?: (s: TraceShape) => string): void {
  if (!shapes.length) return;
  const paths = shapes.map((sh) => { const p = new Path2D(); for (const loop of sh.loops) { p.moveTo(loop[0]!, loop[1]!); for (let i = 2; i < loop.length; i += 2) p.lineTo(loop[i]!, loop[i + 1]!); p.closePath(); } return p; });
  // page bounds of each shape for tile culling
  const pb = shapes.map((sh) => [map.ox + sh.box[0] * map.sx - 2, map.oy + sh.box[1] * map.sy - 2, map.ox + sh.box[2] * map.sx + 2, map.oy + sh.box[3] * map.sy + 2] as const);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const b of pb) { x0 = Math.min(x0, b[0]); y0 = Math.min(y0, b[1]); x1 = Math.max(x1, b[2]); y1 = Math.max(y1, b[3]); }
  for (const t of layer.tilesIn(x0, y0, x1, y1, true)) {
    if (!t.ctx) continue; const g = t.ctx as CanvasRenderingContext2D; const tx = t.x * TILE, ty = t.y * TILE;
    g.save(); g.setTransform(map.sx, 0, 0, map.sy, map.ox - tx, map.oy - ty); g.lineJoin = "round";
    let drew = false;
    shapes.forEach((sh, i) => {
      const b = pb[i]!; if (b[2] < tx || b[0] > tx + TILE || b[3] < ty || b[1] > ty + TILE) return;
      const c = color ? color(sh) : hex(sh.color); g.fillStyle = c; g.fill(paths[i]!, "evenodd");
      if (seam) { g.strokeStyle = c; g.lineWidth = 0.9; g.stroke(paths[i]!); }
      drew = true;
    });
    g.restore(); if (drew) t.generation++;
  }
  layer.generation++;
}

/**
 * Paint airbrush dabs (x, y, radius, R, G, B, alpha) onto a layer: each dab is a radial gradient with
 * a cos^2 falloff, the same footprint the Airbrush preset stamps. Batched per tile.
 */
function paintSoftDabs(layer: Layer, soft: Float32Array, map: { sx: number; sy: number; ox: number; oy: number }): number {
  const n = soft.length / 7; if (!n) return 0;
  const k = (map.sx + map.sy) / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { const px = map.ox + soft[i * 7]! * map.sx, py = map.oy + soft[i * 7 + 1]! * map.sy, r = soft[i * 7 + 2]! * k; x0 = Math.min(x0, px - r); y0 = Math.min(y0, py - r); x1 = Math.max(x1, px + r); y1 = Math.max(y1, py + r); }
  // one gradient per distinct radius (the grid uses one), re-coloured per dab via a cached sprite
  const sprites = new Map<string, HTMLCanvasElement | OffscreenCanvas>();
  const sprite = (r: number, R: number, G: number, B: number) => {
    const key = `${Math.round(r * 4)}:${R},${G},${B}`; let c = sprites.get(key); if (c) return c;
    const d = Math.ceil(r * 2) + 2; c = makeCanvas(d, d); const g = c.getContext("2d") as CanvasRenderingContext2D;
    const im = g.createImageData(d, d); const cx = d / 2, cy = d / 2;
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) { const dist = Math.hypot(x + 0.5 - cx, y + 0.5 - cy); const t = dist >= r ? 0 : Math.cos((Math.PI / 2) * (dist / r)); const o = (y * d + x) * 4; im.data[o] = R; im.data[o + 1] = G; im.data[o + 2] = B; im.data[o + 3] = Math.round(255 * t * t); }
    g.putImageData(im, 0, 0); sprites.set(key, c); return c;
  };
  let painted = 0;
  for (const t of layer.tilesIn(x0, y0, x1, y1, true)) {
    if (!t.ctx) continue; const g = t.ctx as CanvasRenderingContext2D; const tx = t.x * TILE, ty = t.y * TILE; let drew = false;
    for (let i = 0; i < n; i++) {
      const px = map.ox + soft[i * 7]! * map.sx - tx, py = map.oy + soft[i * 7 + 1]! * map.sy - ty, r = soft[i * 7 + 2]! * k;
      if (px + r < 0 || py + r < 0 || px - r > TILE || py - r > TILE) continue;
      const sp = sprite(r, Math.round(soft[i * 7 + 3]!), Math.round(soft[i * 7 + 4]!), Math.round(soft[i * 7 + 5]!));
      g.globalAlpha = soft[i * 7 + 6]!; g.drawImage(sp as CanvasImageSource, px - sp.width / 2, py - sp.height / 2); drew = true; painted++;
    }
    g.globalAlpha = 1; if (drew) t.generation++;
  }
  layer.generation++;
  return painted;
}

/** build the redraw layers from an analysis. Returns the new layers (bottom to top) and the group. */
export async function buildRedraw(doc: Doc, r: TraceResult, region: Region & { panelId?: number }, opts: RedrawOptions, progress?: Progress): Promise<{ layers: Layer[]; group: Layer; dabs: number }> {
  const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
  const map = { sx: rw / r.w, sy: rh / r.h, ox: region.x0, oy: region.y0 };
  const made: Layer[] = [];
  const mk = (kind: "raster" | "tone" | "group", name: string): Layer => { const l = doc.addLayer(kind); l.name = name; made.push(l); return l; };
  progress?.("flats", 0.62);
  const flats = mk("raster", "Flats"); fillShapes(flats, r.flats, map, true);
  progress?.("shadows", 0.66);
  const shadows = mk("raster", "Shadows"); shadows.blend = "multiply"; fillShapes(shadows, r.shadows, map, false);
  let light: Layer | null = null;
  if (r.highlights.length) { light = mk("raster", "Light"); light.blend = "screen"; fillShapes(light, r.highlights, map, false); }
  // soft shading: the gradients and airbrushed transitions the cel layers cannot hold, as airbrush dabs
  let softLayer: Layer | null = null;
  if (r.soft.length) { progress?.("soft shading", 0.68); softLayer = mk("raster", "Soft shading"); paintSoftDabs(softLayer, r.soft, map); }
  progress?.("screentone", 0.7);
  const toneGroup = mk("group", "Screentone");
  const tones: Layer[] = [];
  for (const t of r.tones) {
    const l = mk("tone", `Tone ${Math.round(t.density * 100)}%`); l.tone = { lpi: opts.lpi, density: t.density, angle: 45, shape: "dot", gradient: null };
    fillShapes(l, t.shapes, map, false, () => "#000000"); l.parent = toneGroup.id; tones.push(l);
  }
  // keep the tone group's row above its children
  doc.drawing.layers.splice(doc.drawing.layers.indexOf(toneGroup), 1); doc.drawing.layers.push(toneGroup); made.splice(made.indexOf(toneGroup), 1); made.push(toneGroup);
  // ---- ink: solid areas as fills, then every centre line through the stroke engine
  const ink = mk("raster", "Ink");
  fillShapes(ink, r.inkFills, map, false, opts.inkBlack ? () => "#141414" : undefined);
  const base = PRESETS.find((p) => p.name === "Trace Pen")!;
  const tips = new Map<string, OffscreenCanvas | HTMLCanvasElement>();
  const k = (map.sx + map.sy) / 2; let dabs = 0;
  for (let si = 0; si < r.strokes.length; si++) {
    const st = r.strokes[si]!; const p = st.pts; const n = p.length / 3;
    let maxW = 0; for (let i = 0; i < n; i++) maxW = Math.max(maxW, p[i * 3 + 2]!);
    const preset: BrushPreset = { ...base, size: Math.max(0.6, maxW * k) };
    const eng = new StrokeEngine({ preset, color: opts.inkBlack ? "#141414" : hex(st.color), layer: ink, docScale: doc.width / 2480, pageWidth: doc.width, pageHeight: doc.height, exact: true, sharedTips: tips });
    const sample = (i: number, t: number) => ({ x: map.ox + p[i * 3]! * map.sx, y: map.oy + p[i * 3 + 1]! * map.sy, pressure: p[i * 3 + 2]! / maxW, tiltX: 0, tiltY: 0, tMs: t });
    eng.begin(sample(0, 0));
    for (let i = 1; i < n; i++) eng.move(sample(i, i * 16));
    eng.end(); eng.commit(); dabs += eng.dabCount;
    if (si % 120 === 119) { progress?.("ink", 0.72 + 0.24 * (si / r.strokes.length)); await new Promise((res) => setTimeout(res, 0)); }
  }
  // ---- group, order (Flats, Shadows, Light, Screentone, Ink), panel clip, visibility for the style
  const group = mk("group", opts.name);
  for (const l of made) if (l !== group && l.parent === null) l.parent = group.id;
  for (const l of made) if (l.kind !== "group" && region.panelId !== undefined) l.panelMask = region.panelId;
  const manga = opts.style === "manga";
  flats.visible = !manga; shadows.visible = !manga; if (light) light.visible = !manga; if (softLayer) softLayer.visible = !manga; toneGroup.visible = manga;
  void tones;
  return { layers: made, group, dabs };
}

/**
 * Score the colour redraw against the source (both on white, on the working grid): mean CIE76
 * delta E and the share of pixels within 10, plus a 1 px-tolerant F1 of the ink lines.
 */
export function scoreRedraw(doc: Doc, srcImg: ImageData, r: TraceResult, region: Region, colourLayers: Layer[], inkLayer: Layer, mask: Uint8Array | null = null): { deltaE: number; within10: number; coverage: number; lineF1: number; linePrecision: number; lineRecall: number } {
  const W = r.w, H = r.h; const rw = region.x1 - region.x0, rh = region.y1 - region.y0;
  const render = (layers: Layer[], white: boolean): ImageData => {
    const c = makeCanvas(W, H) as HTMLCanvasElement; const g = c.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    if (white) { g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); }
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    for (const l of layers) {
      if (l.kind !== "raster") continue;
      g.save(); g.globalCompositeOperation = l.blend === "multiply" ? "multiply" : l.blend === "screen" ? "screen" : "source-over";
      g.setTransform(W / rw, 0, 0, H / rh, -region.x0 * W / rw, -region.y0 * H / rh);
      for (const t of l.tiles.values()) if (t.canvas) g.drawImage(t.canvas as CanvasImageSource, t.x * TILE, t.y * TILE);
      g.restore();
    }
    return g.getImageData(0, 0, W, H);
  };
  const out = render(colourLayers, true);
  const N = W * H; const a = toLab(srcImg.data, N), b = toLab(out.data, N);
  // only where the source has pixels: a transparent sticker is not judged against the paper around it
  let sum = 0, ok = 0, cnt = 0; for (let i = 0; i < N; i++) { if (mask && !mask[i]) continue; cnt++; const d = Math.hypot(a.L[i]! - b.L[i]!, a.A[i]! - b.A[i]!, a.B[i]! - b.B[i]!); sum += d; if (d < 10) ok++; }
  const M = Math.max(1, cnt);
  const inkImg = render([inkLayer], false); const red = new Uint8Array(N); for (let i = 0; i < N; i++) red[i] = inkImg.data[i * 4 + 3]! > 110 ? 1 : 0;
  const near = (m: Uint8Array, i: number) => { const x = i % W, y = (i / W) | 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < W && ny < H && m[ny * W + nx]) return true; } return false; };
  // lines only: solid black areas match trivially and would hide line errors
  let tp1 = 0, n1 = 0, tp2 = 0, n2 = 0;
  for (let i = 0; i < N; i++) { if (r.inkMask[i] === 2) continue; if (red[i]) { n1++; if (near(r.inkMask, i)) tp1++; } if (r.inkMask[i] === 1) { n2++; if (near(red, i)) tp2++; } }
  const P = n1 ? tp1 / n1 : 1, R = n2 ? tp2 / n2 : 1;
  return { deltaE: sum / M, within10: ok / M, coverage: cnt / N, lineF1: P + R ? (2 * P * R) / (P + R) : 0, linePrecision: P, lineRecall: R };
}

/**
 * Collapse a redraw group into one raster layer: the visible layers composited with their blend
 * modes and tones baked as dot screens (renderer.flatten does the baking). The caller decides what
 * happens to the parts; they can be re-baked later with another look even after leaving the document.
 */
export function bakeRedraw(doc: Doc, flatten: (doc: Doc, scale: number, ids: Set<number>) => HTMLCanvasElement, built: { layers: Layer[]; group: Layer }, region: Region & { panelId?: number }, name: string): Layer {
  const ids = new Set(built.layers.filter((l) => l.kind !== "group" && l.visible).map((l) => l.id));
  // the parts may already have been taken out of the document (re-baking a single layer): put them in for the composite
  const list = doc.drawing.layers; const temp = built.layers.filter((l) => !list.includes(l)); list.push(...temp);
  let flat: HTMLCanvasElement;
  try { flat = flatten(doc, 1, ids); } finally { for (const l of temp) { const i = list.indexOf(l); if (i >= 0) list.splice(i, 1); } }
  const out = doc.addLayer("raster"); out.name = name;
  if (region.panelId !== undefined) out.panelMask = region.panelId;
  for (const t of out.tilesIn(region.x0, region.y0, region.x1, region.y1, true)) {
    if (!t.ctx) continue; const g = t.ctx as CanvasRenderingContext2D;
    g.drawImage(flat, t.x * TILE, t.y * TILE, TILE, TILE, 0, 0, TILE, TILE); t.generation++;
  }
  out.generation++;
  return out;
}

