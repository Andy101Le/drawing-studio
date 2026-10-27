from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); reqs=[]
    pg.on("request", lambda r: reqs.append(r.post_data) if r.url.endswith("/generate") else None)
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)
    P = "#side .panel.active "
    pg.evaluate("() => { const s = JSON.parse(localStorage.getItem('omni.ml')); s.fast = false; localStorage.setItem('omni.ml', JSON.stringify(s)); }"); pg.reload(wait_until="networkidle"); pg.wait_for_timeout(600); pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)
    pg.select_option(P+"select[title='Pose preset']", "running"); pg.wait_for_timeout(300)
    print("editor:", pg.evaluate("() => !!document.querySelector(\"#side .panel.active canvas[title='Pose editor']\")"))
    # drag the right wrist (index 4) somewhere else
    pg.locator(P+"canvas[title='Pose editor']").scroll_into_view_if_needed(); pg.wait_for_timeout(200)
    box = pg.locator(P+"canvas[title='Pose editor']").bounding_box()
    before = pg.evaluate("() => JSON.parse(localStorage.getItem('omni.ml')).pose.pts[4]")
    pg.mouse.move(box["x"] + before["x"] * box["width"], box["y"] + before["y"] * box["height"]); pg.mouse.down(); pg.mouse.move(box["x"] + 0.1 * box["width"], box["y"] + 0.5 * box["height"], steps=5); pg.mouse.up(); pg.wait_for_timeout(200)
    after = pg.evaluate("() => JSON.parse(localStorage.getItem('omni.ml')).pose.pts[4]")
    print("wrist moved:", round(before["x"], 2), "->", round(after["x"], 2))
    pg.click(P+"button[title='Mirror pose']"); pg.wait_for_timeout(200)
    print("mirrored x:", round(pg.evaluate("() => JSON.parse(localStorage.getItem('omni.ml')).pose.pts[7].x"), 2))
    print("embeddings line:", pg.evaluate("() => [...document.querySelectorAll('#side .panel.active span')].map(s => s.textContent).find(t => t.startsWith('loaded:'))"))
    pg.click(P+"button[title='Generate']"); pg.wait_for_timeout(2600)
    import json; body = json.loads(reqs[-1])
    print("controls:", [(c["type"], c["weight"], c["image"][:22]) for c in body["controls"]], "| detail:", body.get("detail"), "| negEmb:", body.get("negEmbeddings"))
    print("negative has anatomy:", "fused fingers" in body["negative"], "| prompt tail:", body["prompt"][-60:])
    print("detail chip:", pg.evaluate("() => [...document.querySelectorAll('#side .panel.active .gen-job .chip')].map(c => c.textContent)"))
    print("errors:", errs); b.close()
