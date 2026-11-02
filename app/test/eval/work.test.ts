// KV cache: none
// Work copies, the test hint, venvs through a recording fake uv, node envs through fake node and pnpm
// scripts on a test PATH, and the src-layout `.pth` file.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSet, type EvalSet, type RepoTask } from "../../src/eval/set.ts";
import { readTar } from "../../src/eval/tar.ts";
import {
  browserReady,
  ensureBrowser,
  ensureNodeEnv,
  ensureVenv,
  EnvError,
  fillHint,
  findNodeTools,
  git,
  installNodeModules,
  makeWorkCopy,
  nodeToolsProblem,
  parseProbe,
  pyLiteral,
  removeSrcPth,
  revertTestPaths,
  SRC_PTH,
  writeSrcPth,
  type Runner,
} from "../../src/eval/work.ts";
import { buildFixtureSet } from "./fixture.ts";

let tmp: string;
let set: EvalSet;
const task = (id: string) => set.tasks.find((t) => t.id === id) as RepoTask;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rlmh-work-"));
  set = loadSet(buildFixtureSet(tmp));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("makeWorkCopy", () => {
  test("one commit, base, with a fixed author and date and the same hash every time", async () => {
    const a = await makeWorkCopy(set, task("fx-python-S-01"), join(tmp, "copy-a"));
    const b = await makeWorkCopy(set, task("fx-python-S-01"), join(tmp, "copy-b"));
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(b).toBe(a);
    const log = (await git(join(tmp, "copy-a"), ["log", "--format=%s|%an|%ae|%ad|%cn|%ce", "--date=raw"])).stdout.trim().split("\n");
    expect(log).toEqual(["base|rlmh-eval|eval@localhost|946684800 +0000|rlmh-eval|eval@localhost"]);
    expect(readFileSync(join(tmp, "copy-a", ".git", "info", "exclude"), "utf8").split("\n")).toContain("node_modules/");
    expect((await git(join(tmp, "copy-a"), ["status", "--porcelain"])).stdout).toBe("");
  });

  test("the files are byte-identical to the tar", async () => {
    const dir = join(tmp, "copy-k");
    await makeWorkCopy(set, task("fx-kernel-S-01"), dir);
    const entries = readTar(new Uint8Array(readFileSync(join(set.dir, task("fx-kernel-S-01").base))));
    expect(entries.length).toBeGreaterThan(4);
    for (const e of entries.filter((x) => x.type === "file")) expect(readFileSync(join(dir, ...e.path.split("/"))).equals(Buffer.from(e.data))).toBe(true);
  });
});

describe("revertTestPaths", () => {
  test("a .gitignore the run wrote can't hide a new conftest.py; the base's own ignores still hold", async () => {
    const dir = join(tmp, "copy-ignore");
    const base = await makeWorkCopy(set, task("fx-python-S-01"), dir);
    writeFileSync(join(dir, ".gitignore"), "conftest.py\n__pycache__/\n");
    writeFileSync(join(dir, "conftest.py"), "import pytest\n");
    writeFileSync(join(dir, "tests", "test_basic.py"), "def test_mul():\n    assert True\n");
    const reverted = await revertTestPaths(dir, { track: "python", base });
    expect(reverted).toEqual(["conftest.py", "tests/test_basic.py"]);
    expect(existsSync(join(dir, "conftest.py"))).toBe(false);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("conftest.py\n__pycache__/\n"); // put back as the run left it
  });
});

describe("fillHint", () => {
  test("{python} and {pnpm} become / paths, quoted when they hold a space", () => {
    const py = process.platform === "win32" ? "C:\\Users\\Some One\\venv\\Scripts\\python.exe" : "/home/some one/venv/bin/python";
    const pn = process.platform === "win32" ? "C:\\npm\\pnpm.cmd" : "/usr/bin/pnpm";
    const filled = fillHint("{python} -m pytest -q && {pnpm} exec playwright test", { python: py, pnpm: pn });
    expect(filled).toBe(`"${py.replace(/\\/g, "/")}" -m pytest -q && ${pn.replace(/\\/g, "/")} exec playwright test`);
    expect(filled).not.toContain("\\");
  });
});

describe("ensureVenv", () => {
  test("a recording fake uv: venv, then pip install once, then the folder is reused", async () => {
    const home = join(tmp, "home-venv");
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push(argv);
      if (argv[1] === "venv") mkdirSync(argv[4]!, { recursive: true });
      const out = argv.includes("-c") ? `${join(home, "site")}\n` : "";
      return { code: 0, stdout: out, stderr: "", timedOut: false };
    };
    const first = await ensureVenv(set, "fx", { home, uv: "uv-fake", run });
    expect(calls.map((c) => c.slice(0, 3))).toEqual([["uv-fake", "venv", "--python"], ["uv-fake", "pip", "install"], [first.python, "-I", "-c"]]);
    expect(calls[1]!).toContain("-r");
    expect(first.purelib).toBe(join(home, "site"));
    const again = await ensureVenv(set, "fx", { home, uv: "uv-fake", run });
    expect(again).toEqual(first);
    expect(calls.length).toBe(3);
  });

  test("a failed install is an EnvError naming its log", async () => {
    const home = join(tmp, "home-venv-fail");
    const run: Runner = async (argv) => ({ code: argv[1] === "pip" ? 1 : 0, stdout: "", stderr: "no network\n", timedOut: false });
    const err = await ensureVenv(set, "fx", { home, uv: "uv-fake", run }).catch((e) => e);
    expect(err).toBeInstanceOf(EnvError);
    expect(err.log).toBe(join(home, "eval", "env-logs", "venv-fx.log"));
    expect(readFileSync(err.log, "utf8")).toContain("no network");
  });
});

/** Fake `node` and `pnpm` that log their arguments and print a version. */
function fakeTools(dir: string, versions: { node: string; pnpm: string }): { PATH: string; log: string } {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.log");
  for (const [name, version] of Object.entries(versions)) {
    if (process.platform === "win32") {
      writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\necho ${name} %*>>"${log}"\r\nif "%~1"=="--version" echo ${version}\r\nexit /b 0\r\n`);
    } else {
      writeFileSync(join(dir, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n[ "$1" = "--version" ] && echo ${version}\nexit 0\n`, { mode: 0o755 });
    }
  }
  return { PATH: dir, log };
}

describe("node envs", () => {
  test("fetch once per lockfile, install from the store, one browser per version", async () => {
    const home = join(tmp, "home-node");
    const { PATH, log } = fakeTools(join(tmp, "bin-ok"), { node: "v22.11.0", pnpm: "10.34.7" });
    const tools = await findNodeTools({ PATH });
    expect(tools.ok).toBe(true);
    if (!tools.ok) return;
    expect(tools.nodeVersion).toBe("22.11.0");
    expect(nodeToolsProblem(tools, set.nodeEnvs.get("fx-web")!)).toBeNull();
    const store = join(home, "store");
    await ensureNodeEnv(set, "fx-web", { home, tools, storeDir: store });
    await ensureNodeEnv(set, "fx-web", { home, tools, storeDir: store });
    const copy = join(tmp, "copy-web");
    await makeWorkCopy(set, task("fx-web-S-01"), copy);
    await installNodeModules(copy, { home, tools, storeDir: store });
    const browsers = join(home, "browsers");
    expect(browserReady("1.57.0", { home, browsersDir: browsers })).toBe(false);
    await ensureBrowser("1.57.0", { home, tools, copy, browsersDir: browsers });
    await ensureBrowser("1.57.0", { home, tools, copy, browsersDir: browsers });
    expect(browserReady("1.57.0", { home, browsersDir: browsers })).toBe(true);
    // Windows: the fake .cmd echoes the quotes toolCommand puts around each argument
    const calls = readFileSync(log, "utf8").split(/\r?\n/).map((l) => l.replace(/"/g, "").trim()).filter((l) => l !== "" && !l.endsWith("--version"));
    expect(calls).toEqual([
      `pnpm fetch --store-dir ${store}`,
      `pnpm install --offline --frozen-lockfile --store-dir ${store}`,
      "pnpm exec playwright install chromium",
    ]);
    expect(existsSync(join(home, "eval", "env-logs"))).toBe(true);
  });

  test("pnpm in a folder with a space, and arguments with a space and an &", async () => {
    const home = join(tmp, "home node spaced");
    const { PATH, log } = fakeTools(join(tmp, "Program Files", "nodejs"), { node: "v22.11.0", pnpm: "10.34.7" });
    const tools = await findNodeTools({ PATH });
    expect(tools.ok).toBe(true);
    if (!tools.ok) return;
    const copy = join(tmp, "copy & web");
    await makeWorkCopy(set, task("fx-web-S-01"), copy);
    const store = join(home, "store dir");
    await installNodeModules(copy, { home, tools, storeDir: store });
    const calls = readFileSync(log, "utf8").split(/\r?\n/).filter((l) => l.includes("install"));
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain(store);
  });

  test("node 20 and a pnpm off the pin are refused with their fix", async () => {
    const old = await findNodeTools({ PATH: fakeTools(join(tmp, "bin-old"), { node: "v20.18.0", pnpm: "10.34.7" }).PATH });
    expect(nodeToolsProblem(old, { node: "22", pnpm: "10.34.7" })).toContain("older than the 22 the set needs");
    const off = await findNodeTools({ PATH: fakeTools(join(tmp, "bin-off"), { node: "v22.11.0", pnpm: "11.14.0" }).PATH });
    expect(nodeToolsProblem(off, { node: "22", pnpm: "10.34.7" })).toContain("npm install -g pnpm@10.34.7");
    const none = await findNodeTools({ PATH: join(tmp, "nothing-here") });
    expect(none.ok).toBe(false);
    expect(nodeToolsProblem(none, { node: "22", pnpm: "10.34.7" })).toContain("node is not on PATH");
    const err = await ensureNodeEnv(set, "fx-web", { home: join(tmp, "h"), tools: off as never }).catch((e) => e);
    expect(err).toBeInstanceOf(EnvError);
  });
});

describe("src-layout .pth (D-196)", () => {
  test("one line with / separators and every non-ASCII character escaped; removal is quiet when it is gone", () => {
    const purelib = join(tmp, "purelib");
    mkdirSync(purelib, { recursive: true });
    const venv = { python: "python", purelib };
    const copy = join(tmp, "dir with ünï 文");
    writeSrcPth(venv, copy);
    const text = readFileSync(join(purelib, SRC_PTH), "utf8");
    expect(text.split("\n").filter((l) => l !== "")).toHaveLength(1);
    expect(text).toMatch(/^import sys; sys\.path\.append\("[ -~]+"\)\n$/);
    expect(text).not.toContain("\\\\");
    expect(text).toContain("\\u00fc");
    expect(text).toContain("\\u6587");
    expect(text).toContain("/src\")");
    expect(pyLiteral("a\\b")).toBe('"a/b"');
    removeSrcPth(venv);
    expect(existsSync(join(purelib, SRC_PTH))).toBe(false);
    removeSrcPth(venv);
  });
});

describe("parseProbe", () => {
  test("only the one-line shape", () => {
    expect(parseProbe("backend=hip devices=1\n")).toEqual({ backend: "hip", devices: 1 });
    expect(parseProbe("backend=none devices=0")).toEqual({ backend: "none", devices: 0 });
    for (const bad of ["", "backend=metal devices=1", "backend=cuda devices=1\nGeForce", "cuda 1", "backend=cuda devices=x"]) {
      expect(() => parseProbe(bad)).toThrow("one line");
    }
  });
});

