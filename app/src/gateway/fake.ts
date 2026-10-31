// KV cache: none
// The scripted fake provider `fake/scripted` (architecture §7.5, D-20): replies come from the JSON
// file named by RLMH_FAKE_SCRIPT, read at a run's first call. Steps 6, 7 and 10 and CI use it.

import { readFileSync } from "node:fs";
import type { FinishReason, ModelCompleteParams, ModelErrorKind, ToolCall } from "../protocol.ts";

export interface FakeScript {
  root?: { text?: string; tool_call?: { code: string } }[];
  sub?: { match?: string; text?: string }[];
  chunk_chars?: number;
  delay_ms?: number;
  errors?: { role: "root" | "sub"; at: number; kind: ModelErrorKind; status?: number | null }[];
}

/** One run's place in the script. The gateway keeps it with the run's other state. */
export interface FakeRunState {
  script: FakeScript | null;
  rootServed: number;
  calls: { root: number; sub: number };
}

export function newFakeRunState(): FakeRunState {
  return { script: null, rootServed: 0, calls: { root: 0, sub: 0 } };
}

/** A failure the gateway turns into a ModelError as it is, with no retries. */
export class FakeError extends Error {
  readonly kind: ModelErrorKind;
  readonly status: number | null;

  constructor(kind: ModelErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "FakeError";
    this.kind = kind;
    this.status = status;
  }
}

export interface FakeReply {
  text: string;
  tool_call: ToolCall | null;
  finish_reason: FinishReason;
}

export class FakeProvider {
  private readonly env: Record<string, string | undefined>;

  constructor(env: Record<string, string | undefined> = process.env) {
    this.env = env;
  }

  /** Streams the scripted reply through `onText`; `signal` aborts the delays. */
  async complete(p: ModelCompleteParams, state: FakeRunState, onText: (text: string) => void, signal: AbortSignal): Promise<FakeReply> {
    state.script ??= this.load();
    const script = state.script;
    const n = ++state.calls[p.role];
    const scripted = script.errors?.find((e) => e.role === p.role && e.at === n);
    if (scripted) throw new FakeError(scripted.kind, `fake script error: ${scripted.kind} at ${p.role} call ${n}`, scripted.status ?? null);

    let reply: FakeReply;
    if (p.role === "root") {
      const entry = script.root?.[state.rootServed];
      if (!entry) throw new FakeError("other", "fake script exhausted");
      state.rootServed += 1;
      const toolCall = entry.tool_call ? { id: `call_${state.rootServed}`, name: "python", arguments: { code: entry.tool_call.code } } : null;
      reply = { text: entry.text ?? "", tool_call: toolCall, finish_reason: toolCall ? "tool_call" : "stop" };
    } else {
      const prompt = p.messages[p.messages.length - 1]?.content ?? "";
      const rules = script.sub ?? [];
      const rule = rules.find((r) => r.match !== undefined && matches(r.match, prompt)) ?? rules.find((r) => r.match === undefined);
      if (!rule) throw new FakeError("other", "fake script has no sub-call rule for this prompt");
      reply = { text: rule.text ?? "", tool_call: null, finish_reason: "stop" };
    }

    const size = Math.max(1, script.chunk_chars ?? 16);
    const delay = script.delay_ms ?? 0;
    for (let i = 0; i < reply.text.length; i += size) {
      if (i > 0 && delay > 0) await sleep(delay, signal);
      if (signal.aborted) throw signal.reason;
      onText(reply.text.slice(i, i + size));
    }
    return reply;
  }

  private load(): FakeScript {
    const file = this.env.RLMH_FAKE_SCRIPT;
    if (!file) throw new FakeError("other", "RLMH_FAKE_SCRIPT is not set");
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("not a JSON object");
      return data as FakeScript;
    } catch (err) {
      throw new FakeError("other", `fake script unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

function matches(pattern: string, prompt: string): boolean {
  try {
    return new RegExp(pattern).test(prompt);
  } catch (err) {
    throw new FakeError("other", `fake script has a bad match regex ${JSON.stringify(pattern)}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
