// KV cache: none
// Builds app/catalog/models.json from a subset of oh-my-pi's model catalog (MIT; see
// catalog/ATTRIBUTION.md). A developer runs it by hand:
//
//   bun run scripts/build-catalog.ts --commit <40-hex sha>               downloads the file at that commit
//   bun run scripts/build-catalog.ts --commit <40-hex sha> --file <path>  reads a local copy of the same commit
//   (--out <path> writes somewhere other than app/catalog/models.json)
//
// This is the only code in the repo that may touch the network, and only in that download.
// buildCatalog() is pure and runs under import.meta.main only, so tests import it freely;
// one commit always gives the same bytes (no timestamp, sorted, 2-space indent, ends in "\n").

import { createHash } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { CatalogFile, ModelInfo } from "../src/gateway/catalog.ts";

export const OMP_REPO = "can1357/oh-my-pi";
export const OMP_PATH = "packages/catalog/src/models.json";

/** OMP provider id to ours. Only `google` is renamed. */
export const PROVIDER_MAP: ReadonlyArray<readonly [omp: string, ours: string]> = [
  ["anthropic", "anthropic"],
  ["deepseek", "deepseek"],
  ["google", "gemini"],
  ["openai", "openai"],
  ["openrouter", "openrouter"],
];

/** OpenRouter keeps ids whose first segment is one of these (and that are not `:batch`), sorted by id, at most OPENROUTER_CAP. */
export const OPENROUTER_VENDORS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "qwen",
  "meta-llama",
  "mistralai",
  "x-ai",
  "moonshotai",
  "z-ai",
]);
export const OPENROUTER_CAP = 300;

/**
 * OpenAI ids that only the Responses API serves. Our OpenAI client speaks Chat Completions
 * (OMP marks every OpenAI chat model `openai-responses`, so the entry's `api` can't tell
 * them apart), and these would be refused:
 *   -pro           o1-pro, o3-pro, gpt-5-pro, gpt-5.2-pro, ...
 *   codex          codex-mini-latest, gpt-5-codex, gpt-5.3-codex-spark, ...
 *   deep-research  o3-deep-research, o4-mini-deep-research
 *   realtime       gpt-realtime-*
 *   computer-use   computer-use models
 */
export const OPENAI_RESPONSES_ONLY = /-pro$|codex|deep-research|realtime|computer-use/;

/**
 * Gemini ids that don't work through the OpenAI-compatible chat endpoint we call
 * (generativelanguage.googleapis.com/v1beta/openai/): they need Google's own Interactions or
 * Live APIs, or are not text chat models.
 *   deep-research  deep-research-preview-*, deep-research-max-preview-*
 *   computer-use   gemini-2.5-computer-use-preview-*
 *   live           gemini-live-*, gemini-*-live-preview (a whole `live` segment, so `deliver` can't match)
 *   robotics       gemini-robotics-er-*
 */
export const GEMINI_NOT_CHAT = /deep-research|computer-use|(^|-)live(-|$)|robotics/;

/** OpenRouter's `:batch` ids are its batch-API variants of a model, at half price; they are dropped. */
export const OPENROUTER_BATCH = /:batch$/;

/**
 * True for an OpenAI entry that is not a plain Chat Completions model: an id matching
 * OPENAI_RESPONSES_ONLY, or one of OMP's virtual aliases (`requestModelId` is set and names
 * another id, as `gpt-5.6-luna-pro` names `gpt-5.6-luna`).
 */
export function isOpenAiResponsesOnly(id: string, requestModelId?: string): boolean {
  if (OPENAI_RESPONSES_ONLY.test(id)) return true;
  return typeof requestModelId === "string" && requestModelId !== "" && requestModelId !== id;
}

/**
 * Anthropic's minimum cacheable prompt, in tokens (Anthropic's prompt-caching page, 2026-10-28; sonnet-5 rechecked and moved to 1024 on 2026-10-31). A row's name
 * matches `^claude-<name>(-\d{8})?(-latest)?$`, so dated and `-latest` ids are covered.
 */
const ANTHROPIC_CACHE_MIN: ReadonlyArray<readonly [tokens: number, names: readonly string[]]> = [
  [512, ["opus-5-5", "opus-5", "sonnet-5-5", "haiku-5-5", "fable-5-1", "fable-5", "mythos-5-1", "mythos-5"]],
  [1024, ["sonnet-5", "opus-4-8", "sonnet-4-6", "sonnet-4-5", "sonnet-4", "opus-4-1", "opus-4"]],
  [2048, ["opus-4-7", "mythos-preview", "haiku-3-5"]],
  [4096, ["opus-4-6", "opus-4-5", "haiku-4-5"]],
];

const ANTHROPIC_ROWS = ANTHROPIC_CACHE_MIN.flatMap(([tokens, names]) =>
  names.map((name) => ({ tokens, re: new RegExp(`^claude-${name}(-\\d{8})?(-latest)?$`) })),
);

const OPENAI_CACHE_MIN = 1024;

/** Throws `add a cache_min_tokens row for <id>` for an Anthropic id the table doesn't cover. */
export function anthropicCacheMin(id: string): number {
  const row = ANTHROPIC_ROWS.find((r) => r.re.test(id));
  if (!row) throw new Error(`add a cache_min_tokens row for ${id}`);
  return row.tokens;
}

// ---- OMP's input -------------------------------------------------------------------------

/** The fields of an OMP entry that we read. Everything else is ignored. */
export interface OmpEntry {
  id?: string;
  name?: string;
  /** Not read: OMP marks every OpenAI chat model `openai-responses`, so it can't tell Chat Completions ones apart. */
  api?: string;
  kind?: string | null;
  reasoning?: boolean;
  input?: string[];
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
  supportsTools?: boolean;
  requestModelId?: string;
}

/** The plain shape: `{ [provider]: { [modelId]: entry } }`. */
export type OmpCatalog = Record<string, Record<string, OmpEntry>>;

// OMP's models.json is a compact, interned format: {version, keys, booleanShapes, nodes, compat, providers}.
// This decoder follows packages/catalog/src/model-catalog-format.ts in can1357/oh-my-pi (MIT,
// Copyright (c) 2025-2026 Can Bölük, 2026 Stencil Labs, Inc.; see catalog/ATTRIBUTION.md).
// We write our own, and read only what we need: `compat` deltas are skipped, since no
// compat field reaches models.json.
//
// A value is a JSON scalar, or a one-element array [n]: a reference to nodes[n], or [-1] for an
// explicitly present undefined. An object node is [0, [keyId, value, keyId, value, ...],
// booleanShapeId, masks], where the shape lists the key ids of the boolean properties and bit i
// (word i >>> 5, bit i % 32) of masks holds the value of the i-th one. An array node is [1, values].

type Encoded = string | number | boolean | null | [number];
type ObjectNode = [0, Encoded[], number, number[]];
type ArrayNode = [1, Encoded[]];
type ModelRow = [id: string, value: Encoded, compatDelta?: unknown];
type ProviderRow = [provider: string, constants: Encoded, rows: ModelRow[]];

export interface CompactCatalog {
  version: number;
  keys: string[];
  booleanShapes: number[][];
  nodes: (ObjectNode | ArrayNode)[];
  providers: ProviderRow[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** True for the compact format (it has `nodes`); false for the plain `{provider: {id: entry}}` one. */
export function isCompactCatalog(data: unknown): data is CompactCatalog {
  return isRecord(data) && Array.isArray(data.nodes) && Array.isArray(data.providers) && Array.isArray(data.keys);
}

// Assignment is fine for ordinary keys, but a key named __proto__ has to stay an own key.
function setProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
  else target[key] = value;
}

/** Decodes OMP's compact catalog into the plain `{ [provider]: { [modelId]: entry } }` shape. */
export function decodeOmpCatalog(data: unknown): OmpCatalog {
  if (!isCompactCatalog(data)) throw new Error("not an OMP compact catalog (expected keys, nodes and providers)");
  if (data.version !== 1) throw new Error(`unsupported OMP catalog version ${String(data.version)} (expected 1)`);
  const cache = new Map<number, unknown>();

  const decodeObject = (target: Record<string, unknown>, node: ObjectNode): void => {
    const props = node[1];
    for (let i = 0; i < props.length; i += 2) {
      setProperty(target, data.keys[props[i] as number]!, decode(props[i + 1]!));
    }
    const shape = data.booleanShapes[node[2]];
    if (!shape) throw new Error(`OMP catalog: no boolean shape ${node[2]}`);
    for (let i = 0; i < shape.length; i++) {
      const word = node[3][i >>> 5] ?? 0;
      setProperty(target, data.keys[shape[i]!]!, ((word >>> (i % 32)) & 1) !== 0);
    }
  };

  const decode = (value: Encoded): unknown => {
    if (!Array.isArray(value)) return value;
    const id = value[0];
    if (id === -1) return undefined;
    if (cache.has(id)) return cache.get(id);
    const node = data.nodes[id];
    if (!node) throw new Error(`OMP catalog: no node ${id}`);
    let result: unknown;
    if (node[0] === 1) {
      result = node[1].map(decode);
    } else {
      const object: Record<string, unknown> = {};
      decodeObject(object, node);
      result = object;
    }
    cache.set(id, result);
    return result;
  };

  const out: OmpCatalog = {};
  for (const [provider, encodedConstants, rows] of data.providers) {
    const constants = decode(encodedConstants);
    const models: Record<string, OmpEntry> = {};
    for (const [id, encoded] of rows) {
      if (!Array.isArray(encoded) || encoded[0] < 0) throw new Error(`OMP catalog: invalid row for "${id}"`);
      const node = data.nodes[encoded[0]];
      if (!node || node[0] !== 0) throw new Error(`OMP catalog: invalid row for "${id}"`);
      const entry: Record<string, unknown> = { id, ...(isRecord(constants) ? constants : {}) };
      decodeObject(entry, node);
      setProperty(models, id, entry);
    }
    setProperty(out, provider, models);
  }
  return out;
}

// ---- The build ---------------------------------------------------------------------------

export interface BuildOptions {
  /** The OMP commit the input came from: 40 lowercase hex characters. It goes into `source`. */
  commit: string;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** OpenRouter's prices arrive as per-token strings times 1e6, so some carry float noise (0.7999999999999999). */
function cleanPrice(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** One OMP entry to ours, or null when it is not a chat model we keep. */
function toModel(ours: string, key: string, e: OmpEntry): ModelInfo | null {
  if (e === null || typeof e !== "object") return null;
  if (e.kind !== undefined && e.kind !== null) return null; // image, stt, embedding, judge, rerank, video
  if (!Array.isArray(e.input) || !e.input.includes("text")) return null;
  const ctx = e.contextWindow;
  if (typeof ctx !== "number" || !(ctx > 0)) return null; // null and 0 are dropped
  const cost = e.cost;
  if (!isRecord(cost)) return null;
  // A negative price marks a router whose price varies (OpenRouter's auto models); not a price.
  const cacheRead = cost.cacheRead ?? 0;
  const cacheWrite = cost.cacheWrite ?? 0;
  if (!isPrice(cost.input) || !isPrice(cost.output) || !isPrice(cacheRead) || !isPrice(cacheWrite)) return null;
  const id = typeof e.id === "string" && e.id !== "" ? e.id : key;
  if (ours === "openai" && isOpenAiResponsesOnly(id, e.requestModelId)) return null;
  if (ours === "gemini" && GEMINI_NOT_CHAT.test(id)) return null;
  if (ours === "openrouter" && OPENROUTER_BATCH.test(id)) return null; // before the vendor list and the cap

  const maxTokens = e.maxTokens;
  return {
    provider: ours,
    id,
    name: typeof e.name === "string" && e.name !== "" ? e.name : id,
    context_window: ctx,
    max_output: typeof maxTokens === "number" && maxTokens > 0 ? maxTokens : 0,
    price: {
      input: cleanPrice(cost.input),
      output: cleanPrice(cost.output),
      cache_read: cleanPrice(cacheRead),
      cache_write: cleanPrice(cacheWrite),
    },
    // OpenAI's entries are all `openai-responses`, so `api` says nothing about Chat Completions there.
    tool_call: e.supportsTools !== false,
    reasoning: e.reasoning === true,
    cache_min_tokens: ours === "anthropic" ? anthropicCacheMin(id) : ours === "openai" ? OPENAI_CACHE_MIN : null,
  };
}

function inOpenRouterSet(id: string): boolean {
  const slash = id.indexOf("/");
  return slash > 0 && OPENROUTER_VENDORS.has(id.slice(0, slash));
}

/** Pure: the same input and commit always give the same file. */
export function buildCatalog(src: OmpCatalog, opts: BuildOptions): CatalogFile {
  if (!/^[0-9a-f]{40}$/.test(opts.commit)) {
    throw new Error(`commit must be 40 lowercase hex characters, got "${opts.commit}"`);
  }
  const models: ModelInfo[] = [];
  for (const [omp, ours] of PROVIDER_MAP) {
    const entries = Object.hasOwn(src, omp) ? src[omp] : undefined;
    if (!isRecord(entries)) throw new Error(`the OMP catalog has no provider "${omp}"`);
    let kept: ModelInfo[] = [];
    for (const [key, entry] of Object.entries(entries)) {
      const m = toModel(ours, key, entry);
      if (m) kept.push(m);
    }
    kept.sort((a, b) => compare(a.id, b.id));
    if (ours === "openrouter") kept = kept.filter((m) => inOpenRouterSet(m.id)).slice(0, OPENROUTER_CAP);
    models.push(...kept);
  }
  models.sort((a, b) => compare(a.provider, b.provider) || compare(a.id, b.id));
  return {
    version: 1,
    source: { repo: OMP_REPO, path: OMP_PATH, commit: opts.commit, license: "MIT" },
    models,
  };
}

/** The exact bytes of catalog/models.json. */
export function serializeCatalog(file: CatalogFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

// ---- The command line --------------------------------------------------------------------

const USAGE =
  "usage: bun run scripts/build-catalog.ts --commit <40-hex sha> [--file <local copy>] [--out <path>]";

export interface CliArgs {
  commit: string;
  /** A local copy of the file at `commit`; null downloads it. */
  file: string | null;
  out: string;
}

export function sourceUrl(commit: string): string {
  return `https://raw.githubusercontent.com/${OMP_REPO}/${commit}/${OMP_PATH}`;
}

export function parseArgs(argv: string[]): CliArgs {
  let commit: string | null = null;
  let file: string | null = null;
  let out = fileURLToPath(new URL("../catalog/models.json", import.meta.url));
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value\n${USAGE}`);
    if (flag === "--commit") commit = value;
    else if (flag === "--file") file = value;
    else if (flag === "--out") out = value;
    else throw new Error(`unknown argument ${flag}\n${USAGE}`);
  }
  if (commit === null) throw new Error(`--commit is required (it goes into source.commit, even with --file)\n${USAGE}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`--commit must be 40 lowercase hex characters\n${USAGE}`);
  return { commit, file, out };
}

async function download(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`GET ${url} gave HTTP ${res.status}`);
  return res.text();
}

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const text = args.file !== null ? readFileSync(args.file, "utf8") : await download(sourceUrl(args.commit));
  const parsed: unknown = JSON.parse(text);
  const src = isCompactCatalog(parsed) ? decodeOmpCatalog(parsed) : (parsed as OmpCatalog);
  const file = buildCatalog(src, { commit: args.commit });

  const counts = new Map<string, number>();
  for (const m of file.models) counts.set(m.provider, (counts.get(m.provider) ?? 0) + 1);
  for (const [, ours] of PROVIDER_MAP) {
    if (!counts.has(ours)) throw new Error(`no ${ours} models survived the filters; the OMP format has probably changed`);
  }

  const bytes = serializeCatalog(file);
  const tmp = `${args.out}.tmp`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, args.out);
  const sha = createHash("sha256").update(bytes).digest("hex");
  console.log(`wrote ${args.out}`);
  console.log(`commit ${args.commit}, ${file.models.length} models: ${[...counts].map(([p, n]) => `${p} ${n}`).join(", ")}`);
  console.log(`sha256 ${sha}`);
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
