/**
 * Tile cache tiers (Phase 1.2 data virtualization).
 *
 *   HOT   tile.canvas present            (RAM, drawable now)
 *   WARM  PNG bytes in RAM, canvas freed  (~5-15x smaller)
 *   COLD  PNG bytes in OPFS, RAM freed    (unbounded, sync-access worker)
 *
 * The current drawing is always HOT. Everything else is demoted in LRU order
 * once the hot budget is exceeded (default: 25 % of device memory, min 256 MB,
 * max 2 GB). Demotion encodes the tile to PNG; promotion decodes it. Both are
 * async and never block input: a frame change starts `warm()` for the drawing
 * about to be shown and the renderer simply skips tiles whose canvas is not back yet.
 * The GPU compositor keeps its own LRU of tile textures on top of this.
 */

import { TILE, makeCanvas, type Doc, type Frame, type Tile } from "./document.js";
import type { TileCacheClient } from "@omni/crypto/opfs.js";

interface Meta { tile: Tile; layerId: number; frameId: number; lastUse: number; png: Uint8Array | null; opfsKey: string | null }

export class TileCache {
  private meta = new Map<Tile, Meta>();
  private tick = 0;
  hotBytes = 0;
  warmBytes = 0;
  coldBytes = 0;
  budgetBytes: number;
  private warmBudget: number;
  private opfs: TileCacheClient | null = null;
  private opfsPath = "cache/tiles.bin";
  private opfsOffset = 0;
  private pending = new Set<Tile>();
  /** all demote / spill / promote work runs on one chain so tiers never race each other */
  private chain: Promise<unknown> = Promise.resolve();
  onChange: (() => void) | null = null;
  private run<T>(fn: () => Promise<T>): Promise<T> { const next = this.chain.then(fn, fn); this.chain = next.catch(() => undefined); return next; }

  constructor(opts: { budgetBytes?: number; warmBudgetBytes?: number } = {}) {
    const devMem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 4;
    this.budgetBytes = opts.budgetBytes ?? Math.max(256, Math.min(2048, devMem * 1024 * 0.25)) * 1024 * 1024;
    this.warmBudget = opts.warmBudgetBytes ?? this.budgetBytes / 2;
  }

  async attachOpfs(client: TileCacheClient): Promise<void> {
    try { await client.open(this.opfsPath); await client.truncate(this.opfsPath, 0); this.opfs = client; this.opfsOffset = 0; } catch { this.opfs = null; }
  }

  /** Called whenever a tile is created or drawn into. */
  touch(tile: Tile, layerId: number, frameId: number): void {
    let m = this.meta.get(tile);
    if (!m) { m = { tile, layerId, frameId, lastUse: 0, png: null, opfsKey: null }; this.meta.set(tile, m); if (tile.canvas) this.hotBytes += TILE * TILE * 4; }
    m.lastUse = ++this.tick;
  }

  /** Register every tile of a document (after load). */
  index(doc: Doc): void {
    for (const f of doc.frames) for (const l of f.layers) for (const t of l.tiles.values()) this.touch(t, l.id, f.id);
  }

  /** Demote LRU tiles outside the current drawing until under budget. `current` is re-read per tile so a frame change mid-run is respected. */
  maintain(current: () => Frame): Promise<void> {
    return this.run(async () => {
      if (this.hotBytes <= this.budgetBytes) return;
      const candidates = [...this.meta.values()].filter((m) => m.tile.canvas).sort((a, b) => a.lastUse - b.lastUse);
      // encode in batches of 16: PNG encoding is the cost, and the browser parallelizes convertToBlob
      let batch: Meta[] = [];
      for (const m of candidates) {
        if (this.hotBytes - batch.length * TILE * TILE * 4 <= this.budgetBytes * 0.85) break;
        if (m.frameId === current().id || !m.tile.canvas) continue;
        batch.push(m);
        if (batch.length === 16) { await Promise.all(batch.map((x) => this.demote(x))); batch = []; }
      }
      if (batch.length) await Promise.all(batch.map((x) => this.demote(x)));
      while (this.warmBytes > this.warmBudget && this.opfs) {
        const m = [...this.meta.values()].filter((x) => x.png && !x.opfsKey).sort((a, b) => a.lastUse - b.lastUse)[0];
        if (!m) break;
        await this.spill(m);
      }
      this.onChange?.();
    });
  }

  private async demote(m: Meta): Promise<void> {
    const c = m.tile.canvas; if (!c) return;
    this.pending.add(m.tile);
    try {
      const blob = c instanceof OffscreenCanvas ? await c.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((res, rej) => (c as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
      m.png = new Uint8Array(await blob.arrayBuffer());
      this.warmBytes += m.png.byteLength;
      m.tile.canvas = null; m.tile.ctx = null;
      this.hotBytes -= TILE * TILE * 4;
    } finally { this.pending.delete(m.tile); }
  }

  private async spill(m: Meta): Promise<void> {
    if (!this.opfs || !m.png) return;
    const off = this.opfsOffset; this.opfsOffset += m.png.byteLength;
    await this.opfs.writeRange(this.opfsPath, off, m.png);
    m.opfsKey = `${off}:${m.png.byteLength}`;
    this.coldBytes += m.png.byteLength; this.warmBytes -= m.png.byteLength;
    m.png = null;
  }

  /** Promote every tile of a drawing back to HOT. Resolves when all are drawable. */
  warm(frame: Frame): Promise<number> {
    return this.run(async () => {
      const jobs: Promise<void>[] = [];
      for (const l of frame.layers) for (const t of l.tiles.values()) if (!t.canvas) jobs.push(this.promote(t));
      await Promise.all(jobs);
      if (jobs.length) this.onChange?.();
      return jobs.length;
    });
  }

  async promote(tile: Tile): Promise<void> {
    const m = this.meta.get(tile); if (!m || tile.canvas) return;
    let png = m.png;
    if (!png && m.opfsKey && this.opfs) {
      const [off, len] = m.opfsKey.split(":").map(Number) as [number, number];
      png = await this.opfs.readRange(this.opfsPath, off, len);
      this.coldBytes -= len;
    } else if (png) { this.warmBytes -= png.byteLength; }
    m.png = null; m.opfsKey = null;
    const canvas = makeCanvas(TILE, TILE);
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;
    if (png) { const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" })); ctx.drawImage(bmp, 0, 0); bmp.close(); }
    tile.canvas = canvas; tile.ctx = ctx; tile.generation++;
    this.hotBytes += TILE * TILE * 4;
    m.lastUse = ++this.tick;
  }

  /** PNG bytes of a demoted tile without promoting it (for save). */
  async bytes(tile: Tile): Promise<Uint8Array | null> {
    const m = this.meta.get(tile); if (!m) return null;
    if (m.png) return m.png;
    if (m.opfsKey && this.opfs) { const [off, len] = m.opfsKey.split(":").map(Number) as [number, number]; return this.opfs.readRange(this.opfsPath, off, len); }
    return null;
  }

  touchLayer(layerTiles: Iterable<Tile>, layerId: number, frameId: number): void { for (const t of layerTiles) this.touch(t, layerId, frameId); }

  stats(): { hotMB: number; warmMB: number; coldMB: number; tiles: number; budgetMB: number } {
    return { hotMB: this.hotBytes / 1048576, warmMB: this.warmBytes / 1048576, coldMB: this.coldBytes / 1048576, tiles: this.meta.size, budgetMB: this.budgetBytes / 1048576 };
  }
}
