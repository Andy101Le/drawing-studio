/**
 * Customisable shortcuts. A binding is "mod+key" with mods in {ctrl, shift, alt}; the
 * table is persisted in localStorage (omni.keymap) and edited in the Settings tab.
 * Selection shortcuts (M/W/T, Ctrl+A/D...) and Enter/Escape stay in select-tools.ts.
 */
export type Action = "tool.brush" | "tool.eraser" | "tool.pan" | "tool.rotate" | "tool.panel-cut" | "tool.eyedrop" | "tool.fill" | "tool.vector" | "tool.node" | "tool.text" | "tool.ruler" | "tool.gradient" | "edit.transform"
  | "edit.undo" | "edit.redo" | "edit.redo2" | "layer.clip" | "brush.smaller" | "brush.larger" | "anim.onion" | "anim.prev" | "anim.next" | "view.fit" | "mode.toggle";

export const ACTION_LABELS: Record<Action, string> = {
  "tool.brush": "Brush", "tool.eraser": "Eraser", "tool.pan": "Pan", "tool.rotate": "Rotate view", "tool.panel-cut": "Panel cut", "tool.eyedrop": "Eyedropper", "tool.fill": "Fill",
  "tool.vector": "Vector pen", "tool.node": "Node edit", "tool.text": "Text & balloons", "tool.ruler": "Ruler", "tool.gradient": "Gradient", "edit.transform": "Free transform selection", "edit.undo": "Undo", "edit.redo": "Redo", "edit.redo2": "Redo (alt)",
  "layer.clip": "Clip layer to below", "brush.smaller": "Brush smaller", "brush.larger": "Brush larger", "anim.onion": "Onion skin", "anim.prev": "Previous frame", "anim.next": "Next frame",
  "view.fit": "Fit page", "mode.toggle": "Manga / Anime mode",
};
export const DEFAULT_KEYMAP: Record<Action, string> = {
  "tool.brush": "b", "tool.eraser": "e", "tool.pan": "h", "tool.rotate": "r", "tool.panel-cut": "k", "tool.eyedrop": "i", "tool.fill": "g", "tool.vector": "v", "tool.node": "a", "tool.text": "x", "tool.ruler": "u", "tool.gradient": "d", "edit.transform": "ctrl+t",
  "edit.undo": "ctrl+z", "edit.redo": "ctrl+shift+z", "edit.redo2": "ctrl+y", "layer.clip": "ctrl+alt+g", "brush.smaller": "[", "brush.larger": "]", "anim.onion": "o", "anim.prev": ",", "anim.next": ".", "view.fit": "ctrl+0", "mode.toggle": "tab",
};

export class Keymap {
  map: Record<Action, string> = { ...DEFAULT_KEYMAP };
  constructor() { try { const raw = localStorage.getItem("omni.keymap"); if (raw) Object.assign(this.map, JSON.parse(raw)); } catch { /* private mode */ } }
  save(): void { try { localStorage.setItem("omni.keymap", JSON.stringify(this.map)); } catch { /* private mode */ } }
  reset(): void { this.map = { ...DEFAULT_KEYMAP }; this.save(); }
  static combo(e: KeyboardEvent): string {
    const k = e.key.toLowerCase(); const parts: string[] = [];
    if (e.ctrlKey || e.metaKey) parts.push("ctrl"); if (e.shiftKey && k.length > 1) parts.push("shift"); if (e.altKey) parts.push("alt");
    // letters with shift are reported upper-case: keep "shift" for them too
    if (e.shiftKey && k.length === 1 && /[a-z]/.test(k)) parts.push("shift");
    parts.push(k === " " ? "space" : k); return parts.join("+");
  }
  actionFor(e: KeyboardEvent): Action | null {
    const c = Keymap.combo(e);
    for (const [a, v] of Object.entries(this.map) as Array<[Action, string]>) if (v === c) return a;
    return null;
  }
  conflicts(action: Action, combo: string): Action | null { for (const [a, v] of Object.entries(this.map) as Array<[Action, string]>) if (a !== action && v === combo) return a; return null; }
}
