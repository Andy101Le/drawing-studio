/**
 * Selection overlay: marching ants, floating-pixel preview and transform handles.
 *
 * Ants are derived from the mask itself, so every selection shape (wand regions
 * included) gets an outline: the mask is drawn in screen space, eroded by one pixel
 * with four offset destination-out passes, and the remaining 1 px rim is masked by an
 * animated diagonal stripe pattern. The animation only runs while a selection exists.
 */
import type { AppState } from "./state.js";
import type { SelectController } from "./select-tools.js";
import { floatingMatrix } from "../engine/selection.js";
import { layerAt } from "../engine/tween.js";

export function installSelectionOverlay(app: AppState, canvas: HTMLCanvasElement, overlay: HTMLCanvasElement, select: SelectController): void {
  const ctx = overlay.getContext("2d")!;
  let scratch: HTMLCanvasElement | null = null; let tmpC: HTMLCanvasElement | null = null;
  const rimCache = new WeakMap<HTMLCanvasElement, { key: string; canvas: HTMLCanvasElement }>();
  let phase = 0; let raf = 0;
  const stripes = (() => { const c = document.createElement("canvas"); c.width = 8; c.height = 8; const g = c.getContext("2d")!; g.fillStyle = "#000"; g.beginPath(); g.moveTo(0, 8); g.lineTo(8, 0); g.lineTo(8, 4); g.lineTo(4, 8); g.closePath(); g.fill(); g.beginPath(); g.moveTo(0, 0); g.lineTo(4, 0); g.lineTo(0, 4); g.closePath(); g.fill(); return c; })();

  const paint = () => {
    const r = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
    const W = Math.round(r.width * dpr), H = Math.round(r.height * dpr);
    if (overlay.width !== W || overlay.height !== H) { overlay.width = W; overlay.height = H; overlay.style.width = `${r.width}px`; overlay.style.height = `${r.height}px`; }
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, W, H);
    const m = app.renderer.matrix(); // doc -> device px
    const sel = app.floating && app.floatingSel ? null : app.selection;

    // floating pixels: drawn above the document with the live transform
    if (app.floating) {
      const f = app.floating; const fm = floatingMatrix(f);
      const draw = (alpha: number, clip: boolean) => {
        ctx.save(); ctx.setTransform(m);
        if (clip && f.clip) { ctx.beginPath(); f.clip.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.closePath(); ctx.clip(); }
        ctx.transform(fm.a, fm.b, fm.c, fm.d, fm.e, fm.f); ctx.globalAlpha = alpha;
        ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high"; ctx.drawImage(f.canvas, f.x, f.y);
        // a whole group in flight: its other layers on top, in order (blend modes are approximated as normal until the stamp)
        for (const q of f.parts ?? []) { if (!q.layer.visible) continue; ctx.globalCompositeOperation = q.layer.blend === "multiply" ? "multiply" : q.layer.blend === "screen" ? "screen" : "source-over"; ctx.globalAlpha = alpha * q.layer.opacity * (q.layer.kind === "tone" ? (q.layer.tone?.density ?? 0.3) : 1); ctx.drawImage(q.canvas, f.x, f.y); }
        ctx.restore();
      };
      // cropped to a panel: the part that will be cut off shows faintly so the crop can be judged
      if (f.clip) { draw(0.22, false); draw(1, true); } else draw(1, false);
      // the panel it will land in, and any snap lines in use
      const sn = select.snap;
      if (sn.panel || sn.xs.length || sn.ys.length) {
        ctx.save(); ctx.setTransform(m); const z = app.renderer.view.zoom * dpr;
        if (sn.panel) { ctx.strokeStyle = "rgba(90,170,255,0.95)"; ctx.lineWidth = 3 / z; ctx.strokeRect(sn.panel.x0, sn.panel.y0, sn.panel.x1 - sn.panel.x0, sn.panel.y1 - sn.panel.y0); }
        ctx.strokeStyle = "rgba(255,80,160,0.95)"; ctx.lineWidth = 1.5 / z; ctx.setLineDash([6 / z, 4 / z]);
        for (const x of sn.xs) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, app.doc.height); ctx.stroke(); }
        for (const y of sn.ys) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(app.doc.width, y); ctx.stroke(); }
        ctx.restore();
      }
    }

    // ants
    // The rim (mask minus its 1 px erosion) costs ~10 full-screen passes, so it is cached per
    // selection + view + floating transform; each frame only re-stripes the cached rim.
    const antsFor = (maskCanvas: HTMLCanvasElement, transform?: DOMMatrix) => {
      if (!scratch) scratch = document.createElement("canvas");
      if (!tmpC) tmpC = document.createElement("canvas");
      if (scratch.width !== W || scratch.height !== H) { scratch.width = W; scratch.height = H; tmpC.width = W; tmpC.height = H; }
      const key = `${W}x${H}|${m.a},${m.b},${m.c},${m.d},${m.e},${m.f}|${transform ? `${transform.a},${transform.b},${transform.c},${transform.d},${transform.e},${transform.f}` : ""}`;
      let rim = rimCache.get(maskCanvas);
      if (!rim || rim.key !== key) {
        const rc = document.createElement("canvas"); rc.width = W; rc.height = H; const s = rc.getContext("2d")!; const t = tmpC.getContext("2d")!;
        s.setTransform(m); if (transform) s.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
        s.imageSmoothingEnabled = false; s.drawImage(maskCanvas, 0, 0);
        // erode by 1 device px (intersection of the four 1 px shifts), rim = mask minus eroded
        s.setTransform(1, 0, 0, 1, 0, 0);
        t.setTransform(1, 0, 0, 1, 0, 0); t.globalCompositeOperation = "source-over"; t.clearRect(0, 0, W, H); t.drawImage(rc, 0, 0);
        t.globalCompositeOperation = "destination-in";
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) t.drawImage(rc, dx!, dy!);
        t.globalCompositeOperation = "source-over";
        s.globalCompositeOperation = "destination-out"; s.drawImage(tmpC, 0, 0);
        s.globalCompositeOperation = "source-in"; s.fillStyle = "#000"; s.fillRect(0, 0, W, H);
        rim = { key, canvas: rc }; rimCache.set(maskCanvas, rim);
      }
      // black rim, then white stripes limited to the rim = black/white ants
      ctx.drawImage(rim.canvas, 0, 0);
      const s = scratch.getContext("2d")!;
      s.setTransform(1, 0, 0, 1, 0, 0); s.globalCompositeOperation = "source-over"; s.clearRect(0, 0, W, H); s.drawImage(rim.canvas, 0, 0);
      s.globalCompositeOperation = "source-in"; s.fillStyle = "#fff"; s.fillRect(0, 0, W, H);
      s.globalCompositeOperation = "destination-in"; s.save(); s.translate(phase, phase); s.fillStyle = s.createPattern(stripes, "repeat")!; s.fillRect(-16, -16, W + 32, H + 32); s.restore();
      s.globalCompositeOperation = "source-over";
      ctx.drawImage(scratch, 0, 0);
    };
    if (sel && !sel.empty) antsFor(sel.canvas);
    if (app.floating && app.floatingSel) antsFor(app.floatingSel.canvas, floatingMatrix(app.floating));

    // rulers: line (full-width guide, parallel family faint) and perspective (vanishing points + rays)
    const rl = app.ruler;
    if (rl.kind !== "none") {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = 1 * dpr;
      const toS = (q: { x: number; y: number }) => { const t = m.transformPoint(new DOMPoint(q.x, q.y)); return { x: t.x, y: t.y }; };
      if (rl.kind === "line") {
        const a = toS(rl.a), b = toS(rl.b); const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; const ux = dx / l, uy = dy / l; const L = Math.hypot(W, H) * 2;
        ctx.strokeStyle = "rgba(79,142,247,0.9)"; ctx.beginPath(); ctx.moveTo(a.x - ux * L, a.y - uy * L); ctx.lineTo(a.x + ux * L, a.y + uy * L); ctx.stroke();
        ctx.strokeStyle = "rgba(79,142,247,0.22)"; const px = -uy, py = ux; const step = 48 * dpr;
        for (let k = -40; k <= 40; k++) { if (!k) continue; ctx.beginPath(); ctx.moveTo(a.x + px * step * k - ux * L, a.y + py * step * k - uy * L); ctx.lineTo(a.x + px * step * k + ux * L, a.y + py * step * k + uy * L); ctx.stroke(); }
      } else if (rl.kind === "curve") {
        const c = rl.curve.map(toS); ctx.strokeStyle = "rgba(79,142,247,0.9)";
        if (c.length >= 2) { ctx.beginPath(); ctx.moveTo(c[0]!.x, c[0]!.y); if (c.length === 2) ctx.lineTo(c[1]!.x, c[1]!.y); else if (c.length === 3) ctx.quadraticCurveTo(c[1]!.x, c[1]!.y, c[2]!.x, c[2]!.y); else ctx.bezierCurveTo(c[1]!.x, c[1]!.y, c[2]!.x, c[2]!.y, c[3]!.x, c[3]!.y); ctx.stroke(); }
        ctx.strokeStyle = "rgba(79,142,247,0.35)"; ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.beginPath(); c.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); ctx.setLineDash([]);
        for (const q of c) { ctx.fillStyle = "#4f8ef7"; ctx.beginPath(); ctx.arc(q.x, q.y, 4 * dpr, 0, Math.PI * 2); ctx.fill(); }
      } else if (rl.kind === "ellipse") {
        const e = rl.ellipse; ctx.strokeStyle = "rgba(79,142,247,0.9)"; ctx.save(); ctx.setTransform(m); ctx.lineWidth = 1 / (app.renderer.view.zoom * dpr) * dpr; ctx.beginPath(); ctx.ellipse(e.cx, e.cy, e.rx, e.ry, e.rot, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      } else {
        for (const v of rl.vps) {
          const q = toS(v); ctx.fillStyle = "#4f8ef7"; ctx.beginPath(); ctx.arc(q.x, q.y, 5 * dpr, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = "rgba(79,142,247,0.28)"; const L = Math.hypot(W, H) * 2;
          for (let k = 0; k < 36; k++) { const a = (k / 36) * Math.PI * 2; ctx.beginPath(); ctx.moveTo(q.x, q.y); ctx.lineTo(q.x + Math.cos(a) * L, q.y + Math.sin(a) * L); ctx.stroke(); }
        }
        if (rl.vps.length >= 2) { const a = toS(rl.vps[0]!), b = toS(rl.vps[1]!); ctx.strokeStyle = "rgba(79,142,247,0.7)"; ctx.setLineDash([6 * dpr, 4 * dpr]); const dx = b.x - a.x, dy = b.y - a.y, l = Math.hypot(dx, dy) || 1; const L = Math.hypot(W, H) * 2; ctx.beginPath(); ctx.moveTo(a.x - (dx / l) * L, a.y - (dy / l) * L); ctx.lineTo(a.x + (dx / l) * L, a.y + (dy / l) * L); ctx.stroke(); ctx.setLineDash([]); }
      }
      ctx.restore();
    }
    // motion path of the active layer (pivot position per frame), keys as diamonds
    const ml = app.doc.activeLayer;
    if (app.doc.mode === "anime" && ml.keys.length >= 2) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = "rgba(240,160,80,0.9)";
      const n = app.doc.exposure.length; ctx.beginPath();
      for (let f = 0; f < n; f++) { const k = layerAt(ml.keys, f)!; const q = m.transformPoint(new DOMPoint(k.x + k.px, k.y + k.py)); if (f) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }
      ctx.stroke();
      for (const k of ml.keys) { const q = m.transformPoint(new DOMPoint(k.x + k.px, k.y + k.py)); ctx.fillStyle = k.frame === app.doc.currentFrame ? "#fff" : "#f0a050"; ctx.beginPath(); ctx.moveTo(q.x, q.y - 6 * dpr); ctx.lineTo(q.x + 6 * dpr, q.y); ctx.lineTo(q.x, q.y + 6 * dpr); ctx.lineTo(q.x - 6 * dpr, q.y); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
    // symmetry guides
    const sy = app.symmetry;
    if (sy.kind !== "none") {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = 1 * dpr; ctx.strokeStyle = "rgba(240,160,80,0.85)"; ctx.setLineDash([8 * dpr, 6 * dpr]);
      const c = m.transformPoint(new DOMPoint(sy.cx, sy.cy)); const L = Math.hypot(W, H) * 2;
      const n = sy.kind === "mirror" ? 1 : sy.count; const mirrorExtra = sy.kind === "radial" && sy.mirrorRadial;
      for (let k = 0; k < n; k++) {
        const ang = sy.kind === "mirror" ? (sy.angle * Math.PI) / 180 : (k / n) * Math.PI * 2 + Math.PI / 2;
        // view rotation applied through the matrix: rotate the axis vector by m
        const v = m.transformPoint(new DOMPoint(sy.cx + Math.cos(ang), sy.cy + Math.sin(ang))); const dx = v.x - c.x, dy = v.y - c.y, l = Math.hypot(dx, dy) || 1;
        ctx.beginPath(); ctx.moveTo(c.x - (dx / l) * L, c.y - (dy / l) * L); ctx.lineTo(c.x + (dx / l) * L, c.y + (dy / l) * L); ctx.stroke();
      }
      if (mirrorExtra) { ctx.beginPath(); ctx.moveTo(c.x, c.y - L); ctx.lineTo(c.x, c.y + L); ctx.stroke(); }
      ctx.setLineDash([]); ctx.fillStyle = "rgba(240,160,80,0.9)"; ctx.beginPath(); ctx.arc(c.x, c.y, 5 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    }
    // drag preview for marquee shapes
    const pv = select.preview;
    if (pv && pv.pts.length >= 2) {
      ctx.save(); ctx.setTransform(m);
      ctx.beginPath();
      if (pv.shape === "rect") { const [a, b] = [pv.pts[0]!, pv.pts[1]!]; ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)); }
      else if (pv.shape === "ellipse") { const [a, b] = [pv.pts[0]!, pv.pts[1]!]; ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2); }
      else { pv.pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); if (pv.shape === "lasso") ctx.closePath(); }
      ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.lineWidth = 1 * dpr; ctx.strokeStyle = "#000"; ctx.stroke(); ctx.setLineDash([4 * dpr, 4 * dpr]); ctx.strokeStyle = "#fff"; ctx.stroke(); ctx.restore();
    }

    placeBar();
    // transform handles
    const hb = select.handleBox();
    if (hb) {
      ctx.save(); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.strokeStyle = "rgba(230,230,230,0.9)"; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); [0, 2, 4, 6].forEach((i, k) => { const q = hb.pts[i]!; if (k) ctx.lineTo(q.x, q.y); else ctx.moveTo(q.x, q.y); }); ctx.closePath(); ctx.stroke();
      ctx.setLineDash([]); ctx.beginPath(); ctx.moveTo(hb.pts[1]!.x, hb.pts[1]!.y); ctx.lineTo(hb.rot.x, hb.rot.y); ctx.stroke();
      hb.pts.forEach((q, i) => { const corner = i % 2 === 0; const r = corner ? 6 : 5; ctx.fillStyle = corner ? "#e6e6e6" : "#161616"; ctx.strokeStyle = corner ? "#161616" : "#e6e6e6"; ctx.beginPath(); ctx.rect(q.x - r, q.y - r, r * 2, r * 2); ctx.fill(); ctx.stroke(); });
      ctx.beginPath(); ctx.arc(hb.rot.x, hb.rot.y, 6, 0, Math.PI * 2); ctx.fillStyle = "#161616"; ctx.fill(); ctx.stroke();
      ctx.restore();
    }
  };

  // ---- floating toolbar: one-click fit / fill into the panel under the picture ----
  const bar = document.createElement("div"); bar.className = "float-bar";
  Object.assign(bar.style, { position: "fixed", display: "none", gap: "4px", padding: "4px", background: "rgba(22,22,22,0.94)", border: "1px solid #3a3a3a", borderRadius: "6px", zIndex: "40", fontSize: "12px" });
  const btn = (label: string, title: string, help: string, run: () => void) => { const b = document.createElement("button"); b.textContent = label; b.title = title; b.setAttribute("data-help", help); b.addEventListener("pointerdown", (e) => e.stopPropagation()); b.addEventListener("click", (e) => { e.stopPropagation(); run(); }); return b; };
  bar.append(
    btn("Fit panel", "Fit to panel", "Scale the picture so all of it fits inside the panel under it, centred. Double-click the picture does Fill.", () => select.fitPanel("fit")),
    btn("Fill panel", "Fill panel", "Scale the picture to cover the panel under it, centred; whatever spills over the panel border is cropped when you press Done. Drag to choose the crop.", () => select.fitPanel("fill")),
    btn("Reset", "Reset transform", "Back to the size and place it had when lifted.", () => select.resetTransform()),
    btn("Done", "Apply transform", "Stamp the picture where it is (Enter). Esc cancels.", () => select.commitFloating()));
  document.body.append(bar);
  const placeBar = () => {
    const hb = select.handleBox();
    if (!hb || !app.floating) { bar.style.display = "none"; return; }
    const r = canvas.getBoundingClientRect(); bar.style.display = "flex";
    const xs = hb.pts.map((q) => q.x), ys = hb.pts.map((q) => q.y);
    const bw = bar.offsetWidth || 260; let x = r.left + (Math.min(...xs) + Math.max(...xs)) / 2 - bw / 2, y = r.top + Math.max(...ys) + 14;
    if (y + 40 > r.bottom) y = r.top + Math.min(...ys) - 48; // no room below: above the box
    x = Math.max(r.left + 4, Math.min(r.right - bw - 4, x)); y = Math.max(r.top + 4, y);
    bar.style.left = `${x}px`; bar.style.top = `${y}px`;
  };
  canvas.addEventListener("dblclick", (e) => {
    if (!app.floating || app.tool !== "move") return;
    const r = canvas.getBoundingClientRect(); if (select.handleAt(e.clientX - r.left, e.clientY - r.top) !== "body") return;
    select.fitPanel("fill");
  });
  let antsFrame = 0;
  const tick = () => { if ((antsFrame++ & 1) === 0) { phase = (phase + 1) % 8; paint(); } raf = (app.selection || app.floating) ? requestAnimationFrame(tick) : 0; }; // ants step at 30 Hz
  const kick = () => { if (!raf && (app.selection || app.floating)) raf = requestAnimationFrame(tick); else if (!app.selection && !app.floating) paint(); };
  app.on("ruler", paint); app.on("symmetry", paint); app.on("timeline", paint); app.on("frame", paint);
  app.on("selection", kick); app.on("sel-preview", paint); app.on("view", paint); app.on("tool", kick); app.on("layers", paint);
  kick();
}
