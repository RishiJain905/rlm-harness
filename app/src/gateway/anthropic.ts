// KV cache: builds Anthropic request bytes; same input, same bytes (no clock, no randomness, fixed key order: model, max_tokens, system, tools, messages, temperature, thinking, output_config, stream), markers only through cache.ts, thinking blocks replayed exactly as received.
// The Messages API mapping (spec step 5), the thinking families, and the raw-event stream reader.

import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError, type Anthropic } from "@anthropic-ai/sdk";
import type { Message, ModelCompleteParams, Thinking } from "../protocol.ts";
import { anthropicBreakpoints } from "./cache.ts";
import { isObject, sdkAttemptError, type Replay, type SdkErrors, type StreamHooks, type StreamResult } from "./stream.ts";

const ERRORS: SdkErrors = { APIError, APIConnectionError, APIConnectionTimeoutError, APIUserAbortError };

export type ThinkingShape = "budget" | "adaptive";

export interface Family {
  /** The shape thinking low, medium and high take. */
  on: ThinkingShape;
  /** What thinking off sends: nothing, `{type: "disabled"}`, or `{type: "between_tools"}`. */
  off: null | "disabled" | "between_tools";
  /** "off-only": temperature goes out only with thinking off. */
  temperature: "off-only" | "never";
}

/** The spec's family table, by the id after `claude-` (thinking-troubleshooting page, 2026-10-28). */
const FAMILIES: [readonly string[], Family][] = [
  [["opus-4", "opus-4-1", "sonnet-4", "sonnet-4-5", "opus-4-5", "haiku-4-5", "sonnet-3-7"], { on: "budget", off: null, temperature: "off-only" }],
  [["opus-4-6", "sonnet-4-6"], { on: "adaptive", off: null, temperature: "off-only" }],
  [["opus-4-7", "opus-4-8"], { on: "adaptive", off: null, temperature: "never" }],
  [["opus-5", "sonnet-5", "haiku-5-5"], { on: "adaptive", off: "disabled", temperature: "never" }],
  [["sonnet-5-5"], { on: "adaptive", off: "between_tools", temperature: "never" }],
  [["opus-5-5"], { on: "adaptive", off: null, temperature: "never" }],
];
const CANT_TURN_OFF = /^(fable|mythos)-/;
const OTHER: Family = { on: "adaptive", off: null, temperature: "off-only" };
const BUDGET_SHARE: Record<Exclude<Thinking, "off">, number> = { low: 0.25, medium: 0.5, high: 0.75 };
const MIN_BUDGET = 1024;

export function anthropicFamily(model: string): Family {
  const name = model.replace(/^claude-/, "").replace(/(-\d{8})?(-latest)?$/, "");
  for (const [names, family] of FAMILIES) if (names.includes(name)) return family;
  if (CANT_TURN_OFF.test(name)) return { on: "adaptive", off: null, temperature: "never" };
  return OTHER;
}

/** floor(max_tokens × 0.25 | 0.5 | 0.75), at least 1024; null at max_tokens 1024 or less (no thinking sent). */
export function thinkingBudget(maxTokens: number, level: Exclude<Thinking, "off">): number | null {
  if (maxTokens <= MIN_BUDGET) return null;
  return Math.max(MIN_BUDGET, Math.floor(maxTokens * BUDGET_SHARE[level]));
}

export interface AnthropicContext {
  /** Set after a 400 said the family's own shape is not supported; remembered by the gateway. */
  shape?: ThinkingShape;
  /** Fields the parameter fallback took out for this model. */
  dropped: ReadonlySet<string>;
  /** Cache markers: root calls, and batch calls that share one whole prompt (cache.ts). */
  markers: boolean;
  /** The thinking blocks to put back on this assistant message, if any (D-33). */
  replay(m: Extract<Message, { role: "assistant" }>): Replay | undefined;
}

type Block = Record<string, unknown>;

/** Pure: the Messages API body for one model.complete request. */
export function buildAnthropicRequest(p: ModelCompleteParams, ctx: AnthropicContext): Record<string, unknown> {
  const family = anthropicFamily(p.model.model);
  const system = p.messages.filter((m) => m.role === "system").map((m) => m.content);
  const messages: { role: "user" | "assistant"; content: Block[] }[] = [];
  const push = (role: "user" | "assistant", blocks: Block[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks); // neighbours of a dropped message merge
    else messages.push({ role, content: blocks });
  };
  for (const m of p.messages) {
    if (m.role === "user") push("user", [{ type: "text", text: m.content }]);
    else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]);
    else if (m.role === "assistant") {
      const blocks: Block[] = [...(ctx.replay(m)?.thinking_blocks ?? [])];
      if (m.content !== "") blocks.push({ type: "text", text: m.content });
      if (m.tool_call) blocks.push({ type: "tool_use", id: m.tool_call.id, name: m.tool_call.name, input: m.tool_call.arguments });
      if (m.content !== "" || m.tool_call) push("assistant", blocks); // an empty assistant message is dropped
    }
  }

  let thinking: Block | undefined;
  let outputConfig: Block | undefined;
  if (p.thinking !== "off") {
    const shape = ctx.shape ?? family.on;
    if (shape === "adaptive") {
      thinking = { type: "adaptive", display: "summarized" };
      outputConfig = { effort: p.thinking };
    } else {
      const budget = thinkingBudget(p.max_tokens, p.thinking);
      if (budget !== null) thinking = { type: "enabled", budget_tokens: budget };
    }
  } else if (family.off !== null) {
    thinking = { type: family.off };
  }
  const thinkingOn = thinking !== undefined && thinking.type !== "disabled" && thinking.type !== "between_tools";

  const body: Record<string, unknown> = { model: p.model.model, max_tokens: p.max_tokens };
  if (system.length > 0) body.system = [{ type: "text", text: system.join("\n\n") }];
  if (p.tools.length > 0) body.tools = p.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  body.messages = messages;
  if (family.temperature === "off-only" && !thinkingOn && !ctx.dropped.has("temperature")) body.temperature = p.temperature;
  if (thinking) body.thinking = thinking;
  if (outputConfig) body.output_config = outputConfig;
  body.stream = true;
  return ctx.markers ? anthropicBreakpoints(body as { system?: Block[]; messages: typeof messages }) : body;
}

/** Streams one attempt as raw events, keeping thinking blocks and signatures as received. Throws AttemptError. */
export async function streamAnthropic(client: Anthropic, body: Record<string, unknown>, hooks: StreamHooks, signal: AbortSignal): Promise<StreamResult> {
  const out: StreamResult = { text: "", reasoning: "", toolCall: null, finish: null, served: null, usage: null, replay: {} };
  const blocks = new Map<number, Block>();
  const order: number[] = [];
  let usage: Record<string, unknown> | null = null;
  try {
    const stream = await client.messages.create(body as never, { signal });
    for await (const event of stream as unknown as AsyncIterable<any>) {
      hooks.onEvent();
      if (!isObject(event)) continue;
      switch (event.type) {
        case "message_start": {
          const msg = isObject(event.message) ? event.message : {};
          if (typeof msg.model === "string" && msg.model !== "") out.served = msg.model;
          if (isObject(msg.usage)) usage = { ...msg.usage };
          break;
        }
        case "content_block_start": {
          hooks.onContent();
          const block = isObject(event.content_block) ? { ...event.content_block } : {};
          if (block.type === "tool_use") block.input_json = "";
          blocks.set(event.index, block);
          order.push(event.index);
          if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
            out.text += block.text;
            hooks.onText(block.text);
          }
          break;
        }
        case "content_block_delta": {
          const block = blocks.get(event.index);
          const d = isObject(event.delta) ? event.delta : {};
          if (!block) break;
          if (d.type === "text_delta" && typeof d.text === "string") {
            block.text = `${block.text ?? ""}${d.text}`;
            out.text += d.text;
            hooks.onContent();
            hooks.onText(d.text);
          } else if (d.type === "thinking_delta" && typeof d.thinking === "string") {
            block.thinking = `${block.thinking ?? ""}${d.thinking}`;
            out.reasoning += d.thinking;
            hooks.onContent();
            hooks.onReasoning(d.thinking);
          } else if (d.type === "signature_delta" && typeof d.signature === "string") {
            block.signature = `${block.signature ?? ""}${d.signature}`;
          } else if (d.type === "input_json_delta" && typeof d.partial_json === "string") {
            block.input_json = `${block.input_json}${d.partial_json}`;
            hooks.onContent();
          }
          break;
        }
        case "message_delta": {
          const d = isObject(event.delta) ? event.delta : {};
          if (typeof d.stop_reason === "string") out.finish = finishOf(d.stop_reason);
          if (isObject(event.usage)) {
            usage ??= {};
            for (const [k, v] of Object.entries(event.usage)) if (v !== null && v !== undefined) usage[k] = v;
          }
          break;
        }
        case "error":
          throw new APIError(undefined, event, undefined, undefined); // an error event inside the stream
      }
    }
  } catch (err) {
    throw sdkAttemptError(err, ERRORS);
  }
  out.usage = usage;
  const thinking: Block[] = [];
  for (const index of order) {
    const block = blocks.get(index)!;
    if (block.type === "tool_use") {
      out.toolCall = { id: typeof block.id === "string" ? block.id : null, name: String(block.name ?? ""), arguments: String(block.input_json) || "{}" };
      break; // D-04: the first call only, and the thinking before it
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") thinking.push(block);
  }
  if (thinking.length > 0) out.replay.thinking_blocks = thinking;
  return out;
}

function finishOf(reason: string): StreamResult["finish"] {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
    case "model_context_window_exceeded":
      return "length";
    case "tool_use":
      return "tool_call";
    case "refusal":
      return "content_filter";
    default:
      return "other";
  }
}
