// KV cache: none
// The scripted fake provider `fake/scripted`, through gateway.complete: every bullet of the
// "FakeProvider (§7.5, exactly)" paragraph of the step 5 spec and architecture §7.5.
// No server and no key: the script file comes in through rig's env as RLMH_FAKE_SCRIPT.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelError } from "../../src/gateway/gateway.ts";
import type { ModelErrorKind } from "../../src/protocol.ts";
import { caught, limits, params, recordSleeps, ref, rig, sub, type Rig } from "./helpers.ts";

const FAKE = ref("fake", "scripted");
const RUN_A = "r_aaaaaaaaaaaa";
const RUN_B = "r_bbbbbbbbbbbb";

let dir: string;
let rigs: Rig[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlmh-fake-"));
  rigs = [];
});
afterEach(() => {
  for (const r of rigs) r.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function scriptFile(content: unknown, name = "script.json"): string {
  const file = join(dir, name);
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

/** A gateway whose RLMH_FAKE_SCRIPT names a file holding `content`. */
async function fakeRig(content: unknown, opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig({ ...opts, env: { RLMH_FAKE_SCRIPT: scriptFile(content) } });
  rigs.push(r);
  return r;
}

async function plainRig(env: Record<string, string> = {}): Promise<Rig> {
  const r = await rig({ env });
  rigs.push(r);
  return r;
}

const root = (run = RUN_A) => params(FAKE, { run_id: run });
const subCall = (prompt: string, run = RUN_A, index = 0) => sub(FAKE, prompt, { id: "b1", index, size: 1 }, { run_id: run });

/** The text deltas of a call, in order. */
function deltas(r: Rig, callId?: string): string[] {
  return r.events.filter((e) => e.name === "call.delta" && (callId === undefined || e.payload.call_id === callId)).map((e) => e.payload.text);
}

describe("root replies", () => {
  test("are served in order: text, text with a tool call, a tool call alone", async () => {
    const r = await fakeRig({
      root: [
        { text: "Look first.\n```python\nprint(len(context))\n```" },
        { text: "", tool_call: { code: "submit('42')" } },
        { text: "I will run it.", tool_call: { code: "print(1)" } },
        { tool_call: { code: "print(2)" } },
        { text: "last" },
      ],
    });
    const one = await r.gateway.complete(root());
    expect(one.text).toBe("Look first.\n```python\nprint(len(context))\n```");
    expect(one.tool_call).toBeNull();
    expect(one.finish_reason).toBe("stop");
    expect(one.reasoning).toBeNull();
    expect(one.served_model).toBe("scripted");

    const two = await r.gateway.complete(root());
    expect(two.text).toBe("");
    expect(two.tool_call).toEqual({ id: "call_2", name: "python", arguments: { code: "submit('42')" } });
    expect(two.finish_reason).toBe("tool_call");

    const three = await r.gateway.complete(root());
    expect(three.text).toBe("I will run it.");
    expect(three.tool_call).toEqual({ id: "call_3", name: "python", arguments: { code: "print(1)" } });
    expect(three.finish_reason).toBe("tool_call");

    const four = await r.gateway.complete(root());
    expect(four.text).toBe("");
    expect(four.tool_call).toEqual({ id: "call_4", name: "python", arguments: { code: "print(2)" } });

    const five = await r.gateway.complete(root());
    expect(five.text).toBe("last");
    expect(five.tool_call).toBeNull();
    expect(five.finish_reason).toBe("stop");
  });

  test("a tool call's id is call_<n>, n counting the root replies served in the run from 1", async () => {
    const r = await fakeRig({ root: [{ tool_call: { code: "a" } }, { text: "plain" }, { tool_call: { code: "b" } }, { tool_call: { code: "c" } }] });
    const ids: (string | null)[] = [];
    for (let i = 0; i < 4; i++) ids.push((await r.gateway.complete(root())).tool_call?.id ?? null);
    expect(ids).toEqual(["call_1", null, "call_3", "call_4"]);
  });

  test("each run starts again at index 0, and its ids start again at call_1", async () => {
    const r = await fakeRig({ root: [{ tool_call: { code: "first" } }, { text: "second" }] });
    const a1 = await r.gateway.complete(root(RUN_A));
    const b1 = await r.gateway.complete(root(RUN_B));
    const a2 = await r.gateway.complete(root(RUN_A));
    const b2 = await r.gateway.complete(root(RUN_B));
    expect(a1.tool_call).toEqual({ id: "call_1", name: "python", arguments: { code: "first" } });
    expect(b1.tool_call).toEqual({ id: "call_1", name: "python", arguments: { code: "first" } });
    expect(a2.text).toBe("second");
    expect(b2.text).toBe("second");
  });

  test("past the end of the script the call fails with kind other, `fake script exhausted`", async () => {
    const r = await fakeRig({ root: [{ text: "only" }] });
    expect((await r.gateway.complete(root())).text).toBe("only");
    for (let i = 0; i < 2; i++) {
      const err = await caught(r.gateway.complete(root()));
      expect(err).toBeInstanceOf(ModelError);
      expect(err.data).toEqual({ kind: "other", provider: "fake", model: "scripted", status: null, message: "fake script exhausted" });
      expect(err.code).toBe(-32001);
    }
    // Another run is not affected.
    expect((await r.gateway.complete(root(RUN_B))).text).toBe("only");
    const end = r.events.filter((e) => e.name === "call.end").map((e) => e.payload);
    expect(end[1].error.kind).toBe("other");
    expect(end[1].error.message).toBe("fake script exhausted");
  });

  test("a script with no root replies is exhausted at once", async () => {
    const r = await fakeRig({ sub: [{ text: "x" }] });
    const err = await caught(r.gateway.complete(root()));
    expect(err.data.message).toBe("fake script exhausted");
  });
});

describe("sub-calls", () => {
  test("take the first rule whose match regex finds the prompt anywhere in it", async () => {
    const r = await fakeRig({
      sub: [
        { match: "^Summarize", text: "a summary" },
        { match: "foo", text: "foo rule" },
        { match: "foo|bar", text: "later rule" },
        { match: "\\d{3}", text: "digits" },
      ],
    });
    const answer = async (prompt: string) => (await r.gateway.complete(subCall(prompt))).text;
    expect(await answer("Summarize this chunk")).toBe("a summary");
    expect(await answer("Summarize foo")).toBe("a summary"); // rule order, not the best match
    expect(await answer("please foo that")).toBe("foo rule"); // anywhere in the prompt
    expect(await answer("a bar here")).toBe("later rule");
    expect(await answer("page 123 of 456")).toBe("digits");
    // `^` anchors at the start of the prompt only.
    const err = await caught(r.gateway.complete(subCall("Please Summarize this")));
    expect(err.data.message).toBe("fake script has no sub-call rule for this prompt");
  });

  test("when no rule matches, the first rule without a match answers, wherever it stands", async () => {
    const r = await fakeRig({ sub: [{ text: "default sub-call answer" }, { match: "^Summarize", text: "a summary" }, { text: "a second default" }] });
    expect((await r.gateway.complete(subCall("Summarize x"))).text).toBe("a summary"); // a later match beats an earlier default
    expect((await r.gateway.complete(subCall("anything else"))).text).toBe("default sub-call answer");
  });

  test("with no rule at all the call fails with kind other and the exact message", async () => {
    for (const script of [{ root: [{ text: "x" }] }, { sub: [] }, { sub: [{ match: "^Summarize", text: "s" }] }]) {
      const r = await fakeRig(script);
      const err = await caught(r.gateway.complete(subCall("Translate this")));
      expect(err).toBeInstanceOf(ModelError);
      expect(err.data).toEqual({ kind: "other", provider: "fake", model: "scripted", status: null, message: "fake script has no sub-call rule for this prompt" });
    }
  });

  test("the prompt is the last message, and a rule without text answers with an empty string", async () => {
    const r = await fakeRig({ sub: [{ match: "^Summarize", text: "matched" }, { match: "^Empty", text: "" }, { text: "default" }] });
    const p = params(FAKE, {
      role: "sub",
      messages: [
        { role: "system", content: "Summarize everything" },
        { role: "user", content: "just chat" },
      ],
    });
    expect((await r.gateway.complete(p)).text).toBe("default");
    const empty = await r.gateway.complete(subCall("Empty one"));
    expect(empty.text).toBe("");
  });

  test("always finish with stop, with no tool call and no reasoning", async () => {
    const r = await fakeRig({ sub: [{ text: "answer" }] });
    const res = await r.gateway.complete(subCall("q"));
    expect(res.finish_reason).toBe("stop");
    expect(res.tool_call).toBeNull();
    expect(res.reasoning).toBeNull();
    expect(res.served_model).toBe("scripted");
  });

  test("do not use up root replies, and root calls do not use up sub rules", async () => {
    const r = await fakeRig({ root: [{ text: "r1" }, { text: "r2" }], sub: [{ text: "s" }] });
    expect((await r.gateway.complete(root())).text).toBe("r1");
    await r.gateway.complete(subCall("q"));
    await r.gateway.complete(subCall("q"));
    expect((await r.gateway.complete(root())).text).toBe("r2");
  });
});

describe("errors[]", () => {
  test("fails the at-th call of that role, counting the calls that succeeded", async () => {
    const r = await fakeRig({ sub: [{ text: "ok" }], errors: [{ role: "sub", at: 3, kind: "bad_request", status: 400 }] });
    expect((await r.gateway.complete(subCall("one"))).text).toBe("ok");
    expect((await r.gateway.complete(subCall("two"))).text).toBe("ok");
    const err = await caught(r.gateway.complete(subCall("three")));
    expect(err).toBeInstanceOf(ModelError);
    expect(err.data).toMatchObject({ kind: "bad_request", provider: "fake", model: "scripted", status: 400 });
    expect(typeof err.data.message).toBe("string");
    expect(err.data.message.length).toBeGreaterThan(0);
    expect(err.code).toBe(-32001);
    expect((await r.gateway.complete(subCall("four"))).text).toBe("ok"); // only the at-th call fails
  });

  test("status is null unless the script gives one", async () => {
    const r = await fakeRig({ root: [{ text: "x" }], errors: [{ role: "root", at: 1, kind: "rate_limit" }] });
    const err = await caught(r.gateway.complete(root()));
    expect(err.data.kind).toBe("rate_limit");
    expect(err.data.status).toBeNull();
    const withNull = await fakeRig({ root: [{ text: "x" }], errors: [{ role: "root", at: 1, kind: "server", status: null }] });
    expect((await caught(withNull.gateway.complete(root()))).data.status).toBeNull();
  });

  test("are counted per role: a root error doesn't move the sub count, and the other way round", async () => {
    const r = await fakeRig({
      root: [{ text: "r1" }, { text: "r2" }, { text: "r3" }],
      sub: [{ text: "s" }],
      errors: [
        { role: "root", at: 2, kind: "timeout" },
        { role: "sub", at: 1, kind: "server", status: 503 },
      ],
    });
    expect((await r.gateway.complete(root())).text).toBe("r1");
    expect((await caught(r.gateway.complete(subCall("a")))).data).toMatchObject({ kind: "server", status: 503 }); // sub call 1
    expect((await caught(r.gateway.complete(root()))).data.kind).toBe("timeout"); // root call 2
    expect((await r.gateway.complete(subCall("b"))).text).toBe("s"); // sub call 2
  });

  test("are counted per run", async () => {
    const r = await fakeRig({ root: [{ text: "x" }], errors: [{ role: "root", at: 1, kind: "network" }] });
    expect((await caught(r.gateway.complete(root(RUN_A)))).data.kind).toBe("network");
    expect((await caught(r.gateway.complete(root(RUN_B)))).data.kind).toBe("network"); // B's first call fails too
    expect((await r.gateway.complete(root(RUN_A))).text).toBe("x"); // A's second does not
  });

  test("a failed root call is not a served reply: the next call serves the next reply and call_<n> doesn't skip", async () => {
    const r = await fakeRig({ root: [{ tool_call: { code: "a" } }, { tool_call: { code: "b" } }], errors: [{ role: "root", at: 2, kind: "server", status: 500 }] });
    expect((await r.gateway.complete(root())).tool_call?.id).toBe("call_1");
    await caught(r.gateway.complete(root()));
    const third = await r.gateway.complete(root());
    expect(third.tool_call).toEqual({ id: "call_2", name: "python", arguments: { code: "b" } });
  });

  test("every kind comes through unchanged, raised at once with no retries", async () => {
    const kinds: ModelErrorKind[] = ["auth", "no_key", "bad_request", "rate_limit", "server", "timeout", "network", "context_window", "unknown_model", "cancelled", "other"];
    const sleeps = recordSleeps();
    try {
      for (const kind of kinds) {
        const r = await fakeRig({ root: [{ text: "x" }], errors: [{ role: "root", at: 1, kind, status: 503 }] });
        const start = Date.now();
        const err = await caught(r.gateway.complete(root()));
        expect(err.data.kind, kind).toBe(kind);
        expect(err.data.status, kind).toBe(503);
        expect(Date.now() - start, kind).toBeLessThan(1000);
      }
    } finally {
      sleeps.restore();
    }
    // A retry would have slept (RETRY.sleep) and then succeeded, since only call 1 is scripted to fail.
    expect(sleeps.delays).toEqual([]);
  });

  test("the failed call ends with the error on the bus and adds nothing to the totals", async () => {
    const r = await fakeRig({ root: [{ text: "x" }], errors: [{ role: "root", at: 1, kind: "rate_limit", status: 429 }] });
    await caught(r.gateway.complete(root()));
    const end = r.events.find((e) => e.name === "call.end")!.payload;
    expect(end.error).toMatchObject({ kind: "rate_limit", status: 429, provider: "fake", model: "scripted" });
    expect(end.usage.input_tokens).toBe(0);
    expect(r.gateway.totals(RUN_A).root.input_tokens).toBe(0);
  });
});

describe("streaming through call.delta", () => {
  const text40 = "0123456789abcdefghijklmnopqrstuvwxyzABCD";

  test("chunk_chars defaults to 16", async () => {
    const r = await fakeRig({ root: [{ text: text40 }] });
    const res = await r.gateway.complete(root());
    const d = deltas(r);
    expect(d).toEqual([text40.slice(0, 16), text40.slice(16, 32), text40.slice(32)]);
    expect(d.join("")).toBe(res.text);
  });

  test("chunk_chars sets the piece size, for root and sub-calls alike", async () => {
    const r = await fakeRig({ root: [{ text: "abcdefghijkl" }], sub: [{ text: "mnopqrstu" }], chunk_chars: 5 });
    await r.gateway.complete(root());
    await r.gateway.complete(subCall("q"));
    expect(deltas(r)).toEqual(["abcde", "fghij", "kl", "mnopq", "rstu"]);
  });

  test("a chunk size of 1, and a size longer than the text", async () => {
    const one = await fakeRig({ root: [{ text: "abc" }], chunk_chars: 1 });
    await one.gateway.complete(root());
    expect(deltas(one)).toEqual(["a", "b", "c"]);
    const big = await fakeRig({ root: [{ text: "abc" }], chunk_chars: 1000 });
    await big.gateway.complete(root());
    expect(deltas(big)).toEqual(["abc"]);
  });

  test("an empty text sends no deltas", async () => {
    const r = await fakeRig({ root: [{ text: "" }, { tool_call: { code: "x" } }] });
    await r.gateway.complete(root());
    await r.gateway.complete(root());
    expect(deltas(r)).toEqual([]);
  });

  test("the deltas belong to their call, between its call.start and call.end, and carry text only", async () => {
    const r = await fakeRig({ root: [{ text: "hello world, hello world" }], chunk_chars: 8 });
    await r.gateway.complete(root());
    const names = r.events.map((e) => e.name);
    expect(names[0]).toBe("call.start");
    expect(names.at(-1)).toBe("call.end");
    expect(names.slice(1, -1).every((n) => n === "call.delta")).toBe(true);
    const callId = r.events[0]!.payload.call_id;
    for (const e of r.events) expect(e.payload.call_id).toBe(callId);
    for (const e of r.events.filter((x) => x.name === "call.delta")) expect(Object.keys(e.payload).sort()).toEqual(["call_id", "text"]);
    expect(deltas(r, callId)).toEqual(["hello wo", "rld, hel", "lo world"]);
  });

  test("delay_ms waits between the pieces, not before the first", async () => {
    const r = await fakeRig({ root: [{ text: "abc" }], chunk_chars: 1, delay_ms: 150 });
    const times: number[] = [];
    r.bus.on("call.delta", () => times.push(Date.now()));
    const start = Date.now();
    await r.gateway.complete(root());
    const end = Date.now();
    expect(times.length).toBe(3);
    expect(times[0]! - start).toBeLessThan(100); // the first piece is not delayed
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(140);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(140);
    expect(end - start).toBeGreaterThanOrEqual(290);
  });

  test("without delay_ms there is no wait", async () => {
    const r = await fakeRig({ root: [{ text: "x".repeat(2000) }], chunk_chars: 1 });
    const start = Date.now();
    await r.gateway.complete(root());
    expect(deltas(r).length).toBe(2000);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  test("an abort during delay_ms cancels the call at once", async () => {
    const r = await fakeRig({ root: [{ text: "abcdef" }], chunk_chars: 1, delay_ms: 10_000 });
    const ac = new AbortController();
    r.bus.on("call.delta", () => ac.abort());
    const start = Date.now();
    const err = await caught(r.gateway.complete(root(), ac.signal));
    expect(Date.now() - start).toBeLessThan(2000);
    expect(err).toBeInstanceOf(ModelError);
    expect(err.data).toMatchObject({ kind: "cancelled", provider: "fake", model: "scripted" });
    expect(deltas(r)).toEqual(["a"]); // nothing after the abort
    const end = r.events.at(-1)!;
    expect(end.name).toBe("call.end");
    expect(end.payload.error.kind).toBe("cancelled");
  });

  test("cancelRun during delay_ms cancels the call too, and a signal that is already aborted never starts it", async () => {
    const r = await fakeRig({ root: [{ text: "abcdef" }, { text: "again" }], chunk_chars: 1, delay_ms: 10_000 });
    r.bus.on("call.delta", () => r.gateway.cancelRun(RUN_A));
    const err = await caught(r.gateway.complete(root(RUN_A)));
    expect(err.data.kind).toBe("cancelled");

    const pre = new AbortController();
    pre.abort();
    const before = deltas(r).length;
    const err2 = await caught(r.gateway.complete(root(RUN_B), pre.signal));
    expect(err2.data.kind).toBe("cancelled");
    expect(deltas(r).length).toBe(before);
  });
});

describe("the script file", () => {
  test("RLMH_FAKE_SCRIPT unset: kind other, `RLMH_FAKE_SCRIPT is not set`", async () => {
    const r = await plainRig();
    const err = await caught(r.gateway.complete(root()));
    expect(err).toBeInstanceOf(ModelError);
    expect(err.data).toEqual({ kind: "other", provider: "fake", model: "scripted", status: null, message: "RLMH_FAKE_SCRIPT is not set" });
    // The same for a sub-call, and for an empty variable.
    expect((await caught(r.gateway.complete(subCall("q")))).data.message).toBe("RLMH_FAKE_SCRIPT is not set");
    const empty = await plainRig({ RLMH_FAKE_SCRIPT: "" });
    expect((await caught(empty.gateway.complete(root()))).data.message).toBe("RLMH_FAKE_SCRIPT is not set");
  });

  test("a missing file: kind other, `fake script unreadable: <cause>`", async () => {
    const missing = join(dir, "no-such-script.json");
    const r = await plainRig({ RLMH_FAKE_SCRIPT: missing });
    const err = await caught(r.gateway.complete(root()));
    expect(err.data.kind).toBe("other");
    expect(err.data.status).toBeNull();
    expect(err.data.message.startsWith("fake script unreadable: ")).toBe(true);
    expect(err.data.message.length).toBeGreaterThan("fake script unreadable: ".length);
  });

  test("a file that isn't JSON is unreadable too", async () => {
    const r = await plainRig({ RLMH_FAKE_SCRIPT: scriptFile("{ this is not json") });
    const err = await caught(r.gateway.complete(root()));
    expect(err.data.kind).toBe("other");
    expect(err.data.message.startsWith("fake script unreadable: ")).toBe(true);
  });

  test("the file is read at a run's first call: later edits reach the next run, not this one", async () => {
    const file = scriptFile({ root: [{ text: "old 1" }, { text: "old 2" }] });
    const r = await rig({ env: { RLMH_FAKE_SCRIPT: file } });
    rigs.push(r);
    expect((await r.gateway.complete(root(RUN_A))).text).toBe("old 1");
    writeFileSync(file, JSON.stringify({ root: [{ text: "new 1" }, { text: "new 2" }] }));
    expect((await r.gateway.complete(root(RUN_A))).text).toBe("old 2"); // run A keeps the script it read
    expect((await r.gateway.complete(root(RUN_B))).text).toBe("new 1"); // run B reads the file afresh
  });

  test("nothing reads the variable until a fake call is made", async () => {
    const r = await plainRig({ RLMH_FAKE_SCRIPT: join(dir, "never-read.json") });
    expect(r.gateway.resolveCallFormat(FAKE, "auto")).toBe("native");
    expect(r.gateway.totals(RUN_A).root.input_tokens).toBe(0);
  });
});

describe("keys, the window and the call format", () => {
  test("an empty KeyStore works", async () => {
    const r = await fakeRig({ root: [{ text: "hi" }] });
    expect(await r.keys.list()).toEqual([]);
    expect(await r.keys.resolve("fake")).toBeNull();
    const res = await r.gateway.complete(root());
    expect(res.text).toBe("hi");
    expect(await r.keys.list()).toEqual([]);
  });

  test("a request of 400,000 characters passes the window check; one that is too long for 1,000,000 tokens does not", async () => {
    const r = await fakeRig({ root: [{ text: "ok" }, { text: "ok" }], sub: [{ text: "ok" }] });
    const big = (n: number) => params(FAKE, { messages: [{ role: "system", content: "S" }, { role: "user", content: "x".repeat(n) }] });

    const res = await r.gateway.complete(big(400_000));
    expect(res.text).toBe("ok");
    // 1 + 400,000 characters of messages and "[]" for no tools: 400,003 chars.
    expect(res.usage.input_tokens).toBe(Math.ceil(400_003 / 4));

    // About 3,000,000 characters is about 1,000,000 tokens by the gateway's estimate of ceil(chars / 3), plus max_tokens.
    const err = await caught(r.gateway.complete(big(3_000_000)));
    expect(err.data.kind).toBe("context_window");
    expect(err.data.provider).toBe("fake");

    // The window check is for root calls only.
    const longSub = sub(FAKE, "y".repeat(4_000_000), { id: "b1", index: 0, size: 1 });
    expect((await r.gateway.complete(longSub)).text).toBe("ok");
  });

  test("resolveCallFormat gives native for fake/scripted with auto, and passes fenced and native through", async () => {
    const r = await plainRig();
    expect(r.gateway.resolveCallFormat(FAKE, "auto")).toBe("native");
    expect(r.gateway.resolveCallFormat(FAKE, "native")).toBe("native");
    expect(r.gateway.resolveCallFormat(FAKE, "fenced")).toBe("fenced");
  });
});

describe("results, usage and the gateway around the fake", () => {
  test("served_model is scripted and tokens are ceil(chars / 4) at zero cost", async () => {
    const args = { code: "submit('42')" };
    const r = await fakeRig({ root: [{ text: "hello world" }, { text: "", tool_call: { code: args.code } }], sub: [{ text: "a summary of it" }] });

    const text = await r.gateway.complete(root());
    // In: "You are a test." (15) + "Question?" (9) + JSON.stringify([]) (2). Out: the text.
    expect(text.served_model).toBe("scripted");
    expect(text.usage).toEqual({
      input_tokens: Math.ceil((15 + 9 + 2) / 4),
      output_tokens: Math.ceil("hello world".length / 4),
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      reasoning_tokens: 0,
      cost_usd: 0,
    });
    expect(typeof text.seconds).toBe("number");
    expect(text.seconds).toBeGreaterThanOrEqual(0);

    // A tool call's arguments are reply characters.
    const call = await r.gateway.complete(root());
    expect(call.usage.output_tokens).toBe(Math.ceil(JSON.stringify(args).length / 4));
    expect(call.served_model).toBe("scripted");

    // A sub-call's input is its prompt.
    const prompt = "Summarize the following chunk of text, please.";
    const s = await r.gateway.complete(subCall(prompt));
    expect(s.served_model).toBe("scripted");
    expect(s.usage.input_tokens).toBe(Math.ceil((prompt.length + 2) / 4));
    expect(s.usage.output_tokens).toBe(Math.ceil("a summary of it".length / 4));
    expect(s.usage.cost_usd).toBe(0);

    const totals = r.gateway.totals(RUN_A);
    expect(totals.root.output_tokens).toBe(text.usage.output_tokens + call.usage.output_tokens);
    expect(totals.sub.input_tokens).toBe(s.usage.input_tokens);
    expect(totals.cost_usd).toBe(0);
    expect(totals.cache_hit_rate).toBe(0);
  });

  test("goes through the bus: call.start with the role and prompt, deltas, call.end with the usage", async () => {
    const r = await fakeRig({ root: [{ text: "reply text" }], sub: [{ text: "sub reply" }], chunk_chars: 4 });
    const res = await r.gateway.complete(root());
    const start = r.events[0]!;
    expect(start.name).toBe("call.start");
    expect(start.payload).toMatchObject({ run_id: RUN_A, role: "root", model: FAKE, prompt: "Question?" });
    const end = r.events.at(-1)!;
    expect(end.name).toBe("call.end");
    expect(end.payload).toMatchObject({ run_id: RUN_A, finish_reason: "stop" });
    expect(end.payload.usage).toEqual(res.usage);
    expect(end.payload.error).toBeUndefined();

    r.events.length = 0;
    await r.gateway.complete(sub(FAKE, "the sub prompt", { id: "b9", index: 2, size: 3 }, { run_id: RUN_A, subcall_id: 3, origin: { turn: 2, line: 5 } }));
    expect(r.events[0]!.payload).toMatchObject({ role: "sub", subcall_id: 3, origin: { turn: 2, line: 5 }, batch: { id: "b9", index: 2, size: 3 }, prompt: "the sub prompt" });
  });

  test("a sub-call of a batch is not held back: the fake has no caching to plan, so the batch gate is skipped", async () => {
    const restore = limits({ BATCH_COLLECT_MS: 500 });
    try {
      const r = await fakeRig({ sub: [{ text: "ok" }] });
      const start = Date.now();
      // One member of a batch of 4: on a caching provider it would wait up to BATCH_COLLECT_MS for the others.
      await r.gateway.complete(sub(FAKE, "same prompt", { id: "b1", index: 0, size: 4 }, { run_id: RUN_A }));
      expect(Date.now() - start).toBeLessThan(300);
    } finally {
      restore();
    }
  });

  test("keeps the last root request for /context", async () => {
    const r = await fakeRig({ root: [{ text: "a" }, { text: "b" }] });
    const p1 = root();
    await r.gateway.complete(p1);
    expect(r.gateway.lastRootRequest(RUN_A)).toEqual(p1);
    const p2 = params(FAKE, { run_id: RUN_A, turn: 2, messages: [{ role: "user", content: "second" }] });
    await r.gateway.complete(p2);
    expect(r.gateway.lastRootRequest(RUN_A)).toEqual(p2);
  });

  test("the in-flight cap applies to the fake: with providers.fake.max_in_flight = 1 the calls take turns", async () => {
    const script = { root: [{ text: "abc" }], chunk_chars: 1, delay_ms: 80 };
    // The slot is given back when the provider call is over, which is just before call.end goes out,
    // so the comparison is with the first call's last delta, not with its call.end.
    const order = async (cap: number) => {
      const r = await fakeRig(script, { settings: { "providers.fake.max_in_flight": cap } });
      await Promise.all([r.gateway.complete(root(RUN_A)), r.gateway.complete(root(RUN_B))]);
      const starts = r.events.filter((e) => e.name === "call.start").map((e) => e.payload.call_id as string);
      const first = starts[0]!;
      const second = starts[1]!;
      const firstLastDelta = r.events.map((e, i) => (e.name === "call.delta" && e.payload.call_id === first ? i : -1)).filter((i) => i >= 0).at(-1)!;
      const secondFirstDelta = r.events.findIndex((e) => e.name === "call.delta" && e.payload.call_id === second);
      return { firstLastDelta, secondFirstDelta };
    };
    const one = await order(1);
    expect(one.secondFirstDelta).toBeGreaterThan(one.firstLastDelta); // the second call waited for the first to finish
    const many = await order(16);
    expect(many.secondFirstDelta).toBeLessThan(many.firstLastDelta); // both ran at once
  });
});
