/**
 * Manga production objects: word balloons with lettering, page presets, panel layout
 * templates, and the vertical (tategaki) text layout Japanese manga uses.
 *
 * Balloons are document-level vector objects (not pixels): they are drawn above the
 * raster layers at composite time, export with the page, and stay editable. Shapes:
 *   speech   ellipse with a curved tail toward the speaker
 *   thought  bumpy cloud with a trail of small circles
 *   shout    jagged burst (spike count scales with size)
 *   whisper  dashed ellipse
 *   caption  rectangle (narration box)
 *   none     text only (sound effects / free lettering)
 */
import { newId, type Doc, type Panel } from "./document.js";

export type BalloonKind = "speech" | "thought" | "shout" | "whisper" | "caption" | "none";

export interface Balloon {
  id: number;
  kind: BalloonKind;
  x: number; y: number; w: number; h: number; // DU, bounding box of the shape
  tail: { x: number; y: number } | null;       // DU, tail tip (speaker position)
  text: string;
  font: string;      // CSS family
  size: number;      // DU
  lineHeight: number; // multiplier
  vertical: boolean; // tategaki: columns right to left
  bold: boolean;
  fill: string; stroke: string; strokeWidth: number; // DU
  textColor: string;
}

export function newBalloon(x: number, y: number, w: number, h: number, kind: BalloonKind, dpi: number): Balloon {
  return { id: newId(), kind, x, y, w, h, tail: kind === "speech" || kind === "thought" || kind === "shout" ? { x: x + w * 0.3, y: y + h + dpi * 0.35 } : null,
    text: "", font: "'Noto Sans JP', 'Yu Gothic', 'Hiragino Sans', 'Comic Neue', sans-serif", size: Math.round(dpi * 0.13), lineHeight: 1.35, vertical: false, bold: false,
    fill: "#ffffff", stroke: "#141414", strokeWidth: Math.max(1, Math.round(dpi * 0.012)), textColor: "#141414" };
}

/** Seeded hash so shout spikes and thought bumps are stable between frames. */
function noise(i: number, seed: number): number { let x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453; return x - Math.floor(x); }

export function balloonPath(b: Balloon): Path2D {
  const p = new Path2D();
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2, rx = b.w / 2, ry = b.h / 2;
  if (b.kind === "caption") { p.rect(b.x, b.y, b.w, b.h); return p; }
  if (b.kind === "none") return p;
  if (b.kind === "shout") {
    const n = Math.max(12, Math.round((b.w + b.h) / 60));
    for (let i = 0; i < n * 2; i++) {
      const a = (i / (n * 2)) * Math.PI * 2;
      const k = i % 2 === 0 ? 1 : 0.72 + noise(i, b.id) * 0.1;
      const x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      if (i === 0) p.moveTo(x, y); else p.lineTo(x, y);
    }
    p.closePath(); return p;
  }
  if (b.kind === "thought") {
    const n = Math.max(10, Math.round((b.w + b.h) / 90));
    let prev = { x: cx + rx, y: cy };
    p.moveTo(prev.x, prev.y);
    for (let i = 1; i <= n; i++) {
      const a = (i / n) * Math.PI * 2; const q = { x: cx + Math.cos(a) * rx, y: cy + Math.sin(a) * ry };
      const mx = (prev.x + q.x) / 2, my = (prev.y + q.y) / 2; const ma = Math.atan2(my - cy, mx - cx);
      const bulge = 0.16 * Math.min(rx, ry);
      p.quadraticCurveTo(mx + Math.cos(ma) * bulge * 2.2, my + Math.sin(ma) * bulge * 2.2, q.x, q.y);
      prev = q;
    }
    p.closePath(); return p;
  }
  // speech / whisper: ellipse, tail merged into the outline for speech
  if (b.kind === "speech" && b.tail) {
    const t = b.tail; const ang = Math.atan2((t.y - cy) / ry, (t.x - cx) / rx);
    const spread = 0.22;
    const a0 = ang - spread, a1 = ang + spread;
    const p0 = { x: cx + Math.cos(a0) * rx, y: cy + Math.sin(a0) * ry }, p1 = { x: cx + Math.cos(a1) * rx, y: cy + Math.sin(a1) * ry };
    p.ellipse(cx, cy, rx, ry, 0, a1, a0 + Math.PI * 2);
    // curved tail: control point pulled sideways so the tail bends like hand-drawn ones
    const mid = { x: (p0.x + t.x) / 2, y: (p0.y + t.y) / 2 }; const nx = -(t.y - p0.y), ny = t.x - p0.x; const nl = Math.hypot(nx, ny) || 1;
    p.quadraticCurveTo(mid.x + (nx / nl) * rx * 0.15, mid.y + (ny / nl) * rx * 0.15, t.x, t.y);
    p.lineTo(p1.x, p1.y);
    p.closePath(); return p;
  }
  p.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  return p;
}

/** thought-balloon trail: three shrinking circles toward the tail tip */
function thoughtTrail(ctx: CanvasRenderingContext2D, b: Balloon): void {
  if (!b.tail) return;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  const dx = b.tail.x - cx, dy = b.tail.y - cy; const d = Math.hypot(dx, dy) || 1;
  const edge = Math.min(b.w, b.h) / 2;
  for (let i = 0; i < 3; i++) {
    const k = edge / d + ((1 - edge / d) * (i + 1)) / 3.4; const r = Math.max(2, (b.w / 18) * (1 - i * 0.28));
    ctx.beginPath(); ctx.arc(cx + dx * k, cy + dy * k, r, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}

/** Wrap text to a width (horizontal) or height (vertical). Returns lines/columns. */
export function layoutText(ctx: CanvasRenderingContext2D, b: Balloon): { lines: string[]; inner: { x: number; y: number; w: number; h: number } } {
  const pad = b.kind === "none" ? 0 : b.kind === "caption" ? b.size * 0.6 : Math.min(b.w, b.h) * 0.16;
  const inner = { x: b.x + pad, y: b.y + pad, w: Math.max(1, b.w - pad * 2), h: Math.max(1, b.h - pad * 2) };
  ctx.font = `${b.bold ? "700" : "400"} ${b.size}px ${b.font}`;
  const lines: string[] = [];
  if (b.vertical) {
    const perCol = Math.max(1, Math.floor(inner.h / (b.size * 1.05)));
    for (const para of b.text.split("\n")) { const chars = [...para]; if (!chars.length) { lines.push(""); continue; } for (let i = 0; i < chars.length; i += perCol) lines.push(chars.slice(i, i + perCol).join("")); }
    return { lines, inner };
  }
  for (const para of b.text.split("\n")) {
    const words = para.split(/(\s+)/); let cur = "";
    for (const w of words) {
      const test = cur + w;
      if (ctx.measureText(test).width > inner.w && cur) { lines.push(cur.trimEnd()); cur = w.trimStart(); } else cur = test;
    }
    lines.push(cur.trimEnd());
  }
  return { lines, inner };
}

/** Ruby (furigana) markup: 漢字《かんじ》 or 漢字(かんじ) immediately after the base. Returns segments. */
export function parseRuby(line: string): Array<{ base: string; ruby: string | null }> {
  const out: Array<{ base: string; ruby: string | null }> = []; const re = /([^《(（]+?)[《(（]([^》)）]+)[》)）]/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    // only treat as ruby when the base is CJK or the reading is kana (keeps ordinary parentheses in English dialogue)
    const base = m[1]!, ruby = m[2]!;
    if (!/[\u3040-\u30ff\u4e00-\u9fff]/.test(base + ruby)) continue;
    if (m.index > last) out.push({ base: line.slice(last, m.index), ruby: null });
    out.push({ base, ruby }); last = m.index + m[0].length;
  }
  if (last < line.length) out.push({ base: line.slice(last), ruby: null });
  return out.length ? out : [{ base: line, ruby: null }];
}

export function drawBalloon(ctx: CanvasRenderingContext2D, b: Balloon, selected = false): void {
  ctx.save();
  const path = balloonPath(b);
  if (b.kind !== "none") {
    ctx.fillStyle = b.fill; ctx.strokeStyle = b.stroke; ctx.lineWidth = b.strokeWidth; ctx.lineJoin = b.kind === "shout" ? "miter" : "round";
    if (b.kind === "whisper") ctx.setLineDash([b.strokeWidth * 4, b.strokeWidth * 3]);
    ctx.fill(path); ctx.stroke(path); ctx.setLineDash([]);
    if (b.kind === "thought") thoughtTrail(ctx, b);
  }
  // lettering
  const { lines, inner } = layoutText(ctx, b);
  ctx.fillStyle = b.textColor; ctx.textBaseline = "middle";
  if (b.vertical) {
    const colW = b.size * b.lineHeight; const total = lines.length * colW;
    let x = inner.x + inner.w / 2 + total / 2 - colW / 2; // first column at the right
    ctx.textAlign = "center";
    for (const col of lines) {
      const chars = [...col]; const h = chars.length * b.size * 1.05; let y = inner.y + inner.h / 2 - h / 2 + b.size * 0.55;
      for (const ch of chars) {
        const rot = /[ー〜…―「」『』（）()\-–—]/.test(ch); // long vowel mark and brackets rotate in vertical text
        if (rot) { ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 2); ctx.fillText(ch, 0, 0); ctx.restore(); } else ctx.fillText(ch, x, y);
        y += b.size * 1.05;
      }
      x -= colW;
    }
  } else {
    const lh = b.size * b.lineHeight; const total = lines.length * lh;
    let y = inner.y + inner.h / 2 - total / 2 + lh / 2;
    for (const line of lines) {
      const segs = parseRuby(line);
      if (segs.length === 1 && !segs[0]!.ruby) { ctx.textAlign = "center"; ctx.fillText(line, inner.x + inner.w / 2, y); y += lh; continue; }
      // ruby line: lay out segments left to right, centred as a whole; readings at 50% size above the base
      ctx.font = `${b.bold ? "700" : "400"} ${b.size}px ${b.font}`;
      const widths = segs.map((sg) => ctx.measureText(sg.base).width); const w = widths.reduce((a, c) => a + c, 0);
      let x = inner.x + inner.w / 2 - w / 2; ctx.textAlign = "left";
      segs.forEach((sg, i) => {
        ctx.font = `${b.bold ? "700" : "400"} ${b.size}px ${b.font}`; ctx.fillText(sg.base, x, y);
        if (sg.ruby) { ctx.font = `400 ${b.size * 0.5}px ${b.font}`; const rw = ctx.measureText(sg.ruby).width; ctx.fillText(sg.ruby, x + widths[i]! / 2 - rw / 2, y - b.size * 0.72); }
        x += widths[i]!;
      });
      y += lh;
    }
  }
  if (selected) { ctx.setLineDash([6, 4]); ctx.strokeStyle = "#4f8ef7"; ctx.lineWidth = 2; ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.setLineDash([]); if (b.tail) { ctx.fillStyle = "#4f8ef7"; ctx.beginPath(); ctx.arc(b.tail.x, b.tail.y, 6, 0, Math.PI * 2); ctx.fill(); } }
  ctx.restore();
}

export function balloonAt(balloons: Balloon[], x: number, y: number): Balloon | null {
  for (let i = balloons.length - 1; i >= 0; i--) { const b = balloons[i]!; if (x >= b.x && y >= b.y && x <= b.x + b.w && y <= b.y + b.h) return b; }
  return null;
}

// ---------------------------------------------------------------- pages & templates

export interface PagePreset { name: string; w: number; h: number; dpi: number; note: string; bleed: number; safe: number }
/** Sizes in px at the preset dpi. Bleed and safe margins in px. */
export const PAGE_PRESETS: PagePreset[] = [
  { name: "B5 doujinshi 350 dpi", w: 2508, h: 3541, dpi: 350, note: "182 x 257 mm trim + 3 mm bleed each side", bleed: 41, safe: 220 },
  { name: "A4 300 dpi", w: 2480, h: 3508, dpi: 300, note: "210 x 297 mm", bleed: 35, safe: 190 },
  { name: "Shonen magazine B4 600 dpi", w: 6071, h: 8598, dpi: 600, note: "257 x 364 mm manuscript paper, 220 x 310 mm frame", bleed: 71, safe: 520 },
  { name: "Webtoon episode slice", w: 800, h: 1280, dpi: 72, note: "800 px wide, stack slices vertically", bleed: 0, safe: 40 },
  { name: "Webtoon tall canvas", w: 800, h: 6000, dpi: 72, note: "one long scroll, panels float with white space", bleed: 0, safe: 40 },
  { name: "4-koma strip 300 dpi", w: 1240, h: 3508, dpi: 300, note: "single column, four equal panels", bleed: 35, safe: 150 },
];

export interface PanelTemplate { name: string; group: "grid" | "story" | "action" | "koma" | "webtoon"; cells: Array<[number, number, number, number]>; note: string }
/** Cells are fractions of the live area (inside margins): [x0, y0, x1, y1]. */
export const PANEL_TEMPLATES: PanelTemplate[] = [
  { name: "Single splash", group: "story", cells: [[0, 0, 1, 1]], note: "full-page establishing shot or climax" },
  { name: "2 rows", group: "grid", cells: [[0, 0, 1, 0.5], [0, 0.5, 1, 1]], note: "" },
  { name: "3 rows", group: "grid", cells: [[0, 0, 1, 1 / 3], [0, 1 / 3, 1, 2 / 3], [0, 2 / 3, 1, 1]], note: "classic shojo pacing" },
  { name: "2 x 2", group: "grid", cells: [[0, 0, 0.5, 0.5], [0.5, 0, 1, 0.5], [0, 0.5, 0.5, 1], [0.5, 0.5, 1, 1]], note: "" },
  { name: "2 x 3", group: "grid", cells: [[0, 0, 0.5, 1 / 3], [0.5, 0, 1, 1 / 3], [0, 1 / 3, 0.5, 2 / 3], [0.5, 1 / 3, 1, 2 / 3], [0, 2 / 3, 0.5, 1], [0.5, 2 / 3, 1, 1]], note: "dense dialogue page" },
  { name: "4-koma", group: "koma", cells: [[0, 0, 1, 0.25], [0, 0.25, 1, 0.5], [0, 0.5, 1, 0.75], [0, 0.75, 1, 1]], note: "gag strip: setup, build, twist, punchline" },
  { name: "Wide top + 2", group: "story", cells: [[0, 0, 1, 0.42], [0, 0.42, 0.5, 1], [0.5, 0.42, 1, 1]], note: "establishing shot, then reaction pair" },
  { name: "2 + wide bottom", group: "story", cells: [[0, 0, 0.5, 0.55], [0.5, 0, 1, 0.55], [0, 0.55, 1, 1]], note: "builds to a reveal" },
  { name: "Tall left + 3", group: "story", cells: [[0, 0, 0.45, 1], [0.45, 0, 1, 1 / 3], [0.45, 1 / 3, 1, 2 / 3], [0.45, 2 / 3, 1, 1]], note: "character beat with inserts" },
  { name: "Action 5", group: "action", cells: [[0, 0, 0.6, 0.35], [0.6, 0, 1, 0.35], [0, 0.35, 1, 0.65], [0, 0.65, 0.4, 1], [0.4, 0.65, 1, 1]], note: "wide impact strip in the middle" },
  { name: "Staircase 6", group: "action", cells: [[0, 0, 0.5, 0.3], [0.5, 0, 1, 0.3], [0, 0.3, 0.35, 0.65], [0.35, 0.3, 1, 0.65], [0, 0.65, 0.65, 1], [0.65, 0.65, 1, 1]], note: "eye leads down-left to down-right" },
  { name: "Webtoon stack 4", group: "webtoon", cells: [[0.05, 0.02, 0.95, 0.22], [0.05, 0.28, 0.95, 0.48], [0.05, 0.54, 0.95, 0.74], [0.05, 0.8, 0.95, 0.98]], note: "floating panels with scroll breathing room" },
];

export function applyPanelTemplate(doc: Doc, t: PanelTemplate, margin: number, gutter: number): Panel[] {
  const x0 = margin, y0 = margin, w = doc.width - margin * 2, h = doc.height - margin * 2; const g = gutter / 2;
  return t.cells.map(([a, b, c, d]) => {
    const px0 = x0 + a * w + (a > 0 ? g : 0), py0 = y0 + b * h + (b > 0 ? g : 0), px1 = x0 + c * w - (c < 1 ? g : 0), py1 = y0 + d * h - (d < 1 ? g : 0);
    return { id: newId(), polygon: [{ x: px0, y: py0 }, { x: px1, y: py0 }, { x: px1, y: py1 }, { x: px0, y: py1 }], gutter };
  });
}

/** Diagonal variant: slant every horizontal gutter by `slant` DU (dynamic action layouts). */
export function slantPanels(panels: Panel[], slant: number): Panel[] {
  return panels.map((p, i) => ({ ...p, polygon: p.polygon.map((q, k) => ({ x: q.x, y: q.y + ((k === 0 || k === 3) ? -1 : 1) * (i % 2 ? slant : -slant) * 0.5 })) }));
}
