/** Application state and a tiny event bus. Panels subscribe and re-render. */

import { Doc } from "../engine/document.js";
import { History } from "../engine/history.js";
import { PRESETS, type BrushPreset } from "../engine/brush.js";
import type { StrokeEngine } from "../engine/brush.js";
import { DEFAULT_NPR, type NprParams } from "../engine/npr.js";
import type { Renderer } from "../engine/renderer.js";
import { TileCache } from "../engine/tile-cache.js";
import type { Selection, Floating, SelMode } from "../engine/selection.js";
import { Keymap } from "./keymap.js";

export type Tool = "brush" | "eraser" | "vector" | "node" | "fill" | "select" | "wand" | "move" | "text" | "fx" | "ruler" | "gradient" | "pan" | "zoom" | "rotate" | "panel-cut" | "eyedrop";

export class AppState {
  doc = new Doc();
  history = new History();
  tool: Tool = "brush";
  preset: BrushPreset = { ...PRESETS[0]! };
  /** remembered preset per tool so B/E switch back to what the user had */
  lastPaint: BrushPreset = { ...PRESETS[0]! };
  lastEraser: BrushPreset = { ...PRESETS.find((p) => p.kind === "eraser")! };
  activeStroke: StrokeEngine | null = null;
  /** symmetry copies of the active stroke (live preview) */
  extraStrokes: StrokeEngine[] = [];
  spaceHeld = false;
  // ---- selection ----
  selection: Selection | null = null;
  floating: Floating | null = null;
  floatingSel: Selection | null = null;
  selMode: SelMode = "replace";
  selShape: "rect" | "ellipse" | "lasso" | "poly" | "magnetic" = "rect";
  /** Tighten: how far (page px) from the rough outline the edge may be found; 0 = auto (3% of the selection size) */
  tightenBand = 0;
  /** last Tighten result, shown in the selection options */
  tightenNote = "";
  /** the selection controller (set by main), for panels that trigger selection actions */
  select: { tighten(band: number): string | null } | null = null;
  /** drop the selection when switching to a tool that does not use it (off by default, as in other art apps) */
  clearSelectionOnTool = localStorage.getItem("omni.clearSelOnTool") === "1";
  wandTolerance = 0.12;
  wandContiguous = true;
  wandReference: "all" | "current" = "all";
  keymap = new Keymap();
  wasmBrush: import("../engine/wasm-brush.js").WasmBrush | null = null;
  useWasmBrush = false; // measured slower than the GPU-backed Canvas 2D tip path (see Settings bench); opt-in
  wasmBenchMsg = "";
  exportMessage = "";
  audio: import("../engine/anim-export.js").AudioTrack | null = null;
  animMessage = "";
  lastExport: { name: string; bytes: Uint8Array } | null = null;
  pageGuides: { bleed: number; safe: number } | null = null;
  showGuides = true;
  setMode(m: "manga" | "anime"): void { this.doc.mode = m; document.body.classList.toggle("mode-anime", m === "anime"); document.body.classList.toggle("mode-manga", m === "manga"); this.emit("mode"); this.emit("view"); }
  // ---- rulers (snap brush strokes) ----
  ruler: { kind: "none" | "line" | "perspective" | "curve" | "ellipse"; a: { x: number; y: number }; b: { x: number; y: number }; vps: Array<{ x: number; y: number }>; snapThreshold: number; curve: Array<{ x: number; y: number }>; ellipse: { cx: number; cy: number; rx: number; ry: number; rot: number } } = { kind: "none", a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, vps: [], snapThreshold: 8, curve: [], ellipse: { cx: 0, cy: 0, rx: 1, ry: 1, rot: 0 } };
  /** ruler placement sub-mode for the ruler tool */
  gradientShape: "linear" | "radial" = "linear";
  gradientEnd: "transparent" | "color2" = "transparent";
  color2 = "#ffffff";
  rulerPlace: "auto" | "curve" | "ellipse" = "auto";
  // ---- symmetry: every stroke is repeated through the mirror axis / radial copies ----
  symmetry: { kind: "none" | "mirror" | "radial"; cx: number; cy: number; angle: number; count: number; mirrorRadial: boolean } = { kind: "none", cx: 1240, cy: 1754, angle: 90, count: 6, mirrorRadial: false };
  // ---- text / balloons ----
  selectedBalloon: number | null = null;
  balloonKind: import("../engine/manga.js").BalloonKind = "speech";
  // ---- manga effects ----
  selectedFx: number | null = null;
  fxKind: import("../engine/manga-fx.js").FxKind = "speed";
  clipboard: { canvas: HTMLCanvasElement; x: number; y: number; mask: Selection } | null = null;
  fillTolerance = 0.12;
  fillMode: "contiguous" | "global" = "contiguous";
  fillReference: "all" | "current" = "all";
  fillAntialias = true;
  fillCloseGap = 3;
  fillAutoClose = true;
  fillMaxAutoGap = 48;
  fillStopLeaks = true;
  fillMessage = "";
  /** G: click fills; drag draws an enclosure that is filled on release */
  fillLasso = true;
  /** "fixed": constant 0.55; "speed": slow = firm, fast = light (industry fallback for mice) */
  mousePressure: "fixed" | "speed" = "speed";
  vectorSimplify = 2.5; // RDP epsilon in screen px
  selectedNode: { pathId: number; index: number } | null = null;
  fillExpand = 2;
  color = "#141414";
  recent: string[] = ["#141414", "#ffffff", "#8d8d8d", "#c0392b", "#2e86c1", "#f1c40f", "#27ae60", "#8e44ad"];
  proofCmyk = false;
  gamut: "srgb" | "p3" | "rec2020" | "acescg" = "srgb";
  showPanels = true;
  showGrid = false;
  compact = false;
  dockPanel = "Layers";
  story: import("./story.js").Story | null = null;
  /** depth map of the 3D layer's last render (ML Studio depth control) */
  nprDepth: (() => HTMLCanvasElement | null) | null = null;
  collab: import("./collab.js").Collab | null = null;
  playing = false;
  npr: NprParams = { ...DEFAULT_NPR };
  nprMesh: "sphere" | "torus" | "box" | "obj" = "sphere";
  nprDecalLayer: number | null = null;
  renderer!: Renderer;
  cache = new TileCache();
  statusInput = { source: "pointer", rateHz: 0, pressure: 0 };
  bridge = { state: "idle", room: "", rttMs: 0, p99Ms: 0, safety: "", role: "host" as "host" | "client" };
  vault = { unlocked: false, enrolled: false, message: "" };
  autosave: import("./autosave.js").AutosaveState = { enabled: true, intervalSec: 120, plainWhenLocked: true, dirty: false, lastAt: 0, lastKind: "", pending: null, message: "" };

  private listeners = new Map<string, Set<(payload?: unknown) => void>>();
  on(evt: string, fn: (payload?: unknown) => void): () => void {
    let s = this.listeners.get(evt);
    if (!s) { s = new Set(); this.listeners.set(evt, s); }
    s.add(fn);
    return () => s!.delete(fn);
  }
  emit(evt: string, payload?: unknown): void {
    this.listeners.get(evt)?.forEach((fn) => fn(payload));
    this.listeners.get("*")?.forEach((fn) => fn(evt));
  }

  setTool(t: Tool): void {
    if (this.tool === "eraser" && t !== "eraser") this.lastEraser = this.preset;
    if (this.tool === "brush" && t !== "brush") this.lastPaint = this.preset;
    this.tool = t;
    if (t === "eraser" && this.preset.kind !== "eraser") this.preset = { ...this.lastEraser };
    else if (t === "brush" && this.preset.kind === "eraser") this.preset = { ...this.lastPaint };
    this.emit("tool");
    this.emit("brush");
  }
  setPreset(p: BrushPreset): void {
    this.preset = { ...p, curve: [...p.curve] as BrushPreset["curve"] };
    this.tool = p.kind === "eraser" ? "eraser" : "brush";
    this.emit("tool");
    this.emit("brush");
  }
  setColor(hex: string): void {
    this.color = hex;
    if (!this.recent.includes(hex)) { this.recent.unshift(hex); this.recent.length = Math.min(16, this.recent.length); }
    this.emit("color");
  }
  invalidate(rect?: { x0: number; y0: number; x1: number; y1: number }): void {
    this.renderer.invalidate(rect);
  }
  /** Damage from the live stroke itself: repainted, but the renderer's under/over-stroke caches stay valid. */
  invalidateStroke(rect: { x0: number; y0: number; x1: number; y1: number }): void {
    this.renderer.invalidate(rect, true);
  }
  /**
   * Pen-up: repaint the stroke's box, but the flattened projection only needs the tiles the stroke
   * actually touched, and every per-batch invalidateStroke() already marked those.
   */
  invalidateStrokeEnd(rect: { x0: number; y0: number; x1: number; y1: number }): void {
    this.renderer.invalidate(rect, true, false);
    this.renderer.strokeEndFrame = true;
  }
}
