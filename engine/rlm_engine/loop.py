"""KV cache: appends to one message list (a follow-up's note and question only after its last message, followup.py) and edits it only at a compaction (compaction.py), which keeps the system prompt and first message byte for byte; the tool list is fixed for the run.

One run: training's `run_episode` (rlm_rl/env.py at RLM commit 0b9af69) against any model through the app, with
`_cap_output` copied. Left out, as the build plan lists: token ids, logprobs, rewards, detectors, the grader,
broken-reply redraws and format penalties. Added: the §5.3 events, the run-log record (§7.8), native tool calls
(callformat, 6b), the permission modes, a scratch folder that is removed when the run ends (D-12), and under a
profile's agent_api the rlm() children (child.py, D-160), and under a profile's [compaction] the summary that replaces the
middle of a conversation that outgrows its window (compaction.py, v1 step 3), and with `conversation` one run that
answers several prompts on the same REPL, one record each (v1 step 4).

`run` never raises, except CancelledError, and that only after the record is written and `run.finished` sent.
"""

from __future__ import annotations

import asyncio
import contextlib
import dataclasses
import hashlib
import os
import shutil
import stat
import sys
import time
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import PROTOCOL_VERSION, __version__, callformat, compaction, contract, followup, inputs, workspace
from .appport import AppPort
from .bridge import Bridge
from .child import Children
from .errors import InfraError, ModelError
from .permissions import Permissions
from .profiles import Profile
from .runlog import FORMAT_VERSION, RunLog
from .worker.manager import CellResult, Worker

USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
              "cost_usd")
EVENT_LIMITS = ("max_turns", "max_subcalls", "root_max_tokens", "output_max_chars", "cell_timeout_s",
                "subcall_max_chars", "subcall_max_tokens")  # run.started's `limits` (§5.3)
# A cell that waits on an rlm() child waits for a whole run, so agent_api raises the worker's wall cap from 30 minutes
# (manager.Worker's default) to three hours (D-160).
AGENT_WALL_CAP_S = 3 * 3600.0
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
    input_spans: list[dict] | None = None  # read mode: each input's place in `context` (inputs.prepare, D-157)
    # the root model's catalog numbers from run.start, 0 when unknown (v1 step 3)
    window: dict = field(default_factory=lambda: {"context_window": 0, "max_output": 0})
    conversation: bool = False  # the run waits for run.say after each prompt (v1 step 4; the interactive app only)


class Inbox:
    """A conversation's next questions (v1 step 4): `run.say` puts one, `run.close` puts None. `waiting` is true only
    while the loop waits between prompts, so `run.say` can refuse a busy run (-32013)."""

    def __init__(self) -> None:
        self.prompt_index = 0
        self.waiting = False
        self._queue: asyncio.Queue[str | None] = asyncio.Queue()

    def put(self, text: str) -> int:
        self.waiting = False
        self.prompt_index += 1
        self._queue.put_nowait(text)
        return self.prompt_index

    def close(self) -> None:
        self._queue.put_nowait(None)

    async def next(self) -> str | None:
        return await self._queue.get()


async def run(spec: RunSpec, app: AppPort, *, home: Path, worker_factory=Worker, inbox: Inbox | None = None) -> dict:
    """Play one run to a submit, the turn limit or an infra error; emit every §5.3 event, append one run-log record
    and return it. Never raises except CancelledError.

    With `spec.conversation` and an `inbox` (v1 step 4, §5), a prompt that ends without an infra error writes its
    record, sends `run.finished {open: true}` and waits for the next question, on the same worker, bridge, scratch
    folder and message list; `None` from the inbox, a cancel or an infra error ends it with `run.closed`. The record
    returned is the last prompt's."""
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
    compactions: list[dict] = []  # run.compacted bodies without run_id, for the records
    root_usage = _zero_usage()
    submitted, answer, answer_valid = False, None, True
    infra_kind: str | None = None
    infra_error: str | None = None
    host_traceback: str | None = None
    cancelled = False
    perms: Permissions | None = None
    bridge: Bridge | None = None
    children: Children | None = None
    worker: Any = None
    prompt = 0  # the prompt index, 0 for a one-shot run
    text = spec.task if repo_mode else spec.question  # this prompt's question or task
    in_prompt = True  # a prompt (or the setup) is in flight: the `finally` writes its record
    bases = _Bases()
    record: dict = {}

    try:
        inputs.prepare(spec)
        mode_settings = spec.profile.mode(spec.mode)
        limits = mode_settings.limits
        plan = (compaction.plan(spec.profile.compaction, spec.window, limits.root_max_tokens)
                if spec.profile.compaction else None)
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
        init_extra = None
        if spec.profile.agent_api:  # never training-v4: its worker's init and REPL stay training's (D-157)
            children = bridge.children = Children(
                run_id=spec.run_id, app=app, profile=spec.profile, mode=spec.mode, root=spec.root,
                call_format=spec.call_format, bridge=bridge, permissions=perms, shell=shell, scratch=scratch,
                repo_path=spec.repo_path, base_tree=base_tree, test_hint=spec.test_hint, language=spec.language,
                worker_factory=worker_factory, emit=emit, window=spec.window, compactions=compactions)
            init_extra = children.init_extra(mode=spec.mode, task=spec.task, tool_names=None,
                                             input_files=spec.input_spans or [Path(p).as_posix() for p in spec.inputs])
        worker = worker_factory(mode=spec.mode, context=spec.context, workspace=workspace_path, scratch=scratch,
                                limits=limits, messages=contract.cell_messages(limits, edit=repo_mode),
                                on_request=bridge.handle, shell=shell, base_tree=base_tree,
                                cache_api=spec.profile.cache_api,
                                **({"init_extra": init_extra, "wall_cap_s": AGENT_WALL_CAP_S} if init_extra else {}))
        await worker.start()
        emit("run.started", {
            "tag": spec.tag, "mode": spec.mode, "profile": spec.profile.name,
            "prompt_hash": spec.profile.prompt_hash(), "profile_hash": spec.profile.profile_hash(),
            "contract_hash": contract.prompt_hash(contract.PROMPTS_V4), "call_format": spec.call_format,
            "root": spec.root, "sub": spec.sub, "permission_mode": spec.permission_mode,
            "workspace": str(workspace_path), "input": _input_info(spec),
            "limits": {key: getattr(limits, key) for key in EVENT_LIMITS}, "log_path": str(spec.log_path),
            "window": dict(spec.window), "compaction": plan.as_event() if plan else None,
            "conversation": spec.conversation,
        })

        last_usage: dict | None = None  # the latest reply's usage, for compaction.estimate
        chars_since = 0  # characters appended since that reply
        while True:
            # one prompt: its own turns, usage, answer and budgets (D-199); the REPL and the messages go on
            bridge.start_prompt()
            if children is not None:
                children.start_prompt(prompt)
            bases = _Bases.now(perms, worker, compactions)
            if prompt:
                started_at, clock = time.time(), time.monotonic()
                turns, root_usage, diff = [], _zero_usage(), None
                follow = followup.follow_up_messages(messages[-1], submitted=submitted, text=text, mode=spec.mode,
                                                     turns_left=limits.max_turns,
                                                     subcalls_left=bridge.subcalls_left())
                submitted, answer, answer_valid = False, None, True
                messages.extend(follow)
                chars_since += sum(len(m["content"]) for m in follow)
            edited = False  # a repo run has changed a file in its workspace during this prompt (pace_nudge)
            compacting = plan is not None  # off for the rest of the prompt after a compaction that barely helped
            for index in range(limits.max_turns):
                turn = index + 1
                bridge.turn = worker.turn = turn
                if compacting and (index or prompt):
                    before = compaction.estimate(messages, last_usage, chars_since)
                    if before > plan.trigger:
                        body = await _compact(spec, app, messages, plan, turn, before, root_usage, prompt)
                        if body is not None:
                            last_usage, chars_since = None, 0
                            compactions.append(body)
                            emit("run.compacted", body)
                            compacting = body["after_tokens"] <= compaction.NO_LOOP_RATIO * before
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
                last_usage, chars_since = usage, 0
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
                    chars_since += len(entry["observation"])
                emit("run.cell", _cell_event(turn, code, result, entry["observation"]))
                emit("run.budget", {"turns_left": turns_left, "subcalls_left": bridge.subcalls_left()})

            is_open = spec.conversation and inbox is not None and infra_error is None
            if children is not None and children.started and not is_open:
                # rlm() children still running (rlm_async) end with the worker, before the diff, so none edits after
                # it; between a conversation's prompts nothing is cancelled (D-203)
                await worker.close()
            if infra_error is None and repo_mode and base_tree is not None:
                diff = await _workspace_call(workspace.diff, spec.repo_path, base_tree, scratch)
            if not is_open:
                break  # the `finally` writes this prompt's record after the clean-up, as for a one-shot run

            # the prompt ends with the conversation open: its record and run.finished now, then the next question
            in_prompt = False
            record = _record(
                spec, started_at=started_at, wall_s=round(time.monotonic() - clock, 3), limits=limits,
                workspace_path=workspace_path, base_tree=base_tree, messages=messages, turns=turns,
                compactions=compactions, root_usage=root_usage, bridge=bridge, children=children, perms=perms,
                worker=worker, submitted=submitted, answer=answer, answer_valid=answer_valid, diff=diff,
                infra_error=None, infra_kind=None, host_traceback=None, bases=bases, prompt_index=prompt, text=text,
            )
            try:
                RunLog(spec.log_path).append(record)
            except Exception as exc:  # no durable record: this prompt fails, and the conversation ends with it
                _note(f"run {spec.run_id}: could not write the run log: {exc!r}")
                record = _log_failed(record, spec.log_path, exc)
                emit("run.finished", _finished_event(spec, record, bridge.prompt_used(), prompt, False))
                break
            emit("run.finished", _finished_event(spec, record, bridge.prompt_used(), prompt, True))
            inbox.waiting = True
            question = await inbox.next()
            inbox.waiting = False
            if question is None:
                break
            prompt, text, in_prompt = inbox.prompt_index, question, True
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
        if in_prompt:  # the prompt in flight (or the setup): its record and run.finished, as v0 writes them
            try:
                record = _record(
                    spec, started_at=started_at, wall_s=round(time.monotonic() - clock, 3), limits=limits,
                    workspace_path=workspace_path, base_tree=base_tree, messages=messages, turns=turns,
                    compactions=compactions, root_usage=root_usage, bridge=bridge, children=children, perms=perms,
                    worker=worker, submitted=submitted, answer=answer, answer_valid=answer_valid, diff=diff,
                    infra_error=infra_error, infra_kind=infra_kind, host_traceback=host_traceback, bases=bases,
                    prompt_index=prompt, text=text,
                )
            except Exception as exc:  # still one line in the log, so the run is never silently missing
                record = {"format": FORMAT_VERSION, "run_id": spec.run_id, "tag": spec.tag, "batch": spec.batch,
                          "infra_error": f"host error: could not build the run record: {exc!r}",
                          "infra_kind": "host_bug", "host_traceback": traceback.format_exc()}
                _note(f"run {spec.run_id}: {record['host_traceback']}")
            log_failure = step.call("write the run log", RunLog(spec.log_path).append, record)
            if log_failure is not None:  # no durable record: the run fails, so the CLI exits 1, but the answer stays
                record = _log_failed(record, spec.log_path, log_failure)
            subcalls = bridge.prompt_used() if bridge is not None else 0
            step.call("send run.finished", emit, "run.finished", _finished_event(spec, record, subcalls, prompt, False))
        if spec.conversation:
            step.call("send run.closed", emit, "run.closed", {"prompts": prompt + 1})
        if cancelled or step.cancelled:
            raise asyncio.CancelledError
    return record


@dataclass
class _Bases:
    """Where this prompt's slices start in the run-long lists and counters, so its record holds only its own."""
    permissions: int = 0
    compactions: int = 0
    timeouts: int = 0
    crashes: int = 0
    restarts: int = 0

    @classmethod
    def now(cls, perms: Permissions, worker: Any, compactions: list[dict]) -> _Bases:
        return cls(len(perms.log), len(compactions), getattr(worker, "timeouts", 0), getattr(worker, "crashes", 0),
                   getattr(worker, "restarts", 0))


# ---------------------------------------------------------------------------------------------- the turn


async def _compact(spec: RunSpec, app: AppPort, messages: list[dict], plan: compaction.Plan, turn: int, before: int,
                   root_usage: dict, prompt_index: int = 0) -> dict | None:
    """One compaction before root turn `turn` (§4.2): `messages` is replaced in place and the run.compacted body
    (without run_id) returned, or None when there was nothing to drop. The summary call is the run's own root call
    with `purpose: "compact"`, so its prefix is a cache hit; its usage counts in `usage.root`, and it is not a turn.
    A `bad_request` or `context_window` error gives the mechanical summary (D-200); any other ModelError stops the
    run, as a root call's does."""
    settings = spec.profile.compaction
    started = time.monotonic()

    async def summarize(request: list[dict]) -> str:
        try:
            reply = await app.complete({
                "run_id": spec.run_id, "role": "root", "purpose": "compact", "model": spec.root, "messages": request,
                "tools": callformat.tools_for(spec.call_format), "max_tokens": settings.summary_max_tokens,
                "temperature": spec.profile.root_temperature, "thinking": "off", "turn": turn,
            })
        except ModelError as exc:
            if exc.kind in ("bad_request", "context_window"):
                return ""
            raise
        _add_usage(root_usage, reply.get("usage"))
        return reply.get("text") or ""

    result = await compaction.compact(messages, keep_tokens=plan.keep, summarize=summarize,
                                      summary_max_tokens=settings.summary_max_tokens)
    if result is None:
        return None
    messages[:] = result.messages
    return {"turn": turn, "prompt_index": prompt_index, "child_id": None, "before_tokens": before,
            "after_tokens": compaction.estimate(messages, None, 0), "dropped_messages": result.dropped,
            "kept_messages": result.kept, "summary_chars": len(result.summary),
            "seconds": round(time.monotonic() - started, 3)}


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
    """workspace.snapshot or diff on a thread; their RuntimeError (a git failure or timeout, D-72) stops the run.

    A cancel kills the git call that is running and waits for the thread to end before it goes on, so the record,
    the scratch folder's removal and run.finished all come after git is gone."""
    control = workspace.GitControl()
    work = asyncio.ensure_future(asyncio.to_thread(fn, *args, control=control))
    try:
        return await asyncio.shield(work)
    except asyncio.CancelledError:
        control.abort()
        while not work.done():  # a second cancel still waits: the thread ends once its git call is killed
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.wait({work})  # never raises what the call raised
        if not work.cancelled():
            work.exception()  # retrieved: the cancel is what this run ends with
        raise
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
            base_tree: str | None, messages: list[dict], turns: list[dict], compactions: list[dict], root_usage: dict, bridge: Bridge | None,
            children: Children | None, perms: Permissions | None, worker: Any, submitted: bool, answer: Any, answer_valid: bool, diff: str | None,
            infra_error: str | None, infra_kind: str | None, host_traceback: str | None, bases: _Bases | None = None,
            prompt_index: int = 0, text: str | None = None) -> dict:
    """One prompt's run-log record, keys in runlog.RECORD_KEYS order (§7.8, v1 §3.4): its own turns, sub-calls,
    children, fetches, permissions, compactions, usage and worker counters, with the whole message list. A one-shot
    run's one prompt is the whole run."""
    bases = bases or _Bases()
    records = bridge.prompt_records() if bridge is not None else []
    sub_usage = _zero_usage()
    for r in records:
        _add_usage(sub_usage, r.usage)
    reads = root_usage["cache_read_tokens"] + sub_usage["cache_read_tokens"]
    writes = root_usage["cache_write_tokens"] + sub_usage["cache_write_tokens"]
    prompt_tokens = root_usage["input_tokens"] + sub_usage["input_tokens"]
    key = "task" if spec.mode == "repo" else "question"
    if text is None:
        text = spec.task if spec.mode == "repo" else spec.question
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
        "children": children.records() if children is not None else [],
        "fetches": list(bridge.fetches[bridge.fetch_base:]) if bridge is not None else [],
        "permissions": list(perms.log[bases.permissions:]) if perms is not None else [],
        "submitted": submitted,
        "answer": answer,
        "answer_valid": answer_valid,
        "usage": {"root": root_usage, "sub": sub_usage},
        "cost_usd": round(root_usage["cost_usd"] + sub_usage["cost_usd"], 6),
        "cache": {"read_tokens": reads, "write_tokens": writes,
                  "hit_rate": reads / prompt_tokens if prompt_tokens else None},  # D-22
        "timeouts": getattr(worker, "timeouts", 0) - bases.timeouts,
        "crashes": getattr(worker, "crashes", 0) - bases.crashes,
        "restarts": getattr(worker, "restarts", 0) - bases.restarts,
        "diff": diff,
        "infra_error": infra_error,
        "infra_kind": infra_kind,
        "host_traceback": host_traceback,
        "window": dict(spec.window),
        "compactions": compactions[bases.compactions:],
        "prompt_index": prompt_index,
        "conversation": spec.conversation,
    }


def _log_failed(record: dict, log_path: Path, exc: Exception) -> dict:
    """The record as run.finished reports it when the run log could not be written: infra_kind "runlog", or, for a
    run that had already failed, its own kind with the log failure added to the message."""
    note = f"runlog: could not write the run log {log_path}: {exc!r}"
    if record.get("infra_error") is None:
        return {**record, "infra_error": note, "infra_kind": "runlog"}
    return {**record, "infra_error": f"{record['infra_error']}; {note}"}


def _finished_event(spec: RunSpec, record: dict, subcalls: int, prompt_index: int, is_open: bool) -> dict:
    """`.get` with defaults only for the fallback record a host bug in `_record` leaves. `subcalls` counts this
    prompt's; `open` is true when a conversation waits for run.say (v1 step 4)."""
    return {
        "tag": spec.tag, "answer": record.get("answer"), "submitted": record.get("submitted", False),
        "answer_valid": record.get("answer_valid", True), "turns": len(record.get("turns", [])),
        "subcalls": subcalls, "usage": record.get("usage", {"root": _zero_usage(), "sub": _zero_usage()}),
        "cost_usd": record.get("cost_usd", 0.0), "infra_error": record["infra_error"],
        "infra_kind": record["infra_kind"], "wall_s": record.get("wall_s", 0.0), "log_path": str(spec.log_path),
        "prompt_index": prompt_index, "open": is_open,
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

    def call(self, what: str, fn: Any, *args: Any) -> Exception | None:
        """None when `fn` ran, else the exception it raised (noted on stderr)."""
        try:
            fn(*args)
        except Exception as exc:
            _note(f"run {self.run_id}: could not {what}: {exc!r}")
            return exc
        return None


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
