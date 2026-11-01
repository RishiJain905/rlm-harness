// KV cache: none
// A stream that stops is not an answer (a timeout or a cancel after content began, a connection that closed with no
// finish event), the byte limit on a reply, and the SDKs' ambient custom-header variables. Every retrying test records sleeps.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { LIMITS, ModelError } from "../../src/gateway/gateway.ts";
import type { ModelCompleteParams } from "../../src/protocol.ts";
import { anthropicPartial, anthropicStream, endMidStream, httpError, openaiPartial, openaiStream, stallMidStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { caught, KEYS, limits, params, recordSleeps, ref, rig, type Rig } from "./helpers.ts";

/** Both wire formats: how each one's stream looks after some content, and when it is whole. */
const WIRES = [
  { name: "openai", keyId: "openai", model: ref("openai", "gpt-4.1"), provider: "OpenAI", partial: openaiPartial, full: (text: string) => openaiStream({ text }) },
  { name: "anthropic", keyId: "anthropic", model: ref("anthropic", "claude-haiku-4-5"), provider: "Anthropic", partial: anthropicPartial, full: (text: string) => anthropicStream({ text }) },
] as const;

let server: FakeServer;
let sleeps: ReturnType<typeof recordSleeps>;
const rigs: Rig[] = [];
const restores: (() => void)[] = [];

beforeAll(() => {
  server = startFakeProvider();
});
afterAll(() => {
  server.stop();
});
beforeEach(() => {
  server.requests.length = 0;
  sleeps = recordSleeps();
});
afterEach(() => {
  sleeps.restore();
  for (const restore of restores.splice(0)) restore();
  for (const r of rigs.splice(0)) r.cleanup();
});

async function make(opts: Parameters<typeof rig>[0] = {}): Promise<Rig> {
  const r = await rig({ server, ...opts });
  rigs.push(r);
  return r;
}

async function fails(r: Rig, p: ModelCompleteParams, signal?: AbortSignal): Promise<ModelError> {
  const err = await caught(r.gateway.complete(p, signal));
  expect(err).toBeInstanceOf(ModelError);
  return err as ModelError;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await Bun.sleep(2);
  }
}

const deltas = (r: Rig) => r.events.filter((e) => e.name === "call.delta").map((e) => e.payload);
const ends = (r: Rig) => r.events.filter((e) => e.name === "call.end").map((e) => e.payload);

describe("a stream cut short is not an answer", () => {
  for (const w of WIRES) {
    test(`${w.name}: an idle timeout after content is a timeout, retried whole`, async () => {
      restores.push(limits({ IDLE_TIMEOUT_MS: 60 }));
      const r = await make({ keys: [w.keyId] });
      server.script([() => stallMidStream(w.partial("partial ")), () => w.full("full answer")]);
      const res = await r.gateway.complete(params(w.model));
      expect(res.text).toBe("full answer");
      expect(sleeps.delays).toEqual([2000]);
      expect(server.requests).toHaveLength(2);
      const d = deltas(r);
      expect(d[0]).toMatchObject({ text: "partial " }); // the content really arrived before the abort
      expect(d[1]).toEqual({ call_id: d[0].call_id, reset: true });
      expect(d.slice(2).map((x) => x.text).join("")).toBe("full answer");
      expect(ends(r)).toHaveLength(1);
    });

    test(`${w.name}: an idle timeout after content, on every try, gives timeout and no result`, async () => {
      restores.push(limits({ IDLE_TIMEOUT_MS: 60 }));
      const r = await make({ keys: [w.keyId] });
      server.script(() => stallMidStream(w.partial("partial ")));
      const err = await fails(r, params(w.model));
      expect(err.message).toBe(`${w.provider} did not answer in time after 7 tries.`);
      expect(err.data).toMatchObject({ kind: "timeout", status: null });
      expect(server.requests).toHaveLength(7);
      expect(sleeps.delays).toHaveLength(6);
      expect(deltas(r).filter((x) => x.text === "partial ")).toHaveLength(7);
      expect(ends(r)).toHaveLength(1);
      expect(ends(r)[0].error.kind).toBe("timeout");
    });

    test(`${w.name}: the total timeout after content is a timeout too`, async () => {
      restores.push(limits({ TOTAL_TIMEOUT_MS: 150 }));
      const r = await make({ keys: [w.keyId] });
      server.script(() => (w.name === "openai" ? openaiStream({ text: "x".repeat(8 * 60), chunkDelayMs: 30 }) : anthropicStream({ text: "x".repeat(8 * 60), chunkDelayMs: 30 })));
      const err = await fails(r, params(w.model));
      expect(err.data).toMatchObject({ kind: "timeout", status: null });
      expect(server.requests).toHaveLength(7);
      expect(deltas(r).some((x) => typeof x.text === "string")).toBe(true); // content came in before each cut
    });

    for (const way of ["cancelRun", "signal"] as const) {
      test(`${w.name}: ${way} after content began is cancelled, not a result`, async () => {
        const r = await make({ keys: [w.keyId] });
        server.script(() => stallMidStream(w.partial("partial ")));
        const ac = new AbortController();
        const call = r.gateway.complete(params(w.model, { run_id: "r_cancelafter" }), ac.signal);
        await until(() => deltas(r).some((x) => x.text === "partial "));
        const t0 = Date.now();
        if (way === "cancelRun") r.gateway.cancelRun("r_cancelafter");
        else ac.abort();
        const err = await caught(call);
        expect(err).toBeInstanceOf(ModelError);
        expect(err.data).toMatchObject({ kind: "cancelled", status: null, message: "The call was cancelled." });
        expect(Date.now() - t0).toBeLessThan(1000);
        expect(server.requests).toHaveLength(1);
        expect(sleeps.delays).toEqual([]);
        expect(ends(r)).toHaveLength(1);
        expect(ends(r)[0].error.kind).toBe("cancelled");
        expect(r.gateway.totals("r_cancelafter").root.output_tokens).toBe(0); // nothing was counted as a finished call
      });
    }

    test(`${w.name}: a connection that closes with no finish event is retried whole`, async () => {
      const r = await make({ keys: [w.keyId] });
      server.script([() => endMidStream(w.partial("partial ")), () => w.full("full answer")]);
      const res = await r.gateway.complete(params(w.model));
      expect(res.text).toBe("full answer");
      expect(sleeps.delays).toEqual([2000]);
      const d = deltas(r);
      expect(d[0]).toMatchObject({ text: "partial " });
      expect(d[1]).toEqual({ call_id: d[0].call_id, reset: true });
    });

    test(`${w.name}: a connection that always closes with no finish event fails as a network error`, async () => {
      const r = await make({ keys: [w.keyId] });
      server.script(() => endMidStream(w.partial("partial ")));
      const err = await fails(r, params(w.model));
      expect(err.data).toMatchObject({ kind: "network", status: null });
      expect(err.message).toMatch(new RegExp(`^Could not reach ${w.provider} at \\S+ after 7 tries: the stream ended before the provider sent its finish event$`));
      expect(server.requests).toHaveLength(7);
    });
  }

  test("an Anthropic stream that has its stop_reason but lost message_stop is whole", async () => {
    const r = await make({ keys: ["anthropic"] });
    const delta = `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`;
    server.script(() => endMidStream(anthropicPartial("complete") + delta));
    const res = await r.gateway.complete(params(ref("anthropic", "claude-haiku-4-5")));
    expect(res).toMatchObject({ text: "complete", finish_reason: "stop" });
    expect(server.requests).toHaveLength(1);
  });

  test("an OpenAI stream whose finish_reason came but whose [DONE] did not is whole", async () => {
    const r = await make({ keys: ["openai"] });
    const finish = `data: ${JSON.stringify({ model: "served-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`;
    server.script(() => endMidStream(openaiPartial("complete") + finish));
    const res = await r.gateway.complete(params(ref("openai", "gpt-4.1")));
    expect(res).toMatchObject({ text: "complete", finish_reason: "stop" });
    expect(server.requests).toHaveLength(1);
  });
});

describe("the byte limit on a reply", () => {
  const MULTI = "é".repeat(600); // 600 characters, 1200 bytes

  test("limits are named constants with generous values", () => {
    expect(LIMITS.MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024);
    expect(LIMITS.MAX_MODEL_LIST_BYTES).toBe(16 * 1024 * 1024);
  });

  test("a reply at the limit passes, one byte over fails: bytes are counted, not characters", async () => {
    restores.push(limits({ MAX_RESPONSE_BYTES: 1200 }));
    const r = await make({ keys: ["openai"] });
    server.script(() => openaiStream({ text: MULTI }));
    expect((await r.gateway.complete(params(ref("openai", "gpt-4.1")))).text).toBe(MULTI);
    server.script(() => openaiStream({ text: `${MULTI}x` }));
    const err = await fails(r, params(ref("openai", "gpt-4.1")));
    expect(err.data).toMatchObject({ kind: "other", status: null });
    expect(err.message).toBe("OpenAI returned a stream that could not be read: the reply grew past the limit of 1200 bytes and was cut off");
  });

  test("openai: text, reasoning and tool arguments all count, together, and the call is not retried", async () => {
    restores.push(limits({ MAX_RESPONSE_BYTES: 1000 }));
    const r = await make({ keys: ["openai"] });
    const model = ref("openai", "gpt-4.1");
    const cases: Record<string, () => Response> = {
      text: () => openaiStream({ text: "x".repeat(5000) }),
      reasoning: () => openaiStream({ reasoning: "x".repeat(5000), text: "ok" }),
      "tool arguments": () => openaiStream({ toolCall: { arguments: JSON.stringify({ code: "x".repeat(5000) }) } }),
      "text and reasoning, each under the limit": () => openaiStream({ reasoning: "r".repeat(600), text: "t".repeat(600) }),
    };
    for (const [name, make_] of Object.entries(cases)) {
      server.requests.length = 0;
      server.script(make_);
      const err = await fails(r, params(model));
      expect(err.data.kind, name).toBe("other");
      expect(err.message, name).toContain("the reply grew past the limit of 1000 bytes");
      expect(server.requests, name).toHaveLength(1);
    }
    expect(sleeps.delays).toEqual([]);
  });

  test("anthropic: text, thinking and tool arguments all count, and the call is not retried", async () => {
    restores.push(limits({ MAX_RESPONSE_BYTES: 1000 }));
    const r = await make({ keys: ["anthropic"] });
    const model = ref("anthropic", "claude-haiku-4-5");
    const cases: Record<string, () => Response> = {
      text: () => anthropicStream({ text: "x".repeat(5000) }),
      thinking: () => anthropicStream({ reasoning: "x".repeat(5000), text: "ok" }),
      "tool arguments": () => anthropicStream({ toolCall: { arguments: JSON.stringify({ code: "x".repeat(5000) }) } }),
      "thinking and text, each under the limit": () => anthropicStream({ reasoning: "r".repeat(600), text: "t".repeat(600) }),
    };
    for (const [name, make_] of Object.entries(cases)) {
      server.requests.length = 0;
      server.script(make_);
      const err = await fails(r, params(model));
      expect(err.data.kind, name).toBe("other");
      expect(err.message, name).toContain("the reply grew past the limit of 1000 bytes");
      expect(server.requests, name).toHaveLength(1);
    }
    expect(sleeps.delays).toEqual([]);
  });

  for (const w of WIRES) {
    test(`${w.name}: going over aborts the request at once, without waiting for the server or a timeout`, async () => {
      restores.push(limits({ MAX_RESPONSE_BYTES: 1000 }));
      const r = await make({ keys: [w.keyId] });
      const big = w.name === "openai" ? openaiPartial("x".repeat(5000)) : anthropicPartial("x".repeat(5000));
      server.script(() => stallMidStream(big)); // the server never finishes; the default idle timeout is 3 minutes
      const t0 = Date.now();
      const err = await fails(r, params(w.model));
      expect(err.message).toContain("the reply grew past the limit of 1000 bytes");
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(server.requests).toHaveLength(1);
    });
  }
});

describe("ambient header variables", () => {
  const NAMES = ["OPENAI_CUSTOM_HEADERS", "ANTHROPIC_CUSTOM_HEADERS"] as const;
  const saved = new Map<string, string | undefined>();
  const OPENAI_VALUE = "x-corp-token: FAKE-corp-token\nauthorization: Bearer FAKE-corp-bearer\nx-openai-extra: FAKE-extra";
  const ANTHROPIC_VALUE = "x-corp-token: FAKE-corp-token\nauthorization: Bearer FAKE-corp-bearer\nx-api-key: FAKE-corp-key\nanthropic-version: 1999-01-01";

  beforeEach(() => {
    for (const name of NAMES) saved.set(name, process.env[name]);
    process.env.OPENAI_CUSTOM_HEADERS = OPENAI_VALUE;
    process.env.ANTHROPIC_CUSTOM_HEADERS = ANTHROPIC_VALUE;
  });
  afterEach(() => {
    for (const name of NAMES) {
      const was = saved.get(name);
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  });

  test("no provider's request carries them, and the variables are back afterwards", async () => {
    const r = await make({ keys: ["openai", "anthropic", "deepseek"] });
    server.script((q) => (q.path.includes("/models") ? Response.json({ data: [{ id: "model-a" }] }) : q.path.startsWith("/v1/messages") ? anthropicStream({ text: "ok" }) : openaiStream({ text: "ok" })));
    await r.gateway.complete(params(ref("openai", "gpt-4.1")));
    await r.gateway.complete(params(ref("deepseek", "deepseek-v4-pro")));
    await r.gateway.complete(params(ref("local", "qwen"))); // a local server: no key, its own base URL
    await r.gateway.refreshModels("openai");
    await r.gateway.complete(params(ref("anthropic", "claude-haiku-4-5")));
    await r.gateway.refreshModels("anthropic");

    expect(server.requests).toHaveLength(6);
    for (const q of server.requests) {
      const where = `${q.headers["x-orig-host"]}${q.path}`;
      expect(q.headers["x-corp-token"], where).toBeUndefined();
      expect(q.headers["x-openai-extra"], where).toBeUndefined();
      expect(JSON.stringify(q.headers), where).not.toContain("FAKE-corp");
    }
    const [openai, deepseek, local, , anthropic] = server.requests;
    expect(openai!.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(deepseek!.headers.authorization).toBe(`Bearer ${KEYS.deepseek}`);
    expect(local!.headers.authorization).toBe("Bearer none");
    expect(anthropic!.headers.authorization).toBe(`Bearer ${KEYS.anthropic}`); // the SDK's own way to send the key
    expect(anthropic!.headers["x-api-key"]).toBeUndefined();
    expect(anthropic!.headers["anthropic-version"]).toBe("2023-06-01");

    expect(process.env.OPENAI_CUSTOM_HEADERS).toBe(OPENAI_VALUE);
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(ANTHROPIC_VALUE);
  });

  test("an unset variable stays unset", async () => {
    delete process.env.OPENAI_CUSTOM_HEADERS;
    delete process.env.ANTHROPIC_CUSTOM_HEADERS;
    const r = await make({ keys: ["openai"] });
    server.script(() => openaiStream({ text: "ok" }));
    await r.gateway.complete(params(ref("openai", "gpt-4.1")));
    expect("OPENAI_CUSTOM_HEADERS" in process.env).toBe(false);
    expect("ANTHROPIC_CUSTOM_HEADERS" in process.env).toBe(false);
  });
});
