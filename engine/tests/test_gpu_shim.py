"""KV cache: none

The GPU shim the kernel eval tasks carry (app/test/fixtures/evalset/gpu/, D-223, D-226), on its no-GPU path: the
probe's one-line shape, the backend choice with fake runtimes, and the allowlist that keeps every C call away from a
device's name, UUID, serial or driver version. Step 2 owns the shim; these run on every CI OS, which has no GPU.
"""

from __future__ import annotations

import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest

SHIM = Path(__file__).resolve().parents[2] / "app" / "test" / "fixtures" / "evalset" / "gpu"


@pytest.fixture()
def gpu(monkeypatch):
    monkeypatch.delenv("RLMH_GPU_BACKEND", raising=False)
    spec = importlib.util.spec_from_file_location("gpu_shim_under_test", SHIM / "gpu.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def rig(gpu, monkeypatch, cuda: int | None, hip: int | None) -> None:
    """None: the backend's runtime doesn't load; a number: how many devices it reports."""

    class Rt:
        def __init__(self, name: str, n: int):
            self.name, self.n = name, n

        def devices(self) -> int:
            return self.n

    loaders = {name: (lambda n=n: None if n is None else object()) for name, n in (("cuda", cuda), ("hip", hip))}
    runtimes = {"cuda": lambda lib: Rt("cuda", cuda), "hip": lambda lib: Rt("hip", hip)}
    monkeypatch.setattr(gpu, "LOADERS", loaders)
    monkeypatch.setattr(gpu, "RUNTIMES", runtimes)


def test_probe_prints_one_line():
    out = subprocess.run([sys.executable, "-I", str(SHIM / "gpu.py"), "--probe"], capture_output=True, text=True,
                         timeout=60)
    assert out.returncode == 0
    assert re.fullmatch(r"backend=(cuda|hip|none) devices=\d+\n", out.stdout)
    bad = subprocess.run([sys.executable, "-I", str(SHIM / "gpu.py"), "--probe", "--backend", "metal"],
                         capture_output=True, text=True, timeout=60)
    assert bad.returncode == 2 and bad.stdout == ""


def test_backend_choice(gpu, monkeypatch):
    rig(gpu, monkeypatch, 1, 1)
    assert gpu.pick().name == "cuda" and gpu.probe() == ("cuda", 1)
    rig(gpu, monkeypatch, None, 2)
    assert gpu.pick().name == "hip" and gpu.probe() == ("hip", 2)
    rig(gpu, monkeypatch, 0, 1)
    assert gpu.pick().name == "hip"
    rig(gpu, monkeypatch, 0, None)
    assert gpu.pick() is None and gpu.probe() == ("none", 0)
    with pytest.raises(gpu.GpuError, match="no GPU found"):
        gpu.backend()
    rig(gpu, monkeypatch, 1, 1)
    monkeypatch.setenv("RLMH_GPU_BACKEND", "hip")
    assert gpu.pick().name == "hip"
    rig(gpu, monkeypatch, 1, None)
    assert gpu.pick() is None


def test_calls_stay_in_the_allowlist(gpu):
    names = [n for group in gpu.CALLS.values() for n in group]
    for n in names:
        assert not re.search(r"Name|Uuid|UUID|Serial|PCIBus|Version|Properties|nvml", n) or n.endswith("GetErrorName"), n
    with pytest.raises(gpu.GpuError):
        gpu._bind(object(), "cuda", "cuDeviceGetName")
    src = (SHIM / "gpu.py").read_text(encoding="utf-8")
    for call in ("cuDeviceGetName", "cuDeviceGetUuid", "cuDriverGetVersion", "hipGetDeviceProperties",
                 "hipDeviceGetName", "hipDriverGetVersion", "nvidia-smi"):
        assert call not in src


def test_prelude_names():
    text = (SHIM / "gpu_compat.h").read_text(encoding="utf-8")
    assert text.startswith("// KV cache: none.")
    for name in ("GPU_KERNEL", "LAUNCH_BOUNDS", "WARP_SIZE", "shfl_down", "shfl_xor", "warp_ballot", "GPU_INFINITY",
                 "GPU_NAN", "h2f", "f2h", "GPU_BACKEND_HIP", "GPU_BACKEND_CUDA"):
        assert name in text
    assert not re.search(r"^\s*#\s*include", text, re.M)  # the prelude needs no header on either compiler
    assert "\r" not in text
