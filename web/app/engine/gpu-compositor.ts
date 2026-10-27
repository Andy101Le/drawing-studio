/**
 * WebGPU compositor (Phase 1.1 / 1.5). Feature-detected; the Canvas 2D
 * renderer stays as fallback and for export / readback.
 *
 * Per frame:
 *   acc ← paper
 *   for each layer (bottom → top):
 *     layerTex ← clear; draw every visible tile quad (normal blend, premultiplied)
 *                plus the in-progress stroke buffer (flow buffer with stroke opacity / erase)
 *     acc' ← blend(acc, layerTex, mode, opacity, panelMask)        full-screen pass, ping-pong
 *   onion ghosts (tinted layer pass) before the current drawing's layers
 *   swap chain ← acc with optional CMYK soft proof applied in the shader
 *
 * Tone layers: the tile alpha is the mask and the dot screen is computed
 * analytically in the fragment shader at screen resolution (no resampling,
 * no moiré). NPR layers are uploaded as one texture. Panel masks are
 * rasterized once per panel on the CPU at 1/4 document resolution.
 *
 * Dirty rects become a scissor on every pass. Tile textures are uploaded only
 * when the tile's generation changed; an LRU keeps GPU memory bounded.
 */

import { TILE, type Doc, type Layer, type Panel, type Tile , effectiveLayer, clipBase } from "./document.js";
import type { ActiveStroke, RenderOptions, View } from "./renderer.js";
import { drawPathTo } from "./vector.js";
import { layerAt, keyMatrix } from "./tween.js";

const BLEND_INDEX: Record<string, number> = { normal: 0, multiply: 1, screen: 2, overlay: 3, darken: 4, lighten: 5, add: 6 };

const SHADER_TILE = /* wgsl */ `
struct Uniforms {
  view: mat3x3<f32>,      // doc → clip
  color: vec4<f32>,       // tint (onion) or unused
  params: vec4<f32>,      // x: opacity, y: mode(0 normal,1 erase-preview,2 tint), z: unused, w: unused
  tone: vec4<f32>,        // x: pitch px, y: density, z: angle rad, w: shape (0 dot,1 line,2 cross) ; pitch<=0 → not a tone layer
  screen: vec4<f32>,      // x: width px, y: height px, z: zoom, w: dpr
};
@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex: texture_2d<f32>;

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) scr: vec2<f32>, @location(2) doc: vec2<f32> };

@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4<f32>) -> VSOut {
  // rect = (x0, y0, x1, y1) in document units; 6 vertices per quad
  var corners = array<vec2<f32>, 6>(vec2f(0.0,0.0), vec2f(1.0,0.0), vec2f(0.0,1.0), vec2f(0.0,1.0), vec2f(1.0,0.0), vec2f(1.0,1.0));
  let c = corners[vi % 6u];
  let doc = vec2f(rect.x + (rect.z - rect.x) * c.x, rect.y + (rect.w - rect.y) * c.y);
  let clip = u.view * vec3f(doc, 1.0);
  var o: VSOut;
  o.pos = vec4f(clip.xy, 0.0, 1.0);
  o.uv = c;
  o.scr = vec2f((clip.x * 0.5 + 0.5) * u.screen.x, (0.5 - clip.y * 0.5) * u.screen.y);
  o.doc = doc;
  return o;
}
fn toneHash(p: vec2<f32>) -> f32 {
  var h = u32(p.x) * 374761393u + u32(p.y) * 668265263u;
  h = (h ^ (h >> 13u)) * 1274126177u;
  return f32(h ^ (h >> 16u)) / 4294967296.0;
}

fn toneCoverage(scr: vec2<f32>, doc: vec2<f32>) -> f32 {
  let pitch = u.tone.x; var density = u.tone.y; let ca = cos(u.tone.z); let sa = sin(u.tone.z);
  // gradient: color holds (x0, y0, x1, y1) in DU and params.z the end density when params.w > 0.5
  if (u.params.w > 0.5) {
    let g = u.color; let d = g.zw - g.xy; let l2 = max(1.0, dot(d, d));
    let t = clamp(dot(doc - g.xy, d) / l2, 0.0, 1.0);
    density = mix(u.tone.y, u.params.z, t);
  }
  if (u.tone.w > 2.5 && u.tone.w < 3.5) { return select(0.0, 1.0, toneHash(floor(scr)) < density); }          // noise
  if (u.tone.w > 3.5) { return select(0.0, 1.0, toneHash(floor(scr * 0.5)) < density); }                       // sand (2 px grains)
  var cov = 0.0;
  // 4x4 supersampling of the analytic screen
  for (var sy = 0; sy < 4; sy++) { for (var sx = 0; sx < 4; sx++) {
    let p = scr + vec2f((f32(sx) + 0.5) / 4.0 - 0.5, (f32(sy) + 0.5) / 4.0 - 0.5);
    let uu = p.x * ca + p.y * sa; let vv = -p.x * sa + p.y * ca;
    let fu = fract(uu / pitch) - 0.5; let fv = fract(vv / pitch) - 0.5;
    var inside = false;
    if (u.tone.w < 0.5) { let r2 = density * pitch * pitch / 3.14159265; inside = (fu*fu + fv*fv) * pitch * pitch <= r2; }
    else if (u.tone.w < 1.5) { inside = abs(fv) * pitch <= density * pitch * 0.5; }
    else { inside = abs(fv) * pitch <= density * pitch * 0.25 || abs(fu) * pitch <= density * pitch * 0.25; }
    if (inside) { cov += 1.0; }
  } }
  return cov / 16.0;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  var c = textureSample(tex, samp, in.uv); // premultiplied
  if (u.tone.x > 0.0) { c = vec4f(0.08, 0.08, 0.08, 1.0) * c.a * toneCoverage(in.scr, in.doc); }
  if (u.params.y > 1.5) { c = u.color * c.a; }                 // onion tint
  return c * u.params.x;
}
`;

const SHADER_BLEND = /* wgsl */ `
struct BlendU { params: vec4<f32>, /* x: mode, y: opacity, z: hasMask, w: proof */ docRect: vec4<f32>, /* mask doc→uv mapping: x0 y0 w h */ page: vec4<f32>, /* page width, height, 0, 0 */ };
@group(0) @binding(0) var<uniform> b: BlendU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var accTex: texture_2d<f32>;
@group(0) @binding(3) var layerTex: texture_2d<f32>;
@group(0) @binding(4) var maskTex: texture_2d<f32>;
@group(0) @binding(5) var<uniform> inv: mat3x3<f32>; // clip → doc, for the panel mask lookup
@group(0) @binding(6) var clipTex: texture_2d<f32>; // screen-space alpha of the clipping base layer (params.w > 0.5)

struct VSOut { @builtin(position) pos: vec4<f32>, @location(0) uv: vec2<f32>, @location(1) clip: vec2<f32> };
@vertex fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var q = array<vec2<f32>, 6>(vec2f(-1.0,-1.0), vec2f(1.0,-1.0), vec2f(-1.0,1.0), vec2f(-1.0,1.0), vec2f(1.0,-1.0), vec2f(1.0,1.0));
  var o: VSOut; o.pos = vec4f(q[vi], 0.0, 1.0); o.uv = vec2f(q[vi].x * 0.5 + 0.5, 0.5 - q[vi].y * 0.5); o.clip = q[vi]; return o;
}
fn unpremul(c: vec4<f32>) -> vec3<f32> { if (c.a <= 0.0) { return vec3f(0.0); } return c.rgb / c.a; }
fn blendRgb(mode: f32, d: vec3<f32>, s: vec3<f32>) -> vec3<f32> {
  if (mode < 0.5) { return s; }
  if (mode < 1.5) { return d * s; }
  if (mode < 2.5) { return 1.0 - (1.0 - d) * (1.0 - s); }
  if (mode < 3.5) { return select(1.0 - 2.0 * (1.0 - d) * (1.0 - s), 2.0 * d * s, d < vec3f(0.5)); }
  if (mode < 4.5) { return min(d, s); }
  if (mode < 5.5) { return max(d, s); }
  return min(d + s, vec3f(1.0));
}
fn proofCmyk(rgb: vec3<f32>) -> vec3<f32> {
  let k = 1.0 - max(rgb.r, max(rgb.g, rgb.b));
  if (k >= 0.999) { return vec3f(0.14, 0.12, 0.12) * 0.96; }
  var c = (1.0 - rgb.r - k) / (1.0 - k); var m = (1.0 - rgb.g - k) / (1.0 - k); var y = (1.0 - rgb.b - k) / (1.0 - k);
  let gcr = 0.6 * min(c, min(m, y)); c -= gcr; m -= gcr; y -= gcr; let kk = min(1.0, k + gcr);
  let g = 0.18;
  let C = c + g * 4.0 * c * (1.0 - c) * (1.0 - c * 0.5); let M = m + g * 4.0 * m * (1.0 - m) * (1.0 - m * 0.5);
  let Y = y + g * 4.0 * y * (1.0 - y) * (1.0 - y * 0.5); let K = kk + g * 4.0 * kk * (1.0 - kk) * (1.0 - kk * 0.5);
  var out = vec3f(0.96, 0.95, 0.92);
  out *= 1.0 - C * (1.0 - vec3f(0.08, 0.62, 0.90));
  out *= 1.0 - M * (1.0 - vec3f(0.92, 0.12, 0.55));
  out *= 1.0 - Y * (1.0 - vec3f(0.98, 0.93, 0.12));
  out *= 1.0 - K * (1.0 - vec3f(0.14, 0.12, 0.12));
  return out;
}
@fragment fn fs(in: VSOut) -> @location(0) vec4<f32> {
  let dst = textureSample(accTex, samp, in.uv);
  var src = textureSample(layerTex, samp, in.uv);
  let doc = inv * vec3f(in.clip, 1.0);
  if (doc.x < 0.0 || doc.y < 0.0 || doc.x > b.page.x || doc.y > b.page.y) { src = vec4f(0.0); }
  if (b.params.z > 0.5) {
    let muv = vec2f((doc.x - b.docRect.x) / b.docRect.z, (doc.y - b.docRect.y) / b.docRect.w);
    let m = textureSample(maskTex, samp, clamp(muv, vec2f(0.0), vec2f(1.0))).r;
    src = src * select(0.0, m, all(muv >= vec2f(0.0)) && all(muv <= vec2f(1.0)));
  }
  if (b.params.w > 0.5) { src = src * textureSample(clipTex, samp, in.uv).a; }
  let a = src.a * b.params.y;
  if (a <= 0.0) { return dst; }
  let s = unpremul(src); let d = unpremul(dst);
  let mixed = blendRgb(b.params.x, d, s);
  // src-over with the blended colour where both exist (dst alpha is 1 on paper)
  let rgb = mix(d, mixed, dst.a) * a + d * (1.0 - a);
  let outA = a + dst.a * (1.0 - a);
  return vec4f(rgb * outA, outA);
}
@fragment fn fsPresent(in: VSOut) -> @location(0) vec4<f32> {
  var c = textureSample(accTex, samp, in.uv);
  var rgb = unpremul(c);
  if (b.params.w > 0.5) { rgb = proofCmyk(rgb); }
  return vec4f(rgb * c.a, c.a); // premultiplied: transparent outside the page so the CSS surface shows
}
`;

interface TileGpu { texture: GPUTexture; generation: number; lastUse: number; bytes: number }

export class GpuCompositor {
  static isSupported(): boolean { return typeof navigator !== "undefined" && !!navigator.gpu; }

  private device!: GPUDevice;
  private ctx!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private tilePipeline!: GPURenderPipeline;
  private blendPipeline!: GPURenderPipeline;
  private presentPipeline!: GPURenderPipeline;
  private sampler!: GPUSampler;
  private quadBuf!: GPUBuffer;
  private acc: [GPUTexture, GPUTexture] | null = null;
  private layerTex: GPUTexture | null = null;
  private clipTex: GPUTexture | null = null;
  /** last fully composited frame; the swap-chain texture is not preserved between frames, so dirty rects are copied into this and the whole thing is presented */
  private final: GPUTexture | null = null;
  private w = 0; private h = 0;
  private tiles = new Map<Tile, TileGpu>();
  private tileBytes = 0;
  readonly tileBudgetBytes = 256 * 1024 * 1024;
  private frame = 0;
  private masks = new Map<number, { tex: GPUTexture; rect: [number, number, number, number] }>();
  private nprTex = new Map<number, { tex: GPUTexture; src: CanvasImageSource }>();
  private vectorScratch: HTMLCanvasElement | null = null;
  private white!: GPUTexture;
  private uniformBufs: GPUBuffer[] = [];
  private uniformIdx = 0;
  private rectBufs: GPUBuffer[] = [];
  private rectIdx = 0;
  ready = false;
  info = "";
  /** set when the device reports an error; the renderer then falls back to Canvas 2D */
  failed: string | null = null;

  constructor(private canvas: HTMLCanvasElement) {}

  async init(): Promise<boolean> {
    if (!GpuCompositor.isSupported()) return false;
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return false;
    this.device = await adapter.requestDevice();
    this.device.addEventListener("uncapturederror", (e) => { this.failed = (e as GPUUncapturedErrorEvent).error.message; console.error("[omni] WebGPU error, falling back to Canvas 2D:", this.failed); });
    void this.device.lost.then((info) => { this.failed = `device lost: ${info.message}`; });
    this.ctx = this.canvas.getContext("webgpu") as GPUCanvasContext;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.ctx.configure({ device: this.device, format: this.format, alphaMode: "premultiplied" });
    const dev = this.device;
    this.sampler = dev.createSampler({ magFilter: "linear", minFilter: "linear", mipmapFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const tileMod = dev.createShaderModule({ code: SHADER_TILE });
    const blendMod = dev.createShaderModule({ code: SHADER_BLEND });
    const premul: GPUBlendState = { color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" }, alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" } };
    this.tilePipeline = dev.createRenderPipeline({
      layout: "auto",
      vertex: { module: tileMod, entryPoint: "vs", buffers: [{ arrayStride: 16, stepMode: "instance", attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }] }] },
      fragment: { module: tileMod, entryPoint: "fs", targets: [{ format: "rgba16float", blend: premul }] },
      primitive: { topology: "triangle-list" },
    });
    this.blendPipeline = dev.createRenderPipeline({ layout: "auto", vertex: { module: blendMod, entryPoint: "vs" }, fragment: { module: blendMod, entryPoint: "fs", targets: [{ format: "rgba16float" }] }, primitive: { topology: "triangle-list" } });
    this.presentPipeline = dev.createRenderPipeline({ layout: "auto", vertex: { module: blendMod, entryPoint: "vs" }, fragment: { module: blendMod, entryPoint: "fsPresent", targets: [{ format: this.format }] }, primitive: { topology: "triangle-list" } });
    this.quadBuf = dev.createBuffer({ size: 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    this.white = dev.createTexture({ size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    dev.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
    const a = adapter.info;
    this.info = `${a?.vendor ?? "gpu"} ${a?.architecture ?? ""}`.trim();
    this.ready = true;
    return true;
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    this.w = w; this.h = h;
    this.acc?.forEach((t) => t.destroy()); this.layerTex?.destroy(); this.final?.destroy();
    const mk = () => this.device.createTexture({ size: [w, h], format: "rgba16float", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    this.acc = [mk(), mk()]; this.layerTex = mk(); this.final = mk(); this.clipTex = mk();
  }

  // ---- uniform ring (one buffer per draw, reused each frame) ----
  private uniform(bytes: Float32Array): GPUBuffer {
    let buf = this.uniformBufs[this.uniformIdx];
    if (!buf) { buf = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }); this.uniformBufs.push(buf); }
    this.device.queue.writeBuffer(buf, 0, bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.uniformIdx++;
    return buf;
  }

  private tileTexture(tile: Tile): GPUTexture {
    let g = this.tiles.get(tile);
    if (!g) {
      const texture = this.device.createTexture({ size: [TILE, TILE], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      g = { texture, generation: -1, lastUse: 0, bytes: TILE * TILE * 4 };
      this.tiles.set(tile, g); this.tileBytes += g.bytes;
    }
    if (g.generation !== tile.generation && tile.canvas) {
      this.device.queue.copyExternalImageToTexture({ source: tile.canvas as GPUImageCopyExternalImageSource }, { texture: g.texture, premultipliedAlpha: true }, [TILE, TILE]);
      g.generation = tile.generation;
    }
    g.lastUse = this.frame;
    return g.texture;
  }

  private evict(): void {
    if (this.tileBytes <= this.tileBudgetBytes) return;
    const entries = [...this.tiles.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse);
    for (const [tile, g] of entries) {
      if (this.tileBytes <= this.tileBudgetBytes * 0.8) break;
      if (g.lastUse === this.frame) continue;
      g.texture.destroy(); this.tiles.delete(tile); this.tileBytes -= g.bytes;
    }
  }

  private maskFor(doc: Doc, panel: Panel): { tex: GPUTexture; rect: [number, number, number, number] } {
    const hit = this.masks.get(panel.id); if (hit) return hit;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const q of panel.polygon) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
    const scale = 0.25; const w = Math.max(1, Math.ceil((x1 - x0) * scale)), h = Math.max(1, Math.ceil((y1 - y0) * scale));
    const c = document.createElement("canvas"); c.width = w; c.height = h;
    const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.scale(scale, scale); g.translate(-x0, -y0);
    g.beginPath(); panel.polygon.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y))); g.closePath(); g.fill();
    const tex = this.device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.device.queue.copyExternalImageToTexture({ source: c }, { texture: tex }, [w, h]);
    const entry = { tex, rect: [x0, y0, x1 - x0, y1 - y0] as [number, number, number, number] };
    this.masks.set(panel.id, entry);
    void doc;
    return entry;
  }
  invalidateMasks(): void { this.masks.forEach((m) => m.tex.destroy()); this.masks.clear(); }

  private viewMatrix(view: View, dpr: number): Float32Array {
    // doc → clip: clip.x = 2*(screen.x/W) - 1, clip.y = 1 - 2*(screen.y/H); screen = dpr*(pan + R(rot)·zoom·doc)
    const W = this.w, H = this.h, cs = Math.cos(view.rotation) * view.zoom * dpr, sn = Math.sin(view.rotation) * view.zoom * dpr;
    const tx = view.panX * dpr, ty = view.panY * dpr;
    // column-major mat3x3 with std140-style padding (each column vec3 padded to 16 bytes)
    const a = (2 / W) * cs, b = (-2 / H) * sn, c = (2 / W) * -sn, d = (-2 / H) * cs, e = (2 / W) * tx - 1, f = 1 - (2 / H) * ty;
    return new Float32Array([a, b, 0, 0, c, d, 0, 0, e, f, 1, 0]);
  }
  private inverseMatrix(m: Float32Array): Float32Array {
    const a = m[0]!, b = m[1]!, c = m[4]!, d = m[5]!, e = m[8]!, f = m[9]!;
    const det = a * d - b * c;
    const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
    const ie = -(ia * e + ic * f), iff = -(ib * e + id * f);
    return new Float32Array([ia, ib, 0, 0, ic, id, 0, 0, ie, iff, 1, 0]);
  }

  private drawTiles(enc: GPUCommandEncoder, target: GPUTexture, clear: boolean, tilesList: Array<{ tile?: Tile; texture?: GPUTexture; rect: [number, number, number, number] }>, uni: Float32Array, scissor: [number, number, number, number]): void {
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: clear ? "clear" : "load", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setScissorRect(scissor[0], scissor[1], scissor[2], scissor[3]);
    pass.setPipeline(this.tilePipeline);
    for (const t of tilesList) {
      const tex = t.texture ?? this.tileTexture(t.tile as Tile);
      const ub = this.uniform(uni);
      const bg = this.device.createBindGroup({ layout: this.tilePipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ub } }, { binding: 1, resource: this.sampler }, { binding: 2, resource: tex.createView() }] });
      let vb = this.rectBufs[this.rectIdx];
      if (!vb) { vb = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST }); this.rectBufs.push(vb); }
      this.device.queue.writeBuffer(vb, 0, new Float32Array(t.rect)); this.rectIdx++;
      pass.setBindGroup(0, bg); pass.setVertexBuffer(0, vb); pass.draw(6, 1);
    }
    pass.end();
  }

  private pageW = 0; private pageH = 0;
  private blend(enc: GPUCommandEncoder, src: GPUTexture, dst: GPUTexture, layer: GPUTexture, mode: number, opacity: number, mask: { tex: GPUTexture; rect: [number, number, number, number] } | null, inv: Float32Array, scissor: [number, number, number, number], clip: GPUTexture | null = null): void {
    const ub = this.uniform(new Float32Array([mode, opacity, mask ? 1 : 0, clip ? 1 : 0, ...(mask ? mask.rect : [0, 0, 1, 1]), this.pageW, this.pageH, 0, 0]));
    const ib = this.uniform(inv);
    const bg = this.device.createBindGroup({ layout: this.blendPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: ub } }, { binding: 1, resource: this.sampler }, { binding: 2, resource: src.createView() }, { binding: 3, resource: layer.createView() },
      { binding: 4, resource: (mask ? mask.tex : this.white).createView() }, { binding: 5, resource: { buffer: ib } }, { binding: 6, resource: (clip ?? this.white).createView() }] });
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: dst.createView(), loadOp: "load", storeOp: "store" }] });
    pass.setScissorRect(...scissor); pass.setPipeline(this.blendPipeline); pass.setBindGroup(0, bg); pass.draw(6, 1); pass.end();
  }

  /** Full-frame or dirty-rect composite. `clip` in device pixels. */
  render(doc: Doc, view: View, dpr: number, opts: RenderOptions, clip: { x0: number; y0: number; x1: number; y1: number }): void {
    if (!this.ready || !this.acc || !this.layerTex) return;
    this.frame++; this.uniformIdx = 0; this.rectIdx = 0; this.pageW = doc.width; this.pageH = doc.height;
    const dev = this.device, enc = dev.createCommandEncoder();
    const scissor: [number, number, number, number] = [Math.max(0, clip.x0), Math.max(0, clip.y0), Math.max(1, Math.min(this.w, clip.x1) - Math.max(0, clip.x0)), Math.max(1, Math.min(this.h, clip.y1) - Math.max(0, clip.y0))];
    const vm = this.viewMatrix(view, dpr), inv = this.inverseMatrix(vm);
    // per-layer affine (tween keys or the static layer transform) composed into the view matrix
    const withLayer = (L: [number, number, number, number, number, number]): Float32Array => {
      const va = vm[0]!, vb = vm[1]!, vc = vm[4]!, vd = vm[5]!, ve = vm[8]!, vf = vm[9]!; const [la, lb, lc, ld, le, lf] = L;
      return new Float32Array([va * la + vc * lb, vb * la + vd * lb, 0, 0, va * lc + vc * ld, vb * lc + vd * ld, 0, 0, va * le + vc * lf + ve, vb * le + vd * lf + vf, 1, 0]);
    };
    let layerM: Float32Array = vm;
    const base = (opacity: number, mode: number, tint: [number, number, number, number] = [0, 0, 0, 0], tone: [number, number, number, number] = [0, 0, 0, 0]) =>
      new Float32Array([...layerM, ...tint, opacity, mode, 0, 0, ...tone, this.w, this.h, view.zoom, dpr]);
    let cur = 0;
    // paper: clear acc to #0f0f0f then white page quad
    const pass0 = enc.beginRenderPass({ colorAttachments: [{ view: this.acc[0]!.createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] }); pass0.end();
    this.drawTiles(enc, this.acc[0]!, false, [{ texture: this.white, rect: [0, 0, doc.width, doc.height] }], base(1, 0), scissor);

    // visible doc rect for culling
    const corners = [[clip.x0, clip.y0], [clip.x1, clip.y0], [clip.x0, clip.y1], [clip.x1, clip.y1]].map(([x, y]) => {
      const cx = (2 * (x as number)) / this.w - 1, cy = 1 - (2 * (y as number)) / this.h;
      return [inv[0]! * cx + inv[4]! * cy + inv[8]!, inv[1]! * cx + inv[5]! * cy + inv[9]!];
    });
    const vx0 = Math.min(...corners.map((p) => p[0]!)), vy0 = Math.min(...corners.map((p) => p[1]!)), vx1 = Math.max(...corners.map((p) => p[0]!)), vy1 = Math.max(...corners.map((p) => p[1]!));
    const visibleTiles = (layer: Layer) => [...layer.tiles.values()].filter((t) => t.canvas && !(t.x * TILE > vx1 || t.y * TILE > vy1 || (t.x + 1) * TILE < vx0 || (t.y + 1) * TILE < vy0)).map((tile) => ({ tile, rect: [tile.x * TILE, tile.y * TILE, (tile.x + 1) * TILE, (tile.y + 1) * TILE] as [number, number, number, number] }));

    const composite = (layerTiles: ReturnType<typeof visibleTiles>, extra: Array<{ texture: GPUTexture; rect: [number, number, number, number] }>, uni: Float32Array, mode: number, opacity: number, mask: Panel | null, stroke: ActiveStroke | null, clip: Layer | null = null) => {
      if (clip) { // clipping base alpha in screen space
        const ex: Array<{ texture: GPUTexture; rect: [number, number, number, number] }> = [];
        if (clip.kind === "vector" && clip.paths.length) ex.push(this.vectorTexture(clip, vx0, vy0, vx1, vy1, view.zoom * dpr));
        this.drawTiles(enc, this.clipTex!, true, [...visibleTiles(clip), ...ex], base(1, 0), scissor);
      }
      this.drawTiles(enc, this.layerTex!, true, [...layerTiles, ...extra], uni, scissor);
      if (stroke && stroke.kind !== "smudge" && stroke.kind !== "blur") {
        for (const stk of [stroke, ...(opts.extraStrokes ?? []).filter((x) => x.layerId === stroke.layerId)]) {
          const st = visibleTiles(stk.buffer);
          this.drawTiles(enc, this.layerTex!, false, st, base(stk.opacity, stk.kind === "eraser" ? 1 : 0), scissor);
        }
      }
      this.blend(enc, this.acc![cur]!, this.acc![1 - cur]!, this.layerTex!, mode, opacity, mask ? this.maskFor(doc, mask) : null, inv, scissor, clip ? this.clipTex : null);
      // keep the untouched part of acc in sync: blend wrote only inside the scissor; copy the rest
      cur = 1 - cur;
    };

    // onion ghosts
    if (doc.onionEnabled) {
      const curDrawing = doc.drawing; const seen = new Set<number>([curDrawing.id]);
      const ghosts: Array<{ frame: typeof curDrawing; t: number; tint: [number, number, number, number] }> = [];
      for (let k = 1; k <= doc.onionPrev; k++) { const f = doc.drawingAt(doc.currentFrame - k); if (f && !seen.has(f.id)) { seen.add(f.id); ghosts.push({ frame: f, t: (k - 1) / Math.max(1, doc.onionPrev), tint: [0.75, 0.22, 0.17, 1] }); } }
      for (let k = 1; k <= doc.onionNext; k++) { const f = doc.drawingAt(doc.currentFrame + k); if (f && !seen.has(f.id)) { seen.add(f.id); ghosts.push({ frame: f, t: (k - 1) / Math.max(1, doc.onionNext), tint: [0.18, 0.53, 0.76, 1] }); } }
      for (const g of ghosts) {
        const tiles = g.frame.layers.filter((l) => l.visible && (l.kind === "raster" || l.kind === "vector")).flatMap((l) => visibleTiles(l));
        composite(tiles, [], base(1, 2, g.tint), 0, doc.onionCurve(g.t), null, null);
      }
    }

    for (const layer of doc.drawing.layers) {
      if (layer.kind === "group") continue;
      const eff = effectiveLayer(doc.drawing.layers, layer); if (!eff.visible || eff.opacity <= 0) continue;
      const clip = clipBase(doc.drawing.layers, layer);
      const kf = layer.keys.length ? layerAt(layer.keys, doc.currentFrame) : null;
      const lm = kf ? keyMatrix(kf) : layer.transform; const ident = lm[0] === 1 && lm[1] === 0 && lm[2] === 0 && lm[3] === 1 && lm[4] === 0 && lm[5] === 0;
      layerM = ident ? vm : withLayer(lm);
      const layerOpacity = eff.opacity * (kf ? kf.opacity : 1);
      const mask = layer.panelMask !== null ? doc.panels.find((p) => p.id === layer.panelMask) ?? null : null;
      const stroke = opts.activeStroke && opts.activeStroke.layerId === layer.id ? opts.activeStroke : null;
      if (layer.kind === "npr") {
        const src = opts.nprCanvases.get(layer.id); if (!src) continue;
        composite([], [{ texture: this.nprTexture(layer.id, src), rect: [0, 0, doc.width, doc.height] }], base(1, 0), BLEND_INDEX[layer.blend]!, layerOpacity, mask, null);
      } else if (layer.kind === "tone") {
        const pitch = (doc.dpi / layer.tone.lpi) * view.zoom * dpr;
        const tn = layer.tone; const shapeIdx = tn.shape === "dot" ? 0 : tn.shape === "line" ? 1 : tn.shape === "cross" ? 2 : tn.shape === "noise" ? 3 : 4;
        const uni = base(1, 0, tn.gradient ? [tn.gradient.x0, tn.gradient.y0, tn.gradient.x1, tn.gradient.y1] : [0, 0, 0, 0], [pitch, tn.density, (tn.angle * Math.PI) / 180, shapeIdx]);
        if (tn.gradient) { uni[18] = tn.gradient.density2; uni[19] = 1; } // params.z, params.w (12 mat + 4 tint + opacity, mode)
        composite(visibleTiles(layer), [], uni, BLEND_INDEX[layer.blend]!, layerOpacity, mask, stroke, clip);
      } else {
        const extra: Array<{ texture: GPUTexture; rect: [number, number, number, number] }> = [];
        if (layer.kind === "vector" && layer.paths.length) extra.push(this.vectorTexture(layer, vx0, vy0, vx1, vy1, view.zoom * dpr));
        composite(visibleTiles(layer), extra, base(1, 0), BLEND_INDEX[layer.blend]!, layerOpacity, mask, stroke, clip);
      }
    }
    // copy the composited rect into the persistent frame, then present the whole frame
    enc.copyTextureToTexture({ texture: this.acc[cur]!, origin: [scissor[0], scissor[1]] }, { texture: this.final!, origin: [scissor[0], scissor[1]] }, [scissor[2], scissor[3]]);
    const pb = this.uniform(new Float32Array([0, 1, 0, opts.proofCmyk ? 1 : 0, 0, 0, 1, 1, doc.width, doc.height, 0, 0]));
    const ib = this.uniform(inv);
    void ib;
    const bg = dev.createBindGroup({ layout: this.presentPipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: pb } }, { binding: 1, resource: this.sampler }, { binding: 2, resource: this.final!.createView() }] });
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } }] });
    pass.setPipeline(this.presentPipeline); pass.setBindGroup(0, bg); pass.draw(6, 1); pass.end();
    dev.queue.submit([enc.finish()]);
    this.evict();
  }

  private nprTexture(layerId: number, src: CanvasImageSource): GPUTexture {
    const c = src as HTMLCanvasElement;
    let e = this.nprTex.get(layerId);
    if (!e || e.src !== src) {
      e?.tex.destroy();
      const tex = this.device.createTexture({ size: [c.width, c.height], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
      this.device.queue.copyExternalImageToTexture({ source: c }, { texture: tex, premultipliedAlpha: true }, [c.width, c.height]);
      e = { tex, src }; this.nprTex.set(layerId, e);
    }
    return e.tex;
  }

  /** Vector paths rasterized on the CPU for the visible doc rect at screen resolution, uploaded as one quad. */
  private vectorTexture(layer: Layer, vx0: number, vy0: number, vx1: number, vy1: number, scale: number): { texture: GPUTexture; rect: [number, number, number, number] } {
    const w = Math.max(1, Math.min(4096, Math.ceil((vx1 - vx0) * scale))), h = Math.max(1, Math.min(4096, Math.ceil((vy1 - vy0) * scale)));
    if (!this.vectorScratch) this.vectorScratch = document.createElement("canvas");
    const c = this.vectorScratch; c.width = w; c.height = h;
    const g = c.getContext("2d")!; g.scale(w / (vx1 - vx0), h / (vy1 - vy0)); g.translate(-vx0, -vy0);
    for (const p of layer.paths) drawPathTo(g, p);
    const tex = this.device.createTexture({ size: [w, h], format: "rgba8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
    this.device.queue.copyExternalImageToTexture({ source: c }, { texture: tex, premultipliedAlpha: true }, [w, h]);
    // destroyed after submit via a microtask so the frame can still read it
    queueMicrotask(() => setTimeout(() => tex.destroy(), 0));
    return { texture: tex, rect: [vx0, vy0, vx1, vy1] };
  }

  /** Read one pixel of the last composited frame (device px). Used by the start-up self-test. */
  async readPixel(x: number, y: number): Promise<[number, number, number, number] | null> {
    if (!this.final) return null;
    const buf = this.device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.final, origin: [Math.max(0, Math.min(this.w - 1, x | 0)), Math.max(0, Math.min(this.h - 1, y | 0))] }, { buffer: buf, bytesPerRow: 256 }, [1, 1]);
    this.device.queue.submit([enc.finish()]);
    await buf.mapAsync(GPUMapMode.READ);
    const h = new Uint16Array(buf.getMappedRange(), 0, 4);
    const f16 = (u: number) => { const s = (u & 0x8000) ? -1 : 1, e = (u >> 10) & 0x1f, m = u & 0x3ff; return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15); };
    const out: [number, number, number, number] = [f16(h[0]!), f16(h[1]!), f16(h[2]!), f16(h[3]!)];
    buf.unmap(); buf.destroy();
    return out;
  }

  stats(): { tiles: number; tileMB: number } { return { tiles: this.tiles.size, tileMB: this.tileBytes / 1048576 }; }
}
