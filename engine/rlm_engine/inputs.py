"""KV cache: builds `context` and the first message's numbers once, before the first request.

What a run is given to work on: the model's `context` string, and in repo mode the language, file count and test
command that go into the first message (architecture §6.3, decisions D-07, D-10, D-11). `prepare` fills these in
a `RunSpec` before the first request and never again, so the first message's bytes stay the same for the whole run.

`FALLBACK_SKIP_DIRS` and the walk in `_walk` are copied from training's rlm_rl/repl_tools.py (`_files_under`) at
RLM commit 0b9af69, and `repo_context` is training's `_context` from rlm_rl/tasks/editreal.py at the same commit.
The git listing is `_files_under`'s, with the engine's rules for running git (workspace.GIT_ARGS, no prompts).
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
from collections import Counter
from collections.abc import Callable, Sequence
from pathlib import Path, PurePath, PurePosixPath
from typing import TYPE_CHECKING

from . import contract
from .workspace import GIT_ARGS

if TYPE_CHECKING:  # loop.py imports this module, so the import must not run
    from .loop import RunSpec

# Searched only when the repository has no git to read .gitignore from (a private copy of training's list).
FALLBACK_SKIP_DIRS = frozenset({".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", ".mypy_cache",
                                ".pytest_cache", ".gradle"})

GIT_LIST_TIMEOUT_S = 120
NO_TEST_COMMAND = "no test command found; look for one in the repository"
_NO_WINDOW = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0

# extension -> language, for detect_language
LANGUAGES = {
    ".py": "python", ".go": "go", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript",
    ".cjs": "javascript", ".ts": "typescript", ".tsx": "typescript", ".rs": "rust", ".java": "java", ".rb": "ruby",
    ".php": "php", ".c": "c", ".h": "c", ".cc": "c++", ".cpp": "c++", ".hpp": "c++", ".cs": "c#", ".kt": "kotlin",
    ".swift": "swift",
}


class InputError(Exception):
    """An input the run cannot start from: a missing or unreadable file, a relative path, no inputs at all. The
    service turns it into error -32012."""


# ----------------------------------------------------------------------------- read mode


def _read_file(path: PurePath) -> str:
    """One input file's text: UTF-8 with bad bytes replaced by U+FFFD, CRLF and a BOM kept as they are (D-10)."""
    real = Path(path)
    if not real.is_absolute():
        raise InputError(f"input path must be absolute: {path}")
    if not real.is_file():
        raise InputError(f"input is not a file or does not exist: {path}")
    try:
        with open(real, encoding="utf-8", errors="replace", newline="") as f:
            return f.read()
    except OSError as exc:
        raise InputError(f"cannot read {path}: {exc}") from exc


def join_context(paths: Sequence[PurePath], texts: Sequence[str]) -> str:
    """The `context` for already-read files. One file is its text; several are `=== <path> ===\\n<text>` parts,
    paths with `/` separators on every OS, joined by a blank line (D-10)."""
    if len(texts) == 1:
        return texts[0]
    return "\n\n".join(f"=== {p.as_posix()} ===\n{t}" for p, t in zip(paths, texts))


def read_context(paths: Sequence[Path]) -> str:
    """The `context` of a read-mode run (D-10). Raises InputError for an empty list, a relative path, or a path
    that is missing, a folder or unreadable."""
    items = [p if isinstance(p, PurePath) else Path(p) for p in paths]
    if not items:
        raise InputError("a read-mode run needs at least one input file")
    return join_context(items, [_read_file(p) for p in items])


# ----------------------------------------------------------------------------- repo mode


def _git_names(repo: Path) -> list[str] | None:
    """Git's own file list for `repo`: tracked plus untracked, minus what .gitignore excludes, as raw `/` paths
    relative to `repo`. None when git is missing, times out or exits non-zero (not a work tree, say): the caller
    walks the folder instead."""
    git = shutil.which("git")
    if git is None:
        return None
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_NO_LAZY_FETCH": "1"}  # as workspace._git (D-63)
    try:
        done = subprocess.run([git, *GIT_ARGS, "-C", str(repo), "ls-files", "-z", "--cached", "--others",
                               "--exclude-standard"], capture_output=True, env=env, stdin=subprocess.DEVNULL,
                              creationflags=_NO_WINDOW, timeout=GIT_LIST_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError):  # FileNotFoundError, a timeout
        return None
    if done.returncode != 0:
        return None
    # surrogateescape keeps a name that is not UTF-8 usable for os.stat on POSIX; clean_text then makes it printable
    return [n for n in done.stdout.decode("utf-8", "surrogateescape").split("\0") if n]


def _walk(repo: Path) -> list[str]:
    """Every file name under `repo` as `/` paths, skipping the usual dependency and cache folders."""
    found: list[str] = []
    for dirpath, dirnames, filenames in os.walk(repo):
        dirnames[:] = sorted(d for d in dirnames if d not in FALLBACK_SKIP_DIRS)
        rel = os.path.relpath(dirpath, repo)
        prefix = "" if rel == "." else rel.replace(os.sep, "/") + "/"
        found += [prefix + name for name in filenames]
    return found


def repo_files(repo: Path) -> list[tuple[str, int]]:
    """`(path, size in bytes)` for each real file in `repo`, sorted by path, `/` separators (D-11).

    Inside a git work tree it is git's list (tracked plus untracked, minus .gitignore); otherwise, or when git is
    missing or fails, a walk of the folder that skips FALLBACK_SKIP_DIRS. A name git lists that is no longer a
    regular file (a deleted tracked file, a symlinked folder, a submodule) is dropped. Sizes come from `os.stat`.
    Raises InputError when `repo` is not a folder.
    """
    repo = Path(repo)
    if not repo.is_dir():
        raise InputError(f"repository path is not a folder: {repo}")
    names = _git_names(repo)
    if names is None:
        names = _walk(repo)
    base = str(repo)
    files: list[tuple[str, int]] = []
    for name in names:
        try:
            st = os.stat(os.path.join(base, name))
        except (OSError, ValueError):  # gone, unreadable, or a name this OS cannot encode
            continue
        if stat.S_ISREG(st.st_mode):
            files.append((contract.clean_text(name), st.st_size))
    return sorted(files)


def repo_context(task: str, files: Sequence[tuple[str, int]]) -> str:
    """The `context` of a repo-mode run: the task, then the file list with sizes (training's `_context`)."""
    listing = "\n".join(f"{p}  {s:,}" for p, s in files)
    return f"{task}\n\nRepository files (path, size in bytes):\n{listing}\n"


def detect_language(files: Sequence[tuple[str, int]]) -> str:
    """The language with the most files among those whose extension is known (LANGUAGES, counted per language, so
    `.js` and `.jsx` add up); ties go to the name that sorts first. "unknown" when no file has a known extension."""
    counts = Counter(LANGUAGES[ext] for ext in (PurePosixPath(p).suffix.lower() for p, _ in files) if ext in LANGUAGES)
    if not counts:
        return "unknown"
    return min(counts, key=lambda lang: (-counts[lang], lang))


def _package_json(repo: Path, names: set[str]) -> dict | None:
    if "package.json" not in names:
        return None
    try:
        data = json.loads((repo / "package.json").read_text(encoding="utf-8", errors="replace"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _rule_npm(repo: Path, names: set[str]) -> str | None:
    pkg = _package_json(repo, names)
    scripts = pkg.get("scripts") if pkg else None
    test = scripts.get("test") if isinstance(scripts, dict) else None
    return "npm test" if isinstance(test, str) and test.strip() else None


def _rule_npx(repo: Path, names: set[str]) -> str | None:
    pkg = _package_json(repo, names)
    if not pkg:
        return None
    deps = [pkg.get(key) for key in ("dependencies", "devDependencies")]
    for runner in ("vitest", "jest", "mocha"):
        if any(isinstance(d, dict) and runner in d for d in deps):
            return f"npx {runner}"
    return None


def _rule_pytest(repo: Path, names: set[str]) -> str | None:
    markers = ("pytest.ini", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "conftest.py")
    return "python -m pytest -q" if any(m in names for m in markers) else None


def _rule_go(repo: Path, names: set[str]) -> str | None:
    return "go test ./..." if "go.mod" in names else None


def _rule_cargo(repo: Path, names: set[str]) -> str | None:
    return "cargo test" if "Cargo.toml" in names else None


def _rule_maven(repo: Path, names: set[str]) -> str | None:
    return "mvn -o -q test" if "pom.xml" in names else None


def _rule_gradle(repo: Path, names: set[str]) -> str | None:
    if "build.gradle" not in names and "build.gradle.kts" not in names:
        return None
    return "./gradlew test --offline" if "gradlew" in names else "gradle test --offline"


def _rule_make(repo: Path, names: set[str]) -> str | None:
    if "Makefile" not in names:
        return None
    try:
        text = (repo / "Makefile").read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return "make test" if re.search(r"^test[ \t]*:(?!=)", text, re.MULTILINE) else None


# The rules in the order the spec gives them. A language's own rules are tried before the rest.
_RULES: tuple[Callable[[Path, set[str]], str | None], ...] = (
    _rule_npm, _rule_npx, _rule_pytest, _rule_go, _rule_cargo, _rule_maven, _rule_gradle, _rule_make,
)
_OWN_RULES: dict[str, tuple[Callable[[Path, set[str]], str | None], ...]] = {
    "javascript": (_rule_npm, _rule_npx), "typescript": (_rule_npm, _rule_npx), "python": (_rule_pytest,),
    "go": (_rule_go,), "rust": (_rule_cargo,), "java": (_rule_maven, _rule_gradle),
    "kotlin": (_rule_gradle, _rule_maven), "c": (_rule_make,), "c++": (_rule_make,),
}


def detect_test_hint(repo: Path, files: Sequence[tuple[str, int]], language: str) -> str:
    """The command that probably runs the repository's tests: the first rule that matches wins, those for
    `language` first. Only files at the repository root count. `NO_TEST_COMMAND` when nothing matches."""
    repo = Path(repo)
    names = {p for p, _ in files if "/" not in p}
    ordered = [*_OWN_RULES.get(language, ()), *_RULES]
    for rule in ordered:
        hint = rule(repo, names)
        if hint:
            return hint
    return NO_TEST_COMMAND


# ----------------------------------------------------------------------------- the run's inputs


def prepare(spec: RunSpec) -> None:
    """Fill the `None` fields of `spec` in place: `context` in read mode, and `context`, `language`, `n_files` and
    `test_hint` in repo mode (D-07). Fields that are already set are left alone, git is not touched when all four
    are set, and a second call changes nothing. Returns nothing. Raises InputError."""
    if spec.mode == "read":
        if spec.context is None:
            spec.context = read_context(spec.inputs)
        return
    if spec.mode != "repo":
        raise InputError(f"unknown mode {spec.mode!r}")
    wanted = (spec.context, spec.language, spec.n_files, spec.test_hint)
    if all(v is not None for v in wanted):
        return
    if spec.repo_path is None:
        raise InputError("a repo-mode run needs a repository path")
    if spec.context is None and spec.task is None:
        raise InputError("a repo-mode run needs a task")
    files = repo_files(spec.repo_path)
    if spec.language is None:
        spec.language = detect_language(files)
    if spec.n_files is None:
        spec.n_files = len(files)
    if spec.test_hint is None:
        spec.test_hint = detect_test_hint(spec.repo_path, files, spec.language)
    if spec.context is None:
        spec.context = repo_context(spec.task, files)
