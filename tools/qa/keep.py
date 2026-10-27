from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); reqs=[]
    pg.on("request", lambda r: reqs.append(r.post_data) if "/dataset/add" in r.url else None)
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)
    P = "#side .panel.active "
    pg.fill(P+"input[type=search]", "katana"); pg.wait_for_timeout(150); pg.click(P+"button.tag[title='katana']"); pg.fill(P+"input[type=search]", ""); pg.wait_for_timeout(150)
    pg.click(P+"button[title='Generate']"); pg.wait_for_timeout(2500)
    pg.click(P+"button[title='Keep']"); pg.wait_for_timeout(500)
    print("dialog:", pg.evaluate("() => !!document.querySelector('#keep-name')"), "action guessed:", pg.evaluate("() => document.querySelector(\"#side .panel.active select[title='Action folder']\").value"))
    pg.fill("#keep-name", "Trooper Sword Swing, rooftop!"); pg.fill(P+".keep-box textarea", "1boy, katana, sword swing, rooftop")
    pg.click(P+"button[title='Save to training set']"); pg.wait_for_timeout(800)
    import json; body = json.loads(reqs[-1]); print("sent:", {k: body[k] for k in ("name", "action", "caption", "verdict")})
    print("kept chip:", pg.evaluate("() => document.querySelector('#side .panel.active .keep-box')?.innerText.slice(0, 80)"))
    # shift-click keeps at once
    pg.click(P+"button[title='Keep']", modifiers=["Shift"]); pg.wait_for_timeout(600)
    body = json.loads(reqs[-1]); print("shift keep sent name/action:", body.get("name"), body.get("action"), "| total adds:", len(reqs))
    print("errors:", errs); b.close()
