"""KV cache: none

`FakeApp`, the scripted AppPort the engine tests use instead of a pipe (architecture §7.2).
It records every call. `script=` serves root replies and sub-call answers in the format of the
app's fake provider (architecture §7.5), so engine tests and app tests read the same scripts.
"""

from __future__ import annotations

import asyncio
import copy
import inspect
import json
import math
import re
from typing import Any, Callable

from rlm_engine.appport import AppPort
from rlm_engine.errors import ModelError


def zero_usage() -> dict:
    return {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "cost_usd": 0.0,
    }


class FakeApp(AppPort):
    """`complete` answers with the last message's text, `ping` turned into `pong`.

    `complete=` and `approve=` replace the default answers; each may be sync or async and
    may raise. Without `approve=`, every approval is denied.

    `script=` (a dict in the §7.5 format) serves model calls instead, each run from the start of
    the script: root replies in order (a `tool_call: {code}` entry becomes a `python` call with id
    `call_<n>`), sub-calls by the first rule whose `match` regex finds the prompt, else the rule
    without `match`, and `errors` entries as ModelError. Tokens are ceil(chars / 4) at zero cost,
    unless an entry carries its own `usage`. `delay_ms` waits that long before each answer. An rlm()
    child's turn (params with `child`, D-160) is served `children[<child id>]`, else `children["*"]`,
    at the child's turn number, and leaves the root and sub counters alone. A compaction's summary call
    (`purpose: "compact"`, v1 step 3) takes the next `compact` entry, else `{"text": "summary"}`, and never
    touches the root, sub or child entries.
    `requests` holds a deep copy of every `complete` params, in order.
    """

    def __init__(
        self,
        *,
        complete: Callable[[dict], Any] | None = None,
        approve: Callable[[dict], Any] | None = None,
        script: dict | None = None,
    ) -> None:
        self._complete = complete
        self._approve = approve
        self.script = script
        self.completes: list[dict] = []
        self.requests: list[dict] = []
        self.approvals: list[dict] = []
        self.events: list[tuple[str, dict]] = []
        self.cancelled: list[str] = []
        self._runs: dict[str, dict[str, int]] = {}  # run_id -> {"served", "root", "sub"}

    async def complete(self, params: dict) -> dict:
        self.completes.append(params)
        self.requests.append(copy.deepcopy(params))
        if self._complete is not None:
            return await _maybe_await(self._complete(params))
        if self.script is not None:
            return await self._scripted(params)
        text = params["messages"][-1]["content"].replace("ping", "pong")
        return {
            "text": text,
            "tool_call": None,
            "reasoning": None,
            "usage": zero_usage(),
            "finish_reason": "stop",
            "served_model": params["model"]["model"],
            "seconds": 0.0,
        }

    async def approve(self, params: dict) -> dict:
        self.approvals.append(params)
        if self._approve is not None:
            return await _maybe_await(self._approve(params))
        return {"allow": False, "remember_for_run": False}

    def event(self, method: str, params: dict) -> None:
        self.events.append((method, params))

    def cancel_calls(self, run_id: str) -> None:
        self.cancelled.append(run_id)

    def sent(self, method: str) -> list[dict]:
        """The params of every event of one method, in order."""
        return [params for m, params in self.events if m == method]

    # -- the script --

    async def _scripted(self, params: dict) -> dict:
        script = self.script or {}
        role = params["role"]
        state = self._runs.setdefault(params["run_id"], {"served": 0, "root": 0, "sub": 0, "compact": 0})
        if params.get("purpose") == "compact":  # a compaction's summary call (v1 step 3)
            if script.get("delay_ms"):
                await asyncio.sleep(script["delay_ms"] / 1000)
            entries = script.get("compact") or []
            state["compact"] += 1
            entry = entries[state["compact"] - 1] if state["compact"] <= len(entries) else {"text": "summary"}
            if entry.get("error"):
                kind = entry["error"]
                raise ModelError(f"fake script error: {kind} at compact call {state['compact']}", kind=kind,
                                 provider=params["model"].get("provider", ""), model=params["model"].get("model", ""))
            return self._reply(params, entry, None)
        child = params.get("child")
        if child is not None:  # an rlm() child's turn (D-160): `children[id]` or `children["*"]`, by the child's turn
            if script.get("delay_ms"):
                await asyncio.sleep(script["delay_ms"] / 1000)
            lists = script.get("children") or {}
            entries = lists.get(str(child["id"]), lists.get("*")) or []
            if child["turn"] > len(entries):
                raise ModelError("fake script exhausted", kind="other")
            entry = entries[child["turn"] - 1]
            tool_call = None
            if entry.get("tool_call"):
                tool_call = {"id": f"call_c{child['id']}_{child['turn']}", "name": "python",
                             "arguments": {"code": entry["tool_call"]["code"]}}
            return self._reply(params, entry, tool_call)
        state[role] += 1
        n = state[role]
        if script.get("delay_ms"):
            await asyncio.sleep(script["delay_ms"] / 1000)
        for err in script.get("errors") or []:
            if err.get("role") == role and err.get("at") == n:
                kind = err.get("kind", "other")
                raise ModelError(f"fake script error: {kind} at {role} call {n}", kind=kind, status=err.get("status"),
                                 provider=params["model"].get("provider", ""), model=params["model"].get("model", ""))
        tool_call = None
        if role == "root":
            entries = script.get("root") or []
            if state["served"] >= len(entries):
                raise ModelError("fake script exhausted", kind="other")
            entry = entries[state["served"]]
            state["served"] += 1
            if entry.get("tool_call"):
                tool_call = {"id": f"call_{state['served']}", "name": "python",
                             "arguments": {"code": entry["tool_call"]["code"]}}
        else:
            prompt = params["messages"][-1]["content"]
            rules = script.get("sub") or []
            entry = next((r for r in rules if "match" in r and re.search(r["match"], prompt)), None)
            entry = entry or next((r for r in rules if "match" not in r), None)
            if entry is None:
                raise ModelError("fake script has no sub-call rule for this prompt", kind="other")
        return self._reply(params, entry, tool_call)

    def _reply(self, params: dict, entry: dict, tool_call: dict | None) -> dict:
        text = entry.get("text", "")
        usage = zero_usage()
        usage["input_tokens"] = math.ceil(_request_chars(params) / 4)
        usage["output_tokens"] = math.ceil((len(text) + (len(_compact(tool_call["arguments"])) if tool_call else 0)) / 4)
        usage.update(entry.get("usage") or {})
        return {
            "text": text,
            "tool_call": tool_call,
            "reasoning": None,
            "usage": usage,
            "finish_reason": "tool_call" if tool_call else "stop",
            "served_model": params["model"]["model"],
            "seconds": 0.0,
        }


def _compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _request_chars(params: dict) -> int:
    """As the app's gateway counts them: every message's content, tool-call arguments, and the tool list."""
    n = 0
    for message in params["messages"]:
        n += len(message["content"])
        if message["role"] == "assistant" and message.get("tool_call"):
            n += len(_compact(message["tool_call"]["arguments"]))
    return n + len(_compact(params.get("tools") or []))


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value
