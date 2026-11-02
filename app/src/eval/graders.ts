// KV cache: none
// Grading (v1 architecture §6.3, §6.4, D-170, D-184, D-189, D-190): read answers through the port of
// training's score_answer, repo tasks through their hidden tests in the work copy, after any change to
// a test path has been reverted. Test runs get an env without key-like variables, so a key in the app's
// environment never reaches code the model wrote.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { parseJunit, playwrightKey, pytestKey, resolvedFrom, type TestStatus } from "./junit.ts";
import { scoreAnswer } from "./reward.ts";
import type { AnswerGrade, EvalSet, RepoTask, TestsGrade } from "./set.ts";
import { extractTar } from "./tar.ts";
import { pytestArgs, pytestBoot } from "./testpaths.ts";
import { childEnv, revertTestPaths, spawnRunner, toolCommand, type Runner } from "./work.ts";

export { scoreAnswer };

/** D-170, D-224: a read task passes when its score reaches its pass_score (1.0 when absent). */
export function readPassed(score: number, grade: Pick<AnswerGrade, "pass_score">): boolean {
  return score >= (grade.pass_score ?? 1);
}

export interface RepoGrade {
  resolved: boolean;
  /** f2p passed over f2p count. */
  f2p_share: number;
  test_tamper: boolean;
  /** The test paths revertTestPaths restored or deleted. */
  reverted: string[];
  grade_error: string | null;
  results: Map<string, TestStatus>;
}

export interface GradeRepoOpts {
  /** The work copy. */
  dir: string;
  /** Its `base` commit. */
  base: string;
  set: EvalSet;
  /** `<out>/grade-logs/<id>/`. */
  logDir: string;
  /** The venv's interpreter (pytest). */
  python?: string;
  /** pnpm's path (playwright). */
  pnpm?: string;
  /** Playwright's browsers. */
  browsersDir?: string;
  /** EVAL_PROJECT_PORT; picked free when absent. */
  port?: number;
  /** Added to the runner's env, such as RLMH_GPU_BACKEND. */
  env?: Record<string, string>;
  run?: Runner;
}

/** A port nothing listens on right now: bind port 0, read it, close. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Grades one repo task in its work copy after run.finished: revert, hidden tests, the runner, the report. */
export async function gradeRepo(task: RepoTask, grade: TestsGrade, o: GradeRepoOpts): Promise<RepoGrade> {
  const run = o.run ?? spawnRunner;
  mkdirSync(o.logDir, { recursive: true });
  const reverted = await revertTestPaths(o.dir, { track: task.track, base: o.base, ...(o.run ? { run: o.run } : {}) });
  extractTar(new Uint8Array(readFileSync(join(o.set.dir, grade.hidden))), o.dir);
  const junit = join(o.logDir, "junit.xml");
  let argv: string[];
  let env: Record<string, string>;
  if (grade.runner === "pytest") {
    if (o.python === undefined) throw new Error(`task ${task.id}: no interpreter to run pytest with`);
    argv = [o.python, "-c", pytestBoot(o.dir), ...pytestArgs(junit, grade.files)];
    env = childEnv(process.env, { ...o.env, PYTHONUTF8: "1" }); // D-230
  } else {
    if (o.pnpm === undefined) throw new Error(`task ${task.id}: no pnpm to run Playwright with`);
    const port = o.port ?? (await freePort());
    argv = toolCommand(o.pnpm, ["exec", "playwright", "test", "--reporter=junit", "--retries=0", ...grade.files]);
    env = childEnv(process.env, {
      ...o.env,
      PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit,
      IS_EVAL_PRODUCTION: "1",
      EVAL_PROJECT_PORT: String(port),
      ...(o.browsersDir !== undefined ? { PLAYWRIGHT_BROWSERS_PATH: o.browsersDir } : {}),
    });
    for (const name of Object.keys(env)) if (name.toUpperCase() === "CI") delete env[name]; // Web-Bench's config retries under CI
  }
  const r = await run(argv, { cwd: o.dir, env, timeoutMs: grade.timeout_s * 1000 });
  writeFileSync(join(o.logDir, "output.txt"), `${r.stdout}${r.stderr}`);
  const base = { test_tamper: reverted.length > 0, reverted };
  if (r.timedOut) return { ...base, resolved: false, f2p_share: 0, grade_error: `the tests ran past timeout_s (${grade.timeout_s} s)`, results: new Map() };
  let results: Map<string, TestStatus>;
  try {
    const xml = readFileSync(junit, "utf8");
    results =
      grade.runner === "pytest"
        ? parseJunit(xml, (c) => pytestKey(c.file, c.classname, c.name, "."))
        : parseJunit(xml, (c) => playwrightKey(c.classname, c.name));
  } catch (err) {
    return { ...base, resolved: false, f2p_share: 0, grade_error: `no usable JUnit report (exit ${r.code}): ${(err as Error).message}`, results: new Map() };
  }
  const { resolved, f2pPassed } = resolvedFrom(results, grade.f2p, grade.p2p);
  return { ...base, resolved, f2p_share: grade.f2p.length === 0 ? 0 : f2pPassed / grade.f2p.length, grade_error: null, results };
}

const fold = (s: string) => (process.platform === "win32" || process.platform === "darwin" ? s.toLowerCase() : s);

/**
 * True when the run's messages hold the set folder's path (either separator), `hidden/`, the function name of
 * a pytest f2p id, or a Playwright f2p title of 20 characters or more. It never changes `resolved`.
 */
export function leakSuspect(messages: unknown, o: { setDir: string; grade: AnswerGrade | TestsGrade }): boolean {
  const text = fold(JSON.stringify(messages ?? []));
  // JSON escapes a backslash, so the Windows spelling of the path is looked for escaped too
  const dir = o.setDir.replace(/[\\/]+$/, "");
  const needles = [dir.replace(/\\/g, "/"), JSON.stringify(dir.replace(/\//g, "\\")).slice(1, -1), "hidden/"];
  if (o.grade.grader === "tests") {
    for (const id of o.grade.f2p) {
      const last = id.split("::").pop() ?? "";
      if (o.grade.runner === "pytest") {
        const fn = last.replace(/\[.*$/s, "");
        if (fn !== "") needles.push(fn);
      } else if (last.length >= 20) {
        needles.push(JSON.stringify(last).slice(1, -1));
      }
    }
  }
  return needles.some((n) => n !== "" && text.includes(fold(n)));
}
