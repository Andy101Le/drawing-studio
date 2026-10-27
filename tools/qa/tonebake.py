from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1200,"height":800}).new_page()
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    print(pg.evaluate("""() => { const o = window.omni; const l = o.doc.addLayer('tone'); l.tone = { lpi: 60, density: 0.3, angle: 45, shape: 'dot', gradient: null }; for (const t of l.tilesIn(500, 500, 900, 900, true)) { const c = t.ctx; c.fillStyle = '#000'; c.fillRect(500 - t.x*256, 500 - t.y*256, 400, 400); t.generation++; }
      const flat = o.renderer.flatten(o.doc, 1); const g = flat.getContext('2d'); const d = g.getImageData(520, 520, 300, 300).data; let dark = 0, mid = 0, clear = 0; for (let i = 0; i < d.length; i += 4) { if (d[i+3] < 10) clear++; else if (d[i] < 60) dark++; else mid++; }
      const out = g.getImageData(100, 100, 50, 50).data; let outside = 0; for (let i = 3; i < out.length; i += 4) if (out[i] > 10) outside++;
      o.doc.removeLayer(l.id); return { dark, mid, clear, outside }; }"""))
    b.close()
