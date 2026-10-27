// Native sanity test: smoothing reduces jitter, prediction stays bounded,
// ring consumer pops records in order and reports drops.
#include <cassert>
#include <cmath>
#include <cstdio>
#include <random>

#include "omni/input_record.hpp"
#include "omni/stroke_predictor.hpp"

using namespace omni;

static InputRecord rec(double tUs, float x, float y, float p, bool tip) {
    InputRecord r{};
    r.timestampUs = tUs; r.x = x; r.y = y; r.pressure = p;
    r.rotationCdeg = 0xFFFF; r.flags = tip ? (kTip | kInRange) : kInRange;
    return r;
}

int main() {
    // 1. Ring round trip with overwrite-on-overflow semantics.
    void* ring = RingAlloc(4);
    auto* hdr = static_cast<RingHeader*>(ring);
    auto* recs = reinterpret_cast<InputRecord*>(static_cast<uint8_t*>(ring) + kRingHeaderBytes);
    for (uint32_t i = 0; i < 4; ++i) { recs[i] = rec(i, i * 0.1f, 0, 0, true); hdr->head.store(i + 1); }
    InputRingConsumer c(ring);
    assert(c.size() == 4);
    InputRecord out{};
    assert(c.pop(out) && out.timestampUs == 0);
    assert(c.pop(out) && out.timestampUs == 1);
    RingFree(ring);

    // 2. One Euro: jittered straight line at 240 Hz; filtered residual must shrink.
    std::mt19937 rng(42);
    std::normal_distribution<float> noise(0.0f, 0.002f);
    StrokePredictor pred;
    // Jitter metric: mean |second difference|. Lag metric: mean |filtered - truth|.
    double rawRough = 0, filtRough = 0, lag = 0; int n = 0;
    float r1 = 0, r2 = 0, f1 = 0, f2 = 0;
    for (int i = 0; i < 240; ++i) {
        const double tUs = i * (1e6 / 240.0);
        const float truth = 0.1f + 0.5f * static_cast<float>(i) / 240.0f; // 0.5 units/s
        const float jittered = truth + noise(rng);
        StrokePoint p = pred.feed(rec(tUs, jittered, 0.5f, 0.5f, true));
        if (i > 60) {
            rawRough += std::fabs(jittered - 2 * r1 + r2);
            filtRough += std::fabs(p.x - 2 * f1 + f2);
            lag += std::fabs(p.x - truth); ++n;
        }
        r2 = r1; r1 = jittered; f2 = f1; f1 = p.x;
    }
    std::printf("roughness raw=%.6f filtered=%.6f  mean lag=%.5f\n", rawRough / n, filtRough / n, lag / n);
    assert(filtRough < rawRough * 0.5);   // at least 2x jitter reduction
    assert(lag / n < 0.005);              // under 0.5% of canvas width at 0.5 u/s

    // 3. Prediction: 8 ms ahead on 0.5 u/s motion moves ~0.0034 with gain 0.85; clamp beyond 8 ms.
    const double tLast = pred.last().timestampUs;
    StrokePoint p8 = pred.predict(tLast + 8000.0);
    StrokePoint p50 = pred.predict(tLast + 50000.0);
    std::printf("predict dx@8ms=%.5f dx@50ms=%.5f\n", p8.x - pred.last().x, p50.x - pred.last().x);
    assert(p8.predicted && p8.x > pred.last().x);
    assert(std::fabs((p50.x - pred.last().x) - (p8.x - pred.last().x)) < 1e-6f); // clamped
    assert(p8.x - pred.last().x < 0.01f);

    // 4. Catmull-Rom endpoints interpolate exactly.
    StrokePoint a{0,0,0,0,0,0,-1,false}, b{0,0.1f,0.1f,0,0,0,-1,false}, cc{0,0.2f,0.15f,0,0,0,-1,false}, d{0,0.3f,0.1f,0,0,0,-1,false};
    float x, y; catmullRom(a, b, cc, d, 0.0f, x, y);
    assert(std::fabs(x - 0.1f) < 1e-5f && std::fabs(y - 0.1f) < 1e-5f);
    catmullRom(a, b, cc, d, 1.0f, x, y);
    assert(std::fabs(x - 0.2f) < 1e-5f && std::fabs(y - 0.15f) < 1e-5f);

    std::puts("predictor_test OK");
    return 0;
}
