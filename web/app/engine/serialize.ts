/**
 * .omni project serialization. Produces one plaintext bundle (JSON manifest +
 * PNG tiles) which account.ts encrypts chunk-wise before it touches OPFS.
 *
 * Bundle format (little-endian):
 *   u32 manifestLength, [manifest JSON utf8], then per tile:
 *   u32 layerId, i32 tx, i32 ty, u32 pngLength, [png bytes]
 */

import { Doc, Frame, Layer, TILE, type BlendMode, type LayerKind } from "./document.js";

interface Manifest {
  version: 1;
  name: string; width: number; height: number; dpi: number; fps: number;
  exposure: number[]; currentFrame: number; activeLayerId: number;
  onion: { prev: number; next: number; enabled: boolean };
  panels: Doc["panels"];
  balloons?: Doc["balloons"];
  mode?: Doc["mode"];
  surface?: Doc["surface"];
  camera?: Doc["camera"];
  frames: Array<{ id: number; label: string; note: string; viseme: Frame["viseme"]; dialog: string; layers: Array<{
    id: number; name: string; kind: LayerKind; visible: boolean; opacity: number; blend: BlendMode; locked: boolean;
    transform: Layer["transform"]; tone: Layer["tone"]; panelMask: number | null; paths: Layer["paths"]; clipBelow?: boolean; parent?: number | null; collapsed?: boolean; keys?: Layer["keys"];
  }> }>;
}

async function tilePng(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Uint8Array> {
  const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: "image/png" }) : await new Promise<Blob>((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error("toBlob"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function serializeDoc(doc: Doc, coldBytes?: (t: import("./document.js").Tile) => Promise<Uint8Array | null>): Promise<Uint8Array> {
  const manifest: Manifest = {
    version: 1, name: doc.name, width: doc.width, height: doc.height, dpi: doc.dpi, fps: doc.fps,
    exposure: doc.exposure, currentFrame: doc.currentFrame, activeLayerId: doc.activeLayerId,
    onion: { prev: doc.onionPrev, next: doc.onionNext, enabled: doc.onionEnabled },
    panels: doc.panels, balloons: doc.balloons, mode: doc.mode, surface: doc.surface, camera: doc.camera,
    frames: doc.frames.map((f) => ({ id: f.id, label: f.label, note: f.note, viseme: f.viseme, dialog: f.dialog, layers: f.layers.map((l) => ({
      id: l.id, name: l.name, kind: l.kind, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, transform: l.transform, tone: l.tone, panelMask: l.panelMask, paths: l.paths, clipBelow: l.clipBelow, parent: l.parent, collapsed: l.collapsed, keys: l.keys,
    })) })),
  };
  const parts: Uint8Array[] = [];
  const mbytes = new TextEncoder().encode(JSON.stringify(manifest));
  const head = new Uint8Array(4); new DataView(head.buffer).setUint32(0, mbytes.byteLength, true);
  parts.push(head, mbytes);
  for (const f of doc.frames) for (const l of f.layers) for (const t of l.tiles.values()) {
    const png = t.canvas ? await tilePng(t.canvas) : coldBytes ? await coldBytes(t) : null;
    if (!png) continue;
    const h = new Uint8Array(16); const dv = new DataView(h.buffer);
    dv.setUint32(0, l.id, true); dv.setInt32(4, t.x, true); dv.setInt32(8, t.y, true); dv.setUint32(12, png.byteLength, true);
    parts.push(h, png);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}

export async function deserializeDoc(bytes: Uint8Array, idMapOut?: Map<number, number>): Promise<Doc> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mlen = dv.getUint32(0, true);
  const manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + mlen))) as Manifest;
  if (manifest.version !== 1) throw new Error("unsupported project version");
  const doc = new Doc();
  doc.name = manifest.name; doc.width = manifest.width; doc.height = manifest.height; doc.dpi = manifest.dpi; doc.fps = manifest.fps as Doc["fps"];
  doc.exposure = manifest.exposure; doc.currentFrame = manifest.currentFrame;
  doc.onionPrev = manifest.onion.prev; doc.onionNext = manifest.onion.next; doc.onionEnabled = manifest.onion.enabled;
  doc.panels = manifest.panels; doc.balloons = manifest.balloons ?? []; doc.mode = manifest.mode ?? "manga"; if (manifest.surface) doc.surface = { ...doc.surface, ...manifest.surface }; doc.camera = manifest.camera ?? [];
  const layerById = new Map<number, Layer>();
  const idMap = new Map<number, number>();
  doc.frames = manifest.frames.map((mf) => {
    const f = new Frame(mf.label); f.note = mf.note; f.viseme = mf.viseme; f.dialog = mf.dialog;
    f.layers = mf.layers.map((ml) => {
      const l = new Layer(ml.name, ml.kind);
      l.visible = ml.visible; l.opacity = ml.opacity; l.blend = ml.blend; l.locked = ml.locked; l.transform = ml.transform; l.tone = ml.tone; l.panelMask = ml.panelMask; l.paths = ml.paths; l.clipBelow = ml.clipBelow ?? false; l.parent = ml.parent ?? null; l.collapsed = ml.collapsed ?? false; l.keys = ml.keys ?? [];
      layerById.set(ml.id, l); idMap.set(ml.id, l.id);
      return l;
    });
    return f;
  });
  // group parents refer to old ids: remap now that every layer has its new id
  for (const f of doc.frames) for (const l of f.layers) if (l.parent !== null) l.parent = idMap.get(l.parent) ?? null;
  if (idMapOut) for (const [k, v] of idMap) idMapOut.set(k, v);
  doc.activeLayerId = idMap.get(manifest.activeLayerId) ?? (doc.frames[0]!.layers[0] as Layer).id;
  let o = 4 + mlen;
  const decodes: Promise<void>[] = [];
  while (o + 16 <= bytes.byteLength) {
    const lid = dv.getUint32(o, true), tx = dv.getInt32(o + 4, true), ty = dv.getInt32(o + 8, true), len = dv.getUint32(o + 12, true);
    const png = bytes.subarray(o + 16, o + 16 + len); o += 16 + len;
    const layer = layerById.get(lid);
    if (!layer) continue;
    decodes.push((async () => {
      const bmp = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
      const t = layer.getTile(tx, ty, true)!;
      if (t.ctx) (t.ctx as CanvasRenderingContext2D).drawImage(bmp, 0, 0, TILE, TILE);
      bmp.close();
    })());
  }
  await Promise.all(decodes);
  return doc;
}
