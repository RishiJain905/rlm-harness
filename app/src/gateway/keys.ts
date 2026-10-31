// KV cache: none
// Saved API keys (architecture §7.3, D-21): the OS key store through Bun.secrets, with an
// owner-only keys.json as the fallback, and key-index.json for what /providers lists.
// Makes no network call. A key never goes into an error message, a log line or the index.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { basename, join } from "node:path";
import { keyIndexPath, keysPath } from "../paths.ts";
import { provider, providerName } from "./providers.ts";

export interface SecretsLike {
  get(o: { service: string; name: string }): Promise<string | null>;
  set(o: { service: string; name: string; value: string }): Promise<void>;
  delete(o: { service: string; name: string }): Promise<boolean>;
}

export interface KeyInfo {
  id: string;
  provider: string;
  label: string;
  last4: string;
  store: "secrets" | "file";
  active: boolean;
  /** ISO 8601. */
  created_at: string;
}

export interface ResolvedKey {
  key: string;
  source: "env" | "secrets" | "file";
  /** Set for a saved key. */
  info?: KeyInfo;
  /** Set for an environment key: the variable's name, such as GOOGLE_API_KEY. */
  envVar?: string;
}

/** `resolve` could not read a saved key. The message is the plain cause, such as "timed out after 15000 ms". */
export class KeyReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyReadError";
  }
}

/** Every Bun.secrets call races this; tests shorten it. */
export const KEY_LIMITS = { SECRETS_TIMEOUT_MS: 15_000 };

/** Makes an empty temp file owner-only before a key is written to it; tests swap it for a thrower. */
export const KEY_HOOKS: { restrict(file: string): Promise<void> } = { restrict: restrictToOwner };

const SERVICE = "rlm-harness";
const MAX_KEY_LENGTH = 2048;
const GEMINI_MIN_LENGTH = 20;
const PREFIXES = new Map([
  ["anthropic", "sk-ant-"],
  ["openai", "sk-"],
  ["deepseek", "sk-"],
  ["openrouter", "sk-or-"],
]);
/** A shorter key gets an empty last4, since four characters would be too much of it. */
const LAST4_MIN_LENGTH = 16;
const RENAME_RETRIES = 3;
const RENAME_RETRY_MS = 50;
const SPAWN_TIMEOUT_MS = 15_000;
const IS_WINDOWS = process.platform === "win32";

/** The default store: Bun.secrets, with persist "local" so a Windows entry does not roam. */
const OS_SECRETS: SecretsLike = {
  get: (o) => Bun.secrets.get(o),
  set: (o) => Bun.secrets.set({ ...o, persist: "local" }),
  delete: (o) => Bun.secrets.delete(o),
};

/** An error message, or null. Format only, no network. Surrounding whitespace is trimmed first, as `add` does. */
export function checkFormat(providerId: string, key: string): string | null {
  const k = key.trim();
  if (k === "") return "Paste a key first.";
  if (/[^\x21-\x7e]/.test(k)) return "That key has spaces or odd characters in it. Copy it again without the surrounding text.";
  if (k.length > MAX_KEY_LENGTH) return "That key is too long to be an API key.";
  const prefix = PREFIXES.get(providerId);
  if (prefix !== undefined && !k.startsWith(prefix)) {
    return `That does not look like ${providerName(providerId)} key: they start with "${prefix}".`;
  }
  if (providerId === "gemini" && k.length < GEMINI_MIN_LENGTH) {
    return `That key is too short to be a ${providerName(providerId)} key: they have at least ${GEMINI_MIN_LENGTH} characters.`;
  }
  return null;
}

// One queue for every write in this process, so parallel adds never lose an entry.
// Two app processes at once are not handled.
let tail: Promise<unknown> = Promise.resolve();

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(fn, fn);
  tail = run.catch(() => undefined);
  return run;
}

/** keys.json could not be made owner-only; the caller says what was not done. */
class RestrictError extends Error {}

export class KeyStore {
  private readonly home: string;
  private readonly secrets: SecretsLike;
  private readonly env: Record<string, string | undefined>;

  constructor(opts: { home: string; secrets?: SecretsLike; env?: Record<string, string | undefined> }) {
    this.home = opts.home;
    this.secrets = opts.secrets ?? OS_SECRETS;
    this.env = opts.env ?? process.env;
  }

  /** Saved keys only, oldest first; environment keys are never listed. */
  async list(providerId?: string): Promise<KeyInfo[]> {
    const keys = await this.readIndex();
    return keys.filter((k) => providerId === undefined || k.provider === providerId).map((k) => ({ ...k }));
  }

  async add(providerId: string, key: string, label?: string): Promise<KeyInfo> {
    if (!provider(providerId)) throw new Error(`Unknown provider "${providerId}".`);
    const problem = checkFormat(providerId, key);
    if (problem !== null) throw new Error(problem);
    const value = key.trim();
    const name = label?.trim() ?? "";
    if (name.includes(value)) throw new Error("The label can't contain the key.");
    return serial(async () => {
      const keys = await this.loadIndexLocked();
      let id = newId();
      while (keys.some((k) => k.id === id)) id = newId();
      const mine = keys.filter((k) => k.provider === providerId);
      const info: KeyInfo = {
        id,
        provider: providerId,
        label: name || `key ${mine.length + 1}`,
        last4: value.length >= LAST4_MIN_LENGTH ? value.slice(-4) : "",
        store: "secrets",
        active: !mine.some((k) => k.active),
        created_at: new Date().toISOString(),
      };
      const entry = entryName(info);
      if (this.forceFile()) info.store = "file";
      else {
        try {
          await this.setSecret(entry, value);
        } catch {
          info.store = "file";
        }
      }
      if (info.store === "file") {
        let file: Record<string, string>;
        try {
          file = this.readKeysFile();
        } catch (err) {
          throw new Error(`Could not read keys.json, so the key was not saved: ${causeOf(err)}`);
        }
        file[entry] = value;
        try {
          await this.writeKeysFile(file);
        } catch (err) {
          if (err instanceof RestrictError) throw new Error(`Could not restrict keys.json to your account, so the key was not saved: ${err.message}`);
          throw new Error(`Could not write keys.json, so the key was not saved: ${causeOf(err)}`);
        }
      }
      try {
        await this.writeIndex([...keys, info]);
      } catch (err) {
        // The key is stored but nothing names it; take it back out.
        await this.dropStored(info).catch(() => undefined);
        throw err;
      }
      return { ...info };
    });
  }

  /**
   * Deletes the key from the store the index names (an entry already gone is fine), then from the index.
   * If the OS store's delete throws or times out, this throws and leaves the index as it was, so the key
   * stays listed and the user can retry; dropping it from the index would leave an entry nobody can find.
   */
  async remove(providerId: string, id: string): Promise<void> {
    return serial(async () => {
      const keys = await this.loadIndexLocked();
      const target = keys.find((k) => k.provider === providerId && k.id === id);
      if (!target) throw new Error(noSuchKey(providerId, id));
      await this.dropStored(target);
      const rest = keys.filter((k) => k !== target);
      if (target.active) {
        const next = newest(rest, providerId);
        if (next) next.active = true;
      }
      await this.writeIndex(rest);
    });
  }

  async setActive(providerId: string, id: string): Promise<void> {
    return serial(async () => {
      const keys = await this.loadIndexLocked();
      if (!keys.some((k) => k.provider === providerId && k.id === id)) throw new Error(noSuchKey(providerId, id));
      for (const k of keys) if (k.provider === providerId) k.active = k.id === id;
      await this.writeIndex(keys);
    });
  }

  /** The provider's variable (then its fallback), non-empty after trimming; then the active saved key; else null. */
  async resolve(providerId: string): Promise<ResolvedKey | null> {
    const def = provider(providerId);
    if (!def) return null;
    for (const name of [def.envVar, def.envFallback]) {
      if (!name) continue;
      const v = this.env[name]?.trim();
      if (v) return { key: v, source: "env", envVar: name };
    }
    const active = (await this.readIndex()).find((k) => k.provider === providerId && k.active);
    if (!active) return null;
    const key = active.store === "secrets" ? await this.getSecret(entryName(active)) : this.getFileKey(entryName(active));
    return { key, source: active.store, info: { ...active } };
  }

  private forceFile(): boolean {
    return this.env.RLMH_KEY_STORE?.trim().toLowerCase() === "file";
  }

  // --- the OS store ---

  private async setSecret(name: string, value: string): Promise<void> {
    const p = Promise.resolve().then(() => this.secrets.set({ service: SERVICE, name, value }));
    try {
      await withTimeout(p);
    } catch (err) {
      // A set that timed out may still land later. The key goes to keys.json instead, so delete that entry then.
      p.then(
        () => this.secrets.delete({ service: SERVICE, name }),
        () => undefined,
      ).catch(() => undefined);
      throw err;
    }
  }

  private async getSecret(name: string): Promise<string> {
    let value: string | null;
    try {
      value = await withTimeout(Promise.resolve().then(() => this.secrets.get({ service: SERVICE, name })));
    } catch (err) {
      throw new KeyReadError(causeOf(err));
    }
    if (!value) throw new KeyReadError("the saved entry is missing");
    return value;
  }

  /** Deletes the stored key of one index entry. Throws, with nothing changed, if that fails. */
  private async dropStored(info: KeyInfo): Promise<void> {
    const entry = entryName(info);
    if (info.store === "secrets") {
      try {
        await withTimeout(Promise.resolve().then(() => this.secrets.delete({ service: SERVICE, name: entry })));
      } catch (err) {
        throw new Error(`Could not delete the key from the OS key store (${causeOf(err)}), so it is still saved. Try again.`);
      }
      return;
    }
    let file: Record<string, string>;
    try {
      file = this.readKeysFile();
    } catch (err) {
      throw new Error(`Could not read keys.json, so the key was not removed: ${causeOf(err)}`);
    }
    if (!Object.hasOwn(file, entry)) return;
    delete file[entry];
    try {
      if (Object.keys(file).length === 0) unlinkSync(keysPath(this.home));
      else await this.writeKeysFile(file);
    } catch (err) {
      if (err instanceof RestrictError) throw new Error(`Could not restrict keys.json to your account, so the key was not removed: ${err.message}`);
      throw new Error(`Could not write keys.json, so the key was not removed: ${causeOf(err)}`);
    }
  }

  // --- keys.json ---

  private getFileKey(entry: string): string {
    let file: Record<string, string>;
    try {
      file = this.readKeysFile();
    } catch (err) {
      throw new KeyReadError(causeOf(err));
    }
    const value = Object.hasOwn(file, entry) ? file[entry] : undefined;
    if (!value) throw new KeyReadError("keys.json has no entry for this key");
    return value;
  }

  /** The `keys` map; a missing file is empty. Tightens group or other bits on POSIX. Error messages never quote the file. */
  private readKeysFile(): Record<string, string> {
    const path = keysPath(this.home);
    let text: string;
    try {
      if (!IS_WINDOWS) {
        const mode = statSync(path).mode & 0o777;
        if (mode & 0o077) {
          try {
            chmodSync(path, mode & 0o700);
          } catch {
            // Reading still works; the next write makes a fresh owner-only file.
          }
        }
      }
      text = readFileSync(path, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return {};
      throw new Error(`keys.json could not be read (${code ?? "unknown error"})`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("keys.json is not valid JSON");
    }
    const keys = (data as { version?: unknown; keys?: unknown } | null)?.keys;
    if ((data as { version?: unknown } | null)?.version !== 1 || typeof keys !== "object" || keys === null || Array.isArray(keys)) {
      throw new Error("keys.json is not in the expected format");
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(keys)) if (typeof v === "string") out[k] = v;
    return out;
  }

  /** Temp file created 0o600 and empty, made owner-only by KEY_HOOKS.restrict, then written, then renamed over. */
  private async writeKeysFile(keys: Record<string, string>): Promise<void> {
    mkdirSync(this.home, { recursive: true });
    const path = keysPath(this.home);
    const tmp = tempName(path);
    // One handle from create to close: reopening with a truncating flag can give the file a fresh,
    // inherited ACL on Windows, which undoes the lock (the first Windows CI run showed three ACEs).
    const fd = openSync(tmp, "wx", 0o600);
    let open = true;
    try {
      try {
        await KEY_HOOKS.restrict(tmp);
      } catch (err) {
        throw new RestrictError(causeOf(err));
      }
      writeSync(fd, json({ version: 1, keys }));
      fsyncSync(fd);
      closeSync(fd);
      open = false;
      if (!IS_WINDOWS) {
        try {
          chmodSync(tmp, 0o600); // again, whatever the umask did
        } catch (err) {
          throw new RestrictError(causeOf(err));
        }
      }
      await renameWithRetry(tmp, path);
    } catch (err) {
      if (open) closeSync(fd);
      removeQuietly(tmp);
      throw err;
    }
  }


  // --- key-index.json ---

  /** Outside the queue. A corrupt index is moved aside inside it, once no write is in flight. */
  private async readIndex(): Promise<KeyInfo[]> {
    return parseIndex(keyIndexPath(this.home)) ?? serial(() => this.loadIndexLocked());
  }

  /** Inside the queue only. An unreadable index becomes key-index.json.bad and counts as empty. */
  private async loadIndexLocked(): Promise<KeyInfo[]> {
    const path = keyIndexPath(this.home);
    const keys = parseIndex(path);
    if (keys) return keys;
    try {
      await renameWithRetry(path, `${path}.bad`);
    } catch (err) {
      throw new Error(`key-index.json is unreadable and could not be moved aside: ${causeOf(err)}`);
    }
    return [];
  }

  private async writeIndex(keys: KeyInfo[]): Promise<void> {
    mkdirSync(this.home, { recursive: true });
    const path = keyIndexPath(this.home);
    const tmp = tempName(path);
    try {
      writeFileSync(tmp, json({ version: 1, keys: keys.map(pickInfo) }), { flag: "wx" });
      await renameWithRetry(tmp, path);
    } catch (err) {
      removeQuietly(tmp);
      throw err;
    }
  }
}

/** The entries, or [] for a missing file, or null when it can't be read or parsed. */
function parseIndex(path: string): KeyInfo[] | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? [] : null;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  const d = data as { version?: unknown; keys?: unknown } | null;
  if (d?.version !== 1 || !Array.isArray(d.keys) || !d.keys.every(isKeyInfo)) return null;
  const keys = d.keys.map(pickInfo);
  // One active key per provider: keep the first one marked, or mark the newest if none is.
  for (const p of new Set(keys.map((k) => k.provider))) {
    const mine = keys.filter((k) => k.provider === p);
    const first = mine.find((k) => k.active);
    for (const k of mine) k.active = k === first;
    if (!first) newest(mine, p)!.active = true;
  }
  return keys;
}

function isKeyInfo(v: unknown): v is KeyInfo {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.provider === "string" &&
    typeof o.label === "string" &&
    typeof o.last4 === "string" &&
    (o.store === "secrets" || o.store === "file") &&
    typeof o.active === "boolean" &&
    typeof o.created_at === "string"
  );
}

function pickInfo(k: KeyInfo): KeyInfo {
  return { id: k.id, provider: k.provider, label: k.label, last4: k.last4, store: k.store, active: k.active, created_at: k.created_at };
}

/** The newest of a provider's keys; a tie goes to the later entry. */
function newest(keys: KeyInfo[], providerId: string): KeyInfo | undefined {
  let best: KeyInfo | undefined;
  for (const k of keys) if (k.provider === providerId && (!best || k.created_at >= best.created_at)) best = k;
  return best;
}

function entryName(k: { provider: string; id: string }): string {
  return `${k.provider}:${k.id}`;
}

function noSuchKey(providerId: string, id: string): string {
  return `There is no saved ${providerName(providerId)} key with id "${id}".`;
}

function newId(): string {
  return `k_${hex(4)}`;
}

function hex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function tempName(path: string): string {
  return `${path}.${hex(4)}.tmp`;
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function causeOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout<T>(p: Promise<T>): Promise<T> {
  const ms = KEY_LIMITS.SECRETS_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Retries EPERM and EBUSY (antivirus on Windows holding the file). */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= RENAME_RETRIES || (code !== "EPERM" && code !== "EBUSY")) throw err;
      await Bun.sleep(RENAME_RETRY_MS);
    }
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** KEY_HOOKS.restrict's default. POSIX: mode 0o600. Windows: an ACL with one entry, full control for the current user. */
async function restrictToOwner(file: string): Promise<void> {
  if (!IS_WINDOWS) {
    chmodSync(file, 0o600);
    if ((statSync(file).mode & 0o077) !== 0) throw new Error("the file is still open to other users");
    return;
  }
  const sid = await currentSid();
  await runQuiet([join(system32(), "icacls.exe"), file, "/inheritance:r", "/grant:r", `*${sid}:F`]);
}

let sidOnce: Promise<string> | undefined;

/** The current user's SID, asked of whoami once per process (a failure is asked again next time). */
function currentSid(): Promise<string> {
  sidOnce ??= (async () => {
    const who = await runQuiet([join(system32(), "whoami.exe"), "/user", "/fo", "csv", "/nh"]);
    // "desktop\rishi","S-1-5-21-…": the SID is the second field.
    const sid = /,"(S-1-\d+(?:-\d+)+)"$/.exec(who.trim())?.[1];
    if (!sid) throw new Error("whoami /user did not give a SID");
    return sid;
  })();
  sidOnce.catch(() => {
    sidOnce = undefined;
  });
  return sidOnce;
}

function system32(): string {
  return join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows", "System32");
}

/** Runs argv with no shell and returns stdout; a non-zero exit throws with the first line it printed. */
async function runQuiet(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: SPAWN_TIMEOUT_MS });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) {
    const line = `${err}\n${out}`.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "");
    throw new Error(`${basename(argv[0]!)} exited with code ${code}${line ? `: ${line}` : ""}`);
  }
  return out;
}
