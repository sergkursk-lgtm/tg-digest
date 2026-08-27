# CMakeLists.txt для llama.cpp JNI биндингов

cmake_minimum_required(VERSION 3.18.1)
project("tglocaldigest_llama")

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# Опции для llama.cpp
option(GGML_NATIVE "ggml: enable native optimizations" OFF)
option(GGML_OPENMP "ggml: enable OpenMP support" OFF)
option(BUILD_SHARED_LIBS "Build shared libraries" ON)

# Включаем исходники llama.cpp
# Предполагается что llama.cpp находится в директории проекта или подключена как submodule
# Для production используйте: git submodule add https://github.com/ggerganov/llama.cpp

set(LLAMA_CPP_DIR "${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp")

if(EXISTS ${LLAMA_CPP_DIR})
    # Добавляем llama.cpp как подпроект
    add_subdirectory(${LLAMA_CPP_DIR} ${CMAKE_CURRENT_BINARY_DIR}/llama.cpp)
else()
    message(WARNING "llama.cpp not found. Please clone it to ${LLAMA_CPP_DIR}")
    message(STATUS "Building without llama.cpp - stub implementation will be used")
endif()

# JNI библиотека для интеграции с Android
add_library(tglocaldigest-llama SHARED
    LlamaCppJNI.cpp
)

# Поиск JNI
find_package(JNI REQUIRED)

target_include_directories(tglocaldigest-llama PRIVATE
    ${JNI_INCLUDE_DIRS}
    ${LLAMA_CPP_DIR}/include
    ${LLAMA_CPP_DIR}/ggml/include
)

# Линкуем с llama.cpp если он доступен
if(EXISTS ${LLAMA_CPP_DIR})
    target_link_libraries(tglocaldigest-llama
        llama
        ggml
        android
        log
    )
else()
    # Stub библиотеки для компиляции без llama.cpp
    target_link_libraries(tglocaldigest-llama
        android
        log
    )
endif()

# Компиляторные флаги
target_compile_options(tglocaldigest-llama PRIVATE
    -Wall
    -Wextra
    -O2
    -fPIC
    -ffast-math
    -funroll-loops
)

# Настройки для разных ABI
if(${ANDROID_ABI} STREQUAL "arm64-v8a")
    target_compile_options(tglocaldigest-llama PRIVATE
        -march=armv8-a+fp+simd
    )
elseif(${ANDROID_ABI} STREQUAL "armeabi-v7a")
    target_compile_options(tglocaldigest-llama PRIVATE
        -mfloat-abi=softfp
        -mfpu=neon
    )
endif()
