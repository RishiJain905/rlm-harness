"""KV cache: none

`loop.run` end to end against `FakeApp(script=...)` and a real `Worker`: the exact messages the root model sees,
the counters, the last-turn line, the no-code error, truncation, pacing, both call formats, every event's keys and
order, usage sums, and how each kind of failure ends a run (spec step 6, tests).
"""

from __future__ import annotations

import asyncio
import json
import re
import secrets
from pathlib import Path

import pytest

from conftest import needs_git, run
from fakeapp import FakeApp
from rlm_engine import callformat, contract, loop, workspace
from rlm_engine.errors import InfraError
from rlm_engine.profiles import BUILTIN_DIR, Profile, load_profile
from rlm_engine.runlog import RECORD_KEYS, RunLog
from rlm_engine.worker.manager import Worker

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 90

# §5.3, hard-coded on purpose: a change to the wire has to change this table too
EVENT_KEYS = {
    "run.started": {"tag", "mode", "profile", "prompt_hash", "profile_hash", "contract_hash", "call_format", "root",
                    "sub", "permission_mode", "workspace", "input", "limits", "log_path"},
    "run.reply": {"turn", "text", "tool_call", "reasoning", "finish_reason", "usage", "seconds"},
    "run.cell": {"turn", "code", "output", "error", "observation", "seconds", "restarted", "crash", "repo_changed"},
    "run.subcall": {"subcall_id", "origin", "batch", "prompt_chars", "status", "error", "seconds"},
    "run.permission": {"turn", "kind", "detail", "allowed", "asked", "remembered"},
    "run.budget": {"turns_left", "subcalls_left"},
    "run.finished": {"tag", "answer", "submitted", "answer_valid", "turns", "subcalls", "usage", "cost_usd",
                     "infra_error", "infra_kind", "wall_s", "log_path"},
}


# ---------------------------------------------------------------------------------------------- helpers


def fenced(code: str, text: str = "Next.") -> dict:
    return {"text": f"{text}\n```python\n{code}\n```"}


def tool(code: str) -> dict:
    return {"text": "", "tool_call": {"code": code}}


def short_profile(home: Path, section: str, **changes: object) -> Profile:
    """The built-in training-v4 profile.toml with keys of one mode table replaced, saved as a user profile."""
    lines = (BUILTIN_DIR / "training-v4" / "profile.toml").read_text(encoding="utf-8").splitlines()
    current = None
    for i, line in enumerate(lines):
        if line.startswith("["):
            current = line.split("]")[0].strip("[")
        key = line.split("=")[0].strip()
        if current == section and key in changes:
            lines[i] = f"{key} = {json.dumps(changes.pop(key))}"
    assert not changes, f"keys not in [{section}]: {changes}"
    name = "short-" + secrets.token_hex(3)
    folder = home / "profiles" / name
    folder.mkdir(parents=True)
    (folder / "profile.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return load_profile(name, home)


def read_spec(home: Path, profile: Profile | None = None, *, text: str = "first line\nsecond line\nthird\nfourth\n",
              call_format: str = "fenced", mode: str = "accept-edits") -> loop.RunSpec:
    path = home / "input.txt"
    path.write_bytes(text.encode("utf-8"))
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=profile or load_profile("training-v4", home),
        root=dict(REF), sub=dict(REF), permission_mode=mode, call_format=call_format, interactive=False,
        question="What is it?", inputs=[path], task=None, repo_path=None, test_hint=None, language=None,
        n_files=None, context=None, tag="t1", batch="test", log_path=home / "runs" / "test" / "runs.jsonl")


def repo_spec(home: Path, repo: Path, profile: Profile | None = None, **overrides: object) -> loop.RunSpec:
    spec = loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="repo", profile=profile or load_profile("training-v4", home),
        root=dict(REF), sub=dict(REF), permission_mode="accept-edits", call_format="fenced", interactive=False,
        question=None, inputs=[], task="Make parse() strip spaces.", repo_path=repo, test_hint=None, language=None,
        n_files=None, context=None, tag=None, batch="test", log_path=home / "runs" / "test" / "runs.jsonl")
    for key, value in overrides.items():
        setattr(spec, key, value)
    return spec


def play(spec: loop.RunSpec, app: FakeApp, home: Path, factory=Worker) -> dict:
    return run(loop.run(spec, app, home=home, worker_factory=factory), TIMEOUT)


def roots(app: FakeApp) -> list[dict]:
    return [r for r in app.requests if r["role"] == "root"]


def observations(app: FakeApp) -> list[str]:
    """The observation each root request after the first ends with."""
    return [r["messages"][-1]["content"] for r in roots(app)[1:]]


class Capture:
    """A worker factory that keeps the worker it made."""

    def __init__(self) -> None:
        self.worker: Worker | None = None

    def __call__(self, **kwargs: object) -> Worker:
        self.worker = Worker(**kwargs)
        return self.worker


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    h.mkdir()
    return h


# ---------------------------------------------------------------------------------------------- the messages


def test_read_counters(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print('hello')"), fenced("submit('x')")]})
    spec = read_spec(home)
    record = play(spec, app, home)
    profile = spec.profile
    limits = profile.read.limits
    messages = roots(app)[1]["messages"]
    assert [m["role"] for m in messages] == ["system", "user", "assistant", "user"]
    assert messages[0]["content"] == profile.system_prompt(workspace.find_shell().name)
    assert messages[1]["content"] == contract.first_user_message("What is it?", spec.context, limits)
    # print() ends its line, and training's observation joins its parts with "\n", hence the blank line
    assert messages[3]["content"] == "REPL output:\nhello\n\n(19 turns left, 80 sub-calls left)"
    assert record["submitted"] and record["answer"] == "x"
    assert record["messages"] == roots(app)[1]["messages"] + [record["messages"][-1]]
    assert sorted(record) == sorted(RECORD_KEYS)


def test_subcall_counter(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print(llm_batch(['a', 'b', 'c']))"), fenced("submit('x')")],
                          "sub": [{"text": "ok"}]})
    record = play(read_spec(home), app, home)
    assert observations(app)[0].endswith("(19 turns left, 77 sub-calls left)")
    assert len(record["subcalls"]) == 3
    assert [s["subcall_id"] for s in record["subcalls"]] == [1, 2, 3]
    assert app.sent("run.finished")[0]["subcalls"] == 3


def test_last_turn_line(home: Path) -> None:
    profile = short_profile(home, "read", max_turns=3)
    app = FakeApp(script={"root": [fenced("print(1)"), fenced("print(2)"), fenced("print(3)")]})
    record = play(read_spec(home, profile), app, home)
    assert observations(app)[1].endswith(
        "(1 turns left, 80 sub-calls left)\nYour next turn is the last one: it must call submit() with your best answer.")
    assert app.sent("run.cell")[-1]["observation"] is None
    assert record["submitted"] is False
    assert len(roots(app)) == 3
    assert record["infra_error"] is None and len(record["turns"]) == 3


def test_no_code_error(home: Path) -> None:
    capture = Capture()
    app = FakeApp(script={"root": [{"text": "I will think about it."}, fenced("submit('x')")]})
    record = play(read_spec(home), app, home, capture)
    assert contract.no_code_error().startswith("No ```python code block found.")
    assert observations(app)[0] == ("REPL output: (nothing printed)\nError:\n" + contract.no_code_error()
                                    + "\n(19 turns left, 80 sub-calls left)")
    assert app.sent("run.cell")[0]["code"] is None
    assert capture.worker.cells == 1  # only the submit ran
    assert record["turns"][0]["code"] is None


def test_truncation(home: Path) -> None:
    profile = short_profile(home, "read", output_max_chars=100)
    app = FakeApp(script={"root": [fenced("print('x' * 300, end='')"), fenced("raise ValueError('e' * 1000)"),
                                   fenced("submit('x')")]})
    record = play(read_spec(home, profile), app, home)
    shown = "x" * 100 + "\n[... 200 more characters truncated]"
    assert observations(app)[0].startswith("REPL output:\n" + shown + "\n(")
    assert app.sent("run.cell")[0]["output"] == shown
    assert len(app.sent("run.cell")[1]["error"]) == 200
    assert record["turns"][0]["stdout"] == "x" * 100 and record["turns"][0]["stdout_chars"] == 300


# ---------------------------------------------------------------------------------------------- repo mode


@needs_git
def test_pacing_repo(home: Path, git_repo: Path) -> None:
    repo = git_repo
    profile = short_profile(home, "repo", max_turns=10)
    pace_edit = contract.OBS_PACE_EDIT.split(".")[0]

    app = FakeApp(script={"root": [fenced("print(1)")] * 10})
    record = play(repo_spec(home, repo, profile), app, home)
    obs = observations(app)
    assert len(obs) == 9  # the 10th turn gets no observation
    with_line = [9 - i for i, text in enumerate(obs) if pace_edit in text]
    assert with_line == [5, 4, 3, 2]
    assert record["diff"] == ""

    app = FakeApp(script={"root": [fenced("write_file('new.txt', 'made\\n')")] + [fenced("print(1)")] * 9})
    record = play(repo_spec(home, repo, profile), app, home)
    obs = observations(app)
    test_line = "5 turns left: run the tests, fix what fails, and call submit()."
    assert [9 - i for i, text in enumerate(obs) if test_line in text] == [5]
    assert not any(pace_edit in text for text in obs)
    assert "new.txt" in record["diff"] and "+made" in record["diff"]
    assert re.fullmatch(r"[0-9a-f]{40}", record["base_tree"])
    assert record["workspace"] == str(repo)
    assert record["turns"][0]["repo_changed"] is True
    (repo / "new.txt").unlink()

    quiet = short_profile(home, "repo", max_turns=10, pace_nudge=False)
    app = FakeApp(script={"root": [fenced("print(1)")] * 10})
    play(repo_spec(home, repo, quiet), app, home)
    assert not any(pace_edit in text or "turns left: run the tests" in text for text in observations(app))


@needs_git
def test_repo_first_message(home: Path, git_repo: Path) -> None:
    repo = git_repo
    capture = Capture()
    app = FakeApp(script={"root": [fenced("submit('done')")]})
    spec = repo_spec(home, repo, language="go", n_files=7, test_hint="make check", context="CTX given")
    record = play(spec, app, home, capture)
    assert app.requests[0]["messages"][1]["content"] == contract.edit_first_message(
        "Make parse() strip spaces.", language="go", n_files=7, test_hint="make check", limits=spec.profile.repo.limits)
    assert capture.worker.context == "CTX given"
    assert record["task"] == "Make parse() strip spaces." and "question" not in record
    assert record["input"]["files"] == [] and record["input"]["chars"] == len("CTX given")


# ---------------------------------------------------------------------------------------------- call formats


def test_native_placement(home: Path) -> None:
    app = FakeApp(script={"root": [tool("print(1)"), fenced("print(2)"), tool("submit('a')")]})
    record = play(read_spec(home, call_format="native"), app, home)
    assert all(r["tools"] == [callformat.PYTHON_TOOL] for r in app.requests)
    after_tool = roots(app)[1]["messages"]
    assert after_tool[-2]["tool_call"]["id"] == "call_1"
    assert after_tool[-1] == {"role": "tool", "tool_call_id": "call_1", "content": observations(app)[0]}
    assert app.requests[2]["messages"][-1]["role"] == "user"  # a text-only reply (fenced code, D-31)
    assert record["answer"] == "a"

    app = FakeApp(script={"root": [fenced("print(1)"), fenced("submit('a')")]})
    play(read_spec(home), app, home)
    assert all(r["tools"] == [] for r in app.requests)


# ---------------------------------------------------------------------------------------------- events and the record


def test_event_shapes_and_order(home: Path) -> None:
    seen_in_log: list[int] = []

    class Checking(FakeApp):
        def event(self, method: str, params: dict) -> None:
            if method == "run.finished":
                seen_in_log.append(len(RunLog(Path(params["log_path"])).records()))
            super().event(method, params)

    probe = "try:\n    fetch('http://127.0.0.1:9/')\nexcept Exception as e:\n    print(type(e).__name__)"
    app = Checking(script={"root": [fenced("print(llm('hi'))"), fenced(probe), fenced("submit('x')")],
                           "sub": [{"text": "hello back"}]})
    spec = read_spec(home, mode="default")
    record = play(spec, app, home)
    methods = [m for m, _ in app.events]
    assert set(methods) == set(EVENT_KEYS)
    for method, params in app.events:
        assert set(params) == EVENT_KEYS[method] | {"run_id"}, method
        assert params["run_id"] == spec.run_id
    assert methods[0] == "run.started" and methods[-1] == "run.finished"
    assert [p["turn"] for p in app.sent("run.reply")] == [1, 2, 3]
    assert [p["turn"] for p in app.sent("run.cell")] == [1, 2, 3]

    def at(method: str, turn: int) -> int:
        return next(i for i, (m, p) in enumerate(app.events) if m == method and p["turn"] == turn)

    for turn in (1, 2):  # turn 3 submits: no budget after it
        reply, cell, next_reply = at("run.reply", turn), at("run.cell", turn), at("run.reply", turn + 1)
        assert reply < cell < next_reply
        assert "run.budget" in methods[cell + 1:next_reply]
    assert seen_in_log == [1]
    assert observations(app)[1].startswith("REPL output:\nPermissionError")
    started = app.sent("run.started")[0]
    assert started["input"]["files"] == [spec.inputs[0].as_posix()]
    assert started["limits"]["max_turns"] == 20 and set(started["limits"]) == set(loop.EVENT_LIMITS)
    permission = app.sent("run.permission")[0]
    assert permission["allowed"] is False and permission["asked"] is False
    assert record["permissions"] == [{k: v for k, v in permission.items() if k != "run_id"}]
    assert record["fetches"] == []  # denied before any request
    assert record["subcalls"][0]["output"] == "hello back"


def test_usage_sums(home: Path) -> None:
    def usage(i: int, o: int, r: int, w: int, cost: float) -> dict:
        return {"input_tokens": i, "output_tokens": o, "cache_read_tokens": r, "cache_write_tokens": w,
                "reasoning_tokens": 0, "cost_usd": cost}

    app = FakeApp(script={
        "root": [{**fenced("print(llm('a'))"), "usage": usage(100, 10, 60, 40, 0.25)},
                 {**fenced("submit('x')"), "usage": usage(300, 20, 100, 0, 0.5)}],
        "sub": [{"text": "s", "usage": usage(40, 4, 0, 0, 0.125)}]})
    record = play(read_spec(home), app, home)
    assert record["usage"]["root"] == usage(400, 30, 160, 40, 0.75)
    assert record["usage"]["sub"] == usage(40, 4, 0, 0, 0.125)
    assert record["cost_usd"] == 0.875
    assert record["cache"] == {"read_tokens": 160, "write_tokens": 40, "hit_rate": 160 / 440}
    assert record["turns"][0]["usage"] == usage(100, 10, 60, 40, 0.25)
    assert record["subcalls"][0]["usage"] == usage(40, 4, 0, 0, 0.125)
    finished = app.sent("run.finished")[0]
    assert finished["usage"] == record["usage"] and finished["cost_usd"] == 0.875


# ---------------------------------------------------------------------------------------------- how runs fail


def log_lines(spec: loop.RunSpec) -> list[dict]:
    return RunLog(spec.log_path).records()


def test_model_error_stops(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print(1)"), fenced("print(2)")],
                          "errors": [{"role": "root", "at": 2, "kind": "auth", "status": 401}]})
    spec = read_spec(home)
    record = play(spec, app, home)
    assert len(record["turns"]) == 1
    assert record["infra_kind"] == "auth" and record["infra_error"].startswith("auth: ")
    assert not record["infra_error"].startswith("auth: auth: ")
    assert app.cancelled == [spec.run_id]
    assert not (home / "scratch" / spec.run_id).exists()
    assert log_lines(spec) == [record]
    finished = app.sent("run.finished")[0]
    assert (finished["infra_kind"], finished["infra_error"]) == ("auth", record["infra_error"])


def test_subcall_server_error_stops(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print(llm('a'))"), fenced("submit('x')")], "sub": [{"text": "s"}],
                          "errors": [{"role": "sub", "at": 1, "kind": "server", "status": 500}]})
    record = play(read_spec(home), app, home)
    assert record["infra_kind"] == "server"
    assert record["infra_error"].startswith("server: sub-call failed: ")
    assert len(app.requests) == 2  # one root call and the failed sub-call: the run stopped there
    assert record["submitted"] is False


def test_subcall_bad_request_continues(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print(llm('a'))"), fenced("submit('x')")], "sub": [{"text": "s"}],
                          "errors": [{"role": "sub", "at": 1, "kind": "bad_request", "status": 400}]})
    record = play(read_spec(home), app, home)
    assert "RuntimeError" in app.sent("run.cell")[0]["error"]
    assert record["infra_error"] is None and record["submitted"] is True


class _NoStart:
    turn = 0

    def __init__(self, **kwargs: object) -> None:
        pass

    async def start(self) -> None:
        raise InfraError("worker", "worker failed to start (2 attempts): no output")

    async def close(self) -> None:
        pass


def test_worker_start_failure(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("submit('x')")]})
    spec = read_spec(home)
    record = play(spec, app, home, _NoStart)
    assert [m for m, _ in app.events] == ["run.finished"]
    assert app.sent("run.finished")[0]["infra_kind"] == "worker"
    assert record["infra_error"] == "worker: worker failed to start (2 attempts): no output"
    assert app.requests == []
    assert not (home / "scratch" / spec.run_id).exists()


def test_host_bug(home: Path, capsys: pytest.CaptureFixture) -> None:
    def boom(**kwargs: object) -> Worker:
        raise RuntimeError("boom")

    app = FakeApp(script={"root": [fenced("submit('x')")]})
    spec = read_spec(home)
    record = play(spec, app, home, boom)
    assert record["infra_kind"] == "host_bug"
    assert record["infra_error"] == "host error: RuntimeError('boom')"
    assert "boom" in record["host_traceback"] and "Traceback" in record["host_traceback"]
    err = capsys.readouterr().err
    assert "Traceback" in err and "RuntimeError: boom" in err
    assert log_lines(spec) == [record]


def test_cancel(home: Path) -> None:
    async def scenario() -> tuple[FakeApp, loop.RunSpec]:
        asked = asyncio.Event()

        async def block(params: dict) -> dict:
            asked.set()
            await asyncio.Event().wait()
            raise AssertionError("unreachable")

        app = FakeApp(complete=block)
        spec = read_spec(home)
        task = asyncio.create_task(loop.run(spec, app, home=home))
        await asyncio.wait_for(asked.wait(), 30)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return app, spec

    app, spec = run(scenario(), TIMEOUT)
    (record,) = log_lines(spec)
    assert record["infra_error"] == "cancelled" and record["infra_kind"] == "cancelled"
    assert app.events[-1][0] == "run.finished"
    assert app.sent("run.finished")[0]["infra_error"] == "cancelled"
    assert not (home / "scratch" / spec.run_id).exists()
    assert app.cancelled == [spec.run_id]
