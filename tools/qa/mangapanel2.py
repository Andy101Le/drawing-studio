from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); reqs=[]
    pg.on("request", lambda r: reqs.append(r.url.split('8790')[-1]) if "8790" in r.url and r.method == "POST" else None)
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    # tone export check: a tone layer with a filled square must flatten to a dot pattern, not solid black
    print("tone bake:", pg.evaluate("""() => { const o = window.omni; const l = o.doc.addLayer('tone'); l.tone = { lpi: 60, density: 0.3, angle: 45, shape: 'dot', gradient: null }; for (const t of l.tilesIn(500, 500, 900, 900, true)) { const c = t.ctx; c.fillStyle = '#000'; c.fillRect(500 - t.x*256, 500 - t.y*256, 400, 400); t.generation++; }
      const flat = o.renderer.flatten(o.doc, 0.25); const d = flat.getContext('2d').getImageData(130, 130, 90, 90).data; let dark = 0, n = 0; for (let i = 0; i < d.length; i += 4) { n++; if (d[i+3] > 128 && d[i] < 100) dark++; } o.doc.removeLayer(l.id); return { darkShare: +(dark / n).toFixed(2) }; }"""))
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)
    pg.evaluate("() => { const s = JSON.parse(localStorage.getItem('omni.ml')); s.fast = false; s.dedupe = false; s.steerKept = false; localStorage.setItem('omni.ml', JSON.stringify(s)); const r = JSON.parse(localStorage.getItem('omni.redraw.v1') || '{}'); r.maxMpx = 1; localStorage.setItem('omni.redraw.v1', JSON.stringify(r)); }"); pg.reload(wait_until="networkidle"); pg.wait_for_timeout(800); pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)
    pg.click("#side .panel.active button[title='Generate']"); pg.wait_for_timeout(2600)
    pg.click("#side .panel.active button[title='Manga panel']")
    for i in range(240):
        pg.wait_for_timeout(1000)
        txt = pg.evaluate("() => document.querySelector('.redraw-tab .gen-job .mono')?.textContent || document.querySelector('.redraw-tab .notice')?.textContent || null")
        if txt: break
    print("report:", (txt or "")[:100])
    print("posts:", [r for r in reqs if "lineart" in r or "generate" in r])
    print("layers:", pg.evaluate("() => window.omni.doc.drawing.layers.map(l => l.name + ':' + l.kind)"))
    print("settings now:", pg.evaluate("() => { const r = JSON.parse(localStorage.getItem('omni.redraw.v1')); return [r.style, r.ink, r.layers, r.lines]; }"))
    print("errors:", errs[:3]); b.close()
