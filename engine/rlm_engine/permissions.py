"""KV cache: none

The three permission modes and the approval round trip (architecture §7.7; decisions D-12 to D-15, D-47, D-48).

The worker's audit hooks (and `tools.shell`, `tools.fetch`) send `approve` requests; the bridge hands them to
`Permissions.check`, which decides from the mode and from what the user already allowed "for the rest of this run",
asks the app with `approval.request` when it must, and records every decision on a guarded action as a
`run.permission` event. This stops accidents, not attackers: it is not a sandbox.
"""

from __future__ import annotations

import asyncio
import ipaddress
import os
from pathlib import Path
from urllib.parse import urlsplit

from .appport import AppPort

MODES = ("default", "accept-edits", "bypass")
KINDS = ("write", "shell", "network")
MAX_LOG = 200  # entries kept and sent per run; later decisions still apply but are only counted in `dropped`
RENAME_SEP = " -> "  # a rename's write detail is `src -> dst` (D-47)


class Permissions:
    def __init__(
        self,
        *,
        run_id: str,
        mode: str,
        workspace: Path,
        scratch: Path,
        repo_mode: bool,
        interactive: bool,
        app: AppPort,
    ) -> None:
        if mode not in MODES:
            raise ValueError(f"unknown permission mode {mode!r}")
        self.run_id = run_id
        self.mode = mode
        self.workspace = Path(workspace)
        self.scratch = Path(scratch)
        self.repo_mode = repo_mode  # stored; no v0 rule depends on it (read mode's workspace is the scratch folder)
        self.interactive = interactive
        self.app = app
        self.log: list[dict] = []  # entries have run.permission's six keys: turn, kind, detail, allowed, asked, remembered
        self.dropped = 0  # decisions made after the log reached MAX_LOG
        self.allowed_keys: set[tuple] = set()  # "allow for the rest of this run" answers (D-14)
        self._lock = asyncio.Lock()  # one prompt at a time; a second waiting cell sees the first answer

    # ------------------------------------------------------------------------------------------ the rules

    def decide(self, kind: str, detail: str, inside_workspace: bool) -> str:
        """`"allow"` or `"ask"`. Pure: it reads only the mode, the scratch folder and the remembered keys."""
        if kind == "write" and self._in_scratch(detail):
            return "allow"  # D-12: the scratch folder is always writable
        key = _key(kind, detail, inside_workspace)
        if key is not None and key in self.allowed_keys:
            return "allow"
        if self.mode == "bypass":
            return "allow"
        if self.mode == "accept-edits" and kind == "write" and inside_workspace:
            return "allow"
        return "ask"

    async def check(self, kind: str, detail: str, *, inside_workspace: bool, turn: int) -> bool:
        """Whether the action may go ahead, asking the app when the rules say `ask`."""
        inside_workspace = bool(inside_workspace)
        if kind == "write" and self._in_scratch(detail):
            return True  # no log entry and no event
        decision = self.decide(kind, detail, inside_workspace)
        if decision == "allow":
            self._record(turn, kind, detail, allowed=True, asked=False, remembered=self._is_remembered(kind, detail, inside_workspace))
            return True
        if not self.interactive:  # D-15: nobody can answer, so anything that would ask is denied
            self._record(turn, kind, detail, allowed=False, asked=False, remembered=False)
            return False
        async with self._lock:
            # A cell that waited for the lock may now find its answer already given.
            if self.decide(kind, detail, inside_workspace) == "allow":
                self._record(turn, kind, detail, allowed=True, asked=False, remembered=self._is_remembered(kind, detail, inside_workspace))
                return True
            params = {"run_id": self.run_id, "kind": kind, "detail": detail, "turn": turn, "inside_workspace": inside_workspace}
            try:
                reply = await self.app.approve(params)
            except asyncio.CancelledError:
                raise
            except Exception:  # the app could not answer: deny
                reply = None
            if not isinstance(reply, dict):
                reply = {}
            allowed = reply.get("allow") is True
            if allowed and (reply.get("remember_for_run") is True or _is_bare_host(kind, detail)):
                key = _key(kind, detail, inside_workspace)
                if key is not None:
                    self.allowed_keys.add(key)
            self._record(turn, kind, detail, allowed=allowed, asked=True, remembered=False)
            return allowed

    # ------------------------------------------------------------------------------------------ helpers

    def _is_remembered(self, kind: str, detail: str, inside_workspace: bool) -> bool:
        key = _key(kind, detail, inside_workspace)
        return key is not None and key in self.allowed_keys

    def _in_scratch(self, detail: str) -> bool:
        """Whether a write detail names only paths under the scratch folder. A rename needs both of its paths there."""
        root = _real(str(self.scratch))
        parts = detail.split(RENAME_SEP)
        return all(os.path.isabs(part) and _under(_real(part), root) for part in parts)

    def _record(self, turn: int, kind: str, detail: str, *, allowed: bool, asked: bool, remembered: bool) -> None:
        if len(self.log) >= MAX_LOG:
            self.dropped += 1
            return
        entry = {"turn": turn, "kind": kind, "detail": detail, "allowed": allowed, "asked": asked, "remembered": remembered}
        self.log.append(entry)
        self.app.event("run.permission", {"run_id": self.run_id, **entry})


def _real(path: str) -> str:
    """`path` resolved and case-folded the way the OS compares paths (realpath also lengthens Windows 8.3 names)."""
    return os.path.normcase(os.path.realpath(path))


def _under(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:  # different drives, or a mix of absolute and relative
        return False


def _key(kind: str, detail: str, inside_workspace: bool) -> tuple | None:
    """What an "allow for the rest of this run" answer is remembered as (D-14); None when nothing can be remembered."""
    if kind == "write":
        return ("write", bool(inside_workspace))
    if kind == "shell":
        return ("shell",)
    if kind == "network":
        host = _network_host(detail)[0]
        return ("network", host) if host else None
    return None


def _is_bare_host(kind: str, detail: str) -> bool:
    """A network detail that is a host with no port came from `fetch` (D-47)."""
    if kind != "network":
        return False
    host, has_port = _network_host(detail)
    return host is not None and not has_port


def _network_host(detail: str) -> tuple[str | None, bool]:
    """`(host, has_port)` for `host`, `host:port`, `[v6]:port` or a bare IPv6 address; `(None, False)` for anything else
    (a Unix socket path, say). IP addresses are normalised so `::1` and `[0:0:0:0:0:0:0:1]:80` give the same host."""
    text = detail.strip()
    if text.count(":") > 1 and not text.startswith("["):  # an IPv6 address without brackets can only be a bare host
        try:
            return str(ipaddress.ip_address(text)), False
        except ValueError:
            return None, False
    try:
        parts = urlsplit("//" + text)
        host = parts.hostname
    except ValueError:
        return None, False
    if not host:
        return None, False
    has_port = ":" in parts.netloc[parts.netloc.rfind("]") + 1 :]
    try:
        host = str(ipaddress.ip_address(host))
    except ValueError:
        pass
    return host, has_port
