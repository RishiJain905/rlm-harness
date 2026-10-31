"""KV cache: none

The engine's methods on the link: `engine.info` (with the contract and profiles since step 3),
`run.start`, `run.cancel` and `run.vars` (step 6), and `debug.roundtrip` for the link tests when `RLMH_DEBUG=1`.

The engine keeps nothing between runs (D-35): `_runs` holds only the runs still going.
"""

from __future__ import annotations

import asyncio
import os
import platform
import secrets
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from . import PROTOCOL_VERSION, __version__, contract, inputs, loop, profiles, runlog
from .appport import AppPort
from .errors import ModelError
from .link import BAD_INPUT, INVALID_PARAMS, MODEL_ERROR, UNKNOWN_PROFILE, UNKNOWN_RUN, Link, RpcError
from .permissions import MODES
from .worker.manager import Worker

MAX_ROUNDTRIP = 1000
CANCEL_WAIT_S = 10
THINKING = (None, "off", "low", "medium", "high")
_OPTIONAL_STR = ("question", "task", "repo_path", "test_hint", "language", "context", "tag", "batch", "log_dir")
_REPO_OVERRIDES = ("test_hint", "language", "n_files", "context")


def _default_home() -> Path:
    value = os.environ.get("RLMH_HOME", "")
    return Path(value) if value else Path.home() / ".rlm-harness"


@dataclass
class _Run:
    task: asyncio.Task | None = None
    worker: Any = None
    gate: _Gate | None = None
    cancelling: bool = False


class _Gate(AppPort):
    """The app as one run sees it until `run.start` has answered (§5.4): notifications (events and model.cancel) are
    held, and model calls and approvals wait, until `release`. `started` resolves at `run.started`."""

    def __init__(self, app: AppPort) -> None:
        self.app = app
        self.started: asyncio.Future = asyncio.get_running_loop().create_future()
        self._held: list[Callable[[], None]] | None = []
        self._released = asyncio.Event()

    async def complete(self, params: dict) -> dict:
        await self._released.wait()
        return await self.app.complete(params)

    async def approve(self, params: dict) -> dict:
        await self._released.wait()
        return await self.app.approve(params)

    def event(self, method: str, params: dict) -> None:
        if method == "run.started" and not self.started.done():
            self.started.set_result(None)
        self._send(lambda: self.app.event(method, params))

    def cancel_calls(self, run_id: str) -> None:
        self._send(lambda: self.app.cancel_calls(run_id))

    def release(self) -> None:
        held, self._held = self._held or [], None
        for send in held:
            send()
        self._released.set()

    def _send(self, send: Callable[[], None]) -> None:
        if self._held is not None:
            self._held.append(send)
        else:
            send()


class Engine:
    def __init__(self, app: AppPort, *, home: Path | None = None, debug: bool = False) -> None:
        self.app = app
        self.debug = debug
        self.home = home if home is not None else _default_home()
        self.worker_factory = Worker  # tests replace it
        self._runs: dict[str, _Run] = {}

    def info(self) -> dict:
        return {
            "version": __version__,
            "protocol": PROTOCOL_VERSION,
            "python": platform.python_version(),
            **contract_info(self.home),
        }

    def register(self, link: Link) -> None:
        link.method("engine.info", self._engine_info)
        link.method("run.start", self._run_start)
        link.method("run.cancel", self._run_cancel)
        link.method("run.vars", self._run_vars)
        link.on_close(self._cancel_all)
        if self.debug:
            link.method("debug.roundtrip", self._debug_roundtrip)

    async def _engine_info(self, params: dict) -> dict:
        return self.info()

    # -- runs --

    async def _run_start(self, params: dict) -> dict:
        spec = _run_spec(params, self.home)
        try:
            await asyncio.to_thread(inputs.prepare, spec)
        except inputs.InputError as exc:
            raise RpcError(BAD_INPUT, str(exc)) from None

        gate = _Gate(self.app)
        entry = _Run(gate=gate)

        def capture(**kwargs: Any) -> Any:
            entry.worker = self.worker_factory(**kwargs)
            return entry.worker

        entry.task = asyncio.create_task(loop.run(spec, gate, home=self.home, worker_factory=capture))
        self._runs[spec.run_id] = entry
        entry.task.add_done_callback(lambda _: self._runs.pop(spec.run_id, None))
        try:
            # a worker that can't start ends the task without run.started
            await asyncio.wait({gate.started, entry.task}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:  # the link is closing
            _cancel(entry)
            raise
        # The result goes out in this step (Link writes it as the handler returns); held events and the first root
        # call follow in a later one, so the order on the wire is result, run.started, model.complete (§5.4).
        asyncio.get_running_loop().call_soon(gate.release)
        return {"run_id": spec.run_id, "log_path": str(spec.log_path)}

    async def _run_cancel(self, params: dict) -> dict:
        entry = self._live_run(params)
        _cancel(entry)
        await asyncio.wait({entry.task}, timeout=CANCEL_WAIT_S)  # run.finished has been sent when this returns
        return {}

    async def _run_vars(self, params: dict) -> dict:
        entry = self._live_run(params)
        return {"vars": await entry.worker.vars() if entry.worker is not None else []}

    def _live_run(self, params: dict) -> _Run:
        entry = self._runs.get(params.get("run_id"))  # type: ignore[arg-type]
        if entry is None or entry.task is None or entry.task.done():
            raise RpcError(UNKNOWN_RUN, f"no run {params.get('run_id')!r} is going")
        return entry

    async def _cancel_all(self) -> None:
        """The link closed: cancel every run and wait for each, so no worker outlives stdin."""
        entries = list(self._runs.values())
        for entry in entries:
            _cancel(entry)
        if entries:
            await asyncio.gather(*(e.task for e in entries), return_exceptions=True)

    async def _debug_roundtrip(self, params: dict) -> dict:
        count = params.get("count")
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= MAX_ROUNDTRIP:
            raise RpcError(INVALID_PARAMS, f"count must be an integer from 1 to {MAX_ROUNDTRIP}")
        calls = [asyncio.ensure_future(self.app.complete(_ping(i))) for i in range(count)]
        try:
            results = await asyncio.gather(*calls)
        except ModelError as err:
            for call in calls:
                call.cancel()
            raise RpcError(MODEL_ERROR, err.message, err.data()) from None
        return {"texts": [r["text"] for r in results]}


def _cancel(entry: _Run) -> None:
    """Cancel a run once: a second cancel would cut into the run's own clean-up (the record and run.finished)."""
    if not entry.cancelling and entry.task is not None:
        entry.cancelling = True
        entry.task.cancel()


def contract_info(home: Path) -> dict:
    """engine.info's contract fields: the copy's hash beside training's, and every profile with its two hashes."""
    return {
        "contract": contract.CONTRACT_VERSION,
        "contract_hash": contract.prompt_hash(contract.PROMPTS_V4),
        "training_hash": contract.TRAINING_HASH,
        "profiles": [
            {"name": p.name, "source": p.source, "prompt_hash": p.prompt_hash(), "profile_hash": p.profile_hash()}
            for p in profiles.list_profiles(home)
        ],
    }


def _run_spec(params: dict, home: Path) -> loop.RunSpec:
    """Check run.start's params in the spec's order and build the RunSpec: types and enums (-32602), the profile
    (-32011), missing fields and paths (-32012), then the log path (-32602)."""

    p = params
    if p.get("mode") is not None and p["mode"] not in ("read", "repo"):
        raise RpcError(INVALID_PARAMS, f"mode must be read or repo (got {p['mode']!r})")
    for key in ("profile", *_OPTIONAL_STR):
        if p.get(key) is not None and not isinstance(p[key], str):
            raise RpcError(INVALID_PARAMS, f"{key} must be a string")
    for key in ("root", "sub"):
        if p.get(key) is not None and not _is_model_ref(p[key]):
            raise RpcError(INVALID_PARAMS, f"{key} must be a ModelRef: {{provider, model, thinking}}")
    if p.get("permission_mode") is not None and p["permission_mode"] not in MODES:
        raise RpcError(INVALID_PARAMS, f"permission_mode must be one of {', '.join(MODES)}")
    if p.get("call_format") is not None and p["call_format"] not in ("fenced", "native"):
        raise RpcError(INVALID_PARAMS, "call_format must be fenced or native")
    if p.get("inputs") is not None and not (isinstance(p["inputs"], list) and all(isinstance(i, str) for i in p["inputs"])):
        raise RpcError(INVALID_PARAMS, "inputs must be a list of strings")
    n_files = p.get("n_files")
    if n_files is not None and (not isinstance(n_files, int) or isinstance(n_files, bool) or n_files < 0):
        raise RpcError(INVALID_PARAMS, "n_files must be a whole number")
    if p.get("interactive") is not None and not isinstance(p["interactive"], bool):
        raise RpcError(INVALID_PARAMS, "interactive must be true or false")

    profile = None
    if p.get("profile") is not None:
        try:
            profile = profiles.load_profile(p["profile"], home)
        except profiles.ProfileError as exc:
            raise RpcError(UNKNOWN_PROFILE, str(exc)) from None

    mode = p.get("mode")
    needed = ["mode", "profile", "root", "sub", "permission_mode", "call_format"]
    needed += ["question", "inputs"] if mode == "read" else ["task", "repo_path"]
    missing = [key for key in needed if p.get(key) is None or (key == "inputs" and not p[key])]
    if missing:
        raise RpcError(BAD_INPUT, f"run.start is missing {', '.join(missing)}")
    repo = mode == "repo"
    input_paths = [] if repo else [Path(i) for i in p["inputs"]]
    repo_path = Path(p["repo_path"]) if repo else None
    log_dir = Path(p["log_dir"]) if p.get("log_dir") is not None else None
    for path in [*input_paths, repo_path, log_dir]:
        if path is not None and not path.is_absolute():
            raise RpcError(BAD_INPUT, f"not an absolute path: {path}")
    for path in input_paths:
        if not path.is_file():
            raise RpcError(BAD_INPUT, f"no such input file: {path}")
    if repo_path is not None and not repo_path.is_dir():
        raise RpcError(BAD_INPUT, f"the repo path is not a folder: {repo_path}")

    batch = p.get("batch") or "interactive"
    try:
        log_path = runlog.log_path(home, batch, log_dir)
    except ValueError as exc:
        raise RpcError(INVALID_PARAMS, str(exc)) from None

    return loop.RunSpec(
        run_id="r_" + secrets.token_hex(6), mode=mode, profile=profile, root=dict(p["root"]), sub=dict(p["sub"]),
        permission_mode=p["permission_mode"], call_format=p["call_format"], interactive=bool(p.get("interactive")),
        question=None if repo else p["question"], inputs=input_paths, task=p["task"] if repo else None,
        repo_path=repo_path,
        **{key: p.get(key) if repo else None for key in _REPO_OVERRIDES},
        tag=p.get("tag"), batch=batch, log_path=log_path,
    )


def _is_model_ref(value: Any) -> bool:
    return (isinstance(value, dict) and isinstance(value.get("provider"), str) and isinstance(value.get("model"), str)
            and value.get("thinking") in THINKING)


def _ping(i: int) -> dict:
    return {
        "run_id": "debug",
        "role": "root",
        "model": {"provider": "debug", "model": "roundtrip", "thinking": None},
        "messages": [{"role": "user", "content": f"ping {i}"}],
        "tools": [],
        "max_tokens": 16,
        "temperature": 0.0,
        "thinking": "off",
        "turn": 1,
    }
