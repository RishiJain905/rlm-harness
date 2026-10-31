// KV cache: none; a test.
// The slash commands against the fake engine: open and close, /model and /settings saving through
// applySetting, /permissions held for the session only, /context, and /runs replaying the run log.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestChars } from "../../src/gateway/usage.ts";
import { COMMANDS } from "../../src/interface/commands/index.ts";
import { settingRows } from "../../src/interface/commands/settings.tsx";
import { contextBreakdown, viewFromRecord } from "../../src/interface/store.ts";
import { runsDir, settingsPath } from "../../src/paths.ts";
import { PROVIDERS } from "../../src/gateway/providers.ts";
import { loadSettings, SCHEMA } from "../../src/settings.ts";
import { createFakeApp, FAKE_VARS, runRecord, type FakeApp, type FakeAppOptions } from "../fakes/engine.ts";
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

async function command(m: Mounted, name: string): Promise<string> {
  await m.type(`/${name}`);
  await m.press(KEYS.enter);
  return m.waitForText(`── /${name}`);
}

async function ask(m: Mounted, text = "Summarize @a.txt"): Promise<void> {
  await m.type(text);
  await m.press(KEYS.enter);
}

async function downs(m: Mounted, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await m.press(KEYS.down);
}

describe("slash commands", () => {
  test("(1) each command opens and Esc closes it; /help lists every name", async () => {
    const { m } = await open();
    for (const c of COMMANDS) {
      await command(m, c.name);
      await m.press(KEYS.esc);
      await m.waitFor(() => !m.screen().includes(`── /${c.name}`) && m.screen().includes("Each question is a new run."));
    }
    const help = await command(m, "help");
    for (const c of COMMANDS) expect(help).toContain(`/${c.name}`);
    expect(help).toContain("/quit");
    expect(help).toContain("Ctrl+C");
  });

  test("(2) /model saves root fake/scripted with thinking low, a free-text id, and sub same as root", async () => {
    const { app, m } = await open({ settings: { "root.model": "", "sub.model": "fake/scripted" } });
    const fakeAt = PROVIDERS.findIndex((p) => p.id === "fake");
    await command(m, "model");
    await m.press(KEYS.enter); // root
    await m.waitForText("Provider for root");
    await downs(m, fakeAt);
    await m.press(KEYS.enter);
    await m.waitForText("scripted   window 1M");
    await m.press(KEYS.enter);
    await m.waitForText("Thinking for root fake/scripted");
    await downs(m, 2); // default, off, low
    await m.press(KEYS.enter);
    await m.waitForText("root is fake/scripted, thinking low.");
    let saved = loadSettings(app.deps.home);
    expect(saved.root).toEqual({ model: "fake/scripted", thinking: "low" });
    expect(app.session.settings.root.model).toBe("fake/scripted");
    expect(app.session.gateway.settings.root.thinking).toBe("low");

    // a free-text id the catalog lacks
    await m.press(KEYS.enter);
    await downs(m, PROVIDERS.findIndex((p) => p.id === "local"));
    await m.press(KEYS.enter);
    await m.waitForText("Model for root from local");
    await m.type("my-model:7b");
    await m.waitForText('use "my-model:7b" as typed');
    await m.press(KEYS.enter);
    await m.waitForText("Thinking for root local/my-model:7b");
    await m.press(KEYS.enter);
    await m.waitForText("Window and prices unknown.");
    expect(loadSettings(app.deps.home).root.model).toBe("local/my-model:7b");

    // sub: same as root
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    await m.waitForText("Provider for sub");
    await m.press(KEYS.enter); // "same as root" is first
    await m.waitForText("The sub-call model is now the root model.");
    saved = loadSettings(app.deps.home);
    expect(saved.sub.model).toBe("");
  });

  test("(3) /settings: rows, an enum, a bool, a bad int and a reset", async () => {
    const listed = PROVIDERS.filter((p) => p.id !== "fake").length;
    const rows = settingRows();
    expect(rows).toHaveLength(SCHEMA.filter((d) => !d.key.startsWith("providers.<id>.")).length + 2 * listed);
    const at = (key: string) => rows.findIndex((r) => r.key === key);

    const { app, m } = await open({ size: { columns: 100, rows: 40 } });
    await command(m, "settings");
    await downs(m, at("root.thinking"));
    await m.press(KEYS.right);
    await m.waitForText('"off"');
    expect(loadSettings(app.deps.home).root.thinking).toBe("off");

    await downs(m, at("display.verbose") - at("root.thinking"));
    await m.press(" ");
    await m.waitFor(() => loadSettings(app.deps.home).display.verbose === true);
    await m.press("d");
    await m.waitFor(() => loadSettings(app.deps.home).display.verbose === false);

    const before = readFileSync(settingsPath(app.deps.home), "utf8");
    for (let i = 0; i < at("display.verbose") - at("providers.anthropic.max_in_flight"); i++) await m.press(KEYS.up);
    await m.press(KEYS.enter);
    await m.press(KEYS.backspace);
    await m.press(KEYS.backspace);
    await m.type("0");
    await m.press(KEYS.enter);
    await m.waitForText("providers.anthropic.max_in_flight must be a whole number, 1 or more");
    expect(readFileSync(settingsPath(app.deps.home), "utf8")).toBe(before);
    await m.press(KEYS.esc); // leaves the edit
    await m.press(KEYS.esc); // closes the screen
    await m.waitFor(() => !m.screen().includes("── /settings"));
  });

  test("(4) /permissions: default is carried to the next run and never saved; bypass warns", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    const before = readFileSync(settingsPath(app.deps.home), "utf8");
    let s = await command(m, "permissions");
    expect(s).toContain(">● accept-edits");
    await m.press(KEYS.down);
    s = await m.waitForText("bypass asks nothing");
    await m.press(KEYS.up);
    await m.press(KEYS.up);
    await m.press(KEYS.enter);
    await m.waitForText("● default");
    await m.press(KEYS.esc);
    await m.waitForText("| default");
    await ask(m);
    await m.waitFor(() => app.startCalls.length === 1);
    expect(app.startCalls[0]!.permissionMode).toBe("default");
    await m.waitForText("finished");
    expect(readFileSync(settingsPath(app.deps.home), "utf8")).toBe(before);
    expect(app.session.settings.permissions.mode).toBe("accept-edits");
  });

  test("(4) /permissions lists the run's events after approvalShell", async () => {
    const { m } = await open({ scenario: "approvalShell" });
    await ask(m);
    await m.waitForText("ls -la");
    await m.press("n");
    await m.waitForText("finished");
    await command(m, "permissions");
    await m.waitForText("turn 1  shell ls -la denied (asked)");
  });

  test("(5) /context: nothing yet, the vars mid-run, the breakdown after a run", async () => {
    const { app, m } = await open({ scenario: "hold" });
    let s = await command(m, "context");
    expect(s).toContain("No root request yet.");
    expect(s).toContain("Variables exist only while a run is active.");
    await m.press(KEYS.esc);
    await ask(m);
    await m.waitForText("running");
    s = await command(m, "context");
    s = await m.waitForText(FAKE_VARS[0]!.name);
    expect(s).toContain("name");
    expect(s).toContain(FAKE_VARS[0]!.type);
    expect(app.engine.calls.filter((c) => c.method === "run.vars")).toHaveLength(1);
    await m.press("r");
    await m.waitFor(() => app.engine.calls.filter((c) => c.method === "run.vars").length === 2);
    await m.press(KEYS.esc);
    await m.press(KEYS.esc); // cancels the held run
    await m.waitForText("Run cancelled.");
  });

  test("(5) /context after a run: the segments add up to the request's estimate", async () => {
    const { app, m } = await open({ scenario: "simpleRead" });
    await ask(m);
    await m.waitForText("finished");
    const runId = app.engine.runId!;
    const request = app.session.gateway.lastRootRequest(runId)!;
    const { segments, estimate } = contextBreakdown(request);
    expect(segments.map((x) => x.label)).toEqual(["system", "first message", "turns (1)", "tool def"]);
    expect(segments.reduce((n, x) => n + x.chars, 0)).toBe(requestChars(request));
    expect(segments.reduce((n, x) => n + x.tokens, 0)).toBeCloseTo(estimate, 9);
    const s = await command(m, "context");
    expect(s).toContain("fake/scripted  window 1M");
    for (const label of ["system", "first message", "turns (1)", "tool def", "output reserve", "free"]) expect(s).toContain(label);
    expect(s).toContain("Variables exist only while a run is active.");
  });

  test("(6) /runs lists the log newest first, replays one read-only, and flags another format", async () => {
    const { app, m } = await open({ size: { columns: 120, rows: 40 } });
    const dir = join(runsDir(app.deps.home), "interactive");
    mkdirSync(dir, { recursive: true });
    const lines = [
      runRecord({ run_id: "r_000000000aaa", started_at: 1793450000, question: "oldest question" }),
      runRecord({ run_id: "r_000000000bbb", started_at: 1793460000, question: "newest question" }),
      runRecord({ run_id: "r_000000000ccc", started_at: 1793455000, question: "middle question", format: 99 }),
    ].map((r) => JSON.stringify(r));
    writeFileSync(join(dir, "runs.jsonl"), `${lines.join("\n")}\n{"format": 1, "run_id": "r_torn`);
    let s = await command(m, "runs");
    s = await m.waitForText("oldest question");
    const order = ["newest question", "middle question", "oldest question"].map((q) => s.indexOf(q));
    expect(order.every((x) => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(s).not.toContain("r_torn");
    expect(s).toMatch(/middle question\s+format 99/);

    await m.press(KEYS.enter); // the newest
    s = await m.waitForText("run r_000000000bbb (read-only)");
    await m.press(KEYS.pageUp);
    await m.waitForText("> newest question");
    expect(s).toContain("Let me split the input and ask about each part.");
    expect(s).toContain("batch b1  3 calls  3/3 done  turn 1 line 2");
    expect(s).toContain("Answer");
    await m.press(KEYS.tab);
    await m.press(KEYS.enter); // expand the block
    await m.waitForText("#03");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    s = await m.waitForText("Sub-call #01");
    expect(s).toContain("Summarize: First part: the ledger opens.");
    expect(s).toContain("The ledger opens.");
    expect(s).toContain("Issued by turn 1, line 2: outs = llm_batch([f'Summarize: {p}' for p in parts[:3]])");
    expect(s).not.toContain("Reasoning");
    await m.press(KEYS.esc); // the view
    await m.press(KEYS.esc); // the panel
    await m.press(KEYS.esc); // back to the list
    await m.waitForText("newest question");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    await m.waitForText("That run was written by another format version (format 99)");
    expect(app.engine.calls.some((c) => c.method === "run.start")).toBe(false);
  });

  test("(7) viewFromRecord gives the record's rows and turn count", () => {
    const record = runRecord();
    const view = viewFromRecord(record);
    expect(view.readOnly).toBe(true);
    expect(view.turns).toBe(record.turns.length);
    expect(view.entries.filter((e) => e.kind === "reply")).toHaveLength(record.turns.length);
    const rows = view.blocks.flatMap((b) => b.rows);
    expect(rows.map((r) => r.subcallId)).toEqual(record.subcalls.map((s: { subcall_id: number }) => s.subcall_id));
    expect(rows.map((r) => r.text)).toEqual(record.subcalls.map((s: { output: string }) => s.output));
    expect(rows.every((r) => r.status === "done" && r.usage !== null)).toBe(true);
    expect(view.blocks.map((b) => b.id)).toEqual(["b1"]);
    expect(view.phase).toBe("finished");
    expect(view.totals!.cost_usd).toBe(record.cost_usd);
    expect(view.entries.at(-1)).toEqual({ kind: "answer", text: "42" });
    expect(view.permissions).toEqual(record.permissions);
    const failed = viewFromRecord(runRecord({ infra_error: "auth: rejected", infra_kind: "auth", answer: null, submitted: false }));
    expect(failed.phase).toBe("failed");
    expect(failed.failKind).toBe("auth");
  });
});
