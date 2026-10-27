/**
 * Autosave and crash recovery.
 *
 * Every `intervalSec` (default 120 s) while the document is dirty, and whenever the tab is
 * hidden or about to unload, a recovery snapshot is written:
 *   - vault unlocked: encrypted with K_d into the OPFS asset slot RECOVERY_ID (zero-knowledge
 *     path, same AES-GCM envelope as an explicit save, separate slot so it never overwrites it)
 *   - vault locked or not enrolled: plain serialized bytes in the OPFS sandbox file
 *     `recovery/plain.omniraw`. This stays on the device and never syncs, but it IS readable by
 *     anything with access to this browser profile. The toggle "Plain recovery when locked"
 *     turns it off for people who would rather lose unsaved work than keep plaintext on disk.
 * Timestamps live in localStorage: on startup, if a recovery snapshot is newer than the last
 * explicit save, the vault panel offers Restore / Discard. Restore loads it into the document
 * and clears the snapshot.
 */
import type { AppState } from "./state.js";
import type { VaultController } from "./vault-panel.js";
import { packStory, unpackStory } from "./story.js";

const RECOVERY_ID = new Uint8Array([0x4f, 0x4d, 0x4e, 0x49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
const PLAIN_PATH = "recovery/plain.omniraw";
const UNDO_PATH = "recovery/undo.json";
const LS_SAVE = "omni.lastSave", LS_AUTO = "omni.lastAutosave", LS_KIND = "omni.lastAutosaveKind";

export interface AutosaveState { undoSaved?: number; enabled: boolean; intervalSec: number; plainWhenLocked: boolean; dirty: boolean; lastAt: number; lastKind: "encrypted" | "plain" | ""; pending: { at: number; kind: string } | null; message: string }

export function installAutosave(app: AppState, vault: VaultController): { saveNow: () => Promise<void>; restore: () => Promise<void>; discard: () => Promise<void>; markSaved: () => void } {
  const st: AutosaveState = app.autosave;
  const ls = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
  const markDirty = () => { st.dirty = true; };
  for (const ev of ["stroke-end", "layers", "vector", "panels", "timeline", "frame"]) app.on(ev, markDirty);
  let busy = false;

  async function saveNow(): Promise<void> {
    if (busy || !st.enabled) return;
    busy = true;
    try {
      const t0 = performance.now();
      const bytes = await packStory(app);
      let kind: "encrypted" | "plain";
      if (app.vault.unlocked) { await vault.account.putAsset(bytes, RECOVERY_ID); kind = "encrypted"; }
      else if (st.plainWhenLocked) { await vault.account.vault.writeFile(PLAIN_PATH, bytes); kind = "plain"; }
      else { st.message = "vault locked, plain recovery off: nothing written"; app.emit("autosave"); return; }
      // undo history that survives reload: the newest tile entries next to the snapshot
      try { const entries = await app.history.exportEntries(16); await vault.account.vault.writeFile(UNDO_PATH, new TextEncoder().encode(JSON.stringify(entries))); st.undoSaved = entries.length; } catch { st.undoSaved = 0; }
      st.dirty = false; st.lastAt = Date.now(); st.lastKind = kind;
      lsSet(LS_AUTO, String(st.lastAt)); lsSet(LS_KIND, kind);
      st.message = `autosaved ${(bytes.byteLength / 1024).toFixed(0)} KB ${kind} + ${st.undoSaved} undo steps in ${Math.round(performance.now() - t0)} ms`;
      app.emit("autosave");
    } catch (e) { st.message = `autosave failed: ${e instanceof Error ? e.message : String(e)}`; app.emit("autosave"); }
    finally { busy = false; }
  }
  const tick = () => { if (st.dirty && st.enabled) void saveNow(); };
  let timer = window.setInterval(tick, st.intervalSec * 1000);
  app.on("autosave-config", () => { window.clearInterval(timer); timer = window.setInterval(tick, Math.max(10, st.intervalSec) * 1000); });
  document.addEventListener("visibilitychange", () => { if (document.hidden && st.dirty) void saveNow(); });
  window.addEventListener("beforeunload", () => { if (st.dirty) void saveNow(); });

  async function clearSnapshots(): Promise<void> {
    try { await vault.account.vault.deleteFile(PLAIN_PATH); } catch { /* none */ }
    try { await vault.account.vault.deleteFile(UNDO_PATH); } catch { /* none */ }
    try { localStorage.removeItem(LS_AUTO); localStorage.removeItem(LS_KIND); } catch { /* private mode */ }
    st.pending = null; app.emit("autosave");
  }
  async function restore(): Promise<void> {
    const p = st.pending; if (!p) return;
    try {
      const bytes = p.kind === "encrypted" ? await vault.account.getAsset(RECOVERY_ID) : await vault.account.vault.readFile(PLAIN_PATH);
      const idMap = await unpackStory(app, bytes);
      app.cache.index(app.doc); app.renderer.fitPage(app.doc);
      app.invalidate(); app.emit("layers"); app.emit("timeline"); app.emit("panels"); app.emit("doc-loaded"); app.emit("story");
      let undoN = 0;
      try {
        const txt = new TextDecoder().decode(await vault.account.vault.readFile(UNDO_PATH)); const entries = JSON.parse(txt) as import("../engine/history.js").SerializedEntry[];
        for (const e of entries) e.layerId = idMap.get(e.layerId) ?? e.layerId; // layers get fresh ids on load
        await app.history.importEntries(entries); undoN = entries.length;
      } catch { /* no undo file */ }
      st.message = `restored ${(bytes.byteLength / 1024).toFixed(0)} KB from ${new Date(p.at).toLocaleTimeString()}${undoN ? `, ${undoN} undo steps` : ""}`;
      st.dirty = true;
    } catch (e) { st.message = `restore failed: ${e instanceof Error ? e.message : String(e)}`; }
    st.pending = null; app.emit("autosave");
  }
  async function discard(): Promise<void> { await clearSnapshots(); st.message = "recovery snapshot discarded"; app.emit("autosave"); }
  function markSaved(): void { lsSet(LS_SAVE, String(Date.now())); st.dirty = false; void clearSnapshots(); }

  // startup: is there unsaved work newer than the last explicit save?
  const auto = Number(ls(LS_AUTO) ?? 0), saved = Number(ls(LS_SAVE) ?? 0), kind = ls(LS_KIND) ?? "";
  if (auto > saved && kind) {
    st.pending = { at: auto, kind };
    st.message = `unsaved work from ${new Date(auto).toLocaleString()} (${kind})`;
    app.emit("autosave");
  }
  return { saveNow, restore, discard, markSaved };
}
