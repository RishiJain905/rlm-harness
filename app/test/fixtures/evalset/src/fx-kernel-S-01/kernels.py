"""The kernel task's entry point: kernels/*.gpu.cu loaded through gpu.py, which picks CUDA or HIP."""

from pathlib import Path

import numpy as np

import gpu

BLOCK = 128
_module = None


def _kernels():
    global _module
    if _module is None:
        _module = gpu.load(sorted((Path(__file__).parent / "kernels").glob("*.gpu.cu")))
    return _module


def add(a, b) -> np.ndarray:
    a = np.ascontiguousarray(a, dtype=np.float32)
    b = np.ascontiguousarray(b, dtype=np.float32)
    n = a.size
    out = gpu.empty(a.shape, np.float32, fill=0xFF)
    grid = max(1, (n + BLOCK - 1) // BLOCK)
    _kernels().launch("fx_add", grid, BLOCK, [gpu.to_device(a), gpu.to_device(b), out, np.int32(n)])
    return out.to_host()
