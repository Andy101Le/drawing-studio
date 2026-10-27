import { describe, it, expect } from "vitest";
import { trace, edt, contours } from "../app/engine/trace/trace-core.js";

function synth(w: number, h: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4; let r = 245, g = 240, b = 230;
    const dx = x - w * 0.4, dy = y - h * 0.5, rr = Math.hypot(dx, dy), R = Math.min(w, h) * 0.3;
    if (rr < R) { r = 220; g = 70; b = 60; if (dx > 0 && dy > 0) { r = 150; g = 40; b = 35; } if (dx < -R * 0.4 && dy < -R * 0.4) { r = 245; g = 140; b = 125; } }
    if (Math.abs(rr - R) < 1.8) { r = 25; g = 20; b = 30; }                               // outline ~3.5 px
    if (x > w * 0.78 && x < w * 0.92 && y > h * 0.2 && y < h * 0.6) { r = 10; g = 10; b = 12; } // solid black block
    if (Math.abs((y - h * 0.1) - (x - w * 0.05) * 0.3) < 0.9 && x < w * 0.6) { r = 30; g = 30; b = 40; } // thin line
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255;
  }
  return d;
}

describe("redraw core", () => {
  it("distance transform matches a hand case", () => {
    const m = new Uint8Array(7 * 7); for (let y = 1; y < 6; y++) for (let x = 1; x < 6; x++) m[y * 7 + x] = 1;
    const d = edt(m, 7, 7); expect(d[3 * 7 + 3]).toBeCloseTo(3, 5); expect(d[1 * 7 + 1]).toBeCloseTo(1, 5); expect(d[0]).toBe(0);
  });
  it("contours a square as one closed loop near its edge", () => {
    const w = 20, h = 20; const m = new Uint8Array(w * h); for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) m[y * w + x] = 1;
    const loops = contours(m, w, h, [5, 5, 15, 15]); expect(loops.length).toBe(1);
    const xs = [...loops[0]!].filter((_, i) => i % 2 === 0); expect(Math.min(...xs)).toBeGreaterThan(4.4); expect(Math.max(...xs)).toBeLessThan(15.6);
  });
  it("splits a picture into ink strokes, solid ink, flats, shadows, highlights and tones", () => {
    const w = 600, h = 400; const t0 = Date.now();
    const r = trace(synth(w, h), w, h, {});
    const ms = Date.now() - t0;
    expect(r.strokes.length).toBeGreaterThan(0);
    expect(r.inkFills.length).toBeGreaterThanOrEqual(1);
    const red = r.flats.find((f) => f.color[0] > 180 && f.color[1] < 110); expect(red).toBeTruthy();
    expect(r.shadows.length).toBeGreaterThan(0);
    expect(r.highlights.length).toBeGreaterThan(0);
    expect(r.tones.length).toBeGreaterThan(0);
    // stroke widths near the drawn ~3.5 px outline
    const widths = r.strokes.flatMap((s) => [...s.pts].filter((_, i) => i % 3 === 2)); const med = widths.sort((a, b) => a - b)[widths.length >> 1]!;
    expect(med).toBeGreaterThan(1.5); expect(med).toBeLessThan(6);
    console.log(`trace 0.24 Mpx: ${ms} ms`, r.stats);
  });
});

describe("loop 18: chaining, soft residual, alpha mask", () => {
  it("chainStrokes joins two collinear pieces across a small gap and leaves a thin/thick pair alone", async () => {
    const { chainStrokes } = await import("../app/engine/trace/trace-core.js");
    const line = (x0: number, x1: number, w: number) => new Float32Array([x0, 10, w, (x0 + x1) / 2, 10, w, x1, 10, w]);
    const a = [{ pts: line(0, 20, 2), color: [0, 0, 0] as [number, number, number] }, { pts: line(22, 40, 2), color: [0, 0, 0] as [number, number, number] }];
    expect(chainStrokes(a, 3)).toBe(1); expect(a.length).toBe(1); expect(a[0]!.pts.length).toBe(18);
    const b = [{ pts: line(0, 20, 1), color: [0, 0, 0] as [number, number, number] }, { pts: line(22, 40, 6), color: [0, 0, 0] as [number, number, number] }];
    expect(chainStrokes(b, 3)).toBe(0); expect(b.length).toBe(2);
  });
  it("traces nothing outside the alpha mask and paints soft dabs only where the picture is not flat", async () => {
    const { trace } = await import("../app/engine/trace/trace-core.js");
    const w = 96, h = 96, N = w * h; const rgba = new Uint8ClampedArray(N * 4); const mask = new Uint8Array(N);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x; const inside = x < 64; mask[i] = inside ? 1 : 0;
      // left: a horizontal gradient from light blue to dark blue (what cel layers cannot hold); right: black "outside"
      const t = x / 64; const c = inside ? [Math.round(200 - 140 * t), Math.round(210 - 120 * t), 240] : [0, 0, 0];
      rgba[i * 4] = c[0]!; rgba[i * 4 + 1] = c[1]!; rgba[i * 4 + 2] = c[2]!; rgba[i * 4 + 3] = 255;
    }
    const r = trace(rgba, w, h, { detail: 4, soft: 1 }, undefined, mask);
    expect(r.inkMask.some((v, i) => v && !mask[i])).toBe(false);
    for (const f of r.flats) expect(f.box[0]).toBeLessThan(64);
    expect(r.stats.softDabs).toBeGreaterThan(0);
    for (let i = 0; i < r.soft.length; i += 7) expect(r.soft[i]!).toBeLessThan(64);
    const r0 = trace(rgba, w, h, { detail: 4, soft: 0 }, undefined, mask);
    expect(r0.stats.softDabs).toBe(0);
  });
});
