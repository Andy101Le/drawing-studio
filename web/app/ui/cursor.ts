/**
 * Cursor system. Industry convention (Clip Studio, Photoshop, Procreate on desktop):
 *   - paint tools show the brush footprint: a ring of the current diameter in screen px,
 *     drawn in difference blend so it reads on black ink and white paper alike, with a
 *     1 px dot at the centre; below ~6 px the ring is replaced by a precision crosshair
 *   - the eraser ring is dashed, smudge/blur rings carry a small inner mark
 *   - every other tool is a 24 px SVG cursor with a light glyph on a dark outline and an
 *     explicit hotspot (bucket spout, eyedropper tip, pen nib, knife point)
 *   - Space held = open hand, dragging while panning = closed hand
 *   - outside the page the paint ring dims so the user sees the stroke will be clipped
 * All cursors are generated here as data URIs so no asset pipeline is needed.
 */
import type { AppState as App } from "./state.js";
import { h } from "./dom.js";

type Glyph = { path: string; hot: [number, number]; fill?: string };

const GLYPHS: Record<string, Glyph> = {
  // paint bucket, spout at the bottom-left; hotspot at the spout tip
  fill: { path: "M9 3 L20 9 L13 20 L2 14 Z M13 20 L15 23 M4 14 L2 20 Q1 23 3 23 Q5 23 5 20 Z", hot: [3, 22] },
  // eyedropper, tip at bottom-left
  eyedrop: { path: "M16 3 L21 8 L17 12 L12 7 Z M12 7 L5 14 L4 20 L10 19 L17 12 M19 2 L22 5 M7 14 L10 17", hot: [4, 20] },
  // pen nib, tip at bottom-left
  vector: { path: "M4 20 L14 10 L17 13 L7 23 Z M14 10 L18 2 L22 6 L17 13 M9 18 L4 20", hot: [4, 21] },
  // node arrow with a small square
  node: { path: "M3 3 L3 17 L7 13 L10 20 L13 19 L10 12 L15 12 Z M15 15 L21 15 L21 21 L15 21 Z", hot: [3, 3] },
  // crosshair with a blade for panel cutting
  "panel-cut": { path: "M12 2 L12 9 M12 15 L12 22 M2 12 L9 12 M15 12 L22 12 M12 12 L21 3 M19 3 L21 3 L21 5", hot: [12, 12] },
  // magnifier
  zoom: { path: "M10 3 A7 7 0 1 0 10 17 A7 7 0 1 0 10 3 Z M15 15 L22 22 M7 10 L13 10 M10 7 L10 13", hot: [10, 10] },
  // circular arrow
  rotate: { path: "M19 12 A7 7 0 1 1 12 5 M12 2 L16 5 L12 8", hot: [12, 12] },
  // open hand
  grab: { path: "M8 11 V5 Q8 3 10 3 Q12 3 12 5 V10 M12 5 Q12 3 14 3 Q16 3 16 5 V11 M16 7 Q16 5 18 5 Q20 5 20 7 V15 Q20 21 14 21 H12 Q8 21 6 17 L4 13 Q3 11 5 10 Q7 10 8 12", hot: [12, 12] },
  // closed hand
  grabbing: { path: "M7 12 V10 Q7 8 9 8 Q11 8 11 10 M11 9 Q11 7 13 7 Q15 7 15 9 M15 9 Q15 7 17 7 Q19 7 19 9 V15 Q19 21 14 21 H12 Q8 21 6 17 L5 14 Q4 12 6 12 Q7 12 7 13", hot: [12, 12] },
  // lasso (fill enclosure drag)
  lasso: { path: "M12 3 Q20 3 20 8 Q20 13 12 13 Q4 13 4 8 Q4 3 12 3 Z M8 12 Q6 16 9 18 Q7 20 8 23", hot: [8, 22] },
  // marquee: dashed square with crosshair centre
  marquee: { path: "M4 4 H8 M12 4 H16 M20 4 V8 M20 12 V16 M20 20 H16 M12 20 H8 M4 20 V16 M4 12 V8 M12 9 V15 M9 12 H15", hot: [12, 12] },
  // magic wand: star-tipped stick
  wand: { path: "M3 21 L13 11 M15 3 L16 7 L20 8 L16 9 L15 13 L14 9 L10 8 L14 7 Z", hot: [3, 21] },
  // move: four-way arrow
  move: { path: "M12 2 V22 M2 12 H22 M12 2 L9 5 M12 2 L15 5 M12 22 L9 19 M12 22 L15 19 M2 12 L5 9 M2 12 L5 15 M22 12 L19 9 M22 12 L19 15", hot: [12, 12] },
  // precision crosshair for very small brushes
  crosshair: { path: "M12 2 V9 M12 15 V22 M2 12 H9 M15 12 H22", hot: [12, 12] },
};

const cache = new Map<string, string>();
function svgCursor(name: string): string {
  const hit = cache.get(name); if (hit) return hit;
  const g = GLYPHS[name]!;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">` +
    `<path d="${g.path}" fill="${g.fill ?? "none"}" stroke="#000" stroke-width="3.2" stroke-linejoin="round" stroke-linecap="round" opacity=".85"/>` +
    `<path d="${g.path}" fill="${g.fill ?? "none"}" stroke="#f2f2f2" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
  const url = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") ${g.hot[0]} ${g.hot[1]}, crosshair`;
  cache.set(name, url); return url;
}

export interface CursorState { x: number; y: number; type: string; buttons?: number }

const HANDLE_CSS: Record<string, string> = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", body: "move", rot: "" };

export function installCursor(app: App, viewport: HTMLElement, canvas: HTMLCanvasElement, select?: { handleAt: (sx: number, sy: number) => string | null }): { update: (s: CursorState | null) => void } {
  // ring + centre dot, both in difference blend so they stay visible on any colour
  const ring = h("div", { style: { position: "absolute", left: "0", top: "0", pointerEvents: "none", borderRadius: "50%", display: "none", transform: "translate(-50%,-50%)", willChange: "transform", mixBlendMode: "difference", boxSizing: "border-box" } });
  const dot = h("div", { style: { position: "absolute", left: "0", top: "0", pointerEvents: "none", width: "3px", height: "3px", borderRadius: "50%", background: "#fff", display: "none", transform: "translate(-50%,-50%)", mixBlendMode: "difference" } });
  const mark = h("div", { style: { position: "absolute", left: "0", top: "0", pointerEvents: "none", display: "none", transform: "translate(-50%,-50%)", mixBlendMode: "difference", color: "#fff", font: "10px/1 monospace", letterSpacing: "0" } });
  viewport.append(ring, dot, mark);
  let last: CursorState | null = null;

  const hideRing = () => { ring.style.display = "none"; dot.style.display = "none"; mark.style.display = "none"; };

  // one layout read per frame at most: rects are cached until the window resizes or scrolls, and
  // hover updates are coalesced to the next animation frame (the ring is an overlay, not the stroke)
  let vpRect: DOMRect | null = null, cvRect: DOMRect | null = null;
  const rects = () => { if (!vpRect || !cvRect) { vpRect = viewport.getBoundingClientRect(); cvRect = canvas.getBoundingClientRect(); } return { r: vpRect, cr: cvRect }; };
  window.addEventListener("resize", () => { vpRect = cvRect = null; }); window.addEventListener("scroll", () => { vpRect = cvRect = null; }, true);
  let queued = false;
  const update = (s: CursorState | null) => { last = s; if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; apply(last); }); };
  const setCursor = (v: string) => { if (canvas.style.cursor !== v) canvas.style.cursor = v; };
  const apply = (s: CursorState | null) => {
    if (!s) { hideRing(); setCursor(""); return; }
    const { r, cr } = rects();
    const lx = s.x - r.left, ly = s.y - r.top;
    const tool = app.tool;
    const dragging = (s.buttons ?? 0) > 0;

    // navigation overrides
    if (app.spaceHeld || tool === "pan") { hideRing(); setCursor(svgCursor(dragging ? "grabbing" : "grab")); return; }
    if (tool === "zoom" || tool === "rotate" || tool === "eyedrop" || tool === "node" || tool === "panel-cut") { hideRing(); setCursor(svgCursor(tool)); return; }
    if (tool === "fill") { hideRing(); setCursor(svgCursor(dragging && app.fillLasso ? "lasso" : "fill")); return; }
    if (tool === "text") { hideRing(); setCursor("text"); return; }
    if (tool === "ruler" || tool === "gradient") { hideRing(); setCursor(svgCursor("crosshair")); return; }
    if (tool === "select") { hideRing(); setCursor(svgCursor(app.selShape === "lasso" || app.selShape === "magnetic" ? "lasso" : "marquee")); return; }
    if (tool === "wand") { hideRing(); setCursor(svgCursor("wand")); return; }
    if (tool === "move") {
      hideRing();
      const hd = select?.handleAt(s.x - cr.left, s.y - cr.top) ?? null;
      setCursor(hd === "rot" ? svgCursor("rotate") : hd ? HANDLE_CSS[hd]! : app.selection ? svgCursor("move") : "default");
      return;
    }
    if (s.type === "touch") { hideRing(); setCursor("none"); return; }

    // paint tools: footprint ring
    const kind = tool === "eraser" ? "eraser" : app.preset.kind;
    const d = app.preset.size * app.renderer.view.zoom;
    const p = app.renderer.screenToDoc(s.x - cr.left, s.y - cr.top);
    const onPage = p.x >= 0 && p.y >= 0 && p.x <= app.doc.width && p.y <= app.doc.height;
    if (tool === "vector") { hideRing(); setCursor(svgCursor("vector")); return; }
    if (d < 6) { hideRing(); setCursor(svgCursor("crosshair")); return; }
    setCursor("none");
    ring.style.display = "block"; ring.style.transform = `translate(${lx}px,${ly}px) translate(-50%,-50%)`;
    ring.style.width = `${d}px`; ring.style.height = `${d}px`;
    ring.style.opacity = onPage ? "1" : "0.35";
    ring.style.border = kind === "eraser" ? "1.5px dashed rgba(255,255,255,0.95)" : "1px solid rgba(255,255,255,0.95)";
    ring.style.outline = kind === "eraser" ? "none" : "1px solid rgba(0,0,0,0.35)";
    dot.style.display = d > 14 ? "block" : "none"; dot.style.transform = `translate(${lx}px,${ly}px) translate(-50%,-50%)`;
    // family mark inside the ring for the fx tools, so smudge and blur are distinguishable from paint
    if (kind === "smudge" || kind === "blur") { mark.style.display = "block"; mark.style.transform = `translate(${lx}px,${ly + Math.min(d / 2 + 9, 40)}px) translate(-50%,-50%)`; mark.textContent = kind === "smudge" ? "~" : "≈"; }
    else mark.style.display = "none";
  };

  app.on("hover", (p: unknown) => update(p as CursorState | null));
  app.on("brush", () => update(last)); app.on("tool", () => update(last)); app.on("view", () => update(last));
  app.on("space", () => update(last)); app.on("selection", () => update(last));
  app.on("layout", () => { vpRect = cvRect = null; update(last); }); app.on("dock", () => { vpRect = cvRect = null; }); app.on("mode", () => { vpRect = cvRect = null; });
  return { update };
}
