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


class Repl:
    """A REPL child. `run()` sends one cell and answers call/llm frames with the given fakes until it is done."""

    def __init__(self):
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
            elif f["t"] == "llm" and llm is not None:
                self.send({"t": "reply", "cid": f["cid"], "value": [llm(p) for p in f["prompts"]]})

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


if __name__ == "__main__":
    unittest.main()
