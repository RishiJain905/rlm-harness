// KV cache: none
// D-250: which thinking levels each model takes, the level the gateway sends for one it lacks, and the levels a
// refresh keeps from OpenRouter's `reasoning.supported_efforts`.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Catalog, type ModelInfo } from "../../src/gateway/catalog.ts";
import { fitThinking, levelsFromEfforts, thinkingRule, type ThinkingOn } from "../../src/gateway/thinking.ts";
import type { Thinking } from "../../src/protocol.ts";
import { anthropicStream, openaiStream, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { params, ref, rig, type Rig } from "./helpers.ts";

const FIVE: ThinkingOn[] = ["low", "medium", "high", "xhigh", "max"];
const ALL: ThinkingOn[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

const jsonResponse = (body: unknown): Response => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const info = (over: Partial<ModelInfo> = {}): ModelInfo => ({
  provider: "openrouter",
  id: "x",
  name: "x",
  context_window: 0,
  max_output: 0,
  price: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  tool_call: true,
  reasoning: true,
  cache_min_tokens: null,
  ...over,
});

describe("levels by model", () => {
  const cases: [string, string, ThinkingOn[]][] = [
    // Anthropic: effort with xhigh from Opus 4.7, max from 4.6; budget models low to high
    ["anthropic", "claude-opus-5-5", FIVE],
    ["anthropic", "claude-sonnet-5-5", FIVE],
    ["anthropic", "claude-haiku-5-5", FIVE],
    ["anthropic", "claude-fable-5-1", FIVE],
    ["anthropic", "claude-opus-4-7", FIVE],
    ["anthropic", "claude-sonnet-4-6", ["low", "medium", "high", "max"]],
    ["anthropic", "claude-opus-4-5", ["low", "medium", "high"]],
    ["anthropic", "claude-haiku-4-5-20251001", ["low", "medium", "high"]],
    ["openrouter", "anthropic/claude-opus-5.5", FIVE],
    ["openrouter", "anthropic/claude-sonnet-4.6@anthropic", ["low", "medium", "high", "max"]],
    // OpenAI
    ["openai", "o3", ["low", "medium", "high"]],
    ["openai", "gpt-5", ["minimal", "low", "medium", "high"]],
    ["openai", "gpt-5-mini", ["minimal", "low", "medium", "high"]],
    ["openai", "gpt-5-pro", ["high"]],
    ["openai", "gpt-5.1", ["low", "medium", "high"]],
    ["openai", "gpt-5.1-codex-max", ["low", "medium", "high", "xhigh"]],
    ["openai", "gpt-5.5", ["low", "medium", "high", "xhigh"]],
    ["openai", "gpt-6.1-sol", FIVE],
    ["openrouter", "openai/gpt-5.2", ["low", "medium", "high", "xhigh"]],
    // DeepSeek V4 and later, direct or through OpenRouter
    ["deepseek", "deepseek-flash", ["low", "high", "max"]],
    ["deepseek", "deepseek-v4-pro", ["low", "high", "max"]],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", ["low", "high", "max"]],
    // Gemini
    ["gemini", "gemini-2.5-pro", ["minimal", "low", "medium", "high"]],
    ["gemini", "gemini-3.5-flash", ["minimal", "low", "medium", "high"]],
    ["gemini", "gemini-3.1-pro-preview", ["low", "medium", "high"]],
    ["gemini", "gemini-3-pro-preview", ["low", "high"]],
    ["openrouter", "google/gemini-3-flash-preview", ["minimal", "low", "medium", "high"]],
    // xAI through OpenRouter
    ["openrouter", "x-ai/grok-4.7", ["low", "medium", "high", "xhigh"]],
    ["openrouter", "x-ai/grok-4.5", ["low", "medium", "high"]],
    // a template, a fake or an unknown maker
    ["local", "qwen", ALL],
    ["custom", "m", ALL],
    ["fake", "scripted", ALL],
    ["openrouter", "vendor/thing", ["low", "medium", "high"]],
  ];
  for (const [provider, model, levels] of cases) {
    test(`${provider}/${model}`, () => expect([...thinkingRule(provider, model).levels]).toEqual(levels));
  }

  test("a model the catalog lists without reasoning takes no level, unless a template or the fake decides", () => {
    expect(thinkingRule("openai", "gpt-4.1", info({ reasoning: false })).levels).toEqual([]);
    expect(thinkingRule("local", "qwen", info({ reasoning: false })).levels).toEqual(ALL);
  });

  test("OpenRouter's own list wins over the id rule, and DeepSeek keeps its aliases", () => {
    const rule = thinkingRule("openrouter", "deepseek/deepseek-v4-pro", info({ thinking_levels: ["high", "xhigh"] }));
    expect(rule.levels).toEqual(["high", "xhigh"]);
    expect(fitThinking("medium", rule)).toBe("high");
    expect(thinkingRule("openrouter", "vendor/thing", info({ thinking_levels: ["low", "max"] })).levels).toEqual(["low", "max"]);
  });
});

describe("fitThinking", () => {
  const cases: [string, string, Thinking, Thinking][] = [
    // what the model takes goes as asked; off always does
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "high", "high"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "max", "max"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "off", "off"],
    // DeepSeek's own aliases
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "minimal", "low"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "medium", "high"],
    ["openrouter", "deepseek/deepseek-v4.1-flash-1017", "xhigh", "high"],
    // else the nearest, the lower on a tie
    ["anthropic", "claude-sonnet-4-6", "xhigh", "high"],
    ["anthropic", "claude-opus-4-5", "max", "high"],
    ["anthropic", "claude-opus-5-5", "minimal", "low"],
    ["openai", "gpt-5.1", "minimal", "low"],
    ["openai", "gpt-5.2", "max", "xhigh"],
    ["openai", "gpt-5-pro", "low", "high"],
    ["openai", "o3", "xhigh", "high"],
    ["gemini", "gemini-3-pro-preview", "medium", "low"],
    ["gemini", "gemini-2.5-flash", "max", "high"],
  ];
  for (const [provider, model, asked, sent] of cases) {
    test(`${provider}/${model}: ${asked} goes as ${sent}`, () => expect(fitThinking(asked, thinkingRule(provider, model))).toBe(sent));
  }

  test("a model with no levels known gets the level as asked", () => {
    expect(fitThinking("max", thinkingRule("openai", "gpt-4.1", info({ reasoning: false })))).toBe("max");
  });
});

test("levelsFromEfforts: least first, none and unknown words dropped, empty is unknown", () => {
  expect(levelsFromEfforts(["max", "high", "low", "none"])).toEqual(["low", "high", "max"]);
  expect(levelsFromEfforts(["xhigh", "turbo"])).toEqual(["xhigh"]);
  expect(levelsFromEfforts(["none"])).toBeUndefined();
  expect(levelsFromEfforts(null)).toBeUndefined();
});

describe("on the wire", () => {
  let server: FakeServer;
  let r: Rig | undefined;
  beforeEach(() => {
    server = startFakeProvider();
  });
  afterEach(() => {
    server.stop();
    r?.cleanup();
    r = undefined;
  });

  test("OpenRouter DeepSeek: max goes as max, xhigh as high", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() => openaiStream({ text: "ok" }));
    for (const [asked, sent] of [["max", "max"], ["xhigh", "high"], ["high", "high"]] as const) {
      await r.gateway.complete(params(ref("openrouter", "deepseek/deepseek-v4.1-flash-1017"), { thinking: asked }));
      expect(server.requests[server.requests.length - 1]!.body.reasoning).toEqual({ effort: sent });
    }
  });

  test("Anthropic: xhigh as effort where the model has it, as high where it doesn't", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    for (const [model, sent] of [["claude-opus-5-5", "xhigh"], ["claude-sonnet-4-6", "high"]] as const) {
      await r.gateway.complete(params(ref("anthropic", model), { thinking: "xhigh" }));
      expect(server.requests[server.requests.length - 1]!.body.output_config).toEqual({ effort: sent });
    }
  });

  test("a budget model fits max to high's budget", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => anthropicStream({ text: "ok" }));
    await r.gateway.complete(params(ref("anthropic", "claude-opus-4-5"), { thinking: "max", max_tokens: 4096 }));
    expect(server.requests[0]!.body.thinking).toEqual({ type: "enabled", budget_tokens: 3072 });
  });

  test("a refresh keeps OpenRouter's supported_efforts, and the catalog reads them back", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() =>
      jsonResponse({
        data: [
          { id: "vendor/thinker", supported_parameters: ["tools", "reasoning"], reasoning: { supported_efforts: ["max", "high", "low", "none"], default_effort: "high" } },
          { id: "vendor/plain", supported_parameters: ["tools"] },
        ],
      }),
    );
    const got = await r.gateway.refreshModels("openrouter");
    expect(got.find((m) => m.id === "vendor/thinker")!.thinking_levels).toEqual(["low", "high", "max"]);
    expect("thinking_levels" in got.find((m) => m.id === "vendor/plain")!).toBe(false);
    expect(new Catalog(r.home).get("openrouter", "vendor/thinker")!.thinking_levels).toEqual(["low", "high", "max"]);
    server.script(() => openaiStream({ text: "ok" }));
    await r.gateway.complete(params(ref("openrouter", "vendor/thinker"), { thinking: "xhigh" }));
    expect(server.requests[server.requests.length - 1]!.body.reasoning).toEqual({ effort: "high" });
  });
});
