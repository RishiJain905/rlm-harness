// KV cache: none
// online.ts (v1 step 9, tasks 4 and 5) on createFakeApp({tune}): the estimate's medians and fallbacks, nothing spent
// or written before yes, a read task's stages and what they leave (a tuned-* profile, tuned.jsonl, the library),
// skills and scripts in a kept harness, KEEP_BASE skipping probes and the composed run, an invalid session retried
// once, a kept harness as the next task's base, the queue (one waits, a third is skipped, a stale one too), offers,
// tests deciding delivery in a real git repo, no approvals in background runs, the cap (a cancel, tuning off, the
// spend summed again after a restart), D-257's account stop, and the library off. Offline: fake/scripted only.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { referenceRunUsd } from "../../src/eval/estimate.ts";
import { libraryDir, profilesDir, runsDir, tuneDir } from "../../src/paths.ts";
import type { ModelRef } from "../../src/protocol.ts";
import { defaultSettings, loadSettings, setSetting, type Settings } from "../../src/settings.ts";
import { userDomain } from "../../src/tune/library.ts";
import {
  capNote,
  estimateOnline,
  offerProblem,
  PROFILE_GONE,
  readOnline,
  spentSince,
  takeSnapshot,
  TUNE_BUSY,
  TuneQueue,
  tuneTask,
  taskId,
  writeOnline,
  type TuneEvent,
  type TuneTask,
} from "../../src/tune/online.ts";
import { temp, type Temp } from "../cli/helpers.ts";
import { createFakeApp, runRecord, type FakeApp, type TuneStageScript } from "../fakes/engine.ts";

const ROOT: ModelRef = { provider: "fake", model: "scripted", thinking: null };
const SUB: ModelRef = { provider: "fake", model: "subm", thinking: null };
const SLOW = 60_000;

const EDIT_INV = { decision: "EDIT", notes: ["read in parts"], guidance: "Read the input in parts, then delegate.\n", toml: {}, files: {} };
const EDIT_DOM = { decision: "EDIT", notes: ["know ledgers"], guidance: "Ledgers end on a total.\n", toml: {}, files: {} };
const KEEP = { decision: "KEEP_BASE", notes: ["nothing to change"], guidance: null, toml: {}, files: {} };
const ADOPT_INV = { decision: "ADOPT", adopt: "inv", notes: ["kept -> read in parts -> the probe found it"], guidance: null, toml: {}, files: {} };
const CUE = "when a long input hides one number in its last part";
const ENTRY = { domain: "read", entry: { cue: CUE, lesson: "guidance.md: read the last part first", evidence: "edit row 1", confidence: "low" }, edits: [] };
const NO_ENTRY = { domain: "read", entry: "NO_ENTRY", edits: [] };

/** Every stage scripted, each at `usd`. */
function stages(over: Record<string, TuneStageScript> = {}, usd = 0.001): Record<string, TuneStageScript> {
  return {
    inv: { answer: EDIT_INV, costUsd: usd },
    dom: { answer: EDIT_DOM, costUsd: usd },
    "probe-inv": { answer: "42", costUsd: usd },
    "probe-dom": { answer: "41", costUsd: usd },
    compose: { answer: ADOPT_INV, costUsd: usd },
    composed: { answer: "42", costUsd: usd },
    reflect: { answer: ENTRY, costUsd: usd },
    ...over,
  };
}

const apps: FakeApp[] = [];
const temps: Temp[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.dispose();
});
afterAll(() => {
  for (const t of temps.splice(0)) t.cleanup();
});

async function app(stageScripts: Record<string, TuneStageScript>, settings: Record<string, string | number | boolean> = {}): Promise<FakeApp> {
  const fa = await createFakeApp({ tune: { stages: stageScripts }, settings: { "tune.enabled": true, "tune.model": "fake/tuner", ...settings } });
  apps.push(fa);
  writeOnline(fa.deps.home);
  return fa;
}

const deps = (fa: FakeApp) => ({ home: fa.deps.home, session: fa.session, settings: () => fa.session.settings });
const setting = (fa: FakeApp, key: string, value: string | number | boolean) => void (fa.session.settings = setSetting(fa.session.settings, key, value));
const stageOf = (tag: string | undefined) => (tag ?? "").split(":").pop();
const tuneStarts = (fa: FakeApp) => fa.startCalls.filter((s) => (s.tag ?? "").startsWith("tune:"));

let userRuns = 0;
/** A user's read task: its input file and its record in `<home>/runs/interactive/runs.jsonl`. */
function readTask(fa: FakeApp, o: { profile?: string; question?: string } = {}): TuneTask {
  const home = fa.deps.home;
  const input = join(fa.deps.cwd, "a.txt");
  const runId = `r_user${++userRuns}`;
  const logPath = join(runsDir(home), "interactive", "runs.jsonl");
  mkdirSync(join(logPath, ".."), { recursive: true });
  const record = runRecord({ run_id: runId, profile: o.profile ?? "default", question: o.question ?? "What number?", input: { chars: 6, lines: 1, sha256: "x", files: [input.replace(/\\/g, "/")] }, started_at: Date.now() / 1000 });
  writeFileSync(logPath, `${existsSync(logPath) ? readFileSync(logPath, "utf8") : ""}${JSON.stringify(record)}\n`);
  return { id: taskId(home), runId, logPath, mode: "read", profile: o.profile ?? "default", root: ROOT, sub: SUB, question: o.question ?? "What number?", inputs: [input] };
}

const profileNames = (home: string) => (existsSync(profilesDir(home)) ? readdirSync(profilesDir(home)).sort() : []);
const tunedLines = (home: string) => (existsSync(join(tuneDir(home), "tuned.jsonl")) ? readFileSync(join(tuneDir(home), "tuned.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

// -- the estimate --

describe("estimateOnline", () => {
  const prices: Record<string, { input: number; output: number }> = { "openrouter/x/root": { input: 1, output: 2 }, "openrouter/x/sub": { input: 1, output: 2 }, "openrouter/x/tune": { input: 0.5, output: 1 } };
  const catalog = { get: (p: string, m: string) => (prices[`${p}/${m}`] ? { price: { ...prices[`${p}/${m}`]!, cache_read: 0, cache_write: 0 } } : undefined) } as never;
  const settingsWith = (o: Record<string, string | number | boolean>): Settings => {
    let s = defaultSettings();
    for (const [k, v] of Object.entries({ "root.model": "openrouter/x/root", "sub.model": "openrouter/x/sub", ...o })) s = setSetting(s, k, v);
    return s;
  };
  const rec = (home: string, batch: string, r: Record<string, unknown>) => {
    const file = join(runsDir(home), batch, "runs.jsonl");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${existsSync(file) ? readFileSync(file, "utf8") : ""}${JSON.stringify({ root: { provider: "openrouter", model: "x/root" }, infra_kind: null, prompt_index: 0, started_at: 100, ...r })}\n`);
  };

  test("the medians skip tune-* batches, infra runs, and other modes and models; sessions are tune-* session tags on tune.model", () => {
    const t = temp("rlmh-est-");
    temps.push(t);
    for (const c of [0.1, 0.3, 0.2]) rec(t.home, "interactive", { mode: "read", cost_usd: c });
    rec(t.home, "interactive", { mode: "read", cost_usd: 9, infra_kind: "server" });
    rec(t.home, "cli", { mode: "read", cost_usd: 9, root: { provider: "openrouter", model: "x/other" } });
    rec(t.home, "tune-t_1", { mode: "read", cost_usd: 9, tag: "tune:t_1:probe-inv" });
    for (const c of [0.5, 0.7]) rec(t.home, "cli", { mode: "repo", cost_usd: c });
    const tuneRoot = { provider: "openrouter", model: "x/tune" };
    rec(t.home, "tune-t_1", { mode: "read", cost_usd: 0.01, tag: "tune:t_1:inv", root: tuneRoot });
    rec(t.home, "tune-t_1", { mode: "read", cost_usd: 0.03, tag: "tune:t_1:reflect", root: tuneRoot });
    rec(t.home, "tune-t_1", { mode: "read", cost_usd: 5, tag: "tune:t_1:dom" }); // another model
    const e = estimateOnline({ home: t.home, settings: settingsWith({ "tune.model": "openrouter/x/tune", "tune.max_usd": 2 }), catalog });
    expect(e.read.runs).toMatchObject({ count: 3, source: "history", samples: 3 });
    expect(e.read.runs.each_usd).toBeCloseTo(0.2, 9);
    expect(e.repo.runs.each_usd).toBeCloseTo(0.6, 9);
    expect(e.read.sessions).toMatchObject({ count: 4, source: "history", samples: 2 });
    expect(e.read.sessions.each_usd).toBeCloseTo(0.02, 9);
    expect(e.read.total_usd).toBeCloseTo(0.6 + 0.08, 9);
    expect(e.read.runs_share! + e.read.sessions_share!).toBeCloseTo(1, 9);
    expect(e.read.covers).toBe(Math.floor(2 / 0.68));
    expect(e.blocked).toBeNull();
  });

  test("with no history, §6.6's rows: runs at the root and sub prices, sessions at tune.model's, or the root's when it is empty; the library off gives 3 sessions", () => {
    const t = temp("rlmh-est0-");
    temps.push(t);
    const e = estimateOnline({ home: t.home, settings: settingsWith({ "tune.model": "openrouter/x/tune" }), catalog });
    // R: 0.3M in, 20K out at the root price, 0.3M in, 30K out at the sub price; M: 1.2M, 50K and 0.3M, 30K
    expect(e.read.runs).toMatchObject({ source: "reference", samples: 0 });
    expect(e.read.runs.each_usd).toBeCloseTo(0.3 + 0.04 + 0.3 + 0.06, 9);
    expect(e.repo.runs.each_usd).toBeCloseTo(1.2 + 0.1 + 0.3 + 0.06, 9);
    expect(e.read.sessions.each_usd).toBeCloseTo(0.15 + 0.02 + 0.15 + 0.03, 9);
    expect(e.read.sessions.count).toBe(4);
    expect(e.tuning).toMatchObject({ provider: "openrouter", model: "x/tune" });
    const same = estimateOnline({ home: t.home, settings: settingsWith({ "tune.library": false }), catalog });
    expect(same.read.sessions.count).toBe(3);
    expect(same.read.sessions.each_usd).toBeCloseTo(referenceRunUsd("R", "read", { root: { provider: "openrouter", model: "x/root", thinking: null }, sub: { provider: "openrouter", model: "x/root", thinking: null }, catalog })!, 9);
    expect(same.read.sessions.each_usd).toBeCloseTo(0.7, 9);
    // the $1.00 default cap: the repo line (3 × 1.66 + …) is over it, the read line too, so no y
    expect(same.blocked).toBe("over_cap");
    const one = estimateOnline({ home: t.home, settings: settingsWith({ "tune.max_usd": 5 }), catalog });
    expect(one.read.over_cap).toBe(false);
    expect(one.repo.over_cap).toBe(true);
    expect(one.warnings[0]).toContain("repo task");
    expect(estimateOnline({ home: t.home, settings: settingsWith({ profile: "training-v4", "tune.max_usd": 50 }), catalog }).blocked).toBe("training-v4");
    expect(estimateOnline({ home: t.home, settings: setSetting(defaultSettings(), "tune.max_usd", 50), catalog }).blocked).toBe("no_root");
  });

  test(
    "nothing before yes: no run.start, no gateway call, no <home>/tune, git worktree list unchanged",
    async () => {
      const t = temp("rlmh-est-git-");
      temps.push(t);
      const repo = gitRepo(t);
      const before = git(repo, "worktree", "list");
      const fa = await createFakeApp({ tune: { stages: stages() }, cwd: repo });
      apps.push(fa);
      const calls: string[] = [];
      const off = fa.bus.on("call.start", (c) => void calls.push(c.call_id));
      const e = estimateOnline({ home: fa.deps.home, settings: fa.session.settings, catalog: fa.deps.catalog, profiles: (await fa.session.info()).profiles });
      off();
      expect(e.read.total_usd).toBe(0); // fake/scripted is priced at $0
      expect(e.read.covers).toBe(Infinity);
      expect(fa.engine.calls.filter((c) => c.method === "run.start")).toEqual([]);
      expect(fa.fetchCalls).toEqual([]);
      expect(calls).toEqual([]);
      expect(existsSync(tuneDir(fa.deps.home))).toBe(false);
      expect(git(repo, "worktree", "list")).toBe(before);
    },
    SLOW,
  );
});

// -- offers --

describe("offerProblem", () => {
  const f = { prompt_index: 0, submitted: true, infra_kind: null, infra_error: null };
  test("a follow-up, an infra error, no submit and training-v4 are not offered; a submitted first prompt is", () => {
    expect(offerProblem(f, "default")).toBeNull();
    expect(offerProblem(f, "tuned-20261105-1200")).toBeNull();
    expect(offerProblem({ ...f, prompt_index: 1 }, "default")).toContain("follow-up");
    expect(offerProblem({ ...f, infra_kind: "server", infra_error: "server: 500" }, "default")).toContain("infra");
    expect(offerProblem({ ...f, submitted: false }, "default")).toContain("submit");
    expect(offerProblem(f, "training-v4")).toContain("training-v4");
  });
  test("userDomain: read, or repo-<slug of the folder's name>", () => {
    expect(userDomain({ mode: "read" })).toBe("read");
    expect(userDomain({ mode: "repo", folder: "C:\\Users\\me\\My Project_2\\" })).toBe("repo-my-project-2");
    expect(userDomain({ mode: "repo", folder: "/tmp/!!!" })).toBe("repo-folder");
  });
});

// -- a read task --

describe("tuneTask, read", () => {
  test(
    "the stages in order on the right models, a tuned-* profile with its tuned.jsonl line, the library entry, and nothing left",
    async () => {
      const fa = await app(stages(), { "permissions.mode": "default" });
      const home = fa.deps.home;
      const task = readTask(fa);
      const events: TuneEvent[] = [];
      const r = await tuneTask(task, deps(fa), (e) => events.push(e));
      expect(r.outcome).toBe("kept");
      const starts = tuneStarts(fa);
      expect(starts.map((s) => stageOf(s.tag))).toEqual(["inv", "dom", "probe-inv", "probe-dom", "compose", "composed", "reflect"]);
      expect(fa.startCalls.some((s) => stageOf(s.tag) === "ref")).toBe(false);
      for (const s of starts) {
        expect(s).toMatchObject({ interactive: false, batch: `tune-${task.id}`, tag: `tune:${task.id}:${stageOf(s.tag)}` });
        expect(s.conversation ?? false).toBe(false);
        expect(s.logDir).toBe(join(runsDir(home), `tune-${task.id}`));
      }
      for (const s of starts.filter((x) => /probe|composed/.test(x.tag!))) {
        expect(s).toMatchObject({ root: ROOT, sub: SUB, permissionMode: "default", conversation: false, mode: "read", question: "What number?" });
      }
      const tuner = { provider: "fake", model: "tuner", thinking: null };
      for (const s of starts.filter((x) => /:(inv|dom|compose|reflect)$/.test(x.tag!))) expect(s).toMatchObject({ root: tuner, sub: tuner, profile: "default" });
      expect(starts.find((s) => s.tag!.endsWith("probe-inv"))!.profile).toBe(`${task.id}-inv`);
      expect(starts.find((s) => s.tag!.endsWith(":composed"))!.profile).toBe(`${task.id}-composed`);
      // the kept harness, its line, and no <id>-* profile
      const names = profileNames(home);
      expect(names).toHaveLength(1);
      expect(names[0]).toMatch(/^tuned-\d{8}-\d{4}$/);
      expect(r.kept?.name).toBe(names[0]!);
      expect(readFileSync(join(profilesDir(home), names[0]!, "guidance.md"), "utf8")).toBe(EDIT_INV.guidance);
      const lines = tunedLines(home);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ name: names[0], base: "default", run_id: task.runId, changed: ["guidance"] });
      expect(Object.keys(lines[0]).sort()).toEqual(["at", "base", "base_hash", "changed", "name", "profile_hash", "run_id"]);
      expect(events.some((e) => e.type === "kept" && e.name === names[0])).toBe(true);
      // the library
      expect(readFileSync(join(libraryDir(home), "read", "INDEX.md"), "utf8")).toContain(CUE);
      // tune.json and the clean-up
      const j = JSON.parse(readFileSync(join(tuneDir(home), task.id, "tune.json"), "utf8"));
      expect(j).toMatchObject({ outcome: "kept", base: "default", domain: "read" });
      for (const s of ["ref", "inv", "dom", "probe-inv", "probe-dom", "compose", "composed", "reflect"]) expect(j.stages[s]).toHaveProperty("decision");
      expect(j.stages.ref).toMatchObject({ decision: "reference", run_id: task.runId, cost_usd: 0 });
      expect(j.stages.inv).toHaveProperty("profile_hash");
      expect(r.cost_usd).toBeCloseTo(0.007, 9);
      expect(existsSync(join(tuneDir(home), "work", task.id))).toBe(false);
      // the runs show in /runs: one log under runs/tune-<id>/
      const log = readFileSync(join(runsDir(home), `tune-${task.id}`, "runs.jsonl"), "utf8").trim().split("\n");
      expect(log).toHaveLength(7);
      // a second task whose reflector says NO_ENTRY adds nothing to the library
      const before = readdirSync(join(libraryDir(home), "read", "entries"));
      const fb = await app(stages({ reflect: { answer: NO_ENTRY } }));
      const t2 = readTask(fb);
      mkdirSync(libraryDir(fb.deps.home), { recursive: true });
      expect((await tuneTask(t2, deps(fb))).outcome).toBe("kept");
      expect(existsSync(join(libraryDir(fb.deps.home), "read", "entries"))).toBe(false);
      expect(before).toEqual([task.id]);
    },
    SLOW,
  );

  test(
    "skills and scripts: an INV edit with files gives a tuned-* holding them (D-233)",
    async () => {
      const skill = "---\nname: careful\ndescription: read slowly\n---\nRead the last part first.\n";
      const script = "def last(parts):\n    return parts[-1]\n";
      const inv = { ...EDIT_INV, guidance: "Use the careful skill and scripts/helper.py.\n", files: { "skills/careful/SKILL.md": skill, "scripts/helper.py": script } };
      const fa = await app(stages({ inv: { answer: inv } }));
      const r = await tuneTask(readTask(fa), deps(fa));
      expect(r.outcome).toBe("kept");
      const dir = r.kept!.path;
      expect(readFileSync(join(dir, "skills", "careful", "SKILL.md"), "utf8")).toBe(skill);
      expect(readFileSync(join(dir, "scripts", "helper.py"), "utf8")).toBe(script);
      expect(r.kept!.changed).toEqual(["guidance", "scripts/helper.py", "skills/careful/SKILL.md"]);
    },
    SLOW,
  );

  test(
    "keeping the base: an editor's KEEP_BASE skips its probe; the composer's KEEP_BASE skips composed and writes no tuned-*",
    async () => {
      const fa = await app(stages({ inv: { answer: KEEP }, compose: { answer: { ...KEEP, adopt: null } } }));
      const task = readTask(fa);
      const r = await tuneTask(task, deps(fa));
      expect(r).toMatchObject({ outcome: "base", reason: "the composer kept the base", kept: null });
      expect(tuneStarts(fa).map((s) => stageOf(s.tag))).toEqual(["inv", "dom", "probe-dom", "compose"]);
      expect(profileNames(fa.deps.home)).toEqual([]);
      const notes = readFileSync(join(tuneDir(fa.deps.home), task.id, "evidence-compose", "candidates", "inv", "notes.md"), "utf8");
      expect(notes).toContain("its probe is ref");
      const j = JSON.parse(readFileSync(join(tuneDir(fa.deps.home), task.id, "tune.json"), "utf8"));
      expect(j.stages["probe-inv"].decision).toContain("not run");
      // both editors keeping the base: no composer either
      const fb = await app(stages({ inv: { answer: KEEP }, dom: { answer: KEEP } }));
      expect((await tuneTask(readTask(fb), deps(fb))).reason).toBe("both editors kept the base");
      expect(tuneStarts(fb).map((s) => stageOf(s.tag))).toEqual(["inv", "dom"]);
    },
    SLOW,
  );

  test(
    "an invalid session is retried once with the errors, then becomes KEEP_BASE",
    async () => {
      const bad = { ...EDIT_INV, guidance: "INVALID guidance\n" };
      const fa = await app(stages({ inv: { answers: [bad, bad] }, compose: { answer: { ...ADOPT_INV, adopt: "dom" } } }));
      const task = readTask(fa);
      const r = await tuneTask(task, deps(fa));
      const invs = tuneStarts(fa).filter((s) => s.tag!.endsWith(":inv"));
      expect(invs).toHaveLength(2);
      expect(invs[0]!.question).not.toContain("YOUR PREVIOUS ATTEMPT WAS REJECTED");
      expect(invs[1]!.question).toContain("YOUR PREVIOUS ATTEMPT WAS REJECTED");
      expect(invs[1]!.question).toContain("refuses a guidance that says INVALID");
      expect(tuneStarts(fa).some((s) => s.tag!.endsWith("probe-inv"))).toBe(false);
      const j = JSON.parse(readFileSync(join(tuneDir(fa.deps.home), task.id, "tune.json"), "utf8"));
      expect(j.stages.inv).toMatchObject({ decision: "KEEP_BASE", attempts: 2, fell_back: true });
      expect(r.outcome).toBe("kept");
      expect(readFileSync(join(r.kept!.path, "guidance.md"), "utf8")).toBe(EDIT_DOM.guidance);
    },
    SLOW,
  );

  test(
    "carrying forward: task 2, run under task 1's tuned profile, uses it as H",
    async () => {
      const second = { ...EDIT_INV, guidance: "Second task's guidance.\n" };
      const fa = await app(stages({ inv: { answers: [EDIT_INV, second] } }));
      const r1 = await tuneTask(readTask(fa), deps(fa));
      const h = r1.kept!.name;
      setting(fa, "profile", h);
      fa.engine.calls.length = 0;
      const t2 = readTask(fa, { profile: h });
      const r2 = await tuneTask(t2, deps(fa));
      expect(r2.outcome).toBe("kept");
      const j = JSON.parse(readFileSync(join(tuneDir(fa.deps.home), t2.id, "tune.json"), "utf8"));
      expect(j.base).toBe(h);
      expect(readFileSync(join(tuneDir(fa.deps.home), t2.id, "evidence-inv", "harness", "guidance.md"), "utf8")).toBe(EDIT_INV.guidance);
      expect(fa.engine.calls.filter((c) => c.method === "profile.check").every((c) => c.params.base === h)).toBe(true);
      expect(tunedLines(fa.deps.home)[1]).toMatchObject({ base: h, name: r2.kept!.name });
      expect(readFileSync(join(r2.kept!.path, "guidance.md"), "utf8")).toBe(second.guidance);
    },
    SLOW,
  );

  test(
    "no approvals: a probe whose cell would ask is denied, and no approval.request reaches the interface",
    async () => {
      const fa = await app(stages({ "probe-inv": { answer: "42", code: "print(shell('ls -la'))" } }));
      const perms: { allowed: boolean; asked: boolean }[] = [];
      const off = fa.bus.on("engine.event", (e) => {
        if (e.method === "run.permission") perms.push(e.params);
      });
      await tuneTask(readTask(fa), deps(fa));
      off();
      expect(perms).toEqual([expect.objectContaining({ kind: "shell", allowed: false, asked: false })]);
      expect(fa.deps.approvals.version).toBe(0);
      expect(fa.deps.approvals.size).toBe(0);
    },
    SLOW,
  );

  test(
    "library off: no reflect run, no library/ in the evidence, and no <home>/library",
    async () => {
      const fa = await app(stages(), { "tune.library": false });
      const task = readTask(fa);
      expect((await tuneTask(task, deps(fa))).outcome).toBe("kept");
      expect(tuneStarts(fa).some((s) => s.tag!.endsWith(":reflect"))).toBe(false);
      const dir = join(tuneDir(fa.deps.home), task.id);
      for (const e of readdirSync(dir).filter((x) => x.startsWith("evidence-"))) expect(existsSync(join(dir, e, "library"))).toBe(false);
      expect(existsSync(libraryDir(fa.deps.home))).toBe(false);
    },
    SLOW,
  );

  test(
    "an account kind (D-257) in a session stops the task; the queue turns tuning off with the note",
    async () => {
      const fa = await app(stages({ inv: { infra: "no_credit" } }));
      const events: TuneEvent[] = [];
      const q = new TuneQueue(deps(fa), (e) => events.push(e));
      expect(q.offer(readTask(fa))).toBe("started");
      await q.idle();
      expect(tuneStarts(fa).map((s) => stageOf(s.tag))).toEqual(["inv"]);
      const off = events.find((e) => e.type === "off");
      expect(off).toMatchObject({ type: "off", reason: "account" });
      expect((off as { text: string }).text).toContain("out of credit");
      expect(loadSettings(fa.deps.home).tune.enabled).toBe(false);
      expect(profileNames(fa.deps.home)).toEqual([]);
    },
    SLOW,
  );
});

// -- the queue --

describe("TuneQueue", () => {
  test(
    "three tasks during one tune: the second waits, the third is skipped with the note",
    async () => {
      const fa = await app(stages({ inv: { answer: KEEP, delayMs: 150 }, dom: { answer: KEEP } }));
      const events: TuneEvent[] = [];
      const q = new TuneQueue(deps(fa), (e) => events.push(e));
      const [a, b, c] = [readTask(fa), readTask(fa), readTask(fa)];
      expect(q.offer(a)).toBe("started");
      expect(q.offer(b)).toBe("waiting");
      expect(q.offer(c)).toBe("skipped");
      expect(q.state()).toMatchObject({ running: { id: a.id }, waiting: { id: b.id } });
      expect(events).toContainEqual({ type: "note", id: c.id, text: TUNE_BUSY, tone: "dim" });
      await q.idle();
      const ended = events.filter((e) => e.type === "task" && e.phase === "end").map((e) => (e as { id: string }).id);
      expect(ended).toEqual([a.id, b.id]);
      expect(existsSync(join(tuneDir(fa.deps.home), c.id))).toBe(false);
      expect(q.state()).toMatchObject({ running: null, waiting: null });
    },
    SLOW,
  );

  test(
    "a waiting task whose profile is no longer active is skipped",
    async () => {
      const fa = await app(stages({ inv: { answer: KEEP, delayMs: 150 }, dom: { answer: KEEP } }));
      const events: TuneEvent[] = [];
      const q = new TuneQueue(deps(fa), (e) => events.push(e));
      const [a, b] = [readTask(fa), readTask(fa)];
      q.offer(a);
      q.offer(b);
      setting(fa, "profile", "training-v4"); // the user switched
      await q.idle();
      expect(events).toContainEqual({ type: "note", id: b.id, text: PROFILE_GONE, tone: "dim" });
      expect(tuneStarts(fa).filter((s) => s.tag!.includes(b.id))).toEqual([]);
    },
    SLOW,
  );

  test(
    "cancel (/tune off, quit) cancels the task in flight, drops the waiting one, and keeps nothing",
    async () => {
      const fa = await app(stages({ "probe-inv": { answer: "42", delayMs: 2000 } }));
      const events: TuneEvent[] = [];
      const q = new TuneQueue(deps(fa), (e) => events.push(e));
      const [a, b] = [readTask(fa), readTask(fa)];
      q.offer(a);
      q.offer(b);
      while (!tuneStarts(fa).some((s) => s.tag!.endsWith("probe-inv"))) await Bun.sleep(10);
      await Bun.sleep(20);
      expect(await q.cancel("off")).toEqual({ cancelled: a.id, dropped: b.id });
      expect(fa.engine.calls.some((c) => c.method === "run.cancel")).toBe(true);
      const end = events.find((e) => e.type === "task" && e.phase === "end") as { result: { outcome: string } };
      expect(end.result.outcome).toBe("cancelled");
      expect(events.some((e) => e.type === "off")).toBe(false);
      expect(profileNames(fa.deps.home)).toEqual([]);
      expect(loadSettings(fa.deps.home).tune.enabled).toBe(true);
    },
    SLOW,
  );

  test(
    "the cap trips in task 2: run.cancel, no later run.start, H stays task 1's, tuning off with the note; a restart sums the spend again",
    async () => {
      const fa = await app(stages({ inv: { answers: [EDIT_INV, { ...EDIT_INV, guidance: "Another edit.\n" }] }, "probe-inv": { answer: "42", costsUsd: [0.001, 0.2] } }), { "tune.max_usd": 0.05 });
      const home = fa.deps.home;
      const events: TuneEvent[] = [];
      const q = new TuneQueue(deps(fa), (e) => {
        events.push(e);
        if (e.type === "kept") setting(fa, "profile", e.name); // what the interface does with no conversation open
      });
      q.offer(readTask(fa));
      await q.idle();
      const h = fa.session.settings.profile;
      expect(h).toMatch(/^tuned-/);
      const t2 = readTask(fa, { profile: h });
      q.offer(t2);
      await q.idle();
      const starts = tuneStarts(fa).filter((s) => s.tag!.includes(t2.id));
      expect(starts.map((s) => stageOf(s.tag))).toEqual(["inv", "dom", "probe-inv"]);
      const cancels = fa.engine.calls.filter((c) => c.method === "run.cancel");
      expect(cancels).toHaveLength(1);
      expect(fa.session.settings.profile).toBe(h);
      expect(profileNames(home)).toEqual([h]);
      expect(loadSettings(home).tune.enabled).toBe(false);
      expect(events).toContainEqual({ type: "off", reason: "cap", text: capNote(0.05) });
      expect(capNote(0.05)).toBe("Tuning turned off: the $0.05 cap was reached.");
      const j = JSON.parse(readFileSync(join(tuneDir(home), t2.id, "tune.json"), "utf8"));
      expect(j.outcome).toBe("capped");
      // a restart: the spend since on_since comes back from the run logs
      const spent = q.state().spent_usd;
      expect(spent).toBeGreaterThan(0.2);
      const again = new TuneQueue(deps(fa));
      expect(again.state().spent_usd).toBeCloseTo(spent, 6);
      expect(spentSince(home, readOnline(home)!.on_since)).toBeCloseTo(spent, 6);
      // runs before on_since don't count
      expect(spentSince(home, new Date(Date.now() + 60_000).toISOString())).toBe(0);
    },
    SLOW,
  );
});

// -- repo tasks: tests decide delivery --

function git(dir: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

function gitRepo(t: Temp): string {
  const dir = join(t.dir, "proj");
  mkdirSync(dir, { recursive: true });
  git(dir, "-c", "init.defaultBranch=main", "init", "-q");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const exitDiff = (code: number) => ["diff --git a/exit.txt b/exit.txt", "new file mode 100644", "--- /dev/null", "+++ b/exit.txt", "@@ -0,0 +1 @@", `+${code}`, ""].join("\n");
const MARKER = "TESTLOG-MARKER-7f3a";

describe("tuneTask, repo: tests decide delivery", () => {
  async function repoTask(o: { refDiff: string; composedExit: number }) {
    const t = temp("rlmh-online-repo-");
    temps.push(t);
    const repo = gitRepo(t);
    const check = t.file("check.js", `const fs = require("fs");\nconsole.log(${JSON.stringify(MARKER)});\nlet x = "3";\ntry { x = fs.readFileSync("exit.txt", "utf8"); } catch {}\nprocess.exit(Number(x.trim()));\n`);
    const fa = await app(stages({ "probe-inv": { answer: "done", exit: 0 }, "probe-dom": { answer: "done", exit: 0 }, composed: { answer: "done", exit: o.composedExit }, reflect: { answer: { ...ENTRY, domain: "repo" } } }), {
      "tune.test": `"${process.execPath}" "${check}"`,
    });
    const home = fa.deps.home;
    const worktrees = git(repo, "worktree", "list");
    const snap = await takeSnapshot(home, repo);
    if ("refused" in snap) throw new Error(snap.refused);
    const logPath = join(runsDir(home), "interactive", "runs.jsonl");
    mkdirSync(join(logPath, ".."), { recursive: true });
    const record = runRecord({ run_id: "r_userrepo", mode: "repo", question: null, task: "Write exit.txt", diff: o.refDiff, started_at: Date.now() / 1000 });
    writeFileSync(logPath, `${JSON.stringify(record)}\n`);
    const task: TuneTask = { id: snap.id, runId: "r_userrepo", logPath, mode: "repo", profile: "default", root: ROOT, sub: SUB, task: "Write exit.txt", folder: repo, snapshot: snap.snapshot };
    const r = await tuneTask(task, deps(fa));
    const j = JSON.parse(readFileSync(join(tuneDir(home), task.id, "tune.json"), "utf8"));
    expect(git(repo, "worktree", "list")).toBe(worktrees);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(existsSync(snap.snapshot.dir)).toBe(false);
    return { fa, home, task, r, j };
  }

  test(
    "ref at exit 0 and composed at exit 1: the base stays",
    async () => {
      const { r, j } = await repoTask({ refDiff: exitDiff(0), composedExit: 1 });
      expect(r.outcome).toBe("base");
      expect(r.reason).toContain("tune.test passed on the reference and failed on the composed run");
      expect(j).toMatchObject({ test_rule: "applied", stages: { ref: { exit: 0 }, composed: { exit: 1 } } });
    },
    SLOW,
  );

  test(
    "both at exit 1: the composed harness is kept; no evidence or library file holds the test log's text",
    async () => {
      const { r, j, home, task } = await repoTask({ refDiff: exitDiff(1), composedExit: 1 });
      expect(r.outcome).toBe("kept");
      expect(j).toMatchObject({ test_rule: "applied", domain: "repo-proj", stages: { ref: { exit: 1 }, composed: { exit: 1 } } });
      expect(readFileSync(join(tuneDir(home), task.id, "tests", "composed.log"), "utf8")).toContain(MARKER);
      const dir = join(tuneDir(home), task.id);
      const files = [...readdirSync(dir).filter((x) => x.startsWith("evidence-")).flatMap((e) => walk(join(dir, e))), ...walk(libraryDir(home))];
      expect(files.length).toBeGreaterThan(0);
      expect(walk(libraryDir(home)).some((f) => f.replace(/\\/g, "/").includes("repo-proj/entries"))).toBe(true);
      for (const f of files) expect(readFileSync(f, "utf8")).not.toContain(MARKER);
    },
    SLOW,
  );

  test(
    "a reference diff that doesn't apply skips the rule, and tune.json says so",
    async () => {
      const bad = ["diff --git a/missing.txt b/missing.txt", "--- a/missing.txt", "+++ b/missing.txt", "@@ -1 +1 @@", "-old", "+new", ""].join("\n");
      const { r, j } = await repoTask({ refDiff: bad, composedExit: 1 });
      expect(j.test_rule).toContain("skipped");
      expect(j.test_rule).toContain("did not apply");
      expect(r.outcome).toBe("kept");
    },
    SLOW,
  );
});
