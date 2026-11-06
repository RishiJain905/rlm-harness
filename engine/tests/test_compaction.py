"""KV cache: none

compaction.py on its own (v1 step 3): the plan's numbers, the estimate, which messages stay, the two pinned texts and
the fallback summary. No model: `summarize` is a stub.
"""

from __future__ import annotations

import asyncio
import math

from rlm_engine import compaction
from rlm_engine.compaction import COMPACT_REQUEST, COMPACTED
from rlm_engine.profiles import CompactionSettings

DEFAULT = CompactionSettings(window=262144, keep_ratio=0.16, reserve=65536, summary_max_tokens=8192)


def run(coro):
    return asyncio.run(coro)


def assistant(text: str, code: str | None = None, call_id: str | None = None) -> dict:
    message = {"role": "assistant", "content": text}
    if call_id is not None:
        message["tool_call"] = {"id": call_id, "name": "python", "arguments": {"code": code or ""}}
    return message


def conversation(turns: int, chars: int = 300, native: bool = False) -> list[dict]:
    messages = [{"role": "system", "content": "SYSTEM"}, {"role": "user", "content": "FIRST"}]
    for i in range(1, turns + 1):
        if native:
            messages.append(assistant("", f"print({i})", f"call_{i}"))
            messages.append({"role": "tool", "tool_call_id": f"call_{i}", "content": str(i) * chars})
        else:
            messages.append(assistant(f"Turn {i}.\n```python\nprint({i})\n```"))
            messages.append({"role": "user", "content": str(i % 10) * chars})
    return messages


class Stub:
    def __init__(self, text: str = "S") -> None:
        self.text = text
        self.requests: list[list[dict]] = []

    async def __call__(self, request: list[dict]) -> str:
        self.requests.append(request)
        return self.text


def test_plan_numbers() -> None:
    deepseek = compaction.plan(DEFAULT, {"context_window": 1_048_576, "max_output": 65536}, 16384)
    assert deepseek == compaction.Plan(window=262144, trigger=180224, keep=39321)
    assert deepseek.as_event() == {"window": 262144, "trigger": 180224, "keep": 39321}
    assert compaction.plan(DEFAULT, {"context_window": 0, "max_output": 0}, 16384) == deepseek
    small = compaction.plan(DEFAULT, {"context_window": 128_000, "max_output": 0}, 16384)
    assert 128_000 - 16384 - 65536 == 46080
    assert small.trigger == 64000 == small.window // 2
    test = CompactionSettings(window=4096, keep_ratio=0.16, reserve=0, summary_max_tokens=512)
    assert compaction.plan(test, {"context_window": 0, "max_output": 0}, 256) == compaction.Plan(4096, 3276, 614)


def test_estimate() -> None:
    messages = conversation(2, native=True)
    total = compaction.total_chars(messages)
    arguments = len('{"code":"print(1)"}') + len('{"code":"print(2)"}')
    assert total == len("SYSTEM") + len("FIRST") + 600 + arguments
    usage = {"input_tokens": 1000, "output_tokens": 50}
    assert compaction.estimate(messages, usage, 10) == 1050 + 4
    assert compaction.estimate(messages, usage, 0) == 1050
    assert compaction.estimate(messages, None, 10) == math.ceil(total / 3)
    assert compaction.estimate(messages, {"input_tokens": 0, "output_tokens": 50}, 10) == math.ceil(total / 3)


def test_head_and_tail() -> None:
    messages = conversation(10, chars=300)
    stub = Stub()
    result = run(compaction.compact(messages, keep_tokens=250, summarize=stub))
    assert result.messages[0] is messages[0] and result.messages[1] is messages[1]
    assert result.messages[:2] == [{"role": "system", "content": "SYSTEM"}, {"role": "user", "content": "FIRST"}]
    note, tail = result.messages[2], result.messages[3:]
    assert note == {"role": "user", "content": COMPACTED.format(turns=result.turns, summary="S")}
    assert tail[0]["role"] == "assistant"
    assert tail == messages[len(messages) - len(tail):]
    assert math.ceil(compaction.total_chars(tail) / 3) <= 250
    assert result.kept == len(tail) == 4 and result.dropped == 16 and result.turns == 8
    assert stub.requests == [messages + [{"role": "user", "content": COMPACT_REQUEST.format(max_words=1638)}]]

    # the newest turn alone is larger than keep_tokens: the tail is exactly that turn
    result = run(compaction.compact(conversation(4, chars=3000), keep_tokens=100, summarize=Stub()))
    assert result.kept == 2 and result.messages[3]["role"] == "assistant" and result.turns == 3

    # native: a tool call stays with its tool result
    messages = conversation(6, chars=300, native=True)
    result = run(compaction.compact(messages, keep_tokens=230, summarize=Stub()))
    tail = result.messages[3:]
    assert tail[0]["role"] == "assistant" and "tool_call" in tail[0]
    for i, message in enumerate(tail):
        if message["role"] == "tool":
            assert tail[i - 1]["tool_call"]["id"] == message["tool_call_id"]


def test_second_compaction_drops_the_first_summary() -> None:
    first = run(compaction.compact(conversation(6), keep_tokens=250, summarize=Stub("ONE")))
    grown = first.messages + conversation(6)[2:]
    second = run(compaction.compact(grown, keep_tokens=250, summarize=Stub("TWO")))
    assert second.messages[2]["content"] == COMPACTED.format(turns=second.turns, summary="TWO")
    assert "ONE" not in "".join(m["content"] for m in second.messages)
    assert second.dropped == 1 + 2 * second.turns  # the old summary message and the dropped turns


def test_texts_pinned() -> None:
    assert COMPACT_REQUEST.format(max_words=1638) == (
        "Stop work on the task for this one reply. The conversation is about to be shortened: every turn after the "
        "first message will be replaced by a summary you write now, and only the newest turns will stay as they are. "
        "The REPL keeps running, so every variable you have made stays as it is.\n\n"
        "Write the summary as plain text. Do not write code and do not call a tool. Include:\n"
        "- what the task is, and what is already done;\n"
        "- what you found, with the exact numbers, names and file paths that matter;\n"
        "- every REPL variable that holds state you still need, and what it holds;\n"
        "- what you were about to do next.\n\n"
        "Keep it under 1,638 words."
    )
    assert COMPACTED.format(turns=3, summary="S") == (
        "[3 earlier turns were compacted to save context. Your summary of them follows.]\n\n"
        "S\n\n"
        "[The newest turns follow as they were. The REPL still holds every variable.]"
    )


def test_nothing_to_drop() -> None:
    stub = Stub()
    assert run(compaction.compact(conversation(1, chars=30000), keep_tokens=10, summarize=stub)) is None
    assert run(compaction.compact(conversation(0), keep_tokens=10, summarize=stub)) is None
    assert stub.requests == []


def test_fallback_summary() -> None:
    long = "x" * 500
    dropped = [
        assistant("Look first.\n```python\n\n  print(len(context))\nprint(2)\n```"),
        {"role": "user", "content": "out"},
        assistant("", f"\n{long}\n", "call_2"),
        {"role": "tool", "tool_call_id": "call_2", "content": "out"},
        assistant("\n  I am not sure yet.\nMore."),
        {"role": "user", "content": "out"},
    ]
    assert compaction.fallback_summary(dropped) == "\n".join([
        "Turn 1: print(len(context))", f"Turn 2: {'x' * 200}", "Turn 3: I am not sure yet."])
    # an empty summary text falls back to it
    result = run(compaction.compact(conversation(3), keep_tokens=10, summarize=Stub("  ")))
    assert result.summary == "Turn 1: print(1)\nTurn 2: print(2)"
