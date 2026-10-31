"""KV cache: none

permissions.py on its own: `decide` for every mode and kind, and `check` against a `StubApp` (the parameters it
sends, what a "for the run" answer remembers, denial, non-interactive runs, the log and its events). The worker's
hooks and `tools.fetch` meet it in the end-to-end section at the bottom.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import http.server
import json
import os
import socket
import subprocess
import sys
import threading
from pathlib import Path
from typing import Any, AsyncIterator

import pytest
from conftest import StubApp, needs_git, run

from rlm_engine import contract, workspace
from rlm_engine.bridge import Bridge
from rlm_engine.errors import ModelError
from rlm_engine.permissions import MAX_LOG, MODES, Permissions
from rlm_engine.profiles import load_profile
from rlm_engine.worker.manager import Worker

RUN_ID = "r_0123456789ab"
LOG_KEYS = {"turn", "kind", "detail", "allowed", "asked", "remembered"}
ALLOW = {"allow": True, "remember_for_run": False}
ALLOW_RUN = {"allow": True, "remember_for_run": True}
DENY = {"allow": False, "remember_for_run": False}
DENY_RUN = {"allow": False, "remember_for_run": True}
EXAMPLES = {
    ex["name"]: ex["message"]
    for ex in json.loads((Path(__file__).resolve().parents[2] / "protocol" / "examples.json").read_text("utf-8"))["examples"]
}


def make(tmp_path: Path, *, mode: str = "default", interactive: bool = True, answer=None, repo_mode: bool = True):
    app = StubApp(answer=answer if answer is not None else ALLOW)
    perms = Permissions(
        run_id=RUN_ID,
        mode=mode,
        workspace=tmp_path / "repo",
        scratch=tmp_path / "scratch",
        repo_mode=repo_mode,
        interactive=interactive,
        app=app,
    )
    return perms, app


def inside(tmp_path: Path, name: str = "a.py") -> str:
    return (tmp_path / "repo" / name).as_posix()


def outside(tmp_path: Path, name: str = "x.txt") -> str:
    return (tmp_path / "elsewhere" / name).as_posix()


def in_scratch(tmp_path: Path, name: str = "f.txt") -> str:
    return (tmp_path / "scratch" / name).as_posix()


def check(perms: Permissions, kind: str, detail: str, *, inside_workspace: bool = False, turn: int = 1) -> bool:
    return run(perms.check(kind, detail, inside_workspace=inside_workspace, turn=turn))


# ---------------------------------------------------------------------------------------------- decide

# mode -> (write inside, write outside, shell, network, scratch write)
DECISIONS = {
    "default": ("ask", "ask", "ask", "ask", "allow"),
    "accept-edits": ("allow", "ask", "ask", "ask", "allow"),
    "bypass": ("allow", "allow", "allow", "allow", "allow"),
}


def test_modes_listed() -> None:
    assert MODES == ("default", "accept-edits", "bypass")
    assert set(DECISIONS) == set(MODES)


@pytest.mark.parametrize("mode", MODES)
def test_decide_table(tmp_path: Path, mode: str) -> None:
    perms, app = make(tmp_path, mode=mode)
    write_in, write_out, shell, network, scratch = DECISIONS[mode]
    assert perms.decide("write", inside(tmp_path), True) == write_in
    assert perms.decide("write", outside(tmp_path), False) == write_out
    assert perms.decide("shell", "ls -la", True) == shell
    assert perms.decide("network", "example.com:443", False) == network
    assert perms.decide("network", "example.com", False) == network
    assert perms.decide("write", in_scratch(tmp_path), True) == scratch
    assert perms.decide("write", in_scratch(tmp_path), False) == scratch
    assert not app.approvals and not app.events and not perms.log  # decide is pure


def test_unknown_mode_is_an_error(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        make(tmp_path, mode="yolo")


def test_decide_reads_the_remembered_set(tmp_path: Path) -> None:
    perms, _ = make(tmp_path, answer=ALLOW_RUN)
    assert perms.decide("shell", "make", True) == "ask"
    assert check(perms, "shell", "make", inside_workspace=True)
    assert perms.decide("shell", "something else", True) == "allow"
    assert perms.decide("write", inside(tmp_path), True) == "ask"  # other kinds are untouched


def test_unknown_kind_asks_unless_bypass(tmp_path: Path) -> None:
    assert make(tmp_path)[0].decide("telepathy", "x", False) == "ask"
    assert make(tmp_path, mode="bypass")[0].decide("telepathy", "x", False) == "allow"


def test_repo_mode_is_stored_only(tmp_path: Path) -> None:
    for repo_mode in (True, False):
        perms, _ = make(tmp_path, repo_mode=repo_mode)
        assert perms.repo_mode is repo_mode
        assert perms.decide("write", inside(tmp_path), True) == "ask"


# ---------------------------------------------------------------------------------------------- scratch

def test_scratch_write_is_silent_in_every_mode(tmp_path: Path) -> None:
    for mode in MODES:
        perms, app = make(tmp_path, mode=mode, interactive=False)
        assert check(perms, "write", in_scratch(tmp_path), inside_workspace=True)
        assert check(perms, "write", in_scratch(tmp_path, "sub/dir/deep.txt"), inside_workspace=False)
        assert check(perms, "write", tmp_path.joinpath("scratch").as_posix())  # the folder itself
        assert not app.approvals and not app.events and not perms.log and perms.dropped == 0


def test_scratch_check_is_not_fooled(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=DENY)
    scratch = tmp_path / "scratch"
    tricky = [
        (tmp_path / "scratch2" / "f.txt").as_posix(),  # a sibling that shares the prefix
        (scratch / ".." / "elsewhere" / "f.txt").as_posix(),  # climbs out
        "scratch/f.txt",  # relative
        f"{in_scratch(tmp_path)} -> {outside(tmp_path)}",  # a rename out of scratch
        f"{outside(tmp_path)} -> {in_scratch(tmp_path)}",  # a rename into it
    ]
    for detail in tricky:
        assert perms.decide("write", detail, False) == "ask", detail
        assert not check(perms, "write", detail)
    assert len(app.approvals) == len(tricky)


def test_scratch_rename_inside_scratch_is_silent(tmp_path: Path) -> None:
    perms, app = make(tmp_path)
    assert check(perms, "write", f"{in_scratch(tmp_path, 'a')} -> {in_scratch(tmp_path, 'b')}")
    assert not app.approvals and not perms.log


def test_scratch_symlink_out_is_not_scratch(tmp_path: Path) -> None:
    scratch, target = tmp_path / "scratch", tmp_path / "elsewhere"
    scratch.mkdir()
    target.mkdir()
    try:
        os.symlink(target, scratch / "link", target_is_directory=True)
    except (OSError, NotImplementedError):
        pytest.skip("cannot create symlinks here")
    perms, app = make(tmp_path, answer=DENY)
    assert not check(perms, "write", (scratch / "link" / "f.txt").as_posix())
    assert len(app.approvals) == 1


def test_scratch_matches_with_a_spelling_the_os_considers_equal(tmp_path: Path) -> None:
    (tmp_path / "scratch").mkdir()
    perms, app = make(tmp_path)
    # a `..` detour, and (where the filesystem is case-insensitive) a different case
    assert check(perms, "write", (tmp_path / "scratch" / ".." / "scratch" / "f.txt").as_posix())
    if os.path.normcase("A") == "a":
        assert check(perms, "write", in_scratch(tmp_path).upper())
    assert not app.approvals


# ---------------------------------------------------------------------------------------------- check: asking

def test_params_sent_exactly(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW)
    detail = outside(tmp_path)
    assert check(perms, "write", detail, inside_workspace=False, turn=3)
    assert app.approvals == [{"run_id": RUN_ID, "kind": "write", "detail": detail, "turn": 3, "inside_workspace": False}]
    assert check(perms, "shell", "python -m pytest -q", inside_workspace=True, turn=4)
    assert app.approvals[1] == {
        "run_id": RUN_ID, "kind": "shell", "detail": "python -m pytest -q", "turn": 4, "inside_workspace": True,
    }
    assert list(app.approvals[1]) == ["run_id", "kind", "detail", "turn", "inside_workspace"]


def test_allow_once_is_asked_again(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW)
    assert check(perms, "shell", "ls")
    assert check(perms, "shell", "ls")
    assert len(app.approvals) == 2
    assert [e["remembered"] for e in perms.log] == [False, False]


def test_deny_is_not_remembered(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=DENY_RUN)  # "remember" on a denial remembers nothing
    assert not check(perms, "shell", "rm -rf x")
    assert not check(perms, "shell", "rm -rf x")
    assert len(app.approvals) == 2
    assert perms.log == [
        {"turn": 1, "kind": "shell", "detail": "rm -rf x", "allowed": False, "asked": True, "remembered": False}
    ] * 2


def test_shell_remembered_for_the_run(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    assert check(perms, "shell", "make test", inside_workspace=True, turn=2)
    assert check(perms, "shell", "a completely different command", inside_workspace=True, turn=3)
    assert len(app.approvals) == 1
    assert [(e["asked"], e["remembered"]) for e in perms.log] == [(True, False), (False, True)]


def test_write_remembered_per_side_of_the_workspace(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    assert check(perms, "write", inside(tmp_path, "a.py"), inside_workspace=True)
    assert check(perms, "write", inside(tmp_path, "b.py"), inside_workspace=True)  # remembered
    assert len(app.approvals) == 1
    assert check(perms, "write", outside(tmp_path), inside_workspace=False)  # the other side still asks
    assert len(app.approvals) == 2
    assert check(perms, "write", outside(tmp_path, "y.txt"), inside_workspace=False)  # and is remembered separately
    assert len(app.approvals) == 2
    assert [e["remembered"] for e in perms.log] == [False, True, False, True]


def test_outside_write_allowed_for_the_run_does_not_open_the_inside(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    assert check(perms, "write", outside(tmp_path), inside_workspace=False)
    assert check(perms, "write", inside(tmp_path), inside_workspace=True)
    assert len(app.approvals) == 2


def test_network_remembered_per_host(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    assert check(perms, "network", "api.example.com:443")
    assert check(perms, "network", "api.example.com:8080")  # same host, other port
    assert check(perms, "network", "API.example.com")  # case-insensitive, and a bare host
    assert len(app.approvals) == 1
    assert check(perms, "network", "other.example.com:443")  # another host asks
    assert check(perms, "network", "localhost")
    assert check(perms, "network", "127.0.0.1")  # localhost and 127.0.0.1 differ
    assert [a["detail"] for a in app.approvals] == ["api.example.com:443", "other.example.com:443", "localhost", "127.0.0.1"]


def test_network_ipv6_hosts(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    assert check(perms, "network", "[::1]:8080")
    assert check(perms, "network", "::1")  # a bare IPv6 host (fetch sends the host without brackets)
    assert check(perms, "network", "[0:0:0:0:0:0:0:1]:80")  # the same address, spelled out
    assert len(app.approvals) == 1
    assert check(perms, "network", "[::2]:8080")
    assert len(app.approvals) == 2


def test_plain_allow_on_a_fetch_host_is_not_asked_again(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW)  # remember_for_run is false
    assert check(perms, "network", "127.0.0.1")  # a bare host: it came from fetch
    assert check(perms, "network", "127.0.0.1")
    assert len(app.approvals) == 1
    assert check(perms, "network", "localhost")
    assert len(app.approvals) == 2
    assert [(e["asked"], e["remembered"]) for e in perms.log] == [(True, False), (False, True), (True, False)]


def test_plain_allow_on_a_socket_is_asked_again(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW)
    assert check(perms, "network", "127.0.0.1:8123")
    assert check(perms, "network", "127.0.0.1:8123")
    assert check(perms, "network", "::1")  # but a bare IPv6 host is a fetch host
    assert check(perms, "network", "::1")
    assert len(app.approvals) == 3


def test_a_socket_path_cannot_be_remembered(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    assert check(perms, "network", "/var/run/docker.sock")
    assert check(perms, "network", "/var/run/docker.sock")
    assert len(app.approvals) == 2


def test_denied_fetch_host_asks_again(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=DENY)
    assert not check(perms, "network", "127.0.0.1")
    assert not check(perms, "network", "127.0.0.1")
    assert len(app.approvals) == 2


def test_answers_can_change_between_asks(tmp_path: Path) -> None:
    answers = iter([DENY, ALLOW_RUN, DENY])
    perms, app = make(tmp_path, answer=lambda params: next(answers))
    assert not check(perms, "shell", "ls")
    assert check(perms, "shell", "ls")
    assert check(perms, "shell", "ls")  # remembered: the third answer is never read
    assert len(app.approvals) == 2


def test_accept_edits_asks_outside_and_for_shell(tmp_path: Path) -> None:
    perms, app = make(tmp_path, mode="accept-edits", answer=DENY)
    assert check(perms, "write", inside(tmp_path), inside_workspace=True)  # no ask
    assert not check(perms, "write", outside(tmp_path))
    assert not check(perms, "shell", "ls", inside_workspace=True)
    assert [a["kind"] for a in app.approvals] == ["write", "shell"]
    assert [(e["allowed"], e["asked"]) for e in perms.log] == [(True, False), (False, True), (False, True)]


def test_bypass_asks_nothing(tmp_path: Path) -> None:
    perms, app = make(tmp_path, mode="bypass", answer=DENY)
    for kind, detail in (("write", outside(tmp_path)), ("shell", "rm -rf /"), ("network", "evil.example:443")):
        assert check(perms, kind, detail)
    assert not app.approvals
    assert [(e["allowed"], e["asked"], e["remembered"]) for e in perms.log] == [(True, False, False)] * 3


def test_non_interactive_never_calls_the_app(tmp_path: Path) -> None:
    perms, app = make(tmp_path, interactive=False, answer=ALLOW_RUN)
    assert not check(perms, "write", outside(tmp_path))
    assert not check(perms, "write", inside(tmp_path), inside_workspace=True)
    assert not check(perms, "shell", "ls", inside_workspace=True)
    assert not check(perms, "network", "127.0.0.1")
    assert app.approvals == []
    assert [(e["allowed"], e["asked"], e["remembered"]) for e in perms.log] == [(False, False, False)] * 4
    assert len(app.sent("run.permission")) == 4


def test_non_interactive_still_allows_what_the_mode_allows(tmp_path: Path) -> None:
    perms, app = make(tmp_path, mode="accept-edits", interactive=False)
    assert check(perms, "write", inside(tmp_path), inside_workspace=True)
    assert not check(perms, "write", outside(tmp_path))
    perms, app = make(tmp_path, mode="bypass", interactive=False)
    assert check(perms, "shell", "ls", inside_workspace=True)
    assert app.approvals == []


def test_inside_workspace_is_sent_as_a_bool(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW)
    assert check(perms, "shell", "ls", inside_workspace=1)  # type: ignore[arg-type]
    assert app.approvals[0]["inside_workspace"] is True


# ---------------------------------------------------------------------------------------------- check: failures

def test_an_approve_exception_denies(tmp_path: Path) -> None:
    def boom(params: dict) -> dict:
        raise RuntimeError("the link is gone")

    perms, app = make(tmp_path, answer=boom)
    assert not check(perms, "shell", "ls")
    assert len(app.approvals) == 1
    assert perms.log == [{"turn": 1, "kind": "shell", "detail": "ls", "allowed": False, "asked": True, "remembered": False}]


def test_an_async_approve_exception_denies(tmp_path: Path) -> None:
    async def boom(params: dict) -> dict:
        await asyncio.sleep(0)
        raise ConnectionError("closed")

    perms, _ = make(tmp_path, answer=boom)
    assert not check(perms, "network", "127.0.0.1")
    assert not perms.allowed_keys


@pytest.mark.parametrize("reply", [None, [], "yes", {}, {"allow": "true"}, {"allow": 1}, {"remember_for_run": True}])
def test_a_reply_that_is_not_an_allow_denies(tmp_path: Path, reply) -> None:
    perms, _ = make(tmp_path, answer=lambda params: reply)
    assert not check(perms, "shell", "ls")
    assert not perms.allowed_keys


def test_cancelling_a_waiting_check_releases_the_lock(tmp_path: Path) -> None:
    async def scenario() -> None:
        release = asyncio.Event()
        calls = 0

        async def answer(params: dict) -> dict:
            nonlocal calls
            calls += 1
            if calls == 1:
                await release.wait()
            return ALLOW

        perms, app = make(tmp_path, answer=answer)
        stuck = asyncio.create_task(perms.check("shell", "ls", inside_workspace=True, turn=1))
        await asyncio.sleep(0.02)
        assert len(app.approvals) == 1
        stuck.cancel()
        with pytest.raises(asyncio.CancelledError):
            await stuck
        assert perms.log == []  # a cancelled ask makes no decision
        assert await asyncio.wait_for(perms.check("shell", "ls", inside_workspace=True, turn=1), 2)
        assert len(app.approvals) == 2

    run(scenario())


def test_concurrent_checks_prompt_once(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def slow(params: dict) -> dict:
            await asyncio.sleep(0.05)
            return ALLOW_RUN

        perms, app = make(tmp_path, answer=slow)
        results = await asyncio.gather(
            *(perms.check("shell", f"cmd {i}", inside_workspace=True, turn=1) for i in range(5))
        )
        assert results == [True] * 5
        assert len(app.approvals) == 1
        assert [(e["asked"], e["remembered"]) for e in perms.log] == [(True, False)] + [(False, True)] * 4

    run(scenario())


def test_one_prompt_at_a_time(tmp_path: Path) -> None:
    async def scenario() -> None:
        live = peak = 0

        async def slow(params: dict) -> dict:
            nonlocal live, peak
            live += 1
            peak = max(peak, live)
            await asyncio.sleep(0.02)
            live -= 1
            return ALLOW  # not remembered, so every check asks

        perms, app = make(tmp_path, answer=slow)
        await asyncio.gather(*(perms.check("shell", f"c{i}", inside_workspace=True, turn=1) for i in range(4)))
        assert len(app.approvals) == 4 and peak == 1

    run(scenario())


def test_a_waiting_check_sees_a_denial_too(tmp_path: Path) -> None:
    async def scenario() -> None:
        async def slow(params: dict) -> dict:
            await asyncio.sleep(0.02)
            return DENY

        perms, app = make(tmp_path, answer=slow)
        results = await asyncio.gather(*(perms.check("shell", "ls", inside_workspace=True, turn=1) for _ in range(2)))
        assert results == [False, False]
        assert len(app.approvals) == 2  # a denial is not remembered, so the second cell asks as well

    run(scenario())


# ---------------------------------------------------------------------------------------------- the log

def test_log_entries_and_events(tmp_path: Path) -> None:
    answers = iter([ALLOW, DENY, ALLOW_RUN])
    perms, app = make(tmp_path, answer=lambda params: next(answers))
    check(perms, "write", outside(tmp_path), turn=1)
    check(perms, "shell", "ls", inside_workspace=True, turn=2)
    check(perms, "network", "example.com:443", turn=3)
    check(perms, "network", "example.com:80", turn=4)
    assert perms.log == [
        {"turn": 1, "kind": "write", "detail": outside(tmp_path), "allowed": True, "asked": True, "remembered": False},
        {"turn": 2, "kind": "shell", "detail": "ls", "allowed": False, "asked": True, "remembered": False},
        {"turn": 3, "kind": "network", "detail": "example.com:443", "allowed": True, "asked": True, "remembered": False},
        {"turn": 4, "kind": "network", "detail": "example.com:80", "allowed": True, "asked": False, "remembered": True},
    ]
    assert all(set(entry) == LOG_KEYS for entry in perms.log)
    assert [m for m, _ in app.events] == ["run.permission"] * 4
    for entry, (_, params) in zip(perms.log, app.events):
        assert params == {"run_id": RUN_ID, **entry}
        assert list(params) == ["run_id", "turn", "kind", "detail", "allowed", "asked", "remembered"]


def test_the_log_is_capped_at_200(tmp_path: Path) -> None:
    assert MAX_LOG == 200
    perms, app = make(tmp_path, mode="bypass")
    for i in range(MAX_LOG + 7):
        assert check(perms, "shell", f"cmd {i}", inside_workspace=True)  # decisions still apply
    assert len(perms.log) == MAX_LOG and perms.dropped == 7
    assert len(app.sent("run.permission")) == MAX_LOG
    assert perms.log[-1]["detail"] == f"cmd {MAX_LOG - 1}"


def test_a_denial_after_the_cap_still_denies(tmp_path: Path) -> None:
    perms, app = make(tmp_path, interactive=False)
    for i in range(MAX_LOG + 3):
        assert not check(perms, "shell", f"cmd {i}", inside_workspace=True)
    assert len(perms.log) == MAX_LOG and perms.dropped == 3 and len(app.events) == MAX_LOG


def test_asking_still_works_after_the_cap(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW_RUN)
    perms.log.extend({"turn": 0, "kind": "shell", "detail": "x", "allowed": True, "asked": False, "remembered": False}
                     for _ in range(MAX_LOG))
    assert check(perms, "shell", "ls", inside_workspace=True)
    assert check(perms, "shell", "ls", inside_workspace=True)
    assert len(app.approvals) == 1 and perms.dropped == 2 and app.events == []


def test_wire_shapes_match_the_protocol_examples(tmp_path: Path) -> None:
    perms, app = make(tmp_path, answer=ALLOW)
    check(perms, "shell", "python -m pytest -q", inside_workspace=True, turn=3)
    assert set(app.approvals[0]) == set(EXAMPLES["approval.request:request"]["params"])
    assert set(app.events[0][1]) == set(EXAMPLES["run.permission:notification"]["params"])
    assert app.events[0][1] == EXAMPLES["run.permission:notification"]["params"] | {"run_id": RUN_ID}


# ----- end to end with a real worker (added by the lead)

# Real worker, bridge and permissions, per mode. Each table row is one cell: what it does, and what it asks in
# each mode as (kind, detail, inside_workspace). Writes under scratch, reads, asyncio and the tools' own git calls
# never ask. A denial ends the asked cell in PermissionError; an allow lets the action happen.

WINDOWS = sys.platform == "win32"
SUB_REF = {"provider": "fake", "model": "scripted", "thinking": None}
DENIED = "[Errno 13] Permission denied (not approved)"


@dataclasses.dataclass
class Run:
    worker: Worker
    bridge: Bridge
    permissions: Permissions
    app: StubApp


@contextlib.asynccontextmanager
async def real_run(tmp_path: Path, mode: str, answer: Any, *, repo: Path | None = None, interactive: bool = True,
                   workspace_path: Path | None = None) -> AsyncIterator[Run]:
    """A run as step 6 will wire it: repo mode on `repo` (snapshot in scratch), else read mode in scratch."""
    scratch = tmp_path / "scratch"
    scratch.mkdir(exist_ok=True)
    space = workspace_path or repo or scratch
    run_mode = "repo" if repo is not None else "read"
    app = StubApp(answer=answer)
    profile = load_profile("training-v4", tmp_path / "home")
    perms = Permissions(run_id=RUN_ID, mode=mode, workspace=space, scratch=scratch, repo_mode=repo is not None,
                        interactive=interactive, app=app)
    bridge = Bridge(run_id=RUN_ID, app=app, profile=profile, mode=run_mode, sub_ref=SUB_REF, permissions=perms)
    limits = profile.mode(run_mode).limits
    worker = Worker(mode=run_mode, context="ctx", workspace=space, scratch=scratch, limits=limits,
                    messages=contract.cell_messages(limits, edit=repo is not None), on_request=bridge.handle,
                    shell=workspace.find_shell(),
                    base_tree=workspace.snapshot(repo, scratch) if repo is not None else None)
    await worker.start()
    try:
        yield Run(worker, bridge, perms, app)
    finally:
        await worker.close()


def shown(path: Path) -> str:
    return str(path).replace(os.sep, "/")


def asks_by_mode(entry: tuple, *, inside: bool = False) -> dict[str, list]:
    """default asks; accept-edits asks unless it is a write inside the workspace; bypass never asks."""
    return {"default": [entry], "accept-edits": [] if inside else [entry], "bypass": []}


class Listener:
    """A raw TCP listener on 127.0.0.1 that counts the connections it accepted."""

    def __init__(self) -> None:
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(8)
        self.sock.settimeout(0.2)
        self.port = self.sock.getsockname()[1]
        self.accepted = 0
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                continue
            self.accepted += 1
            conn.close()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(2)
        self.sock.close()


def e2e_cells(repo: Path, outside: Path, port: int) -> list[tuple[str, str, dict[str, list]]]:
    shell_cmd = "echo hi"
    return [
        ("write outside", f"open({str(outside)!r}, 'w').write('x')",
         asks_by_mode(("write", shown(outside), False))),
        ("write inside", "open('inside.txt', 'w').write('x')",
         asks_by_mode(("write", shown(repo / "inside.txt"), True), inside=True)),
        ("write_file inside", "print(write_file('tool.txt', 'x'))",
         asks_by_mode(("write", shown(repo / "tool.txt"), True), inside=True)),
        ("scratch via tempfile", "import tempfile\nwith tempfile.NamedTemporaryFile(delete=False) as f:\n    f.write(b'x')",
         {m: [] for m in MODES}),
        ("reads", "import os\nprint(len(open('a.py').read()), len(os.listdir('.')))", {m: [] for m in MODES}),
        ("shell", f"print(shell({shell_cmd!r}))", asks_by_mode(("shell", shell_cmd, True))),
        ("subprocess.run", "import subprocess, sys\nsubprocess.run([sys.executable, '-c', 'pass'])",
         asks_by_mode(("shell", subprocess.list2cmdline([sys.executable, "-c", "pass"]) if WINDOWS
                       else f"{sys.executable} -c pass", True))),
        ("os.system", "import os\nos.system('echo s')", asks_by_mode(("shell", "echo s", True))),
        ("socket", f"import socket\nsocket.create_connection(('127.0.0.1', {port}), timeout=5).close()",
         asks_by_mode(("network", f"127.0.0.1:{port}", False))),
        ("asyncio", "import asyncio\nasyncio.run(asyncio.sleep(0))", {m: [] for m in MODES}),
        ("tools' git", "find_files('*.py'); grep('x'); print(len(diff()) > 0)", {m: [] for m in MODES}),
    ]


@needs_git
@pytest.mark.parametrize("allow", [False, True], ids=["deny", "allow"])
@pytest.mark.parametrize("mode", MODES)
def test_end_to_end_per_mode(tmp_path: Path, git_repo: Path, mode: str, allow: bool) -> None:
    outside = tmp_path / "outside" / "x.txt"
    outside.parent.mkdir()
    listener = Listener()

    async def main() -> None:
        async with real_run(tmp_path, mode, ALLOW if allow else DENY, repo=git_repo) as r:
            for name, code, expected in e2e_cells(git_repo, outside, listener.port):
                before = len(r.app.approvals)
                result = await r.worker.run_cell(code)
                asked = [(a["kind"], a["detail"], a["inside_workspace"]) for a in r.app.approvals[before:]]
                assert asked == expected[mode], name
                if expected[mode] and not allow:
                    assert DENIED in (result.error or ""), (name, result.error)
                else:
                    assert result.error is None, (name, result.error)
            # what the denials stopped did not happen, and what was allowed did
            happened = allow or mode == "bypass"
            assert outside.exists() == happened
            assert (git_repo / "inside.txt").exists() == (happened or mode == "accept-edits")
            assert (listener.accepted > 0) == happened
            # every guarded decision is in the log and was sent as an event; scratch writes are in neither
            assert r.app.sent("run.permission") == [{"run_id": RUN_ID, **e} for e in r.permissions.log]
            assert not [e for e in r.permissions.log if "scratch" in e["detail"]]
            for approval in r.app.approvals:
                assert set(approval) == {"run_id", "kind", "detail", "turn", "inside_workspace"}

    try:
        run(main(), 120)
    finally:
        listener.close()


@needs_git
def test_denial_then_next_cell_works_and_one_open_is_one_ask(tmp_path: Path, git_repo: Path) -> None:
    outside = tmp_path / "out.txt"

    async def main() -> None:
        async with real_run(tmp_path, "default", DENY, repo=git_repo) as r:
            result = await r.worker.run_cell(f"x = 1\nopen({str(outside)!r}, 'w')")
            assert result.error.splitlines()[-1] == f"PermissionError: {DENIED}: {shown(outside)!r}"
            assert '  File "<repl>", line 2, in <module>' in result.error
            assert len(r.app.approvals) == 1
            assert (await r.worker.run_cell("print(x)")).stdout == "1\n"

    run(main(), 60)


@needs_git
def test_non_interactive_denies_without_asking(tmp_path: Path, git_repo: Path) -> None:
    outside = tmp_path / "out.txt"

    async def main() -> None:
        async with real_run(tmp_path, "accept-edits", ALLOW, repo=git_repo, interactive=False) as r:
            result = await r.worker.run_cell(f"open({str(outside)!r}, 'w')")
            assert DENIED in result.error
            assert (await r.worker.run_cell("print(write_file('ok.txt', 'x'))")).error is None  # inside: allowed
            assert r.app.approvals == [] and not outside.exists()
            assert [(e["kind"], e["allowed"], e["asked"]) for e in r.permissions.log] == [
                ("write", False, False), ("write", True, False)]

    run(main(), 60)


def test_read_mode_scratch_writes_never_ask(tmp_path: Path) -> None:
    async def main() -> None:
        async with real_run(tmp_path, "default", DENY) as r:
            result = await r.worker.run_cell("import os\nos.mkdir('d')\nopen('d/f.txt', 'w').write('x')\n"
                                             "os.rename('d/f.txt', 'd/g.txt')\nos.remove('d/g.txt')\nos.rmdir('d')")
            assert result.error is None and r.app.approvals == [] and r.permissions.log == []

    run(main(), 60)


class _Pages(http.server.BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self) -> None:  # noqa: N802
        type(self).hits.append(self.headers.get("Host", ""))
        body = b"hello page"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args: Any) -> None:
        pass


@pytest.mark.parametrize("allow", [False, True], ids=["deny", "allow"])
def test_fetch_asks_once_per_host(tmp_path: Path, allow: bool, monkeypatch: pytest.MonkeyPatch) -> None:
    for name in list(os.environ):
        if name.lower().endswith("_proxy"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("NO_PROXY", "*")
    _Pages.hits = []
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Pages)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    port = server.server_address[1]
    cells = [f"print(fetch('http://127.0.0.1:{port}/a'))", f"print(fetch('http://127.0.0.1:{port}/b'))",
             f"print(fetch('http://localhost:{port}/c'))"]

    async def main() -> None:
        async with real_run(tmp_path, "accept-edits", ALLOW if allow else DENY) as r:
            results = [await r.worker.run_cell(code) for code in cells]
            hosts = [(a["kind"], a["detail"], a["inside_workspace"]) for a in r.app.approvals]
            if allow:
                assert [x.stdout for x in results] == ["hello page\n"] * 3
                assert hosts == [("network", "127.0.0.1", False), ("network", "localhost", False)]
                assert len(_Pages.hits) == 3
            else:
                assert all(DENIED in x.error for x in results)
                assert hosts == [("network", "127.0.0.1", False)] * 2 + [("network", "localhost", False)]
                assert _Pages.hits == [] and r.bridge.fetches == []

    try:
        run(main(), 60)
    finally:
        server.shutdown()
        server.server_close()


def _alternate_spellings(folder: Path) -> list[Path]:
    """Other names for the same folder: the Windows 8.3 short name, and a swapped case where the OS folds case."""
    found = []
    if WINDOWS:
        import ctypes

        buf = ctypes.create_unicode_buffer(1024)
        if ctypes.windll.kernel32.GetShortPathNameW(str(folder), buf, 1024) and buf.value.lower() != str(folder).lower():
            found.append(Path(buf.value))
    swapped = Path(str(folder)[:-len(folder.name)] + folder.name.swapcase())
    if WINDOWS and swapped.exists():  # normcase folds case only on Windows; on macOS a case variant asks as outside
        found.append(swapped)
    return found


def test_inside_workspace_through_other_spellings(tmp_path: Path) -> None:
    space = tmp_path / "Long Workspace Folder"
    space.mkdir()
    spellings = _alternate_spellings(space)
    if not spellings:
        pytest.skip("this file system has no other spelling for a folder")
    scratch = tmp_path / "scratch"
    cells = [f"open({str(s / f'f{i}.txt')!r}, 'w').write('x')" for i, s in enumerate(spellings)]

    async def main() -> None:
        async with real_run(tmp_path, "default", ALLOW, workspace_path=space, repo=space) as r:
            for code in cells:
                assert (await r.worker.run_cell(code)).error is None
            assert [a["inside_workspace"] for a in r.app.approvals] == [True] * len(cells)

    scratch.mkdir(exist_ok=True)
    run(main(), 60)


@pytest.mark.skipif(not WINDOWS, reason="os.startfile is Windows only")
def test_startfile_asks_and_a_denial_stops_it(tmp_path: Path) -> None:
    async def main() -> None:
        async with real_run(tmp_path, "accept-edits", DENY) as r:
            result = await r.worker.run_cell("import os\nos.startfile('nothing-here.txt')")
            assert DENIED in result.error
            assert [(a["kind"], a["detail"]) for a in r.app.approvals] == [("shell", "nothing-here.txt")]

    run(main(), 60)


# ----------------------------------------------------------------------------- the hand-check driver (Done when 3)


class PrintApp:
    """An AppPort for the hand check: prints each approval.request and reads y, a (for the run) or n."""

    async def complete(self, params: dict) -> dict:
        raise ModelError("the hand check has no model", kind="bad_request")

    async def approve(self, params: dict) -> dict:
        print(f"\napproval.request {json.dumps(params)}", flush=True)
        while True:
            answer = (await asyncio.to_thread(input, "allow? [y]es / [a]llow for the run / [n]o: ")).strip().lower()
            if answer in ("y", "a", "n", ""):
                return {"allow": answer in ("y", "a"), "remember_for_run": answer == "a"}

    def event(self, method: str, params: dict) -> None:
        pass

    def cancel_calls(self, run_id: str) -> None:
        pass


async def _hand_check(mode: str, repo: Path | None, cells: list[str]) -> None:
    import tempfile

    with tempfile.TemporaryDirectory(prefix="rlmh-handcheck-") as tmp:
        scratch = Path(tmp) / "scratch"
        scratch.mkdir()
        app = PrintApp()
        space = repo.resolve() if repo else scratch
        run_mode = "repo" if repo else "read"
        profile = load_profile("default", Path(tmp) / "home")
        perms = Permissions(run_id="r_handcheck0000", mode=mode, workspace=space, scratch=scratch,
                            repo_mode=repo is not None, interactive=True, app=app)
        bridge = Bridge(run_id="r_handcheck0000", app=app, profile=profile, mode=run_mode, sub_ref=SUB_REF,
                        permissions=perms)
        limits = profile.mode(run_mode).limits
        worker = Worker(mode=run_mode, context="hand check", workspace=space, scratch=scratch, limits=limits,
                        messages=contract.cell_messages(limits, edit=repo is not None), on_request=bridge.handle,
                        shell=workspace.find_shell(), base_tree=workspace.snapshot(space, scratch) if repo else None)
        print(f"mode {mode}, {run_mode} mode in {space}, shell {workspace.find_shell().name}", flush=True)
        await worker.start()
        try:
            for turn, code in enumerate(cells, 1):
                bridge.turn = worker.turn = turn
                print(f"\n--- cell {turn}: {code}", flush=True)
                result = await worker.run_cell(code)
                print(f"error: {result.error}\nstdout: {result.stdout!r}", flush=True)
        finally:
            await worker.close()
        print("\npermission log:")
        for entry in perms.log:
            print(f"  {json.dumps(entry)}")


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Hand check for step 4: run cells under a permission mode.")
    parser.add_argument("--mode", choices=MODES, default="accept-edits")
    parser.add_argument("--repo", type=Path, help="repo mode on this folder (default: read mode in a temp scratch)")
    parser.add_argument("--cell", action="append", default=[], help="a cell to run; repeat for more")
    options = parser.parse_args()
    asyncio.run(_hand_check(options.mode, options.repo, options.cell))
