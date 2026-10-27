import base64, sys, time
from playwright.sync_api import sync_playwright
ids = sys.argv[1:] or ["silver-glasses", "braids-phone", "red-camera", "watercolour-smoke", "theatre-red"]
OUT = "/home/claude/omni-cell/web/app/public/samples/"
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width": 1400, "height": 1000}).new_page(); errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(400)
    pg.evaluate(open("/tmp/shots/art.js").read()); pg.evaluate(open("/tmp/shots/portraits.js").read())
    for sid in ids:
        t0 = time.time()
        pg.evaluate(f"() => window.drawSample('{sid}')")
        pg.wait_for_timeout(9000)  # let watercolour dry
        pg.evaluate("() => { for (const l of window.omni.doc.drawing.layers) window.omniMedia.dryLayer(l); window.omni.invalidate(); }")
        pg.wait_for_timeout(300)
        r = pg.evaluate(f"() => window.art.export('{sid}')")
        open(OUT + sid + ".omni", "wb").write(base64.b64decode(r["omni"]))
        open(OUT + sid + ".png", "wb").write(base64.b64decode(r["png"].split(",")[1]))
        print(sid, "done in", round(time.time() - t0, 1), "s; layers:", pg.evaluate("() => window.omni.doc.drawing.layers.map(l => l.name)"), "errors:", errs)
    b.close()
