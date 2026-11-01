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

Snapshot and diff run before and after the permission system's reach, so they run no program the repository's
config names: every filter driver is switched off (`no_filters`) and the diff takes `--no-textconv` and
`--no-ext-diff`. Each git call has a time limit (GIT_TIMEOUT_S), and a `GitControl` lets the loop kill it on cancel.
"""

from __future__ import annotations

import contextlib
import hashlib
import os
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Every snapshot and diff git call gets these (step 4 spec, "Snapshot and diff").
GIT_ARGS = ("-c", "safe.directory=*", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false",
            "-c", "core.safecrlf=false")
SNAPSHOT_OBJECTS = "git-objects"  # <scratch>/git-objects: the snapshot tree and every blob staged for it
_GIT_STORE_VARS = ("GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES")
DIFF_ARGS = ("--no-color", "--no-ext-diff", "--no-textconv")  # no program the config names runs for the diff
_FILTER_OFF = (("clean", ""), ("smudge", ""), ("process", ""), ("required", "false"))  # per driver (no_filters)
GIT_TIMEOUT_S = 300  # one snapshot or diff git call; a hung git stops the run instead of holding it
GIT_REAP_S = 5  # after a kill, how long to wait for git to go
GIT_POLL_S = 0.1  # how often a git call checks for an abort
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


class GitControl:
    """Lets another thread stop the git calls of one snapshot or diff: after `abort`, the git call running is killed
    (with its children) within GIT_POLL_S and no later one starts, so a cancelled run never leaves git behind it.
    `abort` is safe from any thread and never blocks. The loop owns one per call."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.aborted = False

    def abort(self) -> None:
        with self._lock:
            self.aborted = True

    def _start(self, argv: list[str], **kwargs: Any) -> subprocess.Popen:
        with self._lock:  # an abort either comes first and stops this start, or sees the process the poll will kill
            if self.aborted:
                raise RuntimeError(f"git {argv[len(GIT_ARGS) + 1]} cancelled")
            return subprocess.Popen(argv, **kwargs)


def _kill(proc: subprocess.Popen) -> None:
    """Kill git and whatever it started (a hook-like helper, an alias's shell): its process group on POSIX, where git
    runs as a group leader; taskkill /T, which follows parent ids, on Windows, where killing git alone would leave a
    child holding its output pipes open."""
    if sys.platform != "win32":
        with contextlib.suppress(OSError):
            os.killpg(proc.pid, signal.SIGKILL)
        return
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, stdin=subprocess.DEVNULL,
                       creationflags=_NO_WINDOW, timeout=GIT_REAP_S)
    with contextlib.suppress(OSError):
        proc.kill()


def _git(args: list[str], cwd: Path, env: Mapping[str, str] | None = None, control: GitControl | None = None,
         ok: tuple[int, ...] = (0,)) -> str:
    """Run git with GIT_ARGS; its stdout, decoded as tools._git decodes it. Raises RuntimeError when it fails, takes
    longer than GIT_TIMEOUT_S, or `control` aborts it; in each case git has been killed and reaped first."""
    full_env = {**(os.environ if env is None else env), "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1"}  # D-63
    control = control if control is not None else GitControl()
    proc = control._start(["git", *GIT_ARGS, *args], cwd=cwd, env=full_env, stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, creationflags=_NO_WINDOW,
                          start_new_session=sys.platform != "win32")
    deadline = time.monotonic() + GIT_TIMEOUT_S
    try:
        while True:
            try:  # in slices, so an abort is seen even while git's output is still open
                stdout, stderr = proc.communicate(timeout=GIT_POLL_S)
                break
            except subprocess.TimeoutExpired:
                if control.aborted or time.monotonic() >= deadline:
                    _kill(proc)
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        proc.communicate(timeout=GIT_REAP_S)
                    if control.aborted:
                        raise RuntimeError(f"git {args[0]} cancelled") from None
                    raise RuntimeError(f"git {args[0]} timed out after {GIT_TIMEOUT_S:g} s") from None
    finally:
        if proc.poll() is None:  # an exception (KeyboardInterrupt) cut the wait short
            _kill(proc)
            with contextlib.suppress(subprocess.TimeoutExpired):
                proc.wait(GIT_REAP_S)
    if control.aborted:
        raise RuntimeError(f"git {args[0]} cancelled")
    if proc.returncode not in ok:
        raise RuntimeError(f"git {args[0]} failed: {stderr.decode(errors='replace').strip()[:500]}")
    return stdout.decode(errors="replace")


def _locate(repo: Path, control: GitControl | None = None) -> tuple[str, str] | None:
    """(git dir, absolute objects folder) when `repo` is in a git work tree; None outside one or without git."""
    if shutil.which("git") is None:
        return None
    try:
        out = _git(["rev-parse", "--is-inside-work-tree", "--absolute-git-dir", "--git-path", "objects"], repo,
                   control=control)
    except RuntimeError:
        if control is not None and control.aborted:
            raise
        return None
    except OSError:
        return None
    lines = out.splitlines()
    if len(lines) < 3 or lines[0] != "true":  # a bare repository, or inside .git
        return None
    return lines[1], os.path.normpath(os.path.join(repo, lines[2]))


def no_filters(repo: Path, env: Mapping[str, str], control: GitControl | None = None) -> dict[str, str]:
    """`env` with every configured filter driver switched off, so staging hashes the work tree's own bytes and never
    runs a program the repository's config names (a clean filter, or a long-running `process` one).

    The driver names come from `git config` (every scope, includes followed); each gets `clean`, `smudge` and
    `process` set to "" (git runs no command for an empty one) and `required` to false (a required driver with no
    command would fail the add). The settings go in GIT_CONFIG_COUNT/KEY_n/VALUE_n, which carry a key and a value
    apart, so a driver name holding `=` or `.` is still exact; they follow any set already in `env`, and a later
    entry wins. GIT_CONFIG_PARAMETERS, which git reads after them, is dropped."""
    env = {k: v for k, v in env.items() if k != "GIT_CONFIG_PARAMETERS"}
    listed = _git(["config", "-z", "--name-only", "--get-regexp", r"^filter\."], repo, env, control, ok=(0, 1))
    drivers = sorted({key[len("filter."):key.rindex(".")] for key in listed.split("\0") if key.count(".") >= 2})
    try:
        count = int(env.get("GIT_CONFIG_COUNT") or 0)
    except ValueError:
        count = 0
    if count < 0:
        count = 0
    for driver in drivers:
        for var, value in _FILTER_OFF:
            env[f"GIT_CONFIG_KEY_{count}"] = f"filter.{driver}.{var}"
            env[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
    if drivers:
        env["GIT_CONFIG_COUNT"] = str(count)
    return env


def _stage(repo: Path, scratch: Path, git_dir: str, objects: str, index: Path,
           control: GitControl | None = None) -> dict[str, str]:
    """Copy the repository's index to `index` and `git add -A -- .` into it, with new blobs in the scratch store and
    no filter driver run. Returns the git environment that reads that index and store."""
    real = Path(git_dir, "index")
    if real.exists():
        # copy2 keeps the index's mtime, which git's racy-entry check needs: with a fresh mtime, a same-size edit
        # made in the same second as the entry's stat looks clean where git compares seconds (Windows) (D-64)
        shutil.copy2(real, index)
    store = scratch / SNAPSHOT_OBJECTS
    store.mkdir(parents=True, exist_ok=True)
    env = {k: v for k, v in os.environ.items() if k not in _GIT_STORE_VARS}
    env.update(GIT_INDEX_FILE=str(index), GIT_OBJECT_DIRECTORY=str(store), GIT_ALTERNATE_OBJECT_DIRECTORIES=objects)
    env = no_filters(repo, env, control)
    _git(["add", "-A", "--", "."], repo, env, control)
    return env


def snapshot(repo: Path, scratch: Path, *, control: GitControl | None = None) -> str | None:
    """The work tree under `repo` as a git tree sha, written through a temporary index into `<scratch>/git-objects`
    (tracked and untracked files, minus what .gitignore excludes). None outside a git work tree or without git.

    The repository's index, refs and object store are never written, and no program its config names is run
    (`no_filters`). `scratch` must live for the whole run, because the tree exists only there. A git failure after
    the repository is found raises RuntimeError, as do a git call over GIT_TIMEOUT_S and an abort through `control`.
    """
    repo, scratch = Path(repo), Path(scratch)
    found = _locate(repo, control)
    if found is None:
        return None
    scratch.mkdir(parents=True, exist_ok=True)
    index = scratch / f"git-index-{secrets.token_hex(8)}"
    try:
        env = _stage(repo, scratch, *found, index, control)
        return _git(["write-tree"], repo, env, control).strip()
    finally:
        index.unlink(missing_ok=True)


def diff(repo: Path, base_tree: str, scratch: Path, *, control: GitControl | None = None) -> str:
    """The work tree's change against `base_tree` (from `snapshot` with the same scratch) as a unified diff, new
    and deleted files included, paths relative to `repo`: the same text tools.diff() returns. Raises RuntimeError
    when `repo` is no longer in a git work tree, git fails or times out, or `control` aborts it. No textconv or
    external diff program runs (DIFF_ARGS), nor any filter driver."""
    repo, scratch = Path(repo), Path(scratch)
    found = _locate(repo, control)
    if found is None:
        raise RuntimeError(f"{repo} is not in a git work tree")
    index = scratch / f"git-index-{secrets.token_hex(8)}"
    try:
        env = _stage(repo, scratch, *found, index, control)
        return _git(["diff", "--cached", "--relative", *DIFF_ARGS, base_tree, "--", "."], repo, env, control)
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
