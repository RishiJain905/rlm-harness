// KV cache: none
// cli/setup.ts (step 10): finding uv, extracting the engine byte for byte, and the setup steps with
// a stand-in uv that records its argv and env. Offline: no real uv, no download. The one real check
// starts the engine extracted from the generated bundle (skipped when app/build/engine-files.ts is absent).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  SETUP_LOCK,
  classifyEngineEntry,
  ensureEngine,
  extractEngine,
  findUv,
  loadBundle,
  pruneOldEngines,
  runSetup,
  stageEngine,
  swapBack,
  swapIn,
  sweepEngine,
  type EngineBundle,
  type SetupOptions,
  type UvRunner,
} from "../src/cli/setup.ts";
import { EngineNotFound, fetchInfo, findEngine, startEngine } from "../src/engine.ts";
import { APP_VERSION, PROTOCOL_VERSION } from "../src/version.ts";

const ROOT = resolve(import.meta.dir, "..", "..");
const EXE = process.platform === "win32" ? ".exe" : "";
const COMPILED = "/$bunfs/root"; // no source checkout, as in a compiled binary
const REAL = 120_000;

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "rlmh-setup-"));
  temps.push(dir);
  return dir;
}

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/** A small bundle on disk, like the generated one: real files and their hashes. `variant` changes one file, so a second bundle is a different engine. */
function fakeBundle(variant = ""): EngineBundle {
  const src = temp();
  const contents: Record<string, string | Uint8Array> = {
    "rlm_engine/__main__.py": `print('serve${variant}')\n`,
    "rlm_engine/worker/worker.py": "# worker\r\nkeeps CRLF\r\n",
    "rlm_engine/profiles/default/guidance.md": "caf\u00e9 \u2014 bytes\n",
    "rlm_engine/blob.bin": new Uint8Array([0, 255, 13, 10, 128]),
  };
  const files = Object.entries(contents).map(([path, data]) => {
    const file = join(src, path);
    mkdirSync(resolve(file, ".."), { recursive: true });
    writeFileSync(file, data);
    return { path, sha256: sha256(readFileSync(file)), file };
  });
  return { files, sha256: sha256(files.map((f) => `${f.path}\0${f.sha256}\n`).join("")) };
}

interface Call {
  argv: string[];
  env: Record<string, string>;
}

/**
 * A stand-in uv: `python install` puts a fake Python under UV_PYTHON_INSTALL_DIR (or exits
 * `installCode`), and `python find` reports it once it exists (or `findPath`, when given).
 */
function standInUv(o: { installCode?: number; findPath?: string } = {}): { run: UvRunner; calls: Call[] } {
  const calls: Call[] = [];
  const run: UvRunner = async (argv, env) => {
    calls.push({ argv, env });
    const python = join(env.UV_PYTHON_INSTALL_DIR!, "cpython-3.12.99-test", "bin", `python${EXE}`);
    if (argv[2] === "install") {
      if ((o.installCode ?? 0) !== 0) return { code: o.installCode!, stdout: "" };
      mkdirSync(resolve(python, ".."), { recursive: true });
      writeFileSync(python, "");
      return { code: 0, stdout: "" };
    }
    if (o.findPath !== undefined && calls.some((c) => c.argv[2] === "install")) return { code: 0, stdout: `${o.findPath}\n` };
    return existsSync(python) ? { code: 0, stdout: `${python}\n` } : { code: 2, stdout: "" };
  };
  return { run, calls };
}

/** A home with a stand-in uv binary in <home>/bin, so findUv finds it. */
function homeWithUv(): string {
  const h = join(temp(), "home");
  mkdirSync(join(h, "bin"), { recursive: true });
  writeFileSync(join(h, "bin", `uv${EXE}`), "");
  return h;
}

function options(h: string, extra: Partial<SetupOptions> = {}): SetupOptions & { lines: string[] } {
  const lines: string[] = [];
  return {
    home: h,
    yes: false,
    interactive: false,
    env: { PATH: "", OPENAI_API_KEY: "sk-FAKE-1234", HF_TOKEN: "hf_FAKE", PLAIN: "kept" },
    out: (line) => lines.push(line),
    ask: async () => {
      throw new Error("asked a question");
    },
    runPython: async () => ({ code: 0, stdout: "3.12.99\nsh\n" }),
    checkEngine: async () => ({ ok: true }),
    bundle: fakeBundle(),
    lines,
    ...extra,
  };
}

const markerOf = (h: string) => join(h, "engine", APP_VERSION, ".installed.json");

describe("findUv", () => {
  test("home_bin_beats_path", () => {
    const h = homeWithUv();
    const onPath = temp();
    writeFileSync(join(onPath, `uv${EXE}`), "");
    if (process.platform !== "win32") Bun.spawnSync(["chmod", "+x", join(onPath, "uv")]);
    expect(findUv({ home: h, env: { PATH: onPath } })).toBe(join(h, "bin", `uv${EXE}`));
    expect(findUv({ home: join(temp(), "empty"), env: { PATH: onPath } })).toBe(join(onPath, `uv${EXE}`));
    expect(findUv({ home: join(temp(), "empty"), env: { PATH: temp() } })).toBeNull();
  });
});

describe("extractEngine", () => {
  test("byte_exact", () => {
    const bundle = fakeBundle();
    const dest = join(temp(), "engine", "0.1.0");
    extractEngine(bundle, dest);
    for (const f of bundle.files) expect(sha256(readFileSync(join(dest, f.path)))).toBe(f.sha256);
    expect(readdirSync(dirname(dest))).toEqual(["0.1.0"]); // no staging folder left beside it
    const all = readdirSync(dest, { recursive: true }).map(String);
    expect(all.some((p) => p.includes("__pycache__"))).toBe(false);
  });

  test("refuses_a_changed_file", () => {
    const bundle = fakeBundle();
    writeFileSync(bundle.files[0]!.file, "changed");
    expect(() => extractEngine(bundle, join(temp(), "dest"))).toThrow(/does not match/);
  });

  test("real_bundle", async () => {
    const bundle = await loadBundle();
    if (bundle === null) return; // a fresh checkout: scripts/embed-engine.ts has not run
    const paths = bundle.files.map((f) => f.path);
    for (const p of ["rlm_engine/__main__.py", "rlm_engine/worker/worker.py", "rlm_engine/profiles/training-v4/profile.toml"])
      expect(paths).toContain(p);
    expect(paths.some((p) => p.includes("__pycache__") || p.endsWith(".pyc"))).toBe(false);
    const dest = join(temp(), "engine");
    extractEngine(bundle, dest);
    for (const f of bundle.files) expect(sha256(readFileSync(join(dest, f.path)))).toBe(f.sha256);
  });
});

describe("runSetup", () => {
  test("declined", async () => {
    const h = homeWithUv();
    const uv = standInUv();
    const o = options(h, { interactive: true, ask: async () => false, runUv: uv.run });
    expect(await runSetup(o)).toBe(1);
    expect(uv.calls.filter((c) => c.argv[2] === "install")).toEqual([]);
    expect(o.lines.join("\n")).toContain("Not installed.");
    expect(existsSync(join(h, "python"))).toBe(false);
    expect(existsSync(join(h, "engine"))).toBe(false);
  });

  test("asks_once_on_a_terminal", async () => {
    const h = homeWithUv();
    const questions: string[] = [];
    const o = options(h, { interactive: true, ask: async (q) => (questions.push(q), true), runUv: standInUv().run });
    expect(await runSetup(o)).toBe(0);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain("Download it now");
    expect(questions[0]).toContain("[Y/n]");
  });

  test("no_terminal_no_yes", async () => {
    const h = homeWithUv();
    const uv = standInUv();
    const o = options(h, { runUv: uv.run });
    expect(await runSetup(o)).toBe(1);
    expect(o.lines.join("\n")).toContain("rlmh setup --yes");
    expect(uv.calls.filter((c) => c.argv[2] === "install")).toEqual([]);
  });

  test("yes_installs_then_already_installed", async () => {
    const h = homeWithUv();
    const uv = standInUv();
    const o = options(h, { yes: true, runUv: uv.run });
    expect(await runSetup(o)).toBe(0);
    const install = uv.calls.find((c) => c.argv[2] === "install")!;
    expect(install.argv.slice(1)).toEqual(["python", "install", "3.12"]);
    expect(install.env.UV_PYTHON_INSTALL_DIR).toBe(join(h, "python"));
    expect(install.env.UV_PYTHON_BIN_DIR).toBe(join(h, "python", "bin"));
    expect(install.env.UV_PYTHON_INSTALL_BIN).toBe("0");
    expect(install.env.UV_PYTHON_INSTALL_REGISTRY).toBe("0");
    for (const c of uv.calls) {
      expect(c.env.OPENAI_API_KEY).toBeUndefined();
      expect(c.env.HF_TOKEN).toBeUndefined();
      expect(c.env.PLAIN).toBe("kept");
    }
    const find = uv.calls.find((c) => c.argv[2] === "find")!;
    expect(find.env.UV_MANAGED_PYTHON).toBe("1");
    expect(find.env.UV_PYTHON_DOWNLOADS).toBe("never");
    const marker = JSON.parse(readFileSync(markerOf(h), "utf8"));
    expect(marker.python).toBe(join(h, "python", "cpython-3.12.99-test", "bin", `python${EXE}`));
    expect(marker).toMatchObject({ app_version: APP_VERSION, bundle_sha256: o.bundle!.sha256, python_version: "3.12.99" });
    expect(o.lines.join("\n")).toContain("shell() will use: sh");
    // the installed engine is what findEngine now returns from a binary
    expect(findEngine({ home: h, env: { PATH: "" }, sourceDir: COMPILED }).cmd[0]).toBe(marker.python);

    const again = standInUv();
    const o2 = options(h, { yes: true, runUv: again.run, bundle: o.bundle });
    expect(await runSetup(o2)).toBe(0);
    expect(o2.lines.join("\n")).toContain("already installed");
    expect(again.calls).toEqual([]);
  });

  test("force_reinstalls", async () => {
    const h = homeWithUv();
    const bundle = fakeBundle();
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle }))).toBe(0);
    const uv = standInUv();
    expect(await runSetup(options(h, { yes: true, force: true, runUv: uv.run, bundle }))).toBe(0);
    expect(uv.calls.find((c) => c.argv[2] === "install")!.argv.slice(1)).toEqual(["python", "install", "3.12", "--reinstall"]);
  });

  test("upgrade_reuses_python", async () => {
    const h = homeWithUv();
    const python = join(h, "python", "cpython-3.12.98-test", "bin", `python${EXE}`);
    mkdirSync(resolve(python, ".."), { recursive: true });
    writeFileSync(python, "");
    mkdirSync(join(h, "engine", "0.0.9"), { recursive: true });
    writeFileSync(join(h, "engine", "0.0.9", ".installed.json"), JSON.stringify({ app_version: "0.0.9", bundle_sha256: "old", python }));
    const uv = standInUv();
    const o = options(h, { runUv: uv.run }); // no --yes, no terminal: an upgrade needs neither
    expect(await runSetup(o)).toBe(0);
    expect(uv.calls).toEqual([]);
    expect(JSON.parse(readFileSync(markerOf(h), "utf8")).python).toBe(python);
    expect(existsSync(join(h, "engine", APP_VERSION, "rlm_engine", "__main__.py"))).toBe(true);
  });

  test("download_fails", async () => {
    const h = homeWithUv();
    const o = options(h, { yes: true, runUv: standInUv({ installCode: 3 }).run });
    expect(await runSetup(o)).toBe(1);
    const text = o.lines.join("\n");
    expect(text).toContain("uv exited 3");
    expect(text).toContain("UV_PYTHON_INSTALL_MIRROR");
    expect(existsSync(markerOf(h))).toBe(false);
    expect(existsSync(join(h, "engine", APP_VERSION))).toBe(false);
  });

  test("python_outside_home_refused", async () => {
    const h = homeWithUv();
    const outside = join(temp(), `python${EXE}`);
    writeFileSync(outside, "");
    const o = options(h, { yes: true, runUv: standInUv({ findPath: outside }).run });
    expect(await runSetup(o)).toBe(1);
    expect(o.lines.join("\n")).toContain("refusing");
    expect(existsSync(markerOf(h))).toBe(false);
  });

  test("no_uv", async () => {
    const h = join(temp(), "home");
    const o = options(h, { yes: true, runUv: standInUv().run });
    expect(await runSetup(o)).toBe(1);
    expect(o.lines.join("\n")).toContain("uv was not found in");
    expect(existsSync(h)).toBe(false);
  });

  test("engine_check_fails", async () => {
    const h = homeWithUv();
    const o = options(h, {
      yes: true,
      runUv: standInUv().run,
      checkEngine: async () => ({ ok: false, message: "boom", stderr: ["Traceback: the tail"] }),
    });
    expect(await runSetup(o)).toBe(1);
    expect(o.lines).toContain("Traceback: the tail");
    expect(existsSync(markerOf(h))).toBe(false);
  });

  test("long_home_warning", async () => {
    const base = join(temp(), "h");
    for (const [length, warns] of [[70, true], [40, false]] as const) {
      const h = length > base.length ? base + "x".repeat(length - base.length) : `C:\\${"x".repeat(length - 3)}`;
      expect(h).toHaveLength(length);
      const o = options(h, { platform: "win32", yes: true, runUv: standInUv().run });
      await runSetup(o);
      expect(o.lines.some((l) => l.includes("RLMH_HOME=C:\\rlmh"))).toBe(warns);
    }
  });

  test("source_run_has_no_bundle", async () => {
    const o = options(homeWithUv(), { yes: true, bundle: null });
    expect(await runSetup(o)).toBe(1);
    expect(o.lines.join("\n")).toContain("from source");
  });
});

describe("staging and swapping the engine folder", () => {
  const mainPy = (dir: string) => readFileSync(join(dir, "rlm_engine", "__main__.py"), "utf8");

  test("staging folders are unique, never the old fixed <dest>.tmp, and do not disturb each other", () => {
    const bundle = fakeBundle();
    const dest = join(temp(), "engine", "0.1.0");
    const a = stageEngine(bundle, dest);
    const b = stageEngine(bundle, dest);
    expect(a).not.toBe(b);
    expect([a, b]).not.toContain(`${dest}.tmp`);
    expect(mainPy(a)).toBe("print('serve')\n");
    expect(swapIn(a, dest)).toBeNull();
    expect(mainPy(b)).toBe("print('serve')\n"); // b is still there
    expect(mainPy(dest)).toBe("print('serve')\n");
  });

  test("a bundle that fails its check leaves the installed engine and no staging folder", () => {
    const dest = join(temp(), "engine", "0.1.0");
    extractEngine(fakeBundle("-old"), dest);
    const bad = fakeBundle("-new");
    writeFileSync(bad.files[0]!.file, "changed");
    expect(() => extractEngine(bad, dest)).toThrow(/does not match/);
    expect(mainPy(dest)).toBe("print('serve-old')\n");
    expect(readdirSync(dirname(dest))).toEqual(["0.1.0"]);
  });

  test("swapIn keeps the old engine aside until it is discarded, and swapBack restores it", () => {
    const parent = join(temp(), "engine");
    const dest = join(parent, "0.1.0");
    extractEngine(fakeBundle("-old"), dest);
    const aside = swapIn(stageEngine(fakeBundle("-new"), dest), dest);
    expect(aside).not.toBeNull();
    expect(mainPy(dest)).toBe("print('serve-new')\n");
    expect(mainPy(aside!)).toBe("print('serve-old')\n");
    swapBack(dest, aside);
    expect(mainPy(dest)).toBe("print('serve-old')\n");
    expect(readdirSync(parent)).toEqual(["0.1.0"]);

    // with nothing before it, swapBack removes the new engine
    const fresh = join(parent, "0.2.0");
    const none = swapIn(stageEngine(fakeBundle(), fresh), fresh);
    expect(none).toBeNull();
    swapBack(fresh, none);
    expect(readdirSync(parent)).toEqual(["0.1.0"]);
  });

  test("sweepEngine restores the engine a crash between the two renames set aside, and removes the rest", () => {
    const parent = join(temp(), "engine");
    const dest = join(parent, "0.1.0");
    const oldA = `${dest}.old-1-aaaa`;
    const oldB = `${dest}.old-2-bbbb`;
    for (const [dir, text] of [[oldA, "older"], [oldB, "newer"]] as const) {
      mkdirSync(join(dir, "rlm_engine"), { recursive: true });
      writeFileSync(join(dir, "rlm_engine", "__main__.py"), text);
    }
    utimesSync(oldA, new Date(2020, 0, 1), new Date(2020, 0, 1));
    utimesSync(oldB, new Date(2021, 0, 1), new Date(2021, 0, 1));
    mkdirSync(`${dest}.tmp-3-cccc`);
    mkdirSync(`${dest}.tmp`); // the name an earlier rlmh used
    writeFileSync(`${dest}.lock`, "{}");
    mkdirSync(join(parent, "0.0.9"));
    sweepEngine(dest);
    expect(readFileSync(join(dest, "rlm_engine", "__main__.py"), "utf8")).toBe("newer");
    expect(readdirSync(parent).sort()).toEqual(["0.0.9", "0.1.0", "0.1.0.lock"]);

    // with the engine in place nothing is restored, and what was set aside goes
    mkdirSync(`${dest}.old-4-dddd`);
    sweepEngine(dest);
    expect(readFileSync(join(dest, "rlm_engine", "__main__.py"), "utf8")).toBe("newer");
    expect(readdirSync(parent).sort()).toEqual(["0.0.9", "0.1.0", "0.1.0.lock"]);
    sweepEngine(join(parent, "no-such-engine")); // nothing there: no error
  });
});

describe("runSetup: overlapping setups, a held lock and a failed replacement", () => {
  const saved = { ...SETUP_LOCK };
  beforeEach(() => {
    SETUP_LOCK.pollMs = 10;
  });
  afterEach(() => {
    Object.assign(SETUP_LOCK, saved);
  });

  const lockOf = (h: string) => join(h, "engine", `${APP_VERSION}.lock`);
  const mainPy = (h: string) => readFileSync(join(h, "engine", APP_VERSION, "rlm_engine", "__main__.py"), "utf8");
  const leftovers = (h: string) => readdirSync(join(h, "engine")).filter((e) => e !== APP_VERSION);
  const holdLock = (h: string, owner: object) => {
    mkdirSync(join(h, "engine"), { recursive: true });
    writeFileSync(lockOf(h), JSON.stringify(owner));
  };

  test("two setups at once take turns: one installs, the other finds it done", async () => {
    const h = homeWithUv();
    const bundle = fakeBundle();
    const uv = standInUv();
    let inside = 0;
    let most = 0;
    let probes = 0;
    const runPython: UvRunner = async () => {
      probes += 1;
      most = Math.max(most, (inside += 1));
      await Bun.sleep(120);
      inside -= 1;
      return { code: 0, stdout: "3.12.99\nsh\n" };
    };
    const a = options(h, { yes: true, runUv: uv.run, bundle, runPython });
    const b = options(h, { yes: true, runUv: uv.run, bundle, runPython });
    expect(await Promise.all([runSetup(a), runSetup(b)])).toEqual([0, 0]);
    expect(most).toBe(1);
    expect(probes).toBe(1);
    expect(uv.calls.filter((c) => c.argv[2] === "install")).toHaveLength(1); // one download, not two
    const said = [...a.lines, ...b.lines].join("\n");
    expect(said).toContain("waiting for it");
    expect(said).toContain("already installed");
    expect(JSON.parse(readFileSync(markerOf(h), "utf8")).bundle_sha256).toBe(bundle.sha256);
    expect(leftovers(h)).toEqual([]); // no staging folder, no set-aside engine, no lock file
  });

  test("a lock held by a live setup is waited for, then the setup goes ahead", async () => {
    const h = homeWithUv();
    holdLock(h, { pid: process.pid, at: Date.now() });
    const o = options(h, { yes: true, runUv: standInUv().run });
    const result = runSetup(o);
    await Bun.sleep(150);
    expect(existsSync(markerOf(h))).toBe(false); // still waiting
    expect(o.lines.join("\n")).toContain("waiting for it");
    rmSync(lockOf(h));
    expect(await result).toBe(0);
    expect(existsSync(markerOf(h))).toBe(true);
    expect(existsSync(lockOf(h))).toBe(false);
  });

  test("a lock left by a process that is gone is taken over", async () => {
    const h = homeWithUv();
    const gone = Bun.spawn({ cmd: [process.execPath, "-e", ""], stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    holdLock(h, { pid: gone.pid, at: Date.now() });
    const o = options(h, { yes: true, runUv: standInUv().run });
    expect(await runSetup(o)).toBe(0);
    expect(o.lines.join("\n")).not.toContain("waiting for it");
    expect(existsSync(lockOf(h))).toBe(false);
  });

  test("an old lock is abandoned even when its pid is alive, and an unreadable fresh one is respected", async () => {
    const h = homeWithUv();
    holdLock(h, { pid: process.pid, at: Date.now() - 2 * SETUP_LOCK.staleMs });
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run }))).toBe(0);

    const h2 = homeWithUv();
    mkdirSync(join(h2, "engine"), { recursive: true });
    writeFileSync(lockOf(h2), "{half a"); // being written
    SETUP_LOCK.waitMs = 100;
    await expect(runSetup(options(h2, { yes: true, runUv: standInUv().run }))).rejects.toThrow(/\.lock/);
    expect(existsSync(markerOf(h2))).toBe(false);
  });

  test("giving up after the wait names the lock file", async () => {
    const h = homeWithUv();
    holdLock(h, { pid: process.pid, at: Date.now() });
    SETUP_LOCK.waitMs = 60;
    await expect(runSetup(options(h, { yes: true, runUv: standInUv().run }))).rejects.toThrow(`another rlmh setup has held ${lockOf(h)}`);
    expect(existsSync(lockOf(h))).toBe(true); // not ours to remove
  });

  /** An engine installed from `variant`, then a forced setup of `next` that goes wrong in the way `fail` says. */
  async function failedReplacement(fail: Partial<SetupOptions>, next = fakeBundle("-new")) {
    const h = homeWithUv();
    const first = fakeBundle("-old");
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle: first }))).toBe(0);
    const o = options(h, { yes: true, force: true, runUv: standInUv().run, bundle: next, ...fail });
    expect(await runSetup(o)).toBe(1);
    // the engine that was there is still there, with its marker, and nothing is left beside it
    expect(mainPy(h)).toBe("print('serve-old')\n");
    expect(JSON.parse(readFileSync(markerOf(h), "utf8")).bundle_sha256).toBe(first.sha256);
    expect(leftovers(h)).toEqual([]);
    return o.lines.join("\n");
  }

  test("a new engine that does not start leaves the old one in place", async () => {
    const said = await failedReplacement({ checkEngine: async () => ({ ok: false, message: "boom", stderr: ["Traceback: the tail"] }) });
    expect(said).toContain("The installed engine did not start: boom");
    expect(said).toContain("Traceback: the tail");
  });

  test("a Python that does not run leaves the old engine in place", async () => {
    const said = await failedReplacement({ runPython: async () => ({ code: 1, stdout: "" }) });
    expect(said).toContain("did not run");
  });

  test("a bundle that fails its own check never touches the old engine", async () => {
    const bad = fakeBundle("-new");
    writeFileSync(bad.files[0]!.file, "changed");
    const said = await failedReplacement({}, bad);
    expect(said).toContain("Could not put the engine");
    expect(said).toContain("does not match");
  });

  test("a replacement that works discards the old engine", async () => {
    const h = homeWithUv();
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle: fakeBundle("-old") }))).toBe(0);
    const next = fakeBundle("-new");
    expect(await runSetup(options(h, { yes: true, force: true, runUv: standInUv().run, bundle: next }))).toBe(0);
    expect(mainPy(h)).toBe("print('serve-new')\n");
    expect(JSON.parse(readFileSync(markerOf(h), "utf8")).bundle_sha256).toBe(next.sha256);
    expect(leftovers(h)).toEqual([]);
  });

  test("a setup killed between the two renames is repaired by the next one", async () => {
    const h = homeWithUv();
    const bundle = fakeBundle("-old");
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle }))).toBe(0);
    const dest = join(h, "engine", APP_VERSION);
    renameSync(dest, `${dest}.old-9-dead`); // the engine set aside, the new one never arrived
    mkdirSync(`${dest}.tmp-9-dead`);
    const o = options(h, { yes: true, runUv: standInUv().run, bundle });
    expect(await runSetup(o)).toBe(0);
    expect(mainPy(h)).toBe("print('serve-old')\n");
    expect(basename(dest)).toBe(APP_VERSION);
    expect(leftovers(h)).toEqual([]);
  });
});

describe("old engine versions are removed once this version's engine is in place", () => {
  const engines = (h: string) => join(h, "engine");
  const names = (h: string) => readdirSync(engines(h)).sort();
  const saved = { ...SETUP_LOCK };
  beforeEach(() => {
    SETUP_LOCK.pollMs = 10;
  });
  afterEach(() => {
    Object.assign(SETUP_LOCK, saved);
  });

  async function deadPid(): Promise<number> {
    const gone = Bun.spawn({ cmd: [process.execPath, "-e", ""], stdout: "ignore", stderr: "ignore" });
    await gone.exited;
    return gone.pid;
  }

  /** Other versions' folders as an upgrade leaves them, and neighbours that are not engines. */
  async function strew(h: string): Promise<void> {
    const e = engines(h);
    const dir = (name: string, files: Record<string, string> = { "rlm_engine/__main__.py": "old" }) => {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(e, name, path)), { recursive: true });
        writeFileSync(join(e, name, path), text);
      }
    };
    dir("0.0.9", { ".installed.json": '{"python":"p"}', "rlm_engine/__main__.py": "old" });
    dir("0.0.8"); // named like a version, no marker
    dir("0.0.7.old-1-aaaa"); // an old setup's leftovers, no lock beside them
    dir("0.0.7.tmp-2-bbbb");
    dir("custom-engine", { ".installed.json": "{}" }); // a marker is enough
    writeFileSync(join(e, "0.0.5.lock"), JSON.stringify({ pid: await deadPid(), at: Date.now() })); // its owner is gone
    // not to be touched: a setup of another version that is running now, and what is not an engine at all
    dir("0.0.6");
    dir("0.0.6.tmp-3-cccc");
    writeFileSync(join(e, "0.0.6.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }));
    dir("notes", { "todo.txt": "mine" });
    writeFileSync(join(e, "readme.txt"), "mine");
    writeFileSync(join(e, "0.0.4"), "a file, not a folder");
  }
  const KEPT = ["0.0.4", "0.0.6", "0.0.6.lock", "0.0.6.tmp-3-cccc", APP_VERSION, "notes", "readme.txt"].sort();

  async function installed(): Promise<{ h: string; bundle: EngineBundle }> {
    const h = homeWithUv();
    const bundle = fakeBundle();
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle }))).toBe(0);
    return { h, bundle };
  }

  test("classifyEngineEntry names what a folder in <home>/engine is", () => {
    expect(classifyEngineEntry("0.1.0")).toEqual({ version: "0.1.0", kind: "version" });
    expect(classifyEngineEntry("0.1.0-rc.1")).toEqual({ version: "0.1.0-rc.1", kind: "version" });
    expect(classifyEngineEntry("0.1.0.lock")).toEqual({ version: "0.1.0", kind: "lock" });
    expect(classifyEngineEntry("0.1.0.tmp-12-ab")).toEqual({ version: "0.1.0", kind: "staging" });
    expect(classifyEngineEntry("0.1.0.old-12-ab")).toEqual({ version: "0.1.0", kind: "staging" });
    expect(classifyEngineEntry("0.1.0.tmp")).toEqual({ version: "0.1.0", kind: "staging" });
    expect(classifyEngineEntry("0.1.0-rc.1.tmp-3-aa")).toEqual({ version: "0.1.0-rc.1", kind: "staging" });
    for (const other of ["notes", "readme.txt", "0.1", "v0.1.0", "0.1.0.bak", ".tmp-1", "x.lock", ""]) expect(classifyEngineEntry(other)).toBeNull();
  });

  test("a fresh install or an upgrade removes the other versions, and only those", async () => {
    const h = homeWithUv();
    await strew(h);
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run }))).toBe(0);
    expect(names(h)).toEqual(KEPT);
    // what was kept is untouched
    expect(readFileSync(join(engines(h), "notes", "todo.txt"), "utf8")).toBe("mine");
    expect(existsSync(join(engines(h), "0.0.6", "rlm_engine", "__main__.py"))).toBe(true);
    expect(existsSync(markerOf(h))).toBe(true);
  });

  test("an install that is already there is tidied too, without waiting for the lock", async () => {
    const { h, bundle } = await installed();
    await strew(h);
    const o = options(h, { yes: true, runUv: standInUv().run, bundle });
    expect(await runSetup(o)).toBe(0);
    expect(o.lines.join("\n")).toContain("already installed");
    expect(names(h)).toEqual(KEPT);

    // a setup of this version running now: nothing is removed, nothing is waited for, its lock stays
    await strew(h);
    const lock = join(engines(h), `${APP_VERSION}.lock`);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const started = Date.now();
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle }))).toBe(0);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(existsSync(join(engines(h), "0.0.9"))).toBe(true);
    expect(existsSync(lock)).toBe(true);
    rmSync(lock);
    expect(await runSetup(options(h, { yes: true, runUv: standInUv().run, bundle }))).toBe(0);
    expect(names(h)).toEqual(KEPT);
  });

  test("the start-up check (ensureEngine) tidies when the installed engine is the one in use, and not from a source checkout", async () => {
    const { h } = await installed();
    await strew(h);
    await ensureEngine(options(h, { sourceDir: join(ROOT, "app", "src") })); // a source checkout: its own engine is used, the home's folders are not touched
    expect(names(h)).toContain("0.0.9");
    await ensureEngine(options(h, { env: { PATH: "", RLMH_ENGINE: "my-engine serve" }, sourceDir: COMPILED })); // an override likewise
    expect(names(h)).toContain("0.0.9");
    await ensureEngine(options(h, { sourceDir: COMPILED }));
    expect(names(h)).toEqual(KEPT);
  });

  test("an upgrade (the old engine's Python is reused) removes the old engine's folder", async () => {
    const h = homeWithUv();
    const python = join(h, "python", "cpython-3.12.98-test", "bin", `python${EXE}`);
    mkdirSync(resolve(python, ".."), { recursive: true });
    writeFileSync(python, "");
    mkdirSync(join(h, "engine", "0.0.9"), { recursive: true });
    writeFileSync(join(h, "engine", "0.0.9", ".installed.json"), JSON.stringify({ python }));
    await ensureEngine(options(h, { sourceDir: COMPILED }));
    expect(names(h)).toEqual([APP_VERSION]);
    expect(existsSync(python)).toBe(true); // the Python is shared, and stays
    expect(JSON.parse(readFileSync(markerOf(h), "utf8")).python).toBe(python);
  });

  test("nothing is removed while this version's engine is not whole: the old one is the fallback", async () => {
    const h = homeWithUv();
    await strew(h);
    const o = options(h, { yes: true, runUv: standInUv().run, checkEngine: async () => ({ ok: false, message: "boom", stderr: [] }) });
    expect(await runSetup(o)).toBe(1);
    expect(names(h)).toContain("0.0.9");
    expect(names(h)).not.toContain(APP_VERSION);
    expect(await pruneOldEngines(h)).toEqual({ removed: [], left: [] });
    expect(names(h)).toContain("0.0.9");
  });

  test.skipIf(process.platform !== "win32")("a folder a running older rlmh still uses stays whole and is removed next time", async () => {
    const { h } = await installed();
    const old = join(engines(h), "0.0.9");
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, ".installed.json"), "{}");
    writeFileSync(join(old, "keep.py"), "in use");
    // the old engine's Python runs with the engine folder as its working directory
    const running = Bun.spawn({ cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"], cwd: old, stdout: "ignore", stderr: "ignore" });
    try {
      await Bun.sleep(300);
      const first = await pruneOldEngines(h);
      expect(first).toEqual({ removed: [], left: ["0.0.9"] });
      expect(readFileSync(join(old, "keep.py"), "utf8")).toBe("in use"); // not half-deleted
    } finally {
      running.kill();
      await running.exited;
    }
    expect(await pruneOldEngines(h)).toEqual({ removed: ["0.0.9"], left: [] });
    expect(names(h)).toEqual([APP_VERSION]);
  });
});

describe("ensureEngine", () => {
  test("no_terminal_throws", async () => {
    const h = homeWithUv();
    const uv = standInUv();
    const o = options(h, { runUv: uv.run, sourceDir: COMPILED });
    let caught: unknown;
    const started = Date.now();
    try {
      await ensureEngine(o);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineNotFound);
    expect((caught as Error).message).toContain("rlmh setup --yes");
    expect((caught as Error).message).toContain("RLMH_ENGINE");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(uv.calls.filter((c) => c.argv[2] === "install")).toEqual([]);
  });

  test("rlmh_engine_returns_at_once", async () => {
    const o = options(join(temp(), "home"), { env: { PATH: "", RLMH_ENGINE: "my-engine serve" }, sourceDir: COMPILED });
    await ensureEngine(o);
    expect(o.lines).toEqual([]);
  });

  test("upgrade_without_a_question", async () => {
    const h = homeWithUv();
    const python = join(h, "python", "cpython-3.12.98-test", "bin", `python${EXE}`);
    mkdirSync(resolve(python, ".."), { recursive: true });
    writeFileSync(python, "");
    mkdirSync(join(h, "engine", "0.0.9"), { recursive: true });
    writeFileSync(join(h, "engine", "0.0.9", ".installed.json"), JSON.stringify({ python }));
    const uv = standInUv();
    const o = options(h, { runUv: uv.run, sourceDir: COMPILED });
    await ensureEngine(o);
    expect(o.lines).toEqual([`Copying the engine for rlmh ${APP_VERSION} to ${join(h, "engine", APP_VERSION)}`]);
    expect(uv.calls).toEqual([]);
    expect(findEngine({ home: h, env: { PATH: "" }, sourceDir: COMPILED }).cwd).toBe(join(h, "engine", APP_VERSION));
  });

  test("declined_is_reported", async () => {
    const h = homeWithUv();
    const o = options(h, { interactive: true, ask: async () => false, runUv: standInUv().run, sourceDir: COMPILED });
    let caught: unknown;
    try {
      await ensureEngine(o);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(EngineNotFound);
    expect((caught as EngineNotFound).reported).toBe(true);
    expect(o.lines.join("\n")).toContain("Not installed.");
  });
});

test(
  "installed_engine_answers",
  async () => {
    // the real bundle, extracted, started the way a binary starts it: python -E -s -X utf8 -m rlm_engine
    const bundle = await loadBundle();
    if (bundle === null) return;
    const which = Bun.spawnSync(["uv", "run", "--project", join(ROOT, "engine"), "python", "-c", "import sys; print(sys.executable)"], {
      stderr: "ignore",
    });
    const python = which.stdout.toString().trim();
    expect(python).not.toBe("");
    const h = join(temp(), "home");
    const dest = join(h, "engine", APP_VERSION);
    extractEngine(bundle, dest);
    writeFileSync(join(dest, ".installed.json"), JSON.stringify({ python }));
    const engine = startEngine(findEngine({ home: h, sourceDir: COMPILED }));
    try {
      const info = await fetchInfo(engine.link);
      expect(info.protocol).toBe(PROTOCOL_VERSION);
      expect(info.version).toBe(APP_VERSION);
    } finally {
      engine.kill();
      await engine.exited;
    }
  },
  REAL,
);
