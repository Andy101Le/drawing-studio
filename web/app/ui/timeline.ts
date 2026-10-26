/**
 * Dual timeline (Phase 6.2): horizontal keyframe strip (canvas) and vertical
 * exposure sheet (table), both views over Doc.exposure / Doc.frames.
 */

import { motionPanel } from "./motion-panel.js";
import type { Frame } from "../engine/document.js";
import { clear, h } from "./dom.js";
import type { AppState } from "./state.js";

const VISEMES: Frame["viseme"][] = ["rest", "A", "E", "O", "M", "F", "L"];

export function timelinePanel(app: AppState, root: HTMLElement): void {
  const left = h("div", { class: "col", style: { overflow: "hidden", minWidth: "0" } });
  const transport = h("div", { class: "transport" });
  const strip = h("div", { id: "keyframes", class: "grow" });
  const stripCanvas = h("canvas") as HTMLCanvasElement;
  strip.append(stripCanvas);
  left.append(transport, strip, motionPanel(app));
  const xs = h("div", { id: "xsheet" });
  root.append(left, h("div", { class: "vsep" }), xs);

  let timer: ReturnType<typeof setInterval> | null = null;
  let audioCtx: AudioContext | null = null; let player: import("../engine/anim-export.js").AudioPlayer | null = null;
  const goto = (f: number) => { app.doc.currentFrame = Math.max(0, Math.min(app.doc.exposure.length - 1, f)); app.invalidate(); app.emit("frame"); };
  const play = () => {
    if (timer) { clearInterval(timer); timer = null; app.playing = false; player?.stop(); app.emit("timeline"); return; }
    app.playing = true;
    // audio: start at the current frame and let the wall clock drive frames so sound and picture stay aligned
    const t0 = performance.now(); const f0 = app.doc.currentFrame;
    if (app.audio) void import("../engine/anim-export.js").then(({ AudioPlayer }) => { audioCtx ??= new AudioContext(); player ??= new AudioPlayer(audioCtx); player.start(app.audio!, f0, app.doc.fps); });
    timer = setInterval(() => { const f = f0 + Math.floor(((performance.now() - t0) / 1000) * app.doc.fps); if (f >= app.doc.exposure.length) { if (app.audio) { play(); goto(0); return; } goto(f % app.doc.exposure.length); } else goto(f); }, 1000 / app.doc.fps / 2);
    app.emit("timeline");
  };
  async function loadAudioFile(file: File | null) {
    if (!file) return;
    const { loadAudio } = await import("../engine/anim-export.js");
    audioCtx ??= new AudioContext();
    try { app.audio = await loadAudio(file, app.doc.fps, audioCtx); app.animMessage = `${file.name}: ${app.audio.buffer.duration.toFixed(2)} s, ${app.audio.buffer.sampleRate} Hz, ${app.audio.rms.length} frames`; }
    catch (e) { app.animMessage = `audio: ${e instanceof Error ? e.message : String(e)}`; }
    app.emit("timeline");
  }
  async function exportAnim(kind: "zip" | "gif" | "webm", scale: number) {
    const mod = await import("../engine/anim-export.js");
    const d = app.doc; const n = d.exposure.length; const keep = d.currentFrame; const t0 = performance.now();
    const w = Math.round(d.width * scale), h = Math.round(d.height * scale);
    const frames: HTMLCanvasElement[] = [];
    for (let i = 0; i < n; i++) {
      d.currentFrame = i; const flat = app.renderer.flatten(d, scale);
      const c = document.createElement("canvas"); c.width = w; c.height = h; const g = c.getContext("2d")!; g.fillStyle = "#fff"; g.fillRect(0, 0, w, h);
      const cam = d.camera.length ? mod.cameraAt(d.camera, i) : null;
      if (cam) { g.save(); g.translate(w / 2, h / 2); g.rotate(-cam.rot); g.scale(cam.zoom, cam.zoom); g.translate(-cam.cx * scale, -cam.cy * scale); g.imageSmoothingQuality = "high"; g.drawImage(flat, 0, 0); g.restore(); }
      else g.drawImage(flat, 0, 0);
      frames.push(c);
      app.animMessage = `rendering frame ${i + 1}/${n}`; app.emit("anim-progress"); await new Promise((r) => setTimeout(r, 0));
    }
    d.currentFrame = keep; app.invalidate();
    let bytes: Uint8Array | Blob; let name: string;
    if (kind === "zip") {
      const files: Array<{ name: string; data: Uint8Array }> = [];
      for (let i = 0; i < n; i++) { const blob: Blob = await new Promise((res) => frames[i]!.toBlob((b) => res(b!), "image/png")); files.push({ name: `${d.name}_${String(i + 1).padStart(4, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) }); }
      bytes = mod.zipStore(files); name = `${d.name}_frames.zip`;
    } else if (kind === "gif") {
      bytes = mod.encodeGif(frames.map((c) => ({ data: c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, w, h).data, w, h })), d.fps); name = `${d.name}.gif`;
    } else { bytes = await mod.recordWebm(frames, d.fps, (i) => { app.animMessage = `recording ${i + 1}/${n}`; app.emit("anim-progress"); }); name = `${d.name}.webm`; }
    const blob = bytes instanceof Blob ? bytes : new Blob([bytes as BlobPart]);
    app.lastExport = { name, bytes: bytes instanceof Blob ? new Uint8Array(await bytes.arrayBuffer()) : bytes };
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    app.animMessage = `${name}: ${(blob.size / 1048576).toFixed(2)} MB, ${n} frames at ${w}x${h}, ${Math.round(performance.now() - t0)} ms`; app.emit("timeline");
  }

  const renderTransport = () => {
    clear(transport).append(
      h("button", { title: "First frame", onClick: () => goto(0) }, "⏮"), h("button", { title: "Previous frame", "data-action": "anim.prev", onClick: () => goto(app.doc.currentFrame - 1) }, "◀"),
      h("button", { class: app.playing ? "active" : "", title: app.playing ? "Pause" : "Play", onClick: play }, app.playing ? "⏸" : "▶"),
      h("button", { title: "Next frame", "data-action": "anim.next", onClick: () => goto(app.doc.currentFrame + 1) }, "▶|"),
      h("span", { class: "mono dim", id: "frame-counter", style: { margin: "0 8px" } }, `${String(app.doc.currentFrame + 1).padStart(3, "0")} / ${app.doc.exposure.length}`),
      h("label", {}, "fps"), h("select", { onChange: (e: Event) => { app.doc.fps = Number((e.target as HTMLSelectElement).value) as 12 | 24 | 30; if (timer) { play(); play(); } } }, ...[12, 24, 30].map((v) => h("option", { value: v, selected: v === app.doc.fps }, String(v)))),
      h("label", {}, "frames"), h("input", { type: "number", value: app.doc.exposure.length, style: { width: "60px" }, onChange: (e: Event) => { app.doc.setFrameCount(Math.max(1, Number((e.target as HTMLInputElement).value))); app.emit("timeline"); } }),
      h("button", { title: "New drawing at this frame (converts hold to key)", onClick: () => { app.doc.newDrawingAtCurrent(); app.invalidate(); app.emit("layers"); app.emit("timeline"); } }, "+ Key"),
      h("button", { class: app.doc.onionEnabled ? "active" : "", title: "Onion skin", "data-action": "anim.onion", onClick: () => { app.doc.onionEnabled = !app.doc.onionEnabled; app.invalidate(); app.emit("timeline"); } }, "Onion"),
      h("label", {}, "prev"), h("input", { type: "number", value: app.doc.onionPrev, min: 0, max: 6, style: { width: "44px" }, onChange: (e: Event) => { app.doc.onionPrev = Number((e.target as HTMLInputElement).value); app.invalidate(); } }),
      h("label", {}, "next"), h("input", { type: "number", value: app.doc.onionNext, min: 0, max: 6, style: { width: "44px" }, onChange: (e: Event) => { app.doc.onionNext = Number((e.target as HTMLInputElement).value); app.invalidate(); } }),
      h("label", {}, "curve"), h("select", { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; app.doc.onionCurve = v === "lin" ? (t) => 0.45 * (1 - t) : v === "ease" ? (t) => 0.45 * (1 - t) * (1 - t) : (t) => 0.45 * Math.pow(1 - t, 4); app.invalidate(); } },
        h("option", { value: "ease", selected: true }, "ease"), h("option", { value: "lin" }, "linear"), h("option", { value: "steep" }, "steep")),
      h("span", { class: "vsep", style: { width: "1px", height: "18px", margin: "0 6px" } }),
      h("label", { class: "btn", title: "Load a dialogue or music track (wav, mp3, ogg); the Xsheet shows its waveform and playback is synced", style: { cursor: "pointer" } }, app.audio ? `♪ ${app.audio.name.slice(0, 18)}` : "♪ Audio", h("input", { type: "file", accept: "audio/*", style: { display: "none" }, onChange: (e: Event) => void loadAudioFile((e.target as HTMLInputElement).files?.[0] ?? null) })),
      app.audio ? h("input", { type: "number", title: "audio offset in frames", value: app.audio.offsetFrames, style: { width: "52px" }, onChange: (e: Event) => { app.audio!.offsetFrames = Number((e.target as HTMLInputElement).value); app.emit("timeline"); } }) : null,
      h("label", {}, "export"), h("select", { id: "anim-scale" }, h("option", { value: "0.25" }, "25%"), h("option", { value: "0.5", selected: true }, "50%"), h("option", { value: "1" }, "100%")),
      h("button", { title: "PNG image sequence (zip)", onClick: () => void exportAnim("zip", Number((document.getElementById("anim-scale") as HTMLSelectElement).value)) }, "PNG seq"),
      h("button", { title: "Animated GIF, 256 colours, dithered", onClick: () => void exportAnim("gif", Number((document.getElementById("anim-scale") as HTMLSelectElement).value)) }, "GIF"),
      h("button", { title: "WebM video (VP9/VP8) via MediaRecorder; convert to MP4 with ffmpeg if needed", onClick: () => void exportAnim("webm", Number((document.getElementById("anim-scale") as HTMLSelectElement).value)) }, "WebM"),
      h("span", { class: "mono dim", id: "anim-msg", style: { fontSize: "10px", marginLeft: "6px" } }, app.animMessage),
    );
  };

  const CELL = 18, ROW = 24;
  const renderStrip = () => {
    const d = app.doc;
    const n = d.exposure.length;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(strip.clientWidth, 40 + n * CELL), hgt = ROW * 3 + 8;
    stripCanvas.width = w * dpr; stripCanvas.height = hgt * dpr; stripCanvas.style.width = `${w}px`; stripCanvas.style.height = `${hgt}px`;
    const c = stripCanvas.getContext("2d")!; c.scale(dpr, dpr);
    c.fillStyle = "#161616"; c.fillRect(0, 0, w, hgt);
    c.font = "10px JetBrains Mono, monospace"; c.textBaseline = "middle";
    for (let i = 0; i < n; i++) {
      const x = 40 + i * CELL;
      c.fillStyle = i % d.fps === 0 ? "#2c2c2c" : i % 6 === 0 ? "#1f1f1f" : "#1a1a1a"; c.fillRect(x, 0, CELL - 1, ROW);
      if (i % 6 === 0) { c.fillStyle = "#9a9a9a"; c.fillText(String(i + 1), x + 2, ROW / 2); }
      const key = i === 0 || d.exposure[i] !== d.exposure[i - 1];
      c.fillStyle = key ? "#e6e6e6" : "#3a3a3a";
      if (key) { c.beginPath(); c.arc(x + CELL / 2, ROW * 1.5, 4, 0, Math.PI * 2); c.fill(); }
      else c.fillRect(x + CELL / 2 - 1, ROW * 1.5 - 1, 2, 2);
      const f = d.drawingAt(i);
      if (f && f.viseme !== "rest") { c.fillStyle = "#b8b8b8"; c.fillText(f.viseme, x + 4, ROW * 2.5); }
    }
    c.fillStyle = "#9a9a9a"; c.fillText("time", 4, ROW / 2); c.fillText("keys", 4, ROW * 1.5); c.fillText("lips", 4, ROW * 2.5);
    const px = 40 + d.currentFrame * CELL;
    c.strokeStyle = "#b8b8b8"; c.lineWidth = 1; c.beginPath(); c.moveTo(px + 0.5, 0); c.lineTo(px + 0.5, hgt); c.stroke();
  };
  stripCanvas.addEventListener("pointerdown", (e) => { const r = stripCanvas.getBoundingClientRect(); goto(Math.floor((e.clientX - r.left - 40) / CELL)); });
  stripCanvas.addEventListener("pointermove", (e) => { if (e.buttons) { const r = stripCanvas.getBoundingClientRect(); goto(Math.floor((e.clientX - r.left - 40) / CELL)); } });

  const renderXsheet = () => {
    const d = app.doc;
    const table = h("table");
    table.append(h("tr", {}, h("th", {}, "#"), h("th", {}, "drawing"), h("th", {}, "viseme"), h("th", {}, "dialog"), h("th", {}, "note"), app.audio ? h("th", {}, "audio") : null));
    for (let i = 0; i < d.exposure.length; i++) {
      const f = d.drawingAt(i);
      const key = i === 0 || d.exposure[i] !== d.exposure[i - 1];
      const tr = h("tr", { class: i === d.currentFrame ? "current" : "", onClick: () => goto(i) },
        h("td", { class: "dim" }, String(i + 1)),
        h("td", { class: key ? "key" : "hold" }, key ? f?.label ?? "" : "│"),
        h("td", { class: "editable" }, key ? h("select", { style: { padding: "0", fontSize: "10px", background: "transparent", border: "0" }, onChange: (e: Event) => { if (f) { f.viseme = (e.target as HTMLSelectElement).value as Frame["viseme"]; app.emit("timeline"); } } }, ...VISEMES.map((v) => h("option", { value: v, selected: f?.viseme === v }, v))) : ""),
        h("td", { class: "editable", contenteditable: key ? "true" : undefined, onInput: (e: Event) => { if (f) f.dialog = (e.target as HTMLElement).textContent ?? ""; } }, key ? f?.dialog ?? "" : ""),
        h("td", { class: "editable", contenteditable: key ? "true" : undefined, onInput: (e: Event) => { if (f) f.note = (e.target as HTMLElement).textContent ?? ""; } }, key ? f?.note ?? "" : ""),
        app.audio ? h("td", { title: `rms ${(app.audio.rms[i - app.audio.offsetFrames] ?? 0).toFixed(2)}` }, h("div", { style: { height: "8px", width: `${Math.round(100 * (app.audio.rms[i - app.audio.offsetFrames] ?? 0))}%`, minWidth: "0", background: "#4f8ef7", borderRadius: "2px" } })) : null,
      );
      table.append(tr);
    }
    clear(xs).append(table);
    const cur = xs.querySelector("tr.current") as HTMLElement | null;
    cur?.scrollIntoView({ block: "nearest" });
  };

  const renderFrame = () => {
    renderStrip();
    const counter = transport.querySelector("#frame-counter"); if (counter) counter.textContent = `${String(app.doc.currentFrame + 1).padStart(3, "0")} / ${app.doc.exposure.length}`;
    xs.querySelectorAll("tr").forEach((tr, i) => tr.classList.toggle("current", i - 1 === app.doc.currentFrame));
    (xs.querySelector("tr.current") as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
    app.emit("layers-refresh");
  };
  const renderAll = () => { renderTransport(); renderStrip(); renderXsheet(); };
  app.on("timeline", renderAll); app.on("frame", renderFrame); app.on("layers", renderStrip);
  app.on("anim-progress", () => { const el = document.getElementById("anim-msg"); if (el) el.textContent = app.animMessage; });
  new ResizeObserver(renderStrip).observe(strip);
  renderAll();
}
