import argparse, uvicorn
from .server import build_app

p = argparse.ArgumentParser(description="OMNI-CELL ML sidecar")
p.add_argument("--model", default="animagine-xl-4", help="preset name (animagine-xl-4, illustrious-xl, counterfeit-v3-sd15), a Hugging Face id, or a local .safetensors")
p.add_argument("--profile", default="6gb", choices=["6gb", "8gb", "12gb"], help="memory profile: offload and the pixel cap")
p.add_argument("--controlnet", default="lineart", choices=["lineart", "none"])
p.add_argument("--ip-adapter", action="store_true")
p.add_argument("--offload", action="store_true", help="CPU offload for 8 GB cards")
p.add_argument("--port", type=int, default=8790)
a = p.parse_args()
uvicorn.run(build_app(a.model, a.controlnet, a.ip_adapter, a.offload, a.profile), host="127.0.0.1", port=a.port, log_level="info")
