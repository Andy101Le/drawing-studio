/**
 * Brush panel: categorized presets, live stroke preview, pressure-curve editor
 * (drag two Bézier handles), size/flow/opacity dynamics, grain, tilt, jitter,
 * and a stroke-strength meter driven by the last filtered pressure.
 */

import { PRESETS, StrokeEngine, pressureCurve, type BrushPreset, type TipShape, type Media, type WetEffect } from "../engine/brush.js";
import { WET_DEFAULT, BODY_DEFAULT, wetField, dryLayer, layerWet, type SpongeKind } from "../engine/media.js";
import { Layer, TILE } from "../engine/document.js";
import { clear, field, h, slider } from "./dom.js";
import type { AppState } from "./state.js";

const CATS: Array<[BrushPreset["category"], string]> = [["ink", "Ink"], ["pencil", "Pencil"], ["paint", "Paint"], ["water", "Water"], ["acrylic", "Acrylic"], ["sponge", "Sponge"], ["air", "Air"], ["fx", "FX"], ["erase", "Erase"]];

interface SavedTip { name: string; data: string }
function loadTips(): SavedTip[] { try { return JSON.parse(localStorage.getItem("omni.customTips") ?? "[]") as SavedTip[]; } catch { return []; } }
function saveTip(name: string, data: string): void { const list = loadTips().filter((t) => t.data !== data); list.unshift({ name, data }); try { localStorage.setItem("omni.customTips", JSON.stringify(list.slice(0, 24))); } catch { /* quota */ } }
export function brushPanel(app: AppState): HTMLElement {
  const root = h("div");
  let cat: BrushPreset["category"] = "ink";
  const preview = h("canvas", { width: 248, height: 64, style: { width: "100%", height: "64px", border: "1px solid #3a3a3a", background: "#fff", display: "block" } }) as HTMLCanvasElement;
  const curveC = h("canvas", { width: 120, height: 120, style: { width: "120px", height: "120px", border: "1px solid #3a3a3a", background: "#0f0f0f", cursor: "crosshair" } }) as HTMLCanvasElement;
  const meter = h("div", { style: { height: "6px", border: "1px solid #3a3a3a", position: "relative" } }, h("div", { style: { position: "absolute", left: 0, top: 0, bottom: 0, width: "0%", background: "#b8b8b8" } }));

  const drawPreview = () => {
    const p = app.preset;
    const w = 248, hgt = 64;
    const layer = new Layer("preview", "raster"); layer.transient = true;
    // the preview is rendered in a 2.5x document scale so small pens stay legible
    const sc = Math.max(0.6, Math.min(2.5, 24 / p.size));
    // mixers / smudge / blur need something underneath: two colour bands
    const needsBase = p.mix > 0 || p.kind === "smudge" || p.kind === "blur" || p.wetEffect !== "none" || (p.media === "water" && (p.wet.lift ?? 0) > 0);
    // wet effects and lifts need a wash under them: a soft blue wash laid first, still wet
    if (p.media === "water" && (p.wetEffect !== "none" || (p.wet.lift ?? 0) > 0 || (p.wet.pigment ?? WET_DEFAULT.pigment) === 0)) {
      const wash = new StrokeEngine({ preset: { ...PRESETS.find((x) => x.name === "Flat Wash")!, size: 70 }, color: "#2e86c1", layer, docScale: 1 });
      wash.begin({ x: 10, y: hgt / 2, pressure: 0.8, tiltX: 0, tiltY: 0, tMs: 0 }); for (let i = 1; i <= 20; i++) wash.move({ x: 10 + (i / 20) * (w - 20), y: hgt / 2, pressure: 0.8, tiltX: 0, tiltY: 0, tMs: i * 8 }); wash.end(); wash.commit();
      const f = wetField(layer); if (f) { const t0 = performance.now(); f.lastTick = t0; for (let i = 1; i <= 8; i++) f.tick(t0 + i * 100, f.params); }
    }
    if (needsBase) { const bt = layer.getTile(0, 0, true)!; const bc = bt.ctx as CanvasRenderingContext2D; bc.fillStyle = "#2e86c1"; bc.fillRect(0, 0, w, hgt / 2); bc.fillStyle = "#f1c40f"; bc.fillRect(0, hgt / 2, w, hgt / 2); }
    const eng = new StrokeEngine({ preset: { ...p, size: p.size * sc }, color: p.kind === "eraser" ? "#8c8c8c" : app.color, layer, docScale: 1 });
    const n = 70;
    // slow start, fast middle, slow end: pooling and speed-thinning become visible; tilt ramps to 50° at the end
    const at = (i: number) => { const t = i / n; const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; return { x: 12 + ease * (w - 24), y: hgt / 2 + Math.sin(t * Math.PI * 2) * 14, pressure: Math.pow(Math.sin(t * Math.PI), 0.8), tiltX: 10 + 40 * t, tiltY: 5, tMs: i * 8 }; };
    eng.begin(at(0)); for (let i = 1; i <= n; i++) eng.move(at(i)); eng.end(); eng.commit();
    // watercolour: let the preview dry (simulate ~4 s) so edges, granulation and blooms show
    { const f = wetField(layer); if (f) { const t0 = performance.now(); f.lastTick = t0; for (let i = 1; i <= 40; i++) f.tick(t0 + i * 100, f.params); dryLayer(layer); } }
    const c = preview.getContext("2d")!; c.clearRect(0, 0, w, hgt); c.fillStyle = "#fff"; c.fillRect(0, 0, w, hgt);
    if (p.blend === "multiply" && !needsBase) c.globalCompositeOperation = "multiply";
    for (const t of layer.tiles.values()) if (t.canvas) c.drawImage(t.canvas as CanvasImageSource, t.x * TILE, t.y * TILE);
    c.globalCompositeOperation = "source-over";
  };

  let dragHandle: 0 | 1 | null = null;
  const drawCurve = () => {
    const c = curveC.getContext("2d")!; const S = 120; const cv = app.preset.curve;
    c.clearRect(0, 0, S, S); c.strokeStyle = "#2c2c2c"; c.lineWidth = 1;
    for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo((i * S) / 4, 0); c.lineTo((i * S) / 4, S); c.moveTo(0, (i * S) / 4); c.lineTo(S, (i * S) / 4); c.stroke(); }
    c.strokeStyle = "#555"; c.setLineDash([3, 3]); c.beginPath(); c.moveTo(0, S); c.lineTo(S, 0); c.stroke(); c.setLineDash([]);
    c.strokeStyle = "#e6e6e6"; c.lineWidth = 1.5; c.beginPath();
    for (let i = 0; i <= 60; i++) { const x = i / 60; const y = pressureCurve(x, cv); if (i === 0) c.moveTo(x * S, S - y * S); else c.lineTo(x * S, S - y * S); }
    c.stroke();
    c.strokeStyle = "#8c8c8c"; c.beginPath(); c.moveTo(0, S); c.lineTo(cv[0] * S, S - cv[1] * S); c.moveTo(S, 0); c.lineTo(cv[2] * S, S - cv[3] * S); c.stroke();
    c.fillStyle = "#b8b8b8"; for (const [x, y] of [[cv[0], cv[1]], [cv[2], cv[3]]] as Array<[number, number]>) { c.beginPath(); c.arc(x * S, S - y * S, 4, 0, Math.PI * 2); c.fill(); }
    // current pressure marker
    const px = app.statusInput.pressure; c.fillStyle = "#fff"; c.beginPath(); c.arc(px * S, S - pressureCurve(px, cv) * S, 3, 0, Math.PI * 2); c.fill();
  };
  const curvePt = (e: PointerEvent) => { const r = curveC.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) }; };
  curveC.addEventListener("pointerdown", (e) => {
    const q = curvePt(e); const cv = app.preset.curve;
    dragHandle = Math.hypot(q.x - cv[0], q.y - cv[1]) <= Math.hypot(q.x - cv[2], q.y - cv[3]) ? 0 : 1;
    curveC.setPointerCapture(e.pointerId);
  });
  curveC.addEventListener("pointermove", (e) => {
    if (dragHandle === null) return;
    const q = curvePt(e); const cv = app.preset.curve;
    if (dragHandle === 0) { cv[0] = q.x; cv[1] = q.y; } else { cv[2] = q.x; cv[3] = q.y; }
    drawCurve(); drawPreview();
  });
  curveC.addEventListener("pointerup", () => (dragHandle = null));

  const render = () => {
    const p = app.preset;
    const catBar = h("div", { class: "row", style: { flexWrap: "wrap", marginBottom: "6px" } }, ...CATS.map(([id, label]) => h("button", { class: id === cat ? "active" : "", onClick: () => { cat = id; render(); } }, label)));
    const list = h("div", { class: "row", style: { flexWrap: "wrap", marginBottom: "8px" } }, ...PRESETS.filter((x) => x.category === cat).map((x) => h("button", { class: x.name === p.name ? "active" : "", onClick: () => app.setPreset(x) }, x.name)));
    const dyn = h("div", {},
      field("Size", slider(1, 400, 0.5, p.size, (v) => { p.size = v; drawPreview(); }), () => `${p.size.toFixed(1)} px`),
      field("Size ∝ press.", h("input", { type: "checkbox", checked: p.sizeByPressure, onChange: (e: Event) => { p.sizeByPressure = (e.target as HTMLInputElement).checked; drawPreview(); } })),
      field("Min size", slider(0, 1, 0.01, p.minSizeRatio, (v) => { p.minSizeRatio = v; drawPreview(); }), () => `${Math.round(p.minSizeRatio * 100)}%`),
      field("Opacity", slider(0.01, 1, 0.01, p.opacity, (v) => { p.opacity = v; drawPreview(); }), () => `${Math.round(p.opacity * 100)}%`),
      field("Flow", slider(0.01, 1, 0.01, p.flow, (v) => { p.flow = v; drawPreview(); }), () => `${Math.round(p.flow * 100)}%`),
      field("Flow ∝ press.", h("input", { type: "checkbox", checked: p.flowByPressure, onChange: (e: Event) => { p.flowByPressure = (e.target as HTMLInputElement).checked; drawPreview(); } })),
      field("Hardness", slider(0, 1, 0.01, p.hardness, (v) => { p.hardness = v; drawPreview(); }), () => `${Math.round(p.hardness * 100)}%`),
      field("Spacing", slider(0.03, 0.5, 0.01, p.spacing, (v) => { p.spacing = v; drawPreview(); }), () => `${Math.round(p.spacing * 100)}%`),
      field("Grain", slider(0, 1, 0.01, p.grain, (v) => { p.grain = v; drawPreview(); }), () => `${Math.round(p.grain * 100)}%`),
      field("Grain scale", slider(6, 80, 1, p.grainScale, (v) => { p.grainScale = v; drawPreview(); }), () => `${p.grainScale} px`),
      field("Smoothing", slider(0, 1, 0.01, p.smoothing, (v) => (p.smoothing = v)), () => `${Math.round(p.smoothing * 100)}%`),
      field("Stabilizer", slider(0, 40, 1, p.stabilizer, (v) => (p.stabilizer = v)), () => `${p.stabilizer} px`),
      field("Taper", slider(0, 120, 1, p.taper, (v) => { p.taper = v; drawPreview(); }), () => `${p.taper} px`),
      field("Speed thin", slider(0, 1, 0.01, p.velocityThin, (v) => { p.velocityThin = v; drawPreview(); }), () => `${Math.round(p.velocityThin * 100)}%`),
      field("Jitter", slider(0, 1, 0.01, p.jitter, (v) => { p.jitter = v; drawPreview(); }), () => `${Math.round(p.jitter * 100)}%`),
      field("Tilt shape", h("input", { type: "checkbox", checked: p.tiltShape, onChange: (e: Event) => { p.tiltShape = (e.target as HTMLInputElement).checked; drawPreview(); } })),
      field("Blend", h("select", { onChange: (e: Event) => { p.blend = (e.target as HTMLSelectElement).value as BrushPreset["blend"]; drawPreview(); } }, h("option", { value: "normal", selected: p.blend === "normal" }, "normal"), h("option", { value: "multiply", selected: p.blend === "multiply" }, "multiply"))),
      (p.kind === "smudge" || p.kind === "blur") ? field("Strength", slider(0.05, 1, 0.01, p.smudgeStrength, (v) => (p.smudgeStrength = v)), () => `${Math.round(p.smudgeStrength * 100)}%`) : null,
    );
    const family = h("div", {}, h("div", { class: "sep" }), h("h3", {}, "Tip & media"),
      field("Tip shape", h("select", { onChange: (e: Event) => { p.tipShape = (e.target as HTMLSelectElement).value as TipShape; drawPreview(); render(); } }, ...(["round", "flat", "bristle", "custom", "sponge"] as const).map((v) => h("option", { value: v, selected: p.tipShape === v }, v)))),
      p.tipShape === "sponge" ? field("Sponge", h("select", { onChange: (e: Event) => { p.spongeKind = (e.target as HTMLSelectElement).value as SpongeKind; drawPreview(); } }, ...(["natural", "sea", "stipple", "synthetic"] as const).map((v) => h("option", { value: v, selected: p.spongeKind === v }, v)))) : null,
      p.tipShape === "sponge" ? field("Spin per dab", h("input", { type: "checkbox", checked: p.spinTip, onChange: (e: Event) => { p.spinTip = (e.target as HTMLInputElement).checked; drawPreview(); } })) : null,
      p.tipShape === "flat" ? field("Tip angle", slider(0, 180, 1, p.tipAngleDeg, (v) => { p.tipAngleDeg = v; drawPreview(); }), () => `${p.tipAngleDeg}°`) : null,
      p.tipShape === "custom" ? h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", margin: "4px 0" } },
        h("label", { class: "btn", style: { cursor: "pointer" } }, "Import tip PNG", h("input", { type: "file", accept: "image/png,image/webp,image/jpeg", style: { display: "none" }, onChange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => { p.tipImage = String(r.result); saveTip(f.name, p.tipImage); drawPreview(); render(); }; r.readAsDataURL(f); } })),
        ...loadTips().map((t) => h("img", { src: t.data, title: t.name, width: 28, height: 28, style: { border: p.tipImage === t.data ? "1px solid var(--accent)" : "1px solid var(--obsidian-border-dim)", background: "#fff", cursor: "pointer", borderRadius: "3px" }, onClick: () => { p.tipImage = t.data; drawPreview(); render(); } })),
        p.tipImage ? field("Follows stroke", h("input", { type: "checkbox", checked: p.tipImageFollow, onChange: (e: Event) => { p.tipImageFollow = (e.target as HTMLInputElement).checked; drawPreview(); } })) : h("span", { class: "dim", style: { fontSize: "11px" } }, "PNG with alpha, or black ink on white")) : null,
      p.tipShape === "flat" ? field("Nib follows", h("select", { onChange: (e: Event) => { p.tipFollow = (e.target as HTMLSelectElement).value === "yes"; drawPreview(); } }, h("option", { value: "no", selected: !p.tipFollow }, "fixed angle (chisel)"), h("option", { value: "yes", selected: p.tipFollow }, "stroke direction (ribbon)"))) : null,
      p.tipShape === "flat" ? field("Tip ratio", slider(0.08, 1, 0.01, p.tipRatio, (v) => { p.tipRatio = v; drawPreview(); }), () => p.tipRatio.toFixed(2)) : null,
      p.tipShape === "bristle" ? field("Bristles", slider(3, 48, 1, p.bristles, (v) => { p.bristles = v; drawPreview(); }), () => String(p.bristles)) : null,
      p.tipShape === "bristle" ? field("Spread", slider(0.2, 1.2, 0.01, p.bristleSpread, (v) => { p.bristleSpread = v; drawPreview(); }), () => p.bristleSpread.toFixed(2)) : null,
      h("div", { class: "sep" }), h("h3", {}, "Natural media"),
      field("Media", h("select", { onChange: (e: Event) => { p.media = (e.target as HTMLSelectElement).value as Media; if (p.media !== "water") p.wetEffect = "none"; drawPreview(); render(); } }, ...([["none", "none (digital)"], ["water", "watercolour (wet simulation)"], ["acrylic", "acrylic (body + relief)"]] as const).map(([v, l]) => h("option", { value: v, selected: p.media === v }, l)))),
      ...(p.media === "water" ? (() => { const wv = (k: keyof typeof WET_DEFAULT) => p.wet[k] ?? WET_DEFAULT[k]; const set = (k: keyof typeof WET_DEFAULT, v: number) => { p.wet = { ...p.wet, [k]: v }; drawPreview(); }; return [
        field("Effect", h("select", { onChange: (e: Event) => { p.wetEffect = (e.target as HTMLSelectElement).value as WetEffect; drawPreview(); render(); } }, ...([["none", "paint"], ["salt", "salt"], ["alcohol", "rubbing alcohol"], ["sand", "sandpaper"]] as const).map(([v, l]) => h("option", { value: v, selected: p.wetEffect === v }, l)))),
        field("Water amount", slider(0, 1, 0.01, wv("water"), (v) => set("water", v)), () => `${Math.round(wv("water") * 100)}%`),
        field("Pigment", slider(0, 1, 0.01, wv("pigment"), (v) => set("pigment", v)), () => `${Math.round(wv("pigment") * 100)}%`),
        field("Wet spread", slider(0, 1, 0.01, wv("diffusion"), (v) => set("diffusion", v)), () => `${Math.round(wv("diffusion") * 100)}%`),
        field("Edge darkening", slider(0, 1, 0.01, wv("edgeDark"), (v) => set("edgeDark", v)), () => `${Math.round(wv("edgeDark") * 100)}%`),
        field("Granulation", slider(0, 1, 0.01, wv("granulation"), (v) => set("granulation", v)), () => `${Math.round(wv("granulation") * 100)}%`),
        field("Bloom", slider(0, 1, 0.01, wv("bloom"), (v) => set("bloom", v)), () => `${Math.round(wv("bloom") * 100)}%`),
        field("Lift", slider(0, 1, 0.01, wv("lift"), (v) => set("lift", v)), () => `${Math.round(wv("lift") * 100)}%`),
        field("Dry time", slider(0.5, 30, 0.5, wv("dryTime"), (v) => set("dryTime", v)), () => `${wv("dryTime").toFixed(1)} s`),
        field("Pigment strength", slider(0.5, 6, 0.1, wv("absorb"), (v) => set("absorb", v)), () => wv("absorb").toFixed(1)),
        h("div", { class: "row", style: { gap: "6px", alignItems: "center", margin: "4px 0" } }, h("button", { class: "btn", title: "Fix every wash on the active layer now", onClick: () => { if (dryLayer(app.doc.activeLayer)) { app.invalidate(); } render(); } }, "Dry layer now"), h("span", { class: "dim", style: { fontSize: "11px" } }, layerWet(app.doc.activeLayer) ? "active layer: still wet" : "active layer: dry")),
      ]; })() : []),
      ...(p.media === "acrylic" ? (() => { const bv = (k: keyof typeof BODY_DEFAULT) => p.body[k] ?? BODY_DEFAULT[k]; const set = (k: keyof typeof BODY_DEFAULT, v: number) => { p.body = { ...p.body, [k]: v }; drawPreview(); }; return [
        field("Body (impasto)", slider(0, 1, 0.01, bv("body"), (v) => set("body", v)), () => `${Math.round(bv("body") * 100)}%`),
        field("Relief light", slider(0, 1, 0.01, bv("relief"), (v) => set("relief", v)), () => `${Math.round(bv("relief") * 100)}%`),
        field("Gloss", slider(0, 1, 0.01, bv("gloss"), (v) => set("gloss", v)), () => `${Math.round(bv("gloss") * 100)}%`),
        field("Open time", slider(0, 120, 1, bv("open"), (v) => set("open", v)), () => `${bv("open")} s`),
        field("Mix open only", h("input", { type: "checkbox", checked: p.mixOpen, onChange: (e: Event) => { p.mixOpen = (e.target as HTMLInputElement).checked; drawPreview(); } })),
        field("Scrape body", h("input", { type: "checkbox", checked: p.scrape, onChange: (e: Event) => { p.scrape = (e.target as HTMLInputElement).checked; drawPreview(); } })),
      ]; })() : []),
      h("div", { class: "sep" }), h("h3", {}, "Dual brush"),
      field("Dual", h("input", { type: "checkbox", checked: p.dual, onChange: (e: Event) => { p.dual = (e.target as HTMLInputElement).checked; drawPreview(); render(); } })),
      p.dual ? field("Second tip", h("select", { onChange: (e: Event) => { p.dualShape = (e.target as HTMLSelectElement).value as TipShape; drawPreview(); render(); } }, ...(["round", "flat", "bristle", "custom"] as const).map((v) => h("option", { value: v, selected: p.dualShape === v }, v)))) : null,
      p.dual && p.dualShape === "custom" ? h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", margin: "4px 0" } }, ...loadTips().map((t) => h("img", { src: t.data, title: t.name, width: 28, height: 28, style: { border: p.dualImage === t.data ? "1px solid var(--accent)" : "1px solid var(--obsidian-border-dim)", background: "#fff", cursor: "pointer", borderRadius: "3px" }, onClick: () => { p.dualImage = t.data; drawPreview(); render(); } }))) : null,
      p.dual ? field("Dual size", slider(0.3, 3, 0.05, p.dualRatio, (v) => { p.dualRatio = v; drawPreview(); }), () => `${p.dualRatio.toFixed(2)}x`) : null,
      p.dual ? field("Spin per dab", h("input", { type: "checkbox", checked: p.dualRotate, onChange: (e: Event) => { p.dualRotate = (e.target as HTMLInputElement).checked; drawPreview(); } })) : null,
      field("Wet mix", slider(0, 1, 0.01, p.mix, (v) => { p.mix = v; drawPreview(); }), () => `${Math.round(p.mix * 100)}%`),
      field("Wet edge", slider(0, 1, 0.01, p.wetEdge, (v) => { p.wetEdge = v; drawPreview(); }), () => `${Math.round(p.wetEdge * 100)}%`),
      field("Edge noise", slider(0, 1, 0.01, p.sizeNoise, (v) => { p.sizeNoise = v; drawPreview(); }), () => `${Math.round(p.sizeNoise * 100)}%`),
      field("Deposit noise", slider(0, 1, 0.01, p.flowNoise, (v) => { p.flowNoise = v; drawPreview(); }), () => `${Math.round(p.flowNoise * 100)}%`),
      field("Opacity by press.", slider(0, 1, 0.01, p.opacityByPressure, (v) => { p.opacityByPressure = v; drawPreview(); }), () => `${Math.round(p.opacityByPressure * 100)}%`),
      p.tipShape === "round" ? field("Nib flex", slider(0, 1, 0.01, p.nibFlex, (v) => { p.nibFlex = v; drawPreview(); render(); }), () => `${Math.round(p.nibFlex * 100)}%`) : null,
      p.tipShape === "round" && p.nibFlex > 0 ? field("Nib angle", slider(0, 180, 1, p.nibAngleDeg, (v) => { p.nibAngleDeg = v; drawPreview(); }), () => `${p.nibAngleDeg}°`) : null,
      field("Ink load", slider(0, 4000, 50, p.inkLoad, (v) => { p.inkLoad = v; drawPreview(); }), () => (p.inkLoad ? `${p.inkLoad} px` : "never dry")),
      p.inkLoad > 0 ? field("Dry floor", slider(0, 1, 0.01, p.inkMin, (v) => { p.inkMin = v; drawPreview(); }), () => `${Math.round(p.inkMin * 100)}%`) : null,
      field("Soft when light", slider(0, 1, 0.01, p.hardnessByPressure, (v) => { p.hardnessByPressure = v; drawPreview(); }), () => `${Math.round(p.hardnessByPressure * 100)}%`),
      field("Pooling", slider(0, 1, 0.01, p.pooling, (v) => { p.pooling = v; drawPreview(); }), () => `${Math.round(p.pooling * 100)}%`),
      field("Tilt size", slider(0, 1, 0.01, p.tiltSize, (v) => { p.tiltSize = v; drawPreview(); }), () => `${Math.round(p.tiltSize * 100)}%`),
      field("Tilt flow", slider(0, 1, 0.01, p.tiltFlow, (v) => { p.tiltFlow = v; drawPreview(); }), () => `${Math.round(p.tiltFlow * 100)}%`),
      field("Scatter", slider(0, 1, 0.01, p.scatter, (v) => { p.scatter = v; drawPreview(); }), () => `${Math.round(p.scatter * 100)}%`),
      p.scatter > 0 ? field("Droplets", slider(1, 60, 1, p.scatterCount, (v) => { p.scatterCount = v; drawPreview(); }), () => String(p.scatterCount)) : null,
      field("Mouse press.", h("select", { onChange: (e: Event) => { app.mousePressure = (e.target as HTMLSelectElement).value as "fixed" | "speed"; } }, h("option", { value: "speed", selected: app.mousePressure === "speed" }, "from speed"), h("option", { value: "fixed", selected: app.mousePressure === "fixed" }, "fixed 0.55"))),
    );
    const selOpts = (app.tool === "select" || app.tool === "wand" || app.tool === "move") ? h("div", {}, h("div", { class: "sep" }), h("h3", {}, app.tool === "wand" ? "Magic wand (W)" : app.tool === "move" ? "Move / transform (T)" : "Select (M)"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, app.tool === "move" ? "Drag inside to move, corner handles scale (Shift keeps ratio), the top knob rotates (Shift snaps 15°). Enter commits, Esc cancels. Painting and fills are clipped to the selection." : "Shift adds, Alt subtracts, Shift+Alt intersects. Ctrl+A all, Ctrl+D deselect, Ctrl+Shift+I invert, Delete clears, Ctrl+C/X/V copy, cut, paste to a new layer."),
      app.tool === "select" ? field("Shape", h("select", { onChange: (e: Event) => { app.selShape = (e.target as HTMLSelectElement).value as typeof app.selShape; app.emit("tool"); } }, ...(["rect", "ellipse", "lasso", "poly", "magnetic"] as const).map((v) => h("option", { value: v, selected: app.selShape === v }, v === "poly" ? "polygon (click, Enter)" : v === "magnetic" ? "magnetic lasso (snaps to edges)" : v)))) : null,
      app.tool === "select" && app.selShape === "magnetic" ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, "Click or drag along the object: the line snaps to the nearest edge on the visible page. Click to pin an anchor, Backspace removes the last one, Enter or a click on the first anchor closes, Esc cancels.") : null,
      app.selection && !app.floating ? h("div", { id: "tighten-row", class: "row", style: { gap: "6px", alignItems: "center", margin: "4px 0", flexWrap: "wrap" } },
        h("button", { title: "Tighten selection", "data-help": "Pull a rough selection onto the object's edges: colours inside vs outside decide where the boundary goes, within the band below. Run it twice for a stubborn edge; add or subtract by hand where object and background share a colour.", onClick: () => { const r = app.select?.tighten(app.tightenBand); app.tightenNote = r ?? ""; render(); } }, "Tighten to edges"),
        app.tightenNote ? h("span", { class: "dim", style: { fontSize: "11px" } }, app.tightenNote) : null,
        field("Search band", slider(0, 60, 2, app.tightenBand, (v) => (app.tightenBand = v)), () => (app.tightenBand ? `${app.tightenBand} px` : "auto"))) : null,
      field("Mode", h("select", { onChange: (e: Event) => (app.selMode = (e.target as HTMLSelectElement).value as typeof app.selMode) }, ...(["replace", "add", "subtract", "intersect"] as const).map((v) => h("option", { value: v, selected: app.selMode === v }, v)))),
      app.tool === "wand" ? field("Tolerance", slider(0, 0.6, 0.01, app.wandTolerance, (v) => (app.wandTolerance = v)), () => `${Math.round(app.wandTolerance * 100)}%`) : null,
      app.tool === "wand" ? field("Region", h("select", { onChange: (e: Event) => (app.wandContiguous = (e.target as HTMLSelectElement).value === "contiguous") }, h("option", { value: "contiguous", selected: app.wandContiguous }, "contiguous"), h("option", { value: "global", selected: !app.wandContiguous }, "all matching"))) : null,
      app.tool === "wand" ? field("Reference", h("select", { onChange: (e: Event) => (app.wandReference = (e.target as HTMLSelectElement).value as "all" | "current") }, h("option", { value: "all", selected: app.wandReference === "all" }, "all layers"), h("option", { value: "current", selected: app.wandReference === "current" }, "current layer"))) : null,
      h("div", { class: "row", style: { gap: "6px", marginTop: "6px", flexWrap: "wrap" } },
        h("button", { title: "Select all", "data-keys": "Ctrl + A", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true })) }, "All"),
        h("button", { title: "Deselect", "data-keys": "Ctrl + D", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", ctrlKey: true })) }, "None"),
        h("button", { title: "Invert selection", "data-keys": "Ctrl + Shift + I", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "i", ctrlKey: true, shiftKey: true })) }, "Invert"),
        h("button", { onClick: () => { if (app.selection) { const prev = app.selection; const next = prev.offset(2); app.selection = next; app.history.pushCustom("Grow selection", () => { app.selection = prev; app.emit("selection"); }, () => { app.selection = next; app.emit("selection"); }); app.emit("selection"); } } }, "Grow 2 px"),
        h("button", { onClick: () => { if (app.selection) { const prev = app.selection; const next = prev.offset(-2); app.selection = next.empty ? null : next; app.history.pushCustom("Shrink selection", () => { app.selection = prev; app.emit("selection"); }, () => { app.selection = next; app.emit("selection"); }); app.emit("selection"); } } }, "Shrink 2 px"),
        app.tool === "move" && app.floating ? h("button", { title: "Commit transform", "data-keys": "Enter", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })) }, "Commit") : null),
      h("div", { class: "kv", style: { marginTop: "6px" } }, h("span", {}, "selection"), h("b", { id: "sel-info" }, app.selection ? `${app.selection.bounds.x1 - app.selection.bounds.x0 + 1} × ${app.selection.bounds.y1 - app.selection.bounds.y0 + 1} px` : "none"))) : null;
    const sy = app.symmetry;
    const symOpts = h("div", {}, h("div", { class: "sep" }), h("h3", {}, "Symmetry"),
      h("div", { class: "segmented", style: { marginBottom: "6px" } }, ...(["none", "mirror", "radial"] as const).map((k) => h("button", { class: sy.kind === k ? "active" : "", onClick: () => { sy.kind = k; app.emit("symmetry"); app.emit("sel-preview"); render(); } }, k))),
      sy.kind === "mirror" ? field("Axis angle", slider(0, 180, 1, sy.angle, (v) => { sy.angle = v; app.emit("symmetry"); app.emit("sel-preview"); }), () => `${sy.angle}°`) : null,
      sy.kind === "radial" ? field("Copies", slider(2, 24, 1, sy.count, (v) => { sy.count = v; app.emit("symmetry"); app.emit("sel-preview"); }), () => String(sy.count)) : null,
      sy.kind === "radial" ? field("Mirror too", h("input", { type: "checkbox", checked: sy.mirrorRadial, onChange: (e: Event) => { sy.mirrorRadial = (e.target as HTMLInputElement).checked; app.emit("symmetry"); app.emit("sel-preview"); } })) : null,
      sy.kind !== "none" ? h("div", { class: "row", style: { gap: "6px", marginTop: "4px" } }, h("button", { onClick: () => { sy.cx = app.doc.width / 2; sy.cy = app.doc.height / 2; app.emit("symmetry"); app.emit("sel-preview"); } }, "Centre on page"), h("span", { class: "dim", style: { fontSize: "11px" } }, "Alt-click with the ruler tool moves the centre")) : null);
    const rulerOpts = app.tool === "ruler" || app.ruler.kind !== "none" ? h("div", {}, h("div", { class: "sep" }), h("h3", {}, "Ruler (U)"),
      h("div", { class: "segmented", style: { marginBottom: "6px" } }, ...(["auto", "curve", "ellipse"] as const).map((k) => h("button", { class: app.rulerPlace === k ? "active" : "", title: k === "auto" ? "drag = line, click = vanishing point" : k === "curve" ? "click 2 to 4 points: line, quadratic, cubic" : "drag the bounding box (Shift tilts 30°)", onClick: () => { app.rulerPlace = k; if (k === "curve") { app.ruler.kind = "curve"; app.ruler.curve = []; } render(); } }, k === "auto" ? "line / perspective" : k))),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Line: drag. Perspective: click up to 3 vanishing points. Curve: click control points. Ellipse: drag a box. Strokes snap to the active ruler; Esc clears it while the ruler tool is active."),
      h("div", { class: "kv" }, h("span", {}, "active"), h("b", {}, app.ruler.kind === "none" ? "none" : app.ruler.kind === "line" ? `line ${Math.round(Math.atan2(app.ruler.b.y - app.ruler.a.y, app.ruler.b.x - app.ruler.a.x) * 180 / Math.PI)}°` : app.ruler.kind === "curve" ? `curve, ${app.ruler.curve.length} pts` : app.ruler.kind === "ellipse" ? "ellipse" : `${app.ruler.vps.length}-point perspective`)),
      h("div", { class: "row", style: { gap: "6px", marginTop: "6px" } }, h("button", { onClick: () => { app.ruler.kind = "none"; app.ruler.vps = []; app.emit("ruler"); app.emit("sel-preview"); render(); } }, "Clear ruler"),
        h("button", { onClick: () => { app.ruler.kind = "line"; app.ruler.a = { x: 0, y: 0 }; app.ruler.b = { x: 1, y: 0 }; app.emit("ruler"); app.emit("sel-preview"); render(); } }, "Horizontal"),
        h("button", { onClick: () => { app.ruler.kind = "line"; app.ruler.a = { x: 0, y: 0 }; app.ruler.b = { x: 0, y: 1 }; app.emit("ruler"); app.emit("sel-preview"); render(); } }, "Vertical"))) : null;
    const gradOpts = app.tool === "gradient" ? h("div", {}, h("div", { class: "sep" }), h("h3", {}, "Gradient (D)"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Drag across the page: start colour at the press, end at the release. Fills the selection, or the whole layer when nothing is selected. Vertical gradients over a long canvas read as scene transitions in webtoons."),
      field("Shape", h("select", { onChange: (e: Event) => (app.gradientShape = (e.target as HTMLSelectElement).value as "linear" | "radial") }, h("option", { value: "linear", selected: app.gradientShape === "linear" }, "linear"), h("option", { value: "radial", selected: app.gradientShape === "radial" }, "radial"))),
      field("Ends at", h("select", { onChange: (e: Event) => { app.gradientEnd = (e.target as HTMLSelectElement).value as "transparent" | "color2"; render(); } }, h("option", { value: "transparent", selected: app.gradientEnd === "transparent" }, "transparent"), h("option", { value: "color2", selected: app.gradientEnd === "color2" }, "second colour"))),
      app.gradientEnd === "color2" ? field("Second colour", h("input", { type: "color", value: app.color2, onInput: (e: Event) => (app.color2 = (e.target as HTMLInputElement).value) })) : null) : null;
    const fillOpts = app.tool === "fill" ? h("div", {}, h("div", { class: "sep" }), h("h3", {}, "Fill (G)"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Click to flood an area. Drag to draw an enclosure and fill it on release. Expand tucks the fill under anti-aliased ink."),
      field("Mode", h("select", { onChange: (e: Event) => (app.fillMode = (e.target as HTMLSelectElement).value as "contiguous" | "global") }, h("option", { value: "contiguous", selected: app.fillMode === "contiguous" }, "contiguous"), h("option", { value: "global", selected: app.fillMode === "global" }, "global (same colour everywhere)"))),
      field("Reference", h("select", { onChange: (e: Event) => (app.fillReference = (e.target as HTMLSelectElement).value as "all" | "current") }, h("option", { value: "all", selected: app.fillReference === "all" }, "all visible layers"), h("option", { value: "current", selected: app.fillReference === "current" }, "current layer only"))),
      field("Tolerance", slider(0, 0.6, 0.01, app.fillTolerance, (v) => (app.fillTolerance = v)), () => `${Math.round(app.fillTolerance * 100)}%`),
      field("Expand", slider(0, 8, 1, app.fillExpand, (v) => (app.fillExpand = v)), () => `${app.fillExpand} px`),
      field("Close gaps", slider(0, 24, 1, app.fillCloseGap, (v) => (app.fillCloseGap = v)), () => `${app.fillCloseGap} px`),
      field("Auto close", h("select", { onChange: (e: Event) => { app.fillAutoClose = (e.target as HTMLSelectElement).value === "on"; render(); } }, h("option", { value: "on", selected: app.fillAutoClose }, "widen until enclosed"), h("option", { value: "off", selected: !app.fillAutoClose }, "off"))),
      app.fillAutoClose ? field("Max auto gap", slider(4, 160, 2, app.fillMaxAutoGap, (v) => (app.fillMaxAutoGap = v)), () => `${app.fillMaxAutoGap} px`) : null,
      field("Stop leaks", h("select", { onChange: (e: Event) => (app.fillStopLeaks = (e.target as HTMLSelectElement).value === "on") }, h("option", { value: "on", selected: app.fillStopLeaks }, "refuse to flood the page"), h("option", { value: "off", selected: !app.fillStopLeaks }, "fill anyway"))),
      h("div", { class: "notice mono", style: { fontSize: "11px", marginTop: "6px", minHeight: "14px" }, id: "fill-msg" }, app.fillMessage),
      field("Anti-alias", h("input", { type: "checkbox", checked: app.fillAntialias, onChange: (e: Event) => (app.fillAntialias = (e.target as HTMLInputElement).checked) })),
      field("Lasso fill", h("input", { type: "checkbox", checked: app.fillLasso, onChange: (e: Event) => (app.fillLasso = (e.target as HTMLInputElement).checked) }))) : null;
    clear(root).append(
      h("h3", {}, `Brush · ${p.name}`), catBar, list,
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "0 0 6px", lineHeight: "1.35" } }, p.description),
      preview,
      h("div", { class: "row", style: { margin: "8px 0", alignItems: "flex-start" } },
        h("div", { class: "col" }, h("label", {}, "Pressure curve"), curveC, h("span", { class: "dim", style: { fontSize: "10px" } }, "drag the two handles")),
        h("div", { class: "col grow" }, h("label", {}, "Stroke strength"), meter, h("div", { class: "kv" },
          h("span", {}, "kind"), h("b", {}, p.kind), h("span", {}, "dabs / stroke"), h("b", { id: "dabs" }, "–"),
          h("span", {}, "edge"), h("b", {}, "AA ≥ 1 px"), h("span", {}, "buffer"), h("b", {}, p.kind === "smudge" || p.kind === "blur" ? "direct" : "flow → opacity")))),
      dyn, family, fillOpts, gradOpts, selOpts, rulerOpts, symOpts,
      h("div", { class: "sep" }),
      h("div", { class: "kv" }, h("span", {}, "shortcuts"), h("b", {}, "B brush · E eraser · G fill · [ ] size"), h("span", {}, "undo / redo"), h("b", {}, "Ctrl+Z · Ctrl+Shift+Z")),
    );
    drawPreview(); drawCurve();
  };
  app.on("brush", render); app.on("tool", render); app.on("ruler", render); app.on("selection", () => { const el = document.getElementById("sel-info"); if (el) el.textContent = app.selection ? `${app.selection.bounds.x1 - app.selection.bounds.x0 + 1} × ${app.selection.bounds.y1 - app.selection.bounds.y0 + 1} px` : "none"; const hasRow = !!document.getElementById("tighten-row"); if (["select", "wand", "move"].includes(app.tool) && hasRow !== (!!app.selection && !app.floating)) render(); else if (!el && app.tool === "move") render(); }); app.on("fill-message", () => { const el = document.getElementById("fill-msg"); if (el) el.textContent = app.fillMessage; }); app.on("color", () => { drawPreview(); });
  let statusQueued = false;
  app.on("status", () => {
    if (statusQueued || !root.isConnected || root.offsetParent === null) return; statusQueued = true;
    requestAnimationFrame(() => { statusQueued = false; (meter.firstElementChild as HTMLElement).style.width = `${Math.round(app.statusInput.pressure * 100)}%`; drawCurve(); const d = root.querySelector("#dabs"); if (d) d.textContent = String(app.activeStroke?.dabCount ?? 0); });
  });
  app.on("stroke-end", () => { (meter.firstElementChild as HTMLElement).style.width = "0%"; });
  render();
  return root;
}
