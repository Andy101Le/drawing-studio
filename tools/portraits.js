// Five portraits built from shared parts. Doc is 2000x2000. Head centre (cx,cy), radius R.
(() => {
  const A = window.art; const o = window.omni;
  const INK = '#15120f';
  const head = { cx: 1000, cy: 880, R: 330 };

  // ---- parts ------------------------------------------------------------------------------
  function faceContour(h, ink, size = 9, tilt = 0) {
    const { cx, cy, R } = h; const t = tilt;
    const pts = A.curve([
      [cx - R * 0.98 + t * 40, cy - R * 0.25, 0.5], [cx - R * 0.95 + t * 30, cy + R * 0.25, 0.8], [cx - R * 0.78 + t * 20, cy + R * 0.72, 0.9],
      [cx - R * 0.4 + t * 10, cy + R * 1.04, 0.85], [cx + R * 0.05, cy + R * 1.14, 0.8], [cx + R * 0.5 - t * 10, cy + R * 1.0, 0.85],
      [cx + R * 0.86 - t * 20, cy + R * 0.6, 0.9], [cx + R * 0.97 - t * 30, cy + R * 0.15, 0.7], [cx + R * 0.98 - t * 40, cy - R * 0.25, 0.4]], 10);
    A.stroke('G-Pen', ink, size, pts);
  }
  function neckAndShoulders(h, ink, size = 8, collar = 'turtleneck') {
    const { cx, cy, R } = h; const y0 = cy + R * 1.05;
    A.stroke('G-Pen', ink, size, A.curve([[cx - R * 0.5, y0 - 30, 0.6], [cx - R * 0.52, y0 + R * 0.45, 0.8], [cx - R * 0.6, y0 + R * 0.7, 0.7]], 8));
    A.stroke('G-Pen', ink, size, A.curve([[cx + R * 0.46, y0 - 40, 0.6], [cx + R * 0.5, y0 + R * 0.45, 0.8], [cx + R * 0.6, y0 + R * 0.7, 0.7]], 8));
    const sy = y0 + R * 0.62;
    if (collar === 'turtleneck') {
      A.stroke('G-Pen', ink, size, A.curve([[cx - R * 0.72, sy + 20, 0.6], [cx - R * 0.3, sy - 30, 0.9], [cx + R * 0.3, sy - 30, 0.9], [cx + R * 0.72, sy + 20, 0.6]], 10));
      A.stroke('G-Pen', ink, size, A.curve([[cx - R * 0.72, sy + 40, 0.5], [cx, sy + 70, 0.8], [cx + R * 0.72, sy + 40, 0.5]], 10));
    } else if (collar === 'shirt') {
      A.stroke('G-Pen', ink, size, A.curve([[cx - R * 0.5, sy - 10, 0.6], [cx - R * 0.15, sy + 90, 0.9], [cx, sy + 40, 0.8]], 8));
      A.stroke('G-Pen', ink, size, A.curve([[cx + R * 0.5, sy - 10, 0.6], [cx + R * 0.15, sy + 90, 0.9], [cx, sy + 40, 0.8]], 8));
    }
    // shoulders out to the page edge
    A.stroke('G-Pen', ink, size, A.curve([[cx - R * 0.72, sy + 20, 0.5], [cx - R * 1.5, sy + R * 0.3, 0.9], [cx - R * 2.6, sy + R * 0.9, 0.9], [cx - R * 3.2, sy + R * 1.5, 0.7]], 10));
    A.stroke('G-Pen', ink, size, A.curve([[cx + R * 0.72, sy + 20, 0.5], [cx + R * 1.5, sy + R * 0.3, 0.9], [cx + R * 2.6, sy + R * 0.9, 0.9], [cx + R * 3.2, sy + R * 1.5, 0.7]], 10));
    return sy;
  }
  function eye(ex, ey, w, hgt, ink, opts = {}) {
    const dir = opts.dir ?? 1; // 1 = looks right
    // upper lid: thick, with a heavier outer third
    A.stroke('G-Pen', ink, opts.lid ?? 12, A.curve([[ex - w * 0.5, ey + hgt * 0.05, 0.35], [ex - w * 0.2, ey - hgt * 0.42, 0.8], [ex + w * 0.2, ey - hgt * 0.5, 1], [ex + w * 0.52, ey - hgt * 0.12, 0.9], [ex + w * 0.6, ey + hgt * 0.1, 0.4]], 8));
    // lower lid: light
    A.stroke('G-Pen', ink, 4, A.curve([[ex - w * 0.4, ey + hgt * 0.35, 0.3], [ex, ey + hgt * 0.5, 0.6], [ex + w * 0.45, ey + hgt * 0.3, 0.4]], 8));
    // lashes
    for (let i = 0; i < 3; i++) { const t = 0.35 + i * 0.12; const x = ex + w * t, y = ey - hgt * (0.5 - (t - 0.35) * 0.9); A.stroke('G-Pen', ink, 5, A.curve([[x, y, 0.9], [x + 18 + i * 4, y - 22 + i * 6, 0.2]], 6)); }
    // iris
    const ir = hgt * 0.55, ix = ex + dir * w * 0.06, iy = ey + hgt * 0.02;
    A.stroke('G-Pen', ink, 4, A.ellipse(ix, iy, ir * 0.78, ir, 0, 40), {}, () => 0.7);
    return { ix, iy, ir };
  }
  function eyeColour(e, base, dark, ink) {
    A.fill(e.ix, e.iy + e.ir * 0.3, base);
    A.stroke('Airbrush', dark, e.ir * 1.6, [[e.ix, e.iy - e.ir * 0.6], [e.ix, e.iy - e.ir * 0.2]], { opacity: 0.9 }, () => 0.8); // shadow of the lid on the iris
    A.stroke('Round Paint', ink, e.ir * 0.75, [[e.ix, e.iy - e.ir * 0.1], [e.ix, e.iy + e.ir * 0.1]], {}, () => 1); // pupil
  }
  function highlight(x, y, r) { A.stroke('Round Paint', '#ffffff', r, [[x, y], [x + r * 0.3, y + r * 0.2]], {}, () => 1); }
  function brow(bx, by, w, ink, size = 7, arch = 18) { A.stroke('G-Pen', ink, size, A.curve([[bx - w * 0.5, by + 6, 0.3], [bx - w * 0.1, by - arch, 0.9], [bx + w * 0.45, by - 4, 0.6], [bx + w * 0.55, by + 8, 0.2]], 8)); }
  function nose(x, y, ink) { A.stroke('G-Pen', ink, 5, A.curve([[x + 6, y - 40, 0.2], [x - 4, y + 10, 0.6], [x + 14, y + 22, 0.9], [x + 30, y + 10, 0.4]], 8)); }
  function mouth(x, y, w, ink, open = false) {
    A.stroke('G-Pen', ink, 6, A.curve([[x - w * 0.5, y - 4, 0.3], [x - w * 0.15, y + 6, 0.8], [x + w * 0.2, y + 5, 0.8], [x + w * 0.5, y - 8, 0.3]], 8));
    if (open) { A.stroke('G-Pen', ink, 4, A.curve([[x - w * 0.4, y + 2, 0.3], [x, y + 30, 0.7], [x + w * 0.42, y - 2, 0.3]], 8)); }
  }
  /** hair mass: outline polygon (closed) plus strands following the flow function */
  function hairMass(outline, ink, size = 8) { A.stroke('G-Pen', ink, size, A.curve([...outline, outline[0], outline[1]], 10), {}, () => 0.85); }
  function strands(list, ink, size = 5) { for (const s of list) A.stroke('G-Pen', ink, size, s, { taper: 30 }, (t) => Math.sin(Math.PI * t) ** 0.5); }

  // ---- shared shading --------------------------------------------------------------------
  function shade(h, skinShadow, items) {
    const { cx, cy, R } = h;
    // under the jaw / neck, under the bangs, eye sockets
    A.stroke('Airbrush', skinShadow, 130, [[cx - R * 0.45, cy + R * 1.2], [cx + R * 0.45, cy + R * 1.25]], { opacity: 0.8 }, () => 0.9);
    A.stroke('Airbrush', skinShadow, 110, [[cx - R * 0.35, cy + R * 1.4], [cx + R * 0.35, cy + R * 1.45]], { opacity: 0.8 }, () => 0.9);
    for (const it of items) A.stroke(it.preset ?? 'Airbrush', it.color ?? skinShadow, it.size ?? 90, it.pts, { opacity: it.opacity ?? 0.7 }, () => it.p ?? 0.8);
  }

  // ---- samples ---------------------------------------------------------------------------
  const samples = {
    'silver-glasses'() {
      A.seed(7); A.setup(2000, 2000);
      const flats = A.layer('Flats'); const shd = A.layer('Shade', { blend: 'multiply', clipBelow: true }); const ink = A.layer('Ink'); const hi = A.layer('Highlights');
      const h = { ...head }; const { cx, cy, R } = h;
      // background flat
      A.active(flats); A.stroke('Round Paint', '#d9d9dc', 2400, [[-200, 1000], [2200, 1000]], {}, () => 1);
      A.active(ink);
      faceContour(h, INK, 9); const sy = neckAndShoulders(h, INK, 8, 'turtleneck');
      A.stroke('G-Pen', INK, 6, [[-10, 1990], [2010, 1990]], {}, () => 0.8); A.stroke('G-Pen', INK, 6, [[5, 1200], [5, 1995]], {}, () => 0.8); A.stroke('G-Pen', INK, 6, [[1995, 1200], [1995, 1995]], {}, () => 0.8);
      // bob hair: big mass with ragged tips
      const out = [[cx - R * 1.35, cy + R * 0.55], [cx - R * 1.3, cy - R * 0.3], [cx - R * 1.0, cy - R * 1.05], [cx - R * 0.35, cy - R * 1.4], [cx + R * 0.4, cy - R * 1.38], [cx + R * 1.05, cy - R * 1.0], [cx + R * 1.3, cy - R * 0.2], [cx + R * 1.25, cy + R * 0.5], [cx + R * 1.0, cy + R * 0.95]];
      hairMass(out, INK, 7);
      // ragged bottom edge: zigzag tips left and right
      const tips = []; for (let i = 0; i < 9; i++) { const x = cx - R * 1.35 + i * R * 0.11; tips.push([x, cy + R * (0.5 + (i % 2) * 0.22) + A.rnd() * 30]); } A.stroke('G-Pen', INK, 7, A.curve(tips, 6), {}, () => 0.8);
      const tipsR = []; for (let i = 0; i < 6; i++) { const x = cx + R * 0.65 + i * R * 0.12; tipsR.push([x, cy + R * (0.95 - (i % 2) * 0.2) - i * 20]); } A.stroke('G-Pen', INK, 7, A.curve(tipsR, 6), {}, () => 0.8);
      // bangs: strands falling over the forehead to the eyes
      const bangs = []; for (let i = 0; i < 16; i++) { const t = i / 15; const x0 = cx - R * 0.95 + t * R * 1.9; const x1 = x0 + (t - 0.5) * R * 0.5 + (A.rnd() - 0.5) * 50; const y1 = cy - R * (0.05 - Math.abs(t - 0.5) * 0.25) + A.rnd() * 60; bangs.push(A.strand([x0 + (A.rnd() - 0.5) * 30, cy - R * 1.1 + Math.abs(t - 0.5) * R * 0.3], [x1, y1], (A.rnd() - 0.5) * 60, 10)); }
      strands(bangs, INK, 6);
      // side strands and texture inside the mass
      const tex = []; for (let i = 0; i < 40; i++) { const side = i % 2 ? 1 : -1; const y0 = cy - R * (0.9 - A.rnd() * 0.5), y1 = cy + R * (0.2 + A.rnd() * 0.5); const x0 = cx + side * R * (0.5 + A.rnd() * 0.6), x1 = x0 + side * R * (0.3 + A.rnd() * 0.35); tex.push(A.strand([x0, y0], [x1, y1], side * (20 + A.rnd() * 60), 10)); }
      strands(tex, INK, 4);
      // eyes behind the glasses
      const eL = eye(cx - R * 0.42, cy + R * 0.12, R * 0.42, R * 0.2, INK, { dir: 1 }), eR = eye(cx + R * 0.46, cy + R * 0.08, R * 0.42, R * 0.2, INK, { dir: 1 });
      brow(cx - R * 0.42, cy - R * 0.2, R * 0.4, INK); brow(cx + R * 0.46, cy - R * 0.24, R * 0.4, INK);
      nose(cx + R * 0.02, cy + R * 0.55, INK); mouth(cx + R * 0.05, cy + R * 0.82, R * 0.36, INK, true);
      // glasses: two rounded rectangles and a bridge, in red
      const frame = (fx, fy, w, hh) => { const r = 40; const pts = [[fx - w / 2 + r, fy - hh / 2], [fx + w / 2 - r, fy - hh / 2], [fx + w / 2, fy - hh / 2 + r], [fx + w / 2, fy + hh / 2 - r], [fx + w / 2 - r, fy + hh / 2], [fx - w / 2 + r, fy + hh / 2], [fx - w / 2, fy + hh / 2 - r], [fx - w / 2, fy - hh / 2 + r]]; A.stroke('G-Pen', '#b8321c', 14, A.curve([...pts, pts[0], pts[1]], 8), {}, () => 0.95); };
      frame(cx - R * 0.44, cy + R * 0.14, R * 0.72, R * 0.46); frame(cx + R * 0.48, cy + R * 0.1, R * 0.72, R * 0.46);
      A.stroke('G-Pen', '#b8321c', 10, [[cx - R * 0.08, cy + R * 0.03], [cx + R * 0.12, cy + R * 0.0]], {}, () => 0.9);
      A.stroke('G-Pen', '#b8321c', 10, [[cx + R * 0.84, cy + R * 0.05], [cx + R * 1.15, cy - R * 0.05]], {}, () => 0.9);
      // cross pendant held at the lips, and a chain
      A.stroke('G-Pen', INK, 7, A.curve([[cx + R * 0.1, cy + R * 0.9, 0.8], [cx - R * 0.12, cy + R * 1.35, 0.8]], 6)); A.stroke('G-Pen', INK, 7, A.curve([[cx - R * 0.12, cy + R * 1.05, 0.8], [cx + R * 0.1, cy + R * 1.18, 0.8]], 6));
      A.stroke('G-Pen', INK, 4, A.jitter(A.curve([[cx - R * 0.1, cy + R * 1.35], [cx - R * 0.3, sy + 120], [cx - R * 0.5, sy + 400]], 10), 6), {}, () => 0.6);
      A.stroke('G-Pen', INK, 4, A.jitter(A.curve([[cx + R * 0.0, cy + R * 1.35], [cx + R * 0.35, sy + 150], [cx + R * 0.6, sy + 420]], 10), 6), {}, () => 0.6);
      // flats
      A.active(flats);
      A.fill(cx, cy + R * 0.6, '#f0d6c2'); A.fill(cx - R * 0.6, cy - R * 0.8, '#b9bcc3'); A.fill(cx, sy + 150, '#17171a'); A.fill(cx - R * 2.2, sy + R * 1.2, '#17171a'); A.fill(cx + R * 2.2, sy + R * 1.2, '#17171a');
      
      eyeColour(eL, '#6b6d5a', '#2d2f24', INK); eyeColour(eR, '#6b6d5a', '#2d2f24', INK);
      // shading
      A.active(shd); shade(h, '#d9a989', [{ pts: [[cx - R * 0.9, cy - R * 0.1], [cx + R * 0.9, cy - R * 0.2]], size: 120, opacity: 0.6 }, { color: '#8e9299', pts: [[cx - R * 1.1, cy - R * 0.2], [cx - R * 0.9, cy + R * 0.4]], size: 140 }, { color: '#8e9299', pts: [[cx + R * 0.9, cy - R * 0.6], [cx + R * 1.1, cy + R * 0.3]], size: 140 }]);
      A.active(hi); highlight(eL.ix - eL.ir * 0.35, eL.iy - eL.ir * 0.35, 22); highlight(eR.ix - eR.ir * 0.35, eR.iy - eR.ir * 0.35, 22);
      for (let i = 0; i < 12; i++) A.stroke('G-Pen', '#f4f4f6', 5, A.strand([cx - R * 0.7 + i * R * 0.12, cy - R * 1.0], [cx - R * 0.75 + i * R * 0.12, cy - R * 0.55], (A.rnd() - 0.5) * 20, 6), { taper: 20 }, (t) => Math.sin(Math.PI * t));
    },
    'braids-phone'() {
      A.seed(11); A.setup(2000, 2000);
      const flats = A.layer('Flats'); const shd = A.layer('Shade', { blend: 'multiply', clipBelow: true }); const ink = A.layer('Ink');
      const h = { cx: 1060, cy: 820, R: 320 }; const { cx, cy, R } = h;
      A.active(flats); A.stroke('Round Paint', '#d7dde8', 2400, [[-200, 1000], [2200, 1000]], {}, () => 1);
      A.active(ink);
      faceContour(h, INK, 8, 0.6); const sy = neckAndShoulders(h, INK, 7, 'shirt');
      // hair pulled back with braids: smooth cap + a few braid ropes on the right
      const out = [[cx - R * 1.05, cy + R * 0.1], [cx - R * 1.0, cy - R * 0.6], [cx - R * 0.6, cy - R * 1.18], [cx + R * 0.2, cy - R * 1.3], [cx + R * 0.95, cy - R * 1.0], [cx + R * 1.15, cy - R * 0.35], [cx + R * 1.05, cy + R * 0.3]];
      hairMass(out, INK, 7);
      const tex = []; for (let i = 0; i < 26; i++) { const t = i / 25; tex.push(A.strand([cx - R * 0.9 + t * R * 1.8, cy - R * (1.2 - Math.abs(t - 0.5) * 0.5)], [cx + R * 0.9, cy - R * 0.3 + t * R * 0.4], -40 + t * 80, 10)); } strands(tex, INK, 4);
      // braids: chains of small ellipses
      for (let b = 0; b < 2; b++) { const bx = cx + R * (1.05 + b * 0.18), by = cy - R * 0.5; for (let i = 0; i < 7; i++) { A.stroke('G-Pen', INK, 5, A.ellipse(bx + Math.sin(i) * 12 - b * 10 + i * 6, by + i * 48, 22, 26, 0.4, 20), {}, () => 0.8); } }
      // fringe at the forehead
      const bangs = []; for (let i = 0; i < 9; i++) { const t = i / 8; bangs.push(A.strand([cx - R * 0.7 + t * R * 1.2, cy - R * 0.95], [cx - R * 0.8 + t * R * 1.3 + (A.rnd() - 0.5) * 40, cy - R * (0.45 - A.rnd() * 0.2)], (A.rnd() - 0.5) * 40, 8)); } strands(bangs, INK, 5);
      const eL = eye(cx - R * 0.35, cy + R * 0.1, R * 0.36, R * 0.2, INK, { lid: 10 }), eR = eye(cx + R * 0.44, cy + R * 0.06, R * 0.4, R * 0.22, INK, { lid: 11 });
      brow(cx - R * 0.35, cy - R * 0.2, R * 0.36, INK, 6, 12); brow(cx + R * 0.44, cy - R * 0.24, R * 0.38, INK, 6, 14);
      nose(cx + R * 0.1, cy + R * 0.5, INK); mouth(cx + R * 0.12, cy + R * 0.8, R * 0.3, INK, false);
      // hoop earring
      A.stroke('G-Pen', '#a8362a', 10, A.ellipse(cx + R * 1.22, cy + R * 0.62, R * 0.2, R * 0.26, 0, 40), {}, () => 0.9);
      // hand holding a flip phone at the left temple
      const px = cx - R * 1.35, py = cy - R * 0.15;
      A.stroke('G-Pen', INK, 7, A.curve([[px - 60, py - 230, 0.8], [px + 110, py - 260, 0.8], [px + 150, py + 20, 0.8], [px - 20, py + 50, 0.8], [px - 60, py - 230, 0.8]], 8)); // upper half
      A.stroke('G-Pen', INK, 7, A.curve([[px - 20, py + 50, 0.8], [px + 150, py + 20, 0.8], [px + 170, py + 300, 0.8], [px + 10, py + 330, 0.8], [px - 20, py + 50, 0.8]], 8)); // lower half
      for (let i = 0; i < 4; i++) A.stroke('G-Pen', INK, 4, [[px + 10, py - 190 + i * 40], [px + 100, py - 200 + i * 40]], {}, () => 0.5); // text lines
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) A.stroke('G-Pen', INK, 4, A.ellipse(px + 40 + c * 36, py + 120 + r * 48, 12, 14, 0, 12), {}, () => 0.6); // keys
      // fingers over the phone and the forearm with bracelets
      A.stroke('G-Pen', INK, 7, A.curve([[px + 150, py - 150, 0.7], [px + 230, py - 120, 0.9], [px + 240, py + 30, 0.9], [px + 160, py + 50, 0.7]], 8));
      A.stroke('G-Pen', INK, 7, A.curve([[px + 10, py + 330, 0.7], [px - 60, py + 520, 0.9], [px - 90, py + 760, 0.8]], 8)); A.stroke('G-Pen', INK, 7, A.curve([[px + 170, py + 300, 0.7], [px + 150, py + 520, 0.9], [px + 110, py + 760, 0.8]], 8));
      for (let i = 0; i < 3; i++) A.stroke('G-Pen', ['#8a3a2a', '#c9b07e', '#b8b8b8'][i], 10, A.curve([[px - 60 + i * 8, py + 480 + i * 60, 0.8], [px + 50, py + 520 + i * 60, 0.9], [px + 150 - i * 8, py + 470 + i * 60, 0.8]], 8));
      // flats
      A.active(flats);
      A.fill(cx, cy + R * 0.6, '#f1d2b8'); A.fill(cx, cy - R * 0.9, '#7a4a2c'); A.fill(cx, sy + 200, '#f3f3f6'); A.fill(cx - R * 2.3, sy + R * 1.3, '#f3f3f6'); A.fill(cx + R * 2.3, sy + R * 1.3, '#f3f3f6');
      A.fill(px + 50, py - 100, '#e9b9d8'); A.fill(px + 70, py + 200, '#e9b9d8'); A.fill(px + 190, py - 40, '#f1d2b8'); A.fill(px + 30, py + 600, '#f1d2b8');
      eyeColour(eL, '#5a4a3c', '#2b241d', INK); eyeColour(eR, '#5a4a3c', '#2b241d', INK);
      A.active(shd); shade(h, '#d9a28a', [{ pts: [[cx - R * 0.8, cy - R * 0.3], [cx + R * 0.8, cy - R * 0.4]], size: 120, opacity: 0.55 }, { color: '#9aa4b8', pts: [[cx - R * 0.6, sy + 250], [cx - R * 0.2, sy + 700]], size: 200, opacity: 0.6 }, { color: '#9aa4b8', pts: [[cx + R * 0.9, sy + 200], [cx + R * 1.4, sy + 700]], size: 220, opacity: 0.6 }]);
      A.active(ink); highlight(eL.ix - eL.ir * 0.3, eL.iy - eL.ir * 0.35, 18); highlight(eR.ix - eR.ir * 0.3, eR.iy - eR.ir * 0.35, 20);
    },
    'red-camera'() {
      A.seed(23); A.setup(2000, 2000);
      const flats = A.layer('Flats'); const shd = A.layer('Shade', { blend: 'multiply', clipBelow: true }); const ink = A.layer('Ink');
      const h = { cx: 900, cy: 700, R: 400 }; const { cx, cy, R } = h;
      A.active(flats); A.stroke('Round Paint', '#f3ead3', 2400, [[-200, 1000], [2200, 1000]], {}, () => 1);
      A.active(ink);
      faceContour(h, INK, 11, -0.3);
      // big soft hair falling straight, covering the sides
      const out = [[cx - R * 1.3, cy + R * 1.6], [cx - R * 1.25, cy - R * 0.2], [cx - R * 0.9, cy - R * 1.1], [cx - R * 0.1, cy - R * 1.45], [cx + R * 0.7, cy - R * 1.3], [cx + R * 1.25, cy - R * 0.6], [cx + R * 1.35, cy + R * 0.4], [cx + R * 1.4, cy + R * 1.6]];
      hairMass(out, INK, 10);
      const bangs = []; for (let i = 0; i < 12; i++) { const t = i / 11; bangs.push(A.strand([cx - R * 0.9 + t * R * 1.7, cy - R * 1.2 + Math.abs(t - 0.5) * R * 0.2], [cx - R * 0.95 + t * R * 1.9 + (A.rnd() - 0.5) * 40, cy - R * (0.55 - Math.abs(t - 0.45) * 0.25) + A.rnd() * 50], (t - 0.5) * 80, 10)); } strands(bangs, INK, 8);
      const tex = []; for (let i = 0; i < 24; i++) { const side = i % 2 ? 1 : -1; tex.push(A.strand([cx + side * R * (0.9 + A.rnd() * 0.3), cy - R * (0.6 - A.rnd() * 0.4)], [cx + side * R * (1.0 + A.rnd() * 0.3), cy + R * (0.6 + A.rnd() * 0.9)], side * (A.rnd() - 0.5) * 60, 10)); } strands(tex, INK, 6);
      // big round eyes looking up-left
      const eL = eye(cx - R * 0.42, cy + R * 0.02, R * 0.5, R * 0.3, INK, { lid: 14, dir: -1 }), eR = eye(cx + R * 0.42, cy - R * 0.02, R * 0.5, R * 0.3, INK, { lid: 14, dir: -1 });
      brow(cx - R * 0.42, cy - R * 0.36, R * 0.45, INK, 8, 10); brow(cx + R * 0.42, cy - R * 0.4, R * 0.45, INK, 8, 10);
      nose(cx + R * 0.0, cy + R * 0.5, INK); mouth(cx, cy + R * 0.78, R * 0.25, INK, false);
      // compact camera held up in front of the chin, hand on the left
      const kx = 760, ky = 1380, kw = 920, kh = 520;
      const box = [[kx - kw / 2, ky - kh / 2], [kx + kw / 2, ky - kh / 2], [kx + kw / 2, ky + kh / 2], [kx - kw / 2, ky + kh / 2]];
      A.stroke('G-Pen', INK, 11, A.curve([...box, box[0], box[1]], 6), {}, () => 0.95);
      A.stroke('G-Pen', INK, 9, A.ellipse(kx - 80, ky + 60, 150, 150, 0, 48), {}, () => 0.9); A.stroke('G-Pen', INK, 7, A.ellipse(kx - 80, ky + 60, 105, 105, 0, 40), {}, () => 0.9); A.stroke('G-Pen', INK, 6, A.ellipse(kx - 80, ky + 60, 60, 60, 0, 32), {}, () => 0.9);
      A.stroke('G-Pen', INK, 8, A.curve([[kx - 10, ky - 180], [kx + 170, ky - 180], [kx + 170, ky - 60], [kx - 10, ky - 60], [kx - 10, ky - 180], [kx + 170, ky - 180]], 6), {}, () => 0.9); // viewfinder
      A.stroke('G-Pen', INK, 7, A.ellipse(kx - 330, ky - 160, 26, 26, 0, 24), {}, () => 0.9); // shutter
      for (let i = 0; i < 10; i++) A.stroke('G-Pen', INK, 4, [[kx - kw / 2 + 60 + i * 80, ky - kh / 2 + 20], [kx - kw / 2 + 60 + i * 80, ky - kh / 2 + 90]], {}, () => 0.5); // grip ridges
      // fingers over the top edge
      for (let i = 0; i < 3; i++) A.stroke('G-Pen', INK, 8, A.curve([[kx - kw / 2 - 60 + i * 90, ky - kh / 2 + 10, 0.6], [kx - kw / 2 - 40 + i * 90, ky - kh / 2 - 140, 0.9], [kx - kw / 2 + 30 + i * 90, ky - kh / 2 - 150, 0.8], [kx - kw / 2 + 50 + i * 90, ky - kh / 2 + 10, 0.6]], 8));
      A.stroke('G-Pen', INK, 9, A.curve([[kx - kw / 2 - 60, ky - kh / 2 + 10, 0.7], [kx - kw / 2 - 180, ky + 100, 0.9], [kx - kw / 2 - 200, ky + 400, 0.8]], 8));
      // cat peeking at the right edge
      const catx = 1760, caty = 1420;
      A.stroke('G-Pen', INK, 10, A.curve([[catx - 160, caty + 400, 0.8], [catx - 170, caty, 0.9], [catx - 120, caty - 220, 0.9], [catx - 60, caty - 160, 0.9], [catx + 40, caty - 170, 0.9], [catx + 110, caty - 250, 0.9], [catx + 170, caty - 50, 0.9], [catx + 200, caty + 400, 0.8]], 8));
      A.stroke('G-Pen', INK, 8, A.ellipse(catx - 60, caty + 20, 60, 70, 0, 32), {}, () => 0.9); A.stroke('G-Pen', INK, 8, A.ellipse(catx + 100, caty + 10, 60, 70, 0, 32), {}, () => 0.9);
      // flats
      A.active(flats);
      A.fill(cx, cy + R * 0.6, '#f6e3d2'); A.fill(cx, cy - R * 0.9, '#c8343c'); A.fill(cx - R * 1.1, cy + R * 0.8, '#c8343c'); A.fill(cx + R * 1.2, cy + R * 0.8, '#c8343c');
      A.fill(kx + 200, ky + 100, '#d8d0bc'); A.fill(kx - 80, ky + 60, '#2a2a2a'); A.fill(kx + 80, ky - 120, '#1d1d1d'); A.fill(kx - 330, ky - 160, '#b8352c');
      A.fill(catx, caty + 150, '#161616'); A.fill(catx - 60, caty + 20, '#f5f1e0'); A.fill(catx + 100, caty + 10, '#f5f1e0');
      A.fill(kx - kw / 2 - 20, ky - kh / 2 - 90, '#f6e3d2'); A.fill(kx - kw / 2 - 150, ky + 250, '#f6e3d2');
      A.fill(400, 1850, '#2f5fa8'); A.fill(1500, 1900, '#2f5fa8');
      eyeColour(eL, '#c0702a', '#5a2d10', INK); eyeColour(eR, '#c0702a', '#5a2d10', INK);
      A.active(shd); shade(h, '#e0b49a', [{ pts: [[cx - R * 0.9, cy - R * 0.4], [cx + R * 0.9, cy - R * 0.5]], size: 150, opacity: 0.5 }, { color: '#7a1f27', pts: [[cx - R * 1.15, cy], [cx - R * 1.1, cy + R * 1.3]], size: 160 }, { color: '#7a1f27', pts: [[cx + R * 1.2, cy - R * 0.2], [cx + R * 1.25, cy + R * 1.3]], size: 160 }]);
      A.active(ink); highlight(eL.ix - eL.ir * 0.35, eL.iy - eL.ir * 0.4, 30); highlight(eR.ix - eR.ir * 0.35, eR.iy - eR.ir * 0.4, 30);
      A.stroke('Round Paint', INK, 70, [[catx - 60, caty + 30], [catx - 55, caty + 35]], {}, () => 1); A.stroke('Round Paint', INK, 70, [[catx + 100, caty + 20], [catx + 105, caty + 25]], {}, () => 1);
    },
    'watercolour-smoke'() {
      A.seed(31); A.setup(2000, 2000);
      const wash = A.layer('Wash'); const sketch = A.layer('Sketch', { opacity: 0.55 }); const ink = A.layer('Ink');
      const h = { cx: 1180, cy: 720, R: 300 }; const { cx, cy, R } = h;
      // wet background: cool grey-blue wash with granulation, darker at the left
      A.active(wash);
      for (let i = 0; i < 9; i++) A.stroke('Granulating', i < 4 ? '#5e6a78' : '#9aa3ad', 260, [[-100, 150 + i * 220], [2100, 120 + i * 220]], {}, () => 0.9);
      for (let i = 0; i < 5; i++) A.stroke('Wet-in-Wet', '#3b3f45', 240, [[-100 + i * 60, 200 + i * 320], [700, 300 + i * 320]], {}, () => 0.85);
      // warm skin wash and hair wash
      A.stroke('Flat Wash', '#f2cdb9', 320, A.curve([[cx - R * 0.6, cy - R * 0.6], [cx, cy + R * 0.4], [cx + R * 0.3, cy + R * 1.4]], 10), {}, () => 0.9);
      A.stroke('Wet-on-Dry', '#d9898a', 140, [[cx - R * 0.5, cy + R * 0.55], [cx + R * 0.55, cy + R * 0.6]], {}, () => 0.8);
      for (let i = 0; i < 8; i++) A.stroke('Graded Wash', '#8c8676', 150, A.curve([[cx - R * 1.1 + i * R * 0.3, cy - R * 1.2], [cx - R * 1.2 + i * R * 0.3, cy + R * 1.0], [cx - R * 1.15 + i * R * 0.3, cy + R * 2.4]], 10), {}, () => 0.9);
      A.stroke('Flat Wash', '#f4f1ea', 420, [[cx - R * 1.2, cy + R * 2.3], [cx + R * 1.6, cy + R * 2.5]], {}, () => 0.8); // white t-shirt
      // sketch layer: loose pencil construction
      A.active(sketch);
      A.stroke('Pencil 2B', '#3a3a3a', 6, A.jitter(A.ellipse(cx, cy + R * 0.1, R * 0.95, R * 1.1, 0, 60), 8), {}, () => 0.6);
      // ink: long straight hair, half-lidded eyes, cigarette, hand with camera
      A.active(ink);
      faceContour(h, '#2b2a28', 7, -0.4);
      for (let i = 0; i < 34; i++) { const t = i / 33; const x0 = cx - R * 1.15 + t * R * 2.4; A.stroke('G-Pen', '#2b2a28', 5, A.strand([x0, cy - R * 1.15 + Math.abs(t - 0.5) * R * 0.35], [x0 + (t - 0.5) * R * 0.5 + (A.rnd() - 0.5) * 40, cy + R * (1.6 + A.rnd() * 0.9)], (t - 0.5) * 50, 14), { taper: 40 }, (q) => 0.4 + 0.5 * Math.sin(Math.PI * q)); }
      A.stroke('G-Pen', '#2b2a28', 7, A.curve([[cx - R * 1.1, cy - R * 0.55], [cx - R * 0.6, cy - R * 1.15], [cx + R * 0.3, cy - R * 1.3], [cx + R * 1.1, cy - R * 0.9], [cx + R * 1.25, cy - R * 0.3]], 10), {}, () => 0.8);
      // heavy-lidded eyes: straight upper lid, small iris
      for (const s of [-1, 1]) { const ex = cx + s * R * 0.4, ey = cy + R * 0.08; A.stroke('G-Pen', '#2b2a28', 10, A.curve([[ex - R * 0.22, ey - 6, 0.5], [ex, ey - 14, 1], [ex + R * 0.24, ey + 2, 0.6]], 8)); A.stroke('G-Pen', '#2b2a28', 4, A.curve([[ex - R * 0.18, ey + R * 0.1, 0.3], [ex, ey + R * 0.13, 0.6], [ex + R * 0.2, ey + R * 0.09, 0.3]], 8)); A.stroke('Round Paint', '#2b2a28', 34, [[ex + s * 10, ey + 20], [ex + s * 12, ey + 24]], {}, () => 1); A.stroke('G-Pen', '#2b2a28', 5, A.curve([[ex - R * 0.22, ey - R * 0.3, 0.3], [ex + R * 0.05, ey - R * 0.36, 0.8], [ex + R * 0.26, ey - R * 0.28, 0.3]], 8)); }
      A.stroke('G-Pen', '#2b2a28', 5, A.curve([[cx - 10, cy + R * 0.3, 0.2], [cx - 20, cy + R * 0.55, 0.7], [cx + 10, cy + R * 0.62, 0.5]], 8));
      A.stroke('G-Pen', '#2b2a28', 6, A.curve([[cx - R * 0.2, cy + R * 0.85, 0.3], [cx, cy + R * 0.9, 0.8], [cx + R * 0.2, cy + R * 0.83, 0.3]], 8));
      A.stroke('G-Pen', '#2b2a28', 7, [[cx - R * 0.05, cy + R * 0.9], [cx - R * 0.6, cy + R * 0.95]], {}, () => 0.8); A.stroke('G-Pen', '#d8432c', 16, [[cx - R * 0.6, cy + R * 0.95], [cx - R * 0.66, cy + R * 0.955]], {}, () => 1); // cigarette
      for (let i = 0; i < 4; i++) A.stroke('Airbrush', '#c8ccd2', 60 + i * 30, A.curve([[cx - R * 0.7, cy + R * 0.9 - i * 90], [cx - R * (0.9 + i * 0.1), cy + R * 0.5 - i * 140], [cx - R * 0.8, cy - i * 160]], 10), { opacity: 0.5 }, () => 0.6); // smoke
      // freckles
      for (let i = 0; i < 14; i++) A.stroke('Round Paint', '#b56c5c', 7, [[cx - R * 0.35 + A.rnd() * R * 0.7, cy + R * 0.3 + A.rnd() * R * 0.25]], {}, () => 0.8);
      // hand holding a small green camera at chest height
      const kx = 760, ky = 1420;
      A.stroke('G-Pen', '#2b2a28', 7, A.curve([[kx - 140, ky - 60], [kx + 140, ky - 70], [kx + 150, ky + 120], [kx - 130, ky + 130], [kx - 140, ky - 60], [kx + 140, ky - 70]], 6), {}, () => 0.85);
      A.stroke('G-Pen', '#2b2a28', 6, A.ellipse(kx - 20, ky - 110, 70, 60, 0, 32), {}, () => 0.85); A.stroke('G-Pen', '#2b2a28', 5, A.ellipse(kx - 20, ky - 110, 40, 34, 0, 24), {}, () => 0.85);
      for (let i = 0; i < 4; i++) A.stroke('G-Pen', '#2b2a28', 7, A.curve([[kx - 150 + i * 80, ky + 120, 0.6], [kx - 170 + i * 80, ky + 250, 0.9], [kx - 110 + i * 80, ky + 280, 0.7]], 8));
      A.stroke('G-Pen', '#2b2a28', 7, A.curve([[kx + 150, ky + 60, 0.6], [kx + 240, ky + 220, 0.9], [kx + 200, ky + 520, 0.8]], 8));
      A.active(wash); A.stroke('Wet-on-Dry', '#4f7a3c', 150, [[kx - 100, ky + 30], [kx + 100, ky + 20]], {}, () => 0.9); A.stroke('Flat Wash', '#f2cdb9', 170, A.curve([[kx - 120, ky + 220], [kx + 100, ky + 230], [kx + 220, ky + 400]], 8), {}, () => 0.8);
      A.stroke('Lift Out', '#000', 80, A.curve([[cx - R * 0.3, cy + R * 0.1], [cx + R * 0.2, cy + R * 0.0]], 6), {}, () => 0.9);
    },
    'theatre-red'() {
      A.seed(41); A.setup(2000, 2000);
      const ground = A.layer('Ground'); const seats = A.layer('Seats'); const figure = A.layer('Figure'); const ink = A.layer('Ink');
      // dark scumbled ground
      A.active(ground); A.stroke('Round Paint', '#0e1210', 2400, [[-200, 1000], [2200, 1000]], {}, () => 1);
      for (let i = 0; i < 40; i++) A.stroke('Scumble', ['#16221a', '#1d2a22', '#0b0f0d'][i % 3], 220, A.jitter(A.curve([[A.rnd() * 2000, A.rnd() * 2000], [A.rnd() * 2000, A.rnd() * 2000]], 10), 40), {}, () => 0.7);
      // rows of red seats: flat bristle blocks, lit from the top left
      A.active(seats);
      const seat = (x, y, w, hh, tone) => { for (let r = 0; r < 5; r++) A.stroke('Acrylic Flat Bristle', tone, hh / 4.2, [[x - w / 2, y - hh / 2 + r * hh / 4.5], [x + w / 2, y - hh / 2 + r * hh / 4.5]], { opacity: 0.95 }, () => 0.9); A.stroke('Acrylic Round', '#5a1216', hh * 0.2, [[x - w / 2, y + hh / 2], [x + w / 2, y + hh / 2]], { opacity: 0.8 }, () => 0.9); };
      for (let row = 0; row < 4; row++) for (let c = -1; c < 4; c++) { const x = 220 + c * 460 + row * 90, y = 260 + row * 330; seat(x, y, 380 - row * 20, 300 - row * 10, ['#b8232b', '#a81f27', '#c0282f', '#9a1d24'][(row + c + 4) % 4]); }
      // figure: seated, dark jacket and trousers, white shirt, red tie
      A.active(figure);
      const px = 1060, py = 560, R = 190;
      A.stroke('Acrylic Round', '#262522', 200, A.curve([[px - 160, py + 300], [px - 120, py + 620], [px + 80, py + 700], [px + 300, py + 520]], 10), {}, () => 1); // jacket mass
      A.stroke('Acrylic Round', '#262522', 180, A.curve([[px + 60, py + 320], [px + 320, py + 400], [px + 420, py + 640]], 8), {}, () => 1); // arm on the seat
      A.stroke('Acrylic Round', '#1c1b19', 220, A.curve([[px - 200, py + 700], [px - 500, py + 980], [px - 700, py + 1260]], 10), {}, () => 1); // trouser leg out to the left
      A.stroke('Acrylic Round', '#1c1b19', 230, A.curve([[px + 60, py + 760], [px + 180, py + 1100], [px + 60, py + 1420]], 10), {}, () => 1);
      A.stroke('Acrylic Round', '#f1efe8', 90, A.curve([[px - 40, py + 320], [px - 10, py + 520], [px + 40, py + 620]], 8), {}, () => 1); // shirt
      A.stroke('Acrylic Round', '#9c1f24', 52, A.curve([[px + 10, py + 360], [px - 30, py + 540], [px, py + 680]], 8), {}, () => 1); // tie
      A.stroke('Acrylic Round', '#f0d9c4', 150, [[px - 10, py + 60], [px + 10, py + 220]], {}, () => 1); // face mass
      A.stroke('Acrylic Round', '#f0d9c4', 70, A.curve([[px + 120, py + 340], [px + 90, py + 240], [px + 40, py + 210]], 8), {}, () => 1); // hand at the mouth
      A.stroke('Acrylic Round', '#15130f', 170, A.curve([[px - 150, py + 120], [px - 60, py - 120], [px + 140, py - 110], [px + 200, py + 120]], 10), {}, () => 1); // hair cap
      // socks with a diamond pattern, shoes
      A.stroke('Acrylic Round', '#5b2b2a', 80, A.curve([[px - 560, py + 1080], [px - 660, py + 1220]], 6), {}, () => 1);
      for (let i = 0; i < 8; i++) A.stroke('Paint Pen', '#caa95c', 6, [[px - 600 + i * 12 - (i % 2) * 20, py + 1120 + i * 14], [px - 580 + i * 12, py + 1140 + i * 14]], {}, () => 1);
      A.stroke('Acrylic Round', '#101010', 110, A.curve([[px - 700, py + 1260], [px - 880, py + 1330]], 6), {}, () => 1);
      // ink: minimal lines on the face
      A.active(ink);
      const h = { cx: px, cy: py + 120, R };
      for (const s of [-1, 1]) { const ex = px + s * 60, ey = py + 150; A.stroke('G-Pen', '#1a1612', 7, A.curve([[ex - 36, ey, 0.4], [ex, ey - 12, 0.9], [ex + 38, ey + 4, 0.4]], 8)); A.stroke('Round Paint', '#3b4a6a', 30, [[ex + 4, ey + 10], [ex + 6, ey + 12]], {}, () => 1); A.stroke('Round Paint', '#101418', 16, [[ex + 4, ey + 10], [ex + 6, ey + 12]], {}, () => 1); A.stroke('G-Pen', '#1a1612', 5, A.curve([[ex - 40, ey - 44, 0.3], [ex + 2, ey - 56, 0.8], [ex + 42, ey - 42, 0.3]], 8)); }
      A.stroke('G-Pen', '#1a1612', 6, A.curve([[px + 70, py + 20, 0.5], [px + 40, py + 100, 0.9], [px + 90, py + 160, 0.6]], 8)); // hair edge over the eye
      A.stroke('G-Pen', '#1a1612', 5, A.curve([[px - 150, py + 120, 0.5], [px - 170, py + 200, 0.9], [px - 120, py + 290, 0.7], [px - 40, py + 330, 0.6]], 8)); // jaw
      A.stroke('G-Pen', '#1a1612', 5, A.curve([[px + 10, py + 230, 0.3], [px + 2, py + 262, 0.8], [px + 28, py + 268, 0.4]], 8)); // nose
      A.stroke('G-Pen', '#b9d3df', 4, A.curve([[px + 70, py + 40], [px + 110, py + 36], [px + 112, py + 60], [px + 72, py + 64]], 6), {}, () => 0.8); // hair clip
      for (let i = 0; i < 6; i++) A.stroke('Paint Pen', '#d7b25a', 4, [[px - 30 + (i % 3) * 20, py + 400 + i * 40], [px - 26 + (i % 3) * 20, py + 404 + i * 40]], {}, () => 1); // tie pattern
    },
  };
  window.drawSample = (id) => { samples[id](); };
})();
