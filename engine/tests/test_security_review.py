"""KV cache: none

Regression tests from the 2026-11 security review (SECURITY_REVIEW.md). Each test names its finding.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest
from conftest import needs_git, run
from test_permissions import ALLOW, DENY, real_run

from rlm_engine.worker import tools as rt

POSIX = sys.platform != "win32"
SH = {"kind": "sh", "argv": ["sh", "-c"]}


@pytest.fixture(autouse=True)
def reset_tools():
    yield
    rt.configure()


# ----------------------------------------------------------------------------- SR-1: the tools' quiet git


@pytest.mark.skipif(not POSIX, reason="a #!/bin/sh program on PATH")
@needs_git
def test_sr1_tools_git_is_not_taken_from_a_path_the_cell_changed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """SR-1: `_git` runs quietly (no approval), so the program it runs must be the git found when the tools were
    configured, not whatever a later `os.environ["PATH"]` puts first."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "a.py").write_text("x = 1\n")
    rt.configure(root=str(root), shell=SH)
    marker = tmp_path / "fake-git-ran"
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    fake = fake_bin / "git"
    fake.write_text(f"#!/bin/sh\necho ran > {marker}\nexit 1\n")
    fake.chmod(0o755)
    monkeypatch.setenv("PATH", f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}")
    rt.find_files("*.py")
    assert not marker.exists(), "the tools ran a git the cell put on PATH, with no approval"


@needs_git
def test_sr1_tools_git_runs_with_the_configure_time_environment(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """SR-1: a variable the cell sets after the tools were configured (LD_PRELOAD, GIT_EXEC_PATH, PATH) never
    reaches the quiet git, and git's own path is the one resolved at configure time."""
    root = tmp_path / "root"
    root.mkdir()
    (root / "a.py").write_text("x = 1\n")
    monkeypatch.delenv("RLMH_SET_LATER", raising=False)
    rt.configure(root=str(root), shell=SH)
    expected_git = rt.shutil.which("git")
    seen: list[dict] = []
    real_run_ = subprocess.run

    def spy(argv, *args, **kwargs):
        seen.append({"argv": list(argv), "env": dict(kwargs.get("env") or {})})
        return real_run_(argv, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", spy)
    monkeypatch.setenv("RLMH_SET_LATER", "1")
    rt.find_files("*.py")
    assert seen, "git was not run"
    for call in seen:
        assert call["argv"][0] == expected_git
        assert "RLMH_SET_LATER" not in call["env"]
