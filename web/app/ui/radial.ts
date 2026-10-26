/**
 * Radial menu for stylus/touch mode (Phase 5.2). Opens on long-press or
 * barrel button, 8 sectors, inner dead zone 24 px, outer 96 px, selection by
 * release angle: sector = floor((atan2 + π/8) / (π/4)) mod 8.
 */

import { h } from "./dom.js";
import type { AppState, Tool } from "./state.js";

interface Item { label: string; run: () => void }

export function radialMenu(host: HTMLElement, app: AppState): { open(x: number, y: number): void; close(): void; readonly isOpen: boolean } {
  const el = h("div", { id: "radial" });
  host.append(el);
  const items: Item[] = [
    { label: "Brush", run: () => app.setTool("brush") },
    { label: "Eraser", run: () => app.setTool("eraser") },
    { label: "Undo", run: () => { app.history.undo(app.doc); app.invalidate(app.history.lastRect ?? undefined); app.emit("layers"); } },
    { label: "Redo", run: () => { app.history.redo(app.doc); app.invalidate(app.history.lastRect ?? undefined); app.emit("layers"); } },
    { label: "Size −", run: () => { app.preset.size = Math.max(1, app.preset.size * 0.8); app.emit("brush"); } },
    { label: "Size +", run: () => { app.preset.size = Math.min(600, app.preset.size * 1.25); app.emit("brush"); } },
    { label: "Fit", run: () => { app.renderer.fitPage(app.doc); app.emit("view"); } },
    { label: "Onion", run: () => { app.doc.onionEnabled = !app.doc.onionEnabled; app.invalidate(); app.emit("timeline"); } },
  ];
  const R0 = 24, R1 = 96, C = 110;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 220 220");
  const paths: SVGPathElement[] = [];
  items.forEach((it, i) => {
    const a0 = (i - 0.5) * (Math.PI / 4), a1 = (i + 0.5) * (Math.PI / 4);
    const p = document.createElementNS(svgNS, "path");
    const P = (r: number, a: number) => `${C + r * Math.cos(a)} ${C + r * Math.sin(a)}`;
    p.setAttribute("d", `M ${P(R0, a0)} L ${P(R1, a0)} A ${R1} ${R1} 0 0 1 ${P(R1, a1)} L ${P(R0, a1)} A ${R0} ${R0} 0 0 0 ${P(R0, a0)} Z`);
    const t = document.createElementNS(svgNS, "text");
    const am = i * (Math.PI / 4), rm = (R0 + R1) / 2;
    t.setAttribute("x", String(C + rm * Math.cos(am))); t.setAttribute("y", String(C + rm * Math.sin(am)));
    t.textContent = it.label;
    svg.append(p, t); paths.push(p);
  });
  el.append(svg);
  let open = false, cx = 0, cy = 0, hot = -1;
  const sectorAt = (x: number, y: number) => {
    const dx = x - cx, dy = y - cy; if (Math.hypot(dx, dy) < R0) return -1;
    return Math.floor((Math.atan2(dy, dx) + Math.PI / 8 + Math.PI * 2) / (Math.PI / 4)) % 8;
  };
  const onMove = (e: PointerEvent) => { const s = sectorAt(e.clientX, e.clientY); if (s !== hot) { hot = s; paths.forEach((p, i) => p.classList.toggle("hot", i === s)); } };
  const onUp = (e: PointerEvent) => { const s = sectorAt(e.clientX, e.clientY); api.close(); if (s >= 0) items[s]!.run(); };
  const api = {
    get isOpen() { return open; },
    open(x: number, y: number) {
      const r = host.getBoundingClientRect();
      cx = x; cy = y; hot = -1; open = true;
      el.style.left = `${x - r.left - C}px`; el.style.top = `${y - r.top - C}px`; el.classList.add("open");
      window.addEventListener("pointermove", onMove); window.addEventListener("pointerup", onUp, { once: true });
    },
    close() { open = false; el.classList.remove("open"); window.removeEventListener("pointermove", onMove); paths.forEach((p) => p.classList.remove("hot")); },
  };
  return api;
}

/** Long-press / barrel-button trigger bound to the viewport canvas. */
export function bindRadialTriggers(canvas: HTMLCanvasElement, menu: ReturnType<typeof radialMenu>, app: AppState): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start = { x: 0, y: 0 };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "pen" && (e.buttons & 2)) { menu.open(e.clientX, e.clientY); e.preventDefault(); return; }
    if (e.pointerType !== "touch" || !app.compact) return;
    start = { x: e.clientX, y: e.clientY };
    timer = setTimeout(() => menu.open(start.x, start.y), 450);
  }, { capture: true });
  const cancel = (e: PointerEvent) => { if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 8) { clearTimeout(timer); timer = null; } };
  canvas.addEventListener("pointermove", cancel, { capture: true });
  canvas.addEventListener("pointerup", () => { if (timer) clearTimeout(timer); timer = null; }, { capture: true });
}

export const TOOL_LABELS: Record<Tool, string> = { brush: "Brush (B)", eraser: "Eraser (E)", vector: "Vector pen (V)", node: "Node edit (A)", fill: "Fill (G)", select: "Select (M)", wand: "Magic wand (W)", move: "Move / transform (T)", text: "Text & balloons (X)", fx: "Manga effects (F)", ruler: "Ruler / perspective (U)", gradient: "Gradient (D)", pan: "Pan (H)", zoom: "Zoom", rotate: "Rotate (R)", "panel-cut": "Panel cut (K)", eyedrop: "Eyedropper (I)" };
