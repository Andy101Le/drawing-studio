// Phase 3.1: shared input record and SPSC ring consumer.
// Byte-for-byte mirror of web/src/input/ring-buffer.ts. Any change here must
// change that file and the cross-check in web/test/ring-buffer.test.ts.
#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace omni {

#pragma pack(push, 1)
struct InputRecord {
    double   timestampUs;   // 0
    float    x;             // 8   normalized 0..1
    float    y;             // 12
    float    pressure;      // 16  0..1
    int8_t   tiltX;         // 20  degrees
    int8_t   tiltY;         // 21
    uint16_t rotationCdeg;  // 22  0.01 deg units, 0xFFFF = none
    uint8_t  flags;         // 24
    uint8_t  reserved[7];   // 25..31
};
#pragma pack(pop)
static_assert(sizeof(InputRecord) == 32, "InputRecord must be 32 bytes");

enum InputFlags : uint8_t {
    kTip = 1 << 0, kBarrel1 = 1 << 1, kBarrel2 = 1 << 2, kEraser = 1 << 3, kInRange = 1 << 4,
};

constexpr std::size_t kRingHeaderBytes = 64;

// Header layout (u32 each): head, tail, capacity, dropped. Matches the TS side.
struct RingHeader {
    std::atomic<uint32_t> head;
    std::atomic<uint32_t> tail;
    std::atomic<uint32_t> capacity;
    std::atomic<uint32_t> dropped;
};
static_assert(sizeof(std::atomic<uint32_t>) == 4, "atomic<u32> must be lock-free 4 bytes");

// Consumer view over a ring allocated either by JS (SharedArrayBuffer passed in
// as a pointer into Wasm memory) or natively by RingAlloc().
class InputRingConsumer {
public:
    explicit InputRingConsumer(void* base)
        : hdr_(static_cast<RingHeader*>(base)),
          records_(reinterpret_cast<InputRecord*>(static_cast<uint8_t*>(base) + kRingHeaderBytes)),
          mask_(hdr_->capacity.load(std::memory_order_relaxed) - 1) {}

    // Returns false when empty. Acquire on head pairs with the producer's release store.
    bool pop(InputRecord& out) {
        const uint32_t head = hdr_->head.load(std::memory_order_acquire);
        const uint32_t tail = hdr_->tail.load(std::memory_order_relaxed);
        if (head == tail) return false;
        std::memcpy(&out, &records_[tail & mask_], sizeof(InputRecord));
        hdr_->tail.store(tail + 1, std::memory_order_release);
        return true;
    }

    uint32_t size() const {
        return hdr_->head.load(std::memory_order_acquire) - hdr_->tail.load(std::memory_order_relaxed);
    }
    uint32_t dropped() const { return hdr_->dropped.load(std::memory_order_relaxed); }

private:
    RingHeader*  hdr_;
    InputRecord* records_;
    uint32_t     mask_;
};

// Native allocation helper (web builds get the buffer from JS instead).
inline void* RingAlloc(uint32_t capacityPow2) {
    const std::size_t bytes = kRingHeaderBytes + static_cast<std::size_t>(capacityPow2) * sizeof(InputRecord);
    auto* base = static_cast<uint8_t*>(::operator new(bytes, std::align_val_t{64}));
    std::memset(base, 0, bytes);
    auto* hdr = reinterpret_cast<RingHeader*>(base);
    hdr->capacity.store(capacityPow2, std::memory_order_relaxed);
    return base;
}
inline void RingFree(void* base) { ::operator delete(base, std::align_val_t{64}); }

} // namespace omni
