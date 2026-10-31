"""KV cache: none

`run.start`, `run.cancel` and `run.vars` on a real Link (spec step 6, tests): the checks and their error codes, the
result, the order of the first lines on the wire (§5.4), cancelling, the REPL's variables, eight runs on one engine,
and a closed stdin cancelling what still runs.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest

from conftest import finish, pipes, run
from fakeapp import FakeApp
from rlm_engine.appport import LinkAppPort
from rlm_engine.errors import InfraError
from rlm_engine.link import Link
from rlm_engine.runlog import RunLog
from rlm_engine.service import Engine
from rlm_engine.worker.manager import Worker

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 90


def fenced(code: str) -> dict:
    return {"text": f"```python\n{code}\n```"}


def reply(code: str) -> dict:
    return {"text": f"```python\n{code}\n```", "tool_call": None, "reasoning": None,
            "usage": {"input_tokens": 1, "output_tokens": 1, "cache_read_tokens": 0, "cache_write_tokens": 0,
                      "reasoning_tokens": 0, "cost_usd": 0.0},
            "finish_reason": "stop", "served_model": "scripted", "seconds": 0.0}


def read_params(home: Path, text: str = "some input\n", name: str = "input.txt", **over: object) -> dict:
    path = home / name
    path.write_bytes(text.encode("utf-8"))
    params = {"mode": "read", "question": "What is it?", "inputs": [str(path)], "profile": "training-v4",
              "root": dict(REF), "sub": dict(REF), "permission_mode": "accept-edits", "call_format": "fenced"}
    params.update(over)
    return params


class Served:
    """An Engine on a real Link, with the test as the app's end of the pipes. With a FakeApp, only answers to the
    test's own requests come back on the wire; with `wire=True`, the engine's events and requests do too."""

    def __init__(self, home: Path, app: FakeApp | None = None, factory=None) -> None:
        self.pipes = pipes()
        self.link = Link(self.pipes.reader, self.pipes.writer)
        self.app = app
        self.engine = Engine(app if app is not None else LinkAppPort(self.link), home=home)
        if factory is not None:
            self.engine.worker_factory = factory
        self.engine.register(self.link)
        self.next_id = 0
        self.server: asyncio.Task | None = None

    async def __aenter__(self) -> Served:
        self.server = asyncio.create_task(self.link.serve())
        await asyncio.sleep(0)
        return self

    async def __aexit__(self, *exc: object) -> None:
        await finish(self.pipes, self.server)

    def send(self, method: str, params: dict) -> int:
        self.next_id += 1
        self.pipes.peer.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        return self.next_id

    async def recv(self, timeout: float = 30) -> dict:
        return await self.pipes.peer.recv(timeout)

    async def call(self, method: str, params: dict) -> dict:
        """One request and its answer (with a FakeApp nothing else is on the wire)."""
        mid = self.send(method, params)
        msg = await self.recv()
        assert msg.get("id") == mid, msg
        return msg


async def finished(app: FakeApp, run_id: str, timeout: float = 60) -> dict:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        for params in app.sent("run.finished"):
            if params["run_id"] == run_id:
                return params
        await asyncio.sleep(0.01)
    raise TimeoutError(f"no run.finished for {run_id}")


class Blocking(FakeApp):
    """Holds every root call open until `release` is set; `asked` is set at the first one. Replies come from
    `replies` in order, the first answered at once."""

    def __init__(self, replies: list[dict] | None = None, *, first_free: bool = False) -> None:
        super().__init__(complete=self._answer)
        self.asked = asyncio.Event()
        self.release = asyncio.Event()
        self.replies = list(replies or [])
        self.first_free = first_free
        self.calls = 0

    async def _answer(self, params: dict) -> dict:
        self.calls += 1
        if not (self.first_free and self.calls == 1):
            self.asked.set()
            await self.release.wait()
        return self.replies.pop(0)


# ---------------------------------------------------------------------------------------------- run.start


def test_start_errors(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    folder_file = tmp_path / "not-a-folder.txt"
    folder_file.write_text("x")
    cases = [
        (read_params(home, profile="no-such-profile"), -32011),
        ({k: v for k, v in read_params(home).items() if k != "question"}, -32012),
        (read_params(home, inputs=[str(tmp_path / "missing.txt")]), -32012),
        (read_params(home, inputs=["relative.txt"]), -32012),
        (read_params(home, inputs=[]), -32012),
        ({**read_params(home), "mode": "repo", "task": "t", "repo_path": str(folder_file)}, -32012),
        ({**read_params(home), "mode": "repo", "task": "t", "repo_path": "relative/repo"}, -32012),
        (read_params(home, permission_mode="ask-me"), -32602),
        (read_params(home, call_format="auto"), -32602),
        (read_params(home, root={"provider": "fake"}), -32602),
        (read_params(home, batch="../up"), -32602),
        (read_params(home, log_dir="relative/logs"), -32012),
    ]

    async def main() -> None:
        async with Served(home, FakeApp()) as s:
            for params, code in cases:
                msg = await s.call("run.start", params)
                assert msg["error"]["code"] == code, (params, msg)
            assert s.engine._runs == {}

    run(main(), TIMEOUT)
    assert not (home / "scratch").exists() or not any((home / "scratch").iterdir())


def test_start_result(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    out = tmp_path / "out"
    app = FakeApp(script={"root": [fenced("submit('x')")]})

    async def main() -> list[tuple[str, str]]:
        got = []
        async with Served(home, app) as s:
            for extra in ({}, {"batch": "b-1"}, {"batch": "b-1", "log_dir": str(out)}):
                msg = await s.call("run.start", read_params(home, **extra))
                assert "result" in msg, msg
                result = msg["result"]
                assert set(result) == {"run_id", "log_path"}
                await finished(app, result["run_id"])
                got.append((result["run_id"], result["log_path"]))
        return got

    got = run(main(), TIMEOUT)
    assert all(re.fullmatch(r"r_[0-9a-f]{12}", run_id) for run_id, _ in got)
    assert [Path(p) for _, p in got] == [home / "runs" / "interactive" / "runs.jsonl",
                                         home / "runs" / "b-1" / "runs.jsonl", out / "runs.jsonl"]
    assert len({run_id for run_id, _ in got}) == 3
    assert RunLog(out / "runs.jsonl").records()[0]["batch"] == "b-1"


def test_order_on_the_wire(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()

    async def main() -> None:
        async with Served(home) as s:  # events and model calls on the wire
            mid = s.send("run.start", read_params(home))
            first, second, third = await s.recv(), await s.recv(), await s.recv()
            assert first["id"] == mid and "result" in first, first
            assert second["method"] == "run.started" and "id" not in second
            assert second["params"]["run_id"] == first["result"]["run_id"]
            assert third["method"] == "model.complete" and third["params"]["role"] == "root"
            with pytest.raises(TimeoutError):  # the root call is held open: nothing more is sent
                await s.recv(timeout=0.5)

        async with Served(home, factory=_NoStart) as s:
            mid = s.send("run.start", read_params(home))
            first, second, third = await s.recv(), await s.recv(), await s.recv()
            assert first["id"] == mid and "result" in first, first
            assert second["method"] == "model.cancel"  # the run's clean-up, before its record
            assert third["method"] == "run.finished" and third["params"]["infra_kind"] == "worker"

    run(main(), TIMEOUT)


class _NoStart:
    turn = 0

    def __init__(self, **kwargs: object) -> None:
        pass

    async def start(self) -> None:
        raise InfraError("worker", "worker failed to start")

    async def close(self) -> None:
        pass


# ---------------------------------------------------------------------------------------------- run.cancel, run.vars


def test_cancel(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()

    async def main() -> None:
        app = Blocking()
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", read_params(home)))["result"]["run_id"]
            await asyncio.wait_for(app.asked.wait(), 30)
            assert (await s.call("run.cancel", {"run_id": run_id}))["result"] == {}
            (done,) = app.sent("run.finished")  # sent before the answer
            assert done["infra_error"] == "cancelled" and done["infra_kind"] == "cancelled"
            assert app.events[-1][0] == "run.finished"
            assert (await s.call("run.cancel", {"run_id": run_id}))["error"]["code"] == -32010
            assert (await s.call("run.cancel", {"run_id": "r_000000000000"}))["error"]["code"] == -32010
        assert not (home / "scratch" / run_id).exists()

    run(main(), TIMEOUT)


def test_vars(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()

    async def main() -> None:
        app = Blocking([reply("x = 'abc'"), reply("submit(x)")], first_free=True)
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", read_params(home)))["result"]["run_id"]
            await asyncio.wait_for(app.asked.wait(), 30)  # turn 2's root call: turn 1's cell has run
            found = (await s.call("run.vars", {"run_id": run_id}))["result"]["vars"]
            assert {"name": "x", "type": "str", "len": 3, "chars": 5} in found
            assert not {"context", "llm", "llm_batch", "submit"} & {v["name"] for v in found}
            app.release.set()
            assert (await finished(app, run_id))["answer"] == "abc"
            await asyncio.sleep(0.05)  # the done-callback that forgets the run
            assert (await s.call("run.vars", {"run_id": run_id}))["error"]["code"] == -32010

    run(main(), TIMEOUT)


# ---------------------------------------------------------------------------------------------- many runs, closing


def test_eight_runs_at_once(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    app = FakeApp(script={"root": [fenced("submit(context.strip())")]})

    async def main() -> list[str]:
        async with Served(home, app) as s:
            ids = [s.send("run.start", read_params(home, f"answer-{i}\n", f"in{i}.txt", tag=f"t{i}", batch="eight"))
                   for i in range(8)]
            answers = [await s.recv() for _ in ids]
            assert sorted(a["id"] for a in answers) == ids
            run_ids = [a["result"]["run_id"] for a in answers]
            for run_id in run_ids:
                await finished(app, run_id)
            return run_ids

    run_ids = run(main(), TIMEOUT)
    assert len(set(run_ids)) == 8
    records = RunLog(home / "runs" / "eight" / "runs.jsonl").records()
    assert len(records) == 8
    assert sorted(r["run_id"] for r in records) == sorted(run_ids)
    for r in records:
        assert r["answer"] == f"answer-{r['tag'][1:]}"
    assert not any((home / "scratch").iterdir())


def test_stdin_close_cancels(tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    workers: list[Worker] = []

    def capture(**kwargs: object) -> Worker:
        workers.append(Worker(**kwargs))
        return workers[-1]

    async def main() -> None:
        app = Blocking()
        async with Served(home, app, capture) as s:
            await s.call("run.start", read_params(home))
            await asyncio.wait_for(app.asked.wait(), 30)
            proc = workers[0]._proc
            assert proc is not None and proc.poll() is None
        # leaving the block closed the link's input; serve() returned after on_close cancelled the run
        assert proc.poll() is not None
        (done,) = app.sent("run.finished")
        assert done["infra_error"] == "cancelled"

    run(main(), TIMEOUT)
    (record,) = RunLog(home / "runs" / "interactive" / "runs.jsonl").records()
    assert record["infra_error"] == "cancelled"
