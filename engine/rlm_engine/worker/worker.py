"""The REPL worker, one process per run: rlm_rl/repl_worker.py at RLM commit 0b9af69, run natively.

KV cache: what a cell prints, its traceback and the sub-call errors become the model's next observation; that text
is frozen to training's (_Capped, _format_error, _truncate, submit), so the same cell gives the same bytes.

Launched as `python -I -B -X utf8 <dir>/rlm_engine/worker/worker.py` (D-01, D-42). Standard library only, and it
imports only its sibling files `hooks` and `tools`, by putting its own folder on sys.path for those two imports.
It speaks JSON lines on private dups of its original stdin and stdout (architecture §6.1): the engine sends `init`,
then `cell`s and `vars`; the worker sends `ready`, `result`s, `vars` answers and `request`s (`llm`, `llm_batch`,
`fetch`, `approve`), whose `reply` the reader thread hands back to the waiting thread.

During a cell, fds 1 and 2 feed the cell's output in both modes (D-37); between cells they point at the null device,
and fd 0 always does. Python's sys.stderr is a hidden buffer that only the run log sees. The worker's own diagnostics
go to a private dup of fd 2, which the engine copies to its stderr.

Dropped from training: the PID 1 supervisor, Landlock, the Docker paths, the Unix socket, the edit-metrics log,
_ImportWatch, and the ctypes and gc blocks. The audit hook asks the engine instead of blocking (hooks.py).
"""

import contextlib
import io
import json
import math
import os
import queue
import sys
import threading
import time
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)  # -I leaves the script's folder off sys.path (D-01)
try:
    import hooks
    import tools
finally:
    sys.path.remove(_HERE)

# Must match engine/rlm_engine/contract.py; tests/test_worker.py checks.
API_NAMES = ("context", "llm", "llm_batch", "submit")
OUTPUT_MAX_CHARS = 8000  # the largest cap; the host cuts each episode to its own (prompt v1: 2,000)
TRACEBACK_LINES = 6
SUBCALL_MAX_CHARS = 24_000
SUBCALL_TRUNCATION_MARK = "[prompt truncated]"
SUBMIT_MAX_BYTES = 100_000

STDERR_KEEP_CHARS = 4000
HIDDEN_NAMES = frozenset(API_NAMES + ("fetch",) + tools.TOOL_NAMES)  # never listed by `vars`
VARS_REPR_MAX = 10**6

_state = {"submitted": False, "answer": None}

# ----------------------------------------------------------------------------- engine requests

# Time spent waiting on the engine, counted once however many threads wait: the engine's cell limit counts compute
# only, so the coding tools' time_left leaves it out too. Approvals and fetches count as waiting, like sub-calls.
_waiting = {"calls": 0, "since": 0.0, "total": 0.0}
_waiting_lock = threading.Lock()

_link = {"out": None, "diag": 2, "next_id": 0}
_send_lock = threading.Lock()
_pending: dict = {}  # request id -> [threading.Event, reply]
_pending_lock = threading.Lock()
_inbox: queue.Queue = queue.Queue()  # init and cell messages, for the main thread; None at EOF
_namespace: dict = {}  # the cell globals, once init has built them (the reader thread answers `vars` from it)


def _bridge_seconds() -> float:
    with _waiting_lock:
        return _waiting["total"] + (time.monotonic() - _waiting["since"] if _waiting["calls"] else 0.0)


def _send(message: dict) -> None:
    data = (json.dumps(message) + "\n").encode()
    with _send_lock:
        while data:
            data = data[os.write(_link["out"], data):]


def _diag(text: str) -> None:
    try:
        os.write(_link["diag"], (text + "\n").encode("utf-8", "replace"))
    except OSError:
        pass


def _repl_line():
    """The line of the innermost <repl> frame on the calling thread, or None outside a cell's code."""
    frame = sys._getframe(1)
    while frame is not None:
        if frame.f_code.co_filename == "<repl>":
            return frame.f_lineno
        frame = frame.f_back
    return None


def _request(op: str, **fields) -> dict:
    """One request to the engine, from any thread; blocks until its reply. Raises RuntimeError on an error reply."""
    slot = [threading.Event(), None]
    with _pending_lock:
        _link["next_id"] += 1
        request_id = _link["next_id"]
        _pending[request_id] = slot
    message = {"type": "request", "id": request_id, "op": op, "line": _repl_line(), **fields}
    with _waiting_lock:
        if not _waiting["calls"]:
            _waiting["since"] = time.monotonic()
        _waiting["calls"] += 1
    try:
        _send(message)
        slot[0].wait()
    except OSError:  # the engine is gone; the reader thread is about to end the process
        slot[1] = {"error": "the engine closed the connection"}
    finally:
        with _waiting_lock:
            _waiting["calls"] -= 1
            if not _waiting["calls"]:
                _waiting["total"] += time.monotonic() - _waiting["since"]
        with _pending_lock:
            _pending.pop(request_id, None)
    reply = slot[1]
    if "error" in reply:
        raise RuntimeError(reply["error"])
    return reply


def _approve(kind: str, detail: str, inside_workspace: bool) -> None:
    """Ask the engine for a guarded action (hooks.py, tools.shell, tools.fetch); a denial raises PermissionError."""
    if not _request("approve", kind=kind, detail=detail, inside_workspace=inside_workspace).get("allow"):
        raise PermissionError(13, "Permission denied (not approved)", detail)


def _remote_fetch(url: str) -> str:
    """tools.fetch's GET, made by the engine (D-16): the worker opens no connection."""
    return _request("fetch", url=url)["text"]


def _bridge(op: str, prompts: list) -> list:
    """One sub-call request to the engine, which enforces the budget."""
    return _request(op, prompts=prompts)["outputs"]


_SUBCALLS = {"max_chars": SUBCALL_MAX_CHARS, "oversize": "truncate"}


def _set_subcall_limits(max_chars, oversize) -> None:
    """The run's sub-call limits, from `init` (training read them from the episode's subcalls.json)."""
    if isinstance(max_chars, int) and not isinstance(max_chars, bool) and max_chars > 0:
        _SUBCALLS["max_chars"] = max_chars
    if oversize in ("truncate", "error"):
        _SUBCALLS["oversize"] = oversize


def _truncate(prompt: str) -> str:
    limit = _SUBCALLS["max_chars"]
    if len(prompt) > limit:
        if _SUBCALLS["oversize"] == "error":
            raise ValueError(f"sub-call prompt is {len(prompt):,} characters; one sub-call reads at most {limit:,}. "
                             "Split the input into smaller prompts (llm_batch runs them in parallel).")
        return prompt[:limit] + "\n" + SUBCALL_TRUNCATION_MARK
    return prompt


def llm(prompt: str) -> str:
    """Ask a language model one question. The task's prompt says how much it reads per call."""
    return _bridge("llm", [_truncate(str(prompt))])[0]


def llm_batch(prompts: list[str]) -> list[str]:
    """Ask several prompts in parallel; each prompt counts as one sub-call. Outputs come back in input order."""
    if isinstance(prompts, (str, bytes)):
        raise TypeError("llm_batch expects a list of prompts, not a single string")
    return _bridge("llm_batch", [_truncate(str(p)) for p in prompts])


def _plain(value):
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        return float(value) if math.isfinite(value) else None
    if isinstance(value, str):
        return str(value)
    return None


def normalize_answer(answer):
    """int, float and str pass through; a list, tuple or set becomes a list of those; anything else becomes str()."""
    plain = _plain(answer)
    if plain is not None:
        return plain
    if isinstance(answer, (list, tuple, set, frozenset)):
        items = [str(v) if _plain(v) is None else _plain(v) for v in answer]
        if isinstance(answer, (set, frozenset)):
            items.sort(key=lambda v: (type(v).__name__, str(v)))
        return items
    return str(answer)


def submit(answer) -> None:
    """Give your final answer and end the episode."""
    value = normalize_answer(answer)
    size = len(json.dumps(value))
    if size > SUBMIT_MAX_BYTES:
        raise ValueError(f"answer too large ({size:,} characters as JSON; the limit is {SUBMIT_MAX_BYTES:,})")
    _state["submitted"] = True
    _state["answer"] = value


def make_namespace(context: str) -> dict:
    return {"context": context, "llm": llm, "llm_batch": llm_batch, "submit": submit, "fetch": tools.fetch,
            "__name__": "__repl__"}


# ----------------------------------------------------------------------------- cells


class _Capped(io.TextIOBase):
    """A stdout stand-in that keeps the first `cap` characters and counts the rest."""

    def __init__(self, cap: int):
        self.cap, self.total, self._parts, self._kept = cap, 0, [], 0
        self._lock = threading.Lock()  # the fd pump writes from another thread

    @property
    def encoding(self):
        return "utf-8"

    def writable(self):
        return True

    def write(self, s):
        if not isinstance(s, str):
            raise TypeError(f"write() argument must be str, not {type(s).__name__}")
        with self._lock:
            self.total += len(s)
            if self._kept < self.cap:
                piece = s[: self.cap - self._kept]
                self._parts.append(piece)
                self._kept += len(piece)
        return len(s)

    def getvalue(self) -> str:
        with self._lock:
            return "".join(self._parts)


class _FdCapture:
    """During a cell, fds 1 and 2 are a pipe whose output goes to the cell's stdout, so programs the model runs
    without capturing their output still show it. A program left running in the background keeps the pipe open;
    its later output is dropped, since the cell is over."""

    DRAIN_S = 0.5

    def __init__(self, sink: "_Capped"):
        self._sink = sink
        try:
            os.fstat(0)
        except OSError:  # a cell closed fd 0; the pipe must not take its place
            _point_at_null((0,))
        read_fd, write_fd = os.pipe()
        self._read_fd = read_fd
        os.dup2(write_fd, 1)
        os.dup2(write_fd, 2)
        os.close(write_fd)
        self._thread = threading.Thread(target=self._pump, name="rlm-fd-capture", daemon=True)
        self._thread.start()

    def _pump(self) -> None:
        import codecs

        hooks.exempt_thread()
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                data = os.read(self._read_fd, 65536)
                if not data:
                    break
                text = decoder.decode(data)
                sink = self._sink
                if sink is not None and text:
                    sink.write(text)
        except OSError:
            pass
        finally:
            try:
                os.close(self._read_fd)
            except OSError:
                pass

    def stop(self) -> None:
        _point_at_null((1, 2))
        self._thread.join(self.DRAIN_S)  # every writer that exited has closed its end; a background one may not have
        self._sink = None


def _point_at_null(fds: tuple) -> None:
    """Point each fd at the null device. When a cell closed one of them, os.open hands it back: keep that one open."""
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in fds:
        if fd != devnull:
            os.dup2(devnull, fd)
    if devnull not in fds:
        os.close(devnull)


def _format_error(exc: BaseException) -> str:
    tb = exc.__traceback__.tb_next if exc.__traceback__ is not None else None  # drop the worker's own frame
    lines = "".join(traceback.format_exception(type(exc), exc, tb)).splitlines()
    text = "\n".join(lines[-TRACEBACK_LINES:])
    if len(text) > OUTPUT_MAX_CHARS:
        text = text[:OUTPUT_MAX_CHARS] + f"\n[... {len(text) - OUTPUT_MAX_CHARS} more characters truncated]"
    return text


_cell = {"timeout": None, "start": 0.0, "bridge_at_start": 0.0}


def cell_seconds_left() -> float:
    """Compute seconds left in the running cell (time waiting on the engine doesn't count, as on the host)."""
    if not _cell["timeout"]:
        return float("inf")
    used = time.monotonic() - _cell["start"] - (_bridge_seconds() - _cell["bridge_at_start"])
    return _cell["timeout"] - used


def run_cell(code: str, namespace: dict) -> dict:
    _state["submitted"], _state["answer"] = False, None
    _cell["start"], _cell["bridge_at_start"] = time.monotonic(), _bridge_seconds()
    out, err = _Capped(OUTPUT_MAX_CHARS), _Capped(STDERR_KEEP_CHARS)
    capture = _FdCapture(out)
    error = None
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(code, "<repl>", "exec"), namespace)
    except BaseException as exc:
        error = _format_error(exc)
    finally:
        capture.stop()
    return {
        "stdout": out.getvalue(),
        "stdout_chars": out.total,
        "stderr": err.getvalue(),
        "error": error,
        "submitted": _state["submitted"],
        "answer": _state["answer"],
        "threads": threading.active_count() - 2,  # the main thread and the reader
    }


# ----------------------------------------------------------------------------- the link


def _var_info(name: str, value) -> dict:
    try:
        length = len(value)
    except Exception:
        length = None
    try:
        chars = min(len(repr(value)), VARS_REPR_MAX)
    except Exception:
        chars = 0
    return {"name": name, "type": type(value).__name__, "len": length if isinstance(length, int) else None,
            "chars": chars}


def _vars() -> list:
    """The user's globals: not the API, the tools, or names starting with an underscore."""
    for _ in range(3):
        try:
            items = list(_namespace.items())
            break
        except RuntimeError:  # the cell changed its globals mid-copy
            continue
    else:
        return []
    return [_var_info(name, value) for name, value in items
            if isinstance(name, str) and not name.startswith("_") and name not in HIDDEN_NAMES]


def _read_engine(proto_in) -> None:
    """The reader thread: replies wake their requests, `vars` is answered here, init and cells go to the main thread."""
    hooks.exempt_thread()
    try:
        for line in proto_in:
            try:
                message = json.loads(line)
            except ValueError:
                _diag(f"unreadable message from the engine: {line[:200]!r}")
                continue
            if not isinstance(message, dict):
                continue
            kind = message.get("type")
            if kind == "reply":
                with _pending_lock:
                    slot = _pending.get(message.get("id"))
                if slot is not None:
                    slot[1] = message
                    slot[0].set()
            elif kind == "vars":
                _send({"type": "vars", "id": message.get("id"), "vars": _vars()})
            elif kind in ("init", "cell"):
                _inbox.put(message)
    except Exception as exc:
        _diag(f"reader thread failed: {exc!r}")
    with _pending_lock:
        waiting = list(_pending.values())
    for slot in waiting:
        slot[1] = {"error": "the engine closed the connection"}
        slot[0].set()
    os._exit(0)


def _start(message: dict) -> dict:
    """`init`: move into the workspace, set up the tools and the hook, and build the cell globals."""
    repo = message.get("mode") == "repo"
    workspace, scratch = message["workspace"], message["scratch"]
    os.chdir(workspace)
    _cell["timeout"] = message.get("cell_timeout_s")
    _set_subcall_limits(message.get("subcall_max_chars"), message.get("subcall_oversize"))
    tools.configure(root=workspace, base=message.get("base_tree"), time_left=cell_seconds_left, scratch=scratch,
                    shell=message.get("shell"), alias=message.get("repo_alias"), approve=_approve,
                    remote_fetch=_remote_fetch)
    namespace = make_namespace(message["context"])
    if repo:
        namespace.update(tools.namespace())
    hooks.install(approve=_approve, workspace=workspace, scratch=scratch, tools=tools)
    _namespace.update(namespace)
    return _namespace


def repl_main() -> None:
    """The worker process: move the protocol to private descriptors, then run cells until the engine closes stdin."""
    # Model code that reads stdin gets EOF, and raw writes to fd 1 or 2 land in the cell output or the null device
    # instead of corrupting a message.
    proto_in = os.fdopen(os.dup(0), "rb")
    _link["out"] = os.dup(1)
    _link["diag"] = os.dup(2)
    if sys.platform == "win32":
        import msvcrt

        for fd in (proto_in.fileno(), _link["out"], _link["diag"]):
            msvcrt.setmode(fd, os.O_BINARY)
    _point_at_null((0, 1, 2))
    sys.stdin = io.StringIO()
    threading.Thread(target=_read_engine, args=(proto_in,), name="rlm-reader", daemon=True).start()

    message = _inbox.get()
    if message is None or message.get("type") != "init":
        _diag("expected init first")
        os._exit(2)
    try:
        namespace = _start(message)
    except Exception as exc:
        _diag(f"init failed: {exc!r}")
        os._exit(3)
    _send({"type": "ready", "python": sys.version.split()[0],
           "tools": tools.TOOLS_VERSION if message.get("mode") == "repo" else None})

    while True:
        message = _inbox.get()
        if message is None:
            os._exit(0)
        code = message.get("code")
        if message.get("type") != "cell" or not isinstance(code, str):
            _send({"type": "protocol_error", "error": "expected {\"type\": \"cell\", \"id\": ..., \"code\": ...}"})
            continue
        _send({"type": "result", "id": message.get("id"), **run_cell(code, namespace)})


if __name__ == "__main__":
    repl_main()
