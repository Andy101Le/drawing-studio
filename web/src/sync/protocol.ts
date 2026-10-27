/**
 * Phase 4: OMNI-Bridge wire protocol.
 *
 * Two data channels per peer:
 *   "telemetry"  unordered, maxRetransmits 0   (stylus samples: a late packet is useless)
 *   "control"    ordered, reliable             (stroke begin/end, clock sync, corrections)
 *
 * All multi-byte fields little-endian. Every message starts with u8 type.
 *
 * TELEMETRY  (type 0x01, 32 bytes, one stylus sample)
 *   u8   type = 0x01
 *   u8   flags       bit0 tip, bit1 barrel1, bit2 barrel2, bit3 eraser, bit4 inRange
 *   u16  strokeId
 *   u32  seq         per-stroke sequence number, starts at 0
 *   f64  tSenderUs   sender's monotonic clock, converted on receipt with ClockSync
 *   f32  x, y        normalized canvas coordinates
 *   f32  pressure    0..1
 *   i8   tiltX, tiltY
 *   u16  rotationCdeg (0xFFFF = none)
 *
 * TELEMETRY_BATCH (type 0x02): u8 type, u8 count, then count × 31-byte sample
 *   bodies (same layout as TELEMETRY minus the type byte). Used when more than
 *   one sample is ready per send tick to amortize SCTP/DTLS overhead.
 *
 * CONTROL messages:
 *   0x10 HELLO        u8 type, u8 role (0 host, 1 client), u16 protocolVersion, u32 capabilities
 *   0x11 PING         u8 type, u32 id, f64 t0 (sender clock)
 *   0x12 PONG         u8 type, u32 id, f64 t0, f64 t1 (receive), f64 t2 (send)
 *   0x20 STROKE_BEGIN u8 type, u16 strokeId, u32 layerId, u32 brushId, u8 toolFlags, f64 tUs
 *   0x21 STROKE_END   u8 type, u16 strokeId, u32 sampleCount, f64 tUs
 *   0x22 STROKE_ACK   u8 type, u16 strokeId, u32 sampleCountReceived, u32 missingSeqCount,
 *                     then missingSeqCount × u32 missing seq (host asks for retransmit)
 *   0x23 STROKE_RESEND u8 type, u16 strokeId, u32 count, then count × 31-byte sample bodies
 *   0x30 TILE_HASH    u8 type, u32 layerId, u16 tileX, u16 tileY, u64 generation, [32] blake-ish SHA-256 digest
 *   0x31 TILE_PATCH   u8 type, u32 layerId, u16 tileX, u16 tileY, u64 generation, u8 codec, u32 byteLength, bytes
 *   0x40 STATE_SNAPSHOT u8 type, u32 byteLength, bytes (encrypted .omni manifest delta, AES-GCM per aead.ts)
 */

export const PROTOCOL_VERSION = 1;
export const TELEMETRY_BYTES = 32;
export const SAMPLE_BODY_BYTES = 31;
export const MAX_BATCH = 7; // 1 + 1 + 7*31 = 219 bytes, under a 256-byte budget per datagram

export enum MsgType {
  Telemetry = 0x01,
  TelemetryBatch = 0x02,
  Hello = 0x10,
  Ping = 0x11,
  Pong = 0x12,
  StrokeBegin = 0x20,
  StrokeEnd = 0x21,
  StrokeAck = 0x22,
  StrokeResend = 0x23,
  TileHash = 0x30,
  TilePatch = 0x31,
  StateSnapshot = 0x40,
}

export enum Role {
  Host = 0,
  Client = 1,
}

export interface TelemetrySample {
  flags: number;
  strokeId: number;
  seq: number;
  tSenderUs: number;
  x: number;
  y: number;
  pressure: number;
  tiltX: number;
  tiltY: number;
  rotationCdeg: number;
}

function writeSampleBody(dv: DataView, off: number, s: TelemetrySample): void {
  dv.setUint8(off + 0, s.flags & 0xff);
  dv.setUint16(off + 1, s.strokeId, true);
  dv.setUint32(off + 3, s.seq >>> 0, true);
  dv.setFloat64(off + 7, s.tSenderUs, true);
  dv.setFloat32(off + 15, s.x, true);
  dv.setFloat32(off + 19, s.y, true);
  dv.setFloat32(off + 23, s.pressure, true);
  dv.setInt8(off + 27, s.tiltX);
  dv.setInt8(off + 28, s.tiltY);
  dv.setUint16(off + 29, s.rotationCdeg, true);
}

function readSampleBody(dv: DataView, off: number): TelemetrySample {
  return {
    flags: dv.getUint8(off + 0),
    strokeId: dv.getUint16(off + 1, true),
    seq: dv.getUint32(off + 3, true),
    tSenderUs: dv.getFloat64(off + 7, true),
    x: dv.getFloat32(off + 15, true),
    y: dv.getFloat32(off + 19, true),
    pressure: dv.getFloat32(off + 23, true),
    tiltX: dv.getInt8(off + 27),
    tiltY: dv.getInt8(off + 28),
    rotationCdeg: dv.getUint16(off + 29, true),
  };
}

export function encodeTelemetry(s: TelemetrySample): ArrayBuffer {
  const buf = new ArrayBuffer(TELEMETRY_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, MsgType.Telemetry);
  writeSampleBody(dv, 1, s);
  return buf;
}

export function encodeTelemetryBatch(samples: TelemetrySample[]): ArrayBuffer {
  if (samples.length === 0 || samples.length > MAX_BATCH) throw new RangeError("batch size 1..MAX_BATCH");
  const buf = new ArrayBuffer(2 + samples.length * SAMPLE_BODY_BYTES);
  const dv = new DataView(buf);
  dv.setUint8(0, MsgType.TelemetryBatch);
  dv.setUint8(1, samples.length);
  samples.forEach((s, i) => writeSampleBody(dv, 2 + i * SAMPLE_BODY_BYTES, s));
  return buf;
}

export interface HelloMsg { type: MsgType.Hello; role: Role; protocolVersion: number; capabilities: number }
export interface PingMsg { type: MsgType.Ping; id: number; t0: number }
export interface PongMsg { type: MsgType.Pong; id: number; t0: number; t1: number; t2: number }
export interface StrokeBeginMsg { type: MsgType.StrokeBegin; strokeId: number; layerId: number; brushId: number; toolFlags: number; tUs: number }
export interface StrokeEndMsg { type: MsgType.StrokeEnd; strokeId: number; sampleCount: number; tUs: number }
export interface StrokeAckMsg { type: MsgType.StrokeAck; strokeId: number; received: number; missing: number[] }
export interface StrokeResendMsg { type: MsgType.StrokeResend; strokeId: number; samples: TelemetrySample[] }
export interface TileHashMsg { type: MsgType.TileHash; layerId: number; tileX: number; tileY: number; generation: bigint; digest: Uint8Array }
export interface TilePatchMsg { type: MsgType.TilePatch; layerId: number; tileX: number; tileY: number; generation: bigint; codec: number; payload: Uint8Array }
export interface StateSnapshotMsg { type: MsgType.StateSnapshot; payload: Uint8Array }
export interface TelemetryMsg { type: MsgType.Telemetry | MsgType.TelemetryBatch; samples: TelemetrySample[] }

export type Message =
  | HelloMsg | PingMsg | PongMsg | StrokeBeginMsg | StrokeEndMsg | StrokeAckMsg
  | StrokeResendMsg | TileHashMsg | TilePatchMsg | StateSnapshotMsg | TelemetryMsg;

export const TILE_CODEC_RAW_RGBA8 = 0;
export const TILE_CODEC_RAW_RGBA16F = 1;
export const TILE_CODEC_DEFLATE_RGBA8 = 2;

export function encodeControl(m: Exclude<Message, TelemetryMsg>): ArrayBuffer {
  switch (m.type) {
    case MsgType.Hello: {
      const b = new ArrayBuffer(8); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint8(1, m.role); dv.setUint16(2, m.protocolVersion, true); dv.setUint32(4, m.capabilities >>> 0, true);
      return b;
    }
    case MsgType.Ping: {
      const b = new ArrayBuffer(13); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint32(1, m.id >>> 0, true); dv.setFloat64(5, m.t0, true);
      return b;
    }
    case MsgType.Pong: {
      const b = new ArrayBuffer(29); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint32(1, m.id >>> 0, true);
      dv.setFloat64(5, m.t0, true); dv.setFloat64(13, m.t1, true); dv.setFloat64(21, m.t2, true);
      return b;
    }
    case MsgType.StrokeBegin: {
      const b = new ArrayBuffer(20); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint16(1, m.strokeId, true); dv.setUint32(3, m.layerId >>> 0, true);
      dv.setUint32(7, m.brushId >>> 0, true); dv.setUint8(11, m.toolFlags & 0xff); dv.setFloat64(12, m.tUs, true);
      return b;
    }
    case MsgType.StrokeEnd: {
      const b = new ArrayBuffer(15); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint16(1, m.strokeId, true); dv.setUint32(3, m.sampleCount >>> 0, true); dv.setFloat64(7, m.tUs, true);
      return b;
    }
    case MsgType.StrokeAck: {
      const b = new ArrayBuffer(11 + m.missing.length * 4); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint16(1, m.strokeId, true); dv.setUint32(3, m.received >>> 0, true); dv.setUint32(7, m.missing.length, true);
      m.missing.forEach((s, i) => dv.setUint32(11 + i * 4, s >>> 0, true));
      return b;
    }
    case MsgType.StrokeResend: {
      const b = new ArrayBuffer(7 + m.samples.length * SAMPLE_BODY_BYTES); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint16(1, m.strokeId, true); dv.setUint32(3, m.samples.length, true);
      m.samples.forEach((s, i) => writeSampleBody(dv, 7 + i * SAMPLE_BODY_BYTES, s));
      return b;
    }
    case MsgType.TileHash: {
      if (m.digest.byteLength !== 32) throw new RangeError("digest must be 32 bytes");
      const b = new ArrayBuffer(49); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint32(1, m.layerId >>> 0, true); dv.setUint16(5, m.tileX, true); dv.setUint16(7, m.tileY, true);
      dv.setBigUint64(9, m.generation, true); new Uint8Array(b, 17, 32).set(m.digest);
      return b;
    }
    case MsgType.TilePatch: {
      const b = new ArrayBuffer(22 + m.payload.byteLength); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint32(1, m.layerId >>> 0, true); dv.setUint16(5, m.tileX, true); dv.setUint16(7, m.tileY, true);
      dv.setBigUint64(9, m.generation, true); dv.setUint8(17, m.codec); dv.setUint32(18, m.payload.byteLength, true);
      new Uint8Array(b, 22).set(m.payload);
      return b;
    }
    case MsgType.StateSnapshot: {
      const b = new ArrayBuffer(5 + m.payload.byteLength); const dv = new DataView(b);
      dv.setUint8(0, m.type); dv.setUint32(1, m.payload.byteLength, true); new Uint8Array(b, 5).set(m.payload);
      return b;
    }
  }
}

export function decode(buf: ArrayBuffer): Message {
  const dv = new DataView(buf);
  if (buf.byteLength < 1) throw new RangeError("empty message");
  const type = dv.getUint8(0) as MsgType;
  const need = (n: number) => { if (buf.byteLength < n) throw new RangeError(`message 0x${type.toString(16)} truncated`); };
  switch (type) {
    case MsgType.Telemetry:
      need(TELEMETRY_BYTES);
      return { type, samples: [readSampleBody(dv, 1)] };
    case MsgType.TelemetryBatch: {
      need(2);
      const count = dv.getUint8(1);
      if (count === 0 || count > MAX_BATCH) throw new RangeError("bad batch count");
      need(2 + count * SAMPLE_BODY_BYTES);
      const samples: TelemetrySample[] = [];
      for (let i = 0; i < count; i++) samples.push(readSampleBody(dv, 2 + i * SAMPLE_BODY_BYTES));
      return { type, samples };
    }
    case MsgType.Hello:
      need(8);
      return { type, role: dv.getUint8(1) as Role, protocolVersion: dv.getUint16(2, true), capabilities: dv.getUint32(4, true) };
    case MsgType.Ping:
      need(13);
      return { type, id: dv.getUint32(1, true), t0: dv.getFloat64(5, true) };
    case MsgType.Pong:
      need(29);
      return { type, id: dv.getUint32(1, true), t0: dv.getFloat64(5, true), t1: dv.getFloat64(13, true), t2: dv.getFloat64(21, true) };
    case MsgType.StrokeBegin:
      need(20);
      return { type, strokeId: dv.getUint16(1, true), layerId: dv.getUint32(3, true), brushId: dv.getUint32(7, true), toolFlags: dv.getUint8(11), tUs: dv.getFloat64(12, true) };
    case MsgType.StrokeEnd:
      need(15);
      return { type, strokeId: dv.getUint16(1, true), sampleCount: dv.getUint32(3, true), tUs: dv.getFloat64(7, true) };
    case MsgType.StrokeAck: {
      need(11);
      const n = dv.getUint32(7, true);
      need(11 + n * 4);
      const missing: number[] = [];
      for (let i = 0; i < n; i++) missing.push(dv.getUint32(11 + i * 4, true));
      return { type, strokeId: dv.getUint16(1, true), received: dv.getUint32(3, true), missing };
    }
    case MsgType.StrokeResend: {
      need(7);
      const n = dv.getUint32(3, true);
      need(7 + n * SAMPLE_BODY_BYTES);
      const samples: TelemetrySample[] = [];
      for (let i = 0; i < n; i++) samples.push(readSampleBody(dv, 7 + i * SAMPLE_BODY_BYTES));
      return { type, strokeId: dv.getUint16(1, true), samples };
    }
    case MsgType.TileHash:
      need(49);
      return { type, layerId: dv.getUint32(1, true), tileX: dv.getUint16(5, true), tileY: dv.getUint16(7, true), generation: dv.getBigUint64(9, true), digest: new Uint8Array(buf.slice(17, 49)) };
    case MsgType.TilePatch: {
      need(22);
      const len = dv.getUint32(18, true);
      need(22 + len);
      return { type, layerId: dv.getUint32(1, true), tileX: dv.getUint16(5, true), tileY: dv.getUint16(7, true), generation: dv.getBigUint64(9, true), codec: dv.getUint8(17), payload: new Uint8Array(buf.slice(22, 22 + len)) };
    }
    case MsgType.StateSnapshot: {
      need(5);
      const len = dv.getUint32(1, true);
      need(5 + len);
      return { type, payload: new Uint8Array(buf.slice(5, 5 + len)) };
    }
    default:
      throw new RangeError(`unknown message type 0x${(type as number).toString(16)}`);
  }
}
