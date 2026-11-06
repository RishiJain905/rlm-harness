"""KV cache: none

v1 step 6, D-234: named agents (`agents/<name>/AGENT.md`) and nudge rules (`nudges.toml`), behind a gate that is off
(`profiles.GATED = False`; `RLMH_TUNE_GATED=1` turns it on for one engine). Loading with the gate off and on, `agent=`
on `llm` and `rlm` through a real worker and `FakeApp.requests`, each nudge kind through `loop.run`, the nudges.toml
format, and `training-v4` getting neither.
"""

from __future__ import annotations

import asyncio
import json
import secrets
from pathlib import Path

import pytest

from conftest import run
from fakeapp import FakeApp
from rlm_engine import loop
from rlm_engine import profiles as p
from rlm_engine.worker.manager import Worker
from tuneprofiles import agent_md, make_profile

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 120
AGENT = "fixture-reader"
AGENT_TEXT = "You read the text you are given and answer in one line."
RULES = ('[[nudge]]\nwhen = "error"\npattern = "ZeroDivisionError"\nhint = "HINT-ERROR: read the error first."\n\n'
         '[[nudge]]\nwhen = "no_submit"\nturns = 3\nhint = "HINT-TURNS: submit what you have."\n\n'
         '[[nudge]]\nwhen = "long_output"\nchars = 1000\nhint = "HINT-LONG: print less."\n')


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    (h / "profiles").mkdir(parents=True)
    return h


@pytest.fixture
def gate(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(p.GATE_ENV, "1")


def fenced(code: str) -> dict:
    return {"text": f"Next.\n```python\n{code}\n```"}


def gated(home: Path, name: str = "gated", *, agents: bool = True, nudges: str | None = RULES,
          base: str = "default") -> Path:
    files: dict[str, str | None] = {}
    if agents:
        files[f"agents/{AGENT}/AGENT.md"] = agent_md(AGENT, body=AGENT_TEXT)
    if nudges is not None:
        files["nudges.toml"] = nudges
    return make_profile(home / "profiles", name, base=base, files=files,
                        add_guidance=f"\nFor a long input, use llm(..., agent=\"{AGENT}\")." if agents else "")


def read_spec(home: Path, profile: str, text: str = "some input\n", conversation: bool = False) -> loop.RunSpec:
    path = home / "input.txt"
    path.write_bytes(text.encode("utf-8"))
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=p.load_profile(profile, home), root=dict(REF),
        sub={"provider": "fake", "model": "sub", "thinking": None}, permission_mode="accept-edits",
        call_format="fenced", interactive=False, question="What is it?", inputs=[path], task=None, repo_path=None,
        test_hint=None, language=None, n_files=None, context=None, tag=None, batch="test",
        log_path=home / "runs" / "test" / "runs.jsonl", conversation=conversation)


def play(home: Path, profile: str, cells: list[str], **script: object) -> tuple[dict, FakeApp]:
    app = FakeApp(script={"root": [fenced(c) for c in cells], "sub": [{"text": "an answer"}], **script})
    return run(loop.run(read_spec(home, profile), app, home=home, worker_factory=Worker), TIMEOUT), app


# ---------------------------------------------------------------------------------------------- loading


def test_gate_off_refuses_both(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(p.GATE_ENV, raising=False)
    assert p.GATED is False and not p.gate_on()
    gated(home, "with-agents", nudges=None)
    gated(home, "with-nudges", agents=False)
    for name in ("with-agents", "with-nudges"):
        with pytest.raises(p.ProfileError, match="behind a gate that is off"):
            p.load_profile(name, home)
    assert [x.name for x in p.list_profiles(home)] == ["default", "training-v4"]  # skipped with a warning
    monkeypatch.setenv(p.GATE_ENV, "1")
    assert p.load_profile("with-agents", home).agents == {
        AGENT: p.Agent(description="Reads a long input and answers briefly.", text=AGENT_TEXT)}
    assert [r.when for r in p.load_profile("with-nudges", home).nudges] == ["error", "no_submit", "long_output"]
    monkeypatch.setenv(p.GATE_ENV, "0")
    with pytest.raises(p.ProfileError):
        p.load_profile("with-agents", home)
    monkeypatch.setattr(p, "GATED", True)  # what step 7 would flip
    assert p.load_profile("with-agents", home).agents


def test_loaded_rules(home: Path, gate: None) -> None:
    gated(home)
    profile = p.load_profile("gated", home)
    assert profile.nudges == (
        p.Nudge(when="error", pattern="ZeroDivisionError", hint="HINT-ERROR: read the error first."),
        p.Nudge(when="no_submit", turns=3, hint="HINT-TURNS: submit what you have."),
        p.Nudge(when="long_output", chars=1000, hint="HINT-LONG: print less."))
    assert sorted(profile.files) == [f"agents/{AGENT}/AGENT.md", "nudges.toml"]
    assert profile.profile_hash() != p.load_profile("default", home).profile_hash()
    assert AGENT_TEXT not in profile.system_prompt()


@pytest.mark.parametrize(("text", "message"), [
    ('[[nudge]]\nwhen = "error"\npattern = "x"\nhint = "h"\ncolour = "red"\n', "unknown key 'colour'"),
    ('[[nudge]]\nwhen = "error"\npattern = ["a", "b"]\nhint = "h"\n', "pattern must be a string"),
    ('[[nudge]]\nwhen = "error"\npattern = "x"\nhint = "' + "h" * 401 + '"\n', "hint must be a string of 1 to 400"),
    ('[[nudge]]\nwhen = "error"\nturns = 3\nhint = "h"\n', "unknown key 'turns'"),
    ('[[nudge]]\nwhen = "sometimes"\npattern = "x"\nhint = "h"\n', "when must be one of"),
    ('[[nudge]]\nwhen = "no_submit"\nturns = true\nhint = "h"\n', "turns must be an integer"),
    ('[[nudge]]\nwhen = "long_output"\nchars = 999\nhint = "h"\n', "chars must be an integer from 1,000"),
    ('[[nudge]]\nwhen = "error"\nhint = "h"\n', "missing key 'pattern'"),
    ('nudge = 1\n', "holds [[nudge]] tables only"),
    ('[other]\nx = 1\n', "unknown key 'other'"),
    ('[[nudge]\n', "not valid TOML"),
])
def test_bad_nudges(text: str, message: str, home: Path, gate: None) -> None:
    gated(home, "bad", agents=False, nudges=text)
    with pytest.raises(p.ProfileError, match=message.replace("[", r"\[").replace("]", r"\]")):
        p.load_profile("bad", home)


def test_training_v4_gets_neither(home: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    for value in ("0", "1"):
        monkeypatch.setenv(p.GATE_ENV, value)
        training = p.load_profile("training-v4", home)
        assert training.agents == {} and training.nudges == () and training.files == {}
        record, app = play(home, "training-v4", ["print('skill' in globals())\ntry:\n    llm('q', agent='x')\n"
                                                 "except TypeError as e:\n    print('TypeError')", "submit(1)"])
        assert record["turns"][0]["stdout"] == "False\nTypeError\n"
        assert all(len(r["messages"]) == 1 for r in app.requests if r["role"] == "sub")
    gated(home, "bare-agents", base="training-v4", nudges=None)
    with pytest.raises(p.ProfileError, match="need agent_api = true"):
        p.load_profile("bare-agents", home)


# ---------------------------------------------------------------------------------------------- agents


def test_llm_agent_is_the_system_message(home: Path, gate: None) -> None:
    gated(home, nudges=None)
    cells = [
        f"print(llm('first', agent='{AGENT}'))\nprint(llm('second', agent='{AGENT}', schema=str))",
        f"f = llm_async('third', agent='{AGENT}')\nprint(f.result(), llm('plain'))",
        "llm('x', agent='nobody')",
        "submit('done')",
    ]
    sub = [{"match": "second", "text": json.dumps("parsed")}, {"text": "an answer"}]
    record, app = play(home, "gated", cells, sub=sub)
    assert record["turns"][0]["stdout"] == "an answer\nparsed\n"
    assert record["turns"][1]["stdout"] == "an answer an answer\n"
    subs = [r for r in app.requests if r["role"] == "sub"]
    with_agent = [r for r in subs if len(r["messages"]) == 2]
    assert len(with_agent) == 3 and len(subs) == 4
    for request in with_agent:  # the same bytes every time, so the cache prefix holds
        assert request["messages"][0] == {"role": "system", "content": AGENT_TEXT}
        assert request["messages"][1]["role"] == "user"
    assert [m["role"] for m in subs[-1]["messages"]] == ["user"]  # llm('plain')
    error = record["turns"][2]["error"]
    assert "ValueError: unknown agent 'nobody'; the agents are: fixture-reader" in error
    assert record["answer"] == "done"


def test_rlm_agent_starts_the_task(home: Path, gate: None) -> None:
    gated(home, nudges=None)
    child = [fenced("submit('child done')")]
    record, app = play(home, "gated", [f"print(rlm('Count the lines.', agent='{AGENT}', tools='none'))",
                                       "rlm('x', agent='nobody')", "submit('ok')"], children={"1": child})
    assert record["turns"][0]["stdout"] == "child done\n"
    [kid] = record["children"]
    assert kid["task"] == AGENT_TEXT + "\n\nCount the lines."
    first = next(r for r in app.requests if r.get("child"))["messages"][1]["content"]
    assert AGENT_TEXT + "\n\nCount the lines." in first
    assert "unknown agent 'nobody'" in record["turns"][1]["error"]


def test_bridge_refuses_an_unknown_agent(home: Path) -> None:
    """The engine checks too: a request naming an agent the profile lacks is an error reply, never a model call."""
    from rlm_engine.bridge import Bridge
    from rlm_engine.permissions import Permissions

    app = FakeApp()
    profile = p.load_profile("default", home)
    perms = Permissions(run_id="r", mode="accept-edits", workspace=home, scratch=home, repo_mode=False,
                        interactive=False, app=app)
    bridge = Bridge(run_id="r", app=app, profile=profile, mode="read", sub_ref=dict(REF), permissions=perms)
    reply = run(bridge.handle({"op": "llm", "prompts": ["hi"], "agent": "x"}))
    assert reply == {"error": "unknown agent 'x'; this profile's agents are: none"} and app.requests == []


# ---------------------------------------------------------------------------------------------- nudges


def test_each_nudge_fires_once(home: Path, gate: None) -> None:
    gated(home, agents=False)
    cells = ["1/0", "1/0", "print('x' * 1500)", "print('y' * 2000)", "print('fine')", "submit('done')"]
    record, _ = play(home, "gated", cells)
    obs = [t["observation"] for t in record["turns"]]
    assert obs[0].endswith("\nHINT-ERROR: read the error first.")
    assert "HINT" not in obs[1]
    assert obs[2].endswith("\nHINT-TURNS: submit what you have.\nHINT-LONG: print less.")
    assert "HINT" not in obs[3] + obs[4]
    assert record["answer"] == "done"


def test_no_nudges_no_hints(home: Path) -> None:
    record, _ = play(home, "default", ["1/0", "print('x' * 1500)", "print(1)", "submit(1)"])
    assert not any("HINT" in (t["observation"] or "") for t in record["turns"])


def test_nudges_start_over_each_prompt(home: Path, gate: None) -> None:
    gated(home, agents=False)
    app = FakeApp(script={"root": [fenced("1/0"), fenced("submit('a')"), fenced("1/0"), fenced("submit('b')")]})

    async def main() -> None:
        inbox = loop.Inbox()
        task = asyncio.create_task(loop.run(read_spec(home, "gated", conversation=True), app, home=home,
                                            worker_factory=Worker, inbox=inbox))
        for n in (1, 2):
            while len(app.sent("run.finished")) < n:
                await asyncio.sleep(0.01)
            if n == 1:
                inbox.put("And again?")
        inbox.close()
        await task

    run(main(), TIMEOUT)
    records = [json.loads(line) for line in (home / "runs" / "test" / "runs.jsonl").read_text("utf-8").splitlines()]
    assert [r["answer"] for r in records] == ["a", "b"]
    for record in records:
        assert record["turns"][0]["observation"].endswith("\nHINT-ERROR: read the error first.")
