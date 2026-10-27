/**
 * Looks. All three share the same token names (design/obsidian.css); a theme only changes
 * the values, so every panel inherits it. Persisted in localStorage (omni.theme).
 *   obsidian  the spec's Dark Studio Obsidian, polished: L*6 canvas surround, 1 px silver frames
 *   noir      deeper black with a champagne-gold accent and glass panels (departs from the silver rule)
 *   gallery   light warm-white workspace with graphite type and silver lines
 */
export const THEMES: Array<{ id: string; label: string; surface: string }> = [
  { id: "obsidian", label: "Studio Obsidian", surface: "#0f0f0f" },
  { id: "noir", label: "Noir Champagne", surface: "#070708" },
  { id: "gallery", label: "Gallery Light", surface: "#d9d6d0" },
];
export function currentTheme(): string { try { return localStorage.getItem("omni.theme") ?? "obsidian"; } catch { return "obsidian"; } }
export function applyTheme(id: string): void {
  if (!THEMES.some((t) => t.id === id)) id = "obsidian";
  document.documentElement.dataset["theme"] = id;
  try { localStorage.setItem("omni.theme", id); } catch { /* private mode */ }
}
