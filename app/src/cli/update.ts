// KV cache: none
// `rlmh update`: replaces an installed rlmh with a release by running that release's own installer.
// It finds the latest tag from the redirect of github.com/<repo>/releases/latest (no API, no token),
// downloads install.sh or install.ps1 and SHA256SUMS from the release's download folder, checks the
// installer against SHA256SUMS, and runs it with RLMH_HOME pointing at this home. Only on request:
// nothing here runs at start-up, and no key or token is sent anywhere. On Windows the running
// rlmh.exe is renamed to rlmh.exe.old first (a running exe can be renamed, not overwritten) and put
// back if the installer fails; the next start deletes the leftover.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { stripKeys } from "../engine.ts";
import { binDir } from "../paths.ts";
import { APP_VERSION } from "../version.ts";
import { askYesNo } from "./setup.ts";

export const REPO_URL = "https://github.com/RishiJain905/rlm-harness";

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const REQUEST_TIMEOUT_MS = 30_000;
const SUMS_MAX_BYTES = 64 * 1024;
const INSTALLER_MAX_BYTES = 1024 * 1024;

export interface UpdateOptions {
  home: string;
  /** --version: install this release instead of the latest. */
  version?: string;
  /** --yes: do not ask. */
  yes: boolean;
  /** --check: report the current and the latest version, change nothing. */
  check: boolean;
  /** stdin and stdout are terminals: someone can answer the question. */
  interactive: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Replaces the terminal question (default answer no). */
  ask?: (question: string) => Promise<boolean>;
  // -- seams for tests --
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Runs the installer and returns its exit code; its output goes straight to the terminal. */
  run?: (argv: string[], env: Record<string, string>) => Promise<number>;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** The running binary (process.execPath). */
  execPath?: string;
  /** Whether this process is a compiled binary (default: asks import.meta.dir). */
  compiled?: boolean;
  appVersion?: string;
  repoUrl?: string;
  /** Where the downloads go (default: the OS temp folder). */
  tmpRoot?: string;
}

class UpdateError extends Error {}

/** True in a binary made by `bun build --compile`, whose sources live in a virtual folder. */
export function isCompiledBinary(dir: string = import.meta.dir): boolean {
  return dir.includes("$bunfs") || dir.includes("~BUN");
}

/** 0.1.1 or v0.1.1 as 0.1.1, or null when it is not a plain version. */
export function normalizeVersion(text: string): string | null {
  const v = text.startsWith("v") ? text.slice(1) : text;
  return VERSION.test(v) ? v : null;
}

/** <0 when a is older than b. A release is newer than its own pre-releases. */
export function compareVersions(a: string, b: string): number {
  const [core1 = "", pre1] = a.split(/-(.*)/s);
  const [core2 = "", pre2] = b.split(/-(.*)/s);
  const x = core1.split(".").map(Number);
  const y = core2.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  if (pre1 === undefined || pre2 === undefined) return pre1 === pre2 ? 0 : pre1 === undefined ? 1 : -1;
  return pre1 < pre2 ? -1 : pre1 > pre2 ? 1 : 0;
}

/** Best effort, on every start of an installed Windows rlmh: delete what an update left next to the running binary (rlmh.exe.old, rlmh.exe.old.<pid>). */
export function sweepOldBinaries(execPath: string): void {
  const dir = dirname(execPath);
  const base = basename(execPath);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name !== `${base}.old` && !name.startsWith(`${base}.old.`)) continue;
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // an older rlmh is still running from it: next time
    }
  }
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const real = (p: string) => {
    try {
      return realpathSync.native(p);
    } catch {
      return resolve(p);
    }
  };
  const fold = (p: string) => (platform === "win32" ? p.toLowerCase() : p);
  return fold(real(a)) === fold(real(b));
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The latest release's version, from where github.com/<repo>/releases/latest redirects to (…/releases/tag/vX.Y.Z). */
async function latestVersion(fetchFn: NonNullable<UpdateOptions["fetch"]>, repo: string): Promise<string> {
  const url = `${repo}/releases/latest`;
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new UpdateError(`could not reach ${url}: ${message(err)}`);
  }
  const location = res.headers.get("location");
  if (res.status < 300 || res.status >= 400 || !location) {
    throw new UpdateError(`${url} answered HTTP ${res.status} and did not point at a release. Is a release published?`);
  }
  let path: string;
  try {
    path = decodeURIComponent(new URL(location, url).pathname);
  } catch {
    throw new UpdateError(`${url} redirected somewhere that is not a URL: ${location}`);
  }
  const tag = /\/releases\/tag\/([^/]+)$/.exec(path)?.[1];
  const version = tag === undefined ? null : normalizeVersion(tag);
  if (version === null) throw new UpdateError(`${url} redirected to ${location}, which does not name a release such as v0.1.1`);
  return version;
}

/** The whole body of `url`, at most `limit` bytes. */
async function download(fetchFn: NonNullable<UpdateOptions["fetch"]>, url: string, limit: number): Promise<Uint8Array> {
  let res: Response;
  try {
    res = await fetchFn(url, { redirect: "follow", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (err) {
    throw new UpdateError(`could not download ${url}: ${message(err)}`);
  }
  if (!res.ok) throw new UpdateError(`could not download ${url}: HTTP ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > limit) throw new UpdateError(`${url} is larger than the ${limit} bytes expected`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    const reader = res.body?.getReader();
    if (!reader) return new Uint8Array(await res.arrayBuffer());
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw new UpdateError(`${url} is larger than the ${limit} bytes expected`);
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof UpdateError) throw err;
    throw new UpdateError(`could not download ${url}: ${message(err)}`);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return body;
}

/** The hex digest SHA256SUMS gives for `name`, or null when no line names it. */
function expectedSha(sums: string, name: string): string | null {
  for (const raw of sums.split("\n")) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(raw.replace(/\r$/, ""));
    if (m && m[2] === name) return m[1]!.toLowerCase();
  }
  return null;
}

/** Windows: puts the running binary aside under a name it can be restored from. */
function stepAside(binary: string): string {
  let old = `${binary}.old`;
  try {
    rmSync(old, { force: true }); // a leftover from the last update, when no rlmh runs from it any more
  } catch {
    // still in use
  }
  if (existsSync(old)) old = `${binary}.old.${process.pid}`;
  renameSync(binary, old);
  return old;
}

/** Puts the binary set aside back, replacing whatever the installer placed. Returns why it could not, else null. */
function putBack(binary: string, old: string): string | null {
  try {
    rmSync(binary, { force: true });
  } catch {
    // the rename below says if that matters
  }
  try {
    renameSync(old, binary);
    return null;
  } catch (err) {
    return message(err);
  }
}

/** Runs argv with the terminal as its output. Ctrl-C belongs to the installer then: this process waits to clean up after it. */
async function spawnInstaller(argv: string[], env: Record<string, string>): Promise<number> {
  const ignore = () => undefined;
  process.on("SIGINT", ignore);
  try {
    const proc = Bun.spawn({ cmd: argv, env, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  } finally {
    process.off("SIGINT", ignore);
  }
}

/** `rlmh update [--version X] [--yes] [--check]`; returns the exit code (0, 1 failed or declined, 2 not possible here or not asked). */
export async function runUpdate(o: UpdateOptions): Promise<number> {
  const platform = o.platform ?? process.platform;
  const current = o.appVersion ?? APP_VERSION;
  const repo = (o.repoUrl ?? REPO_URL).replace(/\/$/, "");
  const fetchFn = o.fetch ?? ((url, init) => fetch(url, init));
  const run = o.run ?? spawnInstaller;
  const env = o.env ?? process.env;
  const execPath = o.execPath ?? process.execPath;

  if (!(o.compiled ?? isCompiledBinary())) {
    o.err("This rlmh runs from a source checkout; update it with git pull.");
    return 2;
  }
  const binary = join(binDir(o.home), platform === "win32" ? "rlmh.exe" : "rlmh");
  if (!o.check && !samePath(execPath, binary, platform)) {
    if (/[\\/]node_modules[\\/]/.test(execPath)) {
      o.err("This rlmh was installed with npm or bun; update it with npm i -g rlm-harness@latest (or bun add -g --trust rlm-harness@latest).");
      return 2;
    }
    o.err(
      `This rlmh (${execPath}) is not the one the installer put in ${binDir(o.home)}, so "rlmh update" would not replace it. ` +
        `Run the installer to update that one (see ${repo}).`,
    );
    return 2;
  }

  let target: string;
  try {
    if (o.version !== undefined) {
      const v = normalizeVersion(o.version);
      if (v === null) {
        o.err(`rlmh update: --version must be a release such as 0.1.1 (got ${JSON.stringify(o.version)})`);
        return 2;
      }
      target = v;
    } else {
      target = await latestVersion(fetchFn, repo);
    }
  } catch (err) {
    o.err(`rlmh update: ${message(err)}`);
    return 1;
  }

  const label = o.version === undefined ? "the latest version" : `version ${target}`;
  if (o.check) {
    if (target === current) o.out(`rlmh ${current} is installed, and is ${label}.`);
    else if (compareVersions(target, current) < 0) o.out(`rlmh ${current} is installed; ${label} is ${target}, which is older.`);
    else o.out(`rlmh ${current} is installed; ${label} is ${target}. Run "rlmh update" to update.`);
    return 0;
  }
  if (target === current) {
    o.out(o.version === undefined ? `rlmh ${current} is the latest version.` : `rlmh ${current} is already installed.`);
    return 0;
  }
  if (o.version === undefined && compareVersions(target, current) < 0) {
    o.out(`rlmh ${current} is newer than the latest release (${target}); nothing to do.`);
    return 0;
  }

  const installerName = platform === "win32" ? "install.ps1" : "install.sh";
  const base = `${repo}/releases/download/v${target}`;
  o.out(`rlmh update: ${current} -> ${target}`);
  o.out(`  from   ${base}/ (${installerName}, checked against SHA256SUMS, then run)`);
  o.out(`  into   ${binary}`);
  if (!o.yes) {
    if (!o.interactive) {
      o.err('rlmh update: this needs a yes and there is no terminal to ask on; run "rlmh update --yes" to go ahead.');
      return 2;
    }
    if (!(await (o.ask ?? ((q) => askYesNo(q, false)))("Update now? [y/N] "))) {
      o.out("Not updated.");
      return 1;
    }
  }

  const work = mkdtempSync(join(o.tmpRoot ?? tmpdir(), "rlmh-update-"));
  let old: string | null = null;
  try {
    // 1. the installer and the checksums, checked before anything runs or changes
    let installer: Uint8Array;
    try {
      const sums = new TextDecoder().decode(await download(fetchFn, `${base}/SHA256SUMS`, SUMS_MAX_BYTES));
      installer = await download(fetchFn, `${base}/${installerName}`, INSTALLER_MAX_BYTES);
      const expected = expectedSha(sums, installerName);
      const actual = createHash("sha256").update(installer).digest("hex");
      if (expected === null) throw new UpdateError(`SHA256SUMS has no line for ${installerName}; nothing was run or changed`);
      if (expected !== actual) {
        throw new UpdateError(`checksum mismatch for ${installerName}\n  expected  ${expected}\n  actual    ${actual}\nnothing was run or changed`);
      }
    } catch (err) {
      o.err(`rlmh update: ${message(err)}`);
      return 1;
    }
    const script = join(work, installerName);
    writeFileSync(script, installer);

    // 2. the installer, with this home and this release, and none of this process's keys
    const child: Record<string, string> = { ...stripKeys(env), RLMH_HOME: o.home, RLMH_VERSION: target, RLMH_NO_MODIFY_PATH: "1" };
    delete child.RLMH_DOWNLOAD_BASE; // the release this run just checked, not a folder from the environment
    const argv = platform === "win32" ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] : ["sh", script];
    if (platform === "win32") {
      try {
        old = stepAside(binary);
      } catch (err) {
        o.err(`rlmh update: could not step ${binary} aside for the installer: ${message(err)}. Nothing was changed.`);
        return 1;
      }
    }
    let code: number;
    try {
      code = await run(argv, child);
    } catch (err) {
      o.err(`rlmh update: could not run ${installerName}: ${message(err)}`);
      code = -1;
    }
    if (code !== 0) {
      const failed = code === -1 ? "" : `The installer exited with code ${code}. `;
      if (old === null) {
        o.err(`rlmh update: ${failed}rlmh was not updated; if ${binary} is damaged, run the installer again.`);
      } else {
        const why = putBack(binary, old);
        o.err(why === null ? `rlmh update: ${failed}The previous rlmh was put back.` : `rlmh update: ${failed}Could not put the previous rlmh back: ${why}. It is at ${old}; rename it to ${binary}.`);
      }
      return 1;
    }
    o.out(`rlmh updated to ${target}.`);
    o.out('The next "rlmh" start sets up the new engine (Python is reused) and removes the old engine folders.');
    return 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
