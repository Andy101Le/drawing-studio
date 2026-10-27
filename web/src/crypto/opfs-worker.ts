/**
 * Dedicated worker: synchronous random-access OPFS handles for the tile cache.
 * Load with: new Worker(new URL("./opfs-worker.ts", import.meta.url), { type: "module" })
 *
 * createSyncAccessHandle() is worker-only by spec. One handle per file, exclusive
 * lock, so this worker is the single writer for every .tiles file.
 */

import type { WorkerRequest, WorkerResponse } from "./opfs.js";
import { VAULT_ROOT } from "./opfs.js";

type SyncHandle = FileSystemSyncAccessHandle;

const handles = new Map<string, SyncHandle>();
let rootPromise: Promise<FileSystemDirectoryHandle> | null = null;

function root(): Promise<FileSystemDirectoryHandle> {
  if (!rootPromise) {
    rootPromise = navigator.storage.getDirectory().then((o) => o.getDirectoryHandle(VAULT_ROOT, { create: true }));
  }
  return rootPromise;
}

async function fileHandle(path: string): Promise<FileSystemFileHandle> {
  const parts = path.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) throw new RangeError("empty path");
  for (const p of parts) {
    if (p === "." || p === ".." || p.includes("\\")) throw new RangeError(`illegal path segment ${p}`);
  }
  let dir = await root();
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i] as string, { create: true });
  }
  return dir.getFileHandle(parts[parts.length - 1] as string, { create: true });
}

function getOpen(path: string): SyncHandle {
  const h = handles.get(path);
  if (!h) throw new Error(`not open: ${path}`);
  return h;
}

async function handle(req: WorkerRequest): Promise<unknown> {
  switch (req.op) {
    case "open": {
      if (handles.has(req.path)) return undefined;
      const fh = await fileHandle(req.path);
      handles.set(req.path, await fh.createSyncAccessHandle());
      return undefined;
    }
    case "close": {
      const h = handles.get(req.path);
      if (h) {
        h.flush();
        h.close();
        handles.delete(req.path);
      }
      return undefined;
    }
    case "size":
      return getOpen(req.path).getSize();
    case "read": {
      const h = getOpen(req.path);
      const buf = new Uint8Array(req.length);
      const n = h.read(buf, { at: req.offset });
      if (n !== req.length) throw new RangeError(`short read: wanted ${req.length}, got ${n}`);
      return buf;
    }
    case "write": {
      const h = getOpen(req.path);
      const n = h.write(req.data, { at: req.offset });
      if (n !== req.data.byteLength) throw new RangeError(`short write: wanted ${req.data.byteLength}, got ${n}`);
      return undefined;
    }
    case "truncate":
      getOpen(req.path).truncate(req.length);
      return undefined;
    case "flush":
      getOpen(req.path).flush();
      return undefined;
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const req = ev.data;
  let res: WorkerResponse;
  try {
    const result = await handle(req);
    res = { id: req.id, ok: true, result };
    if (result instanceof Uint8Array) {
      (self as unknown as Worker).postMessage(res, [result.buffer]);
      return;
    }
  } catch (e) {
    res = { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  (self as unknown as Worker).postMessage(res);
};
