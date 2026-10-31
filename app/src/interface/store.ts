// KV cache: none; the interface never touches the bytes sent to the model.
// The view model of one run (step 7). RunStore turns the bus's engine and gateway events into a
// RunView and publishes it at most every FLUSH_MS; statusModel and contextBreakdown are selectors
// over it, and viewFromRecord builds the same view from a run-log record for /runs.

import type { Catalog } from "../gateway/catalog.ts";
import type { AppEvents } from "../gateway/gateway.ts";
import type { KeyStore } from "../gateway/keys.ts";
import { requestChars } from "../gateway/usage.ts";
import type {
  ModelCompleteParams,
  ModelRef,
  Origin,
  RunBudgetParams,
  RunCellParams,
  RunFinishedParams,
  RunLimits,
  RunPermissionParams,
  RunReplyParams,
  RunStartedParams,
  RunSubcallParams,
  Usage,
} from "../protocol.ts";
import type { Session } from "../session.ts";
import { saveSettings, setSetting, type Settings } from "../settings.ts";
import type { ApprovalQueue } from "./approvals.ts";
import { cacheTone, contextTone, formatClock, formatCost, formatTokens, type StatusSegment } from "./format.ts";

/** Store changes reach React at most this often, so 20 streams don't repaint per chunk. */
export const FLUSH_MS = 50;
/** The tick that moves spinners and timers while a row streams or a root call is open. */
export const TICK_MS = 100;
/** The run clock's tick while a run is active but nothing streams. */
const CLOCK_MS = 1000;
const STDERR_LINES = 12;

/** What the interface needs of a Session; the fake engine in the tests builds one over in-memory links. */
export type SessionLike = Pick<Session, "bus" | "gateway" | "settings" | "info" | "start" | "cancel" | "vars" | "close">;

export interface AppDeps {
  session: SessionLike;
  keys: KeyStore;
  catalog: Catalog;
  approvals: ApprovalQueue;
  home: string;
  cwd: string;
  /** The terminal size; tests fix it, the app reads the terminal. */
  size?: { columns: number; rows: number };
  /** Where NO_COLOR, RLMH_ASCII, WT_SESSION and the providers' key variables are read; default process.env. */
  env?: Record<string, string | undefined>;
}

export type Phase = "idle" | "starting" | "running" | "cancelling" | "finished" | "cancelled" | "failed";
export type RowStatus = "queued" | "streaming" | "done" | "error" | "rejected";

export interface SubcallRow {
  /** `s<subcall_id>`, or `rej<n>` for a refused request (it has no sub-call id). */
  key: string;
  subcallId: number | null;
  batchId: string;
  index: number;
  origin: Origin;
  status: RowStatus;
  model: ModelRef | null;
  prompt: string;
  promptChars: number;
  text: string;
  reasoning: string;
  /** Exact, from call.end or the run log; until then the panel shows chars ÷ 4 estimates. */
  usage: Usage | null;
  seconds: number | null;
  /** Date.now() at call.start, for the live timer. */
  startedAt: number | null;
  error: string | null;
}

/** One llm_batch fan-out; a single llm() is a block of one. */
export interface Block {
  id: string;
  size: number;
  origin: Origin;
  rows: SubcallRow[];
}

export type Entry =
  | { kind: "question"; text: string; detail: string }
  | { kind: "started"; text: string }
  | { kind: "reply"; turn: number; text: string; reasoning: string; live: boolean }
  | { kind: "cell"; turn: number; code: string | null; output: string; error: string | null; notes: string[] }
  | { kind: "permission"; text: string; allowed: boolean }
  | { kind: "answer"; text: string }
  | { kind: "error"; text: string; lines: string[] }
  | { kind: "note"; text: string; tone: "info" | "warn" | "error" };

export interface Totals {
  root: Usage;
  sub: Usage;
  cost_usd: number;
  cache_hit_rate: number | null;
}

export interface RunView {
  phase: Phase;
  runId: string | null;
  /** infra_kind of a failed run, or "engine" when the engine exited. */
  failKind: string | null;
  /** A /runs replay: no cancel, no approvals. */
  readOnly: boolean;
  root: ModelRef | null;
  sub: ModelRef | null;
  permissionMode: string | null;
  limits: RunLimits | null;
  budget: { turnsLeft: number; subcallsLeft: number } | null;
  /** Date.now() when the run began, and when it ended. */
  startedAt: number | null;
  endedAt: number | null;
  entries: Entry[];
  blocks: Block[];
  permissions: RunPermissionParams[];
  /** Root replies so far. */
  turns: number;
  /** The code of each turn's cell, by turn, for the sub-call view's "Issued by" line. */
  cellCode: Record<number, string>;
  rootOpen: boolean;
  /** Context used: the latest reply's input + output, else ~chars ÷ 4 of the last root request. */
  ctx: { tokens: number; estimated: boolean } | null;
  totals: Totals | null;
  finished: RunFinishedParams | null;
  engineExit: { code: number; stderr: string[] } | null;
  /** Date.now() at the flush that built this view; screens draw timers from it. */
  now: number;
}

export interface QuestionInfo {
  text: string;
  /** `read: 2 files` or `repo: <folder>`. */
  detail: string;
}

export function emptyView(): RunView {
  return {
    phase: "idle",
    runId: null,
    failKind: null,
    readOnly: false,
    root: null,
    sub: null,
    permissionMode: null,
    limits: null,
    budget: null,
    startedAt: null,
    endedAt: null,
    entries: [],
    blocks: [],
    permissions: [],
    turns: 0,
    cellCode: {},
    rootOpen: false,
    ctx: null,
    totals: null,
    finished: null,
    engineExit: null,
    now: Date.now(),
  };
}

const ACTIVE: readonly Phase[] = ["starting", "running", "cancelling"];

export function isActive(phase: Phase): boolean {
  return ACTIVE.includes(phase);
}

/**
 * Listens to engine.event, call.start, call.delta, call.end and engine.exit, and drops events for
 * other run ids. beginRun() runs before session.start(): the first run.started while starting fixes
 * the run id, because it can arrive before start() resolves (same pipe, §5.4).
 */
export class RunStore {
  private readonly deps: AppDeps;
  private v: RunView = emptyView();
  private published: RunView = this.v;
  private readonly listeners = new Set<() => void>();
  private readonly off: (() => void)[] = [];
  /** Gateway call ids of this run: the root's live tail, or a sub-call row's key. */
  private readonly calls = new Map<string, { role: "root" } | { role: "sub"; key: string }>();
  private lastReply: Usage | null = null;
  private rejected = 0;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;
  private tick: { timer: ReturnType<typeof setInterval>; ms: number } | undefined;

  constructor(deps: AppDeps) {
    this.deps = deps;
    const bus = deps.session.bus;
    this.off.push(
      bus.on("engine.event", (e) => this.onEngine(e.method, e.params)),
      bus.on("call.start", (e) => this.onCallStart(e)),
      bus.on("call.delta", (e) => this.onCallDelta(e)),
      bus.on("call.end", (e) => this.onCallEnd(e)),
      bus.on("engine.exit", (e) => this.onEngineExit(e.code, e.stderr)),
    );
  }

  /** A fresh view for a new run; the question entry first, when given. */
  beginRun(question?: QuestionInfo): void {
    const exit = this.v.engineExit;
    this.v = { ...emptyView(), phase: "starting", startedAt: Date.now(), engineExit: exit };
    if (question) this.v.entries.push({ kind: "question", text: question.text, detail: question.detail });
    this.calls.clear();
    this.lastReply = null;
    this.rejected = 0;
    this.changed();
  }

  /** start() resolved. run.started has usually fixed the id already. */
  startResolved(runId: string): void {
    if (this.v.runId === null && this.awaitingId()) this.v.runId = runId;
  }

  /** Starting, or cancelled while starting: the first run.started or start() fixes the id. */
  private awaitingId(): boolean {
    return this.v.phase === "starting" || this.v.phase === "cancelling";
  }

  /** start() rejected (-32011, -32012, a usage error): the message, and back to idle. */
  startFailed(message: string): void {
    this.v.entries.push({ kind: "error", text: message, lines: [] });
    this.v.phase = "idle";
    this.v.startedAt = null;
    this.changed();
  }

  /** run.cancel was sent. */
  cancelling(): void {
    if (isActive(this.v.phase)) {
      this.v.phase = "cancelling";
      this.changed();
    }
  }

  note(text: string, tone: "info" | "warn" | "error" = "info"): void {
    this.v.entries.push({ kind: "note", text, tone });
    this.changed();
  }

  snapshot(): RunView {
    return this.published;
  }

  /** The phase and run id now, ahead of the next flush; key handlers decide on these. */
  live(): { phase: Phase; runId: string | null } {
    return { phase: this.v.phase, runId: this.v.runId };
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    for (const off of this.off.splice(0)) off();
    clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.setTick(0);
    this.listeners.clear();
  }

  // -- events --

  private onEngine(method: string, params: any): void {
    if (typeof params?.run_id !== "string") return;
    if (method === "run.started" && this.v.runId === null && this.awaitingId()) this.v.runId = params.run_id;
    if (params.run_id !== this.v.runId || this.v.runId === null) return;
    switch (method) {
      case "run.started":
        this.started(params as RunStartedParams);
        break;
      case "run.reply":
        this.reply(params as RunReplyParams);
        break;
      case "run.cell":
        this.cell(params as RunCellParams);
        break;
      case "run.subcall":
        this.subcall(params as RunSubcallParams);
        break;
      case "run.permission":
        this.permission(params as RunPermissionParams);
        break;
      case "run.budget": {
        const b = params as RunBudgetParams;
        this.v.budget = { turnsLeft: b.turns_left, subcallsLeft: b.subcalls_left };
        break;
      }
      case "run.finished":
        this.finished(params as RunFinishedParams);
        break;
      default:
        return;
    }
    this.changed();
  }

  private started(p: RunStartedParams): void {
    const v = this.v;
    if (v.phase === "starting") v.phase = "running";
    v.root = p.root;
    v.sub = p.sub;
    v.permissionMode = p.permission_mode;
    v.limits = p.limits;
    v.budget ??= { turnsLeft: p.limits.max_turns, subcallsLeft: p.limits.max_subcalls };
    v.entries.push({ kind: "started", text: startedLine(p) });
  }

  private reply(p: RunReplyParams): void {
    const v = this.v;
    v.turns = Math.max(v.turns, p.turn);
    this.lastReply = p.usage;
    v.rootOpen = false;
    for (const [id, c] of this.calls) if (c.role === "root") this.calls.delete(id);
    const entry: Entry = { kind: "reply", turn: p.turn, text: p.text, reasoning: p.reasoning ?? "", live: false };
    const live = v.entries.findIndex((e) => e.kind === "reply" && e.live);
    if (live >= 0) v.entries[live] = entry;
    else v.entries.push(entry);
    const code = p.tool_call?.arguments?.code;
    if (typeof code === "string" && v.cellCode[p.turn] === undefined) v.cellCode[p.turn] = code;
  }

  private cell(p: RunCellParams): void {
    if (p.code !== null) this.v.cellCode[p.turn] = p.code;
    this.v.entries.push({ kind: "cell", turn: p.turn, code: p.code, output: p.output, error: p.error, notes: cellNotes(p) });
  }

  private subcall(p: RunSubcallParams): void {
    if (p.status === "rejected" || p.subcall_id === null) {
      const row = newRow(`rej${++this.rejected}`, null, p.batch.id, 0, p.origin);
      row.status = "rejected";
      row.promptChars = p.prompt_chars;
      row.error = p.error;
      row.usage = null;
      this.blockFor(p.batch.id, p.batch.size, p.origin).rows.push(row);
      return;
    }
    const row = this.row(p.subcall_id, p.batch.id, p.batch.index, p.batch.size, p.origin);
    row.promptChars = p.prompt_chars;
    row.origin = p.origin;
    if (p.seconds !== null) row.seconds ??= p.seconds;
    if (p.status === "done" && (row.status === "queued" || row.status === "streaming")) row.status = "done";
    if (p.status === "error" && row.status !== "error") {
      row.status = "error";
      row.error ??= p.error;
    }
  }

  private permission(p: RunPermissionParams): void {
    this.v.permissions.push(p);
    if (p.asked || !p.allowed) this.v.entries.push({ kind: "permission", text: permissionLine(p), allowed: p.allowed });
  }

  private finished(p: RunFinishedParams): void {
    const v = this.v;
    v.finished = p;
    v.phase = p.infra_kind === "cancelled" ? "cancelled" : p.infra_error ? "failed" : "finished";
    v.failKind = v.phase === "failed" ? (p.infra_kind ?? "other") : null;
    v.endedAt = Date.now();
    v.rootOpen = false;
    v.entries = v.entries.filter((e) => !(e.kind === "reply" && e.live));
    for (const b of v.blocks) {
      for (const r of b.rows) {
        if (r.status === "queued" || r.status === "streaming") {
          r.status = "error";
          r.error ??= "the run ended before this call finished";
        }
      }
    }
    v.entries.push(...finishEntries(p));
    this.deps.approvals.denyAll();
  }

  private onCallStart(e: AppEvents["call.start"]): void {
    if (this.v.runId === null || e.run_id !== this.v.runId || this.v.readOnly) return;
    if (e.role === "root") {
      this.calls.set(e.call_id, { role: "root" });
      this.v.rootOpen = true;
      this.v.entries = this.v.entries.filter((x) => !(x.kind === "reply" && x.live));
      this.v.entries.push({ kind: "reply", turn: this.v.turns + 1, text: "", reasoning: "", live: true });
    } else if (e.subcall_id !== undefined) {
      const batch = e.batch ?? { id: `call${e.subcall_id}`, index: 0, size: 1 };
      const row = this.row(e.subcall_id, batch.id, batch.index, batch.size, e.origin ?? { turn: this.v.turns, line: null });
      row.status = row.status === "queued" ? "streaming" : row.status;
      row.prompt = e.prompt;
      row.model = e.model;
      row.startedAt = e.started_at;
      this.calls.set(e.call_id, { role: "sub", key: row.key });
    } else {
      return;
    }
    this.changed();
  }

  private onCallDelta(e: AppEvents["call.delta"]): void {
    const c = this.calls.get(e.call_id);
    if (!c) return;
    let target: { text: string; reasoning: string } | undefined;
    if (c.role === "root") {
      const live = this.v.entries.find((x) => x.kind === "reply" && x.live);
      target = live?.kind === "reply" ? live : undefined;
    } else {
      target = this.findRow(c.key);
    }
    if (!target) return;
    if (e.reset) {
      target.text = "";
      target.reasoning = "";
    }
    if (e.text) target.text += e.text;
    if (e.reasoning) target.reasoning += e.reasoning;
    this.changed();
  }

  private onCallEnd(e: AppEvents["call.end"]): void {
    const c = this.calls.get(e.call_id);
    if (!c || e.run_id !== this.v.runId) return;
    if (c.role === "root") {
      this.v.rootOpen = false;
      this.calls.delete(e.call_id);
      if (e.error) this.v.entries = this.v.entries.filter((x) => !(x.kind === "reply" && x.live));
    } else {
      const row = this.findRow(c.key);
      if (!row) return;
      row.seconds = e.seconds;
      if (e.error) {
        row.status = "error";
        row.error = e.error.message;
      } else {
        row.status = "done";
        row.usage = e.usage;
      }
    }
    this.changed();
  }

  private onEngineExit(code: number, stderr: string[]): void {
    const v = this.v;
    v.engineExit = { code, stderr: stderr.slice(-STDERR_LINES) };
    if (isActive(v.phase)) {
      v.phase = "failed";
      v.failKind = "engine";
      v.endedAt = Date.now();
      v.rootOpen = false;
    }
    v.entries.push({ kind: "error", text: engineStoppedMessage(code), lines: v.engineExit.stderr });
    this.deps.approvals.denyAll();
    this.changed();
  }

  // -- rows and blocks --

  private blockFor(id: string, size: number, origin: Origin): Block {
    let block = this.v.blocks.find((b) => b.id === id);
    if (!block) {
      block = { id, size, origin, rows: [] };
      this.v.blocks.push(block);
    }
    return block;
  }

  private row(subcallId: number, batchId: string, index: number, size: number, origin: Origin): SubcallRow {
    const key = `s${subcallId}`;
    const found = this.findRow(key);
    if (found) return found;
    const block = this.blockFor(batchId, size, origin);
    const row = newRow(key, subcallId, batchId, index, origin);
    block.rows.push(row);
    block.rows.sort((a, b) => a.index - b.index);
    return row;
  }

  private findRow(key: string): SubcallRow | undefined {
    for (const b of this.v.blocks) for (const r of b.rows) if (r.key === key) return r;
    return undefined;
  }

  // -- publishing --

  private changed(): void {
    if (this.flushTimer !== undefined) return;
    const wait = Math.max(0, this.lastFlush + FLUSH_MS - Date.now());
    this.flushTimer = setTimeout(() => this.flush(), wait);
  }

  private flush(): void {
    this.flushTimer = undefined;
    this.lastFlush = Date.now();
    const v = this.v;
    if (v.runId !== null && !v.readOnly) {
      v.totals = this.deps.session.gateway.totals(v.runId);
      if (this.lastReply) {
        v.ctx = { tokens: this.lastReply.input_tokens + this.lastReply.output_tokens, estimated: false };
      } else {
        const req = this.deps.session.gateway.lastRootRequest(v.runId);
        if (req) v.ctx = { tokens: Math.ceil(requestChars(req) / 4), estimated: true };
      }
    }
    v.now = this.lastFlush;
    this.published = copyView(v);
    const streaming = v.rootOpen || v.blocks.some((b) => b.rows.some((r) => r.status === "streaming"));
    this.setTick(streaming ? TICK_MS : isActive(v.phase) ? CLOCK_MS : 0);
    for (const fn of [...this.listeners]) fn();
  }

  private setTick(ms: number): void {
    if (this.tick?.ms === ms) return;
    if (this.tick) clearInterval(this.tick.timer);
    this.tick = ms > 0 ? { timer: setInterval(() => this.changed(), ms), ms } : undefined;
  }
}

/** A copy the next events can't change: entries, blocks and rows are new objects. */
function copyView(v: RunView): RunView {
  return {
    ...v,
    entries: v.entries.map((e) => ({ ...e })),
    blocks: v.blocks.map((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r })) })),
    permissions: [...v.permissions],
    cellCode: { ...v.cellCode },
  };
}

function newRow(key: string, subcallId: number | null, batchId: string, index: number, origin: Origin): SubcallRow {
  return {
    key,
    subcallId,
    batchId,
    index,
    origin,
    status: "queued",
    model: null,
    prompt: "",
    promptChars: 0,
    text: "",
    reasoning: "",
    usage: null,
    seconds: null,
    startedAt: null,
    error: null,
  };
}

export function engineStoppedMessage(code: number): string {
  return `The engine stopped (exit ${code}). Restart rlmh.`;
}

function refText(r: ModelRef): string {
  return `${r.provider}/${r.model}`;
}

function sameModel(a: ModelRef, b: ModelRef): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function startedLine(p: { run_id: string; profile: string; call_format: string; root: ModelRef; sub: ModelRef; permission_mode: string }): string {
  const sub = sameModel(p.root, p.sub) ? "same" : refText(p.sub);
  return `Run ${p.run_id} started: profile ${p.profile}, ${p.call_format}, root ${refText(p.root)}, sub ${sub}, ${p.permission_mode}`;
}

function cellNotes(p: { restarted: boolean; crash: string | null; repo_changed: boolean | null }): string[] {
  const notes: string[] = [];
  if (p.restarted) notes.push("the REPL restarted");
  if (p.crash) notes.push(`crash: ${p.crash}`);
  if (p.repo_changed) notes.push("the repository changed");
  return notes;
}

export function permissionLine(p: { turn: number; kind: string; detail: string; allowed: boolean; asked: boolean; remembered: boolean }): string {
  const how = p.asked ? "asked" : p.remembered ? "remembered" : "automatic";
  return `turn ${p.turn}  ${p.kind} ${p.detail} ${p.allowed ? "allowed" : "denied"} (${how})`;
}

function answerText(answer: unknown): string {
  return typeof answer === "string" ? answer : JSON.stringify(answer);
}

function finishEntries(p: { answer: unknown; submitted: boolean; infra_error: string | null; infra_kind: string | null }): Entry[] {
  if (p.infra_kind === "cancelled") return [{ kind: "note", text: "Run cancelled.", tone: "warn" }];
  if (p.infra_error) return [{ kind: "error", text: p.infra_error, lines: [] }];
  if (p.submitted && p.answer !== null && p.answer !== undefined) return [{ kind: "answer", text: answerText(p.answer) }];
  return [{ kind: "note", text: "The run ended without an answer.", tone: "warn" }];
}

// -- selectors --

/**
 * The status line's segments, before layoutStatus drops what doesn't fit. With no run the models
 * come from settings, and the mode is the one the next run would use.
 */
export function statusModel(view: RunView, deps: AppDeps, nextMode?: string): StatusSegment[] {
  const settings = deps.session.settings;
  const segs: StatusSegment[] = [{ id: "state", ...stateText(view, deps) }];
  const root = view.root ?? settingsRef(settings.root.model);
  const sub = view.root ? view.sub : settings.sub.model === "" ? root : settingsRef(settings.sub.model);
  segs.push({ id: "root", text: `root ${root ? refText(root) : "none"}` });
  segs.push({ id: "sub", text: `sub ${!sub || (root && sameModel(root, sub)) ? "same" : refText(sub)}` });
  if (view.ctx && root) {
    const window = deps.catalog.get(root.provider, root.model)?.context_window;
    const used = `${view.ctx.estimated ? "~" : ""}${formatTokens(view.ctx.tokens)}`;
    if (window) {
      const pct = (view.ctx.tokens / window) * 100;
      segs.push({ id: "ctx", text: `ctx ${used}/${formatTokens(window)} ${Math.round(pct)}%`, tone: contextTone(pct) });
    } else {
      segs.push({ id: "ctx", text: `ctx ${used}/?` });
    }
  }
  if (view.totals) {
    const t = view.totals;
    segs.push({ id: "cost", text: `${formatCost(t.cost_usd)} (root ${formatCost(t.root.cost_usd)} + sub ${formatCost(t.sub.cost_usd)})` });
    const rate = t.cache_hit_rate;
    segs.push(rate === null ? { id: "cache", text: "cache --" } : { id: "cache", text: `cache ${Math.round(rate * 100)}%`, tone: cacheTone(rate) });
  }
  if (view.limits && view.budget) {
    const { limits: l, budget: b } = view;
    segs.push({ id: "budget", text: `turns left ${b.turnsLeft}/${l.max_turns}, sub-calls left ${b.subcallsLeft}/${l.max_subcalls}` });
  }
  const mode = isActive(view.phase) && view.permissionMode ? view.permissionMode : (nextMode ?? settings.permissions.mode);
  segs.push({ id: "mode", text: mode, tone: mode === "bypass" ? "high" : undefined });
  return segs;
}

function stateText(view: RunView, deps: AppDeps): { text: string; tone?: StatusSegment["tone"] } {
  switch (view.phase) {
    case "idle":
      return { text: "idle" };
    case "starting":
      return { text: "starting" };
    case "running":
      if (deps.approvals.size > 0) return { text: "waiting for approval", tone: "warn" };
      return { text: `running ${formatClock(((view.now ?? Date.now()) - (view.startedAt ?? view.now)) / 1000)}` };
    case "cancelling":
      return { text: "cancelling", tone: "warn" };
    case "finished":
      return { text: "finished", tone: "ok" };
    case "cancelled":
      return { text: "cancelled", tone: "warn" };
    case "failed":
      return { text: `failed: ${view.failKind ?? "other"}`, tone: "high" };
  }
}

function settingsRef(model: string): ModelRef | null {
  const slash = model.indexOf("/");
  return slash > 0 ? { provider: model.slice(0, slash), model: model.slice(slash + 1), thinking: null } : null;
}

export interface ContextSegment {
  label: string;
  chars: number;
  /** chars ÷ 4, unrounded, so the segments add up to the request's estimate. */
  tokens: number;
}

/**
 * /context: the root request split into system (messages[0]), first message (messages[1]),
 * turns (the rest), tool def, and the output reserve (max_tokens). The first four add up to
 * requestChars(request) / 4, the gateway's own estimate.
 */
export function contextBreakdown(request: ModelCompleteParams): { segments: ContextSegment[]; reserve: number; estimate: number } {
  const msgChars = (m: ModelCompleteParams["messages"][number]) =>
    m.content.length + (m.role === "assistant" && m.tool_call ? JSON.stringify(m.tool_call.arguments).length : 0);
  const [system, first, ...rest] = request.messages;
  const turns = rest.filter((m) => m.role === "assistant").length;
  const seg = (label: string, chars: number): ContextSegment => ({ label, chars, tokens: chars / 4 });
  const segments = [
    seg("system", system ? msgChars(system) : 0),
    seg("first message", first ? msgChars(first) : 0),
    seg(`turns (${turns})`, rest.reduce((n, m) => n + msgChars(m), 0)),
    seg("tool def", JSON.stringify(request.tools).length),
  ];
  return { segments, reserve: request.max_tokens, estimate: requestChars(request) / 4 };
}

/** setSetting, then saveSettings, then the session and the gateway read the new settings. Throws SettingsError. */
export function applySetting(deps: AppDeps, key: string, value: unknown): Settings {
  const next = setSetting(deps.session.settings, key, value);
  saveSettings(deps.home, next);
  deps.session.settings = next;
  deps.session.gateway.settings = next;
  return next;
}

// -- the run log --

/** A run-log record (§7.8) as the same view a live run builds, read-only, for /runs. */
export function viewFromRecord(record: Record<string, any>): RunView {
  const v = emptyView();
  v.readOnly = true;
  v.runId = str(record.run_id);
  v.root = isRef(record.root) ? record.root : null;
  v.sub = isRef(record.sub) ? record.sub : null;
  v.permissionMode = str(record.permission_mode);
  v.limits = isObj(record.limits) ? (record.limits as RunLimits) : null;
  v.startedAt = typeof record.started_at === "number" ? record.started_at * 1000 : null;
  v.endedAt = v.startedAt !== null && typeof record.wall_s === "number" ? v.startedAt + record.wall_s * 1000 : null;
  v.now = v.endedAt ?? Date.now();

  const files: string[] = Array.isArray(record.input?.files) ? record.input.files : [];
  const text = str(record.mode === "repo" ? record.task : record.question) ?? "";
  const detail = record.mode === "repo" ? `repo: ${str(record.workspace) ?? "?"}` : `read: ${files.length} file${files.length === 1 ? "" : "s"}`;
  v.entries.push({ kind: "question", text, detail });
  if (v.root && v.sub) {
    v.entries.push({
      kind: "started",
      text: startedLine({
        run_id: v.runId ?? "?",
        profile: str(record.profile) ?? "?",
        call_format: str(record.call_format) ?? "?",
        root: v.root,
        sub: v.sub,
        permission_mode: v.permissionMode ?? "?",
      }),
    });
  }

  const turns: any[] = Array.isArray(record.turns) ? record.turns : [];
  const perms: RunPermissionParams[] = Array.isArray(record.permissions) ? record.permissions : [];
  v.permissions = perms;
  for (const t of turns) {
    const turn = typeof t.turn === "number" ? t.turn : v.turns + 1;
    v.turns = Math.max(v.turns, turn);
    v.entries.push({ kind: "reply", turn, text: str(t.reply) ?? "", reasoning: str(t.reasoning) ?? "", live: false });
    if (typeof t.code === "string") v.cellCode[turn] = t.code;
    if (t.code !== null || t.error !== null) {
      v.entries.push({
        kind: "cell",
        turn,
        code: str(t.code),
        output: str(t.stdout) ?? "",
        error: str(t.error),
        notes: cellNotes({ restarted: t.restarted === true, crash: str(t.crash), repo_changed: t.repo_changed === true }),
      });
    }
    for (const p of perms) {
      if (p.turn === turn && (p.asked || !p.allowed)) v.entries.push({ kind: "permission", text: permissionLine(p), allowed: p.allowed });
    }
  }

  const subcalls: any[] = Array.isArray(record.subcalls) ? record.subcalls : [];
  for (const s of subcalls) {
    const batch = isObj(s.batch) ? s.batch : { id: `call${s.subcall_id}`, index: 0, size: 1 };
    const origin: Origin = isObj(s.origin) ? s.origin : { turn: 0, line: null };
    let block = v.blocks.find((b) => b.id === batch.id);
    if (!block) {
      block = { id: batch.id, size: batch.size, origin, rows: [] };
      v.blocks.push(block);
    }
    const row = newRow(`s${s.subcall_id}`, s.subcall_id ?? null, batch.id, batch.index ?? 0, origin);
    row.status = s.error ? "error" : "done";
    row.model = v.sub;
    row.prompt = str(s.prompt) ?? "";
    row.promptChars = row.prompt.length;
    row.text = str(s.output) ?? "";
    row.reasoning = str(s.reasoning) ?? "";
    row.usage = isObj(s.usage) ? (s.usage as Usage) : null;
    row.seconds = typeof s.seconds === "number" ? s.seconds : null;
    row.error = str(s.error);
    block.rows.push(row);
  }
  for (const b of v.blocks) b.rows.sort((a, z) => a.index - z.index);

  const infraKind = str(record.infra_kind);
  const infraError = str(record.infra_error);
  v.phase = infraKind === "cancelled" ? "cancelled" : infraError ? "failed" : "finished";
  v.failKind = v.phase === "failed" ? (infraKind ?? "other") : null;
  v.entries.push(...finishEntries({ answer: record.answer, submitted: record.submitted === true, infra_error: infraError, infra_kind: infraKind }));

  if (isObj(record.usage) && isObj(record.usage.root) && isObj(record.usage.sub)) {
    v.totals = {
      root: record.usage.root as Usage,
      sub: record.usage.sub as Usage,
      cost_usd: typeof record.cost_usd === "number" ? record.cost_usd : 0,
      cache_hit_rate: typeof record.cache?.hit_rate === "number" ? record.cache.hit_rate : null,
    };
  }
  const last = turns[turns.length - 1];
  if (isObj(last?.usage)) v.ctx = { tokens: (last.usage.input_tokens ?? 0) + (last.usage.output_tokens ?? 0), estimated: false };
  return v;
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isRef(v: unknown): v is ModelRef {
  return isObj(v) && typeof v.provider === "string" && typeof v.model === "string";
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
