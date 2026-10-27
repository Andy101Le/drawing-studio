import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from sidecar.detail import pad_box, merge_overlapping, regions_from_pose, feather_mask, box_from_points

class K:
    def __init__(self, x, y, score=0.9): self.x, self.y, self.score = x, y, score
class Body:
    def __init__(self, kps): self.keypoints = kps
class Pose:
    def __init__(self, body, lh=None, rh=None): self.body, self.left_hand, self.right_hand = body, lh, rh

def test_pad_box_is_square_and_clamped():
    assert pad_box((10, 10, 30, 20), 0.5, 100, 100) == (0, 0, 40, 35)
    b = pad_box((90, 90, 100, 100), 0.5, 100, 100); assert b[2] <= 100 and b[3] <= 100

def test_merge_overlapping_unions_touching_hands():
    assert merge_overlapping([(0, 0, 10, 10), (5, 5, 20, 20), (50, 50, 60, 60)]) == [(0, 0, 20, 20), (50, 50, 60, 60)]

def test_regions_from_pose_face_eyes_hands():
    kps = [None] * 18
    kps[0] = K(0.50, 0.20); kps[14] = K(0.47, 0.18); kps[15] = K(0.53, 0.18); kps[16] = K(0.44, 0.19); kps[17] = K(0.56, 0.19)
    hand = [K(0.2 + i * 0.004, 0.6 + i * 0.004) for i in range(21)]
    pose = Pose(Body(kps), lh=hand, rh=None)
    r = regions_from_pose([pose], 1000, 1000, {"faces": True, "eyes": True, "hands": True}, 24)
    kinds = sorted(k for k, _ in r)
    assert kinds == ["eyes", "face", "hand"]
    face = dict(r)["face"]; assert face[0] < 470 and face[2] > 560 and face[3] > 200  # extended down for the chin
    r2 = regions_from_pose([pose], 1000, 1000, {"faces": False, "eyes": False, "hands": True}, 24)
    assert [k for k, _ in r2] == ["hand"]
    # a hand with too few confident points is left alone
    pose3 = Pose(Body(kps), lh=[K(0.2, 0.6, 0.1)] * 21)
    assert [k for k, _ in regions_from_pose([pose3], 1000, 1000, {"hands": True}, 24)] == []

def test_feather_mask_is_solid_in_the_middle_and_soft_at_the_edge():
    m = feather_mask(128, 0.12)
    assert m.getpixel((64, 64)) == 255
    assert m.getpixel((1, 64)) < 60


def test_hand_patch_widens_and_asks_for_a_grip_when_a_weapon_is_named():
    """run_detail with a fake engine: one hand region, weapon set; the inpaint call must see the grip prompt and a wider box."""
    from sidecar import detail
    from PIL import Image
    calls = []
    class KP:  # a keypoint
        def __init__(s, x, y): s.x, s.y, s.score = x, y, 1.0
    class Body:
        keypoints = [None] * 18
    class Pose:
        body = Body(); left_hand = [KP(0.45 + i * 0.01, 0.5 + i * 0.01) for i in range(8)]; right_hand = None
    class Det:
        def detect_poses(s, img, include_hand, include_face): return [Pose()]
    class Res:
        def __init__(s, im): s.images = [im]
    class Eng:
        family = "sd15"; txt = None
        def pose_detector(s): return Det()
        def inpaint(s, **kw): calls.append(kw); return Res(kw["image"])
    img = Image.new("RGB", (512, 512), "white")
    _, rep = detail.run_detail(Eng(), img, {"hands": True, "faces": False, "eyes": False, "weapon": "gun"}, "", "", {"prompt": "x"})
    assert rep["regions"] and rep["regions"][0]["kind"] == "hand"
    assert "gripping a gun" in calls[0]["prompt"] and "gun fused with hand" in calls[0]["negative_prompt"]
    x0, y0, x1, y1 = rep["regions"][0]["box"]
    assert x1 - x0 >= int(0.07 * 512) * (1 + 2 * 0.6) - 2  # the 0.6 padding, not the default 0.35
    _, rep2 = detail.run_detail(Eng(), img, {"hands": True, "faces": False, "eyes": False}, "", "", {"prompt": "x"})
    assert "five fingers" in calls[1]["prompt"] and "gripping" not in calls[1]["prompt"]
    assert (rep2["regions"][0]["box"][2] - rep2["regions"][0]["box"][0]) < (x1 - x0)
