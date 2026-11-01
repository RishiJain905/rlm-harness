"""KV cache: none

Cache-shaped sub-calls (D-119): `worker/cacheapi.py` (segments, `llm(over=)`, `llm_batch(shared=, over=)`) in a real
worker, the bridge's prefix handling and `model.complete` `prefix` param, and the profile flag that turns them on.
training-v4 must see none of it: its REPL and its requests stay training's own.
"""

from __future__ import annotations

import contextlib
import dataclasses
import hashlib
from pathlib import Path
from typing import Any, AsyncIterator

import pytest
from conftest import run
from test_bridge import RUN_ID, batch_request, handle, make

from rlm_engine import contract
from rlm_engine.profiles import ProfileError, load_profile
from rlm_engine.workspace import find_shell
from rlm_engine.worker import cacheapi
from rlm_engine.worker.manager import SEGMENT_CHARS, Worker, segment_chars

READ = contract.READ_LIMITS_V4
CONTEXT = "".join(f"line {i:04d}: headline text number {i}\n" for i in range(3000))  # 102,000 characters


def key(prefix: str) -> str:
    return hashlib.sha256(prefix.encode("utf-8")).hexdigest()[:16]


@contextlib.asynccontextmanager
async def worker(tmp_path: Path, seen: list, *, cache_api: bool, limits: contract.Limits = READ) -> AsyncIterator[Worker]:
    async def record(request: dict) -> dict:
        seen.append(request)
        return {"outputs": [f"ok{i}" for i in range(len(request["prompts"]))]}

    scratch = tmp_path / "scratch"
    scratch.mkdir(exist_ok=True)
    w = Worker(mode="read", context=CONTEXT, workspace=scratch, scratch=scratch, limits=limits,
               messages=contract.cell_messages(limits, edit=False), on_request=record, shell=find_shell(),
               cache_api=cache_api)
    await w.start()
    try:
        yield w
    finally:
        await w.close()


# ---------------------------------------------------------------------------------------------- segments


def test_cut_is_line_aligned_complete_and_deterministic() -> None:
    segs = cacheapi.cut(CONTEXT, 40_000)
    assert "".join(segs) == CONTEXT
    assert [s.id for s in segs] == list(range(len(segs)))
    assert all(s == CONTEXT[s.start:s.end] for s in segs)
    assert all(s.endswith("\n") for s in segs)  # cut at line ends
    assert all(len(s) <= 40_000 for s in segs)
    assert segs[0].start == 0 and segs[-1].end == len(CONTEXT)
    assert [(s.start, s.end) for s in cacheapi.cut(CONTEXT, 40_000)] == [(s.start, s.end) for s in segs]
    no_newline = cacheapi.cut("x" * 2500, 1000)  # nothing to align to: plain cuts
    assert [len(s) for s in no_newline] == [1000, 1000, 500]
    assert cacheapi.cut("", 1000) == []
    assert repr(segs[1]) == f"Segment(id=1, start={segs[1].start}, end={segs[1].end}, chars={len(segs[1])})"


def test_default_segment_size_leaves_room_for_the_prompt() -> None:
    assert segment_chars(READ) == SEGMENT_CHARS == 40_000  # 60,000-character sub-calls
    assert segment_chars(dataclasses.replace(READ, subcall_max_chars=24_000)) == 16_000


# ---------------------------------------------------------------------------------------------- in a real worker


def test_worker_api_sends_prefixes(tmp_path: Path) -> None:
    seen: list[dict] = []

    async def main() -> None:
        async with worker(tmp_path, seen, cache_api=True) as w:
            r = await w.run_cell("segs = segments()\nprint(len(segs), segs[0].start, segs[0].end, segs[1].id)")
            first = cacheapi.cut(CONTEXT, 40_000)
            assert r.error is None and r.stdout == f"{len(first)} 0 {first[0].end} 1\n"
            r = await w.run_cell("print(llm('count travel', over=segs[0]))")
            assert r.stdout == "ok0\n"
            r = await w.run_cell("print(llm_batch(['a', 'b'], shared='RUBRIC'))")
            assert r.stdout == "['ok0', 'ok1']\n"
            r = await w.run_cell("print(llm_batch(['a', 'b'], shared='RUBRIC', over=segs[:2]))")
            assert r.error is None
            r = await w.run_cell("print(llm_batch(['a', 'b']))")  # no prefix: training's request shape
            assert r.error is None
            r = await w.run_cell("print(llm_batch(['a'], shared=''), llm('b', over=''))")  # empty text is no prefix
            assert r.error is None
            r = await w.run_cell("llm_batch(['a', 'b'], over=segs[:3])")
            assert r.error.splitlines()[-1] == "ValueError: over has 3 segments for 2 prompts; give one, or one per prompt"
            r = await w.run_cell("llm('q', over=5)")
            assert r.error.splitlines()[-1] == "TypeError: over takes a segment (a str), not int"
            r = await w.run_cell("llm('q' * 30_000, over=segs[0])")  # segment + 2 + 30,000 > 60,000
            total = len(cacheapi.cut(CONTEXT, 40_000)[0]) + 2 + 30_000
            assert r.error.splitlines()[-1] == (f"ValueError: sub-call is {total:,} characters with its segment or shared "
                                                "text; one sub-call reads at most 60,000. Use smaller segments or a shorter prompt.")
            r = await w.run_cell("segments(10)")
            assert r.error.splitlines()[-1] == "ValueError: segments(size) takes a whole number of characters, at least 1,000"
        first = cacheapi.cut(CONTEXT, 40_000)
        assert [(q["op"], q["prompts"], q.get("prefixes")) for q in seen] == [
            ("llm", ["count travel"], [str(first[0])]),
            ("llm_batch", ["a", "b"], ["RUBRIC", "RUBRIC"]),
            ("llm_batch", ["RUBRIC\n\na", "RUBRIC\n\nb"], [str(first[0]), str(first[1])]),  # the segment is the prefix
            ("llm_batch", ["a", "b"], None),
            ("llm_batch", ["a"], None),
            ("llm", ["b"], None),
        ]

    run(main(), 90)


def test_training_v4_worker_has_none_of_it(tmp_path: Path) -> None:
    seen: list[dict] = []

    async def main() -> None:
        async with worker(tmp_path, seen, cache_api=False) as w:
            r = await w.run_cell("segments()")
            assert r.error.splitlines()[-1] == "NameError: name 'segments' is not defined"
            r = await w.run_cell("llm('q', over='x')")
            assert r.error.splitlines()[-1] == "TypeError: llm() got an unexpected keyword argument 'over'"
            r = await w.run_cell("print(llm_batch(['a']))")
            assert r.stdout == "['ok0']\n"
        assert [q.get("prefixes", "absent") for q in seen] == ["absent"]

    run(main(), 90)


def test_init_message_carries_the_flag_only_when_on(tmp_path: Path) -> None:
    def init(cache_api: bool) -> dict:
        return Worker(mode="read", context="c", workspace=tmp_path, scratch=tmp_path, limits=READ,
                      messages=contract.cell_messages(READ, edit=False), on_request=None, shell=find_shell(),
                      cache_api=cache_api)._init_message()

    assert (init(True)["cache_api"], init(True)["segment_chars"]) == (True, 40_000)
    assert "cache_api" not in init(False) and "segment_chars" not in init(False)


# ---------------------------------------------------------------------------------------------- the bridge


def test_bridge_joins_the_prefix_and_sends_its_key(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    seg = "S" * 5000
    request = {**batch_request(["q1", "q2", "q3"]), "prefixes": [seg, seg, None]}
    assert handle(bridge, request) == {"outputs": ["A:" + seg + "\n\nq1", "A:" + seg + "\n\nq2", "A:q3"]}
    params = app.completes
    assert [p["messages"] for p in params] == [[{"role": "user", "content": seg + "\n\nq1"}],
                                              [{"role": "user", "content": seg + "\n\nq2"}],
                                              [{"role": "user", "content": "q3"}]]
    assert [p.get("prefix") for p in params] == [{"chars": 5002, "key": key(seg)}, {"chars": 5002, "key": key(seg)}, None]
    assert [r.prompt for r in bridge.records] == [seg + "\n\nq1", seg + "\n\nq2", "q3"]  # the run log keeps what was sent


def test_bridge_without_prefixes_is_unchanged(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    handle(bridge, batch_request(["q1", "q2"]))
    assert app.completes and all("prefix" not in p for p in app.completes)


def test_bridge_checks_prefixes_and_the_joined_size(tmp_path: Path) -> None:
    bridge, app = make(tmp_path)
    assert handle(bridge, {**batch_request(["q"]), "prefixes": ["a", "b"]}) == {
        "error": "prefixes must be a list of strings or nulls, one per prompt"}
    assert handle(bridge, {**batch_request(["q"]), "prefixes": [3]}) == {
        "error": "prefixes must be a list of strings or nulls, one per prompt"}
    big = {**batch_request(["q" * 30_000]), "prefixes": ["S" * 40_000]}  # READ_LIMITS_V4: 60,000, "error"
    assert handle(bridge, big) == {"error": contract.oversize_message(70_002, 60_000)}
    assert bridge.subcalls_used == 0


def test_prefix_key_is_the_same_in_every_run(tmp_path: Path) -> None:
    keys = []
    for i in range(2):
        bridge, app = make(tmp_path / str(i))
        handle(bridge, {**batch_request([f"question {i}"]), "prefixes": ["SEGMENT" * 500]})
        keys.append(app.completes[0]["prefix"]["key"])
    assert keys[0] == keys[1] == key("SEGMENT" * 500)


# ---------------------------------------------------------------------------------------------- profiles


def test_profile_flag(tmp_path: Path) -> None:
    assert load_profile("default", tmp_path).cache_api is True
    assert load_profile("training-v4", tmp_path).cache_api is False
    folder = tmp_path / "profiles" / "mine"
    folder.mkdir(parents=True)
    (folder / "profile.toml").write_text('contract = "v4"\ncache_api = "yes"\n', encoding="utf-8")
    with pytest.raises(ProfileError, match="cache_api must be true or false"):
        load_profile("mine", tmp_path)


# ---------------------------------------------------------------------------------------------- end to end


def test_default_profile_run_sends_cached_segments(tmp_path: Path) -> None:
    """A real loop and worker under the default profile: the root's code reads segments through sub-calls, and every
    sub-call's model.complete carries its segment first and a prefix whose key repeats when the segment does."""
    from fakeapp import FakeApp
    from test_loop import fenced, play, read_spec

    code = "segs = segments()\nfirst = llm_batch(['label'] * len(segs), over=segs)\nagain = llm('verify', over=segs[0])\nsubmit(len(first))"
    app = FakeApp(script={"root": [fenced(code)], "sub": [{"text": "ok"}]})
    record = play(read_spec(tmp_path, load_profile("default", tmp_path), text=CONTEXT), app, tmp_path)
    assert record["infra_error"] is None and record["answer"] == len(cacheapi.cut(CONTEXT, 40_000))
    subs = [q for q in app.requests if q["role"] == "sub"]
    segs = cacheapi.cut(CONTEXT, 40_000)
    assert [q["messages"][0]["content"] for q in subs] == [s + "\n\nlabel" for s in segs] + [segs[0] + "\n\nverify"]
    assert [q["prefix"] for q in subs] == [{"chars": len(s) + 2, "key": key(s)} for s in segs] + [
        {"chars": len(segs[0]) + 2, "key": key(segs[0])}]  # the re-read has the same key: same backend, cached prefix
