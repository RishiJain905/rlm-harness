"""KV cache: none

The run log: one JSON line per finished run, appended to `runs.jsonl` (architecture §7.8, decision D-26).
`RunLog.append` and `records` follow training's `TranscriptLog.append` and `all_records` (rlm_rl/transcripts.py
at RLM commit 0b9af69): an append-only file, each line flushed and fsynced as it is written, so a crash loses at
most the line being written, and the reader counts and skips a torn line.

What differs from training: the line goes out in one `os.write` on a descriptor opened O_APPEND, so two runs in
one engine (or two processes) never interleave inside a line; O_BINARY keeps Windows from turning `\\n` into
`\\r\\n`; a file whose last line is torn gets a fresh line before the next record; and NaN and infinities are
written as the strings "nan", "inf" and "-inf", because `json.dumps` would write bare `NaN`, which the app's
`JSON.parse` rejects.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from pathlib import Path
from typing import Any

FORMAT_VERSION = 1

# The top-level keys of a record, in order (architecture §7.8). Read-mode records carry `question` where repo-mode
# records carry `task`: "question" stands for that slot here, and a repo-mode record has `task` in its place.
RECORD_KEYS: tuple[str, ...] = (
    "format", "run_id", "tag", "batch", "harness_version", "protocol", "contract", "contract_hash", "prompt_hash",
    "profile", "profile_hash", "mode", "call_format", "root", "sub", "permission_mode", "limits", "started_at",
    "wall_s", "question", "input", "workspace", "base_tree", "messages", "turns", "subcalls", "fetches",
    "permissions", "submitted", "answer", "answer_valid", "usage", "cost_usd", "cache", "timeouts", "crashes",
    "restarts", "diff", "infra_error", "infra_kind", "host_traceback",
)

_BATCH_RE = re.compile(r"[A-Za-z0-9._-]+")
_LOCK = threading.Lock()  # one writer at a time inside this process; O_APPEND covers other processes
_BINARY = getattr(os, "O_BINARY", 0)  # Windows: without it the CRT writes "\n" as "\r\n"


def log_path(home: Path, batch: str, log_dir: Path | None) -> Path:
    """`log_dir/runs.jsonl` when `log_dir` is given, else `<home>/runs/<batch>/runs.jsonl` (D-26).

    `batch` must be one folder name made of letters, digits, `.`, `_` and `-`, and must not start with `.`:
    anything else raises ValueError. It is checked even when `log_dir` is given, because the record carries it.
    """
    if not isinstance(batch, str) or not _BATCH_RE.fullmatch(batch) or batch.startswith("."):
        raise ValueError(f"batch name {batch!r} must match [A-Za-z0-9._-]+ and not start with '.'")
    if log_dir is not None:
        return Path(log_dir) / "runs.jsonl"
    return Path(home) / "runs" / batch / "runs.jsonl"


def _finite(value: Any) -> Any:
    """`value` with every NaN and infinity (at any depth in dicts, lists and tuples) replaced by its string."""
    if isinstance(value, float):
        if math.isnan(value):
            return "nan"
        if math.isinf(value):
            return "inf" if value > 0 else "-inf"
        return value
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(v) for v in value]
    return value


class RunLog:
    """An append-only JSONL file of run records. `torn_lines` is the number of unreadable lines the last `records()`
    call skipped."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.torn_lines = 0

    def append(self, record: dict) -> None:
        """Write `record` as one line, flushed to disk. Creates the folder and the file. A lone surrogate in a
        string is written as `?` rather than losing the record."""
        line = json.dumps(_finite(record), ensure_ascii=False, default=str) + "\n"
        data = line.encode("utf-8", "replace")
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            if self._ends_torn():
                data = b"\n" + data  # in the same write, so the fresh line and the record stay together
            fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | _BINARY, 0o666)
            try:
                view = memoryview(data)
                while view:  # one write in practice; a partial write would continue, not restart
                    view = view[os.write(fd, view) :]
                os.fsync(fd)
            finally:
                os.close(fd)

    def _ends_torn(self) -> bool:
        """Whether the file has bytes and the last one is not a newline (a crash cut the last line short)."""
        try:
            with open(self.path, "rb") as f:
                f.seek(0, os.SEEK_END)
                if f.tell() == 0:
                    return False
                f.seek(-1, os.SEEK_END)
                return f.read(1) != b"\n"
        except FileNotFoundError:
            return False

    def records(self) -> list[dict]:
        """Every readable record, in the order written. A line that is not valid UTF-8 JSON is skipped and counted
        in `torn_lines`; blank lines are skipped without being counted. `[]` when the file is missing."""
        self.torn_lines = 0
        try:
            raw = self.path.read_bytes()
        except FileNotFoundError:
            return []
        records: list[dict] = []
        for chunk in raw.split(b"\n"):  # not splitlines(): U+2028 and friends may sit inside a string
            if not chunk.strip():
                continue
            try:
                record = json.loads(chunk.decode("utf-8"))
            except ValueError:  # JSONDecodeError and UnicodeDecodeError are both ValueErrors
                self.torn_lines += 1
                continue
            if isinstance(record, dict):
                records.append(record)
            else:  # a line that parses but is not a record, such as `12`, is as unusable as a torn one
                self.torn_lines += 1
        return records
