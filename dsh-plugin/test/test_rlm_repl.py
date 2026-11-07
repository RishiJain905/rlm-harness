# KV cache: none
"""Offline tests for dsh-plugin/python/rlm_repl.py: drive the REPL over its JSON-lines protocol, as the host does.

Run: python -m unittest discover -s dsh-plugin/test -p "test_*.py" -v   (any Python 3.10+)
"""
import json
import os
import subprocess
import sys
import threading
import time
import unittest

REPL = os.path.join(os.path.dirname(__file__), "..", "python", "rlm_repl.py")
SEPARATOR = "\n\n"  # rlmapi.SEPARATOR, between a prefix and its prompt


class Repl:
    """A REPL child. `run()` sends one cell and answers call/llm frames with the given fakes until it is done."""

    def __init__(self):
        self.blobs = {}  # prefix id -> text, as the host stores them
        self.p = subprocess.Popen([sys.executable, "-I", "-u", "-X", "utf8", REPL], stdin=subprocess.PIPE,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.frames = []

    def send(self, frame):
        self.p.stdin.write((json.dumps(frame) + "\n").encode())
        self.p.stdin.flush()

    def read(self):
        line = self.p.stdout.readline()
        if not line:
            raise EOFError("REPL closed its output")
        f = json.loads(line)
        self.frames.append(f)
        return f

    def run(self, program, tools=None, llm=None, cap=None, on_frame=None):
        self.send({"t": "run", "program": program, "cwd": os.getcwd(), "cap": cap,
                   "bindings": [{"global": "tools", "names": sorted(tools or {}),
                                 "errorClass": {"name": "ToolCallError", "memberNameProperty": "toolName"}}]})
        while True:
            f = self.read()
            if on_frame:
                on_frame(self, f)
            if f["t"] == "done":
                return f
            if f["t"] == "call":
                try:
                    self.send({"t": "reply", "cid": f["cid"], "value": tools[f["name"]](f["args"])})
                except Exception as e:  # noqa: BLE001 - a fake tool's failure becomes a tool error
                    self.send({"t": "reply", "cid": f["cid"], "error": str(e)})
            elif f["t"] == "blob":
                self.blobs[f["id"]] = f["text"]
            elif f["t"] == "llm" and llm is not None:
                self.send({"t": "reply", "cid": f["cid"], "value": [llm(self.full(i)) for i in f["items"]]})

    def full(self, item):
        """The prompt a sub-call sends: the stored prefix first, then the prompt (lib/subcall-tool.js)."""
        if "prefix_id" in item:
            return self.blobs[item["prefix_id"]] + SEPARATOR + item["prompt"]
        return item["prompt"]

    def close(self):
        for stream in (self.p.stdin,):
            try:
                stream.close()
            except OSError:
                pass
        try:
            self.p.wait(10)
        finally:
            for stream in (self.p.stdout, self.p.stderr):
                if not stream.closed:
                    stream.close()


class ReplTest(unittest.TestCase):
    def setUp(self):
        self.r = Repl()

    def tearDown(self):
        self.r.close()

    def test_state_persists_and_last_expression_is_the_value(self):
        self.assertEqual(self.r.run("x = 41\nx + 1")["value"], 42)
        done = self.r.run("print(x * 2)")
        self.assertEqual(done["output"], "82\n")
        self.assertIsNone(done["error"])

    def test_top_level_await_and_tools(self):
        tools = {"read": lambda a: {"lines": [{"text": "alpha 3"}, {"text": "beta 5"}]}}
        done = self.r.run('r = await tools.read({"file_path": "x"})\nprint([l.text for l in r.lines], r["lines"][1]["text"])',
                          tools=tools)
        self.assertIsNone(done["error"])
        self.assertEqual(done["output"], "['alpha 3', 'beta 5'] beta 5\n")

    def test_tool_failure_raises_tool_call_error(self):
        def boom(a):
            raise ValueError("no such file")

        done = self.r.run('try:\n    await tools.read({})\nexcept ToolCallError as e:\n    print("caught", e.toolName, e)',
                          tools={"read": boom})
        self.assertEqual(done["output"], "caught read no such file\n")

    def test_llm_and_llm_batch(self):
        done = self.r.run('print(llm("a"), llm_batch(["b", "c"]), llm_batch([]))', llm=lambda p: p.upper())
        self.assertEqual(done["output"], "A ['B', 'C'] []\n")

    def test_child_process_output_is_captured_not_mixed_into_the_protocol(self):
        code = ("import subprocess, sys, os\n"
                "subprocess.run([sys.executable, '-c', 'print(\"from child\"); import sys; sys.stderr.write(\"err\\\\n\")'])\n"
                "os.write(1, b'raw fd1\\n')\n"
                "print('after')")
        done = self.r.run(code)
        self.assertIsNone(done["error"], done)
        for text in ("from child", "err", "raw fd1", "after"):
            self.assertIn(text, done["output"])
        # the protocol still works afterwards
        self.assertEqual(self.r.run("1 + 1")["value"], 2)

    def test_reading_stdin_gets_eof(self):
        done = self.r.run("import sys\nprint(repr(sys.stdin.read()))\nimport subprocess\n"
                          "print(subprocess.run([sys.executable, '-c', 'import sys; print(len(sys.stdin.read()))'], capture_output=True, text=True).stdout.strip())")
        self.assertEqual(done["output"], "''\n0\n")

    def test_output_cap_counts_the_rest(self):
        done = self.r.run("print('x' * 50)", cap=10)
        self.assertEqual(done["output"], "x" * 10)
        self.assertEqual(done["total"], 51)

    def test_errors_show_only_the_cell(self):
        done = self.r.run("def f():\n    return 1 / 0\nf()")
        self.assertIn('File "<run_code>", line 3', done["error"])
        self.assertIn("ZeroDivisionError", done["error"])
        self.assertNotIn("rlm_repl.py", done["error"])

    def test_system_exit_does_not_end_the_repl(self):
        self.assertIn("SystemExit", self.r.run("raise SystemExit(3)")["error"])
        self.assertEqual(self.r.run("2 * 3")["value"], 6)

    def test_interrupt_stops_a_cell_and_keeps_variables(self):
        self.r.run("keep = 'still here'")
        timer = threading.Timer(1.0, lambda: self.r.send({"t": "interrupt"}))
        timer.start()
        t0 = time.monotonic()
        done = self.r.run("import time\nwhile True:\n    time.sleep(0.05)")
        timer.cancel()
        self.assertLess(time.monotonic() - t0, 8)
        self.assertIn("KeyboardInterrupt", done["error"])
        self.assertEqual(self.r.run("keep")["value"], "still here")

    def test_interrupt_wakes_a_pending_sub_call(self):
        def on_frame(r, f):
            if f["t"] == "llm":  # never answer it: interrupt instead
                r.send({"t": "interrupt"})

        done = self.r.run("llm('slow')", on_frame=on_frame)
        self.assertIsNotNone(done["error"])
        self.assertEqual(self.r.run("'alive'")["value"], "alive")

    def test_closing_input_releases_a_blocked_sub_call_and_exits(self):
        self.r.send({"t": "run", "program": "llm('never answered')", "cwd": os.getcwd(), "bindings": []})
        self.assertEqual(self.r.read()["t"], "llm")
        self.r.p.stdin.close()
        done = self.r.read()
        self.assertIn("closed this REPL", done["error"])
        self.assertEqual(self.r.p.wait(10), 0)


class ToolkitTest(unittest.TestCase):
    """rlmapi.py through the REPL: the sub-calls it makes, as the fake host sees them."""

    def setUp(self):
        self.r = Repl()
        self.prompts = []

    def tearDown(self):
        self.r.close()

    def answer(self, reply):
        def llm(prompt):
            self.prompts.append(prompt)
            return reply(prompt) if callable(reply) else reply
        return llm

    def test_segments_cut_at_line_ends(self):
        done = self.r.run('text = "".join(f"line {i}\\n" for i in range(400))\n'
                          's = segments(text, 1000)\n'
                          '[len(s), s[0].id, s[0].start, s[0].end, s[0].endswith("\\n"), "".join(s) == text]')
        n, first_id, start, end, at_line_end, whole = done["value"]
        self.assertGreater(n, 1)
        self.assertEqual((first_id, start), (0, 0))
        self.assertLessEqual(end, 1000)
        self.assertTrue(at_line_end and whole)
        self.assertIn("at least", self.r.run('segments("x", 10)')["error"])

    def test_over_sends_the_segment_first_and_only_once(self):
        llm = self.answer("ok")
        done = self.r.run('seg = segments("A" * 3000 + "\\n" + "B" * 10, 2000)[0]\n'
                          'llm("q1", over=seg); llm_batch(["q2", "q3"], over=seg)', llm=llm)
        self.assertIsNone(done["error"], done)
        self.assertEqual(len(self.r.blobs), 1, "the segment was sent more than once, or not at all")
        blobs_sent = [f for f in self.r.frames if f["t"] == "blob"]
        self.assertEqual(len(blobs_sent), 1)
        for prompt, q in zip(self.prompts, ("q1", "q2", "q3")):
            self.assertTrue(prompt.startswith("A" * 2000), "the segment did not come first")
            self.assertTrue(prompt.endswith(SEPARATOR + q))

    def test_shared_goes_first_and_with_over_goes_after_the_segment(self):
        llm = self.answer("ok")
        self.r.run('llm_batch(["a", "b"], shared="RULES")', llm=llm)
        self.assertEqual(self.prompts, ["RULES" + SEPARATOR + "a", "RULES" + SEPARATOR + "b"])
        self.prompts.clear()
        self.r.run('llm_batch(["a"], shared="RULES", over="SEG")', llm=llm)
        self.assertEqual(self.prompts, ["SEG" + SEPARATOR + "RULES" + SEPARATOR + "a"])

    def test_schema_parses_and_asks_again_once(self):
        replies = iter(["no json here", '```json\n{"n": 3, "ok": true}\n```'])
        done = self.r.run('llm("count", schema={"n": int, "ok": bool})', llm=self.answer(lambda p: next(replies)))
        self.assertEqual(done["value"], {"n": 3, "ok": True})
        self.assertEqual(len(self.prompts), 2)
        self.assertIn("It was not valid", self.prompts[1])
        done = self.r.run('llm_batch(["a", "b"], schema=["yes", "no"])', llm=self.answer(lambda p: '"yes"' if p.startswith("a") else "maybe"))
        self.assertEqual(done["value"], ["yes", None])
        self.assertIn("did not match the schema", done["output"])

    def test_thinking_is_passed_and_checked(self):
        self.r.run('llm("a", thinking="low")', llm=self.answer("ok"))
        item = [f for f in self.r.frames if f["t"] == "llm"][-1]["items"][0]
        self.assertEqual(item["thinking"], "low")
        self.assertIn("thinking must be one of", self.r.run('llm("a", thinking="huge")')["error"])

    def test_scan_returns_quotes_with_offsets(self):
        text = "alpha\n" * 300 + "the key fact is 42\n" + "omega\n" * 300

        def reply(prompt):
            return json.dumps({"quotes": ["the key fact is 42"] if "key fact" in prompt.split(SEPARATOR)[0] else [],
                               "note": "found"})

        done = self.r.run(f'text = {text!r}\nfound = scan(text, "what is the key fact?", size=1000)\n'
                          'found2 = [(f["quotes"][0]["at"], text[f["quotes"][0]["at"]:][:18]) for f in found]\nfound2',
                          llm=self.answer(reply))
        self.assertIsNone(done["error"], done)
        ((at, quoted),) = done["value"]
        self.assertEqual(quoted, "the key fact is 42")
        self.assertIn("scan:", done["output"])

    def test_ask_files_reads_a_glob_and_sends_each_file_first(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            for name, body in (("a.py", "print(1)\n"), ("b.py", "print(2)\n"), ("c.txt", "skip\n")):
                with open(os.path.join(d, name), "w") as f:
                    f.write(body)
            pattern = os.path.join(d, "*.py").replace("\\", "/")
            done = self.r.run(f'r = ask_files({pattern!r}, "what does it print?")\nsorted(v for v in r.values())',
                              llm=self.answer(lambda p: p.split("print(")[1][0]))
        self.assertEqual(done["value"], ["1", "2"])
        self.assertTrue(all(p.startswith("=== ") for p in self.prompts))

    def test_a_lost_prefix_is_sent_again(self):
        state = {"dropped": False}

        def on_frame(r, f):
            if f["t"] == "llm" and not state["dropped"]:
                state["dropped"] = True
                r.blobs.clear()  # the host lost it
                r.send({"t": "reply", "cid": f["cid"], "error": "unknown prefix_id: send the prefix again"})

        llm = self.answer("ok")

        def run_frame(r, f):
            on_frame(r, f)

        # the first llm frame is refused before the fake answers it; the REPL resends the blob and asks again
        def run(program):
            self.r.send({"t": "run", "program": program, "cwd": os.getcwd(), "cap": None, "bindings": []})
            while True:
                f = self.r.read()
                if f["t"] == "done":
                    return f
                if f["t"] == "blob":
                    self.r.blobs[f["id"]] = f["text"]
                elif f["t"] == "llm":
                    if not state["dropped"]:
                        run_frame(self.r, f)
                    else:
                        self.r.send({"t": "reply", "cid": f["cid"], "value": [llm(self.r.full(i)) for i in f["items"]]})

        done = run('llm("q", over="SEGMENT")')
        self.assertIsNone(done["error"], done)
        self.assertEqual(self.prompts, ["SEGMENT" + SEPARATOR + "q"])
        self.assertEqual(sum(1 for f in self.r.frames if f["t"] == "blob"), 2)


class RlmChildTest(unittest.TestCase):
    """rlm(): one blocking call to the dsh `rlm` tool."""

    def setUp(self):
        self.r = Repl()

    def tearDown(self):
        self.r.close()

    def test_rlm_calls_the_tool_and_returns_the_text(self):
        seen = []

        def rlm_tool(args):
            seen.append(args)
            return {"text": "done: " + args["task"], "childId": "c1"}

        done = self.r.run('rlm("fix it", context="INPUT")', tools={"rlm": rlm_tool})
        self.assertIsNone(done["error"], done)
        self.assertEqual(done["value"], "done: fix it")
        self.assertEqual(seen, [{"task": "fix it", "context": "INPUT"}])

    def test_rlm_without_the_tool_says_so(self):
        self.assertIn("needs RLM mode's rlm tool", self.r.run('rlm("x")')["error"])

    def test_rlm_checks_context(self):
        self.assertIn("context takes a str", self.r.run('rlm("x", context=3)', tools={"rlm": lambda a: {}})["error"])

    def test_a_failing_child_raises_in_the_cell(self):
        def rlm_tool(args):
            raise ValueError("the child run ended without an answer (error)")

        self.assertIn("ended without an answer", self.r.run('rlm("x")', tools={"rlm": rlm_tool})["error"])


if __name__ == "__main__":
    unittest.main()
