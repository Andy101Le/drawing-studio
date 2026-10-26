/**
 * Settings: shortcut editor (click a binding, press the new keys; conflicts are flagged),
 * workspace layouts (panel/toolbar widths, timeline height, persisted), and reset.
 */
import { perfStats } from "./perf-stats.js";
import type { AppState } from "./state.js";
import { h, clear, field } from "./dom.js";
import { ACTION_LABELS, Keymap, type Action } from "./keymap.js";

export interface Workspace { name: string; panelW: number; toolbarW: number; timelineH: number }
export const WORKSPACES: Workspace[] = [
  { name: "Studio (default)", panelW: 272, toolbarW: 44, timelineH: 232 },
  { name: "Inking (wide canvas)", panelW: 220, toolbarW: 40, timelineH: 160 },
  { name: "Animation (tall Xsheet)", panelW: 272, toolbarW: 44, timelineH: 320 },
  { name: "Review (minimal)", panelW: 200, toolbarW: 36, timelineH: 120 },
];
export function applyWorkspace(w: Workspace): void {
  const r = document.documentElement.style;
  r.setProperty("--panel-w", `${w.panelW}px`); r.setProperty("--toolbar-w", `${w.toolbarW}px`); r.setProperty("--timeline-h", `${w.timelineH}px`);
  try { localStorage.setItem("omni.workspace", JSON.stringify(w)); } catch { /* private mode */ }
  window.dispatchEvent(new Event("resize"));
}
export function loadWorkspace(): Workspace { try { const raw = localStorage.getItem("omni.workspace"); if (raw) return JSON.parse(raw) as Workspace; } catch { /* none */ } return WORKSPACES[0]!; }

function perfSection(app: AppState): HTMLElement {
  const out = h("pre", { class: "dim", style: { fontSize: "11px", margin: "4px 0", whiteSpace: "pre-wrap" } });
  const text = () => {
    const s = perfStats.summary(); const r = app.renderer as AppState["renderer"] | undefined; const d = app.doc;
    if (!r) return "starting…"; // the panel is built before the renderer exists
    const tiles = d.drawing.layers.reduce((n, l) => n + l.tiles.size, 0);
    return [
      `compositor   ${r.mode === "webgpu" ? "WebGPU (render = CPU submit time)" : "Canvas 2D"}`,
      `repaint      p50 ${s.renderP50} ms · p95 ${s.renderP95} ms (${s.renders} repaints)`,
      `frames       p95 interval ${s.frameP95} ms · ${s.slowFrames} of ${s.frames} slower than 30 fps`,
      `document     ${d.drawing.layers.length} layers · ${tiles} tiles · undo ${app.history.memoryMB} MB`,
      `caches       stroke ${r.strokeCache ? (r.sc ? "warm" : "on") : "off"} · flattened ${r.projection ? (r.proj ? `${r.proj.upto} layers` : "on (not in use)") : "off"}`,
      `pen input    ${app.statusInput.rateHz || 0} samples/s`,
    ].join("\n");
  };
  out.textContent = text();
  const timer = window.setInterval(() => { if (!out.isConnected) { window.clearInterval(timer); return; } out.textContent = text(); }, 1000);
  const toggle = (label: string, key: string, get: () => boolean, set: (v: boolean) => void, help: string) =>
    field(label, h("input", { type: "checkbox", checked: get(), title: label, "data-help": help, onChange: (e: Event) => { const v = (e.target as HTMLInputElement).checked; set(v); try { localStorage.setItem(key, v ? "1" : "0"); } catch { /* storage blocked */ } app.invalidate(); perfStats.reset(); } }));
  return h("div", {},
    out,
    toggle("Stroke cache", "omni.strokeCache", () => (app.renderer as AppState["renderer"] | undefined)?.strokeCache ?? true, (v) => { app.renderer.strokeCache = v; if (!v) app.renderer.endStroke(); }, "While you draw, the layers under and over the one you are drawing on are kept as two ready images, so each frame redraws one layer instead of all of them. Turn off only to compare."),
    toggle("Flatten layers", "omni.flatten", () => (app.renderer as AppState["renderer"] | undefined)?.projection ?? true, (v) => { app.renderer.projection = v; }, "Plain layers at the bottom of the stack are kept merged per tile and per zoom level, so panning and zooming draw one image per tile instead of one per layer. Tone and 3D layers, and anything above them, are still drawn live. Turn off only to compare."),
    h("div", { class: "row", style: { marginTop: "4px" } },
      h("button", { title: "Reset numbers", "data-help": "Start the rolling numbers again, e.g. before drawing a test stroke.", onClick: () => { perfStats.reset(); out.textContent = text(); } }, "Reset numbers"),
      h("button", { title: "Copy numbers", "data-help": "Copy these numbers to paste into a bug report or chat.", onClick: () => { void navigator.clipboard?.writeText(text()); } }, "Copy")));
}

export function settingsPanel(app: AppState): HTMLElement {
  const root = h("div");
  let capturing: Action | null = null;
  const render = () => {
    clear(root);
    const km = app.keymap;
    const rows = (Object.keys(ACTION_LABELS) as Action[]).map((a) => {
      const conflict = km.conflicts(a, km.map[a]);
      const btn = h("button", { class: capturing === a ? "active" : "", style: { minWidth: "96px", fontFamily: "monospace", borderColor: conflict ? "#c0392b" : undefined }, title: conflict ? `conflicts with ${ACTION_LABELS[conflict]}` : "click, then press the new shortcut (Esc cancels)", onClick: () => { capturing = capturing === a ? null : a; render(); } }, capturing === a ? "press keys…" : km.map[a]);
      return h("div", { class: "kv", style: { alignItems: "center" } }, h("span", {}, ACTION_LABELS[a]), btn);
    });
    const ws = loadWorkspace();
    root.append(h("h3", {}, "Selection"),
      field("Clear on tool change", h("input", { type: "checkbox", checked: app.clearSelectionOnTool, title: "Clear on tool change", "data-help": "Off (default, like other art apps): a selection stays until you clear it, so you can select an area and then paint inside it. On: switching to a tool that does not use the selection clears it. Esc and Ctrl+D always clear it.", onChange: (e: Event) => { app.clearSelectionOnTool = (e.target as HTMLInputElement).checked; try { localStorage.setItem("omni.clearSelOnTool", app.clearSelectionOnTool ? "1" : "0"); } catch { /* quota */ } } })),
      h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0 8px" } }, "Esc or Ctrl+D clears the marching ants at any time."),
      h("div", { class: "sep" }), h("h3", {}, "Shortcuts"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Click a binding and press the new keys. Red = conflict. Selection keys (M, W, T, Ctrl+A/D, Ctrl+Shift+I) are fixed."),
      ...rows,
      h("div", { class: "row", style: { marginTop: "6px" } }, h("button", { onClick: () => { km.reset(); render(); } }, "Reset to defaults")),
      h("div", { class: "sep" }), h("h3", {}, "Workspace"),
      field("Layout", h("select", { onChange: (e: Event) => { const w = WORKSPACES[Number((e.target as HTMLSelectElement).value)]!; applyWorkspace(w); render(); } }, ...WORKSPACES.map((w, i) => h("option", { value: String(i), selected: w.name === ws.name }, w.name)))),
      h("div", { class: "kv" }, h("span", {}, "panel"), h("b", {}, `${ws.panelW} px`), h("span", {}, "toolbar"), h("b", {}, `${ws.toolbarW} px`), h("span", {}, "timeline"), h("b", {}, `${ws.timelineH} px`)),
      h("div", { class: "sep" }), h("h3", {}, "Performance"),
      perfSection(app),
      h("div", { class: "sep" }), h("h3", {}, "Brush core"),
      h("div", { class: "kv" }, h("span", {}, "wasm module"), h("b", {}, app.wasmBrush ? "loaded (core/wasm/brush_core.cpp)" : "not available"), h("span", {}, "bench"), h("b", { id: "wasm-bench" }, app.wasmBenchMsg)),
      field("Use wasm core", h("select", { onChange: (e: Event) => { app.useWasmBrush = (e.target as HTMLSelectElement).value === "on"; } }, h("option", { value: "on", selected: app.useWasmBrush }, "on (round grain-free tips)"), h("option", { value: "off", selected: !app.useWasmBrush }, "off (Canvas 2D tips)"))),
      h("div", { class: "row", style: { marginTop: "6px" } }, h("button", { disabled: !app.wasmBrush, onClick: () => {
        const n = 20000; const wasmMs = app.wasmBrush!.bench(n, 12, 0.9);
        // JS reference: the same dab count with the Canvas 2D tip path on one 256 px tile
        const c = document.createElement("canvas"); c.width = 256; c.height = 256; const g = c.getContext("2d")!; const tip = document.createElement("canvas"); tip.width = 26; tip.height = 26; const tg = tip.getContext("2d")!;
        const grad = tg.createRadialGradient(13, 13, 0, 13, 13, 12.5); grad.addColorStop(0, "rgba(20,20,20,1)"); grad.addColorStop(0.9, "rgba(20,20,20,1)"); grad.addColorStop(1, "rgba(20,20,20,0)"); tg.fillStyle = grad; tg.beginPath(); tg.arc(13, 13, 12.5, 0, Math.PI * 2); tg.fill();
        const t0 = performance.now(); g.globalAlpha = 0.6; for (let i = 0; i < n; i++) { const t = i / (n - 1); g.drawImage(tip, 16 + t * 224 - 13, 16 + t * 224 - 13); } g.getImageData(0, 0, 1, 1); const jsMs = performance.now() - t0;
        app.wasmBenchMsg = `${n} dabs r=12: wasm ${wasmMs.toFixed(0)} ms (${Math.round(n / wasmMs * 1000 / 1000)}k/s), canvas ${jsMs.toFixed(0)} ms (${Math.round(n / jsMs * 1000 / 1000)}k/s)`;
        const el = document.getElementById("wasm-bench"); if (el) el.textContent = app.wasmBenchMsg; } }, "Benchmark 20k dabs")),
      h("div", { class: "sep" }), h("h3", {}, "About"),
      h("div", { class: "kv" }, h("span", {}, "renderer"), h("b", {}, app.renderer?.mode ?? "?"), h("span", {}, "mode"), h("b", {}, app.doc.mode), h("span", {}, "undo depth"), h("b", {}, String(app.history.labels.length))));
  };
  window.addEventListener("keydown", (e) => {
    if (!capturing) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") { capturing = null; render(); return; }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    app.keymap.map[capturing] = Keymap.combo(e); app.keymap.save(); capturing = null; render();
  }, true);
  app.on("tool", () => { if (!capturing) render(); }); app.on("wasm", render);
  render();
  return root;
}
