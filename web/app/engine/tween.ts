/**
 * Keyframed motion for 2D animation.
 *   Layer keys: transform (translate, scale, rotate about the layer's pivot) and opacity per
 *     frame, interpolated with a cubic-bezier ease stored on the outgoing key.
 *   Camera keys: centre, zoom (1 = whole page) and rotation; the camera frames the export and
 *     is shown as a field guide in the viewport.
 * Interpolation is per channel: translation and pivot linearly, scale linearly, rotation along
 * the shortest arc, opacity linearly, all through the key's easing curve.
 */
export interface Ease { x1: number; y1: number; x2: number; y2: number }
export const EASES: Record<string, Ease> = {
  linear: { x1: 0, y1: 0, x2: 1, y2: 1 }, "ease-in": { x1: 0.42, y1: 0, x2: 1, y2: 1 }, "ease-out": { x1: 0, y1: 0, x2: 0.58, y2: 1 },
  "ease-in-out": { x1: 0.42, y1: 0, x2: 0.58, y2: 1 }, snap: { x1: 0.9, y1: 0, x2: 1, y2: 0.1 }, anticipate: { x1: 0.6, y1: -0.3, x2: 0.4, y2: 1.3 },
};
/** y for a given x on the cubic-bezier (0,0)-(x1,y1)-(x2,y2)-(1,1), solved by bisection. */
export function easeAt(e: Ease, x: number): number {
  if (x <= 0) return 0; if (x >= 1) return 1;
  const bx = (t: number) => 3 * (1 - t) * (1 - t) * t * e.x1 + 3 * (1 - t) * t * t * e.x2 + t * t * t;
  const by = (t: number) => 3 * (1 - t) * (1 - t) * t * e.y1 + 3 * (1 - t) * t * t * e.y2 + t * t * t;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 24; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
  return by(t);
}

export interface LayerKey { frame: number; x: number; y: number; sx: number; sy: number; rot: number; px: number; py: number; opacity: number; ease: Ease }
export interface CameraKey { frame: number; cx: number; cy: number; zoom: number; rot: number; ease: Ease }

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function lerpAngle(a: number, b: number, t: number): number { let d = b - a; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return a + d * t; }

export function layerAt(keys: LayerKey[], frame: number): LayerKey | null {
  if (!keys.length) return null;
  const ks = [...keys].sort((a, b) => a.frame - b.frame);
  if (frame <= ks[0]!.frame) return ks[0]!;
  if (frame >= ks[ks.length - 1]!.frame) return ks[ks.length - 1]!;
  let i = 0; while (ks[i + 1]!.frame <= frame) i++;
  const a = ks[i]!, b = ks[i + 1]!; const t = easeAt(a.ease, (frame - a.frame) / Math.max(1, b.frame - a.frame));
  return { frame, x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), sx: lerp(a.sx, b.sx, t), sy: lerp(a.sy, b.sy, t), rot: lerpAngle(a.rot, b.rot, t), px: lerp(a.px, b.px, t), py: lerp(a.py, b.py, t), opacity: lerp(a.opacity, b.opacity, t), ease: a.ease };
}
export function cameraAt(keys: CameraKey[], frame: number): CameraKey | null {
  if (!keys.length) return null;
  const ks = [...keys].sort((a, b) => a.frame - b.frame);
  if (frame <= ks[0]!.frame) return ks[0]!;
  if (frame >= ks[ks.length - 1]!.frame) return ks[ks.length - 1]!;
  let i = 0; while (ks[i + 1]!.frame <= frame) i++;
  const a = ks[i]!, b = ks[i + 1]!; const t = easeAt(a.ease, (frame - a.frame) / Math.max(1, b.frame - a.frame));
  return { frame, cx: lerp(a.cx, b.cx, t), cy: lerp(a.cy, b.cy, t), zoom: Math.exp(lerp(Math.log(a.zoom), Math.log(b.zoom), t)), rot: lerpAngle(a.rot, b.rot, t), ease: a.ease };
}
/** Affine matrix [a b c d e f] for a layer key: translate(x,y) · translate(p) · rotate · scale · translate(-p). */
export function keyMatrix(k: LayerKey): [number, number, number, number, number, number] {
  const c = Math.cos(k.rot), s = Math.sin(k.rot);
  const a = c * k.sx, b = s * k.sx, cc = -s * k.sy, d = c * k.sy;
  const e = k.x + k.px - (a * k.px + cc * k.py), f = k.y + k.py - (b * k.px + d * k.py);
  return [a, b, cc, d, e, f];
}
/** Camera rectangle in DU for a page of w x h: zoom 1 shows the whole page. */
export function cameraRect(k: CameraKey, w: number, h: number): { cx: number; cy: number; w: number; h: number; rot: number } {
  return { cx: k.cx, cy: k.cy, w: w / k.zoom, h: h / k.zoom, rot: k.rot };
}
