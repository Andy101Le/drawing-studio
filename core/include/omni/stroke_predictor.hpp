// Phase 3.1 / 4.2: predictive stroke smoothing for local echo.
//
// Plain-language model:
//   1. One Euro filter per axis. At slow pen speed it smooths hard (kills
//      hardware jitter); at fast speed it smooths lightly (no visible lag).
//      Cutoff f_c = minCutoff + beta * |velocity|.
//   2. Dead-reckoning extrapolation. The renderer asks "where is the pen at
//      time t_render?" and gets filtered position + filtered velocity * dt,
//      with dt capped so a stalled device never shoots a line across the page.
//   3. Pressure and tilt use a lighter One Euro (they change slowly).
//
// Both the iPad (local echo) and the host (authority) run this exact code on
// the same input records, so their active-stroke geometry matches to float
// precision and corrections are only needed for dropped packets.
#pragma once

#include <cmath>
#include <cstdint>

#include "input_record.hpp"

namespace omni {

class LowPassFilter {
public:
    void reset() { initialized_ = false; }
    float filter(float value, float alpha) {
        if (!initialized_) { last_ = value; initialized_ = true; return value; }
        last_ = alpha * value + (1.0f - alpha) * last_;
        return last_;
    }
    float last() const { return last_; }
    bool initialized() const { return initialized_; }
private:
    float last_ = 0.0f;
    bool  initialized_ = false;
};

// Casiez, Roussel, Vogel (CHI 2012). Units: value in normalized canvas space,
// time in seconds.
class OneEuroFilter {
public:
    OneEuroFilter(float minCutoffHz = 1.0f, float beta = 0.007f, float dCutoffHz = 1.0f)
        : minCutoff_(minCutoffHz), beta_(beta), dCutoff_(dCutoffHz) {}

    void reset() { x_.reset(); dx_.reset(); lastT_ = 0.0; hasRaw_ = false; }

    float filter(float value, double tSec) {
        float dt = (x_.initialized() && tSec > lastT_) ? static_cast<float>(tSec - lastT_) : (1.0f / 240.0f);
        if (dt < 1e-5f) dt = 1e-5f;
        lastT_ = tSec;
        // Derivative from consecutive RAW samples, not from the lagged filtered
        // value as in the original paper: the paper's form biases velocity by
        // lag/dt, which makes dead-reckoning overshoot.
        const float rawDeriv = hasRaw_ ? (value - lastRaw_) / dt : 0.0f;
        lastRaw_ = value; hasRaw_ = true;
        const float dEst = dx_.filter(rawDeriv, alpha(dCutoff_, dt));
        const float cutoff = minCutoff_ + beta_ * std::fabs(dEst);
        velocity_ = dEst;
        return x_.filter(value, alpha(cutoff, dt));
    }

    float velocity() const { return velocity_; }   // units per second (filtered)
    float value() const { return x_.last(); }

private:
    static float alpha(float cutoffHz, float dt) {
        const float tau = 1.0f / (2.0f * 3.14159265358979f * cutoffHz);
        return 1.0f / (1.0f + tau / dt);
    }
    float minCutoff_, beta_, dCutoff_;
    LowPassFilter x_, dx_;
    double lastT_ = 0.0;
    float velocity_ = 0.0f;
    float lastRaw_ = 0.0f;
    bool  hasRaw_ = false;
};

struct StrokePoint {
    double timestampUs;
    float  x, y;        // normalized canvas space
    float  pressure;    // 0..1
    float  tiltX, tiltY; // degrees
    float  rotationDeg; // 0..360, negative when unknown
    bool   predicted;   // true when extrapolated beyond the last real sample
};

struct PredictorConfig {
    // Units are normalized canvas space (0..1), so velocities are small
    // (a fast stroke is ~2 units/s). Beta is therefore much larger than the
    // pixel-space defaults in the One Euro paper (0.007 at ~1000 px/s).
    float posMinCutoffHz = 1.0f;   // lower = smoother at rest
    float posBeta        = 50.0f;  // higher = less lag at speed
    float pressureCutoffHz = 4.0f;
    float tiltCutoffHz     = 2.0f;
    float maxPredictMs     = 8.0f; // never extrapolate past one 120 Hz frame
    float predictGain      = 0.85f; // < 1 damps overshoot on direction change
};

class StrokePredictor {
public:
    explicit StrokePredictor(PredictorConfig cfg = {})
        : cfg_(cfg), fx_(cfg.posMinCutoffHz, cfg.posBeta), fy_(cfg.posMinCutoffHz, cfg.posBeta),
          fp_(cfg.pressureCutoffHz, 0.0f), ftx_(cfg.tiltCutoffHz, 0.0f), fty_(cfg.tiltCutoffHz, 0.0f) {}

    void reset() {
        fx_.reset(); fy_.reset(); fp_.reset(); ftx_.reset(); fty_.reset();
        hasSample_ = false;
    }

    // Feed one raw record. Returns the filtered point at the record's time.
    StrokePoint feed(const InputRecord& r) {
        const double tSec = r.timestampUs * 1e-6;
        if (!(r.flags & kTip)) {
            // pen lifted: hover samples still update position so the next
            // touch starts without a filter warm-up jump, but reset velocity.
            StrokePoint p = filterAt(r, tSec);
            hasSample_ = true;
            return p;
        }
        StrokePoint p = filterAt(r, tSec);
        hasSample_ = true;
        return p;
    }

    // Extrapolate to tUs (microseconds, same clock as records). Clamped.
    StrokePoint predict(double tUs) const {
        StrokePoint p = last_;
        if (!hasSample_) return p;
        double dtMs = (tUs - last_.timestampUs) * 1e-3;
        if (dtMs <= 0.0) return p;
        if (dtMs > cfg_.maxPredictMs) dtMs = cfg_.maxPredictMs;
        const float dtSec = static_cast<float>(dtMs * 1e-3);
        p.x = last_.x + cfg_.predictGain * fx_.velocity() * dtSec;
        p.y = last_.y + cfg_.predictGain * fy_.velocity() * dtSec;
        p.x = clamp01(p.x); p.y = clamp01(p.y);
        p.timestampUs = tUs;
        p.predicted = true;
        return p;
    }

    const StrokePoint& last() const { return last_; }
    bool hasSample() const { return hasSample_; }

private:
    static float clamp01(float v) { return v < 0.0f ? 0.0f : (v > 1.0f ? 1.0f : v); }

    StrokePoint filterAt(const InputRecord& r, double tSec) {
        last_.timestampUs = r.timestampUs;
        last_.x = fx_.filter(r.x, tSec);
        last_.y = fy_.filter(r.y, tSec);
        last_.pressure = fp_.filter(r.pressure, tSec);
        last_.tiltX = ftx_.filter(static_cast<float>(r.tiltX), tSec);
        last_.tiltY = fty_.filter(static_cast<float>(r.tiltY), tSec);
        last_.rotationDeg = (r.rotationCdeg == 0xFFFF) ? -1.0f : r.rotationCdeg * 0.01f;
        last_.predicted = false;
        return last_;
    }

    PredictorConfig cfg_;
    OneEuroFilter fx_, fy_, fp_, ftx_, fty_;
    StrokePoint last_{};
    bool hasSample_ = false;
};

// Centripetal Catmull-Rom (alpha = 0.5) between filtered points. Centripetal
// parameterization avoids cusps and self-intersections on tight corners.
inline void catmullRom(const StrokePoint& p0, const StrokePoint& p1, const StrokePoint& p2, const StrokePoint& p3,
                       float t, float& outX, float& outY) {
    auto knot = [](float t0, const StrokePoint& a, const StrokePoint& b) {
        const float dx = b.x - a.x, dy = b.y - a.y;
        return t0 + std::sqrt(std::sqrt(dx * dx + dy * dy)) + 1e-6f;
    };
    const float t0 = 0.0f, t1 = knot(t0, p0, p1), t2 = knot(t1, p1, p2), t3 = knot(t2, p2, p3);
    const float tt = t1 + (t2 - t1) * t;
    auto lerp = [](float a, float b, float u) { return a + (b - a) * u; };
    const float a1x = lerp(p0.x, p1.x, (tt - t0) / (t1 - t0)), a1y = lerp(p0.y, p1.y, (tt - t0) / (t1 - t0));
    const float a2x = lerp(p1.x, p2.x, (tt - t1) / (t2 - t1)), a2y = lerp(p1.y, p2.y, (tt - t1) / (t2 - t1));
    const float a3x = lerp(p2.x, p3.x, (tt - t2) / (t3 - t2)), a3y = lerp(p2.y, p3.y, (tt - t2) / (t3 - t2));
    const float b1x = lerp(a1x, a2x, (tt - t0) / (t2 - t0)), b1y = lerp(a1y, a2y, (tt - t0) / (t2 - t0));
    const float b2x = lerp(a2x, a3x, (tt - t1) / (t3 - t1)), b2y = lerp(a2y, a3y, (tt - t1) / (t3 - t1));
    outX = lerp(b1x, b2x, (tt - t1) / (t2 - t1));
    outY = lerp(b1y, b2y, (tt - t1) / (t2 - t1));
}

} // namespace omni
