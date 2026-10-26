"""Contract stub: the same HTTP surface as the real sidecar with a placeholder image, no model. Used by tests and by anyone wiring the app without a GPU."""
import io, json, base64, struct, zlib, threading, time, uuid, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def png(w, h, seed):
    rows = b"".join(b"\x00" + bytes(((x * 7 + y * 3 + seed) & 255, (x ^ y) & 255, (x + y + seed * 13) & 255, 255) for x in range(w)) for y in range(h)) if False else None
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w): raw += bytes(((x * 255) // w, (y * 255) // h, (seed * 37) & 255, 255))
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(raw))) + chunk(b"IEND", b"")

jobs = {}
def stats():
    acts = {"standing": max(0, LIKED[0] - 7), "running": 4, "shooting": 3}
    return {"path": "C:\\omni-cell\\ml\\sidecar\\dataset", "liked": LIKED[0], "rejected": LIKED[1], "readyToTrain": LIKED[0] >= 20, "actions": acts, "thin": ["walking", "jumping", "fighting", "sword", "sneaking", "talking", "death", "disarming", "sitting"], "unsorted": 0}
LIKED = [3, 1]
class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode(); self.send_response(code)
        self.send_header("content-type", "application/json"); self.send_header("access-control-allow-origin", "*"); self.send_header("access-control-allow-headers", "content-type"); self.send_header("access-control-allow-methods", "GET,POST,OPTIONS"); self.send_header("content-length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_OPTIONS(self): self._send(200, {})
    def do_GET(self):
        if self.path == "/health": return self._send(200, {"model": "stub-placeholder", "family": "sdxl", "device": "cpu", "vramGB": 6, "freeVramGB": 5.2, "controlnets": ["lineart"], "profile": "6gb", "maxPx": 832 * 1216, "presets": ["animagine-xl-4", "illustrious-xl", "dreamshaper-8-sd15", "realistic-vision-sd15", "counterfeit-v3-sd15"], "embeddings": ["bad-hands-5"]})
        if self.path == "/models": return self._send(200, {"presets": [{"name": "animagine-xl-4", "family": "sdxl"}, {"name": "illustrious-xl", "family": "sdxl"}, {"name": "dreamshaper-8-sd15", "family": "sd15"}, {"name": "realistic-vision-sd15", "family": "sd15"}, {"name": "counterfeit-v3-sd15", "family": "sd15"}], "current": "animagine-xl-4"})
        if self.path == "/loras": return self._send(200, {"loras": ["studio-house-style", "thick-ink"], "triggers": {"studio-house-style": "ohwx-style"}})
        if self.path.startswith("/dataset/sample"):
            out = ["data:image/png;base64," + __import__("base64").b64encode(png(64, 64, k)).decode() for k in (3, 4)]
            return self._send(200, {"images": out, "pool": LIKED[0]})
        if self.path == "/dataset/stats": return self._send(200, stats())
        if self.path.startswith("/dataset/list"):
            items = [{"id": f"running/trooper-run-{i}.png", "action": "running", "name": f"trooper-run-{i}", "caption": "ohwx-style, 1boy, running, rain" if i % 2 else "masterpiece, best quality, absurdres", "character": "kai" if i == 1 else "", "issues": [] if i % 2 else ["fewer than 3 content tags", "no subject (1boy, 1girl, solo...)", "no action tag"], "mtime": 1000 - i} for i in range(4)]
            return self._send(200, {"items": items})
        if self.path.startswith("/dataset/thumb"):
            data = png(64, 64, 7); self.send_response(200); self.send_header("content-type", "image/png"); self.send_header("access-control-allow-origin", "*"); self.end_headers(); self.wfile.write(data); return
        if self.path == "/dataset/actions": return self._send(200, {"actions": ["running", "walking", "jumping", "fighting", "sword", "shooting", "sneaking", "talking", "death", "disarming", "sitting", "standing", "misc"]})
        if self.path.startswith("/jobs/"):
            j = jobs.get(self.path.split("/")[2])
            if not j: return self._send(404, {"error": "unknown job"})
            el = time.time() - j["t0"]; total = j["req"]["steps"]; step = min(total, int(el * 20))
            if j["cancel"]: return self._send(200, {"status": "cancelled"})
            if step < total: return self._send(200, {"status": "running", "progress": {"step": step, "total": total}})
            img = "data:image/png;base64," + base64.b64encode(png(min(256, j["req"]["width"]), min(256, j["req"]["height"]), j["req"]["seed"])).decode()
            words = lambda t: int(len((t or "").replace(",", " ").split()) * 1.3)
            return self._send(200, {"status": "done", "result": {"image": img, "seed": j["req"]["seed"], "model": "stub-placeholder", "ms": int(el * 1000), "fast": bool(j["req"].get("fast")), "promptTokens": words(j["req"].get("prompt")), "negativeTokens": words(j["req"].get("negative")), "chunks": 1 + words(j["req"].get("prompt")) // 75, "detail": ({"regions": [{"kind": "face", "box": [10, 10, 60, 60]}, {"kind": "hand", "box": [80, 120, 110, 150]}], "skipped": 0} if j["req"].get("detail") and not j["req"].get("fast") else None)}})
        self._send(404, {"error": "not found"})
    def do_POST(self):
        n = int(self.headers.get("content-length", 0)); body = json.loads(self.rfile.read(n) or b"{}")
        if self.path == "/load": return self._send(200, {"model": body.get("model"), "device": "cpu"})
        if self.path == "/dataset/add":
            if body.get("verdict") == "liked": LIKED[0] += 1
            else: LIKED[1] += 1
            out = stats(); out["saved"] = f"{body.get('verdict')}/{body.get('action') or 'standing'}/{body.get('name') or '1792'}-123456.png"; return self._send(200, out)
        if self.path == "/dataset/update": return self._send(200, {"id": body.get("id"), "caption": body.get("caption", ""), "issues": []})
        if self.path == "/dataset/remove": return self._send(200, {"movedTo": "C:\\omni-cell\\ml\\sidecar\\dataset\\removed"})
        if self.path == "/dataset/suggest": return self._send(200, {"tags": [{"tag": "1boy", "p": 0.95}, {"tag": "armor", "p": 0.9}, {"tag": "helmet", "p": 0.8}, {"tag": "rain", "p": 0.6}, {"tag": "holding gun", "p": 0.55}]})
        if self.path == "/dataset/guess":
            cap = (body.get("caption") or "").lower(); return self._send(200, {"action": "running" if "running" in cap else "sword" if "sword" in cap or "katana" in cap else "misc"})
        if self.path == "/dataset/organize": return self._send(200, stats())
        if self.path == "/tokens":
            words = lambda t: int(len((t or "").replace(",", " ").split()) * 1.3)
            return self._send(200, {"prompt": words(body.get("prompt")) + 4, "negative": words(body.get("negative")) + 12, "chunk": 75})
        if self.path == "/tag": return self._send(200, {"tags": [{"tag": "1girl", "p": 0.93}, {"tag": "short hair", "p": 0.81}, {"tag": "glasses", "p": 0.66}, {"tag": "monochrome", "p": 0.4}]})
        if self.path == "/lineart":
            # a stand-in for the anime lineart detector: edges of the picture itself (PIL), white on black,
            # so the Redraw path behaves like it would with the real model
            try:
                from PIL import Image, ImageFilter, ImageOps
                raw = base64.b64decode(body["image"].split(",", 1)[1]); im = Image.open(io.BytesIO(raw)).convert("L")
                e = ImageOps.autocontrast(im.filter(ImageFilter.FIND_EDGES)).filter(ImageFilter.MaxFilter(3))
                buf = io.BytesIO(); e.convert("RGB").save(buf, format="PNG")
                return self._send(200, {"image": "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode(), "width": im.width, "height": im.height})
            except Exception as ex:
                return self._send(500, {"error": str(ex)})
        if self.path == "/upscale":
            sc = int(body.get("scale", 2)); img = "data:image/png;base64," + base64.b64encode(png(128 * sc, 128 * sc, 5)).decode(); return self._send(200, {"image": img, "width": 128 * sc, "height": 128 * sc})
        if self.path == "/generate":
            jid = uuid.uuid4().hex[:12]; jobs[jid] = {"req": body, "t0": time.time(), "cancel": False}; return self._send(200, {"id": jid})
        if self.path.startswith("/jobs/") and self.path.endswith("/cancel"):
            j = jobs.get(self.path.split("/")[2]);
            if j: j["cancel"] = True
            return self._send(200, {"ok": True})
        self._send(404, {"error": "not found"})
    def log_message(self, *a): pass
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8790
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
