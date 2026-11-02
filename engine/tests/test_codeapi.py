"""KV cache: none

`worker/codeapi.py` (D-157 to D-162): review(), check() and outline() for the `default` profile's coding tasks. Everything runs
offline: a fake `llm_batch` that records its calls, a fake `tools` for review() and check(), and the real tools module
on a temporary folder for outline() (and, in one test, for a real git diff).
"""

from __future__ import annotations

import ast
import inspect
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from conftest import git, needs_git

from rlm_engine import inputs, workspace
from rlm_engine.worker import codeapi
from rlm_engine.worker import tools as rt


# ---------------------------------------------------------------------------------------------- fakes


class FakeBatch:
    """A stand-in for the worker's llm_batch(prompts, shared=, over=, schema=): records every call and answers with
    `replies` (a list, or a function of the prompts); the default is an ok reply for each prompt."""

    def __init__(self, replies: Any = None) -> None:
        self.calls: list[dict] = []
        self.replies = replies

    def __call__(self, prompts: list[str], shared: str | None = None, over: Any = None, schema: Any = None) -> list:
        self.calls.append({"prompts": list(prompts), "shared": shared, "over": over, "schema": schema})
        if callable(self.replies):
            return self.replies(prompts)
        if self.replies is None:
            return [{"ok": True, "issues": []} for _ in prompts]
        return list(self.replies)


class FakeTools:
    def __init__(self, diff: str = "", result: Any = None, root: str = ".") -> None:
        self._diff, self.result, self.root = diff, result, root
        self.diff_calls = 0
        self.shells: list[tuple] = []

    def diff(self) -> str:
        self.diff_calls += 1
        return self._diff

    def shell(self, cmd: str, timeout: float = 120) -> Any:
        self.shells.append((cmd, timeout))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result

    def _abs(self, path: str) -> str:
        return str(Path(self.root) / path)


def make(*, batch: Any = None, tools: Any = None, task: str | None = "fix the bug", hint: str | None = "python -m pytest -q",
         repo: bool = True) -> dict:
    return codeapi.namespace(llm_batch=batch or FakeBatch(), tools=tools or FakeTools(), task=task, test_hint=hint, repo=repo)


@pytest.fixture(autouse=True)
def reset_tools() -> Any:
    yield
    rt.configure()


@pytest.fixture
def root(tmp_path: Path) -> Path:
    folder = tmp_path / "root"
    folder.mkdir()
    rt.configure(root=str(folder))
    return folder


def put(root: Path, rel: str, text: str | bytes) -> None:
    full = root / rel
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_bytes(text if isinstance(text, bytes) else text.encode("utf-8"))


def outline_of(root: Path, rel: str, text: str) -> str:
    put(root, rel, text)
    return make(tools=rt, repo=False)["outline"](rel)


# ---------------------------------------------------------------------------------------------- the module


def test_names_and_signatures() -> None:
    space = make()
    assert codeapi.NAMES == ("review", "check", "outline") and tuple(space) == codeapi.NAMES
    assert str(inspect.signature(space["review"])) == "(task: 'str | None' = None, diff_text: 'str | None' = None) -> 'list[dict]'"
    assert str(inspect.signature(space["check"])) == "(cmd: 'str | None' = None, timeout: 'float' = 300) -> 'CheckResult'"
    assert str(inspect.signature(space["outline"])) == "(path: 'str') -> 'str'"
    for fn in space.values():
        assert 1 <= len(inspect.getdoc(fn).splitlines()) <= 3  # what help() shows the model


def test_standard_library_only() -> None:
    source = inspect.getsource(codeapi)
    modules = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Import):
            modules |= {alias.name.split(".")[0] for alias in node.names}
        elif isinstance(node, ast.ImportFrom):
            modules.add((node.module or "").split(".")[0])
    assert modules <= set(sys.stdlib_module_names), modules - set(sys.stdlib_module_names)


def test_imports_as_the_worker_does() -> None:
    """The worker runs with -I and imports codeapi.py as a top-level module from its own folder."""
    folder = Path(codeapi.__file__).parent
    script = ("import sys; sys.path.insert(0, sys.argv[1]); import codeapi; "
              "print(codeapi.NAMES, 'rlm_engine' in sys.modules, codeapi.namespace.__module__)")
    done = subprocess.run([sys.executable, "-I", "-B", "-X", "utf8", "-c", script, str(folder)],
                          capture_output=True, text=True, timeout=60)
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "('review', 'check', 'outline') False codeapi"


def test_the_copied_constant_matches_inputs() -> None:
    assert codeapi.NO_TEST_COMMAND == inputs.NO_TEST_COMMAND
    assert codeapi.TIMEOUT_CODE == rt.SHELL_TIMEOUT_CODE


def test_review_and_check_need_a_coding_task() -> None:
    space = make(repo=False)
    with pytest.raises(RuntimeError, match=re.escape("review() works in coding tasks")):
        space["review"]()
    with pytest.raises(RuntimeError, match=re.escape("check() works in coding tasks")):
        space["check"]("pytest")


# ---------------------------------------------------------------------------------------------- diff splitting


A_DIFF = """diff --git a/src/a.py b/src/a.py
index 1111111..2222222 100644
--- a/src/a.py
+++ b/src/a.py
@@ -1,3 +1,3 @@
 def f():
-    return 1
+    return 2
     pass
"""
B_DIFF = """diff --git a/b.txt b/b.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/b.txt
@@ -0,0 +1,2 @@
+one
+two
"""
GONE_DIFF = """diff --git a/old.py b/old.py
deleted file mode 100644
index 4444444..0000000
--- a/old.py
+++ /dev/null
@@ -1,2 +0,0 @@
-x = 1
-y = 2
"""
BINARY_DIFF = """diff --git a/img/logo.png b/img/logo.png
new file mode 100644
index 0000000..5555555
Binary files /dev/null and b/img/logo.png differ
"""
RENAME_DIFF = """diff --git a/old name.py b/new name.py
similarity index 90%
rename from old name.py
rename to new name.py
index 6666666..7777777 100644
--- a/old name.py\t
+++ b/new name.py\t
@@ -1 +1 @@
-a = 1
+a = 2
"""
SPACE_DIFF = """diff --git a/my dir/file x.py b/my dir/file x.py
new file mode 100644
index 0000000..8888888
Binary files /dev/null and b/my dir/file x.py differ
"""


def test_split_diff_per_file_in_diff_order() -> None:
    parts = codeapi.split_diff(A_DIFF + B_DIFF + GONE_DIFF + BINARY_DIFF + RENAME_DIFF + SPACE_DIFF)
    assert [name for name, _ in parts] == ["src/a.py", "b.txt", "old.py", "img/logo.png", "new name.py", "my dir/file x.py"]
    assert "".join(chunk for _, chunk in parts) == A_DIFF + B_DIFF + GONE_DIFF + BINARY_DIFF + RENAME_DIFF + SPACE_DIFF
    assert all(chunk.startswith("diff --git ") for _, chunk in parts)


def test_split_diff_without_headers_is_one_chunk() -> None:
    plain = "--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n"
    assert codeapi.split_diff(plain) == [("x.py", plain)]
    assert codeapi.split_diff("@@ -1 +1 @@\n-a\n+b\n") == [("(diff)", "@@ -1 +1 @@\n-a\n+b\n")]
    assert codeapi.split_diff("") == [] and codeapi.split_diff("\n\n") == []


def test_a_plus_line_in_a_hunk_is_not_a_file_name() -> None:
    chunk = "diff --git a/bin b/bin\nBinary files differ\n"
    assert codeapi.split_diff(chunk)[0][0] == "bin"
    tricky = "diff --git a/x.md b/x.md\n--- a/x.md\n+++ b/x.md\n@@ -1 +1,2 @@\n a\n+++ b/evil.py\n"
    assert codeapi.split_diff(tricky)[0][0] == "x.md"


def hunk(n: int) -> str:
    return (f"@@ -{n * 10},3 +{n * 10},3 @@ def func_{n}():\n context line before the change {n}\n"
            f"-    old_value_{n} = compute_something({n})\n+    new_value_{n} = compute_something_else({n}, True)\n"
            f" context line after the change {n}\n")


def big_diff(hunks: int) -> str:
    return ("diff --git a/big.py b/big.py\nindex 1111111..2222222 100644\n--- a/big.py\n+++ b/big.py\n"
            + "".join(hunk(n) for n in range(1, hunks + 1)))


def test_split_chunk_leaves_a_small_diff_alone() -> None:
    assert codeapi.split_chunk(A_DIFF) == [A_DIFF]
    exactly = "x" * codeapi.CHUNK_CHARS
    assert codeapi.split_chunk(exactly) == [exactly]


def test_split_chunk_cuts_at_hunk_boundaries_and_repeats_the_header() -> None:
    chunk = big_diff(400)
    assert len(chunk) > 2 * codeapi.CHUNK_CHARS
    pieces = codeapi.split_chunk(chunk)
    assert len(pieces) >= 3 and all(len(p) <= codeapi.CHUNK_CHARS for p in pieces)
    header = "diff --git a/big.py b/big.py\nindex 1111111..2222222 100644\n--- a/big.py\n+++ b/big.py\n"
    assert all(p.startswith(header) for p in pieces)
    hunk_lines = [line for p in pieces for line in p.split("\n") if line.startswith("@@")]
    assert hunk_lines == [hunk(n).split("\n")[0] for n in range(1, 401)]  # every hunk once, in order, whole
    for p in pieces:
        assert p.split("\n")[4].startswith("@@")  # a piece starts at a hunk, never inside one
    assert "".join(p[len(header):] for p in pieces) == chunk[len(header):]  # nothing lost or added


def test_split_chunk_cuts_inside_one_huge_hunk_and_keeps_the_numbers() -> None:
    body = "".join(f"+line number {i:05d} with some padding text to make it longer\n" for i in range(1, 2001))
    chunk = ("diff --git a/new.py b/new.py\nnew file mode 100644\nindex 0000000..1234567\n--- /dev/null\n+++ b/new.py\n"
             f"@@ -0,0 +1,2000 @@\n{body}")
    pieces = codeapi.split_chunk(chunk)
    assert len(pieces) >= 3 and all(len(p) <= codeapi.CHUNK_CHARS for p in pieces)
    assert pieces[0].split("\n")[5] == "@@ -0,0 +1,2000 @@"
    added = 0
    for p in pieces:
        lines = p.rstrip("\n").split("\n")
        at = next(i for i, line in enumerate(lines) if line.startswith("@@"))
        if added:
            assert lines[at] == f"@@ -0 +{added + 1} @@ (continued)"
        content = lines[at + 1:]
        assert all(line.startswith("+") for line in content)
        added += len(content)
    assert added == 2000


def test_split_chunk_shortens_a_huge_line() -> None:
    minified = "+" + "x" * 100_000
    chunk = f"diff --git a/m.js b/m.js\n--- a/m.js\n+++ b/m.js\n@@ -1 +1 @@\n-a\n{minified}\n"
    pieces = codeapi.split_chunk(chunk)
    assert len(pieces) == 1 and len(pieces[0]) < codeapi.CHUNK_CHARS
    assert "[... 96,001 more characters]" in pieces[0]


# ---------------------------------------------------------------------------------------------- review


def test_review_sends_one_prompt_per_file_with_shared_instruction_and_task() -> None:
    batch, tools = FakeBatch(), FakeTools(diff=A_DIFF + B_DIFF)
    result = make(batch=batch, tools=tools)["review"]()
    assert tools.diff_calls == 1 and len(batch.calls) == 1
    call = batch.calls[0]
    assert call["prompts"] == [f"File: src/a.py\n\n{A_DIFF}", f"File: b.txt\n\n{B_DIFF}"]
    assert call["shared"].startswith(codeapi.REVIEW_INSTRUCTION) and call["shared"].endswith("Task:\nfix the bug")
    assert call["over"] is None
    assert call["schema"] == {"ok": bool, "issues": [{"line": int, "problem": str}]}
    assert result == [{"file": "src/a.py", "ok": True, "issues": []}, {"file": "b.txt", "ok": True, "issues": []}]


def test_review_task_argument_beats_the_runs_task_and_a_missing_task_is_said() -> None:
    batch = FakeBatch()
    make(batch=batch, tools=FakeTools(diff=A_DIFF))["review"]("add a retry to f()")
    assert batch.calls[0]["shared"].endswith("Task:\nadd a retry to f()")
    make(batch=batch, tools=FakeTools(diff=A_DIFF), task=None)["review"]()
    assert batch.calls[1]["shared"] == f"{codeapi.REVIEW_INSTRUCTION}\n\n{codeapi.NO_TASK}"
    make(batch=batch, tools=FakeTools(diff=A_DIFF), task="x" * 20_000)["review"]()
    assert len(batch.calls[2]["shared"]) < len(codeapi.REVIEW_INSTRUCTION) + codeapi.TASK_MAX_CHARS + 100


def test_review_of_given_diff_text_does_not_ask_for_the_diff() -> None:
    batch, tools = FakeBatch(), FakeTools(diff="never used")
    result = make(batch=batch, tools=tools)["review"](diff_text=B_DIFF)
    assert tools.diff_calls == 0 and [r["file"] for r in result] == ["b.txt"]


def test_review_with_nothing_to_review_raises() -> None:
    batch = FakeBatch()
    space = make(batch=batch, tools=FakeTools(diff=""))
    with pytest.raises(ValueError, match="there are no changes to review"):
        space["review"]()
    with pytest.raises(ValueError, match="there are no changes to review"):
        space["review"](diff_text="  \n")
    with pytest.raises(TypeError, match="diff_text takes a str"):
        space["review"](diff_text=5)  # type: ignore[arg-type]
    assert batch.calls == []


def test_review_returns_issues_with_lines_and_files_in_diff_order() -> None:
    replies = [{"ok": False, "issues": [{"line": 3, "problem": "returns 2, the task wants 3"}, {"line": 0, "problem": "no test"}]},
               {"ok": True, "issues": []}, {"ok": False, "issues": []}]
    result = make(batch=FakeBatch(replies), tools=FakeTools(diff=A_DIFF + B_DIFF + GONE_DIFF))["review"]()
    assert result == [
        {"file": "src/a.py", "ok": False, "issues": [{"line": 3, "problem": "returns 2, the task wants 3"},
                                                      {"line": None, "problem": "no test"}]},
        {"file": "b.txt", "ok": True, "issues": []},
        {"file": "old.py", "ok": False, "issues": []},
    ]


def test_review_treats_a_missing_reply_as_unknown() -> None:
    result = make(batch=FakeBatch([None, {"ok": True, "issues": []}]), tools=FakeTools(diff=A_DIFF + B_DIFF))["review"]()
    assert result == [{"file": "src/a.py", "ok": None, "issues": [], "error": "no valid reply"},
                      {"file": "b.txt", "ok": True, "issues": []}]


def test_review_merges_the_pieces_of_a_big_file() -> None:
    diff = big_diff(400) + B_DIFF
    pieces = codeapi.split_chunk(big_diff(400))
    n = len(pieces)
    assert n >= 3

    def replies(prompts: list[str]) -> list:
        assert len(prompts) == n + 1
        assert prompts[0].startswith(f"File: big.py (part 1 of {n})\n\n") and prompts[n - 1].startswith(f"File: big.py (part {n} of {n})")
        assert prompts[n] == f"File: b.txt\n\n{B_DIFF}"
        out: list = [{"ok": True, "issues": []}] * n + [{"ok": True, "issues": []}]
        out[0] = {"ok": False, "issues": [{"line": 12, "problem": "first"}]}
        out[2] = {"ok": False, "issues": [{"line": 99, "problem": "third"}]}
        return out

    result = make(batch=FakeBatch(replies), tools=FakeTools(diff=diff))["review"]()
    assert [r["file"] for r in result] == ["big.py", "b.txt"]
    assert result[0]["ok"] is False
    assert result[0]["issues"] == [{"line": 12, "problem": "first"}, {"line": 99, "problem": "third"}]
    assert result[1] == {"file": "b.txt", "ok": True, "issues": []}


def test_review_a_big_file_with_one_lost_piece() -> None:
    n = len(codeapi.split_chunk(big_diff(400)))
    clean = [{"ok": True, "issues": []}] * n
    lost = make(batch=FakeBatch([None, *clean[1:]]), tools=FakeTools(diff=big_diff(400)))["review"]()
    assert lost == [{"file": "big.py", "ok": None, "issues": [], "error": f"no valid reply for 1 of {n} parts"}]
    # a found problem outranks a lost piece
    found = make(batch=FakeBatch([None, {"ok": False, "issues": [{"line": 4, "problem": "p"}]}, *clean[2:]]),
                 tools=FakeTools(diff=big_diff(400)))["review"]()
    assert found[0]["ok"] is False and found[0]["issues"] == [{"line": 4, "problem": "p"}]
    assert found[0]["error"] == f"no valid reply for 1 of {n} parts"


def test_review_cleans_odd_replies() -> None:
    odd = [{"ok": "yes", "issues": [{"line": "7", "problem": " spaced "}, "plain text", {"problem": "no line"}]}]
    result = make(batch=FakeBatch(odd), tools=FakeTools(diff=A_DIFF))["review"]()
    assert result == [{"file": "src/a.py", "ok": False, "issues": [
        {"line": None, "problem": "spaced"}, {"line": None, "problem": "plain text"}, {"line": None, "problem": "no line"}]}]
    assert make(batch=FakeBatch([{"issues": []}]), tools=FakeTools(diff=A_DIFF))["review"]()[0]["ok"] is True
    assert make(batch=FakeBatch([{}]), tools=FakeTools(diff=A_DIFF))["review"]()[0]["ok"] is None


@needs_git
def test_review_on_a_real_git_diff(git_repo: Path, tmp_path: Path) -> None:
    scratch = tmp_path / "scratch"
    base = workspace.snapshot(git_repo, scratch)
    assert base is not None
    rt.configure(root=str(git_repo), base=base, scratch=str(scratch))
    rt.edit_file("a.py", "x = 1", "x = 2")
    rt.write_file("sub/new file.py", "y = 1\n")
    batch = FakeBatch()
    result = make(batch=batch, tools=rt, task="make x two")["review"]()
    assert [r["file"] for r in result] == ["a.py", "sub/new file.py"]
    prompts = batch.calls[0]["prompts"]
    assert "-x = 1\n+x = 2" in prompts[0] and "+y = 1" in prompts[1]
    assert batch.calls[0]["shared"].endswith("Task:\nmake x two")


# ---------------------------------------------------------------------------------------------- check


def shell_result(code: int, out: str) -> rt.ShellResult:
    return rt.ShellResult(code, out)


PYTEST_FAIL = ("============================= test session starts =============================\n"
               "collected 40 items\n\n"
               + "".join(f"tests/test_mod{i}.py {'.' * 10}                                [{i * 5}%]\n" for i in range(1, 12))
               + "tests/test_a.py .F.                                                      [ 90%]\n\n"
               "=================================== FAILURES ===================================\n"
               "______________________________ test_add ______________________________\n\n"
               "    def test_add():\n>       assert add(1, 2) == 4\nE       assert 3 == 4\n"
               "E        +  where 3 = add(1, 2)\n\ntests/test_a.py:5: AssertionError\n"
               "------------------------------ Captured log call -------------------------------\n"
               + "".join(f"INFO     app:service.py:{n} handled request {n}\n" for n in range(12))
               + "=========================== short test summary info ============================\n"
               "FAILED tests/test_a.py::test_add - assert 3 == 4\n"
               "========================= 1 failed, 39 passed in 0.12s ==========================\n")


def test_check_runs_the_test_hint_and_summarizes_a_pytest_failure() -> None:
    tools = FakeTools(result=shell_result(1, PYTEST_FAIL))
    result = make(tools=tools)["check"]()
    assert tools.shells == [("python -m pytest -q", 300)]
    assert (result.ok, result.code, result.cmd, result.out, bool(result)) == (False, 1, "python -m pytest -q", PYTEST_FAIL, False)
    assert result.timed_out is False and str(result) == result.summary == repr(result)
    lines = result.summary.split("\n")
    assert lines[0] == "FAIL (exit 1): python -m pytest -q"
    assert lines[1] == "failures:"
    failures = lines[2:lines.index("last 15 lines:")]
    assert failures == ["______________________________ test_add ______________________________",
                        "E       assert 3 == 4", "E        +  where 3 = add(1, 2)", "tests/test_a.py:5: AssertionError"]
    tail = lines[lines.index("last 15 lines:") + 1:]
    assert tail == PYTEST_FAIL.rstrip("\n").split("\n")[-15:]
    assert len(result.summary) <= codeapi.SUMMARY_MAX_CHARS


def test_check_passes_with_a_short_tail() -> None:
    out = "".join(f"line {i}\n" for i in range(30)) + "AssertionError is mentioned but all is fine\n40 passed in 1.2s\n"
    result = make(tools=FakeTools(result=shell_result(0, out)))["check"]("pytest -q", timeout=60)
    assert result.ok and bool(result) and result.code == 0
    assert result.summary == "PASS: pytest -q\nlast 5 lines:\nline 27\nline 28\nline 29\n" \
                             "AssertionError is mentioned but all is fine\n40 passed in 1.2s"


def test_check_command_and_timeout_pass_through() -> None:
    tools = FakeTools(result=shell_result(0, "ok\n"))
    space = make(tools=tools)
    assert str(space["check"]("bun test src/a.test.ts", timeout=45)) == "PASS: bun test src/a.test.ts\noutput:\nok"
    assert tools.shells == [("bun test src/a.test.ts", 45)]
    assert str(space["check"]("true")).endswith("output:\nok")
    assert str(make(tools=FakeTools(result=shell_result(0, "")))["check"]("true")) == "PASS: true\n(no output)"


BUN_FAIL = ("bun test v1.4.4\n\nsrc/a.test.ts:\n" + "(pass) test number {n} [0.10ms]\n" * 0
            + "".join(f"(pass) test number {n} [0.10ms]\n" for n in range(25))
            + "(fail) subtracts [0.30ms]\nerror: expect(received).toBe(expected)\n\nExpected: 2\nReceived: 3\n\n"
            "      at <anonymous> (src/a.test.ts:9:20)\n\u2717 subtracts [0.30ms]\n"
            + "".join(f"(pass) later test {n} [0.10ms]\n" for n in range(25))
            + " 49 pass\n 1 fail\n 50 expect() calls\nRan 50 tests across 1 files. [20.00ms]\n")


def test_check_summarizes_bun_failures() -> None:
    result = make(tools=FakeTools(result=shell_result(1, BUN_FAIL)), hint="bun test")["check"]()
    lines = result.summary.split("\n")
    assert lines[0] == "FAIL (exit 1): bun test" and lines[1] == "failures:"
    failures = lines[2:lines.index("last 15 lines:")]
    assert failures == ["(fail) subtracts [0.30ms]", "error: expect(received).toBe(expected)", "\u2717 subtracts [0.30ms]"]
    assert "(pass) test number" not in result.summary.split("last 15 lines:")[0]


TSC_FAIL = ("".join(f"npm warn something {n}\n" for n in range(20))
            + "src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.\n"
            "src/b.ts(10,1): error TS2304: Cannot find name 'foo'.\n"
            + "".join(f"npm note {n}\n" for n in range(20))
            + "Found 2 errors in 2 files.\n")


def test_check_summarizes_tsc_errors() -> None:
    result = make(tools=FakeTools(result=shell_result(2, TSC_FAIL)), hint="npx tsc --noEmit")["check"]()
    lines = result.summary.split("\n")
    assert lines[0] == "FAIL (exit 2): npx tsc --noEmit" and lines[1] == "failures:"
    assert lines[2:4] == ["src/a.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
                          "src/b.ts(10,1): error TS2304: Cannot find name 'foo'."]
    assert lines[-1] == "Found 2 errors in 2 files."


@pytest.mark.parametrize("line", [
    "--- FAIL: TestAdd (0.00s)", "FAIL\texample.com/pkg\t0.003s", "    add_test.go:12: got 3, want 4", "panic: runtime error: index out of range",
    "test tests::adds ... FAILED", "thread 'tests::adds' panicked at src/lib.rs:5:9:", "error[E0308]: mismatched types",
    "Traceback (most recent call last):", "ModuleNotFoundError: No module named 'x'", "  FAIL  src/a.test.ts > adds",
    " \u25cf Suite \u203a adds", "[ERROR] Tests run: 3, Failures: 1", "> Task :test FAILED", "ERROR tests/test_a.py - ImportError",
    "\u2715 adds (3 ms)", "(fail) adds [0.1ms]",
])
def test_failure_lines_other_runners_print(line: str) -> None:
    filler = "".join(f"noise {i}\n" for i in range(30))
    summary = codeapi.summarize("run tests", 1, filler + line + "\n" + filler)
    assert summary.split("\n")[2] == line.rstrip()


def test_check_dedupes_failure_lines_and_clips_long_ones() -> None:
    out = ("FAILED tests/a.py::t\n" * 5 + "x" * 500 + " AssertionError\n" + "noise\n" * 30)
    summary = codeapi.summarize("c", 1, out)
    lines = summary.split("\n")
    assert lines[1:4] == ["failures:", "FAILED tests/a.py::t", "x" * 197 + "..."]
    assert summary.count("FAILED tests/a.py::t") == 1


def test_check_caps_the_summary() -> None:
    out = "".join(f"FAILED tests/test_{i:04d}.py::test_something_long_enough_to_matter - assert {i} == {i + 1}\n" for i in range(500))
    out += "".join(f"tail line {i} " + "y" * 150 + "\n" for i in range(40))
    summary = codeapi.summarize("pytest", 1, out)
    lines = summary.split("\n")
    assert len(summary) <= codeapi.SUMMARY_MAX_CHARS and lines[0] == "FAIL (exit 1): pytest"
    shown = [line for line in lines if line.startswith("FAILED tests/test_")]
    assert 1 <= len(shown) <= codeapi.MAX_FAIL_LINES and shown == [line for line in out.split("\n") if line][:len(shown)]
    assert re.search(r"\[\.\.\. \d+ more failure lines\]", summary)
    assert lines[-1].startswith("tail line 39")  # the end of the output always survives


def test_check_strips_colour_codes() -> None:
    out = "\x1b[31mFAILED\x1b[0m tests/a.py::t\n" + "noise\n" * 30
    assert codeapi.summarize("c", 1, out).split("\n")[2] == "FAILED tests/a.py::t"


def test_check_timeout_is_told_apart_from_an_exit_124() -> None:
    killed = shell_result(124, "partial output\ntests/a.py ..\n[timed out after 5 s and killed]")
    result = make(tools=FakeTools(result=killed))["check"](timeout=5)
    assert result.timed_out and not result.ok and result.code == 124
    assert result.summary.split("\n")[0] == "TIMEOUT: python -m pytest -q"
    assert result.summary.endswith("[timed out after 5 s and killed]")
    plain = make(tools=FakeTools(result=shell_result(124, "the program itself returned 124\n")))["check"]()
    assert plain.timed_out is False and plain.summary.split("\n")[0] == "FAIL (exit 124): python -m pytest -q"


def test_check_without_a_command_asks_for_one() -> None:
    for hint in (None, "", inputs.NO_TEST_COMMAND):
        tools = FakeTools(result=shell_result(0, ""))
        with pytest.raises(ValueError, match=r"check\(\) needs a command"):
            make(tools=tools, hint=hint)["check"]()
        assert tools.shells == []
    tools = FakeTools(result=shell_result(0, "ok"))
    assert make(tools=tools, hint=None)["check"]("make test").ok and tools.shells == [("make test", 300)]
    for bad in ("", "  ", 3):
        with pytest.raises(ValueError, match="non-empty command"):
            make(tools=tools)["check"](bad)  # type: ignore[arg-type]
    for bad_timeout in (0, -1, True, "5"):
        with pytest.raises(ValueError, match="positive number"):
            make(tools=tools)["check"]("x", timeout=bad_timeout)  # type: ignore[arg-type]


def test_check_lets_a_denied_approval_through() -> None:
    tools = FakeTools(result=PermissionError("denied: shell"))
    with pytest.raises(PermissionError, match="denied: shell"):
        make(tools=tools)["check"]()


def test_check_shows_a_long_command_once_and_short() -> None:
    summary = codeapi.summarize("cd sub &&\nmake test\n" + "z" * 10, 3, "boom")
    assert summary.split("\n")[0] == "FAIL (exit 3): cd sub && ..."


# ---------------------------------------------------------------------------------------------- outline: Python


PY_SOURCE = '''"""doc"""
import os

MAX_SIZE = 10
name = "lower"
LIMIT: int = 5
A = B = 1


@decorator
class Foo(Base, metaclass=Meta):
    """doc"""
    CONST = 1

    def bar(self, x):
        def inner():
            pass
        return x

    async def baz(self, *, y: int = 3) -> str:
        return ""

    @property
    def prop(self):
        return 1


def top(a, b=2):
    return a


async def atop():
    pass


if TYPE_CHECKING:
    def cond(): ...
'''


def test_outline_python_nesting_async_constants_and_decorators(root: Path) -> None:
    assert outline_of(root, "m.py", PY_SOURCE).split("\n") == [
        "L4 MAX_SIZE =",
        "L6 LIMIT =",
        "L7 A =",
        "L7 B =",
        "L10-25 class Foo(Base, metaclass=Meta)",  # from the decorator line
        "L15-18   def bar(self, x)",
        "L16-17     def inner()",
        "L20-21   async def baz(self, *, y: int=3) -> str",
        "L23-25   def prop(self)",
        "L28-29 def top(a, b=2)",
        "L32-33 async def atop()",
        "L37 def cond()",
    ]


def test_outline_python_line_numbers_agree_with_read_file(root: Path) -> None:
    text = "X = 1\x0c\ndef f():\n    pass\n"  # str.splitlines() (read_file) breaks at the form feed, ast does not
    assert outline_of(root, "f.py", text) == "L1 X =\nL3-4 def f()"
    assert "     3\tdef f():" in rt.read_file("f.py")


def test_outline_python_that_does_not_parse_falls_back_to_def_and_class_lines(root: Path) -> None:
    text = "def a(:\n    pass\nclass B:\n    def c(self):\n        pass\n"
    assert outline_of(root, "bad.py", text).split("\n") == [
        "[does not parse (line 1: invalid syntax); outline from def and class lines]",
        "L1-2 def a(", "L3-5 class B", "L4-5   def c(self)"]


def test_outline_empty_and_bom_files(root: Path) -> None:
    assert outline_of(root, "empty.py", "") == "(no symbols found)"
    assert outline_of(root, "plain.py", "x = 1\nprint(x)\n") == "(no symbols found)"
    assert outline_of(root, "bom.py", "\ufeffdef f():\n    pass\n") == "L1-2 def f()"
    assert outline_of(root, "crlf.py", "def f():\r\n    pass\r\n\r\ndef g():\r\n    pass\r\n") == "L1-2 def f()\nL4-5 def g()"


def test_outline_cuts_a_long_signature(root: Path) -> None:
    args = ", ".join(f"argument_{i}: int = {i}" for i in range(30))
    line = outline_of(root, "long.py", f"def f({args}):\n    pass\n").split("\n")[0]
    assert line.startswith("L1-2 def f(argument_0: int=0, ") and line.endswith("...") and len(line) < 135


def test_outline_python_nests_four_levels_and_no_deeper(root: Path) -> None:
    text = ("class A:\n    class B:\n        class C:\n            class D:\n                class E:\n"
            "                    x = 1\n")
    assert outline_of(root, "deep.py", text).split("\n") == [
        "L1-6 class A", "L2-6   class B", "L3-6     class C", "L4-6       class D"]


def test_outline_cap(root: Path) -> None:
    text = "".join(f"def f{i}():\n    pass\n" for i in range(450))
    lines = outline_of(root, "many.py", text).split("\n")
    assert len(lines) == codeapi.MAX_OUTLINE_LINES + 1
    assert lines[0] == "L1-2 def f0()" and lines[399] == "L799-800 def f399()" and lines[-1] == "[... 50 more]"
    exactly = "".join(f"def f{i}():\n    pass\n" for i in range(400))
    assert "more]" not in outline_of(root, "exact.py", exactly)


# ---------------------------------------------------------------------------------------------- outline: other languages


TS_SOURCE = '''import { x } from "y";

export const MAX_RETRIES = 3;

/**
 * doc comment
 * function fake() {}
 */
export interface Options {
  retries: number;
  run(x: number): void;
}

export type Handler = (req: Request) => Response;

export enum Color { Red, Green }

export class Server extends Base implements Thing {
  private port = 80;
  handle = async (req: Request) => {
    return 1;
  };

  constructor(private opts: Options) {
    super();
  }

  async start(): Promise<void> {
    if (this.port) {
      await listen(this.port, () => {
        console.log("x");
      });
    }
    for (const a of b) {
      foo(a) {
    }
  }

  get name(): string {
    return "x";
  }

  static create<T>(x: T): Server {
    return new Server(x);
  }
}

export function helper(a: number, b: string): string {
  return a + b;
}

export const arrow = async (a: number) => {
  return a;
};

const short = (x: number) => x + 1;

function* gen() {
  yield 1;
}

export default function () {}

const items = list.map((i) => i);
'''


def test_outline_typescript(root: Path) -> None:
    assert outline_of(root, "src/server.ts", TS_SOURCE).split("\n") == [
        "L3 MAX_RETRIES =",
        "L9-12 export interface Options",
        "L14 export type Handler = (req: Request) => Response",
        "L16 export enum Color { Red, Green }",
        "L18-46 export class Server extends Base implements Thing",
        "L20-22   handle = async (req: Request)",
        "L24-26   constructor(private opts: Options)",
        "L28-37   async start(): Promise<void>",
        "L39-41   get name(): string",
        "L43-45   static create<T>(x: T): Server",
        "L48-50 export function helper(a: number, b: string): string",
        "L52-54 export const arrow = async (a: number)",
        "L56 const short = (x: number) => x + 1",
        "L58-60 function* gen()",
        "L62 export default function () {}",
    ]
    assert outline_of(root, "a.jsx", "function App() {\n  return 1;\n}\n") == "L1-3 function App()"
    for ext in (".js", ".mjs", ".cjs", ".tsx", ".mts", ".cts"):
        assert outline_of(root, f"x{ext}", "export function f() {\n}\n") == "L1-2 export function f()"


GO_SOURCE = '''package main

import "fmt"

// Server does things.
type Server struct {
	port int
}

type ID int

type Handler interface {
	Handle(w int) error
}

// New builds one.
func New(port int) *Server {
	return &Server{port: port}
}

func (s *Server) Start() error {
	go func() {
		fmt.Println("x")
	}()
	return nil
}

func (s *Server) Stop() {}
'''


def test_outline_go(root: Path) -> None:
    assert outline_of(root, "main.go", GO_SOURCE).split("\n") == [
        "L6-8 type Server struct",
        "L10 type ID int",
        "L12-14 type Handler interface",
        "L17-19 func New(port int) *Server",
        "L21-26 func (s *Server) Start() error",
        "L28 func (s *Server) Stop() {}",
    ]


RUST_SOURCE = '''use std::fmt;

pub const MAX_SIZE: usize = 10;

#[derive(Debug)]
pub struct Point {
    x: i32,
}

pub enum Shape {
    Circle,
}

pub trait Area {
    fn area(&self) -> f64;
    fn name(&self) -> String {
        "x".into()
    }
}

impl Area for Point {
    fn area(&self) -> f64 {
        0.0
    }
}

impl Point {
    pub fn new(x: i32) -> Self {
        Self { x }
    }
    pub(crate) async fn run(&self) {}
}

pub fn main() {
    println!("hi");
}

mod tests {
    use super::*;
    #[test]
    fn works() {
        assert!(true);
    }
}
'''


def test_outline_rust(root: Path) -> None:
    assert outline_of(root, "src/lib.rs", RUST_SOURCE).split("\n") == [
        "L3 MAX_SIZE =",
        "L6-8 pub struct Point",
        "L10-12 pub enum Shape",
        "L14-19 pub trait Area",
        "L15   fn area(&self) -> f64",
        "L16-18   fn name(&self) -> String",
        "L21-25 impl Area for Point",
        "L22-24   fn area(&self) -> f64",
        "L27-32 impl Point",
        "L28-30   pub fn new(x: i32) -> Self",
        "L31   pub(crate) async fn run(&self) {}",
        "L34-36 pub fn main()",
        "L38-44 mod tests",
        "L41-43   fn works()",
    ]


JAVA_SOURCE = '''package x;

import java.util.List;

/** Doc */
public class Foo extends Bar {
    private static final int MAX = 5;
    private final Map<String, Integer> map = new HashMap<>();

    @Override
    public String toString() {
        return "x";
    }

    public Foo(int x) {
        this.x = x;
        if (x > 1) {
            run(x);
        }
    }

    static <T> List<T> of(T a) {
        return null;
    }

    void run(int a)
    {
        for (int i = 0; i < a; i++) {
            foo(i);
        }
    }

    interface Inner {
        void go();
    }

    public Map<String, List<Integer>> build(int x, int y) {
        return x;
    }
}
'''


def test_outline_java_and_other_brace_languages(root: Path) -> None:
    assert outline_of(root, "Foo.java", JAVA_SOURCE).split("\n") == [
        "L6-40 public class Foo extends Bar",
        "L11-13   public String toString()",
        "L15-20   public Foo(int x)",
        "L22-24   static <T> List<T> of(T a)",
        "L26-31   void run(int a)",
        "L33-35   interface Inner",
        "L37-39   public Map<String, List<Integer>> build(int x, int y)",
    ]
    kotlin = "package a\n\ndata class User(val id: Int)\n\nobject Registry {\n    fun find(id: Int): User? = null\n" \
             "    private suspend fun load() {\n    }\n}\n\nfun main() {\n    println(\"x\")\n}\n"
    assert outline_of(root, "a.kt", kotlin).split("\n") == [
        "L3 data class User(val id: Int)", "L5-9 object Registry", "L6   fun find(id: Int): User? = null",
        "L7-8   private suspend fun load()", "L11-13 fun main()"]
    swift = ("struct Point {\n    var x: Int\n    init(x: Int) {\n        self.x = x\n    }\n"
             "    mutating func move(by dx: Int) {\n        x += dx\n    }\n}\n")
    assert outline_of(root, "p.swift", swift).split("\n") == [
        "L1-9 struct Point", "L3-5   init(x: Int)", "L6-8   mutating func move(by dx: Int)"]
    csharp = ("namespace App\n{\n    public class Service\n    {\n        public async Task<List<int>> RunAsync(int a)\n"
              "        {\n            var x = Foo(a);\n            return x;\n        }\n    }\n}\n")
    assert outline_of(root, "S.cs", csharp).split("\n") == [
        "L1-11 namespace App", "L3-10   public class Service", "L5-9     public async Task<List<int>> RunAsync(int a)"]


def test_outline_ruby_and_php(root: Path) -> None:
    ruby = ("module App\n  class Server < Base\n    # comment def fake\n    def initialize(port)\n      @port = port\n    end\n\n"
            "    def self.build\n      new(80)\n    end\n\n    def run\n      [1].each do |x|\n        puts x\n      end\n"
            "    end\n\n    def short; 1; end\n  end\nend\n")
    assert outline_of(root, "app.rb", ruby).split("\n") == [
        "L1-20 module App", "L2-19   class Server < Base", "L4-6     def initialize(port)", "L8-10     def self.build",
        "L12-16     def run", "L18     def short; 1; end"]
    php = ("<?php\nnamespace App;\n\nabstract class Model {\n    public function __construct($a) {\n        $this->a = $a;\n    }\n"
           "    public static function make(): static {\n        return new static;\n    }\n}\n\nfunction helper($x) {\n    return $x;\n}\n")
    assert outline_of(root, "m.php", php).split("\n") == [
        "L4-11 abstract class Model", "L5-7   public function __construct($a)", "L8-10   public static function make(): static",
        "L13-15 function helper($x)"]


def test_outline_without_closers_ends_at_the_next_symbol(root: Path) -> None:
    text = "func a() int\n\n// doc for b\nfunc b() int\n"  # a Go file that never closes: no `}` to find
    assert outline_of(root, "odd.go", text) == "L1 func a() int\nL4 func b() int"
    text = "class A {\n  m() {\n    x()\n  }\n"  # the class has no closing brace: it runs to the last line
    assert outline_of(root, "open.ts", text).split("\n") == ["L1-4 class A", "L2-4   m()"]


def test_outline_skips_minified_lines_quickly(root: Path) -> None:
    text = "function a() {\n}\n" + "function m() {" + " " * 100_000 + "}\n" + "function c() {\n}\n"
    assert outline_of(root, "min.js", text) == "L1-2 function a()\nL4-5 function c()"
    block = "/*\n" + " " * 3000 + " */\nfunction d() {\n}\n"  # a long line that closes a comment still closes it
    assert outline_of(root, "block.js", block) == "L3-4 function d()"


def test_outline_ignores_commented_out_declarations(root: Path) -> None:
    text = "// function a() {}\n/* function b() {}\n   function c() {} */\nfunction d() {\n}\n"
    assert outline_of(root, "c.js", text) == "L4-5 function d()"


# ---------------------------------------------------------------------------------------------- outline: files and errors


def test_outline_reads_the_work_repo_alias_and_relative_paths(root: Path) -> None:
    put(root, "pkg/a.py", "def f():\n    pass\n")
    space = make(tools=rt, repo=False)
    assert space["outline"]("/work/repo/pkg/a.py") == space["outline"]("pkg/a.py") == "L1-2 def f()"
    assert space["outline"](root / "pkg" / "a.py") == "L1-2 def f()"  # type: ignore[arg-type]


def test_outline_works_in_read_mode_and_repo_mode() -> None:
    assert make(repo=False)["outline"].__name__ == make(repo=True)["outline"].__name__ == "outline"


def test_outline_errors(root: Path) -> None:
    space = make(tools=rt, repo=False)
    put(root, "README.md", "# title\n")
    put(root, "Makefile", "all:\n")
    with pytest.raises(ValueError, match=r"outline\(\) reads \.py, \.pyi, \.js, .*\.go, \.rs, .*\.php files, not '\.md' files"):
        space["outline"]("README.md")
    with pytest.raises(ValueError, match="not a file with no extension"):
        space["outline"]("Makefile")
    with pytest.raises(FileNotFoundError, match="no such file: nope.py"):
        space["outline"]("nope.py")
    (root / "folder.py").mkdir()
    with pytest.raises(FileNotFoundError, match="no such file: folder.py"):
        space["outline"]("folder.py")
    put(root, "blob.py", b"\0\1\2\3")
    with pytest.raises(ValueError, match="blob.py is a binary file"):
        space["outline"]("blob.py")
    put(root, "huge.go", "x" * (codeapi.MAX_FILE_BYTES + 1))
    with pytest.raises(ValueError, match="over 5,000,000 bytes"):
        space["outline"]("huge.go")
    assert codeapi.SUPPORTED[:3] == (".py", ".pyi", ".js") and ".swift" in codeapi.SUPPORTED


def test_outline_tolerates_bad_utf8(root: Path) -> None:
    assert outline_of(root, "latin.py", b"# caf\xe9\ndef f():\n    pass\n") == "L2-3 def f()"  # type: ignore[arg-type]
