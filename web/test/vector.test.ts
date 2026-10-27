import { describe, expect, it } from "vitest";
import { densify, outline, rdp, resample, tween } from "../app/engine/vector.js";
import { pressureCurve } from "../app/engine/brush.js";

describe("vector paths", () => {
  it("RDP keeps endpoints and drops collinear points", () => {
    const pts = Array.from({ length: 50 }, (_, i) => ({ x: i, y: i * 0.5 + (i === 25 ? 10 : 0), p: 1 }));
    const out = rdp(pts, 1);
    expect(out[0]).toEqual(pts[0]); expect(out[out.length - 1]).toEqual(pts[49]);
    expect(out.length).toBeLessThan(8); expect(out.some((q) => q.x === 25)).toBe(true);
  });
  it("resample is arc-length uniform and tween blends positions", () => {
    const a = { id: 1, color: "#000", closed: false, width: 4, points: [{ x: 0, y: 0, p: 1 }, { x: 100, y: 0, p: 1 }] };
    const b = { id: 1, color: "#000", closed: false, width: 8, points: [{ x: 0, y: 50, p: 1 }, { x: 50, y: 50, p: 1 }, { x: 100, y: 50, p: 1 }] };
    const r = resample(a.points, 5);
    expect(r.map((q) => Math.round(q.x))).toEqual([0, 25, 50, 75, 100]);
    const t = tween(a, b, 0.5);
    expect(t.width).toBe(6);
    expect(t.points.every((q) => Math.abs(q.y - 25) < 1e-6)).toBe(true);
  });
  it("outline is a closed polygon wider at higher pressure", () => {
    const path = { id: 2, color: "#000", closed: false, width: 10, points: [{ x: 0, y: 0, p: 0.1 }, { x: 50, y: 0, p: 0.5 }, { x: 100, y: 0, p: 1 }] };
    const poly = outline(path);
    expect(poly.length).toBeGreaterThan(20);
    const near = (x: number) => poly.filter((q) => Math.abs(q.x - x) < 3).map((q) => q.y);
    const spread = (ys: number[]) => Math.max(...ys) - Math.min(...ys);
    expect(spread(near(90))).toBeGreaterThan(spread(near(10)));
    expect(densify(path.points, 4).length).toBe(9);
  });
  it("pressure curve is monotonic and hits the endpoints", () => {
    const c: [number, number, number, number] = [0.35, 0.1, 0.65, 0.95];
    expect(pressureCurve(0, c)).toBeCloseTo(0, 3); expect(pressureCurve(1, c)).toBeCloseTo(1, 3);
    let prev = 0; for (let x = 0; x <= 1; x += 0.05) { const y = pressureCurve(x, c); expect(y).toBeGreaterThanOrEqual(prev - 1e-9); prev = y; }
    expect(pressureCurve(0.5, [0.33, 0.33, 0.66, 0.66])).toBeCloseTo(0.5, 2);
  });
});
