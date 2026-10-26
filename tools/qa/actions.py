from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(1200)
    txt = pg.evaluate("() => document.querySelector('#side .panel.active').innerText")
    import re
    print("by action line:", [l for l in txt.splitlines() if l.startswith("By action")][:1])
    print("thin line:", [l for l in txt.splitlines() if l.startswith("Under 8")][:1])
    print("errors:", errs); b.close()
