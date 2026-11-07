# KV cache: lays out sub-call bytes so the parts many calls share come first and stay byte-identical (rlmh D-119):
# a segment (over=) or a batch's shared text (shared=) is the prefix, the question comes after it.
"""rlmh's sub-call toolkit for RLM mode in DeepSeek Harness, ported from rlmh's worker (engine/rlm_engine/worker/
cacheapi.py and agentapi.py, same repo). Differences under dsh: there is no built-in `context`, so segments() and scan()
take the text to read; files are read from disk by ask_files(); sub-calls go out through `subcalls(items)`, which the
REPL connects to the dsh `llm` tool. Standard library only.

    segments(text, size=None) -> list[Segment]
    llm(prompt, over=None, schema=None, thinking=None)
    llm_batch(prompts, shared=None, over=None, schema=None, thinking=None) -> list
    scan(text, question, schema=None, thinking=None, size=None) -> list
    ask_files(files, question, schema=None, thinking=None) -> dict
"""
import glob
import json
import os
import re
import types
import typing

SEPARATOR = "\n\n"  # between a prefix and its prompt
SEGMENT_CHARS = 40_000
MIN_SEGMENT_CHARS = 1_000
SUBCALL_MAX_CHARS = 60_000  # what one sub-call should read (rlmh default profile: subcall_max_chars)
BINARY_SNIFF_BYTES = 8192
PART_MARGIN = 600
REPLY_SHOWN_ON_RETRY = 2000
THINKING = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
JSON_INSTRUCTION = "\n\nReply with only a JSON value that matches this JSON Schema, and nothing else:\n{schema}"
JSON_RETRY = ("\n\nYour previous reply was:\n{reply}\n\nIt was not valid: {error}. Reply again with only a JSON value "
              "that matches this JSON Schema, and nothing else:\n{schema}")
JSON_RETRY_EMPTY = ("\n\nYour previous attempt ran out of room before it answered. Do not think at length: reply now "
                    "with only a JSON value that matches this JSON Schema, and nothing else:\n{schema}")
SCAN_PROMPT = ("Above is part {part} of {parts} of a longer text (characters {start:,} to {end:,}). The question about "
               "the whole text is:\n{question}\n\nFrom this part only, copy out word for word every passage that helps "
               "answer it: passages that answer it, that name or define something the question depends on, or that "
               "contradict another reading. Give an empty list when nothing here bears on it. In note, say in one "
               "sentence what the passages show.")
SCAN_SCHEMA = {"quotes": list[str], "note": str}


# ----------------------------------------------------------------------------- segments (cacheapi.py)


class Segment(str):
    """A slice of a text: the text itself, plus `id`, `start` and `end` (character offsets into the text)."""

    def __new__(cls, text, id, start, end):
        obj = super().__new__(cls, text)
        obj.id, obj.start, obj.end = id, start, end
        return obj

    def __repr__(self):
        return f"Segment(id={self.id}, start={self.start}, end={self.end}, chars={len(self)})"


def cut(text, size):
    """Fixed slices of about `size` characters, each ending at a line end when there is one; the same text and size
    always give the same slices, so their bytes (and the provider's cache of them) repeat."""
    out, start, n = [], 0, len(text)
    while start < n:
        end = min(start + size, n)
        if end < n:
            line_end = text.rfind("\n", start, end)
            if line_end > start:
                end = line_end + 1
        out.append(Segment(text[start:end], len(out), start, end))
        start = end
    return out


# ----------------------------------------------------------------------------- schemas (agentapi.py)

_SCALARS = {str: "string", int: "integer", float: "number", bool: "boolean", type(None): "null", list: "array",
            dict: "object"}
_JSON_TYPES = ("string", "integer", "number", "boolean", "null", "array", "object")
_SCHEMA_KEYS = ("type", "properties", "required", "items", "enum", "anyOf", "description", "additionalProperties")


def compile_schema(schema):
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


def _is_json_schema(schema):
    kind = schema.get("type")
    if isinstance(kind, str) or (isinstance(kind, list) and kind and all(isinstance(k, str) for k in kind)):
        return True
    return ("enum" in schema or "anyOf" in schema) and set(schema) <= set(_SCHEMA_KEYS)


def _check_json_schema(schema):
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


def validate(value, schema, path="$"):
    """`(value, None)` when `value` matches, with whole floats made ints where an integer is wanted; else
    `(None, error)`."""
    if "anyOf" in schema:
        errors = []
        for sub in schema["anyOf"]:
            out, error = validate(value, sub, path)
            if error is None:
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


def _as_type(value, kind):
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


def _short(value):
    text = json.dumps(value) if not isinstance(value, str) else repr(value)
    return text if len(text) <= 60 else text[:57] + "..."


_FENCE_RE = re.compile(r"```(?:json|JSON)?[ \t]*\n(.*?)```", re.DOTALL)


def parse_reply(text):
    """The JSON value in a sub-call's reply: the whole reply, else a fenced block, else the first object or array."""
    text = (text or "").strip()
    if not text:
        raise ValueError("the reply was empty")
    for candidate in [text] + [m.group(1).strip() for m in _FENCE_RE.finditer(text)]:
        try:
            return json.loads(candidate)
        except ValueError:
            pass
    decoder, tries = json.JSONDecoder(), 0
    for i, ch in enumerate(text):
        if ch in "{[":
            try:
                return decoder.raw_decode(text, i)[0]
            except ValueError:
                tries += 1
                if tries >= 50:
                    break
    raise ValueError("the reply holds no JSON value")


def decode(reply, schema):
    try:
        value = parse_reply(reply)
    except ValueError as exc:
        return None, str(exc)
    return validate(value, schema)


def instruction(schema):
    return JSON_INSTRUCTION.format(schema=json.dumps(schema))


def retry_prompt(prompt, reply, error, schema, room=None):
    """The retry for a reply that failed, at most `room` characters, or None if it would not fit in one sub-call."""
    if not (reply or "").strip():  # it spent its output on thinking (rlmh D-164)
        out = prompt + JSON_RETRY_EMPTY.format(schema=json.dumps(schema))
        return out if room is None or len(out) <= room else None
    error = error if len(error) <= 300 else error[:300] + " [...]"
    bare = prompt + JSON_RETRY.format(reply="", error=error, schema=json.dumps(schema))
    keep = REPLY_SHOWN_ON_RETRY if room is None else min(REPLY_SHOWN_ON_RETRY, room - len(bare) - len(" [...]"))
    if keep < 0:
        return None
    shown = reply if len(reply) <= keep else reply[:keep] + " [...]"
    return prompt + JSON_RETRY.format(reply=shown, error=error, schema=json.dumps(schema))


def split_text(text, size):
    """`text` cut into pieces of at most `size` characters at line ends where it can: (first line, last line, piece)."""
    pieces, start, line = [], 0, 1
    while start < len(text):
        end = min(start + size, len(text))
        if end < len(text):
            at = text.rfind("\n", start, end)
            if at > start:
                end = at + 1
        piece = text[start:end]
        lines = piece.count("\n") + (0 if piece.endswith("\n") else 1)
        pieces.append((line, line + max(lines, 1) - 1, piece))
        line += piece.count("\n")
        start = end
    return pieces or [(1, 1, "")]


# ----------------------------------------------------------------------------- the API


def build(subcalls, max_chars=SUBCALL_MAX_CHARS):
    """The REPL globals. `subcalls(items)` runs sub-calls and returns their reply texts in order; each item is
    {"prompt": str, "prefix": str or None, "thinking": str or None}, and the prefix is sent first, before SEPARATOR."""

    def _thinking(thinking):
        if thinking is not None and thinking not in THINKING:
            raise ValueError(f"thinking must be one of {', '.join(map(repr, THINKING))}, or None for the default")
        return thinking

    def _prefix(item):
        if item is None:
            return None
        if not isinstance(item, str):
            raise TypeError(f"over takes a segment (a str), not {type(item).__name__}")
        return str(item) or None

    def _check(prompt, prefix):
        total = len(prompt) + (len(prefix) + len(SEPARATOR) if prefix is not None else 0)
        if total > max_chars:
            raise ValueError(f"sub-call is {total:,} characters with its segment or shared text; one sub-call reads at "
                             f"most {max_chars:,}. Use smaller segments or a shorter prompt.")

    def _room(over=None, shared=None):
        used = sum(len(t) + len(SEPARATOR) for t in (over, shared) if isinstance(t, str) and t)
        return max_chars - used

    def base_batch(prompts, shared=None, over=None, thinking=None):
        if isinstance(prompts, (str, bytes)):
            raise TypeError("llm_batch expects a list of prompts, not a single string")
        prompts = [str(p) for p in prompts]
        if shared is not None and not isinstance(shared, str):
            raise TypeError(f"shared takes a str, not {type(shared).__name__}")
        shared = shared or None
        overs = [over] * len(prompts) if over is None or isinstance(over, str) else list(over)
        if len(overs) != len(prompts):
            raise ValueError(f"over has {len(overs)} segments for {len(prompts)} prompts; give one, or one per prompt")
        items = []
        for prompt, item in zip(prompts, overs):
            segment = _prefix(item)
            if segment is not None:  # the segment is the cached prefix; the shared text goes with the prompt
                body, prefix = (shared + SEPARATOR + prompt) if shared else prompt, segment
            else:
                body, prefix = prompt, shared
            _check(body, prefix)
            items.append({"prompt": body, "prefix": prefix, "thinking": thinking})
        return subcalls(items) if items else []

    def segments(text, size=None):
        """Split `text` into fixed slices (about 40,000 characters by default), cut at line ends. Pass them to
        llm(..., over=) or llm_batch(..., over=): a segment's text is sent first, byte for byte, so asking about the
        same segment again costs the cache price."""
        if not isinstance(text, str):
            raise TypeError(f"segments() takes the text to cut (a str), not {type(text).__name__}")
        size = SEGMENT_CHARS if size is None else size
        if not isinstance(size, int) or isinstance(size, bool) or size < MIN_SEGMENT_CHARS:
            raise ValueError(f"segments(text, size) takes a whole number of characters, at least {MIN_SEGMENT_CHARS:,}")
        return cut(text, size)

    def llm(prompt, over=None, schema=None, thinking=None):
        """Ask a language model one question. over=segment sends the segment's text first, cached. schema= (str, int,
        list[str], {"key": type}, ["yes", "no"], or a JSON Schema dict) parses and checks the reply as JSON, asks once
        more if it does not match, and returns a Python value (ValueError if it still fails). thinking= ("off" to
        "max") sets how much the sub-call may think; None keeps the default."""
        thinking = _thinking(thinking)
        if schema is None:
            return base_batch([prompt], over=over, thinking=thinking)[0]
        compiled = compile_schema(schema)
        prompt = str(prompt)
        reply = base_batch([prompt + instruction(compiled)], over=over, thinking=thinking)[0]
        value, error = decode(reply, compiled)
        if error is None:
            return value
        again = "off" if not (reply or "").strip() else thinking
        retry = retry_prompt(prompt, reply, error, compiled, _room(over))
        if retry is None:
            raise ValueError(f"the sub-call's reply did not match the schema ({error}), and the prompt leaves no room "
                             "to ask again; shorten it")
        value, error = decode(base_batch([retry], over=over, thinking=again)[0], compiled)
        if error is None:
            return value
        raise ValueError(f"the sub-call's reply did not match the schema, asked twice: {error}")

    def llm_batch(prompts, shared=None, over=None, schema=None, thinking=None):
        """Ask several prompts in parallel; each prompt is one sub-call. shared= is text sent first in every prompt;
        over= is one segment for all prompts or one per prompt, sent first and cached. With schema= each reply is
        parsed and checked as llm's is; a reply that fails twice is None. Outputs come back in input order."""
        thinking = _thinking(thinking)
        if schema is None:
            return base_batch(prompts, shared=shared, over=over, thinking=thinking)
        if isinstance(prompts, (str, bytes)):
            raise TypeError("llm_batch expects a list of prompts, not a single string")
        compiled = compile_schema(schema)
        prompts = [str(p) for p in prompts]
        overs = list(over) if isinstance(over, (list, tuple)) else [over] * len(prompts)
        if len(overs) != len(prompts):
            raise ValueError(f"over has {len(overs)} segments for {len(prompts)} prompts; give one, or one per prompt")
        replies = base_batch([p + instruction(compiled) for p in prompts], shared=shared, over=overs, thinking=thinking)
        values, failed = [None] * len(prompts), []
        for i, reply in enumerate(replies):
            values[i], error = decode(reply, compiled)
            if error is not None:
                failed.append((i, reply, error))
        still = 0
        for empty in (True, False):  # empty replies spent their output thinking: ask them again without it
            group = [f for f in failed if (not (f[1] or "").strip()) == empty]
            retries = [retry_prompt(prompts[i], reply, error, compiled, _room(overs[i], shared)) for i, reply, error in group]
            still += sum(r is None for r in retries)
            group = [f for f, r in zip(group, retries) if r is not None]
            if not group:
                continue
            again = base_batch([r for r in retries if r is not None], shared=shared,
                               over=[overs[i] for i, _r, _e in group], thinking="off" if empty else thinking)
            for (i, _r, _e), reply in zip(group, again):
                values[i], error = decode(reply, compiled)
                still += error is not None
        if still:
            print(f"llm_batch: {still} of {len(prompts)} replies did not match the schema, asked twice; they are None")
        return values

    def _read(path):
        with open(path, "rb") as f:
            data = f.read()
        if b"\0" in data[:BINARY_SNIFF_BYTES]:
            return None
        return data.decode("utf-8", "replace")

    def _files(files):
        if isinstance(files, os.PathLike):
            files = os.fspath(files)
        if isinstance(files, str):
            pattern = files.replace("\\", "/")
            if not any(ch in pattern for ch in "*?["):
                names = [pattern]
            else:
                names = sorted(p.replace("\\", "/") for p in glob.glob(pattern, recursive=True) if os.path.isfile(p))
                if not names:
                    raise FileNotFoundError(f"no files match {files!r}")
        else:
            names = [os.fspath(f).replace("\\", "/") for f in files]
        return {name: _read(name) for name in dict.fromkeys(names)}

    def ask_files(files, question, schema=None, thinking=None):
        """Ask the same question about each file, one sub-call per file, the file's text sent first and cached.
        files: a glob such as "src/**/*.py" (relative to the working directory) or a list of paths. A file too large
        for one sub-call is asked in parts, and its value is a list of the parts' answers. A binary file is None.
        Returns {path: answer}; schema= and thinking= work as in llm_batch."""
        texts = _files(files)
        question = str(question)
        room = max_chars - len(question) - len(SEPARATOR) - PART_MARGIN
        if schema is not None:
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
        out = {name: None for name in texts}
        for (name, parts), answer in zip(owners, answers):
            out[name] = answer if parts == 1 else (out[name] or []) + [answer]
        return out

    def scan(text, question, schema=None, thinking=None, size=None):
        """Ask one question about every segment of `text` at once, one sub-call per segment (cached, as
        llm_batch(..., over=segments(text)) is). Without schema=, each sub-call copies out the passages that bear on
        the question, and scan returns the parts that had any: [{"part", "start", "end", "quotes": [{"text", "at"}],
        "note"}], where "at" is the quote's offset in `text` (None when it is not word for word). With schema=, it
        returns every part as {"part", "start", "end", "answer"}."""
        parts = segments(text, size)
        question = str(question)
        prompts = [SCAN_PROMPT.format(part=s.id + 1, parts=len(parts), start=s.start, end=s.end, question=question)
                   for s in parts]
        answers = llm_batch(prompts, over=parts, schema=SCAN_SCHEMA if schema is None else schema,
                            thinking=thinking) if parts else []
        if schema is not None:
            return [{"part": s.id, "start": s.start, "end": s.end, "answer": a} for s, a in zip(parts, answers)]
        found, failed, quotes, exact = [], 0, 0, 0
        for s, a in zip(parts, answers):
            if a is None:
                failed += 1
                found.append({"part": s.id, "start": s.start, "end": s.end, "quotes": [], "note": None})
                continue
            kept = []
            for q in a["quotes"]:
                q = q.strip()
                if q:
                    at = s.find(q)
                    kept.append({"text": q, "at": s.start + at if at >= 0 else None})
            if kept:
                quotes += len(kept)
                exact += sum(k["at"] is not None for k in kept)
                found.append({"part": s.id, "start": s.start, "end": s.end, "quotes": kept, "note": a["note"]})
        print(f"scan: {len(parts)} parts, {len(found) - failed} with passages, {quotes} quotes ({exact} word for word)"
              + (f", {failed} failed" if failed else ""))
        return found

    return {"segments": segments, "llm": llm, "llm_batch": llm_batch, "scan": scan, "ask_files": ask_files}
