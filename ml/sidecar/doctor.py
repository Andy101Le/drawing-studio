"""Preflight for the sidecar: prints what is wrong and what to do, before any weights download.
  python doctor.py --check        exit 1 on a blocking problem
  python doctor.py --cuda-index   prints the torch wheel index matching the NVIDIA driver
"""
import os, shutil, subprocess, sys, platform

def nvidia_driver():
    try:
        out = subprocess.check_output(["nvidia-smi", "--query-gpu=driver_version,name,memory.total,memory.free", "--format=csv,noheader"], text=True).strip().splitlines()[0]
        drv, name, total, free = [x.strip() for x in out.split(",")]
        return float(drv.split(".")[0] + "." + drv.split(".")[1]) if "." in drv else float(drv), name, int(total.split()[0]), int(free.split()[0])
    except Exception:
        return None

if "--cuda-index" in sys.argv:
    d = nvidia_driver()
    # CUDA 12.1 wheels need driver >= 528.33 (Windows); older drivers get CUDA 11.8 wheels [A: NVIDIA compatibility table]
    print("https://download.pytorch.org/whl/cu121" if d and d[0] >= 528.33 else "https://download.pytorch.org/whl/cu118" if d else "https://download.pytorch.org/whl/cpu")
    sys.exit(0)

# Requirements depend on the model family: SDXL streams ~7 GB of weights through system RAM with
# CPU offload; SD 1.5 (~2 GB fp16) sits entirely in 6 GB of VRAM, so it needs little RAM and disk.
model = "animagine-xl-4"
for i, a in enumerate(sys.argv):
    if a == "--model" and i + 1 < len(sys.argv): model = sys.argv[i + 1]
sd15 = "sd15" in model or "1.5" in model or "counterfeit" in model
need_ram_gib = 3 if sd15 else 8
need_disk_gib = 6 if sd15 else 15
problems, notes = [], []
notes.append(f"Target model: {model} ({'SD 1.5' if sd15 else 'SDXL'}): needs ~{need_disk_gib} GiB disk, ~{need_ram_gib} GiB free RAM")
v = sys.version_info
if v < (3, 10): problems.append(f"Python {v.major}.{v.minor}: use 3.10–3.12.")
elif v >= (3, 13): notes.append(f"Python {v.major}.{v.minor}: torch works; onnxruntime-gpu (tagger) may lack a wheel, install 3.12 if the tagger fails [A].")
d = nvidia_driver()
if not d: problems.append("nvidia-smi not found: NVIDIA driver missing or the sidecar is running on the Intel GPU. Install the NVIDIA driver and run again.")
else:
    drv, name, total, free = d
    notes.append(f"GPU: {name}, driver {drv}, {free}/{total} MiB free")
    if total < 5500: problems.append(f"{total} MiB VRAM: use --profile 6gb with the SD 1.5 preset (counterfeit-v3-sd15).")
    elif total < 7500: notes.append("6 GB class: profile 6gb (offload, cap 832x1216). SDXL works; expect ~1 min per image.")
try:
    import psutil
    ram = psutil.virtual_memory(); notes.append(f"RAM: {ram.available // 2**20} MiB free of {ram.total // 2**20} MiB")
    if ram.available < need_ram_gib * 2**30:
        extra = "" if sd15 else " Or start with --model counterfeit-v3-sd15 (SD 1.5): it fits in VRAM and needs ~3 GiB."
        problems.append(f"Only {ram.available // 2**30} GiB RAM free: this model needs ~{need_ram_gib} GiB free. Close other applications (browser tabs, IDEs) and retry.{extra}")
except ImportError:
    notes.append("psutil not installed yet (RAM check skipped on first run)")
cache_dir = os.environ.get("HF_HOME") or os.path.expanduser("~/.cache/huggingface")
probe = cache_dir if os.path.isdir(cache_dir) else os.path.dirname(cache_dir.rstrip("/\\")) or os.getcwd()
try: free_disk = shutil.disk_usage(probe).free // 2**30
except Exception: free_disk = shutil.disk_usage(os.getcwd()).free // 2**30
if free_disk < need_disk_gib:
    extra = "" if sd15 else " Or start with --model counterfeit-v3-sd15 (SD 1.5): ~6 GiB."
    problems.append(f"{free_disk} GiB free where the cache lives: this model needs ~{need_disk_gib} GiB. Free space, or run start.ps1 with -CacheDir D:\\hf-cache to put the weights on another drive.{extra}")
notes.append(f"Disk: {free_disk} GiB free where the cache lives ({cache_dir})")
try:
    import torch
    notes.append(f"torch {torch.__version__}, cuda available: {torch.cuda.is_available()}")
    if not torch.cuda.is_available(): problems.append("torch cannot see CUDA: the installed wheel is CPU-only or does not match the driver. Delete .venv and run start.ps1 again (it picks the wheel index from the driver).")
except ImportError:
    notes.append("torch not installed yet")
for n in notes: print("  ", n)
for p in problems: print("PROBLEM:", p)
if "--check" in sys.argv and problems:
    # a RAM shortfall is a warning, not a stop: the user may have just closed things
    hard = [p for p in problems if not p.startswith("Only")]
    sys.exit(1 if hard else 0)
