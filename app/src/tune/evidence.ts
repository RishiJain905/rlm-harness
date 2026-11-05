// KV cache: none
// The evidence folder of one tuner session (v1 architecture §7.3, D-204, D-205), modelled on harness2's
// core/context.py at 6868817 (`build`, `_write_rollout`, `_WITHHELD_NOTE`, `assert_no_leak_paths`,
// `assert_no_grader_verdicts`). Records come only from an eval's runs.jsonl; nothing here ever reads
// grades.jsonl, grade-logs/ or the set's hidden/, and a run whose own text names the set folder, a hidden
// test or a grade marker is withheld rather than shown.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import type { EvalTask } from "../eval/set.ts";

/** Strings that only a grader's output holds; any of them in the evidence is a leak. */
export const GRADE_MARKERS = ["f2p_share", "test_tamper", "leak_suspect", "grade_error", "<testsuites"] as const;

/** A record key that only a grade line or grades.jsonl carries. */
const GRADE_KEYS = ["gold", "f2p", "p2p", "grading", "pass", "f2p_share"];

export const WITHHELD = "(withheld by the evidence guard)";
const DELIVERABLE_MAX = 60_000;
const ANSWER_HEAD = 200;

export class EvidenceLeak extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceLeak";
  }
}

export type Stage = "inv" | "dom" | "compose" | "reflect";
export type RunLabel = "ref" | "inv" | "dom" | "composed";

/** What the guard looks for in a run's own text; offline.ts builds it from the set (it alone reads grades). */
export interface Secrets {
  setDir: string;
  /** The hidden tars' members, as `/` paths. */
  hiddenPaths: string[];
  /** The f2p test ids (D-253: p2p ids name tests the repository already has). */
  testIds: string[];
}

export interface EvidenceRun {
  taskId: string;
  label: RunLabel;
  record: Record<string, unknown>;
}

export interface EvidenceSpec {
  stage: Stage;
  round: number;
  attempt: number;
  /** The harness under review: its profile.toml, guidance.md, skills/ and scripts/ (agents/ and nudges.toml with gated). */
  harnessDir: string;
  gated?: boolean;
  /** Prompt v4, as the engine renders it; read-only for the session. */
  systemPrompt: string;
  /** Every task whose runs appear; each gets tasks/<id>/task.md. */
  tasks: EvalTask[];
  setDir: string;
  runs: EvidenceRun[];
  secrets: Secrets;
  /** The composer's and reflector's: each candidate's diff and its editor's notes. */
  candidates?: { label: string; diff: string; notes: string[] }[];
  /** Earlier rounds' composer notes. */
  history?: string;
  /** The tune's library root, copied whole (both domains). */
  libraryDir?: string;
  /** The reflector's: the composed profile's diff against the incumbent. */
  composedDiff?: string;
}

export interface EvidenceResult {
  dir: string;
  /** The evidence files, sorted: the session's inputs. */
  files: string[];
  withheld: { taskId: string; label: RunLabel }[];
}

const fold = (s: string) => (process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s);

/** Throws EvidenceLeak for a path under grades.jsonl, grade-logs/ or the set's hidden/ (the read boundary). */
export function guardRead(path: string, setDir?: string): void {
  const p = fold(resolve(path).replace(/\\/g, "/"));
  const parts = p.split("/");
  if (parts.includes("grade-logs") || parts[parts.length - 1] === "grades.jsonl") throw new EvidenceLeak(`the tuner never reads ${path}`);
  if (setDir !== undefined) {
    const hidden = fold(resolve(setDir, "hidden").replace(/\\/g, "/"));
    if (p === hidden || p.startsWith(`${hidden}/`)) throw new EvidenceLeak(`the tuner never reads the set's hidden tests (${path})`);
  }
}

/** A guarded text read. */
export function readGuarded(path: string, setDir?: string): string {
  guardRead(path, setDir);
  return readFileSync(path, "utf8");
}

/**
 * The tune-split records of one eval output, by task id: runs.jsonl, with rerun/runs.jsonl's records in place of
 * their originals (as readGrades prefers rerun lines). A record carrying a grade key throws.
 */
export function readRecords(out: string, ids: Set<string>): Map<string, Record<string, unknown>> {
  const byTag = new Map<string, Record<string, unknown>>();
  for (const file of [join(out, "runs.jsonl"), join(out, "rerun", "runs.jsonl")]) {
    if (!existsSync(file)) continue;
    for (const chunk of readGuarded(file).split("\n")) {
      if (chunk.trim() === "") continue;
      let r: Record<string, unknown>;
      try {
        r = JSON.parse(chunk);
      } catch {
        continue; // torn
      }
      const tag = typeof r.tag === "string" ? r.tag : null;
      if (tag === null || !ids.has(tag)) continue;
      const bad = GRADE_KEYS.filter((k) => k in r);
      if (bad.length > 0) throw new EvidenceLeak(`a run record carries ${bad.join(", ")}: it isn't from runs.jsonl`);
      byTag.set(tag, r);
    }
  }
  return byTag;
}

const str = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));
const num = (v: unknown): number => (typeof v === "number" ? v : 0);

function originTurn(origin: unknown): number | null {
  if (typeof origin === "object" && origin !== null && typeof (origin as { turn?: unknown }).turn === "number") return (origin as { turn: number }).turn;
  return null;
}

function subcallLine(s: Record<string, unknown>): string {
  const status = s.error ? `error: ${str(s.error).split("\n")[0]}` : "ok";
  const answer = str(s.output).replace(/\s+/g, " ").slice(0, ANSWER_HEAD);
  return `- sub-call ${str(s.subcall_id)}: ${str(s.prompt).length} prompt chars, ${status}${answer ? `: ${answer}` : ""}`;
}

/** One run as the sessions read it: a header, then each turn's reply, code, output and error, with its sub-calls; then children and compactions. Reasoning is left out. */
export function trajectoryText(record: Record<string, unknown>): string {
  const turns = (Array.isArray(record.turns) ? record.turns : []) as Record<string, unknown>[];
  const subcalls = (Array.isArray(record.subcalls) ? record.subcalls : []) as Record<string, unknown>[];
  const children = (Array.isArray(record.children) ? record.children : []) as Record<string, unknown>[];
  const compactions = (Array.isArray(record.compactions) ? record.compactions : []) as Record<string, unknown>[];
  const byTurn = new Map<number, Record<string, unknown>[]>();
  const loose: Record<string, unknown>[] = [];
  for (const s of subcalls) {
    const t = originTurn(s.origin);
    if (t === null) loose.push(s);
    else byTurn.set(t, [...(byTurn.get(t) ?? []), s]);
  }
  const out = [
    "# Trajectory",
    "",
    `turns: ${turns.length}`,
    `sub-calls: ${subcalls.length}`,
    `submitted: ${record.submitted === true ? "yes" : "no"}`,
    `infra: ${record.infra_kind === null || record.infra_kind === undefined ? "none" : str(record.infra_kind)}`,
  ];
  for (const t of turns) {
    const n = num(t.turn);
    out.push("", `## Turn ${n}`);
    const reply = str(t.reply).trim();
    if (reply) out.push("", "### Reply", "", reply);
    const code = str(t.code);
    if (code) out.push("", "### Code", "", "```python", code.replace(/\n$/, ""), "```");
    const output = str(t.stdout);
    if (output) out.push("", "### Output", "", "```", output.replace(/\n$/, ""), "```");
    if (t.error) out.push("", "### Error", "", "```", str(t.error).replace(/\n$/, ""), "```");
    const calls = byTurn.get(n) ?? [];
    if (calls.length > 0) out.push("", "### Sub-calls", "", ...calls.map(subcallLine));
  }
  if (loose.length > 0) out.push("", "## Sub-calls outside a turn", "", ...loose.map(subcallLine));
  if (children.length > 0) {
    out.push("", "## Child runs (rlm)");
    for (const c of children) {
      out.push(
        "",
        `- child ${str(c.child_id)} (depth ${str(c.depth)}, tools ${str(c.tools)}): ${num(c.turns)} turns, ${c.submitted ? "submitted" : "not submitted"}${c.error ? `, error: ${str(c.error).split("\n")[0]}` : ""}`,
        `  task: ${str(c.task).replace(/\s+/g, " ").slice(0, 400)}`,
        `  answer: ${str(c.answer).replace(/\s+/g, " ").slice(0, ANSWER_HEAD)}`,
      );
    }
  }
  if (compactions.length > 0) {
    out.push("", "## Compactions", "");
    for (const c of compactions) out.push(`- turn ${str(c.turn)}: ${str(c.before_tokens)} -> ${str(c.after_tokens)} tokens, ${str(c.dropped_messages)} messages dropped`);
  }
  return `${out.join("\n")}\n`;
}

/** The record's diff (repo) or its answer as JSON (read), cut at 60,000 characters with a marker. */
export function deliverableText(record: Record<string, unknown>): string {
  const text = record.mode === "repo" ? str(record.diff) || "(no diff)" : record.submitted === true ? JSON.stringify(record.answer) : "(no answer submitted)";
  return text.length > DELIVERABLE_MAX ? `${text.slice(0, DELIVERABLE_MAX)}\n[cut at ${DELIVERABLE_MAX.toLocaleString("en-US")} characters by the evidence writer]\n` : `${text}\n`;
}

/** What makes a run's own text unusable: the set folder, a hidden test, a test id or a marker. */
function leakIn(text: string, s: Secrets): string | null {
  const t = fold(text);
  const dir = s.setDir.replace(/[\\/]+$/, "");
  for (const d of [dir.replace(/\\/g, "/"), dir.replace(/\//g, "\\")]) if (d !== "" && t.includes(fold(d))) return "the set folder";
  for (const p of s.hiddenPaths) if (p !== "" && (t.includes(fold(p)) || t.includes(fold(p.replace(/\//g, "\\"))))) return "a hidden test path";
  for (const id of s.testIds) if (id !== "" && t.includes(fold(id))) return "a test id";
  for (const m of GRADE_MARKERS) if (t.includes(fold(m))) return "a grade marker";
  return null;
}

/** tasks/<id>/task.md: the task text as rlmh gave it; for read tasks the input names and sizes, never their contents. */
export function taskText(t: EvalTask, setDir: string): string {
  if (t.kind === "read") {
    const files = t.input.map((p) => {
      const full = join(setDir, ...p.split("/"));
      guardRead(full, setDir);
      return `- ${basename(p)}: ${statSync(full).size.toLocaleString("en-US")} bytes`;
    });
    return `# Task ${t.id} (read, ${t.track})\n\n## Question\n\n${t.question.trim()}\n\n## Input files (contents not shown)\n\n${files.join("\n")}\n`;
  }
  const tar = join(setDir, ...t.base.split("/"));
  guardRead(tar, setDir);
  const files = countTarFiles(new Uint8Array(readFileSync(tar)));
  return `# Task ${t.id} (repo, ${t.track})\n\n## Task\n\n${t.task.trim()}\n\n## Test hint\n\n${t.test_hint}\n\n## Repository\n\n${files} files\n`;
}

/** Regular files in a ustar archive, counted from the headers. */
function countTarFiles(b: Uint8Array): number {
  let n = 0;
  let at = 0;
  while (at + 512 <= b.length) {
    const h = b.subarray(at, at + 512);
    if (h.every((x) => x === 0)) break;
    const size = parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, "").trim() || "0", 8);
    const type = String.fromCharCode(h[156] ?? 48);
    if (type === "0" || type === "\0") n++;
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return n;
}

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full, base));
    else out.push(relative(base, full).split(sep).join("/"));
  }
  return out;
}

/** Throws if any file name or content under `root` holds a GRADE_MARKERS string (harness2's `assert_no_grader_verdicts`). */
export function scanTree(root: string): void {
  for (const rel of walk(root)) {
    for (const m of GRADE_MARKERS) {
      if (rel.includes(m)) throw new EvidenceLeak(`grade marker ${JSON.stringify(m)} in the evidence file name ${rel}: this is a leak, find the read that produced it`);
    }
    const body = readFileSync(join(root, ...rel.split("/")), "utf8");
    for (const m of GRADE_MARKERS) {
      const at = body.indexOf(m);
      if (at >= 0) throw new EvidenceLeak(`grade marker ${JSON.stringify(m)} in ${rel} at offset ${at}: this is a leak, find the read that produced it`);
    }
  }
}

/** Copies the library root (both domains) to `<dest>`. */
export function copyLibrary(root: string, dest: string): boolean {
  if (!existsSync(root) || readdirSync(root).length === 0) return false;
  cpSync(root, dest, { recursive: true });
  return true;
}

const HARNESS_EXTRAS = ["skills", "scripts"];
const GATED_EXTRAS = ["agents", "nudges.toml"];

/** Writes one session's evidence into `dir` (replacing it) and returns its files; throws EvidenceLeak (D-205). */
export function writeEvidence(dir: string, spec: EvidenceSpec): EvidenceResult {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const write = (rel: string, text: string) => {
    const full = join(dir, ...rel.split("/"));
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, text.replace(/\r\n/g, "\n"));
  };
  write("stage.md", `stage: ${spec.stage}\nround: ${spec.round}\nattempt: ${spec.attempt}\n`);
  write("harness/profile.toml", readFileSync(join(spec.harnessDir, "profile.toml"), "utf8"));
  write("harness/guidance.md", readFileSync(join(spec.harnessDir, "guidance.md"), "utf8"));
  if (existsSync(join(spec.harnessDir, "system.md"))) write("harness/system.md", readFileSync(join(spec.harnessDir, "system.md"), "utf8"));
  write("harness/system_prompt.md", spec.systemPrompt);
  for (const name of [...HARNESS_EXTRAS, ...(spec.gated ? GATED_EXTRAS : [])]) {
    const from = join(spec.harnessDir, name);
    if (!existsSync(from)) continue;
    if (statSync(from).isDirectory()) {
      for (const rel of walk(from)) if (!rel.includes("__pycache__") && !rel.endsWith(".pyc")) write(`harness/${name}/${rel}`, readFileSync(join(from, ...rel.split("/")), "utf8"));
    } else write(`harness/${name}`, readFileSync(from, "utf8"));
  }
  const tasks = new Map(spec.tasks.map((t) => [t.id, t]));
  const withheld: EvidenceResult["withheld"] = [];
  let shown = 0;
  for (const id of [...new Set(spec.runs.map((r) => r.taskId))].sort()) {
    const t = tasks.get(id);
    if (t === undefined) throw new Error(`no task ${id} for the evidence`);
    write(`tasks/${id}/task.md`, taskText(t, spec.setDir));
  }
  for (const run of spec.runs) {
    const bad = GRADE_KEYS.filter((k) => k in run.record);
    if (bad.length > 0) throw new EvidenceLeak(`a run record carries ${bad.join(", ")}: it isn't from runs.jsonl`);
    const trajectory = trajectoryText(run.record);
    const deliverable = deliverableText(run.record);
    const where = `tasks/${run.taskId}/${run.label}`;
    if (leakIn(trajectory + deliverable, spec.secrets) !== null) {
      withheld.push({ taskId: run.taskId, label: run.label });
      write(`${where}/trajectory.md`, `${WITHHELD}\n`);
      write(`${where}/deliverable.md`, `${WITHHELD}\n`);
      continue;
    }
    shown++;
    write(`${where}/trajectory.md`, trajectory);
    write(`${where}/deliverable.md`, deliverable);
  }
  if (spec.runs.length > 0 && shown === 0) {
    throw new EvidenceLeak(`every run of this stage was withheld by the evidence guard (${withheld.length}): the session would adapt on nothing`);
  }
  for (const c of spec.candidates ?? []) {
    write(`candidates/${c.label}/diff.md`, c.diff === "" ? "(no change from the incumbent)\n" : c.diff);
    write(`candidates/${c.label}/notes.md`, c.notes.length === 0 ? "(no notes)\n" : `${c.notes.map((n) => `- ${n}`).join("\n")}\n`);
  }
  if (spec.composedDiff !== undefined) write("candidates/composed/diff.md", spec.composedDiff === "" ? "(no change from the incumbent)\n" : spec.composedDiff);
  write("history.md", spec.history && spec.history.trim() !== "" ? spec.history : "(no earlier rounds)\n");
  if (spec.libraryDir !== undefined) copyLibrary(spec.libraryDir, join(dir, "library"));
  scanTree(dir);
  return { dir, files: walk(dir).map((rel) => join(dir, ...rel.split("/"))), withheld };
}
