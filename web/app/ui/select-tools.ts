/**
 * Selection tools: marquee (rectangle / ellipse / lasso / polygon), magic wand, and
 * move/transform of the selected pixels.
 *
 * Modifier convention (Photoshop / Clip Studio): Shift = add, Alt = subtract,
 * Shift+Alt = intersect. Keys: M marquee, W wand, T move/transform, Ctrl+A all,
 * Ctrl+D deselect, Ctrl+Shift+I invert, Delete clears the selected pixels,
 * Ctrl+C / Ctrl+X / Ctrl+V copy / cut / paste (paste lands on a new layer),
 * Enter commits a transform, Escape cancels it.
 *
 * Every selection change is one undo entry; move/transform is one entry that covers
 * the cut and the stamp, so undo puts the pixels back where they were.
 */
import type { AppState } from "./state.js";
import { Selection, floatingBounds, stampFloating, transformSelection, type Floating, type SelMode } from "../engine/selection.js";
import { floodFill } from "../engine/brush.js";
import { Layer } from "../engine/document.js";
import { LiveWire, buildEdgeMap, tighten as tightenSel, type EdgeMap } from "../engine/smart-select.js";

export type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "rot" | "body";

export interface SelectController {
  down(e: PointerEvent, doc: { x: number; y: number }): boolean; // true when consumed
  move(e: PointerEvent, doc: { x: number; y: number }): void;
  up(e: PointerEvent, doc: { x: number; y: number }): void;
  key(e: KeyboardEvent): boolean;
  commitFloating(): void;
  cancelFloating(): void;
  toolChanged(tool: string): void;
  reset(): void;
  /** Ctrl+T: lift the selection into a floating transform right away */
  liftNow(): void;
  /** pull the current selection onto the object's edges; returns a note for the panel */
  tighten(band: number): string | null;
  /** current drag preview for the overlay */
  preview: { shape: "rect" | "ellipse" | "lasso" | "poly"; pts: Array<{ x: number; y: number }> } | null;
  /** handle under a screen point for cursor feedback */
  handleAt(sx: number, sy: number): Handle | null;
  handleBox(): { pts: Array<{ x: number; y: number }>; rot: { x: number; y: number } } | null;
  /** panel and guide lines the floating image is snapping to (page coordinates), for the overlay */
  snap: { panel: { x0: number; y0: number; x1: number; y1: number } | null; xs: number[]; ys: number[] };
  /** size the floating image to a panel: "fit" shows all of it, "fill" covers the panel and crops to it */
  fitPanel(mode: "fit" | "fill"): void;
  /** undo scale/rotation/move of the floating image (back to where it was lifted) */
  resetTransform(): void;
}

type Box = { x0: number; y0: number; x1: number; y1: number };
const polyBox = (pts: Array<{ x: number; y: number }>): Box => ({ x0: Math.min(...pts.map((q) => q.x)), y0: Math.min(...pts.map((q) => q.y)), x1: Math.max(...pts.map((q) => q.x)), y1: Math.max(...pts.map((q) => q.y)) });

export function createSelectController(app: AppState): SelectController {
  let drag: { start: { x: number; y: number }; pts: Array<{ x: number; y: number }>; mode: SelMode } | null = null;
  let floatDrag: { handle: Handle; start: { x: number; y: number }; f0: Floating; angle0: number; dist0: number } | null = null;
  let polyPts: Array<{ x: number; y: number }> | null = null;
  const panels = () => app.doc.panels.filter((p) => p.polygon.length >= 3).map((p) => ({ p, box: polyBox(p.polygon) }));
  /** the panel under a page point, else the one the box overlaps most */
  const panelFor = (b: Box) => {
    const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; const list = panels();
    const inside = list.find((q) => c.x >= q.box.x0 && c.x <= q.box.x1 && c.y >= q.box.y0 && q.box.y1 >= c.y);
    if (inside) return inside;
    let best: (typeof list)[number] | null = null, area = 0;
    for (const q of list) { const w = Math.min(b.x1, q.box.x1) - Math.max(b.x0, q.box.x0), hh = Math.min(b.y1, q.box.y1) - Math.max(b.y0, q.box.y0); if (w > 0 && hh > 0 && w * hh > area) { area = w * hh; best = q; } }
    return best;
  };
  /** snap targets: panel edges and centres, and the page edges and centre */
  const snapLines = () => {
    const xs = [0, app.doc.width / 2, app.doc.width], ys = [0, app.doc.height / 2, app.doc.height];
    for (const { box } of panels()) { xs.push(box.x0, box.x1, (box.x0 + box.x1) / 2); ys.push(box.y0, box.y1, (box.y0 + box.y1) / 2); }
    return { xs, ys };
  };
  const snapTol = () => 10 / Math.max(0.01, app.renderer.view.zoom); // 10 screen px in page units
  /** the closest snap line to any of `vals` within tolerance: returns the shift to apply */
  const nearest = (vals: number[], lines: number[]): { d: number; line: number } | null => {
    let best: { d: number; line: number } | null = null; const tol = snapTol();
    for (const v of vals) for (const l of lines) { const d = l - v; if (Math.abs(d) <= tol && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, line: l }; }
    return best;
  };
  /** box of the floating pixels without rotation, from its centre and scale (exact, unrounded) */
  const rawBox = (f: Floating): Box => {
    const cx = f.x + f.canvas.width / 2 + f.tx, cy = f.y + f.canvas.height / 2 + f.ty; const w = f.canvas.width * Math.abs(f.sx) / 2, hh = f.canvas.height * Math.abs(f.sy) / 2;
    return { x0: cx - w, y0: cy - hh, x1: cx + w, y1: cy + hh };
  };
  const setBox = (f: Floating, b: Box) => {
    f.sx = Math.sign(f.sx || 1) * (b.x1 - b.x0) / f.canvas.width; f.sy = Math.sign(f.sy || 1) * (b.y1 - b.y0) / f.canvas.height;
    f.tx = (b.x0 + b.x1) / 2 - (f.x + f.canvas.width / 2); f.ty = (b.y0 + b.y1) / 2 - (f.y + f.canvas.height / 2);
  };
  /** content bounds of a layer (alpha > 0), for lifting a whole layer when nothing is selected */
  const contentBounds = (layer: Layer): Box | null => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of layer.tiles.values()) {
      if (!t.ctx) continue; const d = (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, 256, 256).data;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) if (d[(y * 256 + x) * 4 + 3]! > 0) { const px = t.x * 256 + x, py = t.y * 256 + y; if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py; }
    }
    return Number.isFinite(x0) ? { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(app.doc.width - 1, x1), y1: Math.min(app.doc.height - 1, y1) } : null;
  };

  const modeOf = (e: PointerEvent | KeyboardEvent): SelMode => (e.shiftKey && e.altKey ? "intersect" : e.shiftKey ? "add" : e.altKey ? "subtract" : app.selMode);

  function setSelection(next: Selection | null, label: string) {
    const prev = app.selection;
    const n = next && next.empty ? null : next;
    app.selection = n;
    app.history.pushCustom(label, () => { app.selection = prev; app.emit("selection"); }, () => { app.selection = n; app.emit("selection"); });
    app.emit("selection");
  }

  function wand(p: { x: number; y: number }, mode: SelMode) {
    const layer = app.doc.activeLayer;
    const scale = Math.min(1, Math.sqrt(16e6 / (app.doc.width * app.doc.height)));
    const ref = app.renderer.flatten(app.doc, scale, app.wandReference === "current" ? new Set([layer.id]) : undefined);
    const rc = ref.getContext("2d")!; rc.globalCompositeOperation = "destination-over"; rc.fillStyle = "#fff"; rc.fillRect(0, 0, ref.width, ref.height);
    const sx = ref.width / app.doc.width;
    const tmp = new Layer("wand", "raster"); tmp.transient = true;
    const r = floodFill(ref, tmp, p.x * sx, p.y * sx, "#000000", {
      tolerance: app.wandTolerance, expand: 0, mode: app.wandContiguous ? "contiguous" : "global", antialias: false,
      closeGap: 0, autoClose: false, maxAutoGap: 0, stopLeaks: false, maskOnly: true,
    });
    if (!r.mask) return;
    const s = Selection.fromMask(app.doc.width, app.doc.height, r.mask, ref.width, ref.height);
    setSelection(app.selection && mode !== "replace" ? app.selection.combine(s, mode) : s, "Magic wand");
  }

  // ---- floating (move / transform) ----
  function lift(): Floating | null {
    const sel = app.selection; const layer = app.doc.activeLayer;
    if (!sel || layer.locked || layer.kind !== "raster") return null;
    const b = sel.bounds;
    app.history.begin(layer, { x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 }, "Move selection");
    const lifted = sel.lift(layer, true, (l, tx, ty) => app.history.capture(l, tx, ty));
    const f: Floating = { canvas: lifted.canvas, layer, x: lifted.x, y: lifted.y, tx: 0, ty: 0, sx: 1, sy: 1, rot: 0 };
    app.floating = f; app.floatingSel = sel; app.invalidate(); app.emit("selection");
    return f;
  }
  /** every layer inside a group (nested groups included) that holds pixels and can be moved */
  const groupMembers = (g: Layer): Layer[] => {
    const all = app.doc.drawing.layers; const ids = new Set([g.id]); let grew = true;
    while (grew) { grew = false; for (const l of all) if (l.parent !== null && ids.has(l.parent) && !ids.has(l.id)) { ids.add(l.id); grew = true; } }
    return all.filter((l) => l.id !== g.id && ids.has(l.id) && (l.kind === "raster" || l.kind === "tone") && !l.locked && l.tiles.size > 0);
  };
  /**
   * Move with a group active lifts every layer in it at once (a Redraw group is six layers; moving
   * them one by one would never line up again). All parts share one origin and one transform; the
   * step is one undo entry across all the layers.
   */
  function liftGroup(g: Layer): Floating | null {
    if (g.locked) return null;
    const members = groupMembers(g); if (!members.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const l of members) { const cb = contentBounds(l); if (!cb) continue; x0 = Math.min(x0, cb.x0); y0 = Math.min(y0, cb.y0); x1 = Math.max(x1, cb.x1); y1 = Math.max(y1, cb.y1); }
    if (!Number.isFinite(x0)) return null;
    const sel = Selection.rect(app.doc.width, app.doc.height, x0, y0, x1 + 1, y1 + 1);
    app.history.beginMulti(members, `Move group ${g.name}`);
    const lifted = members.map((l) => ({ layer: l, ...sel.lift(l, true, (ll, tx, ty) => app.history.capture(ll, tx, ty)) }));
    const first = lifted[0]!;
    const f: Floating = { canvas: first.canvas, layer: first.layer, x: first.x, y: first.y, tx: 0, ty: 0, sx: 1, sy: 1, rot: 0, parts: lifted.slice(1).map((q) => ({ layer: q.layer, canvas: q.canvas })) };
    app.selection = sel; app.floating = f; app.floatingSel = sel; app.invalidate(); app.emit("selection");
    return f;
  }
  function commitFloating() {
    const f = app.floating; if (!f) return;
    const b = stampFloating(f, (l, tx, ty) => app.history.capture(l, tx, ty));
    const prevSel = app.floatingSel; let nextSel = prevSel ? transformSelection(prevSel, f) : null;
    if (nextSel && f.clip && f.clip.length >= 3) nextSel = nextSel.combine(Selection.polygon(app.doc.width, app.doc.height, f.clip), "intersect");
    const sel = nextSel && !nextSel.empty ? nextSel : null;
    // the selection change rides on the same undo step, so undo restores pixels and mask together
    const also = { undo: () => { app.selection = prevSel; app.emit("selection"); }, redo: () => { app.selection = sel; app.emit("selection"); } };
    if (app.history.inMulti) app.history.commitMulti(also);
    else app.history.commit({ x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 }, also);
    // a moved group leaves no selection behind: the next Move takes the group again as a whole
    const groupMove = !!f.parts;
    app.floating = null; app.floatingSel = null; app.selection = groupMove ? null : sel; ctl.snap = { panel: null, xs: [], ys: [] };
    app.invalidate(); app.emit("selection"); app.emit("layers");
  }
  function cancelFloating() {
    if (!app.floating) return;
    if (app.history.inMulti) app.history.rollbackMulti(); else app.history.rollback(); // puts the lifted pixels back exactly
    app.floating = null; app.floatingSel = null; ctl.snap = { panel: null, xs: [], ys: [] }; app.invalidate(); app.emit("selection");
  }

  function handleBox() {
    const f = app.floating; if (!f) return null;
    const b = floatingBounds(f);
    const s = (x: number, y: number) => app.renderer.docToScreen(x, y);
    const pts = [s(b.x0, b.y0), s((b.x0 + b.x1) / 2, b.y0), s(b.x1, b.y0), s(b.x1, (b.y0 + b.y1) / 2), s(b.x1, b.y1), s((b.x0 + b.x1) / 2, b.y1), s(b.x0, b.y1), s(b.x0, (b.y0 + b.y1) / 2)];
    const top = pts[1]!; const rot = { x: top.x, y: top.y - 28 };
    return { pts, rot };
  }
  const HANDLES: Handle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
  function handleAt(sx: number, sy: number): Handle | null {
    const hb = handleBox(); if (!hb) return null;
    if (Math.hypot(hb.rot.x - sx, hb.rot.y - sy) < 12) return "rot";
    // edge handles need room: on a box thinner than 24 screen px they would hide the body
    const bw = hb.pts[2]!.x - hb.pts[0]!.x, bh = hb.pts[6]!.y - hb.pts[0]!.y;
    for (let i = 0; i < 8; i++) {
      const hname = HANDLES[i]!; const q = hb.pts[i]!;
      if ((hname === "n" || hname === "s") && bh < 24) continue;
      if ((hname === "e" || hname === "w") && bw < 24) continue;
      if (hname.length === 2 && (bw < 24 || bh < 24)) { if (Math.abs(q.x - sx) < 7 && Math.abs(q.y - sy) < 7) return hname; continue; }
      if (Math.abs(q.x - sx) < 11 && Math.abs(q.y - sy) < 11) return hname; // pen-friendly target
    }
    const f = app.floating!; const b = floatingBounds(f); const p = app.renderer.screenToDoc(sx, sy);
    if (p.x >= b.x0 && p.x <= b.x1 && p.y >= b.y0 && p.y <= b.y1) return "body";
    return null;
  }

  // ---- edge map for the magnetic lasso and Tighten: the visible page flattened at <= 1.5 Mpx,
  // rebuilt when the document changes (generation of any layer) or the page size changes
  let edge: { map: EdgeMap; key: string } | null = null;
  const edgeMap = (): EdgeMap => {
    const key = `${app.doc.width}x${app.doc.height}:${app.doc.drawing.layers.map((l) => `${l.id}.${l.generation}.${l.visible ? 1 : 0}`).join(",")}`;
    if (edge && edge.key === key) return edge.map;
    const scale = Math.min(1, Math.sqrt(1.5e6 / (app.doc.width * app.doc.height)));
    const map = buildEdgeMap(app.renderer.flatten(app.doc, scale), scale); edge = { map, key }; return map;
  };
  /** magnetic lasso session: pinned anchors, the fixed path up to the last anchor, the live segment */
  let mag: { anchors: Array<{ x: number; y: number }>; fixed: Array<{ x: number; y: number }>; live: Array<{ x: number; y: number }>; wire: LiveWire; lastAuto: { x: number; y: number }; mode: SelMode } | null = null;
  const magPreview = () => { if (!mag) return; ctl.preview = { shape: "poly", pts: [...mag.fixed, ...mag.live] }; app.emit("sel-preview"); };
  const magAnchor = (p: { x: number; y: number }) => {
    if (!mag) return;
    if (mag.anchors.length) { const seg = mag.wire.pathTo(p.x, p.y, mag.anchors[mag.anchors.length - 1]!.x, mag.anchors[mag.anchors.length - 1]!.y); mag.fixed.push(...seg.slice(1)); } else mag.fixed.push(p);
    mag.anchors.push(p); mag.live = []; mag.lastAuto = p; mag.wire.setSeed(p.x, p.y); magPreview();
  };
  const magFinish = (close: boolean) => {
    const m = mag; mag = null; ctl.preview = null; app.emit("sel-preview"); if (!m || !close) return;
    let pts = m.fixed;
    if (m.anchors.length >= 2) { const a = m.anchors[m.anchors.length - 1]!, b = m.anchors[0]!; pts = [...pts, ...m.wire.pathTo(b.x, b.y, a.x, a.y).slice(1)]; }
    if (pts.length < 3) return;
    const sel = Selection.polygon(app.doc.width, app.doc.height, pts);
    setSelection(app.selection && m.mode !== "replace" ? app.selection.combine(sel, m.mode) : sel, "Magnetic lasso");
  };
  const ctl: SelectController = {
    tighten(band) {
      const sel = app.selection; if (!sel || app.floating) return null;
      const b = sel.bounds; const auto = Math.max(8, Math.round(0.03 * Math.max(b.x1 - b.x0, b.y1 - b.y0)));
      const t0 = performance.now(); const r = tightenSel(sel, edgeMap(), band > 0 ? band : auto);
      setSelection(r.selection, "Tighten selection");
      return `${Math.round(r.changed * 100)}% of the band moved · ${Math.round(performance.now() - t0)} ms · band ${band > 0 ? band : auto} px`;
    },
    preview: null,
    snap: { panel: null, xs: [], ys: [] },
    fitPanel(mode) {
      const f = app.floating; if (!f) return;
      const target = panelFor(f.rot ? floatingBounds(f) : rawBox(f)); if (!target) return;
      const pb = target.box; const pw = pb.x1 - pb.x0, ph = pb.y1 - pb.y0;
      const s = mode === "fill" ? Math.max(pw / f.canvas.width, ph / f.canvas.height) : Math.min(pw / f.canvas.width, ph / f.canvas.height);
      f.rot = 0; const w = f.canvas.width * s, hh = f.canvas.height * s; const cx = (pb.x0 + pb.x1) / 2, cy = (pb.y0 + pb.y1) / 2;
      setBox(f, { x0: cx - w / 2, y0: cy - hh / 2, x1: cx + w / 2, y1: cy + hh / 2 });
      f.clip = target.p.polygon.map((q) => ({ ...q })); // anything outside the panel is cropped on Enter
      ctl.snap = { panel: pb, xs: [], ys: [] }; app.invalidate(); app.emit("selection");
    },
    resetTransform() { const f = app.floating; if (!f) return; f.tx = 0; f.ty = 0; f.sx = 1; f.sy = 1; f.rot = 0; f.clip = null; ctl.snap = { panel: null, xs: [], ys: [] }; app.invalidate(); app.emit("selection"); },
    handleAt, handleBox, commitFloating, cancelFloating,
    /** New / loaded document: nothing from the old one may survive (floating pixels, drags, preview) */
    /** tool changed: drop the selection when the artist asked for that behaviour */
    toolChanged(tool: string) { if (mag) magFinish(mag.anchors.length >= 3); if (app.clearSelectionOnTool && app.selection && !app.floating && !["select", "wand", "move"].includes(tool)) setSelection(null, "Deselect"); },
    reset() { if (app.floating) cancelFloating(); drag = null; polyPts = null; mag = null; edge = null; ctl.preview = null; app.selection = null; app.floatingSel = null; app.emit("sel-preview"); app.emit("selection"); },
    liftNow() { if (!app.floating && app.selection) lift(); },
    down(e, p) {
      const r = (e.target as HTMLElement).getBoundingClientRect(); const sx = e.clientX - r.left, sy = e.clientY - r.top;
      if (app.tool === "move") {
        if (!app.floating) {
          if (!app.selection) {
            // Move with nothing selected takes the whole layer's content, as in other paint apps,
            // so a generated or pasted picture can be resized into a panel without selecting first
            const layer = app.doc.activeLayer;
            if (layer.kind === "group") { if (!liftGroup(layer)) return true; }
            else {
              if (layer.kind !== "raster" || layer.locked) return true;
              const cb = contentBounds(layer); if (!cb) return true;
              app.selection = Selection.rect(app.doc.width, app.doc.height, cb.x0, cb.y0, cb.x1 + 1, cb.y1 + 1); app.emit("selection");
            }
          }
          if (!app.floating && !lift()) return true;
        }
        const h = handleAt(sx, sy);
        if (!h) { commitFloating(); return true; }
        const f = app.floating!; const b = floatingBounds(f); const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
        floatDrag = { handle: h, start: p, f0: { ...f }, angle0: Math.atan2(p.y - c.y, p.x - c.x), dist0: Math.hypot(p.x - c.x, p.y - c.y) };
        return true;
      }
      if (app.floating) commitFloating();
      if (app.tool === "wand") { wand(p, modeOf(e)); return true; }
      if (app.tool === "select") {
        const mode = modeOf(e);
        if (app.selShape === "poly") {
          if (!polyPts) polyPts = [p]; else polyPts.push(p);
          ctl.preview = { shape: "poly", pts: polyPts }; app.emit("sel-preview");
          return true;
        }
        if (app.selShape === "magnetic") {
          if (!mag) mag = { anchors: [], fixed: [], live: [], wire: new LiveWire(edgeMap()), lastAuto: p, mode };
          else if (mag.anchors.length >= 3) { const a = mag.anchors[0]!; if (Math.hypot(p.x - a.x, p.y - a.y) < 10 / app.renderer.view.zoom) { magFinish(true); return true; } }
          magAnchor(p); return true;
        }
        drag = { start: p, pts: [p], mode };
        ctl.preview = { shape: app.selShape, pts: [p, p] }; app.emit("sel-preview");
        return true;
      }
      return false;
    },
    move(_e, p) {
      if (floatDrag && app.floating) {
        const f = app.floating; const d = floatDrag; const f0 = d.f0; const lines = snapLines();
        ctl.snap = { panel: null, xs: [], ys: [] };
        if (d.handle === "body") {
          f.tx = f0.tx + (p.x - d.start.x); f.ty = f0.ty + (p.y - d.start.y);
          if (!_e.altKey) { // Alt = no snapping
            const b = f.rot ? floatingBounds(f) : rawBox(f);
            const sx = nearest([b.x0, (b.x0 + b.x1) / 2, b.x1], lines.xs), sy = nearest([b.y0, (b.y0 + b.y1) / 2, b.y1], lines.ys);
            if (sx) { f.tx += sx.d; ctl.snap.xs.push(sx.line); } if (sy) { f.ty += sy.d; ctl.snap.ys.push(sy.line); }
          }
        }
        else if (d.handle === "rot") { const b = floatingBounds(f0); const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }; f.rot = f0.rot + (Math.atan2(p.y - c.y, p.x - c.x) - d.angle0); if (_e.shiftKey) f.rot = Math.round(f.rot / (Math.PI / 12)) * (Math.PI / 12); }
        else if (f0.rot) {
          // rotated: scale about the centre (anchoring a rotated box is ambiguous)
          const b = floatingBounds(f0); const c = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
          const hx = d.handle.includes("e") ? 1 : d.handle.includes("w") ? -1 : 0, hy = d.handle.includes("s") ? 1 : d.handle.includes("n") ? -1 : 0;
          const w0 = (b.x1 - b.x0) / 2, h0 = (b.y1 - b.y0) / 2;
          let kx = hx ? Math.max(0.02, ((p.x - c.x) * hx) / w0) : 1, ky = hy ? Math.max(0.02, ((p.y - c.y) * hy) / h0) : 1;
          if (!_e.shiftKey && hx && hy) { const k = Math.max(kx, ky); kx = k; ky = k; }
          f.sx = f0.sx * kx; f.sy = f0.sy * ky;
        } else {
          // The opposite corner or edge stays put (Alt: scale about the centre). Corners keep the
          // picture's proportions (Shift: free). Moving edges snap to panel and page lines.
          const b0 = rawBox(f0); const hx = d.handle.includes("e") ? 1 : d.handle.includes("w") ? -1 : 0, hy = d.handle.includes("s") ? 1 : d.handle.includes("n") ? -1 : 0;
          const fromCentre = _e.altKey; const cx = (b0.x0 + b0.x1) / 2, cy = (b0.y0 + b0.y1) / 2;
          const ax = fromCentre ? cx : hx > 0 ? b0.x0 : b0.x1, ay = fromCentre ? cy : hy > 0 ? b0.y0 : b0.y1;
          let px = p.x, py = p.y;
          const sxs = hx ? nearest([px], lines.xs) : null, sys = hy ? nearest([py], lines.ys) : null;
          if (sxs) { px += sxs.d; ctl.snap.xs.push(sxs.line); } if (sys) { py += sys.d; ctl.snap.ys.push(sys.line); }
          const k = fromCentre ? 2 : 1; const W0 = b0.x1 - b0.x0, H0 = b0.y1 - b0.y0;
          let W = hx ? Math.max(4, Math.abs(px - ax) * k) : W0, H = hy ? Math.max(4, Math.abs(py - ay) * k) : H0;
          if (hx && hy && !_e.shiftKey) { const s = sxs && !sys ? W / W0 : sys && !sxs ? H / H0 : Math.max(W / W0, H / H0); W = W0 * s; H = H0 * s; }
          const nx0 = fromCentre ? cx - W / 2 : hx > 0 ? ax : hx < 0 ? ax - W : b0.x0, ny0 = fromCentre ? cy - H / 2 : hy > 0 ? ay : hy < 0 ? ay - H : b0.y0;
          const nb = { x0: hx ? nx0 : (fromCentre ? cx - W / 2 : b0.x0), y0: hy ? ny0 : (fromCentre ? cy - H / 2 : b0.y0), x1: 0, y1: 0 };
          nb.x1 = nb.x0 + W; nb.y1 = nb.y0 + H;
          setBox(f, nb);
        }
        const pb = panelFor(f.rot ? floatingBounds(f) : rawBox(f)); ctl.snap.panel = pb ? pb.box : null;
        if (f.clip && pb) f.clip = pb.p.polygon.map((q) => ({ ...q })); // a cropped picture dragged to another panel crops to that one
        app.emit("selection"); return;
      }
      if (drag) {
        if (app.selShape === "lasso") drag.pts.push(p);
        ctl.preview = { shape: app.selShape === "magnetic" ? "poly" : app.selShape, pts: app.selShape === "lasso" ? drag.pts : [drag.start, p] };
        app.emit("sel-preview");
      } else if (polyPts) { ctl.preview = { shape: "poly", pts: [...polyPts, p] }; app.emit("sel-preview"); }
      else if (mag && mag.anchors.length) {
        const a = mag.anchors[mag.anchors.length - 1]!;
        // dragging with the button down pins an anchor every ~60 screen px, as Photoshop does
        if (_e.buttons & 1) { const d = Math.hypot(p.x - mag.lastAuto.x, p.y - mag.lastAuto.y) * app.renderer.view.zoom; if (d > 60) { magAnchor(p); return; } }
        mag.live = mag.wire.pathTo(p.x, p.y, a.x, a.y).slice(1); magPreview();
      }
    },
    up(_e, p) {
      if (floatDrag) { floatDrag = null; ctl.snap = { panel: ctl.snap.panel, xs: [], ys: [] }; app.emit("selection"); return; }
      if (!drag) return;
      const d = drag; drag = null; ctl.preview = null; app.emit("sel-preview");
      const W = app.doc.width, H = app.doc.height;
      let s: Selection;
      if (app.selShape === "lasso") s = Selection.polygon(W, H, d.pts);
      else if (app.selShape === "ellipse") s = Selection.ellipse(W, H, d.start.x, d.start.y, p.x, p.y);
      else s = Selection.rect(W, H, d.start.x, d.start.y, p.x, p.y);
      const tiny = app.selShape === "lasso" ? s.empty : Math.hypot(p.x - d.start.x, p.y - d.start.y) < 2 / app.renderer.view.zoom;
      if (tiny && d.mode === "replace") { setSelection(null, "Deselect"); return; }
      setSelection(app.selection && d.mode !== "replace" ? app.selection.combine(s, d.mode) : s, "Select");
    },
    key(e) {
      const k = e.key.toLowerCase(); const ctrl = e.ctrlKey || e.metaKey;
      if (polyPts && (k === "enter" || k === "escape")) {
        const pts = polyPts; polyPts = null; ctl.preview = null; app.emit("sel-preview");
        if (k === "enter" && pts.length >= 3) { const s = Selection.polygon(app.doc.width, app.doc.height, pts); setSelection(app.selection && modeOf(e) !== "replace" ? app.selection.combine(s, modeOf(e)) : s, "Select"); }
        return true;
      }
      if (mag) {
        if (k === "enter") { magFinish(true); return true; }
        if (k === "escape") { magFinish(false); return true; }
        if (k === "backspace" || k === "delete") {
          mag.anchors.pop(); if (!mag.anchors.length) { magFinish(false); return true; }
          // rebuild the fixed path from the remaining anchors
          const anchors = mag.anchors; mag.anchors = []; mag.fixed = []; for (const a of anchors) magAnchor(a); return true;
        }
      }
      if (app.floating && k === "enter") { commitFloating(); return true; }
      if (app.floating && k === "escape") { cancelFloating(); return true; }
      if (ctrl && k === "a") { setSelection(Selection.all(app.doc.width, app.doc.height), "Select all"); return true; }
      if (ctrl && k === "d") { if (app.floating) commitFloating(); setSelection(null, "Deselect"); return true; }
      if (k === "escape" && !app.floating && app.selection) { setSelection(null, "Deselect"); return true; }
      // a selection clips every paint tool, so it must be easy to drop: Esc anywhere, not just in the selection tools
      if (!ctrl && k === "escape" && app.selection) { setSelection(null, "Deselect"); return true; }
      if (ctrl && e.shiftKey && k === "i") { if (app.selection) setSelection(app.selection.invert(), "Invert selection"); return true; }
      if (!ctrl && k === "m") { app.setTool("select"); return true; }
      if (!ctrl && k === "w") { app.setTool("wand"); return true; }
      if (!ctrl && k === "t") { app.setTool("move"); return true; }
      if ((k === "delete" || k === "backspace") && app.floating) {
        // the pixels are already lifted off their layers: dropping them is the deletion
        const prevSel = app.floatingSel;
        const also = { undo: () => { app.selection = prevSel; app.emit("selection"); }, redo: () => { app.selection = null; app.emit("selection"); } };
        if (app.history.inMulti) app.history.commitMulti(also); else app.history.commit({ x0: 0, y0: 0, x1: 0, y1: 0 }, also);
        app.floating = null; app.floatingSel = null; app.selection = null; ctl.snap = { panel: null, xs: [], ys: [] };
        app.invalidate(); app.emit("selection"); app.emit("layers"); return true;
      }
      if ((k === "delete" || k === "backspace") && app.selection && !app.selectedNode) {
        const layer = app.doc.activeLayer;
        // a group: clear the selection on every layer inside it, as one undo step
        const targets = layer.kind === "group" ? groupMembers(layer) : layer.kind === "raster" && !layer.locked ? [layer] : [];
        if (!targets.length) return true;
        const b = app.selection.bounds; const rect = { x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 };
        if (targets.length === 1) { app.history.begin(targets[0]!, rect, "Clear selection"); app.selection.lift(targets[0]!, true, (l, tx, ty) => app.history.capture(l, tx, ty)); app.history.commit(rect); }
        else { app.history.beginMulti(targets, `Clear selection in ${layer.name}`); for (const l of targets) app.selection.lift(l, true, (ll, tx, ty) => app.history.capture(ll, tx, ty)); app.history.commitMulti(); }
        app.invalidate(rect); app.emit("layers"); return true;
      }
      if (ctrl && (k === "c" || k === "x") && app.selection) {
        const layer = app.doc.activeLayer; if (layer.kind !== "raster") return true;
        if (k === "x" && layer.locked) return true;
        const b = app.selection.bounds; const rect = { x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 };
        if (k === "x") app.history.begin(layer, rect, "Cut");
        const lifted = app.selection.lift(layer, k === "x", (l, tx, ty) => app.history.capture(l, tx, ty));
        if (k === "x") { app.history.commit(rect); app.invalidate(rect); }
        app.clipboard = { canvas: lifted.canvas, x: lifted.x, y: lifted.y, mask: app.selection.clone() };
        app.emit("layers"); return true;
      }
      if (ctrl && k === "v" && app.clipboard) {
        const cb = app.clipboard; const frame = app.doc.drawing;
        const layer = new Layer(`Pasted ${frame.layers.length + 1}`, "raster");
        const idx = frame.layers.indexOf(app.doc.activeLayer);
        frame.layers.splice(idx + 1, 0, layer);
        for (const t of layer.tilesIn(cb.x, cb.y, cb.x + cb.canvas.width, cb.y + cb.canvas.height, true)) { if (!t.ctx) continue; (t.ctx as CanvasRenderingContext2D).drawImage(cb.canvas, cb.x - t.x * 256, cb.y - t.y * 256); t.generation++; }
        app.doc.activeLayerId = layer.id;
        app.history.pushCustom("Paste", () => { const i = frame.layers.indexOf(layer); if (i >= 0) frame.layers.splice(i, 1); app.emit("layers"); app.invalidate(); }, () => { frame.layers.splice(idx + 1, 0, layer); app.emit("layers"); app.invalidate(); });
        app.selection = cb.mask.clone(); app.emit("selection"); app.emit("layers"); app.invalidate();
        app.setTool("move"); return true;
      }
      return false;
    },
  };
  return ctl;
}
