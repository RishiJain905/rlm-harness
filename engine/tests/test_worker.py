"""KV cache: none

worker/manager.py and worker/worker.py against real worker processes (spawned with sys.executable): globals, the
exact context, truncation, tracebacks, submit, link safety, timeouts and crashes with restarts, blocked time, the
wall cap, start failures, infra errors from the request handler, `vars`, request lines, the environment, repo-mode
fingerprints, and the constants shared with contract.py. Timeouts use a cell limit of 1 to 3 seconds.
"""

from __future__ import annotations

import ast
import asyncio
import contextlib
import dataclasses
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, AsyncIterator

import pytest
from conftest import run

from rlm_engine import contract
from rlm_engine.errors import InfraError
from rlm_engine.worker import manager
from rlm_engine.worker.manager import CellResult, Worker
from rlm_engine.workspace import find_shell

POSIX = sys.platform != "win32"
READ = contract.READ_LIMITS_V4
WORKER_SOURCE = Path(manager.__file__).with_name("worker.py")


async def allow_all(request: dict) -> dict:
    """An on_request that approves everything and echoes sub-call prompts."""
    op = request["op"]
    if op == "approve":
        return {"allow": True}
    if op in ("llm", "llm_batch"):
        return {"outputs": [f"echo:{p}" for p in request["prompts"]]}
    if op == "fetch":
        return {"text": "page"}
    return {"error": "unknown request"}


def make_worker(tmp_path: Path, *, mode: str = "read", workspace: Path | None = None, limits: contract.Limits = READ,
                on_request: Any = allow_all, **kwargs: Any) -> Worker:
    scratch = tmp_path / "scratch"
    scratch.mkdir(exist_ok=True)
    return Worker(mode=mode, context=kwargs.pop("context", "ctx"), workspace=workspace or scratch, scratch=scratch,
                  limits=limits, messages=contract.cell_messages(limits, edit=mode == "repo"),
                  on_request=on_request, shell=find_shell(), **kwargs)


@contextlib.asynccontextmanager
async def started(tmp_path: Path, **kwargs: Any) -> AsyncIterator[Worker]:
    worker = make_worker(tmp_path, **kwargs)
    await worker.start()
    try:
        yield worker
    finally:
        await worker.close()


def go(coro: Any, timeout: float = 60) -> Any:
    return run(coro, timeout)


def short(seconds: int) -> contract.Limits:
    return dataclasses.replace(READ, cell_timeout_s=seconds)


def alive(pid: int) -> bool:
    """Whether a process runs (a zombie counts as dead)."""
    if sys.platform == "win32":
        import ctypes

        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    try:
        with open(f"/proc/{pid}/stat", encoding="utf-8") as f:
            return f.read().rsplit(")", 1)[-1].split()[0] != "Z"
    except OSError:
        return True


def wait_dead(pid: int, seconds: float = 10) -> bool:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if not alive(pid):
            return True
        time.sleep(0.05)
    return False


# ----------------------------------------------------------------------------- cells


def test_globals_persist_and_context_is_exact(tmp_path: Path) -> None:
    context = "first line\r\nzweite Zeile é ü 中\r\nlast, no newline"

    async def main() -> None:
        async with started(tmp_path, context=context) as w:
            assert w.python_version and w.python_version.startswith("3.")
            assert (await w.run_cell("x = 41")).error is None
            r = await w.run_cell("print(x + 1)\nprint(context == %r, len(context))" % context)
            assert r.stdout == f"42\nTrue {len(context)}\n"
            assert (r.restarted, r.crash, r.repo_changed, r.submitted) == (False, None, None, False)

    go(main())


def test_truncation_counts_everything(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("print('x' * 10000)")
            assert r.stdout == "x" * contract.OUTPUT_MAX_CHARS
            assert r.stdout_chars == 10001

    go(main())


def test_traceback_has_no_worker_frame(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("def f(n):\n    return f(n - 1) if n else 1 / 0\nf(10)")
            lines = r.error.splitlines()
            assert len(lines) <= contract.TRACEBACK_LINES
            assert "worker.py" not in r.error and "manager.py" not in r.error
            assert lines[-1] == "ZeroDivisionError: division by zero"
            r = await w.run_cell("raise ValueError('boom')")
            assert r.error == 'Traceback (most recent call last):\n  File "<repl>", line 1, in <module>\nValueError: boom'

    go(main())


def test_traceback_names_training_files(tmp_path: Path, git_repo: Path) -> None:
    """D-109: the worker's own frames show training's container paths, never the install folder; line numbers stay."""
    native = str(WORKER_SOURCE.parent)

    async def main() -> None:
        async with started(tmp_path) as w:  # raised in worker.py's _truncate, as training's oversize error was
            r = await w.run_cell("llm('x' * 60001)")
            assert native not in r.error and "/opt/rlm/repl_worker.py" in r.error, r.error
            assert re.findall(r'File "([^"]+)", line \d+, in (\w+)', r.error) == [
                ("/opt/rlm/repl_worker.py", "llm"), ("/opt/rlm/repl_worker.py", "_truncate")]
        async with started(tmp_path, mode="repo", workspace=git_repo, limits=contract.EDIT_LIMITS_V4) as w:
            r = await w.run_cell("read_file('missing.py')")
            assert native not in r.error and 'File "/opt/rlm/repl_tools.py", line ' in r.error, r.error
            assert r.error.splitlines()[-1].startswith("FileNotFoundError")
            r = await w.run_cell("raise KeyError('/opt/x.py')")  # only frame paths change, never the message
            assert r.error == ('Traceback (most recent call last):\n  File "<repl>", line 1, in <module>\n'
                               "KeyError: '/opt/x.py'")

    go(main())


def test_submit_types_and_size(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            cases = [("submit(3)", 3), ("submit(2.5)", 2.5), ("submit('a')", "a"), ("submit((1, 'b'))", [1, "b"]),
                     ("submit({2, 1})", [1, 2]), ("submit(True)", "True"), ("submit({'k': 1})", "{'k': 1}"),
                     ("submit([1, [2]])", [1, "[2]"])]
            for code, answer in cases:
                r = await w.run_cell(code)
                assert (r.submitted, r.answer, r.answer_valid, r.error) == (True, answer, True, None), code
            r = await w.run_cell("submit('x' * 100_001)")
            assert not r.submitted and r.answer is None
            assert r.error.splitlines()[-1] == ("ValueError: answer too large (100,003 characters as JSON; "
                                                "the limit is 100,000)")
            assert not (await w.run_cell("print(1)")).submitted  # reset each cell

    go(main())


def test_link_safety(tmp_path: Path) -> None:
    code = """import os, sys
os.write(1, b'{"type": "result", "id": 99}\\n')
os.write(2, b'raw two\\n')
try:
    input()
except EOFError:
    print('input eof')
print(repr(sys.stdin.read()), os.read(0, 10))
os.close(1)
os.close(2)
"""

    async def main() -> None:
        async with started(tmp_path) as w:
            r = await asyncio.wait_for(w.run_cell(code), 30)
            assert r.error is None
            assert '{"type": "result", "id": 99}\nraw two\n' in r.stdout
            assert "input eof\n" in r.stdout and "'' b''" in r.stdout
            r = await w.run_cell("print('alive'); import os; os.write(1, b'fd still works\\n')")
            assert r.stdout == "alive\nfd still works\n" and not r.restarted

    go(main())


def test_child_and_system_output_reach_the_cell(tmp_path: Path) -> None:
    code = "import os, subprocess, sys\nsubprocess.run([sys.executable, '-c', \"print('child out')\"])\nos.system('echo sys out')"

    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell(code)
            assert r.error is None, r.error
            assert "child out" in r.stdout and "sys out" in r.stdout

    go(main())


def test_sys_stderr_is_hidden(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("import sys\nprint('to err', file=sys.stderr)\nprint('to out')")
            assert (r.stdout, r.stderr) == ("to out\n", "to err\n")

    go(main())


def test_utf8_open(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("open('u.txt', 'w').write('é')\nprint(open('u.txt').read())")
            assert r.error is None and r.stdout == "é\n"
            assert (tmp_path / "scratch" / "u.txt").read_bytes() == "é".encode("utf-8")

    go(main())


def test_env_strips_keys_and_temp_is_scratch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("RLMH_TEST_API_KEY", "my_token", "Db_Password", "SOME_SECRET", "GH_AUTH_X", "CREDENTIALS_FILE",
                 "OPENAI_CUSTOM_HEADERS", "ANTHROPIC_CUSTOM_HEADERS", "rlmh_test_headers",
                 "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_VALUE_7"):
        monkeypatch.setenv(name, "FAKE-value")  # git's env config goes as a whole (D-62)
    monkeypatch.setenv("RLMH_TEST_PLAIN", "kept")
    monkeypatch.setenv("PYTHONUNBUFFERED", "1")  # the engine's, never the model's commands'
    code = ("import os, tempfile\nprint(sorted(k for k, v in os.environ.items() if v == 'FAKE-value'))\n"
            "print(os.environ.get('RLMH_TEST_PLAIN'))\nprint(tempfile.gettempdir())\n"
            "print(os.environ.get('PYTHONUNBUFFERED'))")

    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell(code)
            listed, plain, temp, unbuffered = r.stdout.splitlines()
            assert (listed, plain, unbuffered) == ("[]", "kept", "None")
            assert os.path.realpath(temp) == os.path.realpath(tmp_path / "scratch")

    go(main())


def test_sub_call_limits_reach_the_worker(tmp_path: Path) -> None:
    seen: list[list[str]] = []

    async def record(request: dict) -> dict:
        seen.append(request["prompts"])
        return {"outputs": ["ok"] * len(request["prompts"])}

    async def main() -> None:
        async with started(tmp_path, on_request=record) as w:  # READ_LIMITS_V4: 60,000 characters, "error"
            r = await w.run_cell("llm('x' * 60001)")
            assert r.error.splitlines()[-1] == "ValueError: " + contract.oversize_message(60001, 60000)
            assert seen == []
        cut = dataclasses.replace(READ, subcall_max_chars=10, subcall_oversize="truncate")
        async with started(tmp_path, on_request=record, limits=cut) as w:
            r = await w.run_cell("print(llm_batch(['y' * 12, 'short']))")
            assert r.stdout == "['ok', 'ok']\n"
            assert seen == [["y" * 10 + "\n" + contract.SUBCALL_TRUNCATION_MARK, "short"]]

    go(main())


def test_request_lines(tmp_path: Path) -> None:
    lines: list[Any] = []

    async def record(request: dict) -> dict:
        lines.append(request["line"])
        return {"outputs": ["ok"] * len(request["prompts"])}

    code = """x = 1
llm('a')
def f():
    return llm('b')
f()
import threading
t = threading.Thread(target=lambda: llm('c'))
t.start(); t.join()
"""

    async def main() -> None:
        async with started(tmp_path, on_request=record) as w:
            r = await w.run_cell(code)
            assert r.error is None
            assert lines == [2, 4, 7]

    go(main())


def test_an_over_long_request_is_an_error_not_silence(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A batch whose request line is over the engine's limit gets an error reply, raised in the cell, instead of being
    dropped while the cell waits out its time (review #7)."""
    seen: list[int] = []

    async def record(request: dict) -> dict:
        seen.append(len(request["prompts"]))
        return {"outputs": ["ok"] * len(request["prompts"])}

    monkeypatch.setattr(manager, "REQUEST_LINE_LIMIT", 512 * 1024)  # the engine's side only: the worker sends it

    async def main() -> None:
        async with started(tmp_path, on_request=record, limits=short(30)) as w:
            start = time.monotonic()
            r = await w.run_cell("llm_batch(['é' * 50_000] * 4)")  # ~1.2 MB as ASCII JSON
            assert time.monotonic() - start < 10
            assert r.error.splitlines()[-1] == f"RuntimeError: {manager.REQUEST_TOO_LARGE}"
            assert not r.restarted and seen == []
            assert (await w.run_cell("print(llm_batch(['a', 'b']))")).stdout == "['ok', 'ok']\n"
            # The worker refuses one over its own limit before sending it.
            r = await w.run_cell("import sys\nsys.modules['__main__'].REQUEST_MAX_BYTES = 1000\nllm('x' * 2000)")
            assert re.fullmatch(r"RuntimeError: the request is [\d,]+ bytes; one request carries at most 1,000\. "
                                r"Send fewer or shorter prompts per call\.", r.error.splitlines()[-1])
            assert seen == [2]

    go(main())


def test_request_limits_agree() -> None:
    from rlm_engine.worker import worker

    assert worker.REQUEST_MAX_BYTES == manager.REQUEST_LINE_LIMIT
    assert manager._REQUEST_START.match(json.dumps({"type": "request", "id": 42, "op": "llm"}).encode()).group(1) == b"42"


class Chunks:
    """A stream that hands out the given chunks, then EOF."""

    def __init__(self, *chunks: bytes) -> None:
        self.chunks = list(chunks)

    def read(self, n: int) -> bytes:
        assert n <= manager.STDERR_READ
        return self.chunks.pop(0) if self.chunks else b""

    def close(self) -> None:
        pass


def test_stderr_is_read_in_bounded_pieces(tmp_path: Path) -> None:
    """A huge diagnostic line without a newline is never buffered whole: its start is kept, the rest skipped (#26)."""
    w = make_worker(tmp_path)
    huge = [b"x" * manager.STDERR_READ] * 200  # 13 MB, no newline
    w._read_stderr(Chunks(b"first\r\npartial ", b"line\n", *huge, b"xx\nafter\n", "é".encode() * 600, b"\nend"))
    assert list(w.stderr_lines) == ["first", "partial line", "x" * manager.STDERR_LINE_CHARS, "after",
                                    "é" * manager.STDERR_LINE_CHARS, "end"]


def test_vars_mid_cell(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            assert await w.vars() == []
            cell = asyncio.ensure_future(w.run_cell(
                "a = [1, 2, 3]\n_hidden = 1\nname = 'é' * 5\nimport time\nfor _ in range(60):\n    time.sleep(0.02)"))
            await asyncio.sleep(0.4)
            listed = {v["name"]: v for v in await w.vars()}
            await cell
            assert listed["a"] == {"name": "a", "type": "list", "len": 3, "chars": 9}
            assert listed["name"] == {"name": "name", "type": "str", "len": 5, "chars": 7}
            assert listed["time"]["type"] == "module" and listed["time"]["len"] is None
            assert not {"context", "llm", "llm_batch", "submit", "fetch", "_hidden", "_", "__builtins__"} & set(listed)
        assert await w.vars() == []  # closed

    go(main())


SNEAKY = """
class Sneaky(type):
    @property
    def __name__(cls):
        open('ran.txt', 'a').write('metaclass name\\n')
        return 'x'

class Loud(metaclass=Sneaky):
    def __repr__(self):
        open('ran.txt', 'a').write('repr\\n')
        return llm('deadlock?')
    def __len__(self):
        open('ran.txt', 'a').write('len\\n')
        return 1

class Text(str):
    def __len__(self):
        open('ran.txt', 'a').write('str len\\n')
        return 1

obj = Loud()
inside = [1, Loud(), 'x']
text = Text('abc')
loop = [1]
loop.append(loop)
big = 'x' * 2_000_000
many = list(range(400_000))
nested = {'a': [1, (2,)], 'b': frozenset()}
"""


def test_vars_runs_no_model_code(tmp_path: Path) -> None:
    """`vars` answers on the reader thread, which the audit hook never asks on and which delivers replies: it must not
    call the model's __repr__, __len__ or metaclass __name__, nor build a huge repr (review #4)."""
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell(SNEAKY)
            assert r.error is None, r.error
            listed = {v["name"]: v for v in await w.vars()}
            assert not (tmp_path / "scratch" / "ran.txt").exists()
            assert listed["obj"] == {"name": "obj", "type": "Loud", "len": None, "chars": 0}
            assert listed["inside"] == {"name": "inside", "type": "list", "len": 3, "chars": 0}
            assert listed["text"] == {"name": "text", "type": "Text", "len": None, "chars": 0}
            assert listed["loop"] == {"name": "loop", "type": "list", "len": 2, "chars": len("[1, [...]]")}
            assert listed["big"] == {"name": "big", "type": "str", "len": 2_000_000, "chars": 10**6}
            assert listed["many"] == {"name": "many", "type": "list", "len": 400_000, "chars": 10**6}
            assert listed["nested"]["chars"] == len(repr({'a': [1, (2,)], 'b': frozenset()}))
            assert listed["Loud"]["type"] == "Sneaky" and listed["Loud"]["chars"] == 0
            assert not (tmp_path / "scratch" / "ran.txt").exists()

    go(main())


def test_close_twice(tmp_path: Path) -> None:
    async def main() -> None:
        w = make_worker(tmp_path)
        await w.start()
        proc = w._proc
        await w.close()
        await w.close()
        assert proc is not None and proc.poll() is not None

    go(main())


# ----------------------------------------------------------------------------- failures


def test_timeout_restarts_and_loses_variables(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path, limits=short(1)) as w:
            await w.run_cell("x = 1")
            started_at = time.monotonic()
            r = await w.run_cell("while True:\n    pass")
            assert time.monotonic() - started_at < 15
            assert r == CellResult("", 0, w.messages.timeout, restarted=True, crash="timeout",
                                   compute_s=r.compute_s, blocked_s=r.blocked_s, wall_s=r.wall_s)
            assert r.error == contract.cell_messages(short(1), edit=False).timeout
            assert (w.timeouts, w.restarts, w.crashes) == (1, 1, 0)
            r = await w.run_cell("print(x)")
            assert r.error.splitlines()[-1] == "NameError: name 'x' is not defined"
            assert (await w.run_cell("print(len(context))")).stdout == "3\n"

    go(main())


GRANDCHILD = """
import subprocess, sys, time
g = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
open(sys.argv[1], 'w').write(f'{g.pid}')
time.sleep(120)
"""


def test_timeout_kills_the_process_tree(tmp_path: Path) -> None:
    pids_file = tmp_path / "scratch" / "pids.txt"
    code = f"""import os, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', {GRANDCHILD!r}, {str(pids_file)!r}])
while not os.path.exists({str(pids_file)!r}) or not open({str(pids_file)!r}).read():
    time.sleep(0.02)
open({str(tmp_path / 'scratch' / 'child.txt')!r}, 'w').write(str(child.pid))
while True:
    pass
"""

    async def main() -> None:
        async with started(tmp_path, limits=short(3)) as w:
            r = await w.run_cell(code)
            assert r.crash == "timeout"
            child = int((tmp_path / "scratch" / "child.txt").read_text())
            grandchild = int(pids_file.read_text())
            assert wait_dead(child) and wait_dead(grandchild)

    go(main())


SLEEPER = """
import subprocess, sys, time
quiet = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'], **quiet)
open(sys.argv[1], 'w').write(str(child.pid))
if sys.argv[2] == 'stay':
    time.sleep(120)
"""


def shell_command(script: Path, *args: str) -> str:
    """Run `script` with this Python in find_shell()'s shell."""
    kind = find_shell().kind
    parts = [sys.executable, str(script), *args]
    if kind == "bash":
        parts = [p.replace("\\", "/") for p in parts]
    quoted = " ".join(f'"{p}"' for p in parts)
    return f"& {quoted}" if kind == "powershell" else quoted


def test_shell_processes_die_with_the_worker(tmp_path: Path, git_repo: Path) -> None:
    """shell() starts its own session (POSIX) or process group (Windows), out of reach of a kill aimed at the worker's
    group: what it left running, and a shell() still running on a thread, die when the worker closes (review #3, #5)."""
    script = tmp_path / "sleeper.py"
    script.write_text(SLEEPER, encoding="utf-8")
    left, running = tmp_path / "left.txt", tmp_path / "running.txt"
    code = f"""import os, threading, time
print(shell({shell_command(script, str(left), 'go')!r}).code)
threading.Thread(target=shell, args=({shell_command(script, str(running), 'stay')!r},), daemon=True).start()
while not os.path.exists({str(running)!r}) or not open({str(running)!r}).read():
    time.sleep(0.02)
"""

    async def main() -> None:
        async with started(tmp_path, mode="repo", workspace=git_repo, limits=contract.EDIT_LIMITS_V4) as w:
            r = await w.run_cell(code)
            assert (r.error, r.stdout) == (None, "0\n")
            pids = [int(left.read_text()), int(running.read_text())]
            assert all(alive(pid) for pid in pids)
            if POSIX:
                assert (tmp_path / "scratch" / "shell-groups").read_text().split()
        assert [wait_dead(pid) for pid in pids] == [True, True]
        assert not (tmp_path / "scratch" / "shell-groups").exists()

    go(main())


def test_a_dead_workers_children_die_on_recovery(tmp_path: Path) -> None:
    """A worker that exits leaves its child to the cleanup, which must still reach it: on Windows taskkill /T can't
    find children of a dead parent, the job object can (review #5)."""
    pid_file = tmp_path / "scratch" / "child.txt"
    code = f"""import os, subprocess, sys
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'])
open({str(pid_file)!r}, 'w').write(str(child.pid))
os._exit(3)
"""

    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell(code)
            assert r.restarted and r.crash == "exit code 3"
            assert wait_dead(int(pid_file.read_text()))

    go(main())


def test_blocked_time_does_not_count(tmp_path: Path) -> None:
    async def slow(request: dict) -> dict:
        await asyncio.sleep(2.0)
        return {"outputs": ["late"]}

    async def main() -> None:
        async with started(tmp_path, limits=short(1), on_request=slow) as w:
            r = await w.run_cell("print(llm('a'))")
            assert (r.stdout, r.crash) == ("late\n", None)
            assert r.blocked_s >= 1.9 and r.compute_s < 1.0 and r.wall_s >= r.blocked_s

    go(main())


def test_exit_code_restarts(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("import os\nos._exit(7)")
            assert (r.crash, r.restarted) == ("exit code 7", True)
            assert r.error == w.messages.crash.format(reason="exit code 7")
            assert (w.crashes, w.restarts) == (1, 1)
            assert (await w.run_cell("print('back')")).stdout == "back\n"

    go(main())


@pytest.mark.skipif(not POSIX, reason="signals are POSIX only")
def test_sigkill_reason(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("import os, signal\nos.kill(os.getpid(), signal.SIGKILL)")
            assert r.crash == "killed by SIGKILL"
            assert r.error == w.messages.crash.format(reason="killed by SIGKILL")

    go(main())


def test_death_between_cells_adds_not_run(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("import os, threading, time\n"
                                 "threading.Thread(target=lambda: (time.sleep(0.3), os._exit(5))).start()")
            assert r.error is None and not r.restarted
            await asyncio.sleep(1.5)
            r = await w.run_cell("print('never runs')")
            assert r.error == w.messages.crash.format(reason="exit code 5") + w.messages.not_run
            assert (r.restarted, r.crash, r.stdout) == (True, "exit code 5", "")
            assert (await w.run_cell("print('next')")).stdout == "next\n"

    go(main())


def test_parse_rejects_bad_results(tmp_path: Path) -> None:
    w = make_worker(tmp_path)
    good = {"stdout": "a", "stdout_chars": 1, "error": None, "stderr": "", "submitted": False, "answer": None}
    assert w._parse(good) == CellResult("a", 1, None)
    for bad in ({**good, "stdout": 3}, {**good, "error": 5}, {**good, "stderr": None}, {**good, "stdout_chars": "x"},
                {k: v for k, v in good.items() if k != "submitted"}, {k: v for k, v in good.items() if k != "stdout"}):
        assert w._parse(bad) is None, bad
    r = w._parse({**good, "submitted": True, "answer": {"k": 1}})
    assert (r.submitted, r.answer, r.answer_valid) == (True, None, False)
    r = w._parse({**good, "stdout": "y" * 9000, "stdout_chars": 2, "error": "e" * 20000, "stderr": "s" * 5000})
    assert (len(r.stdout), r.stdout_chars, len(r.error), len(r.stderr)) == (8000, 9000, 16000, 4000)
    assert w._parse({**good, "stdout": "\ud800"}).stdout == "?"


def test_wall_cap_is_infra(tmp_path: Path) -> None:
    async def stuck(request: dict) -> dict:
        await asyncio.sleep(30)
        return {"outputs": ["never"]}

    async def main() -> None:
        async with started(tmp_path, on_request=stuck, wall_cap_s=1) as w:
            with pytest.raises(InfraError) as err:
                await w.run_cell("llm('a')")
            assert err.value.kind == "worker"
            assert str(err.value) == "a cell waited over 1 s on requests"

    go(main())


def test_repo_wall_cap_adds_the_cell_limit(tmp_path: Path) -> None:
    w = make_worker(tmp_path, mode="repo", workspace=tmp_path, limits=contract.EDIT_LIMITS_V4)
    assert w.wall_cap_s == 1800 + contract.EDIT_LIMITS_V4.cell_timeout_s
    assert make_worker(tmp_path).wall_cap_s == 1800


def test_bad_python_path_is_infra(tmp_path: Path) -> None:
    async def main() -> None:
        w = make_worker(tmp_path, python=str(tmp_path / "no-such-python"))
        with pytest.raises(InfraError) as err:
            await w.start()
        assert err.value.kind == "worker"
        assert "worker failed to start (2 attempts)" in str(err.value) and "no-such-python" in str(err.value)
        assert w.start_retries == 1

    go(main())


def test_worker_that_exits_at_once_is_infra(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    script = tmp_path / "dies.py"
    script.write_text("import sys\nprint('boom from the worker', file=sys.stderr)\nsys.exit(1)\n", encoding="utf-8")
    monkeypatch.setattr(manager, "WORKER_PATH", script)

    async def main() -> None:
        w = make_worker(tmp_path)
        with pytest.raises(InfraError) as err:
            await w.start()
        assert "worker failed to start (2 attempts)" in str(err.value)
        assert "boom from the worker" in str(err.value)

    go(main())


def test_infra_error_from_on_request(tmp_path: Path) -> None:
    async def failing(request: dict) -> dict:
        raise InfraError("rate_limit", "sub-call: rate limited")

    async def main() -> None:
        async with started(tmp_path, on_request=failing) as w:
            proc = w._proc
            with pytest.raises(InfraError) as err:
                await w.run_cell("llm('a')\nimport time\ntime.sleep(30)")
            assert (err.value.kind, str(err.value)) == ("rate_limit", "sub-call: rate limited")
            assert proc.poll() is not None
            with pytest.raises(InfraError):
                await w.run_cell("print(1)")

    go(main())


def test_unexpected_handler_error_is_internal_infra(tmp_path: Path) -> None:
    async def broken(request: dict) -> dict:
        raise KeyError("oops")

    async def main() -> None:
        async with started(tmp_path, on_request=broken) as w:
            with pytest.raises(InfraError) as err:
                await w.run_cell("llm('a')")
            assert err.value.kind == "internal"

    go(main())


# ----------------------------------------------------------------------------- repo mode


def test_repo_changed(tmp_path: Path, git_repo: Path) -> None:
    async def main() -> None:
        async with started(tmp_path, mode="repo", workspace=git_repo, limits=contract.EDIT_LIMITS_V4) as w:
            r = await w.run_cell("print(write_file('new.txt', 'x'))")
            assert (r.stdout, r.repo_changed) == ("wrote new.txt (1 lines)\n", True)
            r = await w.run_cell("print(read_file('a.py'))")
            assert (r.stdout, r.repo_changed) == ("     1\tx = 1\n", False)
            r = await w.run_cell("import os\nos._exit(3)")
            assert r.restarted and r.repo_changed is False
            assert (await w.run_cell("print(sorted(n for n in dir() if not n.startswith('_')))")).stdout == (
                "['context', 'diff', 'edit_file', 'fetch', 'find_files', 'grep', 'llm', 'llm_batch', 'read_file', "
                "'shell', 'submit', 'write_file']\n")

    go(main())


def test_read_mode_has_no_tools(tmp_path: Path) -> None:
    async def main() -> None:
        async with started(tmp_path) as w:
            r = await w.run_cell("print(sorted(n for n in dir() if not n.startswith('_')))")
            assert r.stdout == "['context', 'fetch', 'llm', 'llm_batch', 'submit']\n"

    go(main())


# ----------------------------------------------------------------------------- shared constants


def test_worker_constants_equal_contract() -> None:
    tree = ast.parse(WORKER_SOURCE.read_text(encoding="utf-8"))
    values = {node.targets[0].id: ast.literal_eval(node.value) for node in tree.body
              if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)
              and node.targets[0].id.isupper() and isinstance(node.value, (ast.Constant, ast.Tuple))}
    for name in ("OUTPUT_MAX_CHARS", "TRACEBACK_LINES", "SUBMIT_MAX_BYTES", "SUBCALL_TRUNCATION_MARK",
                 "SUBCALL_MAX_CHARS", "API_NAMES"):
        assert values[name] == getattr(contract, name), name
    assert "from __future__" not in WORKER_SOURCE.read_text(encoding="utf-8")
