"""Audit hooks (PEP 578) that turn writes, shell commands and network use into approval requests.

KV cache: none

Adapted from the audit hook in rlm_rl/repl_worker.py at RLM commit 0b9af69 (`_HANDLERS`, `_EDIT_HANDLERS`,
`_on_open`, `_WRITE_FLAGS`, `_abspath`, the `last_popen` dedup). Inside Docker that hook blocked these events;
here each one asks the engine through `approve`, which raises PermissionError when the answer is no, and the
error propagates out of the audited call into the cell. Reads never ask.

This stops accidents, not attackers (v0-design § Permissions): code can get around an audit hook, for example
through ctypes. Standard library only; the worker imports this file as a sibling module (D-01).

Never asks: a write under the scratch folder (D-12); anything while `tools.quiet()` is true on this thread
(git reads in the tools, the Popen inside `shell()` after its own ask, taskkill; D-13); the posix_spawn or
CreateProcess that follows an approved Popen on the same thread; the loopback connect inside socketpair (Windows
asyncio makes one); and anything a handler itself triggers, or that happens on an exempt thread.
"""

from __future__ import annotations

import contextlib
import os
import shlex
import subprocess
import sys
import threading
from typing import Any, Callable, Iterator

_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC
_SOCKETPAIR_DEPTH = 3  # caller frames searched for socket.py's socketpair (or 3.12's _fallback_socketpair)

_local = threading.local()  # busy: a handler runs (or an exempt thread); after_popen: the approved Popen's detail


def exempt_thread() -> None:
    """Never ask on the calling thread (the worker's reader and fd pump), for good."""
    _local.busy = True


@contextlib.contextmanager
def ignored() -> Iterator[None]:
    """Ignore audit events on this thread inside the block: the worker's own request plumbing, so a finalizer that
    the garbage collector runs there can't re-enter a request while its locks are held."""
    previous = getattr(_local, "busy", False)
    _local.busy = True
    try:
        yield
    finally:
        _local.busy = previous


def install(*, approve: Callable[[str, str, bool], None], workspace: str, scratch: str, tools: Any) -> None:
    """Install the one audit hook. Python can't remove it again."""
    guard = _Guard(approve, workspace, scratch, tools)
    handlers: dict[str, Callable[[tuple], None]] = {
        "open": guard.on_open,
        "os.rename": guard.on_rename,
        "os.link": guard.writer(1),
        "os.symlink": guard.writer(1),
        "subprocess.Popen": guard.on_popen,
        "os.system": guard.on_system,
        "os.exec": guard.shell_at(1),
        "os.spawn": guard.shell_at(2),
        "os.posix_spawn": guard.after_popen_at(1),
        "_winapi.CreateProcess": guard.after_popen_at(1, any_detail=True),
        "os.startfile": guard.on_startfile,
        "socket.connect": guard.on_connect,
    }
    for event, (index, dir_fd) in _PATH_EVENTS.items():
        handlers[event] = guard.writer(index, dir_fd, skip_existing=event == "os.mkdir")

    def hook(event: str, args: tuple) -> None:
        handler = handlers.get(event)
        if handler is None or getattr(_local, "busy", False):
            return
        _local.busy = True
        try:
            if not tools.quiet():
                handler(args)
        except PermissionError as err:
            # The cell's six traceback lines then show its own <repl> line, not the handler's insides.
            raise err.with_traceback(None) from None
        finally:
            _local.busy = False

    sys.addaudithook(hook)


# event -> (index of the path, index of dir_fd or None), for events whose first path is the one written
_PATH_EVENTS = {
    "os.mkdir": (0, 2),
    "os.remove": (0, 1),
    "os.rmdir": (0, 1),
    "os.truncate": (0, None),
    "os.chmod": (0, 2),
    "os.chown": (0, 3),
    "os.utime": (0, 3),
    "os.setxattr": (0, None),
    "os.removexattr": (0, None),
}


def _norm(path: str) -> str:
    """A path for comparing: real (symlinks and Windows 8.3 names resolved) and case-folded where the OS folds."""
    return os.path.normcase(os.path.realpath(path))


def _under(path: str, root: str) -> bool:
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _shown(path: str) -> str:
    return path.replace(os.sep, "/")


def _argv_text(value: Any) -> str:
    """A program's arguments as one line: list2cmdline on Windows, shlex.join elsewhere; a string as it is."""
    if isinstance(value, (str, bytes, os.PathLike)):
        return os.fsdecode(value)
    try:
        items = [os.fsdecode(a) if isinstance(a, (str, bytes, os.PathLike)) else str(a) for a in value]
    except TypeError:
        return str(value)
    return subprocess.list2cmdline(items) if sys.platform == "win32" else shlex.join(items)


def _dir_of_fd(fd: int) -> str | None:
    """The folder an open directory descriptor names, for paths given relative to a dir_fd (shutil.rmtree)."""
    try:
        if sys.platform.startswith("linux"):
            return os.readlink(f"/proc/self/fd/{fd}")
        if sys.platform == "darwin":
            import fcntl

            return os.fsdecode(fcntl.fcntl(fd, 50, b"\0" * 1024).rstrip(b"\0"))  # F_GETPATH
    except (OSError, ValueError):
        pass
    return None


class _Guard:
    def __init__(self, approve: Callable[[str, str, bool], None], workspace: str, scratch: str, tools: Any) -> None:
        self.approve = approve
        self.workspace = _norm(workspace)
        self.scratch = _norm(scratch)
        self.devnull = {os.devnull, os.path.normcase(os.path.abspath(os.devnull))}
        self.tools = tools

    # ------------------------------------------------------------------ writes

    def _abspath(self, path: Any, dir_fd: Any = None) -> str | None:
        """The absolute path an event writes, or None for a descriptor, the null device or no path."""
        if path is None or isinstance(path, int):
            return None
        try:
            text = os.fsdecode(os.fspath(path))
        except (TypeError, ValueError):
            return None
        if text in self.devnull:
            return None
        base = os.getcwd()
        if isinstance(dir_fd, int) and not os.path.isabs(text):
            base = _dir_of_fd(dir_fd) or base
        full = os.path.abspath(os.path.join(base, text))
        return None if os.path.normcase(full) in self.devnull else full

    def _write(self, paths: list[str]) -> None:
        """Ask for a write unless every path is under scratch; a rename's scratch side doesn't count for `inside`."""
        rest = [r for r in (_norm(p) for p in paths) if not _under(r, self.scratch)]
        if not rest:
            return
        inside = all(_under(r, self.workspace) for r in rest)
        self.approve("write", " -> ".join(_shown(p) for p in paths), inside)

    def writer(self, index: int, dir_fd_index: int | None = None, skip_existing: bool = False) -> Callable[[tuple], None]:
        """`skip_existing` (os.mkdir): a path that already exists fails with FileExistsError and changes nothing, so
        os.makedirs(..., exist_ok=True) in write_file doesn't ask for a folder that is already there."""

        def handler(args: tuple) -> None:
            dir_fd = args[dir_fd_index] if dir_fd_index is not None and len(args) > dir_fd_index else None
            path = self._abspath(args[index] if len(args) > index else None, dir_fd)
            if path is not None and not (skip_existing and os.path.lexists(path)):
                self._write([path])

        return handler

    def on_open(self, args: tuple) -> None:
        path, mode, flags = (tuple(args) + (None, None, None))[:3]
        writing = isinstance(flags, int) and bool(flags & _WRITE_FLAGS)
        if isinstance(mode, str) and any(c in mode for c in "wax+"):
            writing = True
        if writing:
            full = self._abspath(path)
            if full is not None:
                self._write([full])

    def on_rename(self, args: tuple) -> None:
        args = tuple(args) + (None, None, None, None)
        src, dst = self._abspath(args[0], args[2]), self._abspath(args[1], args[3])
        if src is not None and dst is not None:
            self._write([src, dst])

    # ------------------------------------------------------------------ programs

    def _shell(self, detail: str) -> None:
        self.approve("shell", detail, True)  # the cwd is the workspace

    def on_popen(self, args: tuple) -> None:
        args = tuple(args) + (None, None)
        detail = _argv_text(args[1] if args[1] is not None else args[0])
        _local.after_popen = None
        self._shell(detail)
        _local.after_popen = detail  # only once approved: the spawn that follows is the same program

    def after_popen_at(self, index: int, any_detail: bool = False) -> Callable[[tuple], None]:
        """os.posix_spawn and _winapi.CreateProcess: skip the one that follows an approved Popen on this thread.
        posix_spawn must show the same argv (Popen may have used fork_exec instead, leaving the flag unused);
        CreateProcess always follows Popen on Windows, and CPython 3.12 sends it garbled arguments, so any one counts."""

        def handler(args: tuple) -> None:
            args = tuple(args)
            value = args[index] if len(args) > index and args[index] is not None else (args[0] if args else "")
            detail = _argv_text(value)
            after = getattr(_local, "after_popen", None)
            if after is not None and (any_detail or after == detail):
                _local.after_popen = None
                return
            self._shell(detail)

        return handler

    def shell_at(self, index: int) -> Callable[[tuple], None]:
        def handler(args: tuple) -> None:
            args = tuple(args)
            value = args[index] if len(args) > index and args[index] is not None else (args[0] if args else "")
            self._shell(_argv_text(value))

        return handler

    def on_system(self, args: tuple) -> None:
        self._shell(_argv_text(args[0] if args else ""))

    def on_startfile(self, args: tuple) -> None:
        path = args[0] if args else ""
        self._shell(_argv_text(path) if path is not None else "")

    # ------------------------------------------------------------------ network

    def on_connect(self, args: tuple) -> None:
        if _in_socketpair():
            return
        address = args[1] if len(args) > 1 else None
        if isinstance(address, tuple) and len(address) >= 2:
            host, port = str(address[0]), address[1]
            detail = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        elif isinstance(address, (str, bytes, os.PathLike)):
            detail = os.fsdecode(address)
        else:
            detail = str(address)
        self.approve("network", detail, False)


def _in_socketpair() -> bool:
    """Whether socket.py's socketpair (Windows builds it from a loopback connect) is a near caller."""
    frame = sys._getframe(1)
    for _ in range(_SOCKETPAIR_DEPTH + 2):  # + the handler and the hook
        if frame is None:
            return False
        code = frame.f_code
        if "socketpair" in code.co_name and os.path.basename(code.co_filename) == "socket.py":
            return True
        frame = frame.f_back
    return False
