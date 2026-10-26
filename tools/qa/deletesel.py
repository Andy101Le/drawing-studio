from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    pg.evaluate("""() => { const o = window.omni; const g = o.doc.addLayer('group'); g.name = 'G';
      const mk = (kind, name, color) => { const l = o.doc.addLayer(kind); l.name = name; l.parent = g.id; for (const t of l.tilesIn(600, 600, 1000, 1000, true)) { const c = t.ctx; c.fillStyle = color; c.fillRect(600 - t.x*256, 600 - t.y*256, 400, 400); t.generation++; } return l; };
      mk('raster', 'A', '#4080ff'); mk('raster', 'B', '#808080'); o.doc.activeLayerId = g.id; o.emit('layers'); o.invalidate(); }""")
    count = lambda: pg.evaluate("() => window.omni.doc.drawing.layers.filter(l => l.parent !== null).map(l => { let n = 0; for (const t of l.tiles.values()) { const d = t.ctx.getImageData(0,0,256,256).data; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; } return [l.name, n]; })")
    print("start:", count())
    # floating group, then Backspace
    pg.keyboard.press("t"); s = pg.evaluate("() => { const a = window.omni.renderer.docToScreen(800, 800); return [a.x, a.y]; }"); box = pg.locator("#draw").bounding_box()
    pg.mouse.move(box["x"]+s[0], box["y"]+s[1]); pg.mouse.down(); pg.mouse.move(box["x"]+s[0]+40, box["y"]+s[1]+40, steps=4); pg.mouse.up(); pg.wait_for_timeout(200)
    pg.keyboard.press("Backspace"); pg.wait_for_timeout(200); print("after backspace on floating:", count(), "floating:", pg.evaluate("() => !!window.omni.floating"))
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(200); print("after undo:", count())
    # rect selection on the group, Delete
    pg.evaluate("() => { const o = window.omni; o.selection = o.selectionRect ? null : null; }")
    pg.evaluate("async () => { const { Selection } = await import('/src/engine/selection.ts').catch(() => ({})); }")
    pg.keyboard.press("m"); a = pg.evaluate("() => { const r = window.omni.renderer; const a = r.docToScreen(600, 600), b = r.docToScreen(800, 1000); return [a.x, a.y, b.x, b.y]; }")
    pg.mouse.move(box["x"]+a[0], box["y"]+a[1]); pg.mouse.down(); pg.mouse.move(box["x"]+a[2], box["y"]+a[3], steps=4); pg.mouse.up(); pg.wait_for_timeout(200)
    pg.keyboard.press("Delete"); pg.wait_for_timeout(200); print("after delete half on group:", count(), pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(200); print("after undo:", count())
    print("errors:", errs); b.close()
