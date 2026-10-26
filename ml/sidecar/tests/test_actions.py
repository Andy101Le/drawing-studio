"""Run with:  python -m pytest ml/sidecar/tests  (from the repo root; needs Pillow, no torch)."""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from PIL import Image
from sidecar.actions import action_for, organize, counts, caption_of, slug

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
        Image.new("RGB", (8, 8), (i * 40, 0, 0)).save(os.path.join(liked, f"{i}.png"))  # distinct pixels: identical files would count as duplicates
        with open(os.path.join(liked, f"{i}.json"), "w") as f: json.dump({"caption": cap}, f)
        with open(os.path.join(liked, f"{i}.txt"), "w") as f: f.write(cap)
    r = organize(liked)
    assert r["moved"] == 4
    assert counts(liked) == {"misc": 1, "running": 1, "standing": 1, "sword": 1}
    assert caption_of(os.path.join(liked, "running", "0.png")) == "1boy, running"
    assert os.path.isfile(os.path.join(liked, "running", "0.txt"))
    # a second pass has nothing left to move
    assert organize(liked)["moved"] == 0

def test_organize_moves_byte_identical_copies_aside():
    d = tempfile.mkdtemp(); liked = os.path.join(d, "liked"); os.makedirs(liked)
    for i in range(3):
        Image.new("RGB", (8, 8), (10, 20, 30)).save(os.path.join(liked, f"{i}.png"))
        with open(os.path.join(liked, f"{i}.txt"), "w") as f: f.write("1boy, running")
    Image.new("RGB", (8, 8), (200, 0, 0)).save(os.path.join(liked, "other.png"))
    r = organize(liked)
    assert r["duplicates"] == 2 and r["moved"] == 2
    assert counts(liked) == {"misc": 1, "running": 1}
    assert len(os.listdir(os.path.join(d, "duplicates"))) == 4

def test_slug_is_file_safe():
    assert slug("Sword swing, rooftop!") == "sword-swing-rooftop"
    assert slug("  ") == ""
    assert slug("../../etc/passwd") == "etc-passwd"
    assert len(slug("a" * 100)) == 48
