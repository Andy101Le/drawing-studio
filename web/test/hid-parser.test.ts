import { describe, expect, it } from "vitest";
import { DEFAULT_PROFILE, HidReportParser, profileFromCollections, validateProfile } from "../src/input/hid-parser.js";

function penReport(opts: { status: number; x: number; y: number; p: number; tx: number; ty: number }): DataView {
  const b = new Uint8Array(11); // WebHID payload without report ID
  const dv = new DataView(b.buffer);
  dv.setUint16(0, opts.status, true);
  dv.setUint16(2, opts.x, true);
  dv.setUint16(4, opts.y, true);
  dv.setUint16(6, opts.p, true);
  dv.setInt8(8, opts.tx);
  dv.setInt8(9, opts.ty);
  dv.setUint8(10, 0);
  return dv;
}

describe("HID parser (spec default profile)", () => {
  it("decodes a pen report byte-for-byte per spec 3.2", () => {
    const p = new HidReportParser();
    const [ev] = p.parse(0x01, penReport({ status: 0b100111, x: 0x8000, y: 0xffff, p: 16383, tx: -60, ty: 45 }), 5);
    expect(ev?.kind).toBe("pen");
    if (ev?.kind !== "pen") return;
    expect(ev.tip).toBe(true);
    expect(ev.barrel1).toBe(true);
    expect(ev.barrel2).toBe(true);
    expect(ev.eraser).toBe(true);
    expect(ev.rawX).toBe(0x8000);
    expect(ev.x).toBeCloseTo(0x8000 / 0xffff, 6);
    expect(ev.y).toBe(1);
    expect(ev.pressure).toBe(1);
    expect(ev.tiltXDeg).toBe(-60);
    expect(ev.tiltYDeg).toBe(45);
    expect(ev.inRange).toBe(true);
  });

  it("clamps pressure and tilt, flags out-of-range at 0xFFFF/0xFFFF", () => {
    const p = new HidReportParser();
    const [ev] = p.parse(0x01, penReport({ status: 0, x: 0xffff, y: 0xffff, p: 60000, tx: 127, ty: -128 }), 0);
    if (ev?.kind !== "pen") throw new Error("expected pen");
    expect(ev.rawPressure).toBe(16383);
    expect(ev.tiltXDeg).toBe(60);
    expect(ev.tiltYDeg).toBe(-60);
    expect(ev.inRange).toBe(false);
  });

  it("emits keys edges and dial steps from report 0x02", () => {
    const p = new HidReportParser();
    const mk = (mask: number, dial: number) => {
      const b = new Uint8Array(11);
      new DataView(b.buffer).setUint16(0, mask, true);
      b[10] = dial;
      return new DataView(b.buffer);
    };
    let evs = p.parse(0x02, mk(0b0101, 0x01), 0);
    expect(evs.map((e) => e.kind)).toEqual(["keys", "dial"]);
    expect(evs[0]).toMatchObject({ pressed: [0, 2], released: [] });
    expect(evs[1]).toMatchObject({ step: 1 });
    evs = p.parse(0x02, mk(0b0100, 0xff), 1);
    expect(evs[0]).toMatchObject({ pressed: [], released: [0] });
    expect(evs[1]).toMatchObject({ step: -1 });
    evs = p.parse(0x02, mk(0b0100, 0x00), 2);
    expect(evs).toEqual([]);
  });

  it("reports unknown IDs and short packets without throwing", () => {
    const p = new HidReportParser();
    expect(p.parse(0x09, penReport({ status: 0, x: 0, y: 0, p: 0, tx: 0, ty: 0 }), 0)[0]?.kind).toBe("unknown");
    expect(p.parse(0x01, new DataView(new ArrayBuffer(3)), 0)[0]?.kind).toBe("unknown");
  });

  it("validates profiles", () => {
    expect(() => validateProfile({ ...DEFAULT_PROFILE, pressureOffset: 11 })).toThrow();
    expect(() => validateProfile({ ...DEFAULT_PROFILE, keysReportId: 1 })).toThrow();
  });

  it("builds a profile from a digitizer report descriptor", () => {
    const usage = (page: number, id: number) => (page << 16) | id;
    const collections = [
      {
        usagePage: 0x0d, usage: 0x02, type: 1, children: [], featureReports: [], outputReports: [],
        inputReports: [{
          reportId: 7,
          items: [
            { reportSize: 1, reportCount: 8, usages: [usage(0x0d, 0x42), usage(0x0d, 0x44), usage(0x0d, 0x5a), 0, 0, usage(0x0d, 0x45), usage(0x0d, 0x32), 0] },
            { reportSize: 8, reportCount: 1, usages: [] },
            { reportSize: 16, reportCount: 1, usages: [usage(0x01, 0x30)], logicalMaximum: 50000 },
            { reportSize: 16, reportCount: 1, usages: [usage(0x01, 0x31)], logicalMaximum: 30000 },
            { reportSize: 16, reportCount: 1, usages: [usage(0x0d, 0x30)], logicalMaximum: 8191 },
            { reportSize: 8, reportCount: 1, usages: [usage(0x0d, 0x3d)] },
            { reportSize: 8, reportCount: 1, usages: [usage(0x0d, 0x3e)] },
            { reportSize: 8, reportCount: 1, usages: [] },
          ],
        }],
      },
    ] as unknown as HIDCollectionInfo[];
    const prof = profileFromCollections(collections);
    expect(prof).not.toBeNull();
    expect(prof).toMatchObject({ penReportId: 7, xOffset: 3, yOffset: 5, pressureOffset: 7, pressureMax: 8191, tiltXOffset: 9, tiltYOffset: 10, tipBit: 0, barrel1Bit: 1, barrel2Bit: 2, eraserBit: 5, inRangeBit: 6, xMax: 50000 });
  });
});
