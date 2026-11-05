"""KV cache: builds the system prompt and limits from files; a profile is read once per run and its text is fixed from then on. Skills, scripts and agents never enter the system prompt: `skill()` prints a skill into the REPL output, scripts are imported in the REPL, and an agent's text is a sub-call's own system message, the same bytes on every call (v1 step 6).

A profile is a folder holding `profile.toml` and an optional guidance file appended to the system prompt
(v0-design § Profiles). Built-ins live next to this file; user profiles in `<home>/profiles/<name>`, and a
built-in wins over a user profile of the same name (D-34). Each mode table starts from training's v4 limits and
replaces only the keys it lists (D-09), so `training-v4` hashes to `contract.TRAINING_HASH`. Files are read as
bytes with CRLF turned into LF before decoding, so a Windows checkout gives the same prompts and hashes (D-43).

v1 step 6 adds the tuner's surface (v1 architecture §7.2): `TUNABLE`, the only keys a candidate may change, with their
bounds; `FROZEN`; `effective`, `check_tunable` and `changed`; a profile's skills (`skills/<name>/SKILL.md`) and scripts
(`scripts/<name>.py`) under agent_api (D-233); and, behind a gate that is off (`GATED`, D-234), its named agents
(`agents/<name>/AGENT.md`) and nudge rules (`nudges.toml`).
"""

from __future__ import annotations

import ast
import dataclasses
import hashlib
import json
import keyword
import os
import re
import sys
import tomllib
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath, PureWindowsPath

from . import contract
from .worker import agentapi, codeapi, tools

BUILTIN_DIR = Path(__file__).resolve().parent / "profiles"

_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_TOP_KEYS = ("contract", "guidance", "cache_api", "agent_api", "rlm", "compaction", "root", "sub", "read", "repo")
_LIMIT_FIELDS = tuple(f.name for f in dataclasses.fields(contract.Limits))
_THINKING = {"off": None, **{t: t for t in ("minimal", "low", "medium", "high", "xhigh", "max")}}  # TOML has no null: off means none
_OVERSIZE = ("truncate", "error")
_DEFAULT_TEMPERATURE = {"root": 1.0, "sub": 0.3}
_warned: set[str] = set()

# ----------------------------------------------------------------------------- the tuner's surface (v1 step 6)

# D-234: named agents and nudge rules are built but off. The gate is on when this is true, or when the engine's
# environment has RLMH_TUNE_GATED=1 (`rlmh tune --gated` sets it for its own engine). Step 7 decides.
GATED = False
GATE_ENV = "RLMH_TUNE_GATED"

# Each dotted key a candidate may change (v1 architecture §7.2, D-207), and its bound: a pair of ints (an integer
# range), a pair of floats (a number range; an integer value counts, a bool never), `bool`, or a tuple of strings (one
# of them). This is the only copy in code; app/src/tune/prompts/surface.md repeats it, and a test checks they agree.
TUNABLE: dict[str, object] = {
    "read.max_turns": (10, 200),
    "repo.max_turns": (10, 200),
    "read.max_subcalls": (10, 200),
    "repo.max_subcalls": (10, 200),
    "read.submit_check": (0.0, 1.0),  # D-251's check, given to the tuner here (D-252)
    "repo.subcall_thinking": ("off", "low", "medium", "high"),
    "repo.pace_nudge": bool,
    "root.temperature": (0.0, 1.0),
    "sub.temperature": (0.0, 1.0),
    "rlm.max_runs": (0, 24),
    "rlm.max_turns": (5, 60),
    "rlm.max_parallel": (1, 8),
    "compaction.window": (65_536, 1_048_576),
    "compaction.keep_ratio": (0.08, 0.32),
}
# §7.2's frozen list. Every other key outside TUNABLE is frozen too: a candidate that changes one is invalid.
FROZEN: tuple[str, ...] = (
    "contract", "cache_api", "agent_api",
    *(f"{mode}.{key}" for mode in ("read", "repo") for key in (
        "root_max_tokens", "subcall_max_tokens", "output_max_chars", "cell_timeout_s", "subcall_max_chars",
        "subcall_oversize")),
    "rlm.max_depth", "compaction.reserve", "compaction.summary_max_tokens",
)
GUIDANCE_MAX_CHARS = 12_000
# Skills and scripts (D-233, §7.2's starting figures)
MAX_SKILLS = 16
SKILL_MAX_CHARS = 8_000  # a whole SKILL.md, front matter included
MAX_SCRIPTS = 16
SCRIPT_MAX_CHARS = 16_000
SKILL_NAME = r"[a-z0-9][a-z0-9-]{0,47}"  # an agent's name follows the same rule
SCRIPT_NAME = r"[a-z][a-z0-9_]{0,47}"  # a lowercase identifier, neither a standard-library module nor a REPL name
# Named agents and nudges, behind the gate (D-234, §7.2's starting figures)
MAX_AGENTS = 8
AGENT_MAX_CHARS = 4_000  # a whole AGENT.md, front matter included
MAX_NUDGES = 8
NUDGE_PATTERN_MAX = 200
NUDGE_TURNS = (1, 200)
NUDGE_CHARS = (1_000, 1_000_000)
NUDGE_HINT_MAX = 400
NUDGE_WHEN = {"error": "pattern", "no_submit": "turns", "long_output": "chars"}  # each kind's threshold key
TUNABLE_GATED: dict[str, dict[str, object]] = {
    "agents": {"count": MAX_AGENTS, "chars": AGENT_MAX_CHARS},
    "nudges": {"count": MAX_NUDGES, "pattern": NUDGE_PATTERN_MAX, "turns": NUDGE_TURNS, "chars": NUDGE_CHARS,
               "hint": NUDGE_HINT_MAX},
}
# Names a script may not take: the REPL's own (worker.py's API, cacheapi's, the tools, agentapi's and codeapi's)
REPL_NAMES = frozenset((*contract.API_NAMES, "fetch", "segments", "skill", *tools.TOOL_NAMES, *agentapi.NAMES,
                        *codeapi.NAMES))
_SKILL_RE = re.compile(SKILL_NAME)
_SCRIPT_RE = re.compile(SCRIPT_NAME)
_NAMED_SCRIPT_RE = re.compile(r"scripts/([A-Za-z0-9_]+)\.py")
_FILE_RES = {kind: re.compile(pattern) for kind, pattern in (
    ("skill", r"skills/([^/]+)/SKILL\.md"), ("script", r"scripts/([^/]+)\.py"), ("agent", r"agents/([^/]+)/AGENT\.md"))}


def gate_on() -> bool:
    """Whether agents/ and nudges.toml may load (D-234)."""
    return GATED or os.environ.get(GATE_ENV) == "1"


class ProfileError(ValueError):
    """A profile that fails to parse; step 6 maps it to -32011."""


class UnknownProfile(ProfileError):
    """No profile of that name, or a name that is not safe as a folder name; -32011."""


@dataclass(frozen=True)
class Skill:
    """`skills/<name>/SKILL.md` (D-233): its front matter's one-line description, and the text after it."""

    description: str
    text: str


@dataclass(frozen=True)
class Agent:
    """`agents/<name>/AGENT.md` (D-234, gated): its description, and the text a sub-call gets as its system message."""

    description: str
    text: str


@dataclass(frozen=True)
class Nudge:
    """One `[[nudge]]` rule of nudges.toml (D-234, gated): data only, never run. `pattern` is a plain substring."""

    when: str  # "error" | "no_submit" | "long_output"
    hint: str
    pattern: str | None = None  # when = "error": a substring of a cell's output or error
    turns: int | None = None  # when = "no_submit": that many turns of a prompt with no submit()
    chars: int | None = None  # when = "long_output": a cell that printed more than that many characters


@dataclass(frozen=True)
class ModeSettings:
    limits: contract.Limits
    pace_nudge: bool
    submit_check: float = 0.0  # [read] only: hold a first submit() resting on less of `context` than this (D-251)


@dataclass(frozen=True)
class RlmSettings:
    """rlm() child runs (D-160): how many a run may start, each one's turn limit, how deep they nest, and how many run at
    once (the rest wait)."""

    max_runs: int = 12
    max_turns: int = 30
    max_depth: int = 1
    max_parallel: int = 4


_RLM_FIELDS = tuple(f.name for f in dataclasses.fields(RlmSettings))


@dataclass(frozen=True)
class CompactionSettings:
    """The [compaction] table (v1 step 3, D-171): compact as if the model's window were at most `window` tokens,
    keep the newest `keep_ratio` of (window - output) verbatim, with DeepSeek Harness's `reserve` margin, and give the
    summary call `summary_max_tokens`."""

    window: int
    keep_ratio: float
    reserve: int
    summary_max_tokens: int


_COMPACTION_FIELDS = tuple(f.name for f in dataclasses.fields(CompactionSettings))


@dataclass(frozen=True)
class Profile:
    name: str
    source: str  # "builtin" or "user"
    path: Path  # the profile's folder
    guidance: str
    root_temperature: float
    sub_temperature: float
    read: ModeSettings
    repo: ModeSettings
    cache_api: bool = False  # cache-shaped sub-calls in the REPL (D-119); training-v4 never has them
    agent_api: bool = False  # ask_files, schema=, llm_async, rlm, review, check, outline (D-157 to D-162); never training-v4
    rlm: RlmSettings = RlmSettings()
    compaction: CompactionSettings | None = None  # None: the run never compacts (training-v4, D-171)
    file_hash: str = ""  # profile_hash() of the bytes this profile was loaded from
    skills: dict[str, Skill] = field(default_factory=dict)  # D-233, agent_api only
    scripts: dict[str, Path] = field(default_factory=dict)  # name -> its file in the profile folder; D-233
    agents: dict[str, Agent] = field(default_factory=dict)  # D-234, gated
    nudges: tuple[Nudge, ...] = ()  # D-234, gated
    # every skill, script, agent and nudges.toml file, by its path in the folder with "/", LF-normalised: the bytes
    # the hash covers and a run copies (scripts)
    files: dict[str, bytes] = field(default_factory=dict)

    def system_prompt(self, shell_name: str = "sh") -> str:
        """Prompt v4, then the guidance block (if any) with every `{shell}` filled in."""
        if not self.guidance:
            return contract.SYSTEM_PROMPT_V4
        return contract.SYSTEM_PROMPT_V4 + "\n\n" + self.guidance.replace("{shell}", shell_name)

    def prompt_hash(self) -> str:
        """Training's hash over this profile's texts and limits. `{shell}` stays unfilled, so the hash is the same
        on every machine; the run log's messages hold the filled text."""
        texts = dict(contract.PROMPTS_V4)
        texts["system"] = self.system_prompt("{shell}")
        texts["limits"] = json.dumps({"read": self.read.limits.as_dict(), "edit": self.repo.limits.as_dict()},
                                     sort_keys=True)
        return contract.prompt_hash(texts)

    def profile_hash(self) -> str:
        """sha256 of the LF-normalised profile.toml, a NUL byte, and the guidance file, then, for each skill, script,
        agent or nudges.toml file in sorted path order, a NUL, its path with "/", a NUL and its bytes (v1 §7.2): the
        bytes this profile was loaded from, so a file edited or deleted during a run doesn't change the hash its
        record shows. A profile with none of those files hashes as before step 6."""
        return self.file_hash

    def script_files(self) -> dict[str, bytes]:
        """`<name>.py` -> the bytes loaded, for the run's copy of scripts/ (D-233)."""
        return {f"{name}.py": self.files[f"scripts/{name}.py"] for name in self.scripts}

    def mode(self, mode: str) -> ModeSettings:
        if mode == "read":
            return self.read
        if mode == "repo":
            return self.repo
        raise ValueError(f"unknown mode {mode!r}")


def list_profiles(home: Path) -> list[Profile]:
    """Built-ins sorted by name, then user profiles sorted by name. A user profile named like a built-in, or one
    that fails to load, is skipped with a warning on stderr."""
    builtins = _builtin_names()
    profiles = [_load(name, BUILTIN_DIR / name, "builtin") for name in builtins]
    for folder in _user_folders(home):
        if folder.name in builtins:
            _warn_shadowed(folder)
            continue
        try:
            profiles.append(_load_user(folder.name, folder))
        except ProfileError as err:
            _warn(f"skipping the user profile in {folder}: {err}")
    return profiles


def load_profile(name: str, home: Path) -> Profile:
    """The built-in of that name, else the user profile in `<home>/profiles/<name>`, else UnknownProfile."""
    _check_name(name)
    folder = home / "profiles" / name
    if name in _builtin_names():
        if folder.is_dir():
            _warn_shadowed(folder)
        return _load(name, BUILTIN_DIR / name, "builtin")
    return _load_user(name, folder)


# ----------------------------------------------------------------------------- loading


def _builtin_names() -> list[str]:
    return sorted(p.name for p in BUILTIN_DIR.iterdir() if (p / "profile.toml").is_file())


def _user_folders(home: Path) -> list[Path]:
    root = home / "profiles"
    if not root.is_dir():
        return []
    return sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)


def _check_name(name: object) -> None:
    if not isinstance(name, str) or not _NAME_RE.fullmatch(name):
        raise UnknownProfile(f"invalid profile name {name!r}")


def _load_user(name: str, folder: Path) -> Profile:
    _check_name(name)
    if not (folder / "profile.toml").is_file():
        raise UnknownProfile(f"unknown profile {name!r}")
    return _load(name, folder, "user")


def _load(name: str, folder: Path, source: str) -> Profile:
    toml_bytes = _read(name, folder / "profile.toml")
    data = _parse(name, toml_bytes)
    for key in data:
        if key not in _TOP_KEYS:
            raise ProfileError(f"profile {name!r}: unknown key {key!r}")
    if "contract" not in data:
        raise ProfileError(f"profile {name!r}: missing key 'contract'")
    if data["contract"] != contract.CONTRACT_VERSION:
        raise ProfileError(f"profile {name!r}: contract must be {contract.CONTRACT_VERSION!r}, not {data['contract']!r}")
    if data.get("agent_api") is True and data.get("cache_api") is not True:
        raise ProfileError(f"profile {name!r}: agent_api needs cache_api = true")  # it builds on cacheapi's llm (D-157)
    guidance_path = _guidance_path(name, folder, data.get("guidance", ""))
    guidance, guidance_bytes = "", b""
    if guidance_path:
        guidance_bytes = _read(name, guidance_path)
        guidance = _decode(name, f"guidance file {guidance_path.name!r}", guidance_bytes).strip()
    agent_api = _bool(name, "agent_api", data.get("agent_api", False))
    extras = _extras(name, folder, agent_api)
    read = _mode(name, "read", data, contract.READ_LIMITS_V4)
    repo = _mode(name, "repo", data, contract.EDIT_LIMITS_V4)
    compaction = _compaction(name, data)
    if compaction is not None:
        for key, settings in (("read", read), ("repo", repo)):
            if settings.limits.root_max_tokens >= compaction.window:
                raise ProfileError(f"profile {name!r}: [{key}] root_max_tokens must be below [compaction] window")
    return Profile(
        name=name,
        source=source,
        path=folder,
        guidance=guidance,
        root_temperature=_temperature(name, "root", data),
        sub_temperature=_temperature(name, "sub", data),
        read=read,
        repo=repo,
        cache_api=_bool(name, "cache_api", data.get("cache_api", False)),
        agent_api=agent_api,
        rlm=_rlm(name, data),
        compaction=compaction,
        file_hash=_file_hash(toml_bytes, guidance_bytes, extras["files"]),
        **extras,
    )


def _file_hash(toml_bytes: bytes, guidance_bytes: bytes, files: dict[str, bytes]) -> str:
    blob = [toml_bytes, b"\x00", guidance_bytes]
    for path in sorted(files):
        blob += [b"\x00", path.encode("utf-8"), b"\x00", files[path]]
    return hashlib.sha256(b"".join(blob)).hexdigest()


# ----------------------------------------------------------------------------- skills, scripts, agents, nudges


def _extras(name: str, folder: Path, agent_api: bool) -> dict:
    """The profile's skills and scripts (D-233) and, with the gate on, its agents and nudges (D-234). Only what a run
    needs is checked here; the rest of §7.2's rules are check_tunable's, so a user's own profile that breaks one still
    loads and runs."""
    out: dict = {"skills": {}, "scripts": {}, "agents": {}, "nudges": (), "files": {}}
    files = out["files"]
    skills, scripts, agents = folder / "skills", folder / "scripts", folder / "agents"
    nudges = folder / "nudges.toml"
    if (skills.exists() or scripts.exists()) and not agent_api:
        raise ProfileError(f"profile {name!r}: skills/ and scripts/ need agent_api = true")
    if agents.exists() or nudges.exists():
        if not gate_on():
            raise ProfileError(f"profile {name!r}: agents/ and nudges.toml are behind a gate that is off (D-234; "
                               f"rlmh tune --gated sets {GATE_ENV}=1)")
        if not agent_api:
            raise ProfileError(f"profile {name!r}: agents/ and nudges.toml need agent_api = true")
    for root, file_name, cls, into in ((skills, "SKILL.md", Skill, out["skills"]),
                                       (agents, "AGENT.md", Agent, out["agents"])):
        for sub in _subfolders(root):
            path = sub / file_name
            if not path.is_file():
                continue
            rel = f"{root.name}/{sub.name}/{file_name}"
            raw = _read(name, path)
            meta, text = _front_matter(name, rel, _decode(name, rel, raw))
            if meta.get("name") != sub.name:
                raise ProfileError(f"profile {name!r}: {rel}'s front matter must say name: {sub.name}")
            into[sub.name] = cls(description=meta.get("description", ""), text=text)
            files[rel] = raw
    if scripts.is_dir():
        for path in sorted(scripts.iterdir(), key=lambda p: p.name):
            if path.suffix == ".py" and path.is_file():
                rel = f"scripts/{path.name}"
                raw = _read(name, path)
                _decode(name, rel, raw)
                out["scripts"][path.stem] = path
                files[rel] = raw
    if nudges.is_file():
        raw = _read(name, nudges)
        out["nudges"] = _nudges(name, _decode(name, "nudges.toml", raw))
        files["nudges.toml"] = raw
    return out


def _subfolders(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    return sorted((p for p in root.iterdir() if p.is_dir()), key=lambda p: p.name)


def _front_matter(name: str, rel: str, text: str) -> tuple[dict[str, str], str]:
    """`---`, `key: value` lines, `---`, then the text. Returns the keys and the text after the front matter."""
    lines = text.split("\n")
    end = None
    if lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise ProfileError(f"profile {name!r}: {rel} has no front matter (a --- line, name: and description:, then ---)")
    meta: dict[str, str] = {}
    for line in lines[1:end]:
        if not line.strip():
            continue
        key, sep, value = line.partition(":")
        if not sep:
            raise ProfileError(f"profile {name!r}: {rel}'s front matter line {line.strip()!r} is not key: value")
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        meta[key.strip()] = value
    return meta, "\n".join(lines[end + 1:]).strip()


def _nudges(name: str, text: str) -> tuple[Nudge, ...]:
    """nudges.toml: `[[nudge]]` tables, each with exactly `when`, that kind's threshold and `hint` (§7.2), every
    value of the right type and within TUNABLE_GATED's bounds. The rule count is check_tunable's."""
    try:
        data = tomllib.loads(text)
    except tomllib.TOMLDecodeError as err:
        raise ProfileError(f"profile {name!r}: nudges.toml is not valid TOML: {err}") from None
    for key in data:
        if key != "nudge":
            raise ProfileError(f"profile {name!r}: unknown key {key!r} in nudges.toml (it holds [[nudge]] tables)")
    rules = data.get("nudge", [])
    if not isinstance(rules, list) or not all(isinstance(r, dict) for r in rules):
        raise ProfileError(f"profile {name!r}: nudges.toml holds [[nudge]] tables only")
    out = []
    for i, rule in enumerate(rules, 1):
        where = f"profile {name!r}: nudges.toml rule {i}"
        when = rule.get("when")
        if when not in NUDGE_WHEN:
            raise ProfileError(f"{where}: when must be one of {', '.join(NUDGE_WHEN)}")
        threshold = NUDGE_WHEN[when]
        for key in rule:
            if key not in ("when", threshold, "hint"):
                raise ProfileError(f"{where}: unknown key {key!r} (a {when} rule has when, {threshold} and hint)")
        for key in (threshold, "hint"):
            if key not in rule:
                raise ProfileError(f"{where}: missing key {key!r}")
        hint, value = rule["hint"], rule[threshold]
        if not isinstance(hint, str) or not hint.strip() or len(hint) > NUDGE_HINT_MAX:
            raise ProfileError(f"{where}: hint must be a string of 1 to {NUDGE_HINT_MAX} characters")
        if threshold == "pattern":
            if not isinstance(value, str) or not value or len(value) > NUDGE_PATTERN_MAX:
                raise ProfileError(f"{where}: pattern must be a string of 1 to {NUDGE_PATTERN_MAX} characters")
        else:
            lo, hi = NUDGE_TURNS if threshold == "turns" else NUDGE_CHARS
            if isinstance(value, bool) or not isinstance(value, int) or not lo <= value <= hi:
                raise ProfileError(f"{where}: {threshold} must be an integer from {lo:,} to {hi:,}")
        out.append(Nudge(when=when, hint=hint, **{threshold: value}))
    return tuple(out)


def _bool(name: str, key: str, value: object) -> bool:
    if not isinstance(value, bool):
        raise ProfileError(f"profile {name!r}: {key} must be true or false")
    return value


def _read(name: str, path: Path) -> bytes:
    try:
        return path.read_bytes().replace(b"\r\n", b"\n")
    except OSError as err:
        raise ProfileError(f"profile {name!r}: cannot read {path.name}: {err.strerror or err}") from None


def _decode(name: str, what: str, raw: bytes) -> str:
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        raise ProfileError(f"profile {name!r}: {what} is not UTF-8") from None


def _parse(name: str, raw: bytes) -> dict:
    try:
        return tomllib.loads(_decode(name, "profile.toml", raw))
    except tomllib.TOMLDecodeError as err:
        raise ProfileError(f"profile {name!r}: profile.toml is not valid TOML: {err}") from None


def _guidance_path(name: str, folder: Path, value: object) -> Path | None:
    """The guidance file inside the profile folder, or None for `""`."""
    if not isinstance(value, str):
        raise ProfileError(f"profile {name!r}: guidance must be a file name or \"\"")
    if not value:
        return None
    posix, windows = PurePosixPath(value), PureWindowsPath(value)
    if posix.is_absolute() or windows.is_absolute() or windows.drive or ".." in windows.parts:
        raise ProfileError(f"profile {name!r}: guidance {value!r} must be a file inside the profile folder")
    path = folder / value
    if not path.is_file():
        raise ProfileError(f"profile {name!r}: guidance file {value!r} not found")
    return path


def _table(name: str, key: str, data: dict) -> dict:
    table = data.get(key, {})
    if not isinstance(table, dict):
        raise ProfileError(f"profile {name!r}: {key} must be a table")
    return table


def _temperature(name: str, key: str, data: dict) -> float:
    table = _table(name, key, data)
    for k in table:
        if k != "temperature":
            raise ProfileError(f"profile {name!r}: unknown key {k!r} in [{key}]")
    value = table.get("temperature", _DEFAULT_TEMPERATURE[key])
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 2:
        raise ProfileError(f"profile {name!r}: [{key}] temperature must be a number from 0 to 2")
    return float(value)


def _mode(name: str, key: str, data: dict, base: contract.Limits) -> ModeSettings:
    changes: dict = {}
    pace_nudge = False
    submit_check = 0.0
    for field, value in _table(name, key, data).items():
        where = f"profile {name!r}: [{key}] {field}"
        if field == "pace_nudge" and key == "repo":
            if not isinstance(value, bool):
                raise ProfileError(f"{where} must be true or false")
            pace_nudge = value
        elif field == "submit_check" and key == "read":
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not 0 <= value <= 1:
                raise ProfileError(f"{where} must be a number from 0 (off) to 1")
            submit_check = float(value)
        elif field in _LIMIT_FIELDS:
            changes[field] = _limit(where, field, value)
        else:
            raise ProfileError(f"profile {name!r}: unknown key {field!r} in [{key}]")
    return ModeSettings(dataclasses.replace(base, **changes), pace_nudge, submit_check)


def _rlm(name: str, data: dict) -> RlmSettings:
    """The [rlm] table over RlmSettings' defaults. It needs agent_api, which brings rlm() into the REPL."""
    table = _table(name, "rlm", data)
    if table and data.get("agent_api") is not True:
        raise ProfileError(f"profile {name!r}: [rlm] needs agent_api = true")
    changes = {}
    for field, value in table.items():
        if field not in _RLM_FIELDS:
            raise ProfileError(f"profile {name!r}: unknown key {field!r} in [rlm]")
        least = 0 if field in ("max_depth", "max_runs") else 1  # max_runs = 0: no children (TUNABLE's lower bound)
        if isinstance(value, bool) or not isinstance(value, int) or value < least:
            raise ProfileError(f"profile {name!r}: [rlm] {field} must be an integer of at least {least}")
        changes[field] = value
    return RlmSettings(**changes)


def _compaction(name: str, data: dict) -> CompactionSettings | None:
    """The [compaction] table, or None when the profile has none. All four keys are required (v1 step 3)."""
    if "compaction" not in data:
        return None
    table = _table(name, "compaction", data)
    for field in table:
        if field not in _COMPACTION_FIELDS:
            raise ProfileError(f"profile {name!r}: unknown key {field!r} in [compaction]")
    missing = [field for field in _COMPACTION_FIELDS if field not in table]
    if missing:
        raise ProfileError(f"profile {name!r}: [compaction] is missing {', '.join(missing)}")

    def integer(field: str, least: int, most: int | None = None) -> int:
        value = table[field]
        if isinstance(value, bool) or not isinstance(value, int) or value < least or (most is not None and value > most):
            span = f"from {least:,} to {most:,}" if most is not None else f"of at least {least:,}"
            raise ProfileError(f"profile {name!r}: [compaction] {field} must be an integer {span}")
        return value

    keep_ratio = table["keep_ratio"]
    if isinstance(keep_ratio, bool) or not isinstance(keep_ratio, (int, float)) or not 0 < keep_ratio <= 0.5:
        raise ProfileError(f"profile {name!r}: [compaction] keep_ratio must be a number above 0 and at most 0.5")
    return CompactionSettings(window=integer("window", 4096, 4_194_304), keep_ratio=float(keep_ratio),
                              reserve=integer("reserve", 0), summary_max_tokens=integer("summary_max_tokens", 256, 32768))


def _limit(where: str, field: str, value: object) -> object:
    if field == "cpus":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not value > 0:
            raise ProfileError(f"{where} must be a positive number")
        return float(value)
    if field == "subcall_thinking":
        if not isinstance(value, str) or value not in _THINKING:
            raise ProfileError(f"{where} must be one of {', '.join(_THINKING)}")
        return _THINKING[value]
    if field == "subcall_oversize":
        if not isinstance(value, str) or value not in _OVERSIZE:
            raise ProfileError(f"{where} must be one of {', '.join(_OVERSIZE)}")
        return value
    least = 0 if field == "max_subcalls" else 1
    if isinstance(value, bool) or not isinstance(value, int) or value < least:
        raise ProfileError(f"{where} must be an integer of at least {least}")
    if field == "output_max_chars" and value > contract.OUTPUT_MAX_CHARS:
        # The REPL keeps at most contract.OUTPUT_MAX_CHARS of a cell's output (worker.py's frozen cap), so a larger
        # cap could never be met.
        raise ProfileError(f"{where} must be at most {contract.OUTPUT_MAX_CHARS:,}, the most a cell's output keeps")
    return value


# ----------------------------------------------------------------------------- the tuner's checks (v1 step 6)


def effective(profile: Profile) -> dict[str, object]:
    """Every dotted key a profile.toml can set, with the value this profile runs with (defaults filled). A level
    of `off` reads "off", and a profile without [compaction] has None for its four keys. `guidance` (the file name)
    is left out: the text is compared on its own."""
    out: dict[str, object] = {"contract": contract.CONTRACT_VERSION, "cache_api": profile.cache_api,
                              "agent_api": profile.agent_api, "root.temperature": profile.root_temperature,
                              "sub.temperature": profile.sub_temperature}
    for mode in ("read", "repo"):
        limits = profile.mode(mode).limits
        for key in _LIMIT_FIELDS:
            value = getattr(limits, key)
            out[f"{mode}.{key}"] = (value or "off") if key == "subcall_thinking" else value
    out["read.submit_check"] = profile.read.submit_check  # [read] only (D-251)
    out["repo.pace_nudge"] = profile.repo.pace_nudge  # [repo] only
    for key in _RLM_FIELDS:
        out[f"rlm.{key}"] = getattr(profile.rlm, key)
    settings = getattr(profile, "compaction", None)
    for key in _COMPACTION_FIELDS:
        out[f"compaction.{key}"] = getattr(settings, key) if settings is not None else None
    return out


def changed(base: Profile, candidate: Profile) -> list[str]:
    """profile.check's `changed`: the sorted dotted keys whose effective values differ, then "guidance" when the
    text differs, then the sorted paths of skill, script, agent and nudges.toml files added, removed or changed."""
    a, b = effective(base), effective(candidate)
    keys = sorted(k for k in set(a) | set(b) if _differs(a.get(k), b.get(k)))
    if base.guidance != candidate.guidance:
        keys.append("guidance")
    keys += sorted(p for p in set(base.files) | set(candidate.files) if base.files.get(p) != candidate.files.get(p))
    return keys


def check_tunable(base: Profile, candidate: Profile, gated: bool = False) -> list[str]:
    """The problems that make `candidate` an invalid edit of `base` (v1 §7.2, D-207), one line each; [] when it is
    valid. A changed key outside TUNABLE is frozen; a changed TUNABLE key must be within its bound; then
    `check_files`' rules for the candidate's guidance and files. `gated` (or GATED) allows agents/ and nudges.toml."""
    problems = []
    if base.name == "training-v4":
        problems.append("training-v4 is never a base")
    a, b = effective(base), effective(candidate)
    for key in sorted(set(a) | set(b)):
        if not _differs(a.get(key), b.get(key)):
            continue
        if key not in TUNABLE:
            problems.append(f"{key} is frozen")
            continue
        problem = _out_of_bounds(key, b.get(key), TUNABLE[key])
        if problem:
            problems.append(problem)
    return problems + check_files(candidate, gated=gated)


def check_files(profile: Profile, gated: bool = False) -> list[str]:
    """§7.2's rules for a candidate folder on its own: the guidance's size; every file UTF-8 with LF ends and no NUL,
    and none but profile.toml, guidance.md, skills/<name>/SKILL.md, scripts/<name>.py and, with the gate,
    agents/<name>/AGENT.md and nudges.toml; the skill, script, agent and nudge names, counts and sizes; every skill
    (and agent) named in guidance.md; every scripts/<name>.py that guidance.md or a skill names present; every script
    compiling and importing only the standard library. Never raises for anything in the folder."""
    problems: list[str] = []
    gated = gated or GATED
    folder = profile.path
    if len(profile.guidance) > GUIDANCE_MAX_CHARS:
        problems.append(f"guidance.md is {len(profile.guidance):,} characters: must be at most {GUIDANCE_MAX_CHARS:,}")
    found: dict[str, dict[str, str]] = {"skill": {}, "script": {}, "agent": {}}  # name -> decoded text
    nudges_file = False
    for path in sorted((p for p in folder.rglob("*") if p.is_file()), key=lambda p: p.relative_to(folder).as_posix()):
        rel = path.relative_to(folder).as_posix()
        try:
            raw = path.read_bytes()
        except OSError as err:
            problems.append(f"{rel} cannot be read: {err.strerror or err}")
            continue
        kind = next((k for k, pattern in _FILE_RES.items() if pattern.fullmatch(rel)), None)
        if kind == "agent" or rel == "nudges.toml":
            if not gated:
                problems.append(f"{rel}: agents/ and nudges.toml are behind the gate (D-234); only rlmh tune --gated "
                                "may change them")
                continue
        elif kind is None and rel not in ("profile.toml", "guidance.md"):
            problems.append(f"{rel} is not a file a profile may hold")
            continue
        if b"\r" in raw:
            problems.append(f"{rel} has a CR: line ends must be LF")
        if b"\x00" in raw:
            problems.append(f"{rel} holds a NUL")
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            problems.append(f"{rel} is not UTF-8")
            continue
        if rel == "nudges.toml":
            nudges_file = True
        elif kind is not None:
            found[kind][_FILE_RES[kind].fullmatch(rel).group(1)] = text
    guidance = profile.guidance
    problems += _skill_problems(found["skill"], profile, guidance)
    problems += _script_problems(found["script"], found["skill"], guidance)
    if gated:
        problems += _agent_problems(found["agent"], profile, guidance)
        if nudges_file:
            problems += _nudge_problems(profile.nudges)
    return problems


def _skill_problems(skills: dict[str, str], profile: Profile, guidance: str) -> list[str]:
    problems = []
    if len(skills) > MAX_SKILLS:
        problems.append(f"{len(skills)} skills: at most {MAX_SKILLS}")
    for name, text in skills.items():
        rel = f"skills/{name}/SKILL.md"
        if not _SKILL_RE.fullmatch(name):
            problems.append(f"skill name {name!r} must match {SKILL_NAME}")
        if len(text) > SKILL_MAX_CHARS:
            problems.append(f"{rel} is {len(text):,} characters: must be at most {SKILL_MAX_CHARS:,}")
        skill = profile.skills.get(name)
        if skill is not None and (not skill.description.strip() or "\n" in skill.description):
            problems.append(f"{rel} needs a one-line description in its front matter")
        if name not in guidance:
            problems.append(f"skill {name!r} is not named in guidance.md (its trigger line)")
    return problems


def _script_problems(scripts: dict[str, str], skills: dict[str, str], guidance: str) -> list[str]:
    problems = []
    if len(scripts) > MAX_SCRIPTS:
        problems.append(f"{len(scripts)} scripts: at most {MAX_SCRIPTS}")
    for where, text in (("guidance.md", guidance), *((f"skills/{n}/SKILL.md", t) for n, t in skills.items())):
        for name in dict.fromkeys(_NAMED_SCRIPT_RE.findall(text)):
            if name not in scripts:
                problems.append(f"{where} names scripts/{name}.py, which the profile does not hold")
    for name, source in scripts.items():
        rel = f"scripts/{name}.py"
        if not (_SCRIPT_RE.fullmatch(name) and name.isidentifier()) or keyword.iskeyword(name):
            problems.append(f"script name {name!r} must be a lowercase Python identifier ({SCRIPT_NAME})")
        elif name in sys.stdlib_module_names:
            problems.append(f"script name {name!r} is a standard-library module")
        elif name in REPL_NAMES:
            problems.append(f"script name {name!r} is a REPL name")
        if len(source) > SCRIPT_MAX_CHARS:
            problems.append(f"{rel} is {len(source):,} characters: must be at most {SCRIPT_MAX_CHARS:,}")
        try:
            tree = compile(source, rel, "exec", flags=ast.PyCF_ONLY_AST, dont_inherit=True)
            compile(tree, rel, "exec", dont_inherit=True)
        except SyntaxError as err:
            problems.append(f"{rel} does not compile: {err.msg} (line {err.lineno})")
            continue
        except (ValueError, TypeError, RecursionError, MemoryError) as err:
            problems.append(f"{rel} does not compile: {err}")
            continue
        for module in _imports(tree):
            if module is None:
                problems.append(f"{rel} uses a relative import; scripts import only the standard library")
            elif module != "__future__" and module not in sys.stdlib_module_names:
                problems.append(f"{rel} imports {module}, which is not in the standard library")
    return problems


def _imports(tree: ast.AST) -> list[str | None]:
    """The top-level module of every import in `tree`, in order, once each; None for a relative import."""
    out: list[str | None] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            out += [alias.name.split(".")[0] for alias in node.names]
        elif isinstance(node, ast.ImportFrom):
            out.append(None if node.level else (node.module or "").split(".")[0])
    return list(dict.fromkeys(out))


def _agent_problems(agents: dict[str, str], profile: Profile, guidance: str) -> list[str]:
    problems = []
    if len(agents) > MAX_AGENTS:
        problems.append(f"{len(agents)} agents: at most {MAX_AGENTS}")
    for name, text in agents.items():
        rel = f"agents/{name}/AGENT.md"
        if not _SKILL_RE.fullmatch(name):
            problems.append(f"agent name {name!r} must match {SKILL_NAME}")
        if len(text) > AGENT_MAX_CHARS:
            problems.append(f"{rel} is {len(text):,} characters: must be at most {AGENT_MAX_CHARS:,}")
        agent = profile.agents.get(name)
        if agent is not None and (not agent.description.strip() or "\n" in agent.description):
            problems.append(f"{rel} needs a one-line description in its front matter")
        if name not in guidance:
            problems.append(f"agent {name!r} is not named in guidance.md")
    return problems


def _nudge_problems(nudges: tuple[Nudge, ...]) -> list[str]:
    """The rule count; each rule's own bounds are checked when nudges.toml loads, and again here."""
    problems = []
    if len(nudges) > MAX_NUDGES:
        problems.append(f"nudges.toml has {len(nudges)} rules: at most {MAX_NUDGES}")
    for i, rule in enumerate(nudges, 1):
        if len(rule.hint) > NUDGE_HINT_MAX:
            problems.append(f"nudges.toml rule {i}: hint is {len(rule.hint):,} characters: at most {NUDGE_HINT_MAX}")
        if rule.pattern is not None and len(rule.pattern) > NUDGE_PATTERN_MAX:
            problems.append(f"nudges.toml rule {i}: pattern is {len(rule.pattern):,} characters: at most "
                            f"{NUDGE_PATTERN_MAX}")
        for key, (lo, hi) in (("turns", NUDGE_TURNS), ("chars", NUDGE_CHARS)):
            value = getattr(rule, key)
            if value is not None and not lo <= value <= hi:
                problems.append(f"nudges.toml rule {i}: {key} = {value}: must be {lo} to {hi}")
    return problems


def _differs(a: object, b: object) -> bool:
    """Whether two effective values differ; a bool never equals a number here (True == 1 in Python)."""
    return a != b or isinstance(a, bool) != isinstance(b, bool)


def _out_of_bounds(key: str, value: object, bound: object) -> str | None:
    """`<key> = <value>: must be <lo> to <hi>` (or the bool or enum form) when `value` is outside `bound`."""
    shown = _shown_value(value)
    if bound is bool:
        return None if isinstance(value, bool) else f"{key} = {shown}: must be true or false"
    assert isinstance(bound, tuple)
    if all(isinstance(b, str) for b in bound):
        return None if value in bound else f"{key} = {shown}: must be one of {', '.join(bound)}"
    lo, hi = bound
    number = (int, float) if isinstance(lo, float) else (int,)
    ok = isinstance(value, number) and not isinstance(value, bool) and lo <= value <= hi
    return None if ok else f"{key} = {shown}: must be {lo} to {hi}"


def _shown_value(value: object) -> str:
    if value is None:
        return "(not set)"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    return repr(value)


# ----------------------------------------------------------------------------- warnings


def _warn_shadowed(folder: Path) -> None:
    _warn(f"the user profile in {folder} is ignored: a built-in profile is named {folder.name!r}")


def _warn(message: str) -> None:
    """Once per process, on stderr: stdout carries only the protocol."""
    if message in _warned:
        return
    _warned.add(message)
    print(f"rlm_engine WARNING {__name__}: {message}", file=sys.stderr, flush=True)
