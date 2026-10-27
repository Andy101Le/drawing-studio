/**
 * Bridge to the Tauri shell when the UI runs inside it (desktop/src-tauri). In a plain
 * browser every call reports `available: false` and the UI keeps its web paths (OPFS,
 * download links). No Tauri npm package is required: the shell injects `window.__TAURI__`.
 */
interface TauriCore { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> }
interface TauriEvent { listen(name: string, cb: (e: { payload: unknown }) => void): Promise<() => void> }
interface TauriDialog { open(opts: Record<string, unknown>): Promise<string | string[] | null>; save(opts: Record<string, unknown>): Promise<string | null> }
interface TauriGlobal { core: TauriCore; event: TauriEvent; dialog?: TauriDialog }

const T = (): TauriGlobal | null => (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;

export const native = {
  get available(): boolean { return T() !== null; },
  async hostInfo(): Promise<{ os: string; arch: string; tauri: string; cpu_threads: number } | null> { const t = T(); return t ? t.core.invoke("host_info") : null; },
  async readProject(path: string): Promise<Uint8Array> { const t = T(); if (!t) throw new Error("not in the desktop shell"); return new Uint8Array(await t.core.invoke<number[]>("read_project", { path })); },
  async writeProject(path: string, bytes: Uint8Array): Promise<{ path: string; bytes: number; sha256: string }> { const t = T(); if (!t) throw new Error("not in the desktop shell"); return t.core.invoke("write_project", { path, bytes: Array.from(bytes) }); },
  async pendingOpenFiles(): Promise<string[]> { const t = T(); return t ? t.core.invoke<string[]>("pending_open_files") : []; },
  async onOpenFile(cb: (paths: string[]) => void): Promise<void> { const t = T(); if (!t) return; await t.event.listen("open-file", (e) => cb(e.payload as string[])); },
  async pickOpen(): Promise<string | null> { const t = T(); if (!t?.dialog) return null; const r = await t.dialog.open({ multiple: false, filters: [{ name: "OMNI-CELL project", extensions: ["omni"] }] }); return typeof r === "string" ? r : null; },
  async pickSave(defaultName: string): Promise<string | null> { const t = T(); if (!t?.dialog) return null; return t.dialog.save({ defaultPath: defaultName, filters: [{ name: "OMNI-CELL project", extensions: ["omni"] }] }); },
};
