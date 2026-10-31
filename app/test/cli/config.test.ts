// KV cache: none
// `rlmh config`: set, get and list round trip in a temp home, every §8 key listed, errors exit 2.
// No engine and no requests: an RLMH_ENGINE that can't start would fail any command that tried.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configCommand } from "../../src/cli/config.ts";
import { SCHEMA } from "../../src/settings.ts";
import { rlmh, temp, type Temp } from "./helpers.ts";

let t: Temp;
beforeAll(() => {
  t = temp("rlmh-config-");
});
afterAll(() => t.cleanup());

async function config(home: string, ...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  const code = await configCommand(argv, { home, stdout: { write: (s) => void (stdout += s) }, stderr: { write: (s) => void (stderr += s) } });
  return { code, stdout, stderr };
}

test("set, get and list round trip; settings.toml is written", async () => {
  const home = join(t.dir, "round");
  expect(await config(home, "set", "root.model", "fake/scripted")).toEqual({ code: 0, stdout: "root.model = fake/scripted\n", stderr: "" });
  expect(existsSync(join(home, "settings.toml"))).toBe(true);
  expect(readFileSync(join(home, "settings.toml"), "utf8")).toContain('model = "fake/scripted"');
  expect((await config(home, "set", "display.verbose", "true")).stdout).toBe("display.verbose = true\n");
  expect((await config(home, "set", "providers.local.max_in_flight", "4")).stdout).toBe("providers.local.max_in_flight = 4\n");
  expect((await config(home, "get", "root.model")).stdout).toBe("fake/scripted\n");
  expect((await config(home, "get", "display.verbose")).stdout).toBe("true\n");
  expect((await config(home, "get", "permissions.mode")).stdout).toBe("accept-edits\n");
  expect((await config(home, "get", "providers.local.base_url")).stdout).toBe("http://localhost:8000/v1\n");

  const list = await config(home, "list");
  expect(list.code).toBe(0);
  const keys = list.stdout.trimEnd().split("\n").map((l) => l.split(" = ")[0]);
  // every §8 key, in schema order; provider keys for each provider that has settings
  const expected = SCHEMA.flatMap((d) => (d.key === "providers.<id>.base_url" ? ["providers.local.base_url", "providers.local.max_in_flight"] : d.key.startsWith("providers.") ? [] : [d.key]));
  expect(keys).toEqual(expected);
  expect(list.stdout).toContain("root.model = fake/scripted\n");
  expect(list.stdout).toContain("providers.local.max_in_flight = 4\n");
});

test("a fresh home lists every non-provider key with its default", async () => {
  const { code, stdout } = await config(join(t.dir, "fresh"), "list");
  expect(code).toBe(0);
  for (const def of SCHEMA.filter((d) => !d.key.startsWith("providers."))) expect(stdout).toContain(`${def.key} = ${def.default}\n`);
  expect(existsSync(join(t.dir, "fresh"))).toBe(false); // list writes nothing
});

test("unknown keys, bad values and bad usage exit 2", async () => {
  const home = join(t.dir, "bad");
  for (const argv of [
    ["get", "nope"],
    ["set", "nope", "1"],
    ["set", "root.thinking", "huge"],
    ["set", "providers.local.max_in_flight", "zero"],
    ["set", "root.model", "no-slash"],
    [],
    ["frob"],
    ["get"],
    ["set", "root.model"],
  ]) {
    const r = await config(home, ...argv);
    expect([argv.join(" "), r.code]).toEqual([argv.join(" "), 2]);
    expect(r.stderr).not.toBe("");
    expect(r.stdout).toBe("");
  }
  expect(existsSync(join(home, "settings.toml"))).toBe(false);
});

test("rlmh config through main.ts never starts the engine", async () => {
  const home = join(t.dir, "main");
  const env = { RLMH_ENGINE: "rlmh-no-such-engine-FAKE" };
  const set = await rlmh(["config", "set", "sub.model", "fake/scripted"], { home, env });
  expect(set).toEqual({ code: 0, stdout: "sub.model = fake/scripted\n", stderr: "" });
  const get = await rlmh(["config", "get", "sub.model"], { home, env });
  expect(get.stdout).toBe("fake/scripted\n");
  expect((await rlmh(["config", "get", "nope"], { home, env })).code).toBe(2);
});
