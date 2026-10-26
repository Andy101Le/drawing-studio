/**
 * OMNI-Bridge signaling relay. Run: npm run signaling  (PORT env, default 8787)
 *
 * Pairs exactly one host and one client per 6-digit room, forwards offer /
 * answer / ice verbatim, and tells each side when the other arrives or leaves.
 * It holds no media, no stylus data, no keys. Rooms expire 10 minutes after
 * creation and joins are rate-limited per IP to blunt room-code guessing.
 *
 * On a LAN this can run on the host laptop itself (the iPad connects to
 * ws://<laptop-ip>:8787). For the web-only first milestone it runs wherever the
 * web app is served.
 */

import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { SignalMessage } from "../web/src/sync/signaling.js";
import { isSignalMessage } from "../web/src/sync/signaling.js";

const PORT = Number(process.env.PORT ?? 8787);
const ROOM_TTL_MS = 10 * 60 * 1000;
const JOIN_LIMIT_PER_MIN = 20;

interface Room {
  host: WebSocket | null;
  client: WebSocket | null;
  createdAt: number;
}

const rooms = new Map<string, Room>();
const joinCounts = new Map<string, { count: number; windowStart: number }>();
const socketRoom = new WeakMap<WebSocket, { room: string; role: "host" | "client" }>();

function send(ws: WebSocket, msg: SignalMessage): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  const e = joinCounts.get(ip);
  if (!e || now - e.windowStart > 60_000) {
    joinCounts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  e.count++;
  return e.count > JOIN_LIMIT_PER_MIN;
}

function leave(ws: WebSocket): void {
  const info = socketRoom.get(ws);
  if (!info) return;
  const room = rooms.get(info.room);
  socketRoom.delete(ws);
  if (!room) return;
  if (info.role === "host") room.host = null;
  else room.client = null;
  const other = info.role === "host" ? room.client : room.host;
  if (other) send(other, { kind: "peer-left" });
  if (!room.host && !room.client) rooms.delete(info.room);
}

/**
 * Zero-knowledge sync store (Phase 2 compliance surface). The server only ever sees:
 *   - the SHA-256 of the object id (route key), never the id or the project name
 *   - the ciphertext length and bytes (AES-GCM envelope made in the browser)
 *   - a Lamport timestamp chosen by the client
 * Conflict rule: last writer wins by Lamport; a PUT with a lower stamp than the stored one is
 * refused with 409 and the stored stamp, so the client can pull, merge locally and re-push.
 * No PII, no plaintext, no account identity: this is why the data directory can be backed up
 * anywhere. Storage: server/data/<hash>.bin + .json.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
const DATA = process.env.OMNI_SYNC_DIR ?? join(process.cwd(), "server", "data");
mkdirSync(DATA, { recursive: true });
const HASH_RE = /^[0-9a-f]{64}$/;
const cors = { "cross-origin-resource-policy": "cross-origin", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,PUT,OPTIONS", "access-control-allow-headers": "content-type,x-lamport", "access-control-expose-headers": "x-lamport,x-length" };
const http = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (req.method === "OPTIONS") { res.writeHead(204, cors); res.end(); return; }
  const m = url.pathname.match(/^\/sync\/([0-9a-f]{64})(\/meta)?$/);
  if (m && HASH_RE.test(m[1]!)) {
    const hash = m[1]!; const bin = join(DATA, `${hash}.bin`), meta = join(DATA, `${hash}.json`);
    if (req.method === "GET") {
      if (!existsSync(meta)) { res.writeHead(404, cors); res.end(); return; }
      const info = JSON.parse(readFileSync(meta, "utf8")) as { lamport: string; length: number; at: number };
      if (m[2]) { res.writeHead(200, { ...cors, "content-type": "application/json" }); res.end(JSON.stringify(info)); return; }
      res.writeHead(200, { ...cors, "content-type": "application/octet-stream", "x-lamport": info.lamport, "x-length": String(info.length) }); res.end(readFileSync(bin)); return;
    }
    if (req.method === "PUT") {
      const lamport = String(req.headers["x-lamport"] ?? "0"); if (!/^\d{1,20}$/.test(lamport)) { res.writeHead(400, cors); res.end("bad lamport"); return; }
      const chunks: Buffer[] = []; let size = 0;
      req.on("data", (c: Buffer) => { size += c.length; if (size > 512 * 1024 * 1024) { req.destroy(); return; } chunks.push(c); });
      req.on("end", () => {
        if (existsSync(meta)) { const cur = JSON.parse(readFileSync(meta, "utf8")) as { lamport: string }; if (BigInt(cur.lamport) >= BigInt(lamport)) { res.writeHead(409, { ...cors, "x-lamport": cur.lamport }); res.end("stale: pull first"); return; } }
        const body = Buffer.concat(chunks);
        writeFileSync(bin, body); writeFileSync(meta, JSON.stringify({ lamport, length: body.length, at: Date.now() }));
        res.writeHead(200, { ...cors, "x-lamport": lamport }); res.end();
      });
      return;
    }
  }
  res.writeHead(200, { ...cors, "content-type": "text/plain" });
  res.end("omni-bridge signaling + zero-knowledge sync store\n");
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

/**
 * Live sessions relay (/collab?room=X&name=Y). Rooms hold N members; every message is relayed
 * to the room (or to `to` only) with `from` stamped by the server, so identity cannot be forged.
 * The oldest member is asked for a snapshot whenever someone joins. Payloads up to 32 MB
 * (snapshots carry the whole story as base64 ciphertext-free bytes: the relay is a LAN tool,
 * see docs 19.4 for the zero-knowledge caveat).
 */
interface Member { ws: WebSocket; id: string; name: string; color: string }
const collabRooms = new Map<string, Member[]>();
const COLORS = ["#4f8ef7", "#f0a050", "#2ecc71", "#e056a0", "#9b59b6", "#1abc9c", "#e67e22", "#e74c3c"];
const cwss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
cwss.on("connection", (ws: WebSocket, req) => {
  const url = new URL(req.url ?? "/", "http://x"); const room = (url.searchParams.get("room") ?? "").slice(0, 64); const name = (url.searchParams.get("name") ?? "artist").slice(0, 32);
  if (!room) { ws.close(1008, "room required"); return; }
  const list = collabRooms.get(room) ?? []; collabRooms.set(room, list);
  const id = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const me: Member = { ws, id, name, color: COLORS[list.length % COLORS.length]! }; list.push(me);
  const pub = (m: Member) => ({ id: m.id, name: m.name, color: m.color });
  const relay = (msg: Record<string, unknown>, except?: WebSocket) => { const raw = JSON.stringify(msg); for (const m of list) if (m.ws !== except && m.ws.readyState === WebSocket.OPEN) m.ws.send(raw); };
  ws.send(JSON.stringify({ t: "hello", id, me: pub(me), members: list.map(pub) }));
  relay({ t: "join", from: id, member: pub(me) }, ws);
  if (list.length > 1) { const host = list[0]!; if (host.ws.readyState === WebSocket.OPEN) host.ws.send(JSON.stringify({ t: "need-snapshot", to: id })); }
  ws.on("message", (raw) => {
    let msg: Record<string, unknown>; try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
    if (typeof msg["t"] !== "string") return;
    msg["from"] = id;
    const to = typeof msg["to"] === "string" ? list.find((m) => m.id === msg["to"]) : null;
    if (to) { if (to.ws.readyState === WebSocket.OPEN) to.ws.send(JSON.stringify(msg)); }
    else if (typeof msg["exclude"] === "string") { const ex = list.find((m) => m.id === msg["exclude"]); const raw = JSON.stringify(msg); for (const m of list) if (m.ws !== ws && m !== ex && m.ws.readyState === WebSocket.OPEN) m.ws.send(raw); }
    else relay(msg, ws);
  });
  ws.on("close", () => { const i = list.indexOf(me); if (i >= 0) list.splice(i, 1); relay({ t: "leave", from: id }); if (!list.length) collabRooms.delete(room); });
});
http.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (path === "/collab") cwss.handleUpgrade(req, socket, head, (ws) => cwss.emit("connection", ws, req));
  else wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress ?? "unknown";
  ws.on("message", (raw) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!isSignalMessage(parsed)) return;
    const msg = parsed;

    if (msg.kind === "join") {
      if (!/^\d{6}$/.test(msg.room)) return send(ws, { kind: "error", message: "bad room code" });
      if (rateLimited(ip)) return send(ws, { kind: "error", message: "rate limited" });
      leave(ws);
      let room = rooms.get(msg.room);
      if (!room) {
        room = { host: null, client: null, createdAt: Date.now() };
        rooms.set(msg.room, room);
      }
      if (Date.now() - room.createdAt > ROOM_TTL_MS) return send(ws, { kind: "error", message: "room expired" });
      const slotTaken = msg.role === "host" ? room.host : room.client;
      if (slotTaken && slotTaken !== ws) return send(ws, { kind: "error", message: `${msg.role} already present` });
      if (msg.role === "host") room.host = ws;
      else room.client = ws;
      socketRoom.set(ws, { room: msg.room, role: msg.role });
      const other = msg.role === "host" ? room.client : room.host;
      if (other) {
        send(other, { kind: "peer-joined", role: msg.role });
        send(ws, { kind: "peer-joined", role: msg.role === "host" ? "client" : "host" });
      }
      return;
    }

    const info = socketRoom.get(ws);
    if (!info) return;
    const room = rooms.get(info.room);
    if (!room) return;
    const other = info.role === "host" ? room.client : room.host;
    if (!other) return;
    if (msg.kind === "offer" || msg.kind === "answer" || msg.kind === "ice") send(other, msg);
  });
  ws.on("close", () => leave(ws));
  ws.on("error", () => leave(ws));
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS) {
      for (const s of [room.host, room.client]) if (s) send(s, { kind: "error", message: "room expired" });
      rooms.delete(code);
    }
  }
}, 60_000).unref();

http.listen(PORT, () => {
  console.log(`omni-bridge signaling on :${PORT}`);
});
