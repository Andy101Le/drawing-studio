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
