"""
Action folders for the training set.

A LoRA learns from captions, not from folder names, so sorting kept images into
dataset/liked/running, dataset/liked/shooting and so on does not by itself teach the model
anything new. What the folders do give you:

  * a count per action, so you can see that "sneaking" has 3 images and "standing" has 40
  * balanced sampling in train_lora.py, so the 40 do not drown out the 3
  * one evaluation image per action after training (eval_lora.py), to compare checkpoints

The folder is picked from the caption: the first action group whose tag appears wins, in the
order below (so "running, shooting" files under running). Captions with no action tag go to
"misc". Change the lists here if your tags differ; the app's tag groups use the same words.
"""
import os, re

ACTION_GROUPS = [
    ("running", ["running", "sprinting", "dashing", "chasing"]),
    ("walking", ["walking", "walking away", "strolling", "marching"]),
    ("jumping", ["jumping", "midair", "leaping", "falling", "landing", "flying"]),
    ("fighting", ["fighting", "fighting stance", "punching", "kicking", "martial arts", "battle", "grappling", "headbutt", "uppercut", "flying kick", "high kick", "spinning kick", "knee strike", "elbow strike", "blocking", "dodging", "parrying", "throwing", "incoming attack", "two people fighting"]),
    ("sword", ["sword", "katana", "slash", "slashing", "sword swing", "drawing sword", "unsheathing", "blade", "dual wielding", "spear", "naginata", "axe", "dagger", "knife"]),
    ("shooting", ["shooting", "firing", "holding gun", "gun", "handgun", "rifle", "shotgun", "sniper rifle", "assault rifle", "aiming", "muzzle flash", "reloading", "bow", "archery"]),
    ("sneaking", ["sneaking", "crouching", "hiding", "stealth", "peeking", "lurking", "tiptoe"]),
    ("talking", ["talking", "speaking", "shouting", "yelling", "screaming", "whispering", "laughing", "crying", "conversation", "open mouth"]),
    ("death", ["death", "dying", "dead", "corpse", "lying on ground", "unconscious", "collapsed", "defeat", "defeated", "injury", "injured", "wounded", "blood splatter"]),
    ("disarming", ["disarming", "disarmed", "weapon drop", "surrender", "hands up"]),
    ("sitting", ["sitting", "kneeling", "one knee", "squatting", "lying down", "sleeping"]),
    ("standing", ["standing", "idle", "arms crossed", "hands on hips", "looking at viewer", "portrait"]),
]
ACTIONS = [name for name, _ in ACTION_GROUPS]

_split = re.compile(r"[,\n]+")

def _clean(tag: str) -> str:
    # strip (tag:1.3), ((tag)), [tag] emphasis and whitespace
    t = tag.strip().lower().strip("()[] ")
    t = re.sub(r":\s*[+-]?[\d.]+\s*$", "", t)
    return t.strip("()[] ").strip()

def action_for(caption: str) -> str:
    """The folder name for a caption, 'misc' when no action tag is present."""
    tags = [_clean(t) for t in _split.split(caption or "") if t.strip()]
    tagset = set(tags)
    for name, words in ACTION_GROUPS:
        for w in words:
            if w in tagset: return name
    # fall back to substring matches for phrases like "running toward viewer"
    joined = " " + " ".join(tags) + " "
    for name, words in ACTION_GROUPS:
        for w in words:
            if f" {w} " in joined or f" {w}," in joined: return name
    return "misc"

def slug(name: str, limit: int = 48) -> str:
    """A file-safe stem from a name the user typed: lower case, words joined by hyphens, nothing else."""
    words = re.findall(r"[a-z0-9]+", (name or "").lower())
    return "-".join(words)[:limit].strip("-")

IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".avif")

def walk_images(root: str):
    """(path, action) for every image under root, one level of action folders or flat."""
    if not os.path.isdir(root): return
    for name in sorted(os.listdir(root)):
        p = os.path.join(root, name)
        if os.path.isdir(p):
            for f in sorted(os.listdir(p)):
                if os.path.splitext(f)[1].lower() in IMAGE_EXT: yield os.path.join(p, f), name
        elif os.path.splitext(name)[1].lower() in IMAGE_EXT:
            yield p, ""

def caption_of(image_path: str) -> str:
    """The caption next to an image: .json (caption or prompt), then .txt, else empty."""
    import json
    base = os.path.splitext(image_path)[0]
    try:
        with open(base + ".json", encoding="utf-8") as f: meta = json.load(f)
        cap = (meta.get("caption") or meta.get("prompt") or "").strip()
        if cap: return cap
    except Exception: pass
    try:
        with open(base + ".txt", encoding="utf-8") as f: return f.read().strip()
    except Exception: return ""

def _digest(path: str) -> str:
    import hashlib
    h = hashlib.sha1()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""): h.update(chunk)
    return h.hexdigest()

def dedupe(root: str) -> int:
    """
    Keep pressed twice on the same result writes the same picture twice; the trainer would then
    see it twice as often. Byte-identical copies (and their .json/.txt) move to <root>/../duplicates.
    Returns how many moved.
    """
    seen: dict = {}; moved = 0
    dup_dir = os.path.join(os.path.dirname(os.path.abspath(root)), "duplicates")
    for path, _ in list(walk_images(root)):
        d = _digest(path)
        if d not in seen: seen[d] = path; continue
        os.makedirs(dup_dir, exist_ok=True)
        base = os.path.splitext(path)[0]
        for ext in (os.path.splitext(path)[1], ".json", ".txt"):
            src = base + ext
            if os.path.isfile(src): os.replace(src, os.path.join(dup_dir, os.path.basename(src)))
        moved += 1
    return moved

def organize(root: str) -> dict:
    """Move flat images (and their .json/.txt) into action folders, after dropping byte-identical copies. Returns counts per folder."""
    moved = 0
    duplicates = dedupe(root)
    for path, action in list(walk_images(root)):
        if action: continue
        target = action_for(caption_of(path))
        d = os.path.join(root, target); os.makedirs(d, exist_ok=True)
        base = os.path.splitext(path)[0]
        for ext in (os.path.splitext(path)[1], ".json", ".txt"):
            src = base + ext
            if os.path.isfile(src): os.replace(src, os.path.join(d, os.path.basename(src)))
        moved += 1
    return {"moved": moved, "duplicates": duplicates, **counts(root)}

def counts(root: str) -> dict:
    """Images per action folder (flat images count under 'unsorted')."""
    out: dict = {}
    for _, action in walk_images(root):
        key = action or "unsorted"
        out[key] = out.get(key, 0) + 1
    return out

def uncaptioned(root: str) -> int:
    """Images with no caption at all: they train on the trigger word only and cannot be sorted by action."""
    return sum(1 for p, _ in walk_images(root) if not caption_of(p))

# ---------------------------------------------------------------- reviewing the set in the app

STYLE_WORDS = {"masterpiece", "best quality", "high score", "great score", "absurdres", "very aesthetic", "highly detailed", "lowres", "monochrome", "greyscale", "manga", "comic", "lineart", "screentones", "halftone", "anime screencap", "cel shading", "flat color", "clean lineart", "semi-realistic", "realistic", "photorealistic", "8k", "cinematic lighting", "depth of field", "correct anatomy", "five fingers", "symmetrical eyes"}

def caption_tags(caption: str) -> list:
    return [_clean(t) for t in _split.split(caption or "") if t.strip()]

def caption_issues(caption: str, trigger: str = "") -> list:
    """
    Why a caption is weak, as short phrases the app shows next to the image. Empty = fine.
    A caption teaches only what it says, so these are the things that make a LoRA learn nothing
    or the wrong thing: no words at all, only style words, no subject, no action, and style
    words that belong to the generator rather than to the picture.
    """
    tags = [t for t in caption_tags(caption) if t and t != trigger]
    issues = []
    if not tags: return ["no caption"]
    content = [t for t in tags if t not in STYLE_WORDS and not t.startswith("(")]
    if len(content) < 3: issues.append("fewer than 3 content tags")
    if not any(t in ("1girl", "1boy", "2girls", "2boys", "solo", "multiple girls", "multiple boys", "1other", "crowd") or t.endswith("boy") or t.endswith("girl") for t in tags): issues.append("no subject (1boy, 1girl, solo...)")
    if action_for(caption) == "misc": issues.append("no action tag")
    style = [t for t in tags if t in STYLE_WORDS]
    if len(style) > 4: issues.append(f"{len(style)} style/quality words (the picture does not show them)")
    if len(tags) > 40: issues.append("over 40 tags: the first 75 tokens matter most")
    return issues

def list_items(root: str, limit: int = 500) -> list:
    """Every kept image with its caption, folder and issues, newest first."""
    import json as _json
    items = []
    for path, action in walk_images(root):
        base = os.path.splitext(path)[0]; cap = caption_of(path)
        meta = {}
        try:
            with open(base + ".json", encoding="utf-8") as f: meta = _json.load(f)
        except Exception: pass
        rel = os.path.relpath(path, root).replace("\\", "/")
        items.append({"id": rel, "action": action or "unsorted", "name": os.path.basename(base), "caption": cap, "character": meta.get("character", ""), "issues": caption_issues(cap, meta.get("trigger", "")), "mtime": os.path.getmtime(path)})
    items.sort(key=lambda it: -it["mtime"])
    return items[:limit]

def _paths_for(root: str, rel: str):
    rel = rel.replace("\\", "/")
    if ".." in rel.split("/"): raise ValueError("bad id")
    path = os.path.join(root, *rel.split("/"))
    if not os.path.isfile(path): raise FileNotFoundError(rel)
    base = os.path.splitext(path)[0]; ext = os.path.splitext(path)[1]
    return path, base, ext

def update_item(root: str, rel: str, caption=None, action=None, name=None, character=None) -> dict:
    """Rewrite the caption (.json + .txt), move to another action folder and/or rename. Returns the new id."""
    import json as _json
    path, base, ext = _paths_for(root, rel)
    meta = {}
    try:
        with open(base + ".json", encoding="utf-8") as f: meta = _json.load(f)
    except Exception: pass
    if caption is not None: meta["caption"] = caption.strip()
    if character is not None: meta["character"] = slug(character)
    cap = meta.get("caption") or caption_of(path)
    with open(base + ".json", "w", encoding="utf-8") as f: _json.dump(meta, f, indent=1)
    with open(base + ".txt", "w", encoding="utf-8") as f: f.write(cap)
    # move / rename
    folder = os.path.dirname(path)
    if action and action in ACTIONS + ["misc"]: folder = os.path.join(root, action); os.makedirs(folder, exist_ok=True)
    stem = os.path.basename(base)
    if name:
        n = slug(name); tail = stem.rsplit("-", 1)[-1] if "-" in stem else stem
        stem = f"{n}-{tail}" if n and tail.isdigit() else (n or stem)
    target = os.path.join(folder, stem)
    if target != base:
        while os.path.exists(target + ext): target += "x"
        for e in (ext, ".json", ".txt"):
            if os.path.isfile(base + e): os.replace(base + e, target + e)
    new_rel = os.path.relpath(target + ext, root).replace("\\", "/")
    return {"id": new_rel, "caption": cap, "issues": caption_issues(cap)}

def remove_item(root: str, rel: str) -> str:
    """Move an image and its captions to <root>/../removed (nothing is deleted)."""
    path, base, ext = _paths_for(root, rel)
    dst = os.path.join(os.path.dirname(os.path.abspath(root)), "removed"); os.makedirs(dst, exist_ok=True)
    for e in (ext, ".json", ".txt"):
        if os.path.isfile(base + e): os.replace(base + e, os.path.join(dst, os.path.basename(base) + e))
    return dst

