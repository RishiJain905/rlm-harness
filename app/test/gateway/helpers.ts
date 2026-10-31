// KV cache: none
// Shared setup for the gateway tests: a Gateway on a temp home, in-memory secrets, no env keys,
// a fetch redirected to the fake server, and a recorder for RETRY.sleep.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../src/bus.ts";
import { Catalog } from "../../src/gateway/catalog.ts";
import { Gateway, LIMITS, RETRY, type AppEvents } from "../../src/gateway/gateway.ts";
import { KeyStore, type SecretsLike } from "../../src/gateway/keys.ts";
import type { ModelCompleteParams, ModelRef } from "../../src/protocol.ts";
import { defaultSettings, setSetting, type Settings } from "../../src/settings.ts";
import type { FakeServer } from "../fakes/http.ts";

export const KEYS: Record<string, string> = {
  anthropic: "sk-ant-FAKE-0123456789abcdef3f9a",
  openai: "sk-FAKE-openai-0123456789abcd",
  deepseek: "sk-FAKE-deepseek-0123456789ab",
  openrouter: "sk-or-FAKE-0123456789abcdef",
  gemini: "AIza-FAKE-gemini-0123456789abcdef",
};

export function memorySecrets(): SecretsLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(o) {
      return store.get(`${o.service}/${o.name}`) ?? null;
    },
    async set(o) {
      store.set(`${o.service}/${o.name}`, o.value);
    },
    async delete(o) {
      return store.delete(`${o.service}/${o.name}`);
    },
  };
}

export interface Rig {
  gateway: Gateway;
  bus: Bus<AppEvents>;
  keys: KeyStore;
  catalog: Catalog;
  home: string;
  events: { name: keyof AppEvents; payload: any }[];
  cleanup(): void;
}

/** A gateway on a temp home. `keys` saves one key per provider named (label "work" unless given). */
export async function rig(opts: { server?: FakeServer; settings?: Record<string, string | number>; keys?: string[]; labels?: Record<string, string>; env?: Record<string, string>; fetch?: typeof fetch } = {}): Promise<Rig> {
  const home = mkdtempSync(join(tmpdir(), "rlmh-gw-"));
  const bus = new Bus<AppEvents>();
  const events: Rig["events"] = [];
  for (const name of ["call.start", "call.delta", "call.end"] as const) bus.on(name, (payload) => events.push({ name, payload }));
  const keys = new KeyStore({ home, secrets: memorySecrets(), env: opts.env ?? {} });
  for (const id of opts.keys ?? []) await keys.add(id, KEYS[id]!, opts.labels?.[id] ?? "work");
  const catalog = new Catalog(home);
  let settings: Settings = defaultSettings();
  for (const [k, v] of Object.entries(opts.settings ?? {})) settings = setSetting(settings, k, v);
  const gateway = new Gateway({ keys, catalog, settings, bus, fetch: opts.fetch ?? opts.server?.redirectFetch(), env: opts.env ?? {} });
  return { gateway, bus, keys, catalog, home, events, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function ref(provider: string, model: string): ModelRef {
  return { provider, model, thinking: null };
}

/** A root call by default; override anything. */
export function params(model: ModelRef, over: Partial<ModelCompleteParams> = {}): ModelCompleteParams {
  return {
    run_id: "r_0123456789ab",
    role: "root",
    model,
    messages: [
      { role: "system", content: "You are a test." },
      { role: "user", content: "Question?" },
    ],
    tools: [],
    max_tokens: 4096,
    temperature: 0.3,
    thinking: "off",
    turn: 1,
    ...over,
  };
}

export function sub(model: ModelRef, prompt: string, batch: { id: string; index: number; size: number }, over: Partial<ModelCompleteParams> = {}): ModelCompleteParams {
  return params(model, { role: "sub", messages: [{ role: "user", content: prompt }], tools: [], subcall_id: batch.index + 1, origin: { turn: 1, line: 1 }, batch, ...over });
}

/** RETRY.sleep records instead of waiting; RETRY.random gives a factor of 1. Returns the delays (ms) and a restore. */
export function recordSleeps(): { delays: number[]; restore(): void } {
  const sleep = RETRY.sleep;
  const random = RETRY.random;
  const delays: number[] = [];
  RETRY.sleep = async (ms, signal) => {
    delays.push(ms);
    if (signal.aborted) throw signal.reason;
  };
  RETRY.random = () => 0.5;
  return {
    delays,
    restore() {
      RETRY.sleep = sleep;
      RETRY.random = random;
    },
  };
}

/** Shortens LIMITS for a test; returns a restore. */
export function limits(over: Partial<typeof LIMITS>): () => void {
  const saved = { ...LIMITS };
  Object.assign(LIMITS, over);
  return () => Object.assign(LIMITS, saved);
}

export async function caught(p: Promise<unknown>): Promise<any> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}
