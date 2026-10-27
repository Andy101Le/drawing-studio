/**
 * Rolling performance numbers from real use (no synthetic load): CPU time of each repaint and
 * the interval between animation frames, over the last ~10 s. Shown in Settings > Performance so
 * the numbers can be compared on the machine that matters, in both compositor modes.
 *
 * Note: in WebGPU mode `render` is CPU submit time only; the GPU finishes asynchronously.
 */
const N = 600;
class Ring {
  private a = new Float32Array(N); private n = 0; private i = 0;
  push(v: number): void { this.a[this.i] = v; this.i = (this.i + 1) % N; if (this.n < N) this.n++; }
  values(): number[] { return Array.from(this.a.subarray(0, this.n)); }
  pct(p: number): number { const v = this.values().sort((x, y) => x - y); return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * p))]! : 0; }
  count(pred: (v: number) => boolean): number { let c = 0; for (const v of this.values()) if (pred(v)) c++; return c; }
  get size(): number { return this.n; }
  clear(): void { this.n = 0; this.i = 0; }
}
export const perfStats = {
  render: new Ring(), frame: new Ring(),
  lastFrame: 0,
  /** call once per animation frame, with the repaint's CPU time if one happened */
  tick(now: number, renderMs: number | null): void {
    if (this.lastFrame) { const d = now - this.lastFrame; if (d < 1000) this.frame.push(d); } // ignore background-tab gaps
    this.lastFrame = now;
    if (renderMs !== null) this.render.push(renderMs);
  },
  summary(): { renderP50: number; renderP95: number; renders: number; frameP95: number; slowFrames: number; frames: number } {
    return { renderP50: +this.render.pct(0.5).toFixed(2), renderP95: +this.render.pct(0.95).toFixed(2), renders: this.render.size, frameP95: +this.frame.pct(0.95).toFixed(1), slowFrames: this.frame.count((v) => v > 33.4), frames: this.frame.size };
  },
  reset(): void { this.render.clear(); this.frame.clear(); },
};
