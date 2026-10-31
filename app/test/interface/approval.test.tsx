// KV cache: none; a test.
// Approvals answered from the keyboard: y, a, n, Enter on the highlight, Esc, the queue, the
// detail cap, and clean-up when the run ends.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { ApprovalParams, ApprovalResult } from "../../src/protocol.ts";
import { createFakeApp, type FakeApp, type FakeAppOptions } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

setDefaultTimeout(20_000);

let app: FakeApp | undefined;
let m: Mounted | undefined;

afterEach(async () => {
  m?.unmount();
  await app?.dispose();
  app = undefined;
  m = undefined;
});

/** The app, plus every answer the engine got back for its approval.request. */
async function open(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; m: Mounted; answers: ApprovalResult[] }> {
  app = await createFakeApp({ scenario: "approvalShell", ...opts });
  const answers: ApprovalResult[] = [];
  const q = app.deps.approvals;
  const ask = q.ask.bind(q);
  q.ask = (p: ApprovalParams) =>
    ask(p).then((r) => {
      answers.push(r);
      return r;
    });
  m = mount(app.deps);
  await m.waitForText("idle");
  await m.type("Summarize @a.txt");
  await m.press(KEYS.enter);
  return { app, m, answers };
}

const SHELL_PROMPT = "Allow for this run: every later shell command in this run";

describe("approvals", () => {
  test("(1) the prompt shows the kind, the detail and the three choices, above the prompt box", async () => {
    const { m } = await open();
    const s = await m.waitForText("ls -la");
    const lines = s.split("\n");
    const at = (t: string) => lines.findIndex((l) => l.includes(t));
    expect(at("shell")).toBeGreaterThan(-1);
    expect(at("y  Allow once")).toBeGreaterThan(at("ls -la"));
    expect(at(SHELL_PROMPT)).toBeGreaterThan(at("y  Allow once"));
    expect(at("n  Deny")).toBeGreaterThan(at(SHELL_PROMPT));
    expect(at("> n  Deny")).toBeGreaterThan(-1); // the highlight starts on Deny
    expect(at("Summarize a.txt") === -1 || at("Summarize a.txt") < at("shell")).toBe(true);
    const box = lines.findLastIndex((l) => /^[│|] > /.test(l)); // the prompt box is the last such line
    expect(box).toBeGreaterThan(at("n  Deny"));
    await m.waitForText("waiting for approval");
  });

  test("(2) y allows once, and the cell prints ok", async () => {
    const { m, answers } = await open();
    await m.waitForText("ls -la");
    await m.press("y");
    await m.waitForText("finished");
    expect(answers).toEqual([{ allow: true, remember_for_run: false }]);
    expect(m.frames.some((f) => /\n\s+ok\n/.test(f))).toBe(true);
  });

  test("(3) a allows for the rest of the run", async () => {
    const { m, answers } = await open();
    await m.waitForText("ls -la");
    await m.press("a");
    await m.waitForText("finished");
    expect(answers).toEqual([{ allow: true, remember_for_run: true }]);
  });

  for (const [name, key] of [
    ["n", "n"],
    ["Enter on the default highlight", KEYS.enter],
    ["Esc", KEYS.esc],
  ] as const) {
    test(`(4) ${name} denies, and the cell gets a PermissionError`, async () => {
      const { app, m, answers } = await open();
      await m.waitForText("ls -la");
      await m.press(key);
      await m.waitForText("finished");
      expect(answers).toEqual([{ allow: false, remember_for_run: false }]);
      expect(m.frames.some((f) => f.includes("PermissionError: shell command denied: ls -la"))).toBe(true);
      expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(false);
    });
  }

  test("(4) Esc denies without cancelling; a second Esc cancels", async () => {
    const slowTurn2 = {
      root: [
        { text: "Listing.", tool_call: { code: "print(shell('ls -la'))" } },
        { text: "Now a long reply that streams slowly enough to press Esc in the middle of it, and then some more.", tool_call: { code: "submit('ok')" } },
      ],
      chunk_chars: 2,
      delay_ms: 60,
    };
    const { app, m, answers } = await open({ script: slowTurn2 });
    await m.waitForText("ls -la");
    await m.press(KEYS.esc);
    await m.waitForText("turn 2");
    expect(answers).toEqual([{ allow: false, remember_for_run: false }]);
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(false);
    await m.press(KEYS.esc);
    await m.waitForText("Run cancelled.");
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(true);
  });

  test("(5) Down then Enter picks the highlighted choice", async () => {
    const { m, answers } = await open();
    await m.waitForText("ls -la");
    await m.press(KEYS.down); // from Deny round to Allow once
    await m.waitForText("> y  Allow once");
    await m.press(KEYS.enter);
    await m.waitForText("finished");
    expect(answers).toEqual([{ allow: true, remember_for_run: false }]);
  });

  test("(6) two at once: the head shows +1 waiting, and they are answered in order", async () => {
    const { m, answers } = await open({ scenario: "twoApprovals" });
    let s = await m.waitForText("+1 waiting");
    expect(s).toContain("/outside/notes.txt");
    expect(s).toContain("outside the workspace");
    expect(s).toContain("Allow for this run: every later write outside the workspace in this run");
    await m.press("y");
    s = await m.waitForText("example.com");
    expect(s).not.toContain("+1 waiting");
    expect(s).toContain("this host, for the rest of this run");
    await m.press("n");
    await m.waitForText("finished");
    expect(answers).toEqual([
      { allow: true, remember_for_run: false },
      { allow: false, remember_for_run: false },
    ]);
  });

  test("(7) y goes to the prompt box when nothing is pending; other keys don't reach it while one is", async () => {
    const { m } = await open();
    await m.waitForText("ls -la");
    await m.press("x");
    await m.press("q");
    await new Promise((r) => setTimeout(r, 100));
    expect(m.screen()).toMatch(/[│|] > {1,2}A run is active/);
    await m.press("y");
    await m.waitForText("finished");
    await m.press("y");
    await m.waitFor(() => /[│|] > y /.test(m.screen()));
  });

  test("(8) a long command shows 600 characters and the rest as a count", async () => {
    const command = `echo ${"a".repeat(695)}`;
    const { m } = await open({ script: { root: [{ text: "", tool_call: { code: `print(shell('${command}'))` } }, { text: "", tool_call: { code: "submit('ok')" } }] } });
    const s = await m.waitForText("(+100 chars)");
    expect(s.match(/a/g)!.length).toBeGreaterThanOrEqual(595);
    expect(s).not.toContain("outside the workspace");
    await m.press("n");
  });

  test("(9) run.finished with an approval pending clears it and answers deny", async () => {
    const { app, m, answers } = await open();
    await m.waitForText("ls -la");
    app.engine.emit("run.finished", {
      tag: null,
      answer: null,
      submitted: false,
      answer_valid: true,
      turns: 1,
      subcalls: 0,
      usage: { root: zero(), sub: zero() },
      cost_usd: 0,
      infra_error: null,
      infra_kind: null,
      wall_s: 1,
      log_path: "x",
    });
    await m.waitFor(() => !m.screen().includes("Allow once"));
    await m.waitFor(() => answers.length === 1);
    expect(answers).toEqual([{ allow: false, remember_for_run: false }]);
    expect(app.deps.approvals.size).toBe(0);
  });

  test("(10) the run.permission event shows in /permissions", async () => {
    const { m } = await open();
    await m.waitForText("ls -la");
    await m.press("y");
    await m.waitForText("finished");
    await m.type("/permissions");
    await m.press(KEYS.enter);
    await m.waitForText("turn 1  shell ls -la allowed (asked)");
  });
});

function zero() {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
}
