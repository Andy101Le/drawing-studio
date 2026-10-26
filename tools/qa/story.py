from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_context(viewport={"width":1500,"height":1000}).new_page(); errs=[]; pg.on("pageerror", lambda e: errs.append(str(e))); reqs=[]
    pg.on("request", lambda r: reqs.append(r.post_data) if r.url.endswith("/generate") else None)
    pg.goto("http://localhost:4173/", wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(600)
    pg.evaluate("() => { const s = JSON.parse(localStorage.getItem('omni.ml')); s.fast = false; s.dedupe = false; s.steerKept = false; localStorage.setItem('omni.ml', JSON.stringify(s)); }"); pg.reload(wait_until="networkidle"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Generate']"); pg.wait_for_timeout(600)
    pg.click("#side .rail button[title='Story']"); pg.wait_for_timeout(500)
    P = "#side .panel.active "
    print("plan rows:", pg.evaluate("() => document.querySelectorAll('#story-plan .mono').length"), "| cast:", pg.evaluate("() => [...document.querySelectorAll('#story-plan .dim')].map(d => d.textContent).find(t => t.startsWith('Cast'))"))
    pg.click(P+"button[title='Lay out page']"); pg.wait_for_timeout(300)
    print("panels on page:", pg.evaluate("() => window.omni.doc.panels.length"), "| undo:", pg.evaluate("() => window.omni.history.labels.slice(-1)"))
    pg.click(P+"button[title='Generate page']"); 
    for i in range(40):
        pg.wait_for_timeout(500)
        st = pg.evaluate("() => { const b = [...document.querySelectorAll('.story-tab button')].find(x => x.textContent.startsWith('Generat')); return b ? b.disabled : 'missing'; }")
        if st == 'missing': print("button missing; errors so far:", errs, "| buttons:", pg.evaluate("() => [...document.querySelectorAll('.story-tab button')].map(b => [b.title, b.textContent])")); break
        if not st: break
    import json
    print("jobs sent:", len(reqs), "| first prompt:", json.loads(reqs[0])["prompt"][:90] if reqs else None)
    print("regions:", [json.loads(r).get("region", {}).get("panelId") for r in reqs])
    print("gen layers:", pg.evaluate("() => window.omni.doc.drawing.layers.filter(l => l.name.startsWith('Gen')).map(l => [l.name, l.panelMask])"))
    print("balloons:", pg.evaluate("() => window.omni.doc.balloons.map(b => [b.kind, b.text])"))
    print("log tail:", pg.evaluate("() => document.querySelector('.story-tab .mono.dim')?.textContent.split('\\n').slice(-2)"))
    print("errors:", errs); b.close()
