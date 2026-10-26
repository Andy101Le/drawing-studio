/**
 * Phase 2.1: asset encryption with AES-GCM-256, chunked for multi-gigabyte files.
 *
 * Why chunked: WebCrypto encrypt() is one-shot and must hold the whole plaintext
 * and ciphertext in RAM. A 2 GB manga file would need 4 GB. Chunking at 1 MiB
 * bounds memory and lets delta sync re-upload only changed chunks.
 *
 * Nonce construction (96 bits): 4-byte random file prefix || 8-byte chunk index.
 * Never reused for a given K_d as long as prefixes don't collide; with a 32-bit
 * prefix, 2^16 files gives a ~0.05% birthday collision chance, so every chunk's
 * AAD also binds the objectId, which makes a cross-file nonce reuse detectable
 * rather than exploitable for forgery of the other file's AAD.
 *
 * AAD per chunk binds: header bytes || chunkIndex (u64) || isFinal (u8).
 * This defeats chunk reordering, chunk substitution across files, and
 * truncation (the final chunk carries isFinal = 1).
 *
 * File layout:
 *   header (40 bytes, plaintext, authenticated through AAD):
 *     "OMNI"  (4)  magic
 *     u8      version = 1
 *     u8      cipher  = 1 (AES-256-GCM)
 *     u16     reserved = 0
 *     u32 BE  chunkSize
 *     [16]    objectId
 *     [4]     noncePrefix
 *     u64 BE  plaintextLength
 *   chunks: each is chunkSize plaintext bytes (last may be shorter) + 16-byte tag
 */

import { bs, concatBytes, readU32be, utf8 } from "./bytes.js";

export const ASSET_MAGIC = utf8("OMNI");
export const ASSET_VERSION = 1;
export const CIPHER_AES256GCM = 1;
export const HEADER_LENGTH = 40;
export const GCM_TAG_BYTES = 16;
export const DEFAULT_CHUNK_SIZE = 1 << 20; // 1 MiB

export interface AssetHeader {
  version: number;
  cipher: number;
  chunkSize: number;
  objectId: Uint8Array; // 16 bytes
  noncePrefix: Uint8Array; // 4 bytes
  plaintextLength: bigint;
}

export function encodeHeader(h: AssetHeader): Uint8Array {
  if (h.objectId.byteLength !== 16) throw new RangeError("objectId must be 16 bytes");
  if (h.noncePrefix.byteLength !== 4) throw new RangeError("noncePrefix must be 4 bytes");
  const out = new Uint8Array(HEADER_LENGTH);
  const dv = new DataView(out.buffer);
  out.set(ASSET_MAGIC, 0);
  out[4] = h.version;
  out[5] = h.cipher;
  dv.setUint16(6, 0, false);
  dv.setUint32(8, h.chunkSize, false);
  out.set(h.objectId, 12);
  out.set(h.noncePrefix, 28);
  dv.setBigUint64(32, h.plaintextLength, false);
  return out;
}

export function decodeHeader(bytes: Uint8Array): AssetHeader {
  if (bytes.byteLength < HEADER_LENGTH) throw new RangeError("header too short");
  for (let i = 0; i < 4; i++) {
    if (bytes[i] !== ASSET_MAGIC[i]) throw new RangeError("bad magic");
  }
  const version = bytes[4] as number;
  const cipher = bytes[5] as number;
  if (version !== ASSET_VERSION) throw new RangeError(`unsupported asset version ${version}`);
  if (cipher !== CIPHER_AES256GCM) throw new RangeError(`unsupported cipher ${cipher}`);
  const chunkSize = readU32be(bytes, 8);
  if (chunkSize === 0 || chunkSize > 64 * 1024 * 1024) throw new RangeError("chunkSize out of range");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    version,
    cipher,
    chunkSize,
    objectId: bytes.slice(12, 28),
    noncePrefix: bytes.slice(28, 32),
    plaintextLength: dv.getBigUint64(32, false),
  };
}

function chunkNonce(prefix: Uint8Array, index: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setBigUint64(4, index, false);
  return nonce;
}

function chunkAad(headerBytes: Uint8Array, index: bigint, isFinal: boolean): Uint8Array {
  const tail = new Uint8Array(9);
  new DataView(tail.buffer).setBigUint64(0, index, false);
  tail[8] = isFinal ? 1 : 0;
  return concatBytes(headerBytes, tail);
}

export function chunkCount(h: AssetHeader): bigint {
  if (h.plaintextLength === 0n) return 1n; // empty file still has one authenticated final chunk
  return (h.plaintextLength + BigInt(h.chunkSize) - 1n) / BigInt(h.chunkSize);
}

export class AssetEncryptor {
  readonly header: AssetHeader;
  readonly headerBytes: Uint8Array;
  readonly #key: CryptoKey;
  readonly #count: bigint;
  #next = 0n;

  constructor(key: CryptoKey, objectId: Uint8Array, plaintextLength: bigint, chunkSize = DEFAULT_CHUNK_SIZE) {
    const noncePrefix = new Uint8Array(4);
    crypto.getRandomValues(noncePrefix);
    this.header = {
      version: ASSET_VERSION,
      cipher: CIPHER_AES256GCM,
      chunkSize,
      objectId,
      noncePrefix,
      plaintextLength,
    };
    this.headerBytes = encodeHeader(this.header);
    this.#key = key;
    this.#count = chunkCount(this.header);
  }

  get remainingChunks(): bigint {
    return this.#count - this.#next;
  }

  /** Encrypts the next chunk. Plaintext must be exactly chunkSize except for the final chunk. */
  async encryptChunk(plaintext: Uint8Array): Promise<Uint8Array> {
    if (this.#next >= this.#count) throw new RangeError("all chunks already encrypted");
    const index = this.#next;
    const isFinal = index === this.#count - 1n;
    const expected = isFinal
      ? Number(this.header.plaintextLength - index * BigInt(this.header.chunkSize))
      : this.header.chunkSize;
    if (plaintext.byteLength !== expected) {
      throw new RangeError(`chunk ${index} must be ${expected} bytes, got ${plaintext.byteLength}`);
    }
    const ct = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: bs(chunkNonce(this.header.noncePrefix, index)),
        additionalData: bs(chunkAad(this.headerBytes, index, isFinal)),
        tagLength: 128,
      },
      this.#key,
      bs(plaintext),
    );
    this.#next = index + 1n;
    return new Uint8Array(ct);
  }
}

export class AssetDecryptor {
  readonly header: AssetHeader;
  readonly headerBytes: Uint8Array;
  readonly #key: CryptoKey;
  readonly #count: bigint;
  #next = 0n;

  constructor(key: CryptoKey, headerBytes: Uint8Array) {
    this.headerBytes = headerBytes.slice(0, HEADER_LENGTH);
    this.header = decodeHeader(this.headerBytes);
    this.#key = key;
    this.#count = chunkCount(this.header);
  }

  get remainingChunks(): bigint {
    return this.#count - this.#next;
  }

  /** Byte length of ciphertext chunk `index` (plaintext part + tag). */
  ciphertextChunkLength(index: bigint): number {
    const isFinal = index === this.#count - 1n;
    const pt = isFinal
      ? Number(this.header.plaintextLength - index * BigInt(this.header.chunkSize))
      : this.header.chunkSize;
    return pt + GCM_TAG_BYTES;
  }

  /** Decrypts chunks strictly in order. Throws on any tampering, reorder, or truncation. */
  async decryptChunk(ciphertext: Uint8Array): Promise<Uint8Array> {
    if (this.#next >= this.#count) throw new RangeError("all chunks already decrypted");
    const index = this.#next;
    const isFinal = index === this.#count - 1n;
    if (ciphertext.byteLength !== this.ciphertextChunkLength(index)) {
      throw new RangeError(`chunk ${index} has wrong ciphertext length`);
    }
    const pt = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bs(chunkNonce(this.header.noncePrefix, index)),
        additionalData: bs(chunkAad(this.headerBytes, index, isFinal)),
        tagLength: 128,
      },
      this.#key,
      bs(ciphertext),
    );
    this.#next = index + 1n;
    return new Uint8Array(pt);
  }
}

/** One-shot helpers for small assets (brush presets, timelines, project manifest). */
export async function encryptAsset(
  key: CryptoKey,
  objectId: Uint8Array,
  plaintext: Uint8Array,
  chunkSize = DEFAULT_CHUNK_SIZE,
): Promise<Uint8Array> {
  const enc = new AssetEncryptor(key, objectId, BigInt(plaintext.byteLength), chunkSize);
  const parts: Uint8Array[] = [enc.headerBytes];
  let offset = 0;
  while (enc.remainingChunks > 0n) {
    const end = Math.min(offset + chunkSize, plaintext.byteLength);
    parts.push(await enc.encryptChunk(plaintext.subarray(offset, end)));
    offset = end;
  }
  return concatBytes(...parts);
}

export async function decryptAsset(key: CryptoKey, file: Uint8Array): Promise<Uint8Array> {
  const dec = new AssetDecryptor(key, file);
  const parts: Uint8Array[] = [];
  let offset = HEADER_LENGTH;
  let index = 0n;
  while (dec.remainingChunks > 0n) {
    const len = dec.ciphertextChunkLength(index);
    if (offset + len > file.byteLength) throw new RangeError("file truncated");
    parts.push(await dec.decryptChunk(file.subarray(offset, offset + len)));
    offset += len;
    index += 1n;
  }
  if (offset !== file.byteLength) throw new RangeError("trailing bytes after final chunk");
  return concatBytes(...parts);
}

/**
 * Streaming transform: plaintext bytes in, [header, chunk0, chunk1, ...] out.
 * Total plaintext length must be known up front (it's authenticated in the header).
 */
export function encryptStream(
  key: CryptoKey,
  objectId: Uint8Array,
  plaintextLength: bigint,
  chunkSize = DEFAULT_CHUNK_SIZE,
): TransformStream<Uint8Array, Uint8Array> {
  const enc = new AssetEncryptor(key, objectId, plaintextLength, chunkSize);
  let pending: Uint8Array = new Uint8Array(0);
  return new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(enc.headerBytes);
    },
    async transform(input, controller) {
      pending = concatBytes(pending, input);
      while (pending.byteLength >= chunkSize && enc.remainingChunks > 1n) {
        controller.enqueue(await enc.encryptChunk(pending.slice(0, chunkSize)));
        pending = pending.slice(chunkSize);
      }
    },
    async flush(controller) {
      if (enc.remainingChunks !== 1n) throw new RangeError("plaintext shorter than declared length");
      controller.enqueue(await enc.encryptChunk(pending));
    },
  });
}

export function decryptStream(key: CryptoKey): TransformStream<Uint8Array, Uint8Array> {
  let dec: AssetDecryptor | null = null;
  let pending: Uint8Array = new Uint8Array(0);
  let index = 0n;
  return new TransformStream<Uint8Array, Uint8Array>({
    async transform(input, controller) {
      pending = concatBytes(pending, input);
      if (!dec) {
        if (pending.byteLength < HEADER_LENGTH) return;
        dec = new AssetDecryptor(key, pending);
        pending = pending.slice(HEADER_LENGTH);
      }
      while (dec.remainingChunks > 0n) {
        const len = dec.ciphertextChunkLength(index);
        if (pending.byteLength < len) break;
        controller.enqueue(await dec.decryptChunk(pending.slice(0, len)));
        pending = pending.slice(len);
        index += 1n;
      }
    },
    flush() {
      if (!dec || dec.remainingChunks !== 0n) throw new RangeError("ciphertext stream truncated");
      if (pending.byteLength !== 0) throw new RangeError("trailing bytes after final chunk");
    },
  });
}
