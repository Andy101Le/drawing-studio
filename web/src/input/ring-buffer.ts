/**
 * Phase 3.1: single-producer single-consumer ring buffer over SharedArrayBuffer.
 *
 * Producer: the input thread (main thread WebHID handler, or an input worker).
 * Consumer: the C++ core compiled with Emscripten + pthreads. The core's Wasm
 * memory IS a SharedArrayBuffer when threads are enabled, so the ring lives
 * inside it (allocate with omni_input_ring_alloc in the core) and no copy
 * crosses the JS/Wasm boundary: JS writes records, C++ reads them with the
 * same atomics. Record layout mirrors core/include/omni/input_record.hpp.
 *
 * Memory layout:
 *   [0..4)    u32 head   (producer write index, monotonically increasing)
 *   [4..8)    u32 tail   (consumer read index)
 *   [8..12)   u32 capacity (power of two, number of records)
 *   [12..16)  u32 dropped (count of records dropped on overflow)
 *   [64..)    records, 32 bytes each
 *
 * Record (32 bytes, little-endian):
 *   f64 timestampUs    0
 *   f32 x              8     normalized 0..1
 *   f32 y             12
 *   f32 pressure      16     0..1
 *   i8  tiltX         20     degrees
 *   i8  tiltY         21
 *   u16 rotation      22     0.01 degree units, 0xFFFF = none
 *   u8  flags         24     bit0 tip, bit1 barrel1, bit2 barrel2, bit3 eraser, bit4 inRange
 *   u8  reserved      25..31
 *
 * Overflow policy: drop oldest (overwrite). For a drawing app a late sample is
 * worth less than a fresh one; the dropped counter feeds telemetry.
 */

import type { PenSample } from "./hid-parser.js";

export const RING_HEADER_BYTES = 64;
export const RING_RECORD_BYTES = 32;

const IDX_HEAD = 0;
const IDX_TAIL = 1;
const IDX_CAP = 2;
const IDX_DROPPED = 3;

export class InputRing {
  readonly #ctrl: Int32Array;
  readonly #data: DataView;
  readonly #capacity: number;
  readonly #mask: number;

  /** Capacity must be a power of two. 1024 records = 32 KiB, ~5 s at 200 Hz. */
  static allocate(capacity = 1024): InputRing {
    if ((capacity & (capacity - 1)) !== 0 || capacity === 0) throw new RangeError("capacity must be a power of two");
    const sab = new SharedArrayBuffer(RING_HEADER_BYTES + capacity * RING_RECORD_BYTES);
    const ctrl = new Int32Array(sab, 0, 16);
    Atomics.store(ctrl, IDX_CAP, capacity);
    return new InputRing(sab, 0);
  }

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, byteOffset: number) {
    this.#ctrl = new Int32Array(buffer, byteOffset, 16);
    this.#capacity = Atomics.load(this.#ctrl, IDX_CAP);
    if (this.#capacity === 0) throw new RangeError("ring not initialized");
    this.#mask = this.#capacity - 1;
    this.#data = new DataView(buffer, byteOffset + RING_HEADER_BYTES, this.#capacity * RING_RECORD_BYTES);
  }

  get buffer(): ArrayBufferLike {
    return this.#ctrl.buffer;
  }
  get capacity(): number {
    return this.#capacity;
  }
  get dropped(): number {
    return Atomics.load(this.#ctrl, IDX_DROPPED) >>> 0;
  }
  get length(): number {
    return ((Atomics.load(this.#ctrl, IDX_HEAD) >>> 0) - (Atomics.load(this.#ctrl, IDX_TAIL) >>> 0)) >>> 0;
  }

  push(s: PenSample): void {
    const head = Atomics.load(this.#ctrl, IDX_HEAD) >>> 0;
    const tail = Atomics.load(this.#ctrl, IDX_TAIL) >>> 0;
    if (((head - tail) >>> 0) >= this.#capacity) {
      // overwrite oldest: advance tail by one
      Atomics.store(this.#ctrl, IDX_TAIL, (tail + 1) | 0);
      Atomics.add(this.#ctrl, IDX_DROPPED, 1);
    }
    const off = (head & this.#mask) * RING_RECORD_BYTES;
    const dv = this.#data;
    dv.setFloat64(off + 0, s.timestampMs * 1000, true);
    dv.setFloat32(off + 8, s.x, true);
    dv.setFloat32(off + 12, s.y, true);
    dv.setFloat32(off + 16, s.pressure, true);
    dv.setInt8(off + 20, Math.round(s.tiltXDeg));
    dv.setInt8(off + 21, Math.round(s.tiltYDeg));
    dv.setUint16(off + 22, s.rotationDeg === null ? 0xffff : Math.round(s.rotationDeg * 100) % 36000, true);
    let flags = 0;
    if (s.tip) flags |= 1;
    if (s.barrel1) flags |= 2;
    if (s.barrel2) flags |= 4;
    if (s.eraser) flags |= 8;
    if (s.inRange) flags |= 16;
    dv.setUint8(off + 24, flags);
    for (let i = 25; i < 32; i++) dv.setUint8(off + i, 0);
    Atomics.store(this.#ctrl, IDX_HEAD, (head + 1) | 0);
    Atomics.notify(this.#ctrl, IDX_HEAD, 1);
  }

  /** Consumer side (used by tests and by a JS fallback when the core is absent). */
  pop(): PenSample | null {
    const head = Atomics.load(this.#ctrl, IDX_HEAD) >>> 0;
    const tail = Atomics.load(this.#ctrl, IDX_TAIL) >>> 0;
    if (head === tail) return null;
    const off = (tail & this.#mask) * RING_RECORD_BYTES;
    const dv = this.#data;
    const flags = dv.getUint8(off + 24);
    const rot = dv.getUint16(off + 22, true);
    const sample: PenSample = {
      kind: "pen",
      timestampMs: dv.getFloat64(off + 0, true) / 1000,
      x: dv.getFloat32(off + 8, true),
      y: dv.getFloat32(off + 12, true),
      pressure: dv.getFloat32(off + 16, true),
      tiltXDeg: dv.getInt8(off + 20),
      tiltYDeg: dv.getInt8(off + 21),
      rotationDeg: rot === 0xffff ? null : rot / 100,
      tip: (flags & 1) !== 0,
      barrel1: (flags & 2) !== 0,
      barrel2: (flags & 4) !== 0,
      eraser: (flags & 8) !== 0,
      inRange: (flags & 16) !== 0,
      rawX: 0,
      rawY: 0,
      rawPressure: 0,
      status: 0,
    };
    Atomics.store(this.#ctrl, IDX_TAIL, (tail + 1) | 0);
    return sample;
  }
}
