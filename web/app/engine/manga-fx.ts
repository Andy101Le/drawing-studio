/**
 * Manga effects: the vector overlays a page gets after the drawing is done.
 *
 *   speed   parallel lines across a box, tapered, with a direction (a running figure, a thrown punch)
 *   focus   lines running from the edge of a box in toward a point (the eye goes where they point)
 *   flash   an impact burst around a point: a white star with a black rim and spikes flying out
 *   tone    a screentone whose dot coverage ramps across the box (shadow fading into light)
 *   sfx     lettering with a thick outline and a halo, rotated and slanted (DOOM, BAM, ゴゴゴ)
 *
 * Like balloons they are document-level objects, not pixels: they draw above the raster layers,
 * export with the page, and stay editable. Each one has a box (where it lives), an anchor (the
 * point focus and flash converge on, or the direction speed lines run toward) and optionally a
 * panel: anchored to a panel the box follows the panel's bounds and the drawing is clipped to its
 * polygon, so lines never cross a gutter. "Bake" turns one into pixels on a new layer when you want
 * to paint over it.
 *
 * Every line position comes from a seeded hash so the picture is identical between frames and
 * between the viewport and the export.
 */
import { newId, TILE, type Panel } from "./document.js";

export type FxKind = "speed" | "focus" | "flash" | "tone" | "sfx";
export interface Pt { x: number; y: number }
export interface Seg { x0: number; y0: number; x1: number; y1: number; /** line weight at the start and end, DU */ w0: number; w1: number }

export interface Fx {
  id: number;
  kind: FxKind;
  /** box in DU; with a panel it is recomputed from the panel bounds at draw time */
  x: number; y: number; w: number; h: number;
  /** the point lines converge on (focus, flash) or run toward (speed); DU */
  anchor: Pt;
  /** panel whose bounds and polygon this effect follows, or null for a free box */
  panelId: number | null;
  /** 0..1 how many lines (speed, focus, flash spikes) or dots (tone) */
  density: number;
  /** 0..1 how far lines reach: speed = share of the box they cross, focus/flash = clear radius share */
  length: number;
  /** 0..1 randomness of length, spacing and angle */
  jitter: number;
  /** line weight at the thick end, DU */
  weight: number;
  /** degrees; speed line direction, tone ramp direction, sfx rotation */
  angle: number;
  seed: number;
  ink: string;
  opacity: number;
  /** tone: dot coverage at the start and end of the ramp (0..1) and lines per inch */
  toneFrom: number; toneTo: number; lpi: number;
  /** sfx */
  text: string; font: string; size: number; fill: string; outline: number; halo: number; slant: number; bold: boolean;
}

export function newFx(kind: FxKind, x: number, y: number, w: number, h: number, dpi: number): Fx {
  const d: Fx = {
    id: newId(), kind, x, y, w, h, anchor: { x: x + w / 2, y: y + h / 2 }, panelId: null,
    density: 0.5, length: 0.5, jitter: 0.5, weight: Math.max(1, dpi * 0.012), angle: 0, seed: (Math.random() * 1e6) | 0,
    ink: "#141414", opacity: 1, toneFrom: 0.6, toneTo: 0, lpi: 50,
    text: "BAM", font: "'Impact', 'Arial Black', 'Noto Sans JP', sans-serif", size: Math.round(dpi * 0.6), fill: "#ffffff", outline: Math.max(2, dpi * 0.03), halo: Math.max(2, dpi * 0.05), slant: -12, bold: true,
  };
  if (kind === "speed") { d.density = 0.6; d.length = 0.7; d.angle = 0; }
  if (kind === "focus") { d.density = 0.7; d.length = 0.35; }
  if (kind === "flash") { d.density = 0.5; d.length = 0.3; d.weight = Math.max(2, dpi * 0.02); }
  if (kind === "tone") { d.angle = 90; }
  if (kind === "sfx") { d.angle = -8; }
  return d;
}

/** stable noise in 0..1 for index i and seed s */
export function fxNoise(i: number, s: number): number { const x = Math.sin(i * 127.1 + s * 311.7 + 0.5) * 43758.5453; return x - Math.floor(x); }

export interface Box { x: number; y: number; w: number; h: number }

/** the box an effect occupies: its own, or the panel's bounds when anchored to one */
export function fxBox(fx: Fx, panels: Panel[]): Box {
  if (fx.panelId !== null) {
    const p = panels.find((q) => q.id === fx.panelId);
    if (p) { const xs = p.polygon.map((q) => q.x), ys = p.polygon.map((q) => q.y); const x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
  }
  return { x: fx.x, y: fx.y, w: fx.w, h: fx.h };
}

/**
 * Speed lines: lines parallel to `angle` across the box, each starting at a random offset along
 * its run and covering `length` of the run (jittered), thick where they start and tapering out.
 */
export function speedLines(fx: Fx, box: Box): Seg[] {
  const a = (fx.angle * Math.PI) / 180; const ux = Math.cos(a), uy = Math.sin(a); const nx = -uy, ny = ux;
  const diag = Math.hypot(box.w, box.h); const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const n = Math.max(2, Math.round(8 + fx.density * fx.density * 360 * (diag / 2000)));
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    // offset across the direction: even spacing plus jitter; run along the direction: random start
    const t = ((i + 0.5) / n - 0.5 + (fxNoise(i * 3 + 1, fx.seed) - 0.5) * fx.jitter / n) * diag;
    const len = diag * fx.length * (1 - fx.jitter * 0.6 * fxNoise(i * 3 + 2, fx.seed));
    const start = -diag / 2 + fxNoise(i * 3 + 3, fx.seed) * (diag - len) * (0.4 + 0.6 * fx.jitter);
    const s = clipToBox({ x0: cx + nx * t + ux * start, y0: cy + ny * t + uy * start, x1: cx + nx * t + ux * (start + len), y1: cy + ny * t + uy * (start + len), w0: fx.weight * (0.6 + 0.8 * fxNoise(i * 3 + 4, fx.seed)), w1: 0 }, box);
    if (s) out.push(s);
  }
  return out;
}

/**
 * Focus lines: from the box edge toward the anchor, stopping at a clear radius (`length` of the
 * shorter half-side), thick at the edge and tapering to a point at the inside end.
 */
export function focusLines(fx: Fx, box: Box): Seg[] {
  const cx = fx.anchor.x, cy = fx.anchor.y; const far = Math.hypot(box.w, box.h);
  const clear = Math.min(box.w, box.h) * 0.5 * fx.length;
  const n = Math.max(6, Math.round(12 + fx.density * fx.density * 240));
  const out: Seg[] = [];
  for (let i = 0; i < n; i++) {
    const a = ((i + (fxNoise(i * 3 + 1, fx.seed) - 0.5) * fx.jitter * 0.9) / n) * Math.PI * 2;
    const ux = Math.cos(a), uy = Math.sin(a);
    const inner = clear * (1 + (fxNoise(i * 3 + 2, fx.seed) - 0.5) * fx.jitter * 0.8);
    const s = clipToBox({ x0: cx + ux * far, y0: cy + uy * far, x1: cx + ux * inner, y1: cy + uy * inner, w0: fx.weight * (0.5 + fxNoise(i * 3 + 3, fx.seed)), w1: 0 }, box);
    if (s) out.push(s);
  }
  return out;
}

/** Impact flash: the star polygon (white, inked rim) around the anchor, and the spikes flying out of it. */
export function flashShape(fx: Fx, box: Box): { star: Pt[]; spikes: Seg[] } {
  const cx = fx.anchor.x, cy = fx.anchor.y; const r = Math.min(box.w, box.h) * 0.5 * Math.max(0.05, fx.length);
  const points = Math.max(6, Math.round(8 + fx.density * 16));
  const star: Pt[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const k = i % 2 === 0 ? 1 + (fxNoise(i, fx.seed) - 0.5) * fx.jitter * 0.5 : 0.55 + (fxNoise(i, fx.seed) - 0.5) * fx.jitter * 0.2;
    star.push({ x: cx + Math.cos(a) * r * k, y: cy + Math.sin(a) * r * k });
  }
  const spikes: Seg[] = []; const n = Math.round(points * 1.5);
  for (let i = 0; i < n; i++) {
    const a = ((i + fxNoise(i * 5 + 7, fx.seed) * fx.jitter) / n) * Math.PI * 2;
    const ux = Math.cos(a), uy = Math.sin(a); const from = r * (1.1 + fxNoise(i * 5 + 8, fx.seed) * 0.3), to = r * (1.5 + fxNoise(i * 5 + 9, fx.seed) * (0.8 + fx.jitter));
    const s = clipToBox({ x0: cx + ux * from, y0: cy + uy * from, x1: cx + ux * to, y1: cy + uy * to, w0: fx.weight * (0.6 + fxNoise(i * 5 + 10, fx.seed)), w1: 0 }, box);
    if (s) spikes.push(s);
  }
  return { star, spikes };
}

/** Liang–Barsky clip of a segment to the box; weights are interpolated to the kept part. */
export function clipToBox(s: Seg, b: Box): Seg | null {
  let t0 = 0, t1 = 1; const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const edges: Array<[number, number]> = [[-dx, s.x0 - b.x], [dx, b.x + b.w - s.x0], [-dy, s.y0 - b.y], [dy, b.y + b.h - s.y0]];
  for (const [p, q] of edges) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t1 - t0 < 1e-6) return null;
  const lerp = (a: number, c: number, t: number) => a + (c - a) * t;
  return { x0: lerp(s.x0, s.x1, t0), y0: lerp(s.y0, s.y1, t0), x1: lerp(s.x0, s.x1, t1), y1: lerp(s.y0, s.y1, t1), w0: lerp(s.w0, s.w1, t0), w1: lerp(s.w0, s.w1, t1) };
}

/** a tapered line as a filled quad: wide w0 at the start, w1 at the end */
export function taperPath(p: Path2D, s: Seg): void {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0; const L = Math.hypot(dx, dy) || 1; const nx = -dy / L, ny = dx / L;
  p.moveTo(s.x0 + nx * s.w0 / 2, s.y0 + ny * s.w0 / 2);
  p.lineTo(s.x1 + nx * s.w1 / 2, s.y1 + ny * s.w1 / 2);
  p.lineTo(s.x1 - nx * s.w1 / 2, s.y1 - ny * s.w1 / 2);
  p.lineTo(s.x0 - nx * s.w0 / 2, s.y0 - ny * s.w0 / 2);
  p.closePath();
}

/**
 * Tone ramp dots: a square grid of `lpi` lines per inch rotated 45° (the print convention) whose
 * dot radius follows the coverage ramp from `toneFrom` at the box's start edge (along `angle`) to
 * `toneTo` at the far edge. Returns the dot centres and radii; the caller clips to the box.
 */
export function toneDots(fx: Fx, box: Box, dpi: number): Array<{ x: number; y: number; r: number }> {
  const pitch = Math.max(2, dpi / Math.max(5, fx.lpi)); const a = Math.PI / 4;
  const ux = Math.cos(a), uy = Math.sin(a); const vx = -uy, vy = ux;
  const ra = (fx.angle * Math.PI) / 180; const rx = Math.cos(ra), ry = Math.sin(ra);
  // ramp runs across the box's projection on the ramp direction
  const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => x! * rx + y! * ry);
  const lo = Math.min(...corners), hi = Math.max(...corners); const span = Math.max(1e-6, hi - lo);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2; const half = Math.hypot(box.w, box.h) / 2;
  const n = Math.ceil(half / pitch); const out: Array<{ x: number; y: number; r: number }> = [];
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
    const x = cx + (i * ux + j * vx) * pitch, y = cy + (i * uy + j * vy) * pitch;
    if (x < box.x - pitch || x > box.x + box.w + pitch || y < box.y - pitch || y > box.y + box.h + pitch) continue;
    const t = ((x * rx + y * ry) - lo) / span; const cov = fx.toneFrom + (fx.toneTo - fx.toneFrom) * Math.min(1, Math.max(0, t));
    if (cov <= 0.005) continue;
    // a dot of radius r in a cell of area pitch² covers π r² / pitch²; invert for r (capped so dots join at 100%)
    const r = Math.min(pitch * 0.75, Math.sqrt((cov * pitch * pitch) / Math.PI));
    out.push({ x, y, r });
  }
  return out;
}

function hexRgb(hex: string): string { const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex); return m ? `${parseInt(m[1]!, 16)},${parseInt(m[2]!, 16)},${parseInt(m[3]!, 16)}` : "20,20,20"; }

function clipPanel(ctx: CanvasRenderingContext2D, fx: Fx, panels: Panel[]): void {
  if (fx.panelId === null) return;
  const p = panels.find((q) => q.id === fx.panelId); if (!p || p.polygon.length < 3) return;
  ctx.beginPath(); p.polygon.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.clip();
}

/** draw one effect on a context already in document space */
export function drawFx(ctx: CanvasRenderingContext2D, fx: Fx, panels: Panel[], dpi: number, selected = false, zoom = 1): void {
  const box = fxBox(fx, panels);
  ctx.save(); ctx.globalAlpha = fx.opacity;
  ctx.beginPath(); ctx.rect(box.x, box.y, box.w, box.h); ctx.clip();
  clipPanel(ctx, fx, panels);
  ctx.fillStyle = fx.ink;
  if (fx.kind === "speed" || fx.kind === "focus") {
    const segs = fx.kind === "speed" ? speedLines(fx, box) : focusLines(fx, box);
    const p = new Path2D(); for (const s of segs) taperPath(p, s); ctx.fill(p);
  } else if (fx.kind === "flash") {
    const { star, spikes } = flashShape(fx, box);
    const p = new Path2D(); for (const s of spikes) taperPath(p, s); ctx.fill(p);
    const st = new Path2D(); star.forEach((q, i) => (i ? st.lineTo(q.x, q.y) : st.moveTo(q.x, q.y))); st.closePath();
    ctx.fillStyle = "#ffffff"; ctx.fill(st); ctx.strokeStyle = fx.ink; ctx.lineWidth = fx.weight; ctx.lineJoin = "miter"; ctx.stroke(st);
  } else if (fx.kind === "tone") {
    const pitch = dpi / Math.max(5, fx.lpi);
    if (pitch * zoom < 3) {
      // zoomed out, the dots would alias into moiré bands: show the coverage ramp as a smooth gradient instead
      // (the export and any zoom where a dot is 3 px or more draw the real dots)
      const ra = (fx.angle * Math.PI) / 180; const rx = Math.cos(ra), ry = Math.sin(ra);
      const corners = [[box.x, box.y], [box.x + box.w, box.y], [box.x, box.y + box.h], [box.x + box.w, box.y + box.h]].map(([x, y]) => x! * rx + y! * ry);
      const lo = Math.min(...corners), hi = Math.max(...corners);
      const g = ctx.createLinearGradient(rx * lo, ry * lo, rx * hi, ry * hi);
      const rgb = hexRgb(fx.ink); g.addColorStop(0, `rgba(${rgb},${fx.toneFrom})`); g.addColorStop(1, `rgba(${rgb},${fx.toneTo})`);
      ctx.fillStyle = g; ctx.fillRect(box.x, box.y, box.w, box.h);
    } else { const p = new Path2D(); for (const d of toneDots(fx, box, dpi)) { p.moveTo(d.x + d.r, d.y); p.arc(d.x, d.y, d.r, 0, Math.PI * 2); } ctx.fill(p); }
  } else if (fx.kind === "sfx") {
    ctx.translate(fx.anchor.x, fx.anchor.y); ctx.rotate((fx.angle * Math.PI) / 180); ctx.transform(1, 0, Math.tan((fx.slant * Math.PI) / 180), 1, 0, 0);
    ctx.font = `${fx.bold ? "900 " : ""}${fx.size}px ${fx.font}`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    const lines = fx.text.split("\n"); const lh = fx.size * 1.05;
    lines.forEach((line, i) => {
      const y = (i - (lines.length - 1) / 2) * lh;
      if (fx.halo > 0) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = fx.outline * 2 + fx.halo * 2; ctx.strokeText(line, 0, y); }
      if (fx.outline > 0) { ctx.strokeStyle = fx.ink; ctx.lineWidth = fx.outline * 2; ctx.strokeText(line, 0, y); }
      ctx.fillStyle = fx.fill; ctx.fillText(line, 0, y);
    });
  }
  ctx.restore();
  if (selected) {
    ctx.save(); ctx.strokeStyle = "#4da3ff"; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]); ctx.strokeRect(box.x, box.y, box.w, box.h); ctx.setLineDash([]);
    ctx.fillStyle = "#4da3ff"; ctx.beginPath(); ctx.arc(fx.anchor.x, fx.anchor.y, 6, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke(); ctx.restore();
  }
}

/** the topmost effect whose box contains (x, y), or null */
export function fxAt(list: Fx[], panels: Panel[], x: number, y: number): Fx | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const f = list[i]!; const b = fxBox(f, panels);
    if (f.kind === "sfx") { const r = f.size * Math.max(1, f.text.length * 0.3); if (Math.hypot(x - f.anchor.x, y - f.anchor.y) <= r) return f; continue; }
    if (x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h) return f;
  }
  return null;
}

/** the panel whose bounds contain the point, or null */
export function panelAtPoint(panels: Panel[], x: number, y: number): Panel | null {
  for (const p of panels) {
    // ray cast on the polygon
    let inside = false; const poly = p.polygon;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i]!, b = poly[j]!;
      if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    if (inside) return p;
  }
  return null;
}

/**
 * Turn an effect into pixels on a new raster layer (so you can paint over it, erase bits of it,
 * or blend it) and take it out of the vector list. Returns the layer.
 */
export function bakeFx(doc: import("./document.js").Doc, fx: Fx): import("./document.js").Layer {
  const box = fxBox(fx, doc.panels);
  // sfx lettering can spill past its box: bake a generous area around the anchor
  const pad = fx.kind === "sfx" ? fx.size * Math.max(2, fx.text.length) : fx.weight * 2;
  const x0 = Math.max(0, Math.floor(Math.min(box.x, fx.anchor.x - pad) - pad)), y0 = Math.max(0, Math.floor(Math.min(box.y, fx.anchor.y - pad) - pad));
  const x1 = Math.min(doc.width, Math.ceil(Math.max(box.x + box.w, fx.anchor.x + pad) + pad)), y1 = Math.min(doc.height, Math.ceil(Math.max(box.y + box.h, fx.anchor.y + pad) + pad));
  const out = doc.addLayer("raster"); out.name = `${fx.kind === "sfx" ? fx.text.split("\n")[0] : fx.kind} fx`;
  if (fx.panelId !== null) out.panelMask = fx.panelId;
  for (const t of out.tilesIn(x0, y0, x1, y1, true)) {
    if (!t.ctx) continue; const g = t.ctx as CanvasRenderingContext2D;
    g.save(); g.translate(-t.x * TILE, -t.y * TILE); drawFx(g, fx, doc.panels, doc.dpi); g.restore(); t.generation++;
  }
  out.generation++;
  return out;
}
