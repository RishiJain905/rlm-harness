"""KV cache: none. gpu.py: run kernels in the CUDA/HIP dialect of gpu_compat.h on whichever GPU loads (D-223).

Pure ctypes, standard library at import; numpy is imported only when arrays move.

    backend() -> "cuda" | "hip"        the backend in use (RLMH_GPU_BACKEND, else cuda, then hip)
    load(paths) -> Module              compile each kernel file at run time (NVRTC or hiprtc)
    Module.launch(name, grid, block, args, shared=0)
    to_device(ndarray) -> DeviceArray, empty(shape, dtype) -> DeviceArray, DeviceArray.to_host()
    compile_check(paths, arch) -> {path: log}   compile for CUDA with no GPU (NVRTC only)

`python gpu.py --probe [--backend cuda|hip]` prints one line, `backend=<cuda|hip|none> devices=<n>`.

Detection loads a runtime and counts devices. The only device properties read are the compile target
(compute capability; hiprtc picks the gfx target itself) and, on HIP, the warp size, which every compile
gets as GPU_WARP_SIZE (D-237). Never a device name, UUID, serial or driver version: every C function goes
through _bind, which accepts only the names in CALLS.
"""

from __future__ import annotations

import ctypes
import glob
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
PRELUDE = "gpu_compat.h"
BACKENDS = ("cuda", "hip")

CALLS = {
    "cuda": ("cuInit", "cuDeviceGetCount", "cuDeviceGet", "cuDeviceGetAttribute", "cuDevicePrimaryCtxRetain",
             "cuCtxSetCurrent", "cuCtxSynchronize", "cuModuleLoadData", "cuModuleGetFunction", "cuFuncSetAttribute",
             "cuLaunchKernel", "cuMemAlloc_v2", "cuMemFree_v2", "cuMemcpyHtoD_v2", "cuMemcpyDtoH_v2",
             "cuMemsetD8_v2", "cuGetErrorName"),
    "nvrtc": ("nvrtcCreateProgram", "nvrtcCompileProgram", "nvrtcGetProgramLogSize", "nvrtcGetProgramLog",
              "nvrtcGetCUBINSize", "nvrtcGetCUBIN", "nvrtcDestroyProgram", "nvrtcGetErrorString"),
    "hip": ("hipInit", "hipGetDeviceCount", "hipSetDevice", "hipDeviceSynchronize", "hipModuleLoadData",
            "hipModuleGetFunction", "hipModuleLaunchKernel", "hipMalloc", "hipFree", "hipMemcpyHtoD",
            "hipMemcpyDtoH", "hipMemset", "hipGetErrorName", "hipDeviceGetAttribute"),
    "hiprtc": ("hiprtcCreateProgram", "hiprtcCompileProgram", "hiprtcGetProgramLogSize", "hiprtcGetProgramLog",
               "hiprtcGetCodeSize", "hiprtcGetCode", "hiprtcDestroyProgram", "hiprtcGetErrorString"),
}

CU_COMPUTE_MAJOR, CU_COMPUTE_MINOR = 75, 76
HIP_ATTR_WARP_SIZE = 87  # hipDeviceAttributeWarpSize in ROCm 7.1's hip_runtime_api.h
CU_FUNC_MAX_DYNAMIC_SHARED = 8


class GpuError(RuntimeError):
    pass


class CompileError(GpuError):
    pass


def _bind(lib: ctypes.CDLL, group: str, name: str):
    if name not in CALLS[group]:
        raise GpuError(f"{name} is not an allowed {group} call")
    fn = getattr(lib, name)
    fn.restype = ctypes.c_int
    return fn


# --- finding the libraries -------------------------------------------------------------------


def _open(candidates: list[str]) -> ctypes.CDLL | None:
    for path in candidates:
        try:
            return ctypes.CDLL(path)
        except OSError:
            continue
    return None


def _nvrtc_paths() -> list[str]:
    """NVRTC from the nvidia-cuda-nvrtc-cu12 wheel in this interpreter's site-packages, then CUDA_PATH."""
    found: list[str] = []
    for entry in sys.path:
        base = Path(entry or ".") / "nvidia" / "cuda_nvrtc"
        if os.name == "nt":
            found += sorted(glob.glob(str(base / "bin" / "nvrtc64_*.dll")))
        else:
            found += sorted(glob.glob(str(base / "lib" / "libnvrtc.so.*")))
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        sub = ("bin", "nvrtc64_*.dll") if os.name == "nt" else ("lib64", "libnvrtc.so*")
        found += sorted(glob.glob(str(Path(cuda_path) / sub[0] / sub[1])))
    found = [p for p in found if ".alt." not in p and "builtins" not in p]
    return found or (["nvrtc64_120_0.dll"] if os.name == "nt" else ["libnvrtc.so.12"])


def _cuda_paths() -> list[str]:
    return ["nvcuda.dll"] if os.name == "nt" else ["libcuda.so.1", "libcuda.so"]


def _hip_dirs() -> list[Path]:
    dirs: list[Path] = []
    if os.name == "nt":
        if os.environ.get("HIP_PATH"):
            dirs.append(Path(os.environ["HIP_PATH"]) / "bin")
    else:
        if os.environ.get("ROCM_PATH"):
            dirs.append(Path(os.environ["ROCM_PATH"]) / "lib")
        dirs.append(Path("/opt/rocm/lib"))
    return dirs


def _hip_paths(stem: str) -> list[str]:
    """stem is amdhip64 or hiprtc; the newest versioned name first."""
    found: list[str] = []
    for d in _hip_dirs():
        if os.name == "nt":
            names = [p for p in glob.glob(str(d / f"{stem}*.dll")) if "builtins" not in p]
        else:
            names = glob.glob(str(d / f"lib{stem}.so*"))
        found += sorted(names, reverse=True)
    return found or ([f"{stem}.dll"] if os.name == "nt" else [f"lib{stem}.so"])


# --- runtimes ------------------------------------------------------------------------------


class _Runtime:
    name = ""

    def devices(self) -> int:
        raise NotImplementedError


class _Cuda(_Runtime):
    name = "cuda"

    def __init__(self, lib: ctypes.CDLL):
        self.lib = lib
        self.fn = {n: _bind(lib, "cuda", n) for n in CALLS["cuda"]}
        self.nvrtc: _Nvrtc | None = None
        self.ready = False
        self.arch = ""

    def check(self, code: int, what: str) -> None:
        if code != 0:
            name = ctypes.c_char_p()
            self.fn["cuGetErrorName"](code, ctypes.byref(name))
            raise GpuError(f"{what} failed: {(name.value or b'?').decode()} ({code})")

    def devices(self) -> int:
        if self.fn["cuInit"](0) != 0:
            return 0
        count = ctypes.c_int(0)
        if self.fn["cuDeviceGetCount"](ctypes.byref(count)) != 0:
            return 0
        return count.value

    def start(self) -> None:
        if self.ready:
            return
        self.check(self.fn["cuInit"](0), "cuInit")
        dev = ctypes.c_int()
        self.check(self.fn["cuDeviceGet"](ctypes.byref(dev), 0), "cuDeviceGet")
        major, minor = ctypes.c_int(), ctypes.c_int()
        self.check(self.fn["cuDeviceGetAttribute"](ctypes.byref(major), CU_COMPUTE_MAJOR, dev), "compute capability")
        self.check(self.fn["cuDeviceGetAttribute"](ctypes.byref(minor), CU_COMPUTE_MINOR, dev), "compute capability")
        ctx = ctypes.c_void_p()
        self.check(self.fn["cuDevicePrimaryCtxRetain"](ctypes.byref(ctx), dev), "cuDevicePrimaryCtxRetain")
        self.check(self.fn["cuCtxSetCurrent"](ctx), "cuCtxSetCurrent")
        self.arch = os.environ.get("RLMH_GPU_ARCH") or f"sm_{major.value}{minor.value}"
        self.nvrtc = _Nvrtc.open()
        self.ready = True

    def compile(self, source: str, name: str) -> tuple[bytes, str]:
        assert self.nvrtc is not None
        return self.nvrtc.compile(source, name, self.arch)

    def load(self, image: bytes) -> ctypes.c_void_p:
        mod = ctypes.c_void_p()
        self.check(self.fn["cuModuleLoadData"](ctypes.byref(mod), ctypes.c_char_p(image)), "cuModuleLoadData")
        return mod

    def function(self, mod: ctypes.c_void_p, name: str) -> ctypes.c_void_p | None:
        fn = ctypes.c_void_p()
        if self.fn["cuModuleGetFunction"](ctypes.byref(fn), mod, name.encode()) != 0:
            return None
        return fn

    def launch(self, fn, grid, block, shared: int, params) -> None:
        if shared > 48 * 1024:
            self.check(self.fn["cuFuncSetAttribute"](fn, CU_FUNC_MAX_DYNAMIC_SHARED, shared), "cuFuncSetAttribute")
        self.check(self.fn["cuLaunchKernel"](fn, *grid, *block, shared, None, params, None), "cuLaunchKernel")
        self.check(self.fn["cuCtxSynchronize"](), "kernel run")

    def alloc(self, nbytes: int) -> int:
        ptr = ctypes.c_uint64()
        self.check(self.fn["cuMemAlloc_v2"](ctypes.byref(ptr), ctypes.c_size_t(max(nbytes, 1))), "cuMemAlloc")
        return ptr.value

    def free(self, ptr: int) -> None:
        self.fn["cuMemFree_v2"](ctypes.c_uint64(ptr))

    def to_device(self, ptr: int, host: ctypes.c_void_p, nbytes: int) -> None:
        self.check(self.fn["cuMemcpyHtoD_v2"](ctypes.c_uint64(ptr), host, ctypes.c_size_t(nbytes)), "cuMemcpyHtoD")

    def to_host(self, host: ctypes.c_void_p, ptr: int, nbytes: int) -> None:
        self.check(self.fn["cuMemcpyDtoH_v2"](host, ctypes.c_uint64(ptr), ctypes.c_size_t(nbytes)), "cuMemcpyDtoH")

    def fill(self, ptr: int, byte: int, nbytes: int) -> None:
        self.check(self.fn["cuMemsetD8_v2"](ctypes.c_uint64(ptr), ctypes.c_ubyte(byte), ctypes.c_size_t(nbytes)), "cuMemset")


class _Nvrtc:
    def __init__(self, lib: ctypes.CDLL):
        self.fn = {n: _bind(lib, "nvrtc", n) for n in CALLS["nvrtc"]}
        self.fn["nvrtcGetErrorString"].restype = ctypes.c_char_p

    @classmethod
    def open(cls) -> "_Nvrtc":
        lib = _open(_nvrtc_paths())
        if lib is None:
            raise GpuError("NVRTC not found: install nvidia-cuda-nvrtc-cu12 into this venv")
        return cls(lib)

    def compile(self, source: str, name: str, arch: str) -> tuple[bytes, str]:
        f = self.fn
        prog = ctypes.c_void_p()
        code = f["nvrtcCreateProgram"](ctypes.byref(prog), source.encode(), name.encode(), 0, None, None)
        if code != 0:
            raise CompileError(f"nvrtcCreateProgram: {f['nvrtcGetErrorString'](code).decode()}")
        try:
            opts = [f"--gpu-architecture={arch}".encode(), b"--std=c++17"]
            arr = (ctypes.c_char_p * len(opts))(*opts)
            result = f["nvrtcCompileProgram"](prog, len(opts), arr)
            size = ctypes.c_size_t()
            f["nvrtcGetProgramLogSize"](prog, ctypes.byref(size))
            buf = ctypes.create_string_buffer(size.value)
            f["nvrtcGetProgramLog"](prog, buf)
            log = buf.value.decode(errors="replace").strip()
            if result != 0:
                raise CompileError(f"{name}: {log or f['nvrtcGetErrorString'](result).decode()}")
            f["nvrtcGetCUBINSize"](prog, ctypes.byref(size))
            image = ctypes.create_string_buffer(size.value)
            f["nvrtcGetCUBIN"](prog, image)
            return image.raw, log
        finally:
            f["nvrtcDestroyProgram"](ctypes.byref(prog))


class _Hip(_Runtime):
    name = "hip"

    def __init__(self, lib: ctypes.CDLL):
        self.fn = {n: _bind(lib, "hip", n) for n in CALLS["hip"]}
        self.fn["hipGetErrorName"].restype = ctypes.c_char_p
        self.rtc: dict | None = None
        self.ready = False
        self.warp = 0

    def check(self, code: int, what: str) -> None:
        if code != 0:
            raise GpuError(f"{what} failed: {(self.fn['hipGetErrorName'](code) or b'?').decode()} ({code})")

    def devices(self) -> int:
        if self.fn["hipInit"](0) != 0:
            return 0
        count = ctypes.c_int(0)
        if self.fn["hipGetDeviceCount"](ctypes.byref(count)) != 0:
            return 0
        return count.value

    def start(self) -> None:
        if self.ready:
            return
        self.check(self.fn["hipInit"](0), "hipInit")
        self.check(self.fn["hipSetDevice"](0), "hipSetDevice")
        # ROCm 7's clang deprecates __AMDGCN_WAVEFRONT_SIZE, so WARP_SIZE comes from the device (D-237)
        warp = ctypes.c_int(0)
        self.check(self.fn["hipDeviceGetAttribute"](ctypes.byref(warp), HIP_ATTR_WARP_SIZE, 0), "warp size")
        if warp.value not in (32, 64):
            raise GpuError(f"unexpected warp size {warp.value}")
        self.warp = warp.value
        lib = _open(_hip_paths("hiprtc"))
        if lib is None:
            raise GpuError("hiprtc not found: install the AMD HIP SDK (HIP_PATH) or ROCm")
        self.rtc = {n: _bind(lib, "hiprtc", n) for n in CALLS["hiprtc"]}
        self.rtc["hiprtcGetErrorString"].restype = ctypes.c_char_p
        self.ready = True

    def compile(self, source: str, name: str) -> tuple[bytes, str]:
        assert self.rtc is not None
        f = self.rtc
        prog = ctypes.c_void_p()
        code = f["hiprtcCreateProgram"](ctypes.byref(prog), source.encode(), name.encode(), 0, None, None)
        if code != 0:
            raise CompileError(f"hiprtcCreateProgram: {f['hiprtcGetErrorString'](code).decode()}")
        try:
            # Without --offload-arch, hiprtc compiles for the current device's own gfx target.
            opts = [b"-std=c++17", f"-DGPU_WARP_SIZE={self.warp}".encode()]
            if os.environ.get("RLMH_GPU_ARCH"):
                opts.append(f"--offload-arch={os.environ['RLMH_GPU_ARCH']}".encode())
            arr = (ctypes.c_char_p * len(opts))(*opts)
            result = f["hiprtcCompileProgram"](prog, len(opts), arr)
            size = ctypes.c_size_t()
            f["hiprtcGetProgramLogSize"](prog, ctypes.byref(size))
            buf = ctypes.create_string_buffer(max(size.value, 1))
            f["hiprtcGetProgramLog"](prog, buf)
            log = buf.value.decode(errors="replace").strip()
            if result != 0:
                raise CompileError(f"{name}: {log or f['hiprtcGetErrorString'](result).decode()}")
            f["hiprtcGetCodeSize"](prog, ctypes.byref(size))
            image = ctypes.create_string_buffer(size.value)
            f["hiprtcGetCode"](prog, image)
            return image.raw, log
        finally:
            f["hiprtcDestroyProgram"](ctypes.byref(prog))

    def load(self, image: bytes) -> ctypes.c_void_p:
        mod = ctypes.c_void_p()
        self.check(self.fn["hipModuleLoadData"](ctypes.byref(mod), ctypes.c_char_p(image)), "hipModuleLoadData")
        return mod

    def function(self, mod: ctypes.c_void_p, name: str) -> ctypes.c_void_p | None:
        fn = ctypes.c_void_p()
        if self.fn["hipModuleGetFunction"](ctypes.byref(fn), mod, name.encode()) != 0:
            return None
        return fn

    def launch(self, fn, grid, block, shared: int, params) -> None:
        self.check(self.fn["hipModuleLaunchKernel"](fn, *grid, *block, shared, None, params, None),
                   "hipModuleLaunchKernel")
        self.check(self.fn["hipDeviceSynchronize"](), "kernel run")

    def alloc(self, nbytes: int) -> int:
        ptr = ctypes.c_void_p()
        self.check(self.fn["hipMalloc"](ctypes.byref(ptr), ctypes.c_size_t(max(nbytes, 1))), "hipMalloc")
        return ptr.value or 0

    def free(self, ptr: int) -> None:
        self.fn["hipFree"](ctypes.c_void_p(ptr))

    def to_device(self, ptr: int, host: ctypes.c_void_p, nbytes: int) -> None:
        self.check(self.fn["hipMemcpyHtoD"](ctypes.c_void_p(ptr), host, ctypes.c_size_t(nbytes)), "hipMemcpyHtoD")

    def to_host(self, host: ctypes.c_void_p, ptr: int, nbytes: int) -> None:
        self.check(self.fn["hipMemcpyDtoH"](host, ctypes.c_void_p(ptr), ctypes.c_size_t(nbytes)), "hipMemcpyDtoH")

    def fill(self, ptr: int, byte: int, nbytes: int) -> None:
        self.check(self.fn["hipMemset"](ctypes.c_void_p(ptr), ctypes.c_int(byte), ctypes.c_size_t(nbytes)), "hipMemset")


LOADERS = {
    "cuda": lambda: _open(_cuda_paths()),
    "hip": lambda: _open(_hip_paths("amdhip64")),
}
RUNTIMES = {"cuda": _Cuda, "hip": _Hip}


def _runtime_for(name: str) -> _Runtime | None:
    """The backend's runtime when it loads and reports at least one device, else None."""
    lib = LOADERS[name]()
    if lib is None:
        return None
    try:
        rt = RUNTIMES[name](lib)
        return rt if rt.devices() > 0 else None
    except (AttributeError, OSError, GpuError):
        return None


def pick(forced: str | None = None) -> _Runtime | None:
    """RLMH_GPU_BACKEND (or forced) checks only that backend; otherwise cuda, then hip."""
    choice = forced or os.environ.get("RLMH_GPU_BACKEND") or ""
    if choice and choice not in BACKENDS:
        raise GpuError(f"RLMH_GPU_BACKEND must be cuda or hip, not {choice!r}")
    for name in ([choice] if choice else BACKENDS):
        rt = _runtime_for(name)
        if rt is not None:
            return rt
    return None


_current: _Runtime | None = None


def _rt():
    global _current
    if _current is None:
        rt = pick()
        if rt is None:
            forced = os.environ.get("RLMH_GPU_BACKEND")
            raise GpuError(f"no {forced} GPU found" if forced else
                           "no GPU found: neither CUDA (NVIDIA driver) nor HIP (AMD HIP SDK or ROCm) reports a device")
        rt.start()
        _current = rt
    return _current


def backend() -> str:
    return _rt().name


# --- arrays ------------------------------------------------------------------------------------


class DeviceArray:
    def __init__(self, shape, dtype):
        import numpy as np

        self.shape = tuple(int(n) for n in (shape if isinstance(shape, (tuple, list)) else (shape,)))
        self.dtype = np.dtype(dtype)
        self.nbytes = int(np.prod(self.shape, dtype=np.int64)) * self.dtype.itemsize
        self._rt = _rt()
        self.ptr = self._rt.alloc(self.nbytes)

    def to_host(self):
        import numpy as np

        out = np.empty(self.shape, dtype=self.dtype)
        if self.nbytes:
            self._rt.to_host(out.ctypes.data_as(ctypes.c_void_p), self.ptr, self.nbytes)
        return out

    def free(self) -> None:
        if self.ptr:
            self._rt.free(self.ptr)
            self.ptr = 0

    def __del__(self):
        try:
            self.free()
        except Exception:
            pass


def to_device(array) -> DeviceArray:
    import numpy as np

    host = np.ascontiguousarray(array)
    dev = DeviceArray(host.shape, host.dtype)
    if dev.nbytes:
        dev._rt.to_device(dev.ptr, host.ctypes.data_as(ctypes.c_void_p), dev.nbytes)
    return dev


def empty(shape, dtype, fill: int | None = None) -> DeviceArray:
    """A device array; fill sets every byte (0xff makes fp32 NaN), so unwritten outputs show."""
    dev = DeviceArray(shape, dtype)
    if fill is not None and dev.nbytes:
        dev._rt.fill(dev.ptr, fill, dev.nbytes)
    return dev


# --- modules -----------------------------------------------------------------------------------


def _source(path: Path) -> str:
    """The prelude, then the kernel file, with #line so errors name the file."""
    prelude = (HERE / PRELUDE).read_text(encoding="utf-8")
    body = Path(path).read_text(encoding="utf-8")
    return f'{prelude}\n#line 1 "{Path(path).name}"\n{body}'


def _arg(value):
    import numpy as np

    if isinstance(value, DeviceArray):
        return ctypes.c_uint64(value.ptr)
    if isinstance(value, bool):
        raise TypeError("pass a bool as np.int32")
    if isinstance(value, int):
        if not -2**31 <= value < 2**31:
            raise OverflowError(f"{value} doesn't fit an int: pass np.int64 or np.uint64 for a 64-bit argument")
        return ctypes.c_int32(value)
    if isinstance(value, float):
        return ctypes.c_float(value)
    if isinstance(value, np.generic):
        kinds = {np.dtype(np.int32): ctypes.c_int32, np.dtype(np.uint32): ctypes.c_uint32,
                 np.dtype(np.int64): ctypes.c_int64, np.dtype(np.uint64): ctypes.c_uint64,
                 np.dtype(np.float32): ctypes.c_float, np.dtype(np.float64): ctypes.c_double,
                 np.dtype(np.uint16): ctypes.c_uint16, np.dtype(np.int16): ctypes.c_int16}
        if value.dtype not in kinds:
            raise TypeError(f"unsupported kernel argument dtype {value.dtype}")
        return kinds[value.dtype](value.item())
    raise TypeError(f"unsupported kernel argument {type(value).__name__}: pass a DeviceArray, int, float or numpy scalar")


class Module:
    """Kernels from one or more files, each compiled on its own with the prelude in front."""

    def __init__(self, paths):
        self._rt = _rt()
        self.logs: dict[str, str] = {}
        self._mods = []
        self._fns: dict[str, ctypes.c_void_p] = {}
        for path in paths:
            image, log = self._rt.compile(_source(Path(path)), Path(path).name)
            self.logs[str(path)] = log
            self._mods.append(self._rt.load(image))

    def function(self, name: str):
        if name not in self._fns:
            for mod in self._mods:
                fn = self._rt.function(mod, name)
                if fn is not None:
                    self._fns[name] = fn
                    break
            else:
                raise GpuError(f"no kernel named {name}")
        return self._fns[name]

    def launch(self, name: str, grid, block, args, shared: int = 0) -> None:
        grid3 = tuple(int(x) for x in ((list(grid) if isinstance(grid, (tuple, list)) else [grid]) + [1, 1])[:3])
        block3 = tuple(int(x) for x in ((list(block) if isinstance(block, (tuple, list)) else [block]) + [1, 1])[:3])
        if min(grid3) < 1 or min(block3) < 1:
            raise GpuError(f"{name}: grid {grid3} and block {block3} must be at least 1 in every dimension")
        values = [_arg(a) for a in args]
        params = (ctypes.c_void_p * max(len(values), 1))(*[ctypes.cast(ctypes.pointer(v), ctypes.c_void_p) for v in values])
        self._rt.launch(self.function(name), grid3, block3, int(shared), params)


def load(paths) -> Module:
    if isinstance(paths, (str, Path)):
        paths = [paths]
    return Module([Path(p) for p in paths])


def compile_check(paths, arch: str = "sm_80") -> dict[str, str]:
    """Compile each file for CUDA with NVRTC and no GPU; returns each file's log, raises CompileError."""
    nvrtc = _Nvrtc.open()
    if isinstance(paths, (str, Path)):
        paths = [paths]
    return {str(p): nvrtc.compile(_source(Path(p)), Path(p).name, arch)[1] for p in paths}


# --- probe ---------------------------------------------------------------------------------------


def probe(forced: str | None = None) -> tuple[str, int]:
    for name in ([forced] if forced else BACKENDS):
        lib = LOADERS[name]()
        if lib is None:
            continue
        try:
            n = RUNTIMES[name](lib).devices()
        except (AttributeError, OSError, GpuError):
            n = 0
        if n > 0:
            return name, n
    return "none", 0


def main(argv: list[str]) -> int:
    if argv[:1] != ["--probe"] or len(argv) not in (1, 3) or (len(argv) == 3 and (
            argv[1] != "--backend" or argv[2] not in BACKENDS)):
        print("usage: python gpu.py --probe [--backend cuda|hip]", file=sys.stderr)
        return 2
    forced = argv[2] if len(argv) == 3 else os.environ.get("RLMH_GPU_BACKEND") or None
    if forced and forced not in BACKENDS:
        forced = None
    name, n = probe(forced)
    print(f"backend={name} devices={n}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
