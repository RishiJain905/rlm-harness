"""KV cache: appends to one message list, never edits or reorders an earlier message, and the system prompt and tool list are fixed for the run.

One run: training's `run_episode` (rlm_rl/env.py at RLM commit 0b9af69) against any model through the app, with
`_cap_output` copied. Left out, as the build plan lists: token ids, logprobs, rewards, detectors, the grader,
broken-reply redraws and format penalties. Added: the §5.3 events, the run-log record (§7.8), native tool calls
(callformat, 6b), the permission modes, and a scratch folder that is removed when the run ends (D-12).

`run` never raises, except CancelledError, and that only after the record is written and `run.finished` sent.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import os
import shutil
import stat
import sys
import time
import traceback
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, __version__, callformat, contract, inputs, workspace
from .appport import AppPort
from .bridge import Bridge
from .errors import InfraError, ModelError
from .permissions import Permissions
from .profiles import Profile
from .runlog import FORMAT_VERSION, RunLog
from .worker.manager import CellResult, Worker

USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
              "cost_usd")
EVENT_LIMITS = ("max_turns", "max_subcalls", "root_max_tokens", "output_max_chars", "cell_timeout_s",
                "subcall_max_chars", "subcall_max_tokens")  # run.started's `limits` (§5.3)
RMTREE_TRIES = 5
RMTREE_WAIT_S = 0.2


@dataclass
class RunSpec:
    run_id: str
    mode: str  # "read" | "repo"
    profile: Profile
    root: dict  # ModelRef
    sub: dict  # ModelRef
    permission_mode: str
    call_format: str  # "fenced" | "native", resolved by the app
    interactive: bool
    question: str | None
    inputs: list[Path]
    task: str | None
    repo_path: Path | None
    test_hint: str | None  # this and the next three: repo-mode overrides; inputs.prepare fills what is None (D-07)
    language: str | None
    n_files: int | None
    context: str | None
    tag: str | None
    batch: str
    log_path: Path


async def run(spec: RunSpec, app: AppPort, *, home: Path, worker_factory=Worker) -> dict:
    """Play one run to a submit, the turn limit or an infra error; emit every §5.3 event, append one run-log record
    and return it. Never raises except CancelledError."""
    started_at = time.time()
    clock = time.monotonic()

    def emit(method: str, params: dict) -> None:
        _emit(app, spec.run_id, method, params)

    repo_mode = spec.mode == "repo"
    limits: contract.Limits | None = None
    scratch = Path(home) / "scratch" / spec.run_id
    workspace_path = spec.repo_path if repo_mode else scratch
    base_tree: str | None = None
    diff: str | None = None
    messages: list[dict] = []
    turns: list[dict] = []
    root_usage = _zero_usage()
    submitted, answer, answer_valid = False, None, True
    infra_kind: str | None = None
    infra_error: str | None = None
    host_traceback: str | None = None
    cancelled = False
    perms: Permissions | None = None
    bridge: Bridge | None = None
    worker: Any = None

    try:
        inputs.prepare(spec)
        mode_settings = spec.profile.mode(spec.mode)
        limits = mode_settings.limits
        shell = workspace.find_shell()
        scratch.mkdir(parents=True, exist_ok=True)
        if repo_mode:
            base_tree = await _workspace_call(workspace.snapshot, spec.repo_path, scratch)

        system = spec.profile.system_prompt(shell.name)
        if repo_mode:
            first = contract.edit_first_message(spec.task, language=spec.language, n_files=spec.n_files,
                                                test_hint=spec.test_hint, limits=limits)
        else:
            first = contract.first_user_message(spec.question, spec.context, limits)
        messages = [{"role": "system", "content": system}, {"role": "user", "content": first}]

        perms = Permissions(run_id=spec.run_id, mode=spec.permission_mode, workspace=workspace_path, scratch=scratch,
                            repo_mode=repo_mode, interactive=spec.interactive, app=app)
        bridge = Bridge(run_id=spec.run_id, app=app, profile=spec.profile, mode=spec.mode, sub_ref=spec.sub,
                        permissions=perms)
        worker = worker_factory(mode=spec.mode, context=spec.context, workspace=workspace_path, scratch=scratch,
                                limits=limits, messages=contract.cell_messages(limits, edit=repo_mode),
                                on_request=bridge.handle, shell=shell, base_tree=base_tree)
        await worker.start()
        emit("run.started", {
            "tag": spec.tag, "mode": spec.mode, "profile": spec.profile.name,
            "prompt_hash": spec.profile.prompt_hash(), "profile_hash": spec.profile.profile_hash(),
            "contract_hash": contract.prompt_hash(contract.PROMPTS_V4), "call_format": spec.call_format,
            "root": spec.root, "sub": spec.sub, "permission_mode": spec.permission_mode,
            "workspace": str(workspace_path), "input": _input_info(spec),
            "limits": {key: getattr(limits, key) for key in EVENT_LIMITS}, "log_path": str(spec.log_path),
        })

        edited = False  # a repo run has changed a file in its workspace (pace_nudge)
        for index in range(limits.max_turns):
            turn = index + 1
            bridge.turn = worker.turn = turn
            asked = time.monotonic()
            reply = await app.complete({
                "run_id": spec.run_id, "role": "root", "model": spec.root, "messages": list(messages),
                "tools": callformat.tools_for(spec.call_format), "max_tokens": limits.root_max_tokens,
                "temperature": spec.profile.root_temperature, "thinking": spec.root.get("thinking") or "off",
                "turn": turn,
            })
            root_s = round(time.monotonic() - asked, 3)
            code = callformat.code_from_reply(spec.call_format, reply)
            assistant = callformat.assistant_message(spec.call_format, reply)
            messages.append(assistant)
            usage = reply.get("usage") or _zero_usage()
            _add_usage(root_usage, usage)
            emit("run.reply", {
                "turn": turn, "text": reply.get("text") or "", "tool_call": reply.get("tool_call"),
                "reasoning": reply.get("reasoning"), "finish_reason": reply.get("finish_reason"), "usage": usage,
                "seconds": root_s,
            })
            # in the log now, with empty cell fields, so a stop mid-cell still shows the reply
            entry = {
                "turn": turn, "reply": reply.get("text") or "", "tool_call": reply.get("tool_call"),
                "reasoning": reply.get("reasoning"), "finish_reason": reply.get("finish_reason"), "usage": usage,
                "code": code, "stdout": None, "stdout_chars": None, "error": None, "stderr": None,
                "observation": None, "restarted": None, "crash": None, "repo_changed": None, "root_s": root_s,
                "compute_s": None, "blocked_s": None, "wall_s": None,
            }
            turns.append(entry)

            result = CellResult("", 0, contract.no_code_error()) if code is None else await worker.run_cell(code)
            _cap_output(result, limits.output_max_chars)
            edited = edited or bool(result.repo_changed)
            entry.update(stdout=result.stdout, stdout_chars=result.stdout_chars, error=result.error,
                         stderr=result.stderr, restarted=result.restarted, crash=result.crash,
                         repo_changed=result.repo_changed, compute_s=round(result.compute_s, 3),
                         blocked_s=round(result.blocked_s, 3), wall_s=round(result.wall_s, 3))

            if bridge.infra_error:
                infra_kind, infra_error = _infra(bridge.infra_kind or "other", bridge.infra_error)
                emit("run.cell", _cell_event(turn, code, result, None))
                break
            if result.submitted:
                submitted, answer, answer_valid = True, result.answer, result.answer_valid
                emit("run.cell", _cell_event(turn, code, result, None))
                break
            turns_left = limits.max_turns - index - 1
            if turns_left:
                pace = (contract.pace_message(turns_left, limits.max_turns, edited)
                        if repo_mode and mode_settings.pace_nudge else None)
                entry["observation"] = contract.observation(result.stdout, result.stdout_chars, result.error,
                                                            turns_left, bridge.subcalls_left(),
                                                            max_chars=limits.output_max_chars, pace=pace)
                messages.append(callformat.observation_message(assistant, entry["observation"]))
            emit("run.cell", _cell_event(turn, code, result, entry["observation"]))
            emit("run.budget", {"turns_left": turns_left, "subcalls_left": bridge.subcalls_left()})

        if infra_error is None and repo_mode and base_tree is not None:
            diff = await _workspace_call(workspace.diff, spec.repo_path, base_tree, scratch)
    except asyncio.CancelledError:
        cancelled = True
        infra_kind = infra_error = "cancelled"
    except (ModelError, InfraError) as exc:
        infra_kind, infra_error = _infra(exc.kind, exc.message)
    except Exception as exc:  # a bug on the host: logged in full, never shown to the model
        infra_kind, infra_error = "host_bug", f"host error: {exc!r}"
        host_traceback = traceback.format_exc()
        _note(f"run {spec.run_id}: {host_traceback}")
    finally:
        # Each step runs whatever the one before it did. A second cancellation is noted and re-raised at the end.
        step = _Steps(spec.run_id)
        if worker is not None:
            await step.wait("close the worker", worker.close())
        step.call("cancel model calls", app.cancel_calls, spec.run_id)
        await step.wait("remove the scratch folder", asyncio.to_thread(_rmtree, scratch))
        try:
            record = _record(
                spec, started_at=started_at, wall_s=round(time.monotonic() - clock, 3), limits=limits,
                workspace_path=workspace_path, base_tree=base_tree, messages=messages, turns=turns,
                root_usage=root_usage, bridge=bridge, perms=perms, worker=worker, submitted=submitted,
                answer=answer, answer_valid=answer_valid, diff=diff, infra_error=infra_error,
                infra_kind=infra_kind, host_traceback=host_traceback,
            )
        except Exception as exc:  # still one line in the log, so the run is never silently missing
            record = {"format": FORMAT_VERSION, "run_id": spec.run_id, "tag": spec.tag, "batch": spec.batch,
                      "infra_error": f"host error: could not build the run record: {exc!r}", "infra_kind": "host_bug",
                      "host_traceback": traceback.format_exc()}
            _note(f"run {spec.run_id}: {record['host_traceback']}")
        step.call("write the run log", RunLog(spec.log_path).append, record)
        subcalls = bridge.subcalls_used if bridge is not None else 0
        step.call("send run.finished", emit, "run.finished", _finished_event(spec, record, subcalls))
        if cancelled or step.cancelled:
            raise asyncio.CancelledError
    return record


# ---------------------------------------------------------------------------------------------- the turn


def _cap_output(result: CellResult, max_chars: int) -> None:
    """Cut a cell's output to the episode's own cap. The REPL keeps bridge.OUTPUT_MAX_CHARS, the largest cap, so a
    prompt v1 episode is cut here to the 2,000 characters it ran with; transcripts and detectors see what the model saw."""
    result.stdout = result.stdout[:max_chars]
    if result.error is not None:
        result.error = result.error[:2 * max_chars]  # the sandbox's own error cut, at this episode's cap


def _shown(result: CellResult) -> str:
    """`run.cell.output`: stdout as the model sees it, with the truncation note when the cell printed more."""
    if result.stdout_chars > len(result.stdout):
        return result.stdout + contract.OBS_TRUNCATED.format(n=result.stdout_chars - len(result.stdout))
    return result.stdout


def _cell_event(turn: int, code: str | None, result: CellResult, observation: str | None) -> dict:
    return {"turn": turn, "code": code, "output": _shown(result), "error": result.error, "observation": observation,
            "seconds": round(result.compute_s, 3), "restarted": result.restarted, "crash": result.crash,
            "repo_changed": result.repo_changed}


async def _workspace_call(fn, *args: Any) -> Any:
    """workspace.snapshot or diff on a thread; their RuntimeError (a git failure, D-72) stops the run."""
    try:
        return await asyncio.to_thread(fn, *args)
    except RuntimeError as exc:
        raise InfraError("workspace", str(exc)) from exc


def _infra(kind: str, text: str) -> tuple[str, str]:
    """`(infra_kind, infra_error)`, with the kind in front of the text once."""
    return kind, text if text.startswith(f"{kind}: ") else f"{kind}: {text}"


# ---------------------------------------------------------------------------------------------- usage and the record


def _zero_usage() -> dict:
    return {key: 0.0 if key == "cost_usd" else 0 for key in USAGE_KEYS}


def _add_usage(total: dict, usage: dict | None) -> None:
    for key in USAGE_KEYS:
        value = (usage or {}).get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            total[key] += value


def _input_info(spec: RunSpec) -> dict:
    """The input as training measured it (env.run_episode), plus the input paths in read mode."""
    context = spec.context or ""
    return {
        "chars": len(context),
        "lines": len(context.splitlines()),
        "sha256": hashlib.sha256(context.encode("utf-8", "replace")).hexdigest(),
        "files": [Path(p).as_posix() for p in spec.inputs] if spec.mode == "read" else [],
    }


def _record(spec: RunSpec, *, started_at: float, wall_s: float, limits: contract.Limits | None, workspace_path: Path,
            base_tree: str | None, messages: list[dict], turns: list[dict], root_usage: dict, bridge: Bridge | None,
            perms: Permissions | None, worker: Any, submitted: bool, answer: Any, answer_valid: bool, diff: str | None,
            infra_error: str | None, infra_kind: str | None, host_traceback: str | None) -> dict:
    """The run-log record, keys in runlog.RECORD_KEYS order (§7.8)."""
    records = sorted(bridge.records, key=lambda r: r.subcall_id) if bridge is not None else []
    sub_usage = _zero_usage()
    for r in records:
        _add_usage(sub_usage, r.usage)
    reads = root_usage["cache_read_tokens"] + sub_usage["cache_read_tokens"]
    writes = root_usage["cache_write_tokens"] + sub_usage["cache_write_tokens"]
    prompt_tokens = root_usage["input_tokens"] + sub_usage["input_tokens"]
    key, text = ("task", spec.task) if spec.mode == "repo" else ("question", spec.question)
    return {
        "format": FORMAT_VERSION,
        "run_id": spec.run_id,
        "tag": spec.tag,
        "batch": spec.batch,
        "harness_version": __version__,
        "protocol": PROTOCOL_VERSION,
        "contract": contract.CONTRACT_VERSION,
        "contract_hash": contract.prompt_hash(contract.PROMPTS_V4),
        "prompt_hash": spec.profile.prompt_hash(),
        "profile": spec.profile.name,
        "profile_hash": spec.profile.profile_hash(),
        "mode": spec.mode,
        "call_format": spec.call_format,
        "root": spec.root,
        "sub": spec.sub,
        "permission_mode": spec.permission_mode,
        "limits": dataclasses.asdict(limits) if limits is not None else None,
        "started_at": started_at,
        "wall_s": wall_s,
        key: text,
        "input": _input_info(spec),
        "workspace": str(workspace_path),
        "base_tree": base_tree,
        "messages": messages,
        "turns": turns,
        "subcalls": [dataclasses.asdict(r) for r in records],
        "fetches": list(bridge.fetches) if bridge is not None else [],
        "permissions": list(perms.log) if perms is not None else [],
        "submitted": submitted,
        "answer": answer,
        "answer_valid": answer_valid,
        "usage": {"root": root_usage, "sub": sub_usage},
        "cost_usd": round(root_usage["cost_usd"] + sub_usage["cost_usd"], 6),
        "cache": {"read_tokens": reads, "write_tokens": writes,
                  "hit_rate": reads / prompt_tokens if prompt_tokens else None},  # D-22
        "timeouts": getattr(worker, "timeouts", 0),
        "crashes": getattr(worker, "crashes", 0),
        "restarts": getattr(worker, "restarts", 0),
        "diff": diff,
        "infra_error": infra_error,
        "infra_kind": infra_kind,
        "host_traceback": host_traceback,
    }


def _finished_event(spec: RunSpec, record: dict, subcalls: int) -> dict:
    """`.get` with defaults only for the fallback record a host bug in `_record` leaves."""
    return {
        "tag": spec.tag, "answer": record.get("answer"), "submitted": record.get("submitted", False),
        "answer_valid": record.get("answer_valid", True), "turns": len(record.get("turns", [])),
        "subcalls": subcalls, "usage": record.get("usage", {"root": _zero_usage(), "sub": _zero_usage()}),
        "cost_usd": record.get("cost_usd", 0.0), "infra_error": record["infra_error"],
        "infra_kind": record["infra_kind"], "wall_s": record.get("wall_s", 0.0), "log_path": str(spec.log_path),
    }


# ---------------------------------------------------------------------------------------------- plumbing


def _emit(app: AppPort, run_id: str, method: str, params: dict) -> None:
    """`app.event` with the run id added. A send that fails (the app is gone) is one stderr line, never a stop."""
    try:
        app.event(method, {"run_id": run_id, **params})
    except Exception as exc:
        _note(f"run {run_id}: could not send {method}: {exc!r}")


class _Steps:
    """The end of a run: every step runs even when the one before it failed or was cancelled."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.cancelled = False

    async def wait(self, what: str, awaitable: Any) -> None:
        try:
            await awaitable
        except asyncio.CancelledError:
            self.cancelled = True
        except Exception as exc:
            _note(f"run {self.run_id}: could not {what}: {exc!r}")

    def call(self, what: str, fn: Any, *args: Any) -> None:
        try:
            fn(*args)
        except Exception as exc:
            _note(f"run {self.run_id}: could not {what}: {exc!r}")


def _rmtree(path: Path) -> None:
    """Remove the scratch folder, clearing read-only bits, with retries: on Windows the folder can stay locked
    briefly after the worker is killed. A folder that stays is a stderr note, never an error."""

    def onexc(func: Any, target: str, exc: BaseException) -> None:
        if isinstance(exc, FileNotFoundError):
            return
        for p in (os.path.dirname(target), target):
            if not os.path.islink(p):
                try:
                    os.chmod(p, stat.S_IRWXU)
                except OSError:
                    pass
        func(target)

    for attempt in range(RMTREE_TRIES):
        try:
            shutil.rmtree(path, onexc=onexc)
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            if attempt + 1 == RMTREE_TRIES:
                _note(f"scratch folder left behind: {path} ({exc})")
                return
            time.sleep(RMTREE_WAIT_S)


def _note(text: str) -> None:
    try:
        sys.stderr.write(f"rlm_engine: {text.rstrip()}\n")
        sys.stderr.flush()
    except (OSError, ValueError):
        pass
