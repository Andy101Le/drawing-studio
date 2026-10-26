/**
 * Loader for the wasm32 brush core (core/wasm/brush_core.cpp, built by core/wasm/build.sh
 * with clang + wasm-ld, no Emscripten). Tile mirrors live in Wasm memory; `view(slot)`
 * returns a Uint8ClampedArray over them so one putImageData blits a tile.
 * When the module is missing or fails to instantiate, `WasmBrush.load()` resolves null and
 * the engine keeps the Canvas 2D tip path.
 */
export interface WasmExports {
  memory: WebAssembly.Memory;
  omni_slot_alloc(): number; omni_slot_ptr(slot: number): number; omni_slot_clear(slot: number): void; omni_slots_reset(): void;
  omni_dab(slot: number, cx: number, cy: number, r: number, h: number, a: number, cr: number, cg: number, cb: number, erase: number, outRect: number): void;
  omni_bench(slot: number, n: number, r: number, h: number): number;
  omni_tile_bytes(): number; omni_max_slots(): number;
}

export class WasmBrush {
  private rectPtr: number;
  private constructor(readonly ex: WasmExports) {
    // scratch for omni_dab's rect output: 16 bytes at the start of a fresh slot-sized block
    this.rectPtr = ex.omni_slot_ptr(ex.omni_slot_alloc());
  }
  static async load(url = "/brush_core.wasm"): Promise<WasmBrush | null> {
    try {
      const res = await fetch(url); if (!res.ok) return null;
      const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
      const ex = instance.exports as unknown as WasmExports;
      if (typeof ex.omni_dab !== "function") return null;
      return new WasmBrush(ex);
    } catch { return null; }
  }
  alloc(): number { return this.ex.omni_slot_alloc(); }
  reset(): void { this.ex.omni_slots_reset(); this.rectPtr = this.ex.omni_slot_ptr(this.ex.omni_slot_alloc()); }
  clear(slot: number): void { this.ex.omni_slot_clear(slot); }
  view(slot: number): Uint8ClampedArray { return new Uint8ClampedArray(this.ex.memory.buffer, this.ex.omni_slot_ptr(slot), 256 * 256 * 4); }
  /** returns the touched rect [x0, y0, x1, y1) in tile pixels */
  dab(slot: number, cx: number, cy: number, r: number, hardness: number, alpha: number, rgb: [number, number, number]): [number, number, number, number] {
    this.ex.omni_dab(slot, cx, cy, r, hardness, alpha, rgb[0], rgb[1], rgb[2], 0, this.rectPtr);
    const v = new Int32Array(this.ex.memory.buffer, this.rectPtr, 4); return [v[0]!, v[1]!, v[2]!, v[3]!];
  }
  bench(n: number, r: number, hardness: number): number { const s = this.alloc(); const t0 = performance.now(); this.ex.omni_bench(s, n, r, hardness); return performance.now() - t0; }
}
