// KV cache: none
// What counts as a test in a repo task's work copy, and how its tests are run. Ported from `rlm_rl/grader.py` in
// RishiJain905/rlm (last changed at commit 55e2d62, read at dev_rishi's tip 042e486), for the `python` language:
// `TEST_DIRS`, `TEST_NAMES`, `TEST_CONFIGS`, `INI_TEST_SECTIONS`, `TOML_TEST_SECTIONS`, `SECTIONED`,
// `is_test_path`, `is_test_config`, `touches_test_config`, `PYTEST_BOOT_TEMPLATE`, and the arguments
// `Pytest.commands` builds. `test/eval/junit-vectors.json` holds inputs and outputs that training's own
// functions produced, and `test/eval/junit.test.ts` checks this file against them.
//
// Paths are POSIX-relative (`/`), as the model sees them (D-17). Names match case-sensitively, as on training's
// Linux. Not ported: the other languages, `package.json`'s test keys (a web copy reverts the whole file),
// `Cargo.toml`, `pom.xml`, `build.gradle`. Training reads a change as the hunks of a `git diff`; here the caller
// gives the file's text before and after, and `touchesTestConfig` diffs them by lines.

// ------------------------------------------------------------------------------------ what counts as a test

/** A folder by this name anywhere in the path holds tests. */
export const TEST_DIRS = ["tests", "test"] as const;
/** File names (fnmatch patterns) of tests. */
export const TEST_NAMES = ["test_*.py", "*_test.py"] as const;
/** Whole files that configure the test run, new or existing. */
export const TEST_CONFIGS = ["conftest.py", "pytest.ini", "tox.ini", "noxfile.py", ".coveragerc"] as const;

/** `fnmatch.fnmatchcase` for patterns made of literals and `*`. */
function fnmatch(name: string, pattern: string): boolean {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`, "s").test(name);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** A test file: the runner's own naming, or a test folder anywhere above it. */
export function isTestPath(path: string): boolean {
  const parts = path.split("/");
  const last = parts[parts.length - 1]!;
  if (TEST_NAMES.some((pattern) => fnmatch(last, pattern))) return true;
  return parts.slice(0, -1).some((dir) => (TEST_DIRS as readonly string[]).includes(dir));
}

/** A file that configures the test run as a whole. */
export function isTestConfig(path: string): boolean {
  const name = baseName(path);
  return TEST_CONFIGS.some((pattern) => fnmatch(name, pattern));
}

// Python's `\s`, `\w` and `str.strip()` read more characters than JavaScript's, so the section headers are
// written with explicit classes.
const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const WORD = "\\p{L}\\p{N}_";
const STRIP = new RegExp(`^[${SPACE}]+|[${SPACE}]+$`, "gu");

/** Python's `str.strip()`. */
function pyStrip(text: string): string {
  return text.replace(STRIP, "");
}

/** Sections of `setup.cfg` that configure tests. */
export const INI_TEST_SECTIONS = new RegExp(
  `^\\[(tool:pytest|pytest|coverage:[^\\n]*|tool:tox|testenv[^\\n]*|tox[^\\n]*)\\][${SPACE}]*$`,
  "u",
);
/** Tables of `pyproject.toml` that configure tests. */
export const TOML_TEST_SECTIONS = new RegExp(
  `^\\[\\[?[${SPACE}]*(tool\\.pytest[${WORD}.\\-]*|tool\\.tox[${WORD}.\\-]*|tool\\.coverage[${WORD}.\\-]*|test|tool\\.vitest[${WORD}.\\-]*)[${SPACE}]*\\]?\\][${SPACE}]*$`,
  "u",
);
/** Shared config files whose sections can hold test configuration: a changed line inside one is a test change. */
export const SECTIONED: Readonly<Record<string, RegExp>> = {
  "setup.cfg": INI_TEST_SECTIONS,
  "pyproject.toml": TOML_TEST_SECTIONS,
};

/** `(first line, is a test section)` for each section, in order; line numbers are 1-based. */
function sectionsOf(lines: string[], header: RegExp): Array<[number, boolean]> {
  const out: Array<[number, boolean]> = [[1, false]];
  lines.forEach((line, k) => {
    const s = pyStrip(line);
    if (s.startsWith("[")) out.push([k + 1, header.test(s)]);
  });
  return out;
}

function inTestSection(sections: Array<[number, boolean]>, lineno: number): boolean {
  let current = false;
  for (const [start, test] of sections) {
    if (start <= lineno) current = test;
    else break;
  }
  return current;
}

interface Tok {
  /** What a line is compared by: its text, marked when it has no newline after it (git diffs those apart). */
  key: string;
  text: string;
}

function tokens(text: string): Tok[] {
  const lines = text.split("\n");
  const last = lines.pop()!;
  const out = lines.map((line) => ({ key: line, text: line }));
  if (last !== "") out.push({ key: `${last}\u0000no newline`, text: last });
  return out;
}

const MAX_CELLS = 4_000_000;

/**
 * Where `after` differs from `before`, in the terms training's `_hunk_lines` reads a diff: the old line numbers of
 * removed lines (1-based), and, for each added line, the old line number it comes in front of (`n`; a run of
 * changes puts its removals first, so `n` is the line after the run's last removal) and its text.
 */
function changedLines(before: string, after: string): { removed: number[]; added: Array<{ n: number; text: string }> } {
  const a = tokens(before);
  const b = tokens(after);
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo]!.key === b[lo]!.key) lo++;
  let ea = a.length;
  let eb = b.length;
  while (ea > lo && eb > lo && a[ea - 1]!.key === b[eb - 1]!.key) {
    ea--;
    eb--;
  }
  const rows = ea - lo;
  const cols = eb - lo;
  // Matched (old, new) pairs of a longest common subsequence of the middle, as indexes into it.
  const matches: Array<[number, number]> = [];
  if (rows * cols <= MAX_CELLS) {
    const width = cols + 1;
    const lcs = new Uint32Array((rows + 1) * width);
    for (let x = rows - 1; x >= 0; x--) {
      for (let y = cols - 1; y >= 0; y--) {
        lcs[x * width + y] =
          a[lo + x]!.key === b[lo + y]!.key
            ? lcs[(x + 1) * width + y + 1]! + 1
            : Math.max(lcs[(x + 1) * width + y]!, lcs[x * width + y + 1]!);
      }
    }
    let x = 0;
    let y = 0;
    while (x < rows && y < cols) {
      if (a[lo + x]!.key === b[lo + y]!.key) {
        matches.push([x, y]);
        x++;
        y++;
      } else if (lcs[(x + 1) * width + y]! >= lcs[x * width + y + 1]!) x++;
      else y++;
    }
  } // else: too big to align, so the whole middle counts as replaced
  matches.push([rows, cols]);

  const removed: number[] = [];
  const added: Array<{ n: number; text: string }> = [];
  let x = 0;
  let y = 0;
  for (const [mx, my] of matches) {
    for (; x < mx; x++) removed.push(lo + x + 1);
    for (; y < my; y++) added.push({ n: lo + mx + 1, text: b[lo + y]!.text });
    x = mx + 1;
    y = my + 1;
  }
  return { removed, added };
}

/**
 * Training's `touches_test_config`, for `python`: whether a change to this file is a change to test configuration.
 * A whole-file config (`conftest.py`, `pytest.ini`, `tox.ini`, ...) always is. In `setup.cfg` and `pyproject.toml`
 * it is when a removed line sat inside a test section, when a line was added inside one (after a line of one), or
 * when a test section's header was added. `before` or `after` is null for a file that is new or deleted. Nothing
 * changed means false.
 */
export function touchesTestConfig(path: string, before: string | null, after: string | null): boolean {
  if (before === after) return false;
  if (isTestConfig(path)) return true;
  const name = baseName(path);
  if (!Object.hasOwn(SECTIONED, name)) return false;
  const header = SECTIONED[name]!;
  const old = before ?? "";
  const { removed, added } = changedLines(old, after ?? "");
  const sections = sectionsOf(old.split("\n"), header);
  if (removed.some((n) => inTestSection(sections, n))) return true;
  if (added.some(({ n }) => n > 1 && inTestSection(sections, n - 1))) return true;
  return added.some(({ text }) => header.test(pyStrip(text)));
}

// ----------------------------------------------------------------------------------------- per track

/**
 * Whether a path in a task's work copy is a test path for that track, so grading reverts it (architecture §6.4).
 * Every track gets the python rules: `isTestPath` and `isTestConfig`, whose folders and names match at any depth.
 * Web copies add `*.spec.*` at any depth, and, at the copy's root only, `playwright.config.*`, `package.json`,
 * `pnpm-lock.yaml` and everything under `vendor/` (where step 1 puts Web-Bench's `test-util`). Kernel copies add,
 * at the root only, `gpu.py`, `gpu_compat.h` and `kernels.py`. Root-only because only the root's files steer the
 * run, and a nested `package.json` or `vendor/` is ordinary code a model may write. (`tests/` and `test/` are
 * python rules, so they cover Web-Bench's `test/` and the kernel tasks' `tests/` at any depth.)
 */
export function isTrackTestPath(track: "python" | "kernel" | "web", path: string): boolean {
  if (isTestPath(path) || isTestConfig(path)) return true;
  if (track === "web") {
    return (
      fnmatch(baseName(path), "*.spec.*") ||
      (!path.includes("/") && fnmatch(path, "playwright.config.*")) ||
      path === "package.json" ||
      path === "pnpm-lock.yaml" ||
      path.startsWith("vendor/")
    );
  }
  if (track === "kernel") return path === "gpu.py" || path === "gpu_compat.h" || path === "kernels.py";
  return false;
}

// ----------------------------------------------------------------------------------------- running pytest

/**
 * `python -m pytest`, except that pytest, its built-in plugins and the standard modules it imports late are
 * imported before the repository joins `sys.path`, so no file in the repository can stand in for them (red-team
 * F1: a `pytest.py` became the runner). The repository's entries then go back where they were, and the working
 * directory in front, as `-m` puts it. Training's, byte for byte: `%r` is the repository path as a Python string
 * literal.
 */
export const PYTEST_BOOT_TEMPLATE = `import os, sys
repo = os.path.realpath(%r)
def inside(p):
    p = os.path.realpath(p or '.')
    return p == repo or p.startswith(repo + os.sep)
if sys.path and not sys.path[0]:
    del sys.path[0]
kept = [(i, p) for i, p in enumerate(sys.path) if inside(p)]
sys.path[:] = [p for p in sys.path if not inside(p)]
import pytest
try:
    from _pytest.config import default_plugins
except Exception:
    default_plugins = ()
for name in default_plugins:
    try:
        __import__('_pytest.' + name)
    except Exception:
        pass
import doctest, pdb, unittest
for i, p in kept:
    sys.path.insert(i, p)
sys.path.insert(0, os.getcwd())
import runpy
runpy.run_module('pytest', run_name='__main__', alter_sys=True)
`;

/** Characters Python's `repr` writes as an escape: control characters and what `str.isprintable` refuses. */
const UNPRINTABLE = /^[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]$/u;

/** Python's `repr(str)`: the text as a string literal that reads back as itself. */
function pyRepr(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (ch === quote || ch === "\\") out += `\\${ch}`;
    else if (ch === "\t") out += "\\t";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp < 0x7f) out += ch;
    else if (!UNPRINTABLE.test(ch)) out += ch;
    else if (cp <= 0xff) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (cp <= 0xffff) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += `\\U${cp.toString(16).padStart(8, "0")}`;
  }
  return out + quote;
}

/** Training's `pytest_boot(repo)`: the `-c` code for a copy at `copyDir`. */
export function pytestBoot(copyDir: string): string {
  return PYTEST_BOOT_TEMPLATE.replace("%r", () => pyRepr(copyDir));
}

/**
 * What `Pytest.commands` puts after `python -c <boot>`: no cache provider, xunit1 (it keeps each test's file),
 * a JUnit report at `junitPath`, short tracebacks, quiet, then the test files.
 */
export function pytestArgs(junitPath: string, files: string[]): string[] {
  return ["-p", "no:cacheprovider", "-o", "junit_family=xunit1", `--junitxml=${junitPath}`, "--tb=short", "-q", ...files];
}
