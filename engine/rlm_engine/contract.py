"""Prompt v4, copied from rlm_rl/bridge.py and rlm_rl/env.py (extract_code) at RLM commit 0b9af69.

KV cache: defines every byte of the system prompt, first message, observations and errors; all are pure functions of their arguments, so a run's prefix never changes.

The only place the model's bytes are defined. The text is training's, character for character, so
`prompt_hash(PROMPTS_V4)` equals training's `PROMPT_HASHES["v4"]` (S-14), and test_contract.py pins it.
Only prompt v4 is here: no v1 to v3 text and no socket bridge. Training's `SYSTEM_PROMPT` (the v2 text that
v4 is built from) is renamed `_SYSTEM_PROMPT_V2`, so the loop cannot pick the wrong prompt. The functions
take v4's arguments only: no `version`, and `limits` is required.
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

CONTRACT_VERSION = "v4"
# training's PROMPT_HASHES["v4"] (S-14): the LoRA only works on these exact bytes
TRAINING_HASH = "a71401e2e3bb2e94a424309d2ac01b58ec53a3407a7d9053e589512742b8a1d6"

# What the model sees in the REPL (spec §1.1).
# `submit` never crosses the bridge: its value comes back with the cell result.
API_NAMES = ("context", "llm", "llm_batch", "submit")

# Episode limits for the read families (spec §4). Edit families use EDIT_LIMITS (spec §12.3).
MAX_TURNS = 12
MAX_SUBCALLS = 30
ROOT_MAX_TOKENS = 3072
# What one cell's printed output shows the model. Raised from 2,000 for prompt v2 after the second seed
# (step 10 results §5, Rishi 2026-10-16): 40% of its cells were cut, the median cut cell printed 4,100
# characters, and a cut list led to the one suspicious audited win. 8,000 covers 78% of those cells. The
# REPL keeps this much; each episode's `Limits.output_max_chars` is its own cap, which the loop applies.
OUTPUT_MAX_CHARS = 8000
TRACEBACK_LINES = 6
CELL_TIMEOUT_S = 120

EDIT_REPO_PATH = "/work/repo"


@dataclass(frozen=True)
class Limits:
    """One family's episode limits (spec §4, §12.3). Each episode records the limits it ran under."""

    max_turns: int
    max_subcalls: int
    root_max_tokens: int
    output_max_chars: int
    cell_timeout_s: int  # compute only: time blocked on the bridge doesn't count
    cpus: float
    memory_mb: int
    pids: int
    grader_timeout_s: int | None  # edit families only
    # Sub-calls (prompt v4, 2026-10-18): how much one sub-call reads and writes, whether it thinks, and what an
    # oversize prompt does ("truncate": cut it, as v1-v3 did; "error": refuse it in the REPL so the model splits it).
    subcall_max_chars: int = 24_000
    subcall_max_tokens: int = 1024
    subcall_thinking: str | None = None
    subcall_oversize: str = "truncate"

    def as_dict(self) -> dict:
        return dataclasses.asdict(self)


READ_LIMITS = Limits(max_turns=MAX_TURNS, max_subcalls=MAX_SUBCALLS, root_max_tokens=ROOT_MAX_TOKENS,
                     output_max_chars=OUTPUT_MAX_CHARS, cell_timeout_s=CELL_TIMEOUT_S, cpus=1.0, memory_mb=512,
                     pids=64, grader_timeout_s=None)
EDIT_LIMITS = Limits(max_turns=20, max_subcalls=30, root_max_tokens=4096, output_max_chars=OUTPUT_MAX_CHARS,
                     cell_timeout_s=300, cpus=2.0, memory_mb=4096, pids=256, grader_timeout_s=600)
# Prompt v4 (prod-v1 checkpoint 20, Rishi 2026-10-18, documentation/step-12-multistep-plan.md step 2): sub-calls are
# sub-agents worth calling. Each reads 60,000 characters and writes 4,096 tokens, coding sub-calls think at low effort,
# an oversize prompt is an error instead of a silent cut, the budget is 80 sub-calls, and read families get 20 turns.
READ_LIMITS_V4 = dataclasses.replace(READ_LIMITS, max_turns=20, max_subcalls=80, root_max_tokens=4096,
                                     subcall_max_chars=60_000, subcall_max_tokens=4096, subcall_oversize="error")
EDIT_LIMITS_V4 = dataclasses.replace(EDIT_LIMITS, max_turns=30, max_subcalls=80, subcall_max_chars=60_000,
                                     subcall_max_tokens=4096, subcall_thinking="low", subcall_oversize="error")

# Sub-calls (spec §1.2).
SUBCALL_MAX_CHARS = 24_000
SUBCALL_TRUNCATION_MARK = "[prompt truncated]"
# Wire limits (mine): a larger submitted answer is an error in the REPL.
SUBMIT_MAX_BYTES = 100_000

# ----------------------------------------------------------------------------- prompt text v2 (spec §12.2)

_SYSTEM_PROMPT_V2 = """You are a Recursive Language Model. You work on a task whose input is too large to read directly. The input is stored in a persistent Python REPL as the string variable `context`; for coding tasks, a repository is also checked out on disk.

Each turn, write a short plan and then exactly one ```python code block. The REPL runs it and shows you what it prints (truncated to 8000 characters). Variables persist between turns.

Available in the REPL:
- `context`: the task input (str)
- `llm(prompt: str) -> str`: ask a language model; it can read about 20,000 characters per call
- `llm_batch(prompts: list[str]) -> list[str]`: ask several prompts in parallel; each prompt counts as one sub-call
- `submit(answer)`: give your final answer and end the episode

The REPL has only the Python standard library.

Your turn and sub-call limits are given with the task. Look at the structure of the input before processing it, decompose the work, use code for exact filtering and arithmetic, and use sub-calls for judgments that need reading comprehension. Call `submit()` once you are confident.

For coding tasks, the REPL starts in the repository and also has these tools. They return values; print what you need to see.
- `read_file(path, start=1, n=40) -> str`: numbered lines of a file
- `find_files(pattern, path=".") -> list[str]`: files matching a glob such as "src/**/*.py"
- `grep(pattern, path=".", glob=None, ignore_case=False, files_only=False) -> list[str]`: regex matches as "path:line: text"
- `edit_file(path, old, new, replace_all=False) -> str`: replace exact text that occurs once (or every time with replace_all=True); raises otherwise
- `write_file(path, text) -> str`: create or overwrite a file
- `shell(cmd, timeout=120)`: run a shell command; the result has `.code` and `.out` and prints as the exit code and the end of the output
- `diff() -> str`: your changes so far, as they will be graded

Explore with code and print summaries, not whole files. Use `llm_batch` to read many files at once, and `llm` to draft or review a change. Run the relevant build or tests with `shell` before you submit. Your changes to the repository are what gets graded, by tests you cannot see, so do not change existing tests or test configuration. There is no network."""

FIRST_USER_TEMPLATE = """Question: {question}

`context` holds {n_chars:,} characters in {n_lines} lines. The first 3 lines are:
{first_3_lines}

You have at most {max_turns} turns and {max_subcalls} sub-calls."""

EDIT_FIRST_USER_TEMPLATE = """Task: {task}

The repository is at /work/repo ({language}, {n_files} files). `context` holds this task and the repository's file list with sizes. Run its tests with: {test_hint}

When your change is ready, call submit() with a one-line summary. You have at most {max_turns} turns and {max_subcalls} sub-calls, and each cell may run for {cell_timeout_s} seconds."""

# Observation after each turn (spec §2.3), assembled by `observation()`. The same in v1 and v2.
OBS_OUTPUT = "REPL output:\n{stdout}"
OBS_NOTHING_PRINTED = "REPL output: (nothing printed)"
OBS_TRUNCATED = "\n[... {n} more characters truncated]"
OBS_ERROR = "Error:\n{error}"
OBS_COUNTERS = "({turns_left} turns left, {subcalls_left} sub-calls left)"
OBS_LAST_TURN = "Your next turn is the last one: it must call submit() with your best answer."
# Prompt v3 (step 11): under v2 the base model often answered in tool-call tags, then repeated them after the error.
NO_CODE_BLOCK_ERROR_V3 = ("No ```python code block found. Reply with exactly one ```python block. Tool-call tags "
                          "don't run here: call llm, llm_batch, submit and the tools as Python functions inside "
                          "the block.")

# What the model is told after a timeout or crash (spec §4, §12.2): v2 quotes the cell limit as a value, and edit
# episodes add one sentence.
CELL_TIMEOUT_TEMPLATE = (
    "The cell timed out after {cell_timeout_s} seconds of compute. The REPL was restarted and all variables were "
    "lost; `context` and your sub-call budget are unchanged."
)
CELL_CRASH_TEMPLATE = (
    "The REPL crashed ({{reason}}). It was restarted and all variables were lost; "
    "`context` and your sub-call budget are unchanged."
)
EDIT_FILES_UNCHANGED = " Your files in /work/repo are unchanged."
CELL_NOT_RUN = " This cell was not run."

# Prompt v4 (2026-10-18): v3 with the orchestrator framing the published RLM harnesses use (alexzhang13/rlm, Prime
# Intellect's RLMEnv, the RLM harness post's "nudge to decompose"), sub-calls described as the sub-agents they now are,
# and interface-first delegation for code (the main multi-agent coding failure is parts that don't fit together).
SYSTEM_PROMPT_V4 = (_SYSTEM_PROMPT_V2
    .replace("it can read about 20,000 characters per call", "it can read about 60,000 characters and write a few "
             "thousand tokens per call; a longer prompt is an error, so split it")
    .replace("Your turn and sub-call limits are given with the task. Look at the structure of the input before "
             "processing it, decompose the work, use code for exact filtering and arithmetic, and use sub-calls for "
             "judgments that need reading comprehension. Call `submit()` once you are confident.",
             "Your turn and sub-call limits are given with the task. You are an orchestrator, not a lone solver: your own "
             "view is small (8000 printed characters a turn), while sub-calls are sub-agents that each read a large "
             "piece and report back. First look at the structure of the input, then plan the decomposition: which "
             "pieces, which question for each, how you will combine the answers. Send independent pieces together "
             "with `llm_batch` (around 20 prompts a batch), ask each sub-call for a short, structured answer you can "
             "parse, combine the results with code, and check anything surprising with a follow-up sub-call. Use code "
             "for exact filtering and arithmetic, and sub-calls for reading and judgment. Call `submit()` once you "
             "are confident.")
    .replace("Explore with code and print summaries, not whole files. Use `llm_batch` to read many files at once, and "
             "`llm` to draft or review a change.",
             "Explore with code and print summaries, not whole files. Split coding work the same way: write the "
             "interfaces first (signatures, types, docstrings and how the parts call each other), give them to every "
             "sub-call, let each sub-call draft or review one part (`llm_batch` for parts that don't depend on each "
             "other) or check one suspect file or hypothesis, then integrate the parts yourself, run the tests and "
             "fix what fails."))
assert SYSTEM_PROMPT_V4.count("orchestrator") == 1 and "interfaces first" in SYSTEM_PROMPT_V4 and "60,000" in SYSTEM_PROMPT_V4

_OBSERVATION = [OBS_OUTPUT, OBS_NOTHING_PRINTED, OBS_TRUNCATED, OBS_ERROR, OBS_COUNTERS, OBS_LAST_TURN,
                NO_CODE_BLOCK_ERROR_V3]
# v3's messages with v4's system prompt; "limits" puts v4's sub-call and budget changes in its hash
PROMPTS_V4: dict[str, str] = {
    "system": SYSTEM_PROMPT_V4, "first_user": FIRST_USER_TEMPLATE + "\n\n" + EDIT_FIRST_USER_TEMPLATE,
    "observation": "\n".join(_OBSERVATION + [CELL_TIMEOUT_TEMPLATE, CELL_CRASH_TEMPLATE, EDIT_FILES_UNCHANGED, CELL_NOT_RUN]),
    "code": "```python blocks, and <function=python> tool-call blocks",
    "limits": json.dumps({"read": READ_LIMITS_V4.as_dict(), "edit": EDIT_LIMITS_V4.as_dict()}, sort_keys=True),
}


def prompt_hash(texts: dict[str, str]) -> str:
    """Training's PROMPT_HASHES method: sha256 of the sorted JSON of a version's texts."""
    return hashlib.sha256(json.dumps(texts, sort_keys=True).encode()).hexdigest()


def first_user_message(question: str, context: str, limits: Limits) -> str:
    """A read family's first message (v2: spec §2.2 plus one limits line)."""
    lines = context.splitlines()
    fields = dict(question=question, n_chars=len(context), n_lines=len(lines), first_3_lines="\n".join(lines[:3]))
    return FIRST_USER_TEMPLATE.format(**fields, max_turns=limits.max_turns, max_subcalls=limits.max_subcalls)


def edit_first_message(task: str, *, language: str, n_files: int, test_hint: str, limits: Limits) -> str:
    """An edit family's first message (spec §12.2). `test_hint` runs the visible tests, never a hidden test's name."""
    return EDIT_FIRST_USER_TEMPLATE.format(task=task, language=language, n_files=n_files, test_hint=test_hint,
                                           max_turns=limits.max_turns, max_subcalls=limits.max_subcalls,
                                           cell_timeout_s=limits.cell_timeout_s)


@dataclass(frozen=True)
class CellMessages:
    """What the sandbox tells the model after a timeout or a crash. `crash` has a {reason} field."""

    timeout: str
    crash: str
    not_run: str = CELL_NOT_RUN


def cell_messages(limits: Limits, edit: bool) -> CellMessages:
    tail = EDIT_FILES_UNCHANGED if edit else ""
    return CellMessages(CELL_TIMEOUT_TEMPLATE.format(cell_timeout_s=limits.cell_timeout_s) + tail,
                        CELL_CRASH_TEMPLATE.format() + tail)


def no_code_error() -> str:
    """What a turn without code gets back (v3 adds that tool-call tags don't run)."""
    return NO_CODE_BLOCK_ERROR_V3


# Pacing for edit episodes (RunConfig.pace_nudge; prod-v2, Rishi 2026-10-19). Base Qwen read a 1,800-line file in
# 30-130 line slices and made its first edit at turn 18-28 or never, so all 12 build-from-spec episodes of prod-v2's
# step 1 hit the 30-turn cap with nothing tested; "N turns left" alone didn't change that.
OBS_PACE_EDIT = ("Half your turns are gone and no file has changed yet. Write your implementation now with edit_file or "
                 "write_file (you can read more afterwards), then run the tests.")
OBS_PACE_TEST = "{turns_left} turns left: run the tests, fix what fails, and call submit()."
PACE_TEST_AT = 5


def pace_message(turns_left: int, max_turns: int, edited: bool) -> str | None:
    """The pacing line an edit episode's observation gets: from half its turns while no file has changed, and once at
    PACE_TEST_AT turns left after a change."""
    if not edited and turns_left <= max_turns // 2:
        return OBS_PACE_EDIT
    if edited and turns_left == PACE_TEST_AT:
        return OBS_PACE_TEST.format(turns_left=turns_left)
    return None


def observation(stdout: str, stdout_chars: int, error: str | None, turns_left: int, subcalls_left: int,
                max_chars: int, pace: str | None = None) -> str:
    """The user message after a turn. `stdout_chars` is how much the cell printed before truncation; `pace` is an edit
    episode's pacing line (pace_message)."""
    out = stdout[:max_chars]
    if stdout_chars > len(out):
        out += OBS_TRUNCATED.format(n=stdout_chars - len(out))
    parts = [OBS_OUTPUT.format(stdout=out) if out.strip() else OBS_NOTHING_PRINTED]
    if error:
        parts.append(OBS_ERROR.format(error=error))
    parts.append(OBS_COUNTERS.format(turns_left=turns_left, subcalls_left=subcalls_left))
    if pace and turns_left > 1:
        parts.append(pace)
    if turns_left == 1:
        parts.append(OBS_LAST_TURN)
    return "\n".join(parts)


def truncate_prompt(prompt: str, max_chars: int = SUBCALL_MAX_CHARS) -> str:
    if len(prompt) > max_chars:
        return prompt[:max_chars] + "\n" + SUBCALL_TRUNCATION_MARK
    return prompt


def oversize_message(n_chars: int, max_chars: int) -> str:
    """What an oversize sub-call prompt gets under prompt v4: an error the model can act on, not a silent cut."""
    return (f"sub-call prompt is {n_chars:,} characters; one sub-call reads at most {max_chars:,}. "
            "Split the input into smaller prompts (llm_batch runs them in parallel).")


def budget_exhausted_message(max_subcalls: int) -> str:
    return f"sub-call budget exhausted ({max_subcalls} total)"


def clean_text(text: str) -> str:
    """Replace lone surrogates, which the model can print but no API request can encode."""
    return text.encode("utf-8", "replace").decode("utf-8")


def valid_answer(value: Any) -> bool:
    """Whether a submitted value has the shape spec §1.2 allows: int, float, str, or a list of those."""
    scalar = (int, float, str)
    if isinstance(value, bool):
        return False
    if isinstance(value, scalar):
        return True
    return isinstance(value, list) and all(isinstance(v, scalar) and not isinstance(v, bool) for v in value)


# ----------------------------------------------------------------------------- code extraction (env.py)

_CODE_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL)


# Qwen3.8's own tool-call syntax around Python, as the base model wrote it on 43% of its turns under prompt v2 (step 11
# results §3): "<tool_call>", "<function=python>", the code, "</function>", "</tool_call>", sometimes with a parameter
# tag around the code, sometimes cut off before the closing tags.
_TOOL_CALL_CODE_RE = re.compile(r"<function=python>[ \t]*\n?(?:<parameter=\w+>[ \t]*\n?)?(.*?)"
                                r"(?:</parameter>\s*)?(?:</function>|</tool_call>|\Z)", re.DOTALL)


def extract_code(text: str | None, tool_calls: bool = True) -> str | None:
    """The first fenced code block in a reply, or None. With `tool_calls` (prompt v3), a reply without one may carry
    its code in a `<function=python>` tool call instead."""
    match = _CODE_RE.search(text or "")
    if match:
        return match.group(1)
    if tool_calls:
        found = _TOOL_CALL_CODE_RE.search(text or "")
        if found and found.group(1).strip():
            return found.group(1)
    return None
