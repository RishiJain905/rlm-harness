// KV cache: none
// The link (step 2): the same cases as engine/tests/test_link.py, plus chunking, abort and
// listeners, and the bus. A raw peer writes bytes and reads lines; two Links are wired by
// stream pairs, the fake engine with idPrefix "e".

import { describe, expect, spyOn, test } from "bun:test";
import { Bus } from "../src/bus.ts";
import { classify, Link, MAX_LINE_BYTES, MESSAGE_TOO_LARGE, RpcError } from "../src/link.ts";

const encoder = new TextEncoder();

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
    bytes(data: Uint8Array) {
      ctrl.enqueue(data);
    },
    end() {
      ctrl.close();
    },
  };
}

/** The test's raw end of a Link. */
class Peer {
  readonly toLink = channel();
  readonly written: string[] = []; // every chunk the link wrote
  private buf = "";
  private readonly lines: string[] = [];
  readonly output = {
    write: (text: string) => {
      this.written.push(text);
      this.buf += text;
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) >= 0) {
        this.lines.push(this.buf.slice(0, nl));
        this.buf = this.buf.slice(nl + 1);
      }
    },
  };

  link(opts: { idPrefix?: string; maxLineBytes?: number; maxSendBytes?: number } = {}): Link {
    return new Link(this.toLink.readable, this.output, opts);
  }

  send(msg: object | string | Uint8Array): void {
    if (msg instanceof Uint8Array) this.toLink.bytes(msg);
    else this.toLink.bytes(encoder.encode(typeof msg === "string" ? msg : `${JSON.stringify(msg)}\n`));
  }

  async recvLine(timeoutMs = 2000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (this.lines.length === 0) {
      if (Date.now() > deadline) throw new Error("no line from the link");
      await Bun.sleep(1);
    }
    return this.lines.shift()!;
  }

  async recv(timeoutMs = 2000): Promise<any> {
    return JSON.parse(await this.recvLine(timeoutMs));
  }

  async silent(ms = 100): Promise<boolean> {
    await Bun.sleep(ms);
    return this.lines.length === 0;
  }
}

/** Two Links wired back to back: the app side (integer ids) and a fake engine (ids e1, e2, …). */
function linkedPair() {
  const toEngine = channel();
  const toApp = channel();
  const app = new Link(toApp.readable, toEngine.writer);
  const engine = new Link(toEngine.readable, toApp.writer, { idPrefix: "e" });
  return { app, engine, close: () => (toApp.end(), toEngine.end()) };
}

const echo = async (params: unknown) => params;

/** The error a promise rejects with; fails if it resolves. */
async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (err) {
    return err as RpcError;
  }
  throw new Error("expected a rejection");
}

function captureStderr() {
  const lines: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
    lines.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  return { lines, restore: () => spy.mockRestore() };
}

describe("link", () => {
  test("request_result", async () => {
    const peer = new Peer();
    const link = peer.link();
    link.handle("echo", echo);
    link.handle("nothing", async () => undefined);
    peer.send({ jsonrpc: "2.0", id: 1, method: "echo", params: { a: [1, "x"] } });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 1, result: { a: [1, "x"] } });
    peer.send({ jsonrpc: "2.0", id: "s-1", method: "nothing", params: {} });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: "s-1", result: null });
    peer.send({ jsonrpc: "2.0", id: 2, method: "echo" }); // no params means {}
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 2, result: {} });

    const { app, engine, close } = linkedPair();
    engine.handle("engine.info", async () => ({ protocol: 1 }));
    expect(await app.request("engine.info", {})).toEqual({ protocol: 1 });
    close();
  });

  test("errors", async () => {
    const peer = new Peer();
    const link = peer.link();
    link.handle("echo", echo);
    link.handle("bad_input", async () => {
      throw new RpcError(-32012, "missing input", { field: "inputs" });
    });
    link.handle("broken", async () => {
      throw new Error("boom");
    });
    const expectError = async (line: object | string | Uint8Array, id: unknown, code: number, message?: string) => {
      peer.send(line);
      const msg = await peer.recv();
      expect(msg.jsonrpc).toBe("2.0");
      expect(msg.id).toEqual(id);
      expect(msg.error.code).toBe(code);
      if (message !== undefined) expect(msg.error.message).toBe(message);
      peer.send({ jsonrpc: "2.0", id: 99, method: "echo", params: { still: "serving" } });
      expect((await peer.recv()).result).toEqual({ still: "serving" });
      return msg.error;
    };
    await expectError({ jsonrpc: "2.0", id: 3, method: "nope" }, 3, -32601, "method not found: nope");
    await expectError("[1, 2]\n", null, -32600);
    await expectError('{"id": 4, "method":\n', null, -32700);
    await expectError(new Uint8Array([...encoder.encode('{"id": 5, "method": "echo", "params": {"a": "'), 0xff, ...encoder.encode('"}}\n')]), null, -32700);
    await expectError({ jsonrpc: "2.0", id: 6, method: "echo", params: [1] }, 6, -32602, "params must be an object");
    await expectError({ jsonrpc: "2.0", id: 7, result: 1, error: { code: 1, message: "x" } }, 7, -32600);
    const err = await expectError({ jsonrpc: "2.0", id: 8, method: "bad_input" }, 8, -32012, "missing input");
    expect(err.data).toEqual({ field: "inputs" });
    await expectError({ jsonrpc: "2.0", id: 9, method: "broken" }, 9, -32603, "internal error: Error: boom");
  });

  test("envelope_must_be_jsonrpc_2", async () => {
    const note = { jsonrpc: "2.0", method: "m" };
    expect(classify({ jsonrpc: "2.0", id: 1, method: "m" })).toBe("request");
    expect(classify(note)).toBe("notification");
    expect(classify({ jsonrpc: "2.0", id: 1, result: null })).toBe("result");
    expect(classify({ jsonrpc: "2.0", id: null, error: { code: -1, message: "x" } })).toBe("error");
    for (const bad of [
      { id: 1, method: "m" }, // jsonrpc missing
      { jsonrpc: "1.0", id: 1, method: "m" },
      { jsonrpc: 2, id: 1, method: "m" },
      { jsonrpc: "2.0 ", id: 1, method: "m" },
      { method: "m" },
      { id: 1, result: null },
      { id: 1, error: { code: -1, message: "x" } },
      { jsonrpc: "2.0", id: 1, method: "m", result: null }, // method mixed with a response field
      { jsonrpc: "2.0", id: 1, method: "m", error: { code: -1, message: "x" } },
      { ...note, result: 1 },
      { ...note, error: null },
      { jsonrpc: "2.0", id: 1, result: null, error: { code: -1, message: "x" } },
    ]) {
      expect(classify(bad)).toBe("invalid");
    }

    // on the wire: answered with -32600 (the id when it has one), never dispatched, and the link keeps serving
    const peer = new Peer();
    const link = peer.link();
    const seen: string[] = [];
    link.handle("echo", async (p) => (seen.push("echo"), p));
    link.onNotification("note", () => seen.push("note"));
    const call = link.request("m", {});
    const req = await peer.recv();
    for (const [msg, id] of [
      [{ id: 11, method: "echo", params: {} }, 11],
      [{ jsonrpc: "1.0", id: 12, method: "echo", params: {} }, 12],
      [{ jsonrpc: "2.0", id: 13, method: "echo", params: {}, result: 1 }, 13],
      [{ jsonrpc: "2.0", method: "note", params: {}, error: { code: -1, message: "x" } }, null],
      [{ id: req.id, result: "no jsonrpc" }, req.id],
    ] as const) {
      peer.send(msg);
      const reply = await peer.recv();
      expect([reply.id, reply.error?.code]).toEqual([id, -32600]);
    }
    expect(seen).toEqual([]);
    peer.send({ jsonrpc: "2.0", id: req.id, result: "good" }); // the pending request was not answered by the bad one
    expect(await call).toBe("good");
  });

  test("oversized_messages_fail_locally", async () => {
    const peer = new Peer();
    const link = peer.link({ maxSendBytes: 1024 });
    link.handle("big", async () => "x".repeat(2000));
    link.handle("bigerror", async () => {
      throw new RpcError(-32001, "too big", { blob: "x".repeat(2000) });
    });
    link.handle("echo", echo);

    // a request: rejected here, with a structured error, and nothing is written. Bytes count, not UTF-16 units.
    const err = await rejection(link.request("m", { s: "😀".repeat(300) })); // about 620 units, 1200 bytes
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(-32600);
    expect(err.data).toMatchObject({ kind: MESSAGE_TOO_LARGE, method: "m", limit: 1024 });
    expect((err.data as { bytes: number }).bytes).toBeGreaterThan(1200);
    expect(await peer.silent()).toBe(true);
    const small = link.request("m", { s: "😀".repeat(100) }); // 400 bytes: fits, and takes id 1: the refusal used none
    const req = await peer.recv();
    expect(req.id).toBe(1);
    peer.send({ jsonrpc: "2.0", id: req.id, result: "ok" });
    expect(await small).toBe("ok");

    // a reply: the peer's request gets a small error with its id, not silence
    peer.send({ jsonrpc: "2.0", id: 5, method: "big", params: {} });
    const reply = await peer.recv();
    expect(reply).toMatchObject({ jsonrpc: "2.0", id: 5, error: { code: -32603, data: { kind: MESSAGE_TOO_LARGE, limit: 1024 } } });
    expect(reply.error.data.bytes).toBeGreaterThan(2000);
    expect(JSON.stringify(reply).length).toBeLessThan(1024);
    peer.send({ jsonrpc: "2.0", id: 6, method: "bigerror", params: {} });
    expect(await peer.recv()).toMatchObject({ id: 6, error: { code: -32603, data: { kind: MESSAGE_TOO_LARGE } } });
    peer.send({ jsonrpc: "2.0", id: 7, method: "echo", params: { still: "serving" } });
    expect((await peer.recv()).result).toEqual({ still: "serving" });

    // a notification: dropped and logged, nobody waits for it
    const stderr = captureStderr();
    try {
      link.notify("note", { s: "x".repeat(2000) });
    } finally {
      stderr.restore();
    }
    expect(stderr.lines.join("")).toContain("notification note dropped");
    expect(await peer.silent()).toBe(true);
    link.notify("note", { s: "short" });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", method: "note", params: { s: "short" } });
  });

  test("the_send_limit_defaults_to_the_read_limit", async () => {
    const peer = new Peer();
    const link = peer.link();
    const err = await rejection(link.request("m", { s: "x".repeat(MAX_LINE_BYTES) }));
    expect([err.code, (err.data as { limit: number }).limit]).toEqual([-32600, MAX_LINE_BYTES]);
    expect(await peer.silent()).toBe(true);
  });

  test("notification_no_reply", async () => {
    const peer = new Peer();
    const link = peer.link();
    const seen: number[] = [];
    link.onNotification("note", (p) => seen.push(p.n));
    link.handle("echo", echo);
    for (let n = 0; n < 5; n++) peer.send({ jsonrpc: "2.0", method: "note", params: { n } });
    peer.send({ jsonrpc: "2.0", id: 1, method: "echo", params: {} });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(seen).toEqual([0, 1, 2, 3, 4]);
    expect(await peer.silent()).toBe(true);
  });

  test("both_ways_interleaved", async () => {
    const peer = new Peer();
    const link = peer.link();
    link.handle("a", async () => ({ a: await link.request("model.complete", { q: "from A" }) }));
    link.handle("b", async () => "B");
    peer.send({ jsonrpc: "2.0", id: 1, method: "a", params: {} });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 1, method: "model.complete", params: { q: "from A" } });
    peer.send({ jsonrpc: "2.0", id: 2, method: "b", params: {} });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 2, result: "B" });
    peer.send({ jsonrpc: "2.0", id: 1, result: "pong" });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 1, result: { a: "pong" } });

    // the same dance between two Links: engine.info calls back into the app
    const { app, engine, close } = linkedPair();
    engine.handle("engine.info", async () => ({ via: await engine.request("model.complete", { n: 1 }) }));
    app.handle("model.complete", async (p) => `pong ${p.n}`);
    expect(await app.request("engine.info", {})).toEqual({ via: "pong 1" });
    close();
  });

  test("slow_handler_does_not_block", async () => {
    const peer = new Peer();
    const link = peer.link();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    link.handle("slow", async () => {
      await gate;
      return "slow";
    });
    link.handle("fast", async () => "fast");
    peer.send({ jsonrpc: "2.0", id: 1, method: "slow", params: {} });
    peer.send({ jsonrpc: "2.0", id: 2, method: "fast", params: {} });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 2, result: "fast" });
    release();
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 1, result: "slow" });
  });

  test("concurrent_requests", async () => {
    const peer = new Peer();
    const link = peer.link({ idPrefix: "e" });
    const calls = Array.from({ length: 20 }, (_, i) => link.request("m", { i }));
    const requests = [];
    for (let i = 0; i < 20; i++) requests.push(await peer.recv());
    expect(requests.map((r) => r.id)).toEqual(Array.from({ length: 20 }, (_, i) => `e${i + 1}`));
    for (const req of requests.reverse()) peer.send({ jsonrpc: "2.0", id: req.id, result: req.params.i * 10 });
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 20 }, (_, i) => i * 10));
  });

  test("error_response_raises", async () => {
    const peer = new Peer();
    const link = peer.link();
    const call = link.request("m", {});
    const req = await peer.recv();
    peer.send({ jsonrpc: "2.0", id: req.id, error: { code: -32001, message: "no", data: { kind: "auth" } } });
    const err = await rejection(call);
    expect(err).toBeInstanceOf(RpcError);
    expect([err.code, err.message, err.data]).toEqual([-32001, "no", { kind: "auth" }]);
  });

  test("utf8_and_long_lines", async () => {
    const text = `é 😀   a\r\nb ${"x".repeat(2 * 1024 * 1024)}`;
    const peer = new Peer();
    const link = peer.link();
    link.handle("echo", echo);
    link.handle("surrogate", async () => "\ud800");

    peer.send({ jsonrpc: "2.0", id: 1, method: "echo", params: { s: text } });
    const line = await peer.recvLine();
    expect(line).toContain("é 😀  "); // raw characters, not escapes
    expect(JSON.parse(line).result.s).toBe(text);

    const call = link.request("echo", { s: text });
    const req = await peer.recv();
    expect(req.params.s).toBe(text);
    peer.send({ jsonrpc: "2.0", id: req.id, result: req.params.s });
    expect(await call).toBe(text);

    peer.send({ jsonrpc: "2.0", id: 2, method: "surrogate", params: {} });
    const surrogate = await peer.recvLine();
    expect(surrogate).toContain("\\ud800");
    expect(JSON.parse(surrogate).result).toBe("\ud800");

    expect(peer.written.some((chunk) => chunk.includes("\r"))).toBe(false); // no 0x0D byte is ever written
  });

  test("line_too_long", async () => {
    const peer = new Peer();
    const link = peer.link({ maxLineBytes: 1024 });
    link.handle("echo", echo);
    peer.send(`{"jsonrpc": "2.0", "id": 1, "method": "echo", "params": {"s": "${"x".repeat(2000)}"}}\n`);
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "line too long (over 1024 bytes)" } });
    peer.send({ jsonrpc: "2.0", id: 2, method: "echo", params: { ok: true } });
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 2, result: { ok: true } });
  });

  test("eof", async () => {
    const peer = new Peer();
    const link = peer.link();
    let signal!: AbortSignal;
    let started!: () => void;
    const running = new Promise<void>((resolve) => (started = resolve));
    link.handle("hang", (_p, ctx) => {
      signal = ctx.signal;
      started();
      return new Promise(() => {});
    });
    peer.send({ jsonrpc: "2.0", id: 1, method: "hang", params: {} });
    await running;
    const pending = link.request("m", {});
    await peer.recv();
    peer.toLink.end();
    await link.closed;
    expect((await rejection(pending)).code).toBe(-32800);
    expect(signal.aborted).toBe(true);
    const after = await rejection(link.request("m", {}));
    expect([after.code, after.message]).toEqual([-32800, "link closed"]);
    link.notify("dropped", {}); // no error
    expect(await peer.silent()).toBe(true);
  });

  test("notify", async () => {
    const peer = new Peer();
    const link = peer.link();
    for (let i = 0; i < 50; i++) link.notify("tick", { i });
    for (let i = 0; i < 50; i++) expect(await peer.recv()).toEqual({ jsonrpc: "2.0", method: "tick", params: { i } });
  });

  test("split_chunks", async () => {
    const peer = new Peer();
    const link = peer.link();
    link.handle("echo", echo);
    const bytes = encoder.encode(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "echo", params: { s: "é😀" } })}\n`);
    const cut = bytes.indexOf(0xf0) + 2; // inside the emoji's four bytes
    peer.send(bytes.slice(0, cut));
    await Bun.sleep(5);
    peer.send(bytes.slice(cut));
    expect(await peer.recv()).toEqual({ jsonrpc: "2.0", id: 1, result: { s: "é😀" } });
    peer.send(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "echo", params: { n: 2 } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "echo", params: { n: 3 } })}\n`);
    expect((await peer.recv()).id).toBe(2);
    expect((await peer.recv()).id).toBe(3);
  });

  test("abort_and_close", async () => {
    const peer = new Peer();
    const link = peer.link();
    const ac = new AbortController();
    const call = link.request("m", {}, { signal: ac.signal });
    const req = await peer.recv();
    ac.abort();
    const err = await rejection(call);
    expect([err.code, err.message]).toEqual([-32800, "cancelled"]);
    peer.send({ jsonrpc: "2.0", id: req.id, result: "late" }); // ignored
    const pre = new AbortController();
    pre.abort();
    expect((await rejection(link.request("m", {}, { signal: pre.signal }))).code).toBe(-32800);
    expect(await peer.silent()).toBe(true); // an aborted signal sends nothing

    let signal!: AbortSignal;
    link.handle("hang", (_p, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    });
    peer.send({ jsonrpc: "2.0", id: 5, method: "hang", params: {} });
    await Bun.sleep(5);
    link.close();
    await link.closed;
    expect(signal.aborted).toBe(true);
    expect((await rejection(link.request("m", {}))).code).toBe(-32800);
  });

  test("notification_listeners", async () => {
    const peer = new Peer();
    const link = peer.link();
    const all: [string, unknown][] = [];
    const ticks: unknown[] = [];
    link.onNotification("*", (method, params) => all.push([method, params]));
    const off = link.onNotification("tick", (p) => ticks.push(p));
    link.onNotification("boom", () => {
      throw new Error("listener failed");
    });
    const after: unknown[] = [];
    link.onNotification("boom", (p) => after.push(p));
    link.handle("echo", echo);
    const stderr = captureStderr();
    try {
      peer.send({ jsonrpc: "2.0", method: "tick", params: { n: 1 } });
      peer.send({ jsonrpc: "2.0", method: "boom", params: { n: 2 } });
      peer.send({ jsonrpc: "2.0", id: 1, method: "echo", params: {} });
      await peer.recv();
      off();
      peer.send({ jsonrpc: "2.0", method: "tick", params: { n: 3 } });
      peer.send({ jsonrpc: "2.0", id: 2, method: "echo", params: {} });
      await peer.recv();
    } finally {
      stderr.restore();
    }
    expect(all).toEqual([
      ["tick", { n: 1 }],
      ["boom", { n: 2 }],
      ["tick", { n: 3 }],
    ]);
    expect(ticks).toEqual([{ n: 1 }]);
    expect(after).toEqual([{ n: 2 }]);
    expect(stderr.lines.join("")).toContain("listener failed");
  });
});

describe("bus", () => {
  test("bus", () => {
    type Events = { ping: { n: number }; other: string };
    const bus = new Bus<Events>();
    const got: number[] = [];
    const off = bus.on("ping", (p) => got.push(p.n));
    bus.on("ping", () => {
      throw new Error("bad listener");
    });
    const later: number[] = [];
    bus.on("ping", (p) => later.push(p.n));
    const stderr = captureStderr();
    try {
      bus.emit("ping", { n: 1 });
      off();
      bus.emit("ping", { n: 2 });
      bus.emit("other", "no listeners");
    } finally {
      stderr.restore();
    }
    expect(got).toEqual([1]);
    expect(later).toEqual([1, 2]);
    expect(stderr.lines.join("")).toContain("bad listener");
  });
});
