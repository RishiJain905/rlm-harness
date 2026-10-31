"""KV cache: none

The sub-call bridge, between the worker and the app. Source: training's `rlm_rl/bridge.py` `EpisodeBridge`
(`_handle`, `_one`) at commit 0b9af69, with the order of checks and the error strings unchanged. The Unix socket is
gone: `handle` takes a worker `request` (architecture §6.1) and returns the `reply` fields.

It enforces the sub-call budget and the prompt-size rule, sends each sub-call to the app as `model.complete` (§5.2),
reports `run.subcall` and `run.budget` (§5.3), makes `fetch` GET requests for the worker (D-16), and hands `approve`
requests to `Permissions`. Nothing the worker sends can set `infra_error`: only a failure on this side does.
"""

from __future__ import annotations

import asyncio
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

OPS = ("llm", "llm_batch", "fetch", "approve")
INFRA_REPLY = "sub-call failed for an infrastructure reason; this episode will be discarded"

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
        self.subcalls_used = 0
        self.records: list[SubcallRecord] = []
        self.fetches: list[dict] = []  # {url, status, chars, error, seconds}, one per fetch call
        self.infra_error: str | None = None
        self.infra_kind: str | None = None
        self._batches = 0

    def subcalls_left(self) -> int:
        return max(0, self.max_subcalls - self.subcalls_used)

    async def handle(self, request: dict) -> dict:
        """The reply fields for a worker `request`, or an `InfraError` (after `infra_error` and `infra_kind` are set)."""
        if not isinstance(request, dict) or request.get("op") not in OPS:
            return {"error": "unknown request"}
        op = request["op"]
        if op == "fetch":
            return await self._fetch(request)
        if op == "approve":
            return await self._approve(request)
        return await self._llm(op, request)

    # ------------------------------------------------------------------------------------------ llm, llm_batch

    async def _llm(self, op: str, request: dict) -> dict:
        prompts = request.get("prompts")
        if not isinstance(prompts, list) or not all(isinstance(p, str) for p in prompts):
            return {"error": "prompts must be a list of strings"}
        if op == "llm" and len(prompts) != 1:
            return {"error": "llm takes exactly one prompt"}
        if self.infra_error:
            return {"error": INFRA_REPLY}
        if self.subcalls_used + len(prompts) > self.max_subcalls:
            return self._reject(prompts, request, contract.budget_exhausted_message(self.max_subcalls))
        if self.limits.subcall_oversize == "error":
            longest = max((len(p) for p in prompts), default=0)
            if longest > self.limits.subcall_max_chars:
                return self._reject(prompts, request, contract.oversize_message(longest, self.limits.subcall_max_chars))
        if not prompts:
            return {"outputs": []}

        # Allocate ids in one synchronous step: no await between the budget check and the increment, so threads in
        # one cell can't oversubscribe the budget.
        n = len(prompts)
        first_id = self.subcalls_used + 1
        self.subcalls_used += n
        batch_id = self._next_batch_id()
        origin = self._origin(request)

        results = await asyncio.gather(
            *(
                self._one(first_id + i, prompt, origin, {"id": batch_id, "index": i, "size": n})
                for i, prompt in enumerate(prompts)
            ),
            return_exceptions=True,
        )
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
            if isinstance(result, BaseException) and not isinstance(result, SubcallError):
                kind, message = _infra_of(result)
                if self.infra_error is None:  # the first failure is the one that stops the run
                    self.infra_error, self.infra_kind = message, kind
                raise InfraError(self.infra_kind or kind, self.infra_error or message)
        for result in results:
            if isinstance(result, SubcallError):
                return {"error": f"sub-call failed: {result.message}"}
        return {"outputs": results}

    def _reject(self, prompts: list[str], request: dict, message: str) -> dict:
        """A refused request: one `rejected` event, no model call, no sub-call ids used."""
        batch = {"id": self._next_batch_id(), "index": 0, "size": len(prompts)}
        longest = max((len(p) for p in prompts), default=0)
        self._subcall_event(None, self._origin(request), batch, longest, "rejected", message, 0.0)
        return {"error": message}

    async def _one(self, subcall_id: int, prompt: str, origin: dict, batch: dict) -> str:
        prompt = contract.truncate_prompt(contract.clean_text(prompt), self.limits.subcall_max_chars)
        params = {
            "run_id": self.run_id,
            "role": "sub",
            "model": dict(self.sub_ref),
            "messages": [{"role": "user", "content": prompt}],
            "tools": [],
            "max_tokens": self.limits.subcall_max_tokens,
            "temperature": self.profile.sub_temperature,
            "thinking": self.sub_ref.get("thinking") or self.limits.subcall_thinking or "off",
            "turn": self.turn,
            "subcall_id": subcall_id,
            "origin": dict(origin),
            "batch": dict(batch),
        }
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

    def _origin(self, request: dict) -> dict:
        line = request.get("line")
        return {"turn": self.turn, "line": line if isinstance(line, int) and not isinstance(line, bool) else None}

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

    async def _approve(self, request: dict) -> dict:
        kind, detail, inside = request.get("kind"), request.get("detail"), request.get("inside_workspace")
        if kind not in KINDS or not isinstance(detail, str) or not isinstance(inside, bool):
            return {"error": "malformed request"}
        return {"allow": await self.permissions.check(kind, detail, inside_workspace=inside, turn=self.turn)}

    # ------------------------------------------------------------------------------------------ fetch

    async def _fetch(self, request: dict) -> dict:
        url = request.get("url")
        if not isinstance(url, str):
            return {"error": "malformed request"}
        started = time.monotonic()
        status: int | None = None
        text: str | None = None
        error: str | None = None
        try:
            status, text = await asyncio.to_thread(_fetch_blocking, url)
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


class _BadResult(Exception):
    """`model.complete` answered with a text that is not a str: an infrastructure fault."""


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


def _fetch_blocking(url: str) -> tuple[int, str]:
    """GET `url` on a worker thread: `(status, text)`, or `_FetchFailed`."""
    try:
        return _get(url)
    except _FetchFailed:
        raise
    except urllib.error.URLError as exc:
        if isinstance(exc.reason, TimeoutError):
            raise _timed_out() from None
        raise _FetchFailed(str(exc.reason) or type(exc.reason).__name__) from None
    except TimeoutError:
        raise _timed_out() from None
    except Exception as exc:
        raise _FetchFailed(str(exc) or type(exc).__name__) from None


def _get(url: str) -> tuple[int, str]:
    deadline = time.monotonic() + FETCH_TIMEOUT_S
    opener = urllib.request.build_opener(_NoRedirects)
    host = _check_scheme(url)
    redirects = 0
    while True:
        request = urllib.request.Request(url, method="GET", headers={"Accept-Encoding": "identity"})
        try:
            with opener.open(request, timeout=max(deadline - time.monotonic(), 0.001)) as response:
                body = _read_body(response, deadline)
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


def _check_scheme(url: str, redirect: bool = False) -> str:
    """The URL's host; fails for anything but http and https."""
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        if redirect:
            raise _FetchFailed(f"redirected to a URL that is not http:// or https:// ({url})")
        raise _FetchFailed("fetch takes an http:// or https:// URL")
    return parts.hostname or ""


def _read_body(response: Any, deadline: float) -> bytes:
    """At most four bytes per allowed character (plus a few), so a decoded body over the cap is always seen as over."""
    limit = FETCH_MAX_CHARS * 4 + 4
    chunks: list[bytes] = []
    total = 0
    while total < limit:
        if time.monotonic() > deadline:
            raise _timed_out()
        # read1 returns what has arrived; read(n) would wait for n bytes, and a slow trickle would outlast the deadline
        chunk = response.read1(min(_READ_CHUNK, limit - total))
        if not chunk:
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
