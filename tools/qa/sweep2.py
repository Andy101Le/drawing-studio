from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]
    pg.on("pageerror", lambda e: errs.append("page:" + str(e))); pg.on("dialog", lambda d: d.dismiss())
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(800)
    for label in ["Templates", "Balloons", "Tones", "Export", "Save", "New", "Samples"]:
        vis = pg.evaluate(f"() => [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '{label}').map(b => [b.offsetParent !== null, b.disabled])")
        print(label, vis)
        try: pg.click(f"button:text-is('{label}')", timeout=2000); pg.wait_for_timeout(400); pg.keyboard.press("Escape")
        except Exception as e: errs.append(f"{label}: {str(e)[:80]}")
    print("errors:", errs); b.close()
