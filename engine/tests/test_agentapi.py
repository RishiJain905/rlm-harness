"""KV cache: none

The default profile's delegation helpers (D-157 to D-160): agentapi's schemas, reply parsing and file parts as plain
functions, then `ask_files`, `schema=`, the async calls and rlm() children end to end through `loop.run`, a real worker
and `FakeApp(script=...)`.
"""

from __future__ import annotations

import json
import math
import secrets
from pathlib import Path, PurePosixPath

import pytest

from conftest import compact_profile, run
from fakeapp import FakeApp, _request_chars
from rlm_engine import inputs, loop
from rlm_engine.profiles import BUILTIN_DIR, ProfileError, load_profile
from rlm_engine.worker import agentapi
from rlm_engine.worker.manager import Worker

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 120


def fenced(code: str) -> dict:
    return {"text": f"Next.\n```python\n{code}\n```"}


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    h.mkdir()
    return h


def read_spec(home: Path, files: dict[str, str], **overrides: object) -> loop.RunSpec:
    paths = []
    for name, text in files.items():
        path = home / name
        path.write_bytes(text.encode("utf-8"))
        paths.append(path)
    spec = loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=load_profile("default", home), root=dict(REF),
        sub={"provider": "fake", "model": "sub", "thinking": None}, permission_mode="accept-edits",
        call_format="fenced", interactive=False, question="What is it?", inputs=paths, task=None, repo_path=None,
        test_hint=None, language=None, n_files=None, context=None, tag=None, batch="test",
        log_path=home / "runs" / "test" / "runs.jsonl")
    for key, value in overrides.items():
        setattr(spec, key, value)
    return spec


def repo_spec(home: Path, repo: Path) -> loop.RunSpec:
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="repo", profile=load_profile("default", home), root=dict(REF),
        sub=dict(REF), permission_mode="accept-edits", call_format="fenced", interactive=False, question=None,
        inputs=[], task="Make parse() strip spaces.", repo_path=repo, test_hint=None, language=None, n_files=None,
        context=None, tag=None, batch="test", log_path=home / "runs" / "test" / "runs.jsonl")


def play(spec: loop.RunSpec, app: FakeApp, home: Path) -> dict:
    return run(loop.run(spec, app, home=home, worker_factory=Worker), TIMEOUT)


def outputs(record: dict) -> list[str]:
    return [t["stdout"] or t["error"] or "" for t in record["turns"]]


# ---------------------------------------------------------------------------------------------- schemas


def test_compile_shorthand() -> None:
    assert agentapi.compile_schema(int) == {"type": "integer"}
    assert agentapi.compile_schema(list[str]) == {"type": "array", "items": {"type": "string"}}
    assert agentapi.compile_schema(["yes", "no"]) == {"type": "string", "enum": ["yes", "no"]}
    assert agentapi.compile_schema([int]) == {"type": "array", "items": {"type": "integer"}}
    assert agentapi.compile_schema({"ok": bool, "line": int | None}) == {
        "type": "object", "properties": {"ok": {"type": "boolean"},
                                         "line": {"anyOf": [{"type": "integer"}, {"type": "null"}]}},
        "required": ["ok", "line"]}
    assert agentapi.compile_schema({"type": str}) == {"type": "object", "properties": {"type": {"type": "string"}},
                                                      "required": ["type"]}  # a Python type: the shorthand
    js = {"type": "object", "properties": {"n": {"type": "number"}}, "required": ["n"]}
    assert agentapi.compile_schema(js) is js
    with pytest.raises(TypeError):
        agentapi.compile_schema({"type": "object", "pattern": "x"})
    with pytest.raises(TypeError):
        agentapi.compile_schema(object)


def test_validate() -> None:
    schema = agentapi.compile_schema({"ok": bool, "issues": [{"line": int, "problem": str}]})
    value, error = agentapi.validate({"ok": False, "issues": [{"line": 3.0, "problem": "x"}]}, schema)
    assert error is None and value["issues"][0]["line"] == 3 and isinstance(value["issues"][0]["line"], int)
    assert agentapi.validate({"ok": True}, schema)[1] == "$ is missing issues"
    assert "$.issues[0].line" in agentapi.validate({"ok": 1 == 1, "issues": [{"line": "3", "problem": ""}]}, schema)[1]
    assert agentapi.validate(True, {"type": "integer"})[1] is not None  # bool is not an integer
    assert agentapi.validate("maybe", agentapi.compile_schema(["yes", "no"]))[1].startswith("$ is 'maybe'")


def test_parse_reply() -> None:
    assert agentapi.parse_reply(" 42 ") == 42
    assert agentapi.parse_reply("Sure:\n```json\n{\"a\": [1, 2]}\n```\nDone.") == {"a": [1, 2]}
    assert agentapi.parse_reply("The answer is {\"a\": 1} as asked") == {"a": 1}
    with pytest.raises(ValueError):
        agentapi.parse_reply("")
    with pytest.raises(ValueError):
        agentapi.parse_reply("no json here")


def test_split_text_and_parts() -> None:
    text = "".join(f"line {i}\n" for i in range(1, 101))
    pieces = agentapi.split_text(text, 200)
    assert "".join(p for _, _, p in pieces) == text
    assert all(len(p) <= 200 and p.endswith("\n") for _, _, p in pieces)
    assert pieces[0][0] == 1 and pieces[1][0] == pieces[0][1] + 1 and pieces[-1][1] == 100
    context = inputs.join_context([PurePosixPath("C:/x/a.txt"), PurePosixPath("C:/x/b.txt")], ["alpha\n", "beta\n"])
    assert agentapi.context_parts(context, ["C:/x/a.txt", "C:/x/b.txt"]) == {"C:/x/a.txt": "alpha\n",
                                                                           "C:/x/b.txt": "beta\n"}
    assert agentapi.context_parts("only", ["C:/x/a.txt"]) == {"C:/x/a.txt": "only"}


# ---------------------------------------------------------------------------------------------- the profile


def test_profile_settings(home: Path) -> None:
    profile = load_profile("default", home)
    assert profile.agent_api and profile.cache_api
    assert (profile.rlm.max_runs, profile.rlm.max_turns, profile.rlm.max_depth, profile.rlm.max_parallel) == (12, 30, 1, 4)
    assert not load_profile("training-v4", home).agent_api
    base = (BUILTIN_DIR / "training-v4" / "profile.toml").read_text(encoding="utf-8")
    both = "cache_api = true\nagent_api = true\n"
    for top, table, message in (("agent_api = true\n", "", "needs cache_api"), ("", "max_runs = 2", "needs agent_api"),
                                (both, "max_depth = -1", "at least 0"), (both, "who = 1", "unknown key")):
        name = "p-" + secrets.token_hex(3)
        folder = home / "profiles" / name
        folder.mkdir(parents=True)
        text = top + base + (f"\n[rlm]\n{table}\n" if table else "")  # top-level keys before the first table
        (folder / "profile.toml").write_text(text, encoding="utf-8")
        with pytest.raises(ProfileError, match=message):
            load_profile(name, home)


# ---------------------------------------------------------------------------------------------- end to end


def test_ask_files_schema_and_async(home: Path) -> None:
    cells = [
        "r = ask_files('*.txt', 'Which animal?')\nprint(sorted((k.rsplit('/', 1)[-1], v) for k, v in r.items()))",
        "print(llm('Give a number', schema=int) + 1)",
        "print(llm_batch(['Pick one', 'Give a number'], schema=int))",
        "try:\n    llm('Pick one', schema=int)\nexcept ValueError as e:\n    print('ValueError', str(e)[:40])",
        "f = llm_async('ping async')\ng = llm_batch_async(['ping a', 'ping b'])\nprint(gather([f, g]))",
        "submit('done')",
    ]
    app = FakeApp(script={
        "root": [fenced(c) for c in cells],
        "sub": [{"match": r"a\.txt ===", "text": "cat"}, {"match": r"b\.txt ===", "text": "dog"},
                {"match": "Give a number", "text": "Here:\n```json\n41\n```"}, {"match": "Pick one", "text": "no"},
                {"match": "ping", "text": "pong"}]})
    record = play(read_spec(home, {"a.txt": "alpha\n", "b.txt": "beta\n"}), app, home)
    out = outputs(record)
    assert out[0] == "[('a.txt', 'cat'), ('b.txt', 'dog')]\n"
    assert out[1] == "42\n"
    assert out[2] == ("llm_batch: 1 of 2 replies did not match the schema, asked twice; they are None\n"
                      "[None, 41]\n")
    assert out[3].startswith("ValueError the sub-call's reply did not match")
    assert out[4] == "['pong', ['pong', 'pong']]\n"
    assert record["answer"] == "done"
    subs = [r for r in app.requests if r["role"] == "sub"]
    file_calls = [r for r in subs if "Which animal?" in r["messages"][-1]["content"]]
    assert len(file_calls) == 2 and all("prefix" in r for r in file_calls)  # the file is the cached prefix
    assert all(r["messages"][-1]["content"].endswith("\n\nWhich animal?") for r in file_calls)
    asynced = [r for r in subs if r["messages"][-1]["content"].startswith("ping")]
    assert {r["origin"]["line"] for r in asynced} == {1, 2}  # the cell line that started each, not None


def test_thinking_and_empty_replies(home: Path) -> None:
    cells = [
        "try:\n    llm('Blank one', schema=int, thinking='high')\nexcept ValueError as e:\n    print('ValueError')",
        "print(llm_batch(['Blank two', 'Give a number'], schema=int, thinking='medium'))",
        "print(llm('Give a number', thinking='low'))",
        "try:\n    llm('x', thinking='max')\nexcept ValueError as e:\n    print(e)",
        "submit(1)",
    ]
    app = FakeApp(script={"root": [fenced(c) for c in cells],
                          "sub": [{"match": "Blank", "text": ""}, {"match": "Give a number", "text": "41"}]})
    record = play(read_spec(home, {"a.txt": "x\n"}), app, home)
    out = outputs(record)
    assert out[0] == "ValueError\n"
    assert out[1].endswith("[None, 41]\n")
    assert out[2] == "41\n"
    assert out[3].startswith("thinking must be one of 'off', 'low', 'medium', 'high'")
    subs = [(r["messages"][-1]["content"], r["thinking"]) for r in app.requests if r["role"] == "sub"]
    blank = [(p, t) for p, t in subs if p.startswith("Blank one")]
    assert [t for _, t in blank] == ["high", "off"]  # the retry of an empty reply does not think (D-164)
    assert "ran out of room" in blank[1][0] and "Your previous reply was" not in blank[1][0]
    assert [t for p, t in subs if p.startswith("Blank two")] == ["medium", "off"]
    assert [t for p, t in subs if p.startswith("Give a number")] == ["medium", "low"]


def test_training_v4_has_none_of_it(home: Path) -> None:
    app = FakeApp(script={"root": [fenced("print([n in dir() for n in ('ask_files', 'rlm', 'gather', 'review')])"),
                                   fenced("submit(1)")]})
    record = play(read_spec(home, {"a.txt": "x\n"}, profile=load_profile("training-v4", home)), app, home)
    assert outputs(record)[0] == "[False, False, False, False]\n"
    assert record["children"] == []


def test_rlm_child_read_mode(home: Path) -> None:
    cells = ["ans = rlm('Count the lines', context='a\\nb\\nc')\nprint(ans)",
             "try:\n    rlm('again', tools='edit')\nexcept ValueError as e:\n    print(e)",
             "submit(ans)"]
    child = [fenced("print(len(context))"), fenced("try:\n    rlm('deeper')\nexcept RuntimeError as e:\n    print(e)"),
             fenced("submit(len(context.splitlines()))")]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "children": {"1": child}})
    record = play(read_spec(home, {"a.txt": "x\n"}), app, home)
    out = outputs(record)
    assert out[0] == "3\n"
    assert out[1] == 'rlm(tools="edit") works only in coding tasks\n'
    assert record["answer"] == 3
    [kid] = record["children"]
    assert kid["child_id"] == 1 and kid["depth"] == 1 and kid["submitted"] and kid["answer"] == 3
    assert [t["stdout"] for t in kid["turns"]][:2] == ["5\n", "rlm() cannot start a run from inside an rlm() run "
                                                             "here (at most 1 level deep); do the work in this run\n"]
    turns = [r for r in app.requests if r.get("child")]
    assert [r["child"]["turn"] for r in turns] == [1, 2, 3]
    first = turns[0]
    assert first["role"] == "sub" and first["model"] == REF and first["subcall_id"] == kid["subcall_id"]
    assert first["tools"] == [] and first["batch"] == {"id": "rlm1", "index": 0, "size": 1}
    assert first["messages"][0] == app.requests[0]["messages"][0]  # the parent's system prompt
    assert first["messages"][1]["content"].startswith("Question: Count the lines")
    [row] = [s for s in record["subcalls"] if s["subcall_id"] == kid["subcall_id"]]
    assert row["prompt"] == "Count the lines" and row["output"] == "3" and row["error"] is None
    statuses = [p["status"] for p in app.sent("run.child")]
    assert statuses == ["started", "turn", "turn", "turn", "done"]
    assert app.sent("run.child")[-1]["answer"] == 3
    sub_events = [p for p in app.sent("run.subcall") if p["subcall_id"] == kid["subcall_id"]]
    assert [p["status"] for p in sub_events] == ["sent", "done"]


def test_rlm_child_limits(home: Path) -> None:
    cells = ["try:\n    rlm('loop forever', max_turns=2)\nexcept RuntimeError as e:\n    print(e)", "submit(1)"]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "children": {"*": [fenced("print(1)")] * 5}})
    record = play(read_spec(home, {"a.txt": "x\n"}), app, home)
    assert outputs(record)[0].startswith("the rlm() run used all 2 of its turns without calling submit()")
    [kid] = record["children"]
    assert kid["max_turns"] == 2 and len(kid["turns"]) == 2 and not kid["submitted"]
    assert app.sent("run.child")[-1]["status"] == "error"


def test_rlm_children_share_the_budget(home: Path) -> None:
    cells = ["fs = [rlm_async(f'task {i}', context=str(i)) for i in range(3)]\nprint(gather(fs))", "submit(1)"]
    child = [fenced("print(llm('ping ' + context))"), fenced("submit(context)")]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "children": {"*": child},
                          "sub": [{"match": "ping", "text": "pong"}]})
    record = play(read_spec(home, {"a.txt": "x\n"}), app, home)
    assert outputs(record)[0] == "['0', '1', '2']\n"
    assert len(record["children"]) == 3
    assert len(record["subcalls"]) == 6  # three children and one sub-call each
    inner = [s for s in record["subcalls"] if s["origin"].get("child")]
    assert sorted(s["origin"]["child"] for s in inner) == [1, 2, 3]
    assert all(s["origin"]["turn"] == 1 and s["origin"]["line"] == 1 for s in inner)  # the child's own turn and line
    finished = app.sent("run.finished")[-1]
    assert finished["subcalls"] == 6


@pytest.mark.usefixtures("git_repo")
def test_rlm_child_repo_read_only_and_edit(home: Path, git_repo: Path) -> None:
    probe = ("print(read_file('a.py'))\nprint('edit_file' in dir())\n"
             "try:\n    open('a.py', 'w').write('y = 2\\n')\nexcept PermissionError as e:\n    print(str(e)[:80])")
    cells = ["print(rlm('Look at a.py'))", "print(rlm('Change a.py', tools='edit'))", "submit('ok')"]
    app = FakeApp(script={"root": [fenced(c) for c in cells],
                          "children": {"1": [fenced(probe), fenced("submit('looked')")],
                                       "2": [fenced("print(edit_file('a.py', 'x = 1', 'x = 3'))"),
                                             fenced("submit('changed')")]}})
    record = play(repo_spec(home, git_repo), app, home)
    assert outputs(record)[:2] == ["looked\n", "changed\n"]
    first = record["children"][0]["turns"][0]["stdout"]
    assert "x = 1" in first and "False" in first
    assert "this rlm() run is read-only" in first
    assert (git_repo / "a.py").read_text(encoding="utf-8") == "x = 3\n"
    assert "+x = 3" in record["diff"]
    kid_request = next(r for r in app.requests if r.get("child", {}).get("id") == 1)
    assert "read_file, find_files, grep and diff" in kid_request["messages"][1]["content"]
    edit_request = next(r for r in app.requests if r.get("child", {}).get("id") == 2)
    assert edit_request["messages"][1]["content"].startswith("Task: Change a.py")
    assert json.loads(json.dumps(record["children"]))  # the record stays JSON


# ---------------------------------------------------------------------------------------------- Sol's review (D-165)


def deep_profile(home: Path, **rlm: int):
    """The default profile with [rlm] keys replaced and no guidance, saved as a user profile."""
    lines = (BUILTIN_DIR / "default" / "profile.toml").read_text(encoding="utf-8").splitlines()
    for i, line in enumerate(lines):
        key = line.split("=")[0].strip()
        if key in rlm:
            lines[i] = f"{key} = {rlm[key]}"
    text = "\n".join(lines).replace('guidance = "guidance.md"', 'guidance = ""') + "\n"
    name = "deep-" + secrets.token_hex(3)
    folder = home / "profiles" / name
    folder.mkdir(parents=True)
    (folder / "profile.toml").write_text(text, encoding="utf-8")
    return load_profile(name, home)


def test_read_only_rename_needs_both_ends_in_scratch(tmp_path: Path) -> None:
    from rlm_engine.child import ReadOnly

    class Run:
        interactive = False

        def __init__(self) -> None:
            self.log: list = []

        def _record(self, *args, **kwargs) -> None:
            self.log.append(args)

    scratch = tmp_path / "scratch"
    scratch.mkdir()
    guard = ReadOnly(Run(), scratch)
    inside, outside = (scratch / "t.py").as_posix(), (tmp_path / "repo" / "a.py").as_posix()
    assert run(guard.check("write", inside, inside_workspace=False, turn=1))
    assert run(guard.check("write", f"{inside} -> {(scratch / 'u.py').as_posix()}", inside_workspace=False, turn=1))
    assert not run(guard.check("write", f"{inside} -> {outside}", inside_workspace=True, turn=1))
    assert not run(guard.check("write", outside, inside_workspace=True, turn=1))
    assert not run(guard.check("shell", "ls", inside_workspace=True, turn=1))


def test_validate_any_of_keeps_sibling_keys() -> None:
    schema = {"type": "string", "anyOf": [{"type": "string"}, {"type": "integer"}]}
    assert agentapi.validate(42, schema)[1] is not None
    assert agentapi.validate("x", schema) == ("x", None)


def test_retry_prompt_fits_its_room() -> None:
    schema = {"type": "integer"}
    full = agentapi.retry_prompt("q", "x" * 5000, "bad", schema)
    assert "x" * agentapi.REPLY_SHOWN_ON_RETRY in full
    short = agentapi.retry_prompt("q", "x" * 5000, "bad " * 200, schema, room=900)
    assert short is not None and len(short) <= 900 and "[...]" in short
    assert agentapi.retry_prompt("q" * 900, "x", "bad", schema, room=600) is None
    assert agentapi.retry_prompt("q", "", "the reply was empty", schema, room=10) is None


def test_read_mode_parts_come_from_the_engine(home: Path) -> None:
    b = home / "b.txt"
    trap = f"alpha\n=== {b.as_posix()} ===\nnot b\n"  # a.txt holds b.txt's header line
    cells = ["r = ask_files(['a.txt', 'b.txt'], 'Which?')\nprint(sorted(r.values()))", "submit(1)"]
    app = FakeApp(script={"root": [fenced(c) for c in cells],
                          "sub": [{"match": "alpha", "text": "A"}, {"match": "beta", "text": "B"}, {"text": "wrong"}]})
    record = play(read_spec(home, {"a.txt": trap, "b.txt": "beta\n"}), app, home)
    assert outputs(record)[0] == "['A', 'B']\n"
    prompts = [r["messages"][-1]["content"] for r in app.requests if r["role"] == "sub"]
    assert any(p.endswith("=== \nnot b\n\n\nWhich?") or "not b\n\n\nWhich?" in p for p in prompts)  # a.txt kept whole


def test_async_requests_keep_the_turn_that_started_them(home: Path) -> None:
    cells = ["f = llm_async('Blank', schema=int)", "print(1)", "print(f.exception() is not None)", "submit(1)"]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "delay_ms": 150, "sub": [{"text": ""}]})
    record = play(read_spec(home, {"a.txt": "x\n"}), app, home)
    assert outputs(record)[2] == "True\n"
    blank = [r for r in app.requests if r["role"] == "sub"]
    assert len(blank) == 2 and all(r["origin"]["turn"] == 1 and r["origin"]["line"] == 1 for r in blank)


def test_nested_children_keep_their_ceiling_and_never_deadlock(home: Path) -> None:
    profile = deep_profile(home, max_depth=2, max_parallel=1)
    cells = ["print(rlm('outer', context='c'))", "submit(1)"]
    outer = [fenced("try:\n    rlm('wider', tools='edit')\nexcept Exception as e:\n    print(e)"),
             fenced("print(rlm('inner', context='i', tools='none'))"), fenced("submit('outer done')")]
    app = FakeApp(script={"root": [fenced(c) for c in cells],
                          "children": {"1": outer, "2": [fenced("submit('inner done')")]}})
    record = play(read_spec(home, {"a.txt": "x\n"}, profile=profile), app, home)
    assert outputs(record)[0] == "outer done\n"
    kid = record["children"][0]
    assert kid["turns"][0]["stdout"].startswith('rlm(tools="edit") works only in coding tasks')
    assert kid["turns"][1]["stdout"] == "inner done\n"
    assert record["children"][1]["depth"] == 2 and record["children"][1]["parent_child"] == 1


@pytest.mark.usefixtures("git_repo")
def test_read_only_child_cannot_start_an_edit_child(home: Path, git_repo: Path) -> None:
    spec = repo_spec(home, git_repo)
    spec.profile = deep_profile(home, max_depth=2)
    cells = ["print(rlm('look'))", "submit(1)"]
    probe = "try:\n    rlm('change it', tools='edit')\nexcept RuntimeError as e:\n    print(e)"
    app = FakeApp(script={"root": [fenced(c) for c in cells],
                          "children": {"1": [fenced(probe), fenced("submit('ok')")]}})
    record = play(spec, app, home)
    assert record["children"][0]["turns"][0]["stdout"] == ('an rlm() run with tools="read" cannot start one with '
                                                          'tools="edit"\n')
    assert len(record["children"]) == 1


@pytest.mark.usefixtures("git_repo")
def test_ask_files_takes_a_work_repo_path(home: Path, git_repo: Path) -> None:
    cells = ["print(ask_files('/work/repo/pkg/core.py', 'What?'))", "submit(1)"]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "sub": [{"text": "parse"}]})
    record = play(repo_spec(home, git_repo), app, home)
    assert outputs(record)[0] == "{'pkg/core.py': 'parse'}\n"


@pytest.mark.usefixtures("git_repo")
def test_unfinished_edit_child_stops_before_the_diff(home: Path, git_repo: Path) -> None:
    cells = ["f = rlm_async('change it', tools='edit')\nsubmit('early')"]
    child = [fenced("import time\ntime.sleep(1)"), fenced("print(write_file('late.txt', 'late\\n'))"),
             fenced("submit('x')")]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "children": {"*": child}})
    record = play(repo_spec(home, git_repo), app, home)
    assert record["answer"] == "early"
    late = git_repo / "late.txt"
    assert ("late.txt" in (record["diff"] or "")) == late.exists()  # never on disk but missing from the diff


def test_git_runs_no_repository_hook(tmp_path: Path) -> None:
    from conftest import HAS_GIT, git
    from rlm_engine import workspace

    if not HAS_GIT:
        pytest.skip("needs git")
    repo, scratch = tmp_path / "repo", tmp_path / "scratch"
    repo.mkdir()
    scratch.mkdir()
    (repo / "a.txt").write_text("a\n", encoding="utf-8")
    git(repo, "init", "-q")
    git(repo, "add", "-A")
    git(repo, "commit", "-qm", "base")
    marker = tmp_path / "hooked"
    hook = repo / ".git" / "hooks" / "post-index-change"
    hook.write_bytes(f"#!/bin/sh\necho ran > '{marker.as_posix()}'\n".encode())
    hook.chmod(0o755)
    (repo / "a.txt").write_text("b\n", encoding="utf-8")
    git(repo, "-c", "core.hooksPath=.git/hooks", "add", "-A")  # git itself runs it
    if not marker.exists():
        pytest.skip("git on this machine does not run post-index-change hooks")
    marker.unlink()
    (repo / "a.txt").write_text("c\n", encoding="utf-8")
    tree = workspace.snapshot(repo, scratch)
    workspace.diff(repo, tree, scratch)
    assert not marker.exists()


def test_rlm_child_compacts(home: Path) -> None:
    """A child run compacts as the run does (v1 step 3): its summary call is role "sub" with its `child` field and
    `purpose`, its run.compacted carries the child's id, and the summary's usage is the child's."""
    compact_profile(home)
    cells = ["ans = rlm('Print a lot, then answer', context='x')\nprint(ans)", "submit(ans)"]
    child = [fenced(f"print({c!r} * 3000)") for c in "abcdefgh"] + [fenced("submit('child done')")]
    app = FakeApp(script={"root": [fenced(c) for c in cells], "children": {"1": child},
                          "compact": [{"text": "CHILD SUMMARY"}]})
    record = play(read_spec(home, {"a.txt": "x\n"}, profile=load_profile("compact-test", home)), app, home)
    assert record["answer"] == "child done"
    [event] = app.sent("run.compacted")
    assert event["child_id"] == 1 and event["prompt_index"] == 0
    assert record["compactions"] == [{k: v for k, v in event.items() if k != "run_id"}]
    [kid] = record["children"]
    [summary] = [r for r in app.requests if r.get("purpose") == "compact"]
    assert summary["role"] == "sub" and summary["subcall_id"] == kid["subcall_id"]
    assert summary["child"] == {"id": 1, "turn": event["turn"], "max_turns": kid["max_turns"], "depth": 1}
    assert summary["batch"] == {"id": "rlm1", "index": 0, "size": 1} and summary["max_tokens"] == 512
    assert summary["messages"][-1]["content"].startswith("Stop work on the task for this one reply.")
    turns = [r for r in app.requests if r.get("child") and r.get("purpose") is None]
    after = next(r for r in turns if r["child"]["turn"] == event["turn"])
    assert after["messages"][:2] == turns[0]["messages"][:2]
    assert after["messages"][2]["content"].endswith(
        "CHILD SUMMARY\n\n[The newest turns follow as they were. The REPL still holds every variable.]")
    turn_input = sum(t["usage"]["input_tokens"] for t in kid["turns"])
    summary_input = math.ceil(_request_chars(summary) / 4)
    assert kid["usage"]["input_tokens"] == turn_input + summary_input
    assert record["usage"]["sub"]["input_tokens"] == kid["usage"]["input_tokens"]  # through finish_child
    assert not any(r.get("purpose") for r in app.requests if r["role"] == "root")
