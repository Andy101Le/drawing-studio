# OMNI-CELL ML sidecar

A small local HTTP service that runs an anime-style diffusion model on your own GPU and talks to the
app at `http://127.0.0.1:8790`. Nothing leaves the machine.

## Requirements (Windows)

- Python 3.10, 3.11 or 3.12 (3.13 lacks some wheels). Install with `winget install -e --id Python.Python.3.12`, or from python.org with "Add python.exe to PATH" ticked. If `python` opens the Microsoft Store, turn off the python entries under Settings > Apps > Advanced app settings > App execution aliases.
- NVIDIA driver with a working `nvidia-smi`.
- ~15 GiB free disk for the weights, ~8 GiB free RAM while generating.

## Start (Windows, one command)

Double-click `start.bat` in `ml\sidecar`, or in PowerShell `.\start.ps1`. It creates the venv, picks the torch CUDA wheel from your NVIDIA driver (`doctor.py --cuda-index`), installs everything, runs the preflight (`doctor.py --check`: Python, driver, VRAM, free RAM, disk) and starts with IP-Adapter on. Options: `.\start.ps1 -Model counterfeit-v3-sd15 -Profile 6gb -NoIpAdapter`.

Laptops with two GPUs (Intel + NVIDIA): CUDA uses the NVIDIA card regardless of which one drives the display; `nvidia-smi` must work in the terminal.

## Start (manual)

```
cd ml/sidecar
python -m venv .venv && . .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r requirements.txt                     # torch: pick the CUDA / ROCm / MPS build for your GPU
python -m sidecar --model dreamshaper-8-sd15 --profile 6gb --controlnet lineart   # Windows: .\start.ps1
```

Presets: `dreamshaper-8-sd15` (default: SD 1.5, semi-realistic, ~2 GB, fits a 6 GB card), `realistic-vision-sd15` (SD 1.5, photographic), `counterfeit-v3-sd15` (SD 1.5 anime), `animagine-xl-4` and `illustrious-xl` (SDXL, ~7 GB download, slower on 6 GB). Pass `-Model <name>` to start.bat, or switch under Model in the Generate tab. Profiles: `6gb` (offload, cap 832x1216), `8gb` (offload, cap 1024²), `12gb` (resident).

Flags: `--model` (preset, Hugging Face id or a local .safetensors), `--profile`, `--controlnet lineart|none`, `--port 8790`,
`--offload` (8 GB cards), `--half` (default on CUDA), `--ip-adapter` (style reference).

The first run downloads the weights (several GB). The licence of the checkpoint you choose applies
to what it produces; Animagine XL is under the Fair AI Public License 1.0-SD [A: check the model card].

## Endpoints

- `GET /health` -> `{model, device, vramGB, controlnets}`
- `POST /generate` with the app's GenRequest JSON -> `{id}`
- `GET /jobs/{id}` -> `{status, progress: {step,total,preview?}, result: {image,seed,model,ms}}`
- `POST /jobs/{id}/cancel`
- `POST /tokens` `{prompt, negative, qualityTags}` -> CLIP token counts (the app's token meter)
- `GET /loras` -> `{loras: [...], triggers: {name: word}}`

One job runs at a time; others queue. Previews are emitted every 5 steps from the latent decode.

Prompts are encoded by `sidecar/prompt.py`, not by the pipeline: longer than 75 tokens is fine
(chunked, as the WebUI does) and `(tag:1.3)` / `((tag))` / `[tag]` emphasis works. Before this,
everything past token 77 was silently dropped, which is why long tag lists lost the subject.

## On a 6 GB laptop GPU (RTX A3000, 16 GB RAM)

- Close other apps first: with CPU offload the SDXL weights (~7 GB fp16) sit in system RAM and page to the GPU per step; under ~8 GB free RAM it thrashes [A].
- Expect roughly 40–90 s per 1024² image at 25 steps with offload, and 15–30 s at 832x1216 on the SD 1.5 fallback [A: unmeasured; record the real numbers in ARCHITECTURE.md].
- The `6gb` profile caps requests at 832x1216 pixels; larger requests are scaled down keeping the aspect.
- Results carry `vramPeakGB` so the right profile can be chosen after the first run.

## If a model id 404s

Repo ids change. Each preset carries several candidates and the sidecar tries them in order,
printing which one loaded. To check before downloading:

    .\.venv\Scripts\python probe_models.py

It prints OK (usable with `--model <id>`), SINGLE-FILE (use the printed `--model https://.../file.safetensors`),
or MISSING. Any Hugging Face id or local `.safetensors` path works as `--model`.

## Extras (loaded on first use)

- `POST /tag {image}`: WD14 tagger (`SmilingWolf/wd-v1-4-moat-tagger-v2`, ONNX) returns Danbooru tags with probabilities for a drawing; the app uses it to seed the prompt.
- `POST /upscale {image, scale}`: Real-ESRGAN anime 6B; put `RealESRGAN_x4plus_anime_6B.pth` in `ml/sidecar/weights/` (download from the Real-ESRGAN releases).
- `fast: true` on a job: LCM-LoRA preview (≤8 steps, guidance ≤2), seconds instead of a minute; `freeu: true` (default) sharpens for free.
- `controls: [{type: "depth", image, weight}]`: depth ControlNet alongside lineart; the app sends the 3D layer's depth map.

## Teaching it your taste (accept / reject)

Every result in the Generate tab has **Keep** and **Discard**. Keep writes the image plus its prompt
as a caption to `dataset/liked/`, Discard to `dataset/rejected/`; `GET /dataset/stats` reports the
counts. Nothing leaves the machine.

Once you have 20 or more kept images (40-80 is comfortable):

1. Stop the sidecar (Ctrl+C in its window). Training needs the whole 6 GB card.
2. If the venv was made before `peft` was added to requirements.txt, install it once:
   `.\.venv\Scripts\python -m pip install peft==0.12.0`
3. Train:

       .\.venv\Scripts\python train_lora.py --name my-style

   Without `--model` the script tries the SD 1.5 preset's candidates in order, like the sidecar
   does, and prints why any of them failed. Pass `--model <hub id or .safetensors path>` to pin one.
   Without `--steps` it trains about 12 passes over the set (300-1500 steps) and writes checkpoints
   `my-style-s250`, `-s500`, ... next to the final file, so you can compare a lighter version. The
   trigger word (default `ohwx-style`) is saved in `my-style.json` and the app adds it to prompts
   for you when the LoRA is ticked.

It trains a LoRA on the UNet attention layers at 512 px with gradient checkpointing (fits a 6 GB
card) and writes `loras/my-style.safetensors`, which then appears under LoRA styles in the Generate
tab. It learns look, not correctness: palette, line weight, shading, face shapes. It will not fix
hands, and it learns whatever artefacts the kept images contain.

If results with the LoRA look worse than without: check that **Fast preview** is off (LCM ignores
most of it), keep its weight at 0.6-0.8 and Guidance at 5-8, and try the `-s250` / `-s500`
checkpoints; a style that comes out burnt or repetitive at the final step is usually fine earlier.

Rejected images are not used by this script. They are the negative half for preference tuning
(Diffusion-DPO), which needs accepted/rejected pairs from the same prompt and seed.
