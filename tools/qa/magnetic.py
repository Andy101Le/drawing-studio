from playwright.sync_api import sync_playwright
import math
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    # a solid shape with a soft edge on a textured background: a disc at (1200,1400) r=500
    pg.evaluate("""() => { const o = window.omni; const l = o.doc.addLayer('raster'); l.name = 'Pic';
      for (const t of l.tilesIn(0, 0, o.doc.width, o.doc.height, true)) { const c = t.ctx; c.save(); c.translate(-t.x*256, -t.y*256);
        for (let i = 0; i < 400; i++) { c.fillStyle = `hsl(${200 + (i % 7) * 4}, 30%, ${55 + (i % 5) * 4}%)`; c.fillRect((i * 97) % 2480, (i * 61) % 3508, 120, 120); }
        c.fillStyle = '#7a2d1e'; c.beginPath(); c.arc(1200, 1400, 500, 0, Math.PI * 2); c.fill(); c.restore(); t.generation++; }
      o.doc.activeLayerId = l.id; o.emit('layers'); o.invalidate(); o.renderer.fitPage(o.doc); o.invalidate(); }""")
    pg.wait_for_timeout(500)
    box = pg.locator("#draw").bounding_box()
    scr = lambda x, y: pg.evaluate("([x,y]) => { const a = window.omni.renderer.docToScreen(x, y); return [a.x, a.y]; }", [x, y])
    def iou():
        return pg.evaluate("""() => { const o = window.omni; const s = o.selection; if (!s) return null; const d = s.ctx.getImageData(0, 0, s.width, s.height).data; let inter = 0, uni = 0;
          for (let y = 0; y < s.height; y += 2) for (let x = 0; x < s.width; x += 2) { const sel = d[(y * s.width + x) * 4 + 3] > 127; const disc = Math.hypot(x - 1200, y - 1400) <= 500; if (sel && disc) inter++; if (sel || disc) uni++; } return inter / uni; }""")
    # magnetic lasso: 8 clicks 40 px OUTSIDE the disc edge (sloppy), then Enter
    pg.keyboard.press("m"); pg.evaluate("() => { window.omni.selShape = 'magnetic'; window.omni.emit('tool'); }")
    import time; t0 = time.time()
    for k in range(8):
        a = k / 8 * 2 * math.pi; x = 1200 + 540 * math.cos(a); y = 1400 + 540 * math.sin(a); sx, sy = scr(x, y)
        pg.mouse.move(box["x"]+sx, box["y"]+sy); pg.wait_for_timeout(60); pg.mouse.click(box["x"]+sx, box["y"]+sy); pg.wait_for_timeout(120)
    pg.keyboard.press("Enter"); pg.wait_for_timeout(400)
    print("magnetic IoU vs disc (anchors 40 px outside):", round(iou(), 3), "in", round(time.time() - t0, 1), "s")
    # plain polygon for comparison with the same points
    pg.keyboard.press("Escape"); pg.evaluate("() => { const o = window.omni; const pts = []; for (let k = 0; k < 8; k++) { const a = k / 8 * 2 * Math.PI; pts.push({ x: 1200 + 540 * Math.cos(a), y: 1400 + 540 * Math.sin(a) }); } o.selection = null; }")
    # rough rect then Tighten
    pg.evaluate("() => { window.omni.selShape = 'rect'; window.omni.emit('tool'); }")
    s0 = scr(1200 - 560, 1400 - 560); s1 = scr(1200 + 560, 1400 + 560)
    pg.mouse.move(box["x"]+s0[0], box["y"]+s0[1]); pg.mouse.down(); pg.mouse.move(box["x"]+s1[0], box["y"]+s1[1], steps=5); pg.mouse.up(); pg.wait_for_timeout(300)
    print("rect IoU before tighten:", round(iou(), 3))
    t0 = time.time(); note = pg.evaluate("() => window.omni.select.tighten(0)"); print("tighten:", note, "| IoU after:", round(iou(), 3))
    note = pg.evaluate("() => window.omni.select.tighten(0)"); print("tighten again:", note, "| IoU:", round(iou(), 3))
    print("undo labels:", pg.evaluate("() => window.omni.history.labels.slice(-3)"))
    print("errors:", errs); b.close()
