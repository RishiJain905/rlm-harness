"""KV cache: none

Errors shared across engine modules.
"""

from __future__ import annotations


class InfraError(Exception):
    """Stops the run. `kind` goes to the run's `infra_kind`."""

    def __init__(self, kind: str, message: str = "") -> None:
        super().__init__(message or kind)
        self.kind = kind
        self.message = message


class SubcallError(Exception):
    """A sub-call the model sees fail, as `RuntimeError("sub-call failed: ...")` in its cell."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.message = message


class ModelError(Exception):
    """`model.complete` failed. `data()` is the ModelErrorData the link carries with -32001."""

    def __init__(
        self,
        message: str,
        *,
        kind: str = "other",
        status: int | None = None,
        provider: str = "",
        model: str = "",
    ) -> None:
        super().__init__(message)
        self.message = message
        self.kind = kind
        self.status = status
        self.provider = provider
        self.model = model

    def data(self) -> dict:
        return {
            "kind": self.kind,
            "provider": self.provider,
            "model": self.model,
            "status": self.status,
            "message": self.message,
        }
