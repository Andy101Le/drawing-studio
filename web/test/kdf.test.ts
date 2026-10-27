import { describe, expect, it } from "vitest";
import { ARGON2_PARAMS, deriveKeysFromSeed, stretchPassword } from "../src/crypto/kdf.js";
import { toHex } from "../src/crypto/bytes.js";

describe("Argon2id KDF", () => {
  const salt = new Uint8Array(16).map((_, i) => i);

  it("is deterministic and 32 bytes", async () => {
    const a = await stretchPassword("correct horse battery staple", salt);
    const b = await stretchPassword("correct horse battery staple", salt);
    expect(a.byteLength).toBe(ARGON2_PARAMS.hashLength);
    expect(toHex(a)).toBe(toHex(b));
  }, 60_000);

  it("changes with password, salt, and NFKC normalization", async () => {
    const a = await stretchPassword("pässword", salt);
    const b = await stretchPassword("pässword", salt); // combining diaeresis, NFKC-equal
    const c = await stretchPassword("password", salt);
    const d = await stretchPassword("pässword", new Uint8Array(16).fill(9));
    expect(toHex(a)).toBe(toHex(b));
    expect(toHex(a)).not.toBe(toHex(c));
    expect(toHex(a)).not.toBe(toHex(d));
  }, 60_000);

  it("derives distinct K_m and K_auth and wipes the seed", async () => {
    const seed = await stretchPassword("x", salt);
    const keys = await deriveKeysFromSeed(seed);
    expect(seed.every((b) => b === 0)).toBe(true);
    expect(keys.authKey.byteLength).toBe(32);
    expect(keys.masterKey.extractable).toBe(false);
    expect(keys.masterKey.usages).toEqual(["wrapKey", "unwrapKey"]);
  }, 60_000);
});
