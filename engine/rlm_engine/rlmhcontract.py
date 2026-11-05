"""rlmh's own contract, `rlmh-1` (D-256): the first messages, observations and cell notes of every profile whose
`contract` is "rlmh-1", the built-in `default` among them. Prompt v4 (contract.py) stays training's, byte for byte,
for `training-v4` and the LoRA; nothing here is copied from training. `Texts` (at the end) gathers either contract's
texts into one object, `Profile.texts`, which the loop, children and bridge take every model-facing text from.

KV cache: defines the bytes of a rlmh-1 run's first message, observations and errors; all are pure functions of their
arguments, so a run's prefix never changes. The system prompt is the profile's own `system.md` (profiles.py).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Callable

from . import contract

CONTRACT_VERSION = "rlmh-1"

FIRST_USER_TEMPLATE = """Question: {question}

`context` holds {n_chars:,} characters in {n_lines:,} lines. Its first 3 lines are:
{first_3_lines}

Your budget: {max_turns} turns and {max_subcalls} sub-calls."""

EDIT_FIRST_USER_TEMPLATE = """Task: {task}

The REPL runs in the repository ({language}, {n_files:,} files), so relative paths work everywhere; `context` holds this task and the repository's file list with sizes. Run its tests with: {test_hint}

Your budget: {max_turns} turns and {max_subcalls} sub-calls, and each cell may compute for {cell_timeout_s} seconds. When your change is ready, call submit() with a short summary of it; if the task asks a question instead, submit the whole answer."""

OBS_OUTPUT = "Output:\n{stdout}"
OBS_NOTHING_PRINTED = "Output: (nothing printed)"
OBS_TRUNCATED = "\n[{n:,} more characters not shown: print less, or keep it in a variable and print the part you need]"
OBS_ERROR = "Error:\n{error}"
OBS_COUNTERS = "[{turns_left} turns and {subcalls_left} sub-calls left]"
OBS_LAST_TURN = "Your next turn is your last: it must call submit() with your best answer."
NO_CODE_ERROR = ("Nothing ran: the reply had no Python. Run one cell each turn, with the python tool or, when no tool is "
                 "offered, one ```python block; call llm, submit and the other helpers inside it.")

CELL_TIMEOUT_TEMPLATE = ("The cell passed its {cell_timeout_s}-second compute limit and was stopped. The REPL restarted, "
                         "so every variable is gone; `context` and your sub-call budget are as they were.")
CELL_CRASH_TEMPLATE = ("The REPL crashed ({{reason}}) and restarted, so every variable is gone; `context` and your "
                       "sub-call budget are as they were.")
EDIT_FILES_KEPT = " Your changes to the repository are kept."
CELL_NOT_RUN = " This cell was not run."

OBS_PACE_EDIT = ("Half your turns are gone and no file has changed yet. Make your change now with edit_file or "
                 "write_file (you can read more afterwards), then run the tests.")
OBS_PACE_TEST = "{turns_left} turns left: run the tests, fix what fails, and call submit()."

_OBSERVATION = [OBS_OUTPUT, OBS_NOTHING_PRINTED, OBS_TRUNCATED, OBS_ERROR, OBS_COUNTERS, OBS_LAST_TURN, NO_CODE_ERROR,
                CELL_TIMEOUT_TEMPLATE, CELL_CRASH_TEMPLATE, EDIT_FILES_KEPT, CELL_NOT_RUN, OBS_PACE_EDIT, OBS_PACE_TEST]

# The texts a rlmh-1 profile's prompt hash covers, beside its system text and limits (profiles.py fills those two)
PROMPTS: dict[str, str] = {
    "contract": CONTRACT_VERSION,
    "first_user": FIRST_USER_TEMPLATE + "\n\n" + EDIT_FIRST_USER_TEMPLATE,
    "observation": "\n".join(_OBSERVATION),
    "code": "the python tool, or ```python blocks",
}


def contract_hash() -> str:
    """The hash of rlmh-1's own texts, as `contract.prompt_hash` hashes prompt v4's."""
    return contract.prompt_hash(PROMPTS)


def first_user_message(question: str, context: str, limits: contract.Limits) -> str:
    lines = context.splitlines()
    return FIRST_USER_TEMPLATE.format(question=question, n_chars=len(context), n_lines=len(lines),
                                      first_3_lines="\n".join(lines[:3]), max_turns=limits.max_turns,
                                      max_subcalls=limits.max_subcalls)


def edit_first_message(task: str, *, language: str, n_files: int, test_hint: str, limits: contract.Limits) -> str:
    return EDIT_FIRST_USER_TEMPLATE.format(task=task, language=language, n_files=n_files, test_hint=test_hint,
                                           max_turns=limits.max_turns, max_subcalls=limits.max_subcalls,
                                           cell_timeout_s=limits.cell_timeout_s)


def cell_messages(limits: contract.Limits, edit: bool) -> contract.CellMessages:
    tail = EDIT_FILES_KEPT if edit else ""
    return contract.CellMessages(CELL_TIMEOUT_TEMPLATE.format(cell_timeout_s=limits.cell_timeout_s) + tail,
                                 CELL_CRASH_TEMPLATE.format() + tail, CELL_NOT_RUN)


def no_code_error() -> str:
    return NO_CODE_ERROR


def pace_message(turns_left: int, max_turns: int, edited: bool) -> str | None:
    """The same rule as prompt v4's pacing (contract.pace_message), in rlmh-1's words."""
    if not edited and turns_left <= max_turns // 2:
        return OBS_PACE_EDIT
    if edited and turns_left == contract.PACE_TEST_AT:
        return OBS_PACE_TEST.format(turns_left=turns_left)
    return None


def truncated(n: int) -> str:
    return OBS_TRUNCATED.format(n=n)


def observation(stdout: str, stdout_chars: int, error: str | None, turns_left: int, subcalls_left: int,
                max_chars: int, pace: str | None = None) -> str:
    """The message after a turn: the same shape as prompt v4's (contract.observation), in rlmh-1's words."""
    out = stdout[:max_chars]
    if stdout_chars > len(out):
        out += truncated(stdout_chars - len(out))
    parts = [OBS_OUTPUT.format(stdout=out) if out.strip() else OBS_NOTHING_PRINTED]
    if error:
        parts.append(OBS_ERROR.format(error=error))
    parts.append(OBS_COUNTERS.format(turns_left=turns_left, subcalls_left=subcalls_left))
    if pace and turns_left > 1:
        parts.append(pace)
    if turns_left == 1:
        parts.append(OBS_LAST_TURN)
    return "\n".join(parts)


def oversize_message(n_chars: int, max_chars: int) -> str:
    return (f"this sub-call's prompt is {n_chars:,} characters, over the {max_chars:,} one sub-call reads; split it "
            "(segments() and llm_batch(prompts, over=...) do the splitting for you)")


def budget_exhausted_message(max_subcalls: int) -> str:
    return f"no sub-calls left: all {max_subcalls} are spent"


def limits_text(read: contract.Limits, repo: contract.Limits) -> str:
    return json.dumps({"read": read.as_dict(), "edit": repo.as_dict()}, sort_keys=True)


# ----------------------------------------------------------------------------- one run's texts, by contract


@dataclass(frozen=True)
class Texts:
    """Every model-facing text a run takes from its contract (D-256): the loop, children, bridge and worker manager ask
    the run's profile (`Profile.texts`) for these instead of calling contract.py, so prompt v4's words reach only v4
    profiles and rlmh-1's only rlmh-1 ones. `contract_hash` is the hash the run record and `run.started` show."""

    version: str
    contract_hash: str
    first_user_message: Callable[..., str]
    edit_first_message: Callable[..., str]
    cell_messages: Callable[[contract.Limits, bool], contract.CellMessages]
    no_code_error: Callable[[], str]
    pace_message: Callable[[int, int, bool], str | None]
    observation: Callable[..., str]
    truncated: Callable[[int], str]  # the note after a cell's cut output
    oversize_message: Callable[[int, int], str]
    budget_exhausted_message: Callable[[int], str]


def _v4_truncated(n: int) -> str:
    return contract.OBS_TRUNCATED.format(n=n)


V4 = Texts(version=contract.CONTRACT_VERSION, contract_hash=contract.prompt_hash(contract.PROMPTS_V4),
           first_user_message=contract.first_user_message, edit_first_message=contract.edit_first_message,
           cell_messages=contract.cell_messages, no_code_error=contract.no_code_error,
           pace_message=contract.pace_message, observation=contract.observation, truncated=_v4_truncated,
           oversize_message=contract.oversize_message, budget_exhausted_message=contract.budget_exhausted_message)
RLMH1 = Texts(version=CONTRACT_VERSION, contract_hash=contract_hash(), first_user_message=first_user_message,
              edit_first_message=edit_first_message, cell_messages=cell_messages, no_code_error=no_code_error,
              pace_message=pace_message, observation=observation, truncated=truncated,
              oversize_message=oversize_message, budget_exhausted_message=budget_exhausted_message)
# profile.toml's `contract` -> its texts
TEXTS: dict[str, Texts] = {V4.version: V4, RLMH1.version: RLMH1}
