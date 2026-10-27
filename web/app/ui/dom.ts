/** Minimal DOM builder. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Array<Node | string | null | undefined | false>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v as Record<string, string>);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "value") (el as HTMLInputElement).value = String(v);
    else if (k === "checked") (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(c));
  return el;
}

export function field(label: string, input: HTMLElement, valueText?: () => string): HTMLElement {
  const val = h("span", { class: "val" }, valueText ? valueText() : "");
  const row = h("div", { class: "field" }, h("label", {}, label), input, val);
  if (valueText) input.addEventListener("input", () => (val.textContent = valueText()));
  return row;
}

export function slider(min: number, max: number, step: number, value: number, onInput: (v: number) => void): HTMLInputElement {
  const el = h("input", { type: "range", min, max, step, value }) as HTMLInputElement;
  el.addEventListener("input", () => onInput(Number(el.value)));
  return el;
}

export function clear(el: HTMLElement): { append(...nodes: Array<Node | string | null | undefined | false>): void } {
  el.replaceChildren();
  return { append: (...nodes) => { for (const n of nodes) if (n !== null && n !== undefined && n !== false) el.append(n); } };
}
