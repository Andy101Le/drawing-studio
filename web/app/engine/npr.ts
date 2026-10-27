import { makeCanvas } from "./document.js";
/**
 * Real-time cel-shaded NPR renderer (Phase 6.3), WebGL2.
 *
 * Passes:
 *   1. G-buffer: color (cel-banded), view-space normal, linear depth → 3 MRT targets
 *   2. Inverted hull: back faces extruded along normals, screen-constant width
 *   3. Edge compose: Sobel on depth + normal buffers → ink lines, composite over color
 *
 * Shading:  n·l → step(t_shadow) two-tone (+ optional third band), rim light
 *           as step(1 - n·v) for the anime "edge glow".
 * Planar projection: a 2D layer (any raster tiles) can be projected onto the
 * mesh along the view axis (decal), so inked lines land on the 3D form.
 */

export interface Mesh {
  positions: Float32Array; // xyz
  normals: Float32Array;
  indices: Uint32Array;
  name: string;
}

export interface NprParams {
  yaw: number; pitch: number; zoom: number;
  lightYaw: number; lightPitch: number;
  baseColor: [number, number, number];
  shadowColor: [number, number, number];
  tShadow: number; tHighlight: number; rim: number;
  lineWidthPx: number; depthEdge: number; normalEdge: number;
  bands: 2 | 3;
}

export const DEFAULT_NPR: NprParams = {
  yaw: 0.6, pitch: 0.35, zoom: 1, lightYaw: 0.8, lightPitch: 0.7,
  baseColor: [0.93, 0.80, 0.72], shadowColor: [0.60, 0.45, 0.50],
  tShadow: 0.25, tHighlight: 0.85, rim: 0.55, lineWidthPx: 2.2, depthEdge: 0.08, normalEdge: 0.35, bands: 2,
};

// ---- primitive meshes ----
export function sphere(seg = 48, rings = 32, r = 1): Mesh {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let y = 0; y <= rings; y++) {
    const v = y / rings, phi = v * Math.PI;
    for (let x = 0; x <= seg; x++) {
      const u = x / seg, th = u * Math.PI * 2;
      const nx = Math.sin(phi) * Math.cos(th), ny = Math.cos(phi), nz = Math.sin(phi) * Math.sin(th);
      pos.push(nx * r, ny * r, nz * r); nor.push(nx, ny, nz);
    }
  }
  for (let y = 0; y < rings; y++) for (let x = 0; x < seg; x++) {
    const a = y * (seg + 1) + x, b = a + seg + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), name: "sphere" };
}
export function torus(R = 1, r = 0.4, seg = 64, tube = 24): Mesh {
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  for (let i = 0; i <= seg; i++) {
    const u = (i / seg) * Math.PI * 2;
    for (let j = 0; j <= tube; j++) {
      const v = (j / tube) * Math.PI * 2;
      const cx = Math.cos(u) * R, cz = Math.sin(u) * R;
      const nx = Math.cos(u) * Math.cos(v), ny = Math.sin(v), nz = Math.sin(u) * Math.cos(v);
      pos.push(cx + nx * r, ny * r, cz + nz * r); nor.push(nx, ny, nz);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < tube; j++) {
    const a = i * (tube + 1) + j, b = a + tube + 1;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), name: "torus" };
}
export function box(s = 0.9): Mesh {
  const f = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  f.forEach(([nx, ny, nz], fi) => {
    const u = nx ? [0, 1, 0] : [1, 0, 0]; const v = nz ? [0, 1, 0] : [0, 0, 1];
    const uu = u, vv = nx || nz ? v : [0, 0, 1];
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
    for (const [a, b] of corners) {
      pos.push(nx! * s + (uu[0]! * a! + vv[0]! * b!) * s, ny! * s + (uu[1]! * a! + vv[1]! * b!) * s, nz! * s + (uu[2]! * a! + vv[2]! * b!) * s);
      nor.push(nx!, ny!, nz!);
    }
    const o = fi * 4;
    idx.push(o, o + 1, o + 2, o, o + 2, o + 3);
  });
  return { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), name: "box" };
}

/** Minimal OBJ loader: v, vn, f (triangulates fans). Generates smooth normals when absent. */
export function parseObj(text: string): Mesh {
  const v: number[][] = [], vn: number[][] = [];
  const pos: number[] = [], nor: number[] = [], idx: number[] = [];
  const cache = new Map<string, number>();
  for (const line of text.split("\n")) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "v") v.push([+p[1]!, +p[2]!, +p[3]!]);
    else if (p[0] === "vn") vn.push([+p[1]!, +p[2]!, +p[3]!]);
    else if (p[0] === "f") {
      const ids = p.slice(1).map((tok) => {
        let i = cache.get(tok);
        if (i !== undefined) return i;
        const [vi, , ni] = tok.split("/");
        const P = v[(+vi! > 0 ? +vi! - 1 : v.length + +vi!)]!;
        const N = ni ? vn[(+ni > 0 ? +ni - 1 : vn.length + +ni)]! : [0, 0, 0];
        i = pos.length / 3; pos.push(...P); nor.push(...N); cache.set(tok, i);
        return i;
      });
      for (let k = 1; k + 1 < ids.length; k++) idx.push(ids[0]!, ids[k]!, ids[k + 1]!);
    }
  }
  const mesh: Mesh = { positions: new Float32Array(pos), normals: new Float32Array(nor), indices: new Uint32Array(idx), name: "obj" };
  if (vn.length === 0) computeNormals(mesh);
  normalize(mesh);
  return mesh;
}
function computeNormals(m: Mesh): void {
  const n = new Float32Array(m.positions.length);
  const P = m.positions, I = m.indices;
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i]! * 3, b = I[i + 1]! * 3, c = I[i + 2]! * 3;
    const ux = P[b]! - P[a]!, uy = P[b + 1]! - P[a + 1]!, uz = P[b + 2]! - P[a + 2]!;
    const vx = P[c]! - P[a]!, vy = P[c + 1]! - P[a + 1]!, vz = P[c + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const k of [a, b, c]) { n[k]! += nx; n[k + 1]! += ny; n[k + 2]! += nz; }
  }
  for (let i = 0; i < n.length; i += 3) { const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!) || 1; n[i]! /= l; n[i + 1]! /= l; n[i + 2]! /= l; }
  m.normals = n;
}
function normalize(m: Mesh): void {
  const P = m.positions; let mx = 0, my = 0, mz = 0, n = P.length / 3;
  for (let i = 0; i < P.length; i += 3) { mx += P[i]!; my += P[i + 1]!; mz += P[i + 2]!; }
  mx /= n; my /= n; mz /= n; let r = 0;
  for (let i = 0; i < P.length; i += 3) { P[i]! -= mx; P[i + 1]! -= my; P[i + 2]! -= mz; r = Math.max(r, Math.hypot(P[i]!, P[i + 1]!, P[i + 2]!)); }
  for (let i = 0; i < P.length; i++) P[i]! /= r || 1;
}

// ---- shaders ----
const VS_GBUF = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor;
uniform mat4 uMVP, uMV; uniform mat3 uN;
out vec3 vN; out vec3 vV; out float vDepth; out vec2 vProj;
void main(){ vec4 mv = uMV*vec4(aPos,1.0); vV = -mv.xyz; vN = normalize(uN*aNor); vDepth = -mv.z;
  gl_Position = uMVP*vec4(aPos,1.0); vProj = gl_Position.xy/gl_Position.w*0.5+0.5; }`;

const FS_GBUF = `#version 300 es
precision highp float;
in vec3 vN; in vec3 vV; in float vDepth; in vec2 vProj;
uniform vec3 uL; uniform vec3 uBase, uShadow; uniform float uTShadow, uTHigh, uRim; uniform int uBands;
uniform sampler2D uDecal; uniform int uHasDecal;
layout(location=0) out vec4 oColor; layout(location=1) out vec4 oNormal; layout(location=2) out vec4 oDepth;
void main(){
  vec3 n = normalize(vN); vec3 v = normalize(vV); float ndl = dot(n, normalize(uL));
  float band = step(uTShadow, ndl);
  vec3 col = mix(uShadow, uBase, band);
  if (uBands == 3) { float hi = step(uTHigh, ndl); col = mix(col, min(col*1.18+0.05, vec3(1.0)), hi); }
  float rim = step(1.0 - uRim*0.5, 1.0 - max(dot(n, v), 0.0)) * step(0.0, ndl);
  col = mix(col, min(col + 0.25, vec3(1.0)), rim*0.6);
  if (uHasDecal == 1) { vec4 d = texture(uDecal, vec2(vProj.x, 1.0 - vProj.y)); col = mix(col, d.rgb, d.a); }
  oColor = vec4(col, 1.0); oNormal = vec4(n*0.5+0.5, 1.0); oDepth = vec4(vDepth, 0.0, 0.0, 1.0);
}`;

const VS_HULL = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos; layout(location=1) in vec3 aNor;
uniform mat4 uMVP; uniform mat3 uN; uniform float uWidth; uniform vec2 uViewport;
void main(){ vec4 clip = uMVP*vec4(aPos,1.0); vec3 nc = normalize(mat3(uMVP)*aNor);
  vec2 off = normalize(nc.xy + 1e-5) * uWidth / uViewport * 2.0 * clip.w; clip.xy += off; gl_Position = clip; }`;
const FS_HULL = `#version 300 es
precision highp float; out vec4 o; void main(){ o = vec4(0.06,0.05,0.07,1.0); }`;

const VS_QUAD = `#version 300 es
precision highp float; const vec2 q[6]=vec2[6](vec2(-1,-1),vec2(1,-1),vec2(-1,1),vec2(-1,1),vec2(1,-1),vec2(1,1));
out vec2 uv; void main(){ uv = q[gl_VertexID]*0.5+0.5; gl_Position = vec4(q[gl_VertexID],0,1); }`;
const FS_EDGE = `#version 300 es
precision highp float; in vec2 uv; out vec4 o;
uniform sampler2D uColor, uNormal, uDepth, uHull; uniform vec2 uTexel; uniform float uDepthT, uNormalT;
float sobel(sampler2D t, vec2 p, int ch){
  float k[9]; int i=0; for(int y=-1;y<=1;y++) for(int x=-1;x<=1;x++){ vec4 s = texture(t, p + vec2(x,y)*uTexel); k[i++] = ch==0 ? s.r : dot(s.rgb*2.0-1.0, vec3(0.577)); }
  float gx = -k[0]-2.0*k[3]-k[6]+k[2]+2.0*k[5]+k[8]; float gy = -k[0]-2.0*k[1]-k[2]+k[6]+2.0*k[7]+k[8];
  return sqrt(gx*gx+gy*gy); }
void main(){
  vec4 c = texture(uColor, uv); vec4 h = texture(uHull, uv);
  float d = texture(uDepth, uv).r; float de = sobel(uDepth, uv, 0) / max(d, 0.2);
  float ne = sobel(uNormal, uv, 1);
  float edge = step(uDepthT, de) + step(uNormalT, ne);
  edge = clamp(edge, 0.0, 1.0);
  vec3 ink = vec3(0.06,0.05,0.07);
  vec3 col = mix(c.rgb, ink, edge * c.a);
  float a = max(c.a, h.a);
  if (c.a < 0.5 && h.a > 0.5) col = ink;
  o = vec4(col, a);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const mk = (type: number, src: string) => { const s = gl.createShader(type)!; gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader"); return s; };
  const p = gl.createProgram()!; gl.attachShader(p, mk(gl.VERTEX_SHADER, vs)); gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
  return p;
}

// ---- tiny matrix helpers ----
function perspective(fov: number, aspect: number, n: number, f: number): Float32Array {
  const t = 1 / Math.tan(fov / 2); const m = new Float32Array(16);
  m[0] = t / aspect; m[5] = t; m[10] = (f + n) / (n - f); m[11] = -1; m[14] = (2 * f * n) / (n - f); return m;
}
function mat4mul(a: Float32Array, b: Float32Array): Float32Array {
  const o = new Float32Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r]! * b[c * 4 + k]!; o[c * 4 + r] = s; }
  return o;
}
function rotYX(yaw: number, pitch: number, zoom: number): Float32Array {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const Y = new Float32Array([cy, 0, -sy, 0, 0, 1, 0, 0, sy, 0, cy, 0, 0, 0, 0, 1]);
  const X = new Float32Array([1, 0, 0, 0, 0, cp, sp, 0, 0, -sp, cp, 0, 0, 0, 0, 1]);
  const T = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -6.0 / zoom, 1]);
  return mat4mul(T, mat4mul(X, Y));
}
function normalMat(mv: Float32Array): Float32Array {
  // upper-left 3x3 of a rotation+translation matrix is already orthonormal
  return new Float32Array([mv[0]!, mv[1]!, mv[2]!, mv[4]!, mv[5]!, mv[6]!, mv[8]!, mv[9]!, mv[10]!]);
}

export class NprRenderer {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private gl: WebGL2RenderingContext;
  private pG: WebGLProgram; private pH: WebGLProgram; private pE: WebGLProgram;
  private vao: WebGLVertexArrayObject | null = null;
  private count = 0;
  private fbo: WebGLFramebuffer; private hullFbo: WebGLFramebuffer;
  private tex: WebGLTexture[] = []; private hullTex: WebGLTexture; private depthRb: WebGLRenderbuffer; private hullDepthRb: WebGLRenderbuffer;
  private decal: WebGLTexture | null = null;
  private w = 0; private h = 0;
  mesh: Mesh;

  constructor(w: number, h: number, mesh: Mesh = sphere()) {
    this.canvas = makeCanvas(w, h);
    const gl = this.canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 unavailable");
    this.gl = gl;
    this.pG = compile(gl, VS_GBUF, FS_GBUF);
    this.pH = compile(gl, VS_HULL, FS_HULL);
    this.pE = compile(gl, VS_QUAD, FS_EDGE);
    this.fbo = gl.createFramebuffer()!; this.hullFbo = gl.createFramebuffer()!;
    this.hullTex = gl.createTexture()!; this.depthRb = gl.createRenderbuffer()!; this.hullDepthRb = gl.createRenderbuffer()!;
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float required");
    this.mesh = mesh;
    this.resize(w, h);
    this.setMesh(mesh);
  }

  resize(w: number, h: number): void {
    if (w === this.w && h === this.h) return;
    const gl = this.gl; this.w = w; this.h = h; this.canvas.width = w; this.canvas.height = h;
    for (const t of this.tex) gl.deleteTexture(t);
    this.tex = [];
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const fmts: Array<[number, number, number]> = [[gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE], [gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE], [gl.R32F, gl.RED, gl.FLOAT]];
    fmts.forEach(([inner, fmt, type], i) => {
      const t = gl.createTexture()!; gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, inner, w, h, 0, fmt, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      this.tex.push(t);
    });
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hullFbo);
    gl.bindTexture(gl.TEXTURE_2D, this.hullTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.hullTex, 0);
    gl.bindRenderbuffer(gl.RENDERBUFFER, this.hullDepthRb); gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.hullDepthRb);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  setMesh(m: Mesh): void {
    const gl = this.gl; this.mesh = m;
    if (this.vao) gl.deleteVertexArray(this.vao);
    this.vao = gl.createVertexArray(); gl.bindVertexArray(this.vao);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.indices, gl.STATIC_DRAW);
    this.count = m.indices.length;
    gl.bindVertexArray(null);
  }

  /** Planar projection source: any canvas (a rendered 2D layer). null removes it. */
  setDecal(src: CanvasImageSource | null): void {
    const gl = this.gl;
    if (!src) { if (this.decal) gl.deleteTexture(this.decal); this.decal = null; return; }
    if (!this.decal) this.decal = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.decal);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src as TexImageSource);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  render(p: NprParams): void {
    const gl = this.gl, w = this.w, h = this.h;
    const proj = perspective(0.55, w / h, 0.1, 60);
    const mv = rotYX(p.yaw, p.pitch, p.zoom);
    const mvp = mat4mul(proj, mv);
    const nm = normalMat(mv);
    const L = [Math.cos(p.lightPitch) * Math.sin(p.lightYaw), Math.sin(p.lightPitch), Math.cos(p.lightPitch) * Math.cos(p.lightYaw)];

    gl.viewport(0, 0, w, h);
    // unbind sampler units used by the compose pass so no FBO attachment is also a bound texture
    for (let i = 0; i < 4; i++) { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, null); }
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    // pass 1: g-buffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]); gl.clearBufferfv(gl.COLOR, 1, [0.5, 0.5, 0.5, 0]); gl.clearBufferfv(gl.COLOR, 2, [0, 0, 0, 0]);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.cullFace(gl.BACK);
    gl.useProgram(this.pG);
    const u = (n: string) => gl.getUniformLocation(this.pG, n);
    gl.uniformMatrix4fv(u("uMVP"), false, mvp); gl.uniformMatrix4fv(u("uMV"), false, mv); gl.uniformMatrix3fv(u("uN"), false, nm);
    gl.uniform3fv(u("uL"), L); gl.uniform3fv(u("uBase"), p.baseColor); gl.uniform3fv(u("uShadow"), p.shadowColor);
    gl.uniform1f(u("uTShadow"), p.tShadow); gl.uniform1f(u("uTHigh"), p.tHighlight); gl.uniform1f(u("uRim"), p.rim); gl.uniform1i(u("uBands"), p.bands);
    gl.uniform1i(u("uHasDecal"), this.decal ? 1 : 0);
    if (this.decal) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.decal); gl.uniform1i(u("uDecal"), 3); }
    gl.bindVertexArray(this.vao); gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    // pass 2: inverted hull
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.hullFbo);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.cullFace(gl.FRONT);
    gl.useProgram(this.pH);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.pH, "uMVP"), false, mvp); gl.uniformMatrix3fv(gl.getUniformLocation(this.pH, "uN"), false, nm);
    gl.uniform1f(gl.getUniformLocation(this.pH, "uWidth"), p.lineWidthPx); gl.uniform2f(gl.getUniformLocation(this.pH, "uViewport"), w, h);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    // pass 3: edges + compose to canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.DEPTH_TEST); gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.pE);
    const names = ["uColor", "uNormal", "uDepth", "uHull"];
    [this.tex[0]!, this.tex[1]!, this.tex[2]!, this.hullTex].forEach((t, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(gl.getUniformLocation(this.pE, names[i]!), i); });
    gl.uniform2f(gl.getUniformLocation(this.pE, "uTexel"), 1 / w, 1 / h);
    gl.uniform1f(gl.getUniformLocation(this.pE, "uDepthT"), p.depthEdge); gl.uniform1f(gl.getUniformLocation(this.pE, "uNormalT"), p.normalEdge);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Depth map of the last render for the depth ControlNet: near = white, far = black, background
   * black (MiDaS convention). Reads the linear-depth G-buffer (R32F) and normalises over the covered pixels.
   */
  depthMap(): HTMLCanvasElement {
    const gl = this.gl, w = this.w, h = this.h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo); gl.readBuffer(gl.COLOR_ATTACHMENT2);
    const buf = new Float32Array(w * h); gl.readPixels(0, 0, w, h, gl.RED, gl.FLOAT, buf);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    let lo = Infinity, hi = -Infinity; for (let i = 0; i < buf.length; i++) { const d = buf[i]!; if (d > 0) { if (d < lo) lo = d; if (d > hi) hi = d; } }
    const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!; const img = g.createImageData(w, h); const d = img.data;
    const range = hi > lo ? hi - lo : 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = buf[(h - 1 - y) * w + x]!; const i = (y * w + x) * 4; // GL rows are bottom-up
      const t = v > 0 ? 1 - (v - lo) / range : 0; const b = Math.round(40 + 215 * t) * (v > 0 ? 1 : 0);
      d[i] = d[i + 1] = d[i + 2] = b; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0); return c;
  }
}
