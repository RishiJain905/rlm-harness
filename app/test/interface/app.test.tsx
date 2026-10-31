// KV cache: none; a test.
// The app against the fake engine: the idle screen, the 6c submit flow and its local checks,
// cancel, an engine exit, quitting, the ASCII fallback and the frame size.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unicodeSupported } from "../../src/interface/format.ts";
import { RunStore } from "../../src/interface/store.ts";
import { createFakeApp, FAKE_LIMITS, scriptedBus, type FakeApp, type FakeAppOptions } from "../fakes/engine.ts";
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

async function ask(m: Mounted, text: string): Promise<void> {
  await m.type(text);
  await m.press(KEYS.enter);
}

describe("app", () => {
  test("(1) the idle screen shows the banner, the folder, the prompt and status idle", async () => {
    const { app, m } = await open();
    const s = await m.waitForText("engine 0.0.0-fake");
    expect(s).toContain("rlmh 0.1.0");
    expect(s).toContain(`folder ${app.deps.cwd}`);
    expect(s).toContain("root fake/scripted");
    expect(s).toContain("Each question is a new run.");
    expect(s).toContain("Ask a question");
    expect(s.trimEnd().split("\n").at(-1)).toStartWith("idle");
  });

  test("(2) @a.txt starts a read run and the transcript fills to the answer", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    await ask(m, "Summarize @a.txt");
    const s = await m.waitForText("finished");
    expect(app.startCalls).toHaveLength(1);
    const run = app.startCalls[0]!;
    expect(run.mode).toBe("read");
    expect(run.inputs).toEqual([join(app.deps.cwd, "a.txt")]);
    expect(run.interactive).toBe(true);
    expect(run.question).toBe("Summarize a.txt");
    expect(run.root).toBeUndefined();
    expect(m.frames.some((f) => f.includes("> Summarize a.txt") && f.includes("(read: 1 file)"))).toBe(true);
    expect(s).toContain("Reading the input.");
    expect(s).toContain("print(s)");
    expect(s).toContain("A short summary.");
    expect(s).toContain("Answer");
    expect(s).toMatch(/Answer\n\s+42/);
  });

  test("(3) a question with no mention starts a repo run on the folder", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    await ask(m, "Fix the failing test");
    await m.waitFor(() => app.startCalls.length === 1);
    expect(app.startCalls[0]).toMatchObject({ mode: "repo", task: "Fix the failing test", repoPath: app.deps.cwd, interactive: true });
  });

  test("(4) a missing @file starts nothing and names the token; a@b.com is not a mention", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    await ask(m, "Read @missing.txt please");
    await m.waitForText("@missing.txt: no such file");
    expect(app.startCalls).toHaveLength(0);
    expect(m.screen()).toContain("Read @missing.txt please"); // the text stays in the box
    await m.press(KEYS.esc); // clears the prompt
    await ask(m, "Mail a@b.com about it");
    await m.waitFor(() => app.startCalls.length === 1);
    expect(app.startCalls[0]).toMatchObject({ mode: "repo", task: "Mail a@b.com about it" });
  });

  test("(5) an empty root.model gives the hint and opens /model", async () => {
    const { app, m } = await open({ settings: { "root.model": "" } });
    await ask(m, "Summarize @a.txt");
    const s = await m.waitForText("── /model");
    expect(s).toContain("none picked");
    expect(app.startCalls).toHaveLength(0);
    await m.press(KEYS.esc);
    await m.waitForText("No model picked. Use /model.");
  });

  test("(6) no key for a provider that needs one gives the hint", async () => {
    const { app, m } = await open({ settings: { "root.model": "anthropic/claude-sonnet-5" } });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("No key for Anthropic. Use /providers.");
    expect(app.startCalls).toHaveLength(0);
    expect(app.fetchCalls).toHaveLength(0);
  });

  test("(7) no .git: a warning line, and the run still starts; with .git no warning", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    await ask(m, "Look around");
    await m.waitForText("diff() will be unavailable");
    await m.waitFor(() => app.startCalls.length === 1);
    await m.waitForText("finished");
    mkdirSync(join(app.deps.cwd, ".git"));
    await ask(m, "Look again");
    await m.waitFor(() => app.startCalls.length === 2);
    await m.waitForText("finished");
    expect(m.screen()).not.toContain("diff() will be unavailable");
  });

  test("(8) cwd is the home folder: asks y/N, and n starts nothing", async () => {
    const { app, m } = await open({ cwd: homedir() }); // as the app compares it
    await ask(m, "Look around");
    await m.waitForText("This folder is very large. Run on it anyway? y/N");
    await m.press("n");
    await m.waitForText("Not started.");
    expect(app.startCalls).toHaveLength(0);
  });

  test("(9) Enter during a run keeps the text and says a run is active", async () => {
    const { app, m } = await open({ scenario: "hold" });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("running");
    await ask(m, "second question");
    const s = await m.waitForText("A run is active. Esc cancels it.");
    expect(s).toContain("second question");
    expect(app.startCalls).toHaveLength(1);
  });

  test("(10) slow + Esc cancels: run.cancel, status cancelled, the prompt works again", async () => {
    const { app, m } = await open({ scenario: "slow" });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("turn 1");
    await m.press(KEYS.esc);
    const s = await m.waitForText("Run cancelled.");
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(true);
    await m.waitFor(() => m.screen().trimEnd().split("\n").at(-1)!.startsWith("cancelled"));
    expect(s).not.toContain("A run is active");
    await ask(m, "Summarize @b.txt");
    await m.waitFor(() => app.startCalls.length === 2);
  });

  test("(11) an engine exit shows its stderr and refuses new questions", async () => {
    const { app, m } = await open({ scenario: "hold" });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("running");
    app.engine.crash(1, ["Traceback (most recent call last):", "RuntimeError: boom"]);
    const s = await m.waitForText("The engine stopped (exit 1). Restart rlmh.");
    expect(s).toContain("RuntimeError: boom");
    await m.waitForText("failed: engine");
    await ask(m, "Summarize @b.txt");
    await m.waitFor(() => m.screen().split("The engine stopped (exit 1)").length > 2);
    expect(app.startCalls).toHaveLength(1);
  });

  test("(12) /quit closes the session", async () => {
    const { app, m } = await open();
    await ask(m, "/quit");
    await m.waitFor(() => app.sessionClosed());
  });

  test("(12) Ctrl+C twice when idle quits; once does not", async () => {
    const { app, m } = await open();
    await m.press(KEYS.ctrlC);
    await m.waitForText("Press Ctrl+C again to quit.");
    expect(app.sessionClosed()).toBe(false);
    await m.press(KEYS.ctrlC);
    await m.waitFor(() => app.sessionClosed());
  });

  test("(12) Ctrl+C during a run cancels it", async () => {
    const { app, m } = await open({ scenario: "slow" });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("turn 1");
    await m.press(KEYS.ctrlC);
    await m.waitForText("Run cancelled.");
    expect(app.sessionClosed()).toBe(false);
  });

  test("(13) unicodeSupported, and an ASCII frame has none of the Unicode glyphs", async () => {
    expect(unicodeSupported({ WT_SESSION: "x" }, "win32")).toBe(true);
    expect(unicodeSupported({}, "win32")).toBe(false);
    expect(unicodeSupported({ TERM: "linux" }, "linux")).toBe(false);
    expect(unicodeSupported({ RLMH_ASCII: "1" }, "darwin")).toBe(false);
    expect(unicodeSupported({ RLMH_ASCII: "1", WT_SESSION: "x" }, "win32")).toBe(false);
    const { m } = await open({ scenario: "fanOut20", env: { RLMH_ASCII: "1" } });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("finished", 10_000);
    const glyphs = /[●○╭╮╰╯─│█░…⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;
    for (const f of m.frames) expect(f).not.toMatch(glyphs);
  }, 15_000);

  for (const size of [
    { columns: 50, rows: 14 },
    { columns: 100, rows: 30 },
  ]) {
    test(`(14) at ${size.columns}x${size.rows} no line is wider than the terminal and no frame taller than rows - 1`, async () => {
      const { m } = await open({ scenario: "fanOut20", size });
      await ask(m, "Summarize @a.txt and tell me about every part of it in great detail please");
      await m.waitForText("finished", 10_000);
      for (const f of m.frames) {
        const lines = f.replace(/\n$/, "").split("\n");
        expect(lines.length).toBeLessThanOrEqual(size.rows - 1);
        for (const l of lines) expect(Bun.stringWidth(l)).toBeLessThanOrEqual(size.columns);
      }
    }, 15_000);
  }

  test("below 50x12 the app says the terminal is too small", async () => {
    app = await createFakeApp({ size: { columns: 49, rows: 20 } });
    m = mount(app.deps);
    await m.waitForText("Terminal too small (need 50x12)");
  });
});

describe("RunStore", () => {
  test("a run cancelled before run.started still takes its id and ends cancelled", async () => {
    app = await createFakeApp();
    const store = new RunStore(app.deps);
    try {
      store.beginRun({ text: "Q", detail: "read: 1 file" });
      store.cancelling();
      const ref = { provider: "fake", model: "scripted", thinking: null };
      const sb = scriptedBus(app.bus, "r_00000000abcd");
      sb.event("run.started", { root: ref, sub: ref, profile: "default", call_format: "native", permission_mode: "accept-edits", limits: FAKE_LIMITS });
      sb.event("run.finished", { answer: null, submitted: false, infra_error: "cancelled", infra_kind: "cancelled" });
      const deadline = Date.now() + 2000;
      while (store.snapshot().phase !== "cancelled" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(store.snapshot()).toMatchObject({ phase: "cancelled", runId: "r_00000000abcd" });
      expect(store.snapshot().entries.at(-1)).toEqual({ kind: "note", text: "Run cancelled.", tone: "warn" });
    } finally {
      store.dispose();
    }
  });

  test("events for another run id are dropped", async () => {
    app = await createFakeApp();
    const store = new RunStore(app.deps);
    try {
      store.beginRun();
      store.startResolved("r_000000000001");
      scriptedBus(app.bus, "r_00000000ffff").event("run.finished", { answer: "x", submitted: true, infra_error: null, infra_kind: null });
      await new Promise((r) => setTimeout(r, 120));
      expect(store.snapshot().phase).toBe("starting");
    } finally {
      store.dispose();
    }
  });
});
