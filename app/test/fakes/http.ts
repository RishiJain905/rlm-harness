// KV cache: none
// A fake provider HTTP server for the gateway tests (step 5; steps 6 and 7 may reuse it):
// Bun.serve on 127.0.0.1 (not localhost, which can be ::1 on Windows), port 0, recording every
// request, plus builders for OpenAI and Anthropic streams, HTTP errors and a cut stream.

export interface RecordedRequest {
  path: string;
  headers: Record<string, string>;
  body: any;
  rawBody: string;
  arrivedAt: number;
}

/** `n` counts the requests since the last `script()`, from 0. */
export type FakeHandler = (req: RecordedRequest, n: number) => Response | Promise<Response>;

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  readonly inFlight: number;
  readonly maxInFlight: number;
  /** A fetch that sends any URL here, keeping path and query, with the original host in x-orig-host. */
  redirectFetch(real?: typeof fetch): typeof fetch;
  /** One handler for every request, or a list used in order (the last one repeats). */
  script(handler: FakeHandler | FakeHandler[]): void;
  stop(): void;
}

export function startFakeProvider(): FakeServer {
  let handlers: FakeHandler[] = [() => openaiStream({ text: "ok" })];
  let n = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const rawBody = await req.text();
      let body: unknown = null;
      try {
        body = rawBody === "" ? null : JSON.parse(rawBody);
      } catch {
        body = null;
      }
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
      const rec: RecordedRequest = { path: `${url.pathname}${url.search}`, headers, body, rawBody, arrivedAt: Date.now() };
      requests.push(rec);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const handler = handlers[Math.min(n, handlers.length - 1)]!;
      n += 1;
      let res: Response;
      try {
        res = await handler(rec, n - 1);
      } catch (err) {
        res = new Response(String(err), { status: 500 });
      }
      return track(res, () => (inFlight -= 1));
    },
  });
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    requests,
    get inFlight() {
      return inFlight;
    },
    get maxInFlight() {
      return maxInFlight;
    },
    redirectFetch(real: typeof fetch = globalThis.fetch) {
      return (async (input: string | URL | Request, init?: RequestInit) => {
        const orig = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const target = `${url}${orig.pathname}${orig.search}`;
        const base = input instanceof Request ? new Request(target, input) : new Request(target, init);
        const headers = new Headers(base.headers);
        headers.set("x-orig-host", orig.host);
        return real(new Request(base, { headers }));
      }) as typeof fetch;
    },
    script(handler) {
      handlers = Array.isArray(handler) ? handler : [handler];
      n = 0;
    },
    stop() {
      server.stop(true);
    },
  };
}

/** Counts a response as in flight until its body is fully sent or cancelled. */
function track(res: Response, done: () => void): Response {
  if (!res.body) {
    done();
    return res;
  }
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      done();
    }
  };
  const reader = res.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      try {
        const { value, done: end } = await reader.read();
        if (end) {
          finish();
          ctrl.close();
        } else ctrl.enqueue(value);
      } catch {
        finish();
        ctrl.error(); // a bare error: the client sees a reset connection, and Bun prints nothing
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, { status: res.status, headers: res.headers });
}

export interface StreamOptions {
  text?: string;
  reasoning?: string;
  toolCall?: { id?: string | null; name?: string; arguments: string | Record<string, unknown> };
  usage?: Record<string, unknown> | null;
  model?: string;
  /** Characters per text or reasoning delta (default 8). */
  chunkChars?: number;
  chunkDelayMs?: number;
  holdFirstChunkMs?: number;
}

export interface OpenAIStreamOptions extends StreamOptions {
  /** Where reasoning goes: reasoning_content (DeepSeek, vLLM) or reasoning (OpenRouter). */
  reasoningField?: "reasoning_content" | "reasoning";
  reasoningDetails?: unknown[];
  /** Gemini's thought signature carrier, on the tool call. */
  extraContent?: unknown;
  /** More tool calls after the first, which the gateway drops (D-04). */
  extraToolCalls?: { name: string; arguments: string }[];
  finish?: string;
}

export interface AnthropicStreamOptions extends StreamOptions {
  thinking?: { thinking: string; signature: string }[];
  redacted?: string[];
  stopReason?: string;
}

export function openaiStream(o: OpenAIStreamOptions = {}): Response {
  const model = o.model ?? "served-model";
  const events: unknown[] = [];
  const chunk = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => events.push({ id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, ...extra }] });
  chunk({ role: "assistant", content: "" });
  for (const part of pieces(o.reasoning ?? "", o.chunkChars)) chunk({ [o.reasoningField ?? "reasoning_content"]: part });
  if (o.reasoningDetails) for (const d of o.reasoningDetails) chunk({ reasoning_details: [d] });
  for (const part of pieces(o.text ?? "", o.chunkChars)) chunk({ content: part });
  if (o.toolCall) {
    const args = typeof o.toolCall.arguments === "string" ? o.toolCall.arguments : JSON.stringify(o.toolCall.arguments);
    const half = Math.floor(args.length / 2);
    const first: Record<string, unknown> = { index: 0, type: "function", function: { name: o.toolCall.name ?? "python", arguments: args.slice(0, half) } };
    if (o.toolCall.id !== null) first.id = o.toolCall.id ?? "call_abc";
    if (o.extraContent !== undefined) first.extra_content = o.extraContent;
    chunk({ tool_calls: [first] });
    chunk({ tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] });
    (o.extraToolCalls ?? []).forEach((tc, i) => chunk({ tool_calls: [{ index: i + 1, id: `call_extra_${i}`, type: "function", function: { name: tc.name, arguments: tc.arguments } }] }));
  }
  chunk({}, { finish_reason: o.finish ?? (o.toolCall ? "tool_calls" : "stop") });
  if (o.usage !== null) events.push({ id: "chatcmpl-1", object: "chat.completion.chunk", model, choices: [], usage: o.usage ?? { prompt_tokens: 100, completion_tokens: 10 } });
  return sse(
    [...events.map((e) => `data: ${JSON.stringify(e)}\n\n`), "data: [DONE]\n\n"],
    o,
  );
}

export function anthropicStream(o: AnthropicStreamOptions = {}): Response {
  const model = o.model ?? "served-model";
  const events: [string, unknown][] = [];
  const usage = o.usage ?? { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 };
  events.push(["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage } }]);
  let index = 0;
  for (const t of o.thinking ?? []) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }]);
    for (const part of pieces(t.thinking, o.chunkChars)) events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: t.signature } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  }
  for (const data of o.redacted ?? []) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "redacted_thinking", data } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  }
  if (o.reasoning) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } }]);
    for (const part of pieces(o.reasoning, o.chunkChars)) events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: part } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  }
  if (o.text) {
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } }]);
    for (const part of pieces(o.text, o.chunkChars)) events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index += 1;
  }
  if (o.toolCall) {
    const args = typeof o.toolCall.arguments === "string" ? o.toolCall.arguments : JSON.stringify(o.toolCall.arguments);
    const half = Math.floor(args.length / 2);
    events.push(["content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: o.toolCall.id ?? "toolu_1", name: o.toolCall.name ?? "python", input: {} } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args.slice(0, half) } }]);
    events.push(["content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: args.slice(half) } }]);
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
  }
  events.push(["message_delta", { type: "message_delta", delta: { stop_reason: o.stopReason ?? (o.toolCall ? "tool_use" : "end_turn") }, usage: { output_tokens: 10 } }]);
  events.push(["message_stop", { type: "message_stop" }]);
  return sse(
    events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`),
    o,
  );
}

export function httpError(status: number, body: unknown = { error: { message: `HTTP ${status}`, type: "error" } }, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Sends `before` (SSE text), then breaks the connection. */
export function cutMidStream(before = `data: ${JSON.stringify({ model: "served-model", choices: [{ index: 0, delta: { content: "partial " } }] })}\n\n`): Response {
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (!sent) {
        sent = true;
        ctrl.enqueue(new TextEncoder().encode(before));
        return;
      }
      await Bun.sleep(10);
      ctrl.error();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function pieces(text: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function sse(parts: string[], o: StreamOptions): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      if (i === 0 && o.holdFirstChunkMs) await Bun.sleep(o.holdFirstChunkMs);
      else if (i > 0 && o.chunkDelayMs) await Bun.sleep(o.chunkDelayMs);
      if (i >= parts.length) {
        ctrl.close();
        return;
      }
      ctrl.enqueue(enc.encode(parts[i]!));
      i += 1;
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
