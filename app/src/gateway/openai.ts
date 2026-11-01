// KV cache: builds request bytes for every OpenAI-compatible provider; same input, same bytes (no clock, no randomness, fixed key order: model, messages, tools, max tokens, temperature, thinking fields, cache fields, stream, stream_options), replay only from what the provider sent; a cache marker turns a message's string into one text part holding the same bytes, with the marker as a field beside it, so the model reads the same text with or without it.
// The Chat Completions mapping (spec step 5) and the stream reader, through the openai SDK.

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, type OpenAI } from "openai";
import type { Message, ModelCompleteParams } from "../protocol.ts";
import type { ModelInfo } from "./catalog.ts";
import type { ProviderDef } from "./providers.ts";
import { isObject, sdkAttemptError, type Replay, type SdkErrors, type StreamHooks, type StreamResult, type StreamToolCall } from "./stream.ts";

const ERRORS: SdkErrors = { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError };

/** Fields the parameter fallback may drop, longest first so `reasoning` never matches inside `reasoning_effort`. */
export const DROPPABLE_FIELDS = ["chat_template_kwargs", "reasoning_effort", "stream_options", "temperature", "reasoning", "top_p"] as const;

export interface OpenAIContext {
  provider: ProviderDef;
  info?: ModelInfo;
  /** Fields the parameter fallback took out for this provider and model. */
  dropped: ReadonlySet<string>;
  /** The replay to attach to this assistant message, if any (D-33). */
  replay(m: Extract<Message, { role: "assistant" }>): Replay | undefined;
  /** Cache markers: root calls, and batch calls that share one whole prompt (cache.ts). Only OpenRouter's Anthropic (D-117) and Alibaba-cached (D-119) models use them. */
  markers: boolean;
}

/** OpenRouter model ids served by Anthropic, `~anthropic/…` aliases included. */
const OPENROUTER_ANTHROPIC = /^~?anthropic\//;

/**
 * OpenRouter models served by Alibaba, which caches only with per-block breakpoints and has no top-level field
 * (OpenRouter's prompt-caching docs, "Alibaba Qwen"). Exact ids: snapshot endpoints such as `qwen/qwen3.5-plus-02-15`
 * don't cache. `deepseek/deepseek-v3.2` caches only when Alibaba serves it; OpenRouter handles the marker for the rest (D-119).
 */
const OPENROUTER_ALIBABA = new Set(["qwen/qwen3-max", "qwen/qwen-plus", "qwen/qwen3.6-plus", "qwen/qwen3-coder-plus", "qwen/qwen3-coder-flash", "deepseek/deepseek-v3.2"]);

interface CacheMarkers {
  /** Indexes of the messages whose one text part carries a breakpoint. */
  blocks: ReadonlySet<number>;
  /** OpenRouter's top-level automatic breakpoint. */
  auto: boolean;
}

/** Where this call's cache breakpoints go: only OpenRouter, only on a marked call. */
function cacheMarkers(providerId: string, p: ModelCompleteParams, ctx: OpenAIContext): CacheMarkers {
  if (providerId !== "openrouter" || !ctx.markers) return { blocks: new Set(), auto: false };
  const model = p.model.model;
  const system = p.messages[0]?.role === "system" ? [0] : [];
  // Anthropic: the top-level field puts a breakpoint on the last block and moves it as the conversation grows; the
  // system prompt's own breakpoint lets every run read it (D-117)
  if (OPENROUTER_ANTHROPIC.test(model)) return { blocks: new Set(system), auto: true };
  // Alibaba: both breakpoints explicit, where anthropicBreakpoints (cache.ts) puts them: the end of system and the last
  // message. That is often a tool result; OpenRouter's ChatToolMessage takes text parts with cache_control, so it
  // carries the marker itself (D-119)
  if (OPENROUTER_ALIBABA.has(model)) return { blocks: new Set([...system, p.messages.length - 1]), auto: false };
  return { blocks: new Set(), auto: false };
}

/** Pure: the Chat Completions body for one model.complete request. */
export function buildOpenAIRequest(p: ModelCompleteParams, ctx: OpenAIContext): Record<string, unknown> {
  const id = ctx.provider.id;
  const hasTools = p.tools.length > 0;
  const keep = (field: string) => !ctx.dropped.has(field);
  const on = p.thinking !== "off";
  const markers = cacheMarkers(id, p, ctx);
  const body: Record<string, unknown> = { model: p.model.model, messages: p.messages.map((m, i) => toMessage(m, id, hasTools, ctx, markers.blocks.has(i))) };
  if (hasTools) body.tools = p.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  body[id === "openai" ? "max_completion_tokens" : "max_tokens"] = p.max_tokens;
  if (keep("temperature") && !(id === "openai" && ctx.info?.reasoning)) body.temperature = p.temperature;
  switch (id) {
    case "openai":
    case "custom":
      if (on && keep("reasoning_effort")) body.reasoning_effort = p.thinking;
      break;
    case "deepseek":
      body.thinking = { type: on ? "enabled" : "disabled" };
      if (on && keep("reasoning_effort")) body.reasoning_effort = p.thinking;
      break;
    case "openrouter":
      if (keep("reasoning")) body.reasoning = { effort: on ? p.thinking : "none" };
      break;
    case "gemini":
      if (keep("reasoning_effort")) body.reasoning_effort = on ? p.thinking : "none";
      break;
    case "local":
      if (keep("chat_template_kwargs")) body.chat_template_kwargs = on ? { enable_thinking: true, reasoning_effort: p.thinking } : { enable_thinking: false };
      break;
  }
  // The routing key pins a conversation to one backend and its warm cache. Sub-calls get their own, so a burst of
  // them (and the failover it can cause) never moves the root's backend (D-118).
  const routeKey = p.role === "root" ? p.run_id : `${p.run_id}-sub`;
  if (id === "openai") body.prompt_cache_key = routeKey;
  if (id === "openrouter") {
    body.session_id = routeKey;
    if (markers.auto) body.cache_control = { type: "ephemeral" };
  }
  body.stream = true;
  if (keep("stream_options")) body.stream_options = { include_usage: true };
  return body;
}

function toMessage(m: Message, providerId: string, hasTools: boolean, ctx: OpenAIContext, marked: boolean): Record<string, unknown> {
  switch (m.role) {
    case "system":
    case "user":
      return { role: m.role, content: markedContent(m.content, marked) };
    case "tool":
      return { role: "tool", tool_call_id: m.tool_call_id, content: markedContent(m.content, marked) };
    case "assistant": {
      const out: Record<string, unknown> = { role: "assistant", content: m.content };
      const replay = ctx.replay(m);
      if (replay?.reasoning_content !== undefined && providerId === "deepseek" && hasTools) out.reasoning_content = replay.reasoning_content;
      if (replay?.reasoning_details !== undefined && providerId === "openrouter") out.reasoning_details = replay.reasoning_details;
      if (m.tool_call) {
        const call: Record<string, unknown> = {
          id: m.tool_call.id,
          type: "function",
          function: { name: m.tool_call.name, arguments: JSON.stringify(m.tool_call.arguments) },
        };
        if (replay?.extra_content !== undefined && providerId === "gemini") call.extra_content = replay.extra_content;
        out.tool_calls = [call];
      }
      return out;
    }
  }
}

/**
 * A marked message: one text part with the engine's exact string, the breakpoint a field beside it, not text (D-117,
 * D-119). An empty string stays plain, since an empty block can't hold a breakpoint.
 */
function markedContent(text: string, marked: boolean): string | Record<string, unknown>[] {
  return marked && text !== "" ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : text;
}

/** Streams one attempt. Throws AttemptError for every failure, the abort included. */
export async function streamOpenAI(client: OpenAI, body: Record<string, unknown>, hooks: StreamHooks, signal: AbortSignal): Promise<StreamResult> {
  const out: StreamResult = { text: "", reasoning: "", toolCall: null, finish: null, served: null, usage: null, replay: {} };
  const calls = new Map<number, StreamToolCall & { extra?: unknown }>();
  let firstIndex: number | null = null;
  let reasoningContent = "";
  const details: unknown[] = [];
  let content = false;
  const touch = () => {
    if (!content) {
      content = true;
      hooks.onContent();
    }
  };
  try {
    const stream = await client.chat.completions.create(body as never, { signal });
    for await (const chunk of stream as unknown as AsyncIterable<any>) {
      hooks.onEvent();
      if (!isObject(chunk)) continue;
      if (typeof chunk.model === "string" && chunk.model !== "" && out.served === null) out.served = chunk.model;
      if (chunk.usage) out.usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!isObject(choice)) continue;
      if (typeof choice.finish_reason === "string") out.finish = finishOf(choice.finish_reason);
      const delta = isObject(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content !== "") {
        touch();
        out.text += delta.content;
        hooks.onText(delta.content);
      }
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
      let shown = reasoning;
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
        details.push(...delta.reasoning_details);
        if (shown === "") shown = delta.reasoning_details.map(detailText).join("");
      }
      if (shown !== "") {
        touch();
        out.reasoning += shown;
        hooks.onReasoning(shown);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          if (!isObject(tc)) continue;
          touch();
          const index = typeof tc.index === "number" ? tc.index : 0;
          let call = calls.get(index);
          if (!call) {
            call = { id: null, name: "", arguments: "" };
            calls.set(index, call);
            firstIndex ??= index;
          }
          if (typeof tc.id === "string" && tc.id !== "") call.id ??= tc.id;
          const fn = isObject(tc.function) ? tc.function : {};
          if (typeof fn.name === "string") call.name += fn.name;
          if (typeof fn.arguments === "string") call.arguments += fn.arguments;
          if (tc.extra_content !== undefined && call.extra === undefined) call.extra = tc.extra_content;
        }
      }
    }
  } catch (err) {
    throw sdkAttemptError(err, ERRORS);
  }
  if (firstIndex !== null) {
    const { extra, ...call } = calls.get(firstIndex)!; // D-04: the first call only
    out.toolCall = call;
    if (extra !== undefined) out.replay.extra_content = extra;
  }
  if (reasoningContent !== "") out.replay.reasoning_content = reasoningContent;
  if (details.length > 0) out.replay.reasoning_details = details;
  return out;
}

function detailText(d: unknown): string {
  if (!isObject(d)) return "";
  if (typeof d.text === "string") return d.text;
  if (typeof d.summary === "string") return d.summary;
  return "";
}

function finishOf(reason: string): StreamResult["finish"] {
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "content_filter":
      return "content_filter";
    default:
      return "other";
  }
}
