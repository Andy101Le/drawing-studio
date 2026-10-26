/**
 * Viewport compositor (Phase 1.5 pass order, Canvas 2D implementation).
 *
 * WebGPU is the long-term compositor; this implementation runs everywhere the
 * web build is tested first (Windows Chrome, iPad Safari) and renders the same
 * document model. Dirty-rect redraw keeps a 4K viewport under budget: only the
 * screen rect covered by the last stroke is recomposited.
 *
 * Pass order per frame:
 *   paper → (for each layer, bottom→top) tiles with blend/opacity/panel clip →
 *   onion ghosts → panel borders + gutters → proof LUT (optional) → UI overlay
 */

import { drawBalloon } from "./manga.js";
import { effectiveLayer, clipBase } from "./document.js";
import { layerAt, keyMatrix, cameraAt, cameraRect } from "./tween.js";
import { BLEND_TO_CANVAS, TILE, type Doc, type Frame, type Layer, type Panel, type Tile } from "./document.js";
import { proofImageData } from "./color.js";
import { toneField, tonePattern } from "./screentone.js";
import { hexToRgb } from "./brush.js";
import { drawPathTo, tween } from "./vector.js";
import { GpuCompositor } from "./gpu-compositor.js";

export interface View {
  zoom: number; // screen px per DU
  rotation: number; // radians
  panX: number; // screen px of DU origin
  panY: number;
}

export interface ActiveStroke {
  layerId: number;
  buffer: Layer;
  opacity: number;
  kind: "paint" | "eraser" | "smudge" | "blur";
  blend: "normal" | "multiply";
}

const PROJ_OPTS = { activeStroke: null, extraStrokes: [], proofCmyk: false, showPanels: false, showGrid: false, selectedBalloon: null, guides: null, nprCanvases: new Map(), toneInk: "#141414" } as unknown as RenderOptions;

export interface RenderOptions {
  activeStroke: ActiveStroke | null;
  proofCmyk: boolean;
  showPanels: boolean;
  extraStrokes?: ActiveStroke[];
  selectedBalloon?: number | null;
  guides?: { bleed: number; safe: number } | null;
  showGrid: boolean;
  nprCanvases: Map<number, CanvasImageSource>; // layerId → rendered NPR canvas
  toneInk: string;
}

export class Renderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private scratch: HTMLCanvasElement;
  private sctx: CanvasRenderingContext2D;
  private dpr = 1;
  gpu: GpuCompositor | null = null;
  mode: "canvas2d" | "webgpu" = "canvas2d";
  /** overlay for panel borders / grid when the GPU path owns the main canvas */
  uiCanvas: HTMLCanvasElement | null = null;
  view: View = { zoom: 0.25, rotation: 0, panX: 40, panY: 40 };
  private dirty: { x0: number; y0: number; x1: number; y1: number } | null = null; // screen px
  private full = true;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: true, desynchronized: true }) as CanvasRenderingContext2D;
    this.scratch = document.createElement("canvas");
    this.sctx = this.scratch.getContext("2d") as CanvasRenderingContext2D;
  }

  /** Try the WebGPU compositor on a second canvas; falls back silently. */
  async initGpu(gpuCanvas: HTMLCanvasElement, uiCanvas: HTMLCanvasElement): Promise<boolean> {
    try {
      const g = new GpuCompositor(gpuCanvas);
      if (!(await g.init())) return false;
      this.gpu = g; this.mode = "webgpu"; this.uiCanvas = uiCanvas;
      // keep the 2D canvas as the (invisible) pointer target; visibility:hidden would stop pointer events
      this.canvas.style.opacity = "0"; gpuCanvas.style.display = "block"; uiCanvas.style.display = "block";
      this.full = true;
      return true;
    } catch { return false; }
  }

  /** Switch back to Canvas 2D (GPU error, self-test failure, or user toggle). */
  useCanvas2d(reason: string): void {
    if (this.mode !== "webgpu") return;
    this.mode = "canvas2d";
    this.canvas.style.opacity = "1";
    const gc = this.gpu?.["canvas"] as HTMLCanvasElement | undefined; if (gc) gc.style.display = "none";
    if (this.uiCanvas) this.uiCanvas.style.display = "none";
    this.gpuDisabledReason = reason;
    this.full = true;
  }
  gpuDisabledReason: string | null = null;

  /** Re-enable the GPU path after a manual toggle. */
  useWebGpu(): boolean {
    if (!this.gpu || this.gpu.failed) return false;
    this.mode = "webgpu"; this.canvas.style.opacity = "0";
    (this.gpu["canvas"] as HTMLCanvasElement).style.display = "block"; if (this.uiCanvas) this.uiCanvas.style.display = "block";
    this.full = true; return true;
  }

  /**
   * Start-up self-test: after the first GPU frame, the pixel at the page centre
   * must be bright (paper). Catches silent validation failures on drivers the
   * build machine never saw.
   */
  async selfTest(doc: Doc): Promise<boolean> {
    if (!this.gpu || this.mode !== "webgpu") return true;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    if (this.gpu.failed) { this.useCanvas2d(this.gpu.failed); return false; }
    const c = this.docToScreen(doc.width / 2, doc.height / 2);
    const px = await this.gpu.readPixel(c.x * this.dpr, c.y * this.dpr);
    if (!px || !(px[0] > 0.5 && px[1] > 0.5 && px[2] > 0.5)) { this.useCanvas2d(`self-test: centre pixel ${px ? px.map((v) => v.toFixed(2)).join(",") : "unreadable"}`); return false; }
    return true;
  }

  resize(): void {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h || dpr !== this.dpr) {
      this.canvas.width = w; this.canvas.height = h; this.dpr = dpr;
      this.scratch.width = w; this.scratch.height = h;
      this.full = true;
    }
    if (this.gpu) {
      const gc = this.gpu["canvas"] as HTMLCanvasElement;
      if (gc.width !== w || gc.height !== h) { gc.width = w; gc.height = h; this.full = true; }
      this.gpu.resize(w, h);
      if (this.uiCanvas && (this.uiCanvas.width !== w || this.uiCanvas.height !== h)) { this.uiCanvas.width = w; this.uiCanvas.height = h; }
    }
  }

  // ---- transforms ----
  matrix(): DOMMatrix {
    const v = this.view;
    return new DOMMatrix().scale(this.dpr).translate(v.panX, v.panY).rotate((v.rotation * 180) / Math.PI).scale(v.zoom);
  }
  screenToDoc(sx: number, sy: number): { x: number; y: number } {
    const p = this.matrix().inverse().transformPoint(new DOMPoint(sx * this.dpr, sy * this.dpr));
    return { x: p.x, y: p.y };
  }
  docToScreen(x: number, y: number): { x: number; y: number } {
    const p = this.matrix().transformPoint(new DOMPoint(x, y));
    return { x: p.x / this.dpr, y: p.y / this.dpr };
  }
  fitPage(doc: Doc, padding = 48): void {
    const r = this.canvas.getBoundingClientRect();
    const z = Math.min((r.width - padding * 2) / doc.width, (r.height - padding * 2) / doc.height);
    this.view = { zoom: z, rotation: 0, panX: (r.width - doc.width * z) / 2, panY: (r.height - doc.height * z) / 2 };
    this.full = true;
  }
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToDoc(sx, sy);
    this.view.zoom = Math.max(0.02, Math.min(32, this.view.zoom * factor));
    const after = this.screenToDoc(sx, sy);
    const m = new DOMMatrix().rotate((this.view.rotation * 180) / Math.PI).scale(this.view.zoom);
    const d = m.transformPoint(new DOMPoint(after.x - before.x, after.y - before.y));
    this.view.panX += d.x; this.view.panY += d.y;
    this.full = true;
  }
  rotateBy(rad: number): void { this.view.rotation += rad; this.full = true; }
  panBy(dx: number, dy: number): void { this.view.panX += dx; this.view.panY += dy; this.full = true; }

  /** Mark a DU rect dirty. */
  invalidate(rect?: { x0: number; y0: number; x1: number; y1: number }, fromStroke = false, staleProjection = true): void {
    if (!rect || Number.isNaN(rect.x0)) { this.full = true; this.sc = null; this.proj = null; return; }
    // an empty rect (a batch of samples that laid no dab) used to fall through to a full repaint
    if (!Number.isFinite(rect.x0) || !Number.isFinite(rect.x1) || rect.x1 < rect.x0 || rect.y1 < rect.y0) return;
    if (this.proj && staleProjection) this.projStale(rect);
    const m = this.matrix();
    const pts = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x0, rect.y1], [rect.x1, rect.y1]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
    const sx0 = Math.floor(Math.min(...pts.map((p) => p.x))) - 2, sy0 = Math.floor(Math.min(...pts.map((p) => p.y))) - 2;
    const sx1 = Math.ceil(Math.max(...pts.map((p) => p.x))) + 2, sy1 = Math.ceil(Math.max(...pts.map((p) => p.y))) + 2;
    if (this.sc && !fromStroke) this.sc.stale.push({ x0: sx0, y0: sy0, x1: sx1, y1: sy1 });
    if (!this.dirty) this.dirty = { x0: sx0, y0: sy0, x1: sx1, y1: sy1 };
    else this.dirty = { x0: Math.min(this.dirty.x0, sx0), y0: Math.min(this.dirty.y0, sy0), x1: Math.max(this.dirty.x1, sx1), y1: Math.max(this.dirty.y1, sy1) };
  }

  get needsRender(): boolean { return this.full || this.dirty !== null; }

  private extraStrokes: ActiveStroke[] | null = null;
  /** screen rect being repainted this frame: scratch canvases are cleared and copied only inside it */
  private clipRect = { x0: 0, y0: 0, x1: 0, y1: 0 };
  /** Clip a scratch canvas to this frame's rect: without it every tile drawImage rasterises its whole 256 px footprint. Pair with g.restore(). */
  private clipScratch(g: CanvasRenderingContext2D): void { const c = this.clipRect; g.save(); g.setTransform(1, 0, 0, 1, 0, 0); g.beginPath(); g.rect(c.x0, c.y0, Math.max(0, c.x1 - c.x0), Math.max(0, c.y1 - c.y0)); g.clip(); }
  /**
   * Draw the tiles that meet this frame's rect, each cropped to the part inside it (+2 px for filtering).
   * The rect is mapped through g's current transform, so view, layer and keyframe transforms are all honoured.
   */
  private drawTiles(g: CanvasRenderingContext2D, tiles: Map<string, Tile>): void {
    if (!tiles.size) return;
    const c = this.clipRect; const inv = g.getTransform().inverse();
    let vx0 = Infinity, vy0 = Infinity, vx1 = -Infinity, vy1 = -Infinity;
    for (const [px, py] of [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]] as const) {
      const x = inv.a * px + inv.c * py + inv.e, y = inv.b * px + inv.d * py + inv.f;
      if (x < vx0) vx0 = x; if (x > vx1) vx1 = x; if (y < vy0) vy0 = y; if (y > vy1) vy1 = y;
    }
    // filtering reads up to ~2 px past the rect; unfiltered (1:1 projection tiles) reads nothing past it,
    // so neighbours are not pulled in
    const M = g.imageSmoothingEnabled ? 2 : 0; const e = M ? 0 : 1e-6;
    const tx0 = Math.floor((vx0 - M + e) / TILE), ty0 = Math.floor((vy0 - M + e) / TILE), tx1 = Math.floor((vx1 + M - e) / TILE), ty1 = Math.floor((vy1 + M - e) / TILE);
    const one = (tile: Tile) => {
      if (!tile.canvas) return;
      const x = tile.x * TILE, y = tile.y * TILE;
      const sx0 = Math.max(0, Math.floor(vx0 - x + e) - M), sy0 = Math.max(0, Math.floor(vy0 - y + e) - M);
      const sx1 = Math.min(TILE, Math.ceil(vx1 - x - e) + M), sy1 = Math.min(TILE, Math.ceil(vy1 - y - e) + M);
      if (sx1 <= sx0 || sy1 <= sy0) return;
      if (sx0 === 0 && sy0 === 0 && sx1 === TILE && sy1 === TILE) g.drawImage(tile.canvas as CanvasImageSource, x, y);
      else g.drawImage(tile.canvas as CanvasImageSource, sx0, sy0, sx1 - sx0, sy1 - sy0, x + sx0, y + sy0, sx1 - sx0, sy1 - sy0);
    };
    if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) < tiles.size) {
      // a small rect over a big layer: look up the few candidate tiles instead of scanning them all
      for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) { const t = tiles.get(`${tx},${ty}`); if (t) one(t); }
    } else for (const tile of tiles.values()) { if (tile.x < tx0 || tile.x > tx1 || tile.y < ty0 || tile.y > ty1) continue; one(tile); }
  }
  private clearScratch(g: CanvasRenderingContext2D): void { const c = this.clipRect; g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(c.x0, c.y0, Math.max(0, c.x1 - c.x0), Math.max(0, c.y1 - c.y0)); }
  private blitScratch(ctx: CanvasRenderingContext2D, src: HTMLCanvasElement | OffscreenCanvas): void { const c = this.clipRect; const w = c.x1 - c.x0, hh = c.y1 - c.y0; if (w <= 0 || hh <= 0) return; ctx.drawImage(src as CanvasImageSource, c.x0, c.y0, w, hh, c.x0, c.y0, w, hh); }
  render(doc: Doc, opts: RenderOptions): void {
    if (!this.needsRender) return;
    this.extraStrokes = opts.extraStrokes ?? null;
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    const clip = this.full ? { x0: 0, y0: 0, x1: W, y1: H } : (this.dirty as NonNullable<typeof this.dirty>);
    this.full = false; this.dirty = null;
    this.clipRect = { x0: Math.max(0, clip.x0), y0: Math.max(0, clip.y0), x1: Math.min(W, clip.x1), y1: Math.min(H, clip.y1) };
    if (this.gpu && this.mode === "webgpu") {
      if (this.gpu.failed) { this.useCanvas2d(this.gpu.failed); this.full = true; this.render(doc, opts); return; }
      this.gpu.render(doc, this.view, this.dpr, opts, clip);
      if (this.uiCanvas) {
        const u = this.uiCanvas.getContext("2d")!;
        u.setTransform(1, 0, 0, 1, 0, 0); u.clearRect(0, 0, W, H); u.setTransform(this.matrix());
        if (doc.surface.shadow) this.drawPageShadow(u, doc);
        for (const b of doc.balloons) drawBalloon(u, b, b.id === opts.selectedBalloon);
        if (opts.showPanels) this.drawPanels(u, doc.panels);
        if (opts.showGrid) this.drawGrid(u, doc);
        if (opts.guides) this.drawGuides(u, doc, opts.guides);
        if (doc.showCamera && doc.camera.length) this.drawCamera(u, doc);
      }
      return;
    }
    const m = this.matrix();
    const n = doc.drawing.layers.length;
    // While a stroke is live only its layer changes, so everything under it and (when it composes
    // associatively) everything over it is cached in screen space once per stroke. A frame then costs
    // two blits plus one layer instead of re-compositing every layer in the dirty rect.
    const plan = this.strokePlan(doc, opts);
    // the pen-up frame also goes through the stroke cache: only the stroke's layer changed, and the
    // flattened projection under it is rebuilt by idle frames instead of all at once here
    const viaCache = !!plan && (!!opts.activeStroke || this.strokeEndFrame); this.strokeEndFrame = false;
    if (plan && viaCache) this.prepareStrokeCache(doc, opts, plan, W, H); else if (!plan) this.sc = null;
    ctx.save();
    ctx.beginPath(); ctx.rect(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0); ctx.clip();
    ctx.clearRect(0, 0, W, H); // the viewport's CSS surface shows through outside the page
    this.clipRect = { x0: Math.max(0, clip.x0), y0: Math.max(0, clip.y0), x1: Math.min(W, clip.x1), y1: Math.min(H, clip.y1) };
    const v = this.visibleDocRect(m, this.clipRect);
    if (plan && viaCache && this.sc) {
      ctx.setTransform(1, 0, 0, 1, 0, 0); this.blitScratch(ctx, this.sc.below);
      ctx.setTransform(m); ctx.imageSmoothingEnabled = this.view.zoom < 4; ctx.imageSmoothingQuality = "high";
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
      this.paintLayers(ctx, doc, opts, plan.index, plan.aboveCached ? plan.index + 1 : n, v);
      ctx.restore();
      if (plan.aboveCached) { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); this.blitScratch(ctx, this.sc.above); ctx.restore(); }
    } else {
      ctx.setTransform(m);
      // mid-stroke frames that miss the stroke cache draw every layer live and leave the projection alone
      const k = opts.activeStroke || (opts.extraStrokes && opts.extraStrokes.length) ? 0 : this.projectionPrefix(doc);
      if (k > 0) {
        // layers [0, k) come from the flattened, zoom-levelled projection: one tile draw per
        // position instead of one per layer, and no per-frame downsampling of full-res tiles
        if (doc.surface.shadow) this.drawPageShadow(ctx, doc);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
        const late = this.drawProjection(ctx, doc, k);
        ctx.imageSmoothingEnabled = this.view.zoom < 4; ctx.imageSmoothingQuality = "high";
        this.paintLayers(ctx, doc, opts, k, n, v);
        ctx.restore();
        // tiles shown from another zoom level this frame: refine them next frame (content unchanged,
        // so neither cache is marked stale)
        for (const [tx, ty] of late) this.invalidate({ x0: tx * TILE, y0: ty * TILE, x1: (tx + 1) * TILE, y1: (ty + 1) * TILE }, true, false);
      } else {
        this.paintBase(ctx, doc, v);
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip();
        this.paintLayers(ctx, doc, opts, 0, n, v);
        ctx.restore();
      }
    }
    ctx.setTransform(m);
    for (const b of doc.balloons) drawBalloon(ctx, b, b.id === opts.selectedBalloon);
    // panels
    if (opts.showPanels) this.drawPanels(ctx, doc.panels);
    if (opts.guides) this.drawGuides(ctx, doc, opts.guides);
    if (opts.showGrid) this.drawGrid(ctx, doc);
    if (doc.showCamera && doc.camera.length) this.drawCamera(ctx, doc);
    ctx.restore();
    if (opts.proofCmyk) {
      const img = ctx.getImageData(clip.x0, clip.y0, clip.x1 - clip.x0, clip.y1 - clip.y0);
      proofImageData(img);
      ctx.putImageData(img, clip.x0, clip.y0);
    }
  }

  // ---- projection: the bottom of the stack flattened per document tile and zoom level ----
  /**
   * tiles[level]["tx,ty"] holds paper + layers [0, upto) composited at 1/2^level resolution.
   * Content edits mark tiles stale through invalidate(rect); invalidate() with no rect, a new
   * document/frame, or any layer property change (folded into `key`) drops it all.
   */
  proj: { key: string; upto: number; levels: Map<number, Map<string, HTMLCanvasElement>> } | null = null;
  /** turn off to compare against compositing every layer (window.omni.renderer.projection = false) */
  projection = true;
  private docIds = new WeakMap<object, number>(); private nextDocId = 1;
  private projScratch: { s2: HTMLCanvasElement; c2: CanvasRenderingContext2D; s3: HTMLCanvasElement; c3: CanvasRenderingContext2D } | null = null;
  private projStale(rect: { x0: number; y0: number; x1: number; y1: number }): void {
    const tx0 = Math.floor((rect.x0 - 2) / TILE), ty0 = Math.floor((rect.y0 - 2) / TILE), tx1 = Math.floor((rect.x1 + 2) / TILE), ty1 = Math.floor((rect.y1 + 2) / TILE);
    for (const tiles of this.proj!.levels.values()) {
      if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > tiles.size) { for (const key of [...tiles.keys()]) { const [x, y] = key.split(",").map(Number) as [number, number]; if (x >= tx0 && x <= tx1 && y >= ty0 && y <= ty1) tiles.delete(key); } }
      else for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) tiles.delete(`${tx},${ty}`);
    }
  }
  /** How many layers from the bottom can be flattened: plain raster/vector layers in page space. */
  private projectionPrefix(doc: Doc): number {
    if (!this.projection || doc.onionEnabled || this.mode !== "canvas2d") { this.proj = null; return 0; }
    const layers = doc.drawing.layers; let k = 0;
    for (; k < layers.length; k++) {
      const l = layers[k]!; if (l.kind === "group") continue;
      const eff = effectiveLayer(layers, l); if (!eff.visible || eff.opacity <= 0) continue;
      if (l.kind !== "raster" && l.kind !== "vector") break; // tone patterns are screen-locked, NPR is a live render
      if (l.keys.length) break;
      const t = l.transform; if (t[0] !== 1 || t[1] !== 0 || t[2] !== 0 || t[3] !== 1 || t[4] !== 0 || t[5] !== 0) break;
    }
    // a clipped layer just above the prefix needs its base drawn live too, so stop below that base
    while (k > 0 && k < layers.length) { const b = clipBase(layers, layers[k]!); if (!b) break; const bi = layers.indexOf(b); if (bi >= k) break; k = bi; }
    if (k < 2) { this.proj = null; return 0; }
    let id = this.docIds.get(doc); if (!id) { id = this.nextDocId++; this.docIds.set(doc, id); }
    let sig = 0;
    for (let i = 0; i < k; i++) { const l = layers[i]!; const e = effectiveLayer(layers, l); sig = (sig * 31 + l.id * 7 + (e.visible ? 1 : 0) + Math.round(e.opacity * 255) * 3 + l.blend.length * 13 + (l.clipBelow ? 11 : 0) + (l.panelMask ?? -1) * 17 + l.paths.length * 19) | 0; }
    const key = `${id}|${doc.drawing.id}|${k}|${sig}|${doc.width}x${doc.height}|${doc.panels.length}`;
    if (!this.proj || this.proj.key !== key) this.proj = { key, upto: k, levels: new Map() };
    return k;
  }
  /** flattening budget per frame (ms); past it, tiles another kept level has are stretched and refined next frame */
  projBudgetMs = 10;
  /**
   * Zoom level of the flattened tiles. A level is used only well below its threshold: down to 0.35x
   * the full-resolution tiles are drawn directly (same single filter step as drawing each layer,
   * so edges match the live-stroke view), below that the stored tile is at most 1.4x the screen size.
   */
  private projLevel(scale: number): number { return Math.max(0, Math.min(3, Math.floor(Math.log2(1 / Math.max(1e-6, scale)) - 0.5))); }
  private drawProjection(ctx: CanvasRenderingContext2D, doc: Doc, k: number): Array<[number, number]> {
    const late: Array<[number, number]> = []; const t0 = performance.now();
    const scale = this.view.zoom * this.dpr;
    const level = this.projLevel(scale);
    const pj = this.proj!;
    let tiles = pj.levels.get(level);
    if (!tiles) {
      tiles = new Map(); pj.levels.set(level, tiles);
      // keep the two most recently used levels (zooming back and forth stays cheap)
      while (pj.levels.size > 2) pj.levels.delete(pj.levels.keys().next().value!);
    } else { pj.levels.delete(level); pj.levels.set(level, tiles); }
    const S = TILE >> level;
    const c = this.clipRect; const inv = ctx.getTransform().inverse();
    let vx0 = Infinity, vy0 = Infinity, vx1 = -Infinity, vy1 = -Infinity;
    for (const [px, py] of [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]] as const) {
      const x = inv.a * px + inv.c * py + inv.e, y = inv.b * px + inv.d * py + inv.f;
      if (x < vx0) vx0 = x; if (x > vx1) vx1 = x; if (y < vy0) vy0 = y; if (y > vy1) vy1 = y;
    }
    const tx0 = Math.max(0, Math.floor(vx0 / TILE)), ty0 = Math.max(0, Math.floor(vy0 / TILE));
    const tx1 = Math.min(Math.ceil(doc.width / TILE) - 1, Math.floor(vx1 / TILE)), ty1 = Math.min(Math.ceil(doc.height / TILE) - 1, Math.floor(vy1 / TILE));
    const eff = scale * (1 << level); // 0.5..1 when zoomed out
    ctx.imageSmoothingEnabled = eff < 4; ctx.imageSmoothingQuality = "high";
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = `${tx},${ty}`; let pc = tiles.get(key);
      const x = tx * TILE, y = ty * TILE;
      if (!pc && performance.now() - t0 > this.projBudgetMs) {
        // over budget (a zoom step into a new level): stretch the tile from the other kept level now
        let stand: { c: HTMLCanvasElement; l: number } | null = null;
        for (const [l, m] of pj.levels) { if (l === level) continue; const c2 = m.get(key); if (c2) { stand = { c: c2, l }; break; } }
        if (stand) {
          ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "low";
          ctx.drawImage(stand.c, 0, 0, stand.c.width, stand.c.height, x, y, TILE, TILE); ctx.restore();
          late.push([tx, ty]); continue;
        }
      }
      if (!pc) { pc = this.composeProjectionTile(doc, k, tx, ty, level); tiles.set(key, pc); }
      // crop to the visible part, in level pixels (+1 for filtering)
      const sx0 = Math.max(0, Math.floor((vx0 - x) / (1 << level)) - 1), sy0 = Math.max(0, Math.floor((vy0 - y) / (1 << level)) - 1);
      const sx1 = Math.min(S, Math.ceil((vx1 - x) / (1 << level)) + 1), sy1 = Math.min(S, Math.ceil((vy1 - y) / (1 << level)) + 1);
      if (sx1 <= sx0 || sy1 <= sy0) continue;
      const f = 1 << level;
      ctx.drawImage(pc, sx0, sy0, sx1 - sx0, sy1 - sy0, x + sx0 * f, y + sy0 * f, (sx1 - sx0) * f, (sy1 - sy0) * f);
    }
    return late;
  }
  private composeProjectionTile(doc: Doc, k: number, tx: number, ty: number, level: number): HTMLCanvasElement {
    // Composite at full resolution (1:1 copies, no filtering), then downscale once. Drawing each
    // layer straight to 1/4 size made the browser filter every source tile separately.
    const S = TILE >> level;
    const full = this.projLevel0(doc, k, tx, ty, level === 0);
    if (level === 0) return full;
    // one filtered downscale of the flattened tile (the browser's "high" filter, the same one the
    // per-layer path uses) instead of one per layer
    const dst = document.createElement("canvas"); dst.width = S; dst.height = S;
    const g = dst.getContext("2d") as CanvasRenderingContext2D;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(full, 0, 0, TILE, TILE, 0, 0, S, S);
    return dst;
  }
  private projFull: HTMLCanvasElement | null = null;
  /** Paper + layers [0, k) of one tile at 1:1. `keep` returns a fresh canvas (it becomes a level-0 tile). */
  private projLevel0(doc: Doc, k: number, tx: number, ty: number, keep: boolean): HTMLCanvasElement {
    let cv: HTMLCanvasElement;
    if (keep) { cv = document.createElement("canvas"); cv.width = TILE; cv.height = TILE; }
    else { cv = this.projFull ?? (this.projFull = Object.assign(document.createElement("canvas"), { width: TILE, height: TILE })); }
    const g = cv.getContext("2d") as CanvasRenderingContext2D;
    g.setTransform(1, 0, 0, 1, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = "source-over"; g.clearRect(0, 0, TILE, TILE);
    g.setTransform(1, 0, 0, 1, -tx * TILE, -ty * TILE);
    g.fillStyle = "#ffffff"; g.fillRect(0, 0, doc.width, doc.height);
    g.imageSmoothingEnabled = false;
    // drawClipped's scratch canvases follow the target's size: give it tile-sized ones
    if (!this.projScratch) {
      const s2 = document.createElement("canvas"), s3 = document.createElement("canvas"); s2.width = s3.width = TILE; s2.height = s3.height = TILE;
      this.projScratch = { s2, c2: s2.getContext("2d") as CanvasRenderingContext2D, s3, c3: s3.getContext("2d") as CanvasRenderingContext2D };
    }
    const saved = { clip: this.clipRect, s2: this.scratch2, c2: this.sctx2, s3: this.scratch3, c3: this.sctx3 };
    this.clipRect = { x0: 0, y0: 0, x1: TILE, y1: TILE };
    this.scratch2 = this.projScratch.s2; this.sctx2 = this.projScratch.c2; this.scratch3 = this.projScratch.s3; this.sctx3 = this.projScratch.c3;
    const x0 = tx * TILE, y0 = ty * TILE;
    g.save(); g.beginPath(); g.rect(0, 0, doc.width, doc.height); g.clip();
    this.paintLayers(g, doc, PROJ_OPTS, 0, k, { vx0: x0, vy0: y0, vx1: x0 + TILE, vy1: y0 + TILE });
    g.restore();
    this.clipRect = saved.clip; this.scratch2 = saved.s2; this.sctx2 = saved.c2; this.scratch3 = saved.s3; this.sctx3 = saved.c3;
    return cv;
  }

  /** Page shadow, paper and onion skins: everything under the first layer. */
  private paintBase(ctx: CanvasRenderingContext2D, doc: Doc, v: { vx0: number; vy0: number; vx1: number; vy1: number }): void {
    if (doc.surface.shadow) this.drawPageShadow(ctx, doc);
    ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, doc.width, doc.height);
    ctx.imageSmoothingEnabled = this.view.zoom < 4;
    ctx.imageSmoothingQuality = "high";
    if (doc.onionEnabled) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, doc.width, doc.height); ctx.clip(); this.onion(ctx, doc, v.vx0, v.vy0, v.vx1, v.vy1); ctx.restore(); }
  }
  /** Layers [from, to) in stack order, already inside the page clip. */
  private paintLayers(ctx: CanvasRenderingContext2D, doc: Doc, opts: RenderOptions, from: number, to: number, v: { vx0: number; vy0: number; vx1: number; vy1: number }): void {
    const layers = doc.drawing.layers;
    for (let i = from; i < to; i++) {
      const layer = layers[i]!;
      if (layer.kind === "group") continue;
      const eff = effectiveLayer(layers, layer); if (!eff.visible || eff.opacity <= 0) continue;
      const base = clipBase(layers, layer);
      if (base) this.drawClipped(ctx, doc, layer, base, v.vx0, v.vy0, v.vx1, v.vy1, opts, eff.opacity / Math.max(1e-6, layer.opacity));
      else this.drawLayer(ctx, doc, layer, v.vx0, v.vy0, v.vx1, v.vy1, opts, eff.opacity / Math.max(1e-6, layer.opacity));
    }
  }
  private visibleDocRect(m: DOMMatrix, c: { x0: number; y0: number; x1: number; y1: number }): { vx0: number; vy0: number; vx1: number; vy1: number } {
    const inv = m.inverse();
    const p = [[c.x0, c.y0], [c.x1, c.y0], [c.x0, c.y1], [c.x1, c.y1]].map(([x, y]) => inv.transformPoint(new DOMPoint(x, y)));
    return { vx0: Math.min(p[0]!.x, p[1]!.x, p[2]!.x, p[3]!.x), vy0: Math.min(p[0]!.y, p[1]!.y, p[2]!.y, p[3]!.y), vx1: Math.max(p[0]!.x, p[1]!.x, p[2]!.x, p[3]!.x), vy1: Math.max(p[0]!.y, p[1]!.y, p[2]!.y, p[3]!.y) };
  }

  // ---- stroke-time layer cache ----
  /** below: shadow + paper + onion + layers under the stroke; above: layers over it (only when exact). */
  sc: { key: string; below: HTMLCanvasElement; above: HTMLCanvasElement; stale: { x0: number; y0: number; x1: number; y1: number }[]; valid: Uint8Array; gw: number } | null = null;
  private scPool: { below: HTMLCanvasElement; above: HTMLCanvasElement } | null = null;
  /** turn off to compare against the uncached path (window.omni.renderer.strokeCache = false) */
  strokeCache = true;
  /** Which layer the cache is built around: the live stroke's, else the active layer (idle warm-up). */
  private strokePlan(doc: Doc, opts: RenderOptions): { index: number; aboveCached: boolean; key: string } | null {
    if (!this.strokeCache || opts.proofCmyk) return null;
    const st = opts.activeStroke; const layerId = st ? st.layerId : doc.activeLayerId;
    const layers = doc.drawing.layers; const index = layers.findIndex((l) => l.id === layerId);
    if (index < 0 || layers[index]!.kind === "group") return null;
    // a remote collaborator stroking another layer changes that layer every frame: draw live
    if ((opts.extraStrokes ?? []).some((x) => x.layerId !== layerId)) return null;
    if (layers.length < 2) return null; // nothing to cache
    // source-over is associative, so the layers above can be pre-composited onto transparency.
    // Any other blend, or a layer clipped onto the stroke layer or below it, needs the live result.
    let aboveCached = true;
    for (let i = index + 1; i < layers.length; i++) {
      const l = layers[i]!; if (l.kind === "group") continue;
      const eff = effectiveLayer(layers, l); if (!eff.visible || eff.opacity <= 0) continue;
      // 8-bit premultiplied intermediates round differently for translucent layers (measured up to 14/255)
      if (l.blend !== "normal" || eff.opacity < 0.999 || (l.keys.length > 0)) { aboveCached = false; break; }
      const b = clipBase(layers, l); if (b && layers.indexOf(b) <= index) { aboveCached = false; break; }
    }
    // layer visibility/opacity/blend below are folded into the key so property edits that skip
    // invalidation still rebuild
    let sig = 0; for (let i = 0; i < layers.length; i++) { const l = layers[i]!; sig = (sig * 31 + l.id * 7 + (l.visible ? 1 : 0) + Math.round(l.opacity * 255) * 3 + l.blend.length + (l.clipBelow ? 11 : 0)) | 0; }
    const v = this.view;
    const key = `${layerId}|${index}|${layers.length}|${sig}|${doc.currentFrame}|${doc.onionEnabled}|${v.zoom}|${v.rotation}|${v.panX}|${v.panY}|${this.canvas.width}x${this.canvas.height}|${aboveCached}`;
    return { index, aboveCached, key };
  }
  private static readonly CELL = 64;
  private ensureCache(plan: { key: string }, W: number, H: number): NonNullable<Renderer["sc"]> {
    const CELL = Renderer.CELL;
    if (!this.sc || this.sc.key !== plan.key) {
      // lazily filled cell by cell, so there is no full composite at pen-down
      const mk = () => document.createElement("canvas");
      const pool = this.scPool ?? (this.scPool = { below: mk(), above: mk() });
      for (const c of [pool.below, pool.above]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
      this.sc = { key: plan.key, below: pool.below, above: pool.above, stale: [], valid: new Uint8Array(Math.ceil(W / CELL) * Math.ceil(H / CELL)), gw: Math.ceil(W / CELL) };
    }
    const sc = this.sc; const gw = sc.gw, gh = sc.valid.length / gw;
    for (const r of sc.stale) { // something other than the cached-around layer changed (drying paint, a remote commit)
      const cx0 = Math.max(0, Math.floor(r.x0 / CELL)), cy0 = Math.max(0, Math.floor(r.y0 / CELL)), cx1 = Math.min(gw - 1, Math.floor(r.x1 / CELL)), cy1 = Math.min(gh - 1, Math.floor(r.y1 / CELL));
      for (let cy = cy0; cy <= cy1; cy++) sc.valid.fill(0, cy * gw + cx0, cy * gw + cx1 + 1);
    }
    sc.stale = [];
    return sc;
  }
  private paintCache(doc: Doc, opts: RenderOptions, plan: { index: number; aboveCached: boolean }, rect: { x0: number; y0: number; x1: number; y1: number }): void {
    const sc = this.sc!; const W = sc.below.width, H = sc.below.height;
    const n = doc.drawing.layers.length; const m = this.matrix();
    const r = { x0: Math.max(0, Math.floor(rect.x0)), y0: Math.max(0, Math.floor(rect.y0)), x1: Math.min(W, Math.ceil(rect.x1)), y1: Math.min(H, Math.ceil(rect.y1)) };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
    const saved = this.clipRect; this.clipRect = r; const v = this.visibleDocRect(m, r);
    const noStroke: RenderOptions = { ...opts, activeStroke: null, extraStrokes: [] };
    for (const [g, from, to, base] of [[sc.below, 0, plan.index, true], [sc.above, plan.index + 1, n, false]] as const) {
      if (!base && !plan.aboveCached) continue;
      const c = g.getContext("2d") as CanvasRenderingContext2D;
      c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalAlpha = 1; c.globalCompositeOperation = "source-over";
      c.beginPath(); c.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); c.clip(); c.clearRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0);
      c.setTransform(m);
      if (base) this.paintBase(c, doc, v);
      c.imageSmoothingEnabled = this.view.zoom < 4; c.imageSmoothingQuality = "high";
      c.beginPath(); c.rect(0, 0, doc.width, doc.height); c.clip();
      this.paintLayers(c, doc, noStroke, from, to, v);
      c.restore();
    }
    this.clipRect = saved;
  }
  /** Make the cache cells under `clip` valid (one pass over the box of missing cells). */
  private prepareStrokeCache(doc: Doc, opts: RenderOptions, plan: { index: number; aboveCached: boolean; key: string }, W: number, H: number): void {
    const CELL = Renderer.CELL; const sc = this.ensureCache(plan, W, H); const gw = sc.gw, gh = sc.valid.length / gw;
    const c = this.clipRect;
    const cx0 = Math.max(0, Math.floor(c.x0 / CELL)), cy0 = Math.max(0, Math.floor(c.y0 / CELL)), cx1 = Math.min(gw - 1, Math.floor((c.x1 - 1) / CELL)), cy1 = Math.min(gh - 1, Math.floor((c.y1 - 1) / CELL));
    // per-call overhead dominates small drawImage calls, so one slightly larger pass beats one per row
    let mx0 = Infinity, my0 = Infinity, mx1 = -1, my1 = -1;
    for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) if (!sc.valid[cy * gw + cx]) { if (cx < mx0) mx0 = cx; if (cx > mx1) mx1 = cx; if (cy < my0) my0 = cy; if (cy > my1) my1 = cy; }
    if (mx1 < 0) return;
    this.paintCache(doc, opts, plan, { x0: mx0 * CELL, y0: my0 * CELL, x1: (mx1 + 1) * CELL, y1: (my1 + 1) * CELL });
    for (let cy = my0; cy <= my1; cy++) sc.valid.fill(1, cy * gw + mx0, cy * gw + mx1 + 1);
  }
  /**
   * Idle-time warm-up: fill missing cache cells for the active layer within `budgetMs`, so the first
   * stroke after a pan, zoom or layer switch already finds the layers above and below composited.
   * Returns true while work remains.
   */
  /** set by the pen-up invalidation: the next frame repaints through the stroke cache */
  strokeEndFrame = false;
  /** Idle: flatten projection tiles in view that edits made stale. Returns true while work remains. */
  private warmProjection(doc: Doc, budgetMs: number): boolean {
    const k = this.projectionPrefix(doc); if (!k || !this.proj) return false;
    const scale = this.view.zoom * this.dpr;
    const level = this.projLevel(scale);
    const tiles = this.proj.levels.get(level); if (!tiles) return false; // nothing drawn at this level yet
    const inv = this.matrix().inverse(); const W = this.canvas.width, H = this.canvas.height;
    let vx0 = Infinity, vy0 = Infinity, vx1 = -Infinity, vy1 = -Infinity;
    for (const [px, py] of [[0, 0], [W, 0], [0, H], [W, H]] as const) { const p = inv.transformPoint(new DOMPoint(px, py)); vx0 = Math.min(vx0, p.x); vy0 = Math.min(vy0, p.y); vx1 = Math.max(vx1, p.x); vy1 = Math.max(vy1, p.y); }
    const tx0 = Math.max(0, Math.floor(vx0 / TILE)), ty0 = Math.max(0, Math.floor(vy0 / TILE));
    const tx1 = Math.min(Math.ceil(doc.width / TILE) - 1, Math.floor(vx1 / TILE)), ty1 = Math.min(Math.ceil(doc.height / TILE) - 1, Math.floor(vy1 / TILE));
    const t0 = performance.now();
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const key = `${tx},${ty}`; if (tiles.has(key)) continue;
      if (performance.now() - t0 > budgetMs) return true;
      tiles.set(key, this.composeProjectionTile(doc, k, tx, ty, level));
    }
    return false;
  }
  warmStrokeCache(doc: Doc, opts: RenderOptions, budgetMs = 4): boolean {
    if (this.mode !== "canvas2d" || this.needsRender) return false;
    if (this.warmProjection(doc, budgetMs)) return true;
    const plan = this.strokePlan(doc, { ...opts, activeStroke: null }); if (!plan) { this.sc = null; return false; }
    const W = this.canvas.width, H = this.canvas.height; const CELL = Renderer.CELL;
    const sc = this.ensureCache(plan, W, H); const gw = sc.gw, gh = sc.valid.length / gw;
    const t0 = performance.now();
    let i = sc.valid.indexOf(0);
    while (i >= 0 && performance.now() - t0 < budgetMs) {
      // a band of up to 16x2 cells per pass
      const cy = Math.floor(i / gw), cx = i % gw; const cx1 = Math.min(gw - 1, cx + 15), cy1 = Math.min(gh - 1, cy + 1);
      this.paintCache(doc, opts, plan, { x0: cx * CELL, y0: cy * CELL, x1: (cx1 + 1) * CELL, y1: (cy1 + 1) * CELL });
      for (let y = cy; y <= cy1; y++) sc.valid.fill(1, y * gw + cx, y * gw + cx1 + 1);
      i = sc.valid.indexOf(0, i);
    }
    return i >= 0;
  }
  /** Drop the stroke cache; the canvases stay pooled. */
  endStroke(): void { this.sc = null; }

  /**
   * Clipping mask: the layer is drawn into a screen-space scratch, multiplied by the base
   * layer's alpha (destination-in), then composited with the layer's own blend and opacity.
   */
  private drawClipped(ctx: CanvasRenderingContext2D, doc: Doc, layer: Layer, base: Layer, vx0: number, vy0: number, vx1: number, vy1: number, opts: RenderOptions, alphaMul: number): void {
    if (!this.scratch2) { this.scratch2 = document.createElement("canvas"); this.sctx2 = this.scratch2.getContext("2d") as CanvasRenderingContext2D; }
    const W = ctx.canvas.width, H = ctx.canvas.height;
    if (this.scratch2.width !== W || this.scratch2.height !== H) { this.scratch2.width = W; this.scratch2.height = H; }
    const s = this.sctx2!; s.globalCompositeOperation = "source-over"; s.globalAlpha = 1; this.clearScratch(s); this.clipScratch(s);
    s.setTransform(ctx.getTransform()); s.imageSmoothingEnabled = ctx.imageSmoothingEnabled; s.imageSmoothingQuality = "high";
    this.drawLayer(s, doc, layer, vx0, vy0, vx1, vy1, opts, 1, true); s.restore();
    // base alpha assembled on its own canvas first: destination-in per tile would keep only the last tile
    if (!this.scratch3) { this.scratch3 = document.createElement("canvas"); this.sctx3 = this.scratch3.getContext("2d") as CanvasRenderingContext2D; }
    if (this.scratch3.width !== W || this.scratch3.height !== H) { this.scratch3.width = W; this.scratch3.height = H; }
    const b3 = this.sctx3!; b3.globalCompositeOperation = "source-over"; this.clearScratch(b3); this.clipScratch(b3); b3.setTransform(ctx.getTransform());
    const t = base.transform; b3.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    this.drawTiles(b3, base.tiles);
    if (base.kind === "vector") this.drawPaths(b3, base);
    b3.restore();
    s.setTransform(1, 0, 0, 1, 0, 0); s.globalCompositeOperation = "destination-in"; this.blitScratch(s, this.scratch3); s.globalCompositeOperation = "source-over";
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = layer.opacity * alphaMul; ctx.globalCompositeOperation = BLEND_TO_CANVAS[layer.blend];
    this.blitScratch(ctx, this.scratch2); ctx.restore();
  }
  private scratch2: HTMLCanvasElement | null = null; private sctx2: CanvasRenderingContext2D | null = null;
  private scratch3: HTMLCanvasElement | null = null; private sctx3: CanvasRenderingContext2D | null = null;

  private drawLayer(ctx: CanvasRenderingContext2D, doc: Doc, layer: Layer, vx0: number, vy0: number, vx1: number, vy1: number, opts: RenderOptions, alphaMul: number, raw = false): void {
    if (!layer.visible || layer.opacity <= 0) return;
    ctx.save();
    ctx.globalAlpha = raw ? 1 : layer.opacity * alphaMul;
    ctx.globalCompositeOperation = raw ? "source-over" : BLEND_TO_CANVAS[layer.blend];
    const panel = layer.panelMask !== null ? doc.panels.find((p) => p.id === layer.panelMask) : null;
    if (panel) { ctx.beginPath(); panel.polygon.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.clip(); }
    const kf = layer.keys.length ? layerAt(layer.keys, doc.currentFrame) : null;
    const t = kf ? keyMatrix(kf) : layer.transform; ctx.transform(t[0], t[1], t[2], t[3], t[4], t[5]);
    if (kf && !raw) ctx.globalAlpha *= kf.opacity;
    if (layer.kind === "npr") {
      const src = opts.nprCanvases.get(layer.id);
      if (src) ctx.drawImage(src, 0, 0, doc.width, doc.height);
    } else if (layer.kind === "tone") {
      this.drawTone(ctx, doc, layer, vx0, vy0, vx1, vy1, opts.toneInk);
    } else {
      const st = opts.activeStroke && opts.activeStroke.layerId === layer.id ? opts.activeStroke : null;
      if (st && st.kind !== "smudge" && st.kind !== "blur") this.drawLayerWithStroke(ctx, layer, st, vx0, vy0, vx1, vy1);
      else {
        this.drawTiles(ctx, layer.tiles);
      }
      if (layer.kind === "vector") this.drawPaths(ctx, layer);
    }
    ctx.restore();
  }

  /** Layer + in-progress stroke buffer composited in screen space (stroke opacity, blend, erase preview). */
  private drawLayerWithStroke(ctx: CanvasRenderingContext2D, layer: Layer, st: ActiveStroke, vx0: number, vy0: number, vx1: number, vy1: number): void {
    const strokes = [st, ...(this.extraStrokes ?? []).filter((x) => x.layerId === layer.id)];
    // Common case (opaque normal layer, painting not erasing): layer and stroke can go straight onto the
    // target, which is already clipped. Skips clearing and blitting a scratch canvas every frame.
    if (ctx.globalCompositeOperation === "source-over" && ctx.globalAlpha >= 0.999 && strokes.every((k) => k.kind !== "eraser" && k.blend !== "multiply")) {
      this.drawTiles(ctx, layer.tiles);
      for (const k of strokes) { ctx.globalAlpha = k.opacity; this.drawTiles(ctx, k.buffer.tiles); }
      ctx.globalAlpha = 1;
      return;
    }
    const s = this.sctx;
    s.globalCompositeOperation = "source-over"; s.globalAlpha = 1; this.clearScratch(s); this.clipScratch(s);
    s.setTransform(ctx.getTransform()); s.imageSmoothingEnabled = ctx.imageSmoothingEnabled; s.imageSmoothingQuality = "high";
    this.drawTiles(s, layer.tiles);
    for (const stk of strokes) {
      s.globalAlpha = stk.opacity;
      s.globalCompositeOperation = stk.kind === "eraser" ? "destination-out" : stk.blend === "multiply" ? "multiply" : "source-over";
      this.drawTiles(s, stk.buffer.tiles);
    }
    s.globalAlpha = 1; s.globalCompositeOperation = "source-over"; s.restore();
    const saved = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0); this.blitScratch(ctx, this.scratch); ctx.setTransform(saved);
  }

  /** Tone layer: painted alpha becomes the mask; pattern is rendered in screen space. */
  private toneFieldCache: { key: string; canvas: HTMLCanvasElement | OffscreenCanvas } | null = null;
  private drawTone(ctx: CanvasRenderingContext2D, doc: Doc, layer: Layer, vx0: number, vy0: number, vx1: number, vy1: number, ink: string): void {
    const t = layer.tone; const field = t.shape === "noise" || t.shape === "sand" || t.gradient;
    const pat = field ? null : tonePattern(t, doc.dpi, this.view.zoom * this.dpr, hexToRgb(ink));
    const s = this.sctx; const W = this.scratch.width, H = this.scratch.height; const cr = this.clipRect;
    this.clearScratch(s); s.globalCompositeOperation = "source-over"; s.globalAlpha = 1; this.clipScratch(s);
    s.setTransform(ctx.getTransform());
    s.imageSmoothingEnabled = ctx.imageSmoothingEnabled;
    this.drawTiles(s, layer.tiles);
    // pattern locked to screen pixels (rotation of the view rotates the screen; the
    // tone angle is added by the generator, so the dots stay crisp)
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.globalCompositeOperation = "source-in";
    if (field) {
      const m = ctx.getTransform(); const inv = m.inverse();
      const key = `${JSON.stringify(t)}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${W}x${H}|${ink}`;
      if (!this.toneFieldCache || this.toneFieldCache.key !== key) this.toneFieldCache = { key, canvas: toneField(t, doc.dpi, this.view.zoom * this.dpr, W, H, (sx, sy) => { const p = inv.transformPoint(new DOMPoint(sx, sy)); return { x: p.x, y: p.y }; }, hexToRgb(ink)) };
      s.drawImage(this.toneFieldCache.canvas as CanvasImageSource, 0, 0);
      s.globalCompositeOperation = "source-over"; s.restore();
      const saved2 = ctx.getTransform(); ctx.setTransform(1, 0, 0, 1, 0, 0); this.blitScratch(ctx, this.scratch); ctx.setTransform(saved2);
      return;
    }
    const p = s.createPattern(pat!.canvas as CanvasImageSource, "repeat");
    if (p) { s.fillStyle = p; s.fillRect(cr.x0, cr.y0, cr.x1 - cr.x0, cr.y1 - cr.y0); }
    s.globalCompositeOperation = "source-over"; s.restore();
    const saved = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.blitScratch(ctx, this.scratch);
    ctx.setTransform(saved);
  }

  private drawPaths(ctx: CanvasRenderingContext2D, layer: Layer): void {
    for (const path of layer.paths) drawPathTo(ctx, path);
  }

  private onion(ctx: CanvasRenderingContext2D, doc: Doc, vx0: number, vy0: number, vx1: number, vy1: number): void {
    const cur = doc.drawing;
    const ghosts: Array<{ frame: Frame; t: number; tint: string }> = [];
    const seen = new Set<number>([cur.id]);
    for (let k = 1; k <= doc.onionPrev; k++) {
      const f = doc.drawingAt(doc.currentFrame - k);
      if (f && !seen.has(f.id)) { seen.add(f.id); ghosts.push({ frame: f, t: (k - 1) / Math.max(1, doc.onionPrev), tint: "#c0392b" }); }
    }
    for (let k = 1; k <= doc.onionNext; k++) {
      const f = doc.drawingAt(doc.currentFrame + k);
      if (f && !seen.has(f.id)) { seen.add(f.id); ghosts.push({ frame: f, t: (k - 1) / Math.max(1, doc.onionNext), tint: "#2e86c1" }); }
    }
    for (const g of ghosts) {
      const a = doc.onionCurve(g.t);
      const s = this.sctx; const W = this.scratch.width, H = this.scratch.height;
      this.clearScratch(s);
      s.setTransform(ctx.getTransform());
      for (const layer of g.frame.layers) {
        if (!layer.visible || layer.kind === "tone" || layer.kind === "npr") continue;
        this.drawTiles(s, layer.tiles);
        if (layer.kind === "vector") {
          // interpolated ghost: tween toward the current drawing's path with the same id
          const curPaths = new Map<number, (typeof layer.paths)[number]>();
          for (const cl of cur.layers) if (cl.kind === "vector") for (const pth of cl.paths) curPaths.set(pth.id, pth);
          for (const pth of layer.paths) {
            const target = curPaths.get(pth.id);
            const f = target ? tween(pth, target, g.t === 0 ? 0.5 : 0.5 * (1 - g.t)) : pth;
            drawPathTo(s as unknown as CanvasRenderingContext2D, f);
          }
        }
      }
      s.setTransform(1, 0, 0, 1, 0, 0);
      s.globalCompositeOperation = "source-in"; s.fillStyle = g.tint; s.fillRect(0, 0, W, H);
      s.globalCompositeOperation = "source-over";
      const saved = ctx.getTransform();
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = a; this.blitScratch(ctx, this.scratch); ctx.globalAlpha = 1;
      ctx.setTransform(saved);
    }
  }

  /** soft drop shadow around the page (drawn before the paper; the page area itself is cleared) */
  /**
   * The drop shadow is rendered once per view into its own canvas and blitted. Drawing it live cost a
   * 40 px blur every frame, and when the dirty rect missed the page rectangle the browser culled the
   * shape and its shadow with it, leaving shadow-less strips under small repaints.
   */
  private shadowCache: { key: string; canvas: HTMLCanvasElement; x: number; y: number } | null = null;
  private drawPageShadow(ctx: CanvasRenderingContext2D, doc: Doc): void {
    const m = ctx.getTransform(); const W = this.canvas.width, H = this.canvas.height;
    const key = `${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${doc.width}x${doc.height}|${W}x${H}|${this.dpr}`;
    if (!this.shadowCache || this.shadowCache.key !== key) {
      const pad = Math.ceil(70 * this.dpr);
      const pts = [[0, 0], [doc.width, 0], [0, doc.height], [doc.width, doc.height]].map(([x, y]) => ({ x: m.a * x! + m.c * y! + m.e, y: m.b * x! + m.d * y! + m.f }));
      const x0 = Math.max(-pad, Math.floor(Math.min(...pts.map((p) => p.x))) - pad), y0 = Math.max(-pad, Math.floor(Math.min(...pts.map((p) => p.y))) - pad);
      const x1 = Math.min(W + pad, Math.ceil(Math.max(...pts.map((p) => p.x))) + pad), y1 = Math.min(H + pad, Math.ceil(Math.max(...pts.map((p) => p.y))) + pad);
      const cv = this.shadowCache?.canvas ?? document.createElement("canvas");
      cv.width = Math.max(1, x1 - x0); cv.height = Math.max(1, y1 - y0);
      const g = cv.getContext("2d") as CanvasRenderingContext2D;
      g.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
      // shadowBlur / offsets are in device pixels (not transformed), so no zoom compensation
      g.save(); g.shadowColor = "rgba(0,0,0,0.75)"; g.shadowBlur = 40 * this.dpr; g.shadowOffsetY = 10 * this.dpr;
      g.fillStyle = "rgba(0,0,0,0.5)"; g.fillRect(0, 0, doc.width, doc.height); g.restore();
      g.clearRect(0, 0, doc.width, doc.height);
      this.shadowCache = { key, canvas: cv, x: x0, y: y0 };
    }
    const sc = this.shadowCache, c = this.clipRect;
    const x0 = Math.max(c.x0, sc.x), y0 = Math.max(c.y0, sc.y), x1 = Math.min(c.x1, sc.x + sc.canvas.width), y1 = Math.min(c.y1, sc.y + sc.canvas.height);
    if (x1 <= x0 || y1 <= y0) return;
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(sc.canvas, x0 - sc.x, y0 - sc.y, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0); ctx.restore();
  }

  /** camera field guide at the current frame: frame rectangle, centre cross, 10% action-safe inset */
  private drawCamera(ctx: CanvasRenderingContext2D, doc: Doc): void {
    const k = cameraAt(doc.camera, doc.currentFrame); if (!k) return;
    const r = cameraRect(k, doc.width, doc.height); const lw = 1 / (this.view.zoom * this.dpr);
    ctx.save(); ctx.translate(r.cx, r.cy); ctx.rotate(r.rot); ctx.lineWidth = lw * 1.5; ctx.strokeStyle = "rgba(240,160,80,0.95)";
    ctx.strokeRect(-r.w / 2, -r.h / 2, r.w, r.h); ctx.setLineDash([6 * lw, 4 * lw]); ctx.strokeStyle = "rgba(240,160,80,0.5)"; ctx.strokeRect(-r.w * 0.45, -r.h * 0.45, r.w * 0.9, r.h * 0.9);
    ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(-r.w * 0.04, 0); ctx.lineTo(r.w * 0.04, 0); ctx.moveTo(0, -r.h * 0.04); ctx.lineTo(0, r.h * 0.04); ctx.stroke();
    ctx.restore();
  }

  /** print guides: bleed (outer, red) and safe area (inner, cyan), 1 screen px */
  private drawGuides(ctx: CanvasRenderingContext2D, doc: Doc, g: { bleed: number; safe: number }): void {
    const lw = 1 / (this.view.zoom * this.dpr);
    ctx.save(); ctx.lineWidth = lw; ctx.setLineDash([6 * lw, 4 * lw]);
    if (g.bleed > 0) { ctx.strokeStyle = "rgba(220,60,60,0.8)"; ctx.strokeRect(g.bleed, g.bleed, doc.width - g.bleed * 2, doc.height - g.bleed * 2); }
    if (g.safe > 0) { ctx.strokeStyle = "rgba(60,180,220,0.8)"; ctx.strokeRect(g.safe, g.safe, doc.width - g.safe * 2, doc.height - g.safe * 2); }
    ctx.setLineDash([]); ctx.restore();
  }

  private drawPanels(ctx: CanvasRenderingContext2D, panels: Panel[]): void {
    const px = this.dpr / (this.view.zoom * this.dpr); // 1 screen px in DU
    for (const p of panels) {
      ctx.beginPath(); p.polygon.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
      ctx.lineWidth = Math.max(px, 3); ctx.strokeStyle = "#111"; ctx.stroke();
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, doc: Doc): void {
    const step = doc.dpi / 2; // half-inch
    ctx.lineWidth = 1 / (this.view.zoom * this.dpr); ctx.strokeStyle = "rgba(0,0,0,0.12)";
    ctx.beginPath();
    for (let x = 0; x <= doc.width; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, doc.height); }
    for (let y = 0; y <= doc.height; y += step) { ctx.moveTo(0, y); ctx.lineTo(doc.width, y); }
    ctx.stroke();
  }

  /** Flatten the current drawing to an RGBA canvas at document resolution (export / decal source). */
  flatten(doc: Doc, scale = 1, layerIds?: Set<number>): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(doc.width * scale)); c.height = Math.max(1, Math.round(doc.height * scale));
    const ctx = c.getContext("2d") as CanvasRenderingContext2D;
    ctx.scale(scale, scale);
    for (const layer of doc.drawing.layers) {
      if (layerIds && !layerIds.has(layer.id)) continue;
      if (layer.kind === "npr" || layer.kind === "group") continue;
      const eff = effectiveLayer(doc.drawing.layers, layer); if (!eff.visible) continue;
      const base = layerIds ? null : clipBase(doc.drawing.layers, layer);
      const kf = layer.keys.length ? layerAt(layer.keys, doc.currentFrame) : null;
      const drawInto = (g: CanvasRenderingContext2D, l: Layer) => { g.save(); const lk = l.keys.length ? layerAt(l.keys, doc.currentFrame) : null; const t = lk ? keyMatrix(lk) : l.transform; g.transform(t[0], t[1], t[2], t[3], t[4], t[5]); for (const tile of l.tiles.values()) if (tile.canvas) g.drawImage(tile.canvas as CanvasImageSource, tile.x * TILE, tile.y * TILE); if (l.kind === "vector") this.drawPaths(g, l); g.restore(); };
      ctx.save(); ctx.globalAlpha = eff.opacity * (kf ? kf.opacity : 1); ctx.globalCompositeOperation = BLEND_TO_CANVAS[layer.blend];
      if (base) {
        const tmp = document.createElement("canvas"); tmp.width = c.width; tmp.height = c.height; const g = tmp.getContext("2d")!; g.scale(scale, scale);
        drawInto(g, layer);
        const bt = document.createElement("canvas"); bt.width = c.width; bt.height = c.height; const bg = bt.getContext("2d")!; bg.scale(scale, scale); drawInto(bg, base);
        g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "destination-in"; g.drawImage(bt, 0, 0);
        ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(tmp, 0, 0); ctx.setTransform(scale, 0, 0, scale, 0, 0);
      } else drawInto(ctx, layer);
      ctx.restore();
    }
    if (!layerIds) for (const b of doc.balloons) drawBalloon(ctx, b);
    ctx.setTransform(1, 0, 0, 1, 0, 0); // callers draw on this context in pixel space
    return c;
  }
}
