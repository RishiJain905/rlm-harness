"""KV cache: review() puts its fixed instruction and the task in `shared`, first and byte-identical in every sub-call.

Coding helpers for the `default` profile (agent_api): `review()` has sub-calls read your diff one file at a time against
the task, `check()` runs the tests and boils the output down to what failed, `outline()` lists a source file's classes
and functions with line ranges so `read_file` can go straight to the part that matters (D-157 to D-162). review() and check()
work in coding (repo) tasks only; outline() works in both modes.

Worker-side: imports only the standard library, never `rlm_engine`. The worker passes in everything else: its
`llm_batch` (agentapi's, with `schema=`), the `tools` module (`diff`, `shell`, `_abs`), and the run's task and test hint.
"""

from __future__ import annotations

import ast
import os
import re
from typing import Any, Callable, NamedTuple

NAMES = ("review", "check", "outline")  # the names namespace() adds; the worker hides them from `vars`

# inputs.NO_TEST_COMMAND, copied because the worker cannot import rlm_engine; test_codeapi checks they match.
NO_TEST_COMMAND = "no test command found; look for one in the repository"

# ----------------------------------------------------------------------------- review

CHUNK_CHARS = 40_000  # one review prompt's diff; a larger file diff is cut at hunk boundaries
MAX_LINE_CHARS = 4_000  # in a file diff that has to be cut, a longer line (minified code) is shortened to this
TASK_MAX_CHARS = 8_000

REVIEW_INSTRUCTION = (
    "You are reviewing part of a code change. First comes the task the change was written for. You then get one "
    "file's diff (a unified diff).\n\n"
    "Report only real problems: bugs, parts of the task the change leaves undone, other code or callers the change "
    "breaks, and tests that would fail. Ignore style, naming, formatting and comments. Judge only what the diff "
    "shows; do not guess about code you cannot see. For each problem give \"line\", the line number in the new "
    "file (the number after + in the @@ header, counting down from it; 0 if no single line applies), and "
    "\"problem\", one or two sentences. If the change looks right, answer ok = true with no issues; otherwise "
    "ok = false."
)
NO_TASK = "No task description was given; look for bugs only."


def _file_name(chunk: str) -> str:
    """The path a file's diff chunk is about: a rename's new name, else the +++ (or --- for a deletion) name, else
    the name in the `diff --git` header (a binary file has no +++ line)."""
    header = []
    for line in chunk.split("\n"):
        if line.startswith("@@"):
            break
        header.append(line.rstrip("\r"))

    def unquote(path: str) -> str:
        path = path.split("\t")[0].strip()
        return path[1:-1] if len(path) >= 2 and path[0] == path[-1] == '"' else path

    old = new = None
    for line in header:
        if line.startswith("rename to "):
            return unquote(line[len("rename to "):])
        if line.startswith("+++ "):
            new = unquote(line[4:])
        elif line.startswith("--- "):
            old = unquote(line[4:])
    for name in (new, old):
        if name and name != "/dev/null":
            return name[2:] if name[:2] in ("a/", "b/") else name
    first = header[0] if header else ""
    if first.startswith("diff --git "):
        rest = first[len("diff --git "):]
        size = (len(rest) - 5) // 2  # "a/X b/X" holds X twice
        if rest.startswith("a/") and size > 0 and rest[2 + size:] == " b/" + rest[2:2 + size]:
            return rest[2:2 + size]
        found = re.match(r'^"?a/(.+?)"? "?b/(.+?)"?$', rest)
        if found:
            return found.group(2)
    return "(diff)"


def split_diff(text: str) -> list[tuple[str, str]]:
    """A git unified diff as [(path, that file's diff)] in diff order. Text without `diff --git` headers is one chunk."""
    out = []
    for piece in re.split(r"(?m)^(?=diff --git )", text):
        if piece.strip():
            out.append((_file_name(piece), piece.rstrip("\n") + "\n"))
    return out


def _size(lines: list[str]) -> int:
    return sum(len(line) + 1 for line in lines)


def _cut_long(line: str) -> str:
    if len(line) <= MAX_LINE_CHARS:
        return line
    return line[:MAX_LINE_CHARS] + f" [... {len(line) - MAX_LINE_CHARS:,} more characters]"


def _split_hunk(hunk: list[str], room: int) -> list[list[str]]:
    """One hunk (its @@ line first) as parts of at most `room` characters; each part after the first gets a made-up
    @@ line with the right line numbers, so the reviewer can still count lines."""
    found = re.match(r"@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@", hunk[0])
    old, new = (int(found.group(1)), int(found.group(2))) if found else (1, 1)
    parts: list[list[str]] = []
    cur, size = [hunk[0]], len(hunk[0]) + 1
    for line in hunk[1:]:
        if len(cur) > 1 and size + len(line) + 1 > room:
            parts.append(cur)
            cur = [f"@@ -{old} +{new} @@ (continued)"]
            size = len(cur[0]) + 1
        cur.append(line)
        size += len(line) + 1
        mark = line[:1]
        if mark in (" ", ""):
            old, new = old + 1, new + 1
        elif mark == "+":
            new += 1
        elif mark == "-":
            old += 1
    parts.append(cur)
    return parts


def split_chunk(chunk: str, limit: int = CHUNK_CHARS) -> list[str]:
    """A file's diff as pieces of at most `limit` characters: cut between hunks, and inside a hunk only when one hunk
    alone is too big. Every piece repeats the diff header (`diff --git`, `---`, `+++`)."""
    if len(chunk) <= limit:
        return [chunk]
    lines = [_cut_long(line) for line in chunk.rstrip("\n").split("\n")]
    first = next((i for i, line in enumerate(lines) if line.startswith("@@")), len(lines))
    head, hunks = lines[:first], []
    for line in lines[first:]:
        if line.startswith("@@"):
            hunks.append([line])
        else:
            hunks[-1].append(line)
    if not hunks:  # no hunks to cut between (a huge header): plain line groups
        hunks = [lines[i:i + 200] for i in range(0, len(lines), 200)]
        head = []
    room = max(limit - _size(head) - 100, 1_000)
    pieces: list[str] = []
    cur: list[str] = []
    for hunk in hunks:
        for part in (_split_hunk(hunk, room) if _size(hunk) > room and hunk[0].startswith("@@") else [hunk]):
            if cur and _size(cur) + _size(part) > room:
                pieces.append("\n".join(head + cur) + "\n")
                cur = []
            cur += part
    if cur:
        pieces.append("\n".join(head + cur) + "\n")
    return pieces


def _issue(item: Any) -> dict:
    if isinstance(item, dict):
        line = item.get("line")
        line = line if isinstance(line, int) and not isinstance(line, bool) and line > 0 else None
        return {"line": line, "problem": str(item.get("problem", "")).strip()}
    return {"line": None, "problem": str(item).strip()}


def _merge(replies: list) -> dict:
    """One file's replies (one per piece of its diff) as {"ok", "issues"}, plus "error" if a reply was unusable."""
    issues: list[dict] = []
    oks: list[bool | None] = []
    failed = 0
    for reply in replies:
        if not isinstance(reply, dict):
            failed += 1
            continue
        found = [_issue(item) for item in (reply.get("issues") or [])]
        issues += found
        ok = reply.get("ok")
        oks.append(ok if isinstance(ok, bool) else (not found if "issues" in reply else None))
    if issues or False in oks:
        ok = False
    elif failed or not oks or None in oks:
        ok = None
    else:
        ok = True
    out: dict = {"ok": ok, "issues": issues}
    if failed:
        out["error"] = "no valid reply" if failed == len(replies) else f"no valid reply for {failed} of {len(replies)} parts"
    return out


# ----------------------------------------------------------------------------- check

SUMMARY_MAX_CHARS = 3_000
MAX_FAIL_LINES = 40
TAIL_LINES_FAIL = 15
TAIL_LINES_PASS = 5
TAIL_MAX_CHARS = 1_200
SUMMARY_LINE_CHARS = 200
TIMEOUT_CODE = 124  # tools.SHELL_TIMEOUT_CODE
_TIMED_OUT = re.compile(r"\[timed out after [\d.]+ s and killed\]\s*$")
_ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
# Lines that say what failed, for the test runners the default profile's test hints name.
_FAILURE = re.compile("|".join((
    r"^(?:FAILED|ERROR)\b",  # pytest short summary
    r"^E {3}",  # pytest's assertion detail
    r"^_{2,} .+ _{2,}$",  # pytest's per-test header
    r"^\s*(?:FAIL|ERROR)\b",  # jest, vitest, go
    r"^\s*[✗✕×✘]",  # bun, jest, vitest: a cross before a test name
    r"^\s*\(fail\)",  # bun
    r"^\s*●",  # jest's failure headings
    r"Traceback \(most recent call last\)",
    r"\bAssertionError\b",
    r"^[A-Za-z_][\w.]*(?:Error|Exception)\b:",  # a raised exception
    r"\berror TS\d+",  # tsc
    r"^\s*--- FAIL",  # go test
    r"^\s+\S+_test\.go:\d+:",  # go test's message lines
    r"^panic:",
    r"\bpanicked at\b",  # cargo
    r"^error(?:\[E\d+\])?:",  # cargo, rustc
    r"^\[ERROR\]",  # maven
    r"\bFAILED\b",  # cargo's `... FAILED`, gradle, pytest
)))


def _clip(line: str, size: int = SUMMARY_LINE_CHARS) -> str:
    line = line.rstrip()
    return line if len(line) <= size else line[:size - 3] + "..."


def _one_line(cmd: str) -> str:
    first = cmd.strip().split("\n")[0]
    return _clip(first, SUMMARY_LINE_CHARS) + (" ..." if "\n" in cmd.strip() else "")


def summarize(cmd: str, code: int, out: str, timed_out: bool = False) -> str:
    """A test run as text: `PASS`, `FAIL (exit N)` or `TIMEOUT` and the command; the lines that look like failures
    (at most 40, no repeats); the last lines of output. At most about 3,000 characters."""
    ok = code == 0
    head = f"{'PASS' if ok else 'TIMEOUT' if timed_out else f'FAIL (exit {code})'}: {_one_line(cmd)}"
    body = _ANSI.sub("", out).replace("\r\n", "\n").rstrip()
    raw = body.split("\n") if body.strip() else []
    lines = [_clip(line) for line in raw]  # shown clipped; a failure is recognized on the whole line
    tail = lines[-(TAIL_LINES_PASS if ok else TAIL_LINES_FAIL):]
    while len(tail) > 1 and len("\n".join(tail)) > TAIL_MAX_CHARS:
        tail.pop(0)
    fails: list[str] = []
    if not ok:
        seen = set(tail)  # a failure line already in the tail is not shown twice
        for whole, line in zip(raw, lines):
            if line.strip() and line not in seen and _FAILURE.search(whole.rstrip()):
                seen.add(line)
                fails.append(line)
    room = SUMMARY_MAX_CHARS - len(head) - len("\n".join(tail)) - 100  # labels and the "more" line
    kept, used = [], 0
    for line in fails[:MAX_FAIL_LINES]:
        if used + len(line) + 1 > room:
            break
        kept.append(line)
        used += len(line) + 1
    parts = [head]
    if kept:
        parts += ["failures:", *kept]
        if len(fails) > len(kept):
            parts.append(f"[... {len(fails) - len(kept)} more failure lines]")
    if tail:
        parts += [f"last {len(tail)} lines:" if len(tail) > 1 else "output:", *tail]
    else:
        parts.append("(no output)")
    text = "\n".join(parts)
    return text if len(text) <= SUMMARY_MAX_CHARS else text[:SUMMARY_MAX_CHARS - 20] + "\n[... cut]"


class CheckResult:
    """What check() returns. Printing it shows `summary`: PASS or FAIL, the lines that say what failed, and the end of
    the output. `ok` is True when the exit code was 0 (and bool(result) is `ok`), `code` the exit code, `cmd` the
    command, `out` the full output, `timed_out` whether the command was killed at its time limit."""

    def __init__(self, cmd: str, code: int, out: str) -> None:
        self.cmd, self.code, self.out = cmd, code, out
        self.ok = code == 0
        self.timed_out = code == TIMEOUT_CODE and bool(_TIMED_OUT.search(out))
        self.summary = summarize(cmd, code, out, self.timed_out)

    def __str__(self) -> str:
        return self.summary

    __repr__ = __str__

    def __bool__(self) -> bool:
        return self.ok


# ----------------------------------------------------------------------------- outline

MAX_OUTLINE_LINES = 400
MAX_FILE_BYTES = 5_000_000
SYMBOL_CHARS = 120
MAX_SCAN_LINE = 2_000
PY_MAX_LEVEL = 3
SNIFF_BYTES = 8192


class _Rule(NamedTuple):
    regex: re.Pattern
    container: bool = False  # members may sit inside it (a class, an impl, a trait, a namespace)
    where: str = "any"  # "top": column 0 only; "member": directly inside a container; "any"
    const: bool = False  # shown as `NAME =` instead of the declaration line


class _Family(NamedTuple):
    rules: tuple
    comments: tuple  # a line starting with one of these is not code
    close: str | None  # what ends a block: "}" or "end" at the declaration's own indent
    skip: frozenset = frozenset()  # words that look like a name but are statements


def _rule(pattern: str, **kw: Any) -> _Rule:
    return _Rule(re.compile(pattern), **kw)


_C_COMMENTS = ("//", "/*", "*")
_MODS = "public|private|protected|internal|fileprivate|static|final|abstract|override|open"

_JS = _Family(rules=(
    _rule(r"\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class(?:\s+[\w$]+|\s*\{|\s+extends\b)",
          container=True),
    _rule(r"\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\b\s*\*?\s*(?P<name>[\w$]*)\s*[(<]"),
    _rule(r"\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[\w$]+"),
    _rule(r"\s*(?:export\s+)?(?:declare\s+)?interface\s+[\w$]+"),
    _rule(r"\s*(?:export\s+)?(?:declare\s+)?type\s+[\w$]+\s*(?:<[^=]*>)?\s*="),
    _rule(r"\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+[\w$.]+", container=True),
    _rule(r"\s*(?:export\s+)?(?:default\s+)?(?:const|let|var)\s+[\w$]+\s*(?::[^=]+)?=\s*(?:async\s+)?"
          r"(?:function\b|(?:<[^>]*>\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+?)?\s*=>)"),
    _rule(r"\s*(?:export\s+)?const\s+(?P<name>[A-Z][A-Z0-9_]*)\b\s*(?::[^=]+)?=(?!=)", where="top", const=True),
    _rule(r"\s+(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set|declare|accessor)\s+)*"
          r"\*?\s*(?P<name>#?[\w$]+)\s*(?:<[^>(]*>)?\s*\(", where="member"),
    _rule(r"\s+(?:(?:public|private|protected|static|readonly|override|declare|accessor)\s+)*(?P<name>#?[\w$]+)\s*"
          r"(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::\s*[^=]+?)?\s*=>", where="member"),
), comments=_C_COMMENTS, close="}", skip=frozenset(
    "if for while switch catch function return else with do try finally new typeof await yield delete void throw "
    "super import export".split()))

_GO = _Family(rules=(
    _rule(r"func\s*(?:\([^)]*\)\s*)?\w+", where="top"),
    _rule(r"type\s+\w+", where="top"),
), comments=_C_COMMENTS, close="}")

_RS_VIS = r"(?:pub(?:\([^)]*\))?\s+)?"
_RUST = _Family(rules=(
    _rule(r"\s*" + _RS_VIS + r"(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+(?:\"[^\"]*\"\s+)?)?"
          r"fn\s+\w+"),
    _rule(r"\s*" + _RS_VIS + r"(?:unsafe\s+)?(?:struct|enum|union)\s+\w+"),
    _rule(r"\s*" + _RS_VIS + r"(?:unsafe\s+)?(?:trait|mod)\s+\w+", container=True),
    _rule(r"\s*(?:unsafe\s+)?impl\b", container=True),
    _rule(r"\s*" + _RS_VIS + r"type\s+\w+"),
    _rule(r"\s*macro_rules!\s*\w+"),
    _rule(r"\s*" + _RS_VIS + r"(?:const|static)\s+(?P<name>[A-Z][A-Z0-9_]*)\s*:", where="top", const=True),
), comments=_C_COMMENTS, close="}")

_JVM = _Family(rules=(
    _rule(r"\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:" + _MODS + r"|sealed|data|partial|inner|value|annotation|enum|inline|"
          r"expect|actual|unsafe|readonly|ref|record)\s+)*(?:class|interface|enum|record|struct|object|trait|protocol|"
          r"extension|actor|namespace)\s+[\w.<>]+", container=True),
    _rule(r"\s*(?:(?:public|private|internal)\s+)?companion\s+object\b", container=True),
    _rule(r"\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:" + _MODS + r"|suspend|inline|operator|infix|tailrec|external|"
          r"mutating|nonmutating|class|convenience|required|lazy)\s+)*(?:fun|func)\s+(?:<[^>]*>\s*)?(?P<name>[\w.<>?]+)\s*\("),
    _rule(r"\s*(?:(?:public|private|internal|fileprivate|open|convenience|required|override)\s+)*"
          r"(?:init[?!]?|deinit)\s*[({]"),
    _rule(r"\s+(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:" + _MODS + r"|virtual|async|synchronized|native|sealed|new|extern|"
          r"partial|unsafe|readonly|default|strictfp)\s+)*(?:(?P<ret>[\w.?*&]+(?:\s*<[^()]*>)?(?:\[\])*)\s+)?"
          r"(?P<name>\w+)\s*\(", where="member"),
), comments=_C_COMMENTS, close="}", skip=frozenset(
    "if for while switch catch return synchronized using lock foreach fixed new throw else do try when assert super this "
    "sizeof typeof nameof await yield case".split()))

_RUBY = _Family(rules=(
    _rule(r"\s*(?:class|module)\s+[\w:]+", container=True),
    _rule(r"\s*class\s*<<\s*\w+", container=True),
    _rule(r"\s*def\s+(?:self\.|\w+\.)?[^\s(;]+"),
), comments=("#",), close="end")

_PHP = _Family(rules=(
    _rule(r"\s*(?:(?:abstract|final|readonly)\s+)*(?:class|interface|trait|enum)\s+\w+", container=True),
    _rule(r"\s*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+&?\w+\s*\("),
), comments=("//", "#", "/*", "*"), close="}")

_PY_FALLBACK = _Family(rules=(
    _rule(r"\s*class\s+\w+"),
    _rule(r"\s*(?:async\s+def|def)\s+\w+"),
), comments=("#",), close=None)

_FAMILIES: dict[str, tuple[str, ...]] = {
    "python": (".py", ".pyi"),
    "js": (".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"),
    "go": (".go",),
    "rust": (".rs",),
    "jvm": (".java", ".cs", ".kt", ".kts", ".swift"),
    "ruby": (".rb",),
    "php": (".php",),
}
_REGEX_FAMILY = {"js": _JS, "go": _GO, "rust": _RUST, "jvm": _JVM, "ruby": _RUBY, "php": _PHP}
_KIND = {ext: kind for kind, exts in _FAMILIES.items() for ext in exts}
SUPPORTED = tuple(ext for exts in _FAMILIES.values() for ext in exts)


class _Sym:
    __slots__ = ("start", "end", "width", "level", "text", "container")

    def __init__(self, start: int, width: int, level: int, text: str, container: bool) -> None:
        self.start, self.end, self.width, self.level, self.text, self.container = start, start, width, level, text, container


def _width(line: str) -> int:
    return len(line[:len(line) - len(line.lstrip())].expandtabs(4))


def _is_close(stripped: str, close: str) -> bool:
    return stripped.startswith("}") if close == "}" else re.match(r"end\b", stripped) is not None


def _symbol_text(stripped: str) -> str:
    text = re.sub(r"\s*(?:=>\s*)?\{\s*$", "", stripped)
    text = re.sub(r"\s*[;:]\s*$", "", text)
    return text if len(text) <= SYMBOL_CHARS else text[:SYMBOL_CHARS - 3] + "..."


def _single_line(stripped: str, family: _Family) -> bool:
    """True when a declaration starts and ends on its own line (`fn f() {}`, `type X = Y;`, `def f; end`)."""
    if family.close == "end":
        return re.search(r"\bend\s*$", stripped) is not None
    if stripped.count("{") != stripped.count("}") or stripped.count("(") != stripped.count(")"):
        return False
    if "{" in stripped or stripped.endswith(";"):
        return True
    return "=>" in stripped and not stripped.endswith(("=>", ",", "("))


def _scan(lines: list[str], family: _Family) -> list[_Sym]:
    """Declarations by regex. Nesting comes from indentation: a declaration is inside the nearest earlier one that is
    indented less and has not been closed by a `}` / `end` at its own indent."""
    syms: list[_Sym] = []
    stack: list[_Sym] = []
    in_block = False
    for number, raw in enumerate(lines, 1):
        stripped = raw.strip()
        if not stripped:
            continue
        if in_block:
            in_block = "*/" not in stripped
            continue
        if len(raw) > MAX_SCAN_LINE:  # minified code: no declaration to find, and the regexes slow down
            continue
        if stripped.startswith(family.comments):
            in_block = stripped.startswith("/*") and "*/" not in stripped
            continue
        width = _width(raw)
        if family.close and _is_close(stripped, family.close):
            while stack and stack[-1].width >= width:
                stack.pop()
            continue
        parent = next((s for s in reversed(stack) if s.width < width), None)
        for rule in family.rules:
            found = rule.regex.match(raw)
            if not found or (rule.where == "top" and width != 0):
                continue
            if rule.where == "member" and (parent is None or not parent.container or stripped.endswith(";")):
                continue
            names = found.groupdict()
            if names.get("name") in family.skip or names.get("ret") in family.skip:
                continue
            while stack and stack[-1].width >= width:
                stack.pop()
            text = f"{names['name']} =" if rule.const else _symbol_text(stripped)
            sym = _Sym(number, width, len(stack), text, rule.container)
            syms.append(sym)
            stack.append(sym)
            break
    return syms


def _regex_outline(source: str, family: _Family) -> list[tuple[int, int, int, str]]:
    lines = source.splitlines()
    syms = _scan(lines, family)
    count = len(lines)
    limit = [count] * len(syms)  # the line before the next declaration at this level or above
    open_: list[int] = []
    for i, sym in enumerate(syms):
        while open_ and syms[open_[-1]].level >= sym.level:
            limit[open_.pop()] = sym.start - 1
        open_.append(i)
    out = []
    for sym, last in zip(syms, limit):
        start, last = sym.start, max(last, sym.start)
        if _single_line(lines[start - 1].strip(), family):
            end = start
        else:
            end = None
            if family.close:  # the first closing line at the declaration's own indent
                for k in range(start, last):
                    line = lines[k]
                    if line.strip() and _width(line) == sym.width and _is_close(line.strip(), family.close):
                        end = k + 1
                        break
            if end is None:  # no closer: up to the next declaration, minus blank and comment lines before it
                end = last
                while end > start and (not lines[end - 1].strip() or lines[end - 1].strip().startswith(family.comments)):
                    end -= 1
        out.append((start, end, sym.level, sym.text))
    return out


_ODD_BREAKS = re.compile("[\x0b\x0c\x1c\x1d\x1e\x85  ]")  # str.splitlines() breaks on these, ast does not


def _py_text(node: ast.AST) -> str:
    if isinstance(node, ast.ClassDef):
        bases = [ast.unparse(b) for b in node.bases]
        bases += [f"{k.arg}={ast.unparse(k.value)}" if k.arg else f"**{ast.unparse(k.value)}" for k in node.keywords]
        text = f"class {node.name}" + (f"({', '.join(bases)})" if bases else "")
    else:
        text = f"{'async def' if isinstance(node, ast.AsyncFunctionDef) else 'def'} {node.name}({ast.unparse(node.args)})"
        if node.returns is not None:
            text += f" -> {ast.unparse(node.returns)}"
    return text if len(text) <= SYMBOL_CHARS else text[:SYMBOL_CHARS - 3] + "..."


def _py_outline(tree: ast.Module) -> list[tuple[int, int, int, str]]:
    out: list[tuple[int, int, int, str]] = []

    def visit(body: list, level: int) -> None:
        for node in body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = min([node.lineno] + [d.lineno for d in node.decorator_list])
                out.append((start, node.end_lineno or node.lineno, level, _py_text(node)))
                if level < PY_MAX_LEVEL:
                    visit(node.body, level + 1)
                continue
            if level == 0 and isinstance(node, (ast.Assign, ast.AnnAssign)):
                targets = node.targets if isinstance(node, ast.Assign) else [node.target]
                for target in targets:
                    if isinstance(target, ast.Name) and re.fullmatch(r"[A-Z][A-Z0-9_]*", target.id):
                        out.append((node.lineno, node.end_lineno or node.lineno, 0, f"{target.id} ="))
            for field in ("body", "orelse", "finalbody"):  # `if TYPE_CHECKING:`, `try:`, `with`: same level
                sub = getattr(node, field, None)
                if isinstance(sub, list):
                    visit(sub, level)
            for branch in (*getattr(node, "handlers", ()), *getattr(node, "cases", ())):
                visit(branch.body, level)

    visit(tree.body, 0)
    out.sort(key=lambda entry: entry[0])
    return out


def _python_symbols(source: str) -> tuple[list[tuple[int, int, int, str]], str | None]:
    """(symbols, note). The numbering is str.splitlines()'s, which is read_file's; ast agrees except after odd line
    breaks, so those are turned into plain newlines first (the original is tried when that no longer parses)."""
    tries = [source]
    if _ODD_BREAKS.search(source):
        tries.insert(0, "\n".join(source.splitlines()))
    error = None
    for text in tries:
        try:
            return _py_outline(ast.parse(text)), None
        except (SyntaxError, ValueError, RecursionError) as e:
            error = e
    where = f"line {error.lineno}: " if isinstance(error, SyntaxError) and error.lineno else ""
    reason = (error.msg if isinstance(error, SyntaxError) else str(error)) or type(error).__name__
    return _regex_outline(source, _PY_FALLBACK), f"[does not parse ({where}{reason}); outline from def and class lines]"


def render_outline(entries: list[tuple[int, int, int, str]], note: str | None = None) -> str:
    """`L12-40 class Foo(Base)` lines, two spaces of indent per nesting level, at most MAX_OUTLINE_LINES."""
    if not entries:
        return "(no symbols found)" if note is None else note + "\n(no symbols found)"
    shown = [f"L{start}{f'-{end}' if end > start else ''} {'  ' * level}{text}"
             for start, end, level, text in entries[:MAX_OUTLINE_LINES]]
    if len(entries) > MAX_OUTLINE_LINES:
        shown.append(f"[... {len(entries) - MAX_OUTLINE_LINES} more]")
    return "\n".join(([note] if note else []) + shown)


# ----------------------------------------------------------------------------- the REPL names


def namespace(*, llm_batch: Callable, tools: Any, task: str | None, test_hint: str | None, repo: bool) -> dict:
    """The cell globals review, check and outline. `llm_batch` is the worker's (agentapi's: it takes `schema=` and
    returns None for a reply that failed validation twice), `tools` is the worker's tools module (diff, shell, _abs),
    `task` and `test_hint` are the run's, and `repo` says whether this is a coding task."""
    run_task = task

    def review(task: str | None = None, diff_text: str | None = None) -> list[dict]:
        """Have sub-calls review your change against the task, one file at a time. Returns
        [{"file", "ok", "issues": [{"line", "problem"}]}] in diff order; ok is None if no usable reply came back."""
        if not repo:
            raise RuntimeError("review() works in coding tasks")
        for name, value in (("task", task), ("diff_text", diff_text)):
            if value is not None and not isinstance(value, str):
                raise TypeError(f"{name} takes a str, not {type(value).__name__}")
        text = tools.diff() if diff_text is None else diff_text
        if not text.strip():
            raise ValueError("there are no changes to review")
        about = (task or "").strip() or (run_task or "").strip()
        if len(about) > TASK_MAX_CHARS:
            about = about[:TASK_MAX_CHARS] + "\n[... task cut]"
        shared = f"{REVIEW_INSTRUCTION}\n\nTask:\n{about}" if about else f"{REVIEW_INSTRUCTION}\n\n{NO_TASK}"
        prompts: list[str] = []
        spans: list[tuple[str, int, int]] = []  # (file, first prompt, one past the last)
        for name, chunk in split_diff(text):
            pieces = split_chunk(chunk)
            spans.append((name, len(prompts), len(prompts) + len(pieces)))
            for number, piece in enumerate(pieces, 1):
                part = f" (part {number} of {len(pieces)})" if len(pieces) > 1 else ""
                prompts.append(f"File: {name}{part}\n\n{piece}")
        replies = llm_batch(prompts, shared=shared,
                            schema={"ok": bool, "issues": [{"line": int, "problem": str}]})
        if len(replies) != len(prompts):
            raise RuntimeError(f"llm_batch returned {len(replies)} replies for {len(prompts)} prompts")
        return [{"file": name, **_merge(list(replies[first:end]))} for name, first, end in spans]

    def check(cmd: str | None = None, timeout: float = 300) -> CheckResult:
        """Run the repository's test command (or `cmd`) and return a result: printing it shows PASS or FAIL, the lines
        that say what failed and the end of the output. `.ok`, `.code` and `.out` hold the verdict and the full output."""
        if not repo:
            raise RuntimeError("check() works in coding tasks")
        if cmd is None:
            if not test_hint or test_hint == NO_TEST_COMMAND:
                raise ValueError("check() needs a command: no test command was found for this repository. "
                                 "Pass one, for example check('pytest -q').")
            cmd = test_hint
        elif not isinstance(cmd, str) or not cmd.strip():
            raise ValueError("cmd must be a non-empty command string")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or timeout <= 0:
            raise ValueError("timeout must be a positive number of seconds")
        done = tools.shell(cmd, timeout=timeout)
        return CheckResult(cmd, done.code, done.out)

    def outline(path: str) -> str:
        """List the classes, functions and constants in a source file with their line ranges (Python, JavaScript and
        TypeScript, Go, Rust, Java, C#, Kotlin, Swift, Ruby, PHP), so read_file can go straight to the part you need."""
        full = tools._abs(path)
        extension = os.path.splitext(full)[1].lower()
        kind = _KIND.get(extension)
        if kind is None:
            what = f"'{extension}' files" if extension else "a file with no extension"
            raise ValueError(f"outline() reads {', '.join(SUPPORTED)} files, not {what}; use read_file or grep for this one")
        if not os.path.isfile(full):
            raise FileNotFoundError(f"no such file: {path}")
        if os.path.getsize(full) > MAX_FILE_BYTES:
            raise ValueError(f"{path} is over {MAX_FILE_BYTES:,} bytes; use grep to find what you need")
        with open(full, "rb") as f:
            data = f.read()
        if b"\0" in data[:SNIFF_BYTES]:
            raise ValueError(f"{path} is a binary file")
        source = data.decode("utf-8-sig", errors="replace")
        if kind == "python":
            entries, note = _python_symbols(source)
        else:
            entries, note = _regex_outline(source, _REGEX_FAMILY[kind]), None
        return render_outline(entries, note)

    return {"review": review, "check": check, "outline": outline}
