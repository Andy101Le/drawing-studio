/**
 * Turn a generated image into print-ready manga: greyscale with a contrast curve, or pure black and
 * white with amplitude-modulated screentone dots locked to page coordinates (so tones from several
 * panels or several results line up, and dot pitch is set in lines per inch at the page's dpi).
 */

export type MangaFinish = "none" | "grey" | "tone" | "ink";

export interface FinishOptions {
  mode: MangaFinish;
  /** screentone frequency, lines per inch (55-85 is typical for manga) */
  lpi: number;
  /** page resolution, dots per inch */
  dpi: number;
  /** screen angle, degrees (45 is the usual single-colour angle) */
  angleDeg: number;
  /** 0..1: luminance below this prints solid black (lines, hair, deep shadow) */
  black: number;
  /** 0..1: luminance above this stays paper white */
  white: number;
}

export const FINISH_DEFAULTS: FinishOptions = { mode: "tone", lpi: 60, dpi: 300, angleDeg: 45, black: 0.2, white: 0.9 };

/**
 * Process RGBA pixels in place. (x0, y0) is the page position of the buffer's top-left pixel, so
 * adjacent tiles processed separately produce one continuous dot screen.
 */
export function finishPixels(data: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, o: FinishOptions): void {
  if (o.mode === "none") return;
  const cell = o.dpi / Math.max(1, o.lpi); // dot pitch in page pixels
  const a = (o.angleDeg * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
  const span = Math.max(1e-3, o.white - o.black);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3]! === 0) continue;
      const L = (0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!) / 255;
      let v: number;
      if (o.mode === "grey") {
        // S-curve between the black and white points: flatter mid-greys, solid darks
        const t = Math.min(1, Math.max(0, (L - o.black) / span));
        v = 255 * (t * t * (3 - 2 * t));
      } else if (o.mode === "ink") {
        v = L < (o.black + o.white) / 2 ? 0 : 255;
      } else {
        if (L <= o.black) v = 0;
        else if (L >= o.white) v = 255;
        else {
          const dark = 1 - (L - o.black) / span; // 0 = paper, 1 = solid
          const px = x0 + x, py = y0 + y;
          const u = (px * ca + py * sa) / cell, w = (-px * sa + py * ca) / cell;
          // round dot spot function, 0..1; ink where the tone is darker than the spot
          const spot = 0.5 + 0.25 * (Math.cos(2 * Math.PI * u) + Math.cos(2 * Math.PI * w));
          v = dark > spot ? 0 : 255;
        }
      }
      data[i] = data[i + 1] = data[i + 2] = v;
    }
  }
}
