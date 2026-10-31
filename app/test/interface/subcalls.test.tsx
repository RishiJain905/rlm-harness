// KV cache: none; a test.
// The sub-call panel and the sub-call view: the real 20-way fan-out through the gateway, the
// window at 80x24, the view of one row, and scriptedBus for reasoning, refusals, errors and floods.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createFakeApp, scriptedBus, type FakeApp, type FakeAppOptions, type ScriptedBus } from "../fakes/engine.ts";
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

async function open(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; m: Mounted }> {
  app = await createFakeApp(opts);
  m = mount(app.deps);
  await m.waitForText("idle");
  return { app, m };
}

async function ask(m: Mounted, text = "Summarize @a.txt"): Promise<void> {
  await m.type(text);
  await m.press(KEYS.enter);
}

/** A held run (the `hold` scenario) and a scriptedBus for its id. */
async function held(): Promise<{ app: FakeApp; m: Mounted; sb: ScriptedBus }> {
  const { app, m } = await open({ scenario: "hold" });
  await ask(m);
  await m.waitForText("running");
  const runId = await m.waitFor(() => app.engine.runId);
  return { app, m, sb: scriptedBus(app.bus, runId) };
}

/** Once the panel shows, Tab to it, then Down `n` times, then Enter. */
async function openRow(m: Mounted, n: number): Promise<void> {
  await m.waitForText("batch ");
  await m.press(KEYS.tab);
  for (let i = 0; i < n; i++) await m.press(KEYS.down);
  await m.press(KEYS.enter);
}

// slow enough to act while the batch streams: about 2 s per sub-call, two waves of 16 and 4
const SLOW_FAN_OUT = { chunk_chars: 2, delay_ms: 120 };

describe("sub-call panel", () => {
  test("(1) fanOut20: one block of 20 that streams, then 20/20 done with real tokens", async () => {
    const { m } = await open({ scenario: "fanOut20", size: { columns: 100, rows: 60 } });
    await ask(m);
    await m.waitForText("finished", 10_000);
    const blocks = new Set(m.frames.flatMap((f) => [...f.matchAll(/batch (b\d+)/g)].map((x) => x[1])));
    expect([...blocks]).toEqual(["b1"]);
    expect(m.frames.some((f) => f.includes("batch b1  20 calls"))).toBe(true);
    // at least one frame shows a row streaming with some of its answer in
    expect(m.frames.some((f) => /streaming\s+~\d+ in ~[1-9]\d* out/.test(f))).toBe(true);
    expect(m.screen()).toContain("20/20 done");
    await m.press(KEYS.tab);
    await m.press(KEYS.enter); // expand the finished block
    const s = await m.waitForText("#20");
    const rows = s.split("\n").filter((l) => /#\d\d /.test(l));
    expect(rows).toHaveLength(20);
    for (const r of rows) expect(r).toMatch(/done\s+[1-9]\d* in [1-9]\d* out/);
  });

  test("(2) at 80x24 everything fits rows - 1; the rows window around the selection", async () => {
    const { m } = await open({ scenario: "fanOut20", size: { columns: 80, rows: 24 } });
    await ask(m);
    await m.waitForText("finished", 10_000);
    for (const f of m.frames) expect(f.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(23);
    expect(m.frames.some((f) => /v \d+ more/.test(f))).toBe(true);
    await m.press(KEYS.tab);
    await m.press(KEYS.enter); // expand
    await m.waitForText("v ");
    expect(m.screen()).not.toContain("#20");
    for (let i = 0; i < 20; i++) await m.press(KEYS.down);
    const s = await m.waitForText("#20");
    expect(s).toMatch(/\^ \d+ more/);
    for (const f of m.frames) expect(f.replace(/\n$/, "").split("\n").length).toBeLessThanOrEqual(23);
  });

  test("(3) the view of one row while the batch streams; Esc closes it and the run goes on", async () => {
    const { app, m } = await open({ scenario: "fanOut20", script: SLOW_FAN_OUT, size: { columns: 100, rows: 30 } });
    await ask(m);
    await m.waitForText("streaming", 10_000);
    await openRow(m, 1);
    await m.waitForText("Sub-call #01");
    const s = await m.waitForText("Part summary");
    expect(s).toContain("Summarize part 0");
    expect(s).toContain("Issued by turn 1, line 3: outs = llm_batch(prompts)");
    expect(s).toContain("model fake/scripted");
    expect(s).toMatch(/tokens in /);
    expect(s).toMatch(/time \d+\.\ds/);
    const done = await m.waitForText("Part summary: nothing unusual here.", 10_000);
    expect(done).toMatch(/tokens in \d+ \(cached 0\)  out \d+/);
    await m.press(KEYS.esc);
    await m.waitForText("sub-calls");
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(false);
    await m.waitForText("finished", 15_000);
  }, 30_000);

  test("(4) reasoning deltas give a Reasoning section; none gives no section", async () => {
    const { m, sb } = await held();
    sb.subcall({ subcall_id: 1, batch: { id: "b1", index: 0, size: 2 } });
    sb.subcall({ subcall_id: 2, batch: { id: "b1", index: 1, size: 2 } });
    sb.callStart("x1", { subcall_id: 1, batch: { id: "b1", index: 0, size: 2 } });
    sb.callStart("x2", { subcall_id: 2, batch: { id: "b1", index: 1, size: 2 }, prompt: "Summarize part 1" });
    sb.delta("x1", { reasoning: "Weighing the two halves." });
    sb.delta("x1", { text: "first answer" });
    sb.delta("x2", { text: "second answer" });
    sb.callEnd("x1");
    sb.callEnd("x2");
    await m.waitForText("2/2 done");
    await m.press(KEYS.tab);
    await m.press(KEYS.enter); // a finished block starts collapsed
    await m.waitForText("#02");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    let s = await m.waitForText("first answer");
    expect(s).toContain("Reasoning");
    expect(s).toContain("Weighing the two halves.");
    expect(s).toContain("tokens in 1.2k (cached 800)  out 340");
    expect(s).toContain("cost $0.0023");
    await m.press(KEYS.right);
    s = await m.waitForText("second answer");
    expect(s).not.toContain("Reasoning");
  });

  test("(5) a rejected run.subcall is a rej row, with the reason in the view and no tokens", async () => {
    const { m, sb } = await held();
    sb.subcall({ subcall_id: null, status: "rejected", error: "Sub-call budget exhausted (80 used).", batch: { id: "b1", index: 0, size: 5 }, prompt_chars: 900, seconds: 0 });
    await m.waitForText("rejected: Sub-call budget exhausted");
    await m.press(KEYS.tab);
    await m.press(KEYS.enter); // expand
    await m.waitForText("#-- rej");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    const s = await m.waitForText("Refused");
    expect(s).toContain("Sub-call budget exhausted (80 used).");
    expect(s).not.toContain("tokens");
  });

  test("(6) call.end with a rate_limit error is an err row, with the message in the view", async () => {
    const { m, sb } = await held();
    sb.subcall({});
    sb.callStart("x1");
    sb.callEnd("x1", { error: { kind: "rate_limit", provider: "fake", model: "scripted", status: 429, message: "Rate limited by Fake after 7 tries." } });
    sb.subcall({ status: "error", error: "sub-call failed: rate limited", seconds: 1.2 });
    await m.waitForText("0/1 done, 1 err");
    await m.press(KEYS.tab);
    await m.press(KEYS.enter); // the block is finished, so it starts collapsed
    await m.waitForText("#01 err");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    const s = await m.waitForText("Rate limited by Fake after 7 tries.");
    expect(s).toContain("err");
  });

  test("(7) simpleRead: a block of one", async () => {
    const { m } = await open({ scenario: "simpleRead" });
    await ask(m);
    await m.waitForText("finished");
    expect(m.screen()).toContain("batch b1  1 call  1/1 done");
  });

  test("(8) a finished block collapses to one line, and Enter expands it", async () => {
    const { m } = await open({ scenario: "fanOut20", size: { columns: 100, rows: 40 } });
    await ask(m);
    await m.waitForText("finished", 10_000);
    const s = m.screen();
    expect(s).toContain("(Enter expands)");
    expect(s).not.toMatch(/#\d\d /);
    await m.press(KEYS.tab);
    await m.press(KEYS.enter);
    await m.waitForText("#01");
    expect(m.screen()).not.toContain("(Enter expands)");
    await m.press(KEYS.enter); // and collapses again
    await m.waitFor(() => !m.screen().includes("#01"));
  });

  test("(9) 2,000 call.delta events in one tick make fewer than 100 frames", async () => {
    const { m, sb } = await held();
    sb.subcall({});
    sb.callStart("x1");
    await m.waitForText("streaming");
    const before = m.frames.length;
    for (let i = 0; i < 2000; i++) sb.delta("x1", { text: "ab" });
    await new Promise((r) => setTimeout(r, 400));
    expect(m.frames.length - before).toBeLessThan(100);
    sb.callEnd("x1");
    await m.waitForText("1/1 done");
  });

  test("(10) the cell line's text appears in the view once run.cell arrives", async () => {
    const { m, sb } = await held();
    sb.subcall({ origin: { turn: 1, line: 2 } });
    sb.callStart("x1", { origin: { turn: 1, line: 2 } });
    await openRow(m, 1);
    await m.waitForText("Issued by turn 1, line 2");
    expect(m.screen()).not.toContain("Issued by turn 1, line 2:");
    sb.event("run.cell", { turn: 1, code: "a = 1\nx = llm('hi')\nprint(x)", output: "", error: null, observation: null, seconds: 0.1, restarted: false, crash: null, repo_changed: null });
    await m.waitForText("Issued by turn 1, line 2: x = llm('hi')");
    sb.callEnd("x1");
  });

  test("a call.delta reset clears the text streamed so far", async () => {
    const { m, sb } = await held();
    sb.subcall({});
    sb.callStart("x1");
    sb.delta("x1", { text: "broken half" });
    await openRow(m, 1);
    await m.waitForText("broken half");
    sb.delta("x1", { reset: true });
    sb.delta("x1", { text: "whole again" });
    const s = await m.waitForText("whole again");
    expect(s).not.toContain("broken half");
    sb.callEnd("x1");
  });
});
