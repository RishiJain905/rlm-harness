// KV cache: none
// `rlmh tune`'s driver (v1 architecture §7.5, D-173, D-204 to D-212): budget-driven rounds of reference,
// edit (INV and DOM), probe, compose, accept and reflect over one eval set's tune split, on one Session.
// Labels are used only for acceptance: this is the only tune module that reads grades, always through
// readGrades and only `infra_kind`, `pass`, `f2p_share` and `cost_usd`. Candidates are installed into
// <home>/profiles/ only while they run, and `finally` always removes them and writes tune.json.

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunWatcher } from "../cli/run.ts";
import { TRANSIENT } from "../cli/eval.ts";
import type { Catalog } from "../gateway/catalog.ts";
import { appendLedger } from "../eval/ledger.ts";
import { readGrades, type GradeLine } from "../eval/report.ts";
import { accountStopMessage, CostCap, runEval, type EvalDeps, type EvalResult, type EvalSession } from "../eval/runner.ts";
import { estimate, referenceFrom } from "../eval/estimate.ts";
import { selectTasks, type EvalSet, type EvalTask } from "../eval/set.ts";
import { readTar } from "../eval/tar.ts";
import type { Backend } from "../eval/work.ts";
import type { ModelRef, ProfileInfo } from "../protocol.ts";
import { APP_VERSION } from "../version.ts";
import { diffProfiles, installProfile, uninstallProfiles } from "./candidate.ts";
import { readRecords, trajectoryText, writeEvidence, type EvidenceRun, type RunLabel, type Secrets, type Stage } from "./evidence.ts";
import { addEntry } from "./library.ts";
import { runSession, type ComposerSubmission, type EditorSubmission, type ReflectorSubmission, type StageResult, type TuneSession } from "./sessions.ts";

/** Infra kinds that say nothing about a profile (D-209): transient ones (rerun once) and setup ones. */
export const SETUP = ["auth", "no_key", "unknown_model", "workspace", "host_bug"];
const EXCLUDED = new Set([...TRANSIENT, ...SETUP]);

// -- acceptance (D-173, D-209) --

export interface Side {
  passed: number;
  mean_f2p_share: number | null;
  mean_cost_usd: number;
}

export interface Acceptance {
  compared: number;
  excluded: string[];
  ref: Side;
  new: Side;
  accepted: boolean;
  reason: "accepted" | "passes" | "f2p_share" | "cost" | "infra";
}

const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** D-173: at least one more pass, mean f2p_share over repo tasks not lower, mean cost at most 1.5x; D-209's exclusions. */
export function accept(ref: GradeLine[], neu: GradeLine[]): Acceptance {
  const a = new Map(ref.map((l) => [l.id, l]));
  const b = new Map(neu.map((l) => [l.id, l]));
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  const excluded = ids.filter((id) => {
    const x = a.get(id);
    const y = b.get(id);
    return x === undefined || y === undefined || (x.infra_kind !== null && EXCLUDED.has(x.infra_kind)) || (y.infra_kind !== null && EXCLUDED.has(y.infra_kind));
  });
  const kept = ids.filter((id) => !excluded.includes(id));
  const side = (m: Map<string, GradeLine>): Side => {
    const lines = kept.map((id) => m.get(id)!);
    const repo = lines.filter((l) => l.kind === "repo");
    return {
      passed: lines.filter((l) => l.pass && l.infra_kind === null).length,
      mean_f2p_share: repo.length === 0 ? null : mean(repo.map((l) => l.f2p_share ?? 0)),
      mean_cost_usd: mean(lines.map((l) => l.cost_usd)),
    };
  };
  const r = side(a);
  const n = side(b);
  const base = { compared: kept.length, excluded, ref: r, new: n };
  if (excluded.length * 4 > ids.length) return { ...base, accepted: false, reason: "infra" };
  if (n.passed < r.passed + 1) return { ...base, accepted: false, reason: "passes" };
  if (r.mean_f2p_share !== null && (n.mean_f2p_share ?? 0) < r.mean_f2p_share - 1e-12) return { ...base, accepted: false, reason: "f2p_share" };
  if (n.mean_cost_usd > 1.5 * r.mean_cost_usd + 1e-12) return { ...base, accepted: false, reason: "cost" };
  return { ...base, accepted: true, reason: "accepted" };
}

// -- the estimate (task 10) --

/** Each session's fixed figures (task 10): root 0.3M in, 20K out; sub out 30K; sub in = evidence chars ÷ 3. */
const SESSION = { root_in: 300_000, root_out: 20_000, sub_out: 30_000 };

export interface StageEstimate {
  stage: string;
  runs: number;
  usd: number | null;
}

export interface RoundEstimate {
  round: number;
  stages: StageEstimate[];
  usd: number | null;
  /** Round 1 always runs; a later one only if the running total fits under the cap. */
  fits: boolean;
}

export interface TuneEstimate {
  rounds: RoundEstimate[];
  total_usd: number | null;
  default_cap_usd: number | null;
  /** The evidence characters an editor reads (E). */
  evidence_chars: number;
  unpriced: string[];
}

export interface TuneEstimateOpts {
  set: EvalSet;
  tune: EvalTask[];
  probe: EvalTask[];
  root: ModelRef;
  sub: ModelRef;
  catalog: Pick<Catalog, "get">;
  profile: Pick<ProfileInfo, "name" | "agent_api" | "limits">;
  home: string;
  /** Run logs for the token means (--tokens-from, --from's runs.jsonl, this tune's). */
  runLogs: string[];
  /** The reference eval output, for E. */
  from: string;
  rounds: number;
  cap?: number | null;
}

/** E: the trajectoryText characters of the reference runs of every tune task. */
export function evidenceChars(from: string, tune: EvalTask[]): number {
  const records = readRecords(from, new Set(tune.map((t) => t.id)));
  let n = 0;
  for (const r of records.values()) n += trajectoryText(r).length;
  return n;
}

/** Every round's stages priced: 2 × probe + the tune split in rollouts, and 4 sessions (D-212). */
export function tuneEstimate(o: TuneEstimateOpts): TuneEstimate {
  const refs = referenceFrom(o.runLogs.filter((f) => existsSync(f)), o.set);
  const priced = (tasks: EvalTask[]) => estimate(tasks, { root: o.root, sub: o.sub, catalog: o.catalog, refs, profile: o.profile, home: o.home, set: o.set });
  const probeEst = priced(o.probe);
  const tuneEst = priced(o.tune);
  const e = evidenceChars(o.from, o.tune);
  const unpriced = [...new Set([...probeEst.unpriced, ...tuneEst.unpriced])];
  const price = (ref: ModelRef) => {
    if (ref.provider === "fake") return { input: 0, output: 0 };
    const m = o.catalog.get(ref.provider, ref.model.split("@")[0]!);
    return m === undefined ? null : { input: m.price.input, output: m.price.output };
  };
  const rp = price(o.root);
  const sp = price(o.sub);
  const session = (evidence: number): number | null =>
    rp === null || sp === null ? null : (SESSION.root_in * rp.input + SESSION.root_out * rp.output + (evidence / 3) * sp.input + SESSION.sub_out * sp.output) / 1e6;
  const share = o.tune.length === 0 ? 0 : o.probe.length / o.tune.length;
  const sum = (xs: (number | null)[]) => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, x) => a + x!, 0));
  const one = (round: number): Omit<RoundEstimate, "fits"> => {
    const stages: StageEstimate[] = [
      { stage: "inv session", runs: 1, usd: session(e) },
      { stage: "dom session", runs: 1, usd: session(e) },
      { stage: "probe inv", runs: o.probe.length, usd: probeEst.total_usd },
      { stage: "probe dom", runs: o.probe.length, usd: probeEst.total_usd },
      { stage: "compose session", runs: 1, usd: session(3 * e * share) },
      { stage: "accept (tune split)", runs: o.tune.length, usd: tuneEst.total_usd },
      { stage: "reflect session", runs: 1, usd: session(2 * e) },
    ];
    return { round, stages, usd: sum(stages.map((s) => s.usd)) };
  };
  const rounds = Array.from({ length: Math.max(1, o.rounds) }, (_, i) => one(i + 1));
  const total = sum(rounds.map((r) => r.usd));
  const cap = o.cap ?? (total === null ? null : 2 * total);
  let running = 0;
  const withFits = rounds.map((r) => {
    running += r.usd ?? 0;
    return { ...r, fits: r.round === 1 || (cap !== null && r.usd !== null && running <= cap + 1e-12) };
  });
  return { rounds: withFits, total_usd: total, default_cap_usd: total === null ? null : 2 * total, evidence_chars: e, unpriced };
}

const money = (x: number | null) => (x === null ? "unpriced" : `$${x.toFixed(2)}`);

export function renderTuneEstimate(e: TuneEstimate, o: { base: string; name: string; root: ModelRef; sub: ModelRef; probe: number; tune: number; cap: number | null; ledgerTotal: number; ledgerCap: number }): string {
  const lines = [
    `plan: tune ${o.base} into ${o.name}, root ${o.root.provider}/${o.root.model}, sub ${o.sub.provider}/${o.sub.model}`,
    `probe: ${o.probe} of ${o.tune} tune tasks; sessions read ${e.evidence_chars.toLocaleString("en-US")} characters of evidence each (E)`,
    "",
    "| round | stage | runs | cost |",
    "|---|---|---|---|",
    ...e.rounds.flatMap((r) => r.stages.map((s) => `| ${r.round} | ${s.stage} | ${s.runs} | ${money(s.usd)} |`)),
    "",
    ...e.rounds.map((r) => `round ${r.round}: ${money(r.usd)}${r.round === 1 ? " (always runs)" : r.fits ? " (fits under the cap)" : " (over the cap: would not run)"}`),
    `estimate: ${money(e.total_usd)}`,
    `cap: ${o.cap === null ? "none yet (an unpriced model needs --max-usd before --go)" : `$${o.cap.toFixed(2)}`} for the whole tune`,
    `ledger: $${o.ledgerTotal.toFixed(2)} spent of $${o.ledgerCap} so far`,
    ...(e.unpriced.length > 0 ? [`unpriced: ${e.unpriced.join(", ")} (--go needs an explicit --max-usd)`] : []),
    "",
    "Nothing was run and nothing was spent. Add --go to run.",
  ];
  return `${lines.join("\n")}\n`;
}

// -- the tune --

export interface TuneOptions {
  home: string;
  set: EvalSet;
  /** The base profile as engine.info lists it. */
  base: ProfileInfo;
  name: string;
  root: ModelRef;
  sub: ModelRef;
  callFormat?: string;
  /** The reference eval output (round 1's), --from. */
  from: string;
  rounds: number;
  probe: number;
  seed: string;
  jobs: number;
  out: string;
  maxUsd: number;
  gated: boolean;
  gpu?: Backend | "none";
  tokensFrom: string[];
  estimate: TuneEstimate;
  harnessCommit: string | null;
  /** --continue: the finished tune.json being continued. */
  resume?: Record<string, unknown>;
  catalog: Pick<Catalog, "get">;
  say?: (line: string) => void;
  onStage?: (e: { round: number; stage: string; decision: string; attempts: number; fell_back: boolean; cost_usd: number }) => void;
  onRound?: (e: Record<string, unknown>) => void;
  /** The engine's system prompt text, for harness/system_prompt.md when no reference record carries one. */
  systemPrompt?: string;
}

export interface TuneDeps {
  session: TuneSession & EvalSession;
  runEval?: (o: Parameters<typeof runEval>[0], d?: EvalDeps) => Promise<EvalResult>;
  evalDeps?: EvalDeps;
  now?: () => Date;
  onInterrupt?: (fn: () => void) => () => void;
}

export interface TuneResult {
  stopped: null | "max_usd" | "interrupted" | "error";
  budget_stop: number | null;
  /** D-257: the account kind (ACCOUNT) an eval or a session ended with, which stopped the tune ("error"). */
  account_stop: string | null;
  /** Why the tune stopped with "error": an account stop's message, or what threw. */
  stop_reason: string | null;
  accepted_rounds: number[];
  final: string;
  cost_usd: number;
  tuneJson: Record<string, unknown>;
}

/**
 * What the evidence guard looks for, from the set (this module alone reads grades and hidden tars): the hidden tars'
 * members and the f2p ids. Not `files` or the p2p ids: those name tests the repository already has, which a run's own
 * `pytest -v` prints (D-253).
 */
export function secretsOf(set: EvalSet): Secrets {
  const hidden = new Set<string>();
  const ids = new Set<string>();
  for (const g of set.grades.values()) {
    if (g.grader !== "tests") continue;
    for (const id of g.f2p) ids.add(id);
    try {
      for (const e of readTar(new Uint8Array(readFileSync(join(set.dir, ...g.hidden.split("/")))))) if (e.type === "file") hidden.add(e.path);
    } catch {
      // a missing hidden tar is the eval's problem, not the guard's
    }
  }
  return { setDir: set.dir, hiddenPaths: [...hidden].sort(), testIds: [...ids].sort() };
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const systemOf = (r: Record<string, unknown> | undefined): string | null => {
  const m = Array.isArray(r?.messages) ? (r!.messages as { role?: string; content?: unknown }[])[0] : undefined;
  return m?.role === "system" && typeof m.content === "string" ? m.content : null;
};

/** Runs the tune (architecture §7.5). Never throws for a stage's own failure; tune.json is always written. */
export async function runTune(o: TuneOptions, deps: TuneDeps): Promise<TuneResult> {
  const now = deps.now ?? (() => new Date());
  const doEval = deps.runEval ?? runEval;
  const say = o.say ?? (() => {});
  const session = deps.session;
  const watcher = new RunWatcher(session.bus);
  const started = now();
  const resume = o.resume;
  const tuneId = (resume?.id as string | undefined) ?? `${o.name}-${stamp(started)}`;
  mkdirSync(o.out, { recursive: true });
  const library = join(o.out, "library");
  const tune = selectTasks(o.set, { split: "tune", skipGpu: o.gpu === "none" });
  const probeIds: string[] = (resume?.probe as { ids?: string[] } | undefined)?.ids ?? selectTasks(o.set, { split: "tune", sample: o.probe, seed: o.seed, skipGpu: o.gpu === "none" }).map((t) => t.id);
  const probe = tune.filter((t) => probeIds.includes(t.id));
  const tuneIds = new Set(tune.map((t) => t.id));
  const secrets = secretsOf(o.set);
  const installed = new Set<string>();
  const rounds: Record<string, unknown>[] = [...((resume?.rounds as Record<string, unknown>[] | undefined) ?? [])];
  let spent = Number((resume?.cost_usd as number | undefined) ?? 0);
  const startSpent = spent;
  let rollouts = 0;
  let sessions = 0;
  let rolloutUsd = 0;
  let sessionUsd = 0;
  let stopped: TuneResult["stopped"] = null;
  let budgetStop: number | null = null;
  let accountStop: string | null = null;
  let stopReason: string | null = null;
  let history = (resume?.history as string | undefined) ?? "";
  const accepted: number[] = ((resume?.accepted_rounds as number[] | undefined) ?? []).slice();

  // the incumbent: its name (for profile.check and evals), folder and latest tune-split eval
  let incumbent: { name: string; dir: string; ref: string; hash: string } = resume?.incumbent
    ? (resume.incumbent as { name: string; dir: string; ref: string; hash: string })
    : { name: o.base.name, dir: o.base.path, ref: o.from, hash: o.base.profile_hash };
  if (resume && incumbent.name !== o.base.name && !existsSync(join(o.home, "profiles", incumbent.name))) {
    // a continued tune's accepted incumbent is installed again for the rounds that follow
    installProfile(o.home, incumbent.dir, incumbent.name);
    installed.add(incumbent.name);
  }

  // the tune's own cap over every session and eval on the bus; evals carry `cap − spent` of their own
  const capUsd = o.maxUsd;
  const cap = new CostCap(session.bus, Math.max(0, capUsd - startSpent), (runId) => void session.cancel(runId).catch(() => {}), () => {
    say(`the cost passed --max-usd ($${capUsd}): stopping the tune`);
  });
  let interrupted = false;
  const offInterrupt = (deps.onInterrupt ?? ((fn) => (process.on("SIGINT", fn), () => void process.off("SIGINT", fn))))(() => {
    interrupted = true;
  });
  const track = (runId: string) => {
    cap.track(runId);
    return () => cap.untrack(runId);
  };
  /** D-257: an account kind ends the tune at once: no later stage, no rerun, no verdict and no library entry. */
  const stopForAccount = (kind: string) => {
    if (accountStop !== null) return;
    accountStop = kind;
    stopped = "error";
    stopReason = accountStopMessage(kind, "the tune stopped", true);
    say(accountStopMessage(kind, "stopping the tune; this round gets no verdict"));
  };
  const shouldStop = (): boolean => {
    if (accountStop !== null) stopped = "error";
    else if (interrupted) stopped = "interrupted";
    else if (cap.capped) stopped = "max_usd";
    return stopped !== null;
  };
  const evalSpend = (r: EvalResult) => {
    const c = r.lines.reduce((a, l) => a + l.cost_usd, 0);
    spent += c;
    rolloutUsd += c;
    rollouts += r.lines.filter((l) => l.run_id !== null).length;
    if (r.capped) stopped = "max_usd";
    if (r.interrupted) stopped = "interrupted";
    if (r.account_stop) stopForAccount(r.account_stop);
  };
  const sessionSpend = (s: StageResult) => {
    spent += s.cost_usd;
    sessionUsd += s.cost_usd;
    sessions += s.run_ids.length;
    if (s.account_stop) stopForAccount(s.account_stop);
  };
  const evalOpts = (tasks: EvalTask[], profile: string, out: string, hash: string | null = null) => ({
    home: o.home,
    set: o.set,
    tasks,
    split: "tune" as const,
    root: o.root,
    sub: o.sub,
    profile,
    ...(o.callFormat !== undefined ? { callFormat: o.callFormat } : {}),
    jobs: o.jobs,
    out,
    maxUsd: Math.max(0, capUsd - spent),
    ledger: false,
    ...(o.gpu !== undefined ? { gpu: o.gpu } : {}),
    meta: { tune: tuneId, profile_hash: hash },
    say,
  });
  /** The composed side's transient infra tasks, rerun once into `<out>/rerun/` (D-209). */
  const rerunTransient = async (out: string, profile: string): Promise<void> => {
    const again = new Set(readGrades(out).filter((l) => l.infra_kind !== null && TRANSIENT.includes(l.infra_kind)).map((l) => l.id));
    if (again.size === 0 || shouldStop()) return;
    say(`rerunning ${again.size} transient infra task(s) once`);
    evalSpend(await doEval({ ...evalOpts(tune.filter((t) => again.has(t.id)), profile, join(out, "rerun")), meta: { tune: tuneId, rerun_of: out } }, { ...deps.evalDeps, session }));
  };

  const firstRound = rounds.length + 1;
  const lastRound = Math.max(firstRound - 1, o.rounds);
  const runLogs = () => [...o.tokensFrom, join(o.from, "runs.jsonl"), ...rounds.flatMap((r) => ((r.evals as Record<string, string> | undefined) ? Object.values(r.evals as Record<string, string>).map((d) => join(d, "runs.jsonl")) : []))];
  let result!: TuneResult;
  try {
    for (let r = firstRound; r <= lastRound; r++) {
      if (shouldStop()) break;
      if (r > 1) {
        const est = tuneEstimate({ set: o.set, tune, probe, root: o.root, sub: o.sub, catalog: o.catalog, profile: o.base, home: o.home, runLogs: runLogs(), from: incumbent.ref, rounds: 1 });
        const usd = est.total_usd ?? Infinity;
        if (usd > capUsd - spent) {
          say(`round ${r} would cost about $${Number.isFinite(usd) ? usd.toFixed(2) : "?"}, more than the $${(capUsd - spent).toFixed(2)} left: the tune ends here`);
          budgetStop = r;
          break;
        }
      }
      const roundDir = join(o.out, "rounds", String(r));
      mkdirSync(join(roundDir, "profiles"), { recursive: true });
      const sessionsDir = join(roundDir, "sessions");
      const round: Record<string, unknown> = { round: r, incumbent: incumbent.name, incumbent_hash: incumbent.hash, reference: incumbent.ref, stages: {}, evals: {} };
      const stages = round.stages as Record<string, unknown>;
      const evals = round.evals as Record<string, string>;
      const roundStart = spent;
      rounds.push(round);
      const refRecords = readRecords(incumbent.ref, tuneIds);
      const systemPrompt = systemOf([...refRecords.values()][0]) ?? o.systemPrompt ?? "(the system prompt was not recorded)";
      const refRuns: EvidenceRun[] = tune.filter((t) => refRecords.has(t.id)).map((t) => ({ taskId: t.id, label: "ref", record: refRecords.get(t.id)! }));
      const stageRecord = (name: string, s: StageResult, extra: Record<string, unknown> = {}) => {
        stages[name] = { decision: s.decision, attempts: s.attempts, fell_back: s.fell_back, errors: s.errors, profile_hash: s.candidate?.check.profile_hash ?? null, changed: s.candidate?.check.changed ?? [], run_ids: s.run_ids, cost_usd: s.cost_usd, ...extra };
        o.onStage?.({ round: r, stage: name, decision: s.decision, attempts: s.attempts, fell_back: s.fell_back, cost_usd: s.cost_usd });
      };
      const stage = async (name: Stage, runs: EvidenceRun[], extra: { candidates?: { label: string; diff: string; notes: string[] }[]; composedDiff?: string; candidateName: string; tasks?: EvalTask[] }): Promise<StageResult> => {
        let built: StageResult;
        try {
          built = await runSession({
            session,
            watcher,
            stage: name,
            round: r,
            root: o.root,
            sub: o.sub,
            tag: `tune:${tuneId}:r${r}-${name}`,
            logDir: sessionsDir,
            gated: o.gated,
            incumbent: { dir: incumbent.dir, name: incumbent.name },
            candidateDir: join(roundDir, "profiles", extra.candidateName),
            track,
            evidence: (attempt) =>
              writeEvidence(join(roundDir, `evidence-${name}`), {
                stage: name,
                round: r,
                attempt,
                harnessDir: incumbent.dir,
                gated: o.gated,
                systemPrompt,
                tasks: extra.tasks ?? tune,
                setDir: o.set.dir,
                runs,
                secrets,
                ...(extra.candidates ? { candidates: extra.candidates } : {}),
                ...(extra.composedDiff !== undefined ? { composedDiff: extra.composedDiff } : {}),
                history,
                libraryDir: library,
              }),
          });
        } catch (err) {
          // the evidence writer threw (D-205): the stage keeps its base
          built = { decision: "KEEP_BASE", value: null, attempts: 0, fell_back: true, errors: [`could not build the evidence: ${(err as Error).message}`], run_ids: [], cost_usd: 0 };
        }
        sessionSpend(built);
        return built;
      };

      // -- edit: INV and DOM, side by side --
      say(`round ${r}: the INV and DOM editors`);
      const [invS, domS] = await Promise.all([
        stage("inv", refRuns, { candidateName: `${o.name}-r${r}-inv` }),
        stage("dom", refRuns, { candidateName: `${o.name}-r${r}-dom` }),
      ]);
      stageRecord("inv", invS);
      stageRecord("dom", domS);
      if (shouldStop()) break;
      const cands = (
        [
          ["inv", invS],
          ["dom", domS],
        ] as const
      ).filter(([, s]) => s.decision === "EDIT" && s.candidate !== undefined);
      if (cands.length === 0) {
        round.result = "no_candidates";
        round.cost_usd = spent - roundStart;
        o.onRound?.(round);
        continue;
      }

      // -- probe each candidate --
      const probeRecords = new Map<RunLabel, Map<string, Record<string, unknown>>>([["ref", refRecords]]);
      const candidates: { label: string; diff: string; notes: string[] }[] = [];
      for (const [label, s] of cands) {
        const name = `${o.name}-r${r}-${label}`;
        installProfile(o.home, s.candidate!.dir, name);
        installed.add(name);
        const out = join(roundDir, "evals", label);
        say(`round ${r}: probing ${label} on ${probe.length} task(s)`);
        evalSpend(await doEval(evalOpts(probe, name, out, s.candidate!.check.profile_hash), { ...deps.evalDeps, session }));
        evals[label] = out;
        if (shouldStop()) break;
        probeRecords.set(label, readRecords(out, new Set(probe.map((t) => t.id))));
        candidates.push({ label, diff: await diffProfiles(incumbent.dir, s.candidate!.dir), notes: (s.value as EditorSubmission).notes });
        if (shouldStop()) break;
      }
      if (shouldStop()) break;

      // -- compose --
      const probeRuns: EvidenceRun[] = [];
      for (const t of probe) for (const [label, recs] of probeRecords) if (recs.has(t.id)) probeRuns.push({ taskId: t.id, label, record: recs.get(t.id)! });
      say(`round ${r}: the composer`);
      const compS = await stage("compose", probeRuns, { candidates, candidateName: `${o.name}-r${r}-composed`, tasks: probe });
      const comp = compS.value as ComposerSubmission | null;
      stageRecord("compose", compS, { adopt: comp?.adopt ?? null });
      if (comp && comp.notes.length > 0) history += `## Round ${r} (${compS.decision})\n\n${comp.notes.map((n) => `- ${n}`).join("\n")}\n\n`;
      if (shouldStop()) break;
      let composedDir: string | null = null;
      let composedHash: string | null = null;
      if (compS.decision === "ADOPT" && comp?.adopt) {
        const from = cands.find(([l]) => l === comp.adopt)?.[1].candidate;
        if (from) {
          composedDir = join(roundDir, "profiles", `${o.name}-r${r}`);
          cpSync(from.dir, composedDir, { recursive: true });
          composedHash = from.check.profile_hash;
        }
      } else if ((compS.decision === "MERGE" || compS.decision === "REVISE") && compS.candidate) {
        composedDir = join(roundDir, "profiles", `${o.name}-r${r}`);
        cpSync(compS.candidate.dir, composedDir, { recursive: true });
        composedHash = compS.candidate.check.profile_hash;
      }
      if (composedDir === null) {
        round.result = "keep_base";
        round.cost_usd = spent - roundStart;
        o.onRound?.(round);
        continue;
      }

      // -- accept: the whole tune split --
      const composedName = `${o.name}-r${r}`;
      installProfile(o.home, composedDir, composedName);
      installed.add(composedName);
      const composedOut = join(roundDir, "evals", "composed");
      say(`round ${r}: the composed profile on the tune split (${tune.length} task(s))`);
      evalSpend(await doEval(evalOpts(tune, composedName, composedOut, composedHash), { ...deps.evalDeps, session }));
      evals.composed = composedOut;
      if (shouldStop()) break;
      await rerunTransient(composedOut, composedName);
      if (shouldStop()) break;
      const verdict = accept(readGrades(incumbent.ref), readGrades(composedOut));
      round.accept = verdict;
      round.composed = { name: composedName, profile_hash: composedHash };
      const before = { ...incumbent };
      if (verdict.accepted) {
        accepted.push(r);
        incumbent = { name: composedName, dir: composedDir, ref: composedOut, hash: composedHash ?? "" };
      }
      round.result = verdict.accepted ? "accepted" : "rejected";

      // -- reflect --
      const composedRecords = readRecords(composedOut, tuneIds);
      const reflectRuns = [...probeRuns, ...tune.filter((t) => composedRecords.has(t.id)).map((t) => ({ taskId: t.id, label: "composed" as const, record: composedRecords.get(t.id)! }))];
      const saved = incumbent;
      incumbent = before; // the reflector reads the harness the round started from
      say(`round ${r}: the reflector`);
      const refl = await stage("reflect", reflectRuns, { candidates, composedDiff: await diffProfiles(before.dir, composedDir), candidateName: `${o.name}-r${r}-reflect` });
      incumbent = saved;
      stageRecord("reflect", refl);
      if (refl.account_stop) break; // D-257: no library entry from a round the account stopped
      const record = refl.value as ReflectorSubmission | null;
      writeJson(join(roundDir, "reflect.json"), record ?? { entry: "NO_ENTRY", edits: [], fell_back: true });
      if (record) {
        const wrote = addEntry(library, record.domain, `${tuneId}-r${r}`, record.entry, record.edits, composedDir);
        round.library_entry = wrote ? `${record.domain}/entries/${tuneId}-r${r}` : null;
      }
      round.cost_usd = spent - roundStart;
      o.onRound?.(round);
    }
  } catch (err) {
    stopped = "error";
    stopReason ??= `the tune failed: ${(err as Error).message}`;
    say(`the tune failed: ${(err as Error).message}`);
    rounds.push({ error: (err as Error).message });
  } finally {
    offInterrupt();
    cap.dispose();
    watcher.dispose();
    if (stopped === null && interrupted) stopped = "interrupted";
    uninstallProfiles(o.home, installed);
    const finalDir = join(o.out, "final");
    rmSync(finalDir, { recursive: true, force: true });
    cpSync(incumbent.dir, finalDir, { recursive: true });
    if (accepted.length > 0 && stopped === null) {
      rmSync(join(o.home, "profiles", o.name), { recursive: true, force: true });
      installProfile(o.home, finalDir, o.name);
    }
    const prior = (resume?.counts as { rollouts?: number; sessions?: number; rollouts_usd?: number; sessions_usd?: number } | undefined) ?? {};
    const tuneJson: Record<string, unknown> = {
      id: tuneId,
      set: o.set.manifest.name,
      set_dir: o.set.dir,
      tasks_sha256: o.set.manifest.tasks_sha256,
      grades_sha256: o.set.manifest.grades_sha256,
      base: o.base.name,
      base_hash: o.base.profile_hash,
      name: o.name,
      root: o.root,
      sub: o.sub,
      probe: { k: probeIds.length, seed: (resume?.probe as { seed?: string } | undefined)?.seed ?? o.seed, ids: probeIds },
      from: o.from,
      gated: o.gated,
      harness_version: APP_VERSION,
      harness_commit: o.harnessCommit,
      estimate: o.estimate,
      cap: capUsd,
      started: (resume?.started as string | undefined) ?? started.toISOString(),
      finished: now().toISOString(),
      stopped,
      budget_stop: budgetStop,
      account_stop: accountStop,
      stop_reason: stopReason,
      rounds,
      accepted_rounds: accepted,
      incumbent,
      history,
      final: { name: accepted.length > 0 && stopped === null ? o.name : o.base.name, profile_hash: incumbent.hash, dir: finalDir },
      counts: {
        rollouts: (prior.rollouts ?? 0) + rollouts,
        sessions: (prior.sessions ?? 0) + sessions,
        rollouts_usd: Math.round(((prior.rollouts_usd ?? 0) + rolloutUsd) * 1e6) / 1e6,
        sessions_usd: Math.round(((prior.sessions_usd ?? 0) + sessionUsd) * 1e6) / 1e6,
      },
      cost_usd: Math.round(spent * 1e6) / 1e6,
    };
    writeJson(join(o.out, "tune.json"), tuneJson);
    appendLedger(o.home, {
      date: now().toISOString(),
      what: "tune",
      set: o.set.manifest.name,
      split: "tune",
      root: `${o.root.provider}/${o.root.model}`,
      profile: o.name,
      runs: rollouts + sessions,
      cost_usd: Math.round((spent - startSpent) * 1e6) / 1e6,
      out: o.out,
    });
    result = { stopped, budget_stop: budgetStop, account_stop: accountStop, stop_reason: stopReason, accepted_rounds: accepted, final: finalDir, cost_usd: Math.round(spent * 1e6) / 1e6, tuneJson };
  }
  return result;
}
