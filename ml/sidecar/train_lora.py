r"""Train a personal LoRA from the images you kept in the Generate tab.

    .\.venv\Scripts\python train_lora.py --name my-style
    .\.venv\Scripts\python train_lora.py --name my-style --steps 1200 --rank 16 --resolution 512

Reads dataset/liked/*.png with their .json captions, trains a LoRA on the UNet attention layers
(the text encoder is left alone: it is the cheapest configuration that still learns a look), and
writes loras/<name>.safetensors, which appears in the Generate tab's LoRA list.

Scale: 20 images is the minimum that teaches anything, 40-80 is comfortable, more than ~200 of the
same subject starts to overfit into copying. On a 6 GB card use --resolution 512 and the defaults
below; SDXL training needs more memory than this card has, so train against the SD 1.5 preset even
if you generate with SDXL later [A: SDXL LoRA on 6 GB would need 8-bit optimisers and offloading].

Rejected images are not used for this kind of training. They are kept for preference tuning
(Diffusion-DPO), which needs accepted/rejected pairs from the same prompt and is a separate script.
"""
import argparse, json, math, os, random, sys

p = argparse.ArgumentParser()
p.add_argument("--name", required=True, help="output name: loras/<name>.safetensors")
p.add_argument("--model", default="", help="base checkpoint (default: the last one the sidecar loaded, else the SD 1.5 preset)")
p.add_argument("--data", default="dataset/liked")
p.add_argument("--steps", type=int, default=0, help="training steps (one image each); 0 = about 12 passes over the set, between 300 and 1500")
p.add_argument("--rank", type=int, default=16)
p.add_argument("--lr", type=float, default=1e-4)
p.add_argument("--resolution", type=int, default=512)
p.add_argument("--batch", type=int, default=1)
p.add_argument("--accum", type=int, default=4, help="gradient accumulation: effective batch = batch * accum")
p.add_argument("--trigger", default="ohwx-style", help="word prepended to every caption; the app adds it to prompts automatically when the LoRA is on (empty to disable)")
p.add_argument("--balance", type=int, default=1, help="1: sample every action folder equally (default); 0: natural frequencies")
p.add_argument("--snr-gamma", type=float, default=5.0, help="min-SNR loss weighting (5 is the paper's value; 0 = off): steadier training, cleaner detail")
p.add_argument("--save-every", type=int, default=250, help="also write loras/<name>-s<step>.safetensors at these steps, so you can compare an earlier, lighter version against the final one")
a = p.parse_args()

import torch
from torch.utils.data import Dataset, DataLoader
from PIL import Image
from diffusers import StableDiffusionPipeline, DDPMScheduler
from diffusers.training_utils import cast_training_params
try:
    from peft import LoraConfig
    from peft.utils import get_peft_model_state_dict
except ImportError:
    raise SystemExit("peft is missing: run  .venv\\Scripts\\python -m pip install peft==0.12.0  (or reinstall requirements.txt)")
from safetensors.torch import save_file

if not a.model:
    sys.path.insert(0, ".")
    from sidecar.server import PRESETS
    a.model = ""
    _cands = list(PRESETS["counterfeit-v3-sd15"]["ids"])
else:
    _cands = [a.model]

device = "cuda" if torch.cuda.is_available() else "cpu"
dtype = torch.float16 if device == "cuda" else torch.float32
print(f"candidates: {_cands}  device: {device}  res: {a.resolution}  steps: {a.steps}  rank: {a.rank}")

pipe = None
for _c in _cands:
    try:
        if _c.endswith((".safetensors", ".ckpt")):
            pipe = StableDiffusionPipeline.from_single_file(_c, torch_dtype=dtype, safety_checker=None)
        else:
            pipe = StableDiffusionPipeline.from_pretrained(_c, torch_dtype=dtype, safety_checker=None)
        a.model = _c; print(f"loaded base: {_c}"); break
    except Exception as e:
        print(f"  {_c}: {type(e).__name__}: {str(e).splitlines()[0][:160]}")
if pipe is None: raise SystemExit("no base model could be loaded; pass --model <hub id or .safetensors path>")
unet, vae, text_encoder, tokenizer = pipe.unet, pipe.vae, pipe.text_encoder, pipe.tokenizer
noise_sched = DDPMScheduler.from_config(pipe.scheduler.config)
del pipe

vae.requires_grad_(False); text_encoder.requires_grad_(False); unet.requires_grad_(False)
vae.to(device, dtype=dtype); text_encoder.to(device, dtype=dtype); unet.to(device, dtype=dtype)
unet.add_adapter(LoraConfig(r=a.rank, lora_alpha=a.rank, init_lora_weights="gaussian",
                            target_modules=["to_k", "to_q", "to_v", "to_out.0"]))
cast_training_params(unet, dtype=torch.float32)
unet.enable_gradient_checkpointing()
try: unet.enable_xformers_memory_efficient_attention()
except Exception: pass
params = [q for q in unet.parameters() if q.requires_grad]
print(f"trainable tensors: {len(params)}")


class Pairs(Dataset):
    def __init__(self, folder, res, trigger):
        self.items = []
        exts = (".png", ".jpg", ".jpeg", ".webp", ".avif")
        import re
        def name_caption(stem):
            """A descriptive file name ("shooting at other person") is a usable caption; a hash or a date is not."""
            words = [w for w in re.split(r"[\s_\-.]+", stem) if w]
            good = [w for w in words if w.isalpha() and len(w) > 1]
            return ", ".join([" ".join(good)]) if len(good) >= 2 and len(good) >= len(words) / 2 else ""
        uncaptioned = []
        # images sit either flat in the folder or one level down in action folders (dataset/liked/running/...)
        sys.path.insert(0, ".")
        from sidecar.actions import walk_images, caption_of, action_for
        self.actions = []
        for path, action in walk_images(folder):
            f = os.path.relpath(path, folder); stem = os.path.splitext(os.path.basename(path))[0]
            cap = caption_of(path)
            if not cap: cap = name_caption(stem)
            if not cap: uncaptioned.append(f)
            try:
                with Image.open(path) as probe: probe.verify()
            except Exception:
                print(f"   skipped {f}: this Python cannot read it (convert it to .png or .jpg)"); continue
            self.items.append((path, (trigger + ", " + cap).strip(", ") if trigger else cap))
            self.actions.append(action or action_for(cap))
        if uncaptioned:
            print(f"{len(uncaptioned)} images have no caption (.json from Keep or a .txt next to them); they train on the trigger word only:")
            for f in uncaptioned: print("   ", f)
        self.res = res
        if not self.items: raise SystemExit(f"no images in {folder}: keep some results in the Generate tab first")
        per = {}
        for a in self.actions: per[a] = per.get(a, 0) + 1
        print(f"{len(self.items)} images: " + ", ".join(f"{k} {v}" for k, v in sorted(per.items(), key=lambda kv: -kv[1])))
        thin = [k for k, v in per.items() if v < 8]
        if thin: print(f"   thin actions (under 8 images, the model will barely learn them): {', '.join(thin)}")

    def weights(self, cap=3.0):
        """Sampling weight per image so every action gets an equal share of training, with no image drawn more than `cap` times its natural share."""
        per = {}
        for a in self.actions: per[a] = per.get(a, 0) + 1
        n = len(self.actions); k = len(per)
        return [min(cap, (n / k) / per[a]) for a in self.actions]

    def __len__(self): return len(self.items)

    def __getitem__(self, i):
        path, cap = self.items[i]
        im = Image.open(path).convert("RGB")
        # centre crop to square, then resize: keeps faces centred, which is what these images are
        w, h = im.size; m = min(w, h)
        im = im.crop(((w - m) // 2, (h - m) // 2, (w + m) // 2, (h + m) // 2)).resize((self.res, self.res), Image.BICUBIC)
        if random.random() < 0.5: im = im.transpose(Image.FLIP_LEFT_RIGHT)
        import numpy as np
        x = torch.from_numpy(np.asarray(im, dtype=np.uint8).copy()).permute(2, 0, 1).float() / 127.5 - 1.0
        # 10% of the time the caption is dropped, so the LoRA also works when a prompt says little
        if random.random() < 0.1: cap = ""
        ids = tokenizer(cap or "illustration", padding="max_length", truncation=True,
                        max_length=tokenizer.model_max_length, return_tensors="pt").input_ids[0]
        return x, ids


pairs = Pairs(a.data, a.resolution, a.trigger)
# balanced across action folders: a thin action is drawn as often as a fat one (capped at 3x)
from torch.utils.data import WeightedRandomSampler
sampler = WeightedRandomSampler(pairs.weights(), num_samples=len(pairs), replacement=True) if a.balance else None
loader = DataLoader(pairs, batch_size=a.batch, shuffle=sampler is None, sampler=sampler, num_workers=0, drop_last=True)
if a.steps <= 0:
    # 12 passes over the set is where style LoRAs on 40-100 images usually look right at weight 0.6-0.8;
    # more than ~25 passes starts copying whole images [A: rule of thumb, not measured on this set]
    a.steps = max(300, min(1500, 12 * len(loader.dataset)))
    print(f"steps: {a.steps} (about 12 passes over {len(loader.dataset)} images; set --steps to override)")
os.makedirs("loras", exist_ok=True)
def write_lora(path):
    state = {f"unet.{k}": v for k, v in get_peft_model_state_dict(unet).items()}
    save_file(state, path)
    with open(path[:-12] + ".json", "w", encoding="utf-8") as f:
        json.dump({"trigger": a.trigger, "steps": step, "rank": a.rank, "lr": a.lr, "resolution": a.resolution, "images": len(loader.dataset), "base": a.model, "balanced": bool(a.balance), "snrGamma": a.snr_gamma}, f, indent=1)
opt = torch.optim.AdamW(params, lr=a.lr, weight_decay=1e-2)
sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=max(1, a.steps))
scaler = torch.amp.GradScaler("cuda", enabled=(device == "cuda"))

step = 0
unet.train()
while step < a.steps:
    for x, ids in loader:
        x = x.to(device, dtype=dtype); ids = ids.to(device)
        with torch.no_grad():
            lat = vae.encode(x).latent_dist.sample() * vae.config.scaling_factor
            emb = text_encoder(ids)[0]
        noise = torch.randn_like(lat)
        t = torch.randint(0, noise_sched.config.num_train_timesteps, (lat.shape[0],), device=device).long()
        noisy = noise_sched.add_noise(lat, noise, t)
        target = noise if noise_sched.config.prediction_type == "epsilon" else noise_sched.get_velocity(lat, noise, t)
        with torch.amp.autocast("cuda", enabled=(device == "cuda")):
            pred = unet(noisy, t, encoder_hidden_states=emb).sample
            per_px = torch.nn.functional.mse_loss(pred.float(), target.float(), reduction="none").mean(dim=(1, 2, 3))
            if a.snr_gamma > 0:
                # min-SNR-gamma (Hang et al. 2023): down-weight the easy low-noise steps that otherwise dominate
                ac = noise_sched.alphas_cumprod.to(device)[t]; snr = ac / (1 - ac)
                w = torch.clamp(snr, max=a.snr_gamma) / (snr if noise_sched.config.prediction_type == "epsilon" else snr + 1)
                per_px = per_px * w
            loss = per_px.mean() / a.accum
        scaler.scale(loss).backward()
        if (step + 1) % a.accum == 0:
            scaler.unscale_(opt); torch.nn.utils.clip_grad_norm_(params, 1.0)
            scaler.step(opt); scaler.update(); opt.zero_grad(set_to_none=True); sched.step()
        step += 1
        if step % 25 == 0: print(f"step {step}/{a.steps}  loss {loss.item() * a.accum:.4f}  lr {sched.get_last_lr()[0]:.2e}", flush=True)
        if a.save_every > 0 and step % a.save_every == 0 and step < a.steps:
            cp = os.path.join("loras", f"{a.name}-s{step}.safetensors"); write_lora(cp); print(f"checkpoint {cp}", flush=True)
        if step >= a.steps: break

out = os.path.join("loras", a.name + ".safetensors")
write_lora(out)
print(f"\nwrote {out}\nPick it in the Generate tab under LoRA styles." + (f"\nUse the trigger word '{a.trigger}' in prompts." if a.trigger else "") +
      f"\nTo compare checkpoints per action:  .\\.venv\\Scripts\\python eval_lora.py --name {a.name}")
