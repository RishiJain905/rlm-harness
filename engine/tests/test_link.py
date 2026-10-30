"""KV cache: none

The link (step 2): requests both ways and interleaved, the error answers, closing, and the
real `serve` process with nothing but protocol on its stdout.
"""

from __future__ import annotations

import asyncio
import json
import random
import subprocess
import sys
import threading
import time

import pytest
from conftest import EngineProc, finish, pipes, run
from fakeapp import FakeApp, zero_usage

from rlm_engine.appport import LinkAppPort
from rlm_engine.errors import ModelError
from rlm_engine.link import CANCELLED, Link, RpcError, classify
from rlm_engine.service import Engine

INFO_KEYS = {"version", "protocol", "python", "contract", "contract_hash", "training_hash", "profiles"}


async def echo(params: dict) -> dict:
    return params


async def serving(link: Link) -> asyncio.Task:
    """Start serve() and let it start its threads, so a large peer write can't block first."""
    task = asyncio.create_task(link.serve())
    await asyncio.sleep(0)
    return task


def assert_protocol_only(raw: bytes) -> None:
    lines = [line for line in raw.split(b"\n") if line]
    assert lines, "no protocol output"
    for line in lines:
        msg = json.loads(line)
        assert msg.get("jsonrpc") == "2.0"
        assert classify(msg) != "invalid", msg


def complete_result(text: str) -> dict:
    return {
        "text": text,
        "tool_call": None,
        "reasoning": None,
        "usage": zero_usage(),
        "finish_reason": "stop",
        "served_model": "roundtrip",
        "seconds": 0.0,
    }


def test_request_result() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)

        async def nothing(params: dict) -> None:
            return None

        link.method("echo", echo)
        link.method("nothing", nothing)
        server = await serving(link)
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {"a": [1, "x"]}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 1, "result": {"a": [1, "x"]}}
        p.peer.send({"jsonrpc": "2.0", "id": "s-1", "method": "nothing", "params": {}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": "s-1", "result": None}
        p.peer.send({"id": 2, "method": "echo"})  # no params means {}; jsonrpc not required
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 2, "result": {}}
        await finish(p, server)

    run(main())


def test_errors() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)

        async def bad_input(params: dict) -> None:
            raise RpcError(-32012, "missing input", {"field": "inputs"})

        async def broken(params: dict) -> None:
            raise ValueError("boom")

        link.method("echo", echo)
        link.method("bad_input", bad_input)
        link.method("broken", broken)
        server = await serving(link)

        async def expect(line: bytes | dict, mid: object, code: int, message: str | None = None) -> dict:
            p.peer.send(line)
            msg = await p.peer.recv()
            assert msg["jsonrpc"] == "2.0" and msg["id"] == mid and msg["error"]["code"] == code, msg
            if message is not None:
                assert msg["error"]["message"] == message
            p.peer.send({"jsonrpc": "2.0", "id": 99, "method": "echo", "params": {"still": "serving"}})
            assert (await p.peer.recv())["result"] == {"still": "serving"}
            return msg["error"]

        await expect({"jsonrpc": "2.0", "id": 3, "method": "nope"}, 3, -32601, "method not found: nope")
        await expect(b"[1, 2]\n", None, -32600)
        await expect(b'{"id": 4, "method":\n', None, -32700)
        await expect(b'{"id": 5, "method": "echo", "params": {"a": "\xff"}}\n', None, -32700)
        await expect({"id": 6, "method": "echo", "params": [1]}, 6, -32602, "params must be an object")
        await expect({"id": 7, "result": 1, "error": {"code": 1, "message": "x"}}, 7, -32600)
        err = await expect({"id": 8, "method": "bad_input"}, 8, -32012, "missing input")
        assert err["data"] == {"field": "inputs"}
        await expect({"id": 9, "method": "broken"}, 9, -32603, "internal error: ValueError: boom")
        await finish(p, server)

    run(main())


def test_notification_no_reply() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        seen: list[int] = []

        async def note(params: dict) -> None:
            await asyncio.sleep(random.random() / 100)  # later ones must still wait their turn
            seen.append(params["n"])

        link.method("note", note)
        link.method("echo", echo)
        server = await serving(link)
        for n in range(5):
            p.peer.send({"jsonrpc": "2.0", "method": "note", "params": {"n": n}})
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 1, "result": {}}
        for _ in range(100):
            if len(seen) == 5:
                break
            await asyncio.sleep(0.01)
        assert seen == [0, 1, 2, 3, 4]
        with pytest.raises(TimeoutError):
            await p.peer.recv(timeout=0.2)
        await finish(p, server)

    run(main())


def test_both_ways_interleaved() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)

        async def a(params: dict) -> dict:
            return {"a": await link.request("model.complete", {"q": "from A"})}

        async def b(params: dict) -> str:
            return "B"

        link.method("a", a)
        link.method("b", b)
        server = await serving(link)
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "a", "params": {}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": "e1", "method": "model.complete", "params": {"q": "from A"}}
        p.peer.send({"jsonrpc": "2.0", "id": 2, "method": "b", "params": {}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 2, "result": "B"}
        p.peer.send({"jsonrpc": "2.0", "id": "e1", "result": "pong"})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 1, "result": {"a": "pong"}}
        await finish(p, server)

    run(main())


def test_slow_handler_does_not_block() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        gate = asyncio.Event()

        async def slow(params: dict) -> str:
            await gate.wait()
            return "slow"

        async def fast(params: dict) -> str:
            return "fast"

        link.method("slow", slow)
        link.method("fast", fast)
        server = await serving(link)
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "slow", "params": {}})
        p.peer.send({"jsonrpc": "2.0", "id": 2, "method": "fast", "params": {}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 2, "result": "fast"}
        gate.set()
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 1, "result": "slow"}
        await finish(p, server)

    run(main())


def test_concurrent_requests() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        server = await serving(link)
        calls = [asyncio.create_task(link.request("m", {"i": i})) for i in range(20)]
        requests = [await p.peer.recv() for _ in range(20)]
        assert sorted(r["id"] for r in requests) == sorted(f"e{i}" for i in range(1, 21))
        for req in reversed(requests):
            p.peer.send({"jsonrpc": "2.0", "id": req["id"], "result": req["params"]["i"] * 10})
        assert await asyncio.gather(*calls) == [i * 10 for i in range(20)]
        await finish(p, server)

    run(main())


def test_error_response_raises() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        server = await serving(link)
        call = asyncio.create_task(link.request("m", {}))
        req = await p.peer.recv()
        p.peer.send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32001, "message": "no", "data": {"kind": "auth"}}})
        with pytest.raises(RpcError) as info:
            await call
        assert (info.value.code, info.value.message, info.value.data) == (-32001, "no", {"kind": "auth"})
        await finish(p, server)

    run(main())


def test_utf8_and_long_lines() -> None:
    text = "é 😀   a\r\nb " + "x" * (2 * 1024 * 1024)

    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)

        async def surrogate(params: dict) -> str:
            return "\ud800"

        link.method("echo", echo)
        link.method("surrogate", surrogate)
        server = await serving(link)

        # peer -> link -> peer
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {"s": text}})
        line = await p.peer.recv_line()
        assert "é 😀  ".encode() in line  # raw UTF-8, not escapes
        assert json.loads(line)["result"]["s"] == text

        # link -> peer -> link
        call = asyncio.create_task(link.request("echo", {"s": text}))
        req = await p.peer.recv()
        assert req["params"]["s"] == text
        p.peer.send({"jsonrpc": "2.0", "id": req["id"], "result": req["params"]["s"]})
        assert await call == text

        # a lone surrogate can't be UTF-8: it leaves as an escape
        p.peer.send({"jsonrpc": "2.0", "id": 2, "method": "surrogate", "params": {}})
        line = await p.peer.recv_line()
        assert b"\\ud800" in line
        assert json.loads(line)["result"] == "\ud800"

        await finish(p, server)
        assert b"\r" not in p.peer.out.raw  # no 0x0D byte is ever written

    run(main(), timeout=30)


def test_line_too_long() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer, max_line_bytes=1024)
        link.method("echo", echo)
        server = await serving(link)
        p.peer.send(b'{"id": 1, "method": "echo", "params": {"s": "' + b"x" * 2000 + b'"}}\n')
        msg = await p.peer.recv()
        assert msg == {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "line too long (over 1024 bytes)"}}
        p.peer.send({"jsonrpc": "2.0", "id": 2, "method": "echo", "params": {"ok": True}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 2, "result": {"ok": True}}
        await finish(p, server)

    run(main())


def test_eof() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        order: list[str] = []
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def first() -> None:
            order.append("first")
            raise RuntimeError("the first callback fails; the second still runs")

        async def second() -> None:
            order.append("second")

        async def hang(params: dict) -> None:
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                cancelled.set()
                raise

        link.on_close(first)
        link.on_close(second)
        link.method("hang", hang)
        server = await serving(link)
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "hang", "params": {}})
        await asyncio.wait_for(started.wait(), 5)
        pending = asyncio.create_task(link.request("m", {}))
        await p.peer.recv()
        p.peer.writer.close()
        await asyncio.wait_for(server, 5)

        with pytest.raises(RpcError) as info:
            await pending
        assert info.value.code == CANCELLED
        assert cancelled.is_set()
        assert order == ["first", "second"]
        with pytest.raises(RpcError) as info:
            await link.request("m", {})
        assert (info.value.code, info.value.message) == (CANCELLED, "link closed")
        link.notify("dropped", {})  # no error
        p.close()

    run(main())


def test_notify_threadsafe() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        server = await serving(link)

        def blast() -> None:
            for i in range(50):
                link.notify("tick", {"i": i})

        thread = threading.Thread(target=blast)
        thread.start()
        thread.join()
        msgs = [await p.peer.recv() for _ in range(50)]
        assert all(m == {"jsonrpc": "2.0", "method": "tick", "params": {"i": i}} for i, m in enumerate(msgs))
        await finish(p, server)

    run(main())


def test_link_app_port() -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        port = LinkAppPort(link)
        server = await serving(link)

        async def complete_with(error: dict) -> ModelError:
            call = asyncio.create_task(port.complete({"run_id": "r_1"}))
            req = await p.peer.recv()
            assert req["method"] == "model.complete" and req["params"] == {"run_id": "r_1"}
            p.peer.send({"jsonrpc": "2.0", "id": req["id"], "error": error})
            with pytest.raises(ModelError) as info:
                await call
            return info.value

        data = {"kind": "rate_limit", "provider": "openai", "model": "example", "status": 429, "message": "slow down"}
        err = await complete_with({"code": -32001, "message": "slow down", "data": data})
        assert (err.kind, err.status, err.provider, err.model, err.message) == ("rate_limit", 429, "openai", "example", "slow down")
        assert err.data() == data
        assert (await complete_with({"code": -32800, "message": "cancelled"})).kind == "cancelled"
        assert (await complete_with({"code": -32603, "message": "internal error: X: y"})).kind == "other"

        call = asyncio.create_task(port.approve({"run_id": "r_1", "kind": "shell"}))
        req = await p.peer.recv()
        assert req["method"] == "approval.request"
        p.peer.send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32603, "message": "no"}})
        assert await call == {"allow": False, "remember_for_run": False}

        call = asyncio.create_task(port.approve({"run_id": "r_1", "kind": "shell"}))
        req = await p.peer.recv()
        p.peer.send({"jsonrpc": "2.0", "id": req["id"], "result": {"allow": True, "remember_for_run": True}})
        assert await call == {"allow": True, "remember_for_run": True}

        port.event("run.budget", {"run_id": "r_1", "turns_left": 3, "subcalls_left": 9})
        assert await p.peer.recv() == {
            "jsonrpc": "2.0",
            "method": "run.budget",
            "params": {"run_id": "r_1", "turns_left": 3, "subcalls_left": 9},
        }
        port.cancel_calls("r_1")
        assert await p.peer.recv() == {"jsonrpc": "2.0", "method": "model.cancel", "params": {"run_id": "r_1"}}
        await finish(p, server)

    run(main())


def test_engine_with_fakeapp(tmp_path) -> None:
    async def main() -> None:
        p = pipes()
        link = Link(p.reader, p.writer)
        app = FakeApp()
        engine = Engine(app, home=tmp_path, debug=True)
        assert engine.home == tmp_path
        engine.register(link)
        server = await serving(link)
        p.peer.send({"jsonrpc": "2.0", "id": 1, "method": "debug.roundtrip", "params": {"count": 3}})
        assert await p.peer.recv() == {"jsonrpc": "2.0", "id": 1, "result": {"texts": ["pong 0", "pong 1", "pong 2"]}}
        assert [c["messages"][0]["content"] for c in app.completes] == ["ping 0", "ping 1", "ping 2"]
        for i, bad in enumerate([0, 1001, True, "3", None]):
            p.peer.send({"jsonrpc": "2.0", "id": 10 + i, "method": "debug.roundtrip", "params": {"count": bad}})
            assert (await p.peer.recv())["error"]["code"] == -32602
        await finish(p, server)

    run(main())


def test_process_info(tmp_path) -> None:
    engine = EngineProc(tmp_path)
    try:
        engine.send({"jsonrpc": "2.0", "id": 1, "method": "engine.info", "params": {}})
        info = engine.recv()["result"]
        assert set(info) == INFO_KEYS
        assert (info["version"], info["protocol"], info["contract"], info["profiles"]) == ("0.1.0", 1, None, [])
        assert info["contract_hash"] is None and info["training_hash"] is None
        assert info["python"].startswith("3.12.")
        engine.send({"jsonrpc": "2.0", "id": 2, "method": "debug.roundtrip", "params": {"count": 1}})
        assert engine.recv()["error"]["code"] == -32601
        engine.close_stdin()
        assert engine.wait() == 0
        assert engine.out.get(5) is None
        assert_protocol_only(bytes(engine.out.raw))
    finally:
        engine.kill()


def test_process_roundtrip(tmp_path) -> None:
    engine = EngineProc(tmp_path, debug=True)
    try:
        engine.send({"jsonrpc": "2.0", "id": 1, "method": "debug.roundtrip", "params": {"count": 8}})
        reqs = [engine.recv() for _ in range(8)]
        assert sorted(r["id"] for r in reqs) == sorted(f"e{i}" for i in range(1, 9))
        assert all(r["method"] == "model.complete" and r["params"]["run_id"] == "debug" for r in reqs)
        engine.send({"jsonrpc": "2.0", "id": 2, "method": "engine.info", "params": {}})
        assert engine.recv()["id"] == 2
        for req in random.sample(reqs, len(reqs)):
            text = req["params"]["messages"][0]["content"].replace("ping", "pong")
            engine.send({"jsonrpc": "2.0", "id": req["id"], "result": complete_result(text)})
        assert engine.recv() == {"jsonrpc": "2.0", "id": 1, "result": {"texts": [f"pong {i}" for i in range(8)]}}

        engine.send({"jsonrpc": "2.0", "id": 3, "method": "debug.roundtrip", "params": {"count": 3}})
        reqs = [engine.recv() for _ in range(3)]
        data = {"kind": "rate_limit", "provider": "debug", "model": "roundtrip", "status": 429, "message": "slow down"}
        engine.send({"jsonrpc": "2.0", "id": reqs[1]["id"], "error": {"code": -32001, "message": "slow down", "data": data}})
        msg = engine.recv()
        assert msg["id"] == 3 and msg["error"]["code"] == -32001 and msg["error"]["data"]["kind"] == "rate_limit"
        for req in (reqs[0], reqs[2]):  # late answers are ignored
            engine.send({"jsonrpc": "2.0", "id": req["id"], "result": complete_result("late")})
        engine.close_stdin()
        assert engine.wait() == 0
        assert engine.out.get(5) is None
        assert_protocol_only(bytes(engine.out.raw))
    finally:
        engine.kill()


def test_process_stdout_clean() -> None:
    code = (
        "import os\n"
        "from rlm_engine.__main__ import claim_stdio\n"
        "claim_stdio()\n"
        "print('stray')\n"
        "os.write(1, b'fd one\\n')\n"
    )
    proc = subprocess.run([sys.executable, "-X", "utf8", "-c", code], capture_output=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    assert proc.stdout == b""
    assert b"stray" in proc.stderr and b"fd one" in proc.stderr


def test_process_stdin_close(tmp_path) -> None:
    engine = EngineProc(tmp_path, debug=True)
    try:
        engine.send({"jsonrpc": "2.0", "id": 1, "method": "debug.roundtrip", "params": {"count": 1}})
        assert engine.recv()["method"] == "model.complete"  # left unanswered
        start = time.monotonic()
        engine.close_stdin()
        assert engine.wait(5) == 0
        assert time.monotonic() - start < 5
        assert engine.out.get(5) is None  # no further stdout
        assert "serving" in engine.stderr_text()
    finally:
        engine.kill()


def test_main_usage() -> None:
    proc = subprocess.run([sys.executable, "-X", "utf8", "-m", "rlm_engine", "bogus"], capture_output=True, timeout=60)
    assert proc.returncode == 2
    assert proc.stdout == b"" and b"usage" in proc.stderr

