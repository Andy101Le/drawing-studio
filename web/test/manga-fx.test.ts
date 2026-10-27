import { describe, it, expect } from "vitest";
import { newFx, speedLines, focusLines, flashShape, clipToBox, toneDots, fxBox, fxAt, panelAtPoint, fxNoise, type Fx } from "../app/engine/manga-fx.js";

const box = { x: 100, y: 100, w: 400, h: 300 };
const inBox = (x: number, y: number) => x >= box.x - 1e-6 && x <= box.x + box.w + 1e-6 && y >= box.y - 1e-6 && y <= box.y + box.h + 1e-6;
const mk = (kind: Fx["kind"]): Fx => ({ ...newFx(kind, box.x, box.y, box.w, box.h, 300), seed: 7 });

describe("manga fx geometry", () => {
  it("speed lines stay inside the box, taper to nothing, and follow the angle", () => {
    const f = mk("speed"); f.angle = 0;
    const segs = speedLines(f, box);
    expect(segs.length).toBeGreaterThan(5);
    for (const s of segs) {
      expect(inBox(s.x0, s.y0)).toBe(true); expect(inBox(s.x1, s.y1)).toBe(true);
      expect(s.w0).toBeGreaterThan(0); expect(s.w1).toBeLessThan(s.w0);
      expect(Math.abs(s.y1 - s.y0)).toBeLessThan(1e-6); // horizontal at angle 0
    }
    f.angle = 90;
    for (const s of speedLines(f, box)) expect(Math.abs(s.x1 - s.x0)).toBeLessThan(1e-6);
  });

  it("more density means more lines; the same seed gives the same lines", () => {
    const a = mk("speed"); a.density = 0.2; const b = mk("speed"); b.density = 0.9;
    expect(speedLines(b, box).length).toBeGreaterThan(speedLines(a, box).length);
    expect(JSON.stringify(speedLines(a, box))).toBe(JSON.stringify(speedLines({ ...a }, box)));
    const c = { ...a, seed: 8 }; expect(JSON.stringify(speedLines(c, box))).not.toBe(JSON.stringify(speedLines(a, box)));
  });

  it("focus lines point at the anchor and leave the clear centre empty", () => {
    const f = mk("focus"); f.anchor = { x: 300, y: 250 }; f.length = 0.4; f.jitter = 0;
    const segs = focusLines(f, box); expect(segs.length).toBeGreaterThan(10);
    const clear = Math.min(box.w, box.h) * 0.5 * 0.4;
    for (const s of segs) {
      // the inner end is on the ray from the anchor, at the clear radius
      const r1 = Math.hypot(s.x1 - f.anchor.x, s.y1 - f.anchor.y);
      expect(r1).toBeGreaterThanOrEqual(clear - 1e-6);
      const r0 = Math.hypot(s.x0 - f.anchor.x, s.y0 - f.anchor.y); expect(r0).toBeGreaterThan(r1);
      const cross = (s.x0 - f.anchor.x) * (s.y1 - f.anchor.y) - (s.y0 - f.anchor.y) * (s.x1 - f.anchor.x);
      expect(Math.abs(cross) / (r0 * r1)).toBeLessThan(1e-6); // collinear with the anchor
      expect(inBox(s.x0, s.y0)).toBe(true);
    }
  });

  it("a flash is a closed star around the anchor with spikes outside it", () => {
    const f = mk("flash"); f.anchor = { x: 300, y: 250 }; f.length = 0.3;
    const { star, spikes } = flashShape(f, box);
    expect(star.length % 2).toBe(0); expect(star.length).toBeGreaterThanOrEqual(12);
    const r = Math.min(box.w, box.h) * 0.5 * 0.3;
    const radii = star.map((p) => Math.hypot(p.x - f.anchor.x, p.y - f.anchor.y));
    expect(Math.max(...radii)).toBeLessThan(r * 1.3); expect(Math.min(...radii)).toBeGreaterThan(r * 0.4);
    for (const s of spikes) expect(Math.hypot(s.x0 - f.anchor.x, s.y0 - f.anchor.y)).toBeGreaterThan(r);
  });

  it("clipToBox keeps the inside part and interpolates the weights", () => {
    const s = clipToBox({ x0: 0, y0: 250, x1: 600, y1: 250, w0: 10, w1: 0 }, box)!;
    expect(s.x0).toBeCloseTo(100); expect(s.x1).toBeCloseTo(500);
    expect(s.w0).toBeCloseTo(10 - 10 * (100 / 600)); expect(s.w1).toBeCloseTo(10 - 10 * (500 / 600));
    expect(clipToBox({ x0: 0, y0: 0, x1: 50, y1: 50, w0: 1, w1: 0 }, box)).toBeNull();
  });

  it("tone ramp dots grow from the 'to' edge to the 'from' edge and respect lpi", () => {
    const f = mk("tone"); f.toneFrom = 0.6; f.toneTo = 0; f.angle = 0; f.lpi = 50;
    const dots = toneDots(f, box, 300);
    expect(dots.length).toBeGreaterThan(100);
    const left = dots.filter((d) => d.x < box.x + box.w * 0.2), right = dots.filter((d) => d.x > box.x + box.w * 0.8);
    const mean = (a: typeof dots) => a.reduce((s, d) => s + d.r, 0) / a.length;
    expect(mean(left)).toBeGreaterThan(mean(right) * 1.5);
    // nearest-neighbour spacing is the pitch, 300 / 50 = 6 DU
    const d0 = dots[Math.floor(dots.length / 2)]!;
    const nn = Math.min(...dots.filter((d) => d !== d0).map((d) => Math.hypot(d.x - d0.x, d.y - d0.y)));
    expect(nn).toBeCloseTo(6, 3);
    f.toneFrom = 0; f.toneTo = 0; expect(toneDots(f, box, 300).length).toBe(0);
  });

  it("an effect anchored to a panel takes the panel's bounds; hit testing and panel lookup work", () => {
    const panel = { id: 42, polygon: [{ x: 10, y: 10 }, { x: 210, y: 10 }, { x: 210, y: 160 }, { x: 10, y: 160 }], gutter: 0 } as unknown as import("../app/engine/document.js").Panel;
    const f = mk("focus"); f.panelId = 42;
    expect(fxBox(f, [panel])).toEqual({ x: 10, y: 10, w: 200, h: 150 });
    expect(fxBox(f, [])).toEqual(box); // panel gone: falls back to its own box
    const g = mk("speed");
    expect(fxAt([g, f], [panel], 50, 50)).toBe(f);
    expect(fxAt([g, f], [panel], 300, 250)).toBe(g);
    expect(fxAt([g, f], [panel], 1000, 1000)).toBeNull();
    expect(panelAtPoint([panel], 100, 100)).toBe(panel); expect(panelAtPoint([panel], 300, 300)).toBeNull();
    const t = mk("sfx"); t.anchor = { x: 900, y: 900 }; t.size = 50; t.text = "BAM";
    expect(fxAt([t], [], 910, 905)).toBe(t); expect(fxAt([t], [], 700, 700)).toBeNull();
  });

  it("noise is deterministic and in [0, 1)", () => {
    for (let i = 0; i < 200; i++) { const v = fxNoise(i, 3); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); expect(fxNoise(i, 3)).toBe(v); }
  });
});
