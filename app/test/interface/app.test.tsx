// KV cache: none; a test.
// The app against the fake engine: the idle screen, the 6c submit flow and its local checks,
// cancel, an engine exit, quitting, the ASCII fallback and the frame size.

import { afterEach, describe, expect, test, setDefaultTimeout } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { unicodeSupported } from "../../src/interface/format.ts";
import { isActive, RunStore } from "../../src/interface/store.ts";
import { Link } from "../../src/link.ts";
import { runsDir } from "../../src/paths.ts";
import { APP_VERSION } from "../../src/version.ts";
import { createFakeApp, FAKE_LIMITS, runRecord, scriptedBus, scriptedUsage, type FakeApp, type FakeAppOptions } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";
import { followUpLine } from "../../src/interface/Transcript.tsx";

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
    expect(s).toContain(`rlmh ${APP_VERSION}`);
    expect(s).toContain(`folder ${app.deps.cwd}`);
    expect(s).toContain("root fake/scripted");
    expect(s).toContain(followUpLine(true));
    expect(followUpLine(false)).toBe("Each question is a new run.");
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

  test("(4b) Shift+Tab picks the mode: repo works on the folder with @files named, read needs a mention, then auto again", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    const status = () => m.screen().trimEnd().split("\n").at(-1)!;
    expect(status()).not.toContain("repo mode");
    await m.press(KEYS.shiftTab);
    await m.waitFor(() => status().includes("repo mode") && m.screen().includes("Repo mode (Shift+Tab changes)"));
    await ask(m, "Read @a.txt and complete everything in it");
    await m.waitFor(() => app.startCalls.length === 1);
    expect(app.startCalls[0]).toMatchObject({ mode: "repo", task: "Read a.txt and complete everything in it", repoPath: app.deps.cwd });
    expect(app.startCalls[0]!.inputs).toBeUndefined();
    await m.waitFor(() => status().startsWith("finished"));
    await m.press(KEYS.shiftTab);
    await m.waitFor(() => status().includes("read mode"));
    await ask(m, "What is in this folder?");
    await m.waitForText("Read mode needs @file mentions");
    expect(app.startCalls).toHaveLength(1);
    await m.press(KEYS.esc);
    await m.press(KEYS.shiftTab); // back to auto: the segment goes, and a mention reads again
    await m.waitFor(() => !status().includes("read mode") && !status().includes("repo mode"));
    await ask(m, "Summarize @a.txt");
    await m.waitFor(() => app.startCalls.length === 2);
    expect(app.startCalls[1]).toMatchObject({ mode: "read", question: "Summarize a.txt" });
    // /clear starts a new session in auto
    await m.waitFor(() => status().startsWith("finished"));
    await m.press(KEYS.shiftTab);
    await m.waitFor(() => status().includes("repo mode"));
    await ask(m, "/clear");
    await m.waitForText("New session.");
    await m.waitFor(() => !status().includes("repo mode") && m.screen().includes("Ask a question"));
  });

  test("(5) first run, no model and no key: /providers opens, then /model; a question still opens /model", async () => {
    const { app, m } = await open({ settings: { "root.model": "" } });
    let s = await m.waitForText("── /providers");
    expect(s).toContain("Welcome to rlmh. Connect a provider");
    await m.press(KEYS.esc);
    s = await m.waitForText("── /model");
    expect(s).toContain("Pick the root model");
    await m.press(KEYS.esc);
    await m.waitForText("No model picked yet");
    await ask(m, "Summarize @a.txt");
    s = await m.waitForText("── /model");
    expect(s).toContain("none picked");
    expect(app.startCalls).toHaveLength(0);
    await m.press(KEYS.esc);
    await m.waitForText("No model picked. Use /model.");
    expect(app.fetchCalls).toHaveLength(0);
  });

  test("(5b) first run with a provider key in the environment opens /model at once", async () => {
    const { app, m } = await open({ settings: { "root.model": "" }, env: { OPENROUTER_API_KEY: "sk-or-v1-FAKE0000000000000000" } });
    const s = await m.waitForText("── /model");
    expect(s).toContain("Pick the root model");
    expect(m.frames.some((f) => f.includes("── /providers"))).toBe(false);
    expect(app.fetchCalls).toHaveLength(0);
  });

  test("(6) no key for a provider that needs one opens /providers, and the hint stays", async () => {
    const { app, m } = await open({ settings: { "root.model": "anthropic/claude-sonnet-5" } });
    expect(m.frames.some((f) => f.includes("── /providers"))).toBe(false); // a model is picked: no first-run screens
    await ask(m, "Summarize @a.txt");
    await m.waitForText("── /providers");
    expect(app.startCalls).toHaveLength(0);
    expect(app.fetchCalls).toHaveLength(0);
    await m.press(KEYS.esc);
    await m.waitForText("No key for Anthropic. Use /providers.");
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

describe("/clear", () => {
  const promptLine = (screen: string) => {
    const line = screen.split("\n").find((l) => /^[│|] > /.test(l)) ?? "";
    return line.slice(4, -1).trimEnd();
  };
  const statusLine = (screen: string) => screen.trimEnd().split("\n").at(-1)!;
  async function slash(m: Mounted, name: string): Promise<void> {
    await m.type(`/${name}`);
    await m.press(KEYS.enter);
  }

  test("after a finished run it empties the transcript, the history and the mode override, and says so", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    // this session's mode override: /permissions to default
    await slash(m, "permissions");
    await m.waitForText("── /permissions");
    await m.press(KEYS.up);
    await m.press(KEYS.enter);
    await m.waitForText("● default");
    await m.press(KEYS.esc);
    await m.waitFor(() => statusLine(m.screen()).includes("| default"));
    await ask(m, "Summarize @a.txt");
    await m.waitFor(() => statusLine(m.screen()).startsWith("finished"));
    expect(app.startCalls[0]!.permissionMode).toBe("default");
    expect(m.screen()).toContain("Answer");
    // the history holds the question: Up brings it back
    await m.press(KEYS.up);
    await m.waitFor(() => promptLine(m.screen()) === "Summarize @a.txt");
    await m.press(KEYS.esc); // the line ends in a mention: the first Esc closes the file menu
    await m.waitFor(() => !m.screen().includes("  @a.txt"));
    await m.press(KEYS.esc);
    await m.waitFor(() => promptLine(m.screen()).includes("Ask a question"));

    await slash(m, "clear");
    const s = await m.waitForText("New session.");
    expect(s).not.toContain("Answer");
    expect(s).not.toContain("turn 1");
    expect(s).not.toContain("sub-calls ──"); // the panel is gone
    expect(statusLine(s)).toStartWith("idle");
    await m.waitFor(() => statusLine(m.screen()).includes("| accept-edits"));
    expect(statusLine(m.screen())).not.toContain("| default");
    // the history is gone, and /clear is not in it
    await m.press(KEYS.up);
    await Bun.sleep(150);
    expect(promptLine(m.screen())).toContain("Ask a question");
    // nothing was sent to the engine, and the next run uses the settings' mode
    expect(app.engine.calls.map((c) => c.method)).not.toContain("run.cancel");
    await ask(m, "Summarize @b.txt");
    await m.waitFor(() => app.startCalls.length === 2);
    expect(app.startCalls[1]!.permissionMode).toBe("accept-edits");
    await m.waitFor(() => statusLine(m.screen()).startsWith("finished"));
  });

  test("it is refused during a run, which carries on; after Esc cancels it, /clear works", async () => {
    const { app, m } = await open({ scenario: "hold" });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("running");
    await slash(m, "clear");
    const s = await m.waitForText("A run is active. Esc cancels it, then /clear.");
    expect(statusLine(s)).toContain("running");
    expect(s).toContain("Summarize a.txt"); // the transcript is still there
    expect(s).not.toContain("New session.");
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(false);
    expect(app.startCalls).toHaveLength(1);

    await m.press(KEYS.esc); // the user's own cancel
    await m.waitForText("Run cancelled.");
    await m.waitFor(() => statusLine(m.screen()).startsWith("cancelled"));
    await m.waitFor(() => promptLine(m.screen()) === "/clear"); // the refused text stayed
    await m.press(KEYS.enter);
    const after = await m.waitForText("New session.");
    expect(after).not.toContain("Run cancelled.");
    expect(statusLine(after)).toStartWith("idle");
  });

  test("the slash menu and Tab offer /clear, and /help lists it", async () => {
    const { m } = await open();
    await m.type("/");
    const all = await m.waitForText("/clear");
    expect(all).toContain("/quit"); // the menu has room for every command
    await m.press(KEYS.esc);
    await m.type("/cl");
    await m.waitFor(() => !m.screen().includes("/context") && m.screen().includes("/clear"));
    await m.press(KEYS.tab);
    await m.waitFor(() => promptLine(m.screen()) === "/clear");
    await m.press(KEYS.esc);
    await slash(m, "help");
    const help = await m.waitForText("── /help");
    expect(help).toContain("/clear");
    expect(help).toContain("Start a new session");
  });

  test("the engine's exit survives it: still shown, and questions are still refused", async () => {
    const { app, m } = await open({ scenario: "hold" });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("running");
    app.engine.crash(1, ["Traceback (most recent call last):", "RuntimeError: boom"]);
    await m.waitForText("The engine stopped (exit 1). Restart rlmh.");
    await m.waitForText("failed: engine");
    await slash(m, "clear");
    const s = await m.waitForText("New session.");
    expect(s).not.toContain("Summarize a.txt");
    expect(s).toContain("The engine stopped (exit 1). Restart rlmh.");
    expect(s).toContain("RuntimeError: boom");
    await ask(m, "Summarize @b.txt");
    await m.waitFor(() => m.screen().split("The engine stopped (exit 1)").length > 2);
    expect(app.startCalls).toHaveLength(1);
  });

  test("the run log on disk is untouched: /runs still lists past runs", async () => {
    const { app, m } = await open({ size: { columns: 120, rows: 40 } });
    const dir = join(runsDir(app.deps.home), "interactive");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(runRecord({ run_id: "r_000000000aaa", question: "an earlier question" }))}\n`);
    await slash(m, "clear");
    await m.waitForText("New session.");
    await slash(m, "runs");
    await m.waitForText("an earlier question");
  });
});

describe("RunStore", () => {
  test("clear() returns to an empty idle view, keeping only the engine's exit", async () => {
    app = await createFakeApp();
    const store = new RunStore(app.deps);
    try {
      store.beginRun({ text: "Q", detail: "read: 1 file" });
      store.startResolved("r_00000000abcd");
      scriptedBus(app.bus, "r_00000000abcd").subcall({ status: "sent" });
      store.clear();
      await new Promise((r) => setTimeout(r, 120));
      expect(store.snapshot()).toMatchObject({ phase: "idle", runId: null, entries: [], blocks: [], turns: 0, finished: null, engineExit: null });
      expect(store.live()).toEqual({ phase: "idle", runId: null });
      // events of the cleared run no longer find a home
      scriptedBus(app.bus, "r_00000000abcd").event("run.finished", { answer: "late", submitted: true, infra_error: null, infra_kind: null });
      await new Promise((r) => setTimeout(r, 120));
      expect(store.snapshot().phase).toBe("idle");

      app.bus.emit("engine.exit", { code: 3, stderr: ["boom"] });
      store.clear();
      await new Promise((r) => setTimeout(r, 120));
      expect(store.snapshot().engineExit).toEqual({ code: 3, stderr: ["boom"] });
      expect(store.snapshot().entries).toEqual([{ kind: "error", text: "The engine stopped (exit 3). Restart rlmh.", lines: ["boom"] }]);
    } finally {
      store.dispose();
    }
  });

  const FINISHED_CANCELLED = { answer: null, submitted: false, infra_error: "cancelled", infra_kind: "cancelled" };

  /** Waits for the published view to show `phase` for run `runId`. */
  async function settled(store: RunStore, phase: string, runId: string): Promise<void> {
    const deadline = Date.now() + 2000;
    while (!(store.snapshot().phase === phase && store.snapshot().runId === runId) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  }

  test("a run cancelled before start() resolves takes its id from the start result and ends cancelled", async () => {
    app = await createFakeApp();
    const store = new RunStore(app.deps);
    try {
      store.beginRun({ text: "Q", detail: "read: 1 file" });
      store.cancelling();
      // no run.started at all: run.finished comes first, then start() resolves (the start result and the
      // notification can be read together, and the notification is handled before the promise continuation)
      scriptedBus(app.bus, "r_00000000abcd").event("run.finished", FINISHED_CANCELLED);
      expect(store.live()).toEqual({ phase: "cancelling", runId: null }); // nothing says whose it is yet
      store.startResolved("r_00000000abcd");
      await settled(store, "cancelled", "r_00000000abcd");
      expect(store.snapshot()).toMatchObject({ phase: "cancelled", runId: "r_00000000abcd" });
      expect(store.snapshot().entries.at(-1)).toEqual({ kind: "note", text: "Run cancelled.", tone: "warn" });
    } finally {
      store.dispose();
    }
  });

  test("a run cancelled while starting also ends cancelled when start() resolves first, or run.started comes first", async () => {
    app = await createFakeApp();
    const store = new RunStore(app.deps);
    try {
      store.beginRun();
      store.cancelling();
      store.startResolved("r_00000000abcd");
      scriptedBus(app.bus, "r_00000000abcd").event("run.finished", FINISHED_CANCELLED);
      await settled(store, "cancelled", "r_00000000abcd");
      expect(store.snapshot()).toMatchObject({ phase: "cancelled", runId: "r_00000000abcd" });

      store.beginRun();
      store.cancelling();
      const ref = { provider: "fake", model: "scripted", thinking: null };
      const sb = scriptedBus(app.bus, "r_00000000abce");
      sb.event("run.started", { root: ref, sub: ref, profile: "default", call_format: "native", permission_mode: "accept-edits", limits: FAKE_LIMITS });
      sb.event("run.finished", FINISHED_CANCELLED);
      await settled(store, "cancelled", "r_00000000abce");
      expect(store.snapshot()).toMatchObject({ phase: "cancelled", runId: "r_00000000abce" });
    } finally {
      store.dispose();
    }
  });

  test("a startup failure whose start result and run.finished are read together still ends the run", async () => {
    app = await createFakeApp();
    // the real Link, given the two lines in one chunk, as a pipe delivers them when the engine writes both at once
    const encoder = new TextEncoder();
    let feed!: (text: string) => void;
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        feed = (text) => c.enqueue(encoder.encode(text));
      },
    });
    const link = new Link(input, { write: () => {} });
    link.onNotification("*", (method, params) => app!.bus.emit("engine.event", { method, params }));
    const store = new RunStore(app.deps);
    try {
      store.beginRun({ text: "Q", detail: "read: 1 file" });
      // what App.start does with Session.start()
      void link.request<{ run_id: string }>("run.start", {}).then((r) => store.startResolved(r.run_id));
      const runId = "r_0000000fa11e";
      const none = scriptedUsage({ input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cost_usd: 0 });
      const finished = {
        run_id: runId, tag: null, answer: null, submitted: false, answer_valid: false, turns: 0, subcalls: 0, cost_usd: 0, wall_s: 0.1,
        usage: { root: none, sub: none }, infra_error: "the worker did not start", infra_kind: "worker", log_path: "/tmp/runs.jsonl",
      };
      feed(
        `${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { run_id: runId, log_path: "/tmp/runs.jsonl" } })}\n` +
          `${JSON.stringify({ jsonrpc: "2.0", method: "run.finished", params: finished })}\n`,
      );
      await settled(store, "failed", runId);
      expect(store.snapshot()).toMatchObject({ phase: "failed", runId, failKind: "worker" });
      expect(store.snapshot().entries.at(-1)).toEqual({ kind: "error", text: "the worker did not start", lines: [] });
      expect(isActive(store.snapshot().phase)).toBe(false);
    } finally {
      store.dispose();
      link.close();
    }
  });

  test("events kept while starting are replayed for this run only, and a failed start discards them", async () => {
    app = await createFakeApp();
    const store = new RunStore(app.deps);
    try {
      store.beginRun();
      scriptedBus(app.bus, "r_00000000ffff").event("run.finished", { answer: "x", submitted: true, infra_error: null, infra_kind: null });
      scriptedBus(app.bus, "r_00000000cafe").event("run.finished", { answer: "mine", submitted: true, infra_error: null, infra_kind: null });
      store.startResolved("r_00000000cafe");
      await settled(store, "finished", "r_00000000cafe");
      expect(store.snapshot()).toMatchObject({ phase: "finished", runId: "r_00000000cafe" });
      expect(store.snapshot().entries.at(-1)).toEqual({ kind: "answer", text: "mine" });

      store.beginRun();
      scriptedBus(app.bus, "r_00000000dead").event("run.finished", { answer: "stale", submitted: true, infra_error: null, infra_kind: null });
      store.startFailed("no such profile");
      store.beginRun();
      store.startResolved("r_00000000dead"); // the failed start's events went with it
      await new Promise((r) => setTimeout(r, 120));
      expect(store.snapshot().phase).toBe("starting");
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
