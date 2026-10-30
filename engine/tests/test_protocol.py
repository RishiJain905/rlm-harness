"""KV cache: none

protocol/examples.json against architecture §3 to §6.2 (D-02). The required names and the
field tables live here, apart from the file, so a wrong example can't bless itself.
app/test/protocol.test.ts holds the same lists; change both with any wire change.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from rlm_engine import PROTOCOL_VERSION, link

EXAMPLES_PATH = Path(__file__).resolve().parents[2] / "protocol" / "examples.json"
EXAMPLES: list[dict] = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))["examples"]

ERROR_CODES = {
    "PARSE_ERROR": -32700,
    "INVALID_REQUEST": -32600,
    "METHOD_NOT_FOUND": -32601,
    "INVALID_PARAMS": -32602,
    "INTERNAL_ERROR": -32603,
    "MODEL_ERROR": -32001,
    "UNKNOWN_RUN": -32010,
    "UNKNOWN_PROFILE": -32011,
    "BAD_INPUT": -32012,
    "CANCELLED": -32800,
}

REQUIRED = [
    "engine.info:request",
    "engine.info:result",
    "run.cancel:request",
    "run.cancel:result",
    "run.vars:request",
    "run.vars:result",
    "debug.roundtrip:request",
    "debug.roundtrip:result",
    "run.start:request:read",
    "run.start:request:repo",
    "run.start:result",
    "model.complete:request:root",
    "model.complete:request:sub",
    "model.complete:result",
    "approval.request:request",
    "approval.request:result",
    "run.start:error:UNKNOWN_PROFILE",
    "run.start:error:BAD_INPUT",
    "run.cancel:error:UNKNOWN_RUN",
    "model.complete:error:MODEL_ERROR",
    "rpc:error:PARSE_ERROR",
    "rpc:error:INVALID_REQUEST",
    "rpc:error:METHOD_NOT_FOUND",
    "rpc:error:INVALID_PARAMS",
    "rpc:error:INTERNAL_ERROR",
    "rpc:error:CANCELLED",
    "run.started:notification",
    "run.reply:notification",
    "run.cell:notification",
    "run.subcall:notification",
    "run.permission:notification",
    "run.budget:notification",
    "run.finished:notification",
    "model.cancel:notification",
]

# Who sends each §5 method.
METHODS = {
    "engine.info": "app->engine",
    "run.start": "app->engine",
    "run.cancel": "app->engine",
    "run.vars": "app->engine",
    "debug.roundtrip": "app->engine",
    "model.complete": "engine->app",
    "approval.request": "engine->app",
    "run.started": "engine->app",
    "run.reply": "engine->app",
    "run.cell": "engine->app",
    "run.subcall": "engine->app",
    "run.permission": "engine->app",
    "run.budget": "engine->app",
    "run.finished": "engine->app",
    "model.cancel": "engine->app",
}

# §6.2, key for key.
PYTHON_TOOL = {
    "name": "python",
    "description": "Run one cell of Python in the persistent REPL. Variables persist between calls. The result is what the cell printed, followed by your remaining turns and sub-calls.",
    "parameters": {
        "type": "object",
        "properties": {"code": {"type": "string", "description": "The Python code to run."}},
        "required": ["code"],
        "additionalProperties": False,
    },
}

# -- a small type language for §4 and §5 --

STR, INT, NUM, BOOL, OBJECT = "str", "int", "num", "bool", "object"


def obj(required: dict, optional: dict | None = None) -> tuple:
    return ("obj", required, optional or {})


def nullable(spec: Any) -> tuple:
    return ("nullable", spec)


def list_of(spec: Any) -> tuple:
    return ("list", spec)


def enum(*values: str) -> tuple:
    return ("enum", values)


MESSAGE = ("message",)
THINKING = enum("off", "low", "medium", "high")
FINISH_REASON = enum("stop", "length", "tool_call", "content_filter", "other")
PERMISSION_MODE = enum("default", "accept-edits", "bypass")
CALL_FORMAT = enum("fenced", "native")
APPROVAL_KIND = enum("write", "shell", "network")
MODEL_REF = obj({"provider": STR, "model": STR, "thinking": nullable(THINKING)})
TOOL_CALL = obj({"id": STR, "name": STR, "arguments": OBJECT})
TOOL_DEF = obj({"name": STR, "description": STR, "parameters": OBJECT})
USAGE = obj(
    {
        "input_tokens": INT,
        "output_tokens": INT,
        "cache_read_tokens": INT,
        "cache_write_tokens": INT,
        "reasoning_tokens": INT,
        "cost_usd": NUM,
    }
)
MODEL_ERROR_DATA = obj(
    {
        "kind": enum(
            "auth", "no_key", "bad_request", "rate_limit", "server", "timeout",
            "network", "context_window", "unknown_model", "cancelled", "other",
        ),
        "provider": STR,
        "model": STR,
        "status": nullable(INT),
        "message": STR,
    }
)
ORIGIN = obj({"turn": INT, "line": nullable(INT)})
BATCH = obj({"id": STR, "index": INT, "size": INT})
MESSAGES = {
    "system": obj({"role": enum("system"), "content": STR}),
    "user": obj({"role": enum("user"), "content": STR}),
    "assistant": obj({"role": enum("assistant"), "content": STR}, {"tool_call": TOOL_CALL}),
    "tool": obj({"role": enum("tool"), "tool_call_id": STR, "content": STR}),
}

# params (requests, notifications) or result, per "<method>:<kind>".
FIELDS = {
    "engine.info:request": obj({}),
    "engine.info:result": obj(
        {
            "version": STR,
            "protocol": INT,
            "python": STR,
            "contract": nullable(STR),
            "contract_hash": nullable(STR),
            "training_hash": nullable(STR),
            "profiles": list_of(obj({"name": STR, "source": enum("builtin", "user"), "prompt_hash": STR, "profile_hash": STR})),
        }
    ),
    "run.start:request": obj(
        {
            "mode": enum("read", "repo"),
            "profile": STR,
            "root": MODEL_REF,
            "sub": MODEL_REF,
            "permission_mode": PERMISSION_MODE,
            "call_format": CALL_FORMAT,
        },
        {
            "question": STR,
            "inputs": list_of(STR),
            "task": STR,
            "repo_path": STR,
            "test_hint": STR,
            "language": STR,
            "n_files": INT,
            "context": STR,
            "interactive": BOOL,
            "tag": STR,
            "batch": STR,
            "log_dir": STR,
        },
    ),
    "run.start:result": obj({"run_id": STR, "log_path": STR}),
    "run.cancel:request": obj({"run_id": STR}),
    "run.cancel:result": obj({}),
    "run.vars:request": obj({"run_id": STR}),
    "run.vars:result": obj({"vars": list_of(obj({"name": STR, "type": STR, "len": nullable(INT), "chars": INT}))}),
    "debug.roundtrip:request": obj({"count": INT}),
    "debug.roundtrip:result": obj({"texts": list_of(STR)}),
    "model.complete:request": obj(
        {
            "run_id": STR,
            "role": enum("root", "sub"),
            "model": MODEL_REF,
            "messages": list_of(MESSAGE),
            "tools": list_of(TOOL_DEF),
            "max_tokens": INT,
            "temperature": NUM,
            "thinking": THINKING,
            "turn": INT,
        },
        {"subcall_id": INT, "origin": ORIGIN, "batch": BATCH},
    ),
    "model.complete:result": obj(
        {
            "text": STR,
            "tool_call": nullable(TOOL_CALL),
            "reasoning": nullable(STR),
            "usage": USAGE,
            "finish_reason": FINISH_REASON,
            "served_model": STR,
            "seconds": NUM,
        }
    ),
    "approval.request:request": obj(
        {"run_id": STR, "kind": APPROVAL_KIND, "detail": STR, "turn": INT, "inside_workspace": BOOL}
    ),
    "approval.request:result": obj({"allow": BOOL, "remember_for_run": BOOL}),
    "run.started:notification": obj(
        {
            "run_id": STR,
            "tag": nullable(STR),
            "mode": enum("read", "repo"),
            "profile": STR,
            "prompt_hash": STR,
            "profile_hash": STR,
            "contract_hash": STR,
            "call_format": CALL_FORMAT,
            "root": MODEL_REF,
            "sub": MODEL_REF,
            "permission_mode": PERMISSION_MODE,
            "workspace": STR,
            "input": obj({"chars": INT, "lines": INT, "sha256": STR, "files": list_of(STR)}),
            "limits": obj(
                {
                    "max_turns": INT,
                    "max_subcalls": INT,
                    "root_max_tokens": INT,
                    "output_max_chars": INT,
                    "cell_timeout_s": NUM,
                    "subcall_max_chars": INT,
                    "subcall_max_tokens": INT,
                }
            ),
            "log_path": STR,
        }
    ),
    "run.reply:notification": obj(
        {
            "run_id": STR,
            "turn": INT,
            "text": STR,
            "tool_call": nullable(TOOL_CALL),
            "reasoning": nullable(STR),
            "finish_reason": FINISH_REASON,
            "usage": USAGE,
            "seconds": NUM,
        }
    ),
    "run.cell:notification": obj(
        {
            "run_id": STR,
            "turn": INT,
            "code": nullable(STR),
            "output": STR,
            "error": nullable(STR),
            "observation": nullable(STR),
            "seconds": NUM,
            "restarted": BOOL,
            "crash": nullable(STR),
            "repo_changed": nullable(BOOL),
        }
    ),
    "run.subcall:notification": obj(
        {
            "run_id": STR,
            "subcall_id": nullable(INT),
            "origin": ORIGIN,
            "batch": BATCH,
            "prompt_chars": INT,
            "status": enum("sent", "done", "error", "rejected"),
            "error": nullable(STR),
            "seconds": nullable(NUM),
        }
    ),
    "run.permission:notification": obj(
        {"run_id": STR, "turn": INT, "kind": APPROVAL_KIND, "detail": STR, "allowed": BOOL, "asked": BOOL, "remembered": BOOL}
    ),
    "run.budget:notification": obj({"run_id": STR, "turns_left": INT, "subcalls_left": INT}),
    "run.finished:notification": obj(
        {
            "run_id": STR,
            "tag": nullable(STR),
            "answer": nullable(STR),
            "submitted": BOOL,
            "answer_valid": BOOL,
            "turns": INT,
            "subcalls": INT,
            "usage": obj({"root": USAGE, "sub": USAGE}),
            "cost_usd": NUM,
            "infra_error": nullable(STR),
            "infra_kind": nullable(STR),
            "wall_s": NUM,
            "log_path": STR,
        }
    ),
    "model.cancel:notification": obj({"run_id": STR}),
}

ERROR_OBJECT = obj({"code": INT, "message": STR}, {"data": OBJECT})


def check(value: Any, spec: Any, path: str) -> None:
    """Assert `value` matches `spec`; `path` names the field in the failure message."""
    if spec == STR:
        assert isinstance(value, str), f"{path}: not a string: {value!r}"
    elif spec == INT:
        assert isinstance(value, int) and not isinstance(value, bool), f"{path}: not an integer: {value!r}"
    elif spec == NUM:
        assert isinstance(value, (int, float)) and not isinstance(value, bool), f"{path}: not a number: {value!r}"
    elif spec == BOOL:
        assert isinstance(value, bool), f"{path}: not a bool: {value!r}"
    elif spec == OBJECT:
        assert isinstance(value, dict), f"{path}: not an object: {value!r}"
    elif spec == MESSAGE:
        assert isinstance(value, dict) and value.get("role") in MESSAGES, f"{path}: not a Message: {value!r}"
        check(value, MESSAGES[value["role"]], path)
    elif spec[0] == "nullable":
        if value is not None:
            check(value, spec[1], path)
    elif spec[0] == "list":
        assert isinstance(value, list), f"{path}: not a list: {value!r}"
        for i, item in enumerate(value):
            check(item, spec[1], f"{path}[{i}]")
    elif spec[0] == "enum":
        assert value in spec[1], f"{path}: {value!r} not in {spec[1]}"
    elif spec[0] == "obj":
        _, required, optional = spec
        assert isinstance(value, dict), f"{path}: not an object: {value!r}"
        missing = set(required) - set(value)
        extra = set(value) - set(required) - set(optional)
        assert not missing, f"{path}: missing {sorted(missing)}"
        assert not extra, f"{path}: unexpected {sorted(extra)}"
        for key, item in value.items():
            check(item, required.get(key, optional.get(key)), f"{path}.{key}")
    else:
        raise AssertionError(f"bad spec {spec!r}")


def by_name() -> dict[str, dict]:
    return {ex["name"]: ex for ex in EXAMPLES}


def method_of(ex: dict) -> str:
    return ex["name"].split(":")[0]


def test_file_shape() -> None:
    data = json.loads(EXAMPLES_PATH.read_text(encoding="utf-8"))
    assert data["protocol"] == 1 == PROTOCOL_VERSION
    assert set(data) == {"protocol", "examples"}
    names = [ex["name"] for ex in EXAMPLES]
    assert len(names) == len(set(names)), "duplicate names"
    for ex in EXAMPLES:
        assert set(ex) == {"name", "direction", "kind", "message"}, ex["name"]
        parts = ex["name"].split(":")
        assert len(parts) in (2, 3), ex["name"]
        assert parts[1] == ex["kind"], ex["name"]
        assert ex["kind"] in ("request", "result", "error", "notification"), ex["name"]
        assert ex["direction"] in ("app->engine", "engine->app"), ex["name"]


def test_coverage() -> None:
    names = by_name()
    for name in REQUIRED:
        assert name in names, f"missing example {name}"
    for ex in EXAMPLES:
        method = method_of(ex)
        assert method in METHODS or method == "rpc", f"{ex['name']}: method outside §5"
        if ex["kind"] in ("request", "notification"):
            assert ex["message"]["method"] == method, ex["name"]
            assert ex["direction"] == METHODS[method], ex["name"]
        if method == "rpc":
            assert ex["kind"] == "error", ex["name"]
    errors = {ex["name"].split(":")[2]: ex for ex in EXAMPLES if ex["kind"] == "error"}
    assert set(errors) <= set(ERROR_CODES), sorted(set(errors) - set(ERROR_CODES))
    for code_name, code in ERROR_CODES.items():
        assert code_name in errors, f"no error example for {code_name}"
        assert errors[code_name]["message"]["error"]["code"] == code, code_name


def test_classify() -> None:
    for ex in EXAMPLES:
        msg, kind, direction = ex["message"], ex["kind"], ex["direction"]
        assert link.classify(msg) == kind, ex["name"]
        assert msg["jsonrpc"] == "2.0", ex["name"]
        if kind == "notification":
            assert "id" not in msg, ex["name"]
            continue
        mid = msg["id"]
        app_id = isinstance(mid, int) and not isinstance(mid, bool) and mid >= 1
        engine_id = isinstance(mid, str) and re.fullmatch(r"e[1-9][0-9]*", mid) is not None
        if kind == "request":
            assert app_id if direction == "app->engine" else engine_id, ex["name"]
        else:  # an answer carries the id of the other side's request, or null
            assert mid is None or (engine_id if direction == "app->engine" else app_id), ex["name"]


def test_pairing() -> None:
    requests = [ex for ex in EXAMPLES if ex["kind"] == "request"]
    for ex in EXAMPLES:
        if ex["kind"] not in ("result", "error") or method_of(ex) == "rpc":
            continue
        match = [
            r for r in requests
            if method_of(r) == method_of(ex) and r["message"]["id"] == ex["message"]["id"] and r["direction"] != ex["direction"]
        ]
        assert match, f"{ex['name']}: no {method_of(ex)} request with id {ex['message']['id']!r}"


def test_round_trip() -> None:
    for ex in EXAMPLES:
        line = json.dumps(ex["message"], ensure_ascii=False)
        assert "\n" not in line, ex["name"]
        assert json.loads(line) == ex["message"], ex["name"]


def test_fields() -> None:
    for ex in EXAMPLES:
        msg, kind, name = ex["message"], ex["kind"], ex["name"]
        if kind == "error":
            check(msg["error"], ERROR_OBJECT, f"{name}.error")
            if name.endswith(":MODEL_ERROR"):
                check(msg["error"]["data"], MODEL_ERROR_DATA, f"{name}.error.data")
            continue
        key = f"{method_of(ex)}:{kind}"
        assert key in FIELDS, f"{name}: no field table for {key}"
        body = msg["result"] if kind == "result" else msg["params"]
        check(body, FIELDS[key], name)

    names = by_name()
    read = names["run.start:request:read"]["message"]["params"]
    repo = names["run.start:request:repo"]["message"]["params"]
    assert read["mode"] == "read" and read["question"] and len(read["inputs"]) >= 1
    assert repo["mode"] == "repo" and repo["task"] and repo["repo_path"]
    root = names["model.complete:request:root"]["message"]["params"]
    sub = names["model.complete:request:sub"]["message"]["params"]
    assert root["role"] == "root" and not {"subcall_id", "origin", "batch"} & set(root)
    assert sorted(m["role"] for m in root["messages"]) == ["assistant", "system", "tool", "user"]
    assert sub["role"] == "sub" and {"subcall_id", "origin", "batch"} <= set(sub)
    assert sub["tools"] == [] and [m["role"] for m in sub["messages"]] == ["user"]


def test_python_tool() -> None:
    tools = by_name()["model.complete:request:root"]["message"]["params"]["tools"]
    assert tools[0] == PYTHON_TOOL
    assert list(tools[0]) == list(PYTHON_TOOL)


def test_constants() -> None:
    for name, code in ERROR_CODES.items():
        assert getattr(link, name) == code, name
    assert link.MAX_LINE_BYTES == 32 * 1024 * 1024
