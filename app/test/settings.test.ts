// KV cache: none
// settings.ts against architecture §8, and paths.ts against §9.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import * as paths from "../src/paths.ts";
import {
  SCHEMA,
  SettingsError,
  defaultSettings,
  getSetting,
  listSettings,
  loadSettings,
  saveSettings,
  setSetting,
} from "../src/settings.ts";

const DEFAULTS: Record<string, string | number | boolean> = {
  "root.model": "",
  "root.thinking": "default",
  "sub.model": "",
  "sub.thinking": "default",
  profile: "default",
  "permissions.mode": "accept-edits",
  call_format: "auto",
  "providers.local.base_url": "http://localhost:8000/v1",
  "providers.local.max_in_flight": 16,
  "providers.openai.base_url": "",
  "providers.openai.max_in_flight": 16,
  "display.verbose": false,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlmh-settings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function expectSettingsError(fn: () => unknown, ...parts: string[]): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SettingsError);
  for (const part of parts) expect((caught as Error).message).toContain(part);
}

describe("paths", () => {
  test("home", () => {
    expect(paths.home({ RLMH_HOME: "some/where" })).toBe(resolve("some/where"));
    expect(isAbsolute(paths.home({ RLMH_HOME: "some/where" }))).toBe(true);
    expect(paths.home({ RLMH_HOME: "" })).toBe(join(homedir(), ".rlm-harness"));
    expect(paths.home({})).toBe(join(homedir(), ".rlm-harness"));
    const h = join(dir, "h");
    expect(paths.settingsPath(h)).toBe(join(h, "settings.toml"));
    expect(paths.keyIndexPath(h)).toBe(join(h, "key-index.json"));
    expect(paths.keysPath(h)).toBe(join(h, "keys.json"));
    expect(paths.refreshedModelsPath(h)).toBe(join(h, "models-refreshed.json"));
    expect(paths.profilesDir(h)).toBe(join(h, "profiles"));
    expect(paths.runsDir(h)).toBe(join(h, "runs"));
    expect(paths.scratchDir("r_0123456789ab", h)).toBe(join(h, "scratch", "r_0123456789ab"));
    expect(paths.pythonDir(h)).toBe(join(h, "python"));
    expect(paths.engineDir("0.1.0", h)).toBe(join(h, "engine", "0.1.0"));
    expect(paths.binDir(h)).toBe(join(h, "bin"));
    expect(existsSync(h)).toBe(false); // the helpers create nothing
  });
});

describe("settings", () => {
  test("defaults", () => {
    expect(SCHEMA.map((d) => d.key)).toEqual([
      "root.model",
      "root.thinking",
      "sub.model",
      "sub.thinking",
      "profile",
      "permissions.mode",
      "call_format",
      "providers.<id>.base_url",
      "providers.<id>.max_in_flight",
      "display.verbose",
    ]);
    for (const def of SCHEMA) expect(def.doc.length).toBeGreaterThan(0);
    const s = defaultSettings();
    for (const [key, value] of Object.entries(DEFAULTS)) expect(getSetting(s, key)).toBe(value);
    expect(s.providers).toEqual({});
    expect(listSettings(s).map(([k]) => k)).toEqual(SCHEMA.filter((d) => !d.key.includes("<id>")).map((d) => d.key));
  });

  test("save_load", () => {
    expect(loadSettings(dir)).toEqual(defaultSettings());
    let s = defaultSettings();
    s = setSetting(s, "root.model", "anthropic/example-model");
    s = setSetting(s, "permissions.mode", "bypass");
    s = setSetting(s, "providers.local.max_in_flight", "32");
    s = setSetting(s, "providers.custom.base_url", 'http://example.test:9000/v1?q="x"');
    s = setSetting(s, "display.verbose", "true");
    const home = join(dir, "new-home");
    saveSettings(home, s);
    expect(loadSettings(home)).toEqual(s);
    expect(getSetting(loadSettings(home), "providers.local.max_in_flight")).toBe(32);
    const text = readFileSync(paths.settingsPath(home), "utf8");
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain("[providers.local]");
    expect(existsSync(`${paths.settingsPath(home)}.tmp`)).toBe(false);
    expect(listSettings(s).map(([k]) => k)).toContain("providers.custom.max_in_flight");
  });

  test("set_setting", () => {
    const s = defaultSettings();
    const before = structuredClone(s);
    for (const key of ["root.thinking", "sub.thinking"]) expectSettingsError(() => setSetting(s, key, "max"), key, "default, off, low, medium, high");
    expectSettingsError(() => setSetting(s, "permissions.mode", "yolo"), "permissions.mode", "default, accept-edits, bypass");
    expectSettingsError(() => setSetting(s, "call_format", "json"), "call_format", "auto, fenced, native");
    expect(getSetting(setSetting(s, "display.verbose", "true"), "display.verbose")).toBe(true);
    expect(getSetting(setSetting(s, "display.verbose", false), "display.verbose")).toBe(false);
    expectSettingsError(() => setSetting(s, "display.verbose", "yes"), "display.verbose", "true or false");
    for (const bad of ["0", "-1", "1.5", "abc", 0, -1, 1.5]) {
      expectSettingsError(() => setSetting(s, "providers.local.max_in_flight", bad), "providers.local.max_in_flight");
    }
    expect(getSetting(setSetting(s, "providers.local.max_in_flight", "32"), "providers.local.max_in_flight")).toBe(32);
    expect(getSetting(setSetting(s, "providers.local.max_in_flight", 32), "providers.local.max_in_flight")).toBe(32);
    expectSettingsError(() => setSetting(s, "no.such.key", "x"), "no.such.key");
    expectSettingsError(() => setSetting(s, "providers.Bad!.base_url", "x"), "Bad!");
    expectSettingsError(() => setSetting(s, "root", "x"), "root");
    expectSettingsError(() => getSetting(s, "nope"), "nope");
    expect(s).toEqual(before); // setSetting is pure
  });

  test("load_errors", () => {
    const file = paths.settingsPath(dir);
    const cases: [string, string][] = [
      ["profile = \n", "TOML"],
      ['foo = 1\n', "foo"],
      ['[display]\nverbose = "yes"\n', "display.verbose"],
      ["[providers.local]\nmax_in_flight = 0\n", "providers.local.max_in_flight"],
      ['root = "x"\n', "root"],
    ];
    for (const [text, key] of cases) {
      writeFileSync(file, text);
      expectSettingsError(() => loadSettings(dir), file, key);
      expect(readFileSync(file, "utf8")).toBe(text); // never rewritten
    }
  });
});
