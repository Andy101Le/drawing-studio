/**
 * Sample drawings: bundled, layered .omni documents (plain serializeDoc bytes under /samples/)
 * that open as an editable copy. The gallery is a modal with a preview per sample; opening one
 * goes through the same reset path as New so nothing from the previous document survives.
 */
import { deserializeDoc } from "../engine/serialize.js";
import { resetMedia } from "../engine/media.js";
import { h } from "./dom.js";
import type { AppState } from "./state.js";

export interface SampleDef { id: string; name: string; note: string; layers: string }
export const SAMPLES: SampleDef[] = [
  { id: "silver-glasses", name: "Procedural portrait (engine demo)", note: "Drawn by a script through the real tools: G-Pen ink with tapered strands, fills for flats, multiply airbrush shading, highlights. A demonstration of the layer split, not finished artwork.", layers: "Paper · Flats · Shade · Ink · Highlights" },
];

export async function openSample(app: AppState, def: SampleDef): Promise<void> {
  const res = await fetch(`samples/${def.id}.omni`); if (!res.ok) { alert(`Sample "${def.name}" is not available (${res.status}).`); return; }
  const doc = await deserializeDoc(new Uint8Array(await res.arrayBuffer()));
  app.emit("doc-reset");
  for (const l of app.doc.drawing.layers) resetMedia(l);
  app.history.clear(); app.story = null; app.selectedBalloon = null; app.selectedNode = null;
  doc.name = `${def.name} (copy)`;
  app.doc = doc; app.cache.index(app.doc); app.renderer.fitPage(app.doc); app.invalidate();
  app.emit("layers"); app.emit("timeline"); app.emit("panels"); app.emit("balloons"); app.emit("selection"); app.emit("doc-loaded"); app.emit("story"); app.emit("vector");
}

export function samplesModal(app: AppState): void {
  const close = () => backdrop.remove();
  const cards = SAMPLES.map((s) => h("div", { class: "sample-card", title: `Open "${s.name}" as an editable copy`, "data-help": `${s.note} Layers: ${s.layers}. Opens as a copy; your current document is replaced (save first).`, onClick: () => { if (confirm(`Open the sample "${s.name}"? The current document is replaced (autosave keeps a copy).`)) { close(); void openSample(app, s); } } },
    h("img", { src: `samples/${s.id}.png`, alt: s.name, loading: "lazy" }),
    h("div", { class: "cap" }, h("b", {}, s.name), h("span", { class: "dim" }, s.layers))));
  const backdrop = h("div", { class: "modal-backdrop", onClick: (e: Event) => { if (e.target === backdrop) close(); } },
    h("div", { class: "modal samples-modal" },
      h("div", { class: "row", style: { alignItems: "center", gap: "8px" } }, h("h3", { style: { margin: 0 } }, "Sample drawings"), h("span", { class: "dim", style: { fontSize: "11.5px" } }, "layered, editable copies: open one, then paint, erase or re-ink any layer"), h("span", { class: "grow" }), h("button", { title: "Close", onClick: close }, "✕")),
      h("div", { class: "sample-grid" }, ...cards)));
  document.body.append(backdrop);
}
