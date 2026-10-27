/**
 * Document model (Phase 1.2): tiled raster layers, vector layers, 3D layers,
 * panel masks, and the animation timeline, all in document units (DU).
 *
 * Tiles are 256x256 OffscreenCanvas (or HTMLCanvas fallback) created lazily
 * and tracked in a Map keyed by "x,y". Untouched regions cost nothing, which is
 * what lets a multi-gigapixel page exist without allocating it.
 */

export const TILE = 256;

export type BlendMode = "normal" | "multiply" | "screen" | "overlay" | "darken" | "lighten" | "add";

export const BLEND_TO_CANVAS: Record<BlendMode, GlobalCompositeOperation> = {
  normal: "source-over",
  multiply: "multiply",
  screen: "screen",
  overlay: "overlay",
  darken: "darken",
  lighten: "lighten",
  add: "lighter",
};

export type LayerKind = "raster" | "vector" | "tone" | "npr" | "group";

export interface Tile {
  x: number;
  y: number;
  /** null while the tile is demoted to the WARM/COLD cache tiers (see tile-cache.ts) */
  canvas: OffscreenCanvas | HTMLCanvasElement | null;
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  generation: number;
}

/** Hook the tile cache registers to learn about new tiles. */
export const tileHooks: { created: ((tile: Tile, layer: Layer) => void) | null } = { created: null };

/**
 * Canvases that get drawn onto other canvases on the main thread are plain <canvas> elements.
 * Chromium snapshots an OffscreenCanvas source on every drawImage; with tiles and stroke buffers
 * changing every frame that cost ~0.4 ms per call and made a 0.03 Mpx repaint take 15 ms
 * (measured headless: render p50 15.1 ms with OffscreenCanvas tiles, 1.0 ms with <canvas>).
 * Workers have no document and keep OffscreenCanvas.
 */
export function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof document === "undefined" && typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

export function ctx2d(c: OffscreenCanvas | HTMLCanvasElement): OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D {
  const ctx = c.getContext("2d", { willReadFrequently: false }) as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("2d context unavailable");
  return ctx;
}

let nextId = 1;
export const newId = (): number => nextId++;

export interface VectorPath {
  id: number;
  points: Array<{ x: number; y: number; p: number }>; // DU + pressure
  width: number;
  color: string;
  closed: boolean;
}

export interface ToneSettings {
  /** lines per inch at 100% zoom; typical manga tones: 27.5, 32.5, 42.5, 60 */
  lpi: number;
  /** dot coverage 0..1 (ink density) */
  density: number;
  /** screen angle degrees */
  angle: number;
  shape: "dot" | "line" | "cross" | "noise" | "sand";
  /** gradient tone: density runs from `density` at (gx0,gy0) to `density2` at (gx1,gy1) in DU; null = flat */
  gradient: { x0: number; y0: number; x1: number; y1: number; density2: number } | null;
}

export interface Panel {
  id: number;
  /** polygon in DU, clockwise */
  polygon: Array<{ x: number; y: number }>;
  gutter: number; // DU
}

export class Layer {
  readonly id = newId();
  name: string;
  kind: LayerKind;
  visible = true;
  opacity = 1;
  blend: BlendMode = "normal";
  locked = false;
  /** affine transform T_L: [a b c d e f] */
  transform: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];
  readonly tiles = new Map<string, Tile>();
  paths: VectorPath[] = [];
  tone: ToneSettings = { lpi: 42.5, density: 0.3, angle: 45, shape: "dot", gradient: null };
  /** panel id whose mask clips this layer, or null */
  panelMask: number | null = null;
  /** clipping mask: this layer only shows where the nearest non-clipped layer below has pixels */
  clipBelow = false;
  /** group layer id this layer sits in, or null (groups multiply visibility and opacity) */
  parent: number | null = null;
  /** group only: children hidden in the panel */
  collapsed = false;
  /** motion keys (tween.ts); when present they drive transform and opacity per frame */
  keys: import("./tween.js").LayerKey[] = [];
  /** scratch layers (stroke buffers, previews) are never cached */
  transient = false;
  /** for animation: which drawing id this layer shows per frame (frame → drawingId) */
  generation = 0;

  constructor(name: string, kind: LayerKind = "raster") {
    this.name = name;
    this.kind = kind;
  }

  tileKey(tx: number, ty: number): string {
    return `${tx},${ty}`;
  }

  getTile(tx: number, ty: number, create: boolean): Tile | null {
    const key = this.tileKey(tx, ty);
    let t = this.tiles.get(key);
    if (!t && create) {
      const canvas = makeCanvas(TILE, TILE);
      t = { x: tx, y: ty, canvas, ctx: ctx2d(canvas), generation: 0 };
      this.tiles.set(key, t);
      if (!this.transient) tileHooks.created?.(t, this);
    }
    return t ?? null;
  }

  /** Iterates tiles touched by a DU rectangle. */
  *tilesIn(x0: number, y0: number, x1: number, y1: number, create: boolean): Generator<Tile> {
    const tx0 = Math.floor(x0 / TILE), ty0 = Math.floor(y0 / TILE);
    const tx1 = Math.floor(x1 / TILE), ty1 = Math.floor(y1 / TILE);
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const t = this.getTile(tx, ty, create);
        if (t) yield t;
      }
    }
  }

  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.tiles.size === 0) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of this.tiles.values()) {
      x0 = Math.min(x0, t.x * TILE); y0 = Math.min(y0, t.y * TILE);
      x1 = Math.max(x1, (t.x + 1) * TILE); y1 = Math.max(y1, (t.y + 1) * TILE);
    }
    return { x0, y0, x1, y1 };
  }

  clear(): void {
    this.tiles.clear();
    this.paths = [];
    this.generation++;
  }

  /** Snapshot of tiles intersecting a rect, for undo. */
  snapshot(x0: number, y0: number, x1: number, y1: number): TileSnapshot {
    const entries: TileSnapshot["entries"] = [];
    for (const t of this.tilesIn(x0, y0, x1, y1, false)) {
      if (!t.ctx) continue;
      entries.push({ x: t.x, y: t.y, data: (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE) });
    }
    return { layerId: this.id, entries, rect: { x0, y0, x1, y1 } };
  }

  /** Put back exactly the tiles in the snapshot; tiles not listed are untouched. */
  restore(s: TileSnapshot): void {
    for (const e of s.entries) {
      if (e.data === null) { this.tiles.delete(this.tileKey(e.x, e.y)); continue; }
      const t = this.getTile(e.x, e.y, true) as Tile;
      if (!t.ctx) continue;
      (t.ctx as CanvasRenderingContext2D).putImageData(e.data, 0, 0);
      t.generation++;
    }
    this.generation++;
  }
}

export interface TileSnapshot {
  layerId: number;
  /** data null = the tile did not exist in that state */
  entries: Array<{ x: number; y: number; data: ImageData | null }>;
  rect: { x0: number; y0: number; x1: number; y1: number };
}

/** One animation "drawing": a set of layers that make up a frame's cel. */
export class Frame {
  readonly id = newId();
  layers: Layer[] = [];
  /** exposure sheet metadata */
  note = "";
  viseme: "rest" | "A" | "E" | "O" | "M" | "F" | "L" = "rest";
  dialog = "";
  constructor(public label: string) {}
}

export class Doc {
  name = "Untitled";
  /** page size in DU (A4 at 600 dpi: 4960 x 7016) */
  width = 2480;
  height = 3508;
  dpi = 300;
  frames: Frame[] = [];
  /** frame index → drawing index (exposure). Holds reuse the previous drawing. */
  exposure: number[] = [];
  fps: 12 | 24 | 30 = 24;
  panels: Panel[] = [];
  /** word balloons and lettering (manga.ts), drawn above the raster layers */
  balloons: import("./manga.js").Balloon[] = [];
  /** production mode: manga pages or 2D animation */
  mode: "manga" | "anime" = "manga";
  /** camera keys (tween.ts): frames the export and the field guide */
  camera: import("./tween.js").CameraKey[] = [];
  showCamera = true;
  /** background surface behind the paper (surface.ts) */
  surface: import("./surface.js").Surface = { kind: "color", color: "#0f0f0f", color2: "#1c1c1c", angle: 180, image: null, imageMode: "cover", imageTint: 0.25, texture: "walnut", shadow: true, inExport: false };
  currentFrame = 0;
  activeLayerId: number;
  onionPrev = 2;
  onionNext = 1;
  onionEnabled = false;
  /** opacity curve for onion ghosts: t in 0..1 → alpha */
  onionCurve: (t: number) => number = (t) => 0.45 * (1 - t) * (1 - t);

  constructor() {
    const f = new Frame("1");
    const ink = new Layer("Ink");
    const paper = new Layer("Paper");
    f.layers = [paper, ink];
    this.frames = [f];
    this.exposure = Array.from({ length: 24 }, () => 0);
    this.activeLayerId = ink.id;
  }

  get drawing(): Frame {
    const idx = this.exposure[this.currentFrame] ?? 0;
    return this.frames[idx] ?? (this.frames[0] as Frame);
  }

  drawingAt(frame: number): Frame | null {
    const idx = this.exposure[frame];
    if (idx === undefined) return null;
    return this.frames[idx] ?? null;
  }

  get activeLayer(): Layer {
    const l = this.drawing.layers.find((x) => x.id === this.activeLayerId);
    return l ?? (this.drawing.layers[this.drawing.layers.length - 1] as Layer);
  }

  findLayer(id: number): Layer | null {
    for (const f of this.frames) for (const l of f.layers) if (l.id === id) return l;
    return null;
  }

  addLayer(kind: LayerKind = "raster"): Layer {
    const names: Record<LayerKind, string> = { raster: "Layer", vector: "Vector", tone: "Tone", npr: "3D Cel", group: "Group" };
    const l = new Layer(`${names[kind]} ${this.drawing.layers.length + 1}`, kind);
    this.drawing.layers.push(l);
    this.activeLayerId = l.id;
    return l;
  }

  removeLayer(id: number): void {
    const d = this.drawing;
    if (d.layers.length <= 1) return;
    const victim = d.layers.find((l) => l.id === id);
    if (victim && victim.kind === "group") for (const l of d.layers) if (l.parent === id) l.parent = victim.parent; // un-group children
    d.layers = d.layers.filter((l) => l.id !== id);
    if (this.activeLayerId === id) this.activeLayerId = (d.layers[d.layers.length - 1] as Layer).id;
  }

  isKey(frame: number): boolean {
    return frame === 0 || this.exposure[frame] !== this.exposure[frame - 1];
  }

  /**
   * Insert a new drawing. If the current frame is already a key, the new
   * drawing starts on the next frame (extending the sheet when needed);
   * otherwise it splits the hold at the current frame. Either way the new
   * drawing covers the rest of the run it lands in.
   */
  newDrawingAtCurrent(): Frame {
    let start = this.currentFrame;
    if (this.isKey(start)) {
      start += 1;
      if (start >= this.exposure.length) this.setFrameCount(start + 1);
    }
    const f = new Frame(String(this.frames.length + 1));
    f.layers = this.drawing.layers.map((src) => {
      const l = new Layer(src.name, src.kind);
      l.blend = src.blend; l.opacity = src.opacity; l.tone = { ...src.tone }; l.panelMask = src.panelMask;
      // vector paths carry over with the same ids so consecutive keys can be tweened
      l.paths = src.paths.map((pth) => ({ ...pth, points: pth.points.map((q) => ({ ...q })) }));
      return l;
    });
    this.frames.push(f);
    const idx = this.frames.length - 1;
    const prev = this.exposure[start] ?? 0;
    for (let i = start; i < this.exposure.length && this.exposure[i] === prev; i++) this.exposure[i] = idx;
    this.currentFrame = start;
    this.activeLayerId = (f.layers[f.layers.length - 1] as Layer).id;
    return f;
  }

  setFrameCount(n: number): void {
    const last = this.exposure[this.exposure.length - 1] ?? 0;
    while (this.exposure.length < n) this.exposure.push(last);
    this.exposure.length = n;
    if (this.currentFrame >= n) this.currentFrame = n - 1;
  }
}


/** Visibility and opacity after walking the group chain. */
export function effectiveLayer(layers: Layer[], layer: Layer): { visible: boolean; opacity: number } {
  let visible = layer.visible, opacity = layer.opacity; let p = layer.parent; let guard = 0;
  while (p !== null && guard++ < 16) { const g = layers.find((l) => l.id === p); if (!g) break; visible = visible && g.visible; opacity *= g.opacity; p = g.parent; }
  return { visible, opacity };
}

/** The layer a clipped layer clips to: nearest layer below with the same parent that is not itself clipped. */
export function clipBase(layers: Layer[], layer: Layer): Layer | null {
  if (!layer.clipBelow) return null;
  const i = layers.indexOf(layer);
  for (let k = i - 1; k >= 0; k--) { const b = layers[k]!; if (b.parent !== layer.parent || b.kind === "group") continue; if (!b.clipBelow) return b; }
  return null;
}
