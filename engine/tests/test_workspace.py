"""KV cache: none

workspace.py: find_shell (the Windows lookup tested entirely with a faked `which`, environment and platform over
a fake tree in tmp_path), the snapshot that never writes the repository, the diff that matches tools.diff(),
fingerprint, and remove_tree. Tests that need git skip without it.
"""

from __future__ import annotations

import os
import re
import stat
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import git, needs_git

from rlm_engine import workspace as ws
from rlm_engine.workspace import ShellSpec
from rlm_engine.worker import tools as rt

SHA = re.compile(r"[0-9a-f]{40}([0-9a-f]{24})?")
PS_FLAGS = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]


# ----------------------------------------------------------------------------- find_shell


def touch(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"")
    return path


def fake_which(table: dict[str, Path | None], asked: list[str]) -> Callable[[str], str | None]:
    def which(name: str) -> str | None:
        asked.append(name)
        found = table.get(name)
        return str(found) if found else None
    return which


def windows_shell(tmp_path: Path, *, git: Path | None = None, env: dict[str, str] | None = None,
                  powershell: Path | None = None) -> tuple[ShellSpec, list[str]]:
    asked: list[str] = []
    spec = ws.find_shell(which=fake_which({"git": git, "powershell": powershell}, asked), env=env or {},
                         platform="win32")
    assert set(asked) <= {"git", "powershell"}, "never which('bash'): that finds WSL's launcher"
    return spec, asked


def git_bash(path: Path) -> ShellSpec:
    return ShellSpec("bash", "Git Bash", [str(path), "-c"])


def test_posix_is_sh() -> None:
    for platform in ("linux", "darwin"):
        assert ws.find_shell(platform=platform) == ShellSpec("sh", "sh", ["sh", "-c"])
    if sys.platform != "win32":
        assert ws.find_shell() == ShellSpec("sh", "sh", ["sh", "-c"])


def test_git_bash_next_to_git_cmd(tmp_path: Path) -> None:
    git = touch(tmp_path / "Git" / "cmd" / "git.exe")
    bash = touch(tmp_path / "Git" / "bin" / "bash.exe")
    assert windows_shell(tmp_path, git=git)[0] == git_bash(bash)


def test_git_bash_from_mingw64_bin(tmp_path: Path) -> None:
    git = touch(tmp_path / "Personal" / "Git" / "mingw64" / "bin" / "git.exe")
    bash = touch(tmp_path / "Personal" / "Git" / "bin" / "bash.exe")
    assert windows_shell(tmp_path, git=git)[0] == git_bash(bash)


def test_bin_bash_before_usr_bin_bash(tmp_path: Path) -> None:
    git = touch(tmp_path / "Git" / "cmd" / "git.exe")
    usr = touch(tmp_path / "Git" / "usr" / "bin" / "bash.exe")
    assert windows_shell(tmp_path, git=git)[0] == git_bash(usr)
    bin_bash = touch(tmp_path / "Git" / "bin" / "bash.exe")
    assert windows_shell(tmp_path, git=git)[0] == git_bash(bin_bash)


def test_only_three_ancestors_of_git(tmp_path: Path) -> None:
    git = touch(tmp_path / "Git" / "a" / "b" / "c" / "git.exe")  # ancestors c, b, a: Git is the fourth
    touch(tmp_path / "Git" / "bin" / "bash.exe")
    ps = touch(tmp_path / "ps" / "powershell.exe")
    assert windows_shell(tmp_path, git=git, powershell=ps)[0].kind == "powershell"


@pytest.mark.parametrize("var, sub", [("ProgramFiles", ()), ("ProgramFiles(x86)", ()),
                                      ("LocalAppData", ("Programs",)), ("PROGRAMFILES", ())])
def test_git_bash_under_program_folders(tmp_path: Path, var: str, sub: tuple[str, ...]) -> None:
    base = tmp_path / "pf"
    bash = touch(base.joinpath(*sub, "Git", "bin", "bash.exe"))
    assert windows_shell(tmp_path, env={var: str(base)})[0] == git_bash(bash)


def test_system32_and_windowsapps_bash_are_rejected(tmp_path: Path) -> None:
    ps = touch(tmp_path / "ps" / "powershell.exe")
    # git.exe found in System32 or WindowsApps, with a bash.exe "next to it"
    for folder in (tmp_path / "Windows" / "System32", tmp_path / "Local" / "Microsoft" / "WindowsApps",
                   tmp_path / "Windows" / "system32"):
        git = touch(folder / "git.exe")
        touch(folder / "bin" / "bash.exe")
        touch(folder / "usr" / "bin" / "bash.exe")
        assert windows_shell(tmp_path, git=git, powershell=ps)[0].kind == "powershell", folder
    # a program folder variable that points into System32
    touch(tmp_path / "Windows" / "System32" / "Git" / "bin" / "bash.exe")
    spec, _ = windows_shell(tmp_path, env={"ProgramFiles": str(tmp_path / "Windows" / "System32")}, powershell=ps)
    assert spec.kind == "powershell"


def test_no_git_bash_gives_powershell(tmp_path: Path) -> None:
    ps = touch(tmp_path / "ps" / "powershell.exe")
    spec, asked = windows_shell(tmp_path, powershell=ps)
    assert spec == ShellSpec("powershell", "PowerShell", [str(ps), *PS_FLAGS])
    assert asked == ["git", "powershell"]
    # not on PATH: the copy under %SystemRoot%, else the bare name
    default = touch(tmp_path / "Windows" / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
    spec, _ = windows_shell(tmp_path, env={"SystemRoot": str(tmp_path / "Windows")})
    assert spec.argv == [str(default), *PS_FLAGS]
    assert windows_shell(tmp_path / "nowhere")[0].argv == ["powershell.exe", *PS_FLAGS]


def test_shell_spec_is_frozen() -> None:
    spec = ws.find_shell(platform="linux")
    with pytest.raises(AttributeError):
        spec.kind = "bash"  # type: ignore[misc]


# ----------------------------------------------------------------------------- snapshot


def store_env(repo: Path, scratch: Path) -> dict[str, str]:
    """A git environment that can read the snapshot's objects as well as the repository's."""
    return {**os.environ, "GIT_OBJECT_DIRECTORY": str(scratch / ws.SNAPSHOT_OBJECTS),
            "GIT_ALTERNATE_OBJECT_DIRECTORIES": str(repo / ".git" / "objects")}


def tree_files(repo: Path, scratch: Path, tree: str) -> list[str]:
    done = subprocess.run(["git", "ls-tree", "-r", "--name-only", tree], cwd=repo, capture_output=True, check=True,
                          env=store_env(repo, scratch))
    return done.stdout.decode("utf-8").splitlines()


def repo_state(repo: Path) -> tuple:
    index = repo / ".git" / "index"
    return (git(repo, "--no-optional-locks", "status", "--porcelain"),
            git(repo, "count-objects", "-v"),
            git(repo, "for-each-ref"),
            index.stat().st_mtime_ns, index.read_bytes(),
            sorted(str(p.relative_to(repo / ".git")) for p in (repo / ".git").rglob("*")))


@needs_git
def test_snapshot_is_a_tree_sha_and_never_writes_the_repository(git_repo: Path, tmp_path: Path) -> None:
    (git_repo / "a.py").write_bytes(b"x = 2\n")  # modified
    (git_repo / "new.py").write_bytes(b"n = 1\n")  # untracked
    (git_repo / "build").mkdir()
    (git_repo / "build" / "out.txt").write_bytes(b"ignored\n")
    before = repo_state(git_repo)
    scratch = tmp_path / "scratch"
    tree = ws.snapshot(git_repo, scratch)
    assert tree is not None and SHA.fullmatch(tree)
    assert repo_state(git_repo) == before
    files = tree_files(git_repo, scratch, tree)
    assert "new.py" in files, "untracked files are in"
    assert "build/out.txt" not in files, "ignored files are out"
    assert set(files) == {".gitignore", "README.md", "a.py", "new.py", "pkg/core.py"}
    assert subprocess.run(["git", "cat-file", "-e", tree], cwd=git_repo, capture_output=True).returncode != 0, \
        "the tree lives only in the scratch store"
    assert [p.name for p in scratch.iterdir()] == [ws.SNAPSHOT_OBJECTS], "the temporary index is removed"


@needs_git
def test_snapshot_from_a_subfolder(git_repo: Path, tmp_path: Path) -> None:
    (git_repo / "pkg" / "extra.py").write_bytes(b"e = 1\n")
    scratch = tmp_path / "scratch"
    whole = ws.snapshot(git_repo, scratch)
    sub = ws.snapshot(git_repo / "pkg", scratch)
    assert sub is not None and sub == whole  # the whole repository's tree, staged from the subfolder
    assert "pkg/extra.py" in tree_files(git_repo, scratch, sub)
    (git_repo / "pkg" / "core.py").write_bytes(b"def parse(x):\n    return x + 1\n")
    (git_repo / "a.py").write_bytes(b"x = 3\n")  # outside the subfolder: not in its diff
    d = ws.diff(git_repo / "pkg", sub, scratch)
    assert "--- a/core.py" in d and "+    return x + 1" in d
    assert "x = 3" not in d


@needs_git
def test_snapshot_none_outside_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    monkeypatch.setenv("GIT_CEILING_DIRECTORIES", str(tmp_path))
    assert ws.snapshot(plain, tmp_path / "scratch") is None


def test_snapshot_none_without_git(git_repo_or_plain: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    empty = tmp_path / "empty-path"
    empty.mkdir()
    monkeypatch.setenv("PATH", str(empty))
    assert ws.snapshot(git_repo_or_plain, tmp_path / "scratch") is None


@pytest.fixture
def git_repo_or_plain(tmp_path: Path) -> Path:
    """A repository when git exists (so only the missing git makes snapshot() give None), else a plain folder."""
    folder = tmp_path / "work"
    folder.mkdir()
    if ws.shutil.which("git"):
        git(folder, "init", "-q")
    return folder


@needs_git
def test_snapshot_none_for_a_non_work_tree(git_repo: Path, tmp_path: Path) -> None:
    bare = tmp_path / "bare.git"
    bare.mkdir()
    git(bare, "init", "-q", "--bare")
    assert ws.snapshot(bare, tmp_path / "s1") is None
    assert ws.snapshot(git_repo / ".git", tmp_path / "s2") is None


@needs_git
def test_snapshot_of_a_repository_without_commits(tmp_path: Path) -> None:
    repo = tmp_path / "fresh"
    repo.mkdir()
    git(repo, "init", "-q")
    (repo / "f.txt").write_bytes(b"f\n")
    scratch = tmp_path / "scratch"
    tree = ws.snapshot(repo, scratch)
    assert tree is not None and tree_files(repo, scratch, tree) == ["f.txt"]
    assert not (repo / ".git" / "index").exists()
    (repo / "f.txt").write_bytes(b"g\n")
    assert "-f\n+g" in ws.diff(repo, tree, scratch)


# ----------------------------------------------------------------------------- diff


def tools_diff(repo: Path, tree: str, scratch: Path) -> str:
    rt.configure(root=str(repo), base=tree, scratch=str(scratch))
    try:
        return rt.diff()
    finally:
        rt.configure()


@needs_git
def test_diff_shows_modified_new_and_deleted_and_equals_tools_diff(git_repo: Path, tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    tree = ws.snapshot(git_repo, scratch)
    assert tree is not None
    assert ws.diff(git_repo, tree, scratch) == ""
    (git_repo / "a.py").write_bytes(b"x = 2\n")
    (git_repo / "new.py").write_bytes(b"n = 1\n")
    (git_repo / "README.md").unlink()
    (git_repo / "build").mkdir()
    (git_repo / "build" / "out.txt").write_bytes(b"ignored\n")
    before = repo_state(git_repo)
    d = ws.diff(git_repo, tree, scratch)
    assert "--- a/a.py\n+++ b/a.py" in d and "-x = 1\n+x = 2" in d
    assert "new file mode" in d and "+++ b/new.py" in d
    assert "deleted file mode" in d and "--- a/README.md" in d
    assert "build/out.txt" not in d
    assert repo_state(git_repo) == before
    assert tools_diff(git_repo, tree, scratch) == d
    assert sorted(p.name for p in scratch.iterdir()) == [ws.SNAPSHOT_OBJECTS]


@needs_git
def test_diff_sees_through_a_commit(git_repo: Path, tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    tree = ws.snapshot(git_repo, scratch)
    assert tree is not None
    (git_repo / "a.py").write_bytes(b"x = 2\n")
    git(git_repo, "commit", "-qam", "mine")
    assert "+x = 2" in ws.diff(git_repo, tree, scratch)
    assert tools_diff(git_repo, tree, scratch) == ws.diff(git_repo, tree, scratch)


@needs_git
def test_diff_survives_autocrlf(git_repo: Path, tmp_path: Path) -> None:
    """A Windows checkout: core.autocrlf=true, CRLF in the work tree, LF in the repository."""
    (git_repo / "c.txt").write_bytes(b"one\ntwo\nthree\n")
    git(git_repo, "add", "c.txt")
    git(git_repo, "commit", "-qm", "c")
    subprocess.run(["git", "config", "core.autocrlf", "true"], cwd=git_repo, check=True)
    (git_repo / "c.txt").write_bytes(b"one\r\ntwo\r\nthree\r\n")
    scratch = tmp_path / "scratch"
    tree = ws.snapshot(git_repo, scratch)
    assert tree is not None
    assert ws.diff(git_repo, tree, scratch) == ""
    (git_repo / "c.txt").write_bytes(b"one\r\nTWO\r\nthree\r\n")
    d = ws.diff(git_repo, tree, scratch)
    assert "-two\n+TWO\n" in d and "\r" not in d
    assert tools_diff(git_repo, tree, scratch) == d


# ----------------------------------------------------------------------------- fingerprint and remove_tree


def test_fingerprint_changes_on_edits_and_ignores_caches(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    touch(tree / "a.py").write_bytes(b"x = 1\n")
    first = ws.fingerprint(tree)
    assert ws.fingerprint(tree) == first
    for rel in (".git/index", "__pycache__/a.cpython-312.pyc", "pkg/b.pyc", "node_modules/dep/index.js",
                "pkg/__pycache__/c.pyc"):
        touch(tree / rel).write_bytes(b"cache")
    assert ws.fingerprint(tree) == first
    (tree / "a.py").write_bytes(b"x = 22\n")
    edited = ws.fingerprint(tree)
    assert edited != first
    touch(tree / "pkg" / "new.py")
    assert ws.fingerprint(tree) != edited
    assert "pkg/new.py" not in ws.CACHE_DIRS and ".pyc" in ws.CACHE_SUFFIXES


def test_fingerprint_sees_a_same_size_edit(tmp_path: Path) -> None:
    tree = tmp_path / "tree"
    path = touch(tree / "a.py")
    path.write_bytes(b"x = 1\n")
    os.utime(path, ns=(1_000_000_000, 1_000_000_000))
    first = ws.fingerprint(tree)
    path.write_bytes(b"x = 2\n")
    os.utime(path, ns=(2_000_000_000, 2_000_000_000))
    assert ws.fingerprint(tree) != first


def test_remove_tree_clears_read_only_bits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The first rmtree fails (as it does on Windows for git's read-only object files), so the fallback runs."""
    target = tmp_path / "scratch"
    obj = touch(target / "git-objects" / "ab" / "cdef")
    obj.chmod(stat.S_IREAD)
    locked = target / "locked"
    touch(locked / "f.txt")
    outside = touch(tmp_path / "outside.txt")
    outside.chmod(0o755)
    outside_mode = outside.stat().st_mode
    try:
        (target / "link").symlink_to(outside)
    except OSError:  # Windows without the symlink privilege
        pass
    locked.chmod(stat.S_IREAD | stat.S_IEXEC)
    real_rmtree = ws.shutil.rmtree
    calls: list[bool] = []

    def rmtree(path: Path, ignore_errors: bool = False, **kwargs: object) -> None:
        calls.append(ignore_errors)
        if len(calls) == 1:
            raise PermissionError(13, "Access is denied", str(path))
        real_rmtree(path, ignore_errors=ignore_errors, **kwargs)

    monkeypatch.setattr(ws.shutil, "rmtree", rmtree)
    ws.remove_tree(target)
    assert calls == [False, True]
    assert not target.exists()
    assert outside.exists() and outside.stat().st_mode == outside_mode, "a symlink's target is never chmodded"
    ws.remove_tree(target)  # gone already: no error


def test_remove_tree_plain(tmp_path: Path) -> None:
    target = tmp_path / "t"
    obj = touch(target / "o" / "x")
    obj.chmod(stat.S_IREAD)
    ws.remove_tree(target)
    assert not target.exists()
