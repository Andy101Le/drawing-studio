/**
 * Story tab: write the manga as a panel script, lay out a page from it, generate every panel with
 * the Generate tab's settings, and drop the dialogue into balloons.
 */
import { clear, field, h } from "./dom.js";
import type { AppState } from "./state.js";
import { PANEL_TEMPLATES, applyPanelTemplate, newBalloon } from "../engine/manga.js";
import { parseScript, templateFor, balloonSlots, type Script } from "../engine/script.js";

const KEY = "omni.story.v1";
const EXAMPLE = `@Kai = kai, 1boy, short black hair, dark green power armor, red accents
@Mira = mira, 1girl, long silver hair, red coat

# Page 1
[wide] night city street, rain, neon signs
[close-up] Kai, angry: "You lied to me."
[two-shot] Kai | Mira, calm: "I had no choice."
[action] Kai punching, speed lines | Mira dodging
[full body] Kai running away, rain`;

export function storyPanel(app: AppState): HTMLElement {
  const root = h("div", { class: "story-tab" });
  let text = EXAMPLE; try { text = localStorage.getItem(KEY) ?? EXAMPLE; } catch { /* storage off */ }
  let page = 0; let script: Script = parseScript(text); let log: string[] = []; let running = false;
  let render = () => {};
  const save = () => { try { localStorage.setItem(KEY, text); } catch { /* quota */ } };

  const layout = (): boolean => {
    const panels = script.pages[page]; if (!panels?.length) return false;
    const name = templateFor(panels); const t = PANEL_TEMPLATES.find((q) => q.name === name) ?? PANEL_TEMPLATES[0]!;
    const d = app.doc; const margin = app.pageGuides?.safe ?? Math.round(d.dpi * 0.5), gutter = Math.round(d.dpi * 0.12);
    const prev = d.panels; const next = applyPanelTemplate(d, t, margin, gutter);
    d.panels = next; for (const f of d.frames) for (const l of f.layers) l.panelMask = null;
    app.history.pushCustom(`Story page ${page + 1}: ${t.name}`, () => { d.panels = prev; app.invalidate(); app.emit("panels"); }, () => { d.panels = next; app.invalidate(); app.emit("panels"); });
    app.invalidate(); app.emit("panels");
    log.push(`page ${page + 1}: ${t.name} (${panels.length} panels)`); return true;
  };
  const addBalloons = () => {
    const panels = script.pages[page]; if (!panels) return;
    const d = app.doc; const made: number[] = [];
    panels.forEach((p, i) => {
      const panel = d.panels[i]; if (!panel || !p.dialogue.length) return;
      const xs = panel.polygon.map((q) => q.x), ys = panel.polygon.map((q) => q.y);
      const box = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      balloonSlots(box, p.dialogue.length).forEach((slot, k) => {
        const line = p.dialogue[k]!; const b = newBalloon(slot.x, slot.y, slot.w, slot.h, /[!?]{2,}|[A-Z]{4,}/.test(line.text) ? "shout" : "speech", d.dpi);
        b.text = line.text; d.balloons.push(b); made.push(b.id);
      });
    });
    if (made.length) { app.history.pushCustom(`Story balloons page ${page + 1}`, () => { d.balloons = d.balloons.filter((b) => !made.includes(b.id)); app.invalidate(); app.emit("balloons"); }, () => { app.invalidate(); app.emit("balloons"); }); app.invalidate(); app.emit("balloons"); }
    log.push(`${made.length} balloons placed`);
  };
  const generatePage = async () => {
    const gen = (app as unknown as { generateFor?: (o: { panelId: number; tags: string[]; place: boolean }) => Promise<{ ok: boolean; error?: string }> }).generateFor;
    if (!gen) { log.push("open the Generate tab once first (it holds the model settings)"); render(); return; }
    const panels = script.pages[page]; if (!panels?.length) return;
    if (app.doc.panels.length < panels.length) layout();
    running = true; render();
    for (let i = 0; i < panels.length; i++) {
      const p = panels[i]!; const target = app.doc.panels[i]; if (!target) break;
      log.push(`panel ${i + 1}: ${p.prompt.slice(0, 70)}…`); render();
      const r = await gen({ panelId: target.id, tags: p.prompt.split(/\s*,\s*/).filter(Boolean), place: true });
      log.push(r.ok ? `panel ${i + 1}: placed` : `panel ${i + 1}: ${r.error}`); render();
      if (!r.ok) break;
    }
    addBalloons(); running = false; render();
  };

  render = () => {
    const pages = script.pages; const panels = pages[page] ?? [];
    clear(root).append(
      h("h3", {}, "Story to panels"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "One panel per line. Blank line starts a new page. Cast lines (@Name = trigger, tags) say who is who; a segment starting with a name is that character, with an emotion and a line in quotes. [shot] picks the camera. Nothing reads this but the rules, so what you write is what is sent."),
      h("textarea", { rows: 12, style: { width: "100%", resize: "vertical", fontFamily: "monospace", fontSize: "11px" }, spellcheck: "false", onInput: (e: Event) => { text = (e.target as HTMLTextAreaElement).value; script = parseScript(text); save(); const el = root.querySelector("#story-plan"); if (el) el.replaceWith(plan()); } }, text),
      plan(),
      h("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap", margin: "6px 0" } },
        field("Page", h("select", { title: "Page", onChange: (e: Event) => { page = Number((e.target as HTMLSelectElement).value); render(); } }, ...pages.map((_, i) => h("option", { value: String(i), selected: i === page }, `Page ${i + 1} (${pages[i]!.length} panels)`)))),
        h("button", { title: "Lay out page", "data-help": `Apply the template that fits this page's panel count (${panels.length ? templateFor(panels) : "none"}) inside the safe area. Refine with the cut tool after.`, disabled: !panels.length, onClick: () => { layout(); render(); } }, "Lay out page"),
        h("button", { class: "primary", title: "Generate page", "data-help": "Lay out if needed, then generate each panel in order with the Generate tab's settings (model, look, pose and anatomy options, LoRAs), place each result in its panel, and add the dialogue balloons.", disabled: !panels.length || running, onClick: () => void generatePage() }, running ? "Generating…" : "Generate page"),
        h("button", { title: "Balloons only", "data-help": "Place the dialogue balloons for this page without generating.", disabled: !panels.length, onClick: () => { addBalloons(); render(); } }, "Balloons only")),
      log.length ? h("div", { class: "mono dim", style: { fontSize: "10.5px", whiteSpace: "pre-wrap", maxHeight: "140px", overflow: "auto" } }, log.slice(-12).join("\n")) : null,
      h("div", { class: "sep" }),
      h("p", { class: "dim", style: { fontSize: "11px" } }, "Characters stay consistent only if their trigger word is a trained LoRA (Dataset tab → tag images with the character → train_lora.py --only kai --trigger kai) and the LoRA is ticked in the Generate tab. Without that, the tags after the trigger carry the look and the character will drift between panels."));
  };
  const plan = (): HTMLElement => {
    const panels = script.pages[page] ?? [];
    return h("div", { id: "story-plan", style: { margin: "4px 0" } },
      script.errors.length ? h("div", { class: "notice", style: { fontSize: "11px" } }, script.errors.slice(0, 4).join("\n")) : null,
      script.cast.length ? h("div", { class: "dim", style: { fontSize: "11px" } }, "Cast: " + script.cast.map((c) => `${c.name} (${c.trigger})`).join(", ")) : h("div", { class: "dim", style: { fontSize: "11px" } }, "No cast yet: add @Name = trigger, tags lines."),
      ...panels.map((p, i) => h("div", { class: "mono", style: { fontSize: "10.5px", margin: "2px 0", borderLeft: "2px solid #555", paddingLeft: "6px" } },
        h("b", {}, `${i + 1}. `), p.shot ? h("span", { class: "chip" }, p.shot) : null, " ", p.prompt,
        ...p.dialogue.map((l) => h("div", { class: "dim" }, `${l.speaker}${l.emotion ? ` (${l.emotion})` : ""}: "${l.text}"`)))));
  };
  render();
  return root;
}
