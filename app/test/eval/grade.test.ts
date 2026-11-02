// KV cache: none
// gradeRepo with the real runners on the fixture's repo tasks. Python always runs: the venvs are built
// with UV_OFFLINE=1 from uv's cache. The kernel cases need a GPU (the real probe decides), and the web
// cases need RLMH_TEST_PNPM_STORE and PLAYWRIGHT_BROWSERS_PATH filled by prepare-web.sh, plus node and the
// pinned pnpm on PATH; otherwise they skip and say why.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gradeRepo } from "../../src/eval/graders.ts";
import { loadSet, type EvalSet, type RepoTask, type TestsGrade } from "../../src/eval/set.ts";
import {
  ensureNodeEnv,
  ensureVenv,
  extractShim,
  findNodeTools,
  installNodeModules,
  makeWorkCopy,
  nodeToolsProblem,
  probeGpu,
  removeSrcPth,
  SRC_PTH,
  writeSrcPth,
  type ReadyTools,
  type Venv,
} from "../../src/eval/work.ts";
import { buildFixtureSet } from "./fixture.ts";

const LONG = 240_000;
let tmp: string;
let home: string;
let set: EvalSet;
let n = 0;
const uv = Bun.which("uv");
const offline = { ...process.env, UV_OFFLINE: "1" };
const task = (id: string) => set.tasks.find((t) => t.id === id) as RepoTask;
const grade = (id: string) => set.grades.get(id) as TestsGrade;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rlmh-grade-"));
  home = join(tmp, "home");
  set = loadSet(buildFixtureSet(tmp));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function copyOf(id: string): Promise<{ dir: string; base: string; logDir: string }> {
  const dir = join(tmp, "work", `${id}-${n++}`);
  const base = await makeWorkCopy(set, task(id), dir);
  return { dir, base, logDir: join(tmp, "grade-logs", `${id}-${n}`) };
}

const FIX = '"""A tiny calculator with one bug."""\n\n\ndef add(a, b):\n    return a + b\n\n\ndef mul(a, b):\n    return a * b\n';

describe.skipIf(uv === null)("python", () => {
  let fx: Venv;
  let fxSrc: Venv;
  beforeAll(async () => {
    fx = await ensureVenv(set, "fx", { home, uv: uv!, env: offline });
    fxSrc = await ensureVenv(set, "fx-src", { home, uv: uv!, env: offline });
  }, LONG);

  test(
    "the base fails f2p; with the fix written the task resolves",
    async () => {
      const c = await copyOf("fx-python-S-01");
      const before = await gradeRepo(task("fx-python-S-01"), grade("fx-python-S-01"), { ...c, set, python: fx.python });
      expect(before.grade_error).toBeNull();
      expect(before).toMatchObject({ resolved: false, f2p_share: 0, test_tamper: false });
      expect(before.results.get("tests/test_basic.py::test_mul")).toBe("passed");
      expect(before.results.get("tests/test_fix.py::test_add")).toBe("failed");
      expect(readFileSync(join(c.logDir, "output.txt"), "utf8")).toContain("test_add");
      expect(existsSync(join(c.logDir, "junit.xml"))).toBe(true);

      const fixed = await copyOf("fx-python-S-01");
      writeFileSync(join(fixed.dir, "calc", "__init__.py"), FIX);
      const after = await gradeRepo(task("fx-python-S-01"), grade("fx-python-S-01"), { ...fixed, set, python: fx.python });
      expect(after).toMatchObject({ resolved: true, f2p_share: 1, test_tamper: false, grade_error: null });
    },
    LONG,
  );

  test(
    "an edited visible test is reverted and a new conftest.py deleted, both flagged",
    async () => {
      const c = await copyOf("fx-python-S-01");
      writeFileSync(join(c.dir, "tests", "test_basic.py"), "def test_mul():\n    assert True\n");
      writeFileSync(join(c.dir, "conftest.py"), "import pytest\n");
      const g = await gradeRepo(task("fx-python-S-01"), grade("fx-python-S-01"), { ...c, set, python: fx.python });
      expect(g.test_tamper).toBe(true);
      expect(g.reverted).toEqual(["conftest.py", "tests/test_basic.py"]);
      expect(existsSync(join(c.dir, "conftest.py"))).toBe(false);
      expect(readFileSync(join(c.dir, "tests", "test_basic.py"), "utf8")).toContain("mul(2, 3) == 6");
    },
    LONG,
  );

  test(
    "a pytest.py in the copy doesn't replace the runner",
    async () => {
      const c = await copyOf("fx-python-S-01");
      writeFileSync(join(c.dir, "pytest.py"), "raise SystemExit('not the real pytest')\n");
      writeFileSync(join(c.dir, "calc", "__init__.py"), FIX);
      const g = await gradeRepo(task("fx-python-S-01"), grade("fx-python-S-01"), { ...c, set, python: fx.python });
      expect(g).toMatchObject({ resolved: true, grade_error: null });
    },
    LONG,
  );

  test(
    "a 1-second timeout_s on a sleeping test gives grade_error",
    async () => {
      const c = await copyOf("fx-python-S-01");
      process.env.FX_SLEEP = "30";
      try {
        const g = await gradeRepo(task("fx-python-S-01"), { ...grade("fx-python-S-01"), timeout_s: 1 }, { ...c, set, python: fx.python });
        expect(g.resolved).toBe(false);
        expect(g.grade_error).toContain("timeout_s");
      } finally {
        delete process.env.FX_SLEEP;
      }
    },
    LONG,
  );

  test(
    "the src layout imports the copy's calc through the .pth, which is gone afterwards",
    async () => {
      const c = await copyOf("fx-python-S-02");
      writeFileSync(join(c.dir, "src", "calc", "__init__.py"), FIX);
      writeSrcPth(fxSrc, c.dir);
      try {
        const g = await gradeRepo(task("fx-python-S-02"), grade("fx-python-S-02"), { ...c, set, python: fxSrc.python });
        expect(g).toMatchObject({ resolved: true, grade_error: null });
      } finally {
        removeSrcPth(fxSrc);
      }
      expect(existsSync(join(fxSrc.purelib, SRC_PTH))).toBe(false);
      const without = await copyOf("fx-python-S-02");
      writeFileSync(join(without.dir, "src", "calc", "__init__.py"), FIX);
      const g = await gradeRepo(task("fx-python-S-02"), grade("fx-python-S-02"), { ...without, set, python: fxSrc.python });
      expect(g.resolved).toBe(false); // calc is not importable without it
    },
    LONG,
  );

  test(
    "a key-like variable never reaches the tests",
    async () => {
      const c = await copyOf("fx-python-S-01");
      const dump = join(tmp, "env-names.txt");
      process.env.FAKE_TEST_KEY = "sk-FAKE-never-shown";
      process.env.FX_ENV_DUMP = dump;
      try {
        await gradeRepo(task("fx-python-S-01"), grade("fx-python-S-01"), { ...c, set, python: fx.python });
      } finally {
        delete process.env.FAKE_TEST_KEY;
        delete process.env.FX_ENV_DUMP;
      }
      const names = readFileSync(dump, "utf8").split(/\r?\n/);
      expect(names).toContain("FX_ENV_DUMP");
      expect(names).toContain("PYTHONUTF8");
      expect(names).not.toContain("FAKE_TEST_KEY");
    },
    LONG,
  );
});

// -- kernel: only with a GPU --

let kernelVenv: Venv | null = null;
let kernelSkip = "uv is missing";
if (uv !== null) {
  const probeTmp = mkdtempSync(join(tmpdir(), "rlmh-gpu-"));
  try {
    const s = loadSet(buildFixtureSet(probeTmp));
    const venv = await ensureVenv(s, "fx-kernel", { home: join(probeTmp, "home"), uv, env: offline }).catch(() => null);
    if (venv === null) kernelSkip = "the kernel venv can't be built offline from uv's cache";
    else {
      const shim = extractShim(s, s.tasks.find((t) => t.id === "fx-kernel-S-01") as RepoTask, join(probeTmp, "shim"));
      const probe = await probeGpu(venv, shim).catch(() => ({ backend: "none", devices: 0 }));
      if (probe.devices > 0) kernelVenv = venv;
      else kernelSkip = "the GPU probe found no device";
    }
  } finally {
    if (kernelVenv === null) rmSync(probeTmp, { recursive: true, force: true });
  }
}
if (kernelVenv === null) console.log(`grade.test.ts: kernel cases skipped: ${kernelSkip}`);

const ADD = "GPU_KERNEL void fx_add(const float *a, const float *b, float *out, int n) {\n    int i = blockIdx.x * blockDim.x + threadIdx.x;\n    if (i < n) {\n        out[i] = a[i] + b[i];\n    }\n}\n";

describe.skipIf(kernelVenv === null)("kernel", () => {
  test(
    "the stub fails test_add; a real body resolves; an edited kernels.py or gpu.py is reverted and flagged",
    async () => {
      const python = kernelVenv!.python;
      const stub = await copyOf("fx-kernel-S-01");
      const g0 = await gradeRepo(task("fx-kernel-S-01"), grade("fx-kernel-S-01"), { ...stub, set, python });
      expect(g0.grade_error).toBeNull();
      expect(g0.results.get("tests/test_smoke.py::test_compiles_and_launches")).toBe("passed");
      expect(g0.resolved).toBe(false);
      const real = await copyOf("fx-kernel-S-01");
      writeFileSync(join(real.dir, "kernels", "add.gpu.cu"), ADD);
      const g1 = await gradeRepo(task("fx-kernel-S-01"), grade("fx-kernel-S-01"), { ...real, set, python });
      expect(g1).toMatchObject({ resolved: true, f2p_share: 1, test_tamper: false });
      const tampered = await copyOf("fx-kernel-S-01");
      writeFileSync(join(tampered.dir, "kernels.py"), "def add(a, b):\n    return a + b\n");
      writeFileSync(join(tampered.dir, "gpu.py"), "# gone\n");
      const g2 = await gradeRepo(task("fx-kernel-S-01"), grade("fx-kernel-S-01"), { ...tampered, set, python });
      expect(g2.test_tamper).toBe(true);
      expect(g2.reverted).toEqual(["gpu.py", "kernels.py"]);
      expect(g2.resolved).toBe(false);
    },
    LONG,
  );
});

// -- web: only where prepare-web.sh filled the store and the browsers --

const store = process.env.RLMH_TEST_PNPM_STORE;
const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH;
const filled = (d: string | undefined) => d !== undefined && existsSync(d) && readdirSync(d).length > 0;
const tools = await findNodeTools(process.env);
const webSkip = !filled(store)
  ? "RLMH_TEST_PNPM_STORE is not a filled folder (run app/test/eval/prepare-web.sh)"
  : !filled(browsers)
    ? "PLAYWRIGHT_BROWSERS_PATH is not a filled folder (run app/test/eval/prepare-web.sh)"
    : nodeToolsProblem(tools, { node: "22", pnpm: "10.34.7" });
if (webSkip !== null) console.log(`grade.test.ts: web cases skipped: ${webSkip}`);

const HELLO = "<!doctype html>\n<html lang=\"en\">\n  <head>\n    <meta charset=\"utf-8\" />\n    <title>fx-web</title>\n  </head>\n  <body>\n    <h1>Hello</h1>\n  </body>\n</html>\n";

describe.skipIf(webSkip !== null)("web", () => {
  let ready: ReadyTools;
  let squatter: Server;
  beforeAll(async () => {
    ready = tools as ReadyTools;
    await ensureNodeEnv(set, "fx-web", { home, tools: ready, storeDir: store! });
    // something else answers on Web-Bench's default port: grading must use its own
    squatter = createServer((_, res) => res.end("<h1>Hello</h1>"));
    await new Promise<void>((r) => squatter.listen(3211, "127.0.0.1", () => r()));
  }, LONG);
  afterAll(() => squatter?.close());

  const webCopy = async () => {
    const c = await copyOf("fx-web-S-01");
    await installNodeModules(c.dir, { home, tools: ready, storeDir: store! });
    return c;
  };
  const opts = (c: { dir: string; base: string; logDir: string }) => ({ ...c, set, pnpm: ready.pnpm, browsersDir: browsers! });

  test(
    "the base page fails task-1; with Hello written it resolves, on its own port",
    async () => {
      const base = await webCopy();
      const g0 = await gradeRepo(task("fx-web-S-01"), grade("fx-web-S-01"), opts(base));
      expect(g0.grade_error).toBeNull();
      expect(g0.results.get("task-1.spec.js::the page heading greets the visitor")).toBe("failed");
      expect(g0.resolved).toBe(false);
      const fixed = await webCopy();
      writeFileSync(join(fixed.dir, "index.html"), HELLO);
      const g1 = await gradeRepo(task("fx-web-S-01"), grade("fx-web-S-01"), opts(fixed));
      expect(g1).toMatchObject({ resolved: true, f2p_share: 1, test_tamper: false, grade_error: null });
    },
    LONG,
  );

  test(
    "a new spec is deleted and an edited playwright.config.js restored, both flagged",
    async () => {
      const c = await webCopy();
      writeFileSync(join(c.dir, "index.html"), HELLO);
      writeFileSync(join(c.dir, "test-mine.txt"), "not a test path\n");
      const mine = join(c.dir, "test");
      require("node:fs").mkdirSync(mine, { recursive: true });
      writeFileSync(join(mine, "mine.spec.js"), "require('@playwright/test').test('x', () => {})\n");
      writeFileSync(join(c.dir, "playwright.config.js"), "module.exports = {}\n");
      const g = await gradeRepo(task("fx-web-S-01"), grade("fx-web-S-01"), opts(c));
      expect(g.test_tamper).toBe(true);
      expect(g.reverted).toEqual(["playwright.config.js", "test/mine.spec.js"]);
      expect(g.resolved).toBe(true);
    },
    LONG,
  );
});
