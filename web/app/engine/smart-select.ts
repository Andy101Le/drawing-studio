/**
 * Edge-aware selection, two tools in the Photoshop sense:
 *
 *   Magnetic lasso (live-wire, "intelligent scissors"): between the last anchor and the cursor the
 *   path is the cheapest route through an edge-cost map, so it hugs the object's outline. Dijkstra
 *   runs once per anchor over a window around it; moving the cursor only follows parent pointers.
 *
 *   Tighten: a rough selection is refined inside a band around its outline. Colour models of the
 *   definite inside and definite outside (k-means in Lab) give each band pixel an inside likelihood;
 *   a bilateral majority vote keeps the boundary on colour edges; the result is the component
 *   attached to the core, holes filled. The GrabCut idea without the graph cut.
 *
 * Both read a flattened copy of the visible page (Photoshop's "sample all layers") at a working
 * scale of at most ~1.5 Mpx; results are mapped back to page coordinates.
 */
import { edt, toLab, kmeans, nearestCentre } from "./trace/trace-core.js";
import { Selection } from "./selection.js";

export interface EdgeMap { w: number; h: number; scale: number; cost: Float32Array; lab: { L: Float32Array; A: Float32Array; B: Float32Array } }

/** gradient-based cost map from a flattened page (white under transparency); scale = map px per page px */
export function buildEdgeMap(flat: HTMLCanvasElement, scale: number): EdgeMap {
  const w = flat.width, h = flat.height, N = w * h;
  const g = flat.getContext("2d", { willReadFrequently: true })!;
  g.save(); g.globalCompositeOperation = "destination-over"; g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); g.restore();
  const rgba = g.getImageData(0, 0, w, h).data;
  const lab = toLab(rgba, N);
  // Sobel on L and on chroma (a, b): an edge between two colours of equal lightness still counts
  const mag = new Float32Array(N);
  for (const [arr, k] of [[lab.L, 1], [lab.A, 0.6], [lab.B, 0.6]] as const) {
    for (let y = 0; y < h; y++) {
      const ym = Math.max(0, y - 1) * w, y0 = y * w, yp = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) {
        const xm = Math.max(0, x - 1), xp = Math.min(w - 1, x + 1);
        const gx = (arr[ym + xp]! + 2 * arr[y0 + xp]! + arr[yp + xp]!) - (arr[ym + xm]! + 2 * arr[y0 + xm]! + arr[yp + xm]!);
        const gy = (arr[yp + xm]! + 2 * arr[yp + x]! + arr[yp + xp]!) - (arr[ym + xm]! + 2 * arr[ym + x]! + arr[ym + xp]!);
        mag[y0 + x] = mag[y0 + x]! + k * Math.sqrt(gx * gx + gy * gy);
      }
    }
  }
  // normalise by a high percentile so one very strong edge does not flatten the rest
  const sample: number[] = []; for (let i = 0; i < N; i += Math.max(1, (N / 50000) | 0)) sample.push(mag[i]!);
  sample.sort((a, b) => a - b); const hi = Math.max(1e-3, sample[Math.floor(sample.length * 0.985)]!);
  const cost = new Float32Array(N);
  for (let i = 0; i < N; i++) { const t = Math.min(1, mag[i]! / hi); cost[i] = 0.04 + (1 - t) * (1 - t); }
  return { w, h, scale, cost, lab };
}

/** binary min-heap on (cost, index) pairs, typed arrays (the inner loop of the live-wire) */
class Heap {
  private k = new Float32Array(1 << 16); private v = new Int32Array(1 << 16); size = 0;
  push(key: number, val: number) {
    if (this.size === this.k.length) { const k2 = new Float32Array(this.k.length * 2); k2.set(this.k); this.k = k2; const v2 = new Int32Array(this.v.length * 2); v2.set(this.v); this.v = v2; }
    const k = this.k, v = this.v; let i = this.size++; k[i] = key; v[i] = val;
    while (i > 0) { const p = (i - 1) >> 1; if (k[p]! <= k[i]!) break; const tk = k[p]!, tv = v[p]!; k[p] = k[i]!; v[p] = v[i]!; k[i] = tk; v[i] = tv; i = p; }
  }
  pop(): [number, number] {
    const k = this.k, v = this.v; const top: [number, number] = [k[0]!, v[0]!]; const n = --this.size;
    if (n > 0) { k[0] = k[n]!; v[0] = v[n]!; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && k[l]! < k[m]!) m = l; if (r < n && k[r]! < k[m]!) m = r; if (m === i) break; const tk = k[m]!, tv = v[m]!; k[m] = k[i]!; v[m] = v[i]!; k[i] = tk; v[i] = tv; i = m; } }
    return top;
  }
}

const N8 = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [-1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;

/** Dijkstra from a seed over a window of the edge map; pathTo() follows the parent pointers back */
export class LiveWire {
  private parent: Int32Array; private dist: Float32Array;
  private seed = -1; private win = { x0: 0, y0: 0, x1: 0, y1: 0 };
  constructor(readonly map: EdgeMap) { this.parent = new Int32Array(map.w * map.h).fill(-1); this.dist = new Float32Array(map.w * map.h).fill(Infinity); }
  /** run from a page point; `radius` in map px decides the window (grows if the cursor leaves it) */
  /** ms spent in the last setSeed, for the status line */
  lastMs = 0;
  setSeed(px: number, py: number, radius = 240): void {
    const t0 = performance.now();
    const { w, h, scale, cost } = this.map;
    const sx = Math.min(w - 1, Math.max(0, Math.round(px * scale))), sy = Math.min(h - 1, Math.max(0, Math.round(py * scale)));
    const x0 = Math.max(0, sx - radius), y0 = Math.max(0, sy - radius), x1 = Math.min(w - 1, sx + radius), y1 = Math.min(h - 1, sy + radius);
    this.win = { x0, y0, x1, y1 }; this.seed = sy * w + sx;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * w + x; this.dist[i] = Infinity; this.parent[i] = -1; }
    const heap = new Heap(); this.dist[this.seed] = 0; heap.push(0, this.seed);
    const done = new Uint8Array(w * h);
    while (heap.size) {
      const [d, i] = heap.pop(); if (done[i]) continue; done[i] = 1;
      const x = i % w, y = (i / w) | 0;
      for (const [dx, dy, len] of N8) {
        const nx = x + dx, ny = y + dy; if (nx < x0 || ny < y0 || nx > x1 || ny > y1) continue;
        const j = ny * w + nx; if (done[j]) continue;
        const nd = d + len * (cost[j]! + cost[i]!) * 0.5;
        if (nd < this.dist[j]!) { this.dist[j] = nd; this.parent[j] = i; heap.push(nd, j); }
      }
    }
    this.lastMs = performance.now() - t0;
  }
  private inWindow(px: number, py: number): boolean { const s = this.map.scale; const x = Math.round(px * s), y = Math.round(py * s); return x >= this.win.x0 && x <= this.win.x1 && y >= this.win.y0 && y <= this.win.y1; }
  /** page points from the seed to (px, py); re-runs with a larger window if the cursor is outside it */
  pathTo(px: number, py: number, seedPx: number, seedPy: number): Array<{ x: number; y: number }> {
    if (this.seed < 0) return [];
    if (!this.inWindow(px, py)) { const s = this.map.scale; const r = Math.ceil(Math.hypot(px - seedPx, py - seedPy) * s) + 80; this.setSeed(seedPx, seedPy, Math.min(1400, r)); }
    const { w, scale } = this.map;
    const x = Math.min(this.win.x1, Math.max(this.win.x0, Math.round(px * scale))), y = Math.min(this.win.y1, Math.max(this.win.y0, Math.round(py * scale)));
    let i = y * w + x; const out: number[] = [];
    for (let g = 0; g < w * 4 && i >= 0; g++) { out.push(i); if (i === this.seed) break; i = this.parent[i]!; }
    if (i !== this.seed) return [{ x: seedPx, y: seedPy }, { x: px, y: py }]; // unreachable (should not happen inside the window): straight segment
    out.reverse();
    const pts = out.map((q) => ({ x: (q % w + 0.5) / scale, y: (((q / w) | 0) + 0.5) / scale }));
    pts[0] = { x: seedPx, y: seedPy }; pts[pts.length - 1] = { x: px, y: py };
    return pts;
  }
}

/**
 * Refine a selection to the object edges inside a band of +-`band` page px around its outline.
 * Returns the new selection (same page size) and the share of band pixels that changed.
 */
export function tighten(sel: Selection, map: EdgeMap, band: number): { selection: Selection; changed: number } {
  const { w, h, scale, lab } = map; const N = w * h;
  // the selection at map scale
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.drawImage(sel.canvas, 0, 0, w, h);
  const sd = g.getImageData(0, 0, w, h).data;
  const inside = new Uint8Array(N), outside = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const a = sd[i * 4 + 3]!; inside[i] = a >= 128 ? 1 : 0; outside[i] = a >= 128 ? 0 : 1; }
  const r = Math.max(3, band * scale);
  const dIn = edt(inside, w, h), dOut = edt(outside, w, h); // distance to the outline from each side
  // classes: 1 core (deep inside), 2 band, 3 outer ring (outside, up to 3r from the outline), 0 far outside
  const cls = new Uint8Array(N); let bandN = 0;
  for (let i = 0; i < N; i++) { if (inside[i]) cls[i] = dIn[i]! > r ? 1 : 2; else cls[i] = dOut[i]! <= r ? 2 : dOut[i]! <= 3 * r ? 3 : 0; if (cls[i] === 2) bandN++; }
  if (!bandN) return { selection: sel, changed: 0 };
  const feat = (list: number[]) => { const f = new Float32Array(list.length * 3); list.forEach((i, j) => { f[j * 3] = lab.L[i]!; f[j * 3 + 1] = lab.A[i]!; f[j * 3 + 2] = lab.B[i]!; }); return f; };
  const pick = (want: number, max: number) => { const idx: number[] = []; for (let i = 0; i < N; i++) if (cls[i] === want) idx.push(i); if (idx.length <= max) return idx; const step = idx.length / max; const out: number[] = []; for (let t = 0; t < max; t++) out.push(idx[Math.floor(t * step)]!); return out; };
  let inIdx = pick(1, 20000), outIdx = pick(3, 20000);
  if (!inIdx.length) inIdx = pick(2, 20000); if (!outIdx.length) outIdx = pick(0, 20000);
  if (!inIdx.length || !outIdx.length) return { selection: sel, changed: 0 };
  const K = 6;
  let cIn = kmeans(feat(inIdx), inIdx.length, 3, Math.min(K, inIdx.length), 8, 3), cOut = kmeans(feat(outIdx), outIdx.length, 3, Math.min(K, outIdx.length), 8, 5);
  const kIn = Math.min(K, inIdx.length), kOut = Math.min(K, outIdx.length);
  const p = new Float32Array(N); const label = new Uint8Array(N); // 1 = inside
  const dist2 = (C: Float32Array, k: number, i: number) => { const v = [lab.L[i]!, lab.A[i]!, lab.B[i]!]; const c0 = nearestCentre(C, k, 3, v); let dd = 0; for (let d = 0; d < 3; d++) { const t = v[d]! - C[c0 * 3 + d]!; dd += t * t; } return Math.sqrt(dd); };
  for (let iter = 0; iter < 3; iter++) {
    for (let i = 0; i < N; i++) {
      if (cls[i] === 1) { p[i] = 1; label[i] = 1; continue; } if (cls[i] !== 2) { p[i] = 0; label[i] = 0; continue; }
      const a = dist2(cIn, kIn, i), b = dist2(cOut, kOut, i);
      // the rough outline is a prior: 0.5 at the line, leaning to its own side further away
      const prior = inside[i] ? 0.5 + 0.25 * Math.min(1, dIn[i]! / r) : 0.5 - 0.25 * Math.min(1, dOut[i]! / r);
      const like = (b + 1e-3) / (a + b + 2e-3);
      p[i] = 0.7 * like + 0.3 * prior; label[i] = p[i]! > 0.5 ? 1 : 0;
    }
    if (iter < 2) {
      // re-estimate the colour models from the current labelling of the band plus the definite sets
      const li: number[] = [], lo: number[] = [];
      for (let i = 0; i < N; i++) if (cls[i] === 2) (label[i] ? li : lo).push(i);
      const sub = (arr: number[], max: number) => { if (arr.length <= max) return arr; const st = arr.length / max; const o: number[] = []; for (let t = 0; t < max; t++) o.push(arr[Math.floor(t * st)]!); return o; };
      const ii = [...sub(inIdx, 12000), ...sub(li, 8000)], oo = [...sub(outIdx, 12000), ...sub(lo, 8000)];
      cIn = kmeans(feat(ii), ii.length, 3, kIn, 6, 3); cOut = kmeans(feat(oo), oo.length, 3, kOut, 6, 5);
    }
  }
  // bilateral majority: neighbours vote only if their colour is close, so the vote never crosses an edge
  for (let pass = 0; pass < 2; pass++) {
    const next = label.slice();
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (cls[i] !== 2) continue;
      let yes = 0, tot = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx;
        const de = Math.hypot(lab.L[i]! - lab.L[j]!, lab.A[i]! - lab.A[j]!, lab.B[i]! - lab.B[j]!); const wgt = Math.exp(-de / 8);
        tot += wgt; if (label[j]) yes += wgt;
      }
      next[i] = yes > tot * 0.5 ? 1 : 0;
    }
    label.set(next);
  }
  // keep what is attached to the core; fill band holes that cannot reach the outside
  const reach = new Uint8Array(N); { const st: number[] = []; for (let i = 0; i < N; i++) if (cls[i] === 1) { reach[i] = 1; st.push(i); } while (st.length) { const i = st.pop()!; const x = i % w, y = (i / w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx!, ny = y + dy!; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (!reach[j] && label[j] && cls[j] === 2) { reach[j] = 1; st.push(j); } } } }
  const outReach = new Uint8Array(N); { const st: number[] = []; for (let i = 0; i < N; i++) if (cls[i] === 3 || cls[i] === 0) { outReach[i] = 1; st.push(i); } while (st.length) { const i = st.pop()!; const x = i % w, y = (i / w) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const nx = x + dx!, ny = y + dy!; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const j = ny * w + nx; if (!outReach[j] && !reach[j] && cls[j] === 2) { outReach[j] = 1; st.push(j); } } } }
  const mask = new Uint8Array(N); let changed = 0;
  for (let i = 0; i < N; i++) { const v = cls[i] === 1 || reach[i] || (cls[i] === 2 && !outReach[i]) ? 1 : 0; mask[i] = v; if (cls[i] === 2 && v !== inside[i]) changed++; }
  // back to page size with smoothing on, so the edge is not stepped by the working scale
  const img = new ImageData(w, h); for (let i = 0; i < N; i++) if (mask[i]) img.data[i * 4 + 3] = 255;
  const mc = document.createElement("canvas"); mc.width = w; mc.height = h; mc.getContext("2d")!.putImageData(img, 0, 0);
  const out = new Selection(sel.width, sel.height); out.ctx.imageSmoothingEnabled = true; out.ctx.imageSmoothingQuality = "high"; out.ctx.drawImage(mc, 0, 0, sel.width, sel.height);
  return { selection: out.finalize(), changed: changed / bandN };
}
