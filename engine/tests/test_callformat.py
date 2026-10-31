"""KV cache: none

callformat.py: the python tool byte for byte, the same code from all three reply shapes (fenced, a
`<function=python>` block in text, a native tool call), and where the observation goes (architecture §6.2, D-31).
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from rlm_engine import callformat as cf
from rlm_engine import contract

CODE = "print(len(context))\n"
FENCED_TEXT = "Look first.\n```python\nprint(len(context))\n```"
FUNCTION_TEXT = "<tool_call>\n<function=python>\nprint(len(context))\n</function>\n</tool_call>"
PYTHON_TOOL_JSON = (
    '{"name":"python","description":"Run one cell of Python in the persistent REPL. Variables persist between calls. '
    'The result is what the cell printed, followed by your remaining turns and sub-calls.","parameters":{"type":'
    '"object","properties":{"code":{"type":"string","description":"The Python code to run."}},"required":["code"],'
    '"additionalProperties":false}}'
)
EXAMPLES_PATH = Path(__file__).resolve().parents[2] / "protocol" / "examples.json"


def reply(text: str | None = "", tool_call: dict | None = None, **extra) -> dict:
    """A model.complete result, with only the fields callformat reads plus any extras."""
    return {"text": text, "tool_call": tool_call, "reasoning": None, **extra}


def call(code=CODE, name: str = "python", call_id: str = "call_1", arguments=None) -> dict:
    return {"id": call_id, "name": name, "arguments": {"code": code} if arguments is None else arguments}


def test_python_tool_byte_for_byte() -> None:
    compact = json.dumps(cf.PYTHON_TOOL, separators=(",", ":"))
    assert compact == PYTHON_TOOL_JSON
    assert hashlib.sha256(compact.encode()).hexdigest() == "3d3c2513de47f59b70b24fae749af49f15543e61aa2f80d01f048286e09a84ab"
    # the wire example of a native root call carries the same tool
    examples = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]
    root = next(e for e in examples if e["name"] == "model.complete:request:root")
    assert root["message"]["params"]["tools"] == cf.tools_for(cf.NATIVE)


def test_tools_for() -> None:
    assert cf.tools_for(cf.FENCED) == []
    tools = cf.tools_for(cf.NATIVE)
    assert tools == [cf.PYTHON_TOOL] and tools[0] is not cf.PYTHON_TOOL
    tools[0]["parameters"]["required"].append("x")
    assert cf.PYTHON_TOOL["parameters"]["required"] == ["code"]
    with pytest.raises(ValueError, match="unknown call format 'x'"):
        cf.tools_for("x")


def test_three_formats_same_code() -> None:
    assert cf.code_from_reply(cf.FENCED, reply(FENCED_TEXT)) == CODE
    assert cf.code_from_reply(cf.FENCED, reply(FUNCTION_TEXT)) == CODE
    assert cf.code_from_reply(cf.NATIVE, reply("", call())) == CODE


def test_function_tag_in_native_text() -> None:
    assert cf.code_from_reply(cf.NATIVE, reply(FUNCTION_TEXT, None)) == CODE
    assert cf.code_from_reply(cf.NATIVE, reply(FENCED_TEXT, None)) == CODE


def test_native_call_wins_over_text() -> None:
    assert cf.code_from_reply(cf.NATIVE, reply("```python\nother = 1\n```", call())) == CODE
    assert cf.code_from_reply(cf.NATIVE, reply(FENCED_TEXT, call(code=""))) == ""


def test_native_falls_back() -> None:
    unusable = [
        call(name="bash"),
        call(arguments={"cmd": "ls"}),
        call(code=5),
        call(arguments=json.dumps({"code": CODE})),
    ]
    for bad in unusable:
        assert cf.code_from_reply(cf.NATIVE, reply(FENCED_TEXT, bad)) == CODE, bad
        assert cf.code_from_reply(cf.NATIVE, reply("No code here.", bad)) is None, bad
        assert cf.code_from_reply(cf.NATIVE, reply(None, bad)) is None, bad


def test_fenced_ignores_tool_call() -> None:
    result = reply("```python\nfrom_text = 1\n```", call())
    assert cf.code_from_reply(cf.FENCED, result) == "from_text = 1\n"
    assert cf.code_from_reply(cf.FENCED, reply("no code", call())) is None
    assert list(cf.assistant_message(cf.FENCED, result)) == ["role", "content"]


def test_observation_message() -> None:
    with_call = cf.assistant_message(cf.NATIVE, reply("", call(call_id="call_1")))
    assert cf.observation_message(with_call, "obs") == {"role": "tool", "tool_call_id": "call_1", "content": "obs"}
    no_code = cf.assistant_message(cf.NATIVE, reply("thinking aloud", call(name="bash", call_id="call_1")))
    assert cf.observation_message(no_code, "obs") == {"role": "tool", "tool_call_id": "call_1", "content": "obs"}
    plain = cf.assistant_message(cf.NATIVE, reply(FENCED_TEXT))
    assert cf.observation_message(plain, "obs") == {"role": "user", "content": "obs"}


def test_assistant_message() -> None:
    fenced = cf.assistant_message(cf.FENCED, reply(FENCED_TEXT))
    assert fenced == {"role": "assistant", "content": FENCED_TEXT}
    result = reply("  Let me look.\r\n", call(), reasoning="SECRET-THOUGHT", served_model="m")
    native = cf.assistant_message(cf.NATIVE, result)
    assert list(native) == ["role", "content", "tool_call"]
    assert list(native["tool_call"]) == ["id", "name", "arguments"]
    assert native["content"] == result["text"]  # byte for byte, never cleaned (D-33)
    assert "SECRET-THOUGHT" not in json.dumps(native)
    assert cf.assistant_message(cf.NATIVE, reply(None))["content"] == ""
    native["tool_call"]["arguments"]["code"] = "changed"
    assert result["tool_call"]["arguments"]["code"] == CODE
    assert native["tool_call"] is not result["tool_call"]


def test_conversation_shape() -> None:
    def roles(fmt: str, replies: list[dict]) -> list[str]:
        messages = [{"role": "system", "content": contract.SYSTEM_PROMPT_V4}, {"role": "user", "content": "first"}]
        for turn, result in enumerate(replies):
            assistant = cf.assistant_message(fmt, result)
            messages.append(assistant)
            if turn < len(replies) - 1:
                assert cf.code_from_reply(fmt, result) is not None
                text = contract.observation("48210\n", 6, None, 19, 80, 8000)
                messages.append(cf.observation_message(assistant, text))
        return [m["role"] for m in messages]

    fenced = [reply(FENCED_TEXT), reply("```python\nsubmit(1)\n```")]
    native = [reply("", call()), reply("", call(code="submit(1)", call_id="call_2"))]
    assert roles(cf.FENCED, fenced) == ["system", "user", "assistant", "user", "assistant"]
    assert roles(cf.NATIVE, native) == ["system", "user", "assistant", "tool", "assistant"]
