/**
 * Phase 4.1: OMNI-Bridge connection manager.
 *
 * Owns one RTCPeerConnection and two data channels, negotiates through a
 * SignalingTransport, keeps the clock synchronized, tracks stroke loss, and
 * reconnects on failure (ICE restart first, full renegotiation second).
 *
 * Latency choices, with reasons:
 *   - telemetry channel: ordered=false, maxRetransmits=0. SCTP then delivers
 *     each sample the instant it arrives instead of holding it behind a lost one.
 *   - send immediately, no timer batching. A 32-byte datagram every 4 ms is
 *     8 KB/s; batching only kicks in when the channel is backed up.
 *   - bufferedAmountLowThreshold keeps the control channel from head-of-line
 *     blocking large TILE_PATCH messages behind each other.
 *   - iceServers is empty by default: LAN only, host candidates via mDNS. A STUN
 *     server is only added when `allowInternet` is true (not the design goal).
 *
 * USB path: WebRTC runs over UDP, which usbmuxd's TCP port forward cannot carry.
 * The native iPad companion therefore exposes the same binary protocol over a
 * plain WebSocket on the forwarded port; WebSocketLink below speaks it.
 * Both links implement `Link`, so everything above this file is transport-agnostic.
 */

import { ClockSync } from "./clock-sync.js";
import { MsgType, PROTOCOL_VERSION, Role, decode, encodeControl, encodeTelemetry, encodeTelemetryBatch, type Message, type TelemetrySample } from "./protocol.js";
import type { SignalMessage, SignalingTransport } from "./signaling.js";
import { ReceiverStrokeTracker, SenderStrokeBuffer } from "./stroke-tracker.js";

export type BridgeState = "idle" | "signaling" | "connecting" | "connected" | "reconnecting" | "closed";

export interface BridgeStats {
  state: BridgeState;
  transport: "webrtc" | "websocket" | "none";
  rttMinUs: number;
  rttP50Us: number;
  rttP99Us: number;
  jitterUs: number;
  clockOffsetUs: number;
  telemetrySent: number;
  telemetryReceived: number;
  telemetryQueued: number;
  bytesSent: number;
  bytesReceived: number;
  iceCandidatePairType: string;
}

export interface Link {
  readonly kind: "webrtc" | "websocket";
  sendTelemetry(buf: ArrayBuffer): void;
  sendControl(buf: ArrayBuffer): void;
  telemetryBufferedAmount(): number;
  controlBufferedAmount(): number;
  close(): void;
}

export interface BridgeEvents {
  onState?: (s: BridgeState) => void;
  onMessage?: (m: Message, receivedAtUs: number) => void;
  onStrokeComplete?: (strokeId: number, samples: TelemetrySample[], lossRatio: number) => void;
  onStats?: (s: BridgeStats) => void;
  onSafetyCode?: (code: string) => void;
}

export interface BridgeOptions {
  role: Role;
  room: string;
  allowInternet?: boolean;
  pingIntervalMs?: number;
  statsIntervalMs?: number;
  maxIceRestarts?: number;
  telemetryBacklogBytes?: number;
}

const nowUs = (): number => performance.now() * 1000;

export class BridgePeer {
  readonly clock = new ClockSync();
  readonly #opts: Required<BridgeOptions>;
  readonly #signaling: SignalingTransport;
  readonly #events: BridgeEvents;
  readonly #sendBuffer = new SenderStrokeBuffer();
  readonly #recvTracker = new ReceiverStrokeTracker();

  #pc: RTCPeerConnection | null = null;
  #link: Link | null = null;
  #state: BridgeState = "idle";
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #statsTimer: ReturnType<typeof setInterval> | null = null;
  #pingId = 0;
  readonly #pendingPings = new Map<number, number>();
  #iceRestarts = 0;
  #makingOffer = false;
  readonly #pendingIce: RTCIceCandidateInit[] = [];
  #remoteSet = false;
  readonly #queue: TelemetrySample[] = [];
  #activeStroke: number | null = null;
  #seq = 0;
  #stats = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0, pairType: "" };

  constructor(signaling: SignalingTransport, opts: BridgeOptions, events: BridgeEvents = {}) {
    this.#signaling = signaling;
    this.#events = events;
    this.#opts = {
      role: opts.role,
      room: opts.room,
      allowInternet: opts.allowInternet ?? false,
      pingIntervalMs: opts.pingIntervalMs ?? 250,
      statsIntervalMs: opts.statsIntervalMs ?? 1000,
      maxIceRestarts: opts.maxIceRestarts ?? 3,
      telemetryBacklogBytes: opts.telemetryBacklogBytes ?? 4096,
    };
    signaling.onMessage((m) => void this.#onSignal(m));
    signaling.onClose(() => {
      if (this.#state === "signaling") this.#setState("closed");
    });
  }

  get state(): BridgeState {
    return this.#state;
  }
  get role(): Role {
    return this.#opts.role;
  }

  // ---------- lifecycle ----------

  async connect(): Promise<void> {
    if (this.#state !== "idle" && this.#state !== "closed") throw new Error(`cannot connect from state ${this.#state}`);
    this.#setState("signaling");
    this.#createPeerConnection();
    this.#signaling.send({ kind: "join", room: this.#opts.room, role: this.#opts.role === Role.Host ? "host" : "client" });
  }

  /** Attach a pre-built link (USB WebSocket path) instead of negotiating WebRTC. */
  attachLink(link: Link): void {
    this.#link = link;
    this.#onLinkOpen();
  }

  close(): void {
    this.#stopTimers();
    this.#link?.close();
    this.#link = null;
    this.#pc?.close();
    this.#pc = null;
    this.#signaling.close();
    this.#setState("closed");
  }

  // ---------- sending ----------

  beginStroke(layerId: number, brushId: number, toolFlags: number): number {
    const strokeId = (this.#activeStroke === null ? 1 : (this.#activeStroke + 1) & 0xffff) || 1;
    this.#activeStroke = strokeId;
    this.#seq = 0;
    this.#sendBuffer.begin(strokeId);
    this.#sendControl({ type: MsgType.StrokeBegin, strokeId, layerId, brushId, toolFlags, tUs: nowUs() });
    return strokeId;
  }

  /** Sends one stylus sample on the unreliable channel. Returns the seq it was given. */
  sendSample(s: Omit<TelemetrySample, "strokeId" | "seq" | "tSenderUs">): number {
    if (this.#activeStroke === null) throw new Error("no active stroke");
    const sample: TelemetrySample = { ...s, strokeId: this.#activeStroke, seq: this.#seq++, tSenderUs: nowUs() };
    this.#sendBuffer.record(sample);
    this.#queue.push(sample);
    this.#flushTelemetry();
    return sample.seq;
  }

  endStroke(): void {
    if (this.#activeStroke === null) return;
    this.#flushTelemetry(true);
    this.#sendControl({ type: MsgType.StrokeEnd, strokeId: this.#activeStroke, sampleCount: this.#seq, tUs: nowUs() });
    this.#activeStroke = null;
  }

  sendControlMessage(m: Exclude<Message, { type: MsgType.Telemetry | MsgType.TelemetryBatch }>): void {
    this.#sendControl(m);
  }

  #flushTelemetry(force = false): void {
    const link = this.#link;
    if (!link || this.#state !== "connected") return;
    if (!force && link.telemetryBufferedAmount() > this.#opts.telemetryBacklogBytes) return; // wait for drain
    while (this.#queue.length > 0) {
      if (this.#queue.length === 1) {
        const s = this.#queue.shift() as TelemetrySample;
        const buf = encodeTelemetry(s);
        link.sendTelemetry(buf);
        this.#stats.sent++;
        this.#stats.bytesSent += buf.byteLength;
      } else {
        const batch = this.#queue.splice(0, Math.min(7, this.#queue.length));
        const buf = encodeTelemetryBatch(batch);
        link.sendTelemetry(buf);
        this.#stats.sent += batch.length;
        this.#stats.bytesSent += buf.byteLength;
      }
    }
  }

  #sendControl(m: Exclude<Message, { type: MsgType.Telemetry | MsgType.TelemetryBatch }>): void {
    if (!this.#link) return;
    const buf = encodeControl(m);
    this.#link.sendControl(buf);
    this.#stats.bytesSent += buf.byteLength;
  }

  // ---------- receiving ----------

  #onData(buf: ArrayBuffer): void {
    const at = nowUs();
    this.#stats.bytesReceived += buf.byteLength;
    let m: Message;
    try {
      m = decode(buf);
    } catch {
      return; // malformed: drop silently, never crash the input path
    }
    switch (m.type) {
      case MsgType.Telemetry:
      case MsgType.TelemetryBatch:
        this.#stats.received += m.samples.length;
        for (const s of m.samples) this.#recvTracker.accept(s);
        break;
      case MsgType.Hello:
        if (m.protocolVersion !== PROTOCOL_VERSION) {
          this.close();
          return;
        }
        break;
      case MsgType.Ping:
        this.#sendControl({ type: MsgType.Pong, id: m.id, t0: m.t0, t1: at, t2: nowUs() });
        return;
      case MsgType.Pong: {
        const t0 = this.#pendingPings.get(m.id);
        if (t0 !== undefined) {
          this.#pendingPings.delete(m.id);
          this.clock.addRoundTrip(t0, m.t1, m.t2, at);
        }
        return;
      }
      case MsgType.StrokeBegin:
        this.#recvTracker.begin(m.strokeId);
        break;
      case MsgType.StrokeEnd: {
        const missing = this.#recvTracker.end(m.strokeId, m.sampleCount);
        this.#sendControl({ type: MsgType.StrokeAck, strokeId: m.strokeId, received: m.sampleCount - missing.length, missing });
        if (missing.length === 0) this.#completeStroke(m.strokeId);
        break;
      }
      case MsgType.StrokeAck:
        if (m.missing.length > 0) {
          const samples = this.#sendBuffer.lookup(m.strokeId, m.missing);
          if (samples.length > 0) this.#sendControl({ type: MsgType.StrokeResend, strokeId: m.strokeId, samples });
        }
        break;
      case MsgType.StrokeResend:
        for (const s of m.samples) this.#recvTracker.accept(s);
        if (this.#recvTracker.isComplete(m.strokeId)) this.#completeStroke(m.strokeId);
        break;
      default:
        break;
    }
    this.#events.onMessage?.(m, at);
  }

  #completeStroke(strokeId: number): void {
    const samples = this.#recvTracker.ordered(strokeId);
    const loss = this.#recvTracker.lossRatio(strokeId);
    this.#recvTracker.forget(strokeId);
    this.#events.onStrokeComplete?.(strokeId, samples, loss);
  }

  // ---------- WebRTC negotiation (perfect negotiation pattern) ----------

  #createPeerConnection(): void {
    const config: RTCConfiguration = {
      iceServers: this.#opts.allowInternet ? [{ urls: "stun:stun.l.google.com:19302" }] : [],
      iceCandidatePoolSize: 2,
      bundlePolicy: "max-bundle",
    };
    const pc = new RTCPeerConnection(config);
    this.#pc = pc;
    this.#remoteSet = false;
    this.#pendingIce.length = 0;

    pc.onicecandidate = (e) => {
      if (e.candidate) this.#signaling.send({ kind: "ice", candidate: e.candidate.toJSON() });
    };
    // Offers are sent explicitly on "peer-joined" (host only), so the relay never
    // has to buffer an offer for a client that has not arrived yet. The polite
    // client never initiates.
    pc.onnegotiationneeded = () => undefined;
    pc.oniceconnectionstatechange = () => {
      if (pc.iceConnectionState === "failed") void this.#handleFailure();
      else if (pc.iceConnectionState === "disconnected") this.#setState("reconnecting");
      else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        if (this.#link) this.#setState("connected");
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") void this.#handleFailure();
    };

    // negotiated:true with fixed ids: both sides construct the channels locally and
    // they bind once DTLS/SCTP is up. No ondatachannel race, one less round trip.
    const telemetry = pc.createDataChannel("telemetry", { ordered: false, maxRetransmits: 0, id: 0, negotiated: true });
    const control = pc.createDataChannel("control", { ordered: true, id: 1, negotiated: true });
    this.#bindChannels(telemetry, control);
  }

  #bindChannels(telemetry: RTCDataChannel, control: RTCDataChannel): void {
    telemetry.binaryType = "arraybuffer";
    control.binaryType = "arraybuffer";
    control.bufferedAmountLowThreshold = 16 * 1024;
    let opened = 0;
    const onOpen = () => {
      opened++;
      if (opened === 2) {
        this.#link = new WebRtcLink(telemetry, control);
        this.#onLinkOpen();
      }
    };
    telemetry.onopen = onOpen;
    control.onopen = onOpen;
    telemetry.onmessage = (e) => this.#onData(e.data as ArrayBuffer);
    control.onmessage = (e) => this.#onData(e.data as ArrayBuffer);
    telemetry.onbufferedamountlow = () => this.#flushTelemetry();
    const onClose = () => {
      if (this.#state === "connected") this.#setState("reconnecting");
    };
    telemetry.onclose = onClose;
    control.onclose = onClose;
  }

  async #onSignal(m: SignalMessage): Promise<void> {
    const pc = this.#pc;
    switch (m.kind) {
      case "peer-joined":
        if (this.#opts.role === Role.Host && pc) {
          this.#makingOffer = true;
          await pc.setLocalDescription();
          this.#makingOffer = false;
          if (pc.localDescription) this.#signaling.send({ kind: "offer", sdp: pc.localDescription.sdp });
          this.#setState("connecting");
        }
        return;
      case "offer": {
        if (!pc) return;
        const polite = this.#opts.role === Role.Client;
        const collision = this.#makingOffer || pc.signalingState !== "stable";
        if (!polite && collision) return; // impolite peer ignores the colliding offer
        await pc.setRemoteDescription({ type: "offer", sdp: m.sdp });
        this.#remoteSet = true;
        await this.#drainIce();
        await pc.setLocalDescription();
        if (pc.localDescription) this.#signaling.send({ kind: "answer", sdp: pc.localDescription.sdp });
        this.#setState("connecting");
        return;
      }
      case "answer":
        if (!pc) return;
        await pc.setRemoteDescription({ type: "answer", sdp: m.sdp });
        this.#remoteSet = true;
        await this.#drainIce();
        return;
      case "ice":
        if (!pc) return;
        if (!this.#remoteSet) {
          this.#pendingIce.push(m.candidate);
          return;
        }
        try {
          await pc.addIceCandidate(m.candidate);
        } catch {
          // candidate for a stale generation after ICE restart; ignore
        }
        return;
      case "peer-left":
        this.#setState("reconnecting");
        return;
      case "error":
        this.close();
        return;
      case "join":
        return;
    }
  }

  async #drainIce(): Promise<void> {
    const pc = this.#pc;
    if (!pc) return;
    while (this.#pendingIce.length) {
      const c = this.#pendingIce.shift() as RTCIceCandidateInit;
      try {
        await pc.addIceCandidate(c);
      } catch {
        /* stale */
      }
    }
  }

  async #handleFailure(): Promise<void> {
    if (this.#state === "closed") return;
    const pc = this.#pc;
    if (!pc) return;
    this.#stopTimers();
    this.#setState("reconnecting");
    if (this.#iceRestarts < this.#opts.maxIceRestarts && this.#opts.role === Role.Host) {
      this.#iceRestarts++;
      const delay = Math.min(4000, 250 * 2 ** (this.#iceRestarts - 1));
      await new Promise((r) => setTimeout(r, delay));
      if ((this.#state as BridgeState) === "closed") return;
      pc.restartIce();
      return;
    }
    // Full teardown and re-negotiation.
    pc.close();
    this.#link = null;
    this.#iceRestarts = 0;
    this.#createPeerConnection();
    this.#signaling.send({ kind: "join", room: this.#opts.room, role: this.#opts.role === Role.Host ? "host" : "client" });
  }

  // ---------- connected housekeeping ----------

  #onLinkOpen(): void {
    this.#iceRestarts = 0;
    this.#setState("connected");
    this.#sendControl({ type: MsgType.Hello, role: this.#opts.role, protocolVersion: PROTOCOL_VERSION, capabilities: 0 });
    this.#startTimers();
    void this.#emitSafetyCode();
    this.#flushTelemetry(true);
  }

  #startTimers(): void {
    this.#stopTimers();
    this.#pingTimer = setInterval(() => {
      const id = ++this.#pingId;
      const t0 = nowUs();
      this.#pendingPings.set(id, t0);
      if (this.#pendingPings.size > 16) {
        const oldest = this.#pendingPings.keys().next().value;
        if (oldest !== undefined) this.#pendingPings.delete(oldest);
      }
      this.#sendControl({ type: MsgType.Ping, id, t0 });
    }, this.#opts.pingIntervalMs);
    this.#statsTimer = setInterval(() => void this.#emitStats(), this.#opts.statsIntervalMs);
  }

  #stopTimers(): void {
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    if (this.#statsTimer) clearInterval(this.#statsTimer);
    this.#pingTimer = null;
    this.#statsTimer = null;
  }

  async #emitStats(): Promise<void> {
    if (this.#pc) {
      try {
        const report = await this.#pc.getStats();
        report.forEach((r: RTCStats) => {
          const rr = r as RTCStats & { type: string; state?: string; nominated?: boolean; localCandidateId?: string };
          if (rr.type === "candidate-pair" && rr.state === "succeeded" && rr.nominated && rr.localCandidateId) {
            const local = report.get(rr.localCandidateId) as (RTCStats & { candidateType?: string }) | undefined;
            this.#stats.pairType = local?.candidateType ?? "";
          }
        });
      } catch {
        /* stats unsupported */
      }
    }
    this.#events.onStats?.(this.stats());
  }

  stats(): BridgeStats {
    return {
      state: this.#state,
      transport: this.#link?.kind ?? "none",
      rttMinUs: this.clock.ready ? this.clock.minRttUs : 0,
      rttP50Us: this.clock.ready ? this.clock.p50RttUs : 0,
      rttP99Us: this.clock.ready ? this.clock.p99RttUs : 0,
      jitterUs: this.clock.jitterUs,
      clockOffsetUs: this.clock.offsetUs,
      telemetrySent: this.#stats.sent,
      telemetryReceived: this.#stats.received,
      telemetryQueued: this.#queue.length,
      bytesSent: this.#stats.bytesSent,
      bytesReceived: this.#stats.bytesReceived,
      iceCandidatePairType: this.#stats.pairType,
    };
  }

  /**
   * 4-digit pairing safety code from both DTLS fingerprints, sorted so both
   * sides compute the same value. Shown on both screens; a mismatch means the
   * signaling relay substituted an SDP.
   */
  async #emitSafetyCode(): Promise<void> {
    const pc = this.#pc;
    if (!pc || !pc.localDescription || !pc.remoteDescription) return;
    const fp = (sdp: string) => /a=fingerprint:sha-256 ([0-9A-F:]+)/i.exec(sdp)?.[1]?.toUpperCase() ?? "";
    const a = fp(pc.localDescription.sdp);
    const b = fp(pc.remoteDescription.sdp);
    if (!a || !b) return;
    const joined = [a, b].sort().join("|");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(joined)));
    const code = (new DataView(digest.buffer).getUint32(0, false) % 10_000).toString().padStart(4, "0");
    this.#events.onSafetyCode?.(code);
  }

  #setState(s: BridgeState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.#events.onState?.(s);
  }
}

class WebRtcLink implements Link {
  readonly kind = "webrtc" as const;
  constructor(private readonly telemetry: RTCDataChannel, private readonly control: RTCDataChannel) {}
  sendTelemetry(buf: ArrayBuffer): void {
    if (this.telemetry.readyState === "open") this.telemetry.send(buf);
  }
  sendControl(buf: ArrayBuffer): void {
    if (this.control.readyState === "open") this.control.send(buf);
  }
  telemetryBufferedAmount(): number {
    return this.telemetry.bufferedAmount;
  }
  controlBufferedAmount(): number {
    return this.control.bufferedAmount;
  }
  close(): void {
    this.telemetry.close();
    this.control.close();
  }
}

/**
 * USB fallback: a single WebSocket to the native companion on the usbmuxd-forwarded
 * port (e.g. ws://127.0.0.1:27042). Frames are the same binary messages; a 1-byte
 * channel prefix (0 telemetry, 1 control) is added because WebSocket has one stream.
 * TCP makes the telemetry channel reliable and ordered, which costs retransmit
 * delay on a lossy link, but USB is lossless so this is the right trade.
 */
export class WebSocketLink implements Link {
  readonly kind = "websocket" as const;
  readonly #ws: WebSocket;
  constructor(url: string, onData: (buf: ArrayBuffer) => void, onOpen: () => void, onClose: () => void) {
    this.#ws = new WebSocket(url);
    this.#ws.binaryType = "arraybuffer";
    this.#ws.onopen = onOpen;
    this.#ws.onclose = onClose;
    this.#ws.onerror = onClose;
    this.#ws.onmessage = (e) => {
      const data = e.data as ArrayBuffer;
      if (data.byteLength < 2) return;
      onData(data.slice(1));
    };
  }
  #send(channel: number, buf: ArrayBuffer): void {
    if (this.#ws.readyState !== WebSocket.OPEN) return;
    const out = new Uint8Array(1 + buf.byteLength);
    out[0] = channel;
    out.set(new Uint8Array(buf), 1);
    this.#ws.send(out);
  }
  sendTelemetry(buf: ArrayBuffer): void {
    this.#send(0, buf);
  }
  sendControl(buf: ArrayBuffer): void {
    this.#send(1, buf);
  }
  telemetryBufferedAmount(): number {
    return this.#ws.bufferedAmount;
  }
  controlBufferedAmount(): number {
    return this.#ws.bufferedAmount;
  }
  close(): void {
    this.#ws.close();
  }
}
