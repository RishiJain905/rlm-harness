// KV cache: none; the interface never touches the bytes sent to the model.
// What a typed question means (6c): `@path` mentions make a read-mode run over those files, no
// mention makes a repo-mode run on the folder. Also the `@path` completion and the `@` file menu for
// the prompt box.

import { spawnSync } from "node:child_process";
import { opendirSync, readdirSync, statSync, type Dir } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { StartRun } from "../session.ts";

/** What `parseQuestion` needs from the file system; tests pass a fake. `other` is anything that exists and is neither a file nor a folder. */
export interface FileProbe {
  stat(path: string): "file" | "dir" | "other" | "missing";
}

const nodeProbe: FileProbe = {
  stat(path) {
    try {
      const s = statSync(path, { throwIfNoEntry: false });
      if (!s) return "missing";
      return s.isFile() ? "file" : s.isDirectory() ? "dir" : "other";
    } catch {
      return "missing"; // ENOTDIR, EACCES and the like: the run could not read it either
    }
  },
};

// `a@b.com` is no mention: the `@` must start the text or follow whitespace (6c).
const MENTION = /(^|\s)@("[^"]+"|\S+)/g;
const QUOTED = /^"[^"]+"$/;

export type ParsedQuestion = { ok: true; run: StartRun } | { ok: false; error: string };

/**
 * How the next question picks its mode (D-156, Shift+Tab in the prompt). `auto` is S-31's rule: mentions mean read mode
 * on those files, none means repo mode on the folder. `repo` always works on the folder, so `@spec.md implement it`
 * edits the repo with the spec named in the task. `read` always reads the mentioned files and needs at least one.
 */
export type RunChoice = "auto" | "repo" | "read";
export const RUN_CHOICES: readonly RunChoice[] = ["auto", "repo", "read"];

/**
 * Pure apart from `fs` (which defaults to node's `statSync`). Paths resolve against `cwd`. `\` means
 * `/` except on win32, where node:path takes both and `C:\temp\a.txt` is a path. The `question`
 * carries each mention's path as typed with every `\` written as `/` (D-17), quotes and `@` dropped.
 * `inputs` are absolute and deduplicated in order. The first mention that is not a file stops it. Under `choice`
 * `repo` the same checks run and each mention is written into the task as the file it named (`repoPath`): relative to
 * `cwd` with `/` when inside it, else absolute with `/`, quoted when it holds whitespace, so the worker's `/tmp` and
 * `/work/repo` names can't send the model elsewhere. Under `read` a question needs a mention.
 */
export function parseQuestion(text: string, cwd: string, fs: FileProbe = nodeProbe, choice: RunChoice = "auto"): ParsedQuestion {
  const mentions = [...text.matchAll(MENTION)];
  if (mentions.length === 0) {
    if (choice === "read") return { ok: false, error: "Read mode needs @file mentions. Shift+Tab changes the mode." };
    return { ok: true, run: { mode: "repo", task: text, repoPath: cwd, interactive: true } };
  }
  const win32 = process.platform === "win32";
  const inputs: string[] = [];
  const seen = new Set<string>();
  let question = "";
  let task = "";
  let last = 0;
  for (const m of mentions) {
    const lead = m[1] as string;
    const token = m[2] as string;
    const typed = QUOTED.test(token) ? token.slice(1, -1) : token;
    const absolute = resolve(cwd, win32 ? typed : typed.replaceAll("\\", "/"));
    const kind = fs.stat(absolute);
    if (kind === "missing") return { ok: false, error: `@${token}: no such file` };
    if (kind !== "file") return { ok: false, error: `@${token}: not a file` };
    const key = win32 ? absolute.toLowerCase() : absolute;
    if (!seen.has(key)) {
      seen.add(key);
      inputs.push(absolute);
    }
    const start = (m.index ?? 0) + lead.length;
    question += text.slice(last, start) + typed.replaceAll("\\", "/");
    task += text.slice(last, start) + repoPath(absolute, cwd);
    last = (m.index ?? 0) + m[0].length;
  }
  question += text.slice(last);
  task += text.slice(last);
  if (choice === "repo") return { ok: true, run: { mode: "repo", task, repoPath: cwd, interactive: true } };
  return { ok: true, run: { mode: "read", question, inputs, interactive: true } };
}

/** A checked mention as a repo task names it: relative to `cwd` inside it, else absolute; `/` always; quoted with whitespace. */
function repoPath(absolute: string, cwd: string): string {
  const rel = relative(cwd, absolute);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  const path = (inside ? rel : absolute).replaceAll("\\", "/");
  return /\s/.test(path) ? `"${path}"` : path;
}

const MAX_COMPLETIONS = 50;

/**
 * Candidates for what follows `@`. `prefix` is the text typed after the `@`, possibly starting with
 * `"`. Each candidate replaces all of it: the folder part as typed, then an entry name that starts
 * with the typed basename (case-sensitive; dot-entries only if the basename starts with a dot),
 * with `/` after a folder. A candidate that needs quotes (the user typed one, or the path holds
 * whitespace) starts with `"`, and a file also gets the closing `"`. Sorted, at most 50. Unreadable
 * or missing folders give `[]`; it never throws.
 */
export function completePath(prefix: string, cwd: string): string[] {
  try {
    const quoted = prefix.startsWith('"');
    const typed = quoted ? prefix.slice(1) : prefix;
    let cut = typed.lastIndexOf("/");
    if (process.platform === "win32") cut = Math.max(cut, typed.lastIndexOf("\\"));
    const folder = typed.slice(0, cut + 1);
    const base = typed.slice(cut + 1);
    const dir = resolve(cwd, folder);
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.name.startsWith(base) && (base.startsWith(".") || !e.name.startsWith(".")))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .slice(0, MAX_COMPLETIONS);
    return entries.map((e) => {
      let isDir = e.isDirectory();
      if (!isDir && e.isSymbolicLink()) {
        try {
          isDir = statSync(join(dir, e.name)).isDirectory();
        } catch {
          // a broken link is a file as far as completion goes
        }
      }
      const path = folder + e.name + (isDir ? "/" : "");
      if (!quoted && !/\s/.test(path)) return path;
      return isDir ? `"${path}` : `"${path}"`;
    });
  } catch {
    return [];
  }
}

/** The `@` token at the end of `value`: where its `@` is and what follows it (an opening `"` kept), or null. */
export function mentionToken(value: string): { start: number; typed: string } | null {
  const m = /(^|\s)@("[^"]*|\S*)$/.exec(value);
  if (!m) return null;
  const start = m.index + m[1]!.length;
  return { start, typed: value.slice(start + 1) };
}

/** A path as it goes after `@`: quoted when it holds whitespace, so `parseQuestion` reads it back whole. */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `"${path}"` : path;
}

/** True when the mention `typed` (what follows `@`) names a file that exists, read the way `parseQuestion` reads it. */
export function namesFile(typed: string, cwd: string, fs: FileProbe = nodeProbe): boolean {
  const path = QUOTED.test(typed) ? typed.slice(1, -1) : typed;
  if (path === "") return false;
  return fs.stat(resolve(cwd, process.platform === "win32" ? path : path.replaceAll("\\", "/"))) === "file";
}

const INDEX_TTL_MS = 10_000;
const INDEX_MAX = 20_000;
const WALK_BUDGET_MS = 300;
const GIT_TIMEOUT_MS = 2_000;
const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);
let index: { cwd: string; at: number; files: string[] } | null = null;

/**
 * Files under `cwd` for the `@` menu, relative and written with `/`, at most 20,000. In a git work
 * tree that is git's own list (tracked, plus untracked files that are not ignored); elsewhere a
 * breadth-first walk that skips dot-entries and `node_modules`, read one entry at a time and
 * stopped after 300 ms, so a home folder, a drive root or one huge folder cannot hang the prompt.
 * Kept for 10 s per folder. Never throws.
 */
export function listFiles(cwd: string, now = Date.now()): string[] {
  if (index && index.cwd === cwd && now - index.at < INDEX_TTL_MS) return index.files;
  const files = (gitFiles(cwd) ?? walkFiles(cwd)).slice(0, INDEX_MAX);
  index = { cwd, at: now, files };
  return files;
}

function gitFiles(cwd: string): string[] | null {
  try {
    // core.fsmonitor=false: a folder's own git config must not get to run a command just because rlmh opened there
    const r = spawnSync("git", ["-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    if (r.error || r.status !== 0) return null;
    return [...new Set(r.stdout.split("\0").filter(Boolean))];
  } catch {
    return null;
  }
}

function walkFiles(cwd: string): string[] {
  const files: string[] = [];
  const queue = [""];
  const until = Date.now() + WALK_BUDGET_MS;
  const more = () => files.length < INDEX_MAX && Date.now() < until;
  for (let next = 0; next < queue.length && more(); next++) {
    const rel = queue[next]!;
    let dir: Dir | undefined;
    try {
      dir = opendirSync(join(cwd, rel));
      // entry by entry, with the budget checked on each, rather than one readdir of a folder of any size
      for (let e = dir.readSync(); e !== null && more(); e = dir.readSync()) {
        if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
        const path = rel + e.name;
        if (e.isDirectory()) queue.push(`${path}/`);
        else if (e.isFile()) files.push(path);
        else if (e.isSymbolicLink()) {
          try {
            if (statSync(join(cwd, path)).isFile()) files.push(path);
          } catch {
            // a broken link is no file to read
          }
        }
      }
    } catch {
      // an unreadable folder adds nothing
    } finally {
      try {
        dir?.closeSync();
      } catch {
        // already closed
      }
    }
  }
  return files;
}

const MAX_SUGGESTIONS = 50;

/** Lower is better: [tier, penalty]. Null when `path` does not hold `q`'s characters in order. */
function rank(q: string, path: string): [number, number] | null {
  const p = path.toLowerCase();
  if (q === "") return [0, (p.split("/").length - 1) * 1000 + p.length];
  if (p === q) return [0, 0];
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base.startsWith(q)) return [1, base.length];
  const inBase = base.indexOf(q);
  if (inBase >= 0) return [2, inBase * 100 + base.length];
  if (p.startsWith(q)) return [3, p.length];
  const inPath = p.indexOf(q);
  if (inPath >= 0) return [4, inPath * 100 + p.length];
  // the characters in order: fewer and shorter gaps first
  let at = 0;
  let gaps = 0;
  let spread = 0;
  for (const ch of q) {
    const found = p.indexOf(ch, at);
    if (found < 0) return null;
    if (found > at && at > 0) {
      gaps += 1;
      spread += found - at;
    }
    at = found + 1;
  }
  return [5, gaps * 1000 + spread * 10 + p.length];
}

/**
 * The `@` menu's files for `typed` (the token after `@`; an opening `"` and a closing one are
 * dropped, and on win32 `\` means `/`), best first, at most 50. Case-insensitive: a whole-path
 * match, then a file name that starts with it, holds it, a path that starts with it, holds it, and
 * last the characters in order. Ties go to the shorter path, then the sorted order. An empty token
 * lists the shallowest files first.
 */
export function rankFiles(typed: string, files: readonly string[]): string[] {
  let q = typed.replace(/^"/, "").replace(/"$/, "").toLowerCase();
  if (process.platform === "win32") q = q.replaceAll("\\", "/");
  const scored: { path: string; tier: number; penalty: number }[] = [];
  for (const path of files) {
    const r = rank(q, path);
    if (r) scored.push({ path, tier: r[0], penalty: r[1] });
  }
  scored.sort((a, b) => a.tier - b.tier || a.penalty - b.penalty || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return scored.slice(0, MAX_SUGGESTIONS).map((s) => s.path);
}
