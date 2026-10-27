import { describe, expect, it } from "vitest";
import { ClockSync } from "../src/sync/clock-sync.js";
import { ReceiverStrokeTracker, SenderStrokeBuffer } from "../src/sync/stroke-tracker.js";
import type { TelemetrySample } from "../src/sync/protocol.js";

describe("ClockSync", () => {
  it("picks the lowest-RTT sample and converges", () => {
    const c = new ClockSync();
    // true offset +5000us, symmetric delay 1000us, with jitter spikes
    c.addRoundTrip(0, 6000, 6100, 2100);          // rtt 2000
    c.addRoundTrip(100_000, 125_000, 125_050, 150_050); // spike: rtt 50000, offset biased
    c.addRoundTrip(200_000, 205_500, 205_600, 201_100); // rtt 1000, best
    expect(c.minRttUs).toBe(1000);
    expect(Math.abs(c.offsetUs - 5000)).toBeLessThan(1000);
    expect(c.jitterUs).toBeGreaterThan(40_000);
    expect(c.toRemoteUs(1000) - 1000).toBeCloseTo(c.offsetUs);
  });
});

describe("stroke loss accounting", () => {
  const s = (seq: number): TelemetrySample => ({ flags: 1, strokeId: 7, seq, tSenderUs: seq, x: 0, y: 0, pressure: 0, tiltX: 0, tiltY: 0, rotationCdeg: 0 });

  it("computes gaps and resolves them with resend", () => {
    const sender = new SenderStrokeBuffer();
    const recv = new ReceiverStrokeTracker();
    sender.begin(7); recv.begin(7);
    for (let i = 0; i < 10; i++) { sender.record(s(i)); if (i !== 3 && i !== 8) recv.accept(s(i)); }
    expect(recv.accept(s(5))).toBe(false); // duplicate
    const missing = recv.end(7, 10);
    expect(missing).toEqual([3, 8]);
    expect(recv.isComplete(7)).toBe(false);
    expect(recv.lossRatio(7)).toBeCloseTo(0.2);
    for (const r of sender.lookup(7, missing)) recv.accept(r);
    expect(recv.isComplete(7)).toBe(true);
    expect(recv.ordered(7).map((x) => x.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("sender retains only the newest strokes", () => {
    const sender = new SenderStrokeBuffer(2);
    for (const id of [1, 2, 3]) { sender.begin(id); sender.record({ ...s(0), strokeId: id }); }
    expect(sender.count(1)).toBe(0);
    expect(sender.count(3)).toBe(1);
  });
});
