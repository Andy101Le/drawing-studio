cmake_minimum_required(VERSION 3.20)
project(omni_core CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_library(omni_core STATIC src/input_bridge.cpp)
target_include_directories(omni_core PUBLIC include)
target_compile_options(omni_core PRIVATE -Wall -Wextra -Wpedantic -O2)

if(EMSCRIPTEN)
  # Shared memory so the JS InputRing can live inside the Wasm heap.
  # Requires the page to be served with COOP/COEP headers (see docs/ARCHITECTURE.md).
  add_executable(omni_core_wasm src/input_bridge.cpp)
  target_include_directories(omni_core_wasm PUBLIC include)
  target_link_options(omni_core_wasm PRIVATE
    -sWASM=1 -sALLOW_MEMORY_GROWTH=0 -sINITIAL_MEMORY=268435456
    -sUSE_PTHREADS=1 -sPTHREAD_POOL_SIZE=4 -sSHARED_MEMORY=1
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker
    -sEXPORTED_FUNCTIONS=_omni_ring_create,_omni_ring_destroy,_omni_predictor_create,_omni_predictor_destroy,_omni_predictor_reset,_omni_predictor_drain,_omni_predictor_predict,_omni_stroke_point_size,_malloc,_free
    -sEXPORTED_RUNTIME_METHODS=HEAPU8,HEAPF32,HEAPF64)
  set_target_properties(omni_core_wasm PROPERTIES OUTPUT_NAME omni_core SUFFIX .js)
endif()

add_executable(predictor_test test/predictor_test.cpp)
target_link_libraries(predictor_test omni_core)
