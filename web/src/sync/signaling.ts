/**
 * Phase 4.1: signaling transport. Carries SDP and ICE candidates between the
 * two peers before the P2P data channels exist. It is NOT in the stylus data
 * path. Any transport works; the reference is a tiny WebSocket relay
 * (server/signaling.ts) that pairs peers by a 6-digit room code shown on the
 * host screen and typed on the iPad.
 *
 * Security: the relay sees SDP (which contains local IPs / mDNS names) and
 * nothing else. DTLS fingerprints in SDP authenticate the data channel; to stop
 * a malicious relay from MITM-ing the pairing, both peers display a 4-digit
 * safety code derived from both DTLS fingerprints (see BridgePeer.safetyCode).
 */

export type SignalMessage =
  | { kind: "join"; room: string; role: "host" | "client" }
  | { kind: "peer-joined"; role: "host" | "client" }
  | { kind: "peer-left" }
  | { kind: "offer"; sdp: string }
  | { kind: "answer"; sdp: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit }
  | { kind: "error"; message: string };

export interface SignalingTransport {
  send(msg: SignalMessage): void;
  onMessage(handler: (msg: SignalMessage) => void): void;
  onClose(handler: () => void): void;
  close(): void;
}

export class WebSocketSignaling implements SignalingTransport {
  readonly #ws: WebSocket;
  #msgHandler: ((m: SignalMessage) => void) | null = null;
  #closeHandler: (() => void) | null = null;
  readonly #queue: string[] = [];

  constructor(url: string) {
    this.#ws = new WebSocket(url);
    this.#ws.onopen = () => {
      for (const q of this.#queue) this.#ws.send(q);
      this.#queue.length = 0;
    };
    this.#ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }
      if (isSignalMessage(parsed)) this.#msgHandler?.(parsed);
    };
    this.#ws.onclose = () => this.#closeHandler?.();
    this.#ws.onerror = () => this.#closeHandler?.();
  }

  send(msg: SignalMessage): void {
    const s = JSON.stringify(msg);
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(s);
    else this.#queue.push(s);
  }
  onMessage(handler: (msg: SignalMessage) => void): void {
    this.#msgHandler = handler;
  }
  onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }
  close(): void {
    this.#ws.close();
  }
}

export function isSignalMessage(v: unknown): v is SignalMessage {
  if (typeof v !== "object" || v === null) return false;
  const k = (v as { kind?: unknown }).kind;
  switch (k) {
    case "join":
      return typeof (v as { room?: unknown }).room === "string" && ["host", "client"].includes((v as { role?: string }).role ?? "");
    case "peer-joined":
      return ["host", "client"].includes((v as { role?: string }).role ?? "");
    case "peer-left":
      return true;
    case "offer":
    case "answer":
      return typeof (v as { sdp?: unknown }).sdp === "string";
    case "ice":
      return typeof (v as { candidate?: unknown }).candidate === "object";
    case "error":
      return typeof (v as { message?: unknown }).message === "string";
    default:
      return false;
  }
}

/** Room code: 6 digits, ~1 in 10^6 guess; the relay rate-limits joins. */
export function generateRoomCode(): string {
  const b = new Uint32Array(1);
  crypto.getRandomValues(b);
  return ((b[0] as number) % 1_000_000).toString().padStart(6, "0");
}
