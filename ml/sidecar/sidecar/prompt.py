r"""
Long, weighted prompts for CLIP-conditioned pipelines.

CLIP reads at most 77 tokens (75 plus start/end). diffusers' default path silently drops everything
after that, so a prompt built from quality tags + manga look + twenty tags + the subject lost its
subject. This module does what the WebUI ("A1111") does instead:

  * parse emphasis: (word) = x1.1, ((word)) = x1.21, (word:1.3) = x1.3, [word] = /1.1, \( escapes
  * tokenise the whole prompt, cut it into 75-token chunks (at a comma where possible), wrap each
    chunk in start/end tokens, encode each chunk separately and concatenate the hidden states
  * scale each token's embedding by its weight, then restore the chunk's mean so the overall
    magnitude the UNet was trained on does not drift
  * pad the positive and negative prompts to the same number of chunks (classifier-free guidance
    needs equal sequence lengths)

SD 1.5: one encoder, last hidden layer. SDXL: two encoders, penultimate layer each, concatenated
(768 + 1280), plus the pooled output of the second encoder from the first chunk (what the WebUI does).
"""
import re
from typing import List, Tuple

_RE_ATTN = re.compile(r"""
\\\(|\\\)|\\\[|\\\]|\\\\|\\|\(|\[|:\s*([+-]?[.\d]+)\s*\)|\)|\]|[^\\()\[\]:]+|:
""", re.X)

def parse_attention(text: str) -> List[Tuple[str, float]]:
    """A1111 parse_prompt_attention: text -> [(fragment, weight)], adjacent equal weights merged."""
    res: List[list] = []; round_b: List[int] = []; square_b: List[int] = []
    def mult(start, m):
        for p in range(start, len(res)): res[p][1] *= m
    for m in _RE_ATTN.finditer(text):
        t = m.group(0); w = m.group(1)
        if t.startswith("\\"): res.append([t[1:], 1.0])
        elif t == "(": round_b.append(len(res))
        elif t == "[": square_b.append(len(res))
        elif w is not None and round_b: mult(round_b.pop(), float(w))
        elif t == ")" and round_b: mult(round_b.pop(), 1.1)
        elif t == "]" and square_b: mult(square_b.pop(), 1 / 1.1)
        else: res.append([t, 1.0])
    for pos in round_b: mult(pos, 1.1)
    for pos in square_b: mult(pos, 1 / 1.1)
    if not res: res = [["", 1.0]]
    i = 0
    while i + 1 < len(res):
        if res[i][1] == res[i + 1][1]: res[i][0] += res[i + 1][0]; del res[i + 1]
        else: i += 1
    return [(t, w) for t, w in res]

def tokenize_weighted(tokenizer, text: str, chunk: int = 75):
    """-> (chunks of (ids, weights) each exactly `chunk` long, total token count). Breaks at commas when a chunk would otherwise split a tag."""
    ids: List[int] = []; ws: List[float] = []
    comma = tokenizer(",", add_special_tokens=False).input_ids
    comma_id = comma[0] if len(comma) == 1 else None
    for frag, w in parse_attention(text):
        toks = tokenizer(frag, add_special_tokens=False, truncation=False).input_ids
        ids.extend(toks); ws.extend([w] * len(toks))
    total = len(ids)
    chunks = []
    while ids:
        if len(ids) <= chunk: cut = len(ids)
        else:
            cut = chunk
            # prefer to break just after the last comma in the chunk (keep a tag whole), if it is not too early
            if comma_id is not None:
                last = max((i for i in range(chunk) if ids[i] == comma_id), default=-1)
                if last >= chunk // 2: cut = last + 1
        chunks.append((ids[:cut], ws[:cut])); ids = ids[cut:]; ws = ws[cut:]
    if not chunks: chunks = [([], [])]
    return chunks, total

def _encode_chunks(tokenizer, text_encoder, chunks, device, dtype, layer: str, want_pooled: bool, n_chunks: int, torch):
    """Encode `n_chunks` chunks (padding with empty ones) -> (hidden [1, 77*n, d], pooled [1, d2] or None)."""
    bos = tokenizer.bos_token_id; eos = tokenizer.eos_token_id
    pad = tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos
    outs = []; pooled = None
    for ci in range(n_chunks):
        ids, ws = chunks[ci] if ci < len(chunks) else ([], [])
        full = [bos] + list(ids) + [eos] + [pad] * (75 - len(ids))
        wfull = [1.0] + list(ws) + [1.0] * (76 - len(ws))
        t = torch.tensor([full], device=device)
        out = text_encoder(t, output_hidden_states=True)
        # SDXL conditions on the penultimate layer without the final norm (what diffusers' encode_prompt does)
        h = out.hidden_states[-2] if layer == "penultimate" else out[0]
        if want_pooled and pooled is None:
            # CLIPTextModelWithProjection returns text_embeds [1, d] first; CLIPTextModel returns the sequence
            pooled = out[0] if out[0].dim() == 2 else getattr(out, "pooler_output", None)
        h = h.to(dtype)
        w = torch.tensor(wfull, device=h.device, dtype=h.dtype).view(1, -1, 1)
        mean0 = h.float().mean()
        h = h * w
        mean1 = h.float().mean()
        if abs(float(mean1)) > 1e-8: h = h * (mean0 / mean1).to(h.dtype)
        outs.append(h)
    return torch.cat(outs, dim=1), (pooled.to(dtype) if pooled is not None else None)

def encode_prompts(pipe, prompt: str, negative: str, family: str):
    """
    -> (kwargs for the pipeline call, info dict). kwargs carry prompt_embeds / negative_prompt_embeds
    (and the pooled pair for SDXL); the caller must not also pass prompt= / negative_prompt=.
    """
    import torch
    device = getattr(pipe, "_execution_device", None) or pipe.device
    if family == "sdxl":
        tok1, enc1, tok2, enc2 = pipe.tokenizer, pipe.text_encoder, pipe.tokenizer_2, pipe.text_encoder_2
        dtype = enc2.dtype
        cp, np_ = tokenize_weighted(tok1, prompt); cn, nn = tokenize_weighted(tok1, negative)
        n = max(len(cp), len(cn))
        with torch.no_grad():
            p1, _ = _encode_chunks(tok1, enc1, cp, device, dtype, "penultimate", False, n, torch)
            n1, _ = _encode_chunks(tok1, enc1, cn, device, dtype, "penultimate", False, n, torch)
            cp2, _ = tokenize_weighted(tok2, prompt); cn2, _ = tokenize_weighted(tok2, negative)
            p2, pp = _encode_chunks(tok2, enc2, cp2, device, dtype, "penultimate", True, n, torch)
            n2, npool = _encode_chunks(tok2, enc2, cn2, device, dtype, "penultimate", True, n, torch)
        kw = {"prompt_embeds": torch.cat([p1, p2], dim=-1), "negative_prompt_embeds": torch.cat([n1, n2], dim=-1),
              "pooled_prompt_embeds": pp, "negative_pooled_prompt_embeds": npool}
        return kw, {"promptTokens": np_, "negativeTokens": nn, "chunks": n}
    tok, enc = pipe.tokenizer, pipe.text_encoder
    dtype = enc.dtype
    cp, np_ = tokenize_weighted(tok, prompt); cn, nn = tokenize_weighted(tok, negative)
    n = max(len(cp), len(cn))
    with torch.no_grad():
        p, _ = _encode_chunks(tok, enc, cp, device, dtype, "last", False, n, torch)
        ng, _ = _encode_chunks(tok, enc, cn, device, dtype, "last", False, n, torch)
    return {"prompt_embeds": p, "negative_prompt_embeds": ng}, {"promptTokens": np_, "negativeTokens": nn, "chunks": n}

def count_tokens(tokenizer, text: str) -> int:
    return tokenize_weighted(tokenizer, text)[1]
