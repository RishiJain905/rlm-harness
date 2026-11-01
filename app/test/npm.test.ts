// KV cache: none
// The npm packages (D-130): rlmh's postinstall (npm/rlmh/install.js) run under Node in temp
// node_modules layouts, the placeholder bin's Unix fallback run with sh, and the templates. The
// platform binaries are stand-ins; scripts/npm-pack.sh and real installs are the CI npm job's.

import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const NPM = join(ROOT, "npm");
const NODE = Bun.which("node");
const WIN = process.platform === "win32";
const EXE = WIN ? ".exe" : "";
const HOST = `${process.platform}-${process.arch}`;
const lib = createRequire(import.meta.url)(join(NPM, "rlmh", "install.js")) as {
  PLATFORMS: string[];
  UNSUPPORTED: string;
  platformKey: (platform: string, arch: string, musl: boolean) => string;
};

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "rlmh-npm-"));
  temps.push(dir);
  return dir;
}

/**
 * A global node_modules with rlmh and @rlmh/<HOST>, nested inside rlmh as npm does, or beside it as
 * Bun and pnpm do. The stand-in rlmh is a shell script that prints its argv, so sh can exec it.
 */
function layout(where: "nested" | "beside" | "none"): { modules: string; pkg: string; platform: string } {
  const modules = join(temp(), "node_modules");
  const pkg = join(modules, "rlm-harness");
  mkdirSync(join(pkg, "bin"), { recursive: true });
  copyFileSync(join(NPM, "rlmh", "install.js"), join(pkg, "install.js"));
  copyFileSync(join(NPM, "rlmh", "bin", "rlmh.exe"), join(pkg, "bin", "rlmh.exe"));
  const platform = where === "nested" ? join(pkg, "node_modules", "@rlmh", HOST) : join(modules, "@rlmh", HOST);
  if (where !== "none") {
    mkdirSync(join(platform, "bin"), { recursive: true });
    writeFileSync(join(platform, "package.json"), JSON.stringify({ name: `@rlmh/${HOST}`, version: "0.0.0" }));
    writeFileSync(join(platform, "bin", `rlmh${EXE}`), "#!/bin/sh\necho \"real rlmh $*\"\n", { mode: 0o755 });
    writeFileSync(join(platform, "bin", `uv${EXE}`), "stand-in uv\n", { mode: 0o755 });
  }
  return { modules, pkg, platform };
}

function postinstall(pkg: string) {
  const r = Bun.spawnSync([NODE!, "install.js"], { cwd: pkg, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stderr: r.stderr.toString() };
}

describe("templates", () => {
  test("rlmh_package_shape", () => {
    const pkg = JSON.parse(readFileSync(join(NPM, "rlmh", "package.json"), "utf8"));
    expect(pkg.name).toBe("rlm-harness");
    expect(pkg.bin).toEqual({ rlmh: "bin/rlmh.exe" });
    expect(pkg.scripts).toEqual({ postinstall: "node install.js" });
    expect(pkg.dependencies).toBeUndefined();
    expect(Object.keys(pkg.optionalDependencies).sort()).toEqual(lib.PLATFORMS.map((p) => `@rlmh/${p}`).sort());
    for (const f of ["bin/rlmh.exe", "install.js"]) expect(pkg.files).toContain(f);
  });

  test("placeholder_has_no_shebang_and_lf", () => {
    // a #! line would make npm's Windows cmd-shim run node or sh on the binary that replaces it
    const bytes = readFileSync(join(NPM, "rlmh", "bin", "rlmh.exe"), "latin1");
    expect(bytes.startsWith("#!")).toBe(false);
    expect(bytes.includes("\r")).toBe(false);
  });

  test("unsupported_platforms", () => {
    for (const p of lib.PLATFORMS) expect(lib.platformKey(p.split("-")[0]!, p.split("-")[1]!, false)).toBe(p);
    expect(() => lib.platformKey("linux", "arm64", false)).toThrow(lib.UNSUPPORTED);
    expect(() => lib.platformKey("linux", "x64", true)).toThrow("(musl)");
    expect(() => lib.platformKey("win32", "arm64", false)).toThrow("This machine is win32 arm64.");
    expect(() => lib.platformKey("freebsd", "x64", false)).toThrow(lib.UNSUPPORTED);
  });
});

describe.skipIf(NODE === null || !lib.PLATFORMS.includes(HOST))("postinstall under node", () => {
  for (const where of ["nested", "beside"] as const) {
    test(`links_the_binary_and_uv_${where}`, () => {
      const { pkg, platform } = layout(where);
      const r = postinstall(pkg);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
      const bin = join(pkg, "bin", "rlmh.exe");
      expect(readFileSync(bin)).toEqual(readFileSync(join(platform, "bin", `rlmh${EXE}`)));
      expect(readFileSync(join(pkg, "bin", `uv${EXE}`))).toEqual(readFileSync(join(platform, "bin", `uv${EXE}`)));
      expect(statSync(bin).nlink).toBeGreaterThanOrEqual(2); // a hard link, not a 120 MB copy
      if (!WIN) expect(statSync(bin).mode & 0o777).toBe(0o755);
      // a re-run (bun pm -g trust after a plain install) leaves no temp file
      expect(postinstall(pkg).code).toBe(0);
      expect(readdirSync(join(pkg, "bin")).sort()).toEqual(["rlmh.exe", `uv${EXE}`].sort());
    });
  }

  test("missing_platform_package", () => {
    const { pkg } = layout("none");
    const before = readFileSync(join(pkg, "bin", "rlmh.exe"));
    const r = postinstall(pkg);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`@rlmh/${HOST} is not installed`);
    expect(r.stderr).toContain("--omit=optional");
    expect(readFileSync(join(pkg, "bin", "rlmh.exe"))).toEqual(before);
  });
});

describe.skipIf(WIN || !lib.PLATFORMS.includes(HOST))("placeholder fallback with sh", () => {
  // the postinstall did not run: a shell or execvp runs the placeholder with /bin/sh
  for (const where of ["nested", "beside"] as const) {
    test(`execs_the_platform_binary_${where}`, () => {
      const { pkg } = layout(where);
      const r = Bun.spawnSync(["sh", join(pkg, "bin", "rlmh.exe"), "run", "--json"], { stdout: "pipe", stderr: "pipe" });
      expect(r.stdout.toString()).toBe("real rlmh run --json\n");
      expect(r.stderr.toString()).toContain("bun pm -g trust rlm-harness");
      expect(r.exitCode).toBe(0);
    });
  }

  test("follows_the_global_bin_link", () => {
    const { modules, pkg } = layout("beside");
    const link = join(modules, "..", "rlmh");
    symlinkSync(join(pkg, "bin", "rlmh.exe"), link);
    const r = Bun.spawnSync(["sh", link, "--version"], { stdout: "pipe", stderr: "pipe" });
    expect(r.stdout.toString()).toBe("real rlmh --version\n");
  });

  test("no_platform_package", () => {
    const { pkg } = layout("none");
    const r = Bun.spawnSync(["sh", join(pkg, "bin", "rlmh.exe")], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("--omit=optional");
    expect(existsSync(join(pkg, "bin", "uv"))).toBe(false);
  });
});
