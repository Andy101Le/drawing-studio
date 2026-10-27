/**
 * Prompt vocabulary for manga panels: Danbooru-style tags (what anime checkpoints were trained on),
 * grouped by what a panel needs to say: shot, action, emotion, effects, setting.
 * Plain phrases are used where no standard tag exists (marked in the help text as "phrase").
 */

export interface TagGroup { name: string; hint: string; tags: string[] }

export const TAG_GROUPS: TagGroup[] = [
  { name: "Cast", hint: "Who is in the panel.", tags: ["1girl", "1boy", "2girls", "2boys", "multiple girls", "multiple boys", "solo", "crowd", "faceless", "silhouette", "back turned"] },
  { name: "Shot", hint: "Framing: how much of the body the panel shows.", tags: ["extreme close-up", "close-up", "portrait", "upper body", "cowboy shot", "full body", "wide shot", "very wide shot", "eye focus", "hand focus", "foot focus", "weapon focus", "out of frame"] },
  { name: "Camera", hint: "Angle and lens. Low angles make a character look powerful; high angles make them small.", tags: ["from below", "from above", "from side", "from behind", "dutch angle", "fisheye", "foreshortening", "perspective", "pov", "pov hands", "dynamic angle", "upside-down", "vanishing point", "over the shoulder"] },
  { name: "Manga look", hint: "Black-and-white print rendering.", tags: ["monochrome", "greyscale", "manga", "comic", "lineart", "screentones", "halftone", "hatching (texture)", "cross-hatching", "high contrast", "ink wash", "traditional media", "sketch", "manga style"] },
  { name: "Colour style", hint: "For colour illustrations and covers (turn Manga look off).", tags: ["anime screencap", "cel shading", "flat color", "watercolor (medium)", "retro artstyle", "1990s (style)", "illustration", "official art", "pastel colors", "vivid colors", "muted colors", "limited palette"] },
  { name: "Motion FX", hint: "The marks manga uses to show speed and force.", tags: ["speed lines", "motion lines", "emphasis lines", "motion blur", "afterimage", "impact", "shockwave", "action lines", "blurry background", "wind lines"] },
  { name: "Talking", hint: "Dialogue panels. Speech bubbles come from the Balloons tool, not the model.", tags: ["talking", "open mouth", "closed mouth", "shouting", "screaming", "whispering", "hand to own mouth", "pointing", "pointing at viewer", "looking at another", "looking at viewer", "facing another", "eye contact", "conversation", "arguing", "phone call", "holding phone", "sitting across table"] },
  { name: "Emotion", hint: "Faces carry most of a manga page.", tags: ["smile", "grin", "smirk", "evil smile", "laughing", "angry", "furious", "clenched teeth", "frown", "serious", "determined", "surprised", "wide-eyed", "shocked", "scared", "nervous", "sweat", "crying", "tears", "streaming tears", "blush", "embarrassed", "expressionless", "half-closed eyes", "empty eyes", "shaded face", "shadowed face", "glaring", "despair", "relieved", "confident"] },
  { name: "Movement", hint: "Walking, running and getting around.", tags: ["walking", "running", "sprinting", "dashing", "jumping", "midair", "leaping", "falling", "landing", "rolling", "sliding", "climbing", "crouching", "kneeling", "one knee", "squatting", "sitting", "standing", "leaning forward", "looking back", "turning around", "walking away", "parkour", "stairs"] },
  { name: "Fighting", hint: "Hand-to-hand. Pair with Motion FX and a strong camera angle.", tags: ["fighting", "fighting stance", "battle", "martial arts", "punching", "incoming punch", "uppercut", "kicking", "high kick", "flying kick", "spinning kick", "knee strike", "headbutt", "elbow strike", "blocking", "dodging", "parrying", "grappling", "headlock", "chokehold", "throwing", "clenched hand", "fist", "incoming attack", "attack", "two people fighting"] },
  { name: "Blades", hint: "Swords and knives.", tags: ["holding sword", "katana", "unsheathing", "sheathed", "sword clash", "slashing", "sword swing", "slash", "stabbing", "dual wielding", "holding knife", "knife", "spear", "sparks", "sword behind back", "reverse grip"] },
  { name: "Guns", hint: "Shooting scenes.", tags: ["holding gun", "handgun", "rifle", "assault rifle", "shotgun", "sniper rifle", "aiming", "aiming at viewer", "aiming at another", "firing", "muzzle flash", "shell casing", "gunsmoke", "reloading", "finger on trigger", "two-handed grip", "scope", "bullet", "bullet hole", "gun to head", "dual pistols"] },
  { name: "Disarm", hint: "Taking a weapon away or restraining someone.", tags: ["disarming", "weapon drop", "wrist grab", "arm grab", "grabbing another's arm", "twisting arm", "arm lock", "pinned down", "restrained", "weapon knocked away", "dropping weapon", "kicking weapon", "hand on another's wrist", "hostage"] },
  { name: "Stealth", hint: "Sneaking and hiding.", tags: ["sneaking", "tiptoes", "crouching", "hiding", "peeking", "peeking out", "back against wall", "behind cover", "in shadow", "hood up", "hooded", "mask", "face mask", "night vision", "flashlight", "finger to mouth", "shushing", "knife", "ambush", "silhouette"] },
  { name: "Drama", hint: "Turning points. Keep the camera close or very far.", tags: ["dramatic", "intense", "glowing eyes", "glowing", "aura", "dark aura", "wind", "floating hair", "hair blowing", "torn clothes", "injury", "bandages", "bruise", "blood", "blood on face", "blood splatter", "nosebleed", "defeat", "on one knee", "lying on ground", "on back", "unconscious", "dying", "death", "holding person", "carrying person", "funeral", "grave", "rain", "kneeling in rain", "reaching out", "farewell", "betrayal", "standoff"] },
  { name: "Effects", hint: "Things in the air.", tags: ["explosion", "fire", "smoke", "dust cloud", "debris", "rubble", "shattered glass", "broken glass", "sparks", "lightning", "electricity", "energy", "light rays", "lens flare", "backlighting", "rim lighting", "falling petals", "falling leaves", "snow", "heavy rain", "splash"] },
  { name: "Light", hint: "Where the light comes from decides the mood.", tags: ["dramatic lighting", "cinematic lighting", "dramatic shadow", "chiaroscuro", "spotlight", "soft lighting", "sunlight", "sunset", "night", "moonlight", "neon lights", "street lamp", "fire light", "dark", "bright"] },
  { name: "Setting", hint: "Where it happens.", tags: ["city", "city street", "alley", "rooftop", "night city", "crowd", "train", "train station", "classroom", "school hallway", "office", "bar", "warehouse", "factory", "ruins", "battlefield", "forest", "mountain", "beach", "bridge", "bedroom", "kitchen", "hospital", "prison cell", "shrine", "theater", "indoors", "outdoors", "scenery", "cherry blossoms", "depth of field", "simple background", "white background", "no background"] },
  { name: "Look", hint: "Character details.", tags: ["short hair", "bob cut", "long hair", "ponytail", "twintails", "braid", "twin braids", "messy hair", "spiked hair", "black hair", "white hair", "grey hair", "brown hair", "red hair", "glasses", "red-framed eyewear", "freckles", "cigarette", "eyepatch", "scar", "scar on face", "school uniform", "suit", "necktie", "jacket", "coat", "trench coat", "hoodie", "armor", "military uniform", "gloves", "cape"] },
];

/** Tags that make the model draw manga instead of colour illustration. */
export const MANGA_LOOK_TAGS = ["monochrome", "greyscale", "manga", "lineart", "screentones", "high contrast"];
/** Added to the negative prompt with the manga look: colour, and the model drawing its own panel grid or lettering. */
export const MANGA_LOOK_NEGATIVE = "color, colorful, 3d, cgi, render, realistic, photo, airbrush, smooth shading, gradient shading, western comic, multiple views, comic panels, panel border, speech bubble, text, sound effects, signature, watermark";
/** what the Anatomy guard appends to every negative prompt: the usual hand, limb and eye failures by name */
export const ANATOMY_NEGATIVE = "bad hands, extra fingers, missing fingers, fused fingers, too many fingers, extra limbs, missing limbs, extra arms, extra legs, bad anatomy, deformed, malformed limbs, asymmetrical eyes, cross-eyed, extra eyes, bad feet, extra objects, floating objects, objects growing from body, stray limbs, disconnected limbs, mutated body";
/** words that mean the picture has a weapon in it; the weapon guard turns on when one is in the prompt or tags */
export const WEAPON_WORDS = ["gun", "handgun", "pistol", "revolver", "rifle", "shotgun", "assault rifle", "sniper rifle", "submachine gun", "machine gun", "weapon", "sword", "katana", "blade", "dagger", "knife", "spear", "axe", "bow", "staff"];
export function weaponIn(text: string): string | null {
  const tags = text.toLowerCase().split(/[,\n]+/).map((t) => t.trim().replace(/^[([]+|[)\]]+$/g, "").replace(/:\s*[+-]?[\d.]+\s*$/, "").trim());
  for (const w of WEAPON_WORDS) if (tags.some((t) => t === w || t.endsWith(" " + w) || t.startsWith(w + " ") || t.includes(" " + w + " "))) return w;
  return null;
}
/** what the weapon guard adds: how a weapon is held, and the ways a model gets one wrong (fused with the arm, floating, duplicated) */
export const weaponPositive = (w: string): string[] => {
  const gun = /gun|pistol|revolver|rifle|shotgun/.test(w);
  return [`holding ${w}`, gun ? "two-handed grip, finger on trigger, aiming down sights" : "both hands on the hilt, proper grip", `(${w} held in hands:1.1)`, "correct weapon proportions", "weapon separate from body"];
};
export const weaponNegative = (w: string): string => `${w} fused with hand, ${w} growing from arm, ${w} coming out of body, floating ${w}, extra ${w}, two ${w}s, duplicate weapon, weapon merged with body, weapon without hand, arm merged with weapon, extra arms, misplaced weapon, broken ${w}, deformed ${w}`;
/** what the Anatomy guard adds to the positive side (weighted lightly so it does not take over the subject) */
export const ANATOMY_POSITIVE = ["(correct anatomy:1.1)", "five fingers", "symmetrical eyes"];

export interface PanelRecipe { name: string; hint: string; tags: string[]; aspect: number }

/**
 * One-click starting points. Each sets the action, camera and effect tags and suggests a panel shape
 * (width / height). Character tags (Cast, Look, Emotion) already chosen are kept.
 */
export const PANEL_RECIPES: PanelRecipe[] = [
  { name: "Dialogue close-up", hint: "One speaker filling the panel.", aspect: 0.8, tags: ["close-up", "talking", "open mouth", "looking at another", "depth of field", "soft lighting"] },
  { name: "Two-shot talk", hint: "Two characters facing each other mid-conversation.", aspect: 1.5, tags: ["upper body", "conversation", "facing another", "eye contact", "talking", "from side"] },
  { name: "Reaction shot", hint: "A face reacting to what just happened.", aspect: 1, tags: ["close-up", "surprised", "wide-eyed", "sweat", "emphasis lines"] },
  { name: "Walking establishing", hint: "Opens a scene: where we are.", aspect: 1.8, tags: ["very wide shot", "walking", "from behind", "city street", "scenery", "perspective", "vanishing point"] },
  { name: "Running chase", hint: "Speed toward the reader.", aspect: 1.4, tags: ["running", "sprinting", "leaning forward", "foreshortening", "speed lines", "motion blur", "from below", "dynamic angle"] },
  { name: "Jump / leap", hint: "Airborne moment.", aspect: 0.7, tags: ["jumping", "midair", "full body", "from below", "dynamic angle", "motion lines", "wind", "floating hair"] },
  { name: "Punch impact", hint: "The hit lands.", aspect: 1.3, tags: ["punching", "incoming punch", "fist", "impact", "speed lines", "foreshortening", "clenched teeth", "dynamic angle", "debris"] },
  { name: "Flying kick", hint: "Full-body strike.", aspect: 1.5, tags: ["flying kick", "kicking", "midair", "full body", "motion lines", "afterimage", "dutch angle", "dust cloud"] },
  { name: "Sword clash", hint: "Two blades meet.", aspect: 1.6, tags: ["sword clash", "two people fighting", "holding sword", "katana", "sparks", "motion lines", "dramatic lighting", "dutch angle"] },
  { name: "Draw the blade", hint: "Quiet before the strike.", aspect: 0.6, tags: ["unsheathing", "katana", "cowboy shot", "serious", "glaring", "wind", "dramatic shadow"] },
  { name: "Gunfight", hint: "Shooting across a room or street.", aspect: 1.5, tags: ["holding gun", "handgun", "aiming", "firing", "muzzle flash", "shell casing", "behind cover", "dramatic lighting", "dutch angle"] },
  { name: "Gun to camera", hint: "The barrel pointed at the reader.", aspect: 1, tags: ["aiming at viewer", "handgun", "foreshortening", "pov", "serious", "close-up", "dramatic shadow"] },
  { name: "Sniper", hint: "Long shot through a scope.", aspect: 2, tags: ["sniper rifle", "scope", "aiming", "lying", "on stomach", "rooftop", "night", "wide shot"] },
  { name: "Disarm", hint: "Taking the weapon away.", aspect: 1.4, tags: ["disarming", "wrist grab", "twisting arm", "weapon knocked away", "two people fighting", "motion lines", "close-up", "clenched teeth"] },
  { name: "Restrain", hint: "Pinning or holding someone.", aspect: 1.4, tags: ["arm lock", "pinned down", "restrained", "grappling", "from above", "sweat"] },
  { name: "Sneak", hint: "Moving unseen.", aspect: 0.8, tags: ["sneaking", "crouching", "back against wall", "in shadow", "night", "alley", "hood up", "finger to mouth"] },
  { name: "Ambush", hint: "Attack from the dark.", aspect: 1.3, tags: ["ambush", "from behind", "holding knife", "reverse grip", "silhouette", "dark", "dramatic shadow"] },
  { name: "Dramatic reveal", hint: "A face in shadow, eyes lit.", aspect: 0.9, tags: ["close-up", "shaded face", "glowing eyes", "chiaroscuro", "high contrast", "dark aura", "wind", "hair blowing"] },
  { name: "Standoff", hint: "Two sides before the fight.", aspect: 2.2, tags: ["standoff", "very wide shot", "facing another", "wind", "dust cloud", "dramatic lighting", "from side"] },
  { name: "Defeat", hint: "After losing.", aspect: 1.2, tags: ["defeat", "on one knee", "injury", "torn clothes", "blood", "despair", "heavy rain", "from above"] },
  { name: "Death scene", hint: "A loss the story turns on.", aspect: 1.3, tags: ["holding person", "lying on ground", "unconscious", "blood", "crying", "streaming tears", "heavy rain", "from above"] },
  { name: "Explosion escape", hint: "Running from a blast.", aspect: 1.6, tags: ["running", "explosion", "debris", "fire", "smoke", "from behind", "motion blur", "shockwave"] },
  { name: "Power-up", hint: "Energy gathering.", aspect: 0.75, tags: ["aura", "glowing eyes", "energy", "electricity", "floating hair", "from below", "emphasis lines", "clenched hand"] },
];
