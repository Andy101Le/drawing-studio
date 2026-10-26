import sys
from playwright.sync_api import sync_playwright
STYLE = sys.argv[1] if len(sys.argv) > 1 else "colour"
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width": 1500, "height": 1000}).new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: errs.append("c:" + m.text) if m.type == "error" else None)
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(2000)
    # put the sample picture on a layer as the source
    pg.evaluate("""async () => { const o = window.omni; const r = await fetch('/samples/silver-glasses.png'); const bl = await r.blob(); const url = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(bl); });
      const { pngToLayer } = await import('/src/engine/ml.ts').catch(() => ({ pngToLayer: null }));
      const img = new Image(); await new Promise(res => { img.onload = res; img.src = url; });
      const l = o.doc.addLayer('raster'); l.name = 'Source';
      const s = Math.min(o.doc.width / img.width, o.doc.height / img.height); const ox = (o.doc.width - img.width * s) / 2, oy = (o.doc.height - img.height * s) / 2;
      for (const t of l.tilesIn(0, 0, o.doc.width, o.doc.height, true)) { const g = t.ctx; g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high'; g.drawImage(img, ox - t.x * 256, oy - t.y * 256, img.width * s, img.height * s); t.generation++; }
      o.doc.activeLayerId = l.id; o.emit('layers'); o.invalidate(); }""")
    pg.wait_for_timeout(400)
    pg.evaluate("() => document.querySelector(\"#side .rail button[title='Redraw']\").click()"); pg.wait_for_timeout(600)
    pg.select_option("#side .panel.active select[title='Redraw look']", STYLE)
    pg.click("#side .panel.active button[title='Redraw']")
    for i in range(240):
        pg.wait_for_timeout(1000)
        txt = pg.evaluate("() => document.querySelector('#side .panel.active .gen-job .mono')?.textContent || document.querySelector('#side .panel.active .notice')?.textContent || null")
        if txt: break
    print(STYLE, "report:", txt)
    print("layers:", pg.evaluate("() => window.omni.doc.drawing.layers.map(l => `${l.name}${l.visible ? '' : '(hidden)'}:${l.kind}:${l.tiles.size}`)"))
    pg.evaluate("() => { const r = window.omni.renderer; r.fitPage(window.omni.doc); window.omni.invalidate(); }"); pg.wait_for_timeout(800)
    box = pg.locator("#draw").bounding_box()
    pg.screenshot(path=f"/tmp/shots/redraw_{STYLE}.png", clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]})
    pg.click("#side .panel.active button[title='Compare with source']"); pg.wait_for_timeout(600)
    pg.screenshot(path=f"/tmp/shots/redraw_src.png", clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]})
    print("errors:", errs[:5]); b.close()
