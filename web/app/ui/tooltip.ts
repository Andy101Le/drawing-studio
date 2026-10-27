/**
 * Shortcut tooltips. One floating element, delegated hover over the whole app:
 *   - any element with data-action="<keymap action>" shows its label and the CURRENT binding
 *     (so rebinding in Settings updates every tooltip)
 *   - any element with data-keys="Ctrl+A" shows a fixed chord (selection keys, Enter/Esc)
 *   - any element with a title gets the same styled tooltip; the native title is moved to
 *     data-tip so the browser's slow default tooltip does not double up
 * Shows after 220 ms, follows the element (below it, flipped above near the bottom edge),
 * hides on leave, scroll, pointer down, or key press.
 */
import type { AppState } from "./state.js";
import { ACTION_LABELS, type Action } from "./keymap.js";
import { helpFor } from "./help.js";

const pretty = (combo: string): string => combo.split("+").map((k) => k === "ctrl" ? (navigator.platform.startsWith("Mac") ? "⌘" : "Ctrl") : k === "shift" ? "Shift" : k === "alt" ? "Alt" : k.length === 1 ? k.toUpperCase() : k[0]!.toUpperCase() + k.slice(1)).join(" + ");

export function installTooltips(app: AppState): void {
  const tip = document.createElement("div"); tip.id = "tooltip"; tip.style.display = "none"; document.body.append(tip);
  let timer = 0; let current: HTMLElement | null = null;

  const textFor = (el: HTMLElement): { label: string; keys: string | null } | null => {
    if (el.title) { el.dataset["tip"] = el.title; el.removeAttribute("title"); } // one tooltip, not the browser's too
    const action = el.dataset["action"] as Action | undefined;
    if (action && ACTION_LABELS[action]) return { label: el.dataset["tip"] ?? ACTION_LABELS[action], keys: pretty(app.keymap.map[action]) };
    if (el.dataset["keys"]) return { label: el.dataset["tip"] ?? el.textContent?.trim() ?? "", keys: el.dataset["keys"]! };
    if (el.dataset["tip"]) {
      // "Label (B)" written in a title becomes label + chip when it matches a known binding
      const m = el.dataset["tip"].match(/^(.*?)\s*\(([^()]{1,24})\)$/);
      return m ? { label: m[1]!, keys: m[2]! } : { label: el.dataset["tip"], keys: null };
    }
    // a plain button: its text is the name, the help table supplies the description
    const text = el.textContent?.trim() ?? "";
    if (text && text.length <= 40) return { label: text, keys: null };
    return null;
  };
  const place = (el: HTMLElement) => {
    const r = el.getBoundingClientRect(); tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = r.left + r.width / 2 - tw / 2, y = r.bottom + 8;
    if (y + th > window.innerHeight - 4) y = r.top - th - 8;
    x = Math.max(4, Math.min(window.innerWidth - tw - 4, x));
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  };
  const show = (el: HTMLElement) => {
    const t = textFor(el); const help = helpFor(el);
    if (!t || (!t.label && !t.keys)) return;
    if (!help && !el.matches("[data-action],[data-keys],[data-tip],[title]")) return; // nameless plain button with nothing to say
    tip.replaceChildren();
    const head = document.createElement("div"); head.className = "head";
    const label = document.createElement("span"); label.textContent = t.label; head.append(label);
    if (t.keys) { const kbd = document.createElement("kbd"); kbd.textContent = t.keys; head.append(kbd); }
    tip.append(head);
    if (help && help !== t.label) { const d = document.createElement("div"); d.className = "desc"; d.textContent = help; tip.append(d); }
    current = el; place(el);
  };
  const hide = () => { window.clearTimeout(timer); timer = 0; current = null; tip.style.display = "none"; };

  document.addEventListener("mouseover", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action],[data-keys],[title],[data-tip],[data-help],button,.field > label");
    if (!el || el === current) return;
    hide();
    if (el.closest("#tooltip")) return;
    timer = window.setTimeout(() => show(el), 220);
  });
  document.addEventListener("mouseout", (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>("[data-action],[data-keys],[title],[data-tip],[data-help],button,.field > label");
    if (el && !el.contains(e.relatedTarget as Node | null)) hide();
  });
  for (const ev of ["pointerdown", "keydown", "scroll", "wheel"]) document.addEventListener(ev, hide, { capture: true, passive: true });
  window.addEventListener("blur", hide);
}
