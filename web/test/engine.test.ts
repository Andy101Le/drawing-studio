import { describe, expect, it } from "vitest";
import { M_ACESCG_TO_XYZ, M_XYZ_TO_ACESCG, M_P3_TO_XYZ, M_XYZ_TO_P3, M_2020_TO_XYZ, M_XYZ_TO_2020, mul, linearSrgbToOklab, oklabToLinearSrgb, oklabToOklch, oklchToOklab, rgbToCmyk, cmykToRgbProof, maxChroma, type Vec3 } from "../app/engine/color.js";
import { applySplit, pageToPanel, pointInPolygon, polygonArea, splitPanel } from "../app/engine/panels.js";
import { moireRisk } from "../app/engine/screentone.js";
import { Doc } from "../app/engine/document.js";

const close = (a: Vec3, b: Vec3, eps = 1e-3) => a.every((v, i) => Math.abs(v - (b[i] as number)) < eps);

describe("color engineering", () => {
  it("gamut matrices invert each other", () => {
    for (const [A, B] of [[M_ACESCG_TO_XYZ, M_XYZ_TO_ACESCG], [M_P3_TO_XYZ, M_XYZ_TO_P3], [M_2020_TO_XYZ, M_XYZ_TO_2020]] as const) {
      for (const v of [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0.2, 0.5, 0.9]] as Vec3[]) expect(close(mul(B, mul(A, v)), v)).toBe(true);
    }
  });
  it("Oklab round-trips and white is achromatic", () => {
    const lin: Vec3 = [0.3, 0.6, 0.1];
    expect(close(oklabToLinearSrgb(linearSrgbToOklab(lin)), lin, 1e-4)).toBe(true);
    const white = oklabToOklch(linearSrgbToOklab([1, 1, 1]));
    expect(white[0]).toBeCloseTo(1, 3); expect(white[1]).toBeLessThan(1e-4);
    expect(close(oklabToLinearSrgb(oklchToOklab([0.5, 0, 0])), [0.125, 0.125, 0.125], 1e-3)).toBe(true);
  });
  it("max chroma stays inside sRGB and pure blue dulls under CMYK proof", () => {
    const c = maxChroma(0.6, 260);
    expect(oklabToLinearSrgb(oklchToOklab([0.6, c, 260])).every((v) => v >= -1e-6 && v <= 1 + 1e-6)).toBe(true);
    expect(oklabToLinearSrgb(oklchToOklab([0.6, c + 0.02, 260])).some((v) => v < 0 || v > 1)).toBe(true);
    const proofBlue = cmykToRgbProof(rgbToCmyk([0, 0, 1]));
    expect(proofBlue[2]).toBeLessThan(0.75); expect(proofBlue[0]).toBeGreaterThan(0.05);
    expect(rgbToCmyk([0, 0, 0])).toEqual([0, 0, 0, 1]);
  });
});

describe("panel slicing", () => {
  it("splits a page panel into two with a gutter and preserves area minus gutter", () => {
    const page = pageToPanel(2000, 3000, 100, 40);
    const halves = splitPanel(page, { x: 0, y: 1500 }, { x: 2000, y: 1500 });
    expect(halves).not.toBeNull();
    const [a, b] = halves!;
    expect(polygonArea(a.polygon) + polygonArea(b.polygon)).toBeCloseTo(polygonArea(page.polygon) - 1800 * 40, 0);
    expect(pointInPolygon({ x: 1000, y: 500 }, a.polygon) !== pointInPolygon({ x: 1000, y: 500 }, b.polygon)).toBe(true);
    expect(pointInPolygon({ x: 1000, y: 1500 }, a.polygon) || pointInPolygon({ x: 1000, y: 1500 }, b.polygon)).toBe(false); // in the gutter
  });
  it("rejects a cut that misses or shaves a sliver", () => {
    const page = pageToPanel(2000, 3000, 100, 40);
    expect(splitPanel(page, { x: 0, y: 5000 }, { x: 2000, y: 5000 })).toBeNull();
    expect(splitPanel(page, { x: 0, y: 101 }, { x: 2000, y: 101 })).toBeNull();
    const res = applySplit([page], page, { x: 1000, y: 0 }, { x: 1000, y: 3000 });
    expect(res?.panels.length).toBe(2);
  });
});

describe("screentone + timeline model", () => {
  it("flags moiré near integer pitch and not at half-pixel pitch", () => {
    expect(moireRisk(6.02)).toBeGreaterThan(0.8);
    expect(moireRisk(6.5)).toBe(0);
  });
  it("inserts keys without orphaning the first drawing", () => {
    const d = new Doc();
    d.setFrameCount(12);
    d.newDrawingAtCurrent(); // at key 0 → new drawing starts at 1
    expect(d.exposure.slice(0, 3)).toEqual([0, 1, 1]);
    d.currentFrame = 6; d.newDrawingAtCurrent(); // split the hold
    expect(d.exposure[5]).toBe(1); expect(d.exposure[6]).toBe(2); expect(d.exposure[11]).toBe(2);
    expect(d.isKey(6)).toBe(true); expect(d.isKey(7)).toBe(false);
    d.currentFrame = 11; d.newDrawingAtCurrent(); d.currentFrame = 11; d.newDrawingAtCurrent();
    expect(d.exposure.length).toBe(13);
  });
});
