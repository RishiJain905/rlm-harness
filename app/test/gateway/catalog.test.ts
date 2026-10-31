// KV cache: none
// catalog.ts, scripts/build-catalog.ts and the committed catalog/models.json (step 5, catalog.test.ts row).
// Everything runs offline: buildCatalog on small OMP-shaped fixtures, Catalog on temp homes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CATALOG_SOURCE,
  Catalog,
  FAKE_MODEL,
  type CatalogFile,
  type ModelInfo,
} from "../../src/gateway/catalog.ts";
import { ModelError } from "../../src/gateway/gateway.ts";
import { PROVIDER_IDS } from "../../src/gateway/providers.ts";
import { refreshedModelsPath } from "../../src/paths.ts";
import { httpError, startFakeProvider, type FakeServer } from "../fakes/http.ts";
import { KEYS, caught, limits, params, recordSleeps, ref, rig, type Rig } from "./helpers.ts";
import {
  GEMINI_NOT_CHAT,
  OMP_PATH,
  OMP_REPO,
  OPENROUTER_BATCH,
  OPENROUTER_CAP,
  OPENROUTER_VENDORS,
  anthropicCacheMin,
  buildCatalog,
  decodeOmpCatalog,
  isCompactCatalog,
  isOpenAiResponsesOnly,
  parseArgs,
  serializeCatalog,
  sourceUrl,
  type OmpCatalog,
  type OmpEntry,
} from "../../scripts/build-catalog.ts";

const CATALOG_DIR = fileURLToPath(new URL("../../catalog/", import.meta.url));
const MODELS_TEXT = readFileSync(join(CATALOG_DIR, "models.json"), "utf8");
const FILE = JSON.parse(MODELS_TEXT) as CatalogFile;
const COMMIT = "c29f7c56f5530d805bb2887ade964aa55970d8e1";

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---- The committed catalog/models.json ---------------------------------------------------

describe("catalog/models.json", () => {
  test("version 1, then source, then models", () => {
    expect(FILE.version).toBe(1);
    expect(Object.keys(FILE)).toEqual(["version", "source", "models"]);
    expect(Object.keys(FILE.source)).toEqual(["repo", "path", "commit", "license"]);
    expect(FILE.source.repo).toBe(OMP_REPO);
    expect(FILE.source.path).toBe(OMP_PATH);
    expect(FILE.source.license).toBe("MIT");
  });

  test("source.commit is 40 hex, and CATALOG_SOURCE is that object", () => {
    expect(FILE.source.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(CATALOG_SOURCE).toEqual(FILE.source);
  });

  test("the file is exactly what serializeCatalog writes: 2-space indent, one final newline", () => {
    expect(MODELS_TEXT).toBe(serializeCatalog(FILE));
    expect(MODELS_TEXT.endsWith("}\n")).toBe(true);
    expect(MODELS_TEXT.includes("\r")).toBe(false);
  });

  test("sorted by provider and then id, with no duplicates", () => {
    const keys = FILE.models.map((m) => `${m.provider}\0${m.id}`);
    expect(keys).toEqual([...keys].sort(cmp));
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every entry has the ModelInfo fields in order, with usable numbers", () => {
    expect(FILE.models.length).toBeGreaterThan(0);
    for (const m of FILE.models) {
      const where = `${m.provider}/${m.id}`;
      expect(Object.keys(m), where).toEqual([
        "provider",
        "id",
        "name",
        "context_window",
        "max_output",
        "price",
        "tool_call",
        "reasoning",
        "cache_min_tokens",
      ]);
      expect(Object.keys(m.price), where).toEqual(["input", "output", "cache_read", "cache_write"]);
      expect(typeof m.name, where).toBe("string");
      expect(m.context_window, where).toBeGreaterThan(0);
      expect(Number.isInteger(m.max_output) && m.max_output >= 0, where).toBe(true);
      for (const [k, v] of Object.entries(m.price)) {
        expect(Number.isFinite(v) && v >= 0, `${where} price.${k}`).toBe(true);
      }
      expect(typeof m.tool_call, where).toBe("boolean");
      expect(typeof m.reasoning, where).toBe("boolean");
    }
  });

  test("every provider is a real non-fake id, and all five are there", () => {
    const providers = new Set(FILE.models.map((m) => m.provider));
    for (const p of providers) {
      expect(PROVIDER_IDS, p).toContain(p);
      expect(p).not.toBe("fake");
    }
    expect([...providers].sort()).toEqual(["anthropic", "deepseek", "gemini", "openai", "openrouter"]);
  });

  test("every Anthropic entry has a cache_min_tokens in {512, 1024, 2048, 4096}, and it is the table's", () => {
    const anthropic = FILE.models.filter((m) => m.provider === "anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
    for (const m of anthropic) {
      expect([512, 1024, 2048, 4096], m.id).toContain(m.cache_min_tokens as number);
      expect(m.cache_min_tokens, m.id).toBe(anthropicCacheMin(m.id));
    }
  });

  test("every OpenAI entry has 1024, and none is Responses-only; the others have null", () => {
    for (const m of FILE.models) {
      if (m.provider === "openai") {
        expect(m.cache_min_tokens, m.id).toBe(1024);
        expect(isOpenAiResponsesOnly(m.id), m.id).toBe(false);
      } else if (m.provider !== "anthropic") {
        expect(m.cache_min_tokens, `${m.provider}/${m.id}`).toBeNull();
      }
    }
  });

  test("Anthropic sonnet-5 is in the 1024 row and sonnet-5-5 in the 512 one", () => {
    const get = (id: string) => FILE.models.find((m) => m.provider === "anthropic" && m.id === id);
    expect(get("claude-sonnet-5")?.cache_min_tokens).toBe(1024);
    expect(get("claude-sonnet-5-5")?.cache_min_tokens).toBe(512);
  });

  test("OpenRouter: all ten vendors are there, none is cut by the cap, and no id ends :batch", () => {
    const or = FILE.models.filter((m) => m.provider === "openrouter");
    expect(or.length).toBeGreaterThan(0);
    expect(or.length).toBeLessThan(OPENROUTER_CAP); // the cap is a safety limit and cuts nothing
    for (const m of or) {
      expect(OPENROUTER_VENDORS.has(m.id.split("/")[0]!), m.id).toBe(true);
      expect(OPENROUTER_BATCH.test(m.id), m.id).toBe(false);
    }
    expect(new Set(or.map((m) => m.id.split("/")[0]))).toEqual(new Set(OPENROUTER_VENDORS));
  });

  test("Gemini has none of the ids the OpenAI-compatible chat endpoint can't serve", () => {
    const gemini = FILE.models.filter((m) => m.provider === "gemini");
    expect(gemini.length).toBeGreaterThan(0);
    for (const m of gemini) expect(GEMINI_NOT_CHAT.test(m.id), m.id).toBe(false);
  });

  test("ATTRIBUTION.md names OMP, the licence and its holders", () => {
    const text = readFileSync(join(CATALOG_DIR, "ATTRIBUTION.md"), "utf8");
    expect(text).toContain("https://github.com/can1357/oh-my-pi");
    expect(text).toContain("packages/catalog/src/models.json");
    expect(text).toContain("source.commit");
    expect(text).toContain("MIT License");
    expect(text).toContain("Permission is hereby granted, free of charge");
    expect(text).toContain("Copyright (c) 2025-2026 Can Bölük");
    expect(text).toContain("Copyright (c) 2026 Stencil Labs, Inc.");
    expect(text).toContain("Copyright (c) 2025 Mario Zechner");
    expect(text).toContain("stencil.so");
    expect(text).toContain("OpenCode");
  });
});

// ---- buildCatalog on OMP-shaped fixtures -------------------------------------------------

function entry(over: OmpEntry & { id: string }): OmpEntry {
  return {
    name: over.id,
    reasoning: false,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...over,
  };
}

/** The five OMP providers, each from a list of entries; one left out is an empty provider. */
function omp(parts: Partial<Record<"anthropic" | "openai" | "deepseek" | "openrouter" | "google", OmpEntry[]>>): OmpCatalog {
  const out: OmpCatalog = {};
  for (const p of ["anthropic", "openai", "deepseek", "openrouter", "google"] as const) {
    out[p] = Object.fromEntries((parts[p] ?? []).map((e) => [e.id!, e]));
  }
  return out;
}

function build(parts: Parameters<typeof omp>[0]): ModelInfo[] {
  return buildCatalog(omp(parts), { commit: COMMIT }).models;
}

function ids(models: ModelInfo[], provider: string): string[] {
  return models.filter((m) => m.provider === provider).map((m) => m.id);
}

describe("buildCatalog", () => {
  test("maps one entry per provider, with google renamed gemini and the fields in order", () => {
    const file = buildCatalog(
      omp({
        anthropic: [
          entry({
            id: "claude-sonnet-5",
            name: "Claude Sonnet 5",
            reasoning: true,
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
          }),
        ],
        google: [entry({ id: "gemini-x", name: "Gemini X", maxTokens: null })],
        deepseek: [entry({ id: "deepseek-x", supportsTools: false })],
      }),
      { commit: COMMIT },
    );
    expect(file.version).toBe(1);
    expect(file.source).toEqual({ repo: "can1357/oh-my-pi", path: "packages/catalog/src/models.json", commit: COMMIT, license: "MIT" });
    expect(file.models).toEqual([
      {
        provider: "anthropic",
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        context_window: 1_000_000,
        max_output: 128_000,
        price: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
        tool_call: true,
        reasoning: true,
        cache_min_tokens: 1024, // the sonnet-5 row
      },
      {
        provider: "deepseek",
        id: "deepseek-x",
        name: "deepseek-x",
        context_window: 1000,
        max_output: 100,
        price: { input: 1, output: 2, cache_read: 0.5, cache_write: 0 },
        tool_call: false,
        reasoning: false,
        cache_min_tokens: null,
      },
      {
        provider: "gemini",
        id: "gemini-x",
        name: "Gemini X",
        context_window: 1000,
        max_output: 0,
        price: { input: 1, output: 2, cache_read: 0.5, cache_write: 0 },
        tool_call: true,
        reasoning: false,
        cache_min_tokens: null,
      },
    ]);
    for (const m of file.models) {
      expect(Object.keys(m)).toEqual(["provider", "id", "name", "context_window", "max_output", "price", "tool_call", "reasoning", "cache_min_tokens"]);
      expect(Object.keys(m.price)).toEqual(["input", "output", "cache_read", "cache_write"]);
    }
    expect(file.models.some((m) => m.provider === "google")).toBe(false);
  });

  test("sorts by provider and then id, in plain code-unit order, whatever the input order", () => {
    const parts = {
      anthropic: [entry({ id: "claude-opus-5" }), entry({ id: "claude-fable-5" })],
      openai: [entry({ id: "o3" }), entry({ id: "gpt-5" }), entry({ id: "GPT-x" })],
      google: [entry({ id: "gemini-b" }), entry({ id: "gemini-a" })],
    };
    const models = build(parts);
    expect(models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-5",
      "gemini/gemini-a",
      "gemini/gemini-b",
      "openai/GPT-x", // uppercase sorts before lowercase
      "openai/gpt-5",
      "openai/o3",
    ]);
    const reversed = { anthropic: [...parts.anthropic].reverse(), openai: [...parts.openai].reverse(), google: [...parts.google].reverse() };
    expect(serializeCatalog(buildCatalog(omp(reversed), { commit: COMMIT }))).toBe(
      serializeCatalog(buildCatalog(omp(parts), { commit: COMMIT })),
    );
  });

  test("an entry with a kind is dropped, as is one without text input", () => {
    const models = build({
      google: [
        entry({ id: "keep" }),
        entry({ id: "image", kind: "image" }),
        entry({ id: "stt", kind: "stt" }),
        entry({ id: "embedding", kind: "embedding" }),
        entry({ id: "judge", kind: "judge" }),
        entry({ id: "rerank", kind: "rerank" }),
        entry({ id: "video", kind: "video" }),
        entry({ id: "audio-only", input: ["audio"] }),
        entry({ id: "no-input", input: [] }),
        entry({ id: "text-and-image", input: ["image", "text"] }),
      ],
    });
    expect(ids(models, "gemini")).toEqual(["keep", "text-and-image"]);
  });

  test("a null, zero or missing context window is dropped, as is a missing cost", () => {
    const noWindow = entry({ id: "no-window" });
    delete noWindow.contextWindow;
    const noCost = entry({ id: "no-cost" });
    delete noCost.cost;
    const models = build({
      deepseek: [
        entry({ id: "keep" }),
        entry({ id: "null-window", contextWindow: null }),
        entry({ id: "zero-window", contextWindow: 0 }),
        noWindow,
        entry({ id: "null-cost", cost: null }),
        noCost,
      ],
    });
    expect(ids(models, "deepseek")).toEqual(["keep"]);
  });

  test("a negative price (a router with a variable price) is dropped; missing cache prices are 0", () => {
    const models = build({
      deepseek: [
        entry({ id: "router", cost: { input: -1_000_000, output: -1_000_000, cacheRead: 0, cacheWrite: 0 } }),
        entry({ id: "no-cache-prices", cost: { input: 1, output: 2 } }),
        entry({ id: "free", cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      ],
    });
    expect(models.map((m) => m.id)).toEqual(["free", "no-cache-prices"]);
    expect(models.find((m) => m.id === "no-cache-prices")!.price).toEqual({ input: 1, output: 2, cache_read: 0, cache_write: 0 });
  });

  test("prices lose float noise from per-token strings times 1e6", () => {
    const [m] = build({ deepseek: [entry({ id: "x", cost: { input: 0.7999999999999999, output: 0.09999999999999999, cacheRead: 0.0375, cacheWrite: 0.083333333 } })] });
    expect(m!.price).toEqual({ input: 0.8, output: 0.1, cache_read: 0.0375, cache_write: 0.083333333 });
  });

  test("tool_call is supportsTools !== false, and the api says nothing, for OpenAI too", () => {
    const models = build({
      openai: [
        entry({ id: "gpt-a", api: "openai-responses" }),
        entry({ id: "gpt-b", api: "openai-responses", supportsTools: false }),
        entry({ id: "gpt-c", api: "openai-completions", supportsTools: true }),
        entry({ id: "gpt-d", api: "something-else" }),
      ],
      google: [entry({ id: "g-a", supportsTools: false }), entry({ id: "g-b" })],
    });
    expect(Object.fromEntries(models.map((m) => [m.id, m.tool_call]))).toEqual({
      "gpt-a": true,
      "gpt-b": false,
      "gpt-c": true,
      "gpt-d": true,
      "g-a": false,
      "g-b": true,
    });
  });

  test("reasoning is true only for reasoning === true; max_output is maxTokens or 0", () => {
    const models = build({
      deepseek: [
        entry({ id: "a", reasoning: true, maxTokens: 64 }),
        entry({ id: "b", reasoning: false, maxTokens: null }),
        entry({ id: "c", maxTokens: 0 }),
      ],
    });
    expect(models.map((m) => [m.id, m.reasoning, m.max_output])).toEqual([
      ["a", true, 64],
      ["b", false, 0],
      ["c", false, 0],
    ]);
  });

  test("a missing name falls back to the id", () => {
    const e = entry({ id: "nameless" });
    delete e.name;
    expect(build({ deepseek: [e] })[0]!.name).toBe("nameless");
  });

  test("OpenAI: ids that work only on the Responses API are dropped", () => {
    const dropped = [
      "o1-pro",
      "o3-pro",
      "gpt-5-pro",
      "gpt-5.2-pro",
      "gpt-5.6-luna-pro",
      "codex-mini-latest",
      "gpt-5-codex",
      "gpt-5.1-codex-max",
      "gpt-5.3-codex-spark",
      "o3-deep-research",
      "o4-mini-deep-research",
      "gpt-realtime-2.1",
      "gpt-5-computer-use-preview",
    ];
    const kept = ["gpt-4o", "gpt-4.1-mini", "gpt-5", "gpt-5-chat-latest", "gpt-5.6-sol", "o1", "o3", "o3-mini", "o4-mini", "gpt-5.5-prompt"];
    const models = build({ openai: [...dropped, ...kept].map((id) => entry({ id, api: "openai-responses" })) });
    expect(ids(models, "openai")).toEqual([...kept].sort(cmp));
  });

  test("OpenAI: a virtual alias (requestModelId names another id) is dropped, a self-reference is not", () => {
    const models = build({
      openai: [
        entry({ id: "gpt-5.6-luna" }),
        entry({ id: "gpt-5.6-luna-fast", requestModelId: "gpt-5.6-luna" }),
        entry({ id: "gpt-5.6-self", requestModelId: "gpt-5.6-self" }),
      ],
    });
    expect(ids(models, "openai")).toEqual(["gpt-5.6-luna", "gpt-5.6-self"]);
  });

  test("the Responses-only rule is OpenAI's alone: OpenRouter keeps the same words", () => {
    const models = build({ openrouter: [entry({ id: "openai/o3-pro" }), entry({ id: "openai/gpt-5-codex" })] });
    expect(ids(models, "openrouter")).toEqual(["openai/gpt-5-codex", "openai/o3-pro"]);
  });

  test("Gemini: ids the OpenAI-compatible chat endpoint can't serve are dropped", () => {
    const dropped = [
      "deep-research-max-preview-04-2026",
      "deep-research-preview-04-2026",
      "gemini-2.5-computer-use-preview-10-2025",
      "gemini-3.1-flash-live-preview",
      "gemini-live-2.5-flash",
      "gemini-live-2.5-flash-preview-native-audio",
      "gemini-robotics-er-1.6-preview",
    ];
    const kept = [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
      "gemini-3.1-flash-lite-preview",
      "gemini-flash-latest",
      "gemma-4-26b-it",
      "gemini-delivery-1", // "live" inside a word is not the Live API
      "gemini-olive-1",
      "gemini-alive",
    ];
    const models = build({ google: [...dropped, ...kept].map((id) => entry({ id })) });
    expect(ids(models, "gemini")).toEqual([...kept].sort(cmp));
    for (const id of dropped) expect(GEMINI_NOT_CHAT.test(id), id).toBe(true);
    for (const id of kept) expect(GEMINI_NOT_CHAT.test(id), id).toBe(false);
  });

  test("the Gemini rule is Gemini's alone: OpenRouter and OpenAI keep the same words", () => {
    const models = build({
      openrouter: [entry({ id: "google/gemini-live-2.5-flash" }), entry({ id: "google/gemini-2.5-computer-use-preview" })],
      openai: [entry({ id: "gpt-live-chat" }), entry({ id: "gpt-robotics-1" })],
    });
    expect(ids(models, "openrouter")).toEqual(["google/gemini-2.5-computer-use-preview", "google/gemini-live-2.5-flash"]);
    expect(ids(models, "openai")).toEqual(["gpt-live-chat", "gpt-robotics-1"]);
  });

  test("isOpenAiResponsesOnly, by id and alias", () => {
    for (const id of ["o1-pro", "o3-pro", "gpt-5-pro", "gpt-5.4-pro", "codex-mini-latest", "gpt-5-codex", "o3-deep-research", "gpt-realtime-2.1", "x-computer-use-y"]) {
      expect(isOpenAiResponsesOnly(id), id).toBe(true);
    }
    for (const id of ["gpt-5", "o3", "o1", "gpt-4o", "gpt-5-chat-latest", "pro", "gpt-5-proxy", "o3-mini"]) {
      expect(isOpenAiResponsesOnly(id), id).toBe(false);
    }
    expect(isOpenAiResponsesOnly("gpt-5.6-sol-fast", "gpt-5.6-sol")).toBe(true);
    expect(isOpenAiResponsesOnly("gpt-5.6-sol", "gpt-5.6-sol")).toBe(false);
    expect(isOpenAiResponsesOnly("gpt-5.6-sol", "")).toBe(false);
    expect(isOpenAiResponsesOnly("gpt-5.6-sol", undefined)).toBe(false);
  });

  test("OpenRouter: only the listed vendors, sorted, and capped at 300 after sorting", () => {
    const pad = (n: number): string => String(n).padStart(3, "0");
    const many = Array.from({ length: 349 }, (_, i) => entry({ id: `qwen/m${pad(i)}` }));
    const models = build({
      openrouter: [
        ...many,
        entry({ id: "anthropic/b" }),
        entry({ id: "anthropic/a" }),
        entry({ id: "z-ai/glm" }), // sorts last, so the cap cuts it
        entry({ id: "ai21/jamba" }), // not a listed vendor
        entry({ id: "~anthropic/claude" }), // OpenRouter's alias namespace
        entry({ id: "qwen" }), // no vendor segment
      ],
    });
    const got = ids(models, "openrouter");
    expect(got.length).toBe(OPENROUTER_CAP);
    expect(got.slice(0, 2)).toEqual(["anthropic/a", "anthropic/b"]);
    expect(got.at(-1)).toBe("qwen/m297");
    expect(got).toEqual([...got].sort(cmp));
    expect(got.some((id) => id.startsWith("z-ai/") || id.startsWith("ai21/") || id.startsWith("~") || id === "qwen")).toBe(false);
  });

  test("OpenRouter: ids ending :batch are dropped before the vendor list and the cap", () => {
    const pad = (n: number): string => String(n).padStart(3, "0");
    // 299 plain ids, each followed in sort order by its :batch twin, then z-ai/glm last of all.
    // Were :batch dropped after the cap, the first 300 would stop near qwen/m149 and z-ai/glm would be cut.
    const plain = Array.from({ length: 299 }, (_, i) => entry({ id: `qwen/m${pad(i)}` }));
    const twins = plain.map((e) => entry({ id: `${e.id}:batch` }));
    const models = build({
      openrouter: [
        ...plain,
        ...twins,
        entry({ id: "z-ai/glm" }),
        entry({ id: "anthropic/claude-x:batch" }),
        entry({ id: "anthropic/claude-x" }),
        entry({ id: "anthropic/batch" }), // "batch" elsewhere in the id is fine
        entry({ id: "anthropic/claude-y:batch-extra" }), // so is a longer suffix
        entry({ id: "anthropic/claude-y:free" }),
      ],
    });
    const got = ids(models, "openrouter");
    expect(got.length).toBe(OPENROUTER_CAP); // 299 + z-ai/glm + 4 anthropic ids, cut at 300
    expect(got.some((id) => id.endsWith(":batch"))).toBe(false);
    expect(got.slice(0, 4)).toEqual(["anthropic/batch", "anthropic/claude-x", "anthropic/claude-y:batch-extra", "anthropic/claude-y:free"]);
    expect(got.at(-1)).toBe("qwen/m295"); // 4 + 296 plain ids; the cap now cuts qwen/m296.. and z-ai/glm
    expect(OPENROUTER_BATCH.test("a/b:batch")).toBe(true);
    expect(OPENROUTER_BATCH.test("a/b:batch-extra")).toBe(false);
    expect(OPENROUTER_BATCH.test("a/batch")).toBe(false);
  });

  test("OpenRouter: with :batch gone a full list fits under the cap and keeps its last vendors", () => {
    const pad = (n: number): string => String(n).padStart(3, "0");
    const plain = Array.from({ length: 250 }, (_, i) => entry({ id: `qwen/m${pad(i)}` }));
    const models = build({
      openrouter: [...plain, ...plain.map((e) => entry({ id: `${e.id}:batch` })), entry({ id: "x-ai/grok" }), entry({ id: "z-ai/glm" })],
    });
    const got = ids(models, "openrouter");
    expect(got.length).toBe(252);
    expect(got.slice(-2)).toEqual(["x-ai/grok", "z-ai/glm"]);
  });

  test("OpenRouter: all ten vendors pass when they fit", () => {
    const vendors = ["anthropic", "openai", "google", "deepseek", "qwen", "meta-llama", "mistralai", "x-ai", "moonshotai", "z-ai"];
    const models = build({ openrouter: vendors.map((v) => entry({ id: `${v}/m` })) });
    expect(ids(models, "openrouter")).toEqual(vendors.map((v) => `${v}/m`).sort(cmp));
  });

  test("cache_min_tokens: Anthropic from the table, OpenAI 1024, everything else null", () => {
    const models = build({
      anthropic: [
        entry({ id: "claude-opus-5-5" }),
        entry({ id: "claude-opus-4-8" }),
        entry({ id: "claude-opus-4-7" }),
        entry({ id: "claude-opus-4-6" }),
      ],
      openai: [entry({ id: "gpt-5" })],
      deepseek: [entry({ id: "deepseek-x" })],
      openrouter: [entry({ id: "anthropic/claude-x" })],
      google: [entry({ id: "gemini-x" })],
    });
    expect(Object.fromEntries(models.map((m) => [`${m.provider}/${m.id}`, m.cache_min_tokens]))).toEqual({
      "anthropic/claude-opus-4-6": 4096,
      "anthropic/claude-opus-4-7": 2048,
      "anthropic/claude-opus-4-8": 1024,
      "anthropic/claude-opus-5-5": 512,
      "deepseek/deepseek-x": null,
      "gemini/gemini-x": null,
      "openai/gpt-5": 1024,
      "openrouter/anthropic/claude-x": null,
    });
  });

  test("anthropicCacheMin: dated and -latest ids match their row, and rows don't bleed into each other", () => {
    expect(anthropicCacheMin("claude-sonnet-4-5-20250929")).toBe(1024);
    expect(anthropicCacheMin("claude-haiku-4-5-20251001")).toBe(4096);
    expect(anthropicCacheMin("claude-haiku-4-5-latest")).toBe(4096);
    expect(anthropicCacheMin("claude-opus-4-20250514")).toBe(1024); // the opus-4 row
    expect(anthropicCacheMin("claude-opus-4-5-20251101")).toBe(4096); // the opus-4-5 row
    expect(anthropicCacheMin("claude-opus-4-1")).toBe(1024);
    expect(anthropicCacheMin("claude-haiku-3-5-20241022")).toBe(2048);
    expect(anthropicCacheMin("claude-mythos-preview")).toBe(2048);
    expect(anthropicCacheMin("claude-fable-5-1")).toBe(512);
    expect(anthropicCacheMin("claude-sonnet-5")).toBe(1024); // moved from 512 on 2026-10-31
    expect(anthropicCacheMin("claude-sonnet-5-20261001")).toBe(1024);
    expect(anthropicCacheMin("claude-sonnet-5-5")).toBe(512); // the row next to it stays
    expect(anthropicCacheMin("claude-opus-5")).toBe(512);
    for (const id of ["claude-opus-4-5-2025", "claude-sonnet-9", "claude-sonnet-4-5-preview", "gpt-5", "claude-opus-4-5-latest-x"]) {
      expect(() => anthropicCacheMin(id), id).toThrow(`add a cache_min_tokens row for ${id}`);
    }
  });

  test("an unlisted Anthropic id stops the build with the id in the message", () => {
    expect(() => build({ anthropic: [entry({ id: "claude-opus-4-5" }), entry({ id: "claude-newmodel-9" })] })).toThrow(
      "add a cache_min_tokens row for claude-newmodel-9",
    );
  });

  test("an unlisted Anthropic id that the filters drop does not stop the build", () => {
    const models = build({ anthropic: [entry({ id: "claude-opus-4-5" }), entry({ id: "claude-embed-9", kind: "embedding" }), entry({ id: "claude-null-9", contextWindow: null })] });
    expect(ids(models, "anthropic")).toEqual(["claude-opus-4-5"]);
  });

  test("the same input gives the same bytes twice, and the bytes end in one newline", () => {
    const src = omp({ anthropic: [entry({ id: "claude-opus-5" })], google: [entry({ id: "gemini-x" })], openai: [entry({ id: "gpt-5" })] });
    const a = serializeCatalog(buildCatalog(src, { commit: COMMIT }));
    const b = serializeCatalog(buildCatalog(structuredClone(src), { commit: COMMIT }));
    expect(a).toBe(b);
    expect(a.endsWith("}\n")).toBe(true);
    expect(a.endsWith("\n\n")).toBe(false);
    expect(a.startsWith('{\n  "version": 1,\n  "source": {\n')).toBe(true);
    expect(a).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no timestamp
  });

  test("a provider missing from the input stops the build", () => {
    expect(() => buildCatalog({}, { commit: COMMIT })).toThrow('no provider "anthropic"');
    const src = omp({});
    delete src.google;
    expect(() => buildCatalog(src, { commit: COMMIT })).toThrow('no provider "google"');
  });

  test("a commit that is not 40 lowercase hex stops the build", () => {
    for (const commit of ["", "main", "c29f7c5", COMMIT.toUpperCase(), COMMIT + "0"]) {
      expect(() => buildCatalog(omp({}), { commit }), commit).toThrow("40 lowercase hex");
    }
  });
});

// ---- The decoder for OMP's compact format ------------------------------------------------

// Hand-built, in the format of OMP's model-catalog-format.ts. A value is a scalar, [n] (node n) or [-1] (undefined).
const COMPACT = {
  version: 1,
  keys: ["api", "contextWindow", "cost", "input", "output", "cacheRead", "reasoning", "supportsTools", "name", "note"],
  booleanShapes: [[], [6, 7]],
  nodes: [
    [1, ["text", "image"]], // 0: the shared input array
    [0, [3, 5, 4, 10, 5, 1], 0, []], // 1: the shared cost object {input: 5, output: 10, cacheRead: 1}
    [0, [0, "const-api"], 0, []], // 2: the provider's constants {api}
    // 3: row a. Booleans, in shape 1's order (reasoning, supportsTools): bits 0 and 1 set, mask 3.
    [0, [8, "Model A", 2, [1], 3, [0], 1, 1000, 9, [-1]], 1, [3]],
    // 4: row b. reasoning false, supportsTools true: mask 2. Its own api beats the constant.
    [0, [8, "Model B", 2, [1], 3, [0], 1, 2000, 0, "own-api"], 1, [2]],
  ],
  compat: [],
  providers: [["prov", [2], [["a", [3]], ["b", [4]]]]],
};

describe("decodeOmpCatalog", () => {
  test("object nodes, constants, a shared node, boolean bits and an explicit undefined", () => {
    const out = decodeOmpCatalog(structuredClone(COMPACT));
    expect(Object.keys(out)).toEqual(["prov"]);
    expect(Object.keys(out.prov!)).toEqual(["a", "b"]);
    const a = out.prov!.a! as Record<string, unknown>;
    const b = out.prov!.b! as Record<string, unknown>;
    expect(a).toEqual({
      id: "a",
      api: "const-api", // from the provider's constants
      name: "Model A",
      cost: { input: 5, output: 10, cacheRead: 1 },
      input: ["text", "image"],
      contextWindow: 1000,
      reasoning: true,
      supportsTools: true,
    });
    expect(b).toEqual({
      id: "b",
      api: "own-api", // the row beats the constant
      name: "Model B",
      cost: { input: 5, output: 10, cacheRead: 1 },
      input: ["text", "image"],
      contextWindow: 2000,
      reasoning: false, // a false bit
      supportsTools: true, // a true bit
    });
    // [-1] is an own key holding undefined; row b has no such key.
    expect(Object.hasOwn(a, "note")).toBe(true);
    expect(a.note).toBeUndefined();
    expect(Object.hasOwn(b, "note")).toBe(false);
    // Nodes are decoded once and shared.
    expect(a.cost).toBe(b.cost);
    expect(a.input).toBe(b.input);
  });

  test("boolean masks span 32-bit words", () => {
    const keys = Array.from({ length: 34 }, (_, i) => `k${i}`);
    const out = decodeOmpCatalog({
      version: 1,
      keys,
      booleanShapes: [keys.map((_, i) => i), []],
      nodes: [
        [0, [], 1, []],
        [0, [], 0, [4294967295, 2]], // word 0: all 32 set. word 1: bit 1 (k33) set, bit 0 (k32) clear.
      ],
      compat: [],
      providers: [["p", [0], [["m", [1]]]]],
    });
    const m = out.p!.m! as Record<string, unknown>;
    for (let i = 0; i < 32; i++) expect(m[`k${i}`], `k${i}`).toBe(true);
    expect(m.k32).toBe(false);
    expect(m.k33).toBe(true);
  });

  test("a key named __proto__ stays an own key", () => {
    const out = decodeOmpCatalog({
      version: 1,
      keys: ["__proto__"],
      booleanShapes: [[]],
      nodes: [
        [0, [], 0, []],
        [0, [0, "x"], 0, []],
      ],
      compat: [],
      providers: [["p", [0], [["m", [1]]]]],
    });
    const m = out.p!.m! as Record<string, unknown>;
    expect(Object.hasOwn(m, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(m)).toBe(Object.prototype);
  });

  test("an array node holds references and scalars", () => {
    const out = decodeOmpCatalog({
      version: 1,
      keys: ["list", "obj"],
      booleanShapes: [[]],
      nodes: [
        [0, [], 0, []],
        [0, [0, [2], 1, [3]], 0, []],
        [1, ["a", 1, null, [3], [-1]]],
        [0, [], 0, []],
      ],
      compat: [],
      providers: [["p", [0], [["m", [1]]]]],
    });
    const m = out.p!.m! as Record<string, unknown>;
    expect(m.list).toEqual(["a", 1, null, {}, undefined]);
    expect((m.list as unknown[])[3]).toBe(m.obj);
  });

  test("the decoded result goes straight into buildCatalog", () => {
    // The fixture's own provider is not one we map, so rename it by hand to get through the build.
    const plain = decodeOmpCatalog(structuredClone(COMPACT));
    const src = omp({});
    src.deepseek = plain.prov!;
    const models = buildCatalog(src, { commit: COMMIT }).models;
    expect(models.map((m) => [m.provider, m.id, m.name, m.context_window, m.reasoning, m.tool_call])).toEqual([
      ["deepseek", "a", "Model A", 1000, true, true],
      ["deepseek", "b", "Model B", 2000, false, true],
    ]);
  });

  test("isCompactCatalog tells the two formats apart", () => {
    expect(isCompactCatalog(COMPACT)).toBe(true);
    expect(isCompactCatalog(omp({}))).toBe(false);
    expect(isCompactCatalog(null)).toBe(false);
    expect(isCompactCatalog([])).toBe(false);
    expect(isCompactCatalog({ nodes: [], providers: [] })).toBe(false); // keys missing
  });

  test("another version, or the plain format, is refused", () => {
    expect(() => decodeOmpCatalog({ ...COMPACT, version: 2 })).toThrow("version 2");
    expect(() => decodeOmpCatalog(omp({}))).toThrow("not an OMP compact catalog");
    expect(() => decodeOmpCatalog({ ...structuredClone(COMPACT), providers: [["p", [2], [["a", [99]]]]] })).toThrow("invalid row");
    expect(() => decodeOmpCatalog({ ...structuredClone(COMPACT), providers: [["p", [2], [["a", "oops"]]]] })).toThrow("invalid row");
  });
});

describe("the command line", () => {
  test("--commit is required and must be 40 lowercase hex", () => {
    expect(() => parseArgs([])).toThrow("--commit is required");
    expect(() => parseArgs(["--commit", "main"])).toThrow("40 lowercase hex");
    expect(() => parseArgs(["--file", "x.json"])).toThrow("--commit is required");
  });

  test("--file and --out, and the default output next to catalog/", () => {
    const a = parseArgs(["--commit", COMMIT]);
    expect(a.file).toBeNull();
    expect(a.out).toBe(join(CATALOG_DIR, "models.json"));
    const b = parseArgs(["--commit", COMMIT, "--file", "in.json", "--out", "out.json"]);
    expect(b).toEqual({ commit: COMMIT, file: "in.json", out: "out.json" });
  });

  test("an unknown flag or a flag without a value is refused", () => {
    expect(() => parseArgs(["--commit", COMMIT, "--frobnicate", "1"])).toThrow("unknown argument --frobnicate");
    expect(() => parseArgs(["--commit"])).toThrow("--commit needs a value");
    expect(() => parseArgs(["--commit", COMMIT, "--file"])).toThrow("--file needs a value");
    expect(() => parseArgs(["--commit", "--file", "x"])).toThrow("--commit needs a value");
  });

  test("the download URL is the raw file at the commit", () => {
    expect(sourceUrl(COMMIT)).toBe(`https://raw.githubusercontent.com/can1357/oh-my-pi/${COMMIT}/packages/catalog/src/models.json`);
  });
});

// ---- Catalog ------------------------------------------------------------------------------

function info(provider: string, id: string, over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    provider,
    id,
    name: id,
    context_window: 50_000,
    max_output: 4096,
    price: { input: 1, output: 2, cache_read: 0.1, cache_write: 1.25 },
    tool_call: true,
    reasoning: false,
    cache_min_tokens: null,
    ...over,
  };
}

function writeRefreshed(home: string, providers: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(refreshedModelsPath(home), JSON.stringify({ version: 1, providers }));
}

function readRefreshed(home: string): { version: number; providers: Record<string, ModelInfo[]> } {
  return JSON.parse(readFileSync(refreshedModelsPath(home), "utf8"));
}

describe("Catalog", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rlmh-catalog-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const SAMPLE = FILE.models.find((m) => m.provider === "anthropic")!;

  test("loads the bundled models, sorted, and nothing is written to the home", () => {
    const catalog = new Catalog(home);
    expect(catalog.models()).toEqual(FILE.models);
    expect(readdirSync(home)).toEqual([]);
  });

  test("models(provider) filters, and an unknown provider has none", () => {
    const catalog = new Catalog(home);
    expect(catalog.models("anthropic")).toEqual(FILE.models.filter((m) => m.provider === "anthropic"));
    expect(catalog.models("local")).toEqual([]);
    expect(catalog.models("nope")).toEqual([]);
  });

  test("get finds a bundled entry, and gives undefined for an id the catalog doesn't know", () => {
    const catalog = new Catalog(home);
    expect(catalog.get("anthropic", SAMPLE.id)).toEqual(SAMPLE);
    expect(catalog.get("anthropic", "claude-not-a-model")).toBeUndefined();
    expect(catalog.get("local", "my-model")).toBeUndefined();
    expect(catalog.get("openrouter", FILE.models.find((m) => m.provider === "openrouter")!.id)).toBeDefined();
  });

  test("models() hands out a fresh array each time", () => {
    const catalog = new Catalog(home);
    const first = catalog.models();
    first.length = 0;
    expect(catalog.models()).toEqual(FILE.models);
  });

  test("two Catalogs are independent", () => {
    const other = mkdtempSync(join(tmpdir(), "rlmh-catalog-"));
    try {
      const a = new Catalog(home);
      const b = new Catalog(other);
      a.merge("anthropic", [info("anthropic", "claude-only-in-a")]);
      expect(a.get("anthropic", "claude-only-in-a")).toBeDefined();
      expect(b.get("anthropic", "claude-only-in-a")).toBeUndefined();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("fake/scripted is found by get and hidden from models()", () => {
    const catalog = new Catalog(home);
    expect(catalog.models().some((m) => m.provider === "fake")).toBe(false);
    expect(catalog.models("fake")).toEqual([]);
    const fake = catalog.get("fake", "scripted");
    expect(fake).toEqual({
      provider: "fake",
      id: "scripted",
      name: "Scripted fake",
      context_window: 1_000_000,
      max_output: 0,
      price: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
      tool_call: true,
      reasoning: false,
      cache_min_tokens: null,
    });
    expect(fake).toBe(FAKE_MODEL);
    expect(catalog.get("fake", "other")).toBeUndefined();
  });

  test("the overlay is read over the bundled list: it replaces by id, adds new ids and keeps the rest", () => {
    const changed = { ...SAMPLE, price: { ...SAMPLE.price, input: 99 }, context_window: 123 };
    const added = info("anthropic", "claude-zzz-new");
    const local = info("local", "my-model", { context_window: 8192 });
    writeRefreshed(home, { anthropic: [changed, added], local: [local] });

    const catalog = new Catalog(home);
    expect(catalog.get("anthropic", SAMPLE.id)).toEqual(changed);
    expect(catalog.get("anthropic", "claude-zzz-new")).toEqual(added);
    expect(catalog.get("local", "my-model")).toEqual(local);
    // Everything else is the bundled entry.
    const rest = FILE.models.filter((m) => m.id !== SAMPLE.id);
    for (const m of rest) expect(catalog.get(m.provider, m.id)).toEqual(m);
    expect(catalog.models().length).toBe(FILE.models.length + 2);
    // Sorted by provider and then id, the new ids in their places.
    const listed = catalog.models().map((m) => `${m.provider}\0${m.id}`);
    expect(listed).toEqual([...listed].sort(cmp));
    expect(catalog.models("local")).toEqual([local]);
  });

  test("the overlay can't replace or add to the fake provider", () => {
    writeRefreshed(home, { fake: [info("fake", "scripted", { context_window: 5 }), info("fake", "other")] });
    const catalog = new Catalog(home);
    expect(catalog.get("fake", "scripted")).toBe(FAKE_MODEL);
    expect(catalog.get("fake", "other")).toBeUndefined();
    expect(catalog.models()).toEqual(FILE.models);
  });

  test("a missing overlay is ignored", () => {
    expect(existsSync(refreshedModelsPath(home))).toBe(false);
    expect(new Catalog(home).models()).toEqual(FILE.models);
    expect(new Catalog(join(home, "does", "not", "exist")).models()).toEqual(FILE.models);
  });

  test("a corrupt overlay is ignored, whatever way it is corrupt", () => {
    const bad: Array<[string, string]> = [
      ["empty", ""],
      ["not json", "{ this is not json"],
      ["truncated", '{"version": 1, "providers": {"anthropic": [{"provider": "anthr'],
      ["a binary file", "\u0000\u0001\u0002"],
      ["null", "null"],
      ["an array", "[]"],
      ["another version", JSON.stringify({ version: 2, providers: { anthropic: [info("anthropic", "claude-v2")] } })],
      ["no version", JSON.stringify({ providers: { anthropic: [info("anthropic", "claude-nov")] } })],
      ["providers is a list", JSON.stringify({ version: 1, providers: [info("anthropic", "claude-list")] })],
      ["providers is missing", JSON.stringify({ version: 1 })],
      ["a provider's list is an object", JSON.stringify({ version: 1, providers: { anthropic: { id: "x" } } })],
    ];
    for (const [what, text] of bad) {
      writeFileSync(refreshedModelsPath(home), text);
      const catalog = new Catalog(home);
      expect(catalog.models(), what).toEqual(FILE.models);
    }
  });

  test("an overlay entry that isn't a usable ModelInfo is skipped, and the good ones stay", () => {
    const good = info("anthropic", "claude-good");
    const providers: Record<string, unknown> = {
      anthropic: [
        good,
        { ...info("anthropic", "claude-neg"), price: { input: -1, output: 2, cache_read: 0, cache_write: 0 } },
        { ...info("anthropic", "claude-nan"), context_window: "big" },
        { ...info("anthropic", "claude-notool"), tool_call: "yes" },
        { ...info("anthropic", "claude-nocache"), cache_min_tokens: undefined },
        info("openai", "gpt-wrong-provider"),
        { ...info("anthropic", ""), id: "" },
        "a string",
        null,
      ],
    };
    // A literal `__proto__:` would set the prototype; defineProperty makes the own key JSON.stringify writes.
    Object.defineProperty(providers, "__proto__", { value: [info("__proto__", "x")], enumerable: true });
    writeRefreshed(home, providers);
    expect(readFileSync(refreshedModelsPath(home), "utf8")).toContain('"__proto__"');
    const catalog = new Catalog(home);
    expect(catalog.models("anthropic").map((m) => m.id)).toEqual([...FILE.models.filter((m) => m.provider === "anthropic").map((m) => m.id), "claude-good"].sort(cmp));
    expect(catalog.get("anthropic", "claude-good")).toEqual(good);
    expect(catalog.get("openai", "gpt-wrong-provider")).toBeUndefined();
    expect(catalog.models().length).toBe(FILE.models.length + 1);
  });

  test("a refreshed entry keeps only the ModelInfo fields, in order", () => {
    writeRefreshed(home, { local: [{ ...info("local", "m"), extra: "ignored", price: { ...info("local", "m").price, odd: 1 } }] });
    const got = new Catalog(home).get("local", "m")!;
    expect(Object.keys(got)).toEqual(["provider", "id", "name", "context_window", "max_output", "price", "tool_call", "reasoning", "cache_min_tokens"]);
    expect(Object.keys(got.price)).toEqual(["input", "output", "cache_read", "cache_write"]);
  });

  test("merge persists: a new Catalog on the same home sees the entries", () => {
    const a = info("openrouter", "vendor/a", { context_window: 111 });
    const b = info("openrouter", "vendor/b", { cache_min_tokens: 1024 });
    const catalog = new Catalog(home);
    catalog.merge("openrouter", [b, a]);
    expect(catalog.get("openrouter", "vendor/a")).toEqual(a);

    const again = new Catalog(home);
    expect(again.get("openrouter", "vendor/a")).toEqual(a);
    expect(again.get("openrouter", "vendor/b")).toEqual(b);
    expect(readRefreshed(home)).toEqual({ version: 1, providers: { openrouter: [a, b] } }); // sorted by id
    const text = readFileSync(refreshedModelsPath(home), "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toBe(JSON.stringify(readRefreshed(home), null, 2) + "\n");
  });

  test("merge writes atomically: only the refreshed file is left in the home", () => {
    const catalog = new Catalog(home);
    catalog.merge("anthropic", [info("anthropic", "claude-x")]);
    catalog.merge("anthropic", [info("anthropic", "claude-y")]);
    expect(readdirSync(home)).toEqual(["models-refreshed.json"]);
  });

  test("merge replaces by id and keeps the rest, across merges", () => {
    const catalog = new Catalog(home);
    catalog.merge("openrouter", [info("openrouter", "v/a"), info("openrouter", "v/b")]);
    catalog.merge("openrouter", [info("openrouter", "v/b", { context_window: 777 }), info("openrouter", "v/c")]);
    const want = [info("openrouter", "v/a"), info("openrouter", "v/b", { context_window: 777 }), info("openrouter", "v/c")];
    expect(readRefreshed(home).providers.openrouter).toEqual(want);
    expect(catalog.models("openrouter").filter((m) => m.id.startsWith("v/"))).toEqual(want);
    expect(new Catalog(home).models("openrouter").filter((m) => m.id.startsWith("v/"))).toEqual(want);
  });

  test("merge keeps another provider's refreshed entries", () => {
    const catalog = new Catalog(home);
    catalog.merge("openrouter", [info("openrouter", "v/a")]);
    catalog.merge("anthropic", [info("anthropic", "claude-x")]);
    expect(readRefreshed(home)).toEqual({
      version: 1,
      providers: { anthropic: [info("anthropic", "claude-x")], openrouter: [info("openrouter", "v/a")] },
    });
    const again = new Catalog(home);
    expect(again.get("openrouter", "v/a")).toBeDefined();
    expect(again.get("anthropic", "claude-x")).toBeDefined();
  });

  test("merge over a bundled entry replaces it and leaves the count alone; the other bundled entries stay", () => {
    const changed = { ...SAMPLE, name: "Renamed", price: { ...SAMPLE.price, output: 77 } };
    const catalog = new Catalog(home);
    catalog.merge("anthropic", [changed]);
    expect(catalog.get("anthropic", SAMPLE.id)).toEqual(changed);
    expect(catalog.models().length).toBe(FILE.models.length);
    expect(new Catalog(home).get("anthropic", SAMPLE.id)).toEqual(changed);
    const other = FILE.models.find((m) => m.provider === "anthropic" && m.id !== SAMPLE.id)!;
    expect(catalog.get("anthropic", other.id)).toEqual(other);
  });

  test("merge creates the home folder when it isn't there yet", () => {
    const nested = join(home, "not", "yet");
    new Catalog(nested).merge("local", [info("local", "m")]);
    expect(new Catalog(nested).get("local", "m")).toBeDefined();
  });

  test("merge over a corrupt overlay replaces it", () => {
    writeFileSync(refreshedModelsPath(home), "{ not json");
    const catalog = new Catalog(home);
    catalog.merge("local", [info("local", "m")]);
    expect(readRefreshed(home)).toEqual({ version: 1, providers: { local: [info("local", "m")] } });
    expect(new Catalog(home).get("local", "m")).toBeDefined();
  });

  test("merge skips an entry with an unusable field and keeps the rest", () => {
    const catalog = new Catalog(home);
    catalog.merge("local", [info("local", "good"), info("local", "nan", { context_window: Number.NaN }), info("local", "neg", { max_output: -1 })]);
    expect(catalog.models("local").map((m) => m.id)).toEqual(["good"]);
    expect(readRefreshed(home).providers.local!.map((m) => m.id)).toEqual(["good"]);
  });

  test("merge of an empty list still writes a valid file, and changes nothing", () => {
    const catalog = new Catalog(home);
    catalog.merge("anthropic", []);
    expect(readRefreshed(home)).toEqual({ version: 1, providers: { anthropic: [] } });
    expect(new Catalog(home).models()).toEqual(FILE.models);
  });

  test("merge refuses an entry of another provider, and the fake provider; nothing is written", () => {
    const catalog = new Catalog(home);
    expect(() => catalog.merge("anthropic", [info("openai", "gpt-x")])).toThrow('"gpt-x" belongs to provider "openai"');
    expect(() => catalog.merge("fake", [info("fake", "scripted")])).toThrow("fake provider is built in");
    expect(existsSync(refreshedModelsPath(home))).toBe(false);
    expect(catalog.get("openai", "gpt-x")).toBeUndefined();
    expect(catalog.get("fake", "scripted")).toBe(FAKE_MODEL);
  });

  test("a write that fails throws, leaves the view as it was, and leaves no temp file", () => {
    // A folder where the file should go: the rename can't succeed on any OS.
    mkdirSync(refreshedModelsPath(home));
    const catalog = new Catalog(home);
    expect(() => catalog.merge("local", [info("local", "m")])).toThrow();
    expect(catalog.get("local", "m")).toBeUndefined();
    expect(readdirSync(home)).toEqual(["models-refreshed.json"]);
  });
});

// ---- refreshModels ------------------------------------------------------------------------

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

/** What a model the catalog has never seen becomes: zeros, no tools, no reasoning, no cache minimum. */
function zeros(provider: string, id: string, name = id): ModelInfo {
  return {
    provider,
    id,
    name,
    context_window: 0,
    max_output: 0,
    price: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    tool_call: false,
    reasoning: false,
    cache_min_tokens: null,
  };
}

function bundledOf(provider: string): ModelInfo {
  return FILE.models.find((m) => m.provider === provider)!;
}

describe("refreshModels", () => {
  let server: FakeServer;
  let r: Rig | undefined;
  beforeEach(() => {
    server = startFakeProvider();
    r = undefined;
  });
  afterEach(() => {
    r?.cleanup();
    server.stop();
  });

  const refreshed = (rg: Rig): { version: number; providers: Record<string, ModelInfo[]> } => JSON.parse(readFileSync(refreshedModelsPath(rg.home), "utf8"));
  const sortedById = (list: ModelInfo[]): ModelInfo[] => [...list].sort((a, b) => cmp(a.id, b.id));

  test("OpenRouter: one GET /models; prices are per-token strings times 1e6; tools and reasoning come from supported_parameters", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    const known = bundledOf("openrouter");
    server.script(() =>
      jsonResponse({
        data: [
          {
            id: "vendor/new-model",
            name: "Vendor: New Model",
            context_length: 65536,
            pricing: { prompt: "0.000002", completion: "0.000008", input_cache_read: "0.0000005", input_cache_write: "0.0000025" },
            top_provider: { max_completion_tokens: 8192 },
            supported_parameters: ["temperature", "tools", "reasoning"],
          },
          // A model the catalog has: only the window changes; price, name, tools and the rest stay.
          { id: known.id, context_length: 12345 },
          {
            id: "vendor/plain",
            context_length: 4096,
            pricing: { prompt: "0", completion: "0" },
            top_provider: { max_completion_tokens: null },
            supported_parameters: ["temperature"],
          },
          { id: "" },
          { name: "no id" },
          null,
          "a string",
        ],
      }),
    );
    const got = await r.gateway.refreshModels("openrouter");

    const expectedNew: ModelInfo = {
      provider: "openrouter",
      id: "vendor/new-model",
      name: "Vendor: New Model",
      context_window: 65536,
      max_output: 8192,
      price: { input: 2, output: 8, cache_read: 0.5, cache_write: 2.5 },
      tool_call: true,
      reasoning: true,
      cache_min_tokens: null,
    };
    const expectedKnown: ModelInfo = { ...known, price: { ...known.price }, context_window: 12345 };
    const expectedPlain = { ...zeros("openrouter", "vendor/plain"), context_window: 4096 };
    expect(got).toEqual([expectedNew, expectedKnown, expectedPlain]);

    // One request, to the right path, with the key and nothing else.
    expect(server.requests.length).toBe(1);
    const req = server.requests[0]!;
    expect(req.path).toBe("/api/v1/models");
    expect(req.headers["x-orig-host"]).toBe("openrouter.ai");
    expect(req.headers.authorization).toBe(`Bearer ${KEYS.openrouter}`);
    expect(req.rawBody).toBe("");

    // Merged into the live catalog and into <home>/models-refreshed.json (the refreshed entries only).
    expect(r.catalog.get("openrouter", "vendor/new-model")).toEqual(expectedNew);
    expect(r.catalog.get("openrouter", known.id)).toEqual(expectedKnown);
    expect(r.catalog.models("openrouter").length).toBe(FILE.models.filter((m) => m.provider === "openrouter").length + 2);
    expect(refreshed(r)).toEqual({ version: 1, providers: { openrouter: sortedById([expectedNew, expectedKnown, expectedPlain]) } });
    expect(new Catalog(r.home).get("openrouter", "vendor/new-model")).toEqual(expectedNew);
    expect(readdirSync(r.home).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  test("OpenRouter: a per-token string that isn't exact in binary comes out within float noise of the per-million price", async () => {
    r = await rig({ server, keys: ["openrouter"] });
    server.script(() => jsonResponse({ data: [{ id: "vendor/cheap", pricing: { prompt: "0.0000008", completion: "0.0000001" } }] }));
    const [m] = await r.gateway.refreshModels("openrouter");
    expect(m!.price.input).toBeCloseTo(0.8, 12);
    expect(m!.price.output).toBeCloseTo(0.1, 12);
  });

  test("Anthropic: pages follow has_more and last_id into after_id, and a known id keeps its bundled entry", async () => {
    r = await rig({ server, keys: ["anthropic"], labels: { anthropic: "work" } });
    const known = bundledOf("anthropic");
    server.script([
      () =>
        jsonResponse({
          data: [
            { type: "model", id: known.id, display_name: "Some Other Display Name", created_at: "2026-01-01T00:00:00Z" },
            { type: "model", id: "claude-newmodel-9", display_name: "Claude Newmodel 9", created_at: "2026-02-01T00:00:00Z" },
          ],
          has_more: true,
          first_id: known.id,
          last_id: "claude-newmodel-9",
        }),
      () =>
        jsonResponse({
          data: [{ type: "model", id: "claude-newmodel-8", display_name: "Claude Newmodel 8", created_at: "2026-01-15T00:00:00Z" }],
          has_more: false,
          first_id: "claude-newmodel-8",
          last_id: "claude-newmodel-8",
        }),
    ]);
    const got = await r.gateway.refreshModels("anthropic");

    expect(server.requests.map((q) => q.path)).toEqual(["/v1/models?limit=1000", "/v1/models?limit=1000&after_id=claude-newmodel-9"]);
    for (const q of server.requests) {
      expect(q.headers["x-api-key"]).toBe(KEYS.anthropic);
      expect(q.headers["anthropic-version"]).toBe("2023-06-01");
      expect(q.headers.authorization).toBeUndefined();
      expect(q.headers["x-orig-host"]).toBe("api.anthropic.com");
    }
    expect(got).toEqual([known, zeros("anthropic", "claude-newmodel-9", "Claude Newmodel 9"), zeros("anthropic", "claude-newmodel-8", "Claude Newmodel 8")]);
    expect(r.catalog.get("anthropic", known.id)).toEqual(known);
    expect(r.catalog.get("anthropic", "claude-newmodel-8")).toEqual(zeros("anthropic", "claude-newmodel-8", "Claude Newmodel 8"));
    expect(refreshed(r).providers.anthropic!.map((m) => m.id)).toEqual(sortedById(got).map((m) => m.id));
    expect(new Catalog(r.home).get("anthropic", "claude-newmodel-9")).toEqual(zeros("anthropic", "claude-newmodel-9", "Claude Newmodel 9"));
  });

  test("Anthropic: at most 5 pages, however long has_more goes on", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script((_req, n) => jsonResponse({ data: [{ type: "model", id: `claude-page-${n + 1}`, display_name: `Page ${n + 1}` }], has_more: true, last_id: `claude-page-${n + 1}` }));
    const got = await r.gateway.refreshModels("anthropic");
    expect(server.requests.map((q) => q.path)).toEqual([
      "/v1/models?limit=1000",
      "/v1/models?limit=1000&after_id=claude-page-1",
      "/v1/models?limit=1000&after_id=claude-page-2",
      "/v1/models?limit=1000&after_id=claude-page-3",
      "/v1/models?limit=1000&after_id=claude-page-4",
    ]);
    expect(got.map((m) => m.id)).toEqual(["claude-page-1", "claude-page-2", "claude-page-3", "claude-page-4", "claude-page-5"]);
  });

  test("Anthropic: has_more without a last_id ends the paging", async () => {
    r = await rig({ server, keys: ["anthropic"] });
    server.script(() => jsonResponse({ data: [{ type: "model", id: "claude-solo-1", display_name: "Solo" }], has_more: true }));
    const got = await r.gateway.refreshModels("anthropic");
    expect(server.requests.length).toBe(1);
    expect(got.map((m) => m.id)).toEqual(["claude-solo-1"]);
  });

  test("Gemini: ids lose the models/ prefix, and a known id keeps its bundled entry", async () => {
    r = await rig({ server, keys: ["gemini"] });
    const known = bundledOf("gemini");
    server.script(() =>
      jsonResponse({
        object: "list",
        data: [
          { id: `models/${known.id}`, object: "model", owned_by: "google" },
          { id: "models/gemini-newmodel-1", object: "model", owned_by: "google" },
          { id: "gemini-bare-2", object: "model", owned_by: "google" },
        ],
      }),
    );
    const got = await r.gateway.refreshModels("gemini");

    expect(server.requests.length).toBe(1);
    const req = server.requests[0]!;
    expect(req.path).toBe("/v1beta/openai/models");
    expect(req.headers["x-orig-host"]).toBe("generativelanguage.googleapis.com");
    expect(req.headers.authorization).toBe(`Bearer ${KEYS.gemini}`);
    expect(got).toEqual([known, zeros("gemini", "gemini-newmodel-1"), zeros("gemini", "gemini-bare-2")]);
    expect(r.catalog.get("gemini", known.id)).toEqual(known);
    expect(r.catalog.get("gemini", `models/${known.id}`)).toBeUndefined();
    expect(r.catalog.get("gemini", "models/gemini-newmodel-1")).toBeUndefined();
    expect(refreshed(r).providers.gemini!.map((m) => m.id)).toEqual(sortedById(got).map((m) => m.id));
  });

  test("an ids-only provider (OpenAI): every id starts from the bundled entry, or from zeros", async () => {
    r = await rig({ server, keys: ["openai"] });
    const known = bundledOf("openai");
    server.script(() =>
      jsonResponse({
        object: "list",
        data: [
          { id: "gpt-newmodel-1", object: "model", created: 1_700_000_000, owned_by: "openai" },
          { id: known.id, object: "model", created: 1_700_000_001, owned_by: "openai" },
          { id: "o3-pro", object: "model", created: 1_700_000_002, owned_by: "system" }, // not in our catalog, so zeros
        ],
      }),
    );
    const got = await r.gateway.refreshModels("openai");

    expect(server.requests.length).toBe(1);
    expect(server.requests[0]!.path).toBe("/v1/models");
    expect(server.requests[0]!.headers["x-orig-host"]).toBe("api.openai.com");
    expect(server.requests[0]!.headers.authorization).toBe(`Bearer ${KEYS.openai}`);
    expect(got).toEqual([zeros("openai", "gpt-newmodel-1"), known, zeros("openai", "o3-pro")]);
    expect(got[1]!.cache_min_tokens).toBe(1024); // from the bundled entry
    expect(r.catalog.get("openai", "gpt-newmodel-1")).toEqual(zeros("openai", "gpt-newmodel-1"));
    expect(refreshed(r)).toEqual({ version: 1, providers: { openai: sortedById(got) } });
  });

  test("an ids-only provider (DeepSeek) lists at <base>/models", async () => {
    r = await rig({ server, keys: ["deepseek"] });
    const known = bundledOf("deepseek");
    server.script(() => jsonResponse({ object: "list", data: [{ id: known.id, object: "model", owned_by: "deepseek" }, { id: "deepseek-newmodel", object: "model", owned_by: "deepseek" }] }));
    const got = await r.gateway.refreshModels("deepseek");
    expect(server.requests.map((q) => q.path)).toEqual(["/models"]);
    expect(server.requests[0]!.headers["x-orig-host"]).toBe("api.deepseek.com");
    expect(got).toEqual([known, zeros("deepseek", "deepseek-newmodel")]);
  });

  test("a second refresh replaces by id and keeps the earlier refreshed ids", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script([
      () => jsonResponse({ data: [{ id: "gpt-a" }, { id: "gpt-b" }] }),
      () => jsonResponse({ data: [{ id: "gpt-b" }, { id: "gpt-c" }] }),
    ]);
    await r.gateway.refreshModels("openai");
    await r.gateway.refreshModels("openai");
    expect(server.requests.length).toBe(2);
    expect(refreshed(r).providers.openai!.map((m) => m.id)).toEqual(["gpt-a", "gpt-b", "gpt-c"]);
  });

  test("no key gives kind no_key, before any request, for every provider that needs one", async () => {
    r = await rig({ server, keys: ["openai"] }); // a key for another provider doesn't help
    const names: Record<string, string> = { anthropic: "Anthropic", deepseek: "DeepSeek", openrouter: "OpenRouter", gemini: "Google Gemini" };
    for (const [id, name] of Object.entries(names)) {
      const err = await caught(r.gateway.refreshModels(id));
      expect(err, id).toBeInstanceOf(ModelError);
      expect(err.data, id).toEqual({ kind: "no_key", provider: id, model: "", status: null, message: `No API key for ${name}. Add one in /providers.` });
      expect(err.code, id).toBe(-32001);
    }
    const bare = await rig({ server });
    try {
      const err = await caught(bare.gateway.refreshModels("openai"));
      expect(err.data.kind).toBe("no_key");
    } finally {
      bare.cleanup();
    }
    expect(server.requests.length).toBe(0);
    expect(existsSync(refreshedModelsPath(r.home))).toBe(false);
  });

  test("local needs no key and sends none; custom without a base URL says so; fake and unknown providers have nothing to refresh", async () => {
    r = await rig({ server });
    server.script(() => jsonResponse({ data: [{ id: "my-local-model" }] }));
    const got = await r.gateway.refreshModels("local");
    expect(got).toEqual([zeros("local", "my-local-model")]);
    expect(server.requests.map((q) => q.path)).toEqual(["/v1/models"]);
    expect(server.requests[0]!.headers.authorization).toBeUndefined();
    expect(r.catalog.get("local", "my-local-model")).toEqual(zeros("local", "my-local-model"));

    const custom = await caught(r.gateway.refreshModels("custom"));
    expect(custom.data.kind).toBe("other");
    expect(custom.data.message).toContain("No base URL for the custom provider");
    for (const id of ["fake", "nope"]) {
      const err = await caught(r.gateway.refreshModels(id));
      expect(err.data.kind, id).toBe("other");
      expect(err.data.message, id).toContain("has no model list to refresh");
    }
    expect(server.requests.length).toBe(1);
  });

  test("an HTTP error is one request with no retry, names the key, and writes nothing", async () => {
    r = await rig({ server, keys: ["anthropic", "openai"], labels: { anthropic: "work" } });
    const sleeps = recordSleeps();
    try {
      server.script(() => httpError(401, { error: { type: "authentication_error", message: "invalid x-api-key" } }));
      const auth = await caught(r.gateway.refreshModels("anthropic"));
      expect(auth.data.kind).toBe("auth");
      expect(auth.data.status).toBe(401);
      expect(auth.data.message).toBe('Anthropic rejected the key "work" (ends in 3f9a). Re-enter or delete it in /providers.');
      expect(auth.data.message).not.toContain(KEYS.anthropic);
      expect(server.requests.length).toBe(1);

      server.script(() => httpError(503));
      const down = await caught(r.gateway.refreshModels("openai"));
      expect(down.data.kind).toBe("server");
      expect(down.data.status).toBe(503);
      expect(server.requests.length).toBe(2); // one request each, 401 then 503: no retry of either
    } finally {
      sleeps.restore();
    }
    expect(sleeps.delays).toEqual([]); // nothing slept: no retries
    expect(existsSync(refreshedModelsPath(r.home))).toBe(false);
  });

  test("a reply without a data array is an unreadable list, and writes nothing", async () => {
    r = await rig({ server, keys: ["openai"] });
    server.script(() => jsonResponse({ models: [] }));
    const err = await caught(r.gateway.refreshModels("openai"));
    expect(err.data.kind).toBe("other");
    expect(err.data.message).toContain("could not be read");
    expect(existsSync(refreshedModelsPath(r.home))).toBe(false);
  });

  test("a request that gets no answer within REFRESH_TIMEOUT_MS fails as a timeout, once", async () => {
    r = await rig({ server, keys: ["openai"] });
    const restore = limits({ REFRESH_TIMEOUT_MS: 100 });
    try {
      server.script(async () => {
        await Bun.sleep(1000);
        return jsonResponse({ data: [] });
      });
      const err = await caught(r.gateway.refreshModels("openai"));
      expect(err.data.kind).toBe("timeout");
      expect(server.requests.length).toBe(1);
    } finally {
      restore();
    }
  });

  test("complete never lists models: only the chat request is made", async () => {
    r = await rig({ server, keys: ["openai"] });
    await r.gateway.complete(params(ref("openai", "gpt-5")));
    expect(server.requests.length).toBe(1);
    expect(server.requests[0]!.path).toBe("/v1/chat/completions");
  });
});
