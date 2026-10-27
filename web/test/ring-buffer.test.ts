import { describe, expect, it } from "vitest";
import { InputRing, RING_HEADER_BYTES, RING_RECORD_BYTES } from "../src/input/ring-buffer.js";
import type { PenSample } from "../src/input/hid-parser.js";

const sample = (t: number): PenSample => ({
  kind: "pen", timestampMs: t, tip: true, barrel1: false, barrel2: true, eraser: false, inRange: true,
  rawX: 0, rawY: 0, x: 0.25, y: 0.75, rawPressure: 0, pressure: 0.5, tiltXDeg: -12, tiltYDeg: 33, rotationDeg: 90.5, status: 0,
});

describe("InputRing", () => {
  it("writes the documented 32-byte layout the C++ consumer expects", () => {
    const ring = InputRing.allocate(4);
    ring.push(sample(1.5));
    const dv = new DataView(ring.buffer, RING_HEADER_BYTES, RING_RECORD_BYTES);
    expect(dv.getFloat64(0, true)).toBe(1500);
    expect(dv.getFloat32(8, true)).toBeCloseTo(0.25);
    expect(dv.getFloat32(12, true)).toBeCloseTo(0.75);
    expect(dv.getFloat32(16, true)).toBeCloseTo(0.5);
    expect(dv.getInt8(20)).toBe(-12);
    expect(dv.getInt8(21)).toBe(33);
    expect(dv.getUint16(22, true)).toBe(9050);
    expect(dv.getUint8(24)).toBe(0b10101);
  });

  it("pops in order and overwrites oldest on overflow", () => {
    const ring = InputRing.allocate(4);
    for (let i = 0; i < 6; i++) ring.push(sample(i));
    expect(ring.length).toBe(4);
    expect(ring.dropped).toBe(2);
    expect(ring.pop()?.timestampMs).toBe(2);
    expect(ring.pop()?.timestampMs).toBe(3);
    ring.pop(); ring.pop();
    expect(ring.pop()).toBeNull();
  });
});
