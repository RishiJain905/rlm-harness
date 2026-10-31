// KV cache: none; a test fake. It builds model.complete messages the way the engine does, but its bytes are never sent to a real provider.
// The fake engine for step 7's interface tests: it speaks the real link (two in-memory Links, the engine
// side with idPrefix "e") and drives the real Gateway on the scripted fake provider (§7.5). It answers
// engine.info, run.start, run.cancel and run.vars, and plays a scenario with the events and ordering of
// §5.4. The replies come from the fake-provider script derived from the scenario, never from here: the
// engine side only runs the code it gets back, through a small reader of the few Python shapes the
// scenarios use (llm, llm_batch, shell, open(..., "w"), fetch, print, submit).
//
// `scriptedBus` covers what the fake provider can't produce (reasoning, a chosen error, a flood of deltas,
// non-zero cost), and `runRecord` is a complete run-log record (§7.8) for /runs and viewFromRecord.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Bus } from "../../src/bus.ts";
import { fetchInfo } from "../../src/engine.ts";
import { Catalog } from "../../src/gateway/catalog.ts";
import { Gateway, type AppEvents } from "../../src/gateway/gateway.ts";
import { KeyStore, type SecretsLike } from "../../src/gateway/keys.ts";
import { ApprovalQueue } from "../../src/interface/approvals.ts";
import type { AppDeps, SessionLike } from "../../src/interface/store.ts";
import { Link, RpcError } from "../../src/link.ts";
import {
  ErrorCode,
  type ApprovalKind,
  type ApprovalParams,
  type ApprovalResult,
  type EngineInfo,
  type Message,
  type ModelCompleteParams,
  type ModelCompleteResult,
  type ModelErrorData,
  type RunStartParams,
  type RunStartResult,
  type RunSubcallParams,
  type RunVarsResult,
  type ToolDef,
  type Usage,
  type VarInfo,
} from "../../src/protocol.ts";
import { buildRunParams, type StartRun } from "../../src/session.ts";
import { defaultSettings, saveSettings, setSetting, type Settings } from "../../src/settings.ts";
import { PROTOCOL_VERSION } from "../../src/version.ts";

export type Scenario = "simpleRead" | "fanOut20" | "approvalShell" | "twoApprovals" | "slow" | "rootError" | "hold";

export interface FakeEngine {
  /** Every request the engine received, in order (engine.info, run.start, run.cancel, run.vars). */
  calls: { method: string; params: any }[];
  /** Send a notification from the engine side; `run_id` defaults to the current run. A `run.finished` for an active run also stops its play (after a `model.cancel`, as D-84 orders). */
  emit(method: string, params: object): void;
  /** Close the link both ways, then emit bus "engine.exit" {code, stderr}; later requests reject with -32800. */
  crash(code: number, stderr: string[]): void;
  /** The current or last run id. */
  readonly runId: string | null;
}

export interface FakeApp {
  session: SessionLike;
  deps: AppDeps;
  engine: FakeEngine;
  bus: Bus<AppEvents>;
  /** Every StartRun passed to session.start, as given. */
  startCalls: StartRun[];
  /** URLs the gateway's injected fetch was asked for (it then rejects: offline). */
  fetchCalls: string[];
  sessionClosed(): boolean;
  /** The RLMH_FAKE_SCRIPT file. */
  scriptPath: string;
  dispose(): Promise<void>;
}

export interface FakeAppOptions {
  scenario?: Scenario;
  /** Laid shallowly over the fake-provider script derived from the scenario. */
  script?: object;
  /** Default: a fresh `<tmp>/work` folder holding a.txt and b.txt; not a git repo. */
  cwd?: string;
  /** Applied with setSetting over the defaults and root.model = "fake/scripted", then saved. */
  settings?: Record<string, string | number | boolean>;
  /** Extra variables for deps.env, the KeyStore and the Gateway. */
  env?: Record<string, string>;
  size?: { columns: number; rows: number };
}

// -- the scenarios' fake-provider scripts (§7.5) --

const SLOW_TEXT =
  "Let me think about how to read this input carefully before writing any code. " +
  "First I will look at its size, then split it into parts, then ask a sub-call about each part, " +
  "and finally put the answers together into one short reply that answers the question exactly.";

export const SCENARIO_SCRIPTS: Record<Scenario, Record<string, unknown>> = {
  simpleRead: {
    root: [
      { text: "Reading the input.", tool_call: { code: "s = llm('Summarize the input')\nprint(s)" } },
      { text: "", tool_call: { code: "submit('42')" } },
    ],
    sub: [{ text: "A short summary." }],
    chunk_chars: 8,
    delay_ms: 5,
  },
  fanOut20: {
    root: [
      {
        text: "Fan out over the parts.",
        tool_call: {
          code: "parts = context.split('\\n')\nprompts = [f'Summarize part {i}' for i in range(20)]\nouts = llm_batch(prompts)\nprint(len(outs))",
        },
      },
      { text: "", tool_call: { code: "submit('done')" } },
    ],
    sub: [{ text: "Part summary: nothing unusual here." }],
    chunk_chars: 6,
    delay_ms: 25,
  },
  approvalShell: {
    root: [
      { text: "Listing the folder.", tool_call: { code: "print(shell('ls -la'))" } },
      { text: "", tool_call: { code: "submit('ok')" } },
    ],
    sub: [{ text: "unused" }],
    chunk_chars: 8,
    delay_ms: 5,
  },
  twoApprovals: {
    root: [
      {
        text: "Write a note and fetch a page.",
        tool_call: { code: "open('/outside/notes.txt', 'w').write('notes')\nprint(fetch('https://example.com'))" },
      },
      { text: "", tool_call: { code: "submit('done')" } },
    ],
    sub: [{ text: "unused" }],
    chunk_chars: 8,
    delay_ms: 5,
  },
  slow: {
    root: [{ text: SLOW_TEXT, tool_call: { code: "submit('slow done')" } }],
    sub: [{ text: "unused" }],
    chunk_chars: 4,
    delay_ms: 50,
  },
  rootError: {
    root: [{ text: "never sent", tool_call: { code: "submit('x')" } }],
    sub: [{ text: "unused" }],
    errors: [{ role: "root", at: 1, kind: "auth", status: 401 }],
  },
  hold: {
    root: [{ text: "", tool_call: { code: "submit('held')" } }],
    sub: [{ text: "unused" }],
  },
};

// -- fixed engine facts --

const FAKE_SYSTEM_PROMPT =
  "You are tasked with answering a query with associated context. You can access, transform, and analyze this " +
  "context interactively in a REPL environment that can recursively query sub-LLMs, which you are strongly " +
  "encouraged to use as much as possible. The REPL gives you `context`, `llm(prompt)`, `llm_batch(prompts)` and " +
  "`submit(answer)`. Write Python, look at the output, and call submit() when you have the final answer. " +
  "(This is the fake engine's system prompt.)";

const PYTHON_TOOL: ToolDef = {
  name: "python",
  description:
    "Run one cell of Python in the persistent REPL. Variables persist between calls. The result is what the cell printed, followed by your remaining turns and sub-calls.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "The Python code to run." } },
    required: ["code"],
    additionalProperties: false,
  },
};

export const FAKE_LIMITS = {
  max_turns: 20,
  max_subcalls: 80,
  root_max_tokens: 4096,
  output_max_chars: 8192,
  cell_timeout_s: 120,
  subcall_max_chars: 24000,
  subcall_max_tokens: 1024,
};

const NO_CODE_ERROR = "No code block found. Put your code in a ```repl block, or call submit() to answer.";
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const CONTRACT_HASH = sha("fake contract v4");
const DEFAULT_PROMPT_HASH = sha("fake contract v4 + guidance.md");
const PROFILES: EngineInfo["profiles"] = [
  { name: "default", source: "builtin", prompt_hash: DEFAULT_PROMPT_HASH, profile_hash: sha("profile default") },
  { name: "training-v4", source: "builtin", prompt_hash: CONTRACT_HASH, profile_hash: sha("profile training-v4") },
];

/** The fixed run.vars answer while a run is active. */
export const FAKE_VARS: VarInfo[] = [
  { name: "outs", type: "list", len: 20, chars: 412 },
  { name: "n", type: "int", len: null, chars: 2 },
];

function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
}

function addUsage(total: Usage, u: Usage | undefined): void {
  if (!u) return;
  total.input_tokens += u.input_tokens;
  total.output_tokens += u.output_tokens;
  total.cache_read_tokens += u.cache_read_tokens;
  total.cache_write_tokens += u.cache_write_tokens;
  total.reasoning_tokens += u.reasoning_tokens;
  total.cost_usd += u.cost_usd;
}

// -- in-memory pipes --

interface Pipe {
  readable: ReadableStream<Uint8Array>;
  writer: { write(chunk: string): void };
  close(): void;
}

/** A byte stream fed by the other side's `write`: what one side writes, the other reads, in order. */
function pipe(): Pipe {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  return {
    readable,
    writer: {
      write(chunk: string) {
        if (closed) throw new Error("pipe closed");
        controller.enqueue(encoder.encode(chunk));
      },
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {
        // already cancelled by the reader
      }
    },
  };
}

// -- the engine side --

class Stopped extends Error {}

interface RunState {
  id: string;
  params: RunStartParams;
  logPath: string;
  workspace: string;
  context: string;
  ac: AbortController;
  finished: boolean;
  startedAt: number;
  messages: Message[];
  turns: number;
  subcallsUsed: number;
  batches: number;
  usage: { root: Usage; sub: Usage };
  vars: Map<string, string | string[]>;
  remembered: Set<string>;
  infra: { kind: string; error: string } | null;
}

interface CellResult {
  output: string;
  error: string | null;
  submitted: boolean;
  answer: string | number | null;
}

type Action =
  | { type: "approval"; line: number; kind: ApprovalKind; detail: string; inside: boolean; print: boolean; shown: string; deniedText: string }
  | { type: "llm"; line: number; prompts: string[]; assign: string | null; batch: boolean }
  | { type: "print"; line: number; text?: string; name?: string; len?: string }
  | { type: "submit"; line: number; answer: string | number | null };

const QUOTED = String.raw`(['"])((?:\\.|(?!\1).)*)\1`;

function unquote(text: string): string {
  return text.replace(/\\n/g, "\n").replace(/\\(['"\\])/g, "$1");
}

/** Python's repr of a list of strings, as print() shows it. */
function reprList(items: string[]): string {
  return `[${items.map((s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n")}'`).join(", ")}]`;
}

class EngineSide {
  readonly calls: { method: string; params: any }[] = [];
  runId: string | null = null;
  private readonly runs = new Map<string, RunState>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private nextRun = 0;

  constructor(
    private readonly link: Link,
    private readonly home: string,
    private readonly scenario: Scenario,
  ) {
    link.handle("engine.info", async (p) => {
      this.calls.push({ method: "engine.info", params: p });
      const info: EngineInfo = {
        version: "0.0.0-fake",
        protocol: PROTOCOL_VERSION,
        python: "3.12.10",
        contract: "v4",
        contract_hash: CONTRACT_HASH,
        training_hash: CONTRACT_HASH,
        profiles: PROFILES.map((x) => ({ ...x })),
      };
      return info;
    });
    link.handle("run.start", async (p: RunStartParams) => {
      this.calls.push({ method: "run.start", params: p });
      return this.start(p);
    });
    link.handle("run.cancel", async (p: { run_id: string }) => {
      this.calls.push({ method: "run.cancel", params: p });
      const run = this.active(p.run_id);
      this.finish(run, { infra: { kind: "cancelled", error: "cancelled: the run was cancelled" } });
      return {};
    });
    link.handle("run.vars", async (p: { run_id: string }) => {
      this.calls.push({ method: "run.vars", params: p });
      this.active(p.run_id);
      const result: RunVarsResult = { vars: FAKE_VARS.map((v) => ({ ...v })) };
      return result;
    });
  }

  emit(method: string, params: object): void {
    const full: Record<string, unknown> = { run_id: this.runId, ...params };
    const run = typeof full.run_id === "string" ? this.runs.get(full.run_id) : undefined;
    if (method === "run.finished" && run && !run.finished) {
      run.finished = true;
      run.ac.abort();
      this.link.notify("model.cancel", { run_id: run.id });
    }
    this.link.notify(method, full);
  }

  /** Stop every play without sending anything more (the link is gone). */
  stopAll(): void {
    for (const run of this.runs.values()) {
      run.finished = true;
      run.ac.abort();
    }
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }

  runIds(): string[] {
    return [...this.runs.keys()];
  }

  private active(runId: unknown): RunState {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (!run || run.finished) throw new RpcError(ErrorCode.UNKNOWN_RUN, `no run ${JSON.stringify(runId)} is going`);
    return run;
  }

  private start(p: RunStartParams): RunStartResult {
    if (!PROFILES.some((x) => x.name === p.profile)) {
      throw new RpcError(ErrorCode.UNKNOWN_PROFILE, `unknown profile ${JSON.stringify(p.profile)}: known are default, training-v4`);
    }
    const repo = p.mode === "repo";
    const inputs = p.inputs ?? [];
    if (!repo && inputs.length === 0) throw new RpcError(ErrorCode.BAD_INPUT, "run.start is missing inputs");
    if (repo && !p.task) throw new RpcError(ErrorCode.BAD_INPUT, "run.start is missing task");
    for (const f of inputs) {
      if (!existsSync(f) || !statSync(f).isFile()) throw new RpcError(ErrorCode.BAD_INPUT, `no such input file: ${f}`);
    }
    if (repo && (!p.repo_path || !existsSync(p.repo_path) || !statSync(p.repo_path).isDirectory())) {
      throw new RpcError(ErrorCode.BAD_INPUT, `the repo path is not a folder: ${p.repo_path}`);
    }
    this.nextRun += 1;
    const id = `r_${String(this.nextRun).padStart(12, "0")}`;
    const logPath = p.log_dir ? join(p.log_dir, "runs.jsonl") : join(this.home, "runs", p.batch ?? "interactive", "runs.jsonl");
    const context = repo ? (p.context ?? "") : inputs.map((f) => readFileSync(f, "utf8")).join("\n");
    const run: RunState = {
      id,
      params: p,
      logPath,
      workspace: repo ? p.repo_path! : join(this.home, "scratch", id),
      context,
      ac: new AbortController(),
      finished: false,
      startedAt: performance.now(),
      messages: [],
      turns: 0,
      subcallsUsed: 0,
      batches: 0,
      usage: { root: zeroUsage(), sub: zeroUsage() },
      vars: new Map(),
      remembered: new Set(),
      infra: null,
    };
    this.runs.set(id, run);
    this.runId = id;
    // the result is written first; run.started follows it on the wire (§5.4, §7.8)
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.play(run);
    }, 0);
    this.timers.add(timer);
    return { run_id: id, log_path: logPath };
  }

  // -- events --

  private event(run: RunState, method: string, params: object): void {
    if (run.finished) return;
    this.link.notify(method, { run_id: run.id, ...params });
  }

  private check(run: RunState): void {
    if (run.finished) throw new Stopped();
  }

  private finish(run: RunState, outcome: { answer?: string | number | null; submitted?: boolean; infra?: { kind: string; error: string } | null }): void {
    if (run.finished) return;
    run.finished = true;
    run.ac.abort();
    const { root, sub } = run.usage;
    this.link.notify("model.cancel", { run_id: run.id }); // D-84: at the end of every run, before run.finished
    this.link.notify("run.finished", {
      run_id: run.id,
      tag: run.params.tag ?? null,
      answer: outcome.answer ?? null,
      submitted: outcome.submitted ?? false,
      answer_valid: true,
      turns: run.turns,
      subcalls: run.subcallsUsed,
      usage: { root: { ...root }, sub: { ...sub } },
      cost_usd: Math.round((root.cost_usd + sub.cost_usd) * 1e6) / 1e6,
      infra_error: outcome.infra?.error ?? null,
      infra_kind: outcome.infra?.kind ?? null,
      wall_s: Math.round(performance.now() - run.startedAt) / 1000,
      log_path: run.logPath,
    });
  }

  // -- the play --

  private async play(run: RunState): Promise<void> {
    const p = run.params;
    const repo = p.mode === "repo";
    this.event(run, "run.started", {
      tag: p.tag ?? null,
      mode: p.mode,
      profile: p.profile,
      prompt_hash: PROFILES.find((x) => x.name === p.profile)?.prompt_hash ?? CONTRACT_HASH,
      profile_hash: PROFILES.find((x) => x.name === p.profile)?.profile_hash ?? sha(p.profile),
      contract_hash: CONTRACT_HASH,
      call_format: p.call_format,
      root: p.root,
      sub: p.sub,
      permission_mode: p.permission_mode,
      workspace: run.workspace,
      input: {
        chars: run.context.length,
        lines: run.context.split(/\r\n|\r|\n/).length - (run.context === "" || /(\r\n|\r|\n)$/.test(run.context) ? 1 : 0),
        sha256: sha(run.context),
        files: repo ? [] : (p.inputs ?? []).map((f) => f.replace(/\\/g, "/")),
      },
      limits: { ...FAKE_LIMITS },
      log_path: run.logPath,
    });
    if (this.scenario === "hold") return; // nothing more until run.cancel

    const first = repo
      ? `Task: ${p.task}\n\nThe repository is your working folder. Make the change, run the tests, then call submit().`
      : `Question: ${p.question ?? ""}\n\nThe input is in \`context\` (${run.context.length} characters). Write Python to read it, and call submit() with your answer.`;
    run.messages = [
      { role: "system", content: FAKE_SYSTEM_PROMPT },
      { role: "user", content: first },
    ];
    const native = p.call_format === "native";
    try {
      for (let turn = 1; turn <= FAKE_LIMITS.max_turns; turn++) {
        const asked = performance.now();
        const reply = await this.link.request<ModelCompleteResult>(
          "model.complete",
          {
            run_id: run.id,
            role: "root",
            model: p.root,
            messages: run.messages.map((m) => ({ ...m })),
            tools: native ? [structuredClone(PYTHON_TOOL)] : [],
            max_tokens: FAKE_LIMITS.root_max_tokens,
            temperature: 0,
            thinking: p.root.thinking ?? "off",
            turn,
          } satisfies ModelCompleteParams,
          { signal: run.ac.signal },
        );
        this.check(run);
        run.turns = turn;
        addUsage(run.usage.root, reply.usage);
        this.event(run, "run.reply", {
          turn,
          text: reply.text ?? "",
          tool_call: reply.tool_call ?? null,
          reasoning: reply.reasoning ?? null,
          finish_reason: reply.finish_reason,
          usage: reply.usage,
          seconds: Math.round(performance.now() - asked) / 1000,
        });
        const assistant: Message = native && reply.tool_call
          ? { role: "assistant", content: reply.text ?? "", tool_call: reply.tool_call }
          : { role: "assistant", content: reply.text ?? "" };
        run.messages.push(assistant);

        const code = codeOf(reply);
        const computed = performance.now();
        const result: CellResult = code === null ? { output: "", error: NO_CODE_ERROR, submitted: false, answer: null } : await this.cell(run, turn, code);
        this.check(run);
        const cell = (observation: string | null) => ({
          turn,
          code,
          output: result.output,
          error: result.error,
          observation,
          seconds: Math.round(performance.now() - computed) / 1000,
          restarted: false,
          crash: null,
          repo_changed: repo ? false : null,
        });
        if (run.infra) {
          this.event(run, "run.cell", cell(null));
          this.finish(run, { infra: run.infra });
          return;
        }
        if (result.submitted) {
          this.event(run, "run.cell", cell(null));
          this.finish(run, { answer: result.answer, submitted: true });
          return;
        }
        const turnsLeft = FAKE_LIMITS.max_turns - turn;
        let observation: string | null = null;
        if (turnsLeft > 0) {
          observation = observationText(result, turnsLeft, this.subcallsLeft(run));
          run.messages.push(
            "tool_call" in assistant && assistant.tool_call
              ? { role: "tool", tool_call_id: assistant.tool_call.id, content: observation }
              : { role: "user", content: observation },
          );
        }
        this.event(run, "run.cell", cell(observation));
        this.event(run, "run.budget", { turns_left: turnsLeft, subcalls_left: this.subcallsLeft(run) });
      }
      this.finish(run, {});
    } catch (err) {
      if (run.finished || err instanceof Stopped) return;
      if (err instanceof RpcError && err.code === ErrorCode.CANCELLED) {
        run.finished = true; // the link closed under the run: nothing can be sent
        return;
      }
      if (err instanceof RpcError && err.code === ErrorCode.MODEL_ERROR) {
        this.finish(run, { infra: infraOf(err) });
        return;
      }
      const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      this.finish(run, { infra: { kind: "host_bug", error: `host error: ${text}` } });
    }
  }

  private subcallsLeft(run: RunState): number {
    return Math.max(0, FAKE_LIMITS.max_subcalls - run.subcallsUsed);
  }

  /** Runs one cell of the few shapes the scenarios use. Approvals next to each other go out together. */
  private async cell(run: RunState, turn: number, code: string): Promise<CellResult> {
    const out: CellResult = { output: "", error: null, submitted: false, answer: null };
    const actions = parseCell(code, run);
    let group: Extract<Action, { type: "approval" }>[] = [];
    const flush = async (): Promise<boolean> => {
      if (group.length === 0) return true;
      const pending = group;
      group = [];
      const answers = await Promise.all(pending.map((a) => this.approve(run, turn, a)));
      this.check(run);
      for (let i = 0; i < pending.length; i++) {
        const a = pending[i]!;
        if (!answers[i]) {
          out.error = a.deniedText;
          return false;
        }
        if (a.print) out.output += `${a.shown}\n`;
      }
      return true;
    };
    for (const action of actions) {
      if (action.type === "approval") {
        group.push(action);
        continue;
      }
      if (!(await flush())) return out;
      if (action.type === "print") {
        out.output += `${printed(run, action)}\n`;
      } else if (action.type === "submit") {
        out.submitted = true;
        out.answer = action.answer;
        return out;
      } else {
        const texts = await this.batch(run, turn, action);
        if (texts === null) return { ...out, error: out.error ?? "RuntimeError: the sub-call failed" };
        if (typeof texts === "string") return { ...out, error: texts };
        if (action.assign) run.vars.set(action.assign, action.batch ? texts : texts[0]!);
      }
    }
    await flush();
    return out;
  }

  /** One approval: asked (concurrently with its neighbours), remembered, automatic, or denied without asking. */
  private async approve(run: RunState, turn: number, a: Extract<Action, { type: "approval" }>): Promise<boolean> {
    const mode = run.params.permission_mode;
    const key = a.kind === "shell" ? "shell" : a.kind === "write" ? `write:${a.inside}` : `network:${a.detail}`;
    const decide = (allowed: boolean, asked: boolean, remembered: boolean) => {
      this.event(run, "run.permission", { turn, kind: a.kind, detail: a.detail, allowed, asked, remembered });
      return allowed;
    };
    if (mode === "bypass" || (mode === "accept-edits" && a.kind === "write" && a.inside)) return decide(true, false, false);
    if (run.remembered.has(key)) return decide(true, false, true);
    if (run.params.interactive !== true) return decide(false, false, false); // D-15
    const params: ApprovalParams = { run_id: run.id, kind: a.kind, detail: a.detail, turn, inside_workspace: a.inside };
    const answer = await this.link.request<ApprovalResult>("approval.request", params, { signal: run.ac.signal });
    this.check(run);
    if (answer.allow && answer.remember_for_run) run.remembered.add(key);
    return decide(answer.allow === true, true, false);
  }

  /** One llm or llm_batch: sent events, all calls at once, done or error events as each ends, then run.budget. Returns the texts, or the cell's error text. */
  private async batch(run: RunState, turn: number, action: Extract<Action, { type: "llm" }>): Promise<string[] | string | null> {
    const p = run.params;
    const n = action.prompts.length;
    const origin = { turn, line: action.line };
    run.batches += 1;
    const batchId = `b${run.batches}`;
    if (run.subcallsUsed + n > FAKE_LIMITS.max_subcalls) {
      const message = `sub-call budget exhausted: this run may make ${FAKE_LIMITS.max_subcalls} sub-calls`;
      this.event(run, "run.subcall", {
        subcall_id: null,
        origin,
        batch: { id: batchId, index: 0, size: n },
        prompt_chars: Math.max(0, ...action.prompts.map((x) => x.length)),
        status: "rejected",
        error: message,
        seconds: 0,
      });
      return `RuntimeError: ${message}`;
    }
    const firstId = run.subcallsUsed + 1;
    run.subcallsUsed += n;
    const calls = action.prompts.map((prompt, index) => {
      const subcallId = firstId + index;
      const batch = { id: batchId, index, size: n };
      const base = { subcall_id: subcallId, origin, batch, prompt_chars: prompt.length };
      this.event(run, "run.subcall", { ...base, status: "sent", error: null, seconds: null });
      const started = performance.now();
      const params: ModelCompleteParams = {
        run_id: run.id,
        role: "sub",
        model: p.sub,
        messages: [{ role: "user", content: prompt }],
        tools: [],
        max_tokens: FAKE_LIMITS.subcall_max_tokens,
        temperature: 0,
        thinking: p.sub.thinking ?? "off",
        turn,
        subcall_id: subcallId,
        origin,
        batch,
      };
      return this.link.request<ModelCompleteResult>("model.complete", params, { signal: run.ac.signal }).then(
        (res) => {
          addUsage(run.usage.sub, res.usage);
          this.event(run, "run.subcall", { ...base, status: "done", error: null, seconds: Math.round(performance.now() - started) / 1000 });
          return res.text;
        },
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.event(run, "run.subcall", { ...base, status: "error", error: message, seconds: Math.round(performance.now() - started) / 1000 });
          throw err;
        },
      );
    });
    const settled = await Promise.allSettled(calls);
    this.check(run);
    this.event(run, "run.budget", { turns_left: Math.max(0, FAKE_LIMITS.max_turns - turn), subcalls_left: this.subcallsLeft(run) });
    const failures = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected").map((s) => s.reason as unknown);
    for (const err of failures) {
      if (err instanceof RpcError && err.code === ErrorCode.CANCELLED) throw err;
      const data = err instanceof RpcError ? (err.data as Partial<ModelErrorData> | undefined) : undefined;
      if (data?.kind !== "bad_request") {
        run.infra = err instanceof RpcError && err.code === ErrorCode.MODEL_ERROR ? infraOf(err) : { kind: "other", error: `other: ${String(err)}` };
        return "RuntimeError: the run stopped: a sub-call failed";
      }
    }
    if (failures.length > 0) {
      const err = failures[0] as RpcError;
      return `RuntimeError: sub-call failed: ${err.message}`;
    }
    return settled.map((s) => (s as PromiseFulfilledResult<string>).value);
  }
}

function infraOf(err: RpcError): { kind: string; error: string } {
  const data = err.data as Partial<ModelErrorData> | undefined;
  const kind = typeof data?.kind === "string" ? data.kind : "other";
  const message = err.message;
  return { kind, error: message.startsWith(`${kind}: `) ? message : `${kind}: ${message}` };
}

/** Native: the python tool call's code; otherwise the first ```python or ```repl block of the text. */
function codeOf(reply: ModelCompleteResult): string | null {
  const code = reply.tool_call?.arguments?.code;
  if (reply.tool_call && typeof code === "string") return code;
  const m = /```(?:python|repl)?\n([\s\S]*?)```/.exec(reply.text ?? "");
  return m ? m[1]! : null;
}

function observationText(r: CellResult, turnsLeft: number, subcallsLeft: number): string {
  const parts = [r.output.trim() ? `REPL output:\n${r.output}` : "REPL output: (nothing printed)"];
  if (r.error) parts.push(`Error:\n${r.error}`);
  parts.push(`(${turnsLeft} turns left, ${subcallsLeft} sub-calls left)`);
  if (turnsLeft === 1) parts.push("Your next turn is the last one: it must call submit() with your best answer.");
  return parts.join("\n");
}

/** The actions of one cell, line by line. Lines the reader does not know do nothing. */
function parseCell(code: string, run: RunState): Action[] {
  const actions: Action[] = [];
  const lines = code.split("\n");
  const valueOf = (name: string): string | string[] | undefined => run.vars.get(name);
  lines.forEach((raw, i) => {
    const line = i + 1;
    const text = raw.trim();
    const assign = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(text);
    const rhs = assign ? assign[2]! : text;

    const llmOne = new RegExp(String.raw`\bllm\(\s*${QUOTED}\s*\)`).exec(rhs);
    if (llmOne) {
      actions.push({ type: "llm", line, prompts: [unquote(llmOne[2]!)], assign: assign ? assign[1]! : null, batch: false });
      return;
    }
    if (/\bllm_batch\(/.test(rhs)) {
      actions.push({ type: "llm", line, prompts: batchPrompts(code, rhs), assign: assign ? assign[1]! : null, batch: true });
      return;
    }
    const shell = new RegExp(String.raw`\bshell\(\s*${QUOTED}\s*\)`).exec(text);
    if (shell) {
      const detail = unquote(shell[2]!);
      actions.push({ type: "approval", line, kind: "shell", detail, inside: true, print: /^print\(/.test(text), shown: "ok", deniedText: `PermissionError: shell command denied: ${detail}` });
      return;
    }
    const write = new RegExp(String.raw`\bopen\(\s*${QUOTED}\s*,\s*(['"])[wax]`).exec(text);
    if (write) {
      const detail = unquote(write[2]!);
      const inside = detail.startsWith(`${run.workspace.replace(/\\/g, "/")}/`) || !/^([A-Za-z]:)?[\\/]/.test(detail);
      actions.push({ type: "approval", line, kind: "write", detail, inside, print: false, shown: "", deniedText: `PermissionError: write denied: ${detail}` });
      return;
    }
    const fetch = new RegExp(String.raw`\bfetch\(\s*${QUOTED}\s*\)`).exec(text);
    if (fetch) {
      const url = unquote(fetch[2]!);
      let host = url;
      try {
        host = new URL(url).hostname;
      } catch {
        // not a URL: the whole text is the detail
      }
      actions.push({ type: "approval", line, kind: "network", detail: host, inside: false, print: /^print\(/.test(text), shown: "Example Domain", deniedText: `PermissionError: network access denied: ${host}` });
      return;
    }
    const submit = /^submit\((.*)\)$/.exec(text);
    if (submit) {
      const arg = submit[1]!.trim();
      const q = new RegExp(`^${QUOTED}$`).exec(arg);
      let answer: string | number | null;
      if (q) answer = unquote(q[2]!);
      else if (/^-?\d+(\.\d+)?$/.test(arg)) answer = Number(arg);
      else {
        const v = valueOf(arg);
        answer = typeof v === "string" ? v : v === undefined ? arg : JSON.stringify(v);
      }
      actions.push({ type: "submit", line, answer });
      return;
    }
    const print = /^print\((.*)\)$/.exec(text);
    if (print) {
      const arg = print[1]!.trim();
      const len = /^len\(([A-Za-z_]\w*)\)$/.exec(arg);
      const q = new RegExp(`^${QUOTED}$`).exec(arg);
      if (len) actions.push({ type: "print", line, len: len[1]! });
      else if (q) actions.push({ type: "print", line, text: unquote(q[2]!) });
      else if (/^[A-Za-z_]\w*$/.test(arg)) actions.push({ type: "print", line, name: arg });
    }
  });
  return actions;
}

/** What a print shows, read when the cell reaches it (a name may be set earlier in the same cell). */
function printed(run: RunState, a: Extract<Action, { type: "print" }>): string {
  if (a.text !== undefined) return a.text;
  const v = run.vars.get((a.len ?? a.name)!);
  if (a.len !== undefined) return String(v?.length ?? 0);
  return Array.isArray(v) ? reprList(v) : (v ?? "None");
}
/** The prompts of an llm_batch: a list literal, or an f-string with {i} over range(N) anywhere in the cell. */
function batchPrompts(code: string, rhs: string): string[] {
  const literal = /\bllm_batch\(\s*\[([^\]]*)\]\s*\)/.exec(rhs);
  if (literal && !/\bfor\b/.test(literal[1]!)) {
    const items = [...literal[1]!.matchAll(new RegExp(QUOTED, "g"))].map((m) => unquote(m[2]!));
    if (items.length > 0) return items;
  }
  const range = /\brange\(\s*(\d+)\s*\)/.exec(code);
  const template = new RegExp(String.raw`\bf${QUOTED}`).exec(code);
  if (range && template && template[2]!.includes("{i}")) {
    const n = Number(range[1]);
    return Array.from({ length: n }, (_, i) => unquote(template[2]!).replaceAll("{i}", String(i)));
  }
  return ["prompt"];
}

// -- createFakeApp --

function memorySecrets(): SecretsLike {
  const store = new Map<string, string>();
  return {
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

async function removeWithRetries(dir: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i >= 9) throw err;
      await Bun.sleep(50 * (i + 1)); // Windows can hold a handle for a moment
    }
  }
}

export async function createFakeApp(opts: FakeAppOptions = {}): Promise<FakeApp> {
  const scenario: Scenario = opts.scenario ?? "simpleRead";
  // the real path: on macOS tmpdir() is under /var, a symlink to /private/var
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rlmh-fake-")));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  let cwd = opts.cwd;
  if (cwd === undefined) {
    cwd = join(dir, "work");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "a.txt"), "hello\n");
    writeFileSync(join(cwd, "b.txt"), "world\nsecond line\n");
  }
  const scriptPath = join(dir, "script.json");
  writeFileSync(scriptPath, JSON.stringify({ ...SCENARIO_SCRIPTS[scenario], ...(opts.script ?? {}) }, null, 2));

  const hadScript = Object.prototype.hasOwnProperty.call(process.env, "RLMH_FAKE_SCRIPT");
  const previousScript = process.env.RLMH_FAKE_SCRIPT;
  process.env.RLMH_FAKE_SCRIPT = scriptPath;
  const env: Record<string, string> = { RLMH_FAKE_SCRIPT: scriptPath, ...(opts.env ?? {}) };

  let settings: Settings = setSetting(defaultSettings(), "root.model", "fake/scripted");
  for (const [k, v] of Object.entries(opts.settings ?? {})) settings = setSetting(settings, k, v);
  saveSettings(home, settings);

  const keys = new KeyStore({ home, secrets: memorySecrets(), env });
  const catalog = new Catalog(home);
  const bus = new Bus<AppEvents>();
  const fetchCalls: string[] = [];
  const offlineFetch = (async (input: Parameters<typeof fetch>[0]) => {
    fetchCalls.push(input instanceof Request ? input.url : String(input));
    throw new Error("offline");
  }) as unknown as typeof fetch;
  const gateway = new Gateway({ keys, catalog, settings, bus, fetch: offlineFetch, env });
  const approvals = new ApprovalQueue();

  const toEngine = pipe();
  const toApp = pipe();
  const appLink = new Link(toApp.readable, toEngine.writer);
  const engineLink = new Link(toEngine.readable, toApp.writer, { idPrefix: "e" });
  const engineSide = new EngineSide(engineLink, home, scenario);

  // the app side: exactly what Session.open wires (§7.3)
  appLink.handle("model.complete", async (p: ModelCompleteParams, { signal }) => {
    try {
      return await gateway.complete(p, signal);
    } catch (err) {
      if (err instanceof RpcError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new RpcError(ErrorCode.MODEL_ERROR, message, { kind: "other", provider: p.model.provider, model: p.model.model, status: null, message });
    }
  });
  appLink.onNotification("model.cancel", (p: { run_id: string }) => gateway.cancelRun(p.run_id));
  appLink.handle("approval.request", (p: ApprovalParams) => approvals.ask(p));
  appLink.onNotification("*", (method, params) => {
    if (method.startsWith("run.")) bus.emit("engine.event", { method, params });
  });

  let closed = false;
  let crashed = false;
  const closeLinks = () => {
    engineSide.stopAll();
    appLink.close();
    engineLink.close();
    toEngine.close();
    toApp.close();
  };

  const startCalls: StartRun[] = [];
  const session = {
    bus,
    gateway,
    settings,
    info(): Promise<EngineInfo> {
      return fetchInfo(appLink);
    },
    start(r: StartRun): Promise<RunStartResult> {
      startCalls.push(r);
      let params: RunStartParams;
      try {
        params = buildRunParams(r, { settings: this.settings, resolveCallFormat: (ref, s) => gateway.resolveCallFormat(ref, s) });
      } catch (err) {
        return Promise.reject(err);
      }
      return appLink.request<RunStartResult>("run.start", params);
    },
    async cancel(runId: string): Promise<void> {
      try {
        await appLink.request("run.cancel", { run_id: runId });
      } catch (err) {
        if (!(err instanceof RpcError && err.code === ErrorCode.UNKNOWN_RUN)) throw err;
      }
    },
    async vars(runId: string): Promise<VarInfo[]> {
      return (await appLink.request<RunVarsResult>("run.vars", { run_id: runId })).vars;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      closeLinks();
    },
  } satisfies SessionLike;

  const engine: FakeEngine = {
    calls: engineSide.calls,
    emit: (method, params) => engineSide.emit(method, params),
    crash(code, stderr) {
      if (crashed) return;
      crashed = true;
      closeLinks();
      // as engine.ts does: the link is closed (pending requests have rejected) before engine.exit
      void Promise.all([appLink.closed, engineLink.closed]).then(() => bus.emit("engine.exit", { code, stderr: [...stderr] }));
    },
    get runId() {
      return engineSide.runId;
    },
  };

  const deps: AppDeps = { session, keys, catalog, approvals, home, cwd, size: opts.size, env };

  let disposing: Promise<void> | undefined;
  return {
    session,
    deps,
    engine,
    bus,
    startCalls,
    fetchCalls,
    sessionClosed: () => closed,
    scriptPath,
    dispose() {
      disposing ??= (async () => {
        closeLinks();
        for (const id of engineSide.runIds()) gateway.cancelRun(id); // stops the fake provider's timers
        approvals.denyAll();
        if (process.env.RLMH_FAKE_SCRIPT === scriptPath) {
          if (hadScript) process.env.RLMH_FAKE_SCRIPT = previousScript;
          else delete process.env.RLMH_FAKE_SCRIPT;
        }
        await removeWithRetries(dir);
      })();
      return disposing;
    },
  };
}

// -- scriptedBus --

export interface ScriptedBus {
  /** engine.event {method, params: {run_id, ...params}}. */
  event(method: string, params: object): void;
  subcall(params: Partial<RunSubcallParams>): void;
  callStart(callId: string, over?: Partial<AppEvents["call.start"]>): void;
  delta(callId: string, d: { text?: string; reasoning?: string; reset?: true }): void;
  callEnd(callId: string, over?: Partial<AppEvents["call.end"]>): void;
}

/** Usage with non-zero tokens and cost: what the fake provider (zero prices) can't produce. */
export function scriptedUsage(over: Partial<Usage> = {}): Usage {
  return { input_tokens: 1200, output_tokens: 340, cache_read_tokens: 800, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0.0023, ...over };
}

export function scriptedBus(bus: Bus<AppEvents>, runId: string): ScriptedBus {
  return {
    event(method, params) {
      bus.emit("engine.event", { method, params: { run_id: runId, ...params } });
    },
    subcall(params) {
      bus.emit("engine.event", {
        method: "run.subcall",
        params: {
          run_id: runId,
          subcall_id: 1,
          origin: { turn: 1, line: 1 },
          batch: { id: "b1", index: 0, size: 1 },
          prompt_chars: 10,
          status: "sent",
          error: null,
          seconds: null,
          ...params,
        } satisfies RunSubcallParams,
      });
    },
    callStart(callId, over = {}) {
      bus.emit("call.start", {
        call_id: callId,
        run_id: runId,
        role: "sub",
        subcall_id: 1,
        batch: { id: "b1", index: 0, size: 1 },
        origin: { turn: 1, line: 1 },
        model: { provider: "fake", model: "scripted", thinking: null },
        prompt: "Summarize part 0",
        started_at: Date.now(),
        ...over,
      });
    },
    delta(callId, d) {
      bus.emit("call.delta", { call_id: callId, ...d });
    },
    callEnd(callId, over = {}) {
      bus.emit("call.end", { call_id: callId, run_id: runId, usage: scriptedUsage(), finish_reason: "stop", seconds: 1.2, ...over });
    },
  };
}

// -- runRecord --

function usage(input: number, output: number, cacheRead: number, cost: number, reasoning = 0): Usage {
  return { input_tokens: input, output_tokens: output, cache_read_tokens: cacheRead, cache_write_tokens: 0, reasoning_tokens: reasoning, cost_usd: cost };
}

/** A complete run-log record (format 1), keys in §7.8 order: a read-mode question, 2 turns, one 3-call batch, one permission. */
export function runRecord(over: Record<string, unknown> = {}): Record<string, any> {
  const runId = "r_3f9a0c1d2e4b";
  const workspace = `/tmp/rlmh-home/scratch/${runId}`;
  const context = "First part: the ledger opens.\n\nSecond part: the totals are checked.\n\nThird part: the answer is 42.\n";
  const question = "What number does the ledger end on?";
  const code1 = "parts = context.split('\\n\\n')\nouts = llm_batch([f'Summarize: {p}' for p in parts[:3]])\nprint(outs)\nprint(shell('wc -l notes.txt'))";
  const stdout1 = "['The ledger opens.', 'The totals are checked.', 'The answer is 42.']\n3 notes.txt\n";
  const observation1 = `REPL output:\n${stdout1}\n(19 turns left, 77 sub-calls left)`;
  const call1 = { id: "call_1", name: "python", arguments: { code: code1 } };
  const call2 = { id: "call_2", name: "python", arguments: { code: "submit('42')" } };
  const first = `Question: ${question}\n\nThe input is in \`context\` (${context.length} characters). Write Python to read it, and call submit() with your answer.`;
  const rootTurn1 = usage(2100, 120, 0, 0.006, 40);
  const rootTurn2 = usage(2400, 30, 2000, 0.004);
  const subUsage = [usage(300, 25, 0, 0.0008), usage(310, 27, 0, 0.0008), usage(290, 22, 0, 0.0007)];
  const sum = (list: Usage[]): Usage => {
    const t = zeroUsage();
    for (const u of list) addUsage(t, u);
    t.cost_usd = Math.round(t.cost_usd * 1e6) / 1e6;
    return t;
  };
  const root = sum([rootTurn1, rootTurn2]);
  const sub = sum(subUsage);
  const prompts = ["Summarize: First part: the ledger opens.", "Summarize: Second part: the totals are checked.", "Summarize: Third part: the answer is 42."];
  const outputs = ["The ledger opens.", "The totals are checked.", "The answer is 42."];
  const reads = root.cache_read_tokens + sub.cache_read_tokens;
  const record: Record<string, any> = {
    format: 1,
    run_id: runId,
    tag: null,
    batch: "interactive",
    harness_version: "0.1.0",
    protocol: PROTOCOL_VERSION,
    contract: "v4",
    contract_hash: CONTRACT_HASH,
    prompt_hash: DEFAULT_PROMPT_HASH,
    profile: "default",
    profile_hash: PROFILES[0]!.profile_hash,
    mode: "read",
    call_format: "native",
    root: { provider: "fake", model: "scripted", thinking: null },
    sub: { provider: "fake", model: "scripted", thinking: null },
    permission_mode: "accept-edits",
    limits: { ...FAKE_LIMITS, cpus: 1.0, memory_mb: 2048, pids: 64, grader_timeout_s: null, subcall_thinking: null, subcall_oversize: "error" },
    started_at: 1793450000.25,
    wall_s: 6.412,
    question,
    input: { chars: context.length, lines: context.split("\n").length - 1, sha256: sha(context), files: ["/home/user/notes/ledger.txt"] },
    workspace,
    base_tree: null,
    messages: [
      { role: "system", content: FAKE_SYSTEM_PROMPT },
      { role: "user", content: first },
      { role: "assistant", content: "Let me split the input and ask about each part.", tool_call: call1 },
      { role: "tool", tool_call_id: "call_1", content: observation1 },
      { role: "assistant", content: "", tool_call: call2 },
    ],
    turns: [
      {
        turn: 1,
        reply: "Let me split the input and ask about each part.",
        tool_call: call1,
        reasoning: "The input has three parts separated by blank lines; one sub-call each, then count the notes.",
        finish_reason: "tool_call",
        usage: rootTurn1,
        code: code1,
        stdout: stdout1,
        stdout_chars: stdout1.length,
        error: null,
        stderr: "",
        observation: observation1,
        restarted: false,
        crash: null,
        repo_changed: null,
        root_s: 1.42,
        compute_s: 0.051,
        blocked_s: 2.734,
        wall_s: 2.811,
      },
      {
        turn: 2,
        reply: "",
        tool_call: call2,
        reasoning: null,
        finish_reason: "tool_call",
        usage: rootTurn2,
        code: "submit('42')",
        stdout: "",
        stdout_chars: 0,
        error: null,
        stderr: "",
        observation: null,
        restarted: false,
        crash: null,
        repo_changed: null,
        root_s: 0.96,
        compute_s: 0.004,
        blocked_s: 0,
        wall_s: 0.006,
      },
    ],
    subcalls: prompts.map((prompt, i) => ({
      subcall_id: i + 1,
      origin: { turn: 1, line: 2 },
      batch: { id: "b1", index: i, size: 3 },
      prompt,
      output: outputs[i],
      error: null,
      seconds: [1.21, 1.34, 1.18][i],
      usage: subUsage[i],
    })),
    fetches: [],
    permissions: [{ turn: 1, kind: "shell", detail: "wc -l notes.txt", allowed: true, asked: true, remembered: false }],
    submitted: true,
    answer: "42",
    answer_valid: true,
    usage: { root, sub },
    cost_usd: 0.0123,
    cache: { read_tokens: reads, write_tokens: 0, hit_rate: reads / (root.input_tokens + sub.input_tokens) },
    timeouts: 0,
    crashes: 0,
    restarts: 0,
    diff: null,
    infra_error: null,
    infra_kind: null,
    host_traceback: null,
  };
  return { ...record, ...over };
}
