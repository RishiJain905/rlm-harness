"""KV cache: rewrites the message list only at a compaction. The head (system prompt and first message) stays byte for byte, and everything after it changes once, so the provider's cache rebuilds from the head. The summary call itself replays the whole current list, a cache hit.

Compaction inside a run (v1 step 3, architecture §4). When the next request would pass the trigger, the middle of the
conversation is replaced by a summary the model writes itself; the system prompt, the first message and the newest
turns stay verbatim, and the REPL keeps every variable. The rule is DeepSeek Harness's (D-171): trigger
min(0.8 W', W' - output - reserve), never below W' / 2, and keep the newest `keep_ratio` of (W' - output), on
W' = min(the model's window, the profile's `[compaction] window`).

`compact` is pure apart from the `summarize` coroutine its caller passes, so tests drive it without a model.
COMPACT_REQUEST and COMPACTED belong to the profile layer, not prompt v4: no hash covers them, and `training-v4`,
which has no `[compaction]`, never sends them. Standard library only, besides `contract.extract_code`.
"""

from __future__ import annotations

import json
import math
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from . import contract
from .profiles import CompactionSettings

COMPACT_REQUEST = (
    "Stop work on the task for this one reply. The conversation is about to be shortened: every turn after the "
    "first message will be replaced by a summary you write now, and only the newest turns will stay as they are. "
    "The REPL keeps running, so every variable you have made stays as it is.\n\n"
    "Write the summary as plain text. Do not write code and do not call a tool. Include:\n"
    "- what the task is, and what is already done;\n"
    "- what you found, with the exact numbers, names and file paths that matter;\n"
    "- every REPL variable that holds state you still need, and what it holds;\n"
    "- what you were about to do next.\n\n"
    "Keep it under {max_words:,} words."
)
COMPACTED = (
    "[{turns} earlier turns were compacted to save context. Your summary of them follows.]\n\n"
    "{summary}\n\n"
    "[The newest turns follow as they were. The REPL still holds every variable.]"
)

CHARS_PER_TOKEN = 3  # the gateway's own estimate (D-25)
WORDS_PER_TOKEN = 5  # COMPACT_REQUEST's word cap: summary_max_tokens // 5
FALLBACK_LINE_MAX = 200
NO_LOOP_RATIO = 0.8  # a compaction that leaves more than this much of its estimate is the last one (§4.2 step 6)


@dataclass(frozen=True)
class Plan:
    """One run's compaction numbers, in tokens (§4.1)."""

    window: int  # W'
    trigger: int
    keep: int

    def as_event(self) -> dict:
        """`run.started.compaction`."""
        return {"window": self.window, "trigger": self.trigger, "keep": self.keep}


@dataclass
class Compacted:
    messages: list[dict]  # head + the summary message + tail
    dropped: int  # messages replaced by the summary
    kept: int  # messages in the tail
    turns: int  # assistant messages dropped
    summary: str


def plan(settings: CompactionSettings, window: dict, out: int) -> Plan:
    """§4.1. `window` is run.start's `{context_window, max_output}` (0 means unknown), `out` the mode's
    root_max_tokens."""
    model_window = window.get("context_window") or 0
    w = min(model_window, settings.window) if model_window > 0 else settings.window
    trigger = max(min(int(0.8 * w), w - out - settings.reserve), w // 2)
    return Plan(window=w, trigger=trigger, keep=int(settings.keep_ratio * (w - out)))


def total_chars(messages: list[dict]) -> int:
    """Every `content` string, plus every tool call's arguments as compact JSON (as the gateway counts them)."""
    n = 0
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            n += len(content)
        call = message.get("tool_call")
        if isinstance(call, dict):
            n += len(json.dumps(call.get("arguments"), ensure_ascii=False, separators=(",", ":")))
    return n


def estimate(messages: list[dict], last_usage: dict | None, chars_since: int) -> int:
    """The next request's size in tokens: the last reply's input and output plus what was appended since, or the
    whole list at ceil(chars / 3) when there is no usable last reply."""
    if not last_usage or not last_usage.get("input_tokens"):
        return math.ceil(total_chars(messages) / CHARS_PER_TOKEN)
    return (int(last_usage.get("input_tokens") or 0) + int(last_usage.get("output_tokens") or 0)
            + math.ceil(chars_since / CHARS_PER_TOKEN))


def _turns(body: list[dict]) -> tuple[list[dict], list[list[dict]]]:
    """`body` (the list after the head) as a preamble (anything before its first assistant message, such as an
    earlier compaction's summary) and turns: each an assistant message and every message after it up to the next
    one, so a native tool call is never parted from its tool result."""
    preamble: list[dict] = []
    turns: list[list[dict]] = []
    for message in body:
        if message.get("role") == "assistant":
            turns.append([message])
        elif turns:
            turns[-1].append(message)
        else:
            preamble.append(message)
    return preamble, turns


async def compact(messages: list[dict], *, keep_tokens: int, summarize: Callable[[list[dict]], Awaitable[str]],
                  summary_max_tokens: int = 8192) -> Compacted | None:
    """§4.2 steps 1 to 5. None when there is no turn to drop; `summarize` is then never called.

    `summarize(request)` gets the current list plus one user message holding COMPACT_REQUEST and returns the
    summary text; an empty text (the caller's answer to a failed call it can go on from, D-200) falls back to
    `fallback_summary`."""
    head, body = messages[:2], messages[2:]
    preamble, turns = _turns(body)
    tail: list[dict] = []
    kept_turns = 0
    for turn in reversed(turns):
        if kept_turns and math.ceil(total_chars(turn + tail) / CHARS_PER_TOKEN) > keep_tokens:
            break
        tail = turn + tail
        kept_turns += 1
    dropped_turns = turns[:len(turns) - kept_turns]
    if not dropped_turns:
        return None
    middle = preamble + [m for turn in dropped_turns for m in turn]
    request = messages + [{"role": "user", "content": COMPACT_REQUEST.format(
        max_words=summary_max_tokens // WORDS_PER_TOKEN)}]
    summary = (await summarize(request) or "").strip() or fallback_summary(middle)
    note = {"role": "user", "content": COMPACTED.format(turns=len(dropped_turns), summary=summary)}
    return Compacted(messages=head + [note] + tail, dropped=len(middle), kept=len(tail), turns=len(dropped_turns),
                     summary=summary)


def fallback_summary(dropped: list[dict]) -> str:
    """One line per dropped assistant message: `Turn n: ` and the first non-empty line of its code, or of its text,
    cut to 200 characters."""
    lines = []
    for n, message in enumerate((m for m in dropped if m.get("role") == "assistant"), 1):
        call = message.get("tool_call")
        arguments = call.get("arguments") if isinstance(call, dict) else None
        code = arguments.get("code") if isinstance(arguments, dict) else None
        if not isinstance(code, str):
            code = contract.extract_code(message.get("content"))
        first = _first_line(code) or _first_line(message.get("content"))
        lines.append(f"Turn {n}: {first[:FALLBACK_LINE_MAX]}")
    return "\n".join(lines)


def _first_line(text: str | None) -> str:
    return next((line.strip() for line in (text or "").splitlines() if line.strip()), "")
