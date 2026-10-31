// KV cache: none
// The providers of 5a (S-28), how to reach each one, and the local-server presets that
// /providers offers. Imports nothing else from the gateway.

import type { ModelRef } from "../protocol.ts";

export interface ProviderDef {
  id: string;
  name: string;
  client: "openai" | "anthropic" | "fake";
  /** null: taken from settings (`local`, `custom`), or none (`fake`). */
  baseUrl: string | null;
  envVar: string | null;
  /** A second variable read when `envVar` is unset or blank (Gemini's GOOGLE_API_KEY). */
  envFallback?: string;
  /** false: a saved key is sent if there is one, and none is fine. */
  needsKey: boolean;
  /** An API provider, so `auto` may pick native (§7.4). */
  api: boolean;
  caching: "anthropic" | "openai" | "openrouter" | "auto" | "none";
}

export const PROVIDERS: readonly ProviderDef[] = [
  { id: "anthropic", name: "Anthropic", client: "anthropic", baseUrl: "https://api.anthropic.com", envVar: "ANTHROPIC_API_KEY", needsKey: true, api: true, caching: "anthropic" },
  { id: "openai", name: "OpenAI", client: "openai", baseUrl: "https://api.openai.com/v1", envVar: "OPENAI_API_KEY", needsKey: true, api: true, caching: "openai" },
  { id: "deepseek", name: "DeepSeek", client: "openai", baseUrl: "https://api.deepseek.com", envVar: "DEEPSEEK_API_KEY", needsKey: true, api: true, caching: "auto" },
  { id: "openrouter", name: "OpenRouter", client: "openai", baseUrl: "https://openrouter.ai/api/v1", envVar: "OPENROUTER_API_KEY", needsKey: true, api: true, caching: "openrouter" },
  {
    id: "gemini",
    name: "Google Gemini",
    client: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    envVar: "GEMINI_API_KEY",
    envFallback: "GOOGLE_API_KEY",
    needsKey: true,
    api: true,
    caching: "auto",
  },
  { id: "local", name: "Local server", client: "openai", baseUrl: null, envVar: null, needsKey: false, api: false, caching: "auto" },
  { id: "custom", name: "Custom endpoint", client: "openai", baseUrl: null, envVar: "RLMH_CUSTOM_API_KEY", needsKey: false, api: false, caching: "none" },
  { id: "fake", name: "Fake (hidden)", client: "fake", baseUrl: null, envVar: null, needsKey: false, api: true, caching: "none" },
];

/** Every provider id, in PROVIDERS order; settings.ts imports only this. */
export const PROVIDER_IDS: readonly string[] = PROVIDERS.map((p) => p.id);

/** For step 7's /providers screen; each is an OpenAI-compatible base URL (checked 2026-10-31: llama-server's default port is now 9931). */
export const LOCAL_PRESETS: readonly { name: string; baseUrl: string }[] = [
  { name: "vLLM", baseUrl: "http://localhost:8000/v1" },
  { name: "Ollama", baseUrl: "http://localhost:11434/v1" },
  { name: "LM Studio", baseUrl: "http://localhost:1234/v1" },
  { name: "llama.cpp (llama-server)", baseUrl: "http://localhost:9931/v1" },
];

export function provider(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** The display name, or the id itself for an unknown provider. */
export function providerName(id: string): string {
  return provider(id)?.name ?? id;
}

/** "openrouter/anthropic/x" splits at the first "/". Throws on an empty provider or model. */
export function parseModelRef(s: string, thinking: ModelRef["thinking"] = null): ModelRef {
  const slash = s.indexOf("/");
  if (slash <= 0 || slash === s.length - 1) throw new Error(`a model is written provider/model, such as anthropic/claude-sonnet-5 (got "${s}")`);
  return { provider: s.slice(0, slash), model: s.slice(slash + 1), thinking };
}
