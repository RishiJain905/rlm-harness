// KV cache: adds cache markers on whole blocks only (no text is split, merged or reordered, so the model reads the same bytes with or without them); same input, same bytes, no clock, no randomness, fixed key order.
// Also the llm_batch rule (D-24): which call goes first, and when the rest follow.

import type { ProviderDef } from "./providers.ts";

/** Splitting a prompt into two text blocks needs proof (count_tokens on both shapes) that the model sees the same bytes. Off until then. */
export const ANTHROPIC_SPLIT_PREFIX = false;
/** cache_min_tokens when the catalog gives null. */
export const DEFAULT_CACHE_MIN_TOKENS = 1024;

type Block = Record<string, unknown>;
interface MarkableBody {
  system?: Block[];
  messages: { role: string; content: Block[] }[];
}

/**
 * Breakpoints at the end of `system` and on the last block of the last message: 2 of Anthropic's 4.
 * `splitAt` (chars) splits the last message's first text block there and marks the first part;
 * only for the shared-prefix experiment behind ANTHROPIC_SPLIT_PREFIX.
 */
export function anthropicBreakpoints<B extends MarkableBody>(body: B, opts: { splitAt?: number } = {}): B {
  const marked = (b: Block): Block => ({ ...b, cache_control: { type: "ephemeral" } });
  const out: B = { ...body };
  if (body.system && body.system.length > 0) out.system = [...body.system.slice(0, -1), marked(body.system[body.system.length - 1]!)];
  const messages = body.messages;
  if (messages.length === 0) return out;
  const last = messages[messages.length - 1]!;
  let content = last.content;
  const first = content[0];
  if (opts.splitAt !== undefined && first?.type === "text" && typeof first.text === "string" && opts.splitAt > 0 && opts.splitAt < first.text.length) {
    content = [marked({ ...first, text: first.text.slice(0, opts.splitAt) }), { ...first, text: first.text.slice(opts.splitAt) }, ...content.slice(1)];
  } else if (content.length > 0) {
    content = [...content.slice(0, -1), marked(content[content.length - 1]!)];
  }
  out.messages = [...messages.slice(0, -1), { ...last, content }];
  return out;
}

/** The longest common prefix, by characters, never ending inside a surrogate pair. */
export function sharedPrefix(prompts: readonly string[]): string {
  if (prompts.length === 0) return "";
  let n = Math.min(...prompts.map((p) => p.length));
  const first = prompts[0]!;
  for (const p of prompts) {
    let i = 0;
    while (i < n && p.charCodeAt(i) === first.charCodeAt(i)) i++;
    n = i;
  }
  const lastCode = n > 0 ? first.charCodeAt(n - 1) : 0;
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) n -= 1; // a lone high surrogate: the pair differs after it
  return first.slice(0, n);
}

export interface BatchPlan {
  /** First call alone, the rest after its first token. */
  apply: boolean;
  prefixChars: number;
  /** Anthropic: every call in the group carries a marker on the shared block. */
  marker: boolean;
  /** Anthropic with ANTHROPIC_SPLIT_PREFIX: mark a split at prefixChars. */
  split: boolean;
}

export interface PlanOptions {
  caching: ProviderDef["caching"];
  cacheMinTokens: number | null;
  /** Allow a split prefix on Anthropic (the pure function only; the gateway passes ANTHROPIC_SPLIT_PREFIX). */
  split?: boolean;
}

/**
 * The batch rule (D-24): the provider caches, at least 2 calls, and the shared prefix reaches the
 * model's minimum cacheable length (chars / 4). On Anthropic the prompts must be identical, so the
 * shared prefix is one whole block, unless `split` is allowed.
 */
export function planBatch(prompts: readonly string[], opts: PlanOptions): BatchPlan {
  const none: BatchPlan = { apply: false, prefixChars: 0, marker: false, split: false };
  if (opts.caching === "none" || prompts.length < 2) return none;
  const prefixChars = sharedPrefix(prompts).length;
  if (Math.ceil(prefixChars / 4) < (opts.cacheMinTokens ?? DEFAULT_CACHE_MIN_TOKENS)) return none;
  if (opts.caching !== "anthropic") return { apply: true, prefixChars, marker: false, split: false };
  const identical = prompts.every((p) => p === prompts[0]);
  if (identical) return { apply: true, prefixChars, marker: true, split: false };
  return opts.split ? { apply: true, prefixChars, marker: true, split: true } : none;
}

export interface BatchTicket {
  plan: BatchPlan;
  leader: boolean;
  /** Anthropic: this call's own prompt carries the marker. */
  marker: boolean;
  /** Call on the call's first stream content. */
  content(): void;
  /** Call once when the call ends, however it ends. */
  end(): void;
}

interface Group {
  size: number;
  opts: PlanOptions;
  prompts: Map<number, string>;
  plan: BatchPlan | null;
  planned: Promise<void>;
  setPlanned(): void;
  released: Promise<void>;
  release(): void;
  leader: number;
  ended: number;
  timers: ReturnType<typeof setTimeout>[];
}

/**
 * Holds a batch's sub-calls (keyed by run and batch id) until all `size` arrived or the collect
 * window passed, then plans once. With the rule, the lowest index goes first and the others wait
 * for its first content or its end, at most the leader wait. Late arrivals follow the same plan.
 */
export class BatchGate {
  private readonly groups = new Map<string, Group>();
  private readonly limits: { BATCH_COLLECT_MS: number; BATCH_LEADER_WAIT_MS: number };

  /** `limits` is read at use time, so tests can shorten it. */
  constructor(limits: { BATCH_COLLECT_MS: number; BATCH_LEADER_WAIT_MS: number }) {
    this.limits = limits;
  }

  /** The group plans with the first member's `opts`. Rejects with the signal's reason when it aborts while waiting. */
  async enter(key: string, member: { index: number; size: number; prompt: string }, opts: PlanOptions, signal: AbortSignal): Promise<BatchTicket> {
    const g = this.group(key, member.size, opts);
    g.prompts.set(member.index, member.prompt);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (member.index === g.leader) g.release();
      g.ended += 1;
      if (g.ended >= g.size && this.groups.get(key) === g) this.drop(key);
    };
    try {
      if (!g.plan) {
        if (g.prompts.size >= g.size) this.finish(g);
        else if (g.prompts.size === 1) g.timers.push(setTimeout(() => this.finish(g), this.limits.BATCH_COLLECT_MS));
        await abortable(g.planned, signal);
      }
      const plan = g.plan!;
      const leader = plan.apply && member.index === g.leader;
      if (plan.apply && !leader) await abortable(g.released, signal);
      const first = g.prompts.get(g.leader) ?? "";
      const marker = plan.marker && (plan.split || member.prompt === first);
      return {
        plan,
        leader,
        marker,
        content: () => {
          if (leader) g.release();
        },
        end,
      };
    } catch (err) {
      end();
      throw err;
    }
  }

  /** Forget a run's groups (run finished or cancelled); their waiters are cancelled by their own signals. */
  dropRun(runId: string): void {
    for (const key of [...this.groups.keys()]) if (key.startsWith(`${runId}\0`)) this.drop(key);
  }

  private group(key: string, size: number, opts: PlanOptions): Group {
    let g = this.groups.get(key);
    if (g) return g;
    let setPlanned!: () => void;
    let resolveReleased!: () => void;
    const planned = new Promise<void>((r) => (setPlanned = r));
    const released = new Promise<void>((r) => (resolveReleased = r));
    const timers: ReturnType<typeof setTimeout>[] = [];
    const release = () => {
      for (const t of timers) clearTimeout(t); // the leader wait, once released, holds nothing open
      resolveReleased();
    };
    g = { size, opts, prompts: new Map(), plan: null, planned, setPlanned, released, release, leader: -1, ended: 0, timers };
    this.groups.set(key, g);
    return g;
  }

  private finish(g: Group): void {
    if (g.plan) return;
    const indexes = [...g.prompts.keys()].sort((a, b) => a - b);
    g.leader = indexes[0]!;
    g.plan = planBatch(
      indexes.map((i) => g.prompts.get(i)!),
      g.opts,
    );
    if (g.plan.apply) g.timers.push(setTimeout(() => g.release(), this.limits.BATCH_LEADER_WAIT_MS));
    else g.release();
    g.setPlanned();
  }

  private drop(key: string): void {
    const g = this.groups.get(key);
    if (!g) return;
    for (const t of g.timers) clearTimeout(t);
    this.groups.delete(key);
  }
}

function abortable(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}
