"""KV cache: a child run appends to its own message list and edits it only at a compaction (compaction.py), which keeps
its system prompt and first message byte for byte; its system prompt and tool list are the parent's, fixed for the run.

rlm() child runs (D-160), for the `default` profile's agent_api. A child is a run inside the run: a worker and a REPL of
its own, the parent's root model, the parent's system prompt, its own turn limit, and the parent's sub-call budget. It
starts from the parent's REPL (`rlm(task, context=None, tools="read", max_turns=None)`), and its submitted answer is the
value `rlm` returns there.

- `tools="read"`: in a coding task, the repository's reading tools (read_file, find_files, grep, diff); writes and
  commands are refused without asking (`ReadOnly`). In a reading task, `context` only.
- `tools="edit"`: a coding task's full tools, under the run's own permissions (the same prompts, the same remembered
  answers).
- `tools="none"`: `context` only.

Each child is one sub-call in the parent's budget and one row in the app (`run.subcall`); its root turns go to the app
as `model.complete` with role "sub" and a `child` field, and `run.child` reports its cells. Its own sub-calls draw on
the same budget, with `origin.child` set. `max_runs`, `max_depth` and `max_parallel` come from the profile's [rlm]; only the root's own children count against
`max_parallel`, and a child can start only children with tools no wider than its own.

Under a profile's [compaction] a child compacts as the run does (v1 step 3): before each of its turns, on the run's
`window` and the child's own limits, with the summary call sent as role "sub" with its `child` field and
`purpose: "compact"`; its usage counts as the child's, and `run.compacted` carries the child's id.
"""

from __future__ import annotations

import asyncio
import dataclasses
import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import callformat, compaction, contract, inputs
from .bridge import Bridge, SubcallRecord
from .errors import InfraError, ModelError
from .permissions import RENAME_SEP, Permissions
from .profiles import Profile
from .workspace import SNAPSHOT_OBJECTS
from .worker.manager import CellResult

READ_TOOLS = ["read_file", "find_files", "grep", "diff"]
TOOL_RANK = {"none": 0, "read": 1, "edit": 2}
USAGE_KEYS = ("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens",
              "cost_usd")

READ_ONLY_NOTE = ("\n\nThis run was started by another run to find something out. The repository is at /work/repo, and "
                  "the REPL has read_file, find_files, grep and diff for it; writing files and running commands are "
                  "refused. When you know the answer, submit() it: it is returned to the run that started you.")
CONTEXT_NOTE = ("\n\nThis run was started by another run, which passed you `context` ({n:,} characters) and is waiting "
                "for what you submit().")
EDIT_CONTEXT_NOTE = ("\n\nThis run was started by another run. `context` holds text it passed you ({n:,} characters), not "
                     "the file list; find files with find_files.")


class ReadOnly:
    """A read-only child's permissions: writes inside its scratch folder go ahead, fetches ask as the run's do, and
    every other write or command is refused without asking (and logged on the run's permissions)."""

    read_only = True

    def __init__(self, run: Permissions, scratch: Path) -> None:
        self.run = run
        self.scratch = scratch
        self.interactive = run.interactive

    async def check(self, kind: str, detail: str, *, inside_workspace: bool, turn: int) -> bool:
        if kind == "network":
            return await self.run.check(kind, detail, inside_workspace=inside_workspace, turn=turn)
        if kind == "write" and all(_under(path, self.scratch) for path in detail.split(RENAME_SEP)):
            return True  # a rename (`src -> dst`, D-47) only when both ends are in the scratch folder
        self.run._record(turn, kind, detail, allowed=False, asked=False, remembered=False)
        return False


def _under(detail: str, folder: Path) -> bool:
    try:
        return Path(detail).resolve().is_relative_to(folder.resolve())
    except (OSError, ValueError):
        return False


@dataclass
class ChildRun:
    child_id: int
    subcall_id: int
    depth: int
    parent_child: int | None
    task: str
    tools: str
    max_turns: int
    origin: dict
    batch: dict
    turn: int = 0  # the child's turn now: the origin of its requests
    turns: list[dict] = field(default_factory=list)
    usage: dict = field(default_factory=lambda: {k: 0.0 if k == "cost_usd" else 0 for k in USAGE_KEYS})
    submitted: bool = False
    answer: Any = None
    error: str | None = None
    seconds: float = 0.0

    def record(self) -> dict:
        return {"child_id": self.child_id, "subcall_id": self.subcall_id, "parent_child": self.parent_child,
                "depth": self.depth, "task": self.task, "tools": self.tools, "max_turns": self.max_turns,
                "turns": self.turns, "submitted": self.submitted, "answer": self.answer, "error": self.error,
                "usage": self.usage, "seconds": round(self.seconds, 3)}


class _ChildBridge:
    """A child worker's requests: sub-calls and fetches through the run's bridge, approvals through the child's own
    permissions, and `rlm` back to `Children` with this child as the parent."""

    def __init__(self, children: "Children", child: ChildRun, permissions: Any) -> None:
        self.children = children
        self.child = child
        self.permissions = permissions

    async def handle(self, request: dict) -> dict:
        bridge = self.children.bridge
        op = request.get("op") if isinstance(request, dict) else None
        if op in ("llm", "llm_batch"):
            return await bridge._llm(op, request, self.child)
        if op == "fetch":
            return await bridge._fetch(request)
        if op == "approve":
            return await bridge._approve(request, self.permissions)
        if op == "rlm":
            return await self.children.run(request, self.child)
        return {"error": "unknown request"}


class Children:
    """The rlm() children of one run."""

    def __init__(self, *, run_id: str, app: Any, profile: Profile, mode: str, root: dict, call_format: str,
                 bridge: Bridge, permissions: Permissions, shell: Any, scratch: Path, repo_path: Path | None,
                 base_tree: str | None, test_hint: str | None, language: str | None, worker_factory: Any,
                 emit: Any, window: dict | None = None, compactions: list[dict] | None = None) -> None:
        self.run_id = run_id
        self.app = app
        self.profile = profile
        self.settings = profile.rlm
        self.mode = mode
        self.root = root
        self.call_format = call_format
        self.bridge = bridge
        self.permissions = permissions
        self.shell = shell
        self.scratch = scratch
        self.repo_path = repo_path
        self.base_tree = base_tree
        self.test_hint = test_hint
        self.language = language
        self.worker_factory = worker_factory
        self.emit = emit
        self.window = window or {"context_window": 0, "max_output": 0}  # run.start's, for compaction.plan
        self.compactions = compactions if compactions is not None else []  # the run's record list, shared
        self.started = 0
        self.runs: list[ChildRun] = []
        self._slots = asyncio.Semaphore(self.settings.max_parallel)

    def records(self) -> list[dict]:
        return [c.record() for c in sorted(self.runs, key=lambda c: c.child_id)]

    async def run(self, request: dict, parent: ChildRun | None) -> dict:
        """The reply fields for an `rlm` request: `{"answer": ..., "turns": n}` or `{"error": ...}`."""
        task, context, tools, max_turns = (request.get("task"), request.get("context"), request.get("tools"),
                                           request.get("max_turns"))
        if not isinstance(task, str) or not task.strip() or tools not in ("read", "edit", "none") or not (
                context is None or isinstance(context, str)) or not (
                max_turns is None or (isinstance(max_turns, int) and not isinstance(max_turns, bool) and max_turns > 0)):
            return {"error": "malformed request"}
        depth = (parent.depth if parent else 0) + 1
        if depth > self.settings.max_depth:
            return {"error": f"rlm() cannot start a run from inside an rlm() run here (at most {self.settings.max_depth} "
                             "level deep); do the work in this run"}
        if tools == "edit" and self.mode != "repo":
            return {"error": "rlm(tools=\"edit\") works only in coding tasks"}
        if parent is not None and TOOL_RANK[tools] > TOOL_RANK[parent.tools]:  # never more than the run that asks
            return {"error": f"an rlm() run with tools=\"{parent.tools}\" cannot start one with tools=\"{tools}\""}
        if self.started >= self.settings.max_runs:
            return {"error": f"this task has started all {self.settings.max_runs} rlm() runs it may; do the rest "
                             "with llm_batch or in this run"}
        child_no = self.started + 1
        reserved = self.bridge.reserve_child(request, task, parent, child_no)
        if isinstance(reserved, dict):
            return reserved
        self.started = child_no
        subcall_id, origin, batch = reserved
        turns = min(max_turns or self.settings.max_turns, self.settings.max_turns)
        child = ChildRun(child_id=child_no, subcall_id=subcall_id, depth=depth,
                         parent_child=parent.child_id if parent else None, task=task, tools=tools, max_turns=turns,
                         origin=origin, batch=batch)
        self.runs.append(child)
        started = time.monotonic()
        self._event(child, "started")
        try:
            if parent is None:
                async with self._slots:
                    await self._play(child, context)
            else:  # a descendant: its ancestor holds a slot while it waits, so taking one could deadlock
                await self._play(child, context)
        except BaseException as exc:
            child.error = child.error or _error_text(exc)
            raise
        finally:
            child.seconds = time.monotonic() - started
            output = json.dumps(child.answer) if child.submitted else None
            self.bridge.finish_child(SubcallRecord(subcall_id, dict(origin), dict(batch), task, output, child.error,
                                                   child.seconds, dict(child.usage)))
            self._event(child, "error" if child.error else "done")
        if child.error:
            return {"error": child.error}
        return {"answer": child.answer, "turns": len(child.turns)}

    # ------------------------------------------------------------------------------------------ one child

    async def _play(self, child: ChildRun, context: str | None) -> None:
        repo = self.mode == "repo" and child.tools in ("read", "edit")
        mode = "repo" if repo else "read"
        limits = dataclasses.replace(self.profile.mode(mode).limits, max_turns=child.max_turns)
        scratch = self.scratch / f"rlm-{child.child_id}"  # inside the run's, so the run's permissions allow it
        scratch.mkdir(parents=True, exist_ok=True)
        if repo:
            files = await asyncio.to_thread(inputs.repo_files, self.repo_path)
            value = context if context is not None else inputs.repo_context(child.task, files)
            if child.tools == "edit":
                first = contract.edit_first_message(child.task, language=self.language or inputs.detect_language(files),
                                                    n_files=len(files), test_hint=self.test_hint or inputs.NO_TEST_COMMAND,
                                                    limits=limits)
                if context is not None:
                    first += EDIT_CONTEXT_NOTE.format(n=len(context))
            else:
                first = contract.first_user_message(child.task, value, limits) + READ_ONLY_NOTE
        else:
            value = context or ""
            first = contract.first_user_message(child.task, value, limits) + CONTEXT_NOTE.format(n=len(value))
        permissions = self.permissions if child.tools == "edit" else ReadOnly(self.permissions, scratch)
        messages = [{"role": "system", "content": self.profile.system_prompt(self.shell.name)},
                    {"role": "user", "content": first}]
        worker = self.worker_factory(
            mode=mode, context=value, workspace=self.repo_path if repo else scratch, scratch=scratch, limits=limits,
            messages=contract.cell_messages(limits, edit=repo), on_request=_ChildBridge(self, child, permissions).handle,
            shell=self.shell, base_tree=self.base_tree if repo else None, cache_api=self.profile.cache_api,
            init_extra={**self.init_extra(mode=mode, task=child.task,
                                          tool_names=READ_TOOLS if child.tools == "read" else None),
                        # diff() finds the base tree where the run's snapshot put it
                        **({"snapshot_objects": str(self.scratch / SNAPSHOT_OBJECTS)} if repo else {})})
        try:
            await worker.start()
            await self._turns(child, worker, messages, limits)
        finally:
            await worker.close()

    def init_extra(self, *, mode: str, task: str | None, tool_names: list[str] | None,
                   input_files: list[str] | None = None) -> dict:
        """The worker init fields agent_api adds (D-157), for the run's own worker and each child's."""
        return {"agent_api": True, "task": task if mode == "repo" else None,
                "test_hint": self.test_hint if mode == "repo" else None, "input_files": input_files or [],
                "tool_names": tool_names}

    def _request(self, child: ChildRun, turn: int, messages: list[dict]) -> dict:
        """A child's `model.complete` params: role "sub" with its sub-call id, origin, batch and `child`."""
        return {"run_id": self.run_id, "role": "sub", "model": self.root, "messages": messages,
                "tools": callformat.tools_for(self.call_format), "turn": turn, "subcall_id": child.subcall_id,
                "origin": dict(child.origin), "batch": dict(child.batch),
                "child": {"id": child.child_id, "turn": turn, "max_turns": child.max_turns, "depth": child.depth}}

    async def _turns(self, child: ChildRun, worker: Any, messages: list[dict], limits: contract.Limits) -> None:
        settings = self.profile.compaction
        plan = compaction.plan(settings, self.window, limits.root_max_tokens) if settings else None
        last_usage: dict | None = None  # as loop.run keeps them (v1 step 3)
        chars_since = 0
        compacting = plan is not None
        for index in range(child.max_turns):
            turn = index + 1
            worker.turn = child.turn = turn
            if compacting and index:
                before = compaction.estimate(messages, last_usage, chars_since)
                if before > plan.trigger:
                    body = await self._compact(child, turn, messages, plan, before)
                    if body is not None:
                        last_usage, chars_since = None, 0
                        self.compactions.append(body)
                        self.emit("run.compacted", body)
                        compacting = body["after_tokens"] <= compaction.NO_LOOP_RATIO * before
            asked = time.monotonic()
            try:
                reply = await self.app.complete({
                    **self._request(child, turn, list(messages)), "max_tokens": limits.root_max_tokens,
                    "temperature": self.profile.root_temperature, "thinking": self.root.get("thinking") or "off",
                })
            except ModelError as exc:
                if exc.kind == "bad_request":  # the model's to see, as a sub-call's is (D-06)
                    child.error = f"rlm() run failed: {exc.message}"
                    return
                raise InfraError(exc.kind, exc.message) from None
            code = callformat.code_from_reply(self.call_format, reply)
            assistant = callformat.assistant_message(self.call_format, reply)
            messages.append(assistant)
            usage = reply.get("usage") or {}
            _add_usage(child.usage, usage)
            last_usage, chars_since = usage, 0
            # in the record now, with empty cell fields, so a stop mid-cell still shows the reply (as loop.py does)
            entry = {"turn": turn, "reply": reply.get("text") or "", "tool_call": reply.get("tool_call"),
                     "reasoning": reply.get("reasoning"), "finish_reason": reply.get("finish_reason"), "usage": usage,
                     "code": code, "stdout": None, "stdout_chars": None, "error": None, "observation": None,
                     "root_s": round(time.monotonic() - asked, 3)}
            child.turns.append(entry)
            result = CellResult("", 0, contract.no_code_error()) if code is None else await worker.run_cell(code)
            result.stdout = result.stdout[:limits.output_max_chars]
            if result.error is not None:
                result.error = result.error[:2 * limits.output_max_chars]
            entry.update(stdout=result.stdout, stdout_chars=result.stdout_chars, error=result.error)
            if self.bridge.infra_error:
                raise InfraError(self.bridge.infra_kind or "other", self.bridge.infra_error)
            if result.submitted:
                child.submitted, child.answer = True, result.answer
                self._event(child, "turn", entry)
                return
            turns_left = child.max_turns - turn
            if turns_left:
                entry["observation"] = contract.observation(result.stdout, result.stdout_chars, result.error, turns_left,
                                                            self.bridge.subcalls_left(),
                                                            max_chars=limits.output_max_chars)
                messages.append(callformat.observation_message(assistant, entry["observation"]))
                chars_since += len(entry["observation"])
            self._event(child, "turn", entry)
        child.error = (f"the rlm() run used all {child.max_turns} of its turns without calling submit(); give it a "
                       "smaller task or more turns")

    async def _compact(self, child: ChildRun, turn: int, messages: list[dict], plan: compaction.Plan,
                       before: int) -> dict | None:
        """loop._compact for a child: the summary call is the child's own request with `purpose: "compact"`, its usage
        is the child's (so it lands in usage.sub), a `bad_request` or `context_window` gives the mechanical summary
        (D-200), and any other ModelError stops the run, as a child turn's does."""
        settings = self.profile.compaction
        started = time.monotonic()

        async def summarize(request: list[dict]) -> str:
            try:
                reply = await self.app.complete({
                    **self._request(child, turn, request), "purpose": "compact",
                    "max_tokens": settings.summary_max_tokens, "temperature": self.profile.root_temperature,
                    "thinking": "off",
                })
            except ModelError as exc:
                if exc.kind in ("bad_request", "context_window"):
                    return ""
                raise InfraError(exc.kind, exc.message) from None
            _add_usage(child.usage, reply.get("usage") or {})
            return reply.get("text") or ""

        result = await compaction.compact(messages, keep_tokens=plan.keep, summarize=summarize,
                                          summary_max_tokens=settings.summary_max_tokens)
        if result is None:
            return None
        messages[:] = result.messages
        return {"turn": turn, "prompt_index": 0, "child_id": child.child_id, "before_tokens": before,
                "after_tokens": compaction.estimate(messages, None, 0), "dropped_messages": result.dropped,
                "kept_messages": result.kept, "summary_chars": len(result.summary),
                "seconds": round(time.monotonic() - started, 3)}

    def _event(self, child: ChildRun, status: str, entry: dict | None = None) -> None:
        self.emit("run.child", {
            "child_id": child.child_id, "subcall_id": child.subcall_id, "depth": child.depth, "status": status,
            "task": child.task, "tools": child.tools, "turn": entry["turn"] if entry else len(child.turns),
            "max_turns": child.max_turns, "code": entry["code"] if entry else None,
            "output": entry["stdout"] if entry else None, "error": entry["error"] if entry else child.error,
            "answer": child.answer if status == "done" else None,
            "seconds": round(child.seconds, 3) if status in ("done", "error") else None,
        })


def _add_usage(total: dict, usage: dict) -> None:
    for key in USAGE_KEYS:
        value = usage.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            total[key] += value


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, asyncio.CancelledError):
        return "cancelled"
    message = getattr(exc, "message", None)
    return f"rlm() run stopped: {message or exc!r}"
