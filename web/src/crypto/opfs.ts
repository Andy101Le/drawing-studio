/**
 * Phase 2.1: Origin Private File System vault.
 *
 * Two access paths exist in browsers:
 *   1. Main thread: FileSystemFileHandle.createWritable() (async, whole-file).
 *      Used for the key bundle and small assets.
 *   2. Dedicated worker: createSyncAccessHandle() (synchronous, random access).
 *      Used by the tile cache for sub-millisecond reads of 1 MiB chunks.
 *      See opfs-worker.ts; this file hosts the main-thread client for it.
 *
 * Layout inside the origin's OPFS root:
 *   /omni/keyring/bundle.bin             wrapped K_d bundle (keyring.ts)
 *   /omni/assets/<objectIdHex>.omni      encrypted assets (aead.ts)
 *   /omni/cache/<objectIdHex>.tiles      encrypted tile cache (random access)
 *
 * Everything written here is already ciphertext. OPFS is origin-sandboxed but
 * not hardware bound, so the vault never holds K_m or raw K_d.
 */

import { bs } from "./bytes.js";

export const VAULT_ROOT = "omni";

export interface VaultEntry {
  name: string;
  kind: "file" | "directory";
  size?: number;
}

export class OpfsVault {
  #root: FileSystemDirectoryHandle | null = null;

  static isSupported(): boolean {
    return typeof navigator !== "undefined" && !!navigator.storage && "getDirectory" in navigator.storage;
  }

  async #rootDir(): Promise<FileSystemDirectoryHandle> {
    if (this.#root) return this.#root;
    if (!OpfsVault.isSupported()) throw new Error("OPFS not supported in this browser");
    const origin = await navigator.storage.getDirectory();
    this.#root = await origin.getDirectoryHandle(VAULT_ROOT, { create: true });
    return this.#root;
  }

  async #resolve(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = path.split("/").filter((p) => p.length > 0);
    if (parts.length === 0) throw new RangeError("empty path");
    for (const p of parts) {
      if (p === "." || p === ".." || p.includes("\\")) throw new RangeError(`illegal path segment ${p}`);
    }
    let dir = await this.#rootDir();
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i] as string, { create });
    }
    return { dir, name: parts[parts.length - 1] as string };
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.#resolve(path, false);
      await dir.getFileHandle(name);
      return true;
    } catch (e) {
      if (e instanceof DOMException && (e.name === "NotFoundError" || e.name === "TypeMismatchError")) return false;
      throw e;
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const { dir, name } = await this.#resolve(path, false);
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return new Uint8Array(await file.arrayBuffer());
  }

  /** Atomic replace: createWritable() writes to a temp file and swaps on close(). */
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    const { dir, name } = await this.#resolve(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    try {
      await writable.write(bs(bytes));
    } catch (e) {
      await writable.abort();
      throw e;
    }
    await writable.close();
  }

  /** Streaming sink for large assets. Pipe encryptStream() output into this. */
  async openWritable(path: string): Promise<WritableStream<Uint8Array>> {
    const { dir, name } = await this.#resolve(path, true);
    const handle = await dir.getFileHandle(name, { create: true });
    return handle.createWritable({ keepExistingData: false });
  }

  async openReadable(path: string): Promise<ReadableStream<Uint8Array>> {
    const { dir, name } = await this.#resolve(path, false);
    const handle = await dir.getFileHandle(name);
    const file = await handle.getFile();
    return file.stream();
  }

  async deleteFile(path: string): Promise<void> {
    const { dir, name } = await this.#resolve(path, false);
    await dir.removeEntry(name);
  }

  async list(dirPath = ""): Promise<VaultEntry[]> {
    let dir = await this.#rootDir();
    for (const p of dirPath.split("/").filter((s) => s.length > 0)) {
      dir = await dir.getDirectoryHandle(p);
    }
    const out: VaultEntry[] = [];
    for await (const [name, handle] of (dir as unknown as AsyncIterableDirectory).entries()) {
      if (handle.kind === "file") {
        const f = await (handle as FileSystemFileHandle).getFile();
        out.push({ name, kind: "file", size: f.size });
      } else {
        out.push({ name, kind: "directory" });
      }
    }
    return out;
  }

  async estimateQuota(): Promise<{ usage: number; quota: number }> {
    const est = await navigator.storage.estimate();
    return { usage: est.usage ?? 0, quota: est.quota ?? 0 };
  }

  /** Wipes the whole vault. Used on account sign-out with "forget this device". */
  async destroy(): Promise<void> {
    const origin = await navigator.storage.getDirectory();
    await origin.removeEntry(VAULT_ROOT, { recursive: true });
    this.#root = null;
  }
}

/** entries() is in the FS Access spec but missing from older TS lib typings. */
interface AsyncIterableDirectory {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
}

export const KEYRING_PATH = "keyring/bundle.bin";
export function assetPath(objectIdHex: string): string {
  return `assets/${objectIdHex}.omni`;
}
export function tileCachePath(objectIdHex: string): string {
  return `cache/${objectIdHex}.tiles`;
}

/**
 * Main-thread client for the random-access worker (opfs-worker.ts).
 * Reads and writes byte ranges in the tile cache without blocking the UI.
 */
export class TileCacheClient {
  readonly #worker: Worker;
  #nextId = 1;
  readonly #pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
      const msg = ev.data;
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    };
  }

  #call<T>(req: DistributiveOmit<WorkerRequest, "id">, transfer: Transferable[] = []): Promise<T> {
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#worker.postMessage({ ...req, id }, transfer);
    });
  }

  open(path: string): Promise<void> {
    return this.#call({ op: "open", path });
  }
  close(path: string): Promise<void> {
    return this.#call({ op: "close", path });
  }
  size(path: string): Promise<number> {
    return this.#call({ op: "size", path });
  }
  readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    return this.#call({ op: "read", path, offset, length });
  }
  writeRange(path: string, offset: number, data: Uint8Array): Promise<void> {
    const copy = data.slice();
    return this.#call({ op: "write", path, offset, data: copy }, [copy.buffer]);
  }
  truncate(path: string, length: number): Promise<void> {
    return this.#call({ op: "truncate", path, length });
  }
  flush(path: string): Promise<void> {
    return this.#call({ op: "flush", path });
  }
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type WorkerRequest =
  | { id: number; op: "open"; path: string }
  | { id: number; op: "close"; path: string }
  | { id: number; op: "size"; path: string }
  | { id: number; op: "read"; path: string; offset: number; length: number }
  | { id: number; op: "write"; path: string; offset: number; data: Uint8Array }
  | { id: number; op: "truncate"; path: string; length: number }
  | { id: number; op: "flush"; path: string };

export type WorkerResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
