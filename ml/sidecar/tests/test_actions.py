"""Run with:  python -m pytest ml/sidecar/tests  (from the repo root; needs Pillow, no torch)."""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image
from sidecar.actions import action_for, organize, counts, caption_of

def test_action_from_caption_order_and_emphasis():
    assert action_for("masterpiece, 1boy, (running:1.2), shooting, rain") == "running"
    assert action_for("((sneaking)), dark alley") == "sneaking"
    assert action_for("1girl, katana, sword swing") == "sword"
    assert action_for("portrait, looking at viewer") == "standing"
    assert action_for("cyber city at night") == "misc"
    assert action_for("") == "misc"

def test_organize_moves_files_with_their_captions():
    d = tempfile.mkdtemp(); liked = os.path.join(d, "liked"); os.makedirs(liked)
    caps = ["1boy, running", "1girl, slashing", "portrait", "a street"]
    for i, cap in enumerate(caps):
        Image.new("RGB", (8, 8)).save(os.path.join(liked, f"{i}.png"))
        with open(os.path.join(liked, f"{i}.json"), "w") as f: json.dump({"caption": cap}, f)
        with open(os.path.join(liked, f"{i}.txt"), "w") as f: f.write(cap)
    r = organize(liked)
    assert r["moved"] == 4
    assert counts(liked) == {"misc": 1, "running": 1, "standing": 1, "sword": 1}
    assert caption_of(os.path.join(liked, "running", "0.png")) == "1boy, running"
    assert os.path.isfile(os.path.join(liked, "running", "0.txt"))
    # a second pass has nothing left to move
    assert organize(liked)["moved"] == 0
