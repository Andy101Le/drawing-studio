/**
 * Panel slicing (Phase 6.1). A panel is a convex-or-concave polygon in DU.
 * Dragging a cut line across a panel splits it into two polygons along the
 * line, applying a gutter (half on each side). Masks are non-destructive:
 * layers reference a panel id and the renderer clips at composite time.
 */

import type { Panel } from "./document.js";
import { newId } from "./document.js";

export interface Pt { x: number; y: number }

export function pageToPanel(width: number, height: number, margin: number, gutter: number): Panel {
  return { id: newId(), polygon: [{ x: margin, y: margin }, { x: width - margin, y: margin }, { x: width - margin, y: height - margin }, { x: margin, y: height - margin }], gutter };
}

function side(a: Pt, b: Pt, p: Pt): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
function intersect(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = { x: b.x - a.x, y: b.y - a.y }, s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  return { x: a.x + t * r.x, y: a.y + t * r.y };
}

/** Clip polygon to the half-plane left of line (a→b) when keepLeft, else right. Sutherland–Hodgman against one edge. */
function clipHalfPlane(poly: Pt[], a: Pt, b: Pt, keepLeft: boolean): Pt[] {
  const out: Pt[] = [];
  const inside = (p: Pt) => (keepLeft ? side(a, b, p) >= 0 : side(a, b, p) <= 0);
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i]!, prev = poly[(i + poly.length - 1) % poly.length]!;
    const ci = inside(cur), pi = inside(prev);
    if (ci) {
      if (!pi) { const x = intersect(prev, cur, a, b); if (x) out.push(x); }
      out.push(cur);
    } else if (pi) {
      const x = intersect(prev, cur, a, b); if (x) out.push(x);
    }
  }
  return out;
}

function offsetLine(a: Pt, b: Pt, dist: number): [Pt, Pt] {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
  return [{ x: a.x + nx * dist, y: a.y + ny * dist }, { x: b.x + nx * dist, y: b.y + ny * dist }];
}

export function polygonArea(poly: Pt[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i]!, q = poly[(i + 1) % poly.length]!; s += p.x * q.y - q.x * p.y; }
  return Math.abs(s) / 2;
}

export function pointInPolygon(p: Pt, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!, b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Split `panel` by the infinite line through a→b. Returns the two new panels
 * (or null when the line misses). Gutter is applied symmetrically.
 */
export function splitPanel(panel: Panel, a: Pt, b: Pt): [Panel, Panel] | null {
  const g = panel.gutter / 2;
  const [la, lb] = offsetLine(a, b, g);
  const [ra, rb] = offsetLine(a, b, -g);
  const left = clipHalfPlane(panel.polygon, la, lb, true);
  const right = clipHalfPlane(panel.polygon, ra, rb, false);
  if (left.length < 3 || right.length < 3) return null;
  const minArea = 0.002 * polygonArea(panel.polygon);
  if (polygonArea(left) < minArea || polygonArea(right) < minArea) return null;
  return [{ id: newId(), polygon: left, gutter: panel.gutter }, { id: newId(), polygon: right, gutter: panel.gutter }];
}

/** Replace a panel with its split halves; layers masked by the old panel follow the half containing their centroid. */
export function applySplit(panels: Panel[], target: Panel, a: Pt, b: Pt): { panels: Panel[]; map: Map<number, number[]> } | null {
  const parts = splitPanel(target, a, b);
  if (!parts) return null;
  const out = panels.flatMap((p) => (p.id === target.id ? parts : [p]));
  return { panels: out, map: new Map([[target.id, parts.map((p) => p.id)]]) };
}

export function panelAt(panels: Panel[], p: Pt): Panel | null {
  for (const panel of panels) if (pointInPolygon(p, panel.polygon)) return panel;
  return null;
}
