/**
 * Story: an ordered set of pages (each a full Doc). `app.doc` is always `pages[index]`.
 * Pages are added, duplicated, removed and reordered from the strip in the Manga tab;
 * chapter export writes one PDF with a page per document (reading order left to right, or
 * right to left for Japanese-style binding) and a ZIP of PNGs. Persistence packs every page
 * into one container ("OMNISTORY1") so vault save, autosave and sync carry the whole story.
 */
import type { AppState } from "./state.js";
import { Doc } from "../engine/document.js";
import { serializeDoc, deserializeDoc } from "../engine/serialize.js";
import { pageToPanel } from "../engine/panels.js";
import { h, clear } from "./dom.js";

const MAGIC = new TextEncoder().encode("OMNISTORY1");

export interface Story { pages: Doc[]; index: number; rtl: boolean; title: string }

export function ensureStory(app: AppState): Story {
  if (!app.story) app.story = { pages: [app.doc], index: 0, rtl: false, title: "Untitled chapter" };
  const s = app.story; if (!s.pages.includes(app.doc)) { s.pages[s.index] = app.doc; }
  return s;
}

export function gotoPage(app: AppState, i: number): void {
  const s = ensureStory(app); if (i < 0 || i >= s.pages.length || i === s.index) return;
  s.index = i; app.doc = s.pages[i]!; app.cache.index(app.doc); app.selection = null; app.floating = null;
  app.renderer.fitPage(app.doc); app.invalidate(); app.emit("layers"); app.emit("timeline"); app.emit("panels"); app.emit("balloons"); app.emit("selection"); app.emit("doc-loaded"); app.emit("story");
}

export function addPage(app: AppState, after = true, duplicate = false): void {
  const s = ensureStory(app); const src = app.doc;
  const run = async () => {
    let d: Doc;
    if (duplicate) d = await deserializeDoc(await serializeDoc(src, (t) => app.cache.bytes(t)));
    else { d = new Doc(); d.width = src.width; d.height = src.height; d.dpi = src.dpi; d.mode = src.mode; d.surface = { ...src.surface }; d.panels = [pageToPanel(d.width, d.height, Math.round(d.dpi * 0.5), Math.round(d.dpi * 0.12))]; }
    d.name = `${s.title} p${s.pages.length + 1}`;
    const at = after ? s.index + 1 : s.index; s.pages.splice(at, 0, d);
    gotoPage(app, at);
  };
  void run();
}

export function removePage(app: AppState): void {
  const s = ensureStory(app); if (s.pages.length <= 1) return;
  s.pages.splice(s.index, 1); const i = Math.min(s.index, s.pages.length - 1); s.index = -1; gotoPage(app, i);
}
export function movePage(app: AppState, dir: -1 | 1): void {
  const s = ensureStory(app); const j = s.index + dir; if (j < 0 || j >= s.pages.length) return;
  const [d] = s.pages.splice(s.index, 1); s.pages.splice(j, 0, d!); s.index = j; app.emit("story");
}

/** Pack every page into one byte container; a single page is written as a plain document for compatibility. */
export async function packStory(app: AppState): Promise<Uint8Array> {
  const s = ensureStory(app);
  if (s.pages.length === 1) return serializeDoc(app.doc, (t) => app.cache.bytes(t));
  const blobs: Uint8Array[] = [];
  for (const d of s.pages) blobs.push(await serializeDoc(d, (t) => app.cache.bytes(t)));
  let total = MAGIC.length + 8 + 4 + blobs.reduce((a, b) => a + 4 + b.length, 0);
  const meta = new TextEncoder().encode(JSON.stringify({ rtl: s.rtl, title: s.title })); total += 4 + meta.length;
  const out = new Uint8Array(total); const dv = new DataView(out.buffer); let o = 0;
  out.set(MAGIC, o); o += MAGIC.length; dv.setUint32(o, s.pages.length); o += 4; dv.setUint32(o, s.index); o += 4; dv.setUint32(o, meta.length); o += 4; out.set(meta, o); o += meta.length;
  for (const b of blobs) { dv.setUint32(o, b.length); o += 4; out.set(b, o); o += b.length; }
  return out;
}
export function isStory(bytes: Uint8Array): boolean { return bytes.length > MAGIC.length && MAGIC.every((v, i) => bytes[i] === v); }
/** Unpack into the app (story or single doc). Returns the id map of the current page for undo restoration. */
export async function unpackStory(app: AppState, bytes: Uint8Array): Promise<Map<number, number>> {
  const idMap = new Map<number, number>();
  if (!isStory(bytes)) { app.doc = await deserializeDoc(bytes, idMap); app.story = { pages: [app.doc], index: 0, rtl: false, title: app.doc.name }; return idMap; }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let o = MAGIC.length;
  const n = dv.getUint32(o); o += 4; const index = dv.getUint32(o); o += 4; const ml = dv.getUint32(o); o += 4;
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(o, o + ml))) as { rtl: boolean; title: string }; o += ml;
  const pages: Doc[] = [];
  for (let i = 0; i < n; i++) { const len = dv.getUint32(o); o += 4; const m = i === index ? idMap : undefined; pages.push(await deserializeDoc(bytes.subarray(o, o + len), m)); o += len; }
  app.story = { pages, index: Math.min(index, pages.length - 1), rtl: meta.rtl, title: meta.title }; app.doc = pages[app.story.index]!;
  return idMap;
}

/** Page strip for the Manga tab. */
export function storyStrip(app: AppState, onExport: (kind: "pdf" | "zip") => void): HTMLElement {
  const root = h("div");
  const thumbs = new Map<Doc, { canvas: HTMLCanvasElement; gen: number }>();
  const thumbFor = (d: Doc): HTMLCanvasElement => {
    if (!app.renderer) { const c = document.createElement("canvas"); c.width = 52; c.height = 72; return c; }
    const gen = d.drawing.layers.reduce((a, l) => a + l.generation, 0) + d.balloons.length * 7 + d.panels.length * 13;
    const hit = thumbs.get(d); if (hit && hit.gen === gen) return hit.canvas;
    const scale = 72 / Math.max(d.width, d.height); const keep = app.doc; app.doc = d; const flat = app.renderer.flatten(d, scale); app.doc = keep;
    const c = document.createElement("canvas"); c.width = flat.width; c.height = flat.height; const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(flat, 0, 0);
    thumbs.set(d, { canvas: c, gen }); return c;
  };
  const render = () => {
    const s = ensureStory(app);
    const strip = h("div", { class: "page-strip" });
    const order = s.rtl ? [...s.pages.keys()].reverse() : [...s.pages.keys()];
    for (const i of order) {
      const d = s.pages[i]!; const t = thumbFor(d);
      strip.append(h("div", { class: `page-thumb ${i === s.index ? "active" : ""}`, title: `${d.name} (${d.width}x${d.height})`, onClick: () => gotoPage(app, i) }, t, h("span", {}, String(i + 1))));
    }
    clear(root).append(h("h3", {}, "Story"),
      h("div", { class: "row", style: { gap: "6px", margin: "4px 0", flexWrap: "wrap" } },
        h("input", { type: "text", value: s.title, style: { width: "120px" }, title: "Chapter title", onChange: (e: Event) => { s.title = (e.target as HTMLInputElement).value; } }),
        h("button", { title: "Add a blank page after this one", onClick: () => addPage(app, true, false) }, "+ Page"),
        h("button", { title: "Duplicate this page", onClick: () => addPage(app, true, true) }, "Duplicate"),
        h("button", { title: "Move page earlier", onClick: () => movePage(app, -1) }, "◀"),
        h("button", { title: "Move page later", onClick: () => movePage(app, 1) }, "▶"),
        h("button", { title: "Remove this page", disabled: s.pages.length <= 1, onClick: () => { if (confirm("Remove this page?")) removePage(app); } }, "Remove"),
        h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center" } }, h("input", { type: "checkbox", checked: s.rtl, onChange: (e: Event) => { s.rtl = (e.target as HTMLInputElement).checked; render(); } }), "right-to-left")),
      strip,
      h("div", { class: "row", style: { gap: "6px", margin: "4px 0" } }, h("button", { title: "One PDF, a page per document, in reading order", onClick: () => onExport("pdf") }, "Export chapter PDF"), h("button", { title: "ZIP of numbered PNGs", onClick: () => onExport("zip") }, "Export chapter PNGs"), h("span", { class: "dim", style: { fontSize: "11px" } }, `${s.pages.length} page${s.pages.length === 1 ? "" : "s"}`)));
  };
  let thumbTimer = 0;
  app.on("story", render); app.on("stroke-end", () => { if (thumbTimer || root.offsetParent === null) return; thumbTimer = window.setTimeout(() => { thumbTimer = 0; const el = root.querySelector(".page-thumb.active canvas"); if (el) { const t = thumbFor(app.doc); el.replaceWith(t); } }, 600); });
  app.on("doc-loaded", render);
  render();
  return root;
}
