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
  defaultSetting,
  defaultSettings,
  getSetting,
  listSettings,
  loadSettings,
  saveSettings,
  setSetting,
  refuseTuneOn,
  TUNE_ON_HINT,
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
  "conversation.follow_ups": true,
  "tune.enabled": false,
  "tune.model": "",
  "tune.max_usd": 1,
  "tune.library": true,
  "tune.test": "",
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
    expect(paths.tuneDir(h)).toBe(join(h, "tune"));
    expect(paths.libraryDir(h)).toBe(join(h, "library"));
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
      "conversation.follow_ups",
      "tune.enabled",
      "tune.model",
      "tune.max_usd",
      "tune.library",
      "tune.test",
    ]);
    expect(SCHEMA.find((d) => d.key === "tune.max_usd")!.type).toBe("number");
    for (const def of SCHEMA) expect(def.doc.length).toBeGreaterThan(0);
    const s = defaultSettings();
    for (const [key, value] of Object.entries(DEFAULTS)) expect(getSetting(s, key)).toBe(value);
    expect(s.providers).toEqual({});
    expect(listSettings(s).map(([k]) => k)).toEqual(SCHEMA.filter((d) => !d.key.includes("<id>")).map((d) => d.key));
  });

  test("default_setting: the value a key has when nothing sets it, provider-aware like getSetting", () => {
    // the schema's own default for base_url is "", but the local provider has a default server
    expect(defaultSetting("providers.local.base_url")).toBe("http://localhost:8000/v1");
    expect(defaultSetting("providers.custom.base_url")).toBe("");
    expect(defaultSetting("providers.openai.base_url")).toBe("");
    // and it is exactly what getSetting gives for an untouched key, for every key in the listing
    const s = defaultSettings();
    for (const [key, value] of Object.entries(DEFAULTS)) expect(defaultSetting(key)).toBe(value);
    for (const [key] of listSettings(setSetting(s, "providers.local.max_in_flight", "32"))) expect(defaultSetting(key)).toBe(getSetting(s, key));
    expect(defaultSetting("providers.local.max_in_flight")).toBe(16);
    expect(defaultSetting("permissions.mode")).toBe("accept-edits");
    expectSettingsError(() => defaultSetting("nope"), "nope");
    expectSettingsError(() => defaultSetting("providers.nosuch.base_url"), "nosuch");
    // a reset through setSetting brings the local server back instead of "no base URL"
    let custom = setSetting(s, "providers.local.base_url", "http://other.test:9000/v1");
    expect(getSetting(custom, "providers.local.base_url")).toBe("http://other.test:9000/v1");
    custom = setSetting(custom, "providers.local.base_url", defaultSetting("providers.local.base_url"));
    expect(getSetting(custom, "providers.local.base_url")).toBe("http://localhost:8000/v1");
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
    for (const key of ["root.thinking", "sub.thinking"]) expectSettingsError(() => setSetting(s, key, "huge"), key, "default, off, minimal, low, medium, high, xhigh, max");
    for (const level of ["minimal", "xhigh", "max"]) expect(getSetting(setSetting(structuredClone(s), "root.thinking", level), "root.thinking")).toBe(level); // D-250
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

  test("number: finite and above 0, coerced from a decimal string, saved as a TOML float (D-220)", () => {
    const s = defaultSettings();
    for (const [given, want] of [["2.5", 2.5], ["3", 3], [".5", 0.5], ["0.01", 0.01], [2.5, 2.5], [7, 7]] as const) {
      expect(getSetting(setSetting(s, "tune.max_usd", given), "tune.max_usd")).toBe(want);
    }
    for (const bad of ["0", "-1", "abc", "", "1e3", "Infinity", "NaN", "1.2.3", 0, -1, Infinity, NaN, true]) {
      expectSettingsError(() => setSetting(s, "tune.max_usd", bad), "tune.max_usd", "above 0");
    }
    // written as a float: the default 1 is `1.0`, and it loads back as the same number
    saveSettings(dir, s);
    let text = readFileSync(paths.settingsPath(dir), "utf8");
    expect(text).toContain('[tune]\nenabled = false\nmodel = ""\nmax_usd = 1.0\nlibrary = true\ntest = ""\n');
    expect(loadSettings(dir)).toEqual(s);
    saveSettings(dir, setSetting(s, "tune.max_usd", "2.5"));
    text = readFileSync(paths.settingsPath(dir), "utf8");
    expect(text).toContain("max_usd = 2.5\n");
    expect(getSetting(loadSettings(dir), "tune.max_usd")).toBe(2.5);
    // an int key is still written as an int
    saveSettings(dir, setSetting(s, "providers.local.max_in_flight", "8"));
    expect(readFileSync(paths.settingsPath(dir), "utf8")).toContain("max_in_flight = 8\n");
    // a TOML integer is a number too
    writeFileSync(paths.settingsPath(dir), "[tune]\nmax_usd = 3\n");
    expect(getSetting(loadSettings(dir), "tune.max_usd")).toBe(3);
  });

  test("tune keys: tune.model is checked like root.model; tune.enabled turns on only through /tune on (D-231, D-232)", () => {
    const s = defaultSettings();
    expect(getSetting(setSetting(s, "tune.model", "fake/scripted"), "tune.model")).toBe("fake/scripted");
    expect(getSetting(setSetting(s, "tune.model", ""), "tune.model")).toBe("");
    expectSettingsError(() => setSetting(s, "tune.model", "no-slash"), "tune.model", "provider/model");
    expectSettingsError(() => setSetting(s, "tune.model", "nosuch/model"), "tune.model", "unknown provider");
    expect(getSetting(setSetting(s, "tune.test", "bun test --bail"), "tune.test")).toBe("bun test --bail");
    expect(getSetting(setSetting(s, "tune.library", "false"), "tune.library")).toBe(false);
    // setSetting itself takes true: /tune on writes it through applySetting after its estimate
    expect(getSetting(setSetting(s, "tune.enabled", true), "tune.enabled")).toBe(true);
    // the guard /settings and rlmh config use refuses true, with the hint, and lets false through
    for (const on of [true, "true"]) expectSettingsError(() => refuseTuneOn("tune.enabled", on), "tune.enabled", TUNE_ON_HINT);
    for (const off of [false, "false"]) expect(() => refuseTuneOn("tune.enabled", off)).not.toThrow();
    expect(() => refuseTuneOn("tune.library", true)).not.toThrow();
    expect(TUNE_ON_HINT).toBe("Use /tune on, which shows the cost first");
  });

  test("load_errors", () => {
    const file = paths.settingsPath(dir);
    const cases: [string, string][] = [
      ["profile = \n", "TOML"],
      ['foo = 1\n', "foo"],
      ['[display]\nverbose = "yes"\n', "display.verbose"],
      ["[providers.local]\nmax_in_flight = 0\n", "providers.local.max_in_flight"],
      ['root = "x"\n', "root"],
      ["[tune]\nmax_usd = 0\n", "tune.max_usd"],
      ['[tune]\nmax_usd = "2.5"\n', "tune.max_usd"],
      ['[tune]\nmodel = "no-slash"\n', "tune.model"],
    ];
    for (const [text, key] of cases) {
      writeFileSync(file, text);
      expectSettingsError(() => loadSettings(dir), file, key);
      expect(readFileSync(file, "utf8")).toBe(text); // never rewritten
    }
  });
});
