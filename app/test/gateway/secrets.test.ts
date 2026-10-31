// KV cache: none
// keys.ts against the real OS store (service renamed to rlm-harness-test) and the owner-only keys.json.
// Passes on a machine with no usable store too: it prints which path ran.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_HOOKS, KEY_LIMITS, KeyStore, type SecretsLike } from "../../src/gateway/keys.ts";

const TEST_SERVICE = "rlm-harness-test";
const PROBE_MS = 8_000;
const FAKE_KEY = "sk-ant-FAKE-0123456789abcdef3f9a";
const IS_WINDOWS = process.platform === "win32";

/** Bun.secrets with the service renamed, so a test never touches a real rlm-harness entry. */
const testSecrets: SecretsLike = {
  get: (o) => Bun.secrets.get({ ...o, service: TEST_SERVICE }),
  set: (o) => Bun.secrets.set({ ...o, service: TEST_SERVICE, persist: "local" }),
  delete: (o) => Bun.secrets.delete({ ...o, service: TEST_SERVICE }),
};

function race<T>(p: Promise<T>, ms = PROBE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function randomName(): string {
  return `probe:k_${Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// The probe is a whole round trip on a throwaway entry, raced at 8 s: a locked keychain can
// answer `get` and still fail or hang on `set`, and that machine belongs on the fallback branch.
let osStore = false;
let fallbackCause = "";
{
  const name = randomName();
  const value = `FAKE-probe-${name}`;
  try {
    await race(
      (async () => {
        await testSecrets.set({ service: "ignored", name, value });
        const got = await testSecrets.get({ service: "ignored", name });
        if (got !== value) throw new Error(got === null ? "get gave null after set" : "get gave back a different value");
        if (!(await testSecrets.delete({ service: "ignored", name }))) throw new Error("delete gave false after set");
      })(),
    );
    osStore = true;
  } catch (err) {
    fallbackCause = err instanceof Error ? err.message : String(err);
    await race(Promise.resolve().then(() => testSecrets.delete({ service: "ignored", name }))).catch(() => undefined);
  }
}

let dir: string;
let home: string;
const savedTimeout = KEY_LIMITS.SECRETS_TIMEOUT_MS;
const savedRestrict = KEY_HOOKS.restrict;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rlmh-secrets-"));
  home = join(dir, "home");
});
afterEach(() => {
  KEY_LIMITS.SECRETS_TIMEOUT_MS = savedTimeout;
  KEY_HOOKS.restrict = savedRestrict;
  rmSync(dir, { recursive: true, force: true });
});

/** Every file under root, as text. */
function allText(root: string): string {
  if (!existsSync(root)) return "";
  let out = "";
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    out += e.isDirectory() ? allText(p) : readFileSync(p, "utf8");
  }
  return out;
}

test("probe the OS store", () => {
  console.log(osStore ? "secrets: os-store" : `secrets: file-fallback (${fallbackCause})`);
  expect(osStore || fallbackCause !== "").toBe(true);
});

describe("OS store", () => {
  test.skipIf(!osStore)(
    "set, get, delete true, get null, delete false",
    async () => {
      const name = randomName();
      const value = `sk-FAKE-os-store-${name}`;
      try {
        await race(testSecrets.set({ service: "ignored", name, value }));
        expect(await race(testSecrets.get({ service: "ignored", name }))).toBe(value);
        expect(await race(testSecrets.delete({ service: "ignored", name }))).toBe(true);
        expect(await race(testSecrets.get({ service: "ignored", name }))).toBeNull();
        expect(await race(testSecrets.delete({ service: "ignored", name }))).toBe(false);
      } finally {
        await race(testSecrets.delete({ service: "ignored", name })).catch(() => undefined);
      }
    },
    60_000,
  );

  test.skipIf(!osStore)(
    "KeyStore add, resolve and remove leave no entry behind",
    async () => {
      KEY_LIMITS.SECRETS_TIMEOUT_MS = PROBE_MS;
      const ks = new KeyStore({ home, secrets: testSecrets, env: {} });
      let entry: string | undefined;
      try {
        const info = await ks.add("anthropic", FAKE_KEY);
        entry = `anthropic:${info.id}`;
        expect(info.store).toBe("secrets");
        expect(existsSync(join(home, "keys.json"))).toBe(false);
        expect(await ks.resolve("anthropic")).toEqual({ key: FAKE_KEY, source: "secrets", info });
        await ks.remove("anthropic", info.id);
        expect(await ks.list()).toEqual([]);
        expect(await race(testSecrets.get({ service: "ignored", name: entry }))).toBeNull();
        expect(allText(home)).not.toContain(FAKE_KEY);
      } finally {
        if (entry) await race(testSecrets.delete({ service: "ignored", name: entry })).catch(() => undefined);
      }
    },
    60_000,
  );
});

describe("keys.json", () => {
  const fileEnv = { RLMH_KEY_STORE: "file" };

  test.skipIf(IS_WINDOWS)("is mode 0o600, and a looser mode is tightened on read", async () => {
    const ks = new KeyStore({ home, secrets: testSecrets, env: fileEnv });
    const info = await ks.add("anthropic", FAKE_KEY);
    expect(info.store).toBe("file");
    const file = join(home, "keys.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    expect((await ks.resolve("anthropic"))?.key).toBe(FAKE_KEY);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test.skipIf(!IS_WINDOWS)(
    "has one ACE, full control for the current user",
    async () => {
      const ks = new KeyStore({ home, secrets: testSecrets, env: fileEnv });
      await ks.add("anthropic", FAKE_KEY);
      const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const user = Bun.spawnSync([join(system32, "whoami.exe")]).stdout.toString().trim().toLowerCase();
      // Relative path, so the first line starts with exactly "keys.json ".
      const out = Bun.spawnSync([join(system32, "icacls.exe"), "keys.json"], { cwd: home }).stdout.toString();
      const lines = out.split(/\r?\n/);
      const block = lines.slice(0, lines.findIndex((l) => l.trim() === ""));
      expect(block[0]!.startsWith("keys.json ")).toBe(true);
      const aces = [block[0]!.slice("keys.json ".length), ...block.slice(1)].map((l) => l.trim()).filter((l) => l !== "");
      expect(aces).toEqual([expect.stringMatching(/:\(F\)$/)]);
      expect(aces[0]!.toLowerCase()).toBe(`${user}:(f)`);
      for (const ace of aces) expect(ace).not.toMatch(/(^|\\)(Everyone|Users|Authenticated Users):/i);
    },
    30_000,
  );

  test("a failing lock stops add, and nothing is written", async () => {
    KEY_HOOKS.restrict = async () => {
      throw new Error("FAKE lock failure");
    };
    const ks = new KeyStore({ home, secrets: testSecrets, env: fileEnv });
    const err = await ks.add("anthropic", FAKE_KEY).catch((e: Error) => e);
    expect((err as Error).message).toBe("Could not restrict keys.json to your account, so the key was not saved: FAKE lock failure");
    expect(existsSync(join(home, "keys.json"))).toBe(false);
    expect(existsSync(join(home, "key-index.json"))).toBe(false);
    expect(readdirSync(home)).toEqual([]);
    expect(allText(home)).not.toContain(FAKE_KEY);
    expect(await ks.list()).toEqual([]);
  });

  test("a failing lock leaves an existing keys.json and index as they were", async () => {
    const ks = new KeyStore({ home, secrets: testSecrets, env: fileEnv });
    await ks.add("openai", "sk-FAKE-openai-0123456789abcd7a1b");
    const before = { keys: readFileSync(join(home, "keys.json"), "utf8"), index: readFileSync(join(home, "key-index.json"), "utf8") };
    KEY_HOOKS.restrict = async () => {
      throw new Error("FAKE lock failure");
    };
    await expect(ks.add("anthropic", FAKE_KEY)).rejects.toThrow("Could not restrict keys.json to your account, so the key was not saved: FAKE lock failure");
    expect(readFileSync(join(home, "keys.json"), "utf8")).toBe(before.keys);
    expect(readFileSync(join(home, "key-index.json"), "utf8")).toBe(before.index);
    expect(readdirSync(home).sort()).toEqual(["key-index.json", "keys.json"]);
    expect(allText(home)).not.toContain(FAKE_KEY);
  });
});
