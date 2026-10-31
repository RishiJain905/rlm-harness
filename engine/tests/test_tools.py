"""KV cache: none

worker/tools.py, the copy of training's repl_tools.py: training's own cases from tests/test_repl_tools.py at
0b9af69 ported to pytest, the frozen API pinned to training's fingerprint, and the step 4 changes (the /work/repo
alias, `/` paths, the shell table, approvals, quiet(), diff() against a snapshot tree, fetch). Shell commands
live in COMMANDS, one entry per shell kind; POSIX tests sh, Windows tests Git Bash (when found) and PowerShell.
"""

from __future__ import annotations

import ast
import hashlib
import inspect
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from conftest import git, needs_git

from rlm_engine import workspace
from rlm_engine.worker import tools as rt

WINDOWS = sys.platform == "win32"

# The trained API. Changing a name, signature or docstring changes what the model learned, so it needs a new
# TOOLS_VERSION and a new pin here. `shell`'s return annotation carries the module's name (training's read
# `rlm_rl.repl_tools.ShellResult`), so it is stripped before comparing and hashing.
FROZEN = {
    "read_file": "(path: str, start: int = 1, n: int = 40) -> str",
    "find_files": "(pattern: str, path: str = '.') -> list[str]",
    "grep": "(pattern: str, path: str = '.', glob: str | None = None, ignore_case: bool = False, "
            "files_only: bool = False) -> list[str]",
    "edit_file": "(path: str, old: str, new: str, replace_all: bool = False) -> str",
    "write_file": "(path: str, text: str) -> str",
    "shell": "(cmd: str, timeout: float = 120) -> ShellResult",
    "diff": "() -> str",
}
# Training's api_fingerprint over the stripped signatures. Unstripped, training's own pin is 816344133c226653
# (rlm_rl.repl_tools at 0b9af69); the same source, imported under that name and stripped, gives this value.
FROZEN_SHA = {"t1": "b395ecf9f9bdb162"}
FETCH_DOC = ("Fetch a web page with a GET request and return its text (at most 200,000 characters). "
             "Asks for approval the first time for each site.")
NO_GIT_DIFF = "diff() is unavailable because the workspace is not a git repository"


def strip_module(signature: str) -> str:
    return re.sub(r"[\w.]+\.ShellResult\b", "ShellResult", signature)


def api_fingerprint(module: Any = rt) -> str:
    parts = [f"{name}{strip_module(str(inspect.signature(fn)))}\n{inspect.getdoc(fn)}"
             for name, fn in module.namespace().items()]
    return hashlib.sha256("\n\n".join(parts).encode()).hexdigest()[:16]


# ----------------------------------------------------------------------------- shells


def py(code: str, kind: str) -> str:
    """A command that runs `code` (single quotes only) with this interpreter, in the given shell's syntax."""
    if kind == "powershell":
        return f'& "{sys.executable}" -c "{code}"'
    exe = sys.executable.replace("\\", "/") if kind == "bash" else sys.executable
    return f'"{exe}" -c "{code}"'


COMMANDS: dict[str, dict[str, str | None]] = {
    "sh": {
        "exit": "echo out; echo err >&2; exit 3",
        "exit_out": "out\nerr\n",  # exact for sh and bash; PowerShell is checked by containment
        "ok": "true",
        "sleep": "sleep 30",
        "hang": "echo started; sleep 30 & sleep 30",  # a background child keeps the output pipe open
        "marker": "echo x > marker.txt",
    },
    "powershell": {
        "exit": "Write-Output out; [Console]::Error.WriteLine('err'); exit 3",
        "exit_out": None,
        "ok": "exit 0",
        "sleep": "Start-Sleep -Seconds 30",
        "hang": "Write-Output started; " + py("import time; time.sleep(30)", "powershell"),
        "marker": "echo x > marker.txt",
    },
}
COMMANDS["bash"] = COMMANDS["sh"]


def as_dict(spec: workspace.ShellSpec) -> dict:
    return {"kind": spec.kind, "argv": spec.argv}


def available_shells() -> list[Any]:
    if not WINDOWS:
        return [pytest.param(dict(rt.SH), id="sh")]
    found = []
    bash = workspace.find_shell()
    if bash.kind == "bash":
        found.append(pytest.param(as_dict(bash), id="git-bash"))
    hidden = {"PROGRAMFILES", "PROGRAMFILES(X86)", "LOCALAPPDATA"}
    powershell = workspace.find_shell(which=lambda name: None if name == "git" else shutil.which(name),
                                      env={k: v for k, v in os.environ.items() if k.upper() not in hidden})
    assert powershell.kind == "powershell"
    found.append(pytest.param(as_dict(powershell), id="powershell"))
    return found


DEFAULT_SHELL = as_dict(workspace.find_shell())


@pytest.fixture(params=available_shells())
def shell_spec(request: pytest.FixtureRequest) -> dict:
    return request.param


def cmd(spec: dict, name: str) -> str:
    value = COMMANDS[spec["kind"]][name]
    assert value is not None
    return value


# ----------------------------------------------------------------------------- fixtures and helpers


@pytest.fixture(autouse=True)
def reset_tools() -> Any:
    yield
    rt.configure()


@pytest.fixture
def root(tmp_path: Path) -> Path:
    folder = tmp_path / "root"
    folder.mkdir()
    rt.configure(root=str(folder), shell=DEFAULT_SHELL)
    return folder


def put(root: Path, rel: str, text: str | bytes) -> None:
    full = root / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))


def text(root: Path, rel: str) -> str:
    return (root / rel).read_bytes().decode("utf-8")


class PopenSpy:
    """Replaces subprocess.Popen and records, for each process started, whether tools.quiet() was true."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.quiet: list[bool] = []
        self.argv: list[Any] = []
        real = subprocess.Popen

        def spy(*args: Any, **kwargs: Any) -> Any:
            self.quiet.append(rt.quiet())
            self.argv.append(args[0] if args else kwargs.get("args"))
            return real(*args, **kwargs)

        monkeypatch.setattr(subprocess, "Popen", spy)


# ----------------------------------------------------------------------------- frozen API


def test_names_and_signatures() -> None:
    assert tuple(rt.namespace()) == rt.TOOL_NAMES
    assert {n: strip_module(str(inspect.signature(f))) for n, f in rt.namespace().items()} == FROZEN
    assert str(inspect.signature(rt.shell)).endswith(f"-> {rt.__name__}.ShellResult")


def test_docstrings_are_pinned_to_the_version() -> None:
    assert rt.TOOLS_VERSION == "t1"
    assert api_fingerprint() == FROZEN_SHA[rt.TOOLS_VERSION], \
        "the tool API changed: bump TOOLS_VERSION and pin the new fingerprint"


def test_standard_library_only() -> None:
    source = inspect.getsource(rt)
    code = source.split('"""', 2)[2]  # after the module docstring
    assert "rlm_rl" not in code and "rlm_engine" not in code
    assert "from __future__" not in source  # annotations are frozen text that help() shows
    modules = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            modules.add((node.module or "").split(".")[0])
    assert modules <= set(sys.stdlib_module_names), modules - set(sys.stdlib_module_names)


def test_imports_as_the_worker_does_with_the_same_fingerprint() -> None:
    """The worker runs with -I and imports tools.py as a top-level `tools` module."""
    folder = Path(rt.__file__).parent
    script = ("import sys; sys.path.insert(0, sys.argv[1]); import hashlib, inspect, re, tools; "
              "strip = lambda s: re.sub(r'[\\w.]+\\.ShellResult\\b', 'ShellResult', s); "
              "parts = [f'{n}{strip(str(inspect.signature(f)))}\\n{inspect.getdoc(f)}' "
              "for n, f in tools.namespace().items()]; "
              "print(hashlib.sha256('\\n\\n'.join(parts).encode()).hexdigest()[:16], "
              "'rlm_engine' in sys.modules, inspect.signature(tools.shell).return_annotation.__module__)")
    done = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", "-c", script, str(folder)],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert done.stdout.split() == [FROZEN_SHA["t1"], "False", "tools"]


def test_fetch_is_not_a_frozen_tool() -> None:
    assert "fetch" not in rt.TOOL_NAMES and "fetch" not in rt.namespace()
    assert str(inspect.signature(rt.fetch)) == "(url: str) -> str"
    assert inspect.getdoc(rt.fetch) == FETCH_DOC


# ----------------------------------------------------------------------------- read_file (training)


def test_read_numbered_window_and_next_hint(root: Path) -> None:
    put(root, "a.py", "".join(f"line {i}\n" for i in range(1, 101)))
    out = rt.read_file("a.py", start=11, n=5)
    assert out.splitlines()[0] == "    11\tline 11"
    assert out.splitlines()[4] == "    15\tline 15"
    assert "[85 more lines; next: read_file('a.py', start=16)]" in out
    assert "more lines" not in rt.read_file("a.py", start=61, n=40)


def test_read_default_window_fits_one_printed_turn(root: Path) -> None:
    put(root, "a.py", "".join(f"    value_{i} = compute_something(value_{i - 1})\n" for i in range(200)))
    assert len(rt.read_file("a.py")) < 2000 + 200


def test_read_long_lines_are_cut(root: Path) -> None:
    put(root, "min.js", "x" * 1000 + "\n")
    assert "[... 700 more characters]" in rt.read_file("min.js")


def test_read_refusals(root: Path) -> None:
    put(root, "b.bin", b"\x00\x01")
    put(root, "short.txt", "one\n")
    with pytest.raises(ValueError, match="binary"):
        rt.read_file("b.bin")
    with pytest.raises(ValueError, match="past the end"):
        rt.read_file("short.txt", start=5)
    with pytest.raises(FileNotFoundError):
        rt.read_file("missing.py")
    put(root, "empty.txt", "")
    assert rt.read_file("empty.txt") == "[empty.txt is empty]"


# ----------------------------------------------------------------------------- find_files and grep (training)


FIND_TREE = ("setup.py", "pkg/core.py", "pkg/sub/deep.py", "web/app.ts", "web/view.tsx", "README.md",
             "node_modules/dep/index.js", "pkg/__pycache__/core.cpython-312.pyc")


def test_find_glob_rules(root: Path) -> None:
    for rel in FIND_TREE:
        put(root, rel, "x\n")
    assert rt.find_files("*.py") == ["setup.py"]
    assert rt.find_files("**/*.py") == ["pkg/core.py", "pkg/sub/deep.py", "setup.py"]
    assert rt.find_files("web/*.{ts,tsx}") == ["web/app.ts", "web/view.tsx"]
    assert rt.find_files("*.py", path="pkg") == ["pkg/core.py"]
    assert rt.find_files("**/*.js") == [], "dependency folders are skipped without git"


@needs_git
def test_find_respects_gitignore_in_a_repository(root: Path) -> None:
    for rel in FIND_TREE:
        put(root, rel, "x\n")
    git(root, "init", "-q")
    put(root, ".gitignore", "build/\n")
    put(root, "build/gen.py", "x\n")
    assert "build/gen.py" not in rt.find_files("**/*.py")
    assert "pkg/core.py" in rt.find_files("**/*.py"), "untracked files still count"


def grep_tree(root: Path) -> None:
    put(root, "pkg/a.py", "def parse(x):\n    return Parse(x)\n")
    put(root, "pkg/b.go", "func parse() {}\n")
    put(root, "blob.bin", b"parse\x00")


def test_grep_matches_glob_case_and_files_only(root: Path) -> None:
    grep_tree(root)
    assert rt.grep("parse") == ["pkg/a.py:1: def parse(x):", "pkg/b.go:1: func parse() {}"]
    assert rt.grep("parse", glob="*.py", ignore_case=True) == ["pkg/a.py:1: def parse(x):",
                                                              "pkg/a.py:2:     return Parse(x)"]
    assert rt.grep("parse", glob="pkg/**/*.go", files_only=True) == ["pkg/b.go"]
    assert rt.grep("parse", path="pkg/b.go") == ["pkg/b.go:1: func parse() {}"]


def test_grep_match_cap_is_explicit(root: Path) -> None:
    grep_tree(root)
    put(root, "many.txt", "hit\n" * (rt.GREP_MAX_MATCHES + 5))
    out = rt.grep("hit", path="many.txt")
    assert len(out) == rt.GREP_MAX_MATCHES + 1
    assert "stopped at 10,000 matches" in out[-1]


# ----------------------------------------------------------------------------- edit_file and write_file (training)


def test_edit_unique_replacement(root: Path) -> None:
    put(root, "m.py", "a = 1\nb = 2\n")
    assert rt.edit_file("m.py", "b = 2", "b = 3") == "edited m.py: 1 replacement, first at line 2"
    assert text(root, "m.py") == "a = 1\nb = 3\n"


def test_edit_failures_leave_the_file_untouched(root: Path) -> None:
    put(root, "m.py", "x = 1\nx = 1\n")
    with pytest.raises(ValueError, match="occurs 2 times"):
        rt.edit_file("m.py", "x = 1", "x = 2")
    with pytest.raises(ValueError, match="not found"):
        rt.edit_file("m.py", "y = 1", "y = 2")
    assert text(root, "m.py") == "x = 1\nx = 1\n"
    assert "2 replacements" in rt.edit_file("m.py", "x = 1", "x = 2", replace_all=True)


def test_edit_crlf_files_keep_their_line_endings(root: Path) -> None:
    put(root, "w.java", "int a;\r\nint b;\r\n")
    rt.edit_file("w.java", "int a;\nint b;", "int a;\nint c;")
    assert text(root, "w.java") == "int a;\r\nint c;\r\n"


def test_write_makes_folders(root: Path) -> None:
    assert rt.write_file("new/dir/f.rs", "fn main() {}\n") == "wrote new/dir/f.rs (1 lines)"
    assert text(root, "new/dir/f.rs") == "fn main() {}\n"


# ----------------------------------------------------------------------------- /work/repo and `/` paths


def test_work_repo_alias_maps_onto_the_root(root: Path) -> None:
    put(root, "a.py", "x = 1\n")
    assert rt.read_file("/work/repo/a.py") == "     1\tx = 1"
    assert rt.find_files("*.py", path="/work/repo") == ["a.py"]
    assert rt.grep("x", path="/work/repo") == ["a.py:1: x = 1"]
    assert rt.write_file("/work/repo/new/b.txt", "b\n") == "wrote new/b.txt (1 lines)"
    assert text(root, "new/b.txt") == "b\n"
    assert rt.edit_file("/work/repo/a.py", "x = 1", "x = 2") == "edited a.py: 1 replacement, first at line 1"
    assert text(root, "a.py") == "x = 2\n"
    assert rt._abs("/work/repo") == str(root)


def test_only_the_whole_alias_segment_is_mapped(root: Path) -> None:
    mapped = rt._abs("/work/repository/x")
    assert mapped == os.path.normpath(os.path.join(str(root), "/work/repository/x"))
    assert not mapped.startswith(str(root))


def test_alias_none_turns_the_mapping_off(root: Path) -> None:
    rt.configure(root=str(root), alias=None)
    put(root, "a.py", "x = 1\n")
    assert rt._abs("/work/repo/a.py") == os.path.normpath(os.path.join(str(root), "/work/repo/a.py"))
    if not os.path.exists("/work/repo/a.py"):
        with pytest.raises(FileNotFoundError):
            rt.read_file("/work/repo/a.py")


def test_shown_paths_are_relative_with_slashes(root: Path, tmp_path: Path) -> None:
    put(root, "pkg/sub/deep.py", "".join(f"x{i}\n" for i in range(50)))
    assert rt.find_files("**/*.py") == ["pkg/sub/deep.py"]
    assert rt.grep("x1$")[0] == "pkg/sub/deep.py:2: x1"
    assert rt.grep("x", glob="pkg/**/*.py", files_only=True) == ["pkg/sub/deep.py"]
    assert "next: read_file('pkg/sub/deep.py', start=41)" in rt.read_file(str(root / "pkg" / "sub" / "deep.py"))
    outside = str(tmp_path / "elsewhere" / "f.txt")
    assert rt._show(outside) == outside.replace(os.sep, "/")


def test_a_path_on_another_drive_is_shown_absolute(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def relpath(path: str, start: str | None = None) -> str:
        raise ValueError("path is on mount 'D:', start on mount 'C:'")

    monkeypatch.setattr(os.path, "relpath", relpath)
    other = os.path.join(os.sep, "other", "f.txt")
    assert rt._show(other) == other.replace(os.sep, "/")


ORDER = ["a-b/x", "a/x", "a0/x"]  # POSIX byte order; with '\' on Windows it would be a-b, a0, a


def test_find_files_order_is_posix_without_git(root: Path) -> None:
    for rel in reversed(ORDER):
        put(root, rel, "x\n")
    assert rt.find_files("**/x") == ORDER
    assert [line.split(":")[0] for line in rt.grep("x")] == ORDER


@needs_git
def test_find_files_order_is_posix_with_git(root: Path) -> None:
    for rel in reversed(ORDER):
        put(root, rel, "x\n")
    git(root, "init", "-q")
    assert rt.find_files("**/x") == ORDER


# ----------------------------------------------------------------------------- shell


def test_shell_code_output_and_printed_tail(root: Path, shell_spec: dict) -> None:
    rt.configure(root=str(root), shell=shell_spec)
    r = rt.shell(cmd(shell_spec, "exit"))
    assert r.code == 3
    expected = COMMANDS[shell_spec["kind"]]["exit_out"]
    if expected is not None:
        assert r.out == expected
    else:
        assert "out" in r.out and "err" in r.out
    long = rt.shell(py("print('x' * 5000 + 'END')", shell_spec["kind"]))
    assert len(long.out) == 5004 + (1 if WINDOWS else 0)  # "\r\n" from a Windows Python
    assert str(long).startswith(f"exit 0\n[... {len(long.out) - rt.SHELL_SHOW_CHARS:,} earlier characters]")
    if not WINDOWS:
        assert str(long).startswith("exit 0\n[... 3,504 earlier characters]")
    assert str(long).rstrip().endswith("END")


def test_shell_cwd_is_the_root(root: Path, shell_spec: dict) -> None:
    rt.configure(root=str(root), shell=shell_spec)
    code, out = rt.shell(py("import os; print(os.getcwd())", shell_spec["kind"]))
    assert code == 0
    assert os.path.realpath(out.strip()) == os.path.realpath(root)
    if shell_spec["kind"] != "powershell":
        assert rt.shell("pwd").code == 0


def test_shell_timeout_kills_the_group_and_keeps_output(root: Path, shell_spec: dict) -> None:
    rt.configure(root=str(root), shell=shell_spec)
    timeout = 4 if WINDOWS else 1  # Windows PowerShell can take over a second just to start
    start = time.monotonic()
    r = rt.shell(cmd(shell_spec, "hang"), timeout=timeout)
    elapsed = time.monotonic() - start
    assert r.code == rt.SHELL_TIMEOUT_CODE
    assert "started" in r.out
    assert f"timed out after {timeout} s" in r.out
    # A child left alive would hold the pipe open, and shell() would wait out its 5 s join first.
    assert elapsed < timeout + 4.5, elapsed


def test_shell_cell_time_left_caps_the_timeout(root: Path, shell_spec: dict) -> None:
    rt.configure(root=str(root), shell=shell_spec, time_left=lambda: 3.0)
    start = time.monotonic()
    assert rt.shell(cmd(shell_spec, "sleep"), timeout=120).code == rt.SHELL_TIMEOUT_CODE
    assert time.monotonic() - start < 10


def test_shell_asks_once_with_the_command(root: Path, shell_spec: dict) -> None:
    asked: list[tuple] = []
    rt.configure(root=str(root), shell=shell_spec, approve=lambda *a: asked.append(a))
    command = cmd(shell_spec, "marker")
    assert rt.shell(command).code == 0
    assert asked == [("shell", command, True)]  # the command as written, without PowerShell's UTF-8 prefix
    assert (root / "marker.txt").exists()


def test_shell_denial_raises_before_anything_runs(root: Path, shell_spec: dict,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    def deny(kind: str, detail: str, inside: bool) -> None:
        raise PermissionError(13, "Permission denied (not approved)", detail)

    spy = PopenSpy(monkeypatch)
    rt.configure(root=str(root), shell=shell_spec, approve=deny)
    with pytest.raises(PermissionError, match="not approved"):
        rt.shell(cmd(shell_spec, "marker"))
    assert not (root / "marker.txt").exists()
    assert spy.quiet == []


def test_shell_runs_its_process_quietly_after_asking(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    quiet_when_asked: list[bool] = []
    rt.configure(root=str(root), shell=DEFAULT_SHELL, approve=lambda *a: quiet_when_asked.append(rt.quiet()))
    spy = PopenSpy(monkeypatch)
    rt.shell(COMMANDS[DEFAULT_SHELL["kind"]]["ok"])
    assert quiet_when_asked == [False]
    assert spy.quiet == [True]
    assert spy.argv[0][:len(DEFAULT_SHELL["argv"])] == DEFAULT_SHELL["argv"]
    assert not rt.quiet()


def test_powershell_gets_utf8_output(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Checked on every OS through the argv; Windows also runs it (the shell table's powershell entries)."""
    started: list[list[str]] = []

    def popen(argv: list[str], **kwargs: Any) -> Any:
        started.append(argv)
        raise OSError("not started")

    monkeypatch.setattr(subprocess, "Popen", popen)
    rt.configure(root=str(root), shell={"kind": "powershell", "argv": ["powershell.exe", "-Command"]})
    with pytest.raises(OSError, match="not started"):
        rt.shell("Get-Location")
    assert started == [["powershell.exe", "-Command", rt.PS_UTF8 + "Get-Location"]]


@pytest.mark.skipif(not WINDOWS, reason="Windows only")
def test_powershell_prints_utf8(root: Path) -> None:
    powershell = workspace.find_shell(which=lambda name: None if name == "git" else shutil.which(name), env={})
    rt.configure(root=str(root), shell=as_dict(powershell))
    r = rt.shell("Write-Output 'héllo'")
    assert (r.code, r.out.strip()) == (0, "héllo")


# ----------------------------------------------------------------------------- diff


@pytest.fixture
def repo(git_repo: Path, tmp_path: Path) -> tuple[Path, Path]:
    """The conftest repository, with the tools configured on it and a snapshot taken; returns (repo, scratch)."""
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    base = workspace.snapshot(git_repo, scratch)
    assert base is not None
    rt.configure(root=str(git_repo), base=base, scratch=str(scratch), shell=DEFAULT_SHELL)
    return git_repo, scratch


def git_files(repo: Path) -> set[str]:
    return {str(p.relative_to(repo / ".git")) for p in (repo / ".git").rglob("*")}


def test_diff_shows_edits_and_new_files_without_touching_the_index(repo: tuple[Path, Path]) -> None:
    root, scratch = repo
    before = git_files(root)
    index = (root / ".git" / "index").read_bytes()
    assert rt.diff() == ""
    rt.edit_file("a.py", "x = 1", "x = 2")
    rt.write_file("b.py", "y = 1\n")
    d = rt.diff()
    assert "-x = 1\n+x = 2" in d
    assert "+++ b/b.py" in d
    assert (root / ".git" / "index").read_bytes() == index, "the repository's own index is unchanged"
    status = git(root, "--no-optional-locks", "status", "--porcelain")
    assert status == " M a.py\n?? b.py\n"
    assert git_files(root) == before, ".git gains no files"
    assert sorted(os.listdir(scratch)) == [workspace.SNAPSHOT_OBJECTS], "the temporary index is removed"


def test_diff_a_commit_does_not_hide_the_change(repo: tuple[Path, Path]) -> None:
    root, _ = repo
    rt.edit_file("a.py", "x = 1", "x = 2")
    git(root, "commit", "-qam", "mine")
    assert "+x = 2" in rt.diff()


def test_diff_shows_deletions(repo: tuple[Path, Path]) -> None:
    root, _ = repo
    (root / "README.md").unlink()
    d = rt.diff()
    assert "deleted file mode" in d and "--- a/README.md" in d


def test_diff_git_runs_quietly(repo: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    spy = PopenSpy(monkeypatch)
    rt.write_file("b.py", "y = 1\n")
    rt.diff()
    assert spy.quiet and all(spy.quiet)
    assert not rt.quiet()


def test_diff_outside_git_raises_the_exact_error(root: Path) -> None:
    with pytest.raises(RuntimeError) as raised:
        rt.diff()
    assert str(raised.value) == NO_GIT_DIFF


# ----------------------------------------------------------------------------- fetch


def test_fetch_unconfigured() -> None:
    with pytest.raises(RuntimeError) as raised:
        rt.fetch("https://example.com/")
    assert str(raised.value) == "fetch is not available here"
    rt.configure(approve=lambda *a: None)
    with pytest.raises(RuntimeError, match="^fetch is not available here$"):
        rt.fetch("https://example.com/")


@pytest.mark.parametrize("url", ["ftp://example.com/x", "file:///etc/passwd", "example.com", "http://",
                                 "https:///path", "javascript:alert(1)", "http://[::1"])
def test_fetch_takes_only_http_urls(url: str) -> None:
    calls: list[tuple] = []
    rt.configure(approve=lambda *a: calls.append(a), remote_fetch=lambda u: calls.append((u,)) or "")
    with pytest.raises(ValueError) as raised:
        rt.fetch(url)
    assert str(raised.value) == "fetch takes an http:// or https:// URL"
    assert calls == []


def test_fetch_asks_for_the_host_then_fetches() -> None:
    calls: list[tuple] = []
    rt.configure(approve=lambda *a: calls.append(("approve", *a)),
                 remote_fetch=lambda u: calls.append(("fetch", u)) or "page text")
    url = "HTTPS://Example.COM:8443/a?b=1"
    assert rt.fetch(url) == "page text"
    assert calls == [("approve", "network", "example.com", False), ("fetch", url)]
    calls.clear()
    rt.fetch("http://[::1]:8000/")
    assert calls[0] == ("approve", "network", "[::1]", False)


def test_fetch_denial_skips_the_request() -> None:
    fetched: list[str] = []

    def deny(kind: str, detail: str, inside: bool) -> None:
        raise PermissionError(13, "Permission denied (not approved)", detail)

    rt.configure(approve=deny, remote_fetch=lambda u: fetched.append(u) or "")
    with pytest.raises(PermissionError):
        rt.fetch("https://example.com/")
    assert fetched == []


def test_fetch_without_approve_just_fetches() -> None:
    rt.configure(remote_fetch=lambda u: f"got {u}")
    assert rt.fetch("http://localhost:8123/") == "got http://localhost:8123/"


# ----------------------------------------------------------------------------- on_call, active() and quiet()


def test_every_call_is_reported(root: Path) -> None:
    seen: list[tuple] = []
    rt.configure(root=str(root), shell=DEFAULT_SHELL, on_call=lambda *a: seen.append(a),
                 remote_fetch=lambda u: "")
    ok = COMMANDS[DEFAULT_SHELL["kind"]]["ok"]
    put(root, "a.py", "x\n")
    rt.read_file("a.py")
    with pytest.raises(ValueError):
        rt.edit_file("a.py", "nope", "y")
    rt.shell(ok)
    rt.fetch("https://example.com/")
    assert [(t, ok_, target) for t, ok_, _, target in seen] == [
        ("read_file", True, "a.py"), ("edit_file", False, "a.py"), ("shell", True, ok),
        ("fetch", True, "https://example.com/")]
    assert not rt.active()


def test_active_only_during_a_call(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    put(root, "a.py", "x\n")
    during: list[bool] = []
    real = rt._is_binary
    monkeypatch.setattr(rt, "_is_binary", lambda path: during.append(rt.active()) or real(path))
    rt.read_file("a.py")
    assert (during, rt.active()) == ([True], False)


def test_quiet_counts_per_thread() -> None:
    assert not rt.quiet()
    seen: list[bool] = []
    with rt._quiet():
        with rt._quiet():
            assert rt.quiet()
        assert rt.quiet()
        thread = threading.Thread(target=lambda: seen.append(rt.quiet()))
        thread.start()
        thread.join()
    assert seen == [False]
    assert not rt.quiet()
    with pytest.raises(KeyError), rt._quiet():
        raise KeyError("x")
    assert not rt.quiet()


@needs_git
def test_git_reads_are_quiet_and_writes_are_not(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    put(root, "a.py", "x = 1\n")
    git(root, "init", "-q")
    spy = PopenSpy(monkeypatch)
    assert rt.find_files("*.py") == ["a.py"]
    assert rt.grep("x") == ["a.py:1: x = 1"]
    assert spy.quiet == [True, True]
    opened: list[tuple[str, bool]] = []
    real_open = open
    monkeypatch.setattr(rt, "open", lambda f, mode="r", *a, **kw: opened.append((mode, rt.quiet()))
                        or real_open(f, mode, *a, **kw), raising=False)
    rt.write_file("b.py", "y\n")
    rt.edit_file("b.py", "y", "z")
    assert [q for mode, q in opened if "w" in mode] == [False, False], "writes must reach the audit hook"
