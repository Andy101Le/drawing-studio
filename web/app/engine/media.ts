/**
 * Natural media simulation: watercolor, acrylic and sponge.
 *
 * WATERCOLOR (WetField): a per-layer fluid and pigment field at half document resolution over the
 * tiles a wet stroke touched. Each cell holds water (0..1), pigment as RGB absorbance (so mixing is
 * subtractive, like real pigment: glazes darken and never go chalky), a paper-tooth value and a
 * fixed flag. The render loop ticks the field while anything is wet:
 *   1. water evaporates; faster at the rim of a wet region (a cell wetter than its neighbours), on
 *      rough paper, and in thin films. The rim drying faster is what drags pigment outward and
 *      makes the dark edge watercolour is known for;
 *   2. pigment diffuses through water (wet-in-wet spreading) and migrates toward the drying rim
 *      (edge darkening); a granulation term lets heavy pigment settle into paper valleys;
 *   3. a bloom (backrun, cauliflower) starts when fresh water lands on a wash that is drying:
 *      the new water pushes the settling pigment outward, leaving a lighter centre and a hard rim;
 *   4. cells whose water is gone fix their pigment.
 * Rendering: transmission T = exp(-k·A) per channel over the paper (multiply), alpha = 1 - mean(T).
 * The field is composited over a "dry base" snapshot of the tile taken when the cell first got wet,
 * so the picture keeps changing while it dries (lift, feather, bloom) and a dry layer is just pixels.
 *
 * ACRYLIC (BodyField): opaque paint with body. Each dab adds height (impasto) under its footprint;
 * paint stays "open" (mixable) for a while and ages out; dry brush skips deposit on the paper
 * tooth; scumbling breaks the deposit; sgraffito and the knife edge scrape body away. Lighting is
 * baked into the pixels at commit: Sobel gradient of the height field under a fixed key light,
 * so ridges get a highlight and a shadow that export and show on both compositors.
 *
 * SPONGE: procedural natural-sponge masks (Worley cell walls with a torn rim) stamped at a random
 * spin and wide spacing; a wet sponge on a watercolour layer lifts pigment instead of adding it.
 */
import { TILE, type Layer } from "./document.js";

// ---------------------------------------------------------------- noise
function hash2(x: number, y: number, seed = 0): number { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 1442695041)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function smooth(x: number, y: number, scale: number, seed: number): number {
  const gx = x / scale, gy = y / scale; const x0 = Math.floor(gx), y0 = Math.floor(gy); const fx = gx - x0, fy = gy - y0;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed), b = hash2(x0 + 1, y0, seed), c = hash2(x0, y0 + 1, seed), d = hash2(x0 + 1, y0 + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
/** paper tooth 0..1 at document coords: fine fibre noise over a coarser cold-press texture (locked to the page, so every stroke sees the same paper) */
export function paper(x: number, y: number): number { return 0.5 * smooth(x, y, 3.1, 11) + 0.32 * smooth(x, y, 9.7, 12) + 0.18 * hash2(x | 0, y | 0, 13); }

const EXP_LUT = new Float32Array(2049); for (let i = 0; i <= 2048; i++) EXP_LUT[i] = Math.exp(-(i / 2048) * 16);
/** exp(-a) for a in 0..16 via table */
function expNeg(a: number): number { if (a <= 0) return 1; if (a >= 16) return EXP_LUT[2048]!; const u = a * 128; const i = u | 0; const f = u - i; return EXP_LUT[i]! + (EXP_LUT[i + 1]! - EXP_LUT[i]!) * f; }

/** footprint sampler: returns coverage 0..1 at offset (dx,dy) from the dab centre in units of r (already rotated) */
export type Footprint = (u: number, v: number) => number;
export const DISC: Footprint = (u, v) => { const d2 = u * u + v * v; return d2 >= 1 ? 0 : 1 - d2; };
/** Footprint from any tip canvas (flat, bristle, custom): alpha sampled over the canvas square */
export function canvasFootprint(c: OffscreenCanvas | HTMLCanvasElement): Footprint {
  const S = c.width; const d = (c.getContext("2d") as CanvasRenderingContext2D).getImageData(0, 0, S, S).data;
  return (u, v) => { if (u < -1 || u > 1 || v < -1 || v > 1) return 0; const x = Math.min(S - 1, ((u + 1) * 0.5 * S) | 0), y = Math.min(S - 1, ((v + 1) * 0.5 * S) | 0); return d[(y * S + x) * 4 + 3]! / 255; };
}

// ---------------------------------------------------------------- watercolor
export interface WetParams {
  water: number;        // water per dab 0..1
  pigment: number;      // pigment per dab 0..1 (0 = clear water: feather / soften / wet the paper)
  diffusion: number;    // wet-in-wet spread 0..1
  edgeDark: number;     // pigment pulled to the drying rim 0..1
  granulation: number;  // settling into paper valleys 0..1
  bloom: number;        // backrun strength when water lands on a drying wash 0..1
  lift: number;         // 0..1 the brush removes pigment where it is still wet (lift out, wipe out)
  dryTime: number;      // seconds for a full-strength dab to dry
  absorb: number;       // pigment strength per unit absorbance (k in exp(-kA))
  sheen: number;        // 0..1 visible wet gloss while water is present
}
export const WET_DEFAULT: WetParams = { water: 0.6, pigment: 0.5, diffusion: 0.5, edgeDark: 0.6, granulation: 0.3, bloom: 0.4, lift: 0, dryTime: 6, absorb: 2.6, sheen: 0.06 };

const HALF = TILE / 2, N = HALF * HALF;
interface WetCell { w: Float32Array; a: Float32Array; fixed: Uint8Array; tooth: Float32Array; base: ImageData | null; dirty: boolean; touched: boolean; age: Float32Array; gen: number }

export class WetField {
  readonly cells = new Map<string, WetCell>();
  lastTick = performance.now();
  /** called before the first write into a layer tile (history capture) */
  beforeWrite: ((layer: Layer, tx: number, ty: number) => void) | null = null;
  /** parameters the drying loop uses between strokes (the last brush that touched the field) */
  params: WetParams = WET_DEFAULT;
  constructor(readonly layer: Layer) {}
  get wet(): boolean { for (const c of this.cells.values()) if (c.dirty) return true; return false; }
  private cell(tx: number, ty: number): WetCell {
    const k = `${tx},${ty}`; let c = this.cells.get(k);
    if (!c) {
      this.beforeWrite?.(this.layer, tx, ty);
      const t = this.layer.getTile(tx, ty, true)!;
      const tooth = new Float32Array(N); for (let y = 0; y < HALF; y++) for (let x = 0; x < HALF; x++) tooth[y * HALF + x] = paper(tx * TILE + x * 2, ty * TILE + y * 2);
      c = { w: new Float32Array(N), a: new Float32Array(N * 3), fixed: new Uint8Array(N), tooth, base: t.ctx ? (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE) : null, dirty: false, touched: false, age: new Float32Array(N), gen: t.generation };
      this.cells.set(k, c);
    } else this.adopt(c, tx, ty);
    return c;
  }
  /**
   * Someone else (fill, gradient, paste, another brush) wrote this tile since our last render:
   * the wash is fixed as it stands and the current pixels become the new base, so later wet
   * strokes glaze over the edit instead of overwriting it with a stale snapshot.
   */
  private adopt(c: WetCell, tx: number, ty: number): void {
    const t = this.layer.getTile(tx, ty, false); if (!t || !t.ctx || t.generation === c.gen) return;
    c.base = (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE); c.a.fill(0); c.w.fill(0); c.fixed.fill(1); c.dirty = false; c.touched = false; c.gen = t.generation;
  }
  /** Deposit a dab: water and pigment absorbance (1 - rgb) scaled by load; lifting removes pigment where water is present. */
  dab(x: number, y: number, r: number, p: WetParams, rgb: [number, number, number], pressure: number, fp: Footprint = DISC, rot = 0, strength = 1): void {
    const R = Math.max(1, r / 2); const cx = x / 2, cy = y / 2; const cs = Math.cos(-rot), sn = Math.sin(-rot);
    const tx0 = Math.floor((cx - R) / HALF), ty0 = Math.floor((cy - R) / HALF), tx1 = Math.floor((cx + R) / HALF), ty1 = Math.floor((cy + R) / HALF);
    // pigment concentration the brush carries: absorbance that renders exactly this colour at full strength,
    // scaled by the pigment load (thin tint .. heavier than the swatch). Deposits approach it instead of stacking without bound.
    const conc = 0.25 + 1.1 * p.pigment;
    const target: [number, number, number] = [(-Math.log(Math.max(rgb[0] / 255, 0.03)) / p.absorb) * conc, (-Math.log(Math.max(rgb[1] / 255, 0.03)) / p.absorb) * conc, (-Math.log(Math.max(rgb[2] / 255, 0.03)) / p.absorb) * conc];
    const load = p.pigment > 0 ? (0.3 + 0.7 * pressure) * 0.5 * strength : 0, water = p.water * (0.5 + 0.5 * pressure) * 0.45 * strength;
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0) continue; const c = this.cell(tx, ty); c.dirty = true; c.touched = true;
      const ox = tx * HALF, oy = ty * HALF;
      const lx0 = Math.max(0, Math.floor(cx - R - ox)), ly0 = Math.max(0, Math.floor(cy - R - oy)), lx1 = Math.min(HALF - 1, Math.ceil(cx + R - ox)), ly1 = Math.min(HALF - 1, Math.ceil(cy + R - oy));
      for (let ly = ly0; ly <= ly1; ly++) for (let lx = lx0; lx <= lx1; lx++) {
        const dx = (lx + ox + 0.5 - cx) / R, dy = (ly + oy + 0.5 - cy) / R;
        let k = fp(dx * cs - dy * sn, dx * sn + dy * cs); if (k <= 0) continue;
        const i = ly * HALF + lx;
        // dry brush: with little water the hairs only touch the tops of the paper tooth; pressure pushes them into the valleys
        if (p.water < 0.3) { const lim = 0.25 + p.water * 1.6 + pressure * 0.3; const t = c.tooth[i]!; if (t > lim) continue; k *= Math.min(1, (lim - t) * 6); }
        // bloom: fresh water onto a cell that is drying (little water left, pigment present, not fixed)
        if (p.bloom > 0 && c.w[i]! < 0.3 && c.w[i]! > 0.01 && !c.fixed[i]) {
          const push = Math.min(0.9, p.bloom * k * 0.9); const a0 = c.a[i * 3]! + c.a[i * 3 + 1]! + c.a[i * 3 + 2]!;
          if (a0 > 0.05) { for (let ch = 0; ch < 3; ch++) c.a[i * 3 + ch] = c.a[i * 3 + ch]! * (1 - push); c.w[i] = Math.min(1, c.w[i]! + water * k * 2.2); }
        }
        const wasWet = c.fixed[i] ? 0 : c.w[i]!;
        c.w[i] = Math.min(1, c.w[i]! + water * k); c.fixed[i] = 0; c.age[i] = 0;
        if (p.lift > 0) { const l = Math.min(0.6, p.lift * k * 0.09 * (0.4 + 0.6 * pressure)); for (let ch = 0; ch < 3; ch++) c.a[i * 3 + ch] = c.a[i * 3 + ch]! * (1 - l); }
        if (load > 0) {
          const g = 1 - p.granulation * 0.6 * c.tooth[i]!; const rate = Math.min(1, load * k * g);
          // into a wet pool the new pigment mixes with what is there (pulls the colour toward itself);
          // onto dry or fixed paint it glazes: absorbances only add, never lighten
          const wetK = wasWet ? Math.min(1, wasWet * 2.5) : 0;
          for (let ch = 0; ch < 3; ch++) { const a = c.a[i * 3 + ch]!, tg = target[ch]!; c.a[i * 3 + ch] = tg > a ? a + (tg - a) * rate : a + (tg - a) * rate * wetK; }
        }
      }
    }
  }
  /** Salt / alcohol / sandpaper effects: random spots that pull pigment away (salt), push it out in rings (alcohol) or scrape it (sandpaper). */
  effect(x: number, y: number, r: number, kind: "salt" | "alcohol" | "sand", seed: number): void {
    const R = r / 2, cx = x / 2, cy = y / 2; const count = kind === "sand" ? 60 : Math.max(3, Math.round(R * R / 40));
    for (let i = 0; i < count; i++) {
      const ang = hash2(i, seed, 1) * Math.PI * 2, d = Math.sqrt(hash2(i, seed, 2)) * R; const px = cx + Math.cos(ang) * d, py = cy + Math.sin(ang) * d;
      const sr = kind === "salt" ? 1.5 + hash2(i, seed, 3) * 3 : kind === "alcohol" ? 3 + hash2(i, seed, 3) * 6 : 0.8;
      const tx = Math.floor(px / HALF), ty = Math.floor(py / HALF); if (tx < 0 || ty < 0) continue; const c = this.cell(tx, ty); c.dirty = true; c.touched = true;
      for (let ly = Math.max(0, Math.floor(py - sr - ty * HALF)); ly <= Math.min(HALF - 1, Math.ceil(py + sr - ty * HALF)); ly++) for (let lx = Math.max(0, Math.floor(px - sr - tx * HALF)); lx <= Math.min(HALF - 1, Math.ceil(px + sr - tx * HALF)); lx++) {
        const dx = lx + tx * HALF + 0.5 - px, dy = ly + ty * HALF + 0.5 - py; const dd = Math.sqrt(dx * dx + dy * dy) / sr; if (dd > 1) continue; const j = ly * HALF + lx;
        if (kind === "salt") { const k = (1 - dd) * Math.min(1, c.w[j]! * 3); for (let ch = 0; ch < 3; ch++) c.a[j * 3 + ch] = c.a[j * 3 + ch]! * (1 - 0.7 * k); c.w[j] = Math.max(0, c.w[j]! - 0.2 * k); }
        else if (kind === "alcohol") { const ring = dd > 0.75 ? 1.5 : 1 - dd * 0.9; const k = Math.min(1, c.w[j]! * 3); for (let ch = 0; ch < 3; ch++) c.a[j * 3 + ch] = c.a[j * 3 + ch]! * (1 - k + k * ring); }
        else { if (c.tooth[j]! > 0.55) for (let ch = 0; ch < 3; ch++) c.a[j * 3 + ch] = c.a[j * 3 + ch]! * 0.3; }
      }
    }
  }
  /** One simulation step: evaporation, diffusion, rim migration, granulation settle, fixing. Neighbouring cells exchange across their borders. */
  tick(now: number, p: WetParams): boolean {
    const dt = Math.min(0.1, (now - this.lastTick) / 1000); this.lastTick = now; if (dt <= 0) return false;
    const evap = dt / Math.max(0.4, p.dryTime); let any = false;
    const next = new Map<WetCell, { w: Float32Array; a: Float32Array }>();
    for (const [key, c] of this.cells) {
      if (!c.dirty) continue; const [tx, ty] = key.split(",").map(Number) as [number, number]; this.adopt(c, tx, ty); if (!c.dirty) continue; any = true;
      const left = this.cells.get(`${tx - 1},${ty}`) ?? null, right = this.cells.get(`${tx + 1},${ty}`) ?? null, up = this.cells.get(`${tx},${ty - 1}`) ?? null, down = this.cells.get(`${tx},${ty + 1}`) ?? null;
      const w2 = new Float32Array(c.w), a2 = new Float32Array(c.a); let anyWet = false; let spreadL = false, spreadR = false, spreadU = false, spreadD = false;
      // neighbour accessors with cross-cell lookup at the borders (a missing neighbour cell is dry paper: 0)
      const W = (x: number, y: number): number => { if (x < 0) return left ? left.w[y * HALF + HALF - 1]! : 0; if (x >= HALF) return right ? right.w[y * HALF]! : 0; if (y < 0) return up ? up.w[(HALF - 1) * HALF + x]! : 0; if (y >= HALF) return down ? down.w[x]! : 0; return c.w[y * HALF + x]!; };
      const A = (x: number, y: number, ch: number): number => { if (x < 0) return left ? left.a[(y * HALF + HALF - 1) * 3 + ch]! : 0; if (x >= HALF) return right ? right.a[(y * HALF) * 3 + ch]! : 0; if (y < 0) return up ? up.a[((HALF - 1) * HALF + x) * 3 + ch]! : 0; if (y >= HALF) return down ? down.a[x * 3 + ch]! : 0; return c.a[(y * HALF + x) * 3 + ch]!; };
      for (let y = 0; y < HALF; y++) for (let x = 0; x < HALF; x++) {
        const i = y * HALF + x; const w = c.w[i]!;
        const wl = W(x - 1, y), wr = W(x + 1, y), wu = W(x, y - 1), wd = W(x, y + 1);
        const wn = (wl + wr + wu + wd) * 0.25;
        if (w <= 0.0015 && wn <= 0.004) continue; // dry pixel with dry neighbours: nothing to do
        if (x === 0 && w > 0.02) spreadL = true; if (x === HALF - 1 && w > 0.02) spreadR = true; if (y === 0 && w > 0.02) spreadU = true; if (y === HALF - 1 && w > 0.02) spreadD = true;
        const rim = Math.max(0, w - wn); // near the boundary of the wet region
        const thin = w < 0.2 ? (0.2 - w) * 2.5 : 0;
        let nw = w - evap * (1 + 4 * rim + thin) * (0.7 + 0.5 * c.tooth[i]!);
        nw += Math.min(0.24, p.diffusion * 0.3 * dt * 12) * (wn - w);
        w2[i] = Math.max(0, nw); if (w2[i]! > 0.0015) anyWet = true;
        const dry = Math.max(0, w - Math.min(wl, wr, wu, wd)); // next to a drier cell: the rim that receives pigment
        for (let ch = 0; ch < 3; ch++) {
          const a = c.a[i * 3 + ch]!; const an = (A(x - 1, y, ch) + A(x + 1, y, ch) + A(x, y - 1, ch) + A(x, y + 1, ch)) * 0.25;
          let na = a + Math.min(0.24, p.diffusion * w * dt * 12) * (an - a); // pigment spreads only where there is water (explicit step clamped for stability)
          na -= p.edgeDark * rim * a * dt * 5;                         // the interior loses pigment toward the rim
          na += p.granulation * w * (c.tooth[i]! - 0.5) * a * dt * 1.5; // valleys collect, hills shed
          if (p.edgeDark > 0 && dry > 0.03) na *= 1 + p.edgeDark * dry * dt * 4.5; // the rim receives what the interior shed
          a2[i * 3 + ch] = Math.max(0, na);
        }
        c.age[i] = c.age[i]! + dt;
      }
      next.set(c, { w: w2, a: a2 }); c.touched = true;
      if (!anyWet) c.dirty = false;
      // water reaching a border wakes the neighbouring cell so it can take the inflow next tick
      if (spreadL && left && !left.dirty) left.dirty = true; if (spreadR && right && !right.dirty) right.dirty = true; if (spreadU && up && !up.dirty) up.dirty = true; if (spreadD && down && !down.dirty) down.dirty = true;
    }
    for (const [c, n] of next) { c.w = n.w; c.a = n.a; for (let i = 0; i < N; i++) if (c.w[i]! <= 0.0015 && c.age[i]! > 0) c.fixed[i] = 1; }
    return any;
  }
  /** Composite base + wet render into the layer tiles that changed since the last present. Returns the doc rect written. */
  present(p: WetParams): { x0: number; y0: number; x1: number; y1: number } | null {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; let wrote = false;
    for (const [key, c] of this.cells) {
      const [tx, ty] = key.split(",").map(Number) as [number, number]; this.adopt(c, tx, ty);
      if (!c.touched) continue; c.touched = false;
      const t = this.layer.getTile(tx, ty, true)!; if (!t.ctx) continue;
      const ctx = t.ctx as CanvasRenderingContext2D; const out = ctx.createImageData(TILE, TILE); const d = out.data; const b = c.base?.data ?? null;
      for (let y = 0; y < TILE; y++) {
        const cy0 = y >> 1, cy1 = Math.min(HALF - 1, cy0 + (y & 1));
        for (let x = 0; x < TILE; x++) {
          const i = (y * TILE + x) * 4; const cx0 = x >> 1, cx1 = Math.min(HALF - 1, cx0 + (x & 1));
          const i00 = cy0 * HALF + cx0, i01 = cy0 * HALF + cx1, i10 = cy1 * HALF + cx0, i11 = cy1 * HALF + cx1;
          const ar = (c.a[i00 * 3]! + c.a[i01 * 3]! + c.a[i10 * 3]! + c.a[i11 * 3]!) * 0.25, ag = (c.a[i00 * 3 + 1]! + c.a[i01 * 3 + 1]! + c.a[i10 * 3 + 1]! + c.a[i11 * 3 + 1]!) * 0.25, ab = (c.a[i00 * 3 + 2]! + c.a[i01 * 3 + 2]! + c.a[i10 * 3 + 2]! + c.a[i11 * 3 + 2]!) * 0.25;
          const wet = (c.w[i00]! + c.w[i11]!) * 0.5 * p.sheen;
          if (ar + ag + ab < 0.002 && wet < 0.002) { if (b) { d[i] = b[i]!; d[i + 1] = b[i + 1]!; d[i + 2] = b[i + 2]!; d[i + 3] = b[i + 3]!; } continue; }
          const tr = expNeg(p.absorb * ar), tg = expNeg(p.absorb * ag), tb = expNeg(p.absorb * ab);
          const alpha = Math.min(1, 1 - (tr + tg + tb) / 3 + wet);
          const pr = 255 * tr, pg = 255 * tg, pb = 255 * tb;
          const ba = b ? b[i + 3]! / 255 : 0;
          const oa = alpha + ba * (1 - alpha); if (oa <= 0) { d[i + 3] = 0; continue; }
          if (b) { const br = b[i]!, bg = b[i + 1]!, bb = b[i + 2]!;
            // over the base: the glaze multiplies the base where it exists, and shows its own colour over bare paper
            d[i] = ((pr * br / 255) * ba * alpha + pr * alpha * (1 - ba) + br * ba * (1 - alpha)) / oa;
            d[i + 1] = ((pg * bg / 255) * ba * alpha + pg * alpha * (1 - ba) + bg * ba * (1 - alpha)) / oa;
            d[i + 2] = ((pb * bb / 255) * ba * alpha + pb * alpha * (1 - ba) + bb * ba * (1 - alpha)) / oa;
          } else { d[i] = pr; d[i + 1] = pg; d[i + 2] = pb; }
          d[i + 3] = oa * 255;
        }
      }
      ctx.putImageData(out, 0, 0); t.generation++; c.gen = t.generation; wrote = true;
      x0 = Math.min(x0, tx * TILE); y0 = Math.min(y0, ty * TILE); x1 = Math.max(x1, (tx + 1) * TILE); y1 = Math.max(y1, (ty + 1) * TILE);
    }
    if (wrote) this.layer.generation++;
    return wrote ? { x0, y0, x1, y1 } : null;
  }
  /** Everything dries now: bake and forget the field (explicit dry, layer switch, undo). */
  dryNow(p: WetParams): void { for (const c of this.cells.values()) { c.w.fill(0); c.fixed.fill(1); c.dirty = false; c.touched = true; } this.present(p); this.cells.clear(); }
  /** Forget the field without writing (undo restored the pixels already). */
  discard(): void { this.cells.clear(); }
}

// ---------------------------------------------------------------- acrylic
export interface BodyParams {
  body: number;         // height added per dab 0..1 (impasto)
  open: number;         // seconds the laid paint stays mixable
  relief: number;       // baked lighting strength 0..1
  gloss: number;        // 0..1 specular sharpness of the baked highlight (gel medium / gloss varnish)
}
export const BODY_DEFAULT: BodyParams = { body: 0.5, open: 20, relief: 0.6, gloss: 0.3 };

export class BodyField {
  readonly height = new Map<string, Float32Array>(); // per tile, TILE*TILE
  readonly laidAt = new Map<string, Float32Array>(); // ms timestamp per pixel
  constructor(readonly layer: Layer) {}
  private h(tx: number, ty: number): Float32Array { const k = `${tx},${ty}`; let a = this.height.get(k); if (!a) { a = new Float32Array(TILE * TILE); this.height.set(k, a); } return a; }
  private t(tx: number, ty: number): Float32Array { const k = `${tx},${ty}`; let a = this.laidAt.get(k); if (!a) { a = new Float32Array(TILE * TILE); this.laidAt.set(k, a); } return a; }
  /** Add body under a dab footprint; bristle ridges run along the stroke direction. */
  addBody(x: number, y: number, r: number, amount: number, now: number, bristle: boolean, dir: number, fp: Footprint = DISC, rot = 0): void {
    const tx0 = Math.floor((x - r) / TILE), ty0 = Math.floor((y - r) / TILE), tx1 = Math.floor((x + r) / TILE), ty1 = Math.floor((y + r) / TILE);
    const c = Math.cos(dir), s = Math.sin(dir), cr = Math.cos(-rot), sr = Math.sin(-rot);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      if (tx < 0 || ty < 0) continue; const H = this.h(tx, ty), T = this.t(tx, ty); const ox = tx * TILE, oy = ty * TILE;
      const lx0 = Math.max(0, Math.floor(x - r - ox)), ly0 = Math.max(0, Math.floor(y - r - oy)), lx1 = Math.min(TILE - 1, Math.ceil(x + r - ox)), ly1 = Math.min(TILE - 1, Math.ceil(y + r - oy));
      for (let ly = ly0; ly <= ly1; ly++) for (let lx = lx0; lx <= lx1; lx++) {
        const dx = (lx + ox + 0.5 - x) / r, dy = (ly + oy + 0.5 - y) / r;
        let k = fp(dx * cr - dy * sr, dx * sr + dy * cr); if (k <= 0) continue;
        if (bristle) { const across = (-dx * s + dy * c) * r; k *= 0.55 + 0.45 * Math.sin(across * 1.9 + hash2(tx, ty, 3) * 6); }
        const i = ly * TILE + lx; H[i] = Math.min(4, H[i]! + amount * k); T[i] = now;
      }
    }
  }
  /** How mixable the paint at (x,y) still is: 1 just laid, 0 after `open` seconds. */
  openness(x: number, y: number, openSec: number, now: number): number {
    const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE); const T = this.laidAt.get(`${tx},${ty}`); if (!T) return 0;
    const t = T[Math.floor(y - ty * TILE) * TILE + Math.floor(x - tx * TILE)]!; if (!t) return 0; return Math.max(0, 1 - (now - t) / (Math.max(0.5, openSec) * 1000));
  }
  /** Height at a point (for a knife that rides on the paint) */
  heightAt(x: number, y: number): number { const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE); const H = this.height.get(`${tx},${ty}`); return H ? H[Math.floor(y - ty * TILE) * TILE + Math.floor(x - tx * TILE)]! : 0; }
  /** Bake impasto lighting into the tile pixels inside rect: ridges catch a key light from the top-left. */
  bake(rect: { x0: number; y0: number; x1: number; y1: number }, p: BodyParams): void {
    if (p.relief <= 0 || !Number.isFinite(rect.x0)) return;
    const lx = -0.6, ly = -0.8; const ln = Math.hypot(lx, ly, 1);
    for (let ty = Math.floor(rect.y0 / TILE); ty <= Math.floor((rect.y1 - 1) / TILE); ty++) for (let tx = Math.floor(rect.x0 / TILE); tx <= Math.floor((rect.x1 - 1) / TILE); tx++) {
      const H = this.height.get(`${tx},${ty}`); if (!H) continue; const t = this.layer.getTile(tx, ty, false); if (!t || !t.ctx) continue;
      let any = false; for (let i = 0; i < H.length; i += 7) if (H[i]! > 0.02) { any = true; break; } if (!any) continue;
      const ctx = t.ctx as CanvasRenderingContext2D; const img = ctx.getImageData(0, 0, TILE, TILE); const d = img.data;
      for (let y = 1; y < TILE - 1; y++) for (let x = 1; x < TILE - 1; x++) {
        const i = y * TILE + x; if (H[i]! <= 0.02) continue; const q = i * 4; if (d[q + 3]! < 8) continue;
        const gx = (H[i + 1]! - H[i - 1]!) * 0.5, gy = (H[i + TILE]! - H[i - TILE]!) * 0.5;
        // normal = (-gx, -gy, 1); diffuse = n·l; specular from the reflected light
        const nn = Math.hypot(gx, gy, 1); const ndl = (gx * lx + gy * ly + 1) / (nn * ln);
        const diff = 1 + p.relief * (ndl - 1 / ln) * 2.2;
        const spec = p.gloss > 0 ? p.gloss * Math.pow(Math.max(0, ndl), 8 + p.gloss * 40) * p.relief * 0.8 * Math.min(1, Math.hypot(gx, gy) * 4) : 0;
        d[q] = Math.max(0, Math.min(255, d[q]! * diff + 255 * spec)); d[q + 1] = Math.max(0, Math.min(255, d[q + 1]! * diff + 255 * spec)); d[q + 2] = Math.max(0, Math.min(255, d[q + 2]! * diff + 255 * spec));
      }
      ctx.putImageData(img, 0, 0); t.generation++;
      for (let i = 0; i < H.length; i++) H[i] = H[i]! * 0.3; // the ridge is now in the pixels; keep a little for the next pass to ride on
    }
  }
  /** Sgraffito / knife edge: scrape body away under the tool. */
  scrape(x: number, y: number, r: number): void {
    const tx0 = Math.floor((x - r) / TILE), ty0 = Math.floor((y - r) / TILE), tx1 = Math.floor((x + r) / TILE), ty1 = Math.floor((y + r) / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
      const H = this.height.get(`${tx},${ty}`); if (!H) continue; const ox = tx * TILE, oy = ty * TILE;
      for (let ly = Math.max(0, Math.floor(y - r - oy)); ly <= Math.min(TILE - 1, Math.ceil(y + r - oy)); ly++) for (let lx = Math.max(0, Math.floor(x - r - ox)); lx <= Math.min(TILE - 1, Math.ceil(x + r - ox)); lx++) { const dx = lx + ox - x, dy = ly + oy - y; if (dx * dx + dy * dy < r * r) H[ly * TILE + lx] = 0; }
    }
  }
}

// ---------------------------------------------------------------- sponge
export type SpongeKind = "natural" | "sea" | "stipple" | "synthetic";
const spongeCache = new Map<string, { canvas: HTMLCanvasElement; alpha: Uint8ClampedArray }>();
const SPONGE_S = 256;
/** Natural-sponge mask (256²): Worley cells become holes, cell walls are the sponge body, the outline is torn by noise. */
export function spongeMask(variant: SpongeKind, seed: number): { canvas: HTMLCanvasElement; alpha: Uint8ClampedArray } {
  const key = `${variant}|${seed}`; const hit = spongeCache.get(key); if (hit) return hit;
  const S = SPONGE_S; const c = document.createElement("canvas"); c.width = S; c.height = S; const g = c.getContext("2d")!; const img = g.createImageData(S, S); const d = img.data;
  const n = variant === "sea" ? 22 : variant === "stipple" ? 150 : variant === "synthetic" ? 70 : 46;
  const pts: Array<[number, number, number]> = []; for (let i = 0; i < n; i++) pts.push([hash2(i, 1, seed) * S, hash2(i, 2, seed) * S, 0.5 + hash2(i, 3, seed)]);
  const holeFrac = variant === "sea" ? 0.66 : variant === "stipple" ? 0.3 : variant === "synthetic" ? 0.45 : 0.56;
  const meanR = (S / Math.sqrt(n)) * 0.5;
  // coarse grid for the nearest-point search
  const G = 8, grid: number[][] = Array.from({ length: G * G }, () => []); for (let i = 0; i < n; i++) grid[Math.floor(pts[i]![1] / S * G) * G + Math.floor(pts[i]![0] / S * G)]!.push(i);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let d1 = 1e9, d2 = 1e9, r1 = 1; const gx = Math.floor(x / S * G), gy = Math.floor(y / S * G);
    for (let oy = -2; oy <= 2; oy++) for (let ox = -2; ox <= 2; ox++) for (const pi of grid[((gy + oy + G) % G) * G + ((gx + ox + G) % G)]!) {
      const [px, py, rr] = pts[pi]!; const dx = Math.min(Math.abs(px - x), S - Math.abs(px - x)), dy = Math.min(Math.abs(py - y), S - Math.abs(py - y)); const dd = (dx * dx + dy * dy) / rr;
      if (dd < d1) { d2 = d1; d1 = dd; r1 = rr; } else if (dd < d2) d2 = dd;
    }
    const cellR = Math.sqrt(d1), wall = Math.sqrt(d2) - Math.sqrt(d1);
    let v = variant === "stipple" ? (cellR < meanR * holeFrac ? 1 : 0) : (wall < meanR * (1 - holeFrac) * 1.1 ? 1 : 0);
    const dx = x - S / 2, dy = y - S / 2; const rad = Math.sqrt(dx * dx + dy * dy) / (S / 2);
    const torn = 0.84 + 0.16 * smooth(x, y, 21, seed + 9); if (rad > torn) v = 0; else if (rad > torn - 0.12) v *= (torn - rad) / 0.12;
    v *= 0.7 + 0.3 * hash2(x, y, seed + 5);
    const i = (y * S + x) * 4; d[i] = d[i + 1] = d[i + 2] = 0; d[i + 3] = Math.round(v * 255 * (1 - r1 * 0.08));
  }
  g.putImageData(img, 0, 0); const alpha = new Uint8ClampedArray(S * S); for (let i = 0; i < S * S; i++) alpha[i] = d[i * 4 + 3]!;
  const out = { canvas: c, alpha }; spongeCache.set(key, out); return out;
}
/** Footprint sampler for a sponge mask (u,v in -1..1) */
export function spongeFootprint(variant: SpongeKind, seed: number): Footprint {
  const { alpha } = spongeMask(variant, seed);
  return (u, v) => { if (u < -1 || u > 1 || v < -1 || v > 1) return 0; const x = Math.min(SPONGE_S - 1, ((u + 1) * 0.5 * SPONGE_S) | 0), y = Math.min(SPONGE_S - 1, ((v + 1) * 0.5 * SPONGE_S) | 0); return alpha[y * SPONGE_S + x]! / 255; };
}

// ---------------------------------------------------------------- per-layer registry
const wetFields = new WeakMap<Layer, WetField>();
const bodyFields = new WeakMap<Layer, BodyField>();
const activeWet = new Set<WetField>();
export function wetField(layer: Layer, create: true): WetField;
export function wetField(layer: Layer, create?: false): WetField | null;
export function wetField(layer: Layer, create = false): WetField | null { let f = wetFields.get(layer) ?? null; if (!f && create) { f = new WetField(layer); wetFields.set(layer, f); activeWet.add(f); } return f; }
export function bodyField(layer: Layer): BodyField { let f = bodyFields.get(layer); if (!f) { f = new BodyField(layer); bodyFields.set(layer, f); } return f; }
/** Fields that may still be drying (for the render loop). */
export function activeWetFields(): Iterable<WetField> { return activeWet; }
/** Undo / layer reset: drop the simulation state for a layer without writing. */
export function resetMedia(layer: Layer): void { const w = wetFields.get(layer); if (w) { w.discard(); activeWet.delete(w); wetFields.delete(layer); } bodyFields.delete(layer); }
export function forgetWet(f: WetField): void { activeWet.delete(f); wetFields.delete(f.layer); }
let lastMediaPresent = 0;
/** Drying step for the render loop: advances every wet field and writes the result into its layer. Returns the doc rect that changed. */
export function tickMedia(now: number): { x0: number; y0: number; x1: number; y1: number } | null {
  let out: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const f of [...activeWet]) {
    if (!f.wet) { if (!f.cells.size) forgetWet(f); else { f.dryNow(f.params); forgetWet(f); } continue; }
    f.tick(now, f.params);
    if (now - lastMediaPresent < 50) continue;
    const r = f.present(f.params); if (r) out = out ? { x0: Math.min(out.x0, r.x0), y0: Math.min(out.y0, r.y0), x1: Math.max(out.x1, r.x1), y1: Math.max(out.y1, r.y1) } : r;
  }
  if (now - lastMediaPresent >= 50) lastMediaPresent = now;
  return out;
}
/** Is anything still drying on this layer? */
export function layerWet(layer: Layer): boolean { const f = wetFields.get(layer); return !!f && f.wet; }
/** Dry a layer now (panel button). */
export function dryLayer(layer: Layer): boolean { const f = wetFields.get(layer); if (!f) return false; f.dryNow(f.params); forgetWet(f); return true; }
