"""KV cache: none

D-251: `scan()` and the reading tasks' submit check, end to end through `loop.run`, a real worker and
`FakeApp(script=...)`, plus `submitcheck`'s rule as plain functions.
"""

from __future__ import annotations

import json
import secrets
from pathlib import Path

import pytest

from conftest import run
from fakeapp import FakeApp
from rlm_engine import loop, submitcheck
from rlm_engine.profiles import BUILTIN_DIR, load_profile
from rlm_engine.worker.manager import Worker

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 120
HELD = "The harness held this submit() once"
NOTHING = {"text": json.dumps({"quotes": [], "note": "nothing here"})}


def fenced(code: str) -> dict:
    return {"text": f"Next.\n```python\n{code}\n```"}


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    h.mkdir()
    return h


def long_text(lines: int = 1000) -> str:
    """50-character lines: 1,000 of them is 50,000 characters, two segments of `context`."""
    return "".join(f"{i:04d} " + "x" * 44 + "\n" for i in range(lines))


def default_with(home: Path, name: str, **read: object) -> str:
    """The built-in `default` saved as a user profile, with [read] keys replaced."""
    folder = home / "profiles" / name
    folder.mkdir(parents=True)
    lines = (BUILTIN_DIR / "default" / "profile.toml").read_text(encoding="utf-8").splitlines()
    section = None
    for i, line in enumerate(lines):
        if line.startswith("["):
            section = line.split("]")[0].strip("[")
        key = line.split("=")[0].strip()
        if section == "read" and key in read:
            lines[i] = f"{key} = {json.dumps(read.pop(key))}"
    assert not read, read
    (folder / "profile.toml").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (folder / "guidance.md").write_bytes((BUILTIN_DIR / "default" / "guidance.md").read_bytes())
    (folder / "system.md").write_bytes((BUILTIN_DIR / "default" / "system.md").read_bytes())  # rlmh-1 (D-256)
    return name


def read_spec(home: Path, text: str, profile: str = "default") -> loop.RunSpec:
    path = home / "input.txt"
    path.write_bytes(text.encode("utf-8"))
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=load_profile(profile, home), root=dict(REF),
        sub={"provider": "fake", "model": "sub", "thinking": None}, permission_mode="accept-edits",
        call_format="fenced", interactive=False, question="What is it?", inputs=[path], task=None, repo_path=None,
        test_hint=None, language=None, n_files=None, context=None, tag=None, batch="test",
        log_path=home / "runs" / "test" / "runs.jsonl")


def play(spec: loop.RunSpec, cells: list[str], home: Path, sub: list[dict] | None = None) -> tuple[dict, FakeApp]:
    app = FakeApp(script={"root": [fenced(c) for c in cells], "sub": sub or [NOTHING]})
    return run(loop.run(spec, app, home=home, worker_factory=Worker), TIMEOUT), app


def observations(record: dict) -> list[str]:
    return [t["observation"] or "" for t in record["turns"]]


# ---------------------------------------------------------------------------------------------- the rule


def test_rule() -> None:
    sizes = {"total": 400_000, "turns_left": 10, "subcalls_left": 80, "segment_chars": 40_000}
    assert submitcheck.should_hold(0.5, seen=8_000, sent=0, **sizes)
    assert not submitcheck.should_hold(0.5, seen=8_000, sent=400_000, **sizes)  # a full scan
    assert not submitcheck.should_hold(0.0, seen=0, sent=0, **sizes)  # off
    assert not submitcheck.should_hold(0.5, seen=0, sent=0, **dict(sizes, total=20_000))  # short: read in a few prints
    assert not submitcheck.should_hold(0.5, seen=0, sent=0, **dict(sizes, turns_left=1))  # no turn to scan and submit
    assert not submitcheck.should_hold(0.5, seen=0, sent=0, **dict(sizes, subcalls_left=9))  # a scan needs 10
    assert submitcheck.share(total=100, seen=80, sent=80) == 1.0
    text = submitcheck.note(total=400_000, seen=8_000, sent=0, segment_chars=40_000)
    assert text.startswith(HELD) and "about 2.0% of `context`" in text and "(about 10 sub-calls)" in text
    assert "8,000 characters printed and 0 sent to sub-calls, of 400,000" in text


# ---------------------------------------------------------------------------------------------- the loop


def test_first_submit_held_once(home: Path) -> None:
    record, app = play(read_spec(home, long_text()), ["print(context[:200])", "submit('first')", "submit('second')"],
                       home)
    assert record["submitted"] and record["answer"] == "second" and len(record["turns"]) == 3
    obs = observations(record)
    assert HELD not in obs[0] and HELD in obs[1] and "scan(" in obs[1]
    assert obs[1].rstrip().endswith("the next submit() is final.")
    assert not [r for r in app.requests if r["role"] == "sub"]


def test_held_answer_stands_when_turns_run_out(home: Path) -> None:
    profile = default_with(home, "few-turns", max_turns=3)
    record, _ = play(read_spec(home, long_text(), profile), ["submit('first')", "print(1)", "print(2)"], home)
    assert record["submitted"] and record["answer"] == "first" and len(record["turns"]) == 3
    assert HELD in observations(record)[0]


def test_no_hold_after_a_scan(home: Path) -> None:
    record, app = play(read_spec(home, long_text()), ["found = scan('What is it?')\nprint(found)", "submit('x')"], home)
    assert record["answer"] == "x" and len(record["turns"]) == 2
    assert record["turns"][0]["stdout"] == "scan: 2 parts, 0 with passages, 0 quotes (0 word for word)\n[]\n"
    assert len([r for r in app.requests if r["role"] == "sub"]) == 2


def test_no_hold_when_off_or_short(home: Path) -> None:
    off = default_with(home, "no-check", submit_check=0)
    for spec in (read_spec(home, long_text(), off), read_spec(home, long_text(), "training-v4"),
                 read_spec(home, long_text(100))):  # 5,000 characters
        record, _ = play(spec, ["submit('a')"], home)
        assert record["answer"] == "a" and len(record["turns"]) == 1


# ---------------------------------------------------------------------------------------------- scan()


def test_scan_quotes_and_offsets(home: Path) -> None:
    text = long_text(50).replace("0030 " + "x" * 44, "0030 the cat sat here" + "x" * 28)
    cells = [
        "f = scan('Who sat?', size=1000)\n"
        "print(len(segments(1000)), [(x['part'], [(q['text'], q['at'] is not None and context[q['at']:].startswith(q['text'])) "
        "for q in x['quotes']], x['note']) for x in f])",
        "print(scan('How many?', schema=int, size=1000)[:2])",
        "submit('done')",
    ]
    sub = [{"match": "How many", "text": "3"},
           {"match": "the cat sat here", "text": json.dumps({"quotes": ["the cat sat here", "a cat was sitting"],
                                                            "note": "a cat sat"})},
           NOTHING]
    record, app = play(read_spec(home, text), cells, home, sub)
    first, second = record["turns"][0]["stdout"], record["turns"][1]["stdout"]
    n = int(first.split("\n")[1].split(" ")[0])
    assert first.startswith(f"scan: {n} parts, 1 with passages, 2 quotes (1 word for word)\n")
    assert "[('the cat sat here', True), ('a cat was sitting', False)], 'a cat sat')]" in first
    assert second.startswith("[{'part': 0, 'start': 0, 'end': ") and "'answer': 3}" in second
    prompts = [r["messages"][-1]["content"] for r in app.requests if r["role"] == "sub"]
    assert len(prompts) == 2 * n and all(f"of {n} of a longer text" in p for p in prompts)
    assert record["answer"] == "done"


def test_scan_refused_in_a_coding_task(home: Path, git_repo: Path) -> None:
    spec = loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="repo", profile=load_profile("default", home), root=dict(REF),
        sub=dict(REF), permission_mode="accept-edits", call_format="fenced", interactive=False, question=None,
        inputs=[], task="Look.", repo_path=git_repo, test_hint=None, language=None, n_files=None, context=None,
        tag=None, batch="test", log_path=home / "runs" / "test" / "runs.jsonl")
    record, _ = play(spec, ["scan('x')", "submit('ok')"], home)
    assert "scan() reads `context`, and a coding task has none" in record["turns"][0]["error"]
