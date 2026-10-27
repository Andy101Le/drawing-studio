"""
Detail pass: find faces, eyes and hands in a finished image and redo each one at full resolution.

This is the same idea as the "ADetailer" extension people run in the WebUI, and it is the single
most effective thing short of a bigger model for the two classic failures: merged fingers and
mismatched eyes. A 512 px picture gives a hand maybe 40 px; the model cannot draw five fingers in
40 px. Cut the hand out, scale the cut-out up to 512, inpaint it with a prompt that says what a hand
is, scale it back and blend it in with a soft edge. Same for faces and for the eye strip.

Where the regions come from: controlnet_aux's OpenPose detector (body + hand + face keypoints). It
is trained on photos and finds anime bodies well enough; anime hands are hit and miss, so a hand
with no keypoints is simply left alone. There is no learned "anime face" detector here on purpose:
one less 100 MB download, and the body keypoints give the face box.

The geometry (boxes, padding, feathering) lives in pure functions so it can be unit-tested without
torch.
"""
from typing import Dict, List, Optional, Tuple

Box = Tuple[int, int, int, int]  # x0, y0, x1, y1 in image pixels

DEFAULTS = {
    "faces": True, "eyes": True, "hands": True,
    "strength": 0.42,      # inpaint strength: 0.3 keeps the picture, 0.6 redraws the part
    "steps": 22,
    "pad": 0.35,           # box grows by this share of its size on every side
    "minSide": 24,         # ignore regions smaller than this (px) in the source
    "work": 512,           # crop is scaled to this before inpainting
    "feather": 0.12,       # soft edge as a share of the crop size
    "weapon": None,        # weapon word from the prompt: hand patches widen to 0.6 and ask for a grip on it
}

PROMPTS = {
    "face": ("detailed face, clean lineart, symmetrical eyes, correct anatomy", "deformed face, asymmetrical eyes, extra eyes, blurry, lowres"),
    "eyes": ("detailed eyes, symmetrical eyes, sharp pupils, clean eyelashes, matching iris colour", "asymmetrical eyes, crossed eyes, extra pupils, blurry eyes, different eye sizes"),
    "hand": ("detailed hand, five fingers, correct finger count, natural knuckles, clean lineart", "extra fingers, missing fingers, fused fingers, six fingers, four fingers, malformed hand, extra hand, blurry"),
}

def clamp_box(b: Box, w: int, h: int) -> Box:
    x0, y0, x1, y1 = b
    return (max(0, min(w, x0)), max(0, min(h, y0)), max(0, min(w, x1)), max(0, min(h, y1)))

def pad_box(b: Box, pad: float, w: int, h: int, square: bool = True) -> Box:
    """Grow a box by `pad` of its size on each side, make it square around its centre, keep it in the image."""
    x0, y0, x1, y1 = b; bw, bh = x1 - x0, y1 - y0
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    side = max(bw, bh) * (1 + 2 * pad) if square else None
    if square: nx0, ny0, nx1, ny1 = cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2
    else: nx0, ny0, nx1, ny1 = x0 - bw * pad, y0 - bh * pad, x1 + bw * pad, y1 + bh * pad
    return clamp_box((int(round(nx0)), int(round(ny0)), int(round(nx1)), int(round(ny1))), w, h)

def merge_overlapping(boxes: List[Box]) -> List[Box]:
    """Union boxes that overlap, so two hands held together are redone once (no seam between them)."""
    out = [list(b) for b in boxes]
    changed = True
    while changed:
        changed = False
        for i in range(len(out)):
            for j in range(i + 1, len(out)):
                a, b = out[i], out[j]
                if a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]:
                    out[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]; del out[j]; changed = True; break
            if changed: break
    return [tuple(b) for b in out]  # type: ignore

def box_from_points(pts: List[Tuple[float, float]], w: int, h: int) -> Optional[Box]:
    pts = [(x, y) for x, y in pts if x is not None and y is not None and 0 <= x <= 1 and 0 <= y <= 1]
    if len(pts) < 2: return None
    xs = [x * w for x, _ in pts]; ys = [y * h for _, y in pts]
    return (int(min(xs)), int(min(ys)), int(max(xs)) + 1, int(max(ys)) + 1)

def regions_from_pose(poses, w: int, h: int, want: Dict[str, bool], min_side: int) -> List[Tuple[str, Box]]:
    """
    Regions from controlnet_aux PoseResult objects (body.keypoints with x, y in 0..1, left_hand,
    right_hand, face as keypoint lists). Faces: the five head keypoints (nose, eyes, ears) widened
    down to the chin. Eyes: a strip across both eye keypoints. Hands: the 21 hand keypoints.
    """
    out: List[Tuple[str, Box]] = []
    for pose in poses or []:
        body = getattr(pose, "body", None); kps = list(getattr(body, "keypoints", []) or []) if body else []
        def kp(i):
            k = kps[i] if i < len(kps) else None
            return (k.x, k.y) if k is not None and getattr(k, "score", 1) and k.score > 0.2 else None
        head = [kp(i) for i in (0, 14, 15, 16, 17)]; head = [p for p in head if p]
        if want.get("faces") and len(head) >= 3:
            b = box_from_points(head, w, h)
            if b:
                x0, y0, x1, y1 = b; hw = x1 - x0
                # eyes and ears sit in the upper half of a head: extend down by 1.3x the eye-span for the chin
                b = (x0, y0 - int(hw * 0.5), x1, y1 + int(hw * 1.3))
                if min(b[2] - b[0], b[3] - b[1]) >= min_side: out.append(("face", clamp_box(b, w, h)))
        eyes = [p for p in (kp(14), kp(15)) if p]
        if want.get("eyes") and len(eyes) == 2:
            b = box_from_points(eyes, w, h)
            if b:
                x0, y0, x1, y1 = b; span = max(8, x1 - x0)
                b = (x0 - span // 2, y0 - span // 2, x1 + span // 2, y1 + span // 2)
                if min(b[2] - b[0], b[3] - b[1]) >= min_side: out.append(("eyes", clamp_box(b, w, h)))
        if want.get("hands"):
            for hand in (getattr(pose, "left_hand", None), getattr(pose, "right_hand", None)):
                pts = [(k.x, k.y) for k in (hand or []) if k is not None and getattr(k, "score", 1) > 0.2]
                if len(pts) >= 6:
                    b = box_from_points(pts, w, h)
                    if b and min(b[2] - b[0], b[3] - b[1]) >= min_side: out.append(("hand", b))
    return out

def feather_mask(size: int, feather: float):
    """A square mask, 255 in the middle, ramping to 0 over `feather` of the side at every edge (PIL 'L')."""
    from PIL import Image, ImageFilter
    m = Image.new("L", (size, size), 0)
    f = max(1, int(size * feather))
    inner = Image.new("L", (size - 2 * f, size - 2 * f), 255)
    m.paste(inner, (f, f))
    return m.filter(ImageFilter.GaussianBlur(f / 2))

def run_detail(engine, img, opts: dict, prompt_extra: str, negative_extra: str, common: dict, progress=None):
    """
    Redo the detected regions on `img` (PIL) in place of the originals. Returns (image, report).
    `common` carries the scheduler/guidance kwargs the main job used; the prompt per region replaces
    the job's prompt, with the job's style words appended so the patch matches the picture.
    """
    from PIL import Image
    o = {**DEFAULTS, **(opts or {})}
    w, h = img.size
    report = {"regions": [], "skipped": 0}
    try:
        det = engine.pose_detector()
        poses = det.detect_poses(img, include_hand=True, include_face=False) if hasattr(det, "detect_poses") else []
    except Exception as e:
        report["error"] = f"detector: {type(e).__name__}: {e}"; return img, report
    regions = regions_from_pose(poses, w, h, {"faces": o["faces"], "eyes": o["eyes"], "hands": o["hands"]}, int(o["minSide"]))
    # eyes inside a face box: do the face first, then the eyes on top (order: face, hand, eyes)
    order = {"face": 0, "hand": 1, "eyes": 2}
    regions.sort(key=lambda r: order[r[0]])
    hands = merge_overlapping([b for k, b in regions if k == "hand"])
    todo = [(k, b) for k, b in regions if k != "hand"] + [("hand", b) for b in hands]
    out = img.convert("RGB")
    weapon = o.get("weapon")
    for i, (kind, raw) in enumerate(todo):
        # a hand holding a weapon is redone together with the weapon: a hand patch that stops at the
        # knuckles cannot fix a grip, and a gun drawn without the hand grows out of the wrist
        pad = max(float(o["pad"]), 0.6) if (kind == "hand" and weapon) else float(o["pad"])
        box = pad_box(raw, pad, w, h, square=True)
        x0, y0, x1, y1 = box; side = min(x1 - x0, y1 - y0)
        if side < int(o["minSide"]): report["skipped"] += 1; continue
        x1, y1 = x0 + side, y0 + side
        crop = out.crop((x0, y0, x1, y1)); work = int(o["work"])
        up = crop.resize((work, work), Image.LANCZOS)
        mask = feather_mask(work, float(o["feather"]))
        pos, neg = PROMPTS[kind]
        if kind == "hand" and weapon:
            pos = f"hand gripping a {weapon}, fingers wrapped around the grip, five fingers, correct grip, {weapon} held naturally, clean lineart"
            neg = f"{neg}, {weapon} fused with hand, {weapon} growing from arm, floating {weapon}, extra {weapon}, weapon merged with body"
        p = f"{pos}, {prompt_extra}" if prompt_extra else pos
        n = f"{neg}, {negative_extra}" if negative_extra else neg
        try:
            from .prompt import encode_prompts
            emb, _ = encode_prompts(engine.txt, p, n, engine.family)
            kw = {k: v for k, v in common.items() if k not in ("prompt", "negative_prompt", "prompt_embeds", "negative_prompt_embeds", "pooled_prompt_embeds", "negative_pooled_prompt_embeds", "num_inference_steps")}
            kw.update(emb)
        except Exception:
            kw = {k: v for k, v in common.items() if k not in ("prompt", "negative_prompt", "num_inference_steps")}; kw["prompt"] = p; kw["negative_prompt"] = n
        res = engine.inpaint(image=up, mask_image=mask, strength=float(o["strength"]), num_inference_steps=int(o["steps"]), width=work, height=work, **kw).images[0]
        back = res.resize((side, side), Image.LANCZOS)
        soft = feather_mask(side, float(o["feather"]))
        out.paste(back, (x0, y0), soft)
        report["regions"].append({"kind": kind, "box": [x0, y0, x1, y1]})
        if progress: progress(i + 1, len(todo))
    return out, report
