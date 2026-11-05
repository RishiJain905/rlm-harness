// KV cache: none
// Candidate profile folders for the tuner (v1 step 6, D-207, D-208, D-233): a candidate's profile.toml
// is the base's file edited key by key, so frozen keys keep their exact bytes; guidance.md, skills/ and
// scripts/ (and, under D-234's gate, agents/ and nudges.toml) are copied from the base and then edited.
// Candidates live under the tune's output folder and are installed into <home>/profiles/ only while
// runs need them.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { stripKeys } from "../engine.ts";
import { profilesDir } from "../paths.ts";

/** A whole edit as a session submits it (architecture §7.4). */
export interface ProfileEdit {
  /** null keeps the base's text. */
  guidance: string | null;
  /** Dotted `<table>.<key>` to value. */
  toml: Record<string, unknown>;
  /** A path in the folder to its new text, or null to remove it. */
  files?: Record<string, string | null>;
}

export class CandidateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateError";
  }
}

const SKILL_PATH = /^skills\/[^/\\]+\/SKILL\.md$/;
const SCRIPT_PATH = /^scripts\/[^/\\]+\.py$/;
const AGENT_PATH = /^agents\/[^/\\]+\/AGENT\.md$/;

/** Null when `path` may go in `files`, else why not (task 4's rule). */
export function filePathProblem(path: string, gated = false): string | null {
  if (path.includes("\\")) return `${path}: use / in paths, not \\`;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return `${path}: an absolute path`;
  if (path.split("/").some((p) => p === ".." || p === "." || p === "")) return `${path}: .., . and empty parts aren't allowed`;
  if (path === "profile.toml" || path === "guidance.md") return `${path}: change it through ${path === "profile.toml" ? "toml" : "guidance"}, not files`;
  if (SKILL_PATH.test(path) || SCRIPT_PATH.test(path)) return null;
  if (AGENT_PATH.test(path) || path === "nudges.toml") return gated ? null : `${path}: agents/ and nudges.toml need --gated (D-234)`;
  return `${path}: only skills/<name>/SKILL.md and scripts/<name>.py${gated ? ", agents/<name>/AGENT.md and nudges.toml" : ""} may change`;
}

/** A value as TOML: bools, integers, floats with a `.`, strings JSON-quoted. */
export function tomlValue(v: unknown): string {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new CandidateError(`${v} is not a TOML number`);
    if (Number.isInteger(v) && !Object.is(v, -0)) return String(v);
    const s = String(v);
    return /[.eE]/.test(s) ? s : `${s}.0`;
  }
  if (typeof v === "string") return JSON.stringify(v);
  throw new CandidateError(`${JSON.stringify(v)} is not a TOML bool, number or string`);
}

const tableOf = (line: string): string | null => {
  const m = /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(line);
  return m ? m[1]!.trim() : null;
};
const keyOf = (line: string): string | null => {
  const m = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
  return m ? m[1]! : null;
};

/** The comment after a value, or "" (a `#` inside a quoted string is not one). */
function trailingComment(rest: string): string {
  let quote: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return rest.slice(i).replace(/\s+$/, "");
  }
  return "";
}

/**
 * Edits profile.toml text a line at a time (D-207). An existing `key = …` in `[table]` gets its value
 * replaced, keeping a trailing comment; a missing key goes after the table's last key line; a missing
 * table is appended. Everything else keeps its bytes.
 */
export function editToml(text: string, edits: Record<string, unknown>): string {
  const lines = text.split("\n");
  const trailingNewline = text.endsWith("\n");
  if (trailingNewline) lines.pop();
  for (const [dotted, value] of Object.entries(edits)) {
    const at = dotted.lastIndexOf(".");
    if (at <= 0) throw new CandidateError(`${dotted}: a TOML edit is <table>.<key>`);
    const table = dotted.slice(0, at);
    const key = dotted.slice(at + 1);
    const rendered = tomlValue(value);
    let current: string | null = null;
    let lastKeyLine = -1;
    let header = -1;
    let done = false;
    for (let i = 0; i < lines.length; i++) {
      const t = tableOf(lines[i]!);
      if (t !== null) {
        if (current === table && header >= 0) break; // left the table
        current = t;
        if (t === table) {
          header = i;
          lastKeyLine = i;
        }
        continue;
      }
      if (current !== table) continue;
      const k = keyOf(lines[i]!);
      if (k === null) continue;
      lastKeyLine = i;
      if (k !== key) continue;
      const eq = lines[i]!.indexOf("=");
      const comment = trailingComment(lines[i]!.slice(eq + 1));
      const lead = lines[i]!.slice(0, eq).replace(/\s+$/, "");
      lines[i] = `${lead} = ${rendered}${comment ? `  ${comment}` : ""}`;
      done = true;
      break;
    }
    if (done) continue;
    if (header >= 0) {
      lines.splice(lastKeyLine + 1, 0, `${key} = ${rendered}`);
    } else {
      while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
      lines.push("", `[${table}]`, `${key} = ${rendered}`);
    }
  }
  return lines.join("\n") + (trailingNewline || lines.length > 0 ? "\n" : "");
}

/** LF UTF-8 bytes with no BOM; a lone CR stays, for check_tunable to refuse. */
const lf = (text: string) => Buffer.from(text.replace(/^﻿/, "").replace(/\r\n/g, "\n"), "utf8");

/** The optional folders and files a profile may carry beside profile.toml and guidance.md. */
function extras(gated: boolean): string[] {
  return gated ? ["skills", "scripts", "agents", "nudges.toml"] : ["skills", "scripts"];
}

/**
 * Writes a candidate into `dir` (which must not exist): the base's profile.toml edited by `edit.toml`,
 * guidance.md (the base's when `edit.guidance` is null), the base's skills/ and scripts/ (and the gated
 * files with `gated`), then `edit.files`. Every path in `files` is checked before anything is written.
 */
export function writeCandidate(dir: string, baseDir: string, edit: ProfileEdit, o: { gated?: boolean } = {}): void {
  const gated = o.gated ?? false;
  const files = edit.files ?? {};
  const problems = Object.keys(files)
    .map((p) => filePathProblem(p, gated))
    .filter((p): p is string => p !== null);
  if (problems.length > 0) throw new CandidateError(problems.join("\n"));
  for (const [p, v] of Object.entries(files)) {
    if (v !== null && typeof v !== "string") throw new CandidateError(`${p}: a file's value is its text or null`);
  }
  if (existsSync(dir)) throw new CandidateError(`${dir} already exists`);
  mkdirSync(dir, { recursive: true });
  const toml = readFileSync(join(baseDir, "profile.toml"), "utf8");
  writeFileSync(join(dir, "profile.toml"), lf(editToml(toml, edit.toml)));
  const guidance = edit.guidance ?? readFileSync(join(baseDir, "guidance.md"), "utf8");
  writeFileSync(join(dir, "guidance.md"), lf(guidance));
  for (const name of extras(gated)) {
    const from = join(baseDir, name);
    if (existsSync(from)) cpSync(from, join(dir, name), { recursive: true, filter: (src) => !src.includes("__pycache__") && !src.endsWith(".pyc") });
  }
  for (const [p, v] of Object.entries(files)) {
    const target = join(dir, ...p.split("/"));
    if (v === null) {
      rmSync(target, { force: true });
      if (p.startsWith("skills/") || p.startsWith("agents/")) removeIfEmpty(dirname(target));
    } else {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, lf(v));
    }
  }
  for (const name of ["skills", "scripts", "agents"]) removeIfEmpty(join(dir, name));
}

function removeIfEmpty(dir: string): void {
  try {
    if (statSync(dir).isDirectory() && readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // gone already
  }
}

/** `git diff --no-index` of two profile folders, subfolders included; "" when they are the same. */
export async function diffProfiles(a: string, b: string): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", "-c", "core.autocrlf=false", "-c", "core.quotepath=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--", resolve(a), resolve(b)],
    stdout: "pipe",
    stderr: "pipe",
    env: stripKeys({ ...process.env, GIT_CONFIG_NOSYSTEM: "1" }),
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code === 0) return "";
  if (code === 1) return out;
  throw new CandidateError(`git diff --no-index failed (exit ${code}): ${err.trim()}`);
}

/** Copies a candidate folder to <home>/profiles/<name>/; refuses an existing folder. Returns the target. */
export function installProfile(home: string, from: string, name: string): string {
  const target = join(profilesDir(home), name);
  if (existsSync(target)) throw new CandidateError(`${target} already exists`);
  mkdirSync(profilesDir(home), { recursive: true });
  cpSync(from, target, { recursive: true });
  return target;
}

/** Removes the profile folders a tune installed, and nothing else. */
export function uninstallProfiles(home: string, names: Iterable<string>): void {
  for (const name of names) rmSync(join(profilesDir(home), name), { recursive: true, force: true });
}
