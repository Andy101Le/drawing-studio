/**
 * Manga panel: production mode switch, page presets with bleed/safe guides, panel layout
 * templates (click to apply, Shift-click to slant), and the balloon/lettering editor for the
 * selected balloon. In animation mode the same tab shows the mode switch only, the timeline
 * and Xsheet take over the bottom of the window.
 */
import type { AppState } from "./state.js";
import { h, clear, field, slider } from "./dom.js";
import { PAGE_PRESETS, PANEL_TEMPLATES, applyPanelTemplate, slantPanels, type BalloonKind } from "../engine/manga.js";
import { pageToPanel } from "../engine/panels.js";
import { storyStrip, ensureStory } from "./story.js";

const KINDS: Array<[BalloonKind, string]> = [["speech", "Speech"], ["thought", "Thought"], ["shout", "Shout"], ["whisper", "Whisper"], ["caption", "Caption"], ["none", "Free text / SFX"]];

async function exportChapter(app: AppState, kind: "pdf" | "zip"): Promise<void> {
  const { exportComposite, exportPdfPages } = await import("../engine/export.js");
  const { zipStore } = await import("../engine/anim-export.js");
  const s = ensureStory(app); const keep = app.doc; const pages: HTMLCanvasElement[] = []; const docs = s.rtl ? [...s.pages].reverse() : s.pages;
  for (const d of docs) { app.doc = d; pages.push(await exportComposite(d, (dd, sc) => app.renderer.flatten(dd, sc))); }
  app.doc = keep;
  let bytes: Uint8Array; let name: string;
  if (kind === "pdf") { bytes = await exportPdfPages(docs, pages); name = `${s.title}.pdf`; }
  else { const files: Array<{ name: string; data: Uint8Array }> = []; for (let i = 0; i < pages.length; i++) { const blob: Blob = await new Promise((res) => pages[i]!.toBlob((b) => res(b!), "image/png")); files.push({ name: `${s.title}_${String(i + 1).padStart(3, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) }); } bytes = zipStore(files); name = `${s.title}_pages.zip`; }
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([bytes as BlobPart])); a.download = name; a.click();
  app.exportMessage = `${name}: ${pages.length} pages, ${(bytes.byteLength / 1048576).toFixed(2)} MB`; app.emit("panels");
}

const CURATED: Array<{ label: string; css: string }> = [
  { label: "Manga sans (Noto Sans JP)", css: "'Noto Sans JP', 'Yu Gothic', 'Hiragino Sans', 'Comic Neue', sans-serif" },
  { label: "Mincho (serif JP)", css: "'Noto Serif JP', 'Yu Mincho', 'Hiragino Mincho ProN', serif" },
  { label: "Comic (Western lettering)", css: "'Comic Neue', 'Comic Sans MS', 'Chalkboard SE', cursive" },
  { label: "Anime title (bold gothic)", css: "'Impact', 'Arial Black', 'Noto Sans JP', sans-serif" },
  { label: "Typewriter", css: "'Courier New', 'JetBrains Mono', monospace" },
  { label: "Elegant serif", css: "Georgia, 'Times New Roman', serif" },
  { label: "Clean sans", css: "Inter, system-ui, 'Segoe UI', sans-serif" },
];
let systemFonts: string[] = [];
function fontChoices(current: string): Array<{ label: string; css: string }> {
  const list = [...CURATED, ...systemFonts.map((f) => ({ label: f, css: `'${f}'` }))];
  if (!list.some((f) => f.css === current)) list.unshift({ label: current, css: current });
  return list;
}
async function loadSystemFonts(then: () => void): Promise<void> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  if (!q) { alert("This browser does not expose installed fonts (Local Font Access is in Chrome and Edge)."); return; }
  try { const fonts = await q(); systemFonts = [...new Set(fonts.map((f) => f.family))].sort(); then(); } catch (e) { alert(`fonts: ${e instanceof Error ? e.message : String(e)}`); }
}

export function mangaPanel(app: AppState): HTMLElement {
  const root = h("div");
  const render = () => {
    clear(root);
    const d = app.doc;
    const modeRow = h("div", { class: "row", style: { gap: "6px", marginBottom: "8px" } },
      h("button", { class: d.mode === "manga" ? "active" : "", title: "Manga pages", "data-action": "mode.toggle", onClick: () => app.setMode("manga") }, "Manga pages"),
      h("button", { class: d.mode === "anime" ? "active" : "", title: "2D animation", "data-action": "mode.toggle", onClick: () => app.setMode("anime") }, "2D animation"));
    if (d.mode === "anime") {
      root.append(h("h3", {}, "Production mode"), modeRow,
        h("p", { class: "dim", style: { fontSize: "12px" } }, "Animation mode: timeline + Xsheet below, onion skin (O), frame keys (, .). Switch to Manga pages for page presets, panel templates and balloons."));
      return;
    }
    // ---- page presets ----
    const presetSel = h("select", {}, ...PAGE_PRESETS.map((p, i) => h("option", { value: String(i) }, p.name))) as HTMLSelectElement;
    const applyPreset = () => {
      const p = PAGE_PRESETS[Number(presetSel.value)]!;
      if (!confirm(`Set the page to ${p.name} (${p.w} x ${p.h} px)? Existing pixels keep their position.`)) return;
      d.width = p.w; d.height = p.h; d.dpi = p.dpi; app.pageGuides = { bleed: p.bleed, safe: p.safe };
      d.panels = [pageToPanel(d.width, d.height, p.safe, Math.round(p.dpi * 0.12))];
      app.renderer.fitPage(d); app.invalidate(); app.emit("panels"); app.emit("view");
    };
    // ---- templates ----
    const tiles = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "6px" } });
    for (const t of PANEL_TEMPLATES) {
      const c = h("canvas", { width: 60, height: 84, title: `${t.name}${t.note ? ": " + t.note : ""} (Shift-click: slanted gutters)`, style: { width: "60px", height: "84px", background: "#f4f4f4", border: "1px solid #666", cursor: "pointer", borderRadius: "2px" } }) as HTMLCanvasElement;
      const g = c.getContext("2d")!; g.fillStyle = "#1a1a1a";
      for (const [a, b, cc, dd] of t.cells) { g.strokeStyle = "#1a1a1a"; g.lineWidth = 1.5; g.strokeRect(4 + a * 52 + 1, 4 + b * 76 + 1, (cc - a) * 52 - 2, (dd - b) * 76 - 2); }
      c.addEventListener("click", (e) => {
        const margin = app.pageGuides?.safe ?? Math.round(d.dpi * 0.5), gutter = Math.round(d.dpi * 0.12);
        const prev = d.panels; let next = applyPanelTemplate(d, t, margin, gutter);
        if (e.shiftKey) next = slantPanels(next, Math.round(d.dpi * 0.25));
        d.panels = next; for (const f of d.frames) for (const l of f.layers) l.panelMask = null;
        app.history.pushCustom(`Template ${t.name}`, () => { d.panels = prev; app.invalidate(); app.emit("panels"); }, () => { d.panels = next; app.invalidate(); app.emit("panels"); });
        app.invalidate(); app.emit("panels");
      });
      tiles.append(h("div", { style: { textAlign: "center", fontSize: "10px" } }, c, h("div", { class: "dim" }, t.name)));
    }
    // ---- balloon editor ----
    const b = d.balloons.find((q) => q.id === app.selectedBalloon) ?? null;
    const upd = () => { app.invalidate(); };
    const editor = b ? h("div", {},
      field("Kind", h("select", { onChange: (e: Event) => { b.kind = (e.target as HTMLSelectElement).value as BalloonKind; if ((b.kind === "speech" || b.kind === "thought" || b.kind === "shout") && !b.tail) b.tail = { x: b.x + b.w * 0.3, y: b.y + b.h + d.dpi * 0.35 }; if (b.kind === "caption" || b.kind === "none" || b.kind === "whisper") b.tail = null; upd(); } }, ...KINDS.map(([k, n]) => h("option", { value: k, selected: b.kind === k }, n)))),
      h("textarea", { rows: 4, style: { width: "100%", font: "13px monospace" }, placeholder: "Dialogue... (Enter for a new line)", onInput: (e: Event) => { b.text = (e.target as HTMLTextAreaElement).value; upd(); } }, b.text),
      field("Size", slider(Math.round(d.dpi * 0.05), Math.round(d.dpi * 0.6), 1, b.size, (v) => { b.size = v; upd(); }), () => `${b.size} px`),
      field("Line height", slider(1, 2, 0.05, b.lineHeight, (v) => { b.lineHeight = v; upd(); }), () => b.lineHeight.toFixed(2)),
      field("Outline", slider(0, Math.round(d.dpi * 0.05), 1, b.strokeWidth, (v) => { b.strokeWidth = v; upd(); }), () => `${b.strokeWidth} px`),
      field("Layout", h("select", { onChange: (e: Event) => { b.vertical = (e.target as HTMLSelectElement).value === "v"; upd(); } }, h("option", { value: "h", selected: !b.vertical }, "horizontal"), h("option", { value: "v", selected: b.vertical }, "vertical (tategaki, columns right to left)"))),
      field("Weight", h("select", { onChange: (e: Event) => { b.bold = (e.target as HTMLSelectElement).value === "b"; upd(); } }, h("option", { value: "r", selected: !b.bold }, "regular"), h("option", { value: "b", selected: b.bold }, "bold"))),
      field("Font", h("select", { style: { width: "100%" }, onChange: (e: Event) => { b.font = (e.target as HTMLSelectElement).value; upd(); } }, ...fontChoices(b.font).map((f) => h("option", { value: f.css, selected: f.css === b.font, style: { fontFamily: f.css } }, f.label)))),
      h("div", { class: "row", style: { gap: "6px" } },
        h("button", { title: "List the fonts installed on this computer (Chrome/Edge, asks permission)", onClick: () => void loadSystemFonts(render) }, "System fonts…"),
        h("span", { class: "dim", style: { fontSize: "11px" } }, systemFonts.length ? `${systemFonts.length} installed` : "ruby: 漢字《かんじ》")),
      h("div", { class: "row", style: { gap: "6px", marginTop: "6px" } },
        h("button", { onClick: () => { b.fill = b.fill === "#ffffff" ? "#141414" : "#ffffff"; b.textColor = b.fill === "#ffffff" ? "#141414" : "#ffffff"; upd(); } }, "Invert (black balloon)"),
        h("button", { title: "Delete balloon", "data-keys": "Delete", onClick: () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Delete" })) }, "Delete")))
      : h("p", { class: "dim", style: { fontSize: "12px" } }, "Text tool (X): drag on the page to place a balloon of the kind chosen below, drag a balloon to move it, drag the blue dot to aim the tail. Select one to edit its text here.");
    root.append(h("h3", {}, "Production mode"), modeRow,
      h("div", { class: "sep" }), storyStrip(app, (kind) => void exportChapter(app, kind)),
      h("div", { class: "sep" }), h("h3", {}, "Page preset"),
      h("div", { class: "row", style: { gap: "6px" } }, presetSel, h("button", { onClick: applyPreset }, "Apply")),
      h("div", { class: "kv" }, h("span", {}, "page"), h("b", {}, `${d.width} x ${d.height} px @ ${d.dpi} dpi`), h("span", {}, "guides"), h("b", {}, app.pageGuides ? `bleed ${app.pageGuides.bleed} px · safe ${app.pageGuides.safe} px` : "none")),
      field("Show guides", h("input", { type: "checkbox", checked: app.showGuides, onChange: (e: Event) => { app.showGuides = (e.target as HTMLInputElement).checked; app.invalidate(); } })),
      h("div", { class: "sep" }), h("h3", {}, "Panel templates"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Click to lay out the page inside the safe area. Shift-click slants the gutters. Then refine with the cut tool (K)."),
      tiles,
      h("div", { class: "sep" }), h("h3", {}, "Balloons & lettering (X)"),
      field("New balloon", h("select", { onChange: (e: Event) => { app.balloonKind = (e.target as HTMLSelectElement).value as BalloonKind; } }, ...KINDS.map(([k, n]) => h("option", { value: k, selected: app.balloonKind === k }, n)))),
      editor,
      h("div", { class: "kv", style: { marginTop: "6px" } }, h("span", {}, "balloons"), h("b", {}, String(d.balloons.length))));
  };
  app.on("balloons", render); app.on("mode", render); app.on("panels", render); app.on("tool", () => { if (app.tool === "text") render(); });
  render();
  return root;
}
