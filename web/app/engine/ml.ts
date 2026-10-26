/**
 * ML Studio: provider-agnostic image generation that talks to the drawing core through images.
 *
 * A Provider submits a job and is polled for progress; results arrive as PNG data URLs and are
 * imported as layers. Two providers ship: the local sidecar (ml/sidecar, HTTP on 127.0.0.1) which
 * keeps every pixel on the device, and a Mock that renders a deterministic placeholder so the UI,
 * the job runner and the import path are testable without a GPU. Hosted providers (Phase 3 of
 * docs/ML-GENERATION.md) implement the same interface and are flagged `leavesDevice`.
 */
import { finishPixels, type FinishOptions } from "./manga-finish.js";
import { TILE, type Doc, type Layer } from "./document.js";

export type GenMode = "text" | "lines" | "repaint" | "reference" | "inpaint";
export interface GenRequest {
  mode: GenMode;
  prompt: string;
  negative: string;
  width: number; height: number;
  steps: number; guidance: number; seed: number;
  /** img2img: how much the result may depart from the input (0 keeps it, 1 ignores it) */
  strength: number;
  /** ControlNet weight for "lines" */
  controlWeight: number;
  /** PNG data URLs prepared by the app */
  control?: string; init?: string; reference?: string;
  /** up to 4 reference images (IP-Adapter): character sheet, colour key, style sample; embeddings are averaged */
  references?: string[];
  /** app-side only: the panel box this was generated for (the sidecar ignores it); used to place the result */
  region?: { x0: number; y0: number; x1: number; y1: number; panelId?: number };
  /** prepend the model preset's recommended quality tags and negative list (sidecar presets) */
  qualityTags: boolean;
  scheduler: "dpmpp_2m_karras" | "euler_a" | "euler" | "ddim";
  cfgRescale: number;
  hiresFix: boolean; hiresStrength: number;
  controlPreprocess: "none" | "lineart_anime" | "scribble";
  /** inpaint: white = regenerate */
  mask?: string;
  referenceScale: number;
  loras: Array<{ name: string; weight: number }>;
  /** extra ControlNets, e.g. the 3D layer's depth map */
  controls: Array<{ type: "depth"; image: string; weight: number }>;
  freeu: boolean;
  /** LCM-LoRA preview: a few steps, low guidance */
  fast: boolean;
}
export type GenModeAll = GenMode | "inpaint";
export interface GenProgress { step: number; total: number; preview?: string }
export interface GenResult { image: string; seed: number; model: string; ms: number; profile?: string; vramPeakGB?: number | null; fast?: boolean; promptTokens?: number; negativeTokens?: number; chunks?: number }
export interface DatasetStats { path: string; liked: number; rejected: number; readyToTrain: boolean; /** kept images per action folder */ actions?: Record<string, number>; /** actions with fewer than 8 images */ thin?: string[]; /** flat images not yet sorted into action folders */ unsorted?: number }
export interface ProviderHealth { ok: boolean; model?: string; family?: string; device?: string; vramGB?: number; freeVramGB?: number; controlnets?: string[]; profile?: string; maxPx?: number; presets?: string[]; ipAdapter?: boolean; upscaler?: boolean; message?: string }
export interface Provider {
  readonly id: string; readonly name: string; readonly leavesDevice: boolean;
  health(): Promise<ProviderHealth>;
  submit(req: GenRequest): Promise<string>;
  poll(jobId: string): Promise<{ status: "queued" | "running" | "done" | "error" | "cancelled"; progress?: GenProgress; result?: GenResult; error?: string }>;
  cancel(jobId: string): Promise<void>;
  /** optional: model presets and LoRAs the provider can use */
  models?(): Promise<{ presets: Array<{ name: string; family: string }>; current: string }>;
  load?(model: string): Promise<void>;
  loras?(): Promise<string[]>;
  /** trigger words written by train_lora.py next to each LoRA (name -> word) */
  loraTriggers?(): Promise<Record<string, string>>;
  /** CLIP token counts for a prompt, with the quality prefix the sidecar adds */
  tokens?(prompt: string, negative: string, qualityTags: boolean): Promise<{ prompt: number; negative: number; chunk: number }>;
  tag?(image: string): Promise<Array<{ tag: string; p: number }>>;
  upscale?(image: string, scale: number): Promise<{ image: string; width: number; height: number }>;
  rate?(image: string, verdict: "liked" | "rejected", caption: string, meta: unknown): Promise<DatasetStats>;
  datasetStats?(): Promise<DatasetStats>;
  /** sort flat kept images into action folders by caption */
  organizeDataset?(): Promise<DatasetStats>;
  /** a few random kept images (small data URLs), different each call */
  sampleKept?(n: number): Promise<{ images: string[]; pool: number }>;
}

// ---------------------------------------------------------------- local sidecar
export class SidecarProvider implements Provider {
  readonly id = "sidecar"; readonly name = "Local sidecar (your GPU)"; readonly leavesDevice = false;
  constructor(public base = "http://127.0.0.1:8790") {}
  private async json<T>(path: string, init?: RequestInit): Promise<T> { const r = await fetch(this.base + path, { ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } }); if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`); return (await r.json()) as T; }
  async health(): Promise<ProviderHealth> { try { return { ok: true, ...(await this.json<Omit<ProviderHealth, "ok">>("/health")) }; } catch (e) { return { ok: false, message: `sidecar not reachable at ${this.base}: ${(e as Error).message}` }; } }
  submit(req: GenRequest): Promise<string> { return this.json<{ id: string }>("/generate", { method: "POST", body: JSON.stringify(req) }).then((r) => r.id); }
  poll(jobId: string) { return this.json<Awaited<ReturnType<Provider["poll"]>>>(`/jobs/${jobId}`); }
  async cancel(jobId: string): Promise<void> { await this.json(`/jobs/${jobId}/cancel`, { method: "POST" }); }
  models() { return this.json<{ presets: Array<{ name: string; family: string }>; current: string }>("/models"); }
  async load(model: string): Promise<void> { await this.json("/load", { method: "POST", body: JSON.stringify({ model }) }); }
  loras() { return this.json<{ loras: string[] }>("/loras").then((r) => r.loras); }
  loraTriggers() { return this.json<{ triggers?: Record<string, string> }>("/loras").then((r) => r.triggers ?? {}); }
  tokens(prompt: string, negative: string, qualityTags: boolean) { return this.json<{ prompt: number; negative: number; chunk: number }>("/tokens", { method: "POST", body: JSON.stringify({ prompt, negative, qualityTags }) }); }
  tag(image: string) { return this.json<{ tags: Array<{ tag: string; p: number }> }>("/tag", { method: "POST", body: JSON.stringify({ image }) }).then((r) => r.tags); }
  upscale(image: string, scale: number) { return this.json<{ image: string; width: number; height: number }>("/upscale", { method: "POST", body: JSON.stringify({ image, scale }) }); }
  rate(image: string, verdict: "liked" | "rejected", caption: string, meta: unknown) { return this.json<DatasetStats>("/dataset/add", { method: "POST", body: JSON.stringify({ image, verdict, caption, meta }) }); }
  datasetStats() { return this.json<DatasetStats>("/dataset/stats"); }
  organizeDataset() { return this.json<DatasetStats>("/dataset/organize", { method: "POST", body: "{}" }); }
  sampleKept(n: number) { return this.json<{ images: string[]; pool: number }>(`/dataset/sample?n=${n}`); }
}

// ---------------------------------------------------------------- mock (no GPU)
/** Deterministic placeholder: a soft-shaded figure-like blob tinted from the prompt hash, drawn over the control lines if any. */
export class MockProvider implements Provider {
  readonly id = "mock"; readonly name = "Mock (placeholder, no model)"; readonly leavesDevice = false;
  private jobs = new Map<string, { req: GenRequest; started: number; cancelled: boolean }>();
  async health(): Promise<ProviderHealth> { return { ok: true, model: "mock-placeholder", device: "cpu", controlnets: ["lineart"] }; }
  async submit(req: GenRequest): Promise<string> { const id = `mock-${Date.now().toString(36)}`; this.jobs.set(id, { req, started: performance.now(), cancelled: false }); return id; }
  async poll(jobId: string) {
    const j = this.jobs.get(jobId); if (!j) return { status: "error" as const, error: "unknown job" };
    if (j.cancelled) return { status: "cancelled" as const };
    const total = j.req.steps, step = Math.min(total, Math.floor((performance.now() - j.started) / 40));
    if (step < total) return { status: "running" as const, progress: { step, total } };
    const image = await renderMock(j.req); return { status: "done" as const, result: { image, seed: j.req.seed, model: "mock-placeholder", ms: Math.round(performance.now() - j.started) } };
  }
  async cancel(jobId: string): Promise<void> { const j = this.jobs.get(jobId); if (j) j.cancelled = true; }
}
async function renderMock(req: GenRequest): Promise<string> {
  const c = document.createElement("canvas"); c.width = req.width; c.height = req.height; const g = c.getContext("2d")!;
  let hsh = 0; for (const ch of req.prompt + req.seed) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0; const hue = ((hsh >>> 0) % 360);
  const bg = g.createLinearGradient(0, 0, 0, c.height); bg.addColorStop(0, `hsl(${hue},35%,88%)`); bg.addColorStop(1, `hsl(${(hue + 40) % 360},30%,70%)`); g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  const cx = c.width / 2, cy = c.height * 0.42, R = Math.min(c.width, c.height) * 0.2;
  const sh = g.createRadialGradient(cx - R * 0.3, cy - R * 0.3, R * 0.2, cx, cy, R * 1.1); sh.addColorStop(0, "#f6e2d2"); sh.addColorStop(1, "#c99a84"); g.fillStyle = sh; g.beginPath(); g.ellipse(cx, cy, R * 0.9, R * 1.05, 0, 0, Math.PI * 2); g.fill();
  g.fillStyle = `hsl(${(hue + 180) % 360},25%,28%)`; g.beginPath(); g.ellipse(cx, cy - R * 0.55, R * 1.05, R * 0.75, 0, Math.PI, Math.PI * 2); g.fill();
  g.fillStyle = "#2b2b2b"; g.beginPath(); g.ellipse(cx, c.height * 0.95, R * 2.2, R * 1.4, 0, Math.PI, Math.PI * 2); g.fill();
  const src = req.control ?? req.init; if (src) { const img = new Image(); await new Promise<void>((res) => { img.onload = () => res(); img.src = src; }); g.globalAlpha = req.mode === "lines" ? 0.9 : 0.35; g.drawImage(img, 0, 0, c.width, c.height); g.globalAlpha = 1; }
  g.fillStyle = "rgba(0,0,0,0.45)"; g.font = `${Math.round(c.width / 28)}px sans-serif`; g.fillText("MOCK: no model loaded", 16, c.height - 20);
  return c.toDataURL("image/png");
}

// ---------------------------------------------------------------- job runner
export interface JobRecord { id: string; provider: string; req: GenRequest; status: string; progress: GenProgress | null; result: GenResult | null; error: string | null; startedAt: number }
export class JobRunner {
  readonly jobs: JobRecord[] = [];
  onChange: (() => void) | null = null;
  private timers = new Map<string, number>();
  constructor(public provider: Provider) {}
  async run(req: GenRequest): Promise<JobRecord> {
    const id = await this.provider.submit(req);
    const rec: JobRecord = { id, provider: this.provider.id, req, status: "queued", progress: null, result: null, error: null, startedAt: Date.now() };
    this.jobs.unshift(rec); if (this.jobs.length > 24) this.jobs.pop(); this.onChange?.();
    const tick = async () => {
      try {
        const p = await this.provider.poll(id); rec.status = p.status; rec.progress = p.progress ?? rec.progress;
        if (p.status === "done") { rec.result = p.result ?? null; this.timers.delete(id); }
        else if (p.status === "error" || p.status === "cancelled") { rec.error = p.error ?? p.status; this.timers.delete(id); }
        else this.timers.set(id, window.setTimeout(tick, 250));
      } catch (e) { rec.status = "error"; rec.error = (e as Error).message; this.timers.delete(id); }
      this.onChange?.();
    };
    void tick();
    return rec;
  }
  async cancel(rec: JobRecord): Promise<void> { const t = this.timers.get(rec.id); if (t) window.clearTimeout(t); this.timers.delete(rec.id); await this.provider.cancel(rec.id); rec.status = "cancelled"; this.onChange?.(); }
}

// ---------------------------------------------------------------- images in and out
/** Flatten the given layers (ink on white, or everything) to a PNG of the requested size, page-fitted and letterboxed white. */
/** A part of the page (a manga panel's bounding box), in document pixels. */
export interface Region { x0: number; y0: number; x1: number; y1: number }
/**
 * Page -> image mapping for a w x h generation: the whole page is letterboxed into the image (contain);
 * a region covers the image (its aspect was chosen to match, so at most a sliver is cropped).
 * image = page * s + (ox, oy). pngToLayer inverts exactly the same mapping.
 */
export function regionMap(doc: Doc, w: number, h: number, region?: Region | null): { s: number; ox: number; oy: number } {
  if (!region) { const s = Math.min(w / doc.width, h / doc.height); return { s, ox: (w - doc.width * s) / 2, oy: (h - doc.height * s) / 2 }; }
  const rw = region.x1 - region.x0, rh = region.y1 - region.y0; const s = Math.max(w / rw, h / rh);
  return { s, ox: w / 2 - (region.x0 + rw / 2) * s, oy: h / 2 - (region.y0 + rh / 2) * s };
}
export function layersToPng(doc: Doc, layers: Layer[], w: number, h: number, onWhite = true, region?: Region | null): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!;
  if (onWhite) { g.fillStyle = "#fff"; g.fillRect(0, 0, w, h); }
  const { s, ox, oy } = regionMap(doc, w, h, region);
  g.save(); g.translate(ox, oy); g.scale(s, s);
  for (const l of layers) { if (!l.visible) continue; g.globalAlpha = l.opacity; for (const t of l.tiles.values()) if (t.canvas) g.drawImage(t.canvas as CanvasImageSource, t.x * TILE, t.y * TILE); }
  g.restore(); return c.toDataURL("image/png");
}
/** Selection mask as a page-fitted PNG (white = selected) for inpainting. */
export function selectionToMaskPng(doc: Doc, sel: { canvas: HTMLCanvasElement }, w: number, h: number, region?: Region | null): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!;
  g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
  const { s, ox, oy } = regionMap(doc, w, h, region);
  const t = document.createElement("canvas"); t.width = sel.canvas.width; t.height = sel.canvas.height; const tg = t.getContext("2d")!;
  tg.drawImage(sel.canvas, 0, 0); tg.globalCompositeOperation = "source-in"; tg.fillStyle = "#fff"; tg.fillRect(0, 0, t.width, t.height);
  g.save(); g.translate(ox, oy); g.scale(s, s); g.drawImage(t, 0, 0); g.restore();
  return c.toDataURL("image/png");
}
/** Any canvas (e.g. the 3D depth map) page-fitted into a PNG of the requested size, black letterbox. */
export function canvasToPng(src: HTMLCanvasElement, doc: Doc, w: number, h: number, region?: Region | null): string {
  const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!; g.fillStyle = "#000"; g.fillRect(0, 0, w, h);
  const { s, ox, oy } = regionMap(doc, w, h, region);
  g.drawImage(src, ox, oy, doc.width * s, doc.height * s); return c.toDataURL("image/png");
}
/** Put a result PNG onto a new raster layer, scaled to the page (the generation was page-fitted, so the inverse mapping is exact). */
export async function pngToLayer(doc: Doc, png: string, name: string, intoFrame?: { layers: Layer[] }, region?: Region | null, finish?: FinishOptions | null): Promise<Layer> {
  const img = new Image(); await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("bad image")); img.src = png; });
  const { s, ox, oy } = regionMap(doc, img.width, img.height, region);
  const l = doc.addLayer("raster"); l.name = name;
  if (intoFrame && intoFrame.layers !== doc.drawing.layers) { doc.drawing.layers.splice(doc.drawing.layers.indexOf(l), 1); intoFrame.layers.push(l); }
  const r = region ?? { x0: 0, y0: 0, x1: doc.width, y1: doc.height };
  for (let ty = Math.max(0, Math.floor(r.y0 / TILE)); ty * TILE < Math.min(doc.height, r.y1); ty++) for (let tx = Math.max(0, Math.floor(r.x0 / TILE)); tx * TILE < Math.min(doc.width, r.x1); tx++) {
    const t = l.getTile(tx, ty, true)!; if (!t.ctx) continue; const g = t.ctx as CanvasRenderingContext2D;
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    if (region) { g.save(); g.beginPath(); g.rect(r.x0 - tx * TILE, r.y0 - ty * TILE, r.x1 - r.x0, r.y1 - r.y0); g.clip(); }
    g.drawImage(img, ox + tx * TILE * s, oy + ty * TILE * s, TILE * s, TILE * s, 0, 0, TILE, TILE);
    if (region) g.restore();
    if (finish && finish.mode !== "none") {
      const d = g.getImageData(0, 0, TILE, TILE); finishPixels(d.data, TILE, TILE, tx * TILE, ty * TILE, finish); g.putImageData(d, 0, 0);
    }
    t.generation++;
  }
  l.generation++; return l;
}


/**
 * 64-bit difference hash of an image (9x8 greyscale, compare horizontal neighbours). Two results whose
 * hashes differ in only a few bits look the same at a glance, whatever their seeds.
 */
export async function imageHash(src: string): Promise<bigint> {
  const img = new Image(); await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error("bad image")); img.src = src; });
  const c = document.createElement("canvas"); c.width = 9; c.height = 8; const g = c.getContext("2d", { willReadFrequently: true })!;
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high"; g.drawImage(img, 0, 0, 9, 8);
  const d = g.getImageData(0, 0, 9, 8).data; let h = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = (y * 9 + x) * 4, j = i + 4;
    const a = d[i]! * 0.299 + d[i + 1]! * 0.587 + d[i + 2]! * 0.114, b = d[j]! * 0.299 + d[j + 1]! * 0.587 + d[j + 2]! * 0.114;
    h = (h << 1n) | (a > b ? 1n : 0n);
  }
  return h;
}
export function hashDistance(a: bigint, b: bigint): number { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; }
