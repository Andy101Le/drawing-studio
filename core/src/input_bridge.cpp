// C ABI exported to JS (Emscripten) and to native hosts.
// JS side: Module._omni_ring_create(1024) returns a pointer into Wasm memory;
// new InputRing(Module.HEAPU8.buffer, ptr) then writes records with no copy.
#include <cstdint>
#include <cstring>
#include <new>

#include "omni/input_record.hpp"
#include "omni/stroke_predictor.hpp"

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define OMNI_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define OMNI_EXPORT
#endif

extern "C" {

OMNI_EXPORT void* omni_ring_create(uint32_t capacityPow2) {
    if (capacityPow2 == 0 || (capacityPow2 & (capacityPow2 - 1)) != 0) return nullptr;
    return omni::RingAlloc(capacityPow2);
}

OMNI_EXPORT void omni_ring_destroy(void* ring) { omni::RingFree(ring); }

OMNI_EXPORT void* omni_predictor_create() { return new (std::nothrow) omni::StrokePredictor(); }
OMNI_EXPORT void omni_predictor_destroy(void* p) { delete static_cast<omni::StrokePredictor*>(p); }
OMNI_EXPORT void omni_predictor_reset(void* p) { static_cast<omni::StrokePredictor*>(p)->reset(); }

// Drains the ring into the predictor. Writes up to maxOut filtered points into
// outPoints (StrokePoint layout) and returns the number written.
OMNI_EXPORT uint32_t omni_predictor_drain(void* p, void* ring, omni::StrokePoint* outPoints, uint32_t maxOut) {
    auto* pred = static_cast<omni::StrokePredictor*>(p);
    omni::InputRingConsumer consumer(ring);
    omni::InputRecord rec{};
    uint32_t n = 0;
    while (n < maxOut && consumer.pop(rec)) {
        outPoints[n++] = pred->feed(rec);
    }
    return n;
}

// Extrapolated point for the renderer at tUs. Returns 0 when no samples yet.
OMNI_EXPORT int omni_predictor_predict(void* p, double tUs, omni::StrokePoint* out) {
    auto* pred = static_cast<omni::StrokePredictor*>(p);
    if (!pred->hasSample()) return 0;
    *out = pred->predict(tUs);
    return 1;
}

OMNI_EXPORT uint32_t omni_stroke_point_size() { return sizeof(omni::StrokePoint); }

} // extern "C"
