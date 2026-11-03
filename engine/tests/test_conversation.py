"""KV cache: none

Conversations (v1 step 4): `run.start` with `conversation: true`, `run.say`, `run.close`, `run.closed` and -32013 on a
real Link, with `FakeApp(script=...)` and a real `Worker`. Two prompts in both call formats, variables that survive,
budgets that start over while ids go on, a prompt that runs out of turns, an infra error, cancels while waiting and
mid-prompt, a repo conversation's accumulating diff, compaction across prompts, the order on the wire, an unchanged
one-shot run, stdin closing, and training-v4.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import shutil
from pathlib import Path

import pytest

from conftest import compact_profile, needs_git, run
from fakeapp import FakeApp
from rlm_engine import loop
from rlm_engine.followup import FOLLOW_UP, SUBMITTED_NOTE, UNANSWERED_NOTE, WHERE, kept_message
from rlm_engine.profiles import BUILTIN_DIR, load_profile
from rlm_engine.runlog import RunLog
from rlm_engine.worker.manager import Worker
from test_service import Served, reply

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 120
PROFILE = "convo"


def fenced(code: str, text: str = "Next.") -> dict:
    return {"text": f"{text}\n```python\n{code}\n```"}


def tool(code: str) -> dict:
    return {"text": "", "tool_call": {"code": code}}


def convo_profile(home: Path, name: str = PROFILE, **read: object) -> str:
    """The built-in default profile with `[read] max_turns = 6, max_subcalls = 5` (or `read`'s keys), saved as a
    user profile; returns its name."""
    changes = {"max_turns": 6, "max_subcalls": 5, **read}
    lines = (BUILTIN_DIR / "default" / "profile.toml").read_text(encoding="utf-8").splitlines()
    section = None
    for i, line in enumerate(lines):
        if line.startswith("["):
            section = line.split("]")[0].strip("[")
        key = line.split("=")[0].strip()
        if section == "read" and key in changes:
            lines[i] = f"{key} = {json.dumps(changes.pop(key))}"
    assert not changes, changes
    folder = home / "profiles" / name
    folder.mkdir(parents=True)
    (folder / "profile.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    shutil.copyfile(BUILTIN_DIR / "default" / "guidance.md", folder / "guidance.md")
    return name


def params(home: Path, *, call_format: str = "fenced", profile: str = PROFILE, conversation: bool = True,
           **over: object) -> dict:
    path = home / "input.txt"
    path.write_bytes(b"first line\nsecond line\n")
    p = {"mode": "read", "question": "What is it?", "inputs": [str(path)], "profile": profile, "root": dict(REF),
         "sub": dict(REF), "permission_mode": "accept-edits", "call_format": call_format,
         "conversation": conversation}
    p.update(over)
    return p


class Workers:
    """A worker factory that keeps every worker it made."""

    def __init__(self) -> None:
        self.made: list[Worker] = []

    def __call__(self, **kwargs: object) -> Worker:
        self.made.append(Worker(**kwargs))
        return self.made[-1]


class Held(FakeApp):
    """FakeApp(script=...) that holds root calls whose number (1-based, across the run) is in `hold` until
    `release` is set; `asked` is set when one is held."""

    def __init__(self, script: dict, hold: set[int]) -> None:
        super().__init__(script=script)
        self.hold = hold
        self.asked = asyncio.Event()
        self.release = asyncio.Event()
        self.root_calls = 0

    async def complete(self, params: dict) -> dict:
        if params["role"] == "root" and params.get("purpose") is None:
            self.root_calls += 1
            if self.root_calls in self.hold:
                self.asked.set()
                await self.release.wait()
        return await super().complete(params)


async def sent(app: FakeApp, method: str, run_id: str, n: int = 1, timeout: float = 60) -> list[dict]:
    """The first `n` events of `method` for `run_id`, once they are there."""
    clock = asyncio.get_running_loop()
    deadline = clock.time() + timeout
    while True:
        got = [p for p in app.sent(method) if p["run_id"] == run_id]
        if len(got) >= n:
            return got
        if clock.time() > deadline:
            raise TimeoutError(f"{len(got)} of {n} {method} for {run_id}")
        await asyncio.sleep(0.01)


def roots(app: FakeApp) -> list[dict]:
    return [r for r in app.requests if r["role"] == "root" and r.get("purpose") is None]


def records(home: Path) -> list[dict]:
    path = home / "runs" / "interactive" / "runs.jsonl"
    return RunLog(path).records() if path.exists() else []


def follow(text: str, turns_left: int = 6, subcalls_left: int = 5, mode: str = "read") -> str:
    return FOLLOW_UP.format(where=WHERE[mode], text=text, turns_left=turns_left, subcalls_left=subcalls_left)


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    h.mkdir()
    convo_profile(h)
    return h


# ---------------------------------------------------------------------------------------------- two prompts


def two_prompts(home: Path, call_format: str) -> tuple[FakeApp, Workers, str]:
    step = tool if call_format == "native" else fenced
    app = FakeApp(script={"root": [step("submit('1')"), step("submit('2')")]})
    workers = Workers()

    async def main() -> str:
        async with Served(home, app, workers) as s:
            run_id = (await s.call("run.start", params(home, call_format=call_format)))["result"]["run_id"]
            (first,) = await sent(app, "run.finished", run_id)
            assert first["prompt_index"] == 0 and first["open"] is True and first["answer"] == "1"
            assert len(records(home)) == 1
            assert (await s.call("run.say", {"run_id": run_id, "text": "Q2"}))["result"] == {"prompt_index": 1}
            await sent(app, "run.finished", run_id, 2)
            assert (await s.call("run.close", {"run_id": run_id}))["result"] == {}
            # run.closed has been sent by the time run.close answers
            assert app.sent("run.closed") == [{"run_id": run_id, "prompts": 2}]
            assert app.events[-1][0] == "run.closed"
        return run_id

    run_id = run(main(), TIMEOUT)
    (worker,) = workers.made  # one worker for both prompts
    assert worker._proc is None or worker._proc.poll() is not None
    assert not (home / "scratch" / run_id).exists()
    return app, workers, run_id


def test_two_prompts_native(home: Path) -> None:
    app, _, run_id = two_prompts(home, "native")
    first, second = roots(app)
    r0, r1 = records(home)
    assert second["messages"][:len(r0["messages"])] == r0["messages"]
    assert second["messages"][len(r0["messages"]):] == [
        {"role": "tool", "tool_call_id": "call_1", "content": SUBMITTED_NOTE},
        {"role": "user", "content": follow("Q2")},
    ]
    assert "(6 turns left, 5 sub-calls left)" in second["messages"][-1]["content"]
    assert r1["run_id"] == r0["run_id"] == run_id
    assert (r0["prompt_index"], r1["prompt_index"]) == (0, 1)
    assert r0["conversation"] is True and r1["conversation"] is True
    assert [t["turn"] for t in r1["turns"]] == [1]
    assert r1["answer"] == "2" and r1["question"] == "Q2" and r0["question"] == "What is it?"
    assert r1["messages"] == second["messages"] + [r1["messages"][-1]]
    assert r1["messages"][-1]["role"] == "assistant"
    finished = app.sent("run.finished")
    assert [(f["prompt_index"], f["open"]) for f in finished] == [(0, True), (1, True)]
    assert app.sent("run.started")[0]["conversation"] is True


def test_two_prompts_fenced(home: Path) -> None:
    app, _, _ = two_prompts(home, "fenced")
    _, second = roots(app)
    r0, _ = records(home)
    assert second["messages"][len(r0["messages"]):] == [
        {"role": "user", "content": SUBMITTED_NOTE + "\n\n" + follow("Q2")}]


# ---------------------------------------------------------------------------------------------- the REPL and budgets


def test_variables_survive(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("x = 41\nsubmit('a')"), fenced("print(x + 1)"), fenced("submit('b')")]})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            found = (await s.call("run.vars", {"run_id": run_id}))["result"]["vars"]
            assert {"name": "x", "type": "int", "len": None, "chars": 2} in found
            await s.call("run.say", {"run_id": run_id, "text": "add one"})
            await sent(app, "run.finished", run_id, 2)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    cells = app.sent("run.cell")
    assert cells[1]["output"].strip() == "42"
    _, r1 = records(home)
    assert r1["answer"] == "b" and [t["turn"] for t in r1["turns"]] == [1, 2]


def test_budgets_start_over(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print(llm_batch(['a', 'b', 'c']))"), fenced("submit('x')"),
                                   fenced("print(llm_batch(['a', 'b', 'c', 'd', 'e']))"), fenced("submit('y')")],
                          "sub": [{"text": "ok"}]})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            await s.call("run.say", {"run_id": run_id, "text": "five more"})
            await sent(app, "run.finished", run_id, 2)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    r0, r1 = records(home)
    assert [c["subcall_id"] for c in r0["subcalls"]] == [1, 2, 3]
    assert [c["subcall_id"] for c in r1["subcalls"]] == [4, 5, 6, 7, 8]  # ids go on, the budget started over
    assert [f["subcalls"] for f in app.sent("run.finished")] == [3, 5]
    assert max(c["subcall_id"] for c in r0["subcalls"] + r1["subcalls"]) == 8  # the run's total
    obs = [r["messages"][-1]["content"] for r in roots(app)]
    assert obs[1].endswith("(5 turns left, 2 sub-calls left)")
    assert obs[2].endswith(follow("five more", subcalls_left=5))
    assert obs[3].endswith("(5 turns left, 0 sub-calls left)")
    assert {e["subcalls_left"] for e in app.sent("run.budget")} >= {2, 0}


def test_turns_out_then_follow_up(home: Path) -> None:
    app = FakeApp(script={"root": [tool(f"print({i})") for i in range(6)] + [tool("submit('z')")]})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home, call_format="native")))["result"]["run_id"]
            (first,) = await sent(app, "run.finished", run_id)
            assert first["submitted"] is False and first["open"] is True and first["turns"] == 6
            await s.call("run.say", {"run_id": run_id, "text": "try again"})
            (_, second) = await sent(app, "run.finished", run_id, 2)
            assert second["submitted"] is True and second["answer"] == "z"
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    last = roots(app)[6]
    assert last["messages"][-2] == {"role": "tool", "tool_call_id": "call_6", "content": UNANSWERED_NOTE}
    assert last["messages"][-1] == {"role": "user", "content": follow("try again")}
    r0, r1 = records(home)
    assert r0["submitted"] is False and r0["infra_error"] is None and r1["submitted"] is True


# ---------------------------------------------------------------------------------------------- how it ends


def test_infra_closes(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("submit('1')")], "errors": [{"role": "root", "at": 1, "kind": "server"}]})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.closed", run_id)
            (done,) = app.sent("run.finished")
            assert done["open"] is False and done["infra_kind"] == "server" and done["prompt_index"] == 0
            assert [m for m, _ in app.events][-2:] == ["run.finished", "run.closed"]
            assert app.sent("run.closed") == [{"run_id": run_id, "prompts": 1}]
            await asyncio.sleep(0.05)
            assert (await s.call("run.say", {"run_id": run_id, "text": "Q2"}))["error"]["code"] == -32010

    run(main(), TIMEOUT)
    (record,) = records(home)
    assert record["infra_kind"] == "server" and record["conversation"] is True


def test_say_errors(home: Path) -> None:
    # root calls count across both runs: the one-shot run's is 1, the conversation's prompts are 2 and 3
    app = Held({"root": [fenced("submit('1')"), fenced("submit('2')")]}, hold={3})

    async def main() -> None:
        async with Served(home, app) as s:
            one = (await s.call("run.start", params(home, conversation=False)))["result"]["run_id"]
            await sent(app, "run.finished", one)
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            assert (await s.call("run.say", {"run_id": one, "text": "Q"}))["error"]["code"] == -32010  # one-shot
            assert (await s.call("run.close", {"run_id": one}))["error"]["code"] == -32010
            for text in ("", "   ", 3, None):
                assert (await s.call("run.say", {"run_id": run_id, "text": text}))["error"]["code"] == -32602
            assert (await s.call("run.say", {"run_id": run_id, "text": "Q2"}))["result"] == {"prompt_index": 1}
            await asyncio.wait_for(app.asked.wait(), 30)  # prompt 1's root call is held
            busy = await s.call("run.say", {"run_id": run_id, "text": "Q3"})
            assert busy["error"]["code"] == -32013
            assert (await s.call("run.close", {"run_id": run_id}))["error"]["code"] == -32013
            app.release.set()
            await sent(app, "run.finished", run_id, 2)
            assert (await s.call("run.close", {"run_id": run_id}))["result"] == {}
            assert (await s.call("run.say", {"run_id": run_id, "text": "Q4"}))["error"]["code"] == -32010
            assert (await s.call("run.close", {"run_id": run_id}))["error"]["code"] == -32010
            assert (await s.call("run.say", {"run_id": "r_000000000000", "text": "Q"}))["error"]["code"] == -32010
            bad = await s.call("run.start", params(home, conversation="yes"))
            assert bad["error"]["code"] == -32602

    run(main(), TIMEOUT)


def test_cancel_while_waiting(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("submit('1')")]})
    workers = Workers()

    async def main() -> str:
        async with Served(home, app, workers) as s:
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            assert (await s.call("run.cancel", {"run_id": run_id}))["result"] == {}
            assert app.sent("run.closed") == [{"run_id": run_id, "prompts": 1}]
            assert len(app.sent("run.finished")) == 1 and app.events[-1][0] == "run.closed"
        return run_id

    run_id = run(main(), TIMEOUT)
    assert len(records(home)) == 1
    assert workers.made[0]._proc is None or workers.made[0]._proc.poll() is not None
    assert not (home / "scratch" / run_id).exists()


def test_cancel_mid_prompt(home: Path) -> None:
    app = Held({"root": [fenced("submit('1')"), fenced("submit('2')")]}, hold={2})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            await s.call("run.say", {"run_id": run_id, "text": "Q2"})
            await asyncio.wait_for(app.asked.wait(), 30)
            assert (await s.call("run.cancel", {"run_id": run_id}))["result"] == {}
            ends = [(m, p) for m, p in app.events if m in ("run.finished", "run.closed")]
            assert [m for m, _ in ends] == ["run.finished", "run.finished", "run.closed"]
            assert ends[1][1]["open"] is False and ends[1][1]["prompt_index"] == 1
            assert ends[1][1]["infra_kind"] == "cancelled"
            assert ends[2][1]["prompts"] == 2

    run(main(), TIMEOUT)
    r0, r1 = records(home)
    assert r0["infra_kind"] is None and r1["infra_kind"] == "cancelled" and r1["prompt_index"] == 1
    assert r1["question"] == "Q2"


def test_stdin_close_with_open_conversation(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("submit('1')")]})
    workers = Workers()

    async def main() -> None:
        async with Served(home, app, workers) as s:
            run_id = (await s.call("run.start", params(home)))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            proc = workers.made[0]._proc
            assert proc is not None and proc.poll() is None  # the worker waits with the conversation
        # leaving the block closed the link's input; serve() returned after on_close cancelled the conversation
        assert proc.poll() is not None
        assert app.sent("run.closed") == [{"run_id": run_id, "prompts": 1}]
        assert len(app.sent("run.finished")) == 1

    run(main(), TIMEOUT)


# ---------------------------------------------------------------------------------------------- repo, compaction


@needs_git
def test_repo_conversation(home: Path, git_repo: Path) -> None:
    app = FakeApp(script={"root": [fenced("write_file('a.txt', 'a\\n')\nsubmit('a')"),
                                   fenced("write_file('b.txt', 'b\\n')\nsubmit('b')")]})

    async def main() -> None:
        async with Served(home, app) as s:
            p = {**params(home), "mode": "repo", "task": "Write a.txt.", "repo_path": str(git_repo)}
            del p["question"], p["inputs"]
            run_id = (await s.call("run.start", p))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            await s.call("run.say", {"run_id": run_id, "text": "Now write b.txt."})
            await sent(app, "run.finished", run_id, 2)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    r0, r1 = records(home)
    assert r0["base_tree"] == r1["base_tree"] is not None
    assert "a.txt" in r0["diff"] and "b.txt" not in r0["diff"]
    assert "a.txt" in r1["diff"] and "b.txt" in r1["diff"]
    assert r1["task"] == "Now write b.txt." and r0["task"] == "Write a.txt."
    assert roots(app)[1]["messages"][-1]["content"].endswith(
        follow("Now write b.txt.", turns_left=150, subcalls_left=80, mode="repo"))


def printing(turns: int, chars: int = 3000) -> list[dict]:
    return [fenced(f"print({'abcdefghij'[i % 10]!r} * {chars})", f"Turn {i + 1}.") for i in range(turns)] + [
        fenced("submit('x')", "Done.")]


def test_compaction_spans_prompts(home: Path) -> None:
    compact_profile(home)
    app = FakeApp(script={"root": [fenced("submit('first')")] + printing(10),
                          "compact": [{"text": "SUMMARY of the work so far."}]})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home, profile="compact-test")))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            await s.call("run.say", {"run_id": run_id, "text": "Print a lot."})
            await sent(app, "run.finished", run_id, 2)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    events = app.sent("run.compacted")
    assert events and all(e["prompt_index"] == 1 for e in events)
    first = roots(app)[0]
    turn = events[0]["turn"]
    after = [r for r in roots(app)[1:] if r["turn"] == turn][-1]
    assert json.dumps(after["messages"][:2]) == json.dumps(first["messages"][:2])  # prompt 0's head, byte for byte
    r0, r1 = records(home)
    assert r0["compactions"] == []
    assert r1["compactions"] == [{k: v for k, v in e.items() if k != "run_id"} for e in events]
    assert r1["submitted"] and r1["infra_error"] is None
    # the follow-up's question sat with prompt 0's last turn, which the summary replaced: it comes right back (D-248)
    assert not any(m["content"].endswith(follow("Print a lot.", turns_left=12)) for m in after["messages"])
    assert after["messages"][3] == kept_message("Print a lot.")


@pytest.mark.parametrize("summary", [{"text": "SUMMARY of the work so far."}, {"error": "context_window"}],
                         ids=["model-summary", "fallback"])
def test_follow_up_survives_compaction(home: Path, summary: dict) -> None:
    """Every request of a follow-up holds its own question exactly once, through each compaction, with the model's
    summary and with the mechanical one (D-200, D-248). Prompt 2's compaction drops prompt 1's repeat as part of the
    middle, and repeats prompt 2's own question instead."""
    compact_profile(home)
    questions = ["Print a lot, then submit.", "Now print more."]
    app = FakeApp(script={"root": [fenced("submit('first')")] + printing(10) + printing(10),
                          "compact": [summary] * 10})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home, profile="compact-test")))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            for k, text in enumerate(questions, 2):
                await s.call("run.say", {"run_id": run_id, "text": text})
                await sent(app, "run.finished", run_id, k)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    events = app.sent("run.compacted")
    assert {e["prompt_index"] for e in events} == {1, 2}  # prompt 2 may compact twice: its own repeat goes and comes back
    by_prompt: list[list[dict]] = []
    for request in roots(app):
        if request["turn"] == 1:
            by_prompt.append([])
        by_prompt[-1].append(request)
    assert [len(p) for p in by_prompt] == [1, 11, 11]
    for text, requests in zip(questions, by_prompt[1:]):
        for request in requests:
            texts = [m["content"] for m in request["messages"]]
            assert sum(text in t for t in texts) == 1, (text, request["turn"], texts)
    after = next(r for r in by_prompt[2] if r["turn"] == events[-1]["turn"])
    assert after["messages"][3] == kept_message(questions[1])
    assert not any(questions[0] in m["content"] for m in after["messages"])  # prompt 1's question went with the middle
    _, r1, r2 = records(home)
    assert r1["submitted"] and r2["submitted"] and r2["infra_error"] is None
    assert sum(questions[1] in m["content"] for m in r2["messages"]) == 1


def test_prompt_zero_compaction_adds_nothing(home: Path) -> None:
    """Prompt 0's question is in the head, which a compaction never drops: no repeat is added."""
    compact_profile(home)
    app = FakeApp(script={"root": printing(10), "compact": [{"text": "SUMMARY."}]})

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home, profile="compact-test")))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    assert app.sent("run.compacted")
    assert not any(m["content"].startswith("[The follow-up") for r in roots(app) for m in r["messages"])


# ---------------------------------------------------------------------------------------------- the wire


def test_order_on_the_wire_say(home: Path) -> None:
    async def answer(s: Served, request: dict, code: str) -> None:
        s.pipes.peer.send({"jsonrpc": "2.0", "id": request["id"], "result": reply(code)})

    async def main() -> None:
        async with Served(home) as s:  # events and model calls on the wire
            mid = s.send("run.start", params(home))
            first, second, third = await s.recv(), await s.recv(), await s.recv()
            assert first["id"] == mid and "result" in first, first
            assert second["method"] == "run.started" and second["params"]["conversation"] is True
            assert third["method"] == "model.complete"
            run_id = first["result"]["run_id"]
            await answer(s, third, "submit('1')")
            while True:
                msg = await s.recv()
                if msg.get("method") == "run.finished":
                    assert msg["params"]["open"] is True
                    break
            with pytest.raises(TimeoutError):  # the conversation waits: nothing more is sent
                await s.recv(timeout=0.5)
            mid = s.send("run.say", {"run_id": run_id, "text": "Q2"})
            first, second = await s.recv(), await s.recv()
            assert first["id"] == mid and first["result"] == {"prompt_index": 1}, first
            assert second["method"] == "model.complete" and second["params"]["turn"] == 1, second
            await answer(s, second, "submit('2')")
            while (await s.recv()).get("method") != "run.finished":
                pass
            mid = s.send("run.close", {"run_id": run_id})
            seen = [await s.recv(), await s.recv(), await s.recv()]
            assert [m.get("method") for m in seen[:2]] == ["model.cancel", "run.closed"]
            assert seen[2]["id"] == mid and seen[2]["result"] == {}

    run(main(), TIMEOUT)


def test_one_shot_unchanged(home: Path) -> None:
    """conversation: false gives v0's events (and step 3's), plus prompt_index and open on run.finished; never
    run.closed. A conversation's prompt 0 sends the same events up to its run.finished, which says open."""
    script = {"root": [fenced("print(1)"), fenced("submit('x')")]}
    shots = []
    for conversation in (False, True):
        app = FakeApp(script=script)

        async def main(app: FakeApp = app, conversation: bool = conversation) -> None:
            async with Served(home, app) as s:
                p = params(home, profile="training-v4", conversation=conversation)
                if not conversation:
                    del p["conversation"]  # absent means false
                run_id = (await s.call("run.start", p))["result"]["run_id"]
                await sent(app, "run.finished", run_id)
                if conversation:
                    await s.call("run.close", {"run_id": run_id})
            shots.append(app)

        run(main(), TIMEOUT)
    one, conv = shots
    methods = [m for m, _ in one.events]
    assert methods == ["run.started", "run.reply", "run.cell", "run.budget", "run.reply", "run.cell", "run.finished"]
    (done,) = one.sent("run.finished")
    assert done["prompt_index"] == 0 and done["open"] is False
    assert one.sent("run.started")[0]["conversation"] is False
    assert one.cancelled and not one.sent("run.closed")
    assert [m for m, _ in conv.events] == methods + ["run.closed"]
    assert conv.sent("run.finished")[0]["open"] is True
    strip = lambda r: {k: v for k, v in r.items() if k != "run_id"}  # noqa: E731
    assert [strip(r) for r in one.requests] == [strip(r) for r in conv.requests]
    r_one, r_conv = records(home)
    assert r_one["conversation"] is False and r_one["prompt_index"] == 0
    assert r_conv["conversation"] is True and r_one["messages"] == r_conv["messages"]


def test_training_v4_follow_up(home: Path) -> None:
    script = {"root": [fenced("x = 7\nsubmit('a')"), fenced("submit(str(x * 6))")]}
    app = FakeApp(script=script)

    async def main() -> None:
        async with Served(home, app) as s:
            run_id = (await s.call("run.start", params(home, profile="training-v4")))["result"]["run_id"]
            await sent(app, "run.finished", run_id)
            await s.call("run.say", {"run_id": run_id, "text": "times six?"})
            await sent(app, "run.finished", run_id, 2)
            await s.call("run.close", {"run_id": run_id})

    run(main(), TIMEOUT)
    _, second = app.sent("run.finished")
    assert second["answer"] == "42" and app.sent("run.started")[0]["compaction"] is None
    limits = load_profile("training-v4", home).read.limits
    assert roots(app)[1]["messages"][-1]["content"].endswith(
        follow("times six?", turns_left=limits.max_turns, subcalls_left=limits.max_subcalls))

    one = FakeApp(script={"root": script["root"][:1]})
    spec = loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=load_profile("training-v4", home), root=dict(REF),
        sub=dict(REF), permission_mode="accept-edits", call_format="fenced", interactive=False,
        question="What is it?", inputs=[home / "input.txt"], task=None, repo_path=None, test_hint=None,
        language=None, n_files=None, context=None, tag=None, batch="interactive",
        log_path=home / "runs" / "one" / "runs.jsonl")
    run(loop.run(spec, one, home=home), TIMEOUT)
    strip = lambda r: {k: v for k, v in r.items() if k != "run_id"}  # noqa: E731
    assert [strip(r) for r in one.requests] == [strip(r) for r in app.requests[:1]]
