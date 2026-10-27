import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from sidecar.prompt import parse_attention, tokenize_weighted

class FakeTok:
    bos_token_id = 1; eos_token_id = 2; pad_token_id = 2
    def __call__(self, text, add_special_tokens=False, truncation=False):
        class R: pass
        r = R(); r.input_ids = [267 if w == "," else (abs(hash(w)) % 40000) + 10 for w in text.replace(",", " , ").split()]; return r

def test_attention_syntax():
    out = dict(parse_attention("(red armor:1.3), ((helmet)), [blurry], plain"))
    assert out["red armor"] == 1.3
    assert abs(out["helmet"] - 1.21) < 1e-9
    assert abs(out["blurry"] - 1 / 1.1) < 1e-9

def test_long_prompt_is_chunked_at_commas():
    chunks, total = tokenize_weighted(FakeTok(), ", ".join(f"tag{i}" for i in range(100)))
    assert total == 199
    assert all(len(c[0]) <= 75 for c in chunks)
    assert sum(len(c[0]) for c in chunks) == total
    assert len(chunks) == 3
