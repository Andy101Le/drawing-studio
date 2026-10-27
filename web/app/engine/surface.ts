/**
 * Background surface behind the paper. Saved per document. Kinds:
 *   color     one flat colour
 *   gradient  two stops at an angle
 *   image     the user's picture, fit (cover) or tiled, with a tint overlay
 *   texture   a procedural preset painted on a 512 px canvas tile (desk wood, felt, slate,
 *             linen, cream paper, carbon); the same painter feeds the CSS background and the
 *             export composite, so what is exported matches what was on screen
 * `surfaceCss()` returns the CSS background for the viewport; `paintSurface()` fills a canvas.
 */
export type SurfaceKind = "color" | "gradient" | "image" | "texture";
export interface Surface {
  kind: SurfaceKind;
  color: string; color2: string; angle: number;
  image: string | null; imageMode: "cover" | "tile"; imageTint: number; // 0..1 darkening
  texture: TextureName;
  shadow: boolean;      // soft drop shadow under the page
  inExport: boolean;    // include behind transparent areas when exporting
}
export type TextureName = "walnut" | "felt" | "slate" | "linen" | "cream" | "carbon";
export const TEXTURES: Array<{ name: TextureName; label: string }> = [
  { name: "walnut", label: "Walnut desk" }, { name: "felt", label: "Green felt" }, { name: "slate", label: "Slate" },
  { name: "linen", label: "Linen" }, { name: "cream", label: "Cream paper" }, { name: "carbon", label: "Carbon" },
];
export const DEFAULT_SURFACE: Surface = { kind: "color", color: "#0f0f0f", color2: "#1c1c1c", angle: 180, image: null, imageMode: "cover", imageTint: 0.25, texture: "walnut", shadow: true, inExport: false };

// deterministic hash noise so textures are stable across sessions
function hash(x: number, y: number, seed: number): number { let h = (x * 374761393 + y * 668265263 + seed * 1442695041) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
function smoothNoise(x: number, y: number, scale: number, seed: number): number {
  const gx = x / scale, gy = y / scale; const x0 = Math.floor(gx), y0 = Math.floor(gy); const fx = gx - x0, fy = gy - y0;
  const s = (t: number) => t * t * (3 - 2 * t); const ux = s(fx), uy = s(fy);
  const a = hash(x0, y0, seed), b = hash(x0 + 1, y0, seed), c = hash(x0, y0 + 1, seed), d = hash(x0 + 1, y0 + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

const tileCache = new Map<TextureName, HTMLCanvasElement>();
/** 512 px seamless-enough texture tile (noise wraps by sampling modulo the tile). */
export function textureTile(name: TextureName): HTMLCanvasElement {
  const hit = tileCache.get(name); if (hit) return hit;
  const S = 512; const c = document.createElement("canvas"); c.width = S; c.height = S; const g = c.getContext("2d")!;
  const img = g.createImageData(S, S); const d = img.data;
  const wrap = (v: number) => ((v % S) + S) % S;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    let r = 0, gg = 0, b = 0;
    if (name === "walnut") { // grain: stretched noise along x with fine ripples
      const grain = smoothNoise(wrap(x) * 0.08, wrap(y), 9, 1) * 0.6 + smoothNoise(wrap(x) * 0.02, wrap(y), 37, 2) * 0.4;
      const rings = 0.5 + 0.5 * Math.sin(grain * 28 + smoothNoise(x, y, 60, 3) * 4);
      const base = 0.28 + rings * 0.16 + (hash(x, y, 4) - 0.5) * 0.04;
      r = 92 * base * 2; gg = 58 * base * 2; b = 34 * base * 2;
    } else if (name === "felt") { const n = smoothNoise(x, y, 3, 5) * 0.5 + hash(x, y, 6) * 0.5; r = 26 + n * 18; gg = 78 + n * 26; b = 48 + n * 16; }
    else if (name === "slate") { const n = smoothNoise(x, y, 24, 7) * 0.6 + smoothNoise(x, y, 5, 8) * 0.3 + hash(x, y, 9) * 0.1; const v = 38 + n * 30; r = v; gg = v + 2; b = v + 6; }
    else if (name === "linen") { const wx = 0.5 + 0.5 * Math.sin(x * 1.2), wy = 0.5 + 0.5 * Math.sin(y * 1.2); const n = (wx * 0.5 + wy * 0.5) * 0.35 + hash(x, y, 10) * 0.15 + smoothNoise(x, y, 40, 11) * 0.2; const v = 150 + n * 70; r = v + 6; gg = v + 2; b = v - 8; }
    else if (name === "cream") { const n = smoothNoise(x, y, 18, 12) * 0.5 + hash(x, y, 13) * 0.5; r = 236 + n * 12; gg = 229 + n * 10; b = 212 + n * 10; }
    else { const cx = (x % 8) < 4 ? 1 : 0, cy = (y % 8) < 4 ? 1 : 0; const weave = cx === cy ? 0.08 : 0; const n = hash(x, y, 14) * 0.05; const v = 14 + (weave + n) * 255 * 0.5; r = v; gg = v; b = v + 2; }
    const i = (y * S + x) * 4; d[i] = Math.max(0, Math.min(255, r)); d[i + 1] = Math.max(0, Math.min(255, gg)); d[i + 2] = Math.max(0, Math.min(255, b)); d[i + 3] = 255;
  }
  // make the tile seamless: blend with a half-offset copy, weighted toward the copy near the edges
  const out = g.createImageData(S, S); const o = out.data; const H = S / 2;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const ex = Math.min(x, S - 1 - x) / H, ey = Math.min(y, S - 1 - y) / H; const t = Math.min(ex, ey); // 0 at edges, 1 at centre
    const m = 1 - (t * t * (3 - 2 * t)); // weight of the shifted copy
    const i = (y * S + x) * 4, j = (((y + H) % S) * S + ((x + H) % S)) * 4;
    for (let k = 0; k < 3; k++) o[i + k] = d[i + k]! * (1 - m) + d[j + k]! * m;
    o[i + 3] = 255;
  }
  g.putImageData(out, 0, 0); tileCache.set(name, c); return c;
}

/** CSS background for the viewport element. */
export function surfaceCss(s: Surface): { background: string; backgroundSize: string; backgroundRepeat: string } {
  if (s.kind === "gradient") return { background: `linear-gradient(${s.angle}deg, ${s.color}, ${s.color2})`, backgroundSize: "auto", backgroundRepeat: "no-repeat" };
  if (s.kind === "image" && s.image) {
    const tint = `linear-gradient(rgba(0,0,0,${s.imageTint}), rgba(0,0,0,${s.imageTint}))`;
    return s.imageMode === "cover" ? { background: `${tint}, url("${s.image}") center / cover no-repeat ${s.color}`, backgroundSize: "auto, cover", backgroundRepeat: "no-repeat" } : { background: `${tint}, url("${s.image}") ${s.color}`, backgroundSize: "auto, auto", backgroundRepeat: "no-repeat, repeat" };
  }
  if (s.kind === "texture") return { background: `url("${textureTile(s.texture).toDataURL()}") ${s.color}`, backgroundSize: "512px 512px", backgroundRepeat: "repeat" };
  return { background: s.color, backgroundSize: "auto", backgroundRepeat: "no-repeat" };
}

/** Paint the surface onto a canvas region (export). Images are drawn from the cached element. */
export function paintSurface(g: CanvasRenderingContext2D, s: Surface, w: number, h: number, img?: HTMLImageElement | null): void {
  g.save();
  if (s.kind === "gradient") {
    const a = ((s.angle - 90) * Math.PI) / 180; const cx = w / 2, cy = h / 2, L = Math.hypot(w, h) / 2;
    const gr = g.createLinearGradient(cx - Math.cos(a) * L, cy - Math.sin(a) * L, cx + Math.cos(a) * L, cy + Math.sin(a) * L); gr.addColorStop(0, s.color); gr.addColorStop(1, s.color2);
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
  } else if (s.kind === "image" && img) {
    g.fillStyle = s.color; g.fillRect(0, 0, w, h);
    if (s.imageMode === "cover") { const k = Math.max(w / img.width, h / img.height); const iw = img.width * k, ih = img.height * k; g.drawImage(img, (w - iw) / 2, (h - ih) / 2, iw, ih); }
    else { g.fillStyle = g.createPattern(img, "repeat")!; g.fillRect(0, 0, w, h); }
    g.fillStyle = `rgba(0,0,0,${s.imageTint})`; g.fillRect(0, 0, w, h);
  } else if (s.kind === "texture") { g.fillStyle = g.createPattern(textureTile(s.texture), "repeat")!; g.fillRect(0, 0, w, h); }
  else { g.fillStyle = s.color; g.fillRect(0, 0, w, h); }
  g.restore();
}
