"""KV cache: none

bridge.py against a `conftest.StubApp`: sub-call ids, batches and the exact `model.complete` params, the budget and
oversize refusals, the D-06 error split, the other ops (`approve`, `fetch`) and the malformed requests. `fetch` runs
against a local `http.server` on 127.0.0.1 (port 0); nothing else touches the network.
"""

from __future__ import annotations

import asyncio
import dataclasses
import http.server
import json
import os
import socket
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from conftest import StubApp, run
from fakeapp import zero_usage

from rlm_engine import bridge as bridge_module
from rlm_engine import contract
from rlm_engine.bridge import INFRA_REPLY, Bridge
from rlm_engine.errors import InfraError, ModelError
from rlm_engine.permissions import Permissions
from rlm_engine.profiles import Profile, load_profile

RUN_ID = "r_0123456789ab"
SUB = {"provider": "openai", "model": "example-sub-model", "thinking": None}
EXAMPLES = {
    ex["name"]: ex["message"]
    for ex in json.loads((Path(__file__).resolve().parents[2] / "protocol" / "examples.json").read_text("utf-8"))["examples"]
}


# ---------------------------------------------------------------------------------------------- helpers

def result(text: Any, **extra: Any) -> dict:
    return {
        "text": text,
        "tool_call": None,
        "reasoning": None,
        "usage": {**zero_usage(), "input_tokens": 7, "output_tokens": 3},
        "finish_reason": "stop",
        "served_model": "m",
        "seconds": 0.0,
        **extra,
    }


def echo(params: dict) -> dict:
    return result("A:" + params["messages"][0]["content"])


def by_prompt(table: dict):
    """A `complete` that looks the prompt up: a str answers, an exception raises, `(delay, x)` waits first."""

    async def complete(params: dict) -> dict:
        behavior = table.get(params["messages"][0]["content"], "ok")
        if isinstance(behavior, tuple):
            await asyncio.sleep(behavior[0])
            behavior = behavior[1]
        if isinstance(behavior, BaseException):
            raise behavior
        return behavior if isinstance(behavior, dict) else result(behavior)

    return complete


def with_limits(profile: Profile, mode: str, **changes: Any) -> Profile:
    settings = profile.mode(mode)
    new = dataclasses.replace(settings, limits=dataclasses.replace(settings.limits, **changes))
    return dataclasses.replace(profile, **{mode: new})


def make(
    tmp_path: Path,
    *,
    mode: str = "read",
    complete=echo,
    sub: dict = SUB,
    limits: dict | None = None,
    answer=None,
    interactive: bool = True,
) -> tuple[Bridge, StubApp]:
    app = StubApp(answer=answer, complete=complete)
    profile = load_profile("training-v4", tmp_path)
    if limits:
        profile = with_limits(profile, mode, **limits)
    permissions = Permissions(
        run_id=RUN_ID,
        mode="default",
        workspace=tmp_path / "repo",
        scratch=tmp_path / "scratch",
        repo_mode=mode == "repo",
        interactive=interactive,
        app=app,
    )
    bridge = Bridge(run_id=RUN_ID, app=app, profile=profile, mode=mode, sub_ref=dict(sub), permissions=permissions)
    return bridge, app


def handle(bridge: Bridge, request: Any, timeout: float = 10) -> dict:
    return run(bridge.handle(request), timeout)


def batch_request(prompts: list, line: int | None = 3, op: str = "llm_batch") -> dict:
    return {"type": "request", "id": 1, "op": op, "line": line, "prompts": prompts}


def subcall_events(app: StubApp) -> list[dict]:
    return app.sent("run.subcall")


# ---------------------------------------------------------------------------------------------- ids, params, events

def test_llm_is_a_batch_of_one(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    bridge.turn = 2
    assert handle(bridge, batch_request(["hello"], line=7, op="llm")) == {"outputs": ["A:hello"]}
    assert bridge.subcalls_used == 1 and bridge.subcalls_left() == 79
    sent = app.completes[0]
    assert sent["subcall_id"] == 1 and sent["batch"] == {"id": "b1", "index": 0, "size": 1}
    assert sent["origin"] == {"turn": 2, "line": 7}


def test_ids_and_batch_ids(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    assert handle(bridge, batch_request(["a", "b", "c"], op="llm_batch"))["outputs"] == ["A:a", "A:b", "A:c"]
    assert handle(bridge, batch_request(["d"], op="llm"))["outputs"] == ["A:d"]
    assert handle(bridge, batch_request(["e", "f"], op="llm_batch"))["outputs"] == ["A:e", "A:f"]
    assert [(p["subcall_id"], p["batch"]) for p in app.completes] == [
        (1, {"id": "b1", "index": 0, "size": 3}),
        (2, {"id": "b1", "index": 1, "size": 3}),
        (3, {"id": "b1", "index": 2, "size": 3}),
        (4, {"id": "b2", "index": 0, "size": 1}),
        (5, {"id": "b3", "index": 0, "size": 2}),
        (6, {"id": "b3", "index": 1, "size": 2}),
    ]
    assert [r.subcall_id for r in bridge.records] == [1, 2, 3, 4, 5, 6] and bridge.subcalls_used == 6


def test_exact_model_complete_params_in_read_mode(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, mode="read")
    bridge.turn = 2
    handle(bridge, batch_request(["Summarize this example chunk.", "second"], line=3))
    profile = load_profile("training-v4", tmp_path)
    assert app.completes[0] == {
        "run_id": RUN_ID,
        "role": "sub",
        "model": SUB,
        "messages": [{"role": "user", "content": "Summarize this example chunk."}],
        "tools": [],
        "max_tokens": 4096,
        "temperature": profile.sub_temperature,
        "thinking": "off",  # read mode: no subcall_thinking, no ref value
        "turn": 2,
        "subcall_id": 1,
        "origin": {"turn": 2, "line": 3},
        "batch": {"id": "b1", "index": 0, "size": 2},
    }
    example = EXAMPLES["model.complete:request:sub"]["params"]
    assert set(app.completes[0]) == set(example) and set(app.completes[0]["model"]) == set(example["model"])


def test_thinking_resolution(tmp_path: Path) -> None:
    repo, app = make(tmp_path, mode="repo")
    handle(repo, batch_request(["x"]))
    assert app.completes[0]["thinking"] == "low"  # training-v4 repo mode: subcall_thinking = "low" (D-08)
    assert app.completes[0]["model"]["thinking"] is None  # the ref is passed through as it came
    assert app.completes[0]["max_tokens"] == contract.EDIT_LIMITS_V4.subcall_max_tokens

    own, app = make(tmp_path, mode="repo", sub={**SUB, "thinking": "high"})
    handle(own, batch_request(["x"]))
    assert app.completes[0]["thinking"] == "high"  # a ref's own value wins
    off, app = make(tmp_path, mode="repo", sub={**SUB, "thinking": "off"})
    handle(off, batch_request(["x"]))
    assert app.completes[0]["thinking"] == "off"  # including "off"
    read, app = make(tmp_path, mode="read", sub={**SUB, "thinking": "medium"})
    handle(read, batch_request(["x"]))
    assert app.completes[0]["thinking"] == "medium"
    plain, app = make(tmp_path, mode="read")
    handle(plain, batch_request(["x"]))
    assert app.completes[0]["thinking"] == "off"


def test_params_do_not_alias_the_bridge_state(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    handle(bridge, batch_request(["a", "b"]))
    app.completes[0]["model"]["model"] = "changed"
    app.completes[0]["origin"]["turn"] = 99
    assert bridge.sub_ref["model"] == "example-sub-model"
    assert app.completes[1]["origin"]["turn"] == 0 and app.completes[1]["model"]["model"] == "example-sub-model"
    assert bridge.records[1].origin["turn"] == 0


def test_events_sent_then_done_then_budget(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, complete=by_prompt({"a": (0.02, "ra"), "bb": (0.02, "rb")}))
    bridge.turn = 5
    handle(bridge, batch_request(["a", "bb"], line=4))
    events = app.events
    assert [m for m, _ in events if m != "run.subcall"] == ["run.budget"]
    assert events[-1][0] == "run.budget"  # after the whole batch
    assert events[-1][1] == {"run_id": RUN_ID, "turns_left": 15, "subcalls_left": 78}
    assert set(events[-1][1]) == set(EXAMPLES["run.budget:notification"]["params"])
    subs = subcall_events(app)
    assert len(subs) == 4
    for sub_id, chars in ((1, 1), (2, 2)):
        mine = [e for e in subs if e["subcall_id"] == sub_id]
        assert [e["status"] for e in mine] == ["sent", "done"]
        assert mine[0]["seconds"] is None and isinstance(mine[1]["seconds"], float)
        assert all(e["prompt_chars"] == chars and e["error"] is None for e in mine)
        assert all(e["origin"] == {"turn": 5, "line": 4} and e["run_id"] == RUN_ID for e in mine)
    assert subs[0]["batch"] == {"id": "b1", "index": 0, "size": 2} and subs[1]["batch"] == {"id": "b1", "index": 1, "size": 2}
    assert set(subs[0]) == set(EXAMPLES["run.subcall:notification"]["params"])
    assert all(e["status"] == "sent" for e in subs[:2])  # both go out before the first answer is back


def test_records_hold_prompt_output_usage_and_time(tmp_path: Path) -> None:
    bridge, _ = make(tmp_path)
    bridge.turn = 3
    handle(bridge, batch_request(["hello"], line=9))
    (record,) = bridge.records
    assert (record.subcall_id, record.prompt, record.output, record.error) == (1, "hello", "A:hello", None)
    assert record.origin == {"turn": 3, "line": 9} and record.batch == {"id": "b1", "index": 0, "size": 1}
    assert record.usage == {**zero_usage(), "input_tokens": 7, "output_tokens": 3} and record.seconds >= 0


def test_budget_event_counts_down(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    bridge.turn = 1
    handle(bridge, batch_request(["a"]))
    handle(bridge, batch_request(["b", "c"]))
    assert [e for m, e in app.events if m == "run.budget"] == [
        {"run_id": RUN_ID, "turns_left": 19, "subcalls_left": 79},
        {"run_id": RUN_ID, "turns_left": 19, "subcalls_left": 77},
    ]
    bridge.turn = 40  # never negative
    handle(bridge, batch_request(["d"]))
    assert app.sent("run.budget")[-1]["turns_left"] == 0


def test_repo_mode_budget_uses_the_repo_limits(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, mode="repo")
    bridge.turn = 4
    assert bridge.max_subcalls == contract.EDIT_LIMITS_V4.max_subcalls
    handle(bridge, batch_request(["a"]))
    assert app.sent("run.budget") == [{"run_id": RUN_ID, "turns_left": 26, "subcalls_left": 79}]


def test_answers_come_back_in_prompt_order(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, complete=by_prompt({"p0": (0.09, "r0"), "p1": (0.05, "r1"), "p2": (0.0, "r2")}))
    assert handle(bridge, batch_request(["p0", "p1", "p2"])) == {"outputs": ["r0", "r1", "r2"]}
    assert [p["subcall_id"] for p in app.completes] == [1, 2, 3]  # the calls go out in prompt order
    done = [e["subcall_id"] for e in subcall_events(app) if e["status"] == "done"]
    assert done == [3, 2, 1]  # and finish in the other order


def test_line_is_none_unless_an_int(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    for line in (None, "3", 1.5, True):
        handle(bridge, batch_request(["x"], line=line))
    handle(bridge, {"op": "llm", "prompts": ["no line key"]})
    assert [p["origin"]["line"] for p in app.completes] == [None] * 5
    handle(bridge, batch_request(["x"], line=0))
    assert app.completes[-1]["origin"]["line"] == 0


def test_text_is_cleaned(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    handle(bridge, batch_request(["a\ud800b"], op="llm"))
    assert app.completes[0]["messages"][0]["content"] == "a?b"  # a lone surrogate can't be sent
    assert bridge.records[0].prompt == "a?b"


# ---------------------------------------------------------------------------------------------- budget and size

def test_budget_refusal(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, limits={"max_subcalls": 3})
    assert handle(bridge, batch_request(["a", "b"]))["outputs"] == ["A:a", "A:b"]
    events_before = len(app.events)
    reply = handle(bridge, batch_request(["ccc", "dddddd"], line=5))
    assert reply == {"error": contract.budget_exhausted_message(3)} == {"error": "sub-call budget exhausted (3 total)"}
    assert len(app.completes) == 2 and bridge.subcalls_used == 2  # no call, counter unchanged
    new = app.events[events_before:]
    assert [m for m, _ in new] == ["run.subcall"]  # one rejected event, no run.budget
    event = new[0][1]
    assert event == {
        "run_id": RUN_ID,
        "subcall_id": None,
        "origin": {"turn": 0, "line": 5},
        "batch": event["batch"],
        "prompt_chars": 6,  # the longest prompt
        "status": "rejected",
        "error": "sub-call budget exhausted (3 total)",
        "seconds": 0.0,
    }
    assert set(event["batch"]) == {"id", "index", "size"} and event["batch"]["size"] == 2
    assert event["batch"]["id"] not in ("b1",)  # a rejected request does not reuse a real batch's id
    assert not bridge.records[2:] and bridge.infra_error is None


def test_budget_allows_exactly_the_limit_then_refuses_llm(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, limits={"max_subcalls": 3})
    assert handle(bridge, batch_request(["a", "b"]))["outputs"] == ["A:a", "A:b"]
    assert handle(bridge, batch_request(["c"], op="llm"))["outputs"] == ["A:c"]  # the 3rd of 3
    assert bridge.subcalls_left() == 0
    assert handle(bridge, batch_request(["d"], op="llm")) == {"error": "sub-call budget exhausted (3 total)"}
    assert len(app.completes) == 3 and bridge.subcalls_used == 3
    assert handle(bridge, batch_request([])) == {"outputs": []}  # an empty batch is still fine


def test_concurrent_requests_cannot_oversubscribe(tmp_path: Path) -> None:
    async def scenario() -> list[dict]:
        bridge, app = make(tmp_path, limits={"max_subcalls": 3}, complete=by_prompt({"x": (0.02, "ok")}))
        replies = await asyncio.gather(*(bridge.handle(batch_request(["x", "x"])) for _ in range(3)))
        assert bridge.subcalls_used == 2 and len(app.completes) == 2
        return replies

    replies = run(scenario())
    assert sum("outputs" in r for r in replies) == 1 and sum("error" in r for r in replies) == 2


def test_oversize_in_error_mode(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)  # training-v4 read mode: subcall_oversize = "error", 60,000 characters
    assert bridge.limits.subcall_oversize == "error" and bridge.limits.subcall_max_chars == 60_000
    assert handle(bridge, batch_request(["x" * 60_000]))["outputs"] == ["A:" + "x" * 60_000]  # exactly the limit is fine
    events_before = len(app.events)
    reply = handle(bridge, batch_request(["short", "y" * 60_001, "z" * 10], line=2))
    assert reply == {"error": contract.oversize_message(60_001, 60_000)}
    assert "60,001 characters" in reply["error"]
    assert len(app.completes) == 1 and bridge.subcalls_used == 1  # the whole batch is refused
    (name, event) = app.events[events_before]
    assert name == "run.subcall" and len(app.events) == events_before + 1
    assert (event["status"], event["subcall_id"], event["prompt_chars"]) == ("rejected", None, 60_001)
    assert event["error"] == reply["error"]


def test_oversize_in_truncate_mode(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, limits={"subcall_oversize": "truncate", "subcall_max_chars": 100})
    prompt = "p" * 250
    assert handle(bridge, batch_request([prompt], op="llm")) == {"outputs": ["A:" + "p" * 100 + "\n[prompt truncated]"]}
    sent = app.completes[0]["messages"][0]["content"]
    assert sent == contract.truncate_prompt(prompt, 100) == "p" * 100 + "\n" + contract.SUBCALL_TRUNCATION_MARK
    assert bridge.records[0].prompt == sent
    assert subcall_events(app)[0]["prompt_chars"] == len(sent)  # the length actually sent
    assert [e["status"] for e in subcall_events(app)] == ["sent", "done"]


def test_budget_is_checked_before_size(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, limits={"max_subcalls": 1, "subcall_max_chars": 10})
    reply = handle(bridge, batch_request(["x" * 50, "y"]))
    assert reply == {"error": "sub-call budget exhausted (1 total)"}
    assert subcall_events(app)[0]["prompt_chars"] == 50


# ---------------------------------------------------------------------------------------------- errors (D-06)

def test_bad_request_reaches_the_cell_and_the_run_goes_on(tmp_path: Path) -> None:
    err = ModelError("HTTP 400: prompt is too long", kind="bad_request", status=400, provider="openai", model="m")
    bridge, app = make(tmp_path, complete=by_prompt({"bad": err}))
    reply = handle(bridge, batch_request(["bad"], op="llm"))
    assert reply == {"error": "sub-call failed: HTTP 400: prompt is too long"}
    assert bridge.infra_error is None and bridge.infra_kind is None
    assert bridge.subcalls_used == 1  # a failed call still used its slot
    (record,) = bridge.records
    assert record.output is None and record.error == "HTTP 400: prompt is too long" and record.usage is None
    assert [(e["status"], e["error"]) for e in subcall_events(app)] == [("sent", None), ("error", "HTTP 400: prompt is too long")]
    assert app.sent("run.budget")  # the batch is over, so the budget is reported
    assert handle(bridge, batch_request(["fine"], op="llm")) == {"outputs": ["ok"]}  # the run goes on


@pytest.mark.parametrize("kind", ["auth", "no_key", "rate_limit", "server", "timeout", "network", "context_window",
                                  "unknown_model", "other"])
def test_other_model_errors_are_infra(tmp_path: Path, kind: str) -> None:
    err = ModelError(f"the {kind} message", kind=kind)
    bridge, app = make(tmp_path, complete=by_prompt({"boom": err}))
    with pytest.raises(InfraError) as caught:
        handle(bridge, batch_request(["boom"], op="llm"))
    assert caught.value.kind == kind and bridge.infra_kind == kind
    assert bridge.infra_error == caught.value.message == f"sub-call failed: the {kind} message"
    assert [e["status"] for e in subcall_events(app)] == ["sent", "error"]


def test_infra_stops_later_sub_calls(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, complete=by_prompt({"boom": ModelError("down", kind="server")}))
    with pytest.raises(InfraError):
        handle(bridge, batch_request(["boom"], op="llm"))
    assert handle(bridge, batch_request(["fine"], op="llm")) == {"error": INFRA_REPLY}
    assert handle(bridge, batch_request(["a", "b"])) == {"error": INFRA_REPLY}
    assert len(app.completes) == 1 and bridge.infra_kind == "server"
    assert handle(bridge, batch_request(["a", 1])) == {"error": "prompts must be a list of strings"}  # validation first
    assert INFRA_REPLY == "sub-call failed for an infrastructure reason; this episode will be discarded"


def test_the_first_infra_failure_is_the_one_kept(tmp_path: Path) -> None:
    bridge, _ = make(tmp_path, complete=by_prompt({"a": (0.0, ModelError("first", kind="auth")),
                                                   "b": (0.03, ModelError("second", kind="server"))}))
    with pytest.raises(InfraError) as caught:
        handle(bridge, batch_request(["a", "b"]))
    assert caught.value.kind == "auth"  # prompt order, not completion order
    assert (bridge.infra_kind, bridge.infra_error) == ("auth", "sub-call failed: first")


def test_a_generic_exception_is_infra_other(tmp_path: Path) -> None:
    bridge, _ = make(tmp_path, complete=by_prompt({"x": ValueError("kaboom")}))
    with pytest.raises(InfraError) as caught:
        handle(bridge, batch_request(["x"], op="llm"))
    assert caught.value.kind == "other" and bridge.infra_kind == "other"
    assert "kaboom" in (bridge.infra_error or "")


@pytest.mark.parametrize("bad", [5, None, ["a"], {"x": 1}, b"bytes"])
def test_a_text_that_is_not_a_str_is_infra(tmp_path: Path, bad) -> None:
    bridge, app = make(tmp_path, complete=by_prompt({"x": result(bad)}))
    with pytest.raises(InfraError) as caught:
        handle(bridge, batch_request(["x"], op="llm"))
    assert caught.value.kind == "other"
    assert bridge.infra_error == f"sub-call returned {type(bad).__name__}, not str"
    assert [e["status"] for e in subcall_events(app)] == ["sent", "error"]


def test_a_reply_that_is_not_a_dict_is_infra(tmp_path: Path) -> None:
    bridge, _ = make(tmp_path, complete=lambda params: "just text")
    with pytest.raises(InfraError) as caught:
        handle(bridge, batch_request(["x"], op="llm"))
    assert caught.value.kind == "other" and bridge.infra_error == "sub-call returned NoneType, not str"


def test_a_cancelled_call_is_infra_cancelled(tmp_path: Path) -> None:
    for exc in (ModelError("cancelled by the app", kind="cancelled"), asyncio.CancelledError()):
        bridge, app = make(tmp_path, complete=by_prompt({"x": exc}))
        with pytest.raises(InfraError) as caught:
            handle(bridge, batch_request(["x"], op="llm"))
        assert caught.value.kind == "cancelled" and bridge.infra_kind == "cancelled"
        assert [e["status"] for e in subcall_events(app)] == ["sent", "error"]


def test_cancelling_the_request_cancels_its_calls(tmp_path: Path) -> None:
    async def scenario() -> Bridge:
        bridge, app = make(tmp_path, complete=by_prompt({"slow": (30, "never")}))
        task = asyncio.create_task(bridge.handle(batch_request(["slow", "slow"])))
        await asyncio.sleep(0.05)
        assert len(app.completes) == 2
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert [r.error for r in bridge.records] == ["cancelled", "cancelled"]
        assert [e["status"] for e in subcall_events(app)].count("error") == 2
        return bridge

    bridge = run(scenario())
    assert bridge.infra_error is None  # the worker going away is not a model failure


def test_mixed_batch_infra_wins(tmp_path: Path) -> None:
    table = {
        "bad": (0.0, ModelError("too long", kind="bad_request")),
        "ok": (0.01, "fine"),
        "down": (0.04, ModelError("overloaded", kind="rate_limit")),
    }
    bridge, app = make(tmp_path, complete=by_prompt(table))
    with pytest.raises(InfraError) as caught:
        handle(bridge, batch_request(["bad", "ok", "down"]))
    assert caught.value.kind == "rate_limit" and bridge.infra_kind == "rate_limit"
    assert [r.subcall_id for r in bridge.records] == [1, 2, 3]  # every call finished and was recorded
    assert bridge.subcalls_used == 3 and app.sent("run.budget")[-1]["subcalls_left"] == 77


def test_mixed_batch_first_bad_request_in_prompt_order(tmp_path: Path) -> None:
    table = {
        "bad1": (0.05, ModelError("first in order", kind="bad_request")),
        "ok": "fine",
        "bad2": (0.0, ModelError("finished first", kind="bad_request")),
    }
    bridge, _ = make(tmp_path, complete=by_prompt(table))
    assert handle(bridge, batch_request(["bad1", "ok", "bad2"])) == {"error": "sub-call failed: first in order"}
    assert bridge.infra_error is None and len(bridge.records) == 3


# ---------------------------------------------------------------------------------------------- batches and requests

def test_empty_batch_uses_nothing(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    assert handle(bridge, batch_request([])) == {"outputs": []}
    assert bridge.subcalls_used == 0 and app.events == [] and app.completes == [] and bridge.records == []
    assert handle(bridge, batch_request(["a"]))["outputs"] == ["A:a"]
    assert app.completes[0]["batch"]["id"] == "b1"  # the empty batch took no batch id


@pytest.mark.parametrize("request_", [None, [], "llm", 5, {}, {"op": None}, {"op": "bogus"}, {"op": "shutdown"},
                                      {"op": "LLM", "prompts": ["x"]}, {"op": ["llm"]}])
def test_unknown_requests(tmp_path: Path, request_) -> None:
    bridge, app = make(tmp_path)
    assert handle(bridge, request_) == {"error": "unknown request"}
    assert app.events == [] and app.completes == [] and bridge.subcalls_used == 0


@pytest.mark.parametrize("prompts", [None, "a string", ["a", 5], [["a"]], [None], {"a": 1}, ("a",)])
def test_prompts_must_be_a_list_of_strings(tmp_path: Path, prompts) -> None:
    bridge, app = make(tmp_path)
    for op in ("llm", "llm_batch"):
        assert handle(bridge, {"op": op, "prompts": prompts}) == {"error": "prompts must be a list of strings"}
    assert handle(bridge, {"op": "llm"}) == {"error": "prompts must be a list of strings"}
    assert app.events == [] and app.completes == [] and bridge.subcalls_used == 0


def test_llm_takes_exactly_one_prompt(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    for prompts in ([], ["a", "b"]):
        assert handle(bridge, batch_request(prompts, op="llm")) == {"error": "llm takes exactly one prompt"}
    assert app.events == [] and bridge.subcalls_used == 0


@pytest.mark.parametrize(
    "request_",
    [
        {"op": "approve"},
        {"op": "approve", "kind": "telepathy", "detail": "x", "inside_workspace": False},
        {"op": "approve", "kind": "shell", "detail": 5, "inside_workspace": False},
        {"op": "approve", "kind": "shell", "detail": "ls"},
        {"op": "approve", "kind": "shell", "detail": "ls", "inside_workspace": "yes"},
        {"op": "approve", "kind": ["shell"], "detail": "ls", "inside_workspace": True},
        {"op": "fetch"},
        {"op": "fetch", "url": None},
        {"op": "fetch", "url": 5},
        {"op": "fetch", "url": ["http://127.0.0.1/"]},
    ],
)
def test_malformed_approve_and_fetch_requests(tmp_path: Path, request_) -> None:
    bridge, app = make(tmp_path, answer={"allow": True, "remember_for_run": False})
    assert handle(bridge, request_) == {"error": "malformed request"}
    assert app.approvals == [] and app.events == [] and bridge.fetches == []


# ---------------------------------------------------------------------------------------------- approve

def approve_request(kind: str, detail: str, inside: bool, line: int | None = 1) -> dict:
    return {"type": "request", "id": 2, "op": "approve", "line": line, "kind": kind, "detail": detail, "inside_workspace": inside}


def test_approve_delegates_to_permissions(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, answer={"allow": True, "remember_for_run": False})
    bridge.turn = 4
    assert handle(bridge, approve_request("shell", "ls -la", True)) == {"allow": True}
    assert app.approvals == [{"run_id": RUN_ID, "kind": "shell", "detail": "ls -la", "turn": 4, "inside_workspace": True}]
    assert bridge.permissions.log == [
        {"turn": 4, "kind": "shell", "detail": "ls -la", "allowed": True, "asked": True, "remembered": False}
    ]
    assert app.sent("run.permission") == [{"run_id": RUN_ID, **bridge.permissions.log[0]}]
    assert bridge.subcalls_used == 0 and not app.sent("run.budget")


def test_approve_denied(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, answer={"allow": False, "remember_for_run": False})
    assert handle(bridge, approve_request("network", "127.0.0.1", False)) == {"allow": False}
    assert [a["detail"] for a in app.approvals] == ["127.0.0.1"]


def test_approve_follows_the_permission_rules(tmp_path: Path) -> None:
    bridge, app = make(tmp_path, answer={"allow": True, "remember_for_run": True}, interactive=False)
    assert handle(bridge, approve_request("shell", "ls", True)) == {"allow": False}  # non-interactive: denied
    assert app.approvals == []
    scratch_file = (tmp_path / "scratch" / "f.txt").as_posix()
    assert handle(bridge, approve_request("write", scratch_file, True)) == {"allow": True}  # scratch: silent
    assert app.approvals == [] and len(bridge.permissions.log) == 1


# ---------------------------------------------------------------------------------------------- fetch

class FetchServer:
    """A threaded `http.server` on 127.0.0.1, port 0. `requests` records (path, headers) for every request."""

    def __init__(self) -> None:
        outer = self
        self.requests: list[tuple[str, dict[str, str]]] = []
        self.stop = threading.Event()

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def reply(self, code: int, body: bytes, content_type: str = "text/plain; charset=utf-8") -> None:
                self.send_response(code)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def redirect(self, code: int, location: str) -> None:
                self.send_response(code)
                self.send_header("Location", location)
                self.send_header("Content-Length", "0")
                self.end_headers()

            def do_GET(self) -> None:
                outer.requests.append((self.path, dict(self.headers)))
                path = self.path
                if path == "/ok":
                    self.reply(200, "héllo wörld, 日本".encode("utf-8"))
                elif path == "/latin":
                    self.reply(200, "café".encode("latin-1"), "text/html; charset=iso-8859-1")
                elif path == "/nocharset":
                    self.reply(200, b"ok\xff!", "text/plain")
                elif path == "/badcharset":
                    self.reply(200, "café".encode("utf-8"), "text/plain; charset=no-such-charset")
                elif path.startswith("/size/"):
                    self.reply(200, b"a" * int(path.rsplit("/", 1)[1]))
                elif path == "/wide":  # 3 bytes per character: the byte cap must not cut the character cap short
                    self.reply(200, "日".encode("utf-8") * 200_001)
                elif path == "/missing":
                    self.send_error(404)
                elif path == "/boom":
                    self.send_error(500)
                elif path.startswith("/chain/"):
                    n = int(path.rsplit("/", 1)[1])
                    if n == 0:
                        self.reply(200, b"end of chain")
                    else:
                        self.redirect(302, f"/chain/{n - 1}")
                elif path.startswith("/code/"):
                    self.redirect(int(path.rsplit("/", 1)[1]), "/ok")
                elif path == "/relative":
                    self.redirect(302, "ok")
                elif path == "/loop":
                    self.redirect(302, "/loop")
                elif path == "/away":
                    self.redirect(302, f"http://localhost:{outer.port}/ok")
                elif path == "/to-ftp":
                    self.redirect(302, "ftp://127.0.0.1/file")
                elif path == "/to-file":
                    self.redirect(302, "file:///etc/passwd")
                elif path == "/no-location":
                    self.send_response(302)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                elif path == "/slow":
                    outer.stop.wait(3)
                    try:
                        self.reply(200, b"too late")
                    except OSError:
                        pass
                elif path == "/drip":  # bytes keep arriving, so no single read ever times out
                    self.send_response(200)
                    self.send_header("Content-Type", "text/plain")
                    self.end_headers()
                    try:
                        for _ in range(60):
                            if outer.stop.wait(0.05):
                                break
                            self.wfile.write(b"x")
                            self.wfile.flush()
                    except OSError:
                        pass
                else:
                    self.send_error(404)

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.httpd.daemon_threads = True
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, args=(0.01,), daemon=True)  # a short poll: quick shutdown
        self.thread.start()

    def url(self, path: str) -> str:
        return f"http://127.0.0.1:{self.port}{path}"

    def paths(self) -> list[str]:
        return [path for path, _ in self.requests]

    def close(self) -> None:
        self.stop.set()
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(5)


@pytest.fixture
def server(monkeypatch: pytest.MonkeyPatch):
    for name in list(os.environ):  # a proxy in the environment must not see the test traffic
        if name.lower().endswith("_proxy"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("NO_PROXY", "*")
    monkeypatch.setenv("no_proxy", "*")
    srv = FetchServer()
    try:
        yield srv
    finally:
        srv.close()


def fetch(bridge: Bridge, url: Any, line: int | None = 2) -> dict:
    return handle(bridge, {"type": "request", "id": 3, "op": "fetch", "line": line, "url": url}, timeout=20)


def test_fetch_constants() -> None:
    assert bridge_module.FETCH_TIMEOUT_S == 30
    assert bridge_module.FETCH_MAX_CHARS == 200_000
    assert bridge_module.FETCH_MAX_REDIRECTS == 5


def test_fetch_ok(tmp_path: Path, server: FetchServer) -> None:
    bridge, app = make(tmp_path)
    assert fetch(bridge, server.url("/ok")) == {"text": "héllo wörld, 日本"}
    path, headers = server.requests[0]
    assert path == "/ok" and {k.lower(): v for k, v in headers.items()}["accept-encoding"] == "identity"
    (record,) = bridge.fetches
    assert set(record) == {"url", "status", "chars", "error", "seconds"}
    assert record["url"] == server.url("/ok") and record["status"] == 200 and record["error"] is None
    assert record["chars"] == len("héllo wörld, 日本") and isinstance(record["seconds"], float)


def test_fetch_does_not_touch_the_budget_or_the_events(tmp_path: Path, server: FetchServer) -> None:
    bridge, app = make(tmp_path)
    fetch(bridge, server.url("/ok"))
    fetch(bridge, server.url("/missing"))
    assert bridge.subcalls_used == 0 and bridge.records == [] and app.events == [] and app.approvals == []


def test_fetch_decodes_with_the_charset(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, server.url("/latin")) == {"text": "café"}
    assert fetch(bridge, server.url("/nocharset")) == {"text": "ok�!"}  # UTF-8 with replacement
    assert fetch(bridge, server.url("/badcharset")) == {"text": "café"}  # an unknown charset falls back to UTF-8


def test_fetch_caps_the_text(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    note = "\n[truncated at 200,000 characters]"
    assert fetch(bridge, server.url("/size/200000")) == {"text": "a" * 200_000}  # exactly the cap: no note
    reply = fetch(bridge, server.url("/size/200001"))
    assert reply == {"text": "a" * 200_000 + note}
    reply = fetch(bridge, server.url("/size/250000"))
    assert reply["text"] == "a" * 200_000 + note and len(reply["text"]) == 200_000 + len(note)
    assert bridge.fetches[-1]["chars"] == len(reply["text"])  # chars is what the model got
    wide = fetch(bridge, server.url("/wide"))["text"]  # 200,001 three-byte characters
    assert wide == "日" * 200_000 + note


def test_fetch_http_errors(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, server.url("/missing")) == {"error": "fetch failed: HTTP 404 Not Found"}
    assert fetch(bridge, server.url("/boom")) == {"error": "fetch failed: HTTP 500 Internal Server Error"}
    assert [(r["status"], r["chars"], r["error"]) for r in bridge.fetches] == [
        (404, 0, "fetch failed: HTTP 404 Not Found"),
        (500, 0, "fetch failed: HTTP 500 Internal Server Error"),
    ]
    assert bridge.infra_error is None


def test_fetch_follows_up_to_five_redirects(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, server.url("/chain/5")) == {"text": "end of chain"}  # 5 redirects, then the page
    assert server.paths() == [f"/chain/{n}" for n in (5, 4, 3, 2, 1, 0)]
    assert bridge.fetches[0]["status"] == 200
    server.requests.clear()
    reply = fetch(bridge, server.url("/chain/6"))  # the 6th redirect is one too many
    assert reply == {"error": "fetch failed: too many redirects (more than 5)"}
    assert server.paths() == [f"/chain/{n}" for n in (6, 5, 4, 3, 2, 1)]  # the 6th redirect is never followed
    assert bridge.fetches[1]["status"] is None and bridge.fetches[1]["error"] == reply["error"]
    assert fetch(bridge, server.url("/loop")) == {"error": "fetch failed: too many redirects (more than 5)"}


@pytest.mark.parametrize("code", [301, 302, 303, 307, 308])
def test_fetch_follows_every_redirect_status(tmp_path: Path, server: FetchServer, code: int) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, server.url(f"/code/{code}")) == {"text": "héllo wörld, 日本"}


def test_fetch_follows_a_relative_redirect(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, server.url("/relative")) == {"text": "héllo wörld, 日本"}


def test_fetch_refuses_a_redirect_to_another_host(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    reply = fetch(bridge, server.url("/away"))  # 127.0.0.1 -> localhost
    assert reply == {"error": "fetch failed: redirected to another host (localhost); call fetch on that URL to allow it"}
    assert server.paths() == ["/away"]  # the other host was never contacted
    assert bridge.fetches[0]["status"] is None and bridge.fetches[0]["error"] == reply["error"]


def test_fetch_refuses_a_redirect_to_another_scheme(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    for path in ("/to-ftp", "/to-file"):
        reply = fetch(bridge, server.url(path))
        assert reply["error"].startswith("fetch failed: redirected to a URL that is not http:// or https://")
    assert server.paths() == ["/to-ftp", "/to-file"]


def test_fetch_redirect_without_a_location_is_an_http_error(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, server.url("/no-location")) == {"error": "fetch failed: HTTP 302 Found"}


@pytest.mark.parametrize("url", ["ftp://127.0.0.1/x", "file:///etc/passwd", "gopher://example.com/", "example.com/x", "", "data:text/plain,hi"])
def test_fetch_only_takes_http_and_https(tmp_path: Path, url: str) -> None:
    bridge, _ = make(tmp_path)
    assert fetch(bridge, url) == {"error": "fetch failed: fetch takes an http:// or https:// URL"}
    assert bridge.fetches[0]["status"] is None and bridge.fetches[0]["url"] == url


def test_fetch_connection_refused(tmp_path: Path, server: FetchServer) -> None:
    with socket.socket() as probe:  # a port nobody listens on
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    bridge, _ = make(tmp_path)
    reply = fetch(bridge, f"http://127.0.0.1:{port}/")
    assert reply["error"].startswith("fetch failed: ") and "HTTP" not in reply["error"]
    assert bridge.fetches[0]["status"] is None and bridge.fetches[0]["error"] == reply["error"]


def test_fetch_without_a_host(tmp_path: Path) -> None:
    bridge, _ = make(tmp_path)
    reply = fetch(bridge, "http:///path")
    assert reply["error"].startswith("fetch failed: ") and bridge.infra_error is None


def test_fetch_times_out(tmp_path: Path, server: FetchServer, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bridge_module, "FETCH_TIMEOUT_S", 0.3)
    bridge, _ = make(tmp_path)
    started = time.monotonic()
    reply = fetch(bridge, server.url("/slow"))
    assert reply == {"error": "fetch failed: timed out after 0.3 s"}
    assert time.monotonic() - started < 2.5
    assert bridge.fetches[0]["status"] is None and bridge.fetches[0]["error"] == reply["error"]


def test_fetch_timeout_covers_the_whole_download(tmp_path: Path, server: FetchServer, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bridge_module, "FETCH_TIMEOUT_S", 0.4)
    bridge, _ = make(tmp_path)
    started = time.monotonic()
    assert fetch(bridge, server.url("/drip")) == {"error": "fetch failed: timed out after 0.4 s"}
    assert time.monotonic() - started < 2.5  # the page would take 3 s


def test_fetch_records_accumulate_in_order(tmp_path: Path, server: FetchServer) -> None:
    bridge, _ = make(tmp_path)
    fetch(bridge, server.url("/ok"))
    fetch(bridge, server.url("/missing"))
    fetch(bridge, "ftp://x/")
    assert [(r["url"], r["status"], r["error"] is None) for r in bridge.fetches] == [
        (server.url("/ok"), 200, True),
        (server.url("/missing"), 404, False),
        ("ftp://x/", None, False),
    ]
