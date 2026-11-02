// KV cache: none
// An eval set folder (v1 architecture §6.1 to §6.3, D-169, D-225): `loadSet` reads and checks it, and
// `selectTasks` picks the tasks one eval runs. Every problem is listed together, and nothing starts
// while there is one. Step 1's `check` covers the same ground in Python; this is the definition.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkGrading } from "./reward.ts";

export type Track = "python" | "web" | "kernel" | "research" | "search";
export type Split = "tune" | "heldout";
export type Size = "R" | "S" | "M" | "L";

export const TRACKS: readonly Track[] = ["python", "web", "kernel", "research", "search"];
export const REPO_TRACKS: readonly Track[] = ["python", "web", "kernel"];
const PERMISSION_MODES = ["default", "accept-edits", "bypass"];

export interface Manifest {
  format: 1;
  name: string;
  created: string;
  builder: { repo: string; commit: string; dirty: boolean };
  permission_mode: "default" | "accept-edits" | "bypass";
  validated: boolean;
  kernel_validated_on: string[];
  counts: Record<string, number>;
  tasks_sha256: string;
  grades_sha256: string;
}

interface TaskBase {
  id: string;
  track: Track;
  split: Split;
  size: Size;
}

export interface ReadTask extends TaskBase {
  kind: "read";
  question: string;
  /** Paths relative to the set folder. */
  input: string[];
}

export interface RepoTask extends TaskBase {
  kind: "repo";
  task: string;
  base: string;
  venv?: string;
  node_env?: string;
  test_hint: string;
  requires?: string[];
}

export type EvalTask = ReadTask | RepoTask;

export interface AnswerGrade {
  id: string;
  grader: "answer";
  gold: unknown;
  grading: Record<string, unknown>;
  pass_score?: number;
}

export interface TestsGrade {
  id: string;
  grader: "tests";
  runner: "pytest" | "playwright";
  hidden: string;
  f2p: string[];
  p2p: string[];
  files: string[];
  timeout_s: number;
}

export type Grade = AnswerGrade | TestsGrade;

export interface VenvSpec {
  python: string;
  requirements: string[];
  import_root: "." | "src";
}

export interface NodeEnvSpec {
  node: string;
  pnpm: string;
  playwright: string;
}

export interface EvalSet {
  /** The set folder, absolute. */
  dir: string;
  manifest: Manifest;
  /** In file order. */
  tasks: EvalTask[];
  grades: Map<string, Grade>;
  venvs: Map<string, VenvSpec>;
  nodeEnvs: Map<string, NodeEnvSpec>;
  /** The raw bytes of `venvs/<key>.json`, whose sha256 marks a built venv. */
  venvBytes: Map<string, Uint8Array>;
}

/** Every problem `loadSet` found, one per line in `message`. */
export class SetError extends Error {
  readonly problems: string[];

  constructor(dir: string, problems: string[]) {
    super(`${dir} is not a valid eval set:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    this.name = "SetError";
    this.problems = problems;
  }
}

export const sha256 = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** JSON lines split on `\n` only, so a U+2028 inside a string stays in its line (as step 1 writes them). */
function jsonLines(text: string, file: string, problems: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      const v = JSON.parse(line);
      if (isObj(v)) out.push(v);
      else problems.push(`${file}:${i + 1}: not a JSON object`);
    } catch (err) {
      problems.push(`${file}:${i + 1}: not valid JSON (${(err as Error).message})`);
    }
  });
  return out;
}

/** A set-relative path's problem, or null: relative, no `..`, no drive letter, inside the set, and present. */
function pathProblem(dir: string, p: unknown, kind: "file" | "dir" = "file"): string | null {
  if (typeof p !== "string" || p === "") return "is not a path";
  if (/^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)) return `${JSON.stringify(p)} is not relative`;
  if (p.split(/[\\/]/).some((part) => part === "..")) return `${JSON.stringify(p)} has a .. part`;
  const full = resolve(dir, p);
  if (!full.startsWith(resolve(dir))) return `${JSON.stringify(p)} is outside the set`;
  try {
    const st = statSync(full);
    if (kind === "file" ? !st.isFile() : !st.isDirectory()) return `${JSON.stringify(p)} is not a ${kind}`;
  } catch {
    return `${JSON.stringify(p)} does not exist`;
  }
  return null;
}

/** The id prefix of a set: its name, or `fx` for the test fixture (D-225). */
export function idPrefix(name: string): string {
  return name.startsWith("harness-eval-fixture") ? "fx" : name;
}

/** Reads and checks a set folder. Throws SetError with every problem. */
export function loadSet(dirIn: string): EvalSet {
  const dir = resolve(dirIn);
  const problems: string[] = [];
  const read = (name: string): Uint8Array | null => {
    try {
      return new Uint8Array(readFileSync(join(dir, name)));
    } catch {
      problems.push(`${name} is missing`);
      return null;
    }
  };
  const manifestBytes = read("manifest.json");
  const tasksBytes = read("tasks.jsonl");
  const gradesBytes = read("grades.jsonl");
  if (manifestBytes === null || tasksBytes === null || gradesBytes === null) throw new SetError(dir, problems);

  let manifest: Manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch (err) {
    throw new SetError(dir, [`manifest.json is not valid JSON (${(err as Error).message})`]);
  }
  if (!isObj(manifest)) throw new SetError(dir, ["manifest.json is not a JSON object"]);
  if (manifest.format !== 1) problems.push(`manifest.json: format must be 1 (got ${JSON.stringify(manifest.format)})`);
  // the name becomes the eval id, a folder under <home>/eval/work/ and out/, so it must be one plain path part
  if (typeof manifest.name !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(manifest.name)) {
    problems.push(`manifest.json: name must be letters, digits, ".", "_" and "-", not starting with "." (got ${JSON.stringify(manifest.name)})`);
  }
  if (manifest.validated !== true) problems.push("manifest.json: validated is not true (a --no-validate build can't be run)");
  if (!PERMISSION_MODES.includes(manifest.permission_mode)) {
    problems.push(`manifest.json: permission_mode must be one of ${PERMISSION_MODES.join(", ")} (got ${JSON.stringify(manifest.permission_mode)})`);
  }
  if (!isStrList(manifest.kernel_validated_on ?? [])) problems.push("manifest.json: kernel_validated_on must be a list of backends");
  if (sha256(tasksBytes) !== manifest.tasks_sha256) problems.push("tasks.jsonl: its sha256 doesn't match manifest.json's tasks_sha256");
  if (sha256(gradesBytes) !== manifest.grades_sha256) problems.push("grades.jsonl: its sha256 doesn't match manifest.json's grades_sha256");

  const prefix = idPrefix(String(manifest.name ?? ""));
  const idRe = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-([a-z]+)-([RSML])-(\\d{2,})$`);
  const tasks: EvalTask[] = [];
  const seen = new Set<string>();
  const venvKeys = new Set<string>();
  const nodeKeys = new Set<string>();
  for (const t of jsonLines(new TextDecoder().decode(tasksBytes), "tasks.jsonl", problems)) {
    const id = typeof t.id === "string" ? t.id : "";
    const bad = (text: string) => problems.push(`task ${id || "(no id)"}: ${text}`);
    if (id === "") {
      bad("id must be a non-empty string");
      continue;
    }
    if (seen.has(id)) {
      bad("the id is used twice");
      continue;
    }
    seen.add(id);
    const m = idRe.exec(id);
    if (m === null) bad(`the id doesn't read ${prefix}-<track>-<size>-<nn>`);
    else if (m[1] !== t.track || m[2] !== t.size) bad("the id's track and size differ from the task's");
    const track = t.track as Track;
    if (!TRACKS.includes(track)) {
      bad(`track must be one of ${TRACKS.join(", ")} (got ${JSON.stringify(t.track)})`);
      continue;
    }
    const kind = REPO_TRACKS.includes(track) ? "repo" : "read";
    if (t.kind !== kind) bad(`track ${track} has kind ${kind} (got ${JSON.stringify(t.kind)})`);
    if (t.split !== "tune" && t.split !== "heldout") bad(`split must be tune or heldout (got ${JSON.stringify(t.split)})`);
    const sizes = kind === "read" ? ["R"] : ["S", "M", "L"];
    if (!sizes.includes(t.size as string)) bad(`a ${kind} task's size is ${sizes.join(", ")} (got ${JSON.stringify(t.size)})`);
    if (t.requires !== undefined && !(isStrList(t.requires) && t.requires.every((r) => r === "gpu"))) {
      bad(`requires must be a list whose only value is "gpu" (got ${JSON.stringify(t.requires)})`);
    }
    const gpu = isStrList(t.requires) && t.requires.includes("gpu");
    if (track === "kernel" && !gpu) bad('a kernel task must carry requires: ["gpu"]');
    if (track !== "kernel" && gpu) bad('only kernel tasks carry requires: ["gpu"]');
    if (kind === "read") {
      if (typeof t.question !== "string") bad("question must be a string");
      if (!isStrList(t.input) || t.input.length === 0) bad("input must be a non-empty list of paths");
      else for (const p of t.input) {
        const why = pathProblem(dir, p);
        if (why !== null) bad(`input ${why}`);
      }
    } else {
      if (typeof t.task !== "string") bad("task must be a string");
      if (typeof t.test_hint !== "string") bad("test_hint must be a string");
      const why = pathProblem(dir, t.base);
      if (why !== null) bad(`base ${why}`);
      if (track === "web") {
        if (typeof t.node_env !== "string" || t.node_env === "") bad("a web task names a node_env");
        else nodeKeys.add(t.node_env);
        if (t.venv !== undefined) bad("a web task has no venv");
      } else {
        if (typeof t.venv !== "string" || t.venv === "") bad(`a ${track} task names a venv`);
        else venvKeys.add(t.venv);
        if (t.node_env !== undefined) bad(`a ${track} task has no node_env`);
      }
    }
    tasks.push(t as unknown as EvalTask);
  }

  const grades = new Map<string, Grade>();
  for (const g of jsonLines(new TextDecoder().decode(gradesBytes), "grades.jsonl", problems)) {
    const id = typeof g.id === "string" ? g.id : "";
    const bad = (text: string) => problems.push(`grade ${id || "(no id)"}: ${text}`);
    if (id === "") {
      bad("id must be a non-empty string");
      continue;
    }
    if (grades.has(id)) {
      bad("there are two grades for this id");
      continue;
    }
    grades.set(id, g as unknown as Grade);
    const task = tasks.find((t) => t.id === id);
    if (task === undefined) {
      bad("no task has this id");
      continue;
    }
    // the kind follows the track, whatever the task line says (that line has its own problem then)
    if (!REPO_TRACKS.includes(task.track)) {
      if (g.grader !== "answer") bad(`a read task's grader is answer (got ${JSON.stringify(g.grader)})`);
      if (!("gold" in g)) bad("an answer grade has a gold");
      for (const why of checkGrading(g.grading, g.gold)) bad(`grading: ${why}`);
      // training's check_grading reads neither, and score_text would crash on a bad one
      if (isObj(g.grading)) {
        for (const key of ["aliases", "ignore"]) {
          if (g.grading[key] !== undefined && g.grading[key] !== null && !isStrList(g.grading[key])) bad(`grading: ${key} must be a list of strings`);
        }
      }
      if (g.pass_score !== undefined && !(typeof g.pass_score === "number" && g.pass_score > 0 && g.pass_score <= 1)) {
        bad(`pass_score must be a number above 0 and at most 1 (got ${JSON.stringify(g.pass_score)})`);
      }
    } else {
      if (g.grader !== "tests") bad(`a repo task's grader is tests (got ${JSON.stringify(g.grader)})`);
      const runner = task.track === "web" ? "playwright" : "pytest";
      if (g.runner !== runner) bad(`a ${task.track} task's runner is ${runner} (got ${JSON.stringify(g.runner)})`);
      const why = pathProblem(dir, g.hidden);
      if (why !== null) bad(`hidden ${why}`);
      for (const key of ["f2p", "p2p", "files"]) if (!isStrList(g[key])) bad(`${key} must be a list of strings`);
      if (isStrList(g.f2p) && g.f2p.length === 0) bad("f2p is empty");
      if (!(Number.isInteger(g.timeout_s) && (g.timeout_s as number) > 0)) bad("timeout_s must be a whole number above 0");
    }
  }
  for (const t of tasks) if (!grades.has(t.id)) problems.push(`task ${t.id}: it has no grade`);

  const venvs = new Map<string, VenvSpec>();
  const venvBytes = new Map<string, Uint8Array>();
  for (const key of [...venvKeys].sort()) {
    const name = `venvs/${key}.json`;
    if (!/^[A-Za-z0-9._-]+$/.test(key) || !existsSync(join(dir, name))) {
      problems.push(`${name} is missing`);
      continue;
    }
    const bytes = new Uint8Array(readFileSync(join(dir, name)));
    let v: unknown;
    try {
      v = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      problems.push(`${name} is not valid JSON`);
      continue;
    }
    if (!isObj(v) || typeof v.python !== "string" || !isStrList(v.requirements) || (v.import_root !== "." && v.import_root !== "src")) {
      problems.push(`${name} must hold python, requirements and import_root ("." or "src")`);
      continue;
    }
    venvs.set(key, v as unknown as VenvSpec);
    venvBytes.set(key, bytes);
  }

  const nodeEnvs = new Map<string, NodeEnvSpec>();
  for (const key of [...nodeKeys].sort()) {
    const name = `nodeenvs/${key}.json`;
    if (!/^[A-Za-z0-9._-]+$/.test(key) || !existsSync(join(dir, name))) {
      problems.push(`${name} is missing`);
      continue;
    }
    let v: unknown;
    try {
      v = JSON.parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      problems.push(`${name} is not valid JSON`);
      continue;
    }
    if (!isObj(v) || typeof v.node !== "string" || typeof v.pnpm !== "string" || typeof v.playwright !== "string") {
      problems.push(`${name} must hold node, pnpm and playwright`);
      continue;
    }
    nodeEnvs.set(key, v as unknown as NodeEnvSpec);
  }
  // one pnpm and one Chromium serve the whole set
  for (const field of ["pnpm", "playwright"] as const) {
    const pins = new Set([...nodeEnvs.values()].map((e) => e[field]));
    if (pins.size > 1) problems.push(`nodeenvs: every node env must pin the same ${field} (found ${[...pins].sort().join(", ")})`);
  }

  if (problems.length > 0) throw new SetError(dir, problems);
  return { dir, manifest, tasks, grades, venvs, nodeEnvs, venvBytes };
}

export interface Selection {
  split?: "tune" | "heldout" | "all";
  only?: string[];
  sample?: number;
  seed?: string;
  /** `--gpu none`: leave out every task that requires a GPU. */
  skipGpu?: boolean;
}

export const needsGpu = (t: EvalTask): boolean => t.kind === "repo" && (t.requires ?? []).includes("gpu");
export const stratum = (t: EvalTask): string => `${t.track}/${t.size}`;

/**
 * The tasks one eval runs, in file order: by split (`all` keeps both), then `only`, then `skipGpu`, then
 * `sample` K with `seed` S, stratified by track/size (D-225): K × the stratum's share, largest remainders
 * first (ties by stratum name), and within a stratum the lowest sha256(S + ":" + id). Throws on an `only`
 * id the set doesn't have, or a sample larger than what is left.
 */
export function selectTasks(set: EvalSet, sel: Selection): EvalTask[] {
  const split = sel.split ?? "all";
  let tasks = set.tasks.filter((t) => split === "all" || t.split === split);
  if (sel.only !== undefined) {
    const unknown = sel.only.filter((id) => !set.tasks.some((t) => t.id === id));
    if (unknown.length > 0) throw new Error(`--only names tasks the set doesn't have: ${unknown.join(", ")}`);
    const wanted = new Set(sel.only);
    tasks = tasks.filter((t) => wanted.has(t.id));
  }
  if (sel.skipGpu) tasks = tasks.filter((t) => !needsGpu(t));
  if (sel.sample === undefined) return tasks;
  const k = sel.sample;
  if (sel.seed === undefined) throw new Error("--sample needs --seed");
  if (k > tasks.length) throw new Error(`--sample ${k} is more than the ${tasks.length} tasks selected`);
  const strata = new Map<string, EvalTask[]>();
  for (const t of tasks) strata.set(stratum(t), [...(strata.get(stratum(t)) ?? []), t]);
  const keys = [...strata.keys()].sort();
  const quota = new Map<string, number>();
  const rest: { key: string; frac: number }[] = [];
  let given = 0;
  for (const key of keys) {
    const exact = (k * strata.get(key)!.length) / tasks.length;
    quota.set(key, Math.floor(exact));
    given += Math.floor(exact);
    rest.push({ key, frac: exact - Math.floor(exact) });
  }
  rest.sort((a, b) => b.frac - a.frac || (a.key < b.key ? -1 : 1));
  for (const { key } of rest.slice(0, k - given)) quota.set(key, quota.get(key)! + 1);
  const picked = new Set<string>();
  for (const key of keys) {
    const ranked = strata.get(key)!.map((t) => ({ id: t.id, h: sha256(`${sel.seed}:${t.id}`) })).sort((a, b) => (a.h < b.h ? -1 : 1));
    for (const { id } of ranked.slice(0, quota.get(key)!)) picked.add(id);
  }
  return tasks.filter((t) => picked.has(t.id));
}
