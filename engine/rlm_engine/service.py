"""KV cache: none

The engine's methods on the link: `engine.info` now, `run.*` from step 6, and
`debug.roundtrip` for the link tests when `RLMH_DEBUG=1`.
"""

from __future__ import annotations

import asyncio
import os
import platform
from pathlib import Path

from . import PROTOCOL_VERSION, __version__
from .appport import AppPort
from .errors import ModelError
from .link import INVALID_PARAMS, MODEL_ERROR, Link, RpcError

MAX_ROUNDTRIP = 1000


def _default_home() -> Path:
    value = os.environ.get("RLMH_HOME", "")
    return Path(value) if value else Path.home() / ".rlm-harness"


class Engine:
    def __init__(self, app: AppPort, *, home: Path | None = None, debug: bool = False) -> None:
        self.app = app
        self.debug = debug
        self.home = home if home is not None else _default_home()

    def info(self) -> dict:
        # contract, contract_hash, training_hash and profiles are step 3's.
        return {
            "version": __version__,
            "protocol": PROTOCOL_VERSION,
            "python": platform.python_version(),
            "contract": None,
            "contract_hash": None,
            "training_hash": None,
            "profiles": [],
        }

    def register(self, link: Link) -> None:
        link.method("engine.info", self._engine_info)
        if self.debug:
            link.method("debug.roundtrip", self._debug_roundtrip)

    async def _engine_info(self, params: dict) -> dict:
        return self.info()

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
