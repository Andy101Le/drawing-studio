r"""Compare LoRA checkpoints action by action.

    .\.venv\Scripts\python eval_lora.py --name my-style
    .\.venv\Scripts\python eval_lora.py --name my-style --weights 0.5,0.7,0.9

For every action folder in the training set (running, shooting, sword, ...) it renders one
image with a fixed prompt and seed: once with no LoRA, then once per checkpoint
(my-style-s250, my-style-s500, ..., my-style) at each weight. The rows are actions, the
columns are checkpoints, and the sheet lands in loras/my-style-eval.png. Pick the column that
looks right across most rows; if an early column already looks good and the last one looks
burnt, train fewer steps next time.

Stop the sidecar first on a 6 GB card. Each image takes the usual few seconds, so a set of
12 actions times 5 checkpoints is about a minute per weight.
"""
import argparse, json, os, sys
p = argparse.ArgumentParser()
p.add_argument("--name", required=True)
p.add_argument("--model", default="", help="base checkpoint; default: the one recorded in loras/<name>.json")
p.add_argument("--weights", default="0.7", help="comma-separated LoRA weights to try")
p.add_argument("--steps", type=int, default=24)
p.add_argument("--guidance", type=float, default=7.0)
p.add_argument("--size", type=int, default=512)
p.add_argument("--seed", type=int, default=1234)
p.add_argument("--actions", default="", help="comma-separated subset; default: the action folders in dataset/liked")
a = p.parse_args()

import torch
from PIL import Image, ImageDraw
from diffusers import StableDiffusionPipeline, DPMSolverMultistepScheduler
sys.path.insert(0, ".")
from sidecar.actions import ACTIONS, counts

PROMPTS = {
    "running": "1boy, running, full body, dynamic angle, motion blur, city street",
    "walking": "1girl, walking, full body, from side, street at dusk",
    "jumping": "1boy, jumping, midair, from below, rooftops, action lines",
    "fighting": "two people fighting, punching, dynamic angle, action lines, dojo",
    "sword": "1girl, katana, sword swing, slash, speed lines, bamboo forest",
    "shooting": "1boy, holding gun, aiming, rifle, muzzle flash, rain, night",
    "sneaking": "1girl, sneaking, crouching, dark alley, shadow, from above",
    "talking": "1boy, talking, open mouth, upper body, cafe, soft light",
    "death": "1boy, lying, collapsed, defeated, dramatic lighting, battlefield",
    "disarming": "two people, disarming, weapon drop, close-up on hands, tense",
    "sitting": "1girl, sitting, kneeling, window light, bedroom",
    "standing": "1boy, standing, arms crossed, looking at viewer, full body",
    "misc": "1girl, portrait, looking at viewer, soft light",
}

meta_path = os.path.join("loras", a.name + ".json")
meta = json.load(open(meta_path, encoding="utf-8")) if os.path.isfile(meta_path) else {}
base = a.model or meta.get("base") or "Lykon/dreamshaper-8"
trigger = meta.get("trigger", "")
device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32
print(f"base {base}  trigger '{trigger}'  device {device}")
if base.endswith((".safetensors", ".ckpt")): pipe = StableDiffusionPipeline.from_single_file(base, torch_dtype=dtype, safety_checker=None)
else: pipe = StableDiffusionPipeline.from_pretrained(base, torch_dtype=dtype, safety_checker=None)
pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True, algorithm_type="dpmsolver++")
pipe.to(device)
if device == "cuda": pipe.enable_attention_slicing("max"); pipe.vae.enable_tiling()

have = counts(os.path.join("dataset", "liked"))
actions = [x.strip() for x in a.actions.split(",") if x.strip()] or [x for x in ACTIONS + ["misc"] if have.get(x, 0) > 0] or ["standing", "running", "fighting"]
names = [f[:-12] for f in os.listdir("loras") if f.endswith(".safetensors")]
def step_of(n):
    tail = n.rsplit("-s", 1)
    return int(tail[1]) if len(tail) == 2 and tail[0] == a.name and tail[1].isdigit() else None
cands = sorted((n for n in names if step_of(n) is not None), key=step_of) + ([a.name] if a.name in names else [])
if not cands: raise SystemExit(f"no loras/{a.name}*.safetensors found")
weights = [float(w) for w in a.weights.split(",")]
print(f"actions: {actions}\ncheckpoints: {cands}\nweights: {weights}")

def render(prompt, seed):
    g = torch.Generator(device="cpu").manual_seed(seed)
    return pipe(prompt, negative_prompt="lowres, bad anatomy, bad hands, worst quality, low quality, blurry, watermark", num_inference_steps=a.steps, guidance_scale=a.guidance, width=a.size, height=a.size, generator=g).images[0]

cols = [("no LoRA", None, 0.0)] + [(f"{c}@{w}", c, w) for w in weights for c in cands]
cell = 256; pad = 4; label_h = 18
sheet = Image.new("RGB", (120 + len(cols) * (cell + pad), label_h + len(actions) * (cell + pad)), "white")
draw = ImageDraw.Draw(sheet)
for ci, (label, _, _) in enumerate(cols): draw.text((120 + ci * (cell + pad), 2), label, fill="black")
for ri, act in enumerate(actions):
    draw.text((4, label_h + ri * (cell + pad) + 4), f"{act} ({have.get(act, 0)})", fill="black")
    prompt = PROMPTS.get(act, f"1boy, {act}, full body")
    for ci, (label, ck, w) in enumerate(cols):
        try:
            if ck is None: pipe.unload_lora_weights()
            else:
                pipe.unload_lora_weights(); pipe.load_lora_weights(os.path.join("loras", ck + ".safetensors"), adapter_name="eval"); pipe.set_adapters(["eval"], adapter_weights=[w])
            full = (trigger + ", " + prompt) if (ck is not None and trigger) else prompt
            im = render(full, a.seed + ri).resize((cell, cell), Image.LANCZOS)
        except Exception as e:
            im = Image.new("RGB", (cell, cell), "#ddd"); ImageDraw.Draw(im).text((6, 6), f"{type(e).__name__}", fill="red"); print(f"  {act} / {label}: {e}")
        sheet.paste(im, (120 + ci * (cell + pad), label_h + ri * (cell + pad)))
        print(f"  {act} / {label}")
out = os.path.join("loras", a.name + "-eval.png"); sheet.save(out)
print(f"\nwrote {out}")
