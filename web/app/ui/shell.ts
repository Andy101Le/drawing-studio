/**
 * Application shell: ribbon (mode-aware primary actions), quick bar above the canvas
 * (what the hand needs every few seconds: preset, size, opacity, colour, stabiliser, undo),
 * and the right dock as an icon rail + one panel. Themes: three selectable looks that share
 * the same tokens (ui/theme.ts). Everything here is layout; behaviour stays in the panels.
 */
import type { AppState } from "./state.js";
import { samplesModal } from "./samples.js";
import { h, clear } from "./dom.js";
import { icon } from "./icons.js";
import { PRESETS } from "../engine/brush.js";
import { THEMES, applyTheme, currentTheme } from "./theme.js";
import { surfaceCss, TEXTURES, type Surface } from "../engine/surface.js";

export interface RibbonActions {
  newPage(): void; exportPng(): void; connectTablet(): void; toggleCompositor(): void; toggleCompact(): void; openPanel(name: string): void; save(): void;
}

export function buildRibbon(app: AppState, a: RibbonActions): HTMLElement {
  const bar = h("div", { id: "menubar" });
  const render = () => {
    const manga = app.doc.mode === "manga";
    clear(bar).append(
      h("div", { class: "brand-lockup" }, h("span", { class: "brand-mark" }), h("span", { class: "brand" }, "OMNI-CELL")),
      h("div", { class: "segmented modeswitch" },
        h("button", { id: "mode-manga", class: manga ? "active" : "", title: "Manga pages: presets, panels, balloons", "data-action": "mode.toggle", onClick: () => app.setMode("manga") }, "Manga"),
        h("button", { id: "mode-anime", class: !manga ? "active" : "", title: "2D animation: timeline and Xsheet", "data-action": "mode.toggle", onClick: () => app.setMode("anime") }, "Anime")),
      h("div", { class: "ribbon-group" },
        h("button", { title: "New page", onClick: a.newPage }, "New"),
        h("button", { title: "Sample drawings", onClick: () => samplesModal(app) }, "Samples"),
        h("button", { title: "Save encrypted to this device (vault)", "data-keys": "Ctrl + S", onClick: a.save }, "Save"),
        h("button", { title: "Fit page to the window", "data-action": "view.fit", onClick: () => { app.renderer.fitPage(app.doc); app.emit("view"); } }, "Fit")),
      h("div", { class: "ribbon-group" }, ...(manga ? [
        h("button", { title: "Page presets and panel templates", onClick: () => a.openPanel("Manga") }, "Templates"),
        h("button", { title: "Text & balloons", "data-action": "tool.text", class: app.tool === "text" ? "active" : "", onClick: () => app.setTool("text") }, "Balloons"),
        h("button", { title: "Manga effects", "data-action": "tool.fx", class: app.tool === "fx" ? "active" : "", onClick: () => app.setTool("fx") }, "FX"),
        h("button", { title: "Screentones", onClick: () => a.openPanel("Tone") }, "Tones"),
        h("button", { title: "Export PSD / PDF / PNG", onClick: () => a.openPanel("Page") }, "Export"),
      ] : [
        h("button", { title: "New drawing at this frame", onClick: () => { app.doc.newDrawingAtCurrent(); app.invalidate(); app.emit("layers"); app.emit("timeline"); } }, "+ Key"),
        h("button", { title: "Onion skin", "data-action": "anim.onion", class: app.doc.onionEnabled ? "active" : "", onClick: () => { app.doc.onionEnabled = !app.doc.onionEnabled; app.invalidate(); app.emit("timeline"); } }, "Onion"),
        h("button", { title: "Export PNG", onClick: a.exportPng }, "Export frame"),
      ])),
      h("span", { class: "grow" }),
      h("div", { class: "ribbon-group right" },
        h("select", { class: "theme-select", title: "Look", onChange: (e: Event) => { applyTheme((e.target as HTMLSelectElement).value); app.emit("theme"); } }, ...THEMES.map((t) => h("option", { value: t.id, selected: currentTheme() === t.id }, t.label))),
        h("button", { title: "Connect a drawing tablet over WebHID (Chrome/Edge)", onClick: a.connectTablet }, "Tablet"),
        h("span", { id: "hid-status", class: "dim mono", style: { fontSize: "11px" } }, ""),
        h("button", { id: "compositor-btn", title: "Toggle WebGPU / Canvas 2D compositor", onClick: a.toggleCompositor }, app.renderer?.mode === "webgpu" ? "WebGPU" : "Canvas 2D"),
        h("button", { title: "Tablet layout: hide panels, radial menu", onClick: a.toggleCompact }, "Tablet layout"),
        h("span", { class: `chip ${app.vault.unlocked ? "ok" : ""}`, title: "Vault state", onClick: () => a.openPanel("Vault") }, app.vault.unlocked ? "🔓 vault" : app.vault.enrolled ? "🔒 locked" : "no vault")));
  };
  app.on("mode", render); app.on("tool", render); app.on("vault", render); app.on("compositor", render); app.on("timeline", render);
  render();
  return bar;
}

export function buildQuickbar(app: AppState, openPanel: (name: string) => void): HTMLElement {
  const bar = h("div", { id: "quickbar" });
  const render = () => {
    const p = app.preset; const fam = PRESETS.filter((x) => x.category === p.category);
    clear(bar).append(
      h("span", { class: "qb-tool" }, icon(app.tool), h("span", {}, app.tool === "eraser" ? "Eraser" : app.tool === "brush" ? p.category[0]!.toUpperCase() + p.category.slice(1) : app.tool)),
      h("select", { class: "qb-preset", title: "Preset", onChange: (e: Event) => { const x = fam.find((q) => q.name === (e.target as HTMLSelectElement).value); if (x) app.setPreset(x); } }, ...fam.map((x) => h("option", { value: x.name, selected: x.name === p.name }, x.name))),
      h("label", {}, "size"), h("input", { type: "range", class: "qb-slider", min: 1, max: 300, step: 1, value: Math.round(p.size), title: "Brush size ([ ])", onInput: (e: Event) => { p.size = Number((e.target as HTMLInputElement).value); const v = bar.querySelector("#qb-size"); if (v) v.textContent = `${Math.round(p.size)} px`; app.emit("brush-size"); } }), h("span", { id: "qb-size", class: "mono qb-val" }, `${Math.round(p.size)} px`),
      h("label", {}, "opacity"), h("input", { type: "range", class: "qb-slider", min: 0.02, max: 1, step: 0.01, value: p.opacity, title: "Stroke opacity", onInput: (e: Event) => { p.opacity = Number((e.target as HTMLInputElement).value); const v = bar.querySelector("#qb-op"); if (v) v.textContent = `${Math.round(p.opacity * 100)}%`; } }), h("span", { id: "qb-op", class: "mono qb-val" }, `${Math.round(p.opacity * 100)}%`),
      h("label", {}, "stabilize"), h("input", { type: "range", class: "qb-slider short", min: 0, max: 30, step: 1, value: p.stabilizer, title: "Pull-string stabiliser radius", onInput: (e: Event) => { p.stabilizer = Number((e.target as HTMLInputElement).value); } }),
      h("span", { class: "qb-swatch", title: "Colour (opens the wheel)", style: { background: app.color }, onClick: () => openPanel("Color") }),
      h("span", { class: "grow" }),
      h("button", { class: "qb-icon", title: "Undo", "data-action": "edit.undo", onClick: () => { if (app.collab?.undo()) return; app.history.undo(app.doc); app.invalidate(app.history.lastRect ?? undefined); app.emit("layers"); } }, icon("undo")),
      h("button", { class: "qb-icon", title: "Redo", "data-action": "edit.redo", onClick: () => { if (app.collab?.redo()) return; app.history.redo(app.doc); app.invalidate(app.history.lastRect ?? undefined); app.emit("layers"); } }, icon("redo")),
      h("span", { class: "mono qb-val", id: "qb-zoom" }, app.renderer ? `${Math.round(app.renderer.view.zoom * 100)}%` : ""));
  };
  app.on("brush", render); app.on("tool", render); app.on("color", render);
  app.on("view", () => { const z = bar.querySelector("#qb-zoom"); if (z) z.textContent = `${Math.round(app.renderer.view.zoom * 100)}%`; });
  render();
  return bar;
}

const RAIL_ICONS: Record<string, string> = { Layers: "layers", Brush: "brush", Color: "palette", Tone: "tone", Manga: "book", Page: "page", "3D": "cube", Live: "live", Bridge: "link", Vault: "lock", Generate: "spark", Redraw: "redraw", Dataset: "photos", Story: "script", Settings: "gear" };
export function buildDock(app: AppState, defs: Array<[string, () => HTMLElement]>): { side: HTMLElement; open: (name: string) => void } {
  const side = h("div", { id: "side" });
  const rail = h("div", { class: "rail" }); const panels = h("div", { class: "panels" });
  const els: HTMLElement[] = []; const btns: HTMLElement[] = [];
  const open = (name: string) => { const i = defs.findIndex(([n]) => n === name); if (i < 0) return; els.forEach((p, j) => p.classList.toggle("active", j === i)); btns.forEach((b, j) => b.classList.toggle("active", j === i)); app.dockPanel = name; app.emit("dock", name); };
  defs.forEach(([name, make], i) => {
    const el = h("div", { class: `panel ${i === 0 ? "active" : ""}` }, h("div", { class: "panel-title" }, name), make());
    els.push(el); panels.append(el);
    const b = h("button", { class: i === 0 ? "active" : "", title: name, onClick: () => open(name) }, icon(RAIL_ICONS[name] ?? "page"));
    btns.push(b); rail.append(b);
  });
  side.append(panels, rail);
  return { side, open };
}

/** Surface section for the Page tab. */
export function surfaceSection(app: AppState, viewport: HTMLElement): HTMLElement {
  const root = h("div");
  const apply = () => { Object.assign(viewport.style, surfaceCss(app.doc.surface)); if (app.renderer) app.invalidate(); };
  const render = () => {
    const s: Surface = app.doc.surface;
    const set = (patch: Partial<Surface>) => { Object.assign(s, patch); apply(); render(); };
    clear(root).append(h("div", { class: "sep" }), h("h3", {}, "Surface behind the paper"),
      h("div", { class: "segmented", style: { marginBottom: "6px" } }, ...(["color", "gradient", "image", "texture"] as const).map((k) => h("button", { class: s.kind === k ? "active" : "", onClick: () => set({ kind: k }) }, k))),
      s.kind === "texture" ? h("div", { class: "texture-grid" }, ...TEXTURES.map((t) => h("div", { class: `tex ${s.texture === t.name ? "active" : ""}`, title: t.label, style: { background: `url(${textureUrl(t.name)}) center / 96px` }, onClick: () => set({ texture: t.name }) }, h("span", {}, t.label)))) : null,
      s.kind !== "texture" ? h("div", { class: "field" }, h("label", {}, s.kind === "gradient" ? "from" : "colour"), h("input", { type: "color", value: s.color, onInput: (e: Event) => { s.color = (e.target as HTMLInputElement).value; apply(); } }), h("span", { class: "val" }, s.color)) : null,
      s.kind === "gradient" ? h("div", { class: "field" }, h("label", {}, "to"), h("input", { type: "color", value: s.color2, onInput: (e: Event) => { s.color2 = (e.target as HTMLInputElement).value; apply(); } }), h("span", { class: "val" }, s.color2)) : null,
      s.kind === "gradient" ? h("div", { class: "field" }, h("label", {}, "angle"), h("input", { type: "range", min: 0, max: 360, step: 1, value: s.angle, onInput: (e: Event) => { s.angle = Number((e.target as HTMLInputElement).value); apply(); } }), h("span", { class: "val" }, `${s.angle}°`)) : null,
      s.kind === "image" ? h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
        h("label", { class: "btn", style: { cursor: "pointer" } }, s.image ? "Replace image" : "Choose image", h("input", { type: "file", accept: "image/*", style: { display: "none" }, onChange: (e: Event) => { const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => set({ image: String(r.result) }); r.readAsDataURL(f); } })),
        h("select", { onChange: (e: Event) => set({ imageMode: (e.target as HTMLSelectElement).value as "cover" | "tile" }) }, h("option", { value: "cover", selected: s.imageMode === "cover" }, "fit (cover)"), h("option", { value: "tile", selected: s.imageMode === "tile" }, "tile")),
        h("div", { class: "field", style: { width: "100%" } }, h("label", {}, "dim"), h("input", { type: "range", min: 0, max: 0.9, step: 0.01, value: s.imageTint, onInput: (e: Event) => { s.imageTint = Number((e.target as HTMLInputElement).value); apply(); } }), h("span", { class: "val" }, `${Math.round(s.imageTint * 100)}%`))) : null,
      h("div", { class: "field" }, h("label", {}, "page shadow"), h("input", { type: "checkbox", checked: s.shadow, onChange: (e: Event) => set({ shadow: (e.target as HTMLInputElement).checked }) }), h("span")),
      h("div", { class: "field" }, h("label", {}, "in exports"), h("input", { type: "checkbox", checked: s.inExport, onChange: (e: Event) => set({ inExport: (e.target as HTMLInputElement).checked }) }), h("span", { class: "val" }, s.inExport ? "yes" : "no")),
      h("p", { class: "dim", style: { fontSize: "11px" } }, "Saved with the document. With 'in exports' on, the surface fills transparent areas of PNG/PDF/PSD output (webtoon covers, social posts)."));
  };
  app.on("doc-loaded", () => { apply(); render(); });
  render(); apply();
  return root;
}
import { textureTile } from "../engine/surface.js";
const texUrlCache = new Map<string, string>();
function textureUrl(name: Parameters<typeof textureTile>[0]): string { let u = texUrlCache.get(name); if (!u) { u = textureTile(name).toDataURL(); texUrlCache.set(name, u); } return u; }
