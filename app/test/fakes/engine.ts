// KV cache: none; a test fake. It builds model.complete messages the way the engine does, but its bytes are never sent to a real provider.
// The fake engine for step 7's interface tests: it speaks the real link (two in-memory Links, the engine
// side with idPrefix "e") and drives the real Gateway on the scripted fake provider (§7.5). It answers
// engine.info, run.start, run.cancel, run.vars, run.say and run.close, and plays a scenario with the events and
// ordering of §5.4. Only the `conversation` scenario keeps a run started with `conversation: true` open after its
// answer (v1 step 4); every other scenario ends such a run after its first prompt, as an infra error would. The replies come from the fake-provider script derived from the scenario, never from here: the
// engine side only runs the code it gets back, through a small reader of the few Python shapes the
// scenarios use (llm, llm_batch, shell, open(..., "w"), fetch, print, submit).
//
// v1 step 9: engine.info also lists every profile under `<home>/profiles/` (the built-ins' folders are real ones in
// the fake's temp folder), run.start accepts them, profile.check answers (`ok: false` for a guidance with INVALID),
// and `createFakeApp({tune: {stages}})` plays `/tune`'s stage runs from a script and writes every run's record.
//
// `scriptedBus` covers what the fake provider can't produce (reasoning, a chosen error, a flood of deltas,
// non-zero cost), and `runRecord` is a complete run-log record (§7.8) for /runs and viewFromRecord.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
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
  type ProfileCheckResult,
  type RunSayResult,
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

export type Scenario = "simpleRead" | "fanOut20" | "approvalShell" | "twoApprovals" | "slow" | "rootError" | "hold" | "compacting" | "conversation";

export interface FakeEngine {
  /** Every request the engine received, in order (engine.info, run.start, run.cancel, run.vars, run.say, run.close). */
  calls: { method: string; params: any }[];
  /** Send a notification from the engine side; `run_id` defaults to the current run. A `run.finished` for an active run also stops its play (after a `model.cancel`, as D-84 orders). */
  emit(method: string, params: object): void;
  /** Close the link both ways, then emit bus "engine.exit" {code, stderr}; later requests reject with -32800. */
  crash(code: number, stderr: string[]): void;
  /** The current or last run id. */
  readonly runId: string | null;
  /** The engine forgets the current run without a word to the app, so its next run.say gets -32010 (v1 step 4). */
  dropRun(): void;
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
  /**
   * v1 step 9: `/tune`'s stages. A run whose tag is `tune:<id>:<stage>` with a script here doesn't reach the fake
   * provider: it runs the stage's `code` cell (if any, so approvals are asked or denied as usual), emits one call.end
   * on the bus carrying `costUsd`, writes `exit.txt` (`<exit>\n`) into a repo run's folder when `exit` is given (its
   * record's diff adds that file), and finishes with the stage's answer (a string as it is, anything else as JSON),
   * or with `infra`. With `tune` given, every run (the user's own too) also writes a run-log record.
   */
  tune?: { stages?: Record<string, TuneStageScript> };
}

export interface TuneStageScript {
  answer?: unknown;
  /** One answer per call of this stage, the last repeated (a retried session). */
  answers?: unknown[];
  costUsd?: number;
  /** One cost per call of this stage, the last repeated; in place of costUsd. */
  costsUsd?: number[];
  exit?: number;
  /** One cell to run first, through the fake's cell reader (shell, open, fetch, print, …). */
  code?: string;
  /** End with this infra kind instead of an answer (no_credit, …). */
  infra?: string;
  /** Before the cost lands; default 5 ms. */
  delayMs?: number;
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
  /** v1 step 3: before turn COMPACT_AT the play compacts once, with a `purpose: "compact"` call the script's `compact`
   *  list answers, then run.compacted. */
  compacting: {
    root: [
      { text: "Reading the first part.", tool_call: { code: `print('${"a".repeat(3000)}')` } },
      { text: "Reading the second part.", tool_call: { code: `print('${"b".repeat(3000)}')` } },
      { text: "Reading the third part.", tool_call: { code: `print('${"c".repeat(3000)}')` } },
      { text: "", tool_call: { code: "submit('compacted answer')" } },
    ],
    sub: [{ text: "unused" }],
    compact: [{ text: "SUMMARY of the work so far." }],
    chunk_chars: 8,
    delay_ms: 5,
  },
  /** v1 step 4: one root reply per prompt, each a submit; the second (follow-up 1) streams for about a second. Each
   *  run starts at the top of the list again. */
  conversation: {
    root: [
      { text: "Answering the first question.", tool_call: { code: "submit('first answer')" } },
      { text: SLOW_TEXT, tool_call: { code: "submit('second answer')" } },
      { text: "Answering the next one.", tool_call: { code: "submit('third answer')" } },
      { text: "", tool_call: { code: "submit('fourth answer')" } },
    ],
    sub: [{ text: "unused" }],
    chunk_chars: 4,
    delay_ms: 15,
  },
};

/** The engine's follow-up texts (engine/rlm_engine/followup.py), as the fake engine appends them. */
const SUBMITTED_NOTE = "Your answer was submitted, and the user has seen it.";
const UNANSWERED_NOTE = "That question ended without a submitted answer.";
const FOLLOW_UP_WHERE: Record<string, string> = { read: ", and `context` is unchanged", repo: ", and the repository keeps your edits" };

/** The `compacting` scenario's turn that a compaction precedes, and its plan (v1 architecture §4.1 on a 4,096 window). */
export const COMPACT_AT = 4;
const FAKE_COMPACT_PLAN = { window: 4096, trigger: 3276, keep: 614 };

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
/** The built-ins' limits as engine.info gives them (v1 step 2). */
const limitsOf = (turns: { read: number; repo: number }, tokens: number): EngineInfo["profiles"][number]["limits"] => {
  const mode = (max_turns: number, repo: boolean) => ({
    max_turns,
    max_subcalls: 80,
    root_max_tokens: tokens,
    output_max_chars: 8000,
    cell_timeout_s: repo ? 300 : 120,
    cpus: repo ? 2 : 1,
    memory_mb: repo ? 4096 : 512,
    pids: repo ? 256 : 64,
    grader_timeout_s: repo ? 600 : null,
    subcall_max_chars: 60000,
    subcall_max_tokens: tokens,
    subcall_thinking: repo ? "low" : null,
    subcall_oversize: "error",
  });
  return { read: mode(turns.read, false), repo: mode(turns.repo, true) };
};
const PROFILES: EngineInfo["profiles"] = [
  { name: "default", source: "builtin", prompt_hash: DEFAULT_PROMPT_HASH, profile_hash: sha("profile default"), agent_api: true, limits: limitsOf({ read: 50, repo: 150 }, 16384), path: "/fake/profiles/default", contract: "rlmh-1" },
  { name: "training-v4", source: "builtin", prompt_hash: CONTRACT_HASH, profile_hash: sha("profile training-v4"), agent_api: false, limits: limitsOf({ read: 20, repo: 30 }, 4096), path: "/fake/profiles/training-v4", contract: "v4" },
];

/** The built-ins' folders, which the fake writes into its temp folder so tuner code can read and copy them (v1 step 9). */
const BUILTIN_FILES: Record<string, Record<string, string>> = {
  default: {
    "profile.toml": 'contract = "rlmh-1"\ncache_api = true\nagent_api = true\n\n[read]\nmax_turns = 50\n\n[repo]\nmax_turns = 150\n',
    "guidance.md": "Read the input with code, and delegate reading to llm().\n",
    "system.md": "You are the fake rlmh-1 system prompt. {shell}\n",
  },
  "training-v4": {
    "profile.toml": 'contract = "v4"\n\n[read]\nmax_turns = 20\n\n[repo]\nmax_turns = 30\n',
    "guidance.md": "Training's guidance.\n",
  },
};

/** Every file under `dir`, as `/` paths relative to it, sorted; `__pycache__` left out. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "__pycache__") continue;
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** A profile folder's fake hash: its files in sorted order, each as path, NUL, bytes, NUL. */
function folderHash(dir: string): string {
  return sha(filesUnder(dir).map((f) => `${f}\0${readFileSync(join(dir, ...f.split("/")), "utf8")}\0`).join(""));
}

/** `<table>.<key>` to its value text, for the simple TOML the profiles use. */
function tomlKeys(text: string): Map<string, string> {
  const out = new Map<string, string>();
  let table = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const t = /^\[([^\]]+)\]$/.exec(line);
    if (t) table = t[1]!.trim();
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*(#.*)?$/.exec(line);
    if (kv) out.set(table === "" ? kv[1]! : `${table}.${kv[1]}`, kv[2]!);
  }
  return out;
}

/** What profile.check's `changed` lists (the dotted keys, then guidance, system and the other files), the fake's way. */
function changedKeys(base: string, cand: string): string[] {
  const read = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : null);
  const a = tomlKeys(read(base, "profile.toml") ?? "");
  const b = tomlKeys(read(cand, "profile.toml") ?? "");
  const keys = [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
  if (read(base, "guidance.md") !== read(cand, "guidance.md")) keys.push("guidance");
  if (read(base, "system.md") !== read(cand, "system.md")) keys.push("system");
  const skip = new Set(["profile.toml", "guidance.md", "system.md"]);
  const files = [...new Set([...filesUnder(base), ...filesUnder(cand)])].filter((f) => !skip.has(f)).sort();
  for (const f of files) if (read(base, f) !== read(cand, f)) keys.push(f);
  return keys;
}

/** A `git diff`-shaped patch that adds one file, as a repo run's record carries it. */
function newFileDiff(path: string, text: string): string {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`), ""].join("\n");
}

/** The fixed run.vars answer while a run is active. */
export const FAKE_VARS: VarInfo[] = [
  { name: "outs", type: "list", len: 20, chars: 412 },
  { name: "n", type: "int", len: null, chars: 2 },
];

function zeroUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: 0 };
}

/** v1 architecture §4.1 for the default profile's table: the plan run.started reports. */
function defaultPlan(window: { context_window: number } | undefined): { window: number; trigger: number; keep: number } {
  const w = Math.min(window && window.context_window > 0 ? window.context_window : Infinity, 262_144);
  const out = FAKE_LIMITS.root_max_tokens;
  return { window: w, trigger: Math.max(Math.min(Math.floor(0.8 * w), w - out - 65_536), Math.floor(w / 2)), keep: Math.floor(0.16 * (w - out)) };
}

/** Every content string plus every tool call's arguments, as compaction.estimate counts them. */
function messageChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + m.content.length + (m.role === "assistant" && m.tool_call ? JSON.stringify(m.tool_call.arguments).length : 0), 0);
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
  /** v1 step 4: true when this run stays open after an answer (the `conversation` scenario and `conversation: true`). */
  conversation: boolean;
  /** The prompt playing, or the last one played. */
  promptIndex: number;
  /** An open conversation between prompts, waiting for run.say or run.close. */
  waiting: boolean;
  /** subcallsUsed when the prompt began: budgets start over each prompt, ids keep counting. */
  subcallBase: number;
  /** Whether the previous prompt submitted, for the follow-up's note. */
  lastSubmitted: boolean;
  batches: number;
  usage: { root: Usage; sub: Usage };
  vars: Map<string, string | string[]>;
  remembered: Set<string>;
  infra: { kind: string; error: string } | null;
  /** v1 step 9 (`tune` given): what the record says. */
  diff: string | null;
  startedEpoch: number;
  cells: { turn: number; code: string; stdout: string; error: string | null }[];
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
  private readonly stageCalls = new Map<string, number>();

  constructor(
    private readonly link: Link,
    private readonly home: string,
    private readonly scenario: Scenario,
    /** v1 step 9: the built-ins' folders, `/tune`'s stage scripts, and how a stage's cost reaches the bus. */
    private readonly extra: { builtinDir: string; tune?: { stages?: Record<string, TuneStageScript> }; onCost: (runId: string, usd: number) => void },
  ) {
    for (const [name, files] of Object.entries(BUILTIN_FILES)) {
      for (const [f, text] of Object.entries(files)) {
        mkdirSync(join(extra.builtinDir, name), { recursive: true });
        writeFileSync(join(extra.builtinDir, name, f), text);
      }
    }
    link.handle("engine.info", async (p) => {
      this.calls.push({ method: "engine.info", params: p });
      const info: EngineInfo = {
        version: "0.0.0-fake",
        protocol: PROTOCOL_VERSION,
        python: "3.12.10",
        contract: "v4",
        contract_hash: CONTRACT_HASH,
        training_hash: CONTRACT_HASH,
        profiles: this.profiles(),
      };
      return info;
    });
    link.handle("profile.check", async (p: { path: string; base: string | null; gated?: boolean }) => {
      this.calls.push({ method: "profile.check", params: p });
      const guidance = existsSync(join(p.path, "guidance.md")) ? readFileSync(join(p.path, "guidance.md"), "utf8") : "";
      const fail = (error: string) => ({ ok: false, errors: [error], prompt_hash: null, profile_hash: null, changed: [] });
      if (!existsSync(join(p.path, "profile.toml"))) return fail(`${p.path}: no profile.toml`);
      if (guidance.includes("INVALID")) return fail("guidance.md: the fake profile.check refuses a guidance that says INVALID");
      const base = p.base === null ? null : this.profiles().find((x) => x.name === p.base);
      if (base === undefined) return fail(`unknown base profile ${JSON.stringify(p.base)}`);
      const system = existsSync(join(p.path, "system.md")) ? readFileSync(join(p.path, "system.md"), "utf8") : "";
      return { ok: true, errors: [], prompt_hash: sha(`${system}\0${guidance}`), profile_hash: folderHash(p.path), changed: base === null ? [] : changedKeys(base.path, p.path) };
    });
    link.handle("run.start", async (p: RunStartParams) => {
      this.calls.push({ method: "run.start", params: p });
      return this.start(p);
    });
    link.handle("run.cancel", async (p: { run_id: string }) => {
      this.calls.push({ method: "run.cancel", params: p });
      const run = this.active(p.run_id);
      if (run.waiting) this.close(run); // between prompts: run.closed, and no new run.finished
      else this.finish(run, { infra: { kind: "cancelled", error: "cancelled: the run was cancelled" } });
      return {};
    });
    link.handle("run.say", async (p: { run_id: string; text: unknown }) => {
      this.calls.push({ method: "run.say", params: p });
      const run = this.conversationOf(p.run_id);
      if (typeof p.text !== "string" || p.text === "") throw new RpcError(ErrorCode.INVALID_PARAMS, "text must be a non-empty string");
      if (!run.waiting) throw new RpcError(ErrorCode.RUN_BUSY, `run ${run.id} is still answering a prompt`);
      run.waiting = false;
      run.promptIndex += 1;
      const text = p.text;
      // the result is written first; the prompt's first model.complete follows it (§5.4)
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        void this.prompt(run, text);
      }, 0);
      this.timers.add(timer);
      return { prompt_index: run.promptIndex };
    });
    link.handle("run.close", async (p: { run_id: string }) => {
      this.calls.push({ method: "run.close", params: p });
      const run = this.conversationOf(p.run_id);
      if (!run.waiting) throw new RpcError(ErrorCode.RUN_BUSY, `run ${run.id} is still answering a prompt; use run.cancel`);
      this.close(run);
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

  /** The built-ins (in the fake's own folders), then every folder under `<home>/profiles/` holding a profile.toml. */
  profiles(): EngineInfo["profiles"] {
    const out = PROFILES.map((x) => ({ ...x, path: join(this.extra.builtinDir, x.name) }));
    const dir = join(this.home, "profiles");
    if (!existsSync(dir)) return out;
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (!existsSync(join(path, "profile.toml")) || out.some((x) => x.name === name)) continue;
      const toml = readFileSync(join(path, "profile.toml"), "utf8");
      const rlmh1 = !/contract\s*=\s*"v4"/.test(toml);
      out.push({
        name,
        source: "user",
        prompt_hash: sha(`prompt ${name}`),
        profile_hash: folderHash(path),
        agent_api: rlmh1,
        limits: limitsOf({ read: 50, repo: 150 }, 16384),
        path,
        contract: rlmh1 ? "rlmh-1" : "v4",
      });
    }
    return out;
  }

  private active(runId: unknown): RunState {
    const run = typeof runId === "string" ? this.runs.get(runId) : undefined;
    if (!run || run.finished) throw new RpcError(ErrorCode.UNKNOWN_RUN, `no run ${JSON.stringify(runId)} is going`);
    return run;
  }

  /** An open conversation, or -32010 (unknown, over, or a one-shot run). */
  private conversationOf(runId: unknown): RunState {
    const run = this.active(runId);
    if (!run.conversation) throw new RpcError(ErrorCode.UNKNOWN_RUN, `run ${run.id} is not an open conversation`);
    return run;
  }

  /** The current run, gone without a word (the test's way to make run.say answer -32010). */
  dropRun(): void {
    const run = this.runId ? this.runs.get(this.runId) : undefined;
    if (!run) return;
    run.finished = true;
    run.ac.abort();
  }

  /** The end of a conversation: model.cancel, then run.closed {prompts}. */
  private close(run: RunState): void {
    if (run.finished) return;
    run.finished = true;
    run.waiting = false;
    run.ac.abort();
    this.link.notify("model.cancel", { run_id: run.id });
    this.link.notify("run.closed", { run_id: run.id, prompts: run.promptIndex + 1 });
  }

  private start(p: RunStartParams): RunStartResult {
    if (!this.profiles().some((x) => x.name === p.profile)) {
      throw new RpcError(ErrorCode.UNKNOWN_PROFILE, `unknown profile ${JSON.stringify(p.profile)}: known are ${this.profiles().map((x) => x.name).join(", ")}`);
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
      conversation: p.conversation === true && this.scenario === "conversation",
      promptIndex: 0,
      waiting: false,
      subcallBase: 0,
      lastSubmitted: false,
      batches: 0,
      usage: { root: zeroUsage(), sub: zeroUsage() },
      vars: new Map(),
      remembered: new Set(),
      infra: null,
      diff: null,
      startedEpoch: Date.now() / 1000,
      cells: [],
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

  /** A prompt's end: an open conversation waits for run.say (`open: true`); anything else ends the run. */
  private endPrompt(run: RunState, outcome: { answer?: string | number | null; submitted?: boolean; infra?: { kind: string; error: string } | null }): void {
    if (run.finished) return;
    if (!run.conversation || outcome.infra) return this.finish(run, outcome);
    run.lastSubmitted = outcome.submitted ?? false;
    run.waiting = true;
    this.writeRecord(run, outcome);
    this.link.notify("run.finished", this.finishedParams(run, outcome, true)); // nothing is cancelled between prompts (D-203)
  }

  /** v1 step 9: with `tune` given, each prompt's record goes to the run's log before its run.finished, as the engine writes it. */
  private writeRecord(run: RunState, outcome: { answer?: string | number | null; submitted?: boolean; infra?: { kind: string; error: string } | null }): void {
    if (this.extra.tune === undefined) return;
    const p = run.params;
    const { root, sub } = run.usage;
    const record = runRecord({
      run_id: run.id,
      tag: p.tag ?? null,
      batch: p.batch ?? (p.log_dir ? basename(p.log_dir) : "interactive"),
      profile: p.profile,
      profile_hash: this.profiles().find((x) => x.name === p.profile)?.profile_hash ?? sha(p.profile),
      mode: p.mode,
      call_format: p.call_format,
      root: p.root,
      sub: p.sub,
      permission_mode: p.permission_mode,
      started_at: run.startedEpoch,
      wall_s: Math.round(performance.now() - run.startedAt) / 1000,
      question: p.mode === "read" ? (p.question ?? null) : null,
      ...(p.mode === "repo" ? { task: p.task ?? null } : {}),
      input: { chars: run.context.length, lines: 0, sha256: sha(run.context), files: (p.inputs ?? []).map((f) => f.replace(/\\/g, "/")) },
      workspace: run.workspace,
      messages: run.messages.length > 0 ? run.messages : [{ role: "system", content: FAKE_SYSTEM_PROMPT }],
      turns: run.cells.map((c) => ({ turn: c.turn, reply: "", tool_call: null, reasoning: null, finish_reason: "tool_call", usage: zeroUsage(), code: c.code, stdout: c.stdout, stdout_chars: c.stdout.length, error: c.error, stderr: "", observation: null, restarted: false, crash: null, repo_changed: null })),
      subcalls: [],
      permissions: [],
      submitted: outcome.submitted ?? false,
      answer: outcome.answer ?? null,
      usage: { root: { ...root }, sub: { ...sub } },
      cost_usd: Math.round((root.cost_usd + sub.cost_usd) * 1e6) / 1e6,
      diff: p.mode === "repo" ? (run.diff ?? "") : null,
      infra_error: outcome.infra?.error ?? null,
      infra_kind: outcome.infra?.kind ?? null,
      window: p.window ?? { context_window: 0, max_output: 0 },
      prompt_index: run.promptIndex,
      conversation: p.conversation === true,
    });
    mkdirSync(dirname(run.logPath), { recursive: true });
    appendFileSync(run.logPath, `${JSON.stringify(record)}\n`);
  }

  private finish(run: RunState, outcome: { answer?: string | number | null; submitted?: boolean; infra?: { kind: string; error: string } | null }): void {
    if (run.finished) return;
    run.finished = true;
    run.waiting = false;
    run.ac.abort();
    this.writeRecord(run, outcome);
    this.link.notify("model.cancel", { run_id: run.id }); // D-84: at the end of every run, before run.finished
    this.link.notify("run.finished", this.finishedParams(run, outcome, false));
    // a run asked to be a conversation that ends here sends run.closed last, as the engine does after an infra error
    if (run.params.conversation === true) this.link.notify("run.closed", { run_id: run.id, prompts: run.promptIndex + 1 });
  }

  private finishedParams(run: RunState, outcome: { answer?: string | number | null; submitted?: boolean; infra?: { kind: string; error: string } | null }, open: boolean): object {
    const { root, sub } = run.usage;
    return {
      run_id: run.id,
      tag: run.params.tag ?? null,
      answer: outcome.answer ?? null,
      submitted: outcome.submitted ?? false,
      answer_valid: true,
      turns: run.turns,
      subcalls: run.subcallsUsed - run.subcallBase,
      usage: { root: { ...root }, sub: { ...sub } },
      cost_usd: Math.round((root.cost_usd + sub.cost_usd) * 1e6) / 1e6,
      infra_error: outcome.infra?.error ?? null,
      infra_kind: outcome.infra?.kind ?? null,
      wall_s: Math.round(performance.now() - run.startedAt) / 1000,
      log_path: run.logPath,
      prompt_index: run.promptIndex,
      open,
    };
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
      window: p.window ?? { context_window: 0, max_output: 0 },
      compaction: p.profile === "training-v4" ? null : this.scenario === "compacting" ? { ...FAKE_COMPACT_PLAN } : defaultPlan(p.window),
      conversation: p.conversation === true,
    });
    const stage = /^tune:[^:]+:(.+)$/.exec(p.tag ?? "")?.[1];
    const script = stage === undefined ? undefined : this.extra.tune?.stages?.[stage];
    if (stage !== undefined && script !== undefined) return this.playStage(run, stage, script);
    if (this.scenario === "hold") return; // nothing more until run.cancel

    const first = repo
      ? `Task: ${p.task}\n\nThe repository is your working folder. Make the change, run the tests, then call submit().`
      : `Question: ${p.question ?? ""}\n\nThe input is in \`context\` (${run.context.length} characters). Write Python to read it, and call submit() with your answer.`;
    run.messages = [
      { role: "system", content: FAKE_SYSTEM_PROMPT },
      { role: "user", content: first },
    ];
    await this.turns(run);
  }

  /** v1 step 9: a `/tune` stage's run, as `tune.stages[stage]` scripts it (see FakeAppOptions.tune). */
  private async playStage(run: RunState, stage: string, s: TuneStageScript): Promise<void> {
    const p = run.params;
    const n = this.stageCalls.get(stage) ?? 0;
    this.stageCalls.set(stage, n + 1);
    const answer = s.answers !== undefined && s.answers.length > 0 ? s.answers[Math.min(n, s.answers.length - 1)] : s.answer;
    const wait = (ms: number) =>
      new Promise<void>((done) => {
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          done();
        }, ms);
        this.timers.add(timer);
      });
    run.messages = [
      { role: "system", content: FAKE_SYSTEM_PROMPT },
      { role: "user", content: p.mode === "repo" ? `Task: ${p.task}` : `Question: ${p.question ?? ""}` },
    ];
    try {
      if (s.code !== undefined) {
        run.turns = 1;
        const r = await this.cell(run, 1, s.code);
        this.check(run);
        run.cells.push({ turn: 1, code: s.code, stdout: r.output, error: r.error });
        this.event(run, "run.cell", { turn: 1, code: s.code, output: r.output, error: r.error, observation: null, seconds: 0, restarted: false, crash: null, repo_changed: p.mode === "repo" ? false : null });
      }
      await wait(s.delayMs ?? 5);
      this.check(run);
      const cost = s.costsUsd !== undefined && s.costsUsd.length > 0 ? s.costsUsd[Math.min(n, s.costsUsd.length - 1)]! : (s.costUsd ?? 0);
      if (cost > 0) {
        run.usage.root.cost_usd += cost;
        this.extra.onCost(run.id, cost);
      }
      await wait(10); // a cap's run.cancel lands first
      this.check(run);
      if (p.mode === "repo" && s.exit !== undefined) {
        writeFileSync(join(run.workspace, "exit.txt"), `${s.exit}\n`);
        run.diff = newFileDiff("exit.txt", `${s.exit}\n`);
      }
      if (s.infra !== undefined) return this.finish(run, { infra: { kind: s.infra, error: `${s.infra}: the fake stage script ended the run` } });
      this.endPrompt(run, { answer: answer === undefined ? null : typeof answer === "string" ? answer : JSON.stringify(answer), submitted: answer !== undefined });
    } catch (err) {
      if (run.finished || err instanceof Stopped) return;
      this.finish(run, { infra: { kind: "host_bug", error: `host error: ${String(err)}` } });
    }
  }

  /** Follow-up `run.promptIndex` (v1 step 4): the previous prompt closed with its note, the question, then the turns. */
  private async prompt(run: RunState, text: string): Promise<void> {
    if (run.finished) return;
    run.turns = 0;
    run.usage = { root: zeroUsage(), sub: zeroUsage() };
    run.subcallBase = run.subcallsUsed;
    run.startedAt = performance.now();
    const note = run.lastSubmitted ? SUBMITTED_NOTE : UNANSWERED_NOTE;
    const followUp =
      `Follow-up from the user. The REPL still holds every variable from before${FOLLOW_UP_WHERE[run.params.mode] ?? ""}.\n\n${text}\n\n` +
      `(${FAKE_LIMITS.max_turns} turns left, ${this.subcallsLeft(run)} sub-calls left) Answer this with submit(), as before.`;
    const last = run.messages[run.messages.length - 1];
    if (last?.role === "assistant" && last.tool_call) {
      run.messages.push({ role: "tool", tool_call_id: last.tool_call.id, content: note }, { role: "user", content: followUp });
    } else {
      run.messages.push({ role: "user", content: `${note}\n\n${followUp}` });
    }
    await this.turns(run);
  }

  /** One prompt's turns, numbered from 1 (D-199), until submit, the turn limit or an error. */
  private async turns(run: RunState): Promise<void> {
    const p = run.params;
    const repo = p.mode === "repo";
    const native = p.call_format === "native";
    try {
      for (let turn = 1; turn <= FAKE_LIMITS.max_turns; turn++) {
        if (this.scenario === "compacting" && turn === COMPACT_AT) await this.compact(run, turn, native);
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
          this.endPrompt(run, { answer: result.answer, submitted: true });
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
      this.endPrompt(run, {});
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

  /** The `compacting` scenario's one compaction: head, the summary message, and the newest turn (v1 architecture §4.2). */
  private async compact(run: RunState, turn: number, native: boolean): Promise<void> {
    const p = run.params;
    const asked = performance.now();
    const before = Math.ceil(messageChars(run.messages) / 3);
    const reply = await this.link.request<ModelCompleteResult>(
      "model.complete",
      {
        run_id: run.id,
        role: "root",
        purpose: "compact",
        model: p.root,
        messages: [...run.messages.map((m) => ({ ...m })), { role: "user", content: "Stop work on the task for this one reply. Write the summary." }],
        tools: native ? [structuredClone(PYTHON_TOOL)] : [],
        max_tokens: 512,
        temperature: 0,
        thinking: "off",
        turn,
      } satisfies ModelCompleteParams,
      { signal: run.ac.signal },
    );
    this.check(run);
    addUsage(run.usage.root, reply.usage);
    const head = run.messages.slice(0, 2);
    const tail = run.messages.slice(-2);
    const dropped = run.messages.length - head.length - tail.length;
    const summary = `[${dropped / 2} earlier turns were compacted to save context. Your summary of them follows.]\n\n${reply.text}\n\n[The newest turns follow as they were. The REPL still holds every variable.]`;
    run.messages = [...head, { role: "user", content: summary }, ...tail];
    this.event(run, "run.compacted", {
      turn,
      prompt_index: run.promptIndex,
      child_id: null,
      before_tokens: before,
      after_tokens: Math.ceil(messageChars(run.messages) / 3),
      dropped_messages: dropped,
      kept_messages: tail.length,
      summary_chars: reply.text.length,
      seconds: Math.round(performance.now() - asked) / 1000,
    });
  }

  private subcallsLeft(run: RunState): number {
    return Math.max(0, FAKE_LIMITS.max_subcalls - (run.subcallsUsed - run.subcallBase));
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
    if (run.subcallsUsed - run.subcallBase + n > FAKE_LIMITS.max_subcalls) {
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
  const engineSide = new EngineSide(engineLink, home, scenario, {
    builtinDir: join(dir, "builtin"),
    ...(opts.tune !== undefined ? { tune: opts.tune } : {}),
    onCost: (runId, usd) =>
      bus.emit("call.end", {
        call_id: `${runId}-tune-${Math.random().toString(36).slice(2, 8)}`,
        run_id: runId,
        usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0, cost_usd: usd },
        finish_reason: "stop",
        seconds: 0,
      }),
  });

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
        params = buildRunParams(r, {
          settings: this.settings,
          resolveCallFormat: (ref, s) => gateway.resolveCallFormat(ref, s),
          windowOf: (ref) => {
            const m = catalog.get(ref.provider, ref.model);
            return { context_window: m?.context_window ?? 0, max_output: m?.max_output ?? 0 };
          },
        });
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
    say(runId: string, text: string): Promise<RunSayResult> {
      return appLink.request<RunSayResult>("run.say", { run_id: runId, text });
    },
    async closeRun(runId: string): Promise<void> {
      try {
        await appLink.request("run.close", { run_id: runId });
      } catch (err) {
        if (!(err instanceof RpcError && err.code === ErrorCode.UNKNOWN_RUN)) throw err;
      }
    },
    checkProfile(path: string, base: string | null, gated = false): Promise<ProfileCheckResult> {
      return appLink.request<ProfileCheckResult>("profile.check", { path: resolve(path), base, gated });
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
    dropRun: () => engineSide.dropRun(),
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

/** A complete run-log record (format 2, v1 step 3), keys in §7.8 order: a read-mode question, 2 turns, one 3-call batch, one permission. */
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
    format: 2,
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
    children: [],
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
    window: { context_window: 1_000_000, max_output: 0 },
    compactions: [],
    prompt_index: 0,
    conversation: false,
  };
  return { ...record, ...over };
}
