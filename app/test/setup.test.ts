// KV cache: none
// cli/setup.ts (step 10): finding uv, extracting the engine byte for byte, and the setup steps with
// a stand-in uv that records its argv and env. Offline: no real uv, no download. The one real check
// starts the engine extracted from the generated bundle (skipped when app/build/engine-files.ts is absent).

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ensureEngine, extractEngine, findUv, loadBundle, runSetup, type EngineBundle, type SetupOptions, type UvRunner } from "../src/cli/setup.ts";
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

/** A small bundle on disk, like the generated one: real files and their hashes. */
function fakeBundle(): EngineBundle {
  const src = temp();
  const contents: Record<string, string | Uint8Array> = {
    "rlm_engine/__main__.py": "print('serve')\n",
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
    mkdirSync(`${dest}.tmp/rlm_engine`, { recursive: true }); // an earlier crash
    writeFileSync(`${dest}.tmp/rlm_engine/stale.py`, "stale");
    extractEngine(bundle, dest);
    for (const f of bundle.files) expect(sha256(readFileSync(join(dest, f.path)))).toBe(f.sha256);
    expect(existsSync(`${dest}.tmp`)).toBe(false);
    expect(existsSync(join(dest, "rlm_engine", "stale.py"))).toBe(false);
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
