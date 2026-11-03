"""KV cache: a file's text is a sub-call's cached prefix, byte for byte the same each time it is asked about; a schema
adds its instruction after the prompt, so the prefix stays the same.

Delegation helpers for the `default` profile (D-157 to D-160). The worker installs them only when its `init` sets
`agent_api`, which `training-v4` never does, so the LoRA's REPL stays training's own.

- `schema=` on `llm` and `llm_batch` (D-158): the reply is parsed as JSON and checked against a small schema; a reply
  that fails is asked again once, with the error.
- `ask_files(files, question)` (D-157): one sub-call per file (or per part of a large file), the file's text sent as
  the cached prefix, so the root never reads or pastes the files itself.
- `llm_async`, `llm_batch_async`, `rlm_async` and `gather` (D-159): the same calls on a thread pool, returning
  futures, so a cell can start work and keep going.
- `rlm(task, ...)` (D-160): a child run with a REPL of its own, run by the engine; returns what the child submits.
  The engine enforces the profile's [rlm] limits (how many, how deep, how many at once).

Worker-side: imports only the standard library, never `rlm_engine`.
"""

from __future__ import annotations

import concurrent.futures
import fnmatch
import json
import os
import re
import threading
import types
import typing

NAMES = ("ask_files", "llm_async", "llm_batch_async", "rlm", "rlm_async", "gather")
SEPARATOR = "\n\n"  # cacheapi.SEPARATOR: between a prefix and its prompt
RLM_TOOLS = ("read", "edit", "none")
ASYNC_WORKERS = 32
BINARY_SNIFF_BYTES = 8192
PART_MARGIN = 600  # room a part leaves for its header and the schema instruction
REPLY_SHOWN_ON_RETRY = 2000
JSON_INSTRUCTION = "\n\nReply with only a JSON value that matches this JSON Schema, and nothing else:\n{schema}"
JSON_RETRY = ("\n\nYour previous reply was:\n{reply}\n\nIt was not valid: {error}. Reply again with only a JSON value "
              "that matches this JSON Schema, and nothing else:\n{schema}")
JSON_RETRY_EMPTY = ("\n\nYour previous attempt ran out of room before it answered. Do not think at length: reply now "
                    "with only a JSON value that matches this JSON Schema, and nothing else:\n{schema}")
THINKING = ("off", "minimal", "low", "medium", "high", "xhigh", "max")

_SCALARS = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null", list: "array",
            dict: "object"}
_JSON_TYPES = ("string", "integer", "number", "boolean", "null", "array", "object")
_SCHEMA_KEYS = ("type", "properties", "required", "items", "enum", "anyOf", "description", "additionalProperties")


# ----------------------------------------------------------------------------- schemas


def compile_schema(schema) -> dict:
    """A JSON Schema dict for `schema`: a Python shorthand (str, int, float, bool, None, list, dict, list[str],
    `X | None`, {"key": type, ...} with every key required, [type] for a list of it, ["a", "b"] for one of those
    strings) or a JSON Schema dict that uses only type, properties, required, items, enum and anyOf."""
    if isinstance(schema, dict) and _is_json_schema(schema):
        _check_json_schema(schema)
        return schema
    if schema is None:
        return {"type": "null"}
    if isinstance(schema, type) and schema in _SCALARS:
        return {"type": _SCALARS[schema]}
    if isinstance(schema, dict):
        return {"type": "object", "properties": {str(k): compile_schema(v) for k, v in schema.items()},
                "required": [str(k) for k in schema]}
    if isinstance(schema, list):
        if schema and all(isinstance(v, str) for v in schema):
            return {"type": "string", "enum": list(schema)}
        if len(schema) == 1:
            return {"type": "array", "items": compile_schema(schema[0])}
        raise TypeError("a list in a schema is [type] (a list of it) or a list of allowed strings")
    origin = typing.get_origin(schema)
    if origin is list:
        args = typing.get_args(schema)
        return {"type": "array", **({"items": compile_schema(args[0])} if args else {})}
    if origin is dict:
        return {"type": "object"}
    if origin in (typing.Union, types.UnionType):
        return {"anyOf": [compile_schema(a) for a in typing.get_args(schema)]}
    if origin is typing.Literal:
        return {"enum": list(typing.get_args(schema))}
    raise TypeError(f"cannot use {schema!r} as a schema; use str, int, float, bool, list, dict, list[str], "
                    "{\"key\": type}, [\"a\", \"b\"] or a JSON Schema dict")


def _is_json_schema(schema: dict) -> bool:
    """A JSON Schema names its type with a string ({"type": "string"}); the shorthand {"type": str} names a Python type."""
    kind = schema.get("type")
    if isinstance(kind, str) or (isinstance(kind, list) and kind and all(isinstance(k, str) for k in kind)):
        return True
    return ("enum" in schema or "anyOf" in schema) and set(schema) <= set(_SCHEMA_KEYS)


def _check_json_schema(schema) -> None:
    if not isinstance(schema, dict):
        raise TypeError(f"a JSON Schema is a dict, not {type(schema).__name__}")
    unknown = set(schema) - set(_SCHEMA_KEYS)
    if unknown:
        raise TypeError(f"schema keys {sorted(unknown)} are not supported; use {', '.join(_SCHEMA_KEYS[:6])}")
    kinds = schema.get("type")
    for kind in kinds if isinstance(kinds, list) else [kinds] if kinds is not None else []:
        if kind not in _JSON_TYPES:
            raise TypeError(f"unknown JSON type {kind!r}")
    for sub in (schema.get("properties") or {}).values():
        _check_json_schema(sub)
    if isinstance(schema.get("items"), dict):
        _check_json_schema(schema["items"])
    for sub in schema.get("anyOf") or []:
        _check_json_schema(sub)


def validate(value, schema: dict, path: str = "$"):
    """`(value, None)` when `value` matches, with whole floats made ints where an integer is wanted; else
    `(None, error)`."""
    if "anyOf" in schema:
        errors = []
        for sub in schema["anyOf"]:
            out, error = validate(value, sub, path)
            if error is None:  # one form matched; the schema's other keys must hold too
                return validate(out, {k: v for k, v in schema.items() if k != "anyOf"}, path)
            errors.append(error)
        return None, f"{path} matches none of the allowed forms ({'; '.join(errors[:3])})"
    if "enum" in schema and value not in schema["enum"]:
        return None, f"{path} is {_short(value)}, not one of {schema['enum']}"
    kinds = schema.get("type")
    if kinds is None:
        return value, None
    for kind in kinds if isinstance(kinds, list) else [kinds]:
        out, ok = _as_type(value, kind)
        if ok:
            break
    else:
        return None, f"{path} is {_short(value)}, not {kinds if isinstance(kinds, str) else ' or '.join(kinds)}"
    if isinstance(out, list) and isinstance(schema.get("items"), dict):
        items = []
        for i, item in enumerate(out):
            item, error = validate(item, schema["items"], f"{path}[{i}]")
            if error is not None:
                return None, error
            items.append(item)
        out = items
    if isinstance(out, dict):
        missing = [k for k in schema.get("required", []) if k not in out]
        if missing:
            return None, f"{path} is missing {', '.join(missing)}"
        out = dict(out)
        for key, sub in (schema.get("properties") or {}).items():
            if key in out:
                out[key], error = validate(out[key], sub, f"{path}.{key}")
                if error is not None:
                    return None, error
    return out, None


def _as_type(value, kind: str):
    if kind == "string":
        return value, isinstance(value, str)
    if kind == "integer":
        if isinstance(value, float) and value.is_integer():
            return int(value), True
        return value, isinstance(value, int) and not isinstance(value, bool)
    if kind == "number":
        return value, isinstance(value, (int, float)) and not isinstance(value, bool)
    if kind == "boolean":
        return value, isinstance(value, bool)
    if kind == "null":
        return value, value is None
    if kind == "array":
        return value, isinstance(value, list)
    if kind == "object":
        return value, isinstance(value, dict)
    return value, False


def _short(value) -> str:
    text = json.dumps(value) if not isinstance(value, str) else repr(value)
    return text if len(text) <= 60 else text[:57] + "..."


_FENCE_RE = re.compile(r"```(?:json|JSON)?[ \t]*\n(.*?)```", re.DOTALL)


def parse_reply(text: str):
    """The JSON value in a sub-call's reply: the whole reply, else a fenced block, else the first object or array.
    Raises ValueError."""
    text = (text or "").strip()
    if not text:
        raise ValueError("the reply was empty")
    candidates = [text] + [m.group(1).strip() for m in _FENCE_RE.finditer(text)]
    for candidate in candidates:
        try:
            return json.loads(candidate)
        except ValueError:
            pass
    decoder = json.JSONDecoder()
    tries = 0
    for i, ch in enumerate(text):
        if ch in "{[":
            try:
                return decoder.raw_decode(text, i)[0]
            except ValueError:
                tries += 1
                if tries >= 50:
                    break
    raise ValueError("the reply holds no JSON value")


def decode(reply: str, schema: dict):
    """`(value, None)` for a reply that parses and matches, else `(None, error)`."""
    try:
        value = parse_reply(reply)
    except ValueError as exc:
        return None, str(exc)
    return validate(value, schema)


def instruction(schema: dict) -> str:
    return JSON_INSTRUCTION.format(schema=json.dumps(schema))


def retry_prompt(prompt: str, reply: str, error: str, schema: dict, room: int | None = None) -> str | None:
    """The retry for a reply that failed, at most `room` characters (None: no limit), or None if even the shortest
    retry would not fit in one sub-call."""
    if not (reply or "").strip():  # it spent its output on thinking (D-164)
        out = prompt + JSON_RETRY_EMPTY.format(schema=json.dumps(schema))
        return out if room is None or len(out) <= room else None
    error = error if len(error) <= 300 else error[:300] + " [...]"
    bare = prompt + JSON_RETRY.format(reply="", error=error, schema=json.dumps(schema))
    keep = REPLY_SHOWN_ON_RETRY if room is None else min(REPLY_SHOWN_ON_RETRY, room - len(bare) - len(" [...]"))
    if keep < 0:
        return None
    shown = reply if len(reply) <= keep else reply[:keep] + " [...]"
    return prompt + JSON_RETRY.format(reply=shown, error=error, schema=json.dumps(schema))


# ----------------------------------------------------------------------------- files


def split_text(text: str, size: int) -> list[tuple[int, int, str]]:
    """`text` cut into pieces of at most `size` characters at line ends where it can: (first line, last line, piece)."""
    pieces, start, line = [], 0, 1
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            cut = text.rfind("\n", start, end)
            if cut > start:
                end = cut + 1
        piece = text[start:end]
        lines = piece.count("\n") + (0 if piece.endswith("\n") else 1)
        pieces.append((line, line + max(lines, 1) - 1, piece))
        line += piece.count("\n")
        start = end
    return pieces or [(1, 1, "")]


def context_parts(context: str, names: list) -> dict[str, str]:
    """Read mode's input files by name. `names` holds the engine's spans ({name, start, end}, inputs.context_spans),
    or, from an older caller, plain names: the whole `context` for one input, else the `=== <name> ===` parts
    inputs.join_context made, found in order."""
    if names and all(isinstance(n, dict) for n in names):
        return {str(n["name"]): context[int(n["start"]):int(n["end"])] for n in names}
    if len(names) <= 1:
        return {names[0] if names else "context": context}
    parts, pos = {}, 0
    heads = []
    for name in names:
        head = f"=== {name} ===\n"
        at = context.find(head, pos)
        if at < 0:
            continue
        heads.append((name, at, at + len(head)))
        pos = at + len(head)
    for i, (name, _at, start) in enumerate(heads):
        end = heads[i + 1][1] - len("\n\n") if i + 1 < len(heads) else len(context)
        parts[name] = context[start:max(start, end)]
    return parts


# ----------------------------------------------------------------------------- the namespace


def namespace(base: dict, *, request, limits: dict, async_line, repl_line, cell_id, repo: bool, tools,
              input_files: list, sub_thinking) -> dict:
    """The cell globals agent_api adds or replaces. `base` holds the cell globals so far (cacheapi's llm and
    llm_batch, `context`); `request(op, **fields)` sends one request to the engine; `limits` is the worker's live
    sub-call limits; `async_line` is the thread-local the worker reads a request's cell line from; `tools` is the
    tools module; `sub_thinking` is the thread-local the worker reads a request's own thinking level from (D-164)."""
    toolkit = tools
    plain_llm, plain_batch = base["llm"], base["llm_batch"]

    def _room(over=None, shared=None) -> int:
        """What a retry prompt may hold: the sub-call limit less the prefix sent before it."""
        used = sum(len(t) + len(SEPARATOR) for t in (over, shared) if isinstance(t, str) and t)
        return limits["max_chars"] - used

    def _thinking(thinking):
        if thinking is not None and thinking not in THINKING:
            raise ValueError(f"thinking must be one of {', '.join(map(repr, THINKING))}, or None for the run's setting")
        return thinking

    def _with(thinking, fn, *args, **kwargs):
        before = getattr(sub_thinking, "value", None)
        sub_thinking.value = thinking if thinking is not None else before
        try:
            return fn(*args, **kwargs)
        finally:
            sub_thinking.value = before

    def base_llm(prompt, over=None, thinking=None):
        return _with(thinking, plain_llm, prompt, over=over)

    def base_batch(prompts, shared=None, over=None, thinking=None):
        return _with(thinking, plain_batch, prompts, shared=shared, over=over)
    pool: list[concurrent.futures.ThreadPoolExecutor] = []
    pool_lock = threading.Lock()

    def llm(prompt: str, over=None, schema=None, thinking=None):
        """Ask a language model one question. With over=segment, the segment's text is sent first, cached. With
        schema= (str, int, list[str], {"key": type}, ["yes", "no"], or a JSON Schema dict) the reply is parsed as JSON
        and checked, asked once more if it does not match, and returned as a Python value; ValueError if it still fails.
        thinking= ("off", "minimal", "low", "medium", "high", "xhigh", "max") sets how much the sub-call may think (a level
        the model lacks becomes its nearest one); None keeps the run's setting."""
        thinking = _thinking(thinking)
        if schema is None:
            return base_llm(prompt, over=over, thinking=thinking)
        compiled = compile_schema(schema)
        prompt = str(prompt)
        reply = base_llm(prompt + instruction(compiled), over=over, thinking=thinking)
        value, error = decode(reply, compiled)
        if error is None:
            return value
        # an empty reply spent its output on thinking: ask again without (D-164)
        again = "off" if not (reply or "").strip() else thinking
        retry = retry_prompt(prompt, reply, error, compiled, _room(over))
        if retry is None:
            raise ValueError(f"the sub-call's reply did not match the schema ({error}), and the prompt leaves no room "
                             "to ask again; shorten it")
        reply = base_llm(retry, over=over, thinking=again)
        value, error = decode(reply, compiled)
        if error is None:
            return value
        raise ValueError(f"the sub-call's reply did not match the schema, asked twice: {error}")

    def llm_batch(prompts: list[str], shared: str | None = None, over=None, schema=None, thinking=None) -> list:
        """Ask several prompts in parallel; each prompt counts as one sub-call. shared= is text sent first in every
        prompt; over= is one segment for all prompts or one per prompt, sent first and cached. With schema= each reply
        is parsed and checked as llm's is; a reply that fails twice is None. thinking= as in llm. Outputs come back in
        input order."""
        thinking = _thinking(thinking)
        if schema is None:
            return base_batch(prompts, shared=shared, over=over, thinking=thinking)
        if isinstance(prompts, (str, bytes)):
            raise TypeError("llm_batch expects a list of prompts, not a single string")
        compiled = compile_schema(schema)
        prompts = [str(p) for p in prompts]
        overs = over if isinstance(over, (list, tuple)) else [over] * len(prompts)
        if len(overs) != len(prompts):
            raise ValueError(f"over has {len(overs)} segments for {len(prompts)} prompts; give one, or one per prompt")
        replies = base_batch([p + instruction(compiled) for p in prompts], shared=shared, over=list(overs),
                             thinking=thinking)
        values, failed = [None] * len(prompts), []
        for i, reply in enumerate(replies):
            values[i], error = decode(reply, compiled)
            if error is not None:
                failed.append((i, reply, error))
        # empty replies spent their output on thinking, so they are asked again without it, in a batch of their own
        # (D-164); the rest keep the batch's thinking
        still = 0
        for empty in (True, False):
            group = [f for f in failed if (not (f[1] or "").strip()) == empty]
            retries = [retry_prompt(prompts[i], reply, error, compiled, _room(overs[i], shared))
                       for i, reply, error in group]
            still += sum(r is None for r in retries)  # no room to ask again: stays None
            group = [f for f, r in zip(group, retries) if r is not None]
            if not group:
                continue
            again = base_batch([r for r in retries if r is not None], shared=shared,
                               over=[overs[i] for i, _r, _e in group], thinking="off" if empty else thinking)
            for (i, _r, _e), reply in zip(group, again):
                values[i], error = decode(reply, compiled)
                still += error is not None
        if failed:
            if still:
                print(f"llm_batch: {still} of {len(prompts)} replies did not match the schema, asked twice; they are None")
        return values

    def _read(name: str) -> str | None:
        path = toolkit._abs(name)
        with open(path, "rb") as f:
            data = f.read()
        if b"\0" in data[:BINARY_SNIFF_BYTES]:
            return None
        return data.decode("utf-8", "replace")

    def _files(files) -> dict[str, str | None]:
        if isinstance(files, os.PathLike):
            files = [os.fspath(files)]
        if repo:
            if isinstance(files, str):
                pattern, alias = files.replace("\\", "/"), toolkit._config["alias"]
                if alias and (pattern == alias or pattern.startswith(alias + "/")):
                    pattern = pattern[len(alias) + 1:] or "."
                if not any(ch in pattern for ch in "*?["):  # one path, not a glob
                    return {toolkit._show(toolkit._abs(pattern)): _read(pattern)}
                names = toolkit.find_files(pattern)
                if not names:
                    raise FileNotFoundError(f"no files match {files!r}")
            else:
                names = [toolkit._show(toolkit._abs(os.fspath(f))) for f in files]
            return {name: _read(name) for name in dict.fromkeys(names)}
        parts = context_parts(base["context"], input_files)
        if isinstance(files, str):
            chosen = [n for n in parts if fnmatch.fnmatchcase(n, files) or fnmatch.fnmatchcase(n.rsplit("/", 1)[-1], files)
                      or fnmatch.fnmatchcase(n, "*/" + files)]
            if not chosen:
                raise FileNotFoundError(f"no input file matches {files!r}; the inputs are {list(parts)[:20]}")
        else:
            chosen = []
            for f in files:
                want = os.fspath(f).replace("\\", "/")
                match = [n for n in parts if n == want or n.endswith("/" + want)]
                if not match:
                    raise FileNotFoundError(f"{want!r} is not an input file; the inputs are {list(parts)[:20]}")
                chosen.append(match[0])
        return {name: parts[name] for name in dict.fromkeys(chosen)}

    def ask_files(files, question: str, schema=None, thinking=None) -> dict:
        """Ask the same question about each file, one sub-call per file, the file's text sent first and cached.
        files: a glob such as "src/**/*.py" or a list of paths (in a reading task, the input files' names). A file too
        large for one sub-call is asked in parts, and its value is a list of the parts' answers. A binary file is None.
        Returns {path: answer}; schema= and thinking= work as in llm_batch."""
        texts = _files(files)
        question = str(question)
        room = limits["max_chars"] - len(question) - len(SEPARATOR) - PART_MARGIN
        if schema is not None:  # the instruction, and room for a retry that shows the reply back
            room -= 2 * len(instruction(compile_schema(schema))) + REPLY_SHOWN_ON_RETRY + 600
        if room < 1000:
            raise ValueError("the question is too long to leave room for a file in one sub-call; shorten it")
        prefixes, owners = [], []
        for name, text in texts.items():
            if text is None:
                continue
            whole = f"=== {name} ===\n{text}"
            if len(whole) <= room:
                prefixes.append(whole)
                owners.append((name, 1))
                continue
            pieces = split_text(text, room - len(name) - 60)
            for k, (first, last, piece) in enumerate(pieces):
                prefixes.append(f"=== {name} (part {k + 1} of {len(pieces)}, lines {first}-{last}) ===\n{piece}")
                owners.append((name, len(pieces)))
        answers = llm_batch([question] * len(prefixes), over=prefixes, schema=schema, thinking=thinking) if prefixes else []
        out: dict = {name: None for name in texts}
        for (name, parts), answer in zip(owners, answers):
            if parts == 1:
                out[name] = answer
            else:
                out[name] = (out[name] or []) + [answer]
        return out

    def rlm_call(task: str, context: str | None = None, tools: str = "read", max_turns: int | None = None):
        """Start a child run on a task: it gets a REPL of its own, with `context` (and in a coding task the
        repository), its own turns and sub-calls, and returns what it submit()s. tools="read" can read the repository
        but not change it, "edit" can change it (coding tasks only), "none" has only `context`. max_turns may lower
        the child's turn limit. Its sub-calls come out of this run's budget."""
        if tools not in RLM_TOOLS:
            raise ValueError(f"tools must be one of {', '.join(map(repr, RLM_TOOLS))}")
        if tools == "edit" and not repo:
            raise ValueError("rlm(tools=\"edit\") works only in coding tasks")
        if max_turns is not None and (isinstance(max_turns, bool) or not isinstance(max_turns, int) or max_turns < 1):
            raise ValueError("max_turns must be a whole number of at least 1")
        reply = request("rlm", task=str(task), context=None if context is None else str(context), tools=tools,
                        max_turns=max_turns)
        return reply.get("answer")

    def _submit(fn, *args, **kwargs) -> concurrent.futures.Future:
        line, cell = repl_line(), cell_id()

        def run():
            async_line.line, async_line.cell = line, cell
            try:
                return fn(*args, **kwargs)
            finally:
                async_line.line = async_line.cell = None

        with pool_lock:
            if not pool:
                pool.append(concurrent.futures.ThreadPoolExecutor(ASYNC_WORKERS, thread_name_prefix="rlm-async"))
        return pool[0].submit(run)

    def llm_async(prompt: str, over=None, schema=None, thinking=None) -> concurrent.futures.Future:
        """llm(...) without waiting: returns a future at once; .result() (or gather) waits for the answer. The cell
        can start many and keep working; a future still running when the cell ends keeps running into the next one."""
        return _submit(llm, prompt, over=over, schema=schema, thinking=thinking)

    def llm_batch_async(prompts: list[str], shared: str | None = None, over=None, schema=None,
                        thinking=None) -> concurrent.futures.Future:
        """llm_batch(...) without waiting: a future whose .result() is the list of answers."""
        return _submit(llm_batch, prompts, shared=shared, over=over, schema=schema, thinking=thinking)

    def rlm_async(task: str, context: str | None = None, tools: str = "read", max_turns: int | None = None):
        """rlm(...) without waiting: a future whose .result() is what the child submitted. Children past the run's
        limit on how many run at once wait their turn."""
        return _submit(rlm_call, task, context=context, tools=tools, max_turns=max_turns)

    def gather(futures) -> list:
        """The results of several futures, in order; raises the first error any of them raised."""
        return [f.result() for f in futures]

    rlm_call.__name__ = rlm_call.__qualname__ = "rlm"
    # rlm is there at every depth; the engine refuses a child's own rlm() past the profile's max_depth, saying why
    return {"llm": llm, "llm_batch": llm_batch, "ask_files": ask_files, "llm_async": llm_async,
            "llm_batch_async": llm_batch_async, "gather": gather, "rlm": rlm_call, "rlm_async": rlm_async}
