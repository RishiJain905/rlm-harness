// KV cache: none; a test.
// Follow-ups in the interactive app (v1 step 4) against the fake engine's `conversation` scenario: a question that fits
// the open conversation is a run.say in it; anything else closes it (run.close) and starts a fresh run.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { PROVIDERS } from "../../src/gateway/providers.ts";
import { CONVERSATION_ENDED } from "../../src/interface/App.tsx";
import { issuedBy, RunStore } from "../../src/interface/store.ts";
import { createFakeApp, scriptedBus, scriptedUsage, type FakeApp, type FakeAppOptions } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

setDefaultTimeout(30_000);

let app: FakeApp | undefined;
let m: Mounted | undefined;

afterEach(async () => {
  m?.unmount();
  await app?.dispose();
  app = undefined;
  m = undefined;
});

async function open(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; m: Mounted }> {
  app = await createFakeApp({ scenario: "conversation", ...opts });
  m = mount(app.deps);
  await m.waitForText("idle");
  return { app, m };
}

async function ask(m: Mounted, text: string): Promise<void> {
  await m.type(text);
  await m.press(KEYS.enter);
}

const status = (m: Mounted) => m.screen().trimEnd().split("\n").at(-1)!;
/** The engine requests that matter here, in order. */
const methods = (app: FakeApp) => app.engine.calls.map((c) => c.method).filter((x) => x !== "engine.info" && x !== "run.vars");
const ready = (m: Mounted) => m.waitFor(() => status(m).startsWith("ready for a follow-up"), 10_000);

describe("follow-ups", () => {
  test("a no-mention question, then a second: one run.start, one run.say, and follow-up 1 in the transcript and status", async () => {
    const { app, m } = await open();
    await ask(m, "What is in this folder?");
    await ready(m);
    expect(m.screen()).toContain("first answer");
    expect(app.startCalls).toHaveLength(1);
    expect(app.startCalls[0]).toMatchObject({ mode: "repo", conversation: true });
    expect(app.engine.calls.find((c) => c.method === "run.start")!.params.conversation).toBe(true);
    const runId = app.engine.runId;

    await ask(m, "And what else?");
    await m.waitFor(() => / · follow-up 1/.test(status(m)) && status(m).startsWith("running "), 10_000);
    expect(m.screen()).toContain("(follow-up 1)");
    await ready(m);
    expect(m.screen()).toContain("second answer");
    expect(m.screen()).toContain("first answer"); // the transcript keeps the first prompt
    expect(methods(app)).toEqual(["run.start", "run.say"]);
    expect(app.engine.calls.find((c) => c.method === "run.say")!.params).toEqual({ run_id: runId, text: "And what else?" });
    expect(app.startCalls).toHaveLength(1);
  });

  test("@a.txt, then a question with no mention: a follow-up in read mode; @a.txt again is one too, mentions dropped", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    expect(app.startCalls[0]).toMatchObject({ mode: "read", question: "Summarize a.txt", conversation: true });
    await ask(m, "How long is it?");
    await m.waitFor(() => app.engine.calls.some((c) => c.method === "run.say"));
    await ready(m);
    await ask(m, "Look at @a.txt again");
    await m.waitFor(() => app.engine.calls.filter((c) => c.method === "run.say").length === 2);
    await ready(m);
    expect(methods(app)).toEqual(["run.start", "run.say", "run.say"]);
    expect(app.engine.calls.filter((c) => c.method === "run.say").map((c) => c.params.text)).toEqual(["How long is it?", "Look at a.txt again"]);
    expect(m.screen()).toContain("(follow-up 2)");
  });

  test("@a.txt, then @b.txt: run.close, then a new run.start", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    const first = app.engine.runId;
    await ask(m, "Now @b.txt");
    await m.waitFor(() => app.startCalls.length === 2);
    await ready(m);
    expect(methods(app)).toEqual(["run.start", "run.close", "run.start"]);
    expect(app.engine.calls.find((c) => c.method === "run.close")!.params).toEqual({ run_id: first });
    expect(app.engine.runId).not.toBe(first);
    expect(app.startCalls[1]).toMatchObject({ mode: "read", question: "Now b.txt" });
  });

  test("a Shift+Tab choice of repo after a read conversation: a new conversation", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    await m.press(KEYS.shiftTab);
    await m.waitFor(() => status(m).includes("repo mode"));
    await ask(m, "Tidy this folder");
    await m.waitFor(() => app.startCalls.length === 2);
    expect(methods(app)).toEqual(["run.start", "run.close", "run.start"]);
    expect(app.startCalls[1]).toMatchObject({ mode: "repo", task: "Tidy this folder" });
  });

  test("a changed root.model (through /model): a new conversation", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    await m.type("/model");
    await m.press(KEYS.enter);
    await m.waitForText("── /model");
    await m.press(KEYS.enter); // root
    await m.waitForText("Provider for root");
    for (let i = 0; i < PROVIDERS.findIndex((p) => p.id === "fake"); i++) await m.press(KEYS.down);
    await m.press(KEYS.enter);
    await m.waitForText("scripted   window 1M");
    await m.type("scripted-two");
    await m.waitForText('use "scripted-two" as typed');
    await m.press(KEYS.enter);
    await m.waitForText("Thinking for root fake/scripted-two");
    await m.press(KEYS.enter);
    await m.waitFor(() => app.session.settings.root.model === "fake/scripted-two");
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("── /model"));
    await ask(m, "How long is it?");
    await m.waitFor(() => app.startCalls.length === 2);
    expect(methods(app)).toEqual(["run.start", "run.close", "run.start"]);
    expect(app.engine.calls.filter((c) => c.method === "run.start")[1]!.params.root).toMatchObject({ provider: "fake", model: "scripted-two" });
  });

  test("/clear with an open conversation: run.close, then New session.", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    await ask(m, "/clear");
    await m.waitForText("New session.");
    expect(methods(app)).toEqual(["run.start", "run.close"]);
    expect(status(m)).toStartWith("idle");
    // the next question starts fresh
    await ask(m, "How long is it?");
    await m.waitFor(() => app.startCalls.length === 2);
    expect(methods(app)).toEqual(["run.start", "run.close", "run.start"]);
  });

  test("conversation.follow_ups = false: every question is a run.start with conversation: false", async () => {
    const { app, m } = await open({ settings: { "conversation.follow_ups": false } });
    await ask(m, "Summarize @a.txt");
    await m.waitFor(() => status(m).startsWith("finished"), 10_000);
    await ask(m, "How long is it?");
    await m.waitFor(() => app.startCalls.length === 2);
    await m.waitFor(() => status(m).startsWith("finished"), 10_000);
    expect(methods(app)).toEqual(["run.start", "run.start"]);
    expect(app.engine.calls.filter((c) => c.method === "run.start").map((c) => c.params.conversation)).toEqual([false, false]);
  });

  test("a -32010 on run.say: the note, then a fresh start", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    app.engine.dropRun(); // the engine forgets the conversation and tells the app nothing
    await ask(m, "How long is it?");
    await m.waitFor(() => app.startCalls.length === 2);
    await m.waitForText(CONVERSATION_ENDED);
    expect(methods(app)).toEqual(["run.start", "run.say", "run.start"]);
    expect(app.startCalls[1]).toMatchObject({ mode: "repo", task: "How long is it?", conversation: true });
    await ready(m);
  });

  test("/context lists the variables while the conversation waits between prompts", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    await ask(m, "/context");
    const s = await m.waitForText("outs");
    expect(s).not.toContain("Variables exist only while a run or a conversation is open.");
    expect(app.engine.calls.some((c) => c.method === "run.vars")).toBe(true);
    await m.press(KEYS.esc);
    await ask(m, "/clear");
    await m.waitForText("New session.");
    await ask(m, "/context");
    await m.waitForText("Variables exist only while a run or a conversation is open.");
  });

  test("Ctrl+C during a follow-up cancels the conversation too", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    await ask(m, "How long is it?");
    await m.waitFor(() => / · follow-up 1/.test(status(m)), 10_000);
    await m.press(KEYS.ctrlC);
    await m.waitFor(() => status(m).startsWith("cancelled"), 10_000);
    expect(methods(app)).toEqual(["run.start", "run.say", "run.cancel"]);
  });

  test("Esc during a follow-up: run.cancel, and the next question starts fresh", async () => {
    const { app, m } = await open();
    await ask(m, "Summarize @a.txt");
    await ready(m);
    await ask(m, "How long is it?");
    await m.waitFor(() => / · follow-up 1/.test(status(m)), 10_000);
    await m.press(KEYS.esc);
    await m.waitFor(() => status(m).startsWith("cancelled"), 10_000);
    expect(methods(app)).toEqual(["run.start", "run.say", "run.cancel"]);
    await ask(m, "And now?");
    await m.waitFor(() => app.startCalls.length === 2);
    expect(methods(app)).toEqual(["run.start", "run.say", "run.cancel", "run.start"]); // nothing left to close
  });
});

describe("the sub-call rows of earlier prompts", () => {
  test("keep their Issued-by line when the next prompt's turns start at 1 again", async () => {
    app = await createFakeApp({ scenario: "conversation" });
    const store = new RunStore(app.deps);
    const runId = "r_00000000abcd";
    const bus = scriptedBus(app.bus, runId);
    const ref = { provider: "fake", model: "scripted", thinking: null };
    try {
      store.beginRun({ text: "Q", detail: "repo" });
      store.startResolved(runId);
      bus.event("run.started", { tag: null, mode: "repo", profile: "default", call_format: "native", root: ref, sub: ref, permission_mode: "accept-edits", input: { chars: 0, lines: 0, sha256: "", files: [] }, limits: { max_turns: 6, max_subcalls: 5 }, conversation: true });
      bus.event("run.reply", { turn: 1, text: "", tool_call: { id: "call_1", name: "python", arguments: { code: "x = llm('first prompt')" } }, reasoning: null, finish_reason: "tool_call", usage: scriptedUsage(), seconds: 0.1 });
      bus.subcall({ status: "sent" });
      bus.event("run.finished", { answer: "1", submitted: true, infra_error: null, infra_kind: null, prompt_index: 0, open: true });
      await new Promise((r) => setTimeout(r, 120));
      store.beginFollowUp("Q2");
      bus.event("run.reply", { turn: 1, text: "", tool_call: { id: "call_2", name: "python", arguments: { code: "y = 2" } }, reasoning: null, finish_reason: "tool_call", usage: scriptedUsage(), seconds: 0.1 });
      await new Promise((r) => setTimeout(r, 120));
      const view = store.snapshot();
      const row = view.blocks[0]!.rows[0]!;
      expect(issuedBy(row, view.cellCode)).toBe("Issued by turn 1, line 1: x = llm('first prompt')");
      expect(view.cellCode[1]).toBe("y = 2");
    } finally {
      store.dispose();
    }
  });
});
