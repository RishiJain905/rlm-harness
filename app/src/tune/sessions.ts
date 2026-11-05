// KV cache: none
// One tuner session (v1 architecture §7.4, D-174, D-210): an rlmh read run on the tuning model over the
// evidence files, under the built-in `default` profile, that submits one JSON object as a string. An
// invalid submission gets one retry with the errors appended to the question, then the stage keeps its
// base, as harness2's recursion.py `_run_stage` (L141, retry text L190) and `_accept_tree` (L114) do.

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Bus } from "../bus.ts";
import { message, RunWatcher } from "../cli/run.ts";
import type { AppEvents } from "../gateway/gateway.ts";
import type { ModelRef, ProfileCheckResult, RunFinishedParams, RunStartResult } from "../protocol.ts";
import type { StartRun } from "../session.ts";
import { ACCOUNT } from "../eval/runner.ts";
import { CandidateError, filePathProblem, writeCandidate, type ProfileEdit } from "./candidate.ts";
import { GRADE_MARKERS, type EvidenceResult, type Stage } from "./evidence.ts";
import { stagePrompt } from "./prompts.ts";

/** What a stage needs of the tune's Session; tests pass a stub. */
export interface TuneSession {
  bus: Bus<AppEvents>;
  start(r: StartRun): Promise<RunStartResult>;
  cancel(runId: string): Promise<void>;
  checkProfile(path: string, base: string | null, gated?: boolean): Promise<ProfileCheckResult>;
}

export type EditorDecision = "EDIT" | "KEEP_BASE";
export type ComposerDecision = "MERGE" | "ADOPT" | "REVISE" | "KEEP_BASE";
export type Verdict = "helped" | "hurt" | "no observed effect" | "confounded";

export interface EditorSubmission extends ProfileEdit {
  decision: EditorDecision;
  notes: string[];
}

export interface ComposerSubmission extends ProfileEdit {
  decision: ComposerDecision;
  adopt: "inv" | "dom" | null;
  notes: string[];
}

export interface EditRow {
  component: string;
  candidates: string;
  change: string;
  observed: string;
  verdict: Verdict;
}

export interface LibraryEntry {
  cue: string;
  lesson: string;
  evidence: string;
  confidence: "high" | "medium" | "low";
}

export interface ReflectorSubmission {
  domain: "read" | "repo";
  entry: "NO_ENTRY" | LibraryEntry;
  edits: EditRow[];
}

export type Submission = EditorSubmission | ComposerSubmission | ReflectorSubmission;

const VERDICTS: readonly string[] = ["helped", "hurt", "no observed effect", "confounded"];
const CONFIDENCE: readonly string[] = ["high", "medium", "low"];

type Parsed<T> = { ok: true; value: T } | { ok: false; errors: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrs = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function markerIn(value: unknown): string | null {
  const text = JSON.stringify(value);
  return GRADE_MARKERS.find((m) => text.includes(m)) ?? null;
}

function editFields(o: Record<string, unknown>, errors: string[], gated: boolean): ProfileEdit {
  if (!(o.guidance === null || typeof o.guidance === "string")) errors.push("guidance must be the whole new text or null");
  if (!(o.system === undefined || o.system === null || typeof o.system === "string")) errors.push("system must be the whole new system.md or null");
  if (!isObj(o.toml)) errors.push('toml must be an object of "<table>.<key>": value');
  else {
    for (const [k, v] of Object.entries(o.toml)) {
      if (!/^[a-z_]+\.[a-z_]+$/.test(k)) errors.push(`toml key ${JSON.stringify(k)} is not <table>.<key>`);
      if (!(typeof v === "boolean" || typeof v === "number" || typeof v === "string")) errors.push(`toml ${k} must be a bool, number or string`);
    }
  }
  let files: Record<string, string | null> = {};
  if (o.files !== undefined && o.files !== null) {
    if (!isObj(o.files)) errors.push('files must be an object of "<path>": text or null');
    else {
      for (const [p, v] of Object.entries(o.files)) {
        if (!(v === null || typeof v === "string")) errors.push(`files ${JSON.stringify(p)} must be the file's text or null`);
        const problem = filePathProblem(p, gated);
        if (problem !== null) errors.push(problem);
      }
      files = o.files as Record<string, string | null>;
    }
  }
  return { guidance: (o.guidance ?? null) as string | null, system: (o.system ?? null) as string | null, toml: (isObj(o.toml) ? o.toml : {}) as Record<string, unknown>, files };
}

/** Parses a session's `answer` (a JSON string) into its stage's shape, or lists what is wrong. */
export function parseSubmission(stage: Stage, answer: unknown, o: { gated?: boolean } = {}): Parsed<Submission> {
  const gated = o.gated ?? false;
  if (typeof answer !== "string") return { ok: false, errors: ["submit one JSON object as a string: submit(json.dumps({...}))"] };
  let v: unknown;
  try {
    v = JSON.parse(answer);
  } catch {
    const pythonish = /^\s*\{\s*'/.test(answer) || /\bTrue\b|\bFalse\b|\bNone\b/.test(answer);
    return {
      ok: false,
      errors: [pythonish ? "the answer is a Python dict's str(), not JSON: build it with submit(json.dumps({...}))" : "the answer is not JSON: submit(json.dumps({...}))"],
    };
  }
  if (!isObj(v)) return { ok: false, errors: ["submit one JSON object, not a list or a value"] };
  const marker = markerIn(v);
  if (marker !== null) return { ok: false, errors: [`the submission contains ${JSON.stringify(marker)}, which only a grader's output holds; remove it`] };
  const errors: string[] = [];
  if (stage === "inv" || stage === "dom") {
    if (v.decision !== "EDIT" && v.decision !== "KEEP_BASE") errors.push('decision must be "EDIT" or "KEEP_BASE"');
    if (!isStrs(v.notes)) errors.push("notes must be a list of strings");
    const edit = editFields(v, errors, gated);
    if (stage === "dom" && Object.keys(edit.toml).length > 0) errors.push("the DOM candidate changes text only: toml must be {}");
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { decision: v.decision as EditorDecision, notes: v.notes as string[], ...edit } };
  }
  if (stage === "compose") {
    if (!["MERGE", "ADOPT", "REVISE", "KEEP_BASE"].includes(v.decision as string)) errors.push('decision must be "MERGE", "ADOPT", "REVISE" or "KEEP_BASE"');
    const adopt = v.adopt ?? null;
    if (v.decision === "ADOPT" && adopt !== "inv" && adopt !== "dom") errors.push('ADOPT needs adopt: "inv" or "dom"');
    if (v.decision !== "ADOPT" && adopt !== null) errors.push("adopt is set only with ADOPT; give null");
    if (!isStrs(v.notes)) errors.push("notes must be a list of strings");
    const edit = editFields({ guidance: null, toml: {}, ...v }, errors, gated);
    if (errors.length > 0) return { ok: false, errors };
    return { ok: true, value: { decision: v.decision as ComposerDecision, adopt: adopt as "inv" | "dom" | null, notes: v.notes as string[], ...edit } };
  }
  if (v.domain !== "read" && v.domain !== "repo") errors.push('domain must be "read" or "repo"');
  let entry: ReflectorSubmission["entry"] = "NO_ENTRY";
  if (v.entry !== "NO_ENTRY") {
    if (!isObj(v.entry)) errors.push('entry must be "NO_ENTRY" or {cue, lesson, evidence, confidence}');
    else {
      for (const k of ["cue", "lesson", "evidence"]) if (typeof v.entry[k] !== "string" || (v.entry[k] as string).trim() === "") errors.push(`entry.${k} must be a non-empty string`);
      if (!CONFIDENCE.includes(v.entry.confidence as string)) errors.push('entry.confidence must be "high", "medium" or "low"');
      entry = { cue: String(v.entry.cue), lesson: String(v.entry.lesson), evidence: String(v.entry.evidence), confidence: v.entry.confidence as LibraryEntry["confidence"] };
    }
  }
  const edits: EditRow[] = [];
  if (!Array.isArray(v.edits)) errors.push("edits must be a list of rows");
  else {
    v.edits.forEach((row, i) => {
      if (!isObj(row)) return void errors.push(`edits[${i}] must be an object`);
      for (const k of ["component", "candidates", "change", "observed"]) if (typeof row[k] !== "string") errors.push(`edits[${i}].${k} must be a string`);
      if (!VERDICTS.includes(row.verdict as string)) errors.push(`edits[${i}].verdict must be one of ${VERDICTS.map((x) => JSON.stringify(x)).join(", ")}`);
      edits.push(row as unknown as EditRow);
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { domain: v.domain as "read" | "repo", entry, edits } };
}

export interface StageResult {
  decision: string;
  value: Submission | null;
  attempts: number;
  fell_back: boolean;
  errors: string[];
  run_ids: string[];
  cost_usd: number;
  /** An editor's or composer's checked candidate folder (EDIT, MERGE, REVISE), and its check. */
  candidate?: { dir: string; check: ProfileCheckResult };
  /** D-257: the session ended with an account kind (ACCOUNT): no second attempt, and the tune stops. */
  account_stop?: string;
}

export interface SessionOpts {
  session: TuneSession;
  watcher: RunWatcher;
  stage: Stage;
  round: number;
  root: ModelRef;
  sub: ModelRef;
  tag: string;
  logDir: string;
  gated?: boolean;
  /** Writes the evidence for an attempt (stage.md carries it). */
  evidence: (attempt: number) => EvidenceResult;
  /** The profile the edit is made against: its folder, and its name for profile.check. */
  incumbent: { dir: string; name: string };
  /** Where an edit's candidate is written; one folder per attempt (`<dir>-a<n>`). */
  candidateDir: string;
  /** Called with each session's run id, so a cost cap can cancel it. */
  track?: (runId: string) => () => void;
}

/** Runs one stage: up to two attempts, then the base (`fell_back`). Never throws for a session's own failure. */
export async function runSession(o: SessionOpts): Promise<StageResult> {
  const r: StageResult = { decision: "KEEP_BASE", value: null, attempts: 0, fell_back: false, errors: [], run_ids: [], cost_usd: 0 };
  let rejected: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    r.attempts = attempt;
    const ev = o.evidence(attempt);
    const layout = ev.files.map((f) => relative(ev.dir, f).split(sep).join("/"));
    const question =
      stagePrompt(o.stage, o.round, { ...(o.gated ? { gated: true } : {}), layout }) +
      (rejected.length > 0 ? `\n# YOUR PREVIOUS ATTEMPT WAS REJECTED\n\n${rejected.map((e) => `- ${e}`).join("\n")}\n\nFix it and submit again.\n` : "");
    let f: RunFinishedParams | null;
    try {
      const { run_id } = await o.session.start({
        mode: "read",
        question,
        inputs: ev.files,
        profile: "default",
        root: o.root,
        sub: o.sub,
        permissionMode: "accept-edits",
        interactive: false,
        tag: o.tag,
        logDir: o.logDir,
      });
      r.run_ids.push(run_id);
      const untrack = o.track?.(run_id) ?? (() => {});
      try {
        f = await o.watcher.finished(run_id);
      } finally {
        untrack();
      }
    } catch (err) {
      rejected = [`the session could not start: ${message(err)}`];
      r.errors.push(...rejected);
      continue;
    }
    if (f === null) {
      r.errors.push("the engine exited during the session");
      break;
    }
    r.cost_usd += f.cost_usd;
    if (f.infra_error !== null) {
      rejected = [`the session ended with an infra error (${f.infra_kind ?? "other"}): ${f.infra_error.split("\n")[0]}`];
      r.errors.push(...rejected);
      if (f.infra_kind === "cancelled" || f.infra_kind === "capped") break;
      if (f.infra_kind !== null && ACCOUNT.includes(f.infra_kind)) {
        r.account_stop = f.infra_kind;
        break;
      }
      continue;
    }
    if (!f.submitted) {
      rejected = ["the session ended without submit(): submit your JSON object with submit(json.dumps({...}))"];
      r.errors.push(...rejected);
      continue;
    }
    const parsed = parseSubmission(o.stage, f.answer, { ...(o.gated ? { gated: true } : {}) });
    if (!parsed.ok) {
      rejected = parsed.errors;
      r.errors.push(...rejected);
      continue;
    }
    const value = parsed.value;
    const decision = "decision" in value ? value.decision : "RECORD";
    if (decision === "EDIT" || decision === "MERGE" || decision === "REVISE") {
      const dir = `${o.candidateDir}-a${attempt}`;
      let check: ProfileCheckResult;
      try {
        writeCandidate(dir, o.incumbent.dir, value as ProfileEdit, { ...(o.gated ? { gated: true } : {}) });
        check = await o.session.checkProfile(dir, o.incumbent.name, o.gated ?? false);
      } catch (err) {
        rejected = [err instanceof CandidateError ? err.message : `the edit could not be written: ${message(err)}`];
        r.errors.push(...rejected);
        continue;
      }
      if (!check.ok) {
        rejected = check.errors.length > 0 ? check.errors : ["profile.check refused the edit"];
        r.errors.push(...rejected);
        continue;
      }
      if (check.changed.length === 0) {
        // an edit that changes nothing is KEEP_BASE (harness2's _accept_tree)
        Object.assign(r, { decision: "KEEP_BASE", value, errors: r.errors });
        return r;
      }
      Object.assign(r, { decision, value, candidate: { dir, check } });
      return r;
    }
    Object.assign(r, { decision, value });
    return r;
  }
  r.decision = "KEEP_BASE";
  r.value = null;
  r.fell_back = true;
  return r;
}

/** True when `dir` is a candidate folder sessions wrote. */
export const isCandidate = (dir: string | undefined): dir is string => dir !== undefined && existsSync(join(dir, "profile.toml"));
