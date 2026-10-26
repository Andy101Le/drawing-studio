/**
 * Color engineering (Phase 5.3).
 *
 * Working model for the picker: Oklab / OKLCh (perceptually uniform, so equal
 * steps on the wheel look equal). Gamut matrices for sRGB, Display P3,
 * Rec.2020, and ACEScg; a CMYK soft-proof model for print preview.
 *
 * All matrices are from the respective standards (IEC 61966-2-1, SMPTE EG 432-1,
 * ITU-R BT.2020, Academy S-2014-004) with D65 white, ACEScg chromatically
 * adapted from D60 with Bradford.
 */

export type Vec3 = [number, number, number];
export type Mat3 = [Vec3, Vec3, Vec3];

export const M_XYZ_TO_SRGB: Mat3 = [[3.2409699, -1.5373832, -0.4986108], [-0.9692436, 1.8759675, 0.0415551], [0.0556301, -0.2039770, 1.0569715]];
export const M_SRGB_TO_XYZ: Mat3 = [[0.4123908, 0.3575843, 0.1804808], [0.2126390, 0.7151687, 0.0721923], [0.0193308, 0.1191948, 0.9505322]];
export const M_XYZ_TO_P3: Mat3 = [[2.4934969, -0.9313836, -0.4027108], [-0.8294890, 1.7626641, 0.0236247], [0.0358458, -0.0761724, 0.9568845]];
export const M_P3_TO_XYZ: Mat3 = [[0.4865709, 0.2656677, 0.1982173], [0.2289746, 0.6917385, 0.0792869], [0.0, 0.0451134, 1.0439444]];
export const M_XYZ_TO_2020: Mat3 = [[1.7166512, -0.3556708, -0.2533663], [-0.6666844, 1.6164812, 0.0157685], [0.0176399, -0.0427706, 0.9421031]];
export const M_2020_TO_XYZ: Mat3 = [[0.6369580, 0.1446169, 0.1688810], [0.2627002, 0.6779981, 0.0593017], [0.0, 0.0280727, 1.0609851]];
/** ACEScg (AP1) ↔ XYZ D65 (Bradford-adapted from D60). */
export const M_ACESCG_TO_XYZ: Mat3 = [[0.6624542, 0.1340042, 0.1561877], [0.2722287, 0.6740818, 0.0536895], [-0.0055746, 0.0040607, 1.0103391]];
export const M_XYZ_TO_ACESCG: Mat3 = [[1.6410234, -0.3248033, -0.2364247], [-0.6636629, 1.6153316, 0.0167563], [0.0117219, -0.0082844, 0.9883949]];

export function mul(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ];
}

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
export const linearToSrgb = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** BT.1886 display EOTF inverse, gamma 2.4, used for Rec.2020 SDR preview. */
export const linearTo1886 = (c: number): number => Math.pow(Math.max(0, c), 1 / 2.4);

// ---- Oklab (Björn Ottosson, 2020) ----
export function linearSrgbToOklab([r, g, b]: Vec3): Vec3 {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}
export function oklabToLinearSrgb([L, a, b]: Vec3): Vec3 {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const l = l_ * l_ * l_, m = m_ * m_ * m_, s = s_ * s_ * s_;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}
export function oklchToOklab([L, C, h]: Vec3): Vec3 {
  const hr = (h * Math.PI) / 180;
  return [L, C * Math.cos(hr), C * Math.sin(hr)];
}
export function oklabToOklch([L, a, b]: Vec3): Vec3 {
  return [L, Math.hypot(a, b), ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360];
}

export type Gamut = "srgb" | "p3" | "rec2020" | "acescg";

/** Linear sRGB → encoded display RGB in the chosen gamut, with out-of-gamut flag. */
export function toDisplay(lin: Vec3, gamut: Gamut): { rgb: Vec3; clipped: boolean } {
  const xyz = mul(M_SRGB_TO_XYZ, lin);
  let v: Vec3;
  let enc: (c: number) => number = linearToSrgb;
  switch (gamut) {
    case "srgb": v = lin; break;
    case "p3": v = mul(M_XYZ_TO_P3, xyz); break;
    case "rec2020": v = mul(M_XYZ_TO_2020, xyz); enc = linearTo1886; break;
    case "acescg": v = mul(M_XYZ_TO_ACESCG, xyz); enc = (c) => c; break;
  }
  const clipped = v.some((c) => c < -0.0005 || c > 1.0005);
  const rgb = v.map((c) => enc(Math.max(0, Math.min(1, c)))) as Vec3;
  return { rgb, clipped };
}

/** Largest chroma at (L, h) that stays inside sRGB, by bisection. */
export function maxChroma(L: number, h: number, gamut: Gamut = "srgb"): number {
  let lo = 0, hi = 0.4;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    const lin = oklabToLinearSrgb(oklchToOklab([L, mid, h]));
    const inside = gamut === "srgb" ? lin.every((c) => c >= 0 && c <= 1) : !toDisplay(lin, gamut).clipped;
    if (inside) lo = mid; else hi = mid;
  }
  return lo;
}

export function hexFromLinear(lin: Vec3): string {
  return "#" + lin.map((c) => Math.round(255 * Math.max(0, Math.min(1, linearToSrgb(c)))).toString(16).padStart(2, "0")).join("");
}
export function linearFromHex(hex: string): Vec3 {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(srgbToLinear) as Vec3;
}

// ---- CMYK soft proof ----
// Model: GCR separation, then rebuild with measured-style ink impurities
// (cyan absorbs some green/blue, magenta some red/blue, yellow some blue),
// which is why a pure sRGB blue dulls under proof. Dot gain 18% at 50% tone.
const INK = { c: [0.08, 0.62, 0.90], m: [0.92, 0.12, 0.55], y: [0.98, 0.93, 0.12], k: [0.14, 0.12, 0.12] } as const;
export function dotGain(v: number, gain = 0.18): number {
  return v + gain * 4 * v * (1 - v) * (1 - v * 0.5);
}
export function rgbToCmyk([r, g, b]: Vec3): [number, number, number, number] {
  const k = 1 - Math.max(r, g, b);
  if (k >= 0.999) return [0, 0, 0, 1];
  const c = (1 - r - k) / (1 - k), m = (1 - g - k) / (1 - k), y = (1 - b - k) / (1 - k);
  const gcr = 0.6 * Math.min(c, m, y); // move common gray to black
  return [c - gcr, m - gcr, y - gcr, Math.min(1, k + gcr)];
}
export function cmykToRgbProof([c, m, y, k]: [number, number, number, number], paper: Vec3 = [0.96, 0.95, 0.92]): Vec3 {
  const C = dotGain(c), M = dotGain(m), Y = dotGain(y), K = dotGain(k);
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let v = paper[i] as number;
    v *= 1 - C * (1 - (INK.c[i] as number));
    v *= 1 - M * (1 - (INK.m[i] as number));
    v *= 1 - Y * (1 - (INK.y[i] as number));
    v *= 1 - K * (1 - (INK.k[i] as number));
    out[i] = v;
  }
  return out;
}
/** Apply the proof to an sRGB-encoded hex. */
export function proofHex(hex: string): string {
  const enc = hex.replace("#", "");
  const n = parseInt(enc, 16);
  const rgb: Vec3 = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const out = cmykToRgbProof(rgbToCmyk(rgb));
  return "#" + out.map((c) => Math.round(255 * Math.max(0, Math.min(1, c))).toString(16).padStart(2, "0")).join("");
}

/** Proof an ImageData in place (used for the viewport toggle). */
export function proofImageData(img: ImageData): void {
  const d = img.data;
  const lut = proofLut();
  for (let i = 0; i < d.length; i += 4) {
    const idx = ((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3);
    d[i] = lut[idx * 3]!; d[i + 1] = lut[idx * 3 + 1]!; d[i + 2] = lut[idx * 3 + 2]!;
  }
}
let _lut: Uint8Array | null = null;
function proofLut(): Uint8Array {
  if (_lut) return _lut;
  const lut = new Uint8Array(32 * 32 * 32 * 3);
  for (let r = 0; r < 32; r++) for (let g = 0; g < 32; g++) for (let b = 0; b < 32; b++) {
    const out = cmykToRgbProof(rgbToCmyk([r / 31, g / 31, b / 31]));
    const i = ((r << 10) | (g << 5) | b) * 3;
    lut[i] = Math.round(255 * out[0]); lut[i + 1] = Math.round(255 * out[1]); lut[i + 2] = Math.round(255 * out[2]);
  }
  _lut = lut;
  return lut;
}
