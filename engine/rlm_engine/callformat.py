"""KV cache: none; it only picks which fields of a reply become code and message, and never edits text.

The two call formats (6b, S-30). `fenced`: the code is the first ```python block in the reply text, and the
observation goes back as a user message, exactly as in training; the LoRA and local models use it. `native`: the
code is the `code` argument of a `python` tool call, and the observation goes back as that call's tool result; API
models use it. A native reply without a usable `python` call falls back to the text (D-31). The app resolves `auto`
before `run.start`, so only these two reach the engine.
"""

from __future__ import annotations

import copy

from . import contract

FENCED, NATIVE = "fenced", "native"

# architecture.md §6.2, byte for byte (test_callformat pins its compact JSON and sha256)
PYTHON_TOOL: dict = {
    "name": "python",
    "description": "Run one cell of Python in the persistent REPL. Variables persist between calls. The result is what "
    "the cell printed, followed by your remaining turns and sub-calls.",
    "parameters": {
        "type": "object",
        "properties": {"code": {"type": "string", "description": "The Python code to run."}},
        "required": ["code"],
        "additionalProperties": False,
    },
}


def _check(fmt: str) -> None:
    if fmt not in (FENCED, NATIVE):
        raise ValueError(f"unknown call format {fmt!r}")


def tools_for(fmt: str) -> list[dict]:
    """A root call's `tools`: none in fenced format, the `python` tool (a fresh copy) in native."""
    _check(fmt)
    return [copy.deepcopy(PYTHON_TOOL)] if fmt == NATIVE else []


def code_from_reply(fmt: str, result: dict) -> str | None:
    """The cell to run from a model.complete result, or None when the reply has no code."""
    _check(fmt)
    call = result.get("tool_call")
    if fmt == NATIVE and isinstance(call, dict) and call.get("name") == "python":
        arguments = call.get("arguments")
        # arguments given as a JSON string count as unusable: the gateway parses them
        if isinstance(arguments, dict) and isinstance(arguments.get("code"), str):
            return arguments["code"]
    return contract.extract_code(result.get("text"), tool_calls=True)


def assistant_message(fmt: str, result: dict) -> dict:
    """The reply as a Message. `content` is the text as received, never cleaned and never the reasoning: the
    gateway keys its reasoning replay on it (D-33). A native reply keeps a copy of its tool call, whatever its name."""
    _check(fmt)
    message = {"role": "assistant", "content": result.get("text") or ""}
    call = result.get("tool_call")
    if fmt == NATIVE and isinstance(call, dict):
        message["tool_call"] = {key: copy.deepcopy(call.get(key)) for key in ("id", "name", "arguments")}
    return message


def observation_message(assistant: dict, text: str) -> dict:
    """The observation as the next Message: the tool result when the reply had a tool call (even one without usable
    code), otherwise a user message (always, in fenced format)."""
    call = assistant.get("tool_call")
    if call:
        return {"role": "tool", "tool_call_id": call["id"], "content": text}
    return {"role": "user", "content": text}
