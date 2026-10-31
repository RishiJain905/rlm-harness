// KV cache: none
// The fake engine itself, without Ink: each scenario plays to run.finished over the real link and the real
// gateway on the fake provider, with §5.4's order; plus crash, dispose, run ids, settings and the helpers.

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Bus } from "../../src/bus.ts";
import type { AppEvents } from "../../src/gateway/gateway.ts";
import type { ApprovalResult, RunFinishedParams } from "../../src/protocol.ts";
import { setSetting } from "../../src/settings.ts";
import { createFakeApp, runRecord, scriptedBus, type FakeApp, type FakeAppOptions } from "./engine.ts";

interface Entry {
  name: string;
  method?: string;
  params: any;
}

const apps: FakeApp[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.dispose();
});

async function open(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; log: Entry[] }> {
  const app = await createFakeApp(opts);
  apps.push(app);
  const log: Entry[] = [];
  app.bus.on("engine.event", (e) => log.push({ name: "engine.event", method: e.method, params: e.params }));
  for (const name of ["call.start", "call.delta", "call.end", "engine.exit"] as const) {
    app.bus.on(name, (p) => log.push({ name, params: p }));
  }
  return { app, log };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("waitFor timed out");
    await Bun.sleep(5);
  }
}

const events = (log: Entry[], method: string) => log.filter((e) => e.method === method).map((e) => e.params);
const index = (log: Entry[], pred: (e: Entry) => boolean) => log.findIndex(pred);

/** Starts a read run on a.txt and records the moment its result arrives. */
async function startRead(app: FakeApp, log: Entry[]): Promise<string> {
  const { run_id } = await app.session.start({ mode: "read", question: "Q", inputs: [join(app.deps.cwd, "a.txt")], interactive: true });
  log.push({ name: "start.result", params: { run_id } });
  return run_id;
}

async function finished(log: Entry[], runId: string): Promise<RunFinishedParams> {
  await waitFor(() => events(log, "run.finished").some((p) => p.run_id === runId));
  return events(log, "run.finished").find((p) => p.run_id === runId);
}

function answerAll(app: FakeApp, r: ApprovalResult): void {
  app.deps.approvals.subscribe(() => {
    if (app.deps.approvals.head()) app.deps.approvals.answer(r);
  });
}

function expectRunOrder(log: Entry[]): void {
  const result = index(log, (e) => e.name === "start.result");
  const started = index(log, (e) => e.method === "run.started");
  const firstCall = index(log, (e) => e.name === "call.start");
  expect(result).toBeGreaterThanOrEqual(0);
  expect(started).toBeGreaterThan(result);
  if (firstCall >= 0) expect(firstCall).toBeGreaterThan(started);
}

describe("scenarios", () => {
  test("simpleRead: one llm, then submit('42')", async () => {
    const { app, log } = await open();
    const runId = await startRead(app, log);
    expect(runId).toBe("r_000000000001");
    const fin = await finished(log, runId);
    expectRunOrder(log);
    expect(fin).toMatchObject({ answer: "42", submitted: true, turns: 2, subcalls: 1, infra_error: null, infra_kind: null });
    expect(fin.log_path).toBe(join(app.deps.home, "runs", "interactive", "runs.jsonl"));
    const started = events(log, "run.started")[0];
    expect(started).toMatchObject({ mode: "read", tag: null, root: { provider: "fake", model: "scripted" }, workspace: join(app.deps.home, "scratch", runId) });
    expect(started.input.files).toEqual([join(app.deps.cwd, "a.txt").replace(/\\/g, "/")]);
    expect(started.input.chars).toBe(6);
    const subs = events(log, "run.subcall");
    expect(subs.map((s) => s.status)).toEqual(["sent", "done"]);
    expect(subs[0]).toMatchObject({ subcall_id: 1, origin: { turn: 1, line: 1 }, batch: { id: "b1", index: 0, size: 1 }, seconds: null });
    const cells = events(log, "run.cell");
    expect(cells[0]).toMatchObject({ turn: 1, output: "A short summary.\n", error: null });
    expect(typeof cells[0].observation).toBe("string");
    expect(cells[1]).toMatchObject({ turn: 2, code: "submit('42')", output: "", observation: null });
    const methods = log.filter((e) => e.name === "engine.event").map((e) => e.method);
    expect(methods).toEqual([
      "run.started",
      "run.reply",
      "run.subcall",
      "run.subcall",
      "run.budget",
      "run.cell",
      "run.budget",
      "run.reply",
      "run.cell",
      "run.finished",
    ]);
    // the second root request carries the first reply and its observation
    const last = app.session.gateway.lastRootRequest(runId)!;
    expect(last.turn).toBe(2);
    expect(last.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", app.session.gateway.resolveCallFormat(last.model, "auto") === "native" ? "tool" : "user"]);
    expect(app.fetchCalls).toEqual([]);
  });

  test("fanOut20: 20 sub-calls in one batch, each streamed and ended with usage", async () => {
    const { app, log } = await open({ scenario: "fanOut20" });
    const t0 = performance.now();
    const runId = await startRead(app, log);
    const fin = await finished(log, runId);
    const ms = performance.now() - t0;
    expectRunOrder(log);
    expect(fin).toMatchObject({ answer: "done", submitted: true, subcalls: 20, infra_error: null });
    const sent = events(log, "run.subcall").filter((s) => s.status === "sent");
    expect(sent.map((s) => s.subcall_id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(new Set(sent.map((s) => s.batch.id))).toEqual(new Set(["b1"]));
    expect(sent.every((s) => s.origin.turn === 1 && s.origin.line === 3 && s.batch.size === 20)).toBe(true);
    const starts = log.filter((e) => e.name === "call.start" && e.params.role === "sub");
    expect(starts.map((e) => e.params.subcall_id).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(starts.map((e) => e.params.prompt).sort()).toEqual(Array.from({ length: 20 }, (_, i) => `Summarize part ${i}`).sort());
    for (const s of starts) {
      const id = s.params.call_id;
      const deltas = log.filter((e) => e.name === "call.delta" && e.params.call_id === id);
      const end = log.find((e) => e.name === "call.end" && e.params.call_id === id)!;
      expect(deltas.length).toBeGreaterThanOrEqual(3);
      expect(end.params.usage.input_tokens + end.params.usage.output_tokens).toBeGreaterThan(0);
      expect(end.params.error).toBeUndefined();
    }
    expect(events(log, "run.cell")[0]).toMatchObject({ output: "20\n", error: null });
    expect(events(log, "run.budget")[0]).toMatchObject({ subcalls_left: 60 });
    expect(ms).toBeLessThan(5000);
    console.error(`fanOut20 played in ${Math.round(ms)} ms`);
  });

  test("approvalShell allowed: output ok and a run.permission", async () => {
    const { app, log } = await open({ scenario: "approvalShell" });
    const asked: unknown[] = [];
    app.deps.approvals.subscribe(() => {
      const head = app.deps.approvals.head();
      if (head) {
        asked.push(head);
        app.deps.approvals.answer({ allow: true, remember_for_run: false });
      }
    });
    const runId = await startRead(app, log);
    const fin = await finished(log, runId);
    expect(asked).toEqual([{ run_id: runId, kind: "shell", detail: "ls -la", turn: 1, inside_workspace: true }]);
    expect(events(log, "run.cell")[0]).toMatchObject({ output: "ok\n", error: null });
    expect(events(log, "run.permission")).toEqual([{ run_id: runId, turn: 1, kind: "shell", detail: "ls -la", allowed: true, asked: true, remembered: false }]);
    expect(fin).toMatchObject({ answer: "ok", submitted: true });
  });

  test("approvalShell denied: PermissionError", async () => {
    const { app, log } = await open({ scenario: "approvalShell" });
    answerAll(app, { allow: false, remember_for_run: false });
    const runId = await startRead(app, log);
    await finished(log, runId);
    const cell = events(log, "run.cell")[0];
    expect(cell.output).toBe("");
    expect(cell.error).toBe("PermissionError: shell command denied: ls -la");
    expect(events(log, "run.permission")[0]).toMatchObject({ allowed: false, asked: true });
  });

  test("twoApprovals: both requests are out before either is answered", async () => {
    const { app, log } = await open({ scenario: "twoApprovals" });
    const runId = await startRead(app, log);
    await waitFor(() => app.deps.approvals.size === 2);
    expect(events(log, "run.permission")).toEqual([]);
    expect(app.deps.approvals.head()).toMatchObject({ kind: "write", detail: "/outside/notes.txt", inside_workspace: false });
    app.deps.approvals.answer({ allow: true, remember_for_run: false });
    await waitFor(() => events(log, "run.permission").length === 1);
    expect(app.deps.approvals.head()).toMatchObject({ kind: "network", detail: "example.com", inside_workspace: false });
    app.deps.approvals.answer({ allow: true, remember_for_run: true });
    const fin = await finished(log, runId);
    expect(events(log, "run.permission").map((p) => [p.kind, p.allowed])).toEqual([
      ["write", true],
      ["network", true],
    ]);
    expect(events(log, "run.cell")[0]).toMatchObject({ output: "Example Domain\n", error: null });
    expect(fin).toMatchObject({ submitted: true, answer: "done" });
  });

  test("slow: run.cancel mid-call sends model.cancel and ends cancelled", async () => {
    const { app, log } = await open({ scenario: "slow" });
    const runId = await startRead(app, log);
    await waitFor(() => log.some((e) => e.name === "call.delta"));
    await app.session.cancel(runId);
    // run.cancel returns after run.finished was sent
    await waitFor(() => events(log, "run.finished").length === 1, 200);
    const fin = events(log, "run.finished")[0];
    expect(fin).toMatchObject({ infra_kind: "cancelled", infra_error: "cancelled: the run was cancelled", submitted: false, turns: 0 });
    expect(app.engine.calls.map((c) => c.method)).toContain("run.cancel");
    await waitFor(() => log.some((e) => e.name === "call.end"));
    expect(log.find((e) => e.name === "call.end")!.params.error.kind).toBe("cancelled");
    expect(events(log, "run.reply")).toEqual([]);
    // a second cancel of a finished run is no error; run.vars of it is
    await app.session.cancel(runId);
    await expect(app.session.vars(runId)).rejects.toMatchObject({ code: -32010 });
  });

  test("rootError: auth on the first root call", async () => {
    const { app, log } = await open({ scenario: "rootError" });
    const runId = await startRead(app, log);
    const fin = await finished(log, runId);
    expect(fin.infra_kind).toBe("auth");
    expect(fin.infra_error).toStartWith("auth: ");
    expect(fin.turns).toBe(0);
    const cancel = index(log, (e) => e.method === "run.finished");
    expect(cancel).toBeGreaterThan(index(log, (e) => e.name === "call.end"));
  });

  test("hold: run.started, then vars, then nothing until cancel", async () => {
    const { app, log } = await open({ scenario: "hold" });
    const runId = await startRead(app, log);
    await waitFor(() => events(log, "run.started").length === 1);
    await Bun.sleep(30);
    expect(log.filter((e) => e.name === "call.start")).toEqual([]);
    expect((await app.session.vars(runId)).map((v) => v.name)).toEqual(["outs", "n"]);
    const sb = scriptedBus(app.bus, runId);
    sb.callStart("x1");
    sb.delta("x1", { reasoning: "thinking..." });
    sb.callEnd("x1");
    expect(log.find((e) => e.name === "call.end" && e.params.call_id === "x1")!.params.usage.cost_usd).toBeGreaterThan(0);
    await app.session.cancel(runId);
    expect(events(log, "run.finished")[0].infra_kind).toBe("cancelled");
    expect(app.engine.calls.map((c) => c.method)).toEqual(["run.start", "run.vars", "run.cancel"]);
  });
});

describe("the app around it", () => {
  test("run ids count up, and a settings swap reaches the next start", async () => {
    const { app, log } = await open();
    const first = await startRead(app, log);
    await finished(log, first);
    expect(app.engine.calls.find((c) => c.method === "run.start")!.params.permission_mode).toBe("accept-edits");
    const s = setSetting(app.session.settings, "permissions.mode", "default");
    app.session.settings = s;
    app.session.gateway.settings = s;
    const second = await startRead(app, log);
    expect(second).toBe("r_000000000002");
    expect(app.engine.runId).toBe(second);
    await finished(log, second);
    expect(app.engine.calls.filter((c) => c.method === "run.start")[1]!.params.permission_mode).toBe("default");
    expect(app.startCalls).toHaveLength(2);
    expect(await app.session.info()).toMatchObject({ protocol: 1, contract: "v4" });
  });

  test("bad input and unknown profile reject start", async () => {
    const { app } = await open();
    await expect(app.session.start({ mode: "read", question: "Q", inputs: [join(app.deps.cwd, "missing.txt")], interactive: true })).rejects.toMatchObject({ code: -32012 });
    await expect(app.session.start({ mode: "read", question: "Q", inputs: [join(app.deps.cwd, "a.txt")], profile: "nope", interactive: true })).rejects.toMatchObject({ code: -32011 });
  });

  test("crash emits engine.exit and later starts reject", async () => {
    const { app, log } = await open({ scenario: "hold" });
    await startRead(app, log);
    app.engine.crash(1, ["Traceback (most recent call last):", "boom"]);
    await waitFor(() => log.some((e) => e.name === "engine.exit"));
    expect(log.find((e) => e.name === "engine.exit")!.params).toEqual({ code: 1, stderr: ["Traceback (most recent call last):", "boom"] });
    await expect(startRead(app, log)).rejects.toMatchObject({ code: -32800 });
    await app.session.close();
    expect(app.sessionClosed()).toBe(true);
  });

  test("close and dispose: settings saved, env set then restored, temp folder gone", async () => {
    const before = process.env.RLMH_FAKE_SCRIPT;
    const { app } = await open({ settings: { "sub.thinking": "low" }, size: { columns: 80, rows: 24 } });
    expect(process.env.RLMH_FAKE_SCRIPT).toBe(app.scriptPath);
    expect(app.deps.env).toEqual({ RLMH_FAKE_SCRIPT: app.scriptPath });
    expect(app.deps.size).toEqual({ columns: 80, rows: 24 });
    const toml = readFileSync(join(app.deps.home, "settings.toml"), "utf8");
    expect(toml).toContain('model = "fake/scripted"');
    expect(toml).toContain('thinking = "low"');
    expect(existsSync(join(app.deps.cwd, "a.txt"))).toBe(true);
    let exits = 0;
    app.bus.on("engine.exit", () => exits++);
    await app.session.close();
    await app.session.close();
    expect(app.sessionClosed()).toBe(true);
    await Bun.sleep(5);
    expect(exits).toBe(0);
    await app.dispose();
    await app.dispose();
    expect(existsSync(app.deps.home)).toBe(false);
    expect(process.env.RLMH_FAKE_SCRIPT).toBe(before);
  });

  test("engine.emit run.finished stops the play", async () => {
    const { app, log } = await open({ scenario: "approvalShell" });
    const runId = await startRead(app, log);
    await waitFor(() => app.deps.approvals.size === 1);
    app.engine.emit("run.finished", { tag: null, answer: null, submitted: false, infra_error: "worker: died", infra_kind: "worker" });
    await waitFor(() => events(log, "run.finished").length === 1);
    expect(events(log, "run.finished")[0]).toMatchObject({ run_id: runId, infra_kind: "worker" });
    app.deps.approvals.denyAll();
    await Bun.sleep(30);
    expect(events(log, "run.finished")).toHaveLength(1);
    expect(events(log, "run.permission")).toEqual([]);
  });
});

describe("helpers", () => {
  test("scriptedBus defaults", () => {
    const bus = new Bus<AppEvents>();
    const seen: any[] = [];
    bus.on("engine.event", (e) => seen.push(e));
    const sb = scriptedBus(bus, "r_x");
    sb.subcall({ status: "rejected", subcall_id: null, error: "budget" });
    expect(seen[0]).toEqual({
      method: "run.subcall",
      params: { run_id: "r_x", subcall_id: null, origin: { turn: 1, line: 1 }, batch: { id: "b1", index: 0, size: 1 }, prompt_chars: 10, status: "rejected", error: "budget", seconds: null },
    });
  });

  test("runRecord has the §7.8 keys in order and adds up", () => {
    const r = runRecord();
    expect(Object.keys(r)).toEqual([
      "format", "run_id", "tag", "batch", "harness_version", "protocol", "contract", "contract_hash", "prompt_hash",
      "profile", "profile_hash", "mode", "call_format", "root", "sub", "permission_mode", "limits", "started_at",
      "wall_s", "question", "input", "workspace", "base_tree", "messages", "turns", "subcalls", "fetches",
      "permissions", "submitted", "answer", "answer_valid", "usage", "cost_usd", "cache", "timeouts", "crashes",
      "restarts", "diff", "infra_error", "infra_kind", "host_traceback",
    ]);
    expect(r.turns).toHaveLength(2);
    expect(r.subcalls).toHaveLength(3);
    expect(Math.round((r.usage.root.cost_usd + r.usage.sub.cost_usd) * 1e6) / 1e6).toBe(r.cost_usd);
    expect(runRecord({ format: 99 }).format).toBe(99);
  });
});
