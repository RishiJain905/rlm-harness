"""KV cache: builds the system prompt and limits from files; a profile is read once per run and its text is fixed from then on.

A profile is a folder holding `profile.toml` and an optional guidance file appended to the system prompt
(v0-design § Profiles). Built-ins live next to this file; user profiles in `<home>/profiles/<name>`, and a
built-in wins over a user profile of the same name (D-34). Each mode table starts from training's v4 limits and
replaces only the keys it lists (D-09), so `training-v4` hashes to `contract.TRAINING_HASH`. Files are read as
bytes with CRLF turned into LF before decoding, so a Windows checkout gives the same prompts and hashes (D-43).
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
import sys
import tomllib
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath

from . import contract

BUILTIN_DIR = Path(__file__).resolve().parent / "profiles"

_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}")
_TOP_KEYS = ("contract", "guidance", "root", "sub", "read", "repo")
_LIMIT_FIELDS = tuple(f.name for f in dataclasses.fields(contract.Limits))
_THINKING = {"off": None, "low": "low", "medium": "medium", "high": "high"}  # TOML has no null: off means none
_OVERSIZE = ("truncate", "error")
_DEFAULT_TEMPERATURE = {"root": 1.0, "sub": 0.3}
_warned: set[str] = set()


class ProfileError(ValueError):
    """A profile that fails to parse; step 6 maps it to -32011."""


class UnknownProfile(ProfileError):
    """No profile of that name, or a name that is not safe as a folder name; -32011."""


@dataclass(frozen=True)
class ModeSettings:
    limits: contract.Limits
    pace_nudge: bool


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
        """sha256 of the LF-normalised profile.toml, a NUL byte, and the guidance file; re-read on each call."""
        toml_bytes = _read(self.name, self.path / "profile.toml")
        guidance_path = _guidance_path(self.name, self.path, _parse(self.name, toml_bytes).get("guidance", ""))
        guidance_bytes = _read(self.name, guidance_path) if guidance_path else b""
        return hashlib.sha256(toml_bytes + b"\x00" + guidance_bytes).hexdigest()

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
    data = _parse(name, _read(name, folder / "profile.toml"))
    for key in data:
        if key not in _TOP_KEYS:
            raise ProfileError(f"profile {name!r}: unknown key {key!r}")
    if "contract" not in data:
        raise ProfileError(f"profile {name!r}: missing key 'contract'")
    if data["contract"] != contract.CONTRACT_VERSION:
        raise ProfileError(f"profile {name!r}: contract must be {contract.CONTRACT_VERSION!r}, not {data['contract']!r}")
    guidance_path = _guidance_path(name, folder, data.get("guidance", ""))
    guidance = ""
    if guidance_path:
        guidance = _decode(name, f"guidance file {guidance_path.name!r}", _read(name, guidance_path)).strip()
    return Profile(
        name=name,
        source=source,
        path=folder,
        guidance=guidance,
        root_temperature=_temperature(name, "root", data),
        sub_temperature=_temperature(name, "sub", data),
        read=_mode(name, "read", data, contract.READ_LIMITS_V4),
        repo=_mode(name, "repo", data, contract.EDIT_LIMITS_V4),
    )


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
    for field, value in _table(name, key, data).items():
        where = f"profile {name!r}: [{key}] {field}"
        if field == "pace_nudge" and key == "repo":
            if not isinstance(value, bool):
                raise ProfileError(f"{where} must be true or false")
            pace_nudge = value
        elif field in _LIMIT_FIELDS:
            changes[field] = _limit(where, field, value)
        else:
            raise ProfileError(f"profile {name!r}: unknown key {field!r} in [{key}]")
    return ModeSettings(dataclasses.replace(base, **changes), pace_nudge)


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
    return value


# ----------------------------------------------------------------------------- warnings


def _warn_shadowed(folder: Path) -> None:
    _warn(f"the user profile in {folder} is ignored: a built-in profile is named {folder.name!r}")


def _warn(message: str) -> None:
    """Once per process, on stderr: stdout carries only the protocol."""
    if message in _warned:
        return
    _warned.add(message)
    print(f"rlm_engine WARNING {__name__}: {message}", file=sys.stderr, flush=True)
