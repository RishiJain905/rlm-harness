// KV cache: none; it fills defaults and the engine writes the bytes.
// One engine and one gateway for the app or a CLI command (architecture §7.8): `open` starts the
// engine and wires the link to the gateway and the bus as §7.3 says, `start` turns a StartRun into
// `run.start` params with the settings' defaults, and `close` ends the engine.

import { resolve } from "node:path";
import { Bus } from "./bus.ts";
import { fetchInfo, findEngine, ProtocolMismatch, startEngine, type EngineProcess } from "./engine.ts";
import { Catalog } from "./gateway/catalog.ts";
import { Gateway, type AppEvents } from "./gateway/gateway.ts";
import { KeyStore } from "./gateway/keys.ts";
import { parseModelRef } from "./gateway/providers.ts";
import { RpcError } from "./link.ts";
import {
  ErrorCode,
  type ApprovalParams,
  type ApprovalResult,
  type CallFormat,
  type EngineInfo,
  type ModelCompleteParams,
  type ModelRef,
  type PermissionMode,
  type RunStartParams,
  type RunStartResult,
  type RunVarsResult,
  type VarInfo,
} from "./protocol.ts";
import { loadSettings, type Settings } from "./settings.ts";

const INFO_TIMEOUT_MS = 120_000; // a first `uv run` may fetch Python
const CLOSE_WAIT_MS = 10_000;
const PERMISSION_MODES: readonly string[] = ["default", "accept-edits", "bypass"];
const CALL_FORMATS: readonly string[] = ["auto", "fenced", "native"];

export interface StartRun {
  mode: "read" | "repo";
  question?: string;
  inputs?: string[];
  task?: string;
  repoPath?: string;
  testHint?: string;
  profile?: string;
  root?: ModelRef;
  sub?: ModelRef;
  permissionMode?: string;
  callFormat?: string;
  interactive: boolean;
  tag?: string;
  batch?: string;
  logDir?: string;
}

/** A mistake in what the user asked for; the CLI prints it and exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/** The engine could not be started or did not answer engine.info; `stderr` is its tail. */
export class EngineStartError extends Error {
  readonly stderr: string[];

  constructor(message: string, stderr: string[]) {
    super(message);
    this.name = "EngineStartError";
    this.stderr = stderr;
  }
}

/** The thinking setting for a role; `default` means the profile's, sent as null (D-08). */
export function thinkingOf(settings: Settings, role: "root" | "sub"): ModelRef["thinking"] {
  const t = settings[role].thinking;
  return t === "default" ? null : t;
}

type ResolveCallFormat = (ref: ModelRef, setting: "auto" | "fenced" | "native") => CallFormat;

/** Pure: the snake_case `run.start` params, with every default taken from `settings`. Throws UsageError. */
export function buildRunParams(r: StartRun, deps: { settings: Settings; resolveCallFormat: ResolveCallFormat }): RunStartParams {
  const { settings } = deps;
  if (r.mode !== "read" && r.mode !== "repo") throw new UsageError(`mode must be read or repo (got ${JSON.stringify(r.mode)})`);
  const root = r.root ?? settingRef(settings, "root");
  if (!root) {
    throw new UsageError("no root model: pass --root provider/model, or pick one with `rlmh config set root.model provider/model`");
  }
  // An empty sub.model is the root's provider and model, with the sub thinking setting, never the root's.
  const sub = r.sub ?? settingRef(settings, "sub") ?? { provider: root.provider, model: root.model, thinking: thinkingOf(settings, "sub") };
  const permissionMode = r.permissionMode ?? settings.permissions.mode;
  if (!PERMISSION_MODES.includes(permissionMode)) {
    throw new UsageError(`permission mode must be one of ${PERMISSION_MODES.join(", ")} (got ${JSON.stringify(permissionMode)})`);
  }
  const callFormat = r.callFormat ?? settings.call_format;
  if (!CALL_FORMATS.includes(callFormat)) {
    throw new UsageError(`call format must be one of ${CALL_FORMATS.join(", ")} (got ${JSON.stringify(callFormat)})`);
  }
  const p: RunStartParams = {
    mode: r.mode,
    profile: r.profile ?? settings.profile,
    root,
    sub,
    permission_mode: permissionMode as PermissionMode,
    call_format: deps.resolveCallFormat(root, callFormat as "auto" | "fenced" | "native"),
    interactive: r.interactive,
  };
  if (r.mode === "read") {
    if (r.question !== undefined) p.question = r.question;
    if (r.inputs !== undefined) p.inputs = r.inputs.map((f) => resolve(f));
  } else {
    if (r.task !== undefined) p.task = r.task;
    if (r.repoPath !== undefined) p.repo_path = resolve(r.repoPath);
    if (r.testHint !== undefined) p.test_hint = r.testHint;
  }
  if (r.tag !== undefined) p.tag = r.tag;
  if (r.batch !== undefined) p.batch = r.batch;
  if (r.logDir !== undefined) p.log_dir = resolve(r.logDir);
  return p;
}

function settingRef(settings: Settings, role: "root" | "sub"): ModelRef | undefined {
  const model = settings[role].model;
  return model === "" ? undefined : parseModelRef(model, thinkingOf(settings, role));
}

/** Resolves with `p`, or with undefined after `ms`; the timer never outlives the race. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((done) => (timer = setTimeout(() => done(undefined), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export class Session {
  readonly bus: Bus<AppEvents>;
  readonly gateway: Gateway;
  /** The interface swaps it, and the gateway's, after /model or /settings saves a change; the next run reads it. */
  settings: Settings;
  readonly keys: KeyStore;
  readonly catalog: Catalog;
  private readonly engine: EngineProcess;
  private closing: Promise<void> | undefined;

  private constructor(parts: { bus: Bus<AppEvents>; gateway: Gateway; settings: Settings; keys: KeyStore; catalog: Catalog; engine: EngineProcess }) {
    this.bus = parts.bus;
    this.gateway = parts.gateway;
    this.settings = parts.settings;
    this.keys = parts.keys;
    this.catalog = parts.catalog;
    this.engine = parts.engine;
  }

  /** Throws SettingsError, EngineNotFound, ProtocolMismatch (the engine is killed) or EngineStartError. */
  static async open(opts: { home: string; verbose?: boolean; approvals: (p: ApprovalParams) => Promise<ApprovalResult> }): Promise<Session> {
    const settings = loadSettings(opts.home);
    const keys = new KeyStore({ home: opts.home });
    const catalog = new Catalog(opts.home);
    const bus = new Bus<AppEvents>();
    const gateway = new Gateway({ keys, catalog, settings, bus });
    // engine.ts strips key-like variables from the engine's env (D-29)
    const verbose = opts.verbose ?? settings.display.verbose;
    const engine = startEngine(findEngine({ home: opts.home, env: process.env }), {
      onStderr: verbose ? (line) => process.stderr.write(`${line}\n`) : undefined,
    });
    const { link } = engine;
    link.handle("model.complete", async (p: ModelCompleteParams, { signal }) => {
      try {
        return await gateway.complete(p, signal);
      } catch (err) {
        if (err instanceof RpcError) throw err; // the gateway's ModelError is one: Link answers -32001
        const message = err instanceof Error ? err.message : String(err);
        throw new RpcError(ErrorCode.MODEL_ERROR, message, { kind: "other", provider: p.model.provider, model: p.model.model, status: null, message });
      }
    });
    link.onNotification("model.cancel", (p: { run_id: string }) => gateway.cancelRun(p.run_id));
    link.handle("approval.request", (p: ApprovalParams) => opts.approvals(p));
    link.onNotification("*", (method, params) => {
      if (method.startsWith("run.")) bus.emit("engine.event", { method, params });
    });
    void engine.exited.then((code) => bus.emit("engine.exit", { code, stderr: engine.stderrTail() }));

    try {
      const info = await within(fetchInfo(link), INFO_TIMEOUT_MS);
      if (info === undefined) throw new Error(`the engine did not answer engine.info within ${INFO_TIMEOUT_MS / 1000} s`);
    } catch (err) {
      engine.kill(); // D-36: a different protocol, or no answer
      const code = await within(engine.exited, CLOSE_WAIT_MS);
      if (err instanceof RpcError && err.code === ErrorCode.CANCELLED) {
        throw new EngineStartError(`the engine exited before answering (exit code ${code ?? "unknown"})`, engine.stderrTail());
      }
      if (err instanceof ProtocolMismatch) throw err;
      throw new EngineStartError(err instanceof Error ? err.message : String(err), engine.stderrTail());
    }
    return new Session({ bus, gateway, settings, keys, catalog, engine });
  }

  info(): Promise<EngineInfo> {
    return fetchInfo(this.engine.link);
  }

  /** Throws UsageError before anything is sent, or the engine's RpcError (-32011, -32012, -32602). */
  start(r: StartRun): Promise<RunStartResult> {
    let params: RunStartParams;
    try {
      params = buildRunParams(r, { settings: this.settings, resolveCallFormat: (ref, s) => this.gateway.resolveCallFormat(ref, s) });
    } catch (err) {
      return Promise.reject(err);
    }
    return this.engine.link.request<RunStartResult>("run.start", params);
  }

  /** Returns once the run's run.finished was sent; a run that is unknown or already over is no error. */
  async cancel(runId: string): Promise<void> {
    try {
      await this.engine.link.request("run.cancel", { run_id: runId });
    } catch (err) {
      if (!(err instanceof RpcError && err.code === ErrorCode.UNKNOWN_RUN)) throw err;
    }
  }

  async vars(runId: string): Promise<VarInfo[]> {
    return (await this.engine.link.request<RunVarsResult>("run.vars", { run_id: runId })).vars;
  }

  /** Safe to call more than once. The engine's stdin is closed (its normal way out), and it is killed if it lingers. */
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.engine.link.close();
      this.engine.kill(); // closes stdin, then kills the tree after a grace period
      await within(this.engine.exited, CLOSE_WAIT_MS);
    })();
    return this.closing;
  }
}
