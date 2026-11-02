// KV cache: builds request bytes for every OpenAI-compatible provider; same input, same bytes (no clock, no randomness, fixed key order: model, messages, tools, max tokens, temperature, thinking fields, cache fields, stream, stream_options), replay only from what the provider sent.
// The Chat Completions mapping (spec step 5) and the stream reader, through the openai SDK.

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, type OpenAI } from "openai";
import type { Message, ModelCompleteParams } from "../protocol.ts";
import { routeKey, splitPrefix } from "./cache.ts";
import type { ModelInfo } from "./catalog.ts";
import { openRouterEndpoint, type ProviderDef } from "./providers.ts";
import { assertFinished, ByteBudget, isObject, sdkAttemptError, type Replay, type SdkErrors, type StreamHooks, type StreamResult, type StreamToolCall } from "./stream.ts";

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
  /** Cache markers: root calls, an rlm() child's turns, and batch calls that share one whole prompt (cache.ts). Only OpenRouter's Anthropic models use them (D-117). */
  markers: boolean;
  /** OpenRouter: mark the sub-call's stable prefix (p.prefix) as its own block; only Anthropic models use it (D-119). */
  prefixMark: boolean;
  /** OpenRouter: the endpoint this call must use, chosen in the model ref or pinned by the gateway (D-120). */
  endpoint: string | null;
}

/** OpenRouter model ids served by Anthropic, `~anthropic/…` aliases included. */
const OPENROUTER_ANTHROPIC = /^~?anthropic\//;

/** Whether this call carries Anthropic cache breakpoints: an OpenRouter Anthropic model on a marked call (D-117). */
function anthropicMarkers(providerId: string, p: ModelCompleteParams, ctx: OpenAIContext): boolean {
  return providerId === "openrouter" && ctx.markers && OPENROUTER_ANTHROPIC.test(p.model.model);
}

/** Pure: the Chat Completions body for one model.complete request. */
export function buildOpenAIRequest(p: ModelCompleteParams, ctx: OpenAIContext): Record<string, unknown> {
  const id = ctx.provider.id;
  const hasTools = p.tools.length > 0;
  const keep = (field: string) => !ctx.dropped.has(field);
  const on = p.thinking !== "off";
  const marked = anthropicMarkers(id, p, ctx);
  const prefixAt = id === "openrouter" && ctx.prefixMark && OPENROUTER_ANTHROPIC.test(p.model.model) && p.prefix ? p.messages.length - 1 : -1;
  const model = id === "openrouter" ? openRouterEndpoint(p.model.model).model : p.model.model;
  const body: Record<string, unknown> = {
    model,
    messages: p.messages.map((m, i) => (i === prefixAt ? prefixMessage(m, p.prefix!.chars) : null) ?? toMessage(m, id, hasTools, ctx, marked && i === 0)),
  };
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
  // The routing key pins a conversation to one backend and its warm cache (cache.ts routeKey, D-118, D-119)
  const key = routeKey(p);
  if (id === "openai") body.prompt_cache_key = key;
  if (id === "openrouter") {
    body.session_id = key;
    // Anthropic caches only with cache_control: the top-level field puts the breakpoint on the last block and moves it
    // as the conversation grows; the system prompt's own breakpoint (toMessage) lets every run read it (D-117)
    if (anthropicMarkers(id, p, ctx)) body.cache_control = { type: "ephemeral" };
    // once a conversation has an endpoint, every call goes there: another endpoint has another, cold cache (D-120)
    if (ctx.endpoint) body.provider = { order: [ctx.endpoint], allow_fallbacks: false };
  }
  body.stream = true;
  if (keep("stream_options")) body.stream_options = { include_usage: true };
  return body;
}

/** A sub-call's user message as two text parts, the stable prefix marked; null when the split doesn't apply (D-119). */
function prefixMessage(m: Message, chars: number): Record<string, unknown> | null {
  if (m.role !== "user") return null;
  const parts = splitPrefix(m.content, chars);
  if (!parts) return null;
  return { role: "user", content: [{ type: "text", text: parts[0], cache_control: { type: "ephemeral" } }, { type: "text", text: parts[1] }] };
}

function toMessage(m: Message, providerId: string, hasTools: boolean, ctx: OpenAIContext, marked: boolean): Record<string, unknown> {
  switch (m.role) {
    case "system":
      // one text block with the engine's exact string; the breakpoint is a field beside it, not text (D-117)
      if (marked) return { role: "system", content: [{ type: "text", text: m.content, cache_control: { type: "ephemeral" } }] };
      return { role: m.role, content: m.content };
    case "user":
      return { role: m.role, content: m.content };
    case "tool":
      return { role: "tool", tool_call_id: m.tool_call_id, content: m.content };
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

/** Streams one attempt. Throws AttemptError for every failure, the abort included, and for a stream that ended with no
 *  finish_reason: the SDK ends iteration quietly on an abort or a clean close, and neither is an answer. */
export async function streamOpenAI(client: OpenAI, body: Record<string, unknown>, hooks: StreamHooks, signal: AbortSignal): Promise<StreamResult> {
  const out: StreamResult = { text: "", reasoning: "", toolCall: null, finish: null, served: null, provider: null, usage: null, replay: {} };
  const budget = new ByteBudget(hooks.maxBytes);
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
      if (typeof chunk.provider === "string" && chunk.provider !== "" && out.provider === null) out.provider = chunk.provider;
      if (chunk.usage) out.usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (!isObject(choice)) continue;
      if (typeof choice.finish_reason === "string") out.finish = finishOf(choice.finish_reason);
      const delta = isObject(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content !== "") {
        budget.add(delta.content);
        touch();
        out.text += delta.content;
        hooks.onText(delta.content);
      }
      const reasoning = typeof delta.reasoning_content === "string" ? delta.reasoning_content : typeof delta.reasoning === "string" ? delta.reasoning : "";
      if (typeof delta.reasoning_content === "string") {
        budget.add(delta.reasoning_content);
        reasoningContent += delta.reasoning_content;
      } else if (typeof delta.reasoning === "string") {
        budget.add(delta.reasoning);
      }
      let shown = reasoning;
      if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0) {
        budget.add(JSON.stringify(delta.reasoning_details));
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
            budget.add(64); // an entry costs something even when its fields are empty
          }
          if (typeof tc.id === "string" && tc.id !== "") {
            if (call.id === null) budget.add(tc.id);
            call.id ??= tc.id;
          }
          const fn = isObject(tc.function) ? tc.function : {};
          if (typeof fn.name === "string") {
            budget.add(fn.name);
            call.name += fn.name;
          }
          if (typeof fn.arguments === "string") {
            budget.add(fn.arguments);
            call.arguments += fn.arguments;
          }
          if (tc.extra_content !== undefined && call.extra === undefined) {
            budget.add(JSON.stringify(tc.extra_content));
            call.extra = tc.extra_content;
          }
        }
      }
    }
  } catch (err) {
    throw sdkAttemptError(err, ERRORS);
  }
  assertFinished(signal, out.finish !== null);
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
