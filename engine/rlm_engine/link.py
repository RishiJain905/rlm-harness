"""KV cache: none

The JSON-RPC 2.0 peer on the engine's stdin and stdout (architecture §3, §7.1).

One UTF-8 JSON object per line, with requests both ways. A daemon thread reads the input
and hands each line to the asyncio loop, because asyncio pipe reads are unreliable on
Windows (D-30). A writer thread drains a queue, so `notify` is safe from any thread and a
stalled app never blocks the loop. A bad line is answered with an error, never a crash.
"""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
from typing import Any, Awaitable, BinaryIO, Callable

log = logging.getLogger(__name__)

MAX_LINE_BYTES = 32 * 1024 * 1024
READ_CHUNK = 64 * 1024
DRAIN_TIMEOUT_S = 5.0

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603
MODEL_ERROR = -32001
UNKNOWN_RUN = -32010
UNKNOWN_PROFILE = -32011
BAD_INPUT = -32012
CANCELLED = -32800

Handler = Callable[[dict], Awaitable[Any]]

_EOF = object()
_TOO_LONG = object()


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Any = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data

    def to_json(self) -> dict:
        err: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.data is not None:
            err["data"] = self.data
        return err


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_id(value: Any) -> bool:
    return isinstance(value, str) or _is_int(value)


def classify(msg: Any) -> str:
    """Return "request", "notification", "result", "error" or "invalid" (link rule 3)."""
    if not isinstance(msg, dict):
        return "invalid"
    if "method" in msg:
        if not isinstance(msg["method"], str):
            return "invalid"
        if "id" not in msg:
            return "notification"
        return "request" if _is_id(msg["id"]) else "invalid"
    if "id" not in msg or not (msg["id"] is None or _is_id(msg["id"])):
        return "invalid"
    if ("result" in msg) == ("error" in msg):
        return "invalid"
    if "result" in msg:
        return "result"
    err = msg["error"]
    if isinstance(err, dict) and _is_int(err.get("code")) and isinstance(err.get("message"), str):
        return "error"
    return "invalid"


def _encode(msg: dict) -> bytes:
    """One line. A `str` holding a lone surrogate can't be UTF-8, so it goes out as ASCII escapes."""
    try:
        text = json.dumps(msg, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        return text.encode("utf-8") + b"\n"
    except UnicodeEncodeError:
        text = json.dumps(msg, ensure_ascii=True, allow_nan=False, separators=(",", ":"))
        return text.encode("ascii") + b"\n"


class Link:
    def __init__(self, reader: BinaryIO, writer: BinaryIO, *, max_line_bytes: int = MAX_LINE_BYTES) -> None:
        self._reader = reader
        self._writer = writer
        self._max = max_line_bytes
        self._methods: dict[str, Handler] = {}
        self._close_callbacks: list[Callable[[], Awaitable[None]]] = []
        self._pending: dict[str, asyncio.Future] = {}
        self._tasks: set[asyncio.Task] = set()
        self._notify_tail: asyncio.Task | None = None
        self._next_id = 0
        self._out: queue.SimpleQueue[bytes | None] = queue.SimpleQueue()
        self._closing = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._done: asyncio.Event | None = None
        self._writer_thread: threading.Thread | None = None

    # -- public API (§7.1) --

    def method(self, name: str, handler: Handler) -> None:
        """Serve requests and notifications for `name`. A later call replaces the handler."""
        self._methods[name] = handler

    def on_close(self, fn: Callable[[], Awaitable[None]]) -> None:
        self._close_callbacks.append(fn)

    async def request(self, method: str, params: dict) -> Any:
        """Send a request and wait for its answer. Raises RpcError, -32800 once the link closes."""
        if self._closing:
            raise RpcError(CANCELLED, "link closed")
        self._next_id += 1
        rid = f"e{self._next_id}"
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        try:
            self._put(_encode({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}))
            return await fut
        finally:
            self._pending.pop(rid, None)

    def notify(self, method: str, params: dict) -> None:
        """Safe from any thread. Dropped once the link is closed."""
        if not self._closing:
            self._put(_encode({"jsonrpc": "2.0", "method": method, "params": params}))

    async def serve(self) -> None:
        """Run until the input ends (or the output breaks), then close in order and return."""
        self._loop = asyncio.get_running_loop()
        self._done = asyncio.Event()
        threading.Thread(target=self._read_loop, name="link-reader", daemon=True).start()
        self._writer_thread = threading.Thread(target=self._write_loop, name="link-writer", daemon=True)
        self._writer_thread.start()
        await self._done.wait()
        await self._shutdown()

    # -- closing (link rule 8) --

    async def _shutdown(self) -> None:
        self._closing = True
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(RpcError(CANCELLED, "link closed"))
        for fn in self._close_callbacks:
            try:
                await fn()
            except Exception:
                log.exception("on_close callback failed")
        running = [t for t in self._tasks if not t.done()]
        for task in running:
            task.cancel()
        if running:
            await asyncio.wait(running, timeout=DRAIN_TIMEOUT_S)
        self._out.put(None)
        loop = asyncio.get_running_loop()
        deadline = loop.time() + DRAIN_TIMEOUT_S
        while self._writer_thread is not None and self._writer_thread.is_alive() and loop.time() < deadline:
            await asyncio.sleep(0.01)

    def _signal_done(self) -> None:
        try:
            self._loop.call_soon_threadsafe(self._done.set)
        except RuntimeError:  # the loop is already closed
            pass

    # -- threads --

    def _read_loop(self) -> None:
        read = getattr(self._reader, "read1", None) or self._reader.read
        buf = bytearray()
        dropping = False  # inside a line that went over the limit; skip to its \n
        try:
            while True:
                chunk = read(READ_CHUNK)
                if not chunk:
                    break
                start = 0
                while True:
                    nl = chunk.find(b"\n", start)
                    if not dropping:
                        buf += chunk[start : len(chunk) if nl < 0 else nl]
                        if len(buf) > self._max:
                            dropping = True
                            buf.clear()
                            self._deliver(_TOO_LONG)
                    if nl < 0:
                        break
                    if dropping:
                        dropping = False
                    else:
                        self._deliver(bytes(buf))
                        buf.clear()
                    start = nl + 1
        except (OSError, ValueError) as exc:
            log.warning("link input failed: %s", exc)
        if buf and not dropping:
            self._deliver(bytes(buf))
        self._deliver(_EOF)

    def _deliver(self, item: object) -> None:
        try:
            self._loop.call_soon_threadsafe(self._on_line, item)
        except RuntimeError:  # the loop is already closed
            pass

    def _write_loop(self) -> None:
        flush = getattr(self._writer, "flush", None)
        while True:
            data = self._out.get()
            if data is None:
                return
            try:
                view = memoryview(data)
                while view:  # a pipe write can be partial
                    view = view[self._writer.write(view) :]
                if flush is not None:
                    flush()
            except (OSError, ValueError) as exc:
                log.warning("link output closed (%s); closing the link", exc)
                self._signal_done()
                return

    def _put(self, data: bytes) -> None:
        if not self._closing:
            self._out.put(data)

    # -- incoming messages (on the loop) --

    def _on_line(self, item: object) -> None:
        if self._closing:
            return
        if item is _EOF:
            self._done.set()
            return
        if item is _TOO_LONG:
            self._send_error(None, INVALID_REQUEST, f"line too long (over {self._max} bytes)")
            return
        line = item
        if line.endswith(b"\r"):
            line = line[:-1]
        if not line.strip():
            return
        try:
            msg = json.loads(line.decode("utf-8"))
        except (ValueError, RecursionError) as exc:  # bad UTF-8 is a ValueError too
            self._send_error(None, PARSE_ERROR, f"parse error: {exc}")
            return
        kind = classify(msg)
        if kind == "request":
            self._on_request(msg)
        elif kind == "notification":
            self._on_notification(msg)
        elif kind in ("result", "error"):
            self._on_response(msg, kind)
        else:
            mid = msg.get("id") if isinstance(msg, dict) and _is_id(msg.get("id")) else None
            self._send_error(mid, INVALID_REQUEST, "invalid request")

    def _on_request(self, msg: dict) -> None:
        mid, name = msg["id"], msg["method"]
        handler = self._methods.get(name)
        if handler is None:
            self._send_error(mid, METHOD_NOT_FOUND, f"method not found: {name}")
            return
        params = msg.get("params", {})
        if not isinstance(params, dict):
            self._send_error(mid, INVALID_PARAMS, "params must be an object")
            return
        self._track(self._loop.create_task(self._run_request(mid, name, handler, params)))

    def _on_notification(self, msg: dict) -> None:
        name = msg["method"]
        handler = self._methods.get(name)
        params = msg.get("params", {})
        if handler is None or not isinstance(params, dict):
            log.warning("notification %s ignored (unknown method or bad params)", name)
            return
        task = self._loop.create_task(self._run_notification(self._notify_tail, name, handler, params))
        self._notify_tail = task
        self._track(task)

    def _on_response(self, msg: dict, kind: str) -> None:
        fut = self._pending.get(msg["id"])
        if fut is None or fut.done():
            return  # unknown, cancelled or already answered
        if kind == "result":
            fut.set_result(msg["result"])
        else:
            err = msg["error"]
            fut.set_exception(RpcError(err["code"], err["message"], err.get("data")))

    def _track(self, task: asyncio.Task) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _run_request(self, mid: Any, name: str, handler: Handler, params: dict) -> None:
        try:
            result = await handler(params)
        except RpcError as exc:
            self._respond(mid, "error", exc.to_json())
        except Exception as exc:
            log.exception("request %s failed", name)
            self._send_error(mid, INTERNAL_ERROR, f"internal error: {type(exc).__name__}: {exc}")
        else:
            self._respond(mid, "result", result)

    async def _run_notification(self, prev: asyncio.Task | None, name: str, handler: Handler, params: dict) -> None:
        if prev is not None and not prev.done():
            await asyncio.wait([prev])  # notifications run in arrival order
        try:
            await handler(params)
        except Exception:
            log.exception("notification %s failed", name)

    def _respond(self, mid: Any, key: str, value: Any) -> None:
        try:
            data = _encode({"jsonrpc": "2.0", "id": mid, key: value})
        except (TypeError, ValueError) as exc:  # not JSON: answer with an error instead
            log.error("answer to %r is not JSON: %s", mid, exc)
            data = _encode(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "error": {"code": INTERNAL_ERROR, "message": f"internal error: {type(exc).__name__}: {exc}"},
                }
            )
        self._put(data)

    def _send_error(self, mid: Any, code: int, message: str) -> None:
        self._put(_encode({"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}))
