/**
 * Motion section of the timeline: layer keys (position, scale, rotation, opacity, easing)
 * for the active layer and camera keys (centre, zoom, rotation). Keys sit on the current
 * frame; "Set" writes or updates, "Delete" removes. The easing editor shows the curve and
 * applies to the segment leaving the key. Motion paths are drawn by the selection overlay.
 */
import type { AppState } from "./state.js";
import { h, clear, field } from "./dom.js";
import { EASES, type Ease, type LayerKey, type CameraKey, easeAt, layerAt, cameraAt } from "../engine/tween.js";

function easeCanvas(e: Ease, onChange: (e: Ease) => void): HTMLCanvasElement {
  const c = h("canvas", { width: 120, height: 80, style: { width: "120px", height: "80px", border: "1px solid var(--obsidian-border-dim)", background: "var(--obsidian-panel-2)", cursor: "crosshair" } }) as HTMLCanvasElement;
  const draw = () => {
    const g = c.getContext("2d")!; g.clearRect(0, 0, 120, 80);
    g.strokeStyle = "rgba(128,128,128,0.35)"; g.beginPath(); for (let i = 1; i < 4; i++) { g.moveTo(i * 30, 0); g.lineTo(i * 30, 80); g.moveTo(0, i * 20); g.lineTo(120, i * 20); } g.stroke();
    g.strokeStyle = "#4f8ef7"; g.lineWidth = 2; g.beginPath(); for (let i = 0; i <= 40; i++) { const x = i / 40; const y = easeAt(e, x); if (i) g.lineTo(x * 120, 80 - y * 80); else g.moveTo(0, 80); } g.stroke();
    g.strokeStyle = "rgba(240,160,80,0.9)"; g.lineWidth = 1; g.beginPath(); g.moveTo(0, 80); g.lineTo(e.x1 * 120, 80 - e.y1 * 80); g.moveTo(120, 0); g.lineTo(e.x2 * 120, 80 - e.y2 * 80); g.stroke();
    g.fillStyle = "#f0a050"; for (const [x, y] of [[e.x1, e.y1], [e.x2, e.y2]] as Array<[number, number]>) { g.beginPath(); g.arc(x * 120, 80 - y * 80, 4, 0, Math.PI * 2); g.fill(); }
  };
  let drag: 1 | 2 | null = null;
  c.addEventListener("pointerdown", (ev) => { const r = c.getBoundingClientRect(); const x = (ev.clientX - r.left) / 120, y = 1 - (ev.clientY - r.top) / 80; drag = Math.hypot(x - e.x1, y - e.y1) < Math.hypot(x - e.x2, y - e.y2) ? 1 : 2; c.setPointerCapture(ev.pointerId); });
  c.addEventListener("pointermove", (ev) => { if (!drag) return; const r = c.getBoundingClientRect(); const x = Math.max(0, Math.min(1, (ev.clientX - r.left) / 120)), y = Math.max(-0.5, Math.min(1.5, 1 - (ev.clientY - r.top) / 80)); if (drag === 1) { e.x1 = x; e.y1 = y; } else { e.x2 = x; e.y2 = y; } draw(); onChange(e); });
  c.addEventListener("pointerup", () => { drag = null; });
  draw(); return c;
}

export function motionPanel(app: AppState): HTMLElement {
  const root = h("div", { id: "motion" });
  const render = () => {
    const d = app.doc; const l = d.activeLayer; const f = d.currentFrame;
    const key = l.keys.find((k) => k.frame === f) ?? null; const cur = layerAt(l.keys, f);
    const camKey = d.camera.find((k) => k.frame === f) ?? null; const cam = cameraAt(d.camera, f);
    const num = (v: number, step: number, on: (n: number) => void, w = "64px") => h("input", { type: "number", value: Math.round(v * 100) / 100, step, style: { width: w }, onChange: (e: Event) => on(Number((e.target as HTMLInputElement).value)) });
    const draft: LayerKey = key ? { ...key } : cur ? { ...cur, frame: f, ease: { ...cur.ease } } : { frame: f, x: 0, y: 0, sx: 1, sy: 1, rot: 0, px: d.width / 2, py: d.height / 2, opacity: 1, ease: { ...EASES["ease-in-out"]! } };
    const setKey = () => { const i = l.keys.findIndex((k) => k.frame === f); const prev = [...l.keys]; if (i >= 0) l.keys[i] = { ...draft }; else l.keys.push({ ...draft }); const next = [...l.keys]; app.history.pushCustom("Set motion key", () => { l.keys = prev; app.invalidate(); app.emit("timeline"); }, () => { l.keys = next; app.invalidate(); app.emit("timeline"); }); app.invalidate(); app.emit("timeline"); };
    const delKey = () => { const prev = [...l.keys]; l.keys = l.keys.filter((k) => k.frame !== f); const next = [...l.keys]; app.history.pushCustom("Delete motion key", () => { l.keys = prev; app.invalidate(); app.emit("timeline"); }, () => { l.keys = next; app.invalidate(); app.emit("timeline"); }); app.invalidate(); app.emit("timeline"); };
    const live = (patch: Partial<LayerKey>) => { Object.assign(draft, patch); if (key) { Object.assign(key, patch); app.invalidate(); } };
    const camDraft: CameraKey = camKey ? { ...camKey } : cam ? { ...cam, frame: f, ease: { ...cam.ease } } : { frame: f, cx: d.width / 2, cy: d.height / 2, zoom: 1, rot: 0, ease: { ...EASES["ease-in-out"]! } };
    const setCam = () => { const i = d.camera.findIndex((k) => k.frame === f); const prev = [...d.camera]; if (i >= 0) d.camera[i] = { ...camDraft }; else d.camera.push({ ...camDraft }); const next = [...d.camera]; app.history.pushCustom("Set camera key", () => { d.camera = prev; app.invalidate(); app.emit("timeline"); }, () => { d.camera = next; app.invalidate(); app.emit("timeline"); }); app.invalidate(); app.emit("timeline"); };
    const camFromView = () => { const r = app.renderer; const rect = (document.getElementById("draw") as HTMLCanvasElement).getBoundingClientRect(); const c = r.screenToDoc(rect.width / 2, rect.height / 2); const fit = Math.min(rect.width / d.width, rect.height / d.height); camDraft.cx = c.x; camDraft.cy = c.y; camDraft.zoom = Math.max(0.05, r.view.zoom / fit); camDraft.rot = -r.view.rotation; setCam(); };
    const liveCam = (patch: Partial<CameraKey>) => { Object.assign(camDraft, patch); if (camKey) { Object.assign(camKey, patch); app.invalidate(); } };
    clear(root).append(
      h("div", { class: "motion-col" }, h("h3", {}, `Layer motion · ${l.name}`),
        h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          h("label", {}, "x"), num(draft.x, 1, (v) => live({ x: v })), h("label", {}, "y"), num(draft.y, 1, (v) => live({ y: v })),
          h("label", {}, "scale"), num(draft.sx, 0.01, (v) => live({ sx: v, sy: v }), "56px"), h("label", {}, "rot°"), num((draft.rot * 180) / Math.PI, 1, (v) => live({ rot: (v * Math.PI) / 180 }), "56px"),
          h("label", {}, "opacity"), num(draft.opacity, 0.05, (v) => live({ opacity: v }), "56px")),
        h("div", { class: "row", style: { gap: "6px", marginTop: "4px", flexWrap: "wrap" } },
          h("button", { class: key ? "active" : "", title: key ? "Update the key on this frame" : "Create a key on this frame", onClick: setKey }, key ? "Update key" : "Set key"),
          key ? h("button", { onClick: delKey }, "Delete key") : null,
          h("button", { title: "Pivot at the layer's painted centre", onClick: () => { const b = l.bounds(); if (b) live({ px: (b.x0 + b.x1) / 2, py: (b.y0 + b.y1) / 2 }); } }, "Pivot: centre"),
          h("span", { class: "dim mono", style: { fontSize: "10px" } }, `${l.keys.length} keys: ${[...l.keys].sort((a, b) => a.frame - b.frame).map((k) => k.frame + 1).join(", ") || "none"}`)),
        h("div", { class: "row", style: { gap: "8px", marginTop: "4px", alignItems: "flex-start" } },
          h("div", {}, h("label", {}, "ease out of this key"), h("select", { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (EASES[v]) live({ ease: { ...EASES[v]! } }); render(); } }, ...Object.keys(EASES).map((k) => h("option", { value: k, selected: JSON.stringify(EASES[k]) === JSON.stringify(draft.ease) }, k)), h("option", { value: "custom", selected: !Object.values(EASES).some((e) => JSON.stringify(e) === JSON.stringify(draft.ease)) }, "custom (drag handles)"))),
          easeCanvas(draft.ease, (e) => live({ ease: e })))),
      h("div", { class: "vsep" }),
      h("div", { class: "motion-col" }, h("h3", {}, "Camera"),
        h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap" } },
          h("label", {}, "cx"), num(camDraft.cx, 1, (v) => liveCam({ cx: v })), h("label", {}, "cy"), num(camDraft.cy, 1, (v) => liveCam({ cy: v })),
          h("label", {}, "zoom"), num(camDraft.zoom, 0.05, (v) => liveCam({ zoom: Math.max(0.05, v) }), "56px"), h("label", {}, "rot°"), num((camDraft.rot * 180) / Math.PI, 1, (v) => liveCam({ rot: (v * Math.PI) / 180 }), "56px")),
        h("div", { class: "row", style: { gap: "6px", marginTop: "4px", flexWrap: "wrap" } },
          h("button", { class: camKey ? "active" : "", onClick: setCam }, camKey ? "Update camera key" : "Set camera key"),
          h("button", { title: "Key from what the viewport shows now", onClick: camFromView }, "From view"),
          camKey ? h("button", { onClick: () => { const prev = [...d.camera]; d.camera = d.camera.filter((k) => k.frame !== f); const next = [...d.camera]; app.history.pushCustom("Delete camera key", () => { d.camera = prev; app.invalidate(); app.emit("timeline"); }, () => { d.camera = next; app.invalidate(); app.emit("timeline"); }); app.invalidate(); app.emit("timeline"); } }, "Delete") : null,
          h("label", { style: { display: "inline-flex", gap: "4px", alignItems: "center" } }, h("input", { type: "checkbox", checked: d.showCamera, onChange: (e: Event) => { d.showCamera = (e.target as HTMLInputElement).checked; app.invalidate(); } }), "field guide"),
          h("span", { class: "dim mono", style: { fontSize: "10px" } }, `${d.camera.length} keys · exports frame through the camera`))));
  };
  app.on("timeline", render); app.on("frame", render); app.on("layers", render);
  render();
  return root;
}
