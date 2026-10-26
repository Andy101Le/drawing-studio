#!/bin/sh
# Builds the brush core to web/app/public/brush_core.wasm with clang + wasm-ld (no Emscripten needed).
set -e
cd "$(dirname "$0")"
clang --target=wasm32 -O3 -nostdlib -fno-exceptions -fno-rtti -ffreestanding -Wall -Wextra -c brush_core.cpp -o brush_core.o
wasm-ld --no-entry --export-all --allow-undefined --initial-memory=4194304 --max-memory=268435456 -o ../../web/app/public/brush_core.wasm brush_core.o
rm -f brush_core.o
ls -la ../../web/app/public/brush_core.wasm
