/**
 * Procedural screentone (Phase 6.1).
 *
 * The tone is defined analytically (lpi, density, angle, shape) and rasterized
 * fresh for the current viewport scale, so no resampling ever happens and the
 * beat frequency that causes moiré never forms. For the on-screen preview the
 * pattern is rendered in *screen pixels*; for export it is rendered at output
 * DPI with the same function.
 *
 * pitch_px = (dpi / lpi) * zoom         distance between dot centers on screen
 * radius   = sqrt(density * pitch² / π)  area-preserving dot for the coverage
 *
 * Supersampled 4x4 per pixel so sub-pixel dots at small zoom become uniform gray
 * instead of aliasing into bands.
 */

import { makeCanvas, type ToneSettings } from "./document.js";

export interface TonePatternResult {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  /** pattern period in screen px along x and y (integer tile size used) */
  size: number;
  pitchPx: number;
}

const cache = new Map<string, TonePatternResult>();

/** Deterministic hash in [0,1) on integer screen coordinates (stochastic tones). */
export function toneHash(x: number, y: number): number { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }

/**
 * Screen-space tone field for shapes that are not a repeating tile (noise, sand) or for
 * gradient tones: coverage evaluated per screen pixel over the given region. `docOf` maps a
 * screen pixel to document coordinates (for the gradient axis). Cached by the caller.
 */
export function toneField(t: ToneSettings, dpi: number, zoom: number, w: number, h: number, docOf: (sx: number, sy: number) => { x: number; y: number }, ink = "0,0,0"): HTMLCanvasElement | OffscreenCanvas {
  const pitch = (dpi / t.lpi) * zoom;
  const c = makeCanvas(w, h);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D; const img = ctx.createImageData(w, h); const d = img.data;
  const [ir, ig, ib] = ink.split(",").map(Number) as [number, number, number];
  const cosA = Math.cos((t.angle * Math.PI) / 180), sinA = Math.sin((t.angle * Math.PI) / 180);
  const g = t.gradient; const gdx = g ? g.x1 - g.x0 : 0, gdy = g ? g.y1 - g.y0 : 0, gl2 = g ? gdx * gdx + gdy * gdy || 1 : 1;
  const ss = t.shape === "noise" || t.shape === "sand" ? 1 : (pitch < 6 ? 3 : 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let density = t.density;
      if (g) { const p = docOf(x, y); const tt = Math.max(0, Math.min(1, ((p.x - g.x0) * gdx + (p.y - g.y0) * gdy) / gl2)); density = t.density + (g.density2 - t.density) * tt; }
      let a: number;
      if (t.shape === "noise") a = toneHash(x, y) < density ? 1 : 0;
      else if (t.shape === "sand") { // clustered grains: threshold on a coarser hash, 2 px cells
        a = toneHash(x >> 1, y >> 1) < density ? 1 : 0;
      } else {
        const r = Math.sqrt((density * pitch * pitch) / Math.PI), lineHalf = (density * pitch) / 2; let cov = 0;
        for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss; const u = px * cosA + py * sinA, v = -px * sinA + py * cosA;
          const fu = u / pitch - Math.floor(u / pitch) - 0.5, fv = v / pitch - Math.floor(v / pitch) - 0.5;
          let inside = false;
          if (t.shape === "dot") inside = (fu * fu + fv * fv) * pitch * pitch <= r * r; else if (t.shape === "line") inside = Math.abs(fv) * pitch <= lineHalf; else inside = Math.abs(fv) * pitch <= lineHalf / 2 || Math.abs(fu) * pitch <= lineHalf / 2;
          if (inside) cov++;
        }
        a = cov / (ss * ss);
      }
      const i = (y * w + x) * 4; d[i] = ir; d[i + 1] = ig; d[i + 2] = ib; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0); return c;
}

export function tonePattern(t: ToneSettings, dpi: number, zoom: number, ink = "0,0,0"): TonePatternResult {
  const pitch = (dpi / t.lpi) * zoom;
  // tile must contain an integer number of periods in the rotated lattice; a
  // square of side N·pitch along the lattice axes repeats when the rotated
  // lattice has rational slope. We approximate with a tile large enough that
  // seams fall below 1/4 px, capped at 512 px.
  const period = pitch * latticeRepeat(t.angle);
  const size = Math.max(8, Math.min(512, Math.round(period)));
  const key = `${t.lpi}|${t.density.toFixed(3)}|${t.angle}|${t.shape}|${dpi}|${zoom.toFixed(4)}|${ink}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const c = makeCanvas(size, size);
  const ctx = c.getContext("2d") as CanvasRenderingContext2D;
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const ss = pitch < 6 ? 4 : 2; // supersampling
  const cosA = Math.cos((t.angle * Math.PI) / 180), sinA = Math.sin((t.angle * Math.PI) / 180);
  const density = Math.max(0, Math.min(1, t.density));
  const r = Math.sqrt((density * pitch * pitch) / Math.PI);
  const lineHalf = (density * pitch) / 2;
  const [ir, ig, ib] = ink.split(",").map(Number) as [number, number, number];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss, py = y + (sy + 0.5) / ss;
          const u = px * cosA + py * sinA, v = -px * sinA + py * cosA;
          const fu = u / pitch - Math.floor(u / pitch) - 0.5;
          const fv = v / pitch - Math.floor(v / pitch) - 0.5;
          let inside = false;
          if (t.shape === "dot") inside = (fu * fu + fv * fv) * pitch * pitch <= r * r;
          else if (t.shape === "line") inside = Math.abs(fv) * pitch <= lineHalf;
          else inside = Math.abs(fv) * pitch <= lineHalf / 2 || Math.abs(fu) * pitch <= lineHalf / 2;
          if (inside) cov++;
        }
      }
      const a = cov / (ss * ss);
      const i = (y * size + x) * 4;
      d[i] = ir; d[i + 1] = ig; d[i + 2] = ib; d[i + 3] = Math.round(a * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const res = { canvas: c, size, pitchPx: pitch };
  if (cache.size > 48) cache.clear();
  cache.set(key, res);
  return res;
}

/**
 * Smallest k such that a k·pitch square tiles a lattice rotated by `angle`
 * without seams, for angles with small rational tangents (0, 15, 30, 45, 60,
 * 75, 90 handled exactly via the (a,b) lattice vector; others get 16).
 */
function latticeRepeat(angleDeg: number): number {
  const a = ((angleDeg % 90) + 90) % 90;
  if (a === 0) return 1;
  if (a === 45) return Math.SQRT2;
  const tan = Math.tan((a * Math.PI) / 180);
  for (let q = 1; q <= 12; q++) {
    const p = Math.round(tan * q);
    if (Math.abs(tan - p / q) < 1e-3) return Math.sqrt(p * p + q * q);
  }
  return 16;
}

/** Moiré risk estimate: distance of the screen pitch to the nearest integer px multiple. */
export function moireRisk(pitchPx: number): number {
  if (pitchPx < 1.5) return 1; // below Nyquist, renders as flat gray (safe by supersampling)
  const frac = Math.abs(pitchPx - Math.round(pitchPx));
  return Math.max(0, 1 - frac / 0.15);
}
