/**
 * Vault panel: zero-knowledge account on this device. Enroll (password or
 * passkey PRF), unlock, lock, save/load the project encrypted in OPFS, export
 * the encrypted .omni blob, and show what the sync server would see.
 */

import { Account } from "@omni/crypto/account.js";
import { encryptAsset, decryptAsset } from "@omni/crypto/aead.js";
import { OpfsVault, KEYRING_PATH } from "@omni/crypto/opfs.js";
import { toHex } from "@omni/crypto/bytes.js";
import { assertPasskey, isPlatformAuthenticatorAvailable, registerPasskey } from "@omni/crypto/webauthn.js";
import { packStory, unpackStory } from "./story.js";
import { clear, field, h } from "./dom.js";
import type { AppState } from "./state.js";

const PROJECT_ID = new Uint8Array([0x4f, 0x4d, 0x4e, 0x49, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]); // fixed id for "current project" slot

export class VaultController {
  account = new Account(new OpfsVault());
  onSaved: (() => void) | null = null;
  constructor(private app: AppState) {
    void this.account.vault.exists(KEYRING_PATH).then((e) => { app.vault.enrolled = e; app.emit("vault"); }).catch(() => undefined);
  }
  private set(msg: string): void { this.app.vault.message = msg; this.app.vault.unlocked = this.account.session.isUnlocked; this.app.emit("vault"); }

  async enrollPassword(pw: string): Promise<void> {
    const t0 = performance.now();
    const r = await this.account.enrollWithPassword(pw);
    this.app.vault.enrolled = true;
    this.set(`enrolled in ${((performance.now() - t0) / 1000).toFixed(2)} s · K_auth ${toHex(r.authKey).slice(0, 12)}… (sent to server, never K_m)`);
  }
  async unlockPassword(pw: string): Promise<void> {
    const t0 = performance.now();
    try { await this.account.unlockWithPassword(pw); this.set(`unlocked in ${((performance.now() - t0) / 1000).toFixed(2)} s`); }
    catch { this.set("wrong password (GCM tag mismatch on K_d unwrap)"); }
  }
  async passkey(enroll: boolean): Promise<void> {
    if (!(await isPlatformAuthenticatorAvailable())) { this.set("no platform authenticator"); return; }
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    try {
      const prf = enroll
        ? (await registerPasskey({ rpId: location.hostname, rpName: "OMNI-CELL", userId: crypto.getRandomValues(new Uint8Array(16)), userName: "omni-user", challenge })).prfOutput
        : (await assertPasskey({ rpId: location.hostname, challenge })).prfOutput;
      if (!prf) { this.set("authenticator has no PRF extension; use the password path on this device"); return; }
      if (enroll) { await this.account.enrollWithPasskey(prf); this.app.vault.enrolled = true; this.set("enrolled with passkey (PRF seed)"); }
      else { await this.account.unlockWithPasskey(prf); this.set("unlocked with passkey"); }
    } catch (e) { this.set(`passkey: ${e instanceof Error ? e.message : String(e)}`); }
  }
  lock(): void { this.account.lock(); this.set("locked"); }
  async save(): Promise<void> {
    const t0 = performance.now();
    const bytes = await packStory(this.app);
    await this.account.putAsset(bytes, PROJECT_ID);
    const meta = await Account.syncMetadata(PROJECT_ID, bytes.byteLength + 40 + 16 * Math.ceil(bytes.byteLength / 1048576), BigInt(Date.now()));
    this.onSaved?.();
    this.set(`saved ${(bytes.byteLength / 1024).toFixed(0)} KB encrypted in ${((performance.now() - t0) / 1000).toFixed(2)} s · server sees {hash ${meta.objectIdHash.slice(0, 10)}…, lamport, ${meta.ciphertextLength} B}`);
  }
  async load(): Promise<void> {
    try {
      const bytes = await this.account.getAsset(PROJECT_ID);
      await unpackStory(this.app, bytes);
      this.app.cache.index(this.app.doc);
      this.app.renderer.fitPage(this.app.doc);
      this.app.invalidate(); this.app.emit("layers"); this.app.emit("timeline"); this.app.emit("panels"); this.app.emit("doc-loaded"); this.app.emit("story");
      this.set(`loaded ${(bytes.byteLength / 1024).toFixed(0)} KB`);
    } catch (e) { this.set(`load failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async exportEncrypted(): Promise<void> {
    const bytes = await packStory(this.app);
    const ct = await encryptAsset(this.account.session.dataKey, PROJECT_ID, bytes);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([ct as BlobPart], { type: "application/octet-stream" }));
    a.download = `${this.app.doc.name}.omni`; a.click();
    this.set(`exported ${(ct.byteLength / 1024).toFixed(0)} KB ciphertext`);
  }
  /** Push the encrypted project to the sync store: the server learns {hash(id), lamport, length} and ciphertext only. */
  syncUrl = `${location.protocol}//${location.hostname}:8787`;
  lamport = BigInt(Date.now());
  async pushSync(): Promise<void> {
    if (!this.account.session.isUnlocked) { this.set("unlock first"); return; }
    const t0 = performance.now();
    const bytes = await packStory(this.app);
    const ct = await encryptAsset(this.account.session.dataKey, PROJECT_ID, bytes);
    this.lamport = this.lamport + 1n > BigInt(Date.now()) ? this.lamport + 1n : BigInt(Date.now());
    const meta = await Account.syncMetadata(PROJECT_ID, ct.byteLength, this.lamport);
    try {
      const r = await fetch(`${this.syncUrl}/sync/${meta.objectIdHash}`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-lamport": meta.lamport }, body: ct as BodyInit });
      if (r.status === 409) { this.set(`server has a newer copy (lamport ${r.headers.get("x-lamport")}): pull first`); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      this.set(`pushed ${(ct.byteLength / 1024).toFixed(0)} KB ciphertext as ${meta.objectIdHash.slice(0, 10)}… lamport ${meta.lamport} in ${((performance.now() - t0) / 1000).toFixed(2)} s`);
    } catch (e) { this.set(`push failed: ${e instanceof Error ? e.message : String(e)} (is "npm run signaling" running?)`); }
  }
  async pullSync(): Promise<void> {
    if (!this.account.session.isUnlocked) { this.set("unlock first"); return; }
    const meta = await Account.syncMetadata(PROJECT_ID, 0, 0n);
    try {
      const r = await fetch(`${this.syncUrl}/sync/${meta.objectIdHash}`);
      if (r.status === 404) { this.set("nothing on the server for this project"); return; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ct = new Uint8Array(await r.arrayBuffer()); const lamport = r.headers.get("x-lamport") ?? "0";
      const bytes = await decryptAsset(this.account.session.dataKey, ct);
      await unpackStory(this.app, bytes); this.app.cache.index(this.app.doc); this.app.renderer.fitPage(this.app.doc);
      this.lamport = BigInt(lamport);
      this.app.invalidate(); this.app.emit("layers"); this.app.emit("timeline"); this.app.emit("panels"); this.app.emit("doc-loaded"); this.app.emit("story");
      this.set(`pulled ${(ct.byteLength / 1024).toFixed(0)} KB (lamport ${lamport}) and decrypted locally`);
    } catch (e) { this.set(`pull failed: ${e instanceof Error ? e.message : String(e)}`); }
  }
  async forgetDevice(): Promise<void> { await this.account.vault.destroy(); this.account.lock(); this.app.vault.enrolled = false; this.set("vault wiped"); }
}

export function vaultPanel(app: AppState, ctl: VaultController, auto?: { saveNow: () => Promise<void>; restore: () => Promise<void>; discard: () => Promise<void> }): HTMLElement {
  const root = h("div");
  const render = () => {
    const v = app.vault; const a = app.autosave;
    const pw = h("input", { type: "password", placeholder: "password", autocomplete: "off", style: { width: "100%" } }) as HTMLInputElement;
    clear(root).append(h("h3", {}, "Zero-Knowledge Vault"),
      h("p", { class: "dim", style: { fontSize: "12px" } }, "Argon2id (64 MiB, t=3, p=4) → HKDF → K_m wraps a random K_d → AES-GCM-256 on every asset. Keys never leave this device."),
      h("div", { class: "kv" }, h("span", {}, "device"), h("b", {}, v.enrolled ? "enrolled" : "not enrolled"), h("span", {}, "session"), h("b", {}, v.unlocked ? "unlocked (auto-lock 15 min)" : "locked")),
      field("Password", pw),
      h("div", { class: "row", style: { flexWrap: "wrap", margin: "6px 0" } },
        !v.enrolled ? h("button", { onClick: () => void ctl.enrollPassword(pw.value) }, "Enroll") : null,
        v.enrolled && !v.unlocked ? h("button", { onClick: () => void ctl.unlockPassword(pw.value) }, "Unlock") : null,
        h("button", { onClick: () => void ctl.passkey(!v.enrolled) }, v.enrolled ? "Passkey unlock" : "Passkey enroll"),
        v.unlocked ? h("button", { onClick: () => ctl.lock() }, "Lock") : null),
      h("div", { class: "sep" }),
      h("div", { class: "row", style: { flexWrap: "wrap" } },
        h("button", { disabled: !v.unlocked, onClick: () => void ctl.save() }, "Save encrypted (OPFS)"),
        h("button", { disabled: !v.unlocked, onClick: () => void ctl.load() }, "Load"),
        h("button", { disabled: !v.unlocked, onClick: () => void ctl.exportEncrypted() }, "Export .omni"),
        h("button", { disabled: !v.unlocked, title: "PUT ciphertext to the sync store (last writer wins by Lamport stamp)", onClick: () => void ctl.pushSync() }, "Push sync"),
        h("button", { disabled: !v.unlocked, title: "GET the latest ciphertext and decrypt here", onClick: () => void ctl.pullSync() }, "Pull sync"),
        h("button", { onClick: () => { if (confirm("Wipe the local vault and keys?")) void ctl.forgetDevice(); } }, "Forget device")),
      v.message ? h("div", { class: "notice mono", style: { marginTop: "8px", fontSize: "11px" } }, v.message) : null,
      h("div", { class: "sep" }), h("h3", {}, "Autosave & recovery"),
      a.pending ? h("div", { class: "notice", style: { margin: "6px 0", padding: "8px", border: "1px solid #c9a227" } },
        h("div", {}, `Unsaved work found from ${new Date(a.pending.at).toLocaleString()} (${a.pending.kind}).`),
        h("div", { class: "row", style: { marginTop: "6px" } }, h("button", { onClick: () => void auto?.restore() }, "Restore"), h("button", { onClick: () => void auto?.discard() }, "Discard"))) : null,
      h("div", { class: "kv" }, h("span", {}, "state"), h("b", {}, a.dirty ? "unsaved changes" : "clean"), h("span", {}, "last autosave"), h("b", {}, a.lastAt ? `${new Date(a.lastAt).toLocaleTimeString()} (${a.lastKind})` : "none this session")),
      field("Every", h("select", { onChange: (e: Event) => { a.intervalSec = Number((e.target as HTMLSelectElement).value); app.emit("autosave-config"); } }, ...[30, 60, 120, 300, 600].map((n) => h("option", { value: String(n), selected: a.intervalSec === n }, n < 60 ? `${n} s` : `${n / 60} min`)))),
      field("Enabled", h("select", { onChange: (e: Event) => { a.enabled = (e.target as HTMLSelectElement).value === "on"; } }, h("option", { value: "on", selected: a.enabled }, "on"), h("option", { value: "off", selected: !a.enabled }, "off"))),
      field("Plain when locked", h("select", { onChange: (e: Event) => { a.plainWhenLocked = (e.target as HTMLSelectElement).value === "on"; } }, h("option", { value: "on", selected: a.plainWhenLocked }, "on (device-local plaintext)"), h("option", { value: "off", selected: !a.plainWhenLocked }, "off (lose unsaved work)"))),
      h("div", { class: "row", style: { marginTop: "6px" } }, h("button", { onClick: () => void auto?.saveNow() }, "Autosave now")),
      a.message ? h("div", { class: "notice mono", style: { marginTop: "6px", fontSize: "11px" } }, a.message) : null);
  };
  app.on("vault", render); app.on("autosave", render);
  render();
  return root;
}

/**
 * Start-up unlock. Shown over the canvas when this browser already holds a
 * key bundle. Enter unlocks (password), the passkey button is one tap, Skip
 * keeps drawing without the vault. After unlocking, the last encrypted project
 * is loaded automatically so the artist lands on their own page.
 */
export function unlockModal(app: AppState, ctl: VaultController): void {
  const pw = h("input", { type: "password", placeholder: "password", autocomplete: "current-password", style: { width: "100%" } }) as HTMLInputElement;
  const msg = h("div", { class: "notice", style: { display: "none" } });
  const backdrop = h("div", { class: "modal-backdrop" });
  const close = () => backdrop.remove();
  const finish = async () => {
    if (!app.vault.unlocked) { msg.style.display = "block"; msg.textContent = app.vault.message; pw.select(); return; }
    try { await ctl.load(); } catch { /* no project yet */ }
    close();
  };
  const unlock = async () => { if (!pw.value) return; await ctl.unlockPassword(pw.value); await finish(); };
  pw.addEventListener("keydown", (e) => { if (e.key === "Enter") void unlock(); });
  backdrop.append(h("div", { class: "modal" },
    h("h2", {}, "Unlock your studio"),
    h("p", { class: "dim", style: { margin: 0, fontSize: "12px" } }, "Keys stay on this device. Argon2id runs locally; nothing is sent."),
    pw, msg,
    h("div", { class: "row" },
      h("button", { class: "active", onClick: () => void unlock() }, "Unlock"),
      h("button", { onClick: async () => { await ctl.passkey(false); await finish(); } }, "Use passkey"),
      h("span", { class: "grow" }),
      h("button", { onClick: close }, "Skip, draw without vault"))));
  document.body.append(backdrop);
  setTimeout(() => pw.focus(), 50);
}
