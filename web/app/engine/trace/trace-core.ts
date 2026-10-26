/**
 * Redraw core: turns a picture into the parts an artist would make it from with OMNI-CELL's own tools.
 *
 *   ink        dark lines -> centre lines with a width at every point (G-Pen strokes),
 *              solid black areas -> filled shapes
 *   flats      one colour per region (the lit colour of that material), under the ink
 *   shadows    cel-shading: per region, one or two darker levels as multiply colours
 *   light      per region, a highlight level as a screen colour
 *   tones      the same picture as screentone densities (manga), from the cel reconstruction
 *
 * Pure functions over typed arrays (no DOM), so it runs in a worker and in unit tests.
 * Everything is in working-image pixels; the caller maps to page coordinates.
 */

export interface TraceParams {
  /** 0..1: how readily a dark edge counts as a line */
  lineSensitivity: number;
  /** number of colour clusters for flats (8..48) */
  detail: number;
  /** regions smaller than this many working pixels merge into a neighbour (0 = auto) */
  minRegion: number;
  /** 1 or 2 shadow levels */
  shadowLevels: 1 | 2;
  /** L* drop (0..100) that counts as shadow; the second level is 2.6x this */
  shadowStep: number;
  /** L* rise that counts as highlight (0 = no highlight layer) */
  highlightStep: number;
  /** half-width (px) above which ink is a filled area, not a stroke */
  solidInk: number;
  /** screentone densities to quantise to (manga) */
  toneLevels: number[];
  /** 0..1: line centre smoothing */
  lineSmoothing: number;
  /**
   * 0..1: how much of the difference between the picture and its cel reconstruction (gradients,
   * airbrushed blush, soft shadows) is painted back as airbrush dabs on a Soft shading layer.
   * 0 = pure cel, 1 = follow the source fully.
   */
  soft: number;
  /** join stroke pieces whose ends meet within this many px with aligned tangents (hair, crossings); 0 = off */
  chainGap: number;
}
export const TRACE_DEFAULTS: TraceParams = { lineSensitivity: 0.55, detail: 20, minRegion: 0, shadowLevels: 2, shadowStep: 7, highlightStep: 9, solidInk: 3.5, toneLevels: [0.1, 0.2, 0.3, 0.45, 0.6, 0.75], lineSmoothing: 0.5, soft: 1, chainGap: 3 };

export type RGB = [number, number, number];
/** x, y, width triplets along a stroke centre line */
export interface TraceStroke { pts: Float32Array; color: RGB }
/** closed loops (x, y pairs), filled even-odd */
export interface TraceShape { loops: Float32Array[]; color: RGB; box: [number, number, number, number] }
export interface TraceTone { density: number; shapes: TraceShape[] }
export interface TraceResult {
  w: number; h: number;
  strokes: TraceStroke[]; inkFills: TraceShape[];
  flats: TraceShape[]; shadows: TraceShape[]; highlights: TraceShape[]; tones: TraceTone[];
  /** source ink mask (1 = line, 2 = solid black area), for scoring the redraw */
  inkMask: Uint8Array;
  /** airbrush dabs for the Soft shading layer: x, y, radius, R, G, B, alpha per dab */
  soft: Float32Array;
  /** pixels the source actually covers (alpha); null = all */
  mask: Uint8Array | null;
  stats: { inkPx: number; strokes: number; regions: number; palette: number; softDabs: number; chained: number; ms: Record<string, number> };
}

// ---------------------------------------------------------------- colour
const lin = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; lin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
export function toLab(rgba: Uint8ClampedArray | Uint8Array, n: number): { L: Float32Array; A: Float32Array; B: Float32Array } {
  const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = lin[rgba[i * 4]!]!, g = lin[rgba[i * 4 + 1]!]!, b = lin[rgba[i * 4 + 2]!]!;
    const x = fLab((r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047), y = fLab(r * 0.2126 + g * 0.7152 + b * 0.0722), z = fLab((r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883);
    L[i] = 116 * y - 16; A[i] = 500 * (x - y); B[i] = 200 * (y - z);
  }
  return { L, A, B };
}

// ---------------------------------------------------------------- morphology and distance
/** separable box blur, radius r, in place via a temp */
export function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h); const k = 2 * r + 1;
  for (let y = 0; y < h; y++) { let s = 0; const o = y * w; for (let x = -r; x <= r; x++) s += src[o + Math.min(w - 1, Math.max(0, x))]!; for (let x = 0; x < w; x++) { tmp[o + x] = s / k; s += src[o + Math.min(w - 1, x + r + 1)]! - src[o + Math.max(0, x - r)]!; } }
  for (let x = 0; x < w; x++) { let s = 0; for (let y = -r; y <= r; y++) s += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!; for (let y = 0; y < h; y++) { out[y * w + x] = s / k; s += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!; } }
  return out;
}
/** separable max filter (square window 2r+1) */
export function maxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) { const o = y * w; for (let x = 0; x < w; x++) { let m = -Infinity; for (let d = Math.max(0, x - r); d <= Math.min(w - 1, x + r); d++) if (src[o + d]! > m) m = src[o + d]!; tmp[o + x] = m; } }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let m = -Infinity; for (let d = Math.max(0, y - r); d <= Math.min(h - 1, y + r); d++) if (tmp[d * w + x]! > m) m = tmp[d * w + x]!; out[y * w + x] = m; }
  return out;
}
/** 1-D squared distance transform (Felzenszwalb & Huttenlocher) */
function dt1(f: Float32Array, n: number, d: Float32Array, v: Int32Array, z: Float32Array): void {
  let k = 0; v[0] = 0; z[0] = -Infinity; z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!);
    while (s <= z[k]!) { k--; s = ((f[q]! + q * q) - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!); }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  k = 0; for (let q = 0; q < n; q++) { while (z[k + 1]! < q) k++; d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!; }
}
/** Euclidean distance from each pixel where mask=1 to the nearest pixel where mask=0 (0 outside the mask) */
export function edt(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12; const g = new Float32Array(w * h);
  const n = Math.max(w, h); const f = new Float32Array(n), d = new Float32Array(n), v = new Int32Array(n), z = new Float32Array(n + 1);
  for (let x = 0; x < w; x++) { for (let y = 0; y < h; y++) f[y] = mask[y * w + x] ? INF : 0; dt1(f, h, d, v, z); for (let y = 0; y < h; y++) g[y * w + x] = d[y]!; }
  for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) f[x] = g[y * w + x]!; dt1(f, w, d, v, z); for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]!); }
  return g;
}

/** connected components (8- or 4-connected) of mask=1; returns labels (0 = none) and sizes */
export function components(mask: Uint8Array, w: number, h: number, eight = true): { lab: Int32Array; sizes: number[] } {
  const lab = new Int32Array(w * h); const sizes = [0]; const stack = new Int32Array(w * h); let next = 1;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || lab[i]) continue;
    let sp = 0; stack[sp++] = i; lab[i] = next; let size = 0;
    while (sp) {
      const p = stack[--sp]!; size++; const x = p % w, y = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; if (!eight && dx && dy) continue;
        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx; if (mask[q] && !lab[q]) { lab[q] = next; stack[sp++] = q; }
      }
    }
    sizes.push(size); next++;
  }
  return { lab, sizes };
}

// ---------------------------------------------------------------- thinning and centre lines
/** Zhang-Suen thinning, in place */
export function thin(m: Uint8Array, w: number, h: number): void {
  const del: number[] = [];
  for (let iter = 0; iter < 200; iter++) {
    let changed = false;
    for (const pass of [0, 1]) {
      del.length = 0;
      for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x; if (!m[i]) continue;
        const p2 = m[i - w]!, p3 = m[i - w + 1]!, p4 = m[i + 1]!, p5 = m[i + w + 1]!, p6 = m[i + w]!, p7 = m[i + w - 1]!, p8 = m[i - 1]!, p9 = m[i - w - 1]!;
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9; if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]; let A = 0; for (let k = 0; k < 8; k++) if (!seq[k] && seq[k + 1]) A++;
        if (A !== 1) continue;
        if (pass === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(i);
      }
      for (const i of del) m[i] = 0; if (del.length) changed = true;
    }
    if (!changed) break;
  }
}
const N8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]] as const; // 4-neighbours first: straighter walks
/**
 * Zhang-Suen leaves staircase corners: an L of three pixels where the corner pixel is redundant
 * (its two 4-neighbours already touch diagonally). Such pixels have three neighbours and read as
 * junctions, which chopped every curved line into 2-pixel pieces. Remove them so a line pixel has
 * exactly two neighbours.
 */
export function cleanCorners(m: Uint8Array, w: number, h: number): void {
  const ring = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as const; // N NE E SE S SW W NW
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x; if (!m[i]) continue;
      const v = ring.map(([dx, dy]) => m[(y + dy) * w + x + dx]!);
      const n = v.reduce((a, b) => a + b, 0); if (n < 2) continue;
      const corner = (v[0] && v[2]) || (v[2] && v[4]) || (v[4] && v[6]) || (v[6] && v[0]); if (!corner) continue;
      // foreground neighbours must form one 8-connected group around the ring (removing p keeps them joined)
      const parent = [0, 1, 2, 3, 4, 5, 6, 7]; const find = (a: number): number => (parent[a] === a ? a : (parent[a] = find(parent[a]!)));
      for (let k = 0; k < 8; k++) { if (!v[k]) continue; const k1 = (k + 1) % 8; if (v[k1]) parent[find(k)] = find(k1); if (k % 2 === 0) { const k2 = (k + 2) % 8; if (v[k2]) parent[find(k)] = find(k2); } }
      const roots = new Set<number>(); for (let k = 0; k < 8; k++) if (v[k]) roots.add(find(k));
      if (roots.size === 1) { m[i] = 0; changed = true; }
    }
    if (!changed) break;
  }
}

/** walk a 1-px skeleton into polylines between end points and junctions (and closed loops) */
export function traceSkeleton(sk: Uint8Array, w: number, h: number): number[][] {
  const deg = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (!sk[i]) continue; let c = 0; for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx]) c++; } deg[i] = c; }
  const used = new Uint8Array(w * h); const paths: number[][] = [];
  const isNode = (i: number) => deg[i] !== 2;
  const nbrs = (i: number) => { const x = i % w, y = (i / w) | 0; const out: number[] = []; for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx]) out.push(ny * w + nx); } return out; };
  const walk = (start: number, first: number) => {
    const path = [start, first]; let prev = start, cur = first; if (!isNode(first)) used[first] = 1;
    for (let guard = 0; guard < w * h && !isNode(cur); guard++) {
      const nx = nbrs(cur).filter((q) => q !== prev && (!used[q] || isNode(q)) && !(isNode(q) && q === start && path.length < 3));
      if (!nx.length) break; const q = nx[0]!; path.push(q); if (!isNode(q)) used[q] = 1; prev = cur; cur = q;
    }
    return path;
  };
  for (let i = 0; i < w * h; i++) {
    if (!sk[i] || !isNode(i)) continue;
    if (deg[i] === 0) { paths.push([i]); continue; }
    for (const q of nbrs(i)) { if (used[q] && !isNode(q)) continue; if (isNode(q) && q < i) continue; paths.push(walk(i, q)); }
  }
  for (let i = 0; i < w * h; i++) { // closed loops with no nodes
    if (!sk[i] || used[i] || isNode(i)) continue;
    used[i] = 1; const n = nbrs(i); if (!n.length) continue; const p = walk(i, n[0]!); p.push(i); paths.push(p);
  }
  return paths;
}

const degreeAt = (sk: Uint8Array, w: number, h: number, i: number) => { const x = i % w, y = (i / w) | 0; let c = 0; for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && sk[ny * w + nx]) c++; } return c; };
/** remove short side branches (thinning leaves them where a line has a bump or an anti-aliased corner) */
export function pruneSpurs(sk: Uint8Array, w: number, h: number, maxLen: (junction: number) => number): void {
  for (let round = 0; round < 2; round++) {
    const ends: number[] = []; for (let i = 0; i < w * h; i++) if (sk[i] && degreeAt(sk, w, h, i) === 1) ends.push(i);
    for (const e of ends) {
      if (!sk[e]) continue; const chain = [e]; let prev = -1, cur = e; let junction = -1;
      for (let guard = 0; guard < 64; guard++) {
        const x = cur % w, y = (cur / w) | 0; let next = -1;
        for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const q = ny * w + nx; if (!sk[q] || q === prev || chain.includes(q)) continue; next = q; break; }
        if (next < 0) break;
        if (degreeAt(sk, w, h, next) >= 3) { junction = next; break; }
        chain.push(next); prev = cur; cur = next;
      }
      if (junction >= 0 && chain.length <= maxLen(junction)) for (const q of chain) sk[q] = 0;
    }
  }
}
/**
 * Join centre-line pieces that meet at a junction and continue each other (directions within ~40
 * degrees of straight through), so a line crossing another stays one stroke instead of several
 * pieces with a cap at every crossing.
 */
export function joinAtJunctions(paths: number[][], sk: Uint8Array, w: number, h: number): number[][] {
  type End = { path: number; start: boolean };
  const alive = paths.map(() => true); const list = paths.map((p) => p.slice());
  const dirOf = (p: number[], start: boolean) => { const n = p.length; const a = start ? p[0]! : p[n - 1]!; const b = start ? p[Math.min(n - 1, 5)]! : p[Math.max(0, n - 6)]!; const dx = (b % w) - (a % w), dy = ((b / w) | 0) - ((a / w) | 0); const L = Math.hypot(dx, dy) || 1; return [dx / L, dy / L] as const; };
  // group path ends that sit on (or next to) the same junction cluster
  const cell = new Map<number, End[]>(); const key = (i: number) => (Math.floor((i % w) / 3) * 100003 + Math.floor(((i / w) | 0) / 3));
  list.forEach((p, k) => { if (p.length < 3) return; for (const start of [true, false]) { const at = start ? p[0]! : p[p.length - 1]!; if (degreeAt(sk, w, h, at) < 3 && degreeAt(sk, w, h, at) !== 0) { /* endpoint of a free line: not a junction */ if (degreeAt(sk, w, h, at) === 1) continue; } const kk = key(at); (cell.get(kk) ?? cell.set(kk, []).get(kk)!).push({ path: k, start }); } });
  // a path id can be replaced by a joined path; follow the redirects (and flips) to the live one
  const redirect = new Map<number, { to: number; flip: boolean }>();
  const resolve = (e: End): End => { let cur = e; for (let g = 0; g < 64; g++) { const r = redirect.get(cur.path); if (!r) return cur; cur = { path: r.to, start: r.flip ? !cur.start : cur.start }; } return cur; };
  for (const ends of cell.values()) {
    if (ends.length < 2) continue;
    const used = new Set<number>();
    const cand: Array<{ a: number; b: number; score: number }> = [];
    for (let i = 0; i < ends.length; i++) for (let j = i + 1; j < ends.length; j++) {
      const A = resolve(ends[i]!), B = resolve(ends[j]!); if (A.path === B.path || !alive[A.path] || !alive[B.path]) continue;
      const da = dirOf(list[A.path]!, A.start), db = dirOf(list[B.path]!, B.start);
      const straight = -(da[0] * db[0] + da[1] * db[1]); // 1 = continues straight through
      if (straight > 0.76) cand.push({ a: i, b: j, score: straight });
    }
    cand.sort((x, y) => y.score - x.score);
    for (const c of cand) {
      if (used.has(c.a) || used.has(c.b)) continue;
      const A = resolve(ends[c.a]!), B = resolve(ends[c.b]!); if (A.path === B.path || !alive[A.path] || !alive[B.path]) continue;
      used.add(c.a); used.add(c.b);
      const pa = A.start ? list[A.path]!.slice().reverse() : list[A.path]!; // junction end last
      const pb = B.start ? list[B.path]! : list[B.path]!.slice().reverse(); // junction end first
      const joined = pa.concat(pb); const id = list.length; list.push(joined); alive.push(true);
      alive[A.path] = false; alive[B.path] = false;
      // A's far end is now the joined start; B's far end is the joined end
      redirect.set(A.path, { to: id, flip: A.start }); redirect.set(B.path, { to: id, flip: !B.start });
    }
  }
  return list.filter((_, k) => alive[k]);
}

/**
 * Join strokes whose ends nearly touch and continue each other: hair drawn as overlapping lines
 * thins into pieces at every crossing and anti-aliased kink. Greedy on a score of gap distance and
 * tangent alignment; the gap is bridged by the join itself. Returns the number of joins made.
 */
export function chainStrokes(strokes: TraceStroke[], maxGap: number): number {
  if (maxGap <= 0 || strokes.length < 2) return 0;
  const alive = strokes.map(() => true); let joins = 0;
  const tangent = (p: Float32Array, atStart: boolean): [number, number, number, number] => {
    const n = p.length / 3; const i0 = atStart ? 0 : n - 1; const i1 = atStart ? Math.min(n - 1, 3) : Math.max(0, n - 4);
    let dx = p[i0 * 3]! - p[i1 * 3]!, dy = p[i0 * 3 + 1]! - p[i1 * 3 + 1]!; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    return [p[i0 * 3]!, p[i0 * 3 + 1]!, dx, dy]; // position and OUTWARD direction at that end
  };
  const cellOf = (x: number, y: number) => Math.floor(x / maxGap) * 1000003 + Math.floor(y / maxGap);
  for (let round = 0; round < 3; round++) {
    const grid = new Map<number, Array<{ s: number; start: boolean }>>();
    strokes.forEach((st, k) => { if (!alive[k] || st.pts.length < 6) return; for (const start of [true, false]) { const t = tangent(st.pts, start); const key = cellOf(t[0], t[1]); (grid.get(key) ?? grid.set(key, []).get(key)!).push({ s: k, start }); } });
    const cand: Array<{ a: number; as: boolean; b: number; bs: boolean; score: number }> = [];
    for (const [key, ends] of grid) {
      const cx = Math.floor(key / 1000003), cy = key % 1000003;
      const near: Array<{ s: number; start: boolean }> = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const l = grid.get((cx + dx) * 1000003 + (cy + dy)); if (l) near.push(...l); }
      for (const A of ends) for (const B of near) {
        if (A.s >= B.s && !(A.s === B.s && A.start && !B.start)) continue; if (A.s === B.s) continue;
        const ta = tangent(strokes[A.s]!.pts, A.start), tb = tangent(strokes[B.s]!.pts, B.start);
        const gx = tb[0] - ta[0], gy = tb[1] - ta[1]; const gap = Math.hypot(gx, gy); if (gap > maxGap) continue;
        const wa = A.start ? strokes[A.s]!.pts[2]! : strokes[A.s]!.pts[strokes[A.s]!.pts.length - 1]!;
        const wb = B.start ? strokes[B.s]!.pts[2]! : strokes[B.s]!.pts[strokes[B.s]!.pts.length - 1]!;
        if (Math.max(wa, wb) > 2.5 * Math.min(wa, wb) + 1) continue; // a thin hair does not continue a thick outline
        const straight = -(ta[2] * tb[2] + ta[3] * tb[3]); if (straight < 0.72) continue; // tangents oppose: continues through
        let along = 1; if (gap > 0.5) { along = (gx * ta[2] + gy * ta[3]) / gap; if (along < 0.5) continue; }
        cand.push({ a: A.s, as: A.start, b: B.s, bs: B.start, score: straight + along - gap / maxGap });
      }
    }
    if (!cand.length) break;
    cand.sort((x, y) => y.score - x.score);
    const usedEnd = new Set<string>(); let made = 0;
    for (const c of cand) {
      if (!alive[c.a] || !alive[c.b]) continue; const ka = `${c.a}:${c.as}`, kb = `${c.b}:${c.bs}`; if (usedEnd.has(ka) || usedEnd.has(kb)) continue;
      const pa = strokes[c.a]!.pts, pb = strokes[c.b]!.pts;
      const rev = (p: Float32Array) => { const n = p.length / 3; const o = new Float32Array(p.length); for (let i = 0; i < n; i++) { o[i * 3] = p[(n - 1 - i) * 3]!; o[i * 3 + 1] = p[(n - 1 - i) * 3 + 1]!; o[i * 3 + 2] = p[(n - 1 - i) * 3 + 2]!; } return o; };
      const first = c.as ? rev(pa) : pa; const second = c.bs ? pb : rev(pb);
      const joined = new Float32Array(first.length + second.length); joined.set(first, 0); joined.set(second, first.length);
      const ca = strokes[c.a]!.color, cb = strokes[c.b]!.color; const na = first.length, nb = second.length;
      strokes[c.a] = { pts: joined, color: na >= nb ? ca : cb }; alive[c.b] = false; usedEnd.add(ka); usedEnd.add(kb);
      // the joined stroke's ends are now A's other end and B's other end; mark both ends of B as used so nothing else grabs the dead stroke
      usedEnd.add(`${c.b}:${!c.bs}`); usedEnd.add(`${c.a}:${!c.as}`); joins++; made++;
    }
    if (!made) break;
    const kept = strokes.filter((_, k) => alive[k]); strokes.length = 0; strokes.push(...kept); alive.length = 0; for (let k = 0; k < strokes.length; k++) alive.push(true);
  }
  return joins;
}

/** Ramer-Douglas-Peucker on (x, y, extra) triplets */
function rdp3(p: number[], eps: number): number[] {
  const n = p.length / 3; if (n < 3) return p;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!; const ax = p[a * 3]!, ay = p[a * 3 + 1]!, bx = p[b * 3]!, by = p[b * 3 + 1]!; const dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((p[i * 3]! - ax) * dy - (p[i * 3 + 1]! - ay) * dx) / L; const dw = Math.abs(p[i * 3 + 2]! - (p[a * 3 + 2]! + (p[b * 3 + 2]! - p[a * 3 + 2]!) * ((i - a) / (b - a)))); const e = Math.max(d, dw * 0.5); if (e > bd) { bd = e; best = i; } }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  const out: number[] = []; for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!); return out;
}
function rdp2(p: Float32Array, eps: number): Float32Array {
  const n = p.length / 2; if (n < 4) return p;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1; const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!; const ax = p[a * 2]!, ay = p[a * 2 + 1]!, dx = p[b * 2]! - ax, dy = p[b * 2 + 1]! - ay; const L = Math.hypot(dx, dy) || 1e-9;
    let best = -1, bd = eps;
    for (let i = a + 1; i < b; i++) { const d = L > 1e-6 ? Math.abs((p[i * 2]! - ax) * dy - (p[i * 2 + 1]! - ay) * dx) / L : Math.hypot(p[i * 2]! - ax, p[i * 2 + 1]! - ay); if (d > bd) { bd = d; best = i; } }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  let c = 0; for (let i = 0; i < n; i++) if (keep[i]) c++; const out = new Float32Array(c * 2); let j = 0; for (let i = 0; i < n; i++) if (keep[i]) { out[j++] = p[i * 2]!; out[j++] = p[i * 2 + 1]!; } return out;
}

// ---------------------------------------------------------------- contours (marching squares)
let ADJ = new Int32Array(0); let SEEN = new Uint8Array(0);
/**
 * Closed outlines of mask=1 inside box [x0, y0, x1, y1), as smooth sub-pixel loops: the mask is
 * blurred 3x3 first, so the 0.5 iso-line rounds stair-steps into the curve the pixels sample.
 */
export function contours(mask: Uint8Array | ((i: number) => boolean), w: number, h: number, box: [number, number, number, number], eps = 0.35): Float32Array[] {
  const [bx0, by0, bx1, by1] = box; const W = bx1 - bx0 + 4, H = by1 - by0 + 4; // 2 px pad
  const m = new Float32Array(W * H); const test = typeof mask === "function" ? mask : (i: number) => mask[i] === 1;
  for (let y = by0; y < by1; y++) for (let x = bx0; x < bx1; x++) if (test(y * w + x)) m[(y - by0 + 2) * W + (x - bx0 + 2)] = 1;
  const f = boxBlur(m, W, H, 1);
  const val = (x: number, y: number) => f[y * W + x]!;
  // edge ids: H(x,y) = (y*W+x)*2, V(x,y) = (y*W+x)*2+1; typed adjacency (each edge point joins two segments)
  const E = W * H * 2;
  if (ADJ.length < E * 2) { ADJ = new Int32Array(E * 2).fill(-1); SEEN = new Uint8Array(E); }
  const adj = ADJ, seen = SEEN; const onList: number[] = []; // scratch reused across calls; only touched entries are reset
  const link = (a: number, b: number) => {
    if (adj[a * 2]! < 0) { adj[a * 2] = b; onList.push(a); } else adj[a * 2 + 1] = b;
    if (adj[b * 2]! < 0) { adj[b * 2] = a; onList.push(b); } else adj[b * 2 + 1] = a;
  };
  const edgePt = (id: number, out: number[]) => {
    const cell = id >> 1, x = cell % W, y = (cell / W) | 0;
    if ((id & 1) === 0) { const a = val(x, y), b = val(x + 1, y); const t = Math.abs(b - a) > 1e-6 ? (0.5 - a) / (b - a) : 0.5; out.push(x + t + bx0 - 1.5, y + by0 - 1.5); }
    else { const a = val(x, y), b = val(x, y + 1); const t = Math.abs(b - a) > 1e-6 ? (0.5 - a) / (b - a) : 0.5; out.push(x + bx0 - 1.5, y + t + by0 - 1.5); }
  };
  for (let y = 0; y < H - 1; y++) for (let x = 0; x < W - 1; x++) {
    const v00 = val(x, y), v10 = val(x + 1, y), v11 = val(x + 1, y + 1), v01 = val(x, y + 1);
    const c = (v00 >= 0.5 ? 8 : 0) | (v10 >= 0.5 ? 4 : 0) | (v11 >= 0.5 ? 2 : 0) | (v01 >= 0.5 ? 1 : 0); if (c === 0 || c === 15) continue;
    const T = (y * W + x) * 2, B = ((y + 1) * W + x) * 2, Lf = (y * W + x) * 2 + 1, R = (y * W + x + 1) * 2 + 1;
    const centre = (v00 + v10 + v11 + v01) / 4 >= 0.5;
    switch (c) {
      case 1: case 14: link(Lf, B); break;
      case 2: case 13: link(B, R); break;
      case 3: case 12: link(Lf, R); break;
      case 4: case 11: link(T, R); break;
      case 6: case 9: link(T, B); break;
      case 7: case 8: link(Lf, T); break;
      case 5: if (centre) { link(Lf, T); link(B, R); } else { link(T, R); link(Lf, B); } break;
      case 10: if (centre) { link(T, R); link(Lf, B); } else { link(Lf, T); link(B, R); } break;
    }
  }
  const loops: Float32Array[] = [];
  for (const start of onList) {
    if (seen[start]) continue;
    const pts: number[] = []; let prev = -1, cur = start;
    for (let guard = 0; guard < E; guard++) {
      seen[cur] = 1; edgePt(cur, pts);
      const a0 = adj[cur * 2]!, a1 = adj[cur * 2 + 1]!;
      const nx = a0 >= 0 && a0 !== prev && !seen[a0] ? a0 : a1 >= 0 && a1 !== prev && !seen[a1] ? a1 : -1;
      if (nx < 0) break; prev = cur; cur = nx;
    }
    if (pts.length >= 6) loops.push(rdp2(new Float32Array(pts), eps));
  }
  for (const e of onList) { adj[e * 2] = -1; adj[e * 2 + 1] = -1; seen[e] = 0; }
  return loops;
}

// ---------------------------------------------------------------- k-means in Lab
export function kmeans(feat: Float32Array, n: number, dim: number, k: number, iters: number, seed = 7): Float32Array {
  let s = seed; const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const sample = Math.min(n, 30000); const idx = new Int32Array(sample); for (let i = 0; i < sample; i++) idx[i] = n <= sample ? i : Math.floor(rnd() * n);
  const C = new Float32Array(k * dim); const dist = new Float32Array(sample).fill(Infinity);
  const first = idx[Math.floor(rnd() * sample)]!; for (let d = 0; d < dim; d++) C[d] = feat[first * dim + d]!;
  for (let c = 1; c < k; c++) { // k-means++
    let tot = 0;
    for (let i = 0; i < sample; i++) { const p = idx[i]!; let dd = 0; for (let d = 0; d < dim; d++) { const t = feat[p * dim + d]! - C[(c - 1) * dim + d]!; dd += t * t; } if (dd < dist[i]!) dist[i] = dd; tot += dist[i]!; }
    let r = rnd() * tot, pick = idx[0]!; for (let i = 0; i < sample; i++) { r -= dist[i]!; if (r <= 0) { pick = idx[i]!; break; } }
    for (let d = 0; d < dim; d++) C[c * dim + d] = feat[pick * dim + d]!;
  }
  const sum = new Float64Array(k * dim), cnt = new Int32Array(k);
  for (let it = 0; it < iters; it++) {
    sum.fill(0); cnt.fill(0);
    for (let i = 0; i < sample; i++) { const p = idx[i]!; let best = 0, bd = Infinity; for (let c = 0; c < k; c++) { let dd = 0; for (let d = 0; d < dim; d++) { const t = feat[p * dim + d]! - C[c * dim + d]!; dd += t * t; } if (dd < bd) { bd = dd; best = c; } } cnt[best] = cnt[best]! + 1; for (let d = 0; d < dim; d++) sum[best * dim + d] = sum[best * dim + d]! + feat[p * dim + d]!; }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let d = 0; d < dim; d++) C[c * dim + d] = sum[c * dim + d]! / cnt[c]!;
  }
  return C;
}
export function nearestCentre(C: Float32Array, k: number, dim: number, v: ArrayLike<number>): number { let best = 0, bd = Infinity; for (let c = 0; c < k; c++) { let dd = 0; for (let d = 0; d < dim; d++) { const t = v[d]! - C[c * dim + d]!; dd += t * t; } if (dd < bd) { bd = dd; best = c; } } return best; }

// ---------------------------------------------------------------- main
export function trace(rgba: Uint8ClampedArray, w: number, h: number, params: Partial<TraceParams> = {}, progress?: (stage: string, pct: number) => void, mask: Uint8Array | null = null): TraceResult {
  const P = { ...TRACE_DEFAULTS, ...params }; const N = w * h; const ms: Record<string, number> = {}; let t0 = Date.now();
  // `mask` marks the pixels the picture covers (alpha >= 50%); outside it nothing is traced or scored
  const inMask = (i: number) => !mask || mask[i] === 1;
  const mark = (k: string) => { const t = Date.now(); ms[k] = t - t0; t0 = t; };
  progress?.("colour", 0.02);
  const { L, A, B } = toLab(rgba, N);
  const scale = Math.sqrt(N / 1e6); // features sized for ~1 Mpx, scaled with resolution
  // ---- 1. ink: darker than the local paper/colour around it, or near-black
  progress?.("lines", 0.08);
  const r = Math.max(2, Math.round(3 * scale));
  // Line = darker than the paper on BOTH sides along some direction (a valley). The edge between a
  // dark area and a light one is darker on one side only, so colour boundaries (an iris, a shadow
  // edge) no longer turn into outlines; wide dark areas are caught by the near-black test instead.
  const valley = new Float32Array(N); const R2 = Math.max(6, Math.round(6 * scale)); // finds lines up to ~2*R2 px wide
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; const l0 = L[i]!; let best = 0;
    for (const [dx, dy] of [[1, 0], [0, 1], [1, 1], [1, -1]] as const) {
      let a = l0, b = l0;
      for (let k = 1; k <= R2; k++) { const xa = x + dx * k, ya = y + dy * k, xb = x - dx * k, yb = y - dy * k; if (xa >= 0 && ya >= 0 && xa < w && ya < h) { const v = L[ya * w + xa]!; if (v > a) a = v; } if (xb >= 0 && yb >= 0 && xb < w && yb < h) { const v = L[yb * w + xb]!; if (v > b) b = v; } }
      const v = Math.min(a, b) - l0; if (v > best) best = v;
    }
    valley[i] = best;
  }
  const bg = valley; // kept name: "how much darker than its surroundings" below
  const sens = Math.min(1, Math.max(0, P.lineSensitivity));
  const T = 30 - 22 * sens, abs = 8 + 14 * sens;
  let ink = new Uint8Array(N);
  for (let i = 0; i < N; i++) { const d = bg[i]!; if (((d > T && L[i]! < 72) || L[i]! < abs) && inMask(i)) ink[i] = 1; }
  { const { lab, sizes } = components(ink, w, h); const minA = Math.max(3, Math.round(4 * scale * scale)); for (let i = 0; i < N; i++) if (ink[i] && sizes[lab[i]!]! < minA) ink[i] = 0; }
  const inkMask = ink.slice();
  const dist = edt(ink, w, h);
  // The loose mask includes anti-aliased fringes: right for topology, too wide for width. The core
  // (clearly dark) mask gives line widths and decides what is a solid black area, so densely
  // overlapping hatching is not mistaken for a fill.
  const inkCore = new Uint8Array(N); for (let i = 0; i < N; i++) { const d = bg[i]!; if (((d > T * 1.7 && L[i]! < 60) || L[i]! < abs) && inMask(i)) inkCore[i] = 1; }
  const distCore = edt(inkCore, w, h);
  // solid areas: the core ink that survives an opening by solidInk px
  const thick = P.solidInk * Math.max(1, scale);
  const core = new Uint8Array(N); for (let i = 0; i < N; i++) if (distCore[i]! > thick) core[i] = 1;
  const notCore = new Uint8Array(N); for (let i = 0; i < N; i++) notCore[i] = core[i] ? 0 : 1;
  const toCore = edt(notCore, w, h);
  const solid = new Uint8Array(N); let solidPx = 0; for (let i = 0; i < N; i++) if (inkCore[i] && toCore[i]! <= thick + 0.75) { solid[i] = 1; solidPx++; }
  mark("ink");
  // ---- 2. ink palette (lines are often coloured in anime art)
  const inkIdx: number[] = []; for (let i = 0; i < N; i += 1) if (ink[i]) inkIdx.push(i);
  const kInk = Math.min(6, Math.max(1, Math.round(inkIdx.length / 4000)));
  const inkFeat = new Float32Array(inkIdx.length * 3); inkIdx.forEach((p, j) => { inkFeat[j * 3] = L[p]!; inkFeat[j * 3 + 1] = A[p]!; inkFeat[j * 3 + 2] = B[p]!; });
  const inkC = inkIdx.length ? kmeans(inkFeat, inkIdx.length, 3, kInk, 8, 3) : new Float32Array(3);
  const inkRGBsum = new Float64Array(kInk * 3), inkCnt = new Int32Array(kInk); const inkCluster = new Int8Array(N).fill(-1);
  inkIdx.forEach((p, j) => { const c = nearestCentre(inkC, kInk, 3, [inkFeat[j * 3]!, inkFeat[j * 3 + 1]!, inkFeat[j * 3 + 2]!]); inkCluster[p] = c; inkCnt[c] = inkCnt[c]! + 1; for (let d = 0; d < 3; d++) inkRGBsum[c * 3 + d] = inkRGBsum[c * 3 + d]! + rgba[p * 4 + d]!; });
  // lines read darker than their anti-aliased average: pull the palette 15% toward its darkest member
  const inkPal: RGB[] = []; for (let c = 0; c < kInk; c++) { const n = Math.max(1, inkCnt[c]!); inkPal.push([0, 1, 2].map((d) => Math.round((inkRGBsum[c * 3 + d]! / n) * 0.85)) as RGB); }
  // ---- 3. strokes from the thin ink
  progress?.("strokes", 0.18);
  // Centre lines of ALL ink, solid areas included: subtracting the solid parts left hollow rims around
  // thick lines (glasses frames came out as two thin outlines). Solid areas are filled as well below,
  // so their exact outline is kept and the wide strokes inside them only add the pen texture.
  const thinM = ink.slice();
  thin(thinM, w, h); cleanCorners(thinM, w, h);
  // the drawn width at a centre-line pixel: from the core mask where the line is clearly dark, else
  // from the loose mask minus its fringe; less the Trace Pen's own 0.4 px anti-aliasing skirt
  // Width across the line at a centre pixel, measured as the full width at half the valley depth:
  // walk out from the centre in each of four directions until lightness rises halfway from the
  // centre value to the paper beside the line (with sub-pixel interpolation), and take the
  // narrowest direction. Threshold-free, so a dark red line or a thick soft one measures the
  // same width an eye sees. Lines wider than the search radius (solid areas) use the distance
  // transform of the core mask as before.
  const DIRS = [[1, 0, 1], [0, 1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2]] as const;
  const fwhmAt = (p: number): number => {
    const x = p % w, y = (p / w) | 0; const l0 = L[p]!; const depth = bg[p]!; if (depth < 4) return -1;
    const thr = l0 + 0.5 * depth; let best = -1;
    for (const [dx, dy, step] of DIRS) {
      let total = 0, ok = true;
      for (const sgn of [1, -1]) {
        let prev = l0, found = false;
        for (let k = 1; k <= R2; k++) { const xx = x + sgn * dx * k, yy = y + sgn * dy * k; if (xx < 0 || yy < 0 || xx >= w || yy >= h) break; const v = L[yy * w + xx]!; if (v >= thr) { const f = (thr - prev) / Math.max(1e-3, v - prev); total += (k - 1 + Math.min(1, Math.max(0, f))) * step; found = true; break; } prev = v; }
        if (!found) { ok = false; break; }
      }
      if (ok && (best < 0 || total < best)) best = total;
    }
    return best;
  };
  const widthAt = (p: number) => {
    const dtW = Math.max(inkCore[p] ? 2 * distCore[p]! - 1 : 0, 2 * dist[p]! - 1.6);
    const f = fwhmAt(p);
    // trust the profile for ordinary lines; for very wide ink (no paper within reach) the DT is the only estimate
    // the profile is capped a little above the DT estimate: at a crossing every direction reads wide
    // (it would draw a bead), while a thick line's missing anti-aliased fringe is about a pixel a side
    const wv = f > 0 ? (dtW > 2 * R2 - 2 ? Math.max(f, dtW) : Math.min(f, dtW + 2.2)) : dtW;
    return Math.max(0.6, wv - 0.3);
  };
  pruneSpurs(thinM, w, h, (p) => Math.max(3, 1.6 * dist[p]!));
  const raw = joinAtJunctions(traceSkeleton(thinM, w, h), thinM, w, h);
  const strokes: TraceStroke[] = [];
  const sm = Math.round(1 + 3 * P.lineSmoothing), smW = sm + 4;
  for (const path of raw) {
    if (path.length < 2) { const p = path[0]!; const wv = widthAt(p); strokes.push({ pts: new Float32Array([p % w + 0.5, ((p / w) | 0) + 0.5, wv, p % w + 0.5, ((p / w) | 0) + 0.5, wv]), color: inkPal[Math.max(0, inkCluster[p]!)] ?? [0, 0, 0] }); continue; }
    const n = path.length;
    const xs = path.map((p) => p % w + 0.5), ys = path.map((p) => ((p / w) | 0) + 0.5), ws = path.map(widthAt);
    const pts: number[] = [];
    for (let i = 0; i < n; i++) {
      let sx = 0, sy = 0, c = 0; for (let j = Math.max(0, i - sm); j <= Math.min(n - 1, i + sm); j++) { sx += xs[j]!; sy += ys[j]!; c++; }
      // width: median over a wider window (single noisy pixels made bead-like bulges)
      const win: number[] = []; for (let j = Math.max(0, i - smW); j <= Math.min(n - 1, i + smW); j++) win.push(ws[j]!); win.sort((a, b) => a - b);
      const wv = (win[win.length >> 1]! * 2 + win[Math.floor(win.length * 0.3)]! + win[Math.floor(win.length * 0.7)]!) / 4;
      if (i === 0 || i === n - 1) pts.push(xs[i]!, ys[i]!, wv); else pts.push(sx / c, sy / c, wv);
    }
    const votes = new Int32Array(kInk); for (const p of path) if (inkCluster[p]! >= 0) { const q = inkCluster[p]!; votes[q] = votes[q]! + 1; }
    let best = 0; for (let c = 1; c < kInk; c++) if (votes[c]! > votes[best]!) best = c;
    strokes.push({ pts: new Float32Array(rdp3(pts, 0.25)), color: inkPal[best] ?? [0, 0, 0] });
  }
  const chained = chainStrokes(strokes, P.chainGap > 0 ? Math.max(P.chainGap, P.chainGap * scale) : 0);
  mark("strokes");
  // ---- 4. solid ink areas as filled shapes
  progress?.("solid ink", 0.3);
  const inkFills: TraceShape[] = [];
  if (solidPx) {
    const { lab, sizes } = components(solid, w, h);
    const boxes = new Map<number, [number, number, number, number]>(); const votes = new Map<number, Int32Array>();
    for (let i = 0; i < N; i++) { const c = lab[i]!; if (!c) continue; const x = i % w, y = (i / w) | 0; const b = boxes.get(c); if (!b) boxes.set(c, [x, y, x + 1, y + 1]); else { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x + 1 > b[2]) b[2] = x + 1; if (y + 1 > b[3]) b[3] = y + 1; } const v = votes.get(c) ?? votes.set(c, new Int32Array(kInk)).get(c)!; if (inkCluster[i]! >= 0) { const q = inkCluster[i]!; v[q] = v[q]! + 1; } }
    for (const [c, box] of boxes) {
      if (sizes[c]! < 6) continue;
      const v = votes.get(c)!; let best = 0; for (let q = 1; q < kInk; q++) if (v[q]! > v[best]!) best = q;
      const loops = contours((i) => lab[i] === c, w, h, box, 0.3); if (loops.length) inkFills.push({ loops, color: inkPal[best] ?? [0, 0, 0], box });
    }
  }
  mark("solid");
  // ---- 5. colour under the lines: fill ink pixels from their non-ink neighbours (onion peel)
  progress?.("flats", 0.38);
  const col = new Float32Array(N * 3); const known = new Uint8Array(N);
  for (let i = 0; i < N; i++) { if (!ink[i]) { known[i] = 1; col[i * 3] = rgba[i * 4]!; col[i * 3 + 1] = rgba[i * 4 + 1]!; col[i * 3 + 2] = rgba[i * 4 + 2]!; } }
  let frontier: number[] = []; for (let i = 0; i < N; i++) if (!known[i]) frontier.push(i);
  for (let pass = 0; pass < 64 && frontier.length; pass++) {
    const fill: Array<[number, number, number, number]> = []; const rest: number[] = [];
    for (const i of frontier) { const x = i % w, y = (i / w) | 0; let r0 = 0, g0 = 0, b0 = 0, c = 0; for (const [dx, dy] of N8) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue; const q = ny * w + nx; if (known[q]) { r0 += col[q * 3]!; g0 += col[q * 3 + 1]!; b0 += col[q * 3 + 2]!; c++; } } if (c) fill.push([i, r0 / c, g0 / c, b0 / c]); else rest.push(i); }
    for (const [i, r1, g1, b1] of fill) { col[i * 3] = r1; col[i * 3 + 1] = g1; col[i * 3 + 2] = b1; known[i] = 1; }
    frontier = rest;
  }
  const filled = new Uint8ClampedArray(N * 4); for (let i = 0; i < N; i++) { filled[i * 4] = col[i * 3]!; filled[i * 4 + 1] = col[i * 3 + 1]!; filled[i * 4 + 2] = col[i * 3 + 2]!; filled[i * 4 + 3] = 255; }
  const lab2 = toLab(filled, N); mark("fill");
  // ---- 6. segmentation: k-means with lightness down-weighted, so lit and shaded parts of one material cluster together
  const k = Math.max(4, Math.min(64, Math.round(P.detail)));
  const feat = new Float32Array(N * 3); for (let i = 0; i < N; i++) { feat[i * 3] = lab2.L[i]! * 0.45; feat[i * 3 + 1] = lab2.A[i]!; feat[i * 3 + 2] = lab2.B[i]!; }
  const C = kmeans(feat, N, 3, k, 10, 11);
  const OUT = k; // label of the pixels the picture does not cover
  let label = new Int32Array(N); for (let i = 0; i < N; i++) label[i] = inMask(i) ? nearestCentre(C, k, 3, [feat[i * 3]!, feat[i * 3 + 1]!, feat[i * 3 + 2]!]) : OUT;
  mark("kmeans");
  // two majority passes: clean boundaries
  for (let pass = 0; pass < 2; pass++) {
    const out = new Int32Array(N); const votes = new Int32Array(k + 1); const seen = new Int32Array(9);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = Math.min(w - 1, Math.max(0, x + dx)), ny = Math.min(h - 1, Math.max(0, y + dy)); const c = label[ny * w + nx]!; if (!votes[c]) seen[n++] = c; votes[c] = votes[c]! + 1; }
      let best = label[y * w + x]!; if (best !== OUT) for (let q = 0; q < n; q++) if (seen[q] !== OUT && votes[seen[q]!]! > votes[best]!) best = seen[q]!;
      out[y * w + x] = best; for (let q = 0; q < n; q++) votes[seen[q]!] = 0;
    }
    label = out;
  }
  mark("mode"); progress?.("regions", 0.5);
  // connected regions of each cluster; small ones merge into the neighbour they share most border with
  const reg = new Int32Array(N); const regSize: number[] = [0]; const regLabel: number[] = [0];
  { const stack = new Int32Array(N); let next = 1; for (let i = 0; i < N; i++) { if (reg[i]) continue; const lb = label[i]!; let sp = 0; stack[sp++] = i; reg[i] = next; let size = 0; while (sp) { const p = stack[--sp]!; size++; const x = p % w, y = (p / w) | 0; if (x > 0 && !reg[p - 1] && label[p - 1] === lb) { reg[p - 1] = next; stack[sp++] = p - 1; } if (x < w - 1 && !reg[p + 1] && label[p + 1] === lb) { reg[p + 1] = next; stack[sp++] = p + 1; } if (y > 0 && !reg[p - w] && label[p - w] === lb) { reg[p - w] = next; stack[sp++] = p - w; } if (y < h - 1 && !reg[p + w] && label[p + w] === lb) { reg[p + w] = next; stack[sp++] = p + w; } } regSize.push(size); regLabel.push(lb); next++; } }
  const minRegion = P.minRegion > 0 ? P.minRegion : Math.max(24, Math.round(N * 0.00012));
  const parent = regSize.map((_, i) => i); const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]!]!; a = parent[a]!; } return a; };
  for (let round = 0; round < 3; round++) {
    const border = new Map<number, Map<number, number>>(); const size = new Map<number, number>();
    for (let i = 0; i < N; i++) { const a = find(reg[i]!); size.set(a, (size.get(a) ?? 0) + 1); }
    const small = (a: number) => (size.get(a) ?? 0) < minRegion && regLabel[a] !== OUT;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; const a = find(reg[i]!); for (const j of [x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1]) { if (j < 0) continue; const b = find(reg[j]!); if (a === b || regLabel[a] === OUT || regLabel[b] === OUT) continue; if (small(a)) { const m = border.get(a) ?? border.set(a, new Map()).get(a)!; m.set(b, (m.get(b) ?? 0) + 1); } if (small(b)) { const m = border.get(b) ?? border.set(b, new Map()).get(b)!; m.set(a, (m.get(a) ?? 0) + 1); } } }
    if (!border.size) break;
    const order = [...border.keys()].sort((a, b) => (size.get(a) ?? 0) - (size.get(b) ?? 0));
    for (const a of order) { const ra = find(a); if (!small(ra)) continue; let best = -1, bc = 0; for (const [b, c] of border.get(a)!) { const rb = find(b); if (rb !== ra && c > bc) { bc = c; best = rb; } } if (best >= 0) parent[ra] = best; }
  }
  // Lit and shaded parts of one material often land in different clusters (anime shadows shift hue a
  // little as well as darken). Join neighbours of the same hue that differ mainly in lightness and
  // share a real border, so the darker part becomes that region's shadow instead of its own flat.
  {
    const stat = new Map<number, { n: number; L: number; a: number; b: number }>();
    for (let i = 0; i < N; i++) { const id = find(reg[i]!); const st = stat.get(id) ?? stat.set(id, { n: 0, L: 0, a: 0, b: 0 }).get(id)!; st.n++; st.L += lab2.L[i]!; st.a += lab2.A[i]!; st.b += lab2.B[i]!; }
    for (const st of stat.values()) { st.L /= st.n; st.a /= st.n; st.b /= st.n; }
    const shared = new Map<number, number>(); const perim = new Map<number, number>();
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; const a0 = find(reg[i]!); for (const j of [x < w - 1 ? i + 1 : -1, y < h - 1 ? i + w : -1]) { if (j < 0) continue; const b0 = find(reg[j]!); if (a0 === b0) continue; const key = a0 < b0 ? a0 * 4194304 + b0 : b0 * 4194304 + a0; shared.set(key, (shared.get(key) ?? 0) + 1); perim.set(a0, (perim.get(a0) ?? 0) + 1); perim.set(b0, (perim.get(b0) ?? 0) + 1); } }
    const pairs = [...shared.entries()].sort((p, q) => q[1] - p[1]);
    for (const [key, len] of pairs) {
      const a0 = Math.floor(key / 4194304), b0 = key % 4194304; const ra = find(a0), rb = find(b0); if (ra === rb || regLabel[ra] === OUT || regLabel[rb] === OUT) continue;
      const A0 = stat.get(a0)!, B0 = stat.get(b0)!; const ca = Math.hypot(A0.a, A0.b), cb = Math.hypot(B0.a, B0.b);
      const dL = Math.abs(A0.L - B0.L); if (dL < P.shadowStep * 0.8 || dL > 45) continue;
      let sameHue: boolean;
      if (ca < 8 && cb < 8) sameHue = true; // greys
      else if (ca < 8 || cb < 8) sameHue = false;
      else { let dh = Math.abs(Math.atan2(A0.b, A0.a) - Math.atan2(B0.b, B0.a)); if (dh > Math.PI) dh = 2 * Math.PI - dh; sameHue = dh < (22 * Math.PI) / 180 && Math.min(ca, cb) / Math.max(ca, cb) > 0.45; }
      if (!sameHue) continue;
      const smaller = Math.min(perim.get(a0) ?? 1, perim.get(b0) ?? 1); if (len < smaller * 0.12) continue;
      parent[ra] = rb;
    }
  }
  const region = new Int32Array(N); for (let i = 0; i < N; i++) region[i] = find(reg[i]!);
  mark("regions");
  // ---- 7. per region: lit (flat) colour, shadow and highlight levels
  progress?.("shading", 0.62);
  const ids = [...new Set(region)]; const idIndex = new Map<number, number>(); ids.forEach((id, j) => idIndex.set(id, j));
  const R = ids.length; const pix: number[][] = ids.map(() => []);
  for (let i = 0; i < N; i++) pix[idIndex.get(region[i]!)!]!.push(i);
  const flatRGB: RGB[] = new Array(R); const flatL = new Float32Array(R); const box: Array<[number, number, number, number]> = new Array(R);
  for (let j = 0; j < R; j++) {
    const list = pix[j]!; const ls = list.map((i) => lab2.L[i]!).sort((a, b) => a - b);
    const q = (f: number) => ls[Math.min(ls.length - 1, Math.floor(f * ls.length))]!;
    const lo = q(0.5), hi = q(0.85); flatL[j] = q(0.65);
    let r0 = 0, g0 = 0, b0 = 0, c = 0; let x0 = w, y0 = h, x1 = 0, y1 = 0;
    for (const i of list) { const x = i % w, y = (i / w) | 0; if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + 1 > x1) x1 = x + 1; if (y + 1 > y1) y1 = y + 1; const l = lab2.L[i]!; if (l >= lo && l <= hi) { r0 += filled[i * 4]!; g0 += filled[i * 4 + 1]!; b0 += filled[i * 4 + 2]!; c++; } }
    flatRGB[j] = c ? [Math.round(r0 / c), Math.round(g0 / c), Math.round(b0 / c)] : [filled[list[0]! * 4]!, filled[list[0]! * 4 + 1]!, filled[list[0]! * 4 + 2]!];
    box[j] = [x0, y0, x1, y1];
  }
  // shading class per pixel: 0 flat, 1 shadow, 2 deep shadow, 3 highlight
  let shade = new Uint8Array(N);
  const s1 = P.shadowStep, s2 = P.shadowStep * 2.6, h1 = P.highlightStep;
  for (let i = 0; i < N; i++) { const j = idIndex.get(region[i]!)!; const d = lab2.L[i]! - flatL[j]!; shade[i] = d < -s2 && P.shadowLevels === 2 ? 2 : d < -s1 ? 1 : h1 > 0 && d > h1 ? 3 : 0; }
  // smooth shading boundaries inside each region (cel shading has clean edges)
  for (let pass = 0; pass < 2; pass++) {
    const out = new Uint8Array(N); const v = new Int32Array(4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; v.fill(0); for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = Math.min(w - 1, Math.max(0, x + dx)), ny = Math.min(h - 1, Math.max(0, y + dy)); const q = ny * w + nx; if (region[q] === region[i]) { const z = shade[q]!; v[z] = v[z]! + 1; } } let best = shade[i]!; for (let c = 0; c < 4; c++) if (v[c]! > v[best]!) best = c; out[i] = best; }
    shade = out;
  }
  // tiny shading specks go back to flat
  { const minS = Math.max(8, Math.round(minRegion / 3)); for (const cls of [1, 2, 3]) { const m = new Uint8Array(N); for (let i = 0; i < N; i++) if (shade[i] === cls) m[i] = 1; const { lab, sizes } = components(m, w, h, false); for (let i = 0; i < N; i++) if (lab[i] && sizes[lab[i]!]! < minS) shade[i] = cls === 2 ? 1 : 0; } }
  // open each shading mask (erode then grow back): thin streaks from paper texture, gradients and
  // anti-aliasing are noise to a cel shader and drew as grey scratches
  {
    const rOpen = Math.max(1.5, 2 * scale);
    for (const cls of [3, 2, 1]) {
      const m = new Uint8Array(N); for (let i = 0; i < N; i++) if (shade[i] === cls || (cls === 1 && shade[i] === 2)) m[i] = 1;
      const d = edt(m, w, h); const coreM = new Uint8Array(N); for (let i = 0; i < N; i++) coreM[i] = d[i]! > rOpen ? 0 : 1; // 0 = core
      const back = edt(coreM, w, h); // distance to the nearest core pixel
      for (let i = 0; i < N; i++) if (m[i] && back[i]! > rOpen + 0.5) { if (cls === 1) { if (shade[i] === 1 || shade[i] === 2) shade[i] = 0; } else shade[i] = cls === 2 ? 1 : 0; }
    }
  }
  // multiply / screen colours per region and level
  const level = (j: number, cls: number): RGB | null => {
    const f = flatRGB[j]!; let r0 = 0, g0 = 0, b0 = 0, c = 0;
    for (const i of pix[j]!) { if (shade[i] !== cls && !(cls === 1 && shade[i] === 2 && P.shadowLevels === 1)) continue; const p = [filled[i * 4]!, filled[i * 4 + 1]!, filled[i * 4 + 2]!];
      if (cls === 3) { r0 += 1 - (1 - p[0]! / 255) / Math.max(0.02, 1 - f[0] / 255); g0 += 1 - (1 - p[1]! / 255) / Math.max(0.02, 1 - f[1] / 255); b0 += 1 - (1 - p[2]! / 255) / Math.max(0.02, 1 - f[2] / 255); }
      else { r0 += p[0]! / Math.max(1, f[0]); g0 += p[1]! / Math.max(1, f[1]); b0 += p[2]! / Math.max(1, f[2]); }
      c++; }
    if (!c) return null; const cl = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v / c)));
    return [cl(r0), cl(g0), cl(b0)];
  };
  mark("shading");
  // ---- 8. shapes
  progress?.("shapes", 0.72);
  const flats: TraceShape[] = []; const shadows: TraceShape[] = []; const highlights: TraceShape[] = [];
  const order = ids.map((_, j) => j).sort((a, b) => pix[b]!.length - pix[a]!.length); // big first; small regions paint over seams
  const outside = new Uint8Array(R); for (let j = 0; j < R; j++) if (regLabel[ids[j]!] === OUT) outside[j] = 1;
  for (const j of order) {
    if (outside[j]) continue;
    const id = ids[j]!; const bx = box[j]!;
    const loops = contours((i) => region[i] === id, w, h, bx, 0.35); if (loops.length) flats.push({ loops, color: flatRGB[j]!, box: bx });
    for (const cls of P.shadowLevels === 2 ? [1, 2] : [1]) {
      const c = level(j, cls); if (!c) continue;
      // level 1 covers deep shadow too (deep is painted over it), so edges stay nested
      const ls = contours((i) => region[i] === id && (shade[i] === cls || (cls === 1 && shade[i] === 2)), w, h, bx, 0.35);
      if (ls.length) shadows.push({ loops: ls, color: c, box: bx });
    }
    if (h1 > 0) { const c = level(j, 3); if (c) { const ls = contours((i) => region[i] === id && shade[i] === 3, w, h, bx, 0.35); if (ls.length) highlights.push({ loops: ls, color: c, box: bx }); } }
  }
  mark("shapes");
  // ---- 8b. what the cel layers cannot say: the residual between the picture (lines peeled off)
  // and flats x shadow (+ highlight), low-passed, becomes airbrush dabs on a Soft shading layer.
  // Dabs sit on a grid, radius 1.6x the spacing; each dab's alpha is set so the overlapping dabs
  // reach the wanted coverage (dab alphas compound: 1 - prod(1 - a*k)).
  progress?.("soft", 0.8);
  const shadowCol = new Map<string, RGB>(); for (let j = 0; j < R; j++) for (const cls of [1, 2]) { const c = level(j, cls); if (c) shadowCol.set(`${j}:${cls}`, c); }
  const hiCol = new Map<number, RGB>(); if (h1 > 0) for (let j = 0; j < R; j++) { const c = level(j, 3); if (c) hiCol.set(j, c); }
  const recon = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const j = idIndex.get(region[i]!)!; const f = flatRGB[j]!; let r0 = f[0], g0 = f[1], b0 = f[2];
    const s = shade[i]!; if (s === 1 || s === 2) { const m = shadowCol.get(`${j}:${s}`) ?? shadowCol.get(`${j}:1`); if (m) { r0 = r0 * m[0] / 255; g0 = g0 * m[1] / 255; b0 = b0 * m[2] / 255; } }
    else if (s === 3) { const m = hiCol.get(j); if (m) { r0 = 255 - (255 - r0) * (1 - m[0] / 255); g0 = 255 - (255 - g0) * (1 - m[1] / 255); b0 = 255 - (255 - b0) * (1 - m[2] / 255); } }
    recon[i * 3] = r0; recon[i * 3 + 1] = g0; recon[i * 3 + 2] = b0;
  }
  const softList: number[] = []; let softDabs = 0;
  if (P.soft > 0) {
    const sp = Math.max(3, Math.round(4 * scale)); const rad = sp * 1.6;
    const chan = (src: Float32Array, c: number) => { const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = src[i * 3 + c]!; return a; };
    const srcB = [0, 1, 2].map((c) => boxBlur(chan(Float32Array.from(filled.filter((_, q) => q % 4 !== 3)), c), w, h, sp));
    const recB = [0, 1, 2].map((c) => boxBlur(chan(recon, c), w, h, sp));
    // summed kernel weight at a pixel from the dab grid (cos^2 falloff), for the alpha compounding
    let ksum = 0; for (let gy = -3; gy <= 3; gy++) for (let gx = -3; gx <= 3; gx++) { const d = Math.hypot(gx * sp + sp / 2, gy * sp + sp / 2); if (d < rad) { const t = Math.cos((Math.PI / 2) * (d / rad)); ksum += t * t; } }
    // no dabs right next to a line: the peeled colour under a line and the anti-aliased fringe beside
    // it are guesses, and blurring them made halos (a pink smear beside red glasses, grey smudges in hair)
    const notInk = new Uint8Array(N); for (let i = 0; i < N; i++) notInk[i] = ink[i] ? 0 : 1; const toInk = edt(notInk, w, h);
    for (let gy = sp >> 1; gy < h; gy += sp) for (let gx = sp >> 1; gx < w; gx += sp) {
      const i = gy * w + gx; if (!inMask(i) || ink[i] || toInk[i]! < 1.5) continue; // only the fringe is excluded: painterly pictures have lines everywhere
      const dr = srcB[0]![i]! - recB[0]![i]!, dg = srcB[1]![i]! - recB[1]![i]!, db = srcB[2]![i]! - recB[2]![i]!;
      const mag = Math.sqrt(dr * dr + dg * dg + db * db); if (mag < 3) continue;
      // coverage: 0 at a 3-unit difference, full at 24 and above, scaled by the soft setting
      const T0 = Math.min(1, (mag - 3) / 21) * Math.min(1, P.soft);
      const a = 1 - Math.pow(1 - T0, 1 / Math.max(1, ksum));
      if (a < 0.004) continue;
      softList.push(gx + 0.5, gy + 0.5, rad, srcB[0]![i]!, srcB[1]![i]!, srcB[2]![i]!, a); softDabs++;
    }
  }
  const soft = new Float32Array(softList);
  mark("soft");
  // ---- 9. screentone densities from the smoothed picture (gradients included), quantised
  progress?.("tones", 0.86);
  const lv = P.toneLevels.slice().sort((a, b) => a - b);
  const toneOf = new Int8Array(N).fill(-1);
  const lumB = boxBlur(Float32Array.from({ length: N }, (_, i) => 0.299 * filled[i * 4]! + 0.587 * filled[i * 4 + 1]! + 0.114 * filled[i * 4 + 2]!), w, h, Math.max(1, Math.round(1.5 * scale)));
  for (let i = 0; i < N; i++) {
    if (!inMask(i)) continue;
    const lum = lumB[i]! / 255; const dark = 1 - lum;
    if (dark < lv[0]! * 0.6) continue;
    let best = 0; for (let q = 1; q < lv.length; q++) if (Math.abs(lv[q]! - dark) < Math.abs(lv[best]! - dark)) best = q;
    toneOf[i] = best;
  }
  const tones: TraceTone[] = [];
  for (let q = 0; q < lv.length; q++) {
    const m = new Uint8Array(N); let any = 0; for (let i = 0; i < N; i++) if (toneOf[i] === q) { m[i] = 1; any++; }
    if (!any) continue;
    const { lab, sizes } = components(m, w, h, false); const bxs = new Map<number, [number, number, number, number]>();
    for (let i = 0; i < N; i++) { const c = lab[i]!; if (!c || sizes[c]! < Math.max(12, minRegion / 2)) continue; const x = i % w, y = (i / w) | 0; const b = bxs.get(c); if (!b) bxs.set(c, [x, y, x + 1, y + 1]); else { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x + 1 > b[2]) b[2] = x + 1; if (y + 1 > b[3]) b[3] = y + 1; } }
    const shapes: TraceShape[] = []; for (const [c, b] of bxs) { const ls = contours((i) => lab[i] === c, w, h, b, 0.4); if (ls.length) shapes.push({ loops: ls, color: [0, 0, 0], box: b }); }
    if (shapes.length) tones.push({ density: lv[q]!, shapes });
  }
  mark("tones");
  progress?.("done", 1);
  for (let i = 0; i < N; i++) if (solid[i]) inkMask[i] = 2;
  return { w, h, strokes, inkFills, flats, shadows, highlights, tones, inkMask, soft, mask, stats: { inkPx: inkIdx.length, strokes: strokes.length, regions: R - (mask ? 1 : 0), palette: kInk, softDabs, chained, ms } };
}
