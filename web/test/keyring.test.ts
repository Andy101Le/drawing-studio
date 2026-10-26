import { describe, expect, it } from "vitest";
import { deriveKeysFromSeed } from "../src/crypto/kdf.js";
import { KdfKind, decodeBundle, encodeBundle, generateDataKey, unwrapDataKey, wrapDataKey, KeySession } from "../src/crypto/keyring.js";
import { encryptAsset, decryptAsset } from "../src/crypto/aead.js";

describe("keyring", () => {
  it("wraps, encodes, decodes, unwraps K_d and the result decrypts assets", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const { masterKey } = await deriveKeysFromSeed(new Uint8Array(seed));
    const kd = await generateDataKey();
    const bundle = await wrapDataKey(kd, masterKey, KdfKind.PasswordArgon2id, new Uint8Array(16).fill(7));
    const bytes = encodeBundle(bundle);
    expect(bytes.byteLength).toBe(4 + 16 + 12 + 48);
    const back = decodeBundle(bytes);
    const kd2 = await unwrapDataKey(back, masterKey);
    const objectId = new Uint8Array(16).fill(1);
    const ct = await encryptAsset(kd, objectId, new TextEncoder().encode("hello"));
    const pt = await decryptAsset(kd2, ct);
    expect(new TextDecoder().decode(pt)).toBe("hello");
  });

  it("rejects unwrapping with the wrong K_m", async () => {
    const { masterKey: a } = await deriveKeysFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const { masterKey: b } = await deriveKeysFromSeed(crypto.getRandomValues(new Uint8Array(32)));
    const bundle = await wrapDataKey(await generateDataKey(), a, KdfKind.PasswordArgon2id, new Uint8Array(16));
    await expect(unwrapDataKey(bundle, b)).rejects.toThrow();
  });

  it("session auto-locks", async () => {
    const s = new KeySession(20);
    s.unlock(await generateDataKey());
    expect(s.isUnlocked).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(s.isUnlocked).toBe(false);
    expect(() => s.dataKey).toThrow();
  });
});
