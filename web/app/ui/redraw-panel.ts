/**
 * Redraw tab: rebuild a picture (a generated result or any raster layer) with OMNI-CELL's tools:
 * Trace Pen ink strokes, shape-filled flats, multiply shadows, screen light and screentone layers.
 */
import type { AppState } from "./state.js";
import { h, clear, field, slider } from "./dom.js";
import { TRACE_DEFAULTS, type TraceParams } from "../engine/trace/trace-core.js";
import { analyse, bakeRedraw, buildRedraw, layerPixels, scoreRedraw, sourcePixels, type RedrawReport, type RedrawStyle } from "../engine/trace/redraw.js";
import type { JobRunner } from "../engine/ml.js";
import type { Layer } from "../engine/document.js";
import type { Region } from "../engine/ml.js";

/** a picture handed over from elsewhere (the Generate tab's results) */
export interface RedrawSource { image: string; region: (Region & { panelId?: number }) | null; name: string; /** preset options applied before an automatic run (Manga panel button) */ auto?: { style: RedrawStyle; ink: "auto" | "colour" | "black"; layers: "single" | "separate"; lines: "trace" | "detector" } }
let pending: RedrawSource | null = null;
export function setRedrawSource(app: AppState, s: RedrawSource): void { pending = s; app.emit("redraw-source"); app.emit("open-panel", "Redraw"); }
/** one-click manga panel from a Generate result: manga look, black ink, detector lines, one layer, then run */
export function redrawAsMangaPanel(app: AppState, s: RedrawSource): void { pending = { ...s, auto: { style: "manga", ink: "black", layers: "single", lines: "detector" } }; app.emit("redraw-source"); app.emit("open-panel", "Redraw"); app.emit("redraw-run"); }

const KEY = "omni.redraw.v1";
interface Saved { params: TraceParams; style: RedrawStyle; maxMpx: number; lpi: number; panelId: number; ink: "auto" | "colour" | "black"; layers: "single" | "separate"; lines: "trace" | "detector" }
const DEF: Saved = { params: { ...TRACE_DEFAULTS }, style: "colour", maxMpx: 2, lpi: 60, panelId: -2, ink: "auto", layers: "single", lines: "detector" };
function load(): Saved { try { const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>; return { ...DEF, ...s, params: { ...DEF.params, ...(s.params ?? {}) } }; } catch { return { ...DEF, params: { ...DEF.params } }; } }

export function redrawPanel(app: AppState): HTMLElement {
  const root = h("div", { class: "redraw-tab" });
  const st = load(); const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* quota */ } };
  let running: { cancel: () => void } | null = null; let stage = ""; let pct = 0; let error = ""; let linesNote = "";
  let report: (RedrawReport & { sourceLayer: Layer | null; single: Layer | null; built: { layers: Layer[]; group: Layer } | null; region: Region & { panelId?: number } }) | null = null;
  const provider = () => (app as unknown as { ml?: JobRunner }).ml?.provider ?? null;
  let render = () => {};

  const panelBox = (id: number): (Region & { panelId: number }) | null => {
    const p = app.doc.panels.find((q) => q.id === id); if (!p || p.polygon.length < 3) return null;
    const xs = p.polygon.map((q) => q.x), ys = p.polygon.map((q) => q.y);
    return { x0: Math.floor(Math.min(...xs)), y0: Math.floor(Math.min(...ys)), x1: Math.ceil(Math.max(...xs)), y1: Math.ceil(Math.max(...ys)), panelId: p.id };
  };
  const layerBox = (l: Layer): Region | null => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of l.tiles.values()) { if (!t.canvas) continue; x0 = Math.min(x0, t.x * 256); y0 = Math.min(y0, t.y * 256); x1 = Math.max(x1, t.x * 256 + 256); y1 = Math.max(y1, t.y * 256 + 256); }
    if (!Number.isFinite(x0)) return null;
    return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(app.doc.width, x1), y1: Math.min(app.doc.height, y1) };
  };

  const run = async () => {
    error = ""; report = null; linesNote = "";
    const doc = app.doc; const src = pending; const srcLayer = src ? null : doc.activeLayer;
    if (src?.auto) { st.style = src.auto.style; st.ink = src.auto.ink; st.layers = src.auto.layers; st.lines = src.auto.lines; save(); }
    if (!src && (!srcLayer || srcLayer.kind !== "raster")) { error = "Pick a raster layer with a picture on it (or press Redraw on a Generate result)."; render(); return; }
    // area: chosen panel, else the result's own panel, else the layer's content / the page
    let region: (Region & { panelId?: number }) | null = st.panelId >= 0 ? panelBox(st.panelId) : null;
    if (!region && src?.region) region = src.region;
    if (!region) region = srcLayer ? layerBox(srcLayer) : { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
    if (!region) { error = "That layer is empty."; render(); return; }
    stage = "reading"; pct = 0.01; render();
    let img: ImageData; let mask: Uint8Array | null = null;
    try {
      let sp;
      if (src) {
        const im = new Image(); await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error("could not read the image")); im.src = src.image; });
        sp = await sourcePixels(im, doc, region, src.region ?? null, st.maxMpx);
      } else sp = layerPixels(srcLayer!, region, st.maxMpx);
      img = sp.data; mask = sp.mask;
      if (sp.coverage < 0.002) { error = "That layer has no visible pixels in the area."; stage = ""; render(); return; }
    } catch (e) { error = (e as Error).message; stage = ""; render(); return; }
    // lines from the sidecar's anime lineart detector when asked and online; otherwise the built-in tracer
    let lines: Uint8Array | null = null;
    const pv = provider();
    if (st.lines === "detector" && pv?.lineart) {
      stage = "lineart (sidecar)"; pct = 0.03; render();
      try {
        const c0 = document.createElement("canvas"); c0.width = img.width; c0.height = img.height; c0.getContext("2d")!.putImageData(img, 0, 0);
        const url = await pv.lineart(c0.toDataURL("image/png"), img.width, img.height);
        const li = new Image(); await new Promise<void>((res, rej) => { li.onload = () => res(); li.onerror = () => rej(new Error("lineart")); li.src = url; });
        const c1 = document.createElement("canvas"); c1.width = img.width; c1.height = img.height; const g1 = c1.getContext("2d", { willReadFrequently: true })!; g1.drawImage(li, 0, 0, img.width, img.height);
        const d = g1.getImageData(0, 0, img.width, img.height).data; lines = new Uint8Array(img.width * img.height);
        for (let i = 0; i < lines.length; i++) lines[i] = d[i * 4]!;
      } catch { lines = null; linesNote = "detector unavailable, traced lines used"; }
    }
    const job = analyse(img, st.params, (s, p) => { stage = s; pct = p; render(); }, mask, lines); running = job;
    let r;
    try { r = await job.promise; } catch (e) { running = null; stage = ""; error = (e as Error).message === "cancelled" ? "" : `Analysis failed: ${(e as Error).message}`; render(); return; }
    running = null;
    const t0 = performance.now();
    const name = `Redraw · ${src ? src.name : srcLayer!.name}`;
    const built = await buildRedraw(doc, r, region, { params: st.params, style: st.style, maxMpx: st.maxMpx, lpi: st.lpi, name, inkBlack: st.ink === "black" || (st.ink === "auto" && st.style === "manga") }, (s, p) => { stage = s; pct = p; render(); });
    const buildMs = Math.round(performance.now() - t0);
    stage = "scoring"; pct = 0.97; render(); await new Promise((res) => setTimeout(res, 0));
    const byName = (n: string) => built.layers.find((l) => l.name === n && l.parent === built.group.id) ?? null;
    const colour = ["Flats", "Shadows", "Light", "Soft shading", "Ink"].map(byName).filter((l): l is Layer => !!l);
    const score = scoreRedraw(doc, img, r, region, colour, byName("Ink")!, mask);
    const list = () => app.doc.drawing.layers;
    let single: Layer | null = null;
    if (st.layers === "single") {
      // everything on one layer: composite the group (tones baked as dot screens) and drop the parts
      stage = "flattening"; pct = 0.985; render(); await new Promise((res) => setTimeout(res, 0));
      single = bakeRedraw(doc, (d, sc, ids) => app.renderer.flatten(d, sc, ids), built, region, name);
      for (const l of built.layers) { const i = list().indexOf(l); if (i >= 0) list().splice(i, 1); }
      const one = single; const pos = list().indexOf(one);
      app.history.pushCustom("Redraw", () => { const i = list().indexOf(one); if (i >= 0) list().splice(i, 1); app.invalidate(); app.emit("layers"); },
        () => { list().splice(Math.min(pos, list().length), 0, one); app.invalidate(); app.emit("layers"); });
      app.doc.activeLayerId = one.id;
    } else {
      // one undo step for the whole redraw
      const layers = built.layers; const at = layers.map((l) => list().indexOf(l));
      app.history.pushCustom("Redraw", () => { for (const l of layers) { const i = list().indexOf(l); if (i >= 0) list().splice(i, 1); } app.invalidate(); app.emit("layers"); },
        () => { layers.forEach((l, j) => list().splice(Math.min(at[j]!, list().length), 0, l)); app.invalidate(); app.emit("layers"); });
      app.doc.activeLayerId = byName("Ink")?.id ?? app.doc.activeLayerId;
    }
    if (srcLayer) srcLayer.visible = false; // compare with the Compare button
    report = { layers: built.layers, group: built.group, stats: { ...r.stats, workW: r.w, workH: r.h, buildMs, dabs: built.dabs }, ...score, sourceLayer: srcLayer, single, built, region };
    pending = null; stage = ""; pct = 0;
    app.invalidate(); app.emit("layers"); render();
  };

  /** switch the redraw between its colour and manga layers; a single-layer redraw is re-baked in place */
  const setLook = (rp: NonNullable<typeof report>, look: "colour" | "manga") => {
    for (const l of rp.layers) { if (["Flats", "Shadows", "Light", "Soft shading"].includes(l.name)) l.visible = look === "colour"; if (l.name === "Screentone") l.visible = look === "manga"; }
    if (rp.single && rp.built) {
      const fresh = bakeRedraw(app.doc, (d, sc, ids) => app.renderer.flatten(d, sc, ids), rp.built, rp.region, rp.single.name);
      // move the baked tiles into the existing layer so its id, position and undo entry stay valid
      const list = app.doc.drawing.layers; const i = list.indexOf(fresh); if (i >= 0) list.splice(i, 1);
      rp.single.tiles.clear(); for (const [k, t] of fresh.tiles) rp.single.tiles.set(k, t); rp.single.generation++;
    }
    app.invalidate(); app.emit("layers");
  };
  const p = st.params;
  const set = <K extends keyof TraceParams>(k: K, v: TraceParams[K]) => { p[k] = v; save(); };
  render = () => {
    const panels = app.doc.panels;
    const srcText = pending ? `Generated result: ${pending.name}${pending.region ? " (its panel)" : ""}` : `Active layer: ${app.doc.activeLayer?.name ?? "none"}`;
    clear(root).append(
      h("h3", {}, "Redraw with OMNI-CELL tools"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Rebuilds a picture on new layers made with the app's own tools: Trace Pen ink strokes, filled flats, multiply shadows, screen light and screentone. Every mark can then be edited, erased or redrawn."),
      h("div", { class: "row", style: { gap: "6px", alignItems: "center", fontSize: "11.5px" } }, h("span", {}, srcText), pending ? h("button", { title: "Use the active layer instead", onClick: () => { pending = null; render(); } }, "Use layer") : null),
      field("Area", h("select", { title: "Redraw area", "data-help": "Which part of the page to rebuild. Auto: the result's panel, or everything on the layer.", onChange: (e: Event) => { st.panelId = Number((e.target as HTMLSelectElement).value); save(); } },
        h("option", { value: "-2", selected: st.panelId < 0 }, "Auto"), ...panels.map((q, i) => h("option", { value: String(q.id), selected: st.panelId === q.id }, `Panel ${i + 1}`)))),
      field("Look", h("select", { title: "Redraw look", "data-help": "Colour: flats, shadows and light visible. Manga: ink and screentone visible, colour layers hidden (still there to switch on).", onChange: (e: Event) => { st.style = (e.target as HTMLSelectElement).value as RedrawStyle; save(); } },
        h("option", { value: "colour", selected: st.style === "colour" }, "Colour (cel)"), h("option", { value: "manga", selected: st.style === "manga" }, "Manga (ink + tone)"))),
      field("Layers", h("select", { title: "Redraw layers", "data-help": "One layer: the whole redraw lands on a single raster layer (tones baked as dot screens), so there is nothing to scramble through. Separate: a group with Ink, Flats, Shadows, Light, Soft shading and Screentone layers for editing each part.", onChange: (e: Event) => { st.layers = (e.target as HTMLSelectElement).value as Saved["layers"]; save(); } },
        h("option", { value: "single", selected: st.layers === "single" }, "One layer"), h("option", { value: "separate", selected: st.layers === "separate" }, "Separate layers (group)"))),
      h("div", { class: "sep" }), h("h3", {}, "Lines"),
      field("Lines from", h("select", { title: "Line source", "data-help": "Anime lineart detector: the sidecar's lineart_anime model picks the lines a manga inker would, cleaner on painted images; needs the sidecar. Traced: the built-in detector (works offline).", onChange: (e: Event) => { st.lines = (e.target as HTMLSelectElement).value as Saved["lines"]; save(); } },
        h("option", { value: "detector", selected: st.lines === "detector" }, "anime lineart detector (sidecar)"), h("option", { value: "trace", selected: st.lines === "trace" }, "traced here"))),
      linesNote ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0", color: "#d9b65c" } }, linesNote) : null,
      field("Ink colour", h("select", { title: "Ink colour", "data-help": "Auto: traced colours for Colour, black for Manga. Coloured line art (red glasses, brown hair lines) keeps its colour unless you choose Black.", onChange: (e: Event) => { st.ink = (e.target as HTMLSelectElement).value as Saved["ink"]; save(); } },
        ...([["auto", "Auto"], ["colour", "As traced"], ["black", "Black"]] as const).map(([v, l]) => h("option", { value: v, selected: st.ink === v }, l)))),
      field("Line pickup", slider(0.1, 0.95, 0.05, p.lineSensitivity, (v) => set("lineSensitivity", v)), () => p.lineSensitivity.toFixed(2)),
      field("Solid black from", slider(1.5, 8, 0.5, p.solidInk, (v) => set("solidInk", v)), () => `${p.solidInk.toFixed(1)} px`),
      field("Line smoothing", slider(0, 1, 0.05, p.lineSmoothing, (v) => set("lineSmoothing", v)), () => p.lineSmoothing.toFixed(2)),
      h("div", { class: "sep" }), h("h3", {}, "Colour and shading"),
      field("Colour detail", slider(6, 48, 1, p.detail, (v) => set("detail", v)), () => `${p.detail} colours`),
      field("Smallest region", slider(0, 400, 10, p.minRegion, (v) => set("minRegion", v)), () => (p.minRegion ? `${p.minRegion} px` : "auto")),
      field("Shadow levels", h("select", { title: "Shadow levels", onChange: (e: Event) => set("shadowLevels", Number((e.target as HTMLSelectElement).value) as 1 | 2) }, h("option", { value: "1", selected: p.shadowLevels === 1 }, "1 (classic cel)"), h("option", { value: "2", selected: p.shadowLevels === 2 }, "2 (shadow + core)"))),
      field("Shadow from", slider(3, 16, 0.5, p.shadowStep, (v) => set("shadowStep", v)), () => `${p.shadowStep.toFixed(1)} L*`),
      field("Highlights from", slider(0, 20, 1, p.highlightStep, (v) => set("highlightStep", v)), () => (p.highlightStep ? `${p.highlightStep} L*` : "off")),
      field("Soft shading", slider(0, 1, 0.05, p.soft, (v) => set("soft", v)), () => (p.soft ? `${Math.round(p.soft * 100)}%` : "off")),
      h("p", { class: "dim", style: { fontSize: "11px", margin: "0 0 4px" } }, "Gradients, airbrushed blush and soft shadows the cel layers cannot hold are painted back as airbrush dabs on a Soft shading layer. 100% follows the picture; 0 is pure cel."),
      field("Join line pieces", slider(0, 8, 0.5, p.chainGap, (v) => set("chainGap", v)), () => (p.chainGap ? `${p.chainGap} px gap` : "off")),
      field("Tone lpi", slider(40, 85, 5, st.lpi, (v) => { st.lpi = v; save(); }), () => `${st.lpi} lpi`),
      field("Working size", h("select", { title: "Working resolution", "data-help": "Pixels the analysis works at. Fine follows thin lines best and takes longest.", onChange: (e: Event) => { st.maxMpx = Number((e.target as HTMLSelectElement).value); save(); } },
        ...([[1, "Fast (1 Mpx)"], [2, "Standard (2 Mpx)"], [3.5, "Fine (3.5 Mpx)"]] as const).map(([v, l]) => h("option", { value: String(v), selected: st.maxMpx === v }, l)))),
      h("div", { class: "row", style: { gap: "6px", margin: "8px 0" } },
        h("button", { class: "primary", title: "Redraw", disabled: !!running || !!stage, "data-help": "Analyse the picture, then draw it again on new layers with OMNI-CELL's tools. One undo step.", onClick: () => void run() }, "Redraw"),
        running ? h("button", { title: "Cancel redraw", onClick: () => { running?.cancel(); running = null; stage = ""; render(); } }, "Cancel") : null,
        h("button", { title: "Reset settings", onClick: () => { st.params = { ...TRACE_DEFAULTS }; save(); render(); } }, "Defaults")),
      stage ? h("div", {}, h("div", { class: "gen-progress" }, h("div", { style: { width: `${Math.round(pct * 100)}%` } })), h("div", { class: "dim mono", style: { fontSize: "11px" } }, `${stage} · ${Math.round(pct * 100)}%`)) : null,
      error ? h("div", { class: "notice", style: { fontSize: "11.5px" } }, error) : null,
      report ? (() => {
        const rp = report;
        const grade = (v: number, good: number, ok: number) => (v >= good ? "close" : v >= ok ? "fair" : "loose");
        return h("div", { class: "gen-job" },
          h("div", { class: "mono", style: { fontSize: "11px", lineHeight: "1.5" } },
            `colour match  ΔE ${rp.deltaE.toFixed(1)} avg · ${(rp.within10 * 100).toFixed(0)}% of pixels within ΔE 10 (${grade(rp.within10, 0.85, 0.7)})${rp.coverage < 0.999 ? ` · judged on the ${(rp.coverage * 100).toFixed(0)}% of the area the picture covers` : ""}`, h("br"),
            `line match    F1 ${rp.lineF1.toFixed(2)} (precision ${rp.linePrecision.toFixed(2)}, recall ${rp.lineRecall.toFixed(2)})`, h("br"),
            `built         ${rp.stats.strokes} Trace Pen strokes (${rp.stats.dabs.toLocaleString()} dabs${rp.stats.chained ? `, ${rp.stats.chained} pieces joined` : ""}), ${rp.stats.regions} regions, ${rp.stats.palette} ink colours${rp.stats.softDabs ? `, ${rp.stats.softDabs.toLocaleString()} airbrush dabs` : ""}`, h("br"),
            `time          analysis ${Object.values(rp.stats.ms).reduce((a, b) => a + b, 0)} ms · drawing ${rp.stats.buildMs} ms at ${rp.stats.workW}×${rp.stats.workH}`),
          h("div", { class: "row", style: { gap: "6px", marginTop: "6px", flexWrap: "wrap" } },
            rp.sourceLayer ? h("button", { title: "Compare with source", "data-help": "Toggle between the redraw and the original layer.", onClick: () => { const s = rp.sourceLayer!; s.visible = !s.visible; rp.group.visible = !s.visible; app.invalidate(); app.emit("layers"); } }, "Compare") : null,
            h("button", { title: "Show colour layers", onClick: () => { setLook(rp, "colour"); } }, "Colour"),
            h("button", { title: "Show manga layers", onClick: () => { setLook(rp, "manga"); } }, "Manga"),
            h("button", { title: "More detail", "data-help": "Run again with more colours, smaller regions and finer lines.", onClick: () => { p.detail = Math.min(48, p.detail + 8); p.minRegion = p.minRegion ? Math.max(0, p.minRegion - 30) : 0; p.lineSensitivity = Math.min(0.9, p.lineSensitivity + 0.05); st.maxMpx = Math.max(st.maxMpx, 3.5); save(); render(); } }, "More detail…")));
      })() : null,
    );
  };
  app.on("redraw-source", () => { report = null; render(); });
  app.on("redraw-run", () => { if (!running && !stage) void run(); });
  app.on("panels", () => { if (root.isConnected) render(); });
  app.on("layers", () => { if (!stage && root.isConnected && !pending) render(); });
  render();
  return root;
}
