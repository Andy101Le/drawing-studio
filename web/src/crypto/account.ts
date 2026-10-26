/**
 * Phase 2.1 orchestration: enrollment, unlock, lock, and sync-safe metadata.
 *
 * Enrollment (password path):
 *   1. salt = random(16)
 *   2. seed = Argon2id(password, salt)
 *   3. K_m, K_auth = HKDF(seed)
 *   4. K_d = random AES-256-GCM key
 *   5. bundle = wrap(K_d under K_m)  ──▶ OPFS keyring/bundle.bin and server
 *   6. send server: { userId, K_auth, bundle }   (server stores K_auth hashed)
 *
 * Unlock:
 *   1. bundle ← OPFS (or server on a new device)
 *   2. seed from password+bundle.kdfSalt, or from passkey PRF
 *   3. K_m = HKDF(seed); K_d = unwrap(bundle, K_m); session.unlock(K_d)
 *
 * Server-visible metadata for sync (Phase 2 compliance clause):
 *   objectIdHash = SHA-256(objectId)  (opaque, not reversible without the id)
 *   lamportTimestamp (u64)
 *   ciphertextLength
 * Nothing else. The sync server schema is in docs/ARCHITECTURE.md.
 */

import { encryptAsset, decryptAsset } from "./aead.js";
import { bs, randomBytes, toHex, wipe } from "./bytes.js";
import { deriveKeysFromPassword, deriveKeysFromPrfOutput, generateKdfSalt } from "./kdf.js";
import {
  KdfKind,
  KeySession,
  WRAP_AAD,
  decodeBundle,
  encodeBundle,
  generateDataKey,
  unwrapDataKey,
  wrapDataKey,
  type WrappedKeyBundle,
} from "./keyring.js";
import { KEYRING_PATH, OpfsVault, assetPath } from "./opfs.js";

export interface EnrollmentResult {
  /** Send to the server. Server must hash it (e.g. Argon2id again or HMAC) before storing. */
  authKey: Uint8Array;
  /** Also sent to the server so a second device can unlock. */
  bundle: Uint8Array;
}

export class Account {
  readonly session: KeySession;
  readonly vault: OpfsVault;

  constructor(vault = new OpfsVault(), session = new KeySession()) {
    this.vault = vault;
    this.session = session;
  }

  async enrollWithPassword(password: string): Promise<EnrollmentResult> {
    const salt = generateKdfSalt();
    const { masterKey, authKey } = await deriveKeysFromPassword(password, salt);
    const dataKey = await generateDataKey();
    const bundle = await wrapDataKey(dataKey, masterKey, KdfKind.PasswordArgon2id, salt);
    const encoded = encodeBundle(bundle);
    await this.vault.writeFile(KEYRING_PATH, encoded);
    const nonExtractable = await unwrapDataKey(bundle, masterKey);
    this.session.unlock(nonExtractable);
    return { authKey, bundle: encoded };
  }

  async enrollWithPasskey(prfOutput: Uint8Array): Promise<EnrollmentResult> {
    const { masterKey, authKey } = await deriveKeysFromPrfOutput(prfOutput);
    const dataKey = await generateDataKey();
    const bundle = await wrapDataKey(dataKey, masterKey, KdfKind.WebAuthnPrf, new Uint8Array(16));
    const encoded = encodeBundle(bundle);
    await this.vault.writeFile(KEYRING_PATH, encoded);
    this.session.unlock(await unwrapDataKey(bundle, masterKey));
    return { authKey, bundle: encoded };
  }

  /** Imports a bundle fetched from the server onto a new device. */
  async importBundle(encoded: Uint8Array): Promise<void> {
    decodeBundle(encoded); // validate before persisting
    await this.vault.writeFile(KEYRING_PATH, encoded);
  }

  async #loadBundle(): Promise<WrappedKeyBundle> {
    return decodeBundle(await this.vault.readFile(KEYRING_PATH));
  }

  /** Returns K_auth for the login request. Throws OperationError on wrong password. */
  async unlockWithPassword(password: string): Promise<Uint8Array> {
    const bundle = await this.#loadBundle();
    if (bundle.kdfKind !== KdfKind.PasswordArgon2id) throw new Error("this device is enrolled with a passkey");
    const { masterKey, authKey } = await deriveKeysFromPassword(password, bundle.kdfSalt);
    this.session.unlock(await unwrapDataKey(bundle, masterKey));
    return authKey;
  }

  async unlockWithPasskey(prfOutput: Uint8Array): Promise<Uint8Array> {
    const bundle = await this.#loadBundle();
    if (bundle.kdfKind !== KdfKind.WebAuthnPrf) throw new Error("this device is enrolled with a password");
    const { masterKey, authKey } = await deriveKeysFromPrfOutput(prfOutput);
    this.session.unlock(await unwrapDataKey(bundle, masterKey));
    return authKey;
  }

  /**
   * Password rotation: re-wraps the same K_d under a new K_m. Assets are not
   * re-encrypted. Old password is required so a hijacked session can't rotate.
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<EnrollmentResult> {
    const bundle = await this.#loadBundle();
    const old = await deriveKeysFromPassword(oldPassword, bundle.kdfSalt);
    wipe(old.authKey);
    // Unwrap extractable only inside this scope so wrapKey can read it.
    const extractable = await crypto.subtle.unwrapKey(
      "raw",
      bs(bundle.wrappedKd),
      old.masterKey,
      { name: "AES-GCM", iv: bs(bundle.wrapIv), additionalData: bs(WRAP_AAD), tagLength: 128 },
      { name: "AES-GCM", length: 256 },
      true,
      ["encrypt", "decrypt"],
    );
    const salt = generateKdfSalt();
    const fresh = await deriveKeysFromPassword(newPassword, salt);
    const rewrapped = await wrapDataKey(extractable, fresh.masterKey, KdfKind.PasswordArgon2id, salt);
    const encoded = encodeBundle(rewrapped);
    await this.vault.writeFile(KEYRING_PATH, encoded);
    this.session.unlock(await unwrapDataKey(rewrapped, fresh.masterKey));
    return { authKey: fresh.authKey, bundle: encoded };
  }

  lock(): void {
    this.session.lock();
  }

  /** Encrypts and stores a small asset. Returns the 16-byte objectId. */
  async putAsset(plaintext: Uint8Array, objectId = randomBytes(16)): Promise<Uint8Array> {
    const file = await encryptAsset(this.session.dataKey, objectId, plaintext);
    await this.vault.writeFile(assetPath(toHex(objectId)), file);
    return objectId;
  }

  async getAsset(objectId: Uint8Array): Promise<Uint8Array> {
    const file = await this.vault.readFile(assetPath(toHex(objectId)));
    return decryptAsset(this.session.dataKey, file);
  }

  /** What the sync server is allowed to learn about one asset. */
  static async syncMetadata(objectId: Uint8Array, ciphertextLength: number, lamport: bigint) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bs(objectId)));
    return { objectIdHash: toHex(digest), lamport: lamport.toString(), ciphertextLength };
  }
}
