from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    # a group of three layers (raster normal, raster multiply, tone) with content at the same spot
    pg.evaluate("""() => { const o = window.omni; const g = o.doc.addLayer('group'); g.name = 'G';
      const mk = (kind, name, color) => { const l = o.doc.addLayer(kind); l.name = name; l.parent = g.id; if (name === 'Shadows') l.blend = 'multiply'; if (kind === 'tone') l.tone = { lpi: 60, density: 0.3, angle: 45, shape: 'dot', gradient: null };
        for (const t of l.tilesIn(600, 600, 1000, 1000, true)) { const c = t.ctx; c.fillStyle = color; c.fillRect(600 - t.x*256, 600 - t.y*256, 400, 400); t.generation++; } return l; };
      mk('raster', 'Flats', '#4080ff'); mk('raster', 'Shadows', '#808080'); mk('tone', 'Tone 30%', '#000');
      o.doc.activeLayerId = g.id; o.emit('layers'); o.invalidate(); }""")
    pg.wait_for_timeout(300)
    def bounds():
        return pg.evaluate("""() => window.omni.doc.drawing.layers.filter(l => l.parent !== null).map(l => { let x0=1e9,y0=1e9,x1=-1,y1=-1; for (const t of l.tiles.values()) { const d = t.ctx.getImageData(0,0,256,256).data; for (let y=0;y<256;y++) for (let x=0;x<256;x++) if (d[(y*256+x)*4+3]>0) { const px=t.x*256+x, py=t.y*256+y; x0=Math.min(x0,px); y0=Math.min(y0,py); x1=Math.max(x1,px); y1=Math.max(y1,py); } } return [l.name, x0, y0, x1, y1]; })""")
    print("before:", bounds())
    pg.keyboard.press("t"); pg.wait_for_timeout(200)
    s = pg.evaluate("() => { const r = window.omni.renderer; const a = r.docToScreen(800, 800), b = r.docToScreen(1100, 1100); return [a.x, a.y, b.x, b.y]; }")
    box = pg.locator("#draw").bounding_box(); ox, oy = box["x"], box["y"]
    pg.mouse.move(ox + s[0], oy + s[1]); pg.mouse.down(); pg.wait_for_timeout(100); pg.mouse.move(ox + s[2], oy + s[3], steps=8); pg.mouse.up(); pg.wait_for_timeout(300)
    print("floating parts:", pg.evaluate("() => window.omni.floating ? (window.omni.floating.parts || []).length + 1 : null"))
    pg.keyboard.press("Enter"); pg.wait_for_timeout(400)
    print("after move:", bounds())
    print("undo label:", pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(300); print("after undo:", bounds())
    pg.keyboard.press("Control+y"); pg.wait_for_timeout(300); print("after redo:", bounds())
    print("errors:", errs)
    b.close()
