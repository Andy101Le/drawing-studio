from playwright.sync_api import sync_playwright
import math
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    pg.evaluate("""() => { const o = window.omni; const l = o.doc.addLayer('raster');
      for (const t of l.tilesIn(0, 0, o.doc.width, o.doc.height, true)) { const c = t.ctx; c.save(); c.translate(-t.x*256, -t.y*256);
        for (let i = 0; i < 400; i++) { c.fillStyle = `hsl(${200 + (i % 7) * 4}, 30%, ${55 + (i % 5) * 4}%)`; c.fillRect((i * 97) % 2480, (i * 61) % 3508, 120, 120); }
        // the object: a disc with a soft airbrushed rim and a darker shaded half
        const g = c.createRadialGradient(1200, 1400, 470, 1200, 1400, 505); g.addColorStop(0, '#7a2d1e'); g.addColorStop(1, 'rgba(122,45,30,0)');
        c.fillStyle = '#7a2d1e'; c.beginPath(); c.arc(1200, 1400, 480, 0, Math.PI * 2); c.fill(); c.fillStyle = g; c.beginPath(); c.arc(1200, 1400, 505, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(0,0,0,0.35)'; c.beginPath(); c.arc(1200, 1400, 480, Math.PI * 0.2, Math.PI * 1.2); c.fill();
        c.restore(); t.generation++; }
      o.doc.activeLayerId = l.id; o.invalidate(); o.renderer.fitPage(o.doc); }""")
    pg.wait_for_timeout(400)
    def iou():
        return pg.evaluate("""() => { const s = window.omni.selection; const d = s.ctx.getImageData(0, 0, s.width, s.height).data; let inter = 0, uni = 0;
          for (let y = 0; y < s.height; y += 2) for (let x = 0; x < s.width; x += 2) { const sel = d[(y * s.width + x) * 4 + 3] > 127; const disc = Math.hypot(x - 1200, y - 1400) <= 492; if (sel && disc) inter++; if (sel || disc) uni++; } return inter / uni; }""")
    # sloppy 10-gon wobbling 35 px in and out of the edge
    pg.evaluate("""async () => { const o = window.omni; const pts = []; for (let k = 0; k < 10; k++) { const a = k / 10 * 2 * Math.PI; const r = 492 + (k % 2 ? 35 : -35); pts.push({ x: 1200 + r * Math.cos(a), y: 1400 + r * Math.sin(a) }); }
      const S = o.selection ? o.selection.constructor : null; const mod = window.omniSelection; }""")
    # use the polygon tool via keyboard clicks
    pg.keyboard.press("m"); pg.evaluate("() => { window.omni.selShape = 'poly'; window.omni.emit('tool'); }")
    box = pg.locator("#draw").bounding_box()
    for k in range(10):
        a = k / 10 * 2 * math.pi; r = 492 + (35 if k % 2 else -35); x = 1200 + r * math.cos(a); y = 1400 + r * math.sin(a)
        s = pg.evaluate("([x,y]) => { const a = window.omni.renderer.docToScreen(x, y); return [a.x, a.y]; }", [x, y]); pg.mouse.click(box["x"]+s[0], box["y"]+s[1]); pg.wait_for_timeout(50)
    pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
    print("sloppy polygon IoU:", round(iou(), 3))
    for i in range(2): print("tighten:", pg.evaluate("() => window.omni.select.tighten(0)"), "| IoU:", round(iou(), 3))
    print("errors:", errs); b.close()
