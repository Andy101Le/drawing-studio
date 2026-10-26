/**
 * Selections. A selection is a binary mask at document resolution kept as a canvas
 * (alpha 255 = selected) plus its bounds. Binary alpha makes every clip idempotent:
 * applying the mask twice to a stroke buffer changes nothing, so the live stroke and
 * the committed stroke can both be clipped without edge darkening.
 *
 * Modes follow the desktop convention: replace, add (Shift), subtract (Alt),
 * intersect (Shift+Alt). Marching ants are rendered from the mask in screen space by
 * the viewport overlay (see ui/ants in main.ts), so any mask shape gets an outline.
 */
import { TILE, type Layer } from "./document.js";

export type SelMode = "replace" | "add" | "subtract" | "intersect";
export interface Bounds { x0: number; y0: number; x1: number; y1: number }

export class Selection {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  bounds: Bounds;
  constructor(readonly width: number, readonly height: number) {
    this.canvas = document.createElement("canvas"); this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true })!;
    this.bounds = { x0: width, y0: height, x1: -1, y1: -1 };
  }
  get empty(): boolean { return this.bounds.x1 < this.bounds.x0; }
  clone(): Selection { const s = new Selection(this.width, this.height); s.ctx.drawImage(this.canvas, 0, 0); s.bounds = { ...this.bounds }; return s; }

  /** recompute bounds from alpha (after combine ops) and snap alpha to 0/255 */
  finalize(): this {
    const w = this.width, h = this.height;
    const img = this.ctx.getImageData(0, 0, w, h); const d = img.data;
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let i = 3, p = 0; i < d.length; i += 4, p++) {
      if (d[i]! >= 128) { d[i] = 255; const x = p % w, y = (p - x) / w; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      else d[i] = 0;
    }
    this.ctx.putImageData(img, 0, 0);
    this.bounds = { x0, y0, x1, y1 };
    return this;
  }

  static rect(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Selection {
    const s = new Selection(w, h);
    const ax = Math.max(0, Math.round(Math.min(x0, x1))), ay = Math.max(0, Math.round(Math.min(y0, y1)));
    const bx = Math.min(w, Math.round(Math.max(x0, x1))), by = Math.min(h, Math.round(Math.max(y0, y1)));
    if (bx <= ax || by <= ay) return s;
    s.ctx.fillStyle = "#000"; s.ctx.fillRect(ax, ay, bx - ax, by - ay);
    s.bounds = { x0: ax, y0: ay, x1: bx - 1, y1: by - 1 }; return s;
  }
  static ellipse(w: number, h: number, x0: number, y0: number, x1: number, y1: number): Selection {
    const s = new Selection(w, h);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
    if (rx < 0.5 || ry < 0.5) return s;
    s.ctx.fillStyle = "#000"; s.ctx.beginPath(); s.ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); s.ctx.fill();
    return s.finalize();
  }
  static polygon(w: number, h: number, pts: Array<{ x: number; y: number }>): Selection {
    const s = new Selection(w, h);
    if (pts.length < 3) return s;
    s.ctx.fillStyle = "#000"; s.ctx.beginPath(); pts.forEach((p, i) => (i ? s.ctx.lineTo(p.x, p.y) : s.ctx.moveTo(p.x, p.y))); s.ctx.closePath(); s.ctx.fill();
    return s.finalize();
  }
  /** from a Uint8Array mask (1 = selected) at the given size, resampled to the document size if needed */
  static fromMask(w: number, h: number, mask: Uint8Array, mw: number, mh: number): Selection {
    const s = new Selection(w, h);
    const img = new ImageData(mw, mh); const d = img.data;
    for (let i = 0; i < mask.length; i++) if (mask[i]) d[i * 4 + 3] = 255;
    if (mw === w && mh === h) s.ctx.putImageData(img, 0, 0);
    else { const c = document.createElement("canvas"); c.width = mw; c.height = mh; c.getContext("2d")!.putImageData(img, 0, 0); s.ctx.imageSmoothingEnabled = false; s.ctx.drawImage(c, 0, 0, w, h); }
    return s.finalize();
  }
  static all(w: number, h: number): Selection { return Selection.rect(w, h, 0, 0, w, h); }

  combine(other: Selection, mode: SelMode): Selection {
    if (mode === "replace") return other;
    const out = this.clone();
    out.ctx.globalCompositeOperation = mode === "add" ? "source-over" : mode === "subtract" ? "destination-out" : "destination-in";
    out.ctx.drawImage(other.canvas, 0, 0); out.ctx.globalCompositeOperation = "source-over";
    return out.finalize();
  }
  invert(): Selection {
    const out = new Selection(this.width, this.height);
    out.ctx.fillStyle = "#000"; out.ctx.fillRect(0, 0, this.width, this.height);
    out.ctx.globalCompositeOperation = "destination-out"; out.ctx.drawImage(this.canvas, 0, 0); out.ctx.globalCompositeOperation = "source-over";
    return out.finalize();
  }
  /** grow (>0) or shrink (<0) by px using repeated 1 px offsets of the mask */
  offset(px: number): Selection {
    const out = this.clone(); const n = Math.abs(Math.round(px)); if (!n) return out;
    const tmp = document.createElement("canvas"); tmp.width = this.width; tmp.height = this.height; const tc = tmp.getContext("2d")!;
    for (let k = 0; k < n; k++) {
      tc.clearRect(0, 0, this.width, this.height);
      if (px > 0) { for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) tc.drawImage(out.canvas, dx!, dy!); out.ctx.drawImage(tmp, 0, 0); }
      else { // erode: keep pixels whose 4 neighbours are all set
        tc.fillStyle = "#000"; tc.fillRect(0, 0, this.width, this.height);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { tc.globalCompositeOperation = "destination-in"; tc.drawImage(out.canvas, dx!, dy!); }
        tc.globalCompositeOperation = "source-over"; out.ctx.globalCompositeOperation = "destination-in"; out.ctx.drawImage(tmp, 0, 0); out.ctx.globalCompositeOperation = "source-over";
      }
    }
    return out.finalize();
  }
  contains(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return this.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data[3]! >= 128;
  }
  /** multiply a tile canvas by the mask (destination-in); binary mask so it is idempotent */
  clipTile(tctx: CanvasRenderingContext2D, tx: number, ty: number): void {
    tctx.save(); tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.globalCompositeOperation = "destination-in"; tctx.globalAlpha = 1;
    tctx.drawImage(this.canvas, tx * TILE, ty * TILE, TILE, TILE, 0, 0, TILE, TILE); tctx.restore();
  }
  /** cut or copy the selected pixels of a layer into a canvas positioned at bounds (x0,y0) */
  lift(layer: Layer, cut: boolean, beforeWrite?: (layer: Layer, tx: number, ty: number) => void): { canvas: HTMLCanvasElement; x: number; y: number } {
    const b = this.bounds; const w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    const c = document.createElement("canvas"); c.width = Math.max(1, w); c.height = Math.max(1, h); const cc = c.getContext("2d")!;
    for (const t of layer.tilesIn(b.x0, b.y0, b.x1 + 1, b.y1 + 1, false)) if (t.canvas) cc.drawImage(t.canvas as CanvasImageSource, t.x * TILE - b.x0, t.y * TILE - b.y0);
    cc.globalCompositeOperation = "destination-in"; cc.drawImage(this.canvas, -b.x0, -b.y0); cc.globalCompositeOperation = "source-over";
    if (cut) {
      for (const t of layer.tilesIn(b.x0, b.y0, b.x1 + 1, b.y1 + 1, false)) {
        if (!t.ctx) continue; beforeWrite?.(layer, t.x, t.y);
        const tc = t.ctx as CanvasRenderingContext2D; tc.save(); tc.globalCompositeOperation = "destination-out"; tc.drawImage(this.canvas, -t.x * TILE, -t.y * TILE); tc.restore(); t.generation++;
      }
      layer.generation++;
    }
    return { canvas: c, x: b.x0, y: b.y0 };
  }
}

/** Floating pixels being moved/transformed before they are stamped back onto a layer. */
export interface Floating {
  canvas: HTMLCanvasElement; // lifted pixels
  layer: Layer;
  x: number; y: number;       // original top-left in DU
  tx: number; ty: number;     // translation
  sx: number; sy: number;     // scale about the centre
  rot: number;                // radians about the centre
  /** page polygon the pixels are cropped to when stamped (set by "Fill panel") */
  clip?: Array<{ x: number; y: number }> | null;
  /**
   * A whole group being moved: the other layers' lifted pixels, same origin and transform as the
   * main canvas, listed bottom to top. The main canvas is the group's bottom-most layer.
   */
  parts?: Array<{ layer: Layer; canvas: HTMLCanvasElement }>;
}

export function floatingMatrix(f: Floating): DOMMatrix {
  const cx = f.x + f.canvas.width / 2, cy = f.y + f.canvas.height / 2;
  return new DOMMatrix().translate(cx + f.tx, cy + f.ty).rotate((f.rot * 180) / Math.PI).scale(f.sx, f.sy).translate(-cx, -cy);
}

/** axis-aligned DU bounds of the transformed floating pixels */
export function floatingBounds(f: Floating): Bounds {
  const m = floatingMatrix(f); const w = f.canvas.width, h = f.canvas.height;
  const pts = [[f.x, f.y], [f.x + w, f.y], [f.x, f.y + h], [f.x + w, f.y + h]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
  return { x0: Math.floor(Math.min(...pts.map((p) => p.x))), y0: Math.floor(Math.min(...pts.map((p) => p.y))), x1: Math.ceil(Math.max(...pts.map((p) => p.x))), y1: Math.ceil(Math.max(...pts.map((p) => p.y))) };
}

/** stamp the floating pixels onto their layer (and every part onto its own layer) with the current transform */
export function stampFloating(f: Floating, beforeWrite?: (layer: Layer, tx: number, ty: number) => void): Bounds {
  const b = floatingBounds(f); const m = floatingMatrix(f);
  const targets = [{ layer: f.layer, canvas: f.canvas }, ...(f.parts ?? [])];
  for (const { layer, canvas } of targets) {
    for (const t of layer.tilesIn(b.x0, b.y0, b.x1 + 1, b.y1 + 1, true)) {
      if (!t.ctx) continue; beforeWrite?.(layer, t.x, t.y);
      const tc = t.ctx as CanvasRenderingContext2D; tc.save(); tc.translate(-t.x * TILE, -t.y * TILE);
      if (f.clip && f.clip.length >= 3) { tc.beginPath(); f.clip.forEach((q, i) => (i ? tc.lineTo(q.x, q.y) : tc.moveTo(q.x, q.y))); tc.closePath(); tc.clip(); }
      tc.transform(m.a, m.b, m.c, m.d, m.e, m.f); tc.imageSmoothingEnabled = true; tc.imageSmoothingQuality = "high";
      tc.drawImage(canvas, f.x, f.y); tc.restore(); t.generation++;
    }
    layer.generation++;
  }
  return b;
}

/** the selection mask transformed the same way as the floating pixels (so the ants follow the move) */
export function transformSelection(sel: Selection, f: Floating): Selection {
  const out = new Selection(sel.width, sel.height); const m = floatingMatrix(f);
  out.ctx.save(); out.ctx.transform(m.a, m.b, m.c, m.d, m.e, m.f); out.ctx.drawImage(sel.canvas, 0, 0); out.ctx.restore();
  return out.finalize();
}
