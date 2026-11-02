"""KV cache: what the tools return becomes the next observation, so their output text is frozen to training's.

Copied from rlm_rl/repl_tools.py at RLM commit 0b9af69 (step 4 of the v0 build). The seven tools, their
signatures and docstrings, TOOLS_VERSION, ShellResult, namespace(), active() and on_call are training's. The
changes, each required by the step 4 spec: configure() takes scratch, shell, alias, approve and remote_fetch;
_abs maps the /work/repo alias onto the workspace; the paths the tools show and match use `/` on every OS;
_git runs quietly (quiet(), read by the worker's audit hook) with no prompt, no fsmonitor, no repository hooks
(D-165) and no console window; configure() also takes objects, the snapshot's object store when it is not the scratch folder's own (an rlm()
child's, D-160); shell() asks approve() first and runs the shell find_shell chose (sh, Git Bash or PowerShell);
diff() compares against the engine's snapshot tree with a temporary index in the scratch folder; fetch()
is new; and shell()'s processes stay the engine's to kill: on POSIX its process group is listed in
<scratch>/shell-groups, on Windows it runs in a job object of its own (popen_owned). Everything else,
limits, messages and order of operations included, is training's. The text below is training's and
describes its container.

The coding tools the edit REPL gives the root (spec §12.1, code-editing-plan.md §5.6).

Seven functions modelled on what Claude Code, Codex CLI, DeepSeek Harness and Qwen Code give
their models: read_file, find_files, grep, edit_file, write_file, shell, diff. They run inside
the episode container, in the REPL process, so nothing new crosses the bridge, and Landlock
and --network none bound them as they bound plain `open` and `subprocess`.

Standard library only, and it imports nothing from the project: the container mounts this file
read-only at /opt/rlm next to repl_worker.py, and the Part 2 harness imports the same file, so
the deployed model calls the functions it trained on. Names, signatures and docstrings are
frozen with TOOLS_VERSION; tests/test_repl_tools.py pins them (H10).

The REPL wires them in with:

    repl_tools.configure(root="/work/repo", time_left=cell_seconds_left, on_call=log_event)
    namespace.update(repl_tools.namespace())
"""

import contextlib
import functools
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from typing import NamedTuple

TOOLS_VERSION = "t1"
TOOL_NAMES = ("read_file", "find_files", "grep", "edit_file", "write_file", "shell", "diff")

REPO_DIR = "/work/repo"
READ_LINES = 40  # one printed turn (2,000 characters) holds about this many numbered lines
LINE_MAX_CHARS = 300
BINARY_SNIFF_BYTES = 8192
GREP_MAX_FILE_BYTES = 2_000_000
GREP_MAX_MATCHES = 10_000
SHELL_TIMEOUT_S = 120
SHELL_TIMEOUT_CODE = 124  # what coreutils `timeout` returns
SHELL_KEEP_CHARS = 1_000_000  # the end of the output is kept; the start of a huge log is dropped
SHELL_SHOW_CHARS = 1500  # what printing a result shows: the end, where failures are
# Searched only when the repository has no git to read .gitignore from.
FALLBACK_SKIP_DIRS = frozenset({".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
                                ".pytest_cache", ".gradle"})

SH = {"kind": "sh", "argv": ["sh", "-c"]}  # training's shell, and the default
SNAPSHOT_OBJECTS = "git-objects"  # <scratch>/git-objects holds the engine's snapshot tree (workspace.snapshot)
PS_UTF8 = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; "
_GIT_STORE_VARS = ("GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES")  # diff() sets its own
if sys.platform == "win32":
    _NO_WINDOW = subprocess.CREATE_NO_WINDOW
    _NEW_GROUP = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW}
else:
    _NO_WINDOW = 0
    _NEW_GROUP = {"start_new_session": True}

_config = {"root": REPO_DIR, "base": None, "time_left": None, "on_call": None, "scratch": None, "shell": SH,
           "alias": REPO_DIR, "approve": None, "remote_fetch": None, "objects": None}
_local = threading.local()


def configure(root: str = REPO_DIR, base: str | None = None, time_left=None, on_call=None, *, scratch=None,
              shell=None, alias="/work/repo", approve=None, remote_fetch=None, objects=None) -> None:
    """Set the repository the tools work in.

    base: the git tree diff() compares against (the engine's workspace.snapshot); None makes diff() raise.
    time_left: a function returning the seconds left in the current cell; shell() never runs past it.
    on_call: called as on_call(tool, ok, seconds, target) after every tool call, for the edit metrics.
    scratch: the run's scratch folder, where diff() keeps its temporary index and the snapshot's objects live.
    shell: {"kind": "sh" | "bash" | "powershell", "argv": [...]} as the worker's init carries it; None means sh -c.
    alias: the path the model knows the repository by, mapped onto root; None turns the mapping off.
    approve: called as approve(kind, detail, inside_workspace) before shell() and fetch(); raises PermissionError.
    remote_fetch: called as remote_fetch(url) to make fetch()'s GET; None means fetch() is unavailable.
    objects: the folder holding the base tree's objects, when it is not <scratch>/git-objects.
    """
    shell = SH if shell is None else {"kind": shell["kind"], "argv": list(shell["argv"])}
    _config.update(root=os.path.abspath(root), base=base, time_left=time_left, on_call=on_call,
                   scratch=os.path.abspath(scratch) if scratch else None, shell=shell, alias=alias, approve=approve,
                   remote_fetch=remote_fetch, objects=os.path.abspath(objects) if objects else None)


def namespace() -> dict:
    """The tools by name, for the REPL's namespace."""
    return {name: globals()[name] for name in TOOL_NAMES}


def active() -> bool:
    """True while a tool call runs on this thread, so the REPL's audit hook can tell tool I/O from raw open/subprocess."""
    return getattr(_local, "depth", 0) > 0


def quiet() -> bool:
    """True while this thread runs the tools' own git or shell process: the worker's audit hook never asks then."""
    return getattr(_local, "quiet", 0) > 0


@contextlib.contextmanager
def _quiet():
    """Mark what this thread does inside the block as the tools' own (read-only git, shell()'s already-approved
    Popen, taskkill), so quiet() is true for the audit hook (D-13)."""
    _local.quiet = getattr(_local, "quiet", 0) + 1
    try:
        yield
    finally:
        _local.quiet -= 1


def _logged(target_arg: str):
    """Report each call to on_call with whether it raised, how long it took and its path or command."""
    def wrap(fn):
        @functools.wraps(fn)
        def call(*args, **kwargs):
            names = fn.__code__.co_varnames[:fn.__code__.co_argcount]
            bound = {**dict(zip(names, args)), **kwargs}
            target = str(bound.get(target_arg, ""))[:200] if target_arg else ""
            _local.depth = getattr(_local, "depth", 0) + 1
            start, ok = time.monotonic(), False
            try:
                result = fn(*args, **kwargs)
                ok = True
                return result
            finally:
                _local.depth -= 1
                if _config["on_call"]:
                    _config["on_call"](fn.__name__, ok, round(time.monotonic() - start, 3), target)
        return call
    return wrap


# ----------------------------------------------------------------------------- paths and files


TMP_ALIAS = "/tmp"


def _tmp_dir():
    """Windows only: the folder that stands for training's /tmp, <scratch>/tmp, made on first use. A Windows Python
    opens /tmp/x as <drive>:\\tmp\\x and Git Bash as its own temp folder, so the two never met; training's sandbox
    had one /tmp. None on POSIX, where /tmp is already one folder for both."""
    if sys.platform != "win32" or not _config["scratch"]:
        return None
    folder = os.path.join(_config["scratch"], "tmp")
    os.makedirs(folder, exist_ok=True)
    return folder


def _abs(path: str) -> str:
    path, alias = os.fspath(path), _config["alias"]
    # The model knows the repository as /work/repo (3a): map that prefix, and only a whole path segment of it.
    if alias and isinstance(path, str) and (path == alias or path.startswith(alias + "/")):
        path = _config["root"] + path[len(alias):]
    elif isinstance(path, str) and (path == TMP_ALIAS or path.startswith(TMP_ALIAS + "/")):
        tmp = _tmp_dir()
        if tmp:
            path = tmp + path[len(TMP_ALIAS):]
    return os.path.normpath(os.path.join(_config["root"], path))


def _segment(name: str) -> str:
    """A regex for `name` as a whole path segment where a path starts (`/x/work/repo`, `/work/repository` and
    `~/tmp` don't match)."""
    return r"(?<![\w.~/-])" + re.escape(name) + r"(?![\w.-])"


def _alias_in_cmd(cmd: str) -> str:
    """A shell command with the /work/repo alias (3a) as the workspace, written with `/`: training's sandbox had
    that folder, so the model writes `cd /work/repo && pytest`. On Windows /tmp becomes the folder the file tools
    use for it too (_tmp_dir)."""
    if not isinstance(cmd, str):
        return cmd
    alias = _config["alias"]
    if alias and alias in cmd:
        root = _slashed(_config["root"])
        cmd = re.sub(_segment(alias), lambda _m: root, cmd)
    if TMP_ALIAS in cmd:
        tmp = _tmp_dir()
        if tmp:
            cmd = re.sub(_segment(TMP_ALIAS), lambda _m: _slashed(tmp), cmd)
    return cmd


def _slashed(path: str) -> str:
    """A path with `/` separators, as the model sees paths on every OS (D-17)."""
    return path.replace(os.sep, "/")


def _show(path: str) -> str:
    """A path as the tools report it: relative to the repository when inside it, so it can go straight back into read_file."""
    try:
        rel = _slashed(os.path.relpath(path, _config["root"]))
    except ValueError:  # Windows: a path on another drive has no relative form
        return _slashed(path)
    return _slashed(path) if rel == ".." or rel.startswith("../") else rel


def _is_binary(path: str) -> bool:
    with open(path, "rb") as f:
        return b"\0" in f.read(BINARY_SNIFF_BYTES)


def _cut(line: str) -> str:
    return line if len(line) <= LINE_MAX_CHARS else line[:LINE_MAX_CHARS] + f" [... {len(line) - LINE_MAX_CHARS} more characters]"


def _git(args: list, cwd: str, env: dict | None = None, ok: tuple = (0,)) -> str:
    if shutil.which("git") is None:
        raise RuntimeError("git is not installed in this environment")
    env = {**(os.environ if env is None else env), "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1"}  # D-63
    with _quiet():  # read-only git never asks (D-13); diff()'s writes go to the scratch folder
        done = subprocess.run(["git", "-c", "safe.directory=*", "-c", "core.quotepath=off", "-c",
                               "core.fsmonitor=false", "-c", "core.safecrlf=false", "-c", f"core.hooksPath={os.devnull}",
                               *args], cwd=cwd,
                              capture_output=True, env=env, stdin=subprocess.DEVNULL, creationflags=_NO_WINDOW)
    if done.returncode not in ok:
        raise RuntimeError(f"git {args[0]} failed: {done.stderr.decode(errors='replace').strip()[:500]}")
    return done.stdout.decode(errors="replace")


_FILTER_OFF = (("clean", ""), ("smudge", ""), ("process", ""), ("required", "false"))


def _no_filters(root: str, env: dict) -> dict:
    """`env` with every configured filter driver switched off, so diff()'s `git add` runs no program the repository's
    config names: workspace.no_filters, the engine's copy of the recipe (GIT_CONFIG_* carries a driver name holding
    `=` or `.` exactly; GIT_CONFIG_PARAMETERS, read after it, is dropped)."""
    env = {k: v for k, v in env.items() if k != "GIT_CONFIG_PARAMETERS"}
    listed = _git(["config", "-z", "--name-only", "--get-regexp", r"^filter\."], cwd=root, env=env, ok=(0, 1))
    drivers = sorted({key[len("filter."):key.rindex(".")] for key in listed.split("\0") if key.count(".") >= 2})
    try:
        count = max(int(env.get("GIT_CONFIG_COUNT") or 0), 0)
    except ValueError:
        count = 0
    for driver in drivers:
        for var, value in _FILTER_OFF:
            env[f"GIT_CONFIG_KEY_{count}"] = f"filter.{driver}.{var}"
            env[f"GIT_CONFIG_VALUE_{count}"] = value
            count += 1
    if drivers:
        env["GIT_CONFIG_COUNT"] = str(count)
    return env


def _files_under(base: str) -> list[str]:
    """Absolute paths of the files under base, sorted. Inside a git work tree, git's own list (tracked plus
    untracked, minus what .gitignore excludes), as ripgrep does; elsewhere a walk that skips the usual
    dependency and cache folders."""
    # Sorted by the '/' form, so the order is POSIX's on every OS (on Windows '\' sorts after '-' and '0').
    if os.path.isfile(base):
        return [base]
    if not os.path.isdir(base):
        raise FileNotFoundError(f"no such directory: {_show(base)}")
    try:
        listed = _git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=base)
        paths = {os.path.join(base, p.replace("/", os.sep)) for p in listed.split("\0") if p}
        return sorted((p for p in paths if os.path.isfile(p)), key=_slashed)
    except RuntimeError:
        pass
    found = []
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = sorted(d for d in dirnames if d not in FALLBACK_SKIP_DIRS)
        found += [os.path.join(dirpath, f) for f in filenames]
    return sorted(found, key=_slashed)


def _glob_regex(pattern: str) -> re.Pattern:
    """A glob as a regex over '/'-separated paths: * and ? stay within one folder, ** crosses folders, {a,b} picks one."""
    out, i = [], 0
    while i < len(pattern):
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern[i] == "?":
            out.append("[^/]")
            i += 1
        elif pattern[i] == "{" and "}" in pattern[i:]:
            end = pattern.index("}", i)
            out.append("(?:" + "|".join(re.escape(p) for p in pattern[i + 1:end].split(",")) + ")")
            i = end + 1
        elif pattern[i] == "[" and "]" in pattern[i + 1:]:
            end = pattern.index("]", i + 1)
            body = pattern[i + 1:end]
            out.append("[" + ("^" + body[1:] if body.startswith("!") else body) + "]")
            i = end + 1
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


# ----------------------------------------------------------------------------- owning process trees (not training's)

# shell() starts each command in its own session (POSIX) or process group (Windows), so killing the worker's own
# group misses it. POSIX: each shell() group is listed in <scratch>/shell-groups, which the engine reads to kill them
# with the worker, after a crash too. Windows: the engine puts the worker in a kill-on-close job object, which every
# descendant joins, and each shell() command gets a nested job of its own for its timeout, so even the children Git
# Bash reparents die with it (taskkill /T, which follows parent ids, stays the fallback).
SHELL_GROUPS = "shell-groups"
_groups_lock = threading.Lock()


def _group_alive(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except (ProcessLookupError, PermissionError):  # gone, or the id now names someone else's group
        return False
    return True


def _note_group(pgid: int) -> None:
    """POSIX: add shell()'s process group to <scratch>/shell-groups, dropping groups that are gone, so an id the OS
    hands out again is never on the list."""
    scratch = _config["scratch"]
    if not scratch:
        return
    path = os.path.join(scratch, SHELL_GROUPS)
    with _groups_lock, _quiet(), contextlib.suppress(OSError, ValueError):
        try:
            with open(path, encoding="ascii") as f:
                known = [int(line) for line in f.read().split()]
        except FileNotFoundError:
            known = []
        live = [g for g in known if g != pgid and _group_alive(g)] + [pgid]
        with open(path + ".tmp", "w", encoding="ascii") as f:
            f.write("".join(f"{g}\n" for g in live))
        os.replace(path + ".tmp", path)


if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _CREATE_SUSPENDED = 0x4
    _KILL_ON_JOB_CLOSE = 0x2000
    _JOB_EXTENDED_LIMITS = 9  # JobObjectExtendedLimitInformation
    _THREAD_SUSPEND_RESUME = 0x2
    _SNAP_THREADS = 0x4  # TH32CS_SNAPTHREAD

    class _BasicLimits(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class _ExtendedLimits(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _BasicLimits), ("IoInfo", ctypes.c_uint64 * 6),
                    ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    class _ThreadEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ThreadID", wintypes.DWORD),
                    ("th32OwnerProcessID", wintypes.DWORD), ("tpBasePri", wintypes.LONG),
                    ("tpDeltaPri", wintypes.LONG), ("dwFlags", wintypes.DWORD)]

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    for _name, _restype, _argtypes in (
            ("CreateJobObjectW", wintypes.HANDLE, [wintypes.LPVOID, wintypes.LPCWSTR]),
            ("SetInformationJobObject", wintypes.BOOL, [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]),
            ("AssignProcessToJobObject", wintypes.BOOL, [wintypes.HANDLE, wintypes.HANDLE]),
            ("TerminateJobObject", wintypes.BOOL, [wintypes.HANDLE, wintypes.UINT]),
            ("CloseHandle", wintypes.BOOL, [wintypes.HANDLE]),
            ("CreateToolhelp32Snapshot", wintypes.HANDLE, [wintypes.DWORD, wintypes.DWORD]),
            ("Thread32First", wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)]),
            ("Thread32Next", wintypes.BOOL, [wintypes.HANDLE, ctypes.POINTER(_ThreadEntry)]),
            ("OpenThread", wintypes.HANDLE, [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]),
            ("ResumeThread", wintypes.DWORD, [wintypes.HANDLE])):
        getattr(_k32, _name).restype, getattr(_k32, _name).argtypes = _restype, _argtypes
    del _name, _restype, _argtypes


class Job:
    """Windows: a job object. Every process its members start joins it too; kill() ends them all, and so does
    closing the last handle when kill_on_close is set (the engine's own exit included)."""

    def __init__(self, kill_on_close: bool) -> None:
        handle = _k32.CreateJobObjectW(None, None)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._handle = handle
        if kill_on_close:
            info = _ExtendedLimits()
            info.BasicLimitInformation.LimitFlags = _KILL_ON_JOB_CLOSE
            if not _k32.SetInformationJobObject(handle, _JOB_EXTENDED_LIMITS, ctypes.byref(info), ctypes.sizeof(info)):
                error = ctypes.WinError(ctypes.get_last_error())
                self.close()
                raise error

    def add(self, proc: subprocess.Popen) -> None:
        if not _k32.AssignProcessToJobObject(self._handle, int(proc._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def kill(self) -> None:
        if self._handle:
            _k32.TerminateJobObject(self._handle, 1)

    def close(self) -> None:
        handle, self._handle = self._handle, None
        if handle:
            _k32.CloseHandle(handle)


def _resume(pid: int) -> None:
    """Windows: resume the threads of a process started with CREATE_SUSPENDED."""
    snapshot = _k32.CreateToolhelp32Snapshot(_SNAP_THREADS, 0)
    if not snapshot or snapshot == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    resumed = 0
    try:
        entry = _ThreadEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = _k32.Thread32First(snapshot, ctypes.byref(entry))
        while more:
            if entry.th32OwnerProcessID == pid:
                thread = _k32.OpenThread(_THREAD_SUSPEND_RESUME, False, entry.th32ThreadID)
                if thread:
                    if _k32.ResumeThread(thread) != 0xFFFFFFFF:
                        resumed += 1
                    _k32.CloseHandle(thread)
            more = _k32.Thread32Next(snapshot, ctypes.byref(entry))
    finally:
        _k32.CloseHandle(snapshot)
    if not resumed:
        raise OSError(f"could not resume process {pid}")


def popen_owned(args, *, kill_on_close: bool = False, **kwargs):
    """subprocess.Popen, and on Windows a Job holding the process before it runs a single instruction, so nothing it
    starts can leave the job: (proc, job), or (proc, None) on POSIX or when the job can't be made (taskkill /T then)."""
    if sys.platform != "win32":
        return subprocess.Popen(args, **kwargs), None
    kwargs["creationflags"] = kwargs.get("creationflags", 0) | _CREATE_SUSPENDED
    proc = subprocess.Popen(args, **kwargs)
    job = None
    try:
        try:
            job = Job(kill_on_close)
            job.add(proc)
        except OSError:
            if job is not None:
                job.close()
            job = None
        _resume(proc.pid)
    except BaseException:
        with contextlib.suppress(OSError):
            proc.kill()
        proc.wait()
        if job is not None:
            job.close()
        raise
    return proc, job


# ----------------------------------------------------------------------------- the tools


@_logged("path")
def read_file(path: str, start: int = 1, n: int = READ_LINES) -> str:
    """Return n lines of a file from line `start` (1-based), numbered, with long lines cut.

    Ends with how many lines follow and the call that reads them. Raises for a missing,
    binary or empty-range read. For a file's raw text, use open().
    """
    full = _abs(path)
    if _is_binary(full):
        raise ValueError(f"{_show(full)} is a binary file")
    with open(full, encoding="utf-8", errors="replace") as f:
        lines = f.read().splitlines()
    if not lines:
        return f"[{_show(full)} is empty]"
    start = max(1, int(start))
    if start > len(lines):
        raise ValueError(f"start={start} is past the end of {_show(full)} ({len(lines)} lines)")
    end = min(len(lines), start - 1 + max(1, int(n)))
    text = "\n".join(f"{i:6}\t{_cut(lines[i - 1])}" for i in range(start, end + 1))
    if end < len(lines):
        text += f"\n[{len(lines) - end} more lines; next: read_file({_show(full)!r}, start={end + 1})]"
    return text


@_logged("pattern")
def find_files(pattern: str, path: str = ".") -> list[str]:
    """Return the files under `path` whose path matches a glob, sorted.

    "*.py" matches only directly under `path`; "**/*.py" matches at any depth; "src/**/*.{ts,tsx}"
    also works. Skips what .gitignore excludes. Paths come back relative to the repository.
    """
    base = _abs(path)
    regex = _glob_regex(pattern)
    return [_show(p) for p in _files_under(base) if regex.match(_slashed(os.path.relpath(p, base)))]


@_logged("pattern")
def grep(pattern: str, path: str = ".", glob: str | None = None, ignore_case: bool = False,
         files_only: bool = False) -> list[str]:
    """Search file contents with a Python regex; return matches as "path:line: text".

    path: a folder or one file. glob: only files matching it ("*.go" matches by file name at any
    depth, "src/**/*.go" by path). files_only: return each matching file's path once instead.
    Skips binary files, files over 2 MB and what .gitignore excludes; stops after 10,000 matches,
    with a last entry saying so.
    """
    regex = re.compile(pattern, re.IGNORECASE if ignore_case else 0)
    base = _abs(path)
    keep = _glob_regex(glob) if glob else None
    results = []
    for full in _files_under(base):
        if keep and not keep.match(os.path.basename(full) if "/" not in glob
                                   else _slashed(os.path.relpath(full, base))):
            continue
        if os.path.getsize(full) > GREP_MAX_FILE_BYTES or _is_binary(full):
            continue
        with open(full, encoding="utf-8", errors="replace") as f:
            for number, line in enumerate(f, 1):
                if not regex.search(line):
                    continue
                if files_only:
                    results.append(_show(full))
                    break
                text = _cut(line.rstrip("\r\n"))
                results.append(f"{_show(full)}:{number}: {text}")
                if len(results) >= GREP_MAX_MATCHES:
                    results.append(f"[stopped at {GREP_MAX_MATCHES:,} matches; narrow the pattern, path or glob]")
                    return results
    return results


@_logged("path")
def edit_file(path: str, old: str, new: str, replace_all: bool = False) -> str:
    """Replace the exact text `old` with `new` in a file and say where.

    `old` must occur exactly once (copy enough surrounding lines to make it unique), or pass
    replace_all=True to replace every occurrence. Otherwise it raises and leaves the file untouched.
    Keeps the file's line endings.
    """
    if not old:
        raise ValueError("old must not be empty; use write_file to create a file")
    if old == new:
        raise ValueError("old and new are the same")
    full = _abs(path)
    try:
        with open(full, encoding="utf-8", newline="") as f:
            text = f.read()
    except UnicodeDecodeError:
        raise ValueError(f"{_show(full)} is not UTF-8 text; change it with shell() instead") from None
    if "\r\n" in text and "\r\n" not in old:
        old, new = old.replace("\n", "\r\n"), new.replace("\n", "\r\n")
    count = text.count(old)
    if count == 0:
        raise ValueError(f"old text not found in {_show(full)}; check whitespace and indentation against read_file")
    if count > 1 and not replace_all:
        raise ValueError(f"old text occurs {count} times in {_show(full)}; include more surrounding lines, "
                         "or pass replace_all=True to replace every one")
    line = text[:text.index(old)].count("\n") + 1
    with open(full, "w", encoding="utf-8", newline="") as f:
        f.write(text.replace(old, new))
    done = count if replace_all else 1
    return f"edited {_show(full)}: {done} replacement{'s' if done > 1 else ''}, first at line {line}"


@_logged("path")
def write_file(path: str, text: str) -> str:
    """Create or overwrite a file with `text`, making its folders as needed."""
    if not isinstance(text, str):
        raise TypeError(f"text must be a str, not {type(text).__name__}")
    full = _abs(path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "w", encoding="utf-8", newline="") as f:
        f.write(text)
    return f"wrote {_show(full)} ({len(text.splitlines())} lines)"


class ShellResult(NamedTuple):
    """What shell() returns: `code` is the exit code, `out` holds stdout and stderr together."""
    code: int
    out: str

    def __str__(self) -> str:
        tail = self.out
        if len(tail) > SHELL_SHOW_CHARS:
            tail = f"[... {len(tail) - SHELL_SHOW_CHARS:,} earlier characters]\n" + tail[-SHELL_SHOW_CHARS:]
        return f"exit {self.code}" + (f"\n{tail}" if tail else "")

    __repr__ = __str__


@_logged("cmd")
def shell(cmd: str, timeout: float = SHELL_TIMEOUT_S) -> ShellResult:
    """Run a shell command (sh -c) in the repository and return its exit code and output.

    Printing the result shows the exit code and the last 1,500 characters; `.out` holds the
    whole output (its last 1,000,000 characters). On timeout the command is killed and the
    result has code 124 and what it printed. Never runs past the cell's time limit. No network.
    """
    if _config["approve"]:
        _config["approve"]("shell", cmd, True)  # one ask, showing cmd (D-13); a denial raises before anything runs
    limit = float(timeout)
    if _config["time_left"]:
        limit = max(1.0, min(limit, _config["time_left"]() - 2.0))
    spec = _config["shell"]
    cmd = _alias_in_cmd(cmd)  # after the ask, which shows the command as the model wrote it
    if spec["kind"] == "powershell":
        cmd = PS_UTF8 + cmd
    with _quiet():  # approved above, so the audit hook does not ask again
        proc, job = popen_owned([*spec["argv"], cmd], cwd=_config["root"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, **_NEW_GROUP)
        if sys.platform != "win32":
            _note_group(proc.pid)
    kept, size = [], [0]

    def drain():
        for chunk in iter(lambda: proc.stdout.read1(65536), b""):
            kept.append(chunk)
            size[0] += len(chunk)
            while size[0] - len(kept[0]) > SHELL_KEEP_CHARS:  # stay near the cap without ever splitting a chunk
                size[0] -= len(kept.pop(0))

    reader = threading.Thread(target=drain, daemon=True)
    reader.start()
    timed_out = False
    try:
        proc.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        timed_out = True
        if sys.platform == "win32":
            if job is not None:  # the whole tree, as killpg does below; children Git Bash reparented too
                job.kill()
            else:
                with _quiet(), contextlib.suppress(OSError):
                    subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=_NO_WINDOW)
            with contextlib.suppress(OSError):
                proc.kill()
        else:
            try:
                os.killpg(proc.pid, 9)  # the whole process group: test runners leave children behind
            except ProcessLookupError:
                pass
        proc.wait()
    if job is not None:  # what the command left running keeps running, inside the worker's job (manager.py)
        job.close()
    reader.join(timeout=5)  # a process that left the group can hold the pipe open; don't wait on it
    if not reader.is_alive():
        proc.stdout.close()
    out = b"".join(list(kept)).decode(errors="replace")
    if sys.platform == "win32":  # native programs end lines with \r\n; training's Linux shell gave the model \n
        out = out.replace("\r\n", "\n")
    out = out[-SHELL_KEEP_CHARS:]
    if timed_out:
        return ShellResult(SHELL_TIMEOUT_CODE, out + f"\n[timed out after {limit:g} s and killed]")
    return ShellResult(proc.returncode, out)


@_logged("")
def diff() -> str:
    """Return your change so far as a unified diff against the task's starting commit, new files
    included: what gets graded. Empty if nothing has changed."""
    root, base, scratch = _config["root"], _config["base"], _config["scratch"]
    if not base:
        raise RuntimeError("diff() is unavailable because the workspace is not a git repository")
    # Stage into a copy of the index, so the repository's own index is never touched. The copy lives in a
    # temporary folder in the scratch folder; new blobs go to <scratch>/git-objects, where the engine's snapshot
    # put the base tree, and the repository's object store is only read. workspace.diff is the same recipe.
    with _quiet():
        tmp = tempfile.mkdtemp(dir=scratch)
        try:
            git_dir, objects = _git(["rev-parse", "--absolute-git-dir", "--git-path", "objects"],
                                    cwd=root).splitlines()[:2]
            real, index = os.path.join(git_dir, "index"), os.path.join(tmp, "index")
            if os.path.exists(real):
                shutil.copy2(real, index)  # keeps the index's mtime for git's racy-entry check (D-64)
            store = _config["objects"] or os.path.join(scratch or tmp, SNAPSHOT_OBJECTS)
            os.makedirs(store, exist_ok=True)
            env = {k: v for k, v in os.environ.items() if k not in _GIT_STORE_VARS}
            env.update(GIT_INDEX_FILE=index, GIT_OBJECT_DIRECTORY=store,
                       GIT_ALTERNATE_OBJECT_DIRECTORIES=os.path.normpath(os.path.join(root, objects)))
            env = _no_filters(root, env)
            _git(["add", "-A", "--", "."], cwd=root, env=env)
            return _git(["diff", "--cached", "--relative", "--no-color", "--no-ext-diff", "--no-textconv", base, "--",
                         "."], cwd=root, env=env)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@_logged("url")
def fetch(url: str) -> str:
    """Fetch a web page with a GET request and return its text (at most 200,000 characters). Asks for approval the first time for each site."""
    if _config["remote_fetch"] is None:
        raise RuntimeError("fetch is not available here")
    if not isinstance(url, str):
        raise TypeError(f"url must be a str, not {type(url).__name__}")
    try:
        parts = urllib.parse.urlsplit(url)
        host = parts.hostname if parts.scheme in ("http", "https") else None
    except ValueError:  # e.g. an unclosed [ in an IPv6 host
        host = None
    if not host:
        raise ValueError("fetch takes an http:// or https:// URL")
    if _config["approve"]:
        _config["approve"]("network", f"[{host}]" if ":" in host else host, False)  # the bare host (D-47)
    return _config["remote_fetch"](url)
