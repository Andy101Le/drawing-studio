from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Manga']"); pg.wait_for_timeout(300)
    pg.evaluate("""() => { const d = window.omni.doc; d.fx.push({ id: 9001, kind: 'focus', x: 100, y: 100, w: 500, h: 400, anchor: { x: 300, y: 250 }, panelId: null, density: 0.7, length: 0.3, jitter: 0.4, weight: 4, angle: 0, seed: 11, ink: '#141414', opacity: 1, toneFrom: 0.6, toneTo: 0, lpi: 50, text: 'X', font: 'sans-serif', size: 100, fill: '#fff', outline: 4, halo: 6, slant: -10, bold: true }); window.omni.invalidate(); }""")
    pg.click("#side .panel.active button:has-text('Duplicate')"); pg.wait_for_timeout(800)
    print("pages:", pg.evaluate("() => window.omni.story.pages.length"), "| fx on copy:", pg.evaluate("() => { const s = window.omni.story; const a = s.pages[0].fx[0], b = s.pages[1].fx[0]; return [s.pages[1].fx.length, JSON.stringify(a) === JSON.stringify(b)]; }"))
    print("errors:", errs); b.close()
