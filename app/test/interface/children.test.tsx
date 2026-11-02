// KV cache: none; a test.
// rlm() child runs in the sub-call panel and view (D-160), driven through scriptedBus on a held run: the child's row
// shows as `rlm` with its task and turn, its turns add up in one row (turn lines, summed usage), its cells reach the
// view, the calls it makes nest under it, and a run-log record's `children` give /runs the same.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { viewFromRecord } from "../../src/interface/store.ts";
import { allRows, orderedBlocks } from "../../src/interface/SubcallPanel.tsx";
import type { ChildTurn, RunChildParams } from "../../src/protocol.ts";
import { createFakeApp, runRecord, scriptedBus, scriptedUsage, type FakeApp, type FakeAppOptions, type ScriptedBus } from "../fakes/engine.ts";
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

/** A held run (the `hold` scenario) and a scriptedBus for its id. */
async function held(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; m: Mounted; sb: ScriptedBus }> {
  app = await createFakeApp({ scenario: "hold", size: { columns: 120, rows: 40 }, ...opts });
  m = mount(app.deps);
  await m.waitForText("idle");
  await m.type("Summarize @a.txt");
  await m.press(KEYS.enter);
  await m.waitForText("running");
  const runId = await m.waitFor(() => app!.engine.runId);
  return { app, m, sb: scriptedBus(app.bus, runId) };
}

const TASK = "Find where the config file is parsed and name the function.";
const CHILD_BATCH = { id: "rlm1", index: 0, size: 1 };
const CHILD_ORIGIN = { turn: 1, line: 2 };
const turn = (k: number): ChildTurn => ({ id: 1, turn: k, max_turns: 30, depth: 1 });

function childEvent(sb: ScriptedBus, over: Partial<RunChildParams>): void {
  sb.event("run.child", {
    child_id: 1,
    subcall_id: 4,
    depth: 1,
    status: "started",
    task: TASK,
    tools: "read",
    turn: 0,
    max_turns: 30,
    code: null,
    output: null,
    error: null,
    answer: null,
    seconds: null,
    ...over,
  });
}

/** What the engine sends when rlm() starts: the child's row, then run.child started. */
function startChild(sb: ScriptedBus): void {
  sb.subcall({ subcall_id: 4, batch: CHILD_BATCH, origin: CHILD_ORIGIN, prompt_chars: TASK.length });
  childEvent(sb, {});
}

/** One of the child's turns: call.start with `child`, a reply, call.end with scriptedUsage, then its cell. */
function childTurn(sb: ScriptedBus, k: number, reply: string, cell: { code: string; output: string; error?: string | null }): void {
  const id = `child-${k}`;
  sb.callStart(id, { subcall_id: 4, batch: CHILD_BATCH, origin: CHILD_ORIGIN, prompt: k === 1 ? `Task: ${TASK}` : "REPL output: ...", child: turn(k) });
  sb.delta(id, { text: reply });
  sb.callEnd(id);
  childEvent(sb, { status: "turn", turn: k, code: cell.code, output: cell.output, error: cell.error ?? null });
}

/** Tab to the panel, Down `n` times, Enter. */
async function openItem(m: Mounted, n: number): Promise<void> {
  await m.press(KEYS.tab);
  for (let i = 0; i < n; i++) await m.press(KEYS.down);
  await m.press(KEYS.enter);
}

describe("rlm() children in the sub-call panel", () => {
  test("a child row shows as rlm with its turn, status and task, in a block of its own", async () => {
    const { m, sb } = await held();
    startChild(sb);
    sb.callStart("child-1", { subcall_id: 4, batch: CHILD_BATCH, origin: CHILD_ORIGIN, prompt: `Task: ${TASK}`, child: turn(1) });
    const s = await m.waitForText("rlm  turn 1/30");
    expect(s).toContain("rlm1  turn 1/30  running  turn 1 line 2");
    const row = s.split("\n").find((l) => l.includes("#04"))!;
    expect(row).toMatch(/#04 running\s+rlm  turn 1\/30 .*Find where the config file is parsed/);
    expect(s).not.toContain("Task: Find where"); // the task, not the turn's prompt
    sb.callEnd("child-1");
  });

  test("turns add up in one row: it stays running after call.end, usage sums, and only run.child done ends it", async () => {
    const { m, sb } = await held();
    startChild(sb);
    childTurn(sb, 1, "Searching for the loader.", { code: "print(grep('def load_config'))", output: "src/config.py:12: def load_config(path):\n" });
    await m.waitForText("1.2k in 340 out");
    childTurn(sb, 2, "Found it.", { code: "submit('load_config')", output: "" });
    let s = await m.waitForText("2.4k in 680 out");
    expect(s).toContain("rlm1  turn 2/30  running");
    expect(s).toMatch(/#04 running/);
    childEvent(sb, { status: "done", turn: 2, answer: "load_config", seconds: 4.2 });
    sb.subcall({ subcall_id: 4, batch: CHILD_BATCH, origin: CHILD_ORIGIN, prompt_chars: TASK.length, status: "done", seconds: 4.2 });
    s = await m.waitForText("rlm1  turn 2/30  done");
    expect(s).toContain("4.2s");
    expect(s).toContain("(Enter expands)"); // a finished child collapses like a finished batch
  });

  test("the view of a child: turn lines between the replies, its cells, summed tokens, then its answer", async () => {
    const { m, sb } = await held();
    startChild(sb);
    childTurn(sb, 1, "Searching for the loader.", { code: "print(grep('def load_config'))", output: "src/config.py:12: def load_config(path):\n" });
    childTurn(sb, 2, "Found it.", { code: "x = 1/0", output: "", error: "ZeroDivisionError: division by zero" });
    await m.waitForText("turn 2/30");
    await openItem(m, 1);
    let s = await m.waitForText("rlm1 child run");
    expect(s).toContain("depth 1, tools read");
    expect(s).toContain("model fake/scripted");
    expect(s).toContain("Issued by turn 1, line 2");
    expect(s).toContain("tokens in 2.4k (cached 1.6k)  out 680");
    expect(s).toContain("cost $0.0046");
    expect(s).toContain(TASK);
    const lines = s.split("\n");
    const at = (text: string) => lines.findIndex((l) => l.includes(text));
    expect(at("── turn 1 ──")).toBeGreaterThan(-1);
    expect(at("── turn 1 ──")).toBeLessThan(at("Searching for the loader."));
    expect(at("Searching for the loader.")).toBeLessThan(at("── turn 2 ──"));
    expect(at("── turn 2 ──")).toBeLessThan(at("Found it."));
    expect(s).toContain("│ print(grep('def load_config'))");
    expect(s).toContain("src/config.py:12: def load_config(path):");
    expect(s).toContain("ZeroDivisionError: division by zero");
    expect(s).toContain("(waiting)"); // no answer yet
    childEvent(sb, { status: "done", turn: 2, answer: ["src/config.py", 12], seconds: 3 });
    s = await m.waitForText('["src/config.py",12]');
    expect(s).toContain("done");
  });

  test("a reset during a child's turn drops that turn's text only", async () => {
    const { m, sb } = await held();
    startChild(sb);
    childTurn(sb, 1, "first turn text", { code: "print(1)", output: "1\n" });
    sb.callStart("child-2", { subcall_id: 4, batch: CHILD_BATCH, origin: CHILD_ORIGIN, prompt: "obs", child: turn(2) });
    sb.delta("child-2", { text: "broken half" });
    await m.waitForText("turn 2/30");
    await openItem(m, 1);
    await m.waitForText("broken half");
    sb.delta("child-2", { reset: true });
    sb.delta("child-2", { text: "whole again" });
    const s = await m.waitForText("whole again");
    expect(s).not.toContain("broken half");
    expect(s).toContain("first turn text");
    expect(s).toContain("── turn 2 ──");
    sb.callEnd("child-2");
  });

  test("a child's run.child error marks its row err with the message", async () => {
    const { m, sb } = await held();
    startChild(sb);
    childTurn(sb, 1, "Trying.", { code: "print(1)", output: "1\n" });
    childEvent(sb, { status: "error", turn: 1, error: "the child ran out of turns", seconds: 9 });
    await m.waitForText("rlm1  turn 1/30  err");
    await openItem(m, 0); // the ended child collapsed: expand it
    await m.waitForText("#04 err");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    const s = await m.waitForText("the child ran out of turns");
    expect(s).toContain("rlm1 child run  err");
  });

  test("the calls a child makes nest under it, apart from the root's batch of the same id", async () => {
    const { m, sb } = await held();
    sb.subcall({ subcall_id: 1, batch: { id: "b1", index: 0, size: 1 }, origin: { turn: 1, line: 1 } }); // the root's own llm()
    startChild(sb);
    childTurn(sb, 1, "Asking a sub-call.", { code: "a = 1\nprint(llm('Summarize config.py'))", output: "It loads YAML.\n" });
    const childOrigin = { turn: 1, line: 2, child: 1 };
    sb.subcall({ subcall_id: 5, batch: { id: "b1", index: 0, size: 2 }, origin: childOrigin });
    sb.subcall({ subcall_id: 6, batch: { id: "b1", index: 1, size: 2 }, origin: childOrigin });
    sb.callStart("cs5", { subcall_id: 5, batch: { id: "b1", index: 0, size: 2 }, origin: childOrigin, prompt: "Summarize config.py" });
    sb.callStart("cs6", { subcall_id: 6, batch: { id: "b1", index: 1, size: 2 }, origin: childOrigin, prompt: "Summarize loader.py" });
    let s = await m.waitForText("↳ rlm1");
    const lines = s.split("\n");
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const rootBlock = at(/batch b1  1 call/);
    const childBlock = at(/rlm1  turn 1\/30/);
    const nested = at(/↳ rlm1  batch b1  2 calls/);
    expect(rootBlock).toBeGreaterThan(-1);
    expect(childBlock).toBeGreaterThan(rootBlock);
    expect(nested).toBeGreaterThan(childBlock);
    expect(lines[nested]!.match(/^\s*/)![0].length).toBeGreaterThan(lines[childBlock]!.match(/^\s*/)![0].length); // indented
    const r5 = at(/#05 streaming/);
    expect(r5).toBeGreaterThan(nested);
    expect(lines[r5]!.match(/^\s*/)![0].length).toBeGreaterThan(lines[at(/#04 running/)]!.match(/^\s*/)![0].length);
    // the nested row's view names the child's cell line
    await m.press(KEYS.tab);
    for (let i = 0; i < 5; i++) await m.press(KEYS.down); // block b1, #01, block rlm1, #04, block ↳ b1, #05
    await m.press(KEYS.enter);
    s = await m.waitForText("Sub-call #05");
    expect(s).toContain("Issued by rlm1 turn 1, line 2: print(llm('Summarize config.py'))");
    sb.callEnd("cs5");
    sb.callEnd("cs6");
  });

  test("a finished child collapses with the calls nested under it", async () => {
    const { m, sb } = await held();
    startChild(sb);
    const childOrigin = { turn: 1, line: 1, child: 1 };
    sb.subcall({ subcall_id: 5, batch: { id: "b1", index: 0, size: 1 }, origin: childOrigin });
    sb.callStart("cs5", { subcall_id: 5, batch: { id: "b1", index: 0, size: 1 }, origin: childOrigin });
    sb.callEnd("cs5");
    sb.subcall({ subcall_id: 5, batch: { id: "b1", index: 0, size: 1 }, origin: childOrigin, status: "done", seconds: 1 });
    await m.waitForText("↳ rlm1");
    childEvent(sb, { status: "done", turn: 1, answer: "x", seconds: 2 });
    sb.subcall({ subcall_id: 4, batch: CHILD_BATCH, origin: CHILD_ORIGIN, status: "done", seconds: 2 });
    await m.waitFor(() => m.screen().includes("rlm1  turn 1/30  done") && !m.screen().includes("↳ rlm1"));
    await openItem(m, 0); // Enter on the child's block expands it and what it made
    await m.waitForText("↳ rlm1");
  });

  test("ASCII mode: `-- turn k --` lines and `-> rlm<n>`", async () => {
    const { m, sb } = await held({ env: { RLMH_ASCII: "1" } });
    startChild(sb);
    childTurn(sb, 1, "Asking.", { code: "print(1)", output: "1\n" });
    const childOrigin = { turn: 1, line: 1, child: 1 };
    sb.subcall({ subcall_id: 5, batch: { id: "b1", index: 0, size: 1 }, origin: childOrigin });
    sb.callStart("cs5", { subcall_id: 5, batch: { id: "b1", index: 0, size: 1 }, origin: childOrigin });
    let s = await m.waitForText("-> rlm1");
    expect(s).not.toContain("↳");
    await openItem(m, 1);
    s = await m.waitForText("rlm1 child run");
    expect(s).toContain("-- turn 1 --");
    expect(s).toContain("| print(1)");
    expect(s).not.toContain("──");
    sb.callEnd("cs5");
  });
});

describe("children in a run-log record (/runs)", () => {
  function recordWithChild(): Record<string, any> {
    const base = runRecord();
    const childUsage = scriptedUsage({ input_tokens: 2400, output_tokens: 680 });
    const turns = [
      { turn: 1, reply: "Searching.", tool_call: null, reasoning: "Grep first.", finish_reason: "tool_call", usage: scriptedUsage(), code: "print(llm('Summarize config.py'))", stdout: "It loads YAML.\n", stdout_chars: 15, error: null, observation: "REPL output: ...", root_s: 1 },
      { turn: 2, reply: "Done.", tool_call: null, reasoning: null, finish_reason: "tool_call", usage: scriptedUsage(), code: "submit('load_config')", stdout: "", stdout_chars: 0, error: null, observation: null, root_s: 1 },
    ];
    return runRecord({
      subcalls: [
        ...base.subcalls,
        { subcall_id: 4, origin: { turn: 1, line: 2 }, batch: { id: "rlm1", index: 0, size: 1 }, prompt: TASK, output: '"load_config"', error: null, seconds: 4.2, usage: childUsage },
        { subcall_id: 5, origin: { turn: 1, line: 1, child: 1 }, batch: { id: "b1", index: 0, size: 1 }, prompt: "Summarize config.py", output: "It loads YAML.", error: null, seconds: 0.8, usage: scriptedUsage() },
      ],
      children: [
        { child_id: 1, subcall_id: 4, parent_child: null, depth: 1, task: TASK, tools: "read", max_turns: 30, turns, submitted: true, answer: "load_config", error: null, usage: childUsage, seconds: 4.2 },
      ],
    });
  }

  test("viewFromRecord gives the child's row its turns, cells and answer, and nests its calls", () => {
    const view = viewFromRecord(recordWithChild());
    const rows = allRows(view.blocks);
    expect(rows.map((r) => r.key)).toEqual(["s1", "s2", "s3", "s4", "s1.5"]);
    const child = rows.find((r) => r.key === "s4")!;
    expect(child.child).toMatchObject({ id: 1, depth: 1, task: TASK, tools: "read", turn: 2, maxTurns: 30, answer: "load_config", done: true });
    expect(child.child!.cells).toEqual([
      { turn: 1, code: "print(llm('Summarize config.py'))", output: "It loads YAML.\n", error: null },
      { turn: 2, code: "submit('load_config')", output: "", error: null },
    ]);
    expect(child.text).toBe("── turn 1 ──\nSearching.\n── turn 2 ──\nDone.");
    expect(child.reasoning).toBe("── turn 1 ──\nGrep first.");
    expect(child.status).toBe("done");
    expect(child.usage!.input_tokens).toBe(2400);
    expect(child.model).toEqual(view.root);
    expect(orderedBlocks(view.blocks).map(({ block, depth }) => [block.id, block.child, depth])).toEqual([
      ["b1", null, 0],
      ["rlm1", null, 0],
      ["b1", 1, 1],
    ]);
    expect(viewFromRecord(recordWithChild(), { unicode: false }).blocks[1]!.rows[0]!.text).toStartWith("-- turn 1 --\n");
    // a record from before D-160 has no `children` at all
    const old = runRecord();
    delete old.children;
    expect(allRows(viewFromRecord(old).blocks).every((r) => r.child === null)).toBe(true);
  });

  test("/runs replays the child as a live run shows it", async () => {
    app = await createFakeApp({ scenario: "hold", size: { columns: 120, rows: 40 } });
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(app.deps.home, "runs", "interactive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(recordWithChild())}\n`);
    m = mount(app.deps);
    await m.waitForText("idle");
    await m.type("/runs");
    await m.press(KEYS.enter);
    await m.waitForText("What number does the ledger end on?");
    await m.press(KEYS.enter); // replay the one run
    await m.waitForText("(read-only)");
    await m.press(KEYS.tab);
    let s = await m.waitForText("rlm1  turn 2/30  done");
    await m.press(KEYS.down);
    await m.press(KEYS.enter); // expand the child's block
    s = await m.waitForText("↳ rlm1");
    expect(s).toMatch(/#04 done\s+rlm  turn 2\/30/);
  });
});
