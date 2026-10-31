// KV cache: none
// keys.ts against the step 5 spec: the index, the in-memory store, the file fallback, env keys and checkFormat.
// Every fake key contains FAKE, so the gate's secret scan lets it through.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_LIMITS, KeyReadError, KeyStore, checkFormat, type SecretsLike } from "../../src/gateway/keys.ts";

const ANT_1 = "sk-ant-FAKE-0123456789abcdef3f9a";
const ANT_2 = "sk-ant-FAKE-1111111111111111b2c4";
const ANT_3 = "sk-ant-FAKE-2222222222222222d5e6";
const OPENAI = "sk-FAKE-openai-0123456789abcd7a1b";
const GEMINI = "AIzaFAKE-gemini-0123456789abcdef";
const ENV_ANT = "sk-ant-FAKE-from-the-env-00000e9v";

/** An in-memory OS store that counts calls; `mode` makes every call throw or never settle. */
class MemSecrets implements SecretsLike {
  readonly entries = new Map<string, string>();
  calls = { get: 0, set: 0, delete: 0 };
  mode: "ok" | "throw" | "hang" = "ok";
  failDelete = false;

  private gate<T>(fn: () => T): Promise<T> {
    if (this.mode === "throw") return Promise.reject(new Error("FAKE store failure"));
    if (this.mode === "hang") return new Promise<T>(() => undefined);
    return Promise.resolve(fn());
  }
  get(o: { service: string; name: string }): Promise<string | null> {
    this.calls.get++;
    return this.gate(() => this.entries.get(`${o.service}/${o.name}`) ?? null);
  }
  set(o: { service: string; name: string; value: string }): Promise<void> {
    this.calls.set++;
    return this.gate(() => {
      this.entries.set(`${o.service}/${o.name}`, o.value);
    });
  }
  delete(o: { service: string; name: string }): Promise<boolean> {
    this.calls.delete++;
    if (this.failDelete) return Promise.reject(new Error("FAKE delete failure"));
    return this.gate(() => this.entries.delete(`${o.service}/${o.name}`));
  }
}

let dir: string;
let home: string;
let mem: MemSecrets;
const savedTimeout = KEY_LIMITS.SECRETS_TIMEOUT_MS;
// On Windows each keys.json write runs icacls, which is slow on CI runners.
setDefaultTimeout(30_000);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlmh-keys-"));
  home = join(dir, "home"); // missing on purpose: the store creates it
  mem = new MemSecrets();
});
afterEach(() => {
  KEY_LIMITS.SECRETS_TIMEOUT_MS = savedTimeout;
  rmSync(dir, { recursive: true, force: true });
});

function store(env: Record<string, string | undefined> = {}): KeyStore {
  return new KeyStore({ home, secrets: mem, env });
}

function indexText(): string {
  return readFileSync(join(home, "key-index.json"), "utf8");
}

function keysFile(): { version: number; keys: Record<string, string> } {
  return JSON.parse(readFileSync(join(home, "keys.json"), "utf8"));
}

/** Every file under home, as text. */
function allText(root: string): string {
  let out = "";
  for (const name of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, name.name);
    out += name.isDirectory() ? allText(p) : readFileSync(p, "utf8");
  }
  return out;
}

describe("round trip", () => {
  test("add, list, setActive, resolve, remove", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    expect(a.id).toMatch(/^k_[0-9a-f]{8}$/);
    expect(a).toMatchObject({ provider: "anthropic", label: "key 1", last4: "3f9a", store: "secrets", active: true });
    expect(new Date(a.created_at).toISOString()).toBe(a.created_at);
    expect(JSON.stringify(a)).not.toContain(ANT_1);
    expect(mem.entries.get(`rlm-harness/anthropic:${a.id}`)).toBe(ANT_1);

    const b = await ks.add("anthropic", ANT_2, "  work  ");
    expect(b).toMatchObject({ label: "work", active: false });
    const o = await ks.add("openai", OPENAI);
    expect(o).toMatchObject({ label: "key 1", active: true });

    expect((await ks.list()).map((k) => k.id)).toEqual([a.id, b.id, o.id]);
    expect((await ks.list("anthropic")).map((k) => k.id)).toEqual([a.id, b.id]);
    expect(await ks.list("deepseek")).toEqual([]);

    expect(await ks.resolve("anthropic")).toEqual({ key: ANT_1, source: "secrets", info: a });
    await ks.setActive("anthropic", b.id);
    expect((await ks.list("anthropic")).map((k) => k.active)).toEqual([false, true]);
    expect((await ks.resolve("anthropic"))?.key).toBe(ANT_2);
    expect((await ks.resolve("openai"))?.key).toBe(OPENAI);

    await ks.remove("anthropic", a.id);
    expect(mem.entries.has(`rlm-harness/anthropic:${a.id}`)).toBe(false);
    expect((await ks.list("anthropic")).map((k) => k.id)).toEqual([b.id]);
    expect((await ks.resolve("anthropic"))?.key).toBe(ANT_2);

    await ks.remove("anthropic", b.id);
    expect(await ks.resolve("anthropic")).toBeNull();
    expect(await ks.list("anthropic")).toEqual([]);
  });

  test("a second store on the same home sees the same keys", async () => {
    const a = await store().add("anthropic", ANT_1);
    expect(await store().list()).toEqual([a]);
  });

  test("removing the active key promotes the newest remaining one", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    const b = await ks.add("anthropic", ANT_2);
    await Bun.sleep(2); // distinct created_at
    const c = await ks.add("anthropic", ANT_3);
    await ks.remove("anthropic", a.id);
    const left = await ks.list("anthropic");
    expect(left.map((k) => [k.id, k.active])).toEqual([
      [b.id, false],
      [c.id, true],
    ]);
  });

  test("removing an inactive key leaves the active one alone", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    const b = await ks.add("anthropic", ANT_2);
    await ks.remove("anthropic", b.id);
    expect(await ks.list()).toEqual([a]);
  });

  test("a store entry already gone is fine on remove", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    mem.entries.clear();
    await ks.remove("anthropic", a.id);
    expect(await ks.list()).toEqual([]);
  });

  test("a delete that throws leaves the key listed, so the user can retry", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    const before = indexText();
    mem.failDelete = true;
    await expect(ks.remove("anthropic", a.id)).rejects.toThrow("Could not delete the key from the OS key store (FAKE delete failure), so it is still saved. Try again.");
    expect(indexText()).toBe(before);
    mem.failDelete = false;
    await ks.remove("anthropic", a.id);
    expect(await ks.list()).toEqual([]);
  });

  test("unknown providers and ids throw", async () => {
    const ks = store();
    await expect(ks.add("nope", ANT_1)).rejects.toThrow('Unknown provider "nope".');
    const a = await ks.add("anthropic", ANT_1);
    await expect(ks.setActive("anthropic", "k_00000000")).rejects.toThrow('There is no saved Anthropic key with id "k_00000000".');
    await expect(ks.setActive("openai", a.id)).rejects.toThrow('There is no saved OpenAI key with id');
    await expect(ks.remove("anthropic", "k_00000000")).rejects.toThrow('There is no saved Anthropic key with id "k_00000000".');
    expect(await ks.resolve("nope")).toBeNull();
  });

  test("add trims the key and stores the trimmed form", async () => {
    const ks = store();
    const a = await ks.add("anthropic", `  ${ANT_1}\r\n`);
    expect(a.last4).toBe("3f9a");
    expect((await ks.resolve("anthropic"))?.key).toBe(ANT_1);
  });

  test("a label holding the key is refused", async () => {
    await expect(store().add("anthropic", ANT_1, `mine ${ANT_1}`)).rejects.toThrow("The label can't contain the key.");
  });

  test("a short key gets no last4", async () => {
    const a = await store().add("local", "FAKEtoken");
    expect(a.last4).toBe("");
    expect(indexText()).not.toContain("FAKEtoken");
  });
});

describe("key-index.json", () => {
  test("holds label, last4 and store, and never the key", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1, "personal");
    const o = await ks.add("openai", OPENAI);
    const text = indexText();
    for (const key of [ANT_1, OPENAI]) expect(text).not.toContain(key);
    expect(text.endsWith("}\n")).toBe(true);
    expect(JSON.parse(text)).toEqual({ version: 1, keys: [a, o] });
    expect(text).toContain('"label": "personal"');
    expect(text).toContain('"last4": "3f9a"');
    expect(text).toContain('"store": "secrets"');
    expect(existsSync(join(home, "keys.json"))).toBe(false);
  });

  test("10 parallel adds give 10 valid entries", async () => {
    const ks = store();
    const keys = Array.from({ length: 10 }, (_, i) => `sk-ant-FAKE-parallel-${String(i).padStart(4, "0")}xyz`);
    const infos = await Promise.all(keys.map((k) => ks.add("anthropic", k)));
    const listed = await ks.list("anthropic");
    expect(listed).toHaveLength(10);
    expect(new Set(listed.map((k) => k.id)).size).toBe(10);
    expect(listed.filter((k) => k.active)).toHaveLength(1);
    expect(listed.map((k) => k.label).sort()).toEqual(Array.from({ length: 10 }, (_, i) => `key ${i + 1}`).sort());
    expect(listed.map((k) => k.id).sort()).toEqual(infos.map((k) => k.id).sort());
    for (const [i, info] of infos.entries()) expect(mem.entries.get(`rlm-harness/anthropic:${info.id}`)).toBe(keys[i]);
    expect(JSON.parse(indexText()).keys).toHaveLength(10);
  });

  test("10 parallel adds to the file store give 10 entries in keys.json", async () => {
    const ks = store({ RLMH_KEY_STORE: "file" });
    const keys = Array.from({ length: 10 }, (_, i) => `sk-FAKE-parallel-file-${String(i).padStart(4, "0")}xy`);
    const infos = await Promise.all(keys.map((k) => ks.add("openai", k)));
    const file = keysFile();
    expect(Object.keys(file.keys)).toHaveLength(10);
    for (const [i, info] of infos.entries()) expect(file.keys[`openai:${info.id}`]).toBe(keys[i]);
    expect(await ks.list("openai")).toHaveLength(10);
  });

  test("a corrupt index is renamed to .bad and treated as empty", async () => {
    const ks = store();
    await ks.add("anthropic", ANT_1);
    writeFileSync(join(home, "key-index.json"), "{ not json");
    expect(await ks.list()).toEqual([]);
    expect(readFileSync(join(home, "key-index.json.bad"), "utf8")).toBe("{ not json");
    expect(existsSync(join(home, "key-index.json"))).toBe(false);
    const b = await ks.add("anthropic", ANT_2);
    expect(b).toMatchObject({ label: "key 1", active: true });
    expect(await ks.list()).toEqual([b]);
  });

  test("an index of the wrong shape counts as corrupt too", async () => {
    const ks = store();
    await ks.add("anthropic", ANT_1);
    writeFileSync(join(home, "key-index.json"), JSON.stringify({ version: 1, keys: [{ id: 3 }] }));
    const b = await ks.add("openai", OPENAI);
    expect(await ks.list()).toEqual([b]);
    expect(existsSync(join(home, "key-index.json.bad"))).toBe(true);
  });

  test("no temp files are left behind", async () => {
    const ks = store({ RLMH_KEY_STORE: "file" });
    const a = await ks.add("openai", OPENAI);
    await ks.add("anthropic", ANT_1);
    await ks.remove("openai", a.id);
    expect(readdirSync(home).sort()).toEqual(["key-index.json", "keys.json"]);
  });
});

describe("environment keys", () => {
  test("env beats saved keys, and is never listed", async () => {
    await store().add("anthropic", ANT_1);
    const ks = store({ ANTHROPIC_API_KEY: `  ${ENV_ANT}  ` });
    expect(await ks.resolve("anthropic")).toEqual({ key: ENV_ANT, source: "env", envVar: "ANTHROPIC_API_KEY" });
    expect((await ks.list()).map((k) => k.last4)).toEqual(["3f9a"]);
  });

  test("env alone, with nothing saved", async () => {
    const ks = store({ OPENAI_API_KEY: OPENAI });
    expect(await ks.resolve("openai")).toEqual({ key: OPENAI, source: "env", envVar: "OPENAI_API_KEY" });
    expect(await ks.list()).toEqual([]);
    expect(existsSync(home)).toBe(false);
  });

  test("Gemini reads GEMINI_API_KEY, then GOOGLE_API_KEY", async () => {
    const other = "AIzaFAKE-google-alias-000000000000";
    expect(await store({ GOOGLE_API_KEY: other }).resolve("gemini")).toEqual({ key: other, source: "env", envVar: "GOOGLE_API_KEY" });
    expect(await store({ GEMINI_API_KEY: GEMINI, GOOGLE_API_KEY: other }).resolve("gemini")).toEqual({
      key: GEMINI,
      source: "env",
      envVar: "GEMINI_API_KEY",
    });
    expect(await store({ GEMINI_API_KEY: " ", GOOGLE_API_KEY: other }).resolve("gemini")).toMatchObject({ envVar: "GOOGLE_API_KEY" });
  });

  test("a blank variable is ignored", async () => {
    expect(await store({ ANTHROPIC_API_KEY: "" }).resolve("anthropic")).toBeNull();
    expect(await store({ ANTHROPIC_API_KEY: " \t\n" }).resolve("anthropic")).toBeNull();
    await store().add("anthropic", ANT_1);
    expect(await store({ ANTHROPIC_API_KEY: "   " }).resolve("anthropic")).toMatchObject({ key: ANT_1, source: "secrets" });
  });

  test("providers without a variable resolve saved keys only", async () => {
    expect(await store({ ANTHROPIC_API_KEY: ENV_ANT }).resolve("local")).toBeNull();
    await store().add("local", "FAKE-local-server-token-0001");
    expect((await store().resolve("local"))?.source).toBe("secrets");
  });
});

describe("checkFormat", () => {
  const SPACES = "That key has spaces or odd characters in it. Copy it again without the surrounding text.";

  test("empty", () => {
    expect(checkFormat("anthropic", "")).toBe("Paste a key first.");
    expect(checkFormat("custom", "  \n\t ")).toBe("Paste a key first.");
  });

  test("spaces and odd characters", () => {
    expect(checkFormat("anthropic", "sk-ant-FAKE 0123456789")).toBe(SPACES);
    expect(checkFormat("custom", "FAKE\tkey")).toBe(SPACES);
    expect(checkFormat("custom", "FAKE key")).toBe(SPACES);
    expect(checkFormat("custom", "FAKE-kéy")).toBe(SPACES);
    expect(checkFormat("custom", "FAKE-“key”")).toBe(SPACES);
    expect(checkFormat("custom", "FAKE\u0000key")).toBe(SPACES);
  });

  test("surrounding whitespace is trimmed, not refused", () => {
    expect(checkFormat("anthropic", `\n  ${ANT_1}  \r\n`)).toBeNull();
  });

  test("too long", () => {
    expect(checkFormat("custom", `FAKE${"x".repeat(2044)}`)).toBeNull();
    expect(checkFormat("custom", `FAKE${"x".repeat(2045)}`)).toBe("That key is too long to be an API key.");
    expect(checkFormat("anthropic", `sk-ant-FAKE${"x".repeat(2100)}`)).toBe("That key is too long to be an API key.");
  });

  test("prefixes", () => {
    expect(checkFormat("anthropic", ANT_1)).toBeNull();
    expect(checkFormat("anthropic", OPENAI)).toBe('That does not look like Anthropic key: they start with "sk-ant-".');
    expect(checkFormat("openai", OPENAI)).toBeNull();
    expect(checkFormat("openai", "FAKE-openai-key")).toBe('That does not look like OpenAI key: they start with "sk-".');
    expect(checkFormat("deepseek", "sk-FAKE-deepseek")).toBeNull();
    expect(checkFormat("deepseek", "FAKE-deepseek")).toBe('That does not look like DeepSeek key: they start with "sk-".');
    expect(checkFormat("openrouter", "sk-or-FAKE-v1-0123")).toBeNull();
    expect(checkFormat("openrouter", "sk-FAKE-v1-0123")).toBe('That does not look like OpenRouter key: they start with "sk-or-".');
  });

  test("gemini needs 20 or more characters", () => {
    expect(checkFormat("gemini", "FAKE-0123456789abcde")).toBeNull(); // 20
    expect(checkFormat("gemini", "FAKE-0123456789abcd")).toBe(
      "That key is too short to be a Google Gemini key: they have at least 20 characters.",
    ); // 19
  });

  test("others take anything", () => {
    for (const p of ["local", "custom", "fake", "unknown", "constructor", "__proto__"]) expect(checkFormat(p, "FAKE")).toBeNull();
  });

  test("add throws the checkFormat message", async () => {
    const ks = store();
    await expect(ks.add("anthropic", "")).rejects.toThrow("Paste a key first.");
    await expect(ks.add("openai", "FAKE-openai-key")).rejects.toThrow('That does not look like OpenAI key: they start with "sk-".');
    await expect(ks.add("gemini", "FAKE")).rejects.toThrow("That key is too short to be a Google Gemini key: they have at least 20 characters.");
    expect(existsSync(home)).toBe(false);
  });
});

describe("file fallback", () => {
  test("set throwing falls back to keys.json", async () => {
    mem.mode = "throw";
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    expect(a.store).toBe("file");
    expect(keysFile()).toEqual({ version: 1, keys: { [`anthropic:${a.id}`]: ANT_1 } });
    if (process.platform !== "win32") expect(statSync(join(home, "keys.json")).mode & 0o777).toBe(0o600);
    expect(indexText()).not.toContain(ANT_1);
    expect(await ks.resolve("anthropic")).toEqual({ key: ANT_1, source: "file", info: a });
  });

  test("set hanging falls back after SECRETS_TIMEOUT_MS", async () => {
    KEY_LIMITS.SECRETS_TIMEOUT_MS = 50;
    mem.mode = "hang";
    const ks = store();
    const t0 = performance.now();
    const a = await ks.add("openai", OPENAI);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(45);
    expect(a.store).toBe("file");
    expect(keysFile().keys[`openai:${a.id}`]).toBe(OPENAI);
    expect((await ks.resolve("openai"))?.source).toBe("file");
  });

  test("RLMH_KEY_STORE=file never touches the OS store", async () => {
    const ks = store({ RLMH_KEY_STORE: "file" });
    const a = await ks.add("anthropic", ANT_1);
    const b = await ks.add("anthropic", ANT_2);
    expect([a.store, b.store]).toEqual(["file", "file"]);
    expect((await ks.resolve("anthropic"))?.key).toBe(ANT_1);
    await ks.remove("anthropic", a.id);
    expect(Object.keys(keysFile().keys)).toEqual([`anthropic:${b.id}`]);
    await ks.remove("anthropic", b.id);
    expect(existsSync(join(home, "keys.json"))).toBe(false);
    expect(mem.calls).toEqual({ get: 0, set: 0, delete: 0 });
  });

  test("a store and a file key side by side", async () => {
    const ks = store();
    const a = await ks.add("anthropic", ANT_1);
    mem.mode = "throw";
    const b = await ks.add("anthropic", ANT_2);
    mem.mode = "ok";
    expect([a.store, b.store]).toEqual(["secrets", "file"]);
    await ks.setActive("anthropic", b.id);
    expect(await ks.resolve("anthropic")).toMatchObject({ key: ANT_2, source: "file" });
    await ks.remove("anthropic", b.id);
    expect(await ks.resolve("anthropic")).toMatchObject({ key: ANT_1, source: "secrets" });
    expect(existsSync(join(home, "keys.json"))).toBe(false);
    expect(allText(home)).not.toContain(ANT_2);
  });

  test("a corrupt keys.json stops add without overwriting it", async () => {
    const ks = store({ RLMH_KEY_STORE: "file" });
    await ks.add("openai", OPENAI);
    writeFileSync(join(home, "keys.json"), `{"version": 1, "keys": {"openai:k_x": "${OPENAI}"`);
    const err = await ks.add("anthropic", ANT_1).catch((e: Error) => e);
    expect((err as Error).message).toBe("Could not read keys.json, so the key was not saved: keys.json is not valid JSON");
    expect((err as Error).message).not.toContain(OPENAI);
    expect(await ks.list()).toHaveLength(1);
  });
});

describe("resolve read failures", () => {
  test("a store that throws gives KeyReadError with the cause", async () => {
    const ks = store();
    await ks.add("anthropic", ANT_1);
    mem.mode = "throw";
    const err = await ks.resolve("anthropic").catch((e: Error) => e);
    expect(err).toBeInstanceOf(KeyReadError);
    expect((err as Error).message).toBe("FAKE store failure");
  });

  test("a store that hangs times out", async () => {
    const ks = store();
    await ks.add("anthropic", ANT_1);
    KEY_LIMITS.SECRETS_TIMEOUT_MS = 30;
    mem.mode = "hang";
    const err = await ks.resolve("anthropic").catch((e: Error) => e);
    expect(err).toBeInstanceOf(KeyReadError);
    expect((err as Error).message).toBe("timed out after 30 ms");
  });

  test("an entry the store no longer has", async () => {
    const ks = store();
    await ks.add("anthropic", ANT_1);
    mem.entries.clear();
    const err = await ks.resolve("anthropic").catch((e: Error) => e);
    expect(err).toBeInstanceOf(KeyReadError);
    expect((err as Error).message).toBe("the saved entry is missing");
  });

  test("a file key missing from keys.json", async () => {
    const ks = store({ RLMH_KEY_STORE: "file" });
    await ks.add("anthropic", ANT_1);
    rmSync(join(home, "keys.json"));
    const err = await ks.resolve("anthropic").catch((e: Error) => e);
    expect(err).toBeInstanceOf(KeyReadError);
    expect((err as Error).message).toBe("keys.json has no entry for this key");
  });

  test("an env key needs no store read", async () => {
    await store().add("anthropic", ANT_1);
    mem.mode = "throw";
    expect((await store({ ANTHROPIC_API_KEY: ENV_ANT }).resolve("anthropic"))?.key).toBe(ENV_ANT);
  });
});
