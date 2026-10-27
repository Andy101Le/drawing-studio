/**
 * Viewport input: Pointer Events (pen/touch/mouse) → brush engine or navigation.
 * Pen samples use getCoalescedEvents() to recover every hardware sample the
 * browser batched into one frame. Two-finger touch pans/zooms/rotates.
 * Space+drag pans, wheel zooms about the cursor, Ctrl+Z / Ctrl+Shift+Z undo/redo.
 */

import { OneEuro, StrokeEngine, floodFill, polygonFill, type StrokeSample } from "../engine/brush.js";
import { createSelectController } from "./select-tools.js";
import type { Tool } from "./state.js";
import { balloonAt, newBalloon } from "../engine/manga.js";
import { fxAt, newFx } from "../engine/manga-fx.js";
import { nearestNode, nearestSegment, rdp, type VPt } from "../engine/vector.js";
import { newId, type VectorPath } from "../engine/document.js";
import { applySplit, panelAt } from "../engine/panels.js";
import { Layer } from "../engine/document.js";
import type { AppState } from "./state.js";

export interface StrokeDriver {
  /** begin a stroke from an external device; coords in document units */
  begin(s: StrokeSample): void;
  move(s: StrokeSample): void;
  end(): void;
  /** selection controller (marquee / wand / move) for the overlay */
  select: import("./select-tools.js").SelectController;
  /** map normalized tablet coordinates (0..1 over the viewport) to document units */
  tabletToDoc(nx: number, ny: number): { x: number; y: number };
}

export function bindViewport(canvas: HTMLCanvasElement, app: AppState): StrokeDriver {
  let engine: StrokeEngine | null = null;
  let activePointer: number | null = null;
  let space = false;
  const select = createSelectController(app);
  app.on("doc-reset", () => select.reset());
  app.on("tool", () => select.toolChanged(app.tool));
  let selDrag = false;
  // ---- text / balloon tool: drag on empty space creates a balloon, drag inside moves it,
  // drag the tail dot re-aims the tail; the Manga panel edits the text ----
  let textDrag: { kind: "create" | "move" | "tail"; start: { x: number; y: number }; b: import("../engine/manga.js").Balloon; orig: { x: number; y: number; tx: number; ty: number } } | null = null;
  function textDown(e: PointerEvent) {
    const p = docPt(e); const z = app.renderer.view.zoom;
    const sel = app.doc.balloons.find((b) => b.id === app.selectedBalloon);
    if (sel && sel.tail && Math.hypot(sel.tail.x - p.x, sel.tail.y - p.y) < 10 / z) { textDrag = { kind: "tail", start: p, b: sel, orig: { x: sel.x, y: sel.y, tx: sel.tail.x, ty: sel.tail.y } }; return; }
    const hit = balloonAt(app.doc.balloons, p.x, p.y);
    if (hit) { app.selectedBalloon = hit.id; textDrag = { kind: "move", start: p, b: hit, orig: { x: hit.x, y: hit.y, tx: hit.tail?.x ?? 0, ty: hit.tail?.y ?? 0 } }; app.invalidate(); app.emit("balloons"); return; }
    const b = newBalloon(p.x, p.y, 1, 1, app.balloonKind, app.doc.dpi);
    textDrag = { kind: "create", start: p, b, orig: { x: p.x, y: p.y, tx: 0, ty: 0 } };
  }
  function textMove(e: PointerEvent) {
    if (!textDrag) return; const p = docPt(e); const d = textDrag;
    if (d.kind === "create") { d.b.x = Math.min(d.start.x, p.x); d.b.y = Math.min(d.start.y, p.y); d.b.w = Math.abs(p.x - d.start.x); d.b.h = Math.abs(p.y - d.start.y); if (d.b.tail) { d.b.tail.x = d.b.x + d.b.w * 0.3; d.b.tail.y = d.b.y + d.b.h + app.doc.dpi * 0.35; } if (!app.doc.balloons.includes(d.b)) app.doc.balloons.push(d.b); app.selectedBalloon = d.b.id; }
    else if (d.kind === "move") { const dx = p.x - d.start.x, dy = p.y - d.start.y; d.b.x = d.orig.x + dx; d.b.y = d.orig.y + dy; if (d.b.tail) { d.b.tail.x = d.orig.tx + dx; d.b.tail.y = d.orig.ty + dy; } }
    else if (d.b.tail) { d.b.tail.x = p.x; d.b.tail.y = p.y; }
    app.invalidate();
  }
  function textUp(_e: PointerEvent) {
    const d = textDrag; textDrag = null; if (!d) return;
    const list = app.doc.balloons; const b = d.b;
    if (d.kind === "create") {
      if (b.w < 8 || b.h < 8) { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); app.selectedBalloon = null; app.invalidate(); app.emit("balloons"); return; }
      app.history.pushCustom("Add balloon", () => { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); app.selectedBalloon = null; app.invalidate(); app.emit("balloons"); }, () => { list.push(b); app.invalidate(); app.emit("balloons"); });
    } else {
      const before = { ...d.orig }, after = { x: b.x, y: b.y, tx: b.tail?.x ?? 0, ty: b.tail?.y ?? 0 };
      const apply = (s: typeof before) => { b.x = s.x; b.y = s.y; if (b.tail) { b.tail.x = s.tx; b.tail.y = s.ty; } app.invalidate(); };
      if (before.x !== after.x || before.y !== after.y || before.tx !== after.tx || before.ty !== after.ty) app.history.pushCustom(d.kind === "tail" ? "Aim tail" : "Move balloon", () => apply(before), () => apply(after));
    }
    app.invalidate(); app.emit("balloons");
  }
  // ---- manga effects tool: like balloons: drag on empty space creates one of app.fxKind, drag inside
  // moves it (box and anchor together), drag the blue anchor dot re-aims it ----
  let fxDrag: { kind: "create" | "move" | "anchor"; start: { x: number; y: number }; f: import("../engine/manga-fx.js").Fx; orig: { x: number; y: number; ax: number; ay: number } } | null = null;
  function fxDown(e: PointerEvent) {
    const p = docPt(e); const z = app.renderer.view.zoom; const list = app.doc.fx;
    const sel = list.find((f) => f.id === app.selectedFx);
    if (sel && Math.hypot(sel.anchor.x - p.x, sel.anchor.y - p.y) < 10 / z) { fxDrag = { kind: "anchor", start: p, f: sel, orig: { x: sel.x, y: sel.y, ax: sel.anchor.x, ay: sel.anchor.y } }; return; }
    const hit = fxAt(list, app.doc.panels, p.x, p.y);
    if (hit) { app.selectedFx = hit.id; fxDrag = { kind: "move", start: p, f: hit, orig: { x: hit.x, y: hit.y, ax: hit.anchor.x, ay: hit.anchor.y } }; app.invalidate(); app.emit("fx"); return; }
    const f = newFx(app.fxKind, p.x, p.y, 1, 1, app.doc.dpi);
    fxDrag = { kind: "create", start: p, f, orig: { x: p.x, y: p.y, ax: p.x, ay: p.y } };
  }
  function fxMove(e: PointerEvent) {
    if (!fxDrag) return; const p = docPt(e); const d = fxDrag; const f = d.f;
    if (d.kind === "create") {
      f.x = Math.min(d.start.x, p.x); f.y = Math.min(d.start.y, p.y); f.w = Math.abs(p.x - d.start.x); f.h = Math.abs(p.y - d.start.y);
      f.anchor = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
      if (!app.doc.fx.includes(f)) app.doc.fx.push(f); app.selectedFx = f.id;
    } else if (d.kind === "move") {
      const dx = p.x - d.start.x, dy = p.y - d.start.y;
      if (f.panelId === null) { f.x = d.orig.x + dx; f.y = d.orig.y + dy; }
      f.anchor = { x: d.orig.ax + dx, y: d.orig.ay + dy };
    } else f.anchor = { x: p.x, y: p.y };
    app.invalidate();
  }
  function fxUp(_e: PointerEvent) {
    const d = fxDrag; fxDrag = null; if (!d) return;
    const list = app.doc.fx; const f = d.f;
    if (d.kind === "create") {
      // a click (no drag) on an sfx places the lettering at the click; other kinds need a box
      if (f.w < 8 || f.h < 8) {
        if (f.kind === "sfx") { const s = app.doc.dpi * 1.5; f.x = d.start.x - s / 2; f.y = d.start.y - s / 2; f.w = f.h = s; f.anchor = { x: d.start.x, y: d.start.y }; if (!list.includes(f)) list.push(f); app.selectedFx = f.id; }
        else { const i = list.indexOf(f); if (i >= 0) list.splice(i, 1); app.selectedFx = null; app.invalidate(); app.emit("fx"); return; }
      }
      app.history.pushCustom(`Add ${f.kind} effect`, () => { const i = list.indexOf(f); if (i >= 0) list.splice(i, 1); app.selectedFx = null; app.invalidate(); app.emit("fx"); }, () => { list.push(f); app.invalidate(); app.emit("fx"); });
    } else {
      const before = { ...d.orig }, after = { x: f.x, y: f.y, ax: f.anchor.x, ay: f.anchor.y };
      const apply = (s: typeof before) => { f.x = s.x; f.y = s.y; f.anchor = { x: s.ax, y: s.ay }; app.invalidate(); app.emit("fx"); };
      if (before.x !== after.x || before.y !== after.y || before.ax !== after.ax || before.ay !== after.ay) app.history.pushCustom(d.kind === "anchor" ? "Aim effect" : "Move effect", () => apply(before), () => apply(after));
    }
    app.invalidate(); app.emit("fx");
  }
  let last = { x: 0, y: 0 };
  let cutStart: { x: number; y: number } | null = null;
  let pendingTouch: { s: StrokeSample; sx: number; sy: number } | null = null;
  let lassoPts: Array<{ x: number; y: number }> | null = null;
  let lassoStart: { x: number; y: number } | null = null;
  // vector tool state
  let vecPts: VPt[] | null = null;
  let vfx = new OneEuro(1.5, 50), vfy = new OneEuro(1.5, 50);
  let nodeDrag: { path: VectorPath; index: number; start: VPt; orig: VPt[] } | null = null;
  const touches = new Map<number, { x: number; y: number }>();
  let pinch: { dist: number; angle: number; mid: { x: number; y: number } } | null = null;
  let rateWin = { t: performance.now(), n: 0 };

  let extraEngines: StrokeEngine[] = [];
  const symTransforms = (): Array<(q: { x: number; y: number }) => { x: number; y: number }> => {
    const sy = app.symmetry; if (sy.kind === "none") return [];
    const out: Array<(q: { x: number; y: number }) => { x: number; y: number }> = [];
    if (sy.kind === "mirror") {
      const a = (sy.angle * Math.PI) / 180; const ux = Math.cos(a), uy = Math.sin(a);
      out.push((q) => { const dx = q.x - sy.cx, dy = q.y - sy.cy; const d = dx * ux + dy * uy; const px = sy.cx + ux * d, py = sy.cy + uy * d; return { x: 2 * px - q.x, y: 2 * py - q.y }; });
    } else {
      for (let k = 1; k < sy.count; k++) { const a = (k / sy.count) * Math.PI * 2; const c = Math.cos(a), sn = Math.sin(a); out.push((q) => { const dx = q.x - sy.cx, dy = q.y - sy.cy; return { x: sy.cx + dx * c - dy * sn, y: sy.cy + dx * sn + dy * c }; }); }
      if (sy.mirrorRadial) { const base = [...out]; const mir = (q: { x: number; y: number }) => ({ x: 2 * sy.cx - q.x, y: q.y }); out.push(mir); for (const f of base) out.push((q) => f(mir(q))); }
    }
    return out;
  };
  let symFns: Array<(q: { x: number; y: number }) => { x: number; y: number }> = [];
  const symSample = (sm: StrokeSample, f: (q: { x: number; y: number }) => { x: number; y: number }): StrokeSample => { const q = f(sm); return { ...sm, x: q.x, y: q.y }; };
  const startEngine = (layer: Layer, s: StrokeSample) => {
    anchor = null; lastSampleTs = -1;
    if (app.floating) select.commitFloating();
    symFns = symTransforms();
    extraEngines = symFns.map(() => new StrokeEngine({ preset: app.preset, color: app.color, layer, pageWidth: app.doc.width, pageHeight: app.doc.height, docScale: app.doc.width / 2480, beforeTileWrite: (l, tx, ty) => app.history.capture(l, tx, ty), clip: app.selection, wasm: null }));
    app.extraStrokes = extraEngines;
    engine = new StrokeEngine({ preset: app.preset, color: app.color, layer, pageWidth: app.doc.width, pageHeight: app.doc.height, docScale: app.doc.width / 2480, beforeTileWrite: (l, tx, ty) => app.history.capture(l, tx, ty), clip: app.selection, wasm: app.useWasmBrush ? app.wasmBrush : null });
    app.activeStroke = engine;
    const g = app.preset.size;
    app.history.begin(layer, { x0: s.x - g, y0: s.y - g, x1: s.x + g, y1: s.y + g }, app.preset.kind === "eraser" ? "Erase" : app.preset.kind === "smudge" ? "Smudge" : app.preset.kind === "blur" ? "Blur" : `Brush ${app.preset.name}`);
    engine.begin(s);
    extraEngines.forEach((x, i) => x.begin(symSample(s, symFns[i]!)));
    app.invalidateStroke(engine.dirty);
    app.emit("stroke-begin");
    app.emit("stroke-sample", { ...s, tip: true });
  };
  // the canvas rect is read once per pointer-down (and on resize), not on every sample: layout reads mid-stroke stall the input thread
  let rectCache: DOMRect | null = null;
  const canvasRect = (): DOMRect => rectCache ?? (rectCache = canvas.getBoundingClientRect());
  window.addEventListener("resize", () => (rectCache = null)); window.addEventListener("scroll", () => (rectCache = null), true);
  canvas.addEventListener("pointerdown", () => (rectCache = null), { capture: true });
  const docPt = (e: PointerEvent) => {
    const r = canvasRect();
    return app.renderer.screenToDoc(e.clientX - r.left, e.clientY - r.top);
  };
  // pull-string stabilizer in screen space: the anchor only moves when the pointer
  // leaves a circle of radius `stabilizer` around it, along the pull direction
  let anchor: { x: number; y: number } | null = null;
  let mouseLast = { x: 0, y: 0, t: 0 }; let mouseV = 0;
  const stabilize = (sx: number, sy: number): { x: number; y: number } => {
    const rad = app.preset.stabilizer;
    if (rad <= 0 || !anchor) { anchor = { x: sx, y: sy }; return anchor; }
    const dx = sx - anchor.x, dy = sy - anchor.y, d = Math.hypot(dx, dy);
    if (d > rad) { anchor = { x: sx - (dx / d) * rad, y: sy - (dy / d) * rad }; }
    return anchor;
  };
  // ---- ruler snapping: the stroke is projected onto a guide line through its first point.
  // line ruler: parallel to a-b. perspective: the ray from the vanishing point the first
  // 6 px of movement head toward (or away from). Until the direction is known the samples
  // stay at the anchor, which reads as a steady start and avoids a hook. ----
  let rulerAnchor: { x: number; y: number } | null = null; let rulerDir: { x: number; y: number } | null = null;
  const applyRuler = (p: { x: number; y: number }): { x: number; y: number } => {
    const rl = app.ruler; if (rl.kind === "none" || (app.tool !== "brush" && app.tool !== "eraser")) return p;
    if (rl.kind === "curve") return projectPolyline(p, curveSamples());
    if (rl.kind === "ellipse") {
      const e = rl.ellipse; const c = Math.cos(-e.rot), sn = Math.sin(-e.rot);
      const lx = (p.x - e.cx) * c - (p.y - e.cy) * sn, ly = (p.x - e.cx) * sn + (p.y - e.cy) * c;
      // nearest point on the ellipse by angle in normalised space (exact for circles, close for mild eccentricity)
      const a = Math.atan2(ly / Math.max(1e-6, e.ry), lx / Math.max(1e-6, e.rx)); const qx = Math.cos(a) * e.rx, qy = Math.sin(a) * e.ry;
      const c2 = Math.cos(e.rot), s2 = Math.sin(e.rot);
      return { x: e.cx + qx * c2 - qy * s2, y: e.cy + qx * s2 + qy * c2 };
    }
    if (!rulerAnchor) { rulerAnchor = { x: p.x, y: p.y }; rulerDir = null; }
    const a = rulerAnchor;
    if (!rulerDir) {
      if (rl.kind === "line") { const dx = rl.b.x - rl.a.x, dy = rl.b.y - rl.a.y, l = Math.hypot(dx, dy) || 1; rulerDir = { x: dx / l, y: dy / l }; }
      else {
        const mv = Math.hypot(p.x - a.x, p.y - a.y);
        if (mv < 6 / app.renderer.view.zoom || !rl.vps.length) return a;
        const md = { x: (p.x - a.x) / mv, y: (p.y - a.y) / mv };
        let best = rl.vps[0]!, bestDot = -1;
        for (const v of rl.vps) { const dx = v.x - a.x, dy = v.y - a.y, l = Math.hypot(dx, dy) || 1; const dot = Math.abs((dx / l) * md.x + (dy / l) * md.y); if (dot > bestDot) { bestDot = dot; best = v; } }
        const dx = best.x - a.x, dy = best.y - a.y, l = Math.hypot(dx, dy) || 1; rulerDir = { x: dx / l, y: dy / l };
      }
    }
    const t = (p.x - a.x) * rulerDir.x + (p.y - a.y) * rulerDir.y;
    return { x: a.x + rulerDir.x * t, y: a.y + rulerDir.y * t };
  };
  let curveCache: { key: string; pts: Array<{ x: number; y: number }> } | null = null;
  function curveSamples(): Array<{ x: number; y: number }> {
    const c = app.ruler.curve; const key = c.map((q) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`).join(";");
    if (curveCache && curveCache.key === key) return curveCache.pts;
    const pts: Array<{ x: number; y: number }> = [];
    if (c.length >= 2) {
      const N = 240;
      for (let i = 0; i <= N; i++) { const t = i / N; pts.push(bezierAt(c, t)); }
    }
    curveCache = { key, pts }; return pts;
  }
  function bezierAt(c: Array<{ x: number; y: number }>, t: number): { x: number; y: number } {
    if (c.length === 2) return { x: c[0]!.x + (c[1]!.x - c[0]!.x) * t, y: c[0]!.y + (c[1]!.y - c[0]!.y) * t };
    if (c.length === 3) { const u = 1 - t; return { x: u * u * c[0]!.x + 2 * u * t * c[1]!.x + t * t * c[2]!.x, y: u * u * c[0]!.y + 2 * u * t * c[1]!.y + t * t * c[2]!.y }; }
    const u = 1 - t; const p0 = c[0]!, p1 = c[1]!, p2 = c[2]!, p3 = c[3]!;
    return { x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x, y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y };
  }
  function projectPolyline(p: { x: number; y: number }, pts: Array<{ x: number; y: number }>): { x: number; y: number } {
    if (pts.length < 2) return p;
    let best = p, bd = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!, b = pts[i + 1]!; const dx = b.x - a.x, dy = b.y - a.y; const l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)); const q = { x: a.x + dx * t, y: a.y + dy * t };
      const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2; if (d < bd) { bd = d; best = q; }
    }
    return best;
  }
  const sample = (e: PointerEvent): StrokeSample => {
    const r = canvas.getBoundingClientRect();
    const st = stabilize(e.clientX - r.left, e.clientY - r.top);
    const p = applyRuler(app.renderer.screenToDoc(st.x, st.y));
    // mouse has no pressure: simulate it from speed (slow = firm, fast = light) so dynamics are visible
    let pressure = e.pointerType === "mouse" ? 0.55 : e.pressure;
    if (e.pointerType === "mouse" && app.mousePressure === "speed") {
      const now = e.timeStamp; const dt = Math.max(4, now - mouseLast.t); const v = Math.hypot(st.x - mouseLast.x, st.y - mouseLast.y) / dt * 1000;
      mouseLast = { x: st.x, y: st.y, t: now };
      mouseV = mouseV * 0.7 + v * 0.3;
      pressure = Math.max(0.15, Math.min(0.95, 0.9 - 0.6 * Math.min(1, mouseV / 1400)));
    }
    return { x: p.x, y: p.y, pressure, tiltX: e.tiltX, tiltY: e.tiltY, tMs: e.timeStamp };
  };

  canvas.addEventListener("pointerdown", (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already-released pointer */ }
    const r = canvas.getBoundingClientRect();
    last = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.pointerType === "touch") {
      touches.set(e.pointerId, last);
      if (touches.size === 2) { pinch = pinchState(); activePointer = null; engine = null; }
      if (touches.size >= 2) return;
    }
    const navTool = space || app.tool === "pan" || e.button === 1 || (e.pointerType === "mouse" && e.button === 2);
    if (navTool || app.tool === "zoom" || app.tool === "rotate") { activePointer = e.pointerId; return; }
    if (app.tool === "panel-cut") { cutStart = docPt(e); activePointer = e.pointerId; return; }
    if (app.tool === "eyedrop") { eyedrop(e); return; }
    if (app.tool === "text") { textDown(e); activePointer = e.pointerId; e.preventDefault(); return; }
    if (app.tool === "fx") { fxDown(e); activePointer = e.pointerId; e.preventDefault(); return; }
    if (app.tool === "ruler") { rulerDown(e); activePointer = e.pointerId; e.preventDefault(); return; }
    if (app.tool === "gradient") { gradDrag = { a: docPt(e), b: docPt(e) }; activePointer = e.pointerId; e.preventDefault(); return; }
    if (app.tool === "select" || app.tool === "wand" || app.tool === "move") { if (select.down(e, docPt(e))) { activePointer = e.pointerId; selDrag = true; e.preventDefault(); } return; }
    if (app.tool === "fill") { lassoPts = [docPt(e)]; lassoStart = { x: e.clientX, y: e.clientY }; activePointer = e.pointerId; e.preventDefault(); return; }
    if (app.tool === "vector") {
      const layer = app.doc.activeLayer;
      if (layer.kind !== "vector" || layer.locked) return;
      activePointer = e.pointerId; vfx.reset(); vfy.reset();
      const p = docPt(e); vecPts = [{ x: vfx.filter(p.x, e.timeStamp / 1000), y: vfy.filter(p.y, e.timeStamp / 1000), p: e.pointerType === "mouse" ? 0.6 : e.pressure }];
      app.emit("vector-preview", vecPts); e.preventDefault(); return;
    }
    if (app.tool === "node") {
      const layer = app.doc.activeLayer;
      if (layer.kind !== "vector" || layer.locked) return;
      const p = docPt(e); const rad = 10 / app.renderer.view.zoom;
      const hit = nearestNode(layer.paths, p.x, p.y, rad);
      if (hit) {
        if (e.shiftKey) { // shift-click deletes the node
          const removed = hit.path.points[hit.index]!; const idx = hit.index; const path = hit.path;
          if (path.points.length > 2) { path.points.splice(idx, 1); app.history.pushCustom("Delete node", () => path.points.splice(idx, 0, removed), () => path.points.splice(idx, 1)); app.invalidate(); app.emit("vector"); }
          return;
        }
        activePointer = e.pointerId;
        nodeDrag = { path: hit.path, index: hit.index, start: p as VPt, orig: hit.path.points.map((q) => ({ ...q })) };
        app.selectedNode = { pathId: hit.path.id, index: hit.index }; app.emit("vector"); return;
      }
      const seg = nearestSegment(layer.paths, p.x, p.y, rad);
      if (seg && e.detail >= 2) { // double-click inserts a node on the segment
        const path = seg.path, idx = seg.index + 1; const a = path.points[seg.index]!, b = path.points[seg.index + 1]!;
        const np: VPt = { x: p.x, y: p.y, p: (a.p + b.p) / 2 };
        path.points.splice(idx, 0, np); app.history.pushCustom("Insert node", () => path.points.splice(idx, 1), () => path.points.splice(idx, 0, np)); app.invalidate(); app.emit("vector");
        return;
      }
      if (seg && e.altKey) { // alt-drag moves the whole path
        activePointer = e.pointerId; nodeDrag = { path: seg.path, index: -1, start: p as VPt, orig: seg.path.points.map((q) => ({ ...q })) }; return;
      }
      app.selectedNode = null; app.emit("vector");
      return;
    }
    if (e.pointerType === "touch" && app.tool !== "brush" && app.tool !== "eraser") return;
    const layer = app.doc.activeLayer;
    if (layer.locked || layer.kind === "npr") return;
    activePointer = e.pointerId;
    app.statusInput.source = e.pointerType;
    const s = sample(e);
    if (e.pointerType === "touch") { pendingTouch = { s, sx: e.clientX, sy: e.clientY }; e.preventDefault(); return; }
    startEngine(layer, s);
    e.preventDefault();
  });

  const onMove = (e: PointerEvent) => {
    const r = canvasRect();
    const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
    if (e.pointerType === "touch" && touches.has(e.pointerId)) {
      touches.set(e.pointerId, cur);
      if (touches.size === 2 && pinch) {
        const now = pinchState();
        app.renderer.zoomAt(now.mid.x, now.mid.y, now.dist / pinch.dist);
        app.renderer.rotateBy(now.angle - pinch.angle);
        app.renderer.panBy(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
        pinch = now; app.emit("view");
        return;
      }
    }
    if (activePointer !== e.pointerId) return;
    if (lassoPts) {
      if (app.fillLasso && Math.hypot(e.clientX - lassoStart!.x, e.clientY - lassoStart!.y) > 6) { lassoPts.push(docPt(e)); app.emit("lasso-preview", lassoPts); }
      return;
    }
    if (textDrag) { textMove(e); return; }
    if (fxDrag) { fxMove(e); return; }
    if (rulerDrag) { app.emit("sel-preview"); return; }
    if (gradDrag) { gradDrag.b = docPt(e); app.emit("lasso-preview", [gradDrag.a, gradDrag.b]); return; }
    if (selDrag) { select.move(e, docPt(e)); return; }
    if (vecPts) {
      const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      for (const ce of evs.length ? evs : [e]) { const p = docPt(ce); vecPts.push({ x: vfx.filter(p.x, ce.timeStamp / 1000), y: vfy.filter(p.y, ce.timeStamp / 1000), p: ce.pointerType === "mouse" ? 0.6 : ce.pressure }); }
      app.emit("vector-preview", vecPts); return;
    }
    if (nodeDrag) {
      const p = docPt(e); const dx = p.x - nodeDrag.start.x, dy = p.y - nodeDrag.start.y;
      if (nodeDrag.index < 0) nodeDrag.path.points.forEach((q, i) => { q.x = nodeDrag!.orig[i]!.x + dx; q.y = nodeDrag!.orig[i]!.y + dy; });
      else { const q = nodeDrag.path.points[nodeDrag.index]!; q.x = nodeDrag.orig[nodeDrag.index]!.x + dx; q.y = nodeDrag.orig[nodeDrag.index]!.y + dy; }
      app.invalidate(); app.emit("vector"); return;
    }
    if (pendingTouch) {
      if (Math.hypot(e.clientX - pendingTouch.sx, e.clientY - pendingTouch.sy) < 8) return;
      startEngine(app.doc.activeLayer, pendingTouch.s);
      pendingTouch = null;
    }
    if (engine) {
      const evs = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
      const list = evs.length ? evs : [e];
      rateWin.n += list.length;
      if (performance.now() - rateWin.t > 1000) { app.statusInput.rateHz = rateWin.n; rateWin = { t: performance.now(), n: 0 }; }
      for (const ce of list) {
        if (ce.timeStamp === lastSampleTs && ce.clientX === lastSampleX && ce.clientY === lastSampleY) continue; // the same hardware sample arrives twice (raw, then coalesced): take it once
        lastSampleTs = ce.timeStamp; lastSampleX = ce.clientX; lastSampleY = ce.clientY;
        const sm = sample(ce); engine.move(sm); extraEngines.forEach((x, i) => { x.move(symSample(sm, symFns[i]!)); app.invalidateStroke(x.takeDirty()); }); app.emit("stroke-sample", { ...sm, tip: true }); }
      app.statusInput.pressure = engine.strength;
      app.emit("status");
      app.invalidateStroke(engine.takeDirty()); // only what this batch of samples touched
      engine.prefetchHistory();
      return;
    }
    const dx = cur.x - last.x, dy = cur.y - last.y;
    if (app.tool === "zoom") app.renderer.zoomAt(last.x, last.y, Math.exp(dx * 0.005));
    else if (app.tool === "rotate") app.renderer.rotateBy(dx * 0.005);
    else if (app.tool === "panel-cut") { app.emit("cut-preview", { from: cutStart, to: docPt(e) }); }
    else app.renderer.panBy(dx, dy);
    last = cur; app.emit("view");
  };
  let lastSampleTs = -1, lastSampleX = 0, lastSampleY = 0;
  // Where the browser delivers pointerrawupdate (Chromium), every hardware sample arrives there before
  // the frame; pointermove then repeats the same samples via getCoalescedEvents, so during a stroke
  // only one of the two feeds the engine. Otherwise pointermove (with its coalesced list) does.
  canvas.addEventListener("pointermove", (e) => { app.emit("hover", { x: e.clientX, y: e.clientY, type: e.pointerType, buttons: e.buttons }); if (!selDrag && app.tool === "select" && (app.selShape === "poly" || app.selShape === "magnetic")) select.move(e, docPt(e)); onMove(e); });
  canvas.addEventListener("pointerleave", () => app.emit("hover", null));
  canvas.addEventListener("pointerrawupdate" as "pointermove", (e) => { if (engine) onMove(e); });

  // gradient tool: drag = direction and length; fills the selection (or the page) on the active raster layer
  let gradDrag: { a: { x: number; y: number }; b: { x: number; y: number } } | null = null;
  function applyGradient(a: { x: number; y: number }, b: { x: number; y: number }) {
    const layer = app.doc.activeLayer; if (layer.locked || layer.kind !== "raster") return;
    if (Math.hypot(b.x - a.x, b.y - a.y) < 2) return;
    const sel = app.selection; const bb = sel ? sel.bounds : { x0: 0, y0: 0, x1: app.doc.width - 1, y1: app.doc.height - 1 };
    const rect = { x0: bb.x0, y0: bb.y0, x1: bb.x1 + 1, y1: bb.y1 + 1 };
    app.history.begin(layer, rect, "Gradient"); app.history.captureRect(layer, rect);
    const c0 = app.color; const r0 = parseInt(c0.slice(1, 3), 16), g0 = parseInt(c0.slice(3, 5), 16), b0 = parseInt(c0.slice(5, 7), 16);
    const c1 = app.gradientEnd === "color2" ? app.color2 : `rgba(${r0},${g0},${b0},0)`;
    const tmp = new Layer("gradient", "raster"); tmp.transient = true;
    for (const t of tmp.tilesIn(rect.x0, rect.y0, rect.x1, rect.y1, true)) {
      if (!t.ctx) continue; const c = t.ctx as CanvasRenderingContext2D; c.save(); c.translate(-t.x * 256, -t.y * 256);
      const gr = app.gradientShape === "linear" ? c.createLinearGradient(a.x, a.y, b.x, b.y) : c.createRadialGradient(a.x, a.y, 0, a.x, a.y, Math.hypot(b.x - a.x, b.y - a.y));
      gr.addColorStop(0, c0); gr.addColorStop(1, c1);
      c.fillStyle = gr; c.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0); c.restore();
      if (sel) sel.clipTile(c, t.x, t.y);
      const lt = layer.getTile(t.x, t.y, true)!; if (lt.ctx && t.canvas) { (lt.ctx as CanvasRenderingContext2D).drawImage(t.canvas as CanvasImageSource, 0, 0); lt.generation++; }
    }
    app.history.commit(rect); app.invalidate(rect); app.emit("stroke-end");
  }
  // ruler placement tool: drag = line a-b; click = add a vanishing point (max 3); double-click clears
  let rulerDrag: { x: number; y: number } | null = null;
  function rulerDown(e: PointerEvent) { if (e.altKey) { const p = docPt(e); app.symmetry.cx = p.x; app.symmetry.cy = p.y; app.emit("symmetry"); app.emit("sel-preview"); return; } rulerDrag = docPt(e); }
  function rulerUp(e: PointerEvent) {
    const p = docPt(e); const s0 = rulerDrag; rulerDrag = null; if (!s0) return;
    const rl = app.ruler; const dragged = Math.hypot(p.x - s0.x, p.y - s0.y) > 6 / app.renderer.view.zoom;
    if (app.rulerPlace === "ellipse") {
      if (dragged) { rl.kind = "ellipse"; rl.ellipse = { cx: (s0.x + p.x) / 2, cy: (s0.y + p.y) / 2, rx: Math.abs(p.x - s0.x) / 2, ry: Math.abs(p.y - s0.y) / 2, rot: e.shiftKey ? Math.PI / 6 : 0 }; }
    } else if (app.rulerPlace === "curve") {
      if (rl.kind !== "curve") { rl.kind = "curve"; rl.curve = []; }
      rl.curve = [...rl.curve, p].slice(-4);
    } else if (dragged) { rl.kind = "line"; rl.a = s0; rl.b = p; }
    else { rl.kind = "perspective"; rl.vps = [...rl.vps.slice(-2), p]; }
    app.emit("ruler"); app.emit("sel-preview");
  }
  const finish = (e: PointerEvent) => {
    if (e.pointerType === "touch") { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; }
    if (activePointer !== e.pointerId) return;
    activePointer = null;
    pendingTouch = null;
    if (textDrag) { textUp(e); return; }
    if (fxDrag) { fxUp(e); return; }
    if (rulerDrag) { rulerUp(e); return; }
    if (gradDrag) { const g = gradDrag; gradDrag = null; app.emit("lasso-preview", null); applyGradient(g.a, docPt(e)); return; }
    rulerAnchor = null; rulerDir = null;
    if (selDrag) { selDrag = false; select.up(e, docPt(e)); return; }
    if (lassoPts) {
      const pts = lassoPts; lassoPts = null; app.emit("lasso-preview", null);
      if (pts.length >= 3 && app.fillLasso) lassoFill(pts); else fill(e);
      return;
    }
    if (vecPts) {
      const layer = app.doc.activeLayer; const pts = vecPts; vecPts = null; app.emit("vector-preview", null);
      const eps = app.vectorSimplify / app.renderer.view.zoom;
      const simplified = rdp(pts, eps);
      if (simplified.length >= 1) {
        const path: VectorPath = { id: newId(), points: simplified, width: app.preset.size, color: app.color, closed: false };
        layer.paths.push(path);
        app.history.pushCustom("Vector stroke", () => { layer.paths = layer.paths.filter((x) => x !== path); }, () => { layer.paths.push(path); });
        app.invalidate(); app.emit("vector"); app.emit("stroke-end");
      }
      return;
    }
    if (nodeDrag) {
      const d = nodeDrag; nodeDrag = null;
      const after = d.path.points.map((q) => ({ ...q })); const before = d.orig;
      app.history.pushCustom("Move node", () => { d.path.points = before.map((q) => ({ ...q })); }, () => { d.path.points = after.map((q) => ({ ...q })); });
      app.emit("vector"); return;
    }
    if (engine) {
      engine.end(); app.invalidateStroke(engine.takeDirty()); // taper dabs laid by end() mark their tiles like any batch
      const rect = engine.commit();
      for (const x of extraEngines) { x.end(); app.invalidateStroke(x.takeDirty()); const r2 = x.commit(); app.invalidateStrokeEnd(r2); }
      extraEngines = []; app.extraStrokes = [];
      app.activeStroke = null;
      app.history.commit(rect);
      app.invalidateStrokeEnd(rect); // only the stroke's layer changed: the cached layers around it stay valid
      engine = null;
      app.emit("stroke-end");
    } else if (app.tool === "panel-cut" && cutStart) {
      const end = docPt(e);
      const target = panelAt(app.doc.panels, { x: (cutStart.x + end.x) / 2, y: (cutStart.y + end.y) / 2 }) ?? panelAt(app.doc.panels, cutStart);
      if (target && Math.hypot(end.x - cutStart.x, end.y - cutStart.y) > 10) {
        const res = applySplit(app.doc.panels, target, cutStart, end);
        if (res) {
          app.doc.panels = res.panels;
          const halves = res.map.get(target.id) ?? [];
          for (const f of app.doc.frames) for (const l of f.layers) if (l.panelMask === target.id) l.panelMask = halves[0] ?? null;
          app.emit("panels");
        }
      }
      cutStart = null; app.emit("cut-preview", null); app.invalidate();
    }
  };
  canvas.addEventListener("pointerup", finish);
  canvas.addEventListener("pointercancel", finish);
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || !e.shiftKey) app.renderer.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    else app.renderer.panBy(-e.deltaY, 0);
    app.emit("view");
  }, { passive: false });

  window.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
    if (e.code === "Space") { if (!space) { space = true; app.spaceHeld = true; app.emit("space"); } e.preventDefault(); }
    const k = e.key.toLowerCase();
    if (select.key(e)) { e.preventDefault(); return; }
    const action = app.keymap.actionFor(e);
    if (action) {
      if (action.startsWith("tool.")) { app.setTool(action.slice(5) as Tool); e.preventDefault(); return; }
      switch (action) {
        case "edit.undo": e.preventDefault(); if (app.collab?.undo()) return; app.history.undo(app.doc); app.invalidate(app.history.lastRect ?? undefined); app.emit("layers"); return;
        case "edit.redo": case "edit.redo2": e.preventDefault(); if (app.collab?.redo()) return; app.history.redo(app.doc); app.invalidate(app.history.lastRect ?? undefined); app.emit("layers"); return;
        case "layer.clip": { e.preventDefault(); const l = app.doc.activeLayer; if (l.kind !== "group") { l.clipBelow = !l.clipBelow; app.invalidate(); app.emit("layers"); } return; }
        case "brush.smaller": app.preset.size = Math.max(1, app.preset.size * 0.85); app.emit("brush"); return;
        case "brush.larger": app.preset.size = Math.min(600, app.preset.size * 1.18); app.emit("brush"); return;
        case "anim.onion": app.doc.onionEnabled = !app.doc.onionEnabled; app.invalidate(); app.emit("timeline"); return;
        case "anim.prev": app.doc.currentFrame = Math.max(0, app.doc.currentFrame - 1); app.invalidate(); app.emit("frame"); return;
        case "anim.next": app.doc.currentFrame = Math.min(app.doc.exposure.length - 1, app.doc.currentFrame + 1); app.invalidate(); app.emit("frame"); return;
        case "view.fit": e.preventDefault(); app.renderer.fitPage(app.doc); app.emit("view"); return;
        case "edit.transform": e.preventDefault(); if (app.selection) { app.setTool("move"); select.liftNow(); } return;
        case "mode.toggle": e.preventDefault(); app.setMode(app.doc.mode === "manga" ? "anime" : "manga"); return;
      }
    }
    if (false) { /* unreachable: kept so the else-chain below stays intact */ }
    else if (k === "escape" && app.ruler.kind !== "none" && app.tool === "ruler") { app.ruler.kind = "none"; app.ruler.vps = []; app.emit("ruler"); app.emit("sel-preview"); }
    else if ((k === "delete" || k === "backspace") && app.tool === "text" && app.selectedBalloon !== null) {
      const list = app.doc.balloons; const b = list.find((q) => q.id === app.selectedBalloon); if (!b) return;
      const idx = list.indexOf(b); list.splice(idx, 1); app.selectedBalloon = null;
      app.history.pushCustom("Delete balloon", () => { list.splice(idx, 0, b); app.invalidate(); app.emit("balloons"); }, () => { const i = list.indexOf(b); if (i >= 0) list.splice(i, 1); app.invalidate(); app.emit("balloons"); });
      app.invalidate(); app.emit("balloons");
    }
    else if ((k === "delete" || k === "backspace") && app.tool === "fx" && app.selectedFx !== null) {
      const list = app.doc.fx; const f = list.find((q) => q.id === app.selectedFx); if (!f) return;
      const idx = list.indexOf(f); list.splice(idx, 1); app.selectedFx = null;
      app.history.pushCustom("Delete effect", () => { list.splice(idx, 0, f); app.invalidate(); app.emit("fx"); }, () => { const i = list.indexOf(f); if (i >= 0) list.splice(i, 1); app.invalidate(); app.emit("fx"); });
      app.invalidate(); app.emit("fx");
    }
    else if ((k === "delete" || k === "backspace") && app.selectedNode) {
      const layer = app.doc.activeLayer; const path = layer.paths.find((x) => x.id === app.selectedNode!.pathId);
      if (path && path.points.length > 2) { const idx = app.selectedNode.index; const removed = path.points[idx]!; path.points.splice(idx, 1); app.history.pushCustom("Delete node", () => path.points.splice(idx, 0, removed), () => path.points.splice(idx, 1)); app.selectedNode = null; app.invalidate(); app.emit("vector"); }
    }
  });
  window.addEventListener("keyup", (e) => { if (e.code === "Space") { space = false; app.spaceHeld = false; app.emit("space"); } });

  function pinchState() {
    const [a, b] = [...touches.values()] as [{ x: number; y: number }, { x: number; y: number }];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, angle: Math.atan2(b.y - a.y, b.x - a.x), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  function fill(e: PointerEvent) {
    const layer = app.doc.activeLayer;
    if (layer.locked || layer.kind !== "raster") return;
    const p = docPt(e);
    // document resolution up to 16 Mpx (a 2480x3508 A4 page is 8.7 Mpx); larger pages are sampled down
    const scale = Math.min(1, Math.sqrt(16e6 / (app.doc.width * app.doc.height)));
    const ref = app.renderer.flatten(app.doc, scale, app.fillReference === "current" ? new Set([layer.id]) : undefined);
    const rc = ref.getContext("2d")!; rc.globalCompositeOperation = "destination-over"; rc.fillStyle = "#fff"; rc.fillRect(0, 0, ref.width, ref.height);
    const sx = ref.width / app.doc.width;
    const tmp = new Layer("fill", "raster"); tmp.transient = true;
    const under = new Layer("fill-under", "raster"); under.transient = true;
    const t0 = performance.now();
    const r = floodFill(ref, tmp, p.x * sx, p.y * sx, app.color, {
      tolerance: app.fillTolerance, expand: app.fillExpand, mode: app.fillMode, antialias: app.fillAntialias,
      closeGap: Math.round(app.fillCloseGap * sx), autoClose: app.fillAutoClose, maxAutoGap: Math.round(app.fillMaxAutoGap * sx), stopLeaks: app.fillStopLeaks,
    }, under);
    const ms = Math.round(performance.now() - t0);
    if (!r.filled) {
      app.fillMessage = r.leaked ? `Not enclosed: the area reaches the page edge even with gaps up to ${app.fillMaxAutoGap} px closed. Close the shape, raise "Max auto gap", or turn off "Stop leaks".` : "Nothing to fill here.";
      app.emit("fill-message"); return;
    }
    app.fillMessage = r.gapUsed > 0 ? `Filled ${(r.pixels / 1e3).toFixed(0)}k px, gap closed at ${Math.round(r.gapUsed / sx)} px, ${ms} ms${r.leaked ? " (leaked)" : ""}` : `Filled ${(r.pixels / 1e3).toFixed(0)}k px, ${ms} ms`;
    app.emit("fill-message");
    const rect = { x0: r.x0 / sx, y0: r.y0 / sx, x1: r.x1 / sx, y1: r.y1 / sx };
    app.history.begin(layer, rect, "Fill");
    app.history.captureRect(layer, rect);
    // clip both parts to the selection (reference is at document resolution unless the page exceeds 16 Mpx)
    if (app.selection && sx === 1) for (const src of [tmp, under]) for (const t of src.tiles.values()) if (t.ctx) app.selection.clipTile(t.ctx as CanvasRenderingContext2D, t.x, t.y);
    // core region replaces; the ring under line art goes beneath existing pixels so lines are never eaten
    for (const [src, op] of [[tmp, "source-over"], [under, "destination-over"]] as Array<[Layer, GlobalCompositeOperation]>) {
      for (const t of src.tiles.values()) {
        for (const lt of layer.tilesIn(t.x * 256 / sx, t.y * 256 / sx, (t.x + 1) * 256 / sx, (t.y + 1) * 256 / sx, true)) {
          if (!lt.ctx || !t.canvas) continue;
          const ctx = lt.ctx as CanvasRenderingContext2D;
          ctx.save(); ctx.globalCompositeOperation = op; ctx.imageSmoothingEnabled = scale < 1; ctx.translate(-lt.x * 256, -lt.y * 256); ctx.scale(1 / sx, 1 / sx); ctx.drawImage(t.canvas as CanvasImageSource, t.x * 256, t.y * 256); ctx.restore();
          lt.generation++;
        }
      }
    }
    app.history.commit(rect); app.invalidate(rect); app.emit("stroke-end");
  }
  function lassoFill(pts: Array<{ x: number; y: number }>) {
    const layer = app.doc.activeLayer;
    if (layer.locked || layer.kind !== "raster") return;
    app.history.begin(layer, { x0: 0, y0: 0, x1: 0, y1: 0 }, "Enclose fill");
    let rect;
    if (app.selection) { // rasterise into a scratch layer, clip to the selection, then composite
      const tmp = new Layer("lasso", "raster"); tmp.transient = true;
      rect = polygonFill(tmp, pts, app.color);
      for (const t of tmp.tiles.values()) {
        if (!t.ctx || !t.canvas) continue;
        app.selection.clipTile(t.ctx as CanvasRenderingContext2D, t.x, t.y);
        app.history.capture(layer, t.x, t.y);
        const lt = layer.getTile(t.x, t.y, true)!; if (lt.ctx) { (lt.ctx as CanvasRenderingContext2D).drawImage(t.canvas as CanvasImageSource, 0, 0); lt.generation++; }
      }
    } else rect = polygonFill(layer, pts, app.color, (l, tx, ty) => app.history.capture(l, tx, ty));
    app.history.commit(rect); app.invalidate(rect); app.emit("stroke-end");
  }
  function eyedrop(e: PointerEvent) {
    if (app.renderer.mode === "webgpu") {
      const p = docPt(e); const scale = Math.min(1, 2048 / Math.max(app.doc.width, app.doc.height));
      const flat = app.renderer.flatten(app.doc, scale); const fc = flat.getContext("2d")!;
      fc.globalCompositeOperation = "destination-over"; fc.fillStyle = "#fff"; fc.fillRect(0, 0, flat.width, flat.height);
      const d = fc.getImageData(Math.max(0, Math.min(flat.width - 1, Math.floor(p.x * scale))), Math.max(0, Math.min(flat.height - 1, Math.floor(p.y * scale))), 1, 1).data;
      app.setColor("#" + [d[0]!, d[1]!, d[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")); app.setTool("brush"); return;
    }
    const r = canvas.getBoundingClientRect();
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    const dpr = canvas.width / r.width;
    const d = ctx.getImageData(Math.floor((e.clientX - r.left) * dpr), Math.floor((e.clientY - r.top) * dpr), 1, 1).data;
    app.setColor("#" + [d[0]!, d[1]!, d[2]!].map((v) => v.toString(16).padStart(2, "0")).join(""));
    app.setTool("brush");
  }

  return {
    begin(sm) { if (engine) return; const layer = app.doc.activeLayer; if (layer.locked || layer.kind === "npr") return; activePointer = -99; app.statusInput.source = "webhid"; startEngine(layer, sm); },
    move(sm) { if (!engine) return; engine.move(sm); extraEngines.forEach((x, i) => { x.move(symSample(sm, symFns[i]!)); app.invalidateStroke(x.dirty); }); app.emit("stroke-sample", { ...sm, tip: true }); app.statusInput.pressure = engine.strength; app.emit("status"); app.invalidateStroke(engine.dirty); },
    end() { if (!engine) return; engine.end(); app.invalidateStroke(engine.takeDirty()); const rect = engine.commit(); for (const x of extraEngines) { x.end(); app.invalidateStroke(x.takeDirty()); app.invalidateStrokeEnd(x.commit()); } extraEngines = []; app.extraStrokes = []; app.activeStroke = null; app.history.commit(rect); app.invalidateStrokeEnd(rect); engine = null; activePointer = null; app.emit("stroke-end"); },
    select,
    tabletToDoc(nx, ny) { const r = canvas.getBoundingClientRect(); return app.renderer.screenToDoc(nx * r.width, ny * r.height); },
  };
}
