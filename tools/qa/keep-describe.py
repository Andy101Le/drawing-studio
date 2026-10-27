from playwright.sync_api import sync_playwright
import json
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); reqs={}
    pg.on("request", lambda r: reqs.__setitem__(r.url.split("/")[-1], r.post_data) if r.url.endswith(("/generate", "/describe", "/dataset/add")) else None)
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)
    P = "#side .panel.active "
    pg.fill(P+"input[type=search]", "holding gun"); pg.wait_for_timeout(150); pg.click(P+"button.tag[title='holding gun']"); pg.fill(P+"input[type=search]", ""); pg.wait_for_timeout(150)
    pg.click(P+"button[title='Generate']"); pg.wait_for_timeout(2500)
    g = json.loads(reqs["generate"]); print("prompt has grip:", "two-handed grip" in g["prompt"], "| negative has fused:", "gun fused with hand" in g["negative"])
    pg.click(P+"button[title='Keep']"); pg.wait_for_timeout(700)
    print("describe sent:", "describe" in reqs, "| note:", pg.evaluate("() => document.querySelector('#side .panel.active .keep-box .dim')?.textContent.slice(0, 60)"))
    print("name:", pg.evaluate("() => document.querySelector('#keep-name').value"), "| action:", pg.evaluate("() => document.querySelector(\"#side .panel.active select[title='Action folder']\").value"), "| caption:", pg.evaluate("() => document.querySelector('#side .panel.active .keep-box textarea').value"))
    pg.click(P+"button[title='Merge prompt']"); pg.wait_for_timeout(100)
    print("merged:", pg.evaluate("() => document.querySelector('#side .panel.active .keep-box textarea').value")[:120])
    pg.click(P+"button[title='Save to training set']"); pg.wait_for_timeout(600)
    a = json.loads(reqs["add"]); print("saved name:", a.get("name"), "| action:", a.get("action"), "| caption head:", a.get("caption")[:50])
    print("errors:", errs); b.close()
