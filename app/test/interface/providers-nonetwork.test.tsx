// KV cache: none; a test.
// /providers makes no request when a key is saved, rejected, made active or deleted: both
// globalThis.fetch and the gateway's injected fetch are counted, and the key never reaches a frame
// or a file. "Refresh models" is the one request, and only on r.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { checkFormat } from "../../src/gateway/keys.ts";
import { PROVIDERS } from "../../src/gateway/providers.ts";
import { createFakeApp, type FakeApp, type FakeAppOptions } from "../fakes/engine.ts";
import { KEYS, mount, type Mounted } from "./helpers.ts";

setDefaultTimeout(20_000);

const LISTED = PROVIDERS.filter((p) => p.id !== "fake");
const TARGET = PROVIDERS.find((p) => p.needsKey && p.id !== "fake")!;
const PREFIXES: Record<string, string> = { anthropic: "sk-ant-", openai: "sk-", deepseek: "sk-", openrouter: "sk-or-" };

/** A key `checkFormat` accepts for the provider; it holds FAKE, so the gate's secret scan lets it through. */
function sampleKey(id: string, tail = "q7Wm2Lp9Xc4Vb8Nz"): string {
  return `${PREFIXES[id] ?? ""}FAKE${tail}${tail}`;
}

let app: FakeApp | undefined;
let m: Mounted | undefined;
let globalFetches = 0;
const realFetch = globalThis.fetch;

beforeEach(() => {
  globalFetches = 0;
  globalThis.fetch = Object.assign(
    async () => {
      globalFetches += 1;
      throw new Error("no network in this test");
    },
    { preconnect: () => undefined },
  ) as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  m?.unmount();
  await app?.dispose();
  app = undefined;
  m = undefined;
});

async function open(opts: FakeAppOptions = {}): Promise<{ app: FakeApp; m: Mounted }> {
  app = await createFakeApp(opts);
  m = mount(app.deps);
  await m.waitForText("idle");
  await m.type("/providers");
  await m.press(KEYS.enter);
  await m.waitForText("── /providers");
  return { app, m };
}

/** Into the target provider's own screen. */
async function enterTarget(m: Mounted): Promise<void> {
  for (let i = 0; i < LISTED.indexOf(TARGET); i++) await m.press(KEYS.down);
  await m.press(KEYS.enter);
  await m.waitForText("a add  d delete");
}

async function addKey(m: Mounted, key: string, label: string): Promise<void> {
  await m.press("a");
  await m.waitForText("Key: ");
  await m.type(key);
  await m.press(KEYS.enter);
  await m.waitForText("Label (optional)");
  await m.type(label);
  await m.press(KEYS.enter);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe("/providers makes no request", () => {
  test("every sample key passes checkFormat", () => {
    for (const p of PROVIDERS.filter((d) => d.needsKey)) expect(checkFormat(p.id, sampleKey(p.id))).toBeNull();
  });

  test("(1, 2) saving a key: Saved, listed, zero requests, and the key is in no frame and no file", async () => {
    const { app, m } = await open();
    const starts: unknown[] = [];
    app.bus.on("call.start", (e) => starts.push(e));
    const engineCalls = app.engine.calls.length;
    await enterTarget(m);
    const key = sampleKey(TARGET.id);
    await addKey(m, key, "work");
    await m.waitForText("Saved. Nothing was sent anywhere.");
    const keys = await app.deps.keys.list(TARGET.id);
    expect(keys.map((k) => k.label)).toEqual(["work"]);
    expect((await app.deps.keys.resolve(TARGET.id))?.key).toBe(key);
    expect(globalFetches).toBe(0);
    expect(app.fetchCalls).toEqual([]);
    expect(starts).toEqual([]);
    expect(app.engine.calls.length).toBe(engineCalls);
    for (const f of m.frames) expect(f).not.toContain(key);
    for (const f of m.frames) expect(f).not.toContain(key.slice(0, 20));
    for (const file of filesUnder(app.deps.home)) expect(readFileSync(file, "utf8")).not.toContain(key);
    await m.press(KEYS.esc);
    await m.waitForText(`active ...${key.slice(-4)} (work)`);
  });

  test("(3) a key checkFormat rejects shows its message and saves nothing", async () => {
    const { app, m } = await open();
    await enterTarget(m);
    const bad = "FAKE-not-a-key";
    const problem = checkFormat(TARGET.id, bad)!;
    expect(problem).not.toBeNull();
    await m.press("a");
    await m.type(bad);
    await m.press(KEYS.enter);
    await m.waitForText(problem.slice(0, 40));
    expect(m.screen()).not.toContain("Label (optional)");
    expect(await app.deps.keys.list()).toEqual([]);
    expect(globalFetches).toBe(0);
    expect(app.fetchCalls).toEqual([]);
  });

  test("(4) set active and delete with y make no request", async () => {
    const { app, m } = await open();
    await enterTarget(m);
    await addKey(m, sampleKey(TARGET.id, "a1b2c3d4e5f6g7h8"), "first");
    await m.waitForText("Saved.");
    await addKey(m, sampleKey(TARGET.id, "z9y8x7w6v5u4t3s2"), "second");
    await m.waitFor(async () => (await app.deps.keys.list(TARGET.id)).length === 2);
    await m.waitForText("second");
    await m.press(KEYS.down);
    await m.press("s");
    await m.waitForText("second is the active key.");
    expect((await app.deps.keys.list(TARGET.id)).find((k) => k.active)?.label).toBe("second");
    await m.press("d");
    await m.waitForText("Delete second");
    await m.press("y");
    await m.waitForText("Deleted second.");
    expect((await app.deps.keys.list(TARGET.id)).map((k) => k.label)).toEqual(["first"]);
    expect(globalFetches).toBe(0);
    expect(app.fetchCalls).toEqual([]);
  });

  test("(5) refresh models: no call until r, then exactly one, for that provider", async () => {
    const { app, m } = await open();
    const spy = spyOn(app.session.gateway, "refreshModels");
    await enterTarget(m);
    await m.waitForText(`sends one request to ${new URL(TARGET.baseUrl!).host} with the active key`);
    await addKey(m, sampleKey(TARGET.id), "work");
    await m.waitForText("Saved.");
    expect(spy).toHaveBeenCalledTimes(0);
    await m.press("r");
    await m.waitFor(() => spy.mock.calls.length === 1);
    expect(spy.mock.calls[0]).toEqual([TARGET.id]);
    await m.waitFor(() => !m.screen().includes("Refreshing"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(globalFetches).toBe(0); // the gateway's own fetch is the injected one
  });

  test("(6) a key from the environment is named, never shown", async () => {
    const value = sampleKey(TARGET.id, "e1n2v3k4e5y6s7x8");
    const { m } = await open({ env: { [TARGET.envVar!]: value } });
    await m.waitForText(`key from ${TARGET.envVar}`);
    await enterTarget(m);
    await m.waitForText(`key from ${TARGET.envVar}`);
    for (const f of m.frames) expect(f).not.toContain(value.slice(-12));
  });

  test("(7) the list is PROVIDERS without the fake", async () => {
    const { m } = await open();
    const s = m.screen();
    for (const p of LISTED) expect(s).toContain(p.name);
    expect(s).not.toContain("Fake (hidden)");
    const local = PROVIDERS.find((p) => p.id === "local")!;
    expect(s).toMatch(new RegExp(`${local.name}.*http://localhost:8000/v1`));
  });
});
