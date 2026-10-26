/**
 * Phase 4.2: loss accounting for the unreliable telemetry channel.
 *
 * Sender side (iPad / client): keeps every sample of the last `retain` strokes so
 * the host can request specific seqs after STROKE_END.
 * Receiver side (host): records which seqs arrived; at STROKE_END computes the
 * gap list → STROKE_ACK. Once the resend lands, the host re-runs the stroke
 * through the authoritative brush engine and, if the tile digests differ from
 * what the client drew with its lossy copy, sends TILE_PATCH corrections.
 */

import type { TelemetrySample } from "./protocol.js";

export class SenderStrokeBuffer {
  readonly #strokes = new Map<number, TelemetrySample[]>();
  readonly #order: number[] = [];
  readonly #retain: number;

  constructor(retainStrokes = 8) {
    this.#retain = retainStrokes;
  }

  begin(strokeId: number): void {
    this.#strokes.set(strokeId, []);
    this.#order.push(strokeId);
    while (this.#order.length > this.#retain) {
      const old = this.#order.shift();
      if (old !== undefined) this.#strokes.delete(old);
    }
  }

  record(s: TelemetrySample): void {
    const arr = this.#strokes.get(s.strokeId);
    if (!arr) return;
    arr.push(s);
  }

  count(strokeId: number): number {
    return this.#strokes.get(strokeId)?.length ?? 0;
  }

  lookup(strokeId: number, seqs: number[]): TelemetrySample[] {
    const arr = this.#strokes.get(strokeId);
    if (!arr) return [];
    const want = new Set(seqs);
    return arr.filter((s) => want.has(s.seq));
  }
}

export interface ReceiverStrokeState {
  strokeId: number;
  expected: number | null; // from STROKE_END
  received: Set<number>;
  samples: Map<number, TelemetrySample>;
  highestSeq: number;
}

export class ReceiverStrokeTracker {
  readonly #strokes = new Map<number, ReceiverStrokeState>();

  begin(strokeId: number): void {
    this.#strokes.set(strokeId, { strokeId, expected: null, received: new Set(), samples: new Map(), highestSeq: -1 });
  }

  /** Returns false for duplicates or unknown strokes. */
  accept(s: TelemetrySample): boolean {
    const st = this.#strokes.get(s.strokeId);
    if (!st) return false;
    if (st.received.has(s.seq)) return false;
    st.received.add(s.seq);
    st.samples.set(s.seq, s);
    if (s.seq > st.highestSeq) st.highestSeq = s.seq;
    return true;
  }

  /** Called on STROKE_END. Returns the missing seq list (empty = complete). */
  end(strokeId: number, sampleCount: number): number[] {
    const st = this.#strokes.get(strokeId);
    if (!st) return [];
    st.expected = sampleCount;
    return this.missing(strokeId);
  }

  missing(strokeId: number): number[] {
    const st = this.#strokes.get(strokeId);
    if (!st || st.expected === null) return [];
    const out: number[] = [];
    for (let i = 0; i < st.expected; i++) if (!st.received.has(i)) out.push(i);
    return out;
  }

  isComplete(strokeId: number): boolean {
    const st = this.#strokes.get(strokeId);
    return !!st && st.expected !== null && st.received.size === st.expected;
  }

  /** Ordered samples for the authoritative replay. */
  ordered(strokeId: number): TelemetrySample[] {
    const st = this.#strokes.get(strokeId);
    if (!st) return [];
    return [...st.samples.keys()].sort((a, b) => a - b).map((k) => st.samples.get(k) as TelemetrySample);
  }

  forget(strokeId: number): void {
    this.#strokes.delete(strokeId);
  }

  lossRatio(strokeId: number): number {
    const st = this.#strokes.get(strokeId);
    if (!st || st.expected === null || st.expected === 0) return 0;
    return 1 - st.received.size / st.expected;
  }
}
