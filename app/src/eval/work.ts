// KV cache: none
// Throwaway work copies and the environments repo tasks test in (v1 architecture §6.4, D-172, D-176,
// D-196, D-222, D-223): a copy is a tar extracted as bytes plus one fixed `base` commit; venvs are made
// with uv, node envs fill one shared pnpm store, and one Chromium serves every web task. Every child
// process gets an env that has been through stripKeys, and keeps the proxy env and CA bundle as
// `rlmh setup`'s uv does (neither name is key-like).

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripKeys } from "../engine.ts";
import { sha256, type EvalSet, type RepoTask, type Track } from "./set.ts";
import { readTar, extractTar } from "./tar.ts";
import { isTrackTestPath, SECTIONED, touchesTestConfig } from "./testpaths.ts";

/** A built venv: its interpreter and its site-packages. */
export interface Venv {
  python: string;
  purelib: string;
}

/** A child process's result. `timedOut` means its tree was killed at the limit. */
export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs one command, no shell. Tests replace it to record calls. */
export type Runner = (argv: string[], opts: { cwd?: string; env: Record<string, string>; timeoutMs?: number; stdin?: string }) => Promise<Ran>;

/** Kills a process and everything it started: taskkill /T on Windows, the process group elsewhere. */
export function killTree(pid: number): void {
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/PID", String(pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

export const spawnRunner: Runner = async (argv, opts) => {
  let proc;
  try {
    proc = Bun.spawn({
      cmd: argv,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      env: opts.env,
      stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: process.platform !== "win32", // its own process group, so a timeout reaches its children
      windowsHide: true,
    });
  } catch (err) {
    return { code: 127, stdout: "", stderr: `could not start ${argv[0]}: ${(err as Error).message}\n`, timedOut: false };
  }
  let timedOut = false;
  const timer = opts.timeoutMs === undefined ? undefined : setTimeout(() => ((timedOut = true), killTree(proc.pid)), opts.timeoutMs);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  return { code, stdout, stderr, timedOut };
};

/** A command for a tool path: `.cmd` and `.bat` files go through `cmd /c` on Windows, as findEngine runs them. */
export function toolCommand(path: string, args: string[]): string[] {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(path) ? [process.env.ComSpec ?? "cmd", "/c", path, ...args] : [path, ...args];
}

/** The env every child of the eval gets: process.env (or `base`) through stripKeys. */
export function childEnv(base: Record<string, string | undefined> = process.env, extra: Record<string, string> = {}): Record<string, string> {
  return { ...stripKeys(base), ...extra };
}

/** Appends one command and its output to `<home>/eval/env-logs/<name>.log`, and returns the log's path. */
export function logRun(home: string, name: string, argv: string[], r: Ran): string {
  const dir = join(home, "eval", "env-logs");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.log`);
  appendFileSync(path, `$ ${argv.join(" ")}\n${r.stdout}${r.stderr}[exit ${r.code}${r.timedOut ? ", timed out" : ""}]\n\n`);
  return path;
}

/** A failed install or a missing tool, with the log that shows why; the task it stops gets `host_bug`. */
export class EnvError extends Error {
  readonly log: string | null;

  constructor(message: string, log: string | null = null) {
    super(log === null ? message : `${message} (log: ${log})`);
    this.name = "EnvError";
    this.log = log;
  }
}

// -- work copies --

/** Python's os.devnull, which git understands on every OS (Node's `\.
ul` it can't open as a config file). */
const devNull = process.platform === "win32" ? "nul" : "/dev/null";

/** workspace.py's GIT_ARGS, plus the three that make the base commit the same everywhere. */
export const GIT_ARGS = [
  "-c", "safe.directory=*", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.safecrlf=false",
  "-c", `core.hooksPath=${devNull}`, "-c", "core.autocrlf=false", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main",
  "-c", "core.filemode=false", "-c", "core.symlinks=false",
];

/** Variables that would point git at another repository or index. */
const GIT_REPO_VARS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|PREFIX)$/i;

/** git's env for work copies: keys stripped, no other repository, no user or system config (so no filters, hooks or signing), fixed names and dates. */
export function gitEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env = childEnv(base);
  for (const name of Object.keys(env)) if (GIT_REPO_VARS.test(name)) delete env[name];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "rlmh-eval",
    GIT_COMMITTER_NAME: "rlmh-eval",
    GIT_AUTHOR_EMAIL: "eval@localhost",
    GIT_COMMITTER_EMAIL: "eval@localhost",
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
  };
}

/** One git call in `dir`; throws with git's stderr when it fails. */
export async function git(dir: string, args: string[], opts: { run?: Runner; stdin?: string; allowFail?: boolean } = {}): Promise<Ran> {
  const run = opts.run ?? spawnRunner;
  const r = await run(["git", ...GIT_ARGS, ...args], { cwd: dir, env: gitEnv(), timeoutMs: 300_000, ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}) });
  if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args[0]} failed in ${dir} (exit ${r.code}): ${r.stderr.trim()}`);
  return r;
}

/** What makeWorkCopy writes to `.git/info/exclude`, so installed packages and test output are never the copy's own files. */
export const WORK_EXCLUDES = ["node_modules/", "test-results/", "playwright-report/"];

/**
 * Extracts `repos/<id>.tar` into `dir` (which must not exist or be empty) and commits it once as `base`.
 * Executable entries are marked in the index from the tar's own modes, so the commit's hash is the same on
 * every OS for the same tar. Returns the base commit's hash.
 */
export async function makeWorkCopy(set: EvalSet, task: RepoTask, dir: string, opts: { run?: Runner } = {}): Promise<string> {
  const entries = extractTar(new Uint8Array(readFileSync(join(set.dir, task.base))), dir);
  await git(dir, ["init", "-q"], opts);
  const info = join(dir, ".git", "info");
  mkdirSync(info, { recursive: true });
  writeFileSync(join(info, "exclude"), `${WORK_EXCLUDES.join("\n")}\n`);
  await git(dir, ["add", "-A"], opts);
  const exec = entries.filter((e) => e.type === "file" && e.mode & 0o111).map((e) => e.path);
  for (let i = 0; i < exec.length; i += 200) await git(dir, ["update-index", "--chmod=+x", "--", ...exec.slice(i, i + 200)], opts);
  await git(dir, ["commit", "-q", "-m", "base", "--no-verify", "--allow-empty"], opts);
  return (await git(dir, ["rev-parse", "HEAD"], opts)).stdout.trim();
}

/** Splits git's `-z` output. */
const zSplit = (s: string) => s.split("\0").filter((x) => x !== "");

/**
 * D-190: every path changed since `base` or new and untracked that is a test path for the track (or a test
 * section of a shared config file) is restored from `base`, or deleted when `base` didn't have it. Returns
 * the paths, sorted; `test_tamper` is a non-empty list.
 */
export async function revertTestPaths(dir: string, opts: { track: Track; base: string; run?: Runner }): Promise<string[]> {
  if (opts.track !== "python" && opts.track !== "kernel" && opts.track !== "web") return [];
  const track = opts.track;
  const status = zSplit((await git(dir, ["diff", "--name-status", "--no-renames", "-z", opts.base], opts)).stdout);
  const changed = new Map<string, string>(); // path -> A, D, M, T
  for (let i = 0; i + 1 < status.length; i += 2) changed.set(status[i + 1]!, status[i]!.charAt(0));
  for (const p of zSplit((await git(dir, ["ls-files", "-z", "--others", "--exclude-standard"], opts)).stdout)) changed.set(p, "?");
  const reverted: string[] = [];
  for (const [path, how] of [...changed].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const full = join(dir, ...path.split("/"));
    const inBase = how !== "A" && how !== "?";
    let hit = isTrackTestPath(track, path);
    const name = path.split("/").pop()!;
    if (!hit && Object.hasOwn(SECTIONED, name)) {
      const before = inBase ? (await git(dir, ["show", `${opts.base}:${path}`], opts)).stdout : null;
      const after = existsSync(full) ? readFileSync(full, "utf8") : null;
      hit = touchesTestConfig(path, before, after);
    }
    if (!hit) continue;
    if (inBase) await git(dir, ["checkout", opts.base, "--", path], opts);
    else rmSync(full, { force: true, recursive: true });
    reverted.push(path);
  }
  return reverted;
}

// -- venvs --

export const venvPython = (dir: string): string => (process.platform === "win32" ? join(dir, "Scripts", "python.exe") : join(dir, "bin", "python"));

const VENV_MARKER = ".rlmh-venv.json";

export interface VenvOpts {
  home: string;
  /** uv's path (findUv). */
  uv: string;
  run?: Runner;
  env?: Record<string, string | undefined>;
}

/** The venv's folder when its marker matches `venvs/<key>.json`, else null: what the estimate counts as a download. */
export function builtVenv(set: EvalSet, key: string, home: string): Venv | null {
  const dir = join(home, "eval", "venvs", key);
  try {
    const marker = JSON.parse(readFileSync(join(dir, VENV_MARKER), "utf8"));
    if (marker.sha256 === sha256(set.venvBytes.get(key)!) && typeof marker.purelib === "string") return { python: venvPython(dir), purelib: marker.purelib };
  } catch {
    // no marker, or a broken one
  }
  return null;
}

/**
 * `<home>/eval/venvs/<key>/`, made with `uv venv --python <python>` and `uv pip install -r` unless its marker
 * already holds the sha256 of `venvs/<key>.json`. Throws EnvError with the log.
 */
export async function ensureVenv(set: EvalSet, key: string, opts: VenvOpts): Promise<Venv> {
  const built = builtVenv(set, key, opts.home);
  if (built !== null) return built;
  const spec = set.venvs.get(key);
  if (spec === undefined) throw new EnvError(`the set has no venv ${key}`);
  const run = opts.run ?? spawnRunner;
  const env = childEnv(opts.env ?? process.env);
  const dir = join(opts.home, "eval", "venvs", key);
  const step = async (argv: string[], what: string): Promise<Ran> => {
    const r = await run(argv, { env, timeoutMs: 1_800_000 });
    const log = logRun(opts.home, `venv-${key}`, argv, r);
    if (r.code !== 0) throw new EnvError(`${what} failed for venv ${key} (exit ${r.code})`, log);
    return r;
  };
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(opts.home, "eval", "venvs"), { recursive: true });
  await step([opts.uv, "venv", "--python", spec.python, dir], "uv venv");
  const python = venvPython(dir);
  const tmp = mkdtempSync(join(tmpdir(), "rlmh-req-"));
  try {
    const req = join(tmp, "requirements.txt");
    writeFileSync(req, `${spec.requirements.join("\n")}\n`);
    await step([opts.uv, "pip", "install", "--python", python, "-r", req], "uv pip install");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const purelib = (await step([python, "-I", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))"], "reading purelib")).stdout.trim();
  writeFileSync(join(dir, VENV_MARKER), `${JSON.stringify({ sha256: sha256(set.venvBytes.get(key)!), purelib }, null, 2)}\n`);
  return { python, purelib };
}

// -- src-layout venvs (D-196) --

export const SRC_PTH = "rlmh-eval-src.pth";

/** A Python string literal for a path: `/` separators, every non-ASCII character escaped, since 3.12 reads `.pth` files in the locale encoding. */
export function pyLiteral(path: string): string {
  let out = "";
  for (const ch of path.replace(/\\/g, "/")) {
    const cp = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x80) out += ch;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return `"${out}"`;
}

/** `<purelib>/rlmh-eval-src.pth`: one line that puts `<copy>/src` on sys.path. A file a crashed eval left is overwritten. */
export function writeSrcPth(venv: Venv, copy: string): void {
  writeFileSync(join(venv.purelib, SRC_PTH), `import sys; sys.path.append(${pyLiteral(`${resolve(copy)}/src`)})\n`);
}

export function removeSrcPth(venv: Venv): void {
  try {
    unlinkSync(join(venv.purelib, SRC_PTH));
  } catch {
    // already gone
  }
}

// -- the test hint --

const quoted = (p: string) => {
  const s = p.replace(/\\/g, "/");
  return /\s/.test(s) ? `"${s}"` : s;
};

/** `{python}` and `{pnpm}` filled with absolute paths written with `/` (D-17), double-quoted when they hold a space. */
export function fillHint(hint: string, tools: { python?: string; pnpm?: string }): string {
  let out = hint;
  if (tools.python !== undefined) out = out.replaceAll("{python}", quoted(resolve(tools.python)));
  if (tools.pnpm !== undefined) out = out.replaceAll("{pnpm}", quoted(resolve(tools.pnpm)));
  return out;
}

// -- Node, pnpm and Playwright (D-222) --

export type NodeTools =
  | { ok: true; node: string; pnpm: string; nodeVersion: string; pnpmVersion: string }
  | { ok: false; missing: "node" | "pnpm"; why: string };

const pathOf = (env: Record<string, string | undefined>) => env.PATH ?? env.Path ?? env.path ?? "";

/** `node` and `pnpm` on the env's PATH (Windows: also `pnpm.cmd`), with their `--version`. */
export async function findNodeTools(env: Record<string, string | undefined> = process.env, run: Runner = spawnRunner): Promise<NodeTools> {
  const found: Record<string, { path: string; version: string }> = {};
  for (const name of ["node", "pnpm"] as const) {
    const PATH = pathOf(env);
    const path = Bun.which(name, { PATH }) ?? (process.platform === "win32" ? Bun.which(`${name}.cmd`, { PATH }) : null);
    if (path === null) return { ok: false, missing: name, why: `${name} is not on PATH` };
    // from a neutral folder: pnpm refuses to run in a project whose package.json names another package manager (app/ names bun)
    const r = await run(toolCommand(path, ["--version"]), { cwd: tmpdir(), env: childEnv({ ...process.env, ...env }), timeoutMs: 30_000 });
    const version = r.stdout.trim().replace(/^v/, "");
    if (r.code !== 0 || !/^\d+\.\d+\.\d+/.test(version)) return { ok: false, missing: name, why: `${path} --version did not answer (exit ${r.code})` };
    found[name] = { path, version };
  }
  return { ok: true, node: found.node!.path, pnpm: found.pnpm!.path, nodeVersion: found.node!.version, pnpmVersion: found.pnpm!.version };
}

export type ReadyTools = Extract<NodeTools, { ok: true }>;

/** What is wrong with the tools for a node env, with the fix, or null. */
export function nodeToolsProblem(tools: NodeTools, spec: { node: string; pnpm: string }): string | null {
  if (!tools.ok) {
    return tools.missing === "node"
      ? `${tools.why}; web tasks need Node ${spec.node} or later (https://nodejs.org)`
      : `${tools.why}; web tasks need pnpm ${spec.pnpm}: npm install -g pnpm@${spec.pnpm} (or corepack prepare pnpm@${spec.pnpm} --activate)`;
  }
  const major = Number(tools.nodeVersion.split(".")[0]);
  if (!(major >= Number(spec.node))) return `node ${tools.nodeVersion} is older than the ${spec.node} the set needs; install Node ${spec.node} or later`;
  if (tools.pnpmVersion !== spec.pnpm) {
    return `pnpm ${tools.pnpmVersion} (${tools.pnpm}) is not the pinned ${spec.pnpm}: npm install -g pnpm@${spec.pnpm} (or corepack prepare pnpm@${spec.pnpm} --activate), and put it first on PATH`;
  }
  return null;
}

export interface NodeOpts {
  home: string;
  tools: ReadyTools;
  run?: Runner;
  /** The pnpm store; default `<home>/eval/pnpm-store`. */
  storeDir?: string;
  /** Playwright's browsers; default `<home>/eval/ms-playwright`. */
  browsersDir?: string;
  env?: Record<string, string | undefined>;
}

export const storeDirOf = (o: { home: string; storeDir?: string }): string => o.storeDir ?? join(o.home, "eval", "pnpm-store");
export const browsersDirOf = (o: { home: string; browsersDir?: string }): string => o.browsersDir ?? join(o.home, "eval", "ms-playwright");

async function nodeStep(o: NodeOpts, log: string, argv: string[], cwd: string, what: string, extra: Record<string, string> = {}): Promise<Ran> {
  const run = o.run ?? spawnRunner;
  const env = childEnv(o.env ?? process.env, extra);
  const r = await run(argv, { cwd, env, timeoutMs: 1_800_000 });
  const path = logRun(o.home, log, argv, r);
  if (r.code !== 0) throw new EnvError(`${what} failed (exit ${r.code})`, path);
  return r;
}

/** The lockfile's sha256 for a node env, from the first task of the set that uses it. */
export function nodeLock(set: EvalSet, key: string): { task: RepoTask; files: Map<string, Uint8Array>; sha: string } {
  const task = set.tasks.find((t): t is RepoTask => t.kind === "repo" && t.node_env === key);
  if (task === undefined) throw new EnvError(`no task uses node env ${key}`);
  const files = new Map<string, Uint8Array>();
  for (const e of readTar(new Uint8Array(readFileSync(join(set.dir, task.base))))) {
    if (e.type === "file" && (e.path === "package.json" || e.path === "pnpm-lock.yaml")) files.set(e.path, e.data);
  }
  const lock = files.get("pnpm-lock.yaml");
  if (lock === undefined || !files.has("package.json")) throw new EnvError(`${task.base} has no package.json and pnpm-lock.yaml at its root`);
  return { task, files, sha: sha256(lock) };
}

/** True when the store already holds this node env's lockfile. */
export function nodeEnvFetched(set: EvalSet, key: string, o: { home: string; storeDir?: string }): boolean {
  return existsSync(join(storeDirOf(o), ".rlmh-fetched", nodeLock(set, key).sha));
}

/**
 * Fills the shared store from one node env's lockfile with `pnpm fetch`, once per lockfile hash. The tools
 * must already be checked against the env (nodeToolsProblem).
 */
export async function ensureNodeEnv(set: EvalSet, key: string, o: NodeOpts): Promise<void> {
  const spec = set.nodeEnvs.get(key);
  if (spec === undefined) throw new EnvError(`the set has no node env ${key}`);
  const problem = nodeToolsProblem(o.tools, spec);
  if (problem !== null) throw new EnvError(problem);
  const { files, sha } = nodeLock(set, key);
  const store = storeDirOf(o);
  const marker = join(store, ".rlmh-fetched", sha);
  if (existsSync(marker)) return;
  const tmp = mkdtempSync(join(tmpdir(), "rlmh-fetch-"));
  try {
    for (const [name, data] of files) writeFileSync(join(tmp, name), data);
    await nodeStep(o, `node-${key}`, toolCommand(o.tools.pnpm, ["fetch", "--store-dir", store]), tmp, `pnpm fetch for node env ${key}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  mkdirSync(join(store, ".rlmh-fetched"), { recursive: true });
  writeFileSync(marker, "");
}

/** `pnpm install --offline --frozen-lockfile` in a work copy, from the shared store. */
export async function installNodeModules(copy: string, o: NodeOpts): Promise<void> {
  await nodeStep(o, "node-install", toolCommand(o.tools.pnpm, ["install", "--offline", "--frozen-lockfile", "--store-dir", storeDirOf(o)]), copy, `pnpm install in ${copy}`);
}

export const browserReady = (version: string, o: { home: string; browsersDir?: string }): boolean => existsSync(join(browsersDirOf(o), `.rlmh-${version}`));

/** One Chromium for a Playwright version, installed once from an installed web copy. Never `--with-deps`, which needs root. */
export async function ensureBrowser(version: string, o: NodeOpts & { copy: string }): Promise<void> {
  if (browserReady(version, o)) return;
  const dir = browsersDirOf(o);
  mkdirSync(dir, { recursive: true });
  await nodeStep(o, "browser", toolCommand(o.tools.pnpm, ["exec", "playwright", "install", "chromium"]), o.copy, `playwright install chromium ${version}`, {
    PLAYWRIGHT_BROWSERS_PATH: dir,
  });
  writeFileSync(join(dir, `.rlmh-${version}`), "");
}

// -- the GPU probe (D-223) --

export type Backend = "cuda" | "hip";
export interface Probe {
  backend: Backend | "none";
  devices: number;
}

/** A probe whose output isn't the one line; its message never repeats the other lines. */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

const PROBE_LINE = /^backend=(cuda|hip|none) devices=(\d+)$/;

/** Accepts only `backend=<cuda|hip|none> devices=<n>`, as one line. */
export function parseProbe(output: string): Probe {
  const text = output.replace(/\r?\n$/, "");
  const m = PROBE_LINE.exec(text);
  if (m === null || text.includes("\n")) throw new ProbeError("the GPU probe did not print one line of the form backend=<cuda|hip|none> devices=<n>");
  return { backend: m[1] as Probe["backend"], devices: Number(m[2]) };
}

/** `gpu.py --probe` under the kernel venv's interpreter: no shell, 30 s, keys stripped. */
export async function probeGpu(venv: Venv, shimDir: string, o: { backend?: Backend; run?: Runner; env?: Record<string, string | undefined> } = {}): Promise<Probe> {
  const run = o.run ?? spawnRunner;
  const argv = [venv.python, "-I", join(shimDir, "gpu.py"), "--probe", ...(o.backend !== undefined ? ["--backend", o.backend] : [])];
  const env = childEnv(o.env ?? process.env);
  delete env.RLMH_GPU_BACKEND; // the probe's own choice, or --backend
  const r = await run(argv, { cwd: shimDir, env, timeoutMs: 30_000 });
  if (r.timedOut) throw new ProbeError("the GPU probe did not answer within 30 s");
  if (r.code !== 0) throw new ProbeError(`the GPU probe exited ${r.code}`);
  return parseProbe(r.stdout);
}

/** `gpu.py` and `gpu_compat.h` from a kernel task's tar, into `dir`. */
export function extractShim(set: EvalSet, task: RepoTask, dir: string): string {
  mkdirSync(dir, { recursive: true });
  for (const e of readTar(new Uint8Array(readFileSync(join(set.dir, task.base))))) {
    const name = e.path.split("/").pop();
    if (e.type === "file" && (name === "gpu.py" || name === "gpu_compat.h") && !existsSync(join(dir, name))) writeFileSync(join(dir, name), e.data);
  }
  if (!existsSync(join(dir, "gpu.py")) || !existsSync(join(dir, "gpu_compat.h"))) throw new EnvError(`${task.base} has no gpu.py and gpu_compat.h`);
  return dir;
}
