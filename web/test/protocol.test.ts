import { describe, expect, it } from "vitest";
import { MsgType, Role, decode, encodeControl, encodeTelemetry, encodeTelemetryBatch, type TelemetrySample } from "../src/sync/protocol.js";

const s = (seq: number): TelemetrySample => ({ flags: 0b10001, strokeId: 42, seq, tSenderUs: 123456.5, x: 0.125, y: 0.875, pressure: 0.25, tiltX: -5, tiltY: 7, rotationCdeg: 0xffff });

describe("protocol", () => {
  it("telemetry single and batch round-trip", () => {
    const one = decode(encodeTelemetry(s(3)));
    expect(one.type).toBe(MsgType.Telemetry);
    if (one.type === MsgType.Telemetry) expect(one.samples[0]).toMatchObject({ strokeId: 42, seq: 3, tiltX: -5, rotationCdeg: 0xffff });
    const batch = decode(encodeTelemetryBatch([s(1), s(2), s(3)]));
    if (batch.type !== MsgType.TelemetryBatch) throw new Error();
    expect(batch.samples.map((x) => x.seq)).toEqual([1, 2, 3]);
    expect(() => encodeTelemetryBatch([])).toThrow();
  });

  it("control messages round-trip", () => {
    const msgs = [
      { type: MsgType.Hello, role: Role.Client, protocolVersion: 1, capabilities: 5 },
      { type: MsgType.Ping, id: 9, t0: 1.5 },
      { type: MsgType.Pong, id: 9, t0: 1.5, t1: 2.5, t2: 3.5 },
      { type: MsgType.StrokeBegin, strokeId: 1, layerId: 2, brushId: 3, toolFlags: 4, tUs: 5 },
      { type: MsgType.StrokeEnd, strokeId: 1, sampleCount: 100, tUs: 6 },
      { type: MsgType.StrokeAck, strokeId: 1, received: 98, missing: [4, 77] },
      { type: MsgType.StrokeResend, strokeId: 1, samples: [s(4), s(77)] },
      { type: MsgType.TileHash, layerId: 1, tileX: 2, tileY: 3, generation: 99n, digest: new Uint8Array(32).fill(7) },
      { type: MsgType.TilePatch, layerId: 1, tileX: 2, tileY: 3, generation: 99n, codec: 2, payload: new Uint8Array([1, 2, 3]) },
      { type: MsgType.StateSnapshot, payload: new Uint8Array([9, 9]) },
    ] as const;
    for (const m of msgs) expect(decode(encodeControl(m as never))).toEqual(m);
  });

  it("rejects truncated and unknown messages", () => {
    expect(() => decode(new ArrayBuffer(0))).toThrow();
    expect(() => decode(encodeTelemetry(s(0)).slice(0, 10))).toThrow();
    expect(() => decode(new Uint8Array([0x77]).buffer)).toThrow();
  });
});
