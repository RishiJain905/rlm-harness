// KV cache: none; a test.
// /tune in the interactive app (v1 step 9, tasks 5, 6, 8 and 9) against createFakeApp({tune}): the eleven commands,
// the status and the estimate (nothing before y, no y when blocked, the one-line warning), y turning tuning on with
// the status segment, a tune in the background while the prompt box and follow-ups stay usable and no approval
// shows, the snapshot before a repo question, the kept harness's switch (deferred while a conversation is open, at
// once otherwise), the cap turning tuning off, /tune off cancelling, and /settings refusing tune.enabled = true.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "../../src/interface/commands/index.ts";
import { settingRows } from "../../src/interface/commands/settings.tsx";
import { layoutStatus, type StatusSegment } from "../../src/interface/format.ts";
import { tuneSegment } from "../../src/interface/store.ts";
import { runsDir, settingsPath, tuneDir } from "../../src/paths.ts";
import { loadSettings, TUNE_ON_HINT } from "../../src/settings.ts";
import { capNote, readOnline, writeOnline } from "../../src/tune/online.ts";
import { createFakeApp, type FakeApp, type FakeAppOptions, type TuneStageScript } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

setDefaultTimeout(60_000);

const EDIT_INV = { decision: "EDIT", notes: ["read in parts"], guidance: "Read the input in parts, then delegate.\n", toml: {}, files: {} };
const EDIT_DOM = { decision: "EDIT", notes: ["know ledgers"], guidance: "Ledgers end on a total.\n", toml: {}, files: {} };
const ADOPT_INV = { decision: "ADOPT", adopt: "inv", notes: ["kept -> read in parts -> the probe found it"], guidance: null, toml: {}, files: {} };
const ENTRY = { domain: "read", entry: { cue: "a long input", lesson: "read the last part first", evidence: "row 1", confidence: "low" }, edits: [] };

/** Every stage scripted so the composed harness is kept. */
function keptStages(over: Record<string, TuneStageScript> = {}): Record<string, TuneStageScript> {
  return {
    inv: { answer: EDIT_INV },
    dom: { answer: EDIT_DOM },
    "probe-inv": { answer: "42" },
    "probe-dom": { answer: "41" },
    compose: { answer: ADOPT_INV },
    composed: { answer: "42" },
    reflect: { answer: ENTRY },
    ...over,
  };
}

const WIDE = { columns: 260, rows: 34 }; // wide enough that the status line keeps the tune segment, which goes first

let app: FakeApp | undefined;
let m: Mounted | undefined;

afterEach(async () => {
  m?.unmount();
  await app?.dispose();
  app = undefined;
  m = undefined;
});

async function open(opts: FakeAppOptions = {}, before?: (home: string) => void): Promise<{ app: FakeApp; m: Mounted }> {
  app = await createFakeApp({ size: WIDE, ...opts });
  if (app.session.settings.tune.enabled) writeOnline(app.deps.home);
  before?.(app.deps.home);
  m = mount(app.deps);
  await m.waitForText("idle");
  return { app, m };
}

async function ask(m: Mounted, text: string): Promise<void> {
  await m.type(text);
  await m.press(KEYS.enter);
}

async function command(m: Mounted, line: string): Promise<string> {
  await ask(m, `/${line}`);
  return m.waitForText(`── /${line.split(" ")[0]} `);
}

const status = (m: Mounted) => m.screen().trimEnd().split("\n").at(-1)!;
const tuneStarts = (a: FakeApp) => a.startCalls.filter((s) => (s.tag ?? "").startsWith("tune:"));
const stageOf = (tag: string | undefined) => (tag ?? "").split(":").pop();

/** A run record for the estimate's medians, under `<home>/runs/interactive/`. */
function history(home: string, rows: { mode: "read" | "repo"; cost_usd: number }[]): void {
  const file = join(runsDir(home), "interactive", "runs.jsonl");
  mkdirSync(join(file, ".."), { recursive: true });
  const lines = rows.map((r, i) => JSON.stringify({ run_id: `r_hist${i}`, root: { provider: "fake", model: "scripted" }, infra_kind: null, prompt_index: 0, started_at: 100 + i, ...r }));
  writeFileSync(file, `${lines.join("\n")}\n`);
}

describe("/tune", () => {
  test("/ lists eleven commands, all visible, and /tune with the menu open picks /tune", async () => {
    const { m } = await open();
    expect(COMMANDS.map((c) => c.name)).toEqual(["providers", "model", "settings", "permissions", "context", "runs", "help", "tune", "tuned"]);
    await m.type("/");
    const all = await m.waitForText("/quit");
    for (const name of [...COMMANDS.map((c) => c.name), "clear", "quit"]) expect(all).toContain(`/${name} `);
    await m.type("tune");
    await m.waitFor(() => !m.screen().includes("/providers") && m.screen().includes("/tuned"));
    await m.press(KEYS.enter);
    const s = await m.waitForText("── /tune ");
    expect(s).not.toContain("── /tuned");
    expect(s).toContain("Tuning: off");
  });

  test("/tune shows off; /tune on shows the estimate; n goes back with no run.start and tune.enabled still false", async () => {
    const { app, m } = await open();
    const s = await command(m, "tune");
    expect(s).toContain("Tuning: off");
    expect(s).toContain("o turns tuning on (the cost first)");
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("── /tune"));
    const e = await command(m, "tune on");
    expect(e).toContain("the estimate per task");
    expect(e).toMatch(/read +\$0\.00 a task/);
    expect(e).toMatch(/repo +\$0\.00 a task/);
    expect(e).toContain("The cap, tune.max_usd: $1.00");
    expect(e).toContain("Your own run is the reference, so a task costs up to 3 runs on the root model");
    expect(e).toContain("4 sessions");
    expect(e).toContain("the runs are most of it");
    expect(e).toContain("after each new conversation's first answer");
    expect(e).toContain("anything that would ask is denied");
    expect(e).toContain("uncommitted and untracked files included, without changing the folder");
    expect(e).toContain("y turns tuning on");
    await m.press("n");
    await m.waitForText("Tuning: off");
    expect(app.engine.calls.some((c) => c.method === "run.start")).toBe(false);
    expect(app.fetchCalls).toEqual([]);
    expect(app.session.settings.tune.enabled).toBe(false);
    expect(loadSettings(app.deps.home).tune.enabled).toBe(false);
    expect(existsSync(tuneDir(app.deps.home))).toBe(false);
  });

  test("y writes tune.enabled = true and online.json, and the status line shows tune on $0.00/$1.00", async () => {
    const { app, m } = await open();
    await command(m, "tune on");
    await m.press("y");
    await m.waitForText("Tuning is on:");
    expect(m.screen()).not.toContain("── /tune");
    expect(loadSettings(app.deps.home).tune.enabled).toBe(true);
    expect(readFileSync(settingsPath(app.deps.home), "utf8")).toContain("[tune]\nenabled = true");
    expect(readOnline(app.deps.home)).not.toBeNull();
    await m.waitFor(() => status(m).includes("tune on $0.00/$1.00"));
    expect(app.engine.calls.some((c) => c.method === "run.start")).toBe(false);
    // the status screen now says on, and /tune on says it already is
    await command(m, "tune on");
    await m.waitForText("Tuning is already on.");
    expect(m.screen()).toContain("Tuning: on");
    expect(m.screen()).toContain("o turns tuning off");
  });

  test("no y under training-v4 or with both lines over the cap, with the hint; one line over warns", async () => {
    const { app, m } = await open({ settings: { profile: "training-v4" } });
    const s = await command(m, "tune on");
    expect(s).toContain("training-v4 is never tuned, so there is no y");
    expect(s).toContain("/settings");
    expect(s).not.toContain("y turns tuning on");
    await m.press("y");
    await Bun.sleep(100);
    expect(app.session.settings.tune.enabled).toBe(false);
    await m.press(KEYS.esc);
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("── /tune"));
    m.unmount();
    await app.dispose();

    const over = await open({}, (home) => history(home, [{ mode: "read", cost_usd: 5 }, { mode: "repo", cost_usd: 5 }]));
    const o = await command(over.m, "tune on");
    expect(o).toMatch(/read +\$15\.00 a task/);
    expect(o).toContain("OVER THE CAP");
    expect(o).toContain("Both lines are over the $1.00 cap, so there is no y. Raise tune.max_usd in /settings");
    expect(o).not.toContain("y turns tuning on");
    await over.m.press("y");
    await Bun.sleep(100);
    expect(loadSettings(over.app.deps.home).tune.enabled).toBe(false);
    over.m.unmount();
    await over.app.dispose();

    const one = await open({}, (home) => history(home, [{ mode: "read", cost_usd: 0.1 }, { mode: "repo", cost_usd: 5 }]));
    const w = await command(one.m, "tune on");
    expect(w).toContain("Warning: a repo task is estimated at $15.00, over the $1.00 cap: such a task will trip the cap");
    expect(w).toContain("y turns tuning on");
  });

  test("after a question's first answer the tune runs in the background: the prompt box stays usable, a follow-up runs, and no approval shows", async () => {
    const { app, m } = await open({
      scenario: "conversation",
      settings: { "tune.enabled": true },
      tune: { stages: keptStages({ inv: { answer: EDIT_INV, delayMs: 3000 }, "probe-inv": { answer: "42", code: "print(shell('ls -la'))" } }) },
    });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("first answer", 10_000);
    await m.waitFor(() => status(m).includes(" · tuning"), 10_000);
    expect(m.screen()).toContain("/tune: tuning t_");
    // a follow-up while the tune runs
    await ask(m, "And again?");
    await m.waitForText("second answer", 15_000);
    expect(app.engine.calls.some((c) => c.method === "run.say")).toBe(true);
    expect(status(m)).toContain(" · tuning");
    expect(status(m)).toStartWith("ready for a follow-up");
    // the kept harness waits for the conversation to end
    await m.waitForText("it becomes the active harness when this conversation ends", 20_000);
    expect(app.deps.approvals.version).toBe(0);
    expect(app.deps.approvals.size).toBe(0);
    expect(tuneStarts(app).map((s) => stageOf(s.tag))).toEqual(["inv", "dom", "probe-inv", "probe-dom", "compose", "composed", "reflect"]);
    for (const s of tuneStarts(app)) {
      expect(s.interactive).toBe(false);
      expect(s.conversation ?? false).toBe(false);
    }
    expect(app.session.settings.profile).toBe("default");
    expect(loadSettings(app.deps.home).profile).toBe("default");
    await m.waitFor(() => !status(m).includes(" · tuning"));
    // /clear ends the conversation: now the kept harness is active
    await ask(m, "/clear");
    await m.waitForText("is now the active harness");
    expect(app.engine.calls.some((c) => c.method === "run.close")).toBe(true);
    expect(loadSettings(app.deps.home).profile).toMatch(/^tuned-\d{8}-\d{4}$/);
    expect(app.session.settings.profile).toMatch(/^tuned-/);
  });

  test("with no conversation open, a kept harness is active at once", async () => {
    const { app, m } = await open({ settings: { "tune.enabled": true, "conversation.follow_ups": false }, tune: { stages: keptStages() } });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("it is now the active harness", 20_000);
    expect(loadSettings(app.deps.home).profile).toMatch(/^tuned-\d{8}-\d{4}$/);
    expect(app.startCalls[0]!.conversation).toBe(false);
  });

  test("a repo question is snapshotted before its run.start, and the tune's runs work in throwaway copies under tune/work", async () => {
    const { app, m } = await open({ settings: { "tune.enabled": true, "conversation.follow_ups": false }, tune: { stages: keptStages({ composed: { answer: "42", exit: 0 } }) } });
    const before = readdirSync(app.deps.cwd).sort();
    await ask(m, "What is in this folder?");
    await m.waitFor(() => tuneStarts(app).some((s) => stageOf(s.tag) === "probe-inv"), 20_000);
    const userRun = app.startCalls[0]!;
    expect(userRun).toMatchObject({ mode: "repo", repoPath: app.deps.cwd });
    const probe = tuneStarts(app).find((s) => stageOf(s.tag) === "probe-inv")!;
    expect(probe.mode).toBe("repo");
    expect(probe.repoPath!.startsWith(join(tuneDir(app.deps.home), "work"))).toBe(true);
    await m.waitFor(() => !status(m).includes(" · tuning") && tuneStarts(app).some((s) => stageOf(s.tag) === "composed"), 20_000);
    await m.waitFor(() => !existsSync(join(tuneDir(app.deps.home), "snapshots")) || readdirSync(join(tuneDir(app.deps.home), "snapshots")).length === 0, 10_000);
    expect(readdirSync(app.deps.cwd).sort()).toEqual(before);
  });

  test("when the cap trips, tuning turns off, the note shows, and the status segment goes", async () => {
    const { app, m } = await open({ settings: { "tune.enabled": true, "tune.max_usd": 0.05 }, tune: { stages: keptStages({ inv: { answer: EDIT_INV, costUsd: 0.1 } }) } });
    await m.waitFor(() => status(m).includes("tune on $0.00/$0.05"));
    await ask(m, "Summarize @a.txt");
    await m.waitForText(capNote(0.05), 20_000);
    await m.waitFor(() => !status(m).includes("tune on"));
    expect(loadSettings(app.deps.home).tune.enabled).toBe(false);
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(true);
    expect(tuneStarts(app).map((s) => stageOf(s.tag))).toEqual(["inv"]);
    expect(app.session.settings.profile).toBe("default");
  });

  test("/tune off during a tune sends run.cancel, notes what it cancelled, and opens no screen", async () => {
    const { app, m } = await open({ settings: { "tune.enabled": true }, tune: { stages: keptStages({ inv: { answer: EDIT_INV, delayMs: 5000 } }) } });
    await ask(m, "Summarize @a.txt");
    await m.waitFor(() => status(m).includes(" · tuning") && tuneStarts(app).length > 0, 15_000);
    await Bun.sleep(50);
    await ask(m, "/tune off");
    await m.waitForText("Tuning is off: cancelled the tune of t_", 10_000);
    expect(m.screen()).not.toContain("── /tune");
    expect(app.engine.calls.some((c) => c.method === "run.cancel")).toBe(true);
    expect(loadSettings(app.deps.home).tune.enabled).toBe(false);
    await m.waitFor(() => !status(m).includes("tune on"));
    // and again, with nothing to cancel
    await ask(m, "/tune off");
    await m.waitForText("Tuning is already off.");
  });

  test("/settings refuses tune.enabled = true with the hint", async () => {
    const { app, m } = await open();
    const at = settingRows().findIndex((r) => r.key === "tune.enabled");
    await command(m, "settings");
    for (let i = 0; i < at; i++) await m.press(KEYS.down);
    await m.press(" ");
    await m.waitForText(TUNE_ON_HINT);
    expect(loadSettings(app.deps.home).tune.enabled).toBe(false);
  });

  test("tuneSegment: the spend against the cap, tuning and waiting", () => {
    expect(tuneSegment({ spent_usd: 0.123, cap_usd: 1, running: null, waiting: null })).toBe("tune on $0.12/$1.00");
    expect(tuneSegment({ spent_usd: 0.12, cap_usd: 1, running: { id: "t_1", mode: "read", stage: "inv" }, waiting: { id: "t_2", mode: "repo" } })).toBe("tune on $0.12/$1.00 · tuning · 1 waiting");
  });

  test("the tune segment is the first one dropped when the line is narrow", () => {
    const segs: StatusSegment[] = [
      { id: "state", text: "idle" },
      { id: "root", text: "root fake/scripted" },
      { id: "sub", text: "sub same" },
      { id: "mode", text: "accept-edits" },
      { id: "tune", text: "tune on $0.00/$1.00 · tuning" },
    ];
    expect(layoutStatus(segs, 200).map((s) => s.id)).toEqual(["state", "root", "sub", "mode", "tune"]);
    expect(layoutStatus(segs, 60).map((s) => s.id)).toEqual(["state", "root", "sub", "mode"]);
  });
});
