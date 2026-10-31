// KV cache: none
// The step 5 additions to settings.ts: base_url for local and custom only, max_in_flight bounds,
// model refs that name a known provider, unknown provider ids refused, and the defaults round trip.
// The older settings cases stay in test/settings.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROVIDER_IDS } from "../../src/gateway/providers.ts";
import { settingsPath } from "../../src/paths.ts";
import {
  SettingsError,
  defaultSettings,
  getSetting,
  listSettings,
  loadSettings,
  saveSettings,
  setSetting,
} from "../../src/settings.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlmh-gwsettings-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Runs fn, expects a SettingsError, and checks that its message holds every part. */
function refused(fn: () => unknown, ...parts: string[]): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SettingsError);
  for (const part of parts) expect((caught as Error).message).toContain(part);
}

function writeToml(text: string): string {
  const file = settingsPath(dir);
  writeFileSync(file, text);
  return file;
}

describe("providers.<id>.base_url", () => {
  test("local and custom accept an http or https URL, or empty", () => {
    for (const id of ["local", "custom"]) {
      const key = `providers.${id}.base_url`;
      for (const url of ["http://localhost:8000/v1", "http://127.0.0.1:11434/v1", "https://llm.example.test/v1", "https://example.test:8443/api/v1?x=1", "HTTP://EXAMPLE.TEST/V1", ""]) {
        expect(getSetting(setSetting(defaultSettings(), key, url), key), `${key} = ${url}`).toBe(url);
      }
    }
  });

  test("anything that isn't an http(s) URL is refused, naming the key and the value", () => {
    const s = defaultSettings();
    for (const id of ["local", "custom"]) {
      const key = `providers.${id}.base_url`;
      for (const bad of ["localhost:8000/v1", "ftp://example.test/v1", "file:///tmp/x", "ws://example.test", "example.test", "http://", "https://", "//example.test/v1", "not a url", " ", "javascript:alert(1)"]) {
        refused(() => setSetting(s, key, bad), key, "http:// or https:// URL", JSON.stringify(bad));
      }
    }
  });

  test("only local and custom take a base_url; every other provider refuses it, even empty", () => {
    const s = defaultSettings();
    for (const id of PROVIDER_IDS.filter((p) => p !== "local" && p !== "custom")) {
      refused(() => setSetting(s, `providers.${id}.base_url`, "https://example.test/v1"), `providers.${id}.base_url`, "only local and custom");
      refused(() => setSetting(s, `providers.${id}.base_url`, ""), `providers.${id}.base_url`, "only local and custom");
    }
  });

  test("the defaults: local is http://localhost:8000/v1, every other provider is empty", () => {
    const s = defaultSettings();
    expect(getSetting(s, "providers.local.base_url")).toBe("http://localhost:8000/v1");
    for (const id of PROVIDER_IDS.filter((p) => p !== "local")) expect(getSetting(s, `providers.${id}.base_url`), id).toBe("");
    // Emptying local's URL is a choice that sticks, and reads back empty.
    expect(getSetting(setSetting(s, "providers.local.base_url", ""), "providers.local.base_url")).toBe("");
  });

  test("a bad value is refused when it comes from settings.toml, with the file named", () => {
    const file = writeToml('[providers.custom]\nbase_url = "ftp://example.test/v1"\n');
    refused(() => loadSettings(dir), file, "providers.custom.base_url", "http:// or https:// URL");
    writeToml('[providers.openai]\nbase_url = "https://example.test/v1"\n');
    refused(() => loadSettings(dir), file, "providers.openai.base_url", "only local and custom");
    expect(readFileSync(file, "utf8")).toContain("openai"); // the file is never rewritten
    writeToml('[providers.custom]\nbase_url = "https://example.test/v1"\n');
    expect(getSetting(loadSettings(dir), "providers.custom.base_url")).toBe("https://example.test/v1");
  });
});

describe("providers.<id>.max_in_flight", () => {
  test("the default is 16 for every provider", () => {
    const s = defaultSettings();
    for (const id of PROVIDER_IDS) expect(getSetting(s, `providers.${id}.max_in_flight`), id).toBe(16);
  });

  test("1 to 256 is accepted for every provider, as a number or a numeric string", () => {
    const s = defaultSettings();
    for (const id of PROVIDER_IDS) {
      const key = `providers.${id}.max_in_flight`;
      for (const ok of [1, 4, 16, 255, 256]) {
        expect(getSetting(setSetting(s, key, ok), key), `${key} = ${ok}`).toBe(ok);
        expect(getSetting(setSetting(s, key, String(ok)), key), `${key} = "${ok}"`).toBe(ok);
      }
    }
  });

  test("0, negatives, fractions and words are refused; so is anything over 256", () => {
    const s = defaultSettings();
    const key = "providers.openai.max_in_flight";
    for (const bad of [0, -1, 1.5, "0", "-3", "1.5", "abc", "", "0x10", Number.NaN, Infinity]) {
      refused(() => setSetting(s, key, bad), key, "whole number, 1 or more");
    }
    for (const bad of [257, 1000, "257", "300"]) refused(() => setSetting(s, key, bad), key, "256 or less", String(bad));
  });

  test("the bounds hold when the value comes from settings.toml", () => {
    const file = writeToml("[providers.anthropic]\nmax_in_flight = 257\n");
    refused(() => loadSettings(dir), file, "providers.anthropic.max_in_flight", "256 or less");
    writeToml("[providers.anthropic]\nmax_in_flight = 0\n");
    refused(() => loadSettings(dir), file, "providers.anthropic.max_in_flight", "whole number, 1 or more");
    writeToml("[providers.anthropic]\nmax_in_flight = 256\n");
    expect(getSetting(loadSettings(dir), "providers.anthropic.max_in_flight")).toBe(256);
  });
});

describe("root.model and sub.model", () => {
  test("a known provider and a model are accepted, fake/scripted included", () => {
    const s = defaultSettings();
    const ok = [
      "anthropic/claude-sonnet-5-5",
      "openai/gpt-5",
      "deepseek/deepseek-v4-flash",
      "gemini/gemini-2.5-flash",
      "local/my-model",
      "custom/whatever",
      "fake/scripted",
      "openrouter/anthropic/claude-sonnet-5", // the model part may hold more slashes
    ];
    for (const key of ["root.model", "sub.model"]) {
      for (const value of ok) expect(getSetting(setSetting(s, key, value), key), `${key} = ${value}`).toBe(value);
    }
  });

  test("an empty string is the unset value", () => {
    const s = setSetting(defaultSettings(), "root.model", "fake/scripted");
    expect(getSetting(setSetting(s, "root.model", ""), "root.model")).toBe("");
    expect(getSetting(setSetting(s, "sub.model", ""), "sub.model")).toBe("");
  });

  test("an unknown provider is refused, naming the provider and the ones to use", () => {
    const s = defaultSettings();
    for (const key of ["root.model", "sub.model"]) {
      for (const bad of ["nope/some-model", "Anthropic/claude-sonnet-5-5", "claude/sonnet", "fakes/scripted"]) {
        const id = bad.slice(0, bad.indexOf("/"));
        refused(() => setSetting(s, key, bad), key, "unknown provider", `"${id}"`, "anthropic, openai, deepseek, openrouter, gemini, local, custom");
      }
    }
  });

  test("the hidden fake provider is accepted but not listed in the message", () => {
    let message = "";
    try {
      setSetting(defaultSettings(), "root.model", "nope/x");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("unknown provider");
    expect(message).not.toContain("fake");
  });

  test("a value that isn't provider/model is refused", () => {
    const s = defaultSettings();
    for (const key of ["root.model", "sub.model"]) {
      for (const bad of ["anthropic", "claude-sonnet-5-5", "/claude", "anthropic/", "/", " "]) {
        refused(() => setSetting(s, key, bad), key, "provider/model", JSON.stringify(bad));
      }
    }
  });

  test("the check applies when the value comes from settings.toml, with the file named", () => {
    const file = writeToml('[root]\nmodel = "nope/x"\n');
    refused(() => loadSettings(dir), file, "root.model", "unknown provider");
    writeToml('[sub]\nmodel = "anthropic"\n');
    refused(() => loadSettings(dir), file, "sub.model", "provider/model");
    writeToml('[root]\nmodel = "fake/scripted"\n\n[sub]\nmodel = "openai/gpt-5"\n');
    const s = loadSettings(dir);
    expect(getSetting(s, "root.model")).toBe("fake/scripted");
    expect(getSetting(s, "sub.model")).toBe("openai/gpt-5");
  });

  test("the other settings keep their own rules", () => {
    // A model-looking value is only checked for the two model keys.
    const s = setSetting(defaultSettings(), "profile", "nope/not-a-model");
    expect(getSetting(s, "profile")).toBe("nope/not-a-model");
  });
});

describe("unknown provider ids in providers.<id>.*", () => {
  test("setSetting and getSetting refuse an id that isn't a provider, for either key", () => {
    const s = defaultSettings();
    for (const id of ["nope", "openaii", "anthropic2", "fakes"]) {
      for (const field of ["base_url", "max_in_flight"]) {
        const key = `providers.${id}.${field}`;
        refused(() => setSetting(s, key, field === "base_url" ? "http://x.test" : 4), `unknown provider "${id}"`, key, "anthropic, openai, deepseek, openrouter, gemini, local, custom");
        refused(() => getSetting(s, key), `unknown provider "${id}"`);
      }
    }
  });

  test("an id of the wrong shape is still refused on its shape", () => {
    refused(() => setSetting(defaultSettings(), "providers.Bad!.max_in_flight", 4), 'bad provider id "Bad!"');
    refused(() => setSetting(defaultSettings(), "providers.1st.max_in_flight", 4), 'bad provider id "1st"');
  });

  test("every real provider id is accepted for max_in_flight, fake included", () => {
    expect(PROVIDER_IDS).toEqual(["anthropic", "openai", "deepseek", "openrouter", "gemini", "local", "custom", "fake"]);
    let s = defaultSettings();
    for (const id of PROVIDER_IDS) s = setSetting(s, `providers.${id}.max_in_flight`, 3);
    expect(Object.keys(s.providers)).toEqual([...PROVIDER_IDS]);
    expect(listSettings(s).map(([k]) => k)).toContain("providers.fake.max_in_flight");
  });

  test("settings.toml with an unknown provider table is refused, with the file named", () => {
    const file = writeToml("[providers.nope]\nmax_in_flight = 4\n");
    refused(() => loadSettings(dir), file, 'unknown provider "nope"', "providers.nope.max_in_flight");
    expect(readFileSync(file, "utf8")).toBe("[providers.nope]\nmax_in_flight = 4\n"); // never rewritten
  });

  test("an unknown key under a real provider is still an unknown setting", () => {
    refused(() => setSetting(defaultSettings(), "providers.openai.timeout", 5), "providers.openai.timeout");
    refused(() => setSetting(defaultSettings(), "providers.openai", "x"), "providers.openai");
  });
});

describe("defaults and the settings file", () => {
  test("the defaults round-trip through saveSettings and loadSettings", () => {
    const s = defaultSettings();
    saveSettings(dir, s);
    expect(loadSettings(dir)).toEqual(s);
    const text = readFileSync(settingsPath(dir), "utf8");
    expect(text).not.toContain("\r");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("a missing settings.toml gives the defaults, including the step 5 values", () => {
    const s = loadSettings(join(dir, "empty-home"));
    expect(s).toEqual(defaultSettings());
    expect(getSetting(s, "providers.local.base_url")).toBe("http://localhost:8000/v1");
    expect(getSetting(s, "providers.local.max_in_flight")).toBe(16);
    expect(getSetting(s, "root.model")).toBe("");
  });

  test("settings with every step 5 key set round-trip", () => {
    let s = defaultSettings();
    s = setSetting(s, "root.model", "fake/scripted");
    s = setSetting(s, "sub.model", "openrouter/anthropic/claude-sonnet-5");
    s = setSetting(s, "providers.local.base_url", "http://127.0.0.1:11434/v1");
    s = setSetting(s, "providers.custom.base_url", "https://llm.example.test/v1");
    s = setSetting(s, "providers.openai.max_in_flight", 4);
    s = setSetting(s, "providers.anthropic.max_in_flight", "256");
    s = setSetting(s, "providers.fake.max_in_flight", 1);
    saveSettings(dir, s);
    const back = loadSettings(dir);
    expect(back).toEqual(s);
    expect(getSetting(back, "providers.local.base_url")).toBe("http://127.0.0.1:11434/v1");
    expect(getSetting(back, "providers.custom.base_url")).toBe("https://llm.example.test/v1");
    expect(getSetting(back, "providers.openai.max_in_flight")).toBe(4);
    expect(getSetting(back, "providers.anthropic.max_in_flight")).toBe(256);
    expect(getSetting(back, "providers.fake.max_in_flight")).toBe(1);
    expect(getSetting(back, "root.model")).toBe("fake/scripted");
    expect(getSetting(back, "sub.model")).toBe("openrouter/anthropic/claude-sonnet-5");
  });

  test("a refused setSetting leaves the settings as they were", () => {
    const s = setSetting(defaultSettings(), "providers.local.max_in_flight", 8);
    const before = structuredClone(s);
    refused(() => setSetting(s, "providers.local.max_in_flight", 999));
    refused(() => setSetting(s, "root.model", "nope/x"));
    refused(() => setSetting(s, "providers.openai.base_url", "https://example.test"));
    expect(s).toEqual(before);
  });
});
