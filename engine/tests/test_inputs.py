"""KV cache: none

inputs.py: the read-mode `context` (D-10), the repo-mode file list, language and test command (D-07, D-11), and
`prepare` filling a run spec. `prepare` is tested on a small stand-in with the RunSpec field names, so this file
does not depend on loop.py. The expected `repo_context` strings were produced by running training's `_context`
(rlm_rl/tasks/editreal.py at 0b9af69) from a scratch copy, never typed by hand; test_repo_context_against_training
re-checks them against the training repo itself when RLM_TRAINING_REPO points at it.
"""

from __future__ import annotations

import ast
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path, PureWindowsPath

import pytest
from conftest import git, needs_git

from rlm_engine import contract, inputs
from rlm_engine.inputs import InputError

TRAINING_COMMIT = "0b9af69"

# training's _context({"issue": "Fix the parser.", "files": TRAINING_FILES}) and the same with no files
TRAINING_FILES = [("README.md", 12), ("a b.txt", 1234), ("caf\u00e9.py", 0), ("src/big.bin", 1234567)]
TRAINING_CONTEXT = (
    "Fix the parser.\n\nRepository files (path, size in bytes):\nREADME.md  12\na b.txt  1,234\ncaf\u00e9.py  0\n"
    "src/big.bin  1,234,567\n"
)
TRAINING_EMPTY = "T\n\nRepository files (path, size in bytes):\n\n"


@dataclass
class Spec:
    """The fields of loop.RunSpec that prepare() reads or fills."""

    mode: str
    inputs: list[Path] = field(default_factory=list)
    task: str | None = None
    repo_path: Path | None = None
    question: str | None = None
    test_hint: str | None = None
    language: str | None = None
    n_files: int | None = None
    context: str | None = None


def write(root: Path, files: dict[str, str | bytes]) -> list[tuple[str, int]]:
    """Create `files` under `root`; returns the (name, size) list a listing would hold."""
    listing = []
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        data = content if isinstance(content, bytes) else content.encode("utf-8")
        path.write_bytes(data)
        listing.append((name, len(data)))
    return listing


# ----------------------------------------------------------------------------- read_context


def test_one_file_keeps_crlf_and_a_bom(tmp_path: Path) -> None:
    path = tmp_path / "a.txt"
    path.write_bytes(b"\xef\xbb\xbfone\r\ntwo\r\n\r\nthree")
    assert inputs.read_context([path]) == "\ufeffone\r\ntwo\r\n\r\nthree"


def test_one_file_turns_an_invalid_byte_into_the_replacement_character(tmp_path: Path) -> None:
    path = tmp_path / "a.txt"
    path.write_bytes(b"ab\xffcd\xc3")  # a stray byte, and a multibyte start cut off at the end
    assert inputs.read_context([path]) == "ab\ufffdcd\ufffd"
    path.write_bytes("caf\u00e9 \u2192 ok".encode("utf-8"))
    assert inputs.read_context([path]) == "caf\u00e9 \u2192 ok"


def test_one_file_has_no_header(tmp_path: Path) -> None:
    path = tmp_path / "a.txt"
    path.write_bytes(b"just the text\n")
    assert inputs.read_context([path]) == "just the text\n"
    path.write_bytes(b"")
    assert inputs.read_context([path]) == ""


def test_several_files_get_headers_and_blank_line_joins(tmp_path: Path) -> None:
    a, b, c = tmp_path / "a.txt", tmp_path / "sub" / "b.txt", tmp_path / "c.txt"
    b.parent.mkdir()
    a.write_bytes(b"A\r\n")
    b.write_bytes(b"B\n")
    c.write_bytes(b"")
    expected = f"=== {a.as_posix()} ===\nA\r\n\n\n=== {b.as_posix()} ===\nB\n\n\n=== {c.as_posix()} ===\n"
    assert inputs.read_context([a, b, c]) == expected
    assert "\\" not in a.as_posix() and "\\" not in expected.split("\n")[0]  # '/' separators on every OS


def test_several_files_headers_use_forward_slashes_for_windows_paths(monkeypatch: pytest.MonkeyPatch) -> None:
    paths = [PureWindowsPath("C:/data/a.txt"), PureWindowsPath(r"C:\data\sub\b.txt")]
    texts = {"C:/data/a.txt": "A\r\n", "C:/data/sub/b.txt": "B"}
    seen: list[str] = []

    def fake_read(path: PureWindowsPath) -> str:
        seen.append(path.as_posix())
        return texts[path.as_posix()]

    monkeypatch.setattr(inputs, "_read_file", fake_read)  # a Windows path cannot be opened on Linux
    assert inputs.read_context(paths) == "=== C:/data/a.txt ===\nA\r\n\n\n=== C:/data/sub/b.txt ===\nB"
    assert seen == ["C:/data/a.txt", "C:/data/sub/b.txt"]
    assert inputs.join_context(paths, ["x", "y"]) == "=== C:/data/a.txt ===\nx\n\n=== C:/data/sub/b.txt ===\ny"
    assert inputs.join_context(paths[:1], ["only"]) == "only"


def test_read_context_errors(tmp_path: Path) -> None:
    good = tmp_path / "good.txt"
    good.write_bytes(b"x")
    with pytest.raises(InputError, match="at least one"):
        inputs.read_context([])
    with pytest.raises(InputError, match="does not exist"):
        inputs.read_context([tmp_path / "missing.txt"])
    with pytest.raises(InputError, match="not a file"):
        inputs.read_context([tmp_path])
    with pytest.raises(InputError, match="absolute"):
        inputs.read_context([Path("relative.txt")])
    with pytest.raises(InputError):  # one bad file among good ones fails the whole list
        inputs.read_context([good, tmp_path / "missing.txt"])
    with pytest.raises(InputError):
        inputs.read_context([tmp_path / "missing.txt", good])


@pytest.mark.skipif(sys.platform == "win32" or (hasattr(os, "geteuid") and os.geteuid() == 0),
                    reason="needs a non-root POSIX user to make a file unreadable")
def test_an_unreadable_file_is_an_input_error(tmp_path: Path) -> None:
    path = tmp_path / "secret.txt"
    path.write_bytes(b"x")
    path.chmod(0)
    try:
        with pytest.raises(InputError, match="cannot read"):
            inputs.read_context([path])
    finally:
        path.chmod(0o600)


# ----------------------------------------------------------------------------- repo_files


def build_repo(root: Path) -> dict[str, int]:
    """The conftest `git_repo` content plus an untracked file, an ignored file, a deleted tracked file, a tracked
    name with a space, an untracked non-ASCII name and a 1,234-byte file. Returns what repo_files must list."""
    write(root, {"my file.txt": "spaced\n", "big.dat": b"x" * 1234})
    git(root, "add", "my file.txt")
    git(root, "commit", "-qm", "more")
    write(root, {"new.txt": "untracked\n", "caf\u00e9.py": "print()\n", "build/out.bin": b"ignored"})
    (root / "a.py").unlink()  # tracked, then deleted from the work tree
    return {".gitignore": 7, "README.md": 8, "big.dat": 1234, "caf\u00e9.py": 8, "my file.txt": 7, "new.txt": 10,
            "pkg/core.py": len("def parse(x):\n    return x\n")}


@needs_git
def test_git_listing(git_repo: Path) -> None:
    expected = build_repo(git_repo)
    got = inputs.repo_files(git_repo)
    assert got == sorted(expected.items())  # sorted, ignored build/out.bin and the deleted a.py are absent
    names = [name for name, _ in got]
    assert "a.py" not in names and "build/out.bin" not in names
    assert ("big.dat", 1234) in got
    assert all(isinstance(size, int) for _, size in got)
    listing = "\n".join(f"{p}  {s:,}" for p, s in got)
    assert "big.dat  1,234" in listing.splitlines()
    assert "my file.txt  7" in listing.splitlines() and "caf\u00e9.py  8" in listing.splitlines()


@needs_git
def test_git_listing_of_a_subfolder_is_relative_to_it(git_repo: Path) -> None:
    assert inputs.repo_files(git_repo / "pkg") == [("core.py", len("def parse(x):\n    return x\n"))]


@needs_git
def test_git_listing_skips_symlinked_folders(git_repo: Path) -> None:
    try:
        (git_repo / "linkdir").symlink_to(git_repo / "pkg", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("cannot create symlinks here")
    names = [name for name, _ in inputs.repo_files(git_repo)]
    assert "linkdir" not in names and not any(n.startswith("linkdir/") for n in names)
    assert "pkg/core.py" in names


@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="other file systems refuse or rewrite such names")
@needs_git
def test_git_listing_with_a_name_that_is_not_utf8(git_repo: Path) -> None:
    fd = os.open(os.fsencode(git_repo) + b"/bad\xffname.txt", os.O_WRONLY | os.O_CREAT)
    os.write(fd, b"xyz")
    os.close(fd)
    got = dict(inputs.repo_files(git_repo))
    assert got["bad?name.txt"] == 3  # sized from the real file, shown with clean_text's replacement


@needs_git
def test_git_output_never_reaches_stdout(git_repo: Path, tmp_path: Path, capfd: pytest.CaptureFixture[str]) -> None:
    inputs.repo_files(git_repo)
    inputs.repo_files(tmp_path)  # not a repository: git writes an error to its stderr
    seen = capfd.readouterr()
    assert seen.out == "" and seen.err == ""


def test_walk_skips_dependency_and_cache_folders_without_git(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "plain"
    write(root, {
        "main.py": "x", "src/deep/mod.py": "yy", "node_modules/pkg/index.js": "n", ".git/config": "c",
        "src/__pycache__/mod.pyc": "p", ".venv/lib/x.py": "v", "venv/y.py": "v", ".tox/t": "t", ".mypy_cache/m": "m",
        ".pytest_cache/p": "p", ".gradle/g": "g", "src/node_modules/z.js": "z", "docs/readme.md": "zzz",
        ".hidden": "h", "caf\u00e9/\u00fcber.txt": "u",
    })
    monkeypatch.setenv("PATH", "")  # no git at all
    assert inputs.repo_files(root) == [
        (".hidden", 1), ("caf\u00e9/\u00fcber.txt", 1), ("docs/readme.md", 3), ("main.py", 1), ("src/deep/mod.py", 2),
    ]


@needs_git
def test_a_folder_that_is_not_a_repository_is_walked(tmp_path: Path) -> None:
    root = tmp_path / "plain"  # git is on PATH but exits non-zero here
    write(root, {"a.txt": "a", "node_modules/b.js": "b", "sub/c.txt": "cc"})
    assert inputs.repo_files(root) == [("a.txt", 1), ("sub/c.txt", 2)]


@needs_git
def test_an_empty_path_falls_back_to_the_walk(git_repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    build_repo(git_repo)
    with_git = [n for n, _ in inputs.repo_files(git_repo)]
    assert "build/out.bin" not in with_git
    monkeypatch.setenv("PATH", "")
    walked = [n for n, _ in inputs.repo_files(git_repo)]
    assert "build/out.bin" in walked  # the walk does not read .gitignore ...
    assert not any(n.startswith(".git/") for n in walked)  # ... but it does skip .git
    assert "a.py" not in walked  # a deleted file is not on disk either way
    assert walked == sorted(walked)


def test_a_missing_or_failing_git_falls_back_to_the_walk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    root = tmp_path / "plain"
    write(root, {"a.txt": "a", "node_modules/b.js": "b"})
    monkeypatch.setattr(inputs.shutil, "which", lambda name: "/nonexistent/git")

    def boom(*args: object, **kwargs: object) -> None:
        raise exc

    monkeypatch.setattr(inputs.subprocess, "run", boom)
    for exc in (FileNotFoundError("git"), PermissionError("git"), subprocess.TimeoutExpired("git", 1)):
        assert inputs.repo_files(root) == [("a.txt", 1)]

    monkeypatch.setattr(inputs.subprocess, "run", lambda *a, **k: subprocess.CompletedProcess(a, 128, b"x\0", b"fatal"))
    assert inputs.repo_files(root) == [("a.txt", 1)]  # non-zero exit: whatever it printed is ignored


def test_repo_files_needs_a_folder(tmp_path: Path) -> None:
    (tmp_path / "f.txt").write_bytes(b"x")
    with pytest.raises(InputError):
        inputs.repo_files(tmp_path / "missing")
    with pytest.raises(InputError):
        inputs.repo_files(tmp_path / "f.txt")


def test_repo_files_drops_irregular_entries(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    write(tmp_path, {"real.txt": "abc", "gone/keep.txt": "k"})
    (tmp_path / "folder").mkdir()
    monkeypatch.setattr(inputs, "_git_names", lambda repo: ["real.txt", "gone.txt", "folder", "bad\udc80.txt", "gone/keep.txt"])
    assert inputs.repo_files(tmp_path) == [("gone/keep.txt", 1), ("real.txt", 3)]  # the missing and folder entries go
    write(tmp_path, {"odd\u2028name.txt": "q"})
    monkeypatch.setattr(inputs, "_git_names", lambda repo: ["odd\u2028name.txt"])
    assert inputs.repo_files(tmp_path) == [("odd\u2028name.txt", 1)]


# ----------------------------------------------------------------------------- repo_context


def test_repo_context_is_trainings_string() -> None:
    assert inputs.repo_context("Fix the parser.", TRAINING_FILES) == TRAINING_CONTEXT
    assert inputs.repo_context("T", []) == TRAINING_EMPTY
    assert inputs.repo_context("Fix the parser.", [list(f) for f in TRAINING_FILES]) == TRAINING_CONTEXT  # type: ignore[arg-type]


@pytest.mark.skipif(not os.environ.get("RLM_TRAINING_REPO"), reason="set RLM_TRAINING_REPO to the RLM checkout")
def test_repo_context_against_training() -> None:
    source = subprocess.run(["git", "-C", os.environ["RLM_TRAINING_REPO"], "show",
                             f"{TRAINING_COMMIT}:rlm_rl/tasks/editreal.py"], capture_output=True, check=True)
    tree = ast.parse(source.stdout.decode("utf-8"))
    keep = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_context"]
    assert len(keep) == 1
    namespace: dict = {}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "training_editreal", "exec"), namespace)
    for task, files in (("Fix the parser.", TRAINING_FILES), ("T", []), ("multi\nline\n", [("x", 1_000_000)])):
        theirs = namespace["_context"]({"issue": task, "files": files})
        assert inputs.repo_context(task, files) == theirs
    assert namespace["_context"]({"issue": "Fix the parser.", "files": TRAINING_FILES}) == TRAINING_CONTEXT
    assert namespace["_context"]({"issue": "T", "files": []}) == TRAINING_EMPTY


# ----------------------------------------------------------------------------- detect_language


def named(*names: str) -> list[tuple[str, int]]:
    return [(n, 1) for n in names]


def test_language_is_the_most_common_known_extension() -> None:
    assert inputs.detect_language(named("a.py", "b.py", "c.go", "README.md", "d.txt", "e.json", "f.yaml")) == "python"
    assert inputs.detect_language(named("a.go", "src/b.go", "src/c.go", "x.py")) == "go"
    assert inputs.detect_language(named("a.rs")) == "rust"


def test_language_ties_go_to_the_name_that_sorts_first() -> None:
    assert inputs.detect_language(named("a.py", "b.go")) == "go"
    assert inputs.detect_language(named("a.rs", "b.py", "c.java", "d.rb")) == "java"
    assert inputs.detect_language(named("a.ts", "b.js")) == "javascript"


def test_language_unknown() -> None:
    assert inputs.detect_language([]) == "unknown"
    assert inputs.detect_language(named("README.md", "Makefile", "data.json", ".py", "py", "a.pyc")) == "unknown"


def test_language_map_and_counting() -> None:
    expected = {
        "a.py": "python", "a.go": "go", "a.js": "javascript", "a.jsx": "javascript", "a.mjs": "javascript",
        "a.cjs": "javascript", "a.ts": "typescript", "a.tsx": "typescript", "a.rs": "rust", "a.java": "java",
        "a.rb": "ruby", "a.php": "php", "a.c": "c", "a.h": "c", "a.cc": "c++", "a.cpp": "c++", "a.hpp": "c++",
        "a.cs": "c#", "a.kt": "kotlin", "a.swift": "swift",
    }
    for name, language in expected.items():
        assert inputs.detect_language(named(name)) == language, name
    assert len(inputs.LANGUAGES) == len(expected)
    # variants of one language add up: 2 .js + 2 .jsx (4) beat 3 .py
    assert inputs.detect_language(named("a.js", "b.js", "c.jsx", "d.jsx", "e.py", "f.py", "g.py")) == "javascript"
    assert inputs.detect_language(named("SRC/A.PY", "b/c.Py", "d.go")) == "python"  # extensions ignore case
    assert inputs.detect_language(named("dir.py/readme", "x.tar.gz")) == "unknown"


# ----------------------------------------------------------------------------- detect_test_hint


def hint(root: Path, files: dict[str, str | bytes], language: str = "unknown") -> str:
    return inputs.detect_test_hint(root, write(root, files), language)


def test_hint_fallback(tmp_path: Path) -> None:
    assert hint(tmp_path, {"README.md": "x", "src/main.c": "int main(){}"}) == (
        "no test command found; look for one in the repository")
    assert inputs.NO_TEST_COMMAND == "no test command found; look for one in the repository"
    assert inputs.detect_test_hint(tmp_path, [], "python") == inputs.NO_TEST_COMMAND


def test_hint_npm_test(tmp_path: Path) -> None:
    pkg = json.dumps({"scripts": {"test": "jest --ci"}, "devDependencies": {"mocha": "1"}})
    assert hint(tmp_path, {"package.json": pkg}, "javascript") == "npm test"


@pytest.mark.parametrize("runner", ["vitest", "jest", "mocha"])
@pytest.mark.parametrize("section", ["dependencies", "devDependencies"])
def test_hint_npx_runner(tmp_path: Path, runner: str, section: str) -> None:
    pkg = json.dumps({"name": "x", "scripts": {"build": "tsc"}, section: {"left-pad": "1", runner: "^1"}})
    assert hint(tmp_path, {"package.json": pkg}, "typescript") == f"npx {runner}"


def test_hint_npx_runner_order_and_non_matches(tmp_path: Path) -> None:
    both = json.dumps({"devDependencies": {"mocha": "1", "jest": "2", "vitest": "3"}})
    assert hint(tmp_path, {"package.json": both}) == "npx vitest"
    only_jest_mocha = json.dumps({"dependencies": {"mocha": "1"}, "devDependencies": {"jest": "2"}})
    assert hint(tmp_path, {"package.json": only_jest_mocha}) == "npx jest"


@pytest.mark.parametrize("content", [
    json.dumps({"scripts": {"test": 5}}), json.dumps({"scripts": {"test": ""}}), json.dumps({"scripts": []}),
    json.dumps({"scripts": {"build": "x"}, "dependencies": ["jest"]}), json.dumps([1, 2]), json.dumps("jest"),
    "not json at all {", "", json.dumps({"dependencies": None, "devDependencies": 3}),
])
def test_hint_package_json_that_does_not_match(tmp_path: Path, content: str) -> None:
    assert hint(tmp_path, {"package.json": content}, "javascript") == inputs.NO_TEST_COMMAND


@pytest.mark.parametrize("marker", ["pytest.ini", "pyproject.toml", "setup.py", "setup.cfg", "tox.ini", "conftest.py"])
def test_hint_pytest(tmp_path: Path, marker: str) -> None:
    assert hint(tmp_path, {marker: ""}, "python") == "python -m pytest -q"


def test_hint_go_cargo_maven(tmp_path: Path) -> None:
    assert hint(tmp_path / "go", {"go.mod": "module x\n"}, "go") == "go test ./..."
    assert hint(tmp_path / "rs", {"Cargo.toml": "[package]\n"}, "rust") == "cargo test"
    assert hint(tmp_path / "mvn", {"pom.xml": "<project/>"}, "java") == "mvn -o -q test"


def test_hint_gradle(tmp_path: Path) -> None:
    assert hint(tmp_path / "w", {"build.gradle": "", "gradlew": "#!/bin/sh"}, "java") == "./gradlew test --offline"
    assert hint(tmp_path / "k", {"build.gradle.kts": "", "gradlew": ""}, "kotlin") == "./gradlew test --offline"
    assert hint(tmp_path / "n", {"build.gradle": ""}, "java") == "gradle test --offline"
    assert hint(tmp_path / "m", {"build.gradle.kts": ""}, "kotlin") == "gradle test --offline"
    assert hint(tmp_path / "x", {"gradlew": ""}, "java") == inputs.NO_TEST_COMMAND  # a wrapper alone says nothing


def test_hint_makefile(tmp_path: Path) -> None:
    assert hint(tmp_path / "a", {"Makefile": "build:\n\tcc x.c\n\ntest: build\n\t./run\n"}, "c") == "make test"
    assert hint(tmp_path / "b", {"Makefile": "test:\n\techo hi\n"}) == "make test"
    assert hint(tmp_path / "c", {"Makefile": "test :\n\techo hi\n"}) == "make test"
    for n, text in enumerate(["tests:\n\tx\n", ".PHONY: test\nbuild:\n\tx\n", "TEST := 1\ntest := 2\n", "\ttest:\n", ""]):
        assert hint(tmp_path / f"no{n}", {"Makefile": text}) == inputs.NO_TEST_COMMAND, text


def test_hint_tries_the_detected_language_first(tmp_path: Path) -> None:
    files = {"package.json": json.dumps({"scripts": {"test": "x"}}), "pyproject.toml": "", "go.mod": "", "Cargo.toml": "",
             "pom.xml": "", "build.gradle": "", "Makefile": "test:\n"}
    assert hint(tmp_path, files, "python") == "python -m pytest -q"
    assert hint(tmp_path, files, "go") == "go test ./..."
    assert hint(tmp_path, files, "rust") == "cargo test"
    assert hint(tmp_path, files, "java") == "mvn -o -q test"
    assert hint(tmp_path, files, "kotlin") == "gradle test --offline"
    assert hint(tmp_path, files, "c") == "make test"
    assert hint(tmp_path, files, "javascript") == "npm test"
    assert hint(tmp_path, files, "unknown") == "npm test"  # no own rule: the spec's order, npm first
    assert hint(tmp_path, files, "ruby") == "npm test"
    only = {"go.mod": "", "pyproject.toml": "", "Cargo.toml": ""}
    assert hint(tmp_path / "o", only, "unknown") == "python -m pytest -q"  # then pytest, go, cargo ...
    assert hint(tmp_path / "o", only, "rust") == "cargo test"
    assert hint(tmp_path / "o", only, "javascript") == "python -m pytest -q"  # own rules miss, the rest are tried


def test_hint_only_root_files_count(tmp_path: Path) -> None:
    assert hint(tmp_path, {"sub/go.mod": "", "pkg/pyproject.toml": "", "a/package.json": '{"scripts":{"test":"x"}}'},
                "go") == inputs.NO_TEST_COMMAND


# ----------------------------------------------------------------------------- prepare


def test_prepare_read_mode_fills_context_only(tmp_path: Path) -> None:
    a, b = tmp_path / "a.txt", tmp_path / "b.txt"
    a.write_bytes(b"A\r\n")
    b.write_bytes(b"B")
    spec = Spec(mode="read", inputs=[a, b], question="Q?")
    assert inputs.prepare(spec) is None
    assert spec.context == f"=== {a.as_posix()} ===\nA\r\n\n\n=== {b.as_posix()} ===\nB"
    assert (spec.language, spec.n_files, spec.test_hint, spec.task, spec.question) == (None, None, None, None, "Q?")

    again = spec.context
    a.write_bytes(b"changed")
    inputs.prepare(spec)  # idempotent: the context is built once
    assert spec.context == again


def test_prepare_read_mode_keeps_a_given_context(tmp_path: Path) -> None:
    spec = Spec(mode="read", inputs=[tmp_path / "missing.txt"], context="given")
    inputs.prepare(spec)  # not read, so the missing file does not matter
    assert spec.context == "given"
    empty = Spec(mode="read", inputs=[tmp_path / "missing.txt"], context="")
    inputs.prepare(empty)
    assert empty.context == ""  # an empty string is not None


def test_prepare_read_mode_errors(tmp_path: Path) -> None:
    with pytest.raises(InputError):
        inputs.prepare(Spec(mode="read", inputs=[]))
    with pytest.raises(InputError):
        inputs.prepare(Spec(mode="read", inputs=[tmp_path / "missing.txt"]))
    with pytest.raises(InputError):
        inputs.prepare(Spec(mode="other"))


@needs_git
def test_prepare_repo_mode_fills_everything(git_repo: Path) -> None:
    build_repo(git_repo)
    write(git_repo, {"pyproject.toml": "[project]\n"})
    files = inputs.repo_files(git_repo)
    spec = Spec(mode="repo", task="Fix the parser.", repo_path=git_repo)
    assert inputs.prepare(spec) is None
    assert spec.language == "python"  # caf\u00e9.py and pkg/core.py
    assert spec.n_files == len(files) == 8
    assert spec.test_hint == "python -m pytest -q"
    assert spec.context == inputs.repo_context("Fix the parser.", files)
    assert spec.context.startswith("Fix the parser.\n\nRepository files (path, size in bytes):\n.gitignore  7\n")
    assert spec.context.endswith("pyproject.toml  10\n")

    snapshot = (spec.context, spec.language, spec.n_files, spec.test_hint)
    write(git_repo, {"later.py": "x"})
    inputs.prepare(spec)  # idempotent even if the repository changed
    assert (spec.context, spec.language, spec.n_files, spec.test_hint) == snapshot


@needs_git
def test_prepare_repo_mode_fills_only_the_none_fields(git_repo: Path) -> None:
    spec = Spec(mode="repo", task="T", repo_path=git_repo, language="go", test_hint="make check")
    inputs.prepare(spec)
    assert (spec.language, spec.test_hint) == ("go", "make check")  # kept, though the files are python
    assert spec.n_files == 4
    assert spec.context == inputs.repo_context("T", inputs.repo_files(git_repo))

    spec = Spec(mode="repo", task="T", repo_path=git_repo, n_files=99, context="my own context")
    inputs.prepare(spec)
    assert (spec.n_files, spec.context) == (99, "my own context")
    assert spec.language == "python" and spec.test_hint == inputs.NO_TEST_COMMAND

    # a language given by the caller steers the test-hint rules
    write(git_repo, {"go.mod": "module x\n", "pyproject.toml": ""})
    spec = Spec(mode="repo", task="T", repo_path=git_repo, language="go")
    inputs.prepare(spec)
    assert spec.test_hint == "go test ./..."


def test_prepare_repo_mode_never_lists_files_when_all_four_are_given(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: object, **kwargs: object) -> None:
        raise AssertionError("repo_files was called")

    monkeypatch.setattr(inputs, "repo_files", forbidden)
    monkeypatch.setattr(inputs, "_git_names", forbidden)
    spec = Spec(mode="repo", task="T", repo_path=tmp_path / "does-not-exist", context="c", language="go", n_files=3,
                test_hint="")
    inputs.prepare(spec)
    assert (spec.context, spec.language, spec.n_files, spec.test_hint) == ("c", "go", 3, "")
    spec = Spec(mode="repo", task=None, repo_path=None, context="c", language="go", n_files=0, test_hint="x")
    inputs.prepare(spec)  # nothing to fill, so no repository path or task is needed
    assert spec.n_files == 0


def test_prepare_repo_mode_lists_the_files_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[Path] = []
    real = inputs.repo_files

    def counting(repo: Path) -> list[tuple[str, int]]:
        calls.append(repo)
        return real(repo)

    monkeypatch.setattr(inputs, "repo_files", counting)
    write(tmp_path, {"a.go": "x", "go.mod": "module x\n"})
    spec = Spec(mode="repo", task="T", repo_path=tmp_path)
    inputs.prepare(spec)
    inputs.prepare(spec)
    assert calls == [tmp_path]
    assert (spec.language, spec.n_files, spec.test_hint) == ("go", 2, "go test ./...")


def test_prepare_repo_mode_errors(tmp_path: Path) -> None:
    with pytest.raises(InputError, match="repository path"):
        inputs.prepare(Spec(mode="repo", task="T"))
    with pytest.raises(InputError, match="task"):
        inputs.prepare(Spec(mode="repo", repo_path=tmp_path))
    (tmp_path / "f.txt").write_bytes(b"x")
    with pytest.raises(InputError):
        inputs.prepare(Spec(mode="repo", task="T", repo_path=tmp_path / "f.txt"))
    spec = Spec(mode="repo", repo_path=tmp_path, context="given")  # a task is not needed when the context is given
    inputs.prepare(spec)
    assert spec.context == "given" and spec.n_files == 1


def test_listed_names_go_through_clean_text(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A name with a lone surrogate (git's bytes that are not UTF-8, after surrogateescape) is shown with `?`."""
    write(tmp_path, {"real.txt": "abcd"})
    real_stat = os.stat

    def fake_stat(path: object, *args: object, **kwargs: object) -> os.stat_result:
        if isinstance(path, str) and path.endswith("bad\udc80.txt"):
            return real_stat(tmp_path / "real.txt")
        return real_stat(path, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(inputs.os, "stat", fake_stat)
    monkeypatch.setattr(inputs, "_git_names", lambda repo: ["bad\udc80.txt"])
    got = inputs.repo_files(tmp_path)
    assert got == [(contract.clean_text("bad\udc80.txt"), 4)] == [("bad?.txt", 4)]
    inputs.repo_context("T", got).encode("utf-8")  # the context can be sent as UTF-8
