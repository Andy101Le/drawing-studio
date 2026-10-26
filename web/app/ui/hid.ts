/**
 * WebHID → brush routing (Phase 3). Raw tablet reports parsed by
 * HidReportParser feed the same StrokeDriver the pointer path uses, so a
 * tablet that the OS hides from Pointer Events (or that reports 16 384 pressure
 * levels and tilt that the browser flattens) still drives the full engine.
 *
 * Mapping: the tablet's absolute (0..1) surface maps to the viewport like a
 * tablet maps to a monitor. Tip switch down/up = stroke begin/end; the eraser
 * bit switches to the eraser preset for that stroke; dial steps change brush
 * size; express keys 0/1 are undo/redo.
 */

import { InputRing, WebHidInputSource, type InputEvent } from "@omni/input/index.js";
import type { AppState } from "./state.js";
import type { StrokeDriver } from "./viewport.js";

export class HidBridge {
  readonly ring = InputRing.allocate(1024);
  readonly source: WebHidInputSource;
  private down = false;
  private usingEraser = false;
  private savedTool: AppState["tool"] | null = null;
  status = "not connected";
  constructor(private app: AppState, private driver: StrokeDriver) {
    this.source = new WebHidInputSource(this.ring);
    this.source.subscribe((ev) => this.onEvent(ev));
  }
  get supported(): boolean { return WebHidInputSource.isSupported(); }

  async connect(): Promise<void> {
    try {
      const dev = await this.source.requestAndOpen();
      this.status = `${dev.productName} · profile ${this.source.profile.name}`;
    } catch (e) { this.status = `error: ${e instanceof Error ? e.message : String(e)}`; }
    this.app.emit("hid");
  }
  async reopen(): Promise<void> {
    const dev = await this.source.reopenGranted();
    this.status = dev ? `${dev.productName} · profile ${this.source.profile.name}` : "not connected";
    this.app.emit("hid");
  }

  /** Public for tests: feed an already-parsed event. */
  onEvent(ev: InputEvent): void {
    const app = this.app;
    if (ev.kind === "dial") { app.preset.size = Math.max(1, Math.min(600, app.preset.size * (ev.step > 0 ? 1.1 : 1 / 1.1))); app.emit("brush"); return; }
    if (ev.kind === "keys") { if (ev.pressed.includes(0)) { app.history.undo(app.doc); app.invalidate(app.history.lastRect ?? undefined); } if (ev.pressed.includes(1)) { app.history.redo(app.doc); app.invalidate(app.history.lastRect ?? undefined); } return; }
    if (ev.kind !== "pen") return;
    const p = this.driver.tabletToDoc(ev.x, ev.y);
    const sample = { x: p.x, y: p.y, pressure: ev.pressure, tiltX: ev.tiltXDeg, tiltY: ev.tiltYDeg, tMs: ev.timestampMs };
    app.emit("hover", { x: ev.x * window.innerWidth, y: ev.y * window.innerHeight, type: "pen" });
    if (ev.tip && ev.inRange) {
      if (!this.down) {
        this.down = true;
        if (ev.eraser && app.tool !== "eraser") { this.savedTool = app.tool; this.usingEraser = true; app.setTool("eraser"); }
        this.driver.begin(sample);
      } else this.driver.move(sample);
    } else if (this.down) {
      this.down = false; this.driver.end();
      if (this.usingEraser && this.savedTool) { app.setTool(this.savedTool); this.savedTool = null; this.usingEraser = false; }
    }
  }
}
