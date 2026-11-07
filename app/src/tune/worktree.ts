// KV cache: none
// `/tune`'s snapshots and throwaway work copies (v1 architecture §7.6, step 9 task 3, D-219, D-231). In git, a
// snapshot is an unreferenced commit of the working tree (untracked files in, ignored ones out) built through a
// temporary index, as workspace.py's `snapshot` builds a run's base tree: workspace.py's GIT_ARGS, every filter
// driver blanked (`no_filters`), no hook. No ref is made and nothing is checked out, so the user's index, HEAD,
// branches and files stay as they were. Outside git it is a copy under D-219's limits. Work copies are
// `git worktree add --detach` at that commit, or a copy of the copy. `runTest` runs `tune.test` in one, with no shell.

import { randomBytes } from "node:crypto";
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { splitCommand, stripKeys } from "../engine.ts";
import { killTree, removeQuietly, spawnRunner, toolCommand, type Ran } from "../eval/work.ts";
import { home as defaultHome, tuneDir } from "../paths.ts";

/** Python's os.devnull, which git takes as a hooks path on every OS. */
const devNull = process.platform === "win32" ? "nul" : "/dev/null";

/** workspace.py's GIT_ARGS (L41), unchanged: the user's own config (autocrlf, attributes) still applies. */
export const GIT_ARGS = [
  "-c", "safe.directory=*", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "core.safecrlf=false",
  "-c", `core.hooksPath=${devNull}`,
];

/** workspace.py's `_FILTER_OFF`: per driver, no command and not required. */
const FILTER_OFF: [string, string][] = [["clean", ""], ["smudge", ""], ["process", ""], ["required", "false"]];

/** Variables that would point git at another repository, index or object store, or add config past no_filters. */
const GIT_REPO_VARS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|PREFIX|CONFIG_PARAMETERS)$/i;

/** The snapshot commit's message and identity: fixed, so the user's identity is never needed and one tree gives one commit. */
export const SNAPSHOT_MESSAGE = "rlmh /tune snapshot";
const IDENTITY = {
  GIT_AUTHOR_NAME: "rlmh",
  GIT_AUTHOR_EMAIL: "rlmh@localhost",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00+0000",
  GIT_COMMITTER_NAME: "rlmh",
  GIT_COMMITTER_EMAIL: "rlmh@localhost",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00+0000",
};

/** D-219's limits for a snapshot outside git, counted before anything is copied. */
export const SNAPSHOT_MAX_FILES = 20_000;
export const SNAPSHOT_MAX_BYTES = 1024 ** 3;
/** Folders a copy snapshot leaves out, at any depth; `.git` also as a file. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  ".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".tox", "dist", "build", "target",
]);
/** `runTest`'s default limit. */
export const TEST_TIMEOUT_S = 600;
const GIT_TIMEOUT_MS = 300_000; // workspace.py's GIT_TIMEOUT_S
/** The marker each snapshot and work copy folder holds, so pruneStale can find what an earlier session left. */
export const WORK_JSON = "work.json";

/**
 * A folder's starting state. `commit`: an unreferenced commit in the repository at `top`, and `sub` is the folder
 * below `top` ("/"-separated, "" at the top). `copy`: a copy at `path`, and `sub` is "". `dir` is the `dest` given,
 * which holds `work.json` (and, for a copy, the copy); `remove()` deletes it.
 */
export interface Snapshot {
  kind: "commit" | "copy";
  commit?: string;
  top?: string;
  path?: string;
  /** The folder the snapshot was taken of, resolved. */
  folder: string;
  sub: string;
  dir: string;
  remove(): Promise<void>;
}

/**
 * A throwaway copy of a snapshot. `path` is the copy's top (a folder named as the user's, inside `dest`), `cwd`
 * is the snapshot's folder inside it (`path` joined with `sub`), and `applied` says a given diff applied.
 */
export interface WorkCopy {
  path: string;
  cwd: string;
  kind: "worktree" | "copy";
  applied: boolean;
  dir: string;
  remove(): Promise<void>;
}

export interface SnapshotOptions {
  /** The runtime home; the temporary index goes under `tuneDir(home)/work/`. Defaults to paths.ts's `home()`. */
  home?: string;
  /** Overrides D-219's limits, for tests. */
  maxFiles?: number;
  maxBytes?: number;
}

export interface TestResult {
  exit: number;
  timedOut: boolean;
  seconds: number;
}

interface WorkJson {
  folder: string;
  kind: "commit" | "copy" | "worktree";
  /** The worktree's path, for a `worktree` entry. */
  path?: string;
  /** The process that made it; pruneStale leaves a live other process's entries alone. */
  pid: number;
}

// -- git --

/** process.env through stripKeys, with nothing that points git elsewhere, and git never prompting (D-63). */
function baseEnv(): Record<string, string> {
  const env = stripKeys(process.env);
  for (const name of Object.keys(env)) if (GIT_REPO_VARS.test(name)) delete env[name];
  return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" };
}

/** `git <GIT_ARGS> -C <dir> …`; throws with git's stderr unless its exit code is in `ok`. */
async function git(dir: string, args: string[], env: Record<string, string>, opts: { ok?: number[]; stdin?: string; extra?: string[] } = {}): Promise<Ran> {
  const r = await spawnRunner(["git", ...GIT_ARGS, ...(opts.extra ?? []), "-C", dir, ...args], {
    cwd: dir,
    env,
    timeoutMs: GIT_TIMEOUT_MS,
    ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
  });
  if (r.timedOut) throw new Error(`git ${args[0]} timed out after ${GIT_TIMEOUT_MS / 1000} s in ${dir}`);
  if (!(opts.ok ?? [0]).includes(r.code)) throw new Error(`git ${args[0]} failed in ${dir} (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`);
  return r;
}

/**
 * workspace.py's `no_filters` (L186): `env` with every configured filter driver's clean, smudge and process
 * blanked and `required` off, through GIT_CONFIG_COUNT/KEY_n/VALUE_n. stripKeys already dropped any set the
 * user's env had (D-62), so the count starts at 0.
 */
async function noFilters(dir: string, env: Record<string, string>): Promise<Record<string, string>> {
  const out = { ...env };
  delete out.GIT_CONFIG_PARAMETERS;
  const listed = (await git(dir, ["config", "-z", "--name-only", "--get-regexp", "^filter\\."], out, { ok: [0, 1] })).stdout;
  const drivers = [...new Set(listed.split("\0").filter((k) => k.split(".").length >= 3).map((k) => k.slice("filter.".length, k.lastIndexOf("."))))].sort();
  let count = Number.parseInt(out.GIT_CONFIG_COUNT ?? "0", 10);
  if (!Number.isFinite(count) || count < 0) count = 0;
  for (const driver of drivers) {
    for (const [name, value] of FILTER_OFF) {
      out[`GIT_CONFIG_KEY_${count}`] = `filter.${driver}.${name}`;
      out[`GIT_CONFIG_VALUE_${count}`] = value;
      count += 1;
    }
  }
  if (drivers.length > 0) out.GIT_CONFIG_COUNT = String(count);
  return out;
}

/** The work tree `folder` is in: its top and the folder below it; "dir" inside a .git folder or a bare repo; null outside git or without git. */
async function locate(folder: string, env: Record<string, string>): Promise<{ top: string; sub: string } | "git-dir" | null> {
  const inside = await spawnRunner(["git", ...GIT_ARGS, "-C", folder, "rev-parse", "--is-inside-work-tree"], { cwd: folder, env, timeoutMs: GIT_TIMEOUT_MS });
  if (inside.code !== 0) return null;
  if (inside.stdout.trim() !== "true") return "git-dir";
  const [top, prefix] = (await git(folder, ["rev-parse", "--show-toplevel", "--show-prefix"], env)).stdout.split(/\r?\n/);
  return { top: resolve(top!), sub: (prefix ?? "").replace(/\/+$/, "") };
}

// -- work.json and copies --

function writeWorkJson(dir: string, info: Omit<WorkJson, "pid">): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, WORK_JSON), `${JSON.stringify({ ...info, pid: process.pid })}\n`);
}

function readWorkJson(dir: string): WorkJson | null {
  try {
    const info = JSON.parse(readFileSync(join(dir, WORK_JSON), "utf8"));
    return info !== null && typeof info === "object" ? (info as WorkJson) : null;
  } catch {
    return null;
  }
}

/** The copy's own folder name: the user's, so a run in it sees the same name. */
function treeName(folder: string): string {
  const name = basename(folder);
  return name === "" || name === WORK_JSON ? "tree" : name;
}

/** Is `pid` a live process other than this one? */
function otherAlive(pid: unknown): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface Plan {
  dirs: string[]; // relative, parents first
  files: string[];
  links: string[];
}

/** Every entry under `src`, links not followed, skipping SKIP_DIRS when `skip`; `{refused}` past a limit, before anything is copied. */
function planCopy(src: string, opts: { skip: boolean; maxFiles?: number; maxBytes?: number }): Plan | { refused: string } {
  const plan: Plan = { dirs: [], files: [], links: [] };
  let files = 0;
  let bytes = 0;
  const stack = [""];
  while (stack.length > 0) {
    const rel = stack.pop()!;
    for (const entry of readdirSync(join(src, rel), { withFileTypes: true })) {
      const child = rel === "" ? entry.name : join(rel, entry.name);
      if (opts.skip && SKIP_DIRS.has(entry.name) && (entry.isDirectory() || entry.name === ".git")) continue;
      if (entry.isSymbolicLink()) {
        plan.links.push(child);
        files += 1;
      } else if (entry.isDirectory()) {
        plan.dirs.push(child);
        stack.push(child);
      } else if (entry.isFile()) {
        plan.files.push(child);
        files += 1;
        bytes += lstatSync(join(src, child)).size;
      } // sockets, fifos and devices are left out
      if (opts.maxFiles !== undefined && files > opts.maxFiles) {
        return { refused: `the folder has more than ${opts.maxFiles.toLocaleString("en-US")} files, the limit for a snapshot outside git` };
      }
      if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
        return { refused: `the folder holds more than ${formatBytes(opts.maxBytes)}, the limit for a snapshot outside git` };
      }
    }
  }
  plan.dirs.sort();
  return plan;
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3 && n % 1024 ** 3 === 0) return `${n / 1024 ** 3} GB`;
  if (n >= 1024 ** 2 && n % 1024 ** 2 === 0) return `${n / 1024 ** 2} MB`;
  return `${n.toLocaleString("en-US")} bytes`;
}

/** Copies a plan into `dest` (made here). A link is copied as a link; one this OS won't let us make is left out. */
function copyPlan(src: string, dest: string, plan: Plan): void {
  mkdirSync(dest, { recursive: true });
  for (const d of plan.dirs) mkdirSync(join(dest, d), { recursive: true });
  for (const f of plan.files) copyFileSync(join(src, f), join(dest, f));
  for (const l of plan.links) {
    const from = join(src, l);
    try {
      let type: "dir" | "file" = "file";
      try {
        type = statSync(from).isDirectory() ? "dir" : "file"; // only for Windows' link type; nothing is read through it
      } catch {
        // a dangling link
      }
      symlinkSync(readlinkSync(from), join(dest, l), type);
    } catch {
      // Windows without the symlink privilege: the link is left out, never followed
    }
  }
}

// -- snapshot --

/**
 * The folder's starting state, written under `dest` (which must not exist). In git, an unreferenced commit made
 * through a temporary index under `tuneDir(home)/work/`; outside git, a copy at `<dest>/<folder name>/`, or
 * `{refused}` above the limits or inside a .git folder. A git failure throws, and leaves nothing behind.
 */
export async function snapshot(folder: string, dest: string, opts: SnapshotOptions = {}): Promise<Snapshot | { refused: string }> {
  const src = resolve(folder);
  const dir = resolve(dest);
  const env = baseEnv();
  const found = await locate(src, env);
  if (found === "git-dir") return { refused: "the folder is inside a .git folder or a bare repository" };
  const remove = async () => void removeQuietly(dir);
  if (found === null) {
    const plan = planCopy(src, { skip: true, maxFiles: opts.maxFiles ?? SNAPSHOT_MAX_FILES, maxBytes: opts.maxBytes ?? SNAPSHOT_MAX_BYTES });
    if ("refused" in plan) return plan;
    const path = join(dir, treeName(src));
    writeWorkJson(dir, { folder: src, kind: "copy" });
    try {
      copyPlan(src, path, plan);
    } catch (err) {
      removeQuietly(dir);
      throw err;
    }
    return { kind: "copy", path, folder: src, sub: "", dir, remove };
  }
  const { top, sub } = found;
  const work = join(tuneDir(opts.home ?? defaultHome()), "work");
  mkdirSync(work, { recursive: true });
  const index = join(work, `index-${process.pid}-${randomBytes(6).toString("hex")}`);
  writeWorkJson(dir, { folder: top, kind: "commit" });
  try {
    const gitEnv = await noFilters(top, { ...env, GIT_INDEX_FILE: index });
    const head = (await git(top, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], gitEnv, { ok: [0, 1] })).stdout.trim();
    await git(top, head !== "" ? ["read-tree", head] : ["read-tree", "--empty"], gitEnv);
    await git(top, ["add", "-A"], gitEnv);
    const tree = (await git(top, ["write-tree"], gitEnv)).stdout.trim();
    if (sub !== "" && (await git(top, ["rev-parse", "--verify", "-q", `${tree}:${sub}`], gitEnv, { ok: [0, 1] })).code !== 0) {
      removeQuietly(dir);
      return { refused: "the folder is ignored by git, or holds no file git would keep" };
    }
    const parent = head !== "" ? ["-p", head] : [];
    const commit = (await git(top, ["commit-tree", "--no-gpg-sign", tree, ...parent, "-m", SNAPSHOT_MESSAGE], { ...gitEnv, ...IDENTITY })).stdout.trim();
    return { kind: "commit", commit, top, folder: src, sub, dir, remove };
  } catch (err) {
    removeQuietly(dir);
    throw err;
  } finally {
    try {
      unlinkSync(index);
    } catch {
      // never written (git failed first)
    }
  }
}

// -- work copies --

/**
 * A fresh copy of `snap` under `dest` (which must not exist): `git worktree add --detach` at the commit, with the
 * snapshot's env (no hook, no filter), or a copy of the copy. With `diff` (a run's recorded diff, relative to the
 * snapshot's folder), it is applied with `git apply`; `applied` says whether it did. An empty diff applies.
 */
export async function workCopy(snap: Snapshot, dest: string, diff?: string): Promise<WorkCopy> {
  const dir = resolve(dest);
  const path = join(dir, treeName(snap.kind === "commit" ? snap.top! : snap.folder));
  const cwd = snap.sub === "" ? path : join(path, ...snap.sub.split("/"));
  let remove: () => Promise<void>;
  if (snap.kind === "commit") {
    const top = snap.top!;
    writeWorkJson(dir, { folder: top, kind: "worktree", path });
    remove = async () => {
      await dropWorktree(top, path);
      removeQuietly(dir);
    };
    try {
      await git(top, ["worktree", "add", "--detach", "--quiet", path, snap.commit!], await noFilters(top, baseEnv()));
    } catch (err) {
      await remove();
      throw err;
    }
  } else {
    writeWorkJson(dir, { folder: snap.folder, kind: "copy" });
    remove = async () => void removeQuietly(dir);
    try {
      const plan = planCopy(snap.path!, { skip: false });
      if ("refused" in plan) throw new Error(plan.refused); // no limits given: never
      copyPlan(snap.path!, path, plan);
    } catch (err) {
      await remove();
      throw err;
    }
  }
  let applied = false;
  if (diff !== undefined) applied = await applyDiff(snap, path, diff);
  return { path, cwd, kind: snap.kind === "commit" ? "worktree" : "copy", applied, dir, remove };
}

/**
 * `git apply`, which also works outside a repository. In a worktree it runs at the top with `--directory=<sub>`
 * and the repository's config, filters blanked; in a copy, git is kept from finding any repository above it
 * and reads the bytes as they are.
 */
async function applyDiff(snap: Snapshot, path: string, diff: string): Promise<boolean> {
  if (diff.trim() === "") return true;
  const env = baseEnv();
  try {
    if (snap.kind === "commit") {
      const args = ["apply", "--whitespace=nowarn", ...(snap.sub !== "" ? [`--directory=${snap.sub}`] : [])];
      await git(path, args, await noFilters(path, env), { stdin: diff });
    } else {
      const copyEnv = await noFilters(path, { ...env, GIT_CEILING_DIRECTORIES: dirname(path) });
      await git(path, ["apply", "--whitespace=nowarn"], copyEnv, { stdin: diff, extra: ["-c", "core.autocrlf=false"] });
    }
    return true;
  } catch {
    return false;
  }
}

/** `git worktree remove --force`, then the folder if git left it, then `git worktree prune`. Never throws. */
async function dropWorktree(top: string, path: string): Promise<void> {
  const env = baseEnv();
  if (existsSync(top)) await git(top, ["worktree", "remove", "--force", path], env, { ok: [] }).catch(() => {});
  if (existsSync(path)) removeQuietly(path);
  if (existsSync(top)) await git(top, ["worktree", "prune"], env, { ok: [] }).catch(() => {});
}

// -- leftovers --

/** Whether `path` is strictly inside `dir`, by path text (case folded on Windows); no link is followed. */
function isBelow(path: string, dir: string): boolean {
  const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  return fold(resolve(path)).startsWith(fold(resolve(dir)) + sep);
}

/** Folders holding a work.json under `root`, not looking inside them; links are not followed. */
function marked(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    if (dir !== root && existsSync(join(dir, WORK_JSON))) {
      out.push(dir);
      continue;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) stack.push(join(dir, e.name));
  }
  return out;
}

/** Removes the empty folders below `root` (not `root`), deepest first. */
function removeEmpty(root: string): void {
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) if (e.isDirectory() && !e.isSymbolicLink()) walk(join(dir, e.name));
    if (dir !== root) {
      try {
        rmdirSync(dir); // only succeeds when empty
      } catch {
        // not empty
      }
    }
  };
  walk(root);
}

/**
 * Removes what an earlier session left under `tuneDir(home)/work/` and `snapshots/`: each work copy (its worktree
 * removed and pruned) and snapshot found by its work.json, and stray temporary indexes. Entries a live other
 * rlmh process made are left alone. Returns the folders removed. Run at start-up when `tune.enabled` is true,
 * and at `/tune on`.
 */
export async function pruneStale(home: string): Promise<string[]> {
  const removed: string[] = [];
  const work = join(tuneDir(home), "work");
  for (const root of [work, join(tuneDir(home), "snapshots")]) {
    if (!existsSync(root)) continue;
    for (const dir of marked(root)) {
      const info = readWorkJson(dir);
      if (info !== null && otherAlive(info.pid)) continue;
      // only a worktree below this work.json's own folder is removed: the file is data, and a path in it must never
      // point the recursive removal anywhere else (SR-5)
      if (info?.kind === "worktree" && typeof info.folder === "string" && typeof info.path === "string" && isBelow(info.path, dir)) {
        await dropWorktree(info.folder, info.path);
      }
      if (removeQuietly(dir)) removed.push(dir);
    }
    removeEmpty(root);
  }
  if (existsSync(work)) {
    for (const e of readdirSync(work, { withFileTypes: true })) {
      const m = /^index-(\d+)-[0-9a-f]+$/.exec(e.name);
      if (e.isFile() && m !== null && !otherAlive(Number(m[1]))) {
        try {
          unlinkSync(join(work, e.name));
        } catch {
          // held by a git that is still exiting
        }
      }
    }
  }
  return removed;
}

// -- tests --

/**
 * Runs `tune.test` in `cwd`: split with splitCommand, no shell (a `.cmd` or `.bat` goes through cmd.exe on
 * Windows, as toolCommand does for the eval), stripKeys(process.env), stdin closed, and killed with its tree
 * after `timeoutS` (600 s). Its stdout and stderr go to `log` (made, or replaced). Only the exit code comes back:
 * 127 when it can't start, -1 when it was killed without one.
 */
export async function runTest(cmd: string, cwd: string, opts: { log: string; timeoutS?: number }): Promise<TestResult> {
  let argv: string[];
  try {
    argv = splitCommand(cmd);
  } catch {
    throw new Error(`tune.test has an unbalanced quote: ${cmd}`);
  }
  if (argv.length === 0) throw new Error("tune.test is empty");
  mkdirSync(dirname(opts.log), { recursive: true });
  const fd = openSync(opts.log, "w");
  const started = performance.now();
  const seconds = () => Math.round(performance.now() - started) / 1000;
  try {
    let proc;
    try {
      proc = Bun.spawn({
        cmd: toolCommand(argv[0]!, argv.slice(1)),
        ...(process.platform === "win32" && /\.(cmd|bat)$/i.test(argv[0]!) ? { windowsVerbatimArguments: true } : {}),
        cwd,
        env: stripKeys(process.env),
        stdin: "ignore",
        stdout: fd,
        stderr: fd,
        detached: process.platform !== "win32", // its own process group, so the limit reaches its children
        windowsHide: true,
      });
    } catch (err) {
      writeSync(fd, `rlmh: could not start ${argv[0]}: ${(err as Error).message}\n`);
      return { exit: 127, timedOut: false, seconds: seconds() };
    }
    let timedOut = false;
    const limit = (opts.timeoutS ?? TEST_TIMEOUT_S) * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(proc.pid);
    }, limit);
    try {
      await proc.exited;
    } finally {
      clearTimeout(timer);
    }
    return { exit: proc.exitCode ?? -1, timedOut, seconds: seconds() };
  } finally {
    closeSync(fd);
  }
}
