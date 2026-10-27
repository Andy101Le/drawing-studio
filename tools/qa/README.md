# QA scripts

Playwright scripts that drive the built app at http://localhost:4173 against the stub sidecar.
Each prints what it checked and ends with `errors: []` when nothing went wrong.

Before running, from the repo root:

    npx vite build --config vite.config.ts
    npx vite preview --config vite.config.ts --port 4173 --strictPort
    cd ml/sidecar && python stub.py          # fake sidecar on port 8790

Then `python tools/qa/<script>.py`. `sweep.py` and `sweep2.py` press every panel, tool and
top-bar button and report page errors; the others exercise one feature each (Generate panel,
character design, magnetic lasso, Tighten, group move, delete, redraw). `gen.py` reads
`media.py` from the same folder; copy it along if you move things.
