from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(700)
    pg.click("#side .rail button[title='Manga']"); pg.wait_for_timeout(400)
    P = "#side .panel.active "
    # 2 x 2 template so there are panels to anchor to
    pg.evaluate("() => { const c = [...document.querySelectorAll('#side .panel.active canvas')].find(x => x.title.startsWith('2 x 2')); c.click(); }"); pg.wait_for_timeout(300)
    print("panels:", pg.evaluate("() => window.omni.doc.panels.length"))
    pg.keyboard.press("f"); pg.wait_for_timeout(200)
    print("tool:", pg.evaluate("() => window.omni.tool"))
    bb = pg.locator("#draw").bounding_box()
    # doc -> screen helper
    def scr(x, y):
        return pg.evaluate(f"() => {{ const r = window.omni.renderer.docToScreen({x}, {y}); return [r.x, r.y]; }}")
    r = pg.evaluate("() => { const b = window.omni.renderer.view; return [b.zoom, b.x, b.y]; }"); print("view:", r)
    def drag(x0,y0,x1,y1, steps=8):
        a = scr(x0,y0); c = scr(x1,y1)
        pg.mouse.move(bb["x"]+a[0], bb["y"]+a[1]); pg.mouse.down()
        for i in range(1, steps+1): pg.mouse.move(bb["x"]+a[0]+(c[0]-a[0])*i/steps, bb["y"]+a[1]+(c[1]-a[1])*i/steps)
        pg.mouse.up(); pg.wait_for_timeout(150)
    W, H = pg.evaluate("() => [window.omni.doc.width, window.omni.doc.height]")
    # speed lines: free box top-left
    drag(300, 400, 1100, 1000)
    print("after speed:", pg.evaluate("() => window.omni.doc.fx.map(f => [f.kind, Math.round(f.w), Math.round(f.h), f.panelId])"), "| undo:", pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    # focus lines in top-right panel, then anchor it to the panel via the editor
    pg.select_option(P+"select[title='Effect kind']", "focus"); pg.wait_for_timeout(100)
    drag(1500, 400, 2200, 1200)
    pg.select_option(P+"select[title='Anchoring']", pg.evaluate("() => String(window.omni.doc.panels[1].id)")); pg.wait_for_timeout(200)
    print("focus anchored:", pg.evaluate("() => { const f = window.omni.doc.fx[1]; return [f.kind, f.panelId, Math.round(f.anchor.x), Math.round(f.anchor.y)]; }"))
    # aim the focus (drag the anchor dot)
    ax, ay = pg.evaluate("() => { const f = window.omni.doc.fx[1]; return [f.anchor.x, f.anchor.y]; }")
    drag(ax, ay, ax + 300, ay + 150)
    print("aimed:", pg.evaluate("() => { const f = window.omni.doc.fx[1]; return [Math.round(f.anchor.x), Math.round(f.anchor.y)]; }"), "| undo:", pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    # flash bottom-left
    pg.select_option(P+"select[title='Effect kind']", "flash"); drag(400, 2000, 1100, 2800)
    # tone ramp bottom-right
    pg.select_option(P+"select[title='Effect kind']", "tone"); drag(1400, 1900, 2200, 2900)
    # sfx: click only
    pg.select_option(P+"select[title='Effect kind']", "sfx"); a = scr(1250, 1700); pg.mouse.click(bb["x"]+a[0], bb["y"]+a[1]); pg.wait_for_timeout(200)
    print("fx:", pg.evaluate("() => window.omni.doc.fx.map(f => f.kind)"))
    # move the speed box: click inside it and drag
    drag(500, 600, 600, 650)
    print("moved speed:", pg.evaluate("() => { const f = window.omni.doc.fx[0]; return [Math.round(f.x), Math.round(f.y)]; }"), "| undo:", pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    pg.wait_for_timeout(400); pg.screenshot(path="/tmp/shots/fx.png")
    # export composite must contain the fx: flatten and count dark pixels in the speed box
    dark = pg.evaluate("""() => { const c = window.omni.renderer.flatten(window.omni.doc, 0.25); const g = c.getContext('2d'); const d = g.getImageData(Math.round(400*0.25), Math.round(450*0.25), Math.round(700*0.25), Math.round(500*0.25)).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++; return n; }""")
    print("dark px in speed box (export):", dark)
    # bake the sfx (selected) to a layer
    nl = pg.evaluate("() => window.omni.doc.drawing.layers.length")
    pg.click(P+"button[title='Bake to layer']"); pg.wait_for_timeout(300)
    print("bake: layers", nl, "->", pg.evaluate("() => window.omni.doc.drawing.layers.length"), "| fx:", pg.evaluate("() => window.omni.doc.fx.length"), "| layer:", pg.evaluate("() => window.omni.doc.drawing.layers.at(-1).name"), "| tiles:", pg.evaluate("() => window.omni.doc.drawing.layers.at(-1).tiles.size"))
    pg.keyboard.press("Control+z"); pg.wait_for_timeout(200)
    print("undo bake: layers", pg.evaluate("() => window.omni.doc.drawing.layers.length"), "fx", pg.evaluate("() => window.omni.doc.fx.length"))
    # select the flash and delete with Backspace
    a = scr(700, 2400); pg.mouse.click(bb["x"]+a[0], bb["y"]+a[1]); pg.wait_for_timeout(150)
    print("selected:", pg.evaluate("() => window.omni.doc.fx.find(f => f.id === window.omni.selectedFx)?.kind"))
    pg.keyboard.press("Backspace"); pg.wait_for_timeout(150)
    print("after delete:", pg.evaluate("() => window.omni.doc.fx.map(f => f.kind)"), "| undo:", pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    pg.keyboard.press("Control+z"); print("undo delete:", pg.evaluate("() => window.omni.doc.fx.map(f => f.kind)"))
    # save/load round trip
    js = pg.evaluate("() => { const m = window.omni.serializeManifest ? 1 : 0; return m; }")
    print("errors:", errs); b.close()
