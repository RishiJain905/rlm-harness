"""KV cache: none

`FakeApp`, the scripted AppPort the engine tests use instead of a pipe (architecture §7.2).
It records every call. Step 6 adds `script=` for root replies and sub-call answers.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable

from rlm_engine.appport import AppPort


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
    """

    def __init__(self, *, complete: Callable[[dict], Any] | None = None, approve: Callable[[dict], Any] | None = None) -> None:
        self._complete = complete
        self._approve = approve
        self.completes: list[dict] = []
        self.approvals: list[dict] = []
        self.events: list[tuple[str, dict]] = []
        self.cancelled: list[str] = []

    async def complete(self, params: dict) -> dict:
        self.completes.append(params)
        if self._complete is not None:
            return await _maybe_await(self._complete(params))
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


async def _maybe_await(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value
