from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append("page:" + str(e))); pg.on("console", lambda m: errs.append("console:" + m.text) if m.type == "error" and "ERR_TUNNEL" not in m.text and "404" not in m.text else None)
    pg.on("dialog", lambda d: d.dismiss())
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    rails = pg.evaluate("() => [...document.querySelectorAll('#side .rail button')].map(b => b.title)")
    print("rail panels:", rails)
    for t in rails:
        pg.click(f"#side .rail button[title='{t}']"); pg.wait_for_timeout(350)
        n = pg.evaluate("() => document.querySelector('#side .panel.active') ? document.querySelector('#side .panel.active').querySelectorAll('button, input, select').length : -1")
        if n < 0: errs.append(f"panel {t}: no active panel")
    # every tool via the left toolbar
    tools = pg.evaluate("() => [...document.querySelectorAll('#tools button, .toolbar button, [data-tool]')].map(b => b.title || b.dataset.tool).filter(Boolean)")
    print("tools:", tools[:30])
    for t in tools[:30]:
        try: pg.click(f"button[title='{t}']", timeout=1500); pg.wait_for_timeout(120)
        except Exception as e: errs.append(f"tool {t}: {str(e)[:60]}")
    # top bar buttons that are safe to press
    for label in ["Manga", "Anime", "Templates", "Balloons", "Tones", "Fit", "Tablet layout", "Tablet", "Export"]:
        try: pg.click(f"text='{label}'", timeout=1500); pg.wait_for_timeout(300)
        except Exception as e: errs.append(f"top {label}: {str(e)[:60]}")
    pg.keyboard.press("Escape")
    # draw, undo, redo, select all, delete, new document
    box = pg.locator("#draw").bounding_box(); cx, cy = box["x"]+box["width"]/2, box["y"]+box["height"]/2
    pg.keyboard.press("b"); pg.mouse.move(cx-100, cy); pg.mouse.down(); pg.mouse.move(cx+100, cy+50, steps=10); pg.mouse.up(); pg.wait_for_timeout(200)
    for k in ["Control+z", "Control+y", "Control+a", "Delete", "Control+z", "Escape"]: pg.keyboard.press(k); pg.wait_for_timeout(150)
    print("history:", pg.evaluate("() => window.omni.history.labels.slice(-4)"))
    print("errors:", errs[:20]); b.close()
