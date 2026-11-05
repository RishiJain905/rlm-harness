"""KV cache: none

D-256: rlmh's own contract, `rlmh-1`, beside prompt v4. Under rlmh-1 (the built-in `default`) every model-facing text
of a run comes from rlmhcontract.py and the system prompt from the profile's system.md, and under v4 (`training-v4`, or
a user profile that says `contract = "v4"`) from contract.py, byte for byte. Also the loading rules for `contract` and
`system`, the prompt and profile hash rules, the run record's contract fields, and system.md's place on the tuner's
surface (profile.check's bounds and `changed`).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import secrets
from pathlib import Path

import pytest

from conftest import needs_git, run
from fakeapp import FakeApp
from rlm_engine import child as childmod
from rlm_engine import contract, loop, rlmhcontract, workspace
from rlm_engine import profiles as p
from rlm_engine.bridge import Bridge
from rlm_engine.permissions import Permissions
from rlm_engine.service import profile_check
from rlm_engine.worker.manager import Worker
from test_bridge import RUN_ID, SUB, StubApp, batch_request, echo, handle
from tuneprofiles import SKILL, edit_toml, make_profile, skill_md

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 120
# The built-in default under rlmh-1, with the system.md and guidance.md of D-256. A change to either file, to
# rlmhcontract's texts or to default's limits moves it; training-v4's (contract.TRAINING_HASH) never moves.
DEFAULT_PROMPT_HASH = "7037edaed42b880017eb658018849546540a4a8406036e68e7633cdb779a3632"
DEFAULT_PROFILE_HASH = "fcfb93777a14b4d5131e53763fbe1fdd7bcdf7f1fce97f0234931969633b443c"
TRAINING_PROFILE_HASH = "b5ffa4b69d4c260b53e740a24919f37c7c9254032b6e9e90edb016da1ad8fa59"
CONTEXT = "first line\nsecond line\nthird\nfourth\n"
NUL = bytes([0])


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    (h / "profiles").mkdir(parents=True)
    return h


@pytest.fixture
def work(tmp_path: Path) -> Path:
    w = tmp_path / "candidates"
    w.mkdir()
    return w


def fenced(code: str) -> dict:
    return {"text": f"Next.\n```python\n{code}\n```"}


def roots(app: FakeApp) -> list[dict]:
    return [r for r in app.requests if r["role"] == "root"]


def observations(app: FakeApp) -> list[str]:
    return [r["messages"][-1]["content"] for r in roots(app)[1:]]


def user(home: Path, base: str, **toml: object) -> p.Profile:
    """A copy of a built-in's folder with TOML keys changed, loaded as a user profile."""
    name = f"{base}-{secrets.token_hex(3)}"
    make_profile(home / "profiles", name, base=base, toml=toml)
    return p.load_profile(name, home)


def read_spec(home: Path, profile: p.Profile, text: str = CONTEXT) -> loop.RunSpec:
    path = home / "input.txt"
    path.write_bytes(text.encode("utf-8"))
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=profile, root=dict(REF), sub=dict(REF),
        permission_mode="accept-edits", call_format="fenced", interactive=False, question="What is it?",
        inputs=[path], task=None, repo_path=None, test_hint=None, language=None, n_files=None, context=None,
        tag="t1", batch="test", log_path=home / "runs" / "test" / "runs.jsonl")


def repo_spec(home: Path, repo: Path, profile: p.Profile) -> loop.RunSpec:
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="repo", profile=profile, root=dict(REF), sub=dict(REF),
        permission_mode="accept-edits", call_format="fenced", interactive=False, question=None, inputs=[],
        task="Make parse() strip spaces.", repo_path=repo, test_hint="make check", language="go", n_files=7,
        context="CTX given", tag=None, batch="test", log_path=home / "runs" / "test" / "runs.jsonl")


class Capture:
    """A worker factory that keeps the worker it made."""

    def __init__(self) -> None:
        self.worker: Worker | None = None

    def __call__(self, **kwargs: object) -> Worker:
        self.worker = Worker(**kwargs)
        return self.worker


def play(spec: loop.RunSpec, app: FakeApp, home: Path, factory=Worker) -> dict:
    return run(loop.run(spec, app, home=home, worker_factory=factory), TIMEOUT)


# ---------------------------------------------------------------------------------------------- the texts object


def test_each_profile_has_its_contracts_texts(home: Path) -> None:
    default, training = p.load_profile("default", home), p.load_profile("training-v4", home)
    assert (default.contract, training.contract) == ("rlmh-1", "v4")
    assert default.texts is rlmhcontract.RLMH1 and training.texts is rlmhcontract.V4
    assert rlmhcontract.TEXTS == {"v4": rlmhcontract.V4, "rlmh-1": rlmhcontract.RLMH1}
    assert rlmhcontract.V4.contract_hash == contract.prompt_hash(contract.PROMPTS_V4) == contract.TRAINING_HASH
    assert rlmhcontract.RLMH1.contract_hash == rlmhcontract.contract_hash() == contract.prompt_hash(rlmhcontract.PROMPTS)
    assert rlmhcontract.RLMH1.contract_hash != contract.TRAINING_HASH
    # every text field of the two differs: nothing of prompt v4 leaks into rlmh-1
    limits = contract.READ_LIMITS_V4
    v4, mine = rlmhcontract.V4, rlmhcontract.RLMH1
    assert v4.first_user_message("Q", CONTEXT, limits) != mine.first_user_message("Q", CONTEXT, limits)
    assert v4.edit_first_message("T", language="go", n_files=3, test_hint="t", limits=limits) != \
        mine.edit_first_message("T", language="go", n_files=3, test_hint="t", limits=limits)
    assert v4.cell_messages(limits, True).timeout != mine.cell_messages(limits, True).timeout
    assert v4.cell_messages(limits, False).crash != mine.cell_messages(limits, False).crash
    assert v4.no_code_error() != mine.no_code_error()
    assert v4.pace_message(5, 10, False) != mine.pace_message(5, 10, False)
    assert v4.observation("x", 1, None, 3, 4, 100) != mine.observation("x", 1, None, 3, 4, 100)
    assert v4.truncated(5) == "\n[... 5 more characters truncated]" != mine.truncated(5)
    assert v4.oversize_message(9, 8) != mine.oversize_message(9, 8)
    assert v4.budget_exhausted_message(3) == "sub-call budget exhausted (3 total)" != mine.budget_exhausted_message(3)
    # the same pacing rule in both
    for left, edited in ((5, False), (6, False), (5, True), (4, True)):
        assert (v4.pace_message(left, 10, edited) is None) == (mine.pace_message(left, 10, edited) is None)


# ---------------------------------------------------------------------------------------------- runs


def test_read_run_under_rlmh1(home: Path) -> None:
    profile = user(home, "default", **{"read.max_turns": 3, "read.output_max_chars": 100})
    assert profile.contract == "rlmh-1"
    app = FakeApp(script={"root": [fenced("print('x' * 300, end='')"), {"text": "No code here."},
                                   fenced("submit('x')")]})
    record = play(read_spec(home, profile), app, home)
    first = roots(app)[0]["messages"]
    limits = profile.read.limits
    shell = workspace.find_shell().name
    assert first[0] == {"role": "system", "content": profile.system_prompt(shell)}
    assert first[0]["content"].startswith(profile.system.split("{shell}")[0]) and contract.SYSTEM_PROMPT_V4 not in first[0]["content"]
    assert "{shell}" not in first[0]["content"] and f"runs `{shell}` on this machine" in first[0]["content"]
    assert first[1]["content"] == rlmhcontract.first_user_message("What is it?", CONTEXT, limits) == (
        "Question: What is it?\n\n`context` holds 36 characters in 4 lines. Its first 3 lines are:\n"
        "first line\nsecond line\nthird\n\nYour budget: 3 turns and 80 sub-calls.")
    obs = observations(app)
    assert obs[0] == ("Output:\n" + "x" * 100 + "\n[200 more characters not shown: print less, or keep it in a variable "
                      "and print the part you need]\n[2 turns and 80 sub-calls left]")
    assert obs[1] == ("Output: (nothing printed)\nError:\n" + rlmhcontract.NO_CODE_ERROR
                      + "\n[1 turns and 80 sub-calls left]\nYour next turn is your last: it must call submit() with "
                      "your best answer.")
    assert app.sent("run.cell")[0]["output"] == "x" * 100 + rlmhcontract.truncated(200)
    assert not any("REPL output" in text or "turns left" in text for text in obs)
    # the record and run.started name the run's own contract
    assert (record["contract"], record["contract_hash"]) == ("rlmh-1", rlmhcontract.contract_hash())
    assert app.sent("run.started")[0]["contract_hash"] == rlmhcontract.contract_hash()
    assert record["prompt_hash"] == profile.prompt_hash() and record["answer"] == "x"


def test_read_run_under_v4_is_unchanged(home: Path) -> None:
    profile = user(home, "training-v4", **{"read.max_turns": 3, "read.output_max_chars": 100})
    app = FakeApp(script={"root": [fenced("print('x' * 300, end='')"), {"text": "No code here."},
                                   fenced("submit('x')")]})
    record = play(read_spec(home, profile), app, home)
    first = roots(app)[0]["messages"]
    assert first[0]["content"] == contract.SYSTEM_PROMPT_V4
    assert first[1]["content"] == contract.first_user_message("What is it?", CONTEXT, profile.read.limits)
    obs = observations(app)
    assert obs[0] == "REPL output:\n" + "x" * 100 + "\n[... 200 more characters truncated]\n(2 turns left, 80 sub-calls left)"
    assert obs[1] == ("REPL output: (nothing printed)\nError:\n" + contract.NO_CODE_BLOCK_ERROR_V3
                      + "\n(1 turns left, 80 sub-calls left)\n" + contract.OBS_LAST_TURN)
    assert (record["contract"], record["contract_hash"]) == ("v4", contract.TRAINING_HASH)
    assert app.sent("run.started")[0]["contract_hash"] == contract.TRAINING_HASH


def test_timeout_note_under_rlmh1(home: Path) -> None:
    profile = user(home, "default", **{"read.cell_timeout_s": 1})
    capture = Capture()
    app = FakeApp(script={"root": [fenced("while True:\n    pass"), fenced("submit(1)")]})
    record = play(read_spec(home, profile), app, home, capture)
    assert capture.worker.messages == rlmhcontract.cell_messages(profile.read.limits, False)
    note = ("The cell passed its 1-second compute limit and was stopped. The REPL restarted, so every variable is "
            "gone; `context` and your sub-call budget are as they were.")
    assert record["turns"][0]["error"] == note and record["turns"][0]["restarted"] is True
    assert observations(app)[0].startswith("Output: (nothing printed)\nError:\n" + note + "\n[")


@needs_git
def test_repo_run_under_rlmh1(home: Path, git_repo: Path) -> None:
    profile = user(home, "default", **{"repo.max_turns": 10})
    capture = Capture()
    app = FakeApp(script={"root": [fenced("print(1)")] * 10})
    spec = repo_spec(home, git_repo, profile)
    record = play(spec, app, home, capture)
    limits = profile.repo.limits
    assert roots(app)[0]["messages"][1]["content"] == rlmhcontract.edit_first_message(
        "Make parse() strip spaces.", language="go", n_files=7, test_hint="make check", limits=limits)
    assert "/work/repo" not in roots(app)[0]["messages"][1]["content"]
    assert capture.worker.messages == rlmhcontract.cell_messages(limits, True)
    assert capture.worker.messages.timeout.endswith(" Your changes to the repository are kept.")
    obs = observations(app)
    assert [9 - i for i, text in enumerate(obs) if rlmhcontract.OBS_PACE_EDIT in text] == [5, 4, 3, 2]
    assert not any(contract.OBS_PACE_EDIT in text for text in obs)
    assert record["contract"] == "rlmh-1"


def test_rlm_child_under_rlmh1(home: Path) -> None:
    profile = p.load_profile("default", home)
    app = FakeApp(script={"root": [fenced("print(rlm('Count the a', context='aaa', tools='none'))"),
                                   fenced("submit(1)")],
                          "children": {"1": [fenced("print(len(context))"), fenced("submit(3)")]}})
    record = play(read_spec(home, profile), app, home)
    kids = [r for r in app.requests if r.get("child")]
    assert len(kids) == 2
    messages = kids[0]["messages"]
    assert messages[0]["content"] == profile.system_prompt(workspace.find_shell().name)
    limits = dataclasses.replace(profile.read.limits, max_turns=profile.rlm.max_turns)
    assert messages[1]["content"] == (rlmhcontract.first_user_message("Count the a", "aaa", limits)
                                      + childmod.CONTEXT_NOTE.format(n=3))
    assert kids[1]["messages"][-1]["content"].startswith(f"Output:\n3\n\n[{profile.rlm.max_turns - 1} turns and ")
    assert record["answer"] == 1


def bridge_for(tmp_path: Path, profile: p.Profile, **limits: object) -> tuple[Bridge, StubApp]:
    app = StubApp(complete=echo)
    if limits:
        mode = dataclasses.replace(profile.read, limits=dataclasses.replace(profile.read.limits, **limits))
        profile = dataclasses.replace(profile, read=mode)
    permissions = Permissions(run_id=RUN_ID, mode="default", workspace=tmp_path / "repo", scratch=tmp_path / "scratch",
                              repo_mode=False, interactive=True, app=app)
    return Bridge(run_id=RUN_ID, app=app, profile=profile, mode="read", sub_ref=dict(SUB), permissions=permissions), app


def test_bridge_errors_follow_the_contract(home: Path, tmp_path: Path) -> None:
    for name, texts in (("default", rlmhcontract.RLMH1), ("training-v4", rlmhcontract.V4)):
        profile = p.load_profile(name, home)
        bridge, _ = bridge_for(tmp_path, profile)
        assert handle(bridge, batch_request(["y" * 60_001])) == {"error": texts.oversize_message(60_001, 60_000)}
        bridge, _ = bridge_for(tmp_path, profile, max_subcalls=1)
        assert "outputs" in handle(bridge, batch_request(["a"]))
        assert handle(bridge, batch_request(["b"])) == {"error": texts.budget_exhausted_message(1)}
    assert rlmhcontract.budget_exhausted_message(1) == "no sub-calls left: all 1 are spent"
    assert rlmhcontract.oversize_message(60_001, 60_000).startswith(
        "this sub-call's prompt is 60,001 characters, over the 60,000 one sub-call reads")


# ---------------------------------------------------------------------------------------------- loading


def folder_with(home: Path, name: str, toml: str, files: dict[str, bytes] | None = None) -> Path:
    folder = home / "profiles" / name
    folder.mkdir(parents=True)
    (folder / "profile.toml").write_bytes(toml.encode("utf-8"))
    for rel, data in (files or {}).items():
        (folder / rel).write_bytes(data)
    return folder


@pytest.mark.parametrize(("toml", "files", "match"), [
    ('contract = "v4"\nsystem = "system.md"\n', {"system.md": b"Hi.\n"}, "system needs contract = \"rlmh-1\""),
    ('contract = "rlmh-1"\n', {}, "contract 'rlmh-1' needs system = \"system.md\""),
    ('contract = "rlmh-1"\nsystem = "system.md"\n', {}, "system file 'system.md' not found"),
    ('contract = "rlmh-1"\nsystem = ""\n', {}, "system must name the profile's system file"),
    ('contract = "rlmh-1"\nsystem = "../system.md"\n', {}, "must be a file inside the profile folder"),
    ('contract = "rlmh-1"\nsystem = 3\n', {}, "system must be a file name"),
    ('contract = "rlmh-1"\nsystem = "system.md"\n', {"system.md": b"\n  \n"}, "is empty"),
    ('contract = "rlmh-1"\nsystem = "system.md"\n', {"system.md": b"caf\xe9\n"}, "is not UTF-8"),
    ('contract = "rlmh-2"\nsystem = "system.md"\n', {"system.md": b"Hi.\n"}, "contract must be 'v4' or 'rlmh-1'"),
    ("contract = 4\n", {}, "contract must be 'v4' or 'rlmh-1'"),
])
def test_contract_and_system_load_errors(home: Path, toml: str, files: dict[str, bytes], match: str) -> None:
    folder_with(home, "bad", toml, files)
    with pytest.raises(p.ProfileError) as err:
        p.load_profile("bad", home)
    assert "'bad'" in str(err.value) and match in str(err.value), str(err.value)


def test_removing_system_md_is_a_load_error(home: Path, work: Path) -> None:
    folder = make_profile(work, "nosystem", files={"system.md": None})
    with pytest.raises(p.ProfileError, match="system file 'system.md' not found"):
        p._load("nosystem", folder, "user")
    result = profile_check(folder, "default", False, home)
    assert result["ok"] is False and result["prompt_hash"] is None
    assert result["errors"] == ["profile 'nosystem': system file 'system.md' not found"]


def test_a_v4_user_profile_keeps_loading(home: Path) -> None:
    """A copy of the old default (prompt v4 plus its guidance, as `v1-baseline` is) loads and hashes as before."""
    guidance = b"Old guidance for {shell}.\n"
    toml = 'contract = "v4"\nguidance = "guidance.md"\n'
    folder_with(home, "old", toml, {"guidance.md": guidance})
    old = p.load_profile("old", home)
    assert (old.contract, old.system, old.texts) == ("v4", None, rlmhcontract.V4)
    assert old.system_prompt("sh") == contract.SYSTEM_PROMPT_V4 + "\n\nOld guidance for sh."
    assert old.profile_hash() == hashlib.sha256(toml.encode() + NUL + guidance).hexdigest()
    texts = dict(contract.PROMPTS_V4, system=contract.SYSTEM_PROMPT_V4 + "\n\nOld guidance for {shell}.")
    assert old.prompt_hash() == contract.prompt_hash(texts)
    training = p.load_profile("training-v4", home)
    assert (training.prompt_hash(), training.profile_hash()) == (contract.TRAINING_HASH, TRAINING_PROFILE_HASH)


# ---------------------------------------------------------------------------------------------- hashes


def test_default_hashes_pinned(home: Path) -> None:
    default = p.load_profile("default", home)
    assert default.prompt_hash() == DEFAULT_PROMPT_HASH
    assert default.profile_hash() == DEFAULT_PROFILE_HASH


def test_prompt_hash_rule(home: Path) -> None:
    default = p.load_profile("default", home)
    system = default.system_prompt("{shell}")
    assert "{shell}" in system and system == default.system + "\n\n" + default.guidance
    texts = dict(rlmhcontract.PROMPTS, system=system,
                 limits=json.dumps({"read": default.read.limits.as_dict(), "edit": default.repo.limits.as_dict()},
                                   sort_keys=True))
    assert default.prompt_hash() == contract.prompt_hash(texts)
    assert set(texts) == {"contract", "first_user", "observation", "code", "system", "limits"}
    filled = default.system_prompt("Git Bash")
    assert "{shell}" not in filled and filled == system.replace("{shell}", "Git Bash")
    assert default.prompt_hash() == DEFAULT_PROMPT_HASH  # filling {shell} never moves it


def test_profile_hash_rule(home: Path, work: Path) -> None:
    folder = make_profile(work, "copy")
    copy = p._load("copy", folder, "user")
    toml, guidance, system = ((folder / f).read_bytes() for f in ("profile.toml", "guidance.md", "system.md"))
    expected = hashlib.sha256(toml + NUL + guidance + NUL + b"system.md" + NUL + system).hexdigest()
    assert copy.profile_hash() == expected == DEFAULT_PROFILE_HASH
    assert copy.files == {}  # system.md is hashed, never copied into a run as a script is
    # sorted with the other files by path: skills/ before system.md
    make_profile(work, "copy", files={f"skills/{SKILL}/SKILL.md": skill_md(SKILL)}, add_guidance=f"\nskill('{SKILL}')")
    skilled = p._load("copy", folder, "user")
    toml, guidance = (folder / "profile.toml").read_bytes(), (folder / "guidance.md").read_bytes()
    skill = (folder / "skills" / SKILL / "SKILL.md").read_bytes()
    expected = hashlib.sha256(toml + NUL + guidance + NUL + f"skills/{SKILL}/SKILL.md".encode() + NUL + skill
                              + NUL + b"system.md" + NUL + system).hexdigest()
    assert skilled.profile_hash() == expected
    # an edit to system.md moves both hashes; CRLF doesn't
    make_profile(work, "copy", files={"system.md": system + b"One more line.\n"})
    edited = p._load("copy", folder, "user")
    assert edited.profile_hash() != DEFAULT_PROFILE_HASH and edited.prompt_hash() != DEFAULT_PROMPT_HASH
    make_profile(work, "copy", files={"system.md": system.replace(b"\n", b"\r\n")})
    crlf = p._load("copy", folder, "user")
    assert (crlf.profile_hash(), crlf.prompt_hash()) == (DEFAULT_PROFILE_HASH, DEFAULT_PROMPT_HASH)


# ---------------------------------------------------------------------------------------------- profile.check


def errors_of(folder: Path, home: Path, base: str | None = "default") -> list[str]:
    result = profile_check(folder, base, False, home)
    assert result["ok"] is (not result["errors"])
    return result["errors"]


def test_system_md_bounds(home: Path, work: Path) -> None:
    assert p.SYSTEM_MAX_CHARS == 16_000
    system = (p.BUILTIN_DIR / "default" / "system.md").read_text(encoding="utf-8")
    assert len(system.strip()) <= p.SYSTEM_MAX_CHARS
    assert errors_of(make_profile(work, "same"), home) == []
    ok = "x" * p.SYSTEM_MAX_CHARS + "\n"
    assert errors_of(make_profile(work, "edge", files={"system.md": ok}), home) == []
    cases = [
        ("x" * (p.SYSTEM_MAX_CHARS + 1) + "\n", "system.md is 16,001 characters: must be at most 16,000"),
        ("Hello.\r\nWorld.\r\n", "system.md has a CR: line ends must be LF"),
        ("Hello." + NUL.decode() + "\n", "system.md holds a NUL"),
        ("Run {shell} and {model}.\n", "system.md holds {model}: {shell} is the only placeholder"),
    ]
    for i, (text, expected) in enumerate(cases):
        assert errors_of(make_profile(work, f"case{i}", files={"system.md": text}), home) == [expected]
    # not UTF-8: the profile doesn't load at all
    result = profile_check(make_profile(work, "latin", files={"system.md": b"caf\xe9\n"}), "default", False, home)
    assert result["ok"] is False and "system file 'system.md' is not UTF-8" in result["errors"][0]


def test_changed_lists_system(home: Path, work: Path) -> None:
    system = (p.BUILTIN_DIR / "default" / "system.md").read_text(encoding="utf-8")
    folder = make_profile(work, "edited", files={"system.md": system + "Be brief.\n"})
    assert profile_check(folder, "default", False, home)["changed"] == ["system"]
    folder = make_profile(work, "both", toml={"read.max_turns": 60}, add_guidance="\nMore.\n",
                          files={"system.md": system + "Be brief.\n", f"skills/{SKILL}/SKILL.md": skill_md(SKILL)})
    (folder / "guidance.md").write_bytes((folder / "guidance.md").read_bytes() + f"skill('{SKILL}')\n".encode())
    result = profile_check(folder, "default", False, home)
    assert result["changed"] == ["read.max_turns", "guidance", "system", f"skills/{SKILL}/SKILL.md"]
    assert result["errors"] == []
    base, candidate = p.load_profile("default", home), p._load("both", folder, "user")
    assert p.changed(base, candidate) == result["changed"]
    assert p.changed(base, base) == []


def test_contract_is_frozen(home: Path, work: Path) -> None:
    text = (p.BUILTIN_DIR / "default" / "profile.toml").read_text(encoding="utf-8")
    lines = [line for line in text.split("\n") if not line.startswith("system =")]
    v4 = edit_toml("\n".join(lines), {"contract": "v4"})
    folder = make_profile(work, "switched", raw_toml=v4, files={"system.md": None})
    candidate = p._load("switched", folder, "user")
    assert candidate.contract == "v4" and candidate.system is None
    assert "contract is frozen" in errors_of(folder, home)
    # a v4 folder may not hold a system.md at all
    folder = make_profile(work, "stray", raw_toml=v4)
    assert "system.md is not a file a profile may hold" in errors_of(folder, home, base=None)


def test_skills_and_scripts_named_in_system_md(home: Path, work: Path) -> None:
    system = (p.BUILTIN_DIR / "default" / "system.md").read_text(encoding="utf-8")
    trigger = f"- For a fixture task, call skill(\"{SKILL}\") first.\n"
    folder = make_profile(work, "insystem", files={"system.md": system + trigger,
                                                   f"skills/{SKILL}/SKILL.md": skill_md(SKILL)})
    assert errors_of(folder, home) == []  # system.md holds the trigger line, so guidance.md needn't
    folder = make_profile(work, "nowhere", files={f"skills/{SKILL}/SKILL.md": skill_md(SKILL)})
    assert errors_of(folder, home) == [f"skill '{SKILL}' is not named in guidance.md or system.md (its trigger line)"]
    folder = make_profile(work, "script", files={"system.md": system + "- Import scripts/helper_tool.py.\n"})
    assert errors_of(folder, home) == ["system.md names scripts/helper_tool.py, which the profile does not hold"]
