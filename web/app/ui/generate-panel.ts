/**
 * Generate tab (ML Studio). Provider status, a mode that decides what the app sends with the
 * prompt (nothing / the ink layers as a ControlNet image / the whole drawing for img2img / a
 * reference image), the usual sampler parameters, and a results strip whose entries land on
 * new layers with their parameters recorded, so any result can be reproduced or re-seeded.
 */
import { setRedrawSource } from "./redraw-panel.js";
import { TAG_GROUPS, PANEL_RECIPES, MANGA_LOOK_TAGS, MANGA_LOOK_NEGATIVE } from "./manga-tags.js";
import { DESIGN_DEFAULTS, designPrompt, renderDesign, renderStyleTags, type Design } from "./character-design.js";
import { FINISH_DEFAULTS, type FinishOptions, type MangaFinish } from "../engine/manga-finish.js";
import { JobRunner, MockProvider, SidecarProvider, canvasToPng, imageHash, hashDistance, type DatasetStats, layersToPng, pngToLayer, selectionToMaskPng, type GenMode, type GenRequest, type Provider, type ProviderHealth, type Region } from "../engine/ml.js";
import { clear, field, h, slider } from "./dom.js";
import type { AppState } from "./state.js";

const KEY = "omni.ml";
interface Saved { provider: string; base: string; prompt: string; negative: string; mode: GenMode; width: number; height: number; steps: number; guidance: number; seed: number; strength: number; controlWeight: number; remoteOk: boolean; qualityTags: boolean; scheduler: GenRequest["scheduler"]; cfgRescale: number; hiresFix: boolean; hiresStrength: number; controlPreprocess: GenRequest["controlPreprocess"]; referenceScale: number; loras: Array<{ name: string; weight: number }>; tags: string[]; useDepth: boolean; depthWeight: number; fast: boolean; freeu: boolean; refAlways: boolean; mangaLook: boolean; finish: MangaFinish; lpi: number; panelId: number; openGroups: string[]; seedMode: "new" | "fixed"; steerKept: boolean; steerWeight: number; dedupe: boolean; design: Design }
const DEF: Saved = { provider: "sidecar", base: "http://127.0.0.1:8790", prompt: "anime illustration, clean lineart, flat cel shading, soft light", negative: "lowres, blurry, extra fingers, watermark, text", mode: "lines", width: 512, height: 768, steps: 25, guidance: 6, seed: 1, strength: 0.6, controlWeight: 0.9, remoteOk: false, qualityTags: true, scheduler: "dpmpp_2m_karras", cfgRescale: 0, hiresFix: false, hiresStrength: 0.35, controlPreprocess: "none", referenceScale: 0.6, loras: [], tags: [], useDepth: false, depthWeight: 0.6, fast: false, freeu: true, refAlways: false, mangaLook: false, finish: "none", lpi: 60, panelId: -1, openGroups: ["Cast", "Shot", "Camera"], seedMode: "new", steerKept: true, steerWeight: 0.3, dedupe: true, design: { ...DESIGN_DEFAULTS } };
function load(): Saved { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Saved>; return { ...DEF, ...v, design: { ...DESIGN_DEFAULTS, ...(v.design ?? {}) } }; } catch { return { ...DEF, design: { ...DESIGN_DEFAULTS } }; } }

export function generatePanel(app: AppState): HTMLElement {
  const root = h("div", { class: "gen-tab" });
  const st = load(); const save = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch { /* quota */ } refreshTokens(); };
  const providers: Record<string, () => Provider> = { sidecar: () => new SidecarProvider(st.base), mock: () => new MockProvider() };
  let runner = new JobRunner(providers[st.provider]!()); let health: ProviderHealth | null = null; let reference: string | null = null;
  /** extra attached images (character sheet, colour key, style sample), sent with the reference */
  let references: string[] = [];
  const pickImages = (files: FileList | null) => { if (!files) return; for (const f of [...files].slice(0, 4 - references.length)) { const r = new FileReader(); r.onload = () => { references.push(String(r.result)); render(); }; r.readAsDataURL(f); } };
  (app as unknown as { ml: JobRunner }).ml = runner;
  let render: () => void = () => {};
  const checkHealth = async () => { health = await runner.provider.health(); render(); if (health.ok) { void refreshModels(); void refreshStats(); } };
  const setProvider = (id: string) => { st.provider = id; save(); runner = new JobRunner(providers[id]!()); runner.onChange = () => { render(); void checkDuplicates(); }; (app as unknown as { ml: JobRunner }).ml = runner; health = null; void checkHealth(); };
  runner.onChange = () => { render(); void checkDuplicates(); };

  /** the panel being generated for, as its bounding box; null = the whole page */
  const panelRegion = (): (Region & { panelId: number }) | null => {
    if (st.panelId < 0) return null; const p = app.doc.panels.find((q) => q.id === st.panelId); if (!p || !p.polygon.length) return null;
    const xs = p.polygon.map((q) => q.x), ys = p.polygon.map((q) => q.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), panelId: p.id };
  };
  /** generation size for a panel: its shape (clamped to what the models handle), at the model's native pixel count */
  const panelSize = (r: Region): [number, number] => {
    const native = health?.family === "sdxl" ? 1024 * 1024 : 512 * 768;
    const area = Math.min(health?.maxPx ?? native, native);
    const a = Math.min(2.5, Math.max(0.4, (r.x1 - r.x0) / Math.max(1, r.y1 - r.y0)));
    // size the width from the area, then the height from the panel's shape, so the crop stays small
    let w = Math.max(384, Math.round(Math.sqrt(area * a) / 64) * 64), hh = Math.max(384, Math.round(w / a / 64) * 64);
    while (w * hh > area * 1.08 && w > 384 && hh > 384) { if (w / hh > a) w -= 64; else hh -= 64; }
    return [w, hh];
  };
  const finishOpts = (): FinishOptions | null => st.finish === "none" ? null : { ...FINISH_DEFAULTS, mode: st.finish, lpi: st.lpi, dpi: app.doc.dpi || 300 };
  const KEEP_ON_RECIPE = new Set(TAG_GROUPS.filter((g) => ["Cast", "Look", "Emotion", "Manga look"].includes(g.name)).flatMap((g) => g.tags));
  let tagFilter = ""; let customTag = "";
  const inkLayers = () => app.doc.drawing.layers.filter((l) => l.kind === "raster" && l.visible && /ink|line|sketch/i.test(l.name));
  /**
   * Prompt order matters: CLIP attends most to the first 75 tokens, and the sidecar now encodes the
   * rest in further chunks rather than dropping it. So: LoRA trigger words, the character design,
   * the prompt text (subject), the scene tags, and the style words last.
   */
  const composePrompt = (): { prompt: string; negative: string } => {
    const d = designPrompt(st.design);
    const triggers = st.loras.map((l) => loraTriggers[l.name]).filter((t): t is string => !!t && !st.prompt.includes(t) && !st.tags.includes(t));
    const style = [...(st.mangaLook ? MANGA_LOOK_TAGS : []), ...renderStyleTags(st.design)];
    const styleSet = new Set(style);
    const parts = [...triggers, ...d.positive, st.prompt.trim(), ...st.tags.filter((t) => !styleSet.has(t)), ...style];
    const prompt = [...new Set(parts.filter(Boolean))].join(", ");
    const negative = [...new Set([st.negative.trim(), ...(st.mangaLook ? [MANGA_LOOK_NEGATIVE] : []), ...d.negative].filter(Boolean))].join(", ");
    return { prompt, negative };
  };
  const buildRequest = (): GenRequest => {
    const region = panelRegion(); const [gw, gh] = region ? panelSize(region) : [st.width, st.height];
    const req: GenRequest = { mode: st.mode, prompt: st.prompt, negative: st.negative, width: gw, height: gh, steps: st.steps, guidance: st.guidance, seed: st.seed, strength: st.strength, controlWeight: st.controlWeight, qualityTags: st.qualityTags, scheduler: st.scheduler, cfgRescale: st.cfgRescale, hiresFix: st.hiresFix, hiresStrength: st.hiresStrength, controlPreprocess: st.controlPreprocess, referenceScale: st.referenceScale, loras: st.loras, controls: [], freeu: st.freeu, fast: st.fast };
    if (region) req.region = region;
    if (st.useDepth && app.nprDepth) { const d = app.nprDepth(); if (d) req.controls.push({ type: "depth", image: canvasToPng(d, app.doc, gw, gh, region), weight: st.depthWeight }); }
    if (st.refAlways && reference && st.mode !== "reference") req.reference = reference;
    if (references.length && (st.mode === "reference" || st.refAlways)) req.references = references;
    const built = composePrompt();
    req.prompt = built.prompt; req.negative = built.negative;
    const all = app.doc.drawing.layers.filter((l) => l.kind === "raster");
    if (st.mode === "lines") { const src = inkLayers().length ? inkLayers() : [app.doc.activeLayer]; req.control = layersToPng(app.doc, src, gw, gh, true, region); }
    if (st.mode === "repaint") req.init = layersToPng(app.doc, all, gw, gh, true, region);
    if (st.mode === "reference" && reference) req.reference = reference;
    if (st.mode === "inpaint") { req.init = layersToPng(app.doc, all, gw, gh, true, region); if (app.selection) req.mask = selectionToMaskPng(app.doc, app.selection, gw, gh, region); }
    return req;
  };
  let presets: Array<{ name: string; family: string }> = []; let currentModel = ""; let loraNames: string[] = []; let loraTriggers: Record<string, string> = {};
  /** CLIP token counts for the prompt as it will be sent (null until the provider answers) */
  let tokenInfo: { prompt: number; negative: number; chunk: number } | null = null; let tokenTimer = 0;
  const refreshTokens = () => { if (!runner.provider.tokens) { tokenInfo = null; return; } clearTimeout(tokenTimer); tokenTimer = window.setTimeout(async () => { try { const c = composePrompt(); tokenInfo = await runner.provider.tokens!(c.prompt, c.negative, st.qualityTags); } catch { tokenInfo = null; } const el = root.querySelector("[data-tokens]"); if (el) el.replaceWith(tokenMeter()); }, 350); };
  let stats: DatasetStats | null = null;
  const refreshStats = async () => { try { if (runner.provider.datasetStats) stats = await runner.provider.datasetStats(); } catch { stats = null; } render(); };
  const rate = async (v: "liked" | "rejected", j: { result: { image: string; seed: number } | null; req: GenRequest }) => {
    if (!j.result || !runner.provider.rate) return;
    const meta = { ...j.req, control: undefined, init: undefined, reference: undefined, references: undefined, controls: undefined, mask: undefined, seed: j.result.seed };
    // caption = the prompt that actually made it (tags, manga look and all), so training learns the same words
    try { stats = await runner.provider.rate(j.result.image, v, j.req.prompt || [...st.tags, st.prompt].filter(Boolean).join(", "), meta); render(); }
    catch (e) { alert((e as Error).message); }
  };
  const refreshModels = async () => { try { if (runner.provider.models) { const m = await runner.provider.models(); presets = m.presets; currentModel = m.current; } if (runner.provider.loras) loraNames = await runner.provider.loras(); if (runner.provider.loraTriggers) loraTriggers = await runner.provider.loraTriggers(); } catch { presets = []; loraNames = []; } render(); refreshTokens(); };
  const newSeed = () => (crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff);
  /**
   * Taste from the training set: two random kept images ride along as IP-Adapter references at a low
   * weight. A different pair each job, so results lean toward what was kept without converging on it.
   */
  let steerNote = "";
  const withKeptSteering = async (req: GenRequest): Promise<GenRequest> => {
    steerNote = "";
    if (!st.steerKept || !runner.provider.sampleKept || health?.ipAdapter === false) return req;
    const room = 4 - (req.reference ? 1 : 0) - (req.references?.length ?? 0); if (room <= 0) return req;
    try {
      const { images, pool } = await runner.provider.sampleKept(Math.min(2, room));
      if (!images.length) return req;
      req.references = [...(req.references ?? []), ...images];
      // the user's own reference keeps its weight; steering alone uses the gentle one
      if (!req.reference && !(st.mode === "reference" || st.refAlways)) req.referenceScale = st.steerWeight;
      steerNote = `steered by ${images.length} of ${pool} kept`;
    } catch { /* sidecar without the endpoint: plain job */ }
    return req;
  };
  // ---- near-duplicate guard: compare each finished result with the ones before it ----
  const hashes = new Map<string, bigint>(); const checking = new Set<string>(); let replaced = 0;
  const checkDuplicates = async () => {
    if (!st.dedupe) return;
    for (const j of [...runner.jobs]) {
      if (j.status !== "done" || !j.result || hashes.has(j.id) || checking.has(j.id)) continue;
      checking.add(j.id);
      try {
        const h0 = await imageHash(j.result.image);
        const dup = [...hashes.entries()].find(([id, h1]) => id !== j.id && hashDistance(h0, h1) <= 6);
        if (dup && !(j.req as GenRequest & { retry?: number }).retry) {
          // same picture again (same seed, or a reference strong enough to pin the composition):
          // drop it and run once more with a fresh seed
          const i = runner.jobs.indexOf(j); if (i >= 0) runner.jobs.splice(i, 1); replaced++;
          const again = { ...j.req, seed: newSeed(), retry: 1 } as GenRequest; render();
          void runner.run(again);
        } else hashes.set(j.id, h0);
      } catch { /* undecodable: leave it */ }
      checking.delete(j.id);
    }
  };
  const generate = async () => {
    if (st.mode === "inpaint" && !app.selection) { alert("Select the area to regenerate first (M, W or the lasso), then Generate."); return; }
    if (runner.provider.leavesDevice && !st.remoteOk) { if (!confirm(`${runner.provider.name} sends your drawing and prompt to a remote service. Continue?`)) return; st.remoteOk = true; save(); }
    if (st.seedMode === "new") { st.seed = newSeed(); save(); }
    try { await runner.run(await withKeptSteering(buildRequest())); } catch (e) {
      const msg = (e as Error).message;
      if (/failed to fetch|NetworkError|ECONNREFUSED|not reachable/i.test(msg)) {
        void checkHealth();
        if (confirm(`The local sidecar is not running at ${st.base}, so there is no model to generate with.\n\nStart it: open PowerShell in omni-cell\\ml\\sidecar and run start.bat (first run installs it and downloads the weights). Then press Check in this tab.\n\nSwitch to the Mock provider now instead? It draws a placeholder so you can see the workflow without a model.`)) setProvider("mock");
      } else alert(`Could not start the job: ${msg}`);
    }
  };
  const renderAllFrames = async () => {
    const frames = app.doc.frames; const keep = app.doc.currentFrame; const seed = st.seed;
    for (let i = 0; i < frames.length; i++) {
      app.doc.currentFrame = app.doc.exposure.indexOf(i) >= 0 ? app.doc.exposure.indexOf(i) : app.doc.currentFrame; // show the drawing while it renders
      const f = frames[i]!; const src = f.layers.filter((l) => l.kind === "raster" && l.visible && /ink|line|sketch/i.test(l.name));
      const req = buildRequest(); req.seed = seed; if (st.mode === "lines") req.control = layersToPng(app.doc, src.length ? src : f.layers.filter((l) => l.kind === "raster"), st.width, st.height, true);
      const rec = await runner.run(req);
      await new Promise<void>((res) => { const t = window.setInterval(() => { if (rec.status === "done" || rec.status === "error" || rec.status === "cancelled") { window.clearInterval(t); res(); } }, 200); });
      if (rec.result) { const l = await pngToLayer(app.doc, rec.result.image, `Gen f${i + 1}`, f); (l as unknown as { meta: unknown }).meta = { ml: { ...req, control: undefined, init: undefined, reference: undefined, controls: undefined, seed: rec.result.seed, model: rec.result.model, frame: i } }; }
      app.invalidate(); app.emit("layers"); app.emit("timeline");
    }
    app.doc.currentFrame = keep; app.invalidate(); app.emit("frame");
  };
  const addAsLayer = async (png: string, label: string, meta: GenRequest, seed: number, model: string) => {
    const region = meta.region ?? null;
    const l = await pngToLayer(app.doc, png, label, undefined, region, finishOpts());
    // a panel result is clipped to its panel's shape, like anything else drawn for that panel
    if (region && "panelId" in region && app.doc.panels.some((p) => p.id === (region as { panelId: number }).panelId)) l.panelMask = (region as { panelId: number }).panelId;
    (l as unknown as { meta: unknown }).meta = { ml: { ...meta, control: undefined, init: undefined, reference: undefined, references: undefined, controls: undefined, mask: undefined, seed, model, finish: st.finish } };
    // A generated image is opaque and page-sized, so on top it hides the drawing. When the job was
    // steered by the artist's lines, the colour belongs UNDER them: slot it below the lowest
    // Ink / Line / Sketch layer so the drawing still reads. Anything else goes on top, as a paste would.
    const list = app.doc.drawing.layers;
    const inkAt = list.findIndex((x) => x.kind === "raster" && x !== l && /ink|line|sketch/i.test(x.name));
    if (meta.mode === "lines" && inkAt >= 0) { list.splice(list.indexOf(l), 1); list.splice(inkAt, 0, l); }
    const at = list.indexOf(l);
    app.history.pushCustom(`Generated layer ${label}`, () => { app.doc.removeLayer(l.id); app.invalidate(); app.emit("layers"); }, () => { app.doc.drawing.layers.splice(Math.min(at, app.doc.drawing.layers.length), 0, l); app.invalidate(); app.emit("layers"); });
    app.doc.activeLayerId = l.id;
    app.invalidate(); app.emit("layers"); app.emit("layers-refresh");
  };

  const tokenMeter = (): HTMLElement => {
    const c = composePrompt();
    const est = (t: string) => Math.round(t.split(/[\s,]+/).filter(Boolean).length * 1.3);
    const n = tokenInfo ? tokenInfo.prompt : est(c.prompt) + 4, chunk = tokenInfo?.chunk ?? 75, chunks = Math.max(1, Math.ceil(n / chunk));
    const over = n > chunk;
    return h("p", { "data-tokens": "1", class: "dim", style: { fontSize: "11px", margin: "2px 0", color: over ? "#d9b65c" : "" } },
      `${tokenInfo ? "" : "≈"}${n} tokens · ${chunks} chunk${chunks > 1 ? "s" : ""} of ${chunk}`,
      over ? ` · the model reads the first ${chunk} most closely; the sidecar encodes the rest in further chunks (old builds dropped them)` : "");
  };
  render = () => {
    const modes: Array<[GenMode, string, string]> = [["text", "Text only", "Prompt alone; nothing from the canvas is sent."], ["lines", "Colour my lines", "Your Ink / Sketch layers go in as a ControlNet lineart image: the model renders colour and light on your drawing."], ["repaint", "Repaint this drawing", "The whole drawing goes in as img2img; Strength decides how far it may depart."], ["inpaint", "Fix this area", "Regenerate only inside the current selection (hands, a face, a background corner); the rest stays pixel for pixel."], ["reference", "Style from reference", "A picture you pick sets the style (IP-Adapter); your lines still steer when present."]];
    clear(root).append(
      h("h3", {}, "Generate (ML Studio)"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "A model renders an image from your prompt and, if you choose, your own lines. Results land on new layers with their seed and settings recorded."),
      field("Provider", h("select", { title: "Provider", "data-help": "Local sidecar keeps every pixel on this computer (needs the Python sidecar running with a GPU). Mock draws a placeholder so you can try the workflow without a model.", onChange: (e: Event) => setProvider((e.target as HTMLSelectElement).value) },
        h("option", { value: "sidecar", selected: st.provider === "sidecar" }, "Local sidecar (your GPU)"), h("option", { value: "mock", selected: st.provider === "mock" }, "Mock placeholder"))),
      st.provider === "sidecar" ? field("Address", h("input", { type: "text", value: st.base, style: { width: "100%" }, onChange: (e: Event) => { st.base = (e.target as HTMLInputElement).value; save(); setProvider("sidecar"); } })) : null,
      h("div", { class: "row", style: { gap: "6px", alignItems: "center", margin: "4px 0" } },
        h("button", { title: "Check provider", "data-help": "Ask the provider which model and device it has loaded.", onClick: () => void checkHealth() }, "Check"),
        h("span", { class: `chip ${health?.ok ? "ok" : ""}` }, health ? (health.ok ? `${health.model ?? "ready"}${health.device ? " · " + health.device : ""}${health.vramGB ? ` · ${health.freeVramGB ?? "?"}/${health.vramGB} GB free` : ""}${health.profile ? ` · ${health.profile}` : ""}` : "offline") : "not checked"),
        runner.provider.leavesDevice ? h("span", { class: "chip warn", title: "Images leave this device" }, "remote") : h("span", { class: "chip", title: "Nothing leaves this device" }, "local")),
      health && !health.ok ? h("div", { class: "notice", style: { fontSize: "11px" } },
        "No model is running, so Generate cannot work yet.", h("br"),
        "Start the sidecar: open a terminal in omni-cell\\ml\\sidecar and run .\\start.bat (Windows) or python -m sidecar --model dreamshaper-8-sd15 (first run installs it and downloads ~2 GB). Then press Check.", h("br"),
        h("button", { style: { marginTop: "4px" }, title: "Use the mock provider", "data-help": "Draw a placeholder instead of a real image, so the workflow (layers, seeds, metadata) can be tried without a model.", onClick: () => setProvider("mock") }, "Use mock instead"),
        h("span", { class: "dim", style: { marginLeft: "6px" } }, health.message ?? "")) : null,
      h("div", { class: "sep" }), h("h3", {}, "What goes in"),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "4px", marginBottom: "4px" } }, ...modes.map(([id, label, help]) => h("button", { class: st.mode === id ? "active" : "", title: label, "data-help": help, onClick: () => { st.mode = id; save(); render(); } }, label))),
      st.mode === "lines" ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, inkLayers().length ? `Using: ${inkLayers().map((l) => l.name).join(", ")}` : "No layer named Ink / Line / Sketch is visible; the active layer will be used.") : null,
      st.mode === "inpaint" ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, app.selection ? "The selection is the mask; Strength 1 replaces it fully, 0.5 keeps its colours." : "No selection yet: select the area to fix first.") : null,
      st.mode === "lines" ? field("Line input", h("select", { title: "Line input", "data-help": "None: your ink is already clean lines. Anime lineart / scribble: run a detector first, for rough pencil sketches or photos.", onChange: (e: Event) => { st.controlPreprocess = (e.target as HTMLSelectElement).value as GenRequest["controlPreprocess"]; save(); } }, ...([["none", "clean ink (as drawn)"], ["lineart_anime", "rough sketch → anime lineart"], ["scribble", "scribble"]] as const).map(([v, l]) => h("option", { value: v, selected: st.controlPreprocess === v }, l)))) : null,
      app.doc.drawing.layers.some((l) => l.kind === "npr") ? field("3D depth", h("div", { class: "row", style: { gap: "6px", alignItems: "center" } }, h("input", { type: "checkbox", checked: st.useDepth, title: "3D depth", "data-help": "Send the 3D layer's depth map as a second ControlNet: the model keeps the mannequin's pose, volume and camera. Combine with your lines or use alone.", onChange: (e: Event) => { st.useDepth = (e.target as HTMLInputElement).checked; save(); render(); } }), st.useDepth ? slider(0.2, 1.2, 0.05, st.depthWeight, (v) => { st.depthWeight = v; save(); }) : null)) : null,
      h("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap", margin: "4px 0" } },
        h("label", { class: "btn", style: { cursor: "pointer" }, title: "Attach images", "data-help": "Attach up to 4 pictures the model should look at while it draws: a character sheet, a colour key, a style sample, a reference photo. They go in through IP-Adapter next to the prompt; the prompt still says what to draw, the pictures say how it should look." }, "Attach images…", h("input", { type: "file", accept: "image/*", multiple: true, style: { display: "none" }, onChange: (e: Event) => pickImages((e.target as HTMLInputElement).files) })),
        ...references.map((src, i) => h("div", { style: { position: "relative" } }, h("img", { src, style: { width: "40px", height: "40px", objectFit: "cover", border: "1px solid #444", borderRadius: "3px" } }), h("button", { title: "Remove image", style: { position: "absolute", top: "-6px", right: "-6px", padding: "0 4px", fontSize: "10px" }, onClick: () => { references.splice(i, 1); render(); } }, "✕"))),
        references.length ? h("span", { class: "dim", style: { fontSize: "11px" } }, `${references.length}/4 attached`) : null),
      (references.length || reference) && health?.ok && health.ipAdapter === false ? h("div", { class: "notice", style: { fontSize: "11px" } }, "The sidecar was started without IP-Adapter, so attached images are ignored. Restart it with start.ps1 (IP-Adapter is on by default) or add --ip-adapter.") : null,
      (reference || references.length) && st.mode !== "reference" ? field("Keep reference", h("input", { type: "checkbox", checked: st.refAlways, title: "Keep reference", "data-help": "Also send the attached images with this mode (lines, repaint, fix), so the same character and look come back across panels and frames.", onChange: (e: Event) => { st.refAlways = (e.target as HTMLInputElement).checked; save(); } })) : null,
      // the reference image: picked here in "Style from reference" mode, or set by a result's Reference
      // button; shown (and removable) in every mode, because "Keep reference" still sends it elsewhere
      (st.mode === "reference" || reference) ? h("div", { class: "row", style: { gap: "6px", alignItems: "center" } },
        st.mode === "reference" ? h("label", { class: "btn", style: { cursor: "pointer" }, title: reference ? "Replace reference image" : "Pick reference image", "data-help": "The one picture whose style and colours the result should follow. Replaces the current one." }, reference ? "Replace reference" : "Pick reference image", h("input", { type: "file", accept: "image/*", style: { display: "none" }, onChange: (e: Event) => { const input = e.target as HTMLInputElement; const f = input.files?.[0]; input.value = ""; if (!f) return; const r = new FileReader(); r.onload = () => { reference = String(r.result); render(); }; r.readAsDataURL(f); } })) : h("span", { class: "dim", style: { fontSize: "11px" } }, "Reference"),
        reference
          ? h("img", { src: reference, title: "Reference image", style: { width: "40px", height: "40px", objectFit: "cover", border: "1px solid #444", borderRadius: "3px" } })
          : h("span", { class: "dim" }, "none"),
        reference ? h("button", { title: "Remove reference image", "data-help": "Stop sending this picture. Attached images are kept.", onClick: () => { reference = null; render(); } }, "Remove") : null) : null,
      h("div", { class: "sep" }), h("h3", {}, "Manga panel"),
      (() => {
        const panels = app.doc.panels; const region = panelRegion();
        return h("div", {},
          field("Target", h("select", { title: "Target panel", "data-help": "Generate for one panel: the image is made in that panel's shape, your lines inside it are what the model follows, and the result lands clipped to the panel. Draw panels with the Manga tab's panel tools.", onChange: (e: Event) => { st.panelId = Number((e.target as HTMLSelectElement).value); save(); render(); } },
            h("option", { value: "-1", selected: st.panelId < 0 }, "Whole page"),
            ...panels.map((p, i) => { const xs = p.polygon.map((q) => q.x), ys = p.polygon.map((q) => q.y); const w = Math.round(Math.max(...xs) - Math.min(...xs)), hh = Math.round(Math.max(...ys) - Math.min(...ys)); return h("option", { value: String(p.id), selected: st.panelId === p.id }, `Panel ${i + 1} (${w}×${hh})`); }))),
          region ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, `Generates at ${panelSize(region).join("×")} in the panel's shape${(region.x1 - region.x0) / (region.y1 - region.y0) > 2.5 || (region.x1 - region.x0) / (region.y1 - region.y0) < 0.4 ? " (very long panels are cropped to 2.5:1)" : ""}. Turn on Hi-res fix and Upscale 2× for print.`) : null,
          field("Manga look", h("input", { type: "checkbox", checked: st.mangaLook, title: "Manga look", "data-help": `Adds ${MANGA_LOOK_TAGS.join(", ")} to the prompt and keeps colour, the model's own panel borders, speech bubbles and lettering out (negative prompt). Balloons and text come from the Balloons tool.`, onChange: (e: Event) => { st.mangaLook = (e.target as HTMLInputElement).checked; save(); render(); } })),
          field("Finish", h("select", { title: "Finish", "data-help": "Applied when a result is added as a layer. Greyscale: grey values with a print contrast curve. Screentone: pure black and white with dots at the lpi below, locked to the page so tones line up across panels. Ink only: black and white, no tone.", onChange: (e: Event) => { st.finish = (e.target as HTMLSelectElement).value as MangaFinish; save(); render(); } },
            ...([["none", "As generated"], ["grey", "Greyscale"], ["tone", "Screentone (print)"], ["ink", "Ink only"]] as const).map(([v, l]) => h("option", { value: v, selected: st.finish === v }, l)))),
          st.finish === "tone" ? field("Tone lpi", slider(40, 100, 5, st.lpi, (v) => { st.lpi = v; save(); }), () => `${st.lpi} lpi`) : null);
      })(),
      h("div", { class: "sep" }), ...renderDesign(st.design, field, slider, () => { save(); render(); }),
      h("div", { class: "sep" }), h("h3", {}, "Scene recipes"),
      h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, "One click sets the action, camera and effect tags for a kind of panel. Cast, look and emotion tags you picked stay."),
      h("div", { class: "row", style: { flexWrap: "wrap", gap: "3px", marginBottom: "4px" } }, ...PANEL_RECIPES.map((r) => h("button", { class: "tag", title: r.name, "data-help": `${r.hint} Tags: ${r.tags.join(", ")}.`, onClick: () => {
        st.tags = [...new Set([...st.tags.filter((t) => KEEP_ON_RECIPE.has(t)), ...r.tags])];
        if (st.panelId < 0) { const area = 512 * 768; const w = Math.max(384, Math.floor(Math.sqrt(area * r.aspect) / 64) * 64); st.width = w; st.height = Math.max(384, Math.floor(area / w / 64) * 64); }
        save(); render();
      } }, r.name))),
      h("div", { class: "sep" }), h("h3", {}, "Tags"),
      h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, "Anime checkpoints answer tags better than sentences. Click to add or remove. Order sent: LoRA trigger, character design, your prompt, these tags, then style words last."),
      h("div", { class: "row", style: { gap: "6px", alignItems: "center", margin: "2px 0" } },
        h("button", { title: "Tags from drawing", "data-help": "Ask the sidecar's tagger (WD14) what it sees in the current drawing and add the confident tags to the prompt. Good for matching a repaint to what is already there.", disabled: !runner.provider.tag, onClick: async () => { try { const png = layersToPng(app.doc, app.doc.drawing.layers.filter((l) => l.kind === "raster"), 768, 768, true); const tags = await runner.provider.tag!(png); const add = tags.filter((t) => t.p >= 0.5).map((t) => t.tag); st.tags = [...new Set([...st.tags, ...add])]; save(); render(); } catch (e) { alert((e as Error).message); } } }, "Tags from drawing"),
        st.tags.length ? h("button", { title: "Clear tags", onClick: () => { st.tags = []; save(); render(); } }, "Clear") : null),
      h("div", { class: "row", style: { gap: "6px", margin: "2px 0 4px" } },
        h("input", { type: "search", placeholder: "Find a tag (e.g. kick, gun, rain)", value: tagFilter, style: { flex: "1" }, title: "Find a tag", onInput: (e: Event) => { tagFilter = (e.target as HTMLInputElement).value; render(); const el = root.querySelector("input[type=search]") as HTMLInputElement | null; if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } } }),
        h("input", { type: "text", placeholder: "Own tag + Enter", value: customTag, style: { width: "110px" }, title: "Add your own tag", "data-help": "Any tag or short phrase; press Enter to add it.", onInput: (e: Event) => { customTag = (e.target as HTMLInputElement).value; }, onKeydown: (e: KeyboardEvent) => { if (e.key !== "Enter") return; const t = customTag.trim(); if (t && !st.tags.includes(t)) { st.tags = [...st.tags, t]; save(); } customTag = ""; render(); } })),
      ...TAG_GROUPS.map((g) => {
        const q = tagFilter.trim().toLowerCase(); const list = q ? g.tags.filter((t) => t.includes(q)) : g.tags;
        if (!list.length) return null;
        const picked = g.tags.filter((t) => st.tags.includes(t)).length;
        const open = !!q || st.openGroups.includes(g.name);
        const det = h("details", { open, style: { marginBottom: "2px" } },
          h("summary", { title: g.hint, style: { cursor: "pointer", fontSize: "11.5px" } }, `${g.name}${picked ? ` · ${picked}` : ""}`),
          h("div", { class: "row", style: { flexWrap: "wrap", gap: "3px", margin: "3px 0 4px" } }, ...list.map((t) => h("button", { class: `tag ${st.tags.includes(t) ? "active" : ""}`, title: t, "data-help": `${g.hint} Adds "${t}" to the prompt.`, onClick: () => { st.tags = st.tags.includes(t) ? st.tags.filter((x) => x !== t) : [...st.tags, t]; save(); render(); } }, t))));
        det.addEventListener("toggle", () => { if (q) return; const on = (det as HTMLDetailsElement).open; st.openGroups = on ? [...new Set([...st.openGroups, g.name])] : st.openGroups.filter((x) => x !== g.name); save(); });
        return det;
      }),
      st.tags.length ? h("div", { class: "mono dim", style: { fontSize: "10.5px", margin: "2px 0 6px" } }, st.tags.join(", ")) : null,
      h("div", { class: "field stack" }, h("label", {}, "Prompt"), h("textarea", { rows: 3, style: { width: "100%", resize: "vertical" }, onInput: (e: Event) => { st.prompt = (e.target as HTMLTextAreaElement).value; save(); } }, st.prompt)),
      h("div", { class: "field stack" }, h("label", {}, "Negative"), h("textarea", { rows: 2, style: { width: "100%", resize: "vertical" }, onInput: (e: Event) => { st.negative = (e.target as HTMLTextAreaElement).value; save(); } }, st.negative)),
      tokenMeter(),
      h("p", { class: "mono dim", style: { fontSize: "10.5px", margin: "2px 0 6px", wordBreak: "break-word" } }, "Sent as: " + composePrompt().prompt),
      h("div", { class: "sep" }), h("h3", {}, "Model"),
      presets.length ? field("Preset", h("select", { title: "Model preset", "data-help": "Swap the checkpoint on the sidecar without restarting it: SDXL presets for quality, the SD 1.5 preset when memory or time is short.", onChange: async (e: Event) => {
        const v = (e.target as HTMLSelectElement).value; const sel = presets.find((p) => p.name === v);
        const warn = sel?.family === "sdxl" ? "\n\nSDXL needs roughly 8 GB of free system RAM and 15 GB of disk, and about a minute per image on a 6 GB card." : "";
        if (runner.provider.load && confirm(`Load ${v}?${warn}\n\nThe sidecar checks for room first and keeps the current model if there is not enough.`)) {
          try { await runner.provider.load(v); } catch (err) { alert((err as Error).message); }
        }
        void checkHealth();
      } }, ...presets.map((p) => h("option", { value: p.name, selected: p.name === currentModel }, `${p.name} (${p.family})`)))) : h("p", { class: "dim", style: { fontSize: "11px" } }, "Presets appear when the sidecar is online."),
      loraNames.length ? h("div", {}, h("span", { class: "dim", style: { fontSize: "11px" } }, "LoRA styles (ml/sidecar/loras/*.safetensors)"), ...loraNames.map((n) => { const cur = st.loras.find((l) => l.name === n); return h("div", { class: "row", style: { gap: "6px", alignItems: "center" } }, h("input", { type: "checkbox", checked: !!cur, title: `LoRA ${n}`, "data-help": "Apply this trained style adapter at the weight on the right.", onChange: (e: Event) => { st.loras = (e.target as HTMLInputElement).checked ? [...st.loras, { name: n, weight: 0.7 }] : st.loras.filter((l) => l.name !== n); save(); render(); } }), h("span", { style: { fontSize: "11.5px", flex: "1" } }, n, loraTriggers[n] ? h("span", { class: "dim" }, ` · trigger "${loraTriggers[n]}" added automatically`) : null), cur ? slider(0, 1.5, 0.05, cur.weight, (v) => { cur.weight = v; save(); }) : null); }),
        st.loras.some((l) => l.weight > 1.0) ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0", color: "#d9b65c" } }, "LoRA weight above 1.0 usually over-applies the style (burnt colours, repeated shapes). 0.5–0.8 is the usual range; compare the -s250/-s500 checkpoints at the same weight if the final one looks overcooked.") : null) : null,
      h("div", { class: "sep" }), h("h3", {}, "Sampler"),
      field("Fast preview", h("div", { class: "row", style: { gap: "6px", alignItems: "center" } }, h("input", { type: "checkbox", checked: st.fast, title: "Fast preview", "data-help": "LCM-LoRA: 8 steps at guidance 2, a few seconds per image. Lower quality by design (soft detail, muddy colours, your LoRA and the Steps/Guidance sliders are mostly ignored). Use it to find a composition and seed, then switch it off, or press Full quality on a result.", onChange: (e: Event) => { st.fast = (e.target as HTMLInputElement).checked; save(); render(); } }), st.fast ? h("span", { class: "chip warn" }, "preview quality: 8 steps, guidance 2") : null)),
      field("FreeU", h("input", { type: "checkbox", checked: st.freeu, title: "FreeU", "data-help": "Rebalances the UNet's backbone and skip features: cleaner shapes and contrast at no memory cost. Off when it over-sharpens.", onChange: (e: Event) => { st.freeu = (e.target as HTMLInputElement).checked; save(); } })),
      field("Scheduler", h("select", { title: "Scheduler", "data-help": "DPM++ 2M Karras: sharp and stable at 20–30 steps (default). Euler a: softer, more variation per seed. DDIM: reproducible, flatter.", onChange: (e: Event) => { st.scheduler = (e.target as HTMLSelectElement).value as GenRequest["scheduler"]; save(); } }, ...([["dpmpp_2m_karras", "DPM++ 2M Karras"], ["euler_a", "Euler a"], ["euler", "Euler"], ["ddim", "DDIM"]] as const).map(([v, l]) => h("option", { value: v, selected: st.scheduler === v }, l)))),
      field("CFG rescale", slider(0, 1, 0.05, st.cfgRescale, (v) => { st.cfgRescale = v; save(); }), () => st.cfgRescale.toFixed(2)),
      field("Hi-res fix", h("input", { type: "checkbox", checked: st.hiresFix, title: "Hi-res fix", "data-help": "Second pass at 1.5× size with low strength: sharper hair, eyes and line edges without changing the composition. Roughly doubles the time; capped by the memory profile.", onChange: (e: Event) => { st.hiresFix = (e.target as HTMLInputElement).checked; save(); render(); } })),
      st.hiresFix ? field("Hi-res strength", slider(0.1, 0.7, 0.05, st.hiresStrength, (v) => { st.hiresStrength = v; save(); }), () => st.hiresStrength.toFixed(2)) : null,
      st.mode === "reference" ? field("Reference weight", slider(0, 1.2, 0.05, st.referenceScale, (v) => { st.referenceScale = v; save(); }), () => st.referenceScale.toFixed(2)) : null,
      st.panelId >= 0 ? null : field("Size", h("select", { onChange: (e: Event) => { const [w, hh] = (e.target as HTMLSelectElement).value.split("x").map(Number) as [number, number]; st.width = w; st.height = hh; save(); } }, ...["512x768", "768x512", "640x640", "832x1216", "1024x1024", "1216x832"].map((v) => h("option", { value: v, selected: v === `${st.width}x${st.height}` }, v)))),
      health?.maxPx && st.width * st.height > health.maxPx ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, `The ${health.profile ?? ""} profile caps at ${health.maxPx.toLocaleString()} px; this request is scaled down to fit.`) : null,
      field("Quality tags", h("input", { type: "checkbox", checked: st.qualityTags, title: "Quality tags", "data-help": "Prepend the model's recommended quality tags and its standard negative list (from the sidecar preset). Keep on unless you are writing the full prompt yourself.", onChange: (e: Event) => { st.qualityTags = (e.target as HTMLInputElement).checked; save(); } })),
      field("Steps", slider(8, 60, 1, st.steps, (v) => { st.steps = v; save(); }), () => String(st.steps)),
      field("Guidance", slider(1, 15, 0.5, st.guidance, (v) => { st.guidance = v; save(); render(); }), () => st.guidance.toFixed(1)),
      st.guidance > 9 && !st.fast ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0", color: "#d9b65c" } }, `Guidance ${st.guidance.toFixed(1)} is high: colours burn, contrast clips and anatomy stiffens. 5–8 is the usual range for these models${st.cfgRescale < 0.5 ? "; if you keep it this high, set CFG rescale to about 0.7" : ""}.`, h("button", { style: { marginLeft: "6px" }, title: "Use 7", onClick: () => { st.guidance = 7; save(); render(); } }, "Use 7")) : null,
      field("Seed", h("div", { class: "row", style: { gap: "4px" } }, h("input", { type: "number", value: st.seed, style: { width: "90px" }, onChange: (e: Event) => { st.seed = Number((e.target as HTMLInputElement).value) | 0; st.seedMode = "fixed"; save(); render(); } }), h("button", { title: "Random seed", onClick: () => { st.seed = newSeed(); save(); render(); } }, "🎲"))),
      field("Each run", h("select", { title: "Seed mode", "data-help": "New seed: every Generate is a different picture (default). Keep seed: the same seed every time, for changing one setting and comparing; typing a seed switches to this.", onChange: (e: Event) => { st.seedMode = (e.target as HTMLSelectElement).value as "new" | "fixed"; save(); } }, h("option", { value: "new", selected: st.seedMode === "new" }, "New seed"), h("option", { value: "fixed", selected: st.seedMode === "fixed" }, "Keep seed"))),
      field("Kept-image taste", h("input", { type: "checkbox", checked: st.steerKept, title: "Steer with kept images", "data-help": "Each job also looks at two random images from your kept set (IP-Adapter, low weight), a different pair every time, so results lean toward your taste without repeating it. Needs the sidecar started with IP-Adapter.", onChange: (e: Event) => { st.steerKept = (e.target as HTMLInputElement).checked; save(); render(); } })),
      st.steerKept ? field("Taste weight", slider(0.1, 0.7, 0.05, st.steerWeight, (v) => { st.steerWeight = v; save(); }), () => st.steerWeight.toFixed(2)) : null,
      field("No repeats", h("input", { type: "checkbox", checked: st.dedupe, title: "No repeats", "data-help": "A result that looks the same as an earlier one (perceptual hash within 6 of 64 bits) is dropped and the job runs again once with a fresh seed.", onChange: (e: Event) => { st.dedupe = (e.target as HTMLInputElement).checked; save(); } })),
      st.mode === "repaint" || st.mode === "inpaint" ? field("Strength", slider(0.1, 1, 0.05, st.strength, (v) => { st.strength = v; save(); }), () => st.strength.toFixed(2)) : null,
      st.mode === "lines" ? field("Line weight", slider(0.2, 1.5, 0.05, st.controlWeight, (v) => { st.controlWeight = v; save(); }), () => st.controlWeight.toFixed(2)) : null,
      h("div", { class: "row", style: { gap: "6px", margin: "8px 0" } }, h("button", { class: "primary", disabled: !!health && !health.ok, title: "Generate", "data-help": "Send the job to the provider. Progress shows below; the result arrives as a new layer when you add it.", onClick: () => void generate() }, "Generate"), app.doc.mode === "anime" && app.doc.frames.length > 1 ? h("button", { title: "Render all frames", "data-help": "Run this job once per drawing on the timeline with the same seed, using each frame's own lines; results land on a Gen layer inside each frame.", onClick: () => void renderAllFrames() }, "All frames") : null,
        h("button", { title: "Generate 4 seeds", "data-help": "Four jobs with four different seeds (four new random ones, or seed to seed+3 with Keep seed).", onClick: async () => { const s0 = st.seed; const keep = st.seedMode; for (let i = 0; i < 4; i++) { if (keep === "fixed") st.seed = s0 + i; await generate(); } if (keep === "fixed") st.seed = s0; save(); render(); } }, "×4 seeds")),
      steerNote || replaced ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, [steerNote, replaced ? `${replaced} repeat${replaced > 1 ? "s" : ""} replaced with a new seed` : ""].filter(Boolean).join(" · ")) : null,
      stats ? h("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap", fontSize: "11px", marginTop: "6px" } },
        h("span", { class: "dim" }, `Training set: ${stats.liked} kept, ${stats.rejected} discarded`),
        h("span", { class: `chip ${stats.readyToTrain ? "ok" : ""}` }, stats.readyToTrain ? "enough to train" : `${Math.max(0, 20 - stats.liked)} more to train`),
        h("button", { title: "How to train", "data-help": "Runs on your machine from ml/sidecar; writes a .safetensors into loras/ which then appears in the LoRA list above.", onClick: () => alert(`Kept images live in:\n${stats!.path}\n\nTrain a personal style:\n  cd ml\\sidecar\n  .venv\\Scripts\\python train_lora.py --name my-style\n\nIt picks a step count from the set size (about 12 passes) and also writes my-style-s250, -s500... checkpoints. Then tick "my-style" under LoRA styles at weight 0.6-0.8; its trigger word is added to prompts for you. If the final one looks overcooked, try an earlier checkpoint.`) }, "How to train")) : null,
      h("div", { class: "sep" }), h("h3", {}, "Results"),
      ...runner.jobs.map((j) => h("div", { class: "gen-job" },
        j.result ? h("img", { src: j.result.image, title: "Result", style: { width: "100%", display: "block", border: "1px solid #444", borderRadius: "3px" } }) : h("div", { class: "gen-progress" }, h("div", { style: { width: `${j.progress ? Math.round((100 * j.progress.step) / j.progress.total) : 2}%` } })),
        h("div", { class: "row", style: { gap: "4px", alignItems: "center", fontSize: "11px", marginTop: "4px", flexWrap: "wrap" } },
          h("span", { class: "mono dim" }, `${j.status}${j.progress && !j.result ? ` ${j.progress.step}/${j.progress.total}` : ""} · seed ${j.req.seed} · ${j.req.mode}${j.result ? ` · ${(j.result.ms / 1000).toFixed(1)} s · ${j.result.model}${j.result.vramPeakGB ? ` · peak ${j.result.vramPeakGB} GB` : ""}${j.result.promptTokens ? ` · ${j.result.promptTokens} tokens` : ""}` : ""}`),
          j.result?.fast ? h("span", { class: "chip warn", title: "Made with Fast preview (LCM, 8 steps)" }, "preview") : null,
          j.result?.fast ? h("button", { title: "Full quality", "data-help": "Run this same seed and settings again with Fast preview off: full steps, your guidance and LoRA weights.", onClick: () => { void runner.run({ ...j.req, fast: false, steps: Math.max(j.req.steps, 28), retry: 1 } as GenRequest); } }, "Full quality") : null,
          h("span", { class: "grow" }),
          j.result ? h("button", { title: "Add as layer", "data-help": "Put this result on a new layer above the active one; the layer remembers prompt, seed and settings.", onClick: () => void addAsLayer(j.result!.image, `Gen ${j.req.seed}`, j.req, j.result!.seed, j.result!.model) }, "Add as layer") : null,
          j.result && runner.provider.upscale ? h("button", { title: "Upscale 2×", "data-help": "Real-ESRGAN anime upscale to print resolution, then add as a layer.", onClick: async () => { try { const r = await runner.provider.upscale!(j.result!.image, 2); await addAsLayer(r.image, `Gen ${j.req.seed} ×2`, j.req, j.result!.seed, j.result!.model); } catch (e) { alert((e as Error).message); } } }, "Upscale 2×") : null,
          j.result ? h("button", { title: "Use as reference", onClick: () => { reference = j.result!.image; st.mode = "reference"; save(); render(); } }, "Reference") : null,
          j.result && runner.provider.rate ? h("button", { title: "Keep", "data-help": "Save this image and its prompt into the training set on your machine. With 20 or more, train_lora.py turns them into a personal style.", onClick: () => void rate("liked", j) }, "✓ Keep") : null,
          j.result && runner.provider.rate ? h("button", { title: "Discard", "data-help": "File this as a bad result. Kept as the negative half for preference tuning; it is not used by the style trainer.", onClick: () => void rate("rejected", j) }, "✗ Discard") : null,
          j.result ? h("button", { title: "Redraw with OMNI-CELL tools", "data-help": "Rebuild this result on new layers with the app's own tools (Trace Pen ink, flats, shadows, light, screentone) in the Redraw tab.", onClick: () => setRedrawSource(app, { image: j.result!.image, region: (j.req.region as (Region & { panelId?: number }) | undefined) ?? null, name: `seed ${j.result!.seed}` }) }, "Redraw") : null,
          j.result ? h("button", { title: "Seed +1", "data-help": "Run the same job with the next seed: a close variation of this result.", onClick: () => { void runner.run({ ...j.req, seed: j.req.seed + 1, retry: 1 } as GenRequest); } }, "Seed +1") : null,
          j.status === "running" || j.status === "queued" ? h("button", { title: "Cancel", onClick: () => void runner.cancel(j) }, "Cancel") : null,
          j.error ? h("span", { class: "dim" }, j.error) : null))),
      runner.jobs.length ? null : h("p", { class: "dim", style: { fontSize: "11px" } }, "No jobs yet."));
  };
  render(); void checkHealth();
  // the panel list follows the page: drawing, cutting or deleting panels, or a new document
  app.on("panels", () => { if (st.panelId >= 0 && !app.doc.panels.some((p) => p.id === st.panelId)) { st.panelId = -1; save(); } if (root.isConnected) render(); });
  app.on("doc-reset", () => { st.panelId = -1; save(); render(); });
  app.on("layers", () => { if (st.mode === "lines") render(); }); app.on("selection", () => { if (st.mode === "inpaint") render(); });
  return root;
}
