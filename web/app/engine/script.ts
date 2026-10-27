/**
 * The panel script: a story written one panel per line, turned into pages, panels, prompts and
 * balloons. No model reads it; the rules below do, so what you write is what you get.
 *
 *   @Kai = kai, 1boy, short black hair, dark green power armor      cast: name = trigger + tags
 *   @Mira = mira, 1girl, long silver hair, red coat
 *
 *   # Page 1                                                       a comment; blank line = new page
 *   [wide] night city street, rain, neon signs
 *   [close-up] Kai, angry: "You lied to me."
 *   [two-shot] Kai | Mira, calm: "I had no choice."
 *   [action] Kai punching, speed lines | Mira dodging
 *   [full body] Kai running away, rain
 *
 * Line grammar: optional [shot], then segments split on "|". A segment that starts with a cast
 * name is that character: "Name, emotion, more tags: "what they say"". Anything else is scene
 * tags. Several speakers on one line make several balloons. Shots map to the camera tags the
 * checkpoints know.
 */
export interface CastMember { name: string; trigger: string; tags: string[] }
export interface Line { speaker: string; text: string; emotion: string }
export interface ScriptPanel { page: number; index: number; shot: string; tags: string[]; cast: string[]; dialogue: Line[]; raw: string; prompt: string }
export interface Script { cast: CastMember[]; pages: ScriptPanel[][]; errors: string[] }

export const SHOTS: Record<string, string[]> = {
  "wide": ["wide shot", "establishing shot"], "very wide": ["very wide shot", "scenery"], "establishing": ["wide shot", "establishing shot", "scenery"],
  "full body": ["full body"], "full": ["full body"], "cowboy": ["cowboy shot"], "medium": ["upper body"], "upper body": ["upper body"],
  "close-up": ["close-up", "portrait"], "closeup": ["close-up", "portrait"], "close": ["close-up"], "extreme close-up": ["extreme close-up", "eye focus"], "eyes": ["extreme close-up", "eye focus"],
  "two-shot": ["2 people", "upper body"], "two shot": ["2 people", "upper body"], "over the shoulder": ["over the shoulder", "pov"], "pov": ["pov"],
  "low angle": ["from below", "dynamic angle"], "high angle": ["from above"], "dutch": ["dutch angle"],
  "action": ["dynamic angle", "action lines", "speed lines", "foreshortening"], "impact": ["dynamic angle", "impact frame", "action lines"], "splash": ["wide shot", "dynamic angle", "dramatic"],
  "reaction": ["close-up", "portrait"], "insert": ["close-up", "hand focus"],
};

const EMOTIONS = new Set(["angry", "furious", "calm", "sad", "crying", "happy", "smiling", "laughing", "scared", "nervous", "surprised", "shocked", "serious", "determined", "confident", "tired", "embarrassed", "blush", "despair", "relieved", "smirk", "glaring", "worried", "expressionless", "pain"]);
const EMOTION_TAGS: Record<string, string> = { angry: "angry", furious: "furious", calm: "expressionless", sad: "sad", crying: "crying", happy: "smile", smiling: "smile", laughing: "laughing", scared: "scared", nervous: "nervous", surprised: "surprised", shocked: "shocked", serious: "serious", determined: "determined", confident: "confident", tired: "half-closed eyes", embarrassed: "embarrassed", blush: "blush", despair: "despair", relieved: "relieved", smirk: "smirk", glaring: "glaring", worried: "worried", expressionless: "expressionless", pain: "clenched teeth" };

export function parseScript(text: string): Script {
  const cast: CastMember[] = []; const pages: ScriptPanel[][] = [[]]; const errors: string[] = [];
  const byName = () => new Map(cast.map((c) => [c.name.toLowerCase(), c]));
  const lines = text.replace(/\r/g, "").split("\n");
  lines.forEach((rawLine, ln) => {
    const line = rawLine.trim();
    if (!line) { if (pages[pages.length - 1]!.length) pages.push([]); return; }
    if (line.startsWith("#")) return;
    const castDef = line.match(/^@(\w[\w .'-]*?)\s*=\s*(.+)$/);
    if (castDef) {
      const tags = castDef[2]!.split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean);
      if (!tags.length) { errors.push(`line ${ln + 1}: cast "${castDef[1]}" has no tags`); return; }
      cast.push({ name: castDef[1]!.trim(), trigger: tags[0]!, tags: tags.slice(1) }); return;
    }
    let shot = ""; let rest = line;
    const sm = line.match(/^\[([^\]]+)\]\s*(.*)$/); if (sm) { shot = sm[1]!.trim().toLowerCase(); rest = sm[2]!; if (!SHOTS[shot]) { errors.push(`line ${ln + 1}: unknown shot "[${shot}]" (using it as a tag)`); } }
    const names = byName(); const tags: string[] = []; const who: string[] = []; const dialogue: Line[] = [];
    for (const seg of rest.split("|").map((s) => s.trim()).filter(Boolean)) {
      // Name[, emotion, tags...]: "text"   or   Name, tags   or   plain tags
      const dm = seg.match(/^([^:"]+?)\s*:\s*["“](.+?)["”]\s*$/);
      const head = (dm ? dm[1]! : seg).split(/\s*,\s*/).map((t) => t.trim()).filter(Boolean);
      const first = head[0]?.toLowerCase() ?? "";
      const member = names.get(first);
      if (member) {
        if (!who.includes(member.name)) who.push(member.name);
        let emotion = "";
        for (const t of head.slice(1)) { const e = t.toLowerCase(); if (EMOTIONS.has(e)) { emotion = e; tags.push(EMOTION_TAGS[e]!); } else tags.push(t); }
        if (dm) dialogue.push({ speaker: member.name, text: dm[2]!.trim(), emotion });
      } else {
        if (dm) { dialogue.push({ speaker: head[0] ?? "", text: dm[2]!.trim(), emotion: "" }); tags.push(...head.slice(1)); if (head[0] && !names.has(first)) errors.push(`line ${ln + 1}: "${head[0]}" is not in the cast (add "@${head[0]} = ..." at the top); treated as a caption`); }
        else tags.push(...head);
      }
    }
    const page = pages.length - 1; const panel: ScriptPanel = { page, index: pages[page]!.length, shot, tags, cast: who, dialogue, raw: line, prompt: "" };
    panel.prompt = panelPrompt(panel, cast);
    pages[page]!.push(panel);
  });
  if (!pages[pages.length - 1]!.length) pages.pop();
  return { cast, pages, errors };
}

/** the tags one panel sends: cast first (trigger + look), then emotion and scene, then the shot */
export function panelPrompt(p: ScriptPanel, cast: CastMember[]): string {
  const members = p.cast.map((n) => cast.find((c) => c.name === n)).filter((c): c is CastMember => !!c);
  const count = members.length >= 2 ? ["2 people"] : [];
  const castTags = members.flatMap((c) => [c.trigger, ...c.tags]);
  const shot = SHOTS[p.shot] ?? (p.shot ? [p.shot] : []);
  return [...count, ...castTags, ...p.tags, ...shot].filter((t, i, a) => t && a.indexOf(t) === i).join(", ");
}

/** which page template fits a count of panels (and whether the first is wide) */
export function templateFor(panels: ScriptPanel[]): string {
  const n = panels.length; const firstWide = ["wide", "very wide", "establishing", "splash"].includes(panels[0]?.shot ?? "");
  const action = panels.some((p) => p.shot === "action" || p.shot === "impact");
  if (n <= 1) return "Single splash";
  if (n === 2) return "2 rows";
  if (n === 3) return firstWide ? "Wide top + 2" : "3 rows";
  if (n === 4) return firstWide ? "Tall left + 3" : "2 x 2";
  if (n === 5) return "Action 5";
  if (n === 6) return action ? "Staircase 6" : "2 x 3";
  return "2 x 3";
}

/** balloon slots inside a panel box, in manga reading order (right to left, top to bottom) */
export function balloonSlots(box: { x0: number; y0: number; x1: number; y1: number }, n: number): Array<{ x: number; y: number; w: number; h: number }> {
  const W = box.x1 - box.x0, H = box.y1 - box.y0; const w = Math.min(W * 0.4, Math.max(W * 0.28, H * 0.3)), h = Math.min(H * 0.26, w * 0.6);
  const pad = Math.min(W, H) * 0.04;
  const spots = [[box.x1 - w - pad, box.y0 + pad], [box.x0 + pad, box.y0 + pad], [box.x0 + pad, box.y1 - h - pad], [box.x1 - w - pad, box.y1 - h - pad]];
  return spots.slice(0, Math.min(n, 4)).map(([x, y]) => ({ x: x!, y: y!, w, h }));
}
