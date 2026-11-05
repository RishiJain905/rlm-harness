"""KV cache: none

v1 step 6: `profile.check` and the rules behind it (`profiles.TUNABLE`, `FROZEN`, `check_tunable`, `check_files`,
`changed`; v1 architecture §3.1 and §7.2). Most cases call `service.profile_check` directly; the wire cases (the
params' -32602 errors, `engine.info`'s `path`) go through a real Link as test_service does. The drift test keeps the
editors' tables in app/src/tune/prompts/surface.md and surface-gated.md equal to these constants (D-207).
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from conftest import finish, pipes, run
from fakeapp import FakeApp
from rlm_engine import profiles as p
from rlm_engine.link import INVALID_PARAMS, Link
from rlm_engine.service import Engine, profile_check
from tuneprofiles import SCRIPT, SKILL, SCRIPT_SOURCE, TRIGGER, agent_md, make_profile, skill_md, with_skill_and_script


@pytest.fixture
def home(tmp_path: Path) -> Path:
    h = tmp_path / "home"
    h.mkdir()
    return h


@pytest.fixture
def work(tmp_path: Path) -> Path:
    w = tmp_path / "candidates"
    w.mkdir()
    return w


def check(folder: Path, home: Path, base: str | None = "default", gated: bool = False) -> dict:
    return profile_check(folder, base, gated, home)


def errors_of(folder: Path, home: Path, **kwargs: object) -> list[str]:
    result = check(folder, home, **kwargs)  # type: ignore[arg-type]
    assert result["ok"] is (not result["errors"])
    return result["errors"]


# ---------------------------------------------------------------------------------------------- the basics


def test_default_against_itself(home: Path) -> None:
    result = check(p.BUILTIN_DIR / "default", home)
    default = p.load_profile("default", home)
    assert result == {"ok": True, "errors": [], "prompt_hash": default.prompt_hash(),
                      "profile_hash": default.profile_hash(), "changed": []}
    plain = check(p.BUILTIN_DIR / "default", home, base=None)
    assert plain["ok"] and plain["changed"] == []


def test_tables() -> None:
    assert not p.GATED  # D-234: off in the committed code
    assert not any(k.startswith(("agents", "nudges")) for k in p.TUNABLE)
    assert "read.submit_check" in p.TUNABLE and "read.pace_nudge" not in p.TUNABLE  # D-252; pace_nudge is [repo]'s
    assert p.TUNABLE["repo.subcall_thinking"] == ("off", "low", "medium", "high")
    assert not set(p.TUNABLE) & set(p.FROZEN)
    every = set(p.effective(p.load_profile("default", Path("/nonexistent"))))
    assert set(p.TUNABLE) <= every and set(p.FROZEN) <= every
    assert p.TUNABLE_GATED == {"agents": {"count": 8, "chars": 4000},
                               "nudges": {"count": 8, "pattern": 200, "turns": (1, 200), "chars": (1000, 1_000_000),
                                          "hint": 400}}
    assert (p.MAX_SKILLS, p.SKILL_MAX_CHARS, p.MAX_SCRIPTS, p.SCRIPT_MAX_CHARS) == (16, 8000, 16, 16000)


def _edges(bound: object) -> tuple[list[object], list[object]]:
    """The values at a bound that pass, and the values just past it that fail."""
    if bound is bool:
        return [True, False], []
    assert isinstance(bound, tuple)
    if isinstance(bound[0], str):
        return list(bound), ["xhigh", "minimal"]
    lo, hi = bound
    step = 1 if isinstance(lo, int) else 0.01
    return [lo, hi], [lo - step, round(hi + step, 6)]


@pytest.mark.parametrize("key", sorted(p.TUNABLE))
def test_tunable_bounds(key: str, home: Path, work: Path) -> None:
    ok, past = _edges(p.TUNABLE[key])
    for i, value in enumerate(ok):
        folder = make_profile(work, f"ok-{i}", toml={key: value})
        assert errors_of(folder, home) == [], (key, value)
    for i, value in enumerate(past):
        folder = make_profile(work, f"past-{i}", toml={key: value})
        result = check(folder, home)
        assert not result["ok"], (key, value)
        loaded = result["profile_hash"] is not None
        if loaded:  # check_tunable's own line
            bound = p.TUNABLE[key]
            if isinstance(bound, tuple) and isinstance(bound[0], str):
                assert result["errors"] == [f"{key} = \"{value}\": must be one of off, low, medium, high"]
            else:
                assert result["errors"] == [f"{key} = {value!r}: must be {bound[0]} to {bound[1]}"]
        else:  # the loader's own bound came first: still an error naming the key
            assert key.split(".")[-1] in result["errors"][0]


def test_whole_numbers_for_number_keys(home: Path, work: Path) -> None:
    """The app's editToml writes 0 and 1 as TOML integers: a float-bounded key takes them, never a bool."""
    folder = make_profile(work, "ints", toml={"root.temperature": 0, "read.submit_check": 1, "sub.temperature": 1})
    result = check(folder, home)
    assert result["ok"] and result["changed"] == ["read.submit_check", "root.temperature", "sub.temperature"]
    for key in ("root.temperature", "read.submit_check"):
        assert not check(make_profile(work, "bool", toml={key: True}), home)["ok"]
    assert p._out_of_bounds("root.temperature", True, (0.0, 1.0)) == "root.temperature = true: must be 0.0 to 1.0"


FROZEN_VALUES = {
    "contract": "v5", "cache_api": False, "agent_api": False,
    "read.root_max_tokens": 8192, "repo.root_max_tokens": 8192, "read.subcall_max_tokens": 8192,
    "repo.subcall_max_tokens": 8192, "read.output_max_chars": 4000, "repo.output_max_chars": 4000,
    "read.cell_timeout_s": 60, "repo.cell_timeout_s": 60, "read.subcall_max_chars": 50000,
    "repo.subcall_max_chars": 50000, "read.subcall_oversize": "truncate", "repo.subcall_oversize": "truncate",
    "rlm.max_depth": 0, "compaction.reserve": 1000, "compaction.summary_max_tokens": 4096,
}


@pytest.mark.parametrize("key", list(p.FROZEN))
def test_frozen_keys(key: str, home: Path, work: Path) -> None:
    result = check(make_profile(work, "frozen", toml={key: FROZEN_VALUES[key]}), home)
    assert not result["ok"]
    if result["profile_hash"] is not None:
        assert f"{key} is frozen" in result["errors"]
    else:  # contract, cache_api and agent_api: the profile no longer loads at all
        assert key.split(".")[-1] in result["errors"][0] or "[rlm]" in result["errors"][0]


def test_unlisted_keys_are_frozen(home: Path, work: Path) -> None:
    folder = make_profile(work, "cpus", toml={"read.cpus": 2.0, "read.subcall_thinking": "high", "repo.pids": 64})
    assert errors_of(folder, home) == ["read.cpus is frozen", "read.subcall_thinking is frozen", "repo.pids is frozen"]


def test_guidance_rules(home: Path, work: Path) -> None:
    long = make_profile(work, "long", guidance="x" * 12_001)
    assert errors_of(long, home) == ["guidance.md is 12,001 characters: must be at most 12,000"]
    assert errors_of(make_profile(work, "fits", guidance="x" * 12_000), home) == []
    cr = make_profile(work, "cr", add_guidance="\none line\rnext")
    assert errors_of(cr, home) == ["guidance.md has a CR: line ends must be LF"]
    crlf = make_profile(work, "crlf", add_guidance="\r\nmore")
    assert "guidance.md has a CR: line ends must be LF" in errors_of(crlf, home)
    nul = make_profile(work, "with-nul", add_guidance="\x00")  # "nul" is a device name on Windows
    assert "guidance.md holds a NUL" in errors_of(nul, home)
    changed = check(make_profile(work, "edited", add_guidance="\nOne more line."), home)
    assert changed["ok"] and changed["changed"] == ["guidance"]


def test_bad_bases_and_folders(home: Path, work: Path) -> None:
    training = check(make_profile(work, "t4", base="training-v4"), home, base="training-v4")
    assert not training["ok"] and training["errors"] == ["training-v4 is never a base"]
    broken = make_profile(work, "broken", raw_toml="contract = \n")
    result = check(broken, home)
    assert result == {"ok": False, "errors": [result["errors"][0]], "prompt_hash": None, "profile_hash": None,
                      "changed": []}
    assert "not valid TOML" in result["errors"][0]
    unknown = check(make_profile(work, "fine"), home, base="no-such-profile")
    assert not unknown["ok"] and unknown["prompt_hash"] is None and "no-such-profile" in unknown["errors"][0]
    assert not check(work / "missing", home)["ok"]
    bad_name = make_profile(work, "bad name")
    assert "invalid profile name" in check(bad_name, home)["errors"][0]


# ---------------------------------------------------------------------------------------------- on the wire


class _Served:
    def __init__(self, home: Path) -> None:
        self.pipes = pipes()
        self.link = Link(self.pipes.reader, self.pipes.writer)
        Engine(FakeApp(), home=home).register(self.link)
        self.next_id = 0

    async def call(self, method: str, params: dict) -> dict:
        self.next_id += 1
        self.pipes.peer.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params})
        return await self.pipes.peer.recv(30)


def test_on_the_wire(home: Path, work: Path) -> None:
    folder = with_skill_and_script(work, "mine")

    async def go() -> list[dict]:
        served = _Served(home)
        server = asyncio.create_task(served.link.serve())
        try:
            return [
                await served.call("profile.check", {"path": "relative/folder", "base": "default"}),
                await served.call("profile.check", {"path": str(folder), "base": 3}),
                await served.call("profile.check", {"path": str(folder), "base": "default", "gated": "yes"}),
                await served.call("profile.check", {"path": str(folder), "base": "default"}),
                await served.call("profile.check", {"path": str(folder), "base": None, "gated": False}),
                await served.call("engine.info", {}),
            ]
        finally:
            await finish(served.pipes, server)

    relative, bad_base, bad_gated, good, no_base, info = run(go(), 30)
    for answer in (relative, bad_base, bad_gated):
        assert answer["error"]["code"] == INVALID_PARAMS
    assert relative["error"]["message"] == "path must be an absolute folder path"
    assert good["result"]["ok"] and good["result"]["changed"] == [
        "guidance", f"scripts/{SCRIPT}.py", f"skills/{SKILL}/SKILL.md"]
    assert good["result"]["profile_hash"] == p._load("mine", folder, "user").profile_hash()
    assert no_base["result"] == {**good["result"], "changed": []}
    profiles = info["result"]["profiles"]
    assert all(Path(entry["path"]).is_absolute() for entry in profiles)
    assert Path(next(e for e in profiles if e["name"] == "default")["path"]) == p.BUILTIN_DIR / "default"


# ---------------------------------------------------------------------------------------------- skills and scripts


def test_skill_and_script_pass(home: Path, work: Path) -> None:
    folder = with_skill_and_script(work, "mine", files={
        "scripts/helper_two.py": "from __future__ import annotations\nimport os.path\nfrom collections import abc\n"})
    assert errors_of(folder, home) == []


def _many(prefix: str, n: int) -> str:
    return "".join(f"\nskill('{prefix}{i}')" for i in range(n))


@pytest.mark.parametrize(("files", "add", "expected"), [
    ({"skills/quiet/SKILL.md": skill_md("quiet")}, "",  # default is rlmh-1: system.md may hold the trigger too (D-256)
     "skill 'quiet' is not named in guidance.md or system.md (its trigger line)"),
    ({}, "\nSee scripts/x.py.", "guidance.md names scripts/x.py, which the profile does not have"),
    ({"scripts/broken.py": "def f(:\n"}, "", "scripts/broken.py does not compile: "),
    ({"scripts/numeric.py": "import numpy\n"}, "", "scripts/numeric.py imports numpy, which is not in the standard library"),
    ({"scripts/rel.py": "from . import x\n"}, "", "scripts/rel.py uses a relative import"),
    ({f"skills/s{i}/SKILL.md": skill_md(f"s{i}") for i in range(16)}, _many("s", 16), "17 skills: at most 16"),
    ({f"skills/{SKILL}/SKILL.md": skill_md(SKILL, body="y" * (8001 - len(skill_md(SKILL, body=""))))}, "",
     f"skills/{SKILL}/SKILL.md is 8,001 characters: must be at most 8,000"),
    ({f"scripts/t{i}.py": "X = 1\n" for i in range(16)}, "", "17 scripts: at most 16"),
    ({f"scripts/{SCRIPT}.py": "X = 1\n" + "#" * (16_001 - 7) + "\n"}, "",
     f"scripts/{SCRIPT}.py is 16,001 characters: must be at most 16,000"),
    ({"skills/Bad_Name/SKILL.md": skill_md("Bad_Name")}, "\nBad_Name", "skill name 'Bad_Name' must match"),
    ({"scripts/json.py": "X = 1\n"}, "", "script name 'json' is a standard-library module"),
    ({"scripts/llm.py": "X = 1\n"}, "", "script name 'llm' is a REPL name"),
    ({"scripts/Upper.py": "X = 1\n"}, "", "script name 'Upper' must be a lowercase Python identifier"),
    ({"notes.txt": "hello\n"}, "", "notes.txt is not a file a profile may hold"),
    ({"skills/extra/notes.md": "hi\n"}, "", "skills/extra/notes.md is not a file a profile may hold"),
    ({f"scripts/{SCRIPT}.py": SCRIPT_SOURCE.replace("\n", "\r\n", 1)}, "",
     f"scripts/{SCRIPT}.py has a CR: line ends must be LF"),
    ({f"skills/{SKILL}/SKILL.md": f"---\nname: {SKILL}\n---\nbody\n"}, "",
     f"skills/{SKILL}/SKILL.md needs a one-line description in its front matter"),
    ({f"skills/{SKILL}/SKILL.md": skill_md(SKILL, body="Use scripts/missing_one.py.")}, "",
     f"skills/{SKILL}/SKILL.md names scripts/missing_one.py, which the profile does not hold"),
])
def test_skill_and_script_rules(files: dict, add: str, expected: str, home: Path, work: Path) -> None:
    expected = expected.replace("does not have", "does not hold")
    folder = with_skill_and_script(work, "rules", files=files, add_guidance=add)
    errors = errors_of(folder, home)
    assert any(e.startswith(expected) for e in errors), errors
    assert len(errors) == 1, errors


def test_skill_size_and_count_at_the_bound(home: Path, work: Path) -> None:
    at = {f"skills/{SKILL}/SKILL.md": skill_md(SKILL, body="y" * (8000 - len(skill_md(SKILL, body=""))))}
    assert errors_of(with_skill_and_script(work, "at", files=at), home) == []
    sixteen = {f"skills/s{i}/SKILL.md": skill_md(f"s{i}") for i in range(15)}
    sixteen.update({f"scripts/t{i}.py": "X = 1\n" for i in range(15)})
    assert errors_of(with_skill_and_script(work, "sixteen", files=sixteen, add_guidance=_many("s", 15)), home) == []


def test_changed_files(home: Path, work: Path) -> None:
    base_home = home
    base = with_skill_and_script(base_home / "profiles", "tuned-base")
    added = with_skill_and_script(work, "added", files={"scripts/more.py": "X = 2\n"})
    assert check(added, base_home, base="tuned-base")["changed"] == ["scripts/more.py"]
    edited = with_skill_and_script(work, "edited", files={f"skills/{SKILL}/SKILL.md": skill_md(SKILL, body="New.")})
    assert check(edited, base_home, base="tuned-base")["changed"] == [f"skills/{SKILL}/SKILL.md"]
    removed = with_skill_and_script(work, "removed")
    (removed / "scripts" / f"{SCRIPT}.py").unlink()
    result = check(removed, base_home, base="tuned-base")
    assert result["changed"] == [f"scripts/{SCRIPT}.py"]
    assert result["errors"] == [f"guidance.md names scripts/{SCRIPT}.py, which the profile does not hold"]
    both = make_profile(work, "both", toml={"read.max_turns": 60}, add_guidance=TRIGGER,
                        files={f"skills/{SKILL}/SKILL.md": skill_md(SKILL), f"scripts/{SCRIPT}.py": SCRIPT_SOURCE})
    assert check(both, home)["changed"] == ["read.max_turns", "guidance", f"scripts/{SCRIPT}.py",
                                            f"skills/{SKILL}/SKILL.md"]
    assert base.is_dir()


# ---------------------------------------------------------------------------------------------- the gate (D-234)


def gated_profile(work: Path, name: str, *, agents: int = 1, agent_chars: int | None = None, rules: str | None = None,
                  named: bool = True) -> Path:
    files: dict[str, str | None] = {}
    trigger = ""
    for i in range(agents):
        agent = f"reader-{i}"
        text = agent_md(agent)
        if agent_chars is not None:
            text = agent_md(agent, body="z" * (agent_chars - len(agent_md(agent, body=""))))
        files[f"agents/{agent}/AGENT.md"] = text
        trigger += f"\nUse llm(..., agent=\"{agent}\") for long inputs." if named else ""
    files["nudges.toml"] = rules if rules is not None else (
        "[[nudge]]\nwhen = \"error\"\npattern = \"Traceback\"\nhint = \"Read the error before you retry.\"\n")
    return make_profile(work, name, add_guidance=trigger, files=files)


def rule(when: str, key: str, value: object, hint: str = "Try another way.") -> str:
    shown = f"\"{value}\"" if isinstance(value, str) else str(value)
    return f"[[nudge]]\nwhen = \"{when}\"\n{key} = {shown}\nhint = \"{hint}\"\n"


def test_gated_files_need_the_gate(home: Path, work: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    folder = gated_profile(work, "gated")
    off = check(folder, home)
    assert not off["ok"] and "behind a gate that is off" in off["errors"][0] and off["profile_hash"] is None
    monkeypatch.setenv(p.GATE_ENV, "1")
    refused = check(folder, home)
    assert refused["errors"] == [
        "agents/reader-0/AGENT.md: agents/ and nudges.toml are behind the gate (D-234); only rlmh tune --gated may "
        "change them",
        "nudges.toml: agents/ and nudges.toml are behind the gate (D-234); only rlmh tune --gated may change them"]
    allowed = check(folder, home, gated=True)
    assert allowed["ok"] and allowed["changed"] == ["guidance", "agents/reader-0/AGENT.md", "nudges.toml"]


@pytest.mark.parametrize(("case", "ok"), [
    ({"agents": 8}, True), ({"agents": 9}, False),
    ({"agent_chars": 4000}, True), ({"agent_chars": 4001}, False),
    ({"named": False}, False),
    ({"rules": rule("error", "pattern", "p" * 200)}, True), ({"rules": rule("error", "pattern", "p" * 201)}, False),
    ({"rules": rule("no_submit", "turns", 1) + rule("no_submit", "turns", 200)}, True),
    ({"rules": rule("no_submit", "turns", 0)}, False), ({"rules": rule("no_submit", "turns", 201)}, False),
    ({"rules": rule("long_output", "chars", 1000) + rule("long_output", "chars", 1_000_000)}, True),
    ({"rules": rule("long_output", "chars", 999)}, False), ({"rules": rule("long_output", "chars", 1_000_001)}, False),
    ({"rules": rule("error", "pattern", "x", "h" * 400)}, True), ({"rules": rule("error", "pattern", "x", "h" * 401)}, False),
    ({"rules": rule("error", "pattern", "x") * 8}, True), ({"rules": rule("error", "pattern", "x") * 9}, False),
])
def test_gated_bounds(case: dict, ok: bool, home: Path, work: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(p.GATE_ENV, "1")
    result = check(gated_profile(work, "bounds", **case), home, gated=True)
    assert result["ok"] is ok, result["errors"]


# ---------------------------------------------------------------------------------------------- drift (D-207)

PROMPTS = Path(__file__).resolve().parents[2] / "app" / "src" / "tune" / "prompts"


def _rows(text: str, header: str) -> dict[str, str]:
    """A markdown table's rows after the line `| <header> | ...`, first cell (backticks dropped) to second."""
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(f"| {header} |"))
    rows = {}
    for line in lines[start + 2:]:
        if not line.startswith("|"):
            break
        cells = [c.strip() for c in line.strip("|").split("|")]
        rows[cells[0].strip("`")] = cells[1]
    return rows


def _bound(b: object) -> str:
    if b is bool:
        return "`true`, `false`"
    if isinstance(b, tuple) and all(isinstance(x, str) for x in b):
        return ", ".join(f"`{x}`" for x in b)
    lo, hi = b  # type: ignore[misc]
    return f"{lo} to {hi}"


def test_surface_tables_match_tunable() -> None:
    text = (PROMPTS / "surface.md").read_text(encoding="utf-8")
    assert _rows(text, "key") == {k: _bound(b) for k, b in p.TUNABLE.items()}
    frozen = next(line for line in text.splitlines() if line.startswith("Frozen: "))
    named = {x.strip("`") for x in frozen.removeprefix("Frozen: ").split(". ")[0].replace("every ", "").split(", ")}
    for key in p.FROZEN:
        leaf = key.split(".")[-1]
        assert key in named or leaf in named or (leaf.endswith("_max_tokens") and "*_max_tokens" in named), key
    for name in named:
        assert any(k == name or k.split(".")[-1] == name or (name == "*_max_tokens" and k.endswith("_max_tokens")) for k in p.FROZEN), name
    files = _rows(text, "file")
    assert files == {
        "system.md": f"at most {p.SYSTEM_MAX_CHARS} characters",  # D-256
        "guidance.md": f"at most {p.GUIDANCE_MAX_CHARS} characters",
        "skills": f"at most {p.MAX_SKILLS}",
        "each `SKILL.md": f"at most {p.SKILL_MAX_CHARS} characters",
        "scripts": f"at most {p.MAX_SCRIPTS}",
        "each script": f"at most {p.SCRIPT_MAX_CHARS} characters",
    }
    assert f"`{p.SKILL_NAME}`" in text


def test_surface_gated_table_matches_tunable_gated() -> None:
    rows = _rows((PROMPTS / "surface-gated.md").read_text(encoding="utf-8"), "what")
    a, n = p.TUNABLE_GATED["agents"], p.TUNABLE_GATED["nudges"]
    assert rows == {
        "agents": f"at most {a['count']}",
        "each `AGENT.md": f"at most {a['chars']} characters",
        "nudge rules": f"at most {n['count']}",
        "pattern": f"at most {n['pattern']} characters",
        "turns": f"{n['turns'][0]} to {n['turns'][1]}",
        "chars": f"{n['chars'][0]} to {n['chars'][1]}",
        "hint": f"at most {n['hint']} characters",
    }
