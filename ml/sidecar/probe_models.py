r"""Check which checkpoint ids are actually loadable before downloading gigabytes.

    .\.venv\Scripts\python probe_models.py              all presets
    .\.venv\Scripts\python probe_models.py some/repo-id one id

Prints OK (diffusers layout, usable with --model), SINGLE-FILE (needs a direct .safetensors URL),
or MISSING. Repo ids move and get renamed, so this is the quick way to find a working one.
"""
import sys
try:
    from huggingface_hub import HfApi
except ImportError:
    print("Run this with the venv's python: .\\.venv\\Scripts\\python probe_models.py"); sys.exit(1)

def candidates():
    sys.path.insert(0, ".")
    from sidecar.server import PRESETS
    for name, p in PRESETS.items():
        for cid in p.get("ids", [p["id"]]):
            yield name, cid

api = HfApi()
ids = [(None, a) for a in sys.argv[1:]] or list(candidates())
for preset, rid in ids:
    label = f"{preset or '-':<20} {rid:<58}"
    try:
        files = {s.rfilename for s in api.model_info(rid, files_metadata=False).siblings}
    except Exception as e:
        print(f"{label} MISSING   ({type(e).__name__})"); continue
    if "model_index.json" in files:
        print(f"{label} OK")
    else:
        safes = sorted(f for f in files if f.endswith(".safetensors"))
        if safes: print(f"{label} SINGLE-FILE  --model https://huggingface.co/{rid}/resolve/main/{safes[0]}")
        else: print(f"{label} NO WEIGHTS")
