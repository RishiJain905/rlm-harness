"""KV cache: none

Shared helpers for the engine tests. Tests are plain functions that call `run(coro)`; there is
no pytest plugin. `pipes()` wires a Link to a raw test peer, and `EngineProc` runs the real
`python -m rlm_engine serve`. Step 4 adds `git_repo` (a committed fixture repository), `git()`,
`needs_git` and `StubApp` (a minimal AppPort for the worker, bridge and permission tests).
"""

from __future__ import annotations

import asyncio
import json
import os
import queue
import shutil
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Callable

import pytest

from rlm_engine.appport import AppPort


def run(coro: Any, timeout: float = 10) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout))


def dump(msg: Any) -> bytes:
    return json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n"


class LineReader:
    """Reads a raw binary file on a daemon thread and queues its lines (None at EOF).

    It reads the raw file, never a BufferedReader, for the reason claim_stdio gives.
    `raw` keeps every byte read.
    """

    def __init__(self, f: BinaryIO) -> None:
        self.lines: queue.Queue[bytes | None] = queue.Queue()
        self.raw = bytearray()
        self.thread = threading.Thread(target=self._run, args=(f,), daemon=True)
        self.thread.start()

    def _run(self, f: BinaryIO) -> None:
        buf = b""
        while True:
            try:
                chunk = f.read(65536)
            except (OSError, ValueError):
                chunk = b""
            if not chunk:
                break
            self.raw += chunk
            *lines, buf = (buf + chunk).split(b"\n")
            for line in lines:
                self.lines.put(line)
        if buf:
            self.lines.put(buf)
        self.lines.put(None)

    def get(self, timeout: float) -> bytes | None:
        """The next line, or None at EOF. Raises queue.Empty after `timeout` seconds."""
        return self.lines.get(timeout=timeout)


class Peer:
    """The test's end of `pipes()`: writes raw lines to the Link and reads its output."""

    def __init__(self, reader: BinaryIO, writer: BinaryIO) -> None:
        self.reader = reader
        self.writer = writer
        self.out = LineReader(reader)

    def send(self, msg: Any) -> None:
        data = msg if isinstance(msg, bytes) else dump(msg)
        view = memoryview(data)
        while view:
            view = view[self.writer.write(view) :]

    async def recv_line(self, timeout: float = 5) -> bytes:
        deadline = time.monotonic() + timeout
        while True:
            try:
                line = self.out.lines.get_nowait()
            except queue.Empty:
                if time.monotonic() > deadline:
                    raise TimeoutError("no line from the link") from None
                await asyncio.sleep(0.005)
                continue
            if line is None:
                raise EOFError("the link closed its output")
            return line

    async def recv(self, timeout: float = 5) -> dict:
        return json.loads(await self.recv_line(timeout))


@dataclass
class Pipes:
    reader: BinaryIO  # the Link's input
    writer: BinaryIO  # the Link's output
    peer: Peer

    def close(self) -> None:
        for f in (self.peer.writer, self.writer):
            try:
                f.close()
            except OSError:
                pass
        self.peer.out.thread.join(2)
        for f in (self.reader, self.peer.reader):
            f.close()


def pipes() -> Pipes:
    """Two os.pipe() pairs as unbuffered binary files: one end for a Link, one for a raw peer."""
    to_link_r, to_link_w = os.pipe()
    from_link_r, from_link_w = os.pipe()
    return Pipes(
        reader=open(to_link_r, "rb", buffering=0),
        writer=open(from_link_w, "wb", buffering=0),
        peer=Peer(open(from_link_r, "rb", buffering=0), open(to_link_w, "wb", buffering=0)),
    )


async def finish(p: Pipes, server: asyncio.Task) -> None:
    """Close the peer's output (EOF for the Link), wait for serve() to return, close the rest."""
    p.peer.writer.close()
    await asyncio.wait_for(server, 5)
    p.close()


class EngineProc:
    """The real engine, `python -m rlm_engine serve`, with every pipe captured."""

    def __init__(self, home: Path, *, debug: bool = False) -> None:
        env = dict(os.environ)
        env.pop("RLMH_DEBUG", None)
        env["PYTHONUTF8"] = "1"
        env["RLMH_HOME"] = str(home)
        if debug:
            env["RLMH_DEBUG"] = "1"
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "rlm_engine", "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            env=env,
        )
        self.out = LineReader(self.proc.stdout)
        self.err = LineReader(self.proc.stderr)

    def send(self, msg: Any) -> None:
        view = memoryview(msg if isinstance(msg, bytes) else dump(msg))
        while view:  # stdin is unbuffered, so a write can be partial
            view = view[self.proc.stdin.write(view) :]

    def recv(self, timeout: float = 10) -> dict:
        line = self.out.get(timeout)
        if line is None:
            raise EOFError(f"the engine closed stdout; stderr:\n{self.stderr_text()}")
        return json.loads(line)

    def close_stdin(self) -> None:
        self.proc.stdin.close()

    def wait(self, timeout: float = 10) -> int:
        return self.proc.wait(timeout)

    def stderr_text(self) -> str:
        return bytes(self.err.raw).decode("utf-8", "replace")

    def kill(self) -> None:
        """Kill the engine if it still runs, then close every pipe."""
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(10)
        for reader in (self.out, self.err):
            reader.thread.join(5)
        for f in (self.proc.stdin, self.proc.stdout, self.proc.stderr):
            try:
                f.close()
            except OSError:
                pass


# ----------------------------------------------------------------------------- step 4

HAS_GIT = shutil.which("git") is not None
needs_git = pytest.mark.skipif(not HAS_GIT, reason="needs git")


def git(root: Path, *args: str) -> str:
    """Run git in `root` with a throwaway identity and no global hooks or autocrlf; returns stdout."""
    done = subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main",
         *args],
        cwd=root, check=True, capture_output=True,
    )
    return done.stdout.decode("utf-8", "replace")


FIXTURE_FILES = {
    "a.py": "x = 1\n",
    "pkg/core.py": "def parse(x):\n    return x\n",
    "README.md": "fixture\n",
    ".gitignore": "build/\n",
}


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    """A git repository with FIXTURE_FILES committed once; skipped when git is missing."""
    if not HAS_GIT:
        pytest.skip("needs git")
    root = tmp_path / "repo"
    for rel, text in FIXTURE_FILES.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.encode("utf-8"))
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "commit", "-qm", "base")
    return root


class StubApp(AppPort):
    """An AppPort that records everything. `approve` answers with `answer` (a dict, or a function of the params
    that may be async and may raise); `complete` calls `complete` the same way. Defaults: deny, and no model."""

    def __init__(self, *, answer: dict | Callable[[dict], Any] | None = None,
                 complete: Callable[[dict], Any] | None = None) -> None:
        self.answer = answer if answer is not None else {"allow": False, "remember_for_run": False}
        self._complete = complete
        self.approvals: list[dict] = []
        self.completes: list[dict] = []
        self.events: list[tuple[str, dict]] = []
        self.cancelled: list[str] = []

    async def complete(self, params: dict) -> dict:
        self.completes.append(params)
        if self._complete is None:
            raise AssertionError("StubApp: no model configured")
        result = self._complete(params)
        return await result if asyncio.iscoroutine(result) else result

    async def approve(self, params: dict) -> dict:
        self.approvals.append(params)
        if callable(self.answer):
            result = self.answer(params)
            return await result if asyncio.iscoroutine(result) else result
        return dict(self.answer)

    def event(self, method: str, params: dict) -> None:
        self.events.append((method, params))

    def cancel_calls(self, run_id: str) -> None:
        self.cancelled.append(run_id)

    def sent(self, method: str) -> list[dict]:
        """The params of every event of one method, in order."""
        return [params for m, params in self.events if m == method]
