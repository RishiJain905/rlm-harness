// KV cache: none
// The gateway behind a Link (architecture §7.3 wiring): a fake engine on the other end of two
// in-memory streams sends model.complete and model.cancel, and the fake provider answers.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeScript } from "../../src/gateway/fake.ts";
import { Link, RpcError } from "../../src/link.ts";
import type { ModelCompleteParams, ModelCompleteResult } from "../../src/protocol.ts";
import { params, ref, rig, sub, type Rig } from "./helpers.ts";

const encoder = new TextEncoder();
const FAKE = ref("fake", "scripted");

/** A one-way byte channel: what one side writes, the other reads. */
function channel() {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
    },
  });
  return {
    readable,
    writer: {
      write(text: string) {
        ctrl.enqueue(encoder.encode(text));
      },
    },
    end() {
      ctrl.close();
    },
  };
}

const SLOW_TEXT = "x".repeat(400);
const SCRIPT: FakeScript = {
  sub: [
    { match: "^q0$", text: "answer zero" },
    { match: "^q1$", text: "answer one" },
    { match: "^q2$", text: "answer two" },
    { match: "^q3$", text: "answer three" },
    { match: "^q4$", text: "answer four" },
    { match: "^slow$", text: SLOW_TEXT },
  ],
  root: [{ text: "never served" }],
  chunk_chars: 4,
  delay_ms: 20,
  errors: [{ role: "root", at: 1, kind: "rate_limit", status: 429 }],
};

let dir: string;
let r: Rig;
let app: Link;
let engine: Link;
let close: () => void;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "rlmh-wire-"));
  const script = join(dir, "script.json");
  writeFileSync(script, JSON.stringify(SCRIPT));
  r = await rig({ env: { RLMH_FAKE_SCRIPT: script } });
  const gateway = r.gateway;

  const toEngine = channel();
  const toApp = channel();
  app = new Link(toApp.readable, toEngine.writer);
  engine = new Link(toEngine.readable, toApp.writer, { idPrefix: "e" });
  close = () => {
    toApp.end();
    toEngine.end();
  };

  // The two lines of §7.3's wiring, exactly.
  app.handle("model.complete", (p, { signal }) => gateway.complete(p, signal));
  app.onNotification("model.cancel", (p) => gateway.cancelRun(p.run_id));
});

afterEach(() => {
  close();
  r.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function complete(p: ModelCompleteParams): Promise<ModelCompleteResult> {
  return engine.request<ModelCompleteResult>("model.complete", p);
}

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (err) {
    return err as RpcError;
  }
  throw new Error("expected a rejection");
}

test("5 concurrent model.complete requests get 5 answers", async () => {
  const names = ["zero", "one", "two", "three", "four"];
  const results = await Promise.all(names.map((_, i) => complete(sub(FAKE, `q${i}`, { id: "b1", index: i, size: 5 }, { run_id: "r_wire" }))));
  expect(results.map((x) => x.text)).toEqual(names.map((n) => `answer ${n}`));
  for (const x of results) {
    expect(x).toMatchObject({ tool_call: null, finish_reason: "stop", served_model: "scripted" });
    expect(x.usage.input_tokens).toBeGreaterThan(0);
    expect(typeof x.seconds).toBe("number");
  }
  expect(r.gateway.totals("r_wire").sub.output_tokens).toBe(results.reduce((n, x) => n + x.usage.output_tokens, 0));
});

test("a scripted error comes back as RpcError -32001 with data.kind", async () => {
  const err = await rejection(complete(params(FAKE, { run_id: "r_err" })));
  expect(err).toBeInstanceOf(RpcError);
  expect(err.code).toBe(-32001);
  expect(err.data).toMatchObject({ kind: "rate_limit", provider: "fake", model: "scripted", status: 429 });
  expect(err.message).toBe("fake script error: rate_limit at root call 1");
});

test("model.cancel makes a slow call fail with kind cancelled", async () => {
  let deltas = 0;
  r.bus.on("call.delta", () => (deltas += 1));
  const t0 = Date.now();
  const slow = complete(sub(FAKE, "slow", { id: "b2", index: 0, size: 1 }, { run_id: "r_slow" }));
  // A call on another run keeps going.
  const other = complete(sub(FAKE, "q1", { id: "b3", index: 0, size: 1 }, { run_id: "r_other" }));
  const deadline = Date.now() + 3000;
  while (deltas < 2 && Date.now() < deadline) await Bun.sleep(5);
  expect(deltas).toBeGreaterThanOrEqual(2);
  engine.notify("model.cancel", { run_id: "r_slow" });
  const err = await rejection(slow);
  expect(err.code).toBe(-32001);
  expect(err.data).toMatchObject({ kind: "cancelled", message: "The call was cancelled." });
  // The whole slow text would take about 100 chunks * 20 ms.
  expect(Date.now() - t0).toBeLessThan(1500);
  expect((await other).text).toBe("answer one");
});
