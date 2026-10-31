"""KV cache: none

The repository a repo-mode run works in: which shell `shell()` uses, a snapshot of the work tree at run start,
the diff against it at the end, a cheap fingerprint that tells whether a cell changed the tree, and removing a
folder git left read-only files in.

`fingerprint`, `CACHE_DIRS`, `CACHE_SUFFIXES` and `remove_tree` are copied from rlm_rl/editbox.py at RLM commit
0b9af69; `remove_tree` also clears read-only file bits, because git writes its object files read-only and Windows
will not delete those, and it never follows a symlink out of the tree. The snapshot and diff replace training's
host-side workspace cache: they use the recipe of rlm_rl/repl_tools.py's `diff()` (a copy of the index, so the
repository's own index is never touched), with new objects kept in the run's scratch folder so the repository's
object store, index and refs are never written. `worker/tools.py`'s `diff()` duplicates the recipe, because it
runs in the worker, which cannot import this module; a test holds the two to the same output.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import secrets
import shutil
import stat
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path

# Every snapshot and diff git call gets these (step 4 spec, "Snapshot and diff").
GIT_ARGS = ("-c", "safe.directory=*", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false",
            "-c", "core.safecrlf=false")
SNAPSHOT_OBJECTS = "git-objects"  # <scratch>/git-objects: the snapshot tree and every blob staged for it
_GIT_STORE_VARS = ("GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES")
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

POWERSHELL_FLAGS = ("-NoLogo", "-NoProfile", "-NonInteractive", "-Command")
_REJECTED_DIRS = frozenset({"system32", "windowsapps"})  # WSL's bash.exe launcher lives there (S-04)


@dataclass(frozen=True)
class ShellSpec:
    """The shell `shell(cmd)` runs `cmd` with: `[*argv, cmd]`. `name` is what the prompt and `rlmh setup` show."""

    kind: str  # "sh" | "bash" | "powershell"
    name: str
    argv: list[str]


def find_shell(*, which: Callable[[str], str | None] = shutil.which, env: Mapping[str, str] | None = None,
               platform: str = sys.platform) -> ShellSpec:
    """POSIX: sh. Windows: Git Bash if it can be found, else Windows PowerShell (4a, S-26).

    Git Bash is looked for next to `git` (each of git.exe's first three ancestor folders, `bin\\bash.exe` then
    `usr\\bin\\bash.exe`), then under %ProgramFiles%, %ProgramFiles(x86)% and %LocalAppData%\\Programs. It is never
    `which("bash")`, and a bash.exe under System32 or WindowsApps (the WSL launcher) is never used.
    """
    if platform != "win32":
        return ShellSpec("sh", "sh", ["sh", "-c"])
    upper = {k.upper(): v for k, v in (os.environ if env is None else env).items()}
    candidates: list[Path] = []
    git = which("git")
    if git:
        for folder in list(Path(git).parents)[:3]:
            candidates += [folder / "bin" / "bash.exe", folder / "usr" / "bin" / "bash.exe"]
    for var, sub in (("PROGRAMFILES", ()), ("PROGRAMFILES(X86)", ()), ("LOCALAPPDATA", ("Programs",))):
        if upper.get(var):
            candidates.append(Path(upper[var], *sub, "Git", "bin", "bash.exe"))
    for bash in candidates:
        if not _REJECTED_DIRS.intersection(part.lower() for part in bash.parts) and bash.is_file():
            return ShellSpec("bash", "Git Bash", [str(bash), "-c"])
    powershell = which("powershell")
    if not powershell and upper.get("SYSTEMROOT"):
        default = Path(upper["SYSTEMROOT"], "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        powershell = str(default) if default.is_file() else None
    return ShellSpec("powershell", "PowerShell", [powershell or "powershell.exe", *POWERSHELL_FLAGS])


# ----------------------------------------------------------------------------- snapshot and diff


def _git(args: list[str], cwd: Path, env: Mapping[str, str] | None = None) -> str:
    """Run git with GIT_ARGS; its stdout, decoded as tools._git decodes it. Raises RuntimeError when it fails."""
    full_env = {**(os.environ if env is None else env), "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1"}  # D-63
    done = subprocess.run(["git", *GIT_ARGS, *args], cwd=cwd, capture_output=True, env=full_env,
                          stdin=subprocess.DEVNULL, creationflags=_NO_WINDOW)
    if done.returncode != 0:
        raise RuntimeError(f"git {args[0]} failed: {done.stderr.decode(errors='replace').strip()[:500]}")
    return done.stdout.decode(errors="replace")


def _locate(repo: Path) -> tuple[str, str] | None:
    """(git dir, absolute objects folder) when `repo` is in a git work tree; None outside one or without git."""
    if shutil.which("git") is None:
        return None
    try:
        out = _git(["rev-parse", "--is-inside-work-tree", "--absolute-git-dir", "--git-path", "objects"], repo)
    except (RuntimeError, OSError):
        return None
    lines = out.splitlines()
    if len(lines) < 3 or lines[0] != "true":  # a bare repository, or inside .git
        return None
    return lines[1], os.path.normpath(os.path.join(repo, lines[2]))


def _stage(repo: Path, scratch: Path, git_dir: str, objects: str, index: Path) -> dict[str, str]:
    """Copy the repository's index to `index` and `git add -A -- .` into it, with new blobs in the scratch store.
    Returns the git environment that reads that index and store."""
    real = Path(git_dir, "index")
    if real.exists():
        # copy2 keeps the index's mtime, which git's racy-entry check needs: with a fresh mtime, a same-size edit
        # made in the same second as the entry's stat looks clean where git compares seconds (Windows) (D-64)
        shutil.copy2(real, index)
    store = scratch / SNAPSHOT_OBJECTS
    store.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k not in _GIT_STORE_VARS}
    env.update(GIT_INDEX_FILE=str(index), GIT_OBJECT_DIRECTORY=str(store), GIT_ALTERNATE_OBJECT_DIRECTORIES=objects)
    _git(["add", "-A", "--", "."], repo, env)
    return env


def snapshot(repo: Path, scratch: Path) -> str | None:
    """The work tree under `repo` as a git tree sha, written through a temporary index into `<scratch>/git-objects`
    (tracked and untracked files, minus what .gitignore excludes). None outside a git work tree or without git.

    The repository's index, refs and object store are never written. `scratch` must live for the whole run,
    because the tree exists only there. A git failure after the repository is found raises RuntimeError.
    """
    repo, scratch = Path(repo), Path(scratch)
    found = _locate(repo)
    if found is None:
        return None
    scratch.mkdir(parents=True, exist_ok=True)
    index = scratch / f"git-index-{secrets.token_hex(8)}"
    try:
        env = _stage(repo, scratch, *found, index)
        return _git(["write-tree"], repo, env).strip()
    finally:
        index.unlink(missing_ok=True)


def diff(repo: Path, base_tree: str, scratch: Path) -> str:
    """The work tree's change against `base_tree` (from `snapshot` with the same scratch) as a unified diff, new
    and deleted files included, paths relative to `repo`: the same text tools.diff() returns. Raises RuntimeError
    when `repo` is no longer in a git work tree or git fails."""
    repo, scratch = Path(repo), Path(scratch)
    found = _locate(repo)
    if found is None:
        raise RuntimeError(f"{repo} is not in a git work tree")
    index = scratch / f"git-index-{secrets.token_hex(8)}"
    try:
        env = _stage(repo, scratch, *found, index)
        return _git(["diff", "--cached", "--relative", "--no-color", "--no-ext-diff", base_tree, "--", "."], repo,
                    env)
    finally:
        index.unlink(missing_ok=True)


# ----------------------------------------------------------------------------- fingerprint and removal


# Build outputs and caches a test run writes into the repository: not an edit.
CACHE_DIRS = frozenset({"__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".hypothesis", ".tox", ".nox",
                        "node_modules", ".gradle", ".cache", "target", ".jest-cache", ".turbo", ".parcel-cache"})
CACHE_SUFFIXES = (".pyc", ".pyo")


def fingerprint(worktree: Path) -> str:
    """A cheap fingerprint of a work tree's files (paths, sizes, modes and modification times), with .git, build
    outputs and caches left out. A cell that changes it edited the repository."""
    h = hashlib.sha1()
    for dirpath, dirnames, filenames in os.walk(worktree):
        dirnames[:] = sorted(d for d in dirnames if d not in CACHE_DIRS
                             and not (dirpath == str(worktree) and d == ".git"))
        for name in sorted(filenames):
            if name.endswith(CACHE_SUFFIXES):
                continue
            path = os.path.join(dirpath, name)
            try:
                st = os.lstat(path)
            except OSError:
                continue
            h.update(f"{os.path.relpath(path, worktree)}\0{st.st_size}\0{st.st_mtime_ns}\0{st.st_mode}\n".encode(
                "utf-8", "replace"))
    return h.hexdigest()


def remove_tree(path: Path) -> None:
    """Remove an episode folder. The model may have made folders it can't be removed from; fix their modes first.
    Read-only files too: git writes its object files read-only, and Windows won't delete a read-only file.
    Symlinks are left alone, so a link to something outside the folder never changes that thing's mode."""
    path = Path(path)
    if not path.exists():
        return
    try:
        shutil.rmtree(path)
        return
    except OSError:
        pass
    with contextlib.suppress(OSError):
        os.chmod(path, 0o700)
    for dirpath, dirnames, filenames in os.walk(path):
        for d in dirnames:
            _make_writable(os.path.join(dirpath, d), 0o700)
        for f in filenames:
            _make_writable(os.path.join(dirpath, f), stat.S_IREAD | stat.S_IWRITE)
    shutil.rmtree(path, ignore_errors=True)


def _make_writable(path: str, mode: int) -> None:
    if os.path.islink(path) or os.path.isjunction(path):  # os.chmod follows links; Linux has no lchmod
        return
    with contextlib.suppress(OSError):
        os.chmod(path, mode)
