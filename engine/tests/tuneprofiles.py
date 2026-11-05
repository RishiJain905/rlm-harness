"""KV cache: none

Candidate profiles for the v1 step 6 tests (test_profile_check, test_profile_files, test_gated): a copy of a
built-in's folder with TOML keys edited a line at a time (as the app's `editToml` does), the guidance replaced or
extended, and skill, script, agent and nudges.toml files added or removed.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

from rlm_engine.profiles import BUILTIN_DIR

SKILL = "fixture-recipe"
SCRIPT = "fixture_tool"
SCRIPT_SOURCE = "import json\n\n\ndef double(x):\n    return json.loads(json.dumps(x)) * 2\n"
TRIGGER = f"\n\nFor a fixture task, call skill(\"{SKILL}\") first; it uses scripts/{SCRIPT}.py."


def toml_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value)
    return repr(value)


def edit_toml(text: str, edits: dict[str, object]) -> str:
    """Replace `key = …` in its table (keeping a trailing comment), insert a missing key after the table's header,
    append a missing table; top-level keys go before the first table."""
    lines = text.split("\n")
    for dotted, value in edits.items():
        table, _, key = dotted.rpartition(".")
        line = f"{key} = {toml_value(value)}"
        section, header, done = "", None, False
        first_table = next((i for i, l in enumerate(lines) if l.startswith("[")), len(lines))
        for i, raw in enumerate(lines):
            if raw.startswith("["):
                section = raw.split("]")[0].strip("[")
                if section == table:
                    header = i
                continue
            if section == table and raw.split("=")[0].strip() == key and "=" in raw:
                comment = raw[raw.index("#"):] if "#" in raw else ""
                lines[i] = f"{line}  {comment}".rstrip()
                done = True
                break
        if done:
            continue
        if not table:
            lines.insert(first_table, line)
        elif header is not None:
            lines.insert(header + 1, line)
        else:
            lines += [f"[{table}]", line]
    return "\n".join(lines)


def make_profile(root: Path, name: str, *, base: str = "default", toml: dict[str, object] | None = None,
                 guidance: str | None = None, add_guidance: str = "", files: dict[str, str | bytes | None] | None = None,
                 raw_toml: str | None = None) -> Path:
    """`<root>/<name>/`: the built-in `base`'s files, then the edits. `files` maps a path in the folder to its text
    (written as UTF-8 bytes, LF as given), bytes, or None (removed)."""
    folder = root / name
    if folder.exists():
        shutil.rmtree(folder)
    shutil.copytree(BUILTIN_DIR / base, folder)
    text = (folder / "profile.toml").read_text(encoding="utf-8")
    if raw_toml is not None:
        text = raw_toml
    (folder / "profile.toml").write_bytes(edit_toml(text, toml or {}).encode("utf-8"))
    if guidance is not None or add_guidance:
        old = (folder / "guidance.md").read_text(encoding="utf-8") if (folder / "guidance.md").is_file() else ""
        (folder / "guidance.md").write_bytes(((guidance if guidance is not None else old) + add_guidance).encode("utf-8"))
    for rel, content in (files or {}).items():
        path = folder / rel
        if content is None:
            path.unlink()
            if path.parent != folder and not any(path.parent.iterdir()):
                path.parent.rmdir()
            continue
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content if isinstance(content, bytes) else content.encode("utf-8"))
    return folder


def skill_md(name: str, description: str = "How to do a fixture task.", body: str = "Step one: look. Step two: act.") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n{body}\n"


def agent_md(name: str, description: str = "Reads a long input and answers briefly.",
             body: str = "You read the text you are given and answer in one line.") -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n{body}\n"


def with_skill_and_script(root: Path, name: str, **kwargs: object) -> Path:
    """`default` plus the fixture skill and script, both named on a guidance trigger line."""
    files = {f"skills/{SKILL}/SKILL.md": skill_md(SKILL, body=f"Import {SCRIPT} and call double(x)."),
             f"scripts/{SCRIPT}.py": SCRIPT_SOURCE}
    files.update(kwargs.pop("files", None) or {})  # type: ignore[arg-type]
    return make_profile(root, name, add_guidance=TRIGGER + str(kwargs.pop("add_guidance", "")), files=files,
                        **kwargs)  # type: ignore[arg-type]
