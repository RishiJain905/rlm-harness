"""KV cache: none

What the engine asks of the app (architecture §7.2). `LinkAppPort` sends it over the link;
engine-side tests use `tests/fakeapp.py:FakeApp` instead.
"""

from __future__ import annotations

from typing import Protocol

from .errors import ModelError
from .link import CANCELLED, MODEL_ERROR, Link, RpcError


class AppPort(Protocol):
    async def complete(self, params: dict) -> dict: ...  # model.complete; raises ModelError

    async def approve(self, params: dict) -> dict: ...  # approval.request

    def event(self, method: str, params: dict) -> None: ...  # a run.* notification

    def cancel_calls(self, run_id: str) -> None: ...  # sends model.cancel


class LinkAppPort(AppPort):
    def __init__(self, link: Link) -> None:
        self.link = link

    async def complete(self, params: dict) -> dict:
        try:
            return await self.link.request("model.complete", params)
        except RpcError as err:
            raise _model_error(err) from None

    async def approve(self, params: dict) -> dict:
        try:
            return await self.link.request("approval.request", params)
        except RpcError:  # the app can't answer: deny
            return {"allow": False, "remember_for_run": False}

    def event(self, method: str, params: dict) -> None:
        self.link.notify(method, params)

    def cancel_calls(self, run_id: str) -> None:
        self.link.notify("model.cancel", {"run_id": run_id})


def _model_error(err: RpcError) -> ModelError:
    if err.code == MODEL_ERROR and isinstance(err.data, dict):
        d = err.data
        return ModelError(
            str(d.get("message", err.message)),
            kind=str(d.get("kind", "other")),
            status=d.get("status"),
            provider=str(d.get("provider", "")),
            model=str(d.get("model", "")),
        )
    if err.code == CANCELLED:
        return ModelError(err.message, kind="cancelled")
    return ModelError(err.message, kind="other")
