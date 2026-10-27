/**
 * Color wheel v2 (Phase 5.3), designed for ink-and-color manga work.
 *
 * Geometry: an OKLCh hue ring (each hue at its maximum in-gamut chroma, L 0.72
 * so the ring is uniform in perceived brightness) around a HUE / WHITE / BLACK
 * triangle that rotates with the hue. Triangle interpolation happens in Oklab,
 * so moving the cursor changes perceived lightness and colorfulness linearly.
 *
 * Harmonies: complementary, analogous (±30°), triadic, split-complementary,
 * tetradic; rendered as ticks on the ring and as a swatch row.
 * Readouts: OKLCh, hex, sRGB / P3 / Rec.2020 / ACEScg, CMYK proof hex, gamut
 * clipping flag; L / C / H / alpha sliders for numeric control.
 */

import { hexFromLinear, linearFromHex, linearSrgbToOklab, maxChroma, oklabToLinearSrgb, oklabToOklch, oklchToOklab, proofHex, toDisplay, type Vec3 } from "../engine/color.js";
import { clear, h } from "./dom.js";
import type { AppState } from "./state.js";

type Harmony = "none" | "complementary" | "analogous" | "triadic" | "split" | "tetradic";
const HARMONIES: Record<Harmony, number[]> = { none: [], complementary: [180], analogous: [-30, 30], triadic: [120, 240], split: [150, 210], tetradic: [90, 180, 270] };

const PALETTES: Array<[string, string[]]> = [
  ["Ink", ["#141414", "#1c1a2e", "#2b2b2b", "#3d2b1f", "#8c8c8c", "#c9c9c9", "#ffffff"]],
  ["Skin", ["#f7e3d3", "#f1cdb3", "#e3b094", "#c98f6f", "#a86b4e", "#7a4a33", "#4f2e1f"]],
  ["Cel", ["#ffd8c2", "#e8a393", "#b35c6a", "#5b3a6b", "#2e86c1", "#7fc8e8", "#f1c40f"]],
  ["Night", ["#0b1026", "#1b2440", "#2f3d6b", "#4c5f9a", "#7b8fc9", "#b4c2ee", "#e6ecff"]],
];

export function colorWheel(app: AppState): HTMLElement {
  const root = h("div");
  const SIZE = 248, DPR = 2, PX = SIZE * DPR;
  const canvas = h("canvas", { width: PX, height: PX, style: { width: `${SIZE}px`, height: `${SIZE}px`, display: "block", cursor: "crosshair", border: "1px solid #3a3a3a" } }) as HTMLCanvasElement;
  const ctx = canvas.getContext("2d")!;
  const R = PX / 2, RING_W = 26 * DPR, R_IN = R - RING_W, TRI_R = R_IN - 10 * DPR;

  let hue = 25, L = 0.25, C = 0.0, alpha = 1;
  let harmony: Harmony = "none";
  let previous = app.color;
  let ringImg: ImageData | null = null;
  let triImg: ImageData | null = null;
  let triHue = -1;

  const fromApp = () => { const ok = oklabToOklch(linearSrgbToOklab(linearFromHex(app.color))); L = ok[0]; C = ok[1]; if (ok[1] > 0.012) hue = ok[2]; };
  fromApp();

  const hueLab = (hh: number): Vec3 => oklchToOklab([0.72, maxChroma(0.72, hh), hh]);
  const vivid = (hh: number): Vec3 => { // the triangle's hue apex: most colorful in-gamut sample of this hue
    let best: Vec3 = [0.5, 0, 0], bc = 0;
    for (let l = 0.3; l <= 0.9; l += 0.05) { const c = maxChroma(l, hh); if (c > bc) { bc = c; best = oklchToOklab([l, c, hh]); } }
    return best;
  };
  const triVerts = (hh: number) => {
    const a = (hh * Math.PI) / 180;
    const P = (ang: number) => ({ x: R + TRI_R * Math.cos(ang), y: R + TRI_R * Math.sin(ang) });
    return { hueP: P(a), whiteP: P(a + (2 * Math.PI) / 3), blackP: P(a - (2 * Math.PI) / 3) };
  };
  const bary = (px: number, py: number, hh: number) => {
    const { hueP, whiteP, blackP } = triVerts(hh);
    const det = (whiteP.y - blackP.y) * (hueP.x - blackP.x) + (blackP.x - whiteP.x) * (hueP.y - blackP.y);
    const wH = ((whiteP.y - blackP.y) * (px - blackP.x) + (blackP.x - whiteP.x) * (py - blackP.y)) / det;
    const wW = ((blackP.y - hueP.y) * (px - blackP.x) + (hueP.x - blackP.x) * (py - blackP.y)) / det;
    return { wH, wW, wK: 1 - wH - wW };
  };

  const renderRing = () => {
    const img = ctx.createImageData(PX, PX); const d = img.data;
    const cache = new Map<number, Vec3>();
    for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
      const dx = x - R + 0.5, dy = y - R + 0.5, r = Math.hypot(dx, dy);
      if (r > R || r < R_IN) continue;
      const hh = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360);
      let lin = cache.get(hh); if (!lin) { lin = oklabToLinearSrgb(hueLab(hh)); cache.set(hh, lin); }
      const edge = Math.min(1, Math.min(R - r, r - R_IN) / 1.5); // anti-aliased ring edges
      const i = (y * PX + x) * 4;
      d[i] = Math.round(255 * srgb(lin[0])); d[i + 1] = Math.round(255 * srgb(lin[1])); d[i + 2] = Math.round(255 * srgb(lin[2])); d[i + 3] = Math.round(255 * edge);
    }
    ringImg = img;
  };
  const renderTriangle = () => {
    if (triHue === hue && triImg) return;
    triHue = hue;
    const img = ctx.createImageData(PX, PX); const d = img.data;
    const apex = vivid(hue);
    const { hueP, whiteP, blackP } = triVerts(hue);
    const minX = Math.floor(Math.min(hueP.x, whiteP.x, blackP.x)), maxX = Math.ceil(Math.max(hueP.x, whiteP.x, blackP.x));
    const minY = Math.floor(Math.min(hueP.y, whiteP.y, blackP.y)), maxY = Math.ceil(Math.max(hueP.y, whiteP.y, blackP.y));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const { wH, wW, wK } = bary(x + 0.5, y + 0.5, hue);
      const m = Math.min(wH, wW, wK);
      if (m < -0.006) continue;
      const lab: Vec3 = [wH * apex[0] + wW * 1, wH * apex[1], wH * apex[2]];
      void wK;
      const lin = oklabToLinearSrgb(lab).map((c) => Math.max(0, Math.min(1, c))) as Vec3;
      const cov = Math.min(1, (m + 0.006) / 0.006);
      const hex = app.proofCmyk ? proofHex(hexFromLinear(lin)) : null;
      const i = (y * PX + x) * 4;
      if (hex) { const n = parseInt(hex.slice(1), 16); d[i] = (n >> 16) & 255; d[i + 1] = (n >> 8) & 255; d[i + 2] = n & 255; }
      else { d[i] = Math.round(255 * srgb(lin[0])); d[i + 1] = Math.round(255 * srgb(lin[1])); d[i + 2] = Math.round(255 * srgb(lin[2])); }
      d[i + 3] = Math.round(255 * cov);
    }
    triImg = img;
  };
  const draw = () => {
    if (!ringImg) renderRing();
    renderTriangle();
    ctx.clearRect(0, 0, PX, PX);
    ctx.fillStyle = "#161616"; ctx.fillRect(0, 0, PX, PX);
    ctx.putImageData(ringImg!, 0, 0);
    // triangle via temp (putImageData ignores alpha compositing against the bg otherwise)
    const tmp = document.createElement("canvas"); tmp.width = PX; tmp.height = PX; tmp.getContext("2d")!.putImageData(triImg!, 0, 0); ctx.drawImage(tmp, 0, 0);
    // harmony ticks
    ctx.lineWidth = 2 * DPR; ctx.strokeStyle = "#e6e6e6";
    for (const off of HARMONIES[harmony]) {
      const a = (((hue + off) % 360) * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(R + (R_IN + 2) * Math.cos(a), R + (R_IN + 2) * Math.sin(a)); ctx.lineTo(R + (R - 2) * Math.cos(a), R + (R - 2) * Math.sin(a)); ctx.stroke();
    }
    // hue marker
    const ha = (hue * Math.PI) / 180;
    ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2 * DPR;
    ctx.beginPath(); ctx.arc(R + (R - RING_W / 2) * Math.cos(ha), R + (R - RING_W / 2) * Math.sin(ha), 6 * DPR, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = "#000"; ctx.lineWidth = 1 * DPR; ctx.beginPath(); ctx.arc(R + (R - RING_W / 2) * Math.cos(ha), R + (R - RING_W / 2) * Math.sin(ha), 7.5 * DPR, 0, Math.PI * 2); ctx.stroke();
    // current colour marker inside triangle: invert the Oklab mix
    const pt = colorToTri();
    if (pt) {
      ctx.strokeStyle = L > 0.6 ? "#000" : "#fff"; ctx.lineWidth = 1.5 * DPR;
      ctx.beginPath(); ctx.arc(pt.x, pt.y, 5 * DPR, 0, Math.PI * 2); ctx.stroke();
    }
  };
  const srgb = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

  /** Find triangle weights reproducing the current (L, C): wH from chroma ratio, wW from lightness. */
  const colorToTri = () => {
    const apex = vivid(hue);
    const apexC = Math.hypot(apex[1], apex[2]);
    const wH = apexC > 0 ? Math.max(0, Math.min(1, C / apexC)) : 0;
    const wW = Math.max(0, Math.min(1 - wH, L - wH * apex[0]));
    const wK = 1 - wH - wW;
    const { hueP, whiteP, blackP } = triVerts(hue);
    return { x: wH * hueP.x + wW * whiteP.x + wK * blackP.x, y: wH * hueP.y + wW * whiteP.y + wK * blackP.y };
  };

  const applyLCH = () => {
    const cMax = maxChroma(L, hue, "srgb");
    const lin = oklabToLinearSrgb(oklchToOklab([L, Math.min(C, cMax), hue]));
    app.setColor(hexFromLinear(lin));
  };

  let drag: "ring" | "tri" | null = null;
  const onPick = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * PX, y = ((e.clientY - r.top) / r.height) * PX;
    const dist = Math.hypot(x - R, y - R);
    if (drag === null) drag = dist >= R_IN - 4 * DPR ? "ring" : "tri";
    if (drag === "ring") { hue = ((Math.atan2(y - R, x - R) * 180) / Math.PI + 360) % 360; applyLCH(); }
    else {
      let { wH, wW, wK } = bary(x, y, hue);
      wH = Math.max(0, wH); wW = Math.max(0, wW); wK = Math.max(0, wK);
      const sum = wH + wW + wK || 1; wH /= sum; wW /= sum;
      const apex = vivid(hue);
      const lab: Vec3 = [wH * apex[0] + wW, wH * apex[1], wH * apex[2]];
      const ok = oklabToOklch(lab); L = ok[0]; C = ok[1];
      app.setColor(hexFromLinear(oklabToLinearSrgb(lab).map((c) => Math.max(0, Math.min(1, c))) as Vec3));
    }
    draw(); renderReadout();
  };
  canvas.addEventListener("pointerdown", (e) => { try { canvas.setPointerCapture(e.pointerId); } catch { /* */ } drag = null; onPick(e); });
  canvas.addEventListener("pointermove", (e) => { if (drag) onPick(e); });
  canvas.addEventListener("pointerup", () => (drag = null));

  // ---- controls ----
  const mkSlider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt: (v: number) => string) => {
    const inp = h("input", { type: "range", min, max, step, value: get() }) as HTMLInputElement;
    const val = h("span", { class: "val" }, fmt(get()));
    inp.addEventListener("input", () => { set(Number(inp.value)); val.textContent = fmt(get()); });
    return { row: h("div", { class: "field" }, h("label", {}, label), inp, val), inp, val };
  };
  const sL = mkSlider("L", 0, 1, 0.001, () => L, (v) => { L = v; applyLCH(); draw(); renderReadout(); }, (v) => v.toFixed(2));
  const sC = mkSlider("C", 0, 0.37, 0.001, () => C, (v) => { C = v; applyLCH(); draw(); renderReadout(); }, (v) => v.toFixed(3));
  const sH = mkSlider("H", 0, 360, 0.5, () => hue, (v) => { hue = v; applyLCH(); draw(); renderReadout(); }, (v) => `${v.toFixed(0)}°`);
  const sA = mkSlider("Alpha", 0, 1, 0.01, () => alpha, (v) => { alpha = v; app.preset.opacity = v; app.emit("brush"); }, (v) => `${Math.round(v * 100)}%`);
  const hexIn = h("input", { type: "text", class: "mono", value: app.color, style: { width: "80px", flex: "none" } }) as HTMLInputElement;
  hexIn.addEventListener("change", () => { if (/^#[0-9a-f]{6}$/i.test(hexIn.value)) { app.setColor(hexIn.value.toLowerCase()); fromApp(); draw(); renderReadout(); } });
  const compare = h("div", { style: { display: "grid", gridTemplateColumns: "1fr 1fr", width: "56px", height: "28px", border: "1px solid #8c8c8c", flex: "none" } }, h("div", { title: "current" }), h("div", { title: "previous (click to restore)", style: { cursor: "pointer" }, onClick: () => { app.setColor(previous); fromApp(); draw(); renderReadout(); } }));
  const gamutSel = h("select", { onChange: (e: Event) => { app.gamut = (e.target as HTMLSelectElement).value as AppState["gamut"]; renderReadout(); } },
    ...(["srgb", "p3", "rec2020", "acescg"] as const).map((g) => h("option", { value: g, selected: g === app.gamut }, g === "srgb" ? "sRGB" : g === "p3" ? "Display P3" : g === "rec2020" ? "Rec. 2020" : "ACEScg")));
  const harmonySel = h("select", { onChange: (e: Event) => { harmony = (e.target as HTMLSelectElement).value as Harmony; draw(); renderHarmony(); } },
    ...(Object.keys(HARMONIES) as Harmony[]).map((k) => h("option", { value: k, selected: k === harmony }, k === "none" ? "harmony: none" : k)));
  const proof = h("input", { type: "checkbox", checked: app.proofCmyk, onChange: (e: Event) => { app.proofCmyk = (e.target as HTMLInputElement).checked; triHue = -1; app.invalidate(); draw(); renderReadout(); app.emit("proof"); } });
  const harmonyRow = h("div", { class: "swatches" });
  const readout = h("div", { class: "kv" });
  const recentRow = h("div", { class: "swatches" });
  const palettes = h("div");

  const renderHarmony = () => {
    clear(harmonyRow);
    const cols = [0, ...HARMONIES[harmony]].map((off) => { const hh = (hue + off + 360) % 360; return hexFromLinear(oklabToLinearSrgb(oklchToOklab([L, Math.min(C, maxChroma(L, hh)), hh]))); });
    cols.forEach((c, i) => harmonyRow.append(h("div", { class: i === 0 ? "active" : "", style: { background: c }, title: c, onClick: () => { app.setColor(c); fromApp(); draw(); renderReadout(); } })));
  };
  const renderReadout = () => {
    const lin = linearFromHex(app.color); const disp = toDisplay(lin, app.gamut);
    const sw = compare.firstElementChild as HTMLElement; sw.style.background = app.color; (compare.lastElementChild as HTMLElement).style.background = previous;
    hexIn.value = app.color;
    sL.inp.value = String(L); sL.val.textContent = L.toFixed(2); sC.inp.value = String(C); sC.val.textContent = C.toFixed(3); sH.inp.value = String(hue); sH.val.textContent = `${hue.toFixed(0)}°`;
    clear(readout).append(
      h("span", {}, "OKLCh"), h("b", {}, `${L.toFixed(3)} ${C.toFixed(3)} ${hue.toFixed(1)}°`),
      h("span", {}, "max C at L,H"), h("b", {}, maxChroma(L, hue).toFixed(3)),
      h("span", {}, app.gamut), h("b", {}, disp.rgb.map((c) => c.toFixed(3)).join(" ") + (disp.clipped ? "  CLIP" : "")),
      h("span", {}, "CMYK proof"), h("b", {}, proofHex(app.color)),
      h("span", {}, "ΔE to previous"), h("b", {}, deltaE(app.color, previous).toFixed(2)));
    renderHarmony();
    clear(recentRow); app.recent.forEach((c) => recentRow.append(h("div", { class: c === app.color ? "active" : "", style: { background: c }, title: c, onClick: () => { app.setColor(c); fromApp(); draw(); renderReadout(); } })));
  };
  const renderPalettes = () => {
    clear(palettes);
    for (const [name, cols] of PALETTES) palettes.append(h("div", { class: "row", style: { margin: "3px 0" } }, h("label", { style: { width: "40px" } }, name), h("div", { class: "swatches grow", style: { gridTemplateColumns: "repeat(7, 1fr)" } }, ...cols.map((c) => h("div", { style: { background: c }, title: c, onClick: () => { app.setColor(c); fromApp(); draw(); renderReadout(); } })))));
  };

  root.append(h("h3", {}, "Color"), canvas,
    h("div", { class: "row", style: { margin: "8px 0 4px" } }, compare, hexIn, harmonySel),
    sL.row, sC.row, sH.row, sA.row,
    h("div", { class: "row", style: { margin: "6px 0" } }, h("label", {}, "Gamut"), gamutSel, h("label", {}, "CMYK proof"), proof),
    h("label", {}, "Harmony set"), harmonyRow,
    h("label", { style: { display: "block", marginTop: "6px" } }, "Recent"), recentRow,
    h("div", { class: "sep" }), palettes, h("div", { class: "sep" }), readout);
  app.on("color", () => { if (!drag) { previous = previous === app.color ? previous : previous; fromApp(); draw(); } renderReadout(); });
  let lastColor = app.color;
  app.on("stroke-end", () => { if (lastColor !== app.color) { previous = lastColor; lastColor = app.color; } });
  renderPalettes(); renderReadout(); draw();
  return root;
}

/** Oklab Euclidean distance ×100 (perceptual ΔE-like). */
function deltaE(a: string, b: string): number {
  const A = linearSrgbToOklab(linearFromHex(a)), B = linearSrgbToOklab(linearFromHex(b));
  return 100 * Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]);
}
