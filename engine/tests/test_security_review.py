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


# ----------------------------------------------------------------------------- SR-2: writes under .git


@needs_git
@pytest.mark.parametrize("code", [
    "open('.git/hooks/pre-commit', 'w').write('#!/bin/sh\\necho pwned\\n')",
    "open('.git/config', 'a').write('[core]\\n\\tfsmonitor = echo pwned\\n')",
    "import os\nos.makedirs('.git/hooks', exist_ok=True)\nos.rename('a.py', '.git/hooks/post-checkout')",
], ids=["hook", "config", "rename-in"])
def test_sr2_accept_edits_asks_before_a_write_under_the_git_dir(tmp_path: Path, git_repo: Path, code: str) -> None:
    """SR-2: accept-edits lets writes inside the workspace through without asking, but a write under `.git/` is
    not an edit of the repository: it changes what the user's own git runs next (hooks, fsmonitor, aliases).
    Such a write asks, and a denial leaves `.git` as it was."""
    before = sorted(p.relative_to(git_repo) for p in (git_repo / ".git").rglob("*"))

    async def main() -> None:
        async with real_run(tmp_path, "accept-edits", DENY, repo=git_repo) as r:
            result = await r.worker.run_cell(code)
            asked = [(a["kind"], a["inside_workspace"]) for a in r.app.approvals]
            assert asked == [("write", False)], (asked, result.error)
            assert "Permission denied" in (result.error or "")

    run(main(), 60)
    after = sorted(p.relative_to(git_repo) for p in (git_repo / ".git").rglob("*"))
    assert after == before
    assert (git_repo / "a.py").exists()


@needs_git
def test_sr2_ordinary_inside_writes_still_pass_silently(tmp_path: Path, git_repo: Path) -> None:
    """The SR-2 rule touches only `.git`: a folder merely named like it elsewhere, and every other inside write,
    still goes through without a prompt under accept-edits."""

    async def main() -> None:
        async with real_run(tmp_path, "accept-edits", DENY, repo=git_repo) as r:
            result = await r.worker.run_cell(
                "import os\nos.makedirs('src/gitstuff', exist_ok=True)\nopen('src/gitstuff/.gitignore', 'w').write('x')\n"
                "open('notes.git.txt', 'w').write('y')\nprint(write_file('src/b.py', 'z'))")
            assert result.error is None, result.error
            assert r.app.approvals == []

    run(main(), 60)
    assert (git_repo / "src" / "b.py").read_text() == "z"
