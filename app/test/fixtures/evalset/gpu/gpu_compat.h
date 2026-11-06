// KV cache: none. gpu_compat.h: one kernel dialect for CUDA (NVRTC) and HIP (hiprtc), D-223.
// gpu.py puts this file in front of every kernel file, so no include path is needed. An #ifndef guard, not
// #pragma once: clang (hiprtc) warns about #pragma once in a main file.
#ifndef GPU_COMPAT_H
#define GPU_COMPAT_H

#if defined(__HIPCC_RTC__) || defined(__HIP_PLATFORM_AMD__) || defined(__HIP__)
#define GPU_BACKEND_HIP 1
#else
#define GPU_BACKEND_CUDA 1
#endif

// Kernels are declared GPU_KERNEL (extern "C" __global__), so both compilers keep their names.
#define GPU_KERNEL extern "C" __global__
#define LAUNCH_BOUNDS(n) __launch_bounds__(n)

// A warp is not always 32 threads: AMD's wavefront is 64 on CDNA and 32 or 64 on RDNA. On HIP, gpu.py reads
// the device's warp size and passes it as GPU_WARP_SIZE, because ROCm 7's clang deprecates
// __AMDGCN_WAVEFRONT_SIZE (D-237); that macro is only the fallback for a compile without gpu.py.
#if defined(GPU_BACKEND_HIP) && defined(GPU_WARP_SIZE)
#define WARP_SIZE GPU_WARP_SIZE
#elif defined(GPU_BACKEND_HIP)
#define WARP_SIZE __AMDGCN_WAVEFRONT_SIZE
#else
#define WARP_SIZE 32
#endif

// Whole-warp shuffles and ballot. HIP has no _sync forms; its ballot is 64 bits wide. The ballot
// wrapper is warp_ballot, because CUDA already declares a legacy ballot(bool) that would win.
template <typename T> __device__ __forceinline__ T shfl_down(T v, int delta) {
#if defined(GPU_BACKEND_HIP)
    return __shfl_down(v, delta);
#else
    return __shfl_down_sync(0xffffffffu, v, delta);
#endif
}

template <typename T> __device__ __forceinline__ T shfl_xor(T v, int mask) {
#if defined(GPU_BACKEND_HIP)
    return __shfl_xor(v, mask);
#else
    return __shfl_xor_sync(0xffffffffu, v, mask);
#endif
}

__device__ __forceinline__ unsigned long long warp_ballot(int predicate) {
#if defined(GPU_BACKEND_HIP)
    return (unsigned long long)__ballot(predicate);
#else
    return (unsigned long long)__ballot_sync(0xffffffffu, predicate);
#endif
}

// Special float values without math headers.
#define GPU_INFINITY __int_as_float(0x7f800000)
#define GPU_NAN __int_as_float(0x7fc00000)

// fp16 travels as raw 16-bit storage (unsigned short), so no vendor fp16 header is needed.
__device__ __forceinline__ float h2f(unsigned short h) {
    unsigned int sign = ((unsigned int)h & 0x8000u) << 16;
    unsigned int exp = ((unsigned int)h >> 10) & 0x1fu;
    unsigned int mant = (unsigned int)h & 0x3ffu;
    unsigned int bits;
    if (exp == 0u) {
        if (mant == 0u) {
            bits = sign;
        } else {  // subnormal: normalise
            exp = 113u;
            while ((mant & 0x400u) == 0u) {
                mant <<= 1;
                exp -= 1u;
            }
            bits = sign | (exp << 23) | ((mant & 0x3ffu) << 13);
        }
    } else if (exp == 31u) {
        bits = sign | 0x7f800000u | (mant << 13);
    } else {
        bits = sign | ((exp + 112u) << 23) | (mant << 13);
    }
    return __uint_as_float(bits);
}

// Round to nearest, ties to even; overflow gives inf, NaN stays NaN.
__device__ __forceinline__ unsigned short f2h(float f) {
    unsigned int x = __float_as_uint(f);
    unsigned int sign = (x >> 16) & 0x8000u;
    unsigned int ax = x & 0x7fffffffu;
    if (ax > 0x7f800000u) return (unsigned short)(sign | 0x7e00u);
    unsigned int e = ax >> 23;
    if (e >= 143u) return (unsigned short)(sign | 0x7c00u);
    unsigned int r, rem, half;
    if (e >= 113u) {
        r = ((e - 112u) << 10) | ((ax & 0x7fffffu) >> 13);
        rem = ax & 0x1fffu;
        half = 0x1000u;
    } else {
        unsigned int shift = 126u - e;
        if (shift > 24u) return (unsigned short)sign;
        unsigned int m = (ax & 0x7fffffu) | 0x800000u;
        r = m >> shift;
        rem = m & ((1u << shift) - 1u);
        half = 1u << (shift - 1u);
    }
    if (rem > half || (rem == half && (r & 1u))) r += 1u;
    return (unsigned short)(sign | r);
}

#endif  // GPU_COMPAT_H
