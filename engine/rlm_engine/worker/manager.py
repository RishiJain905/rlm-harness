"""Starts a run's REPL worker and feeds it cells: rlm_rl/sandbox.py `Sandbox` at RLM commit 0b9af69, without Docker.

KV cache: none

`run_cell`, `_wait`, `_parse`, `_recover` and `_restart` are line-for-line ports of training's, and `CellResult` is
training's dataclass. The deltas: the worker is a local `python -I -B -X utf8 worker.py` process (D-01, D-42), with
no supervisor, so a death's reason comes from its exit code; there is no out-of-memory or tamper case; the bridge is
the `on_request` handler, called for each `request` line the worker writes (architecture §6.1); and a timeout or a
crash kills the whole process tree (POSIX: the worker's own session; Windows: taskkill /T) before a fresh worker
starts. Repo mode adds training's edit-sandbox parts: the workspace fingerprint after every cell, and a wall cap of
`wall_cap_s + cell_timeout_s`.

The worker's stdout and stderr are read on threads, not asyncio pipes (D-30's reason): every OS and event loop
behaves alike. `run_cell` raises only InfraError (and CancelledError).
"""

from __future__ import annotations

import asyncio
import collections
import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from .. import contract
from ..errors import InfraError
from ..workspace import ShellSpec, fingerprint
from .tools import TOOLS_VERSION

WORKER_PATH = Path(__file__).resolve().with_name("worker.py")
REPO_ALIAS = "/work/repo"  # decision 3a: the tools map it onto the workspace (S-25)

START_ATTEMPTS = 2  # launches before a worker that won't start is an infra error
STARTUP_TIMEOUT_S = 60
RESULT_LINE_LIMIT = 4 * 1024 * 1024
STDERR_KEEP = 4000
STDERR_LINES = 50
VARS_TIMEOUT_S = 10
JOIN_S = 2
KEY_ENV = re.compile("KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH", re.IGNORECASE)  # D-29: never reaches the worker
# Git's environment config goes as a whole: KEY_ENV matches its key names, git refuses a partial set, and its values
# can hold credentials (D-62).
GIT_ENV_CONFIG = re.compile(r"GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)", re.IGNORECASE)
INFRA_REPLY = "the request failed for an infrastructure reason; this run will stop"

_WINDOWS = sys.platform == "win32"
_NOTHING = object()


@dataclass
class CellResult:
    stdout: str
    stdout_chars: int
    error: str | None
    submitted: bool = False
    answer: Any = None  # a JSON value: int, float, str, or a list of those
    answer_valid: bool = True
    stderr: str = ""
    restarted: bool = False
    crash: str | None = None  # "timeout", or why the REPL crashed
    repo_changed: bool | None = None  # repo mode: the cell changed a file in the workspace
    compute_s: float = 0.0
    blocked_s: float = 0.0
    wall_s: float = 0.0


RequestHandler = Callable[[dict], Awaitable[dict]]  # a worker `request` -> the `reply` fields


def worker_env(scratch: Path) -> dict[str, str]:
    """The engine's environment minus key-like names (D-29) and git's env config (D-62), with the temp folders
    pointed at scratch."""
    env = {k: v for k, v in os.environ.items() if not KEY_ENV.search(k) and not GIT_ENV_CONFIG.fullmatch(k)}
    env.update(TMPDIR=str(scratch), TEMP=str(scratch), TMP=str(scratch))
    return env


def kill_tree(proc: subprocess.Popen) -> None:
    """Kill a worker and everything it started. POSIX: its session's process group; Windows: taskkill /T."""
    if _WINDOWS:
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    try:
        proc.kill()
    except OSError:
        pass


class Worker:
    """One run's REPL worker. Restarted after a timeout or a crash; `close()` kills it for good.

        worker = Worker(mode="read", context=text, workspace=scratch, scratch=scratch, limits=limits,
                        messages=contract.cell_messages(limits, edit=False), on_request=bridge.handle,
                        shell=workspace.find_shell())
        await worker.start()
        result = await worker.run_cell("print(len(context))")
        await worker.close()
    """

    def __init__(self, *, mode: str, context: str, workspace: Path, scratch: Path, limits: contract.Limits,
                 messages: contract.CellMessages, on_request: RequestHandler, shell: ShellSpec,
                 base_tree: str | None = None, python: str = sys.executable, wall_cap_s: float = 1800.0) -> None:
        if mode not in ("read", "repo"):
            raise ValueError(f"unknown mode {mode!r}")
        self.mode = mode
        self.context = context
        self.workspace = Path(workspace)
        self.scratch = Path(scratch)
        self.limits = limits
        self.messages = messages
        self.on_request = on_request
        self.shell = shell
        self.base_tree = base_tree
        self.python = python
        # training's edit sandbox: the cap sits a full default cap above the cell's own limit
        self.wall_cap_s = wall_cap_s + (limits.cell_timeout_s if mode == "repo" else 0)
        self.turn = 0  # set by the loop before each cell
        self.cells = 0
        self.timeouts = 0
        self.crashes = 0
        self.restarts = 0
        self.start_retries = 0  # launches that didn't come up and were tried again
        self.python_version: str | None = None
        self.stderr_lines: collections.deque[str] = collections.deque(maxlen=STDERR_LINES)
        self._proc: subprocess.Popen | None = None
        self._threads: list[threading.Thread] = []
        self._gen = 0  # one per launch: messages from an earlier process are dropped
        self._events: asyncio.Queue = asyncio.Queue()  # ready, result, and None at EOF
        self._loop: asyncio.AbstractEventLoop | None = None
        self._write_lock = threading.Lock()
        self._requests: set[asyncio.Task] = set()
        self._vars_waiters: dict[int, asyncio.Future] = {}
        self._cell_id = 0
        self._vars_id = 0
        self._inflight = 0
        self._blocked_since = 0.0
        self._blocked_total = 0.0
        self._infra: InfraError | None = None
        self._infra_event = asyncio.Event()
        self._fingerprint: str | None = None
        self._closed = False

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        """Start the worker and wait for `ready`. Raises InfraError("worker", …) if it won't start."""
        self._loop = asyncio.get_running_loop()
        if self.mode == "repo":
            self._fingerprint = await self._take_fingerprint()
        try:
            await self._launch()
        except BaseException:
            await self.close()
            raise

    async def close(self) -> None:
        """Kill the process tree and stop the request tasks. Safe to call twice."""
        if self._closed:
            return
        self._closed = True
        await self._kill()
        for task in list(self._requests):
            task.cancel()
        await asyncio.gather(*self._requests, return_exceptions=True)

    @property
    def infra_error(self) -> InfraError | None:
        return self._infra

    def blocked_seconds(self) -> float:
        """Wall time during which at least one request was in flight. It doesn't count toward the cell timeout."""
        if self._inflight:
            return self._blocked_total + time.monotonic() - self._blocked_since
        return self._blocked_total

    # ------------------------------------------------------------------ cells

    async def run_cell(self, code: str) -> CellResult:
        """Run one cell. Returns the model's outcome, or raises InfraError if the run must stop."""
        if self._closed:
            raise RuntimeError("worker is closed")
        self._raise_if_infra()
        self.cells += 1
        pending = self._pending_death()
        if pending is not _NOTHING:  # the worker died after the last cell, e.g. from a thread the model left running
            return await self._with_repo_change(await self._recover(during_cell=False))

        self._cell_id += 1
        cell_id = self._cell_id
        started, blocked_start = time.monotonic(), self.blocked_seconds()
        await self._write({"type": "cell", "id": cell_id, "code": code})  # a dead worker's EOF is on the way

        infra = asyncio.ensure_future(self._infra_event.wait())
        reply = None
        try:
            while True:
                message = asyncio.ensure_future(self._events.get())
                outcome = await self._wait(message, infra, started, blocked_start)
                if outcome != "message":
                    message.cancel()
                    break
                reply = message.result()
                if reply is None or (reply.get("type") == "result" and reply.get("id") == cell_id):
                    break
                self._note(f"[ignored protocol message] {str(reply)[:200]}")
        finally:
            infra.cancel()
        wall = time.monotonic() - started
        blocked = self.blocked_seconds() - blocked_start
        timing = {"compute_s": wall - blocked, "blocked_s": blocked, "wall_s": wall}

        if outcome == "infra":
            await self._kill()
            self._raise_if_infra()
        if outcome == "wall":
            await self._kill()
            self._flag_infra(InfraError("worker", f"a cell waited over {self.wall_cap_s:.0f} s on requests"))
            self._raise_if_infra()
        if outcome == "timeout":
            self.timeouts += 1
            await self._kill()
            await self._restart()
            return await self._with_repo_change(
                CellResult("", 0, self.messages.timeout, restarted=True, crash="timeout", **timing))
        if reply is None:
            return await self._with_repo_change(await self._recover(during_cell=True, timing=timing))

        result = self._parse(reply)
        self._raise_if_infra()  # a request failed in the engine while the cell was finishing
        if result is None:
            self.crashes += 1
            await self._kill()
            await self._restart()
            return await self._with_repo_change(
                CellResult("", 0, self.messages.crash.format(reason="it returned an unreadable result"),
                           restarted=True, crash="unreadable result", **timing))
        result.compute_s, result.blocked_s, result.wall_s = timing["compute_s"], timing["blocked_s"], timing["wall_s"]
        return await self._with_repo_change(result)

    async def _wait(self, message: asyncio.Future, infra: asyncio.Future, started: float, blocked_start: float) -> str:
        while True:
            wall = time.monotonic() - started
            compute = wall - (self.blocked_seconds() - blocked_start)
            if wall >= self.wall_cap_s:
                return "wall"
            remaining = min(self.limits.cell_timeout_s - compute, self.wall_cap_s - wall)
            if remaining <= 0:
                return "timeout"
            # Compute time can't grow faster than wall time, so waiting `remaining` never overshoots.
            done, _ = await asyncio.wait({message, infra}, timeout=remaining, return_when=asyncio.FIRST_COMPLETED)
            if infra in done:
                return "infra"
            if message in done:
                return "message"

    def _parse(self, raw: dict) -> CellResult | None:
        try:
            stdout, error, stderr = raw["stdout"], raw["error"], raw.get("stderr", "")
            if not isinstance(stdout, str) or not (error is None or isinstance(error, str)) or not isinstance(stderr, str):
                return None
            stdout_chars = int(raw["stdout_chars"])
            submitted = raw["submitted"] is True
            answer = raw.get("answer")
        except (KeyError, TypeError, ValueError):
            return None
        answer_valid = not submitted or contract.valid_answer(answer)
        if isinstance(answer, str):
            answer = contract.clean_text(answer)
        elif isinstance(answer, list):
            answer = [contract.clean_text(a) if isinstance(a, str) else a for a in answer]
        return CellResult(
            stdout=contract.clean_text(stdout[: contract.OUTPUT_MAX_CHARS]),
            stdout_chars=max(stdout_chars, len(stdout)),
            error=None if error is None else contract.clean_text(error[: 2 * contract.OUTPUT_MAX_CHARS]),
            submitted=submitted,
            answer=answer if submitted and answer_valid else None,
            answer_valid=answer_valid,
            stderr=contract.clean_text(stderr[:STDERR_KEEP]),
        )

    async def _with_repo_change(self, result: CellResult) -> CellResult:
        """Repo mode: whether the cell changed the workspace (training's edit sandbox), after restarts too."""
        if self.mode == "repo":
            now = await self._take_fingerprint()
            result.repo_changed = now != self._fingerprint
            self._fingerprint = now
        return result

    async def _take_fingerprint(self) -> str:
        try:
            return await asyncio.to_thread(fingerprint, self.workspace)
        except OSError as exc:
            raise InfraError("worker", f"the workspace is unreadable: {exc!r}") from exc

    # ------------------------------------------------------------------ the REPL's variables

    async def vars(self) -> list[dict]:
        """The user's globals as the worker lists them, even mid-cell; [] when the worker is gone."""
        proc = self._proc
        if self._closed or proc is None or proc.poll() is not None or self._loop is None:
            return []
        self._vars_id += 1
        vars_id = self._vars_id
        future = self._loop.create_future()
        self._vars_waiters[vars_id] = future
        try:
            await self._write({"type": "vars", "id": vars_id})
            reply = await asyncio.wait_for(future, VARS_TIMEOUT_S)
        except (asyncio.TimeoutError, OSError):
            return []
        finally:
            self._vars_waiters.pop(vars_id, None)
        found = reply.get("vars") if isinstance(reply, dict) else None
        return found if isinstance(found, list) else []

    # ------------------------------------------------------------------ crashes and restarts

    def _pending_death(self):
        """An EOF that arrived between cells, or an exit code already set. Anything else waiting is stale and dropped."""
        while not self._events.empty():
            if self._events.get_nowait() is None:
                return None
        if self._proc is not None and self._proc.poll() is not None:
            return None
        return _NOTHING

    async def _recover(self, during_cell: bool, timing: dict | None = None) -> CellResult:
        """The worker died. Restart it and tell the model."""
        reason = await self._death_reason()
        self.crashes += 1
        await self._kill()
        await self._restart()
        error = self.messages.crash.format(reason=reason)
        if not during_cell:
            error += self.messages.not_run
        return CellResult("", 0, error, restarted=True, crash=reason, **(timing or {}))

    async def _death_reason(self) -> str:
        """How the worker ended: an exit code, or on POSIX the signal that killed it."""
        proc = self._proc
        try:
            code = await asyncio.to_thread(proc.wait, 10)
        except subprocess.TimeoutExpired:  # EOF without an exit: its stdout was closed
            return "it closed its output"
        if code < 0 and not _WINDOWS:
            try:
                return f"killed by {signal.Signals(-code).name}"
            except ValueError:
                return f"killed by signal {-code}"
        return f"exit code {code}"

    async def _restart(self) -> None:
        self.restarts += 1
        try:
            await self._launch()
        except InfraError:
            raise
        except Exception as exc:
            raise InfraError("worker", f"worker restart failed: {exc!r}") from exc

    # ------------------------------------------------------------------ the process

    async def _launch(self) -> None:
        for attempt in range(START_ATTEMPTS):  # a worker that doesn't come up is tried again before it's infra
            ready = None
            try:
                self._spawn()
                await self._write(self._init_message())
                ready = await asyncio.wait_for(self._events.get(), STARTUP_TIMEOUT_S)
            except asyncio.TimeoutError:
                self._note(f"no ready message after {STARTUP_TIMEOUT_S} s")
            except OSError as exc:
                self._note(f"cannot start {self.python}: {exc}")
            if isinstance(ready, dict) and ready.get("type") == "ready":
                break
            await self._kill()
            if attempt + 1 == START_ATTEMPTS:
                detail = " | ".join(list(self.stderr_lines)[-5:]) or "no output"
                raise InfraError("worker", f"worker failed to start ({START_ATTEMPTS} attempts): {detail}")
            self.start_retries += 1
        self.python_version = ready.get("python")
        if self.mode == "repo" and ready.get("tools") != TOOLS_VERSION:
            await self._kill()
            raise InfraError("worker", f"the worker's tools are {ready.get('tools')!r}, not {TOOLS_VERSION!r}")

    def _init_message(self) -> dict:
        return {"type": "init", "mode": self.mode, "context": self.context, "workspace": str(self.workspace),
                "scratch": str(self.scratch), "base_tree": self.base_tree,
                "cell_timeout_s": self.limits.cell_timeout_s, "subcall_max_chars": self.limits.subcall_max_chars,
                "subcall_oversize": self.limits.subcall_oversize,
                "shell": {"kind": self.shell.kind, "argv": list(self.shell.argv)}, "repo_alias": REPO_ALIAS}

    def _spawn(self) -> None:
        kwargs: dict[str, Any] = {}
        if _WINDOWS:
            kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
        else:
            kwargs["start_new_session"] = True
        self._gen += 1
        self._events = asyncio.Queue()
        self._proc = None
        proc = subprocess.Popen([self.python, "-I", "-B", "-X", "utf8", str(WORKER_PATH)], cwd=str(self.workspace),
                                env=worker_env(self.scratch), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, bufsize=0, **kwargs)
        self._proc = proc
        gen = self._gen
        self._threads = [
            threading.Thread(target=self._read_stdout, args=(proc.stdout, gen), name="rlm-worker-out", daemon=True),
            threading.Thread(target=self._read_stderr, args=(proc.stderr,), name="rlm-worker-err", daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    async def _kill(self) -> None:
        proc, threads = self._proc, self._threads
        if proc is None:
            return
        await asyncio.to_thread(kill_tree, proc)
        try:
            await asyncio.to_thread(proc.wait, 10)
        except subprocess.TimeoutExpired:
            pass
        await asyncio.to_thread(_join, threads)
        try:
            proc.stdin.close()
        except OSError:
            pass

    async def _write(self, message: dict) -> None:
        """One JSON line to the worker's stdin, ASCII, under a lock; a dead worker's broken pipe is ignored."""
        proc = self._proc
        if proc is None:
            return
        data = (json.dumps(message) + "\n").encode()
        await asyncio.to_thread(self._write_sync, proc, data)

    def _write_sync(self, proc: subprocess.Popen, data: bytes) -> None:
        with self._write_lock:
            view = memoryview(data)
            try:
                while view:
                    view = view[proc.stdin.write(view):]
            except (OSError, ValueError):
                pass

    # ------------------------------------------------------------------ reader threads and messages

    def _read_stdout(self, stream, gen: int) -> None:
        """Protocol messages, one JSON object per line, then None at EOF. Over-long and unreadable lines are dropped."""
        buf, dropping = b"", False
        try:
            while True:
                try:
                    chunk = stream.read(65536)
                except (OSError, ValueError):
                    chunk = b""
                if not chunk:
                    break
                *lines, buf = (buf + chunk).split(b"\n")
                for line in lines:
                    if dropping:
                        dropping = False
                        continue
                    self._deliver(gen, line)
                if len(buf) > RESULT_LINE_LIMIT:
                    self._note("[over-long protocol line dropped]")
                    buf, dropping = b"", True
        finally:
            try:
                stream.close()
            except OSError:
                pass
            self._post(gen, None)

    def _deliver(self, gen: int, line: bytes) -> None:
        if len(line) > RESULT_LINE_LIMIT:
            self._note("[over-long protocol line dropped]")
            return
        try:
            message = json.loads(line)
        except ValueError:
            message = None
        if isinstance(message, dict):
            self._post(gen, message)
        elif line.strip():
            self._note(f"[unreadable protocol line] {line[:200]!r}")

    def _read_stderr(self, stream) -> None:
        try:
            while True:
                try:
                    line = stream.readline()
                except (OSError, ValueError):
                    line = b""
                if not line:
                    break
                self._note(line.decode("utf-8", "replace").rstrip("\r\n")[:500])
        finally:
            try:
                stream.close()
            except OSError:
                pass

    def _note(self, text: str) -> None:
        """A worker diagnostic: kept for the start-failure message and copied to the engine's stderr."""
        self.stderr_lines.append(text)
        try:
            sys.stderr.write(f"[worker] {text}\n")
            sys.stderr.flush()
        except (OSError, ValueError):
            pass

    def _post(self, gen: int, message: dict | None) -> None:
        loop = self._loop
        if loop is None:
            return
        try:
            loop.call_soon_threadsafe(self._on_message, gen, message)
        except RuntimeError:  # the loop is closed
            pass

    def _on_message(self, gen: int, message: dict | None) -> None:
        if gen != self._gen:
            return
        if message is None:
            for future in self._vars_waiters.values():
                if not future.done():
                    future.set_result({"vars": []})
            self._events.put_nowait(None)
            return
        kind = message.get("type")
        if kind == "request":
            task = asyncio.ensure_future(self._serve(gen, message))
            self._requests.add(task)
            task.add_done_callback(self._requests.discard)
        elif kind == "vars":
            future = self._vars_waiters.get(message.get("id"))
            if future is not None and not future.done():
                future.set_result(message)
        elif kind in ("ready", "result"):
            self._events.put_nowait(message)
        else:
            self._note(f"[ignored protocol message] {str(message)[:200]}")

    async def _serve(self, gen: int, request: dict) -> None:
        """One worker request: the handler's answer goes back as a `reply`. Its failure stops the run."""
        if self._inflight == 0:
            self._blocked_since = time.monotonic()
        self._inflight += 1
        try:
            fields = await self.on_request(request)
        except InfraError as exc:
            self._flag_infra(exc)
            fields = {"error": INFRA_REPLY}
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._flag_infra(InfraError("internal", f"request handler failed: {exc!r}"))
            fields = {"error": INFRA_REPLY}
        finally:
            self._inflight -= 1
            if self._inflight == 0:
                self._blocked_total += time.monotonic() - self._blocked_since
        if gen == self._gen:
            await self._write({"type": "reply", "id": request.get("id"), **fields})

    def _flag_infra(self, exc: InfraError) -> None:
        if self._infra is None:
            self._infra = exc
            self._infra_event.set()

    def _raise_if_infra(self) -> None:
        if self._infra is not None:
            raise self._infra


def _join(threads: list[threading.Thread]) -> None:
    deadline = time.monotonic() + JOIN_S
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))
