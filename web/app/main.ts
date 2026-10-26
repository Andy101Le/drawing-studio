/**
 * OMNI-CELL web studio entry point. Assembles the Obsidian shell, viewport,
 * panels, timeline, radial menu, Bridge, and Vault; runs the render loop.
 */

import "./design/obsidian.css";
import { generatePanel } from "./ui/generate-panel.js";
import { redrawPanel } from "./ui/redraw-panel.js";
import { datasetPanel } from "./ui/dataset-panel.js";
import { storyPanel } from "./ui/story-panel.js";
import { tickMedia, resetMedia } from "./engine/media.js";
import { perfStats } from "./ui/perf-stats.js";
import { Renderer, type RenderOptions } from "./engine/renderer.js";
import { NprRenderer, box, parseObj, sphere, torus, type Mesh } from "./engine/npr.js";
import { pageToPanel } from "./engine/panels.js";
import { Doc, tileHooks } from "./engine/document.js";
import { TileCacheClient } from "@omni/crypto/opfs.js";
import { AppState, type Tool } from "./ui/state.js";
import { bindViewport } from "./ui/viewport.js";
import { HidBridge } from "./ui/hid.js";
import { layersPanel, nprPanel, pagePanel, tonePanel } from "./ui/panels.js";
import { colorWheel } from "./ui/color-wheel.js";
import { brushPanel } from "./ui/brush-panel.js";
import { timelinePanel } from "./ui/timeline.js";
import { TOOL_LABELS, bindRadialTriggers, radialMenu } from "./ui/radial.js";
import { BridgeController, bridgePanel } from "./ui/bridge-panel.js";
import { VaultController, unlockModal, vaultPanel } from "./ui/vault-panel.js";
import { h } from "./ui/dom.js";
import { installCursor } from "./ui/cursor.js";
import { installSelectionOverlay } from "./ui/selection-overlay.js";
import { installAutosave } from "./ui/autosave.js";
import { ICONS, icon } from "./ui/icons.js";
import { mangaPanel } from "./ui/manga-panel.js";
import { settingsPanel, applyWorkspace, loadWorkspace } from "./ui/settings-panel.js";
import { installTooltips } from "./ui/tooltip.js";
import { buildRibbon, buildQuickbar, buildDock, surfaceSection } from "./ui/shell.js";
import { Collab, collabPanel, installCollabPopups } from "./ui/collab.js";
import { applyTheme, currentTheme } from "./ui/theme.js";
(window as unknown as { omniIcons: typeof ICONS }).omniIcons = ICONS;

const app = new AppState();
(window as unknown as { omni: AppState }).omni = app; // debugging handle
import("./engine/brush.js").then((m) => { (window as unknown as { omniBrush: typeof m }).omniBrush = m; });
import("./engine/media.js").then((m) => { (window as unknown as { omniMedia: typeof m }).omniMedia = m; });
import("./engine/serialize.js").then((m) => { (window as unknown as { omniSerialize: typeof m }).omniSerialize = m; });
const root = document.getElementById("app") as HTMLElement;

// ---- ribbon (built after the dock exists, see below) ----
let menubar: HTMLElement;
// ---- tool column ----
const tools = h("div", { id: "tools" });
const TOOL_ICONS: Record<Tool, string> = { brush: "✎", eraser: "◌", vector: "⌇", node: "⊹", fill: "▣", select: "⬚", wand: "⚲", move: "⤧", text: "T", fx: "⟫", ruler: "R", gradient: "◐", pan: "✥", zoom: "⌕", rotate: "↻", "panel-cut": "⟋", eyedrop: "✦" };
const toolButtons = new Map<Tool, HTMLButtonElement>();
// grouped by purpose: draw, select, vector, guides, view
const TOOL_GROUPS: Tool[][] = [["brush", "eraser", "fill", "gradient", "text", "fx"], ["select", "wand", "move"], ["vector", "node"], ["ruler", "panel-cut"], ["eyedrop", "pan", "zoom", "rotate"]];
TOOL_GROUPS.forEach((group, gi) => {
  if (gi) tools.append(h("div", { class: "group-sep" }));
  for (const t of group) {
    const fixedKeys: Partial<Record<Tool, string>> = { select: "M", wand: "W", move: "T" };
    const b = h("button", { title: TOOL_LABELS[t].replace(/\s*\([^)]*\)$/, ""), ...(fixedKeys[t] ? { "data-keys": fixedKeys[t] } : (t !== "zoom" ? { "data-action": `tool.${t}` } : {})), onClick: () => app.setTool(t) }, ICONS[t] ? icon(t) : TOOL_ICONS[t]) as HTMLButtonElement;
    toolButtons.set(t, b); tools.append(b);
  }
});
app.on("tool", () => toolButtons.forEach((b, t) => b.classList.toggle("active", app.tool === t)));

// ---- viewport ----
const viewport = h("div", { id: "viewport" });
const gpuCanvas = h("canvas", { style: { display: "none", pointerEvents: "none" } }) as HTMLCanvasElement;
const uiCanvas = h("canvas", { style: { display: "none", pointerEvents: "none" } }) as HTMLCanvasElement;
const canvas = h("canvas", { id: "draw" }) as HTMLCanvasElement;
const cutOverlay = h("canvas", { id: "cut-overlay", style: { pointerEvents: "none" } }) as HTMLCanvasElement;
const selOverlay = h("canvas", { id: "sel-overlay", style: { pointerEvents: "none", position: "absolute", inset: "0" } }) as HTMLCanvasElement;
viewport.append(gpuCanvas, uiCanvas, canvas, cutOverlay, selOverlay);
const statusbar = h("div", { id: "statusbar" });
viewport.append(statusbar);

// ---- side panels ----
let openPanel: (name: string) => void = () => undefined;
const bridge = new BridgeController(app);
(app as unknown as { bridgeStats: () => unknown }).bridgeStats = () => bridge.stats;
const collab = new Collab(app); app.collab = collab;
const vault = new VaultController(app);
const autosave = installAutosave(app, vault); vault.onSaved = () => autosave.markSaved();
(window as unknown as { omniAutosave: typeof autosave }).omniAutosave = autosave;

let npr: NprRenderer | null = null;
let nprDirty = true;
const nprCanvases = new Map<number, CanvasImageSource>();
const meshFor = (): Mesh => (app.nprMesh === "torus" ? torus() : app.nprMesh === "box" ? box() : app.nprMesh === "obj" && objMesh ? objMesh : sphere());
let objMesh: Mesh | null = null;
const markNpr = () => { nprDirty = true; };

const panelDefs: Array<[string, () => HTMLElement]> = [
  ["Layers", () => layersPanel(app)],
  ["Brush", () => brushPanel(app)],
  ["Color", () => colorWheel(app)],
  ["Tone", () => tonePanel(app)],
  ["Manga", () => mangaPanel(app)],
  ["Page", () => h("div", {}, pagePanel(app), surfaceSection(app, viewport))],
  ["3D", () => nprPanel(app, markNpr, (text) => { objMesh = parseObj(text); markNpr(); })],
  ["Live", () => collabPanel(app, collab)],
  ["Bridge", () => bridgePanel(app, bridge)],
  ["Vault", () => vaultPanel(app, vault, autosave)],
  ["Generate", () => generatePanel(app)],
  ["Redraw", () => redrawPanel(app)],
  ["Story", () => storyPanel(app)],
  ["Dataset", () => datasetPanel(app)],
  ["Settings", () => settingsPanel(app)],
];
const dock = buildDock(app, panelDefs); const side = dock.side; openPanel = dock.open;
app.on("open-panel", (n) => openPanel(String(n)));
// ---- timeline ----
const timeline = h("div", { id: "timeline" });

menubar = buildRibbon(app, {
  newPage: () => {
    if (!confirm("New document? Unsaved work is lost.")) return;
    // everything that belonged to the old document goes: floating pixels and selection, undo history,
    // wet/acrylic simulation state, the story strip, balloons and selection overlays
    app.emit("doc-reset");
    const old = app.doc; for (const l of old.drawing.layers) resetMedia(l);
    app.history.clear(); app.story = null; app.selectedBalloon = null; app.selectedFx = null; app.selectedNode = null;
    const w = old.width, hgt = old.height, dpi = old.dpi; // keep the page size and mode the artist was using
    app.doc = new Doc(); app.doc.width = w; app.doc.height = hgt; app.doc.dpi = dpi; app.doc.mode = old.mode; app.doc.surface = { ...old.surface };
    app.doc.panels = [pageToPanel(app.doc.width, app.doc.height, Math.round(dpi * 0.5), Math.round(dpi * 0.12))];
    app.cache.index(app.doc); app.renderer.fitPage(app.doc); app.invalidate();
    app.emit("layers"); app.emit("timeline"); app.emit("panels"); app.emit("balloons"); app.emit("selection"); app.emit("doc-loaded"); app.emit("story"); app.emit("vector");
  },
  exportPng: () => exportPng(),
  connectTablet: () => void hid.connect(),
  toggleCompositor: () => { if (app.renderer.mode === "webgpu") app.renderer.useCanvas2d("user toggle"); else if (!app.renderer.useWebGpu()) alert(`WebGPU unavailable: ${app.renderer.gpuDisabledReason}`); app.renderer.resize(); app.invalidate(); app.emit("compositor"); },
  toggleCompact: () => { app.compact = !app.compact; root.classList.toggle("compact", app.compact); app.emit("layout"); app.renderer.resize(); app.invalidate(); },
  openPanel: (n) => openPanel(n),
  save: () => void vault.save(),
});
viewport.prepend(buildQuickbar(app, (n) => openPanel(n)));
root.append(menubar, tools, viewport, side, timeline);

// ---- engine wiring ----
app.renderer = new Renderer(canvas);
try { app.renderer.strokeCache = localStorage.getItem("omni.strokeCache") !== "0"; app.renderer.projection = localStorage.getItem("omni.flatten") !== "0"; } catch { /* storage blocked */ }
void app.renderer.initGpu(gpuCanvas, uiCanvas).then(async (ok) => {
  app.renderer.resize(); app.invalidate();
  if (ok) { const pass = await app.renderer.selfTest(app.doc); if (!pass) { app.renderer.resize(); app.invalidate(); console.warn("[omni] GPU compositor disabled:", app.renderer.gpuDisabledReason); } }
  app.emit("compositor", ok);
});
app.on("panels", () => app.renderer.gpu?.invalidateMasks());
app.doc.panels = [pageToPanel(app.doc.width, app.doc.height, 150, 36)];
const driver = bindViewport(canvas, app);
const hid = new HidBridge(app, driver);
(window as unknown as { omniHid: HidBridge }).omniHid = hid;
void hid.reopen();
app.on("hid", () => { app.statusInput.source = "webhid"; const el = document.getElementById("hid-status"); if (el) el.textContent = hid.status; });
const menu = radialMenu(viewport, app);
bindRadialTriggers(canvas, menu, app);
timelinePanel(app, timeline);
app.history.onChange = () => app.emit("history");

// ---- tile cache tiers ----
const frameOf = (layerId: number) => app.doc.frames.find((f) => f.layers.some((l) => l.id === layerId))?.id ?? -1;
tileHooks.created = (tile, layer) => app.cache.touch(tile, layer.id, frameOf(layer.id));
try {
  const worker = new Worker(new URL("../src/crypto/opfs-worker.ts", import.meta.url), { type: "module" });
  void app.cache.attachOpfs(new TileCacheClient(worker));
} catch { /* no OPFS: WARM tier only */ }
app.cache.onChange = () => app.invalidate();
{ const q = new URLSearchParams(location.search); const mb = Number(q.get("cacheMB")); if (mb > 0) { app.cache.budgetBytes = mb * 1048576; app.cache["warmBudget"] = mb * 1048576 * 0.5; } }
let maintainTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleMaintain = () => { if (maintainTimer) clearTimeout(maintainTimer); maintainTimer = setTimeout(() => void app.cache.maintain(() => app.doc.drawing), 400); };
app.on("stroke-end", () => { const l = app.doc.activeLayer; app.cache.touchLayer(l.tiles.values(), l.id, app.doc.drawing.id); scheduleMaintain(); });
app.on("frame", () => { void app.cache.warm(app.doc.drawing).then(() => app.invalidate()); scheduleMaintain(); });
app.on("timeline", () => { void app.cache.warm(app.doc.drawing).then(() => app.invalidate()); scheduleMaintain(); });
app.emit("tool");

// Bridge client forwarding
app.on("stroke-begin", () => bridge.sendBegin());
app.on("stroke-sample", (s) => { const q = s as { x: number; y: number; pressure: number; tiltX: number; tiltY: number; tip: boolean }; bridge.sendSample(q.x, q.y, q.pressure, q.tiltX, q.tiltY, q.tip); });
app.on("stroke-end", () => bridge.sendEnd());

app.on("mode", () => { document.getElementById("mode-manga")?.classList.toggle("active", app.doc.mode === "manga"); document.getElementById("mode-anime")?.classList.toggle("active", app.doc.mode === "anime"); window.dispatchEvent(new Event("resize")); });
app.setMode(app.doc.mode);
applyTheme(currentTheme());
applyWorkspace(loadWorkspace());
installTooltips(app);
installCollabPopups(app, collab);
import("./engine/wasm-brush.js").then(async ({ WasmBrush }) => { app.wasmBrush = await WasmBrush.load(); app.emit("wasm"); });
// cursors: brush footprint ring, tool glyphs with hotspots, hand while panning (ui/cursor.ts)
installCursor(app, viewport, canvas, driver.select);
app.select = driver.select;

// selection overlay: marching ants from the mask, floating pixels, transform handles (ui/selection-overlay.ts)
installSelectionOverlay(app, canvas, selOverlay, driver.select);

// vector preview + node handles on the overlay
import("./engine/vector.js").then(({ drawPathTo }) => {
  const paint = () => {
    const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    cutOverlay.width = r.width * dpr; cutOverlay.height = r.height * dpr;
    const c = cutOverlay.getContext("2d")!; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height);
    c.setTransform(app.renderer.matrix());
    if (livePts) drawPathTo(c, { id: 0, points: livePts, width: app.preset.size, color: app.color, closed: false });
    if (app.tool === "node" && app.doc.activeLayer.kind === "vector") {
      const z = app.renderer.view.zoom * dpr;
      for (const path of app.doc.activeLayer.paths) {
        c.strokeStyle = "rgba(184,184,184,0.8)"; c.lineWidth = 1 / z; c.beginPath(); path.points.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.stroke();
        path.points.forEach((q, i) => { const sel = app.selectedNode && app.selectedNode.pathId === path.id && app.selectedNode.index === i; c.fillStyle = sel ? "#ffffff" : "#161616"; c.strokeStyle = "#e6e6e6"; c.beginPath(); c.rect(q.x - 3.5 / z, q.y - 3.5 / z, 7 / z, 7 / z); c.fill(); c.stroke(); });
      }
    }
  };
  let livePts: import("./engine/vector.js").VPt[] | null = null;
  app.on("vector-preview", (p) => { livePts = p as typeof livePts; paint(); });
  app.on("vector", paint); app.on("tool", paint); app.on("view", paint); app.on("layers", paint);
  app.on("cut-preview", (p) => { if (!p) paint(); });
});

// enclose-and-fill lasso preview
app.on("lasso-preview", (p) => {
  const pts = p as Array<{ x: number; y: number }> | null;
  const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  cutOverlay.width = r.width * dpr; cutOverlay.height = r.height * dpr;
  const c = cutOverlay.getContext("2d")!; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height);
  if (!pts || pts.length < 2) return;
  c.setTransform(app.renderer.matrix());
  c.beginPath(); pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y))); c.closePath();
  c.fillStyle = app.color + "55"; c.fill(); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.setLineDash([5, 4]); c.strokeStyle = "#e6e6e6"; c.lineWidth = 1;
  c.setTransform(app.renderer.matrix()); c.lineWidth = 1 / (app.renderer.view.zoom * dpr); c.stroke();
});

// cut-tool preview overlay
app.on("cut-preview", (p) => {
  const seg = p as { from: { x: number; y: number }; to: { x: number; y: number } } | null;
  const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  cutOverlay.width = r.width * dpr; cutOverlay.height = r.height * dpr;
  const c = cutOverlay.getContext("2d")!; c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, r.width, r.height);
  if (!seg || !seg.from) return;
  const a = app.renderer.docToScreen(seg.from.x, seg.from.y), b = app.renderer.docToScreen(seg.to.x, seg.to.y);
  c.strokeStyle = "#b8b8b8"; c.setLineDash([6, 4]); c.lineWidth = 1; c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
});

window.addEventListener("pointerup", () => { if (app.tool === "panel-cut") app.emit("cut-preview", null); });
app.on("tool", () => app.emit("cut-preview", null));

// auto layout: stylus/touch → compact radial layout when the viewport is narrow
const mq = window.matchMedia("(pointer: coarse)");
const applyLayout = () => { const compact = mq.matches && window.innerWidth < 1100; if (compact !== app.compact) { app.compact = compact; root.classList.toggle("compact", compact); app.renderer.resize(); app.invalidate(); } };
mq.addEventListener("change", applyLayout); window.addEventListener("resize", () => { app.renderer.resize(); app.invalidate(); applyLayout(); });
applyLayout();

function renderNpr(): void {
  const layers = app.doc.drawing.layers.filter((l) => l.kind === "npr" && l.visible);
  if (layers.length === 0) return;
  try {
    const w = 1024, hgt = Math.round((1024 * app.doc.height) / app.doc.width);
    if (!npr) npr = new NprRenderer(w, hgt, meshFor()); else { npr.resize(w, hgt); if (npr.mesh.name !== meshFor().name) npr.setMesh(meshFor()); }
    if (app.nprDecalLayer !== null) npr.setDecal(app.renderer.flatten(app.doc, 0.25, new Set([app.nprDecalLayer]))); else npr.setDecal(null);
    npr.render(app.npr);
    const copy = document.createElement("canvas"); copy.width = w; copy.height = hgt;
    copy.getContext("2d")!.drawImage(npr.canvas as CanvasImageSource, 0, 0);
    for (const l of layers) nprCanvases.set(l.id, copy);
    app.nprDepth = () => (npr ? npr.depthMap() : null);
    app.invalidate();
  } catch (e) {
    statusbar.textContent = `3D: ${e instanceof Error ? e.message : String(e)}`;
  }
}
app.on("layers", () => { if (app.doc.drawing.layers.some((l) => l.kind === "npr" && !nprCanvases.has(l.id))) markNpr(); });
app.on("stroke-end", () => { if (app.nprDecalLayer !== null) markNpr(); });

function exportPng(): void {
  const flat = app.renderer.flatten(app.doc, 1);
  const ctx = flat.getContext("2d")!;
  ctx.globalCompositeOperation = "destination-over"; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, flat.width, flat.height);
  const a = document.createElement("a"); a.href = flat.toDataURL("image/png"); a.download = `${app.doc.name}.png`; a.click();
}

// ---- render loop ----
let frames = 0, fpsT = performance.now(), fps = 0;
let lastInput = 0;
addEventListener("pointermove", () => { lastInput = performance.now(); }, { passive: true, capture: true });
function renderOpts(): RenderOptions {
  return { activeStroke: app.activeStroke ? { layerId: app.activeStroke.layer.id, buffer: app.activeStroke.buffer!, opacity: app.activeStroke.preset.opacity, kind: app.activeStroke.preset.kind, blend: app.activeStroke.preset.blend } : null, extraStrokes: app.extraStrokes.map((x) => ({ layerId: x.layer.id, buffer: x.buffer!, opacity: x.preset.opacity, kind: x.preset.kind, blend: x.preset.blend })), proofCmyk: app.proofCmyk, showPanels: app.showPanels, showGrid: app.showGrid, selectedBalloon: app.selectedBalloon, selectedFx: app.selectedFx, guides: app.showGuides ? app.pageGuides : null, nprCanvases, toneInk: "#141414" };
}
function loop(): void {
  if (nprDirty) { nprDirty = false; renderNpr(); }
  { const r = tickMedia(performance.now()); if (r) app.invalidate(r); }
  const tFrame = performance.now(); let renderMs: number | null = null;
  if (app.renderer.needsRender) {
    app.renderer.render(app.doc, renderOpts()); renderMs = performance.now() - tFrame;
  } else if (!app.activeStroke && performance.now() - lastInput > 120) {
    // idle: pre-composite the layers around the active one so the next stroke starts cheap
    app.renderer.warmStrokeCache(app.doc, renderOpts(), 4);
  } else if (!app.activeStroke) {
    app.renderer.warmStrokeCache(app.doc, renderOpts(), 1.5); // hovering: smaller slices
  }
  perfStats.tick(tFrame, renderMs);
  frames++;
  const now = performance.now();
  if (now - fpsT >= 500) {
    fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now;
    const v = app.renderer.view;
    statusbar.replaceChildren(
      h("span", {}, `${TOOL_LABELS[app.tool]}`), h("span", {}, `${Math.round(app.preset.size)} px`), h("span", {}, app.color),
      h("span", {}, `zoom ${(v.zoom * 100).toFixed(0)}%  rot ${((v.rotation * 180) / Math.PI).toFixed(0)}°`),
      h("span", {}, `${app.doc.width}×${app.doc.height} @ ${app.doc.dpi} dpi`),
      h("span", {}, `input ${app.statusInput.source} ${app.statusInput.rateHz} Hz p=${app.statusInput.pressure.toFixed(2)}`),
      h("span", {}, `frame ${app.doc.currentFrame + 1}/${app.doc.exposure.length}`),
      h("span", {}, `bridge ${app.bridge.state}${app.bridge.rttMs ? ` ${app.bridge.rttMs.toFixed(1)} ms` : ""}`),
      h("span", {}, `${app.vault.unlocked ? "🔓" : "🔒"} vault`),
      ...(app.selection ? [h("span", { class: "chip", style: { cursor: "pointer" }, title: "Deselect", "data-help": "A selection is active, so painting is limited to it. Click here, press Esc, or Ctrl+D to drop it.", onClick: () => { app.selection = null; app.emit("selection"); } }, "selection active · Esc")] : []),
      h("span", { title: "tile cache: hot (RAM canvases) / warm (PNG in RAM) / cold (OPFS)" }, (() => { const c = app.cache.stats(); return `tiles ${c.tiles} · ${c.hotMB.toFixed(0)}/${c.warmMB.toFixed(0)}/${c.coldMB.toFixed(0)} MB`; })()),
      h("span", { class: "grow" }), h("span", {}, `${fps} fps`), h("span", {}, app.renderer.mode === "webgpu" ? `WebGPU ${app.renderer.gpu?.info ?? ""} · ${app.renderer.gpu?.stats().tileMB.toFixed(0) ?? 0} MB tiles` : "Canvas 2D"), h("span", {}, typeof SharedArrayBuffer !== "undefined" ? "SAB on" : "SAB off"));
  }
  requestAnimationFrame(loop);
}
app.renderer.resize();
app.renderer.fitPage(app.doc);
requestAnimationFrame(loop);

// straight to the canvas: unlock box appears only if this browser is already enrolled
const unsubVault = app.on("vault", () => { if (app.vault.enrolled && !app.vault.unlocked && !document.querySelector(".modal-backdrop")) unlockModal(app, vault); unsubVault(); });
