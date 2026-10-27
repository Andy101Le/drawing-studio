/**
 * Vector strokes (Phase 1.2 vector mode, Phase 6.2 interpolated onion skin).
 *
 * A VectorPath is a polyline of control points with pressure. Freehand input is
 * smoothed (One Euro, same as raster) and simplified with Ramer–Douglas–Peucker
 * so a stroke becomes a handful of editable nodes. Rendering builds a
 * variable-width outline polygon (left/right offsets along averaged normals,
 * round caps) and fills it, so the line is resolution-independent and crisp at
 * any zoom. Two paths with the same id in consecutive drawings are tweened for
 * onion ghosts by arc-length resampling, which removes the equal-point-count
 * restriction.
 */

import type { VectorPath } from "./document.js";

export interface VPt { x: number; y: number; p: number }

export function rdp(points: VPt[], epsilon: number): VPt[] {
  if (points.length < 3) return points.slice();
  const first = points[0]!, last = points[points.length - 1]!;
  let maxD = -1, idx = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpDist(points[i]!, first, last);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > epsilon) {
    const a = rdp(points.slice(0, idx + 1), epsilon), b = rdp(points.slice(idx), epsilon);
    return a.slice(0, -1).concat(b);
  }
  return [first, last];
}
function perpDist(p: VPt, a: VPt, b: VPt): number {
  const dx = b.x - a.x, dy = b.y - a.y; const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Centripetal Catmull-Rom densification: `segs` sub-points per control segment. */
export function densify(points: VPt[], segs = 8): VPt[] {
  if (points.length < 3) return points.slice();
  const out: VPt[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[Math.min(points.length - 1, i + 2)]!;
    for (let k = 0; k < segs; k++) {
      const t = k / segs;
      const [x, y] = catmull(p0, p1, p2, p3, t);
      out.push({ x, y, p: p1.p + (p2.p - p1.p) * t });
    }
  }
  out.push(points[points.length - 1]!);
  return out;
}
function catmull(p0: VPt, p1: VPt, p2: VPt, p3: VPt, t: number): [number, number] {
  const knot = (t0: number, a: VPt, b: VPt) => t0 + Math.sqrt(Math.hypot(b.x - a.x, b.y - a.y)) + 1e-4;
  const t0 = 0, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
  const tt = t1 + (t2 - t1) * t; const L = (a: number, b: number, u: number) => a + (b - a) * u;
  const a1x = L(p0.x, p1.x, (tt - t0) / (t1 - t0)), a1y = L(p0.y, p1.y, (tt - t0) / (t1 - t0));
  const a2x = L(p1.x, p2.x, (tt - t1) / (t2 - t1)), a2y = L(p1.y, p2.y, (tt - t1) / (t2 - t1));
  const a3x = L(p2.x, p3.x, (tt - t2) / (t3 - t2)), a3y = L(p2.y, p3.y, (tt - t2) / (t3 - t2));
  const b1x = L(a1x, a2x, (tt - t0) / (t2 - t0)), b1y = L(a1y, a2y, (tt - t0) / (t2 - t0));
  const b2x = L(a2x, a3x, (tt - t1) / (t3 - t1)), b2y = L(a2y, a3y, (tt - t1) / (t3 - t1));
  return [L(b1x, b2x, (tt - t1) / (t2 - t1)), L(b1y, b2y, (tt - t1) / (t2 - t1))];
}

/** Variable-width outline: returns a closed polygon (left side forward, right side back). */
export function outline(path: VectorPath, minWidth = 0.4): VPt[] {
  const pts = densify(path.points, 6);
  if (pts.length === 0) return [];
  if (pts.length === 1) { const p = pts[0]!; const r = Math.max(minWidth, path.width * p.p) / 2; return circle(p.x, p.y, r); }
  const left: VPt[] = [], right: VPt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const prev = pts[Math.max(0, i - 1)]!, next = pts[Math.min(pts.length - 1, i + 1)]!;
    let nx = -(next.y - prev.y), ny = next.x - prev.x; const len = Math.hypot(nx, ny) || 1; nx /= len; ny /= len;
    const w = Math.max(minWidth, path.width * (0.25 + 0.75 * p.p)) / 2;
    left.push({ x: p.x + nx * w, y: p.y + ny * w, p: p.p }); right.push({ x: p.x - nx * w, y: p.y - ny * w, p: p.p });
  }
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const wF = Math.max(minWidth, path.width * (0.25 + 0.75 * first.p)) / 2, wL = Math.max(minWidth, path.width * (0.25 + 0.75 * last.p)) / 2;
  const capEnd = arc(last.x, last.y, wL, angle(pts[pts.length - 2]!, last) - Math.PI / 2, angle(pts[pts.length - 2]!, last) + Math.PI / 2);
  const capStart = arc(first.x, first.y, wF, angle(pts[1]!, first) - Math.PI / 2, angle(pts[1]!, first) + Math.PI / 2);
  return left.concat(capEnd, right.reverse(), capStart);
}
const angle = (a: VPt, b: VPt) => Math.atan2(b.y - a.y, b.x - a.x);
function arc(cx: number, cy: number, r: number, a0: number, a1: number, n = 8): VPt[] {
  const out: VPt[] = []; for (let i = 0; i <= n; i++) { const a = a0 + ((a1 - a0) * i) / n; out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a), p: 1 }); } return out;
}
function circle(cx: number, cy: number, r: number): VPt[] { return arc(cx, cy, r, 0, Math.PI * 2, 16); }

export function drawPathTo(ctx: CanvasRenderingContext2D, path: VectorPath): void {
  const poly = outline(path);
  if (poly.length < 3) return;
  ctx.beginPath(); poly.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath();
  ctx.fillStyle = path.color; ctx.fill();
}

/** Resample a polyline to n points by arc length (for tweening paths with different node counts). */
export function resample(points: VPt[], n: number): VPt[] {
  const dense = densify(points, 6);
  if (dense.length < 2) return Array.from({ length: n }, () => ({ ...(dense[0] ?? { x: 0, y: 0, p: 0 }) }));
  const cum = [0]; for (let i = 1; i < dense.length; i++) cum.push(cum[i - 1]! + Math.hypot(dense[i]!.x - dense[i - 1]!.x, dense[i]!.y - dense[i - 1]!.y));
  const total = cum[cum.length - 1]!;
  const out: VPt[] = []; let j = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / (n - 1);
    while (j < cum.length - 2 && cum[j + 1]! < target) j++;
    const seg = cum[j + 1]! - cum[j]! || 1; const t = Math.max(0, Math.min(1, (target - cum[j]!) / seg));
    const a = dense[j]!, b = dense[j + 1]!;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, p: a.p + (b.p - a.p) * t });
  }
  return out;
}

/** Tween path A toward path B by factor t in [0,1]; both resampled to the larger node count. */
export function tween(a: VectorPath, b: VectorPath, t: number): VectorPath {
  const n = Math.max(a.points.length, b.points.length, 12);
  const pa = resample(a.points, n), pb = resample(b.points, n);
  return { id: a.id, color: a.color, closed: a.closed, width: a.width + (b.width - a.width) * t, points: pa.map((p, i) => ({ x: p.x + (pb[i]!.x - p.x) * t, y: p.y + (pb[i]!.y - p.y) * t, p: p.p + (pb[i]!.p - p.p) * t })) };
}

export function nearestNode(paths: VectorPath[], x: number, y: number, radius: number): { path: VectorPath; index: number } | null {
  let best: { path: VectorPath; index: number; d: number } | null = null;
  for (const path of paths) path.points.forEach((pt, i) => { const d = Math.hypot(pt.x - x, pt.y - y); if (d <= radius && (!best || d < best.d)) best = { path, index: i, d }; });
  return best;
}

export function nearestSegment(paths: VectorPath[], x: number, y: number, radius: number): { path: VectorPath; index: number } | null {
  let best: { path: VectorPath; index: number; d: number } | null = null;
  for (const path of paths) for (let i = 0; i < path.points.length - 1; i++) {
    const d = perpDist({ x, y, p: 0 }, path.points[i]!, path.points[i + 1]!);
    if (d <= radius && (!best || d < best.d)) best = { path, index: i, d };
  }
  return best;
}
