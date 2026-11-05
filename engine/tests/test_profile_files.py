"""KV cache: none

v1 step 6, D-233: a profile's skills (`skills/<name>/SKILL.md`) and scripts (`scripts/<name>.py`): loading, the hash
rule of v1 architecture §7.2 (built-in hashes pinned as they were before the step), and the run: the scripts' copy in
the scratch folder, `skill()` and `import <script>` in a real worker, for the run and an rlm() child, and nothing of
either under `training-v4`.
"""

from __future__ import annotations

import json
import secrets
import shutil
from pathlib import Path

import pytest

from conftest import run
from fakeapp import FakeApp
from rlm_engine import contract, loop
from rlm_engine import profiles as p
from rlm_engine.worker.manager import Worker
from tuneprofiles import SCRIPT, SCRIPT_SOURCE, SKILL, TRIGGER, make_profile, skill_md, with_skill_and_script

REF = {"provider": "fake", "model": "scripted", "thinking": None}
TIMEOUT = 120

# The built-ins' hashes. training-v4's are those from before step 6 (computed from this checkout before any step 6
# change) and must never move. default's moved once, when it took rlmh's own contract, rlmh-1, and its system.md
# (D-256); before that they were 46df1b52… (profile) and 0345b73d… (prompt), which a v4 copy of the old default keeps.
DEFAULT_PROFILE_HASH = "fcfb93777a14b4d5131e53763fbe1fdd7bcdf7f1fce97f0234931969633b443c"
DEFAULT_PROMPT_HASH = "7037edaed42b880017eb658018849546540a4a8406036e68e7633cdb779a3632"
TRAINING_PROFILE_HASH = "b5ffa4b69d4c260b53e740a24919f37c7c9254032b6e9e90edb016da1ad8fa59"
TRAINING_PROMPT_HASH = "a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6"


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    (h / "profiles").mkdir(parents=True)
    return h


def fenced(code: str) -> dict:
    return {"text": f"Next.\n```python\n{code}\n```"}


# ---------------------------------------------------------------------------------------------- loading and hashing


def test_builtin_hashes_unchanged(home: Path) -> None:
    default, training = p.load_profile("default", home), p.load_profile("training-v4", home)
    assert (default.profile_hash(), default.prompt_hash()) == (DEFAULT_PROFILE_HASH, DEFAULT_PROMPT_HASH)
    assert (training.profile_hash(), training.prompt_hash()) == (TRAINING_PROFILE_HASH, TRAINING_PROMPT_HASH)
    assert TRAINING_PROMPT_HASH == contract.TRAINING_HASH
    assert default.files == {} and default.skills == {} and default.scripts == {} and training.files == {}
    make_profile(home / "profiles", "plain-copy")
    copy = p.load_profile("plain-copy", home)
    assert (copy.profile_hash(), copy.prompt_hash()) == (DEFAULT_PROFILE_HASH, DEFAULT_PROMPT_HASH)


def test_skill_and_script_load(home: Path) -> None:
    folder = with_skill_and_script(home / "profiles", "mine")
    mine = p.load_profile("mine", home)
    assert mine.skills == {SKILL: p.Skill(description="How to do a fixture task.",
                                          text=f"Import {SCRIPT} and call double(x).")}
    assert mine.scripts == {SCRIPT: folder / "scripts" / f"{SCRIPT}.py"}
    assert sorted(mine.files) == [f"scripts/{SCRIPT}.py", f"skills/{SKILL}/SKILL.md"]
    assert mine.script_files() == {f"{SCRIPT}.py": SCRIPT_SOURCE.encode()}
    prompt = mine.system_prompt()
    assert prompt.startswith(p.load_profile("default", home).system_prompt()) and prompt.endswith(TRIGGER.strip())
    assert "call double(x)" not in prompt  # the skill's text is never in the prompt

    # §7.2's hash rule, by hand
    import hashlib
    blob = ((folder / "profile.toml").read_bytes() + b"\x00" + (folder / "guidance.md").read_bytes()
            + b"\x00" + f"scripts/{SCRIPT}.py".encode() + b"\x00" + SCRIPT_SOURCE.encode()
            + b"\x00" + f"skills/{SKILL}/SKILL.md".encode() + b"\x00"
            + (folder / "skills" / SKILL / "SKILL.md").read_bytes()
            + b"\x00" + b"system.md" + b"\x00" + (folder / "system.md").read_bytes())  # rlmh-1's system file (D-256)
    assert mine.profile_hash() == hashlib.sha256(blob).hexdigest()

    before = mine.profile_hash()
    (folder / "scripts" / f"{SCRIPT}.py").write_bytes(SCRIPT_SOURCE.encode() + b"# more\n")
    after_script = p.load_profile("mine", home).profile_hash()
    (folder / "skills" / SKILL / "SKILL.md").write_bytes(skill_md(SKILL, body="Changed.").encode())
    after_skill = p.load_profile("mine", home).profile_hash()
    assert len({before, after_script, after_skill}) == 3


def test_hash_ignores_write_order(home: Path) -> None:
    files = {f"skills/{SKILL}/SKILL.md": skill_md(SKILL), f"scripts/{SCRIPT}.py": SCRIPT_SOURCE,
             "scripts/another.py": "X = 1\n"}
    make_profile(home / "profiles", "forward", add_guidance=TRIGGER, files=files)
    make_profile(home / "profiles", "backward", add_guidance=TRIGGER, files=dict(reversed(list(files.items()))))
    assert p.load_profile("forward", home).profile_hash() == p.load_profile("backward", home).profile_hash()


@pytest.mark.parametrize(("files", "message"), [
    ({f"skills/{SKILL}/SKILL.md": skill_md(SKILL)}, "skills/ and scripts/ need agent_api = true"),
    ({f"scripts/{SCRIPT}.py": SCRIPT_SOURCE}, "skills/ and scripts/ need agent_api = true"),
])
def test_no_agent_api_no_skills(files: dict, message: str, home: Path) -> None:
    make_profile(home / "profiles", "bare", base="training-v4", files=files)
    with pytest.raises(p.ProfileError, match=message):
        p.load_profile("bare", home)


@pytest.mark.parametrize(("text", "message"), [
    (skill_md("other-name"), "front matter must say name: fixture-recipe"),
    ("No front matter here.\n", "has no front matter"),
    ("---\nname: fixture-recipe\nno colon\n---\n", "is not key: value"),
    (b"---\nname: fixture-recipe\n---\n\xff\n", "is not UTF-8"),
])
def test_bad_skill_files(text: str | bytes, message: str, home: Path) -> None:
    with_skill_and_script(home / "profiles", "bad", files={f"skills/{SKILL}/SKILL.md": text})
    with pytest.raises(p.ProfileError, match=message):
        p.load_profile("bad", home)


def test_script_not_utf8(home: Path) -> None:
    with_skill_and_script(home / "profiles", "bad", files={f"scripts/{SCRIPT}.py": b"X = '\xff'\n"})
    with pytest.raises(p.ProfileError, match="is not UTF-8"):
        p.load_profile("bad", home)


# ---------------------------------------------------------------------------------------------- the run


def read_spec(home: Path, profile: str, text: str = "some input\n") -> loop.RunSpec:
    path = home / "input.txt"
    path.write_bytes(text.encode("utf-8"))
    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode="read", profile=p.load_profile(profile, home), root=dict(REF),
        sub=dict(REF), permission_mode="accept-edits", call_format="fenced", interactive=False,
        question="What is it?", inputs=[path], task=None, repo_path=None, test_hint=None, language=None,
        n_files=None, context=None, tag=None, batch="test", log_path=home / "runs" / "test" / "runs.jsonl")


class Recording:
    """A worker factory that keeps every worker it made, so a test can read each one's init message."""

    def __init__(self) -> None:
        self.workers: list[Worker] = []

    def __call__(self, **kwargs: object) -> Worker:
        worker = Worker(**kwargs)  # type: ignore[arg-type]
        self.workers.append(worker)
        return worker


def play(home: Path, profile: str, cells: list[str], **script: object) -> tuple[dict, FakeApp, Recording]:
    app = FakeApp(script={"root": [fenced(c) for c in cells], **script})
    factory = Recording()
    record = run(loop.run(read_spec(home, profile), app, home=home, worker_factory=factory), TIMEOUT)
    return record, app, factory


SUBPROCESS_SCRIPT = ("import subprocess\nimport sys\n\n\ndef spawn():\n"
                     "    return subprocess.run([sys.executable, '-c', 'print(1)'], capture_output=True).stdout\n")


def test_skill_and_scripts_in_the_worker(home: Path) -> None:
    folder = with_skill_and_script(home / "profiles", "mine", files={"scripts/spawner.py": SUBPROCESS_SCRIPT})
    cells = [
        f"skill('{SKILL}')",
        "skill()",
        "skill('nope')",
        f"import {SCRIPT}\nprint({SCRIPT}.double(21), {SCRIPT}.__file__.replace(chr(92), '/'))",
        "import spawner\nspawner.spawn()",
        f"open({SCRIPT}.__file__, 'w').write('broken = True\\n')\nprint('written')",
        "print(sorted(n for n in ('skill', 'scan', 'rlm') if n in globals()))",
        "submit('done')",
    ]
    record, _, factory = play(home, "mine", cells)
    out = [t["stdout"] for t in record["turns"]]
    assert out[0] == f"Import {SCRIPT} and call double(x).\n"
    assert out[1] == f"{SKILL}: How to do a fixture task.\n"
    assert out[2] == f"no skill named 'nope'; the skills are:\n{SKILL}: How to do a fixture task.\n"
    value, path = out[3].split()
    assert value == "42"
    scratch = Path(home / "scratch" / record["run_id"]).as_posix()
    assert path.lower() == f"{scratch}/scripts/{SCRIPT}.py".lower()
    # a script runs under the cell's audit hooks: a subprocess asks, and a run nobody watches denies it (D-15)
    assert "Permission denied (no one can approve this in this run" in record["turns"][4]["error"]
    assert [x for x in record["permissions"] if x["kind"] == "shell" and not x["allowed"]]
    assert out[5] == "written\n" and record["turns"][5]["error"] is None
    assert (folder / "scripts" / f"{SCRIPT}.py").read_text(encoding="utf-8") == SCRIPT_SOURCE  # the copy changed
    assert out[6] == "['rlm', 'scan', 'skill']\n"
    assert record["answer"] == "done" and record["profile_hash"] == p.load_profile("mine", home).profile_hash()
    init = factory.workers[0]._init_message()
    assert init["skills"] == {SKILL: {"description": "How to do a fixture task.",
                                      "text": f"Import {SCRIPT} and call double(x)."}}
    assert init["scripts_dir"] == str(home / "scratch" / record["run_id"] / "scripts")
    assert "agents" not in init
    assert not (home / "scratch" / record["run_id"]).exists()  # removed with the run


def test_an_rlm_child_has_them_too(home: Path) -> None:
    with_skill_and_script(home / "profiles", "mine")
    child = [fenced(f"skill('{SKILL}')\nimport {SCRIPT}\nsubmit({SCRIPT}.double(4))")]
    record, _, factory = play(home, "mine", ["print(rlm('Double four.', tools='none'))", "submit('ok')"],
                              children={"1": child})
    assert record["turns"][0]["stdout"] == "8\n"
    [kid] = record["children"]
    assert kid["turns"][0]["stdout"] == f"Import {SCRIPT} and call double(x).\n"
    run_init, child_init = (w._init_message() for w in factory.workers)
    for key in ("skills", "scripts_dir"):
        assert child_init[key] == run_init[key]


def test_default_and_training_unchanged(home: Path) -> None:
    for profile, has_agent_api in (("training-v4", False), ("default", True)):
        record, _, factory = play(home, profile, ["print('skill' in globals(), 'scan' in globals())", "submit(1)"])
        assert record["turns"][0]["stdout"] == f"False {has_agent_api}\n"
        init = factory.workers[0]._init_message()
        assert not {"skills", "scripts_dir", "agents"} & set(init)
        if not has_agent_api:  # training-v4: training's init, byte for byte: no agent_api fields at all
            assert "agent_api" not in init and "input_files" not in init
        assert record["prompt_hash"] == (TRAINING_PROMPT_HASH if not has_agent_api else DEFAULT_PROMPT_HASH)


def test_scripts_copy_is_the_loaded_bytes(home: Path, tmp_path: Path) -> None:
    """The run copies the bytes the profile loaded (and hashed), not whatever the folder holds later."""
    folder = with_skill_and_script(home / "profiles", "mine")
    spec = read_spec(home, "mine")
    (folder / "scripts" / f"{SCRIPT}.py").write_bytes(b"double = None\n")
    record = run(loop.run(spec, FakeApp(script={"root": [
        fenced(f"import {SCRIPT}\nprint({SCRIPT}.double(1))"), fenced("submit(1)")]}),
        home=home, worker_factory=Worker), TIMEOUT)
    assert record["turns"][0]["stdout"] == "2\n"
    shutil.rmtree(folder)
    json.dumps(record)
