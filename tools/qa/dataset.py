from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); reqs=[]
    pg.on("request", lambda r: reqs.append((r.url.split('8790')[-1], r.post_data)) if "/dataset/" in r.url and r.method == "POST" else None)
    pg.on("dialog", lambda d: d.accept())
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(800)   # connects the sidecar
    pg.click("#side .rail button[title='Dataset']"); pg.wait_for_timeout(800)
    P = "#side .panel.active "
    print("header:", pg.evaluate("() => [...document.querySelectorAll('#side .panel.active span.dim')].map(s => s.textContent).find(t => t.includes('images'))"))
    print("weak rows shown:", pg.evaluate("() => document.querySelectorAll('#side .panel.active .gen-job').length"))
    pg.select_option(P+"select[title='Show']", "all"); pg.wait_for_timeout(200); print("all rows:", pg.evaluate("() => document.querySelectorAll('#side .panel.active .gen-job').length"))
    pg.click(P+"button[title='Edit caption'] >> nth=0"); pg.wait_for_timeout(200)
    pg.click(P+"button[title='Strip quality words']"); pg.click(P+"button[title='Prepend subject'] >> nth=0"); pg.click(P+"button[title='Suggest tags']"); pg.wait_for_timeout(400)
    print("caption now:", pg.evaluate("() => document.querySelector('#side .panel.active textarea').value"))
    pg.fill(P+"input[title='Character tag']", "Kai"); pg.click(P+"button[title='Save caption']"); pg.wait_for_timeout(400)
    print("update sent:", reqs[-1][0], reqs[-1][1][:120])
    print("characters line:", pg.evaluate("() => [...document.querySelectorAll('#side .panel.active .mono')].map(s => s.textContent).find(t => t.startsWith('Characters'))"))
    pg.click(P+"button[title='Edit caption'] >> nth=1"); pg.wait_for_timeout(200); pg.click(P+"button[title='Remove from set']"); pg.wait_for_timeout(300)
    print("remove sent:", reqs[-1][0], "| rows:", pg.evaluate("() => document.querySelectorAll('#side .panel.active .gen-job').length"))
    print("errors:", errs); b.close()
