/**
 * Phase 2.1: client-side password stretching and master key derivation.
 *
 * Password ──Argon2id(m=65536 KiB, t=3, p=4)──▶ 32-byte seed
 *          seed ──HKDF-SHA256(info="km")──▶ K_m   (never leaves the client)
 *          seed ──HKDF-SHA256(info="auth")─▶ K_auth (sent to server as login proof)
 *
 * Why HKDF after Argon2id: domain separation. The server receives K_auth to
 * authenticate the user and can never recover K_m from it, so a server breach
 * yields neither password nor master key.
 *
 * Argon2id implementation: hash-wasm (the reference C implementation compiled
 * to WebAssembly). Hand-rolling Argon2 is a security anti-pattern; the C++ core
 * can later link libargon2 directly through Emscripten with the same parameters
 * and the vectors in test/kdf.test.ts guarantee both produce identical output.
 */

import { argon2id } from "hash-wasm";
import { bs, randomBytes, utf8, wipe } from "./bytes.js";

export const ARGON2_PARAMS = {
  memoryKiB: 65_536, // m = 64 MiB
  iterations: 3, // t
  parallelism: 4, // p
  hashLength: 32, // 256-bit seed
  saltLength: 16,
} as const;

export const KDF_VERSION = 1;

/** Argon2id salt. Not secret: stored next to the wrapped K_d bundle. */
export function generateKdfSalt(): Uint8Array {
  return randomBytes(ARGON2_PARAMS.saltLength);
}

/**
 * Runs Argon2id over the password. Caller owns the returned seed and must
 * call wipe() on it after deriving keys.
 */
export async function stretchPassword(password: string, salt: Uint8Array): Promise<Uint8Array> {
  if (salt.byteLength !== ARGON2_PARAMS.saltLength) {
    throw new RangeError(`salt must be ${ARGON2_PARAMS.saltLength} bytes`);
  }
  if (password.length === 0) throw new RangeError("password must not be empty");
  const normalized = password.normalize("NFKC");
  const seed = await argon2id({
    password: normalized,
    salt,
    parallelism: ARGON2_PARAMS.parallelism,
    iterations: ARGON2_PARAMS.iterations,
    memorySize: ARGON2_PARAMS.memoryKiB,
    hashLength: ARGON2_PARAMS.hashLength,
    outputType: "binary",
  });
  return seed;
}

export interface DerivedKeys {
  /** Master key K_m, non-extractable, AES-GCM wrap/unwrap only. */
  masterKey: CryptoKey;
  /** Login proof sent to the server. 32 raw bytes. */
  authKey: Uint8Array;
}

async function hkdfExpand(seed: Uint8Array, info: string, bits: number): Promise<ArrayBuffer> {
  const ikm = await crypto.subtle.importKey("raw", bs(seed), "HKDF", false, ["deriveBits"]);
  return crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: bs(utf8(info)) },
    ikm,
    bits,
  );
}

/**
 * Derives K_m (as a non-extractable CryptoKey) and K_auth from the Argon2id
 * seed. The seed is wiped before returning.
 */
export async function deriveKeysFromSeed(seed: Uint8Array): Promise<DerivedKeys> {
  try {
    const kmRaw = new Uint8Array(await hkdfExpand(seed, `omni-cell/v${KDF_VERSION}/km`, 256));
    const authRaw = new Uint8Array(await hkdfExpand(seed, `omni-cell/v${KDF_VERSION}/auth`, 256));
    const masterKey = await crypto.subtle.importKey("raw", bs(kmRaw), { name: "AES-GCM" }, false, [
      "wrapKey",
      "unwrapKey",
    ]);
    wipe(kmRaw);
    return { masterKey, authKey: authRaw };
  } finally {
    wipe(seed);
  }
}

/** One-call convenience used by the password fallback login path. */
export async function deriveKeysFromPassword(password: string, salt: Uint8Array): Promise<DerivedKeys> {
  const seed = await stretchPassword(password, salt);
  return deriveKeysFromSeed(seed);
}

/**
 * WebAuthn PRF path: the authenticator returns 32 bytes bound to the passkey.
 * Those bytes are the seed; no Argon2id needed because a hardware-backed secret
 * already has full entropy.
 */
export async function deriveKeysFromPrfOutput(prf: Uint8Array): Promise<DerivedKeys> {
  if (prf.byteLength !== 32) throw new RangeError("PRF output must be 32 bytes");
  return deriveKeysFromSeed(new Uint8Array(prf));
}
