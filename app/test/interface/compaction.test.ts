// KV cache: none; a test.
// Compaction in the interface (v1 step 3): a compacting run shows a "Compacted …" note before the turn it preceded, a
// root summary call shows "compacting…" as the live tail instead of a reply, a child's compaction lands in its row, and
// /runs lists and opens a format 1 line and a format 2 line with `compactions`.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runsDir } from "../../src/paths.ts";
import { RunStore, viewFromRecord, type Entry, type RunView } from "../../src/interface/store.ts";
import { makeTheme } from "../../src/interface/theme.ts";
import { transcriptLines } from "../../src/interface/Transcript.tsx";
import type { RunCompactedParams } from "../../src/protocol.ts";
import { COMPACT_AT, createFakeApp, FAKE_LIMITS, runRecord, scriptedBus, type FakeApp } from "../fakes/engine.ts";
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

const NOTE = /Compacted (\d+) messages to save context: ~[\d.]+k to ~[\d.]+k tokens\./;
const REF = { provider: "fake", model: "scripted", thinking: null };

function compacted(over: Partial<RunCompactedParams> = {}): Omit<RunCompactedParams, "run_id"> {
  return {
    turn: 3,
    prompt_index: 0,
    child_id: null,
    before_tokens: 131_022,
    after_tokens: 33_870,
    dropped_messages: 12,
    kept_messages: 4,
    summary_chars: 2310,
    seconds: 14.2,
    ...over,
  };
}

/** Waits until `ok` holds for the published view. */
async function until(store: RunStore, ok: (v: RunView) => boolean): Promise<RunView> {
  const deadline = Date.now() + 2000;
  while (!ok(store.snapshot()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return store.snapshot();
}

describe("a live run", () => {
  test("a compacting run shows the note before the turn it preceded, then finishes", async () => {
    app = await createFakeApp({ scenario: "compacting", size: { columns: 120, rows: 60 } });
    m = mount(app.deps);
    await m.waitForText("idle");
    await m.type("Summarize @a.txt");
    await m.press(KEYS.enter);
    const s = await m.waitForText("compacted answer");
    expect(s).toMatch(NOTE);
    expect(NOTE.exec(s)![1]).toBe("4"); // turns 1 and 2 dropped; turn 3 kept
    expect(s.indexOf("Compacted 4 messages")).toBeLessThan(s.indexOf(`turn ${COMPACT_AT}`));
    expect(s.indexOf("Compacted 4 messages")).toBeGreaterThan(s.indexOf(`turn ${COMPACT_AT - 1}`));
    expect(s).not.toContain("SUMMARY of the work so far."); // the summary is not a reply
    // the summary call went to the gateway as a root call with purpose compact; /context still shows the conversation
    const runId = app.engine.runId!;
    expect(app.session.gateway.lastRootRequest(runId)?.purpose).toBeUndefined();
    expect(app.session.gateway.lastRootRequest(runId)?.messages[2]?.content).toContain("SUMMARY of the work so far.");
  });

  test("the root's summary call is a live 'compacting' tail, never a reply; run.compacted turns it into the note", async () => {
    app = await createFakeApp({ scenario: "hold" });
    const store = new RunStore(app.deps);
    try {
      store.beginRun({ text: "Q", detail: "read: 1 file" });
      store.startResolved("r_00000000abcd");
      const sb = scriptedBus(app.bus, "r_00000000abcd");
      sb.event("run.started", { root: REF, sub: REF, profile: "default", call_format: "native", permission_mode: "accept-edits", limits: FAKE_LIMITS });
      sb.event("run.reply", { turn: 1, text: "first", tool_call: null, reasoning: null, finish_reason: "stop", usage: { input_tokens: 900, output_tokens: 100, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 }, seconds: 1 });
      sb.callStart("c9", { role: "root", purpose: "compact", subcall_id: undefined, batch: undefined, origin: undefined });
      sb.delta("c9", { text: "the summary text" });
      let v = await until(store, (x) => x.entries.some((e) => e.kind === "compacting"));
      expect(v.entries.at(-1)).toEqual({ kind: "compacting" });
      expect(v.rootOpen).toBe(true);
      expect(JSON.stringify(v.entries)).not.toContain("the summary text");
      expect(v.entries.filter((e) => e.kind === "reply")).toHaveLength(1); // no live reply for it

      sb.callEnd("c9");
      sb.event("run.compacted", compacted({ turn: 2 }));
      v = await until(store, (x) => x.entries.some((e) => e.kind === "note"));
      expect(v.entries.some((e) => e.kind === "compacting")).toBe(false);
      expect(v.entries.at(-1)).toEqual({ kind: "note", text: "Compacted 12 messages to save context: ~131k to ~33.9k tokens.", tone: "info" });
      expect(v.ctx).toEqual({ tokens: 33_870, estimated: true }); // until the next reply says otherwise

      // a child's compaction: a note naming the child, and a line in the child's row; its summary call stays out of the row's text
      sb.event("run.child", { child_id: 1, subcall_id: 4, depth: 1, status: "started", task: "T", tools: "read", turn: 0, max_turns: 30, code: null, output: null, error: null, answer: null, seconds: null });
      const child = { id: 1, turn: 3, max_turns: 30, depth: 1 };
      sb.callStart("c10", { subcall_id: 4, batch: { id: "rlm1", index: 0, size: 1 }, child, purpose: "compact" });
      sb.delta("c10", { text: "child summary" });
      sb.callEnd("c10");
      sb.event("run.compacted", compacted({ child_id: 1, turn: 3, before_tokens: 3_300, after_tokens: 412, dropped_messages: 6 }));
      sb.callStart("c11", { subcall_id: 4, batch: { id: "rlm1", index: 0, size: 1 }, child });
      v = await until(store, (x) => x.entries.some((e) => e.kind === "note" && e.text.startsWith("rlm1")));
      expect(v.entries.at(-1)).toEqual({ kind: "note", text: "rlm1: Compacted 6 messages to save context: ~3.3k to ~0.4k tokens.", tone: "info" });
      const row = v.blocks.find((b) => b.id === "rlm1")!.rows[0]!;
      expect(row.text).toMatch(/^\(Compacted 6 messages to save context: ~3\.3k to ~0\.4k tokens\.\)\n(──|--) turn 3 (──|--)\n$/); // the rule follows the terminal
      expect(row.usage?.input_tokens).toBe(1200); // the summary call's usage counts for the child
      expect(v.ctx).toEqual({ tokens: 33_870, estimated: true }); // a child's compaction leaves the root's context alone
    } finally {
      store.dispose();
    }
  });
});

test("the transcript draws the compacting tail with a spinner, in Unicode and in ASCII", () => {
  for (const [env, text] of [[{ WT_SESSION: "1" }, "compacting…"], [{ RLMH_ASCII: "1" }, "compacting..."]] as const) {
    const lines = transcriptLines([{ kind: "compacting" }], 80, makeTheme(env, "win32"), { full: false, now: 0 });
    const flat = lines.map((l) => l.map((sp) => sp.text).join(""));
    expect(flat.some((l) => l.includes(text))).toBe(true);
  }
});

describe("viewFromRecord", () => {
  test("each compaction comes before the turn it preceded; a child's goes in its row", () => {
    const base = runRecord();
    const record = runRecord({
      compactions: [compacted({ turn: 2 }), compacted({ turn: 7, dropped_messages: 3 }), compacted({ child_id: 1, turn: 2, before_tokens: 3_300, after_tokens: 412, dropped_messages: 6 })],
      children: [{ child_id: 1, subcall_id: 9, depth: 1, task: "T", tools: "read", max_turns: 30, turns: [{ turn: 1, reply: "one" }, { turn: 2, reply: "two" }], answer: "x" }],
    });
    const v = viewFromRecord(record);
    const kinds = v.entries.map((e: Entry) => (e.kind === "reply" ? `reply ${e.turn}` : e.kind === "note" ? e.text : e.kind));
    const note = "Compacted 12 messages to save context: ~131k to ~33.9k tokens.";
    expect(kinds.indexOf(note)).toBe(kinds.indexOf("reply 2") - 1);
    expect(kinds.indexOf("reply 1")).toBeLessThan(kinds.indexOf(note));
    // turn 7 never came: its note follows the last turn, before the answer
    expect(kinds.slice(-2)).toEqual(["Compacted 3 messages to save context: ~131k to ~33.9k tokens.", "answer"]);
    expect(kinds.filter((k) => k.startsWith("rlm1"))).toEqual([]);
    const row = v.blocks.find((b) => b.id === "rlm1")!.rows[0]!;
    expect(row.text).toBe("── turn 1 ──\none\n(Compacted 6 messages to save context: ~3.3k to ~0.4k tokens.)\n── turn 2 ──\ntwo");
    // no compactions: the same view as before step 3
    expect(viewFromRecord(base).entries.filter((e) => e.kind === "note")).toEqual([]);
  });
});

describe("/runs", () => {
  test("lists a format 1 line and a format 2 line with compactions, and opens both", async () => {
    app = await createFakeApp({ size: { columns: 120, rows: 40 } });
    m = mount(app.deps);
    await m.waitForText("idle");
    const dir = join(runsDir(app.deps.home), "interactive");
    mkdirSync(dir, { recursive: true });
    const v1 = runRecord({ format: 1, run_id: "r_000000000001", started_at: 1793450000, question: "the format one question" });
    for (const k of ["window", "compactions", "prompt_index", "conversation"]) delete v1[k];
    const v2 = runRecord({ run_id: "r_000000000002", started_at: 1793460000, question: "the format two question", compactions: [compacted({ turn: 2 })] });
    writeFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(v1)}\n${JSON.stringify(v2)}\n`);
    await m.type("/runs");
    await m.press(KEYS.enter);
    let s = await m.waitForText("the format one question");
    expect(s).toContain("the format two question");
    expect(s).not.toMatch(/format [12]\b/); // both readable: neither row is flagged with its format
    expect(s).not.toContain("another format version");

    await m.press(KEYS.enter); // the newest: format 2
    s = await m.waitForText("run r_000000000002 (read-only)");
    await m.press(KEYS.pageUp);
    s = await m.waitForText("Compacted 12 messages to save context: ~131k to ~33.9k tokens.");
    expect(s).toContain("> the format two question");
    await m.press(KEYS.esc);
    await m.waitForText("the format one question");
    await m.press(KEYS.down);
    await m.press(KEYS.enter); // format 1
    s = await m.waitForText("run r_000000000001 (read-only)");
    expect(s).not.toContain("another format version");
    await m.press(KEYS.pageUp);
    s = await m.waitForText("> the format one question");
    expect(s).not.toContain("Compacted");
  });
});
