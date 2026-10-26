/// <reference lib="webworker" />
/** Runs the redraw analysis off the main thread so the page stays responsive. */
import { trace, type TraceParams, type TraceResult } from "./trace-core.js";

self.onmessage = (e: MessageEvent<{ id: number; w: number; h: number; rgba: Uint8ClampedArray; params: Partial<TraceParams>; mask?: Uint8Array | null }>) => {
  const { id, w, h, rgba, params } = e.data; const mask = e.data.mask ?? null;
  try {
    const r: TraceResult = trace(rgba, w, h, params, (stage, pct) => (self as unknown as Worker).postMessage({ id, progress: { stage, pct } }), mask);
    const transfer: Transferable[] = [r.inkMask.buffer, r.soft.buffer]; if (r.mask) transfer.push(r.mask.buffer);
    for (const s of r.strokes) transfer.push(s.pts.buffer);
    for (const group of [r.inkFills, r.flats, r.shadows, r.highlights, ...r.tones.map((t) => t.shapes)]) for (const sh of group) for (const l of sh.loops) transfer.push(l.buffer);
    (self as unknown as Worker).postMessage({ id, result: r }, transfer);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: (err as Error).message || String(err) });
  }
};
