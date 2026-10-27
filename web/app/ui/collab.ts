/**
 * Live sessions: several artists on one document over the /collab relay.
 *
 * What travels: strokes (preset, colour, layer index, samples), fills and gradients as
 * tile patches, balloon/layer additions, undo/redo by entry id, and a full snapshot for
 * late joiners. Every peer keeps the same history with the same entry ids, so undo is
 * per author and selective: Ctrl+Z reverts only your newest step, restoring its pixels
 * only where nobody has painted since.
 *
 * Ownership: each layer tile carries a byte per pixel naming who painted it last. When your
 * stroke, erase or fill would disturb enough of another present user's work (adaptive rule in conflicts())
 * artist on that layer, the change is applied locally as provisional, the owner gets a popup
 * (Accept / Reject / Always accept on this layer), and only on acceptance is it broadcast.
 * A rejection reverts it on your side and tells you. "Always accept" is a grant for
 * (you, that layer) that the owner can revoke in the Live tab.
 */
import type { AppState } from "./state.js";
import { h, clear, field, slider } from "./dom.js";
import { StrokeEngine, type BrushPreset, type StrokeSample } from "../engine/brush.js";
import { Layer, TILE } from "../engine/document.js";
import type { TileEntry } from "../engine/history.js";

export interface Member { id: string; name: string; color: string }
interface StrokeMsg { t: "stroke"; id: string; layer: number; preset: BrushPreset; color: string; samples: StrokeSample[]; from?: string }
interface PatchMsg { t: "patch"; id: string; layer: number; label: string; tiles: Array<{ x: number; y: number; png: string }>; from?: string }
interface Pending { id: string; owner: string; layer: number; msg: StrokeMsg | PatchMsg }
/** scales the conflict thresholds; persisted per browser */
const SENS_KEY = "omni.collab.sensitivity";

export class Collab {
  ws: WebSocket | null = null; me: Member | null = null; members: Member[] = []; room = ""; status = "offline";
  grants = new Set<string>();            // "requesterId:layerIdx" granted by me
  myGrants = new Set<string>();          // "ownerId:layerIdx" granted to me
  incoming: Array<{ id: string; from: Member; layer: number; kind: string; px: number }> = [];
  /** 0.3 (ask often) .. 3 (ask rarely); 1 = default */
  sensitivity = (() => { const v = Number(localStorage.getItem(SENS_KEY)); return v > 0 ? v : 1; })();
  setSensitivity(v: number): void { this.sensitivity = Math.max(0.3, Math.min(3, v)); try { localStorage.setItem(SENS_KEY, String(this.sensitivity)); } catch { /* quota */ } }
  pending = new Map<string, Pending>();
  log: string[] = [];
  private owners = new Map<number, Map<string, Uint8Array>>(); // layerId -> tileKey -> owner index per pixel
  private userIndex = new Map<string, number>();
  private current: { preset: BrushPreset; color: string; layer: number; samples: StrokeSample[] } | null = null;
  private applyingRemote = false;
  url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:8787/collab`;

  constructor(private app: AppState) {
    app.on("stroke-begin", () => { if (!this.ws || this.applyingRemote) return; this.current = { preset: { ...app.preset }, color: app.color, layer: this.layerIndex(app.doc.activeLayer.id), samples: [] }; });
    app.on("stroke-sample", (s) => { if (this.current) this.current.samples.push(s as StrokeSample); });
    app.history.onCommit = (e) => this.onLocalCommit(e);
    app.history.eagerAfter = () => this.online || this.applyingRemote;
  }
  private idx(user: string): number { let i = this.userIndex.get(user); if (!i) { i = this.userIndex.size + 1; this.userIndex.set(user, i); } return i; }
  private layerIndex(id: number): number { return this.app.doc.drawing.layers.findIndex((l) => l.id === id); }
  private note(s: string): void { this.log.unshift(`${new Date().toLocaleTimeString()} ${s}`); this.log.length = Math.min(this.log.length, 30); this.app.emit("collab"); }

  connect(room: string, name: string): void {
    this.disconnect(); this.room = room; this.status = "connecting";
    const ws = new WebSocket(`${this.url}?room=${encodeURIComponent(room)}&name=${encodeURIComponent(name)}`); this.ws = ws;
    ws.onopen = () => { this.status = "connected"; this.app.emit("collab"); };
    ws.onclose = () => { this.status = "offline"; this.ws = null; this.app.history.author = "local"; this.app.emit("collab"); };
    ws.onerror = () => { this.status = "error (is the relay running? npm run signaling)"; this.app.emit("collab"); };
    ws.onmessage = (ev) => { void this.onMessage(JSON.parse(String(ev.data)) as Record<string, unknown>); };
  }
  disconnect(): void { this.ws?.close(); this.ws = null; this.members = []; this.me = null; this.status = "offline"; this.app.history.author = "local"; this.app.emit("collab"); }
  private send(msg: object): void { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }
  get online(): boolean { return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.me; }

  // ---------------------------------------------------------------- messages
  private async onMessage(m: Record<string, unknown>): Promise<void> {
    const app = this.app;
    switch (m["t"]) {
      case "hello": { this.me = m["me"] as Member; this.members = m["members"] as Member[]; app.history.author = this.me.id; this.idx(this.me.id); this.note(`joined "${this.room}" as ${this.me.name}`); break; }
      case "join": { const mem = m["member"] as Member; this.members.push(mem); this.note(`${mem.name} joined`); break; }
      case "leave": { const id = m["from"] as string; const mem = this.members.find((x) => x.id === id); this.members = this.members.filter((x) => x.id !== id); this.note(`${mem?.name ?? id} left`); break; }
      case "need-snapshot": { const { packStory } = await import("./story.js"); const bytes = await packStory(app); this.send({ t: "snapshot", to: m["to"], data: b64(bytes), owners: this.exportOwners(), users: [...this.userIndex.entries()] }); break; }
      case "snapshot": {
        const { unpackStory } = await import("./story.js"); await unpackStory(app, unb64(m["data"] as string));
        app.cache.index(app.doc); app.renderer.fitPage(app.doc); app.invalidate(); app.emit("layers"); app.emit("timeline"); app.emit("panels"); app.emit("doc-loaded"); app.emit("story");
        this.userIndex = new Map(m["users"] as Array<[string, number]>); this.importOwners(m["owners"] as Record<string, Record<string, string>>);
        this.note("received the document snapshot"); break;
      }
      case "stroke": { this.applyStroke(m as unknown as StrokeMsg); break; }
      case "patch": { await this.applyPatch(m as unknown as PatchMsg); break; }
      case "undo": case "redo": { const ok = app.history.applyRemote(app.doc, m["id"] as string, m["t"] as "undo" | "redo"); const who = this.members.find((x) => x.id === m["from"])?.name ?? "peer"; this.note(`${who} ${m["t"] === "undo" ? "undid" : "redid"} a step${ok ? "" : " (unknown id)"}`); app.invalidate(); app.emit("layers"); break; }
      case "request": {
        const from = this.members.find((x) => x.id === m["from"]); if (!from) break;
        this.incoming.push({ id: m["id"] as string, from, layer: m["layer"] as number, kind: m["kind"] as string, px: m["px"] as number });
        this.pendingMsgs.set(m["id"] as string, m["msg"] as StrokeMsg | PatchMsg);
        this.note(`${from.name} asks to ${m["kind"]} over your work on layer ${(m["layer"] as number) + 1}`); break;
      }
      case "decision": {
        const p = this.pending.get(m["id"] as string); if (!p) break; this.pending.delete(p.id);
        if (m["ok"]) { if (m["always"]) this.myGrants.add(`${p.owner}:${p.layer}`); const entry = app.history.entryById(p.id); if (entry) this.updateOwners(entry, this.me!.id); this.send({ ...p.msg, exclude: p.owner }); this.note(`accepted${m["always"] ? " (always on this layer)" : ""}`); }
        else { app.history.revoke(app.doc, p.id); app.invalidate(); app.emit("layers"); this.note("rejected: your change was reverted"); }
        break;
      }
      case "revoke-grant": { this.myGrants.delete(`${m["from"]}:${m["layer"]}`); this.note("an always-accept grant was revoked"); break; }
      case "layer-add": { const l = app.doc.addLayer(m["kind"] as "raster"); l.name = m["name"] as string; app.emit("layers"); break; }
      case "balloon": { app.doc.balloons.push(m["balloon"] as never); app.invalidate(); app.emit("balloons"); break; }
    }
    app.emit("collab");
  }
  private pendingMsgs = new Map<string, StrokeMsg | PatchMsg>();

  // ---------------------------------------------------------------- local commits
  private onLocalCommit(e: TileEntry): void {
    const app = this.app;
    if (this.applyingRemote) { this.updateOwners(e, e.author); return; }
    if (!this.online) return;
    const layerIdx = this.layerIndex(e.before.layerId); if (layerIdx < 0) return;
    const diff = this.conflicts(e);
    const msg: StrokeMsg | PatchMsg = this.current && e.label.startsWith("Brush") || e.label === "Erase" || e.label === "Smudge" || e.label === "Blur"
      ? (this.current ? { t: "stroke", id: e.id, layer: layerIdx, preset: this.current.preset, color: this.current.color, samples: this.current.samples } : this.patchFrom(e, layerIdx))
      : this.patchFrom(e, layerIdx);
    this.current = null;
    const owner = diff.owner;
    if (owner && owner !== this.me!.id && this.members.some((x) => x.id === owner) && !this.myGrants.has(`${owner}:${layerIdx}`)) {
      this.pending.set(e.id, { id: e.id, owner, layer: layerIdx, msg });
      this.send({ t: "request", to: owner, id: e.id, layer: layerIdx, kind: e.label === "Erase" ? "erase" : "draw", px: diff.px, msg });
      this.note(`asking ${this.members.find((x) => x.id === owner)?.name ?? "owner"} for permission (${diff.px} px of theirs)`);
    } else { this.updateOwners(e, this.me!.id); this.send(msg); }
  }
  /** pixels of other present users this entry changed; returns the most affected owner */
  /**
   * Does this entry disturb another present user's work enough to ask?
   * Adaptive rule (not a fixed pixel count): px = changed pixels owned by someone else,
   * total = all changed pixels. Ask when px >= floor AND px/total >= ratio, or when px alone
   * is large. Erasing has a lower floor and ratio than painting over, because removal is what
   * people mind. `sensitivity` scales every threshold (0.3 = ask often, 3 = ask rarely).
   */
  private conflicts(e: TileEntry): { owner: string | null; px: number; total: number; removed: number } {
    const counts = new Map<string, number>(); const removedBy = new Map<string, number>(); const map = this.owners.get(e.before.layerId); let total = 0;
    if (!map) return { owner: null, px: 0, total: 0, removed: 0 };
    const byIndex = new Map<number, string>(); for (const [u, i] of this.userIndex) byIndex.set(i, u);
    for (const a of e.after.entries) {
      const own = map.get(`${a.x},${a.y}`);
      const b = e.before.entries.find((q) => q.x === a.x && q.y === a.y)?.data?.data ?? null; const ad = a.data?.data ?? null;
      for (let p = 0, i = 0; p < TILE * TILE; p++, i += 4) {
        const changed = ad ? (!b || b[i] !== ad[i] || b[i + 1] !== ad[i + 1] || b[i + 2] !== ad[i + 2] || b[i + 3] !== ad[i + 3]) : (!!b && b[i + 3]! > 0);
        if (!changed) continue; total++;
        const o = own ? own[p]! : 0; if (!o) continue; const u = byIndex.get(o); if (!u || u === this.me?.id) continue;
        counts.set(u, (counts.get(u) ?? 0) + 1);
        const ba = b ? b[i + 3]! : 0, aa = ad ? ad[i + 3]! : 0; if (aa < ba) removedBy.set(u, (removedBy.get(u) ?? 0) + 1);
      }
    }
    let best: string | null = null, px = 0; for (const [u, n] of counts) if (n > px) { px = n; best = u; }
    const removed = best ? (removedBy.get(best) ?? 0) : 0;
    const sens = this.sensitivity; const erasing = removed > px * 0.5 || /^Erase/.test(e.label);
    const floor = (erasing ? 12 : 25) * sens, ratio = (erasing ? 0.04 : 0.12) * sens, big = 400 * sens;
    const hit = px >= floor && (px / Math.max(1, total) >= ratio || px >= big);
    return hit ? { owner: best, px, total, removed } : { owner: null, px, total, removed };
  }
  private updateOwners(e: TileEntry, author: string): void {
    let map = this.owners.get(e.before.layerId); if (!map) { map = new Map(); this.owners.set(e.before.layerId, map); }
    const idx = this.idx(author);
    for (const a of e.after.entries) {
      const key = `${a.x},${a.y}`; let own = map.get(key); if (!own) { own = new Uint8Array(TILE * TILE); map.set(key, own); }
      const b = e.before.entries.find((q) => q.x === a.x && q.y === a.y)?.data?.data ?? null; const ad = a.data?.data ?? null;
      for (let p = 0, i = 0; p < TILE * TILE; p++, i += 4) {
        const aa = ad ? ad[i + 3]! : 0, ba = b ? b[i + 3]! : 0;
        if (aa > 0 && (!b || b[i] !== ad![i] || b[i + 1] !== ad![i + 1] || b[i + 2] !== ad![i + 2] || ba !== aa)) own[p] = idx;
        else if (aa === 0 && ba > 0) own[p] = 0;
      }
    }
  }
  private exportOwners(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    for (const [layerId, map] of this.owners) { const li = this.layerIndex(layerId); if (li < 0) continue; out[li] = {}; for (const [k, v] of map) out[li]![k] = b64(v); }
    return out;
  }
  private importOwners(o: Record<string, Record<string, string>>): void {
    this.owners.clear();
    for (const [li, tiles] of Object.entries(o)) { const layer = this.app.doc.drawing.layers[Number(li)]; if (!layer) continue; const map = new Map<string, Uint8Array>(); for (const [k, v] of Object.entries(tiles)) map.set(k, unb64(v)); this.owners.set(layer.id, map); }
  }
  private patchFrom(e: TileEntry, layerIdx: number): PatchMsg {
    const c = document.createElement("canvas"); c.width = TILE; c.height = TILE; const g = c.getContext("2d")!;
    const tiles: PatchMsg["tiles"] = [];
    for (const a of e.after.entries) { g.clearRect(0, 0, TILE, TILE); if (a.data) g.putImageData(a.data, 0, 0); tiles.push({ x: a.x, y: a.y, png: c.toDataURL("image/png") }); }
    return { t: "patch", id: e.id, layer: layerIdx, label: e.label, tiles };
  }

  // ---------------------------------------------------------------- remote application
  private applyStroke(m: StrokeMsg): void {
    const app = this.app; const layer = app.doc.drawing.layers[m.layer]; if (!layer || layer.kind !== "raster" && layer.kind !== "tone") return;
    this.applyingRemote = true; const prevAuthor = app.history.author; app.history.author = m.from ?? "remote"; app.history.nextId = m.id;
    const eng = new StrokeEngine({ preset: m.preset, color: m.color, layer, pageWidth: app.doc.width, pageHeight: app.doc.height, docScale: app.doc.width / 2480, beforeTileWrite: (l, tx, ty) => app.history.capture(l, tx, ty) });
    app.history.begin(layer, { x0: 0, y0: 0, x1: 0, y1: 0 }, m.preset.kind === "eraser" ? "Erase" : `Brush ${m.preset.name}`);
    const s0 = m.samples[0]; if (s0) { eng.begin(s0); for (const s of m.samples.slice(1)) eng.move(s); eng.end(); }
    const rect = eng.commit(); app.history.commit(rect); app.history.author = prevAuthor; this.applyingRemote = false;
    app.invalidate(rect); app.emit("layers");
  }
  private async applyPatch(m: PatchMsg): Promise<void> {
    const app = this.app; const layer = app.doc.drawing.layers[m.layer]; if (!layer) return;
    this.applyingRemote = true; const prevAuthor = app.history.author; app.history.author = m.from ?? "remote"; app.history.nextId = m.id;
    app.history.begin(layer, { x0: 0, y0: 0, x1: 0, y1: 0 }, m.label);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of m.tiles) {
      app.history.capture(layer, t.x, t.y); const tile = layer.getTile(t.x, t.y, true)!; if (!tile.ctx) continue;
      const img = new Image(); img.src = t.png; await img.decode();
      const c = tile.ctx as CanvasRenderingContext2D; c.clearRect(0, 0, TILE, TILE); c.drawImage(img, 0, 0); tile.generation++;
      x0 = Math.min(x0, t.x * TILE); y0 = Math.min(y0, t.y * TILE); x1 = Math.max(x1, (t.x + 1) * TILE); y1 = Math.max(y1, (t.y + 1) * TILE);
    }
    layer.generation++; app.history.commit({ x0, y0, x1, y1 }); app.history.author = prevAuthor; this.applyingRemote = false;
    app.invalidate({ x0, y0, x1, y1 }); app.emit("layers");
  }

  // ---------------------------------------------------------------- user actions
  undo(): boolean { if (!this.online) return false; const e = this.app.history.undoBy(this.app.doc, this.me!.id); if (e) { this.send({ t: "undo", id: e.id }); this.app.invalidate(); this.app.emit("layers"); } return true; }
  redo(): boolean { if (!this.online) return false; const e = this.app.history.redoBy(this.app.doc, this.me!.id); if (e) { this.send({ t: "redo", id: e.id }); this.app.invalidate(); this.app.emit("layers"); } return true; }
  decide(id: string, ok: boolean, always: boolean): void {
    const req = this.incoming.find((r) => r.id === id); if (!req) return;
    this.incoming = this.incoming.filter((r) => r.id !== id);
    if (ok) { const msg = this.pendingMsgs.get(id); if (msg) { if (msg.t === "stroke") this.applyStroke({ ...msg, from: req.from.id }); else void this.applyPatch({ ...msg, from: req.from.id }); } if (always) this.grants.add(`${req.from.id}:${req.layer}`); }
    this.pendingMsgs.delete(id);
    this.send({ t: "decision", to: req.from.id, id, ok, always });
    this.note(`${ok ? "accepted" : "rejected"} ${req.from.name}'s ${req.kind}`); this.app.emit("collab");
  }
  revokeGrant(key: string): void { this.grants.delete(key); const [user, layer] = key.split(":"); this.send({ t: "revoke-grant", to: user, layer: Number(layer) }); this.app.emit("collab"); }
  shareLayerAdd(l: Layer): void { if (this.online) this.send({ t: "layer-add", kind: l.kind, name: l.name }); }
}

function b64(u: Uint8Array): string { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s: string): Uint8Array { const bin = atob(s); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

// ---------------------------------------------------------------- UI
export function collabPanel(app: AppState, c: Collab): HTMLElement {
  const root = h("div");
  const nameIn = h("input", { type: "text", value: localStorage.getItem("omni.collabName") ?? "artist", style: { width: "100%" } }) as HTMLInputElement;
  const roomIn = h("input", { type: "text", value: localStorage.getItem("omni.collabRoom") ?? "studio-1", style: { width: "100%" } }) as HTMLInputElement;
  const render = () => {
    clear(root).append(h("h3", {}, "Live session"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "Draw together on one document. Undo only touches your own steps. Changing another artist's pixels on their layer asks them first."),
      field("Name", nameIn), field("Room", roomIn),
      h("div", { class: "row", style: { gap: "6px", margin: "6px 0" } },
        c.online ? h("button", { onClick: () => c.disconnect() }, "Leave") : h("button", { onClick: () => { localStorage.setItem("omni.collabName", nameIn.value); localStorage.setItem("omni.collabRoom", roomIn.value); c.connect(roomIn.value, nameIn.value); } }, "Join"),
        h("span", { class: `chip ${c.online ? "ok" : ""}` }, c.status)),
      h("div", { class: "kv" }, ...c.members.flatMap((m) => [h("span", { style: { color: m.color } }, `● ${m.name}${c.me && m.id === c.me.id ? " (you)" : ""}`), h("b", {}, m.id.slice(0, 6))])),
      c.grants.size ? h("div", {}, h("div", { class: "sep" }), h("h3", {}, "Always-accept grants"), ...[...c.grants].map((k) => { const [u, l] = k.split(":"); const m = c.members.find((x) => x.id === u); return h("div", { class: "row", style: { gap: "6px" } }, h("span", {}, `${m?.name ?? u} on layer ${Number(l) + 1}`), h("button", { onClick: () => c.revokeGrant(k) }, "Revoke")); })) : null,
      c.pending.size ? h("div", { class: "notice", style: { marginTop: "6px" } }, `${c.pending.size} change${c.pending.size > 1 ? "s" : ""} waiting for permission`) : null,
      h("div", { class: "sep" }), h("h3", {}, "Permission sensitivity"),
      field("Ask when", slider(0.3, 3, 0.1, c.sensitivity, (v) => { c.setSensitivity(v); }), () => c.sensitivity <= 0.6 ? "touching a little" : c.sensitivity >= 1.8 ? "only large changes" : "a clear change"),
      h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, "Adaptive: a change asks when it disturbs at least ~25 px of someone else's work (12 px when erasing) AND that is a real share of the stroke, or when it covers a lot of their work regardless. Grazing a line with a big fill does not ask; erasing part of it does."),
      h("div", { class: "sep" }), h("div", { class: "mono dim", style: { fontSize: "10.5px", whiteSpace: "pre-wrap" } }, c.log.slice(0, 8).join("\n")));
  };
  app.on("collab", render); render();
  return root;
}

/** Permission popups (top right), one card per incoming request. */
export function installCollabPopups(app: AppState, c: Collab): void {
  const host = h("div", { id: "collab-popups" }); document.body.append(host);
  const render = () => {
    clear(host).append(...c.incoming.map((r) => h("div", { class: "popup" },
      h("div", { class: "popup-title" }, h("span", { style: { color: r.from.color } }, "● "), `${r.from.name} wants to ${r.kind} over your work`),
      h("div", { class: "dim", style: { fontSize: "11.5px" } }, `layer ${r.layer + 1} · ${r.px} px of yours`),
      h("div", { class: "row", style: { gap: "6px", marginTop: "8px" } },
        h("button", { class: "active", onClick: () => c.decide(r.id, true, false) }, "Accept"),
        h("button", { onClick: () => c.decide(r.id, false, false) }, "Reject"),
        h("button", { title: "Accept this and every later change from them on this layer", onClick: () => c.decide(r.id, true, true) }, "Always accept (this layer)")))));
  };
  app.on("collab", render);
}
