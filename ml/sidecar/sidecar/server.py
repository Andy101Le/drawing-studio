"""
FastAPI service around diffusers. Three pipelines share one set of weights:
  text          StableDiffusionXLPipeline
  repaint       StableDiffusionXLImg2ImgPipeline (strength)
  lines         StableDiffusionXLControlNetPipeline with a lineart ControlNet, the app's ink as the control image
  reference     IP-Adapter style image on top of any of the above (optional)
Jobs run on one worker thread; progress comes from the step callback and a preview every 5 steps.
Written against diffusers 0.30 [A: not yet run on a GPU here; verify pipeline class names and
ControlNet ids on the target machine].
"""
import base64, io, json, os, threading, time, uuid, queue
from typing import Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from PIL import Image

class GenRequest(BaseModel):
    mode: str = "text"; prompt: str = ""; negative: str = ""
    width: int = 1024; height: int = 1024; steps: int = 25; guidance: float = 6.0; seed: int = 1
    strength: float = 0.6; controlWeight: float = 0.9
    control: Optional[str] = None; init: Optional[str] = None; reference: Optional[str] = None
    references: list = []                    # up to 4 reference images; IP-Adapter averages their embeddings
    qualityTags: bool = True
    # quality controls
    scheduler: str = "dpmpp_2m_karras"      # dpmpp_2m_karras | euler_a | euler | ddim
    cfgRescale: float = 0.0                  # 0..1, tames over-saturation at high guidance
    hiresFix: bool = False                   # second pass at 1.5x with low strength (capped by the profile)
    hiresStrength: float = 0.35
    controlPreprocess: str = "none"          # none | lineart_anime | scribble (for rough sketches)
    mask: Optional[str] = None               # inpaint: white = regenerate (mode "inpaint")
    referenceScale: float = 0.6              # IP-Adapter weight
    loras: list = []                         # [{"name": "...", "weight": 0.8}] from /loras
    controls: list = []                      # extra ControlNets: [{"type": "depth", "image": dataURL, "weight": 0.6}]
    freeu: bool = True                       # FreeU backbone/skip scaling: free sharpness and contrast, no extra memory
    fast: bool = False                       # LCM-LoRA preview: 6 steps, guidance 1.5, seconds instead of a minute
    detail: Optional[dict] = None            # {"faces","eyes","hands": bool, "strength", "steps"}: redo those regions at full resolution after the image (detail.py)
    negEmbeddings: bool = True               # append the trigger words of embeddings/*.safetensors|.pt (bad-hands and the like) to the negative

def _b64_to_image(data_url: str) -> Image.Image:
    raw = base64.b64decode(data_url.split(",", 1)[1] if "," in data_url else data_url)
    return Image.open(io.BytesIO(raw)).convert("RGB")
def _image_to_b64(img: Image.Image) -> str:
    buf = io.BytesIO(); img.save(buf, format="PNG"); return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()

# Model presets. Family decides the pipeline classes and the ControlNet; the quality prefix is what the
# model card recommends in front of every prompt [A: ids and tags as published at the time of writing].
PRESETS = {
    "animagine-xl-4": {"family": "sdxl", "ids": ["cagliostrolab/animagine-xl-4.0", "cagliostrolab/animagine-xl-3.1", "Linaqruf/animagine-xl-3.0"], "id": "cagliostrolab/animagine-xl-4.0", "controlnet": "TheMistoAI/MistoLine", "depth": "diffusers/controlnet-depth-sdxl-1.0", "lcm": "latent-consistency/lcm-lora-sdxl", "upscaler": "RealESRGAN_x4plus_anime_6B", "quality": "masterpiece, high score, great score, absurdres", "neg": "lowres, bad anatomy, bad hands, text, error, missing fingers, extra digit, fewer digits, cropped, worst quality, low quality, jpeg artifacts, signature, watermark, username, blurry", "native": (1024, 1024)},
    "illustrious-xl": {"family": "sdxl", "ids": ["OnomaAIResearch/Illustrious-xl-early-release-v0", "John6666/illustrious-xl-v01-sdxl"], "id": "OnomaAIResearch/Illustrious-xl-early-release-v0", "controlnet": "TheMistoAI/MistoLine", "depth": "diffusers/controlnet-depth-sdxl-1.0", "lcm": "latent-consistency/lcm-lora-sdxl", "upscaler": "RealESRGAN_x4plus_anime_6B", "quality": "masterpiece, best quality, very aesthetic, absurdres", "neg": "lowres, worst quality, bad quality, bad anatomy, bad hands, extra digits, jpeg artifacts, signature, watermark, blurry", "native": (1024, 1024)},
    # Semi-realistic and realistic SD 1.5 checkpoints for "Render style: Semi-realistic / Realistic" in the app.
    # [A: hub ids as published at the time of writing; the sidecar tries each in order]
    "dreamshaper-8-sd15": {"family": "sd15", "ids": ["Lykon/dreamshaper-8", "stable-diffusion-v1-5/stable-diffusion-v1-5"], "id": "Lykon/dreamshaper-8", "controlnet": "lllyasviel/control_v11p_sd15_lineart", "depth": "lllyasviel/control_v11f1p_sd15_depth", "lcm": "latent-consistency/lcm-lora-sdv1-5", "upscaler": "RealESRGAN_x4plus_anime_6B", "quality": "masterpiece, best quality, highly detailed", "neg": "lowres, bad anatomy, bad hands, worst quality, low quality, blurry, watermark, deformed", "native": (512, 768)},
    "realistic-vision-sd15": {"family": "sd15", "ids": ["SG161222/Realistic_Vision_V5.1_noVAE", "SG161222/Realistic_Vision_V6.0_B1_noVAE", "Lykon/dreamshaper-8"], "id": "SG161222/Realistic_Vision_V5.1_noVAE", "controlnet": "lllyasviel/control_v11p_sd15_lineart", "depth": "lllyasviel/control_v11f1p_sd15_depth", "lcm": "latent-consistency/lcm-lora-sdv1-5", "upscaler": "RealESRGAN_x4plus_anime_6B", "quality": "RAW photo, best quality, highly detailed, sharp focus", "neg": "cartoon, anime, 3d, painting, lowres, bad anatomy, bad hands, worst quality, low quality, blurry, watermark, deformed", "native": (512, 768)},
    "counterfeit-v3-sd15": {"family": "sd15", "ids": ["stablediffusionapi/counterfeit-v30", "admruul/anything-v3.0", "Lykon/dreamshaper-8", "stable-diffusion-v1-5/stable-diffusion-v1-5"], "id": "stablediffusionapi/counterfeit-v30", "controlnet": "lllyasviel/control_v11p_sd15_lineart", "depth": "lllyasviel/control_v11f1p_sd15_depth", "lcm": "latent-consistency/lcm-lora-sdv1-5", "upscaler": "RealESRGAN_x4plus_anime_6B", "quality": "masterpiece, best quality", "neg": "lowres, bad anatomy, bad hands, worst quality, low quality, blurry, watermark", "native": (512, 768)},
}
# Memory profiles. "6gb" = fp16 + model CPU offload + VAE tiling/slicing: SDXL fits a 6 GB card with ~8-10 GB of free system RAM [A: to verify]; "12gb" keeps everything resident.
PROFILES = {"6gb": {"offload": True, "max_px": 832 * 1216}, "8gb": {"offload": True, "max_px": 1024 * 1024}, "12gb": {"offload": False, "max_px": 1216 * 1216}}

def make_scheduler(name: str, config):
    from diffusers import DPMSolverMultistepScheduler, EulerAncestralDiscreteScheduler, EulerDiscreteScheduler, DDIMScheduler
    if name == "dpmpp_2m_karras": return DPMSolverMultistepScheduler.from_config(config, use_karras_sigmas=True, algorithm_type="dpmsolver++")
    if name == "euler_a": return EulerAncestralDiscreteScheduler.from_config(config)
    if name == "euler": return EulerDiscreteScheduler.from_config(config)
    if name == "ddim": return DDIMScheduler.from_config(config)
    return DPMSolverMultistepScheduler.from_config(config, use_karras_sigmas=True)

class Engine:
    def __init__(self, model: str, controlnet: str, ip_adapter: bool, offload: bool, profile: str = "6gb", lora_dir: str = "loras"):
        import torch
        self.torch = torch; self.device = "cuda" if torch.cuda.is_available() else ("mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
        dtype = torch.float16 if self.device != "cpu" else torch.float32
        self.preset = PRESETS.get(model); self.model = self.preset["id"] if self.preset else model
        self.family = self.preset["family"] if self.preset else ("sd15" if "1.5" in model or "sd15" in model else "sdxl")
        self.profile = dict(PROFILES.get(profile, PROFILES["6gb"]))
        fam = (PRESETS.get(model) or {}).get("family") or ("sd15" if ("1.5" in model or "sd15" in model or "counterfeit" in model) else "sdxl")
        if fam == "sd15":
            # ~2 GB of fp16 weights: keep them resident even on a 6 GB card. SD 1.5 was trained at
            # 512x512-ish; above ~600k px it gets slower and starts duplicating heads and limbs.
            self.profile["offload"] = False; self.profile["max_px"] = 640 * 768
        offload = offload or self.profile["offload"]
        if self.family == "sdxl":
            from diffusers import StableDiffusionXLPipeline as T2I, StableDiffusionXLImg2ImgPipeline as I2I, StableDiffusionXLControlNetPipeline as CTL, ControlNetModel
            cn_id = self.preset["controlnet"] if self.preset else "TheMistoAI/MistoLine"; cn_kw = {"variant": "fp16"} if dtype == torch.float16 else {}
        else:
            from diffusers import StableDiffusionPipeline as T2I, StableDiffusionImg2ImgPipeline as I2I, StableDiffusionControlNetPipeline as CTL, ControlNetModel
            cn_id = self.preset["controlnet"] if self.preset else "lllyasviel/control_v11p_sd15_lineart"; cn_kw = {}
        cands = list(self.preset.get("ids") or [self.preset["id"]]) if self.preset else [model]
        tried = []
        self.txt = None
        for cand in cands:
            try:
                if cand.endswith(".safetensors") or cand.startswith("http"):
                    self.txt = T2I.from_single_file(cand, torch_dtype=dtype)
                else:
                    self.txt = T2I.from_pretrained(cand, torch_dtype=dtype, use_safetensors=True)
                self.model = cand; print(f"[sidecar] loaded {cand}", flush=True); break
            except Exception as e:
                tried.append(f"{cand}: {type(e).__name__}: {str(e)[:160]}")
                print(f"[sidecar] {cand} failed ({type(e).__name__}), trying the next candidate", flush=True)
        if self.txt is None:
            raise RuntimeError("no checkpoint could be loaded. Tried:\n  " + "\n  ".join(tried) +
                               "\nPass a working one with --model <hf-id>, or a local file: --model C:\\path\\to\\model.safetensors")
        if self.family == "sd15": self.txt.safety_checker = None
        self.img2img = I2I(**self.txt.components)
        if self.family == "sdxl":
            from diffusers import StableDiffusionXLInpaintPipeline as INP
        else:
            from diffusers import StableDiffusionInpaintPipeline as INP
        self.inpaint = INP(**self.txt.components)
        self.lora_dir = lora_dir; self.loaded_loras = {}
        # ControlNet is built on first use (see lineart_pipe): keeping it resident costs ~1.4 GB that a
        # text or reference job never needs, and on a 6 GB card that is the difference between
        # running on the card and spilling into shared memory (which is ~20x slower).
        self.controlnets = ["lineart"] if controlnet == "lineart" else []
        self.ctl = None; self.cn_id = cn_id; self.want_lineart = controlnet == "lineart"
        self.cn_lineart = None; self._extra_nets = {}; self.CTL = CTL; self.ControlNetModel = ControlNetModel; self.dtype = dtype; self.cn_kw = cn_kw
        # IP-Adapter is NOT loaded here. With the adapter resident, diffusers passes
        # added_cond_kwargs=None for any job without a reference image and the UNet then does
        # ("image_embeds" not in None) -> TypeError. It is loaded on demand instead (and it also
        # frees ~1 GB of VRAM for ordinary jobs).
        self.ip = bool(ip_adapter); self.ip_loaded = False
        self.pipes = [self.txt, self.img2img, self.inpaint]
        for p in self.pipes:
            p.vae.enable_tiling(); p.vae.enable_slicing()
            try: p.enable_attention_slicing("max")   # a few % slower per step, several hundred MB less peak
            except Exception: pass
            if offload: p.enable_model_cpu_offload()
            else: p.to(self.device)
        self.base_sched_config = self.txt.scheduler.config
        self.detectors = {}
        self.embeddings = []
        try: self.load_embeddings(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "embeddings"))
        except Exception as e: print(f"[sidecar] embeddings: {e}", flush=True)
    def lineart_pipe(self):
        """Build the lineart ControlNet pipeline on first use and keep it after that."""
        if self.ctl is None and self.want_lineart:
            self.cn_lineart = self.ControlNetModel.from_pretrained(self.cn_id, torch_dtype=self.dtype, **self.cn_kw)
            self.ctl = self.CTL(**self.txt.components, controlnet=self.cn_lineart)
            self.ctl.vae.enable_tiling(); self.ctl.vae.enable_slicing()
            if self.profile["offload"]: self.ctl.enable_model_cpu_offload()
            else: self.ctl.to(self.device)
            if self.ctl not in self.pipes: self.pipes.append(self.ctl)
        return self.ctl
    def free_unused(self, keep_lineart: bool):
        """Drop the lineart ControlNet when a job does not need it, so VRAM stays under the card."""
        if not keep_lineart and self.ctl is not None:
            if self.ctl in self.pipes: self.pipes.remove(self.ctl)
            self.ctl = None; self.cn_lineart = None
            try:
                import gc; gc.collect(); self.torch.cuda.empty_cache()
            except Exception: pass
    def extra_net(self, kind: str):
        """A depth or pose ControlNet, loaded on first use and kept. [A: hub ids as published]"""
        cache = getattr(self, "_extra_nets", None)
        if cache is None: cache = self._extra_nets = {}
        if kind not in cache:
            if kind == "depth": cid = self.preset["depth"] if self.preset else ("diffusers/controlnet-depth-sdxl-1.0" if self.family == "sdxl" else "lllyasviel/control_v11f1p_sd15_depth")
            elif kind == "pose": cid = (self.preset or {}).get("pose") or ("thibaud/controlnet-openpose-sdxl-1.0" if self.family == "sdxl" else "lllyasviel/control_v11p_sd15_openpose")
            else: raise ValueError(f"unknown control {kind}")
            cache[kind] = self.ControlNetModel.from_pretrained(cid, torch_dtype=self.dtype, **(self.cn_kw if self.family == "sdxl" else {}))
        return cache[kind]
    def depth_pipe(self, with_lineart: bool, kinds=("depth",)):
        """ControlNet pipeline with [lineart?, depth?, pose?] in that order; the extra nets load on first use."""
        nets = ([self.cn_lineart] if with_lineart and self.cn_lineart is not None else []) + [self.extra_net(k) for k in kinds]
        p = self.CTL(**self.txt.components, controlnet=nets if len(nets) > 1 else nets[0])
        p.vae.enable_tiling(); p.vae.enable_slicing()
        if self.profile["offload"]: p.enable_model_cpu_offload()
        else: p.to(self.device)
        return p
    def set_fast(self, on: bool):
        """LCM-LoRA: 4-8 step previews. Loaded once as an adapter named 'lcm'; toggled with the other LoRAs."""
        if on and "lcm" not in self.loaded_loras:
            lid = self.preset["lcm"] if self.preset else ("latent-consistency/lcm-lora-sdxl" if self.family == "sdxl" else "latent-consistency/lcm-lora-sdv1-5")
            self.txt.load_lora_weights(lid, adapter_name="lcm"); self.loaded_loras["lcm"] = True
    def upscale(self, img, scale: int = 2):
        """Real-ESRGAN anime 6B (x4 model, resized to the requested scale). Loaded on first use."""
        if not hasattr(self, "_esr"):
            # basicsr 1.4.2 imports torchvision.transforms.functional_tensor, removed in torchvision 0.17+: alias it
            try:
                import torchvision.transforms.functional_tensor  # noqa
            except Exception:
                import sys, torchvision.transforms.functional as F; sys.modules["torchvision.transforms.functional_tensor"] = F
            from realesrgan import RealESRGANer
            from basicsr.archs.rrdbnet_arch import RRDBNet
            import os
            net = RRDBNet(num_in_ch=3, num_out_ch=3, num_feat=64, num_block=6, num_grow_ch=32, scale=4)
            path = os.path.join("weights", "RealESRGAN_x4plus_anime_6B.pth")
            self._esr = RealESRGANer(scale=4, model_path=path, model=net, tile=256, tile_pad=10, pre_pad=0, half=(self.device == "cuda"), device=self.device)
        import numpy as np
        out, _ = self._esr.enhance(np.array(img)[:, :, ::-1], outscale=scale)
        return Image.fromarray(out[:, :, ::-1])
    def tag(self, img, threshold: float = 0.35):
        """WD14 tagger (ONNX): Danbooru tags for a drawing, used to seed the prompt. Loaded on first use."""
        if not hasattr(self, "_tagger"):
            import onnxruntime as ort, csv
            from huggingface_hub import hf_hub_download
            repo = "SmilingWolf/wd-v1-4-moat-tagger-v2"
            self._tagger = ort.InferenceSession(hf_hub_download(repo, "model.onnx"), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
            with open(hf_hub_download(repo, "selected_tags.csv"), newline="") as f: self._tags = [(r["name"], int(r["category"])) for r in csv.DictReader(f)]
        import numpy as np
        size = self._tagger.get_inputs()[0].shape[1]
        im = img.convert("RGB"); w, h = im.size; m = max(w, h); sq = Image.new("RGB", (m, m), (255, 255, 255)); sq.paste(im, ((m - w) // 2, (m - h) // 2)); sq = sq.resize((size, size), Image.BICUBIC)
        x = np.asarray(sq, dtype=np.float32)[:, :, ::-1][None]
        probs = self._tagger.run(None, {self._tagger.get_inputs()[0].name: x})[0][0]
        out = [(n, float(p)) for (n, c), p in zip(self._tags, probs) if c == 0 and p >= threshold]
        out.sort(key=lambda t: -t[1]); return [{"tag": n.replace("_", " "), "p": round(p, 3)} for n, p in out[:40]]
    def ensure_ip(self, want: bool):
        """Attach or detach the IP-Adapter. The pipelines share one UNet, so loading once covers all of them."""
        want = bool(want and self.ip)
        if want == self.ip_loaded: return
        if want:
            sub, wname = ("sdxl_models", "ip-adapter_sdxl.bin") if self.family == "sdxl" else ("models", "ip-adapter_sd15.bin")
            # Attention slicing swaps every attention processor for SlicedAttnProcessor(slice_size).
            # load_ip_adapter rebuilds the self-attention processors by calling their class with no
            # arguments, so with slicing on it fails with "SlicedAttnProcessor.__init__() missing 1
            # required positional argument: 'slice_size'". Slicing goes off while the adapter is
            # attached (re-enabling it would also replace the adapter's own processors) and comes
            # back when it is detached.
            for p in self.pipes:
                try: p.disable_attention_slicing()
                except Exception: pass
            self.txt.load_ip_adapter("h94/IP-Adapter", subfolder=sub, weight_name=wname)
            for p in self.pipes:
                if p is not self.txt:
                    p.image_encoder = getattr(self.txt, "image_encoder", None); p.feature_extractor = getattr(self.txt, "feature_extractor", None)
        else:
            for p in self.pipes:
                try: p.unload_ip_adapter()
                except Exception: pass
            for p in self.pipes:
                try: p.enable_attention_slicing("max")
                except Exception: pass
        self.ip_loaded = want
    def list_loras(self):
        import os
        if not os.path.isdir(self.lora_dir): return []
        return sorted(f[:-12] for f in os.listdir(self.lora_dir) if f.endswith(".safetensors"))
    def lora_triggers(self):
        """name -> trigger word, from the <name>.json train_lora.py writes next to the weights."""
        import os
        out = {}
        for n in self.list_loras():
            try:
                with open(os.path.join(self.lora_dir, n + ".json"), encoding="utf-8") as f: meta = json.load(f)
                if meta.get("trigger"): out[n] = meta["trigger"]
            except Exception: pass
        return out
    def apply_loras(self, loras):
        """Load the requested adapters once, then set the active set and weights for every pipeline (shared UNet)."""
        import os
        names, weights = [], []
        for item in loras or []:
            n = item.get("name"); w = float(item.get("weight", 0.8))
            if not n: continue
            if n not in self.loaded_loras:
                path = os.path.join(self.lora_dir, n + ".safetensors")
                if not os.path.isfile(path): continue
                self.txt.load_lora_weights(path, adapter_name=n); self.loaded_loras[n] = True
            names.append(n); weights.append(w)
        for p in self.pipes:
            try:
                if names: p.set_adapters(names, adapter_weights=weights)
                else: p.disable_lora()
            except Exception: pass
    def pose_detector(self):
        """controlnet_aux OpenPose (body + hands), used by the detail pass to find faces and hands. Loaded on first use."""
        if "openpose" not in self.detectors:
            from controlnet_aux import OpenposeDetector
            self.detectors["openpose"] = OpenposeDetector.from_pretrained("lllyasviel/Annotators")
        return self.detectors["openpose"]
    def load_embeddings(self, folder: str = "embeddings"):
        """
        Textual-inversion embeddings dropped into ml/sidecar/embeddings (bad-hands-5, EasyNegative and
        the like). Each file's stem becomes its trigger token; the token list is what the app appends
        to the negative prompt. Loaded once; the text encoder is shared by every pipeline.
        """
        import os
        self.embeddings = []
        if not os.path.isdir(folder): return self.embeddings
        for f in sorted(os.listdir(folder)):
            stem, ext = os.path.splitext(f)
            if ext.lower() not in (".pt", ".safetensors", ".bin"): continue
            try:
                self.txt.load_textual_inversion(os.path.join(folder, f), token=stem)
                self.embeddings.append(stem); print(f"[sidecar] embedding {stem}", flush=True)
            except Exception as e:
                print(f"[sidecar] embedding {f} skipped: {type(e).__name__}: {str(e)[:120]}", flush=True)
        return self.embeddings
    def preprocess(self, kind: str, img):
        """controlnet-aux detectors for rough sketches; the app's own ink is clean and skips this."""
        if kind == "none": return img
        if kind not in self.detectors:
            from controlnet_aux import LineartAnimeDetector, HEDdetector
            self.detectors[kind] = LineartAnimeDetector.from_pretrained("lllyasviel/Annotators") if kind == "lineart_anime" else HEDdetector.from_pretrained("lllyasviel/Annotators")
        det = self.detectors[kind]
        return det(img, scribble=True) if kind == "scribble" else det(img)
    def vram_gb(self):
        try: return round(self.torch.cuda.get_device_properties(0).total_memory / 2**30, 1) if self.device == "cuda" else None
        except Exception: return None
    def free_vram_gb(self):
        try: f, _ = self.torch.cuda.mem_get_info(); return round(f / 2**30, 2)
        except Exception: return None
    def run(self, req: GenRequest, progress, cancelled):
        torch = self.torch; g = torch.Generator(device="cpu").manual_seed(req.seed)
        # the memory profile caps the pixel count; the request is scaled down keeping the aspect, multiples of 64
        px = req.width * req.height; cap = self.profile["max_px"]
        if px > cap:
            k = (cap / px) ** 0.5; req.width = max(64, int(req.width * k) // 64 * 64); req.height = max(64, int(req.height * k) // 64 * 64)
        prompt = req.prompt; neg = req.negative
        if req.negEmbeddings and getattr(self, "embeddings", None):
            toks = [t for t in self.embeddings if t not in (neg or "")]
            if toks: neg = f"{', '.join(toks)}, {neg}" if neg else ", ".join(toks)
        if self.preset and req.qualityTags:
            prompt = f"{self.preset['quality']}, {prompt}" if prompt else self.preset["quality"]
            neg = f"{self.preset['neg']}, {neg}" if neg else self.preset["neg"]
        common = dict(num_inference_steps=req.steps, guidance_scale=req.guidance, generator=g)
        if req.cfgRescale > 0: common["guidance_rescale"] = float(req.cfgRescale)
        for p in self.pipes:
            p.scheduler = make_scheduler(req.scheduler, self.base_sched_config)
            try:
                if req.freeu and not req.fast: p.enable_freeu(s1=0.9, s2=0.2, b1=1.3, b2=1.4) if self.family == "sdxl" else p.enable_freeu(s1=0.9, s2=0.2, b1=1.5, b2=1.6)
                else: p.disable_freeu()
            except Exception: pass
        loras = list(req.loras or [])
        if req.fast:
            self.set_fast(True); loras.append({"name": "lcm", "weight": 1.0})
            from diffusers import LCMScheduler
            for p in self.pipes: p.scheduler = LCMScheduler.from_config(self.base_sched_config)
            common["num_inference_steps"] = min(req.steps, 8); common["guidance_scale"] = min(req.guidance, 2.0)
        self.apply_loras(loras)
        # Encode the prompt ourselves (after the LoRAs are active, in case one carries text-encoder
        # weights): chunked past 77 tokens and with (tag:1.3) weights. Falls back to plain strings
        # if the encoder path fails, so an odd tokenizer never blocks a job.
        self.last_prompt_info = {}
        try:
            from .prompt import encode_prompts
            emb, self.last_prompt_info = encode_prompts(self.txt, prompt, neg, self.family)
            common.update(emb)
        except Exception as e:
            print(f"[sidecar] long-prompt encoding failed ({type(e).__name__}: {e}); using plain strings", flush=True)
            common["prompt"] = prompt; common["negative_prompt"] = neg
        extra = [c for c in (req.controls or []) if c.get("type") in ("depth", "pose") and c.get("image")]
        refs = [r for r in ([req.reference] if req.reference else []) + list(req.references or [])[:4] if r]
        self.ensure_ip(bool(refs))
        if refs and self.ip_loaded:
            imgs = [_b64_to_image(r) for r in refs]
            # one adapter, several pictures: diffusers wants them nested (a list per adapter).
            # A flat list means "one image per adapter" and raises a length mismatch.
            common["ip_adapter_image"] = [imgs] if len(imgs) > 1 else imgs[0]
            for p in self.pipes:
                try: p.set_ip_adapter_scale(float(req.referenceScale))
                except Exception: pass
        def cb(pipe, step, timestep, kw):
            if cancelled.is_set(): raise InterruptedError("cancelled")
            preview = None
            if step % 5 == 4:
                try:
                    lat = kw["latents"]; img = pipe.vae.decode(lat / pipe.vae.config.scaling_factor, return_dict=False)[0]
                    img = pipe.image_processor.postprocess(img, output_type="pil")[0]; img.thumbnail((256, 256)); preview = _image_to_b64(img)
                except Exception: preview = None
            progress(step + 1, req.steps, preview); return kw
        kw = dict(callback_on_step_end=cb, callback_on_step_end_tensor_inputs=["latents"])
        wants_lines = req.mode == "lines" and bool(req.control) and self.want_lineart
        self.free_unused(keep_lineart=wants_lines)
        if (wants_lines and self.lineart_pipe() is not None) or extra:
            ctl = None
            if req.control:
                ctl = _b64_to_image(req.control).resize((req.width, req.height))
                if req.controlPreprocess != "none": ctl = self.preprocess(req.controlPreprocess, ctl).resize((req.width, req.height))
                else:
                    # the app sends black lines on white; ControlNet lineart expects white lines on black
                    from PIL import ImageOps; ctl = ImageOps.invert(ctl)
            if extra:
                # depth from the 3D layer and/or a pose skeleton from the Pose editor, each with its own weight
                kinds = []; imgs = []; ws = []
                for c in extra:
                    if c["type"] in kinds: continue
                    kinds.append(c["type"]); imgs.append(_b64_to_image(c["image"]).resize((req.width, req.height))); ws.append(float(c.get("weight", 0.6)))
                pipe = self.depth_pipe(with_lineart=ctl is not None, kinds=tuple(kinds))
                pipe.scheduler = self.txt.scheduler
                images = ([ctl] if ctl is not None else []) + imgs; scales = ([float(req.controlWeight)] if ctl is not None else []) + ws
                out = pipe(image=images if len(images) > 1 else images[0], controlnet_conditioning_scale=scales if len(scales) > 1 else scales[0], width=req.width, height=req.height, **common, **kw)
            else:
                out = self.ctl(image=ctl, controlnet_conditioning_scale=float(req.controlWeight), width=req.width, height=req.height, **common, **kw)
        elif req.mode == "inpaint" and req.init and req.mask:
            init = _b64_to_image(req.init).resize((req.width, req.height)); mask = _b64_to_image(req.mask).convert("L").resize((req.width, req.height))
            out = self.inpaint(image=init, mask_image=mask, strength=float(req.strength), width=req.width, height=req.height, **common, **kw)
        elif req.mode == "repaint" and req.init:
            init = _b64_to_image(req.init).resize((req.width, req.height))
            out = self.img2img(image=init, strength=float(req.strength), **common, **kw)
        else:
            out = self.txt(width=req.width, height=req.height, **common, **kw)
        img = out.images[0]
        if req.hiresFix:
            # second pass: upscale 1.5x (capped by the profile) and refine with low strength; sharpens hair and eyes without changing the composition
            w2, h2 = int(req.width * 1.5) // 64 * 64, int(req.height * 1.5) // 64 * 64
            if w2 * h2 > cap: k = (cap / (w2 * h2)) ** 0.5; w2, h2 = max(64, int(w2 * k) // 64 * 64), max(64, int(h2 * k) // 64 * 64)
            if w2 > req.width:
                up = img.resize((w2, h2), Image.LANCZOS)
                common2 = dict(common); common2["num_inference_steps"] = max(10, req.steps // 2)
                def cb2(pipe, step, timestep, kw_):
                    if cancelled.is_set(): raise InterruptedError("cancelled")
                    progress(req.steps + step + 1, req.steps + common2["num_inference_steps"], None); return kw_
                img = self.img2img(image=up, strength=float(req.hiresStrength), callback_on_step_end=cb2, callback_on_step_end_tensor_inputs=["latents"], **common2).images[0]
        self.last_detail = None
        d = req.detail or {}
        if d and (d.get("faces") or d.get("eyes") or d.get("hands")) and not req.fast:
            from .detail import run_detail
            # the patch prompt carries the model's quality words and any LoRA trigger, so it matches the picture's look
            style = [self.preset["quality"]] if (self.preset and req.qualityTags) else []
            for item in (req.loras or []):
                t = self.lora_triggers().get(item.get("name", "")); 
                if t: style.append(t)
            if cancelled.is_set(): raise InterruptedError("cancelled")
            img, self.last_detail = run_detail(self, img, d, ", ".join(style), req.negative, common, progress=lambda i, n: progress(req.steps, req.steps, None))
        return img

def build_app(model: str, controlnet: str, ip_adapter: bool, offload: bool, profile: str = "6gb") -> FastAPI:
    app = FastAPI(title="OMNI-CELL ML sidecar")
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
    state = {"engine": None, "error": None}
    jobs: dict = {}; q: "queue.Queue[str]" = queue.Queue()
    def load():
        try: state["engine"] = Engine(model, controlnet, ip_adapter, offload, profile)
        except Exception as e:
            import traceback; traceback.print_exc()
            state["error"] = f"{type(e).__name__}: {e}"
    threading.Thread(target=load, daemon=True).start()
    def worker():
        while True:
            jid = q.get(); j = jobs[jid]
            if j["cancel"].is_set(): j["status"] = "cancelled"; continue
            eng = state["engine"]
            while eng is None and state["error"] is None: time.sleep(0.5); eng = state["engine"]
            if eng is None: j["status"] = "error"; j["error"] = state["error"]; continue
            j["status"] = "running"; t0 = time.time()
            def prog(step, total, preview): j["progress"] = {"step": step, "total": total, **({"preview": preview} if preview else {})}
            try:
                img = eng.run(GenRequest(**j["req"]), prog, j["cancel"])
                j["result"] = {"image": _image_to_b64(img), "seed": j["req"]["seed"], "model": eng.model, "ms": int((time.time() - t0) * 1000), "profile": profile, "vramPeakGB": (round(eng.torch.cuda.max_memory_allocated() / 2**30, 2) if eng.device == "cuda" else None), "fast": bool(j["req"].get("fast")), "detail": getattr(eng, "last_detail", None), **(getattr(eng, "last_prompt_info", None) or {})}; j["status"] = "done"
            except InterruptedError: j["status"] = "cancelled"
            except Exception as e:
                import traceback; traceback.print_exc()
                j["status"] = "error"; j["error"] = f"{type(e).__name__}: {e}"
    threading.Thread(target=worker, daemon=True).start()
    def _preset_name(cur):
        """The app's preset menu matches by preset name; the engine knows the hub id it actually loaded."""
        return next((k for k, v in PRESETS.items() if cur == k or cur in v.get("ids", [v["id"]])), cur)
    @app.get("/health")
    def health():
        eng = state["engine"]
        if state["error"]: raise HTTPException(503, state["error"])
        if eng is None: return {"model": model, "device": "loading", "controlnets": []}
        import os
        return {"model": model, "family": eng.family, "device": eng.device, "vramGB": eng.vram_gb(), "freeVramGB": eng.free_vram_gb(), "controlnets": eng.controlnets, "profile": profile, "maxPx": eng.profile["max_px"], "presets": list(PRESETS), "ipAdapter": bool(eng.ip), "ipLoaded": bool(getattr(eng, "ip_loaded", False)), "embeddings": list(getattr(eng, "embeddings", []) or []), "upscaler": os.path.isfile(os.path.join("weights", "RealESRGAN_x4plus_anime_6B.pth"))}
    @app.get("/models")
    def models():
        eng = state["engine"]
        return {"presets": [{"name": k, "family": v["family"], "id": v["id"], "ids": v.get("ids", [v["id"]]), "native": v["native"]} for k, v in PRESETS.items()], "current": _preset_name(eng.model if eng else model), "loadedId": (eng.model if eng else model)}
    @app.post("/load")
    def load_model(body: dict):
        """
        Swap the model without restarting. The current model is only freed once the machine is
        known to have room for the new one: a failed swap must never leave the sidecar with no
        model (that is what produced "Failed to fetch" in the app).
        """
        nonlocal model
        name = body.get("model"); prof = body.get("profile", profile)
        if not name: raise HTTPException(400, "model required")
        fam = (PRESETS.get(name) or {}).get("family") or ("sd15" if ("1.5" in name or "sd15" in name or "counterfeit" in name) else "sdxl")
        need_ram = 3 if fam == "sd15" else 8
        need_disk = 6 if fam == "sd15" else 15
        try:
            import psutil, shutil, os
            free_ram = psutil.virtual_memory().available / 2**30
            cache = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
            probe = cache if os.path.isdir(cache) else os.path.dirname(cache.rstrip("/\\")) or os.getcwd()
            free_disk = shutil.disk_usage(probe).free / 2**30
            short = []
            if free_ram < need_ram: short.append(f"RAM {free_ram:.1f} GiB free, needs ~{need_ram} GiB")
            if free_disk < need_disk: short.append(f"disk {free_disk:.0f} GiB free, needs ~{need_disk} GiB")
            if short:
                raise HTTPException(400, f"Not loading {name} ({fam}): " + "; ".join(short) +
                                    f". The current model ({model}) is still loaded. Close applications or free space, then try again.")
        except HTTPException: raise
        except Exception: pass  # psutil missing: fall through and attempt the load
        old = state["engine"]; state["engine"] = None; state["error"] = None
        prev_model = model
        if old is not None:
            del old
            try: import torch, gc; gc.collect(); torch.cuda.empty_cache()
            except Exception: pass
        model = name
        try:
            state["engine"] = Engine(model, controlnet, ip_adapter, offload, prof)
        except Exception as e:
            err = f"{type(e).__name__}: {e}"
            # put the previous model back so the sidecar keeps working
            try:
                model = prev_model; state["engine"] = Engine(model, controlnet, ip_adapter, offload, profile); state["error"] = None
                raise HTTPException(500, f"{name} failed to load ({err}). Restored {prev_model}.")
            except HTTPException: raise
            except Exception as e2:
                state["error"] = f"{err} (and restoring {prev_model} failed: {e2})"
                raise HTTPException(500, state["error"])
        return health()
    @app.post("/tokens")
    def tokens(body: dict):
        """CLIP token counts for a prompt, so the app can show how many 75-token chunks it spans."""
        eng = state["engine"]
        if eng is None: raise HTTPException(503, "model loading")
        from .prompt import count_tokens
        pos = body.get("prompt", "") or ""; neg = body.get("negative", "") or ""
        if eng.preset and body.get("qualityTags", True):
            pos = f"{eng.preset['quality']}, {pos}" if pos else eng.preset["quality"]
            neg = f"{eng.preset['neg']}, {neg}" if neg else eng.preset["neg"]
        return {"prompt": count_tokens(eng.txt.tokenizer, pos), "negative": count_tokens(eng.txt.tokenizer, neg), "chunk": 75}
    @app.post("/tag")
    def tag(body: dict):
        eng = state["engine"]
        if eng is None: raise HTTPException(503, "model loading")
        return {"tags": eng.tag(_b64_to_image(body["image"]), float(body.get("threshold", 0.35)))}
    @app.post("/upscale")
    def upscale(body: dict):
        eng = state["engine"]
        if eng is None: raise HTTPException(503, "model loading")
        img = eng.upscale(_b64_to_image(body["image"]), int(body.get("scale", 2)))
        return {"image": _image_to_b64(img), "width": img.width, "height": img.height}
    # ---------------------------------------------------------------- preference dataset
    # Accepted images become LoRA training data: image + caption (the prompt that made it).
    # Rejections are kept separately for review; they are NOT negative training data, since
    # ordinary LoRA training has no notion of "avoid this" (that needs preference optimisation).
    DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "dataset")
    @app.post("/dataset/add")
    def dataset_add(body: dict):
        """
        Record a verdict on a generated image. Liked images (with the prompt that made them) become
        the training set for a personal LoRA; rejected ones are the negative half for preference
        tuning later. Everything stays on this machine. (This file used to define the route twice;
        the first copy won and its .json had no caption, so training never saw the prompts.)
        """
        import json, os, time
        verdict = body.get("verdict", "liked")
        if verdict not in ("liked", "rejected"): raise HTTPException(400, "verdict must be liked or rejected")
        img = body.get("image")
        if not img: raise HTTPException(400, "image required")
        from .actions import action_for, ACTIONS, slug
        meta = dict(body.get("meta") or {})
        caption = (body.get("caption") or meta.get("prompt") or "").strip()
        # kept images file under dataset/liked/<action>/ so the set can be balanced per action;
        # the app may name the image and pick the folder, otherwise both come from the caption
        action = (body.get("action") or "").strip().lower()
        if verdict != "liked": action = ""
        elif action not in ACTIONS + ["misc"]: action = action_for(caption)
        folder = os.path.abspath(os.path.join(DATA, verdict, action)); os.makedirs(folder, exist_ok=True)
        stamp = str(int(time.time() * 1000))
        name = slug(body.get("name") or "")
        stem = f"{name}-{stamp[-6:]}" if name else stamp
        while os.path.exists(os.path.join(folder, stem + ".png")): stem += "x"
        _b64_to_image(img).save(os.path.join(folder, stem + ".png"))
        meta["verdict"] = verdict; meta["model"] = (state["engine"].model if state["engine"] else model); meta["at"] = stamp; meta["caption"] = caption; meta["action"] = action; meta["name"] = name
        with open(os.path.join(folder, stem + ".json"), "w", encoding="utf-8") as f: json.dump(meta, f, indent=1)
        with open(os.path.join(folder, stem + ".txt"), "w", encoding="utf-8") as f: f.write(caption)
        out = dataset_stats(); out["saved"] = os.path.join(verdict, action, stem + ".png").replace("\\", "/"); return out
    @app.get("/dataset/list")
    def dataset_list(limit: int = 500):
        """The kept set for review in the app: id, folder, name, caption, character and what is weak about the caption."""
        import os
        from .actions import list_items
        return {"items": list_items(os.path.join(DATA, "liked"), limit)}
    @app.get("/dataset/thumb")
    def dataset_thumb(id: str, size: int = 160):
        import os
        from fastapi.responses import Response
        from .actions import _paths_for
        try: path, _, _ = _paths_for(os.path.join(DATA, "liked"), id)
        except Exception: raise HTTPException(404, "no such image")
        im = Image.open(path).convert("RGB"); im.thumbnail((size, size)); buf = io.BytesIO(); im.save(buf, format="JPEG", quality=82)
        return Response(buf.getvalue(), media_type="image/jpeg", headers={"cache-control": "no-store"})
    @app.post("/dataset/update")
    def dataset_update(body: dict):
        """Edit a kept image's caption, folder, name or character tag."""
        import os
        from .actions import update_item
        try: return update_item(os.path.join(DATA, "liked"), body.get("id", ""), body.get("caption"), body.get("action"), body.get("name"), body.get("character"))
        except FileNotFoundError: raise HTTPException(404, "no such image")
        except ValueError as e: raise HTTPException(400, str(e))
    @app.post("/dataset/remove")
    def dataset_remove(body: dict):
        """Take an image out of the training set (moved to dataset/removed, not deleted)."""
        import os
        from .actions import remove_item
        try: return {"movedTo": remove_item(os.path.join(DATA, "liked"), body.get("id", ""))}
        except FileNotFoundError: raise HTTPException(404, "no such image")
    @app.post("/dataset/suggest")
    def dataset_suggest(body: dict):
        """Tags the WD14 tagger sees in a kept image, to fill in a weak caption."""
        import os
        eng = state["engine"]
        if eng is None: raise HTTPException(503, "model loading")
        from .actions import _paths_for
        try: path, _, _ = _paths_for(os.path.join(DATA, "liked"), body.get("id", ""))
        except Exception: raise HTTPException(404, "no such image")
        return {"tags": eng.tag(Image.open(path), float(body.get("threshold", 0.35)))}
    @app.get("/dataset/actions")
    def dataset_actions():
        """The action folders the app can offer in the Keep dialog, with the detector for a caption."""
        from .actions import ACTIONS
        return {"actions": ACTIONS + ["misc"]}
    @app.post("/dataset/guess")
    def dataset_guess(body: dict):
        from .actions import action_for
        return {"action": action_for(body.get("caption") or "")}
    @app.get("/dataset/stats")
    def dataset_stats():
        import os
        from .actions import counts, uncaptioned, ACTIONS
        out = {"path": os.path.abspath(DATA)}
        for k in ("liked", "rejected"):
            c = counts(os.path.join(DATA, k)); out[k] = sum(c.values())
            if k == "liked": out["actions"] = c; out["uncaptioned"] = uncaptioned(os.path.join(DATA, k))
        out["readyToTrain"] = out["liked"] >= 20
        # actions with fewer than 8 images are too thin to learn; the app lists them as what to add next
        have = out.get("actions", {})
        out["thin"] = [a for a in ACTIONS if have.get(a, 0) < 8]
        out["unsorted"] = have.get("unsorted", 0)
        return out
    @app.post("/dataset/organize")
    def dataset_organize():
        """Sort flat kept images into action folders by their captions (one-off after upgrading)."""
        import os
        from .actions import organize
        r = organize(os.path.join(DATA, "liked")); out = dataset_stats(); out["moved"] = r["moved"]; out["duplicates"] = r["duplicates"]; return out
    @app.get("/dataset/sample")
    def dataset_sample(n: int = 2, size: int = 384):
        """
        A few random kept images, small, for steering a job toward the artist's taste through the
        IP-Adapter. Different images each call, so steered results vary instead of converging.
        """
        import os, random
        from .actions import walk_images
        files = [p for p, _ in walk_images(os.path.join(DATA, "liked"))]
        pick = random.sample(files, min(max(0, int(n)), len(files)))
        out = []
        for f in pick:
            try:
                im = Image.open(f).convert("RGB"); im.thumbnail((size, size)); out.append(_image_to_b64(im))
            except Exception: pass
        return {"images": out, "pool": len(files)}
    @app.get("/loras")
    def loras():
        eng = state["engine"]; return {"loras": eng.list_loras() if eng else [], "triggers": eng.lora_triggers() if eng else {}}
    @app.post("/generate")
    def generate(req: GenRequest):
        jid = uuid.uuid4().hex[:12]; jobs[jid] = {"req": req.model_dump(), "status": "queued", "progress": None, "result": None, "error": None, "cancel": threading.Event()}; q.put(jid); return {"id": jid}
    @app.get("/jobs/{jid}")
    def job(jid: str):
        j = jobs.get(jid)
        if not j: raise HTTPException(404, "unknown job")
        out = {"status": j["status"]}
        if j["progress"]: out["progress"] = j["progress"]
        if j["result"]: out["result"] = j["result"]
        if j["error"]: out["error"] = j["error"]
        return out
    @app.post("/jobs/{jid}/cancel")
    def cancel(jid: str):
        j = jobs.get(jid)
        if not j: raise HTTPException(404, "unknown job")
        j["cancel"].set(); return {"ok": True}
    return app
