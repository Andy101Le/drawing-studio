// Scripted "artist": drives the real OMNI-CELL tools through pointer events on the canvas.
(() => {
  const o = window.omni; const B = window.omniBrush;
  const canvas = document.querySelector('#draw');
  let pid = 100;
  const rnd = (() => { let s = 12345; return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; })();
  const api = {
    rnd,
    seed(v) { /* deterministic per sample */ let s = v; api.rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; },
    setup(w, h, dpi = 300) {
      o.emit('doc-reset'); o.history.clear(); o.story = null;
      const D = o.doc.constructor; const d = new D(); d.width = w; d.height = h; d.dpi = dpi; d.mode = 'manga'; d.panels = [];
      d.drawing.layers[0].name = 'Paper'; d.drawing.layers.length = 1; d.activeLayerId = d.drawing.layers[0].id;
      o.doc = d; o.cache.index(d); o.renderer.fitPage(d); o.invalidate(); o.emit('layers'); o.emit('doc-loaded');
    },
    layer(name, opts = {}) { const l = o.doc.addLayer('raster'); l.name = name; Object.assign(l, opts); o.emit('layers'); return l; },
    active(l) { o.doc.activeLayerId = l.id; o.emit('layers'); },
    toScreen(x, y) { const r = canvas.getBoundingClientRect(); const p = o.renderer.docToScreen(x, y); return [p.x + r.left, p.y + r.top]; },
    preset(name, over = {}) { const p = B.PRESETS.find((q) => q.name === name); if (!p) throw new Error('no preset ' + name); o.setPreset({ ...p, ...over }); return o.preset; },
    /** pts: [[x,y,(p)]] doc coords. profile: pressure curve fn(t) when no p given */
    stroke(presetName, color, size, pts, over = {}, profile = (t) => Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.6) {
      api.preset(presetName, { size, ...over }); o.setColor(color); const id = ++pid; o.setTool('brush');
      const fire = (type, x, y, p) => { const [sx, sy] = api.toScreen(x, y); canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'pen', isPrimary: true, clientX: sx, clientY: sy, pressure: p, buttons: 1, bubbles: true })); };
      const n = pts.length; const pr = (i) => pts[i][2] !== undefined ? pts[i][2] : profile(n > 1 ? i / (n - 1) : 1);
      fire('pointerdown', pts[0][0], pts[0][1], pr(0));
      for (let i = 1; i < n; i++) fire('pointermove', pts[i][0], pts[i][1], pr(i));
      fire('pointerup', pts[n - 1][0], pts[n - 1][1], pr(n - 1));
    },
    eraser(size, pts, hard = true) { api.stroke(hard ? 'Eraser Hard' : 'Eraser Soft', '#000', size, pts, {}, () => 1); },
    fill(x, y, color, opts = {}) {
      o.setTool('fill'); o.setColor(color); Object.assign(o, { fillTolerance: 0.25, fillExpand: 2, fillAutoClose: true, fillMaxAutoGap: 24, fillStopLeaks: false, fillReference: 'all', fillMode: 'contiguous' }, opts);
      const id = ++pid; const [sx, sy] = api.toScreen(x, y);
      const fire = (type) => canvas.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'mouse', isPrimary: true, clientX: sx, clientY: sy, buttons: 1, bubbles: true }));
      fire('pointerdown'); fire('pointerup'); return o.fillMessage;
    },
    /** Catmull-Rom through control points, n samples per segment; keeps optional pressure in [2] */
    curve(cp, n = 12) {
      const out = []; const P = cp;
      for (let i = 0; i < P.length - 1; i++) {
        const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
        for (let k = 0; k < n; k++) { const t = k / n, t2 = t * t, t3 = t2 * t;
          const f = (a, b, c, d) => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
          const pt = [f(p0[0], p1[0], p2[0], p3[0]), f(p0[1], p1[1], p2[1], p3[1])];
          if (p1[2] !== undefined && p2[2] !== undefined) pt.push(p1[2] + (p2[2] - p1[2]) * t);
          out.push(pt); }
      }
      out.push([...P[P.length - 1]]); return out;
    },
    ellipse(cx, cy, rx, ry, rot = 0, n = 48, a0 = 0, a1 = Math.PI * 2) {
      const out = []; const c = Math.cos(rot), s = Math.sin(rot);
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; const x = Math.cos(a) * rx, y = Math.sin(a) * ry; out.push([cx + x * c - y * s, cy + x * s + y * c]); }
      return out;
    },
    jitter(pts, amt) { return pts.map(([x, y, p]) => [x + (api.rnd() - 0.5) * amt, y + (api.rnd() - 0.5) * amt, p]); },
    /** tapered hair strand from a to b bending by `bend` (perpendicular, in px) */
    strand(a, b, bend, n = 14) { const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2; const dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; const nx = -dy / L, ny = dx / L; return api.curve([a, [mx + nx * bend, my + ny * bend], b], n); },
    async settle(ms = 30) { await new Promise((r) => setTimeout(r, ms)); },
    async export(id) {
      const bytes = await window.omniSerialize.serializeDoc(o.doc); let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const flat = o.renderer.flatten(o.doc, 0.4); const c = document.createElement('canvas'); c.width = flat.width; c.height = flat.height; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(flat, 0, 0);
      return { omni: btoa(bin), png: c.toDataURL('image/png'), id };
    },
  };
  window.art = api;
})();
