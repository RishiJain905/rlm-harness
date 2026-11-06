// KV cache: none
// The JUnit reader, the test-id rules, the test-path rules and the pytest command against training's own outputs:
// junit-vectors.json was written by running rlm_rl/grader.py (last changed at RLM commit 55e2d62) over its inputs
// (task 4); nothing in it is typed by hand. The tests after it use small hand-written reports for what training
// has no twin for (Playwright's ids, the track rules) and for the reader's edges.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  JunitError,
  parseJunit,
  parseJunitDetailed,
  playwrightKey,
  pytestKey,
  resolvedFrom,
  type TestStatus,
} from "../../src/eval/junit.ts";
import {
  PYTEST_BOOT_TEMPLATE,
  SECTIONED,
  isTestConfig,
  isTestPath,
  isTrackTestPath,
  pytestArgs,
  pytestBoot,
  touchesTestConfig,
} from "../../src/eval/testpaths.ts";

interface Vectors {
  source: { repo: string; commit: string; read_at: string; file: string; command: string; export: string };
  pytest_key: Array<{ file: string | null; classname: string; name: string; base: string; key: string | null }>;
  test_path: Array<{ path: string; is_test_path: boolean; is_test_config: boolean }>;
  touches_test_config: Array<{ path: string; before: string | null; after: string | null; result: boolean; why: string | null }>;
  score: Array<{
    results: Record<string, TestStatus>;
    f2p: string[];
    p2p: string[];
    f2p_passed: number;
    p2p_failed: number;
    resolved: boolean;
  }>;
  junit_docs: Array<{ xml: string; wellformed: boolean; cases: Array<[string | null, string, string, TestStatus]> | null }>;
  junit_reports: Array<{
    label: string;
    xml: string;
    base: string;
    results: Array<[string, TestStatus]>;
    bad: string | null;
    real?: boolean;
  }>;
  pytest_boot_template: string;
  pytest_boot: Array<{ repo: string; code: string }>;
  pytest_args: Array<{ junit: string; files: string[]; args: string[] }>;
}

const SRC = join(import.meta.dir, "..", "..", "src", "eval");
const V = JSON.parse(readFileSync(join(import.meta.dir, "junit-vectors.json"), "utf8")) as Vectors;

/** The ways a port can disagree with a vector, listed together so one run shows them all. */
function collect<T>(items: T[], check: (item: T) => unknown | null): unknown[] {
  const out: unknown[] = [];
  for (const item of items) {
    const problem = check(item);
    if (problem !== null) out.push(problem);
  }
  return out;
}

const identityKey = (c: { file: string | null; classname: string; name: string }) => JSON.stringify([c.file, c.classname, c.name]);

describe("junit-vectors.json", () => {
  test("names training's file and commit, as the ports' headers do", () => {
    expect(V.source).toMatchObject({ repo: "RishiJain905/rlm", commit: "55e2d62", read_at: "042e486", file: "rlm_rl/grader.py" });
    expect(V.source.command).toContain("gen_vectors.py");
    for (const file of ["junit.ts", "testpaths.ts"]) {
      const header = readFileSync(join(SRC, file), "utf8").split("\n").slice(0, 8).join("\n");
      expect(header.startsWith("// KV cache: none\n")).toBe(true);
      expect(header).toContain("rlm_rl/grader.py");
      expect(header).toContain(`commit ${V.source.commit}`);
    }
  });

  test("is big enough to mean something", () => {
    expect(V.pytest_key.length).toBeGreaterThanOrEqual(25);
    expect(V.test_path.length).toBeGreaterThanOrEqual(25);
    expect(V.touches_test_config.length).toBeGreaterThanOrEqual(25);
    expect(V.junit_docs.filter((d) => d.wellformed).length).toBeGreaterThan(20);
    expect(V.junit_docs.filter((d) => !d.wellformed).length).toBeGreaterThan(40);
    expect(V.junit_reports.filter((r) => r.real).length).toBeGreaterThanOrEqual(2);
    // both outcomes appear where the answer is a boolean, so a constant function can't pass
    for (const key of ["is_test_path", "is_test_config"] as const) {
      expect(new Set(V.test_path.map((v) => v[key])).size).toBe(2);
    }
    expect(new Set(V.touches_test_config.map((v) => v.result)).size).toBe(2);
    expect(new Set(V.score.map((v) => v.resolved)).size).toBe(2);
  });

  test("pytestKey gives training's pytest_key on every input", () => {
    expect(collect(V.pytest_key, (v) => {
      const got = pytestKey(v.file, v.classname, v.name, v.base);
      return got === v.key ? null : { input: [v.file, v.classname, v.name, v.base], want: v.key, got };
    })).toEqual([]);
  });

  test("isTestPath and isTestConfig give training's is_test_path and is_test_config", () => {
    expect(collect(V.test_path, (v) => {
      const got = { is_test_path: isTestPath(v.path), is_test_config: isTestConfig(v.path) };
      return got.is_test_path === v.is_test_path && got.is_test_config === v.is_test_config ? null : { path: v.path, want: v, got };
    })).toEqual([]);
  });

  test("touchesTestConfig gives training's touches_test_config on a real git diff of each change", () => {
    expect(collect(V.touches_test_config, (v) => {
      const got = touchesTestConfig(v.path, v.before, v.after);
      return got === v.result ? null : { path: v.path, why: v.why, want: v.result, got, before: v.before, after: v.after };
    })).toEqual([]);
  });

  test("resolvedFrom gives training's score on every case", () => {
    expect(collect(V.score, (v) => {
      const got = resolvedFrom(new Map(Object.entries(v.results)), v.f2p, v.p2p);
      const want = { resolved: v.resolved, f2pPassed: v.f2p_passed, p2pFailed: v.p2p_failed };
      return JSON.stringify(got) === JSON.stringify(want) ? null : { results: v.results, f2p: v.f2p, p2p: v.p2p, want, got };
    })).toEqual([]);
  });

  test("the reader accepts and rejects what expat does, and reads the same attributes and outcomes", () => {
    expect(collect(V.junit_docs, (v) => {
      if (!v.wellformed) {
        try {
          parseJunit(v.xml, identityKey);
        } catch (err) {
          return err instanceof JunitError ? null : { xml: v.xml, threw: String(err) };
        }
        return { xml: v.xml, want: "a JunitError", got: "a result" };
      }
      let got: unknown[];
      try {
        got = [...parseJunit(v.xml, identityKey)].map(([key, status]) => [...(JSON.parse(key) as unknown[]), status]);
      } catch (err) {
        return { xml: v.xml, want: v.cases, threw: String(err) };
      }
      return JSON.stringify(got) === JSON.stringify(v.cases) ? null : { xml: v.xml, want: v.cases, got };
    })).toEqual([]);
  });

  test("parseJunitDetailed with pytestKey gives training's Pytest.parse on every report, real ones included", () => {
    expect(collect(V.junit_reports, (v) => {
      const keyOf = (c: { file: string | null; classname: string; name: string }) => pytestKey(c.file, c.classname, c.name, v.base);
      if (v.bad?.startsWith("JUnit XML doesn't parse")) {
        try {
          parseJunitDetailed(v.xml, keyOf);
        } catch (err) {
          return err instanceof JunitError ? null : { label: v.label, threw: String(err) };
        }
        return { label: v.label, want: "a JunitError" };
      }
      const { results, bad } = parseJunitDetailed(v.xml, keyOf);
      const got = { results: [...results], bad };
      const want = { results: v.results, bad: v.bad };
      return JSON.stringify(got) === JSON.stringify(want) ? null : { label: v.label, want, got };
    })).toEqual([]);
  });

  test("parseJunit throws, as training flags a report, exactly when parseJunitDetailed has a reason", () => {
    for (const v of V.junit_reports) {
      const keyOf = (c: { file: string | null; classname: string; name: string }) => pytestKey(c.file, c.classname, c.name, v.base);
      if (v.bad === null) expect(parseJunit(v.xml, keyOf).size).toBe(v.results.length);
      else expect(() => parseJunit(v.xml, keyOf)).toThrow(JunitError);
    }
  });

  test("the real reports have every outcome pytest writes, and the Linux copy reads like the Windows one", () => {
    const real = V.junit_reports.filter((r) => r.real);
    const root = real.filter((r) => r.base === ".");
    expect(new Set(root[0]!.results.map(([, s]) => s))).toEqual(new Set(["passed", "failed", "error", "skipped"]));
    expect(root[0]!.xml).toContain('file="tests\\test_basic.py"');
    expect(root[1]!.xml).toContain('file="tests/test_basic.py"');
    expect(root[0]!.results).toEqual(root[1]!.results);
    // a test whose call failed and whose teardown errored is two testcases, and the failure wins
    expect(root[0]!.results.find(([k]) => k.endsWith("::test_fail_and_teardown_error"))![1]).toBe("failed");
    expect(root[0]!.results.find(([k]) => k.endsWith("::test_pass_and_teardown_error"))![1]).toBe("error");
    // a run from a folder below the repository root carries that folder in every id
    expect(real.find((r) => r.base === "svc")!.results.every(([k]) => k.startsWith("svc/tests/test_svc.py::"))).toBe(true);
  });

  test("PYTEST_BOOT_TEMPLATE is training's, byte for byte, and pytestBoot fills it as Pytest.commands does", () => {
    expect(PYTEST_BOOT_TEMPLATE).toBe(V.pytest_boot_template);
    expect(collect(V.pytest_boot, (v) => {
      const got = pytestBoot(v.repo);
      return got === v.code ? null : { repo: v.repo, want: v.code, got };
    })).toEqual([]);
  });

  test("pytestArgs gives the arguments Pytest.commands builds after the boot code", () => {
    expect(collect(V.pytest_args, (v) => {
      const got = pytestArgs(v.junit, v.files);
      return JSON.stringify(got) === JSON.stringify(v.args) ? null : { want: v.args, got };
    })).toEqual([]);
    expect(pytestArgs("/g/junit.xml", ["a.py"])).toEqual([
      "-p", "no:cacheprovider", "-o", "junit_family=xunit1", "--junitxml=/g/junit.xml", "--tb=short", "-q", "a.py",
    ]);
  });
});

describe("parseJunit on a pytest xunit1 report", () => {
  const REPORT = `<?xml version="1.0" encoding="utf-8"?>
<testsuites name="pytest tests"><testsuite name="pytest" errors="2" failures="1" skipped="1" tests="6" time="0.1">
<testcase classname="tests.test_basic" name="test_ok" file="tests/test_basic.py" line="3" time="0.001" />
<testcase classname="tests.test_basic" name="test_bad" file="tests/test_basic.py" line="7" time="0.001"><failure message="assert 1 == 2">tests/test_basic.py:9: in test_bad
    assert 1 == 2</failure></testcase>
<testcase classname="tests.test_basic.TestK" name="test_setup" file="tests/test_basic.py" line="14" time="0.0"><error message="failed on setup">boom</error></testcase>
<testcase classname="tests.test_basic" name="test_skip[a::b]" file="tests/test_basic.py" line="20" time="0.0"><skipped type="pytest.skip" message="no" /></testcase>
<testcase classname="tests.test_basic" name="test_twice" file="tests/test_basic.py" line="30" time="0.0"><failure message="call">x</failure></testcase>
<testcase classname="tests.test_basic" name="test_twice" file="tests/test_basic.py" line="30" time="0.0"><error message="teardown">y</error></testcase>
</testsuite></testsuites>`;
  const keyOf = (c: { file: string | null; classname: string; name: string }) => pytestKey(c.file, c.classname, c.name, ".");

  test("a pass, a failure, an error, a skip, and a test reported twice", () => {
    expect([...parseJunit(REPORT, keyOf)]).toEqual([
      ["tests/test_basic.py::test_ok", "passed"],
      ["tests/test_basic.py::test_bad", "failed"],
      ["tests/test_basic.py::TestK::test_setup", "error"],
      ["tests/test_basic.py::test_skip[a::b]", "skipped"],
      ["tests/test_basic.py::test_twice", "failed"],
    ]);
  });

  test("a test reported twice merges: a failure beats an error, an error beats a pass, equal outcomes stay", () => {
    const twice = (a: string, b: string) =>
      `<testsuite><testcase classname="t" name="x" file="t.py">${a}</testcase><testcase classname="t" name="x" file="t.py">${b}</testcase></testsuite>`;
    const status = (a: string, b: string) => parseJunit(twice(a, b), keyOf).get("t.py::x");
    expect(status("<error/>", "<failure/>")).toBe("failed");
    expect(status("<failure/>", "<error/>")).toBe("failed");
    expect(status("", "<error/>")).toBe("error");
    expect(status("", "<failure/>")).toBe("failed");
    expect(status("", "")).toBe("passed");
    expect(status("<skipped/>", "<skipped/>")).toBe("skipped");
    // a skip beside any other outcome makes the report malformed, as in training
    expect(() => status("<skipped/>", "")).toThrow("t.py::x reported as both skipped and passed");
    const { results, bad } = parseJunitDetailed(twice("", "<skipped/>"), keyOf);
    expect(bad).toBe("t.py::x reported as both passed and skipped");
    expect(results.get("t.py::x")).toBe("passed");
  });

  test("a case the keying function gives no key is left out, and a case with no name has none", () => {
    expect(parseJunit(REPORT, () => null).size).toBe(0);
    const xml = '<testsuite><testcase classname="a"/><testcase classname="a" name="ok" file="a.py"/></testsuite>';
    expect([...parseJunit(xml, keyOf)]).toEqual([["a.py::ok", "passed"]]);
  });

  test("the keying function sees file as null when the attribute is absent", () => {
    const seen: unknown[] = [];
    parseJunit('<testsuite><testcase name="n" classname="c"/><testcase name="m" file="f.py"/></testsuite>', (c) => {
      seen.push(c);
      return null;
    });
    expect(seen).toEqual([
      { file: null, classname: "c", name: "n" },
      { file: "f.py", classname: "", name: "m" },
    ]);
  });
});

describe("parseJunit on XML that is not a JUnit report", () => {
  const bad: Array<[string, string]> = [
    ["empty", ""],
    ["plain text", "Traceback (most recent call last):\n  boom"],
    ["an unclosed root", '<testsuites><testsuite><testcase name="a"/>'],
    ["a mismatched end tag", "<testsuite><testcase name='a'></testsuite>"],
    ["junk after the root", "<testsuite/>junk"],
    ["two roots", "<testsuite/><testsuite/>"],
    ["an undefined entity", '<testsuite><testcase name="a&nbsp;b"/></testsuite>'],
    ["a bare ampersand", "<testsuite>a & b</testsuite>"],
    ["a duplicated attribute", '<testsuite><testcase name="a" name="b"/></testsuite>'],
    ["an unquoted attribute", "<testsuite><testcase name=a/></testsuite>"],
    ["a control character", "<testsuite>a \u0001 b</testsuite>"],
    ["a DOCTYPE that declares an entity (its entities are not read)", '<!DOCTYPE testsuite [<!ENTITY n "x">]><testsuite><testcase name="&n;"/></testsuite>'],
    ["an HTML page", "<html><body><testcase name='a'/></body></html>"],
    ["a different root that is well-formed", "<report><testcase name='a'/></report>"],
  ];
  for (const [label, xml] of bad) {
    test(label, () => {
      expect(() => parseJunit(xml, identityKey)).toThrow(JunitError);
    });
  }

  test("the message says where", () => {
    expect(() => parseJunit("<testsuite>\n  <testcase name='a'></testsuite>", identityKey)).toThrow(/mismatched tag.*line 2/);
  });
});

describe("the XML reader's edges", () => {
  test("entities decode once", () => {
    const xml = '<testsuite><testcase name="&amp;lt; &#x26;amp; &#38;#65;"/></testsuite>';
    expect([...parseJunit(xml, (c) => c.name).keys()]).toEqual(["&lt; &amp; &#65;"]);
  });

  test("an attribute named like an Object property is only an attribute", () => {
    const xml = '<testsuite><testcase __proto__="x" constructor="y" name="n" toString="z"/></testsuite>';
    expect([...parseJunit(xml, (c) => c.name).keys()]).toEqual(["n"]);
  });

  test("a big report is read in a moment, and a deeply nested one without recursion", () => {
    const cases = Array.from({ length: 20_000 }, (_, k) => `<testcase classname="t.m" name="test_${k}" file="t/m.py"><system-out>${"x".repeat(50)}</system-out></testcase>`);
    const t0 = performance.now();
    const results = parseJunit(`<testsuite>${cases.join("\n")}</testsuite>`, (c) => pytestKey(c.file, c.classname, c.name));
    expect(results.size).toBe(20_000);
    expect(performance.now() - t0).toBeLessThan(2000);
    const depth = 50_000;
    const nested = `<testsuite>${"<a>".repeat(depth)}<testcase name="deep"/>${"</a>".repeat(depth)}</testsuite>`;
    expect([...parseJunit(nested, (c) => c.name).keys()]).toEqual(["deep"]);
  });

  test("a failure, error or skip counts only as a direct child of its testcase", () => {
    const xml = `<testsuite>
      <testcase name="direct"><skipped/></testcase>
      <testcase name="nested"><wrapper><failure/></wrapper></testcase>
      <testcase name="after"/>
      <failure/>
    </testsuite>`;
    expect([...parseJunit(xml, (c) => c.name)]).toEqual([["direct", "skipped"], ["nested", "passed"], ["after", "passed"]]);
  });
});

describe("playwrightKey and a Playwright JUnit report", () => {
  const REPORT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites id="" name="" tests="6" failures="1" skipped="1" errors="0" time="3.2">
<testsuite name="task-1.spec.js" timestamp="2026-11-02T12:00:00.000Z" hostname="" tests="4" failures="1" skipped="1" errors="0" time="2.1">
<testcase name="h1 reads Hello" classname="task-1.spec.js" time="0.4">
</testcase>
<testcase name="Header › nav › has 3 links" classname="task-1.spec.js" time="0.5">
<failure message="task-1.spec.js:12:5 has 3 links" type="FAILURE">
<![CDATA[  1) task-1.spec.js:12:5 › Header › nav › has 3 links =====
    Error: expect(received).toBe(expected) // <b> &amp; </b>
]]>
</failure>
</testcase>
<testcase name="not today" classname="task-1.spec.js" time="0">
<skipped message="true">
</skipped>
</testcase>
<testcase name="saves &amp; loads &quot;state&quot;" classname="task-1.spec.js" time="0.3">
<system-out>
<![CDATA[console output]]>
</system-out>
</testcase>
</testsuite>
<testsuite name="sub\\task-2.spec.js" timestamp="2026-11-02T12:00:01.000Z" hostname="" tests="2" failures="0" skipped="0" errors="0" time="1.1">
<testcase name="windows classname" classname="sub\\task-2.spec.js" time="0.2">
</testcase>
<testcase name="Group › inner" classname="sub\\deeper\\task-3.spec.js" time="0.2">
</testcase>
</testsuite>
</testsuites>`;
  const keyOf = (c: { classname: string; name: string }) => playwrightKey(c.classname, c.name);

  test("the id is the classname with / separators, '::', then the name as the report prints it", () => {
    expect(playwrightKey("task-1.spec.js", "h1 reads Hello")).toBe("task-1.spec.js::h1 reads Hello");
    expect(playwrightKey("sub\\deeper\\task-3.spec.js", "Group › inner")).toBe("sub/deeper/task-3.spec.js::Group › inner");
    expect(playwrightKey("a/b.spec.js", "x::y")).toBe("a/b.spec.js::x::y");
    expect(playwrightKey("", "name")).toBe("::name");
  });

  test("a pass, a failure, a skip, a describe block and a backslash classname", () => {
    expect([...parseJunit(REPORT, keyOf)]).toEqual([
      ["task-1.spec.js::h1 reads Hello", "passed"],
      ["task-1.spec.js::Header › nav › has 3 links", "failed"],
      ["task-1.spec.js::not today", "skipped"],
      ['task-1.spec.js::saves & loads "state"', "passed"],
      ["sub/task-2.spec.js::windows classname", "passed"],
      ["sub/deeper/task-3.spec.js::Group › inner", "passed"],
    ]);
  });

  test("an empty report (no test ran) reads as no results, and resolves nothing", () => {
    const empty = '<?xml version="1.0" encoding="UTF-8"?>\n<testsuites id="" name="" tests="0" failures="0" skipped="0" errors="0" time="0">\n</testsuites>';
    const results = parseJunit(empty, keyOf);
    expect(results.size).toBe(0);
    expect(resolvedFrom(results, ["task-1.spec.js::h1 reads Hello"], []).resolved).toBe(false);
  });

  test("a web grade through the ids: f2p all passed and no p2p failed is resolved", () => {
    const results = parseJunit(REPORT, keyOf);
    expect(resolvedFrom(results, ["task-1.spec.js::h1 reads Hello"], ["sub/task-2.spec.js::windows classname"])).toEqual({
      resolved: true,
      f2pPassed: 1,
      p2pFailed: 0,
    });
    expect(resolvedFrom(results, ["task-1.spec.js::Header › nav › has 3 links"], []).resolved).toBe(false);
  });
});

describe("resolvedFrom", () => {
  const results = new Map<string, TestStatus>([
    ["a", "passed"],
    ["b", "passed"],
    ["c", "failed"],
    ["d", "error"],
    ["e", "skipped"],
  ]);

  test("every f2p passed and every p2p passed", () => {
    expect(resolvedFrom(results, ["a", "b"], ["a"])).toEqual({ resolved: true, f2pPassed: 2, p2pFailed: 0 });
  });

  test("a missing f2p id is not passed", () => {
    expect(resolvedFrom(results, ["a", "gone"], [])).toEqual({ resolved: false, f2pPassed: 1, p2pFailed: 0 });
  });

  test("a missing p2p id counts as failed, and so does a skipped one (training's score)", () => {
    expect(resolvedFrom(results, ["a"], ["gone"])).toEqual({ resolved: false, f2pPassed: 1, p2pFailed: 1 });
    expect(resolvedFrom(results, ["a"], ["e"])).toEqual({ resolved: false, f2pPassed: 1, p2pFailed: 1 });
    expect(resolvedFrom(results, ["a"], ["c", "d", "e", "gone", "a"]).p2pFailed).toBe(4);
  });

  test("a task with no f2p id is never resolved", () => {
    expect(resolvedFrom(results, [], ["a"])).toEqual({ resolved: false, f2pPassed: 0, p2pFailed: 0 });
  });

  test("f2pPassed over the f2p count is the f2p share", () => {
    const f2p = ["a", "b", "c", "d"];
    expect(resolvedFrom(results, f2p, []).f2pPassed / f2p.length).toBe(0.5);
  });
});

describe("isTrackTestPath", () => {
  test("every track reverts the python rules", () => {
    for (const track of ["python", "kernel", "web"] as const) {
      for (const path of ["tests/test_x.py", "test/task-1.spec.js", "a/tests/b.py", "pkg/test_mod.py", "pkg/mod_test.py", "conftest.py", "pytest.ini", "tox.ini"]) {
        expect(isTrackTestPath(track, path)).toBe(true);
      }
      for (const path of ["src/app.py", "index.html", "kernels/add.gpu.cu", "README.md"]) {
        expect(isTrackTestPath(track, path)).toBe(false);
      }
    }
  });

  test("web copies add specs at any depth, and the root's config, manifest, lockfile and vendor folder", () => {
    for (const path of ["task-1.spec.js", "src/a.spec.ts", "e2e/deep/x.spec.mjs", "playwright.config.js", "playwright.config.ts", "package.json", "pnpm-lock.yaml", "vendor/test-util/index.js", "vendor/x"]) {
      expect(isTrackTestPath("web", path)).toBe(true);
    }
    for (const path of ["src/package.json", "src/pnpm-lock.yaml", "src/playwright.config.js", "src/vendor/x.js", "vendor", "vendors/x.js", "my-vendor/x.js", "server.js", "src/index.js", "spec.js", "playwright.config.d/x"]) {
      expect(isTrackTestPath("web", path)).toBe(false);
    }
    // python and kernel copies leave those alone
    for (const track of ["python", "kernel"] as const) {
      for (const path of ["package.json", "vendor/x.js", "playwright.config.js", "src/a.spec.js"]) expect(isTrackTestPath(track, path)).toBe(false);
    }
  });

  test("kernel copies add gpu.py, gpu_compat.h and kernels.py at the root only", () => {
    for (const path of ["gpu.py", "gpu_compat.h", "kernels.py"]) {
      expect(isTrackTestPath("kernel", path)).toBe(true);
      expect(isTrackTestPath("kernel", `sub/${path}`)).toBe(false);
      expect(isTrackTestPath("python", path)).toBe(false);
      expect(isTrackTestPath("web", path)).toBe(false);
    }
    expect(isTrackTestPath("kernel", "launch.py")).toBe(false);
    expect(isTrackTestPath("kernel", "kernels/add.gpu.cu")).toBe(false);
    expect(isTrackTestPath("kernel", "tests/test_add.py")).toBe(true);
  });
});

describe("touchesTestConfig and SECTIONED", () => {
  const CFG = "[metadata]\nname = demo\n\n[tool:pytest]\naddopts = -q\n\n[flake8]\nmax-line-length = 100\n";

  test("SECTIONED names the shared config files, and nothing else is sectioned", () => {
    expect(Object.keys(SECTIONED).sort()).toEqual(["pyproject.toml", "setup.cfg"]);
  });

  test("a line changed inside a test section counts, one outside does not", () => {
    expect(touchesTestConfig("setup.cfg", CFG, CFG.replace("-q", "-x"))).toBe(true);
    expect(touchesTestConfig("setup.cfg", CFG, CFG.replace("demo", "other"))).toBe(false);
    expect(touchesTestConfig("setup.cfg", CFG, CFG.replace("100", "120"))).toBe(false);
  });

  test("whole-file test configs always count; unrelated files and unchanged files do not", () => {
    expect(touchesTestConfig("tox.ini", "[tox]\n", "[tox]\nenvlist = py\n")).toBe(true);
    expect(touchesTestConfig("pkg/conftest.py", null, "import pytest\n")).toBe(true);
    expect(touchesTestConfig("README.md", "a\n", "b\n")).toBe(false);
    expect(touchesTestConfig("setup.cfg", CFG, CFG)).toBe(false);
    expect(touchesTestConfig("tox.ini", null, null)).toBe(false);
  });

  test("a file named like an Object property is not sectioned", () => {
    for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(touchesTestConfig(name, "a\n", "b\n")).toBe(false);
      expect(isTrackTestPath("web", name)).toBe(false);
    }
  });

  test("a huge change falls back to counting the whole middle as replaced", () => {
    const many = Array.from({ length: 2500 }, (_, k) => `key${k} = ${k}`);
    const before = `[metadata]\nname = a\n[tool:pytest]\n${many.join("\n")}\n`;
    const after = `[metadata]\nname = b\n[tool:pytest]\n${many.map((l) => l.replace("=", ":")).join("\n")}\n`;
    expect(touchesTestConfig("setup.cfg", before, after)).toBe(true);
    expect(touchesTestConfig("setup.cfg", before, before.replace("name = a", "name = c"))).toBe(false);
  });
});

describe("pytestBoot", () => {
  test("holds the copy's path as a Python string literal in training's template", () => {
    const boot = pytestBoot("/tmp/work/fx-python-S-01");
    expect(boot).toContain("repo = os.path.realpath('/tmp/work/fx-python-S-01')\n");
    expect(boot).toBe(PYTEST_BOOT_TEMPLATE.replace("%r", "'/tmp/work/fx-python-S-01'"));
    expect(boot.split("\n").length).toBe(PYTEST_BOOT_TEMPLATE.split("\n").length);
  });

  test("a Windows path has its backslashes doubled, so Python reads the same path back", () => {
    const dir = "C:\\Users\\Someone\\.rlm-harness\\eval\\work\\x";
    expect(pytestBoot(dir)).toContain("os.path.realpath('C:\\\\Users\\\\Someone\\\\.rlm-harness\\\\eval\\\\work\\\\x')");
  });

  test("quotes in the path are escaped the way repr does", () => {
    expect(pytestBoot("/tmp/it's")).toContain(`os.path.realpath("/tmp/it's")`);
    expect(pytestBoot(`/tmp/both ' and "`)).toContain(`os.path.realpath('/tmp/both \\' and "')`);
  });

  test("a path with %r, $& or $1 in it comes through unchanged", () => {
    expect(pytestBoot("/tmp/%r/$&/$1")).toContain("os.path.realpath('/tmp/%r/$&/$1')");
  });
});
