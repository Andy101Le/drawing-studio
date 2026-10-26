/**
 * Phase 2.1: K_d lifecycle.
 *
 * K_d (256-bit random) encrypts every asset. It is wrapped under K_m with
 * AES-GCM and the wrapped bundle is what gets persisted (OPFS) and synced.
 * Unwrapped K_d exists only as a non-extractable CryptoKey in RAM for the
 * active session; lock() drops it.
 *
 * Bundle wire format (little binary header, then JSON-free raw bytes):
 *   u8   version        = 1
 *   u8   kdfKind        0 = password/Argon2id, 1 = WebAuthn PRF
 *   u8   saltLen
 *   u8   ivLen
 *   [saltLen]  kdf salt (zeros when kdfKind = 1)
 *   [ivLen]    wrap IV (12 bytes)
 *   [rest]     wrapped K_d (32 bytes ciphertext + 16 byte GCM tag = 48)
 */

import { bs, concatBytes, randomBytes, utf8 } from "./bytes.js";
import { ARGON2_PARAMS } from "./kdf.js";

export const KEYRING_VERSION = 1;
export const WRAP_IV_LENGTH = 12;
export const WRAP_AAD = utf8("omni-cell/keyring/v1");

export enum KdfKind {
  PasswordArgon2id = 0,
  WebAuthnPrf = 1,
}

export interface WrappedKeyBundle {
  version: number;
  kdfKind: KdfKind;
  kdfSalt: Uint8Array;
  wrapIv: Uint8Array;
  wrappedKd: Uint8Array;
}

export async function generateDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function wrapDataKey(
  dataKey: CryptoKey,
  masterKey: CryptoKey,
  kdfKind: KdfKind,
  kdfSalt: Uint8Array,
): Promise<WrappedKeyBundle> {
  const wrapIv = randomBytes(WRAP_IV_LENGTH);
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, masterKey, {
    name: "AES-GCM",
    iv: bs(wrapIv),
    additionalData: bs(WRAP_AAD),
    tagLength: 128,
  });
  return {
    version: KEYRING_VERSION,
    kdfKind,
    kdfSalt,
    wrapIv,
    wrappedKd: new Uint8Array(wrapped),
  };
}

/** Returns a non-extractable K_d. Throws DOMException OperationError on wrong K_m or tampering. */
export async function unwrapDataKey(bundle: WrappedKeyBundle, masterKey: CryptoKey): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    bs(bundle.wrappedKd),
    masterKey,
    { name: "AES-GCM", iv: bs(bundle.wrapIv), additionalData: bs(WRAP_AAD), tagLength: 128 },
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export function encodeBundle(b: WrappedKeyBundle): Uint8Array {
  const header = new Uint8Array([b.version, b.kdfKind, b.kdfSalt.byteLength, b.wrapIv.byteLength]);
  return concatBytes(header, b.kdfSalt, b.wrapIv, b.wrappedKd);
}

export function decodeBundle(bytes: Uint8Array): WrappedKeyBundle {
  if (bytes.byteLength < 4) throw new RangeError("bundle too short");
  const version = bytes[0] as number;
  if (version !== KEYRING_VERSION) throw new RangeError(`unsupported keyring version ${version}`);
  const kdfKind = bytes[1] as number;
  if (kdfKind !== KdfKind.PasswordArgon2id && kdfKind !== KdfKind.WebAuthnPrf) {
    throw new RangeError(`unknown kdfKind ${kdfKind}`);
  }
  const saltLen = bytes[2] as number;
  const ivLen = bytes[3] as number;
  if (saltLen !== ARGON2_PARAMS.saltLength || ivLen !== WRAP_IV_LENGTH) {
    throw new RangeError("bundle header lengths do not match current parameters");
  }
  let off = 4;
  const kdfSalt = bytes.slice(off, off + saltLen);
  off += saltLen;
  const wrapIv = bytes.slice(off, off + ivLen);
  off += ivLen;
  const wrappedKd = bytes.slice(off);
  if (wrappedKd.byteLength !== 48) throw new RangeError("wrapped K_d must be 48 bytes");
  return { version, kdfKind, kdfSalt, wrapIv, wrappedKd };
}

/**
 * Session holder for the unwrapped K_d. Auto-locks after `idleMs` without use.
 */
export class KeySession {
  #dataKey: CryptoKey | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  readonly #idleMs: number;

  constructor(idleMs = 15 * 60 * 1000) {
    this.#idleMs = idleMs;
  }

  unlock(dataKey: CryptoKey): void {
    this.#dataKey = dataKey;
    this.#touch();
  }

  lock(): void {
    this.#dataKey = null;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  get isUnlocked(): boolean {
    return this.#dataKey !== null;
  }

  /** Throws if locked. Every call resets the idle timer. */
  get dataKey(): CryptoKey {
    if (!this.#dataKey) throw new Error("keyring is locked");
    this.#touch();
    return this.#dataKey;
  }

  #touch(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.lock(), this.#idleMs);
  }
}
