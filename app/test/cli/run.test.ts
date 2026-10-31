// KV cache: none
// `rlmh run` end to end: the real engine from source and the scripted fake provider, run as a child
// process with piped stdio, so it is never a TTY. Also createTtyApprover with piped streams.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createTtyApprover, type CliIO } from "../../src/cli/run.ts";
import type { ApprovalParams } from "../../src/protocol.ts";
import { cleanEnv, EVENT_KEYS, jsonLines, lastRecord, MAIN, APP, RECORD_KEYS, REAL, rlmh, sorted, temp, type Temp } from "./helpers.ts";

let t: Temp;
let question: string;
beforeAll(() => {
  t = temp("rlmh-run-");
  question = t.file("q.txt", "The answer is forty-two.\n");
});
afterAll(() => t.cleanup());

const FAKE = ["--root", "fake/scripted", "--sub", "fake/scripted"];

function read(...extra: string[]): string[] {
  return ["run", "--question", "What is the answer?", "--input", question, ...FAKE, ...extra];
}

function checkKeys(events: any[]): void {
  for (const e of events) {
    const { type, ...rest } = e;
    expect(EVENT_KEYS[type]).toBeDefined();
    expect([type, sorted(Object.keys(rest))]).toEqual([type, sorted(EVENT_KEYS[type]!)]);
  }
}

describe("--json", () => {
  test(
    "native",
    async () => {
      const script = t.script({
        root: [
          { text: "Look first.\n```python\nprint(llm('Summarize: ' + context[:10]))\n```" },
          { text: "", tool_call: { code: "submit('42')" } },
        ],
        sub: [{ match: "^Summarize", text: "a summary" }, { text: "default sub-call answer" }],
      });
      const r = await rlmh(read("--call-format", "native", "--json"), { home: t.home, script });
      expect(r.code).toBe(0);
      const events = jsonLines(r.stdout); // every stdout line parses: nothing else is on stdout
      const types = events.map((e) => e.type);
      expect(types[0]).toBe("run.started");
      expect(types[types.length - 1]).toBe("run.finished");
      for (const type of ["run.reply", "run.cell", "run.budget", "run.subcall", "gateway.call"]) expect(types).toContain(type);
      checkKeys(events);
      const calls = events.filter((e) => e.type === "gateway.call");
      expect(new Set(calls.map((c) => c.role))).toEqual(new Set(["root", "sub"]));
      expect(calls.find((c) => c.role === "sub").subcall_id).toBe(1);
      const started = events[0];
      expect(started.call_format).toBe("native");
      expect(started.log_path).toBe(join(t.home, "runs", "cli", "runs.jsonl"));
      const finished = events[events.length - 1];
      expect(finished.answer).toBe("42");
      expect(finished.infra_error).toBeNull();
      expect(finished.subcalls).toBe(1);

      const rec = await lastRecord(finished.log_path);
      expect(sorted(Object.keys(rec))).toEqual(sorted(RECORD_KEYS));
      expect(rec.format).toBe(1);
      expect(rec.run_id).toBe(finished.run_id);
      expect(rec.batch).toBe("cli");
      expect(rec.usage.root.input_tokens).toBeGreaterThan(0);
      expect(rec.answer).toBe("42");
      expect(rec.turns.length).toBe(finished.turns);
      expect(rec.subcalls.length).toBe(1);
    },
    REAL,
  );

  test(
    "fenced",
    async () => {
      const script = t.script({
        root: [{ text: "```python\nprint(llm('Summarize this'))\n```" }, { text: "Done.\n```python\nsubmit('42')\n```" }],
        sub: [{ text: "a summary" }],
      });
      const r = await rlmh(read("--call-format", "fenced", "--json"), { home: t.home, script });
      expect(r.code).toBe(0);
      const events = jsonLines(r.stdout);
      checkKeys(events);
      expect(events[0].type).toBe("run.started");
      expect(events[0].call_format).toBe("fenced");
      const finished = events[events.length - 1];
      expect(finished.type).toBe("run.finished");
      expect(finished.answer).toBe("42");
      expect(events.filter((e) => e.type === "run.reply").every((e) => e.tool_call === null)).toBe(true);
      const rec = await lastRecord(finished.log_path);
      expect(rec.run_id).toBe(finished.run_id);
      expect(rec.call_format).toBe("fenced");
      expect(rec.turns.length).toBe(2);
    },
    REAL,
  );
});

test(
  "plain mode: only the answer on stdout",
  async () => {
    const script = t.script({ root: [{ text: "```python\nprint(len(context))\n```" }, { text: "", tool_call: { code: "submit('42')" } }] });
    const r = await rlmh(read(), { home: t.home, script });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("42\n");
    expect(r.stderr).toContain("run finished");
    expect(r.stderr).toContain("started: read mode");
  },
  REAL,
);

test(
  "plain mode: a non-string answer is printed as JSON",
  async () => {
    const script = t.script({ root: [{ text: "", tool_call: { code: "submit([1, 'two', 3.5])" } }] });
    const r = await rlmh(read(), { home: t.home, script });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('[1,"two",3.5]\n');
  },
  REAL,
);

test(
  "an infra error exits 1",
  async () => {
    const script = t.script({ root: [{ text: "hi" }], errors: [{ role: "root", at: 1, kind: "auth", status: 401 }] });
    const r = await rlmh(read("--json"), { home: t.home, script });
    expect(r.code).toBe(1);
    const finished = jsonLines(r.stdout).pop();
    expect(finished.type).toBe("run.finished");
    expect(finished.infra_kind).toBe("auth");
  },
  REAL,
);

describe("usage errors exit 2", () => {
  test("before the engine starts", async () => {
    const none = await rlmh(["run"], { home: t.home });
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("--question");
    expect(none.stdout).toBe("");

    const noInput = await rlmh(["run", "--question", "Q?", ...FAKE], { home: t.home });
    expect(noInput.code).toBe(2);
    expect(noInput.stderr).toContain("--input");

    const noRoot = await rlmh(["run", "--question", "Q?", "--input", question], { home: t.home });
    expect(noRoot.code).toBe(2);
    expect(noRoot.stderr).toContain("rlmh config set root.model");

    const mixed = await rlmh(["run", "--question", "Q?", "--input", question, "--task", "T", ...FAKE], { home: t.home });
    expect(mixed.code).toBe(2);

    const badEnum = await rlmh(read("--call-format", "xml"), { home: t.home });
    expect(badEnum.code).toBe(2);
    expect(badEnum.stderr).toContain("call format");
  });

  test(
    "from the engine: an unknown profile and a missing input file",
    async () => {
      const script = t.script({ root: [] });
      const profile = await rlmh(read("--profile", "no-such-profile"), { home: t.home, script });
      expect(profile.code).toBe(2);
      expect(profile.stderr).toContain("no-such-profile");
      expect(profile.stdout).toBe("");

      const missing = await rlmh(["run", "--question", "Q?", "--input", join(t.dir, "missing.txt"), ...FAKE], { home: t.home, script });
      expect(missing.code).toBe(2);
      expect(missing.stderr).toContain("missing.txt");
    },
    REAL,
  );
});

test(
  "no TTY: a fetch in default mode is denied without asking",
  async () => {
    const script = t.script({
      root: [{ text: "", tool_call: { code: "fetch('http://127.0.0.1:9/')" } }, { text: "", tool_call: { code: "submit('done')" } }],
    });
    const r = await rlmh(read("--permission-mode", "default", "--json"), { home: t.home, script });
    expect(r.code).toBe(0);
    const events = jsonLines(r.stdout);
    const perms = events.filter((e) => e.type === "run.permission");
    expect(perms.length).toBe(1);
    expect(perms[0]).toMatchObject({ kind: "network", allowed: false, asked: false });
    const cell = events.find((e) => e.type === "run.cell" && e.turn === 1);
    expect(cell.error).toContain("PermissionError");
  },
  REAL,
);

test.skipIf(process.platform === "win32")(
  "Ctrl-C cancels the run and exits 130",
  async () => {
    const script = t.script({ root: [{ text: "x".repeat(400) }], chunk_chars: 1, delay_ms: 50 });
    const proc = Bun.spawn({
      cmd: [process.execPath, MAIN, ...read("--json")],
      cwd: APP,
      env: cleanEnv({ RLMH_HOME: t.home, RLMH_FAKE_SCRIPT: script }),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    proc.stdin.end();
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    let text = "";
    while (!text.includes('"run.started"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await Bun.sleep(300); // inside the slow root call
    proc.kill("SIGINT");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(await proc.exited).toBe(130);
    const finished = jsonLines(text).pop();
    expect(finished.type).toBe("run.finished");
    expect(finished.infra_kind).toBe("cancelled");
  },
  REAL,
);

describe("createTtyApprover", () => {
  const ask = (kind: ApprovalParams["kind"] = "network"): ApprovalParams => ({
    run_id: "r_000000000000",
    kind,
    detail: "GET http://127.0.0.1:9/",
    turn: 1,
    inside_workspace: false,
  });

  function io(isTTY: boolean): { io: CliIO; stdin: PassThrough; err: string[] } {
    const stdin = new PassThrough();
    const err: string[] = [];
    return { io: { stdout: { write: () => {} }, stderr: { write: (s) => void err.push(s) }, stdin, isTTY, home: "" }, stdin, err };
  }

  test("answers from piped stdin", async () => {
    const { io: cli, stdin, err } = io(true);
    const approve = createTtyApprover(cli);
    try {
      let answer = approve(ask());
      stdin.write("y\n");
      expect(await answer).toEqual({ allow: true, remember_for_run: false });
      expect(err.join("")).toBe(
        "[permission] network: GET http://127.0.0.1:9/ (outside the workspace)\nAllow? [y]es / [a]llow for this run / [N]o: ",
      );

      answer = approve({ ...ask("write"), inside_workspace: true });
      stdin.write("a\n");
      expect(await answer).toEqual({ allow: true, remember_for_run: true });
      expect(err.join("")).toContain("[permission] write: GET http://127.0.0.1:9/ (inside the workspace)");

      answer = approve(ask());
      stdin.write("\n"); // Enter denies
      expect(await answer).toEqual({ allow: false, remember_for_run: false });

      answer = approve(ask());
      stdin.write("n\n");
      expect(await answer).toEqual({ allow: false, remember_for_run: false });

      answer = approve(ask());
      stdin.write("YES\r\n");
      expect(await answer).toEqual({ allow: true, remember_for_run: false });

      // two at once: one prompt at a time, answered in order
      err.length = 0;
      const first = approve(ask("shell"));
      const second = approve(ask("write"));
      await Bun.sleep(10);
      expect(err.join("").match(/\[permission\]/g)?.length).toBe(1);
      stdin.write("y\nn\n");
      expect(await first).toEqual({ allow: true, remember_for_run: false });
      expect(await second).toEqual({ allow: false, remember_for_run: false });
      expect(err.join("").match(/\[permission\]/g)?.length).toBe(2);

      // EOF denies, now and later
      answer = approve(ask());
      stdin.end();
      expect(await answer).toEqual({ allow: false, remember_for_run: false });
      expect(await approve(ask())).toEqual({ allow: false, remember_for_run: false });
    } finally {
      approve.close();
    }
  });

  test("Ctrl-C at a prompt denies it", async () => {
    const { io: cli } = io(true);
    const approve = createTtyApprover(cli);
    try {
      expect(approve.interrupt()).toBe(false); // nothing on screen
      const answer = approve(ask());
      await Bun.sleep(5);
      expect(approve.interrupt()).toBe(true);
      expect(await answer).toEqual({ allow: false, remember_for_run: false });
    } finally {
      approve.close();
    }
  });

  test("no TTY: denies without prompting", async () => {
    const { io: cli, err } = io(false);
    const approve = createTtyApprover(cli);
    expect(await approve(ask())).toEqual({ allow: false, remember_for_run: false });
    expect(err).toEqual([]);
    approve.close();
  });
});
