"""KV cache: none

profiles.py and the two built-ins: `training-v4` hashes to training's value, `default` is that plus its guidance
block and nothing else, and user profiles are validated, normalised and never shadow a built-in. Every test uses
`tmp_path` as the home.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from rlm_engine import contract, service
from rlm_engine import profiles as p

HEX64 = re.compile(r"[0-9a-f]{64}")
VALID = 'contract = "v4"\n'


def user_profile(home: Path, name: str, toml: str | bytes, files: dict[str, bytes] | None = None) -> Path:
    folder = home / "profiles" / name
    folder.mkdir(parents=True)
    (folder / "profile.toml").write_bytes(toml if isinstance(toml, bytes) else toml.encode("utf-8"))
    for file_name, data in (files or {}).items():
        (folder / file_name).write_bytes(data)
    return folder


def builtin(name: str, home: Path) -> p.Profile:
    profile = p.load_profile(name, home)
    assert profile.source == "builtin"
    return profile


def test_builtins_listed(tmp_path: Path) -> None:
    listed = p.list_profiles(tmp_path)
    assert [(x.name, x.source) for x in listed] == [("default", "builtin"), ("training-v4", "builtin")]
    for profile in listed:
        assert HEX64.fullmatch(profile.prompt_hash()) and HEX64.fullmatch(profile.profile_hash())


def test_training_v4_is_training(tmp_path: Path) -> None:
    training = builtin("training-v4", tmp_path)
    assert training.prompt_hash() == contract.TRAINING_HASH
    assert training.read.limits == contract.READ_LIMITS_V4
    assert training.repo.limits == contract.EDIT_LIMITS_V4
    assert training.repo.limits.subcall_thinking == "low" and training.read.limits.subcall_thinking is None
    assert (training.repo.pace_nudge, training.read.pace_nudge) == (True, False)
    assert (training.root_temperature, training.sub_temperature) == (1.0, 0.3)
    assert training.guidance == ""
    assert training.system_prompt() == contract.SYSTEM_PROMPT_V4
    assert training.system_prompt("PowerShell") == contract.SYSTEM_PROMPT_V4


def test_default_differs_only_by_guidance(tmp_path: Path) -> None:
    training = builtin("training-v4", tmp_path)
    default = builtin("default", tmp_path)
    assert (default.read, default.repo) == (training.read, training.repo)
    assert (default.root_temperature, default.sub_temperature) == (training.root_temperature, training.sub_temperature)
    assert default.guidance
    assert default.system_prompt("sh") == training.system_prompt("sh") + "\n\n" + default.guidance.replace("{shell}", "sh")
    assert default.prompt_hash() != training.prompt_hash()
    limits = json.dumps({"read": default.read.limits.as_dict(), "edit": default.repo.limits.as_dict()}, sort_keys=True)
    assert contract.prompt_hash(dict(contract.PROMPTS_V4, limits=limits)) == contract.TRAINING_HASH
    before = default.prompt_hash()
    git_bash = default.system_prompt("Git Bash")
    assert "Git Bash" in git_bash and "{shell}" not in git_bash
    assert default.prompt_hash() == before


def test_default_guidance_text() -> None:
    raw = (p.BUILTIN_DIR / "default" / "guidance.md").read_bytes()
    assert b"\r\n" not in raw and not raw.startswith(b"\xef\xbb\xbf") and raw.endswith(b"\n")
    text = raw.decode("utf-8")
    assert len(text.splitlines()) <= 12
    assert "fetch(url) -> str" in text and "200,000" in text and "{shell}" in text


def test_profile_hash(tmp_path: Path) -> None:
    default = builtin("default", tmp_path)
    assert default.profile_hash() == default.profile_hash()
    src = p.BUILTIN_DIR / "default"
    toml, guidance = (src / "profile.toml").read_bytes(), (src / "guidance.md").read_bytes()

    copy = user_profile(tmp_path, "copy", toml, {"guidance.md": guidance})
    mine = p.load_profile("copy", tmp_path)
    assert mine.profile_hash() == default.profile_hash()  # names and folders are not hashed, only bytes
    (copy / "guidance.md").write_bytes(guidance + b"x")
    assert mine.profile_hash() != default.profile_hash()
    (copy / "guidance.md").write_bytes(guidance)
    (copy / "profile.toml").write_bytes(toml.replace(b"max_turns = 20", b"max_turns = 21"))
    assert mine.profile_hash() != default.profile_hash()

    user_profile(tmp_path, "crlf", toml.replace(b"\n", b"\r\n"), {"guidance.md": guidance.replace(b"\n", b"\r\n")})
    windows = p.load_profile("crlf", tmp_path)
    assert windows.profile_hash() == default.profile_hash()
    assert windows.system_prompt("sh") == default.system_prompt("sh")
    assert windows.prompt_hash() == default.prompt_hash()


def test_user_profile(tmp_path: Path) -> None:
    user_profile(tmp_path, "mine", VALID + "[read]\nmax_turns = 7\ncpus = 2\n")
    mine = p.load_profile("mine", tmp_path)
    assert mine.source == "user" and mine.path == tmp_path / "profiles" / "mine"
    assert mine.read.limits.max_turns == 7
    assert (mine.read.limits.memory_mb, mine.read.limits.pids) == (512, 64)
    assert mine.read.limits.cpus == 2.0 and isinstance(mine.read.limits.cpus, float)
    assert mine.repo.limits == contract.EDIT_LIMITS_V4 and mine.repo.pace_nudge is False
    assert (mine.root_temperature, mine.sub_temperature, mine.guidance) == (1.0, 0.3, "")
    assert mine.prompt_hash() != contract.TRAINING_HASH
    assert [(x.name, x.source) for x in p.list_profiles(tmp_path)][-1] == ("mine", "user")

    user_profile(tmp_path, "thinks", VALID + '[read]\nsubcall_thinking = "high"\nmax_subcalls = 0\n'
                 '[repo]\nsubcall_thinking = "off"\npace_nudge = true\n[root]\ntemperature = 0\n')
    thinks = p.load_profile("thinks", tmp_path)
    assert (thinks.read.limits.subcall_thinking, thinks.read.limits.max_subcalls) == ("high", 0)
    assert (thinks.repo.limits.subcall_thinking, thinks.repo.pace_nudge, thinks.root_temperature) == (None, True, 0.0)
    assert [x.name for x in p.list_profiles(tmp_path)] == ["default", "training-v4", "mine", "thinks"]


@pytest.mark.parametrize(
    ("toml", "files", "key"),
    [
        (VALID + "colour = 1\n", {}, "colour"),
        (VALID + "[read]\nturns = 3\n", {}, "turns"),
        (VALID + '[read]\nmax_turns = "20"\n', {}, "max_turns"),
        (VALID + "[read]\nmax_turns = true\n", {}, "max_turns"),
        (VALID + "[read]\nmax_turns = 20.0\n", {}, "max_turns"),
        (VALID + "[read]\nmax_turns = 0\n", {}, "max_turns"),
        ('contract = "v3"\n', {}, "contract"),
        ("[read]\nmax_turns = 3\n", {}, "contract"),
        (VALID + "[read]\npace_nudge = true\n", {}, "pace_nudge"),
        (VALID + '[repo]\nsubcall_oversize = "cut"\n', {}, "subcall_oversize"),
        (VALID + '[repo]\nsubcall_thinking = "none"\n', {}, "subcall_thinking"),
        (VALID + "[read]\ncpus = 0\n", {}, "cpus"),
        (VALID + "[sub]\ntemperature = 2.5\n", {}, "temperature"),
        (VALID + "[sub]\ntop_p = 0.9\n", {}, "top_p"),
        (VALID + "root = 1\n", {}, "root"),
        (VALID + 'guidance = "../x"\n', {}, "guidance"),
        (VALID + 'guidance = "/etc/hostname"\n', {}, "guidance"),
        (VALID + 'guidance = "C:\\\\x.md"\n', {}, "guidance"),
        (VALID + 'guidance = "missing.md"\n', {}, "guidance"),
        (VALID + "guidance = 3\n", {}, "guidance"),
        (VALID + "[read\n", {}, "profile.toml"),
        (VALID + 'guidance = "g.md"\n', {"g.md": b"caf\xe9\n"}, "guidance"),
    ],
)
def test_toml_errors(tmp_path: Path, toml: str, files: dict[str, bytes], key: str) -> None:
    user_profile(tmp_path, "bad", toml, files)
    with pytest.raises(p.ProfileError) as err:
        p.load_profile("bad", tmp_path)
    assert not isinstance(err.value, p.UnknownProfile)
    assert "'bad'" in str(err.value) and key in str(err.value)


def test_toml_not_utf8(tmp_path: Path) -> None:
    user_profile(tmp_path, "bad", b'contract = "v4"\n# caf\xe9\n')
    with pytest.raises(p.ProfileError, match="'bad'.*profile.toml"):
        p.load_profile("bad", tmp_path)


def test_builtin_wins(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    user_profile(tmp_path, "training-v4", VALID + "[read]\nmax_turns = 3\n")
    loaded = p.load_profile("training-v4", tmp_path)
    assert loaded.source == "builtin" and loaded.read.limits.max_turns == 20
    listed = p.list_profiles(tmp_path)
    assert [x.name for x in listed].count("training-v4") == 1
    assert [x.source for x in listed] == ["builtin", "builtin"]
    err = capsys.readouterr()
    assert err.out == ""
    assert len(err.err.splitlines()) == 1 and "training-v4" in err.err


def test_unknown_and_unsafe_names(tmp_path: Path) -> None:
    home = tmp_path / "home"
    # valid profiles wherever an unsafe name could lead, so loading one would succeed instead of raising
    user_profile(tmp_path, "x", VALID)  # tmp_path/profiles/x
    (home / "x").mkdir(parents=True)
    (home / "x" / "profile.toml").write_text(VALID, encoding="utf-8")
    user_profile(home, ".hidden", VALID)
    user_profile(home, "a", VALID)
    (home / "profiles" / "a" / "b").mkdir()
    (home / "profiles" / "a" / "b" / "profile.toml").write_text(VALID, encoding="utf-8")
    for name in ("nope", "", "../x", "a/b", "a\\b", ".hidden", "..", "x" * 65):
        with pytest.raises(p.UnknownProfile):
            p.load_profile(name, home)
    assert p.load_profile("a", home).source == "user"


def test_broken_user_profile(tmp_path: Path, capsys: pytest.CaptureFixture[str], monkeypatch: pytest.MonkeyPatch) -> None:
    user_profile(tmp_path, "broken", VALID + "[read]\nmax_turns = -1\n")
    locked = user_profile(tmp_path, "locked", VALID)
    user_profile(tmp_path, "fine", VALID)
    read_bytes = Path.read_bytes

    def refuse(path: Path) -> bytes:
        if path.parent == locked:
            raise PermissionError(13, "Permission denied")
        return read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", refuse)
    (tmp_path / "profiles" / "empty").mkdir()
    (tmp_path / "profiles" / "notes.txt").write_text("not a profile", encoding="utf-8")
    assert [x.name for x in p.list_profiles(tmp_path)] == ["default", "training-v4", "fine"]
    err = capsys.readouterr()
    assert err.out == "" and "max_turns" in err.err and "Permission denied" in err.err
    assert len(err.err.splitlines()) == 3 and "'empty'" in err.err  # a folder without profile.toml is warned too
    for name in ("broken", "locked"):
        with pytest.raises(p.ProfileError) as raised:
            p.load_profile(name, tmp_path)
        assert not isinstance(raised.value, p.UnknownProfile) and f"'{name}'" in str(raised.value)
    with pytest.raises(p.UnknownProfile):
        p.load_profile("empty", tmp_path)


def test_mode(tmp_path: Path) -> None:
    training = builtin("training-v4", tmp_path)
    assert training.mode("read") is training.read
    assert training.mode("repo") is training.repo
    with pytest.raises(ValueError):
        training.mode("x")


def test_contract_info(tmp_path: Path) -> None:
    user_profile(tmp_path, "mine", VALID)
    info = service.contract_info(tmp_path)
    assert list(info) == ["contract", "contract_hash", "training_hash", "profiles"]
    assert info["contract"] == "v4"
    assert info["contract_hash"] == info["training_hash"] == contract.TRAINING_HASH
    assert [(x["name"], x["source"]) for x in info["profiles"]] == [
        ("default", "builtin"), ("training-v4", "builtin"), ("mine", "user"),
    ]
    for entry in info["profiles"]:
        assert list(entry) == ["name", "source", "prompt_hash", "profile_hash"]
        assert HEX64.fullmatch(entry["prompt_hash"]) and HEX64.fullmatch(entry["profile_hash"])
    training = next(x for x in info["profiles"] if x["name"] == "training-v4")
    assert training["prompt_hash"] == info["training_hash"]
