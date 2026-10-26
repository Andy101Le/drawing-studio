// OMNI-CELL brush core: freestanding C++ compiled straight to wasm32 (clang --target=wasm32,
// no libc). Rasterises anti-aliased round dabs into 256x256 RGBA8 premultiplied tile mirrors
// that live in Wasm linear memory; the TypeScript side blits a tile with one putImageData
// after each pointer move. Coverage matches engine/brush.ts tip(): solid core to hardness*r,
// quadratic falloff to r, half-pixel AA skirt, so switching paths does not change the look.
#include <stdint.h>

extern "C" {

static const int TILE = 256;
static const int TILE_BYTES = TILE * TILE * 4;
static const int MAX_SLOTS = 512;            // 32 MB of tile mirrors at most
static uint8_t* slots[MAX_SLOTS];
static int slotCount = 0;
static uint8_t* heapTop = 0;

static uint8_t* bump(int bytes) {
  if (!heapTop) heapTop = (uint8_t*)(__builtin_wasm_memory_size(0) * 65536);
  uint8_t* p = heapTop;
  uint8_t* end = p + bytes;
  uint32_t have = __builtin_wasm_memory_size(0) * 65536;
  if ((uint32_t)(uintptr_t)end > have) {
    uint32_t need = ((uint32_t)(uintptr_t)end - have + 65535) / 65536;
    if (__builtin_wasm_memory_grow(0, need) == (uint32_t)-1) return 0;
  }
  heapTop = end;
  return p;
}

int omni_tile_bytes() { return TILE_BYTES; }
int omni_max_slots() { return MAX_SLOTS; }

/** Reserve a tile mirror; returns the slot index or -1. */
int omni_slot_alloc() {
  if (slotCount >= MAX_SLOTS) return -1;
  uint8_t* p = bump(TILE_BYTES);
  if (!p) return -1;
  for (int i = 0; i < TILE_BYTES; i++) p[i] = 0;
  slots[slotCount] = p;
  return slotCount++;
}
/** Address of a slot's pixels (for the ImageData view). */
uint8_t* omni_slot_ptr(int slot) { return (slot >= 0 && slot < slotCount) ? slots[slot] : 0; }
void omni_slot_clear(int slot) { if (slot < 0 || slot >= slotCount) return; uint8_t* p = slots[slot]; for (int i = 0; i < TILE_BYTES; i++) p[i] = 0; }
/** Drop every slot (end of stroke). Memory is reused by the next allocations. */
void omni_slots_reset() { slotCount = 0; heapTop = 0; }

static inline float clamp01(float v) { return v < 0.f ? 0.f : (v > 1.f ? 1.f : v); }
static inline float sqrtf_(float x) { return __builtin_sqrtf(x); }

/**
 * Coverage of a round tip at distance d from the centre, radius r, hardness h.
 *   d <= h*r         : 1
 *   h*r < d <= r     : quadratic falloff to 0.35 at the rim (matches tip())
 *   r < d <= r+0.5   : AA skirt to 0
 */
static inline float coverage(float d, float r, float h, float centerA) {
  float core = h * r;
  if (d <= core) return centerA;
  if (d <= r) { float u = (d - core) / (r - core > 1e-4f ? r - core : 1e-4f); float fall = 1.f - u * u * (1.f - 0.35f); return centerA * fall; }
  if (d <= r + 0.5f) return centerA * 0.35f * (1.f - (d - r) / 0.5f);
  return 0.f;
}

/**
 * Blend one dab into a slot. (cx, cy) in tile-local pixels, r radius, h hardness,
 * a flow alpha (0..1), colour 0..255, erase != 0 removes alpha instead of painting.
 * outRect[4] receives the touched x0 y0 x1 y1 (exclusive) in tile pixels.
 */
void omni_dab(int slot, float cx, float cy, float r, float h, float a, float cr, float cg, float cb, int erase, int* outRect) {
  if (slot < 0 || slot >= slotCount || r <= 0.02f) { if (outRect) { outRect[0] = outRect[1] = outRect[2] = outRect[3] = 0; } return; }
  uint8_t* px = slots[slot];
  float R = r + 0.5f;
  int x0 = (int)(cx - R - 1.f); int y0 = (int)(cy - R - 1.f); int x1 = (int)(cx + R + 2.f); int y1 = (int)(cy + R + 2.f);
  if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0; if (x1 > TILE) x1 = TILE; if (y1 > TILE) y1 = TILE;
  if (outRect) { outRect[0] = x0; outRect[1] = y0; outRect[2] = x1; outRect[3] = y1; }
  if (x0 >= x1 || y0 >= y1) return;
  // tiny tips: a sub-pixel disc keeps its total coverage (area pi r^2) in one pixel
  float tiny = r < 0.5f ? (r / 0.5f) * (r / 0.5f) : 1.f;
  for (int y = y0; y < y1; y++) {
    float dy = (float)y + 0.5f - cy;
    for (int x = x0; x < x1; x++) {
      float dx = (float)x + 0.5f - cx;
      float d = sqrtf_(dx * dx + dy * dy);
      float c = (r < 0.5f) ? (d <= 0.75f ? tiny : 0.f) : coverage(d, r, h, 1.f);
      if (c <= 0.f) continue;
      float sa = clamp01(c * a);
      uint8_t* p = px + (y * TILE + x) * 4;
      if (erase) {
        float k = 1.f - sa;
        p[0] = (uint8_t)(p[0] * k + 0.5f); p[1] = (uint8_t)(p[1] * k + 0.5f); p[2] = (uint8_t)(p[2] * k + 0.5f); p[3] = (uint8_t)(p[3] * k + 0.5f);
      } else {
        // premultiplied source-over
        float k = 1.f - sa;
        float dr = p[0] * k + cr * sa, dg = p[1] * k + cg * sa, db = p[2] * k + cb * sa, da = p[3] * k + 255.f * sa;
        p[0] = (uint8_t)(dr + 0.5f); p[1] = (uint8_t)(dg + 0.5f); p[2] = (uint8_t)(db + 0.5f); p[3] = (uint8_t)(da > 255.f ? 255.f : da + 0.5f);
      }
    }
  }
}

/** Benchmark helper: n dabs along a diagonal in one slot; returns the number rasterised. */
int omni_bench(int slot, int n, float r, float h) {
  int rect[4];
  for (int i = 0; i < n; i++) {
    float t = (float)i / (float)(n > 1 ? n - 1 : 1);
    omni_dab(slot, 16.f + t * 224.f, 16.f + t * 224.f, r, h, 0.6f, 20.f, 20.f, 20.f, 0, rect);
  }
  return n;
}

} // extern "C"
