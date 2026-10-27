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
