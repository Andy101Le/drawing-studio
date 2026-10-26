/**
 * Phase 4.2: clock offset estimation between iPad and host (NTP-style).
 *
 * Each ping gives four timestamps:
 *   t0 sender sends, t1 receiver gets, t2 receiver replies, t3 sender gets reply.
 *   offset = ((t1 - t0) + (t2 - t3)) / 2        (receiver clock minus sender clock)
 *   rtt    = (t3 - t0) - (t2 - t1)
 *
 * Wi-Fi jitter makes single samples useless, so the estimator keeps the last
 * N samples and takes the offset from the sample with the smallest RTT (that
 * one had the least queueing, so its symmetric-delay assumption is the best).
 * The spread of RTT across the window is the jitter metric surfaced to the UI.
 */

export interface ClockSample {
  offsetUs: number;
  rttUs: number;
  atUs: number;
}

export class ClockSync {
  readonly #window: ClockSample[] = [];
  readonly #maxSamples: number;
  #offsetUs = 0;
  #ready = false;

  constructor(maxSamples = 32) {
    this.#maxSamples = maxSamples;
  }

  /** All times in microseconds on each side's performance.now()*1000 clock. */
  addRoundTrip(t0: number, t1: number, t2: number, t3: number): ClockSample {
    const rtt = t3 - t0 - (t2 - t1);
    const offset = (t1 - t0 + (t2 - t3)) / 2;
    const s: ClockSample = { offsetUs: offset, rttUs: Math.max(0, rtt), atUs: t3 };
    this.#window.push(s);
    if (this.#window.length > this.#maxSamples) this.#window.shift();
    let best = this.#window[0] as ClockSample;
    for (const c of this.#window) if (c.rttUs < best.rttUs) best = c;
    // Slew toward the best estimate instead of jumping, so timestamps stay monotonic.
    this.#offsetUs = this.#ready ? this.#offsetUs + 0.25 * (best.offsetUs - this.#offsetUs) : best.offsetUs;
    this.#ready = true;
    return s;
  }

  get ready(): boolean {
    return this.#ready;
  }
  /** Remote clock = local clock + offset. */
  get offsetUs(): number {
    return this.#offsetUs;
  }
  get minRttUs(): number {
    return this.#window.reduce((m, s) => Math.min(m, s.rttUs), Number.POSITIVE_INFINITY);
  }
  get p50RttUs(): number {
    return percentile(this.#window.map((s) => s.rttUs), 0.5);
  }
  get p99RttUs(): number {
    return percentile(this.#window.map((s) => s.rttUs), 0.99);
  }
  get jitterUs(): number {
    return this.#window.length ? this.p99RttUs - this.minRttUs : 0;
  }

  toRemoteUs(localUs: number): number {
    return localUs + this.#offsetUs;
  }
  toLocalUs(remoteUs: number): number {
    return remoteUs - this.#offsetUs;
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx] as number;
}
