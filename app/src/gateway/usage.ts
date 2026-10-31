// KV cache: none
// Token usage and cost (D-22): each provider's raw usage as a Usage, priced from the catalog,
// and the per-run totals by role. `input_tokens` counts every prompt token, cached ones included.

import type { ModelCompleteParams, ToolCall, Usage } from "../protocol.ts";
import type { ModelInfo } from "./catalog.ts";

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
  };
}

/** The characters a request carries: every message's content, each tool call's arguments, and the tools (D-25). */
export function requestChars(p: Pick<ModelCompleteParams, "messages" | "tools">): number {
  let n = 0;
  for (const m of p.messages) {
    n += m.content.length;
    if (m.role === "assistant" && m.tool_call) n += JSON.stringify(m.tool_call.arguments).length;
  }
  return n + JSON.stringify(p.tools).length; // "[]" (2) when there are none, as the spec counts it
}

/** The characters a reply carries: its text and its tool call's arguments. */
export function replyChars(text: string, toolCall: ToolCall | null): number {
  return text.length + (toolCall ? JSON.stringify(toolCall.arguments).length : 0);
}

/**
 * `raw` is the provider's usage object: Anthropic's (`input_tokens` excludes cached tokens) or an
 * OpenAI-compatible one (`prompt_tokens`). With none, tokens are ceil(chars / 4) from `chars`.
 */
export function toUsage(raw: unknown, info?: ModelInfo, chars?: { input: number; output: number }): Usage {
  const u = emptyUsage();
  const r = isObject(raw) ? raw : null;
  if (r && "prompt_tokens" in r) {
    const prompt = obj(r.prompt_tokens_details);
    const completion = obj(r.completion_tokens_details);
    u.input_tokens = num(r.prompt_tokens);
    u.output_tokens = num(r.completion_tokens);
    u.cache_read_tokens = num(prompt.cached_tokens) || num(r.prompt_cache_hit_tokens); // DeepSeek reports the second
    u.cache_write_tokens = num(prompt.cache_write_tokens); // OpenRouter
    u.reasoning_tokens = num(completion.reasoning_tokens);
  } else if (r && ("input_tokens" in r || "output_tokens" in r)) {
    u.cache_read_tokens = num(r.cache_read_input_tokens);
    u.cache_write_tokens = num(r.cache_creation_input_tokens);
    u.input_tokens = num(r.input_tokens) + u.cache_read_tokens + u.cache_write_tokens;
    u.output_tokens = num(r.output_tokens);
    u.reasoning_tokens = num(obj(r.output_tokens_details).thinking_tokens);
  } else if (chars) {
    u.input_tokens = Math.ceil(chars.input / 4);
    u.output_tokens = Math.ceil(chars.output / 4);
  }
  u.cost_usd = costOf(u, info);
  return u;
}

/** D-22: uncached input, cache reads, cache writes and output, each at its own price. 0 without a catalog entry. */
export function costOf(u: Usage, info?: ModelInfo): number {
  if (!info) return 0;
  const p = info.price;
  const uncached = Math.max(0, u.input_tokens - u.cache_read_tokens - u.cache_write_tokens);
  return (uncached * p.input + u.cache_read_tokens * p.cache_read + u.cache_write_tokens * p.cache_write + u.output_tokens * p.output) / 1e6;
}

/** Cache reads over input; null with no input. */
export function hitRate(u: Usage): number | null {
  return u.input_tokens > 0 ? u.cache_read_tokens / u.input_tokens : null;
}

/** One run's usage, by role. */
export class RunTotals {
  root = emptyUsage();
  sub = emptyUsage();

  add(role: "root" | "sub", u: Usage): void {
    this[role] = addUsage(this[role], u);
  }

  summary(): { root: Usage; sub: Usage; cost_usd: number; cache_hit_rate: number | null } {
    const all = addUsage(this.root, this.sub);
    return { root: { ...this.root }, sub: { ...this.sub }, cost_usd: all.cost_usd, cache_hit_rate: hitRate(all) };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function obj(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
