import { describe, expect, it } from "vitest";
import { HEADER_LENGTH, decryptAsset, decryptStream, encryptAsset, encryptStream } from "../src/crypto/aead.js";
import { generateDataKey } from "../src/crypto/keyring.js";

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.byteLength; }
  return out;
}

describe("AES-GCM chunked assets", () => {
  const objectId = new Uint8Array(16).map((_, i) => 0x10 + i);

  it("round-trips sizes around chunk boundaries including empty", async () => {
    const key = await generateDataKey();
    for (const size of [0, 1, 1023, 1024, 1025, 3000]) {
      const pt = crypto.getRandomValues(new Uint8Array(size));
      const ct = await encryptAsset(key, objectId, pt, 1024);
      const chunks = Math.max(1, Math.ceil(size / 1024));
      expect(ct.byteLength).toBe(HEADER_LENGTH + size + 16 * chunks);
      expect(await decryptAsset(key, ct)).toEqual(pt);
    }
  });

  it("detects tampering in header, body, tag, truncation, and reordering", async () => {
    const key = await generateDataKey();
    const pt = crypto.getRandomValues(new Uint8Array(2048));
    const ct = await encryptAsset(key, objectId, pt, 1024);
    const flip = (i: number) => { const c = ct.slice(); c[i] = (c[i] as number) ^ 1; return c; };
    await expect(decryptAsset(key, flip(20))).rejects.toThrow();              // objectId in header
    await expect(decryptAsset(key, flip(HEADER_LENGTH + 5))).rejects.toThrow();  // chunk 0 body
    await expect(decryptAsset(key, flip(ct.byteLength - 1))).rejects.toThrow();  // last tag
    await expect(decryptAsset(key, ct.slice(0, ct.byteLength - 1040))).rejects.toThrow(); // truncated
    const swapped = ct.slice();
    swapped.set(ct.subarray(HEADER_LENGTH + 1040, HEADER_LENGTH + 2080), HEADER_LENGTH);
    swapped.set(ct.subarray(HEADER_LENGTH, HEADER_LENGTH + 1040), HEADER_LENGTH + 1040);
    await expect(decryptAsset(key, swapped)).rejects.toThrow();
  });

  it("streams match the one-shot format with arbitrary input chunking", async () => {
    const key = await generateDataKey();
    const pt = crypto.getRandomValues(new Uint8Array(5000));
    const src = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < pt.byteLength; i += 777) c.enqueue(pt.subarray(i, Math.min(i + 777, pt.byteLength))); c.close(); },
    });
    const ct = await collect(src.pipeThrough(encryptStream(key, objectId, BigInt(pt.byteLength), 1024)));
    expect(await decryptAsset(key, ct)).toEqual(pt);
    const back = new ReadableStream<Uint8Array>({
      start(c) { for (let i = 0; i < ct.byteLength; i += 333) c.enqueue(ct.subarray(i, Math.min(i + 333, ct.byteLength))); c.close(); },
    });
    expect(await collect(back.pipeThrough(decryptStream(key)))).toEqual(pt);
  });
});
