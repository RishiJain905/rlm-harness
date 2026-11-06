// KV cache: none; the interface never touches the bytes sent to the model.
// The view model of one run (step 7). RunStore turns the bus's engine and gateway events into a
// RunView and publishes it at most every FLUSH_MS; statusModel and contextBreakdown are selectors
// over it, and viewFromRecord builds the same view from a run-log record for /runs.

import type { Catalog } from "../gateway/catalog.ts";
import type { AppEvents } from "../gateway/gateway.ts";
import type { KeyStore } from "../gateway/keys.ts";
import { requestChars } from "../gateway/usage.ts";
import type {
  ChildTurn,
  ModelCompleteParams,
  ModelRef,
  Origin,
  RunBudgetParams,
  RunCellParams,
  RunChildParams,
  RunClosedParams,
  RunCompactedParams,
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
import { refKey, type Conversation } from "./conversation.ts";
import { cacheTone, contextTone, formatClock, formatCost, formatTokens, thousands, unicodeSupported, type StatusSegment } from "./format.ts";

/** Store changes reach React at most this often, so 20 streams don't repaint per chunk. */
export const FLUSH_MS = 50;
/** The tick that moves spinners and timers while a row streams or a root call is open. */
export const TICK_MS = 100;
/** The run clock's tick while a run is active but nothing streams. */
const CLOCK_MS = 1000;
const STDERR_LINES = 12;
/** Most engine events kept while start() is unresolved; a start answers within a few. */
const EARLY_MAX = 256;

/** What the interface needs of a Session; the fake engine in the tests builds one over in-memory links. */
export type SessionLike = Pick<Session, "bus" | "gateway" | "settings" | "info" | "start" | "cancel" | "vars" | "say" | "closeRun" | "close" | "checkProfile">;

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
  /** Set when the row is an rlm() child run (D-160): its text is every turn's reply after a `── turn k ──` line, and its
   *  usage the sum of its turns. */
  child: ChildInfo | null;
  /** A root row of an earlier prompt of the conversation: its "Issued by" line, frozen when the next prompt began,
   *  because turns count from 1 again in every prompt (D-199) and `cellCode` then holds the new prompt's cells. */
  issued?: string;
}

/** "Issued by turn T, line L: <that line of the cell>", once the cell's code is known; `rlm<n> turn T` for a call an
 *  rlm() child made, whose cells `cellCode` then holds. */
export function issuedBy(row: SubcallRow, cellCode: Record<number, string>): string {
  if (row.issued !== undefined) return row.issued;
  const { turn, line } = row.origin;
  const by = row.origin.child === undefined ? `turn ${turn}` : `rlm${row.origin.child} turn ${turn}`;
  if (line === null) return `Issued by ${by}, line unknown`;
  const text = cellCode[turn]?.split("\n")[line - 1]?.trim();
  return `Issued by ${by}, line ${line}${text ? `: ${text}` : ""}`;
}

/** One cell of an rlm() child, from run.child "turn". */
export interface ChildCell {
  turn: number;
  code: string | null;
  output: string | null;
  error: string | null;
}

export interface ChildInfo {
  id: number;
  depth: number;
  task: string;
  tools: string;
  /** The child's latest turn so far, and its limit. */
  turn: number;
  maxTurns: number;
  cells: ChildCell[];
  /** The submitted answer, once run.child "done" arrived. */
  answer: unknown;
  done: boolean;
}

/** One llm_batch fan-out; a single llm() is a block of one, and an rlm() child's row is a block of its own (`rlm<n>`). */
export interface Block {
  id: string;
  size: number;
  origin: Origin;
  /** The rlm() child whose cell made these calls (origin.child), or null for the root's. */
  child: number | null;
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
  | { kind: "note"; text: string; tone: "info" | "warn" | "error" }
  /** The live tail while a compaction's summary call runs (v1 step 3), in place of a reply. */
  | { kind: "compacting" };

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
  /** The run's conversation (v1 step 4), from run.started with `conversation: true`; null for a one-shot run. */
  conversation: Conversation | null;
  /** The prompt the view shows last: 0 for the run's first question, k for follow-up k. */
  prompt: number;
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
    conversation: null,
    prompt: 0,
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
 * the run id, because it can arrive before start() resolves (same pipe, §5.4). A run that fails to
 * start sends the start result and run.finished with no run.started, often in one read, so the
 * events that arrive while the id is unknown are kept and handled once startResolved() names it.
 */
export class RunStore {
  private readonly deps: AppDeps;
  private v: RunView = emptyView();
  private published: RunView = this.v;
  private readonly listeners = new Set<() => void>();
  private readonly off: (() => void)[] = [];
  /** Gateway call ids of this run: the root's live tail, or a sub-call row's key. */
  private readonly calls = new Map<string, { role: "root"; compact?: true } | { role: "sub"; key: string; child?: ChildCall; compact?: true }>();
  /** `── turn k ──` with box-drawing, or `-- turn k --` in ASCII mode, as the theme draws its rules. */
  private readonly unicode: boolean;
  private lastReply: Usage | null = null;
  /** after_tokens of the root's latest compaction, the context until the next reply says otherwise (v1 step 3). */
  private compactedTo: number | null = null;
  private rejected = 0;
  /** Engine events that came while starting with no run id yet, for startResolved() to replay. */
  private early: { method: string; params: any }[] = [];
  /** What beginFollowUp changed, for followUpFailed to put back. */
  private beforeFollowUp: Pick<RunView, "phase" | "startedAt" | "endedAt" | "finished" | "failKind" | "prompt" | "turns" | "budget"> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private lastFlush = 0;
  private tick: { timer: ReturnType<typeof setInterval>; ms: number } | undefined;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.unicode = unicodeSupported(deps.env ?? process.env, process.platform);
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
    this.early = [];
    this.lastReply = null;
    this.compactedTo = null;
    this.rejected = 0;
    this.changed();
  }

  /**
   * /clear: back to an empty idle view, as at launch. Only the engine's exit survives it (the transcript
   * shows it again), because that is still true. The caller checks that no run is active.
   */
  clear(): void {
    const exit = this.v.engineExit;
    this.v = { ...emptyView(), engineExit: exit };
    if (exit) this.v.entries.push({ kind: "error", text: engineStoppedMessage(exit.code), lines: exit.stderr });
    this.calls.clear();
    this.early = [];
    this.lastReply = null;
    this.compactedTo = null;
    this.rejected = 0;
    this.changed();
  }

  /**
   * The next question of the open conversation (v1 step 4), before run.say is sent: the run id, the transcript and the
   * panel's rows stay; the question is added with detail `follow-up <k>`, and the prompt's turns and budgets start over.
   */
  beginFollowUp(question: string): void {
    const v = this.v;
    const conv = v.conversation;
    if (!conv) return;
    const k = conv.promptIndex + 1;
    this.beforeFollowUp = { phase: v.phase, startedAt: v.startedAt, endedAt: v.endedAt, finished: v.finished, failKind: v.failKind, prompt: v.prompt, turns: v.turns, budget: v.budget };
    v.phase = "starting";
    v.prompt = k;
    v.startedAt = Date.now();
    v.endedAt = null;
    v.finished = null;
    v.failKind = null;
    v.turns = 0; // turns count from 1 in every prompt (D-199)
    for (const b of v.blocks) {
      for (const r of b.rows) if (r.origin.child === undefined && r.issued === undefined) r.issued = issuedBy(r, v.cellCode);
    }
    v.cellCode = {};
    v.rootOpen = false;
    if (v.limits) v.budget = { turnsLeft: v.limits.max_turns, subcallsLeft: v.limits.max_subcalls };
    v.entries.push({ kind: "question", text: question, detail: `follow-up ${k}` });
    this.changed();
  }

  /** run.say answered with the prompt's index. */
  followUpResolved(promptIndex: number): void {
    this.beforeFollowUp = null;
    this.v.prompt = promptIndex;
    if (this.v.phase === "starting") this.v.phase = "running";
    this.changed();
  }

  /** run.say failed: back to how the conversation stood, with `message` as an error when given. */
  followUpFailed(message?: string): void {
    const before = this.beforeFollowUp;
    this.beforeFollowUp = null;
    if (before && this.v.phase === "starting") Object.assign(this.v, before);
    if (message !== undefined) this.v.entries.push({ kind: "error", text: message, lines: [] });
    this.changed();
  }

  /** The engine no longer has the conversation (run.say answered -32010): no question continues it. */
  conversationEnded(): void {
    if (this.v.conversation) this.v.conversation.open = false;
    this.changed();
  }

  /** start() resolved. run.started has usually fixed the id already; if not, the events kept so far are handled now. */
  startResolved(runId: string): void {
    if (this.v.runId !== null || !this.awaitingId()) return;
    this.v.runId = runId;
    const early = this.early;
    this.early = [];
    for (const e of early) this.dispatch(e.method, e.params);
  }

  /** Starting, or cancelled while starting: the first run.started or start() fixes the id. */
  private awaitingId(): boolean {
    return this.v.phase === "starting" || this.v.phase === "cancelling";
  }

  /** start() rejected (-32011, -32012, a usage error): the message, and back to idle. */
  startFailed(message: string): void {
    this.early = [];
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

  /** The run's conversation now, ahead of the next flush (a copy), or null. */
  conversation(): Conversation | null {
    const c = this.v.conversation;
    return c ? { ...c, files: [...c.files] } : null;
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
    if (this.v.runId === null && this.awaitingId()) {
      // a tagged run.started is /tune's own background run (v1 step 9): the app never tags the user's runs
      if (method !== "run.started" || (typeof params.tag === "string" && params.tag !== "")) {
        if (this.early.length < EARLY_MAX) this.early.push({ method, params });
        return;
      }
      this.v.runId = params.run_id;
      this.early = [];
    }
    this.dispatch(method, params);
  }

  /** One engine event of this run; another run's, or any before a run id is known, is dropped. */
  private dispatch(method: string, params: any): void {
    if (params.run_id !== this.v.runId || this.v.runId === null) return;
    // a follow-up's first events can come before run.say's result is handled
    if (method !== "run.finished" && method !== "run.closed") this.promptBegan();
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
      case "run.child":
        this.child(params as RunChildParams);
        break;
      case "run.compacted":
        this.compacted(params as RunCompactedParams);
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
      case "run.closed":
        this.closed(params as RunClosedParams);
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
    if (p.conversation === true) {
      v.conversation = {
        runId: p.run_id,
        mode: p.mode,
        files: Array.isArray(p.input?.files) ? [...p.input.files] : [],
        folder: this.deps.cwd,
        root: refKey(p.root),
        sub: refKey(p.sub),
        profile: p.profile,
        permissionMode: p.permission_mode,
        promptIndex: 0,
        open: true,
      };
    }
  }

  /** A follow-up that is still `starting` is running once any of its events arrives. */
  private promptBegan(): void {
    if (this.v.phase === "starting" && this.v.prompt > 0 && this.v.conversation) {
      this.beforeFollowUp = null;
      this.v.phase = "running";
    }
  }

  /** run.closed (v1 step 4): the conversation is over, and nothing continues it. */
  private closed(_p: RunClosedParams): void {
    if (this.v.conversation) this.v.conversation.open = false;
  }

  private reply(p: RunReplyParams): void {
    const v = this.v;
    v.turns = Math.max(v.turns, p.turn);
    this.lastReply = p.usage;
    this.compactedTo = null;
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
    if (isChildBatch(p.batch.id)) {
      // run.child may have made the child's block before this told where rlm() was called
      const block = this.v.blocks.find((b) => b.id === p.batch.id);
      if (block) {
        block.origin = p.origin;
        block.child = p.origin.child ?? null;
      }
    }
    if (p.seconds !== null) row.seconds ??= p.seconds;
    if (p.status === "done" && (row.status === "queued" || row.status === "streaming")) row.status = "done";
    if (p.status === "error" && row.status !== "error") {
      row.status = "error";
      row.error ??= p.error;
    }
  }

  /** run.child (D-160): the child's task, turn, cells and end, on its row. Its run.subcall events say sent/done/error too. */
  private child(p: RunChildParams): void {
    const row = this.row(p.subcall_id, `rlm${p.child_id}`, 0, 1, { turn: this.v.turns, line: null });
    const c = ensureChild(row, { id: p.child_id, turn: p.turn, max_turns: p.max_turns, depth: p.depth });
    if (p.task !== "") {
      c.task = p.task;
      row.prompt = p.task;
      row.promptChars = p.task.length;
    }
    c.tools = p.tools;
    c.maxTurns = p.max_turns;
    c.turn = Math.max(c.turn, p.turn);
    if (p.status === "turn") c.cells.push({ turn: p.turn, code: p.code, output: p.output, error: p.error });
    if (p.status === "done" || p.status === "error") {
      c.done = true;
      if (p.seconds !== null) row.seconds ??= p.seconds;
    }
    if (p.status === "done") {
      c.answer = p.answer;
      if (row.status === "queued" || row.status === "streaming") row.status = "done";
    }
    if (p.status === "error" && row.status !== "error") {
      row.status = "error";
      row.error ??= p.error;
    }
  }

  /** run.compacted (v1 step 3): a note where it happened; the root's also resets the context estimate. */
  private compacted(p: RunCompactedParams): void {
    const v = this.v;
    v.entries = v.entries.filter((e) => e.kind !== "compacting");
    v.entries.push(compactedNote(p));
    if (p.child_id === null) {
      this.lastReply = null;
      this.compactedTo = p.after_tokens;
      return;
    }
    // a child's: also in its row, before the turn it preceded, as viewFromRecord puts it
    const row = this.v.blocks.find((b) => b.id === `rlm${p.child_id}`)?.rows[0];
    if (row) row.text = withLine(row.text, childCompactedLine(p));
  }

  private permission(p: RunPermissionParams): void {
    this.v.permissions.push(p);
    if (p.asked || !p.allowed) this.v.entries.push({ kind: "permission", text: permissionLine(p), allowed: p.allowed });
  }

  private finished(p: RunFinishedParams): void {
    const v = this.v;
    const open = p.open === true;
    if (v.conversation) {
      v.conversation.promptIndex = typeof p.prompt_index === "number" ? p.prompt_index : v.prompt;
      v.conversation.open = open;
    }
    this.beforeFollowUp = null;
    v.finished = p;
    v.phase = p.infra_kind === "cancelled" ? "cancelled" : p.infra_error ? "failed" : "finished";
    v.failKind = v.phase === "failed" ? (p.infra_kind ?? "other") : null;
    v.endedAt = Date.now();
    v.rootOpen = false;
    v.entries = v.entries.filter((e) => !(e.kind === "reply" && e.live) && e.kind !== "compacting");
    // an open conversation cancels nothing between prompts (D-203): an llm_async call may still be going
    for (const b of open ? [] : v.blocks) {
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
    if (e.role === "root" && e.purpose === "compact") {
      // a compaction's summary call: "compacting…" as the live tail; its text is the summary, not a reply
      this.calls.set(e.call_id, { role: "root", compact: true });
      this.v.rootOpen = true;
      this.v.entries = this.v.entries.filter((x) => !(x.kind === "reply" && x.live) && x.kind !== "compacting");
      this.v.entries.push({ kind: "compacting" });
    } else if (e.role === "root") {
      this.promptBegan();
      this.calls.set(e.call_id, { role: "root" });
      this.v.rootOpen = true;
      this.v.entries = this.v.entries.filter((x) => !(x.kind === "reply" && x.live) && x.kind !== "compacting");
      this.v.entries.push({ kind: "reply", turn: this.v.turns + 1, text: "", reasoning: "", live: true });
    } else if (e.subcall_id !== undefined && e.child && e.purpose === "compact") {
      // a child's summary call: no turn line and no text in its row, only its usage (the row's sums the child's calls)
      const batch = e.batch ?? { id: `rlm${e.child.id}`, index: 0, size: 1 };
      const row = this.row(e.subcall_id, batch.id, batch.index, batch.size, e.origin ?? { turn: this.v.turns, line: null });
      this.calls.set(e.call_id, { role: "sub", key: row.key, compact: true });
      return;
    } else if (e.subcall_id !== undefined && e.child) {
      // a child's turn adds to its row: a turn line, then this turn's reply; the row ends with run.child, not here
      const batch = e.batch ?? { id: `rlm${e.child.id}`, index: 0, size: 1 };
      const row = this.row(e.subcall_id, batch.id, batch.index, batch.size, e.origin ?? { turn: this.v.turns, line: null });
      const c = ensureChild(row, e.child);
      c.turn = Math.max(c.turn, e.child.turn);
      c.maxTurns = e.child.max_turns;
      row.status = row.status === "queued" ? "streaming" : row.status;
      if (row.prompt === "") row.prompt = c.task;
      row.model = e.model;
      row.startedAt ??= e.started_at;
      const sep = turnLine(e.child.turn, this.unicode);
      row.text += `${row.text === "" || row.text.endsWith("\n") ? "" : "\n"}${sep}\n`;
      this.calls.set(e.call_id, { role: "sub", key: row.key, child: { turn: e.child.turn, textFrom: row.text.length, reasoningFrom: row.reasoning.length } });
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
    if (c.role === "root" && c.compact) {
      return;
    } else if (c.role === "root") {
      const live = this.v.entries.find((x) => x.kind === "reply" && x.live);
      target = live?.kind === "reply" ? live : undefined;
    } else {
      if (c.compact) return;
      const row = this.findRow(c.key);
      target = row;
      if (row && c.child) {
        this.childDelta(row, c.child, e);
        this.changed();
        return;
      }
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

  /** A child turn's stream: a reset drops only this turn's text and reasoning; its reasoning gets the turn line too. */
  private childDelta(row: SubcallRow, c: ChildCall, e: AppEvents["call.delta"]): void {
    if (e.reset) {
      row.text = row.text.slice(0, c.textFrom);
      row.reasoning = row.reasoning.slice(0, c.reasoningFrom);
    }
    if (e.text) row.text += e.text;
    if (e.reasoning) {
      if (row.reasoning.length === c.reasoningFrom) row.reasoning += `${row.reasoning === "" || row.reasoning.endsWith("\n") ? "" : "\n"}${turnLine(c.turn, this.unicode)}\n`;
      row.reasoning += e.reasoning;
    }
  }

  private onCallEnd(e: AppEvents["call.end"]): void {
    const c = this.calls.get(e.call_id);
    if (!c || e.run_id !== this.v.runId) return;
    if (c.role === "root") {
      this.v.rootOpen = false;
      this.calls.delete(e.call_id);
      if (c.compact) this.v.entries = this.v.entries.filter((x) => x.kind !== "compacting");
      else if (e.error) this.v.entries = this.v.entries.filter((x) => !(x.kind === "reply" && x.live));
    } else {
      const row = this.findRow(c.key);
      if (!row) return;
      if (c.child || c.compact) {
        // one turn (or a summary call) of the child ended: its usage adds up; the row's status and time wait for run.child
        this.calls.delete(e.call_id);
        if (e.error) row.error ??= e.error.message;
        else row.usage = sumUsage(row.usage, e.usage);
        this.changed();
        return;
      }
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
    if (v.conversation) v.conversation.open = false; // the engine took the conversation with it
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
    let block = findBlock(this.v.blocks, id, origin);
    if (!block) {
      block = { id, size, origin, child: origin.child ?? null, rows: [] };
      this.v.blocks.push(block);
    }
    return block;
  }

  private row(subcallId: number, batchId: string, index: number, size: number, origin: Origin): SubcallRow {
    const key = rowKey(subcallId, origin);
    // a child's own row is found by its block, whatever origin the first event about it gave
    const found = this.findRow(key) ?? (isChildBatch(batchId) ? this.v.blocks.find((b) => b.id === batchId)?.rows.find((r) => r.subcallId === subcallId) : undefined);
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
      } else if (this.compactedTo !== null) {
        v.ctx = { tokens: this.compactedTo, estimated: true };
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
    conversation: v.conversation ? { ...v.conversation, files: [...v.conversation.files] } : null,
    blocks: v.blocks.map((b) => ({ ...b, rows: b.rows.map((r) => ({ ...r, child: r.child ? { ...r.child, cells: [...r.child.cells] } : null })) })),
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
    child: null,
  };
}

/** Where a call of a child's turn has got to in the row: the text and reasoning before this turn stay through a reset. */
interface ChildCall {
  turn: number;
  textFrom: number;
  reasoningFrom: number;
}

/** `s<subcall_id>`, or `s<child>.<subcall_id>` for a call an rlm() child made, so ids a child counts apart never meet
 *  the root's (D-160). */
export function rowKey(subcallId: number, origin: Pick<Origin, "child">): string {
  return origin.child === undefined ? `s${subcallId}` : `s${origin.child}.${subcallId}`;
}

/** An rlm() child's own block: batch `rlm<n>`, a block of one (D-160). */
export function isChildBatch(batchId: string): boolean {
  return /^rlm\d+$/.test(batchId);
}

/** A batch's block: by id within the same child (a child's batch ids may repeat the root's); a child's own block by id. */
function findBlock(blocks: Block[], id: string, origin: Pick<Origin, "child">): Block | undefined {
  if (isChildBatch(id)) return blocks.find((b) => b.id === id);
  return blocks.find((b) => b.id === id && b.child === (origin.child ?? null));
}

function ensureChild(row: SubcallRow, t: ChildTurn): ChildInfo {
  row.child ??= { id: t.id, depth: t.depth, task: "", tools: "", turn: 0, maxTurns: t.max_turns, cells: [], answer: null, done: false };
  return row.child;
}

/** The line before each of a child's turns in its row's text and reasoning. */
export function turnLine(turn: number, unicode: boolean): string {
  const rule = unicode ? "──" : "--";
  return `${rule} turn ${turn} ${rule}`;
}

function sumUsage(a: Usage | null, b: Usage): Usage {
  if (!a) return { ...b };
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_tokens: a.cache_read_tokens + b.cache_read_tokens,
    cache_write_tokens: a.cache_write_tokens + b.cache_write_tokens,
    reasoning_tokens: a.reasoning_tokens + b.reasoning_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
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

/** `text` with `line` and a newline after it, on a line of its own. */
function withLine(text: string, line: string): string {
  return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`;
}

/** A compaction inside an rlm() child, as a line of its row's text. */
function childCompactedLine(p: { dropped_messages: number; before_tokens: number; after_tokens: number }): string {
  return `(${compactedText(p)})`;
}

function compactedText(p: { dropped_messages: number; before_tokens: number; after_tokens: number }): string {
  return `Compacted ${p.dropped_messages} messages to save context: ~${thousands(p.before_tokens)}k to ~${thousands(p.after_tokens)}k tokens.`;
}

/** The transcript's note for a compaction, live or from a record's `compactions`; a child's names the child. */
export function compactedNote(p: { dropped_messages: number; before_tokens: number; after_tokens: number; child_id?: number | null }): Entry {
  const text = compactedText(p);
  return { kind: "note", text: typeof p.child_id === "number" ? `rlm${p.child_id}: ${text}` : text, tone: "info" };
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
/** `runChoice` is the next question's mode choice (D-156); it shows only when it is not `auto`. `tune` is /tune's state
 *  while tuning is on (v1 step 9): `tune on $0.12/$1.00`, then ` · tuning` and ` · 1 waiting`. */
export function statusModel(view: RunView, deps: AppDeps, nextMode?: string, runChoice?: string, tune?: TuneStatus | null): StatusSegment[] {
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
  if (tune) segs.push({ id: "tune", text: tuneSegment(tune) });
  if (runChoice && runChoice !== "auto") segs.push({ id: "run", text: `${runChoice} mode`, tone: "warn" });
  return segs;
}

/** /tune's figures (v1 step 9): the spend since `/tune on` against the cap, and the queue. */
export interface TuneStatus {
  spent_usd: number;
  cap_usd: number;
  running: { id: string; mode: "read" | "repo"; stage: string | null } | null;
  waiting: { id: string; mode: "read" | "repo" } | null;
}

/** `tune on $0.12/$1.00`, with ` · tuning` while a task is tuned and ` · 1 waiting` while one waits. */
export function tuneSegment(t: TuneStatus): string {
  return `tune on $${t.spent_usd.toFixed(2)}/$${t.cap_usd.toFixed(2)}${t.running ? " · tuning" : ""}${t.waiting ? " · 1 waiting" : ""}`;
}

function stateText(view: RunView, deps: AppDeps): { text: string; tone?: StatusSegment["tone"] } {
  if (view.conversation?.open && !view.readOnly && view.phase === "finished") return { text: "ready for a follow-up", tone: "ok" };
  switch (view.phase) {
    case "idle":
      return { text: "idle" };
    case "starting":
      return { text: "starting" };
    case "running":
      if (deps.approvals.size > 0) return { text: "waiting for approval", tone: "warn" };
      return { text: `running ${formatClock(((view.now ?? Date.now()) - (view.startedAt ?? view.now)) / 1000)}${view.prompt > 0 ? ` · follow-up ${view.prompt}` : ""}` };
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
export function viewFromRecord(record: Record<string, any>, opts: { unicode?: boolean } = {}): RunView {
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
  // a conversation's record holds one prompt (v1 step 4): a follow-up's shows its own question and turns only
  const promptIndex = typeof record.prompt_index === "number" ? record.prompt_index : 0;
  v.prompt = promptIndex;
  const detail =
    promptIndex > 0
      ? `follow-up ${promptIndex}`
      : record.mode === "repo"
        ? `repo: ${str(record.workspace) ?? "?"}`
        : `read: ${files.length} file${files.length === 1 ? "" : "s"}`;
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
  // format 2 (v1 step 3): each compaction before the turn it preceded; the root's in the transcript, a child's in its row
  const compactions: any[] = (Array.isArray(record.compactions) ? record.compactions : []).filter(
    (c: any) => isObj(c) && typeof c.turn === "number" && typeof c.dropped_messages === "number",
  );
  const rootCompactions = compactions.filter((c) => typeof c.child_id !== "number");
  const shown = new Set<unknown>();
  for (const t of turns) {
    const turn = typeof t.turn === "number" ? t.turn : v.turns + 1;
    v.turns = Math.max(v.turns, turn);
    for (const c of rootCompactions) {
      if (c.turn === turn && !shown.has(c)) {
        shown.add(c);
        v.entries.push(compactedNote({ ...c, child_id: null }));
      }
    }
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

  // a compaction whose turn never came (the run ended first) still shows, after the last turn
  for (const c of rootCompactions) if (!shown.has(c)) v.entries.push(compactedNote({ ...c, child_id: null }));

  const subcalls: any[] = Array.isArray(record.subcalls) ? record.subcalls : [];
  for (const s of subcalls) {
    const batch = isObj(s.batch) ? s.batch : { id: `call${s.subcall_id}`, index: 0, size: 1 };
    const origin: Origin = isObj(s.origin) ? s.origin : { turn: 0, line: null };
    let block = findBlock(v.blocks, batch.id, origin);
    if (!block) {
      block = { id: batch.id, size: batch.size, origin, child: origin.child ?? null, rows: [] };
      v.blocks.push(block);
    }
    const row = newRow(rowKey(s.subcall_id, origin), s.subcall_id ?? null, batch.id, batch.index ?? 0, origin);
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
  // rlm() children (D-160): each child's row gets its turns, cells and answer
  const children: any[] = Array.isArray(record.children) ? record.children : [];
  for (const ch of children) {
    if (typeof ch?.child_id !== "number") continue;
    const id: number = ch.child_id;
    const batchId = `rlm${id}`;
    let block = v.blocks.find((b) => b.id === batchId);
    if (!block) {
      const origin: Origin = typeof ch.parent_child === "number" ? { turn: 0, line: null, child: ch.parent_child } : { turn: 0, line: null };
      block = { id: batchId, size: 1, origin, child: origin.child ?? null, rows: [] };
      v.blocks.push(block);
    }
    let row = block.rows[0];
    if (!row) {
      row = newRow(rowKey(typeof ch.subcall_id === "number" ? ch.subcall_id : 0, block.origin), typeof ch.subcall_id === "number" ? ch.subcall_id : null, batchId, 0, block.origin);
      row.status = "done";
      block.rows.push(row);
    }
    const turns: any[] = Array.isArray(ch.turns) ? ch.turns : [];
    const cells: ChildCell[] = [];
    let text = "";
    let reasoning = "";
    const own = compactions.filter((c) => c.child_id === id);
    for (const t of turns) {
      const turn = typeof t.turn === "number" ? t.turn : cells.length + 1;
      const sep = turnLine(turn, opts.unicode ?? true);
      for (const c of own) if (c.turn === turn) text = withLine(text, childCompactedLine(c)).slice(0, -1);
      text += `${text === "" ? "" : "\n"}${sep}\n${str(t.reply) ?? ""}`;
      if (str(t.reasoning)) reasoning += `${reasoning === "" ? "" : "\n"}${sep}\n${t.reasoning}`;
      if (t.code !== null || t.error !== null) cells.push({ turn, code: str(t.code), output: str(t.stdout), error: str(t.error) });
    }
    const task = str(ch.task) ?? row.prompt;
    row.child = {
      id,
      depth: typeof ch.depth === "number" ? ch.depth : 1,
      task,
      tools: str(ch.tools) ?? "",
      turn: turns.length,
      maxTurns: typeof ch.max_turns === "number" ? ch.max_turns : turns.length,
      cells,
      answer: ch.answer ?? null,
      done: true,
    };
    row.prompt = task;
    row.promptChars = task.length;
    row.text = text;
    row.reasoning = reasoning;
    row.model = v.root; // a child runs on the root's model
    if (isObj(ch.usage)) row.usage = ch.usage as Usage;
    if (typeof ch.seconds === "number") row.seconds = ch.seconds;
    if (str(ch.error)) {
      row.status = "error";
      row.error = str(ch.error);
    }
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
