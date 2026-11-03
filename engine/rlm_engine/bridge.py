"""KV cache: none

The sub-call bridge, between the worker and the app. Source: training's `rlm_rl/bridge.py` `EpisodeBridge`
(`_handle`, `_one`) at commit 0b9af69, with the order of checks and the error strings unchanged. The Unix socket is
gone: `handle` takes a worker `request` (architecture §6.1) and returns the `reply` fields.

It enforces the sub-call budget and the prompt-size rule, sends each sub-call to the app as `model.complete` (§5.2),
reports `run.subcall` and `run.budget` (§5.3), makes `fetch` GET requests for the worker (D-16), and hands `approve`
requests to `Permissions`. Nothing the worker sends can set `infra_error`: only a failure on this side does. Under
agent_api, `rlm` requests go to `children` (child.py, D-160), whose child runs use this bridge's budget: each child is
one sub-call, and its own sub-calls come through `_llm` with `child` set.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import http.client
import socket
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any
from urllib.parse import urldefrag, urljoin, urlsplit

from . import contract
from .appport import AppPort
from .errors import InfraError, ModelError, SubcallError
from .permissions import KINDS, Permissions
from .profiles import Profile

OPS = ("llm", "llm_batch", "fetch", "approve", "rlm")
THINKING = ("off", "minimal", "low", "medium", "high", "xhigh", "max")  # a request's own thinking level for its sub-calls (D-164, D-250)
INFRA_REPLY = "sub-call failed for an infrastructure reason; this episode will be discarded"
PREFIX_SEPARATOR = "\n\n"  # cacheapi.SEPARATOR: between a sub-call's stable prefix and its prompt (D-119)

# fetch (D-16). Module-level, so tests can patch them.
FETCH_TIMEOUT_S = 30
FETCH_MAX_CHARS = 200_000
FETCH_MAX_REDIRECTS = 5
_REDIRECT_CODES = (301, 302, 303, 307, 308)
_READ_CHUNK = 64 * 1024


@dataclass
class SubcallRecord:
    subcall_id: int
    origin: dict
    batch: dict
    prompt: str  # as sent: cleaned, and cut when it was over the limit
    output: str | None
    error: str | None
    seconds: float
    usage: dict | None


class Bridge:
    def __init__(
        self,
        *,
        run_id: str,
        app: AppPort,
        profile: Profile,
        mode: str,
        sub_ref: dict,
        permissions: Permissions,
    ) -> None:
        self.run_id = run_id
        self.app = app
        self.profile = profile
        self.mode = mode
        self.sub_ref = sub_ref
        self.permissions = permissions
        self.limits = profile.mode(mode).limits
        self.max_subcalls = self.limits.max_subcalls
        self.turn = 0  # set by the loop before each cell
        self.subcalls_used = 0  # ids count across a conversation's prompts, so each stays unique in the run (D-199)
        self.records: list[SubcallRecord] = []
        self.fetches: list[dict] = []  # {url, status, chars, error, seconds}, one per fetch call
        self.prompt_base = 0  # subcalls_used when this prompt started: budgets count from here (v1 step 4)
        self.fetch_base = 0  # len(fetches) when this prompt started
        self._record_base = 0  # len(records) when this prompt started
        self.infra_error: str | None = None
        self.infra_kind: str | None = None
        self.children: Any = None  # child.Children under agent_api (D-160); None refuses `rlm`
        self._batches = 0

    def start_prompt(self) -> None:
        """A conversation's next prompt (v1 step 4): the sub-call budget starts over, the ids go on counting."""
        self.prompt_base = self.subcalls_used
        self.fetch_base = len(self.fetches)
        self._record_base = len(self.records)

    def prompt_used(self) -> int:
        """The sub-call ids this prompt has taken."""
        return self.subcalls_used - self.prompt_base

    def subcalls_left(self) -> int:
        return max(0, self.max_subcalls - self.prompt_used())

    def prompt_records(self) -> list[SubcallRecord]:
        """This prompt's sub-call records, by id. A record lands when its call ends, so this is every record that
        arrived since `start_prompt`: the prompt's own, plus a call an earlier prompt left running (D-203), which
        would otherwise be in no record at all (D-246)."""
        return sorted(self.records[self._record_base:], key=lambda r: r.subcall_id)

    async def handle(self, request: dict) -> dict:
        """The reply fields for a worker `request`, or an `InfraError` (after `infra_error` and `infra_kind` are set)."""
        if not isinstance(request, dict) or request.get("op") not in OPS:
            return {"error": "unknown request"}
        op = request["op"]
        if op == "fetch":
            return await self._fetch(request)
        if op == "approve":
            return await self._approve(request)
        if op == "rlm":
            if self.children is None:
                return {"error": "unknown request"}
            return await self.children.run(request, None)
        return await self._llm(op, request)

    # ------------------------------------------------------------------------------------------ llm, llm_batch

    async def _llm(self, op: str, request: dict, child: Any = None) -> dict:
        """llm and llm_batch, from the run's worker or (with `child`, a child.ChildRun) from a child run's worker."""
        prompts = request.get("prompts")
        if not isinstance(prompts, list) or not all(isinstance(p, str) for p in prompts):
            return {"error": "prompts must be a list of strings"}
        if op == "llm" and len(prompts) != 1:
            return {"error": "llm takes exactly one prompt"}
        thinking = request.get("thinking")  # agentapi's thinking= (D-164); training's requests have none
        if thinking is not None and thinking not in THINKING:
            return {"error": f"thinking must be one of {', '.join(THINKING)}"}
        prefixes = request.get("prefixes")  # cache-shaped sub-calls (D-119); training's requests have none
        if prefixes is None:
            prefixes = [None] * len(prompts)
        elif not (isinstance(prefixes, list) and len(prefixes) == len(prompts)
                  and all(p is None or isinstance(p, str) for p in prefixes)):
            return {"error": "prefixes must be a list of strings or nulls, one per prompt"}
        if self.infra_error:
            return {"error": INFRA_REPLY}
        if self.prompt_used() + len(prompts) > self.max_subcalls:
            return self._reject(prompts, request, contract.budget_exhausted_message(self.max_subcalls), child)
        if self.limits.subcall_oversize == "error":
            longest = max((len(_joined(prefix, p)) for prefix, p in zip(prefixes, prompts)), default=0)
            if longest > self.limits.subcall_max_chars:
                return self._reject(prompts, request, contract.oversize_message(longest, self.limits.subcall_max_chars),
                                    child)
        if not prompts:
            return {"outputs": []}

        # Allocate ids in one synchronous step: no await between the budget check and the increment, so threads in
        # one cell can't oversubscribe the budget.
        n = len(prompts)
        first_id = self.subcalls_used + 1
        self.subcalls_used += n
        batch_id = self._next_batch_id()
        origin = self._origin(request, child)

        tasks = [
            asyncio.ensure_future(
                self._one(first_id + i, prompt, origin, {"id": batch_id, "index": i, "size": n}, prefixes[i], thinking))
            for i, prompt in enumerate(prompts)
        ]
        results = await self._settle(tasks)
        self.app.event(
            "run.budget",
            {
                "run_id": self.run_id,
                "turns_left": max(0, self.limits.max_turns - self.turn),
                "subcalls_left": self.subcalls_left(),
            },
        )

        # D-06: a bad_request is the model's to see; anything else stops the run, and infra wins in a mixed batch.
        for result in results:
            if _fatal(result):
                kind, message = _infra_of(result)
                raise InfraError(self.infra_kind or kind, self.infra_error or message)
        for result in results:
            if isinstance(result, SubcallError):
                return {"error": f"sub-call failed: {result.message}"}
        return {"outputs": results}

    async def _settle(self, tasks: list[asyncio.Future]) -> list[Any]:
        """Each sub-call's text or exception, in prompt order. The first fatal failure to arrive stops the run at
        once: it sets `infra_error`, the calls still going are cancelled (each still ends with its record and event),
        and the app is told to drop the run's queued and in-flight calls, so nothing more is paid for. A cancelled
        request cancels every call it made."""
        pending = set(tasks)
        try:
            while pending:
                done, pending = await asyncio.wait(pending, return_when=asyncio.FIRST_COMPLETED)
                fatal = [t for t in tasks if t in done and _fatal(_outcome(t))]
                if fatal and self.infra_error is None:
                    self.infra_kind, self.infra_error = _infra_of(_outcome(fatal[0]))
                if fatal and pending:
                    for task in pending:
                        task.cancel()
                    self.app.cancel_calls(self.run_id)
                    await asyncio.wait(pending)
                    pending = set()
        except asyncio.CancelledError:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            raise
        return [_outcome(t) for t in tasks]

    def _reject(self, prompts: list[str], request: dict, message: str, child: Any = None) -> dict:
        """A refused request: one `rejected` event, no model call, no sub-call ids used."""
        batch = {"id": self._next_batch_id(), "index": 0, "size": len(prompts)}
        longest = max((len(p) for p in prompts), default=0)
        self._subcall_event(None, self._origin(request, child), batch, longest, "rejected", message, 0.0)
        return {"error": message}

    # ------------------------------------------------------------------------------------------ rlm children

    def reserve_child(self, request: dict, task: str, parent: Any, child_no: int) -> tuple[int, dict, dict] | dict:
        """One sub-call id for a child run (D-160): `(subcall_id, origin, batch)` with its `sent` event, or the
        reply fields of a refusal (an infra failure, or no sub-calls left)."""
        if self.infra_error:
            return {"error": INFRA_REPLY}
        if self.prompt_used() + 1 > self.max_subcalls:
            return self._reject([task], request, contract.budget_exhausted_message(self.max_subcalls), parent)
        self.subcalls_used += 1
        subcall_id = self.subcalls_used
        origin = self._origin(request, parent)
        batch = {"id": f"rlm{child_no}", "index": 0, "size": 1}
        self._subcall_event(subcall_id, origin, batch, len(task), "sent", None, None)
        return subcall_id, origin, batch

    def finish_child(self, record: SubcallRecord) -> None:
        """A child run's sub-call record and its `done` or `error` event, then the budget."""
        self.records.append(record)
        status = "error" if record.error is not None else "done"
        self._subcall_event(record.subcall_id, record.origin, record.batch, len(record.prompt), status, record.error,
                            record.seconds)
        self.app.event("run.budget", {"run_id": self.run_id, "turns_left": max(0, self.limits.max_turns - self.turn),
                                      "subcalls_left": self.subcalls_left()})

    async def _one(self, subcall_id: int, prompt: str, origin: dict, batch: dict, prefix: str | None = None,
                   thinking: str | None = None) -> str:
        if prefix is not None:
            prefix = contract.clean_text(prefix)
        prompt = contract.truncate_prompt(_joined(prefix, contract.clean_text(prompt)), self.limits.subcall_max_chars)
        params = {
            "run_id": self.run_id,
            "role": "sub",
            "model": dict(self.sub_ref),
            "messages": [{"role": "user", "content": prompt}],
            "tools": [],
            "max_tokens": self.limits.subcall_max_tokens,
            "temperature": self.profile.sub_temperature,
            "thinking": thinking or self.sub_ref.get("thinking") or self.limits.subcall_thinking or "off",
            "turn": self.turn,
            "subcall_id": subcall_id,
            "origin": dict(origin),
            "batch": dict(batch),
        }
        if prefix:  # the gateway marks and routes it for the provider's cache; the key is the same in every run
            # `chars` counts UTF-16 code units, the unit the app's strings index by: a character outside the BMP
            # (an emoji) is one code point here but two units there
            chars = _utf16_len(prefix) + _utf16_len(PREFIX_SEPARATOR)
            if chars < _utf16_len(prompt):
                params["prefix"] = {"chars": chars, "key": hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:16]}
        started = time.monotonic()
        self._subcall_event(subcall_id, origin, batch, len(prompt), "sent", None, None)
        usage: dict | None = None
        try:
            result = await self.app.complete(params)
            text = result.get("text") if isinstance(result, dict) else None
            usage = result.get("usage") if isinstance(result, dict) else None
            if not isinstance(text, str):
                raise _BadResult(f"sub-call returned {type(text).__name__}, not str")
        except BaseException as exc:
            seconds = time.monotonic() - started
            error = _error_text(exc)
            self.records.append(SubcallRecord(subcall_id, dict(origin), dict(batch), prompt, None, error, seconds, usage))
            self._subcall_event(subcall_id, origin, batch, len(prompt), "error", error, seconds)
            if isinstance(exc, ModelError) and exc.kind == "bad_request":
                raise SubcallError(exc.message) from None
            raise
        seconds = time.monotonic() - started
        self.records.append(SubcallRecord(subcall_id, dict(origin), dict(batch), prompt, text, None, seconds, usage))
        self._subcall_event(subcall_id, origin, batch, len(prompt), "done", None, seconds)
        return text

    def _next_batch_id(self) -> str:
        self._batches += 1
        return f"b{self._batches}"

    def _origin(self, request: dict, child: Any = None) -> dict:
        """Where a request came from: the turn and the cell line, plus `child` (the child run's number) for a request a
        child run's worker made, whose turn is then the child's own (D-160)."""
        line = request.get("line")
        turn = request.get("turn")  # the manager's, for a request an llm_async thread made in an earlier cell (D-159)
        if not isinstance(turn, int) or isinstance(turn, bool):
            turn = child.turn if child is not None else self.turn
        origin = {"turn": turn, "line": line if isinstance(line, int) and not isinstance(line, bool) else None}
        if child is not None:
            origin["child"] = child.child_id
        return origin

    def _subcall_event(
        self, subcall_id: int | None, origin: dict, batch: dict, prompt_chars: int, status: str, error: str | None,
        seconds: float | None,
    ) -> None:
        self.app.event(
            "run.subcall",
            {
                "run_id": self.run_id,
                "subcall_id": subcall_id,
                "origin": dict(origin),
                "batch": dict(batch),
                "prompt_chars": prompt_chars,
                "status": status,
                "error": error,
                "seconds": seconds,
            },
        )

    # ------------------------------------------------------------------------------------------ approve

    async def _approve(self, request: dict, permissions: Any = None) -> dict:
        """`permissions` is a child run's own (child.ReadOnly for rlm(tools="read")); else the run's."""
        kind, detail, inside = request.get("kind"), request.get("detail"), request.get("inside_workspace")
        if kind not in KINDS or not isinstance(detail, str) or not isinstance(inside, bool):
            return {"error": "malformed request"}
        permissions = permissions or self.permissions
        allowed = await permissions.check(kind, detail, inside_workspace=inside, turn=self.turn)
        if not allowed and getattr(permissions, "read_only", False) and kind != "network":
            return {"allow": False, "reason": "read-only"}
        if not allowed and not permissions.interactive:
            # D-154: say why, so the model stops trying actions that can never be approved in this run
            return {"allow": False, "reason": "unattended"}
        return {"allow": allowed}

    # ------------------------------------------------------------------------------------------ fetch

    async def _fetch(self, request: dict) -> dict:
        url = request.get("url")
        if not isinstance(url, str):
            return {"error": "malformed request"}
        started = time.monotonic()
        status: int | None = None
        text: str | None = None
        error: str | None = None
        owner = _Sockets()
        work = asyncio.ensure_future(asyncio.to_thread(_fetch_blocking, url, owner))
        work.add_done_callback(_consume)  # a fetch cut off by a cancel still ends, with nobody to read its error
        try:
            # shielded, so a cancel reaches the except below while the thread still runs, and closes its connection
            status, text = await asyncio.shield(work)
        except asyncio.CancelledError:
            owner.cut("cancelled")
            raise
        except _FetchFailed as exc:
            status, error = exc.status, f"fetch failed: {exc.message}"
        except Exception as exc:  # a bug in the fetch code must not kill the run
            error = f"fetch failed: {exc or type(exc).__name__}"
        self.fetches.append(
            {
                "url": url,
                "status": status,
                "chars": len(text) if text is not None else 0,  # what the model got, truncation note included
                "error": error,
                "seconds": time.monotonic() - started,
            }
        )
        return {"error": error} if error is not None else {"text": text}


# ---------------------------------------------------------------------------------------------- errors


def _utf16_len(text: str) -> int:
    """The length of `text` in UTF-16 code units (JavaScript's `string.length`)."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def _joined(prefix: str | None, prompt: str) -> str:
    """A cache-shaped sub-call's text: the stable prefix first, byte for byte, then the prompt (D-119)."""
    return prompt if prefix is None else prefix + PREFIX_SEPARATOR + prompt


class _BadResult(Exception):
    """`model.complete` answered with a text that is not a str: an infrastructure fault."""


def _outcome(task: asyncio.Future) -> Any:
    """A finished sub-call's text, or the exception it ended with (CancelledError included)."""
    if task.cancelled():
        return asyncio.CancelledError()
    return task.exception() or task.result()


def _fatal(outcome: Any) -> bool:
    """Whether a sub-call's outcome stops the run (D-06): any exception but a SubcallError (a bad_request)."""
    return isinstance(outcome, BaseException) and not isinstance(outcome, SubcallError)


def _infra_of(exc: BaseException) -> tuple[str, str]:
    """`(infra_kind, infra_error)` for a sub-call failure that stops the run (D-06)."""
    if isinstance(exc, ModelError):
        return exc.kind, f"sub-call failed: {exc.message}"
    if isinstance(exc, asyncio.CancelledError):
        return "cancelled", "sub-call cancelled"
    if isinstance(exc, _BadResult):
        return "other", str(exc)
    return "other", f"sub-call failed: {exc!r}"


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, ModelError):
        return exc.message
    if isinstance(exc, asyncio.CancelledError):
        return "cancelled"
    if isinstance(exc, _BadResult):
        return str(exc)
    return repr(exc)


# ---------------------------------------------------------------------------------------------- fetch


class _FetchFailed(Exception):
    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.status = status


class _NoRedirects(urllib.request.HTTPRedirectHandler):
    """Leaves a redirect as an HTTPError, so `_get` can apply the same-host rule itself."""

    def redirect_request(self, *args: Any, **kwargs: Any) -> None:
        return None


def _timed_out() -> _FetchFailed:
    return _FetchFailed(f"timed out after {FETCH_TIMEOUT_S:g} s")


class _Sockets:
    """Every socket one fetch opens, so another thread can cut them off: a watchdog at the deadline, or the run's
    cancellation. A cut shuts the socket down, which ends a read blocked on it at once, on every OS: as an error on
    Windows, as a clean end of file on Linux, so a reader that sees the end checks `reason` before trusting it."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._socks: list[socket.socket] = []
        self.reason: str | None = None  # "deadline" | "cancelled", once cut

    def track(self, sock: socket.socket) -> socket.socket:
        with self._lock:
            self._socks.append(sock)
            reason = self.reason
        if reason is not None:  # cut before this socket existed
            _shut(sock)
        return sock

    def cut(self, reason: str) -> None:
        with self._lock:
            if self.reason is None:
                self.reason = reason
            socks = list(self._socks)
        for sock in socks:
            _shut(sock)

    def check(self) -> None:
        if self.reason is not None:
            raise self.failure()

    def failure(self) -> _FetchFailed:
        return _timed_out() if self.reason == "deadline" else _FetchFailed("cancelled")

    def set_timeout(self, seconds: float) -> None:
        """The newest socket's timeout: the one the response being read arrives on."""
        with self._lock:
            sock = self._socks[-1] if self._socks else None
        if sock is not None:
            with contextlib.suppress(OSError, ValueError):
                sock.settimeout(seconds)


def _shut(sock: socket.socket) -> None:
    # socket.socket's own shutdown, past SSLSocket's, which would also drop its TLS state under a reading thread.
    # A socket TLS took over (detached) has no descriptor left, and fails here harmlessly.
    with contextlib.suppress(OSError, ValueError):
        socket.socket.shutdown(sock, socket.SHUT_RDWR)


def _owned(cls: type, owner: _Sockets) -> Any:
    """A factory for `cls` (HTTPConnection or HTTPSConnection) whose connections hand their sockets to `owner`: the
    plain socket as it is made, and the socket the connection reads (TLS's own) once it has connected."""

    def factory(host: str, **kwargs: Any) -> Any:
        conn = cls(host, **kwargs)
        create, connect = conn._create_connection, conn.connect

        def owned_connect() -> None:
            connect()
            owner.track(conn.sock)

        conn._create_connection = lambda *args, **kw: owner.track(create(*args, **kw))
        conn.connect = owned_connect
        return conn

    return factory


class _OwnedHTTP(urllib.request.HTTPHandler):
    def __init__(self, owner: _Sockets) -> None:
        super().__init__()
        self.owner = owner

    def http_open(self, req: Any) -> Any:
        return self.do_open(_owned(http.client.HTTPConnection, self.owner), req)


class _OwnedHTTPS(urllib.request.HTTPSHandler):
    def __init__(self, owner: _Sockets) -> None:
        super().__init__()
        self.owner = owner

    def https_open(self, req: Any) -> Any:
        return self.do_open(_owned(http.client.HTTPSConnection, self.owner), req, context=self._context)


def _consume(work: asyncio.Future) -> None:
    if not work.cancelled():
        work.exception()


def _fetch_blocking(url: str, owner: _Sockets | None = None) -> tuple[int, str]:
    """GET `url` on a worker thread: `(status, text)`, or `_FetchFailed`. The whole fetch, redirects included, has
    FETCH_TIMEOUT_S: each blocking read waits at most the time left, and a watchdog cuts the connection at the
    deadline, for the reads that time limit can't bound (a server that sends its headers a byte at a time)."""
    owner = owner if owner is not None else _Sockets()
    deadline = time.monotonic() + FETCH_TIMEOUT_S
    watchdog = threading.Timer(FETCH_TIMEOUT_S, owner.cut, ("deadline",))
    watchdog.daemon = True
    watchdog.start()
    try:
        return _get(url, owner, deadline)
    except _FetchFailed:
        raise
    except Exception as exc:
        if owner.reason is not None:  # the cut is why the read failed
            raise owner.failure() from None
        reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
        if isinstance(reason, TimeoutError) or time.monotonic() >= deadline:
            raise _timed_out() from None
        raise _FetchFailed(str(reason) or type(reason).__name__) from None
    finally:
        watchdog.cancel()


def _get(url: str, owner: _Sockets, deadline: float) -> tuple[int, str]:
    handlers: list[Any] = [_NoRedirects, _OwnedHTTP(owner)]
    if hasattr(http.client, "HTTPSConnection"):  # a Python without ssl has no https at all
        handlers.append(_OwnedHTTPS(owner))
    opener = urllib.request.build_opener(*handlers)
    host = _check_scheme(url)
    redirects = 0
    while True:
        owner.check()
        request = urllib.request.Request(url, method="GET", headers={"Accept-Encoding": "identity"})
        try:
            with opener.open(request, timeout=_remaining(deadline)) as response:
                body = _read_body(response, deadline, owner)
                return response.status, _cap(_decode(body, response.headers.get_content_charset()))
        except urllib.error.HTTPError as err:
            code, reason = err.code, err.reason
            location = err.headers.get("Location") if err.headers is not None else None
            err.close()
            if code not in _REDIRECT_CODES or not location:
                raise _FetchFailed(f"HTTP {code} {reason}".rstrip(), code) from None
        url = urldefrag(urljoin(url, location.strip()))[0]
        target = _check_scheme(url, redirect=True)
        if target != host:
            raise _FetchFailed(f"redirected to another host ({target}); call fetch on that URL to allow it")
        redirects += 1
        if redirects > FETCH_MAX_REDIRECTS:
            raise _FetchFailed(f"too many redirects (more than {FETCH_MAX_REDIRECTS})")


def _remaining(deadline: float) -> float:
    """Seconds left before `deadline`; a fetch with none left has timed out."""
    left = deadline - time.monotonic()
    if left <= 0:
        raise _timed_out()
    return left


def _check_scheme(url: str, redirect: bool = False) -> str:
    """The URL's host; fails for anything but http and https."""
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        if redirect:
            raise _FetchFailed(f"redirected to a URL that is not http:// or https:// ({url})")
        raise _FetchFailed("fetch takes an http:// or https:// URL")
    return parts.hostname or ""


def _read_body(response: Any, deadline: float, owner: _Sockets) -> bytes:
    """At most four bytes per allowed character (plus a few), so a decoded body over the cap is always seen as over.
    Each read waits at most the time left, because the headers may have used most of it."""
    limit = FETCH_MAX_CHARS * 4 + 4
    chunks: list[bytes] = []
    total = 0
    while total < limit:
        owner.set_timeout(_remaining(deadline))
        # read1 returns what has arrived; read(n) would wait for n bytes, and a slow trickle would outlast the deadline
        chunk = response.read1(min(_READ_CHUNK, limit - total))
        if not chunk:
            # On Linux a cut socket reads as a clean end of file, not an error: a cut body is not the whole body.
            owner.check()
            break
        chunks.append(chunk)
        total += len(chunk)
    return b"".join(chunks)


def _decode(body: bytes, charset: str | None) -> str:
    if charset:
        try:
            return body.decode(charset, errors="replace")
        except LookupError:
            pass
    return body.decode("utf-8", errors="replace")


def _cap(text: str) -> str:
    if len(text) > FETCH_MAX_CHARS:
        return text[:FETCH_MAX_CHARS] + f"\n[truncated at {FETCH_MAX_CHARS:,} characters]"
    return text
