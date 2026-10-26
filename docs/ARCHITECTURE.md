# Project OMNI-CELL: Architecture Specification

Status: Milestone 1 (web-first). Decisions recorded here were made by the project owner on 2026-10-24; open decisions are listed in Section 10.

## 0. Decision Record

| ID | Decision | Rationale | Alternative rejected |
|----|----------|-----------|----------------------|
| D1 | Web client first; native iPad and desktop later | Single test surface for Milestone 1 | Native-first (faster to reach latency floor, slower to test) |
| D2 | C++20 core, Emscripten to Wasm | Owner reads C++ more readily; libargon2, wgpu-native, and most brush-engine references are C/C++ | Rust (safer memory model, better wasm-bindgen ergonomics) |
| D3 | Local echo with host authority | Only model that survives Wi-Fi jitter; see Section 4 | Host-only rendering with tile streaming (simpler, visibly laggy on every spike) |
| D4 | Sync server sees only SHA-256(objectId), Lamport timestamps, ciphertext length | Minimum needed for delta sync and ordering | Fully oblivious server (no delta sync, full re-upload) |
| D5 | 4K at 120 Hz is a target, not a requirement | Browsers vsync to the display; 120 Hz reachable only on 120 Hz panels with WebGPU | Fixed 60 Hz cap (simpler, forfeits ProMotion) |
| D6 | Phase 2, 3, 4 implemented in TypeScript; prediction math in C++ | WebHID, WebRTC, OPFS and WebCrypto are browser APIs with no C++ binding; the C++ core owns everything that must be bit-identical on both devices | All-C++ with Embind wrappers (adds a marshaling layer with no latency benefit) |

Assumptions are marked **[A]** throughout and must be verified on target hardware before being treated as fact.

---

## 1. Hybrid Execution Core (Phase 1)

### 1.1 Process and thread topology (web build)

```
Main thread           Input worker            Render worker            Core worker pool (pthreads)
-----------           ------------            -------------            ---------------------------
UI (DOM)              WebHID inputreport  ─▶  WebGPU device/queue      brush raster (tile jobs)
Pointer Events ──┐    PointerEventSource      compositor pass          vector tessellation
                 └─▶  InputRing (SAB) ───────────────────────────────▶ StrokePredictor drain
OPFS worker           WebRTC data channels (BridgePeer)                tile cache encode/decode
```

- The InputRing lives inside the Wasm linear memory (a SharedArrayBuffer when pthreads are enabled). Producer is JavaScript, consumer is C++, zero copies.
- Requirement: the page must be served with `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. Without these headers SharedArrayBuffer is unavailable and the build falls back to single-threaded Wasm with a `postMessage` copy per sample (measured cost: one structured clone of 32 bytes per sample, under 10 µs; the real loss is the lack of worker-side rendering).
- WebGPU on an OffscreenCanvas in the render worker keeps rendering off the main thread so DOM work cannot stall a frame.

### 1.2 Wasm / native boundary contract

Every structure crossing the boundary is a `#pragma pack(1)` C struct with a documented byte layout, mirrored in TypeScript with `DataView` and checked by a test on each side:

| Structure | C++ header | TS mirror | Size |
|-----------|-----------|-----------|------|
| InputRecord | `core/include/omni/input_record.hpp` | `web/src/input/ring-buffer.ts` | 32 B |
| StrokePoint | `core/include/omni/stroke_predictor.hpp` | returned through `omni_predictor_drain` | 36 B |
| Telemetry sample | n/a (JS only) | `web/src/sync/protocol.ts` | 31 B body |

Exported C ABI (see `core/src/input_bridge.cpp`): `omni_ring_create`, `omni_predictor_create`, `omni_predictor_drain`, `omni_predictor_predict`. No Embind, no std::string across the boundary.

### 1.3 Unified Canvas coordinate system (Tri-Mode)

One canonical space, **document units** (DU), with three views:

| Mode | Mapping to DU | Storage |
|------|---------------|---------|
| Raster | pixel (i, j) at layer resolution r_px/DU: `x = i / r`, `y = j / r` | tiles |
| Vector | paths stored directly in DU, float64 | path table |
| 3D | world coordinates W; projection P·V places geometry on the DU plane z = 0 | mesh table |

Transform chain for any sample: `device (0..1) → view (DU) → layer (DU with layer transform T_L) → tile (integer tile index + local pixel)`.

```
view_DU   = V⁻¹ · [x_dev · W_view, y_dev · H_view, 1]ᵀ      V: 3x3 view matrix (zoom, rotation, pan)
layer_DU  = T_L⁻¹ · view_DU                                 T_L: per-layer affine
tile_ix   = floor(layer_DU · r / TILE_PX),  local = (layer_DU · r) mod TILE_PX
```

TILE_PX = 256. All matrices are float64 on the CPU; GPU receives float32 after subtracting the view origin (avoids precision loss on multi-gigapixel documents).

### 1.4 Data virtualization

- Tile cache: three tiers. GPU (textures, LRU by frame-of-last-use), RAM (decoded RGBA16F, LRU by bytes, budget = 25% of `navigator.deviceMemory` GB or 1 GB), OPFS (encrypted chunks via `TileCacheClient`).
- Each layer keeps a mip pyramid of tiles (levels 0..log2(max dimension / 256)). Rendering at zoom z selects level `clamp(floor(-log2(z)), 0, L)`.
- Dirty tracking: every stroke marks tiles in a per-layer bitset; the compositor re-blends only dirty tiles and the GPU uploads only those. 4K at 120 Hz is feasible only because the full-frame path is the exception, not the rule.
- Bandwidth budget **[A]**: a 4K RGBA16F frame is 66 MB. At 120 Hz a full redraw is 8 GB/s, beyond mobile GPUs. Dirty-tile compositing reduces a typical stroke frame to under 2 MB.

### 1.5 Rendering pipeline (WebGPU, WGSL)

Pass order per frame:

1. **Stroke raster** (compute): for each dirty tile, splat dabs along the Catmull-Rom path into an RGBA16F premultiplied stroke buffer. Dab spacing = `max(0.05 · radius, 0.5 px)`.
2. **Layer composite** (render): blend layer tiles bottom-up with the layer blend mode (normal, multiply, screen, overlay, add, subtract, darken, lighten). Linear-light RGBA16F.
3. **Color management** (render): convert working space (ACEScg) to display space (Section 5.3), apply soft-proof LUT if enabled, encode transfer function, write to the swap chain.
4. **UI overlay** (render): 1 px silver frame borders, selection marquees, onion-skin ghosts.

Native builds use the same WGSL through wgpu-native (Vulkan, Metal, DX12).

---

## 2. Security Architecture (Phase 2)

Implemented in `web/src/crypto/`. Summary of what exists:

| Concern | Module | Notes |
|---------|--------|-------|
| Argon2id (m=65536, t=3, p=4) | `kdf.ts` | hash-wasm reference build; HKDF splits seed into K_m and K_auth |
| Passkey PRF | `webauthn.ts` | 32-byte hardware-bound seed, no Argon2id needed |
| K_d wrap/unwrap | `keyring.ts` | AES-GCM-256 wrap, 48-byte wrapped key, versioned bundle |
| Asset encryption | `aead.ts` | AES-GCM-256, 1 MiB chunks, AAD binds header + chunk index + final flag |
| Local storage | `opfs.ts`, `opfs-worker.ts` | Atomic writes on the main thread, sync random access in a worker |
| Orchestration | `account.ts` | enroll, unlock, rotate password, put/get asset, server-visible metadata |

Threat model (replaces the spec phrase "by any means necessary"):

| Adversary | Capability | Mitigation |
|-----------|------------|------------|
| Sync server operator | Reads all stored bytes and metadata | Ciphertext only; metadata limited to objectId hash, Lamport stamp, length |
| Network attacker | Observes/modifies traffic | TLS to server; DTLS on P2P; AEAD on every asset |
| Stolen device, locked | Reads OPFS from disk | Wrapped K_d only; unwrap needs password or passkey |
| Stolen device, unlocked | Uses the open session | KeySession auto-lock (15 min idle); OS screen lock is the real control |
| Malicious signaling relay | Substitutes SDP | 4-digit safety code from both DTLS fingerprints shown on both screens |
| Password guessing offline | Has the wrapped bundle | Argon2id 64 MiB, 3 passes; 16-byte random salt |

Remaining leakage, stated plainly: the server learns how many objects exist, how large each is, and when each changes. Access-pattern leakage is inherent in delta sync and is accepted under D4.

### 2.1 Sync server schema (CRDT, zero-knowledge)

```sql
CREATE TABLE objects (
  user_id        BYTEA   NOT NULL,            -- opaque account id
  object_hash    BYTEA   NOT NULL,            -- SHA-256(objectId), 32 bytes
  lamport        BIGINT  NOT NULL,            -- max Lamport seen for this object
  cipher_len     BIGINT  NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, object_hash)
);

CREATE TABLE chunks (
  user_id        BYTEA   NOT NULL,
  object_hash    BYTEA   NOT NULL,
  chunk_index    BIGINT  NOT NULL,
  lamport        BIGINT  NOT NULL,            -- version that produced this chunk
  blob_ref       TEXT    NOT NULL,            -- object-store key, content-addressed by SHA-256(ciphertext)
  PRIMARY KEY (user_id, object_hash, chunk_index, lamport)
);

CREATE TABLE ops (                            -- encrypted CRDT op log for the project manifest
  user_id        BYTEA   NOT NULL,
  device_id      BYTEA   NOT NULL,            -- random per device, not linkable to hardware
  lamport        BIGINT  NOT NULL,
  payload        BYTEA   NOT NULL,            -- AES-GCM ciphertext of the op (aead.ts format)
  PRIMARY KEY (user_id, device_id, lamport)
);
```

- Manifest (layer tree, timeline, brush library) is a **Yjs-style** CRDT serialized as ops; each op is encrypted before upload. Conflict resolution happens client-side after decryption; the server only orders by (lamport, device_id).
- Tile and asset data are last-writer-wins per chunk keyed by Lamport stamp; a chunk is re-uploaded only when its ciphertext hash changes.
- Vector clock requirement from the owner: `lamport` is per-device monotonic; the client merges device clocks with `max + 1` on every local op.

PII handling: no email, name, or IP is stored next to `user_id`; authentication records live in a separate table keyed by a random account id. Logs strip IPs after 24 h. This covers the structural half of GDPR/CCPA; the process half (DPA, retention policy, breach notification) is organizational and out of scope for the code.

---

## 3. Input Engine (Phase 3)

Implemented in `web/src/input/` and `core/include/omni/`.

- `HidReportParser` is table-driven; `DEFAULT_PROFILE` encodes the spec byte map exactly, `profileFromCollections` derives a profile from the HID report descriptor when the device exposes standard Digitizer usages.
- Browser reality **[A]**: Chrome and Edge expose WebHID on Windows, macOS, Linux, ChromeOS. Safari and Firefox do not. On Windows, tablets installed with vendor drivers are often claimed by the OS and hidden from WebHID; `PointerEventSource` is the fallback and still carries pressure, tilt, and twist. Measure `WebHidInputSource.rateHz` on each test tablet and record it.
- Polling: WebHID delivers interrupt reports at the device rate (commonly 200 to 266 Hz for pen tablets **[A]**). There is no polling loop to configure on the web; the 200 Hz figure in the spec applies to native builds, where IOKit/libinput/RawInput deliver the same interrupt reports.
- Stroke smoothing: One Euro filter with raw-sample derivative, retuned for normalized units (β = 50, f_min = 1 Hz), plus bounded dead reckoning (8 ms max). Native test (`core/test/predictor_test.cpp`): jitter reduced 3.4x, mean lag 0.3% of canvas width at 0.5 units/s.

### 3.1 Brush dynamics mapping

```
radius     = r_base · (k_p · pressure^γ + (1 - k_p))              γ ∈ [0.5, 2], k_p ∈ [0, 1]
opacity    = a_base · (k_a · pressure + (1 - k_a))
tip_scale  = [1, cos(tilt_mag)]  rotated by atan2(tiltY, tiltX)   tilt_mag = sqrt(tiltX² + tiltY²) in radians
rotation   = barrel_rotation if present else stroke_direction
velocity_k = clamp(1 - k_v · |v| / v_ref, 0.2, 1)                 thins fast strokes (optional)
```

Pressure is linear in the HID field (0..16383) per the spec; the γ curve is the user-editable brush profile.

---

## 4. OMNI-Bridge Sync (Phase 4)

Implemented in `web/src/sync/` and `server/signaling.ts`.

### 4.1 Latency model (replaces the spec's 3 ms / 7 ms targets)

Measured quantities, all exposed through `BridgePeer.stats()`:

| Metric | Definition | Target (Wi-Fi 5/6, same AP) **[A]** |
|--------|------------|------------------------------------|
| RTT min | best ping over 32 samples | under 4 ms |
| RTT p99 | 99th percentile | under 25 ms |
| Jitter | p99 minus min | reported, no target |
| Clock offset drift | change per minute | under 1 ms |
| Stroke loss | missing seq / total per stroke | under 1% |

Input-to-photon on the iPad (local echo) is bounded by the iPad's own display pipeline, roughly one to two frames at 120 Hz (8 to 17 ms), and is independent of the network. The network affects only how far the host's view lags the iPad's and how often corrections are needed.

### 4.2 Local echo with host authority: state machine

```
iPad (client)                                     Host (authority)
-------------                                     ----------------
pen down ─▶ STROKE_BEGIN (control, reliable) ───▶ begin stroke, allocate strokeId state
each sample:
   predictor.feed()  ─▶ render locally (ECHO)
   TELEMETRY (unreliable) ─────────────────────▶ tracker.accept(); predictor.feed(); render (AUTH)
pen up ─▶ STROKE_END(count) ──────────────────▶ missing = tracker.end()
         ◀──────────────── STROKE_ACK(missing) ─   if missing: wait for resend
STROKE_RESEND(samples) ─────────────────────────▶ complete; replay stroke through brush engine
                                                   digest each touched tile (SHA-256 of RGBA16F)
         ◀──────────────── TILE_HASH(per tile) ─
compare with local digest; on mismatch:
         ◀──────────────── TILE_PATCH ──────────   (host pushes authoritative pixels)
apply patch; ECHO layer discarded for that stroke
```

Determinism requirement: both devices run the identical C++ brush raster on identical input. With zero loss the digests match and no patch is sent. Floating-point determinism across Apple GPU and desktop GPU is **not** guaranteed, so the digest covers the CPU-side stroke geometry (dab list) rather than the GPU output; pixels are patched only when geometry differs. **[A]** This needs validation once the brush raster exists.

### 4.3 Transport choice

| Path | Transport | Reliability | Expected RTT **[A]** |
|------|-----------|-------------|---------------------|
| Wi-Fi | WebRTC data channels, unordered, maxRetransmits 0 | lossy, lowest latency | 2 to 8 ms, spikes to 50 ms |
| USB | WebSocket over usbmuxd TCP forward (native companion required) | lossless, ordered | under 2 ms, no spikes |

usbmuxd carries TCP only; WebRTC's SCTP-over-DTLS-over-UDP cannot use it. The `Link` interface makes the swap invisible to the rest of the stack.

### 4.4 Correction policy (periodic validation from the owner's requirement)

- Every stroke: digest compare on completion (above).
- Every 2 s while idle: host sends TILE_HASH for the 16 most recently touched tiles; client re-requests any mismatch.
- On reconnect: STATE_SNAPSHOT (encrypted manifest delta since the client's last Lamport stamp) then full tile hash sweep of the visible viewport.

---

## 5. UI/UX Design System "Dark Studio Obsidian" (Phase 5)

### 5.1 Tokens

```
--obsidian-bg:        #0F0F0F   /* 6% luminance, sRGB; L* ≈ 6 in CIELAB */
--obsidian-panel:     #161616
--obsidian-border:    #8C8C8C   /* monochromatic silver, always 1px */
--obsidian-text:      #E6E6E6
--obsidian-text-dim:  #9A9A9A
--obsidian-accent:    #B8B8B8   /* no hue: colour validation requires a neutral chrome */
--radius:             2px
--border-width:       1px
--font-ui:            "Inter", system-ui, sans-serif
--font-mono:          "JetBrains Mono", ui-monospace, monospace
```

Rule: no saturated colour anywhere in chrome. Colour appears only inside the canvas, the colour wheel, and swatches.

### 5.2 Adaptive layout

| Detection | Layout | Trigger |
|-----------|--------|---------|
| Desktop | Dense docked toolbars, 4 panel columns, hover tooltips | `pointer: fine` and `hover: hover` media queries, width ≥ 1280 CSS px |
| Tablet / stylus | Radial menu on long-press or barrel button, panels collapse to edge tabs | `pointer: coarse`, or first `pointerType === "pen"` event |
| Hybrid | Switches live | Last input type wins; 300 ms debounce |

Radial menu geometry: 8 sectors, inner dead-zone radius 24 px, outer 96 px, item selected by release angle `floor((atan2(dy, dx) + π/8) / (π/4)) mod 8`.

### 5.3 Colour engineering

Working space: ACEScg (AP1 primaries, linear). Display conversions as 3x3 matrices followed by the display transfer function:

```
ACEScg → XYZ (D60):  [ 0.66245  0.13400  0.15619 ]
                      [ 0.27222  0.67408  0.05369 ]
                      [-0.00558  0.00407  1.01033 ]
XYZ D60 → D65: Bradford chromatic adaptation
XYZ (D65) → Rec.2020: [ 1.71665 -0.35567 -0.25337 ]
                      [-0.66668  1.61648  0.01577 ]
                      [ 0.01764 -0.04277  0.94210 ]
XYZ (D65) → P3-D65:   [ 2.49350 -0.93138 -0.40271 ]
                      [-0.82949  1.76266  0.02362 ]
                      [ 0.03585 -0.07617  0.95688 ]
XYZ (D65) → sRGB:     [ 3.24097 -1.53738 -0.49861 ]
                      [-0.96924  1.87597  0.04156 ]
                      [ 0.05563 -0.20398  1.05697 ]
```

Transfer functions: sRGB piecewise, P3 uses the sRGB curve, Rec.2020 uses BT.1886 (γ 2.4) or PQ for HDR output. WebGPU canvas configured with `colorSpace: "display-p3"` and `rgba16float` when `navigator.gpu` reports the feature, else sRGB `bgra8unorm` **[A]**.

CMYK soft proof: a 33³ LUT generated from an ICC profile (e.g. a standard coated-paper profile; the specific profile is a user choice) applied in pass 3; out-of-gamut pixels optionally flagged in a chequer overlay.

Spectral colour wheel: hue ring sampled in CIE L*C*h at fixed L* and C*, inner triangle in Oklab for perceptual uniformity; 16-bit per channel picking.

---

## 6. Production Logic (Phase 6)

### 6.1 Manga / webtoon engine

Panel slicing: a panel line is a polyline in DU. Dragging it splits the parent region polygon into two with the line as the shared edge (Weiler-Atherton clip). Each resulting region becomes a **boundary mask** stored as a vector path on a group layer; raster children are clipped at composite time, never destructively.

Screentone moiré control: dot pitch `p_screen` in DU; at viewport zoom z the rendered pitch is `p_screen · z` px. Moiré with the pixel grid appears when `p_screen · z` is within ±15% of an integer multiple of 1 px **[A]**. The engine renders tones procedurally in the fragment shader:

```
d = fract(R · uv)                         R: rotation (typically 45°), uv in screen px / pitch
dot = 1 - smoothstep(r - aa, r + aa, length(d - 0.5))
r = sqrt(coverage / π),  aa = fwidth(d)
```

Because the pattern is regenerated per zoom from the analytic definition, no resampling occurs and the beat frequency never forms. On export the pattern is baked at output DPI.

### 6.2 2D animation framework

Data model:

```
Timeline { fps: 24 | 12 | 30, frames: Frame[], tracks: Track[] }
Track    { id, kind: "drawing" | "camera" | "audio" | "dialog", layers: LayerRef[] }
Xsheet   { columns: Column[]; rows = frames }        // same data, vertical projection
Column   { trackId, cells: Cell[] }                   // Cell { frame, exposure: hold | key | tween, drawingId }
Keyframe { frame, value: Transform | Opacity | PathMorph, ease: Bezier(4) }
LipSync  { phonemes: [{ frame, viseme: "A"|"E"|"O"|"M"|"F"|"L"|"rest" }] }
```

Keyframe editor and Xsheet are two views over one store; edits in either dispatch the same CRDT ops (Section 2.1).

Onion skin: for offsets k ∈ [-N, +N], draw frame f+k with opacity `α(k) = curve(|k| / N)` where `curve` is a user Bezier defaulting to `(1 - t)²`. Vector-interpolated ghosts: when frames f and f+1 are vector drawings with matched path ids, the ghost at fractional time is the linear blend of control points (equal point count required; otherwise fall back to raster ghost).

### 6.3 3D NPR cel pipeline

Projection of 2D vector layers: either **planar projection** (layer plane placed in world space, texels sampled by ray-plane intersection) or **UV binding** (path rasterized into the mesh's UV texture).

Cel shading (fragment):

```
n_dot_l   = dot(normalize(N), normalize(L))
band      = step(t_shadow, n_dot_l) · (1 - w_shadow) + w_shadow      two-tone; add step(t_highlight, ...) for three-tone
colour    = base · band · shadow_tint
```

Ink outlines, two sources combined:

1. **Inverted hull**: second pass with back-face culling flipped, vertices offset along normals by `w_line / viewport_scale` (screen-constant width).
2. **Image-space edges**: Sobel on depth and on normal buffers; edge if `|∇depth| > τ_d` or `1 - dot(n_a, n_b) > τ_n`. Catches creases the hull misses.

Output of the NPR pass is a raster layer in the same tile system, so manga tools apply to it.

---

## 7. .omni Project Format

```
project.omni/                      (a directory, each file an encrypted asset per aead.ts)
  manifest.bin                     CRDT state: layer tree, timeline, brushes, colour settings
  layers/<layerId>/tiles/<level>/<x>_<y>.bin
  layers/<layerId>/paths.bin       vector paths (flatbuffer-style, float64 DU)
  meshes/<meshId>.bin              3D geometry (positions, normals, uv, indices)
  audio/<trackId>.bin
  thumbnails/<frame>.bin
```

Object ids are random 16-byte values; the server sees only their SHA-256.

---

## 8. Test Plan for Milestone 1 (web-only, Windows PC + iPad)

| Test | Device | Pass criterion |
|------|--------|----------------|
| Argon2id timing | iPad Safari, Windows Chrome | under 2 s per derivation |
| WebHID enumeration | Windows Chrome + USB tablet | `rateHz` ≥ 200 for 10 s; profile derived from descriptor |
| Pointer fallback | iPad Safari + Apple Pencil | pressure and tilt non-zero; coalesced events ≥ 120 Hz |
| Bridge RTT | iPad Safari ↔ Windows Chrome, same Wi-Fi | p50 under 8 ms, p99 under 25 ms over 5 min |
| Stroke loss | same | under 1% missing before resend; 0% after |
| OPFS throughput | both | 1 MiB chunk write + read under 10 ms in worker |
| Asset tamper | automated (vitest) | all five tamper cases rejected |

iPad note **[A]**: Safari on iPadOS supports WebRTC data channels, OPFS, WebCrypto, and Pointer Events with pressure/tilt; it does not support WebHID. The iPad therefore runs the client role through `PointerEventSource`, which is sufficient for Milestone 1.

---

## 9. Build and Run

```
npm install
npm run typecheck
npm test                       # 23 tests, Phases 2-4
npm run signaling              # ws://localhost:8787
g++ -std=c++20 -O2 -Icore/include core/src/input_bridge.cpp core/test/predictor_test.cpp -o predictor_test && ./predictor_test
emcmake cmake -S core -B build-wasm && cmake --build build-wasm     # requires Emscripten SDK
```

---

## 10. Open Decisions (owner's call)

1. Brush raster location: CPU (deterministic, slower) vs GPU compute (fast, non-deterministic across devices). Determines whether Section 4.2 digests can cover pixels or only geometry.
2. CRDT library: Yjs (mature, JS) vs Automerge (Rust/Wasm, matches C++-adjacent core) vs hand-written ops. Affects manifest format.
3. Signaling hosting: on the host laptop (LAN only, no cloud dependency) vs alongside the web app (simpler for first test, adds a hop).
4. Display colour space on Windows test machine: most laptop panels are sRGB; P3/Rec.2020 features cannot be validated without a wide-gamut monitor.
5. Which tablet model for the WebHID test. Vendor and model decide whether the OS hides the device from WebHID.

---

## 11. Loop 2 Status (2026-10-24): the studio application

`npm run dev` opens the working studio. Verified in headless Chromium (software GL): draw, undo, layers, tone layer, panel cut, 3D cel layer, color wheel, key insertion with onion skin, vault enroll + encrypted save (411 KB in 1.22 s). 30 automated tests pass.

| Spec item | Status | Where |
|-----------|--------|-------|
| 1.2 tiled raster, lazy 256 px tiles, dirty-rect redraw | done (Canvas 2D compositor) | `engine/document.ts`, `engine/renderer.ts` |
| 1.1 WebGPU compositor | not started; Canvas 2D runs on every target device first | Section 1.5 is the plan |
| 1.2 tri-mode: raster + vector + 3D layers in one document | done (vector paths render; vector *tools* pending) | `engine/document.ts` |
| 1.2 disk cache tiers | OPFS worker exists; GPU/RAM LRU not wired | `web/src/crypto/opfs-worker.ts` |
| 2.1 full key handling, OPFS, passkey PRF, encrypted save/load/export | done | `ui/vault-panel.ts` |
| 3.1 dynamics: pressure γ, min size, tilt ellipse, velocity thinning, One Euro | done (TS mirror of the C++ predictor) | `engine/brush.ts` |
| 3.1 WebHID into the brush engine | parser done; routing into the app waits on the hardware test | `web/src/input/` |
| 4 Bridge host/client in the app, replay with loss recovery | done; needs two devices to measure | `ui/bridge-panel.ts` |
| 5 Obsidian tokens, dense vs tablet layout, radial menu | done | `design/obsidian.css`, `ui/radial.ts` |
| 5 OKLCh wheel, sRGB/P3/Rec.2020/ACEScg readouts, CMYK soft proof (viewport LUT) | done; wide-gamut *output* needs a P3 canvas and a P3 monitor to verify | `engine/color.ts` |
| 6.1 panel slicing with gutters, non-destructive masks | done | `engine/panels.ts` |
| 6.1 procedural screentone, zoom-aware, moiré readout | done | `engine/screentone.ts` |
| 6.2 keyframe strip + Xsheet (exposure, visemes, dialog, notes), onion skin with opacity curves | done; vector-interpolated ghosts pending (needs vector tools) | `ui/timeline.ts` |
| 6.3 cel shader, inverted hull + Sobel ink, 2D planar projection, OBJ import | done | `engine/npr.ts` |

Known limits, stated plainly:
- Mouse pressure is constant (0.55 assumed); a pen is required to exercise dynamics.
- Dark region in the colour square is the sRGB gamut boundary rendered deliberately; switching gamut widens it only in readouts until the canvas itself is configured for P3.
- Undo for Bridge strokes is coarse (page-sized snapshot) until the brush engine reports its dirty rect before the first sample.
- Fonts load from Google Fonts; offline the UI falls back to system fonts.

Loop 3 candidates (owner's pick): WebGPU compositor; vector pen tool + interpolated onion skin; GPU/RAM tile LRU with OPFS spill; WebHID → brush routing after the Wacom test; Yjs manifest CRDT over the sync schema in Section 2.1.


---

## 12. Loop 3 Status (2026-10-24): paint quality, color, vector

Verified headless (software GL): zero page errors across a scripted session covering every preset, fill, undo/redo, vector pen + node edits + rasterize, tone layer, panel cut, 3D layer, key insert, playback, vault enroll/save/load. 34 automated tests pass. Panel overflow check passes for all eight panels at 272 px.

| Item | What changed | Where |
|------|--------------|-------|
| Stroke buffer model | Strokes render into a per-stroke buffer with per-dab FLOW, composited once with stroke OPACITY (and blend / erase). Matches Clip Studio / Procreate behaviour; overlaps inside a stroke no longer darken past the opacity cap. | `engine/brush.ts`, `engine/renderer.ts` (`drawLayerWithStroke`) |
| Anti-aliasing | Tip = solid core to hardness·r, quadratic falloff to r, 0.5 px AA skirt outside r; sub-pixel dabs use area-proportional alpha. Coverage is preserved at every radius, which removed the gaps and kinks seen at 100 % zoom. | `StrokeEngine.tip()` |
| Pressure | User-editable cubic Bézier pressure curve per preset (drag handles), independent size and flow mapping, live stroke-strength meter. Mouse input is treated as constant 0.55; pen input uses `PointerEvent.pressure` with coalesced events, so harder pressing widens and darkens the stroke exactly per the curve. | `ui/brush-panel.ts` |
| Presets | 13 presets in 6 categories: G-Pen, Maru, Brush Ink, Technical 0.3, Pencil 2B / HB (paper-locked grain, pressure fills the valleys), Marker (multiply), Round Paint, Watercolor (multiply, low flow, grain), Airbrush, Smudge (pixel drag), Eraser hard / soft. Jitter, speed thinning, tilt ellipse available on all. | `PRESETS` |
| Fill | Flood fill (G) on the flattened composite with tolerance and gap-closing expand, written to the active layer, undoable. | `floodFill` |
| Colour wheel v2 | OKLCh ring at uniform brightness, hue/white/black triangle interpolated in Oklab, harmonies (complementary, analogous, triadic, split, tetradic), L/C/H/alpha sliders, previous/current compare, ΔE readout, gamut and CMYK readouts, four manga palettes. | `ui/color-wheel.ts` |
| Vector pen | V draws (One Euro + RDP to editable nodes), A edits (drag, shift-click delete, double-click insert, alt-drag move path), rasterize to a new layer; variable-width outline polygon rendering so lines are crisp at any zoom. | `engine/vector.ts`, `ui/viewport.ts` |
| Interpolated onion skin | Paths with the same id in adjacent keys are arc-length resampled and tweened for the ghost; no equal-node-count restriction. | `renderer.onion()` |
| Timeline | Playback no longer rebuilds the transport each frame (buttons stayed stable under test). | `ui/timeline.ts` |
| Undo | Generic reversible entries for vector and node edits alongside tile snapshots. | `engine/history.ts` |

Still open from the spec, unchanged: WebGPU compositor (Canvas 2D at present), GPU/RAM tile LRU with OPFS spill, WebHID routing into the brush (waits on a tablet), two-device Bridge latency numbers.


---

## 13. Loop 4 Status (2026-10-24): launch, stroke accuracy, and the four open gaps

### Launch
`start.cmd` (Windows) / `start.sh` installs on first run, starts Vite and opens http://localhost:5173; `npm run dev` also auto-opens. If the browser already holds a key bundle, an unlock box appears over the canvas with the password field focused (Enter unlocks, one tap for passkey, Skip draws without the vault) and the last encrypted project loads automatically. If not enrolled, the app opens straight on the canvas.

### Stroke accuracy
- Entry/exit taper per preset (deferred-dab exit taper, no re-render), pull-string stabilizer in screen pixels, brush-size cursor outline.
- Coverage-preserving anti-aliased tip (loop 3) verified again at 100 % zoom with tapers.

### Gap 1: WebGPU compositor (`engine/gpu-compositor.ts`)
Implemented: tile textures with generation-based upload and a 256 MB LRU, per-layer ping-pong blend pass with all seven blend modes, panel masks as GPU textures, analytic screentone in the fragment shader (4x4 supersampled), NPR and vector layers as uploaded quads, onion tint pass, in-progress stroke buffer, dirty-rect scissor with a persistent frame texture, CMYK soft proof in the present shader. Both WGSL modules parse (wgsl_reflect). **Not executed**: the build sandbox's Chromium has no WebGPU adapter, so the path is feature-detected and falls back to Canvas 2D; the status bar shows which compositor is active. First run on a WebGPU browser is the owner's test. The Canvas 2D path passed the full QA scenario after the integration.

### Gap 2: tile cache tiers (`engine/tile-cache.ts`)
HOT (canvas) / WARM (PNG in RAM) / COLD (PNG in OPFS via the sync-access worker). Budget 25 % of device memory (256 MB to 2 GB). All tier moves run on one promise chain, so frame changes never race demotion. Measured headless with a 1 MB budget: 312 tiles across 4 drawings → 20 MB hot (current drawing), 2.5 MB cold; returning to the first drawing promoted its tiles and the viewport matched the pre-demotion capture to within PNG alpha quantization (97 edge pixels differing, max 101/255, invisible). Transient stroke buffers are excluded from caching.

### Gap 3: WebHID into the brush (`ui/hid.ts`)
Tablet reports → HidReportParser → StrokeDriver (the same begin/move/end the pointer path uses). Tip switch starts and ends strokes, the eraser bit swaps presets for that stroke, the dial resizes the brush, express keys 0/1 undo/redo. Verified with a synthetic 12-byte device: 205 reports produced one pressure-tapered stroke and two dial steps. Real-tablet behaviour on Windows still depends on whether the OS driver claims the device (Section 8 test).

### Gap 4: Bridge latency (two headless browsers on one machine, real WebRTC + the signaling relay)

| Metric | Host | Client |
|--------|------|--------|
| ICE pair | host ↔ host (loopback) | |
| RTT min | 0.9 ms | 0.9 ms |
| RTT p50 | 1.3 ms | 1.4 ms |
| RTT p99 | 230 ms | 153 ms |
| Telemetry samples | 1205 received | 1205 sent |
| Loss before resend | 0 % | |
| Strokes replayed on host | 5 of 5, pixel-correct | |

Interpretation: p50 is the transport; p99 is the host's main thread stalling under software rendering while it replays strokes, because the ping handler shares that thread. On a GPU-backed browser the stall shrinks, and the measurement itself should move to a worker in the next loop. Wi-Fi numbers between a real iPad and PC remain to be taken; the harness (`npm run signaling`, Host, Join) is what collects them. A host-side ordering bug (StrokeEnd overtaking unordered telemetry, leaving strokes uncommitted) was found and fixed by this test: the layer is now written only from the complete ordered sample set.


---

## 14. Loop 5 Status (2026-10-24): undo correctness and brush families

### Undo / redo (bug reported by the owner from a real session)
Root cause: `History.begin` snapshotted a guessed rectangle around the first sample; `commit` then widened the rect to the stroke's real extent, so `restore` treated tiles it had never captured as "did not exist" and deleted them, taking neighbouring strokes along. Fix: tile-level transactions. The engine calls `history.capture(layer, tx, ty)` before the first write to each tile (also for smudge and blur, which write the layer directly) and `restore` touches only captured tiles. Verified by script: three overlapping strokes, undo twice, redo twice, every state pixel-identical to the matching earlier state.

### Brush families (`engine/brush.ts`, 26 presets)
Each parameter below is a distinct physical behaviour, not a styling knob:

| Mechanism | What it models | Presets |
|-----------|----------------|---------|
| Tip shape: round / flat (angle, ratio) / bristle (count, spread) | chisel markers are thin on one axis; hog brushes leave streaks that follow the stroke | Marker Chisel, Oil Flat, Dry Brush |
| Wet edge | pigment settling at the rim of a wet dab | Watercolor, Ink Wash, Brush Ink |
| Wet mix | the dab takes on the colour already under it (8×8 sample, with the in-progress stroke included) | Round Paint, Oil Flat, Gouache, Mixer |
| Pooling | a nib or brush loads more ink when it lingers (slow = wider) | G-Pen, Brush Ink |
| Tilt size / tilt flow | a pencil laid flat covers more and deposits less per pass | Pencil 2B / 6B / HB |
| Paper grain (pressure fills the valleys) | tooth of the paper | all pencils, Dry Brush, Gouache, Kneaded |
| Scatter + droplet count | spatter and stipple instead of a disc | Spray, Stipple |
| Speed thinning + entry/exit taper | nib dynamics | all inks |
| Flow vs opacity, multiply blend | marker layering darkens across strokes only | Markers, Col-erase, Watercolor |
| Smudge / Blur kinds | move or soften existing pixels; blur replaces under the tip instead of accumulating | FX |
| Mouse pressure from speed (default on) | slow = firm, fast = light, so dynamics show without a stylus | all |

Every preset carries a one-line description shown in the panel, and the panel exposes the family controls (tip shape, bristles, wet mix, wet edge, pooling, tilt, scatter). The live preview now uses a slow-fast-slow path with a tilt ramp over two colour bands so pooling, speed thinning, tilt shading and mixing are all visible at a glance.

## 15. Fill tool and brush mechanics (loop 6)

### 15.1 Flood fill (`engine/brush.ts: floodFill`, `polygonFill`)
- Reference image: `renderer.flatten(doc, scale, layerIds?)` backed with white, at most 2048 px on the long side (scale < 1 for larger pages; the result is resampled into the target layer's tiles).
- Modes: `contiguous` (scanline flood from the click) and `global` (every matching pixel). Reference: all visible layers or the current layer only.
- Tolerance: squared RGBA distance against the clicked colour.
- Close gaps (0..24 px): non-matching pixels are dilated N times to form a virtual obstacle map, the flood runs against it, then the region grows back N px onto truly matching pixels only. A gap narrower than ~2N px is bridged; the bridge is clipped to the dilated zone, which is why a small diamond can appear at the gap (same behaviour as Clip Studio's "close gap").
- Expand: the region is dilated under line art. The core region is composited `source-over`; the dilated ring and the 1 px anti-alias feather are composited `destination-over`, so existing ink is never overwritten by the fill.
- Enclose-and-fill: dragging with the fill tool draws a lasso; on release the polygon is rasterised with the canvas scanline filler (anti-aliased) into the layer.
- Undo: `history.captureRect` snapshots every tile the fill can touch before writing; the entry restores pixel-exactly (`fill.py`).

### 15.2 New per-brush mechanics
| Mechanic | Field | Who uses it | What it does |
|---|---|---|---|
| Nib follows stroke | `tipFollow` | Ribbon Pen | flat tip rotates to stay perpendicular to the direction of travel: full width in every direction, width changes only through pressure |
| Fixed chisel | `tipAngleDeg` (existing) | Calligraphy, Marker Chisel | width depends on the angle between the stroke and the nib: thick on one diagonal, hairline across it |
| Ink reservoir | `inkLoad`, `inkMin` | Brush Ink, Dry Brush, Round Paint | flow decays `1 - (1 - inkMin)(1 - e^(-arc/inkLoad))` along the stroke and reloads on lift |
| Hardness by pressure | `hardnessByPressure` | Round Paint | light pressure softens the tip edge, firm pressure gives a crisp edge (tip cache keyed by quantised hardness) |

Preset count: 28 (ink 8, pencil 5, paint 8, air 3, fx 2, erase 3). All fields are editable in the Brush panel under "Tip & media" and serialise with the preset.

### 15.3 Verification (headless Chromium, Canvas 2D path)
- `fill.py`: Technical-pen circle with a ~10 px gap. Close gaps 0: flood leaks to the page (expected). Close gaps 12: fill stays inside, line art intact, lasso triangle filled, global refill recolours only the matched region. Undo labels `Brush, Fill, Enclose fill, Fill`.
- `families2.py`: 22 presets side by side, Ribbon vs Calligraphy visibly distinct on the same wave.
- `qa.py`, `undo.py`: zero page errors, undo/redo pixel-identical. `vitest`: 34/34.

## 16. Loop 7: fill v3, cursors, selections, autosave, desktop shell

### 16.1 Fill v3 (`engine/brush.ts: floodFill`)
- Reference at document resolution up to 16 Mpx (A4 @ 300 dpi = 8.7 Mpx); larger pages sample down.
- Gap search on a downsampled mask (<= 1 Mpx, conservative) with a chamfer 3-4 distance transform: gaps 3, 6, 12, 24, 48 px (max slider to 160), then binary refinement to the smallest radius that encloses. Each attempt is one scanline flood over "distance to ink > g".
- `leaked` = region touches the page border. With Stop leaks on, nothing is written and the panel explains. Final flood runs only inside the enclosed region's window.
- Grow-back with a feature transform (nearest ink pixel, nearest region pixel): a pixel is kept when the two lie on opposite sides of it, which removes the half-disc bulge of a plain opening and leaves a nearly flat bridge across the gap.
- Expand ring and 1 px feather are composited destination-over, so ink is never overwritten. Measured: 280 to 440 ms for an enclosed shape on the A4 page in headless Chromium (`__fillProf` on window breaks it down).

### 16.2 Cursors (`ui/cursor.ts`)
Footprint ring at brush diameter in difference blend (dashed for erasers, mark for smudge/blur), centre dot above 14 px, crosshair below 6 px, dimmed off-page. SVG glyph cursors with hotspots for fill, lasso, marquee, wand, move, eyedropper, pen, node, panel knife, zoom, rotate, open and closed hand. Transform handles switch to the OS resize cursors.

### 16.3 Selections (`engine/selection.ts`, `ui/select-tools.ts`, `ui/selection-overlay.ts`)
- Mask = binary alpha canvas at document resolution plus bounds. Binary alpha makes clipping idempotent, so the live stroke buffer is clipped after every `move()` and again at `commit()` with no edge darkening.
- Tools: marquee (rect, ellipse, lasso, polygon with Enter), magic wand (reuses `floodFill` with `maskOnly`), move/transform (lift = cut into a floating canvas; drag, 8 scale handles, rotation knob, Shift constrains; Enter commits, Esc rolls back via `History.rollback()`).
- Modes: replace, add (Shift), subtract (Alt), intersect (Shift+Alt). Ctrl+A, Ctrl+D, Ctrl+Shift+I, Delete, Ctrl+C/X/V (paste to a new layer), Grow/Shrink 2 px.
- Paint, erase, flood fill and enclose fill respect the selection; smudge and blur skip dabs outside it.
- Marching ants are derived from the mask in screen space (1 px rim = mask minus the intersection of its four 1 px shifts, striped with an animated pattern), so wand regions get an outline too. The animation loop runs only while a selection exists.
- One undo entry per move covers the cut, the stamp and the mask change (`History.commit(rect, also)`).

### 16.4 Autosave and recovery (`ui/autosave.ts`)
Every 120 s (30 s to 10 min) while dirty, on tab hide and before unload. Vault unlocked: AES-GCM asset in slot RECOVERY_ID. Locked: plain bytes in OPFS `recovery/plain.omniraw` (device-local, user-switchable off; documented trade-off against the zero-knowledge rule). On startup, a snapshot newer than the last explicit save shows Restore / Discard in the Vault panel. Verified: autosave 215 KB plain in 213 ms, reload, restore, centre pixel identical.

### 16.5 Desktop shell (`desktop/src-tauri`, `ui/native.ts`)
Tauri 2 scaffold: window, CSP with COOP/COEP for SharedArrayBuffer, `.omni` file association, capabilities, commands `read_project`, `write_project` (temp file + rename, SHA-256 echo), `host_info`, `pending_open_files`, `open-file` event. `cargo check` resolved every crate but stopped at the GTK system libraries missing in the sandbox, so the shell is unbuilt until it is run on a machine with the Tauri prerequisites. Native tablet hooks are the next step (see desktop/README.md).

### 16.6 Status against the roadmap
Done here: 2 (selections), 9 in part (autosave/recovery; no persistent undo, no CRDT server run), 1 scaffolded. Not started: 3 text/balloons, 4 rulers/perspective, 5 layer groups/clipping masks, 6 PSD/PDF, 7 audio/export, 8 Wasm brush core, 10 polish.

## 17. Loop 8: icons, production modes, balloons, rulers, layer groups, interchange, animation export, persistence, native core

### 17.1 Icons (`ui/icons.ts`)
Original 24 px line glyphs (1.5 px stroke) showing each tool in use; rendered inline as SVG, tinted by CSS. Cursor glyphs stay in `ui/cursor.ts`.

### 17.2 Production modes (`Doc.mode`, `AppState.setMode`)
`manga` hides the timeline (grid row 0) and leads with the Manga tab; `anime` restores timeline and Xsheet. Tab toggles, menubar buttons, saved in the manifest.

### 17.3 Manga tab (`engine/manga.ts`, `ui/manga-panel.ts`)
- Page presets: B5 doujinshi 350 dpi (3 mm bleed), A4, B4 magazine 600 dpi, webtoon slice/tall, 4-koma; bleed and safe guides drawn by the renderer.
- Panel templates: 12 layouts as fractions of the safe area with symmetric gutters; Shift-click slants gutters. Undoable; refine with the cut tool.
- Balloons: document-level vector objects drawn above layers in both compositors and in `flatten()` (so every export carries them). Kinds: speech (tail merged into the outline with a curved quadratic), thought (bumped cloud + 3-circle trail), shout (jagged burst, deterministic spikes), whisper (dashed), caption, none. Lettering: word wrap, vertical tategaki with column flow right-to-left and rotated long-vowel marks/brackets. Text tool X: drag to place, drag to move, blue dot aims the tail, Delete removes; all undoable.

### 17.4 Rulers (`AppState.ruler`, viewport `applyRuler`)
Line ruler: samples projected onto the line through the stroke's first point, parallel to a-b. Perspective: up to 3 vanishing points; the ray is chosen by the first 6 px of motion (max |dot| with the direction to each point), samples held at the anchor until then. Overlay draws the parallel family / rays / horizon.

### 17.5 Layer groups and clipping masks
`Layer.parent`, `Layer.collapsed`, `Layer.clipBelow`. `effectiveLayer()` multiplies visibility and opacity down the group chain; `clipBase()` finds the nearest unclipped sibling below. Canvas 2D: clipped layer drawn to a screen-space scratch, multiplied by the base alpha assembled on a second scratch (a per-tile destination-in keeps only the last tile: found by the test, fixed), then composited with its own blend. WebGPU: the base is drawn into `clipTex` and the blend shader multiplies `src` by its alpha (`params.w`). Ids are remapped on load, including parents.

### 17.6 Interchange (`engine/export.ts`)
PSD export (8-bit RGBA, raw channels, resolution resource, groups as section dividers, clipping flag, blend keys) opens in Pillow and round-trips through the importer (RLE and raw, groups rebuilt). PDF: one page, DCT image, MediaBox from dpi (poppler reports A4, 300 dpi). PNG with pHYs.

### 17.7 Animation (`engine/anim-export.ts`, timeline)
Audio track decoded with Web Audio, per-frame RMS column in the Xsheet, playback started at the current frame with offset; the transport clock drives frames so sound and picture stay aligned. Export: PNG sequence in a store-only ZIP, animated GIF (median-cut, Floyd-Steinberg, LZW, loop), WebM through MediaRecorder on a timed canvas stream (real-time capture; headless Chromium captured 4 of 6 frames at 24 fps, real hardware should capture all; the PNG sequence is the lossless path).

### 17.8 Persistence and sync
Undo entries (tile snapshots as PNG) are written next to the recovery snapshot and restored after reload with id remapping (`History.exportEntries/importEntries`). Sync store in `server/signaling.ts`: `PUT/GET /sync/<sha256(objectId)>` with `x-lamport`, last writer wins, 409 on stale; CORS + CORP headers for the COEP page. The server sees hash, length, ciphertext and Lamport only. Not a CRDT: concurrent stroke merging is not implemented; two devices editing at once resolve by Lamport order with a pull-then-push rule.

### 17.9 Settings (`ui/keymap.ts`, `ui/settings-panel.ts`)
Rebindable shortcuts with conflict detection, persisted in localStorage; 4 workspace layouts (CSS variables); Tab toggles the production mode.

### 17.10 Native brush core (`core/wasm/brush_core.cpp`, `engine/wasm-brush.ts`)
Freestanding C++ compiled with clang to wasm32 (2.8 KB, no Emscripten): tile mirrors in Wasm memory, premultiplied source-over dabs with the same coverage profile as the Canvas tip, blitted with one putImageData per touched tile per pointer move. Measured in headless Chromium: 73k dabs/s wasm vs 135k dabs/s for the GPU-backed Canvas 2D drawImage path, so the wasm path is off by default (Settings toggle + benchmark). It becomes worthwhile with SIMD batching and when the compositor reads Wasm memory directly instead of putImageData.

### 17.11 Decisions after review
- Crash safety over strict zero-knowledge while locked: `plainWhenLocked` stays **on** (device-local plaintext recovery snapshot in OPFS when no K_d is in memory). Rationale recorded by the project owner: a crash during a demo is the likelier loss. The toggle remains in the Vault tab.
- Shortcut tooltips (`ui/tooltip.ts`): every control with a binding shows a styled tooltip with a key chip after 220 ms; bindings come from the live keymap, so rebinding in Settings updates them. Native `title` tooltips are suppressed once an element is hovered.

## 18. Loop 9: redesign, surface, roadmap groups A, B, C

### 18.1 Shell and looks (`ui/shell.ts`, `ui/theme.ts`, `design/obsidian.css`)
- Three looks on one token set: Studio Obsidian (spec), Noir Champagne (gold accent, glass), Gallery Light. `data-theme` on `<html>`, remembered in localStorage.
- Ribbon: brand, Manga/Anime segmented switch, mode-specific actions, theme select, tablet, compositor, tablet layout, vault chip. Quick bar over the canvas: tool, preset, size, opacity, stabiliser, colour, undo/redo, zoom. Tools grouped (draw, select, vector, guides, view). Right dock = panel + icon rail (`ICONS` layers, brush, palette, tone, book, page, cube, link, lock, gear).
- Surface behind the paper (`engine/surface.ts`): colour, gradient, image (cover/tile, dim), six procedural textures made seamless by half-offset blending; CSS background of the viewport; both compositors render transparent outside the page (Canvas 2D alpha context + clearRect; WebGPU premultiplied canvas, transparent clears, present writes `rgb*a, a`); page drop shadow in device pixels; optional in exports. Saved with the document.

### 18.2 Group A
- Symmetry: mirror (axis angle) and radial (2 to 24, optional mirror) as extra `StrokeEngine`s fed transformed samples; live preview through `RenderOptions.extraStrokes` in both compositors; one history transaction.
- Rulers: curve (2 to 4 control points sampled to 240 segments, nearest-segment projection) and ellipse (nearest angle in normalised space). Placement sub-mode in the Brush tab.
- Custom tips: `tipShape: "custom"` with `tipImage` (alpha or luminance mask, cached at 256 px), optional stroke-following rotation, library in localStorage. Dual brush: second tip intersected per dab (`destination-in`) with size ratio and random spin; presets Rake, Chalk.

### 18.3 Group B
- Tones: shapes noise and sand (hash threshold), gradient density between two DU points; 2D path renders a screen-space field (cached per view), WebGPU evaluates in the tile shader (tint = gradient points, params.z = end density). Paste tone fills a selection onto a tone layer.
- Story (`ui/story.ts`): pages as Docs, strip with thumbnails, add/duplicate/reorder/remove, RTL order, chapter export (multi-page PDF `exportPdfPages`, PNG ZIP). Container "OMNISTORY1" used by vault save, autosave and sync.
- Text: curated font families plus Local Font Access; ruby markup 漢字《かんじ》 rendered at 50% above the base (horizontal layout).

### 18.4 Group C (`engine/tween.ts`, `ui/motion-panel.ts`)
- Layer keys: x, y, scale, rotation about a pivot, opacity, cubic-bezier ease per key (presets + drag editor). Evaluated per frame in the 2D renderer, flatten and the WebGPU compositor (layer affine composed into the view matrix). Motion path and key diamonds on the overlay.
- Camera keys: centre, zoom (log-interpolated), rotation; field guide with action-safe inset in the viewport; animation export renders each frame through the camera.
- Verified: 12-frame PNG sequence with the red layer tracking the camera; layer at frame 6 interpolated to 38°, 0.79 scale, 75% opacity.

### 18.5 Not done
CMYK/ICC print export, liquify/warp, 3D figures, text on a path, lip-sync detection, MP4 via WebCodecs, CRDT merge, auto-update and signing, localisation.

## 19. Loop 10: brush engine v4, gradient tool, live sessions

### 19.1 Brush engine v4 (`engine/brush.ts`)
New per-preset mechanics, all exposed in the Brush tab: `sizeNoise` (ragged edge), `flowNoise` (broken deposit), `opacityByPressure` (stroke opacity ceiling from peak pressure, the "builds dark only when pressed" pencil rule), `nibFlex` + `nibAngleDeg` (round nib thins along a fixed angle). Preset set grown to 49 and regrouped after the Clip Studio tool guidance: pencils show tooth and widen when tilted (Graphite Control, Charcoal, Conte); pens keep constant opacity with pressure driving width only (G-Pen, Real G-Pen with a worn nib, Brush Pen, Fineliner, Gel Pen, Ballpoint, Sketch Pen); hatching tools (Crosshatch dual, Ink Stippling, Rake); markers in multiply (Highlighter, Real Marker); paint with mixing (Oil Brushy, Oil Smooth, Watercolor Edge); airbrushes that build over passes (round, square, raw). Family sheet: `families3.png`.

### 19.2 Gradient tool (D) and transform shortcut
Drag sets direction and length; linear or radial; ends transparent or at a second colour; fills the selection or the whole layer; rasterised on a scratch layer, clipped to the selection, composited, one undo entry. Ctrl+T lifts the current selection into a floating transform (the move tool's handles) so "select a part, drag it" works the way Krita, SAI and Photoshop users expect: M or W to select, Ctrl+T or T, drag, Enter.

### 19.3 Live sessions (`ui/collab.ts`, `server/signaling.ts` `/collab`)
- Relay: rooms of N members, server-stamped `from`, direct `to`, `exclude` for accepted changes. New joiner gets a snapshot (packed story + ownership masks) from the oldest member.
- Messages: `stroke` (preset, colour, layer index, samples; replayed through a `StrokeEngine` so remote pixels are identical), `patch` (fills, gradients, lasso fills as PNG tiles), `layer-add`, `balloon`, `undo`/`redo` by entry id, `request`/`decision`/`revoke-grant`.
- History: entries carry `id` and `author`; `undoBy(author)` reverts the author's newest entry selectively (pixels restored only where the layer still holds that entry's result), so Ctrl+Z never touches another artist's work; peers apply the same id.
- Ownership: a byte per pixel per tile names the last painter. A commit that disturbs enough of another present artist's work on that layer (fixed 25 px in this loop; replaced by the adaptive rule in 20.7) becomes provisional: applied locally, sent as a `request` to the owner only; the owner's popup offers Accept / Reject / Always accept (this layer). Reject reverts it on the requester (`History.revoke`) with a log line; Accept applies it on the owner and the requester broadcasts to everyone else; Always accept stores a grant (revocable in the Live tab). Ownership is updated only when a change is accepted or unchallenged, which is what keeps a rejected erase from silently clearing the owner's claim (found by the test, fixed).
- Verified with three headless browsers (`live.py`, `live2.py`): stroke relay both ways, no popup without conflict, popup on erase over another's stroke, reject reverts, always-accept applies and silences later requests, per-author undo on both sides with identical histories, late joiner receives the snapshot, interleaved strokes, fill patches, layer add.
- Caveats to carry into the write-up: the relay sees plaintext strokes and snapshots (it is a LAN/studio tool, not the zero-knowledge sync store); no reconnection/backfill after a dropped socket yet; ownership is per last painter, so semi-transparent overlaps go to the newest hand.

## 20. Loop 11: natural media (watercolour, acrylic, sponge), adaptive conflict rule

### 20.1 Why a simulation and not more presets
The brush engine up to v4 stamps tips into a stroke buffer and composites once at lift. That model cannot do the things the technique sheets are about: a wash that keeps moving after the brush leaves (wet-in-wet, blooms, edge darkening), a thirsty brush that takes pigment away, a glaze that multiplies with what is under it, paint with a surface that catches light. `engine/media.ts` adds two per-layer fields that live between strokes, and the render loop advances them.

### 20.2 Watercolour: `WetField`
- Resolution: half the document, per touched 256 px tile (one "cell" = 128×128 samples). Each sample holds water `w` (0..1), pigment as RGB absorbance `a` (three floats), a paper-tooth value (precomputed procedural cold-press texture, locked to document coordinates so every stroke sees the same paper), an age and a fixed flag. The cell also keeps a `base` snapshot of the tile pixels taken when it first got wet, and the tile generation it last wrote.
- Deposit (`dab`): a footprint sampler (disc, the brush's own tip canvas for flat/bristle/custom tips, or a sponge mask) gives coverage per sample. Water is added; pigment moves toward a target absorbance `-ln(rgb/255)/k · conc` where `conc` comes from the pigment load, so a colour saturates at the swatch instead of stacking to black. Into a wet pool the new pigment pulls the existing colour toward itself (mixing); onto dry or fixed paint it only adds (glazing, subtractive: yellow over dry blue reads green). Dry-brush: with `water < 0.3` samples whose tooth is above `0.25 + 1.6·water + 0.3·pressure` get nothing, so hairs skip the valleys. Lift: a thirsty brush multiplies absorbance down where water is present. Bloom: a wet dab landing on a sample that is drying (little water, pigment, not fixed) pushes its pigment down and overfills it with water, which the next ticks spread outward into the cauliflower rim.
- Tick (`tick`, called every frame while any field is wet): evaporation scaled by `1 + 4·rim + thin` and the paper tooth (the rim of a wet region and thin films dry first); water and pigment diffuse with an explicit step clamped at 0.24 for stability; the interior loses pigment in proportion to `rim` and samples next to drier samples gain it (edge darkening); granulation moves pigment from tooth hills into valleys. Neighbouring cells exchange across their borders, and a wet border wakes the neighbour cell, so washes are seamless across tiles.
- Present: transmission `T = exp(-k·A)` per channel (table lookup), alpha `1 - mean(T) + sheen·w`, composited over the base so a glaze multiplies the base where it exists and shows its own colour over bare paper. Written straight into the layer tiles; the stroke buffer stays empty for wet strokes.
- Lifetime and safety: a wet stroke captures its tiles in history through the field's `beforeWrite`; undo/redo call `resetMedia(layer)` so a restored tile is never overwritten by a stale render. If anything else writes a tile the field is watching (fill, gradient, paste, a dry brush, a peer's stroke), the next access sees the tile generation moved and *adopts* the current pixels as the new base with the wash fixed (`adopt`), which is what makes "paint a dry stroke on a wet layer" safe. A dry-media stroke started on a wet layer dries it first. `tickMedia` forgets a field once it is dry; "Dry layer now" in the Brush tab does it on demand. Effects (salt, rubbing alcohol, sandpaper) are dabs that act on the field instead of adding pigment.
- Cost: a tick is ~16k samples × 3 channels per wet cell; a 6-tile wash ticks in well under a frame and present is throttled to 20 Hz. Drying time is a preset parameter (0.5–30 s).

### 20.3 Acrylic: `BodyField`
- Per tile height (`Float32Array` 256²) and a laid-at timestamp per pixel. Each paint dab adds body under its footprint (bristle tips add ridges that run along the stroke); `openness(x,y)` decays from 1 to 0 over the preset's open time, and presets with `mixOpen` scale wet mixing by it, so paint blends with what was laid in the last half minute and sits on top of what has set. Knife tools `scrape` body first (sgraffito uses an eraser kind with scrape).
- At commit the dirty tiles are lit: normal from the Sobel gradient of the height, a fixed key light from the top-left, diffuse term scaled by `relief`, Blinn-style specular scaled by `gloss` (gel medium and gloss varnish presets). The height is then damped to 30% so a repeated bake does not double a ridge. Because the shading is in the pixels, impasto exports, syncs and shows on both compositors.
- Dry brush and scumble reuse the paper-locked grain mask and deposit noise of v4; drips reuse pooling (slow movement swells the line).

### 20.4 Sponge
Procedural Worley masks at 256²: cell walls become the sponge body, cells are the holes, the outline is torn by low-frequency noise and the body is speckled (variants natural / sea / stipple / synthetic, different point counts and hole fractions). `tipShape: "sponge"` stamps the mask (random spin per dab when `spinTip`) through the normal pipeline, and the same mask is the footprint for wet dabs, so a wet sponge lifts or lays pigment in the cell pattern.

### 20.5 Presets (42 new) and panel
Water: Flat Wash, Graded Wash (reservoir fade), Wet-in-Wet, Wet-on-Dry, Round Sable, Detail Rigger, Glaze, Dry Brush, Scumble, Water Only, Lift Out, Wipe Out, Pushing Pigment, Granulating, Salt, Rubbing Alcohol, Sandpaper, Splatter, Wet Sponge. Acrylic: Round, Flat Bristle, Dry Brush, Scumble, Glaze, Blend Soft, Impasto Knife, Knife Edge, Modelling Paste, Gel Medium, Sgraffito, Oil Pastel, Paint Pen, Splatter, Drips, Stencil Dab. Sponge: Natural, Sea, Stipple, Synthetic, Sponge Wash, Sponge Lift, Sponge Eraser. The Brush tab gained three categories, a Natural media section (media select; water/pigment/spread/edge darkening/granulation/bloom/lift/dry time/pigment strength, effect, Dry layer now with the layer's wet state; body/relief/gloss/open time/mix open/scrape) and a sponge tip shape with kind and spin. The preview runs 4 s of simulated drying so the thumbnail shows the dried wash.

### 20.6 Verified (`media.py`, screenshots `media_sheet.png`, `media_wet.png`, `media_dry.png`, `previews.png`)
All 42 presets stroke without errors; red dropped into a wet blue wash mixes toward red with a purple fringe (centre 199,72,58 after drying) while yellow glazed over dry blue reads green-blue (55,100,116); lift out leaves a soft lighter band (133,189,224 vs 63,133,194); a water drop on a drying wash leaves a paler centre inside a darker ring; salt and alcohol leave pale stars and rings; the knife ribbon and flat bristle show baked ridges; sponge dabs show cells; sgraffito scratches through acrylic; undo of acrylic and sgraffito restores the tile cleanly; the drying loop ends with zero active fields. Bugs found by the screenshots and fixed: pigment stacking to black (replaced by the target model), a dry stroke on a wet layer being overwritten by the field's stale base (adopt-on-generation-change), notches in the dark rim at tile borders (cross-cell neighbours), explicit diffusion unstable at low frame rates (clamp).

### 20.7 Adaptive conflict rule (live sessions)
`conflicts()` no longer compares against a fixed 25 px. It counts `total` changed pixels in the entry and `px` of them owned by another present artist, and whether the change is a removal (`after alpha < before alpha` on most of those pixels, or an Erase label). It asks when `px >= floor` and (`px/total >= ratio` or `px >= 400·s`), with floor 12 px and ratio 4% for removals, 25 px and 12% for painting over; `s` is a per-browser sensitivity (0.3 asks often, 3 asks rarely) exposed as a slider in the Live tab. Rationale: a big fill that grazes someone's line should not interrupt them (tiny share of the stroke), erasing part of their line should (removal, meaningful share), and covering a large area of their work should always ask. `live.py` still passes: no popup for a non-overlapping stroke, popup on the erase, none after always-accept.

### 20.8 Known limits
- The simulation is single-threaded JS on the main thread; washes larger than ~20 tiles will drop frames while drying (a worker or the Wasm core is the next step).
- Drying after commit is outside the undo entry: undo restores the pre-stroke tile, and redo restores the tile as it was at commit (wet render at that moment), not the fully dried result.
- In a live session a remote watercolour stroke replays through the same engine, but drying runs on each peer's own clock, so two screens can differ by the drying state until both are dry.
- Acrylic height is not persisted in the .omni file; reopening a document gives flat (already lit) pixels.

## 21. Loop 12: hover help, Layers tab rebuilt, New document, input and render latency

### 21.1 Hover help (`ui/help.ts`, `ui/tooltip.ts`)
One table of plain-language sentences keyed by keymap action, control title, or visible text, written for the person drawing ("Click inside a shape to fill it. Small gaps in the outline are closed automatically; ..."). The tooltip now has two lines: name + shortcut chip, then the description (wraps at 300 px). Lookup order: `data-help`, action, title, text; brush preset buttons use the preset's own description. The hover delegate also matches plain `button`s and `.field > label`, so sliders explain themselves too (Hardness, Flow, Dry time, Body...). An inventory script (`inventory.py`) walks every ribbon mode and dock panel and lists every button, which is how coverage was checked: 249 controls, all with a description or a preset description.

### 21.2 Layers tab (`ui/panels.ts`)
- Rows: eye, a page-shaped thumbnail of the layer alone (cached by layer generation), name, a "what is on it" line (dominant colour swatches, painted share of the page, path count for vector, lpi and density for tone, child count for groups), a line of what was done on it this session (from history: "2× G-Pen, Fill"), and a state line (kind, blend when not normal, opacity when below 100%, clipped, panel). Lock and clip flags on the right. Hidden layers dim.
- Hovering a thumbnail shows a 320 px preview of that layer alone with its coverage; rows drag to reorder (above/below) or into a group (drop on the group's middle third); groups cannot be dropped into themselves.
- Header: "+ Layer" adds a raster layer above the active one (inside the active group), the arrow opens Vector / Tone / 3D cel / Group; Duplicate, Merge down (raster into the raster below, keeping blend and opacity, one undo entry) and Delete.
- One strip edits the active layer: clip, lock, group/ungroup, up/down, blend, opacity, panel mask, rasterize for vector layers.
- The panel re-renders lazily after strokes (120 ms, only while visible) so it never adds to stroke cost.

### 21.3 New document (`main.ts` newPage)
"New" used to swap `app.doc` and leave the rest: the old selection stayed (and clipped strokes on the new page), undo entries still pointed at old layers, a lifted transform stayed floating, wet fields kept drying into layers that no longer existed, the story strip still listed the old pages. It now emits `doc-reset` (the selection controller cancels any floating transform and clears drags, previews and the selection), resets media fields on the old layers, clears history, drops the story and balloon/node selection, builds a Doc with the same page size, dpi, mode and surface, re-indexes the tile cache and fits the view. Verified with the magic wand active before and after (`wand.py`): selection null, history empty, wand and brush work on the new page.
- Magic wand audit: pen, touch and mouse pointers, Shift add / Alt subtract, contiguous and global, current-layer and all-layer reference, on tone/vector/group/npr layers, in anime mode, on a rotated zoomed view, while a transform was floating: no exceptions, correct bounds. The one defect found was the stale selection after New (fixed above).

### 21.4 Latency and smoothness
- Duplicate samples: Chromium delivers each pen sample on `pointerrawupdate` and again inside the next `pointermove`'s coalesced list; both fed the engine, so every dab was computed twice. Samples are now taken once (same timestamp and position skipped).
- Repaint area: the viewport invalidated the whole stroke's bounding box every batch, so a long stroke repainted a growing region each frame. `StrokeEngine.takeDirty()` returns only what the latest samples touched; the 2D renderer's scratch canvases are cleared and blitted only inside the frame's clip rect (active stroke, clipping masks, tone, onion) instead of full-surface clears.
- Layout reads mid-stroke: `getBoundingClientRect` was called per sample in the viewport and three times per move in the cursor; rects are cached per pointer-down and invalidated on resize/scroll/layout events. The cursor ring updates once per animation frame and moves with `transform` (compositor only).
- Marching ants: the rim (mask minus 1 px erosion) cost ~10 full-screen passes at 60 Hz whenever a selection existed; it is cached per selection + view + floating transform, each frame only re-stripes it, and the ants step at 30 Hz.
- Side effects per sample: the Brush tab redrew its pressure curve on every sample even when hidden (now one per frame, only while visible); the story strip flattened the whole page after every stroke (now 600 ms after, only while visible).
- Measured headless (software rendering, 1600×1000, 600-sample stroke): render 1.54 → 1.28 ms per frame with incremental dirty rects, 0.16 ms of input work per sample; on a GPU-backed 4K display the saved full-surface clears are the larger share.

## 22. Loop 13: Samples gallery, ML Studio (option 3, Phase 2 of docs/ML-GENERATION.md)

- Samples (`ui/samples.ts`): bundled plain `.omni` files under `public/samples/` open as editable copies through the same reset path as New. One entry ships: a procedural portrait drawn by `tools/portraits.js` through the real tools, labelled as an engine demo. It demonstrates the limit that led to the ML plan: scripted geometry gives a schematic cartoon, not illustration.
- ML Studio (`engine/ml.ts`, `ui/generate-panel.ts`): a `Provider` interface (health / submit / poll / cancel) with `SidecarProvider` (HTTP to 127.0.0.1:8790, nothing leaves the device) and `MockProvider` (placeholder render, no model). `JobRunner` polls with progress and cancellation; `layersToPng` turns the Ink/Line/Sketch layers (or the whole drawing) into a page-fitted control or init image; `pngToLayer` puts a result back on a new layer with the exact inverse mapping, and the layer carries `meta.ml` (mode, prompt, negative, size, steps, guidance, seed, strength, control weight, model) so any result is reproducible. Modes: Text only, Colour my lines (ControlNet lineart), Repaint this drawing (img2img), Style from reference (IP-Adapter). Remote providers are flagged and require consent before the first job.
- Sidecar (`ml/sidecar/`): FastAPI + diffusers service (SDXL anime checkpoint, MistoLine ControlNet, optional IP-Adapter, VAE tiling, CPU offload flag), one worker, step progress with latent previews every 5 steps, cancel. Not yet run on a GPU here [A]; `stub.py` implements the same HTTP contract with a placeholder image, and the app was verified against it (`gen.py`): health, job progress, result, Add as layer with metadata, undo entry, mock provider.
- Plan and open decisions: docs/ML-GENERATION.md (where the model runs, base model, steering, licence stance, references).
- Decisions recorded 2026-10-25: own GPU (RTX A3000 6 GB, 16 GB RAM), SDXL `animagine-xl-4` default with `illustrious-xl` and SD 1.5 fallback, `6gb` profile, machine-generated labelling, "Colour my lines" default. Sidecar gained presets with quality-tag prefixes, memory profiles with a pixel cap, free-VRAM and peak-VRAM reporting, and a Windows `start.ps1`.
- Loop 13b: sidecar quality controls (schedulers, CFG rescale, hi-res fix, inpaint with the selection as mask, line preprocessors, LoRA adapters, IP-Adapter weight, model swap endpoints) and the matching Generate-tab controls plus a Danbooru tag assistant; verified against the stub (`gen.py`: inpaint job carries the mask, hi-res flag, tags in the prompt, presets and LoRAs listed). Licence stance deferred by the owner.
- Loop 13c: depth control from the NPR G-buffer (`NprRenderer.depthMap`), LCM fast preview, FreeU, WD14 tagger and Real-ESRGAN endpoints, keep-reference, render-all-frames into per-frame layers.

## 23. Loop 14: drawing speed with many layers and busy pages

The complaint: drawing fast, or drawing on a page with a lot on it, got slow and laggy. A heavier benchmark was built first (`perf2.py`: 8 layers filled with large strokes, then six fast 700-sample strokes; `pan.py`: 12 layers, 60 pan/zoom repaints), run against the previous release and this one in the same headless Chromium (software rendering, 1600x1000, device pixel ratio 1). Numbers below are from that setup, not from a real GPU or display.

| Measure (headless) | Before | After |
|---|---|---|
| Repaint while drawing, median | 78-90 ms | 1.1-1.2 ms |
| Repaint while drawing, 95th percentile | 152-167 ms | 2.3-2.8 ms |
| Worst single repaint during the strokes | 181-192 ms | 33-48 ms |
| Pen-up (commit + undo snapshot) | 82-86 ms | 6-8 ms |
| Full repaint while panning/zooming, median | 109 ms | 8.6 ms |
| JS heap after the run | 527 MB | 202 MB |
| Input work per pen sample (light test, uninstrumented) | 0.23 ms | 0.23 ms (unchanged) |

What was wrong and what changed:

### 23.1 An empty batch repainted the whole canvas (`renderer.ts` invalidate)
A batch of pen samples that laid no dab (spacing not reached yet) returned an empty dirty rect (`Infinity` bounds), which `invalidate()` treated as "repaint everything". With 120-240 Hz pens most batches are like that, so a large share of frames re-composited every layer over the full canvas. Empty rects are now ignored; only a missing rect means "everything".

### 23.2 OffscreenCanvas as a drawImage source (`document.ts` makeCanvas)
Tiles, stroke buffers, brush tips and tone patterns were OffscreenCanvas objects drawn onto the on-screen canvas. Chromium snapshots an OffscreenCanvas source on each such draw, about 0.4 ms per call here, so a 0.03 Mpx repaint took 15 ms. Main-thread surfaces are now `<canvas>` elements (1.0 ms for the same repaint); workers, which have no `document`, keep OffscreenCanvas.

### 23.3 Stroke cache (`renderer.ts` strokePlan / prepareStrokeCache / warmStrokeCache)
While a stroke is live only its layer changes. Everything under it (shadow, paper, onion, lower layers) and, when it composes exactly, everything over it, is kept in two screen-sized canvases. A frame is then: blit "below", draw the stroke layer plus its buffer, blit "above".
- "Above" is cached only when every visible layer above is normal blend, fully opaque, unanimated and not clipped onto the stroke layer or below it. Translucent layers were excluded after measuring up to 14/255 rounding error from 8-bit premultiplied intermediates; with the rule in place cached and uncached frames match to 2/255 for normal, multiply, clipped, translucent, eraser and multiply-brush cases (`cachecheck.py`).
- The cache fills lazily in 64 px cells, so there is no full composite at pen-down; idle frames pre-fill it for the active layer (4 ms slices, 1.5 ms while hovering). It survives between strokes on the same layer, and the pen-up frame also goes through it.
- Changes to other layers during a stroke (drying watercolour, a collaborator's commit) mark cells stale through `invalidate(rect)`; the stroke's own damage goes through `invalidateStroke(rect)` and leaves the cache alone.
- Opaque normal layers with a painting (not erasing, not multiply) stroke skip the scratch canvas and draw straight onto the clipped target.

### 23.4 Flattened projection for pan and zoom (`renderer.ts` projectionPrefix / drawProjection)
Panning repainted every layer, every tile, every frame. Plain raster and vector layers at the bottom of the stack (untransformed, unanimated, no onion skins) are now kept merged per 256 px document tile, with white paper included so blend modes behave as on the page. Tone layers (screen-locked dot patterns), 3D layers and anything above them are still drawn live.
- Tiles are composited at 1:1 (no filtering), then downscaled once for zoomed-out views. Down to 0.35x the full-resolution merged tiles are drawn directly, which keeps edges identical to the live-stroke view (the undo screenshot test differs by at most 1/255). Below 0.35x a reduced level is used; there the merged result differs from per-layer resampling at anti-aliased edges where strokes on different layers overlap (mean 0.13/255 per channel, about 0.3% of pixels more than 32/255 apart in a whole-page view of 12 overlapping layers). That is the order every other paint app uses (merge, then scale), but it is a visible difference from the previous build at whole-page zoom.
- Staleness comes from `invalidate(rect)`; a call without a rect, a new document or frame, or any layer property change drops it. Over a 10 ms budget per frame, tiles the other kept zoom level has are stretched and refined on the next frame. Idle frames re-merge tiles strokes made stale.
- Settings > Performance can turn both caches off for comparison.

### 23.5 Undo snapshots (`history.ts`, `brush.ts` prefetchHistory)
Every pen-up read each touched tile twice from the canvas (before and after), all in one burst.
- Before-snapshots of buffered strokes are taken during the stroke, three new tiles per batch: the layer is untouched until commit, so those pixels are the true before-state.
- After-snapshots are lazy: the next stroke's before-capture of the same tile is the same pixels and is shared; undo reads the tile (which still holds them); export reads them. Live sessions still read them at commit because peers need them immediately.
- A 384 MB budget on snapshot memory joins the 64-step limit; undo and redo repaint only the affected rect.
- Checked by pixel hashes across four strokes on two layers, undo to the start, redo to the end, and a new branch (`undo2.py`), plus the existing undo, autosave-restore and live-session tests.

### 23.6 Smaller items
- Page shadow: rendered once per view and blitted. The live 40 px blur cost time every frame, and when a small repaint missed the page rectangle the browser culled the shadow with the shape, leaving shadow-less strips.
- Tile draws are cropped to the repaint rect, looked up by key for small rects instead of scanning every tile, and skip neighbour tiles when unfiltered.
- Scratch canvases are clipped to the repaint rect.
- Settings > Performance shows live numbers from real use (repaint median and 95th percentile, slow frames, layers, tiles, undo memory, cache state, pen sample rate) with a Copy button. In WebGPU mode the repaint time is CPU submit time only.

### 23.7 Not covered by these measurements
- The WebGPU compositor path (used automatically when the browser offers an adapter). The empty-rect, history and pen-up changes apply to it; the stroke cache and projection do not. Headless Chromium here has no adapter, so it was not measured. Assumption: on a laptop with a discrete GPU, Chrome or Edge will pick WebGPU, and Settings > Performance shows which compositor is in use.
- Autosave still re-encodes every tile every 120 s; encoding is asynchronous and was not profiled.

## 24. Loop 15: Redraw (import and trace) with OMNI-CELL's own tools

A picture (a Generate result, or any raster layer) is rebuilt on new layers made by the app's tools, so every mark can be selected, edited, undone and redrawn. Files: `engine/trace/trace-core.ts` (analysis, pure typed arrays, runs in `trace-worker.ts`), `engine/trace/redraw.ts` (building and scoring), `ui/redraw-panel.ts` (Redraw tab; a Redraw button on every Generate result hands the image and its panel over).

Output layers in a group, bottom to top:

| Layer | Made with | From |
|---|---|---|
| Flats | shape fills (even-odd paths, hairline seam stroke) | k-means in Lab with lightness down-weighted, 2 majority passes, connected regions, small regions merged into their longest-border neighbour, neighbours of the same hue that differ mainly in lightness joined (lit and shaded parts of one material); flat colour = mean of the 50-85th lightness percentile |
| Shadows (multiply) | shape fills | per region, pixels 7 / 18 L* below the flat (1 or 2 levels), majority-smoothed, opened by ~2 px, colour = mean pixel/flat ratio |
| Light (screen) | shape fills | per region, pixels 9 L* above the flat; colour solves screen(flat, c) = pixel |
| Screentone | tone layers, one per density (10-75%), masks filled with shapes | the cel reconstruction's darkness, quantised |
| Ink | Trace Pen strokes through the stroke engine (exact mode) + shape fills for solid black | lines = pixels darker than both sides along some direction (valley test, so colour edges are not lines); centre lines by Zhang-Suen thinning, staircase-corner removal, spur pruning, junction joining (continuations within ~40 degrees become one stroke); width per point from the distance transform, median-smoothed; colour from a k-means ink palette, or black for manga |

Tool changes made for it: the stroke engine gained an exact mode (samples taken as given: no position smoothing or pressure low-pass) and a shared tip cache; a Trace Pen preset (width = pressure x size exactly, no taper, no lag) is in the brush list for normal inking too. Contours are marching squares on a 3x3-blurred mask (sub-pixel, smooth) with typed adjacency and reused scratch buffers.

Scoring, shown after each run: CIE76 delta E of the colour redraw against the source on the working grid (mean and share within 10), and line F1 with 1 px tolerance on thin lines only (solid areas excluded).

Measured on the bundled portrait (1189x1682 working grid, headless software rendering): delta E 3.9 mean, 97% of pixels within 10, line F1 0.98 (precision 0.97, recall 0.99); 1,836 Trace Pen strokes, 136 regions; analysis 10 s in the worker, drawing 8 s.

Known limits at loop 15: soft gradients became cel bands; dense hatching traced as many short strokes; thick coloured lines came out thinner; semi-transparent sources were judged over white. Loop 18 (below) removes each.

### 24.1 Loop 18: the four limits removed

| Limit | What changed | File |
|---|---|---|
| Gradients and airbrushed shading flattened to cel bands | A **Soft shading** layer: the residual between the picture (lines peeled) and the cel reconstruction (flat x shadow, screen highlight), both box-blurred at the dab spacing, becomes airbrush dabs on a grid (spacing 4 px at 1 Mpx, radius 1.6x, cos^2 falloff, the Airbrush footprint). Each dab's alpha is solved so the overlapping dabs reach the wanted coverage (dabs compound as 1 - prod(1 - a k)); coverage ramps from a 3-unit RGB difference to full at 24. No dabs within a dab spacing of a line, because the peeled colour there is a guess (it made halos). Slider "Soft shading" 0..100%; hidden in Manga look. Screentone densities now come from the smoothed picture, so tones follow gradients too. | trace-core.ts step 8b, redraw.ts paintSoftDabs |
| Thick coloured lines thinner than drawn | Width at each centre pixel is now the **full width at half the valley depth**: walk out in four directions until lightness rises halfway from the centre to the paper beside the line, sub-pixel interpolated, narrowest direction. Threshold-free, so an anti-aliased red line measures what the eye sees. Capped at the distance-transform width + 2.2 px (at a crossing every direction reads wide and drew a bead); lines wider than the search radius keep the DT width. The along-path median window grew by 2. | trace-core.ts fwhmAt/widthAt |
| Hair and hatching as many short strokes | **chainStrokes**: after tracing, stroke ends within a gap (3 px at 1 Mpx, scaled) whose outward tangents oppose (cos > 0.72), whose gap direction continues the first stroke (cos > 0.5) and whose widths are within 2.5x are joined, greedily by score, up to 3 rounds. Slider "Join line pieces". | trace-core.ts chainStrokes |
| Semi-transparent sources judged over white | sourcePixels / layerPixels keep an alpha **mask** (alpha >= 50%) and composite onto white only for the colour analysis. The mask goes to the worker: no ink outside it, outside pixels get their own k-means label that is never merged or drawn, no tones or dabs there. The score counts only covered pixels and says so ("judged on the 71% of the area the picture covers"). | redraw.ts onWhite, trace-core.ts inMask/OUT, scoreRedraw |

Measured again on the bundled portrait (same grid, headless; the sample has a transparent surround, so the colour score is now over the 71% it covers rather than inflated by paper matching paper): delta E 3.9 -> 2.1 mean, 96% within 10 over the covered area, line F1 0.98 (precision 0.97, recall 1.00); 1,836 -> 1,110 strokes with 726 pieces joined, 1,883 airbrush dabs; analysis 11 s, drawing 8 s. The neck shadow and cheek blush now read as gradients; the red frames are at full width; the bead artefacts at hair crossings that the first profile estimate produced are gone with the cap. Still not measured on the user's own generated images.

### 24.2 Moving a whole group (loop 18)

A Redraw group is six to ten layers; moving them one at a time never lines up again. With a group as the active layer, the Move/transform tool now lifts every pixel-bearing layer inside it (nested groups included, locked ones skipped) into one floating transform: `Floating.parts` holds the other layers' lifted canvases at the same origin, the overlay previews them in order (multiply/screen approximated, tone layers at their density), `stampFloating` writes each part back to its own layer, and the step is one undo entry across all the layers (`History.beginMulti` / `commitMulti` / `rollbackMulti`, captured through the same `capture()` the stroke path uses, after-tiles read at commit). Fit panel / Fill panel / snapping apply to the group as a whole. Measured headless: a three-layer group (normal, multiply, tone) moved by (300, 300), all parts land together, undo and redo restore all three.

## 25. Loop 19: edge-aware selection (magnetic lasso and Tighten)

`engine/smart-select.ts`, used by `ui/select-tools.ts`. Both read the visible page flattened at <= 1.5 Mpx (Photoshop's "sample all layers"; cached by layer generations) and an edge-cost map: Sobel on L* plus 0.6x on a* and b* (an edge between two colours of equal lightness still counts), normalised at the 98.5th percentile, cost = 0.04 + (1 - edge)^2.

- **Magnetic lasso** (Select tool, shape "magnetic"): live-wire. Each anchor runs Dijkstra (typed-array heap, 8-connected, diagonal x sqrt 2, cost averaged over both ends) over a 480 px window of the map; the segment to the cursor follows parent pointers, so pointer moves cost nothing. Dragging pins an anchor every 60 screen px; a click pins one; Backspace pops one and rebuilds; Enter or a click on the first anchor closes (the closing segment is live-wired too); Esc cancels. The window grows when the cursor leaves it. Measured headless: 175-210 ms per anchor after the first (which also builds the map, ~600 ms); anchors placed 40 px outside a disc give IoU 0.996 against the disc.
- **Tighten to edges** (selection options, any selection): band of +-3% of the selection size (min 8 px, or the slider) around the outline. Core = inside beyond the band, outer ring = outside up to 3 bands. k-means (k = 6, Lab) colour models for each; band pixels get p = 0.7 x colour likelihood + 0.3 x distance prior; two re-estimations; then a 5x5 bilateral majority (neighbours vote with weight exp(-dE/8), so votes never cross an edge); keep the band pixels attached to the core, fill holes that cannot reach the outside; back to page size with smoothing. Measured headless: a 10-gon wobbling +-35 px around a soft-edged, half-shaded disc on a textured background goes from IoU 0.903 to 0.982 in 1.3 s; a second pass changes 4% of the band and nothing in IoU (stable). From a rectangle 230 px off the shape it only reaches 0.74, because the band is the search limit by design.
- Both are ordinary selections: add / subtract / intersect, Move, Fill panel, Delete all apply. The edge map is dropped on reset and rebuilt when any layer changes.

