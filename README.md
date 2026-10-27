# drawing-studio (OMNI-CELL)

Drawing Studio that allows for creation of manga panels, 2D and 3D animation. Integrated Localized AI model where user can add onto their own dataset and can generate their own images.

Fastest start: double-click `start.cmd` (Windows) or run `./start.sh` (macOS/Linux). It installs on first run, starts the server and opens the app.

```
npm install
npm run dev          # http://localhost:5173, opens automatically (COOP/COEP on, SharedArrayBuffer enabled)
npm run signaling    # ws://localhost:8787  pairing relay for OMNI-Bridge
npm test             # 34 tests
npm run typecheck
npm run build        # dist/
```

Layout
- `web/app/`             the studio: `main.ts` shell, `engine/` (document, brush, renderer, color, screentone, panels, npr, history, serialize), `ui/` (viewport, panels, timeline, radial, bridge, vault), `design/obsidian.css`
- `web/src/crypto/`      Phase 2: Argon2id KDF, passkey PRF, AES-GCM-256 chunked assets, OPFS vault
- `web/src/input/`       Phase 3: WebHID parser (profile-driven), Pointer Events fallback, shared ring buffer
- `web/src/sync/`        Phase 4: WebRTC data channel manager, binary protocol, clock sync, loss recovery
- `web/test-pages/`      hardware checks (WebHID enumeration + rate test)
- `server/signaling.ts`  WebSocket pairing relay
- `core/`                C++20: input ring consumer, One Euro + dead-reckoning predictor, C ABI for Wasm
- `docs/ARCHITECTURE.md` decisions, threat model, schemas, math, test plan, status

Hardware test: open `web/test-pages/webhid-enum.html` via `npm run dev` → http://localhost:5173/webhid-enum.html
(a copy lives in `web/app/` so the dev server serves it directly).
