from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(1500)
    pg.evaluate("""async () => { const o = window.omni; const r = await fetch('/samples/silver-glasses.png'); const bl = await r.blob(); const url = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); });
      const img = new Image(); await new Promise(res => { img.onload = res; img.src = url; });
      const l = o.doc.addLayer('raster'); l.name = 'Source';
      const s = Math.min(o.doc.width / img.width, o.doc.height / img.height) * 0.5; const ox = 300, oy = 300;
      for (const t of l.tilesIn(0, 0, o.doc.width, o.doc.height, true)) { const g = t.ctx; g.drawImage(img, ox - t.x * 256, oy - t.y * 256, img.width * s, img.height * s); t.generation++; }
      o.doc.activeLayerId = l.id; o.emit('layers'); o.invalidate(); }""")
    pg.wait_for_timeout(300)
    pg.evaluate("() => document.querySelector(\"#side .rail button[title='Redraw']\").click()"); pg.wait_for_timeout(500)
    pg.select_option("#side .panel.active select[title='Redraw layers']", "single"); pg.select_option("#side .panel.active select[title='Redraw look']", "manga"); pg.select_option("#side .panel.active select[title='Line source']", "trace"); pg.select_option("#side .panel.active select[title='Working resolution']", "1")
    before = pg.evaluate("() => window.omni.doc.drawing.layers.length")
    pg.click("#side .panel.active button[title='Redraw']")
    for i in range(240):
        pg.wait_for_timeout(1000)
        txt = pg.evaluate("() => document.querySelector('#side .panel.active .gen-job .mono')?.textContent || document.querySelector('#side .panel.active .notice')?.textContent || null")
        if txt: break
    print("report:", (txt or "")[:120])
    print("layers before/after:", before, pg.evaluate("() => window.omni.doc.drawing.layers.map(l => l.name + ':' + l.kind)"))
    # the single layer must contain dots (tone baked), i.e. a mix of transparent and black pixels within the tone areas
    print("single layer alpha histogram:", pg.evaluate("""() => { const l = window.omni.doc.drawing.layers.find(x => x.name.startsWith('Redraw')); let on = 0, off = 0; for (const t of l.tiles.values()) { const d = t.ctx.getImageData(0,0,256,256).data; for (let i = 3; i < d.length; i += 4) { if (d[i] > 128) on++; else off++; } } return { on, off, tiles: l.tiles.size }; }"""))
    pg.click("#side .panel.active button[title='Show colour layers']"); pg.wait_for_timeout(1500)
    print("after Colour: colour pixels present:", pg.evaluate("""() => { const l = window.omni.doc.drawing.layers.find(x => x.name.startsWith('Redraw')); let col = 0; for (const t of l.tiles.values()) { const d = t.ctx.getImageData(0,0,256,256).data; for (let i = 0; i < d.length; i += 4) if (d[i+3] > 128 && Math.abs(d[i] - d[i+1]) > 20) col++; } return col; }"""))
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(300); print("after undo:", pg.evaluate("() => window.omni.doc.drawing.layers.map(l => l.name)"))
    print("errors:", errs[:3]); b.close()
