// KV cache: none
// `/tune`, online (v1 architecture §7.6, step 9 tasks 4 and 5; D-215, D-216, D-218, D-221, D-231 to D-233, D-257):
// Harness²'s contrastive step at k = 1 over the user's own tasks, in the order they finish, as harness2's
// schedule.py `run_domain` runs a domain's tasks. The user's run is the reference; then the INV and DOM editors, a
// probe of each candidate that differs from the base, the composer, one run of the composed harness and, with
// the library on, the reflector. Every run goes through runEval's inline form, non-interactive, in a throwaway work
// copy of the task's snapshot; every session is step 6's runSession on the tuning model. A kept harness becomes
// `<home>/profiles/tuned-<YYYYMMDD-HHMM>`; the interface switches to it (this module never touches settings,
// except to turn tuning off when the cap trips with no `turnOff` given). One TuneQueue runs one task at a time.

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { message, RunWatcher } from "../cli/run.ts";
import { referenceRunUsd } from "../eval/estimate.ts";
import { ACCOUNT, accountStopMessage, CostCap, runEval, type EvalDeps, type InlineEvalOptions, type InlineResult, type InlineRun, type InlineTask } from "../eval/runner.ts";
import { removeQuietly } from "../eval/work.ts";
import type { Catalog } from "../gateway/catalog.ts";
import { parseModelRef } from "../gateway/providers.ts";
import { libraryDir, profilesDir, runsDir, tuneDir } from "../paths.ts";
import type { EngineInfo, ModelRef, ProfileInfo, RunFinishedParams } from "../protocol.ts";
import { settingsRefs, type StartRun } from "../session.ts";
import { loadSettings, saveSettings, setSetting, type Settings } from "../settings.ts";
import { diffProfiles, installProfile, uninstallProfiles } from "./candidate.ts";
import { writeEvidence, type EvidenceRun, type RunLabel, type Secrets, type Stage } from "./evidence.ts";
import { addEntry, userDomain } from "./library.ts";
import { runSession, type ComposerSubmission, type EditorSubmission, type ReflectorSubmission, type StageResult, type TuneSession } from "./sessions.ts";
import { runTest, snapshot, workCopy, type Snapshot, type SnapshotOptions } from "./worktree.ts";

/** The note for a task offered while one is tuned and another waits (D-231). */
export const TUNE_BUSY = "Tuning is busy; this task was skipped.";
/** The note for a waiting task whose run's profile is no longer the active one (D-231). */
export const PROFILE_GONE = "The waiting task was skipped: the profile its run used is no longer active.";

/** The transcript's line when the cap trips (spec task 5). */
export const capNote = (maxUsd: number): string => `Tuning turned off: the $${maxUsd.toFixed(2)} cap was reached.`;
/** The transcript's line when an account kind stops a tune (D-257). */
export const accountNote = (kind: string): string => `Tuning turned off: ${accountStopMessage(kind, "the tune stopped", true)}`;

/** A task's stages in order; `ref` is the user's own run and makes no run. */
export type OnlineStage = "ref" | "inv" | "dom" | "probe-inv" | "probe-dom" | "compose" | "composed" | "reflect";
export const STAGES: readonly OnlineStage[] = ["ref", "inv", "dom", "probe-inv", "probe-dom", "compose", "composed", "reflect"];
/** The session stages, whose records' tags end in `:<stage>` (the estimate's medians). */
const SESSION_TAG = /:(inv|dom|compose|reflect)$/;
/** How many earlier records each median reads (D-221). */
const HISTORY = 20;

const two = (n: number) => String(n).padStart(2, "0");
const day = (d: Date) => `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}`;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;

// -- ids, names and online.json --

const allocated = new Set<string>();

/** A new task id, `t_<YYYYMMDD-HHMMSS>` in local time, with `-2`, `-3`… when this process or `tuneDir(home)` already has it. */
export function taskId(home: string, now: Date = new Date()): string {
  const base = `t_${day(now)}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  for (let n = 1; ; n++) {
    const id = n === 1 ? base : `${base}-${n}`;
    if (allocated.has(id) || existsSync(join(tuneDir(home), id)) || existsSync(join(tuneDir(home), "snapshots", id))) continue;
    allocated.add(id);
    return id;
  }
}

/** The name a kept harness gets: `tuned-<YYYYMMDD-HHMM>` in local time, with `-2`, `-3`… when the profile exists. */
export function tunedName(home: string, now: Date = new Date()): string {
  const base = `tuned-${day(now)}-${two(now.getHours())}${two(now.getMinutes())}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!existsSync(join(profilesDir(home), name))) return name;
  }
}

export interface OnlineJson {
  /** ISO time of the last `/tune on`: the start of what `tune.max_usd` counts. */
  on_since: string;
}

const onlinePath = (home: string) => join(tuneDir(home), "online.json");

/** `/tune on`: writes `tuneDir(home)/online.json` with `on_since` = now, so the spend starts at $0. */
export function writeOnline(home: string, now: Date = new Date()): OnlineJson {
  const j: OnlineJson = { on_since: now.toISOString() };
  mkdirSync(tuneDir(home), { recursive: true });
  writeFileSync(onlinePath(home), `${JSON.stringify(j, null, 2)}\n`);
  return j;
}

export function readOnline(home: string): OnlineJson | null {
  try {
    const j = JSON.parse(readFileSync(onlinePath(home), "utf8"));
    return typeof j?.on_since === "string" && Number.isFinite(Date.parse(j.on_since)) ? (j as OnlineJson) : null;
  } catch {
    return null;
  }
}

// -- the run logs --

interface LogRow {
  /** The folder under runsDir: the batch. */
  batch: string;
  tag: string | null;
  mode: string;
  /** `provider/model`. */
  root: string;
  cost: number;
  infra: boolean;
  /** Unix seconds. */
  started: number;
  promptIndex: number;
}

const refName = (r: unknown): string => {
  if (typeof r !== "object" || r === null) return "";
  const { provider, model } = r as { provider?: unknown; model?: unknown };
  return typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : "";
};
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Every record under `runsDir(home)/*\/runs.jsonl`, summarized; torn lines are skipped. `only` picks the folders. */
function readLogs(home: string, only: (batch: string) => boolean = () => true): LogRow[] {
  const root = runsDir(home);
  if (!existsSync(root)) return [];
  const rows: LogRow[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || !only(e.name)) continue;
    let text: string;
    try {
      text = readFileSync(join(root, e.name, "runs.jsonl"), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(line);
      } catch {
        continue;
      }
      rows.push({
        batch: e.name,
        tag: typeof r.tag === "string" ? r.tag : null,
        mode: typeof r.mode === "string" ? r.mode : "",
        root: refName(r.root),
        cost: num(r.cost_usd),
        infra: (r.infra_kind !== null && r.infra_kind !== undefined) || (r.infra_error !== null && r.infra_error !== undefined),
        started: num(r.started_at),
        promptIndex: num(r.prompt_index),
      });
    }
  }
  return rows;
}

const isTuneBatch = (b: string) => b.startsWith("tune-");

/** Everything `/tune` spent since `onSince` (ISO), summed from the `tune-*` run logs; null counts everything there. */
export function spentSince(home: string, onSince: string | null): number {
  const since = onSince === null ? -Infinity : Date.parse(onSince) / 1000;
  return round6(readLogs(home, isTuneBatch).reduce((a, r) => (r.started >= since ? a + r.cost : a), 0));
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const newest = (rows: LogRow[]) => [...rows].sort((a, b) => b.started - a.started).slice(0, HISTORY);

// -- the estimate (task 4) --

export interface OnlineEstimateDeps {
  home: string;
  settings: Settings;
  catalog: Pick<Catalog, "get">;
  /** engine.info's profiles: the active one caps the runs' reference figures, the built-in `default` the sessions'. */
  profiles?: Pick<ProfileInfo, "name" | "agent_api" | "limits">[];
}

export interface OnlinePart {
  count: number;
  /** One run's or session's price; null when unpriced. */
  each_usd: number | null;
  usd: number | null;
  /** `history`: the median of `samples` earlier records; `reference`: §6.6's row. */
  source: "history" | "reference";
  samples: number;
}

export interface OnlineLine {
  mode: "read" | "repo";
  /** 3 runs on the root (and sub) model. */
  runs: OnlinePart;
  /** 4 sessions on the tuning model, 3 with `tune.library` off. */
  sessions: OnlinePart;
  total_usd: number | null;
  runs_share: number | null;
  sessions_share: number | null;
  /** Whole tasks of this mode the cap covers: Infinity when a task prices at $0, null when unpriced. */
  covers: number | null;
  over_cap: boolean;
}

export interface OnlineEstimate {
  read: OnlineLine;
  repo: OnlineLine;
  cap_usd: number;
  root: ModelRef | null;
  sub: ModelRef | null;
  tuning: ModelRef | null;
  profile: string;
  library: boolean;
  /** Why `/tune on` has no `y`: the profile is training-v4, no root model is picked, or both lines are over the cap. */
  blocked: null | "training-v4" | "no_root" | "over_cap";
  /** One line over the cap: such a task will trip it. */
  warnings: string[];
  unpriced: string[];
}

/** The tuning model: `tune.model`, or the root model when it is empty (D-232). */
export function tuningModel(settings: Settings, root: ModelRef | undefined): ModelRef | undefined {
  return settings.tune.model !== "" ? parseModelRef(settings.tune.model, null) : root;
}

/**
 * `/tune on`'s per-task estimate (D-221, D-231, D-232): for each mode, 3 × the median cost of the last 20 records
 * under `runsDir(home)` with that mode and the root model (no `tune-*` batch, no infra run, first prompts only),
 * else §6.6's row (R read, M repo) priced at the root and sub models; plus 4 sessions (3 with the library off) ×
 * the median cost of the last 20 `/tune` sessions on the tuning model, else §6.6's R row priced at it. Reads only
 * the run logs: no run, no gateway call, nothing written.
 */
export function estimateOnline(deps: OnlineEstimateDeps): OnlineEstimate {
  const s = deps.settings;
  const { root, sub } = settingsRefs(s);
  const tuning = tuningModel(s, root);
  const cap = s.tune.max_usd;
  const rows = readLogs(deps.home);
  const active = deps.profiles?.find((p) => p.name === s.profile);
  const builtin = deps.profiles?.find((p) => p.name === "default");
  const sessionCount = s.tune.library ? 4 : 3;
  const unpriced = new Set<string>();
  const sessionRows = tuning === undefined ? [] : newest(rows.filter((r) => isTuneBatch(r.batch) && r.tag !== null && SESSION_TAG.test(r.tag) && !r.infra && r.root === `${tuning.provider}/${tuning.model}`));
  const sessionMedian = median(sessionRows.map((r) => r.cost));
  const sessionEach =
    tuning === undefined ? null : (sessionMedian ?? referenceRunUsd("R", "read", { root: tuning, sub: tuning, catalog: deps.catalog, ...(builtin ? { profile: builtin } : {}) }));
  if (tuning !== undefined && sessionMedian === null && sessionEach === null) unpriced.add(`${tuning.provider}/${tuning.model}`);
  const line = (mode: "read" | "repo"): OnlineLine => {
    const runRows =
      root === undefined ? [] : newest(rows.filter((r) => !isTuneBatch(r.batch) && r.mode === mode && !r.infra && r.promptIndex === 0 && r.root === `${root.provider}/${root.model}`));
    const m = median(runRows.map((r) => r.cost));
    const runEach = root === undefined || sub === undefined ? null : (m ?? referenceRunUsd(mode === "read" ? "R" : "M", mode, { root, sub, catalog: deps.catalog, ...(active ? { profile: active } : {}) }));
    if (root !== undefined && m === null && runEach === null) for (const r of [root, sub!]) unpriced.add(`${r.provider}/${r.model}`);
    const runsUsd = runEach === null ? null : 3 * runEach;
    const sessUsd = sessionEach === null ? null : sessionCount * sessionEach;
    const total = runsUsd === null || sessUsd === null ? null : runsUsd + sessUsd;
    return {
      mode,
      runs: { count: 3, each_usd: runEach, usd: runsUsd, source: m === null ? "reference" : "history", samples: runRows.length },
      sessions: { count: sessionCount, each_usd: sessionEach, usd: sessUsd, source: sessionMedian === null ? "reference" : "history", samples: sessionRows.length },
      total_usd: total,
      runs_share: total === null || total === 0 ? null : runsUsd! / total,
      sessions_share: total === null || total === 0 ? null : sessUsd! / total,
      covers: total === null ? null : total === 0 ? Infinity : Math.floor(cap / total + 1e-9),
      over_cap: total !== null && total > cap + 1e-12,
    };
  };
  const read = line("read");
  const repo = line("repo");
  const warnings: string[] = [];
  if (read.over_cap !== repo.over_cap) {
    const over = read.over_cap ? read : repo;
    warnings.push(`a ${over.mode} task is estimated at $${over.total_usd!.toFixed(2)}, over the $${cap.toFixed(2)} cap: such a task will trip the cap and turn tuning off`);
  }
  const blocked = s.profile === "training-v4" ? "training-v4" : root === undefined ? "no_root" : read.over_cap && repo.over_cap ? "over_cap" : null;
  return { read, repo, cap_usd: cap, root: root ?? null, sub: sub ?? null, tuning: tuning ?? null, profile: s.profile, library: s.tune.library, blocked, warnings, unpriced: [...unpriced].sort() };
}

// -- tasks --

/** One task to tune: a first prompt the user ran in the interactive app (§7.6). */
export interface TuneTask {
  /** `t_<YYYYMMDD-HHMMSS>` (taskId). */
  id: string;
  /** The user's run: the reference. */
  runId: string;
  /** Its runs.jsonl (run.finished's log_path). */
  logPath: string;
  mode: "read" | "repo";
  /** The profile the user's run used: the incumbent H (D-215). */
  profile: string;
  /** The user's run's root and sub models; the probes and the composed run use them (D-232). */
  root: ModelRef;
  sub: ModelRef;
  question?: string;
  inputs?: string[];
  task?: string;
  testHint?: string;
  /** Repo mode: the folder the user's run worked in (its library domain's name). */
  folder?: string;
  /** Repo mode: the folder's state before the run (takeSnapshot). */
  snapshot?: Snapshot;
  /** The reference record; default: read from `logPath` (prompt 0 of `runId`). */
  record?: Record<string, unknown>;
}

/**
 * Null when a finished run may be offered to TuneQueue (§7.6): a first prompt (`prompt_index` 0, never a
 * follow-up) that submitted, with no infra error, under a profile that can be a base (not `training-v4`).
 * Otherwise why not. The interface calls it at `run.finished`; `rlmh run`, `batch` and `eval` never offer.
 */
export function offerProblem(f: Pick<RunFinishedParams, "prompt_index" | "submitted" | "infra_kind" | "infra_error">, profile: string): string | null {
  if ((f.prompt_index ?? 0) !== 0) return "follow-up prompts are not tuned";
  if (f.infra_error !== null || f.infra_kind !== null) return "the run ended with an infra error";
  if (!f.submitted) return "the run ended without a submitted answer";
  if (profile === "training-v4") return "training-v4 is never tuned";
  return null;
}

export const isOfferable = (f: Parameters<typeof offerProblem>[0], profile: string): boolean => offerProblem(f, profile) === null;

/**
 * The snapshot taken before a tuned repo task's run.start (§7.6): a fresh task id and `snapshot(folder,
 * tuneDir(home)/snapshots/<id>)`. A refusal or a failure gives `{refused}`, and the run goes ahead untuned.
 */
export async function takeSnapshot(home: string, folder: string, o: { now?: Date } & Pick<SnapshotOptions, "maxFiles" | "maxBytes"> = {}): Promise<{ id: string; snapshot: Snapshot } | { refused: string }> {
  const id = taskId(home, o.now ?? new Date());
  try {
    const snap = await snapshot(folder, join(tuneDir(home), "snapshots", id), { home, ...(o.maxFiles !== undefined ? { maxFiles: o.maxFiles } : {}), ...(o.maxBytes !== undefined ? { maxBytes: o.maxBytes } : {}) });
    if ("refused" in snap) return { refused: `not tuned: ${snap.refused}` };
    return { id, snapshot: snap };
  } catch (err) {
    return { refused: `not tuned: the snapshot failed: ${message(err)}` };
  }
}

/** A TuneTask from the user's run: its request, run.finished and run.started's profile and models. */
export function taskFromRun(o: {
  home: string;
  request: Pick<StartRun, "mode" | "question" | "inputs" | "task" | "repoPath" | "testHint">;
  finished: Pick<RunFinishedParams, "run_id" | "log_path">;
  profile: string;
  root: ModelRef;
  sub: ModelRef;
  snap?: { id: string; snapshot: Snapshot };
  now?: Date;
}): TuneTask {
  const r = o.request;
  const t: TuneTask = {
    id: o.snap?.id ?? taskId(o.home, o.now ?? new Date()),
    runId: o.finished.run_id,
    logPath: o.finished.log_path,
    mode: r.mode,
    profile: o.profile,
    root: o.root,
    sub: o.sub,
  };
  if (r.mode === "read") {
    if (r.question !== undefined) t.question = r.question;
    if (r.inputs !== undefined) t.inputs = r.inputs;
  } else {
    if (r.task !== undefined) t.task = r.task;
    if (r.testHint !== undefined) t.testHint = r.testHint;
    if (r.repoPath !== undefined) t.folder = r.repoPath;
    if (o.snap) t.snapshot = o.snap.snapshot;
  }
  return t;
}

/** The record of prompt 0 of `runId` in a runs.jsonl, or null. */
export function readTaskRecord(logPath: string, runId: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(runId)) continue;
    try {
      const r = JSON.parse(line);
      if (r?.run_id === runId && num(r.prompt_index) === 0) return r;
    } catch {
      // torn
    }
  }
  return null;
}

// -- tuneTask (task 5) --

/** What tuneTask and TuneQueue need of the app's Session (the interactive app passes its own). */
export interface OnlineSession extends TuneSession {
  info(): Promise<EngineInfo>;
  close(): Promise<void>;
}

export interface TuneDeps {
  home: string;
  session: OnlineSession;
  /** The current settings, read at each task's start (tune.model, tune.library, tune.test, tune.max_usd, permissions.mode, profile). */
  settings: () => Settings;
  now?: () => Date;
  /** Default: runEval (its inline form). */
  runEval?: (o: InlineEvalOptions, d?: EvalDeps) => Promise<InlineResult>;
  /** runTest's limit; default 600 s. */
  testTimeoutS?: number;
  /** Sets `tune.enabled = false` when the cap or an account stop turns tuning off; the interface passes applySetting. Default: writes settings.toml. */
  turnOff?: () => void | Promise<void>;
}

export interface TaskDeps extends TuneDeps {
  /** What `/tune` spent before this task and the cap; default: spentSince(online.json's on_since) and `tune.max_usd`. */
  budget?: { spent_usd: number; max_usd: number };
  /** Aborting cancels every running run and session; the task then ends "cancelled" and keeps nothing. */
  signal?: AbortSignal;
}

export type TaskOutcome = "kept" | "base" | "skipped" | "cancelled" | "capped" | "account" | "error";

export interface TaskResult {
  id: string;
  /** kept: a tuned profile was written; base: H stays; skipped: nothing ran; cancelled, capped, account: stopped, H stays; error: something threw. */
  outcome: TaskOutcome;
  reason: string | null;
  kept: { name: string; path: string; base: string; changed: string[] } | null;
  /** Everything this task's runs and sessions cost. */
  cost_usd: number;
  /** D-257: the account kind that stopped it. */
  account_stop: string | null;
  /** `tuneDir(home)/<id>`, which holds tune.json. */
  tune_dir: string;
}

export interface QueueState {
  running: { id: string; mode: "read" | "repo"; stage: OnlineStage | null } | null;
  waiting: { id: string; mode: "read" | "repo" } | null;
  /** `/tune`'s spend since online.json's on_since, the task in flight included. */
  spent_usd: number;
  cap_usd: number;
}

/**
 * What the interface draws from. `stage` start and end for each stage (an end carries the decision and its cost);
 * `note` lines for the transcript (dim: info, warn: a stop); `spend` as the in-flight task's cost grows; `kept`
 * when a tuned profile is written (the interface makes it active at once or when the open conversation ends); `off`
 * when the cap or an account stop turned tuning off (the queue has called `turnOff`; the interface shows `text`);
 * `state` whenever QueueState changes; `task` at a task's start and end.
 */
export type TuneEvent =
  | { type: "task"; id: string; phase: "start" | "end"; result?: TaskResult }
  | { type: "stage"; id: string; stage: OnlineStage; phase: "start" | "end"; decision?: string; cost_usd?: number }
  | { type: "note"; id: string | null; text: string; tone: "dim" | "warn" }
  | { type: "spend"; id: string; spent_usd: number; cap_usd: number }
  | { type: "kept"; id: string; name: string; base: string; changed: string[]; path: string }
  | { type: "off"; reason: "cap" | "account"; text: string }
  | { type: "state"; state: QueueState };

const NO_SECRETS: Secrets = { setDir: "", hiddenPaths: [], testIds: [] };

const systemOf = (r: Record<string, unknown>): string | null => {
  const m = Array.isArray(r.messages) ? (r.messages as { role?: string; content?: unknown }[])[0] : undefined;
  return m?.role === "system" && typeof m.content === "string" ? m.content : null;
};

/** tasks/<id>/task.md for a user's task: the question and the input names and sizes, or the task and the folder's name. */
function userTaskText(t: TuneTask): string {
  if (t.mode === "read") {
    const files = (t.inputs ?? []).map((p) => {
      let size = "?";
      try {
        size = statSync(p).size.toLocaleString("en-US");
      } catch {
        // gone: the task is skipped before this
      }
      return `- ${basename(p)}: ${size} bytes`;
    });
    return `# Task ${t.id} (read, the user's own)\n\n## Question\n\n${(t.question ?? "").trim()}\n\n## Input files (contents not shown)\n\n${files.join("\n") || "(none)"}\n`;
  }
  return `# Task ${t.id} (repo, the user's own)\n\n## Task\n\n${(t.task ?? "").trim()}\n\n${t.testHint ? `## Test hint\n\n${t.testHint}\n\n` : ""}## Repository\n\n${basename(t.folder ?? "") || "(the user's folder)"}\n`;
}

const hasDiff = (r: Record<string, unknown> | null): boolean => typeof r?.diff === "string" && r.diff.trim() !== "";

/**
 * Tunes one task (§7.6, spec task 5). Never throws for a stage's own failure: the outcome says how it ended, and
 * `<tune dir>/tune.json` is always written. At the end the `<id>-*` profiles, the work copies and the snapshot are
 * removed. It does not change settings; a kept harness comes back in `kept` (and a `kept` event).
 */
export async function tuneTask(task: TuneTask, deps: TaskDeps, onEvent: (e: TuneEvent) => void = () => {}): Promise<TaskResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const home = deps.home;
  const settings = deps.settings();
  const id = task.id;
  const tdir = join(tuneDir(home), id);
  const workRoot = join(tuneDir(home), "work", id);
  const logDir = join(runsDir(home), `tune-${id}`);
  const batch = `tune-${id}`;
  const library = settings.tune.library;
  const domain = userDomain(task);
  const testCmd = task.mode === "repo" ? settings.tune.test.trim() : "";
  const permissionMode = settings.permissions.mode;
  const tuning = tuningModel(settings, task.root) ?? task.root;
  const budget = deps.budget ?? { spent_usd: spentSince(home, readOnline(home)?.on_since ?? null), max_usd: settings.tune.max_usd };
  const doEval = deps.runEval ?? runEval;
  const session = deps.session;
  const watcher = new RunWatcher(session.bus);
  const installed = new Set<string>();
  const stages: Record<string, Record<string, unknown>> = {};
  const running = new Set<string>();
  let accountStop: string | null = null;
  let cancelled = deps.signal?.aborted ?? false;
  const st: { outcome: TaskOutcome; reason: string | null; kept: TaskResult["kept"] } = { outcome: "base", reason: null, kept: null };
  let testRule = testCmd === "" ? "off" : "not reached";
  let baseHash: string | null = null;
  mkdirSync(tdir, { recursive: true });

  const cancelRun = (runId: string) => void session.cancel(runId).catch(() => {});
  const cap = new CostCap(session.bus, Math.max(0, budget.max_usd - budget.spent_usd), cancelRun, () => {}, {
    trackedOnly: true,
    onCost: (total) => onEvent({ type: "spend", id, spent_usd: round6(budget.spent_usd + total), cap_usd: budget.max_usd }),
  });
  const onAbort = () => {
    cancelled = true;
    for (const r of running) cancelRun(r);
  };
  deps.signal?.addEventListener("abort", onAbort);
  const track = (runId: string) => {
    running.add(runId);
    cap.track(runId);
    if (cancelled || accountStop !== null) cancelRun(runId);
    return () => {
      running.delete(runId);
      cap.untrack(runId);
    };
  };
  const stopped = (): TaskOutcome | null => (accountStop !== null ? "account" : cap.capped ? "capped" : cancelled ? "cancelled" : null);
  const begin = (stage: OnlineStage) => onEvent({ type: "stage", id, stage, phase: "start" });
  const end = (stage: OnlineStage, rec: Record<string, unknown>) => {
    stages[stage] = rec;
    onEvent({ type: "stage", id, stage, phase: "end", decision: String(rec.decision), cost_usd: num(rec.cost_usd) });
  };
  const skip = (why: string) => {
    st.outcome = "skipped";
    st.reason = why;
  };
  const account = (kind: string | null | undefined) => {
    if (kind && ACCOUNT.includes(kind) && accountStop === null) {
      accountStop = kind;
      for (const r of running) cancelRun(r);
    }
  };

  const body = async (): Promise<void> => {
    // -- H and the reference --
    const info = await session.info();
    const H = info.profiles.find((p) => p.name === task.profile);
    if (H === undefined || !existsSync(join(H.path, "profile.toml"))) return void skip(`the profile ${task.profile} is not installed`);
    if (H.name === "training-v4") return void skip("training-v4 is never tuned");
    baseHash = H.profile_hash;
    begin("ref");
    const ref = task.record ?? readTaskRecord(task.logPath, task.runId);
    if (ref === null) {
      end("ref", { decision: "missing", run_id: task.runId, cost_usd: 0 });
      return void skip("the run's record is not in its run log");
    }
    if (task.mode === "read") {
      const gone = (task.inputs ?? []).find((p) => !existsSync(p));
      if (gone !== undefined || (task.inputs ?? []).length === 0) {
        end("ref", { decision: "missing", run_id: task.runId, cost_usd: 0 });
        return void skip(gone === undefined ? "the run had no input files" : `an input file is gone: ${gone}`);
      }
    } else if (task.snapshot === undefined) {
      end("ref", { decision: "missing", run_id: task.runId, cost_usd: 0 });
      return void skip("the task has no snapshot");
    }
    end("ref", { decision: "reference", run_id: task.runId, profile_hash: typeof ref.profile_hash === "string" ? ref.profile_hash : H.profile_hash, cost_usd: 0, exit: null });
    const refRun: EvidenceRun = { taskId: id, label: "ref", record: ref };
    const systemPrompt = systemOf(ref) ?? "(the system prompt was not recorded)";
    const taskMd = { [id]: userTaskText(task) };

    const sessionStage = async (stage: Stage, runs: EvidenceRun[], extra: { candidates?: { label: string; diff: string; notes: string[] }[]; composedDiff?: string }): Promise<StageResult> => {
      begin(stage);
      let s: StageResult;
      try {
        s = await runSession({
          session,
          watcher,
          stage,
          round: 1,
          root: tuning,
          sub: tuning,
          tag: `tune:${id}:${stage}`,
          logDir,
          batch,
          incumbent: { dir: H.path, name: H.name },
          candidateDir: join(tdir, "profiles", `${id}-${stage === "compose" ? "composed" : stage}`),
          track,
          evidence: (attempt) =>
            writeEvidence(join(tdir, `evidence-${stage}`), {
              stage,
              round: 1,
              attempt,
              harnessDir: H.path,
              systemPrompt,
              tasks: [],
              setDir: "",
              runs,
              secrets: NO_SECRETS,
              taskMd,
              history: "",
              ...(library ? { libraryDir: libraryDir(home), libraryDomain: domain } : {}),
              ...(extra.candidates ? { candidates: extra.candidates } : {}),
              ...(extra.composedDiff !== undefined ? { composedDiff: extra.composedDiff } : {}),
            }),
        });
      } catch (err) {
        s = { decision: "KEEP_BASE", value: null, attempts: 0, fell_back: true, errors: [`could not build the evidence: ${message(err)}`], run_ids: [], cost_usd: 0 };
      }
      account(s.account_stop);
      end(stage, {
        decision: s.decision,
        attempts: s.attempts,
        fell_back: s.fell_back,
        errors: s.errors,
        profile_hash: s.candidate?.check.profile_hash ?? null,
        changed: s.candidate?.check.changed ?? [],
        run_ids: s.run_ids,
        run_id: s.run_ids[s.run_ids.length - 1] ?? null,
        cost_usd: s.cost_usd,
        exit: null,
      });
      return s;
    };

    const runStage = async (stage: "probe-inv" | "probe-dom" | "composed", profile: string, hash: string | null, test: boolean): Promise<{ run: InlineRun; exit: number | null }> => {
      begin(stage);
      let exit: number | null = null;
      const tag = `tune:${id}:${stage}`;
      const inline: InlineTask =
        task.mode === "read"
          ? { tag, mode: "read", ...(task.question !== undefined ? { question: task.question } : {}), inputs: task.inputs ?? [] }
          : {
              tag,
              mode: "repo",
              ...(task.task !== undefined ? { task: task.task } : {}),
              ...(task.testHint !== undefined ? { testHint: task.testHint } : {}),
              workCopy: async () => {
                const wc = await workCopy(task.snapshot!, join(workRoot, stage));
                return {
                  repoPath: wc.cwd,
                  remove: () => wc.remove(),
                  ...(test
                    ? {
                        after: async (f: RunFinishedParams | null) => {
                          if (f === null || f.infra_error !== null || stopped() !== null) return;
                          exit = (await runTest(testCmd, wc.cwd, { log: join(tdir, "tests", `${stage}.log`), ...(deps.testTimeoutS !== undefined ? { timeoutS: deps.testTimeoutS } : {}) })).exit;
                        },
                      }
                    : {}),
                };
              },
            };
      const r = await doEval(
        {
          home,
          inline: [inline],
          root: task.root,
          sub: task.sub,
          profile,
          out: join(tdir, stage),
          logDir,
          maxUsd: null,
          id: `${id}-${stage}`,
          batch,
          permissionMode,
          interactive: false,
          sharedBus: true,
          track,
          meta: { tune: id, stage, profile_hash: hash },
        },
        { session },
      );
      const run: InlineRun = r.runs[0] ?? { tag, run_id: null, finished: null, record: null, infra_kind: "other", submitted: false, cost_usd: 0, error: "no run" };
      account(r.account_stop ?? run.infra_kind);
      end(stage, {
        decision: run.infra_kind !== null ? `infra: ${run.infra_kind}` : run.submitted ? "submitted" : "no submit",
        profile_hash: hash,
        run_id: run.run_id,
        cost_usd: run.cost_usd,
        exit,
        ...(run.error ? { error: run.error } : {}),
      });
      return { run, exit };
    };

    // -- edit: INV, then DOM --
    const inv = await sessionStage("inv", [refRun], {});
    if (stopped()) return;
    const dom = await sessionStage("dom", [refRun], {});
    if (stopped()) return;

    // -- probe each candidate that differs from H (D-216) --
    const runs: EvidenceRun[] = [refRun];
    const candidates: { label: string; diff: string; notes: string[] }[] = [];
    const edits = new Map<"inv" | "dom", StageResult>();
    for (const [label, s] of [["inv", inv], ["dom", dom]] as const) {
      const notes = (s.value as EditorSubmission | null)?.notes ?? [];
      if (s.decision === "EDIT" && s.candidate !== undefined) {
        edits.set(label, s);
        const name = `${id}-${label}`;
        installProfile(home, s.candidate.dir, name);
        installed.add(name);
        const { run } = await runStage(`probe-${label}`, name, s.candidate.check.profile_hash, false);
        if (stopped()) return;
        if (run.record !== null) runs.push({ taskId: id, label: label as RunLabel, record: run.record });
        candidates.push({ label, diff: await diffProfiles(H.path, s.candidate.dir), notes });
      } else {
        stages[`probe-${label}`] = { decision: "not run: the candidate keeps the base", profile_hash: H.profile_hash, run_id: null, cost_usd: 0, exit: null };
        candidates.push({ label, diff: "", notes: [...notes, `This candidate keeps the base${s.fell_back ? " (its session was invalid twice)" : ""}, so it was not run: its probe is ref.`] });
      }
    }
    if (edits.size === 0) return void (st.reason = "both editors kept the base");

    // -- compose --
    const comp = await sessionStage("compose", runs, { candidates });
    if (stopped()) return;
    const c = comp.value as ComposerSubmission | null;
    let composedDir: string | null = null;
    let composed: { hash: string | null; changed: string[] } = { hash: null, changed: [] };
    if (comp.decision === "ADOPT" && c?.adopt) {
      const from = edits.get(c.adopt)?.candidate;
      if (from !== undefined) {
        composedDir = join(tdir, "profiles", `${id}-composed`);
        cpSync(from.dir, composedDir, { recursive: true });
        composed = { hash: from.check.profile_hash, changed: from.check.changed };
      }
    } else if ((comp.decision === "MERGE" || comp.decision === "REVISE") && comp.candidate !== undefined) {
      composedDir = join(tdir, "profiles", `${id}-composed`);
      cpSync(comp.candidate.dir, composedDir, { recursive: true });
      composed = { hash: comp.candidate.check.profile_hash, changed: comp.candidate.check.changed };
    }
    if (composedDir === null) return void (st.reason = "the composer kept the base");

    // -- the composed run, and its test --
    const composedName = `${id}-composed`;
    installProfile(home, composedDir, composedName);
    installed.add(composedName);
    const { run: final, exit: composedExit } = await runStage("composed", composedName, composed.hash, testCmd !== "");
    if (stopped()) return;
    const delivered = final.infra_kind === null && final.submitted && (task.mode === "read" || hasDiff(final.record));
    let refExit: number | null = null;
    if (testCmd !== "" && delivered) {
      // the reference's test, in a copy of the snapshot with the user's diff applied (D-218)
      const wc = await workCopy(task.snapshot!, join(workRoot, "ref"), typeof ref.diff === "string" ? ref.diff : "");
      try {
        if (!wc.applied) testRule = "skipped: the reference's diff did not apply to the snapshot";
        else {
          refExit = (await runTest(testCmd, wc.cwd, { log: join(tdir, "tests", "ref.log"), ...(deps.testTimeoutS !== undefined ? { timeoutS: deps.testTimeoutS } : {}) })).exit;
          testRule = "applied";
        }
      } finally {
        await wc.remove();
      }
      stages.ref = { ...stages.ref, exit: refExit };
    }
    if (stopped()) return;

    // -- reflect: only with the library on and a delivered composed run --
    if (library && delivered) {
      const reflectRuns = final.record !== null ? [...runs, { taskId: id, label: "composed" as const, record: final.record }] : runs;
      const refl = await sessionStage("reflect", reflectRuns, { candidates, composedDiff: await diffProfiles(H.path, composedDir) });
      if (stopped()) return;
      const record = refl.value as ReflectorSubmission | null;
      writeFileSync(join(tdir, "reflect.json"), `${JSON.stringify(record ?? { entry: "NO_ENTRY", edits: [], fell_back: true }, null, 2)}\n`);
      if (record !== null) {
        try {
          const wrote = addEntry(libraryDir(home), domain, id, record.entry, record.edits, composedDir);
          stages.reflect = { ...stages.reflect, library_entry: wrote ? `${domain}/entries/${id}` : null };
        } catch (err) {
          stages.reflect = { ...stages.reflect, library_error: message(err) };
          onEvent({ type: "note", id, text: `/tune: the library entry was not written: ${message(err)}`, tone: "dim" });
        }
      }
    }

    // -- delivery (D-218, D-231) --
    if (!delivered) {
      st.reason = final.infra_kind !== null ? `the composed run had an infra error (${final.infra_kind})` : "the composed run delivered nothing";
      return;
    }
    if (testRule === "applied" && refExit === 0 && composedExit !== 0) {
      st.reason = `tune.test passed on the reference and failed on the composed run (exit ${composedExit ?? "none"})`;
      return;
    }
    const name = tunedName(home, now());
    const path = installProfile(home, composedDir, name);
    mkdirSync(tuneDir(home), { recursive: true });
    appendFileSync(
      join(tuneDir(home), "tuned.jsonl"),
      `${JSON.stringify({ name, base: H.name, base_hash: H.profile_hash, profile_hash: composed.hash, run_id: task.runId, changed: composed.changed, at: now().toISOString() })}\n`,
    );
    st.kept = { name, path, base: H.name, changed: composed.changed };
    st.outcome = "kept";
    onEvent({ type: "kept", id, name, base: H.name, changed: composed.changed, path });
  };

  try {
    await body();
  } catch (err) {
    st.outcome = "error";
    st.reason = `the tune failed: ${message(err)}`;
  } finally {
    const stop = stopped();
    if (stop !== null && st.outcome !== "kept") {
      st.outcome = stop;
      st.reason = stop === "account" ? accountStopMessage(accountStop!, "the tune stopped", true) : stop === "capped" ? `the $${budget.max_usd.toFixed(2)} cap was reached` : "the tune was cancelled";
    }
    deps.signal?.removeEventListener("abort", onAbort);
    watcher.dispose();
    cap.dispose();
    uninstallProfiles(home, installed);
    removeQuietly(workRoot);
    await task.snapshot?.remove().catch(() => {});
    allocated.delete(id);
    const tuneJson = {
      id,
      run_id: task.runId,
      mode: task.mode,
      base: task.profile,
      base_hash: baseHash,
      root: task.root,
      sub: task.sub,
      tuning,
      permission_mode: permissionMode,
      library,
      domain,
      test: testCmd === "" ? null : testCmd,
      test_rule: testRule,
      stages,
      outcome: st.outcome,
      reason: st.reason,
      kept: st.kept === null ? null : { name: st.kept.name, changed: st.kept.changed },
      account_stop: accountStop,
      cap_usd: budget.max_usd,
      spent_before_usd: budget.spent_usd,
      cost_usd: round6(cap.total),
      started: startedAt.toISOString(),
      finished: now().toISOString(),
    };
    writeFileSync(join(tdir, "tune.json"), `${JSON.stringify(tuneJson, null, 2)}\n`);
  }
  return { id, outcome: st.outcome, reason: st.reason, kept: st.kept, cost_usd: round6(cap.total), account_stop: accountStop, tune_dir: tdir };
}

// -- the queue --

/** Writes `tune.enabled = false` to settings.toml: TuneQueue's default `turnOff`. */
export function turnOffInFile(home: string): void {
  saveSettings(home, setSetting(loadSettings(home), "tune.enabled", false));
}

/**
 * One task tuned at a time; at most one waits (D-231). `offer` starts a task, queues it, or skips it with
 * TUNE_BUSY; a waiting task starts when the running one ends, only if its run's profile is still the active one.
 * The cap: what `/tune` spent since online.json's `on_since` is summed from the run logs here and kept as it grows;
 * each task gets `tune.max_usd` minus that. When the cap or an account stop ends a task, the waiting task is dropped,
 * `turnOff` runs and an `off` event carries the note. Skipped and dropped tasks have their snapshots removed.
 */
export class TuneQueue {
  private current: { task: TuneTask; stage: OnlineStage | null; ac: AbortController; done: Promise<void> } | null = null;
  private waiting: TuneTask | null = null;
  private spent: number;
  private live = 0;
  private halted = false;
  private readonly idlers: (() => void)[] = [];

  constructor(
    private readonly deps: TuneDeps,
    private readonly onEvent: (e: TuneEvent) => void = () => {},
  ) {
    this.spent = spentSince(deps.home, readOnline(deps.home)?.on_since ?? null);
  }

  /** Sums the spend again from the run logs (after `/tune on` wrote a new online.json). */
  resync(): void {
    this.spent = spentSince(this.deps.home, readOnline(this.deps.home)?.on_since ?? null);
    this.emitState();
  }

  state(): QueueState {
    const c = this.current;
    return {
      running: c === null ? null : { id: c.task.id, mode: c.task.mode, stage: c.stage },
      waiting: this.waiting === null ? null : { id: this.waiting.id, mode: this.waiting.mode },
      spent_usd: round6(this.spent + this.live),
      cap_usd: this.deps.settings().tune.max_usd,
    };
  }

  /** Starts `task`, queues it, or skips it (busy, or tuning is off). */
  offer(task: TuneTask): "started" | "waiting" | "skipped" {
    if (!this.deps.settings().tune.enabled) {
      this.drop(task, null);
      return "skipped";
    }
    if (this.current !== null) {
      if (this.waiting !== null) {
        this.drop(task, TUNE_BUSY);
        return "skipped";
      }
      this.waiting = task;
      this.emitState();
      return "waiting";
    }
    return this.start(task) ? "started" : "skipped";
  }

  /**
   * `/tune off` and quitting: cancels the task in flight (it keeps nothing) and drops the waiting one, without the
   * cap note. Resolves once the cancelled task has cleaned up.
   */
  async cancel(_why: "off" | "quit" = "off"): Promise<{ cancelled: string | null; dropped: string | null }> {
    const dropped = this.waiting?.id ?? null;
    if (this.waiting !== null) {
      const w = this.waiting;
      this.waiting = null;
      this.drop(w, null);
    }
    const c = this.current;
    if (c === null) {
      this.emitState();
      return { cancelled: null, dropped };
    }
    this.halted = true;
    c.ac.abort();
    try {
      await c.done;
    } finally {
      this.halted = false;
    }
    return { cancelled: c.task.id, dropped };
  }

  /** Resolves when no task runs or waits. */
  idle(): Promise<void> {
    if (this.current === null && this.waiting === null) return Promise.resolve();
    return new Promise((resolve) => this.idlers.push(resolve));
  }

  private emitState(): void {
    this.onEvent({ type: "state", state: this.state() });
    if (this.current === null && this.waiting === null) for (const f of this.idlers.splice(0)) f();
  }

  private drop(task: TuneTask, note: string | null): void {
    if (note !== null) this.onEvent({ type: "note", id: task.id, text: note, tone: "dim" });
    void task.snapshot?.remove().catch(() => {});
    allocated.delete(task.id);
  }

  private async turnOff(reason: "cap" | "account", text: string): Promise<void> {
    try {
      await (this.deps.turnOff ?? (() => turnOffInFile(this.deps.home)))();
    } catch (err) {
      this.onEvent({ type: "note", id: null, text: `/tune: could not turn tuning off: ${message(err)}`, tone: "warn" });
    }
    this.onEvent({ type: "off", reason, text });
  }

  private start(task: TuneTask): boolean {
    const max = this.deps.settings().tune.max_usd;
    if (this.spent >= max - 1e-12) {
      this.drop(task, null);
      void this.turnOff("cap", capNote(max));
      this.emitState();
      return false;
    }
    const ac = new AbortController();
    const entry: { task: TuneTask; stage: OnlineStage | null; ac: AbortController; done: Promise<void> } = { task, stage: null, ac, done: Promise.resolve() };
    this.current = entry;
    this.live = 0;
    this.onEvent({ type: "task", id: task.id, phase: "start" });
    this.emitState();
    const forward = (e: TuneEvent) => {
      if (e.type === "stage") {
        entry.stage = e.phase === "start" ? e.stage : entry.stage;
        this.onEvent(e);
        if (e.phase === "start") this.emitState();
        return;
      }
      if (e.type === "spend") {
        this.live = e.spent_usd - this.spent;
        this.onEvent({ ...e, spent_usd: round6(this.spent + this.live) });
        return;
      }
      this.onEvent(e);
    };
    entry.done = tuneTask(task, { ...this.deps, budget: { spent_usd: this.spent, max_usd: max }, signal: ac.signal }, forward)
      .catch((err): TaskResult => ({ id: task.id, outcome: "error", reason: message(err), kept: null, cost_usd: this.live, account_stop: null, tune_dir: join(tuneDir(this.deps.home), task.id) }))
      .then(async (result) => {
        this.spent = round6(this.spent + result.cost_usd);
        this.live = 0;
        this.current = null;
        this.onEvent({ type: "task", id: task.id, phase: "end", result });
        if (result.outcome === "skipped" || result.outcome === "error") this.onEvent({ type: "note", id: task.id, text: `/tune: ${result.reason ?? result.outcome}`, tone: "dim" });
        if (result.outcome === "capped" || result.outcome === "account") {
          const w = this.waiting;
          this.waiting = null;
          if (w !== null) this.drop(w, null);
          await this.turnOff(result.outcome === "capped" ? "cap" : "account", result.outcome === "capped" ? capNote(max) : accountNote(result.account_stop ?? "no_credit"));
        }
        this.next();
      });
    return true;
  }

  private next(): void {
    const w = this.waiting;
    this.waiting = null;
    if (w !== null && !this.halted) {
      const s = this.deps.settings();
      if (!s.tune.enabled) this.drop(w, null);
      else if (s.profile !== w.profile) this.drop(w, PROFILE_GONE);
      else if (this.start(w)) return;
    } else if (w !== null) this.drop(w, null);
    this.emitState();
  }
}
