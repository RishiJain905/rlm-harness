// KV cache: none; a test.
// /tuned (v1 step 9, task 7) against the fake engine: default first, then tuned-* newest first with their date, base
// and changes from tuned.jsonl, the active one marked; Enter writes `profile` with no run.start and no gateway call;
// with a conversation open the closing line shows and Enter closes it; a pending switch from a tune is dropped.

import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tunedChoices } from "../../src/interface/commands/tuned.tsx";
import { profilesDir, tuneDir } from "../../src/paths.ts";
import { loadSettings } from "../../src/settings.ts";
import { createFakeApp, type FakeApp, type FakeAppOptions, type TuneStageScript } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

setDefaultTimeout(60_000);

const OLD = "tuned-20261101-0900";
const NEW = "tuned-20261105-1200";

let app: FakeApp | undefined;
let m: Mounted | undefined;

afterEach(async () => {
  m?.unmount();
  await app?.dispose();
  app = undefined;
  m = undefined;
});

/** Two tuned profiles (only OLD has a tuned.jsonl line) and a user profile that isn't a tuned one. */
function profiles(home: string): void {
  for (const name of [OLD, NEW, "mine"]) {
    mkdirSync(join(profilesDir(home), name), { recursive: true });
    writeFileSync(join(profilesDir(home), name, "profile.toml"), 'contract = "rlmh-1"\n');
  }
  mkdirSync(tuneDir(home), { recursive: true });
  const line = { name: OLD, base: "default", base_hash: "h0", profile_hash: "h1", run_id: "r_1", changed: ["guidance", "read.max_turns"], at: "2026-11-01T09:00:00.000Z" };
  writeFileSync(join(tuneDir(home), "tuned.jsonl"), `${JSON.stringify(line)}\n`);
}

async function open(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; m: Mounted }> {
  app = await createFakeApp({ size: { columns: 160, rows: 34 }, ...opts });
  profiles(app.deps.home);
  m = mount(app.deps);
  await m.waitForText("idle");
  return { app, m };
}

async function ask(m: Mounted, text: string): Promise<void> {
  await m.type(text);
  await m.press(KEYS.enter);
}

async function tuned(m: Mounted): Promise<string> {
  await ask(m, "/tuned");
  await m.waitForText("── /tuned ");
  return m.waitForText("built-in");
}

const status = (m: Mounted) => m.screen().trimEnd().split("\n").at(-1)!;

describe("/tuned", () => {
  test("tunedChoices: default, then tuned-* newest first; other profiles are left out", () => {
    expect(tunedChoices(["default", "training-v4", OLD, "mine", NEW, `${NEW}-2`])).toEqual(["default", `${NEW}-2`, NEW, OLD]);
  });

  test("default first, then tuned-* newest first with date, base and changes, the active one marked", async () => {
    const { m } = await open({ settings: {} });
    let s = await tuned(m);
    const at = (x: string) => s.indexOf(x);
    expect(at("default")).toBeGreaterThan(-1);
    expect(at("default")).toBeLessThan(at(NEW));
    expect(at(NEW)).toBeLessThan(at(OLD));
    expect(s).not.toContain("mine");
    expect(s).not.toContain("training-v4");
    expect(s).toMatch(/\* default +built-in/);
    expect(s).toMatch(new RegExp(`${OLD} +2026-11-0\\d \\d\\d:\\d\\d  base default  2 changes`));
    expect(s).toMatch(new RegExp(`${NEW} +—  base —  —`));
    expect(s).not.toContain("Switching closes");
    await m.press(KEYS.esc);
    m.unmount();
    await app!.dispose();

    // an active profile that is neither: a line above the list names it
    const other = await open({ settings: { profile: "mine" } });
    s = await tuned(other.m);
    expect(s).toContain("The active harness is mine, which is neither default nor a tuned one.");
    expect(s).not.toMatch(/\* (default|tuned-)/);
  });

  test("Enter writes profile to settings.toml, with no run.start and no gateway call", async () => {
    const { app, m } = await open();
    const calls: string[] = [];
    const off = app.bus.on("call.start", (c) => void calls.push(c.call_id));
    await tuned(m);
    await m.press(KEYS.down); // NEW
    await m.press(KEYS.enter);
    await m.waitForText(`The active harness is now ${NEW}.`);
    expect(loadSettings(app.deps.home).profile).toBe(NEW);
    expect(app.session.settings.profile).toBe(NEW);
    await m.waitFor(() => new RegExp(`\\* ${NEW}`).test(m.screen()));
    expect(app.engine.calls.some((c) => c.method === "run.start")).toBe(false);
    expect(app.fetchCalls).toEqual([]);
    expect(calls).toEqual([]);
    // and back to default
    await m.press(KEYS.up);
    await m.press(KEYS.enter);
    await m.waitFor(() => loadSettings(app.deps.home).profile === "default");
    off();
  });

  test("with a conversation open, the closing line shows, and Enter closes it", async () => {
    const { app, m } = await open({ scenario: "conversation" });
    await ask(m, "Summarize @a.txt");
    await m.waitFor(() => status(m).startsWith("ready for a follow-up"), 10_000);
    const s = await tuned(m);
    expect(s).toContain("Switching closes the open conversation");
    await m.press(KEYS.down);
    await m.press(KEYS.enter);
    await m.waitFor(() => app.engine.calls.some((c) => c.method === "run.close"), 5000);
    expect(loadSettings(app.deps.home).profile).toBe(NEW);
    await m.press(KEYS.esc);
    await m.waitFor(() => !m.screen().includes("── /tuned") && !status(m).startsWith("ready for a follow-up"));
    expect(app.engine.calls.filter((c) => c.method === "run.start")).toHaveLength(1);
  });

  test("a pending switch from a tune is dropped after a pick", async () => {
    const edit = { decision: "EDIT", notes: ["n"], guidance: "Read in parts.\n", toml: {}, files: {} };
    const stages: Record<string, TuneStageScript> = {
      inv: { answer: edit },
      dom: { answer: { decision: "KEEP_BASE", notes: ["n"], guidance: null, toml: {}, files: {} } },
      "probe-inv": { answer: "42" },
      compose: { answer: { decision: "ADOPT", adopt: "inv", notes: ["n"], guidance: null, toml: {}, files: {} } },
      composed: { answer: "42" },
      reflect: { answer: { domain: "read", entry: "NO_ENTRY", edits: [] } },
    };
    const { app, m } = await open({ scenario: "conversation", settings: { "tune.enabled": true }, size: { columns: 260, rows: 34 }, tune: { stages } });
    await ask(m, "Summarize @a.txt");
    await m.waitForText("it becomes the active harness when this conversation ends", 20_000);
    await tuned(m);
    await m.press(KEYS.enter); // default, already active
    await m.waitForText("The pending switch to tuned-");
    await m.press(KEYS.esc);
    await ask(m, "/clear");
    await m.waitForText("New session.");
    await Bun.sleep(100);
    expect(m.screen()).not.toContain("is now the active harness");
    expect(loadSettings(app.deps.home).profile).toBe("default");
  });
});
