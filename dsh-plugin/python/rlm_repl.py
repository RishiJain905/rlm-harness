# KV cache: none (the REPL's output is returned as a run_code result, appended after the cached prefix)
"""The persistent Python REPL behind RLM mode's run_code (dsh-plugin/lib/rlm-runtime.js), one process per dsh agent.

Protocol: JSON lines. The host writes to our stdin and reads our stdout, but at start-up both move to private,
non-inheritable descriptors and fds 0, 1 and 2 point at the null device (as rlmh's worker does, worker.py
repl_main), so model code that reads stdin gets EOF and anything a cell or its child processes write to fd 1 or 2
lands in the cell's output instead of corrupting a frame.

Host -> REPL: {"t": "run", "program", "cwd", "bindings": [{"global", "names", "errorClass"}], "cap"}
              {"t": "reply", "cid", "value" | "error"}      an answer to a call or llm frame
              {"t": "interrupt"}                             stop the running cell (KeyboardInterrupt)
REPL -> host: {"t": "call", "cid", "global", "name", "args"} a dsh tool call (awaited)
              {"t": "llm", "cid", "prompts"}                 sub-calls (llm, llm_batch; blocking)
              {"t": "done", "output", "total", "value", "error"}
Standard library only. Runs under -I.
"""
import _thread
import ast
import asyncio
import inspect
import io
import json
import os
import queue
import sys
import threading
import traceback

TRACEBACK_LINES = 20

_out_fd = None  # private protocol descriptor
_out_lock = threading.Lock()
_runs = queue.Queue()
_waiters = {}  # cid -> ("future", (loop, fut)) | ("event", [event, frame])
_waiters_lock = threading.Lock()
_next = [0]
_closed = threading.Event()  # the host closed our input: every pending wait fails
_running = threading.Event()  # a cell is executing (an interrupt only applies then)


def send(frame):
    data = (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
    with _out_lock:
        view = memoryview(data)
        while view:
            n = os.write(_out_fd, view)
            view = view[n:]


def _new_waiter(kind, obj):
    with _waiters_lock:
        if _closed.is_set():
            raise RuntimeError("the RLM runtime closed this REPL")
        _next[0] += 1
        cid = _next[0]
        _waiters[cid] = (kind, obj)
        return cid


def _deliver(kind, obj, frame):
    if kind == "future":
        loop, fut = obj
        loop.call_soon_threadsafe(_settle, fut, frame)
    else:
        obj[1] = frame
        obj[0].set()


def _settle(fut, frame):
    if not fut.done():
        fut.set_result(frame)


def _reader(stream):
    for line in stream:
        try:
            f = json.loads(line)
        except ValueError:
            continue
        t = f.get("t") if isinstance(f, dict) else None
        if t == "run":
            _runs.put(f)
        elif t == "reply":
            with _waiters_lock:
                w = _waiters.pop(f.get("cid"), None)
            if w is not None:
                _deliver(w[0], w[1], f)
        elif t == "interrupt":
            if _running.is_set():
                # Wake anything the cell waits on (a tool call, a sub-call), then stop it.
                with _waiters_lock:
                    pending = list(_waiters.values())
                    _waiters.clear()
                for kind, obj in pending:
                    _deliver(kind, obj, {"error": "run_code was stopped"})
                _thread.interrupt_main()
    # Input closed: the host is gone or released us. Fail every pending wait so nothing hangs, then stop.
    with _waiters_lock:
        _closed.set()
        pending = list(_waiters.values())
        _waiters.clear()
    for kind, obj in pending:
        _deliver(kind, obj, {"error": "the RLM runtime closed this REPL"})
    _runs.put(None)


class Obj(dict):
    """A tool result: a plain dict that also reads its keys as attributes (r.lines and r["lines"] both work)."""

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(name) from None


def _wrap(value):
    if isinstance(value, dict):
        return Obj((k, _wrap(v)) for k, v in value.items())
    if isinstance(value, list):
        return [_wrap(v) for v in value]
    return value


class Namespace:
    """`tools`: every dsh tool as an awaitable function, `await tools.read({...})` or `await tools["name"]({...})`."""

    def __init__(self, glob, names, error_cls):
        self._glob, self._names, self._err = glob, frozenset(names), error_cls

    def _fn(self, name):
        if name not in self._names:
            raise AttributeError(f"{self._glob} has no function {name!r}")
        glob, err = self._glob, self._err

        async def call(args=None):
            loop = asyncio.get_running_loop()
            fut = loop.create_future()
            cid = _new_waiter("future", (loop, fut))
            send({"t": "call", "cid": cid, "global": glob, "name": name, "args": {} if args is None else args})
            f = await fut
            if "error" in f:
                e = err(f["error"])
                e.toolName = name
                raise e
            return _wrap(f.get("value"))

        call.__name__ = name
        return call

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return self._fn(name)

    def __getitem__(self, name):
        return self._fn(name)

    def __dir__(self):
        return sorted(self._names)


def _blocking(frame):
    box = [threading.Event(), None]
    cid = _new_waiter("event", box)
    frame["cid"] = cid
    send(frame)
    while not box[0].wait(0.25):  # short waits, so an interrupt is seen on Windows too
        pass
    f = box[1]
    if "error" in f:
        raise RuntimeError(f["error"])
    return f["value"]


def llm(prompt):
    """One sub-call to a language model; returns its reply text."""
    return _blocking({"t": "llm", "prompts": [str(prompt)]})[0]


def llm_batch(prompts):
    """Many sub-calls run concurrently; replies come back in order."""
    prompts = [str(p) for p in prompts]
    return _blocking({"t": "llm", "prompts": prompts}) if prompts else []


class _Capped(io.TextIOBase):
    """A cell's output: keeps the first `cap` characters and counts the rest."""

    def __init__(self, cap):
        self.cap, self.total = cap, 0
        self._parts, self._kept = [], 0
        self._lock = threading.Lock()

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

    def getvalue(self):
        with self._lock:
            return "".join(self._parts)


def _point_at_null(fds):
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in fds:
        if fd != devnull:
            os.dup2(devnull, fd)
    if devnull not in fds:
        os.close(devnull)


class _FdCapture:
    """During a cell, fds 1 and 2 are a pipe into the cell's output, so a subprocess's or os.write's output shows."""

    def __init__(self, sink):
        self._sink = sink
        read_fd, write_fd = os.pipe()
        self._read_fd = read_fd
        os.dup2(write_fd, 1)
        os.dup2(write_fd, 2)
        os.close(write_fd)
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()

    def _pump(self):
        import codecs

        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        try:
            while True:
                data = os.read(self._read_fd, 65536)
                if not data:
                    break
                text = decoder.decode(data)
                if self._sink is not None and text:
                    self._sink.write(text)
        except OSError:
            pass
        finally:
            try:
                os.close(self._read_fd)
            except OSError:
                pass

    def stop(self):
        _point_at_null((1, 2))
        self._thread.join(0.5)  # a background writer that outlives the cell keeps the pipe open; its output is dropped
        self._sink = None


NS = {"__name__": "__main__", "__builtins__": __builtins__, "llm": llm, "llm_batch": llm_batch}
FLAGS = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT


def _format_error(exc):
    tb = exc.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != "<run_code>":
        tb = tb.tb_next  # drop the REPL's own frames
    lines = "".join(traceback.format_exception(type(exc), exc, tb)).splitlines()
    return "\n".join(lines[-TRACEBACK_LINES:])


def _bind(bindings):
    for b in bindings or []:
        ec = b.get("errorClass") or {}
        name = ec.get("name") or "ToolCallError"
        err = NS.get(name)
        if not (isinstance(err, type) and issubclass(err, Exception)):
            err = type(name, (Exception,), {"toolName": ""})
            NS[name] = err
        NS[b["global"]] = Namespace(b["global"], b.get("names") or [], err)


def execute(loop, f):
    try:
        os.chdir(f.get("cwd") or os.getcwd())
    except OSError:
        pass
    _bind(f.get("bindings"))
    sink = _Capped(int(f.get("cap") or 1_000_000))
    sys.stdout = sys.stderr = sink
    fds = _FdCapture(sink)
    value, error = None, None
    _running.set()
    try:
        tree = ast.parse(f["program"], "<run_code>", "exec")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        codes = [compile(tree, "<run_code>", "exec", flags=FLAGS)]
        if last is not None:
            codes.append(compile(ast.Expression(last.value), "<run_code>", "eval", flags=FLAGS))
        for code in codes:
            r = eval(code, NS)
            if inspect.iscoroutine(r):
                r = loop.run_until_complete(r)
            value = r
        if value is not None:
            try:
                json.dumps(value)
            except (TypeError, ValueError):
                sink.write(repr(value) + "\n")
                value = None
    except KeyboardInterrupt:
        error = "KeyboardInterrupt: run_code was stopped (timeout or cancel). Variables are kept."
    except BaseException as exc:  # SystemExit too: a cell can't end the REPL
        error = _format_error(exc)
    finally:
        _running.clear()
        fds.stop()
        sys.stdout = sys.stderr = io.StringIO()
    send({"t": "done", "output": sink.getvalue(), "total": sink.total, "value": value, "error": error})


def main():
    global _out_fd
    proto_in = os.fdopen(os.dup(0), "rb")
    _out_fd = os.dup(1)
    if sys.platform == "win32":
        import msvcrt

        for fd in (proto_in.fileno(), _out_fd):
            msvcrt.setmode(fd, os.O_BINARY)
    _point_at_null((0, 1, 2))
    sys.stdin = io.StringIO()
    sys.stdout = sys.stderr = io.StringIO()
    threading.Thread(target=_reader, args=(io.TextIOWrapper(proto_in, encoding="utf-8"),), daemon=True).start()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    while True:
        f = _runs.get()
        if f is None:
            return
        try:
            execute(loop, f)
        except KeyboardInterrupt:  # an interrupt that landed between cells
            continue


if __name__ == "__main__":
    main()
