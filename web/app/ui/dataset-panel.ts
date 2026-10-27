/**
 * Dataset tab: look through the kept images and fix what the trainer will learn from.
 *
 * Every row is one image with its caption. The sidecar marks the weak ones (no subject, no action,
 * only quality words, nothing at all), because a LoRA learns exactly what the caption says and
 * nothing else. Here you can rewrite the caption, ask the tagger what it sees, move the image to
 * another action folder, give it a name, tag it with a character (for a per-character LoRA), or
 * take it out of the set. Nothing is deleted: removed images go to dataset/removed.
 */
import { clear, field, h } from "./dom.js";
import type { AppState } from "./state.js";
import { JobRunner, type DatasetItem, type Provider } from "../engine/ml.js";

const ACTIONS = ["running", "walking", "jumping", "fighting", "sword", "shooting", "sneaking", "talking", "death", "disarming", "sitting", "standing", "misc"];

export function datasetPanel(app: AppState): HTMLElement {
  const root = h("div", { class: "dataset-tab" });
  const provider = (): Provider | null => (app as unknown as { ml?: JobRunner }).ml?.provider ?? null;
  let items: DatasetItem[] = []; let loaded = false; let error = ""; let filter: "all" | "weak" = "weak"; let folder = ""; let open: string | null = null; let busy = "";
  /** edits in progress for the open row */
  let draft: { caption: string; action: string; name: string; character: string } | null = null;
  let characters: string[] = [];
  let render = () => {};

  const load = async () => {
    const p = provider(); error = "";
    if (!p?.datasetList) { error = "The sidecar is not connected (check it in the Generate tab)."; loaded = true; render(); return; }
    try { items = await p.datasetList(); characters = [...new Set(items.map((i) => i.character).filter(Boolean))].sort(); }
    catch (e) { error = (e as Error).message; }
    loaded = true; render();
  };
  const openRow = (it: DatasetItem) => { open = it.id; draft = { caption: it.caption, action: it.action === "unsorted" ? "misc" : it.action, name: it.name.replace(/-\d{6,}x*$/, ""), character: it.character }; render(); };
  const saveRow = async (it: DatasetItem) => {
    const p = provider(); if (!p?.datasetUpdate || !draft) return;
    busy = it.id; render();
    try {
      const r = await p.datasetUpdate({ id: it.id, caption: tidy(draft.caption), action: draft.action, name: draft.name, character: draft.character });
      Object.assign(it, { id: r.id, caption: r.caption, issues: r.issues, action: draft.action, character: draft.character.toLowerCase().replace(/[^a-z0-9]+/g, "-") });
      open = null; draft = null; characters = [...new Set(items.map((i) => i.character).filter(Boolean))].sort();
    } catch (e) { error = (e as Error).message; }
    busy = ""; render();
  };
  const removeRow = async (it: DatasetItem) => {
    const p = provider(); if (!p?.datasetRemove) return;
    if (!confirm(`Take "${it.name}" out of the training set? It moves to dataset/removed; nothing is deleted.`)) return;
    busy = it.id; render();
    try { await p.datasetRemove(it.id); items = items.filter((x) => x !== it); if (open === it.id) { open = null; draft = null; } }
    catch (e) { error = (e as Error).message; }
    busy = ""; render();
  };
  /** tags joined cleanly: no empty entries, no doubled commas */
  const tidy = (cap: string) => cap.split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean).join(", ");
  const suggest = async (it: DatasetItem) => {
    const p = provider(); if (!p?.datasetSuggest || !draft) return;
    busy = it.id; render();
    try {
      const tags = (await p.datasetSuggest(it.id)).filter((t) => t.p >= 0.45).map((t) => t.tag);
      const have = new Set(draft.caption.split(/\s*,\s*/).map((t) => t.toLowerCase().replace(/^\(+|\)+$|:[\d.]+$/g, "")));
      const add = tags.filter((t) => !have.has(t));
      draft.caption = tidy([draft.caption, ...add].join(", "));
    } catch (e) { error = (e as Error).message; }
    busy = ""; render();
  };

  render = () => {
    const p = provider();
    const shown = items.filter((it) => (filter === "all" || it.issues.length) && (!folder || it.action === folder));
    const weak = items.filter((it) => it.issues.length).length;
    const perChar = new Map<string, number>(); for (const it of items) if (it.character) perChar.set(it.character, (perChar.get(it.character) ?? 0) + 1);
    clear(root).append(
      h("h3", {}, "Training set"),
      h("p", { class: "dim", style: { fontSize: "11.5px", margin: "4px 0" } }, "A LoRA learns exactly what each caption says. Weak captions (no subject, no action, only quality words) teach nothing or the wrong thing. Fix them here: rewrite, ask the tagger, move, name, tag a character, or take the image out."),
      h("div", { class: "row", style: { gap: "6px", alignItems: "center", flexWrap: "wrap", margin: "4px 0" } },
        h("button", { title: "Reload set", onClick: () => void load() }, loaded ? "Reload" : "Load"),
        h("span", { class: "dim", style: { fontSize: "11px" } }, loaded ? `${items.length} images · ${weak} with weak captions` : "not loaded"),
        h("select", { title: "Show", onChange: (e: Event) => { filter = (e.target as HTMLSelectElement).value as typeof filter; render(); } }, h("option", { value: "weak", selected: filter === "weak" }, "weak captions"), h("option", { value: "all", selected: filter === "all" }, "all")),
        h("select", { title: "Folder", onChange: (e: Event) => { folder = (e.target as HTMLSelectElement).value; render(); } }, h("option", { value: "", selected: !folder }, "every action"), ...[...new Set(items.map((i) => i.action))].sort().map((a) => h("option", { value: a, selected: folder === a }, `${a} (${items.filter((i) => i.action === a).length})`)))),
      error ? h("div", { class: "notice", style: { fontSize: "11.5px" } }, error) : null,
      perChar.size ? h("div", { class: "mono dim", style: { fontSize: "10.5px", margin: "2px 0" } }, "Characters: " + [...perChar.entries()].map(([k, v]) => `${k} ${v}${v < 15 ? " (need 15+)" : ""}`).join(" · "), h("div", {}, "Train one:  .venv\\Scripts\\python train_lora.py --name kai --only kai --trigger kai")) : null,
      h("div", { class: "sep" }),
      ...shown.slice(0, 120).map((it) => {
        const isOpen = open === it.id; const d = isOpen ? draft! : null;
        return h("div", { class: "gen-job", style: { marginBottom: "6px" } },
          h("div", { class: "row", style: { gap: "8px", alignItems: "flex-start" } },
            p?.datasetThumb ? h("img", { src: p.datasetThumb(it.id, 120), style: { width: "72px", height: "72px", objectFit: "cover", border: "1px solid #444", borderRadius: "3px", cursor: "pointer" }, title: it.id, onClick: () => (isOpen ? (open = null, draft = null, render()) : openRow(it)) }) : null,
            h("div", { style: { flex: "1", minWidth: "0" } },
              h("div", { class: "row", style: { gap: "6px", alignItems: "center", fontSize: "11.5px" } }, h("b", {}, it.name), h("span", { class: "chip" }, it.action), it.character ? h("span", { class: "chip ok" }, it.character) : null, h("span", { class: "grow" }),
                isOpen ? null : h("button", { title: "Edit caption", onClick: () => openRow(it) }, "Edit")),
              it.issues.length ? h("div", { style: { fontSize: "11px", color: "#d9b65c" } }, it.issues.join(" · ")) : h("div", { class: "dim", style: { fontSize: "11px" } }, "caption looks usable"),
              isOpen ? null : h("div", { class: "mono dim", style: { fontSize: "10.5px", whiteSpace: "pre-wrap", wordBreak: "break-word" } }, it.caption || "(no caption)"))),
          isOpen && d ? h("div", { style: { marginTop: "6px" } },
            h("div", { class: "field stack" }, h("label", { title: "Caption", "data-help": "Tags that are true of the picture, subject first: 1boy, running, holding gun, rain, city. Leave out quality words; they describe the generator, not the picture." }, "Caption"),
              h("textarea", { rows: 4, style: { width: "100%", resize: "vertical", fontSize: "11px" }, onInput: (e: Event) => { d.caption = (e.target as HTMLTextAreaElement).value; } }, d.caption)),
            h("div", { class: "row", style: { gap: "6px", flexWrap: "wrap", margin: "4px 0" } },
              h("button", { title: "Suggest tags", "data-help": "Ask the WD14 tagger what it sees and append the confident tags. Check them: it is a photo-and-anime tagger, not a mind reader.", disabled: busy === it.id || !p?.datasetSuggest, onClick: () => void suggest(it) }, "Suggest tags"),
              h("button", { title: "Prepend subject", onClick: () => { if (!/\b(1boy|1girl|solo|2girls|2boys)\b/.test(d.caption)) { d.caption = tidy(`1boy, ${d.caption}`); render(); } } }, "+1boy"),
              h("button", { title: "Prepend subject", onClick: () => { if (!/\b(1boy|1girl|solo|2girls|2boys)\b/.test(d.caption)) { d.caption = tidy(`1girl, ${d.caption}`); render(); } } }, "+1girl"),
              h("button", { title: "Strip quality words", "data-help": "Remove masterpiece, best quality, absurdres and the other generator words from the caption.", onClick: () => { d.caption = d.caption.split(/\s*,\s*/).filter((t) => t.trim() && !/^(masterpiece|best quality|high score|great score|absurdres|very aesthetic|highly detailed|8k|lowres)$/i.test(t.trim())).join(", "); render(); } }, "Strip quality words")),
            field("Action", h("select", { title: "Action folder", onChange: (e: Event) => { d.action = (e.target as HTMLSelectElement).value; } }, ...ACTIONS.map((a) => h("option", { value: a, selected: d.action === a }, a)))),
            field("Name", h("input", { type: "text", value: d.name, style: { width: "100%" }, onInput: (e: Event) => { d.name = (e.target as HTMLInputElement).value; } })),
            field("Character", h("input", { type: "text", value: d.character, list: "dataset-characters", placeholder: "e.g. kai (one word, used as the LoRA trigger)", style: { width: "100%" }, title: "Character tag", "data-help": "Tag every image of one character with the same word. train_lora.py --only kai --trigger kai then trains a LoRA on just those images. 15 to 30 clean images per character.", onInput: (e: Event) => { d.character = (e.target as HTMLInputElement).value; } })),
            h("datalist", { id: "dataset-characters" }, ...characters.map((c) => h("option", { value: c }))),
            h("div", { class: "row", style: { gap: "6px", marginTop: "4px" } },
              h("button", { class: "primary", disabled: busy === it.id, title: "Save caption", onClick: () => void saveRow(it) }, busy === it.id ? "Saving…" : "Save"),
              h("button", { title: "Cancel edit", onClick: () => { open = null; draft = null; render(); } }, "Cancel"),
              h("span", { class: "grow" }),
              h("button", { title: "Remove from set", disabled: busy === it.id, onClick: () => void removeRow(it) }, "Remove from set"))) : null);
      }),
      loaded && !shown.length ? h("p", { class: "dim", style: { fontSize: "11px" } }, items.length ? "Nothing to show with this filter." : "No kept images yet. Keep results in the Generate tab first.") : null,
      shown.length > 120 ? h("p", { class: "dim", style: { fontSize: "11px" } }, `Showing 120 of ${shown.length}; narrow by folder.`) : null);
  };
  render();
  app.on("dock", (name: unknown) => { if (name === "Dataset" && !loaded) void load(); });
  return root;
}
