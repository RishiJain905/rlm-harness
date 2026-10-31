"""KV cache: none

contract.py against training's prompt v4 (S-14). Every expected string here was produced by running training's
own function from rlm_rl/bridge.py or env.py at 0b9af69, never typed by hand. test_against_training_source
re-checks the copy against the training repo itself when RLM_TRAINING_REPO points at it.
"""

from __future__ import annotations

import ast
import dataclasses
import importlib.util
import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from rlm_engine import contract as c

FIXTURES = Path(__file__).resolve().parent / "fixtures"
EXTRACT_CASES: list[dict] = json.loads((FIXTURES / "extract_cases.json").read_text(encoding="utf-8"))
TRAINING_COMMIT = "0b9af69"

READ_LIMITS_JSON = (
    '{"cell_timeout_s": 120, "cpus": 1.0, "grader_timeout_s": null, "max_subcalls": 80, "max_turns": 20, '
    '"memory_mb": 512, "output_max_chars": 8000, "pids": 64, "root_max_tokens": 4096, "subcall_max_chars": 60000, '
    '"subcall_max_tokens": 4096, "subcall_oversize": "error", "subcall_thinking": null}'
)
EDIT_LIMITS_JSON = (
    '{"cell_timeout_s": 300, "cpus": 2.0, "grader_timeout_s": 600, "max_subcalls": 80, "max_turns": 30, '
    '"memory_mb": 4096, "output_max_chars": 8000, "pids": 256, "root_max_tokens": 4096, "subcall_max_chars": 60000, '
    '"subcall_max_tokens": 4096, "subcall_oversize": "error", "subcall_thinking": "low"}'
)
FIRST_USER = (
    "Question: How many?\n\n`context` holds 24 characters in 4 lines. The first 3 lines are:\na,b\nline 2\nline 3\n\n"
    "You have at most 20 turns and 80 sub-calls."
)
EDIT_FIRST = (
    "Task: Fix the parser.\n\nThe repository is at /work/repo (go, 41 files). `context` holds this task and the "
    "repository's file list with sizes. Run its tests with: go test ./...\n\nWhen your change is ready, call submit() "
    "with a one-line summary. You have at most 30 turns and 80 sub-calls, and each cell may run for 300 seconds."
)
TIMEOUT_READ = (
    "The cell timed out after 120 seconds of compute. The REPL was restarted and all variables were lost; `context` "
    "and your sub-call budget are unchanged."
)
CRASH_READ = (
    "The REPL crashed ({reason}). It was restarted and all variables were lost; `context` and your sub-call budget "
    "are unchanged."
)
TIMEOUT_EDIT = (
    "The cell timed out after 300 seconds of compute. The REPL was restarted and all variables were lost; `context` "
    "and your sub-call budget are unchanged. Your files in /work/repo are unchanged."
)
CRASH_EDIT = (
    "The REPL crashed ({reason}). It was restarted and all variables were lost; `context` and your sub-call budget "
    "are unchanged. Your files in /work/repo are unchanged."
)
CRASH_EDIT_FILLED = (
    "The REPL crashed (exit code 1). It was restarted and all variables were lost; `context` and your sub-call budget "
    "are unchanged. Your files in /work/repo are unchanged."
)
NO_CODE = (
    "No ```python code block found. Reply with exactly one ```python block. Tool-call tags don't run here: call llm, "
    "llm_batch, submit and the tools as Python functions inside the block."
)
OVERSIZE = (
    "sub-call prompt is 72,000 characters; one sub-call reads at most 60,000. Split the input into smaller prompts "
    "(llm_batch runs them in parallel)."
)
PACE_EDIT = (
    "Half your turns are gone and no file has changed yet. Write your implementation now with edit_file or "
    "write_file (you can read more afterwards), then run the tests."
)
LAST_TURN = "Your next turn is the last one: it must call submit() with your best answer."

# (args, kwargs, expected) for contract.observation, each produced by bridge.observation
OBSERVATION_SAMPLES = [
    (("", 0, None, 5, 30, 8000), {}, "REPL output: (nothing printed)\n(5 turns left, 30 sub-calls left)"),
    (("hi\n", 3, "NameError: x", 1, 2, 8000), {},
     "REPL output:\nhi\n\nError:\nNameError: x\n(1 turns left, 2 sub-calls left)\n" + LAST_TURN),
    (("x" * 10, 25, None, 3, 30, 8000), {},
     "REPL output:\nxxxxxxxxxx\n[... 15 more characters truncated]\n(3 turns left, 30 sub-calls left)"),
    (("ok\n", 3, None, 5, 30, 8000), {"pace": "5 turns left: run the tests, fix what fails, and call submit()."},
     "REPL output:\nok\n\n(5 turns left, 30 sub-calls left)\n5 turns left: run the tests, fix what fails, and call submit()."),
    (("ok\n", 3, None, 1, 30, 8000), {"pace": PACE_EDIT},
     "REPL output:\nok\n\n(1 turns left, 30 sub-calls left)\n" + LAST_TURN),
]


def test_hash_matches_training() -> None:
    assert c.prompt_hash(c.PROMPTS_V4) == c.TRAINING_HASH == "a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6"
    assert c.CONTRACT_VERSION == "v4"


def test_prompts_v4_shape() -> None:
    assert list(c.PROMPTS_V4) == ["system", "first_user", "observation", "code", "limits"]
    assert c.PROMPTS_V4["system"] is c.SYSTEM_PROMPT_V4
    assert c.PROMPTS_V4["first_user"] == c.FIRST_USER_TEMPLATE + "\n\n" + c.EDIT_FIRST_USER_TEMPLATE
    assert c.PROMPTS_V4["code"] == "```python blocks, and <function=python> tool-call blocks"
    assert c.PROMPTS_V4["limits"] == json.dumps(
        {"read": c.READ_LIMITS_V4.as_dict(), "edit": c.EDIT_LIMITS_V4.as_dict()}, sort_keys=True
    )
    assert c.no_code_error() in c.PROMPTS_V4["observation"].split("\n")


def test_hash_covers_every_text() -> None:
    for key in c.PROMPTS_V4:
        changed = dict(c.PROMPTS_V4, **{key: c.PROMPTS_V4[key] + " "})
        assert c.prompt_hash(changed) != c.TRAINING_HASH, key


def test_limits() -> None:
    assert [f.name for f in dataclasses.fields(c.Limits)] == [
        "max_turns", "max_subcalls", "root_max_tokens", "output_max_chars", "cell_timeout_s", "cpus", "memory_mb",
        "pids", "grader_timeout_s", "subcall_max_chars", "subcall_max_tokens", "subcall_thinking", "subcall_oversize",
    ]
    assert json.dumps(c.READ_LIMITS_V4.as_dict(), sort_keys=True) == READ_LIMITS_JSON
    assert json.dumps(c.EDIT_LIMITS_V4.as_dict(), sort_keys=True) == EDIT_LIMITS_JSON
    assert (c.READ_LIMITS_V4.cpus, c.EDIT_LIMITS_V4.cpus) == (1.0, 2.0)
    assert isinstance(c.READ_LIMITS_V4.cpus, float) and isinstance(c.EDIT_LIMITS_V4.cpus, float)


def test_system_prompt_v4() -> None:
    prompt = c.SYSTEM_PROMPT_V4
    assert len(prompt) == 3076
    assert prompt.endswith("There is no network.")
    assert prompt.count("orchestrator") == 1
    assert "interfaces first" in prompt and "60,000" in prompt
    for name in c.API_NAMES:
        assert f"`{name}" in prompt, name
    assert "llm_query" not in prompt
    assert c._SYSTEM_PROMPT_V2 != prompt


def test_messages() -> None:
    first = c.first_user_message("How many?", "a,b\nline 2\nline 3\nline 4", c.READ_LIMITS_V4)
    assert first == FIRST_USER
    assert first.endswith("You have at most 20 turns and 80 sub-calls.")
    edit = c.edit_first_message("Fix the parser.", language="go", n_files=41, test_hint="go test ./...",
                                limits=c.EDIT_LIMITS_V4)
    assert edit == EDIT_FIRST
    assert "/work/repo (go, 41 files)" in edit and "30 turns and 80 sub-calls" in edit and "300 seconds" in edit

    read = c.cell_messages(c.READ_LIMITS_V4, edit=False)
    assert read == c.CellMessages(TIMEOUT_READ, CRASH_READ)
    assert "/work/repo" not in read.timeout + read.crash
    repo = c.cell_messages(c.EDIT_LIMITS_V4, edit=True)
    assert repo == c.CellMessages(TIMEOUT_EDIT, CRASH_EDIT)
    assert repo.timeout.endswith("Your files in /work/repo are unchanged.")
    assert repo.crash.format(reason="exit code 1") == CRASH_EDIT_FILLED
    assert read.not_run == repo.not_run == " This cell was not run."

    assert c.no_code_error() == NO_CODE
    assert c.oversize_message(72000, 60000) == OVERSIZE
    assert c.budget_exhausted_message(80) == "sub-call budget exhausted (80 total)"


def test_observation() -> None:
    for args, kwargs, expected in OBSERVATION_SAMPLES:
        assert c.observation(*args, **kwargs) == expected, args
    assert c.observation("  \n", 3, None, 5, 30, 8000).splitlines()[0] == "REPL output: (nothing printed)"
    cut = c.observation("x" * 9000, 9000, None, 3, 30, max_chars=2000)
    assert cut.startswith("REPL output:\n" + "x" * 2000 + "\n[... 7000 more characters truncated]")
    assert "x" * 2001 not in cut


def test_pace_message() -> None:
    assert c.pace_message(16, 30, False) is None
    assert c.pace_message(15, 30, False) == c.OBS_PACE_EDIT == PACE_EDIT
    assert c.pace_message(15, 30, True) is None
    assert c.pace_message(5, 30, True) == "5 turns left: run the tests, fix what fails, and call submit()."
    assert c.pace_message(4, 30, True) is None
    assert c.PACE_TEST_AT == 5


def test_small_helpers() -> None:
    assert c.truncate_prompt("x" * 24_001) == "x" * 24_000 + "\n[prompt truncated]"
    assert c.truncate_prompt("x" * 24_000) == "x" * 24_000
    assert c.clean_text("a\ud800b") == "a?b"
    for ok in (3, 2.5, "host-7", [], [1, "a", 2.0]):
        assert c.valid_answer(ok), ok
    for bad in (None, True, {"a": 1}, [[1]], [None], [False]):
        assert not c.valid_answer(bad), bad


def test_extract_code_matches_training() -> None:
    assert len(EXTRACT_CASES) == len({case["name"] for case in EXTRACT_CASES})
    for case in EXTRACT_CASES:
        assert c.extract_code(case["text"], tool_calls=case["tool_calls"]) == case["expected"], case["name"]
    # tool_calls defaults to True here (training's default was False; prompt v4 always passed True)
    assert c.extract_code("<function=python>\nprint(1)\n</function>") == "print(1)\n"


# ----------------------------------------------------------------------------- against the training repo


def _training_source(repo: str, path: str) -> str:
    out = subprocess.run(["git", "-C", repo, "show", f"{TRAINING_COMMIT}:{path}"], capture_output=True, check=True)
    return out.stdout.decode("utf-8")


def _load_bridge(source: str, tmp_path: Path):
    path = tmp_path / "training_bridge.py"
    path.write_text(source, encoding="utf-8", newline="")
    spec = importlib.util.spec_from_file_location("training_bridge", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["training_bridge"] = module  # @dataclass looks the module up while the class is built
    try:
        spec.loader.exec_module(module)
    finally:
        del sys.modules["training_bridge"]
    return module


def _env_extract_code(source: str):
    """env.extract_code and its two regexes, pulled out with ast: importing env.py needs openai."""
    tree = ast.parse(source)
    keep = [
        node for node in tree.body
        if (isinstance(node, ast.Assign) and getattr(node.targets[0], "id", "") in ("_CODE_RE", "_TOOL_CALL_CODE_RE"))
        or (isinstance(node, ast.FunctionDef) and node.name == "extract_code")
    ]
    assert len(keep) == 3
    namespace: dict = {"re": re}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "training_env", "exec"), namespace)
    return namespace["extract_code"]


@pytest.mark.skipif(not os.environ.get("RLM_TRAINING_REPO"), reason="set RLM_TRAINING_REPO to the RLM checkout")
def test_against_training_source(tmp_path: Path) -> None:
    repo = os.environ["RLM_TRAINING_REPO"]
    bridge = _load_bridge(_training_source(repo, "rlm_rl/bridge.py"), tmp_path)
    extract_code = _env_extract_code(_training_source(repo, "rlm_rl/env.py"))

    assert c.PROMPTS_V4 == bridge.PROMPTS["v4"]
    assert list(c.PROMPTS_V4) == list(bridge.PROMPTS["v4"])
    assert c.prompt_hash(c.PROMPTS_V4) == bridge.PROMPT_HASHES["v4"] == c.TRAINING_HASH
    assert c.READ_LIMITS_V4.as_dict() == bridge.READ_LIMITS_V4.as_dict()
    assert c.EDIT_LIMITS_V4.as_dict() == bridge.EDIT_LIMITS_V4.as_dict()
    assert [f.name for f in dataclasses.fields(c.Limits)] == [f.name for f in dataclasses.fields(bridge.Limits)]
    for case in EXTRACT_CASES:
        assert c.extract_code(case["text"], case["tool_calls"]) == extract_code(case["text"], case["tool_calls"]), case
    for args, kwargs, expected in OBSERVATION_SAMPLES:
        assert bridge.observation(*args, **kwargs) == c.observation(*args, **kwargs) == expected, args
    for name in ("API_NAMES", "EDIT_REPO_PATH", "OUTPUT_MAX_CHARS", "TRACEBACK_LINES", "SUBMIT_MAX_BYTES",
                 "SUBCALL_MAX_CHARS", "SUBCALL_TRUNCATION_MARK", "PACE_TEST_AT", "OBS_PACE_EDIT", "OBS_PACE_TEST"):
        assert getattr(c, name) == getattr(bridge, name), name
    for limits, edit in ((c.READ_LIMITS_V4, False), (c.EDIT_LIMITS_V4, True)):
        theirs = bridge.cell_messages("v4", bridge.limits("edit_real" if edit else "read", "v4"), edit=edit)
        assert dataclasses.astuple(c.cell_messages(limits, edit)) == dataclasses.astuple(theirs), edit
    assert c.oversize_message(72000, 60000) == bridge.oversize_message(72000, 60000)
