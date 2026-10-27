/** Side panels: Layers, Brush, Color, Tone, Page (panels), 3D Cel. */

import type { BlendMode, Layer, LayerKind } from "../engine/document.js";
import { pageToPanel } from "../engine/panels.js";
import { moireRisk, tonePattern } from "../engine/screentone.js";
import { clear, field, h, slider } from "./dom.js";
import type { AppState } from "./state.js";

const BLENDS: BlendMode[] = ["normal", "multiply", "screen", "overlay", "darken", "lighten", "add"];

/**
 * Layers tab. Each row shows the layer as it sits on the page (a page-shaped thumbnail), what is on
 * it (coverage, dominant colours, strokes made this session, paths, tone settings or child count),
 * and its state (visible, locked, clipped, blend, opacity). Rows drag to reorder or into a group;
 * hovering the thumbnail shows a large preview of that layer alone. One strip under the list edits
 * the active layer. Thumbnails are cached by layer generation.
 */
const thumbCache = new Map<number, { gen: number; w: number; h: number; canvas: HTMLCanvasElement; colors: string[]; coverage: number }>();
function layerThumb(app: AppState, l: Layer, w: number, h: number): { canvas: HTMLCanvasElement; colors: string[]; coverage: number } {
  const hit = thumbCache.get(l.id); if (hit && hit.gen === l.generation && hit.w === w && hit.h === h) return hit;
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!;
  const sx = w / app.doc.width, sy = h / app.doc.height;
  if (l.kind === "group") { for (const child of app.doc.drawing.layers) if (child.parent === l.id && child.visible) { const t = layerThumb(app, child, w, h); g.drawImage(t.canvas, 0, 0); } }
  else if (l.kind === "vector") { g.lineCap = "round"; for (const p of l.paths) { if (!p.points.length) continue; g.strokeStyle = p.color; g.lineWidth = Math.max(1, p.width * sx); g.beginPath(); p.points.forEach((q, i) => (i ? g.lineTo(q.x * sx, q.y * sy) : g.moveTo(q.x * sx, q.y * sy))); g.stroke(); } }
  else { for (const t of l.tiles.values()) if (t.canvas) g.drawImage(t.canvas as CanvasImageSource, t.x * 256 * sx, t.y * 256 * sy, 256 * sx, 256 * sy); if (l.kind === "tone") { g.globalCompositeOperation = "source-in"; g.fillStyle = `rgba(20,20,20,${0.35 + l.tone.density * 0.6})`; g.fillRect(0, 0, w, h); } }
  // dominant colours and coverage from the thumbnail itself
  const d = g.getImageData(0, 0, w, h).data; const counts = new Map<number, number>(); let on = 0;
  for (let i = 0; i < d.length; i += 4) { if (d[i + 3]! < 40) continue; on++; const k = ((d[i]! >> 5) << 6) | ((d[i + 1]! >> 5) << 3) | (d[i + 2]! >> 5); counts.set(k, (counts.get(k) ?? 0) + 1); }
  const colors = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => `rgb(${((k >> 6) & 7) * 36},${((k >> 3) & 7) * 36},${(k & 7) * 36})`);
  const out = { gen: l.generation, w, h, canvas: c, colors, coverage: on / (w * h) }; thumbCache.set(l.id, out); return out;
}

export function layersPanel(app: AppState): HTMLElement {
  const root = h("div", { class: "layers-tab" });
  let menuOpen = false;
  const act = (fn: () => void) => { fn(); app.invalidate(); app.emit("layers"); };
  const render = () => {
    clear(root);
    const d = app.doc.drawing; const l = app.doc.activeLayer;
    const addKind = (k: LayerKind) => act(() => { const nl = app.doc.addLayer(k); app.collab?.shareLayerAdd(nl); if (k !== "group") { const i = d.layers.indexOf(nl); d.layers.splice(i, 1); const li = d.layers.indexOf(l); d.layers.splice(li + 1, 0, nl); nl.parent = l.kind === "group" ? l.id : l.parent; } });
    const header = h("div", { class: "layers-head" },
      h("div", { class: "title" }, h("h3", {}, "Layers"), h("span", { class: "dim", style: { fontSize: "11px" } }, `${d.layers.length} on ${app.doc.mode === "anime" ? `frame ${app.doc.currentFrame + 1}` : "this page"}`)),
      h("div", { class: "add-wrap" },
        h("button", { class: "primary", title: "Add raster layer", "data-help": "Add a pixel layer above the active one (most drawing goes on raster layers). The arrow opens other kinds.", onClick: () => addKind("raster") }, "+ Layer"),
        h("button", { title: "More layer kinds", "data-help": "Vector, tone, 3D cel-shade or group.", onClick: () => { menuOpen = !menuOpen; render(); } }, "▾"),
        menuOpen ? h("div", { class: "add-menu" },
          h("button", { title: "Add vector layer", onClick: () => { menuOpen = false; addKind("vector"); } }, "Vector"),
          h("button", { title: "Add tone layer", onClick: () => { menuOpen = false; addKind("tone"); } }, "Tone"),
          h("button", { title: "Add npr layer", onClick: () => { menuOpen = false; addKind("npr"); } }, "3D cel"),
          h("button", { title: "Add group", onClick: () => { menuOpen = false; addKind("group"); } }, "Group")) : null),
      h("button", { title: "Duplicate layer", onClick: () => act(() => duplicateLayer(app, l)) }, "⧉"),
      h("button", { title: "Merge down", disabled: l.kind !== "raster" || !mergeTarget(app, l), onClick: () => act(() => mergeDown(app, l)) }, "⤓"),
      h("button", { title: "Delete layer", disabled: d.layers.length <= 1, onClick: () => act(() => app.doc.removeLayer(app.doc.activeLayerId)) }, "🗑"));
    root.append(header);
    const list = h("div", { class: "layer-list" });
    const depth = (x: Layer): number => { let n = 0, p = x.parent, guard = 0; while (p !== null && guard++ < 16) { const g = d.layers.find((y) => y.id === p); if (!g) break; n++; p = g.parent; } return n; };
    const hidden = (x: Layer): boolean => { let p = x.parent, guard = 0; while (p !== null && guard++ < 16) { const g = d.layers.find((y) => y.id === p); if (!g) break; if (g.collapsed) return true; p = g.parent; } return false; };
    [...d.layers].reverse().forEach((x) => { if (!hidden(x)) list.append(layerRow(app, x, depth(x), act)); });
    root.append(list);
    // ---- active layer strip
    const strip = h("div", { class: "layer-strip" },
      h("div", { class: "row", style: { gap: "6px", alignItems: "center" } },
        h("b", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "120px" }, title: "Double-click to rename" }, l.name),
        h("span", { class: "grow" }),
        l.kind !== "group" ? h("button", { class: l.clipBelow ? "active" : "", title: "Clipping mask: show only where the layer below has pixels", "data-action": "layer.clip", onClick: () => act(() => { l.clipBelow = !l.clipBelow; }) }, l.clipBelow ? "Clipped ↓" : "Clip ↓") : null,
        h("button", { class: l.locked ? "active" : "", title: "Lock this layer", onClick: () => act(() => { l.locked = !l.locked; }) }, l.locked ? "🔒" : "🔓"),
        h("button", { title: "Put the active layer in a new group", onClick: () => act(() => { const g = app.doc.addLayer("group"); const i = d.layers.indexOf(g); d.layers.splice(i, 1); const li = d.layers.indexOf(l); d.layers.splice(li + 1, 0, g); g.parent = l.parent; l.parent = g.id; app.doc.activeLayerId = g.id; }) }, "Group"),
        l.parent !== null ? h("button", { title: "Ungroup", onClick: () => act(() => { const g = d.layers.find((x) => x.id === l.parent); l.parent = g ? g.parent : null; }) }, "Ungroup") : null,
        h("button", { title: "Move up", onClick: () => act(() => { const i = d.layers.indexOf(l); if (i < d.layers.length - 1) { d.layers.splice(i, 1); d.layers.splice(i + 1, 0, l); } }) }, "↑"),
        h("button", { title: "Move down", onClick: () => act(() => { const i = d.layers.indexOf(l); if (i > 0) { d.layers.splice(i, 1); d.layers.splice(i - 1, 0, l); } }) }, "↓")),
      field("Blend", h("select", { onChange: (e: Event) => { l.blend = (e.target as HTMLSelectElement).value as BlendMode; app.invalidate(); app.emit("layers-refresh"); } }, ...BLENDS.map((b) => h("option", { value: b, selected: b === l.blend }, b)))),
      field("Opacity", slider(0, 1, 0.01, l.opacity, (v) => { l.opacity = v; app.invalidate(); }), () => `${Math.round(l.opacity * 100)}%`),
      app.doc.panels.length ? field("Panel mask", h("select", { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; l.panelMask = v === "" ? null : Number(v); app.invalidate(); } },
        h("option", { value: "", selected: l.panelMask === null }, "none"),
        ...app.doc.panels.map((p, i) => h("option", { value: p.id, selected: l.panelMask === p.id }, `panel ${i + 1}`)))) : null,
      l.kind === "vector" ? h("div", { class: "row", style: { marginTop: "6px", gap: "6px", alignItems: "center" } },
        h("button", { onClick: () => rasterize(app, l) }, "Rasterize"),
        h("span", { class: "dim", style: { fontSize: "11px" } }, `${l.paths.length} paths · V draws, A edits`)) : null,
      l.kind === "tone" ? h("span", { class: "dim", style: { fontSize: "11px" } }, "Paint on this layer to lay tone; pattern in the Tone tab.") : null);
    root.append(strip);
  };
  let lazy = 0; const lazyRender = () => { if (lazy) return; lazy = window.setTimeout(() => { lazy = 0; if (root.isConnected && root.offsetParent !== null) render(); else stale = true; }, 120); };
  let stale = false; const renderNow = () => { stale = false; render(); };
  app.on("layers", renderNow); app.on("timeline", renderNow); app.on("panels", renderNow); app.on("vector", lazyRender); app.on("layers-refresh", renderNow); app.on("stroke-end", lazyRender); app.on("frame", renderNow);
  app.on("dock", () => { if (stale && root.offsetParent !== null) renderNow(); });
  render();
  return root;
}

function mergeTarget(app: AppState, l: Layer): Layer | null {
  const d = app.doc.drawing; const i = d.layers.indexOf(l);
  for (let j = i - 1; j >= 0; j--) { const b = d.layers[j]!; if (b.parent === l.parent) return b.kind === "raster" ? b : null; }
  return null;
}
function mergeDown(app: AppState, l: Layer): void {
  const b = mergeTarget(app, l); if (!b) return;
  const bounds = l.bounds(); if (bounds) {
    app.history.begin(b, bounds, "Merge down"); app.history.captureRect(b, bounds);
    for (const t of l.tiles.values()) { if (!t.canvas) continue; const bt = b.getTile(t.x, t.y, true)!; if (!bt.ctx) continue; const c = bt.ctx as CanvasRenderingContext2D; c.save(); c.globalAlpha = l.opacity; c.globalCompositeOperation = l.blend === "normal" ? "source-over" : l.blend === "add" ? "lighter" : l.blend; c.drawImage(t.canvas as CanvasImageSource, 0, 0); c.restore(); bt.generation++; }
    b.generation++; app.history.commit(bounds);
  }
  app.doc.removeLayer(l.id); app.doc.activeLayerId = b.id;
}
function duplicateLayer(app: AppState, l: Layer): void {
  const d = app.doc.drawing; const n = app.doc.addLayer(l.kind); n.name = `${l.name} copy`; n.blend = l.blend; n.opacity = l.opacity; n.clipBelow = l.clipBelow; n.parent = l.parent; n.tone = { ...l.tone }; n.paths = l.paths.map((p) => ({ ...p, points: p.points.map((q) => ({ ...q })) }));
  for (const t of l.tiles.values()) { if (!t.canvas) continue; const nt = n.getTile(t.x, t.y, true)!; if (nt.ctx) { (nt.ctx as CanvasRenderingContext2D).drawImage(t.canvas as CanvasImageSource, 0, 0); nt.generation++; } }
  const i = d.layers.indexOf(n); d.layers.splice(i, 1); d.layers.splice(d.layers.indexOf(l) + 1, 0, n); n.generation++;
}

let preview: HTMLElement | null = null;
function layerRow(app: AppState, l: Layer, depth: number, act: (fn: () => void) => void): HTMLElement {
  const d = app.doc.drawing;
  const tw = 56, th = Math.max(20, Math.min(72, Math.round((56 * app.doc.height) / app.doc.width)));
  const t = layerThumb(app, l, tw, th);
  const thumb = h("div", { class: "thumb-wrap" }, t.canvas);
  thumb.addEventListener("mouseenter", () => {
    if (!preview) { preview = h("div", { id: "layer-preview" }); document.body.append(preview); }
    const big = layerThumb(app, l, 320, Math.round((320 * app.doc.height) / app.doc.width));
    clear(preview).append(big.canvas, h("div", { class: "cap" }, `${l.name} · ${Math.round(t.coverage * 100)}% of the page`));
    const r = thumb.getBoundingClientRect(); preview.style.display = "block"; preview.style.top = `${Math.max(8, Math.min(window.innerHeight - 380, r.top - 40))}px`; preview.style.left = `${r.left - 340}px`;
  });
  thumb.addEventListener("mouseleave", () => { if (preview) preview.style.display = "none"; });
  // what is on it
  let what: string;
  if (l.kind === "group") what = `${d.layers.filter((x) => x.parent === l.id).length} layers inside`;
  else if (l.kind === "vector") what = l.paths.length ? `${l.paths.length} vector path${l.paths.length === 1 ? "" : "s"}` : "empty vector layer";
  else if (l.kind === "tone") what = `tone ${l.tone.lpi} lpi · ${Math.round(l.tone.density * 100)}%${t.coverage ? ` · ${Math.round(t.coverage * 100)}% of page` : " · nothing laid yet"}`;
  else if (l.kind === "npr") what = "3D cel shade (3D tab)";
  else what = t.coverage > 0 ? `${t.coverage < 0.01 ? "<1" : Math.round(t.coverage * 100)}% of page painted` : "empty";
  const hist = app.history.summaryFor(l.id).slice(0, 3).map(([k, n]) => (n > 1 ? `${n}× ${k}` : k)).join(", ");
  const state = [l.kind === "group" ? "group" : l.kind, l.blend !== "normal" ? l.blend : null, l.opacity < 1 ? `${Math.round(l.opacity * 100)}%` : null, l.clipBelow ? "clipped" : null, l.panelMask !== null ? "panel" : null].filter(Boolean).join(" · ");
  const name = h("div", { class: "name", title: "Double-click to rename" }, l.name);
  name.addEventListener("dblclick", (e) => { e.stopPropagation(); const n = prompt("Layer name", l.name); if (n) { l.name = n; app.emit("layers"); } });
  const row = h("div", { class: `layer ${l.id === app.doc.activeLayerId ? "active" : ""} ${l.visible ? "" : "hidden-layer"}`, draggable: "true", style: { marginLeft: `${depth * 12}px` }, onClick: () => { app.doc.activeLayerId = l.id; app.emit("layers"); } },
    h("div", { class: `eye ${l.visible ? "" : "off"}`, title: "Show or hide this layer", onClick: (e: Event) => { e.stopPropagation(); act(() => { l.visible = !l.visible; }); } }, l.visible ? "👁" : "–"),
    l.kind === "group" ? h("div", { class: "thumb-wrap group", title: l.collapsed ? "Expand the group" : "Collapse the group", onClick: (e: Event) => { e.stopPropagation(); l.collapsed = !l.collapsed; app.emit("layers"); } }, h("span", {}, l.collapsed ? "▸ 📁" : "▾ 📂")) : thumb,
    h("div", { class: "info" },
      name,
      h("div", { class: "what" }, ...(t.colors.length && l.kind !== "group" ? [h("span", { class: "swatches" }, ...t.colors.map((c) => h("i", { style: { background: c }, title: c })))] : []), h("span", {}, what)),
      hist ? h("div", { class: "hist", title: "Done on this layer in this session" }, hist) : null,
      h("div", { class: "state" }, state)),
    h("div", { class: "flags" }, l.locked ? h("span", { title: "Lock this layer" }, "🔒") : null, l.clipBelow ? h("span", { title: "Clipping mask: show only where the layer below has pixels" }, "↓") : null));
  // drag to reorder / into a group
  row.addEventListener("dragstart", (e) => { e.dataTransfer?.setData("text/omni-layer", String(l.id)); row.classList.add("dragging"); });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  row.addEventListener("dragover", (e) => { e.preventDefault(); const r = row.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height; row.classList.toggle("drop-above", y < 0.33); row.classList.toggle("drop-into", l.kind === "group" && y >= 0.33 && y <= 0.67); row.classList.toggle("drop-below", y > 0.67 || (l.kind !== "group" && y >= 0.33)); });
  row.addEventListener("dragleave", () => row.classList.remove("drop-above", "drop-below", "drop-into"));
  row.addEventListener("drop", (e) => {
    e.preventDefault(); const id = Number(e.dataTransfer?.getData("text/omni-layer")); row.classList.remove("drop-above", "drop-below", "drop-into");
    const src = d.layers.find((x) => x.id === id); if (!src || src === l) return;
    if (src.kind === "group") { let p: number | null = l.parent; let guard = 0; while (p !== null && guard++ < 16) { if (p === src.id) return; p = d.layers.find((x) => x.id === p)?.parent ?? null; } } // no dropping a group into itself
    const r = row.getBoundingClientRect(); const y = (e.clientY - r.top) / r.height;
    act(() => {
      d.layers.splice(d.layers.indexOf(src), 1);
      if (l.kind === "group" && y >= 0.33 && y <= 0.67) { src.parent = l.id; d.layers.splice(d.layers.indexOf(l), 0, src); }
      else { src.parent = l.parent; const i = d.layers.indexOf(l); d.layers.splice(y < 0.33 || (l.kind !== "group" && y < 0.5) ? i + 1 : i, 0, src); }
      app.doc.activeLayerId = src.id;
    });
  });
  return row;
}

async function rasterize(app: AppState, l: Layer): Promise<void> {
  const { outline } = await import("../engine/vector.js");
  const target = app.doc.addLayer("raster"); target.name = `${l.name} (raster)`;
  for (const path of l.paths) {
    const poly = outline(path); if (poly.length < 3) continue;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const q of poly) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    for (const t of target.tilesIn(x0, y0, x1, y1, true)) { if (!t.ctx) continue; const c = t.ctx as CanvasRenderingContext2D; c.save(); c.translate(-t.x * 256, -t.y * 256); c.beginPath(); poly.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.closePath(); c.fillStyle = path.color; c.fill(); c.restore(); t.generation++; }
  }
  app.invalidate(); app.emit("layers");
}

export function tonePanel(app: AppState): HTMLElement {
  const root = h("div");
  const LPI = [27.5, 32.5, 42.5, 50, 60, 65, 70, 85];
  const render = () => {
    clear(root);
    const l = app.doc.activeLayer;
    const isTone = l.kind === "tone";
    root.append(h("h3", {}, "Screentone"), h("p", { class: "dim", style: { fontSize: "12px", margin: "6px 0" } }, isTone ? `Painting on "${l.name}" masks the tone. Pattern regenerates per zoom; dots never resample.` : "Select or add a tone layer (+T) to paint tones."));
    const grid = h("div", { class: "tone-grid" });
    const matrix: Array<[number, number]> = [];
    for (const lpi of [32.5, 42.5, 60]) for (const den of [0.1, 0.2, 0.35, 0.5]) matrix.push([lpi, den]);
    for (const [lpi, den] of matrix) {
      const c = h("canvas", { width: 48, height: 48, class: isTone && l.tone.lpi === lpi && l.tone.density === den ? "active" : "", title: `${lpi} lpi · ${den * 100}%` }) as HTMLCanvasElement;
      const pat = tonePattern({ lpi, density: den, angle: 45, shape: "dot", gradient: null }, 300, 0.55);
      const cx = c.getContext("2d")!; cx.fillStyle = "#fff"; cx.fillRect(0, 0, 48, 48); const p = cx.createPattern(pat.canvas as CanvasImageSource, "repeat"); if (p) { cx.fillStyle = p; cx.fillRect(0, 0, 48, 48); }
      c.addEventListener("click", () => { if (!isTone) return; l.tone.lpi = lpi; l.tone.density = den; app.invalidate(); render(); });
      grid.append(c);
    }
    root.append(grid);
    if (isTone) {
      const pitch = (app.doc.dpi / l.tone.lpi) * app.renderer.view.zoom;
      const extra = h("div"); clear(extra).append(h("div", { class: "sep" }),
        field("LPI", h("select", { onChange: (e: Event) => { l.tone.lpi = Number((e.target as HTMLSelectElement).value); app.invalidate(); render(); } }, ...LPI.map((v) => h("option", { value: v, selected: v === l.tone.lpi }, String(v))))),
        field("Density", slider(0.02, 0.95, 0.01, l.tone.density, (v) => { l.tone.density = v; app.invalidate(); }), () => `${Math.round(l.tone.density * 100)}%`),
        field("Angle", slider(0, 90, 15, l.tone.angle, (v) => { l.tone.angle = v; app.invalidate(); }), () => `${l.tone.angle}°`),
        field("Shape", h("select", { onChange: (e: Event) => { l.tone.shape = (e.target as HTMLSelectElement).value as typeof l.tone.shape; app.invalidate(); } }, ...(["dot", "line", "cross", "noise", "sand"] as const).map((s) => h("option", { value: s, selected: s === l.tone.shape }, s)))),
        h("div", { class: "kv" }, h("span", {}, "screen pitch"), h("b", {}, `${pitch.toFixed(2)} px`), h("span", {}, "moiré risk"), h("b", {}, `${Math.round(moireRisk(pitch) * 100)}% (compensated)`)),
        h("div", { class: "sep" }), h("h3", {}, "Gradient tone"),
        field("Gradient", h("input", { type: "checkbox", checked: !!l.tone.gradient, onChange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; const b = l.bounds(); l.tone.gradient = on ? { x0: b ? b.x0 : 0, y0: b ? b.y0 : 0, x1: b ? b.x0 : 0, y1: b ? b.y1 : app.doc.height, density2: 0.02 } : null; app.invalidate(); render(); } })),
        l.tone.gradient ? field("End density", slider(0, 0.95, 0.01, l.tone.gradient.density2, (v) => { l.tone.gradient!.density2 = v; app.invalidate(); }), () => `${Math.round(l.tone.gradient!.density2 * 100)}%`) : null,
        l.tone.gradient ? h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          h("button", { title: "top to bottom over the painted area", onClick: () => { const b = l.bounds(); if (b) { l.tone.gradient = { ...l.tone.gradient!, x0: b.x0, y0: b.y0, x1: b.x0, y1: b.y1 }; app.invalidate(); } } }, "↓"),
          h("button", { title: "bottom to top", onClick: () => { const b = l.bounds(); if (b) { l.tone.gradient = { ...l.tone.gradient!, x0: b.x0, y0: b.y1, x1: b.x0, y1: b.y0 }; app.invalidate(); } } }, "↑"),
          h("button", { title: "left to right", onClick: () => { const b = l.bounds(); if (b) { l.tone.gradient = { ...l.tone.gradient!, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y0 }; app.invalidate(); } } }, "→"),
          h("button", { title: "right to left", onClick: () => { const b = l.bounds(); if (b) { l.tone.gradient = { ...l.tone.gradient!, x0: b.x1, y0: b.y0, x1: b.x0, y1: b.y0 }; app.invalidate(); } } }, "←"),
          h("span", { class: "dim", style: { fontSize: "11px" } }, "density runs across the painted area")) : null,
        h("div", { class: "sep" }), h("h3", {}, "Paste tone"),
        h("div", { class: "row", style: { gap: "6px" } },
          h("button", { disabled: !app.selection, title: "Fill the current selection on this tone layer (Ctrl+click: new tone layer)", onClick: (e: Event) => void pasteTone(app, (e as MouseEvent).ctrlKey) }, "Fill selection with tone"),
          h("span", { class: "dim", style: { fontSize: "11px" } }, app.selection ? "selection ready" : "make a selection first (M / W)")));
      root.append(extra);
    } else if (app.selection) {
      root.append(h("div", { class: "sep" }), h("button", { onClick: () => void pasteTone(app, true) }, "New tone layer from selection"));
    }
  };
  app.on("layers", render); app.on("view", render); app.on("selection", render);
  render();
  return root;
}

/** Fill the selection mask onto a tone layer (the painted alpha is the tone mask). */
async function pasteTone(app: AppState, newLayer: boolean): Promise<void> {
  const sel = app.selection; if (!sel) return;
  let layer = app.doc.activeLayer;
  if (newLayer || layer.kind !== "tone") { layer = app.doc.addLayer("tone"); layer.name = `Tone ${app.doc.drawing.layers.length}`; }
  const b = sel.bounds; const rect = { x0: b.x0, y0: b.y0, x1: b.x1 + 1, y1: b.y1 + 1 };
  app.history.begin(layer, rect, "Paste tone"); app.history.captureRect(layer, rect);
  for (const t of layer.tilesIn(rect.x0, rect.y0, rect.x1, rect.y1, true)) { if (!t.ctx) continue; const c = t.ctx as CanvasRenderingContext2D; c.save(); c.fillStyle = "#000"; c.globalCompositeOperation = "source-over"; c.drawImage(sel.canvas, -t.x * 256, -t.y * 256); c.restore(); t.generation++; }
  layer.generation++;
  app.history.commit(rect); app.invalidate(rect); app.emit("layers");
}

export function pagePanel(app: AppState): HTMLElement {
  const root = h("div");
  const render = () => {
    clear(root);
    const d = app.doc;
    root.append(h("h3", {}, "Page & Panels"),
      field("Width", h("input", { type: "number", value: d.width, onChange: (e: Event) => { d.width = Number((e.target as HTMLInputElement).value); app.invalidate(); } })),
      field("Height", h("input", { type: "number", value: d.height, onChange: (e: Event) => { d.height = Number((e.target as HTMLInputElement).value); app.invalidate(); } })),
      field("DPI", h("input", { type: "number", value: d.dpi, onChange: (e: Event) => { d.dpi = Number((e.target as HTMLInputElement).value); app.invalidate(); } })),
      h("div", { class: "sep" }),
      h("div", { class: "row" },
        h("button", { onClick: () => { d.panels = [pageToPanel(d.width, d.height, Math.round(d.dpi * 0.5), Math.round(d.dpi * 0.12))]; app.invalidate(); app.emit("panels"); } }, "New frame"),
        h("button", { class: app.tool === "panel-cut" ? "active" : "", title: "Panel cut tool", "data-action": "tool.panel-cut", onClick: () => app.setTool("panel-cut") }, "Cut tool"),
        h("button", { onClick: () => { d.panels = []; for (const f of d.frames) for (const l of f.layers) l.panelMask = null; app.invalidate(); app.emit("panels"); } }, "Clear")),
      h("p", { class: "dim", style: { fontSize: "12px" } }, "Drag the cut tool across a panel to split it. The gutter is applied symmetrically and layers masked by the parent follow the first half; reassign in Layers → Panel mask."),
      h("div", { class: "kv" }, ...d.panels.flatMap((p, i) => [h("span", {}, `panel ${i + 1}`), h("b", {}, `${p.polygon.length} pts · ${Math.round(polyArea(p.polygon) / (d.dpi * d.dpi))} in²`)])),
      h("div", { class: "sep" }), h("h3", {}, "Export / import"),
      h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        h("button", { title: "Photoshop file with every layer, groups, clipping masks and blend modes", onClick: () => void exportFile(app, "psd") }, "PSD"),
        h("button", { title: "One-page PDF at the page's print size (JPEG 92%)", onClick: () => void exportFile(app, "pdf") }, "PDF"),
        h("button", { title: "PNG with the dpi embedded (pHYs)", onClick: () => void exportFile(app, "png") }, "PNG + dpi"),
        h("label", { class: "btn", style: { cursor: "pointer" } }, "Import PSD", h("input", { type: "file", accept: ".psd", style: { display: "none" }, onChange: (e: Event) => void importFile(app, (e.target as HTMLInputElement).files?.[0] ?? null) }))),
      h("div", { class: "notice mono", id: "export-msg", style: { fontSize: "11px", minHeight: "14px", marginTop: "4px" } }, app.exportMessage),
      h("div", { class: "sep" }),
      field("Show panels", h("input", { type: "checkbox", checked: app.showPanels, onChange: (e: Event) => { app.showPanels = (e.target as HTMLInputElement).checked; app.invalidate(); } })),
      field("Grid ½ in", h("input", { type: "checkbox", checked: app.showGrid, onChange: (e: Event) => { app.showGrid = (e.target as HTMLInputElement).checked; app.invalidate(); } })),
    );
  };
  app.on("panels", render); app.on("tool", render);
  render();
  return root;
}
async function exportFile(app: AppState, kind: "psd" | "pdf" | "png"): Promise<void> {
  const { exportPsd, exportPdf, exportPngWithDpi, exportComposite } = await import("../engine/export.js");
  const t0 = performance.now(); const doc = app.doc;
  const composite = await exportComposite(doc, (d, s) => app.renderer.flatten(d, s));
  let bytes: Uint8Array; let name: string; let mime: string;
  if (kind === "psd") { bytes = exportPsd(doc, composite, (l) => app.renderer.flatten(doc, 1, new Set([l.id]))); name = `${doc.name}.psd`; mime = "image/vnd.adobe.photoshop"; }
  else if (kind === "pdf") { bytes = await exportPdf(doc, composite); name = `${doc.name}.pdf`; mime = "application/pdf"; }
  else { bytes = await exportPngWithDpi(composite, doc.dpi); name = `${doc.name}.png`; mime = "image/png"; }
  app.lastExport = { name, bytes };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })); a.download = name; a.click();
  app.exportMessage = `${name}: ${(bytes.byteLength / 1048576).toFixed(2)} MB in ${Math.round(performance.now() - t0)} ms`;
  const el = document.getElementById("export-msg"); if (el) el.textContent = app.exportMessage;
}
async function importFile(app: AppState, file: File | null): Promise<void> {
  if (!file) return;
  const { importPsd, docFromPsd } = await import("../engine/export.js");
  try {
    const psd = importPsd(new Uint8Array(await file.arrayBuffer()));
    app.doc = docFromPsd(psd); app.cache.index(app.doc); app.renderer.fitPage(app.doc);
    app.exportMessage = `imported ${file.name}: ${psd.width} x ${psd.height} @ ${psd.dpi} dpi, ${psd.layers.length} records`;
    app.invalidate(); app.emit("layers"); app.emit("timeline"); app.emit("panels");
  } catch (e) { app.exportMessage = `import failed: ${e instanceof Error ? e.message : String(e)}`; app.emit("panels"); }
}
function polyArea(poly: Array<{ x: number; y: number }>): number { let s = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i]!, q = poly[(i + 1) % poly.length]!; s += p.x * q.y - q.x * p.y; } return Math.abs(s) / 2; }

export function nprPanel(app: AppState, onChange: () => void, loadObj: (text: string) => void): HTMLElement {
  const root = h("div");
  const render = () => {
    clear(root);
    const p = app.npr;
    const l = app.doc.activeLayer;
    const has3d = app.doc.drawing.layers.some((x) => x.kind === "npr");
    root.append(h("h3", {}, "3D Cel Shading"), h("p", { class: "dim", style: { fontSize: "12px" } }, has3d ? `Renders into every 3D layer of this drawing${l.kind === "npr" ? ` (active: ${l.name})` : ""}.` : "Add a 3D layer (+3D in Layers) to render a cel-shaded mesh."),
      h("div", { class: "row", style: { margin: "6px 0" } }, ...(["sphere", "torus", "box"] as const).map((m) => h("button", { class: app.nprMesh === m ? "active" : "", onClick: () => { app.nprMesh = m; onChange(); render(); } }, m)),
        h("button", { onClick: () => { const i = h("input", { type: "file", accept: ".obj" }) as HTMLInputElement; i.onchange = async () => { const f = i.files?.[0]; if (f) { loadObj(await f.text()); app.nprMesh = "obj"; render(); } }; i.click(); } }, "OBJ…")),
      field("Yaw", slider(-3.14, 3.14, 0.01, p.yaw, (v) => { p.yaw = v; onChange(); })),
      field("Pitch", slider(-1.5, 1.5, 0.01, p.pitch, (v) => { p.pitch = v; onChange(); })),
      field("Zoom", slider(0.4, 3, 0.01, p.zoom, (v) => { p.zoom = v; onChange(); })),
      field("Light yaw", slider(-3.14, 3.14, 0.01, p.lightYaw, (v) => { p.lightYaw = v; onChange(); })),
      field("Light pitch", slider(-1.5, 1.5, 0.01, p.lightPitch, (v) => { p.lightPitch = v; onChange(); })),
      field("Shadow cut", slider(-0.5, 0.9, 0.01, p.tShadow, (v) => { p.tShadow = v; onChange(); }), () => p.tShadow.toFixed(2)),
      field("Bands", h("select", { onChange: (e: Event) => { p.bands = Number((e.target as HTMLSelectElement).value) as 2 | 3; onChange(); } }, h("option", { value: 2, selected: p.bands === 2 }, "2-tone"), h("option", { value: 3, selected: p.bands === 3 }, "3-tone"))),
      field("Rim", slider(0, 1, 0.01, p.rim, (v) => { p.rim = v; onChange(); })),
      field("Line px", slider(0, 6, 0.1, p.lineWidthPx, (v) => { p.lineWidthPx = v; onChange(); }), () => p.lineWidthPx.toFixed(1)),
      field("Depth edge", slider(0.01, 0.5, 0.01, p.depthEdge, (v) => { p.depthEdge = v; onChange(); })),
      field("Normal edge", slider(0.05, 1.5, 0.01, p.normalEdge, (v) => { p.normalEdge = v; onChange(); })),
      field("Base", h("input", { type: "color", value: rgb2hex(p.baseColor), onInput: (e: Event) => { p.baseColor = hex2rgb((e.target as HTMLInputElement).value); onChange(); } })),
      field("Shadow", h("input", { type: "color", value: rgb2hex(p.shadowColor), onInput: (e: Event) => { p.shadowColor = hex2rgb((e.target as HTMLInputElement).value); onChange(); } })),
      field("Project 2D", h("select", { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; app.nprDecalLayer = v === "" ? null : Number(v); onChange(); } },
        h("option", { value: "", selected: app.nprDecalLayer === null }, "none"),
        ...app.doc.drawing.layers.filter((x) => x.kind === "raster" || x.kind === "vector").map((x) => h("option", { value: x.id, selected: app.nprDecalLayer === x.id }, x.name)))),
    );
  };
  app.on("layers", render);
  render();
  return root;
}
const rgb2hex = (c: [number, number, number]) => "#" + c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
const hex2rgb = (hx: string): [number, number, number] => { const n = parseInt(hx.slice(1), 16); return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]; };
