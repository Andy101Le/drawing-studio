/** Undo/redo as tile snapshots scoped to the dirty rect of each stroke. */

import { TILE, type Doc, type Layer, type Tile, type TileSnapshot } from "./document.js";
import { resetMedia } from "./media.js";

export interface SerializedEntry { label: string; layerId: number; rect: { x0: number; y0: number; x1: number; y1: number }; before: Array<{ x: number; y: number; png: string | null }>; after: Array<{ x: number; y: number; png: string | null }> }
async function packTiles(entries: TileSnapshot["entries"]): Promise<SerializedEntry["before"]> {
  const c = document.createElement("canvas"); c.width = TILE; c.height = TILE; const g = c.getContext("2d")!;
  const out: SerializedEntry["before"] = [];
  for (const e of entries) {
    if (!e.data) { out.push({ x: e.x, y: e.y, png: null }); continue; }
    g.putImageData(e.data, 0, 0);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
    const buf = new Uint8Array(await blob.arrayBuffer()); let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    out.push({ x: e.x, y: e.y, png: btoa(bin) });
  }
  return out;
}
async function unpackTiles(list: SerializedEntry["before"]): Promise<TileSnapshot["entries"]> {
  const c = document.createElement("canvas"); c.width = TILE; c.height = TILE; const g = c.getContext("2d", { willReadFrequently: true })!;
  const out: TileSnapshot["entries"] = [];
  for (const e of list) {
    if (!e.png) { out.push({ x: e.x, y: e.y, data: null }); continue; }
    const img = new Image(); img.src = `data:image/png;base64,${e.png}`; await img.decode();
    g.clearRect(0, 0, TILE, TILE); g.drawImage(img, 0, 0); out.push({ x: e.x, y: e.y, data: g.getImageData(0, 0, TILE, TILE) });
  }
  return out;
}

/**
 * `lazy` lists after-tiles not read back yet. Reading them at commit cost one GPU->CPU readback per
 * tile on every pen-up; instead an after-tile is filled when it is first needed: by the next stroke's
 * capture of that tile (the same pixels, shared), by undo (the tile still holds them), or by export.
 */
export type TileEntry = { kind: "tiles"; before: TileSnapshot; after: TileSnapshot; label: string; also?: { undo: () => void; redo: () => void }; id: string; author: string; lazy?: { layer: Layer; keys: Set<string> }; bytes?: number };
type Entry = TileEntry | { kind: "custom"; label: string; undo: () => void; redo: () => void; id?: string; author?: string };

export class History {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private pending: { layer: Layer; label: string; before: Map<string, { x: number; y: number; data: ImageData | null }> } | null = null;
  readonly limit = 64;
  /** memory ceiling for snapshot pixels; oldest entries go first once it is passed */
  byteBudget = 384 * 1024 * 1024;
  private bytes = 0;
  /** layerId:tx,ty -> the newest entry whose after-tile there is still unread */
  private lazyAfter = new Map<string, TileEntry>();
  onChange: (() => void) | null = null;
  /** live sessions: author id stamped on new entries, and a hook after every tile commit */
  author = "local";
  onCommit: ((e: TileEntry) => void) | null = null;
  /** true while a live session needs after-pixels at commit time (set by the collab layer) */
  eagerAfter: () => boolean = () => false;
  /** id to use for the next commit (set by the collab layer when replaying a remote stroke) */
  nextId: string | null = null;

  /**
   * Start a tile-level transaction on a layer. Nothing is captured yet:
   * capture(tile) records each tile's pixels the first time the stroke is
   * about to write it, so the undo entry contains exactly the tiles the
   * stroke touched, never neighbours. `rect` is accepted for API symmetry but
   * no longer drives what is snapshotted.
   */
  begin(layer: Layer, _rect: { x0: number; y0: number; x1: number; y1: number }, label: string): void {
    this.pending = { layer, label, before: new Map() };
  }

  /**
   * A transaction over several layers at once (moving or scaling a whole group). Tiles are captured
   * through the same capture() as a stroke; the step becomes one custom entry whose undo and redo
   * restore every touched tile on every layer. Not lazy: the after-tiles are read at commit.
   */
  private multi: { label: string; layers: Set<Layer>; before: Map<number, { layer: Layer; tiles: Map<string, { x: number; y: number; data: ImageData | null }> }> } | null = null;
  beginMulti(layers: Layer[], label: string): void { this.multi = { label, layers: new Set(layers), before: new Map() }; }
  private restoreTiles(layer: Layer, tiles: Array<{ x: number; y: number; data: ImageData | null }>): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { x, y } of tiles) { x0 = Math.min(x0, x * TILE); y0 = Math.min(y0, y * TILE); x1 = Math.max(x1, (x + 1) * TILE); y1 = Math.max(y1, (y + 1) * TILE); }
    if (tiles.length) layer.restore({ layerId: layer.id, entries: tiles, rect: { x0, y0, x1, y1 } });
  }
  commitMulti(also?: { undo: () => void; redo: () => void }): void {
    const m = this.multi; if (!m) return; this.multi = null;
    const parts: Array<{ layer: Layer; before: Array<{ x: number; y: number; data: ImageData | null }>; after: Array<{ x: number; y: number; data: ImageData | null }> }> = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; let bytes = 0;
    for (const { layer, tiles } of m.before.values()) {
      const before = [...tiles.values()]; const after = before.map(({ x, y }) => { const t = layer.tiles.get(`${x},${y}`); const data = t && t.ctx ? (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE) : null; return { x, y, data }; });
      for (const e of [...before, ...after]) if (e.data) bytes += e.data.data.length;
      for (const { x, y } of before) { x0 = Math.min(x0, x * TILE); y0 = Math.min(y0, y * TILE); x1 = Math.max(x1, (x + 1) * TILE); y1 = Math.max(y1, (y + 1) * TILE); }
      parts.push({ layer, before, after });
    }
    if (!parts.length) { if (also) this.pushCustom(m.label, also.undo, also.redo); return; }
    const rect = { x0, y0, x1, y1 };
    this.pushCustom(m.label,
      () => { for (const q of parts) { resetMedia(q.layer); this.restoreTiles(q.layer, q.before); } also?.undo(); this.lastRect = rect; },
      () => { for (const q of parts) { resetMedia(q.layer); this.restoreTiles(q.layer, q.after); } also?.redo(); this.lastRect = rect; });
    this.bytes += bytes; this.trim();
  }
  rollbackMulti(): void {
    const m = this.multi; if (!m) return; this.multi = null;
    for (const { layer, tiles } of m.before.values()) this.restoreTiles(layer, [...tiles.values()]);
  }
  get inMulti(): boolean { return this.multi !== null; }

  /** Record a tile's pre-write pixels (or its absence) once. Cheap no-op after the first call. */
  capture(layer: Layer, tx: number, ty: number): void {
    const mm = this.multi;
    if (mm && mm.layers.has(layer)) {
      const key = `${tx},${ty}`; const slot = mm.before.get(layer.id) ?? mm.before.set(layer.id, { layer, tiles: new Map() }).get(layer.id)!;
      if (slot.tiles.has(key)) return;
      const t = layer.tiles.get(key); const data = t && t.ctx ? (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE) : null;
      slot.tiles.set(key, { x: tx, y: ty, data });
      const lk = `${layer.id}:${key}`; const prev = this.lazyAfter.get(lk); if (prev) { this.fillAfter(prev, key, data); this.lazyAfter.delete(lk); }
      return;
    }
    const p = this.pending; if (!p || p.layer !== layer) return;
    const key = `${tx},${ty}`;
    if (p.before.has(key)) return;
    const t = layer.tiles.get(key);
    const data = t && t.ctx ? (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE) : null;
    p.before.set(key, { x: tx, y: ty, data });
    // these pixels are also the previous stroke's after-state for this tile: hand them over
    const lk = `${layer.id}:${key}`; const prev = this.lazyAfter.get(lk);
    if (prev) { this.fillAfter(prev, key, data); this.lazyAfter.delete(lk); }
  }
  private fillAfter(e: TileEntry, key: string, data: ImageData | null): void {
    if (!e.lazy || !e.lazy.keys.has(key)) return;
    const a = e.after.entries.find((q) => `${q.x},${q.y}` === key); if (a) a.data = data;
    e.lazy.keys.delete(key); if (data) { e.bytes = (e.bytes ?? 0) + data.data.length; this.bytes += data.data.length; }
    if (!e.lazy.keys.size) delete e.lazy;
  }
  /** Read every still-unread after-tile of `e` from its layer (valid while no later entry touched them). */
  private materialize(e: TileEntry): void {
    const lz = e.lazy; if (!lz) return;
    for (const key of [...lz.keys]) {
      const t = lz.layer.tiles.get(key);
      this.fillAfter(e, key, t && t.ctx ? (t.ctx as CanvasRenderingContext2D).getImageData(0, 0, TILE, TILE) : null);
      const lk = `${lz.layer.id}:${key}`; if (this.lazyAfter.get(lk) === e) this.lazyAfter.delete(lk);
    }
  }
  private forget(e: Entry): void {
    if (e.kind !== "tiles") return;
    this.bytes -= e.bytes ?? 0;
    if (e.lazy) for (const key of e.lazy.keys) { const lk = `${e.lazy.layer.id}:${key}`; if (this.lazyAfter.get(lk) === e) this.lazyAfter.delete(lk); }
  }
  private trim(): void {
    while (this.undoStack.length > 1 && (this.undoStack.length > this.limit || this.bytes > this.byteBudget)) this.forget(this.undoStack.shift()!);
  }
  private dropRedo(): void { for (const e of this.redoStack) this.forget(e); this.redoStack.length = 0; }
  /** Snapshot memory in use (MB), for the status bar and tests. */
  get memoryMB(): number { return Math.round(this.bytes / 1048576); }

  /** Capture every tile a DU rect touches (fill, bridge replay). */
  captureRect(layer: Layer, rect: { x0: number; y0: number; x1: number; y1: number }): void {
    const tx0 = Math.floor(rect.x0 / TILE), ty0 = Math.floor(rect.y0 / TILE), tx1 = Math.floor(rect.x1 / TILE), ty1 = Math.floor(rect.y1 / TILE);
    for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) this.capture(layer, tx, ty);
  }

  /** Close the transaction: "after" is read from the same tile set. */
  commit(_rect: { x0: number; y0: number; x1: number; y1: number }, also?: { undo: () => void; redo: () => void }): void {
    const p = this.pending; if (!p) return;
    this.pending = null;
    if (p.before.size === 0) { if (also) this.pushCustom(p.label, also.undo, also.redo); return; }
    const { layer, label } = p;
    const entries = (pick: "before" | "after") => [...p.before.values()].map(({ x, y, data }) => ({ x, y, data: pick === "before" ? data : null as ImageData | null }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { x, y } of p.before.values()) { x0 = Math.min(x0, x * TILE); y0 = Math.min(y0, y * TILE); x1 = Math.max(x1, (x + 1) * TILE); y1 = Math.max(y1, (y + 1) * TILE); }
    const rect = { x0, y0, x1, y1 };
    const before: TileSnapshot = { layerId: layer.id, entries: entries("before"), rect };
    const after: TileSnapshot = { layerId: layer.id, entries: entries("after"), rect };
    const id = this.nextId ?? `${this.author}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; this.nextId = null;
    const entry: TileEntry = also ? { kind: "tiles", before, after, label, also, id, author: this.author } : { kind: "tiles", before, after, label, id, author: this.author };
    let bb = 0; for (const b of before.entries) if (b.data) bb += b.data.data.length;
    entry.bytes = bb; this.bytes += bb;
    entry.lazy = { layer, keys: new Set(p.before.keys()) };
    for (const key of p.before.keys()) this.lazyAfter.set(`${layer.id}:${key}`, entry);
    // live sessions ship the after-pixels to peers immediately
    if (this.eagerAfter()) this.materialize(entry);
    this.undoStack.push(entry);
    this.dropRedo();
    this.trim();
    this.onChange?.();
    this.onCommit?.(entry);
  }

  /**
   * Selective undo/redo for live sessions: restore `from` pixels only where the layer still
   * holds the entry's `to` pixels, so later edits by others on other pixels survive.
   */
  private selective(doc: Doc, e: TileEntry, direction: "undo" | "redo"): void {
    this.materialize(e);
    const layer = doc.findLayer(e.before.layerId); if (!layer) return; resetMedia(layer);
    const from = direction === "undo" ? e.before : e.after, to = direction === "undo" ? e.after : e.before;
    for (let i = 0; i < to.entries.length; i++) {
      const t = to.entries[i]!, f = from.entries.find((q) => q.x === t.x && q.y === t.y) ?? { x: t.x, y: t.y, data: null };
      const tile = layer.getTile(t.x, t.y, true)!; if (!tile.ctx) continue;
      const ctx = tile.ctx as CanvasRenderingContext2D; const cur = ctx.getImageData(0, 0, TILE, TILE); const d = cur.data;
      const td = t.data?.data ?? null, fd = f.data?.data ?? null;
      for (let p = 0; p < d.length; p += 4) {
        const toA = td ? td[p + 3]! : 0;
        const same = td ? (d[p] === td[p] && d[p + 1] === td[p + 1] && d[p + 2] === td[p + 2] && d[p + 3] === toA) : d[p + 3] === 0;
        if (!same) continue;
        if (fd) { d[p] = fd[p]!; d[p + 1] = fd[p + 1]!; d[p + 2] = fd[p + 2]!; d[p + 3] = fd[p + 3]!; } else { d[p] = d[p + 1] = d[p + 2] = d[p + 3] = 0; }
      }
      ctx.putImageData(cur, 0, 0); tile.generation++;
    }
    layer.generation++;
  }
  /** Undo the newest entry by `author` wherever it sits in the stack. Returns the entry or null. */
  undoBy(doc: Doc, author: string): TileEntry | null {
    for (let i = this.undoStack.length - 1; i >= 0; i--) {
      const e = this.undoStack[i]!; if (e.kind !== "tiles" || e.author !== author) continue;
      this.undoStack.splice(i, 1); this.selective(doc, e, "undo"); e.also?.undo(); this.redoStack.push(e); this.onChange?.(); return e;
    }
    return null;
  }
  redoBy(doc: Doc, author: string): TileEntry | null {
    for (let i = this.redoStack.length - 1; i >= 0; i--) {
      const e = this.redoStack[i]!; if (e.kind !== "tiles" || e.author !== author) continue;
      this.redoStack.splice(i, 1); this.selective(doc, e, "redo"); e.also?.redo(); this.undoStack.push(e); this.onChange?.(); return e;
    }
    return null;
  }
  /** Apply a remote undo/redo of a known entry id (selective), moving it between stacks. */
  applyRemote(doc: Doc, id: string, direction: "undo" | "redo"): boolean {
    const src = direction === "undo" ? this.undoStack : this.redoStack, dst = direction === "undo" ? this.redoStack : this.undoStack;
    const i = src.findIndex((e) => e.kind === "tiles" && e.id === id); if (i < 0) return false;
    const e = src[i] as TileEntry; src.splice(i, 1); this.selective(doc, e, direction); dst.push(e); this.onChange?.(); return true;
  }
  /** Drop an entry after reverting it (rejected request). */
  revoke(doc: Doc, id: string): boolean {
    const i = this.undoStack.findIndex((e) => e.kind === "tiles" && e.id === id); if (i < 0) return false;
    const e = this.undoStack[i] as TileEntry; this.undoStack.splice(i, 1); this.selective(doc, e, "undo"); this.onChange?.(); return true;
  }
  entryById(id: string): TileEntry | null { const e = this.undoStack.find((x) => x.kind === "tiles" && x.id === id); return (e as TileEntry | undefined) ?? null; }

  /** Abandon the transaction and put every captured tile back (cancelled move/transform). */
  rollback(): void {
    const p = this.pending; if (!p) return;
    this.pending = null;
    if (p.before.size === 0) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const { x, y } of p.before.values()) { x0 = Math.min(x0, x * TILE); y0 = Math.min(y0, y * TILE); x1 = Math.max(x1, (x + 1) * TILE); y1 = Math.max(y1, (y + 1) * TILE); }
    p.layer.restore({ layerId: p.layer.id, entries: [...p.before.values()], rect: { x0, y0, x1, y1 } });
  }

  get inTransaction(): boolean { return this.pending !== null; }

  /** Arbitrary reversible action (vector edits, panel changes). */
  pushCustom(label: string, undo: () => void, redo: () => void): void {
    this.undoStack.push({ kind: "custom", label, undo, redo });
    this.dropRedo();
    this.trim();
    this.onChange?.();
  }

  /** pixels the last undo()/redo() touched, null after a custom (non-tile) step: lets the caller repaint just that */
  lastRect: { x0: number; y0: number; x1: number; y1: number } | null = null;
  undo(doc: Doc): boolean {
    const e = this.undoStack.pop();
    if (!e) return false;
    this.lastRect = e.kind === "tiles" && !e.also ? e.before.rect : null;
    if (e.kind === "custom") e.undo(); else { this.materialize(e); const l = doc.findLayer(e.before.layerId); if (l) { resetMedia(l); l.restore(e.before); } e.also?.undo(); }
    this.redoStack.push(e);
    this.onChange?.();
    return true;
  }

  redo(doc: Doc): boolean {
    const e = this.redoStack.pop();
    if (!e) return false;
    this.lastRect = e.kind === "tiles" && !e.also ? e.after.rect : null;
    if (e.kind === "custom") e.redo(); else { const l = doc.findLayer(e.after.layerId); if (l) { resetMedia(l); l.restore(e.after); } e.also?.redo(); }
    this.undoStack.push(e);
    this.onChange?.();
    return true;
  }

  /**
   * Persistence: tile entries from the top of the stack (newest last) as PNG data URLs.
   * Custom entries (vector/panel/selection closures) cannot be serialised; the export stops
   * at the newest custom entry below `max` tile entries so what is restored is contiguous.
   */
  async exportEntries(max = 16): Promise<SerializedEntry[]> {
    const out: SerializedEntry[] = [];
    for (let i = this.undoStack.length - 1; i >= 0 && out.length < max; i--) {
      const e = this.undoStack[i]!; if (e.kind !== "tiles") break;
      this.materialize(e);
      out.unshift({ label: e.label, layerId: e.before.layerId, rect: e.before.rect, before: await packTiles(e.before.entries), after: await packTiles(e.after.entries) });
    }
    return out;
  }
  async importEntries(list: SerializedEntry[]): Promise<void> {
    for (let i = 0; i < list.length; i++) { const se = list[i]!;
      const before: TileSnapshot = { layerId: se.layerId, rect: se.rect, entries: await unpackTiles(se.before) };
      const after: TileSnapshot = { layerId: se.layerId, rect: se.rect, entries: await unpackTiles(se.after) };
      this.undoStack.push({ kind: "tiles", before, after, label: se.label, id: `restored-${i}-${Date.now().toString(36)}`, author: this.author });
    }
    if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
    this.onChange?.();
  }

  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get labels(): string[] { return this.undoStack.map((e) => e.label); }
  /** New document: drop every entry and any open transaction. */
  clear(): void { this.undoStack.length = 0; this.redoStack.length = 0; this.pending = null; this.lazyAfter.clear(); this.bytes = 0; this.onChange?.(); }
  /** What has been done on a layer this session: label counts, newest first (for the Layers tab). */
  summaryFor(layerId: number): Array<[string, number]> {
    const counts = new Map<string, number>();
    for (let i = this.undoStack.length - 1; i >= 0; i--) { const e = this.undoStack[i]!; if (e.kind !== "tiles" || e.before.layerId !== layerId) continue; const k = e.label.replace(/^Brush /, ""); counts.set(k, (counts.get(k) ?? 0) + 1); }
    return [...counts.entries()];
  }
}
