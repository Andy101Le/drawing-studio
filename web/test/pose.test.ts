import { describe, it, expect } from "vitest";
import { POSE_PRESETS, mirrorPose, moveJoint, fitPose, hitJoint } from "../app/engine/pose.js";

describe("pose skeleton", () => {
  it("presets have 18 joints inside the frame", () => {
    for (const [name, make] of Object.entries(POSE_PRESETS)) {
      const p = make(); expect(p.pts.length, name).toBe(18);
      for (const q of p.pts) { expect(q.x).toBeGreaterThanOrEqual(0); expect(q.x).toBeLessThanOrEqual(1); expect(q.y).toBeGreaterThanOrEqual(0); expect(q.y).toBeLessThanOrEqual(1); }
    }
  });
  it("mirror swaps sides and flips x", () => {
    const p = POSE_PRESETS.punching!(); const m = mirrorPose(p);
    expect(m.pts[2]!.x).toBeCloseTo(1 - p.pts[5]!.x); // right shoulder <- left shoulder
    expect(m.pts[4]!.y).toBeCloseTo(p.pts[7]!.y);
    expect(mirrorPose(m).pts[3]!.x).toBeCloseTo(p.pts[3]!.x);
  });
  it("moving a shoulder with carry drags the elbow and wrist along", () => {
    const p = POSE_PRESETS.standing!();
    const moved = moveJoint(p, 2, p.pts[2]!.x + 0.1, p.pts[2]!.y, true);
    expect(moved.pts[3]!.x).toBeCloseTo(p.pts[3]!.x + 0.1); expect(moved.pts[4]!.x).toBeCloseTo(p.pts[4]!.x + 0.1);
    const alone = moveJoint(p, 2, p.pts[2]!.x + 0.1, p.pts[2]!.y, false);
    expect(alone.pts[3]!.x).toBeCloseTo(p.pts[3]!.x);
  });
  it("fits a wide frame by narrowing x about the centre", () => {
    const p = POSE_PRESETS.standing!(); const f = fitPose(p, 2);
    expect(f.pts[10]!.y).toBeCloseTo(p.pts[10]!.y);
    expect(Math.abs(f.pts[2]!.x - 0.5)).toBeLessThan(Math.abs(p.pts[2]!.x - 0.5));
    expect(hitJoint(f, f.pts[0]!.x, f.pts[0]!.y, 0.02)).toBe(0);
  });
});
