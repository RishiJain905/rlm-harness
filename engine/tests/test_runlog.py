"""KV cache: none

runlog.py: where a run's log goes, the one-line-per-record file format, torn-line handling, NaN handling, and
that 8 threads appending at once never interleave. The key list is checked against architecture.md §7.8 itself.
"""

from __future__ import annotations

import json
import re
import threading
from pathlib import Path

import pytest

from rlm_engine import runlog
from rlm_engine.runlog import FORMAT_VERSION, RECORD_KEYS, RunLog, log_path

ARCHITECTURE = Path(__file__).resolve().parents[2] / "documentation" / "v0" / "architecture.md"


# ----------------------------------------------------------------------------- log_path


def test_log_path_for_a_batch(tmp_path: Path) -> None:
    assert log_path(tmp_path, "cli", None) == tmp_path / "runs" / "cli" / "runs.jsonl"
    assert log_path(tmp_path, "tasks-20261031-120000", None) == tmp_path / "runs" / "tasks-20261031-120000" / "runs.jsonl"
    assert log_path(tmp_path, "a.b_c-1", None).parent.name == "a.b_c-1"
    assert isinstance(log_path(tmp_path, "interactive", None), Path)


def test_log_path_for_a_log_dir(tmp_path: Path) -> None:
    out = tmp_path / "somewhere" / "else"
    assert log_path(tmp_path, "cli", out) == out / "runs.jsonl"
    assert log_path(tmp_path, "cli", str(out)) == out / "runs.jsonl"  # type: ignore[arg-type]


@pytest.mark.parametrize("batch", ["", "..", ".", ".hidden", "a/b", "a\\b", "a b", "a:b", "é", "a\nb", "/abs", "C:\\x"])
def test_log_path_rejects_bad_batch_names(tmp_path: Path, batch: str) -> None:
    with pytest.raises(ValueError):
        log_path(tmp_path, batch, None)
    with pytest.raises(ValueError):  # the name is checked when log_dir is given too: the record carries it
        log_path(tmp_path, batch, tmp_path / "out")


# ----------------------------------------------------------------------------- the file format


def _record(i: int = 0, **extra: object) -> dict:
    return {"format": FORMAT_VERSION, "run_id": f"r_{i:012x}", "answer": "42", **extra}


def test_round_trip_keeps_raw_utf8_and_lf_only(tmp_path: Path) -> None:
    path = tmp_path / "deep" / "er" / "runs.jsonl"  # the parent folders are created
    log = RunLog(path)
    first = _record(1, answer="caf\u00e9 \u2192 \U0001f600", nested={"k": ["a\r\nb", 1.5, None, True]})
    log.append(first)
    log.append(_record(2))
    data = path.read_bytes()
    assert b"\r" not in data  # the CR inside the string is escaped, and no line ends with CR (Windows: O_BINARY)
    assert data.count(b"\n") == 2 and data.endswith(b"\n")
    assert "caf\u00e9 \u2192 \U0001f600".encode("utf-8") in data  # raw UTF-8, not \u00e9
    assert b"\\u00e9" not in data
    assert log.records() == [first, _record(2)]
    assert log.torn_lines == 0
    assert RunLog(path).records() == [first, _record(2)]  # a second reader sees the same


def test_separators_inside_strings_do_not_split_a_record(tmp_path: Path) -> None:
    # U+2028, U+0085 and \x0b are line breaks to str.splitlines() but are raw inside a JSON string
    text = "a\u2028b\u0085c\x0bd\x0ce\x1cf"
    log = RunLog(tmp_path / "runs.jsonl")
    log.append(_record(answer=text))
    assert log.records() == [_record(answer=text)]
    assert log.torn_lines == 0


def test_missing_file_gives_no_records(tmp_path: Path) -> None:
    log = RunLog(tmp_path / "nothing" / "runs.jsonl")
    assert log.records() == []
    assert log.torn_lines == 0
    assert not (tmp_path / "nothing").exists()  # reading creates nothing


def test_torn_last_line_is_skipped_and_the_next_append_starts_fresh(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    log = RunLog(path)
    log.append(_record(1))
    with open(path, "ab") as f:
        f.write(b'{"format": 1, "run_id": "r_torn", "answ')  # a crash cut the line, no newline
    assert log.records() == [_record(1)]
    assert log.torn_lines == 1

    log.append(_record(2))
    assert log.records() == [_record(1), _record(2)]
    assert log.torn_lines == 1  # the torn line is still there, on a line of its own
    lines = path.read_bytes().split(b"\n")
    assert len(lines) == 4 and lines[3] == b""
    assert lines[1].startswith(b'{"format": 1, "run_id": "r_torn"')
    assert json.loads(lines[2]) == _record(2)

    log.append(_record(3))  # now the file ends in a newline: no extra blank line
    assert path.read_bytes().count(b"\n") == 4
    assert [r["run_id"] for r in log.records()] == [_record(1)["run_id"], _record(2)["run_id"], _record(3)["run_id"]]


def test_a_line_cut_inside_a_multibyte_character_is_torn_too(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    path.write_bytes(b'{"answer": "caf' + "\u00e9".encode("utf-8")[:1])
    log = RunLog(path)
    assert log.records() == []
    assert log.torn_lines == 1
    log.append(_record(1))
    assert log.records() == [_record(1)]
    assert log.torn_lines == 1


def test_blank_and_non_record_lines(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    path.write_bytes(b'\n   \n{"a": 1}\n12\n[1, 2]\nnot json\n\n')
    log = RunLog(path)
    assert log.records() == [{"a": 1}]
    assert log.torn_lines == 3  # blank lines are not counted; `12`, `[1, 2]` and `not json` are
    path.write_bytes(b'{"a": 1}\n')
    assert log.records() == [{"a": 1}]
    assert log.torn_lines == 0  # recounted on every call


def test_nan_and_infinity_become_strings(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    log = RunLog(path)
    nan, inf = float("nan"), float("inf")
    log.append({"a": nan, "b": inf, "c": -inf, "d": [nan, {"e": -inf, "f": 1.25}], "g": (inf, 2), "h": "nan", "i": 0.0})
    raw = path.read_text(encoding="utf-8")
    assert "NaN" not in raw and "Infinity" not in raw
    json.loads(raw, parse_constant=lambda name: pytest.fail(f"invalid JSON constant {name} in the log"))
    assert log.records() == [{"a": "nan", "b": "inf", "c": "-inf", "d": ["nan", {"e": "-inf", "f": 1.25}],
                              "g": ["inf", 2], "h": "nan", "i": 0.0}]


def test_unserialisable_values_use_str(tmp_path: Path) -> None:
    log = RunLog(tmp_path / "runs.jsonl")
    log.append({"path": Path("a") / "b", "set": {1}})
    got = log.records()[0]
    assert got["path"] == str(Path("a") / "b") and got["set"] == "{1}"


def test_a_lone_surrogate_does_not_lose_the_record(tmp_path: Path) -> None:
    log = RunLog(tmp_path / "runs.jsonl")
    log.append({"stdout": "a\udc80b", "ok": True})
    assert log.records() == [{"stdout": "a?b", "ok": True}]


def test_each_record_is_one_write_on_an_append_descriptor(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    writes: list[bytes] = []
    real_write = runlog.os.write

    def spy(fd: int, data: bytes) -> int:
        if b'"run_id"' in bytes(data):
            writes.append(bytes(data))
        return real_write(fd, data)

    monkeypatch.setattr(runlog.os, "write", spy)
    log = RunLog(tmp_path / "runs.jsonl")
    log.append(_record(1))
    path = tmp_path / "runs.jsonl"
    path.write_bytes(path.read_bytes() + b'{"torn')
    writes.clear()
    log.append(_record(2))
    assert len(writes) == 1  # the fresh line and the record go out together
    assert writes[0].startswith(b"\n{") and writes[0].endswith(b"}\n")


def test_eight_threads_append_two_hundred_valid_lines(tmp_path: Path) -> None:
    path = tmp_path / "runs.jsonl"
    big = "x" * 20000  # long enough that interleaving would show if the writes were split
    errors: list[BaseException] = []

    def work(worker: int) -> None:
        try:
            log = RunLog(path)  # one instance per thread: the lock is the module's, not the instance's
            for n in range(25):
                log.append({"worker": worker, "n": n, "pad": big, "answer": f"w{worker}-{n} \u00e9"})
        except BaseException as exc:  # noqa: BLE001 - reported to the main thread
            errors.append(exc)

    threads = [threading.Thread(target=work, args=(w,)) for w in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(60)
    assert not errors
    log = RunLog(path)
    records = log.records()
    assert log.torn_lines == 0
    assert len(records) == 200
    assert path.read_bytes().count(b"\n") == 200
    assert {(r["worker"], r["n"]) for r in records} == {(w, n) for w in range(8) for n in range(25)}
    assert all(r["pad"] == big for r in records)


# ----------------------------------------------------------------------------- RECORD_KEYS


def _architecture_record_keys() -> list[str]:
    """The top-level keys of the run-log record, read out of the code block in architecture.md §7.8."""
    text = ARCHITECTURE.read_text(encoding="utf-8")
    block = text.split("**The run-log record**", 1)[1].split("```")[1]
    block = " ".join(re.sub(r"#.*", "", line) for line in block.splitlines())
    keys, depth, start = [], 0, 0
    for i, ch in enumerate(block + ","):
        if ch in "[{(":
            depth += 1
        elif ch in "]})":
            depth -= 1
        elif ch == "," and depth == 0:
            item = block[start:i].strip()
            start = i + 1
            if item:
                keys.append(re.split(r"[:|(]", item, maxsplit=1)[0].strip())  # `question | task` is one slot
    return keys


def test_record_keys_match_the_architecture() -> None:
    assert FORMAT_VERSION == 1
    assert isinstance(RECORD_KEYS, tuple) and len(set(RECORD_KEYS)) == len(RECORD_KEYS)
    if not ARCHITECTURE.exists():
        pytest.skip("documentation is not part of this checkout")
    assert list(RECORD_KEYS) == _architecture_record_keys()


def test_record_keys_spot_checks() -> None:
    assert RECORD_KEYS[:3] == ("format", "run_id", "tag")
    assert RECORD_KEYS[-3:] == ("infra_error", "infra_kind", "host_traceback")
    assert "question" in RECORD_KEYS and "task" not in RECORD_KEYS  # repo-mode records carry `task` in its place
    assert RECORD_KEYS.index("wall_s") + 1 == RECORD_KEYS.index("question")
    assert RECORD_KEYS.index("question") + 1 == RECORD_KEYS.index("input")
