/**
 * Phase 3.2: binary report parser.
 *
 * The spec's 12-byte layout is encoded as the DEFAULT profile. Real tablets
 * differ, so every field offset and bit index lives in a ReportProfile. The
 * parser is table-driven: swapping a profile changes no code.
 *
 * Default profile (from the spec):
 *   byte 0      reportId        0x01 pen, 0x02 express keys / dial
 *   bytes 1-2   status (u16 LE) bit0 tip, bit1 barrel1, bit2 barrel2, bit5 eraser
 *   bytes 3-4   x (u16 LE)      bytes 5-6 y (u16 LE)
 *   bytes 7-8   pressure (u16 LE, 0..16383)
 *   byte 9      tiltX (i8, degrees)   byte 10 tiltY (i8, degrees)
 *   byte 11     dial: 0x01 clockwise step, 0xFF counter-clockwise step, 0x00 none
 *
 * Assumptions, labeled:
 *   A1. Multi-byte fields are little-endian (HID convention). Profile field `littleEndian`.
 *   A2. The status word's "in range" bit is not specified. The default profile
 *       treats a pen report as in-range unless x and y are both 0xFFFF. Profile
 *       field `inRangeBit` overrides this when a device exposes one.
 *   A3. On report 0x02 the spec does not say where express-key bits live. The
 *       default profile reads bytes 1-2 as a u16 button bitmask; byte 11 is the dial.
 *   A4. Barrel rotation (Pencil Pro roll) has no byte in the spec; profile field
 *       `rotationOffset` is optional and null in the default profile.
 */

export interface ReportProfile {
  name: string;
  reportLength: number;
  littleEndian: boolean;
  penReportId: number;
  keysReportId: number;
  statusOffset: number; // u16
  tipBit: number;
  barrel1Bit: number;
  barrel2Bit: number;
  eraserBit: number;
  inRangeBit: number | null;
  xOffset: number; // u16
  yOffset: number; // u16
  xMax: number;
  yMax: number;
  pressureOffset: number; // u16
  pressureMax: number;
  tiltXOffset: number; // i8 degrees
  tiltYOffset: number; // i8 degrees
  tiltMaxDeg: number;
  rotationOffset: number | null; // u16, 0..rotationMax maps to 0..360 deg
  rotationMax: number;
  dialOffset: number; // u8
  dialCwValue: number;
  dialCcwValue: number;
  keysMaskOffset: number; // u16
}

export const DEFAULT_PROFILE: ReportProfile = {
  name: "omni-spec-default",
  reportLength: 12,
  littleEndian: true,
  penReportId: 0x01,
  keysReportId: 0x02,
  statusOffset: 1,
  tipBit: 0,
  barrel1Bit: 1,
  barrel2Bit: 2,
  eraserBit: 5,
  inRangeBit: null,
  xOffset: 3,
  yOffset: 5,
  xMax: 0xffff,
  yMax: 0xffff,
  pressureOffset: 7,
  pressureMax: 16_383,
  tiltXOffset: 9,
  tiltYOffset: 10,
  tiltMaxDeg: 60,
  rotationOffset: null,
  rotationMax: 0,
  dialOffset: 11,
  dialCwValue: 0x01,
  dialCcwValue: 0xff,
  keysMaskOffset: 1,
};

export interface PenSample {
  kind: "pen";
  /** performance.now() at receipt, milliseconds. */
  timestampMs: number;
  tip: boolean;
  barrel1: boolean;
  barrel2: boolean;
  eraser: boolean;
  inRange: boolean;
  /** Raw device units. */
  rawX: number;
  rawY: number;
  /** Normalized 0..1 in device space. The view transform applies downstream. */
  x: number;
  y: number;
  rawPressure: number;
  /** 0..1 */
  pressure: number;
  /** Degrees, clamped to ±tiltMaxDeg. */
  tiltXDeg: number;
  tiltYDeg: number;
  /** Degrees 0..360, or null when the profile has no rotation field. */
  rotationDeg: number | null;
  /** Raw status word for diagnostics. */
  status: number;
}

export interface DialEvent {
  kind: "dial";
  timestampMs: number;
  /** +1 clockwise, -1 counter-clockwise. */
  step: 1 | -1;
}

export interface KeysEvent {
  kind: "keys";
  timestampMs: number;
  /** Bitmask of currently pressed express keys. */
  mask: number;
  pressed: number[];
  released: number[];
}

export interface UnknownReport {
  kind: "unknown";
  timestampMs: number;
  reportId: number;
  length: number;
}

export type InputEvent = PenSample | DialEvent | KeysEvent | UnknownReport;

export class HidReportParser {
  readonly profile: ReportProfile;
  #lastKeysMask = 0;

  constructor(profile: ReportProfile = DEFAULT_PROFILE) {
    validateProfile(profile);
    this.profile = profile;
  }

  /**
   * Parses one report. `reportId` is the WebHID event's reportId; `data` is the
   * payload WITHOUT the leading report-ID byte (WebHID strips it). To keep the
   * spec's byte numbering, the parser prepends it internally.
   * Returns zero, one, or two events (a 0x02 report can carry both keys and dial).
   */
  parse(reportId: number, data: DataView, timestampMs: number): InputEvent[] {
    const p = this.profile;
    const full = new Uint8Array(data.byteLength + 1);
    full[0] = reportId & 0xff;
    full.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 1);
    if (full.byteLength < p.reportLength) {
      return [{ kind: "unknown", timestampMs, reportId, length: full.byteLength }];
    }
    const dv = new DataView(full.buffer);

    if (reportId === p.penReportId) return [this.#parsePen(dv, timestampMs)];
    if (reportId === p.keysReportId) return this.#parseKeys(dv, timestampMs);
    return [{ kind: "unknown", timestampMs, reportId, length: full.byteLength }];
  }

  #parsePen(dv: DataView, timestampMs: number): PenSample {
    const p = this.profile;
    const le = p.littleEndian;
    const status = dv.getUint16(p.statusOffset, le);
    const rawX = dv.getUint16(p.xOffset, le);
    const rawY = dv.getUint16(p.yOffset, le);
    const rawPressure = Math.min(dv.getUint16(p.pressureOffset, le), p.pressureMax);
    const tiltX = clamp(dv.getInt8(p.tiltXOffset), -p.tiltMaxDeg, p.tiltMaxDeg);
    const tiltY = clamp(dv.getInt8(p.tiltYOffset), -p.tiltMaxDeg, p.tiltMaxDeg);
    const inRange =
      p.inRangeBit !== null ? bit(status, p.inRangeBit) : !(rawX === 0xffff && rawY === 0xffff);
    let rotationDeg: number | null = null;
    if (p.rotationOffset !== null && p.rotationMax > 0) {
      rotationDeg = (dv.getUint16(p.rotationOffset, le) / p.rotationMax) * 360;
    }
    return {
      kind: "pen",
      timestampMs,
      tip: bit(status, p.tipBit),
      barrel1: bit(status, p.barrel1Bit),
      barrel2: bit(status, p.barrel2Bit),
      eraser: bit(status, p.eraserBit),
      inRange,
      rawX,
      rawY,
      x: rawX / p.xMax,
      y: rawY / p.yMax,
      rawPressure,
      pressure: rawPressure / p.pressureMax,
      tiltXDeg: tiltX,
      tiltYDeg: tiltY,
      rotationDeg,
      status,
    };
  }

  #parseKeys(dv: DataView, timestampMs: number): InputEvent[] {
    const p = this.profile;
    const out: InputEvent[] = [];
    const mask = dv.getUint16(p.keysMaskOffset, p.littleEndian);
    if (mask !== this.#lastKeysMask) {
      const changed = mask ^ this.#lastKeysMask;
      const pressed: number[] = [];
      const released: number[] = [];
      for (let i = 0; i < 16; i++) {
        if (!bit(changed, i)) continue;
        (bit(mask, i) ? pressed : released).push(i);
      }
      this.#lastKeysMask = mask;
      out.push({ kind: "keys", timestampMs, mask, pressed, released });
    }
    const dial = dv.getUint8(p.dialOffset);
    if (dial === p.dialCwValue) out.push({ kind: "dial", timestampMs, step: 1 });
    else if (dial === p.dialCcwValue) out.push({ kind: "dial", timestampMs, step: -1 });
    return out;
  }
}

function bit(word: number, index: number): boolean {
  return ((word >>> index) & 1) === 1;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function validateProfile(p: ReportProfile): void {
  const u16Fields: Array<[string, number]> = [
    ["statusOffset", p.statusOffset],
    ["xOffset", p.xOffset],
    ["yOffset", p.yOffset],
    ["pressureOffset", p.pressureOffset],
    ["keysMaskOffset", p.keysMaskOffset],
  ];
  if (p.rotationOffset !== null) u16Fields.push(["rotationOffset", p.rotationOffset]);
  for (const [name, off] of u16Fields) {
    if (off < 1 || off + 2 > p.reportLength) throw new RangeError(`${name} out of report bounds`);
  }
  for (const [name, off] of [
    ["tiltXOffset", p.tiltXOffset],
    ["tiltYOffset", p.tiltYOffset],
    ["dialOffset", p.dialOffset],
  ] as Array<[string, number]>) {
    if (off < 1 || off + 1 > p.reportLength) throw new RangeError(`${name} out of report bounds`);
  }
  for (const [name, b] of [
    ["tipBit", p.tipBit],
    ["barrel1Bit", p.barrel1Bit],
    ["barrel2Bit", p.barrel2Bit],
    ["eraserBit", p.eraserBit],
  ] as Array<[string, number]>) {
    if (b < 0 || b > 15) throw new RangeError(`${name} must be 0..15`);
  }
  if (p.pressureMax <= 0 || p.xMax <= 0 || p.yMax <= 0) throw new RangeError("max values must be > 0");
  if (p.penReportId === p.keysReportId) throw new RangeError("pen and keys report IDs must differ");
}

/**
 * Builds a profile from a WebHID collection's report descriptor when the device
 * exposes standard Digitizer usages (page 0x0D). Falls back to DEFAULT_PROFILE
 * when the descriptor lacks the needed usages. This is the "flexible matrix"
 * part of the spec: offsets come from the device, not from a constant table.
 *
 * Usage IDs (HID Usage Tables 1.4, Digitizers page 0x0D):
 *   0x30 Tip Pressure, 0x3D X Tilt, 0x3E Y Tilt, 0x41 Twist,
 *   0x42 Tip Switch, 0x44 Barrel Switch, 0x45 Invert, 0x32 In Range,
 *   0x5A Secondary Barrel Switch
 * Generic Desktop page 0x01: 0x30 X, 0x31 Y.
 */
export function profileFromCollections(collections: HIDCollectionInfo[]): ReportProfile | null {
  for (const c of collections) {
    for (const rep of c.inputReports ?? []) {
      let bitPos = 0;
      const found: Partial<ReportProfile> = { littleEndian: true };
      let bytes = 0;
      for (const item of rep.items ?? []) {
        const size = item.reportSize ?? 0;
        const count = item.reportCount ?? 1;
        const usages = item.usages ?? [];
        for (let i = 0; i < count; i++) {
          const usage = usages[i] ?? usages[0];
          const byteOff = 1 + (bitPos >> 3); // +1 keeps spec numbering (report ID at byte 0)
          const bitInByte = bitPos & 7;
          if (usage !== undefined && (bitPos & 7) === 0 && size === 16) {
            const page = usage >>> 16;
            const id = usage & 0xffff;
            if (page === 0x01 && id === 0x30) {
              found.xOffset = byteOff;
              found.xMax = item.logicalMaximum ?? 0xffff;
            } else if (page === 0x01 && id === 0x31) {
              found.yOffset = byteOff;
              found.yMax = item.logicalMaximum ?? 0xffff;
            } else if (page === 0x0d && id === 0x30) {
              found.pressureOffset = byteOff;
              found.pressureMax = item.logicalMaximum ?? 16_383;
            } else if (page === 0x0d && id === 0x41) {
              found.rotationOffset = byteOff;
              found.rotationMax = item.logicalMaximum ?? 0xffff;
            }
          } else if (usage !== undefined && (bitPos & 7) === 0 && size === 8) {
            const page = usage >>> 16;
            const id = usage & 0xffff;
            if (page === 0x0d && id === 0x3d) found.tiltXOffset = byteOff;
            if (page === 0x0d && id === 0x3e) found.tiltYOffset = byteOff;
          } else if (usage !== undefined && size === 1) {
            const page = usage >>> 16;
            const id = usage & 0xffff;
            if (page === 0x0d) {
              // status bits are assumed to live in a 16-bit word at byteOff
              found.statusOffset ??= byteOff;
              const relBit = (byteOff - (found.statusOffset ?? byteOff)) * 8 + bitInByte;
              if (id === 0x42) found.tipBit = relBit;
              if (id === 0x44) found.barrel1Bit = relBit;
              if (id === 0x5a) found.barrel2Bit = relBit;
              if (id === 0x45) found.eraserBit = relBit;
              if (id === 0x32) found.inRangeBit = relBit;
            }
          }
          bitPos += size;
        }
      }
      bytes = 1 + ((bitPos + 7) >> 3);
      const complete =
        found.xOffset !== undefined &&
        found.yOffset !== undefined &&
        found.pressureOffset !== undefined &&
        found.statusOffset !== undefined &&
        found.tipBit !== undefined;
      if (!complete) continue;
      const prof: ReportProfile = {
        ...DEFAULT_PROFILE,
        ...found,
        name: `descriptor-report-${rep.reportId ?? 0}`,
        reportLength: Math.max(bytes, DEFAULT_PROFILE.reportLength),
        penReportId: rep.reportId ?? DEFAULT_PROFILE.penReportId,
        tiltXOffset: found.tiltXOffset ?? DEFAULT_PROFILE.tiltXOffset,
        tiltYOffset: found.tiltYOffset ?? DEFAULT_PROFILE.tiltYOffset,
        rotationOffset: found.rotationOffset ?? null,
        rotationMax: found.rotationMax ?? 0,
        inRangeBit: found.inRangeBit ?? null,
      } as ReportProfile;
      try {
        validateProfile(prof);
        return prof;
      } catch {
        continue;
      }
    }
  }
  return null;
}
