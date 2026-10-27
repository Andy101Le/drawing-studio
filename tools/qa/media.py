from playwright.sync_api import sync_playwright
import math, time

def stroke(pg, preset, col, size, pts, pid=3, pressure=0.85, dt=12):
    pg.evaluate("""([preset,col,size,pts,pid,pressure,dt]) => { const c = document.querySelector('#draw'); const o = window.omni;
      const pr = window.omniBrush.PRESETS.find(p => p.name === preset); if (!pr) throw new Error('no preset ' + preset); o.setPreset(pr); o.setColor(col); if (size) o.preset.size = size;
      let t = performance.now();
      const fire = (type, x, y) => c.dispatchEvent(new PointerEvent(type, { pointerId: pid, pointerType: 'pen', isPrimary: true, clientX: x, clientY: y, pressure, buttons: 1, bubbles: true }));
      fire('pointerdown', pts[0][0], pts[0][1]); for (const [x,y] of pts.slice(1)) fire('pointermove', x, y); const l = pts[pts.length-1]; fire('pointerup', l[0], l[1]); }""", [preset, col, size, pts, pid, pressure, dt])

def px(pg, sx, sy):
    return pg.evaluate("([x,y]) => { const o = window.omni; const r = document.querySelector('#draw').getBoundingClientRect(); const p = o.renderer.screenToDoc(x - r.left, y - r.top); const c = o.renderer.flatten(o.doc, 1); const d = c.getContext('2d').getImageData(Math.round(p.x), Math.round(p.y), 1, 1).data; return [d[0],d[1],d[2],d[3]]; }", [sx, sy])

def line(x0, y0, x1, y1, n=40):
    return [[x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n] for i in range(n + 1)]

with sync_playwright() as p:
    b = p.chromium.launch(); errs = []
    pg = b.new_context(viewport={"width": 1500, "height": 950}).new_page()
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(400)
    pg.keyboard.press("b")
    setview = "() => { const o = window.omni; o.renderer.view = { zoom: 0.42, rotation: 0, panX: 12, panY: 12 }; o.renderer.full = true; o.invalidate(); }"
    pg.evaluate(setview); pg.wait_for_timeout(200)
    box = pg.locator("#draw").bounding_box(); cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    L, T = box["x"] + 30, box["y"] + 30
    names = pg.evaluate("() => window.omniBrush.PRESETS.filter(p => ['water','acrylic','sponge'].includes(p.category)).map(p => p.name)")
    print("media presets:", len(names), names)
    # --- family sheet: each preset one S-stroke
    cols = 4; w = 250; hgt = 66
    for i, n in enumerate(names):
        col = i % cols; row = i // cols
        x0 = L + col * w; y0 = T + row * hgt
        pts = [[x0 + 16 + t * 210 / 30, y0 + 30 + math.sin(t / 30 * math.pi * 2) * 12] for t in range(31)]
        stroke(pg, n, ['#1f5fa8', '#c0392b', '#2a7d4f', '#7a3fa0', '#d68a1a'][i % 5], None, pts, 10 + i)
        pg.wait_for_timeout(30)
    pg.wait_for_timeout(2500)  # let washes move
    pg.evaluate("() => { const o = window.omni; for (const l of o.doc.drawing.layers) window.omniMedia.dryLayer(l); }")
    pg.screenshot(path="/tmp/shots/media_sheet.png", clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]})
    print("sheet errors:", errs)
    # labels: write names via DOM overlay for the sheet? skip; print order instead
    # --- scenario page: wet-in-wet bleed, bloom, lift, impasto, sponge
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(400); pg.keyboard.press("b")
    pg.evaluate(setview); pg.wait_for_timeout(200)
    box = pg.locator("#draw").bounding_box(); L, T = box["x"] + 30, box["y"] + 40
    # 1. wet-in-wet: blue wash then red dropped in while wet
    stroke(pg, "Wet-in-Wet", "#1f5fa8", 110, line(L + 20, T + 60, L + 300, T + 60), 21)
    pg.wait_for_timeout(300)
    stroke(pg, "Wet-in-Wet", "#c0392b", 60, line(L + 120, T + 30, L + 200, T + 90, 12), 22)
    # 2. wet-on-dry: hard edge, wait to dry
    stroke(pg, "Wet-on-Dry", "#2a7d4f", 70, line(L + 360, T + 60, L + 640, T + 60), 23)
    # 3. bloom: wash, wait ~2.5 s, drop water
    stroke(pg, "Flat Wash", "#7a3fa0", 110, line(L + 700, T + 60, L + 980, T + 60), 24)
    pg.wait_for_timeout(2600)
    stroke(pg, "Water Only", "#000000", 60, [[L + 840, T + 60]] * 3, 25)
    # 4. lift out
    stroke(pg, "Flat Wash", "#1f5fa8", 110, line(L + 20, T + 200, L + 300, T + 200), 26)
    pg.wait_for_timeout(400)
    stroke(pg, "Lift Out", "#000000", 50, line(L + 160, T + 160, L + 160, T + 240, 10), 27)
    # 5. glaze over dry: yellow over blue should read green
    stroke(pg, "Wet-on-Dry", "#1f5fa8", 80, line(L + 360, T + 200, L + 640, T + 200), 28)
    pg.wait_for_timeout(5500)
    pg.evaluate("() => window.omniMedia.dryLayer(window.omni.doc.activeLayer)")
    stroke(pg, "Glaze", "#f1c40f", 90, line(L + 450, T + 150, L + 450, T + 250, 10), 29)
    # 6. acrylic impasto: knife ribbon + flat bristle + dry brush over
    stroke(pg, "Acrylic Flat Bristle", "#c0392b", 60, line(L + 700, T + 200, L + 980, T + 200), 30)
    stroke(pg, "Impasto Knife", "#f1c40f", 70, line(L + 720, T + 230, L + 960, T + 170, 30), 31)
    stroke(pg, "Acrylic Dry Brush", "#ffffff", 50, line(L + 700, T + 250, L + 980, T + 250), 32)
    # 7. sponge dabs: natural, sea, stipple
    for i, (n, col) in enumerate([("Natural Sponge", "#2a7d4f"), ("Sea Sponge", "#1f5fa8"), ("Sponge Stipple", "#c0392b"), ("Wet Sponge", "#7a3fa0")]):
        x = L + 60 + i * 150
        stroke(pg, n, col, None, [[x, T + 360], [x + 40, T + 380], [x + 80, T + 350], [x + 120, T + 380]], 40 + i)
    # 8. salt + alcohol on a wash
    stroke(pg, "Flat Wash", "#1f5fa8", 110, line(L + 700, T + 360, L + 980, T + 360), 50)
    pg.wait_for_timeout(300)
    stroke(pg, "Salt", "#000", 90, line(L + 720, T + 360, L + 820, T + 360, 4), 51)
    stroke(pg, "Rubbing Alcohol", "#000", 70, line(L + 860, T + 360, L + 960, T + 360, 3), 52)
    # 9. sgraffito: scratch through red acrylic
    stroke(pg, "Acrylic Round", "#c0392b", 60, line(L + 20, T + 500, L + 300, T + 500), 60)
    stroke(pg, "Sgraffito", "#000", 6, line(L + 60, T + 480, L + 260, T + 520, 20), 61)
    pg.wait_for_timeout(600)
    pg.screenshot(path="/tmp/shots/media_wet.png", clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]})
    print("wet-in-wet centre (red into blue):", px(pg, L + 160, T + 60), "| wet-on-dry:", px(pg, L + 500, T + 60), "| glaze overlap (should be greenish):", px(pg, L + 450, T + 200), "| glaze alone:", px(pg, L + 450, T + 160))
    print("lift centre (lighter):", px(pg, L + 160, T + 200), "vs wash:", px(pg, L + 60, T + 200))
    print("knife:", px(pg, L + 840, T + 200), "sponge natural:", px(pg, L + 100, T + 365), "sgraffito scratch:", px(pg, L + 160, T + 500))
    pg.wait_for_timeout(7000)
    pg.screenshot(path="/tmp/shots/media_dry.png", clip={"x": box["x"], "y": box["y"], "width": box["width"], "height": box["height"]})
    print("after drying: wet-in-wet centre:", px(pg, L + 160, T + 60), "| bloom centre (lighter than rim):", px(pg, L + 840, T + 60), "rim:", px(pg, L + 760, T + 60), "wet field count:", pg.evaluate("() => [...window.omniMedia.activeWetFields()].length"))
    # undo test: undo the sgraffito and the acrylic, no errors
    pg.keyboard.press("Control+z"); pg.keyboard.press("Control+z"); pg.wait_for_timeout(300)
    print("after undo sgraffito+acrylic:", px(pg, L + 160, T + 500))
    # brush panel preview renders for every media preset
    pg.click("#side .rail button[title='Brush']"); pg.wait_for_timeout(200)
    for catname in ("Water", "Acrylic", "Sponge"):
        pg.click(f"#side .panel.active button:has-text('{catname}')"); pg.wait_for_timeout(150)
    pg.click("#side .panel.active button:has-text('Acrylic')"); pg.wait_for_timeout(150)
    pg.click("#side .panel.active button:has-text('Impasto Knife')"); pg.wait_for_timeout(300)
    pg.screenshot(path="/tmp/shots/media_panel.png", clip={"x": box["x"] + box["width"], "y": 0, "width": 1500 - box["x"] - box["width"], "height": 950})
    print("errors:", errs); b.close()
