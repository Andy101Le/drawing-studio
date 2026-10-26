/**
 * Character design controls for the Generate panel: what the character wears, what colour it is,
 * helmet on or off, and free text for the armour, helmet and overall aesthetic. Everything here is
 * turned into weighted prompt fragments that go FIRST in the prompt (the model attends most to the
 * first 75 tokens), with the matching negatives (helmet off also means "helmet" in the negative).
 *
 * Weight syntax is the WebUI's: (tag:1.3) multiplies that tag's token embeddings by 1.3. The
 * sidecar's prompt encoder reads it; a provider without it just sees the text.
 */
import { h } from "./dom.js";

export type Helmet = "any" | "on" | "off" | "open";
export type RenderStyle = "model" | "anime" | "semi" | "realistic";

export interface Design {
  render: RenderStyle;
  helmet: Helmet;
  armourKind: string;   // "" = none
  armourColour: string; // "" = unspecified; free text allowed ("matte gunmetal")
  accentColour: string;
  clothingKind: string;
  clothingColour: string;
  hairColour: string;
  eyeColour: string;
  armourText: string;   // free description of the armour / outfit
  helmetText: string;   // free description of the helmet / headgear
  aesthetic: string;    // overall look: materials, era, wear, palette
  emphasis: number;     // 1.0 .. 1.5: weight on the design fragments
}

export const DESIGN_DEFAULTS: Design = { render: "model", helmet: "any", armourKind: "", armourColour: "", accentColour: "", clothingKind: "", clothingColour: "", hairColour: "", eyeColour: "", armourText: "", helmetText: "", aesthetic: "", emphasis: 1.2 };

export const COLOURS = ["black", "white", "grey", "silver", "gunmetal", "gold", "bronze", "red", "crimson", "dark red", "orange", "yellow", "green", "dark green", "olive", "teal", "cyan", "blue", "navy", "light blue", "purple", "violet", "pink", "brown", "tan", "beige"];
export const ARMOUR_KINDS = ["power armor", "plate armor", "full armor", "mecha armor", "exoskeleton", "combat armor", "samurai armor", "knight armor", "bodysuit", "spacesuit", "tactical gear", "riot gear"];
export const CLOTHING_KINDS = ["jacket", "coat", "trench coat", "hoodie", "school uniform", "military uniform", "suit", "kimono", "cloak", "cape", "dress", "shirt", "t-shirt", "sweater", "vest", "pants", "shorts", "skirt", "boots", "gloves", "scarf"];

export const RENDER_STYLES: Array<{ id: RenderStyle; label: string; hint: string; tags: string[]; negative: string[] }> = [
  { id: "model", label: "Model default", hint: "No extra style words; the checkpoint's own look.", tags: [], negative: [] },
  { id: "anime", label: "Anime cel", hint: "Flat cel shading and clean lines, as in a TV anime.", tags: ["anime screencap", "cel shading", "flat color", "clean lineart"], negative: ["realistic", "photo", "3d render", "painterly"] },
  { id: "semi", label: "Semi-realistic", hint: "Anime proportions with real lighting and materials; DreamShaper-style checkpoints do this best.", tags: ["semi-realistic", "detailed shading", "soft lighting", "detailed clothes", "detailed metal"], negative: ["chibi", "flat color", "sketch", "lowres"] },
  { id: "realistic", label: "Realistic", hint: "Photographic rendering: skin and metal texture, depth of field. An anime checkpoint resists this; use a realistic or semi-realistic checkpoint.", tags: ["(realistic:1.3)", "photorealistic", "detailed skin texture", "detailed metal texture", "cinematic lighting", "depth of field", "8k"], negative: ["anime", "cartoon", "cel shading", "flat color", "lineart", "sketch", "doll"] },
];

const w = (t: string, k: number) => (k > 1.005 ? `(${t}:${k.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")})` : t);

/** The prompt fragments the design adds: positive (subject first) and negative. */
export function designPrompt(d: Design): { positive: string[]; negative: string[]; hasDesign: boolean } {
  const pos: string[] = []; const neg: string[] = []; const k = d.emphasis;
  if (d.armourKind) pos.push(w([d.armourColour, d.armourKind].filter(Boolean).join(" "), k));
  else if (d.armourColour) pos.push(w(`${d.armourColour} armor`, k));
  if (d.accentColour) pos.push(w(`${d.accentColour} accents`, Math.min(k, 1.2)));
  if (d.clothingKind) pos.push(w([d.clothingColour, d.clothingKind].filter(Boolean).join(" "), k));
  else if (d.clothingColour) pos.push(w(`${d.clothingColour} clothes`, k));
  if (d.hairColour) pos.push(`${d.hairColour} hair`);
  if (d.eyeColour) pos.push(`${d.eyeColour} eyes`);
  if (d.helmet === "on") { pos.push(w("helmet", k), "full helmet", "covered face"); neg.push("no headwear", "bare head", "visible face"); }
  if (d.helmet === "off") { pos.push(w("no headwear", k), "face visible", "bare head"); neg.push("helmet", "mask", "visor", "covered face", "hood"); }
  if (d.helmet === "open") { pos.push(w("helmet", k), "open visor", "face visible"); neg.push("covered face", "mask"); }
  if (d.armourText.trim()) pos.push(w(d.armourText.trim(), Math.min(k, 1.25)));
  if (d.helmetText.trim() && d.helmet !== "off") pos.push(w(d.helmetText.trim(), Math.min(k, 1.25)));
  if (d.aesthetic.trim()) pos.push(d.aesthetic.trim());
  const rs = RENDER_STYLES.find((r) => r.id === d.render)!;
  return { positive: pos, negative: [...neg, ...rs.negative], hasDesign: pos.length > 0 };
}

/** Style tags go LAST in the prompt (they still work past token 75 with the chunked encoder, and the subject comes first). */
export function renderStyleTags(d: Design): string[] { return RENDER_STYLES.find((r) => r.id === d.render)!.tags; }

const colourPick = (value: string, title: string, help: string, onChange: (v: string) => void) => {
  const custom = !!value && !COLOURS.includes(value);
  const sel = h("select", { title, "data-help": help, onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v === "__custom") { const t = prompt("Colour or material (e.g. matte gunmetal, pearl white)", custom ? value : ""); onChange((t ?? "").trim()); } else onChange(v); } },
    h("option", { value: "", selected: !value }, "any colour"),
    ...COLOURS.map((c) => h("option", { value: c, selected: value === c }, c)),
    h("option", { value: "__custom", selected: custom }, custom ? `custom: ${value}` : "custom…"));
  return sel;
};
const kindPick = (value: string, kinds: string[], none: string, title: string, help: string, onChange: (v: string) => void) => {
  const custom = !!value && !kinds.includes(value);
  return h("select", { title, "data-help": help, onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v === "__custom") { const t = prompt("Describe it in a few words (e.g. segmented carbon plate armor)", custom ? value : ""); onChange((t ?? "").trim()); } else onChange(v); } },
    h("option", { value: "", selected: !value }, none),
    ...kinds.map((c) => h("option", { value: c, selected: value === c }, c)),
    h("option", { value: "__custom", selected: custom }, custom ? `custom: ${value}` : "custom…"));
};

/** The section's DOM. `field` is the panel's own label+control row helper. */
export function renderDesign(d: Design, field: (label: string, control: HTMLElement, value?: () => string) => HTMLElement, slider: (min: number, max: number, step: number, v: number, on: (v: number) => void) => HTMLElement, onChange: () => void): HTMLElement[] {
  const set = <K extends keyof Design>(k: K, v: Design[K]) => { d[k] = v; onChange(); };
  const text = (k: "armourText" | "helmetText" | "aesthetic", rows: number, placeholder: string) => h("textarea", { rows, placeholder, style: { width: "100%", resize: "vertical", fontSize: "11.5px" }, onInput: (e: Event) => set(k, (e.target as HTMLTextAreaElement).value) }, d[k]);
  const dp = designPrompt(d);
  return [
    h("h3", {}, "Character design"),
    h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, "Colours, armour, helmet and your own description of the design. These go first in the prompt, with emphasis, so the model reads them before the style words."),
    field("Render style", h("select", { title: "Render style", "data-help": RENDER_STYLES.map((r) => `${r.label}: ${r.hint}`).join(" "), onChange: (e: Event) => set("render", (e.target as HTMLSelectElement).value as RenderStyle) }, ...RENDER_STYLES.map((r) => h("option", { value: r.id, selected: d.render === r.id }, r.label)))),
    d.render === "realistic" ? h("p", { class: "dim", style: { fontSize: "11px", margin: "2px 0" } }, "Realistic rendering depends on the checkpoint more than on the words: an anime model stays anime. Load the realistic or DreamShaper preset under Model for this.") : null,
    field("Armour", h("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
      colourPick(d.armourColour, "Armour colour", "Main colour of the armour. Becomes e.g. \"(dark green power armor:1.2)\".", (v) => set("armourColour", v)),
      kindPick(d.armourKind, ARMOUR_KINDS, "no armour", "Armour type", "What kind of armour; custom for your own words.", (v) => set("armourKind", v)))),
    field("Accent", colourPick(d.accentColour, "Accent colour", "Second colour: trim, lights, markings. Becomes \"red accents\".", (v) => set("accentColour", v))),
    field("Clothing", h("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
      colourPick(d.clothingColour, "Clothing colour", "Colour of the main garment.", (v) => set("clothingColour", v)),
      kindPick(d.clothingKind, CLOTHING_KINDS, "no garment", "Garment", "The main garment; custom for your own words.", (v) => set("clothingKind", v)))),
    field("Hair / eyes", h("div", { class: "row", style: { gap: "4px", flexWrap: "wrap" } },
      colourPick(d.hairColour, "Hair colour", "Hair colour tag.", (v) => set("hairColour", v)),
      colourPick(d.eyeColour, "Eye colour", "Eye colour tag.", (v) => set("eyeColour", v)))),
    field("Helmet", h("select", { title: "Helmet", "data-help": "On: helmet with the face covered, and \"no headwear\" in the negative. Off: face visible, with helmet, mask, visor and hood in the negative. Open visor: helmet on, face showing.", onChange: (e: Event) => set("helmet", (e.target as HTMLSelectElement).value as Helmet) },
      ...([["any", "not specified"], ["on", "On (face covered)"], ["off", "Off (face visible)"], ["open", "Open visor"]] as const).map(([v, l]) => h("option", { value: v, selected: d.helmet === v }, l)))),
    h("div", { class: "field stack" }, h("label", { title: "Armour / outfit design", "data-help": "Describe the design in detail: plates, joints, materials, insignia, wear, lights. Short comma-separated phrases work best. Added with emphasis right after the colours." }, "Armour / outfit design"), text("armourText", 3, "segmented shoulder plates, exposed hydraulic joints, chest emblem, scratched paint, glowing seams")),
    d.helmet === "off" ? null : h("div", { class: "field stack" }, h("label", { title: "Helmet / headgear design", "data-help": "Shape and features of the helmet: visor shape, antenna, crest, breathing mask, cracks." }, "Helmet / headgear design"), text("helmetText", 2, "angular visor, single red eye slit, vents on the cheeks, small antenna")),
    h("div", { class: "field stack" }, h("label", { title: "Aesthetic", "data-help": "The overall look: era, materials, palette, mood. Goes after the design, before the scene tags." }, "Aesthetic"), text("aesthetic", 2, "cyberpunk, worn industrial, matte paint with bright warning stripes, 90s mecha anime")),
    field("Emphasis", slider(1, 1.5, 0.05, d.emphasis, (v) => set("emphasis", v)), () => `×${d.emphasis.toFixed(2)}`),
    dp.hasDesign ? h("div", { class: "mono dim", style: { fontSize: "10.5px", margin: "2px 0 6px" } }, dp.positive.join(", ") + (dp.negative.length ? `  |  not: ${dp.negative.join(", ")}` : "")) : null,
    h("div", { class: "row", style: { gap: "6px" } }, h("button", { title: "Clear design", onClick: () => { Object.assign(d, DESIGN_DEFAULTS); onChange(); } }, "Clear design")),
  ].filter(Boolean) as HTMLElement[];
}
