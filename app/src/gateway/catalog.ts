// KV cache: none
// The model catalog (architecture §7.3): the bundled subset of oh-my-pi's list
// (catalog/models.json, imported so `bun build --compile` embeds it), an overlay of
// refreshed entries in <home>/models-refreshed.json, and the built-in fake/scripted model.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { refreshedModelsPath } from "../paths.ts";
import bundled from "../../catalog/models.json" with { type: "json" };

export interface ModelInfo {
  provider: string;
  id: string;
  name: string;
  /** Tokens; 0 means unknown, and the window check is skipped. */
  context_window: number;
  /** Tokens; 0 means unknown. */
  max_output: number;
  /** USD per 1M tokens. */
  price: { input: number; output: number; cache_read: number; cache_write: number };
  tool_call: boolean;
  reasoning: boolean;
  /** Shortest prompt the provider caches, or null when unknown (the batch rule then assumes 1024). */
  cache_min_tokens: number | null;
}

export interface CatalogSource {
  repo: string;
  path: string;
  commit: string;
  license: string;
}

/** The shape of catalog/models.json. */
export interface CatalogFile {
  version: 1;
  source: CatalogSource;
  models: ModelInfo[];
}

/** The shape of <home>/models-refreshed.json. */
export interface RefreshedFile {
  version: 1;
  providers: Record<string, ModelInfo[]>;
}

const BUNDLED = bundled as unknown as CatalogFile;

/** Where the bundled list came from (repo, path, commit, licence). */
export const CATALOG_SOURCE: CatalogSource = BUNDLED.source;

export const FAKE_PROVIDER = "fake";
export const FAKE_MODEL_ID = "scripted";

/**
 * §7.5: zero prices, a 1,000,000 window, tool calls. `max_output` is 0 (unknown), because
 * the fake has no output limit to enforce. `get` finds it and `models()` hides it.
 */
export const FAKE_MODEL: ModelInfo = {
  provider: FAKE_PROVIDER,
  id: FAKE_MODEL_ID,
  name: "Scripted fake",
  context_window: 1_000_000,
  max_output: 0,
  price: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  tool_call: true,
  reasoning: false,
  cache_min_tokens: null,
};

type ByProvider = Map<string, Map<string, ModelInfo>>;

/** A provider id as settings.ts spells it; keeps odd keys such as __proto__ out of the overlay. */
const PROVIDER_KEY = /^[a-z][a-z0-9_-]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** Rebuilds an entry in the canonical field order, or null when any field is unusable. */
function parseModelInfo(v: unknown, provider: string): ModelInfo | null {
  if (!isRecord(v) || v.provider !== provider || typeof v.id !== "string" || v.id === "") return null;
  const price = v.price;
  if (!isRecord(price)) return null;
  if (!isCount(v.context_window) || !isCount(v.max_output)) return null;
  if (!isCount(price.input) || !isCount(price.output) || !isCount(price.cache_read) || !isCount(price.cache_write)) {
    return null;
  }
  if (typeof v.tool_call !== "boolean" || typeof v.reasoning !== "boolean") return null;
  if (v.cache_min_tokens !== null && !isCount(v.cache_min_tokens)) return null;
  return {
    provider,
    id: v.id,
    name: typeof v.name === "string" ? v.name : v.id,
    context_window: v.context_window,
    max_output: v.max_output,
    price: { input: price.input, output: price.output, cache_read: price.cache_read, cache_write: price.cache_write },
    tool_call: v.tool_call,
    reasoning: v.reasoning,
    cache_min_tokens: v.cache_min_tokens,
  };
}

function put(map: ByProvider, m: ModelInfo): void {
  let inner = map.get(m.provider);
  if (!inner) map.set(m.provider, (inner = new Map()));
  inner.set(m.id, m);
}

/** Missing or corrupt gives an empty overlay. Unusable entries and the fake provider are skipped. */
function readRefreshed(path: string): ByProvider {
  const out: ByProvider = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return out;
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.providers)) return out;
  for (const [provider, list] of Object.entries(raw.providers)) {
    if (provider === FAKE_PROVIDER || !PROVIDER_KEY.test(provider) || !Array.isArray(list)) continue;
    for (const item of list) {
      const m = parseModelInfo(item, provider);
      if (m) put(out, m);
    }
  }
  return out;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Temp file, then rename. EPERM and EBUSY (antivirus on Windows) are retried 3 times, 50 ms apart. */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, path);
        return;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (attempt >= 3 || (code !== "EPERM" && code !== "EBUSY")) throw e;
        sleepSync(50);
      }
    }
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export class Catalog {
  private readonly path: string;
  /** Bundled entries with the refreshed ones laid over them: what `get` and `models` see. */
  private readonly view: ByProvider = new Map();
  /** Only the refreshed entries: what the overlay file holds. */
  private readonly refreshed: ByProvider;

  constructor(home: string) {
    this.path = refreshedModelsPath(home);
    for (const m of BUNDLED.models) {
      const entry = parseModelInfo(m, m.provider);
      if (entry) put(this.view, entry);
    }
    this.refreshed = readRefreshed(this.path);
    for (const inner of this.refreshed.values()) for (const m of inner.values()) put(this.view, m);
  }

  /** Every visible model (the fake is hidden), or one provider's, sorted by provider and then id. */
  models(provider?: string): ModelInfo[] {
    const out: ModelInfo[] = [];
    for (const [p, inner] of this.view) {
      if (provider !== undefined && p !== provider) continue;
      out.push(...inner.values());
    }
    return out.sort((a, b) => compare(a.provider, b.provider) || compare(a.id, b.id));
  }

  /** Callers treat the entry as read-only. An id the catalog doesn't know gives undefined. */
  get(provider: string, id: string): ModelInfo | undefined {
    if (provider === FAKE_PROVIDER) return id === FAKE_MODEL_ID ? FAKE_MODEL : undefined;
    return this.view.get(provider)?.get(id);
  }

  /**
   * Replaces the provider's refreshed entries by id, keeps the rest, writes
   * <home>/models-refreshed.json atomically, then updates what `get` and `models` see.
   * An entry with a field that is not usable is skipped. One that names another provider throws.
   */
  merge(provider: string, fetched: ModelInfo[]): void {
    if (provider === FAKE_PROVIDER) throw new Error("the fake provider is built in and cannot be refreshed");
    const entries: ModelInfo[] = [];
    for (const item of fetched) {
      if (item.provider !== provider) {
        throw new Error(`merge("${provider}"): "${item.id}" belongs to provider "${item.provider}"`);
      }
      const m = parseModelInfo(item, provider);
      if (m) entries.push(m);
    }
    const next = new Map(this.refreshed.get(provider));
    for (const m of entries) next.set(m.id, m);

    const providers: Record<string, ModelInfo[]> = {};
    for (const p of [...this.refreshed.keys(), provider].sort(compare)) {
      const list = p === provider ? next : this.refreshed.get(p);
      providers[p] = [...(list?.values() ?? [])].sort((a, b) => compare(a.id, b.id));
    }
    const file: RefreshedFile = { version: 1, providers };
    writeAtomic(this.path, JSON.stringify(file, null, 2) + "\n");

    this.refreshed.set(provider, next);
    for (const m of entries) put(this.view, m);
  }
}
