/**
 * OMNI-Bridge panel: host shows a room code, client types it. Strokes received
 * on the host are replayed through the same brush engine (host authority);
 * strokes drawn on the client are echoed locally and streamed as telemetry.
 */

import { StrokeEngine } from "../engine/brush.js";
import { BridgePeer, type BridgeStats } from "@omni/sync/bridge-peer.js";
import { MsgType, Role, type Message, type TelemetrySample } from "@omni/sync/protocol.js";
import { WebSocketSignaling, generateRoomCode } from "@omni/sync/signaling.js";
import { clear, field, h } from "./dom.js";
import type { AppState } from "./state.js";

export class BridgeController {
  peer: BridgePeer | null = null;
  stats: BridgeStats | null = null;
  private remoteEngines = new Map<number, StrokeEngine>();
  private pendingSamples = new Map<number, TelemetrySample[]>();
  signalingUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787`;

  constructor(private app: AppState) {}

  start(role: Role, room: string): void {
    this.stop();
    const app = this.app;
    app.bridge.role = role === Role.Host ? "host" : "client";
    app.bridge.room = room;
    this.peer = new BridgePeer(new WebSocketSignaling(this.signalingUrl), { role, room }, {
      onState: (s) => { app.bridge.state = s; app.emit("bridge"); },
      onStats: (s) => { this.stats = s; app.bridge.rttMs = s.rttMinUs / 1000; app.bridge.p99Ms = s.rttP99Us / 1000; app.emit("bridge"); },
      onSafetyCode: (c) => { app.bridge.safety = c; app.emit("bridge"); },
      onMessage: (m) => this.onMessage(m),
      onStrokeComplete: (id, samples, loss) => this.replayAuthoritative(id, samples, loss),
    });
    void this.peer.connect().catch((e: unknown) => { app.bridge.state = `error: ${e instanceof Error ? e.message : String(e)}`; app.emit("bridge"); });
    app.emit("bridge");
  }

  stop(): void { this.peer?.close(); this.peer = null; this.app.bridge.state = "idle"; this.app.emit("bridge"); }

  /**
   * Host side. Telemetry (unordered) and control (ordered) are separate
   * channels, so samples may arrive before StrokeBegin or after StrokeEnd.
   * The preview engine only shows the in-flight stroke; the layer is written
   * once, from the complete ordered sample set, in replayAuthoritative().
   */
  private onMessage(m: Message): void {
    const app = this.app;
    if (m.type === MsgType.StrokeBegin) {
      const layer = app.doc.findLayer(m.layerId) ?? app.doc.activeLayer;
      const eng = new StrokeEngine({ preset: app.preset, color: app.color, layer, docScale: app.doc.width / 2480 });
      this.remoteEngines.set(m.strokeId, eng); this.pendingSamples.set(m.strokeId, []);
      if (!app.activeStroke) app.activeStroke = eng;
    } else if (m.type === MsgType.Telemetry || m.type === MsgType.TelemetryBatch) {
      for (const s of m.samples) {
        const eng = this.remoteEngines.get(s.strokeId); if (!eng) continue;
        const pend = this.pendingSamples.get(s.strokeId)!;
        const sm = { x: s.x * app.doc.width, y: s.y * app.doc.height, pressure: s.pressure, tiltX: s.tiltX, tiltY: s.tiltY, tMs: s.tSenderUs / 1000 };
        if (pend.length === 0) eng.begin(sm); else eng.move(sm);
        pend.push(s);
        app.invalidate(eng.dirty);
      }
    }
  }

  private replayAuthoritative(strokeId: number, samples: TelemetrySample[], loss: number): void {
    const app = this.app;
    const preview = this.remoteEngines.get(strokeId);
    this.remoteEngines.delete(strokeId); this.pendingSamples.delete(strokeId);
    if (app.activeStroke === preview) app.activeStroke = null;
    if (!preview || samples.length === 0) { app.invalidate(); return; }
    const layer = preview.layer;
    const fresh = new StrokeEngine({ preset: app.preset, color: app.color, layer, pageWidth: app.doc.width, pageHeight: app.doc.height, docScale: app.doc.width / 2480, beforeTileWrite: (l, tx, ty) => app.history.capture(l, tx, ty) });
    const first = samples[0]!;
    const toSample = (s: TelemetrySample) => ({ x: s.x * app.doc.width, y: s.y * app.doc.height, pressure: s.pressure, tiltX: s.tiltX, tiltY: s.tiltY, tMs: s.tSenderUs / 1000 });
    const g = app.preset.size;
    app.history.begin(layer, { x0: first.x * app.doc.width - g, y0: first.y * app.doc.height - g, x1: first.x * app.doc.width + g, y1: first.y * app.doc.height + g }, `Bridge stroke${loss > 0 ? ` (${Math.round(loss * 100)}% resent)` : ""}`);
    samples.forEach((s, i) => (i === 0 ? fresh.begin(toSample(s)) : fresh.move(toSample(s))));
    fresh.end();
    const rect = fresh.commit();
    app.history.commit(rect);
    app.invalidate(rect);
    app.emit("layers");
  }

  /** Client side: forward local strokes. Hooked from the viewport via app events. */
  sendBegin(): void { if (this.peer?.state === "connected" && this.app.bridge.role === "client") this.peer.beginStroke(this.app.doc.activeLayerId, 0, 0); }
  sendSample(x: number, y: number, p: number, tx: number, ty: number, tip: boolean): void {
    if (this.peer?.state !== "connected" || this.app.bridge.role !== "client") return;
    this.peer.sendSample({ flags: (tip ? 1 : 0) | 16, x: x / this.app.doc.width, y: y / this.app.doc.height, pressure: p, tiltX: tx, tiltY: ty, rotationCdeg: 0xffff });
  }
  sendEnd(): void { if (this.peer?.state === "connected" && this.app.bridge.role === "client") this.peer.endStroke(); }
}

export function bridgePanel(app: AppState, ctl: BridgeController): HTMLElement {
  const root = h("div");
  const render = () => {
    const b = app.bridge;
    const roomIn = h("input", { type: "text", class: "mono", value: b.room, placeholder: "6-digit code", maxlength: 6, style: { width: "100px" } }) as HTMLInputElement;
    const urlIn = h("input", { type: "text", class: "mono", value: ctl.signalingUrl, style: { width: "100%" } }) as HTMLInputElement;
    urlIn.addEventListener("change", () => (ctl.signalingUrl = urlIn.value));
    clear(root).append(h("h3", {}, "OMNI-Bridge"),
      h("p", { class: "dim", style: { fontSize: "12px" } }, "Host on the PC, client on the iPad (same Wi-Fi). The iPad draws with local echo; the PC holds authority and corrects after each stroke."),
      field("Signaling", urlIn),
      h("div", { class: "row", style: { margin: "8px 0" } },
        h("button", { class: b.role === "host" && b.state !== "idle" ? "active" : "", onClick: () => ctl.start(Role.Host, generateRoomCode()) }, "Host"),
        roomIn,
        h("button", { class: b.role === "client" && b.state !== "idle" ? "active" : "", onClick: () => { if (/^\d{6}$/.test(roomIn.value)) ctl.start(Role.Client, roomIn.value); } }, "Join"),
        h("button", { onClick: () => ctl.stop() }, "Stop")),
      b.role === "host" && b.room ? h("div", { class: "notice mono", style: { fontSize: "22px", textAlign: "center", letterSpacing: ".3em" } }, b.room) : null,
      h("div", { class: "kv" },
        h("span", {}, "state"), h("b", {}, b.state),
        h("span", {}, "transport"), h("b", {}, ctl.stats?.transport ?? "none"),
        h("span", {}, "RTT min / p50 / p99"), h("b", {}, ctl.stats ? `${(ctl.stats.rttMinUs / 1000).toFixed(1)} / ${(ctl.stats.rttP50Us / 1000).toFixed(1)} / ${(ctl.stats.rttP99Us / 1000).toFixed(1)} ms` : "–"),
        h("span", {}, "jitter"), h("b", {}, ctl.stats ? `${(ctl.stats.jitterUs / 1000).toFixed(1)} ms` : "–"),
        h("span", {}, "clock offset"), h("b", {}, ctl.stats ? `${(ctl.stats.clockOffsetUs / 1000).toFixed(2)} ms` : "–"),
        h("span", {}, "samples sent / recv"), h("b", {}, ctl.stats ? `${ctl.stats.telemetrySent} / ${ctl.stats.telemetryReceived}` : "–"),
        h("span", {}, "ICE pair"), h("b", {}, ctl.stats?.iceCandidatePairType || "–"),
        h("span", {}, "safety code"), h("b", {}, b.safety || "–")),
      h("p", { class: "dim", style: { fontSize: "11px" } }, "Safety code must match on both screens. Run the relay with `npm run signaling` on the PC."));
  };
  app.on("bridge", render);
  render();
  return root;
}
